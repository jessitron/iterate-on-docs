// html-revisor scopes: what you can pick in a page, and the markdown you would edit for each.
//
//   node scopes.mjs <file>              prints the scope tree of the body
//   node scopes.mjs --annotate <file>   writes, under each .ex example, its HTML and a table
//                                       of its scopes and their markdown (in place)
//
// A scope is any block element, plus links and images. You pick it to leave a directive or to
// edit its whole content as markdown: a section, a list, one list item, a table, one cell (Jess,
// 2026-10-12, F2 in try-me.html#scopes). Other inline elements, like strong, belong to their
// block. The markdown here is a first pass for looking at cases; PLAN.html stage 4 owns the
// real round-trip.
//
// Tiers, dependencies point downward only:
//   Tier I   orchestration: the CLI
//   Tier II  domain: scopes, markdown, the report, annotation (pure functions over a DOM)
//   Tier III interface: the filesystem, through fs in the CLI; parse/serialize from formatter.mjs
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parse, serialize, trimAscii } from './formatter.mjs';

// ======================================================================
// Tier I: orchestration
// ======================================================================

export async function main(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const annotating = args[0] === '--annotate';
  const files = annotating ? args.slice(1) : args;
  if (files.length === 0) {
    stderr.write('usage: node scopes.mjs [--annotate] <file>...\n');
    return 2;
  }
  for (const file of files) {
    const document = parse(await fs.readFile(file, 'utf8'));
    if (annotating) {
      annotate(document);
      await fs.writeFile(file, serialize(document));
    } else {
      stdout.write(report(scopeOf(document.querySelector('body'))) + '\n');
    }
  }
  return 0;
}

// ======================================================================
// Tier II: domain
// ======================================================================

// ---- Kinds of element ---------------------------------------------------

// Not shown, so never a scope and never in the markdown.
const HIDDEN = new Set('head script style template title meta link noscript'.split(' '));

// Shown, but not text. Inside prose it is a token: ⟦svg⟧.
const NONPROSE = new Set(
  'svg img picture video audio canvas iframe embed object math input button select textarea meter progress hr'.split(' '),
);

// Flow content. Everything else is phrasing. svg and img are not here: inside a sentence they are tokens.
const BLOCK = new Set(
  `address article aside blockquote body details dialog div dl dd dt fieldset figcaption figure
   footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main menu nav ol p pre section summary
   table caption colgroup thead tbody tfoot tr th td ul`.split(/\s+/),
);

// Block by name, or because it holds a block (E3: a link wrapping a card).
function holdsBlocks(el) {
  return [...el.children].some((c) => BLOCK.has(c.localName) || (!NONPROSE.has(c.localName) && holdsBlocks(c)));
}
const isBlock = (el) => BLOCK.has(el.localName) || holdsBlocks(el);

// Attributes the tool adds. Markdown doesn't carry them; the prior HTML does.
const IGNORED_ATTRS = new Set(['data-chunk', 'data-hrv']);
const attrNames = (el) => [...el.attributes].map((a) => a.name).filter((a) => !IGNORED_ATTRS.has(a));
const hasAttrs = (el) => attrNames(el).length > 0;

// ---- Scopes -------------------------------------------------------------

// A scope: { el, markdown, children }. Every block element is one; so are links, images, and
// svg <text> labels (D6). The children are the scopes nested inside it.
export function scopeOf(el) {
  return { el, markdown: scopeMarkdown(el), children: scopesWithin(el) };
}

const TABLE_ROWS = new Set(['thead', 'tbody', 'tfoot', 'tr']);
// Inline elements you can pick, decided per element (Jess, 2026-10-12). strong: no.
const INLINE_SCOPES = new Set(['a', 'img']);

export const scopesWithin = (el) => pickable(el).map(scopeOf);

// The elements of the scopes nested in el, nearest first. The rule behind scopesWithin.
function pickable(el) {
  return [...el.children].flatMap((c) => {
    if (HIDDEN.has(c.localName)) return [];
    if (c.localName === 'text' && c.closest('svg')) return [c];
    if (INLINE_SCOPES.has(c.localName) && !isBlock(c)) return [c];
    if (c.localName === 'hr') return [];
    if (TABLE_ROWS.has(c.localName)) return pickable(c); // pick a cell or the table, not a row
    if (isBlock(c)) return [c];
    return pickable(c);
  });
}

