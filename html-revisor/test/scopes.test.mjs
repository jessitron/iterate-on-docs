import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../domain/format.mjs';
import { parse, serialize, canonicalHTML } from '../domain/canonical.mjs';
import { editable, EDIT_LIMIT, scopeElements } from '../domain/scopes.mjs';
import { scopeMarkdown } from '../domain/to-markdown.mjs';
import { roundTrips } from '../domain/from-markdown.mjs';
import { scopesWithin } from '../domain/scope-report.mjs';
import { scopeFromMarkdown } from '../domain/markdown-edits.mjs';

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

test('a span is a scope of its content, keeping its tag; a span in a pre is not', () => {
  const [p, pre] = scopesWithin(body('<p>Split <span class="pill">st<em>ez</em></span></p><pre><span class="k">const</span> x</pre>'));
  assert.deepEqual(p.children.map((s) => s.markdown), ['st*ez*']);
  assert.deepEqual(pre.children, []);
  const [span] = scopeFromMarkdown(p.children[0].el, 'stez **now**');
  assert.equal(span.outerHTML, '<span class="pill">stez <strong>now</strong></span>');
});

test('a span that fills its parent is not a scope, so the parent stays pickable', () => {
  const [p] = scopesWithin(body('<p><a href="#x"><span>there</span></a> and <span>a</span><span>b</span></p>'));
  assert.deepEqual(p.children.map((s) => s.el.localName), ['a', 'span', 'span']);
  assert.deepEqual(p.children[0].children, []);
});

test('svg text is a scope of its own', () => {
  const scopes = scopesWithin(body('<svg><text>Hi <tspan font-weight="700">there</tspan></text></svg>'));
  assert.deepEqual(scopes.map((s) => s.markdown), ['Hi <tspan font-weight="700">there</tspan>']);
});

// ---- Round-trip rules ------------------------------------------------
// The property itself is in the roundtrip-*.test.mjs files; these are the rules, one example each.

const scopeIn = (html) => {
  const document = parse(normalize(`<html><body>${html}</body></html>`));
  return { document, el: document.querySelector('body').firstElementChild };
};
const saved = (html) => {
  const { document, el } = scopeIn(html);
  const markdown = scopeMarkdown(el);
  return { markdown, same: roundTrips(el, markdown), back: canonicalHTML(document, scopeFromMarkdown(el, markdown)) };
};

test('text that reads as syntax is escaped, and entity-shaped text stays text', () => {
  const { markdown, same } = saved('<p>snake_case a*b [x] &amp;copy; &lt;tag&gt; ~~no~~ ⟦svg⟧</p>');
  assert.equal(markdown, 'snake\\_case a\\*b \\[x\\] &amp;copy; &lt;tag> \\~\\~no\\~\\~ \\⟦svg⟧');
  assert.ok(same);
});

test('a line that would start a block is escaped', () => {
  const { markdown, same } = saved('<p>a<br># b<br>- c<br>1. d<br>=== e</p>');
  assert.equal(markdown, 'a\n\\# b\n\\- c\n1\\. d\n\\=== e');
  assert.ok(same);
});

test('emphasis markdown cannot say stays HTML, and still round-trips', () => {
  const { markdown, same } = saved('<p>x<strong> a </strong>y</p>');
  assert.equal(markdown, 'x<strong> a </strong>y');
  assert.ok(same);
});

test('inside a bigger scope, a block with attributes is HTML; picked alone, its class is its own', () => {
  assert.equal(saved('<section><p class="why">a <strong>b</strong></p></section>').markdown, '<p class="why">a <strong>b</strong></p>');
  assert.equal(saved('<p class="why">a <strong>b</strong></p>').markdown, 'a **b**');
  const list = saved('<ul class="yaks"><li>a</li></ul>');
  assert.equal(list.markdown, '- a');
  assert.ok(list.same);
});

test('a card keeps its tag, with markdown inside', () => {
  assert.equal(saved('<section><div class="card"><p>a</p><ul><li>b</li></ul></div></section>').markdown, '<div class="card">\n\na\n\n- b\n\n</div>');
});

