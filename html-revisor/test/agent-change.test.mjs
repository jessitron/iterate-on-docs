// The agent's change, as plain calls: read, replace, add, remove, move, what each refuses, how IDs
// come out, and that your threads ride along. What the server and change.mjs do with an outcome
// is in agent-change-server.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../domain/format.mjs';
import { parse } from '../domain/canonical.mjs';
import { ID, elementById } from '../domain/identity.mjs';
import { baseOf } from '../domain/bases.mjs';
import { collectDirectives, threadsOf } from '../domain/directives.mjs';
import { readScope, reviseByAgent } from '../domain/agent-change.mjs';

const AI = '@AI';
const page = (body) => normalize(`<html><head></head><body>${body}</body></html>`);
const idAt = (text, selector) => parse(text).querySelector(selector).getAttribute(ID);
const versionOf = (text, id) => readScope(text, id, AI).version;
const directives = (text) => collectDirectives(parse(text), AI);

// The agent's change on a scope found by selector, with the version read now.
function replace(text, selector, html) {
  const id = idAt(text, selector);
  return reviseByAgent(text, { change: 'replace', id, version: versionOf(text, id), html }, AI);
}

const SECTION = '<section><h2>Plan</h2><p><!-- @AI: fix this -->One</p><ul><li><!-- @AI: and this -->a</li><li>b</li></ul></section><img src="x.png" alt="x">';

test('read: the scope with its IDs and without threads, and its version; a gone ID is null', () => {
  const text = page(SECTION);
  const id = idAt(text, 'p');
  assert.deepEqual(readScope(text, id, AI), { id, version: baseOf(elementById(parse(text), id), AI), html: `<p data-hrv="${id}">One</p>` });
  assert.equal(readScope(text, '999', AI), null);
});

test('replace lands: the root keeps the scope\'s ID, new elements get IDs, and the answer has the version now', () => {
  const text = page(SECTION);
  const p = idAt(text, 'p');
  const out = replace(text, 'p', '<p data-hrv="999">One, <strong>rewritten</strong></p>');
  assert.match(out.written, new RegExp(`<p data-hrv="${p}">`));
  assert.match(out.written, /One, <strong>rewritten<\/strong>/);
  assert.deepEqual(out.answer, { ok: true, id: p, version: versionOf(out.written, p), ids: [] });
  const grown = replace(text, 'ul', '<ul><li>a</li><li>b</li><li>c</li></ul>');
  const third = [...parse(grown.written).querySelectorAll('li')][2].getAttribute(ID);
  assert.deepEqual(grown.answer.ids, [third], 'the IDs the server gave new elements');
  assert.equal(normalize(grown.written), grown.written, 'the file is in canonical form');
});

test('replace: a version that moved is a conflict with what the scope holds now; a gone ID is a conflict too', () => {
  const text = page(SECTION);
  const p = idAt(text, 'p');
  const stale = reviseByAgent(text, { change: 'replace', id: p, version: 'old', html: '<p>x</p>' }, AI);
  assert.equal(stale.conflict.why, 'changed since');
  assert.deepEqual(stale.conflict.now, readScope(text, p, AI));
  const gone = reviseByAgent(text, { change: 'replace', id: '999', version: 'x', html: '<p>x</p>' }, AI);
  assert.equal(gone.conflict.why, 'no such element');
  assert.deepEqual(gone.conflict.now, { id: '999' });
});

test('replace refuses two roots, bare text, nothing, a document, and body', () => {
  const text = page(SECTION);
  for (const html of ['<p>a</p><p>b</p>', 'just text', '', '  <!-- a comment -->  ', '<body><p>a</p></body>']) {
    assert.ok(replace(text, 'p', html).refused, JSON.stringify(html));
  }
  assert.match(replace(text, 'body', '<body><p>a</p></body>').refused, /body/);
});

