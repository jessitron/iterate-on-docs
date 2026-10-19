// html-revisor formatter: parse an HTML document and write it back in canonical form.
//
//   node formatter.mjs <file>...   rewrites each file in place; prints nothing on success.
//   Exit 0 when every file ends canonical, 1 when a file can't be read or written or
//   breaks a rule the formatter can't fix, 2 for a usage error.
//
// Tier I, orchestration: the CLI. The formatter itself is domain/format.mjs.
import { pathToFileURL } from 'node:url';
import { format } from './domain/format.mjs';
import { readText, writeText } from './interface/files.mjs';

// Format each file in place. Returns the exit status; problems go to stderr.
export async function formatFiles(files, { stderr = process.stderr } = {}) {
  if (files.length === 0) {
    stderr.write('usage: node formatter.mjs <file>...\n');
    return 2;
  }
  let status = 0;
  for (const file of files) {
    try {
      const onDisk = await readText(file);
      const { html, problems } = format(onDisk);
      if (html !== onDisk) await writeText(file, html);
      for (const problem of problems) stderr.write(`${file}: ${problem}\n`);
      if (problems.length) status = 1;
    } catch (err) {
      stderr.write(`${file}: ${err.message}\n`);
      status = 1;
    }
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await formatFiles(process.argv.slice(2));
}
