// Acceptance tests from the spec. Each test copies the fixtures to a temp dir,
// starts the server on a random port, and talks to it over HTTP. The server runs in this
// process; the tests of the CLI itself (--author, a file argument) spawn server.mjs.
// The harness is in acceptance-lib.mjs; the live notice tests are in live-notice.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseHTML } from '../vendor/linkedom.mjs';
import { normalize } from '../domain/format.mjs';
import { here, serverFile, env, withServer, idOf, countOf, announcements, directAndAnnounce } from './acceptance-lib.mjs';

test('1. normalize is idempotent', () =>
  withServer(async (s) => {
    const before = s.read('messy.html');
    await s.get('messy.html');
    await s.waitForLog('messy.html \\(normalized\\)');
    const once = s.read('messy.html');
    assert.notEqual(once, before);

    await s.get('messy.html');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.read('messy.html'), once);
    assert.equal(countOf(s.stdout, '(normalized)'), 1, 'second load must not normalize');
  }));

test('2. inline spacing survives', () =>
  withServer(async (s) => {
    s.write('spacing.html', '<!DOCTYPE html><html><body><p>a <b>b</b> &amp; c</p></body></html>');
    await s.get('spacing.html');
    assert.match(s.read('spacing.html'), /<p data-hrv="\d+">a <strong>b<\/strong> &amp; c<\/p>/);
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
    assert.ok(file.includes('<!-- @AI: - - really - -> -->'), file);
    assert.equal(parseHTML(file).document.querySelectorAll('*').length, elementsOnDisk);
    assert.deepEqual(Object.values((await s.page('page.html')).directives), ['- - really - ->']);
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
    assert.equal(Object.values(directives)[0], '</script><b>hi</b>'); // reads back as typed
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

test('bases: directives do not change them; a markdown edit returns new ones for the element and its ancestors', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const [ul, li, body] = [idOf(document, 'ul'), idOf(document, 'li'), idOf(document, 'body')];
    await s.put('page.html', { id: li, base: bases[li], directive: 'a directive' });
    const res = await s.put('page.html', { id: li, base: bases[li], markdown: 'first' });
    assert.equal(res.status, 200, 'the directive left the base alone');
    const answer = await res.json();
    assert.ok([li, ul, body].every((id) => id in answer.bases));
    assert.notEqual(answer.bases[ul], bases[ul]);
    assert.equal((await s.put('page.html', { id: ul, base: bases[ul], directive: 'x' })).status, 412);
    assert.equal((await s.put('page.html', { id: ul, base: answer.bases[ul], directive: 'x' })).status, 200);
    assert.deepEqual((await s.page('page.html')).bases, { ...bases, ...answer.bases });
  }));

test('the served page carries the markdown of every scope but body', () =>
  withServer(async (s) => {
    const { document, markdowns } = await s.page('page.html');
    assert.equal(markdowns[idOf(document, 'p:nth-of-type(2)')], 'Second **bold** paragraph');
    assert.equal(markdowns[idOf(document, 'ul')], '- one\n- two');
    assert.ok(!(idOf(document, 'body') in markdowns));
  }));

// Make the server's root a repository and commit everything in it, as it stands.
function commitAll(dir) {
  const run = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('add', '.');
  run('commit', '-q', '-m', 'turn');
}

test('Revert: the served page carries each scope\'s markdown at the last commit, numbered like the page', () =>
  withServer(async (s) => {
    commitAll(s.dir);
    const { document, bases, markdowns, committed } = await s.page('page.html');
    assert.deepEqual(committed, markdowns, 'a commit without IDs numbers the same as the page');
    const p = idOf(document, 'p');
    const ul = idOf(document, 'ul');
    await s.put('page.html', { id: p, base: bases[p], markdown: 'First paragraph, edited' });
    await s.put('page.html', { id: ul, base: bases[ul], markdown: '- one' });
    const after = await s.page('page.html');
    assert.equal(after.markdowns[p], 'First paragraph, edited');
    assert.equal(after.committed[p], 'First paragraph');
    assert.equal(after.committed[ul], '- one\n- two', 'the deleted item comes back from its list');

    commitAll(s.dir);
    const next = await s.page('page.html');
    assert.equal(next.committed[p], 'First paragraph, edited', 'a commit with IDs keeps them');
    s.write('new.html', '<p>uncommitted</p>');
    assert.deepEqual((await s.page('new.html')).committed, {}, 'a file not in the commit has nothing to revert to');
  }));

test('Revert: outside a git repository there is nothing to revert to', () =>
  withServer(async (s) => {
    assert.deepEqual((await s.page('page.html')).committed, {});
  }));

test('markdown edits: a PUT with markdown writes HTML and keeps the directive', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const p = idOf(document, 'p');
    await s.put('page.html', { id: p, base: bases[p], directive: 'reworded' });
    const res = await s.put('page.html', { id: p, base: bases[p], markdown: 'First **para** & <more' });
    assert.equal(res.status, 200);
    const answer = await res.json();
    assert.equal(answer.id, p);
    assert.equal(answer.html, `<p data-hrv="${p}">First <strong>para</strong> &amp; &lt;more</p>`);
    assert.equal(answer.markdowns[p], 'First **para** & &lt;more', 'a < that could start a tag is escaped');

    const file = s.read('page.html');
    assert.match(file, /<p data-hrv="\d+">\n {6}<!-- @AI: reworded -->\n {6}First <strong>para<\/strong> &amp; &lt;more\n {4}<\/p>/);
    assert.equal(file, normalize(file));
    assert.deepEqual((await s.page('page.html')).directives, { [p]: 'reworded' });
  }));

