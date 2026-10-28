// Threads: an element's directives and the agent's replies, as HTML comments in the file
// (REPLY-DESIGN.html). Where a reply goes, that it reads back, that it changes no base, and
// that cleanup takes it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../domain/format.mjs';
import { parse, serialize } from '../domain/canonical.mjs';
import { elementById } from '../domain/identity.mjs';
import { baseOf, threadBaseOf } from '../domain/bases.mjs';
import { announcementOf } from '../domain/announcements.mjs';
import { cleanup } from '../domain/cleanup.mjs';
import { tabStateOf } from '../domain/served-page.mjs';
import { placeReply, threadOf, threadsOf, collectDirectives, removeThreads, removeThread, setDirective } from '../domain/directives.mjs';

const page = (body) => parse(normalize(body));
const idOf = (document, selector) => document.querySelector(selector).getAttribute('data-hrv');
const turns = (...pairs) => pairs.map(([prefix, text]) => ({ prefix, text }));

test('a reply goes after the directive, and the thread reads back in order', () => {
  const document = page('<p><!-- @AI: add a diagram -->Where it is headed</p>');
  const p = document.querySelector('p');
  placeReply(p, 'Added one below.', '@AI');
  assert.match(serialize(document), /<!-- @AI: add a diagram -->\s*<!-- @Human: Added one below. -->/);
  assert.deepEqual(threadOf(p, '@AI'), turns(['@AI', 'add a diagram'], ['@Human', 'Added one below.']));
});

test('turns alternate: each reply goes after the last turn', () => {
  const document = page('<p><!-- @AI: one --><!-- @Human: two --><!-- @AI: three -->text</p>');
  const p = document.querySelector('p');
  placeReply(p, 'four', '@AI');
  const reread = parse(serialize(document)).querySelector('p');
  assert.deepEqual(threadOf(reread, '@AI'), turns(['@AI', 'one'], ['@Human', 'two'], ['@AI', 'three'], ['@Human', 'four']));
});

test('a reply on an image goes before it, after its directive', () => {
  const document = page('<div><p>a</p><!-- @AI: crop it --><img src="a.png" alt="a"></div>');
  const img = document.querySelector('img');
  placeReply(img, 'Cropped.', '@AI');
  const reread = parse(serialize(document));
  assert.deepEqual(threadOf(reread.querySelector('img'), '@AI'), turns(['@AI', 'crop it'], ['@Human', 'Cropped.']));
  assert.deepEqual(threadOf(reread.querySelector('div'), '@AI'), []);
});

test("when the first child is an image, the parent's thread goes last, apart from the image's", () => {
  const document = page('<figure><!-- @AI: bigger --><img src="a.png" alt="a"><figcaption>A</figcaption></figure>');
  const figure = document.querySelector('figure');
  setDirective(figure, 'caption?', '@AI');
  placeReply(figure, 'Added one.', '@AI');
  placeReply(document.querySelector('img'), 'Done.', '@AI');
  const reread = parse(serialize(document));
  assert.equal(reread.querySelector('figure').lastElementChild.localName, 'figcaption');
  assert.equal(reread.querySelector('figure').lastElementChild.nextSibling.nextSibling.data, ' @AI: caption? ');
  assert.deepEqual(threadOf(reread.querySelector('figure'), '@AI'), turns(['@AI', 'caption?'], ['@Human', 'Added one.']));
  assert.deepEqual(threadOf(reread.querySelector('img'), '@AI'), turns(['@AI', 'bigger'], ['@Human', 'Done.']));
});

test('a thread on a pre, several turns long, stays the pre\'s', () => {
  const document = page('<div><pre>code</pre></div>');
  const pre = document.querySelector('pre');
  setDirective(pre, 'explain', '@AI');
  placeReply(pre, 'It loops.', '@AI');
  const reread = parse(serialize(document));
  assert.deepEqual(threadOf(reread.querySelector('pre'), '@AI'), turns(['@AI', 'explain'], ['@Human', 'It loops.']));
  assert.deepEqual(threadOf(reread.querySelector('div'), '@AI'), []);
});

