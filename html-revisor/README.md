# html-revisor

Review agent-generated HTML in a browser and leave directives on specific elements. Directives are saved in the HTML file itself as `<!-- @AI: ... -->` HTML comments. Nothing lives in the browser or a sidecar file.

You can also fix wording directly. When the clicked element holds only text (no child elements), the box shows a Text field above the directive. Edits show on the page as you type and are written into the file.

This repo is where html-revisor is developed. Its built output ships inside the [iterate-on-docs](https://github.com/jessitron/iterate-on-docs) plugin, vendored at `iterate-on-docs/html-revisor/`. Make changes here, not in that copy.

## Run

```
./run [rootDir] [--port 7777] [--author @AI]
```

- `rootDir` defaults to the directory you run it from.
- `--author` sets the directive prefix (default `@AI`).
- The server prints a URL on startup. Open an `.html` file under it.
- First load normalizes the file's formatting and rewrites it on disk. It also adds `<html>`, `<head>` and `<body>` if the file lacks them, the way a browser would. These files are agent-generated documents we control, so the tool rewrites them into the shape it needs.
- Loading also writes an element ID, `data-hrv="<n>"`, on each element you can pick, and the next unused number on `<html data-hrv-next="<n>">`. The first load of a page makes one noisy diff; after that a diff shows only new IDs.

Needs Node 20 or later. No `npm install`: the one dependency, linkedom, is bundled into `vendor/linkedom.mjs`.

Tests: `npm test`.

## Try it

`try-me.html` is a sample page for testing by hand. Run `./run` in this directory and open `http://localhost:7777/try-me.html`. It holds one of each case the client handles: text-only elements (Text field plus directive), a paragraph with inline markup (directive only), entities, a link, a list, a table, `hr` and `pre` (directives sit beside them), and a wrapper card.

Your directives and text edits write into the file, so it shows as changed in git. `git checkout try-me.html` resets it. It is committed in normalized form, so loading it does not change it.

## Deploy

```
./deploy [iterate-on-docs dir]
```

Copies the committed files at HEAD into `<dir>/html-revisor/` (default `~/code/jessitron/iterate-on-docs`), runs the tests there, and commits there. It writes nothing else in iterate-on-docs, and it doesn't push. Users get the change when iterate-on-docs runs `./release`.

- It refuses when this repo has uncommitted changes (except `try-me.html`), when HEAD is not on main, or when the copy has uncommitted changes.
- It replaces the whole directory, leaving out dev-only files: `CLAUDE.md`, `OVERVIEW.html`, `PLAN.html`, `DESIGN.html`, `.gitignore`, `.claude/`, `deploy`. It writes `VENDORED.md` with the commit hash.
- If the tests fail in the copy, it restores the directory and commits nothing.

## Contract with iterate-on-docs

The iterate-on-a-document skill and the README in iterate-on-docs run and describe this tool. They rely on:

| What | Value |
| --- | --- |
| Server path | `../../html-revisor/server.mjs`, from the skill's base directory |
| Runtime | Node 20 or later. No `npm install`: the output runs as copied, linkedom is in `vendor/` |
| CLI | `node <server> <dir> --port 0` |
| Default author | `@AI` (the skill passes no `--author`) |
| Startup line | `html-revisor: http://localhost:<port>/ serving <dir>` |
| Page URL | the startup address plus the file's path under `<dir>` |
| Directive syntax | `<!-- @AI: … -->`, first child of its element, or just before a void or raw-text element (full list under [Directive format](#directive-format)) |
| Finding directives | `grep '<!-- *@AI:'` |
| Formatter CLI | `node ../../html-revisor/formatter.mjs <file>...`, from the skill's base directory. Rewrites each file in place into the same canonical form a page load gives. Silent and exit 0 on success; exit 1 with `<file>: <problem>` on stderr when a file can't be read or written or breaks a rule the formatter can't fix (it still writes the fixable part); exit 2 with usage when given no files |
| Loading a page reformats its file | each GET rewrites the file on disk into canonical formatting, with element IDs. The skill fetches the page before each commit, so the reformat lands in the agent's commit and doesn't show up as the user's next edit |
| Element IDs | the formatter (GET, PUT, and the formatter CLI) writes `data-hrv="<n>"` on each element you can pick and `data-hrv-next="<n>"` on `<html>`. Agents leave both alone: don't change, copy, or remove them. A new element needs none; the next format gives it one |
| Browser behavior | click a block, link, image, or part of an SVG to leave a directive on it or change its wording; both save into the file as you type. If the element changed on disk since the page loaded, the save is refused with an error that suggests a reload; a change elsewhere in the file only brings a notice |
| README | this README ships in the output and keeps its "Directive format" section; iterate-on-docs links to it |
| Vocabulary | the words the user sees: **directive** (the directive box says "Directive", "Directive for this element", "Delete the directive", and the toast "saved · N directives"). Not note, comment or annotation |

If you find a mismatch, the Contract wins.

A change to anything in this table is a contract change. It travels out of band, not through deploy: the agent changing it here makes the matching edits in iterate-on-docs (`skills/iterate-on-a-document/SKILL.md`, `README.md`, any other skill that relies on it), in their own commit there, along with the deploy. deploy stays a plain copy. This list stands in for a changelog: these are the only changes iterate-on-docs has to hear about.

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

Open `try-me.html` in a browser (see [Try it](#try-it)).

- [ ] Hovering an element shows crop marks just outside its corners and a copy cursor; `html` and `body` show none. Try an SVG label and an SVG shape too.
- [ ] Clicking an element opens a directive box below its top edge, with focus in the textarea. While the box is open, the element has heavier crop marks and a hairline outline.
- [ ] A marker appears as soon as you type.
- [ ] A text-only element (`<p>First paragraph</p>`) shows a Text field above the directive; an element with child elements (`<p>Second <b>bold</b> paragraph</p>`) shows only the directive. Clicking `<b>bold</b>` picks its paragraph: `strong`, `b` and the like are not scopes.
- [ ] Typing in the Text field changes the page at once and the file within about half a second. Blanking it changes nothing.
- [ ] The file on disk updates within about half a second; the toast says `saved · N directives`.
- [ ] Reloading the page shows the marker. The element itself is not restyled: no stripe, no outline.
- [ ] Clicking a marker opens its box for editing.
- [ ] Delete (or emptying the text) removes the directive and the marker.
- [ ] `⌘↵`, `Esc`, Save, and clicking outside each commit and close the box. (On a page with a full-width wrapper element, clicking the margin opens a box on the wrapper instead; use Esc.)
- [ ] Opening a second box commits and closes the first.
- [ ] Plain click on a link opens a directive box; ⌘-click on a link navigates.
- [ ] The page's own layout and styles look the same with the UI loaded, including while hovering: a card keeps its own box-shadow.
- [ ] Stopping the server and typing shows `save failed: ...`; restarting and typing again saves.
- [ ] Edit one element in the file on disk while the tab is open, then type a directive on that element: the toast says it wasn't saved and suggests a reload, and the file stays untouched.
- [ ] Edit a different element on disk, then type a directive: it saves, and the toast adds that the page changed on disk.
- [ ] Dark mode gives the box a dark theme.

## Design

The code is in `server.mjs` and `formatter.mjs`, in three tiers, plus `client.css`. Dependencies point down: `server.mjs` imports `formatter.mjs`, and `formatter.mjs` imports nothing from `server.mjs`. How the UI looks, and the design decisions so far, are in [DESIGN.html](DESIGN.html); it links `client.css`, so it shows the real styles.

The HTML parser is [linkedom](https://github.com/WebReflection/linkedom), bundled with its dependencies into `vendor/linkedom.mjs` (licenses in `vendor/linkedom.LICENSES.txt`) so the tool runs where `npm install` can't, such as behind a corporate proxy. To upgrade it: change the version in `package.json`'s devDependencies, then `npm install && npm run vendor`, and commit `vendor/`.

- **Tier I, orchestration**: CLI arguments, the HTTP request handler, and the GET and PUT flows (format with IDs, lift directives, compute bases, inject; read, assign IDs, check the base, apply the one change, write). The PUT body is one change: `{"id": "<id>", "base": "<base>", "directive": "text"}` (empty text removes the directive) or `{"id": "<id>", "base": "<base>", "text": "new text"}`. The answer is `{"ok": true, "count", "bases": {"<id>": "<base>"}, "before", "after"}`: new bases for the element, its ancestors, and the IDs inside it, and the file's hash before and after the save. A base that doesn't match, or an ID that isn't in the file, gets 412 and `{"ok": false, "error"}`.
- **Formatter**: `formatter.mjs`. Its Tier II is `parse` (adds a missing skeleton), `assignIds` (element IDs), `serialize` (canonical layout), `normalize` (all three), and `validate`, the rules normalizing can't fix (none yet). Its Tier I is a CLI, `node formatter.mjs <file>...` (see the [Contract](#contract-with-iterate-on-docs)). It takes the rule for which elements are scopes from `scopes.mjs`.
- **Scopes**: `scopes.mjs`. A scope is what you pick to direct or edit: any block, plus links and images; its whole content edits as markdown. Tier II is `scopeElements` (which elements get IDs), `scopesWithin` and `scopeMarkdown`, a first pass at the markdown; the server doesn't edit markdown yet. `node scopes.mjs --annotate try-me.html` writes each case's HTML, scopes, and markdown under it in [try-me.html#scopes](try-me.html#scopes). Markdown editing of scopes is PLAN.html stage 3.
- **Tier II, domain**: pure functions. The formatter (imported from `formatter.mjs`), the directives language (`collectDirectives`, `removeDirectives`, `placeDirective`, escaping), text edits (`isTextElement`, `setText`), and element identity: `elementById`, and `baseOf`, the hash of an element in canonical layout with directives and IDs stripped. A directive coming or going changes no base; a changed child changes its parent's. The IDs themselves come from the formatter's `assignIds`: `data-hrv` from a counter, never changed, never reused, and copies of one ID all get fresh ones.
- **Tier III, interface**: the filesystem gateway (paths under the root, 403 on escape), content types, directory listing, and the client assets injected into served pages: `client.css`, read on each GET, and `CLIENT_JS`.
- **Text edits**: a PUT with `text` replaces the text of an element that holds nothing but text (directives aside, and they stay). Other elements and blank text get 400, so no markup is lost.
- **Files it serves**: agent-generated documents whose generation we control. The tool may require things of them, limit what they contain, and rewrite them on disk. When a file shape causes trouble, normalize it into a shape the tool handles rather than supporting every HTML a browser accepts. If a requirement can't be met by normalizing, add it to the agent instructions above.
- **Deviation from the spec**: element IDs live in the file, and a PUT carries one change with its base instead of the whole set of directives. The served page carries the file's hash as `data-version` on the `#hrv-directives` script, and every element's base in `#hrv-bases`.

## Gotchas for maintainers

- linkedom doesn't create a missing `<html>`/`<head>`/`<body>`. It makes the first element the root, and reading `document.head` or `document.body` silently creates empty ones inside that root. Go through `parse()` in `formatter.mjs`, never `parseHTML` directly.
- `vendor/linkedom.mjs` is a generated bundle. Don't edit it. After changing the linkedom version, run `npm run vendor`.
- GET normalizes the file in place. To try the server by hand, serve a temp copy of `test/fixtures`, not the directory itself.
