// html-revisor formatter: parse an HTML document and write it back in canonical form.
//
//   node formatter.mjs <file>...   rewrites each file in place; prints nothing on success.
//   Exit 0 when every file ends canonical, 1 when a file can't be read or written or
//   breaks a rule the formatter can't fix, 2 for a usage error.
//
// Tiers, dependencies point downward only:
//   Tier I   orchestration: the CLI
//   Tier II  domain: parse, skeleton, canonical forms, element IDs, layout, serialize, validation
//            (pure functions)
//   Tier III interface: the filesystem, through fs in the CLI
// server.mjs imports Tier II from here.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseHTML } from './vendor/linkedom.mjs';
// scopes.mjs imports parse and serialize from here. The cycle is safe: neither module uses
// the other's exports until a function runs.
import { scopeElements } from './scopes.mjs';

// ======================================================================
// Tier I: orchestration
// ======================================================================

// Format each file in place. Returns the exit status; problems go to stderr.
export async function formatFiles(files, { stderr = process.stderr } = {}) {
  if (files.length === 0) {
    stderr.write('usage: node formatter.mjs <file>...\n');
    return 2;
  }
  let status = 0;
  for (const file of files) {
    try {
      const onDisk = await fs.readFile(file, 'utf8');
      const { html, problems } = format(onDisk);
      if (html !== onDisk) await fs.writeFile(file, html);
      for (const problem of problems) stderr.write(`${file}: ${problem}\n`);
      if (problems.length) status = 1;
    } catch (err) {
      stderr.write(`${file}: ${err.message}\n`);
      status = 1;
    }
  }
  return status;
}

// ======================================================================
// Tier II: domain
// ======================================================================

// Canonical form with element IDs, plus the problems normalizing can't fix. The rewrite
// happens either way.
export function format(html) {
  const document = parse(html);
  assignIds(document);
  return { html: serialize(document), problems: validate(document) };
}

// ---- Element identity ---------------------------------------------------

// An element ID lives in the file as data-hrv="<n>". The next unused number sits on
// <html data-hrv-next="<n>">, so an ID is never reused, even after its element is gone.
export const ID = 'data-hrv';
export const NEXT_ID = 'data-hrv-next';
const ID_VALUE = /^(0|[1-9]\d*)$/;

// Every scope gets an ID. So do hr and every element of an svg, which took directives before
// scopes did; commenting inside an SVG stays as it is (Jess, 2026-10-12).
function identifiable(document) {
  const wanted = new Set(scopeElements(document));
  for (const el of document.querySelectorAll('body hr, body svg, body svg *')) wanted.add(el);
  return wanted;
}

// Existing IDs never change. A new element gets the next number. Copies of one ID (an agent's
// copy-paste) retire it: every copy gets a fresh one. An ID on an element that isn't a scope,
// or one that isn't a number, comes off.
export function assignIds(document) {
  const wanted = identifiable(document);
  const html = document.documentElement;
  const stored = html.getAttribute(NEXT_ID);
  let next = ID_VALUE.test(stored ?? '') ? Number(stored) : 1;
  const copies = new Map();
  for (const el of document.querySelectorAll(`[${ID}]`)) {
    const id = el.getAttribute(ID);
    if (ID_VALUE.test(id)) next = Math.max(next, Number(id) + 1);
    if (!wanted.has(el) || !ID_VALUE.test(id)) el.removeAttribute(ID);
    else copies.set(id, (copies.get(id) ?? 0) + 1);
  }
  for (const el of document.querySelectorAll('*')) {
    if (!wanted.has(el)) continue;
    const id = el.getAttribute(ID);
    if (id === null || copies.get(id) > 1) el.setAttribute(ID, String(next++));
  }
  html.setAttribute(NEXT_ID, String(next));
}

// ---- Validation ---------------------------------------------------------

// Each rule takes the parsed document and returns one message per problem it can't fix.
// A problem the formatter can fix belongs in parse or serialize instead. No rules yet.
const RULES = [];

export function validate(document) {
  return RULES.flatMap((rule) => rule(document));
}

// ---- Parse, skeleton, layout, serialize ---------------------------------

