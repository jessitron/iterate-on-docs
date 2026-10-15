# iterate-on-docs

You and your agent make or revise a document together.

The core is iterate-on-a-document, an agent skill for refining a document with your coding agent by trading turns. You edit the
file and leave instructions for the agent in it. The agent applies the intent of your edits,
follows your instructions, and hands it back. Repeat until it makes you happy.

![You toss ideas to the agent; it hands back a document; you mark it up in red; it hands back a revision; you say "good enough!"](https://raw.githubusercontent.com/jessitron/iterate-on-docs/assets/comic.webp)

Programming is theory building: how does the world work now, and how should it work? We get that crisp, and then we ask the agent to make it true. For that to work, we need an artifact that clarifies this theory both for us and for every agent we start up. This plugin is about creating those artifacts.

So there's also make-a-project-overview, for a particular document that gets you aligned on purpose, architecture, language, and whatever else you want about a project.

This works on markdown (or text ig) and on static HTML. For HTML, you leave directives in the browser using a special server included in this plugin. Now you can ask your agent to explain its plans in fancy HTML docs, with SVG diagrams!

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

**The agent commits at each turn**, so every change shows in a git history. It picks where those
commits go to fit how your project works: on your branch, squashed at the end, on a branch merged
back with a merge commit, or in a scratch repository outside your project. It tells you which, and
you can ask for another. The file doesn't need to be in a git repository.

Ask your agent:

> Explain your plan to me in HTML, and then let's iterate on that document.

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

This is based on Arlo Belshee's iteration process. 

### HTML

For `.html` files, the agent starts a local server and gives you a URL. Open it in a browser.
Click a block, a link, an image, a section, part of an SVG, whatever! to leave a directive on it, or to change its
wording. Your directives and edits save into the HTML file as you type.

The server rewrites the file into its own formatting when it starts and each time it loads the page, and writes an
element ID (`data-hrv`) on each element you can pick. The agent commits
that rewrite by itself, so it doesn't mix with your edits.

This is for static HTML written to be iterated on, not for live or generated or fancy web pages.

The server is in [`html-revisor/`](html-revisor/README.md). To use it on its own, grab it from [the source repo](https://github.com/jessitron/html-revisor).

## Project overview

A second skill, `skills/make-a-project-overview/SKILL.md`, draws a picture of a whole project:
one HTML page, `OVERVIEW.html` at the repo root, with diagrams of where the project is headed, its
architecture, and the current work. Then you iterate on it the same way, leaving directives in the browser. Here's an [example](https://jessitron.github.io/html-revisor/OVERVIEW.html).

> Make a project overview

## License

[CC0 1.0](LICENSE): public domain.
