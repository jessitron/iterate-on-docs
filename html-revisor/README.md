# html-revisor

Review agent-generated HTML in a browser and leave directives on specific elements. Directives are saved in the HTML file itself as `<!-- @AI: ... -->` HTML comments. Nothing lives in the browser or a sidecar file.

You can also edit the page directly. Click any block (a paragraph, a list, one item, a section, a table cell), a link, an image, or a span: the box shows its content as markdown in a Content field above the directive. Typing saves into the file, and the page shows the result when the save answers. Elements you left or changed keep their IDs and directives.

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

Needs Node 20 or later. No `npm install`: the two dependencies, linkedom and markdown-it, are bundled into `vendor/`.

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
| Directive syntax | `<!-- @AI: … -->`, first child of its element, or just before a void or raw-text element (full list under [Directive format](#directive-format)) |
| Finding directives | `grep '<!-- *@AI:'` |
| Formatter CLI | `node ../../html-revisor/formatter.mjs <file>...`, from the skill's base directory. Rewrites each file in place into the same canonical form a page load gives. Silent and exit 0 on success; exit 1 with `<file>: <problem>` on stderr when a file can't be read or written or breaks a rule the formatter can't fix (it still writes the fixable part); exit 2 with usage when given no files |
| Cleanup CLI | `node ../../html-revisor/cleanup.mjs <file>...`, from the skill's base directory, when the user says "good enough". Rewrites each file in place without directives (`<!-- @AI: … -->`) or element IDs, formatting kept. Prints each directive it removed on stdout as `<file>: <text>`, newlines as spaces. Exit 0 on success; exit 1 with `<file>: <problem>` on stderr when a file can't be read or written; exit 2 with usage when given no files |
| Loading a page reformats its file | each GET rewrites the file on disk into canonical formatting, with element IDs. The skill runs the formatter CLI before each commit, so the reformat lands in the agent's commit and doesn't show up as the user's next edit |
| Element IDs | the formatter (GET, PUT, and the formatter CLI) writes `data-hrv="<n>"` on each element you can pick and `data-hrv-next="<n>"` on `<html>`. Agents leave both alone: don't change, copy, or remove them. A new element needs none; the next format gives it one |
| Browser behavior | click a block, link, image, or part of an SVG to leave a directive on it or change its wording; both save into the file as you type. If the element changed on disk since the page loaded, the save is refused with an error that suggests a reload; a change elsewhere in the file only brings a notice |
| Bug reports | issues go to `https://github.com/jessitron/html-revisor/issues`. `VENDORED.md` in the copy names the deployed commit, for the report |
| README | this README ships in the output and keeps its "Directive format" section; iterate-on-docs links to it |
| Vocabulary | the words the user sees: **directive** (the directive box says "Directive", "Directive for this element", "Delete the directive (⌥⌘⌫)"; the docket says "N directives" (or "1 directive"), "Previous directive", "Next directive", and "N directives · review off"). The box's buttons are **Done** and **Delete**; its footer says "⌘↵ or esc to close", or the save status "saving…", "saved", "not saved". Typing saves; Done closes the box. Not note, comment or annotation |

If you find a mismatch, the Contract wins.

A change to anything in this table is a contract change. It travels out of band, not through deploy: the agent changing it here searches iterate-on-docs' `skills/` directory and `README.md` for the old value and updates every match, in their own commit there, along with the deploy. deploy stays a plain copy. This list stands in for a changelog: these are the only changes iterate-on-docs has to hear about.

## Directive format

A directive is an HTML comment whose text starts with `<author>:`.

```html
<!-- @AI: this section is out of date -->
```

- HTML comments without the prefix are not directives. The server leaves them alone.
- The directive text is everything after the prefix. Multi-line text is fine.
- On write, `--` becomes `- -` and `>` becomes `&gt;` so the text cannot end the HTML comment early.

Placement: a directive attaches to exactly one element.

- On a normal element, the directive is its **first child**.
- On an element that can't hold an HTML comment inside, the directive sits **immediately before** the element as a sibling. Those are the void elements (`area`, `base`, `br`, `col`, `embed`, `hr`, `img`, `input`, `link`, `meta`, `param`, `source`, `track`, `wbr`), the raw-text elements (`pre`, `textarea`, `script`, `style`, `template`), and `title`, `iframe`, `xmp`, `noembed`, `noframes`.
- A hand-written directive placed in `<body>` between blocks attaches to `<body>` and moves to the top of `<body>` on the next save.

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
- [ ] Every block, link, image, and span shows a Content field above the directive, holding its markdown in monospace: a paragraph with bold shows `**bold**`, a list its `-` lines. Clicking `<b>bold</b>` picks its paragraph: `strong`, `b` and the like are not scopes. An `hr` or an SVG shape shows only the directive.
- [ ] Typing in the Content field changes the file within about half a second, and the page when the save answers. Blanking it changes nothing.
- [ ] Put a directive on one list item, then edit the list's markdown: add a word to that item and a new item beside it. The item keeps its marker; the new one has none.
- [ ] Type a list's markdown into one sentence: the list becomes a paragraph, the box stays open on it, and the list's own directive moves to it.
- [ ] Both fields grow as you type more lines, up to about 240px, then scroll.
- [ ] The file on disk updates within about half a second. The box's footer says `saving…`, then `saved`, then the hint returns.
- [ ] The docket at the bottom right counts the directives (`N directives`) and changes as you add or delete one.
- [ ] The docket's ↑ and ↓, and ⌥↑ and ⌥↓ outside a text field, scroll each directive's element to the middle of the window in document order, wrapping at the ends, show its crop marks for a moment, and show its marker's tip until the next click.
- [ ] Clicking the docket's icon or count turns review mode off (`· review off`): markers hide, hovering shows no marks and no copy cursor, and clicks go to the page. Clicking again turns it back on.
- [ ] Reloading the page shows the marker. The element itself is not restyled.
- [ ] Clicking a marker opens its box for editing.
- [ ] Delete (or emptying the text, or `⌥⌘⌫` in the box) removes the directive and the marker. Delete's tooltip names the hotkey.
- [ ] `⌘↵`, `Esc`, Done, and clicking outside each commit and close the box. (On a page with a full-width wrapper element, clicking the margin opens a box on the wrapper instead; use Esc.)
- [ ] Opening a second box commits and closes the first.
- [ ] Plain click on a link opens a directive box; ⌘-click on a link navigates.
- [ ] The page's own layout and styles look the same with the UI loaded, including while hovering: a card keeps its own box-shadow.
- [ ] Stopping the server and typing shows `save failed: ...` on the docket; restarting and typing again saves and clears it.
- [ ] Edit one element in the file on disk while the tab is open, then type a directive on that element: the docket says it wasn't saved and suggests a reload, the box's footer says `not saved`, the file stays untouched, and the box keeps your text.
- [ ] Edit a different element on disk, then type a directive: it saves, and the docket says the page changed on disk.
- [ ] In dark mode the box, markers and docket look the same as in light mode: one material.

## Design

The code is in `server.mjs` and `formatter.mjs`, in three tiers, plus `client.css` and `client.js`, which the server inlines into each page. Dependencies point down: `server.mjs` imports `formatter.mjs`, and `formatter.mjs` imports nothing from `server.mjs`. How the UI looks, and the design decisions so far, are in [DESIGN.html](DESIGN.html); it links `client.css`, so it shows the real styles. How editing as markdown behaves, and its design decisions, are in [SCOPES-DESIGN.html](SCOPES-DESIGN.html#decided); how elements keep their IDs across a save is in [its identity table](SCOPES-DESIGN.html#identity).

The HTML parser is [linkedom](https://github.com/WebReflection/linkedom), bundled with its dependencies into `vendor/linkedom.mjs` (licenses in `vendor/linkedom.LICENSES.txt`) so the tool runs where `npm install` can't, such as behind a corporate proxy. The markdown parser is [markdown-it](https://github.com/markdown-it/markdown-it), bundled the same way into `vendor/markdown-it.mjs`. The HTML-to-markdown writer is our own, in `scopes.mjs`. To upgrade either: change the version in `package.json`'s devDependencies, then `npm install && npm run vendor`, and commit `vendor/`.

- **Tier I, orchestration**: CLI arguments, the HTTP request handler, and the GET and PUT flows (format with IDs, lift directives, compute bases, inject; read, assign IDs, check the base, apply the one change, write). The PUT body is one change: `{"id": "<id>", "base": "<base>", "directive": "text"}` (empty text removes the directive) or `{"id": "<id>", "base": "<base>", "markdown": "…"}`. The answer is `{"ok": true, "count", "bases": {"<id>": "<base>"}, "before", "after"}`: new bases for the element, its ancestors, and the IDs inside it, and the file's hash before and after the save. A markdown save's answer adds `html` (what replaced the scope, as served), `id` (the ID that holds the scope now), and `markdowns` (the new markdown of the scopes around it). A base that doesn't match, or an ID that isn't in the file, gets 412 and `{"ok": false, "error"}`.
- **Formatter**: `formatter.mjs`. Its Tier II is `parse` (adds a missing skeleton and rewrites into canonical forms: `b`→`strong`, `i`→`em`, table rows in `thead`/`tbody`), `assignIds` (element IDs), `serialize` (canonical layout), `normalize` (all three), and `validate`, the rules normalizing can't fix (none yet). Its Tier I is a CLI, `node formatter.mjs <file>...` (see the [Contract](#contract-with-iterate-on-docs)). It takes the rule for which elements are scopes from `scopes.mjs`.
- **Cleanup**: `cleanup.mjs`. Tier II is `cleanup`: parse, remove directives and element IDs, serialize. Tier I is its CLI (see [Clean up](#clean-up)).
- **Scopes**: `scopes.mjs`. A scope is what you pick to direct or edit: any block, plus links and images; its whole content edits as markdown. Tier II is `scopeElements` (which elements get IDs), `scopesWithin`, `scopeMarkdown` (a scope as markdown), and `scopeFromMarkdown` (the HTML its markdown saves as). Saving a scope's markdown unchanged gives back the same HTML, element IDs included; saving it edited, each element you left, moved, or changed keeps its ID and its directives, and a new one gets none. A directive on an element the edit deleted goes with it. `test/roundtrip.test.mjs` checks both on every page here and on generated ones. What markdown can't say comes out as HTML, and what isn't text (an svg, a script) rides along as a stand-in, `⟦svg⟧`. `node scopes.mjs --annotate SCOPES-DESIGN.html` writes each case's HTML, scopes, and markdown under it in [SCOPES-DESIGN.html#scopes](SCOPES-DESIGN.html#scopes).
- **Tier II, domain**: pure functions. The formatter (imported from `formatter.mjs`), the directives language in `directives.mjs` (`collectDirectives`, `removeDirectives`, `placeDirective`, the placement rule, escaping), markdown edits (`markdownsOf`, `saveMarkdown`, `servedHTML`), and element identity: `elementById`, and `baseOf`, the hash of an element in canonical layout with directives and IDs stripped. A directive coming or going changes no base; a changed child changes its parent's. The IDs themselves come from the formatter's `assignIds`: `data-hrv` from a counter, never changed, never reused, and copies of one ID all get fresh ones.
- **Tier III, interface**: the filesystem gateway (paths under the root, 403 on escape), content types, directory listing, and the client assets injected into served pages: `client.css` and `client.js`, read on each GET, so a change shows on reload without a restart.
- **Markdown edits**: GET serves every scope's markdown in `#hrv-markdown`, for the box. A PUT with `markdown` replaces the scope with what `scopeFromMarkdown` builds, which reconciles: elements you left or changed keep their IDs and directives. An element that isn't a scope (`hr`, an SVG shape), `body`, and blank markdown get 400. The tab doesn't render markdown: it swaps in the `html` the answer carries.
- **Files it serves**: agent-generated documents whose generation we control. The tool may require things of them, limit what they contain, and rewrite them on disk. When a file shape causes trouble, normalize it into a shape the tool handles rather than supporting every HTML a browser accepts. If a requirement can't be met by normalizing, add it to the agent instructions above.
- **Deviation from the spec**: element IDs live in the file, and a PUT carries one change with its base instead of the whole set of directives. The served page carries the file's hash as `data-version` on the `#hrv-directives` script, every element's base in `#hrv-bases`, and every scope's markdown in `#hrv-markdown`.

## Gotchas for maintainers

- linkedom doesn't create a missing `<html>`/`<head>`/`<body>`. It makes the first element the root, and reading `document.head` or `document.body` silently creates empty ones inside that root. Go through `parse()` in `formatter.mjs`, never `parseHTML` directly.
- `vendor/linkedom.mjs` and `vendor/markdown-it.mjs` are generated bundles. Don't edit them. After changing either version, run `npm run vendor`.
- GET normalizes the file in place. To try the server by hand, serve a temp copy of `test/fixtures`, not the directory itself.
