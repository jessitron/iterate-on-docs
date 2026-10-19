import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../domain/format.mjs';
import { parse, serialize } from '../domain/canonical.mjs';

// Layout alone, without element IDs, for the tests about layout. IDs have their own tests.
const layout = (html) => serialize(parse(html));

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
// Body content wrapped in a full document, so indentation is predictable (body at depth 1).
const page = (body) => `<html><body>${body}</body></html>`;
const htmlFixtures = fs.readdirSync(fixtures).filter((f) => f.endsWith('.html'));

for (const name of htmlFixtures) {
  test(`idempotent on ${name}`, () => {
    const once = normalize(fs.readFileSync(path.join(fixtures, name), 'utf8'));
    assert.equal(normalize(once), once);
    assert.ok(once.endsWith('</html>\n') || once.endsWith('\n'));
    assert.ok(!once.endsWith('\n\n'));
  });
}

test('doctype defaults to html', () => {
  assert.ok(normalize('<html><body><p>x</p></body></html>').startsWith('<!DOCTYPE html>\n'));
});

test('inline-only block stays on one line', () => {
  const out = layout(page('<h1>Project <em>Overview</em></h1><ul><li>Ship it</li></ul>'));
  assert.match(out, /^ {4}<h1>Project <em>Overview<\/em><\/h1>$/m);
  assert.match(out, /^ {6}<li>Ship it<\/li>$/m);
});

test('an empty block stays on one line, however long its tag', () => {
  const tag = `<div class="${Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')}">`;
  const out = layout(page(`${tag} \n </div>`));
  assert.match(out, new RegExp(`^ {4}${tag}</div>$`, 'm'));
});

test('long inline-only block takes three lines', () => {
  const long = 'word '.repeat(30).trim();
  const out = layout(page(`<p>${long}</p>`));
  assert.match(out, new RegExp(`^ {4}<p>\\n {6}${long}\\n {4}</p>$`, 'm'));
});

test('whitespace between inline siblings survives', () => {
  const out = layout('<body><p>a <b>b</b> &amp; c</p><p><b>x</b> <i>y</i></p></body>');
  assert.match(out, /<p>a <strong>b<\/strong> &amp; c<\/p>/);
  assert.match(out, /<p><strong>x<\/strong> <em>y<\/em><\/p>/);
});

test('b is strong and i is em, attributes kept', () => {
  const out = layout('<body><p><b class="k" id="j">x</b> <i>y <b>z</b></i></p></body>');
  assert.match(out, /<p><strong class="k" id="j">x<\/strong> <em>y <strong>z<\/strong><\/em><\/p>/);
});

test('whitespace beside br goes', () => {
  const out = layout('<body><p>a <br>\n  b<br> c</p></body>');
  assert.match(out, /<p>a<br>b<br>c<\/p>/);
});

test('table rows go in sections: a leading row of th is the thead', () => {
  const out = layout('<body><table><tr><th>a</th></tr><tr><td>1</td></tr><tr><td>2</td></tr></table></body>');
  assert.match(out, /<table>\s*<thead>\s*<tr>\s*<th>a<\/th>\s*<\/tr>\s*<\/thead>\s*<tbody>\s*<tr>\s*<td>1<\/td>[\s\S]*<td>2<\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/);
  const plain = layout('<body><table><tr><td>1</td></tr></table></body>');
  assert.match(plain, /<table>\s*<tbody>\s*<tr>\s*<td>1<\/td>/);
  const sectioned = '<body><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></body>';
  assert.equal(layout(sectioned), layout(layout(sectioned)));
});

test('only ASCII whitespace collapses; nbsp survives', () => {
  const out = layout('<body><p>a \n\t  b&nbsp;&nbsp;c &nbsp;</p></body>');
  assert.match(out, /<p>a b&nbsp;&nbsp;c &nbsp;<\/p>/);
});

test('entities are escaped once, not twice', () => {
  const out = layout('<body><p>&amp;amp; &lt;b&gt; 1 &amp; 2</p></body>');
  assert.match(out, /<p>&amp;amp; &lt;b&gt; 1 &amp; 2<\/p>/);
});

test('pre, script, style, textarea inner content is untouched', () => {
  const src =
    '<body><pre>  a\n    <code>b &amp; c</code>\n\n</pre><script>var s = "  x  <y> &amp;";\n  go();</script>' +
    '<style>a  >  b {  color: red }</style><textarea>  t\n &lt;</textarea></body>';
  const out = layout(src);
  for (const piece of [
    '<pre>  a\n    <code>b &amp; c</code>\n\n</pre>',
    '<script>var s = "  x  <y> &amp;";\n  go();</script>',
    '<style>a  >  b {  color: red }</style>',
    '<textarea>  t\n &lt;</textarea>',
  ]) {
    assert.ok(out.includes(piece), `missing ${JSON.stringify(piece)} in\n${out}`);
  }
});

test('void elements: no closing slash; boolean attributes are bare', () => {
  const out = layout('<body><img src="a.png" alt="" /><input disabled value="x"><hr/></body>');
  assert.match(out, /<img src="a\.png" alt>/);
  assert.match(out, /<input disabled value="x">/);
  assert.match(out, /<hr>/);
  assert.ok(!out.includes('/>'));
});

test('attributes keep order and escape & and "', () => {
  const out = layout(`<body><a title='say "hi"' href="x?a=1&amp;b=2" id=z>l</a></body>`);
  assert.match(out, /<a title="say &quot;hi&quot;" href="x\?a=1&amp;b=2" id="z">l<\/a>/);
});

test('comments sit on their own lines, data unchanged', () => {
  const out = layout(page('<p>a</p><!--  x -- y  --><p>b</p>'));
  assert.match(out, /^ {4}<!--  x -- y  -->$/m);
});

test('element containing a block is a container even when inline by name', () => {
  const out = layout(page('<a href="x"><div>in</div></a>'));
  assert.match(out, /^ {4}<a href="x">\n {6}<div>in<\/div>\n {4}<\/a>$/m);
});

test('each element of an svg takes its own line', () => {
  const out = layout(page('<svg viewBox="0 0 9 9"><g><rect x="1"></rect><circle r="2"></circle></g></svg>'));
  assert.match(out, /^ {4}<svg viewBox="0 0 9 9">\n {6}<g>\n {8}<rect x="1"><\/rect>\n {8}<circle r="2"><\/circle>\n {6}<\/g>\n {4}<\/svg>$/m);
});

test('an svg text stays whole on one line, however long, directive and tspan included', () => {
  const long = 'word '.repeat(30).trim();
  const out = layout(page(`<svg><text x="1"><!-- @AI: bigger -->${long} <tspan>a  b</tspan> </text></svg>`));
  assert.match(out, new RegExp(`^ {6}<text x="1"><!-- @AI: bigger -->${long} <tspan>a b</tspan> </text>$`, 'm'));
});

test('foreignObject in an svg holds HTML, laid out as HTML', () => {
  const out = layout(page('<svg><foreignObject><p>a <em>b</em> c</p></foreignObject></svg>'));
  assert.match(out, /^ {8}<p>a <em>b<\/em> c<\/p>$/m);
});

test('fragment input still produces a stable document', () => {
  const once = normalize('<p>just a <b>fragment</b></p>');
  assert.equal(normalize(once), once);
});
