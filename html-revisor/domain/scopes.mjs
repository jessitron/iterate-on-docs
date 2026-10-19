// Scopes: what you can pick in a page, and the markdown you would edit for each. Tier II, pure
// functions over a DOM: scopes, markdown both ways, and the report and annotation that
// scopes.mjs, the CLI, writes.
//
// A scope is any block element, plus links, images, and spans. You pick it to leave a directive or to
// edit its whole content as markdown: a section, a list, one list item, a table, one cell (Jess,
// 2026-10-12, F2 in SCOPES-DESIGN.html#scopes). Other inline elements, like strong, belong to their
// block. scopeMarkdown writes a scope as markdown and scopeFromMarkdown reads it back; saving
// it unchanged gives back the same HTML, element IDs included. Saving it
// edited, each element keeps its ID and its directives (SCOPES-DESIGN.html#identity). test/roundtrip.test.mjs.
import { trimAscii, formatElement, VOID } from './canonical.mjs';
import { allComments, directiveOwner, attachComments } from './directives.mjs';
import { MarkdownIt } from '../vendor/markdown-it.mjs';

// ---- Kinds of element ---------------------------------------------------

// Not shown, so never a scope. In markdown it is a token like ⟦svg⟧, so saving keeps it.
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

// A scope: { el, markdown, children }. Every block element is one; so are links, images, spans,
// and svg <text> labels (D6). The children are the scopes nested inside it.
export function scopeOf(el) {
  return { el, markdown: scopeMarkdown(el), children: scopesWithin(el) };
}

const TABLE_ROWS = new Set(['thead', 'tbody', 'tfoot', 'tr']);
// Inline elements whose markdown is the element itself: [text](href), ![alt](src).
const INLINE_SCOPES = new Set(['a', 'img']);
// Inline elements you can pick, decided per element (Jess, 2026-10-12). strong: no. span: yes,
// and it edits its content, like a block (Jess, 2026-10-13). Not inside a pre: those spans are
// highlighting, and the pre is the scope. Not a span that fills its parent: every click would
// land on it, and the parent, a link or a paragraph, could not be picked.
const PICKABLE_INLINE = new Set([...INLINE_SCOPES, 'span']);
const pickableInline = (el) =>
  PICKABLE_INLINE.has(el.localName) &&
  !isBlock(el) &&
  (el.localName !== 'span' || (!el.closest('pre') && [...el.parentNode.childNodes].filter(meaningful).length > 1));

export const scopesWithin = (el) => pickable(el).map(scopeOf);

