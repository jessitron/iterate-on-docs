# iterate-on-docs

A Claude Code plugin for refining a document with Claude by trading turns. You edit the file
and leave instructions for Claude in it. Claude applies the intent of your edits, follows your
instructions, and hands it back. Repeat until it's good.

Works on markdown and on static HTML. For HTML, you comment in the browser.

## Install

In Claude Code:

```
/plugin marketplace add jessitron/iterate-on-docs
/plugin install iterate-on-docs@iterate-on-docs
```

HTML needs Node 20 or later. Markdown needs nothing extra.

## Use

The file must be in a git repository. Claude commits at each turn, so every change shows in the
history. If the file isn't in a repository, Claude asks before running `git init`.

Ask Claude:

> Let's iterate on docs/proposal.md

or run `/iterate-on-docs:iterate-on-a-document docs/proposal.md`.

Then trade turns:

1. **Your turn.** Edit the file however you like. Anywhere you want Claude to do something,
   write an annotation:

   ```
   @AI: make this section shorter
   ```

   Then tell Claude you're done.

2. **Claude's turn.** Claude commits your edits as you made them, applies them everywhere else
   they fit, carries out each `@AI:` instruction, and removes the annotations. It summarizes
   what it did and hands the file back.

3. When you're happy, say "good enough." Claude stops.

### HTML

For an `.html` file, Claude starts a local server and gives you a URL. Open it in a browser.
Click any element to leave an `@AI` comment on it, or to change its wording. Your comments and
edits save into the HTML file as you type. You can still edit the file by hand.

The server rewrites the file into its own formatting when it loads the page. Claude commits that
rewrite by itself, so it doesn't mix with your edits. This is for HTML written to be iterated on,
not for live or generated web pages.

The server is in [`html-with-comments/`](html-with-comments/README.md), with details on the
comment format.