test('an empty element with long attributes round-trips: no blank line ends its HTML block', () => {
  const icon = `<svg class="${Array.from({ length: 20 }, (_, i) => `icon${i}`).join(' ')}"> </svg>`;
  assert.ok(saved(`<ul><li><a href="/"><div class="icon">${icon}</div>Home</a></li></ul>`).same); // a nav link
});

test('a style inside HTML is a token, so its blank lines stay out of the markdown', () => {
  const { markdown, same } = saved('<section><div class="card"><style>a { color: red; }\n\nb { color: blue; }</style></div></section>');
  assert.equal(markdown, '<div class="card">⟦style⟧</div>');
  assert.ok(same);
});

test('a token inside HTML is the next of its kind, even beside a token that stands alone', () => {
  const { document, el } = scopeIn(
    '<section><div class="a"><style>a {}</style><div><p>x</p></div></div><style>b {}</style><p>y</p><div class="c"><span>z</span><style>c {}</style></div></section>',
  );
  const markdown = '<div class="a">\n  ⟦style⟧\n  <div>\n    <p>x</p>\n  </div>\n</div>\n\n⟦style⟧\n\ny\n\n<div class="c"><span>z</span>⟦style⟧</div>';
  assert.equal(canonicalHTML(document, scopeFromMarkdown(el, markdown)), canonicalHTML(document, [el]));
});

test('tokens side by side between blocks each take one that stood between blocks', () => {
  const { markdown, same } = saved('<section><p>x</p><style>a {}</style><style>b {}</style><div class="c"><span>z</span><style>c {}</style></div></section>');
  assert.equal(markdown, 'x\n\n⟦style⟧ ⟦style⟧\n\n<div class="c"><span>z</span> ⟦style⟧</div>');
  assert.ok(same);
});

test('in HTML, a ⟦ you typed stays text', () => {
  const { markdown, same } = saved('<section><div class="card">⟦style⟧<style>a {}</style></div></section>');
  assert.equal(markdown, '<div class="card">&#x27E6;style⟧ ⟦style⟧</div>');
  assert.ok(same);
});

test('pre: backticks for <pre><code>, tildes for a bare <pre>, HTML when it holds markup', () => {
  assert.equal(saved('<section><pre><code class="language-js">a\n\nb</code></pre></section>').markdown, '```js\na\n\nb\n```');
  assert.equal(saved('<section><pre>a ``` b</pre></section>').markdown, '~~~\na ``` b\n~~~');
  const marked = saved('<pre>a <span class="add">b</span></pre>');
  assert.equal(marked.markdown, '<pre>a <span class="add">b</span></pre>');
  assert.ok(marked.same);
});

test('a stand-in comes back as its element: svg, script, and an image with its other attributes', () => {
  const page = saved('<section><h2>T</h2><svg viewBox="0 0 1 1"><text>x</text></svg><p><img src="a.png" alt="A" width="9"></p><script>go()</script></section>');
  assert.equal(page.markdown, '## T\n\n⟦svg⟧\n\n![A](a.png)\n\n⟦script⟧');
  assert.ok(page.same, page.back);
});

test('text bare beside blocks stays bare when saved unchanged; edited, it is a paragraph (C10)', () => {
  const { document, el } = scopeIn('<div>before<ul><li>a</li></ul>after</div>');
  assert.ok(roundTrips(el, 'before\n\n- a\n\nafter'));
  assert.match(canonicalHTML(document, scopeFromMarkdown(el, 'before!\n\n- a\n\nafter')), /<p>before!<\/p>/);
});

test('a link bare beside blocks keeps its ID when its text is edited into a paragraph', () => {
  const { document, el } = scopeIn('<div class="bar"><a class="logo" href="/">home page</a><div class="z"></div></div>');
  const id = el.querySelector('a').getAttribute('data-hrv');
  assert.equal(scopeMarkdown(el), '[home page](/)\n\n<div class="z"></div>');
  const saved = canonicalHTML(document, scopeFromMarkdown(el, scopeMarkdown(el).replace('home', 'yak')), { ids: true });
  assert.match(saved, new RegExp(`<p><a data-hrv="${id}" class="logo" href="/">yak page</a></p>`));
});

