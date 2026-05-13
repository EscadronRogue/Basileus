import test from 'node:test';
import assert from 'node:assert/strict';

import { NEUTRAL_PROFILE } from '../ai/personalities.js';
import { DEFAULT_FITNESS_WEIGHTS, estimateTrainingMatches, FITNESS_TUNING_FIELDS, normalizeTrainingConfig, runEvolutionTraining } from './evolution.js';
import { installNodeWorkerShim } from './node-worker-shim.js';

test('training config preserves user-provided upper values for trainer sizing', () => {
  const config = normalizeTrainingConfig({
    playerCount: 4,
    populationSize: 1000,
    generations: 1000,
    matchesPerCandidate: 128,
    validationMatchesPerCandidate: 96,
    holdoutMatchesPerChampion: 512,
    finalAuditMatchesPerChampion: 64,
    champions: 200,
    hallOfFameSize: 400,
    parallelWorkers: 48,
  });

  assert.equal(config.populationSize, 1000);
  assert.equal(config.generations, 1000);
  assert.equal(config.matchesPerCandidate, 128);
  assert.equal(config.validationMatchesPerCandidate, 96);
  assert.equal(config.holdoutMatchesPerChampion, 512);
  assert.equal(config.finalAuditMatchesPerChampion, 64);
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
    finalAuditMatchesPerChampion: -1,
    champions: 0,
    hallOfFameSize: -3,
    parallelWorkers: -2,
  });

  assert.equal(config.populationSize, 5);
  assert.equal(config.generations, 1);
  assert.equal(config.matchesPerCandidate, 1);
  assert.equal(config.validationMatchesPerCandidate, 1);
  assert.equal(config.holdoutMatchesPerChampion, 1);
  assert.equal(config.finalAuditMatchesPerChampion, 0);
  assert.equal(config.champions, 1);
  assert.equal(config.hallOfFameSize, 0);
  assert.equal(config.parallelWorkers, 0);
});

test('training config defaults to broad scenario coverage', () => {
  const config = normalizeTrainingConfig({});

  assert.deepEqual(config.playerCounts, [3, 4, 5]);
  assert.deepEqual(config.deckSizes, [6, 9, 12]);
  assert.equal(config.populationSize, 48);
  assert.equal(config.generations, 45);
  assert.equal(config.matchesPerCandidate, 32);
  assert.equal(config.validationMatchesPerCandidate, 12);
  assert.equal(config.champions, 12);
  assert.equal(config.holdoutMatchesPerChampion, 1536);
  assert.equal(config.finalAuditMatchesPerChampion, 192);
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
    finalAuditMatchesPerChampion: 64,
    champions: 200,
  });

  assert.equal(total, (1000 * 1000 * (128 + 96)) + (600 * 512) + (200 * 64));
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

test('default training fitness is outcome-first', () => {
  assert.equal(DEFAULT_FITNESS_WEIGHTS.dealUtilityReward, 0);
  assert.equal(DEFAULT_FITNESS_WEIGHTS.dealAcceptanceReward, 0);
  assert.equal(DEFAULT_FITNESS_WEIGHTS.badDealPenalty, 0);
  assert.equal(DEFAULT_FITNESS_WEIGHTS.decisionQualityReward, 0);
  assert.equal(DEFAULT_FITNESS_WEIGHTS.projectionErrorPenalty, 0);
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

test('tiny training run evolves full policy genomes and reports final audit separately', async () => {
  const result = await runEvolutionTraining({
    seed: 12345,
    playerCount: 3,
    deckSize: 1,
    populationSize: 3,
    generations: 1,
    matchesPerCandidate: 1,
    validationMatchesPerCandidate: 1,
    holdoutMatchesPerChampion: 1,
    finalAuditMatchesPerChampion: 1,
    champions: 1,
    hallOfFameSize: 2,
    parallelWorkers: 0,
  });

  assert.equal(result.champions.length, 1);
  assert.ok(result.champions[0].policy);
  assert.equal(typeof result.champions[0].policy.actionPriors.appointment, 'number');
  assert.deepEqual(result.champions[0].policy.numericTuning, {});
  assert.deepEqual(result.champions[0].weights, NEUTRAL_PROFILE.weights);
  assert.deepEqual(result.champions[0].meta, NEUTRAL_PROFILE.meta);
  assert.equal(result.finalAudit.length, 1);
  assert.equal(result.finalAudit[0].matches, 1);
  assert.ok(result.finalAudit[0].perScenarioWinRate);
  assert.ok(result.finalAudit[0].perSeatWinRate);
  assert.ok(result.finalAudit[0].perOpponentTypeWinRate);
});

test('same seed produces repeatable tiny training output', async () => {
  const config = {
    seed: 2468,
    playerCount: 3,
    deckSize: 1,
    populationSize: 3,
    generations: 1,
    matchesPerCandidate: 1,
    validationMatchesPerCandidate: 1,
    holdoutMatchesPerChampion: 1,
    finalAuditMatchesPerChampion: 0,
    champions: 1,
    hallOfFameSize: 2,
    parallelWorkers: 0,
  };

  const first = await runEvolutionTraining(config);
  const second = await runEvolutionTraining(config);

  assert.equal(second.champions[0].training.holdoutWinShare, first.champions[0].training.holdoutWinShare);
  assert.deepEqual(second.champions[0].policy, first.champions[0].policy);
});

test('worker and sequential tiny training produce identical champions', async () => {
  installNodeWorkerShim();
  const config = {
    seed: 13579,
    playerCount: 3,
    deckSize: 1,
    populationSize: 4,
    generations: 1,
    matchesPerCandidate: 1,
    validationMatchesPerCandidate: 1,
    holdoutMatchesPerChampion: 1,
    finalAuditMatchesPerChampion: 1,
    champions: 1,
    hallOfFameSize: 2,
  };

  const sequential = await runEvolutionTraining({ ...config, parallelWorkers: 0 });
  const parallel = await runEvolutionTraining({ ...config, parallelWorkers: 2 });

  assert.equal(parallel.overview.totalMatches, estimateTrainingMatches({ ...config, parallelWorkers: 2 }));
  assert.equal(parallel.champions[0].training.holdoutWinShare, sequential.champions[0].training.holdoutWinShare);
  assert.deepEqual(parallel.champions[0].policy, sequential.champions[0].policy);
  assert.equal(parallel.finalAudit[0].matches, sequential.finalAudit[0].matches);
});

test('training progress reports throughput and does not skip configured matches', async () => {
  const progressEvents = [];
  const config = {
    seed: 97531,
    playerCount: 3,
    deckSize: 1,
    populationSize: 3,
    generations: 1,
    matchesPerCandidate: 1,
    validationMatchesPerCandidate: 1,
    holdoutMatchesPerChampion: 1,
    finalAuditMatchesPerChampion: 1,
    champions: 1,
    hallOfFameSize: 2,
    parallelWorkers: 0,
  };

  const result = await runEvolutionTraining(config, progress => progressEvents.push(progress));
  const expectedMatches = estimateTrainingMatches(config);
  const finalProgress = progressEvents[progressEvents.length - 1];

  assert.equal(result.overview.totalMatches, expectedMatches);
  assert.equal(finalProgress.completed, expectedMatches);
  assert.equal(typeof finalProgress.phaseMatchesPerSecond, 'number');
  assert.equal(typeof finalProgress.workerUtilization, 'number');
  assert.ok(result.overview.performance);
  assert.equal(result.overview.performance.workerFallbacks, 0);
});
