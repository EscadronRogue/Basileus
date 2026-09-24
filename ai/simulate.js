import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { setDealParticipantIds } from '../engine/deals.js';
import { createGameState } from '../engine/state.js';
import { handleContinueAfterResolution, runAiRuntime, startInteractiveRuntime } from '../game/runtime.js';
import { getMercenaryHireCost } from '../engine/rules.js';
import { buildFinalScores } from '../engine/scoring.js';
import { getDeploymentArmyTroopEntry, getPlayerDeploymentArmyKeys } from '../engine/deployment.js';
import { getPreferredCoupCandidate, normalizeCoupRanking, normalizeCoupSupport } from '../engine/coup.js';
import { createAIMeta } from './brain.js';
import { loadTunedOpponentRosterSync } from './nodeOpponentRoster.js';

const DEFAULT_OPTIONS = {
  games: 100,
  playerCount: 5,
  deckSize: 9,
  seed: 1,
  maxSteps: 500,
  samples: 5,
  historyEnabled: true,
  policies: null,
  allowUntunedPolicies: false,
};

const FALL_RATE_ACCEPTABLE_MIN = 0.25;
const FALL_RATE_IDEAL_MIN = 0.4;
const FALL_RATE_IDEAL_MAX = 0.5;
const FALL_RATE_ACCEPTABLE_MAX = 0.75;

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function emptyStats(options) {
  return {
    options,
    games: 0,
    completed: 0,
    falls: 0,
    stuck: 0,
    rounds: 0,
    resolutions: 0,
    wars: {
      victory: 0,
      stalemate: 0,
      defeat: 0,
      reachedCPL: 0,
      themesLost: 0,
      themesRecovered: 0,
      marginTotal: 0,
    },
    coups: {
      throneChanges: 0,
      incumbentHolds: 0,
      selfClaims: 0,
      selfFirst: 0,
      incumbentBacks: 0,
      otherBacks: 0,
    },
    deployment: {
      orders: 0,
      frontierTroops: 0,
      capitalTroops: 0,
      idleTroops: 0,
      fundedTroops: 0,
      mercenaries: 0,
      mercenaryCost: 0,
    },
    court: {
      appointStrategos: 0,
      appointBishop: 0,
      revokeMinor: 0,
      revokeTheme: 0,
    },
    estates: {
      bids: 0,
      bidGold: 0,
      bought: 0,
      goldSpent: 0,
    },
    scoring: {
      winnerScore: 0,
      averageScore: 0,
      pointGap: 0,
      categories: {},
    },
    winners: {},
    fallRounds: {},
    fallInvasions: {},
    players: {},
    samples: [],
  };
}