test('two lists in a row stay two lists', () => {
  const { markdown, same } = saved('<section><ul><li>a</li></ul><ul><li>b</li></ul><ol><li>c</li></ol><ol><li>d</li></ol></section>');
  assert.equal(markdown, '- a\n\n* b\n\n1. c\n\n1) d');
  assert.ok(same);
});

test('a table with a header row is GFM; a pipe in a cell is escaped', () => {
  const { markdown, same } = saved('<table><tr><th>a|b</th></tr><tr><td><code>x|y</code></td></tr></table>');
  assert.equal(markdown, '| a\\|b |\n| --- |\n| `x\\|y` |');
  assert.ok(same);
});

test('a destination with a space or parenthesis goes in angle brackets; a title keeps its quotes', () => {
  const { markdown, same } = saved('<p><a href="a b(1).html" title="say &quot;hi&quot;">x</a></p>');
  assert.equal(markdown, '[x](<a b(1).html> "say \\"hi\\"")');
  assert.ok(same);
});

test('a link with a class or a target is a markdown link, and the save carries those back', () => {
  const link = '<a href="#s" title="this" target="_blank" class="ref">the section</a>';
  const { markdown, same } = saved(`<p>See ${link}.</p>`);
  assert.equal(markdown, 'See [the section](#s "this").');
  assert.ok(same);
  const { document, el } = scopeIn(`<p>See ${link}.</p>`);
  const back = canonicalHTML(document, scopeFromMarkdown(el, 'See [the whole section](#s).'));
  assert.match(back, /<a href="#s" target="_blank" class="ref">the whole section<\/a>/);
});

test('a link picked alone edits as a markdown link and keeps its other attributes', () => {
  const { markdown, same } = saved('<a class="logo" href="/" rel="home">home page</a>');
  assert.equal(markdown, '[home page](/)');
  assert.ok(same);
});

test('links pair with their originals: same href and text first, then same href, then same text', () => {
  const { document, el } = scopeIn('<p><a class="one" href="/a">x</a> <a class="two" href="/a">y</a> <a class="three" href="/b">z</a></p>');
  const back = canonicalHTML(document, scopeFromMarkdown(el, '[y](/a) [x](/a) [z](/c) [new](/d)'));
  assert.match(back, /class="two" href="\/a">y<.*class="one" href="\/a">x<.*class="three" href="\/c">z<.*<a href="\/d">new</);
});

test('a link with a new href and text takes nothing from a link it did not come from', () => {
  const { document, el } = scopeIn('<p><a class="old" href="/a">docs</a></p>');
  const back = canonicalHTML(document, scopeFromMarkdown(el, '[home](/) and [docs](/a)'));
  assert.match(back, /<a href="\/">home<\/a> and <a class="old" href="\/a">docs<\/a>/);
});

test('a link or image written as HTML keeps the attributes it says', () => {
  const { document, el } = scopeIn('<p><a class="ref" href="/a">x</a> <img src="a.png" alt="A" width="9"></p>');
  const back = canonicalHTML(document, scopeFromMarkdown(el, '<a href="/a">x</a> <img src="a.png" alt="A" width="20">'));
  assert.match(back, /<p><a href="\/a">x<\/a> <img src="a.png" alt="A" width="20"><\/p>/);
  assert.doesNotMatch(canonicalHTML(document, scopeFromMarkdown(el, '[x](/a) ![A](a.png)')), /hrv-md/);
});

// The IDs of a list's items after saving markdown over it, by their place in the prior list.
const itemIdsAfter = (items, markdown) => {
  const { el } = scopeIn(`<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`);
  const place = new Map([...el.children].map((li, n) => [li.getAttribute('data-hrv'), n]));
  const [back] = scopeFromMarkdown(el, markdown);
  return [...back.children].map((li) => place.get(li.getAttribute('data-hrv')) ?? null);
};

