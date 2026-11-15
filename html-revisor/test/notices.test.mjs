// Notices: which elements wear a mark for content that changed since you saw it. The agent's
// edits here are as it makes them: text replaced in the file, data-hrv kept on what it rewrote,
// new elements with no ID, which readRevision numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../domain/format.mjs';
import { ID } from '../domain/identity.mjs';
import { baseOf } from '../domain/bases.mjs';
import { readRevision, revise } from '../domain/revision.mjs';
import { seenOf, noticesOf, explained, ack, absorb, directed } from '../domain/notices.mjs';
import { reviseByAgent } from '../domain/agent-change.mjs';

const AI = '@AI';
const page = (body) => normalize(`<html><head></head><body>${body}</body></html>`);
const PAGE = page(`
  <h1>Title</h1>
  <section><h2>Part</h2><p>One <strong>bold</strong> line.</p><ul><li>a</li><li>b</li><li>c</li></ul></section>
  <p>Last <a href="x">link</a> words.</p>`);

// The ID of the first element a selector finds.
const idOf = (text, selector) => readRevision(text).querySelector(selector).getAttribute(ID);
// The notices on text, against what was seen of seenText, as [tag, kind] with the ID.
function noticed(seenText, text, seen = seenOf(readRevision(seenText), AI)) {
  const document = readRevision(text);
  return noticesOf(document, seen, AI).map(({ id, kind }) => [document.querySelector(`[${ID}="${id}"]`).localName, kind, id]);
}
const kinds = (list) => list.map(([tag, kind]) => [tag, kind]);

test('a page as you saw it has no notices', () => {
  assert.deepEqual(noticed(PAGE, PAGE), []);
});

test('changed text marks its scope, and only it', () => {
  const edited = PAGE.replace('One <strong>bold</strong> line.', 'One <strong>bold</strong> line, longer.');
  const found = noticed(PAGE, edited);
  assert.deepEqual(kinds(found), [['p', 'changed']]);
  assert.equal(found[0][2], idOf(PAGE, 'section p'));
});

test('an inline element that is no scope folds into its scope', () => {
  const edited = PAGE.replace('<strong>bold</strong>', '<strong>heavy</strong>');
  assert.deepEqual(kinds(noticed(PAGE, edited)), [['p', 'changed']]);
});

test('a changed link marks the link, not its paragraph', () => {
  const edited = PAGE.replace('>link</a>', '>a link</a>');
  assert.deepEqual(kinds(noticed(PAGE, edited)), [['a', 'changed']]);
});

test('a changed attribute is a change', () => {
  const edited = PAGE.replace('href="x"', 'href="y"');
  assert.deepEqual(kinds(noticed(PAGE, edited)), [['a', 'changed']]);
});

test('a new element is new, and its parent is not marked', () => {
  const edited = PAGE.replace('>c</li>', '>c</li><li>d</li>');
  assert.deepEqual(kinds(noticed(PAGE, edited)), [['li', 'new']]);
});

test('a new section with children: only the section wears the mark', () => {
  const edited = PAGE.replace('</body>', '<section><h2>More</h2><p>New words.</p></section></body>');
  assert.deepEqual(kinds(noticed(PAGE, edited)), [['section', 'new']]);
});

test('a new table row wears one mark, and the table none', () => {
  const table = page('<table><tbody><tr><td>a</td><td>1</td></tr></tbody></table>');
  const doc = readRevision(table);
  const row = doc.createElement('tr');
  row.innerHTML = '<td>b</td><td>2</td>';
  doc.querySelector('tbody').append(row);
  assert.deepEqual(kinds(noticed(table, doc.toString())), [['tr', 'new']]);
});

test('a new header row wears one mark, and the thead around it changes nothing', () => {
  const table = page('<table><tbody><tr><td>a</td></tr></tbody></table>');
  const doc = readRevision(table);
  const thead = doc.createElement('thead');
  thead.innerHTML = '<tr><th>k</th></tr>';
  doc.querySelector('table').prepend(thead);
  assert.deepEqual(kinds(noticed(table, doc.toString())), [['tr', 'new']]);
});

const TABLE = page('<table><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>');
const rowIds = (text) => [...readRevision(text).querySelectorAll('tr')].map((tr) => tr.getAttribute(ID));

test('a table edited as markdown keeps its rows\' IDs, and only the cell you changed differs', () => {
  const el = readRevision(TABLE).querySelector('table');
  const markdown = '| k | v |\n| --- | --- |\n| a | 1 |\n| bee | 2 |';
  const { written } = revise(TABLE, { id: el.getAttribute(ID), base: baseOf(el, AI), markdown }, 'markdown', AI);
  assert.deepEqual(rowIds(written), rowIds(TABLE));
  assert.deepEqual(kinds(noticed(TABLE, written)), [['td', 'changed']]);
});