test('markdown edits: a list keeps the IDs and directives of the items you left, and new ones get IDs', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const ul = idOf(document, 'ul');
    const two = idOf(document, 'li:nth-of-type(2)');
    await s.put('page.html', { id: two, base: bases[two], directive: 'on two' });
    const answer = await (await s.put('page.html', { id: ul, base: bases[ul], markdown: '- one\n- *two*\n- three' })).json();
    const after = await s.page('page.html');
    const items = [...after.document.querySelectorAll('li')].map((li) => li.getAttribute('data-hrv'));
    assert.equal(items[1], two);
    assert.ok(items[2] && !Object.values(bases).includes(items[2]) && !(items[2] in bases), 'the new item has a new ID');
    assert.deepEqual(after.directives, { [two]: 'on two' });
    assert.ok(!answer.html.includes('@AI'), 'the answer is the served HTML, directives lifted');
    assert.ok(items.every((id) => id in answer.bases && id in answer.markdowns));
    assert.deepEqual(after.bases, { ...bases, ...answer.bases });
    assert.deepEqual(after.markdowns[ul], answer.markdowns[ul]);
  }));

test('markdown edits refuse elements that are not scopes and blank markdown', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const li = idOf(document, 'li');
    const body = idOf(document, 'body');
    const before = s.read('page.html');
    assert.equal((await s.put('page.html', { id: li, base: bases[li], markdown: '   ' })).status, 400);
    assert.equal((await s.put('page.html', { id: body, base: bases[body], markdown: 'all gone' })).status, 400);
    assert.equal(s.read('page.html'), before);

    s.write('rule.html', '<p>above</p><hr><p>below</p>');
    const ruled = await s.page('rule.html');
    const hr = idOf(ruled.document, 'hr');
    assert.ok(!(hr in ruled.markdowns), 'an hr takes directives but is no scope');
    assert.equal((await s.put('rule.html', { id: hr, base: ruled.bases[hr], markdown: 'not a rule' })).status, 400);
  }));

test('a scope of 4 KB or more takes directives, not markdown; one a save grows past that loses its markdown', () =>
  withServer(async (s) => {
    const p = (n) => `<p>${'word '.repeat(n)}</p>`;
    s.write('big.html', `<section class="big">${p(150).repeat(6)}</section><section class="near">${p(150).repeat(4)}${p(80)}</section>`);
    const { document, bases, markdowns } = await s.page('big.html');
    const big = idOf(document, 'section.big');
    assert.ok(!(big in markdowns), 'no Content field');
    assert.ok(idOf(document, 'section.big p') in markdowns, 'its paragraphs edit');
    assert.equal((await s.put('big.html', { id: big, base: bases[big], markdown: 'all gone' })).status, 400);
    assert.equal((await s.put('big.html', { id: big, base: bases[big], directive: 'shorter' })).status, 200);

    const near = idOf(document, 'section.near');
    const last = idOf(document, 'section.near p:last-child');
    assert.ok(near in markdowns);
    const res = await s.put('big.html', { id: last, base: bases[last], markdown: 'word '.repeat(400) });
    assert.equal(res.status, 200);
    const answer = await res.json();
    assert.equal(answer.markdowns[near], null, 'the section grew past the limit');
  }));

