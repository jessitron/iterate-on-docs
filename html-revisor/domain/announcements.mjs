// Announcements: what one box session did on its element, and what one field save did. Tier II, pure functions over a DOM.
import { trimAscii } from './canonical.mjs';
import { ID, elementById } from './identity.mjs';
import { collectDirectives, removeThreads, escapeDirectiveText, threadOf } from './directives.mjs';
import { baseOf, threadBaseOf } from './bases.mjs';
import { fieldType, fieldValueOf, labelOf } from './fields.mjs';

// What one box session did on its element, the document being the file at Done. Each change is
// {before, after}, and only there if it changed.
//   directive: from what the box opened with to what the file holds now.
//   revision: the scope's content as markdown, from before the session's first content save to
//     after its last, as the session kept them. A change by anyone else, before, between, or
//     after those saves, is not in it.
//   resolved: the turns of a thread the session's Resolve took away, [{prefix, text}], so the
//     agent hears the conversation ended: a Resolve announces even with nothing else changed.
// An element with a thread adds the thread's base, which a reply to it sends back. version is
// the element's version (its base) now, which the agent hands to change.mjs replace or remove;
// saw is the version the tab showed when the box closed. They differ when your words are about
// content that changed under the box.
// The element gone, a directive the session landed sits on the nearest of ancestors (IDs,
// nearest first) the page holds: id names that one, from the element typed on, and directive
// what the session typed, from the box's opening to its last save. version is the holder's, and
// saw stays the version of the element typed on, so the two always differ.
// session: what the server kept of the session, {said?, content?: {id, before, after}}.
// Null when the session did nothing, or its element and every ancestor are gone. Lifts the
// threads out of the document.
export function announcementOf(document, id, opened, author, { resolved = [], session = {}, saw, ancestors = [] } = {}) {
  const typedOn = elementById(document, id);
  const el = typedOn ?? (session.said !== undefined || session.content ? nearest(document, ancestors) : null);
  if (!el) return null;
  const here = el.getAttribute(ID);
  const announcement = { id: here, ...(typedOn ? {} : { from: id }), element: el.localName, heading: headingOf(el) };
  // Compare as the file holds it: trimmed, escaped.
  const directiveBefore = escapeDirectiveText(opened.directive.trim());
  const directiveAfter = typedOn ? collectDirectives(document, author)[id] ?? '' : session.said ?? directiveBefore;
  if (directiveAfter !== directiveBefore) announcement.directive = { before: directiveBefore, after: directiveAfter };
  const content = session.content;
  if (typeof content?.before === 'string' && typeof content.after === 'string' && content.before !== content.after) {
    announcement.revision = { before: content.before, after: content.after };
  }
  if (resolved.length) announcement.resolved = resolved;
  if (!announcement.directive && !announcement.revision && !announcement.resolved) return null;
  if (threadOf(el, author).length) announcement.thread = threadBaseOf(el, author);
  if (typeof saw === 'string' && saw) announcement.saw = saw;
  announcement.version = baseOf(el, author);
  removeThreads(document, author);
  return announcement;
}

// What a field save did: the field's value before and after, as fields.mjs says. The field's
// type, and its name and label when it has them, tell the agent which question it answers.
// version is the field's version now. Null when the value is the same, or the field is gone.
export function fieldAnnouncementOf(document, id, before, author) {
  const el = elementById(document, id);
  if (!el) return null;
  const after = fieldValueOf(el);
  if (JSON.stringify(after) === JSON.stringify(before)) return null;
  const name = el.getAttribute('name');
  const label = labelOf(el);
  const field = { type: fieldType(el), ...(name ? { name } : {}), ...(label ? { label } : {}), before, after };
  return { id, element: el.localName, heading: headingOf(el), field, version: baseOf(el, author) };
}

function nearest(document, ancestors) {
  for (const id of ancestors) {
    const el = elementById(document, id);
    if (el) return el;
  }
  return null;
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
