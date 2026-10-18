// html-revisor: leave directives on HTML files; they live in the file as <!-- author: text -->.
//
// Three tiers, dependencies point downward only:
//   Tier I   orchestration: CLI, request routing, the GET, PUT, and Done flows
//   Tier II  domain: markdown edits, element identity, Announcements (pure functions over a DOM);
//            directives.mjs, formatter.mjs, and scopes.mjs are Tier II too
//   Tier III interface: filesystem gateway, content types, listings, client assets, stdout;
//            telemetry.mjs is Tier III too
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatFiles, parse, normalize, serialize, assignIds, formatElement, ID, trimAscii, escapeText } from './formatter.mjs';
import { collectDirectives, removeDirectives, setDirective, escapeDirectiveText } from './directives.mjs';
import { scopeElements, scopeMarkdown, scopeFromMarkdown, editable } from './scopes.mjs';
import { trace, inSpan, requestSpan, startTelemetry, recordBrowserSpans } from './telemetry.mjs';

// ======================================================================
// Tier I: orchestration
// ======================================================================

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
  let spans;
  try {
    spans = JSON.parse(await readBody(req));
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  recordBrowserSpans(spans);
  res.writeHead(204);
  res.end();
}

async function route(req, res, config) {
  const urlPath = decodeRequestPath(req.url);
  const file = resolveUnderRoot(config.root, urlPath);
  const isHtml = /\.html?$/i.test(urlPath);
  const named = (what) => trace.getActiveSpan()?.updateName(`${req.method} ${what}`);

  if (req.method === 'PUT' && isHtml) return named('change'), putChange(req, res, file, urlPath, config);
  if (req.method === 'POST' && isHtml) return named('done'), postDone(req, res, file, urlPath, config);
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');

  const stat = await fs.stat(file);
  if (stat.isDirectory()) {
    if (!urlPath.endsWith('/')) return named('redirect'), redirect(res, urlPath + '/');
    named('listing');
    return sendHtml(res, directoryListing(urlPath, await fs.readdir(file, { withFileTypes: true })));
  }
  if (isHtml) return named('page'), getPage(res, file, urlPath, config);
  named('asset');
  res.writeHead(200, { 'Content-Type': contentTypeFor(file) });
  res.end(await fs.readFile(file));
}

// GET: format on disk (which assigns element IDs), then serve a copy with directives lifted
// out into JSON, the base of every element so the tab can send it back with a change, and the
// markdown of every scope for the box to edit, and each scope's markdown at the last commit, for Revert.
async function getPage(res, file, urlPath, { author, telemetry }) {
  const span = trace.getActiveSpan();
  const onDisk = await inSpan('read file', {}, () => fs.readFile(file, 'utf8'));
  const formatted = inSpan('normalize', {}, () => normalize(onDisk));
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.page.bytes': onDisk.length, 'hrv.normalized': formatted !== onDisk });
  if (formatted !== onDisk) {
    await inSpan('write file', {}, () => fs.writeFile(file, formatted));
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
    injectClient(document, { directives, bases, markdowns, committed, telemetry }, versionOf(formatted), assets);
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

// A short fingerprint. Of the file bytes, it lets the tab notice that the page changed on disk.
const versionOf = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12);

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
  let change;
  try {
    change = JSON.parse(await readBody(req));
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  const { id, base, directive, markdown } = change ?? {};
  if (typeof id !== 'string' || typeof base !== 'string' || (typeof directive === 'string') === (typeof markdown === 'string')) {
    throw new HttpError(400, 'body must look like {"id": "<id>", "base": "<base>", "directive": "text"} or {"id", "base", "markdown"}');
  }
  const kind = typeof directive === 'string' ? 'directive' : 'markdown';
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.change.kind': kind, 'hrv.scope.id': id, 'hrv.change.bytes': (directive ?? markdown).length });
  const onDisk = await inSpan('read file', {}, () => fs.readFile(file, 'utf8'));
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
    res.writeHead(412, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: el ? 'that element changed on disk' : 'that element is gone from the file' }));
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
  if (written !== onDisk) await inSpan('write file', {}, () => fs.writeFile(file, written));
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
  const body = JSON.stringify({ ok: true, count, ...answer, before: versionOf(onDisk), after: versionOf(written) });
  span?.setAttributes({ 'hrv.directive.count': count, 'hrv.answer.bytes': body.length });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

