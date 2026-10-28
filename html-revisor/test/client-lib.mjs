// The tab: client.js run in a page made of linkedom, against a real server on a copy of the
// fixtures. No browser: the tab has no layout, so a test checks what the box, the markers, and
// the docket say and what reaches the file, not where anything sits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseHTML } from '../vendor/linkedom.mjs';
import { createServer } from '../server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
export const FAST = 10;   // how much faster the tab's timers run than a browser's

// A server on a fresh copy of the fixtures, in this process. s.down = true makes the tab's
// fetches fail as a browser's do when the server is stopped.
export async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-revisor-client-'));
  fs.cpSync(path.join(here, 'fixtures'), dir, { recursive: true });
  const server = createServer({ root: dir, author: '@AI' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const log = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));   // the server's lines: Announcements and conflicts
  try {
    await fn({
      dir, base, down: false,
      announcements: () => lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)),
      read: (name) => fs.readFileSync(path.join(dir, name), 'utf8'),
      write: (name, text) => fs.writeFileSync(path.join(dir, name), text),
    });
  } finally {
    console.log = log;
    // Close the sockets too: one a PUT used just before the end otherwise holds close() for 3 s.
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// An EventSource over fetch: the tab hears the server's live notices.
function eventSourceFor(base, streams) {
  return class {
    constructor(url) {
      this.listeners = {};
      this.abort = new AbortController();
      streams.push(this);
      fetch(base + url, { headers: { Accept: 'text/event-stream' }, signal: this.abort.signal }).then(async (res) => {
        let buffer = '';
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = block.match(/^event: (.*)$/m)?.[1];
            const data = block.match(/^data: (.*)$/m)?.[1];
            if (event) this.heard = true;   // the server's first event says it has the stream
            (this.listeners[event] ?? []).forEach((f) => f({ data }));
          }
        }
      }).catch(() => {});
    }
    addEventListener(type, f) { (this.listeners[type] ??= []).push(f); }
    close() { this.abort.abort(); }
  };
}

// Open a page in a tab: GET it, parse it, and run client.js on it. The tab's fetches go to the
// server; its localStorage is a Map that a second tab can share.
export async function openTab(s, name, { storage = new Map() } = {}) {
  const html = await (await fetch(`${s.base}/${name}`)).text();
  const window = parseHTML(html);
  const { document } = window;
  // What linkedom leaves out, that the client calls.
  const proto = window.HTMLElement.prototype;
  const scrolled = [];
  proto.scrollIntoView = function () { scrolled.push(this); };
  proto.setSelectionRange ??= function () {};
  proto.select ??= function () {};
  // Focus, as a browser keeps it: only a focusable element takes it, the one it leaves hears
  // blur, and a focused element taken out of the page leaves it on the body.
  let focused = null;
  proto.focus = function () {
    if (focused === this || !this.matches('a[href], button, input, select, textarea, [tabindex]')) return;
    const was = focused;
    focused = null;
    was?.dispatchEvent(new window.Event('blur'));
    focused = this;
    this.dispatchEvent(new window.Event('focus'));
  };
  Object.defineProperty(document, 'activeElement', { get: () => (focused?.isConnected ? focused : document.body) });
  document.execCommand = () => false;
  Object.assign(window.Node, { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 });
  const streams = [];
  const timers = new Set();
  const context = {
    window, document, Node: window.Node, Element: window.Element, Event: window.Event,
    location: { pathname: '/' + name },
    navigator: { platform: 'MacIntel', sendBeacon: () => true },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (f) => setTimeout(f, 0),
    // Chrome's words when nothing answers.
    fetch: (url, options) => (s.down ? Promise.reject(new TypeError('Failed to fetch')) : fetch(s.base + url, options)),
    EventSource: eventSourceFor(s.base, streams),
    // The tab's clock runs fast: its waits (the 400 ms save, the 2 s green ring) take a tenth.
    setTimeout: (f, ms) => { const t = setTimeout(() => { timers.delete(t); f(); }, (ms ?? 0) / FAST); timers.add(t); return t; },
    clearTimeout: (t) => { timers.delete(t); clearTimeout(t); },
    crypto, performance, Blob, Uint8Array, JSON,
  };
  Object.assign(window, { scrollX: 0, scrollY: 0, EventSource: context.EventSource });
  vm.createContext(context);
  vm.runInContext(clientSource, context);
  const layer = document.getElementById('hrv-layer');
  const el = (selector) => document.querySelector(selector);
  const tab = {
    window, document, layer, el,
    // The element the docket last stepped to: its tag. No layout, so no tip shows.
    steppedTo: () => scrolled.at(-1)?.localName,
    steps: () => scrolled.length,
    idOf: (selector) => el(selector).getAttribute('data-hrv'),
    box: () => layer.querySelector('.hrv-box'),
    field: () => layer.querySelector('.hrv-box textarea.hrv-directive'),
    content: () => layer.querySelector('.hrv-box textarea.hrv-text'),
    marker: (selector) => layer.querySelector(`.hrv-marker[data-for="${tab.idOf(selector)}"]`),
    turns: () => [...layer.querySelectorAll('.hrv-box .hrv-turn')].map((t) => [t.querySelector('.hrv-who').textContent, t.querySelector('.hrv-says').textContent]),
    docket: () => layer.querySelector('.hrv-docket'),
    count: () => layer.querySelector('.hrv-docket-main:not(.hrv-row2) > span:last-child').textContent,
    message: () => layer.querySelector('.hrv-docket-msg').textContent,
    hint: () => layer.querySelector('.hrv-box .hrv-hint').textContent,   // the box's footer
    label: () => layer.querySelector('.hrv-box textarea.hrv-directive').previousElementSibling.firstChild.textContent,
    click(node) { node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); },
    open(selector) { tab.click(el(selector)); },
    type(text, field = tab.field()) {
      field.value = text;
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    button(text) { return [...layer.querySelectorAll('.hrv-box button')].find((b) => b.textContent === text); },
    done() { tab.click(tab.button('Done')); },
    connected: () => until(() => streams.some((e) => e.heard)),
    // The tab stops hearing live notices, as when one is on its way while the tab saves.
    deafen() { streams.forEach((e) => e.close()); },
    close() { streams.forEach((e) => e.close()); timers.forEach((t) => clearTimeout(t)); },
  };
  await tab.connected();
  return tab;
}

// ms is how long to wait. A message there would make the wait endless, so it is refused.
export async function until(check, ms = 3000) {
  if (typeof ms !== 'number') throw new TypeError(`until waits ms, not ${JSON.stringify(ms)}`);
  const end = Date.now() + ms;
  for (;;) {
    const got = await check();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${check}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// The agent's reply, as reply.mjs sends it. The thread base comes from a stale try's answer,
// as an agent that read the Announcement late would get it.
export async function reply(s, name, id, text) {
  const put = (thread) => fetch(`${s.base}/${name}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, thread, reply: text }),
  }).then((res) => res.json());
  const stale = await put('none');
  const landed = await put(stale.thread);
  assert.ok(landed.ok, JSON.stringify(landed));
  return landed;
}
