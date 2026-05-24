import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { makeRng } from '../engine/state.js';
import { simulateGame } from './simulate.js';
import { DEFAULT_STRATEGY_WEIGHTS } from './strategy.js';
import { POLICY_WEIGHT_PRESETS } from './policies.js';
import { pickUniqueGreekFirstName, slugifyGreekFirstName } from './greekNames.js';
import { normalizeTunedOpponentRoster } from './opponentRoster.js';

const DEFAULT_TRAINING_LEAGUE = Object.freeze([
  'strategic',
  'defender',
  'usurper',
  'profiteer',
  'patron',
  'tyrant',
  'kingmaker',
  'freeRider',
  'overDefender',
  'estateShark',
  'antiLeader',
  'greedy',
  'loyalist',
  'random',
  'copycat',
]);

const SEED_PROFILE_IDS = Object.freeze([
  'strategic',
  'defender',
  'usurper',
  'patron',
  'tyrant',
  'kingmaker',
  'freeRider',
  'overDefender',
  'estateShark',
  'antiLeader',
]);

const DEFAULT_OPTIONS = {
  generations: 3,
  population: 10,
  elite: 3,
  games: 24,
  playerCounts: [5],
  deckSizes: [9],
  seed: null,
  maxSteps: 500,
  mutation: 0.35,
  fallPenalty: 220,
  opponentMix: 'robust',
  selfPlayEvery: null,
  championPoolSize: 6,
  screeningGames: null,
  finalistGames: null,
  finalists: 5,
  saveChampions: 5,
  workers: null,
  save: true,
  outputPath: fileURLToPath(new URL('./tunedOpponents.json', import.meta.url)),
  league: DEFAULT_TRAINING_LEAGUE,
};

const FALL_RATE_TARGET = 0.5;
const FALL_RATE_LOW_GUARD = 0.25;
const FALL_RATE_HIGH_GUARD = 0.75;

const TRAINING_BEHAVIOR_BASELINES = Object.freeze({
  averageWarMargin: 3,
  invasionDefeatRate: 0.25,
  frontierTroopsPerOrder: 2.4,
  capitalTroopsPerOrder: 0.8,
  idleTroopsPerOrder: 1,
  fundedTroopsPerOrder: 4,
  selfClaimRate: 0.14,
  credibleSelfClaimRate: 0.18,
});

const TRAINING_OPPONENT_MIXES = Object.freeze({
  beginner: {
    label: 'Beginner',
    selfPlayEvery: 4,
    championWeight: 0,
    nonChampionWeight: 6,
    builtInWeights: [
      ['strategic', 2],
      ['defender', 2],
      ['usurper', 2],
      ['profiteer', 1],
      ['patron', 1],
      ['tyrant', 1],
      ['kingmaker', 1],
      ['freeRider', 1],
      ['overDefender', 1],
      ['estateShark', 1],
      ['antiLeader', 1],
      ['random', 1],
      ['copycat', 1],
    ],
  },
  robust: {
    label: 'Robust',
    selfPlayEvery: 3,
    championWeight: 18,
    nonChampionWeight: 18,
    builtInWeights: [
      ['strategic', 2],
      ['defender', 2],
      ['usurper', 2],
      ['patron', 2],
      ['tyrant', 2],
      ['kingmaker', 2],
      ['freeRider', 2],
      ['overDefender', 2],
      ['estateShark', 2],
      ['antiLeader', 2],
      ['profiteer', 1],
      ['greedy', 1],
      ['loyalist', 1],
      ['random', 1],
      ['copycat', 1],
    ],
  },
});

export const STRATEGY_WEIGHT_BOUNDS = Object.freeze({
  ownRecipientBonus: [0, 8],
  appointmentUnlockBonus: [0, 8],
  leaderDenial: [0.2, 2.6],
  rivalDenial: [0, 1.2],
  estateProfit: [1, 9],
  estateBidCost: [0.35, 2.4],
  estateThreatPenalty: [0, 5],
  invasionShortfallPenalty: [1, 12],
  invasionSafetyValue: [0, 4],
  invasionSurplusPenalty: [0.05, 3],
  capitalFallPenalty: [100, 1400],
  capitalRiskPenalty: [20, 500],
  recoveryBonus: [0, 2.5],
  throneBase: [0, 80],
  selfClaim: [0.05, 2.4],
  incumbentDefense: [0.1, 2.4],
  supportLeaderPenalty: [0.1, 2.4],
  supportOtherClaimant: [0, 1.8],
  reserveValue: [0.15, 1.4],
  mercenaryCostPenalty: [0, 0.55],
  reciprocityWeight: [0, 1.8],
  grudgeWeight: [0, 1.8],
  trustWeight: [0, 1.2],
  favorSeekingWeight: [0, 1.6],
  friendNeglectPenalty: [0, 1.6],
  relationshipCap: [1, 8],
  defenseContextWeight: [0, 2.4],
  fundingContextWeight: [0, 1.8],
  revocationContextWeight: [0, 1.6],
  relationshipCoupWeight: [0, 1.8],
  coupOpportunityWeight: [0.05, 2.4],
  basileusTitleExpectation: [0, 2.4],
  basileusRevocationFear: [0, 2.4],
  backerTitleReward: [0, 2.4],
  backerRevocationMercy: [0, 2.4],
  titleQualityWeight: [0, 2.4],
  regimeTreatmentWeight: [0, 2.4],
  regimeUrgencyWeight: [0, 2.4],
  allyDefenseReliance: [0.55, 1],
  kingmakerPenalty: [0, 1.2],
});

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function toFloat(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultScreeningGames(games) {
  if (games < 12) return games;
  return Math.max(4, Math.ceil(games / 3));
}

function defaultWorkerCount() {
  try {
    return Math.max(1, Math.min(4, availableParallelism() - 1));
  } catch {
    return 1;
  }
}

function randomTrainingSeed() {
  return randomBytes(4).readUInt32BE(0);
}

function uniqueInts(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value)))];
}