test('a table the agent rewrites without IDs keeps its rows\' IDs, and an unchanged row wears no mark', () => {
  const doc = readRevision(TABLE);
  const table = doc.querySelector('table');
  const html = '<table><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>two</td></tr><tr><td>c</td><td>3</td></tr></tbody></table>';
  const out = reviseByAgent(TABLE, { change: 'replace', id: table.getAttribute(ID), version: baseOf(table, AI), html }, AI);
  assert.deepEqual(rowIds(out.written).slice(0, 3), rowIds(TABLE));
  assert.deepEqual(kinds(noticed(TABLE, out.written)), [['td', 'changed'], ['tr', 'new']]);
});

test('a removed table row changes the table', () => {
  const table = page('<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>');
  const doc = readRevision(table);
  doc.querySelector('tr:last-child').remove();
  assert.deepEqual(kinds(noticed(table, doc.toString())), [['table', 'changed']]);
});

test('a removed child changes its parent', () => {
  const b = idOf(PAGE, 'li:nth-child(2)');
  const edited = PAGE.replace(new RegExp(`\\s*<li data-hrv="${b}">b</li>`), '');
  assert.deepEqual(kinds(noticed(PAGE, edited)), [['ul', 'changed']]);
});

test('children in a new order change their parent, and not themselves', () => {
  const doc = readRevision(PAGE);
  const ul = doc.querySelector('ul');
  ul.append(ul.firstElementChild);
  assert.deepEqual(kinds(noticed(PAGE, doc.toString())), [['ul', 'changed']]);
});

test('a change nested deep marks only the inner scope', () => {
  const edited = PAGE.replace('>b</li>', '>bee</li>');
  assert.deepEqual(kinds(noticed(PAGE, edited)), [['li', 'changed']]);
});

test('a new element inside a changed one wears no mark of its own', () => {
  const edited = PAGE.replace('Last <a', 'At last, <em>see</em> <a href="z">this</a> and <a');
  assert.deepEqual(kinds(noticed(PAGE, edited)), [['p', 'changed']]);
});

test('directives, replies, element IDs, and layout are not changes', () => {
  const p = idOf(PAGE, 'section p');
  const edited = PAGE
    .replace(`<p data-hrv="${p}">`, `<p data-hrv="${p}"><!-- @AI: shorter --><!-- @Human: done -->`)
    .replace(/\n\s*/g, '\n      ')
    .replace(`<h1 data-hrv="${idOf(PAGE, 'h1')}">`, '<h1>');
  const found = noticed(PAGE, edited);
  // The h1 without its ID comes back with a new one: an element the page didn't have.
  assert.deepEqual(kinds(found), [['h1', 'new']]);
  const unchanged = PAGE.replace(`<p data-hrv="${p}">`, `<p data-hrv="${p}"><!-- @AI: shorter -->`).replace(/\n\s*/g, '\n');
  assert.deepEqual(noticed(PAGE, unchanged), []);
});

test('a change to body itself shows nowhere', () => {
  const edited = PAGE.replace(/<h1[^]*?<\/h1>/, 'Bare text');
  assert.deepEqual(noticed(PAGE, edited), []);
});

test('svg elements are units of their own', () => {
  const svg = page('<svg viewBox="0 0 10 10"><rect width="5" height="5"></rect><text x="1" y="1">Label</text></svg>');
  assert.deepEqual(kinds(noticed(svg, svg.replace('width="5"', 'width="6"'))), [['rect', 'changed']]);
  assert.deepEqual(kinds(noticed(svg, svg.replace('>Label<', '>Name<'))), [['text', 'changed']]);
});

test('ack sees a scope and everything in it', () => {
  const edited = PAGE.replace('>Part<', '>Piece<').replace('>a</li>', '>A</li>').replace('Last', 'Final');
  const document = readRevision(edited);
  const seen = seenOf(readRevision(PAGE), AI);
  assert.deepEqual(noticesOf(document, seen, AI).length, 3);
  const after = ack(seen, document, idOf(edited, 'section'), AI);
  assert.deepEqual(noticesOf(document, after, AI).map((n) => n.id), [idOf(edited, 'body > p')]);
  assert.deepEqual(noticesOf(document, ack(after, document, 'all', AI), AI), []);
  assert.equal(ack(after, document, '999', AI), after, 'an ID not in the page changes nothing');
});

