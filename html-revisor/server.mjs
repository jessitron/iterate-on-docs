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
import { parse, normalize, serialize, VOID, RAW, trimAscii, escapeText } from './formatter.mjs';

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

  if (req.method === 'PUT' && isHtml) return putEdits(req, res, file, urlPath, config);
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

// GET: normalize on disk, then serve a stamped copy with directives lifted out into JSON.
async function getPage(res, file, urlPath, { author }) {
  const onDisk = await fs.readFile(file, 'utf8');
  const formatted = normalize(onDisk);
  if (formatted !== onDisk) {
    await fs.writeFile(file, formatted);
    console.log(`${urlPath} (normalized)`);
  }
  const document = parse(formatted);
  stamp(document);
  const directives = collectDirectives(document, author);
  removeDirectives(document, author);
  injectClient(document, directives, versionOf(formatted), await readClientCss());
  console.log(`${urlPath} — ${Object.keys(directives).length} pending directives`);
  sendHtml(res, document.toString());
}

// A short fingerprint of the file bytes. The client sends it back to prove its view is current.
const versionOf = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12);

// PUT: the body is the complete set of directives, plus the new text of any edited text elements.
// Rewrite the directives into the file and replace the texts. Both maps are idempotent to resend.
// Optimistic concurrency: a "version" that differs from the file on disk is rejected with 409.
async function putEdits(req, res, file, urlPath, { author }) {
  let directives, texts, version;
  try {
    ({ directives, texts = {}, version } = JSON.parse(await readBody(req)));
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  const isMap = (m) => m && typeof m === 'object' && !Array.isArray(m);
  if (!isMap(directives) || !isMap(texts)) {
    throw new HttpError(400, 'body must look like {"directives": {"<id>": "text"}, "texts": {"<id>": "text"}}');
  }
  const onDisk = await fs.readFile(file);
  // A missing version skips the check, so curl and scripts can PUT without a GET first.
  if (version !== undefined && version !== versionOf(onDisk)) {
    console.log(`${urlPath} — stale write rejected (file changed on disk)`);
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'file changed on disk; reload to continue' }));
  }
  const document = parse(onDisk.toString("utf8"));
  const elements = [...document.querySelectorAll('*')]; // snapshot: ids are indices into this
  removeDirectives(document, author);
  let textCount = 0;
  for (const [id, text] of Object.entries(texts)) {
    if (elements[id] && typeof text === 'string' && setText(elements[id], text)) textCount++;
  }
  let count = 0;
  for (const [id, text] of Object.entries(directives)) {
    const element = elements[id];
    if (!element || typeof text !== 'string' || !text.trim()) continue;
    placeDirective(element, text, author);
    count++;
  }
  unstamp(document);
  const written = serialize(document);
  await fs.writeFile(file, written);
  console.log(`${urlPath} — saved ${count} directives` + (textCount ? `, ${textCount} texts` : ''));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, count, version: versionOf(written) }));
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

// data-n is the element's index in document order. Comments are not elements,
// so adding and removing directives never shifts an index.
export function stamp(document) {
  document.querySelectorAll('*').forEach((el, i) => el.setAttribute('data-n', String(i)));
}

