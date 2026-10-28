// Bases: the fingerprint of an element's content that a change has to start from. Tier II, pure
// functions over a DOM.
import crypto from 'node:crypto';
import { formatElement } from './canonical.mjs';
import { ID } from './identity.mjs';
import { removeThreads, threadOf } from './directives.mjs';

// A short fingerprint. Of the file bytes, it lets the tab notice that the page changed on disk.
export const fingerprint = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);

// The element, its content, and its own attributes, minus threads and IDs, in canonical
// layout. Directives, replies, and IDs coming and going change no base; a changed child changes
// its parent's.
export function baseOf(el, author) {
  const copy = el.cloneNode(true);
  removeThreads(copy, author);
  copy.removeAttribute(ID);
  copy.querySelectorAll(`[${ID}]`).forEach((e) => e.removeAttribute(ID));
  return fingerprint(formatElement(copy));
}

// The base a reply starts from: the element's thread, every turn and who it's for. A turn added,
// changed, or resolved away changes it; an edit to the element's content doesn't.
export const threadBaseOf = (el, author) => fingerprint(JSON.stringify(threadOf(el, author)));

export function basesOf(elements, author) {
  return Object.fromEntries([...elements].map((el) => [el.getAttribute(ID), baseOf(el, author)]));
}

// The elements whose base an edit to these can change: each one, the IDs inside it, and its
// ancestors.
export function around(els) {
  const out = new Set();
  for (const el of els) {
    el.querySelectorAll(`[${ID}]`).forEach((e) => out.add(e));
    for (let a = el; a?.nodeType === 1; a = a.parentNode) if (a.hasAttribute(ID)) out.add(a);
  }
  return [...out];
}
