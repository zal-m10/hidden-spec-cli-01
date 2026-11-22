// mend: applies AI-written edits in four formats (unified diff, SEARCH/REPLACE,
// V4A patch, JSON tool calls) to a tree of text files. Written from SPEC.md.
// Node 22 standard library only. Deterministic: no time, no randomness.

import fs from 'node:fs';
import path from 'node:path';

// ---------- generic helpers ----------

function isBlank(s) { return /^\s*$/.test(s); }
function stripTrailingST(s) { return s.replace(/[ \t]+$/, ''); }
function stripBothST(s) { return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''); }
function leadingWS(s) { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; }

// Patch lines: split at \n, one trailing \r removed each, no empty piece after final \n.
function patchLines(text) {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// A file's lines: split at its own line break (CRLF when the first LF follows a CR).
function parseFile(text) {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const idx = text.indexOf('\n');
  const br = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let ends = false;
  if (text.endsWith(br)) { parts.pop(); ends = true; }
  return { lines: parts, br, ends };
}
function serializeFile(lines, br, ends) {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

// ---------- working tree (in-memory; written only on full success) ----------

const orig = new Map(); // path -> string | null (pre-patch content; null = absent)
const state = new Map(); // path -> string | null (current content; null = absent)

function diskRead(p) {
  try {
    return fs.readFileSync(path.join(process.cwd(), ...p.split('/')), 'utf8');
  } catch (e) {
    return null;
  }
}
function getFile(p) {
  if (state.has(p)) return state.get(p);
  const c = diskRead(p);
  state.set(p, c);
  if (!orig.has(p)) orig.set(p, c);
  return c;
}
function setFile(p, content) {
  if (!orig.has(p)) getFile(p);
  state.set(p, content);
}

function isSafe(p) {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) if (s === '' || s === '.' || s === '..') return false;
  return true;
}

// ---------- line matching (section 5) ----------

function lineEq(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingST(a) === stripTrailingST(b);
  return stripBothST(a) === stripBothST(b);
}
function findOccurrences(lines, O, tier) {
  const res = [];
  if (O.length === 0 || O.length > lines.length) return res;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j], O[j], tier)) { ok = false; break; }
    }
    if (ok) res.push(i);
  }
  return res;
}
// First tier (0..2, or only 0 when strict) with an occurrence at/after `from`.
// When endOnly, only occurrences ending at the file's last line count.
function firstTierWith(lines, O, from, strict, endOnly) {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    let occs = findOccurrences(lines, O, tier).filter((i) => i >= from);
    if (endOnly) occs = occs.filter((i) => i + O.length === lines.length);
    if (occs.length) return { tier, occs };
  }
  return null;
}
// Build the replacement lines: context lines come from the file itself;
// at tier 2 the other lines are re-indented from O's first line to the file's.
function buildReplacement(fileLines, start, O, N, nCtx, tier) {
  const out = [];
  const F = start < fileLines.length ? leadingWS(fileLines[start]) : '';
  const P = O.length ? leadingWS(O[0]) : '';
  for (let j = 0; j < N.length; j++) {
    if (nCtx[j] >= 0) {
      out.push(fileLines[start + nCtx[j]]);
    } else if (tier === 2) {
      const line = N[j];
      if (line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(P)) {
        out.push(F + line.slice(P.length));
      } else out.push(line);
    } else out.push(N[j]);
  }
  return out;
}

// Split a hunk/chunk body (entries with kind ' ', '-' or '+', bs = a '\' line
// followed the entry) into old lines O, new lines N and the context map.
function splitBody(entries) {
  const O = [];
  const N = [];
  const nCtx = [];
  for (const e of entries) {
    if (e.kind === ' ') { nCtx.push(O.length); O.push(e.text); N.push(e.text); }
    else if (e.kind === '-') O.push(e.text);
    else if (e.kind === '+') { nCtx.push(-1); N.push(e.text); }
  }
  let lastNBackslash = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k].kind === ' ' || entries[k].kind === '+') { lastNBackslash = entries[k].bs; break; }
  }
  let lastPlusBackslash = null;
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k].kind === '+') { lastPlusBackslash = entries[k].bs; break; }
  }
  return { O, N, nCtx, lastNBackslash, lastPlusBackslash };
}

// ---------- unified diff application (section 6) ----------

