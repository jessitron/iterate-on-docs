// A revision: one change to a page file, from the file's text to the text to write, or to a
// conflict that writes nothing. Tier II, pure functions over a file's text. Orchestration reads
// the file, writes what comes back, and answers; server.mjs names the bodies these take.
import { parse, serialize } from './canonical.mjs';
import { ID, elementById, assignIds } from './identity.mjs';
import { collectDirectives, threadOf, removeThreads, removeThread, setDirective, placeReply, replyCount, escapeDirectiveText } from './directives.mjs';
import { scopeElements, editable } from './scopes.mjs';
import { scopeMarkdown } from './to-markdown.mjs';
import { fingerprint, baseOf, basesOf, threadBaseOf, around } from './bases.mjs';
import { markdownsNear, saveMarkdown, spillOf, settle, spillIds, servedHTML, holderOf } from './markdown-edits.mjs';
import { isField, fieldType, fieldValueOf, fitsField, fieldShape, setField } from './fields.mjs';

// The step port: step(name, fn) runs fn and returns what it returns. The caller supplies it to
// observe each step, as a span, and hands fn a note(attributes) for what the step found out;
// left out, the steps just run.
const justRun = (name, fn) => fn(() => {});

// A change that can't land, and nothing is written. why: what kind of conflict, for telemetry.
// error: what the answer says. log: the line for the server's log, on a change that was not
// expected to meet this. now: what the answer adds for the sender to try again from.
const conflict = (why, error, log, now = {}) => ({ conflict: { why, error, log, now } });

// The file's text as a document, with IDs, so elements an agent added since the last format have
// them.
export function readRevision(text, step = justRun) {
  return step('parse', () => {
    const document = parse(text);
    assignIds(document);
    return document;
  });
}

// A change to content holds when it starts from the element as it stands: the base matches and
// the spill sits beside the element. A directive is a turn, not a change to content: no base
// refuses it, and it holds unless a reply came since it was typed. Gives the spill's elements,
// or a conflict.
function check(el, { id, base, replies, spill = [] }, kind, author) {
  if (!el) return conflict('no such element', 'that element is gone from the file', `conflict on element ${id} (no such element)`);
  if (kind === 'directive') {
    // A turn typed before a reply came in: the tab catches up and sends what's left after the reply.
    const repliesNow = replies === undefined ? replies : replyCount(el, author);
    if (repliesNow !== replies) return conflict('replied since', 'a reply came in on that thread', undefined, { replies: repliesNow });
    return { spilled: [] };
  }
  if (baseOf(el, author) !== base) {
    return conflict('changed on disk', 'that element changed on disk', `conflict on element ${id} (it changed on disk)`);
  }
  const spilled = spillOf(el, spill);
  if (!spilled) {
    return conflict('spill moved', 'what the last save made changed on disk', `conflict on element ${id} (what its last save made changed on disk)`);
  }
  return { spilled };
}

// Where a directive lands on an element that is gone: the nearest of its ancestors, nearest
// first, that the page still holds. Null when none is.
function nearest(document, ancestors = []) {
  for (const id of ancestors) {
    const el = elementById(document, id);
    if (el) return el;
  }
  return null;
}

// A directive moved to an ancestor joins after the directive already there. said is what this
// box session last landed: it comes off the end first, so each draft replaces the one before,
// whether this session or the agent's change moved it there.
function joined(document, holder, text, said, author) {
  const there = collectDirectives(document, author)[holder.getAttribute(ID)] ?? '';
  let rest = there;
  if (said && there === said) rest = '';
  else if (said && there.endsWith(`\n${said}`)) rest = there.slice(0, -said.length - 1);
  return [rest, escapeDirectiveText(text.trim())].filter(Boolean).join('\n');
}

// The scope's markdown as the file holds it, threads left out. Undefined for a scope that
// doesn't edit as markdown.
function contentOf(el, author) {
  if (!editable(el)) return undefined;
  const copy = el.cloneNode(true);
  removeThreads(copy, author);
  return scopeMarkdown(copy);
}

// Replace a scope, and its spill, with its markdown. Null when the scope can't take it.
function reviseMarkdown(document, el, { id, markdown }, spilled, author, step) {
  const saved = step('set markdown', () => saveMarkdown(el, markdown, spilled));
  if (!saved) return null;
  const settled = step('settle', () => settle(document, saved));
  const { nodes } = settled;
  const changed = around(nodes.filter((n) => n.nodeType === 1));
  const answer = step('served html', () => {
    const holder = holderOf(nodes, id, new Set(scopeElements(settled.document)));
    return { html: servedHTML(nodes, author), id: holder, spill: spillIds(nodes, holder) };
  });
  return { document: settled.document, changed, answer };
}

