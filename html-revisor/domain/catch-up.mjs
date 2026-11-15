// Catching up: what a tab needs to show the page as it is now, given the page it shows. Tier II,
// pure functions over a DOM.
//
// A swap is one unit (notices.mjs: an element with an ID) whose content the tab replaces:
// {id, html}. Swaps are the outermost units that changed, and they don't nest. A unit whose own
// content is the same (its tag, attributes, text, and the IDs of the units in it, in order) isn't
// swapped: only the units in it that changed are. Inside a swap's HTML, each unit the tab
// already has unchanged, wherever it sat, stands as a keep comment, <!--hrv-keep 12-->, and the
// tab puts its own element back there. So an element moved, or one beside the change, stays the
// same element in the tab, and an open box on it stays open.
import { formatElement } from './canonical.mjs';
import { ID, elementById } from './identity.mjs';
import { removeThreads } from './directives.mjs';
import { scopeElements } from './scopes.mjs';
import { around } from './bases.mjs';
import { ownOf, unitsIn } from './notices.mjs';
import { markdownsOf, markdownsNear } from './markdown-edits.mjs';

export const KEEP = 'hrv-keep';
const idOf = (el) => el.getAttribute(ID);
const bodyOf = (document) => document.querySelector('body');

// The unit as the file holds it, IDs in and threads out.
function wholeOf(el, author) {
  const copy = el.cloneNode(true);
  removeThreads(copy, author);
  return formatElement(copy);
}

// before: the page the tab shows, or null when the server doesn't know it, which swaps the whole
// body. after: the page now. Gives {swaps, markdowns}: markdowns for the scopes in and around
// the swaps, as a save's answer carries them.
export function catchUp(before, after, author) {
  if (!before) {
    return { swaps: [{ id: idOf(bodyOf(after)), html: wholeOf(bodyOf(after), author) }], markdowns: markdownsOf(scopeElements(after)) };
  }
  const was = new Map([...before.querySelectorAll(`[${ID}]`)].map((e) => [idOf(e), e]));
  const sameness = new Map();
  // The tab has this unit as it is now: the same ID with the same whole content.
  const same = (el) => {
    if (!sameness.has(el)) {
      const prior = was.get(idOf(el));
      sameness.set(el, !!prior && wholeOf(prior, author) === wholeOf(el, author));
    }
    return sameness.get(el);
  };
  const roots = [];
  const walk = (el) => {
    if (same(el)) return;
    const prior = was.get(idOf(el));
    if (prior && ownOf(prior, author).own === ownOf(el, author).own) unitsIn(el).forEach(walk);
    else roots.push(el);
  };
  walk(bodyOf(after));
  const swaps = roots.map((el) => ({ id: idOf(el), html: withKeeps(el, (id) => same(elementById(after, id)), author) }));
  return { swaps, markdowns: markdownsNear(after, around(roots)) };
}

// The unit's HTML with a keep comment for each unit in it the tab has unchanged.
function withKeeps(el, same, author) {
  const copy = el.cloneNode(true);
  removeThreads(copy, author);
  const keep = (parent) => {
    for (const unit of unitsIn(parent)) {
      if (same(idOf(unit))) unit.replaceWith(el.ownerDocument.createComment(`${KEEP} ${idOf(unit)}`));
      else keep(unit);
    }
  };
  keep(copy);
  return formatElement(copy);
}
