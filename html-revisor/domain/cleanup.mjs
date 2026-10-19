// Cleanup: take out what the tool left in a page, for when iterating is done. Tier II, a pure
// function.
import { parse, serialize } from './canonical.mjs';
import { ID, NEXT_ID } from './identity.mjs';
import { allComments, isDirective, directiveText } from './directives.mjs';

// The page without directives or element IDs, in canonical layout, and the text of each
// directive removed. A directive left at "good enough" no longer matters, so it goes.
export function cleanup(html, author = '@AI') {
  const document = parse(html);
  const removed = [];
  for (const comment of allComments(document)) {
    if (!isDirective(comment, author)) continue;
    removed.push(directiveText(comment, author));
    comment.remove();
  }
  for (const el of document.querySelectorAll(`[${ID}]`)) el.removeAttribute(ID);
  document.documentElement.removeAttribute(NEXT_ID);
  return { html: serialize(document), removed };
}
