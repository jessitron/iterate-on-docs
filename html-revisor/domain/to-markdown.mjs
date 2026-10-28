// To markdown: a scope's content as the markdown you would edit. Tier II, pure functions over a
// DOM. from-markdown.mjs reads it back. Both are the markdown language alone: element IDs and
// directives ride across a save in identity.mjs (reconcile) and directives.mjs
// (carryDirectives), which scopeFromMarkdown in markdown-edits.mjs puts together
// (SCOPES-DESIGN.html#identity). test/scopes.test.mjs, test/roundtrip-*.test.mjs.
//
// Unlikely shapes (empty paragraphs, dl, stat tiles) may come out ugly here. Spend the effort
// on the shapes agents write (Jess, 2026-10-12). They still have to round-trip, so each piece
// is checked against the parser: a block, or a run of phrasing, that markdown-it wouldn't read
// back the same is written as HTML instead. The rules make the markdown readable; the check
// keeps it true.
import { trimAscii, formatElement, VOID, attrNames, hasAttrs, bare, collapse } from './canonical.mjs';
import { HIDDEN, NONPROSE, INLINE_SCOPES, MARKDOWN_ITSELF, isBlock, holdsBlocks, meaningful } from './scopes.mjs';
import { roundTrips, sameNodes, render, renderInline, STAND_IN, fenceable, indent, openTag } from './from-markdown.mjs';

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
const allBlocks = (li) => [...li.childNodes].filter(meaningful).every((n) => n.nodeType === 1 && isBlock(n));
const blockCount = (li) => [...li.childNodes].filter(meaningful).length;

const quote = (text) => text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

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

// Phrasing content in markdown. Markdown syntax only for elements with no attributes, and for
// links and images (a: href and title; img: src and alt; the rest come back from the original,
// B2, D2); the rest
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
  if (name === 'a' && !asHTML && n.hasAttribute('href')) {
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

// Characters markdown would read as syntax, and ⟦, which starts a stand-in. U+00A0 stays a
// plain character (A5).
function escapeMarkdown(text) {
  return escapeEntities(text.replace(/[\\`*_[\]~⟦]/g, '\\$&')).replace(/</g, '&lt;');
}
const escapeEntities = (text) => text.replace(/&(?=[a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');
