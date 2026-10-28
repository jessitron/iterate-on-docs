// Acceptance tests of the live notice: the event stream that tells an open tab its page changed.
// Many check that nothing more comes for a while, so they sit in a file of their own and run
// beside acceptance.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprint } from '../domain/bases.mjs';
import { createServer } from '../server.mjs';
import { here, withServer, idOf, directAndAnnounce } from './acceptance-lib.mjs';

// Open a page's event stream, as the tab's EventSource does. next() resolves to the next
// notice, the data of a change event; none(ms) checks that nothing comes for that long.
async function listen(s, name) {
  const abort = new AbortController();
  const res = await fetch(s.base + name, { headers: { Accept: 'text/event-stream' }, signal: abort.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const notices = [];
  let wake = () => {};
  (async () => {
    let buffer = '';
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (event) notices.push({ event, ...JSON.parse(data) });
        wake();
      }
    }
  })().catch(() => {});
  let read = 0;
  const stream = {
    async next(ms = 2000) {
      const until = Date.now() + ms;
      while (read >= notices.length) {
        if (Date.now() > until) assert.fail(`no notice in ${ms} ms; had ${JSON.stringify(notices)}`);
        await new Promise((r) => { wake = r; setTimeout(r, 20); });
      }
      const { event, ...notice } = notices[read++];
      assert.equal(event, 'change');
      return notice;
    },
    async none(ms = 400) {
      await new Promise((r) => setTimeout(r, ms));
      assert.deepEqual(notices.slice(read), [], 'no more notices');
    },
    close: () => abort.abort(),
  };
  return stream;
}

// The page's state as the tab fetches it after a notice.
const stateOf = async (s, name) => {
  const res = await fetch(s.base + name, { headers: { Accept: 'application/json' } });
  assert.equal(res.status, 200);
  return res.json();
};

test('live notice: the stream opens with the version the page served', () =>
  withServer(async (s) => {
    const { version } = await s.page('page.html');
    const tab = await listen(s, 'page.html');
    assert.deepEqual(await tab.next(), { version, cause: 'connect' });
    await tab.none();
    tab.close();
  }));

test('live notice: a save goes to every open tab once, with the version its answer names', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const p = idOf(document, 'p');
    const tabs = [await listen(s, 'page.html'), await listen(s, 'page.html')];
    for (const tab of tabs) await tab.next();
    const answer = await (await s.put('page.html', { id: p, base: bases[p], directive: 'shorter' })).json();
    for (const tab of tabs) {
      assert.deepEqual(await tab.next(), { version: answer.after, cause: 'directive', id: p });
    }
    // The server's own write is not news again when the watcher sees it.
    for (const tab of tabs) await tab.none();
    // A save that changes nothing writes nothing, and says nothing.
    await s.put('page.html', { id: p, base: bases[p], directive: 'shorter' });
    await tabs[0].none();
    tabs.forEach((tab) => tab.close());
  }));

test('live notice: a reply goes to the tab, and the state it fetches holds the thread', () =>
  withServer(async (s) => {
    const { id, announced } = await directAndAnnounce(s, 'page.html', 'p', 'add a diagram');
    const tab = await listen(s, 'page.html');
    await tab.next();
    const answer = await (await s.put('page.html', { id, thread: announced.thread, reply: 'Added one.' })).json();
    assert.deepEqual(await tab.next(), { version: answer.after, cause: 'reply', id });
    const state = await stateOf(s, 'page.html');
    const page = await s.page('page.html');
    assert.deepEqual(state, { version: page.version, directives: page.directives, threads: page.threads, bases: page.bases });
    assert.deepEqual(state.threads[id], [{ prefix: '@AI', text: 'add a diagram' }, { prefix: '@Human', text: 'Added one.' }]);
    await tab.none();
    tab.close();
  }));

test('live notice: an edit that goes around the server is one notice, also when saved by rename', () =>
  withServer(async (s) => {
    await s.page('page.html');
    const tab = await listen(s, 'page.html');
    await tab.next();
    const edited = s.read('page.html').replace('First paragraph', 'First paragraph, edited');
    s.write('page.html', edited.slice(0, 100));   // a write in two parts, as an editor might
    s.write('page.html', edited);
    assert.deepEqual(await tab.next(), { version: fingerprint(edited), cause: 'disk' });
    await tab.none();
    // An editor's atomic save: write a new file beside it, rename it over the page.
    const again = edited.replace('Second', 'The second');
    fs.writeFileSync(path.join(s.dir, '.page.html.tmp'), again);
    fs.renameSync(path.join(s.dir, '.page.html.tmp'), path.join(s.dir, 'page.html'));
    assert.deepEqual(await tab.next(), { version: fingerprint(again), cause: 'disk' });
    // Another file in the directory is not this page's news.
    s.write('other.html', s.read('other.html') + '\n');
    await tab.none();
    tab.close();
  }));

test('live notice: the state is what GET would serve, and fetching it writes nothing', () =>
  withServer(async (s) => {
    const tab = await listen(s, 'messy.html');
    const { version: before } = await tab.next();
    const onDisk = s.read('messy.html');
    const state = await stateOf(s, 'messy.html');
    assert.equal(s.read('messy.html'), onDisk, 'the state GET leaves the file as it was');
    assert.equal(state.version, before);
    await tab.none();
    // The page's GET formats the file, and that write is a notice too.
    const page = await s.page('messy.html');
    assert.notEqual(page.version, before);
    assert.deepEqual(await tab.next(), { version: page.version, cause: 'format' });
    assert.deepEqual(state.bases, page.bases, 'numbered as the format numbers them');
    assert.deepEqual(state.directives, page.directives);
    tab.close();
  }));

test('live notice: a stream needs an html page that is there', () =>
  withServer(async (s) => {
    for (const name of ['nope.html', 'pic.svg']) {
      const res = await fetch(s.base + name, { headers: { Accept: 'text/event-stream' } });
      assert.equal(res.status, 404, name);
    }
  }));

test('live notice: closing the server ends the streams and the watchers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-revisor-'));
  fs.cpSync(path.join(here, 'fixtures'), dir, { recursive: true });
  const server = createServer({ root: dir, author: '@AI' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/page.html`, { headers: { Accept: 'text/event-stream' } });
    const reader = res.body.getReader();
    await reader.read();
    await new Promise((r) => server.close(r));
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

