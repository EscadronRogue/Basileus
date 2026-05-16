import {
  createMatchEpisodeOptions,
  describeStrategy,
  evaluateStrategy,
  strategyIdsForEvaluation,
} from './selfPlay.js';
import { RANDOM_OPPONENT_ID } from './heuristics.js';

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roleMetric(stats = {}, key, role) {
  return finiteNumber(stats?.[key]?.[role] ?? stats?.[key]?.[String(role)]);
}

export function scoreEvaluationStats(stats = {}, role = RANDOM_OPPONENT_ID) {
  const reward = roleMetric(stats, 'rewardByRole', role);
  const winRate = roleMetric(stats, 'winRateByRole', role);
  const points = roleMetric(stats, 'averagePointsByRole', role);
  const survivalRate = roleMetric(stats, 'survivalRateByRole', role);
  const fallRate = roleMetric(stats, 'fallRateByRole', role);
  const truncatedRate = roleMetric(stats, 'truncatedRateByRole', role);
  return reward + (0.45 * winRate) + (0.08 * points) + (0.2 * survivalRate) - fallRate - truncatedRate;
}

function summarizeRole(stats, role) {
  return {
    reward: roleMetric(stats, 'rewardByRole', role),
    winRate: roleMetric(stats, 'winRateByRole', role),
    averagePoints: roleMetric(stats, 'averagePointsByRole', role),
    survivalRate: roleMetric(stats, 'survivalRateByRole', role),
    fallRate: roleMetric(stats, 'fallRateByRole', role),
    truncatedRate: roleMetric(stats, 'truncatedRateByRole', role),
    appearances: roleMetric(stats, 'appearancesByRole', role),
    score: scoreEvaluationStats(stats, role),
  };
}

function deriveTournamentSeed(baseSeed, index = 0) {
  const base = Number.isFinite(Number(baseSeed)) ? Number(baseSeed) : 90_000;
  let value = (base >>> 0) + Math.imul(Math.floor(Number(index) || 0), 0x9e3779b9);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) || 1;
}

function summarizeConfidence(values = []) {
  const samples = values.filter((value) => Number.isFinite(value));
  const count = samples.length;
  if (!count) return { count: 0, mean: 0, standardDeviation: 0, standardError: 0, margin95: 0 };
  const mean = samples.reduce((sum, value) => sum + value, 0) / count;
  const variance = count > 1
    ? samples.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (count - 1)
    : 0;
  const standardDeviation = Math.sqrt(variance);
  const standardError = standardDeviation / Math.sqrt(count);
  const margin95 = count > 1 ? 1.96 * standardError : 0;
  return {
    count,
    mean,
    standardDeviation,
    standardError,
    margin95,
    lower95: mean - margin95,
    upper95: mean + margin95,
  };
}

function commonOptions(options = {}) {
  return {
    episodes: Math.max(1, Number(options.episodes) || 12),
    playerCount: options.playerCount,
    playerMin: options.playerMin,
    playerMax: options.playerMax,
    deckSize: options.deckSize,
    roundMin: options.roundMin,
    roundMax: options.roundMax,
    maxSteps: options.maxSteps,
    maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer,
    searchDepth: options.searchDepth,
  };
}

function runOneMatchup(primaryId, opponentId, options = {}) {
  const common = commonOptions(options);
  const stats = evaluateStrategy({
    ...common,
    seed: options.seed,
    episodeOptions: createMatchEpisodeOptions(primaryId, opponentId, common),
  });
  return {
    primaryStrategy: describeStrategy(primaryId),
    opponentStrategy: describeStrategy(opponentId),
    episodes: common.episodes,
    seed: options.seed ?? null,
    primaryRole: primaryId,
    opponentRole: opponentId,
    primary: summarizeRole(stats, primaryId),
    opponent: summarizeRole(stats, opponentId),
    stats,
  };
}

export function runTournament(options = {}) {
  const primaryId = options.primaryId || options.strategyId || 'alexios';
  const opponentId = options.opponentId || RANDOM_OPPONENT_ID;
  return runOneMatchup(primaryId, opponentId, options);
}

function aggregateMatchupRuns(runs = [], roleKey = 'primary') {
  return {
    score: summarizeConfidence(runs.map((run) => run[roleKey]?.score)).mean,
    adjustedScore: summarizeConfidence(runs.map((run) => run[roleKey]?.score)).lower95,
    winRate: summarizeConfidence(runs.map((run) => run[roleKey]?.winRate)).mean,
    averagePoints: summarizeConfidence(runs.map((run) => run[roleKey]?.averagePoints)).mean,
    reward: summarizeConfidence(runs.map((run) => run[roleKey]?.reward)).mean,
    survivalRate: summarizeConfidence(runs.map((run) => run[roleKey]?.survivalRate)).mean,
    confidence: summarizeConfidence(runs.map((run) => run[roleKey]?.score)),
  };
}

