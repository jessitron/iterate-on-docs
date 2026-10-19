// Element identity: the IDs the file carries. Tier II, pure functions over a DOM.
//
// An element ID lives in the file as data-hrv="<n>". The next unused number sits on
// <html data-hrv-next="<n>">, so an ID is never reused, even after its element is gone.
export const ID = 'data-hrv';
export const NEXT_ID = 'data-hrv-next';
const ID_VALUE = /^(0|[1-9]\d*)$/;

export function elementById(document, id) {
  return /^\d+$/.test(id) ? document.querySelector(`[${ID}="${id}"]`) : null;
}

// Existing IDs never change. A new element gets the next number. Copies of one ID (an agent's
// copy-paste) retire it: every copy gets a fresh one. An ID on an element that isn't wanted,
// or one that isn't a number, comes off.
export function assignIdsTo(document, wanted) {
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
