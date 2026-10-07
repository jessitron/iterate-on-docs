# TODO

## Next

- [ ] `html-iteration` Iterate on HTML files the same way as markdown  ← mountain: successful
  - Write the HTML in a format html-with-comments accepts, run its formatter, open it in the viewer, read the comments, iterate.
  - The server reformats the file. Treat its output as the baseline so formatting changes don't read as the user's edits.
  - Launch: `node "${CLAUDE_PLUGIN_ROOT}/html-with-comments/server.mjs" <dir> --port 0 --author <name>`. Takes a directory, not a file. Startup prints `html-notes: http://localhost:<port>/ serving <root>`; read the port from it. The default 7777 crashes when taken. Opening a page (GET) rewrites the file in place.
- [ ] `hwc-author-default` The server's comment prefix defaults to `jess` (`parseArgs` in `server.mjs`; spec, README, tests too)  ← mountain: published
  - Self-contained constraint. Pick a neutral default, or have the skill always pass `--author`.
- [ ] `hwc-deps` Decide how a fresh plugin install gets `linkedom`  ← mountain: published
  - `node_modules` is gitignored, so `server.mjs` fails on import after install. Options: launch via `run` (runs `npm install` on first use; needs npm + network, writes into the plugin cache), commit `node_modules`, bundle into one file, or a README install step. Needs Node 20+.
- [ ] `overview-skill` Skill that makes an HTML project overview  ← mountain: successful
  - No existing skill found. The seed is `VISUAL-OVERVIEW-CONVENTION.md` in the seamapping plugin (marked DRAFT): a single `OVERVIEW.html` at repo root.
  - The output should be iterable with `html-iteration`.
- [ ] `marketplace-json` Make this repo its own marketplace  ← mountain: published
  - Add `.claude-plugin/marketplace.json` and `plugin.json`. Do the one-time install-from-GitHub check to prove the config.
  - Config written 2026-10-07; `claude plugin validate .` passes (one warning: root CLAUDE.md isn't shipped as plugin context — expected). Assumes GitHub owner `jessitron`. Remaining: push to github.com/jessitron/iterate-on-docs, then `/plugin marketplace add jessitron/iterate-on-docs` and install `iterate-on-docs` once in a clean project.
- [ ] `local-install` Install the plugin locally from this directory for Jessitron's projects  ← mountain: successful
- [ ] `readme` Write a README intelligible to someone unfamiliar with any of this  ← mountain: published
- [ ] `license` Add a LICENSE at repo root and a `license` field in plugin.json  ← mountain: published
  - The vendored html-with-comments carries its own LICENSE; the plugin as a whole has none yet.

## Backlog

- [ ] `rename-viewer` Decide whether html-with-comments needs a better name
- [ ] `share-it` Invite someone else to try it
  - Treasure, not a requirement: someone else installs it and gets use out of it.

## Done

- [x] `git-opinions` Decide how opinionated the published loop is about git and committing
  - Decided 2026-10-07: keep the commits. They make each turn's edits legible. People can rewrite history afterward.
- [x] `markdown-iteration` Bring the iterate-on-a-document skill over for markdown  ← mountain: successful
  - Source: the seamapping plugin's `iterate-on-a-document` skill (tronijess-skills). It works for markdown today.
  - Strip references to seamapping, tronijess-skills, and Jessitron's conventions (Self-contained constraint).
  - Done 2026-10-07: `skills/iterate-on-a-document/SKILL.md`. Commits kept; asks about `git init` when the file is not in a repo.
- [x] `vendor-hwc` Vendor the html-with-comments script into this plugin
  - Done 2026-10-07: copied into `html-with-comments/` from source HEAD 2bdfe8d. Tests pass from the new home.
