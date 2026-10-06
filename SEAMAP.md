# SEAMAP — iterate-on-docs-plugin

## Quest

Let anyone refine a document with an agent by trading turns — mark it up, hand it back, repeat — whether it's markdown or a rendered HTML page.

## The Mountains

**Published:** Other people can install it, and it's intelligible to people unfamiliar with this.

**Successful:** It works for iterating.

## Safe Harbor

Pushed to GitHub, with the docs up to date. A fresh `/plugin marketplace add` and install from this repo, in a clean project, can iterate on a markdown file and an HTML file.

## How will we know it's working?

- **I use it.** Jessitron iterates on her own markdown and HTML documents with it, installed locally from this directory.
- **Someone else can use it.** The README is enough to install it and run an iteration, with no outside context needed. (A judgment call.)
- **The marketplace is configured.** A one-time install from GitHub succeeds.

## Enabling Constraints

- **Static HTML, owned by the server.** The html-with-comments server works on static HTML created for iteration, not dynamic pages. It modifies the HTML file, including reformatting it. That's normal here; it's what makes the server work.
- **html-with-comments lives here.** The script is vendored into this plugin because its purpose is here. It may or may not get published separately.
- **One loop, for now.** HTML iteration reuses the markdown iteration loop; only reading and commenting differ. This is a starting constraint; relax it if that's useful.
- **Self-contained.** Nothing refers to seamapping, tronijess-skills, or Jessitron's personal conventions. Someone unfamiliar with any of that can use it.

## Non-goals

- Commenting on dynamic or live web pages. Static, iteration-made HTML only.
- A general-purpose document editor or review tool. This is for agent-and-human turn-taking.
- Formats beyond markdown and HTML, like Word, Google Docs, or PDF.
- Running html-with-comments as a hosted or shared service. It runs locally, for one person.
