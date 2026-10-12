// html-revisor: leave directives on HTML files; they live in the file as <!-- author: text -->.
//
// Three tiers, dependencies point downward only:
//   Tier I   orchestration: CLI, request routing, the GET and PUT flows
//   Tier II  domain: directives, text edits, element identity (pure functions over a DOM);
//            the formatter is Tier II too, in formatter.mjs
//   Tier III interface: filesystem gateway, content types, listings, client assets
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatFiles, parse, normalize, serialize, assignIds, formatElement, ID, VOID, RAW, trimAscii, escapeText } from './formatter.mjs';

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

export function createServer({ root, author }) {
  return http.createServer((req, res) => {
    route(req, res, { root: path.resolve(root), author }).catch((err) => sendError(res, err));
  });
}

async function route(req, res, config) {
  const urlPath = decodeRequestPath(req.url);
  const file = resolveUnderRoot(config.root, urlPath);
  const isHtml = /\.html?$/i.test(urlPath);

  if (req.method === 'PUT' && isHtml) return putChange(req, res, file, urlPath, config);
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');

  const stat = await fs.stat(file);
  if (stat.isDirectory()) {
    if (!urlPath.endsWith('/')) return redirect(res, urlPath + '/');
    return sendHtml(res, directoryListing(urlPath, await fs.readdir(file, { withFileTypes: true })));
  }
  if (isHtml) return getPage(res, file, urlPath, config);
  res.writeHead(200, { 'Content-Type': contentTypeFor(file) });
  res.end(await fs.readFile(file));
}

// GET: format on disk (which assigns element IDs), then serve a copy with directives lifted
// out into JSON, and the base of every element so the tab can send it back with a change.
async function getPage(res, file, urlPath, { author }) {
  const onDisk = await fs.readFile(file, 'utf8');
  const formatted = normalize(onDisk);
  if (formatted !== onDisk) {
    await fs.writeFile(file, formatted);
    console.log(`${urlPath} (normalized)`);
  }
  const document = parse(formatted);
  const directives = collectDirectives(document, author);
  removeDirectives(document, author);
  const bases = basesOf(document.querySelectorAll(`[${ID}]`), author);
  injectClient(document, { directives, bases }, versionOf(formatted), await readClientAssets());
  console.log(`${urlPath} — ${Object.keys(directives).length} pending directives`);
  sendHtml(res, document.toString());
}

// A short fingerprint. Of the file bytes, it lets the tab notice that the page changed on disk.
const versionOf = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12);

