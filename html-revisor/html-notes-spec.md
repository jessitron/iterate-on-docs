# html-notes — implementation spec

## Purpose

I review HTML files that an agent generates for me (project overviews, plans, reports). I want to read them in a browser and leave comments on specific elements, the way I'd leave `<!-- comments -->` in a Markdown file. Then I tell the agent "address the comments," it does, and it deletes them.

The comments must live **in the HTML file itself**. The file on disk is the single source of truth. Nothing is stored in the browser, in a database, or in a sidecar file.

## Deliverable

A small local HTTP server, one command to run, that:

1. serves HTML files from a directory,
2. normalizes each HTML file's formatting on first load (rewriting it on disk),
3. injects a click-to-comment UI into the served page,
4. writes comments back into the file on disk as HTML comments.

Suggested stack: Node ≥ 20, ES modules, `linkedom` for server-side DOM parsing (fast, no browser emulation). Python + BeautifulSoup is acceptable if preferred. No framework; no build step; no client-side dependencies. One source file plus `package.json` and a README is the expected size.

```
node server.mjs [rootDir] [--port 7777] [--author @AI]
```

Default root is the current directory. Print the URL on startup.

## Comment format

A comment is an HTML comment node whose text, after trimming leading whitespace, starts with `<author>:`:

```html
<!-- @AI: this section is out of date -->
```

- `--author` sets the prefix (default `@AI`). Comments without the prefix are not notes; leave them alone.
- The note text is everything after the prefix, trimmed.
- When writing, escape `--` inside the text as `- -` and `>` as `&gt;` so the comment can't terminate early. (Do not unescape on read; it's fine for the agent to see `- -`.)
- Multi-line text is allowed.

### Placement

A note attaches to exactly one element.

- **Normal elements**: the comment is the **first child** of the element.
- **Void elements** (`img`, `hr`, `br`, `input`, `meta`, `link`, etc.) and **raw-text/preformatted elements** (`pre`, `textarea`, `script`, `style`): the comment is inserted **immediately before** the element, as a sibling.

Reading rule (inverse): a note comment belongs to its parent element, **unless** its next sibling (skipping whitespace-only text) is a void or preformatted element, in which case it belongs to that sibling.

Pre-existing hand-written notes sitting directly in `<body>` between blocks therefore attach to `<body>` and will move to the top of `<body>` on next save. Accept this.

If multiple note comments attach to the same element, join their texts with newlines when reading; write back as a single comment.

## Element identity

The client needs to tell the server "the note on *this* element." Use the element's **index in document order** over all elements (`querySelectorAll('*')`, 0-based). The server stamps `data-n="<index>"` on every element in the served copy.

Why this works: comments are not elements, so adding and removing them never shifts indices. GET and PUT both stamp the same way from the file on disk, so ids are stable across saves without reloading the page. The injected `<style>`/`<script>` are appended *after* stamping and are not stamped.

Never write `data-n` to disk. Strip it before serializing.

## Normalization (the formatter)

**Do this first, on every GET of an HTML file**, before anything else: parse the file, serialize it canonically, and if the result differs from the file, overwrite the file. Log `(normalized)` when that happens. Idempotence is required: normalize(normalize(x)) == normalize(x) byte-for-byte.

Canonical serialization rules:

