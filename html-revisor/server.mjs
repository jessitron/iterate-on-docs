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
import { parse, normalize, serialize, assignIds, formatElement, ID, VOID, RAW, trimAscii, escapeText } from './formatter.mjs';

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
  injectClient(document, { directives, bases }, versionOf(formatted), await readClientCss());
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

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const server = createServer(config);
  server.listen(config.port, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`html-revisor: http://localhost:${port}/ serving ${path.resolve(config.root)}`);
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
// Read on each GET, so a change to client.css shows on reload without a restart.
export function readClientCss() {
  return fs.readFile(new URL('client.css', import.meta.url), 'utf8');
}
const CLIENT_JS = `// html-revisor client. Directives live in the file on disk; this script edits them through PUT.
(function () {
  'use strict';

  var directives = {};      // id -> text, the full current set
  var texts = {};           // id -> new text of each text element edited in this tab
  var bases = {};           // id -> base: the element's content as the server last saw it
  var markers = {};         // id -> marker element
  var box = null;           // the open directive box, if any
  var boxId = null;         // id of the element the open box is for
  var saveTimer = null;
  var saving = false;       // a PUT is in flight
  var unsent = [];          // changes not yet sent, oldest first: {kind: 'directive'|'text', id}
  var toastTimer = null;
  var version = null;       // fingerprint of the file as this tab last saw it
  var changedOnDisk = false; // a save found the file changed by someone else

  try {
    var data = document.getElementById('hrv-directives');
    directives = JSON.parse(data.textContent) || {};
    version = data.getAttribute('data-version');
    bases = JSON.parse(document.getElementById('hrv-bases').textContent) || {};
  } catch (e) {
    directives = directives || {};
  }

  var layer = document.createElement('div');
  layer.id = 'hrv-layer';
  var toast = document.createElement('div');
  toast.className = 'hrv-toast';
  layer.appendChild(toast);
  document.body.appendChild(layer);

  // ---- helpers ----

  function hasText(id) {
    return typeof directives[id] === 'string' && directives[id].trim() !== '';
  }

  function elementFor(id) {
    return document.querySelector('[data-hrv="' + id + '"]');
  }

  function inLayer(node) {
    return node instanceof Node && layer.contains(node);
  }

  // The nearest element with an ID, never html or body.
  function targetElement(node) {
    if (!(node instanceof Element)) return null;
    var el = node.closest('[data-hrv]');
    if (!el || el === document.documentElement || el === document.body) return null;
    return el;
  }

  // An element holding only text, so the box can edit it without losing markup.
  // Same rule as isTextElement on the server.
  var NOT_TEXT = ('area base br col embed hr img input link meta param source track wbr ' +
    'title iframe xmp noembed noframes script style template textarea').split(' ');
  var SPACE = /[ \\t\\n\\r\\f]+/g;   // the whitespace HTML collapses; not U+00A0

  function isTextElement(el) {
    var kids = el.childNodes;
    if (NOT_TEXT.indexOf(el.localName) >= 0 || kids.length === 0) return false;
    for (var i = 0; i < kids.length; i++) if (kids[i].nodeType !== 3) return false;
    return el.textContent.replace(SPACE, '') !== '';
  }

  // The text as the reader sees it. Outside pre, layout whitespace collapses.
  function shownText(el) {
    if (el.localName === 'pre') return el.textContent;
    return el.textContent.replace(SPACE, ' ').trim();
  }

  // Where the layer's origin sits in the document. Zero unless body is positioned.
  function layerOrigin() {
    var r = layer.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY };
  }

  function isHidden(rect) {
    return rect.width === 0 && rect.height === 0;
  }

  // ---- crop marks ----

  // How far outside the element's box its crop marks sit, from client.css.
  var cropGap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hrv-crop-gap')) || 4;

  function makeCrop(className) {
    var crop = document.createElement('div');
    crop.className = className;
    crop.style.display = 'none';
    layer.appendChild(crop);
    return crop;
  }

  // Cover the element's box plus the gap, kept inside the document so it adds no scrolling.
  function positionCrop(crop, el) {
    var rect = el ? el.getBoundingClientRect() : null;
    if (!rect || isHidden(rect)) { crop.style.display = 'none'; return; }
    var doc = document.documentElement;
    var o = layerOrigin();
    var x = rect.left + window.scrollX, y = rect.top + window.scrollY;
    var right = Math.min(x + rect.width + cropGap, Math.max(doc.scrollWidth, x + rect.width));
    var bottom = Math.min(y + rect.height + cropGap, Math.max(doc.scrollHeight, y + rect.height));
    var left = Math.max(0, x - cropGap), top = Math.max(0, y - cropGap);
    crop.style.display = 'block';
    crop.style.left = left - o.x + 'px';
    crop.style.top = top - o.y + 'px';
    crop.style.width = right - left + 'px';
    crop.style.height = bottom - top + 'px';
  }

  // ---- hover ----

  var hovered = null;
  var hoverCrop = makeCrop('hrv-crop');
  var selectedCrop = makeCrop('hrv-crop hrv-selected');

  // The open box's element shows its heavier marks instead.
  function positionHover() {
    positionCrop(hoverCrop, hovered && hovered !== elementFor(boxId) ? hovered : null);
  }

  function setHover(el) {
    if (el === hovered) return;
    hovered = el;
    positionHover();
  }

  document.addEventListener('mouseover', function (e) {
    setHover(inLayer(e.target) ? null : targetElement(e.target));
  }, true);

  document.addEventListener('mouseout', function (e) {
    if (!e.relatedTarget) setHover(null);
  }, true);

  // ---- markers ----

  function positionMarker(id) {
    var marker = markers[id];
    var el = elementFor(id);
    if (!marker) return;
    if (!el) { marker.style.display = 'none'; return; }
    var rect = el.getBoundingClientRect();
    if (isHidden(rect)) { marker.style.display = 'none'; return; }
    var o = layerOrigin();
    marker.style.display = 'block';
    marker.style.left = Math.max(2, rect.left + window.scrollX - 9) - o.x + 'px';
    marker.style.top = Math.max(2, rect.top + window.scrollY - 9) - o.y + 'px';
  }

  function positionBox() {
    if (!box) return;
    var el = elementFor(boxId);
    if (!el) return;
    var rect = el.getBoundingClientRect();
    var o = layerOrigin();
    var viewW = document.documentElement.clientWidth;
    var width = Math.min(320, viewW - 16);
    box.style.width = width + 'px';
    var left = rect.left + window.scrollX;
    left = Math.min(left, window.scrollX + viewW - width - 8);
    left = Math.max(left, window.scrollX + 8);
    var top = rect.top < 0 ? window.scrollY + 8 : rect.top + window.scrollY + 20;
    box.style.left = left - o.x + 'px';
    box.style.top = top - o.y + 'px';
  }

  function positionAll() {
    for (var id in markers) positionMarker(id);
    positionBox();
    positionCrop(selectedCrop, box ? elementFor(boxId) : null);
    positionHover();
  }

  var frame = 0;
  function schedulePosition() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      positionAll();
    });
  }

  // Make the marker match the directive text.
  function syncMarker(id) {
    if (hasText(id)) {
      var marker = markers[id];
      if (!marker) {
        marker = document.createElement('div');
        marker.className = 'hrv-marker';
        marker.textContent = '✎';
        marker.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          openBox(id);
        });
        layer.appendChild(marker);
        markers[id] = marker;
      }
      marker.title = directives[id];
      positionMarker(id);
    } else if (markers[id]) {
      markers[id].remove();
      delete markers[id];
    }
  }

  window.addEventListener('scroll', schedulePosition, { passive: true });
  window.addEventListener('resize', schedulePosition);
  if (window.ResizeObserver) new ResizeObserver(schedulePosition).observe(document.body);

  // ---- saving ----

  function showToast(text, isError, sticky) {
    toast.textContent = text;
    toast.className = 'hrv-toast hrv-show' + (isError ? ' hrv-error' : '');
    clearTimeout(toastTimer);
    if (sticky) return;
    toastTimer = setTimeout(function () {
      toast.className = 'hrv-toast';
    }, isError ? 4000 : 1500);
  }

  function directiveCount() {
    var n = 0;
    for (var id in directives) if (hasText(id)) n++;
    return n;
  }

  // Mark a change to send. A change already waiting sends the latest value, once.
  function addUnsent(kind, id) {
    for (var i = 0; i < unsent.length; i++) {
      if (unsent[i].kind === kind && unsent[i].id === id) return;
    }
    unsent.push({ kind: kind, id: id });
  }

  function bodyFor(change) {
    var body = { id: change.id, base: bases[change.id] || '' };
    body[change.kind] = change.kind === 'text' ? texts[change.id] : (directives[change.id] || '');
    return body;
  }

  // One PUT at a time, one change per PUT. When a PUT ends, the next change goes out.
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (saving || unsent.length === 0) return;
    saving = true;
    var change = unsent.shift();
    var failed = false;
    fetch(location.pathname, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyFor(change))
    }).then(function (res) {
      if (res.ok || res.status === 412) return res.json();
      return res.text().then(function (t) {
        throw new Error(t || ('HTTP ' + res.status));
      });
    }).then(function (data) {
      if (!data.ok) {
        // A conflict: we weren't taking turns. Say so; the reload is up to the human.
        failed = true;
        showToast('not saved: ' + data.error + '. Copy what you wrote, then reload to see the page as it is now', true, true);
        return;
      }
      for (var id in data.bases) bases[id] = data.bases[id];
      if (data.before !== version) changedOnDisk = true;
      version = data.after;
      var n = data.count;
      var saved = 'saved · ' + n + (n === 1 ? ' directive' : ' directives');
      if (changedOnDisk) showToast(saved + ' · the page changed on disk; reload to see it', false, true);
      else showToast(saved, false);
    }).catch(function (err) {
      failed = true;
      addUnsent(change.kind, change.id); // a later edit retries it
      showToast('save failed: ' + (err && err.message ? err.message : err), true);
    }).then(function () {
      saving = false;
      if (!failed) saveNow();
    });
  }

  function scheduleSave(kind, id) {
    addUnsent(kind, id);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  // ---- directive box ----

  function setDirective(id, text) {
    if (text.trim() === '') delete directives[id];
    else directives[id] = text;
    syncMarker(id);
  }

  // Commit and close the open box.
  function closeBox() {
    if (!box) return;
    var ta = box.querySelector('textarea.hrv-directive');
    var id = boxId;
    setDirective(id, ta.value);
    box.remove();
    box = null;
    boxId = null;
    positionCrop(selectedCrop, null);
    positionHover();
    saveNow();
  }

  function openBox(id) {
    if (box && boxId === id) {
      box.querySelector('textarea.hrv-directive').focus();
      return;
    }
    closeBox();
    var el = elementFor(id);
    if (!el) return;
    boxId = id;
    box = document.createElement('div');
    box.className = 'hrv-box';

    // Text elements get a field for their text above the directive.
    // The page shows each edit at once; blank text is not applied.
    if (isTextElement(el)) {
      var textArea = document.createElement('textarea');
      textArea.className = 'hrv-text';
      textArea.value = shownText(el);
      textArea.addEventListener('input', function () {
        if (textArea.value.replace(SPACE, '') === '') return;
        el.textContent = textArea.value;
        texts[id] = textArea.value;
        scheduleSave('text', id);
        schedulePosition();
      });
      box.appendChild(label('Text'));
      box.appendChild(textArea);
      box.appendChild(label('Directive'));
    }

    var ta = document.createElement('textarea');
    ta.className = 'hrv-directive';
    ta.value = directives[id] || '';
    ta.placeholder = 'Directive for this element';
    ta.addEventListener('input', function () {
      setDirective(id, ta.value);
      scheduleSave('directive', id);
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        closeBox();
      }
    });

    var hint = document.createElement('div');
    hint.className = 'hrv-hint';
    hint.textContent = '⌘↵ to save · esc to close';

    var del = document.createElement('div');
    del.className = 'hrv-btn';
    del.textContent = 'Delete';
    del.title = 'Delete the directive';
    del.addEventListener('click', function () {
      ta.value = '';
      setDirective(id, '');
      addUnsent('directive', id);
      closeBox();
    });

    var save = document.createElement('div');
    save.className = 'hrv-btn hrv-save';
    save.textContent = 'Save';
    save.addEventListener('click', function () {
      closeBox();
    });

    var row = document.createElement('div');
    row.className = 'hrv-row';
    row.appendChild(hint);
    row.appendChild(del);
    row.appendChild(save);

    box.appendChild(ta);
    box.appendChild(row);
    // Keep keystrokes in the box away from the page's own shortcuts.
    ['keydown', 'keyup', 'keypress'].forEach(function (type) {
      box.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    layer.appendChild(box);
    positionBox();
    positionCrop(selectedCrop, el);
    positionHover();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function label(text) {
    var div = document.createElement('div');
    div.className = 'hrv-label';
    div.textContent = text;
    return div;
  }

  // ---- click handling ----

  // Capture phase on document, so page handlers and link navigation lose.
  document.addEventListener('click', function (e) {
    if (inLayer(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var el = targetElement(e.target);
    if (!el) {
      closeBox();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    openBox(el.getAttribute('data-hrv'));
  }, true);

  // ---- start ----

  for (var id in directives) syncMarker(id);
})();
`;

// directives: {id: text}. bases: {id: base}, sent back with each change.
export function injectClient(document, { directives, bases }, version, css) {
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
  script.textContent = CLIENT_JS;
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