test('an item edited into a copy of its neighbor keeps its place, and so does the neighbor', () => {
  assert.deepEqual(itemIdsAfter(['x', 'yak', 'z'], '- yak\n- yak\n- z'), [0, 1, 2]);
  assert.deepEqual(itemIdsAfter(['x', 'x', 'y'], "- x'\n- x\n- y"), [0, 1, 2]);
});

test('a save keeps IDs: an edited item keeps its own, a new one beside it gets none', () => {
  const { el } = scopeIn('<ul><li>ship the formatter</li><li>then deploy</li></ul>');
  const [ul, first, second] = [el, ...el.children].map((e) => e.getAttribute('data-hrv'));
  const [back] = scopeFromMarkdown(el, '- a new one\n- ship the formatter first\n- then deploy');
  assert.deepEqual([back, ...back.children].map((e) => e.getAttribute('data-hrv')), [ul, null, first, second]);
});

test('an item you type more into keeps its ID over a short new item beside it', () => {
  assert.deepEqual(
    itemIdsAfter(['First item', 'Second item', 'Third item'], '- First item\n- Second item, **edited**\n- Brand new item\n- Third item'),
    [0, 1, null, 2],
  );
  assert.deepEqual(
    itemIdsAfter(['First item', 'Second item', 'Third item'], '- First item\n- Brand new item\n- Second item, which now explains itself at length\n- Third item'),
    [0, null, 1, 2],
  );
});

test('two images of one picture that swap places keep their own sizes', () => {
  const { document, el } = scopeIn('<p><img src="a.png" alt="big" width="90"> <img src="a.png" alt="small" width="9"></p>');
  const back = canonicalHTML(document, scopeFromMarkdown(el, '![small](a.png) ![big](a.png)'));
  assert.match(back, /alt="small" width="9">.*alt="big" width="90"/);
});

// Two cards alike but for their headings, each with two textareas.
const card = (name) =>
  `<div class="card"><h3>${name}</h3><p>Text</p><textarea class="text">${name} text</textarea><p>Directive</p><textarea class="directive">${name} directive</textarea></div>`;
const cardMarkdown = (name) => `<div class="card">\n\n### ${name}\n\nText\n\n⟦textarea⟧\n\nDirective\n\n⟦textarea⟧\n\n</div>`;
const textareas = (html) => [...html.matchAll(/<textarea class="(\w+)">([^<]*)<\/textarea>/g)].map((m) => `${m[1]}: ${m[2]}`);

test('removing a block that holds stand-ins leaves the next block its own', () => {
  const { document, el } = scopeIn(`<section>${card('Alpha')}${card('Beta')}</section>`);
  const back = canonicalHTML(document, scopeFromMarkdown(el, cardMarkdown('Beta')));
  assert.deepEqual(textareas(back), ['text: Beta text', 'directive: Beta directive']);
});

test('two blocks that swap places take their own stand-ins with them', () => {
  const { document, el } = scopeIn(`<section>${card('Alpha')}${card('Beta')}</section>`);
  const back = canonicalHTML(document, scopeFromMarkdown(el, `${cardMarkdown('Beta')}\n\n${cardMarkdown('Alpha')}`));
  assert.deepEqual(textareas(back), ['text: Beta text', 'directive: Beta directive', 'text: Alpha text', 'directive: Alpha directive']);
});

test('deleting an inline icon leaves a diagram between blocks, not in a paragraph', () => {
  const icon = '<svg viewBox="0 0 1 1"><circle r="1"></circle></svg>';
  const { document, el } = scopeIn(`<section><p>a ${icon} b</p><svg viewBox="0 0 9 9"><text>diagram</text></svg></section>`);
  const back = canonicalHTML(document, scopeFromMarkdown(el, 'a b\n\n⟦svg⟧'));
  assert.match(back, /<\/p>\s*<svg viewBox="0 0 9 9">/);
});

