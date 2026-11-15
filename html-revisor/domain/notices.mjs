// Notices: what changed in a page since you last saw it. Tier II, pure functions over a DOM.
//
// What you have seen is a snapshot, per element ID, of each unit's own content. A unit is an
// element with an ID: a scope, a table row, an hr, an element of an svg, a form field. Its own content is the
// element, its attributes, and what sits in it, with each unit inside it standing as a
// placeholder that names the unit's ID; an element that is no unit (a strong, a code) folds into
// the unit around it. So a change in a paragraph changes the paragraph's own content and not
// its section's, and a section's own content changes when a child goes or the children change
// order. Directives, replies, element IDs, and layout are never content (as in bases.mjs).
//
// A notice is a unit whose own content differs from what you saw ("changed"), or whose ID you
// never saw ("new"). Only the outermost new unit carries one, and a new unit inside a changed
// one carries none: the mark around it covers it. A unit added beside the ones you saw doesn't
// change its parent: the placeholders of children you never saw are left out of the comparison,
// and so is an element that wraps only those, like a thead around a new header row.
// body carries no notice, since no mark can show on it: a change to its own content (a section
// removed or moved at the top level) shows nowhere.
import { formatElement } from './canonical.mjs';
import { ID, elementById } from './identity.mjs';
import { fingerprint } from './bases.mjs';
import { isTurn } from './directives.mjs';

// seen: Map of ID → {own: fingerprint of the unit's own content, children: [IDs of the units in it]}.

// The unit's own content, with a placeholder for each unit in it that keep(id) accepts. Gives
// the fingerprint and the IDs of every unit in it, in order.
export function ownOf(el, author, keep = () => true) {
  const children = [];
  const fill = (copy, from) => {
    for (const n of from.childNodes) {
      if (n.nodeType === 8) {
        if (!isTurn(n, author)) copy.appendChild(n.cloneNode());
      } else if (n.nodeType !== 1) {
        copy.appendChild(n.cloneNode());
      } else if (n.hasAttribute(ID)) {
        const id = n.getAttribute(ID);
        children.push(id);
        if (keep(id)) copy.appendChild(from.ownerDocument.createComment(`hrv-unit ${id}`));
      } else {
        const inner = n.cloneNode(false);
        fill(inner, n);
        if (!wrapsOnlyLeftOut(n, keep)) copy.appendChild(inner);
      }
    }
  };
  const copy = el.cloneNode(false);
  copy.removeAttribute(ID);
  fill(copy, el);
  return { own: fingerprint(formatElement(copy)), children };
}

// An element that is no unit and holds nothing but units keep(id) leaves out, like a new thead
// around a new header row. It goes with them, so a header row added to a table marks the row
// and not the table.
function wrapsOnlyLeftOut(el, keep) {
  const units = unitsIn(el);
  if (!units.length || units.some((u) => keep(u.getAttribute(ID)))) return false;
  const bare = (n) =>
    n.nodeType === 8 ||
    (n.nodeType === 3 && n.data.trim() === '') ||
    (n.nodeType === 1 && (n.hasAttribute(ID) || [...n.childNodes].every(bare)));
  return [...el.childNodes].every(bare);
}

// The units directly in el: elements with an ID whose nearest unit around them is el.
export function unitsIn(el) {
  return [...el.children].flatMap((c) => (c.hasAttribute(ID) ? [c] : unitsIn(c)));
}

const bodyOf = (document) => document.querySelector('body');

// Every unit at and under el, in document order.
function unitsFrom(el) {
  return [el, ...unitsIn(el).flatMap(unitsFrom)];
}

// The page as you see it now: every unit's own content.
export function seenOf(document, author) {
  return record(new Map(), unitsFrom(bodyOf(document)), author);
}

function record(seen, units, author) {
  for (const el of units) seen.set(el.getAttribute(ID), ownOf(el, author));
  return seen;
}

// The notices, in document order: [{id, kind: 'changed' | 'new'}].
export function noticesOf(document, seen, author) {
  const found = [];
  const walk = (el, covered) => {
    const id = el.getAttribute(ID);
    const was = seen.get(id);
    let inside = covered;
    if (!was) {
      if (!covered) found.push({ id, kind: 'new' });
      inside = true;
    } else if (el.localName !== 'body') {
      const known = new Set(was.children);
      if (ownOf(el, author, (child) => known.has(child)).own !== was.own) {
        found.push({ id, kind: 'changed' });
        inside = true;
      }
    }
    for (const unit of unitsIn(el)) walk(unit, inside);
  };
  walk(bodyOf(document), false);
  return found;
}

// The notices, each with what the agent said its change was for. becauses: a Map from a scope's
// ID to the agent's words for its last change there. A notice takes the words of the nearest
// scope at or around it, as `because`. Gives the notices and the words still in use: words no
// notice takes are for a change you've seen.
export function explained(notices, document, becauses) {
  const kept = new Map();
  const told = notices.map((notice) => {
    for (let el = elementById(document, notice.id); el; el = el.parentElement) {
      const id = el.getAttribute(ID);
      if (!becauses.has(id)) continue;
      kept.set(id, becauses.get(id));
      return { ...notice, because: becauses.get(id) };
    }
    return notice;
  });
  return { notices: told, becauses: kept };
}

// Ack: you've seen the unit with this ID and everything in it. An ID not in the page changes
// nothing. "all" sees the whole page.
export function ack(seen, document, id, author) {
  if (id === 'all') return seenOf(document, author);
  const el = elementById(document, id);
  return el ? record(new Map(seen), unitsFrom(el), author) : seen;
}

// Your directive on the unit with this ID: you've seen the mark on it and on each unit around
// it. A mark inside them stays. A new unit a mark covered goes with that mark, so no mark
// appears where none was. An ID not in the page changes nothing.
export function directed(seen, document, id, author) {
  const el = elementById(document, id);
  if (!el) return seen;
  const marked = new Set(noticesOf(document, seen, author).map((n) => n.id));
  const next = new Map(seen);
  const covered = (unit) => [unit, ...unitsIn(unit).filter((u) => !seen.has(u.getAttribute(ID)) && !marked.has(u.getAttribute(ID))).flatMap(covered)];
  for (let unit = el; unit; unit = unit.parentElement?.closest(`[${ID}]`)) {
    if (marked.has(unit.getAttribute(ID))) record(next, covered(unit), author);
  }
  return next;
}

// Your own change, through the tab: the page before it and after. Whatever it made new or
// different, you've seen, and so the unit you edited and everything in it, even over a change
// you hadn't seen: your edit is what it holds now.
export function absorb(seen, before, after, id, author) {
  const was = new Map(unitsFrom(bodyOf(before)).map((el) => [el.getAttribute(ID), ownOf(el, author).own]));
  const next = new Map(seen);
  for (const el of unitsFrom(bodyOf(after))) {
    const now = ownOf(el, author);
    if (was.get(el.getAttribute(ID)) !== now.own) next.set(el.getAttribute(ID), now);
  }
  return ack(next, after, id, author);
}
