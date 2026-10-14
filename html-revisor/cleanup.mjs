// html-revisor cleanup: take out what the tool left in a page, for when iterating is done.
//
//   node cleanup.mjs [--author @AI] <file>...   rewrites each file in place.
//   Removes directives (<!-- @AI: ... -->) and element IDs (data-hrv, data-hrv-next). Leaves
//   the formatting as the formatter wrote it: people read the rendered page, not the source.
//   Prints each directive it removed as "<file>: <text>". Exit 0 when every file is clean,
//   1 when a file can't be read or written, 2 for a usage error.
//
// Tiers, dependencies point downward only:
//   Tier I   orchestration: the CLI
//   Tier II  domain: cleanup (pure function)
//   Tier III interface: the filesystem, through fs in the CLI
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parse, serialize, ID, NEXT_ID } from './formatter.mjs';
import { allComments, isDirective, directiveText } from './directives.mjs';

// ======================================================================
// Tier I: orchestration
// ======================================================================

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
      const onDisk = await fs.readFile(file, 'utf8');
      const { html, removed } = cleanup(onDisk, author);
      if (html !== onDisk) await fs.writeFile(file, html);
      for (const text of removed) stdout.write(`${file}: ${text.replaceAll('\n', ' ')}\n`);
    } catch (err) {
      stderr.write(`${file}: ${err.message}\n`);
      status = 1;
    }
  }
  return status;
}

// ======================================================================
// Tier II: domain
// ======================================================================

// The page without directives or element IDs, in canonical layout, and the text of each
// directive removed. A directive left at "good enough" no longer matters, so it goes.
export function cleanup(html, author = '@AI') {
  const document = parse(html);
  const removed = [];
  for (const comment of allComments(document)) {
    if (!isDirective(comment, author)) continue;
    removed.push(directiveText(comment, author));
    comment.remove();
  }
  for (const el of document.querySelectorAll(`[${ID}]`)) el.removeAttribute(ID);
  document.documentElement.removeAttribute(NEXT_ID);
  return { html: serialize(document), removed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cleanupFiles(process.argv.slice(2));
}
