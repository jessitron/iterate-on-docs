// html-revisor: leave directives on HTML files; they live in the file as <!-- author: text -->.
//
// Tier I, orchestration: the CLI, request routing, and the GET, PUT, and Done flows. The domain
// is in domain/, the filesystem, HTTP, stdout, and telemetry in interface/.
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { formatFiles } from './formatter.mjs';
import { parse } from './domain/canonical.mjs';
import { normalize } from './domain/format.mjs';
import { scopeElements } from './domain/scopes.mjs';
import { fingerprint } from './domain/bases.mjs';
import { markdownsOf, committedMarkdowns } from './domain/markdown-edits.mjs';
import { announcementOf, fieldAnnouncementOf } from './domain/announcements.mjs';
import { injectClient, tabStateOf } from './domain/served-page.mjs';
import { readRevision, revise, answerOf, reviseThread, landed } from './domain/revision.mjs';
import { seenOf, noticesOf, explained, ack, absorb, directed } from './domain/notices.mjs';
import { KINDS, WHERE, readScope, reviseByAgent } from './domain/agent-change.mjs';
import { catchUp } from './domain/catch-up.mjs';
import { readText, readBytes, writeText, listDirectory, isDirectory, readCommitted, readClientAssets, watchFile } from './interface/files.mjs';
import {
  HttpError, decodeRequestPath, queryOf, resolveUnderRoot, readJson, sendFile, sendHtml, sendJson, sendNoContent, redirect, sendError, directoryListing,
  wants, openEventStream,
} from './interface/http.mjs';
import { announce } from './interface/stdout.mjs';
import { trace, inSpan, step, requestSpan, startTelemetry, recordBrowserSpans, spanTime } from './interface/telemetry.mjs';

export function parseArgs(argv) {
  const config = { root: process.cwd(), port: 7777, author: '@AI' };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--port') config.port = Number(inline ?? argv[++i]);
    else if (flag === '--author') config.author = inline ?? argv[++i];
    else if (flag === '--replies' && inline === undefined) config.replies = true;
    else if (!flag.startsWith('--')) config.root = path.resolve(argv[i]);
    else throw new Error(`unknown option ${flag}`);
  }
  return config;
}

