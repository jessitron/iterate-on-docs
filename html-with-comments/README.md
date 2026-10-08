# html-notes

Review agent-generated HTML in a browser and leave comments on specific elements. Comments are saved in the HTML file itself as `<!-- @AI: ... -->` comments. Nothing lives in the browser or a sidecar file.

You can also fix wording directly. When the clicked element holds only text (no child elements), the box shows a Text field above the comment. Edits show on the page as you type and are written into the file.

## Run

```
./run [rootDir] [--port 7777] [--author @AI]
```

- `rootDir` defaults to the directory you run it from.
- `--author` sets the comment prefix (default `@AI`).
- The server prints a URL on startup. Open an `.html` file under it.
- First load normalizes the file's formatting and rewrites it on disk. It also adds `<html>`, `<head>` and `<body>` if the file lacks them, the way a browser would. These files are agent-generated documents we control, so the tool rewrites them into the shape it needs.

Needs Node 20 or later. No `npm install`: the one dependency, linkedom, is bundled into `vendor/linkedom.mjs`.

Tests: `npm test`.

## Try it

`try-me.html` is a sample page for testing by hand. Run `./run` in this directory and open `http://localhost:7777/try-me.html`. It holds one of each case the client handles: text-only elements (Text field plus comment), a paragraph with inline markup (comment only), entities, a link, a list, a table, `hr` and `pre` (notes sit beside them), and a wrapper card.

Your comments and text edits write into the file, so it shows as changed in git. `git checkout try-me.html` resets it. It is committed in normalized form, so loading it does not change it.

## Comment format

A comment is an HTML comment whose text starts with `<author>:`.

```html
<!-- @AI: this section is out of date -->
```

- Comments without the prefix are not notes. The server leaves them alone.
- The note text is everything after the prefix. Multi-line text is fine.
- On write, `--` becomes `- -` and `>` becomes `&gt;` so the text cannot end the comment early.

Placement: a note attaches to exactly one element.

- On a normal element, the comment is its **first child**.
- On a void element (`img`, `hr`, `br`, `input`, ...) or a raw-text element (`pre`, `textarea`, `script`, `style`), the comment sits **immediately before** the element as a sibling.
- A hand-written note placed in `<body>` between blocks attaches to `<body>` and moves to the top of `<body>` on the next save.

## Agent instructions

Paste this into the agent's instructions:

```
HTML files in this project may hold review comments written as HTML comments that
start with "@AI:", for example <!-- @AI: this section is out of date -->.
To find them, run: grep -n '@AI:' file.html
Each comment is a request about the element that contains it (it is the element's
first child), or about the element right after it when that element is an img, hr,
br, input, pre, textarea, script, or style. Address every comment, then delete the
comment from the file. Leave comments that do not start with "@AI:" alone.
Before you regenerate an HTML file from scratch, run grep -c '@AI:' file.html.
The count must be 0. If it is not, address those comments first so no unresolved
comment is thrown away.
```

## Manual client checklist

Each served page carries a version (a hash of the file on disk), and every save sends it back. If the file changed since the page loaded, the server answers 409 and the client stops saving and shows a lasting warning, so a stale tab cannot resurrect deleted notes or misplace notes on shifted elements.

Open `try-me.html` in a browser (see [Try it](#try-it)).

- [ ] Hovering an element shows a dashed outline and a copy cursor; `html` and `body` show none.
- [ ] Clicking an element opens a comment box below its top edge, with focus in the textarea.
- [ ] A marker appears as soon as you type.
- [ ] A text-only element (`<p>First paragraph</p>`, `<b>bold</b>`) shows a Text field above the comment; an element with child elements (`<p>Second <b>bold</b> paragraph</p>`) shows only the comment.
- [ ] Typing in the Text field changes the page at once and the file within about half a second. Blanking it changes nothing.
- [ ] The file on disk updates within about half a second; the toast says `saved · N comments`.
- [ ] Reloading the page shows the marker; the element has a left accent.
- [ ] Clicking a marker opens its box for editing.
- [ ] Delete (or emptying the text) removes the comment and the marker.
- [ ] `⌘↵`, `Esc`, Save, and clicking outside each commit and close the box. (On a page with a full-width wrapper element, clicking the margin opens a box on the wrapper instead; use Esc.)
- [ ] Opening a second box commits and closes the first.
- [ ] Plain click on a link comments; ⌘-click on a link navigates.
- [ ] The page's own layout and styles look the same with the UI loaded.
- [ ] Stopping the server and typing shows `save failed: ...`; restarting and typing again saves.
- [ ] Edit the file on disk while the tab is open, then type: the toast warns that the file changed, the file stays untouched, and the box keeps your text.
- [ ] Dark mode gives the box a dark theme.

## Design

Everything is in `server.mjs`, in three tiers. Dependencies point down.

The HTML parser is [linkedom](https://github.com/WebReflection/linkedom), bundled with its dependencies into `vendor/linkedom.mjs` (licenses in `vendor/linkedom.LICENSES.txt`) so the tool runs where `npm install` can't, such as behind a corporate proxy. To upgrade it: change the version in `package.json`'s devDependencies, then `npm install && npm run vendor`, and commit `vendor/`.

- **Tier I, orchestration**: CLI arguments, the HTTP request handler, and the GET and PUT flows (normalize, stamp, collect or inject; read, strip notes, place notes, write).
- **Tier II, domain**: pure functions. The formatter (`normalize`), the notes language (`collectNotes`, `removeNotes`, `placeNote`, escaping), text edits (`isTextElement`, `setText`), and element identity (`stamp`, `unstamp`: `data-n` is the element's document-order index).
- **Tier III, interface**: the filesystem gateway (paths under the root, 403 on escape), content types, directory listing, and the client assets (`CLIENT_CSS`, `CLIENT_JS`) injected into served pages.
- **Text edits**: PUT also carries `texts`, `{"<id>": "new text"}`, holding every element the tab has edited. Resending is harmless. The server replaces the text only of elements that hold nothing but text (after notes are lifted out) and ignores blank text, so no markup is lost.
- **Files it serves**: agent-generated documents whose generation we control. The tool may require things of them, limit what they contain, and rewrite them on disk. When a file shape causes trouble, normalize it into a shape the tool handles rather than supporting every HTML a browser accepts. If a requirement can't be met by normalizing, add it to the agent instructions above.
- **Deviation from the spec**: PUT carries an optional `version` (hash of the file bytes, from `data-version` on the `#hn-notes` script); a mismatch gets 409 and no write. A PUT without `version` skips the check.

## Gotchas for maintainers

- linkedom doesn't create a missing `<html>`/`<head>`/`<body>`. It makes the first element the root, and reading `document.head` or `document.body` silently creates empty ones inside that root. Go through `parse()`, never `parseHTML` directly.
- GET normalizes the file in place. To try the server by hand, serve a temp copy of `test/fixtures`, not the directory itself.
