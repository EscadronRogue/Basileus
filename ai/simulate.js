import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setDealParticipantIds } from '../engine/deals.js';
import { createGameState } from '../engine/state.js';
import { handleContinueAfterResolution, runAiRuntime, startInteractiveRuntime } from '../engine/runtime.js';
import { getMercenaryHireCost } from '../engine/rules.js';
import { buildFinalScores } from '../engine/scoring.js';
import { getDeploymentArmyTroopEntry, getPlayerDeploymentArmyKeys } from '../engine/deployment.js';
import { getPreferredCoupCandidate, normalizeCoupRanking } from '../engine/coup.js';
import { createAIMeta } from './brain.js';

const DEFAULT_OPTIONS = {
  games: 100,
  playerCount: 5,
  deckSize: 9,
  seed: 1,
  maxSteps: 500,
  samples: 5,
  historyEnabled: true,
  policies: null,
};

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

  return {
    playerId,
    candidate: Number.isInteger(Number(orders.candidate))
      ? Number(orders.candidate)
      : getPreferredCoupCandidate(state, playerId, {
        ...orders,
        ranking: normalizeCoupRanking(state, playerId, orders.ranking, orders.candidate),
      }),
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

function collectHistory(stats, state) {
  for (const event of state.history || []) {
    if (event.type === 'appoint_strategos') stats.court.appointStrategos += 1;
    else if (event.type === 'appoint_bishop') stats.court.appointBishop += 1;
    else if (event.type === 'revoke_minor_title') stats.court.revokeMinor += 1;
    else if (event.type === 'revoke_theme') stats.court.revokeTheme += 1;
    else if (event.type === 'land_bid') {
      stats.estates.bids += 1;
      stats.estates.goldSpent += Number(event.details?.bid) || 0;
    } else if (event.type === 'buy_theme') {
      stats.estates.bought += 1;
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

function resolveSeatPolicy(options, seatId) {
  const policies = options.policies;
  if (!policies) return 'strategic';
  if (Array.isArray(policies)) return policies[seatId % policies.length] || 'strategic';
  return policies;
}

function createAllAiGame(options, seed) {
  const state = createGameState({
    playerCount: options.playerCount,
    deckSize: options.deckSize,
    seed,
    historyEnabled: options.historyEnabled !== false,
  });
  setDealParticipantIds(state, state.players.map((player) => player.id));
  const aiPlayers = Object.fromEntries(
    state.players.map((player) => [player.id, { policy: resolveSeatPolicy(options, player.id) }]),
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

  collectHistory(localStats, state);
  collectScoring(localStats, state);
  const appointmentStatsByPlayer = collectAppointmentStatsByPlayer(state);

  const final = buildFinalScores(state);
  return {
    seed,
    reason,
    phase: state.phase,
    rounds: state.round,
    fall: state.gameOver?.type === 'fall',
    policyIds: Object.fromEntries(Object.entries(meta.players || {}).map(([playerId, entry]) => [playerId, entry.policyId || 'strategic'])),
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
  rememberSample(target, source);
}

export function simulateGames(rawOptions = {}) {
  const options = {
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
  };
  const stats = emptyStats(options);
  for (let gameIndex = 0; gameIndex < options.games; gameIndex += 1) {
    const game = simulateGame(options, gameIndex);
    stats.games += 1;
    mergeStats(stats, game);
  }
  return normalizeStats(stats);
}

function normalizeStats(stats) {
  const games = Math.max(1, stats.games);
  const resolutions = Math.max(1, stats.resolutions);
  const orders = Math.max(1, stats.deployment.orders);
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
    fallRate: round(stats.falls / games, 3),
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
    diagnostics: buildDiagnostics(stats, games, resolutions, orders),
    samples: stats.samples,
  };
}

function buildDiagnostics(stats, games, resolutions, orders) {
  const diagnostics = [];
  const fallRate = stats.falls / games;
  const defeatRate = stats.wars.defeat / Math.max(1, resolutions);
  const selfClaimRate = stats.coups.selfClaims / Math.max(1, orders);
  const estateBidsPerGame = stats.estates.bids / games;
  const idlePerOrder = stats.deployment.idleTroops / Math.max(1, orders);
  const capitalPerOrder = stats.deployment.capitalTroops / Math.max(1, orders);
  const fundedPerOrder = stats.deployment.fundedTroops / Math.max(1, orders);
  const frontierPerOrder = stats.deployment.frontierTroops / Math.max(1, orders);
  const averageMargin = stats.wars.marginTotal / Math.max(1, resolutions);

  if (fallRate > 0.75) diagnostics.push('Excessive empire-fall rate: AI is letting Constantinople collapse too often.');
  else if (fallRate < 0.25 && averageMargin > 5) diagnostics.push('Low empire-fall pressure with safe war margins: AI may be too prudent.');
  if (defeatRate > 0.45) diagnostics.push('Frequent invasion defeats: frontier valuation is probably too low.');
  if (averageMargin > 9) diagnostics.push('High surplus war margins: AI is probably over-defending instead of converting troops into coups or gold.');
  if (selfClaimRate < 0.08) diagnostics.push('Low self-claim rate: AI may be too loyal to incumbents and missing coup windows.');
  if (estateBidsPerGame < stats.options.playerCount) diagnostics.push('Low estate bidding: AI is leaving cheap profit-share tools untouched.');
  if (fundedPerOrder > frontierPerOrder + capitalPerOrder - 0.5 && idlePerOrder < 0.4 && averageMargin > 8) diagnostics.push('Low idle conversion with safe frontiers: AI may be over-funding troops.');
  if (idlePerOrder > capitalPerOrder + 2) diagnostics.push('High idle troop conversion: AI may be overvaluing gold reserves over power projection.');
  if (!diagnostics.length) diagnostics.push('No obvious aggregate pathology detected; inspect sample games or compare against tuned variants.');
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
  }
  return options;
}

function formatReport(result) {
  const lines = [
    `AI simulation: ${result.games} games, ${result.options.playerCount} players, deck ${result.options.deckSize}, seed ${result.options.seed}`,
    `Completion: ${result.completed}/${result.games} complete, stuck ${result.stuck}, fall rate ${Math.round(result.fallRate * 100)}%, avg rounds ${result.averageRounds}`,
    `War: victory ${Math.round(result.wars.victoryRate * 100)}%, stalemate ${Math.round(result.wars.stalemateRate * 100)}%, defeat ${Math.round(result.wars.defeatRate * 100)}%, avg margin ${result.wars.averageMargin}`,
    `Coup: throne changes ${Math.round(result.coups.throneChangeRate * 100)}%, self-claims ${Math.round(result.coups.selfClaimRate * 100)}%, incumbent backing ${Math.round(result.coups.incumbentBackRate * 100)}%`,
    `Deployment/order: frontier ${result.deployment.frontierTroopsPerOrder}, capital ${result.deployment.capitalTroopsPerOrder}, idle ${result.deployment.idleTroopsPerOrder}, mercs ${result.deployment.mercenariesPerOrder}`,
    `Estates/game: bids ${result.estates.bidsPerGame}, purchases ${result.estates.purchasesPerGame}, gold spent ${result.estates.goldSpentPerGame}`,
    `Scoring: winner ${result.scoring.winnerScore}, average ${result.scoring.averageScore}, gap ${result.scoring.pointGap}`,
    'Diagnostics:',
    ...result.diagnostics.map((entry) => `- ${entry}`),
  ];
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

if (isCli) {
  const options = parseArgs(process.argv.slice(2));
  const result = simulateGames(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result));
}
