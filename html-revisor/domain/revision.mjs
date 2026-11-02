// A revision: one change to a page file, from the file's text to the text to write, or to a
// conflict that writes nothing. Tier II, pure functions over a file's text. Orchestration reads
// the file, writes what comes back, and answers; server.mjs names the bodies these take.
import { parse, serialize } from './canonical.mjs';
import { ID, elementById, assignIds } from './identity.mjs';
import { collectDirectives, threadOf, removeThreads, removeThread, setDirective, placeReply, replyCount } from './directives.mjs';
import { editable, scopeElements } from './scopes.mjs';
import { fingerprint, baseOf, basesOf, threadBaseOf, around } from './bases.mjs';
import { markdownsOf, saveMarkdown, spillOf, settle, spillIds, servedHTML, holderOf } from './markdown-edits.mjs';

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

// A change holds when it starts from the element as it stands: the base matches, the spill sits
// beside the element, and no reply came since the turn was typed. Gives the spill's elements, or
// a conflict.
function check(el, { id, base, replies, spill = [] }, kind, author) {
  if (!el) return conflict('no such element', 'that element is gone from the file', `conflict on element ${id} (no such element)`);
  if (baseOf(el, author) !== base) {
    return conflict('changed on disk', 'that element changed on disk', `conflict on element ${id} (it changed on disk)`);
  }
  const spilled = spillOf(el, spill);
  if (!spilled) {
    return conflict('spill moved', 'what the last save made changed on disk', `conflict on element ${id} (what its last save made changed on disk)`);
  }
  // A turn typed before a reply came in: the tab catches up and sends what's left after the reply.
  const repliesNow = kind === 'directive' && replies !== undefined ? replyCount(el, author) : replies;
  if (repliesNow !== replies) return conflict('replied since', 'a reply came in on that thread', undefined, { replies: repliesNow });
  return { spilled };
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

// change: {id, base, directive, replies?} | {id, base, markdown, spill?} | {id, base}, by kind:
// "directive", "markdown", or "resolve".
// Gives one of:
//   {conflict}: see conflict above
//   {refused}: why the change can't be made at all
//   the revision, for answerOf: {written, wrote, ended, answer, …}. written is the text to write
//   when wrote is true. ended: the turns a Resolve took. answer: what a markdown save adds to it.
export function revise(text, change, kind, author, step = justRun) {
  const document = readRevision(text, step);
  const el = elementById(document, change.id);
  const checked = check(el, change, kind, author);
  if (checked.conflict) return checked;
  const ended = kind === 'resolve' ? threadOf(el, author) : [];
  if (kind === 'directive') step('set directive', () => setDirective(el, change.directive, author));
  if (kind === 'resolve') step('resolve', () => removeThread(el, author));
  const revised = kind === 'markdown' ? reviseMarkdown(document, el, change, checked.spilled, author, step) : { document, changed: around([el]), answer: {} };
  if (!revised) return { refused: 'markdown edits need a scope under 4 KB and non-blank markdown' };
  const written = step('serialize', () => serialize(revised.document));
  // A save the canonical file can't tell from what it holds writes nothing: a directive
  // differing only in edge whitespace (it's trimmed), markdown differing only in a trailing space.
  return { ...revised, kind, ended, text, written, wrote: written !== text };
}

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

function markdownsNear(served, elements, note) {
  const scopes = new Set(scopeElements(served));
  const mine = elements.filter((e) => scopes.has(e));
  note({ 'hrv.scope.count': mine.length });
  // A scope the save grew past the limit loses its Content field: null tells the tab.
  const grown = mine.filter((e) => e.hasAttribute(ID) && e.localName !== 'body' && !editable(e));
  return { ...Object.fromEntries(grown.map((e) => [e.getAttribute(ID), null])), ...markdownsOf(mine) };
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
