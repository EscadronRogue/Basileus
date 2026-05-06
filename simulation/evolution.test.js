import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAiProfile } from '../ai/profileStore.js';
import { DEFAULT_META_PARAMS, NEUTRAL_PROFILE } from '../ai/personalities.js';
import {
  buildEvaluationSuite,
  buildSelectionEntry,
  buildTrainingScenarioPlan,
  DEFAULT_FITNESS_WEIGHTS,
  evaluateCandidateOnSuite,
  normalizeTrainingConfig,
  rankSelectionEntries,
} from './evolution.js';
import { runSingleSimulationGame } from './engine.js';

function makeSummary(overrides = {}) {
  return {
    matches: 8,
    wins: 2,
    winShare: 0.25,
    finalScoreMean: 10,
    finalScorePlacement: 0.5,
    finalScoreAdvantage: 1,
    survivingFinalScoreMean: 11,
    empireFallRate: 0,
    guardRate: 0,
    unsafeRate: 0,
    averageFitness: 1,
    opponentVariance: 0.01,
    seatVariance: 0.01,
    mirroredSeatEquity: 1,
    mirroredSeatVariance: 0,
    perOpponentClassWinRate: {
      scripted: { winRate: 0.25 },
      hof: { winRate: 0.25 },
      emergent: { winRate: 0.25 },
    },
    behaviorVector: Array(11).fill(0.5),
    ...overrides,
  };
}

function makeProfile(id = 'test-candidate') {
  return normalizeAiProfile({
    id,
    name: id,
    source: 'emergent-trained',
    weights: { ...NEUTRAL_PROFILE.weights },
    tactics: {
      independence: 1,
      frontierAlarm: 1,
      churchReserve: 1,
      incumbencyGrip: 1,
    },
    meta: { ...DEFAULT_META_PARAMS },
  });
}

function makeCandidate(id = 'test-candidate') {
  const profile = makeProfile(id);
  return {
    id,
    name: id,
    weights: { ...profile.weights },
    tactics: { ...profile.tactics },
    meta: { ...profile.meta },
    profile,
  };
}

test('pareto-first ranking still rewards stronger competitive candidates over merely safer weak ones', () => {
  const safeWeak = buildSelectionEntry(
    { id: 'safe-weak' },
    1,
    makeSummary({ winShare: 0.22, finalScoreMean: 9 }),
    makeSummary({ winShare: 0.22, finalScoreMean: 9 }),
    0.1
  );
  const safeStrong = buildSelectionEntry(
    { id: 'safe-strong' },
    1,
    makeSummary({ winShare: 0.34, finalScoreMean: 13, finalScoreAdvantage: 2.2 }),
    makeSummary({ winShare: 0.34, finalScoreMean: 13, finalScoreAdvantage: 2.2 }),
    0.1
  );
  const higherWinWithFalls = buildSelectionEntry(
    { id: 'higher-win-with-falls' },
    1,
    makeSummary({ winShare: 0.6, finalScoreMean: 20, finalScoreAdvantage: 6, empireFallRate: 0.25, unsafeRate: 0.25 }),
    makeSummary({ winShare: 0.6, finalScoreMean: 20, finalScoreAdvantage: 6, empireFallRate: 0.25, unsafeRate: 0.25 }),
    0.9
  );

  const { rankedEntries, safetyMode } = rankSelectionEntries([higherWinWithFalls, safeWeak, safeStrong]);
  assert.equal(safetyMode, 'pareto-score-novelty');
  assert.deepEqual(rankedEntries.map(entry => entry.candidate.id), ['higher-win-with-falls', 'safe-strong', 'safe-weak']);
});

test('guard failures remain the strongest safety penalty among near-tied candidates', () => {
  const sameWinHighGuard = buildSelectionEntry(
    { id: 'same-win-high-guard' },
    1,
    makeSummary({ winShare: 0.4, guardRate: 0.2, empireFallRate: 0.05, unsafeRate: 0.25, finalScoreMean: 14 }),
    makeSummary({ winShare: 0.4, guardRate: 0.2, empireFallRate: 0.05, unsafeRate: 0.25, finalScoreMean: 14 }),
    0.1
  );
  const sameWinHighFall = buildSelectionEntry(
    { id: 'same-win-high-fall' },
    1,
    makeSummary({ winShare: 0.4, guardRate: 0.05, empireFallRate: 0.15, unsafeRate: 0.2, finalScoreMean: 11 }),
    makeSummary({ winShare: 0.4, guardRate: 0.05, empireFallRate: 0.15, unsafeRate: 0.2, finalScoreMean: 11 }),
    0.1
  );
  const sameWinLowRisk = buildSelectionEntry(
    { id: 'same-win-low-risk' },
    1,
    makeSummary({ winShare: 0.4, guardRate: 0.05, empireFallRate: 0.05, unsafeRate: 0.1, finalScoreMean: 10 }),
    makeSummary({ winShare: 0.4, guardRate: 0.05, empireFallRate: 0.05, unsafeRate: 0.1, finalScoreMean: 10 }),
    0.1
  );

  const { rankedEntries, safetyMode } = rankSelectionEntries([sameWinHighGuard, sameWinHighFall, sameWinLowRisk]);
  assert.equal(safetyMode, 'pareto-score-novelty');
  assert.deepEqual(rankedEntries.map(entry => entry.candidate.id), ['same-win-low-risk', 'same-win-high-fall', 'same-win-high-guard']);
});

