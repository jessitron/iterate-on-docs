// HTTP: request paths, request bodies, and the answers. Tier III.
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The raw request path, percent-decoded. Done by hand because URL parsing
// would quietly resolve ".." before we can reject it.
export function decodeRequestPath(rawUrl) {
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

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// The request body as JSON; anything else is a 400.
export async function readJson(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
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

export function sendFile(res, file, bytes) {
  res.writeHead(200, { 'Content-Type': contentTypeFor(file) });
  res.end(bytes);
}

export function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-store' });
  res.end(html);
}

export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// What a GET asks for, from its Accept header: the page, its state as JSON, or its events.
// A browser's EventSource sends text/event-stream; the tab's fetch of the state, application/json.
export function wants(req) {
  const accept = req.headers.accept ?? '';
  if (accept.startsWith('text/event-stream')) return 'events';
  if (accept.startsWith('application/json')) return 'json';
  return 'page';
}

// Server-sent events: keep the answer open and write each event as it comes. A comment goes
// first, so the browser's EventSource opens at once. A comment every 30 seconds keeps an idle
// connection from timing out. Returns send(event, data) and end(); onClose runs when the tab
// goes away or end() is called.
export function openEventStream(res, onClose) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': html-revisor\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 30000);
  res.on('close', () => {
    clearInterval(ping);
    onClose();
  });
  return {
    send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => res.end(),
  };
}

export function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

export function redirect(res, location) {
  res.writeHead(301, { Location: encodeURI(location) });
  res.end();
}

export function sendError(res, err) {
  const status = err.status ?? (err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 404 : 500);
  if (status === 500) console.error(err.stack ?? err);
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(status === 404 ? 'not found' : String(err.message ?? err));
}

// The other end: PUT a JSON body to a running server. Resolves to the status and the body as
// text; a server that isn't there is an Error that says so.
export async function putJson(url, body) {
  let res;
  try {
    res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`no server answers at ${new URL(url).origin}: is it running? (${err.cause?.code ?? err.message})`);
  }
  return { status: res.status, text: await res.text() };
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;').replace(/"/g, '&quot;');

export function directoryListing(urlPath, entries) {
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
