// html-revisor: leave directives on HTML files; they live in the file as <!-- author: text -->.
//
// Tier I, orchestration: the CLI, request routing, and the GET, PUT, and Done flows. The domain
// is in domain/, the filesystem, HTTP, stdout, and telemetry in interface/.
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { formatFiles } from './formatter.mjs';
import { parse, serialize } from './domain/canonical.mjs';
import { ID, elementById, assignIds } from './domain/identity.mjs';
import { normalize } from './domain/format.mjs';
import { collectDirectives, threadOf, threadsOf, removeThreads, removeThread, setDirective, placeReply, replyCount } from './domain/directives.mjs';
import { scopeElements, editable } from './domain/scopes.mjs';
import { fingerprint, baseOf, basesOf, threadBaseOf, around } from './domain/bases.mjs';
import { markdownsOf, committedMarkdowns, saveMarkdown, spillOf, settle, spillIds, servedHTML, holderOf } from './domain/markdown-edits.mjs';
import { announcementOf } from './domain/announcements.mjs';
import { injectClient, tabStateOf } from './domain/served-page.mjs';
import { readText, readBytes, writeText, listDirectory, isDirectory, readCommitted, readClientAssets, watchFile } from './interface/files.mjs';
import {
  HttpError, decodeRequestPath, resolveUnderRoot, readJson, sendFile, sendHtml, sendJson, sendNoContent, redirect, sendError, directoryListing,
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
    else if (!flag.startsWith('--')) config.root = path.resolve(argv[i]);
    else throw new Error(`unknown option ${flag}`);
  }
  return config;
}

