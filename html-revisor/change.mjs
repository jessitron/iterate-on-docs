// html-revisor change: the agent changes a page through the running server, which writes it in
// turn with the browser's saves, so neither writes over the other, and the open tab shows the
// change without a reload.
//
//   node change.mjs <page URL> read <id>                           the scope now: its HTML and version
//   node change.mjs <page URL> replace <id> <version> < new.html     new content for the scope
//   node change.mjs <page URL> add after|before|into <id> < new.html
//   node change.mjs <page URL> remove <id> <version>
//   node change.mjs <page URL> move <id> after|before|into <other id>
//
// Any change takes --because "<a few words>": what the change is for. The user reads it on the
// change's mark.
//
// <page URL> is the page as the server's startup line names it; <id> is an element's data-hrv.
// <version> is the scope's version, from read, from the answer to the last change, or from an
// Announcement: hand it back unread. HTML comes on stdin. For replace it is one root element; keep
// data-hrv on the elements you kept and leave it off new ones: the server numbers them.
// Prints the server's answer, one line of JSON, on stdout. Exit 0 when the change landed (or the
// read found the scope); 1 when it was refused, {"ok": false, "error", …}: for a scope that
// changed since your version, the answer holds what it holds now ("html", "version") to redo
// your change on; 1 with a message on stderr when no server answers; 2 for a usage error.
//
// Tier I, orchestration: the CLI. The change itself is the server's PUT, and read its GET.
import { pathToFileURL } from 'node:url';
import { putJson, getJson } from './interface/http.mjs';

const USAGE = `usage: node change.mjs <page URL> read <id>
       node change.mjs <page URL> replace <id> <version> < new.html
       node change.mjs <page URL> add after|before|into <id> < new.html
       node change.mjs <page URL> remove <id> <version>
       node change.mjs <page URL> move <id> after|before|into <other id>
       a change takes --because "<what it is for>"
`;
const WHERE = ['after', 'before', 'into'];

// The request the arguments name: {read: id} or {body} for a PUT, with stdin wanted for html.
// Null for a usage error.
function requestOf(words) {
  const at = words.indexOf('--because');
  if (at < 0) return requestWithout(words);
  const because = words[at + 1];
  const request = requestWithout([...words.slice(0, at), ...words.slice(at + 2)]);
  if (typeof because !== 'string' || !request?.body) return null;
  return { ...request, body: { ...request.body, because } };
}

function requestWithout([verb, ...args]) {
  const [a, b, c] = args;
  const id = (s) => typeof s === 'string' && /^\d+$/.test(s);
  if (verb === 'read' && args.length === 1 && id(a)) return { read: a };
  if (verb === 'replace' && args.length === 2 && id(a) && b) return { body: { change: 'replace', id: a, version: b }, html: true };
  if (verb === 'add' && args.length === 2 && WHERE.includes(a) && id(b)) return { body: { change: 'add', where: a, id: b }, html: true };
  if (verb === 'remove' && args.length === 2 && id(a) && b) return { body: { change: 'remove', id: a, version: b } };
  if (verb === 'move' && args.length === 3 && id(a) && WHERE.includes(b) && id(c)) return { body: { change: 'move', id: a, where: b, to: c } };
  return null;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// Make one change, or read one scope. stdin: a stream of the HTML, or the HTML as a string.
// Returns the exit status.
export async function sendChange(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [page, ...rest] = argv;
  const request = requestOf(rest);
  if (!request || !URL.canParse(page) || !/^https?:$/.test(new URL(page).protocol)) {
    stderr.write(USAGE);
    return 2;
  }
  try {
    let answer;
    if (request.read) {
      const url = new URL(page);
      url.searchParams.set('scope', request.read);
      answer = await getJson(url.href);
    } else {
      const html = request.html ? (typeof stdin === 'string' ? stdin : await readAll(stdin)) : undefined;
      answer = await putJson(page, html === undefined ? request.body : { ...request.body, html });
    }
    const said = parsed(answer.text);
    if (said && typeof said.ok === 'boolean') {
      stdout.write(`${JSON.stringify(said)}\n`);
      return said.ok && answer.status === 200 ? 0 : 1;
    }
    stderr.write(`${page}: ${answer.status} ${answer.text}\n`);
  } catch (err) {
    stderr.write(`${page}: ${err.message}\n`);
  }
  return 1;
}

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await sendChange(process.argv.slice(2));
}