// change: {id, base, directive, replies?, ancestors?} | {id, base, markdown, spill?} | {id, base},
// by kind: "directive", "markdown", "resolve", or "field" (change.field: the field's value, as
// fields.mjs says, for an input, textarea, or select). A directive on an element that is gone lands on the nearest of
// its ancestors the page holds (ancestors: their IDs, nearest first), after the directive there;
// said is what the directive's box session last landed, as the file holds it.
// Gives one of:
//   {conflict}: see conflict above
//   {refused}: why the change can't be made at all
//   the revision, for answerOf: {written, wrote, ended, answer, …}. written is the text to write
//   when wrote is true. ended: the turns a Resolve took. answer: what a markdown save adds to it,
//   or for a directive that moved, {id, from, directive}: where it landed, the ID it was typed
//   on, and the directive there now. contentBefore: a markdown save's scope before it.
//   fieldBefore: a field save's value before it.
export function revise(text, change, kind, author, step = justRun, said = '') {
  const document = readRevision(text, step);
  const typedOn = elementById(document, change.id);
  const holder = !typedOn && kind === 'directive' ? nearest(document, change.ancestors) : null;
  const el = typedOn ?? holder;
  const checked = check(el, holder ? { ...change, replies: undefined } : change, kind, author);
  if (checked.conflict) return checked;
  const ended = kind === 'resolve' ? threadOf(el, author) : [];
  const contentBefore = kind === 'markdown' ? contentOf(el, author) : undefined;
  if (kind === 'directive' && holder) setDirective(el, joined(document, el, change.directive, said, author), author);
  else if (kind === 'directive') setDirective(el, change.directive, author);
  if (kind === 'resolve') step('resolve', () => removeThread(el, author));
  let touched = [el];
  const fieldBefore = kind === 'field' && isField(el) ? fieldValueOf(el) : undefined;
  if (kind === 'field') {
    if (!isField(el)) return { refused: 'only an input, textarea, or select takes a field value' };
    if (!fitsField(el, change.field)) return { refused: `a ${fieldType(el)} field takes ${fieldShape(el)}` };
    touched = setField(el, change.field);
  }
  const moved = holder ? { id: holder.getAttribute(ID), from: change.id, directive: collectDirectives(document, author)[holder.getAttribute(ID)] ?? '' } : {};
  const revised = kind === 'markdown' ? reviseMarkdown(document, el, change, checked.spilled, author, step) : { document, changed: around(touched), answer: moved };
  if (!revised) return { refused: 'markdown edits need a scope under 4 KB and non-blank markdown' };
  const written = step('serialize', () => serialize(revised.document));
  // A save the canonical file can't tell from what it holds writes nothing: a directive
  // differing only in edge whitespace (it's trimmed), markdown differing only in a trailing space.
  return { ...revised, kind, ended, text, written, wrote: written !== text, ...(contentBefore === undefined ? {} : { contentBefore }), ...(fieldBefore === undefined ? {} : { fieldBefore }) };
}

// What a directive save lands, as the file holds it: trimmed, escaped. A box session keeps it,
// so the next draft on an element that is gone replaces it (revise's said).
export const landed = (directive) => escapeDirectiveText(directive.trim());

// The answer to a change that landed, with bases and markdown as a reload would serve them: from
// the file in canonical layout. Orchestration calls it after the write, so a trace shows the steps
// in the order they ran.
export function answerOf({ document, changed, answer, kind, text, written }, author, step = justRun) {
  const count = Object.keys(collectDirectives(document, author)).length;
  const served = step('reparse', () => {
    const doc = parse(written);
    removeThreads(doc, author);
    return doc;
  });
  const now = changed.map((e) => elementById(served, e.getAttribute(ID))).filter(Boolean);
  const bases = step('bases', (note) => {
    note({ 'hrv.element.count': now.length });
    return basesOf(now, author);
  });
  const markdowns = kind === 'markdown' ? { markdowns: step('markdowns', (note) => markdownsNear(served, now, note)) } : {};
  return { ok: true, count, ...answer, bases, ...markdowns, before: fingerprint(text), after: fingerprint(written) };
}

// The agent's reply: {id, thread, reply}, thread being the thread base it started from. A turn
// added or resolved since makes that stale: a conflict that holds the thread's directive and base
// now, so the agent can read the new turn and reply again. Gives {conflict}, or {written, answer},
// and the answer carries the new base, for a reply after it.
export function reviseThread(text, { id, thread, reply }, author, step = justRun) {
  const document = readRevision(text, step);
  const el = elementById(document, id);
  const turns = el ? threadOf(el, author) : [];
  const now = el && step('check thread', () => threadBaseOf(el, author));
  if (!turns.length || now !== thread) {
    const why = !el ? 'that element is gone from the file' : !turns.length ? 'that element has no directive to reply to' : 'its thread changed since';
    const current = turns.length ? { directive: collectDirectives(document, author)[id] ?? '', thread: now } : {};
    return conflict(why, why, `stale reply on element ${id} (${why})`, current);
  }
  step('place reply', () => placeReply(el, reply, author));
  const written = step('serialize', () => serialize(document));
  const count = Object.keys(collectDirectives(document, author)).length;
  const answer = { ok: true, count, thread: threadBaseOf(elementById(parse(written), id), author), before: fingerprint(text), after: fingerprint(written) };
  return { written, answer };
}
