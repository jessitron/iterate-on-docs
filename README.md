# iterate-on-docs

Programming is theory building: how does the world work now, and how should it work? We get that crisp, and then we ask the agent to make it true.

For that to work, we need an artifact that clarifies this theory both for us and for every agent we start up. This plugin is about creating those artifacts.

The core is iterate-on-a-document, an agent skill for refining a document with your coding agent by trading turns. You edit the
file and leave instructions for the agent in it. The agent applies the intent of your edits,
follows your instructions, and hands it back. Repeat until it makes you happy.

There's also make-a-project-overview, for a particular document that gets you aligned on purpose, architecture, language, and whatever else you want about a project.

Works on markdown and on basic static HTML, such as fancy design documents the agent writes to explain its plans to you. For HTML, you leave directives in the browser using a special server included in this plugin.

## Install

The skill is `skills/iterate-on-a-document/SKILL.md`, in the
[Agent Skills](https://agentskills.io) format that many coding agents read.

**Claude Code** installs it as a plugin:

```
/plugin marketplace add jessitron/iterate-on-docs
/plugin install iterate-on-docs@iterate-on-docs
```

**Other agents:** clone this repo and add `skills/iterate-on-a-document` (and, if you want it,
`skills/make-a-project-overview`) to your agent's skills.
Keep the repo together: the skill finds the HTML server at `../../html-revisor/` from its
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
write a directive:

```
@AI: make this section shorter
```

Then tell the agent "Your turn"

2. **The agent's turn.** It commits your edits as you made them, applies them everywhere else
   they fit, carries out each `@AI:` instruction, and removes the directives. It summarizes
   what it did and hands the file back.

3. When you're happy, say "good enough." The agent stops.

### HTML

For an `.html` file, the agent starts a local server and gives you a URL. Open it in a browser.
Click any element to leave a directive on it, or to change its wording. Your directives and
edits save into the HTML file as you type. You can still edit the file by hand.

The server rewrites the file into its own formatting when it loads the page. The agent commits
that rewrite by itself, so it doesn't mix with your edits. This is for HTML written to be
iterated on, not for live or generated web pages. The same formatter runs on its own as
`html-revisor/formatter.mjs`; the agent runs it after writing a page and before each commit.

The server is in [`html-revisor/`](html-revisor/README.md), with details on the
directive format.

## Project overview

A second skill, `skills/make-a-project-overview/SKILL.md`, draws a picture of a whole project:
one HTML page, `OVERVIEW.html` at the repo root, with diagrams of where the project is headed, its
architecture, and the current work. Then you iterate on it the same way, leaving directives in the browser.

> Make a project overview

## License

[CC0 1.0](LICENSE): public domain.
