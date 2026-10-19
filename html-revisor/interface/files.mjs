// The filesystem gateway: every read and write of a file, and the file as of the last commit.
// Tier III.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const readText = (file) => fs.readFile(file, 'utf8');
export const readBytes = (file) => fs.readFile(file);
export const writeText = (file, text) => fs.writeFile(file, text);
export const listDirectory = (dir) => fs.readdir(dir, { withFileTypes: true });

// False for a file, and for nothing there at all.
export async function isDirectory(file) {
  return (await fs.stat(file).catch(() => null))?.isDirectory() ?? false;
}

// The file as of the last commit, or null when it isn't in a git repository or isn't committed.
export function readCommitted(file) {
  return new Promise((resolve) => {
    execFile('git', ['show', `HEAD:./${path.basename(file)}`], { cwd: path.dirname(file), maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

// Client assets, injected into each served page. Read on each GET, so a change to client.css
// or client.js shows on reload without a restart.
const readAsset = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8');
export async function readClientAssets() {
  const [css, js] = await Promise.all([readAsset('client.css'), readAsset('client.js')]);
  return { css, js };
}
