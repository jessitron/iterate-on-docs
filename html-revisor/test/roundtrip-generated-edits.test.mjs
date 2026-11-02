// Reconcile on generated pages, for the edits that aren't structure edits. roundtrip-lib.mjs
// says what the property is and holds the edits.
import { EDITS, STRUCTURE_EDITS, generatedEditTests } from './roundtrip-lib.mjs';

generatedEditTests(Object.keys(EDITS).filter((kind) => !STRUCTURE_EDITS.includes(kind)));
