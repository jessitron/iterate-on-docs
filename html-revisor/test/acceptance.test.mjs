// Acceptance tests from the spec. Each test copies the fixtures to a temp dir,
// starts the server as a child process on a random port, and talks to it over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from '../vendor/linkedom.mjs';
import { normalize } from '../formatter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(here, '..', 'server.mjs');

// Run fn with a live server whose root is a fresh copy of the fixtures.
async function withServer(fn, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-revisor-'));
  fs.cpSync(path.join(here, 'fixtures'), dir, { recursive: true });
  const child = spawn(process.execPath, [serverFile, dir, '--port', '0', ...args]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const server = {
    dir,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    read: (name) => fs.readFileSync(path.join(dir, name), 'utf8'),
    write: (name, text) => fs.writeFileSync(path.join(dir, name), text),
    get: (p) => fetch(server.base + p),
    // GET a page and return the parsed served document, its directives and bases, and its version.
    async page(name) {
      const res = await server.get(name);
      const html = await res.text();
      const { document } = parseHTML(html);
      const json = document.querySelector('script#hrv-directives');
      const bases = JSON.parse(document.querySelector('script#hrv-bases').textContent);
      return { res, html, document, bases, version: json.getAttribute('data-version'), directives: JSON.parse(json.textContent) };
    },
    // PUT one change, as the tab sends it: {id, base, directive} or {id, base, text}.
    put: (name, change) =>
      fetch(server.base + name, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      }),
    // Load the page, then set one element's directive with the base the page gave.
    async direct(name, selectorOrId, directive) {
      const { document, bases } = await server.page(name);
      const id = /^\d+$/.test(selectorOrId) ? selectorOrId : idOf(document, selectorOrId);
      return server.put(name, { id, base: bases[id], directive });
    },
    // Wait until the log has a line matching re (stdout arrives slightly after the response).
    async waitForLog(re, count = 1) {
      for (let i = 0; i < 200; i++) {
        if ((stdout.match(new RegExp(re, 'g')) ?? []).length >= count) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(`log never matched ${re}; got:\n${stdout}`);
    },
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no startup line; stderr: ${stderr}`)), 5000);
      child.stdout.on('data', () => {
        const m = stdout.match(/html-revisor: (http:\/\/localhost:\d+\/) serving/);
        if (m) {
          clearTimeout(timer);
          server.base = m[1];
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`server exited ${code}; stderr: ${stderr}`)));
    });
    await fn(server);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const idOf = (document, selector) => document.querySelector(selector).getAttribute('data-hrv');
const countOf = (text, needle) => text.split(needle).length - 1;

test('1. normalize is idempotent', () =>
  withServer(async (s) => {
    const before = s.read('messy.html');
    await s.get('messy.html');
    await s.waitForLog('messy.html — ');
    const once = s.read('messy.html');
    assert.notEqual(once, before);
    assert.equal(countOf(s.stdout, '(normalized)'), 1);

    await s.get('messy.html');
    await s.waitForLog('messy.html — ', 2);
    assert.equal(s.read('messy.html'), once);
    assert.equal(countOf(s.stdout, '(normalized)'), 1, 'second load must not normalize');
  }));

test('2. inline spacing survives', () =>
  withServer(async (s) => {
    s.write('spacing.html', '<!DOCTYPE html><html><body><p>a <b>b</b> &amp; c</p></body></html>');
    await s.get('spacing.html');
    assert.match(s.read('spacing.html'), /<p data-hrv="\d+">a <b>b<\/b> &amp; c<\/p>/);
  }));

test('3. preformatted content is untouched', () =>
  withServer(async (s) => {
    const pre = '<pre>  indented\n    more <code>x &amp; y</code>\ndone</pre>';
    const script = '<script>var s = "  two  spaces <b> &amp; ";\nif (a<b) { go(); }</script>';
    s.write('raw.html', `<!DOCTYPE html><html><body><div>${pre}${script}</div></body></html>`);
    await s.get('raw.html');
    const after = s.read('raw.html').replace(/ data-hrv="\d+"/g, '');
    assert.ok(after.includes(pre), after);
    assert.ok(after.includes(script), after);
  }));

test('4. round-trip: PUT directives, file placement, GET returns the same map', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const ids = Object.fromEntries(['p', 'img', 'pre', 'body'].map((sel) => [sel, idOf(document, sel)]));
    const directives = {
      [ids.p]: 'about the paragraph',
      [ids.img]: 'about the picture',
      [ids.pre]: 'about the code',
      [ids.body]: 'about the whole page',
    };
    let body;
    for (const [id, text] of Object.entries(directives)) {
      const res = await s.direct('page.html', id, text);
      body = await res.json();
      assert.equal(body.ok, true);
    }
    assert.equal(body.count, 4);

    const file = s.read('page.html');
    assert.match(file, /<body data-hrv="\d+">\n {4}<!-- @AI: about the whole page -->/);
    assert.match(file, /<p data-hrv="\d+">\n {6}<!-- @AI: about the paragraph -->\n {6}First paragraph\n {4}<\/p>/);
    assert.match(file, /<!-- @AI: about the picture -->\n {4}<img /);
    assert.match(file, /<!-- @AI: about the code -->\n {4}<pre /);

    const again = await s.page('page.html');
    assert.deepEqual(again.directives, directives);
  }));

test('5. IDs live in the file and are stable across a PUT', () =>
  withServer(async (s) => {
    const first = await s.page('page.html');
    const selectors = ['body', 'h1', 'p', 'img', 'pre', 'ul', 'li'];
    const before = selectors.map((sel) => idOf(first.document, sel));
    assert.ok(before.every((id) => /^\d+$/.test(id)));
    const onDisk = parseHTML(s.read('page.html')).document;
    assert.deepEqual(selectors.map((sel) => idOf(onDisk, sel)), before);
    await s.direct('page.html', before[2], 'a directive');
    await s.direct('page.html', before[3], 'another');
    const second = await s.page('page.html');
    assert.deepEqual(selectors.map((sel) => idOf(second.document, sel)), before);
  }));

test('6. a PUT changes one directive; the rest stay where they are', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const p = idOf(document, 'p');
    const img = idOf(document, 'img');
    await s.direct('page.html', p, 'one');
    await s.direct('page.html', img, 'two');
    assert.equal(countOf(s.read('page.html'), '<!-- @AI:'), 2);

    const res = await s.direct('page.html', p, '');
    assert.equal((await res.json()).count, 1);
    const file = s.read('page.html');
    assert.equal(countOf(file, '<!-- @AI:'), 1);
    assert.ok(file.includes('<!-- @AI: two -->'));
  }));

test('6b. a directive the agent finished stays gone when the tab saves another', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const p = idOf(document, 'p');
    await s.direct('page.html', p, 'done soon');
    const tab = await s.page('page.html');
    // the agent addresses the directive and deletes it
    s.write('page.html', s.read('page.html').replace(/\n *<!-- @AI: done soon -->/, ''));
    const res = await s.put('page.html', { id: idOf(document, 'h1'), base: tab.bases[idOf(document, 'h1')], directive: 'new one' });
    assert.equal(res.status, 200);
    const file = s.read('page.html');
    assert.ok(!file.includes('done soon'));
    assert.ok(file.includes('<!-- @AI: new one -->'));
  }));

test('7. escaping: -- and > cannot end the comment', () =>
  withServer(async (s) => {
    const before = await s.page('page.html');
    const elementsOnDisk = parseHTML(s.read('page.html')).document.querySelectorAll('*').length;
    await s.direct('page.html', idOf(before.document, 'p'), '-- really -->');
    const file = s.read('page.html');
    assert.ok(file.includes('<!-- @AI: - - really - -&gt; -->'), file);
    assert.equal(parseHTML(file).document.querySelectorAll('*').length, elementsOnDisk);
    assert.deepEqual(Object.values((await s.page('page.html')).directives), ['- - really - -&gt;']);
  }));

test('8. non-directive comments are preserved', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    assert.ok(s.read('page.html').includes('<!-- TODO: not a directive -->'));
    await s.direct('page.html', idOf(document, 'p'), 'a directive');
    assert.ok(s.read('page.html').includes('<!-- TODO: not a directive -->'));
    await s.direct('page.html', idOf(document, 'p'), '');
    assert.ok(s.read('page.html').includes('<!-- TODO: not a directive -->'));
  }));

test('9. served page has no directive comments; its IDs are the file\'s, and the client has none', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    await s.direct('page.html', idOf(document, 'p'), 'visible only as data');
    await s.direct('page.html', idOf(document, 'pre'), 'x');
    const { html, document: served, directives } = await s.page('page.html');
    assert.equal(Object.keys(directives).length, 2);
    assert.ok(!/<!--\s*@AI:/.test(html));
    assert.ok(html.includes('<!-- TODO: not a directive -->'));

    const idsOf = (doc) => [...doc.querySelectorAll('[data-hrv]')].map((el) => `${el.localName}=${el.getAttribute('data-hrv')}`);
    assert.deepEqual(idsOf(served), idsOf(parseHTML(s.read('page.html')).document));
    for (const id of ['hrv-directives', 'hrv-bases']) assert.ok(!served.getElementById(id).hasAttribute('data-hrv'));
    assert.equal(served.querySelector('style:last-of-type').hasAttribute('data-hrv'), false);
  }));

test('9b. injection: json script escapes <, client assets are last', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    await s.direct('page.html', idOf(document, 'p'), '</script><b>hi</b>');
    const { html, directives } = await s.page('page.html');
    const jsonScript = html.match(/<script [^>]*id="hrv-directives"[^>]*>(.*?)<\/script>/s)[1];
    assert.ok(!jsonScript.includes('<'));
    assert.ok(jsonScript.includes('\\u003c'));
    assert.equal(Object.values(directives)[0], '</script&gt;<b&gt;hi</b&gt;'); // > is escaped on write, not unescaped on read
    assert.ok(html.indexOf('<style>') < html.indexOf('</head>'));
    assert.ok(html.lastIndexOf('<script>') > html.indexOf('hrv-bases'));
    assert.match(html, /<\/script><\/body>\s*<\/html>\s*$/);
  }));

function rawGet(base, rawPath) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject)
      .end();
  });
}

test('10. path safety', () =>
  withServer(async (s) => {
    for (const bad of ['/../etc/passwd', '/%2e%2e/etc/passwd', '/..%2fetc/passwd', '/a/../../etc/passwd']) {
      assert.equal((await rawGet(s.base, bad)).status, 403, bad);
    }
    // a sibling directory whose name starts with the root's name is still outside
    const sibling = `/../${path.basename(s.dir)}-evil/x`;
    assert.equal((await rawGet(s.base, sibling)).status, 403, sibling);
    assert.equal((await rawGet(s.base, '/%zz')).status, 400);
    assert.equal((await s.get('page.html')).status, 200);
  }));

test('other files: assets, directory listing, 404', () =>
  withServer(async (s) => {
    const svg = await s.get('pic.svg');
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    const listing = await (await s.get('')).text();
    assert.ok(listing.includes('href="page.html"'));
    assert.equal((await s.get('nope.html')).status, 404);
    const put404 = await s.put('nope.html', { id: '1', base: 'x', directive: '' });
    assert.equal(put404.status, 404);
  }));

test('conflict: a base that no longer matches, or an ID that is gone, writes nothing', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const li = idOf(document, 'li');
    // the agent rewords the item
    s.write('page.html', s.read('page.html').replace('>one</li>', '>uno</li>'));
    const before = s.read('page.html');
    const stale = await s.put('page.html', { id: li, base: bases[li], directive: 'mine' });
    assert.equal(stale.status, 412);
    assert.deepEqual(await stale.json(), { ok: false, error: 'that element changed on disk' });
    assert.equal(s.read('page.html'), before);
    await s.waitForLog('conflict on element');

    const gone = await s.put('page.html', { id: '9999', base: 'x', directive: 'mine' });
    assert.equal(gone.status, 412);
    assert.equal((await gone.json()).error, 'that element is gone from the file');
  }));

test('an agent edit elsewhere does not block a save; the answer says the file changed', () =>
  withServer(async (s) => {
    const { document, bases, version } = await s.page('page.html');
    const h1 = idOf(document, 'h1');
    const first = await (await s.direct('page.html', h1, 'one')).json();
    assert.equal(first.before, version);
    assert.notEqual(first.after, version);

    s.write('page.html', s.read('page.html').replace('>two</li>', '>deux</li>'));
    const res = await s.put('page.html', { id: h1, base: bases[h1], directive: 'two' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.notEqual(body.before, first.after, 'before is the file as this save found it');
    assert.match(body.after, /^[0-9a-f]{12}$/);
  }));

test('bases: directives do not change them; a text edit returns new ones for the element and its ancestors', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const [ul, li, body] = [idOf(document, 'ul'), idOf(document, 'li'), idOf(document, 'body')];
    await s.put('page.html', { id: li, base: bases[li], directive: 'a directive' });
    const res = await s.put('page.html', { id: li, base: bases[li], text: 'first' });
    assert.equal(res.status, 200, 'the directive left the base alone');
    const answer = await res.json();
    assert.ok([li, ul, body].every((id) => id in answer.bases));
    assert.notEqual(answer.bases[ul], bases[ul]);
    assert.equal((await s.put('page.html', { id: ul, base: bases[ul], directive: 'x' })).status, 412);
    assert.equal((await s.put('page.html', { id: ul, base: answer.bases[ul], directive: 'x' })).status, 200);
    assert.deepEqual((await s.page('page.html')).bases, { ...bases, ...answer.bases });
  }));

test('text edits: a PUT with text rewrites a text-only element and keeps its directive', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const p = idOf(document, 'p');
    await s.put('page.html', { id: p, base: bases[p], directive: 'reworded' });
    const res = await s.put('page.html', { id: p, base: bases[p], text: 'First <para> & more' });
    assert.equal(res.status, 200);

    const file = s.read('page.html');
    assert.match(file, /<p data-hrv="\d+">\n {6}<!-- @AI: reworded -->\n {6}First &lt;para&gt; &amp; more\n {4}<\/p>/);
    assert.equal(file, normalize(file));
    assert.deepEqual((await s.page('page.html')).directives, { [p]: 'reworded' });
  }));

test('text edits refuse markup-holding elements and blank text', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const mixed = idOf(document, 'p:nth-of-type(2)');
    const li = idOf(document, 'li');
    const before = s.read('page.html');
    assert.equal((await s.put('page.html', { id: mixed, base: bases[mixed], text: 'flattened' })).status, 400);
    assert.equal((await s.put('page.html', { id: li, base: bases[li], text: '   ' })).status, 400);
    assert.equal(s.read('page.html'), before);
  }));

test('a PUT body must be one change: id, base, and a directive or a text', () =>
  withServer(async (s) => {
    for (const body of [{ directives: {} }, { id: '1', base: 'x' }, { id: '1', base: 'x', directive: 'a', text: 'b' }, { id: 1, base: 'x', text: 'b' }]) {
      assert.equal((await s.put('page.html', body)).status, 400, JSON.stringify(body));
    }
  }));

test('errors are plain-text 500 and logged', () =>
  withServer(async (s) => {
    const res = await fetch(s.base + 'page.html', { method: 'PUT', body: 'not json' });
    assert.equal(res.status, 400);
    // a directory named like an html file makes readFile fail with EISDIR
    fs.mkdirSync(path.join(s.dir, 'weird.html'));
    const boom = await s.put('weird.html', { id: '1', base: 'x', directive: '' });
    assert.equal(boom.status, 500);
    assert.match(boom.headers.get('content-type'), /text\/plain/);
    for (let i = 0; i < 100 && !s.stderr.includes('EISDIR'); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(s.stderr.includes('EISDIR'));
  }));

test('idempotence holds for fixtures and for the output of a PUT', () =>
  withServer(async (s) => {
    for (const name of ['messy.html', 'demo.html', 'page.html', 'other.html']) {
      const text = fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
      const once = normalize(text);
      assert.equal(normalize(once), once, name);
      const { document, bases } = await s.page(name);
      const ids = [...document.querySelectorAll('[data-hrv]')]
        .filter((_, i) => i % 3 === 0)
        .map((el) => el.getAttribute('data-hrv'));
      for (const id of ids) {
        assert.equal((await s.put(name, { id, base: bases[id], directive: `directive ${id}` })).status, 200, `${name} ${id}`);
      }
      const written = s.read(name);
      assert.equal(normalize(written), written, `${name} after PUT`);
      assert.ok(countOf(written, '<!-- @AI:') > 0);
      // setting a directive to what it already is changes nothing
      const again = await s.page(name);
      for (const [id, text] of Object.entries(again.directives)) await s.put(name, { id, base: again.bases[id], directive: text });
      assert.equal(s.read(name), written, `${name} PUT round trip`);
    }
  }));

test('--author changes the prefix', () =>
  withServer(
    async (s) => {
      await s.direct('page.html', 'p', 'hello');
      assert.ok(s.read('page.html').includes('<!-- sam: hello -->'));
      assert.deepEqual(Object.values((await s.page('page.html')).directives), ['hello']);
    },
    ['--author', 'sam'],
  ));

test('served page carries the client and still re-parses with the same element count', () =>
  withServer(async (s) => {
    const { html, document } = await s.page('demo.html');
    assert.ok(html.includes('#hrv-layer'), 'client CSS present');
    assert.ok(html.includes("id = 'hrv-layer'"), 'client JS present');
    // the client and its JSON go in after the file's own elements, with no IDs
    const served = document.querySelectorAll('[data-hrv]').length;
    const onDisk = parseHTML(s.read('demo.html')).document.querySelectorAll('[data-hrv]').length;
    assert.equal(served, onDisk);
    assert.equal(document.querySelector('#hrv-layer'), null, 'layer is built by the script, not the server');
    // the inlined script must not close early
    const scripts = [...document.querySelectorAll('script')];
    assert.ok(scripts.some((el) => el.textContent.includes('hrv-layer')));
  }));

test('a page without html, head or body gets them, and the client lands in them', () =>
  withServer(async (s) => {
    const { html, document } = await s.page('bare.html');
    const onDisk = s.read('bare.html');
    assert.match(onDisk, /<html data-hrv-next="\d+">\s*<head>\s*<title>Bare page<\/title>[\s\S]*<\/head>\s*<body data-hrv="1">\s*<main data-hrv="2">/);
    assert.match(onDisk, /<script>document\.title \+= '!';<\/script>\s*<\/body>\s*<\/html>\s*$/);
    assert.equal(document.querySelector('title').textContent, 'Bare page', 'client CSS stays out of <title>');
    assert.ok(html.indexOf('#hrv-layer') < html.indexOf('</head>'), 'client CSS in head');
    assert.match(html, /<\/script><\/body>\s*<\/html>\s*$/, 'client script at end of body');
  }));