// PUT: the body is one change to one element, with the base the tab started from:
//   {"id": "7", "base": "…", "directive": "text"}   sets the element's directive; "" removes it
//   {"id": "7", "base": "…", "text": "new text"}     replaces the text of a text element
// IDs come first, so elements an agent added since the last format have them. A base that
// doesn't match the element now, or an ID that isn't there, is a conflict: 412, nothing written.
// The answer carries the new bases of the element and the elements around it, and the file's
// fingerprint before and after, so the tab can notice an outside change.
async function putChange(req, res, file, urlPath, { author }) {
  let change;
  try {
    change = JSON.parse(await readBody(req));
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  const { id, base, directive, text } = change ?? {};
  if (typeof id !== 'string' || typeof base !== 'string' || (typeof directive === 'string') === (typeof text === 'string')) {
    throw new HttpError(400, 'body must look like {"id": "<id>", "base": "<base>", "directive": "text"} or {"id", "base", "text"}');
  }
  const onDisk = await fs.readFile(file, 'utf8');
  const document = parse(onDisk);
  assignIds(document);
  const el = elementById(document, id);
  if (!el || baseOf(el, author) !== base) {
    console.log(`${urlPath} — conflict on element ${id} (${el ? 'it changed on disk' : 'no such element'})`);
    res.writeHead(412, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: el ? 'that element changed on disk' : 'that element is gone from the file' }));
  }
  if (typeof directive === 'string') setDirective(el, directive, author);
  else if (!setText(el, text, author)) throw new HttpError(400, 'text edits need a text element and non-blank text');
  const written = serialize(document);
  if (written !== onDisk) await fs.writeFile(file, written);
  const count = Object.keys(collectDirectives(document, author)).length;
  console.log(`${urlPath} — saved ${typeof directive === 'string' ? 'directive' : 'text'} on ${id}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, count, bases: basesOf(around(el), author), before: versionOf(onDisk), after: versionOf(written) }));
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
  const server = createServer(config);
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

// The elements whose base an edit to el can change: el, the IDs inside it, and its ancestors.
function around(el) {
  const out = [...el.querySelectorAll(`[${ID}]`)];
  for (let a = el; a?.nodeType === 1; a = a.parentNode) if (a.hasAttribute(ID)) out.push(a);
  return out;
}

// ---- Directives ---------------------------------------------------------

// Directives go before these elements; for everything else a directive is the first child.
// Elements whose content is parsed as plain text (title, iframe, ...) cannot hold a comment.
const TEXT_ONLY = 'title iframe xmp noembed noframes'.split(' ');
const DIRECTIVE_BEFORE = new Set([...VOID, ...RAW, ...TEXT_ONLY]);
const directiveGoesBefore = (el) => DIRECTIVE_BEFORE.has(el.localName);

// A directive is an HTML comment inside an element whose text starts with "<author>:".
// Comments outside any element (before <html>) are never directives.
export function isDirective(node, author) {
  return (
    node.nodeType === 8 &&
    node.parentNode?.nodeType === 1 &&
    node.data.trimStart().startsWith(`${author}:`)
  );
}

export function directiveText(comment, author) {
  return comment.data.trimStart().slice(author.length + 1).trim();
}

// Escape so the text cannot end the comment early. Repeat for runs like "---".
export function escapeDirectiveText(text) {
  let out = text;
  while (out.includes('--')) out = out.replaceAll('--', '- -');
  return out.replaceAll('>', '&gt;');
}

function allComments(node, found = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === 8) found.push(child);
    else if (child.nodeType === 1) allComments(child, found);
  }
  return found;
}

// The reading rule: a directive belongs to its parent, unless the next sibling (skipping
// whitespace-only text) is a void or preformatted element; then it belongs to that sibling.
// Only whitespace is skipped, not other directives. Skipping directives would make a parent's
// directive and the directive of its first-child <img> ambiguous; since writing merges to one
// directive per element, they sit in order [parent directive][img directive][img] and read back correctly.
// Known limit: a parent's directive directly before an <img> first child that has no directive reads as the img's.
function directiveOwner(comment) {
  let next = comment.nextSibling;
  while (next?.nodeType === 3 && trimAscii(next.data) === '') next = next.nextSibling;
  return next?.nodeType === 1 && directiveGoesBefore(next) ? next : comment.parentNode;
}

// { [element ID]: directive text }; several directives on one element join with newlines.
// A directive on an element with no ID stays in the file, unseen.
export function collectDirectives(document, author) {
  const directives = {};
  for (const comment of allComments(document)) {
    if (!isDirective(comment, author)) continue;
    const id = directiveOwner(comment).getAttribute?.(ID);
    if (id == null) continue;
    const text = directiveText(comment, author);
    directives[id] = id in directives ? `${directives[id]}\n${text}` : text;
  }
  return directives;
}

export function removeDirectives(document, author) {
  for (const comment of allComments(document)) {
    if (isDirective(comment, author)) comment.remove();
  }
}

// Replace the element's directives with this one; empty text leaves it none. Other
// elements' directives stay where they are.
export function setDirective(el, text, author) {
  for (const comment of allComments(el.ownerDocument)) {
    if (isDirective(comment, author) && directiveOwner(comment) === el) comment.remove();
  }
  if (text.trim()) placeDirective(el, text, author);
}

export function placeDirective(el, text, author) {
  const comment = el.ownerDocument.createComment(` ${author}: ${escapeDirectiveText(text.trim())} `);
  if (directiveGoesBefore(el) && el.parentNode) el.parentNode.insertBefore(comment, el);
  else el.insertBefore(comment, el.firstChild);
}

// ---- Text edits ---------------------------------------------------------

// A text element holds nothing but text (once directives are lifted out), so replacing its text
// loses no markup. Elements whose text is code or not shown are excluded.
const NOT_TEXT = new Set([...VOID, ...TEXT_ONLY, 'script', 'style', 'template', 'textarea']);

export function isTextElement(el) {
  const kids = [...el.childNodes];
  return (
    !NOT_TEXT.has(el.localName) &&
    kids.length > 0 &&
    kids.every((n) => n.nodeType === 3) &&
    trimAscii(el.textContent) !== ''
  );
}

// Replace the element's text, keeping its directives. Refuses (returns false) for non-text
// elements and blank text.
export function setText(el, text, author) {
  const own = [...el.childNodes].filter((n) => isDirective(n, author));
  own.forEach((n) => n.remove());
  const ok = isTextElement(el) && trimAscii(text) !== '';
  if (ok) el.textContent = text;
  el.prepend(...own);
  return ok;
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

// Client assets. Appended to the served copy, never written to the file, so none of it has an ID.
// Read on each GET, so a change to client.css or client.js shows on reload without a restart.
const readAsset = (name) => fs.readFile(new URL(name, import.meta.url), 'utf8');
export async function readClientAssets() {
  const [css, js] = await Promise.all([readAsset('client.css'), readAsset('client.js')]);
  return { css, js };
}

// directives: {id: text}. bases: {id: base}, sent back with each change.
export function injectClient(document, { directives, bases }, version, { css, js }) {
  const head = document.querySelector('head') ?? document.documentElement;
  const body = document.querySelector('body') ?? document.documentElement;

  const style = document.createElement('style');
  style.textContent = css;
  head.appendChild(style);

  const data = document.createElement('script');
  data.setAttribute('type', 'application/json');
  data.setAttribute('id', 'hrv-directives');
  if (version) data.setAttribute('data-version', version);
  data.textContent = JSON.stringify(directives).replace(/</g, '\\u003c');
  body.appendChild(data);

  const baseData = document.createElement('script');
  baseData.setAttribute('type', 'application/json');
  baseData.setAttribute('id', 'hrv-bases');
  baseData.textContent = JSON.stringify(bases);
  body.appendChild(baseData);

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
