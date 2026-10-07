import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../server.mjs';

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
  const out = normalize(page('<h1>Project <em>Overview</em></h1><ul><li>Ship it</li></ul>'));
  assert.match(out, /^ {4}<h1>Project <em>Overview<\/em><\/h1>$/m);
  assert.match(out, /^ {6}<li>Ship it<\/li>$/m);
});

test('long inline-only block takes three lines', () => {
  const long = 'word '.repeat(30).trim();
  const out = normalize(page(`<p>${long}</p>`));
  assert.match(out, new RegExp(`^ {4}<p>\\n {6}${long}\\n {4}</p>$`, 'm'));
});

test('whitespace between inline siblings survives', () => {
  const out = normalize('<body><p>a <b>b</b> &amp; c</p><p><b>x</b> <i>y</i></p></body>');
  assert.match(out, /<p>a <b>b<\/b> &amp; c<\/p>/);
  assert.match(out, /<p><b>x<\/b> <i>y<\/i><\/p>/);
});

test('only ASCII whitespace collapses; nbsp survives', () => {
  const out = normalize('<body><p>a \n\t  b&nbsp;&nbsp;c &nbsp;</p></body>');
  assert.match(out, /<p>a b&nbsp;&nbsp;c &nbsp;<\/p>/);
});

test('entities are escaped once, not twice', () => {
  const out = normalize('<body><p>&amp;amp; &lt;b&gt; 1 &amp; 2</p></body>');
  assert.match(out, /<p>&amp;amp; &lt;b&gt; 1 &amp; 2<\/p>/);
});

test('pre, script, style, textarea inner content is untouched', () => {
  const src =
    '<body><pre>  a\n    <code>b &amp; c</code>\n\n</pre><script>var s = "  x  <y> &amp;";\n  go();</script>' +
    '<style>a  >  b {  color: red }</style><textarea>  t\n &lt;</textarea></body>';
  const out = normalize(src);
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
  const out = normalize('<body><img src="a.png" alt="" /><input disabled value="x"><hr/></body>');
  assert.match(out, /<img src="a\.png" alt>/);
  assert.match(out, /<input disabled value="x">/);
  assert.match(out, /<hr>/);
  assert.ok(!out.includes('/>'));
});

test('attributes keep order and escape & and "', () => {
  const out = normalize(`<body><a title='say "hi"' href="x?a=1&amp;b=2" id=z>l</a></body>`);
  assert.match(out, /<a title="say &quot;hi&quot;" href="x\?a=1&amp;b=2" id="z">l<\/a>/);
});

test('comments sit on their own lines, data unchanged', () => {
  const out = normalize(page('<p>a</p><!--  x -- y  --><p>b</p>'));
  assert.match(out, /^ {4}<!--  x -- y  -->$/m);
});

test('element containing a block is a container even when inline by name', () => {
  const out = normalize(page('<a href="x"><div>in</div></a>'));
  assert.match(out, /^ {4}<a href="x">\n {6}<div>in<\/div>\n {4}<\/a>$/m);
});

test('fragment input still produces a stable document', () => {
  const once = normalize('<p>just a <b>fragment</b></p>');
  assert.equal(normalize(once), once);
});