// Every scope element in the document, in document order: body, and every scope inside it.
// The formatter gives each one an element ID.
export function scopeElements(document) {
  const walk = (el) => [el, ...pickable(el).flatMap(walk)];
  return walk(document.querySelector('body'));
}

// ---- Markdown -----------------------------------------------------------

// Unlikely shapes (empty paragraphs, dl, stat tiles) may come out ugly here. Spend the effort
// on the shapes agents write (Jess, 2026-10-12). They still have to round-trip.

// The markdown for a scope's content. The scope's own tag is the element's business, so a
// heading picked alone shows no #; inside a bigger scope it does (A3).
export function scopeMarkdown(el) {
  if (el.localName === 'pre') return fence(el);
  if (INLINE_SCOPES.has(el.localName) && !isBlock(el)) return inline([el]); // the whole link: [text](href)
  if (MARKDOWN_ITSELF.has(el.localName)) return block(el);
  if (el.localName === 'li') return itemBody(el, isLoose(el));
  if (!holdsBlocks(el)) return inline(el.childNodes);
  return blocks(el.childNodes, '\n\n');
}

// Elements whose markdown is the syntax itself: a list's content is its - lines.
const MARKDOWN_ITSELF = new Set(['ul', 'ol', 'table']);

// Block children in markdown, separated by sep. Bare text between blocks is a paragraph (C10).
function blocks(nodes, sep) {
  const parts = [];
  let run = [];
  const flush = () => {
    const md = inline(run);
    if (md) parts.push(md);
    run = [];
  };
  for (const n of nodes) {
    if (n.nodeType === 1 && HIDDEN.has(n.localName)) continue;
    if (n.nodeType === 1 && isBlock(n)) {
      flush();
      parts.push(block(n));
    } else if (n.nodeType === 1 || n.nodeType === 3) {
      run.push(n);
    }
  }
  flush();
  return parts.join(sep);
}

function block(el) {
  const name = el.localName;
  const plain = !hasAttrs(el);
  if (name === 'hr') return '---';
  if (name === 'pre') return fence(el);
  if (plain && /^h[1-6]$/.test(name)) return `${'#'.repeat(Number(name[1]))} ${inline(el.childNodes)}`;
  if (plain && (name === 'p' || name === 'div') && !holdsBlocks(el)) return inline(el.childNodes);
  if (plain && name === 'ul') return list(el, null);
  if (name === 'ol' && attrNames(el).every((a) => a === 'start')) return list(el, Number(el.getAttribute('start') ?? 1));
  if (plain && name === 'blockquote') return quote(scopeMarkdown(el));
  if (plain && name === 'table' && simpleTable(el)) return gfmTable(el);
  if (name === 'table') return rawHTML(el);
  // Markdown has no syntax for it: the tag stays, with markdown inside.
  if (!holdsBlocks(el)) return `${openTag(el)}${inline(el.childNodes)}</${name}>`;
  return `${openTag(el)}\n\n${blocks(el.childNodes, '\n\n')}\n\n</${name}>`;
}

function list(el, start) {
  const items = [...el.children].filter((c) => c.localName === 'li');
  const loose = items.some(isLoose);
  return items
    .map((li, i) => {
      const marker = start === null ? '- ' : `${start + i}. `;
      return marker + indent(itemBody(li, loose), marker.length);
    })
    .join(loose ? '\n\n' : '\n');
}

// A loose list item holds paragraphs, so its blocks sit a blank line apart (C3).
const isLoose = (li) => [...li.children].some((c) => c.localName === 'p');
const itemBody = (li, loose) => (holdsBlocks(li) ? blocks(li.childNodes, loose ? '\n\n' : '\n') : inline(li.childNodes));

const indent = (text, n) => text.replace(/\n(?=.)/g, `\n${' '.repeat(n)}`);
const quote = (text) => text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

