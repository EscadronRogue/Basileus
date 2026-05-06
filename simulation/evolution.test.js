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
    perOpponentClassWinRate: {
      scripted: { winRate: 0.25 },
      hof: { winRate: 0.25 },
      emergent: { winRate: 0.25 },
    },
    behaviorVector: Array(11).fill(0.5),
    ...overrides,
  };
}

function makeCandidate(id = 'test-candidate') {
  const profile = normalizeAiProfile({
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
  return {
    id,
    name: id,
    weights: { ...profile.weights },
    tactics: { ...profile.tactics },
    meta: { ...profile.meta },
    profile,
  };
}

test('survival-gated ranking keeps safe candidates ahead of unsafe ones', () => {
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
  const unsafeHighScore = buildSelectionEntry(
    { id: 'unsafe-high-score' },
    1,
    makeSummary({ winShare: 0.6, finalScoreMean: 20, finalScoreAdvantage: 6, empireFallRate: 0.25, unsafeRate: 0.25 }),
    makeSummary({ winShare: 0.6, finalScoreMean: 20, finalScoreAdvantage: 6, empireFallRate: 0.25, unsafeRate: 0.25 }),
    0.9
  );

  const { rankedEntries, safetyMode } = rankSelectionEntries([unsafeHighScore, safeWeak, safeStrong]);
  assert.equal(safetyMode, 'safe-only');
  assert.deepEqual(rankedEntries.slice(0, 2).map(entry => entry.candidate.id), ['safe-strong', 'safe-weak']);
  assert.equal(rankedEntries[2].candidate.id, 'unsafe-high-score');
});

test('minimum-risk fallback prefers lower guard rate before fall rate', () => {
  const riskyA = buildSelectionEntry(
    { id: 'risky-a' },
    1,
    makeSummary({ guardRate: 0.2, empireFallRate: 0.05, unsafeRate: 0.25, finalScoreMean: 14 }),
    makeSummary({ guardRate: 0.2, empireFallRate: 0.05, unsafeRate: 0.25, finalScoreMean: 14 }),
    0.1
  );
  const riskyB = buildSelectionEntry(
    { id: 'risky-b' },
    1,
    makeSummary({ guardRate: 0.05, empireFallRate: 0.15, unsafeRate: 0.2, finalScoreMean: 11 }),
    makeSummary({ guardRate: 0.05, empireFallRate: 0.15, unsafeRate: 0.2, finalScoreMean: 11 }),
    0.1
  );
  const riskyC = buildSelectionEntry(
    { id: 'risky-c' },
    1,
    makeSummary({ guardRate: 0.05, empireFallRate: 0.05, unsafeRate: 0.1, finalScoreMean: 10 }),
    makeSummary({ guardRate: 0.05, empireFallRate: 0.05, unsafeRate: 0.1, finalScoreMean: 10 }),
    0.1
  );

  const { rankedEntries, safetyMode } = rankSelectionEntries([riskyA, riskyB, riskyC]);
  assert.equal(safetyMode, 'minimum-risk');
  assert.equal(rankedEntries[0].candidate.id, 'risky-c');
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