function applyUnifiedHunks(fileText, hunks, strict) {
  const f = parseFile(fileText);
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      let at = h.A + d;
      if (at < 0) at = 0;
      if (at > f.lines.length) at = f.lines.length;
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...h.N);
      if (atEnd) f.ends = !h.lastNBackslash;
      d += h.N.length;
    } else {
      const found = firstTierWith(f.lines, h.O, 0, strict, false);
      if (!found) return null;
      const target = h.A - 1 + d;
      let best = found.occs[0];
      let bestDist = Math.abs(best - target);
      for (const o of found.occs) {
        const dist = Math.abs(o - target);
        if (dist < bestDist) { best = o; bestDist = dist; }
      }
      const rep = buildReplacement(f.lines, best, h.O, h.N, h.nCtx, found.tier);
      const runsToEnd = best + h.O.length === f.lines.length;
      f.lines.splice(best, h.O.length, ...rep);
      if (runsToEnd) f.ends = !h.lastNBackslash;
      d += h.N.length - h.O.length;
    }
  }
  return serializeFile(f.lines, f.br, f.ends);
}

// ---------- unified diff parsing (section 6) ----------

function parseErr(line) {
  const e = new Error('parse ' + line);
  e.parseLine = line;
  return e;
}

// Path after '--- ' / '+++ ': text after the four chars, up to first tab,
// surrounding spaces removed, leading a/ or b/ removed.
function stripDiffPath(s) {
  const tab = s.indexOf('\t');
  if (tab !== -1) s = s.slice(0, tab);
  s = s.replace(/^[ ]+/, '').replace(/[ ]+$/, '');
  if (s.startsWith('a/')) s = s.slice(2);
  else if (s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseDiffGit(line) {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const idx = rest.indexOf(' b/', 2);
  if (idx === -1) return null;
  const X = rest.slice(2, idx);
  const Y = rest.slice(idx + 3);
  if (X === '' || Y === '') return null;
  return { old: X, new: Y };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function collectHunkBody(lines, start) {
  const entries = [];
  let j = start;
  while (j < lines.length) {
    const L = lines[j];
    if (L.startsWith('diff --git ')) break;
    if (L.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (L === '' || L.startsWith(' ') || L.startsWith('-') || L.startsWith('+') || L.startsWith('\\')) {
      if (L.startsWith('\\')) {
        if (entries.length) entries[entries.length - 1].bs = true;
      } else if (L === '') {
        entries.push({ kind: ' ', text: '', bs: false, empty: true });
      } else {
        entries.push({ kind: L[0], text: L.slice(1), bs: false, empty: false });
      }
      j++;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (entries.length && entries[entries.length - 1].empty) entries.pop();
  return { entries, nextIndex: j };
}

function parseUnified(lines) {
  const sections = [];
  let cur = null;
  function startSection(diffOld, diffNew) {
    cur = {
      diffOld, diffNew,
      hdrOld: undefined, hdrNew: undefined,
      renameFrom: undefined, renameTo: undefined,
      newFile: false, deletedFile: false,
      hunks: [], hasPair: false,
    };
    sections.push(cur);
  }
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = parseDiffGit(line);
      if (!m) throw parseErr(i + 1);
      startSection(m.old, m.new);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur && cur.hunks.length === 0 && !cur.hasPair) {
        cur.hdrOld = stripDiffPath(line.slice(4));
        cur.hdrNew = stripDiffPath(lines[i + 1].slice(4));
        cur.hasPair = true;
      } else {
        startSection(undefined, undefined);
        cur.hdrOld = stripDiffPath(line.slice(4));
        cur.hdrNew = stripDiffPath(lines[i + 1].slice(4));
        cur.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw parseErr(i + 1);
      const m = HUNK_RE.exec(line);
      if (!m) throw parseErr(i + 1);
      const body = collectHunkBody(lines, i + 1);
      const split = splitBody(body.entries);
      cur.hunks.push({ A: parseInt(m[1], 10), ...split });
      i = body.nextIndex;
      continue;
    }
    if (cur && cur.hunks.length === 0) {
      // Section header, before its first hunk.
      if (line.startsWith('--- ')) throw parseErr(i + 2);
      if (line.startsWith('+++ ')) { cur.hdrNew = stripDiffPath(line.slice(4)); i++; continue; }
      if (line.startsWith('rename from ')) { cur.renameFrom = line.slice('rename from '.length).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { cur.renameTo = line.slice('rename to '.length).trim(); i++; continue; }
      if (line.startsWith('new file mode')) { cur.newFile = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { cur.deletedFile = true; i++; continue; }
      i++; // index, modes, similarity lines and anything else are ignored
      continue;
    }
    i++; // prose / code fences outside bodies are ignored
  }
  if (sections.length === 0) throw parseErr(1);
  return sections.map((sec) => {
    const oldPath = sec.hdrOld !== undefined ? sec.hdrOld
      : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newPath = sec.hdrNew !== undefined ? sec.hdrNew
      : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    let kind;
    if (oldPath === '/dev/null' || sec.newFile) kind = 'create';
    else if (newPath === '/dev/null' || sec.deletedFile) kind = 'delete';
    else if (oldPath !== newPath) kind = 'move';
    else kind = 'change';
    return { kind, oldPath, newPath, hunks: sec.hunks };
  });
}

const movePairs = []; // successful moves, for R lines in the output

function applyUnifiedEdit(sec, strict) {
  const paths = sec.kind === 'create' ? [sec.newPath]
    : sec.kind === 'delete' ? [sec.oldPath]
    : sec.kind === 'move' ? [sec.oldPath, sec.newPath]
    : [sec.oldPath];
  for (const p of paths) if (!isSafe(p)) return { code: 'unsafe', path: p };
  if (sec.kind === 'create') {
    if (getFile(sec.newPath) !== null) return { code: 'exists', path: sec.newPath };
    const plus = [];
    let lastPlusBs = null;
    for (const h of sec.hunks) {
      // Re-collect '+' lines: they are N lines that are not context lines.
      for (let j = 0; j < h.N.length; j++) if (h.nCtx[j] < 0) plus.push(h.N[j]);
      if (h.lastPlusBackslash !== null) lastPlusBs = h.lastPlusBackslash;
    }
    const text = plus.length ? plus.join('\n') + (lastPlusBs ? '' : '\n') : '';
    setFile(sec.newPath, text);
    return null;
  }
  if (sec.kind === 'delete') {
    if (getFile(sec.oldPath) === null) return { code: 'missing', path: sec.oldPath };
    setFile(sec.oldPath, null);
    return null;
  }
  if (sec.kind === 'move') {
    if (getFile(sec.oldPath) === null) return { code: 'missing', path: sec.oldPath };
    if (getFile(sec.newPath) !== null) return { code: 'exists', path: sec.newPath };
    const cur = getFile(sec.oldPath);
    let text = cur;
    if (sec.hunks.length) {
      text = applyUnifiedHunks(cur, sec.hunks, strict);
      if (text === null) return { code: 'no-match', path: sec.oldPath };
    }
    setFile(sec.newPath, text);
    setFile(sec.oldPath, null);
    movePairs.push({ old: sec.oldPath, new: sec.newPath });
    return null;
  }
  // change
  if (getFile(sec.oldPath) === null) return { code: 'missing', path: sec.oldPath };
  const cur = getFile(sec.oldPath);
  let text = cur;
  if (sec.hunks.length) {
    text = applyUnifiedHunks(cur, sec.hunks, strict);
    if (text === null) return { code: 'no-match', path: sec.oldPath };
  }
  setFile(sec.oldPath, text);
  return null;
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

function parseSearchReplace(lines) {
  const blocks = [];
  let i = 0;
  let prevEnd = -1; // index of the previous block's >>>>>>> REPLACE line
  while (i < lines.length) {
    if (stripTrailingST(lines[i]) === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let p = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j].trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        p = t;
        break;
      }
      if (p === null) {
        if (blocks.length) p = blocks[blocks.length - 1].path;
        else throw parseErr(searchLine);
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (stripTrailingST(lines[j]) === '<<<<<<< SEARCH') break;
        if (stripTrailingST(lines[j]) === '=======') { eq = j; break; }
      }
      if (eq === -1) throw parseErr(searchLine);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (stripTrailingST(lines[j]) === '<<<<<<< SEARCH') break;
        if (stripTrailingST(lines[j]) === '>>>>>>> REPLACE') { rep = j; break; }
      }
      if (rep === -1) throw parseErr(searchLine);
      blocks.push({
        path: p,
        oldLines: lines.slice(i + 1, eq),
        newLines: lines.slice(eq + 1, rep),
      });
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw parseErr(1);
  return blocks;
}

function applySearchReplaceEdit(b, strict) {
  if (!isSafe(b.path)) return { code: 'unsafe', path: b.path };
  if (b.oldLines.length === 0) {
    if (getFile(b.path) !== null) return { code: 'exists', path: b.path };
    setFile(b.path, b.newLines.length ? b.newLines.join('\n') + '\n' : '');
    return null;
  }
  const cur = getFile(b.path);
  if (cur === null) return { code: 'missing', path: b.path };
  const f = parseFile(cur);
  const found = firstTierWith(f.lines, b.oldLines, 0, strict, false);
  if (!found) return { code: 'no-match', path: b.path };
  if (found.occs.length > 1) return { code: 'ambiguous', path: b.path };
  const rep = buildReplacement(f.lines, found.occs[0], b.oldLines, b.newLines,
    b.newLines.map(() => -1), found.tier);
  f.lines.splice(found.occs[0], b.oldLines.length, ...rep);
  setFile(b.path, serializeFile(f.lines, f.br, f.ends));
  return null;
}

// ---------- V4A patches (section 8) ----------

function v4aSpanEnd(lines, start, last) {
  let j = start;
  while (j < last) {
    const L = lines[j];
    if (L.startsWith('*** Add File: ') || L.startsWith('*** Delete File: ')
      || L.startsWith('*** Update File: ')) break;
    j++;
  }
  return j;
}

function parseV4AUpdate(lines, start, end, updateLineNo) {
  let moveTo = null;
  let pos = start;
  if (pos < end && lines[pos].startsWith('*** Move to: ')) {
    moveTo = lines[pos].slice('*** Move to: '.length).trim();
    pos++;
  }
  const chunks = [];
  let cur = null;
  function closeChunk() {
    if (cur) { chunks.push(cur); cur = null; }
  }
  let j = pos;
  while (j < end) {
    const L = lines[j];
    if (L.startsWith('@@')) {
      closeChunk();
      cur = { anchor: L.slice(2).trim(), endOfFile: false, entries: [] };
      j++;
      continue;
    }
    if (L === '*** End of File') {
      if (!cur) throw parseErr(j + 1);
      cur.endOfFile = true;
      closeChunk();
      j++;
      continue;
    }
    if (L.startsWith('*** ')) throw parseErr(j + 1);
    if (L === '') {
      if (cur) {
        cur.entries.push({ kind: ' ', text: '', bs: false });
        j++;
        continue;
      }
      // No chunk open: a blank line counts as an empty context line only when
      // the next non-blank line is a body line that would start the first chunk.
      let k = j + 1;
      while (k < end && lines[k] === '') k++;
      if (k < end && (lines[k].startsWith(' ') || lines[k].startsWith('-') || lines[k].startsWith('+'))) {
        if (chunks.length > 0) throw parseErr(k + 1);
        cur = { anchor: null, endOfFile: false, entries: [] };
        for (let b = j; b < k; b++) cur.entries.push({ kind: ' ', text: '', bs: false });
        j = k;
        continue;
      }
      j = k;
      continue;
    }
    if (L.startsWith(' ') || L.startsWith('-') || L.startsWith('+')) {
      if (!cur) {
        if (chunks.length > 0) throw parseErr(j + 1);
        cur = { anchor: null, endOfFile: false, entries: [] };
      }
      cur.entries.push({ kind: L[0], text: L.slice(1), bs: false });
      j++;
      continue;
    }
    throw parseErr(j + 1);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw parseErr(updateLineNo);
  return { moveTo, chunks };
}

function parseV4A(lines) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) { if (first === -1) first = i; last = i; }
  }
  if (first === -1) throw parseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw parseErr(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw parseErr(lines.length + 1);
  const sections = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const spanEnd = v4aSpanEnd(lines, i + 1, last);
      let end = spanEnd;
      while (end > i + 1 && isBlank(lines[end - 1])) end--;
      const content = [];
      for (let j = i + 1; j < end; j++) {
        const L = lines[j];
        if (L === '') content.push('');
        else if (L.startsWith('+')) content.push(L.slice(1));
        else throw parseErr(j + 1);
      }
      sections.push({ kind: 'add', path: p, lines: content });
      i = spanEnd;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      const spanEnd = v4aSpanEnd(lines, i + 1, last);
      let end = spanEnd;
      while (end > i + 1 && isBlank(lines[end - 1])) end--;
      for (let j = i + 1; j < end; j++) throw parseErr(j + 1);
      sections.push({ kind: 'delete', path: p });
      i = spanEnd;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const spanEnd = v4aSpanEnd(lines, i + 1, last);
      let end = spanEnd;
      while (end > i + 1 && isBlank(lines[end - 1])) end--;
      const sec = parseV4AUpdate(lines, i + 1, end, i + 1);
      sections.push({ kind: 'update', path: p, moveTo: sec.moveTo, chunks: sec.chunks });
      i = spanEnd;
      continue;
    }
    throw parseErr(i + 1);
  }
  if (sections.length === 0) throw parseErr(1);
  return sections;
}

function findAnchor(lines, anchor, cursor, strict) {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(lines[i], anchor, tier)) return i;
    }
  }
  return -1;
}

