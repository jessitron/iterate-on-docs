// Scopes: what you can pick in a page. Tier II, pure functions over a DOM: the kinds of
// element, which elements are scopes, and which scopes are small enough to edit as markdown.
//
// A scope is any block element, plus links, images, and spans. You pick it to leave a directive or to
// edit its whole content as markdown: a section, a list, one list item, a table, one cell (Jess,
// 2026-10-12, F2 in SCOPES-DESIGN.html#scopes). Other inline elements, like strong, belong to their
// block. to-markdown.mjs writes a scope as markdown and from-markdown.mjs reads it back;
// scope-report.mjs shows both for each scope. test/scopes.test.mjs.
import { trimAscii, IGNORED_ATTRS } from './canonical.mjs';

// ---- Kinds of element ---------------------------------------------------

// Not shown, so never a scope. In markdown it is a token like ⟦svg⟧, so saving keeps it.
export const HIDDEN = new Set('head script style template title meta link noscript'.split(' '));

// Shown, but not text. Inside prose it is a token: ⟦svg⟧.
export const NONPROSE = new Set(
  'svg img picture video audio canvas iframe embed object math input button select textarea meter progress hr'.split(' '),
);

// Flow content. Everything else is phrasing. svg and img are not here: inside a sentence they are tokens.
const BLOCK = new Set(
  `address article aside blockquote body details dialog div dl dd dt fieldset figcaption figure
   footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main menu nav ol p pre section summary
   table caption colgroup thead tbody tfoot tr th td ul`.split(/\s+/),
);

// Block by name, or because it holds a block (E3: a link wrapping a card).
export function holdsBlocks(el) {
  return [...el.children].some((c) => BLOCK.has(c.localName) || (!NONPROSE.has(c.localName) && holdsBlocks(c)));
}
export const isBlock = (el) => BLOCK.has(el.localName) || holdsBlocks(el);

// Inline elements whose markdown is the element itself: [text](href), ![alt](src).
export const INLINE_SCOPES = new Set(['a', 'img']);

// Elements whose markdown is the syntax itself: a list's content is its - lines.
export const MARKDOWN_ITSELF = new Set(['ul', 'ol', 'table']);

export const meaningful = (n) => n.nodeType === 1 || (n.nodeType === 3 && trimAscii(n.data) !== '');

// ---- Scopes -------------------------------------------------------------

// Every block element is a scope; so are links, images, spans, and svg <text> labels (D6).
const TABLE_ROWS = new Set(['thead', 'tbody', 'tfoot', 'tr']);
// Inline elements you can pick, decided per element (Jess, 2026-10-12). strong: no. span: yes,
// and it edits its content, like a block (Jess, 2026-10-13). Not inside a pre: those spans are
// highlighting, and the pre is the scope. Not a span that fills its parent: every click would
// land on it, and the parent, a link or a paragraph, could not be picked.
const PICKABLE_INLINE = new Set([...INLINE_SCOPES, 'span']);
const pickableInline = (el) =>
  PICKABLE_INLINE.has(el.localName) &&
  !isBlock(el) &&
  (el.localName !== 'span' || (!el.closest('pre') && [...el.parentNode.childNodes].filter(meaningful).length > 1));

// The elements of the scopes nested in el, nearest first. The rule behind scopesWithin
// (scope-report.mjs) and scopeElements.
export function pickable(el) {
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

