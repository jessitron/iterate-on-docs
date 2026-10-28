// html-revisor reply: the agent answers a directive, through the running server.
//
//   node reply.mjs <page URL> <id> <thread> <text>
//   <page URL> is the page as the server's startup line names it; <id> and <thread> come from
//   the Announcement. The server writes <!-- @Human: text --> after the thread's last turn, in
//   turn with the browser's saves: it is the only writer of the live file.
//   Prints the server's answer, one line of JSON, on stdout. Exit 0 when the reply landed; 1
//   when it's stale (the thread changed since: the answer carries the directive and thread
//   base now, to reply again with) or the server can't take it; 2 for a usage error.
//
// Tier I, orchestration: the CLI. The reply itself is the server's PUT.
import { pathToFileURL } from 'node:url';
import { putJson } from './interface/http.mjs';

const USAGE = 'usage: node reply.mjs <page URL> <id> <thread> <text>\n';

// Send one reply. Returns the exit status.
export async function sendReply(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [page, id, thread, text, ...extra] = argv;
  if (!text?.trim() || extra.length || !URL.canParse(page) || !/^https?:$/.test(new URL(page).protocol)) {
    stderr.write(USAGE);
    return 2;
  }
  try {
    const { status, text: answer } = await putJson(page, { id, thread, reply: text });
    if (status === 200 || status === 412) {
      stdout.write(`${JSON.stringify(JSON.parse(answer))}\n`);
      return status === 200 ? 0 : 1;
    }
    stderr.write(`${page}: ${status} ${answer}\n`);
  } catch (err) {
    stderr.write(`${page}: ${err.message}\n`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await sendReply(process.argv.slice(2));
}
