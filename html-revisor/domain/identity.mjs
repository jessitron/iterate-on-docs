// Element identity: the IDs the file carries, which elements get one, and how they last
// through a rewrite. Tier II, pure functions over a DOM. The attribute names live in
// id-attribute.mjs, below canonical.mjs, which needs them too; this module passes them on.
import { ID, NEXT_ID } from './id-attribute.mjs';
import { canonicalHTML, hasAttrs } from './canonical.mjs';
import { scopeElements, isBlock } from './scopes.mjs';
import { likeness } from './likeness.mjs';

export { ID, NEXT_ID };
const ID_VALUE = /^(0|[1-9]\d*)$/;

export function elementById(document, id) {
  return /^\d+$/.test(id) ? document.querySelector(`[${ID}="${id}"]`) : null;
}

// ---- Assigning IDs ------------------------------------------------------

// Every scope gets an ID. So do hr and every element of an svg, which took directives before
// scopes did; commenting inside an SVG stays as it is (Jess, 2026-10-12).
function identifiable(document) {
  const wanted = new Set(scopeElements(document));
  for (const el of document.querySelectorAll('body hr, body svg, body svg *')) wanted.add(el);
  return wanted;
}

export function assignIds(document) {
  assignIdsTo(document, identifiable(document));
}

// Existing IDs never change. A new element gets the next number. Copies of one ID (an agent's
// copy-paste) retire it: every copy gets a fresh one. An ID on an element that isn't wanted,
// or one that isn't a number, comes off.
function assignIdsTo(document, wanted) {
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

// ---- Reconcile ----------------------------------------------------------

// When a rewrite replaces an element, element IDs come back from the prior HTML. Directives,
// the open box, and the 412 check find elements by them. Siblings pair up the way a diff does:
// first the ones that came back the same, then, between those, ones with the same tag. Those
// are the elements you edited; they keep their IDs so their directives stay with them (Jess,
// 2026-10-12). A pair's children pair up the same way. An element with no pair is new, and
// assignIds gives it one. Returns the pairs: prior element → its partner.
export function reconcile(prior, nodes) {
  for (const n of nodes) if (n.nodeType === 1) [n, ...n.querySelectorAll(`[${ID}]`)].forEach((e) => e.removeAttribute(ID));
  const partners = new Map();
  pairUp(prior[0].ownerDocument, prior, nodes, partners);
  return partners;
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
    if (before[b].hasAttribute(ID)) after[a].setAttribute(ID, before[b].getAttribute(ID));
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