function toIntList(value, fallback, min, max) {
  const fallbackValues = Array.isArray(fallback) ? fallback : [fallback];
  const rawValues = Array.isArray(value)
    ? value
    : String(value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  const parsed = [];

  for (const rawValue of rawValues) {
    if (typeof rawValue === 'string' && /^\d+\s*-\s*\d+$/.test(rawValue)) {
      const [left, right] = rawValue.split('-').map((entry) => Number.parseInt(entry.trim(), 10));
      const start = Math.min(left, right);
      const end = Math.max(left, right);
      for (let current = start; current <= end; current += 1) parsed.push(current);
      continue;
    }
    const number = Number.parseInt(rawValue, 10);
    if (Number.isInteger(number)) parsed.push(number);
  }

  const normalized = uniqueInts(parsed.map((entry) => Math.max(min, Math.min(max, entry))))
    .sort((left, right) => left - right);
  return normalized.length ? normalized : fallbackValues.slice();
}

function toPolicyList(value, fallback) {
  const fallbackValues = Array.isArray(fallback) ? fallback : [fallback];
  const rawValues = Array.isArray(value)
    ? value
    : String(value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  return rawValues.length ? rawValues : fallbackValues.slice();
}

function normalizeOpponentMix(value) {
  const key = String(value || DEFAULT_OPTIONS.opponentMix).trim().toLowerCase();
  return TRAINING_OPPONENT_MIXES[key] ? key : DEFAULT_OPTIONS.opponentMix;
}

function pickScheduledValue(values, index, offset = 0) {
  const list = Array.isArray(values) && values.length ? values : [values];
  return list[Math.abs(index + offset) % list.length];
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function scoreBand(value, min, max, reward, lowPenalty, highPenalty) {
  const number = Number(value) || 0;
  if (number < min) return -(min - number) * lowPenalty;
  if (number > max) return reward - (number - max) * highPenalty;
  return reward;
}

function normalizedRankScore(rank, playerCount) {
  const span = Math.max(1, playerCount - 1);
  return Math.max(0, Math.min(1, (playerCount - rank) / span));
}

function smoothMarginScore(value, scale = 8) {
  return Math.tanh((Number(value) || 0) / scale);
}

function metricValue(metrics, key) {
  const fallback = TRAINING_BEHAVIOR_BASELINES[key] ?? 0;
  const value = Number(metrics?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function excessSignal(value, target, scale) {
  return Math.max(0, (Number(value) - target) / Math.max(0.001, scale));
}

function shortfallSignal(value, target, scale) {
  return Math.max(0, (target - Number(value)) / Math.max(0.001, scale));
}

function cappedSignal(value, cap = 1.5) {
  return Math.max(-cap, Math.min(cap, Number(value) || 0));
}

function scorePrudenceBehavior(metrics) {
  const averageWarMargin = metricValue(metrics, 'averageWarMargin');
  const invasionDefeatRate = metricValue(metrics, 'invasionDefeatRate');
  const frontierTroopsPerOrder = metricValue(metrics, 'frontierTroopsPerOrder');
  const capitalTroopsPerOrder = metricValue(metrics, 'capitalTroopsPerOrder');
  const idleTroopsPerOrder = metricValue(metrics, 'idleTroopsPerOrder');
  const fundedTroopsPerOrder = metricValue(metrics, 'fundedTroopsPerOrder');
  const selfClaimRate = metricValue(metrics, 'selfClaimRate');
  const credibleSelfClaimRate = metricValue(metrics, 'credibleSelfClaimRate');

  // Positive values mean prudent/cautious behavior; negative values mean fearless/risky behavior.
  let score = 0;
  score += cappedSignal(excessSignal(averageWarMargin, 4.5, 5) - shortfallSignal(averageWarMargin, 1, 5)) * 1.4;
  score += cappedSignal(shortfallSignal(invasionDefeatRate, 0.18, 0.2) - excessSignal(invasionDefeatRate, 0.38, 0.25)) * 0.9;
  score += cappedSignal(excessSignal(frontierTroopsPerOrder, 3.2, 2.6) - shortfallSignal(frontierTroopsPerOrder, 1.2, 2)) * 0.9;
  score += cappedSignal(excessSignal(fundedTroopsPerOrder, 4.8, 2.5) - shortfallSignal(fundedTroopsPerOrder, 3.1, 2.2)) * 0.8;
  score += cappedSignal(shortfallSignal(capitalTroopsPerOrder, 0.45, 1.2) - excessSignal(capitalTroopsPerOrder, 1.4, 1.6)) * 0.8;
  score += cappedSignal(shortfallSignal(idleTroopsPerOrder, 0.35, 1.2) - excessSignal(idleTroopsPerOrder, 2.2, 2)) * 0.45;
  score += cappedSignal(shortfallSignal(selfClaimRate, 0.1, 0.12) - excessSignal(selfClaimRate, 0.28, 0.2)) * 0.8;
  score += cappedSignal(shortfallSignal(credibleSelfClaimRate, 0.1, 0.1) - excessSignal(credibleSelfClaimRate, 0.28, 0.18)) * 0.7;
  return cappedSignal(score, 6);
}

function scoreDeploymentConversionBehavior(metrics, fallRate) {
  const averageWarMargin = metricValue(metrics, 'averageWarMargin');
  const invasionDefeatRate = metricValue(metrics, 'invasionDefeatRate');
  const idleTroopsPerOrder = metricValue(metrics, 'idleTroopsPerOrder');
  const fundedTroopsPerOrder = metricValue(metrics, 'fundedTroopsPerOrder');

  let score = scoreBand(idleTroopsPerOrder, 0.55, 1.8, 24, 30, 16);
  if (averageWarMargin > 5 && idleTroopsPerOrder < 0.7) {
    score -= (0.7 - idleTroopsPerOrder) * 34;
  }
  if (fundedTroopsPerOrder > 5.4 && idleTroopsPerOrder < 0.5) {
    score -= (fundedTroopsPerOrder - 5.4) * (0.5 - idleTroopsPerOrder) * 18;
  }
  if (invasionDefeatRate > 0.45 && idleTroopsPerOrder > 1.1) {
    score -= (invasionDefeatRate - 0.45) * (idleTroopsPerOrder - 1.1) * 95;
  }
  if (fallRate > 0.6 && idleTroopsPerOrder > 1.2) {
    score -= (fallRate - 0.6) * (idleTroopsPerOrder - 1.2) * 90;
  }
  if (fallRate < 0.35 && idleTroopsPerOrder < 0.75) {
    score -= (0.35 - fallRate) * (0.75 - idleTroopsPerOrder) * 60;
  }
  return Math.max(-34, Math.min(34, score));
}

export function scoreAggregateTrainingShape(metrics, options) {
  const fallRate = Number(metrics.fallRate) || 0;
  const selfClaimRate = Number(metrics.selfClaimRate) || 0;
  const credibleSelfClaimRate = Number(metrics.credibleSelfClaimRate) || 0;
  const fallPenalty = Math.max(0, Number(options.fallPenalty) || 0);

  let adjustment = 0;
  const fallMiss = FALL_RATE_TARGET - fallRate;
  const fallTargetGap = Math.abs(fallRate - FALL_RATE_TARGET);
  const lowFallGap = Math.max(0, FALL_RATE_LOW_GUARD - fallRate);
  const highFallGap = Math.max(0, fallRate - FALL_RATE_HIGH_GUARD);
  const prudenceBehavior = scorePrudenceBehavior(metrics);
  adjustment -= fallTargetGap * fallPenalty * 2.4;
  adjustment -= fallMiss * prudenceBehavior * fallPenalty * 1.05;
  adjustment -= lowFallGap * fallPenalty * 3.2;
  adjustment -= highFallGap * fallPenalty * 4.5;
  adjustment -= lowFallGap * lowFallGap * fallPenalty * 2;
  adjustment -= highFallGap * highFallGap * fallPenalty * 2;

  adjustment += scoreBand(credibleSelfClaimRate, 0.12, 0.25, 48, 220, 80);
  adjustment += scoreDeploymentConversionBehavior(metrics, fallRate);
  adjustment -= Math.max(0, 0.14 - selfClaimRate) * 90 * Math.max(0, fallMiss * 2);
  return adjustment;
}

function clamp(value, [min, max]) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function boundedWeights(raw = {}) {
  const weights = { ...DEFAULT_STRATEGY_WEIGHTS, ...raw };
  for (const [key, bounds] of Object.entries(STRATEGY_WEIGHT_BOUNDS)) {
    weights[key] = clamp(weights[key], bounds);
  }
  return weights;
}

function mutateWeights(base, rng, mutation) {
  const weights = boundedWeights(base);
  for (const [key, bounds] of Object.entries(STRATEGY_WEIGHT_BOUNDS)) {
    const current = weights[key];
    const span = bounds[1] - bounds[0];
    const scaleNoise = 1 + (rng() * 2 - 1) * mutation;
    const additiveNoise = (rng() * 2 - 1) * span * mutation * 0.08;
    weights[key] = clamp(current * scaleNoise + additiveNoise, bounds);
  }
  return weights;
}

function seedPopulation(options, rng) {
  const namedProfiles = SEED_PROFILE_IDS.map((policyId) => [policyId, POLICY_WEIGHT_PRESETS[policyId] || {}]);
  const population = namedProfiles.map(([name, weights]) => ({
    name,
    weights: boundedWeights(weights),
  }));
  while (population.length < options.population) {
    population.push({
      name: `mutant-${population.length + 1}`,
      weights: mutateWeights(DEFAULT_STRATEGY_WEIGHTS, rng, 0.85),
    });
  }
  return population.slice(0, options.population);
}

function repeatPolicy(policy, count) {
  return Array.from({ length: Math.max(0, Math.floor(Number(count) || 0)) }, () => policy);
}

function cyclePolicies(policies, count) {
  const list = Array.isArray(policies) ? policies.filter(Boolean) : [];
  if (!list.length || count <= 0) return [];
  return Array.from({ length: count }, (_, index) => list[index % list.length]);
}

function expandWeightedPolicies(weightedPolicies) {
  const expanded = [];
  for (const [policy, weight] of weightedPolicies || []) {
    expanded.push(...repeatPolicy(policy, weight));
  }
  return expanded;
}

function policyLabel(policy) {
  if (typeof policy === 'string') return policy;
  return String(policy?.label || policy?.firstName || policy?.id || policy?.policyId || policy?.policy?.policyId || 'opponent');
}

function policyKey(policy) {
  if (typeof policy === 'string') return policy;
  return String(policy?.id || policy?.policyId || policy?.policy?.policyId || policyLabel(policy));
}

function opponentPolicy(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return {
    id: entry.id,
    label: entry.firstName || entry.label || entry.id,
    policyId: entry.policy?.policyId || entry.policyId || 'tuned',
    strategyWeights: entry.policy?.strategyWeights || entry.strategyWeights || entry.weights || {},
  };
}

function buildOpponentExposure(selfPlayEvery, opponentPool) {
  const selfPlayShare = selfPlayEvery > 0 ? 1 / selfPlayEvery : 0;
  const nonSelfShare = 1 - selfPlayShare;
  const poolSize = Math.max(1, opponentPool.length);
  const exposure = { selfPlay: selfPlayShare };
  for (const policy of opponentPool) {
    const key = policyKey(policy);
    exposure[key] = (exposure[key] || 0) + nonSelfShare / poolSize;
  }
  return Object.fromEntries(Object.entries(exposure).map(([key, value]) => [key, round(value, 3)]));
}

function buildTrainingOpponentPool(options) {
  const preset = TRAINING_OPPONENT_MIXES[options.opponentMix] || TRAINING_OPPONENT_MIXES[DEFAULT_OPTIONS.opponentMix];
  const savedOpponents = options.opponentMix === 'robust'
    ? readSavedOpponents(options.outputPath).slice(0, options.championPoolSize)
    : [];
  const champions = savedOpponents.map(opponentPolicy);

  const builtIns = options.leagueWasExplicit
    ? (options.opponentMix === 'beginner' ? options.league : cyclePolicies(options.league, preset.nonChampionWeight))
    : expandWeightedPolicies(preset.builtInWeights);
  const championEntries = cyclePolicies(champions, champions.length ? preset.championWeight : 0);
  const opponentPool = [...championEntries, ...builtIns];
  const finalPool = opponentPool.length ? opponentPool : ['strategic'];
  const exposure = buildOpponentExposure(options.selfPlayEvery, finalPool);

  return {
    opponentPool: finalPool,
    opponentSummary: {
      preset: options.opponentMix,
      label: preset.label,
      selfPlayEvery: options.selfPlayEvery,
      championOpponentIds: savedOpponents.map((entry) => entry.id),
      championOpponentCount: savedOpponents.length,
      nonSelfPool: Object.entries(
        finalPool.reduce((counts, policy) => {
          const key = policyKey(policy);
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}),
      ).map(([id, weight]) => ({ id, weight, label: policyLabel(finalPool.find((policy) => policyKey(policy) === id)) })),
      exposure,
    },
  };
}

function finalizeTrainingOptions(rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const { opponentPool, opponentSummary } = buildTrainingOpponentPool(options);
  options.opponentSummary = opponentSummary;
  Object.defineProperty(options, 'trainingOpponentPool', {
    value: opponentPool,
    enumerable: false,
    configurable: true,
  });
  return options;
}

function buildTrainingScenario(options, gameIndex, profileIndex) {
  return {
    playerCount: pickScheduledValue(options.playerCounts, gameIndex, profileIndex),
    deckSize: pickScheduledValue(options.deckSizes, Math.floor(gameIndex / Math.max(1, options.playerCounts.length)), profileIndex),
    seed: (options.seed + profileIndex * 100000 + gameIndex) >>> 0,
  };
}

function buildPoliciesForGame(weights, options, gameIndex, profileIndex, playerCount) {
  const candidateSeat = gameIndex % playerCount;
  const selfPlay = options.selfPlayEvery > 0 && gameIndex % options.selfPlayEvery === 0;
  const opponentPool = options.trainingOpponentPool || options.league || DEFAULT_OPTIONS.league;
  const policies = [];
  for (let seatId = 0; seatId < playerCount; seatId += 1) {
    if (selfPlay || seatId === candidateSeat) {
      policies.push({ policyId: 'tuned', label: 'candidate', strategyWeights: weights });
    } else {
      const leagueIndex = (gameIndex + seatId + profileIndex) % opponentPool.length;
      policies.push(opponentPool[leagueIndex] || 'strategic');
    }
  }
  return { candidateSeat, policies };
}

function scoreCandidateGame(game, candidateSeat, playerCount, options) {
  const rankIndex = game.finalScores.findIndex((entry) => entry.playerId === candidateSeat);
  const rank = rankIndex >= 0 ? rankIndex + 1 : playerCount;
  const entry = game.finalScores[rankIndex] || { points: 0, gold: 0, projectedIncome: 0 };
  const bestRival = game.finalScores.find((score) => score.playerId !== candidateSeat) || null;
  const pointMargin = (Number(entry.points) || 0) - (Number(bestRival?.points) || 0);
  const resolutions = Math.max(1, Number(game.stats?.resolutions) || 0);
  const victoryRate = (Number(game.stats?.wars?.victory) || 0) / resolutions;
  const defeatRate = (Number(game.stats?.wars?.defeat) || 0) / resolutions;
  const averageWarMargin = (Number(game.stats?.wars?.marginTotal) || 0) / resolutions;
  const playerStats = game.playerStatsByPlayer?.[candidateSeat] || game.playerStatsByPlayer?.[String(candidateSeat)] || {};
  const orders = Math.max(1, Number(playerStats.orders) || 0);
  const selfClaims = Number(playerStats.selfClaims) || 0;
  const credibleSelfClaims = Number(playerStats.credibleSelfClaims) || 0;
  const tokenSelfClaims = Number(playerStats.tokenSelfClaims) || 0;
  const selfClaimWins = Number(playerStats.selfClaimWins) || 0;
  const incumbentBacks = Number(playerStats.incumbentBacks) || 0;
  const otherBacks = Number(playerStats.otherBacks) || 0;
  const selfClaimRate = selfClaims / orders;
  const credibleSelfClaimRate = credibleSelfClaims / orders;
  const selfClaimWinRate = selfClaimWins / Math.max(1, selfClaims);
  const tokenSelfClaimRate = tokenSelfClaims / Math.max(1, selfClaims);
  const incumbentBackRate = incumbentBacks / orders;
  const otherBackRate = otherBacks / orders;
  const averageSelfClaimTroops = selfClaims > 0 ? (Number(playerStats.selfClaimTroops) || 0) / selfClaims : 0;
  const frontierTroopsPerOrder = (Number(playerStats.frontierTroops) || 0) / orders;
  const capitalTroopsPerOrder = (Number(playerStats.capitalTroops) || 0) / orders;
  const idleTroopsPerOrder = (Number(playerStats.idleTroops) || 0) / orders;
  const fundedTroopsPerOrder = (Number(playerStats.fundedTroops) || 0) / orders;
  const appointmentStats = game.appointmentStatsByPlayer?.[candidateSeat] || {};
  const appointmentUnlocks = Number(appointmentStats.unlockAppointments) || 0;
  const unresolvedAppointmentLock = appointmentStats.finalSelfLocked ? 1 : 0;
  const won = game.winnerIds.includes(candidateSeat);

  let objective = won ? 180 : 0;
  objective += normalizedRankScore(rank, playerCount) * 90;
  objective += smoothMarginScore(pointMargin) * 70;
  objective += Math.min(45, Math.max(0, Number(entry.points) || 0)) * 7;
  objective += Math.min(40, Math.max(0, Number(entry.gold) || 0)) * 0.1;
  objective += Math.max(0, Number(entry.projectedIncome) || 0) * 0.14;
  objective += selfClaimWinRate * 55;
  objective += Math.min(0.35, credibleSelfClaimRate) * 36;
  objective += Math.min(0.35, otherBackRate) * 18;
  objective += Math.min(8, averageSelfClaimTroops) * (selfClaims > 0 ? 1.4 : 0);
  objective -= tokenSelfClaimRate * 28;
  objective -= Math.max(0, 0.08 - credibleSelfClaimRate) * 12;
  objective -= Math.max(0, incumbentBackRate - 0.55) * 14;
  objective -= defeatRate * 12;
  objective += victoryRate * 3;
  objective -= Math.max(0, averageWarMargin - 6) * 1.2;
  if (game.reason === 'stuck') objective -= 120;

  return {
    objective,
    won,
    rank,
    points: Number(entry.points) || 0,
    pointMargin,
    fall: Boolean(game.fall),
    averageWarMargin,
    invasionDefeatRate: defeatRate,
    invasionVictoryRate: victoryRate,
    selfClaimRate,
    credibleSelfClaimRate,
    selfClaimWinRate,
    tokenSelfClaimRate,
    incumbentBackRate,
    otherBackRate,
    averageSelfClaimTroops,
    frontierTroopsPerOrder,
    capitalTroopsPerOrder,
    idleTroopsPerOrder,
    fundedTroopsPerOrder,
    appointmentUnlocks,
    unresolvedAppointmentLock,
    selfAppointments: Number(appointmentStats.selfAppointments) || 0,
  };
}

export function evaluateStrategyWeights(weights, rawOptions = {}, profileIndex = 0) {
  const options = rawOptions?.trainingOpponentPool ? rawOptions : finalizeTrainingOptions(rawOptions);
  let total = 0;
  let wins = 0;
  let rankTotal = 0;
  let pointTotal = 0;
  let pointMarginTotal = 0;
  let falls = 0;
  let stuck = 0;
  let appointmentUnlocks = 0;
  let selfAppointments = 0;
  let unresolvedAppointmentLocks = 0;
  let averageWarMargin = 0;
  let invasionDefeatRate = 0;
  let invasionVictoryRate = 0;
  let selfClaimRate = 0;
  let credibleSelfClaimRate = 0;
  let selfClaimWinRate = 0;
  let tokenSelfClaimRate = 0;
  let incumbentBackRate = 0;
  let otherBackRate = 0;
  let averageSelfClaimTroops = 0;
  let frontierTroopsPerOrder = 0;
  let capitalTroopsPerOrder = 0;
  let idleTroopsPerOrder = 0;
  let fundedTroopsPerOrder = 0;

  for (let gameIndex = 0; gameIndex < options.games; gameIndex += 1) {
    const scenario = buildTrainingScenario(options, gameIndex, profileIndex);
    const { candidateSeat, policies } = buildPoliciesForGame(weights, options, gameIndex, profileIndex, scenario.playerCount);
    const game = simulateGame({
      playerCount: scenario.playerCount,
      deckSize: scenario.deckSize,
      seed: scenario.seed,
      maxSteps: options.maxSteps,
      policies,
      historyEnabled: true,
      samples: 0,
    }, 0);
    const score = scoreCandidateGame(game, candidateSeat, scenario.playerCount, options);
    total += score.objective;
    wins += score.won ? 1 : 0;
    rankTotal += score.rank;
    pointTotal += score.points;
    pointMarginTotal += score.pointMargin;
    falls += score.fall ? 1 : 0;
    stuck += game.reason === 'stuck' ? 1 : 0;
    averageWarMargin += score.averageWarMargin;
    invasionDefeatRate += score.invasionDefeatRate;
    invasionVictoryRate += score.invasionVictoryRate;
    selfClaimRate += score.selfClaimRate;
    credibleSelfClaimRate += score.credibleSelfClaimRate;
    selfClaimWinRate += score.selfClaimWinRate;
    tokenSelfClaimRate += score.tokenSelfClaimRate;
    incumbentBackRate += score.incumbentBackRate;
    otherBackRate += score.otherBackRate;
    averageSelfClaimTroops += score.averageSelfClaimTroops;
    frontierTroopsPerOrder += score.frontierTroopsPerOrder;
    capitalTroopsPerOrder += score.capitalTroopsPerOrder;
    idleTroopsPerOrder += score.idleTroopsPerOrder;
    fundedTroopsPerOrder += score.fundedTroopsPerOrder;
    appointmentUnlocks += score.appointmentUnlocks;
    selfAppointments += score.selfAppointments;
    unresolvedAppointmentLocks += score.unresolvedAppointmentLock;
  }

  const games = Math.max(1, options.games);
  const metrics = {
    objective: total / games,
    winRate: wins / games,
    averageRank: rankTotal / games,
    averagePoints: pointTotal / games,
    averagePointMargin: pointMarginTotal / games,
    fallRate: falls / games,
    averageWarMargin: averageWarMargin / games,
    invasionDefeatRate: invasionDefeatRate / games,
    invasionVictoryRate: invasionVictoryRate / games,
    selfClaimRate: selfClaimRate / games,
    credibleSelfClaimRate: credibleSelfClaimRate / games,
    selfClaimWinRate: selfClaimWinRate / games,
    tokenSelfClaimRate: tokenSelfClaimRate / games,
    incumbentBackRate: incumbentBackRate / games,
    otherBackRate: otherBackRate / games,
    averageSelfClaimTroops: averageSelfClaimTroops / games,
    frontierTroopsPerOrder: frontierTroopsPerOrder / games,
    capitalTroopsPerOrder: capitalTroopsPerOrder / games,
    idleTroopsPerOrder: idleTroopsPerOrder / games,
    fundedTroopsPerOrder: fundedTroopsPerOrder / games,
  };
  metrics.objective += scoreAggregateTrainingShape(metrics, options);

  return {
    objective: round(metrics.objective),
    winRate: round(metrics.winRate),
    averageRank: round(metrics.averageRank),
    averagePoints: round(metrics.averagePoints),
    averagePointMargin: round(metrics.averagePointMargin),
    fallRate: round(metrics.fallRate),
    averageWarMargin: round(metrics.averageWarMargin),
    invasionDefeatRate: round(metrics.invasionDefeatRate),
    invasionVictoryRate: round(metrics.invasionVictoryRate),
    selfClaimRate: round(metrics.selfClaimRate),
    credibleSelfClaimRate: round(metrics.credibleSelfClaimRate),
    selfClaimWinRate: round(metrics.selfClaimWinRate),
    tokenSelfClaimRate: round(metrics.tokenSelfClaimRate),
    incumbentBackRate: round(metrics.incumbentBackRate),
    otherBackRate: round(metrics.otherBackRate),
    averageSelfClaimTroops: round(metrics.averageSelfClaimTroops),
    frontierTroopsPerOrder: round(metrics.frontierTroopsPerOrder),
    capitalTroopsPerOrder: round(metrics.capitalTroopsPerOrder),
    idleTroopsPerOrder: round(metrics.idleTroopsPerOrder),
    fundedTroopsPerOrder: round(metrics.fundedTroopsPerOrder),
    appointmentUnlockRate: round(appointmentUnlocks / Math.max(1, selfAppointments)),
    unresolvedAppointmentLocks: round(unresolvedAppointmentLocks / games),
    stuck,
  };
}

function compactWeights(weights) {
  return Object.fromEntries(
    Object.entries(weights)
      .filter(([key, value]) => Math.abs(value - DEFAULT_STRATEGY_WEIGHTS[key]) > 0.001)
      .map(([key, value]) => [key, round(value, 4)]),
  );
}

function readSavedOpponents(path) {
  try {
    return normalizeTunedOpponentRoster(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return [];
  }
}

function uniqueTunedId(name, existing) {
  const used = new Set(existing.map((entry) => entry.id));
  const base = `tuned-${slugifyGreekFirstName(name)}`;
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function formatExposure(exposure = {}) {
  return Object.entries(exposure)
    .map(([key, value]) => `${key} ${percent(value)}`)
    .join(', ');
}

function trainingDescription(options) {
  const preset = options.opponentSummary?.label || options.opponentMix;
  const champions = options.opponentSummary?.championOpponentCount || 0;
  const championText = champions ? `, including ${champions} saved champion${champions === 1 ? '' : 's'}` : '';
  return `Tuned with the ${preset} opponent mix${championText}.`;
}

function buildSavedOpponent(result, champion, index, existing) {
  const usedNames = existing.map((entry) => entry.firstName || entry.name);
  const firstName = pickUniqueGreekFirstName(
    `${result.options.seed}:${Date.now()}:${index}:${champion.metrics.objective}`,
    usedNames,
  );
  const entry = {
    id: uniqueTunedId(firstName, existing),
    firstName,
    label: index === 0 ? 'Tuned AI' : `Tuned AI ${index + 1}`,
    description: trainingDescription(result.options),
    policy: {
      policyId: 'tuned',
      strategyWeights: champion.weights,
    },
    strategyWeights: champion.weights,
    metrics: champion.metrics,
    training: {
      trainedAt: new Date().toISOString(),
      objectiveVersion: 7,
      championRank: index + 1,
      generations: result.options.generations,
      population: result.options.population,
      screeningGamesPerCandidate: result.options.screeningGames,
      gamesPerCandidate: result.options.finalistGames,
      playerCounts: result.options.playerCounts,
      deckSizes: result.options.deckSizes,
      seed: result.options.seed,
      league: result.options.league,
      opponentMix: result.options.opponentMix,
      opponentExposure: result.options.opponentSummary?.exposure || null,
      championOpponentIds: result.options.opponentSummary?.championOpponentIds || [],
      selfPlayEvery: result.options.selfPlayEvery,
      fallPenalty: result.options.fallPenalty,
      appointmentUnlockRate: champion.metrics.appointmentUnlockRate,
      unresolvedAppointmentLocks: champion.metrics.unresolvedAppointmentLocks,
      incumbentBackRate: champion.metrics.incumbentBackRate,
      otherBackRate: champion.metrics.otherBackRate,
    },
  };
  existing.push(entry);
  return entry;
}

function saveBestOpponents(result) {
  const existing = readSavedOpponents(result.options.outputPath);
  const idScratch = existing.slice();
  const opponents = result.champions
    .slice(0, result.options.saveChampions)
    .map((champion, index) => buildSavedOpponent(result, champion, index, idScratch));
  const updatedAt = opponents[0]?.training?.trainedAt || new Date().toISOString();
  const payload = {
    version: 1,
    updatedAt,
    opponents: [...opponents, ...existing].slice(0, 24),
  };
  writeFileSync(result.options.outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path: result.options.outputPath, opponent: opponents[0] || null, opponents };
}

function normalizeOptions(rawOptions = {}) {
  const population = Math.max(2, toInt(rawOptions.population, DEFAULT_OPTIONS.population));
  const games = Math.max(1, toInt(rawOptions.games, DEFAULT_OPTIONS.games));
  const screeningGames = Math.max(1, Math.min(
    games,
    toInt(rawOptions.screeningGames ?? rawOptions.screenGames, defaultScreeningGames(games)),
  ));
  const finalistGames = Math.max(
    screeningGames,
    toInt(rawOptions.finalistGames ?? rawOptions.finalGames, games),
  );
  const saveChampions = Math.max(1, Math.min(24, toInt(rawOptions.saveChampions ?? rawOptions.championsToSave, DEFAULT_OPTIONS.saveChampions)));
  const finalists = Math.min(
    population,
    Math.max(saveChampions, toInt(rawOptions.finalists ?? rawOptions.finalistCount, DEFAULT_OPTIONS.finalists)),
  );
  const rawPlayerCounts = rawOptions.playerCounts ?? rawOptions.playerCount ?? DEFAULT_OPTIONS.playerCounts;
  const rawDeckSizes = rawOptions.deckSizes ?? rawOptions.deckSize ?? DEFAULT_OPTIONS.deckSizes;
  const opponentMix = normalizeOpponentMix(rawOptions.opponentMix ?? rawOptions.trainingProfile ?? rawOptions.trainingPreset);
  const preset = TRAINING_OPPONENT_MIXES[opponentMix] || TRAINING_OPPONENT_MIXES[DEFAULT_OPTIONS.opponentMix];
  const rawSelfPlayEvery = rawOptions.selfPlayEvery ?? rawOptions.selfPlay;
  return {
    ...DEFAULT_OPTIONS,
    ...rawOptions,
    generations: Math.max(1, toInt(rawOptions.generations, DEFAULT_OPTIONS.generations)),
    population,
    elite: Math.max(1, Math.min(population, toInt(rawOptions.elite, DEFAULT_OPTIONS.elite))),
    games,
    screeningGames,
    finalistGames,
    finalists,
    saveChampions,
    playerCounts: toIntList(rawPlayerCounts, DEFAULT_OPTIONS.playerCounts, 3, 5),
    deckSizes: toIntList(rawDeckSizes, DEFAULT_OPTIONS.deckSizes, 1, 30),
    seed: Number.isInteger(rawOptions.seed) ? rawOptions.seed : randomTrainingSeed(),
    maxSteps: Math.max(20, toInt(rawOptions.maxSteps, DEFAULT_OPTIONS.maxSteps)),
    mutation: Math.max(0.01, Math.min(1.5, toFloat(rawOptions.mutation, DEFAULT_OPTIONS.mutation))),
    fallPenalty: Math.max(0, toFloat(rawOptions.fallPenalty, DEFAULT_OPTIONS.fallPenalty)),
    opponentMix,
    selfPlayEvery: rawSelfPlayEvery == null
      ? preset.selfPlayEvery
      : Math.max(0, toInt(rawSelfPlayEvery, preset.selfPlayEvery)),
    championPoolSize: Math.max(0, toInt(rawOptions.championPoolSize ?? rawOptions.champions, DEFAULT_OPTIONS.championPoolSize)),
    save: rawOptions.save !== false,
    outputPath: rawOptions.outputPath || DEFAULT_OPTIONS.outputPath,
    league: toPolicyList(rawOptions.league, DEFAULT_OPTIONS.league),
    leagueWasExplicit: rawOptions.league != null,
    workers: Math.max(1, toInt(rawOptions.workers, defaultWorkerCount())),
  };
}

function emitProgress(options, event) {
  if (typeof options.onProgress === 'function') options.onProgress(event);
}

function estimatedTrainingGames(options) {
  const screeningTotal = options.generations * options.population * options.screeningGames;
  const finalistTotal = options.finalistGames > options.screeningGames
    ? options.finalists * options.finalistGames
    : 0;
  return screeningTotal + finalistTotal;
}

function evaluationOptions(options, games) {
  const clone = { ...options, games };
  delete clone.onProgress;
  Object.defineProperty(clone, 'trainingOpponentPool', {
    value: options.trainingOpponentPool,
    enumerable: true,
    configurable: true,
  });
  return clone;
}

function candidateProfileIndex(options, generation, index) {
  return generation * options.population + index;
}

function finalProfileIndex(index) {
  return 100000 + index;
}

function evaluateProfile(profile, options, profileIndex, games) {
  return {
    ...profile,
    metrics: evaluateStrategyWeights(profile.weights, evaluationOptions(options, games), profileIndex),
  };
}

function compareCandidates(left, right) {
  const leftFallTargetGap = Math.abs((Number(left.metrics.fallRate) || 0) - FALL_RATE_TARGET);
  const rightFallTargetGap = Math.abs((Number(right.metrics.fallRate) || 0) - FALL_RATE_TARGET);
  return (
    (right.metrics.objective - left.metrics.objective)
    || ((right.metrics.winRate || 0) - (left.metrics.winRate || 0))
    || (leftFallTargetGap - rightFallTargetGap)
    || String(left.name).localeCompare(String(right.name))
  );
}

function weightsSignature(weights) {
  return JSON.stringify(compactWeights(weights));
}

function uniqueSortedCandidates(candidates, limit = Infinity) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates.slice().sort(compareCandidates)) {
    const signature = weightsSignature(candidate.weights);
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(candidate);
    if (unique.length >= limit) break;
  }
  return unique;
}

function compactChampion(candidate) {
  return {
    name: candidate.name,
    metrics: candidate.metrics,
    weights: candidate.weights,
    compactWeights: compactWeights(candidate.weights),
    screeningMetrics: candidate.screeningMetrics || null,
  };
}

function createTrainingResult(options, champions, generations) {
  const best = champions[0];
  return {
    options,
    best: compactChampion(best),
    champions: champions.map(compactChampion),
    generations,
  };
}

function beginTraining(rawOptions = {}) {
  const options = finalizeTrainingOptions({ ...rawOptions, seed: randomTrainingSeed() });
  const rng = makeRng(options.seed);
  let population = seedPopulation(options, rng);
  const generations = [];
  let leaderboard = [];
  const startedAt = Date.now();

  emitProgress(options, {
    type: 'training-start',
    generations: options.generations,
    population: options.population,
    games: options.games,
    screeningGames: options.screeningGames,
    finalistGames: options.finalistGames,
    finalists: options.finalists,
    saveChampions: options.saveChampions,
    workers: options.workers,
    totalGames: estimatedTrainingGames(options),
    playerCounts: options.playerCounts,
    deckSizes: options.deckSizes,
    league: options.league,
    opponentMix: options.opponentMix,
    opponentSummary: options.opponentSummary,
    seed: options.seed,
    elapsedMs: 0,
  });

  return { options, rng, population, generations, leaderboard, startedAt };
}

function evaluatePopulationSerial(population, options, generation, startedAt, games) {
  const evaluated = [];
  for (let index = 0; index < population.length; index += 1) {
    const profile = population[index];
    emitProgress(options, {
      type: 'candidate-start',
      generation: generation + 1,
      generations: options.generations,
      candidate: index + 1,
      population: options.population,
      name: profile.name,
      games,
      elapsedMs: Date.now() - startedAt,
    });
    const candidate = evaluateProfile(profile, options, candidateProfileIndex(options, generation, index), games);
    evaluated.push(candidate);
    emitProgress(options, {
      type: 'candidate-end',
      generation: generation + 1,
      generations: options.generations,
      candidate: index + 1,
      population: options.population,
      name: profile.name,
      metrics: candidate.metrics,
      elapsedMs: Date.now() - startedAt,
    });
  }
  return evaluated.sort(compareCandidates);
}

function rerankFinalistsSerial(candidates, options, startedAt) {
  const finalists = uniqueSortedCandidates(candidates, options.finalists);
  if (options.finalistGames <= options.screeningGames) return finalists;
  const evaluated = [];
  for (let index = 0; index < finalists.length; index += 1) {
    const profile = finalists[index];
    emitProgress(options, {
      type: 'finalist-start',
      finalist: index + 1,
      finalists: finalists.length,
      name: profile.name,
      games: options.finalistGames,
      elapsedMs: Date.now() - startedAt,
    });
    const candidate = evaluateProfile(profile, options, finalProfileIndex(index), options.finalistGames);
    candidate.screeningMetrics = profile.metrics;
    evaluated.push(candidate);
    emitProgress(options, {
      type: 'finalist-end',
      finalist: index + 1,
      finalists: finalists.length,
      name: profile.name,
      metrics: candidate.metrics,
      elapsedMs: Date.now() - startedAt,
    });
  }
  return uniqueSortedCandidates(evaluated, options.finalists);
}

function completeTraining(result, startedAt) {
  if (result.options.save) {
    result.saved = saveBestOpponents(result);
    emitProgress(result.options, {
      type: 'saved',
      firstName: result.saved.opponent?.firstName || null,
      id: result.saved.opponent?.id || null,
      count: result.saved.opponents.length,
      path: result.saved.path,
      elapsedMs: Date.now() - startedAt,
    });
  }
  emitProgress(result.options, {
    type: 'training-end',
    bestName: result.best.name,
    bestMetrics: result.best.metrics,
    champions: result.champions,
    saved: result.saved || null,
    elapsedMs: Date.now() - startedAt,
  });
  return result;
}

export function trainStrategyWeights(rawOptions = {}) {
  const session = beginTraining(rawOptions);
  const { options, rng, generations, startedAt } = session;
  let { population, leaderboard } = session;

  for (let generation = 0; generation < options.generations; generation += 1) {
    emitProgress(options, {
      type: 'generation-start',
      generation: generation + 1,
      generations: options.generations,
      elapsedMs: Date.now() - startedAt,
    });

    const evaluated = evaluatePopulationSerial(population, options, generation, startedAt, options.screeningGames);
    leaderboard = uniqueSortedCandidates([...leaderboard, ...evaluated], Math.max(options.finalists * 4, options.elite));

    generations.push({
      generation: generation + 1,
      best: {
        name: evaluated[0].name,
        metrics: evaluated[0].metrics,
        weights: compactWeights(evaluated[0].weights),
      },
    });
    emitProgress(options, {
      type: 'generation-end',
      generation: generation + 1,
      generations: options.generations,
      bestName: evaluated[0].name,
      bestMetrics: evaluated[0].metrics,
      globalBestName: leaderboard[0].name,
      globalBestMetrics: leaderboard[0].metrics,
      elapsedMs: Date.now() - startedAt,
    });

    const elites = evaluated.slice(0, options.elite);
    population = elites.map((profile) => ({ name: profile.name, weights: profile.weights }));
    while (population.length < options.population) {
      const parent = elites[Math.floor(rng() * elites.length)];
      population.push({
        name: `${parent.name}-g${generation + 1}-${population.length + 1}`,
        weights: mutateWeights(parent.weights, rng, options.mutation),
      });
    }
  }

  const champions = rerankFinalistsSerial(leaderboard, options, startedAt);
  return completeTraining(createTrainingResult(options, champions, generations), startedAt);
}

function evaluateProfileInWorker(profile, options, profileIndex, games) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        kind: 'evaluate-profile',
        profile,
        profileIndex,
        games,
        options: evaluationOptions(options, games),
      },
    });
    worker.once('message', (message) => {
      if (message?.ok) resolve({ ...profile, metrics: message.metrics });
      else reject(new Error(message?.error || 'Worker evaluation failed.'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}.`));
    });
  });
}

async function evaluatePopulationParallel(population, options, generation, startedAt, games) {
  if (options.workers <= 1 || population.length <= 1) {
    return evaluatePopulationSerial(population, options, generation, startedAt, games);
  }

  const evaluated = [];
  let nextIndex = 0;
  async function runWorkerLane() {
    while (nextIndex < population.length) {
      const index = nextIndex;
      nextIndex += 1;
      const profile = population[index];
      emitProgress(options, {
        type: 'candidate-start',
        generation: generation + 1,
        generations: options.generations,
        candidate: index + 1,
        population: options.population,
        name: profile.name,
        games,
        elapsedMs: Date.now() - startedAt,
      });
      const candidate = await evaluateProfileInWorker(
        profile,
        options,
        candidateProfileIndex(options, generation, index),
        games,
      );
      evaluated[index] = candidate;
      emitProgress(options, {
        type: 'candidate-end',
        generation: generation + 1,
        generations: options.generations,
        candidate: index + 1,
        population: options.population,
        name: profile.name,
        metrics: candidate.metrics,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.workers, population.length) }, () => runWorkerLane()),
  );
  return evaluated.filter(Boolean).sort(compareCandidates);
}

async function rerankFinalistsParallel(candidates, options, startedAt) {
  const finalists = uniqueSortedCandidates(candidates, options.finalists);
  if (options.finalistGames <= options.screeningGames || options.workers <= 1 || finalists.length <= 1) {
    return rerankFinalistsSerial(candidates, options, startedAt);
  }

  const evaluated = [];
  let nextIndex = 0;
  async function runWorkerLane() {
    while (nextIndex < finalists.length) {
      const index = nextIndex;
      nextIndex += 1;
      const profile = finalists[index];
      emitProgress(options, {
        type: 'finalist-start',
        finalist: index + 1,
        finalists: finalists.length,
        name: profile.name,
        games: options.finalistGames,
        elapsedMs: Date.now() - startedAt,
      });
      const candidate = await evaluateProfileInWorker(profile, options, finalProfileIndex(index), options.finalistGames);
      candidate.screeningMetrics = profile.metrics;
      evaluated[index] = candidate;
      emitProgress(options, {
        type: 'finalist-end',
        finalist: index + 1,
        finalists: finalists.length,
        name: profile.name,
        metrics: candidate.metrics,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.workers, finalists.length) }, () => runWorkerLane()),
  );
  return uniqueSortedCandidates(evaluated.filter(Boolean), options.finalists);
}

export async function trainStrategyWeightsAsync(rawOptions = {}) {
  const session = beginTraining(rawOptions);
  const { options, rng, generations, startedAt } = session;
  let { population, leaderboard } = session;

  for (let generation = 0; generation < options.generations; generation += 1) {
    emitProgress(options, {
      type: 'generation-start',
      generation: generation + 1,
      generations: options.generations,
      elapsedMs: Date.now() - startedAt,
    });

    const evaluated = await evaluatePopulationParallel(population, options, generation, startedAt, options.screeningGames);
    leaderboard = uniqueSortedCandidates([...leaderboard, ...evaluated], Math.max(options.finalists * 4, options.elite));

    generations.push({
      generation: generation + 1,
      best: {
        name: evaluated[0].name,
        metrics: evaluated[0].metrics,
        weights: compactWeights(evaluated[0].weights),
      },
    });
    emitProgress(options, {
      type: 'generation-end',
      generation: generation + 1,
      generations: options.generations,
      bestName: evaluated[0].name,
      bestMetrics: evaluated[0].metrics,
      globalBestName: leaderboard[0].name,
      globalBestMetrics: leaderboard[0].metrics,
      elapsedMs: Date.now() - startedAt,
    });

    const elites = evaluated.slice(0, options.elite);
    population = elites.map((profile) => ({ name: profile.name, weights: profile.weights }));
    while (population.length < options.population) {
      const parent = elites[Math.floor(rng() * elites.length)];
      population.push({
        name: `${parent.name}-g${generation + 1}-${population.length + 1}`,
        weights: mutateWeights(parent.weights, rng, options.mutation),
      });
    }
  }

  const champions = await rerankFinalistsParallel(leaderboard, options, startedAt);
  return completeTraining(createTrainingResult(options, champions, generations), startedAt);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'json') {
      options.json = true;
      continue;
    }
    if (key === 'no-save') {
      options.save = false;
      continue;
    }
    if (key === 'quiet') {
      options.quiet = true;
      continue;
    }
    if (key === 'beginner') {
      options.opponentMix = 'beginner';
      continue;
    }
    if (key === 'robust') {
      options.opponentMix = 'robust';
      continue;
    }
    const value = argv[index + 1];
    index += 1;
    if (key === 'generations') options.generations = toInt(value, DEFAULT_OPTIONS.generations);
    else if (key === 'population') options.population = toInt(value, DEFAULT_OPTIONS.population);
    else if (key === 'elite') options.elite = toInt(value, DEFAULT_OPTIONS.elite);
    else if (key === 'games') options.games = toInt(value, DEFAULT_OPTIONS.games);
    else if (key === 'screening-games' || key === 'screen-games') options.screeningGames = toInt(value, DEFAULT_OPTIONS.screeningGames);
    else if (key === 'finalist-games' || key === 'final-games') options.finalistGames = toInt(value, DEFAULT_OPTIONS.finalistGames);
    else if (key === 'finalists' || key === 'finalist-count') options.finalists = toInt(value, DEFAULT_OPTIONS.finalists);
    else if (key === 'save-champions' || key === 'champions-to-save') options.saveChampions = toInt(value, DEFAULT_OPTIONS.saveChampions);
    else if (key === 'workers') options.workers = toInt(value, DEFAULT_OPTIONS.workers);
    else if (key === 'players' || key === 'player-counts') options.playerCounts = value;
    else if (key === 'deck' || key === 'decks') options.deckSizes = value;
    else if (key === 'mutation') options.mutation = toFloat(value, DEFAULT_OPTIONS.mutation);
    else if (key === 'fall-penalty') options.fallPenalty = toFloat(value, DEFAULT_OPTIONS.fallPenalty);
    else if (key === 'self-play-every') options.selfPlayEvery = toInt(value, DEFAULT_OPTIONS.selfPlayEvery);
    else if (key === 'opponent-mix' || key === 'training-profile' || key === 'training-preset') options.opponentMix = value;
    else if (key === 'champions' || key === 'champion-pool-size') options.championPoolSize = toInt(value, DEFAULT_OPTIONS.championPoolSize);
    else if (key === 'output') options.outputPath = resolve(String(value || DEFAULT_OPTIONS.outputPath));
    else if (key === 'league') options.league = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return options;
}

function percent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function seconds(ms) {
  return `${round((Number(ms) || 0) / 1000, 1)}s`;
}

function compactMetrics(metrics) {
  return `objective ${metrics.objective}, win ${percent(metrics.winRate)}, rank ${metrics.averageRank}, score margin ${metrics.averagePointMargin}, fall ${percent(metrics.fallRate)}, war margin ${metrics.averageWarMargin}, credible coups ${percent(metrics.credibleSelfClaimRate)}, coup wins ${percent(metrics.selfClaimWinRate)}`;
}

function createCliProgressLogger() {
  return (event) => {
    if (event.type === 'training-start') {
      console.log(`[train ${seconds(event.elapsedMs)}] Starting ${event.generations} generations x ${event.population} profiles x ${event.screeningGames} screening games, then ${event.finalists} finalists x ${event.finalistGames} games (${event.totalGames} games estimated), seed ${event.seed}. Workers ${event.workers}.`);
      console.log(`[train ${seconds(event.elapsedMs)}] Players ${event.playerCounts.join('/')}, turns ${event.deckSizes.join('/')}. Saving up to ${event.saveChampions} champions.`);
      console.log(`[train ${seconds(event.elapsedMs)}] Opponent mix: ${event.opponentMix}; expected exposure ${formatExposure(event.opponentSummary?.exposure)}.`);
    } else if (event.type === 'generation-start') {
      console.log(`[train ${seconds(event.elapsedMs)}] Generation ${event.generation}/${event.generations} started.`);
    } else if (event.type === 'candidate-start') {
      console.log(`[train ${seconds(event.elapsedMs)}]   Candidate ${event.candidate}/${event.population}: ${event.name} (${event.games} games)`);
    } else if (event.type === 'candidate-end') {
      console.log(`[train ${seconds(event.elapsedMs)}]   -> ${event.name}: ${compactMetrics(event.metrics)}`);
    } else if (event.type === 'finalist-start') {
      console.log(`[train ${seconds(event.elapsedMs)}]   Finalist ${event.finalist}/${event.finalists}: ${event.name} (${event.games} games)`);
    } else if (event.type === 'finalist-end') {
      console.log(`[train ${seconds(event.elapsedMs)}]   => ${event.name}: ${compactMetrics(event.metrics)}`);
    } else if (event.type === 'generation-end') {
      console.log(`[train ${seconds(event.elapsedMs)}] Generation ${event.generation}/${event.generations} winner: ${event.bestName} (${compactMetrics(event.bestMetrics)}). Global best: ${event.globalBestName}.`);
    } else if (event.type === 'saved') {
      console.log(`[train ${seconds(event.elapsedMs)}] Saved ${event.count} champion${event.count === 1 ? '' : 's'} to ${event.path}.`);
    } else if (event.type === 'training-end') {
      console.log(`[train ${seconds(event.elapsedMs)}] Finished. Best: ${event.bestName} (${compactMetrics(event.bestMetrics)}).`);
    }
  };
}

function formatTrainingReport(result) {
  const lines = [
    `AI training: ${result.options.generations} generations, ${result.options.population} profiles, ${result.options.screeningGames} screening games/profile, ${result.options.finalistGames} finalist games/profile`,
    `Players: ${result.options.playerCounts.join(', ')}; turns: ${result.options.deckSizes.join(', ')}; random seed ${result.options.seed}`,
    `Opponent mix: ${result.options.opponentMix}; exposure ${formatExposure(result.options.opponentSummary?.exposure)}`,
    `Best: ${result.best.name}, objective ${result.best.metrics.objective}, win ${Math.round(result.best.metrics.winRate * 100)}%, rank ${result.best.metrics.averageRank}, score margin ${result.best.metrics.averagePointMargin}, fall ${Math.round(result.best.metrics.fallRate * 100)}%, credible coups ${Math.round(result.best.metrics.credibleSelfClaimRate * 100)}%, coup wins ${Math.round(result.best.metrics.selfClaimWinRate * 100)}%`,
    'Champion leaderboard:',
    ...result.champions.map((entry, index) => (
      `- #${index + 1} ${entry.name}: objective ${entry.metrics.objective}, win ${Math.round(entry.metrics.winRate * 100)}%, rank ${entry.metrics.averageRank}, credible coups ${Math.round(entry.metrics.credibleSelfClaimRate * 100)}%`
    )),
    'Generation winners:',
    ...result.generations.map((entry) => (
      `- g${entry.generation}: ${entry.best.name}, objective ${entry.best.metrics.objective}, win ${Math.round(entry.best.metrics.winRate * 100)}%, rank ${entry.best.metrics.averageRank}`
    )),
    'Best compact weights:',
    JSON.stringify(result.best.compactWeights, null, 2),
  ];
  if (result.saved) {
    lines.push(`Saved opponents: ${result.saved.opponents.map((entry) => `${entry.firstName} (${entry.id})`).join(', ')}`);
    lines.push(`Saved to: ${result.saved.path}`);
  }
  return lines.join('\n');
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!isMainThread && workerData?.kind === 'evaluate-profile') {
  try {
    const profile = workerData.profile;
    const metrics = evaluateStrategyWeights(
      profile.weights,
      workerData.options,
      workerData.profileIndex,
    );
    parentPort.postMessage({ ok: true, metrics });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.message || String(error) });
  }
} else if (isCli) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.json && !options.quiet) options.onProgress = createCliProgressLogger();
  const result = await trainStrategyWeightsAsync(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatTrainingReport(result));
}
