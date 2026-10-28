// Annotation: under each .ex example in SCOPES-DESIGN.html, its HTML and a table of its scopes,
// which scope-report.mjs builds. Tier II, pure functions over a DOM. Annotating again replaces each
// report the way a markdown save replaces a scope: the report elements that came back keep
// their IDs (identity.mjs) and directives (directives.mjs), so a rerun's diff shows only
// what the examples changed.
import { canonicalize } from './canonical.mjs';
import { ID, NEXT_ID, assignIds, reconcile } from './identity.mjs';
import { carryDirectives } from './directives.mjs';
import { exampleReport } from './scope-report.mjs';

// The page comes out in canonical form, its tables sectioned as parse sections them. A page
// that carries element IDs comes out with them, as the formatter writes it; one without
// stays without.
export function annotate(document) {
  const carriesIds = document.documentElement.hasAttribute(NEXT_ID) || document.querySelector(`[${ID}]`) !== null;
  const prior = takeAnnotations(document);
  for (const [key, ex] of examples(document)) ex.after(...replacing(prior.get(key), exampleReport(ex)));

  const legend = document.createElement('p');
  legend.setAttribute('class', 'scope-report');
  legend.innerHTML = LEGEND;
  document.querySelector('#scopes > p')?.after(...replacing(prior.get(LEGEND_KEY), [legend]));

  const style = document.createElement('style');
  style.setAttribute('id', 'scope-view');
  style.textContent = SCOPE_VIEW_CSS;
  document.querySelector('head').appendChild(style);
  if (carriesIds) assignIds(document);
}

// Each example by a key that finds its report on the next run: its element ID, or its place.
const examples = (document) => [...document.querySelectorAll('.ex')].map((ex, i) => [ex.getAttribute(ID) ?? `#${i}`, ex]);
const LEGEND_KEY = 'legend';
const isReport = (node) => node?.nodeType === 1 && node.classList.contains('scope-report');

// Removes this tool's marks. Returns the reports it took, by key: each example's, and the legend.
function takeAnnotations(document) {
  const taken = new Map();
  for (const [key, ex] of examples(document)) {
    const reports = [];
    for (let node = ex.nextSibling; node && (isReport(node) || node.nodeType !== 1); node = node.nextSibling) {
      if (isReport(node)) reports.push(node);
    }
    if (reports.length) taken.set(key, reports);
  }
  const legend = document.querySelector('#scopes > p.scope-report');
  if (legend) taken.set(LEGEND_KEY, [legend]);
  const holders = new Map([...taken].map(([key, els]) => [key, holding(document, els)]));
  document.querySelectorAll('.scope-report, #scope-view').forEach((el) => el.remove());
  return holders;
}

const holding = (document, els) => {
  const holder = document.createElement('div');
  holder.append(...els);
  return holder;
};

// The new report nodes in canonical form, with the IDs and directives of the prior report's
// elements that came back.
function replacing(prior, nodes) {
  const fresh = canonicalize(holding(nodes[0].ownerDocument, nodes));
  const canonical = [...fresh.childNodes];
  if (!prior) return canonical;
  return carryDirectives(prior, canonical, reconcile([...prior.children], canonical));
}

const LEGEND = `Under each example: its HTML (click to open), then a row for each element you could pick,
  nested inside the element that holds it. The last column is the markdown you would edit if you
  picked that element. ⟦svg⟧ marks something that isn't text riding inside the markdown.`;

const SCOPE_VIEW_CSS = `
  table.scope-report { font-size: 0.75rem; margin: 0.5rem 0; width: 100%; }
  table.scope-report td, table.scope-report th { vertical-align: top; padding: 0.15rem 0.5rem; }
  table.scope-report td:first-child { font-family: ui-monospace, monospace; white-space: pre; }
  table.scope-report pre, details.scope-report pre { margin: 0; padding: 0.15rem 0.4rem; background: #f6f8fa; white-space: pre-wrap; }
  details.scope-report { font-size: 0.75rem; margin: 0.5rem 0; }
`;
