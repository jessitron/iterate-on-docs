// The round-trip property: for every scope, scope → markdown → scope is the
// same HTML, element IDs and directives included. Opening a scope and saving it unchanged
// must leave the file unchanged.
//
// The reconcile property (stage 6): edit a scope, write the edited scope's markdown, and save
// it over the prior scope. That gives back the edited scope, IDs included: an element you
// edited, moved, or left alone keeps its ID, and one you added has none.
//
// Directives ride along (stage 7): every element gets one, and after a save each is on the
// element it was on, or is gone with it, if the edit removed that element.
//
// Two sources of scopes: frozen copies of this repo's pages, and pages generated from a seed in the shapes
// agents write, with text full of characters markdown reads as syntax. No property-testing
// library: deploy runs these tests where npm install can't. A failure prints its seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, parse } from '../formatter.mjs';
import { scopeElements as allScopes, scopeMarkdown, scopeFromMarkdown, canonicalHTML, editable } from '../scopes.mjs';
import { allComments, directiveOwner, placeDirective } from '../directives.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The scopes that edit as markdown. One too big has no Content field, so nothing to test.
const scopeElements = (document) => allScopes(document).filter(editable);

// Why a scope doesn't round-trip, or null if it does.
function roundTripFailure(document, el) {
  const markdown = scopeMarkdown(el);
  const saved = scopeFromMarkdown(el, markdown);
  const before = `${canonicalHTML(document, [el], { ids: true })}\n${directivesIn([el])}`;
  const after = `${canonicalHTML(document, saved, { ids: true })}\n${directivesIn(saved)}`;
  if (before === after) return null;
  return `<${el.localName}> doesn't round-trip.\n--- HTML\n${before}\n--- markdown\n${markdown}\n--- back\n${after}`;
}

// ---- Every page here ----------------------------------------------------

// test/pages holds frozen copies of this repo's own pages. The live ones change under every
// iteration, and a test shouldn't fail because Jess edited a page.
const pages = ['test/pages', 'test/fixtures'].flatMap((dir) =>
  fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.html')).map((f) => path.join(root, dir, f)));

for (const file of pages) {
  test(`every scope in ${path.relative(root, file)} round-trips`, () => {
    const document = directEverything(parse(normalize(fs.readFileSync(file, 'utf8'))));
    for (const el of scopeElements(document)) {
      const failure = roundTripFailure(document, el);
      assert.equal(failure, null, failure);
    }
  });
}

// ---- Generated pages ----------------------------------------------------

// mulberry32: small, seeded, good enough to pick shapes.
function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (xs) => xs[int(xs.length)];
  const times = (lo, hi, f) => Array.from({ length: lo + int(hi - lo + 1) }, f);
  return { int, pick, times, chance: (p) => next() < p };
}

