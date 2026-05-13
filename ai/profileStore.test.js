import test from 'node:test';
import assert from 'node:assert/strict';

import { listAvailableAiProfiles } from './profileStore.js';

test('profile library falls back to a neutral baseline policy when no exported roster is readable', async () => {
  const profiles = await listAvailableAiProfiles();
  const baseline = profiles.find(profile => profile.id === 'baseline-policy');

  assert.ok(baseline);
  assert.equal(baseline.source, 'baseline-policy');
  assert.equal(baseline.librarySource, 'baseline');
  assert.ok(baseline.policy);
  assert.deepEqual(baseline.policy.numericTuning, {});
});
