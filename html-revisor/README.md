# html-revisor

Review agent-generated HTML in a browser and leave directives on specific elements. Directives are saved in the HTML file itself as `<!-- @AI: ... -->` HTML comments. Nothing lives in the browser or a sidecar file.

You can also edit the page directly. Click any block (a paragraph, a list, one item, a section, a table cell), a link, an image, or a span: the box shows its content as markdown in a Content field above the directive. An element of 4 KB of HTML or more, such as the page's body or a wrapper around most of it, takes only a directive. Typing saves into the file, and the page shows the result when the save answers. Elements you left or changed keep their IDs and directives.

You and the agent take turns. You leave directives and edits, then hand the agent the turn; it carries out the directives by editing the file, removes them, and hands the page back for you to reload.

This repo is where html-revisor is developed. Its built output ships inside the [iterate-on-docs](https://github.com/jessitron/iterate-on-docs) plugin, vendored at `iterate-on-docs/html-revisor/`. Make changes here, not in that copy.

The [overview](https://jessitron.github.io/html-revisor/) and the pages it links are on GitHub Pages, published from `main` on GitHub. They show what's pushed, as plain pages: no box, no saving. `index.html` redirects to `OVERVIEW.html`, and `.nojekyll` tells Pages to serve the files as they are.

## Run

```
./run [file or dir] [--port 7777] [--author @AI] [--replies]
```

- Given a file, the server formats it, serves its directory, and prints the page's URL on startup. If the file breaks a rule the formatter can't fix, it exits 1 with the formatter's message.
- Given a directory, or nothing (the directory you run it from), the server prints the directory's URL. Open an `.html` file under it.
- `--author` sets the directive prefix (default `@AI`).
- `--replies` turns on the reply prototype, which isn't ready: see [Replies, the future](#replies-the-future).
- First load normalizes the file's formatting and rewrites it on disk. It also adds `<html>`, `<head>` and `<body>` if the file lacks them, the way a browser would. These files are agent-generated documents we control, so the tool rewrites them into the shape it needs.
- Loading also writes an element ID, `data-hrv="<n>"`, on each element you can pick, and the next unused number on `<html data-hrv-next="<n>">`. The first load of a page makes one noisy diff; after that a diff shows only new IDs.
- Typing in the box saves to the file, and prints nothing. Done, closing the box any way, prints an Announcement on stdout when the box changed something: one line of JSON: a record of what the user did in the box. The agent reads the file when the user hands it the turn; it doesn't act on these as they come.

```
{"page":"/OVERVIEW.html","id":"12","element":"p","heading":"Architecture","directive":{"before":"","after":"say what the tiers are"},"revision":{"before":"Three tiers.","after":"Three **tiers**."},"saw":"9f3c0a1b2c3d","version":"9f3c0a1b2c3d"}
```

  An Announcement reports one box session, one opening of the box from open to Done, and nothing of the agent's. `id` is the element's `data-hrv`. `heading` is the text of the heading it sits under, or null. `directive` is there when the directive changed, from what the box opened with to what the file holds now. `revision` is there when you saved the scope's content in this box session: from before your first content save to after your last, so an agent change before, between, or after them is not in it, and typing then undoing in one session is none. Directive text is as the file holds it: trimmed, `--` as `- -`. `version` is the scope's version at Done, which an agent hands to `change.mjs replace` or `remove` (see [The agent's command](#the-agents-command)). `saw` is the version the tab showed when you wrote; when it differs from `version`, your words are about older content. The box opened and closed with nothing of yours changed, or a reload with the box open, prints nothing.

  When the element was taken out of the page while the box was open, your directive landed on the nearest element around it that the page holds, after the directive already there. The Announcement names that one: `id`, `element`, `heading`, `version`, and the thread are the holder's, `from` is the ID you typed on, `directive` is your words alone, and `saw` the version of the element you typed on, so `saw` and `version` always differ there.
- A field, any `input`, `textarea`, or `select` in the page, saves its value into the file when it changes: a checkbox or radio as it ticks, a text field when it loses focus or you press Enter. Each save that changed the file prints a field Announcement. `field` holds the field's `type`, its `name` and the text of its `label` when it has them, and its value `before` and `after`: true or false for a checkbox or radio, an array of option values for a multiple select, a string for the rest. Buttons, hidden inputs, file pickers, and passwords are no fields. A form submits nowhere: its values are in the file.

```
{"page":"/plan.html","id":"31","element":"input","heading":"Groceries","field":{"type":"checkbox","label":"Buy milk","before":false,"after":true},"version":"0d4e5f6a7b8c"}
```

Needs Node 20 or later. No `npm install`: the dependencies, linkedom, markdown-it, and OpenTelemetry, are bundled into `vendor/`.

## Telemetry

```
HRV_TELEMETRY=1 OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<ingest key> ./run
```

`HRV_TELEMETRY` turns on OpenTelemetry traces; without it the server sends nothing, even with `OTEL_*` variables set (Claude Code reads those for its own telemetry, so they can leak into a server an agent starts). Once it's on, the standard variables say where spans go: `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`), `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` (default `html-revisor`, which is the Honeycomb dataset), `OTEL_RESOURCE_ATTRIBUTES`. A failed export prints `telemetry export failed` on stderr.

To take these from `.be`, `with-be ./run`. `with-be` is in Jess's dotfiles, `bin/`: it runs a command with the variables from `.be` at the repo root (in a worktree, the main checkout's).

What it traces:

- **GET, PUT, Done, and ack**: a span per request (`POST done` for Done, with `hrv.announced`; `POST ack` for an ack, with `hrv.scope.id` and `hrv.notice.count` after it; GET page and GET state carry `hrv.notice.count` too), continuing any `traceparent`, with a child span per step (read file, normalize, parse, set markdown, serialize, write file, …) and attributes `hrv.page`, `hrv.page.bytes`, `hrv.change.kind`, `hrv.scope.id`, `hrv.answer.bytes`, and counts. `PUT change` carries `hrv.wrote`: false when the save left the file as it was (a trailing space, trimmed), so it has no write file step. A markdown save that splits its scope, as a typed `<p>` splits a paragraph, carries `hrv.spill.made` (the other elements it made) and the next save `hrv.spill.count` (the ones it replaces). A save from a box, and its `POST done`, carry `hrv.box.session`; a directive that landed on an ancestor carries `hrv.moved.from` and `hrv.moved.to`.
- **The box's saves**, recorded in the browser. Each change is a trace: `save directive` or `save markdown` runs from when the change goes out to the answer applied, with children `PUT` (until it's answered; the server's `PUT change` nests under it) and `apply`. The typing before it is in attributes: `hrv.wait.ms` since the first keystroke, `hrv.quiet.ms` since the last, `hrv.edits` keystrokes. A markdown save carries `hrv.reverted`, true when Revert typed into it. It also carries the element (`hrv.element`, `hrv.scope.id`) and its content before and after: `hrv.html.*`, `hrv.markdown.*` or `hrv.directive.*`, each with a `.length`. Both kinds carry `hrv.directive`, the scope's directive once the save lands. A box closed while a save is going adds a `close box` event to that save (`hrv.close.by`: done, key, click away…; `hrv.pending`).
- **The agent's change**: `PUT agent change`, with `hrv.change.kind` (replace, add, remove, move), `hrv.scope.id` (the ID it named), `hrv.conflict` when refused as stale or gone, `hrv.refused` for HTML that can't go there, `hrv.new.count`, and a step per part (read file, parse, the change, serialize, reparse, write file). Its read is `GET scope`.
- **Catching up**, recorded in the browser: a `refresh` trace when a live notice sends the tab for the page's state, with the server's `GET state` under it (`hrv.since.known`, and a `catch up` step with `hrv.swap.count`), `hrv.swapped` (elements whose content the tab swapped in), `hrv.held` (swaps waiting for the open box), and `hrv.updated` (elements whose directive it took). An event stream gets no span: it lasts as long as the tab.
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
- It replaces the whole directory, leaving out dev-only files: `CLAUDE.md` (and those in `test/` and `domain/`), `CONTRIBUTING.md`, `OVERVIEW.html`, `DESIGN.html`, `CONCURRENCY.html`, `design/`, `index.html`, `.nojekyll`, `.gitignore`, `.claude/`, `deploy`. It writes `VENDORED.md` with the commit hash.
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
| Announcements | when the user closes the box (Done) after changing something, the server prints one line of JSON on stdout: `{"page", "id", "from"?, "element", "heading", "directive"?: {"before", "after"}, "revision"?: {"before", "after"}, "saw"?, "version"}`, as under [Run](#run). When the user changes a field, its save prints a field Announcement: `{"page", "id", "element", "heading", "field": {"type", "name"?, "label"?, "before", "after"}, "version"}`. Every JSON line on stdout starts with `{`, and no other line does. Saves from the box print nothing |
| Directive syntax | `<!-- @AI: … -->`, first child of its element, or just before a void or raw-text element (full list under [Directive format](#directive-format)). On an element whose first child is one of those, it's the last child |
| Finding directives | `grep '<!-- *@AI:'` |
| Formatter CLI | `node ../../html-revisor/formatter.mjs <file>...`, from the skill's base directory. Rewrites each file in place into the same canonical form a page load gives. Silent and exit 0 on success; exit 1 with `<file>: <problem>` on stderr when a file can't be read or written or breaks a rule the formatter can't fix (it still writes the fixable part); exit 2 with usage when given no files |
| Change CLI | `node ../../html-revisor/change.mjs <page URL> read <id>`, `replace <id> <version>`, `add after\|before\|into <id>`, `remove <id> <version>`, `move <id> after\|before\|into <other id>`, from the skill's base directory, HTML on stdin for replace and add. A change takes `--because "<what it is for>"`, which the user reads on the change's mark. One line of JSON on stdout; exit 0 landed, 1 refused (`{"ok": false, "error", …}`, with the scope's `html` and `version` now when it changed since) or no server, 2 usage. See [The agent's command](#the-agents-command) |
| Cleanup CLI | `node ../../html-revisor/cleanup.mjs <file>...`, from the skill's base directory, when the user says "good enough". Rewrites each file in place without directives (`<!-- @AI: … -->`) or element IDs, formatting kept. Prints each directive it removed on stdout as `<file>: <text>`, newlines as spaces. Exit 0 on success; exit 1 with `<file>: <problem>` on stderr when a file can't be read or written; exit 2 with usage when given no files |
| Loading a page reformats its file | each GET rewrites the file on disk into canonical formatting, with element IDs. The skill runs the formatter CLI before each commit, so the reformat lands in the agent's commit and doesn't show up as the user's next edit |
| Element IDs | the formatter (GET, PUT, and the formatter CLI) writes `data-hrv="<n>"` on each element you can pick and `data-hrv-next="<n>"` on `<html>`. Agents leave both alone: don't change, copy, or remove them. A new element needs none; the next format gives it one |
| No revise | an agent puts `data-no-revise` on an element, for a page with interaction of its own: that element and all inside it can't be picked. The tool ignores clicks there, so no box opens, and the page keeps its click behavior, focus, and cursor. A parent scope's markdown still holds its text: it can't be picked, and it isn't protected. The attribute stays through format and cleanup |
| Fields | an agent writes a form with plain HTML fields: `input`, `textarea`, `select`. The tool leaves clicks on a field, and on the label around it, to the page, and saves each change into the file, so it shows in the next git diff: a checkbox or radio as the `checked` attribute (a checked radio unchecks the others of its name in its form), a text input as its `value` attribute, a textarea as its text (`&` and `<` escaped), a select as `selected` on its options. Each save that changed the file prints a field Announcement. The formatter gives each field its own `data-hrv` ID. The agent sets the starting values as in HTML and reads the user's from the file or the Announcements. A form submits nowhere. A change made in the tab shows in the file, not in an agent's edit to a field the tab has open: reload |
| Browser behavior | click a block, link, image, or part of an SVG to leave a directive on it or change its wording; both save into the file as you type. A directive always saves, whatever happened to the content under it; when its element is gone, it lands on the nearest element around it. A content edit on an element that changed while its box was open is refused, with a message to copy the edit and close the box. Revert puts a scope's content back to the file's last commit, so in an iterate loop it goes back to the start of the turn. The box reopened on a directive holds it in the field to edit in place. The open tab hears of each change to the file without a reload: a directive added or removed on disk shows or takes away its marker, and content changed on disk, by the agent's command, or in another tab shows in place; a change to the open box's element waits until the box closes |
| Bug reports | an agent with a checkout at `~/code/jessitron/html-revisor` adds a yak there, with the moment, the page shape that caused it, and the commit `VENDORED.md` in the copy names (`CONTRIBUTING.md`). It files no GitHub issue. Anyone else offers the user an issue at `https://github.com/jessitron/html-revisor/issues` |
| README | this README ships in the output and keeps its "Directive format" section; iterate-on-docs links to it |
| Vocabulary | the words the user sees: **directive** (the directive box says "Directive", "Directive for this element", "Clear the directive (⌥⌘⌫)"; the docket says "N directives" (or "1 directive"), "Previous directive", "Next directive", and "N directives · review off"). **change**, for content changed since the user last saw it: the docket says "N changes" (or "1 change"), "Previous change", "Next change", "Seen all: take every mark off"; the check tile on a changed element says "Seen: take this mark off". **Notice** is the code's word for one; the user sees green crop marks. The box's fields are labeled "Content" and "Directive"; its buttons are **Done**, **Clear** on the Directive label's line, and **Revert** on the Content label's line ("Put back the content this had at the last commit"); its footer says "⌘↵ or esc to close", or the save status "saving…", "saved", "not saved". Typing saves; Done closes the box. Not note, comment or annotation |

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

The tool never drops a directive on its own. The human removes one by clearing it or deleting its element in a markdown edit; the agent, by addressing it or running cleanup.

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
On an element with interaction of its own, like input controls, add the HTML
attribute data-no-revise to its tag: <div data-no-revise>. That element and all
inside it can't be picked for a directive, and clicks there go to the page.
To ask the user for answers, write a form with plain fields: <input>, <textarea>,
<select>, checkboxes, radios. Each change saves into the file (checked, value, the
textarea's text, selected) and prints a field Announcement; read the answers from the file.
A form submits nowhere, so it needs no action and no submit button.
```

## Manual client checklist

Each save carries one change, to one element, with that element's base: a hash of its content as the tab last saw it. If the element changed on disk since, the server refuses a content save (412), and the box stops saving content for the rest of its session and says so once. A directive is a turn, not a change: it saves whatever happened to the content. A change elsewhere in the file doesn't block the save; the tab notices it from the file's hash and swaps it in. A save touches only its own directive, so a tab can't resurrect a directive the agent finished and removed.

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
- [ ] Clicking the docket's icon or count turns review mode off (`· review off`): markers hide, the docket's arrows hide and ⌥↑/⌥↓ don't step, hovering shows no marks and no copy cursor, and clicks go to the page. Clicking again turns it back on.
- [ ] Reloading the page shows the marker. The element itself is not restyled.
- [ ] Closing a box with a directive leaves its pencil marker, and hovering it shows the directive. Clicking the marker opens the box with the directive in its field; editing it changes the directive in the file in place.
- [ ] While writing a new directive, Clear (or emptying the text, or `⌥⌘⌫` in the box) removes the directive and the marker. Clear shows only when there is a directive, in both boxes, and its tooltip names the hotkey. Clear leaves the box open with the Content field as you left it, and `⌘Z` brings the directive back.
- [ ] In a committed page, Revert shows on the Content line only after you change a scope. Clicking it puts the committed markdown back and saves; `⌘Z` takes the revert back. Delete a list item, then Revert the list: the item returns.
- [ ] `⌘↵`, `Esc`, Done, and clicking outside each commit and close the box. (On a page with a full-width wrapper element, clicking the margin opens a box on the wrapper instead; use Esc.)
- [ ] After `⌘↵`, `Esc`, or Done, focus is on the element: Tab goes to the next link after it, not the top of the page. Once focus leaves, the element holds no `tabindex`.
- [ ] In a scope's box with a changed scope and a directive, Tab goes Revert, Content, Clear, Directive, Done, and wraps back to Revert; Shift-Tab goes the other way. A hidden action takes no stop. A button you Tab to wears the accent ring, and nothing moves; a click shows no ring. Enter or Space presses it.
- [ ] Opening a second box commits and closes the first.
- [ ] Plain click on a link opens a directive box. ⌘- or Ctrl-click on a link to a place in this page scrolls this tab there, and an open box stays open; on a link to another page, local or not, it opens a new tab. Shift- or ⌥-click goes to the browser.
- [ ] Add `data-no-revise` to an element holding an input. Hovering it shows no marks and the page's cursor. Clicking the input puts the caret there, and no box opens; an open box stays open.
- [ ] Add `<label><input type="checkbox"> Item</label>` to a page. Hovering the box shows no marks. Clicking the box or its label ticks it and opens no directive box; the file gains `checked` on the input (`git diff`), and unticking removes it. The server prints a field Announcement for each. Reload and the tick holds.
- [ ] Add `<form><input name="q"><textarea></textarea><select><option>a</option><option>b</option></select></form>`. Type in the input and press Enter: the page stays, the file gains `value`, and one Announcement prints. Typing in the textarea saves nothing until you click away. Picking `b` saves `selected` on it.
- [ ] The page's own layout and styles look the same with the UI loaded, including while hovering: a card keeps its own box-shadow.
- [ ] Stopping the server and typing shows `save failed: ...` on the docket; restarting and typing again saves and clears it.
- [ ] With a box open on an element, edit that element in the file on disk: the docket says "this element changed; close the box to see it", and the page holds still. Type a directive: it saves, and the content on disk stays. Edit the Content: the docket says your content edit didn't save, once, the box's footer says `not saved`, no more content saves go out, and the field keeps your text. Close the box: the change shows.
- [ ] With a box open on a list item, remove the list with `node change.mjs`, then type a directive: the docket says "this element is gone; your directive is on the … around it", and the marker shows there. Done prints an Announcement with `from`.
- [ ] Edit a different element on disk: it shows without a reload, and the page doesn't scroll. Type a directive on it: it saves.
- [ ] Make a change with `node change.mjs … --because "shorter, as you asked"`: hovering its check tile shows those words in the tip, with a green rule and "Seen: take this mark off" under them. The changes row's ↓ shows the same tip when it steps there. A change with no `--because` shows the browser's tooltip alone.
- [ ] Run each verb of `node change.mjs` on the page (see [The agent's command](#the-agents-command)): each shows without a reload, with green crop marks. A directive inside a scope you replace stays.
- [ ] Add `<!-- @AI: … -->` to an element on disk: its marker shows without a reload. Delete it: the marker goes.
- [ ] With two tabs on one page, a directive typed in one shows its marker in the other.
- [ ] Edit an element's text on disk: it takes green crop marks and a check tile left of its first line (beside its marker, if it has a directive), without a reload, and the docket shows "1 change". Reload: the mark stays. Click the check: the mark goes, in the other tab too. Edit it on disk again and type a directive on it: the mark goes as the directive saves. Add a section on disk: one mark, on the section. ↑ and ↓ on the changes row step through them; its check takes every mark off. Review off hides them.
- [ ] Change a list item and its list on disk, and a heading above. The changes row's ↓ steps the heading, the item, then the list: inner changes first. After a click on the row's ↑ or ↓, or `c` (which starts at the first change), ↓ and `n` step to the next change and ↑ and `p` to the previous; space takes the mark off and stays; Enter takes it off and steps to the next. Enter on the list takes the item's mark too. Escape, a click elsewhere, or no changes left gives the keys back to the page. `d` steps to the next directive. None of these keys work with a box open, in a text field, with ⌘, Ctrl, ⌥ or Shift held, or with review off.
- [ ] In dark mode the box, markers and docket look the same as in light mode: one material.

## The agent's command

An agent can change the page through the running server instead of editing the file. The server makes each change in turn with the browser's saves, so neither writes over the other; your directives inside what it changes stay; and the open tab shows the change without a reload, wearing green crop marks. It works on any server. Turn-taking goes on as before: an agent that edits the file works as it did.

```
node change.mjs <page URL> read <id>                            # the scope now: its HTML and its version
node change.mjs <page URL> replace <id> <version> < new.html      # new content for the scope
node change.mjs <page URL> add after|before|into <id> < new.html
node change.mjs <page URL> remove <id> <version>
node change.mjs <page URL> move <id> after|before|into <other id>
```

- `<page URL>` is the page as the server's startup line names it; `<id>` is an element's `data-hrv`. HTML comes on stdin.
- **--because "<a few words>"**, on any change: what the change is for, such as the directive it answers. The user reads it in the tip on the change's check tile, and when stepping through the changes. It rides on the notice (`because`) until the user acks, and the next change to that scope replaces it or, with none, takes it away. The server keeps it in memory; a restart forgets.
- **version**: the scope's version, from `read`, from the answer to the agent's last change, or from an Announcement. Hand it back unread. A directive or reply moves no version, so your turns never make the agent's change stale. Today it is the scope's base, a hash of its content; it will become a number that counts up, and the command stays the same.
- **read** writes nothing: `{"ok": true, "id", "version", "html"}`, the scope as the file holds it, IDs in, directives and replies out.
- **replace** takes one root element, which keeps the scope's ID whatever it says. Keep `data-hrv` on the elements you kept and leave it off new ones: the server numbers them. An ID from elsewhere in the page, a made-up one, or one written twice comes off, and that element is new. Elements left without their ID take it back where they pair with the old ones, as a markdown save's do.
- **remove** takes a version too. **add** and **move** take none: they land unless a scope they name is gone. A move carries the scope's content, IDs, and threads along. `into` puts it last inside. Body can't be replaced, removed, or moved, and has no after or before. A table row has no ID: replace the table.
- **Your words never drop.** Each thread (directive and replies) rides with its element by ID. When the agent's HTML drops that element, its thread moves up to the scope it replaced, after that scope's own turns, so the two read as one directive. A removed scope's threads, and those in it, move to the element that held it. Directives and replies in the agent's HTML come out: replies go through `reply.mjs`.
- **Landed**: exit 0, `{"ok": true, "id", "version", "ids"}`: the scope (for add, the first new element; for remove, the element that held it), its version now, and the IDs the server gave new elements. The live notice goes out with cause `agent`.
- **Refused**, nothing written, exit 1, `{"ok": false, "error", …}`. A scope that changed since the version named adds `"id", "version", "html"`, what it holds now, to redo the change on. A gone ID adds `"id"`. HTML that can't go there (more than one root for replace, nothing, an `<li>` outside a list, a `<tr>` after a `<p>`, a `<div>` in a `<p>`, html/head/body tags) says why. No server: exit 1, a message on stderr. Usage: exit 2.

The requests: `read` is a GET of the page with `Accept: application/json` and `?scope=<id>` (404 for a gone ID). The rest are a PUT to the page, one body each:

```
{"change": "replace", "id": "7", "version": "…", "html": "<p>…</p>"}
{"change": "add", "where": "after"|"before"|"into", "id": "7", "html": "…"}
{"change": "remove", "id": "7", "version": "…"}
{"change": "move", "id": "7", "where": "after"|"before"|"into", "to": "9"}
```

Any of them may add `"because": "…"`. A stale version or gone ID is 412, HTML that can't go there 400, both as JSON.

## Replies, the future

Turn-taking makes the user wait while the agent works. The next shape is replies: the agent answers each directive in the page as the user closes its box, and the user keeps reviewing, with many small conversations going at once. A prototype is built, and it proved the shape is worth having. It is not good enough to use. Agents: don't reply in the page unless the user asks for replies by name.

What broke, in a trial with the agent replying while the user reviewed: directives were lost, because the agent's direct edit of the file overwrote a save that landed between its read and its write; a box open across an agent edit sent its directive into conflict, 25 times over; boxes opened before an agent edit announced the agent's own text as the user's revision. The server can take its own writes in turn, but carrying out a directive means editing the file around it. Replies wait on a rewrite designed around concurrent changes; the yak "Get your concurrency together" holds the report, and [REPLY-DESIGN.html](REPLY-DESIGN.html) the design so far.

The prototype as it stands, behind `--replies` on the server:

- **Replies in the file**: `<!-- @Human: … -->`, escaped as a directive is, after the last turn of the element's thread. The prefix names who the words are for. An element's directives and replies, in file order, are its thread; the directive is its open turn, the `@AI` turns after its last reply. Threads change no element's base, and cleanup removes them.
- **The reply CLI**: `node reply.mjs <page URL> <id> <thread> <text>`, with `<id>` and `<thread>` from the Announcement. It is a PUT, `{"id", "thread", "reply"}`, whose base is the thread's (`threadBaseOf`), so a turn added or a thread resolved makes it stale and a content edit doesn't. It prints one line of JSON: exit 0 when it landed, `{"ok": true, "count", "thread", "before", "after"}`, with the base for a next reply; exit 1 when stale, `{"ok": false, "error", "directive"?, "thread"?}`, to read the new turn and reply again; exit 1 with a message on stderr when no server answers or replies are off (409); 2 with usage. A live notice with cause `reply` tells the open tab, and telemetry names the span `PUT reply`.
- **Announcements** add `thread`, the thread's base, when the element has one. Resolve closes the box, and its Done announces `resolved`, the turns of the thread that ended, each `{"prefix", "text"}`, with no `thread`, even with nothing else changed. A turn the user hadn't sent goes with it, last in `resolved`.
- **The box**, once the agent replies, shows the thread, each turn headed "you" or "agent"; the field below is "You", placeholder "Add to the thread", and what's typed there is a new `@AI` turn. **Resolve** sits beside Done and removes the whole thread (a PUT with `"resolve": true`). A directive whose box closed is the agent's to work on: its marker shows three green squares ("Agent working on: …"), and reopened, the box shows it in the thread with the agent "working", and the field adds a turn after it. A new reply gives the marker a green bubble ("New reply: …") and the docket a second row, "N new replies", with its own ↑ and ↓, until the user adds a turn or resolves.
- **Catching up**: the served page carries `data-replies` on `#hrv-directives` and the settled turns of each thread in `#hrv-threads`. A reply to the open box's element joins the thread in the box; the field keeps what was typed past the turns it settled, as the next turn. A directive save carries `replies`, how many the tab has seen; a reply since gets 412 with the count now, and the tab catches up and sends what was left.

## Design

The code is in three tiers, and a file's tier is where it lives: the top-level `*.mjs` files are Tier I, `domain/` is Tier II, `interface/` and `vendor/` are Tier III. Dependencies point down, and no module imports itself through others; `test/architecture.test.mjs` checks both, along with the rest of the rules below. `client.css` and `client.js` run in the browser: the server inlines them into each page. The client is a plain script, with no build step, no framework, and no external resources. How the UI looks, and the design decisions so far, are in [DESIGN.html](DESIGN.html); it links `client.css`, so it shows the real styles. How editing as markdown behaves, and its design decisions, are in [SCOPES-DESIGN.html](SCOPES-DESIGN.html#decided); how elements keep their IDs across a save is in [its identity table](SCOPES-DESIGN.html#identity).

The HTML parser is [linkedom](https://github.com/WebReflection/linkedom), bundled with its dependencies into `vendor/linkedom.mjs` (licenses in `vendor/linkedom.LICENSES.txt`) so the tool runs where `npm install` can't, such as behind a corporate proxy. The markdown parser is [markdown-it](https://github.com/markdown-it/markdown-it), bundled the same way into `vendor/markdown-it.mjs`. The HTML-to-markdown writer is our own, in `domain/to-markdown.mjs`. To upgrade either: change the version in `package.json`'s devDependencies, then `npm install && npm run vendor`, and commit `vendor/`.

- **Tier I, orchestration**: the entry points, whose paths the [Contract](#contract-with-iterate-on-docs) names. `server.mjs`: CLI arguments, the HTTP request handler, the GET, PUT, and Done flows, and the live notices (below) (format with IDs, lift directives, compute bases, inject; read, let `domain/revision.mjs` decide, write, answer). `formatter.mjs`, `cleanup.mjs`, and `scopes.mjs` are CLIs: read each file, run the domain on it, write it back. `change.mjs` is the agent's command ([The agent's command](#the-agents-command)), and `reply.mjs` belongs to the reply prototype (see [Replies, the future](#replies-the-future)); both call the server through `interface/http.mjs`. Tier I imports no vendored library itself. The server takes each read, change, and write of a file in turn (`oneAtATime`): GET's normalize, every PUT, and Done's read wait for the change before them. The PUT body is one change: `{"id": "<id>", "base": "<base>", "directive": "text", "ancestors": ["<id>", …], "session": "<box session>"}` (empty text removes the directive) or `{"id": "<id>", "base": "<base>", "markdown": "…", "session": "<box session>"}`, or `{"id": "<id>", "base": "<base>", "field": <value>}` (see [Run](#run) for the value's shape; it prints its own Announcement). `session` is the random ID the tab gives each box when it opens; the server keeps what each session's saves landed until its Done (`boxSessions`). The answer is `{"ok": true, "count", "bases": {"<id>": "<base>"}, "before", "after"}`: new bases for the element, its ancestors, and the IDs inside it, and the file's hash before and after the save. A markdown save's answer adds `html` (what replaced the scope, as served), `id` (the ID that holds the scope now), and `markdowns` (the new markdown of the scopes around it). For a content save (markdown, field), a base that doesn't match, or an ID that isn't in the file, gets 412 and `{"ok": false, "error"}`. A directive is a turn, not a change to content: it lands whatever its element's base is now. On an element that is gone, it lands on the first of `ancestors` (nearest first) the file holds, after the directive there, replacing what the same session landed before; its answer adds `id` (where it landed), `from` (the ID it was typed on), and `directive` (what that element's directive is now). With no ancestor left, it gets 412. Done is a POST to the page: `{"id": "<id>", "session": "<box session>", "directive": "text", "saw": "<base>", "ancestors": ["<id>", …]}`: the directive the box opened with, and the element's base as the tab held it (`saw`); only `id` and `directive` are required. The tab queues it behind the box's saves; the server reads the file and the session's saves, and announces what the session did (see [Run](#run)). The answer is `{"announced": true|false}`, for the tab's telemetry.
- **Notices**: the server keeps in memory, per file, each scope's content as you last saw it (`domain/notices.mjs`); a restart forgets. The first read of a page since the server started (GET page or GET state) takes it as seen, whole. Content that differs since is a notice, `{"id", "kind": "changed"|"new", "because"?}`, where `because` is what the agent said its change is for (`explained`: the words of the nearest scope at or around the notice that an agent change named): GET page serves them in `#hrv-notices`, GET state in `notices`, and the tab draws green crop marks and a check tile on each, with a docket row, "N changes". Your own markdown or field save is seen, and takes the mark off the scope you edited; its answer carries `notices`. A directive you add or change from the tab (a PUT with a non-empty `directive`) takes the mark off the element it lands on and off each element around it, but not the marks of changed elements inside them; a new element a mark covered goes with it, so no mark appears where none was (`directed`). Its answer carries `notices` too. Clearing a directive, or a directive written into the file, is no ack. An ack is a POST to the page, `{"ack": "<id>"}` (that element and all in it) or `{"ack": "all"}`: it writes nothing to the file, answers `{"notices": [...]}`, and every open stream on the page hears a `notices` event, `{"notices": [...]}`. Everything that reads or changes what you saw takes the file's turn.
- **Live notice**: a GET of a page with `Accept: text/event-stream` (the tab's `EventSource`) opens its stream of `change` events, `{"version", "cause", "id"?}`. `version` is the file's fingerprint after the change; `cause` is the change the server made (`directive`, `markdown`, `check`, `resolve`, `reply`, `agent` for the agent's command, or `format`, GET's rewrite), with the element's `id`, or `disk` for a write that went around the server, or `connect`, the first event on each stream, with the version now. An ack, which changes no file, goes out as a `notices` event (see Notices, above). The server tells the stream as it writes, and watches the file's directory (`watchFile`) for the rest: one notice per save once the file is quiet for 100 ms, an editor's rename-over included, and none for a version it already told, so its own writes aren't news twice. A GET with `Accept: application/json` answers the page's state, `{"version", "directives", "threads", "bases", "notices"}`, as a GET of the page would serve them, and writes nothing, so a file an agent is mid-way through writing isn't written back. With `?since=<version>`, the version whose content the tab shows, it adds `swaps`, `[{"id", "html"}]`, and `markdowns` for the scopes in and around them (`domain/catch-up.mjs`): the outermost elements whose content changed, each as HTML in which every element the tab has unchanged, wherever it sits, stands as `<!--hrv-keep N-->`. The server keeps the last 8 texts of each file it read or wrote to diff from; a version older than those swaps the whole body. The tab ignores a notice for the version it holds (its own save) and otherwise fetches the state, in turn behind its saves. It swaps the content in, putting its own elements back where the keeps stand, so an element moved or beside the change stays the same node, and one whose tag and attributes held keeps its node and takes new children; the page scrolls no more than the change does. Then it takes the new bases, and each element's directive, except any with a save waiting, which catch up when the save lands. A swap that would change or drop the open box's element waits until the box closes, and the docket says "this element changed; close the box to see it"; until then that element and those around it keep their old bases, even through a save's answer, so a content save there is refused; a directive there saves. A change on disk to the open box's directive waits for the box too. Closing the server ends the streams and stops the watchers.
- **Tier II, domain**: `domain/`, pure functions over a DOM. A domain module imports only other domain modules, `vendor/` (linkedom, markdown-it), and `node:crypto`, and never touches `process` or `console`. Orchestration does the I/O around a domain call. When the domain needs the world partway through its work, the domain module declares the shape it needs, a port, as a parameter with a comment and a default that does nothing; orchestration passes in the adapter from `interface/`. The example is the step port: `tabStateOf(document, author, step)` takes `step(name, fn)`, and `server.mjs` passes `step` from `telemetry.mjs`, so each step is a span; `fn` gets a `note(attributes)` for what goes on it. Each imports only the ones listed before it:
  - **Likeness**: `likeness.mjs`. `likeness`, how alike two pieces of HTML are: `reconcile` pairs elements with it, and `from-markdown.mjs` pairs stand-ins.
  - **Canonical form**: `canonical.mjs`. `parse` (adds a missing skeleton and rewrites into canonical forms: `b`→`strong`, `i`→`em`, table rows in `thead`/`tbody`), `serialize` (canonical layout: each element of an svg on its own line, a `<text>` whole on one), and `formatElement`, one element in that layout. `canonicalHTML` and `rawHTML`, content in that layout without directives or element IDs, which is how two pieces of HTML compare, and `hasAttrs`, whether an element has attributes besides the tool's.
  - **Scopes**: `scopes.mjs`. The kinds of element, `scopeElements` (which elements are scopes), `editable` (which scopes edit as markdown). Described below, with the next two.
  - **From markdown**: `from-markdown.mjs`. `nodesFromMarkdown` (the HTML a scope's markdown saves as: stand-ins restored, links and images paired with their originals), `roundTrips`, and the markdown-it setup.
  - **To markdown**: `to-markdown.mjs`. `scopeMarkdown`, a scope as markdown, each piece checked against `from-markdown.mjs` and written as HTML where it wouldn't read back the same.
  - **Scope reports**: `scope-report.mjs`. `scopeOf` and `scopesWithin` (each scope with its markdown, nested), `report` (what the `scopes.mjs` CLI prints), `exampleReport` (what `annotate` puts under an example).
  - **Element identity**: `identity.mjs`. `data-hrv` and `data-hrv-next` (named in `id-attribute.mjs`, at the bottom, since `canonical.mjs` needs them too), `elementById`, `assignIds` (every scope gets an ID, and so do `hr`, every table row (a unit for notices, never a scope: a click on it picks the table, and a thread passes it by), and every element of an svg; IDs come from a counter, never change, are never reused, and copies of one ID all get fresh ones), and `reconcile`, which pairs the elements a rewrite made with the ones they replace, so each keeps its ID.
  - **Directives and threads**: `directives.mjs`. `collectDirectives` (each element's open turn), `threadsOf` (the settled turns of each thread), `setDirective`, `placeReply`, `replyCount` (what a directive save checks), `removeThread` (Resolve), `removeThreads`, the placement rule, `pinTurns` and `repinTurns`, `carryDirectives` (directives ride to their element's partner after a rewrite), escaping.
  - **The formatter**: `format.mjs`. `normalize` (parse, assign IDs, serialize) and `validate`, the rules normalizing can't fix (none yet).
  - **Bases**: `bases.mjs`. `baseOf`, the hash of an element in canonical layout with directives and IDs stripped. A directive coming or going changes no base; a changed child changes its parent's. `threadBaseOf`, the hash of an element's thread, the base a reply starts from.
  - **Notices**: `notices.mjs`. What changed since you last saw it. Its `ownOf` and `unitsIn` serve catching up too. `seenOf`, the page as you see it: each unit's own content (a unit is an element with an ID; its own content holds a placeholder for each unit in it, and an element that is no unit folds into the unit around it), with directives, replies, IDs, and layout left out. `noticesOf`, the notices in document order, `{id, kind: "changed"|"new"}`: a unit whose own content differs, or the outermost new one. A child you never saw doesn't change its parent; one gone, or children in a new order, does. A new unit inside a changed one carries no notice of its own, and body carries none. `ack`, a unit and all in it seen, or `"all"`. `absorb`, your own change seen: whatever it made new or different, and the scope you edited. `directed`, your directive seen: the marks on its unit and the units around it, and the new units those marks covered.
  - **Markdown edits**: `markdown-edits.mjs`. `markdownsOf`, `markdownsNear` (the markdowns a change's answer carries), `committedMarkdowns`, `scopeFromMarkdown` (the scope's markdown as HTML, with the IDs and directives of the elements you kept: `nodesFromMarkdown`, then `reconcile` and `carryDirectives`), `saveMarkdown`, `settle` (the saved nodes as the file reads them back), `spillOf` and `spillIds` (the spill, below), `holderOf`, `servedHTML`.
  - **Annotation**: `annotation.mjs`. `annotate`: under each `.ex` example in SCOPES-DESIGN.html, the report `exampleReport` (in `scope-report.mjs`) builds, in canonical form. A rerun keeps the IDs and directives of the report elements that came back (`reconcile`, `carryDirectives`), and a page without IDs gets none.
  - **Announcements**: `announcementOf`, in `announcements.mjs`: what one box session did, from the file at Done and what the server kept of the session's saves: the directive and the revision, before and after, the turns a Resolve took, the element's thread base, `saw` and `version`, and for an element that is gone, the ancestor its directive landed on. `fieldAnnouncementOf`: what one field save did.
  - **Fields**: `fields.mjs`. Which elements are fields, a field's value as the file holds it, and writing one (`setField`; a checked radio unchecks its group).
  - **The served page**: `served-page.mjs`. `tabStateOf`: what a tab keeps of the page besides its HTML (directives, threads, bases), through the step port. `injectClient`: the client and its data, notices among them, added to the served copy.
  - **Revisions**: `revision.mjs`, through the step port. `revise`: one PUT change, from the file's text to a conflict (base or spill for content, replies since for a directive, an element gone with nowhere to land), a refusal, or the text to write; a directive on an element that is gone lands on its nearest ancestor. `landed`: a directive as the file holds it, what a box session keeps. `answerOf`: the answer, after the write. `reviseThread`: the same for a reply. `readRevision`: the file's text as a document with IDs.
  - **The agent's change**: `agent-change.mjs`, through the step port. `readScope`, and `reviseByAgent`: a replace, add, remove, or move, from the file's text to a conflict, a refusal, or the text to write and `{ok, id, version, ids}`. Threads stay through it: `pinTurns` and `repinTurns` in `directives.mjs` put each turn back on its element, or on the element that holds it now.
  - **Catching up**: `catch-up.mjs`. `catchUp`: the swaps a tab needs, from the page it shows to the page now.
  - **Cleanup**: `cleanup.mjs`. Parse, remove directives and element IDs, serialize (see [Clean up](#clean-up)).
- **Scopes**: `domain/scopes.mjs`, `domain/to-markdown.mjs`, `domain/from-markdown.mjs`. A scope is what you pick to direct or edit: any block, plus links and images; its whole content edits as markdown, if it's under 4 KB of HTML. `scopes.mjs` has `scopeElements` (which elements get IDs) and `editable` (which scopes edit as markdown); `to-markdown.mjs` has `scopeMarkdown` (a scope as markdown); `from-markdown.mjs` has `nodesFromMarkdown` (the HTML its markdown saves as). They know nothing of IDs or directives; `scopeFromMarkdown` in `markdown-edits.mjs` adds them. Saving a scope's markdown unchanged gives back the same HTML, element IDs included; saving it edited, each element you left, moved, or changed keeps its ID and its directives, and a new one gets none. A directive on an element the edit deleted goes with it. The `test/roundtrip-*.test.mjs` files check both on every page here and on generated ones. What markdown can't say comes out as HTML, and what isn't text (an svg, a script) rides along as a stand-in, `⟦svg⟧`; on save, each stand-in goes back to the original whose surroundings are most like its own. A link edits as `[text](href "title")`, and on save takes its other attributes (class, target, rel) back from the original it pairs with: same href and text, then same href, then same text. A link or image written as HTML keeps what it says; the `hrv-md` mark tells the two kinds apart while the save is built, and never reaches the file. `node scopes.mjs --annotate SCOPES-DESIGN.html` writes each case's HTML, scopes, and markdown under it in [SCOPES-DESIGN.html#scopes](SCOPES-DESIGN.html#scopes).
- **Tier III, interface**: `interface/`, the gateways to the world, and `vendor/`. Only these modules import `node:fs` or `node:child_process`. `files.mjs` is the filesystem gateway: reads, writes, directory listings, watching a file (`watchFile`), the file at the last commit, and the client assets injected into served pages: `client.css` and `client.js`, read on each GET, so a change shows on reload without a restart. `http.mjs`: request paths (under the root, 403 on escape), bodies, content types (so a page's own CSS and images load), what a GET wants by its `Accept` (`wants`), answers (404 for a missing file; for any other error, a plain-text 500 with the message, and its stack on stderr), event streams (`openEventStream`), the directory listing page, the query (`queryOf`), and `putJson` and `getJson`, the client side that `reply.mjs` and `change.mjs` call the server with. `stdout.mjs`: Announcements. `telemetry.mjs`: the OTel API, always loaded and a no-op until the SDK registers, which it loads only with `HRV_TELEMETRY` (see [Telemetry](#telemetry)); `inSpan`, and `step`, the adapter for the domain's step port.
- **Markdown edits**: GET serves the markdown of every scope under 4 KB in `#hrv-markdown`, for the box. A PUT with `markdown` replaces the scope with what `scopeFromMarkdown` builds, which reconciles: elements you left or changed keep their IDs and directives. An element that isn't a scope (`hr`, an SVG shape), a scope of 4 KB or more, `body`, and blank markdown get 400. A scope a save grows past 4 KB comes back in the answer's `markdowns` as null, and its Content field goes. The tab doesn't render markdown: it swaps in the `html` the answer carries. When the file splits what a save made, as a typed `<p>` splits a paragraph, the answer's `spill` names the other elements it made; the box's next save sends it back, and the server replaces the scope and its spill together (a spill ID that isn't a sibling of the scope is 412). `test/spill.test.mjs` covers it.
- **Files it serves**: agent-generated documents whose generation we control. The tool may require things of them, limit what they contain, and rewrite them on disk. When a file shape causes trouble, normalize it into a shape the tool handles rather than supporting every HTML a browser accepts. If a requirement can't be met by normalizing, add it to the agent instructions above.
- **What the served page carries**: no directives as HTML comments; they come as data, in JSON scripts with `<` written `<`. `#hrv-directives` holds each element's directive, with the file's hash as its `data-version`. The page also carries every element's base in `#hrv-bases`, every scope's markdown in `#hrv-markdown`, and every scope's markdown at the file's last commit in `#hrv-committed`, for Revert. The server reads that with `git show HEAD:` and normalizes it, so a commit without IDs gets the numbers the page got when first opened.
- **Non-goals**: more than one user, auth, or remote access (the server listens on 127.0.0.1); history or undo beyond git, Revert, and the box's ⌘Z; edits that keep the source's layout, since the formatter owns it.

## Gotchas for maintainers

- linkedom doesn't create a missing `<html>`/`<head>`/`<body>`. It makes the first element the root, and reading `document.head` or `document.body` silently creates empty ones inside that root. Go through `parse()` in `domain/canonical.mjs`, never `parseHTML` directly.
- Everything in `vendor/` is a generated bundle. Don't edit it. After changing a version, run `npm run vendor`.
- GET normalizes the file in place. To try the server by hand, serve a temp copy of `test/fixtures`, not the directory itself.