// POST: Done, the box closed. The body is what the box opened with:
//   {"id": "7", "directive": "text", "markdown": "…"}   markdown only for a scope
// The tab sends it after the box's last change, so the file holds what the box left. What
// changed goes out as an Announcement; nothing changed announces nothing. The answer says which:
// {"announced": true}, for the tab's telemetry.
async function postDone(req, res, file, urlPath, { author }) {
  let opened;
  try {
    opened = JSON.parse(await readBody(req));
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  const { id, directive, markdown } = opened ?? {};
  if (typeof id !== 'string' || typeof directive !== 'string' || (markdown !== undefined && typeof markdown !== 'string')) {
    throw new HttpError(400, 'body must look like {"id": "<id>", "directive": "text", "markdown": "…"}, markdown only for a scope');
  }
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'hrv.page': urlPath, 'hrv.scope.id': id });
  const onDisk = await inSpan('read file', {}, () => fs.readFile(file, 'utf8'));
  const document = inSpan('parse', {}, () => parse(onDisk));
  const announcement = inSpan('announcement', {}, () => announcementOf(document, id, { directive, markdown }, author));
  span?.setAttribute('hrv.announced', !!announcement);
  if (announcement) announce({ page: urlPath, ...announcement });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ announced: !!announcement }));
}

function sendError(res, err) {
  const status = err.status ?? (err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 404 : 500);
  if (status === 500) console.error(err.stack ?? err);
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(status === 404 ? 'not found' : String(err.message ?? err));
}