function applyV4AEdit(sec, strict) {
  if (!isSafe(sec.path)) return { code: 'unsafe', path: sec.path };
  if (sec.kind === 'add') {
    if (getFile(sec.path) !== null) return { code: 'exists', path: sec.path };
    setFile(sec.path, sec.lines.length ? sec.lines.join('\n') + '\n' : '');
    return null;
  }
  if (sec.kind === 'delete') {
    if (getFile(sec.path) === null) return { code: 'missing', path: sec.path };
    setFile(sec.path, null);
    return null;
  }
  // update
  if (sec.moveTo !== null && !isSafe(sec.moveTo)) return { code: 'unsafe', path: sec.moveTo };
  const cur = getFile(sec.path);
  if (cur === null) return { code: 'missing', path: sec.path };
  if (sec.moveTo !== null && getFile(sec.moveTo) !== null) return { code: 'exists', path: sec.moveTo };
  const f = parseFile(cur);
  let cursor = 0;
  for (const ch of sec.chunks) {
    const split = splitBody(ch.entries);
    if (ch.anchor !== null && ch.anchor !== '') {
      const pos = findAnchor(f.lines, ch.anchor, cursor, strict);
      if (pos === -1) return { code: 'no-match', path: sec.path };
      cursor = pos + 1;
    }
    if (split.O.length === 0) {
      const at = ch.endOfFile ? f.lines.length : cursor;
      f.lines.splice(at, 0, ...split.N);
      cursor = at + split.N.length;
    } else {
      const found = firstTierWith(f.lines, split.O, cursor, strict, ch.endOfFile);
      if (!found) return { code: 'no-match', path: sec.path };
      const idx = found.occs[0];
      const rep = buildReplacement(f.lines, idx, split.O, split.N, split.nCtx, found.tier);
      f.lines.splice(idx, split.O.length, ...rep);
      cursor = idx + rep.length;
    }
  }
  const newText = serializeFile(f.lines, f.br, f.ends);
  if (sec.moveTo !== null) {
    setFile(sec.moveTo, newText);
    setFile(sec.path, null);
    movePairs.push({ old: sec.path, new: sec.moveTo });
  } else {
    setFile(sec.path, newText);
  }
  return null;
}

