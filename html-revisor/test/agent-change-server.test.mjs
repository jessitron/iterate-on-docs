// The agent's change through the server and change.mjs: what lands and is written, what is
// refused and what the answer holds then, the live notice, the catch-up a tab gets, and the
// trial's erased directive, end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { here, env, withServer, idOf, countOf } from './acceptance-lib.mjs';

// change.mjs, run as the agent runs it, with stdin. Resolves to its exit status and output.
function runChange(args, stdin = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, '..', 'change.mjs'), ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (status) => resolve({ status, stdout, stderr, json: stdout ? JSON.parse(stdout) : null }));
    child.stdin.end(stdin);
  });
}

const read = (s, id) => runChange([s.base + 'page.html', 'read', id]);

// The first change event on the page's stream after connect whose cause isn't connect.
async function nextChange(s, name, act) {
  const abort = new AbortController();
  const res = await fetch(s.base + name, { headers: { Accept: 'text/event-stream' }, signal: abort.signal });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let acted = false;
  try {
    for (;;) {
      const { value } = await reader.read();
      buffer += value;
      for (const block of buffer.split('\n\n').slice(0, -1)) {
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (!data) continue;
        const heard = JSON.parse(data);
        if (heard.cause === 'connect' && !acted) { acted = true; await act(); }
        else if (heard.cause !== 'connect') return heard;
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    }
  } finally {
    abort.abort();
  }
}

test('change CLI: read gives the scope and its version and writes nothing; replace lands and writes', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const p = idOf(document, 'p');
    const before = s.read('page.html');
    const got = await read(s, p);
    assert.equal(got.status, 0, got.stderr);
    assert.deepEqual(Object.keys(got.json), ['ok', 'id', 'version', 'html']);
    assert.equal(got.json.html, `<p data-hrv="${p}">First paragraph</p>`);
    assert.equal(s.read('page.html'), before, 'read writes nothing');
    const landed = await runChange([s.base + 'page.html', 'replace', p, got.json.version], '<p>First paragraph, by the agent</p>\n');
    assert.equal(landed.status, 0, landed.stderr);
    assert.equal(landed.stdout.split('\n').length, 2, 'one line of JSON');
    assert.deepEqual(landed.json, { ok: true, id: p, version: (await read(s, p)).json.version, ids: [] });
    assert.match(s.read('page.html'), new RegExp(`<p data-hrv="${p}">First paragraph, by the agent</p>`));
  }));

test('change CLI: a stale version is refused with what the scope holds now, and nothing is written', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const p = idOf(document, 'p');
    const old = (await read(s, p)).json.version;
    await s.put('page.html', { id: p, base: bases[p], markdown: 'First paragraph, yours' });
    const onDisk = s.read('page.html');
    const stale = await runChange([s.base + 'page.html', 'replace', p, old], '<p>agent</p>');
    assert.equal(stale.status, 1);
    assert.equal(stale.json.ok, false);
    assert.match(stale.json.error, /changed since your version/);
    assert.deepEqual({ ...stale.json, ok: true, error: undefined }, { ok: true, error: undefined, ...(await read(s, p)).json });
    assert.equal(s.read('page.html'), onDisk);
    const removed = await runChange([s.base + 'page.html', 'remove', p, old]);
    assert.equal(removed.status, 1, 'remove carries a version too');
    const gone = await read(s, '999');
    assert.equal(gone.status, 1);
    assert.deepEqual(gone.json, { ok: false, error: 'element 999 is gone from the page', id: '999' });
  }));

test('change CLI: add, move, and remove; HTML that can\'t go there is refused', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const [h1, ul, li] = ['h1', 'ul', 'li'].map((sel) => idOf(document, sel));
    const page = s.base + 'page.html';
    const added = await runChange([page, 'add', 'after', h1], '<p>Added</p>');
    assert.equal(added.status, 0, added.stderr);
    assert.equal(added.json.ids.length, 1);
    assert.match(s.read('page.html'), /Title<\/h1>\s*<p data-hrv="\d+">Added<\/p>/);
    const moved = await runChange([page, 'move', added.json.id, 'before', h1]);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(s.read('page.html'), /Added<\/p>\s*<h1/);
    const bad = await runChange([page, 'add', 'into', ul], '<p>not an item</p>');
    assert.equal(bad.status, 1);
    assert.deepEqual(bad.json, { ok: false, error: 'a <p> can\'t sit in a <ul>' });
    const gone = await runChange([page, 'remove', li, (await read(s, li)).json.version]);
    assert.equal(gone.status, 0, gone.stderr);
    assert.equal(countOf(s.read('page.html'), '<li'), 1);
  }));

test('change CLI: usage, and a server that is not there', async () => {
  const page = 'http://localhost:1/x.html';
  for (const args of [[], [page], [page, 'read'], [page, 'read', 'x'], [page, 'replace', '1'], [page, 'add', 'beside', '1'], [page, 'move', '1', 'after'], ['x.html', 'read', '1'], [page, 'erase', '1']]) {
    const { status, stderr } = await runChange(args);
    assert.equal(status, 2, JSON.stringify(args));
    assert.match(stderr, /^usage: node change.mjs <page URL> read <id>/);
  }
  const away = await runChange([page, 'read', '1']);
  assert.equal(away.status, 1);
  assert.match(away.stderr, /no server answers at http:\/\/localhost:1: is it running\?/);
});

