// Reconcile, as property tests on generated pages: each edit keeps every element's ID and
// directive. roundtrip-lib.mjs says what the property is and holds the edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../domain/format.mjs';
import { SEEDS, EDITS, random, generator, pageFailure } from './roundtrip-lib.mjs';

for (const kind of Object.keys(EDITS)) {
  test(`edited, every scope in generated pages keeps its IDs: ${kind} (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const tidy = seed % 2 === 0;
      const html = normalize(`<html><body>${generator(random(seed), tidy)()}</body></html>`);
      const failure = pageFailure(html, (n) => seed * 1000 + n, kind);
      assert.equal(failure, null, `page seed ${seed}${tidy ? ' (tidy)' : ''}, ${failure}`);
    }
  });
}