export const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
export const RAW = new Set('pre textarea script style template'.split(' ')); // inner content is kept as-is
const BLOCK = new Set(
  `html head body main header footer nav section article aside div p h1 h2 h3 h4 h5 h6
   ul ol li dl dt dd table thead tbody tfoot tr th td blockquote pre figure figcaption hr
   form fieldset details summary meta link script style noscript template iframe video
   audio canvas svg`.split(/\s+/),
);
const ONE_LINE_LIMIT = 90; // inline-only blocks shorter than this stay on one line

export function parse(html) {
  return canonicalize(ensureSkeleton(parseHTML(html).document));
}

// ---- Canonical forms ----------------------------------------------------

// Where HTML has two ways to say one thing, the file uses the one markdown writes back, so a
// scope saved unchanged as markdown comes back the same. Formatting, not
// validation: no agent hears of it. Whitespace beside <br> goes in the layout, below.
export function canonicalize(document) {
  for (const [from, to] of [['b', 'strong'], ['i', 'em']]) {
    for (const el of document.querySelectorAll(from)) rename(el, to);
  }
  for (const table of document.querySelectorAll('table')) sectionRows(table);
  return document;
}

function rename(el, name) {
  const copy = el.ownerDocument.createElement(name);
  for (const a of [...el.attributes].reverse()) copy.setAttribute(a.name, a.value); // linkedom puts a new attribute first
  copy.append(...el.childNodes);
  el.replaceWith(copy);
}

// Rows sitting right in a table go in sections, as markdown's tables have them: a leading
// row of th is the thead, the rest a tbody.
function sectionRows(table) {
  const rows = [...table.children].filter((c) => c.localName === 'tr');
  if (rows.length === 0) return;
  const document = table.ownerDocument;
  const hasHead = [...table.children].some((c) => c.localName === 'thead');
  const [first] = rows;
  if (!hasHead && first === table.firstElementChild && [...first.children].every((c) => c.localName === 'th')) {
    const thead = document.createElement('thead');
    first.replaceWith(thead);
    thead.appendChild(first);
    rows.shift();
  }
  if (rows.length === 0) return;
  const tbody = document.createElement('tbody');
  rows[0].replaceWith(tbody);
  tbody.append(...rows);
}

// Browsers supply a missing <html>, <head> or <body>; linkedom does not. It makes the first
// element the root, and reading document.head/body creates empty ones inside that root.
// So build the skeleton the way a browser does: head content goes in <head> until the first
// other element or non-blank text, and the rest goes in <body>. Only direct children are
// inspected, to avoid the document.head/body getters.
const HEAD_CONTENT = new Set('base link meta noscript script style template title'.split(' '));

export function ensureSkeleton(document) {
  const isEl = (n, name) => n.nodeType === 1 && n.localName === name;
  let html = [...document.childNodes].find((n) => isEl(n, 'html'));
  if (!html) {
    html = document.createElement('html');
    for (const n of [...document.childNodes]) if (n.nodeType !== 10) html.appendChild(n);
    document.appendChild(html);
  }
  let head = [...html.childNodes].find((n) => isEl(n, 'head'));
  let body = [...html.childNodes].find((n) => isEl(n, 'body'));
  const headCreated = !head;
  const bodyCreated = !body;
  head ??= document.createElement('head');
  body ??= document.createElement('body');
  const beforeBody = [];
  let inHead = true;
  let seenBody = false;
  for (const n of [...html.childNodes]) {
    if (n === head) continue;
    if (n === body) { seenBody = true; inHead = false; continue; }
    if (inHead) {
      // Comments and blank text before the content stay put, so a directive on <html> stays there.
      if (n.nodeType === 8 || (n.nodeType === 3 && !n.data.trim())) continue;
      if (n.nodeType === 1 && HEAD_CONTENT.has(n.localName)) { head.appendChild(n); continue; }
      inHead = false;
    }
    if (seenBody || bodyCreated) body.appendChild(n);
    else beforeBody.push(n);
  }
  body.prepend(...beforeBody);
  if (headCreated) html.prepend(head);
  if (bodyCreated) html.appendChild(body);
  return document;
}

export function normalize(html) {
  return format(html).html;
}

// Canonical serialization of a whole document.
export function serialize(document) {
  const doctype = document.doctype?.name || 'html';
  const lines = [`<!DOCTYPE ${doctype}>`, ...formatChildren(document, 0)];
  return lines.join('\n') + '\n';
}

