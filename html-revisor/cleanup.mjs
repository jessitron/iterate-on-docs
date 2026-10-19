// html-revisor cleanup: take out what the tool left in a page, for when iterating is done.
//
//   node cleanup.mjs [--author @AI] <file>...   rewrites each file in place.
//   Removes directives (<!-- @AI: ... -->) and element IDs (data-hrv, data-hrv-next). Leaves
//   the formatting as the formatter wrote it: people read the rendered page, not the source.
//   Prints each directive it removed as "<file>: <text>". Exit 0 when every file is clean,
//   1 when a file can't be read or written, 2 for a usage error.
//
// Tier I, orchestration: the CLI. The cleanup itself is domain/cleanup.mjs.
import { pathToFileURL } from 'node:url';
import { cleanup } from './domain/cleanup.mjs';
import { readText, writeText } from './interface/files.mjs';

const USAGE = 'usage: node cleanup.mjs [--author @AI] <file>...\n';

// Clean each file in place. Returns the exit status.
export async function cleanupFiles(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let author = '@AI';
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--author') author = inline ?? argv[++i];
    else files.push(argv[i]);
  }
  if (files.length === 0 || !author) {
    stderr.write(USAGE);
    return 2;
  }
  let status = 0;
  for (const file of files) {
    try {
      const onDisk = await readText(file);
      const { html, removed } = cleanup(onDisk, author);
      if (html !== onDisk) await writeText(file, html);
      for (const text of removed) stdout.write(`${file}: ${text.replaceAll('\n', ' ')}\n`);
    } catch (err) {
      stderr.write(`${file}: ${err.message}\n`);
      status = 1;
    }
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cleanupFiles(process.argv.slice(2));
}
