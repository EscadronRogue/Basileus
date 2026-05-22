import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { makeRng } from '../engine/state.js';
import { simulateGame } from './simulate.js';
import { DEFAULT_STRATEGY_WEIGHTS } from './strategy.js';
import { POLICY_WEIGHT_PRESETS } from './policies.js';
import { pickGreekFirstName, slugifyGreekFirstName } from './greekNames.js';
import { normalizeTunedOpponentRoster } from './opponentRoster.js';

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
  fallPenalty: 130,
  opponentMix: 'robust',
  selfPlayEvery: null,
  championPoolSize: 6,
  save: true,
  outputPath: fileURLToPath(new URL('./tunedOpponents.json', import.meta.url)),
  league: ['strategic', 'defender', 'usurper', 'profiteer', 'random', 'copycat'],
};

const TRAINING_OPPONENT_MIXES = Object.freeze({
  beginner: {
    label: 'Beginner',
    selfPlayEvery: 4,
    championWeight: 0,
    nonChampionWeight: 6,
    builtInWeights: [
      ['strategic', 1],
      ['defender', 1],
      ['usurper', 1],
      ['profiteer', 1],
      ['random', 1],
      ['copycat', 1],
    ],
  },
  robust: {
    label: 'Robust',
    selfPlayEvery: 3,
    championWeight: 9,
    nonChampionWeight: 10,
    builtInWeights: [
      ['strategic', 2],
      ['defender', 2],
      ['usurper', 2],
      ['profiteer', 2],
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
  invasionMargin: [0.35, 2.4],
  capitalFallPenalty: [100, 1400],
  capitalRiskPenalty: [20, 500],
  invasionVictoryBonus: [0, 24],
  invasionDefeatPenalty: [0, 34],
  recoveryBonus: [0, 2.5],
  throneBase: [0, 80],
  throneProgress: [0, 0],
  selfClaim: [0.05, 2.4],
  incumbentDefense: [0.1, 2.4],
  supportLeaderPenalty: [0.1, 2.4],
  supportOtherClaimant: [0, 1.8],
  reserveValue: [0, 1.2],
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
  coalitionWillingness: [0, 2.4],
  relationshipCoupWeight: [0, 1.8],
  coalitionDefectionPenalty: [0, 2.4],
  surplusDefensePenalty: [0, 2.4],
  frontierSurplusValue: [0, 1],
  frontierSurplusCap: [0, 24],
  coupOpportunityWeight: [0, 2.4],
  allyDefenseReliance: [0.55, 1],
  selfClaimThreshold: [0.7, 1.8],
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
  const namedProfiles = [
    ['strategic', {}],
    ['defender', POLICY_WEIGHT_PRESETS.defender],
    ['usurper', POLICY_WEIGHT_PRESETS.usurper],
    ['profiteer', POLICY_WEIGHT_PRESETS.profiteer],
    ['greedy', POLICY_WEIGHT_PRESETS.greedy],
    ['loyalist', POLICY_WEIGHT_PRESETS.loyalist],
  ];
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
  const resolutions = Math.max(1, Number(game.stats?.resolutions) || 0);
  const orders = Math.max(1, Number(game.stats?.deployment?.orders) || 0);
  const victoryRate = (Number(game.stats?.wars?.victory) || 0) / resolutions;
  const defeatRate = (Number(game.stats?.wars?.defeat) || 0) / resolutions;
  const averageWarMargin = (Number(game.stats?.wars?.marginTotal) || 0) / resolutions;
  const selfClaimRate = (Number(game.stats?.coups?.selfClaims) || 0) / orders;
  const capitalTroopsPerOrder = (Number(game.stats?.deployment?.capitalTroops) || 0) / orders;
  const fundedTroopsPerOrder = (Number(game.stats?.deployment?.fundedTroops) || 0) / orders;
  const appointmentStats = game.appointmentStatsByPlayer?.[candidateSeat] || {};
  const appointmentUnlocks = Number(appointmentStats.unlockAppointments) || 0;
  const unresolvedAppointmentLock = appointmentStats.finalSelfLocked ? 1 : 0;
  const won = game.winnerIds.includes(candidateSeat);

  let objective = won ? 160 : 0;
  objective += (playerCount - rank) * 34;
  objective += (Number(entry.points) || 0) * 8;
  objective += (Number(entry.gold) || 0) * 0.25;
  objective += (Number(entry.projectedIncome) || 0) * 0.5;
  objective += victoryRate * 24;
  objective -= defeatRate * 34;
  objective -= Math.max(0, averageWarMargin - 7) * 3.2;
  objective -= Math.max(0, victoryRate - 0.88) * 24;
  objective -= Math.max(0, 0.12 - selfClaimRate) * 54;
  objective += Math.min(0.3, selfClaimRate) * 18;
  if (capitalTroopsPerOrder < 1 && selfClaimRate < 0.14) {
    objective -= (1 - capitalTroopsPerOrder) * 7;
  }
  objective += appointmentUnlocks * 10;
  objective -= unresolvedAppointmentLock * 18;
  if (game.fall) objective -= options.fallPenalty;
  if (game.reason === 'stuck') objective -= 100;

  return {
    objective,
    won,
    rank,
    points: Number(entry.points) || 0,
    fall: Boolean(game.fall),
    averageWarMargin,
    selfClaimRate,
    capitalTroopsPerOrder,
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
  let falls = 0;
  let stuck = 0;
  let appointmentUnlocks = 0;
  let selfAppointments = 0;
  let unresolvedAppointmentLocks = 0;
  let averageWarMargin = 0;
  let selfClaimRate = 0;
  let capitalTroopsPerOrder = 0;
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
    falls += score.fall ? 1 : 0;
    stuck += game.reason === 'stuck' ? 1 : 0;
    averageWarMargin += score.averageWarMargin;
    selfClaimRate += score.selfClaimRate;
    capitalTroopsPerOrder += score.capitalTroopsPerOrder;
    fundedTroopsPerOrder += score.fundedTroopsPerOrder;
    appointmentUnlocks += score.appointmentUnlocks;
    selfAppointments += score.selfAppointments;
    unresolvedAppointmentLocks += score.unresolvedAppointmentLock;
  }

  return {
    objective: round(total / options.games),
    winRate: round(wins / options.games),
    averageRank: round(rankTotal / options.games),
    averagePoints: round(pointTotal / options.games),
    fallRate: round(falls / options.games),
    averageWarMargin: round(averageWarMargin / options.games),
    selfClaimRate: round(selfClaimRate / options.games),
    capitalTroopsPerOrder: round(capitalTroopsPerOrder / options.games),
    fundedTroopsPerOrder: round(fundedTroopsPerOrder / options.games),
    appointmentUnlockRate: round(appointmentUnlocks / Math.max(1, selfAppointments)),
    unresolvedAppointmentLocks: round(unresolvedAppointmentLocks / options.games),
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

function saveBestOpponent(result) {
  const existing = readSavedOpponents(result.options.outputPath);
  const firstName = pickGreekFirstName(`${result.options.seed}:${Date.now()}:${result.best.metrics.objective}`);
  const entry = {
    id: uniqueTunedId(firstName, existing),
    firstName,
    label: 'Tuned AI',
    description: trainingDescription(result.options),
    policy: {
      policyId: 'tuned',
      strategyWeights: result.best.weights,
    },
    strategyWeights: result.best.weights,
    metrics: result.best.metrics,
    training: {
      trainedAt: new Date().toISOString(),
      generations: result.options.generations,
      population: result.options.population,
      gamesPerCandidate: result.options.games,
      playerCounts: result.options.playerCounts,
      deckSizes: result.options.deckSizes,
      seed: result.options.seed,
      league: result.options.league,
      opponentMix: result.options.opponentMix,
      opponentExposure: result.options.opponentSummary?.exposure || null,
      championOpponentIds: result.options.opponentSummary?.championOpponentIds || [],
      selfPlayEvery: result.options.selfPlayEvery,
      fallPenalty: result.options.fallPenalty,
      appointmentUnlockRate: result.best.metrics.appointmentUnlockRate,
      unresolvedAppointmentLocks: result.best.metrics.unresolvedAppointmentLocks,
    },
  };
  const payload = {
    version: 1,
    updatedAt: entry.training.trainedAt,
    opponents: [entry, ...existing].slice(0, 24),
  };
  writeFileSync(result.options.outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path: result.options.outputPath, opponent: entry };
}

function normalizeOptions(rawOptions = {}) {
  const population = Math.max(2, toInt(rawOptions.population, DEFAULT_OPTIONS.population));
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
    games: Math.max(1, toInt(rawOptions.games, DEFAULT_OPTIONS.games)),
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
  };
}

function emitProgress(options, event) {
  if (typeof options.onProgress === 'function') options.onProgress(event);
}

export function trainStrategyWeights(rawOptions = {}) {
  const options = finalizeTrainingOptions({ ...rawOptions, seed: randomTrainingSeed() });
  const rng = makeRng(options.seed);
  let population = seedPopulation(options, rng);
  const generations = [];
  let best = null;
  const startedAt = Date.now();

  emitProgress(options, {
    type: 'training-start',
    generations: options.generations,
    population: options.population,
    games: options.games,
    totalGames: options.generations * options.population * options.games,
    playerCounts: options.playerCounts,
    deckSizes: options.deckSizes,
    league: options.league,
    opponentMix: options.opponentMix,
    opponentSummary: options.opponentSummary,
    seed: options.seed,
    elapsedMs: 0,
  });

  for (let generation = 0; generation < options.generations; generation += 1) {
    emitProgress(options, {
      type: 'generation-start',
      generation: generation + 1,
      generations: options.generations,
      elapsedMs: Date.now() - startedAt,
    });

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
        games: options.games,
        elapsedMs: Date.now() - startedAt,
      });
      const metrics = evaluateStrategyWeights(profile.weights, options, generation * options.population + index);
      const candidate = { ...profile, metrics };
      evaluated.push(candidate);
      emitProgress(options, {
        type: 'candidate-end',
        generation: generation + 1,
        generations: options.generations,
        candidate: index + 1,
        population: options.population,
        name: profile.name,
        metrics,
        elapsedMs: Date.now() - startedAt,
      });
    }
    evaluated.sort((left, right) => right.metrics.objective - left.metrics.objective);

    if (!best || evaluated[0].metrics.objective > best.metrics.objective) best = evaluated[0];
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
      globalBestName: best.name,
      globalBestMetrics: best.metrics,
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

  const result = {
    options,
    best: {
      name: best.name,
      metrics: best.metrics,
      weights: best.weights,
      compactWeights: compactWeights(best.weights),
    },
    generations,
  };
  if (options.save) {
    result.saved = saveBestOpponent(result);
    emitProgress(options, {
      type: 'saved',
      firstName: result.saved.opponent.firstName,
      id: result.saved.opponent.id,
      path: result.saved.path,
      elapsedMs: Date.now() - startedAt,
    });
  }
  emitProgress(options, {
    type: 'training-end',
    bestName: result.best.name,
    bestMetrics: result.best.metrics,
    saved: result.saved || null,
    elapsedMs: Date.now() - startedAt,
  });
  return result;
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
  return `objective ${metrics.objective}, win ${percent(metrics.winRate)}, rank ${metrics.averageRank}, fall ${percent(metrics.fallRate)}, margin ${metrics.averageWarMargin}, self-claim ${percent(metrics.selfClaimRate)}, unlock ${percent(metrics.appointmentUnlockRate)}`;
}

function createCliProgressLogger() {
  return (event) => {
    if (event.type === 'training-start') {
      console.log(`[train ${seconds(event.elapsedMs)}] Starting ${event.generations} generations x ${event.population} profiles x ${event.games} games (${event.totalGames} games total), seed ${event.seed}. Players ${event.playerCounts.join('/')}, decks ${event.deckSizes.join('/')}.`);
      console.log(`[train ${seconds(event.elapsedMs)}] Opponent mix: ${event.opponentMix}; expected exposure ${formatExposure(event.opponentSummary?.exposure)}.`);
    } else if (event.type === 'generation-start') {
      console.log(`[train ${seconds(event.elapsedMs)}] Generation ${event.generation}/${event.generations} started.`);
    } else if (event.type === 'candidate-start') {
      console.log(`[train ${seconds(event.elapsedMs)}]   Candidate ${event.candidate}/${event.population}: ${event.name} (${event.games} games)`);
    } else if (event.type === 'candidate-end') {
      console.log(`[train ${seconds(event.elapsedMs)}]   -> ${event.name}: ${compactMetrics(event.metrics)}`);
    } else if (event.type === 'generation-end') {
      console.log(`[train ${seconds(event.elapsedMs)}] Generation ${event.generation}/${event.generations} winner: ${event.bestName} (${compactMetrics(event.bestMetrics)}). Global best: ${event.globalBestName}.`);
    } else if (event.type === 'saved') {
      console.log(`[train ${seconds(event.elapsedMs)}] Saved ${event.firstName} (${event.id}) to ${event.path}.`);
    } else if (event.type === 'training-end') {
      console.log(`[train ${seconds(event.elapsedMs)}] Finished. Best: ${event.bestName} (${compactMetrics(event.bestMetrics)}).`);
    }
  };
}

function formatTrainingReport(result) {
  const lines = [
    `AI training: ${result.options.generations} generations, ${result.options.population} profiles, ${result.options.games} games/profile`,
    `Players: ${result.options.playerCounts.join(', ')}; decks: ${result.options.deckSizes.join(', ')}; random seed ${result.options.seed}`,
    `Opponent mix: ${result.options.opponentMix}; exposure ${formatExposure(result.options.opponentSummary?.exposure)}`,
    `Best: ${result.best.name}, objective ${result.best.metrics.objective}, win ${Math.round(result.best.metrics.winRate * 100)}%, rank ${result.best.metrics.averageRank}, fall ${Math.round(result.best.metrics.fallRate * 100)}%, margin ${result.best.metrics.averageWarMargin}, self-claim ${Math.round(result.best.metrics.selfClaimRate * 100)}%, unlock ${Math.round(result.best.metrics.appointmentUnlockRate * 100)}%`,
    'Generation winners:',
    ...result.generations.map((entry) => (
      `- g${entry.generation}: ${entry.best.name}, objective ${entry.best.metrics.objective}, win ${Math.round(entry.best.metrics.winRate * 100)}%, rank ${entry.best.metrics.averageRank}`
    )),
    'Best compact weights:',
    JSON.stringify(result.best.compactWeights, null, 2),
  ];
  if (result.saved) {
    lines.push(`Saved opponent: ${result.saved.opponent.firstName} (${result.saved.opponent.id})`);
    lines.push(`Saved to: ${result.saved.path}`);
  }
  return lines.join('\n');
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.json && !options.quiet) options.onProgress = createCliProgressLogger();
  const result = trainStrategyWeights(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatTrainingReport(result));
}
