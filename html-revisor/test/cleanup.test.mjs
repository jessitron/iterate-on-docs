// The cleanup: node cleanup.mjs <file>... takes directives and element IDs out of each file.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup } from '../domain/cleanup.mjs';
import { normalize } from '../domain/format.mjs';
import { parse, serialize } from '../domain/canonical.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cleanupFile = path.join(here, '..', 'cleanup.mjs');
const run = (...args) => spawnSync(process.execPath, [cleanupFile, ...args], { encoding: 'utf8' });

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-revisor-cleanup-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

const page = normalize(
  '<h1><!-- @AI: shorter --> Title</h1>\n' +
    '<p>Write <code>&lt;!-- @AI: ... --&gt;</code> to leave a directive.</p>\n' +
    '<ul><li><!-- @AI: say more\nand why -->One</li><li>Two</li></ul>\n' +
    '<!-- @AI: about the image --><img src="a.png" alt="a">\n' +
    '<!-- an ordinary comment -->\n' +
    '<svg viewBox="0 0 10 10"><text x="1" y="5"><!-- @AI: bigger -->hi</text></svg>',
);
const clean = serialize(
  parse(
    '<h1>Title</h1>\n' +
      '<p>Write <code>&lt;!-- @AI: ... --&gt;</code> to leave a directive.</p>\n' +
      '<ul><li>One</li><li>Two</li></ul>\n' +
      '<img src="a.png" alt="a">\n' +
      '<!-- an ordinary comment -->\n' +
      '<svg viewBox="0 0 10 10"><text x="1" y="5">hi</text></svg>',
  ),
);

test('takes out directives and element IDs, and keeps the layout', () => {
  assert.match(page, /data-hrv="\d+"/);
  assert.match(page, /data-hrv-next=/);
  const { html, removed } = cleanup(page);
  assert.equal(html, clean);
  assert.deepEqual(removed, ['shorter', 'say more\nand why', 'about the image', 'bigger']);
});

test('keeps text that talks about directives, and other comments', () => {
  const { html } = cleanup(page);
  assert.match(html, /<code>&lt;!-- @AI: \.\.\. --&gt;<\/code>/);
  assert.match(html, /<!-- an ordinary comment -->/);
});

test('a clean page comes back the same', () => {
  assert.deepEqual(cleanup(clean), { html: clean, removed: [] });
});

test('another author: takes out only that author\'s directives', () => {
  const mixed = normalize('<p><!-- @jess: mine --><!-- @AI: theirs -->x</p>');
  const { html, removed } = cleanup(mixed, '@jess');
  assert.deepEqual(removed, ['mine']);
  assert.match(html, /<!-- @AI: theirs -->/);
});

test('the frozen pages clean up with no IDs or directives left', () => {
  const pages = path.join(here, 'pages');
  for (const name of fs.readdirSync(pages).filter((f) => f.endsWith('.html'))) {
    const { html } = cleanup(fs.readFileSync(path.join(pages, name), 'utf8'));
    assert.doesNotMatch(html, /<[^>]* data-hrv/, name); // OVERVIEW shows data-hrv in its text
    assert.doesNotMatch(html, /<!-- *@AI:/, name);
    assert.equal(cleanup(html).html, html, `${name}: a second cleanup changes nothing`);
  }
});

test('CLI: rewrites in place and lists what it took out', () => {
  const file = tempFile('page.html', page);
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    [`${file}: shorter`, `${file}: say more and why`, `${file}: about the image`, `${file}: bigger`, ''].join('\n'),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), clean);
});

test('CLI: a clean file is silent and not rewritten', () => {
  const file = tempFile('page.html', clean);
  const mtime = fs.statSync(file).mtimeMs;
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('CLI: --author picks whose directives come out', () => {
  const file = tempFile('page.html', normalize('<p><!-- @jess: mine -->x</p>'));
  const result = run('--author', '@jess', file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${file}: mine\n`);
});

test('CLI: a missing file: message on stderr, exit 1, other files still cleaned', () => {
  const file = tempFile('page.html', page);
  const missing = path.join(path.dirname(file), 'nope.html');
  const result = run(missing, file);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nope\.html: /);
  assert.equal(fs.readFileSync(file, 'utf8'), clean);
});

test('CLI: no files is a usage error', () => {
  const result = run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage: /);
});
