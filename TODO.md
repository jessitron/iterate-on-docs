# TODO

## Next

- [ ] get the README up to date
- [ ] `turn-commits` Decide what happens to iterate-on-a-document's per-turn commits
  - Surfaced while considering a "squash at the end" instruction for the skill.
  - The turn commits make the loop work (`git diff HEAD~1` separates the user's edits from the
    agent's), but most people may not want them in their repo's history.
  - Options: (1) leave as-is; (2) offer a squash at "good enough" (record the start commit; skip
    if pushed or interleaved with other work); (3) shadow git dir outside the project
    (`--git-dir`/`--work-tree`), so the file stays in place, the real repo sees one diff, and no
    repo is required; (4) iterate on a branch and end with a kept merge commit (Jess's favorite).
  - People's git processes vary. Get feedback from more users before deciding.
- [x] can we simplify the iterate-on-a-document skill? ask the agent. (HTML steps moved to html.md; the server takes the file)

## Backlog

- [x] Rename html-with-comments to html-revisor
- [ ] get someone to proofread the README and tell me whether it makes sense
- [ ] test installing the plugin somewhere that doesn't have it locally
