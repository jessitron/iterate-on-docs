// Reconcile on generated pages, for the structure edits. roundtrip-lib.mjs says what the
// property is and holds the edits. These sit apart from roundtrip-generated-edits because
// node --test runs files side by side, and the suite waits on the longest.
import { STRUCTURE_EDITS, generatedEditTests } from './roundtrip-lib.mjs';

generatedEditTests(STRUCTURE_EDITS);
