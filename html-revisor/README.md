# html-notes

Review agent-generated HTML in a browser and leave directives on specific elements. Directives are saved in the HTML file itself as `<!-- @AI: ... -->` HTML comments. Nothing lives in the browser or a sidecar file.

You can also fix wording directly. When the clicked element holds only text (no child elements), the box shows a Text field above the directive. Edits show on the page as you type and are written into the file.

This repo is where html-notes is developed. Its built output ships inside the [iterate-on-docs](https://github.com/jessitron/iterate-on-docs) plugin, vendored at `iterate-on-docs/html-with-comments/`. Make changes here, not in that copy.

## Run

```
./run [rootDir] [--port 7777] [--author @AI]
```

- `rootDir` defaults to the directory you run it from.
- `--author` sets the directive prefix (default `@AI`).
- The server prints a URL on startup. Open an `.html` file under it.
- First load normalizes the file's formatting and rewrites it on disk. It also adds `<html>`, `<head>` and `<body>` if the file lacks them, the way a browser would. These files are agent-generated documents we control, so the tool rewrites them into the shape it needs.

Needs Node 20 or later. No `npm install`: the one dependency, linkedom, is bundled into `vendor/linkedom.mjs`.

Tests: `npm test`.

## Try it

`try-me.html` is a sample page for testing by hand. Run `./run` in this directory and open `http://localhost:7777/try-me.html`. It holds one of each case the client handles: text-only elements (Text field plus directive), a paragraph with inline markup (directive only), entities, a link, a list, a table, `hr` and `pre` (directives sit beside them), and a wrapper card.

Your directives and text edits write into the file, so it shows as changed in git. `git checkout try-me.html` resets it. It is committed in normalized form, so loading it does not change it.

## Deploy

```
./deploy [iterate-on-docs dir]
```

Copies the committed files at HEAD into `<dir>/html-with-comments/` (default `~/code/jessitron/iterate-on-docs`), runs the tests there, and commits there. It writes nothing else in iterate-on-docs, and it doesn't push. Users get the change when iterate-on-docs runs `./release`.

- It refuses when this repo has uncommitted changes (except `try-me.html`), when HEAD is not on main, or when the copy has uncommitted changes.
- It replaces the whole directory, leaving out dev-only files: `CLAUDE.md`, `OVERVIEW.html`, `PLAN.html`, `.gitignore`, `deploy`. It writes `VENDORED.md` with the commit hash.
- If the tests fail in the copy, it restores the directory and commits nothing.

## Contract with iterate-on-docs

The iterate-on-a-document skill and the README in iterate-on-docs run and describe this tool. They rely on:

| What | Value |
| --- | --- |
| Server path | `../../html-with-comments/server.mjs`, from the skill's base directory |
| Runtime | Node 20 or later. No `npm install`: the output runs as copied, linkedom is in `vendor/` |
| CLI | `node <server> <dir> --port 0` |
| Default author | `@AI` (the skill passes no `--author`) |
| Startup line | `html-notes: http://localhost:<port>/ serving <dir>` |
| Page URL | the startup address plus the file's path under `<dir>` |
| Directive syntax | `<!-- @AI: … -->`, first child of its element, or just before a void or raw-text element (full list under [Directive format](#directive-format)) |
| Finding directives | `grep '<!-- *@AI:'` |
| GET rewrites the file | the skill fetches the page before each commit |
| Browser behavior | click any element to leave a directive on it or change its wording; both save into the file as you type |
| README | this README ships in the output and keeps its "Directive format" section; iterate-on-docs links to it |
| Vocabulary | the words the user sees: **directive** (the popup says "Directive", "Directive for this element", "Delete the directive", and the toast "saved · N directives"). Not note, comment or annotation |

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
```

## Manual client checklist

Each served page carries a version (a hash of the file on disk), and every save sends it back. If the file changed since the page loaded, the server answers 409 and the client stops saving and shows a lasting warning, so a stale tab cannot resurrect deleted directives or misplace directives on shifted elements.

Open `try-me.html` in a browser (see [Try it](#try-it)).

- [ ] Hovering an element shows a dashed outline and a copy cursor; `html` and `body` show none.
- [ ] Clicking an element opens a directive box below its top edge, with focus in the textarea.
- [ ] A marker appears as soon as you type.
- [ ] A text-only element (`<p>First paragraph</p>`, `<b>bold</b>`) shows a Text field above the directive; an element with child elements (`<p>Second <b>bold</b> paragraph</p>`) shows only the directive.
- [ ] Typing in the Text field changes the page at once and the file within about half a second. Blanking it changes nothing.
- [ ] The file on disk updates within about half a second; the toast says `saved · N directives`.
- [ ] Reloading the page shows the marker; the element has a left accent.
- [ ] Clicking a marker opens its box for editing.
- [ ] Delete (or emptying the text) removes the directive and the marker.
- [ ] `⌘↵`, `Esc`, Save, and clicking outside each commit and close the box. (On a page with a full-width wrapper element, clicking the margin opens a box on the wrapper instead; use Esc.)
- [ ] Opening a second box commits and closes the first.
- [ ] Plain click on a link opens a directive box; ⌘-click on a link navigates.
- [ ] The page's own layout and styles look the same with the UI loaded.
- [ ] Stopping the server and typing shows `save failed: ...`; restarting and typing again saves.
- [ ] Edit the file on disk while the tab is open, then type: the toast warns that the file changed, the file stays untouched, and the box keeps your text.
- [ ] Dark mode gives the box a dark theme.

## Design

Everything is in `server.mjs`, in three tiers. Dependencies point down.

The HTML parser is [linkedom](https://github.com/WebReflection/linkedom), bundled with its dependencies into `vendor/linkedom.mjs` (licenses in `vendor/linkedom.LICENSES.txt`) so the tool runs where `npm install` can't, such as behind a corporate proxy. To upgrade it: change the version in `package.json`'s devDependencies, then `npm install && npm run vendor`, and commit `vendor/`.

- **Tier I, orchestration**: CLI arguments, the HTTP request handler, and the GET and PUT flows (normalize, stamp, collect or inject; read, strip directives, place directives, write). The PUT body is `{"directives": {"<id>": "text"}, "texts": {"<id>": "text"}, "version": "..."}`.
- **Tier II, domain**: pure functions. The formatter (`normalize`), the directives language (`collectDirectives`, `removeDirectives`, `placeDirective`, escaping), text edits (`isTextElement`, `setText`), and element identity (`stamp`, `unstamp`: `data-n` is the element's document-order index).
- **Tier III, interface**: the filesystem gateway (paths under the root, 403 on escape), content types, directory listing, and the client assets (`CLIENT_CSS`, `CLIENT_JS`) injected into served pages.
- **Text edits**: PUT also carries `texts`, `{"<id>": "new text"}`, holding every element the tab has edited. Resending is harmless. The server replaces the text only of elements that hold nothing but text (after directives are lifted out) and ignores blank text, so no markup is lost.
- **Files it serves**: agent-generated documents whose generation we control. The tool may require things of them, limit what they contain, and rewrite them on disk. When a file shape causes trouble, normalize it into a shape the tool handles rather than supporting every HTML a browser accepts. If a requirement can't be met by normalizing, add it to the agent instructions above.
- **Deviation from the spec**: PUT carries an optional `version` (hash of the file bytes, from `data-version` on the `#hn-directives` script); a mismatch gets 409 and no write. A PUT without `version` skips the check.

## Gotchas for maintainers

- linkedom doesn't create a missing `<html>`/`<head>`/`<body>`. It makes the first element the root, and reading `document.head` or `document.body` silently creates empty ones inside that root. Go through `parse()`, never `parseHTML` directly.
- `vendor/linkedom.mjs` is a generated bundle. Don't edit it. After changing the linkedom version, run `npm run vendor`.
- GET normalizes the file in place. To try the server by hand, serve a temp copy of `test/fixtures`, not the directory itself.