function addCount(target, key, amount = 1) {
  target[key] = (target[key] || 0) + amount;
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function createPlayerStats() {
  return {
    orders: 0,
    frontierTroops: 0,
    capitalTroops: 0,
    idleTroops: 0,
    fundedTroops: 0,
    mercenaries: 0,
    mercenaryCost: 0,
    selfClaims: 0,
    selfFirst: 0,
    selfClaimWins: 0,
    selfClaimTroops: 0,
    credibleSelfClaims: 0,
    tokenSelfClaims: 0,
    incumbentBacks: 0,
    otherBacks: 0,
  };
}

function ensurePlayerStats(stats, playerId) {
  const key = String(playerId);
  if (!stats.players[key]) stats.players[key] = createPlayerStats();
  return stats.players[key];
}

function getOrderOfficeKeys(state, playerId) {
  return getPlayerDeploymentArmyKeys(state, playerId);
}

function summarizeOrders(state, playerId) {
  const orders = state.allOrders?.[playerId] || {};
  let frontierTroops = 0;
  let capitalTroops = 0;
  let idleTroops = 0;
  let fundedTroops = 0;

  for (const officeKey of getOrderOfficeKeys(state, playerId)) {
    const pool = getDeploymentArmyTroopEntry(state, playerId, officeKey);
    const total = pool.normal + pool.capitalLocked;
    const order = orders.armies?.[officeKey] || {};
    const funded = Math.max(0, Math.min(total, Number(order.funded) || 0));
    const fundedLocked = Math.min(pool.capitalLocked, funded);
    const fundedNormal = Math.min(pool.normal, Math.max(0, funded - fundedLocked));
    const destination = order.destination === 'capital' ? 'capital' : 'frontier';

    fundedTroops += funded;
    idleTroops += total - funded;
    capitalTroops += fundedLocked + (destination === 'capital' ? fundedNormal : 0);
    frontierTroops += destination === 'frontier' ? fundedNormal : 0;
  }

  const mercenaries = state.mercenaryOrders?.[playerId] || orders.mercenaries || {};
  const mercenaryCount = Math.max(0, Math.min(10, Number(mercenaries.count) || 0));
  if (mercenaries.destination === 'capital') capitalTroops += mercenaryCount;
  else frontierTroops += mercenaryCount;

  const ranking = normalizeCoupRanking(state, playerId, orders.ranking, orders.candidate);
  const candidateSupport = normalizeCoupSupport(state, orders.candidateSupport);

  return {
    playerId,
    // Best-ranked supported claimant other than the player themselves.
    candidate: Number.isInteger(Number(orders.candidate))
      ? Number(orders.candidate)
      : getPreferredCoupCandidate(state, playerId, { ...orders, ranking, candidateSupport }),
    // Whoever the ranking actually puts first, which can be the player.
    topPreference: ranking.find((candidateId) => candidateSupport[candidateId] !== false) ?? playerId,
    frontierTroops,
    capitalTroops,
    idleTroops,
    fundedTroops,
    mercenaryCount,
    mercenaryCost: getMercenaryHireCost(0, mercenaryCount),
  };
}

function collectResolution(stats, state) {
  stats.resolutions += 1;

  const war = state.lastWarResult;
  if (war) {
    addCount(stats.wars, war.outcome || 'unknown');
    if (war.reachedCPL) stats.wars.reachedCPL += 1;
    stats.wars.themesLost += Array.isArray(war.themesLost) ? war.themesLost.length : 0;
    stats.wars.themesRecovered += Array.isArray(war.themesRecovered) ? war.themesRecovered.length : 0;
    stats.wars.marginTotal += (Number(war.frontierTroops) || 0) - (Number(war.invaderStrength) || 0);
  }

  const coup = state.lastCoupResult;
  if (coup) {
    if (coup.winner === state.basileusId) stats.coups.incumbentHolds += 1;
    else stats.coups.throneChanges += 1;
  }

  for (const player of state.players || []) {
    const order = summarizeOrders(state, player.id);
    const playerStats = ensurePlayerStats(stats, player.id);

    stats.deployment.orders += 1;
    stats.deployment.frontierTroops += order.frontierTroops;
    stats.deployment.capitalTroops += order.capitalTroops;
    stats.deployment.idleTroops += order.idleTroops;
    stats.deployment.fundedTroops += order.fundedTroops;
    stats.deployment.mercenaries += order.mercenaryCount;
    stats.deployment.mercenaryCost += order.mercenaryCost;

    playerStats.orders += 1;
    playerStats.frontierTroops += order.frontierTroops;
    playerStats.capitalTroops += order.capitalTroops;
    playerStats.idleTroops += order.idleTroops;
    playerStats.fundedTroops += order.fundedTroops;
    playerStats.mercenaries += order.mercenaryCount;
    playerStats.mercenaryCost += order.mercenaryCost;

    // Report metric: who the ranking actually puts first (often the player).
    if (order.topPreference === player.id) {
      stats.coups.selfFirst += 1;
      playerStats.selfFirst += 1;
    }

    // Training inputs (ai/train.js) keep their original single-candidate
    // definition. `candidate` is the best non-self pick under ranking coups,
    // so these self-claim counters stay at zero; see docs/roadmap.md before
    // redefining them, as that changes what training rewards.
    if (order.candidate === player.id) {
      stats.coups.selfClaims += 1;
      playerStats.selfClaims += 1;
      playerStats.selfClaimTroops += order.capitalTroops;
      if (order.capitalTroops >= 3) playerStats.credibleSelfClaims += 1;
      else playerStats.tokenSelfClaims += 1;
      if (coup?.winner === player.id && order.capitalTroops > 0) playerStats.selfClaimWins += 1;
    } else if (order.candidate === state.basileusId) {
      stats.coups.incumbentBacks += 1;
      playerStats.incumbentBacks += 1;
    } else {
      stats.coups.otherBacks += 1;
      playerStats.otherBacks += 1;
    }
  }
}

function collectEventStats(stats, state) {
  for (const event of state.log || []) {
    if (event.type === 'appoint_strategos') stats.court.appointStrategos += 1;
    else if (event.type === 'appoint_bishop') stats.court.appointBishop += 1;
    else if (event.type === 'revoke_minor') stats.court.revokeMinor += 1;
    else if (event.type === 'revoke_theme') stats.court.revokeTheme += 1;
    else if (event.type === 'land_bid') {
      stats.estates.bids += 1;
      stats.estates.bidGold += Number(event.bid) || 0;
    } else if (event.type === 'buy') {
      stats.estates.bought += 1;
      stats.estates.goldSpent += Number(event.cost) || 0;
    }
  }
}

function createAppointmentStats() {
  return {
    selfAppointments: 0,
    otherAppointments: 0,
    unlockAppointments: 0,
    finalSelfLocked: false,
  };
}

function collectAppointmentStatsByPlayer(state) {
  const byPlayer = Object.fromEntries(
    (state.players || []).map((player) => [player.id, createAppointmentStats()]),
  );
  const selfLocked = Object.fromEntries((state.players || []).map((player) => [player.id, false]));

  for (const event of state.history || []) {
    if (!['appoint_strategos', 'appoint_bishop'].includes(event.type)) continue;
    const appointerId = Number(event.actorId);
    const appointeeId = Number(event.details?.appointeeId);
    if (!Number.isInteger(appointerId) || !Number.isInteger(appointeeId) || !byPlayer[appointerId]) continue;

    if (appointeeId === appointerId) {
      byPlayer[appointerId].selfAppointments += 1;
      selfLocked[appointerId] = true;
      continue;
    }

    byPlayer[appointerId].otherAppointments += 1;
    if (selfLocked[appointerId]) byPlayer[appointerId].unlockAppointments += 1;
    selfLocked[appointerId] = false;
  }

  for (const player of state.players || []) {
    if (!byPlayer[player.id]) continue;
    byPlayer[player.id].finalSelfLocked = Boolean(player.appointmentCooldown?.selfLocked);
  }

  return byPlayer;
}

function collectScoring(stats, state) {
  const final = buildFinalScores(state);
  const winner = final.winners[0] || null;
  if (winner) {
    stats.scoring.winnerScore += winner.points;
    addCount(stats.winners, String(winner.playerId));
  }

  const scoreTotal = final.scores.reduce((total, entry) => total + entry.points, 0);
  stats.scoring.averageScore += final.scores.length ? scoreTotal / final.scores.length : 0;
  if (final.scores.length > 1) {
    stats.scoring.pointGap += final.scores[0].points - final.scores[1].points;
  }

  for (const entry of final.scores) {
    for (const category of entry.categories || []) {
      if (!stats.scoring.categories[category.key]) {
        stats.scoring.categories[category.key] = { points: 0, value: 0, share: 0, count: 0 };
      }
      const bucket = stats.scoring.categories[category.key];
      bucket.points += Number(category.points) || 0;
      bucket.value += Number(category.value) || 0;
      bucket.share += Number(category.share) || 0;
      bucket.count += 1;
    }
  }
}

function compactGameSample(game) {
  return {
    seed: game.seed,
    rounds: game.rounds,
    phase: game.phase,
    fall: game.fall,
    winnerIds: game.winnerIds,
    topScore: game.topScore,
    reason: game.reason,
  };
}

function rememberSample(stats, game) {
  if (stats.samples.length < stats.options.samples) {
    stats.samples.push(compactGameSample(game));
    return;
  }
  if (!game.fall && game.reason !== 'stuck') return;
  const replaceIndex = stats.samples.findIndex((sample) => !sample.fall && sample.reason !== 'stuck');
  if (replaceIndex >= 0) stats.samples[replaceIndex] = compactGameSample(game);
}

function policyIdFor(policy) {
  if (typeof policy === 'string') return policy;
  return policy?.policy?.policyId || policy?.policyId || policy?.policy || policy?.id || '';
}

function policyLabel(policy) {
  if (typeof policy === 'string') return policy;
  return policy?.label || policy?.firstName || policy?.id || policyIdFor(policy) || 'unknown';
}

function policyWeightsFor(policy) {
  return policy?.policy?.strategyWeights || policy?.strategyWeights || policy?.weights || {};
}

function isTunedPolicy(policy) {
  return policyIdFor(policy) === 'tuned' && Object.keys(policyWeightsFor(policy)).length > 0;
}

function aiPlayerFromTunedOpponent(opponent) {
  return {
    opponent,
    displayName: opponent.firstName || opponent.label || opponent.id || 'Tuned AI',
    opponentId: opponent.id || null,
    policy: opponent.policy || {
      policyId: 'tuned',
      strategyWeights: opponent.strategyWeights || opponent.weights || {},
    },
    strategyWeights: opponent.strategyWeights || opponent.policy?.strategyWeights || opponent.weights || {},
  };
}

function aiPlayerFromPolicy(policy, options) {
  if (!options.allowUntunedPolicies && !isTunedPolicy(policy)) {
    throw new Error(
      `Simulation policy "${policyLabel(policy)}" is not a saved tuned AI. `
        + 'Non-tuned policies are only allowed by the training harness.',
    );
  }
  if (isTunedPolicy(policy) && (policy.id || policy.firstName || policy.policy)) {
    return aiPlayerFromTunedOpponent(policy);
  }
  return { policy };
}

function getExplicitSeatPolicy(options, seatId) {
  const policies = options.policies;
  if (!policies) return null;
  if (Array.isArray(policies)) return policies[seatId % policies.length] || null;
  return policies;
}

function resolveSeatAiPlayer(options, seatId, seed, tunedRoster) {
  const explicitPolicy = getExplicitSeatPolicy(options, seatId);
  if (explicitPolicy) {
    if (typeof explicitPolicy === 'string') {
      const tunedOpponent = tunedRoster.find((opponent) => opponent.id === explicitPolicy);
      if (tunedOpponent) return aiPlayerFromTunedOpponent(tunedOpponent);
    }
    return aiPlayerFromPolicy(explicitPolicy, options);
  }

  if (!tunedRoster.length) {
    throw new Error('No tuned AI opponents found. Run npm run train:ai first, then simulate saved tuned opponents.');
  }

  const baseSeed = Math.max(0, Number(seed) || 0);
  const index = (baseSeed + seatId) % tunedRoster.length;
  return aiPlayerFromTunedOpponent(tunedRoster[index]);
}

function createAllAiGame(options, seed) {
  const state = createGameState({
    playerCount: options.playerCount,
    deckSize: options.deckSize,
    seed,
    historyEnabled: options.historyEnabled !== false,
  });
  setDealParticipantIds(state, state.players.map((player) => player.id));
  const tunedRoster = loadTunedOpponentRosterSync();
  const aiPlayers = Object.fromEntries(
    state.players.map((player) => [player.id, resolveSeatAiPlayer(options, player.id, seed, tunedRoster)]),
  );
  const meta = createAIMeta(state, { humanPlayerIds: [], aiPlayers });
  const context = {};
  return { state, meta, context };
}

export function simulateGame(rawOptions = {}, gameIndex = 0) {
  const options = { ...DEFAULT_OPTIONS, ...rawOptions };
  const seed = toInt(options.seed, DEFAULT_OPTIONS.seed) + gameIndex;
  const { state, meta, context } = createAllAiGame(options, seed);
  const localStats = emptyStats({ ...options, games: 1, seed });
  let reason = 'complete';

  startInteractiveRuntime(state, meta, context);

  for (let step = 0; step < options.maxSteps; step += 1) {
    if (state.phase === 'resolution') {
      collectResolution(localStats, state);
      const result = handleContinueAfterResolution(state, meta, context);
      if (!result.ok) {
        reason = result.reason || 'resolution-blocked';
        break;
      }
      continue;
    }

    if (state.gameOver || state.phase === 'scoring') break;

    const before = `${state.round}:${state.phase}:${Object.keys(state.allOrders || {}).length}`;
    runAiRuntime(state, meta, context, { courtMode: 'finish' });
    const after = `${state.round}:${state.phase}:${Object.keys(state.allOrders || {}).length}`;
    if (before === after && state.phase !== 'resolution') {
      reason = 'stuck';
      break;
    }
  }

  if (!state.gameOver && state.phase !== 'scoring' && reason === 'complete') reason = 'stuck';

  collectEventStats(localStats, state);
  collectScoring(localStats, state);
  const appointmentStatsByPlayer = collectAppointmentStatsByPlayer(state);

  const final = buildFinalScores(state);
  return {
    seed,
    reason,
    phase: state.phase,
    rounds: state.round,
    fall: state.gameOver?.type === 'fall',
    fallInvasion: state.gameOver?.type === 'fall' ? state.currentInvasion?.id || 'unknown' : null,
    policyIds: Object.fromEntries(Object.entries(meta.players || {}).map(([playerId, entry]) => [playerId, entry.policyId || 'strategic'])),
    opponentIds: Object.fromEntries(Object.entries(meta.players || {}).map(([playerId, entry]) => [playerId, entry.opponentId || null])),
    finalScores: final.scores.map((entry) => ({
      playerId: entry.playerId,
      points: entry.points,
      gold: entry.gold,
      projectedIncome: entry.projectedIncome,
    })),
    winnerIds: final.winners.map((entry) => entry.playerId),
    topScore: final.topScore,
    appointmentStatsByPlayer,
    playerStatsByPlayer: localStats.players,
    stats: localStats,
  };
}

function mergeStats(target, source) {
  target.completed += source.reason === 'complete' ? 1 : 0;
  target.falls += source.fall ? 1 : 0;
  target.stuck += source.reason === 'stuck' ? 1 : 0;
  target.rounds += source.rounds;
  target.resolutions += source.stats.resolutions;

  for (const [key, value] of Object.entries(source.stats.wars)) target.wars[key] += value;
  for (const [key, value] of Object.entries(source.stats.coups)) target.coups[key] += value;
  for (const [key, value] of Object.entries(source.stats.deployment)) target.deployment[key] += value;
  for (const [key, value] of Object.entries(source.stats.court)) target.court[key] += value;
  for (const [key, value] of Object.entries(source.stats.estates)) target.estates[key] += value;
  for (const [key, value] of Object.entries(source.stats.scoring)) {
    if (key === 'categories') continue;
    target.scoring[key] += value;
  }
  for (const [key, bucket] of Object.entries(source.stats.scoring.categories)) {
    if (!target.scoring.categories[key]) target.scoring.categories[key] = { points: 0, value: 0, share: 0, count: 0 };
    target.scoring.categories[key].points += bucket.points;
    target.scoring.categories[key].value += bucket.value;
    target.scoring.categories[key].share += bucket.share;
    target.scoring.categories[key].count += bucket.count;
  }
  for (const [playerId, wins] of Object.entries(source.stats.winners)) addCount(target.winners, playerId, wins);
  if (source.fall) {
    addCount(target.fallRounds, String(source.rounds));
    addCount(target.fallInvasions, source.fallInvasion || 'unknown');
  }
  rememberSample(target, source);
}

function normalizeSimulationOptions(rawOptions = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...rawOptions,
    games: Math.max(1, toInt(rawOptions.games, DEFAULT_OPTIONS.games)),
    playerCount: Math.max(3, Math.min(5, toInt(rawOptions.playerCount, DEFAULT_OPTIONS.playerCount))),
    deckSize: Math.max(1, toInt(rawOptions.deckSize, DEFAULT_OPTIONS.deckSize)),
    seed: toInt(rawOptions.seed, DEFAULT_OPTIONS.seed),
    maxSteps: Math.max(20, toInt(rawOptions.maxSteps, DEFAULT_OPTIONS.maxSteps)),
    samples: Math.max(0, toInt(rawOptions.samples, DEFAULT_OPTIONS.samples)),
    historyEnabled: rawOptions.historyEnabled !== false,
    policies: rawOptions.policies || null,
    allowUntunedPolicies: Boolean(rawOptions.allowUntunedPolicies),
  };
}

