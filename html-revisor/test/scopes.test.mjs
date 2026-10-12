import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from '../formatter.mjs';
import { scopeOf, scopesWithin, scopeMarkdown, annotate } from '../scopes.mjs';

const body = (html) => parse(`<html><body>${html}</body></html>`).querySelector('body');
const markdownOf = (html) => scopeMarkdown(body(html).firstElementChild);

test('a paragraph with inline markup is markdown', () => {
  assert.equal(markdownOf('<p>Run <code>x</code>, <strong>now</strong>, <a href="#y">see</a>.</p>'), 'Run `x`, **now**, [see](#y).');
});

test('a list is one scope in markdown, and each item is a scope too', () => {
  const [list] = scopesWithin(body('<ul><li>a</li><li>b <em>c</em></li></ul>'));
  assert.equal(list.markdown, '- a\n- b *c*');
  assert.deepEqual(list.children.map((s) => s.markdown), ['a', 'b *c*']);
});

test('a nested list indents under its item, picked whole or by item', () => {
  const [list] = scopesWithin(body('<ul><li>a<ul><li>b</li></ul></li></ul>'));
  assert.equal(list.markdown, '- a\n  - b');
  assert.equal(list.children[0].markdown, 'a\n- b');
});

test('text around a list is paragraphs in one scope', () => {
  assert.equal(markdownOf('<div>before<ul><li>a</li></ul>after</div>'), 'before\n\n- a\n\nafter');
});

test('a heading shows # inside a bigger scope, not alone', () => {
  const [section] = scopesWithin(body('<section><h2>T</h2><p>x</p></section>'));
  assert.equal(section.markdown, '## T\n\nx');
  assert.equal(section.children[0].markdown, 'T');
});

test('br is a newline and nbsp a plain character', () => {
  assert.equal(markdownOf('<p>a<br>b&nbsp;c</p>'), 'a\nb c');
});

test('svg in a sentence is a token; img is markdown', () => {
  assert.equal(markdownOf('<p>A <svg><circle></circle></svg> and <img src="x.png" alt="X" width="9">.</p>'), 'A ⟦svg⟧ and ![X](x.png).');
});

test('a pre is a fenced block', () => {
  assert.equal(markdownOf('<pre><code>a\nb</code></pre>'), '```\na\nb\n```');
});

test('a table with a header row is a GFM table; its cells are scopes, its rows are not', () => {
  const [table] = scopesWithin(body('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>'));
  assert.equal(table.markdown, '| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.deepEqual(table.children.map((s) => s.el.localName), ['th', 'th', 'td', 'td']);
});

test('links and images are scopes; strong is not', () => {
  const [p] = scopesWithin(body('<p><strong>Go</strong> <a href="#x">there</a> <img src="y.png" alt="Y"></p>'));
  assert.deepEqual(p.children.map((s) => s.markdown), ['[there](#x)', '![Y](y.png)']);
});

test('svg text is a scope of its own', () => {
  const scopes = scopesWithin(body('<svg><text>Hi <tspan font-weight="700">there</tspan></text></svg>'));
  assert.deepEqual(scopes.map((s) => s.markdown), ['Hi <tspan font-weight="700">there</tspan>']);
});

test('annotating twice gives the same page', () => {
  const document = parse('<html><head></head><body><div class="ex"><p>a</p></div></body></html>');
  annotate(document);
  const once = serialize(document);
  annotate(document);
  assert.equal(serialize(document), once);
  assert.match(once, /<table class="scope-report">[\s\S]*all markdown/);
  assert.match(once, /<details class="scope-report">/);
  assert.equal(scopeOf(document.querySelector('.ex')).children.length, 1);
});
