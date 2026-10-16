# Development

How to run this plugin from your clone, so other projects use your working copy instead of the
GitHub release. Paths below assume the clone is at `~/code/jessitron/iterate-on-docs`.

## Option 2: install from a local marketplace

The repo is its own marketplace (`.claude-plugin/marketplace.json`). Add it by path:

```
claude plugin marketplace add ~/code/jessitron/iterate-on-docs
claude plugin install iterate-on-docs@iterate-on-docs
```

The install works in every session without a flag, but it is a **snapshot**. Claude Code copies
the plugin into `$CLAUDE_CONFIG_DIR/plugins/cache/iterate-on-docs/iterate-on-docs/<version>/`
and runs that copy. Your edits don't reach other projects until you refresh it:

```
claude plugin marketplace update iterate-on-docs
claude plugin update iterate-on-docs@iterate-on-docs
```

Commit before you update; the cache records the git SHA it copied. If the update doesn't pick up
a change, bump `version` in `.claude-plugin/plugin.json`, because the cache is keyed by version.

## Don't run both

If you installed the GitHub release (`/plugin marketplace add jessitron/iterate-on-docs`), it has
the same plugin name and marketplace name as the local one. Remove it first:

```
/plugin uninstall iterate-on-docs@iterate-on-docs
/plugin marketplace remove iterate-on-docs
```

Run `/plugin` to see which marketplace a plugin came from.

## Check your changes

```
claude plugin validate .
```

It warns that `CLAUDE.md` at the root isn't loaded as plugin context. That's expected: CLAUDE.md
is for working on this repo, not for users of the plugin.

The HTML server has its own tests and needs Node 20 or later:

```
cd html-revisor && npm test
```

## Release

Installed copies update only when `version` in `.claude-plugin/plugin.json` changes, so every
release bumps it. From a clean `main`:

```
./release            # patch bump, commit, tag; prints the push command
./release minor      # or major, or an exact x.y.z
./release --push     # also push main and the tag to GitHub
```

It runs the HTML server's tests first.

## Updating the HTML server

`html-revisor/` is a copy. The code lives in `~/code/jessitron/html-revisor`, and its
`deploy` script replaces this directory and commits here. Don't edit the copy. A deploy is not a
release: run `./release` afterward to ship it.

## Images for the README

An install copies everything on `main` into the plugin cache, so images stay off `main`. They
live on the orphan `assets` branch, and the README links to them by raw URL
(`https://raw.githubusercontent.com/jessitron/iterate-on-docs/assets/<file>`). To add one,
commit it to `assets` and push that branch:

```
git switch assets            # or: git worktree add ../assets assets
git add picture.webp && git commit
git push origin assets
```

Compress first; `cwebp -q 85 picture.png -o picture.webp` shrinks a PNG comic about tenfold.
