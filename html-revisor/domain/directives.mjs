// Directives: requests about one element, in the file as <!-- author: text -->. Where one sits
// says which element it is about. Tier II, pure functions over a DOM; the served page and a
// markdown save (carryDirectives) both use the placement rule.
import { VOID, RAW, trimAscii } from './canonical.mjs';
import { ID } from './identity.mjs';

// Directives go before these elements; for everything else a directive is the first child.
// Elements whose content is parsed as plain text (title, iframe, ...) cannot hold a comment.
export const TEXT_ONLY = 'title iframe xmp noembed noframes'.split(' ');
const directiveGoesBefore = (el) => VOID.has(el.localName) || RAW.has(el.localName) || TEXT_ONLY.includes(el.localName);

// A directive is an HTML comment inside an element whose text starts with "<author>:".
// Comments outside any element (before <html>) are never directives.
export function isDirective(node, author) {
  return (
    node.nodeType === 8 &&
    node.parentNode?.nodeType === 1 &&
    node.data.trimStart().startsWith(`${author}:`)
  );
}

export function directiveText(comment, author) {
  return comment.data.trimStart().slice(author.length + 1).trim();
}

// Escape so the text cannot end the comment early. Repeat for runs like "---". Only "-->" and
// "--!>" end a comment, so with no "--" left a ">" is safe and stays as typed; the "author: "
// before and the space after keep the text off the comment's edges, where ">" and "<!-" can't go.
export function escapeDirectiveText(text) {
  let out = text;
  while (out.includes('--')) out = out.replaceAll('--', '- -');
  return out;
}

export function allComments(node, found = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === 8) found.push(child);
    else if (child.nodeType === 1) allComments(child, found);
  }
  return found;
}

// The reading rule: a directive belongs to its parent, unless the next element (skipping
// whitespace-only text and comments) is a void or preformatted element; then it belongs to that
// sibling. So a run of turns before an <img> is the img's thread. A parent whose first child is
// such an element keeps its thread as its last child instead (attachComments).
export function directiveOwner(comment) {
  const next = nextContent(comment.nextSibling);
  return next?.nodeType === 1 && directiveGoesBefore(next) ? next : comment.parentNode;
}

// The node, or the first after it that isn't whitespace-only text or a comment.
function nextContent(node) {
  while (node?.nodeType === 8 || (node?.nodeType === 3 && trimAscii(node.data) === '')) node = node.nextSibling;
  return node;
}

// { [element ID]: directive text }: each element's open turn, the directives after its last
// reply. Several join with newlines; an element whose thread ends in a reply has none.
// A directive on an element with no ID stays in the file, unseen.
export function collectDirectives(document, author) {
  const directives = {};
  for (const [id, thread] of Object.entries(threadsById(document, author))) {
    const open = thread.slice(lastReply(thread) + 1).map((t) => t.text);
    if (open.length) directives[id] = open.join('\n');
  }
  return directives;
}

// A reply is the agent's turn, in the file as <!-- @Human: text -->: the prefix names who the
// words are for. An element's thread is its directives and replies, in file order
// (REPLY-DESIGN.html).
export const REPLY = '@Human';
export const isTurn = (node, author) => isDirective(node, author) || isDirective(node, REPLY);

// [{ prefix, text }], in order: the author's turns and the replies on this element.
export function threadOf(el, author) {
  return turnsOn(el, author).map((c) => turnOf(c, author));
}

// How many times the agent has replied on this element: what a directive save checks, so a
// turn typed before a reply came in isn't written after it.
export const replyCount = (el, author) => threadOf(el, author).filter((t) => t.prefix === REPLY).length;

function turnOf(comment, author) {
  const prefix = isDirective(comment, author) ? author : REPLY;
  return { prefix, text: directiveText(comment, prefix) };
}

// { [element ID]: [{ prefix, text }] }: the settled part of each thread that has a reply, its
// turns through the last reply. The turn after that is the element's directive.
export function threadsOf(document, author) {
  const threads = {};
  for (const [id, thread] of Object.entries(threadsById(document, author))) {
    const settled = thread.slice(0, lastReply(thread) + 1);
    if (settled.length) threads[id] = settled;
  }
  return threads;
}

// Every element's thread, by ID, in one pass over the comments.
function threadsById(document, author) {
  const threads = {};
  for (const comment of allComments(document)) {
    if (!isTurn(comment, author)) continue;
    const id = directiveOwner(comment).getAttribute?.(ID);
    if (id == null) continue;
    (threads[id] ??= []).push(turnOf(comment, author));
  }
  return threads;
}

const lastReply = (thread) => thread.findLastIndex((t) => t.prefix === REPLY);

// Takes out every thread: the directives and the replies.
export function removeThreads(document, author) {
  for (const comment of allComments(document)) {
    if (isTurn(comment, author)) comment.remove();
  }
}

// Resolve: takes out the element's thread, directives and replies.
export function removeThread(el, author) {
  for (const comment of turnsOn(el, author)) comment.remove();
}

const turnsOn = (el, author) => allComments(el.ownerDocument).filter((c) => isTurn(c, author) && directiveOwner(c) === el);

// A reply goes after the last turn in the element's thread, or where a directive would go.
export function placeReply(el, text, author) {
  const reply = el.ownerDocument.createComment(` ${REPLY}: ${escapeDirectiveText(text.trim())} `);
  const last = turnsOn(el, author).at(-1);
  if (last) last.after(reply);
  else attachComments(el, [reply]);
}

// Replace the element's open turn, the directives after its last reply, with this one; empty
// text leaves it none. The turns before stay as written, and other elements' directives stay
// where they are.
export function setDirective(el, text, author) {
  const turns = turnsOn(el, author);
  const reply = turns.findLast((c) => isDirective(c, REPLY));
  for (const comment of turns.slice(turns.indexOf(reply) + 1)) comment.remove();
  if (!text.trim()) return;
  if (reply) reply.after(el.ownerDocument.createComment(` ${author}: ${escapeDirectiveText(text.trim())} `));
  else placeDirective(el, text, author);
}

export function placeDirective(el, text, author) {
  attachComments(el, [el.ownerDocument.createComment(` ${author}: ${escapeDirectiveText(text.trim())} `)]);
}

// Put comments on an element, in order, where the reading rule finds them: first children, or
// just before an element that can't hold one. When the first child is such an element, they'd
// read as its, so they go last.
export function attachComments(el, comments) {
  const before = directiveGoesBefore(el) && el.parentNode;
  const first = !before && nextContent(el.firstChild);
  const last = first?.nodeType === 1 && directiveGoesBefore(first);
  const [parent, next] = before ? [el.parentNode, el] : [el, last ? null : el.firstChild];
  for (const comment of comments) parent.insertBefore(comment, next);
}

// Directives ride with their element through a rewrite: markdown doesn't show them, so each
// comment in the prior scope goes onto its element's partner (reconcile in identity.mjs pairs
// them). One whose element the edit deleted goes with it (Jess,
// 2026-10-12). The scope's own stay; if the scope came back as something else, they go on its
// first element, or where it was.
export function carryDirectives(el, nodes, partners) {
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