test('threads: the page carries each settled thread; a directive after a reply is a new turn', () =>
  withServer(async (s) => {
    s.write('thread.html', '<p><!-- @AI: add a diagram --><!-- @Human: Added one. Want another? -->Where it is headed</p><p>other</p>');
    const { document, html, directives, threads, bases } = await s.page('thread.html');
    const p = idOf(document, 'p');
    assert.deepEqual(threads, { [p]: [{ prefix: '@AI', text: 'add a diagram' }, { prefix: '@Human', text: 'Added one. Want another?' }] });
    assert.deepEqual(directives, {});
    assert.doesNotMatch(html, /<!--\s*@Human:/);
    assert.equal((await s.put('thread.html', { id: p, base: bases[p], directive: 'Yes' })).status, 200);
    assert.match(s.read('thread.html'), /<!-- @AI: add a diagram -->\s*<!-- @Human: Added one. Want another\? -->\s*<!-- @AI: Yes -->/);
    const again = await s.page('thread.html');
    assert.deepEqual(again.directives, { [p]: 'Yes' });
    assert.equal(again.threads[p].length, 2);
  }));

test('Resolve removes the thread, directives and replies, and nothing else', () =>
  withServer(async (s) => {
    s.write('thread.html', '<p><!-- @AI: one --><!-- @Human: two --><!-- @AI: three -->text</p><p><!-- @AI: keep -->other</p>');
    const { document, bases } = await s.page('thread.html');
    const p = idOf(document, 'p');
    const answer = await (await s.put('thread.html', { id: p, base: bases[p], resolve: true })).json();
    assert.equal(answer.ok, true);
    assert.equal(answer.count, 1);
    assert.doesNotMatch(s.read('thread.html'), /one|two|three/);
    assert.match(s.read('thread.html'), /<!-- @AI: keep -->/);
  }));

// Resolve closes the box: the tab sends the resolve, then Done with what the box opened with.
test('Done after a Resolve announces it once, with the turns that went; a Clear announces none', () =>
  withServer(async (s) => {
    s.write('thread.html', '<h1>Title</h1><p><!-- @AI: one --><!-- @Human: two -->text</p><p><!-- @AI: three --><!-- @Human: four -->other</p>');
    const { document, bases } = await s.page('thread.html');
    const [p, q] = [...document.querySelectorAll('p')].map((e) => e.getAttribute('data-hrv'));
    await s.put('thread.html', { id: p, base: bases[p], resolve: true });
    assert.deepEqual(await (await s.done('thread.html', { id: p, directive: '' })).json(), { announced: true });
    // q: an unsent turn, then Resolve. The directive went too, and resolved tells it from a Clear.
    const typed = await (await s.put('thread.html', { id: q, base: bases[q], directive: 'five' })).json();
    await s.put('thread.html', { id: q, base: typed.bases[q], resolve: true });
    await s.done('thread.html', { id: q, directive: 'five' });
    await s.waitForLog('\n\{', 2);
    assert.deepEqual(announcements(s.stdout), [
      { page: '/thread.html', id: p, element: 'p', heading: 'Title', resolved: [{ prefix: '@AI', text: 'one' }, { prefix: '@Human', text: 'two' }] },
      {
        page: '/thread.html', id: q, element: 'p', heading: 'Title', directive: { before: 'five', after: '' },
        resolved: [{ prefix: '@AI', text: 'three' }, { prefix: '@Human', text: 'four' }, { prefix: '@AI', text: 'five' }],
      },
    ]);
    assert.deepEqual(await (await s.done('thread.html', { id: p, directive: '' })).json(), { announced: false }, 'a Resolve announces once');
  }));

test('a Clear announces the directive gone, with no resolved', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const p = idOf(document, 'p');
    const typed = await (await s.put('page.html', { id: p, base: bases[p], directive: 'say more' })).json();
    await s.put('page.html', { id: p, base: typed.bases[p], directive: '' });
    await s.done('page.html', { id: p, directive: 'say more' });
    await s.waitForLog('\n\{', 1);
    assert.deepEqual(announcements(s.stdout), [{ page: '/page.html', id: p, element: 'p', heading: 'Title', directive: { before: 'say more', after: '' } }]);
  }));

