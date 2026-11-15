// Catching up, as plain calls: which units a tab swaps to show the page as it is now, and which
// of its own elements it keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../domain/format.mjs';
import { readRevision } from '../domain/revision.mjs';
import { ID } from '../domain/identity.mjs';
import { catchUp } from '../domain/catch-up.mjs';

const AI = '@AI';
const page = (body) => normalize(`<html><head></head><body>${body}</body></html>`);
const BEFORE = page('<section><h2>A</h2><p>one</p><ul><li>a</li><li>b</li></ul></section><section><h2>B</h2><p>two</p></section>');
const ids = (text, selector) => [...readRevision(text).querySelectorAll(selector)].map((e) => e.getAttribute(ID));
const swapsOf = (after) => catchUp(readRevision(BEFORE), readRevision(after), AI).swaps;
const keeps = (html) => [...html.matchAll(/<!--hrv-keep (\d+)-->/g)].map((m) => m[1]);

test('nothing changed, or only a directive: no swaps', () => {
  assert.deepEqual(swapsOf(BEFORE), []);
  assert.deepEqual(swapsOf(BEFORE.replace('>one<', '><!-- @AI: hi -->one<')), []);
});

test('a changed paragraph is the one swap, whole', () => {
  const [p] = ids(BEFORE, 'p');
  const swaps = swapsOf(BEFORE.replace('>one<', '>uno<'));
  assert.deepEqual(swaps, [{ id: p, html: `<p data-hrv="${p}">uno</p>` }]);
});

test('a new element beside known ones swaps their parent, which keeps them', () => {
  const [ul] = ids(BEFORE, 'ul');
  const [a, b] = ids(BEFORE, 'li');
  const swaps = swapsOf(BEFORE.replace(/(<li[^>]*>b<\/li>)/, '$1<li>c</li>'));
  assert.deepEqual(swaps.map((w) => w.id), [ul]);
  assert.deepEqual(keeps(swaps[0].html), [a, b]);
  assert.match(swaps[0].html, /<li data-hrv="\d+">c<\/li>/);
});

test('a removed element swaps its parent; a section added at the top swaps body, keeping every section', () => {
  const [ul] = ids(BEFORE, 'ul');
  const [a, b] = ids(BEFORE, 'li');
  const removed = swapsOf(BEFORE.replace(/<li[^>]*>a<\/li>/, ''));
  assert.deepEqual(removed.map((w) => w.id), [ul]);
  assert.deepEqual(keeps(removed[0].html), [b]);
  const [body] = ids(BEFORE, 'body');
  const sections = ids(BEFORE, 'section');
  const added = swapsOf(BEFORE.replace('</body>', '<section><h2>C</h2></section></body>'));
  assert.deepEqual(added.map((w) => w.id), [body]);
  assert.deepEqual(keeps(added[0].html), sections);
  assert.ok(!keeps(added[0].html).includes(a), 'a kept unit stands for all in it');
});

test('a move swaps both parents, and the moved element is a keep in the new one', () => {
  const [, two] = ids(BEFORE, 'p');
  const [first, second] = ids(BEFORE, 'section');
  const text = readRevision(BEFORE);
  const p = text.querySelector(`[${ID}="${two}"]`);
  text.querySelector(`[${ID}="${first}"]`).append(p);
  const after = normalize(text.toString());
  const swaps = swapsOf(after);
  assert.deepEqual(swaps.map((w) => w.id).sort(), [first, second].sort());
  assert.ok(keeps(swaps.find((w) => w.id === first).html).includes(two));
});

test('a section replaced with new content is one swap; markdowns come for the scopes in and around it', () => {
  const [first] = ids(BEFORE, 'section');
  const after = BEFORE.replace(/<section data-hrv="\d+">[\s\S]*?<\/section>/, `<section data-hrv="${first}"><h2>New</h2><p>fresh</p></section>`);
  const { swaps, markdowns } = catchUp(readRevision(BEFORE), readRevision(normalize(after)), AI);
  assert.deepEqual(swaps.map((w) => w.id), [first]);
  assert.deepEqual(keeps(swaps[0].html), []);
  assert.equal(markdowns[first], '## New\n\nfresh');
  assert.ok(Object.values(markdowns).includes('fresh'));
});

test('an unknown page swaps the whole body, with every scope\'s markdown', () => {
  const { swaps, markdowns } = catchUp(null, readRevision(BEFORE), AI);
  assert.deepEqual(swaps.map((w) => w.id), ids(BEFORE, 'body'));
  assert.equal(Object.keys(markdowns).length, ids(BEFORE, '[data-hrv]').length - 1);
});
