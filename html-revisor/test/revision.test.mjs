// A revision, as plain calls: the conflict rules, what each kind of change does to the file's
// text, and the steps it goes through. What the HTTP answer does with an outcome is in
// acceptance.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../domain/format.mjs';
import { parse } from '../domain/canonical.mjs';
import { elementById, ID } from '../domain/identity.mjs';
import { baseOf, fingerprint, threadBaseOf } from '../domain/bases.mjs';
import { readRevision, revise, answerOf, reviseThread } from '../domain/revision.mjs';

const AI = '@AI';
const page = (body) => normalize(`<html><head></head><body>${body}</body></html>`);

// The ID and base of the first element a selector finds, for a change to start from.
function at(text, selector) {
  const el = parse(text).querySelector(selector);
  return { id: el.getAttribute(ID), base: baseOf(el, AI) };
}

// A step port that keeps what went through it.
function recorder() {
  const steps = [], notes = {};
  return { steps, notes, step: (name, fn) => (steps.push(name), fn((attributes) => (notes[name] = attributes))) };
}

test('reading a revision gives elements an agent added their IDs', () => {
  const text = page('<p>one</p>').replace('</body>', '<p>added</p></body>');
  const document = readRevision(text);
  assert.ok([...document.querySelectorAll('p')].every((p) => p.hasAttribute(ID)));
});

test('a change to an element that is gone is a conflict', () => {
  const outcome = revise(page('<p>one</p>'), { id: '999', base: 'x', directive: 'mine' }, 'directive', AI);
  assert.deepEqual(outcome, {
    conflict: { why: 'no such element', error: 'that element is gone from the file', log: 'conflict on element 999 (no such element)', now: {} },
  });
});

test('a base that no longer matches is a conflict', () => {
  const text = page('<p>one</p>');
  const { id, base } = at(text, 'p');
  const outcome = revise(text.replace('one', 'uno'), { id, base, directive: 'mine' }, 'directive', AI);
  assert.deepEqual(outcome, {
    conflict: { why: 'changed on disk', error: 'that element changed on disk', log: `conflict on element ${id} (it changed on disk)`, now: {} },
  });
});

test('a spill that moved is a conflict, for a markdown save', () => {
  const text = page('<p>one</p><div><p>two</p></div>');
  const { id, base } = at(text, 'p');
  const { id: elsewhere } = at(text, 'div p');
  const outcome = revise(text, { id, base, markdown: 'uno', spill: [elsewhere] }, 'markdown', AI);
  assert.equal(outcome.conflict.why, 'spill moved');
  assert.equal(outcome.conflict.error, 'what the last save made changed on disk');
});

test('a directive that saw fewer replies than the thread has is a conflict, with the count now, and no log line', () => {
  const text = page('<p><!-- @AI: one --><!-- @Human: two -->text</p>');
  const { id, base } = at(text, 'p');
  const outcome = revise(text, { id, base, directive: 'three', replies: 0 }, 'directive', AI);
  assert.deepEqual(outcome, { conflict: { why: 'replied since', error: 'a reply came in on that thread', log: undefined, now: { replies: 1 } } });
  assert.equal(revise(text, { id, base, directive: 'three', replies: 1 }, 'directive', AI).wrote, true);
  assert.equal(revise(text, { id, base, directive: 'three' }, 'directive', AI).wrote, true, 'a save that names no count skips the rule');
});

test('a directive lands in the text, and the answer names the element and the file before and after', () => {
  const text = page('<p>one</p><p>two</p>');
  const { id, base } = at(text, 'p');
  const revised = revise(text, { id, base, directive: 'mine' }, 'directive', AI);
  assert.equal(revised.wrote, true);
  assert.match(revised.written, /<!-- @AI: mine -->/);
  assert.deepEqual(revised.ended, []);
  const answer = answerOf(revised, AI);
  assert.equal(answer.ok, true);
  assert.equal(answer.count, 1);
  assert.equal(answer.bases[id], base, 'a directive changes no base');
  assert.equal(answer.before, fingerprint(text));
  assert.equal(answer.after, fingerprint(revised.written));
  assert.equal(answer.markdowns, undefined);
});

test('a directive the file can not tell from what it holds writes nothing', () => {
  const text = page('<p><!-- @AI: mine -->one</p>');
  const { id, base } = at(text, 'p');
  const revised = revise(text, { id, base, directive: 'mine  ' }, 'directive', AI);
  assert.equal(revised.wrote, false);
  assert.equal(revised.written, text);
});

test('a Resolve takes the thread out and hands back its turns', () => {
  const text = page('<p><!-- @AI: one --><!-- @Human: two -->text</p>');
  const { id, base } = at(text, 'p');
  const revised = revise(text, { id, base, resolve: true }, 'resolve', AI);
  assert.doesNotMatch(revised.written, /@AI|@Human/);
  assert.deepEqual(revised.ended, [{ prefix: '@AI', text: 'one' }, { prefix: '@Human', text: 'two' }]);
  assert.equal(answerOf(revised, AI).count, 0);
});