- Start with `<!DOCTYPE html>` (preserve the doctype name if present; emit `html` if absent).
- Two-space indentation, one block element per line.
- Block elements: `html head body main header footer nav section article aside div p h1-h6 ul ol li dl dt dd table thead tbody tfoot tr th td blockquote pre figure figcaption hr form fieldset details summary meta link script style noscript template iframe video audio canvas svg`. An element is also treated as a block container if any of its children are block elements.
- An element with only inline content is kept on **one line** (`<h1>Project <em>Overview</em></h1>`, `<li>Ship it</li>`) when its serialized length is under ~90 characters. Longer inline-only blocks get open tag / indented content line / close tag on three lines.
- Inside a block container, runs of consecutive inline nodes (text + inline elements) are joined onto one indented line with whitespace collapsed to single spaces and trimmed at both ends. **Do not drop whitespace between inline siblings** — `<b>x</b> &amp; y` must keep its space. (Entities may split text nodes in some parsers; a whitespace-only text node between two inline nodes is significant.)
- Comment nodes are block-level: each on its own line, `<!--` + original data + `-->`.
- `pre`, `textarea`, `script`, `style`: emit the open tag, the **raw inner content unchanged**, the close tag. No indentation or whitespace changes inside.
- Void elements: open tag only, no closing slash.
- Attributes: in source order; `name="value"` with `&` and `"` escaped; boolean attributes (empty value) as bare `name`.
- Text: escape `<`, `>`, and `&` (but don't double-escape existing entities).
- File ends with a single trailing newline.

Formatting the agent's output is fine. Changing what it renders as is not: whitespace must only be altered where HTML collapses it anyway (between blocks, within inline runs).

## Server endpoints

### `GET /<path>.html`

1. Normalize the file (above).
2. Re-read, parse, stamp `data-n` on every element.
3. Collect existing notes into `{ [id]: text }` and **remove the comment nodes** from the served DOM (they're delivered as data instead; the file on disk still has them).
4. Append the client CSS in a `<style>` in `<head>`, the notes JSON in `<script type="application/json" id="hn-notes">` (escape `<` as `\u003c`), and the client JS in a `<script>` at the end of `<body>`.
5. Serve. Log `path — N pending notes`.

### `PUT /<path>.html` with body `{ "notes": { "<id>": "text", ... } }`

The body is the **complete current set** of notes for the document, not a delta.

1. Read the file from disk, parse, stamp.
2. Remove every existing note comment.
3. For each `{id, text}` with non-empty trimmed text, insert a note comment per the placement rules. Ignore ids that don't resolve.
4. Strip `data-n`, serialize canonically, write.
5. Respond `{ "ok": true, "count": N }`. Log it.

### Everything else

- `GET` on a directory: minimal HTML listing with links.
- `GET` on any other file: serve it with a sensible content-type (so the page's own CSS/images work).
- Resolve paths under the root only; reject `..` escapes with 403.
- Errors → plain-text 500 with the message; log the stack.

## Client UI

Injected into the page. No external resources. Must not break the page's own layout or styles: all UI lives in an absolutely positioned overlay `div#hn-layer` at document origin with very high `z-index`, except for two classes applied to page elements.

**Hover**: the element under the cursor (nearest ancestor with `data-n`, excluding `html` and `body`) gets a dashed outline (`outline`, not `border`, so layout doesn't shift) and a `copy` cursor.

**Click** (plain, no modifier): prevent default, open the comment box for that element. This means plain clicks on links comment rather than navigate; modifier-clicks (⌘/Ctrl/Shift) are left alone so links still work. Clicking `body`/`html` or empty space closes any open box.

**Marker**: every element with a note gets a small round marker (a pencil or speech-bubble glyph) positioned at the element's top-left corner in document coordinates, and the element gets an `hn-noted` class (thin left accent via `box-shadow: inset`, again no layout shift). Marker `title` = note text. Clicking a marker opens its box. Reposition all markers on scroll, resize, and body `ResizeObserver`.

**Comment box**: positioned just below the element's top edge, clamped to the viewport width. Contains a textarea (prefilled with the current note), a hint line (`⌘↵ to save · esc to close`), **Delete** and **Save** buttons.

- Any input updates the in-memory notes and schedules a save (debounce ~400 ms). The marker appears as soon as there's text.
- `⌘↵`/`Ctrl↵`, `Esc`, **Save**, or clicking outside: commit and close.
- **Delete** or closing with empty text: remove the note and its marker.
- Only one box open at a time; opening another closes the first (committing it).

**Save**: `PUT` the full notes map to `location.pathname`. Show a small fixed toast bottom-right — `saved · 3 comments` — that fades after ~1.5 s. On failure, show `save failed: <reason>` and keep the in-memory state so a later edit retries.

**On load**: build markers for every note in `#hn-notes`. All of them are editable; there's no distinction between notes from this session and earlier ones.

Respect `prefers-color-scheme: dark` for the box. Keyboard: textarea gets focus on open with the caret at the end.

## Lifecycle (what this enables)

1. Agent writes `overview.html`.
2. I open it in the browser. First load normalizes the file.
3. I click around and leave comments. Each one is on disk within half a second.
4. I close the tab, come back later, keep going — comments are still there.
5. I tell the agent: *address the comments in overview.html*. It finds `<!-- @AI:` comments, acts on each, deletes it. I reload: clean page.

The viewer never deletes a note on its own. Only I (emptying the box) or the agent (addressing it) remove notes.

## Acceptance tests

Automate these with a fixture file and `curl`/`fetch`; no browser required for the server side.

1. **Normalize is idempotent.** Load a messy single-line file; file is rewritten. Load again; file is byte-identical and the log does not say `(normalized)`.
2. **Inline spacing survives.** `<p>a <b>b</b> &amp; c</p>` → the space before `&amp;` is still there after normalization.
3. **Preformatted content is untouched.** A `<pre>` with internal indentation and a `<script>` with a string literal are byte-identical after normalization.
4. **Round-trip.** PUT notes on a `<p>`, an `<img>`, a `<pre>`, and `<body>`. File contains the comment as first child of `<p>` and `<body>`, and as the sibling immediately before `<img>` and `<pre>`. GET returns the same `{id: text}` map in `#hn-notes`.
5. **Ids are stable.** After the PUT above, a second GET assigns the same `data-n` to the same elements.
6. **Full-set semantics.** PUT `{}` removes all notes. PUT with one id removed removes only that comment.
7. **Escaping.** A note containing `-- really -->` is written as `- - really - -&gt;` and the document still parses with the correct number of elements.
8. **Non-note comments are preserved.** A `<!-- TODO -->` without the prefix survives normalize and PUT untouched.
9. **Served page has no note comments** in its HTML (they're in the JSON) and has `data-n` on every element; the file on disk has no `data-n`.
10. **Path safety.** `GET /../etc/passwd` → 403.

For the client, a short manual checklist in the README is sufficient: hover outline, click opens box, marker appears while typing, reload shows marker, click marker edits, Delete removes, ⌘-click on a link navigates.

## README must include

- Run instructions.
- The comment format and placement rule, stated for a human.
- A paste-able paragraph of **agent instructions**: how to find notes, that each must be addressed then deleted, and that before regenerating an HTML file from scratch the agent must check `grep -c '@AI:' file.html` is 0 so unresolved comments aren't thrown away.

## Non-goals

- No multi-user, auth, or remote access. Localhost only.
- No sidecar storage, no history, no undo beyond editing the comment again.
- No source-position-preserving edits; the formatter owns the file's layout.
- No React/bundler/CSS framework. Keep it to one file I can read in ten minutes.
