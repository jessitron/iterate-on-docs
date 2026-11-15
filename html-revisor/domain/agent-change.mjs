// The agent's change: new content for one scope, or a scope added, removed, or moved, handed to
// the server instead of written into the file. Tier II, pure functions over a file's text.
// Orchestration reads the file, writes what comes back, and answers; server.mjs names the bodies.
//
// A scope's version is what the code calls its base (bases.mjs): the hash of its content, which
// directives, replies, and IDs leave alone. The agent hands it back unread. Your words never
// drop: each thread rides with its element by ID, and one whose element the change took out
// moves up to the nearest element that holds it now.
import { parse, serialize, canonicalize, formatElement, VOID, RAW } from './canonical.mjs';
import { ID, elementById, assignIds, reconcile } from './identity.mjs';
import { allComments, isTurn, REPLY, removeThreads, pinTurns, repinTurns } from './directives.mjs';
import { meaningful } from './scopes.mjs';
import { baseOf } from './bases.mjs';
import { readRevision } from './revision.mjs';

// The step port: step(name, fn) runs fn and returns what it returns, handing fn a
// note(attributes) for what the step found out; left out, the steps just run.
const justRun = (name, fn) => fn(() => {});

export const KINDS = ['replace', 'add', 'remove', 'move'];
export const WHERE = ['after', 'before', 'into'];

const conflict = (why, error, log, now = {}) => ({ conflict: { why, error, log, now } });
const refused = (why) => ({ refused: why });
const idOf = (el) => el.getAttribute(ID);

// The scope as the file holds it, IDs in and threads out, and its version.
function scopeNow(el, author) {
  const copy = el.cloneNode(true);
  removeThreads(copy, author);
  return { id: idOf(el), version: baseOf(el, author), html: formatElement(copy) };
}

// read: {id, version, html}, or null when no element has that ID.
export function readScope(text, id, author, step = justRun) {
  const el = elementById(readRevision(text, step), id);
  return el ? scopeNow(el, author) : null;
}

const gone = (id) => conflict('no such element', `element ${id} is gone from the page`, `agent change on element ${id}, which is gone`, { id });

// The scope named, unless it's gone or moved past the version the agent started from.
function current(document, id, version, author) {
  const el = elementById(document, id);
  if (!el) return gone(id);
  if (baseOf(el, author) !== version) {
    return conflict('changed since', 'that scope changed since your version: redo your change on what it holds now', `agent change on element ${id}, which changed since`, scopeNow(el, author));
  }
  return { el };
}

// change: {change: "replace", id, version, html} | {change: "add", where, id, html}
//       | {change: "remove", id, version} | {change: "move", id, where, to}
// Gives one of:
//   {conflict}: the page moved under the agent; now holds what the scope holds, to redo it on
//   {refused}: why the change can't be made at all
//   {written, answer}: the text to write, and {ok, id, version, ids}: the scope the answer is
//   about, its version now, and the IDs the server gave new elements
export function reviseByAgent(text, change, author, step = justRun) {
  const document = readRevision(text, step);
  const before = new Set([...document.querySelectorAll(`[${ID}]`)].map(idOf));
  const made = step(change.change, () => CHANGES[change.change](document, change, author));
  if (made.conflict || made.refused) return made;
  assignIds(document);
  const wrong = misplaced(made.touched);
  if (wrong) return refused(wrong);
  const written = step('serialize', () => serialize(document));
  // What the parser would put somewhere else, such as a div inside a p, doesn't hold.
  const again = step('reparse', () => {
    const doc = parse(written);
    assignIds(doc);
    return doc;
  });
  if (serialize(again) !== written) return refused('the page would not read back as written: the HTML has to nest as HTML allows');
  const holder = elementById(again, idOf(holderOf(made.holder)));
  const ids = [...again.querySelectorAll(`[${ID}]`)].map(idOf).filter((id) => !before.has(id));
  return { written, answer: { ok: true, id: idOf(holder), version: baseOf(holder, author), ids } };
}