// ---------- JSON edits (section 9) ----------

function validateJSONEdit(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false;
  if (typeof o.path !== 'string') return false;
  if (typeof o.command !== 'string') return false;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return false;
  } else if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return false;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return false;
  } else if (o.command === 'insert') {
    if (!Number.isInteger(o.insert_line)) return false;
    if (typeof o.new_str !== 'string') return false;
  } else return false;
  return true;
}

function parseJSONPatch(lines, text) {
  const firstNonBlank = lines.findIndex((l) => !isBlank(l));
  if (firstNonBlank === -1) throw parseErr(1);
  const arrayStartLine = firstNonBlank + 1;
  let parsed = null;
  let parsedOk = false;
  try { parsed = JSON.parse(text); parsedOk = true; } catch (e) { /* not whole-text JSON */ }
  if (parsedOk && Array.isArray(parsed)) {
    if (parsed.length === 0) throw parseErr(1);
    for (const el of parsed) if (!validateJSONEdit(el)) throw parseErr(arrayStartLine);
    return parsed.map((el) => ({
      command: el.command,
      path: el.path,
      file_text: el.file_text,
      old_str: el.old_str,
      new_str: el.command === 'str_replace' ? (el.new_str === undefined ? '' : el.new_str) : el.new_str,
      insert_line: el.insert_line,
    }));
  }
  // JSON Lines: one edit object per line, blank lines ignored.
  const edits = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (isBlank(L)) continue;
    let obj = null;
    try { obj = JSON.parse(L); } catch (e) { throw parseErr(i + 1); }
    if (!validateJSONEdit(obj)) throw parseErr(i + 1);
    edits.push({
      command: obj.command,
      path: obj.path,
      file_text: obj.file_text,
      old_str: obj.old_str,
      new_str: obj.command === 'str_replace' ? (obj.new_str === undefined ? '' : obj.new_str) : obj.new_str,
      insert_line: obj.insert_line,
    });
  }
  if (edits.length === 0) throw parseErr(1);
  return edits;
}

