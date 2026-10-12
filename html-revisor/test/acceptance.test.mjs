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
    // GET a page and return the parsed served document plus its directives JSON.
    async page(name) {
      const res = await server.get(name);
      const html = await res.text();
      const { document } = parseHTML(html);
      const json = document.querySelector('script#hrv-directives');
      return { res, html, document, directives: JSON.parse(json.textContent) };
    },
    put: (name, directives) =>
      fetch(server.base + name, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directives }),
      }),
    putTexts: (name, directives, texts) =>
      fetch(server.base + name, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directives, texts }),
      }),
    putVersioned: (name, version, directives) =>
      fetch(server.base + name, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, directives }),
      }),
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

const idOf = (document, selector) => String(document.querySelector(selector).getAttribute('data-n'));
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
    assert.ok(s.read('spacing.html').includes('<p>a <b>b</b> &amp; c</p>'));
  }));

test('3. preformatted content is untouched', () =>
  withServer(async (s) => {
    const pre = '<pre>  indented\n    more <code>x &amp; y</code>\ndone</pre>';
    const script = '<script>var s = "  two  spaces <b> &amp; ";\nif (a<b) { go(); }</script>';
    s.write('raw.html', `<!DOCTYPE html><html><body><div>${pre}${script}</div></body></html>`);
    await s.get('raw.html');
    const after = s.read('raw.html');
    assert.ok(after.includes(pre), after);
    assert.ok(after.includes(script), after);
  }));

test('4. round-trip: PUT directives, file placement, GET returns the same map', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const ids = {
      p: idOf(document, 'p'),
      img: idOf(document, 'img'),
      pre: idOf(document, 'pre'),
      body: idOf(document, 'body'),
    };
    const directives = {
      [ids.p]: 'about the paragraph',
      [ids.img]: 'about the picture',
      [ids.pre]: 'about the code',
      [ids.body]: 'about the whole page',
    };
    const res = await s.put('page.html', directives);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.count, 4);

    const file = s.read('page.html');
    assert.match(file, /<body>\n {4}<!-- @AI: about the whole page -->/);
    assert.match(file, /<p>\n {6}<!-- @AI: about the paragraph -->\n {6}First paragraph\n {4}<\/p>/);
    assert.match(file, /<!-- @AI: about the picture -->\n {4}<img /);
    assert.match(file, /<!-- @AI: about the code -->\n {4}<pre>/);

    const again = await s.page('page.html');
    assert.deepEqual(again.directives, directives);
  }));

test('5. ids are stable across a PUT', () =>
  withServer(async (s) => {
    const first = await s.page('page.html');
    const selectors = ['body', 'h1', 'p', 'img', 'pre', 'ul', 'li'];
    const before = selectors.map((sel) => idOf(first.document, sel));
    await s.put('page.html', { [before[2]]: 'a directive', [before[3]]: 'another', [before[0]]: 'third' });
    const second = await s.page('page.html');
    assert.deepEqual(selectors.map((sel) => idOf(second.document, sel)), before);
  }));

test('6. PUT is the full set', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const p = idOf(document, 'p');
    const img = idOf(document, 'img');
    await s.put('page.html', { [p]: 'one', [img]: 'two' });
    assert.equal(countOf(s.read('page.html'), '<!-- @AI:'), 2);

    await s.put('page.html', { [img]: 'two' });
    const file = s.read('page.html');
    assert.equal(countOf(file, '<!-- @AI:'), 1);
    assert.ok(file.includes('<!-- @AI: two -->'));

    const res = await s.put('page.html', {});
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.count, 0);
    assert.equal(countOf(s.read('page.html'), '<!-- @AI:'), 0);
  }));

