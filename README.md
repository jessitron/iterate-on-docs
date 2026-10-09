# iterate-on-docs

An agent skill for refining a document with your coding agent by trading turns. You edit the
file and leave instructions for the agent in it. The agent applies the intent of your edits,
follows your instructions, and hands it back. Repeat until it's good.

Works on markdown and on basic static HTML, such as fancy design documents the agent writes to explain its plans to you. For HTML, you comment in the browser.

## Install

The skill is `skills/iterate-on-a-document/SKILL.md`, in the
[Agent Skills](https://agentskills.io) format that many coding agents read.

**Claude Code** installs it as a plugin:

```
/plugin marketplace add jessitron/iterate-on-docs
/plugin install iterate-on-docs@iterate-on-docs
```

**Other agents:** clone this repo and add `skills/iterate-on-a-document` to your agent's skills.
Keep the repo together: the skill finds the HTML server at `../../html-with-comments/` from its
own directory.

HTML needs Node 20 or later. Markdown needs nothing extra.

To run the plugin from a clone while you work on it, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Use

The file must be in a git repository. The agent commits at each turn, so every change shows in
the history. If the file isn't in a repository, the agent asks before running `git init`.

Ask your agent:

> Let's iterate on docs/proposal.md

Then trade turns:

1. **Your turn.** Edit the file however you like. If you change something in one place, it's the agents job to make the rest of the document consistent with that change.

Anywhere you want the agent to do something,
write an annotation:

```
@AI: make this section shorter
```

Then tell the agent "Your turn"

2. **The agent's turn.** It commits your edits as you made them, applies them everywhere else
   they fit, carries out each `@AI:` instruction, and removes the annotations. It summarizes
   what it did and hands the file back.

3. When you're happy, say "good enough." The agent stops.

### HTML

For an `.html` file, the agent starts a local server and gives you a URL. Open it in a browser.
Click any element to leave an `@AI` comment on it, or to change its wording. Your comments and
edits save into the HTML file as you type. You can still edit the file by hand.

The server rewrites the file into its own formatting when it loads the page. The agent commits
that rewrite by itself, so it doesn't mix with your edits. This is for HTML written to be
iterated on, not for live or generated web pages.

The server is in [`html-with-comments/`](html-with-comments/README.md), with details on the
comment format.

## License

[CC0 1.0](LICENSE): public domain.