// Directives ride along. Markdown doesn't show them; the save puts each back on its element's
// partner, and one whose element the edit deleted goes with it.
const htmlAfter = (html, markdown) => {
  const { document, el } = scopeIn(html);
  const holder = document.createElement('div');
  holder.append(...scopeFromMarkdown(el, markdown));
  return holder.innerHTML.replace(/ data-hrv="\d+"/g, '').replace(/\s+/g, ' ');
};

test("the scope's own directive stays when its text is edited", () => {
  assert.equal(htmlAfter('<p><!-- @AI: shorter -->a <strong>b</strong></p>', 'a **b** c'), '<p><!-- @AI: shorter -->a <strong>b</strong> c</p>');
});

test('a directive on an item rides with the item past an edit and a new item', () => {
  const back = htmlAfter('<ul><li>x</li><li><!-- @AI: why? -->y</li></ul>', '- new\n- x!\n- y');
  assert.match(back, /<li>new<\/li> ?<li>x!<\/li> ?<li><!-- @AI: why\? -->y<\/li>/);
});

test('a directive on an edited item stays on it', () => {
  assert.match(htmlAfter('<ul><li><!-- @AI: why? -->x</li><li>y</li></ul>', '- x, edited\n- y'), /<li><!-- @AI: why\? -->x, edited<\/li>/);
});

test('a directive before an image in a sentence rides with the image', () => {
  const back = htmlAfter('<p>see <!-- @AI: bigger --><img src="a.png" alt="a"> here</p>', 'see ![a](a.png) there');
  assert.equal(back, '<p>see <!-- @AI: bigger --><img src="a.png" alt="a"> there</p>');
});

test('a directive whose element the edit deleted goes with it; the scope keeps its own', () => {
  assert.match(htmlAfter('<ul><!-- @AI: mine --><li>x</li><li><!-- @AI: gone? -->y</li></ul>', '- x'), /^<ul><!-- @AI: mine --> ?<li>x<\/li> ?<\/ul>$/);
  const nested = '<section><ul><li>x</li><li><!-- @AI: gone? -->y</li></ul></section>';
  assert.doesNotMatch(htmlAfter(nested, '- x'), /gone/);
});

test('directives inside a stand-in come back once, on their elements', () => {
  const svg = '<svg viewBox="0 0 9 9"><text><!-- @AI: label -->diagram</text></svg>';
  const back = htmlAfter(`<section><p>a</p>${svg}</section>`, 'a!\n\n⟦svg⟧');
  assert.equal(back.match(/@AI: label/g).length, 1);
  assert.match(back, /<text><!-- @AI: label -->diagram<\/text>/);
});

test('two directives on one element keep their order', () => {
  assert.match(htmlAfter('<ul><li><!-- @AI: one --><!-- @AI: two -->x</li></ul>', '- x!'), /<li><!-- @AI: one --> ?<!-- @AI: two -->x!<\/li>/);
});

// ---- Size ----

test('a scope of 4 KB of HTML or more is still a scope, but does not edit as markdown', () => {
  const p = `<p>${'word '.repeat(150)}</p>`; // about 760 characters
  const doc = parse(`<html><body><section>${p.repeat(6)}</section></body></html>`);
  const section = doc.querySelector('section');
  assert.ok(scopeElements(doc).includes(section));
  assert.equal(editable(section), false);
  assert.equal(editable(section.querySelector('p')), true);
});

test('element IDs and directives do not count toward the limit', () => {
  const text = 'x'.repeat(EDIT_LIMIT - 100);
  const plain = body(`<p>${text}</p>`).firstElementChild;
  const marked = body(`<p data-hrv="12345"><!-- @AI: ${'long directive '.repeat(20)} -->${text}</p>`).firstElementChild;
  assert.equal(editable(plain), true);
  assert.equal(editable(marked), true);
  assert.equal(editable(body(`<p>${text}${'y'.repeat(200)}</p>`).firstElementChild), false);
});
