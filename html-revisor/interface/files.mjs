// The filesystem gateway: every read and write of a file, watching one for changes, and the
// file as of the last commit.
// Tier III.
import { execFile } from 'node:child_process';
import { watch as fsWatch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const readText = (file) => fs.readFile(file, 'utf8');
export const readBytes = (file) => fs.readFile(file);
export const writeText = (file, text) => fs.writeFile(file, text);
export const listDirectory = (dir) => fs.readdir(dir, { withFileTypes: true });

// Call onChange when the file may have changed, once it has been quiet for quietMs. It watches
// the file's directory, not the file: an editor that saves by writing a new file and renaming it
// over the old one leaves a watch on the file pointed at the old one. One save fires fs.watch
// several times; waiting for quiet makes it one call, and keeps a reader off a half-written file.
// Returns a function that stops watching.
export function watchFile(file, onChange, quietMs = 100) {
  const name = path.basename(file);
  let timer = null;
  const watcher = fsWatch(path.dirname(file), (_, changed) => {
    if (changed && changed.toString() !== name) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, quietMs);
  });
  watcher.on('error', () => {});
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

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
