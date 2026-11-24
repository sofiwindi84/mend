[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sofiwindi84/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sofiwindi84/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

mend is a command-line tool that applies the edits AI models write to a tree
of text files. It reads a patch in one of four formats — a unified diff, a
SEARCH/REPLACE block, a V4A patch, or JSON edit objects — finds the lines
each edit names, and writes every change or none of them.

Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

PATCH is the path of the patch file, or standard input when it is absent or
`-`. `--format` picks one format (`unified`, `search-replace`, `v4a`, `json`,
or `auto`, the default, which detects it). `--check` reports what would change
without writing anything. `--strict` matches lines exactly. Node 22 and its
standard library alone; there is nothing to install.

The full contract is SPEC.md. The practice checks live in the kit at
`program/generator/practice.json` and can be run with `node check.ts
<path to practice.json>`.

Bounty: https://make.fun/bounty/hidden-spec-cli-01-run-20261122