function aggregateGames(options, games) {
  const stats = emptyStats(options);
  for (const game of games) {
    stats.games += 1;
    mergeStats(stats, game);
  }
  return normalizeStats(stats);
}

export function simulateGames(rawOptions = {}) {
  const options = normalizeSimulationOptions(rawOptions);
  const games = [];
  for (let gameIndex = 0; gameIndex < options.games; gameIndex += 1) games.push(simulateGame(options, gameIndex));
  return aggregateGames(options, games);
}

export function defaultSimulationWorkers() {
  try {
    return Math.max(1, Math.min(4, availableParallelism() - 1));
  } catch {
    return 1;
  }
}

function simulateRangeInWorker(options, start, end) {
  return new Promise((resolveRange, rejectRange) => {
    const workerOptions = { workerData: { kind: 'simulate-games', options, start, end } };
    // Workers inherit the parent's flags by default. Only override them to drop
    // --input-type, which is invalid for file workers; passing execArgv
    // explicitly makes Node validate every flag, and some runners (Node 24's
    // test runner) add flags a worker refuses.
    if (process.execArgv.some((arg) => arg.startsWith('--input-type'))) {
      workerOptions.execArgv = process.execArgv.filter((arg) => !arg.startsWith('--input-type'));
    }
    const worker = new Worker(new URL(import.meta.url), workerOptions);
    worker.once('message', (message) => {
      if (message?.ok) resolveRange(message.games);
      else rejectRange(new Error(message?.error || 'Simulation worker failed.'));
    });
    worker.once('error', rejectRange);
    worker.once('exit', (code) => {
      if (code !== 0) rejectRange(new Error(`Simulation worker exited with code ${code}.`));
    });
  });
}

