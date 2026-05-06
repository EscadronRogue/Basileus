import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  listExportedPersonalityFiles,
  readExportedPersonalitiesFromFolder,
} from './personality-files.js';

function profile(id, name) {
  return JSON.stringify({ id, name, weights: {}, tactics: {}, meta: {} }, null, 2);
}

test('runtime personality scan uses direct trained-personalities JSON files only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'basileus-personalities-'));
  try {
    await mkdir(join(root, 'latest'), { recursive: true });
    await mkdir(join(root, 'runs', '2026-05-06T13-46-32-612Z_seed-demo_g1_p2'), { recursive: true });

    await writeFile(join(root, 'alpha.json'), profile('alpha', 'Alpha'), 'utf8');
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ files: [{ file: 'ghost.json' }] }), 'utf8');
    await writeFile(join(root, 'latest', 'beta.json'), profile('beta', 'Beta'), 'utf8');
    await writeFile(join(root, 'runs', '2026-05-06T13-46-32-612Z_seed-demo_g1_p2', 'gamma.json'), profile('gamma', 'Gamma'), 'utf8');

    const files = await listExportedPersonalityFiles(root);
    assert.deepEqual(files.map(file => file.replace(`${root}/`, '')), ['alpha.json']);

    const profiles = await readExportedPersonalitiesFromFolder(root);
    assert.deepEqual(profiles.map(item => item.id), ['alpha']);
    assert.equal(profiles[0].file, 'alpha.json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('name-reservation scan can include archived runs without using latest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'basileus-personalities-'));
  try {
    const runDir = join(root, 'runs', '2026-05-06T13-46-32-612Z_seed-demo_g1_p2');
    await mkdir(join(root, 'latest'), { recursive: true });
    await mkdir(runDir, { recursive: true });

    await writeFile(join(root, 'alpha.json'), profile('alpha', 'Alpha'), 'utf8');
    await writeFile(join(root, 'latest', 'beta.json'), profile('beta', 'Beta'), 'utf8');
    await writeFile(join(runDir, 'gamma.json'), profile('gamma', 'Gamma'), 'utf8');

    const files = await listExportedPersonalityFiles(root, { includeRuns: true });
    assert.deepEqual(
      files.map(file => file.replace(`${root}/`, '')),
      [
        'alpha.json',
        'runs/2026-05-06T13-46-32-612Z_seed-demo_g1_p2/gamma.json',
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
