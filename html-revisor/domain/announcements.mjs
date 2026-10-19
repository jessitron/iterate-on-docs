// Announcements: what one box session changed on its element. Tier II, pure functions over a DOM.
import { trimAscii } from './canonical.mjs';
import { ID, elementById } from './identity.mjs';
import { collectDirectives, removeDirectives, escapeDirectiveText } from './directives.mjs';
import { scopeElements, scopeMarkdown, editable } from './scopes.mjs';

// What one box session changed on its element, from what the box opened with to the document
// now: the directive, and for a scope its content, a revision. Each is {before, after}, and only
// there if it changed. Null when nothing changed or the element is gone. Lifts the directives
// out of the document.
export function announcementOf(document, id, opened, author) {
  const el = elementById(document, id);
  if (!el) return null;
  const announcement = { id, element: el.localName, heading: headingOf(el) };
  // Compare as the file holds it: trimmed, escaped.
  const directiveBefore = escapeDirectiveText(opened.directive.trim());
  const directiveAfter = collectDirectives(document, author)[id] ?? '';
  if (directiveAfter !== directiveBefore) announcement.directive = { before: directiveBefore, after: directiveAfter };
  removeDirectives(document, author);
  if (typeof opened.markdown === 'string' && editable(el) && scopeElements(document).includes(el)) {
    const markdown = scopeMarkdown(el);
    if (markdown !== opened.markdown) announcement.revision = { before: opened.markdown, after: markdown };
  }
  return announcement.directive || announcement.revision ? announcement : null;
}

// The text of the heading the element sits under: itself, or the last h1-h6 before it. Null
// when there is none.
function headingOf(el) {
  let heading = null;
  for (const e of el.ownerDocument.querySelectorAll(`h1, h2, h3, h4, h5, h6, [${ID}="${el.getAttribute(ID)}"]`)) {
    if (e === el) break;
    heading = e;
  }
  if (/^h[1-6]$/.test(el.localName)) heading = el;
  return heading ? trimAscii(heading.textContent.replace(/[ \t\n\r\f]+/g, ' ')) : null;
}
