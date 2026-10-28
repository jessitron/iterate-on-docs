// Round-trip and tidy markdown, as property tests on generated pages. roundtrip-lib.mjs says
// what the properties are and holds the generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../domain/format.mjs';
import { parse, canonicalHTML } from '../domain/canonical.mjs';
import { scopeMarkdown } from '../domain/to-markdown.mjs';
import { SEEDS, random, generator, directEverything, scopeElements, roundTripFailure } from './roundtrip-lib.mjs';

for (const tidy of [false, true]) {
  test(`generated ${tidy ? 'tidy ' : ''}pages: every scope round-trips (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const body = generator(random(seed), tidy)();
      const document = directEverything(parse(normalize(`<html><body>${body}</body></html>`)));
      for (const el of scopeElements(document)) {
        const failure = roundTripFailure(document, el);
        assert.equal(failure, null, `seed ${seed}${tidy ? ' (tidy)' : ''}: ${failure}`);
      }
    }
  });
}

// A section or a card has no markdown syntax: its tags stand on their own lines around markdown.
const WRAPPER_LINE = /^<\/?[a-z][a-z0-9]*(\s[^<>]*)?>$/gm;

test(`generated tidy pages come out as markdown, HTML only for the tags of sections and cards (${SEEDS} seeds)`, () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const document = parse(normalize(`<html><body>${generator(random(seed), true)()}</body></html>`));
    for (const el of scopeElements(document)) {
      const markdown = scopeMarkdown(el);
      const html = markdown
        .replace(WRAPPER_LINE, '')
        .replace(/\]\(<[^<>]*>/g, '](') // a destination with a space: ![x](<a b.png>)
        .replace(/`[^`\n]*`/g, '') // a code span: `<tag>`
        .match(/<\/?[a-z][a-z0-9]*[\s>]/);
      assert.equal(html, null, `seed ${seed}: <${el.localName}> came out with HTML:\n${canonicalHTML(document, [el])}\n--- markdown\n${markdown}`);
    }
  }
});