test('a reply with no directive goes where a directive would', () => {
  const document = page('<p>text</p>');
  placeReply(document.querySelector('p'), 'unasked', '@AI');
  assert.match(serialize(document), /<p data-hrv="\d+">\s*<!-- @Human: unasked -->\s*text/);
});

test('reply text that would end the comment is escaped', () => {
  const document = page('<p><!-- @AI: arrows? -->text</p>');
  placeReply(document.querySelector('p'), 'a --> b', '@AI');
  assert.deepEqual(threadOf(parse(serialize(document)).querySelector('p'), '@AI').at(-1), { prefix: '@Human', text: 'a - -> b' });
});

test('a > typed in a directive or reply reads back as >, in the box, the thread, and the announcement', () => {
  const typed = 'Done -> working; a > b; &gt; stays';
  const document = page('<h1>Title</h1><p>text</p>');
  const p = document.querySelector('p');
  const id = idOf(document, 'p');
  setDirective(p, typed, '@AI');
  let reread = parse(serialize(document));
  assert.equal(collectDirectives(reread, '@AI')[id], typed, 'the box');
  placeReply(elementById(reread, id), `re: ${typed}`, '@AI');
  reread = parse(serialize(reread));
  assert.deepEqual(threadsOf(reread, '@AI')[id], turns(['@AI', typed], ['@Human', `re: ${typed}`]), 'the thread');
  setDirective(elementById(reread, id), `again ${typed}`, '@AI');
  reread = parse(serialize(reread));
  const announcement = announcementOf(reread, id, { directive: '' }, '@AI');
  assert.deepEqual(announcement.directive, { before: '', after: `again ${typed}` }, 'the announcement');
});

test('an unchanged directive holding > and -- announces nothing', () => {
  const document = page('<p>text</p>');
  const id = idOf(document, 'p');
  setDirective(document.querySelector('p'), 'a --> b', '@AI');
  const reread = parse(serialize(document));
  assert.equal(announcementOf(reread, id, { directive: 'a --> b' }, '@AI'), null);
});

test('the directive is the open turn: what comes after the last reply', () => {
  const document = page('<p><!-- @AI: one --><!-- @Human: two --><!-- @AI: three --><!-- @AI: four -->text</p><p><!-- @AI: a --><!-- @Human: b -->x</p>');
  const [first, second] = [idOf(document, 'p'), idOf(document, 'p + p')];
  assert.deepEqual(collectDirectives(document, '@AI'), { [first]: 'three\nfour' });
  assert.deepEqual(threadsOf(document, '@AI'), {
    [first]: turns(['@AI', 'one'], ['@Human', 'two']),
    [second]: turns(['@AI', 'a'], ['@Human', 'b']),
  });
});

test('a thread with no reply is all directive, and no settled thread', () => {
  const document = page('<p><!-- @AI: one -->text</p>');
  assert.deepEqual(threadsOf(document, '@AI'), {});
  assert.deepEqual(Object.values(collectDirectives(document, '@AI')), ['one']);
});

test('setting the directive after a reply adds a turn and leaves the earlier ones as written', () => {
  const document = page('<p><!-- @AI: one --><!-- @Human: two -->text</p>');
  const p = document.querySelector('p');
  setDirective(p, 'three', '@AI');
  setDirective(p, 'three, again', '@AI');
  const reread = parse(serialize(document)).querySelector('p');
  assert.deepEqual(threadOf(reread, '@AI'), turns(['@AI', 'one'], ['@Human', 'two'], ['@AI', 'three, again']));
  setDirective(reread, '', '@AI');
  assert.deepEqual(threadOf(reread, '@AI'), turns(['@AI', 'one'], ['@Human', 'two']));
});

test('Resolve takes out the whole thread and leaves the neighbors\'', () => {
  const document = page('<div><p><!-- @AI: one --><!-- @Human: two -->text</p><!-- @AI: crop --><img src="a.png" alt="a"></div>');
  removeThread(document.querySelector('p'), '@AI');
  const reread = parse(serialize(document));
  assert.deepEqual(threadOf(reread.querySelector('p'), '@AI'), []);
  assert.deepEqual(threadOf(reread.querySelector('img'), '@AI'), turns(['@AI', 'crop']));
});