// ---- The four changes ---------------------------------------------------
// Each gives {conflict}, {refused}, or {holder, touched}: the element the answer is about (or
// the one in it, when it has no ID of its own yet), and the elements whose place in the page the
// structure check reads.

const CHANGES = { replace, add, remove, move };

const isBody = (el) => el.localName === 'body';
const holdsNothing = (el) => VOID.has(el.localName) || RAW.has(el.localName);

// New content for the scope: one root element, which keeps the scope's ID whatever it says.
// Inside it, an ID the agent kept from the scope stays on the element it's on; any other ID (one
// from elsewhere in the page, made up, or written twice) comes off, and the element is new.
// Elements the agent left without their ID take it back where they pair with the scope's own
// (reconcile, as a markdown save does).
function replace(document, { id, version, html }, author) {
  const found = current(document, id, version, author);
  if (!found.el) return found;
  const old = found.el;
  if (isBody(old)) return refused('body can\'t be replaced: replace what is in it');
  const nodes = fragmentOf(document, old.parentNode, html, author);
  if (nodes.refused) return nodes;
  const roots = nodes.filter(meaningful);
  if (roots.length !== 1 || roots[0].nodeType !== 1) return refused('replace takes one root element: the scope\'s new content');
  const root = roots[0];
  const inside = new Set([...old.querySelectorAll(`[${ID}]`)].map(idOf));
  const stated = statedIds(root, inside);
  reconcile([old], [root]);
  const claimed = new Set([id, ...stated.values()]);
  for (const e of [...root.querySelectorAll(`[${ID}]`)]) if (!stated.has(e) && claimed.has(idOf(e))) e.removeAttribute(ID);
  for (const [e, kept] of stated) e.setAttribute(ID, kept);
  root.setAttribute(ID, id);
  const byId = new Map([root, ...root.querySelectorAll(`[${ID}]`)].map((e) => [idOf(e), e]));
  const pins = pinTurns(document, author);
  old.replaceWith(root);
  repinTurns(pins, (owner) => byId.get(idOf(owner)) ?? root, author);
  return { holder: root, touched: [root.parentElement, root, ...root.querySelectorAll('*')] };
}

// The IDs the agent kept: each element in root whose ID was inside the scope and is written once.
function statedIds(root, inside) {
  const els = [...root.querySelectorAll(`[${ID}]`)];
  const count = new Map();
  for (const e of els) count.set(idOf(e), (count.get(idOf(e)) ?? 0) + 1);
  return new Map(els.filter((e) => inside.has(idOf(e)) && count.get(idOf(e)) === 1).map((e) => [e, idOf(e)]));
}

// New content beside a scope or at the end of one. All of it is new: any ID in it comes off.
function add(document, { where, id, html }, author) {
  const anchor = elementById(document, id);
  if (!anchor) return gone(id);
  const into = where === 'into';
  if (!into && isBody(anchor)) return refused(`body has no ${where}: add into it`);
  if (into && holdsNothing(anchor)) return refused(`a <${anchor.localName}> holds no elements: add after or before it`);
  const parent = into ? anchor : anchor.parentNode;
  const nodes = fragmentOf(document, parent, html, author);
  if (nodes.refused) return nodes;
  if (!nodes.some(meaningful)) return refused('the HTML holds nothing to add');
  for (const n of nodes) if (n.nodeType === 1) [n, ...n.querySelectorAll(`[${ID}]`)].forEach((e) => e.removeAttribute(ID));
  const pins = pinTurns(document, author);
  place(anchor, where, nodes);
  repinTurns(pins, () => parent, author);
  const els = nodes.filter((n) => n.nodeType === 1);
  return { holder: els[0] ?? parent, touched: [parent, ...els.flatMap((e) => [e, ...e.querySelectorAll('*')])] };
}

// The scope and all in it go. The threads on it and in it move to the element that held it.
function remove(document, { id, version }, author) {
  const found = current(document, id, version, author);
  if (!found.el) return found;
  const el = found.el;
  if (isBody(el)) return refused('body can\'t be removed');
  const holder = holderOf(el.parentNode);
  const pins = pinTurns(document, author);
  el.remove();
  repinTurns(pins, () => holder, author);
  return { holder, touched: [] };
}

