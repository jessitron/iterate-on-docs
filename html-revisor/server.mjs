// html-revisor: leave directives on HTML files; they live in the file as <!-- author: text -->.
//
// Tier I, orchestration: the CLI, request routing, and the GET, PUT, and Done flows. The domain
// is in domain/, the filesystem, HTTP, stdout, and telemetry in interface/.
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { formatFiles } from './formatter.mjs';
import { parse, serialize } from './domain/canonical.mjs';
import { ID, elementById } from './domain/identity.mjs';
import { normalize, assignIds } from './domain/format.mjs';
import { collectDirectives, removeDirectives, setDirective } from './domain/directives.mjs';
import { scopeElements, editable } from './domain/scopes.mjs';
import { fingerprint, baseOf, basesOf, around } from './domain/bases.mjs';
import { markdownsOf, committedMarkdowns, saveMarkdown, servedHTML, holderOf } from './domain/markdown-edits.mjs';
import { announcementOf } from './domain/announcements.mjs';
import { injectClient } from './domain/served-page.mjs';
import { readText, readBytes, writeText, listDirectory, isDirectory, readCommitted, readClientAssets } from './interface/files.mjs';
import {
  HttpError, decodeRequestPath, resolveUnderRoot, readJson, sendFile, sendHtml, sendJson, sendNoContent, redirect, sendError, directoryListing,
} from './interface/http.mjs';
import { announce } from './interface/stdout.mjs';
import { trace, inSpan, requestSpan, startTelemetry, recordBrowserSpans } from './interface/telemetry.mjs';

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
export function createServer({ root, author, telemetry = false }) {
  const config = { root: path.resolve(root), author, telemetry };
  return http.createServer((req, res) => {
    // Spans from the browser get no span of their own: one per batch would be noise.
    if (req.url === SPANS_PATH) return receiveSpans(req, res).catch((err) => sendError(res, err));
    requestSpan(req, res, (span) =>
      route(req, res, config).catch((err) => {
        span.recordException(err);
        sendError(res, err);
      }),
    );
  });
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
  if (isHtml) return named('page'), getPage(res, file, urlPath, config);
  named('asset');
  sendFile(res, file, await readBytes(file));
}

// GET: format on disk (which assigns element IDs), then serve a copy with directives lifted
// out into JSON, the base of every element so the tab can send it back with a change, and the
// markdown of every scope for the box to edit, and each scope's markdown at the last commit, for Revert.
async function getPage(res, file, urlPath, { author, telemetry }) {
  const span = trace.getActiveSpan();
  const onDisk = await inSpan('read file', {}, () => readText(file));
  const formatted = inSpan('normalize', {}, () => normalize(onDisk));
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.page.bytes': onDisk.length, 'hrv.normalized': formatted !== onDisk });
  if (formatted !== onDisk) {
    await inSpan('write file', {}, () => writeText(file, formatted));
    console.log(`${urlPath} (normalized)`);
  }
  const document = inSpan('parse', {}, () => parse(formatted));
  const directives = inSpan('directives', {}, () => {
    const found = collectDirectives(document, author);
    removeDirectives(document, author);
    return found;
  });
  const bases = inSpan('bases', {}, () => basesOf(document.querySelectorAll(`[${ID}]`), author));
  const markdowns = inSpan('markdowns', {}, () => markdownsOf(scopeElements(document)));
  const committed = await inSpan('committed', {}, async (child) => {
    const found = committedMarkdowns(await readCommitted(file), author);
    child.setAttribute('hrv.scope.count', Object.keys(found).length);
    return found;
  });
  const assets = await readClientAssets();
  const html = inSpan('serialize', {}, () => {
    injectClient(document, { directives, bases, markdowns, committed, telemetry }, fingerprint(formatted), assets);
    return document.toString();
  });
  span?.setAttributes({
    'hrv.directive.count': Object.keys(directives).length,
    'hrv.element.count': Object.keys(bases).length,
    'hrv.scope.count': Object.keys(markdowns).length,
    'hrv.answer.bytes': html.length,
  });
  sendHtml(res, html);
}

// PUT: the body is one change to one element, with the base the tab started from:
//   {"id": "7", "base": "…", "directive": "text"}   sets the element's directive; "" removes it
//   {"id": "7", "base": "…", "markdown": "…"}       replaces a scope with what its markdown says
// IDs come first, so elements an agent added since the last format have them. A base that
// doesn't match the element now, or an ID that isn't there, is a conflict: 412, nothing written.
// The answer carries the new bases of the element and the elements around it, and the file's
// fingerprint before and after, so the tab can notice an outside change. A markdown save also
// answers with the HTML that replaced the scope, as served, the ID now holding the scope, and
// the new markdown of the scopes around it.
async function putChange(req, res, file, urlPath, { author }) {
  const change = await readJson(req);
  const { id, base, directive, markdown } = change ?? {};
  if (typeof id !== 'string' || typeof base !== 'string' || (typeof directive === 'string') === (typeof markdown === 'string')) {
    throw new HttpError(400, 'body must look like {"id": "<id>", "base": "<base>", "directive": "text"} or {"id", "base", "markdown"}');
  }
  const kind = typeof directive === 'string' ? 'directive' : 'markdown';
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.change.kind': kind, 'hrv.scope.id': id, 'hrv.change.bytes': (directive ?? markdown).length });
  const onDisk = await inSpan('read file', {}, () => readText(file));
  span?.setAttribute('hrv.page.bytes', onDisk.length);
  const document = inSpan('parse', {}, () => {
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
  let changed, answer = {};
  if (kind === 'directive') {
    inSpan('set directive', {}, () => setDirective(el, directive, author));
    changed = around([el]);
  } else {
    const nodes = inSpan('set markdown', {}, () => saveMarkdown(el, markdown));
    if (!nodes) throw new HttpError(400, 'markdown edits need a scope under 4 KB and non-blank markdown');
    changed = around(nodes.filter((n) => n.nodeType === 1));
    answer = inSpan('served html', {}, () => ({ html: servedHTML(nodes, author), id: holderOf(nodes, id, new Set(scopeElements(document))) }));
  }
  const written = inSpan('serialize', {}, () => serialize(document));
  if (written !== onDisk) await inSpan('write file', {}, () => writeText(file, written));
  const count = Object.keys(collectDirectives(document, author)).length;
  // Bases and markdown as a reload would serve them: from the file in canonical layout.
  const served = inSpan('reparse', {}, () => {
    const doc = parse(written);
    removeDirectives(doc, author);
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
// changed goes out as an Announcement; nothing changed announces nothing. The answer says which:
// {"announced": true}, for the tab's telemetry.
async function postDone(req, res, file, urlPath, { author }) {
  const opened = await readJson(req);
  const { id, directive, markdown } = opened ?? {};
  if (typeof id !== 'string' || typeof directive !== 'string' || (markdown !== undefined && typeof markdown !== 'string')) {
    throw new HttpError(400, 'body must look like {"id": "<id>", "directive": "text", "markdown": "…"}, markdown only for a scope');
  }
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.scope.id': id });
  const onDisk = await inSpan('read file', {}, () => readText(file));
  const document = inSpan('parse', {}, () => parse(onDisk));
  const announcement = inSpan('announcement', {}, () => announcementOf(document, id, { directive, markdown }, author));
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
