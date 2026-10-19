// The formatter: canonical form with element IDs, and the rules normalizing can't fix.
// Tier II, pure functions over a DOM.
import { parse, serialize } from './canonical.mjs';
import { assignIdsTo } from './identity.mjs';
import { scopeElements } from './scopes.mjs';

// Canonical form with element IDs, plus the problems normalizing can't fix. The rewrite
// happens either way.
export function format(html) {
  const document = parse(html);
  assignIds(document);
  return { html: serialize(document), problems: validate(document) };
}

export function normalize(html) {
  return format(html).html;
}

// Every scope gets an ID. So do hr and every element of an svg, which took directives before
// scopes did; commenting inside an SVG stays as it is (Jess, 2026-10-12).
function identifiable(document) {
  const wanted = new Set(scopeElements(document));
  for (const el of document.querySelectorAll('body hr, body svg, body svg *')) wanted.add(el);
  return wanted;
}

export function assignIds(document) {
  assignIdsTo(document, identifiable(document));
}

// ---- Validation ---------------------------------------------------------

// Each rule takes the parsed document and returns one message per problem it can't fix.
// A problem the formatter can fix belongs in parse or serialize instead. No rules yet.
const RULES = [];

export function validate(document) {
  return RULES.flatMap((rule) => rule(document));
}
