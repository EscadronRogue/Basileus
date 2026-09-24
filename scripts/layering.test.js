// scripts/layering.test.js - enforces which layers may import which.
//
//   data/        static game data
//   engine/      pure, deterministic rules (never the AI or UI)
//   ai/          AI planning on top of the engine
//   game/        runtime that drives engine + AI seats through a match
//   render/, ui/ browser presentation
//   multiplayer/ Node server
//
// Browser code must also stay free of Node built-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_LAYERS = {
  data: ['data'],
  engine: ['data', 'engine'],
  ai: ['data', 'engine', 'ai'],
  game: ['data', 'engine', 'ai', 'game'],
  render: ['data', 'engine', 'render', 'ui'],
  ui: ['data', 'engine', 'ai', 'game', 'render', 'ui'],
  multiplayer: ['data', 'engine', 'ai', 'game', 'multiplayer'],
};

// Offline CLI tools that simulate whole matches through the runtime.
const AI_TOOLS = new Set(['ai/simulate.js', 'ai/train.js']);
const NODE_ONLY = new Set(['ai/nodeOpponentRoster.js', ...AI_TOOLS]);

function listSources() {
  const files = [];
  for (const layer of Object.keys(ALLOWED_LAYERS)) {
    for (const name of readdirSync(join(root, layer))) {
      if (name.endsWith('.js') && !name.endsWith('.test.js')) files.push(`${layer}/${name}`);
    }
  }
  return files;
}

function listImports(file) {
  const source = readFileSync(join(root, file), 'utf8');
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...source.matchAll(pattern)].map((match) => match[1] || match[2] || match[3]);
}

function layerOf(file, specifier) {
  return relative(root, normalize(join(root, dirname(file), specifier))).split(/[\\/]/)[0];
}

test('each layer only imports the layers beneath it', () => {
  const violations = [];
  for (const file of listSources()) {
    const layer = file.split('/')[0];
    const allowed = new Set(ALLOWED_LAYERS[layer]);
    if (AI_TOOLS.has(file)) allowed.add('game');
    for (const specifier of listImports(file)) {
      if (!specifier.startsWith('.')) continue;
      const target = layerOf(file, specifier);
      if (!allowed.has(target)) violations.push(`${file} imports ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('browser code never imports Node built-ins', () => {
  const violations = [];
  for (const file of listSources()) {
    const layer = file.split('/')[0];
    if (layer === 'multiplayer' || NODE_ONLY.has(file)) continue;
    for (const specifier of listImports(file)) {
      if (specifier.startsWith('node:')) violations.push(`${file} imports ${specifier}`);
    }
  }
  for (const specifier of listImports('main.js')) {
    if (specifier.startsWith('node:')) violations.push(`main.js imports ${specifier}`);
  }
  assert.deepEqual(violations, []);
});
