# CLAUDE.md

## Seamap

This repo's seamap — the chart and where work is recorded — lives in `SEAMAP.md`. Orient, capture,
and log proactively; use `drop-buoy` to capture work without derailing.

## Agent-neutral

The skills and the idea work with any coding agent. Only the packaging (`.claude-plugin/`) is
Claude Code's format. In user-facing text — descriptions, README, skills — say "your coding agent"
or "the agent", not "Claude". Name Claude Code only where the instructions are specific to it.

## The HTML server's contract

`html-revisor/` is deployed here from its own repo. The Contract section of its README lists
what this repo relies on, including the words the user sees in its page. The skills and README
here use those same words. When that repo changes its Contract, its agent makes the matching
edits here along with the deploy. If you find a mismatch, the Contract wins.
