// The harness the acceptance tests share: a live server on a fresh copy of the fixtures,
// and the helpers that read what it serves and logs. The tests sit in acceptance.test.mjs and
// live-notice.test.mjs, because node --test runs files side by side and the live notice
// tests spend their time waiting to hear that nothing comes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { parseHTML } from '../vendor/linkedom.mjs';
import { createServer } from '../server.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const serverFile = path.join(here, '..', 'server.mjs');

// The environment without any telemetry settings this shell might carry. With them, the
// server prints a telemetry line first and sends every test's spans out.
export const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OTEL_|HRV_TELEMETRY)/.test(k)));

// Run fn with a live server whose root is a fresh copy of the fixtures. With no args the
// server runs in this process, from createServer, and its console lines are the log. With
// CLI args it runs as the CLI runs it: server.mjs in a child process, its stdout the log.
export async function withServer(fn, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-revisor-'));
  fs.cpSync(path.join(here, 'fixtures'), dir, { recursive: true });
  const run = args ? spawned(dir, args) : inProcess(dir);
  const server = {
    dir,
    get stdout() { return run.stdout; },
    get stderr() { return run.stderr; },
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
      const markdowns = JSON.parse(document.querySelector('script#hrv-markdown').textContent);
      const committed = JSON.parse(document.querySelector('script#hrv-committed').textContent);
      const threads = JSON.parse(document.querySelector('script#hrv-threads').textContent);
      return { res, html, document, bases, markdowns, committed, threads, version: json.getAttribute('data-version'), directives: JSON.parse(json.textContent) };
    },
    // PUT one change, as the tab sends it: {id, base, directive} or {id, base, markdown}.
    put: (name, change) =>
      fetch(server.base + name, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      }),
    // POST Done, as the tab sends it when the box closes: {id, directive, markdown} as the box opened.
    done: (name, opened) =>
      fetch(server.base + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opened),
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
        if ((run.stdout.match(new RegExp(re, 'g')) ?? []).length >= count) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(`log never matched ${re}; got:\n${run.stdout}`);
    },
  };
  try {
    server.base = await run.started;
    await fn(server);
  } finally {
    await run.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The server from createServer, in this process. Tests in a file run one at a time,
// so the console is this server's alone while it runs.
function inProcess(dir) {
  const run = { stdout: '', stderr: '' };
  const { log, error } = console;
  console.log = (...a) => (run.stdout += format(...a) + '\n');
  console.error = (...a) => (run.stderr += format(...a) + '\n');
  const server = createServer({ root: dir, author: '@AI' });
  run.started = new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://localhost:${server.address().port}/`)));
  run.stop = async () => {
    await new Promise((r) => server.close(r));
    Object.assign(console, { log, error });
  };
  return run;
}

// server.mjs as the CLI runs it, in a child process; started resolves to the URL its startup line names.
function spawned(dir, args) {
  const child = spawn(process.execPath, [serverFile, dir, '--port', '0', ...args], { env });
  const run = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (run.stdout += d));
  child.stderr.on('data', (d) => (run.stderr += d));
  run.started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no startup line; stderr: ${run.stderr}`)), 5000);
    child.stdout.on('data', () => {
      const m = run.stdout.match(/html-revisor: (http:\/\/localhost:\d+\/) serving/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}; stderr: ${run.stderr}`)));
  });
  run.stop = () => child.kill();
  return run;
}

export const idOf = (document, selector) => document.querySelector(selector).getAttribute('data-hrv');
export const countOf = (text, needle) => text.split(needle).length - 1;

// The JSON lines on stdout: the Announcements.
export const announcements = (stdout) => stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));

// The flow a reply answers: the tab saves a directive and closes the box, and the Announcement
// carries the thread's base. Returns the element's ID and that Announcement.
export async function directAndAnnounce(s, name, selector, directive) {
  const { document, bases } = await s.page(name);
  const id = idOf(document, selector);
  await s.put(name, { id, base: bases[id], directive });
  await s.done(name, { id, directive: '' });
  await s.waitForLog(`"id":"${id}"`);
  return { id, announced: announcements(s.stdout).findLast((a) => a.id === id) };
}
