// Architecture: the import graph of the code, read from the source. No module imports itself
// through others, and the three tiers each keep to their own files, with dependencies
// pointing down:
//   Tier I   orchestration: the entry points, at the top level (the Contract names their paths)
//   Tier II  domain: domain/, pure functions
//   Tier III interface: interface/, the gateways to the world, and vendor/, the libraries
// The domain imports no gateway. A domain module that needs one partway through declares a port,
// a parameter of the shape it needs, and orchestration passes the adapter in: no import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['vendor', 'test', 'node_modules', '.claude', '.git', '.yaks']);

// Every .mjs file of ours, as a path from the root.
function sources(dir = ROOT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.name.endsWith('.mjs') ? [path.relative(ROOT, full)] : [];
  });
}

// What a file imports: './x.mjs' resolved to a path from the root, 'node:fs' as it is.
// Static imports, re-exports, and dynamic import() of a string.
function importsOf(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const specifiers = [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)]
    .map((m) => m[1] ?? m[2] ?? m[3]);
  return specifiers.map((s) => (s.startsWith('.') ? path.normalize(path.join(path.dirname(file), s)) : s));
}

const graph = () => new Map(sources().map((f) => [f, importsOf(f)]));

// ---- Tiers ----------------------------------------------------------------

const TIER_DIRS = { domain: 2, interface: 3, vendor: 3 };
const tierOf = (file) => (file.includes('/') ? TIER_DIRS[file.split('/')[0]] : 1);

// The domain is pure: it computes, and these are the only builtins it needs to.
const DOMAIN_BUILTINS = new Set(['node:crypto']);
// The world outside the process. Only the gateways in interface/ reach it.
const OUTSIDE = new Set(['node:fs', 'node:fs/promises', 'node:child_process']);

// Each rule broken, as "<file>: <what>". text: a file's source, for the purity check.
function violations(edges, text = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')) {
  const found = [];
  for (const [file, imports] of edges) {
    const tier = tierOf(file);
    if (!tier) {
      found.push(`${file}: in no tier`);
      continue;
    }
    for (const target of imports) {
      if (target.startsWith('node:')) {
        if (tier === 2 && !DOMAIN_BUILTINS.has(target)) found.push(`${file}: domain imports ${target}`);
        if (tier !== 3 && OUTSIDE.has(target)) found.push(`${file}: only interface/ imports ${target}`);
        continue;
      }
      const to = tierOf(target);
      if (!to) found.push(`${file}: imports ${target}, in no tier`);
      else if (to < tier) found.push(`${file}: Tier ${tier} imports ${target}, Tier ${to}`);
      else if (tier === 2 && !/^(domain|vendor)\//.test(target)) found.push(`${file}: domain imports ${target}`);
      else if (tier === 1 && target.startsWith('vendor/')) found.push(`${file}: orchestration imports ${target}`);
    }
    if (tier === 2 && /\b(process|console)\./.test(text(file))) found.push(`${file}: domain uses process or console`);
  }
  return found;
}

test('dependencies point down, and each tier keeps to its own files', () => {
  assert.deepEqual(violations(graph()), []);
});

test('the tier rules catch each kind of violation', () => {
  const edges = new Map([
    ['domain/a.mjs', ['server.mjs', 'interface/files.mjs', 'node:fs', 'node:crypto', 'vendor/lib.mjs', 'domain/b.mjs']],
    ['domain/b.mjs', []],
    ['interface/files.mjs', ['domain/b.mjs', 'node:fs']],
    ['server.mjs', ['node:child_process', 'vendor/lib.mjs', 'domain/a.mjs', 'interface/files.mjs', 'node:http']],
    ['scripts/x.mjs', []],
  ]);
  const text = (file) => (file === 'domain/b.mjs' ? 'console.log(1)' : '');
  assert.deepEqual(violations(edges, text), [
    'domain/a.mjs: Tier 2 imports server.mjs, Tier 1',
    'domain/a.mjs: domain imports interface/files.mjs',
    'domain/a.mjs: domain imports node:fs',
    'domain/a.mjs: only interface/ imports node:fs',
    'domain/b.mjs: domain uses process or console',
    'interface/files.mjs: Tier 3 imports domain/b.mjs, Tier 2',
    'server.mjs: only interface/ imports node:child_process',
    'server.mjs: orchestration imports vendor/lib.mjs',
    'scripts/x.mjs: in no tier',
  ]);
});

// Each cycle as the list of files around it, first file repeated at the end.
function cycles(edges) {
  const found = [];
  const done = new Set();
  const visit = (file, trail) => {
    const at = trail.indexOf(file);
    if (at >= 0) return found.push([...trail.slice(at), file]);
    if (done.has(file)) return;
    for (const next of edges.get(file) ?? []) if (edges.has(next)) visit(next, [...trail, file]);
    done.add(file);
  };
  for (const file of edges.keys()) visit(file, []);
  return found;
}

test('the source files are found, imports and all', () => {
  const edges = graph();
  assert.ok(edges.has('server.mjs'));
  assert.ok(edges.get('server.mjs').includes('node:http'));
});

test('no import cycles', () => {
  assert.deepEqual(cycles(graph()).map((c) => c.join(' → ')), []);
});

test('the cycle finder finds a cycle', () => {
  const edges = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']]]);
  assert.deepEqual(cycles(edges), [['a', 'b', 'c', 'a']]);
});