test('a PUT body must be one change: id, base, and a directive, a markdown, or resolve', () =>
  withServer(async (s) => {
    for (const body of [{ directives: {} }, { id: '1', base: 'x' }, { id: '1', base: 'x', directive: 'a', markdown: 'b' }, { id: 1, base: 'x', markdown: 'b' }, { id: '1', base: 'x', text: 'b' }, { id: '1', base: 'x', resolve: 'yes' }, { id: '1', base: 'x', directive: '', resolve: true }]) {
      assert.equal((await s.put('page.html', body)).status, 400, JSON.stringify(body));
    }
  }));


test('Done announces what the box changed: a revision and a directive, under its heading', () =>
  withServer(async (s) => {
    const { document, bases, markdowns } = await s.page('page.html');
    const p = idOf(document, 'p');
    const opened = { id: p, directive: '', markdown: markdowns[p] };
    const saved = await (await s.put('page.html', { id: p, base: bases[p], markdown: 'First *paragraph*' })).json();
    await s.put('page.html', { id: p, base: saved.bases[p], directive: 'say more -- here' });
    assert.deepEqual(await (await s.done('page.html', opened)).json(), { announced: true });
    await s.waitForLog('\n\{', 1);
    const thread = announcements(s.stdout)[0]?.thread;
    assert.match(thread, /^[0-9a-f]{12}$/, 'the base a reply sends back');
    assert.deepEqual(announcements(s.stdout), [{
      page: '/page.html',
      id: p,
      element: 'p',
      heading: 'Title',
      directive: { before: '', after: 'say more - - here' },
      revision: { before: 'First paragraph', after: 'First *paragraph*' },
      thread,
    }]);
    assert.doesNotMatch(s.stdout, /saved|pending/, 'saves print nothing');
  }));

test('Done with nothing changed announces nothing; a directive alone is no revision', () =>
  withServer(async (s) => {
    const { document, bases, markdowns } = await s.page('page.html');
    const p = idOf(document, 'p');
    const img = idOf(document, 'img');
    assert.deepEqual(await (await s.done('page.html', { id: p, directive: '', markdown: markdowns[p] })).json(), { announced: false });
    assert.deepEqual(await (await s.done('page.html', { id: 'nope', directive: '' })).json(), { announced: false });
    await s.put('page.html', { id: img, base: bases[img], directive: 'bigger' });
    await s.done('page.html', { id: img, directive: '' });
    await s.waitForLog('\n\{', 1);
    const thread = announcements(s.stdout)[0]?.thread;
    assert.deepEqual(announcements(s.stdout), [{
      page: '/page.html', id: img, element: 'img', heading: 'Title', directive: { before: '', after: 'bigger' }, thread,
    }]);
  }));


test('a reply lands after the last turn, with the base the Announcement carried', () =>
  withServer(async (s) => {
    const { id, announced } = await directAndAnnounce(s, 'page.html', 'p', 'add a diagram');
    assert.match(announced.thread, /^[0-9a-f]{12}$/);
    const res = await s.put('page.html', { id, thread: announced.thread, reply: 'Added one -- below.' });
    assert.equal(res.status, 200);
    const answer = await res.json();
    assert.equal(answer.ok, true);
    assert.equal(answer.count, 0, 'the thread ends in a reply: no open directive');
    assert.notEqual(answer.after, answer.before);
    assert.match(s.read('page.html'), /<!-- @AI: add a diagram -->\s*<!-- @Human: Added one - - below. -->/);
    const { threads, directives } = await s.page('page.html');
    assert.deepEqual(threads[id], [{ prefix: '@AI', text: 'add a diagram' }, { prefix: '@Human', text: 'Added one - - below.' }]);
    assert.deepEqual(directives, {});
    const second = await s.put('page.html', { id, thread: answer.thread, reply: 'And a caption.' });
    assert.equal(second.status, 200, 'the answer\'s base takes a second reply');
    assert.match(s.read('page.html'), /<!-- @Human: Added one - - below. -->\s*<!-- @Human: And a caption. -->/);
  }));

