// The formatter CLI: node formatter.mjs <file>... rewrites each file in place.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../formatter.mjs';

const formatterFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'formatter.mjs');
const run = (...files) => spawnSync(process.execPath, [formatterFile, ...files], { encoding: 'utf8' });

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-revisor-formatter-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

const messy = '<h1>Title</h1>\n<p>Ship   the <b>formatter</b>\n   first.</p>';

test('rewrites the file in place into canonical form, silent', () => {
  const file = tempFile('page.html', messy);
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const out = fs.readFileSync(file, 'utf8');
  assert.equal(out, normalize(messy));
  assert.match(out, /^<!DOCTYPE html>\n<html data-hrv-next="\d+">\n/);
  assert.match(out, /<p data-hrv="\d+">Ship the <strong>formatter<\/strong> first\.<\/p>/);
});

test('a second run changes nothing', () => {
  const file = tempFile('page.html', messy);
  assert.equal(run(file).status, 0);
  const once = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), once);
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'a canonical file is not rewritten');
});

test('formats every file given', () => {
  const a = tempFile('a.html', '<p>a</p>');
  const b = tempFile('b.html', '<p>b</p>');
  assert.equal(run(a, b).status, 0);
  assert.equal(fs.readFileSync(a, 'utf8'), normalize('<p>a</p>'));
  assert.equal(fs.readFileSync(b, 'utf8'), normalize('<p>b</p>'));
});

test('a missing file: message on stderr, nonzero exit, other files still formatted', () => {
  const good = tempFile('good.html', '<p>ok</p>');
  const missing = path.join(path.dirname(good), 'nope.html');
  const result = run(missing, good);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nope\.html/);
  assert.equal(result.stdout, '');
  assert.equal(fs.readFileSync(good, 'utf8'), normalize('<p>ok</p>'));
});

test('no arguments: usage on stderr, exit 2', () => {
  const result = run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
});

test('importing the formatter does not run the CLI', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(formatterFile)})`], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