test('7. escaping: -- and > cannot end the comment', () =>
  withServer(async (s) => {
    const before = await s.page('page.html');
    const elementsOnDisk = parseHTML(s.read('page.html')).document.querySelectorAll('*').length;
    await s.put('page.html', { [idOf(before.document, 'p')]: '-- really -->' });
    const file = s.read('page.html');
    assert.ok(file.includes('<!-- @AI: - - really - -&gt; -->'), file);
    assert.equal(parseHTML(file).document.querySelectorAll('*').length, elementsOnDisk);
    assert.deepEqual(Object.values((await s.page('page.html')).directives), ['- - really - -&gt;']);
  }));

test('8. non-directive comments are preserved', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    assert.ok(s.read('page.html').includes('<!-- TODO: not a directive -->'));
    await s.put('page.html', { [idOf(document, 'p')]: 'a directive' });
    assert.ok(s.read('page.html').includes('<!-- TODO: not a directive -->'));
    await s.put('page.html', {});
    assert.ok(s.read('page.html').includes('<!-- TODO: not a directive -->'));
  }));

test('9. served page has no directive comments and data-n everywhere; disk has no data-n', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    await s.put('page.html', { [idOf(document, 'p')]: 'visible only as data', [idOf(document, 'pre')]: 'x' });
    const { html, document: served, directives } = await s.page('page.html');
    assert.equal(Object.keys(directives).length, 2);
    assert.ok(!/<!--\s*@AI:/.test(html));
    assert.ok(html.includes('<!-- TODO: not a directive -->'));

    const unstamped = [...served.querySelectorAll('*')].filter((el) => !el.hasAttribute('data-n'));
    // the injected style and two scripts come after stamping
    assert.deepEqual(unstamped.map((el) => el.localName).sort(), ['script', 'script', 'style']);
    assert.ok(!s.read('page.html').includes('data-n'));
  }));

test('9b. injection: json script escapes <, client assets are last and unstamped', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    await s.put('page.html', { [idOf(document, 'p')]: '</script><b>hi</b>' });
    const { html, directives } = await s.page('page.html');
    const jsonScript = html.match(/<script [^>]*id="hrv-directives"[^>]*>(.*?)<\/script>/s)[1];
    assert.ok(!jsonScript.includes('<'));
    assert.ok(jsonScript.includes('\\u003c'));
    assert.equal(Object.values(directives)[0], '</script&gt;<b&gt;hi</b&gt;'); // > is escaped on write, not unescaped on read
    assert.ok(html.indexOf('<style>') < html.indexOf('</head>'));
    assert.ok(html.lastIndexOf('<script>') > html.indexOf('hrv-directives'));
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
    const put404 = await s.put('nope.html', {});
    assert.equal(put404.status, 404);
  }));

test('versioned PUT: current version succeeds, stale version gets 409, missing version still works', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const v0 = document.querySelector('script#hrv-directives').getAttribute('data-version');
    assert.match(v0, /^[0-9a-f]{12}$/);

    const first = await s.putVersioned('page.html', v0, { 1: 'one' });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.count, 1);
    assert.match(firstBody.version, /^[0-9a-f]{12}$/);
    assert.notEqual(firstBody.version, v0);

    const second = await s.putVersioned('page.html', firstBody.version, { 1: 'two' });
    assert.equal(second.status, 200);
    const secondVersion = (await second.json()).version;

    // someone else edits the file on disk
    s.write('page.html', s.read('page.html').replace('two', 'changed elsewhere'));
    const before = s.read('page.html');
    const stale = await s.putVersioned('page.html', secondVersion, { 1: 'mine' });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { ok: false, error: 'file changed on disk; reload to continue' });
    assert.equal(s.read('page.html'), before);
    await s.waitForLog('stale write rejected');

    // no version: the check is skipped
    assert.equal((await s.put('page.html', { 1: 'curl' })).status, 200);
  }));