// The scope, with its content, IDs, and threads, goes after, before, or into another.
function move(document, { id, where, to }, author) {
  const el = elementById(document, id);
  if (!el) return gone(id);
  const anchor = elementById(document, to);
  if (!anchor) return gone(to);
  if (isBody(el)) return refused('body can\'t move');
  if (where !== 'into' && isBody(anchor)) return refused(`body has no ${where}: move into it`);
  if (el === anchor || el.contains(anchor)) return refused('a scope can\'t move inside itself');
  if (where === 'into' && holdsNothing(anchor)) return refused(`a <${anchor.localName}> holds no elements: move after or before it`);
  const pins = pinTurns(document, author);
  place(anchor, where, [el]);
  repinTurns(pins, () => el, author);
  return { holder: el, touched: [el.parentElement, el] };
}

function place(anchor, where, nodes) {
  if (where === 'after') anchor.after(...nodes);
  else if (where === 'before') anchor.before(...nodes);
  else anchor.append(...nodes);
}

// The nearest element at or around el with an ID: the one a thread can sit on. A table row has
// an ID and is no scope, so a thread passes it by for the table.
function holderOf(el) {
  return el.closest(`[${ID}]:not(tr)`);
}

// ---- The agent's HTML ---------------------------------------------------

// The agent's HTML as nodes of the page's document, parsed where they'll go: inside an svg, as
// svg. Canonical forms as the formatter writes them (b → strong). Threads come out: a directive
// or reply in the agent's HTML isn't yours, and replies go through reply.mjs.
function fragmentOf(document, parent, html, author) {
  if (/<\/?(html|head|body)[\s>/]/i.test(html)) return refused('the HTML is a scope\'s content: no html, head, or body');
  const holder = document.createElement('div');
  const svg = !!parent.closest?.('svg') && !parent.closest('foreignObject, foreignobject');
  holder.innerHTML = svg ? `<svg>${html}</svg>` : html;
  const from = svg ? holder.firstElementChild : holder;
  canonicalize(from);
  for (const c of allComments(from)) if (isTurn(c, author) || isTurn(c, REPLY)) c.remove();
  if (!from.childNodes.length || ![...from.childNodes].some(meaningful)) return refused('the HTML holds nothing');
  return [...from.childNodes];
}

// ---- Structure ----------------------------------------------------------
// What HTML puts only in certain parents, and what certain parents hold. The formatter's parser
// keeps a <tr> after a <p>, where a browser drops it, so this says no first.

const PARENTS = {
  li: ['ul', 'ol', 'menu'], dt: ['dl', 'div'], dd: ['dl', 'div'],
  tr: ['table', 'thead', 'tbody', 'tfoot'], td: ['tr'], th: ['tr'],
  thead: ['table'], tbody: ['table'], tfoot: ['table'], caption: ['table'], colgroup: ['table'], col: ['colgroup'],
};
const SCRIPTING = ['script', 'template'];
const CHILDREN = {
  ul: ['li'], ol: ['li'], menu: ['li'], dl: ['dt', 'dd', 'div'], tr: ['td', 'th'],
  thead: ['tr'], tbody: ['tr'], tfoot: ['tr'], table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot'],
};

// Why one of these elements sits where HTML doesn't let it, or null.
function misplaced(elements) {
  for (const el of elements) {
    if (!el) continue;
    const parent = el.parentElement;
    const allowed = PARENTS[el.localName];
    if (allowed && parent && !allowed.includes(parent.localName)) return `a <${el.localName}> can't sit in a <${parent.localName}>`;
    const holds = CHILDREN[el.localName];
    if (!holds) continue;
    for (const c of el.childNodes) {
      if (c.nodeType === 3 && meaningful(c)) return `a <${el.localName}> can't hold text outside its ${holds.map((h) => `<${h}>`).join(' or ')}`;
      if (c.nodeType === 1 && !holds.includes(c.localName) && !SCRIPTING.includes(c.localName)) return `a <${c.localName}> can't sit in a <${el.localName}>`;
    }
  }
  return null;
}
