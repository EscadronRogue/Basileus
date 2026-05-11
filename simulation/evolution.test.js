import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateTrainingMatches, FITNESS_TUNING_FIELDS, normalizeTrainingConfig } from './evolution.js';

test('training config preserves user-provided upper values for trainer sizing', () => {
  const config = normalizeTrainingConfig({
    playerCount: 4,
    populationSize: 1000,
    generations: 1000,
    matchesPerCandidate: 128,
    validationMatchesPerCandidate: 96,
    holdoutMatchesPerChampion: 512,
    champions: 200,
    hallOfFameSize: 400,
    parallelWorkers: 48,
  });

  assert.equal(config.populationSize, 1000);
  assert.equal(config.generations, 1000);
  assert.equal(config.matchesPerCandidate, 128);
  assert.equal(config.validationMatchesPerCandidate, 96);
  assert.equal(config.holdoutMatchesPerChampion, 512);
  assert.equal(config.champions, 200);
  assert.equal(config.hallOfFameSize, 400);
  assert.equal(config.parallelWorkers, 48);
});

test('training config still enforces structural minimums', () => {
  const config = normalizeTrainingConfig({
    playerCount: 5,
    populationSize: 2,
    generations: 0,
    matchesPerCandidate: 0,
    validationMatchesPerCandidate: 0,
    holdoutMatchesPerChampion: 1,
    champions: 0,
    hallOfFameSize: -3,
    parallelWorkers: -2,
  });

  assert.equal(config.populationSize, 5);
  assert.equal(config.generations, 1);
  assert.equal(config.matchesPerCandidate, 1);
  assert.equal(config.validationMatchesPerCandidate, 1);
  assert.equal(config.holdoutMatchesPerChampion, 16);
  assert.equal(config.champions, 1);
  assert.equal(config.hallOfFameSize, 0);
  assert.equal(config.parallelWorkers, 0);
});

test('training match estimates use the full requested trainer sizes', () => {
  const total = estimateTrainingMatches({
    playerCount: 4,
    populationSize: 1000,
    generations: 1000,
    matchesPerCandidate: 128,
    validationMatchesPerCandidate: 96,
    holdoutMatchesPerChampion: 512,
    champions: 200,
  });

  assert.equal(total, (1000 * 1000 * (128 + 96)) + (600 * 512));
});

test('training UI metadata labels final score reward without breaking the wealth key', () => {
  const field = FITNESS_TUNING_FIELDS.find((entry) => entry.key === 'wealthReward');

  assert.ok(field);
  assert.equal(field.label, 'Score Reward');
  assert.match(field.hint, /final score/i);
});