// replies: an agent answers in the page, through reply.mjs. Off, the agent and the user take
// turns: the agent edits the file between them, the tab shows no agent working, and a reply is
// refused.
// telemetry: the server sends spans, so the page's client records its own and posts them here.
// Closing the server ends every tab's event stream and stops watching files, so close() returns.
export function createServer({ root, author, replies = false, telemetry = false }) {
  const inTurn = oneAtATime();
  const texts = recentTexts();
  const config = { root: path.resolve(root), author, replies, telemetry, inTurn, texts, resolved: resolvedTurns(), sessions: boxSessions(), live: liveNotices(inTurn, texts), seen: seenPages(author) };
  const server = http.createServer((req, res) => {
    // Spans from the browser get no span of their own: one per batch would be noise.
    if (req.url === SPANS_PATH) return receiveSpans(req, res).catch((err) => sendError(res, err));
    // An event stream stays open as long as the tab does: no span, it would never end.
    if (req.method === 'GET' && wants(req) === 'events') return streamEvents(req, res, config).catch((err) => sendError(res, err));
    requestSpan(req, res, (span) =>
      route(req, res, config).catch((err) => {
        span.recordException(err, spanTime());
        sendError(res, err);
      }),
    );
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    config.live.close();
    return close(callback);
  };
  return server;
}

// The server is the only writer of a live file, and it writes one change at a time: each read,
// change, and write of a file waits for the one before it. So the agent's replies and the
// browser's saves land in the order they came, and neither overwrites the other.
// inTurn(file, fn) runs fn after the file's earlier turns settle, and returns what fn does.
function oneAtATime() {
  const tails = new Map();
  return (file, fn) => {
    const result = (tails.get(file) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => {});
    tails.set(file, tail);
    tail.then(() => tails.get(file) === tail && tails.delete(file));
    return result;
  };
}

// The turns each Resolve took out of a file, until the box's Done announces them. Resolve closes
// the box, so its Done comes next in the file's turn, and one box session is one Announcement.
// note(file, id, turns) after a resolve; take(file, id) gives them once, [] when there are none.
// A Done that never comes leaves them for the element's next Done: the Resolve did happen.
function resolvedTurns() {
  const turns = new Map();
  const key = (file, id) => `${file}\n${id}`;
  return {
    note: (file, id, resolved) => resolved.length && turns.set(key(file, id), resolved),
    take: (file, id) => {
      const resolved = turns.get(key(file, id)) ?? [];
      turns.delete(key(file, id));
      return resolved;
    },
  };
}

// What each box session did, until its Done announces it: one box session is one change and one
// turn, and its saves are drafts. A session is the random ID the tab gives a box when it opens.
// Call these in the file's turn.
// said(file, session, text): a directive save landed text (as the file holds it).
// wrote(file, session, id, before, after): a content save on scope id took its markdown from
//   before to after; the session's first save keeps its before, the last its after and id.
// get(file, session): {said?, content?: {id, before, after}}; take(file, session) gives it once.
function boxSessions() {
  const sessions = new Map();
  const key = (file, session) => `${file}\n${session}`;
  const get = (file, session) => sessions.get(key(file, session)) ?? {};
  const set = (file, session, record) => session && sessions.set(key(file, session), { ...get(file, session), ...record });
  return {
    get,
    said: (file, session, text) => set(file, session, { said: text }),
    wrote(file, session, id, before, after) {
      set(file, session, { content: { id, before: get(file, session).content?.before ?? before, after } });
    },
    take(file, session) {
      const record = get(file, session);
      sessions.delete(key(file, session));
      return record;
    },
  };
}

// What you have seen of each page, in memory: each scope's content as you last saw it
// (domain/notices.mjs). The first read of a page takes it as seen, whole; your own changes
// through the tab and your acks add to it. A restart forgets. Call these in the file's turn.
// notices(file, document): the notices on the page now, the page taken as seen if it's the first.
// saw(file, before, after, id): your change, from before to after, on element id.
// acked(file, document, id): you've seen element id ("all": the page); gives the notices now.
// directed(file, document, id): your directive on element id; its mark and those around it are
// seen, not those inside; gives the notices now.
// said(file, id, because): the agent's words for its change to scope id; none takes them away.
function seenPages(author) {
  const pages = new Map();  // file -> seen
  const becauses = new Map();  // file -> Map of scope ID -> the agent's words for its change
  const notices = (file, document) => {
    if (!pages.has(file)) pages.set(file, inSpan('seen', {}, () => seenOf(document, author)));
    return inSpan('notices', {}, (span) => {
      const found = explained(noticesOf(document, pages.get(file), author), document, becauses.get(file) ?? new Map());
      becauses.set(file, found.becauses);
      span.setAttribute('hrv.notice.count', found.notices.length);
      return found.notices;
    });
  };
  return {
    notices,
    said(file, id, because) {
      const words = becauses.get(file) ?? new Map();
      if (because?.trim()) words.set(id, because.trim());
      else words.delete(id);
      becauses.set(file, words);
    },
    saw(file, before, after, id) {
      if (pages.has(file)) inSpan('absorb', {}, () => pages.set(file, absorb(pages.get(file), before, after, id, author)));
      return notices(file, after);
    },
    acked(file, document, id) {
      pages.set(file, ack(pages.get(file) ?? seenOf(document, author), document, id, author));
      return notices(file, document);
    },
    directed(file, document, id) {
      if (pages.has(file)) inSpan('directed', {}, () => pages.set(file, directed(pages.get(file), document, id, author)));
      return notices(file, document);
    },
  };
}

// The texts of each file the server read or wrote lately, by version (the text's fingerprint).
// A tab names the version it shows when it catches up, and the server sends what changed since
// (domain/catch-up.mjs). Every version a tab can hold came through here: the page it loaded, a
// save's answer, a state it caught up to. A version too old to be kept gets the whole body.
// keep(file, text) after a read or write; get(file, version): the text, or null.
const KEPT_TEXTS = 8;
function recentTexts() {
  const files = new Map(); // file -> Map of version -> text, oldest first
  return {
    keep(file, text) {
      const kept = files.get(file) ?? new Map();
      const version = fingerprint(text);
      kept.delete(version);
      kept.set(version, text);
      while (kept.size > KEPT_TEXTS) kept.delete(kept.keys().next().value);
      files.set(file, kept);
    },
    get: (file, version) => files.get(file)?.get(version) ?? null,
  };
}

// Live notice: each open tab keeps an event stream to its page and hears of every change to
// the file, so it catches up without saving first. A change the server makes (a save from any
// tab, a reply, GET's format) goes out as the server writes it, with what it was and the
// element. A write that goes around the server, such as an agent's edit, the server finds by
// watching the file. Every notice carries the file's version after the change, its fingerprint,
// so a tab that already holds that version, the one whose save it was, ignores it.
//   event: change
//   data: {"version": "<fingerprint>", "cause": "directive"|"markdown"|"resolve"|"field"|"reply"|"agent"|"format"|"disk"|"connect", "id"?: "<id>"}
// "agent" is the agent's change through change.mjs, with the ID of the scope it named.
// "connect" is the first event on each stream: the version now, for a tab that loaded an
// older one or reconnects after a restart. An ack changes no file; it goes out as
//   event: notices
//   data: {"notices": [{"id", "kind": "changed"|"new"}]}
function liveNotices(inTurn, texts) {
  const pages = new Map();  // file -> {streams, known: the version the server last wrote or told, stop}
  const tell = (page, notice) => page.streams.forEach((stream) => stream.send('change', notice));

  // The watcher reads in turn, so it never sees a write of the server's half done. A version the
  // server already told is its own write, not news.
  function watch(file, page) {
    return watchFile(file, () => inTurn(file, async () => {
      const text = await readText(file).catch(() => null);
      if (text === null) return;  // gone for now: an editor's rename comes back as a second event
      texts.keep(file, text);
      const version = fingerprint(text);
      if (version === page.known) return;
      page.known = version;
      tell(page, { version, cause: 'disk' });
    }));
  }

  return {
    async subscribe(file, res) {
      let page = pages.get(file);
      const text = await inTurn(file, () => readText(file));
      texts.keep(file, text);
      if (!page) {
        page = { streams: new Set(), known: fingerprint(text) };
        page.stop = watch(file, page);
        pages.set(file, page);
      }
      const stream = openEventStream(res, () => {
        page.streams.delete(stream);
        if (page.streams.size || pages.get(file) !== page) return;
        page.stop();
        pages.delete(file);
      });
      page.streams.add(stream);
      stream.send('change', { version: fingerprint(text), cause: 'connect' });
    },
    // The server wrote text to the file, for cause, on element id.
    wrote(file, text, cause, id) {
      const page = pages.get(file);
      if (!page) return;
      page.known = fingerprint(text);
      tell(page, { version: page.known, cause, ...(id ? { id } : {}) });
    },
    // You acked a notice: the file's version stays, so this is its own event.
    noticed(file, notices) {
      pages.get(file)?.streams.forEach((stream) => stream.send('notices', { notices }));
    },
    close() {
      for (const page of pages.values()) {
        page.stop();
        page.streams.forEach((stream) => stream.end());
      }
      pages.clear();
    },
  };
}

// GET with Accept: text/event-stream, from the tab's EventSource: the page's live notices.
async function streamEvents(req, res, { root, live }) {
  const urlPath = decodeRequestPath(req.url);
  const file = resolveUnderRoot(root, urlPath);
  if (!/\.html?$/i.test(urlPath)) throw new HttpError(404, 'not found');
  await live.subscribe(file, res);
}

// Where the page's client posts its spans. A dot path: no file under the root can be served there.
const SPANS_PATH = '/.hrv/spans';

async function receiveSpans(req, res) {
  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
  recordBrowserSpans(await readJson(req));
  sendNoContent(res);
}

async function route(req, res, config) {
  const urlPath = decodeRequestPath(req.url);
  const file = resolveUnderRoot(config.root, urlPath);
  const isHtml = /\.html?$/i.test(urlPath);
  const named = (what) => trace.getActiveSpan()?.updateName(`${req.method} ${what}`);

  if (req.method === 'PUT' && isHtml) return named('change'), putChange(req, res, file, urlPath, config);
  if (req.method === 'POST' && isHtml) return postPage(req, res, file, urlPath, config, named);
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');

  if (await isDirectory(file)) {
    if (!urlPath.endsWith('/')) return named('redirect'), redirect(res, urlPath + '/');
    named('listing');
    return sendHtml(res, directoryListing(urlPath, await listDirectory(file)));
  }
  if (isHtml && wants(req) === 'json') {
    const query = queryOf(req.url);
    if (query.has('scope')) return named('scope'), getScope(res, file, urlPath, query.get('scope'), config);
    return named('state'), getState(res, file, urlPath, query.get('since'), config);
  }
  if (isHtml) return named('page'), getPage(res, file, urlPath, config);
  named('asset');
  sendFile(res, file, await readBytes(file));
}

// GET: format on disk (which assigns element IDs), then serve a copy with the threads lifted
// out into JSON: each element's directive, its open turn, and the settled turns of each thread
// that has a reply. Also the base of every element so the tab can send it back with a change,
// the markdown of every scope for the box to edit, and each scope's markdown at the last
// commit, for Revert. And the notices: what changed since you last saw it.
async function getPage(res, file, urlPath, { author, replies, telemetry, inTurn, live, seen, texts }) {
  const span = trace.getActiveSpan();
  const { formatted, document, notices } = await inTurn(file, async () => {
    const onDisk = await inSpan('read file', {}, () => readText(file));
    const normalized = inSpan('normalize', {}, () => normalize(onDisk));
    texts.keep(file, normalized);
    span?.setAttributes({ 'hrv.page': urlPath, 'hrv.page.bytes': onDisk.length, 'hrv.normalized': normalized !== onDisk });
    if (normalized !== onDisk) {
      await inSpan('write file', {}, () => writeText(file, normalized));
      live.wrote(file, normalized, 'format');
      console.log(`${urlPath} (normalized)`);
    }
    const parsed = inSpan('parse', {}, () => parse(normalized));
    return { formatted: normalized, document: parsed, notices: seen.notices(file, parsed) };
  });
  span?.setAttribute('hrv.notice.count', notices.length);
  const { directives, threads, bases } = tabStateOf(document, author, step);
  const markdowns = inSpan('markdowns', {}, () => markdownsOf(scopeElements(document)));
  const committed = await inSpan('committed', {}, async (child) => {
    const found = committedMarkdowns(await readCommitted(file), author);
    child.setAttribute('hrv.scope.count', Object.keys(found).length);
    return found;
  });
  const assets = await readClientAssets();
  const html = inSpan('serialize', {}, () => {
    injectClient(document, { directives, threads, bases, markdowns, committed, notices, replies, telemetry }, fingerprint(formatted), assets);
    return document.toString();
  });
  span?.setAttributes({
    'hrv.directive.count': Object.keys(directives).length,
    'hrv.thread.count': Object.keys(threads).length,
    'hrv.element.count': Object.keys(bases).length,
    'hrv.scope.count': Object.keys(markdowns).length,
    'hrv.answer.bytes': html.length,
  });
  sendHtml(res, html);
}

// GET with Accept: application/json, from a tab that heard the file changed: the page's state
// now, {"version", "directives", "threads", "bases", "notices"}, as GET would serve it. It writes
// nothing, so a file an agent is still writing isn't written back: the IDs it numbers are the
// ones the next write gives. version is the file on disk, the one the next PUT's "before" names.
// since: the version the tab shows. With it, the answer adds what the tab swaps in to show the
// page as it is now (domain/catch-up.mjs): "swaps", [{"id", "html"}], and "markdowns" for the
// scopes in and around them. A version the server no longer holds swaps the whole body.
async function getState(res, file, urlPath, since, { author, inTurn, seen, texts }) {
  const span = trace.getActiveSpan();
  const { onDisk, document, notices } = await inTurn(file, async () => {
    const text = await inSpan('read file', {}, () => readText(file));
    texts.keep(file, text);
    const parsed = readRevision(text, step);
    return { onDisk: text, document: parsed, notices: seen.notices(file, parsed) };
  });
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.page.bytes': onDisk.length, 'hrv.notice.count': notices.length });
  const state = { version: fingerprint(onDisk), ...tabStateOf(document, author, step), notices };
  if (since !== null) {
    const shown = since === state.version ? onDisk : texts.get(file, since);
    span?.setAttribute('hrv.since.known', shown !== null);
    const caught = inSpan('catch up', {}, (child) => {
      const found = catchUp(shown === null ? null : readRevision(shown), document, author);
      child.setAttribute('hrv.swap.count', found.swaps.length);
      return found;
    });
    Object.assign(state, caught);
  }
  const body = JSON.stringify(state);
  span?.setAttribute('hrv.answer.bytes', body.length);
  sendJson(res, 200, body);
}

// GET ?scope=<id> with Accept: application/json, from change.mjs read: the scope now, as the file
// holds it with IDs and without threads, and its version, {"ok": true, "id", "version", "html"}.
// An ID that isn't in the page is 404, {"ok": false, "error", "id"}. It writes nothing.
async function getScope(res, file, urlPath, id, { author, inTurn }) {
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.scope.id': id });
  const text = await inTurn(file, () => inSpan('read file', {}, () => readText(file)));
  span?.setAttribute('hrv.page.bytes', text.length);
  const scope = readScope(text, id, author, step);
  if (!scope) return sendJson(res, 404, { ok: false, error: `element ${id} is gone from the page`, id });
  sendJson(res, 200, { ok: true, ...scope });
}

// PUT: the body is one change to one element, with the base the tab started from:
//   {"id": "7", "base": "…", "directive": "text"}   sets the element's directive; "" removes it.
//     "replies": n, the replies the tab has seen on the element, makes it 412 if more came since
//     "ancestors": ["5", "2"], the element's ancestors nearest first: where it lands if it's gone
//   {"id": "7", "base": "…", "markdown": "…"}       replaces a scope with what its markdown says
//     "spill": ["8", "9"], the other elements the box's last save made, replaces them too
//   {"id": "7", "base": "…", "field": value}       writes an input, textarea, or select's value into the file
//     (domain/fields.mjs): true or false for a checkbox or radio, an array for a multiple select,
//     a string for the rest. A field save that changed the file prints an Announcement.
//   {"id": "7", "base": "…", "resolve": true}     Resolve: removes the element's thread; Done announces its turns
// A directive or markdown save carries "session", its box session, which Done names.
// The directive is the element's open turn: after a reply, setting it adds a turn to the thread.
// A directive is a turn, not a change to content: it lands whatever happened to the content.
// When its element is gone, it lands on the nearest ancestor the page holds, after the directive
// there, and the answer adds "id" (where it landed), "from", and "directive" (what it holds now).
// IDs come first, so elements an agent added since the last format have them. For a content
// change, a base that doesn't match the element now, or an ID that isn't there, is a conflict:
// 412, nothing written. So is a directive with nowhere to land.
// The answer carries the new bases of the element and the elements around it, and the file's
// fingerprint before and after, so the tab can notice an outside change. A markdown save also
// answers with the HTML that replaced the scope, as served and as the file reads back, the ID
// now holding the scope, the spill (the other elements it made, as when a typed <p> splits a
// paragraph), and the new markdown of the scopes around it.
//
// The agent's reply is a PUT too, from reply.mjs, with the thread's base instead of the element's:
//   {"id": "7", "thread": "…", "reply": "text"}      adds <!-- @Human: text --> to the thread
// And so is the agent's change, from change.mjs, with the scope's version (its base):
//   {"change": "replace", "id": "7", "version": "…", "html": "<p>…</p>"}
//   {"change": "add", "where": "after"|"before"|"into", "id": "7", "html": "…"}
//   {"change": "remove", "id": "7", "version": "…"}
//   {"change": "move", "id": "7", "where": "after"|"before"|"into", "to": "9"}
// Any of the four may add "because": "…", what the change is for, which its notice shows you.
// Every change to a file takes its turn, so a reply and a save never overwrite each other.
async function putChange(req, res, file, urlPath, config) {
  const change = await readJson(req);
  if (change && 'change' in change) {
    if (!agentChangeShaped(change)) {
      throw new HttpError(400, 'an agent change must look like {"change": "replace", "id", "version", "html"}, {"change": "add", "where", "id", "html"}, {"change": "remove", "id", "version"}, or {"change": "move", "id", "where", "to"}, where is after, before, or into; any may add "because", a string');
    }
    return config.inTurn(file, () => putAgentChange(res, file, urlPath, change, config));
  }
  if (change && 'reply' in change) {
    if (!config.replies) throw new HttpError(409, 'replies are off: start the server with --replies');
    const { id, thread, reply } = change;
    if (typeof id !== 'string' || typeof thread !== 'string' || typeof reply !== 'string' || !reply.trim() || Object.keys(change).length !== 3) {
      throw new HttpError(400, 'a reply must look like {"id": "<id>", "thread": "<thread base>", "reply": "text"}, with text');
    }
    return config.inTurn(file, () => putReply(res, file, urlPath, change, config));
  }
  const { id, base, directive, markdown, resolve, field, replies, spill, ancestors, session } = change ?? {};
  const kinds = [typeof directive === 'string' && 'directive', typeof markdown === 'string' && 'markdown', resolve === true && 'resolve', field !== undefined && 'field'].filter(Boolean);
  const ids = (list) => Array.isArray(list) && list.every((s) => typeof s === 'string' && s !== id);
  const repliesOk = replies === undefined || (kinds[0] === 'directive' && Number.isInteger(replies) && replies >= 0);
  const spillOk = spill === undefined || (kinds[0] === 'markdown' && ids(spill));
  const ancestorsOk = ancestors === undefined || (kinds[0] === 'directive' && ids(ancestors));
  const sessionOk = session === undefined || ((kinds[0] === 'directive' || kinds[0] === 'markdown') && typeof session === 'string' && session !== '');
  if (typeof id !== 'string' || typeof base !== 'string' || kinds.length !== 1 || !repliesOk || !spillOk || !ancestorsOk || !sessionOk) {
    throw new HttpError(400, 'body must look like {"id": "<id>", "base": "<base>", "directive": "text", "replies"?: <n>, "ancestors"?: ["<id>"], "session"?: "<box session>"}, or with "markdown": "…", "spill"?: ["<id>"], "session"?: "<box session>", "resolve": true, or "field": <value> instead');
  }
  return config.inTurn(file, () => applyChange(res, file, urlPath, change, kinds[0], config));
}

// Reply: the agent answers the element's thread. The thread base is the one the agent's
// Announcement carried; a turn added or resolved since makes it stale, and the answer is 412
// with the thread's directive and base now, so the agent can read the new turn and reply again.
// The answer to a reply that lands carries the new base, for a reply after it.
async function putReply(res, file, urlPath, change, { author, live, texts }) {
  const { id, reply } = change;
  const span = trace.getActiveSpan();
  span?.updateName('PUT reply');
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.change.kind': 'reply', 'hrv.scope.id': id, 'hrv.change.bytes': reply.length });
  const onDisk = await inSpan('read file', {}, () => readText(file));
  span?.setAttribute('hrv.page.bytes', onDisk.length);
  const revised = reviseThread(onDisk, change, author, step);
  if (revised.conflict) return sendConflict(res, urlPath, revised.conflict);
  await inSpan('write file', {}, () => writeText(file, revised.written));
  texts.keep(file, revised.written);
  live.wrote(file, revised.written, 'reply', id);
  span?.setAttribute('hrv.directive.count', revised.answer.count);
  sendJson(res, 200, revised.answer);
}

const AGENT_FIELDS = { replace: ['id', 'version', 'html'], add: ['where', 'id', 'html'], remove: ['id', 'version'], move: ['id', 'where', 'to'] };

// Any of them may carry "because": the agent's words for what the change is for.
function agentChangeShaped({ because, ...change }) {
  const fields = AGENT_FIELDS[change.change];
  if (!KINDS.includes(change.change) || !fields) return false;
  if (because !== undefined && typeof because !== 'string') return false;
  if (Object.keys(change).length !== fields.length + 1) return false;
  return fields.every((f) => typeof change[f] === 'string') && (!('where' in change) || WHERE.includes(change.where));
}

// The agent's change: the server makes it, in turn, or refuses it. A scope that moved past the
// version the agent named, or one that's gone, is 412, with what the scope holds now, so the
// agent can redo its change on top; HTML that can't go where it was sent is 400. Both are
// {"ok": false, "error", …} and write nothing. Landed: {"ok": true, "id", "version", "ids"}.
// The change isn't yours, so it stays a notice until you see it, and the notice carries the
// agent's "because".
async function putAgentChange(res, file, urlPath, { because, ...change }, { author, live, texts, seen }) {
  const span = trace.getActiveSpan();
  span?.updateName('PUT agent change');
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.change.kind': change.change, 'hrv.scope.id': change.id, 'hrv.change.bytes': (change.html ?? '').length });
  const onDisk = await inSpan('read file', {}, () => readText(file));
  span?.setAttribute('hrv.page.bytes', onDisk.length);
  const revised = reviseByAgent(onDisk, change, author, step);
  if (revised.conflict) return sendConflict(res, urlPath, revised.conflict);
  if (revised.refused) {
    span?.setAttribute('hrv.refused', revised.refused);
    return sendJson(res, 400, { ok: false, error: revised.refused });
  }
  await inSpan('write file', {}, () => writeText(file, revised.written));
  texts.keep(file, revised.written);
  seen.said(file, revised.answer.id, because);
  live.wrote(file, revised.written, 'agent', change.id);
  span?.setAttributes({ 'hrv.wrote': true, 'hrv.new.count': revised.answer.ids.length });
  sendJson(res, 200, revised.answer);
}

// A change to content (markdown, check) is yours, so you've seen it: the answer carries the
// notices after it. So does a directive you add or change: you've seen the mark on its element
// and on those around it.
// A save in a box session is a draft: the session keeps what it landed, for the next draft and
// for Done.
async function applyChange(res, file, urlPath, change, kind, { author, resolved, live, seen, texts, sessions }) {
  const { id, directive, markdown, spill = [], session } = change;
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.change.kind': kind, 'hrv.scope.id': id, 'hrv.change.bytes': (directive ?? markdown ?? '').length });
  if (session) span?.setAttribute('hrv.box.session', session);
  if (spill.length) span?.setAttribute('hrv.spill.count', spill.length);
  const onDisk = await inSpan('read file', {}, () => readText(file));
  span?.setAttribute('hrv.page.bytes', onDisk.length);
  const revised = revise(onDisk, change, kind, author, step, sessions.get(file, session).said);
  if (revised.conflict) return sendConflict(res, urlPath, revised.conflict);
  if (revised.refused) throw new HttpError(400, revised.refused);
  if (revised.answer.spill?.length) span?.setAttribute('hrv.spill.made', revised.answer.spill.length);
  if (revised.answer.from) span?.setAttributes({ 'hrv.moved.from': id, 'hrv.moved.to': revised.answer.id });
  span?.setAttribute('hrv.wrote', revised.wrote);
  texts.keep(file, onDisk);
  if (revised.wrote) {
    await inSpan('write file', {}, () => writeText(file, revised.written));
    texts.keep(file, revised.written);
    live.wrote(file, revised.written, kind, revised.answer.id ?? id);
  }
  resolved.note(file, id, revised.ended);
  const answer = answerOf(revised, author, step);
  if (kind === 'directive') sessions.said(file, session, landed(directive));
  if (kind === 'markdown') sessions.wrote(file, session, answer.id ?? id, revised.contentBefore, answer.markdowns?.[answer.id ?? id]);
  if (kind === 'field' && revised.wrote) {
    const announcement = inSpan('announcement', {}, () => fieldAnnouncementOf(revised.document, id, revised.fieldBefore, author));
    span?.setAttribute('hrv.announced', !!announcement);
    if (announcement) announce({ page: urlPath, ...announcement });
  }
  if (kind === 'markdown' || kind === 'field') {
    answer.notices = seen.saw(file, readRevision(onDisk, step), readRevision(revised.written, step), answer.id ?? id);
    span?.setAttribute('hrv.notice.count', answer.notices.length);
  }
  if (kind === 'directive' && directive.trim()) {
    answer.notices = seen.directed(file, readRevision(revised.written, step), answer.id ?? id);
    span?.setAttribute('hrv.notice.count', answer.notices.length);
  }
  const body = JSON.stringify(answer);
  span?.setAttributes({ 'hrv.directive.count': answer.count, 'hrv.answer.bytes': body.length });
  sendJson(res, 200, body);
}

// A conflict from domain/revision.mjs: 412, nothing written.
function sendConflict(res, urlPath, { why, error, log, now }) {
  trace.getActiveSpan()?.setAttribute('hrv.conflict', why);
  if (log) console.log(`${urlPath} — ${log}`);
  sendJson(res, 412, { ok: false, error, ...now });
}

// POST to a page: an ack, {"ack": …}, or Done.
async function postPage(req, res, file, urlPath, config, named) {
  const body = await readJson(req);
  if (body && typeof body === 'object' && 'ack' in body) return named('ack'), postAck(res, body, file, urlPath, config);
  named('done');
  return postDone(res, body, file, urlPath, config);
}

// POST ack: you've seen what changed in a scope, and its mark comes off.
//   {"ack": "7"}     the element with ID 7 and everything in it
//   {"ack": "all"}   the whole page
// It writes nothing to the file. The answer is the notices now, {"notices": [{"id", "kind"}]},
// and every open tab on the page hears them as a notices event.
async function postAck(res, body, file, urlPath, { inTurn, seen, live }) {
  const { ack: id } = body;
  if (typeof id !== 'string' || Object.keys(body).length !== 1) throw new HttpError(400, 'body must look like {"ack": "<id>"} or {"ack": "all"}');
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.scope.id': id });
  const notices = await inTurn(file, async () => {
    const document = readRevision(await inSpan('read file', {}, () => readText(file)), step);
    const now = inSpan('ack', {}, () => seen.acked(file, document, id));
    live.noticed(file, now);
    return now;
  });
  span?.setAttribute('hrv.notice.count', notices.length);
  sendJson(res, 200, { notices });
}

// POST: Done, the box closed, ending its box session:
//   {"id": "7", "session": "…", "directive": "text", "saw": "…", "ancestors": ["5", "2"]}
// directive is what the box opened with, saw the element's version as the tab showed it, and
// ancestors the element's, nearest first, for a directive that landed on one. Only id and
// directive are required. The tab sends it after the box's last change, so the server has
// every save of the session. What the session did goes out as an Announcement, with the turns
// a Resolve took; nothing done announces nothing. The answer says which: {"announced": true},
// for the tab's telemetry.
async function postDone(res, body, file, urlPath, { author, inTurn, resolved, sessions }) {
  const { id, directive, session, saw, ancestors = [] } = body ?? {};
  const optional = (value, ok) => value === undefined || ok(value);
  if (typeof id !== 'string' || typeof directive !== 'string' || !optional(session, (v) => typeof v === 'string') ||
      !optional(saw, (v) => typeof v === 'string') || !(Array.isArray(ancestors) && ancestors.every((a) => typeof a === 'string'))) {
    throw new HttpError(400, 'body must look like {"id": "<id>", "directive": "text", "session"?: "<box session>", "saw"?: "<version>", "ancestors"?: ["<id>"]}');
  }
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.scope.id': id });
  if (session) span?.setAttribute('hrv.box.session', session);
  // Read in turn, so the file holds every change that came in before Done.
  const [onDisk, ended, kept] = await inTurn(file, async () => [await inSpan('read file', {}, () => readText(file)), resolved.take(file, id), sessions.take(file, session)]);
  const document = inSpan('parse', {}, () => parse(onDisk));
  const announcement = inSpan('announcement', {}, () => announcementOf(document, id, { directive }, author, { resolved: ended, session: kept, saw, ancestors }));
  span?.setAttribute('hrv.announced', !!announcement);
  if (announcement) announce({ page: urlPath, ...announcement });
  sendJson(res, 200, { announced: !!announcement });
}

// Given a file instead of a directory: format it first, serve its directory, and announce
// the page's own URL. A file the formatter can't fix stops startup with the formatter's message.
async function main() {
  const config = parseArgs(process.argv.slice(2));
  let page = '';
  if (!(await isDirectory(config.root))) {
    const status = await formatFiles([config.root]);
    if (status !== 0) process.exit(status);
    page = encodeURIComponent(path.basename(config.root));
    config.root = path.dirname(config.root);
  }
  const stopTelemetry = await startTelemetry();
  if (stopTelemetry) {
    console.log(`html-revisor: telemetry on, to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318'}`);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => stopTelemetry().finally(() => process.exit(0)));
    }
  }
  const server = createServer({ ...config, telemetry: !!stopTelemetry });
  server.listen(config.port, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`html-revisor: http://localhost:${port}/${page} serving ${config.root}`);
  });
}

// Start only when run directly, not when imported by tests. This sits last so
// every constant above is initialized before main runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
