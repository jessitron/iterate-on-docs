// Round-trip and reconcile on the mintlify page: a published docs page, divs nested about 12
// deep, the one page here shaped like the wider web.
import { pages, fileTests } from './roundtrip-lib.mjs';

fileTests(pages.filter((file) => file.endsWith('mintlify-animal-fables.html')), 'mintlify-animal-fables.html');