test('a reply changes no base', () => {
  const document = page('<section><p>text</p></section>');
  const [section, p] = [document.querySelector('section'), document.querySelector('p')];
  const before = [baseOf(section, '@AI'), baseOf(p, '@AI')];
  placeReply(p, 'noted', '@AI');
  const reread = parse(serialize(document));
  const id = idOf(document, 'p');
  assert.deepEqual([baseOf(reread.querySelector('section'), '@AI'), baseOf(elementById(reread, id), '@AI')], before);
});

test('the thread base changes with a turn, and not with the content or another thread', () => {
  const html = '<div><p><!-- @AI: one -->text</p><p><!-- @AI: other -->more</p></div>';
  const base = (document) => threadBaseOf(document.querySelector('p'), '@AI');
  const start = base(page(html));
  assert.equal(base(page(html.replace('text', 'changed text'))), start);
  assert.equal(base(page(html.replace('other', 'something else'))), start);
  assert.notEqual(base(page(html.replace('one', 'one, edited'))), start);
  const replied = page(html);
  placeReply(replied.querySelector('p'), 'two', '@AI');
  const afterReply = base(replied);
  assert.notEqual(afterReply, start);
  setDirective(replied.querySelector('p'), 'three', '@AI');
  assert.notEqual(base(replied), afterReply, 'a turn added after the reply');
});

test('an Announcement carries the base of its thread; a revision with no thread carries none', () => {
  const document = page('<h1>Title</h1><p><!-- @AI: say more -->text</p><p>plain</p>');
  const [p, plain] = document.querySelectorAll('p');
  const thread = threadBaseOf(p, '@AI');
  assert.equal(announcementOf(document, idOf(document, 'p'), { directive: '' }, '@AI').thread, thread);
  const again = page(serialize(document));
  const plainId = plain.getAttribute('data-hrv');
  assert.equal(announcementOf(again, plainId, { directive: '', markdown: 'before' }, '@AI').thread, undefined);
});

test('an Announcement of a Resolve carries the turns that went, even with nothing else changed', () => {
  const document = page('<h1>Title</h1><p>text</p>');
  const id = idOf(document, 'p');
  const ended = turns(['@AI', 'one'], ['@Human', 'two']);
  assert.deepEqual(announcementOf(document, id, { directive: '' }, '@AI', ended), { id, element: 'p', heading: 'Title', resolved: ended });
  assert.equal(announcementOf(document, id, { directive: '' }, '@AI'), null, 'no Resolve, nothing changed');
});

test('removeThreads takes out directives and replies, and leaves other comments', () => {
  const document = page('<p><!-- @AI: one --><!-- @Human: two --><!-- ordinary -->text</p>');
  removeThreads(document, '@AI');
  assert.doesNotMatch(serialize(document), /@AI|@Human/);
  assert.match(serialize(document), /<!-- ordinary -->/);
});

test('cleanup takes out replies, and lists only the directives', () => {
  const { html, removed } = cleanup(normalize('<p><!-- @AI: one --><!-- @Human: two -->text</p>'));
  assert.doesNotMatch(html, /@Human/);
  assert.deepEqual(removed, ['one']);
});

test('the tab state lifts the threads out, and runs each step through the step port', () => {
  const document = page('<p><!-- @AI: one --><!-- @Human: two -->text</p>');
  const id = idOf(document, 'p');
  const steps = [];
  const state = tabStateOf(document, '@AI', (name, fn) => (steps.push(name), fn()));
  assert.deepEqual(steps, ['directives', 'bases']);
  assert.deepEqual(state.threads[id], turns(['@AI', 'one'], ['@Human', 'two']));
  assert.doesNotMatch(serialize(document), /@Human/);
  assert.deepEqual(tabStateOf(page('<p><!-- @AI: one -->text</p>'), '@AI').directives, { [id]: 'one' });
});
