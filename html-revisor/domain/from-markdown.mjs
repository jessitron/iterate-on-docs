// From markdown: the HTML a scope's markdown saves as. Tier II, pure functions over a DOM, and
// the markdown-it setup they read with. to-markdown.mjs writes the markdown and checks each
// piece against this reader, so the shapes both need (fenceable, openTag) live here. What
// markdown holds as a stand-in, ⟦svg⟧, comes back from the prior HTML, and a link or image
// takes back the attributes markdown can't say. test/scopes.test.mjs, test/roundtrip-*.test.mjs.
import { canonicalHTML, hasAttrs, attrNames, stripForDisplay, collapse } from './canonical.mjs';
import { HIDDEN, NONPROSE, INLINE_SCOPES, MARKDOWN_ITSELF, isBlock, holdsBlocks, meaningful } from './scopes.mjs';
import { likeness } from './likeness.mjs';
import { MarkdownIt } from '../vendor/markdown-it.mjs';

// A stand-in, ⟦svg⟧, renders as this mark, which restore swaps for the element.
export const STAND_IN = 'hrv-stand-in';
// A link or image markdown wrote carries this mark, so restore can tell it from one written
// as HTML, which says all its attributes. restore takes the mark off.
const FROM_MARKDOWN = 'hrv-md';
// Where markdown-it's text rule stops: the characters some rule might start on, and ⟦.
const STOPS = new Set('\n!#$%&*+-:<=@[\\]^_`{}~⟦');

// ---- Shapes both directions share ---------------------------------------

