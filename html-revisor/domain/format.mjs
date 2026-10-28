// The formatter: canonical form with element IDs, and the rules normalizing can't fix.
// Tier II, pure functions over a DOM.
import { parse, serialize } from './canonical.mjs';
import { assignIds } from './identity.mjs';

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

// ---- Validation ---------------------------------------------------------

// Each rule takes the parsed document and returns one message per problem it can't fix.
// A problem the formatter can fix belongs in parse or serialize instead. No rules yet.
const RULES = [];

export function validate(document) {
  return RULES.flatMap((rule) => rule(document));
}