test('a reply to a thread that changed since is stale: 412 with the turn to read, and nothing written', () =>
  withServer(async (s) => {
    const { id, announced } = await directAndAnnounce(s, 'page.html', 'p', 'add a diagram');
    const { bases } = await s.page('page.html');
    await s.put('page.html', { id, base: bases[id], directive: 'add a diagram\nand a caption' });
    const before = s.read('page.html');
    const res = await s.put('page.html', { id, thread: announced.thread, reply: 'Added one.' });
    assert.equal(res.status, 412);
    const answer = await res.json();
    assert.deepEqual({ ...answer, thread: typeof answer.thread }, { ok: false, error: 'its thread changed since', directive: 'add a diagram\nand a caption', thread: 'string' });
    assert.equal(s.read('page.html'), before);
    assert.equal((await s.put('page.html', { id, thread: answer.thread, reply: 'Added both.' })).status, 200);
    assert.match(s.read('page.html'), /and a caption -->\s*<!-- @Human: Added both. -->/);
  }));

test('a directive save that saw fewer replies than the thread has is 412, so a turn typed before a reply lands once', () =>
  withServer(async (s) => {
    const { id, announced } = await directAndAnnounce(s, 'page.html', 'p', 'add a diagram');
    const { bases } = await s.page('page.html');
    assert.equal((await s.put('page.html', { id, base: bases[id], directive: 'add a diagram', replies: 0 })).status, 200);
    await s.put('page.html', { id, thread: announced.thread, reply: 'Added one.' });
    const before = s.read('page.html');
    const res = await s.put('page.html', { id, base: bases[id], directive: 'add a diagram with arrows', replies: 0 });
    assert.equal(res.status, 412);
    assert.deepEqual(await res.json(), { ok: false, error: 'a reply came in on that thread', replies: 1 });
    assert.equal(s.read('page.html'), before);
    assert.equal((await s.put('page.html', { id, base: bases[id], directive: 'with arrows', replies: 1 })).status, 200);
    assert.match(s.read('page.html'), /add a diagram -->\s*<!-- @Human: Added one. -->\s*<!-- @AI: with arrows -->/);
    for (const replies of [-1, 1.5, '1']) {
      assert.equal((await s.put('page.html', { id, base: bases[id], directive: 'x', replies })).status, 400, String(replies));
    }
    assert.equal((await s.put('page.html', { id, base: bases[id], resolve: true, replies: 1 })).status, 400, 'replies goes with a directive');
  }));

test('a reply to an element with no thread, or one that is gone, is refused', () =>
  withServer(async (s) => {
    const { id, announced } = await directAndAnnounce(s, 'page.html', 'p', 'add a diagram');
    const { bases } = await s.page('page.html');
    await s.put('page.html', { id, base: bases[id], resolve: true });
    const before = s.read('page.html');
    const resolved = await s.put('page.html', { id, thread: announced.thread, reply: 'Done.' });
    assert.equal(resolved.status, 412);
    assert.deepEqual(await resolved.json(), { ok: false, error: 'that element has no directive to reply to' });
    const gone = await s.put('page.html', { id: '999', thread: announced.thread, reply: 'Done.' });
    assert.deepEqual(await gone.json(), { ok: false, error: 'that element is gone from the file' });
    assert.equal(s.read('page.html'), before);
  }));

test('a reply body is an id, a thread base, and text', () =>
  withServer(async (s) => {
    for (const body of [{ id: '1', reply: 'a' }, { id: '1', thread: 'x', reply: ' ' }, { id: 1, thread: 'x', reply: 'a' }, { id: '1', thread: 'x', reply: 'a', base: 'y' }, { id: '1', thread: 'x', reply: 'a', directive: 'b' }]) {
      assert.equal((await s.put('page.html', body)).status, 400, JSON.stringify(body));
    }
  }));

test('replies and saves that arrive together all land: the server writes one at a time', () =>
  withServer(async (s) => {
    const { id, announced } = await directAndAnnounce(s, 'page.html', 'p', 'add a diagram');
    const { document, bases } = await s.page('page.html');
    const items = [...document.querySelectorAll('li')].map((li) => li.getAttribute('data-hrv'));
    const h1 = idOf(document, 'h1');
    let thread = announced.thread;
    const replies = (async () => {
      for (const n of [1, 2, 3, 4, 5]) {
        const answer = await (await s.put('page.html', { id, thread, reply: `reply ${n}` })).json();
        assert.equal(answer.ok, true, `reply ${n}`);
        thread = answer.thread;
      }
    })();
    const saves = [h1, ...items].map((e, n) => s.put('page.html', { id: e, base: bases[e], directive: `save ${n}` }));
    const answers = await Promise.all(saves);
    await replies;
    assert.deepEqual(answers.map((r) => r.status), [200, 200, 200]);
    const file = s.read('page.html');
    for (const n of [1, 2, 3, 4, 5]) assert.match(file, new RegExp(`@Human: reply ${n} -->`));
    for (const n of [0, 1, 2]) assert.match(file, new RegExp(`@AI: save ${n} -->`));
  }));