function splitNewStr(s) {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function applyJSONEdit(e) {
  if (!isSafe(e.path)) return { code: 'unsafe', path: e.path };
  if (e.command === 'create') {
    if (getFile(e.path) !== null) return { code: 'exists', path: e.path };
    setFile(e.path, e.file_text);
    return null;
  }
  if (e.command === 'str_replace') {
    const cur = getFile(e.path);
    if (cur === null) return { code: 'missing', path: e.path };
    const f = parseFile(cur);
    let text = cur;
    let oldS = e.old_str;
    let newS = e.new_str;
    if (f.br === '\r\n') {
      text = cur.replace(/\r\n/g, '\n');
      oldS = e.old_str.replace(/\r\n/g, '\n');
      newS = e.new_str.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let firstIdx = -1;
    for (let i = 0; i + oldS.length <= text.length; i++) {
      if (text.startsWith(oldS, i)) { count++; if (firstIdx === -1) firstIdx = i; }
    }
    if (count === 0) return { code: 'no-match', path: e.path };
    if (count > 1) return { code: 'ambiguous', path: e.path };
    let res = text.slice(0, firstIdx) + newS + text.slice(firstIdx + oldS.length);
    if (f.br === '\r\n') res = res.replace(/\n/g, '\r\n');
    setFile(e.path, res);
    return null;
  }
  // insert
  const cur = getFile(e.path);
  if (cur === null) return { code: 'missing', path: e.path };
  const f = parseFile(cur);
  if (e.insert_line < 0 || e.insert_line > f.lines.length) return { code: 'no-match', path: e.path };
  const ins = splitNewStr(e.new_str);
  f.lines.splice(e.insert_line, 0, ...ins);
  setFile(e.path, serializeFile(f.lines, f.br, f.ends));
  return null;
}

// ---------- format detection (section 4) ----------

function detectFormat(lines) {
  const firstNonBlank = lines.findIndex((l) => !isBlank(l));
  if (firstNonBlank === -1) return null;
  const first = lines[firstNonBlank].trim();
  if (first === '*** Begin Patch') return 'v4a';
  const firstNonWS = lines[firstNonBlank].replace(/^\s+/, '');
  if (firstNonWS.startsWith('[') || firstNonWS.startsWith('{')) return 'json';
  for (const l of lines) if (stripTrailingST(l) === '<<<<<<< SEARCH') return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------- CLI parsing (section 1) ----------

function parseArgs(argv) {
  let format = 'auto';
  let check = false;
  let strict = false;
  const seen = new Set();
  const positional = [];
  let noMoreOpts = false;
  for (const a of argv) {
    if (!noMoreOpts && a === '--') { noMoreOpts = true; continue; }
    if (!noMoreOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seen.has('check')) return null;
        seen.add('check'); check = true;
      } else if (a === '--strict') {
        if (seen.has('strict')) return null;
        seen.add('strict'); strict = true;
      } else if (a.startsWith('--format=')) {
        if (seen.has('format')) return null;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        seen.add('format'); format = v;
      } else return null;
    } else positional.push(a);
  }
  if (positional.length > 1) return null;
  return { format, check, strict, patch: positional.length ? positional[0] : null };
}

// ---------- output (section 2) ----------

function writeStdout(text) {
  fs.writeSync(1, text);
}

function computeOutputLines() {
  const changed = [];
  const allPaths = new Set([...orig.keys(), ...state.keys()]);
  for (const p of allPaths) {
    const before = orig.has(p) ? orig.get(p) : null;
    const after = state.has(p) ? state.get(p) : null;
    if (before !== after) changed.push({ path: p, before, after });
  }
  const covered = new Set();
  const lines = [];
  for (const mp of movePairs) {
    const beforeOld = orig.has(mp.old) ? orig.get(mp.old) : null;
    const afterOld = state.has(mp.old) ? state.get(mp.old) : null;
    const beforeNew = orig.has(mp.new) ? orig.get(mp.new) : null;
    const afterNew = state.has(mp.new) ? state.get(mp.new) : null;
    if (beforeOld !== null && afterOld === null && beforeNew === null && afterNew !== null) {
      lines.push({ sortKey: mp.new, text: `R ${mp.old} -> ${mp.new}` });
      covered.add(mp.old);
      covered.add(mp.new);
    }
  }
  for (const c of changed) {
    if (covered.has(c.path)) continue;
    let text;
    if (c.before === null) text = `A ${c.path}`;
    else if (c.after === null) text = `D ${c.path}`;
    else text = `M ${c.path}`;
    lines.push({ sortKey: c.path, text });
  }
  lines.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')));
  return { lines: lines.map((l) => l.text), changed };
}

function writeChangedFiles(changed) {
  for (const c of changed) {
    const full = path.join(process.cwd(), ...c.path.split('/'));
    if (c.after === null) {
      fs.unlinkSync(full);
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, c.after, 'utf8');
    }
  }
}

