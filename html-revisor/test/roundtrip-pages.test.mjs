// Round-trip and reconcile on this repo's frozen pages and the fixtures. The mintlify page has
// its own file, roundtrip-mintlify.test.mjs, so the two run side by side.
import { pages, fileTests } from './roundtrip-lib.mjs';

fileTests(pages.filter((file) => !file.endsWith('mintlify-animal-fables.html')), "this repo's pages");
