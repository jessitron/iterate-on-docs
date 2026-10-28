// How alike two pieces of HTML are. Tier II, a pure function over strings: reconcile
// (identity.mjs) pairs elements with it, and restore (from-markdown.mjs) pairs stand-ins.

// How alike two elements of one tag are, by their content: of the character pairs in the
// shorter, the share the other holds too. Typing more into an item keeps it alike; its tags,
// the same on both, don't count. Ties go to the closer length (the Dice coefficient). An
// element with no content, like an img, compares its tag.
export function likeness(x, y) {
  const inner = (s) => s.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '');
  if (inner(x) && inner(y)) [x, y] = [inner(x), inner(y)];
  const pairsOf = (s) => {
    const counts = new Map();
    for (let i = 0; i < s.length - 1; i++) counts.set(s.slice(i, i + 2), (counts.get(s.slice(i, i + 2)) ?? 0) + 1);
    return counts;
  };
  const [px, py] = [pairsOf(x), pairsOf(y)];
  let shared = 0;
  for (const [p, n] of px) shared += Math.min(n, py.get(p) ?? 0);
  const contained = shared / Math.max(Math.min(x.length, y.length) - 1, 1);
  const dice = (2 * shared) / Math.max(x.length + y.length - 2, 1);
  return contained + dice / 100;
}