// A pre markdown can fence: bare text, or text in a code element whose only attribute is its
// language. Picked alone, the pre's own attributes are the element's business, and a pre of
// bare text fences too: saving puts the text back where it was.
export function fenceable(pre, alone) {
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

export const indent = (text, n) => text.replace(/\n(?=.)/g, `\n${' '.repeat(n)}`);
export const openTag = (el) => `<${el.localName}${attrNames(el).map((a) => ` ${a}="${escapeAttr(el.getAttribute(a))}"`).join('')}>`;
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// ---- Markdown back to HTML ----------------------------------------------

// The nodes that replace a scope's element when its markdown is saved. The prior element says
// what shape the markdown has, the same way it did for scopeMarkdown: an item's content, a
// list's lines, a paragraph's phrasing. Opening a scope and saving it unchanged gives back
// the same HTML, element IDs and directives aside: reconcile and carryDirectives bring those
// back.
export function nodesFromMarkdown(el, markdown) {
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
  canonicalHTML(el.ownerDocument, [el]) === canonicalHTML(el.ownerDocument, nodesFromMarkdown(el, markdown));

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

// What markdown holds as a stand-in comes back from the prior HTML: ⟦svg⟧ is an svg, ⟦script⟧ a
// script, the one whose surroundings are most like the token's (closest), else the next of its
// kind. An image or a link keeps the attributes markdown can't say (B2, D2; see pairs).
// One that stood between blocks comes out of the paragraph markdown put it in. A token alone in
// its paragraph takes the next one that stood between blocks, and one inside text the next one
// that sat in text, so deleting an inline icon doesn't hand its place to a diagram. A token in an
// HTML block takes the next of its kind, wherever that stood.
function restore(prior, nodes) {
  const tokens = new Map();
  const images = [];
  const links = [];
  const collect = (n) => {
    if (n.nodeType !== 1) return;
    if (n.localName === 'img') images.push(n);
    else if (NONPROSE.has(n.localName) || HIDDEN.has(n.localName)) {
      if (!tokens.has(n.localName)) tokens.set(n.localName, []);
      tokens.get(n.localName).push(n);
    } else {
      if (n.localName === 'a') links.push(n);
      [...n.childNodes].forEach(collect);
    }
  };
  prior.forEach(collect);
  const holder = prior[0].ownerDocument.createElement('div');
  holder.append(...nodes);
  const alone = new Set();
  const nearest = closest(prior);
  // Where each mark sits, before any is swapped: a swapped one is no longer a stand-in beside the next.
  const marks = [...holder.querySelectorAll(STAND_IN)].map((mark) => [mark, inOwnParagraph(mark), surroundings(mark, holder)]);
  for (const [mark, ownParagraph, around] of marks) {
    const name = mark.getAttribute('name');
    const left = tokens.get(name) ?? [];
    const fits = (o) => mark.hasAttribute('in-html') || standsAlone(o) === ownParagraph;
    const fitting = left.some(fits) ? left.filter(fits) : left.slice(0, 1);
    const pick = nearest(around, fitting);
    const [original] = pick ? left.splice(left.indexOf(pick), 1) : [];
    if (!original) {
      mark.replaceWith(`⟦${name}⟧`); // nothing it stood for: the text you typed
      continue;
    }
    const copy = original.cloneNode(true);
    stripForDisplay(copy, []); // its directives come back with the rest
    if (standsAlone(original)) alone.add(copy);
    mark.replaceWith(copy);
  }
  for (const [original, img] of pairs([...holder.querySelectorAll('img')], images, IMAGE_RULES)) {
    carryOver(original, img, IMAGE_SAYS);
    if (standsAlone(original)) alone.add(img);
  }
  for (const [original, a] of pairs([...holder.querySelectorAll('a')], links, LINK_RULES)) carryOver(original, a, LINK_SAYS);
  for (const p of holder.querySelectorAll('p')) {
    const kids = [...p.childNodes].filter(meaningful);
    if (kids.length > 0 && kids.every((k) => alone.has(k)) && !hasAttrs(p)) p.replaceWith(...p.childNodes);
  }
  return [...holder.childNodes];
}

// What a stand-in sits in, nearest first, up to the edge: each element's tag and text, the
// stand-ins' own text aside. A plain element with no text says nothing, so it doesn't count:
// the paragraph markdown puts a lone token in lines up with no level.
function surroundings(node, edge) {
  const out = [];
  for (let el = node.parentNode; el && el !== edge && el.nodeType === 1; el = el.parentNode) {
    const text = collapse(proseText(el)).trim();
    if (text !== '' || hasAttrs(el)) out.push(`${openTag(el)}${text}`);
  }
  return out;
}

function proseText(n) {
  if (n.nodeType === 3) return n.data;
  if (n.nodeType !== 1 || n.localName === STAND_IN || NONPROSE.has(n.localName) || HIDDEN.has(n.localName)) return '';
  return [...n.childNodes].map(proseText).join('');
}

// Of the originals a token could take, the one whose surroundings are most like the token's,
// level by level from the nearest; a tie goes to the first. A block that came back, edited or
// moved, takes its own stand-ins; a token in a new block takes the next one left (SCOPES-DESIGN.html#d8).
function closest(prior) {
  const edge = prior[0].parentNode;
  const known = new Map();
  const around = (o) => known.get(o) ?? known.set(o, surroundings(o, edge)).get(o);
  const score = (x, y) => (x === y ? 2 : x === undefined || y === undefined ? 0 : likeness(x, y));
  return (mine, candidates) => {
    let best = candidates;
    for (let level = 0; best.length > 1 && best.some((o) => around(o).length > level); level++) {
      const scores = best.map((o) => score(mine[level], around(o)[level]));
      const top = Math.max(...scores);
      best = best.filter((o, i) => scores[i] === top);
    }
    return best[0];
  };
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

// Which original each image or link that markdown wrote came from (B2, D2). One written as
// HTML says all its attributes, so it keeps them, and takes the original it copies out of the
// running. The rest pair the closest first, so two images of one picture that swap places keep
// their own sizes. Each rule is a pass over all of them, so a weak match for one can't take
// the strong match of another.
const IMAGE_RULES = [['src', 'alt'], ['src']];
const LINK_RULES = [['href', 'text'], ['href'], ['text']];
function pairs(saved, originals, rules) {
  const left = [...originals];
  const value = (el, name) => (name === 'text' ? collapse(el.textContent).trim() : el.getAttribute(name));
  const same = (el, names) => (o) => names.every((a) => value(o, a) === value(el, a));
  const take = (el, names) => {
    const i = left.findIndex(same(el, names));
    return i < 0 ? null : left.splice(i, 1)[0];
  };
  const fromMarkdown = saved.filter((el) => el.hasAttribute(FROM_MARKDOWN));
  for (const el of fromMarkdown) el.removeAttribute(FROM_MARKDOWN);
  const found = new Map();
  for (const el of saved.filter((s) => !fromMarkdown.includes(s))) {
    const copied = take(el, [...new Set([...attrNames(el), ...left.flatMap(attrNames), 'text'])]);
    if (copied) found.set(el, copied);
  }
  for (const names of rules) {
    for (const el of fromMarkdown) {
      const original = found.has(el) ? null : take(el, names);
      if (original) found.set(el, original);
    }
  }
  return saved.filter((el) => found.has(el)).map((el) => [found.get(el), el]);
}

// What markdown says of each. The original gives back the rest, in its order.
const IMAGE_SAYS = ['src', 'alt', 'title'];
const LINK_SAYS = ['href', 'title'];
function carryOver(original, el, says) {
  const said = new Map([...el.attributes].map((a) => [a.name, a.value]));
  const attrs = [];
  for (const a of original.attributes) {
    if (!says.includes(a.name)) attrs.push([a.name, a.value]);
    else if (said.has(a.name)) attrs.push([a.name, said.get(a.name)]);
    said.delete(a.name);
  }
  if (el.localName === 'img' && said.get('alt') === '') said.delete('alt'); // markdown always writes an alt; the original had none
  attrs.push(...said);
  for (const a of [...el.attributes]) el.removeAttribute(a.name);
  for (const [name, value] of attrs.reverse()) el.setAttribute(name, value); // linkedom puts a new attribute first
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
export function sameNodes(prior, html) {
  const document = prior[0].ownerDocument;
  return canonicalHTML(document, prior) === canonicalHTML(document, restore(prior, nodesOf(prior[0], html)));
}

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
// replaced with one that stops at ⟦ too (STOPS).
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
// A link or image markdown wrote carries the FROM_MARKDOWN mark.
const imageRule = markdownIt.renderer.rules.image;
markdownIt.renderer.rules.image = (tokens, i, ...rest) => {
  tokens[i].attrPush([FROM_MARKDOWN, '']);
  return imageRule(tokens, i, ...rest);
};
markdownIt.renderer.rules.link_open = (tokens, i, options, env, self) => {
  tokens[i].attrPush([FROM_MARKDOWN, '']);
  return self.renderToken(tokens, i, options);
};
export const render = (markdown) => markdownIt.render(markdown);
export const renderInline = (markdown) => markdownIt.renderInline(markdown);
