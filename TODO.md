# TODO

## Next

- [ ] `markdown-iteration` Bring the iterate-on-a-document skill over for markdown  ← mountain: successful
  - Source: the seamapping plugin's `iterate-on-a-document` skill (tronijess-skills). It works for markdown today.
  - Strip references to seamapping, tronijess-skills, and Jessitron's conventions (Self-contained constraint).
- [ ] `vendor-hwc` Vendor the html-with-comments script into this plugin  ← mountain: successful
  - Source: `~/code/jessitron/html-with-comments`. Its purpose is here; copy it in, don't depend on it.
- [ ] `html-iteration` Iterate on HTML files the same way as markdown  ← mountain: successful; blocked-by: vendor-hwc, markdown-iteration
  - Write the HTML in a format html-with-comments accepts, run its formatter, open it in the viewer, read the comments, iterate.
  - The server reformats the file. Treat its output as the baseline so formatting changes don't read as the user's edits.
- [ ] `overview-skill` Skill that makes an HTML project overview  ← mountain: successful
  - No existing skill found. The seed is `VISUAL-OVERVIEW-CONVENTION.md` in the seamapping plugin (marked DRAFT): a single `OVERVIEW.html` at repo root.
  - The output should be iterable with `html-iteration`.
- [ ] `marketplace-json` Make this repo its own marketplace  ← mountain: published
  - Add `.claude-plugin/marketplace.json` and `plugin.json`. Do the one-time install-from-GitHub check to prove the config.
- [ ] `local-install` Install the plugin locally from this directory for Jessitron's projects  ← mountain: successful
- [ ] `readme` Write a README intelligible to someone unfamiliar with any of this  ← mountain: published

## Backlog

- [ ] `rename-viewer` Decide whether html-with-comments needs a better name
- [ ] `git-opinions` Decide how opinionated the published loop is about git and committing
  - The current skill assumes git and commits the user's edits each turn. Other people have other habits.
- [ ] `share-it` Invite someone else to try it
  - Treasure, not a requirement: someone else installs it and gets use out of it.

## Done