// ---------- main ----------

function runCli(argv) {
  const args = parseArgs(argv);
  if (args === null) {
    writeStdout('error: usage\n');
    process.exitCode = 2;
    return;
  }
  let patchText;
  if (args.patch === null || args.patch === '-') {
    patchText = fs.readFileSync(0, 'utf8');
  } else {
    try {
      patchText = fs.readFileSync(path.resolve(process.cwd(), args.patch), 'utf8');
    } catch (e) {
      writeStdout('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }
  const lines = patchLines(patchText);
  let format = args.format;
  if (format === 'auto') {
    format = detectFormat(lines);
    if (format === null) {
      writeStdout('error: format\n');
      process.exitCode = 2;
      return;
    }
  }
  let edits;
  try {
    if (format === 'unified') {
      edits = parseUnified(lines).map((sec) => ({
        apply: () => applyUnifiedEdit(sec, args.strict),
      }));
    } else if (format === 'search-replace') {
      edits = parseSearchReplace(lines).map((b) => ({
        apply: () => applySearchReplaceEdit(b, args.strict),
      }));
    } else if (format === 'v4a') {
      edits = parseV4A(lines).map((sec) => ({
        apply: () => applyV4AEdit(sec, args.strict),
      }));
    } else {
      edits = parseJSONPatch(lines, patchText).map((e) => ({
        apply: () => applyJSONEdit(e),
      }));
    }
  } catch (e) {
    if (e && typeof e.parseLine === 'number') {
      writeStdout('error: parse ' + e.parseLine + '\n');
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const failures = [];
  for (const edit of edits) {
    const snap = new Map(state);
    const r = edit.apply();
    if (r) {
      state.clear();
      for (const [k, v] of snap) state.set(k, v);
      failures.push(r);
    }
  }
  if (failures.length) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`).join('\n')
      + '\n' + `failed: ${failures.length} of ${edits.length} edits` + '\n';
    writeStdout(out);
    process.exitCode = 1;
    return;
  }
  const { lines: outLines, changed } = computeOutputLines();
  if (!args.check) writeChangedFiles(changed);
  const n = outLines.length;
  const tail = `ok: ${n} file${n === 1 ? '' : 's'}` + '\n';
  writeStdout((outLines.length ? outLines.join('\n') + '\n' : '') + tail);
  process.exitCode = 0;
}

// ---------- trial hand-over ----------
if (process.env.MAKEFUN_ENV_URL) {
  const runner = await import('./runner.ts');
  await runner.runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  runCli(process.argv.slice(2));
}
