// Annotation: the reports scopes.mjs --annotate writes under each .ex example.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from '../domain/canonical.mjs';
import { normalize } from '../domain/format.mjs';
import { scopeOf, report } from '../domain/scope-report.mjs';
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

test('a row inside data-no-revise says not pickable and offers nothing to edit; the parent still holds its text', () => {
  const html = '<section><p>free</p><div data-no-revise><p>held</p></div></section>';
  const document = parse(annotated(page(`<div class="ex">${html}</div>`)));
  const rows = [...document.querySelectorAll('table.scope-report tr')].slice(1).map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
  const row = (text) => rows.filter((r) => r[0] === text);
  assert.equal(row('<p>')[0][1], 'all markdown', 'a paragraph outside it is pickable');
  assert.deepEqual(row('<div>')[0].slice(1), ['not pickable: data-no-revise', '']);
  assert.deepEqual(row('<p>')[1].slice(1), ['not pickable: data-no-revise', ''], 'so is one inside it');
  assert.match(row('<section>')[0][2], /held/);
  const printed = report(scopeOf(parse(html).querySelector('section')));
  assert.match(printed, /<div>  not pickable: data-no-revise/);
  assert.doesNotMatch(printed.split('\n').at(-1), /held/);
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