test('a notice takes the agent\'s words from the nearest scope at or around it, and unused words go', () => {
  const edited = PAGE.replace('>a</li>', '>A</li>').replace('Last', 'Final');
  const document = readRevision(edited);
  const notices = noticesOf(document, seenOf(readRevision(PAGE), AI), AI);
  const [li, last, section] = [idOf(edited, 'li'), idOf(edited, 'body > p'), idOf(edited, 'section')];
  const around = explained(notices, document, new Map([[section, 'tidied the section'], ['999', 'gone']]));
  assert.deepEqual(around.notices, [{ id: li, kind: 'changed', because: 'tidied the section' }, { id: last, kind: 'changed' }]);
  assert.deepEqual([...around.becauses], [[section, 'tidied the section']], 'words no notice takes are dropped');
  const nearest = explained(notices, document, new Map([[section, 'tidied the section'], [li, 'capital A']]));
  assert.equal(nearest.notices[0].because, 'capital A');
  assert.deepEqual(explained(notices, document, new Map()).notices, notices);
});

// The notices left after a directive on the element selector finds in text, as [tag, kind].
function afterDirective(seenText, text, selector) {
  const document = readRevision(text);
  const seen = directed(seenOf(readRevision(seenText), AI), document, document.querySelector(selector).getAttribute(ID), AI);
  return kinds(noticesOf(document, seen, AI).map(({ id, kind }) => [document.querySelector(`[${ID}="${id}"]`).localName, kind]));
}

test('a directive sees the mark on its element and on each element around it', () => {
  const doc = readRevision(PAGE);
  const ul = doc.querySelector('ul');
  ul.append(ul.firstElementChild);   // the list changes: a, b, c is b, c, a
  ul.querySelector('li:nth-child(2)').textContent = 'C';
  const edited = doc.toString().replace('>Title<', '>Heading<');
  assert.deepEqual(kinds(noticed(PAGE, edited)), [['h1', 'changed'], ['ul', 'changed'], ['li', 'changed']]);
  assert.deepEqual(afterDirective(PAGE, edited, 'li:nth-child(2)'), [['h1', 'changed']]);
});

test('a directive leaves the marks on changed elements inside its own', () => {
  const doc = readRevision(PAGE);
  const ul = doc.querySelector('ul');
  ul.append(ul.firstElementChild);
  ul.querySelector('li').textContent = 'bee';
  assert.deepEqual(afterDirective(PAGE, doc.toString(), 'ul'), [['li', 'changed']]);
});

test('a directive on a new element, or in one, makes no mark appear inside it', () => {
  const added = PAGE.replace('</body>', '<section><h2>More</h2><p>New <a href="y">words</a>.</p></section></body>');
  assert.deepEqual(afterDirective(PAGE, added, 'section:last-of-type'), []);
  assert.deepEqual(afterDirective(PAGE, added, 'section:last-of-type p'), []);
  const linked = PAGE.replace('Last <a', 'Last <a href="z">new</a> and <a');
  assert.deepEqual(kinds(noticed(PAGE, linked)), [['p', 'changed']]);
  assert.deepEqual(afterDirective(PAGE, linked, 'body > p'), [], 'the new link the paragraph\'s mark covered stays unmarked');
});

test('a directive on an element not in the page changes nothing', () => {
  const seen = seenOf(readRevision(PAGE), AI);
  assert.equal(directed(seen, readRevision(PAGE), '999', AI), seen);
});

test('ack of a new child leaves its parent unmarked', () => {
  const edited = PAGE.replace('>c</li>', '>c</li><li>d</li>');
  const document = readRevision(edited);
  const [notice] = noticesOf(document, seenOf(readRevision(PAGE), AI), AI);
  const seen = ack(seenOf(readRevision(PAGE), AI), document, notice.id, AI);
  assert.deepEqual(noticesOf(document, seen, AI), []);
});

test('your own markdown edit is seen, and takes the mark off the scope you edited', () => {
  const p = idOf(PAGE, 'section p');
  const seen = seenOf(readRevision(PAGE), AI);
  // The agent changed the paragraph and the h1; you reloaded, and edit the paragraph.
  const agent = normalize(PAGE.replace('One <strong>', 'Uno <strong>').replace('>Title<', '>Heading<'));
  assert.equal(noticed(PAGE, agent, seen).length, 2);
  const el = readRevision(agent).querySelector(`[${ID}="${p}"]`);
  const revised = revise(agent, { id: p, base: baseOf(el, AI), markdown: 'Mine now.\n\nAnd a split.' }, 'markdown', AI);
  const written = readRevision(revised.written);
  const after = absorb(seen, readRevision(agent), written, revised.answer.id, AI);
  assert.deepEqual(noticesOf(written, after, AI).map((n) => written.querySelector(`[${ID}="${n.id}"]`).localName), ['h1']);
});