// Words agents write, and words markdown would read as syntax. Escaped as HTML text.
const WORDS = [
  'the', 'scope', 'saves', 'markdown', 'deploy', 'formatter', 'plan', 'stage', 'directive', 'yak',
  'snake_case', 'a*b', '2*3=6', '`tick`', '[x]', '[link](y)', '#1', 'C#', 'x|y', '***', '---', '===',
  '~~strike~~', '\\back', 'AT&amp;T', '&amp;copy;', '&lt;tag&gt;', 'a&lt;b', '"quoted"', "it's", '!',
  '![no](img)', '_under_', 'ünïcode', '😀', 'nbsp&nbsp;here', 'http://example.com', '⟦svg⟧', '1.', '2)',
  '+', '-', '&gt;', '*', '_',
];
const PLAIN = WORDS.slice(0, 10);
const attr = (s) => s.replace(/"/g, '&quot;');
const wrap = (tag, inner) => `<${tag}>${inner}</${tag}>`;
const HREFS = ['#x', 'page.html', 'https://example.com/a?b=1&amp;c=2', 'a b.html', 'x(1).html', 'mailto:j@example.com', 'data:image/png;base64,AAAA', 'q.html#a_b'];
const ICON = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg>';

// tidy: the shapes agents write most, which should come out as markdown with no HTML in it.
function generator(r, tidy) {
  const words = tidy ? PLAIN : WORDS;
  const text = (lo = 1, hi = 4) => r.times(lo, hi, () => r.pick(words)).join(' ');
  const inline = (depth = 0) => {
    const parts = r.times(1, 4, () => {
      const kinds = ['text', 'text', 'strong', 'em', 'code', 'a', 'img', 'br'];
      if (!tidy) kinds.push('span', 'kbd', 'icon', 'a-target', 'img-sized', 'spaced', 'empty', 'touching', 'code-ticks', 'a-title', 'nbsp', 'newline');
      const kind = depth > 1 ? 'text' : r.pick(kinds);
      switch (kind) {
        case 'strong': return `<strong>${tidy ? text() : inline(depth + 1)}</strong>`;
        case 'em': return `<em>${tidy ? text() : inline(depth + 1)}</em>`;
        case 'code': return `<code>${r.pick(words)}${r.chance(0.3) ? ' ' + r.pick(WORDS) : ''}</code>`;
        case 'a': return `<a href="${r.pick(tidy ? ['#x', 'page.html'] : HREFS)}">${text()}</a>`;
        case 'a-target': return `<a href="${r.pick(HREFS)}" target="_blank">${text()}</a>`;
        case 'img': return `<img src="${r.pick(['pic.png', 'a b.png'])}" alt="${attr(tidy ? text() : r.pick(words))}">`;
        case 'img-sized': return `<img src="pic.png" alt="${attr(text())}" width="20" height="10">`;
        case 'br': return `${text()}<br>${text()}`;
        case 'span': return `<span class="tag">${inline(depth + 1)}</span>`;
        case 'kbd': return `<kbd>${r.pick(words)}</kbd>`;
        case 'icon': return ICON;
        case 'spaced': return wrap(r.pick(['strong', 'em']), ` ${text()} `);
        case 'empty': return r.pick(['<em></em>', '<strong></strong>', '<code></code>', '<a href="#x"></a>', '<span class="tag"></span>']);
        case 'touching': return `${r.pick(WORDS)}${wrap(r.pick(['strong', 'em', 'code']), r.pick(WORDS))}${r.pick(WORDS)}`;
        case 'code-ticks': return `<code>${r.pick(['`', '``a``', ' a ', '  ', 'a`b', '`a', '<b>'])}</code>`.replace('<b>', '&lt;b&gt;');
        case 'a-title': return `<a href="x.html" title="say &quot;hi&quot; \\ (there)">${text()}</a>`;
        case 'nbsp': return `&nbsp;${text()}&nbsp;`;
        case 'newline': return `${text()}\n    ${text()}`;
        default: return text();
      }
    });
    return parts.join(tidy || r.chance(0.8) ? ' ' : '');
  };
  const item = (depth, loose) => {
    if (loose) return `<li>${r.times(1, 3, () => `<p>${inline()}</p>`).join('')}</li>`;
    const nested = depth < 2 && r.chance(0.3) ? list(depth + 1) : '';
    return `<li>${inline()}${nested}</li>`;
  };
  const list = (depth = 0) => {
    const tag = r.pick(['ul', 'ol']);
    // Nested under an item's text, a list numbered from past 1 can only be HTML.
    const start = tag === 'ol' && (!tidy || depth === 0) && r.chance(0.3) ? ` start="${2 + r.int(5)}"` : '';
    const loose = !tidy && r.chance(0.25);
    const cls = !tidy && r.chance(0.2) ? ' class="yaks"' : '';
    return `<${tag}${start}${cls}>${r.times(1, 4, () => item(depth, loose)).join('')}</${tag}>`;
  };
  const table = () => {
    const cols = 1 + r.int(3);
    const row = (tag) => `<tr>${r.times(cols, cols, () => `<${tag}>${tidy ? text() : inline(2)}</${tag}>`).join('')}</tr>`;
    return `<table><tr>${r.times(cols, cols, () => `<th>${text()}</th>`).join('')}</tr>${r.times(0, 3, () => row('td')).join('')}</table>`;
  };
  const pre = () => {
    const lines = r.times(1, 4, () => `${r.pick(['', '  ', '    '])}${text()}`).join('\n');
    const code = r.pick(['', ' class="language-js"']);
    return r.chance(0.7) ? `<pre><code${code}>${lines}</code></pre>` : `<pre>${lines}</pre>`;
  };
  const block = (depth = 0) => {
    const kinds = ['p', 'p', 'p', 'h', 'list', 'list', 'table', 'pre', 'hr', 'blockquote'];
    if (depth < 2) kinds.push('card', 'section');
    if (!tidy) kinds.push('p-class', 'figure', 'details', 'bare', 'empty-p', 'h-id', 'h-hash', 'empty-li', 'head-only', 'pipes', 'fences', 'lists-hr');
    switch (r.pick(kinds)) {
      case 'h': {
        const level = 2 + r.int(3);
        return `<h${level}>${tidy ? text() : inline(1)}</h${level}>`; // a heading holding a <br> is HTML
      }
      case 'list': return list();
      case 'table': return table();
      case 'pre': return pre();
      case 'hr': return '<hr>';
      case 'blockquote': return `<blockquote>${r.times(1, 2, () => `<p>${inline()}</p>`).join('')}</blockquote>`;
      case 'card': return `<div class="card">${r.times(1, 3, () => block(depth + 1)).join('')}</div>`;
      case 'section': return `<section><h2>${text()}</h2>${r.times(1, 3, () => block(depth + 1)).join('')}</section>`;
      case 'p-class': return `<p class="why">${inline()}</p>`;
      case 'figure': return `<figure>${ICON}<figcaption>${inline()}</figcaption></figure>`;
      case 'details': return `<details><summary>${text()}</summary><p>${inline()}</p></details>`;
      case 'bare': return `<div>${text()}${list()}${text()}</div>`;
      case 'empty-p': return '<p></p>';
      case 'h-id': return `<h3 id="goals">${text()}</h3>`;
      case 'h-hash': return `<h2>${text()} #</h2>`;
      case 'empty-li': return `<ul><li>${text()}</li><li></li></ul>`;
      case 'head-only': return `<table><tr><th>${text()}</th><th></th></tr></table>`;
      case 'pipes': return `<table><tr><th>a|b</th></tr><tr><td><code>x|y</code> \\| ${text()}</td></tr></table>`;
      case 'fences': return r.pick(['<pre><code>```\nin\n```</code></pre>', '<pre>~~~\nin\n~~~</pre>', '<pre><code>\n\nblank first</code></pre>']);
      case 'lists-hr': return `${list()}<hr>${list()}`;
      default: return `<p>${inline()}</p>`;
    }
  };
  return () => r.times(1, 5, () => block()).join('');
}

const SEEDS = Number(process.env.ROUND_TRIP_SEEDS ?? 150);

for (const tidy of [false, true]) {
  test(`generated ${tidy ? 'tidy ' : ''}pages: every scope round-trips (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const body = generator(random(seed), tidy)();
      const document = directEverything(parse(normalize(`<html><body>${body}</body></html>`)));
      for (const el of scopeElements(document)) {
        const failure = roundTripFailure(document, el);
        assert.equal(failure, null, `seed ${seed}${tidy ? ' (tidy)' : ''}: ${failure}`);
      }
    }
  });
}

// ---- Edits --------------------------------------------------------------

// One edit to a scope, made on a second copy of the page so the prior scope stays as it was.
// Each returns a description, or null when the scope has nothing it applies to.
// An svg, a button, or a script is a stand-in in markdown: it comes back from the prior HTML,
// text and all. Markdown can't make a new one.
const STAND_INS =
  'svg img picture video audio canvas iframe embed object math input button select textarea meter progress hr script style template noscript'
    .split(' ')
    .join(', ');
// Elements that can sit twice in a row without markdown running them together.
const REPEATS = new Set(['p', 'li', 'h2', 'h3', 'h4', 'tr', 'blockquote', 'pre', 'section', 'div']);

const textsIn = (el) => {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3 && /\S/.test(n.data)) out.push(n);
    else if (n.nodeType === 1 && !n.matches(STAND_INS)) [...n.childNodes].forEach(walk);
  };
  walk(el);
  return out;
};
const repeatable = (el) =>
  [...el.querySelectorAll('*')].filter((e) => REPEATS.has(e.localName) && !e.closest(STAND_INS) && textsIn(e).length > 0);
const replaceWord = (r, t, word) => {
  const words = [...t.data.matchAll(/\S+/g)];
  const m = r.pick(words);
  t.data = t.data.slice(0, m.index) + word + t.data.slice(m.index + m[0].length);
};
// The element, and the directive just before it when it can't hold one inside (a pre): they move together.
const withDirective = (el) => {
  let p = el.previousSibling;
  while (p?.nodeType === 3 && !/\S/.test(p.data)) p = p.previousSibling;
  return p?.nodeType === 8 && directiveOwner(p) === el ? [p, el] : [el];
};
const bareHTML = (el) => el.outerHTML.replace(/ data-hrv="\d+"/g, '');
// A copy with new words, so it shares none with the element it came from, and no stand-ins.
function fresh(el) {
  const copy = el.cloneNode(true);
  copy.querySelectorAll(STAND_INS).forEach((e) => e.remove());
  allComments(copy).forEach((c) => c.remove());
  [copy, ...copy.querySelectorAll('[data-hrv]')].forEach((e) => e.removeAttribute('data-hrv'));
  for (const t of textsIn(copy)) t.data = t.data.replace(/\S+/g, 'fresh');
  return copy;
}

const EDITS = {
  word(r, el) {
    const texts = textsIn(el);
    if (texts.length === 0) return null;
    const t = r.pick(texts);
    replaceWord(r, t, 'yak');
    return `a word in <${t.parentNode.localName}> is now "yak"`;
  },
  insert(r, el) {
    const candidates = repeatable(el);
    if (candidates.length === 0) return null;
    const at = r.pick(candidates);
    at.after(fresh(at));
    return `a new <${at.localName}> after <${at.localName} data-hrv="${at.getAttribute('data-hrv')}">`;
  },
  // Not one of two that are the same: nothing says which of them went.
  remove(r, el) {
    const candidates = repeatable(el).filter((e) => {
      const kin = [...e.parentNode.children].filter((s) => s.localName === e.localName);
      return kin.length > 1 && kin.every((s) => s === e || bareHTML(s) !== bareHTML(e));
    });
    if (candidates.length === 0) return null;
    const at = r.pick(candidates);
    // Its directives, and those of everything in it, go with it: a pre's sits before it.
    withDirective(at).forEach((n) => n.remove());
    return `<${at.localName} data-hrv="${at.getAttribute('data-hrv')}"> removed`;
  },
  swap(r, el) {
    const candidates = repeatable(el).filter(
      (e) => e.nextElementSibling?.localName === e.localName && bareHTML(e) !== bareHTML(e.nextElementSibling),
    );
    if (candidates.length === 0) return null;
    const at = r.pick(candidates);
    withDirective(at)[0].before(...withDirective(at.nextElementSibling));
    return `<${at.localName} data-hrv="${at.getAttribute('data-hrv')}"> moved down one`;
  },
  // Typed in one save: an edit, and a new element beside it. The edited one keeps a word of
  // what it was; replace its only word and nothing says which of the two it is.
  'word and insert'(r, el) {
    const candidates = repeatable(el).filter((e) => e.textContent.trim().split(/\s+/).length > 1);
    if (candidates.length === 0) return null;
    const at = r.pick(candidates);
    replaceWord(r, r.pick(textsIn(at)), 'yak');
    const copy = fresh(at);
    if (r.chance(0.5)) at.after(copy);
    else withDirective(at)[0].before(copy);
    return `a word in <${at.localName} data-hrv="${at.getAttribute('data-hrv')}"> is now "yak", and a new one beside it`;
  },
};

// Each ID in the nodes, and the tag and text of the element that carries it. Whitespace aside:
// an edit made in the DOM has none between elements.
function idsIn(nodes) {
  const lines = [];
  for (const n of nodes.filter((n) => n.nodeType === 1))
    for (const e of [n, ...n.querySelectorAll('[data-hrv]')])
      if (e.hasAttribute('data-hrv')) lines.push(`${e.getAttribute('data-hrv')} <${e.localName}> ${e.textContent.replace(/\s+/g, '')}`);
  return lines.sort().join('\n');
}

const within = (node, el) => {
  for (let n = node; n; n = n.parentNode) if (n === el) return true;
  return false;
};

// Each directive in the nodes, and the ID of the element it is about (the nearest one with an ID).
function directivesIn(nodes) {
  const lines = [];
  for (const n of nodes.filter((n) => n.nodeType === 1))
    for (const c of allComments(n)) {
      const owner = directiveOwner(c).closest?.('[data-hrv]');
      lines.push(`${c.data.trim()} on ${owner && within(owner, n) ? owner.getAttribute('data-hrv') : 'none'}`);
    }
  return lines.sort().join('\n');
}

// A directive on every element with an ID, naming it.
function directEverything(document) {
  for (const el of document.querySelectorAll('[data-hrv]')) placeDirective(el, `d${el.getAttribute('data-hrv')}`, '@AI');
  return document;
}

// Why saving the edited scope's markdown over the prior scope doesn't put each ID in the
// edited scope on an element with the same tag and text, or null if it does. Its HTML is the
// round-trip's business: edited bare text comes back as a paragraph (C10).
function reconcileFailure(prior, edited, el, r, kind) {
  const id = el.getAttribute('data-hrv');
  const live = edited.querySelector(`[data-hrv="${id}"]`);
  const copy = live.cloneNode(true);
  live.replaceWith(copy);
  try {
    const what = EDITS[kind](r, copy);
    if (what === null) return null;
    const markdown = scopeMarkdown(copy);
    const saved = scopeFromMarkdown(el, markdown);
    const [want, got] = [`${idsIn([copy])}\n${directivesIn([copy])}`, `${idsIn(saved)}\n${directivesIn(saved)}`];
    if (want === got) return null;
    const [html, back] = [canonicalHTML(edited, [copy]), canonicalHTML(prior, saved)];
    const shape = html === back ? '' : `\n--- edited HTML\n${html}\n--- saved HTML\n${back}`;
    const [wanted, gotten] = [want.split('\n'), got.split('\n')];
    const only = (xs, ys) => xs.filter((x) => !ys.includes(x)).join('\n');
    return `<${el.localName} data-hrv="${id}">, ${kind}: ${what}.\n--- markdown\n${markdown}\n--- wanted, not got\n${only(wanted, gotten)}\n--- got, not wanted\n${only(gotten, wanted)}${shape}`;
  } finally {
    copy.replaceWith(live);
  }
}

// Every scope in the page, each edited once, the edit picked by seed(n) for the nth scope. n
// counts the scopes too big to edit, so the limit doesn't change which edit the others get.
function pageFailure(html, seed, kind) {
  const [prior, edited] = [directEverything(parse(html)), directEverything(parse(html))];
  for (const [n, el] of allScopes(prior).entries()) {
    if (!editable(el)) continue;
    const failure = reconcileFailure(prior, edited, el, random(seed(n)), kind);
    if (failure) return `seed ${seed(n)}: ${failure}`;
  }
  return null;
}

for (const kind of Object.keys(EDITS)) {
  test(`edited, every scope in this repo's pages keeps its IDs: ${kind}`, () => {
    for (const file of pages) {
      const failure = pageFailure(normalize(fs.readFileSync(file, 'utf8')), (n) => n + 1, kind);
      assert.equal(failure, null, `${path.relative(root, file)}, ${failure}`);
    }
  });

  test(`edited, every scope in generated pages keeps its IDs: ${kind} (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const tidy = seed % 2 === 0;
      const html = normalize(`<html><body>${generator(random(seed), tidy)()}</body></html>`);
      const failure = pageFailure(html, (n) => seed * 1000 + n, kind);
      assert.equal(failure, null, `page seed ${seed}${tidy ? ' (tidy)' : ''}, ${failure}`);
    }
  });
}

// A section or a card has no markdown syntax: its tags stand on their own lines around markdown.
const WRAPPER_LINE = /^<\/?[a-z][a-z0-9]*(\s[^<>]*)?>$/gm;

test(`generated tidy pages come out as markdown, HTML only for the tags of sections and cards (${SEEDS} seeds)`, () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const document = parse(normalize(`<html><body>${generator(random(seed), true)()}</body></html>`));
    for (const el of scopeElements(document)) {
      const markdown = scopeMarkdown(el);
      const html = markdown
        .replace(WRAPPER_LINE, '')
        .replace(/\]\(<[^<>]*>/g, '](') // a destination with a space: ![x](<a b.png>)
        .replace(/`[^`\n]*`/g, '') // a code span: `<tag>`
        .match(/<\/?[a-z][a-z0-9]*[\s>]/);
      assert.equal(html, null, `seed ${seed}: <${el.localName}> came out with HTML:\n${canonicalHTML(document, [el])}\n--- markdown\n${markdown}`);
    }
  }
});
