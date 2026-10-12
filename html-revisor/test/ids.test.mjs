// Element IDs: the formatter writes data-hrv into the file, from a counter on <html>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parse } from '../formatter.mjs';

const idsOf = (html) => {
  const document = parse(html);
  return {
    next: document.documentElement.getAttribute('data-hrv-next'),
    of: (selector) => [...document.querySelectorAll(selector)].map((el) => el.getAttribute('data-hrv')),
  };
};

test('every scope gets an ID, in document order; strong does not', () => {
  const out = normalize('<h1>Plan</h1><p>Ship the <b>formatter</b> <a href="x">first</a>.</p><ul><li>one</li><li>two</li></ul><img src="m.png">');
  const ids = idsOf(out);
  assert.deepEqual(ids.of('body, h1, p, a, ul, li, img'), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(ids.of('b, head, html'), [null, null, null]);
  assert.equal(ids.next, '9');
});

test('hr and every element of an svg take IDs too, as they took directives before', () => {
  const ids = idsOf(normalize('<hr><svg><g><rect></rect><text>label</text></g></svg>'));
  assert.ok(ids.of('hr, svg, g, rect, text').every((id) => /^\d+$/.test(id)));
});

test('existing IDs never change; a new element gets the next number', () => {
  const once = normalize('<p>a</p><p>b</p>');
  const added = once.replace('</body>', '<p>c</p></body>').replace(/(<p data-hrv="2">a<\/p>)/, '');
  const twice = idsOf(normalize(added));
  assert.deepEqual(twice.of('p'), ['3', '4']);
  assert.equal(twice.next, '5', 'the removed element\'s ID is not reused');
});

test('copies of an ID retire it: every copy gets a fresh one', () => {
  const ids = idsOf(normalize('<html data-hrv-next="5"><body data-hrv="1"><p data-hrv="3">a</p><p data-hrv="3">b</p><p data-hrv="4">c</p></body></html>'));
  assert.deepEqual(ids.of('p'), ['5', '6', '4']);
  assert.equal(ids.next, '7');
});

test('an ID past the counter moves the counter; junk IDs and IDs on non-scopes come off', () => {
  const ids = idsOf(normalize('<html data-hrv-next="2"><body data-hrv="1"><p data-hrv="40">a <b data-hrv="90">b</b></p><p data-hrv="x">c</p></body></html>'));
  assert.deepEqual(ids.of('p, b'), ['40', null, '91']);
  assert.equal(ids.next, '92', 'an ID that came off is not reused either');
});

test('assigning IDs is idempotent', () => {
  const once = normalize('<section><h2>x</h2><p>y <a href="z">z</a></p></section>');
  assert.equal(normalize(once), once);
});
