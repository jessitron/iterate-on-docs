// Cleanup: take out what the tool left in a page, for when iterating is done. Tier II, a pure
// function.
import { parse, serialize } from './canonical.mjs';
import { ID, NEXT_ID } from './identity.mjs';
import { allComments, isDirective, directiveText, removeThreads } from './directives.mjs';

// The page without threads or element IDs, in canonical layout, and the text of each directive
// removed. A thread left at "good enough" no longer matters, so it goes. Replies go unlisted:
// the agent committed each one.
export function cleanup(html, author = '@AI') {
  const document = parse(html);
  const removed = allComments(document)
    .filter((comment) => isDirective(comment, author))
    .map((comment) => directiveText(comment, author));
  removeThreads(document, author);
  for (const el of document.querySelectorAll(`[${ID}]`)) el.removeAttribute(ID);
  document.documentElement.removeAttribute(NEXT_ID);
  return { html: serialize(document), removed };
}