export function unstamp(document) {
  document.querySelectorAll('[data-n]').forEach((el) => el.removeAttribute('data-n'));
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

// { [element index]: directive text }; several directives on one element join with newlines.
export function collectDirectives(document, author) {
  const index = new Map([...document.querySelectorAll('*')].map((el, i) => [el, i]));
  const directives = {};
  for (const comment of allComments(document)) {
    if (!isDirective(comment, author)) continue;
    const id = index.get(directiveOwner(comment));
    if (id === undefined) continue;
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

// Replace the element's text. Refuses (returns false) for non-text elements and blank text.
export function setText(el, text) {
  if (!isTextElement(el) || trimAscii(text) === '') return false;
  el.textContent = text;
  return true;
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

// Client assets. Appended to the served copy after stamping, so none of it gets a data-n.
// Read on each GET, so a change to client.css shows on reload without a restart.
export function readClientCss() {
  return fs.readFile(new URL('client.css', import.meta.url), 'utf8');
}
const CLIENT_JS = `// html-revisor client. Directives live in the file on disk; this script edits them through PUT.
(function () {
  'use strict';

  var directives = {};      // id -> text, the full current set
  var texts = {};           // id -> new text of each text element edited in this tab
  var markers = {};         // id -> marker element
  var box = null;           // the open directive box, if any
  var boxId = null;         // id of the element the open box is for
  var saveTimer = null;
  var saving = false;       // a PUT is in flight
  var again = false;        // an edit arrived while a PUT was in flight
  var edited = false;       // changes not yet sent
  var toastTimer = null;
  var version = null;       // fingerprint of the file as this tab last saw it
  var stale = false;        // the file changed on disk; no more saves

  try {
    var data = document.getElementById('hrv-directives');
    directives = JSON.parse(data.textContent) || {};
    version = data.getAttribute('data-version');
  } catch (e) {
    directives = {};
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
    return document.querySelector('[data-n="' + id + '"]');
  }

  function inLayer(node) {
    return node instanceof Node && layer.contains(node);
  }

  // The nearest stamped ancestor, never html or body.
  function targetElement(node) {
    if (!(node instanceof Element)) return null;
    var el = node.closest('[data-n]');
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

  // ---- hover ----

  var hovered = null;

  function setHover(el) {
    if (el === hovered) return;
    if (hovered) hovered.classList.remove('hrv-hover');
    hovered = el;
    if (hovered) hovered.classList.add('hrv-hover');
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
  }

  var frame = 0;
  function schedulePosition() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      positionAll();
    });
  }

  // Make the marker and the hrv-has-directive class match the directive text.
  function syncMarker(id) {
    var el = elementFor(id);
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
      if (el) el.classList.add('hrv-has-directive');
      positionMarker(id);
    } else {
      if (markers[id]) {
        markers[id].remove();
        delete markers[id];
      }
      if (el) el.classList.remove('hrv-has-directive');
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

  function currentDirectives() {
    var out = {};
    for (var id in directives) if (hasText(id)) out[id] = directives[id];
    return out;
  }

  // One PUT at a time. An edit during a PUT sets "again" and a new PUT follows.
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (stale) return;
    if (saving) { again = true; return; }
    saving = true;
    again = false;
    edited = false;
    var failed = false;
    fetch(location.pathname, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: version, directives: currentDirectives(), texts: texts })
    }).then(function (res) {
      if (res.ok) return res.json();
      if (res.status === 409) return { conflict: true };
      return res.text().then(function (t) {
        throw new Error(t || ('HTTP ' + res.status));
      });
    }).then(function (data) {
      if (data.conflict) {
        stale = true;
        showToast('file changed on disk — reload to see it (your unsaved text is in the box)', true, true);
        return;
      }
      version = data.version;
      var n = data.count;
      showToast('saved · ' + n + (n === 1 ? ' directive' : ' directives'), false);
    }).catch(function (err) {
      failed = true;
      edited = true;
      showToast('save failed: ' + (err && err.message ? err.message : err), true);
    }).then(function () {
      saving = false;
      // A later edit retries after a failure; an edit made during the PUT goes out now.
      if (again && !failed) saveNow();
    });
  }

  function scheduleSave() {
    edited = true;
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
    if (edited || saveTimer) saveNow();
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
        scheduleSave();
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
      scheduleSave();
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
      edited = true;
      closeBox();
    });

    var save = document.createElement('div');
    save.className = 'hrv-btn hrv-save';
    save.textContent = 'Save';
    save.addEventListener('click', function () {
      edited = true;
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
    openBox(el.getAttribute('data-n'));
  }, true);

  // ---- start ----

  for (var id in directives) syncMarker(id);
})();
`;

export function injectClient(document, directives, version, css) {
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
