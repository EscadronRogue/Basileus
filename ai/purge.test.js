import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCANNED_EXTENSIONS = new Set(['.bat', '.css', '.html', '.js', '.json', '.md', '.ps1', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'screenshots']);
const SKIP_FILES = new Set(['ai/purge.test.js']);
const LEGACY_TERMS = [
  ['trained', '-person', 'alities'],
  ['person', 'ality', ' pro', 'file'],
  ['person', 'ality', ' pro', 'files'],
  ['pro', 'file', ' store'],
  ['seat', ' pro', 'files'],
  ['ai', 'pro', 'file'],
  ['ai', 'pro', 'files'],
  ['baseline', 'ai', 'pro', 'file'],
  ['policy', 'gen', 'ome'],
  ['gen', 'ome'],
  ['evo', 'lution lab'],
  ['simu', 'lation lab'],
].map((parts) => parts.join(''));

function toPortablePath(path) {
  return path.replace(/\\/g, '/');
}

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      collectFiles(path, files);
      continue;
    }
    const relativePath = toPortablePath(relative(ROOT, path));
    if (SKIP_FILES.has(relativePath)) continue;
    if (SCANNED_EXTENSIONS.has(extname(path))) files.push(path);
  }
  return files;
}

test('retired named-seat AI traces are absent from active source', () => {
  const violations = [];
  for (const file of collectFiles(ROOT)) {
    const source = readFileSync(file, 'utf8').toLowerCase();
    for (const term of LEGACY_TERMS) {
      if (source.includes(term)) {
        violations.push(`${toPortablePath(relative(ROOT, file))}: ${term}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
