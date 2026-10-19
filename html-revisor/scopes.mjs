// html-revisor scopes: what you can pick in a page, and the markdown you would edit for each.
//
//   node scopes.mjs <file>              prints the scope tree of the body
//   node scopes.mjs --annotate <file>   writes, under each .ex example, its HTML and a table
//                                       of its scopes and their markdown (in place)
//
// Tier I, orchestration: the CLI. The scope rules are domain/scopes.mjs.
import { pathToFileURL } from 'node:url';
import { parse, serialize } from './domain/canonical.mjs';
import { scopeOf, report, annotate } from './domain/scopes.mjs';
import { readText, writeText } from './interface/files.mjs';

export async function main(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const annotating = args[0] === '--annotate';
  const files = annotating ? args.slice(1) : args;
  if (files.length === 0) {
    stderr.write('usage: node scopes.mjs [--annotate] <file>...\n');
    return 2;
  }
  for (const file of files) {
    const document = parse(await readText(file));
    if (annotating) {
      annotate(document);
      await writeText(file, serialize(document));
    } else {
      stdout.write(report(scopeOf(document.querySelector('body'))) + '\n');
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
