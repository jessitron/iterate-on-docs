# TODO

## Next

- [ ] `overview-skill` Skill that makes an HTML project overview  ← mountain: successful
  - No existing skill found. The seed is `VISUAL-OVERVIEW-CONVENTION.md` in the seamapping plugin (marked DRAFT): a single `OVERVIEW.html` at repo root.
  - The output should be iterable with `html-iteration`.
  - Drafted 2026-10-11: `skills/make-a-project-overview/SKILL.md`, a sanitized version of the convention (no seamap, no personal conventions). The Jess-specific version stays in seamapping under a different name (tronijess-skills TODO `rename-seamap-overview`). Remaining: try it on a real project.
- [ ] `marketplace-json` Make this repo its own marketplace  ← mountain: published
  - Add `.claude-plugin/marketplace.json` and `plugin.json`. Do the one-time install-from-GitHub check to prove the config.
  - Config written 2026-10-07; `claude plugin validate .` passes (one warning: root CLAUDE.md isn't shipped as plugin context — expected). Assumes GitHub owner `jessitron`. Remaining: push to github.com/jessitron/iterate-on-docs, then `/plugin marketplace add jessitron/iterate-on-docs` and install `iterate-on-docs` once in a clean project.
- [ ] `readme` Write a README intelligible to someone unfamiliar with any of this  ← mountain: published
  - Drafted 2026-10-09. Install commands are unverified until `marketplace-json` is pushed and tested. Needs a read by someone unfamiliar with it.

## Backlog

- [ ] `rename-viewer` Decide whether html-with-comments needs a better name
- [ ] `share-it` Invite someone else to try it
  - Treasure, not a requirement: someone else installs it and gets use out of it.

## Done

- [x] `license` Add a LICENSE at repo root and a `license` field in plugin.json  ← mountain: published
  - The vendored html-with-comments carries its own LICENSE; the plugin as a whole has none yet.
  - Done 2026-10-09: CC0 1.0 at root, same as the vendored server. `license: CC0-1.0` in plugin.json.
- [x] `git-opinions` Decide how opinionated the published loop is about git and committing
  - Decided 2026-10-07: keep the commits. They make each turn's edits legible. People can rewrite history afterward.
- [x] `markdown-iteration` Bring the iterate-on-a-document skill over for markdown  ← mountain: successful
  - Source: the seamapping plugin's `iterate-on-a-document` skill (tronijess-skills). It works for markdown today.
  - Strip references to seamapping, tronijess-skills, and Jessitron's conventions (Self-contained constraint).
  - Done 2026-10-07: `skills/iterate-on-a-document/SKILL.md`. Commits kept; asks about `git init` when the file is not in a repo.
- [x] `vendor-hwc` Vendor the html-with-comments script into this plugin
  - Done 2026-10-07: copied into `html-with-comments/` from source HEAD 2bdfe8d. Tests pass from the new home.
  - Re-vendored 2026-10-07 from cff7fce, which bundles linkedom into `vendor/linkedom.mjs`. No `npm install` needed; Node 20+.
- [x] `hwc-deps` Decide how a fresh plugin install gets `linkedom`
  - Settled upstream: linkedom is bundled into `html-with-comments/vendor/linkedom.mjs`, so it runs without `npm install` (for example, behind a corporate proxy).
- [x] `hwc-author-default` The server's comment prefix defaulted to `jess`
  - Done 2026-10-08: default is `@AI` in our copy only, matching the skill's `@AI:` annotations. Recorded in `html-with-comments/VENDORED.md`.
- [x] `html-iteration` Iterate on HTML files the same way as markdown  ← mountain: successful
  - Write the HTML in a format html-with-comments accepts, run its formatter, open it in the viewer, read the comments, iterate.
  - The server reformats the file. Treat its output as the baseline so formatting changes don't read as the user's edits.
  - Launch: `node "${CLAUDE_PLUGIN_ROOT}/html-with-comments/server.mjs" <dir> --port 0`. Takes a directory, not a file. Startup prints `html-notes: http://localhost:<port>/ serving <root>`; read the port from it. The default 7777 crashes when taken. Opening a page (GET) rewrites the file in place.
  - Done 2026-10-08: folded into `skills/iterate-on-a-document/SKILL.md` as **HTML** steps (one loop). Fetch the page before every commit so normalization lands with its cause.
- [x] `local-install` Install the plugin locally from this directory for Jessitron's projects  ← mountain: successful
  - Done 2026-10-11: installed at user scope from this directory (`iterate-on-docs@iterate-on-docs`), enabled. Markdown and HTML iteration both confirmed working. How-to in `DEVELOPMENT.md`.