test('replace: IDs the agent kept stay; one from elsewhere, made up, or written twice comes off', () => {
  const text = page(SECTION);
  const [h2, ul, img] = ['h2', 'ul', 'img'].map((s) => idAt(text, s));
  const [a, b] = [...parse(text).querySelectorAll('li')].map((e) => e.getAttribute(ID));
  // b kept, then reordered before a; a written twice; img's ID from outside; a made-up one.
  const out = replace(text, 'section', `<section><h2 data-hrv="${h2}">Plan</h2><ul data-hrv="${ul}"><li data-hrv="${b}">b</li><li data-hrv="${a}">x</li><li data-hrv="${a}">y</li><li data-hrv="${img}">z</li><li data-hrv="777">w</li></ul></section>`);
  const doc = parse(out.written);
  const items = [...doc.querySelectorAll('li')].map((e) => e.getAttribute(ID));
  assert.equal(items[0], b, 'a kept ID stays where the agent put it');
  assert.ok(!items.slice(1).includes(a), 'copies of one ID all get fresh ones');
  assert.ok(!items.includes(img) && elementById(doc, img).localName === 'img', 'an ID from elsewhere keeps its own element');
  assert.ok(!items.includes('777'));
  assert.deepEqual(out.answer.ids, items.slice(1));
});

test('replace: elements the agent left without their IDs take them back where they pair', () => {
  const text = page(SECTION);
  const [h2, p, ul] = ['h2', 'p', 'ul'].map((s) => idAt(text, s));
  const out = replace(text, 'section', '<section><h2>Plan, again</h2><p>One</p><ul><li>a</li><li>b</li></ul></section>');
  const doc = parse(out.written);
  assert.deepEqual(['h2', 'p', 'ul'].map((s) => doc.querySelector(s).getAttribute(ID)), [h2, p, ul]);
  assert.deepEqual(out.answer.ids, []);
});

test('replace: your directive on a kept element stays on it', () => {
  const out = replace(page(SECTION), 'section', '<section><h2>Plan</h2><p>One, rewritten</p><ul><li>a</li><li>b</li></ul></section>');
  const doc = parse(out.written);
  assert.deepEqual(collectDirectives(doc, AI), { [doc.querySelector('p').getAttribute(ID)]: 'fix this', [doc.querySelector('li').getAttribute(ID)]: 'and this' });
});

test('replace: a directive on an element the agent dropped moves up to the scope it replaced, after the scope\'s own', () => {
  const text = page(`<section><!-- @AI: the whole thing -->${SECTION.slice('<section>'.length)}`);
  const section = idAt(text, 'section');
  const out = replace(text, 'section', '<section><h2>Plan</h2></section>');
  assert.deepEqual(directives(out.written), { [section]: 'the whole thing\nfix this\nand this' }, 'read as one directive, nothing lost');
});

test('replace: directives and replies in the agent\'s HTML are not yours, and come out; other comments stay', () => {
  const out = replace(page(SECTION), 'h2', '<h2><!-- @AI: sneaky --><!-- @Human: hi --><!-- a note -->Plan</h2>');
  assert.doesNotMatch(out.written, /sneaky|@Human/);
  assert.match(out.written, /<!-- a note -->/);
  assert.deepEqual(Object.values(directives(out.written)).sort(), ['and this', 'fix this']);
});

test('replace: a thread with a reply rides along whole', () => {
  const text = page('<section><p><!-- @AI: why? --><!-- @Human: because --><!-- @AI: ok -->x</p></section>');
  const out = replace(text, 'section', '<section><p>y</p></section>');
  const p = idAt(out.written, 'p');
  assert.deepEqual(threadsOf(parse(out.written), AI)[p], [{ prefix: AI, text: 'why?' }, { prefix: '@Human', text: 'because' }]);
  assert.equal(directives(out.written)[p], 'ok');
});