// The reply CLI, run as the agent runs it. Resolves to its exit status and output.
function runReply(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, '..', 'reply.mjs'), ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

test('reply CLI: the agent replies through the running server, and hears when it is stale', () =>
  withServer(async (s) => {
    const { id, announced } = await directAndAnnounce(s, 'page.html', 'p', 'add a diagram');
    const page = s.base + 'page.html';
    const landed = await runReply([page, id, announced.thread, "Added one. It's below."]);
    assert.equal(landed.status, 0, landed.stderr);
    assert.equal(JSON.parse(landed.stdout).ok, true);
    assert.equal(landed.stdout.split('\n').length, 2, 'one line of JSON');
    assert.match(s.read('page.html'), /<!-- @Human: Added one. It's below. -->/);
    const stale = await runReply([page, id, announced.thread, 'Again.']);
    assert.equal(stale.status, 1);
    assert.deepEqual(JSON.parse(stale.stdout), { ok: false, error: 'its thread changed since', directive: '', thread: JSON.parse(landed.stdout).thread });
  }));

test('reply CLI: usage, and a server that is not there', async () => {
  for (const args of [[], ['http://localhost:1/x.html', '1', 'abc'], ['x.html', '1', 'abc', 'text'], ['http://localhost:1/x.html', '1', 'abc', 'text', 'more']]) {
    const { status, stderr } = await runReply(args);
    assert.equal(status, 2, JSON.stringify(args));
    assert.match(stderr, /^usage: node reply.mjs <page URL> <id> <thread> <text>/);
  }
  const away = await runReply(['http://localhost:1/x.html', '1', 'abc', 'text']);
  assert.equal(away.status, 1);
  assert.match(away.stderr, /no server answers at http:\/\/localhost:1: is it running\?/);
});

test('a Done body must be an id, the directive, and for a scope the markdown', () =>
  withServer(async (s) => {
    for (const body of [{}, { id: '1' }, { id: 1, directive: '' }, { id: '1', directive: '', markdown: 3 }]) {
      assert.equal((await s.done('page.html', body)).status, 400, JSON.stringify(body));
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

// Start the server on one file in a fresh copy of the fixtures. `done` resolves with the
// startup line, or with the exit code and stderr if the server stops instead.
function startOnFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-revisor-'));
  fs.cpSync(path.join(here, 'fixtures'), dir, { recursive: true });
  const child = spawn(process.execPath, [serverFile, path.join(dir, name), '--port', '0'], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no startup line; stderr: ${stderr}`)), 5000);
    child.stdout.on('data', () => {
      if (!stdout.includes('\n')) return;
      clearTimeout(timer);
      resolve({ line: stdout.trim() });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
  const stop = () => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, done, stop };
}

test('given a file, the server formats it before serving and announces its URL', async () => {
  const s = startOnFile('messy.html');
  try {
    const { line } = await s.done;
    const m = line.match(/^html-revisor: (http:\/\/localhost:\d+\/messy\.html) serving (.*)$/);
    assert.ok(m, `startup line: ${line}`);
    assert.equal(fs.realpathSync(m[2]), fs.realpathSync(s.dir));
    const onDisk = fs.readFileSync(path.join(s.dir, 'messy.html'), 'utf8');
    assert.equal(normalize(onDisk), onDisk, 'formatted before the first GET');
    assert.equal((await fetch(m[1])).status, 200);
    assert.equal(fs.readFileSync(path.join(s.dir, 'messy.html'), 'utf8'), onDisk, 'the GET changes nothing more');
  } finally {
    s.stop();
  }
});

test('given a file the formatter cannot handle, the server exits with its message', async () => {
  const s = startOnFile('missing.html');
  try {
    const { code, stderr } = await s.done;
    assert.equal(code, 1);
    assert.match(stderr, /missing\.html: /);
  } finally {
    s.stop();
  }
});
