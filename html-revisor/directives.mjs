// Directives: requests about one element, in the file as <!-- author: text -->. Where one sits
// says which element it is about. Tier II, pure functions over a DOM; server.mjs and scopes.mjs
// both use the placement rule.
import { VOID, RAW, ID, trimAscii } from './formatter.mjs';

// Directives go before these elements; for everything else a directive is the first child.
// Elements whose content is parsed as plain text (title, iframe, ...) cannot hold a comment.
export const TEXT_ONLY = 'title iframe xmp noembed noframes'.split(' ');
// Read on each call: formatter.mjs and scopes.mjs import each other, so VOID may not exist yet
// while this module loads.
const directiveGoesBefore = (el) => VOID.has(el.localName) || RAW.has(el.localName) || TEXT_ONLY.includes(el.localName);

// A directive is an HTML comment inside an element whose text starts with "<author>:".
// Comments outside any element (before <html>) are never directives.
export function isDirective(node, author) {
  return (
    node.nodeType === 8 &&
    node.parentNode?.nodeType === 1 &&
    node.data.trimStart().startsWith(`${author}:`)
  );
}

export function directiveText(comment, author) {
  return comment.data.trimStart().slice(author.length + 1).trim();
}

// Escape so the text cannot end the comment early. Repeat for runs like "---".
export function escapeDirectiveText(text) {
  let out = text;
  while (out.includes('--')) out = out.replaceAll('--', '- -');
  return out.replaceAll('>', '&gt;');
}

export function allComments(node, found = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === 8) found.push(child);
    else if (child.nodeType === 1) allComments(child, found);
  }
  return found;
}

// The reading rule: a directive belongs to its parent, unless the next sibling (skipping
// whitespace-only text) is a void or preformatted element; then it belongs to that sibling.
// Only whitespace is skipped, not other directives. Skipping directives would make a parent's
// directive and the directive of its first-child <img> ambiguous; since writing merges to one
// directive per element, they sit in order [parent directive][img directive][img] and read back correctly.
// Known limit: a parent's directive directly before an <img> first child that has no directive reads as the img's.
export function directiveOwner(comment) {
  let next = comment.nextSibling;
  while (next?.nodeType === 3 && trimAscii(next.data) === '') next = next.nextSibling;
  return next?.nodeType === 1 && directiveGoesBefore(next) ? next : comment.parentNode;
}

// { [element ID]: directive text }; several directives on one element join with newlines.
// A directive on an element with no ID stays in the file, unseen.
export function collectDirectives(document, author) {
  const directives = {};
  for (const comment of allComments(document)) {
    if (!isDirective(comment, author)) continue;
    const id = directiveOwner(comment).getAttribute?.(ID);
    if (id == null) continue;
    const text = directiveText(comment, author);
    directives[id] = id in directives ? `${directives[id]}\n${text}` : text;
  }
  return directives;
}

export function removeDirectives(document, author) {
  for (const comment of allComments(document)) {
    if (isDirective(comment, author)) comment.remove();
  }
}

// Replace the element's directives with this one; empty text leaves it none. Other
// elements' directives stay where they are.
export function setDirective(el, text, author) {
  for (const comment of allComments(el.ownerDocument)) {
    if (isDirective(comment, author) && directiveOwner(comment) === el) comment.remove();
  }
  if (text.trim()) placeDirective(el, text, author);
}

export function placeDirective(el, text, author) {
  attachComments(el, [el.ownerDocument.createComment(` ${author}: ${escapeDirectiveText(text.trim())} `)]);
}

// Put comments on an element, in order, where the reading rule finds them: first children, or
// just before an element that can't hold one.
export function attachComments(el, comments) {
  const before = directiveGoesBefore(el) && el.parentNode;
  const [parent, next] = before ? [el.parentNode, el] : [el, el.firstChild];
  for (const comment of comments) parent.insertBefore(comment, next);
}