// Same results as simulateGames (games are seeded by index and merged in
// order), spread over worker threads.
export async function simulateGamesParallel(rawOptions = {}) {
  const options = normalizeSimulationOptions(rawOptions);
  const workers = Math.max(1, Math.min(options.games, toInt(rawOptions.workers, defaultSimulationWorkers())));
  if (workers <= 1) return simulateGames(options);
  const chunk = Math.ceil(options.games / workers);
  const ranges = [];
  for (let start = 0; start < options.games; start += chunk) ranges.push([start, Math.min(options.games, start + chunk)]);
  const results = await Promise.all(ranges.map(([start, end]) => simulateRangeInWorker(options, start, end)));
  return aggregateGames(options, results.flat());
}

function describeFallPressure(fallRate) {
  const rounded = round(fallRate, 3);
  if (fallRate < FALL_RATE_ACCEPTABLE_MIN) {
    return {
      band: 'low',
      rate: rounded,
      target: 'acceptable 25%-75%, ideal 40%-50%',
    };
  }
  if (fallRate > FALL_RATE_ACCEPTABLE_MAX) {
    return {
      band: 'high',
      rate: rounded,
      target: 'acceptable 25%-75%, ideal 40%-50%',
    };
  }
  if (fallRate >= FALL_RATE_IDEAL_MIN && fallRate <= FALL_RATE_IDEAL_MAX) {
    return {
      band: 'ideal',
      rate: rounded,
      target: 'acceptable 25%-75%, ideal 40%-50%',
    };
  }
  return {
    band: fallRate < FALL_RATE_IDEAL_MIN ? 'acceptable-low' : 'acceptable-high',
    rate: rounded,
    target: 'acceptable 25%-75%, ideal 40%-50%',
  };
}

