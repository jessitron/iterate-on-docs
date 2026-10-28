// Annotation: the reports scopes.mjs --annotate writes under each .ex example.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from '../domain/canonical.mjs';
import { normalize } from '../domain/format.mjs';
import { scopeOf } from '../domain/scope-report.mjs';
import { annotate } from '../domain/annotation.mjs';

const page = (examples) => `<html><head></head><body><section id="scopes"><p>Cases.</p>${examples}</section></body></html>`;
const annotated = (html) => {
  const document = parse(html);
  annotate(document);
  return serialize(document);
};

test('annotating twice gives the same page', () => {
  const once = annotated(page('<div class="ex"><p>a</p></div>'));
  assert.equal(annotated(once), once);
  assert.match(once, /<table class="scope-report">[\s\S]*all markdown/);
  assert.match(once, /<details class="scope-report">/);
  assert.equal(scopeOf(parse(once).querySelector('.ex')).children.length, 1);
});

test('annotating writes the page in canonical form, and a page without IDs gets none', () => {
  const html = annotated(page('<div class="ex"><p>a</p></div>'));
  assert.equal(serialize(parse(html)), html);
  assert.match(html, /<table class="scope-report">\s*<thead>/);
  assert.doesNotMatch(html, /data-hrv/);
});

test('annotating a page with IDs gives it the IDs the formatter would', () => {
  const html = annotated(normalize(page('<div class="ex"><p>a</p></div>')));
  assert.equal(normalize(html), html);
  assert.ok(parse(html).querySelector('table.scope-report td[data-hrv]'));
});

// The yak: a rerun after a small edit renumbered every report element.
test('a rerun keeps the IDs of the report elements that came back; only what changed is new', () => {
  const before = normalize(annotated(page('<div class="ex"><p>a</p></div><div class="ex"><p>b <em>c</em></p></div>')));
  const edited = before.replace('<em>c</em>', '<em>d</em>');
  const after = annotated(edited);
  const ids = (html) => [...parse(html).querySelectorAll('.scope-report, .scope-report [data-hrv]')].map((el) => el.getAttribute('data-hrv'));
  const [was, now] = [ids(before), ids(after)];
  assert.equal(now.length, was.length);
  const kept = now.filter((id, i) => id === was[i]).length;
  assert.ok(kept >= now.length - 2, `kept ${kept} of ${now.length}`);
  assert.equal(normalize(after), after);
});

test('an example\'s HTML sample reads the same with element IDs or without, as the file has it', () => {
  const example = page('<div class="ex"><p>A line that fits the width alone, but not with an ID on it, here.</p><svg><rect x="1"></rect></svg></div>');
  const sample = (html) => parse(html).querySelector('details.scope-report pre').textContent;
  const clean = sample(annotated(example));
  assert.equal(sample(annotated(normalize(example))), clean);
  assert.match(clean, /<rect x="1"><\/rect>/);
});

test('a directive on a report element stays with it', () => {
  const before = normalize(annotated(page('<div class="ex"><p>a</p></div>')));
  const details = /(<details[^>]*class="scope-report"[^>]*>)/;
  const withDirective = before.replace(details, '$1<!-- @AI: open by default -->');
  assert.notEqual(withDirective, before);
  const after = annotated(withDirective);
  assert.match(after, /<details[^>]*class="scope-report"[^>]*>\s*<!-- @AI: open by default -->/);
});