test('text edits: PUT texts rewrites the text of text-only elements, alongside directives', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const p = idOf(document, 'p');
    const b = idOf(document, 'b');
    const mixed = idOf(document, 'p:nth-of-type(2)');
    const li = idOf(document, 'li');
    const res = await s.putTexts('page.html', { [p]: 'reworded' }, {
      [p]: 'First <para> & more',
      [b]: 'strong',
      [mixed]: 'flattened',
      [li]: '   ',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).count, 1);

    const file = s.read('page.html');
    assert.match(file, /<p>\n {6}<!-- @AI: reworded -->\n {6}First &lt;para&gt; &amp; more\n {4}<\/p>/);
    assert.ok(file.includes('<p>Second <b>strong</b> paragraph</p>'), 'mixed content keeps its markup');
    assert.ok(file.includes('<li>one</li>'), 'blank text is ignored');
    assert.equal(file, normalize(file));

    // texts are idempotent: sending the same set again changes nothing
    await s.putTexts('page.html', { [p]: 'reworded' }, { [p]: 'First <para> & more', [b]: 'strong' });
    assert.equal(s.read('page.html'), file);
    assert.deepEqual((await s.page('page.html')).directives, { [p]: 'reworded' });
  }));

test('texts must be an object of strings when present', () =>
  withServer(async (s) => {
    const res = await fetch(s.base + 'page.html', {
      method: 'PUT',
      body: JSON.stringify({ directives: {}, texts: ['x'] }),
    });
    assert.equal(res.status, 400);
  }));

test('errors are plain-text 500 and logged', () =>
  withServer(async (s) => {
    const res = await fetch(s.base + 'page.html', { method: 'PUT', body: 'not json' });
    assert.equal(res.status, 400);
    // a directory named like an html file makes readFile fail with EISDIR
    fs.mkdirSync(path.join(s.dir, 'weird.html'));
    const boom = await s.put('weird.html', {});
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
      const { document } = await s.page(name);
      const ids = [...document.querySelectorAll('[data-n]')]
        .filter((_, i) => i % 3 === 0)
        .map((el) => el.getAttribute('data-n'));
      await s.put(name, Object.fromEntries(ids.map((id) => [id, `directive ${id}`])));
      const written = s.read(name);
      assert.equal(normalize(written), written, `${name} after PUT`);
      assert.ok(countOf(written, '<!-- @AI:') > 0);
      // a second PUT with the directives the page reports changes nothing
      const { directives } = await s.page(name);
      await s.put(name, directives);
      assert.equal(s.read(name), written, `${name} PUT round trip`);
    }
  }));

test('--author changes the prefix', () =>
  withServer(
    async (s) => {
      const { document } = await s.page('page.html');
      await s.put('page.html', { [idOf(document, 'p')]: 'hello' });
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
    // exactly one client script plus the directives JSON, appended after stamping
    const stamped = document.querySelectorAll('[data-n]').length;
    const onDisk = parseHTML(s.read('demo.html')).document.querySelectorAll('*').length;
    assert.equal(stamped, onDisk);
    assert.equal(document.querySelector('#hrv-layer'), null, 'layer is built by the script, not the server');
    // the inlined script must not close early
    const scripts = [...document.querySelectorAll('script')];
    assert.ok(scripts.some((el) => el.textContent.includes('hrv-layer')));
  }));

test('a page without html, head or body gets them, and the client lands in them', () =>
  withServer(async (s) => {
    const { html, document } = await s.page('bare.html');
    const onDisk = s.read('bare.html');
    assert.match(onDisk, /<html>\s*<head>\s*<title>Bare page<\/title>[\s\S]*<\/head>\s*<body>\s*<main>/);
    assert.match(onDisk, /<script>document\.title \+= '!';<\/script>\s*<\/body>\s*<\/html>\s*$/);
    assert.equal(document.querySelector('title').textContent, 'Bare page', 'client CSS stays out of <title>');
    assert.ok(html.indexOf('#hrv-layer') < html.indexOf('</head>'), 'client CSS in head');
    assert.match(html, /<\/script><\/body>\s*<\/html>\s*$/, 'client script at end of body');
  }));
