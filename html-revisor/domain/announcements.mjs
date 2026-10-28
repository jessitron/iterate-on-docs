// Announcements: what one box session changed on its element. Tier II, pure functions over a DOM.
import { trimAscii } from './canonical.mjs';
import { ID, elementById } from './identity.mjs';
import { collectDirectives, removeThreads, escapeDirectiveText, threadOf } from './directives.mjs';
import { threadBaseOf } from './bases.mjs';
import { scopeElements, editable } from './scopes.mjs';
import { scopeMarkdown } from './to-markdown.mjs';

// What one box session changed on its element, from what the box opened with to the document
// now: the directive, and for a scope its content, a revision. Each is {before, after}, and only
// there if it changed. Null when nothing changed or the element is gone. An element with a
// thread adds the thread's base, which a reply to it sends back. resolved is the turns of a
// thread the session's Resolve took away, [{prefix, text}], so the agent hears the conversation
// ended: a Resolve announces even with nothing else changed. Lifts the threads out of the
// document.
export function announcementOf(document, id, opened, author, resolved = []) {
  const el = elementById(document, id);
  if (!el) return null;
  const announcement = { id, element: el.localName, heading: headingOf(el) };
  // Compare as the file holds it: trimmed, escaped.
  const directiveBefore = escapeDirectiveText(opened.directive.trim());
  const directiveAfter = collectDirectives(document, author)[id] ?? '';
  if (directiveAfter !== directiveBefore) announcement.directive = { before: directiveBefore, after: directiveAfter };
  const thread = threadOf(el, author).length ? threadBaseOf(el, author) : null;
  removeThreads(document, author);
  if (typeof opened.markdown === 'string' && editable(el) && scopeElements(document).includes(el)) {
    const markdown = scopeMarkdown(el);
    if (markdown !== opened.markdown) announcement.revision = { before: opened.markdown, after: markdown };
  }
  if (resolved.length) announcement.resolved = resolved;
  if (!announcement.directive && !announcement.revision && !announcement.resolved) return null;
  if (thread) announcement.thread = thread;
  return announcement;
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
