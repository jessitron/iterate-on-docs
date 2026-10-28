// Scope reports: each scope in a piece of a page, nested, with the markdown you would edit for
// it. Tier II, pure functions over a DOM. scopes.mjs, the CLI, prints report; annotation.mjs
// writes exampleReport under each example in SCOPES-DESIGN.html.
import { rawHTML } from './canonical.mjs';
import { pickable } from './scopes.mjs';
import { scopeMarkdown } from './to-markdown.mjs';

// A scope: { el, markdown, children }. Every block element is one; so are links, images, spans,
// and svg <text> labels (D6). The children are the scopes nested inside it.
export function scopeOf(el) {
  return { el, markdown: scopeMarkdown(el), children: scopesWithin(el) };
}

export const scopesWithin = (el) => pickable(el).map(scopeOf);

// ---- Report -------------------------------------------------------------

const label = (el) => `<${el.localName}${el.getAttribute('class') ? `.${el.getAttribute('class').split(/\s+/).join('.')}` : ''}>`;

// How much of the scope markdown can say.
export function coverage(scope) {
  const md = scope.markdown;
  if (scope.el.localName === 'text') return 'svg text: markdown inside the label';
  if (md.trim() === '') return 'nothing to edit';
  const notes = [];
  // Not HTML: a destination in angle brackets, ](<a b.png>), or a code span, `<tag>`.
  if (/<[a-z]/.test(md.replace(/\]\(<[^<>]*>/g, '](').replace(/`[^`\n]*`/g, ''))) notes.push('HTML');
  if (/(^|[^\\])⟦/.test(md)) notes.push('⟦tokens⟧');
  return notes.length ? `markdown with ${notes.join(' and ')}` : 'all markdown';
}

// One line per scope, indented by nesting, the markdown on one line (⏎ for newlines).
export function report(scope, depth = 0) {
  const md = scope.markdown.replace(/\n/g, '⏎');
  const lines = [`${'  '.repeat(depth)}${label(scope.el)}${md ? `  ${md}` : ''}`];
  for (const child of scope.children) lines.push(report(child, depth + 1));
  return lines.join('\n');
}

function reportRows(document, scope, depth = 0) {
  const tr = document.createElement('tr');
  const cell = (text, mono) => {
    const td = document.createElement('td');
    if (mono && text) {
      const pre = document.createElement('pre');
      pre.textContent = text;
      td.appendChild(pre);
    } else td.textContent = text;
    tr.appendChild(td);
  };
  cell(`${' '.repeat(depth)}${label(scope.el)}`);
  cell(coverage(scope));
  cell(scope.markdown, true);
  return [tr, ...scope.children.flatMap((c) => reportRows(document, c, depth + 1))];
}

// The report on one .ex example, detached: a details holding its HTML, and a table of its
// scopes. annotation.mjs puts it under the example.
export function exampleReport(ex) {
  const document = ex.ownerDocument;
  const html = document.createElement('details');
  html.setAttribute('class', 'scope-report');
  const summary = document.createElement('summary');
  summary.textContent = 'HTML';
  const pre = document.createElement('pre');
  pre.textContent = [...ex.children].map(rawHTML).join('\n');
  html.append(summary, pre);

  const table = document.createElement('table');
  table.setAttribute('class', 'scope-report');
  table.innerHTML = '<tr><th>element</th><th>what markdown can say</th><th>what you would edit</th></tr>';
  for (const scope of scopesWithin(ex)) {
    for (const row of reportRows(document, scope)) table.appendChild(row);
  }
  return [html, table];
}