function normalizeStats(stats) {
  const games = Math.max(1, stats.games);
  const resolutions = Math.max(1, stats.resolutions);
  const orders = Math.max(1, stats.deployment.orders);
  const fallRate = stats.falls / games;
  const categories = {};
  for (const [key, bucket] of Object.entries(stats.scoring.categories)) {
    const count = Math.max(1, bucket.count);
    categories[key] = {
      points: round(bucket.points / count),
      value: round(bucket.value / count),
      share: round(bucket.share / count, 3),
    };
  }

  return {
    options: stats.options,
    games: stats.games,
    completed: stats.completed,
    stuck: stats.stuck,
    fallRate: round(fallRate, 3),
    fallPressure: describeFallPressure(fallRate),
    averageRounds: round(stats.rounds / games),
    resolutions: stats.resolutions,
    wars: {
      victoryRate: round(stats.wars.victory / resolutions, 3),
      stalemateRate: round(stats.wars.stalemate / resolutions, 3),
      defeatRate: round(stats.wars.defeat / resolutions, 3),
      capitalFallRate: round(stats.wars.reachedCPL / resolutions, 3),
      averageMargin: round(stats.wars.marginTotal / resolutions),
      themesLostPerWar: round(stats.wars.themesLost / resolutions),
      themesRecoveredPerWar: round(stats.wars.themesRecovered / resolutions),
    },
    coups: {
      throneChangeRate: round(stats.coups.throneChanges / resolutions, 3),
      selfPreferenceRate: round(stats.coups.selfFirst / orders, 3),
      selfClaimRate: round(stats.coups.selfClaims / orders, 3),
      incumbentBackRate: round(stats.coups.incumbentBacks / orders, 3),
      otherBackRate: round(stats.coups.otherBacks / orders, 3),
    },
    deployment: {
      frontierTroopsPerOrder: round(stats.deployment.frontierTroops / orders),
      capitalTroopsPerOrder: round(stats.deployment.capitalTroops / orders),
      idleTroopsPerOrder: round(stats.deployment.idleTroops / orders),
      fundedTroopsPerOrder: round(stats.deployment.fundedTroops / orders),
      mercenariesPerOrder: round(stats.deployment.mercenaries / orders),
      mercenaryCostPerOrder: round(stats.deployment.mercenaryCost / orders),
    },
    court: Object.fromEntries(Object.entries(stats.court).map(([key, value]) => [key, round(value / games)])),
    estates: {
      bidsPerGame: round(stats.estates.bids / games),
      bidGoldPerGame: round(stats.estates.bidGold / games),
      purchasesPerGame: round(stats.estates.bought / games),
      goldSpentPerGame: round(stats.estates.goldSpent / games),
    },
    scoring: {
      winnerScore: round(stats.scoring.winnerScore / games),
      averageScore: round(stats.scoring.averageScore / games),
      pointGap: round(stats.scoring.pointGap / games),
      categories,
    },
    winners: stats.winners,
    seatWinRates: Object.fromEntries(
      Array.from({ length: stats.options.playerCount }, (_, seat) => [seat, round((stats.winners[seat] || 0) / games, 3)]),
    ),
    fallRoundRates: Object.fromEntries(
      Object.entries(stats.fallRounds)
        .sort(([left], [right]) => Number(left) - Number(right))
        .map(([roundNumber, count]) => [roundNumber, round(count / games, 3)]),
    ),
    fallInvasionRates: Object.fromEntries(
      Object.entries(stats.fallInvasions)
        .sort(([, left], [, right]) => right - left)
        .map(([invasionId, count]) => [invasionId, round(count / games, 3)]),
    ),
    earlyFallRate: round(
      Object.entries(stats.fallRounds).reduce((total, [roundNumber, count]) => total + (Number(roundNumber) <= 3 ? count : 0), 0) / games,
      3,
    ),
    diagnostics: buildDiagnostics(stats, games, resolutions, orders),
    samples: stats.samples,
  };
}

