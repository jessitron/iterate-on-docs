// Markdown edits: the markdown the box shows for each scope, and what saving it does to the
// document. Tier II, pure functions over a DOM.
import { parse, serialize, trimAscii } from './canonical.mjs';
import { ID, assignIds, reconcile, elementById } from './identity.mjs';
import { removeThreads, carryDirectives } from './directives.mjs';
import { scopeElements, editable } from './scopes.mjs';
import { scopeMarkdown } from './to-markdown.mjs';
import { nodesFromMarkdown } from './from-markdown.mjs';
import { normalize } from './format.mjs';

// Each scope's markdown, by ID: what the box shows. Not body's, which nobody picks, and not a
// scope too big to edit.
export function markdownsOf(scopes) {
  return Object.fromEntries(
    scopes.filter((el) => el.hasAttribute(ID) && el.localName !== 'body' && editable(el)).map((el) => [el.getAttribute(ID), scopeMarkdown(el)]),
  );
}

// Each scope's markdown in the committed copy of the page, by ID: what Revert puts back. A
// commit made mid-loop holds IDs; one committed clean gets them from normalize, which numbers a
// page the same way every time, so they match the page as first opened if it hasn't changed
// since. No commit, or a copy the formatter can't handle, gives none.
export function committedMarkdowns(html, author) {
  if (html === null) return {};
  try {
    const document = parse(normalize(html));
    removeThreads(document, author);
    return markdownsOf(scopeElements(document));
  } catch {
    return {};
  }
}

// The nodes that replace a scope's element when its markdown is saved: what the markdown says
// (from-markdown.mjs), with the IDs (identity.mjs) and directives (directives.mjs) of the elements you
// left or changed. Saving it unchanged gives back the same HTML, element IDs and directives
// included (SCOPES-DESIGN.html#identity).
// A spill is the elements beside the scope that its last save made, as the file holds them
// (settle, below): the box's markdown makes all of them, so its next save replaces them too.
export function scopeFromMarkdown(el, markdown, spill = []) {
  let nodes = nodesFromMarkdown(el, markdown);
  const partners = reconcile([el, ...spill], nodes);
  for (const prior of [el, ...spill]) nodes = carryDirectives(prior, nodes, partners);
  return nodes;
}

// The spill's elements, by ID: siblings of the scope's element. Null when one isn't.
export function spillOf(el, ids) {
  const els = ids.map((id) => [...el.parentNode.children].find((e) => e.getAttribute(ID) === id));
  return els.every((e) => e && e !== el) ? els : null;
}

// Replace a scope, and its spill, with what its markdown says. The elements you left or changed
// keep their IDs and directives (scopeFromMarkdown); new ones get IDs. Returns the nodes that
// replaced them, or null, changing nothing, for an element that isn't a scope, one too big to
// edit, or blank markdown. The nodes go where the first of them was, and everything between the
// first and the last goes.
export function saveMarkdown(el, markdown, spill = []) {
  const document = el.ownerDocument;
  if (trimAscii(markdown) === '' || el.localName === 'body' || !editable(el) || !scopeElements(document).includes(el)) return null;
  const nodes = scopeFromMarkdown(el, markdown, spill);
  const siblings = [...el.parentNode.childNodes];
  const at = [el, ...spill].map((n) => siblings.indexOf(n));
  const gone = siblings.slice(Math.min(...at), Math.max(...at) + 1);
  gone[0].replaceWith(...nodes);
  gone.slice(1).forEach((n) => n.remove());
  assignIds(document);
  return nodes;
}

// The document and the saved nodes as the file holds them once read back. A DOM can nest what
// HTML can't: a <p> typed in a paragraph's markdown is a p inside a p, and the file splits it into
// paragraphs. When the nodes read back the same, nothing changes. When they don't, the document
// is read back whole, and the nodes are what lies between the elements around them.
export function settle(document, nodes) {
  const holder = document.createElement('div');
  holder.append(...nodes.map((n) => n.cloneNode(true)));
  const html = holder.innerHTML;
  if (!nodes.some((n) => n.nodeType === 1) || parse(`<body>${html}</body>`).body.innerHTML === html) return { document, nodes };
  const first = nodes[0], last = nodes.at(-1);
  const prev = first.previousElementSibling ?? null, next = last.nextElementSibling ?? null;
  const parentId = first.parentNode.getAttribute?.(ID);
  const again = parse(serialize(document));
  assignIds(again);
  const parent = parentId ? elementById(again, parentId) : null;
  const find = (e) => (e ? [...(parent?.children ?? [])].find((c) => c.getAttribute(ID) === e.getAttribute(ID)) : null);
  const [from, to] = [find(prev), find(next)];
  if (!parent || (prev && !from) || (next && !to)) {
    // Read back, the nodes left their parent: keep the ones still there.
    const ids = new Set(nodes.filter((n) => n.nodeType === 1).map((n) => n.getAttribute(ID)));
    return { document: again, nodes: [...again.querySelectorAll(`[${ID}]`)].filter((e) => ids.has(e.getAttribute(ID))) };
  }
  const children = [...parent.childNodes];
  const start = from ? children.indexOf(from) + 1 : 0;
  const end = to ? children.indexOf(to) : children.length;
  return { document: again, nodes: children.slice(start, end).filter((n) => n.nodeType !== 3 || n.textContent.trim() !== '') };
}

// The IDs of the other elements among the nodes: the spill the box's next save replaces.
export function spillIds(nodes, holder) {
  return nodes.filter((n) => n.nodeType === 1 && n.getAttribute(ID) !== holder).map((n) => n.getAttribute(ID));
}

// The nodes as the tab shows them: threads lifted out.
export function servedHTML(nodes, author) {
  const holder = nodes[0].ownerDocument.createElement('div');
  holder.append(...nodes.map((n) => n.cloneNode(true)));
  removeThreads(holder, author);
  return holder.innerHTML;
}

// The ID that holds the scope after a save: its own, if its element came back, else the first
// new scope's, so the box can follow it. Null when the scope became bare text.
export function holderOf(nodes, id, scopes) {
  const els = nodes.filter((n) => n.nodeType === 1);
  const holder = els.find((e) => e.getAttribute(ID) === id) ?? els.find((e) => scopes.has(e) && e.hasAttribute(ID));
  return holder?.getAttribute(ID) ?? null;
}