test('replace: an img\'s directive, which sits before it, stays with the scope', () => {
  const text = page('<p>x</p><!-- @AI: bigger --><img src="a.png" alt="a">');
  const img = idAt(text, 'img');
  const same = replace(text, 'img', '<img src="b.png" alt="b">');
  assert.deepEqual(directives(same.written), { [img]: 'bigger' });
  const figure = replace(text, 'img', '<figure><img src="b.png" alt="b"><figcaption>B</figcaption></figure>');
  assert.equal(directives(figure.written)[img], 'bigger', 'on the figure, which holds the ID now');
});

test('remove: the scope goes, and its threads and those in it move to the element that held it', () => {
  const text = page(`<section><!-- @AI: mine -->${SECTION.slice('<section>'.length)}`);
  const [section, ul] = ['section', 'ul'].map((s) => idAt(text, s));
  const out = reviseByAgent(text, { change: 'remove', id: ul, version: versionOf(text, ul) }, AI);
  assert.doesNotMatch(out.written, /<ul/);
  assert.deepEqual(directives(out.written)[section], 'mine\nand this');
  assert.deepEqual(out.answer, { ok: true, id: section, version: versionOf(out.written, section), ids: [] });
  assert.equal(reviseByAgent(text, { change: 'remove', id: ul, version: 'old' }, AI).conflict.why, 'changed since');
  assert.ok(reviseByAgent(text, { change: 'remove', id: idAt(text, 'body'), version: versionOf(text, idAt(text, 'body')) }, AI).refused);
});

test('remove a cell: its thread passes the row, which is no scope, and lands on the table', () => {
  const text = page('<table><tbody><tr><td><!-- @AI: drop this -->a</td><td>b</td></tr></tbody></table>');
  const td = idAt(text, 'td');
  const out = reviseByAgent(text, { change: 'remove', id: td, version: versionOf(text, td) }, AI);
  assert.deepEqual(directives(out.written), { [idAt(text, 'table')]: 'drop this' });
});

test('add: after, before, and into a scope; all of it new, IDs and all', () => {
  const text = page(SECTION);
  const [h2, ul, img] = ['h2', 'ul', 'img'].map((s) => idAt(text, s));
  const after = reviseByAgent(text, { change: 'add', where: 'after', id: h2, html: `<p data-hrv="${img}">New</p><p>Two</p>` }, AI);
  const doc = parse(after.written);
  const [first, second] = [...doc.querySelectorAll('h2 + p, h2 + p + p')];
  assert.equal(first.textContent, 'New');
  assert.notEqual(first.getAttribute(ID), img);
  assert.equal(elementById(doc, img).localName, 'img');
  assert.deepEqual(after.answer, { ok: true, id: first.getAttribute(ID), version: baseOf(first, AI), ids: [first, second].map((e) => e.getAttribute(ID)) });
  const into = reviseByAgent(text, { change: 'add', where: 'into', id: ul, html: '<li>c</li>' }, AI);
  assert.deepEqual([...parse(into.written).querySelectorAll('li')].map((e) => e.textContent.trim()), ['a', 'b', 'c']);
  const before = reviseByAgent(text, { change: 'add', where: 'before', id: h2, html: '<h1>Top</h1>' }, AI);
  assert.match(before.written, /<h1[^>]*>Top<\/h1>\s*<h2/);
});

test('add before an img leaves its directive on the img', () => {
  const text = page('<p>x</p><!-- @AI: bigger --><img src="a.png" alt="a">');
  const img = idAt(text, 'img');
  const out = reviseByAgent(text, { change: 'add', where: 'before', id: img, html: '<p>caption</p>' }, AI);
  assert.deepEqual(directives(out.written), { [img]: 'bigger' });
  assert.match(out.written, /caption<\/p>\s*<!-- @AI: bigger -->\s*<img/);
});