function buildDiagnostics(stats, games, resolutions, orders) {
  const diagnostics = [];
  const fallRate = stats.falls / games;
  const defeatRate = stats.wars.defeat / Math.max(1, resolutions);
  const idlePerOrder = stats.deployment.idleTroops / Math.max(1, orders);
  const capitalPerOrder = stats.deployment.capitalTroops / Math.max(1, orders);
  const fundedPerOrder = stats.deployment.fundedTroops / Math.max(1, orders);
  const frontierPerOrder = stats.deployment.frontierTroops / Math.max(1, orders);
  const averageMargin = stats.wars.marginTotal / Math.max(1, resolutions);
  const fallPressure = describeFallPressure(fallRate);
  const fallPct = Math.round(fallRate * 100);

  if (stats.stuck > 0) diagnostics.push('Some simulated games became stuck; inspect sample seeds before trusting aggregate behavior.');
  if (fallPressure.band === 'ideal') diagnostics.push(`Empire-fall rate ${fallPct}% is in the ideal 40%-50% band.`);
  else if (fallPressure.band === 'low') diagnostics.push(`Empire-fall rate ${fallPct}% is below the acceptable 25%-75% band; check whether this scenario is unusually safe.`);
  else if (fallPressure.band === 'high') diagnostics.push(`Empire-fall rate ${fallPct}% is above the acceptable 25%-75% band; check whether this scenario is unusually punishing.`);
  else diagnostics.push(`Empire-fall rate ${fallPct}% is acceptable (${fallPressure.target}).`);
  if (fallRate < FALL_RATE_ACCEPTABLE_MIN && averageMargin > 9) diagnostics.push('War margins are very safe in this simulation sample; compare against replayed games before changing AI behavior.');
  if (fallRate > FALL_RATE_ACCEPTABLE_MAX && defeatRate > 0.6) diagnostics.push('Invasion defeats are frequent in this high-fall sample; inspect the invasion mix and seeds.');
  if (fundedPerOrder > frontierPerOrder + capitalPerOrder - 0.5 && idlePerOrder < 0.4 && averageMargin > 10) diagnostics.push('Most available troops are funded while war margins are large; this is a simulation review note, not an AI defect by itself.');
  if (idlePerOrder > capitalPerOrder + 2 && fallRate > FALL_RATE_ACCEPTABLE_MAX) diagnostics.push('Idle troop conversion is high in a high-fall sample; inspect replay seeds before tuning.');
  return diagnostics;
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
    if (key === 'allow-untuned-policies') {
      options.allowUntunedPolicies = true;
      continue;
    }
    if (key === 'no-history') {
      options.historyEnabled = false;
      continue;
    }
    const value = argv[index + 1];
    index += 1;
    if (key === 'games') options.games = toInt(value, DEFAULT_OPTIONS.games);
    else if (key === 'players') options.playerCount = toInt(value, DEFAULT_OPTIONS.playerCount);
    else if (key === 'deck') options.deckSize = toInt(value, DEFAULT_OPTIONS.deckSize);
    else if (key === 'seed') options.seed = toInt(value, DEFAULT_OPTIONS.seed);
    else if (key === 'samples') options.samples = toInt(value, DEFAULT_OPTIONS.samples);
    else if (key === 'max-steps') options.maxSteps = toInt(value, DEFAULT_OPTIONS.maxSteps);
    else if (key === 'policies') options.policies = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (key === 'workers') options.workers = toInt(value, defaultSimulationWorkers());
  }
  return options;
}