// Given a file instead of a directory: format it first, serve its directory, and announce
// the page's own URL. A file the formatter can't fix stops startup with the formatter's message.
async function main() {
  const config = parseArgs(process.argv.slice(2));
  let page = '';
  if (!(await fs.stat(config.root).catch(() => null))?.isDirectory()) {
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

// ======================================================================
// Tier II: domain
// ======================================================================

// ---- Element identity ---------------------------------------------------

// The formatter writes IDs into the file (assignIds). Here: find an element by ID, and the
// base of an element, the fingerprint of its content that a change has to start from.

export function elementById(document, id) {
  return /^\d+$/.test(id) ? document.querySelector(`[${ID}="${id}"]`) : null;
}

// The element, its content, and its own attributes, minus directives and IDs, in canonical
// layout. Directives and IDs coming and going change no base; a changed child changes its
// parent's.
export function baseOf(el, author) {
  const copy = el.cloneNode(true);
  removeDirectives(copy, author);
  copy.removeAttribute(ID);
  copy.querySelectorAll(`[${ID}]`).forEach((e) => e.removeAttribute(ID));
  return versionOf(formatElement(copy));
}

export function basesOf(elements, author) {
  return Object.fromEntries([...elements].map((el) => [el.getAttribute(ID), baseOf(el, author)]));
}

// The elements whose base an edit to these can change: each one, the IDs inside it, and its
// ancestors.
function around(els) {
  const out = new Set();
  for (const el of els) {
    el.querySelectorAll(`[${ID}]`).forEach((e) => out.add(e));
    for (let a = el; a?.nodeType === 1; a = a.parentNode) if (a.hasAttribute(ID)) out.add(a);
  }
  return [...out];
}

// ---- Markdown edits -----------------------------------------------------

// Each scope's markdown, by ID: what the box shows. Not body's, which nobody picks, and not a
// scope too big to edit.
export function markdownsOf(scopes) {
  return Object.fromEntries(
    scopes.filter((el) => el.hasAttribute(ID) && el.localName !== 'body' && editable(el)).map((el) => [el.getAttribute(ID), scopeMarkdown(el)]),
  );
}

// Each scope's markdown in the committed copy of the page, by ID: what Revert puts back. A
// commit made mid-loop holds IDs; one committed clean gets them from normalize, which numbers a
// page the same way every time, so they match the page as first opened if it hasn't changed
// since. No commit, or a copy the formatter can't handle, gives none.
export function committedMarkdowns(html, author) {
  if (html === null) return {};
  try {
    const document = parse(normalize(html));
    removeDirectives(document, author);
    return markdownsOf(scopeElements(document));
  } catch {
    return {};
  }
}

// Replace a scope with what its markdown says. The elements you left or changed keep their IDs
// and directives (scopes.mjs reconciles); new ones get IDs. Returns the nodes that replaced it,
// or null, changing nothing, for an element that isn't a scope, one too big to edit, or blank markdown.
export function saveMarkdown(el, markdown) {
  const document = el.ownerDocument;
  if (trimAscii(markdown) === '' || el.localName === 'body' || !editable(el) || !scopeElements(document).includes(el)) return null;
  const nodes = scopeFromMarkdown(el, markdown);
  el.replaceWith(...nodes);
  assignIds(document);
  return nodes;
}

// The nodes as the tab shows them: directives lifted out.
export function servedHTML(nodes, author) {
  const holder = nodes[0].ownerDocument.createElement('div');
  holder.append(...nodes.map((n) => n.cloneNode(true)));
  removeDirectives(holder, author);
  return holder.innerHTML;
}

// The ID that holds the scope after a save: its own, if its element came back, else the first
// new scope's, so the box can follow it. Null when the scope became bare text.
function holderOf(nodes, id, scopes) {
  const els = nodes.filter((n) => n.nodeType === 1);
  const holder = els.find((e) => e.getAttribute(ID) === id) ?? els.find((e) => scopes.has(e) && e.hasAttribute(ID));
  return holder?.getAttribute(ID) ?? null;
}

// ---- Announcements ------------------------------------------------------

// What one box session changed on its element, from what the box opened with to the document
// now: the directive, and for a scope its content, a revision. Each is {before, after}, and only
// there if it changed. Null when nothing changed or the element is gone. Lifts the directives
// out of the document.
export function announcementOf(document, id, opened, author) {
  const el = elementById(document, id);
  if (!el) return null;
  const announcement = { id, element: el.localName, heading: headingOf(el) };
  // Compare as the file holds it: trimmed, escaped.
  const directiveBefore = escapeDirectiveText(opened.directive.trim());
  const directiveAfter = collectDirectives(document, author)[id] ?? '';
  if (directiveAfter !== directiveBefore) announcement.directive = { before: directiveBefore, after: directiveAfter };
  removeDirectives(document, author);
  if (typeof opened.markdown === 'string' && editable(el) && scopeElements(document).includes(el)) {
    const markdown = scopeMarkdown(el);
    if (markdown !== opened.markdown) announcement.revision = { before: opened.markdown, after: markdown };
  }
  return announcement.directive || announcement.revision ? announcement : null;
}

// The text of the heading the element sits under: itself, or the last h1-h6 before it. Null
// when there is none.
function headingOf(el) {
  let heading = null;
  for (const e of el.ownerDocument.querySelectorAll(`h1, h2, h3, h4, h5, h6, [${ID}="${el.getAttribute(ID)}"]`)) {
    if (e === el) break;
    heading = e;
  }
  if (/^h[1-6]$/.test(el.localName)) heading = el;
  return heading ? trimAscii(heading.textContent.replace(/[ \t\n\r\f]+/g, ' ')) : null;
}

// ======================================================================
// Tier III: interface (filesystem gateway, HTTP helpers, client assets)
// ======================================================================

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The raw request path, percent-decoded. Done by hand because URL parsing
// would quietly resolve ".." before we can reject it.
function decodeRequestPath(rawUrl) {
  const raw = rawUrl.split(/[?#]/)[0];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes('\0')) throw new Error('null byte');
    return decoded;
  } catch {
    throw new HttpError(400, 'bad request path');
  }
}

export function resolveUnderRoot(root, urlPath) {
  const resolved = path.resolve(root, '.' + path.posix.sep + urlPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HttpError(403, 'forbidden');
  }
  return resolved;
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};
const contentTypeFor = (file) =>
  CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-store' });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(301, { Location: encodeURI(location) });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const escapeHtml = (s) => escapeText(s).replace(/"/g, '&quot;');

function directoryListing(urlPath, entries) {
  const visible = entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => b.isDirectory() - a.isDirectory() || a.name.localeCompare(b.name));
  const items = visible.map((e) => {
    const name = e.isDirectory() ? e.name + '/' : e.name;
    return `<li><a href="${escapeHtml(encodeURIComponent(e.name))}${e.isDirectory() ? '/' : ''}">${escapeHtml(name)}</a></li>`;
  });
  const up = urlPath === '/' ? '' : '<li><a href="../">../</a></li>';
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(urlPath)}</title></head>\n<body><h1>${escapeHtml(urlPath)}</h1>\n<ul>${up}${items.join('\n')}</ul></body></html>\n`;
}

// The file as of the last commit, or null when it isn't in a git repository or isn't committed.
export function readCommitted(file) {
  return new Promise((resolve) => {
    execFile('git', ['show', `HEAD:./${path.basename(file)}`], { cwd: path.dirname(file), maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

// Announcements go to stdout, one line of JSON each, for an agent watching the output.
function announce(announcement) {
  console.log(JSON.stringify(announcement));
}

// Client assets. Appended to the served copy, never written to the file, so none of it has an ID.
// Read on each GET, so a change to client.css or client.js shows on reload without a restart.
const readAsset = (name) => fs.readFile(new URL(name, import.meta.url), 'utf8');
export async function readClientAssets() {
  const [css, js] = await Promise.all([readAsset('client.css'), readAsset('client.js')]);
  return { css, js };
}

// directives: {id: text}. bases: {id: base}, sent back with each change. markdowns: {id: markdown}.
// committed: {id: markdown} at the last commit.
// telemetry: the client records spans for its saves.
export function injectClient(document, { directives, bases, markdowns = {}, committed = {}, telemetry = false }, version, { css, js }) {
  const head = document.querySelector('head') ?? document.documentElement;
  const body = document.querySelector('body') ?? document.documentElement;

  const style = document.createElement('style');
  style.textContent = css;
  head.appendChild(style);

  const data = document.createElement('script');
  data.setAttribute('type', 'application/json');
  data.setAttribute('id', 'hrv-directives');
  if (version) data.setAttribute('data-version', version);
  if (telemetry) data.setAttribute('data-telemetry', '');
  data.textContent = JSON.stringify(directives).replace(/</g, '\\u003c');
  body.appendChild(data);

  const baseData = document.createElement('script');
  baseData.setAttribute('type', 'application/json');
  baseData.setAttribute('id', 'hrv-bases');
  baseData.textContent = JSON.stringify(bases);
  body.appendChild(baseData);

  const markdownData = document.createElement('script');
  markdownData.setAttribute('type', 'application/json');
  markdownData.setAttribute('id', 'hrv-markdown');
  markdownData.textContent = JSON.stringify(markdowns).replace(/</g, '\\u003c');
  body.appendChild(markdownData);

  const committedData = document.createElement('script');
  committedData.setAttribute('type', 'application/json');
  committedData.setAttribute('id', 'hrv-committed');
  committedData.textContent = JSON.stringify(committed).replace(/</g, '\\u003c');
  body.appendChild(committedData);

  const script = document.createElement('script');
  script.textContent = js;
  body.appendChild(script);
}

// Start only when run directly, not when imported by tests. This sits last so
// every constant above is initialized before main runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