test('add refuses what HTML doesn\'t nest: a row after a paragraph, a div in a paragraph, an item in a section, into an img', () => {
  const text = page(`${SECTION}<table><tr><td>1</td></tr></table>`);
  const [p, section, img, ul] = ['p', 'section', 'img', 'ul'].map((s) => idAt(text, s));
  const refuse = (where, id, html) => reviseByAgent(text, { change: 'add', where, id, html }, AI).refused;
  assert.match(refuse('after', p, '<tr><td>x</td></tr>'), /<tr> can't sit in a <section>/);
  assert.ok(refuse('into', p, '<div>x</div>'));
  assert.match(refuse('into', section, '<li>x</li>'), /<li> can't sit in a <section>/);
  assert.match(refuse('into', ul, '<p>x</p>'), /<p> can't sit in a <ul>/);
  assert.ok(refuse('into', img, '<p>x</p>'));
  assert.ok(refuse('after', idAt(text, 'body'), '<p>x</p>'));
  assert.equal(reviseByAgent(text, { change: 'add', where: 'after', id: '999', html: '<p>x</p>' }, AI).conflict.why, 'no such element');
});

test('move: the scope goes with its content, IDs, and threads; its version stays', () => {
  const text = page(`${SECTION}<p>Last</p>`);
  const lastP = (t) => [...parse(t).querySelectorAll('p')].at(-1).getAttribute(ID);
  const [li, last] = [idAt(text, 'li'), lastP(text)];
  const p = idAt(text, 'p');
  const out = reviseByAgent(text, { change: 'move', id: p, where: 'after', to: last }, AI);
  assert.equal(lastP(out.written), p);
  assert.equal(directives(out.written)[p], 'fix this');
  assert.equal(directives(out.written)[li], 'and this');
  assert.deepEqual(out.answer, { ok: true, id: p, version: versionOf(text, p), ids: [] });
});

test('move takes an img\'s directive along', () => {
  const text = page('<p>x</p><!-- @AI: bigger --><img src="a.png" alt="a"><p>y</p>');
  const [img, x] = [idAt(text, 'img'), idAt(text, 'p')];
  const out = reviseByAgent(text, { change: 'move', id: img, where: 'before', to: x }, AI);
  assert.match(out.written, /<!-- @AI: bigger -->\s*<img[^>]*>\s*<p[^>]*>x/);
  assert.deepEqual(directives(out.written), { [img]: 'bigger' });
});

test('move refuses a scope into itself, body, and a list item out of its list; a gone ID is a conflict', () => {
  const text = page(SECTION);
  const [section, li, h2, body] = ['section', 'li', 'h2', 'body'].map((s) => idAt(text, s));
  const move = (id, where, to) => reviseByAgent(text, { change: 'move', id, where, to }, AI);
  assert.match(move(section, 'into', li).refused, /inside itself/);
  assert.ok(move(body, 'into', section).refused);
  assert.match(move(li, 'after', h2).refused, /<li> can't sit in a <section>/);
  assert.equal(move(section, 'after', '999').conflict.why, 'no such element');
});

test('svg: a label replaced and a shape added stay svg', () => {
  const text = page('<svg viewBox="0 0 10 10"><rect width="1" height="1"></rect><text x="1">old</text></svg>');
  const [svg, label] = [idAt(text, 'svg'), idAt(text, 'text')];
  const out = replace(text, 'text', '<text x="2">new</text>');
  assert.match(out.written, new RegExp(`<text data-hrv="${label}" x="2">new</text>`));
  const added = reviseByAgent(out.written, { change: 'add', where: 'into', id: svg, html: '<circle r="2"/><text>after</text>' }, AI);
  assert.ok(added.written, JSON.stringify(added));
  assert.match(added.written, /<circle data-hrv="\d+" r="2"><\/circle>\s*<text data-hrv="\d+">after<\/text>\s*<\/svg>/);
});

test('each change runs through the step port', () => {
  const text = page(SECTION);
  const steps = [];
  const id = idAt(text, 'p');
  reviseByAgent(text, { change: 'replace', id, version: versionOf(text, id), html: '<p>x</p>' }, AI, (name, fn) => (steps.push(name), fn(() => {})));
  assert.deepEqual(steps, ['parse', 'replace', 'serialize', 'reparse']);
});