// The elements of the scopes nested in el, nearest first. The rule behind scopesWithin.
function pickable(el) {
  return [...el.children].flatMap((c) => {
    if (HIDDEN.has(c.localName)) return [];
    if (c.localName === 'text' && c.closest('svg')) return [c];
    if (pickableInline(c)) return [c];
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

// ---- Size ---------------------------------------------------------------

// A scope of 4 KB of HTML or more doesn't edit as markdown (Jess, 2026-10-17): nobody edits a
// page's worth of text in a box, and rendering it is what made saves slow. It is still a scope:
// it keeps its ID and takes directives. Its size leaves out element IDs and comments, so a
// directive can't push it over.
export const EDIT_LIMIT = 4096;
export const editable = (el) => htmlSize(el, EDIT_LIMIT) < EDIT_LIMIT;

// About how many characters of HTML el is, counting no further than limit.
function htmlSize(el, limit) {
  let size = 0;
  const walk = (n) => {
    if (size >= limit) return;
    if (n.nodeType === 3) size += n.data.length;
    if (n.nodeType !== 1) return;
    size += 2 * n.localName.length + 5; // <x></x>
    for (const a of n.attributes) if (!IGNORED_ATTRS.has(a.name)) size += a.name.length + a.value.length + 4; // x=""
    for (const c of n.childNodes) walk(c);
  };
  walk(el);
  return size;
}

// ---- Markdown -----------------------------------------------------------

// Unlikely shapes (empty paragraphs, dl, stat tiles) may come out ugly here. Spend the effort
// on the shapes agents write (Jess, 2026-10-12). They still have to round-trip, so each piece
// is checked against the parser: a block, or a run of phrasing, that markdown-it wouldn't read
// back the same is written as HTML instead. The rules make the markdown readable; the check
// keeps it true.

// The markdown for a scope's content. The scope's own tag is the element's business, so a
// heading picked alone shows no #; inside a bigger scope it does (A3). So is a list's or a
// table's class: picked alone, a ul.yaks is its - lines.
export function scopeMarkdown(el) {
  const name = el.localName;
  if (name === 'pre') return fenceable(el, true) ? fence(el) : rawBlock(el);
  if (INLINE_SCOPES.has(name) && !isBlock(el)) return inline([el]); // the whole link: [text](href)
  if (MARKDOWN_ITSELF.has(name)) {
    const md = syntax(el);
    return md !== null && roundTrips(el, md) ? md : rawBlock(el);
  }
  if (name === 'li') return orHTML(el, itemBody(el, isLoose(el)), isLoose(el) ? '\n\n' : '\n');
  if (!holdsBlocks(el)) return inline(el.childNodes);
  return orHTML(el, blocks(el.childNodes, '\n\n'), '\n\n');
}

// The markdown if saving it unchanged gives back the scope, else its blocks as HTML.
const orHTML = (el, md, sep) => (roundTrips(el, md) ? md : blocks(el.childNodes, sep, true));

// Elements whose markdown is the syntax itself: a list's content is its - lines.
const MARKDOWN_ITSELF = new Set(['ul', 'ol', 'table']);

const syntax = (el) => (el.localName === 'table' ? gfmTable(el) : list(el));

// Block children in markdown, separated by sep. Bare text between blocks is a paragraph (C10).
function blocks(nodes, sep, asHTML = false) {
  const parts = [];
  let run = [];
  let last = null; // the block before, and whether it took the other list marker
  const flush = () => {
    const md = inline(run);
    if (md) {
      parts.push(md);
      last = null;
    }
    run = [];
  };
  for (const n of nodes) {
    if (n.nodeType === 1 && isBlock(n)) {
      const afterText = run.some(meaningful);
      flush();
      // On the line after text, a list numbered from past 1 would be more of the text.
      const joinsText = afterText && sep === '\n' && n.localName === 'ol' && (n.getAttribute('start') ?? '1') !== '1';
      const alt = last?.el.localName === n.localName && !last.alt;
      const md = (!asHTML && !joinsText && checked(n, block(n, alt))) || null;
      parts.push(md ?? rawBlock(n));
      last = { el: n, alt: alt && md !== null };
    } else if (n.nodeType === 1 || n.nodeType === 3) {
      run.push(n);
    }
  }
  flush();
  return parts.join(sep);
}

// The markdown for a block inside a bigger scope, or null where markdown has no way to say it.
function block(el, alt) {
  const name = el.localName;
  const plain = !hasAttrs(el);
  if (name === 'hr') return plain ? '---' : null;
  if (name === 'pre') return fenceable(el, false) ? fence(el) : null;
  if (name === 'ol' && attrNames(el).every((a) => a === 'start')) return list(el, alt);
  if (!plain) return holdsBlocks(el) ? wrapped(el) : null;
  if (/^h[1-6]$/.test(name)) return oneLine(inline(el.childNodes), (md) => `${'#'.repeat(Number(name[1]))} ${md}`);
  if (name === 'p') return inline(el.childNodes) || null;
  if (name === 'ul') return list(el, alt);
  if (name === 'table') return gfmTable(el);
  if (name === 'blockquote') return holdsBlocks(el) ? quote(blocks(el.childNodes, '\n\n')) : null;
  return holdsBlocks(el) ? wrapped(el) : null;
}

// Markdown has no syntax for the element: its tag stays as HTML, with markdown inside.
const wrapped = (el) => `${openTag(el)}\n\n${blocks(el.childNodes, '\n\n')}\n\n</${el.localName}>`;

const oneLine = (md, f) => (md.includes('\n') ? null : f(md));

// The markdown if markdown-it reads it back as el, else null.
function checked(el, md) {
  return md !== null && sameNodes([el], render(md)) ? md : null;
}

// The element as HTML, the way the file has it: an HTML block, which markdown leaves alone.
// What isn't shown is a token, as in prose: a style's blank lines would end the block. A ⟦ in
// the HTML is an entity, so it can't read as a token.
function rawBlock(el) {
  const copy = bare(el);
  for (const hidden of copy.querySelectorAll([...HIDDEN].join(','))) {
    const mark = copy.ownerDocument.createElement(STAND_IN);
    mark.setAttribute('name', hidden.localName);
    hidden.replaceWith(mark);
  }
  const html = formatElement(copy)
    .replace(/⟦/g, '&#x27E6;')
    .replace(new RegExp(`<${STAND_IN} name="([a-z0-9-]+)"></${STAND_IN}>`, 'g'), '⟦$1⟧');
  // A blank line ends an HTML block. Inside a pre, &#10; is the same newline.
  const unbroken = html.replace(/\n{2,}/g, (nl) => `\n${'&#10;'.repeat(nl.length - 1)}`);
  // On one line, an HTML block must start with a block tag; on its own line, any tag will do.
  const open = openTag(el);
  const close = `</${el.localName}>`;
  const ownLine = !unbroken.includes('\n') && unbroken.endsWith(close) ? `${open}\n${unbroken.slice(open.length, -close.length)}\n${close}` : unbroken;
  return [html, unbroken, ownLine].find((md) => sameNodes([el], render(md))) ?? html;
}

// A list's - lines, or null if markdown can't say it. Markdown makes every item of a list
// tight (phrasing in the item) or loose (paragraphs in the item), so the items must agree.
// alt: the list follows one of its kind, so it takes the other marker, * or 1), and stays a
// list of its own.
function list(el, alt = false) {
  const items = [...el.children];
  if (items.some((li) => li.localName !== 'li' || hasAttrs(li))) return null;
  const loose = items.some(isLoose);
  if (loose && !items.every(allBlocks)) return null;
  if (loose && items.length === 1 && blockCount(items[0]) < 2) return null; // one paragraph alone reads as tight
  const start = el.localName === 'ol' ? Number(el.getAttribute('start') ?? 1) : null;
  return items
    .map((li, i) => {
      const marker = start === null ? (alt ? '* ' : '- ') : `${start + i}${alt ? ')' : '.'} `;
      return marker + indent(itemBody(li, loose), marker.length);
    })
    .join(loose ? '\n\n' : '\n');
}

// A loose list item holds paragraphs, so its blocks sit a blank line apart (C3).
const isLoose = (li) => [...li.children].some((c) => c.localName === 'p');
const itemBody = (li, loose) => (holdsBlocks(li) ? blocks(li.childNodes, loose ? '\n\n' : '\n') : inline(li.childNodes));
const meaningful = (n) => n.nodeType === 1 || (n.nodeType === 3 && trimAscii(n.data) !== '');
const allBlocks = (li) => [...li.childNodes].filter(meaningful).every((n) => n.nodeType === 1 && isBlock(n));
const blockCount = (li) => [...li.childNodes].filter(meaningful).length;

const indent = (text, n) => text.replace(/\n(?=.)/g, `\n${' '.repeat(n)}`);
const quote = (text) => text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

// A pre markdown can fence: text, in a code element whose only attribute is its language.
// Picked alone, a pre of bare text fences too: saving puts the text back where it was.
// A pre markdown can fence: bare text, or text in a code element whose only attribute is its
// language. Picked alone, the pre's own attributes are the element's business.
function fenceable(pre, alone) {
  const kids = [...pre.childNodes].filter((n) => n.nodeType !== 8);
  const textOnly = (el) => [...el.childNodes].every((n) => n.nodeType !== 1);
  if (!alone && hasAttrs(pre)) return false;
  if (textOnly(pre)) return true;
  const [code] = kids;
  return (
    kids.length === 1 &&
    code.localName === 'code' &&
    textOnly(code) &&
    attrNames(code).every((a) => a === 'class') &&
    /^(language-\S+)?$/.test(code.getAttribute('class') ?? '')
  );
}

// A fence of backticks is <pre><code>; a fence of tildes is a bare <pre>, as agents often write.
function fence(pre) {
  const code = pre.querySelector('code');
  const language = (code?.getAttribute('class') ?? '').replace(/^language-/, '');
  const text = pre.textContent;
  const mark = code ? '`' : '~';
  const longest = Math.max(2, ...(text.match(code ? /`+/g : /~+/g) ?? []).map((t) => t.length));
  const fence = mark.repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

// A table markdown can say: one header row of th, body rows of td, every cell one line of
// phrasing, no caption. Anything else is null.
function gfmTable(table) {
  const sections = [...table.children];
  const [head, body] = sections;
  if (hasAttrs(table) || head?.localName !== 'thead' || head.children.length !== 1 || hasAttrs(head)) return null;
  if (sections.length > 2 || (body && (body.localName !== 'tbody' || hasAttrs(body)))) return null;
  const rows = [...head.children, ...(body?.children ?? [])];
  const cellsOk = (row, tag) => !hasAttrs(row) && [...row.children].every((c) => c.localName === tag && !hasAttrs(c) && !holdsBlocks(c));
  if (!cellsOk(rows[0], 'th') || !rows.slice(1).every((r) => r.localName === 'tr' && cellsOk(r, 'td'))) return null;
  const md = rows.map((r) => [...r.children].map((c) => inline(c.childNodes).replace(/\|/g, '\\|')));
  if (md.some((cells) => cells.some((c) => c.includes('\n')))) return null;
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(md[0]), line(md[0].map(() => '---')), ...md.slice(1).map(line)].join('\n');
}

// Phrasing content in markdown. Markdown syntax only for elements with no attributes
// (a: href and title; img: src and alt, the rest come back from the original, D2); the rest
// stays as HTML, which CommonMark allows inline. If markdown-it wouldn't read the markdown
// back the same (emphasis beside punctuation, say), the run's marks are written as HTML.
function inline(nodes) {
  nodes = [...nodes];
  const md = phrasing(nodes, false);
  if (nodes.length === 0 || sameNodes(nodes, renderInline(md))) return md;
  return phrasing(nodes, true);
}

function phrasing(nodes, asHTML) {
  const md = phrasingOf(nodes, asHTML);
  return trimAscii(
    md
      .split('\n')
      .map(trimAscii)
      .join('\n')
      .replace(/^([#>+=-])/gm, '\\$1')
      .replace(/^(\d+)([.)])/gm, '$1\\$2'),
  );
}

const MARKS = { strong: '**', em: '*' };

// linkedom splits text at each entity, so adjacent text nodes are escaped as one string:
// "&" and "copy;" in two nodes still read as &copy; once they are side by side.
function phrasingOf(nodes, asHTML) {
  const pieces = [];
  for (const n of nodes) {
    if (n.nodeType === 3 && typeof pieces.at(-1) === 'string') pieces[pieces.length - 1] += n.data;
    else pieces.push(n.nodeType === 3 ? n.data : n);
  }
  return pieces.map((p) => (typeof p === 'string' ? escapeMarkdown(collapse(p)) : inlineNode(p, asHTML))).join('');
}

function inlineNode(n, asHTML) {
  if (n.nodeType !== 1) return '';
  const name = n.localName;
  if (HIDDEN.has(name)) return `⟦${name}⟧`;
  const plain = !hasAttrs(n) && !asHTML;
  const kids = () => phrasingOf(n.childNodes, asHTML);
  const html = () => (VOID.has(name) ? openTag(n) : `${openTag(n)}${kids()}</${name}>`);
  if (name === 'br') return asHTML ? '<br>' : '\n'; // A4: a newline, not a backslash. The conversion back makes it <br>.
  if (name === 'img' && !asHTML) return image(n) ?? html();
  if (NONPROSE.has(name) && name !== 'img') return `⟦${name}⟧`;
  if (plain && name in MARKS) return MARKS[name] + kids() + MARKS[name];
  if (plain && name === 'code' && n.children.length === 0) return codeSpan(collapse(n.textContent)) ?? html();
  if (name === 'a' && !asHTML && attrNames(n).every((a) => a === 'href' || a === 'title') && n.hasAttribute('href')) {
    const target = destination(n.getAttribute('href'), n.getAttribute('title'));
    return target === null ? html() : `[${kids()}](${target})`;
  }
  return html();
}

function image(img) {
  const target = destination(img.getAttribute('src') ?? '', img.getAttribute('title'));
  return target === null ? null : `![${escapeMarkdown(img.getAttribute('alt') ?? '')}](${target})`;
}

// A link's destination and title as markdown writes them, or null where it can't.
function destination(href, title) {
  const url = /[\s()\\<>]/.test(href) || href === '' ? (/[<>\n\\]/.test(href) ? null : `<${href}>`) : href;
  if (url === null) return null;
  const quoted = title === null ? '' : ` "${title.replace(/[\\"]/g, '\\$&')}"`;
  return escapeEntities(url) + escapeEntities(quoted);
}

function codeSpan(text) {
  if (text === '' || /^ +$/.test(text)) return null;
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((t) => t.length));
  const ticks = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ')) ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

const openTag = (el) => `<${el.localName}${attrNames(el).map((a) => ` ${a}="${escapeAttr(el.getAttribute(a))}"`).join('')}>`;
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const collapse = (s) => s.replace(/[ \t\n\r\f]+/g, ' ');

// Characters markdown would read as syntax, and ⟦, which starts a stand-in. U+00A0 stays a
// plain character (A5).
function escapeMarkdown(text) {
  return escapeEntities(text.replace(/[\\`*_[\]~⟦]/g, '\\$&')).replace(/</g, '&lt;');
}
const escapeEntities = (text) => text.replace(/&(?=[a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');

// ---- Markdown back to HTML ----------------------------------------------

// The nodes that replace a scope's element when its markdown is saved. The prior element says
// what shape the markdown has, the same way it did for scopeMarkdown: an item's content, a
// list's lines, a paragraph's phrasing. Opening a scope and saving it unchanged gives back
// the same HTML, element IDs and directives included (SCOPES-DESIGN.html#identity).
export function scopeFromMarkdown(el, markdown) {
  const nodes = rebuild(el, markdown);
  return carryDirectives(el, nodes, reconcile([el], nodes));
}

function rebuild(el, markdown) {
  const nodes = restore([el], fromMarkdown(el, markdown));
  if (holdsParagraphs(el) && nodes.length === 1) keepBareText(el, nodes[0]);
  return nodes;
}

// A scope whose markdown is paragraphs and other blocks.
const holdsParagraphs = (el) =>
  holdsBlocks(el) && !['pre', 'li'].includes(el.localName) && !MARKDOWN_ITSELF.has(el.localName);

// Text that sat bare beside blocks in the prior HTML comes back as a paragraph (C10). Where it
// comes back unchanged, it goes back to bare text.
function keepBareText(prior, el) {
  const document = prior.ownerDocument;
  const runs = [];
  let run = [];
  for (const n of [...prior.childNodes, null]) {
    if (n === null || (n.nodeType === 1 && isBlock(n))) {
      if (run.some(meaningful)) runs.push(canonicalHTML(document, run));
      run = [];
    } else if (n.nodeType === 1 || n.nodeType === 3) run.push(n);
  }
  for (const p of [...el.children]) {
    if (p.localName !== 'p' || hasAttrs(p)) continue;
    const at = runs.indexOf(canonicalHTML(document, [...p.childNodes]));
    if (at < 0) continue;
    runs.splice(at, 1);
    p.replaceWith(...p.childNodes);
  }
}

// Whether saving this markdown unchanged gives back the scope as it is.
export const roundTrips = (el, markdown) =>
  canonicalHTML(el.ownerDocument, [el]) === canonicalHTML(el.ownerDocument, rebuild(el, markdown));

function fromMarkdown(el, markdown) {
  const name = el.localName;
  if (name === 'pre') return fenceable(el, true) ? [codeBlock(el, markdown)] : nodesOf(el, render(markdown));
  if (INLINE_SCOPES.has(name) && !isBlock(el)) return nodesOf(el, renderInline(markdown));
  if (MARKDOWN_ITSELF.has(name)) return adopt(el, nodesOf(el, render(markdown)));
  if (name === 'li') return [shell(el, itemContent(el, markdown))];
  if (holdsParagraphs(el)) return [shell(el, nodesOf(el, render(markdown)))];
  return [shell(el, nodesOf(el, renderInline(markdown)))];
}

// A list or table picked alone keeps its own attributes; an ol takes its start from the markdown.
function adopt(el, nodes) {
  const [only] = nodes.filter(meaningful);
  if (nodes.filter(meaningful).length !== 1 || only.localName !== el.localName) return nodes;
  const copy = shell(el, [...only.childNodes]);
  if (el.localName === 'ol') {
    if (only.hasAttribute('start')) copy.setAttribute('start', only.getAttribute('start'));
    else copy.removeAttribute('start');
  }
  return [copy];
}

// An item's markdown, rendered as the one item of a list, so markdown decides tight or loose.
function itemContent(el, markdown) {
  const [list] = nodesOf(el, render(`- ${indent(markdown, 2)}`));
  return list?.firstElementChild ? [...list.firstElementChild.childNodes] : [];
}

// A pre picked alone keeps its attributes and takes the fence's content. Markdown that isn't
// a fence any more is the pre's text.
function codeBlock(el, markdown) {
  const [rendered] = nodesOf(el, render(markdown)).filter(meaningful);
  if (rendered?.localName === 'pre') return shell(el, [...rendered.childNodes]);
  const pre = el.cloneNode(false);
  pre.textContent = markdown;
  return pre;
}

// What markdown holds as a stand-in comes back from the prior HTML, in order: ⟦svg⟧ is the
// next svg, ⟦script⟧ the next script, and an image keeps the attributes markdown can't say (D2).
// One that stood between blocks comes out of the paragraph markdown put it in. A token alone in
// its paragraph takes the next one that stood between blocks, and one inside text the next one
// that sat in text, so deleting an inline icon doesn't hand its place to a diagram. A token in an
// HTML block takes the next of its kind, wherever that stood.
function restore(prior, nodes) {
  const tokens = new Map();
  const images = [];
  const collect = (n) => {
    if (n.nodeType !== 1) return;
    if (n.localName === 'img') images.push(n);
    else if (NONPROSE.has(n.localName) || HIDDEN.has(n.localName)) {
      if (!tokens.has(n.localName)) tokens.set(n.localName, []);
      tokens.get(n.localName).push(n);
    } else [...n.childNodes].forEach(collect);
  };
  prior.forEach(collect);
  const holder = prior[0].ownerDocument.createElement('div');
  holder.append(...nodes);
  const alone = new Set();
  // Where each mark sits, before any is swapped: a swapped one is no longer a stand-in beside the next.
  const marks = [...holder.querySelectorAll(STAND_IN)].map((mark) => [mark, inOwnParagraph(mark)]);
  for (const [mark, ownParagraph] of marks) {
    const name = mark.getAttribute('name');
    const left = tokens.get(name) ?? [];
    const at = mark.hasAttribute('in-html') ? 0 : left.findIndex((o) => standsAlone(o) === ownParagraph);
    const [original] = left.splice(Math.max(at, 0), 1);
    if (!original) {
      mark.replaceWith(`⟦${name}⟧`); // nothing it stood for: the text you typed
      continue;
    }
    const copy = original.cloneNode(true);
    allComments(copy).forEach((c) => c.remove()); // its directives come back with the rest
    if (standsAlone(original)) alone.add(copy);
    mark.replaceWith(copy);
  }
  // The closest first, so two images of one picture that swap places keep their own sizes: the
  // same attributes (an image written as HTML says them all), then the same src and alt.
  const same = (img, names) => (o) => names.every((a) => o.getAttribute(a) === img.getAttribute(a));
  for (const img of holder.querySelectorAll('img')) {
    const all = [...new Set([...attrNames(img), ...images.flatMap(attrNames)])];
    let i = images.findIndex(same(img, all));
    if (i < 0) i = images.findIndex(same(img, ['src', 'alt']));
    if (i < 0) i = images.findIndex(same(img, ['src']));
    if (i < 0) continue;
    const [original] = images.splice(i, 1);
    carryOver(original, img);
    if (standsAlone(original)) alone.add(img);
  }
  for (const p of holder.querySelectorAll('p')) {
    const kids = [...p.childNodes].filter(meaningful);
    if (kids.length > 0 && kids.every((k) => alone.has(k)) && !hasAttrs(p)) p.replaceWith(...p.childNodes);
  }
  return [...holder.childNodes];
}

// Whether markdown put the token in a paragraph of its own, maybe beside other stand-ins.
function inOwnParagraph(mark) {
  const p = mark.parentNode;
  if (p?.localName !== 'p' || hasAttrs(p)) return false;
  return [...p.childNodes].filter(meaningful).every((k) => k.nodeType === 1 && (k.localName === STAND_IN || k.localName === 'img'));
}

// Whether the element stood between blocks, outside any paragraph, maybe beside other stand-ins.
const isStandIn = (n) => n.nodeType === 1 && (NONPROSE.has(n.localName) || HIDDEN.has(n.localName));
function standsAlone(el) {
  if (!holdsBlocks(el.parentNode)) return false;
  const siblings = [...el.parentNode.childNodes].filter(meaningful);
  const at = siblings.indexOf(el);
  const next = (step) => {
    let i = at + step;
    while (siblings[i] && isStandIn(siblings[i]) && !isBlock(siblings[i])) i += step;
    return siblings[i];
  };
  return [next(-1), next(1)].every((s) => !s || (s.nodeType === 1 && isBlock(s)));
}

function carryOver(original, img) {
  const said = new Map([...img.attributes].map((a) => [a.name, a.value]));
  const attrs = [];
  for (const a of original.attributes) {
    if (!['src', 'alt', 'title'].includes(a.name)) attrs.push([a.name, a.value]);
    else if (said.has(a.name)) attrs.push([a.name, said.get(a.name)]);
    said.delete(a.name);
  }
  if (said.get('alt') === '') said.delete('alt'); // markdown always writes an alt; the original had none
  attrs.push(...said);
  for (const a of [...img.attributes]) img.removeAttribute(a.name);
  for (const [name, value] of attrs.reverse()) img.setAttribute(name, value); // linkedom puts a new attribute first
}

// ---- Reconcile ----------------------------------------------------------

// Element IDs come back from the prior HTML. Directives, the open box, and the 412 check find
// elements by them. Siblings pair up the way a diff does: first the ones that came back the
// same, then, between those, ones with the same tag. Those are the elements you edited; they
// keep their IDs so their directives stay with them (Jess, 2026-10-12). A pair's children pair
// up the same way. An element with no pair is new, and the formatter gives it an ID.
// Returns the pairs: prior element → its partner.
const HRV = 'data-hrv';

function reconcile(prior, nodes) {
  for (const n of nodes) if (n.nodeType === 1) [n, ...n.querySelectorAll(`[${HRV}]`)].forEach((e) => e.removeAttribute(HRV));
  const partners = new Map();
  pairUp(prior[0].ownerDocument, prior, nodes, partners);
  return partners;
}

// Directives ride with their element: markdown doesn't show them, so each comment in the prior
// scope goes onto its element's partner. One whose element the edit deleted goes with it (Jess,
// 2026-10-12). The scope's own stay; if the scope came back as something else, they go on its
// first element, or where it was.
function carryDirectives(el, nodes, partners) {
  const holder = el.ownerDocument.createElement('div');
  holder.append(...nodes);
  const moving = new Map(); // partner → comments, in order
  for (const comment of allComments(el)) {
    const owner = directiveOwner(comment);
    if (owner !== el && !partners.has(owner)) continue;
    const target = partners.get(owner) ?? holder.firstElementChild ?? holder;
    if (!moving.has(target)) moving.set(target, []);
    moving.get(target).push(comment.cloneNode());
  }
  for (const [target, comments] of moving) attachComments(target, comments);
  return [...holder.childNodes];
}

function pairUp(document, prior, nodes, partners) {
  const before = prior.filter((n) => n.nodeType === 1);
  const after = nodes.filter((n) => n.nodeType === 1);
  const keys = (els) => els.map((e) => canonicalHTML(document, [e]));
  const [beforeKeys, afterKeys] = [keys(before), keys(after)];
  const pairs = new Map(); // after index → before index
  const same = commonSubsequence(beforeKeys, afterKeys);
  let [i, j] = [0, 0];
  for (const [si, sj] of [...same, [before.length, after.length]]) {
    pairGap(before, after, i, si, j, sj, pairs, beforeKeys, afterKeys);
    if (si < before.length) pairs.set(sj, si);
    [i, j] = [si + 1, sj + 1];
  }
  // An element that moved, unchanged, past others.
  const taken = new Set(pairs.values());
  for (const [b, key] of beforeKeys.entries()) {
    if (taken.has(b)) continue;
    const a = afterKeys.findIndex((k, x) => k === key && !pairs.has(x));
    if (a >= 0) pairs.set(a, b);
  }
  // Bare text beside blocks, edited, comes back as a paragraph (C10): what was in it pairs with
  // what is in the paragraph.
  const paired = new Set(pairs.values());
  const bare = before.filter((e, b) => !paired.has(b) && !isBlock(e));
  const wrapped = after.filter((e, a) => !pairs.has(a) && e.localName === 'p' && !hasAttrs(e));
  if (bare.length > 0 && wrapped.length > 0) pairUp(document, bare, wrapped.flatMap((p) => [...p.childNodes]), partners);
  for (const [a, b] of pairs) {
    if (before[b].hasAttribute(HRV)) after[a].setAttribute(HRV, before[b].getAttribute(HRV));
    partners.set(before[b], after[a]);
    pairUp(document, [...before[b].childNodes], [...after[a].childNodes], partners);
  }
}

// Between two unchanged siblings: as many before as after, the same tags in order, is an edit
// of each. Otherwise the most alike pairs first, same tag, in order, so a new item typed beside
// an edited one doesn't take its ID.
function pairGap(before, after, b0, b1, a0, a1, pairs, beforeKeys, afterKeys) {
  if (b1 - b0 === a1 - a0 && after.slice(a0, a1).every((el, k) => el.localName === before[b0 + k].localName)) {
    for (let k = 0; k < a1 - a0; k++) pairs.set(a0 + k, b0 + k);
    return;
  }
  const candidates = [];
  for (let b = b0; b < b1; b++)
    for (let a = a0; a < a1; a++)
      if (before[b].localName === after[a].localName) candidates.push([likeness(beforeKeys[b], afterKeys[a]), b, a]);
  const taken = [];
  for (const [, b, a] of candidates.sort((x, y) => y[0] - x[0])) {
    if (taken.some(([tb, ta]) => tb === b || ta === a || tb < b !== ta < a)) continue;
    taken.push([b, a]);
    pairs.set(a, b);
  }
}

// How alike two elements of one tag are, by their content: of the character pairs in the
// shorter, the share the other holds too. Typing more into an item keeps it alike; its tags,
// the same on both, don't count. Ties go to the closer length (the Dice coefficient). An
// element with no content, like an img, compares its tag.
function likeness(x, y) {
  const inner = (s) => s.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '');
  if (inner(x) && inner(y)) [x, y] = [inner(x), inner(y)];
  const pairsOf = (s) => {
    const counts = new Map();
    for (let i = 0; i < s.length - 1; i++) counts.set(s.slice(i, i + 2), (counts.get(s.slice(i, i + 2)) ?? 0) + 1);
    return counts;
  };
  const [px, py] = [pairsOf(x), pairsOf(y)];
  let shared = 0;
  for (const [p, n] of px) shared += Math.min(n, py.get(p) ?? 0);
  const contained = shared / Math.max(Math.min(x.length, y.length) - 1, 1);
  const dice = (2 * shared) / Math.max(x.length + y.length - 2, 1);
  return contained + dice / 100;
}

// Index pairs of a longest common subsequence, in order. Of the longest, the one whose pairs
// moved least: edit an item into a copy of its neighbor, and each copy still pairs in place.
function commonSubsequence(xs, ys) {
  const worth = xs.length + ys.length + 1; // one more pair outweighs any distance
  const best = Array.from({ length: xs.length + 1 }, () => new Array(ys.length + 1).fill(0));
  for (let i = xs.length - 1; i >= 0; i--)
    for (let j = ys.length - 1; j >= 0; j--) {
      const skip = Math.max(best[i + 1][j], best[i][j + 1]);
      best[i][j] = xs[i] === ys[j] ? Math.max(skip, best[i + 1][j + 1] + worth - Math.abs(i - j)) : skip;
    }
  const out = [];
  for (let i = 0, j = 0; i < xs.length && j < ys.length; ) {
    if (xs[i] === ys[j] && best[i][j] === best[i + 1][j + 1] + worth - Math.abs(i - j)) out.push([i++, j++]);
    else if (best[i + 1][j] >= best[i][j + 1]) i++;
    else j++;
  }
  return out;
}

const shell = (el, nodes) => {
  const copy = el.cloneNode(false);
  copy.append(...nodes);
  return copy;
};

function nodesOf(el, html) {
  const holder = el.ownerDocument.createElement('div');
  holder.innerHTML = html;
  return [...holder.childNodes];
}

// Whether HTML from markdown is the same as the prior nodes, laid out by the formatter, with
// stand-ins restored. Element IDs and directives aside: markdown doesn't carry them.
function sameNodes(prior, html) {
  const document = prior[0].ownerDocument;
  return canonicalHTML(document, prior) === canonicalHTML(document, restore(prior, nodesOf(prior[0], html)));
}

// ids: keep element IDs, to check that they survive a save.
export function canonicalHTML(document, nodes, { ids = false } = {}) {
  const holder = document.createElement('div');
  for (const n of nodes) holder.appendChild(bare(n, ids ? new Set(['data-chunk']) : IGNORED_ATTRS));
  return formatElement(holder);
}

// A copy without directives or the attributes the tool adds.
function bare(node, attrs) {
  const copy = node.cloneNode(true);
  if (copy.nodeType === 1) stripForDisplay(copy, attrs);
  return copy;
}

// The element's HTML as it sits in the file, minus directives and annotation, dedented.
export function rawHTML(el) {
  const copy = el.cloneNode(true);
  stripForDisplay(copy);
  return dedent(copy.outerHTML);
}

function stripForDisplay(el, attrs = IGNORED_ATTRS) {
  for (const n of [...el.childNodes]) {
    if (n.nodeType === 8) n.remove();
    else if (n.nodeType === 1) stripForDisplay(n, attrs);
  }
  if (el.removeAttribute) for (const a of attrs) el.removeAttribute(a);
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
  // Not HTML: a destination in angle brackets, ](<a b.png>), or a code span, `<tag>`.
  if (/<[a-z]/.test(md.replace(/\]\(<[^<>]*>/g, '](').replace(/`[^`\n]*`/g, ''))) notes.push('HTML');
  if (/(^|[^\\])⟦/.test(md)) notes.push('⟦tokens⟧');
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

// ======================================================================
// Tier III: interface
// ======================================================================

// CommonMark with GFM tables. Raw HTML passes through, for what markdown can't say; a newline
// is a <br> (A4). No linkify or typographer: what you type is what the file gets.
const markdownIt = new MarkdownIt({ html: true, breaks: true });
// Links go to the file as written: no percent-encoding, no refusing a scheme. The pages are Jess's.
markdownIt.validateLink = () => true;
markdownIt.normalizeLink = (url) => url;
markdownIt.normalizeLinkText = (text) => text;
// A <br> with no newline after it, as the formatter lays it out.
markdownIt.renderer.rules.softbreak = () => '<br>';
markdownIt.renderer.rules.hardbreak = () => '<br>';
// A code block's text without the newline markdown-it adds, so the writer can say whether
// the pre ended with one.
const { escapeHtml, unescapeAll } = markdownIt.utils;
const codeBlockHTML = (text, language) =>
  `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(text.replace(/\n$/, ''))}</code></pre>\n`;
markdownIt.renderer.rules.fence = (tokens, i) => {
  const { content, info, markup } = tokens[i];
  if (markup.startsWith('~')) return `<pre>${escapeHtml(content.replace(/\n$/, ''))}</pre>\n`; // a bare pre
  return codeBlockHTML(content, unescapeAll(info).trim().split(/\s+/)[0]);
};
markdownIt.renderer.rules.code_block = (tokens, i) => codeBlockHTML(tokens[i].content, '');
// A stand-in, ⟦svg⟧, renders as a mark that restore swaps for the element; \⟦ is a plain ⟦.
// markdown-it's text rule runs up to the next character some rule might start on, so it is
// replaced with one that stops at ⟦ too.
const STAND_IN = 'hrv-stand-in';
const STOPS = new Set('\n!#$%&*+-:<=@[\\]^_`{}~⟦');
markdownIt.inline.ruler.at('text', (state, silent) => {
  let pos = state.pos;
  while (pos < state.posMax && !STOPS.has(state.src[pos])) pos++;
  if (pos === state.pos) return false;
  if (!silent) state.pending += state.src.slice(state.pos, pos);
  state.pos = pos;
  return true;
});
markdownIt.inline.ruler.after('text', 'stand_in', (state, silent) => {
  const rest = state.src.slice(state.pos, state.posMax);
  const escaped = rest.startsWith('\\⟦');
  const token = !escaped && rest.match(/^⟦([a-z][a-z0-9-]*)⟧/);
  if (!escaped && !rest.startsWith('⟦')) return false;
  if (!silent && token) state.push('stand_in', '', 0).meta = token[1];
  else if (!silent) state.pending += '⟦';
  state.pos += token ? token[0].length : escaped ? 2 : 1;
  return true;
});
markdownIt.renderer.rules.stand_in = (tokens, i) => `<${STAND_IN} name="${tokens[i].meta}"></${STAND_IN}>`;
// Markdown leaves an HTML block alone, so a stand-in there is swapped in the block's text. It
// sits where the HTML puts it, so it takes the next of its kind (see restore).
markdownIt.renderer.rules.html_block = (tokens, i) =>
  tokens[i].content.replace(/⟦([a-z][a-z0-9-]*)⟧/g, `<${STAND_IN} name="$1" in-html></${STAND_IN}>`);
const render = (markdown) => markdownIt.render(markdown);
const renderInline = (markdown) => markdownIt.renderInline(markdown);