test('a markdown save answers with the HTML, the holder, the spill, and the markdown around it', () => {
  const text = page('<p>one</p><p>two</p>');
  const { id, base } = at(text, 'p');
  const revised = revise(text, { id, base, markdown: 'uno <p>dos' }, 'markdown', AI);
  const answer = answerOf(revised, AI);
  assert.equal(answer.id, id);
  assert.equal(answer.spill.length, 2, 'the file reads a <p> in a <p> as more paragraphs');
  assert.match(answer.html, /uno.*dos/s);
  assert.equal(answer.markdowns[id], 'uno');
  assert.equal(answer.markdowns[answer.spill[0]], 'dos');
  assert.ok(answer.bases[answer.spill[0]], 'the spill has a base to start from');
  assert.ok(Object.keys(answer).indexOf('html') < Object.keys(answer).indexOf('bases'));
});

test('markdown the scope can not take is refused', () => {
  const text = page('<p>one</p><hr>');
  const { id, base } = at(text, 'p');
  assert.deepEqual(revise(text, { id, base, markdown: '  ' }, 'markdown', AI), { refused: 'markdown edits need a scope under 4 KB and non-blank markdown' });
  const hr = at(text, 'hr');
  assert.ok(revise(text, { ...hr, markdown: 'x' }, 'markdown', AI).refused, 'an hr is no scope');
});

test('a scope a save grows past the limit comes back with null for its markdown', () => {
  const text = page('<div><p>one</p></div>');
  const { id, base } = at(text, 'p');
  const div = at(text, 'div');
  const revised = revise(text, { id, base, markdown: 'x'.repeat(5000) }, 'markdown', AI);
  const answer = answerOf(revised, AI);
  assert.equal(answer.markdowns[id], null);
  assert.equal(answer.markdowns[div.id], null);
});

test('each change goes through its steps, in order, and notes what the spans carry', () => {
  const text = page('<p>one</p>');
  const { id, base } = at(text, 'p');
  const directive = recorder();
  answerOf(revise(text, { id, base, directive: 'mine' }, 'directive', AI, directive.step), AI, directive.step);
  assert.deepEqual(directive.steps, ['parse', 'set directive', 'serialize', 'reparse', 'bases']);
  assert.ok(directive.notes.bases['hrv.element.count'] > 0);

  const resolve = recorder();
  revise(text, { id, base, resolve: true }, 'resolve', AI, resolve.step);
  assert.deepEqual(resolve.steps, ['parse', 'resolve', 'serialize']);

  const markdown = recorder();
  answerOf(revise(text, { id, base, markdown: 'uno' }, 'markdown', AI, markdown.step), AI, markdown.step);
  assert.deepEqual(markdown.steps, ['parse', 'set markdown', 'settle', 'served html', 'serialize', 'reparse', 'bases', 'markdowns']);
  assert.equal(markdown.notes.markdowns['hrv.scope.count'], 2, 'the paragraph and the body around it');

  const stale = recorder();
  revise(text, { id, base: 'x', directive: 'mine' }, 'directive', AI, stale.step);
  assert.deepEqual(stale.steps, ['parse']);
});

test('a reply lands after the thread, and the answer carries the new thread base', () => {
  const text = page('<p><!-- @AI: add a diagram -->text</p>');
  const { id } = at(text, 'p');
  const thread = threadBaseOf(elementById(parse(text), id), AI);
  const steps = recorder();
  const { written, answer } = reviseThread(text, { id, thread, reply: 'Added one.' }, AI, steps.step);
  assert.match(written, /add a diagram -->\s*<!-- @Human: Added one. -->/);
  assert.deepEqual(steps.steps, ['parse', 'check thread', 'place reply', 'serialize']);
  assert.deepEqual(answer, {
    ok: true,
    count: 0,
    thread: threadBaseOf(elementById(parse(written), id), AI),
    before: fingerprint(text),
    after: fingerprint(written),
  });
  assert.notEqual(answer.thread, thread);
});

test('a reply to a thread that changed since is a conflict with the directive and base now', () => {
  const text = page('<p><!-- @AI: add a diagram -->text</p>');
  const { id } = at(text, 'p');
  const thread = threadBaseOf(elementById(parse(text), id), AI);
  const later = text.replace('add a diagram', 'add a diagram and a caption');
  const now = threadBaseOf(elementById(parse(later), id), AI);
  const why = 'its thread changed since';
  assert.deepEqual(reviseThread(later, { id, thread, reply: 'Added one.' }, AI), {
    conflict: { why, error: why, log: `stale reply on element ${id} (${why})`, now: { directive: 'add a diagram and a caption', thread: now } },
  });
});

test('a reply to an element with no thread, or one that is gone, is a conflict that offers nothing to read', () => {
  const text = page('<p>text</p>');
  const { id } = at(text, 'p');
  const none = reviseThread(text, { id, thread: 'x', reply: 'Done.' }, AI).conflict;
  assert.equal(none.error, 'that element has no directive to reply to');
  assert.deepEqual(none.now, {});
  const gone = reviseThread(text, { id: '999', thread: 'x', reply: 'Done.' }, AI).conflict;
  assert.equal(gone.error, 'that element is gone from the file');
  assert.deepEqual(gone.now, {});
});