function formatReport(result) {
  const lines = [
    `AI simulation: ${result.games} games, ${result.options.playerCount} players, ${result.options.deckSize} turns, seed ${result.options.seed}`,
    result.options.policies ? null : 'Opponents: saved tuned AI roster',
    `Completion: ${result.completed}/${result.games} complete, stuck ${result.stuck}, fall rate ${Math.round(result.fallRate * 100)}% (${result.fallPressure.band}), avg rounds ${result.averageRounds}`,
    `War: victory ${Math.round(result.wars.victoryRate * 100)}%, stalemate ${Math.round(result.wars.stalemateRate * 100)}%, defeat ${Math.round(result.wars.defeatRate * 100)}%, avg margin ${result.wars.averageMargin}`,
    `Coup: throne changes ${Math.round(result.coups.throneChangeRate * 100)}%, self top-preference ${Math.round(result.coups.selfPreferenceRate * 100)}%, incumbent backing ${Math.round(result.coups.incumbentBackRate * 100)}%`,
    `Deployment/order: frontier ${result.deployment.frontierTroopsPerOrder}, capital ${result.deployment.capitalTroopsPerOrder}, idle ${result.deployment.idleTroopsPerOrder}, mercs ${result.deployment.mercenariesPerOrder}`,
    `Estates/game: bid submissions ${result.estates.bidsPerGame}, winning purchases ${result.estates.purchasesPerGame}, submitted bid total ${result.estates.bidGoldPerGame}, winning spend ${result.estates.goldSpentPerGame}`,
    `Scoring: winner ${result.scoring.winnerScore}, average ${result.scoring.averageScore}, gap ${result.scoring.pointGap}`,
    `Seat win rates: ${Object.entries(result.seatWinRates).map(([seat, rate]) => `seat ${Number(seat) + 1} ${Math.round(rate * 100)}%`).join(', ')}`,
    `Falls by invader: ${Object.entries(result.fallInvasionRates).map(([invasionId, rate]) => `${invasionId} ${Math.round(rate * 100)}%`).join(', ') || 'none'}`,
    `Falls by round: ${Object.entries(result.fallRoundRates).map(([roundNumber, rate]) => `r${roundNumber} ${Math.round(rate * 100)}%`).join(', ') || 'none'} (by round 3: ${Math.round(result.earlyFallRate * 100)}%)`,
    'Diagnostics:',
    ...result.diagnostics.map((entry) => `- ${entry}`),
  ].filter(Boolean);
  if (result.options.policies) {
    const policies = Array.isArray(result.options.policies) ? result.options.policies.join(', ') : result.options.policies;
    lines.splice(1, 0, `Policies: ${policies}`);
  }
  if (result.samples.length) {
    lines.push('Samples:');
    for (const sample of result.samples) {
      const winnerText = sample.winnerIds.length ? sample.winnerIds.join(',') : 'none';
      lines.push(`- seed ${sample.seed}, rounds ${sample.rounds}, phase ${sample.phase}, top ${sample.topScore}, winners ${winnerText}, ${sample.reason}${sample.fall ? ', fall' : ''}`);
    }
  }
  return lines.join('\n');
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!isMainThread && workerData?.kind === 'simulate-games') {
  try {
    const games = [];
    for (let gameIndex = workerData.start; gameIndex < workerData.end; gameIndex += 1) {
      games.push(simulateGame(workerData.options, gameIndex));
    }
    parentPort.postMessage({ ok: true, games });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.message || String(error) });
  }
} else if (isCli) {
  const options = parseArgs(process.argv.slice(2));
  const result = await simulateGamesParallel(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result));
}