export function runTournamentSuite(options = {}) {
  const seedCount = Math.max(1, Math.floor(Number(options.seedCount ?? options.evalSeedCount ?? 1) || 1));
  const primaryId = options.primaryId || options.strategyId || 'alexios';
  const opponentId = options.opponentId || RANDOM_OPPONENT_ID;
  const runs = Array.from({ length: seedCount }, (_, index) => runTournament({
    ...options,
    primaryId,
    opponentId,
    seed: deriveTournamentSeed(options.seed, index),
  }));
  const confidence = summarizeConfidence(runs.map((run) => run.primary.score));
  return {
    primaryStrategy: describeStrategy(primaryId),
    opponentStrategy: describeStrategy(opponentId),
    episodes: Math.max(1, Number(options.episodes) || 12),
    seed: Number.isFinite(Number(options.seed)) ? Number(options.seed) : null,
    seedCount,
    totalEpisodes: runs.reduce((total, run) => total + (run.episodes || 0), 0),
    score: confidence.mean,
    adjustedScore: confidence.lower95,
    primary: aggregateMatchupRuns(runs, 'primary'),
    opponent: aggregateMatchupRuns(runs, 'opponent'),
    runs,
  };
}

function runSelfControl(strategyId, options = {}) {
  const common = commonOptions(options);
  const strategies = strategyId === RANDOM_OPPONENT_ID
    ? null
    : undefined;
  const stats = strategyId === RANDOM_OPPONENT_ID
    ? evaluateStrategy({
      ...common,
      seed: options.seed,
      strategies: Object.fromEntries(Array.from(
        { length: Math.max(1, Number(common.playerCount) || 5) },
        (_, index) => [index, RANDOM_OPPONENT_ID],
      )),
    })
    : evaluateStrategy({
      ...common,
      seed: options.seed,
      strategyId,
    });
  void strategies;
  return {
    strategy: describeStrategy(strategyId),
    role: strategyId,
    stats,
    summary: summarizeRole(stats, strategyId),
  };
}

export function runHeuristicLeague(options = {}) {
  const strategies = options.strategies || strategyIdsForEvaluation();
  const seed = options.seed ?? 44_000;
  const randomSelf = runSelfControl(RANDOM_OPPONENT_ID, {
    ...options,
    seed: deriveTournamentSeed(seed, 1),
  });

  const selfPlay = Object.fromEntries(strategies.map((strategyId, index) => [
    strategyId,
    runSelfControl(strategyId, {
      ...options,
      seed: deriveTournamentSeed(seed, 20 + index),
    }),
  ]));

  const vsRandom = Object.fromEntries(strategies.map((strategyId, index) => [
    strategyId,
    runTournamentSuite({
      ...options,
      primaryId: strategyId,
      opponentId: RANDOM_OPPONENT_ID,
      seed: deriveTournamentSeed(seed, 40 + index),
    }),
  ]));

  const pairwise = {};
  for (let leftIndex = 0; leftIndex < strategies.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < strategies.length; rightIndex += 1) {
      if (leftIndex === rightIndex) continue;
      const primaryId = strategies[leftIndex];
      const opponentId = strategies[rightIndex];
      pairwise[`${primaryId}_vs_${opponentId}`] = runTournamentSuite({
        ...options,
        primaryId,
        opponentId,
        seed: deriveTournamentSeed(seed, 100 + leftIndex * strategies.length + rightIndex),
      });
    }
  }

  const randomBaseline = randomSelf.summary;
  const validation = Object.fromEntries(strategies.map((strategyId) => {
    const matchup = vsRandom[strategyId].primary;
    return [strategyId, {
      beatsRandomScore: matchup.score > randomBaseline.score,
      beatsRandomWinRate: matchup.winRate > randomBaseline.winRate,
      beatsRandomPoints: matchup.averagePoints > randomBaseline.averagePoints,
      scoreDelta: matchup.score - randomBaseline.score,
      winRateDelta: matchup.winRate - randomBaseline.winRate,
      pointDelta: matchup.averagePoints - randomBaseline.averagePoints,
    }];
  }));

  return {
    episodes: Math.max(1, Number(options.episodes) || 12),
    seed,
    strategies: strategies.map(describeStrategy),
    randomSelf,
    selfPlay,
    vsRandom,
    pairwise,
    validation,
  };
}

export function scoreTournamentReport(report = {}) {
  if (Number.isFinite(report.adjustedScore)) return report.adjustedScore;
  if (Number.isFinite(report.score)) return report.score;
  if (Number.isFinite(report.primary?.adjustedScore)) return report.primary.adjustedScore;
  return -Infinity;
}
