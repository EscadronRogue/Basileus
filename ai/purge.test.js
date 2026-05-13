import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCANNED_EXTENSIONS = new Set(['.bat', '.css', '.html', '.js', '.json', '.md', '.ps1', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'screenshots']);
const SKIP_FILES = new Set(['ai/purge.test.js']);
const BANNED_TERMS = [
  ['profile', 'Store'],
  ['policy', 'Genome'],
  ['trained', '-personalities'],
  ['training', '-result'],
  ['train', ':node'],
  ['test', ':evolution'],
  ['smoke', ':simulation'],
  ['Simulation', ' Lab'],
  ['simulator', '.html'],
  ['evolution'],
  ['training'],
  ['trained'],
  ['policy', ' profile'],
  ['AI', ' policy'],
  ['ai', 'Profiles'],
  ['ai', 'SeatProfiles'],
  ['seat', 'Profiles'],
  ['create', 'BaselineAiProfile'],
  ['normalize', 'AiProfile'],
  ['numeric', 'Constants'],
  ['consequences'],
  ['../ai/', 'context'],
  ['./ai/', 'context'],
].map(parts => parts.join(''));

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

test('old AI and trainer terms are absent from active source', () => {
  const violations = [];
  for (const file of collectFiles(ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const term of BANNED_TERMS) {
      if (source.includes(term)) {
        violations.push(`${toPortablePath(relative(ROOT, file))}: ${term}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