// telemetry: the server sends spans, so the page's client records its own and posts them here.
// Closing the server ends every tab's event stream and stops watching files, so close() returns.
export function createServer({ root, author, telemetry = false }) {
  const inTurn = oneAtATime();
  const config = { root: path.resolve(root), author, telemetry, inTurn, resolved: resolvedTurns(), live: liveNotices(inTurn) };
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

// Live notice: each open tab keeps an event stream to its page and hears of every change to
// the file, so it catches up without saving first. A change the server makes (a save from any
// tab, a reply, GET's format) goes out as the server writes it, with what it was and the
// element. A write that goes around the server, such as an agent's edit, the server finds by
// watching the file. Every notice carries the file's version after the change, its fingerprint,
// so a tab that already holds that version, the one whose save it was, ignores it.
//   event: change
//   data: {"version": "<fingerprint>", "cause": "directive"|"markdown"|"resolve"|"reply"|"format"|"disk"|"connect", "id"?: "<id>"}
// "connect" is the first event on each stream: the version now, for a tab that loaded an
// older one or reconnects after a restart.
function liveNotices(inTurn) {
  const pages = new Map();  // file -> {streams, known: the version the server last wrote or told, stop}
  const tell = (page, notice) => page.streams.forEach((stream) => stream.send('change', notice));

  // The watcher reads in turn, so it never sees a write of the server's half done. A version the
  // server already told is its own write, not news.
  function watch(file, page) {
    return watchFile(file, () => inTurn(file, async () => {
      const text = await readText(file).catch(() => null);
      if (text === null) return;  // gone for now: an editor's rename comes back as a second event
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
  if (req.method === 'POST' && isHtml) return named('done'), postDone(req, res, file, urlPath, config);
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');

  if (await isDirectory(file)) {
    if (!urlPath.endsWith('/')) return named('redirect'), redirect(res, urlPath + '/');
    named('listing');
    return sendHtml(res, directoryListing(urlPath, await listDirectory(file)));
  }
  if (isHtml && wants(req) === 'json') return named('state'), getState(res, file, urlPath, config);
  if (isHtml) return named('page'), getPage(res, file, urlPath, config);
  named('asset');
  sendFile(res, file, await readBytes(file));
}

// GET: format on disk (which assigns element IDs), then serve a copy with the threads lifted
// out into JSON: each element's directive, its open turn, and the settled turns of each thread
// that has a reply. Also the base of every element so the tab can send it back with a change,
// the markdown of every scope for the box to edit, and each scope's markdown at the last
// commit, for Revert.
async function getPage(res, file, urlPath, { author, telemetry, inTurn, live }) {
  const span = trace.getActiveSpan();
  const formatted = await inTurn(file, async () => {
    const onDisk = await inSpan('read file', {}, () => readText(file));
    const normalized = inSpan('normalize', {}, () => normalize(onDisk));
    span?.setAttributes({ 'hrv.page': urlPath, 'hrv.page.bytes': onDisk.length, 'hrv.normalized': normalized !== onDisk });
    if (normalized !== onDisk) {
      await inSpan('write file', {}, () => writeText(file, normalized));
      live.wrote(file, normalized, 'format');
      console.log(`${urlPath} (normalized)`);
    }
    return normalized;
  });
  const document = inSpan('parse', {}, () => parse(formatted));
  const { directives, threads, bases } = tabStateOf(document, author, step);
  const markdowns = inSpan('markdowns', {}, () => markdownsOf(scopeElements(document)));
  const committed = await inSpan('committed', {}, async (child) => {
    const found = committedMarkdowns(await readCommitted(file), author);
    child.setAttribute('hrv.scope.count', Object.keys(found).length);
    return found;
  });
  const assets = await readClientAssets();
  const html = inSpan('serialize', {}, () => {
    injectClient(document, { directives, threads, bases, markdowns, committed, telemetry }, fingerprint(formatted), assets);
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
// now, {"version", "directives", "threads", "bases"}, as GET would serve it. It writes nothing,
// so a file an agent is still writing isn't written back: the IDs it numbers are the ones the
// next write gives. version is the file on disk, the one the next PUT's "before" names.
async function getState(res, file, urlPath, { author, inTurn }) {
  const span = trace.getActiveSpan();
  const onDisk = await inTurn(file, () => inSpan('read file', {}, () => readText(file)));
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.page.bytes': onDisk.length });
  const document = inSpan('parse', {}, () => {
    const doc = parse(onDisk);
    assignIds(doc);
    return doc;
  });
  const body = JSON.stringify({ version: fingerprint(onDisk), ...tabStateOf(document, author, step) });
  span?.setAttribute('hrv.answer.bytes', body.length);
  sendJson(res, 200, body);
}

// PUT: the body is one change to one element, with the base the tab started from:
//   {"id": "7", "base": "…", "directive": "text"}   sets the element's directive; "" removes it.
//     "replies": n, the replies the tab has seen on the element, makes it 412 if more came since
//   {"id": "7", "base": "…", "markdown": "…"}       replaces a scope with what its markdown says
//     "spill": ["8", "9"], the other elements the box's last save made, replaces them too
//   {"id": "7", "base": "…", "resolve": true}     Resolve: removes the element's thread; Done announces its turns
// The directive is the element's open turn: after a reply, setting it adds a turn to the thread.
// IDs come first, so elements an agent added since the last format have them. A base that
// doesn't match the element now, or an ID that isn't there, is a conflict: 412, nothing written.
// The answer carries the new bases of the element and the elements around it, and the file's
// fingerprint before and after, so the tab can notice an outside change. A markdown save also
// answers with the HTML that replaced the scope, as served and as the file reads back, the ID
// now holding the scope, the spill (the other elements it made, as when a typed <p> splits a
// paragraph), and the new markdown of the scopes around it.
//
// The agent's reply is a PUT too, from reply.mjs, with the thread's base instead of the element's:
//   {"id": "7", "thread": "…", "reply": "text"}      adds <!-- @Human: text --> to the thread
// Every change to a file takes its turn, so a reply and a save never overwrite each other.
async function putChange(req, res, file, urlPath, config) {
  const change = await readJson(req);
  if (change && 'reply' in change) {
    const { id, thread, reply } = change;
    if (typeof id !== 'string' || typeof thread !== 'string' || typeof reply !== 'string' || !reply.trim() || Object.keys(change).length !== 3) {
      throw new HttpError(400, 'a reply must look like {"id": "<id>", "thread": "<thread base>", "reply": "text"}, with text');
    }
    return config.inTurn(file, () => putReply(res, file, urlPath, change, config));
  }
  const { id, base, directive, markdown, resolve, replies, spill } = change ?? {};
  const kinds = [typeof directive === 'string' && 'directive', typeof markdown === 'string' && 'markdown', resolve === true && 'resolve'].filter(Boolean);
  const repliesOk = replies === undefined || (kinds[0] === 'directive' && Number.isInteger(replies) && replies >= 0);
  const spillOk = spill === undefined || (kinds[0] === 'markdown' && Array.isArray(spill) && spill.every((s) => typeof s === 'string' && s !== id));
  if (typeof id !== 'string' || typeof base !== 'string' || kinds.length !== 1 || !repliesOk || !spillOk) {
    throw new HttpError(400, 'body must look like {"id": "<id>", "base": "<base>", "directive": "text", "replies"?: <n>}, or with "markdown": "…", "spill"?: ["<id>"], or "resolve": true instead');
  }
  return config.inTurn(file, () => applyChange(res, file, urlPath, change, kinds[0], config));
}

// Reply: the agent answers the element's thread. The thread base is the one the agent's
// Announcement carried; a turn added or resolved since makes it stale, and the answer is 412
// with the thread's directive and base now, so the agent can read the new turn and reply again.
// The answer to a reply that lands carries the new base, for a reply after it.
async function putReply(res, file, urlPath, { id, thread, reply }, { author, live }) {
  const span = trace.getActiveSpan();
  span?.updateName('PUT reply');
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.change.kind': 'reply', 'hrv.scope.id': id, 'hrv.change.bytes': reply.length });
  const onDisk = await inSpan('read file', {}, () => readText(file));
  span?.setAttribute('hrv.page.bytes', onDisk.length);
  const document = inSpan('parse', {}, () => {
    const doc = parse(onDisk);
    assignIds(doc);
    return doc;
  });
  const el = elementById(document, id);
  const turns = el ? threadOf(el, author) : [];
  const now = el && inSpan('check thread', {}, () => threadBaseOf(el, author));
  if (!turns.length || now !== thread) {
    const why = !el ? 'that element is gone from the file' : !turns.length ? 'that element has no directive to reply to' : 'its thread changed since';
    span?.setAttribute('hrv.conflict', why);
    console.log(`${urlPath} — stale reply on element ${id} (${why})`);
    const current = turns.length ? { directive: collectDirectives(document, author)[id] ?? '', thread: now } : {};
    return sendJson(res, 412, { ok: false, error: why, ...current });
  }
  inSpan('place reply', {}, () => placeReply(el, reply, author));
  const written = inSpan('serialize', {}, () => serialize(document));
  await inSpan('write file', {}, () => writeText(file, written));
  live.wrote(file, written, 'reply', id);
  const reread = elementById(parse(written), id);
  const count = Object.keys(collectDirectives(document, author)).length;
  span?.setAttribute('hrv.directive.count', count);
  sendJson(res, 200, { ok: true, count, thread: threadBaseOf(reread, author), before: fingerprint(onDisk), after: fingerprint(written) });
}

async function applyChange(res, file, urlPath, { id, base, directive, markdown, replies, spill = [] }, kind, { author, resolved, live }) {
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.change.kind': kind, 'hrv.scope.id': id, 'hrv.change.bytes': (directive ?? markdown ?? '').length });
  if (spill.length) span?.setAttribute('hrv.spill.count', spill.length);
  const onDisk = await inSpan('read file', {}, () => readText(file));
  span?.setAttribute('hrv.page.bytes', onDisk.length);
  let document = inSpan('parse', {}, () => {
    const doc = parse(onDisk);
    assignIds(doc);
    return doc;
  });
  const el = elementById(document, id);
  if (!el || inSpan('check base', {}, () => baseOf(el, author)) !== base) {
    span?.setAttribute('hrv.conflict', el ? 'changed on disk' : 'no such element');
    console.log(`${urlPath} — conflict on element ${id} (${el ? 'it changed on disk' : 'no such element'})`);
    return sendJson(res, 412, { ok: false, error: el ? 'that element changed on disk' : 'that element is gone from the file' });
  }
  const spilled = spillOf(el, spill);
  if (!spilled) {
    span?.setAttribute('hrv.conflict', 'spill moved');
    console.log(`${urlPath} — conflict on element ${id} (what its last save made changed on disk)`);
    return sendJson(res, 412, { ok: false, error: 'what the last save made changed on disk' });
  }
  // A turn typed before a reply came in: the tab catches up and sends what's left after the reply.
  const repliesNow = kind === 'directive' && replies !== undefined ? replyCount(el, author) : replies;
  if (repliesNow !== replies) {
    span?.setAttribute('hrv.conflict', 'replied since');
    return sendJson(res, 412, { ok: false, error: 'a reply came in on that thread', replies: repliesNow });
  }
  let changed, answer = {}, ended = [];
  if (kind === 'directive') {
    inSpan('set directive', {}, () => setDirective(el, directive, author));
    changed = around([el]);
  } else if (kind === 'resolve') {
    ended = threadOf(el, author);
    inSpan('resolve', {}, () => removeThread(el, author));
    changed = around([el]);
  } else {
    const saved = inSpan('set markdown', {}, () => saveMarkdown(el, markdown, spilled));
    if (!saved) throw new HttpError(400, 'markdown edits need a scope under 4 KB and non-blank markdown');
    const settled = inSpan('settle', {}, () => settle(document, saved));
    document = settled.document;
    const { nodes } = settled;
    changed = around(nodes.filter((n) => n.nodeType === 1));
    answer = inSpan('served html', {}, () => {
      const holder = holderOf(nodes, id, new Set(scopeElements(document)));
      return { html: servedHTML(nodes, author), id: holder, spill: spillIds(nodes, holder) };
    });
    if (answer.spill.length) span?.setAttribute('hrv.spill.made', answer.spill.length);
  }
  const written = inSpan('serialize', {}, () => serialize(document));
  // A save the canonical file can't tell from what it holds writes nothing: a directive
  // differing only in edge whitespace (it's trimmed), markdown differing only in a trailing space.
  span?.setAttribute('hrv.wrote', written !== onDisk);
  if (written !== onDisk) {
    await inSpan('write file', {}, () => writeText(file, written));
    live.wrote(file, written, kind, id);
  }
  resolved.note(file, id, ended);
  const count = Object.keys(collectDirectives(document, author)).length;
  // Bases and markdown as a reload would serve them: from the file in canonical layout.
  const served = inSpan('reparse', {}, () => {
    const doc = parse(written);
    removeThreads(doc, author);
    return doc;
  });
  const now = changed.map((e) => elementById(served, e.getAttribute(ID))).filter(Boolean);
  answer.bases = inSpan('bases', { 'hrv.element.count': now.length }, () => basesOf(now, author));
  if (kind === 'markdown') {
    answer.markdowns = inSpan('markdowns', {}, (child) => {
      const scopes = new Set(scopeElements(served));
      const mine = now.filter((e) => scopes.has(e));
      child.setAttribute('hrv.scope.count', mine.length);
      // A scope the save grew past the limit loses its Content field: null tells the tab.
      const grown = mine.filter((e) => e.hasAttribute(ID) && e.localName !== 'body' && !editable(e));
      return { ...Object.fromEntries(grown.map((e) => [e.getAttribute(ID), null])), ...markdownsOf(mine) };
    });
  }
  const body = JSON.stringify({ ok: true, count, ...answer, before: fingerprint(onDisk), after: fingerprint(written) });
  span?.setAttributes({ 'hrv.directive.count': count, 'hrv.answer.bytes': body.length });
  sendJson(res, 200, body);
}

// POST: Done, the box closed. The body is what the box opened with:
//   {"id": "7", "directive": "text", "markdown": "…"}   markdown only for a scope
// The tab sends it after the box's last change, so the file holds what the box left. What
// changed goes out as an Announcement, with the turns a Resolve took; nothing changed announces
// nothing. The answer says which: {"announced": true}, for the tab's telemetry.
async function postDone(req, res, file, urlPath, { author, inTurn, resolved }) {
  const opened = await readJson(req);
  const { id, directive, markdown } = opened ?? {};
  if (typeof id !== 'string' || typeof directive !== 'string' || (markdown !== undefined && typeof markdown !== 'string')) {
    throw new HttpError(400, 'body must look like {"id": "<id>", "directive": "text", "markdown": "…"}, markdown only for a scope');
  }
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.scope.id': id });
  // Read in turn, so the file holds every change that came in before Done.
  const [onDisk, ended] = await inTurn(file, async () => [await inSpan('read file', {}, () => readText(file)), resolved.take(file, id)]);
  const document = inSpan('parse', {}, () => parse(onDisk));
  const announcement = inSpan('announcement', {}, () => announcementOf(document, id, { directive, markdown }, author, ended));
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