function fence(pre) {
  const text = pre.textContent.replace(/\n$/, '');
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}\n${text}\n${ticks}`;
}

// A table markdown can say: a header row of th, every cell phrasing, no caption.
function simpleTable(table) {
  const rows = [...table.querySelectorAll('tr')];
  return (
    rows.length > 0 &&
    !table.querySelector('caption') &&
    [...rows[0].children].every((c) => c.localName === 'th') &&
    rows.every((r) => [...r.children].every((c) => !holdsBlocks(c) && !hasAttrs(c)))
  );
}

function gfmTable(table) {
  const rows = [...table.querySelectorAll('tr')].map((r) => [...r.children].map((c) => inline(c.childNodes).replace(/\|/g, '\\|')));
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
}

// Phrasing content in markdown. Markdown syntax only for elements with no attributes
// (a: href and title; img: src and alt); the rest stays as HTML, which CommonMark allows inline.
function inline(nodes) {
  const md = [...nodes].map(inlineNode).join('');
  return md.split('\n').map(trimAscii).join('\n').replace(/^(#|[-+>]|\d+[.)])(?= |$)/gm, '\\$1').trim();
}

const MARKS = { strong: '**', b: '**', em: '*', i: '*' };

function inlineNode(n) {
  if (n.nodeType === 3) return escapeMarkdown(n.data.replace(/[ \t\n\r\f]+/g, ' '));
  if (n.nodeType !== 1 || HIDDEN.has(n.localName)) return '';
  const name = n.localName;
  const plain = !hasAttrs(n);
  const kids = () => [...n.childNodes].map(inlineNode).join('');
  if (name === 'br') return '\n'; // A4: a newline, not a backslash. The conversion back makes it <br>.
  if (name === 'img') return `![${n.getAttribute('alt') ?? ''}](${n.getAttribute('src') ?? ''})`; // D2: other attributes come back from the original
  if (NONPROSE.has(name)) return `⟦${name}⟧`;
  if (plain && name in MARKS) return MARKS[name] + kids() + MARKS[name];
  if (plain && name === 'code' && n.children.length === 0) {
    const fence = n.textContent.includes('`') ? '``' : '`';
    return fence + n.textContent + fence;
  }
  if (name === 'a' && attrNames(n).every((a) => a === 'href' || a === 'title')) {
    const title = n.getAttribute('title');
    return `[${kids()}](${n.getAttribute('href') ?? ''}${title ? ` "${title}"` : ''})`;
  }
  return `${openTag(n)}${kids()}</${name}>`;
}

const openTag = (el) => `<${el.localName}${attrNames(el).map((a) => ` ${a}="${el.getAttribute(a)}"`).join('')}>`;

// Characters markdown would read as syntax. U+00A0 stays a plain character (A5).
function escapeMarkdown(text) {
  return text
    .replace(/[\\`*_[\]]/g, '\\$&')
    .replace(/&(?=[a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;')
    .replace(/</g, '&lt;');
}

// The element's HTML as it sits in the file, minus directives and annotation, dedented.
export function rawHTML(el) {
  const copy = el.cloneNode(true);
  stripForDisplay(copy);
  return dedent(copy.outerHTML);
}

function stripForDisplay(el) {
  for (const n of [...el.childNodes]) {
    if (n.nodeType === 8) n.remove();
    else if (n.nodeType === 1) stripForDisplay(n);
  }
  if (el.removeAttribute) for (const a of IGNORED_ATTRS) el.removeAttribute(a);
}

// Every line after the first carries the file's indentation; the last line (the closing tag)
// shows how much belongs to the element's depth.
function dedent(html) {
  const lines = html.split('\n');
  const depth = lines.length > 1 ? lines.at(-1).match(/^ */)[0].length : 0;
  return lines.map((l, i) => (i === 0 ? l : l.slice(Math.min(depth, l.match(/^ */)[0].length)))).join('\n');
}

// ---- Report -------------------------------------------------------------

const label = (el) => `<${el.localName}${el.getAttribute('class') ? `.${el.getAttribute('class').split(/\s+/).join('.')}` : ''}>`;

// How much of the scope markdown can say.
export function coverage(scope) {
  const md = scope.markdown;
  if (scope.el.localName === 'text') return 'svg text: markdown inside the label';
  if (md.trim() === '') return 'nothing to edit';
  const notes = [];
  if (/<[a-z]/.test(md)) notes.push('HTML');
  if (/⟦/.test(md)) notes.push('⟦tokens⟧');
  return notes.length ? `markdown with ${notes.join(' and ')}` : 'all markdown';
}

// One line per scope, indented by nesting, the markdown on one line (⏎ for newlines).
export function report(scope, depth = 0) {
  const md = scope.markdown.replace(/\n/g, '⏎');
  const lines = [`${'  '.repeat(depth)}${label(scope.el)}${md ? `  ${md}` : ''}`];
  for (const child of scope.children) lines.push(report(child, depth + 1));
  return lines.join('\n');
}

function reportRows(document, scope, depth = 0) {
  const tr = document.createElement('tr');
  const cell = (text, mono) => {
    const td = document.createElement('td');
    if (mono && text) {
      const pre = document.createElement('pre');
      pre.textContent = text;
      td.appendChild(pre);
    } else td.textContent = text;
    tr.appendChild(td);
  };
  cell(`${' '.repeat(depth)}${label(scope.el)}`);
  cell(coverage(scope));
  cell(scope.markdown, true);
  return [tr, ...scope.children.flatMap((c) => reportRows(document, c, depth + 1))];
}

// ---- Annotation ---------------------------------------------------------

// Under each .ex example: a details holding its HTML, and a table of its scopes. Annotating
// again replaces the old ones, leaving everything else (directives included) where it was.
export function annotate(document) {
  clearAnnotations(document);
  for (const ex of document.querySelectorAll('.ex')) {
    const html = document.createElement('details');
    html.setAttribute('class', 'scope-report');
    const summary = document.createElement('summary');
    summary.textContent = 'HTML';
    const pre = document.createElement('pre');
    pre.textContent = [...ex.children].map(rawHTML).join('\n');
    html.append(summary, pre);

    const table = document.createElement('table');
    table.setAttribute('class', 'scope-report');
    table.innerHTML = '<tr><th>element</th><th>what markdown can say</th><th>what you would edit</th></tr>';
    for (const scope of scopesWithin(ex)) {
      for (const row of reportRows(document, scope)) table.appendChild(row);
    }
    ex.after(html, table);
  }
  const legend = document.createElement('p');
  legend.setAttribute('class', 'scope-report');
  legend.innerHTML = LEGEND;
  document.querySelector('#scopes > p')?.after(legend);
  const style = document.createElement('style');
  style.setAttribute('id', 'scope-view');
  style.textContent = SCOPE_VIEW_CSS;
  document.querySelector('head').appendChild(style);
}

const LEGEND = `Under each example: its HTML (click to open), then a row for each element you could pick,
  nested inside the element that holds it. The last column is the markdown you would edit if you
  picked that element. ⟦svg⟧ marks something that isn't text riding inside the markdown.`;

// Clears this tool's marks, and those of chunks.mjs, the earlier version of this tool.
function clearAnnotations(document) {
  document.querySelectorAll('.scope-report, #scope-view, .chunk-report, #chunk-view').forEach((el) => el.remove());
  document.querySelectorAll('[data-chunk]').forEach((el) => el.removeAttribute('data-chunk'));
}

const SCOPE_VIEW_CSS = `
  table.scope-report { font-size: 0.75rem; margin: 0.5rem 0; width: 100%; }
  table.scope-report td, table.scope-report th { vertical-align: top; padding: 0.15rem 0.5rem; }
  table.scope-report td:first-child { font-family: ui-monospace, monospace; white-space: pre; }
  table.scope-report pre, details.scope-report pre { margin: 0; padding: 0.15rem 0.4rem; background: #f6f8fa; white-space: pre-wrap; }
  details.scope-report { font-size: 0.75rem; margin: 0.5rem 0; }
`;

// Run the CLI when this file is the entry point, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
