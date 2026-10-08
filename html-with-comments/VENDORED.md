# Vendored

This directory is a copy of html-with-comments, kept here because its purpose is this plugin.

Source: `~/code/jessitron/html-with-comments` at `cff7fce`.

## Local changes

Carry these forward each time you copy the source again.

- **Comment prefix is `@AI:`.** The default `--author` is `@AI`, matching the `@AI: <command>`
  annotations in the iterate-on-a-document skill. Upstream defaults to `jess`. Changed in
  `server.mjs`, `run`, `README.md`, `html-notes-spec.md`, and the tests.
- **README additions:** "Files it serves" under Design, and "Gotchas for maintainers".
- **Dropped:** the source's `CLAUDE.md` and nested `.gitignore`.

## To copy the source again

1. `rm -rf html-with-comments && mkdir html-with-comments`
2. `git -C ~/code/jessitron/html-with-comments archive <commit> | tar -x -C html-with-comments`
3. Restore this file, then apply the local changes above.
4. `cd html-with-comments && npm test` — no `npm install` needed; linkedom is in `vendor/`.
5. Update the commit hash above.