const ASCII_SPACE = '[ \\t\\n\\r\\f]'; // the only whitespace HTML collapses; U+00A0 is not in it
const collapse = (s) => s.replace(new RegExp(`${ASCII_SPACE}+`, 'g'), ' ');
export const trimAscii = (s) => s.replace(new RegExp(`^${ASCII_SPACE}+|${ASCII_SPACE}+$`, 'g'), '');
const pad = (depth) => '  '.repeat(depth);

// Parsers decoded the entities already, so escape on the way out.
export const escapeText = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Child nodes with adjacent text nodes merged into one string (entities split text in linkedom).
// Elements and comments pass through; other node types (doctype) are dropped.
function childrenOf(parent) {
  const items = [];
  for (const node of parent.childNodes) {
    if (node.nodeType === 3) {
      if (typeof items.at(-1) === 'string') items[items.length - 1] += node.data;
      else items.push(node.data);
    } else if (node.nodeType === 1 || node.nodeType === 8) {
      items.push(node);
    }
  }
  return items;
}

// A block element by name, or any element holding a block element.
function isBlockish(el) {
  return BLOCK.has(el.localName) || [...el.childNodes].some((n) => n.nodeType === 1 && isBlockish(n));
}

const isBlockItem = (item) =>
  typeof item !== 'string' && (item.nodeType === 8 || isBlockish(item));

// Lay out the children of a block container: block items on their own lines,
// runs of inline items joined onto one line.
function formatChildren(parent, depth) {
  const lines = [];
  let run = [];
  const flush = () => {
    const text = trimAscii(inlineHTML(run));
    run = [];
    if (text) lines.push(pad(depth) + text);
  };
  for (const item of childrenOf(parent)) {
    if (isBlockItem(item)) {
      flush();
      lines.push(...formatBlock(item, depth));
    } else {
      run.push(item);
    }
  }
  flush();
  return lines;
}

// One element in canonical layout, as if it sat at the top level. The same content always
// lays out the same, wherever it sits and whatever whitespace it came with.
export function formatElement(el) {
  return formatBlock(el, 0).join('\n');
}

function formatBlock(node, depth) {
  if (node.nodeType === 8) return [`${pad(depth)}<!--${node.data}-->`];
  const open = openTag(node);
  if (VOID.has(node.localName)) return [pad(depth) + open];
  const close = `</${node.localName}>`;
  if (RAW.has(node.localName)) return [pad(depth) + open + rawInner(node) + close];

  const kids = childrenOf(node);
  if (kids.some(isBlockItem)) {
    return [pad(depth) + open, ...formatChildren(node, depth + 1), pad(depth) + close];
  }
  const inner = trimAscii(inlineHTML(kids));
  if (!inner || (open + inner + close).length < ONE_LINE_LIMIT) return [pad(depth) + open + inner + close];
  return [pad(depth) + open, pad(depth + 1) + inner, pad(depth) + close];
}

// Inline content: whitespace collapses to single spaces, and a whitespace-only
// string between two inline nodes survives as one space. Whitespace beside a <br> goes:
// a browser doesn't show it, and markdown can't say it.
const isBr = (item) => typeof item === 'object' && item?.localName === 'br';

function inlineHTML(items) {
  return items
    .map((item, i) => {
      if (typeof item === 'string') {
        let text = collapse(item);
        if (isBr(items[i - 1])) text = text.replace(/^ /, '');
        if (isBr(items[i + 1])) text = text.replace(/ $/, '');
        return escapeText(text);
      }
      if (item.nodeType === 8) return `<!--${item.data}-->`;
      const open = openTag(item);
      if (VOID.has(item.localName)) return open;
      const inner = RAW.has(item.localName) ? rawInner(item) : inlineHTML(childrenOf(item));
      return `${open}${inner}</${item.localName}>`;
    })
    .join('');
}

function openTag(el) {
  const attrs = [...el.attributes]
    .map((a) => (a.value === '' ? ` ${a.name}` : ` ${a.name}="${escapeAttr(a.value)}"`))
    .join('');
  return `<${el.localName}${attrs}>`;
}

// pre/textarea/script/style/template: linkedom's own inner serialization, no re-indenting.
// linkedom writes U+00A0 as &#160;; use the named entity instead.
function rawInner(el) {
  return el.innerHTML.replace(/&#160;/g, '&nbsp;');
}

// Run the CLI when this file is the entry point, not when imported. This sits last so
// every constant above is initialized before the CLI runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await formatFiles(process.argv.slice(2));
}