test('the trial: you leave a directive inside a scope after the agent read it; its replace lands, and your directive stays', () =>
  withServer(async (s) => {
    s.write('trial.html', '<h1>Trial</h1><section><h2>Diagram</h2><p>Boxes</p><p>Arrows</p></section>');
    const { document, bases } = await s.page('trial.html');
    const [section, arrows] = [idOf(document, 'section'), [...document.querySelectorAll('p')][1].getAttribute('data-hrv')];
    const page = s.base + 'trial.html';
    const agentRead = await runChange([page, 'read', section]);
    const directive = await s.put('trial.html', { id: arrows, base: bases[arrows], directive: 'arrows go the other way' });
    assert.equal(directive.status, 200);
    // The agent rewrites the section from its read, keeping the elements' IDs as read gave them.
    const html = agentRead.json.html.replace('Boxes', 'Boxes, redrawn');
    const landed = await runChange([page, 'replace', section, agentRead.json.version], html);
    assert.equal(landed.status, 0, landed.stdout + landed.stderr);
    const file = s.read('trial.html');
    assert.match(file, /Boxes, redrawn/);
    assert.match(file, new RegExp(`<p data-hrv="${arrows}">\\s*<!-- @AI: arrows go the other way -->\\s*Arrows`));
    // And when the agent's HTML drops that paragraph, your words move up to the section.
    const again = await runChange([page, 'replace', section, landed.json.version], `<section><h2>Diagram</h2><figure>One picture</figure></section>`);
    assert.equal(again.status, 0, again.stdout);
    assert.match(s.read('trial.html'), new RegExp(`<section data-hrv="${section}">\\s*<!-- @AI: arrows go the other way -->`));
  }));

test('an agent change goes out as a live notice with cause agent and the scope\'s ID', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const p = idOf(document, 'p');
    const heard = await nextChange(s, 'page.html', async () => {
      const got = await read(s, p);
      await runChange([s.base + 'page.html', 'replace', p, got.json.version], '<p>New</p>');
    });
    assert.equal(heard.cause, 'agent');
    assert.equal(heard.id, p);
  }));

test('the state since a version: the outermost changed units, unchanged ones inside as keeps; an unknown version swaps the body', () =>
  withServer(async (s) => {
    const { document, version } = await s.page('page.html');
    const [body, p, ul] = ['body', 'p', 'ul'].map((sel) => idOf(document, sel));
    const state = async (since) => (await fetch(`${s.base}page.html?since=${since}`, { headers: { Accept: 'application/json' } })).json();
    assert.deepEqual((await state(version)).swaps, [], 'nothing changed');
    const page = s.base + 'page.html';
    await runChange([page, 'replace', p, (await read(s, p)).json.version], '<p>Changed</p>');
    await runChange([page, 'add', 'into', ul], '<li>three</li>');
    const caught = await state(version);
    assert.deepEqual(caught.swaps.map((w) => w.id), [p, ul]);
    assert.match(caught.swaps[0].html, /Changed/);
    assert.match(caught.swaps[1].html, /<!--hrv-keep \d+-->\s*<!--hrv-keep \d+-->\s*<li data-hrv="\d+">three<\/li>/);
    assert.equal(caught.markdowns[p], 'Changed');
    const whole = await state('unknown');
    assert.deepEqual(whole.swaps.map((w) => w.id), [body]);
    assert.doesNotMatch(whole.swaps[0].html, /hrv-keep/);
    assert.equal((await state(caught.version)).swaps.length, 0);
    assert.equal((await fetch(`${s.base}page.html`, { headers: { Accept: 'application/json' } }).then((r) => r.json())).swaps, undefined, 'no since, no swaps');
  }));

test('an agent change is no ack: it wears a notice', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const p = idOf(document, 'p');
    await runChange([s.base + 'page.html', 'replace', p, (await read(s, p)).json.version], '<p>New</p>');
    assert.deepEqual((await s.page('page.html')).notices, [{ id: p, kind: 'changed' }]);
  }));

test('change CLI: --because rides on the notice until the change is acked, and a change without one takes it away', () =>
  withServer(async (s) => {
    const { document } = await s.page('page.html');
    const p = idOf(document, 'p');
    const page = s.base + 'page.html';
    const first = await runChange([page, 'replace', p, (await read(s, p)).json.version, '--because', 'shorter, as you asked'], '<p>New</p>');
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual((await s.page('page.html')).notices, [{ id: p, kind: 'changed', because: 'shorter, as you asked' }]);
    await runChange([page, '--because', 'a list of one', 'add', 'after', p], '<ul><li>x</li></ul>');
    const added = (await s.page('page.html')).notices.find((n) => n.kind === 'new');
    assert.equal(added.because, 'a list of one');
    await runChange([page, 'replace', p, first.json.version], '<p>Newer</p>');
    assert.deepEqual((await s.page('page.html')).notices.find((n) => n.id === p), { id: p, kind: 'changed' });
    assert.equal((await runChange([page, 'read', p, '--because', 'x'])).status, 2, 'read takes none');
    assert.equal((await runChange([page, 'remove', p, 'v', '--because'])).status, 2, 'the flag needs its words');
  }));

test('a PUT agent change must be one of the four shapes', () =>
  withServer(async (s) => {
    for (const body of [{ change: 'remove', id: '1', version: 'x', because: 7 },{ change: 'erase', id: '1' }, { change: 'replace', id: '1', html: 'x' }, { change: 'add', where: 'beside', id: '1', html: 'x' }, { change: 'move', id: '1', where: 'after' }, { change: 'remove', id: 1, version: 'x' }]) {
      assert.equal((await s.put('page.html', body)).status, 400, JSON.stringify(body));
    }
  }));
