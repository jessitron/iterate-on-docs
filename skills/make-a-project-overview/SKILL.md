---
name: make-a-project-overview
description: >-
  Draw a visual overview of a whole project: one self-contained HTML page, `OVERVIEW.html` at the
  repo root, with diagrams of where the project is headed, its architecture, and the current work.
  Stingy with words, made for a human to take in fast. Then refine it with the user. Use when the user says "make a project overview", "draw me a picture of this project", "give me an overview page", or "update the overview".
---

# Make a project overview

Goal: give a human a fast picture of a whole project in one HTML page, then refine it with them
until they say it is good enough.

Quest: make this project live in the human's head, and in the agent's understanding, consistent with each other and with the code.

## What the overview is

A single HTML page, `OVERVIEW.html` at the repo root. It conveys information with pictures and
diagrams, and it is stingy with words. It is HTML with diagrams, not markdown, because it
optimizes for rapid human comprehension.

**Audience.** People who come to the project: its author coming back after time away and wanting
their bearings, teammates, newcomers. Its author also reads it over time, to see how the
architecture changes. Agents can read it, but it is not written for them; agent-facing notes stay
in markdown.

**Usual material, not a template.** Choose what helps this reader, on this project, now. One
project needs no context map; another needs a picture nobody else would draw.

- **Direction:** what the project is for and where it is headed: its purpose, goals, and what
  a stable stopping point looks like. Draw it. A journey toward a destination works, or a picture that suits
  the project better.
- **Where it runs:** links to dashboards, traces, or deployments, when the project has them.
- **Context map:** the parts of the domain and the language boundaries between them, when the
  project has more than one.
- **Architecture:** the major pieces and how they depend on each other.
- **Invariants:** properties that must stay true. Give them a section, or show them inside the
  task list. Tag them as domain/architecture/design/code style.
- **Domain terms:** The top few terms that are central to understanding the project. Include technical terms that people might not intuitively guess. Like 2-6 key terms that clarify things. List term, bounded context, description, synonyms to avoid.
- **Current work:** what is underway and the high-level plan for it. A sketch of the plan, not a
  other views, whichever reads faster.

Context map and architecture show **reality** first and **direction** second. Anything not yet true
carries a visible **directional** label.

**Sources.** Draw from the README, any document that states the project's goals or plans, agent
instruction files such as `CLAUDE.md` or `AGENTS.md`, and the code and its comments. When a
document states the goals, it is the authority for the direction view. Keep the overview in sync
with those few sources and no others.

**Not complete, and does not try to be.** Most architecture and domain definitions live in the
code. The overview summarizes what a human needs to see at a glance.

**What it leaves out:**

- Task lists and ticket status. Link to the tracker instead.
- Complete API or domain definitions. The code holds those.
- Decision history. That belongs in git.
- Anything that repeats a markdown file without adding a picture.

## Form

- One self-contained file: inline CSS and inline SVG, no build step, no external requests, no
  scripts. Static HTML, so the user can leave directives on it in the browser.
- Diffable. Keep structure and ordering steady across versions, so a git diff between two versions
  shows what changed in the project, not churn in the markup.
- Each view is a `<section>` with a heading, so directives attach to a clear place.
- Make the pictures worth looking at. SVG lets you draw what the project is like, not only boxes
  and arrows.

## Procedure

1. Check for an existing `OVERVIEW.html`. If there is one, read it and update it in place: keep its
   structure, so the diff shows what changed in the project. Leave its `data-hrv` and
   `data-hrv-next` attributes as they are: they are the element IDs html-revisor saves by.
2. Ask the user for commentary on what they want in the overview. Give them an opportunity
   to word vomit about their vision for the project.
3. Read the sources. Find the direction, the major pieces, and what is underway. See how much lines up with the user's expressed vision. When the purpose or the goals are not clear, ask the user one question at a time until you can draw them.
4. Write or update `OVERVIEW.html`.
5. Refine it with the user using the `iterate-on-a-document` skill from this plugin, on
   `OVERVIEW.html`. Its HTML steps let the user leave directives on the page in the browser.

## Keeping it current

- **Before the work, as part of planning.** Update the overview first, so the user can look at it
  and see the plan. Label things not yet true **directional**.
- **When directional things land.** The change that makes a directional item real updates the
  overview in the same commit: drop the "planned" label, and remove anything no longer true.
- **When a change alters the picture.** If the architecture, the context map, or an invariant
  changes, update the overview and **tell the user** so they go look at it.
