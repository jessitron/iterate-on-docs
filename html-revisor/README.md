# html-revisor

Review agent-generated HTML in a browser and leave directives on specific elements. Directives are saved in the HTML file itself as `<!-- @AI: ... -->` HTML comments. Nothing lives in the browser or a sidecar file.

You can also edit the page directly. Click any block (a paragraph, a list, one item, a section, a table cell), a link, an image, or a span: the box shows its content as markdown in a Content field above the directive. An element of 4 KB of HTML or more, such as the page's body or a wrapper around most of it, takes only a directive. Typing saves into the file, and the page shows the result when the save answers. Elements you left or changed keep their IDs and directives.

This repo is where html-revisor is developed. Its built output ships inside the [iterate-on-docs](https://github.com/jessitron/iterate-on-docs) plugin, vendored at `iterate-on-docs/html-revisor/`. Make changes here, not in that copy.

The [overview](https://jessitron.github.io/html-revisor/) and the pages it links are on GitHub Pages, published from `main` on GitHub. They show what's pushed, as plain pages: no box, no saving. `index.html` redirects to `OVERVIEW.html`, and `.nojekyll` tells Pages to serve the files as they are.

## Run

```
./run [file or dir] [--port 7777] [--author @AI]
```

- Given a file, the server formats it, serves its directory, and prints the page's URL on startup. If the file breaks a rule the formatter can't fix, it exits 1 with the formatter's message.
- Given a directory, or nothing (the directory you run it from), the server prints the directory's URL. Open an `.html` file under it.
- `--author` sets the directive prefix (default `@AI`).
- First load normalizes the file's formatting and rewrites it on disk. It also adds `<html>`, `<head>` and `<body>` if the file lacks them, the way a browser would. These files are agent-generated documents we control, so the tool rewrites them into the shape it needs.
- Loading also writes an element ID, `data-hrv="<n>"`, on each element you can pick, and the next unused number on `<html data-hrv-next="<n>">`. The first load of a page makes one noisy diff; after that a diff shows only new IDs.
- Typing in the box saves to the file, and prints nothing. Done, closing the box any way, prints an Announcement on stdout when the box changed something: one line of JSON, so an agent watching the output can start work while you work.

```
{"page":"/OVERVIEW.html","id":"12","element":"p","heading":"Architecture","directive":{"before":"","after":"say what the tiers are"},"revision":{"before":"Three tiers.","after":"Three **tiers**."},"thread":"3f9a0c1e7b2d"}
```

  `id` is the element's `data-hrv`. `heading` is the text of the heading it sits under, or null. `directive` is there when the directive changed, and `revision` when a scope's content did, each from what the box opened with to what the file holds now. Directive text is as the file holds it: trimmed, `--` as `- -`. `thread` is there when the element has a thread: its base, which a reply sends back (see [Reply](#reply)). The box opened and closed with nothing changed, or a reload with the box open, prints nothing.

  Resolve closes the box, so its Done announces it: `resolved` holds the turns of the thread that ended, in order, each `{"prefix", "text"}` (`@AI` for yours, `@Human` for the agent's), and the Announcement has no `thread`. A Resolve announces with nothing else changed. A turn you hadn't sent goes with the thread: it is the last turn in `resolved`, and if the box opened with it, `directive` shows it gone, as a Clear does. `resolved` is what tells a Resolve from a Clear.

```
{"page":"/OVERVIEW.html","id":"12","element":"p","heading":"Architecture","resolved":[{"prefix":"@AI","text":"say what the tiers are"},{"prefix":"@Human","text":"Named them. 👍"}]}
```

## Reply

```
node reply.mjs <page URL> <id> <thread> <text>
```

The agent answers a directive through the running server, which writes `<!-- @Human: text -->` after the thread's last turn. `<page URL>` is the page as the startup line names it; `<id>` and `<thread>` come from the Announcement. The server is the only writer of the live file: it takes each change to a file in turn, the browser's saves and the agent's replies alike, so neither overwrites the other. The open tab hears of the reply at once (see Live notice under [Design](#design)): the element's marker turns to the green bubble.

It prints the server's answer on stdout, one line of JSON. Exit 0 when the reply landed: `{"ok": true, "count", "thread", "before", "after"}`, where `thread` is the new base, for a reply after this one. Exit 1 when it's stale, because a turn was added or the thread resolved since: `{"ok": false, "error", "directive"?, "thread"?}`, with the open directive and thread base now when there is a thread, so the agent reads the new turn and replies again. Exit 1 with a message on stderr when no server answers, and 2 with usage for bad arguments.

Needs Node 20 or later. No `npm install`: the dependencies, linkedom, markdown-it, and OpenTelemetry, are bundled into `vendor/`.

## Telemetry

```
HRV_TELEMETRY=1 OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<ingest key> ./run
```

`HRV_TELEMETRY` turns on OpenTelemetry traces; without it the server sends nothing, even with `OTEL_*` variables set (Claude Code reads those for its own telemetry, so they can leak into a server an agent starts). Once it's on, the standard variables say where spans go: `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`), `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` (default `html-revisor`, which is the Honeycomb dataset), `OTEL_RESOURCE_ATTRIBUTES`. A failed export prints `telemetry export failed` on stderr.

To take these from `.be`, `with-be ./run`. `with-be` is in Jess's dotfiles, `bin/`: it runs a command with the variables from `.be` at the repo root (in a worktree, the main checkout's).

What it traces:

- **GET, PUT, and Done**: a span per request (`POST done` for Done, with `hrv.announced`; `PUT reply` for the agent's reply, `hrv.change.kind` `reply`), continuing any `traceparent`, with a child span per step (read file, normalize, parse, check base, set markdown, serialize, write file, …) and attributes `hrv.page`, `hrv.page.bytes`, `hrv.change.kind`, `hrv.scope.id`, `hrv.answer.bytes`, and counts. `PUT change` carries `hrv.wrote`: false when the save left the file as it was (a trailing space, trimmed), so it has no write file step. A markdown save that splits its scope, as a typed `<p>` splits a paragraph, carries `hrv.spill.made` (the other elements it made) and the next save `hrv.spill.count` (the ones it replaces).
- **The box's saves**, recorded in the browser. Each change is a trace: `save directive` or `save markdown` runs from when the change goes out to the answer applied, with children `PUT` (until it's answered; the server's `PUT change` nests under it) and `apply`. The typing before it is in attributes: `hrv.wait.ms` since the first keystroke, `hrv.quiet.ms` since the last, `hrv.edits` keystrokes. It also carries the element (`hrv.element`, `hrv.scope.id`) and its content before and after: `hrv.html.*`, `hrv.markdown.*` or `hrv.directive.*`, each with a `.length`. Both kinds carry `hrv.directive`, the scope's directive once the save lands. A box closed while a save is going adds a `close box` event to that save (`hrv.close.by`: done, key, click away…; `hrv.pending`).
- **Catching up**, recorded in the browser: a `refresh` trace when a live notice sends the tab for the page's state, with the server's `GET state` under it, `hrv.changed` (content the tab can't show changed) and `hrv.updated` (elements whose thread it took). An event stream gets no span: it lasts as long as the tab.
- **Done**, recorded in the browser: a `done` trace from the box closing to the server's answer, which the server's `POST done` nests under. It carries `hrv.close.by`, `hrv.queued` (saves ahead of it), and `hrv.announced`. Every save and the `done` from one box share `hrv.box.session`, a random ID per box opened, so a query can group a box's saves with whether it announced.

The client posts its spans to `/.hrv/spans`; the server sends them on with the same IDs, tagged `hrv.side=browser`.

[OBSERVABILITY.html](OBSERVABILITY.html) draws a save as a trace and links Honeycomb queries for it. `test/telemetry.test.mjs` checks it against a stand-in collector, and against Honeycomb when the shell's `OTEL_EXPORTER_OTLP_HEADERS` carries a key: that test prints the run's `hrv.test.run` and trace ID, for finding the spans in dataset `html-revisor-test`.

## Clean up

```
node cleanup.mjs [--author @AI] <file>...
```

When you're done iterating on a page, this takes out what the tool left in it: directives and element IDs (`data-hrv`, `data-hrv-next`). It leaves the formatting as the formatter wrote it. It rewrites each file in place, prints each directive it took out as `<file>: <text>`, and exits 0, or 1 when a file can't be read or written. A page left with no IDs is how parallel iterations on one page avoid colliding: the next load hands out IDs from 1 again.

Tests: `npm test`. The property tests run 150 seeds; `ROUND_TRIP_SEEDS=3000 npm test` shakes harder (about 5 minutes). A bug found past seed 150 gets an example test in `test/scopes.test.mjs`, so `npm test` guards it.

## Try it

`SCOPES-DESIGN.html` holds the design decisions for scopes and editing as markdown, each beside the examples that show it, and it is the page for testing by hand. Run `./run` in this directory and open `http://localhost:7777/SCOPES-DESIGN.html`. It holds one of each case the client handles: text-only elements, a paragraph with inline markup, entities, a link, a list, a table, `hr` and `pre` (directives sit beside them), and a wrapper card.

Your directives and markdown edits write into the file, so it shows as changed in git. `git checkout SCOPES-DESIGN.html` resets it. It is committed in normalized form, so loading it does not change it.

## Deploy

```
./deploy [iterate-on-docs dir]
```

Copies the committed files at HEAD into `<dir>/html-revisor/` (default `~/code/jessitron/iterate-on-docs`), runs the tests there, and commits there. It writes nothing else in iterate-on-docs, and it doesn't push. Users get the change when iterate-on-docs runs `./release`.

- It refuses when this repo has uncommitted changes (except `SCOPES-DESIGN.html`), when HEAD is not on main, or when the copy has uncommitted changes.
- It replaces the whole directory, leaving out dev-only files: `CLAUDE.md`, `OVERVIEW.html`, `DESIGN.html`, `design/`, `index.html`, `.nojekyll`, `.gitignore`, `.claude/`, `deploy`. It writes `VENDORED.md` with the commit hash.
- If the tests fail in the copy, it restores the directory and commits nothing.

## Contract with iterate-on-docs

The skills and the README in iterate-on-docs run and describe this tool. They rely on:

| What | Value |
| --- | --- |
| Server path | `../../html-revisor/server.mjs`, from the skill's base directory |
| Runtime | Node 20 or later. No `npm install`: the output runs as copied, its dependencies are in `vendor/` |
| CLI | `node <server> <file> --port 0`. On startup it formats `<file>` the way the formatter CLI does, then serves the file's directory. If the formatter fails, the server exits 1 with the formatter's stderr and serves nothing |
| Default author | `@AI` (the skill passes no `--author`) |
| Startup line | `html-revisor: <page URL> serving <dir>`, as in `html-revisor: http://localhost:4123/OVERVIEW.html serving /path/to/repo` |
| Page URL | the second word of the startup line: `http://localhost:<port>/<file name, URL-encoded>` |
| Announcements | when the user closes the box (Done) after changing something, the server prints one line of JSON on stdout: `{"page", "id", "element", "heading", "directive"?: {"before", "after"}, "revision"?: {"before", "after"}, "resolved"?: [{"prefix", "text"}], "thread"?}`, as under [Run](#run); `thread`, the thread's base, when the element has one; `resolved`, the turns of a thread the user resolved: the conversation ended, and there is nothing to reply to. A Resolve announces even with nothing else changed. Every JSON line on stdout starts with `{`, and no other line does. Saves print nothing |
| Reply CLI | `node ../../html-revisor/reply.mjs <page URL> <id> <thread> <text>`, from the skill's base directory, with the server running. `<id>` and `<thread>` from the Announcement. Writes `<!-- @Human: text -->` after the thread's last turn. Prints one line of JSON on stdout; exit 0 when it landed (`thread`: the base for a next reply), 1 when stale (the answer carries the `directive` and `thread` now: read the new turn, reply again) or no server answers, 2 with usage. As under [Reply](#reply) |
| Directive syntax | `<!-- @AI: … -->`, first child of its element, or just before a void or raw-text element (full list under [Directive format](#directive-format)). On an element whose first child is one of those, it's the last child. A reply is `<!-- @Human: … -->`, after the last turn of the element's thread |
| Finding directives | `grep '<!-- *@AI:'` |
| Formatter CLI | `node ../../html-revisor/formatter.mjs <file>...`, from the skill's base directory. Rewrites each file in place into the same canonical form a page load gives. Silent and exit 0 on success; exit 1 with `<file>: <problem>` on stderr when a file can't be read or written or breaks a rule the formatter can't fix (it still writes the fixable part); exit 2 with usage when given no files |
| Cleanup CLI | `node ../../html-revisor/cleanup.mjs <file>...`, from the skill's base directory, when the user says "good enough". Rewrites each file in place without directives (`<!-- @AI: … -->`), replies (`<!-- @Human: … -->`), or element IDs, formatting kept. Prints each directive it removed on stdout as `<file>: <text>`, newlines as spaces. Exit 0 on success; exit 1 with `<file>: <problem>` on stderr when a file can't be read or written; exit 2 with usage when given no files |
| Loading a page reformats its file | each GET rewrites the file on disk into canonical formatting, with element IDs. The skill runs the formatter CLI before each commit, so the reformat lands in the agent's commit and doesn't show up as the user's next edit |
| Element IDs | the formatter (GET, PUT, and the formatter CLI) writes `data-hrv="<n>"` on each element you can pick and `data-hrv-next="<n>"` on `<html>`. Agents leave both alone: don't change, copy, or remove them. A new element needs none; the next format gives it one |
| Browser behavior | click a block, link, image, or part of an SVG to leave a directive on it or change its wording; both save into the file as you type. If the element changed on disk since the page loaded, the save is refused with an error that suggests a reload; a change elsewhere in the file only brings a notice. Revert puts a scope's content back to the file's last commit, so in an iterate loop it goes back to the start of the turn. After a reply, the box shows the thread; what the user types there is a new `@AI` turn after the last reply, and Resolve removes the whole thread. A directive sent (its box closed) stays as written: the box reopened on it shows it in the thread, and what the user types joins it in the file, after a newline, as one open turn. The open tab hears of each change to the file without a reload: a reply turns its marker to the bubble, and a directive added or removed on disk shows or takes away its marker. A reply to the element whose box is open joins the thread in the box: the turn it answers goes up into the thread, and the field keeps only what the user typed past it, which goes to the agent as the next turn. A change to an element's content on disk brings the notice to reload |
| Bug reports | issues go to `https://github.com/jessitron/html-revisor/issues`. `VENDORED.md` in the copy names the deployed commit, for the report |
| README | this README ships in the output and keeps its "Directive format" section; iterate-on-docs links to it |
| Vocabulary | the words the user sees: **directive** (the directive box says "Directive", "Directive for this element", "Clear the directive (⌥⌘⌫)"; the docket says "N directives" (or "1 directive"), "Previous directive", "Next directive", and "N directives · review off"). The box's fields are labeled "Content" and "Directive"; its buttons are **Done**, **Clear** on the Directive label's line, and **Revert** on the Content label's line ("Put back the content this had at the last commit"); its footer says "⌘↵ or esc to close", or the save status "saving…", "saved", "not saved". Typing saves; Done closes the box. Once the agent replies, the box shows the thread, each turn headed "you" or "agent"; the field below is labeled "You", placeholder "Add to the thread", and its Clear says "Empty the turn you haven't sent"; **Resolve** sits beside Done ("End the thread: remove the directive and its replies"). A new **reply**, where the agent spoke last, gives the marker a green bubble ("New reply: …") until the user adds a turn or resolves; opening the box leaves it. A turn of the user's that is last in its thread, its box closed, is the agent's to work on: the marker shows three green squares ("Agent working on: …"); reopened, the box shows that turn in the thread with the agent's turn as "working", and its field is "You". The docket's second row, shown only when there are some, counts new replies: "N new replies" (or "1 new reply"), with "Previous new reply" and "Next new reply". Not note, comment or annotation |

If you find a mismatch, the Contract wins.

A change to anything in this table is a contract change. It travels out of band, not through deploy: the agent changing it here searches iterate-on-docs' `skills/` directory and `README.md` for the old value and updates every match, in their own commit there, along with the deploy. deploy stays a plain copy. This list stands in for a changelog: these are the only changes iterate-on-docs has to hear about.

## Directive format

A directive is an HTML comment whose text starts with `<author>:`.

```html
<!-- @AI: this section is out of date -->
```

- HTML comments without the prefix are not directives. The server leaves them alone.
- The directive text is everything after the prefix. Multi-line text is fine.
- On write, `--` becomes `- -` and `>` becomes `&gt;` so the text cannot end the HTML comment early. Reading doesn't undo it: the agent sees `- -`.
- Several directives in a row on one element read as one, joined with newlines, and the next save writes them back as one.

Placement: a directive attaches to exactly one element.

- On a normal element, the directive is its **first child**.
- On an element that can't hold an HTML comment inside, the directive sits **immediately before** the element as a sibling. Those are the void elements (`area`, `base`, `br`, `col`, `embed`, `hr`, `img`, `input`, `link`, `meta`, `param`, `source`, `track`, `wbr`), the raw-text elements (`pre`, `textarea`, `script`, `style`, `template`), and `title`, `iframe`, `xmp`, `noembed`, `noframes`. Every comment in the run before it, with nothing but whitespace between, is about it.
- On an element whose first child is one of those, the directive is its **last child**, so it doesn't read as the child's.
- A hand-written directive placed in `<body>` between blocks attaches to `<body>` and moves to the top of `<body>` on the next save.

Replies: the agent answers a directive with `<!-- @Human: … -->`, escaped the same way, through `reply.mjs` (see [Reply](#reply)). The prefix names who the words are for. An element's directives and replies, in file order, are its thread; a reply goes after the thread's last turn. Threads change no element's base, and cleanup removes them.

The tool never drops a directive on its own. The human removes one by clearing it, resolving its thread, or deleting its element in a markdown edit; the agent, by addressing it or running cleanup.

## Canonical form

The formatter owns the file's layout. It changes how the file reads, never what it renders as: whitespace changes only where HTML collapses it, between blocks and inside a run of inline content. Formatting a formatted file changes nothing. `domain/canonical.mjs` holds the rules:

- `<!DOCTYPE html>` first, keeping the doctype's name when the file has one, and one newline at the end. A missing `<html>`, `<head>` or `<body>` is added.
- Two-space indentation, one block element per line. A block element is one named in `BLOCK` (`html`, `body`, `section`, `div`, `p`, `h1`–`h6`, lists, table parts, `pre`, `figure`, `svg`, …), any element holding one, or an element inside an `<svg>`. A `<text>` in an svg stays whole on one line, since its whitespace renders.
- An element holding only inline content stays on one line under 90 characters. A longer one takes three: open tag, content indented, close tag.
- A run of inline nodes is one line, whitespace collapsed to single spaces and trimmed at both ends. Whitespace between two inline siblings stays as a space: `<strong>x</strong> &amp; y` keeps it. Whitespace beside a `<br>` goes. U+00A0 is not whitespace here; it's written `&nbsp;`.
- An HTML comment in a block container sits on its own line, its text as it was.
- `pre`, `textarea`, `script`, `style`, `template`: the open tag, the inner content unchanged, the close tag.
- A void element is its open tag, with no closing slash.
- Attributes in source order, as `name="value"` with `&` and `"` escaped; an empty value as the bare name.
- Text escapes `&`, `<` and `>`.
- `b` becomes `strong`, `i` becomes `em`, and table rows go into `thead` and `tbody`: the forms markdown writes back.

## Agent instructions

Paste this into the agent's instructions:

```
HTML files in this project may hold directives written as HTML comments that
start with "@AI:", for example <!-- @AI: this section is out of date -->.
To find them, run: grep -n '<!-- *@AI:' file.html
Each directive is a request about the element that contains it (it is the element's
first child), or about the element right after it when that element can't hold a
comment inside: a void element (img, hr, br, input, meta, ...), a raw-text element
(pre, textarea, script, style, template), or title, iframe, xmp, noembed, noframes.
Address every directive, then delete the
directive from the file. Leave HTML comments that do not start with "@AI:" alone.
Before you regenerate an HTML file from scratch, run grep -c '<!-- *@AI:' file.html.
The count must be 0. If it is not, address those directives first so no unresolved
directive is thrown away.
Leave data-hrv and data-hrv-next attributes alone: don't change, copy, or remove
them. New elements need none; the formatter adds them.
```

## Manual client checklist

Each save carries one change, to one element, with that element's base: a hash of its content as the tab last saw it. If the element changed on disk since, the server refuses the save (412) and the tab shows an error that suggests a reload. A change elsewhere in the file doesn't block the save; the tab notices it from the file's hash and says the page changed. A save touches only its own directive, so a tab can't resurrect a directive the agent finished and removed.

Open `SCOPES-DESIGN.html` in a browser (see [Try it](#try-it)).

- [ ] Hovering an element shows crop marks just outside its corners and a copy cursor; `html` and `body` show none. Try an SVG label and an SVG shape too.
- [ ] Clicking an element opens a directive box below its top edge, with focus in the textarea. While the box is open, the element has heavier crop marks and a hairline outline.
- [ ] The box's header shows the pencil icon, the tag, and the start of the element's text (`h2 · Text you can edit`); an image shows its alt (`img · orange cat lying`), an `hr` only its tag.
- [ ] A marker appears as soon as you type.
- [ ] Every block, link, image, and span shows a Content field above the directive, holding its markdown in monospace: a paragraph with bold shows `**bold**`, a list its `-` lines. Clicking `<b>bold</b>` picks its paragraph: `strong`, `b` and the like are not scopes. An `hr`, an SVG shape, or a scope of 4 KB of HTML or more shows only the directive.
- [ ] Typing in the Content field changes the file within about half a second, and the page when the save answers. Blanking it changes nothing.
- [ ] Put a directive on one list item, then edit the list's markdown: add a word to that item and a new item beside it. The item keeps its marker; the new one has none.
- [ ] Type a list's markdown into one sentence: the list becomes a paragraph, the box stays open on it, and the list's own directive moves to it.
- [ ] Both fields grow as you type more lines, up to about 240px, then scroll.
- [ ] The file on disk updates within about half a second. The box's footer says `saving…`, then `saved`, then the hint returns.
- [ ] The docket at the bottom right counts the directives (`N directives`) and changes as you add or delete one.
- [ ] The docket's ↑ and ↓, and ⌥↑ and ⌥↓ outside a text field, scroll each directive's element to the middle of the window in document order, wrapping at the ends, show its crop marks for a moment, and show its marker's tip until the next click.
- [ ] A reply adds the docket's second row, `N new replies`, and rings the docket green for 2 s. Its ↑ and ↓ step through the new replies only. Typing a turn on one takes it off the row; with none left the row goes.
- [ ] Clicking the docket's icon or count turns review mode off (`· review off`): markers hide, the docket's arrows hide and ⌥↑/⌥↓ don't step, hovering shows no marks and no copy cursor, and clicks go to the page. Clicking again turns it back on.
- [ ] Reloading the page shows the marker. The element itself is not restyled.
- [ ] Closing a box with a directive turns its marker to three green squares (working), and hovering it shows the directive. Clicking the marker opens the box with the directive in the thread, the agent's turn "working", the box's icon the squares, and an empty You field; the marker is the pencil while the box is open. Typing there adds to the directive in the file after a newline. Resolve removes it.
- [ ] While writing a new directive, Clear (or emptying the text, or `⌥⌘⌫` in the box) removes the directive and the marker. Clear shows only when there is a directive, in both boxes, and its tooltip names the hotkey. Clear leaves the box open with the Content field as you left it, and `⌘Z` brings the directive back.
- [ ] In a committed page, Revert shows on the Content line only after you change a scope. Clicking it puts the committed markdown back and saves; `⌘Z` takes the revert back. Delete a list item, then Revert the list: the item returns.
- [ ] `⌘↵`, `Esc`, Done, and clicking outside each commit and close the box. (On a page with a full-width wrapper element, clicking the margin opens a box on the wrapper instead; use Esc.)
- [ ] After `⌘↵`, `Esc`, or Done, focus is on the element: Tab goes to the next link after it, not the top of the page. Once focus leaves, the element holds no `tabindex`.
- [ ] In a scope's box with a changed scope and a directive, Tab goes Revert, Content, Clear, Directive, Done, and wraps back to Revert; Shift-Tab goes the other way. A hidden action takes no stop. A button you Tab to wears the accent ring, and nothing moves; a click shows no ring. Enter or Space presses it.
- [ ] Opening a second box commits and closes the first.
- [ ] Plain click on a link opens a directive box; ⌘-, Ctrl-, Shift- or ⌥-click on a link goes to the page, so the link navigates.
- [ ] The page's own layout and styles look the same with the UI loaded, including while hovering: a card keeps its own box-shadow.
- [ ] Stopping the server and typing shows `save failed: ...` on the docket; restarting and typing again saves and clears it.
- [ ] Edit one element in the file on disk while the tab is open, then type a directive on that element: the docket says it wasn't saved and suggests a reload, the box's footer says `not saved`, the file stays untouched, and the box keeps your text.
- [ ] Edit a different element on disk: without typing, the docket says the page changed on disk. Type a directive: it saves.
- [ ] Add `<!-- @AI: … -->` to an element on disk: its marker shows without a reload. Delete it: the marker goes.
- [ ] Reply with `reply.mjs`: the marker turns to the green bubble without a reload. With that element's box open, the reply joins the thread in the box and your turn goes up above it; the field keeps only what you typed past what was saved, and saves it as a new turn after the reply, once.
- [ ] With two tabs on one page, a directive typed in one shows its marker in the other.
- [ ] In dark mode the box, markers and docket look the same as in light mode: one material.

## Design

The code is in three tiers, and a file's tier is where it lives: the top-level `*.mjs` files are Tier I, `domain/` is Tier II, `interface/` and `vendor/` are Tier III. Dependencies point down, and no module imports itself through others; `test/architecture.test.mjs` checks both, along with the rest of the rules below. `client.css` and `client.js` run in the browser: the server inlines them into each page. The client is a plain script, with no build step, no framework, and no external resources. How the UI looks, and the design decisions so far, are in [DESIGN.html](DESIGN.html); it links `client.css`, so it shows the real styles. How editing as markdown behaves, and its design decisions, are in [SCOPES-DESIGN.html](SCOPES-DESIGN.html#decided); how elements keep their IDs across a save is in [its identity table](SCOPES-DESIGN.html#identity).

The HTML parser is [linkedom](https://github.com/WebReflection/linkedom), bundled with its dependencies into `vendor/linkedom.mjs` (licenses in `vendor/linkedom.LICENSES.txt`) so the tool runs where `npm install` can't, such as behind a corporate proxy. The markdown parser is [markdown-it](https://github.com/markdown-it/markdown-it), bundled the same way into `vendor/markdown-it.mjs`. The HTML-to-markdown writer is our own, in `domain/to-markdown.mjs`. To upgrade either: change the version in `package.json`'s devDependencies, then `npm install && npm run vendor`, and commit `vendor/`.

- **Tier I, orchestration**: the entry points, whose paths the [Contract](#contract-with-iterate-on-docs) names. `server.mjs`: CLI arguments, the HTTP request handler, the GET, PUT, and Done flows, and the live notices (below) (format with IDs, lift directives, compute bases, inject; read, assign IDs, check the base, apply the one change, write). `formatter.mjs`, `cleanup.mjs`, and `scopes.mjs` are CLIs: read each file, run the domain on it, write it back. `reply.mjs` is the agent's CLI: it hands a reply to the running server and writes no file itself. Tier I imports no vendored library itself. The server is the only writer of a live file, and it takes each read, change, and write of a file in turn (`oneAtATime`): GET's normalize, every PUT, and Done's read wait for the change before them. The PUT body is one change: `{"id": "<id>", "base": "<base>", "directive": "text", "replies": <n>}` (empty text removes the directive; `replies`, optional, is how many replies the tab has seen on the element, and a reply since makes the save 412 with `replies` now, so a turn typed before a reply came in isn't written again after it), `{"id": "<id>", "base": "<base>", "markdown": "…"}`, or `{"id": "<id>", "base": "<base>", "resolve": true}` (Resolve: the element's thread goes, directives and replies). The directive is the element's open turn, the `@AI` turns after its last reply, so after a reply a directive save adds a turn to the thread and leaves the earlier turns as written. The answer is `{"ok": true, "count", "bases": {"<id>": "<base>"}, "before", "after"}`: new bases for the element, its ancestors, and the IDs inside it, and the file's hash before and after the save. A markdown save's answer adds `html` (what replaced the scope, as served), `id` (the ID that holds the scope now), and `markdowns` (the new markdown of the scopes around it). A base that doesn't match, or an ID that isn't in the file, gets 412 and `{"ok": false, "error"}`. The agent's reply, from `reply.mjs`, is a PUT too: `{"id": "<id>", "thread": "<thread base>", "reply": "text"}`. Its base is the thread's (`threadBaseOf`: the turns, who each is for, and their text), so a turn added or a thread resolved makes it stale and an edit to the content doesn't. A stale reply, or one to an element with no thread, gets 412 with `directive` and `thread` as they are now, when there is a thread. The answer to one that lands is `{"ok": true, "count", "thread", "before", "after"}`. Done is a POST to the page with what the box opened with: `{"id": "<id>", "directive": "text", "markdown": "…"}`, markdown only for a scope. The tab queues it behind the box's saves; the server reads the file, and announces what changed. Resolve closes the box, so a resolve PUT is followed by its Done: the server keeps the turns the resolve took, per file and element, and that Done announces them as `resolved`, so one box session makes one Announcement. The answer is `{"announced": true|false}`, for the tab's telemetry.
- **Live notice**: a GET of a page with `Accept: text/event-stream` (the tab's `EventSource`) opens its stream of `change` events, `{"version", "cause", "id"?}`. `version` is the file's fingerprint after the change; `cause` is the change the server made (`directive`, `markdown`, `resolve`, `reply`, or `format`, GET's rewrite), with the element's `id`, or `disk` for a write that went around the server, or `connect`, the first event on each stream, with the version now. The server tells the stream as it writes, and watches the file's directory (`watchFile`) for the rest: one notice per save once the file is quiet for 100 ms, an editor's rename-over included, and none for a version it already told, so its own writes aren't news twice. A GET with `Accept: application/json` answers the page's state, `{"version", "directives", "threads", "bases"}`, as a GET of the page would serve them, and writes nothing, so a file an agent is mid-way through writing isn't written back. The tab ignores a notice for the version it holds (its own save) and otherwise fetches the state, in turn behind its saves. It takes each element's directive and thread, except any with a save waiting, which catch up when the save lands. The open box takes its element's thread: a reply settles the turns the file held before it, so they go up into the thread, and the field keeps what was typed past them and saves it as the next turn. A change on disk to the open box's directive alone waits until the box closes. A directive save refused for a reply (412 with `replies`) is no error: the tab catches up the same way, then sends what was left, ahead of the box's Done, and that Done announces what was added since the reply. An element whose base changed keeps its old base, since the tab can't show its new content: a save there is refused, and the docket says to reload. Closing the server ends the streams and stops the watchers.
- **Tier II, domain**: `domain/`, pure functions over a DOM. A domain module imports only other domain modules, `vendor/` (linkedom, markdown-it), and `node:crypto`, and never touches `process` or `console`. Orchestration does the I/O around a domain call. When the domain needs the world partway through its work, the domain module declares the shape it needs, a port, as a parameter with a comment and a default that does nothing; orchestration passes in the adapter from `interface/`. The example is the step port: `tabStateOf(document, author, step)` takes `step(name, fn)`, and `server.mjs` passes `step` from `telemetry.mjs`, so each step is a span. Each imports only the ones listed before it:
  - **Likeness**: `likeness.mjs`. `likeness`, how alike two pieces of HTML are: `reconcile` pairs elements with it, and `from-markdown.mjs` pairs stand-ins.
  - **Canonical form**: `canonical.mjs`. `parse` (adds a missing skeleton and rewrites into canonical forms: `b`→`strong`, `i`→`em`, table rows in `thead`/`tbody`), `serialize` (canonical layout: each element of an svg on its own line, a `<text>` whole on one), and `formatElement`, one element in that layout. `canonicalHTML` and `rawHTML`, content in that layout without directives or element IDs, which is how two pieces of HTML compare, and `hasAttrs`, whether an element has attributes besides the tool's.
  - **Scopes**: `scopes.mjs`. The kinds of element, `scopeElements` (which elements are scopes), `editable` (which scopes edit as markdown). Described below, with the next two.
  - **From markdown**: `from-markdown.mjs`. `nodesFromMarkdown` (the HTML a scope's markdown saves as: stand-ins restored, links and images paired with their originals), `roundTrips`, and the markdown-it setup.
  - **To markdown**: `to-markdown.mjs`. `scopeMarkdown`, a scope as markdown, each piece checked against `from-markdown.mjs` and written as HTML where it wouldn't read back the same.
  - **Scope reports**: `scope-report.mjs`. `scopeOf` and `scopesWithin` (each scope with its markdown, nested), `report` (what the `scopes.mjs` CLI prints), `exampleReport` (what `annotate` puts under an example).
  - **Element identity**: `identity.mjs`. `data-hrv` and `data-hrv-next` (named in `id-attribute.mjs`, at the bottom, since `canonical.mjs` needs them too), `elementById`, `assignIds` (every scope gets an ID, and so do `hr` and every element of an svg; IDs come from a counter, never change, are never reused, and copies of one ID all get fresh ones), and `reconcile`, which pairs the elements a rewrite made with the ones they replace, so each keeps its ID.
  - **Directives and threads**: `directives.mjs`. `collectDirectives` (each element's open turn), `threadsOf` (the settled turns of each thread), `setDirective`, `placeReply`, `replyCount` (what a directive save checks), `removeThread` (Resolve), `removeThreads`, the placement rule, `carryDirectives` (directives ride to their element's partner after a rewrite), escaping.
  - **The formatter**: `format.mjs`. `normalize` (parse, assign IDs, serialize) and `validate`, the rules normalizing can't fix (none yet).
  - **Bases**: `bases.mjs`. `baseOf`, the hash of an element in canonical layout with directives and IDs stripped. A directive coming or going changes no base; a changed child changes its parent's. `threadBaseOf`, the hash of an element's thread, the base a reply starts from.
  - **Markdown edits**: `markdown-edits.mjs`. `markdownsOf`, `committedMarkdowns`, `scopeFromMarkdown` (the scope's markdown as HTML, with the IDs and directives of the elements you kept: `nodesFromMarkdown`, then `reconcile` and `carryDirectives`), `saveMarkdown`, `settle` (the saved nodes as the file reads them back), `spillOf` and `spillIds` (the spill, below), `holderOf`, `servedHTML`.
  - **Annotation**: `annotation.mjs`. `annotate`: under each `.ex` example in SCOPES-DESIGN.html, the report `exampleReport` (in `scope-report.mjs`) builds, in canonical form. A rerun keeps the IDs and directives of the report elements that came back (`reconcile`, `carryDirectives`), and a page without IDs gets none.
  - **Announcements**: `announcements.mjs`. `announcementOf`: what one box session changed, directive and revision, before and after, the turns a Resolve took, and the element's thread base.
  - **The served page**: `served-page.mjs`. `tabStateOf`: what a tab keeps of the page besides its HTML (directives, threads, bases), through the step port. `injectClient`: the client and its data, added to the served copy.
  - **Cleanup**: `cleanup.mjs`. Parse, remove directives and element IDs, serialize (see [Clean up](#clean-up)).
- **Scopes**: `domain/scopes.mjs`, `domain/to-markdown.mjs`, `domain/from-markdown.mjs`. A scope is what you pick to direct or edit: any block, plus links and images; its whole content edits as markdown, if it's under 4 KB of HTML. `scopes.mjs` has `scopeElements` (which elements get IDs) and `editable` (which scopes edit as markdown); `to-markdown.mjs` has `scopeMarkdown` (a scope as markdown); `from-markdown.mjs` has `nodesFromMarkdown` (the HTML its markdown saves as). They know nothing of IDs or directives; `scopeFromMarkdown` in `markdown-edits.mjs` adds them. Saving a scope's markdown unchanged gives back the same HTML, element IDs included; saving it edited, each element you left, moved, or changed keeps its ID and its directives, and a new one gets none. A directive on an element the edit deleted goes with it. The `test/roundtrip-*.test.mjs` files check both on every page here and on generated ones. What markdown can't say comes out as HTML, and what isn't text (an svg, a script) rides along as a stand-in, `⟦svg⟧`; on save, each stand-in goes back to the original whose surroundings are most like its own. A link edits as `[text](href "title")`, and on save takes its other attributes (class, target, rel) back from the original it pairs with: same href and text, then same href, then same text. A link or image written as HTML keeps what it says; the `hrv-md` mark tells the two kinds apart while the save is built, and never reaches the file. `node scopes.mjs --annotate SCOPES-DESIGN.html` writes each case's HTML, scopes, and markdown under it in [SCOPES-DESIGN.html#scopes](SCOPES-DESIGN.html#scopes).
- **Tier III, interface**: `interface/`, the gateways to the world, and `vendor/`. Only these modules import `node:fs` or `node:child_process`. `files.mjs` is the filesystem gateway: reads, writes, directory listings, watching a file (`watchFile`), the file at the last commit, and the client assets injected into served pages: `client.css` and `client.js`, read on each GET, so a change shows on reload without a restart. `http.mjs`: request paths (under the root, 403 on escape), bodies, content types (so a page's own CSS and images load), what a GET wants by its `Accept` (`wants`), answers (404 for a missing file; for any other error, a plain-text 500 with the message, and its stack on stderr), event streams (`openEventStream`), the directory listing page, and `putJson`, the client side that `reply.mjs` calls the server with. `stdout.mjs`: Announcements. `telemetry.mjs`: the OTel API, always loaded and a no-op until the SDK registers, which it loads only with `HRV_TELEMETRY` (see [Telemetry](#telemetry)); `inSpan`, and `step`, the adapter for the domain's step port.
- **Markdown edits**: GET serves the markdown of every scope under 4 KB in `#hrv-markdown`, for the box. A PUT with `markdown` replaces the scope with what `scopeFromMarkdown` builds, which reconciles: elements you left or changed keep their IDs and directives. An element that isn't a scope (`hr`, an SVG shape), a scope of 4 KB or more, `body`, and blank markdown get 400. A scope a save grows past 4 KB comes back in the answer's `markdowns` as null, and its Content field goes. The tab doesn't render markdown: it swaps in the `html` the answer carries. When the file splits what a save made, as a typed `<p>` splits a paragraph, the answer's `spill` names the other elements it made; the box's next save sends it back, and the server replaces the scope and its spill together (a spill ID that isn't a sibling of the scope is 412). `test/spill.test.mjs` covers it.
- **Files it serves**: agent-generated documents whose generation we control. The tool may require things of them, limit what they contain, and rewrite them on disk. When a file shape causes trouble, normalize it into a shape the tool handles rather than supporting every HTML a browser accepts. If a requirement can't be met by normalizing, add it to the agent instructions above.
- **What the served page carries**: no directives as HTML comments; they come as data, in JSON scripts with `<` written `<`. `#hrv-directives` holds each element's directive, with the file's hash as its `data-version`. The page also carries the settled turns of each thread with a reply in `#hrv-threads` (`{"<id>": [{"prefix", "text"}]}`, through the last reply), every element's base in `#hrv-bases`, every scope's markdown in `#hrv-markdown`, and every scope's markdown at the file's last commit in `#hrv-committed`, for Revert. The server reads that with `git show HEAD:` and normalizes it, so a commit without IDs gets the numbers the page got when first opened.
- **Non-goals**: more than one user, auth, or remote access (the server listens on 127.0.0.1); history or undo beyond git, Revert, and the box's ⌘Z; edits that keep the source's layout, since the formatter owns it.

## Gotchas for maintainers

- linkedom doesn't create a missing `<html>`/`<head>`/`<body>`. It makes the first element the root, and reading `document.head` or `document.body` silently creates empty ones inside that root. Go through `parse()` in `domain/canonical.mjs`, never `parseHTML` directly.
- Everything in `vendor/` is a generated bundle. Don't edit it. After changing a version, run `npm run vendor`.
- GET normalizes the file in place. To try the server by hand, serve a temp copy of `test/fixtures`, not the directory itself.
