import test from 'node:test';
import assert from 'node:assert/strict';

import { AI_ACTION_KINDS } from './actionSpace.js';
import { normalizeAiProfile } from './profileStore.js';
import {
  DEFAULT_POLICY_GENOME,
  POLICY_NUMERIC_TUNING_KEYS,
  mutatePolicyGenome,
  normalizePolicyGenome,
  scorePolicyAction,
} from './policyGenome.js';

test('old saved profiles normalize into the current policy genome schema', () => {
  const profile = normalizeAiProfile({
    id: 'legacy-trained',
    name: 'Legacy Trained',
    source: 'trained',
    weights: { wealth: 2.2 },
    tactics: {},
    meta: {},
  });

  assert.ok(profile.policy);
  assert.equal(profile.policy.version, DEFAULT_POLICY_GENOME.version);
  assert.equal(typeof profile.policy.actionPriors[AI_ACTION_KINDS.APPOINTMENT], 'number');
  assert.equal(typeof profile.policy.featureWeights.baseScore, 'number');
  assert.equal(typeof profile.policy.impactWeights.survival, 'number');
  assert.equal(typeof profile.policy.dealScoreWeights.actorUtility, 'number');
  assert.equal(typeof profile.policy.dealCounterpartySurplusCap, 'number');
  assert.equal(typeof profile.policy.mercenaryHireLimit, 'number');
  assert.deepEqual(profile.policy.numericTuning, {});
});

test('policy genome priors can choose between appointment and confirmation', () => {
  const appointmentPolicy = normalizePolicyGenome({
    actionPriors: {
      [AI_ACTION_KINDS.APPOINTMENT]: 4,
      [AI_ACTION_KINDS.CONFIRM_COURT]: -4,
    },
    baseScoreWeight: 0,
  });
  const confirmationPolicy = normalizePolicyGenome({
    actionPriors: {
      [AI_ACTION_KINDS.APPOINTMENT]: -4,
      [AI_ACTION_KINDS.CONFIRM_COURT]: 4,
    },
    baseScoreWeight: 0,
  });
  const appointment = { kind: AI_ACTION_KINDS.APPOINTMENT, baseScore: 0 };
  const confirm = { kind: AI_ACTION_KINDS.CONFIRM_COURT, baseScore: 0 };

  assert.equal(
    scorePolicyAction(appointmentPolicy, appointment, {}) > scorePolicyAction(appointmentPolicy, confirm, {}),
    true,
  );
  assert.equal(
    scorePolicyAction(confirmationPolicy, confirm, {}) > scorePolicyAction(confirmationPolicy, appointment, {}),
    true,
  );
});

test('policy genome ignores legacy numeric tuning payloads', () => {
  const policy = normalizePolicyGenome({
    numericTuning: {
      N_0_5: 2,
    },
  });

  assert.deepEqual(POLICY_NUMERIC_TUNING_KEYS, []);
  assert.deepEqual(policy.numericTuning, {});

  const rngValues = [0.9, 0.8, 0.7, 0.6];
  let index = 0;
  const mutated = mutatePolicyGenome(policy, () => rngValues[index++ % rngValues.length]);
  assert.deepEqual(mutated.numericTuning, {});
});
