# mend

![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zal-m10/hidden-spec-cli-01/rank.svg)
![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zal-m10/hidden-spec-cli-01/reward.svg)

[mend on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits to a tree of text
files. Models write edits in four formats, and mend reads all of them to a
single contract: unified diffs (even with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, and text-editor tool calls as JSON. It finds the lines an
edit names even when the model drifted their whitespace or indentation, using
three matching tiers from exact down to whitespace-insensitive, and it changes
every file or none: when any edit fails, no file is written at all.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

PATCH is the patch file, or standard input when it is absent or `-`.
`--format` picks one of `unified`, `search-replace`, `v4a`, `json`, or `auto`
(the default, which detects the format). `--check` validates and reports
without writing anything. `--strict` matches lines exactly.

On success mend prints one line per changed file (`A`, `D`, `M`, or `R` for a
move) and a final `ok: N files` line. On failure it prints one
`error: <code> <path>` line per failed edit and a `failed: k of n edits` line,
and writes nothing. Usage, missing patch, unknown format and parse problems
exit 2 with a single `error:` line.

## Requirements

Node 22 and its standard library only. No dependencies, no network, no
configuration.