test('validation suites mirror the focal candidate across every seat for the same scenario seed', () => {
  const config = normalizeTrainingConfig({
    scenarioMode: 'focused',
    playerCount: 4,
    deckSize: 6,
    validationMatchesPerCandidate: 2,
  });
  const suite = buildEvaluationSuite(config, 'validation', 3, 2, 'late');

  assert.equal(suite.length, 2);
  assert.deepEqual(suite[0].mirroredSeats, [0, 1, 2, 3]);
  assert.equal(suite[0].mirrorGroupKey, 'validation:4p-6d:g3:m0');
  assert.equal(suite[0].seed, `${config.seed}:validation:4p-6d:g3:m0`);
  assert.equal(suite[1].focalSeat, 1);
});

test('generalist suite cycles uniformly across the scenario matrix', () => {
  const config = normalizeTrainingConfig({
    scenarioMode: 'generalist',
    playerCounts: [3, 5],
    deckSizes: [6, 12],
    matchesPerCandidate: 8,
  });
  const plan = buildTrainingScenarioPlan(config);
  assert.deepEqual(plan.map(entry => entry.key), ['3p-6d', '3p-12d', '5p-6d', '5p-12d']);

  const suite = buildEvaluationSuite(config, 'training', 1, 8, 'mid');
  assert.equal(new Set(suite.map(entry => entry.scenarioKey)).size, 4);
  assert.deepEqual(suite.slice(0, 4).map(entry => entry.scenarioKey), ['3p-6d', '3p-12d', '5p-6d', '5p-12d']);
});

test('evaluation summaries include per-scenario final-score metrics', () => {
  const config = normalizeTrainingConfig({
    seed: 12345,
    scenarioMode: 'generalist',
    playerCounts: [3],
    deckSizes: [6, 9],
    matchesPerCandidate: 2,
  });
  const suite = buildEvaluationSuite(config, 'training', 1, 2, 'late');
  const candidate = makeCandidate('scenario-summary');
  const summary = evaluateCandidateOnSuite(candidate, suite, {
    config,
    generation: 1,
    scope: 'training',
    population: [candidate],
    hallOfFame: [],
  }, DEFAULT_FITNESS_WEIGHTS);

  assert.equal(summary.matches, 2);
  assert.equal(summary.perScenario.length, 2);
  assert.equal(summary.perScenario.reduce((total, entry) => total + entry.matches, 0), summary.matches);
  assert.ok(Number.isFinite(summary.finalScoreMean));
  assert.ok(Number.isFinite(summary.survivingFinalScoreMean));
});

test('mirrored validation summaries include seat-equity diagnostics', () => {
  const config = normalizeTrainingConfig({
    seed: 2468,
    scenarioMode: 'focused',
    playerCount: 4,
    deckSize: 6,
    validationMatchesPerCandidate: 2,
  });
  const suite = buildEvaluationSuite(config, 'validation', 1, 2, 'late');
  const candidate = makeCandidate('mirrored-validation');
  const summary = evaluateCandidateOnSuite(candidate, suite, {
    config,
    generation: 1,
    scope: 'validation',
    population: [candidate],
    hallOfFame: [],
  }, DEFAULT_FITNESS_WEIGHTS);

  assert.equal(summary.matches, 8);
  assert.equal(summary.perScenario.reduce((total, entry) => total + entry.matches, 0), summary.matches);
  assert.ok(summary.mirroredSeatEquity >= 0 && summary.mirroredSeatEquity <= 1);
  assert.ok(summary.mirroredSeatVariance >= 0);
  assert.equal(Object.keys(summary.perSeatWinRate).length, 4);
});

test('symmetric self-play stays within seat-fairness bounds over 400 games', { timeout: 120000 }, () => {
  const seatProfiles = {
    0: makeProfile('sym-seat-0'),
    1: makeProfile('sym-seat-1'),
    2: makeProfile('sym-seat-2'),
    3: makeProfile('sym-seat-3'),
  };
  const seatWins = [0, 0, 0, 0];
  const games = 400;

  for (let index = 0; index < games; index++) {
    const game = runSingleSimulationGame({
      playerCount: 4,
      deckSize: 6,
      seed: `symmetry-${index}`,
      seatProfiles,
      strictTimeoutMs: 15000,
      maxLoopIterations: 256,
      maxRounds: 40,
    });
    for (const metric of game.playerMetrics) {
      if (!metric.isWinner) continue;
      seatWins[metric.playerId] += 1 / Math.max(1, game.winners.length);
    }
  }

  const seatWinShares = seatWins.map(value => value / games);
  const meanWinShare = seatWinShares.reduce((total, value) => total + value, 0) / seatWinShares.length;

  seatWinShares.forEach(winShare => {
    assert.ok(winShare <= 0.4, `Expected no seat above 0.40 win share, got ${winShare.toFixed(4)}.`);
    assert.ok(Math.abs(winShare - meanWinShare) <= 0.08, `Expected seat win share ${winShare.toFixed(4)} to stay within 0.08 of mean ${meanWinShare.toFixed(4)}.`);
  });
});
