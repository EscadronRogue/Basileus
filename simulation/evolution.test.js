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

test('training config defaults to broad scenario coverage', () => {
  const config = normalizeTrainingConfig({});

  assert.deepEqual(config.playerCounts, [3, 4, 5]);
  assert.deepEqual(config.deckSizes, [6, 9, 12]);
  assert.equal(config.populationSize, 32);
  assert.equal(config.champions, 10);
  assert.equal(config.holdoutMatchesPerChampion, 1024);
  assert.equal(Number.isInteger(config.seed), true);
});

test('training config can still be focused explicitly', () => {
  const config = normalizeTrainingConfig({
    playerCount: 4,
    deckSize: 12,
    populationSize: 4,
  });

  assert.deepEqual(config.playerCounts, [4]);
  assert.deepEqual(config.deckSizes, [12]);
  assert.equal(config.populationSize, 4);
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

test('training config includes deal fitness shaping fields', () => {
  const config = normalizeTrainingConfig({
    fitnessPresetId: 'custom',
    fitness: {
      dealUtilityReward: 0.75,
      dealAcceptanceReward: 0.25,
      badDealPenalty: 2.25,
    },
  });

  assert.equal(config.fitness.dealUtilityReward, 0.75);
  assert.equal(config.fitness.dealAcceptanceReward, 0.25);
  assert.equal(config.fitness.badDealPenalty, 2.25);
  assert.equal(FITNESS_TUNING_FIELDS.some((entry) => entry.key === 'dealUtilityReward'), true);
});

test('training config includes systemic judgment fitness shaping fields', () => {
  const config = normalizeTrainingConfig({
    fitnessPresetId: 'custom',
    fitness: {
      decisionQualityReward: 0.8,
      projectionErrorPenalty: 0.4,
    },
  });

  assert.equal(config.fitness.decisionQualityReward, 0.8);
  assert.equal(config.fitness.projectionErrorPenalty, 0.4);
  assert.equal(FITNESS_TUNING_FIELDS.some((entry) => entry.key === 'decisionQualityReward'), true);
  assert.equal(FITNESS_TUNING_FIELDS.some((entry) => entry.key === 'projectionErrorPenalty'), true);
});
