// A spill: markdown saved into a scope makes HTML the file can't hold inside the scope's element,
// as a <p> typed in a paragraph. settle reads the save back the way the file will, and the next
// save from the same box replaces the scope and its spill together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from '../domain/canonical.mjs';
import { ID, assignIds, elementById } from '../domain/identity.mjs';
import { scopeElements } from '../domain/scopes.mjs';
import { saveMarkdown, settle, spillOf, spillIds, holderOf } from '../domain/markdown-edits.mjs';

const page = '<html><head></head><body><h1>T</h1><p>one</p><p>two</p></body></html>';

// One save as the server makes it: read the file, save, settle, write. Returns the file and the
// box's next ID and spill.
function save(html, id, markdown, spill = []) {
  const document = parse(html);
  assignIds(document);
  const el = elementById(document, id);
  const saved = saveMarkdown(el, markdown, spillOf(el, spill));
  const settled = settle(document, saved);
  const holder = holderOf(settled.nodes, id, new Set(scopeElements(settled.document)));
  return { html: serialize(settled.document), id: holder, spill: spillIds(settled.nodes, holder), nodes: settled.nodes };
}

const texts = (html) => [...parse(html).querySelectorAll('p')].map((p) => p.textContent.trim());

function start() {
  const document = parse(page);
  assignIds(document);
  return { html: serialize(document), id: document.querySelector('p').getAttribute(ID) };
}

test('a <p> in a paragraph’s markdown settles as the file reads it: three paragraphs, and the box spills into two', () => {
  const { html, id } = start();
  const once = save(html, id, 'I edited a <p>, with newlines');
  assert.deepEqual(texts(once.html), ['I edited a', ', with newlines', '', 'two']);
  assert.equal(once.id, id, 'the paragraph keeps its ID');
  assert.equal(once.spill.length, 2);
  assert.equal(serialize(parse(once.html)), once.html, 'what the file holds reads back the same');
});

test('two saves in a row with a <p>: the second replaces the first one’s split', () => {
  const { html, id } = start();
  const once = save(html, id, 'I edited a <p>, with newlines');
  const twice = save(once.html, once.id, 'I edited a <p>, with newlines, and got', once.spill);
  assert.deepEqual(texts(twice.html), ['I edited a', ', with newlines, and got', '', 'two']);
  const fixed = save(twice.html, twice.id, 'I edited a `<p>`', twice.spill);
  assert.deepEqual(texts(fixed.html), ['I edited a <p>', 'two']);
  assert.deepEqual(fixed.spill, [], 'no spill once the markdown fits');
});

test('a <p> at the start leaves the paragraph empty, and it still holds the box', () => {
  const { html, id } = start();
  const once = save(html, id, '<p>x');
  assert.deepEqual(texts(once.html), ['', 'x', '', 'two']);
  assert.equal(once.id, id);
  const twice = save(once.html, once.id, 'x', once.spill);
  assert.deepEqual(texts(twice.html), ['x', 'two']);
});

test('markdown that fits leaves the document alone: settle does no read-back', () => {
  const document = parse(page);
  assignIds(document);
  const saved = saveMarkdown(document.querySelector('p'), 'plain *text*');
  const settled = settle(document, saved);
  assert.equal(settled.document, document);
  assert.deepEqual(settled.nodes, saved);
});

test('a spill that is not beside the scope is none: the server answers 412', () => {
  const { html, id } = start();
  const document = parse(html);
  const el = elementById(document, id);
  assert.equal(spillOf(el, ['1']), null, 'the body is not a sibling');
  assert.equal(spillOf(el, [id]), null, 'nor is the scope itself');
  assert.deepEqual(spillOf(el, []), []);
});
