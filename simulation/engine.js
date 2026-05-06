import { createGameState, getPlayerThemes } from '../engine/state.js';
import { runAdministration } from '../engine/cascade.js';
import { computeFullWealth } from '../engine/actions.js';
import {
  createAIMeta,
  SUPPORTED_PLAYER_COUNTS,
} from '../ai/brain.js';
import { handleContinueAfterResolution, runAiRuntime, startInteractiveRuntime } from '../engine/runtime.js';
import { normalizeAiProfile } from '../ai/profileStore.js';
import { DEFAULT_MIXED_DECK_SIZES } from './constants.js';

export const DEFAULT_BATCH_CONFIG = {
  mode: 'mixed',
  simulations: 1000,
  samplePercent: 1,
  seed: 20260429,
  allowedProfiles: [],
  mixed: {
    playerCounts: SUPPORTED_PLAYER_COUNTS,
    deckSizes: DEFAULT_MIXED_DECK_SIZES,
  },
  focused: {
    playerCount: 4,
    deckSize: 9,
  },
};

const DEFAULT_SIMULATION_GUARDS = {
  maxLoopIterations: 256,
  maxRounds: 40,
  strictTimeoutMs: 15000,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function roundTo(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function hashSeedString(value) {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeSeed(rawSeed) {
  if (rawSeed == null || rawSeed === '') return Date.now() >>> 0;
  const text = String(rawSeed).trim();
  if (!text) return Date.now() >>> 0;
  if (/^-?\d+$/.test(text)) return (Number(text) >>> 0);
  return hashSeedString(text);
}

function uniqueList(items) {
  return [...new Set(items)];
}

function sanitizeDeckSizes(rawDeckSizes) {
  const list = Array.isArray(rawDeckSizes) ? rawDeckSizes : [];
  const cleaned = uniqueList(list.map(value => clamp(toInt(value, 9), 1, 30))).sort((a, b) => a - b);
  return cleaned.length ? cleaned : DEFAULT_MIXED_DECK_SIZES.slice();
}

function sanitizePlayerCounts(rawPlayerCounts) {
  const list = Array.isArray(rawPlayerCounts) ? rawPlayerCounts : [];
  const cleaned = uniqueList(list.map(value => toInt(value, 4)).filter(value => SUPPORTED_PLAYER_COUNTS.includes(value))).sort((a, b) => a - b);
  return cleaned.length ? cleaned : SUPPORTED_PLAYER_COUNTS.slice();
}

function sanitizeProfilePool(rawProfiles) {
  const list = Array.isArray(rawProfiles) ? rawProfiles : [];
  const cleaned = [];
  const seenIds = new Set();
  for (const rawProfile of list) {
    const profile = normalizeAiProfile(rawProfile);
    if (!profile || seenIds.has(profile.id)) continue;
    seenIds.add(profile.id);
    cleaned.push(profile);
  }
  return cleaned;
}

export function normalizeBatchConfig(rawConfig = {}) {
  const mode = rawConfig.mode === 'focused' ? 'focused' : 'mixed';
  const simulations = clamp(toInt(rawConfig.simulations, DEFAULT_BATCH_CONFIG.simulations), 1, 20000);
  const samplePercent = clamp(toNumber(rawConfig.samplePercent, DEFAULT_BATCH_CONFIG.samplePercent), 0, 100);
  const seed = normalizeSeed(rawConfig.seed ?? DEFAULT_BATCH_CONFIG.seed);
  const allowedProfiles = sanitizeProfilePool(rawConfig.allowedProfiles);

  const mixed = {
    playerCounts: sanitizePlayerCounts(rawConfig.mixed?.playerCounts),
    deckSizes: sanitizeDeckSizes(rawConfig.mixed?.deckSizes),
  };

  const focused = {
    playerCount: sanitizePlayerCounts([rawConfig.focused?.playerCount])[0],
    deckSize: clamp(toInt(rawConfig.focused?.deckSize, DEFAULT_BATCH_CONFIG.focused.deckSize), 1, 30),
  };

  return {
    mode,
    simulations,
    samplePercent,
    seed,
    allowedProfiles,
    mixed,
    focused,
  };
}

function buildScenarioPlan(config) {
  if (config.mode === 'focused') {
    return [{
      key: `${config.focused.playerCount}p-${config.focused.deckSize}d-trained`,
      label: `${config.focused.playerCount} players / ${config.focused.deckSize} invasions / trained roster`,
      playerCount: config.focused.playerCount,
      deckSize: config.focused.deckSize,
    }];
  }

  const plan = [];
  for (const playerCount of config.mixed.playerCounts) {
    for (const deckSize of config.mixed.deckSizes) {
      plan.push({
        key: `${playerCount}p-${deckSize}d-trained`,
        label: `${playerCount} players / ${deckSize} invasions / trained roster`,
        playerCount,
        deckSize,
      });
    }
  }
  return plan;
}

function sampleSeatProfiles(rng, playerCount, allowedProfiles) {
  if (!allowedProfiles.length) {
    throw new Error('No trained AI profiles were supplied to the simulation engine.');
  }

  const seatProfiles = {};
  for (let playerId = 0; playerId < playerCount; playerId++) {
    seatProfiles[playerId] = allowedProfiles[Math.floor(rng() * allowedProfiles.length)];
  }
  return seatProfiles;
}

function buildSampleIndexSet(totalGames, samplePercent) {
  const rawCount = Math.round(totalGames * (samplePercent / 100));
  const sampleCount = samplePercent > 0 ? clamp(rawCount || 1, 1, totalGames) : 0;
  const sampleIndices = new Set();
  if (!sampleCount) return sampleIndices;

  const step = totalGames / sampleCount;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const absoluteIndex = Math.min(totalGames - 1, Math.floor((sampleIndex + 0.5) * step));
    sampleIndices.add(absoluteIndex);
  }
  return sampleIndices;
}

function getProfileById(meta, playerId) {
  return meta.players[playerId]?.profile || null;
}

function getMinorTitleCount(state, playerId) {
  let count = 0;
  if (state.empress === playerId) count++;
  if (state.chiefEunuchs === playerId) count++;
  for (const theme of Object.values(state.themes)) {
    if (theme.occupied) continue;
    if (theme.strategos === playerId) count++;
    if (theme.bishop === playerId) count++;
  }
  return count;
}

function getPlayerProfessionalCount(player) {
  return sum(Object.values(player.professionalArmies));
}

function buildStandingsSnapshot(state, meta) {
  return state.players
    .map(player => ({
      playerId: player.id,
      dynasty: player.dynasty,
      personalityId: meta.players[player.id].personalityId,
      gold: player.gold,
      themes: getPlayerThemes(state, player.id).length,
      majorTitles: player.majorTitles.slice(),
      minorTitles: getMinorTitleCount(state, player.id),
      professionalTroops: getPlayerProfessionalCount(player),
      basileus: state.basileusId === player.id,
    }))
    .sort((left, right) => right.gold - left.gold);
}

function recordRoundSnapshot(state, meta) {
  meta.roundSnapshots.push({
    round: state.round,
    invasion: state.currentInvasion?.name || null,
    basileusId: state.basileusId,
    occupiedThemes: Object.values(state.themes).filter(theme => theme.occupied && theme.id !== 'CPL').length,
    standings: buildStandingsSnapshot(state, meta),
  });
}

function logRoundStart(state, meta, loggedRounds) {
  if (state.phase !== 'court' || loggedRounds.has(state.round)) return;
  loggedRounds.add(state.round);
  meta.decisionLog.push(`Round ${state.round}: ${state.currentInvasion.name} enters with strength ${state.currentInvasion.strength[0]}-${state.currentInvasion.strength[1]}.`);
}

function recordResolvedRound(state, meta, recordedRounds) {
  if (state.phase !== 'resolution' || recordedRounds.has(state.round)) return;
  recordedRounds.add(state.round);
  recordRoundSnapshot(state, meta);
}

function buildFinalScores(state, meta) {
  const projectedAdministration = runAdministration(state);
  const scores = state.players.map(player => {
    const projectedIncome = projectedAdministration.income[player.id] || 0;
    return {
      playerId: player.id,
      dynasty: player.dynasty,
      personalityId: meta.players[player.id].personalityId,
      gold: player.gold,
      projectedIncome,
      wealth: computeFullWealth(state, player.id, projectedIncome),
      themes: getPlayerThemes(state, player.id).length,
      majorTitles: player.majorTitles.slice(),
      minorTitles: getMinorTitleCount(state, player.id),
      professionalTroops: getPlayerProfessionalCount(player),
      basileus: state.basileusId === player.id,
    };
  }).sort((left, right) => right.wealth - left.wealth);

  const topWealth = scores[0]?.wealth ?? 0;
  const winners = scores.filter(score => score.wealth === topWealth);
  return { scores, winners, topWealth };
}

function buildSampleGame(state, meta, scenario, seed, finalScores) {
  return {
    seed,
    scenario: {
      label: scenario.label,
      playerCount: scenario.playerCount,
      deckSize: scenario.deckSize,
    },
    empireFall: Boolean(state.gameOver?.type === 'fall'),
    guardTriggered: state.gameOver?.type === 'guard_abort',
    guardReason: state.gameOver?.reason || null,
    roundsPlayed: state.round,
    startingBasileusId: meta.startingBasileusId,
    finalBasileusId: state.basileusId,
    personalities: state.players.map(player => ({
      playerId: player.id,
      dynasty: player.dynasty,
      personalityId: meta.players[player.id].personalityId,
      personalityName: meta.players[player.id].profile?.name || getProfileById(meta, player.id)?.name || 'Unknown',
    })),
    finalScores: finalScores.scores,
    decisionLog: meta.decisionLog.lines.slice(),
    engineLog: state.log.slice(),
    roundSnapshots: meta.roundSnapshots.slice(),
  };
}

function runSingleGame(config, scenario, gameIndex, sampled) {
  const startedAt = Date.now();
  const seed = hashSeedString(`${config.seed}:${gameIndex}:${scenario.key}`);
  const state = createGameState({
    playerCount: scenario.playerCount,
    deckSize: scenario.deckSize,
    seed,
  });

  const seatProfiles = config.seatProfiles && Object.keys(config.seatProfiles).length
    ? { ...config.seatProfiles }
    : sampleSeatProfiles(state.rng, state.players.length, config.allowedProfiles || []);

  const meta = createAIMeta(state, {
    sampled,
    scenario,
    seatProfiles,
  });
  meta.startingBasileusId = state.basileusId;

  const guards = {
    maxLoopIterations: Math.max(8, toInt(config.maxLoopIterations, DEFAULT_SIMULATION_GUARDS.maxLoopIterations)),
    maxRounds: Math.max(scenario.deckSize + 2, toInt(config.maxRounds, Math.max(DEFAULT_SIMULATION_GUARDS.maxRounds, scenario.deckSize + 2))),
    strictTimeoutMs: Math.max(250, toInt(config.strictTimeoutMs, DEFAULT_SIMULATION_GUARDS.strictTimeoutMs)),
  };
  let loopIterations = 0;
  const runtimeContext = { pendingAiTitleAssignment: null };
  const loggedRounds = new Set();
  const recordedRounds = new Set();

  const abortForGuard = (reason) => {
    state.gameOver = {
      type: 'guard_abort',
      reason,
    };
    state.phase = 'scoring';
  };

  while (!state.gameOver && state.phase !== 'scoring') {
    loopIterations++;
    if (loopIterations > guards.maxLoopIterations) {
      abortForGuard('loop_limit');
      break;
    }
    if (state.round > guards.maxRounds) {
      abortForGuard('round_limit');
      break;
    }
    if ((Date.now() - startedAt) > guards.strictTimeoutMs) {
      abortForGuard('timeout');
      break;
    }

    if (state.phase === 'setup' || state.phase === 'cleanup' || state.phase === 'invasion' || state.phase === 'administration') {
      startInteractiveRuntime(state, meta, runtimeContext);
    }

    logRoundStart(state, meta, loggedRounds);

    if (state.phase === 'court' || state.phase === 'orders') {
      runAiRuntime(state, meta, runtimeContext, { courtMode: 'finish' });
    }

    if (state.phase === 'court') {
      abortForGuard('court_incomplete');
      break;
    }

    if (state.phase === 'resolution') {
      recordResolvedRound(state, meta, recordedRounds);
      handleContinueAfterResolution(state, meta, runtimeContext, { processAi: false });
    }
  }

  const finalScores = buildFinalScores(state, meta);
  const frontierTroops = sum(state.players.map(player => meta.players[player.id].stats.frontierTroops));
  const capitalTroops = sum(state.players.map(player => meta.players[player.id].stats.capitalTroops));
  const sampleGame = sampled ? buildSampleGame(state, meta, scenario, seed, finalScores) : null;

  return {
    index: gameIndex,
    seed,
    scenarioKey: scenario.key,
    scenarioLabel: scenario.label,
    playerCount: scenario.playerCount,
    deckSize: scenario.deckSize,
    empireFall: Boolean(state.gameOver?.type === 'fall'),
    guardTriggered: state.gameOver?.type === 'guard_abort',
    guardReason: state.gameOver?.reason || null,
    roundsPlayed: state.round,
    startingBasileusId: meta.startingBasileusId,
    winners: state.gameOver ? [] : finalScores.winners,
    scores: finalScores.scores,
    topWealth: finalScores.topWealth,
    frontierTroops,
    capitalTroops,
    totalLandBuys: meta.totals.landBuys,
    totalGifts: meta.totals.gifts,
    totalRecruits: meta.totals.recruits,
    totalRecruitOpportunities: meta.totals.recruitOpportunities,
    totalRevocations: meta.totals.revocations,
    totalMercSpend: meta.totals.mercSpend,
    throneChanges: meta.totals.throneChanges,
    occupiedThemesEnd: Object.values(state.themes).filter(theme => theme.occupied && theme.id !== 'CPL').length,
    playerMetrics: state.players.map(player => ({
      playerId: player.id,
      dynasty: player.dynasty,
      personalityId: meta.players[player.id].personalityId,
      profileName: meta.players[player.id].profile?.name || 'Unknown',
      profileTheory: meta.players[player.id].profile?.theory || 'Trained AI',
      frontierTroops: meta.players[player.id].stats.frontierTroops,
      capitalTroops: meta.players[player.id].stats.capitalTroops,
      mercSpend: meta.players[player.id].stats.mercSpend,
      mercsHired: meta.players[player.id].stats.mercsHired,
      landBuys: meta.players[player.id].stats.landBuys,
      themesGifted: meta.players[player.id].stats.themesGifted,
      recruits: meta.players[player.id].stats.recruits,
      recruitOpportunities: meta.players[player.id].stats.recruitOpportunities,
      coupVotes: meta.players[player.id].stats.coupVotes,
      revocations: meta.players[player.id].stats.revocations,
      throneCaptures: meta.players[player.id].stats.throneCaptures,
      supportIncumbentVotes: meta.players[player.id].stats.supportIncumbentVotes,
      supportSelfVotes: meta.players[player.id].stats.supportSelfVotes,
      finalWealth: finalScores.scores.find(score => score.playerId === player.id)?.wealth || 0,
      finalThemes: getPlayerThemes(state, player.id).length,
      finalTitles: player.majorTitles.length + getMinorTitleCount(state, player.id),
      finalGold: player.gold,
      isWinner: finalScores.winners.some(winner => winner.playerId === player.id) && !state.gameOver,
    })),
    wars: meta.wars,
    sampleGame,
  };
}

export function runSingleSimulationGame(options = {}) {
  const playerCount = sanitizePlayerCounts([options.playerCount])[0];
  const deckSize = clamp(toInt(options.deckSize, DEFAULT_BATCH_CONFIG.focused.deckSize), 1, 30);
  const allowedProfiles = sanitizeProfilePool(options.allowedProfiles);
  const seed = normalizeSeed(options.seed ?? Date.now());
  const scenario = {
    key: options.scenarioKey || `${playerCount}p-${deckSize}d-trained-custom`,
    label: options.scenarioLabel || `${playerCount} players / ${deckSize} invasions / trained roster`,
    playerCount,
    deckSize,
  };

  return runSingleGame({
    seed,
    allowedProfiles,
    seatProfiles: options.seatProfiles && typeof options.seatProfiles === 'object' ? { ...options.seatProfiles } : {},
    maxLoopIterations: options.maxLoopIterations,
    maxRounds: options.maxRounds,
    strictTimeoutMs: options.strictTimeoutMs,
  }, scenario, toInt(options.gameIndex, 0), Boolean(options.sampled));
}

function createBucket(key, label) {
  return {
    key,
    label,
    games: 0,
    empireFalls: 0,
    guardAborts: 0,
    roundsTotal: 0,
    winnerWealthTotal: 0,
    scoringGames: 0,
    ties: 0,
    throneChangesTotal: 0,
    mercSpendTotal: 0,
    frontierTroopsTotal: 0,
    capitalTroopsTotal: 0,
    landBuysTotal: 0,
    giftsTotal: 0,
    recruitsTotal: 0,
    recruitOpportunitiesTotal: 0,
    occupiedThemesTotal: 0,
  };
}

function applyGameToBucket(bucket, game) {
  bucket.games++;
  bucket.roundsTotal += game.roundsPlayed;
  bucket.empireFalls += game.empireFall ? 1 : 0;
  bucket.guardAborts += game.guardTriggered ? 1 : 0;
  bucket.throneChangesTotal += game.throneChanges;
  bucket.mercSpendTotal += game.totalMercSpend;
  bucket.frontierTroopsTotal += game.frontierTroops;
  bucket.capitalTroopsTotal += game.capitalTroops;
  bucket.landBuysTotal += game.totalLandBuys;
  bucket.giftsTotal += game.totalGifts;
  bucket.recruitsTotal += game.totalRecruits;
  bucket.recruitOpportunitiesTotal += game.totalRecruitOpportunities;
  bucket.occupiedThemesTotal += game.occupiedThemesEnd;
  if (!game.empireFall && !game.guardTriggered) {
    bucket.scoringGames++;
    bucket.winnerWealthTotal += game.topWealth;
    if (game.winners.length > 1) bucket.ties++;
  }
}

function finalizeBucket(bucket) {
  const totalTroops = bucket.frontierTroopsTotal + bucket.capitalTroopsTotal;
  return {
    key: bucket.key,
    label: bucket.label,
    games: bucket.games,
    empireFallRate: bucket.games ? bucket.empireFalls / bucket.games : 0,
    guardAbortRate: bucket.games ? bucket.guardAborts / bucket.games : 0,
    averageRounds: bucket.games ? bucket.roundsTotal / bucket.games : 0,
    averageWinnerWealth: bucket.scoringGames ? bucket.winnerWealthTotal / bucket.scoringGames : 0,
    tieRate: bucket.scoringGames ? bucket.ties / bucket.scoringGames : 0,
    averageThroneChanges: bucket.games ? bucket.throneChangesTotal / bucket.games : 0,
    averageMercSpend: bucket.games ? bucket.mercSpendTotal / bucket.games : 0,
    frontierShare: totalTroops ? bucket.frontierTroopsTotal / totalTroops : 0,
    averageLandBuys: bucket.games ? bucket.landBuysTotal / bucket.games : 0,
    averageGifts: bucket.games ? bucket.giftsTotal / bucket.games : 0,
    averageRecruits: bucket.games ? bucket.recruitsTotal / bucket.games : 0,
    recruitmentUtilization: bucket.recruitOpportunitiesTotal ? bucket.recruitsTotal / bucket.recruitOpportunitiesTotal : 0,
    averageOccupiedThemes: bucket.games ? bucket.occupiedThemesTotal / bucket.games : 0,
  };
}

function createPersonalityBucket(profileId, name, theory) {
  return {
    personalityId: profileId,
    name,
    theory,
    seats: 0,
    weightedWins: 0,
    wealthTotal: 0,
    frontierTroopsTotal: 0,
    capitalTroopsTotal: 0,
    mercSpendTotal: 0,
    landBuysTotal: 0,
    giftsTotal: 0,
    recruitsTotal: 0,
    recruitOpportunitiesTotal: 0,
    throneCapturesTotal: 0,
    titlesTotal: 0,
    themesTotal: 0,
    goldTotal: 0,
  };
}

function finalizePersonalityBucket(bucket) {
  const totalTroops = bucket.frontierTroopsTotal + bucket.capitalTroopsTotal;
  return {
    personalityId: bucket.personalityId,
    name: bucket.name,
    theory: bucket.theory,
    seats: bucket.seats,
    winShare: bucket.seats ? bucket.weightedWins / bucket.seats : 0,
    averageWealth: bucket.seats ? bucket.wealthTotal / bucket.seats : 0,
    frontierShare: totalTroops ? bucket.frontierTroopsTotal / totalTroops : 0,
    averageMercSpend: bucket.seats ? bucket.mercSpendTotal / bucket.seats : 0,
    averageLandBuys: bucket.seats ? bucket.landBuysTotal / bucket.seats : 0,
    averageGifts: bucket.seats ? bucket.giftsTotal / bucket.seats : 0,
    averageRecruits: bucket.seats ? bucket.recruitsTotal / bucket.seats : 0,
    recruitmentUtilization: bucket.recruitOpportunitiesTotal ? bucket.recruitsTotal / bucket.recruitOpportunitiesTotal : 0,
    averageThroneCaptures: bucket.seats ? bucket.throneCapturesTotal / bucket.seats : 0,
    averageTitles: bucket.seats ? bucket.titlesTotal / bucket.seats : 0,
    averageThemes: bucket.seats ? bucket.themesTotal / bucket.seats : 0,
    averageGold: bucket.seats ? bucket.goldTotal / bucket.seats : 0,
  };
}

function createInvasionBucket(id, name) {
  return {
    id,
    name,
    appearances: 0,
    victories: 0,
    defeats: 0,
    stalemates: 0,
    cplFalls: 0,
    themesLostTotal: 0,
    themesRecoveredTotal: 0,
  };
}

function finalizeInvasionBucket(bucket) {
  return {
    id: bucket.id,
    name: bucket.name,
    appearances: bucket.appearances,
    victoryRate: bucket.appearances ? bucket.victories / bucket.appearances : 0,
    defeatRate: bucket.appearances ? bucket.defeats / bucket.appearances : 0,
    stalemateRate: bucket.appearances ? bucket.stalemates / bucket.appearances : 0,
    cplFallRate: bucket.appearances ? bucket.cplFalls / bucket.appearances : 0,
    averageThemesLost: bucket.appearances ? bucket.themesLostTotal / bucket.appearances : 0,
    averageThemesRecovered: bucket.appearances ? bucket.themesRecoveredTotal / bucket.appearances : 0,
  };
}

function buildHighlights(report) {
  const highlights = [];
  const worstScenario = report.byScenario[0];
  const bestScenario = report.byScenario[report.byScenario.length - 1];
  const bestWinningProfile = report.byPersonality[0];
  const mostCooperativeProfile = report.byPersonality.slice().sort((left, right) => right.frontierShare - left.frontierShare)[0];
  const mostDangerousInvasion = report.invasions[0];
  const longestDeck = report.byDeckSize[report.byDeckSize.length - 1];
  const shortestDeck = report.byDeckSize[0];

  highlights.push(
    `Empire fall rate: ${roundTo(report.overview.empireFallRate * 100, 1)}% across ${report.overview.games} runs, with games lasting ${roundTo(report.overview.averageRounds, 2)} rounds on average.`
  );

  if (worstScenario) {
    highlights.push(
      `Least stable scenario: ${worstScenario.label} collapsed ${roundTo(worstScenario.empireFallRate * 100, 1)}% of the time.`
    );
  }

  if (bestScenario) {
    highlights.push(
      `Most resilient scenario: ${bestScenario.label} finished with only ${roundTo(bestScenario.empireFallRate * 100, 1)}% empire falls and an average winner wealth of ${roundTo(bestScenario.averageWinnerWealth, 1)}.`
    );
  }

  if (shortestDeck && longestDeck && shortestDeck.key !== longestDeck.key) {
    highlights.push(
      `Deck length effect: ${shortestDeck.label} fell ${roundTo(shortestDeck.empireFallRate * 100, 1)}% of the time versus ${roundTo(longestDeck.empireFallRate * 100, 1)}% for ${longestDeck.label}.`
    );
  }

  if (bestWinningProfile) {
    highlights.push(
      `Best conversion rate: ${bestWinningProfile.name} posted a ${roundTo(bestWinningProfile.winShare * 100, 1)}% seat win share.`
    );
  }

  if (mostCooperativeProfile) {
    highlights.push(
      `Most frontier-committed profile: ${mostCooperativeProfile.name} sent ${roundTo(mostCooperativeProfile.frontierShare * 100, 1)}% of its troops to the frontier.`
    );
  }

  if (mostDangerousInvasion) {
    highlights.push(
      `Most punishing invader: ${mostDangerousInvasion.name} triggered Constantinople falls in ${roundTo(mostDangerousInvasion.cplFallRate * 100, 1)}% of its appearances.`
    );
  }

  if (report.overview.recruitmentUtilization > 0.9) {
    highlights.push(
      `Recruitment pattern: AIs used ${roundTo(report.overview.recruitmentUtilization * 100, 1)}% of available professional recruitment slots, suggesting the current free-before-cleanup recruit rule is close to a dominant play.`
    );
  }

  return highlights;
}

function finalizeReport(config, startedAt, completedGames, buckets, personalityBuckets, invasionBuckets, sampledGames) {
  const overview = finalizeBucket(buckets.overview);
  const byScenario = Object.values(buckets.byScenario).map(finalizeBucket).sort((left, right) => right.empireFallRate - left.empireFallRate || right.games - left.games);
  const byPlayerCount = Object.values(buckets.byPlayerCount).map(finalizeBucket).sort((left, right) => left.key.localeCompare(right.key));
  const byDeckSize = Object.values(buckets.byDeckSize).map(finalizeBucket).sort((left, right) => Number(left.key) - Number(right.key));
  const byPersonality = Object.values(personalityBuckets).map(finalizePersonalityBucket).sort((left, right) => right.winShare - left.winShare || right.averageWealth - left.averageWealth);
  const invasions = Object.values(invasionBuckets).map(finalizeInvasionBucket).sort((left, right) => right.cplFallRate - left.cplFallRate || right.defeatRate - left.defeatRate);

  const report = {
    generatedAt: new Date().toISOString(),
    config,
    runtimeMs: Date.now() - startedAt,
    overview: {
      ...overview,
      games: completedGames,
      empireFallRate: overview.empireFallRate,
      averageRounds: overview.averageRounds,
      recruitmentUtilization: overview.recruitmentUtilization,
    },
    byScenario,
    byPlayerCount,
    byDeckSize,
    byPersonality,
    invasions,
    sampledGames,
  };

  report.highlights = buildHighlights(report);
  return report;
}

export async function runSimulationBatch(rawConfig = {}, onProgress = null) {
  const startedAt = Date.now();
  const config = normalizeBatchConfig(rawConfig);
  const scenarioPlan = buildScenarioPlan(config);
  const sampleIndices = buildSampleIndexSet(config.simulations, config.samplePercent);

  const buckets = {
    overview: createBucket('overview', 'Overview'),
    byScenario: {},
    byPlayerCount: {},
    byDeckSize: {},
  };

  const personalityBuckets = {};
  const invasionBuckets = {};
  const sampledGames = [];
  if (!config.allowedProfiles.length) {
    throw new Error('No trained AI profiles were selected for this simulation batch.');
  }

  for (let gameIndex = 0; gameIndex < config.simulations; gameIndex++) {
    const scenario = scenarioPlan[gameIndex % scenarioPlan.length];
    const sampled = sampleIndices.has(gameIndex);
    const game = runSingleGame(config, scenario, gameIndex, sampled);

    applyGameToBucket(buckets.overview, game);

    if (!buckets.byScenario[game.scenarioKey]) {
      buckets.byScenario[game.scenarioKey] = createBucket(game.scenarioKey, game.scenarioLabel);
    }
    applyGameToBucket(buckets.byScenario[game.scenarioKey], game);

    const playerCountKey = `${game.playerCount}`;
    if (!buckets.byPlayerCount[playerCountKey]) {
      buckets.byPlayerCount[playerCountKey] = createBucket(playerCountKey, `${game.playerCount} players`);
    }
    applyGameToBucket(buckets.byPlayerCount[playerCountKey], game);

    const deckKey = `${game.deckSize}`;
    if (!buckets.byDeckSize[deckKey]) {
      buckets.byDeckSize[deckKey] = createBucket(deckKey, `${game.deckSize} invasions`);
    }
    applyGameToBucket(buckets.byDeckSize[deckKey], game);

    const winnerShare = game.empireFall || !game.winners.length ? 0 : (1 / game.winners.length);
    for (const playerMetric of game.playerMetrics) {
      if (!personalityBuckets[playerMetric.personalityId]) {
        personalityBuckets[playerMetric.personalityId] = createPersonalityBucket(
          playerMetric.personalityId,
          playerMetric.profileName || playerMetric.personalityId,
          playerMetric.profileTheory || 'Trained AI'
        );
      }
      const bucket = personalityBuckets[playerMetric.personalityId];
      bucket.seats++;
      bucket.weightedWins += playerMetric.isWinner ? winnerShare : 0;
      bucket.wealthTotal += playerMetric.finalWealth;
      bucket.frontierTroopsTotal += playerMetric.frontierTroops;
      bucket.capitalTroopsTotal += playerMetric.capitalTroops;
      bucket.mercSpendTotal += playerMetric.mercSpend;
      bucket.landBuysTotal += playerMetric.landBuys;
      bucket.giftsTotal += playerMetric.themesGifted;
      bucket.recruitsTotal += playerMetric.recruits;
      bucket.recruitOpportunitiesTotal += playerMetric.recruitOpportunities;
      bucket.throneCapturesTotal += playerMetric.throneCaptures;
      bucket.titlesTotal += playerMetric.finalTitles;
      bucket.themesTotal += playerMetric.finalThemes;
      bucket.goldTotal += playerMetric.finalGold;
    }

    for (const war of game.wars) {
      if (!invasionBuckets[war.id]) {
        invasionBuckets[war.id] = createInvasionBucket(war.id, war.name);
      }
      const bucket = invasionBuckets[war.id];
      bucket.appearances++;
      if (war.outcome === 'victory') bucket.victories++;
      if (war.outcome === 'defeat') bucket.defeats++;
      if (war.outcome === 'stalemate') bucket.stalemates++;
      if (war.reachedCPL) bucket.cplFalls++;
      bucket.themesLostTotal += war.themesLost;
      bucket.themesRecoveredTotal += war.themesRecovered;
    }

    if (game.sampleGame) sampledGames.push(game.sampleGame);

    if (onProgress && ((gameIndex + 1) % 10 === 0 || gameIndex + 1 === config.simulations)) {
      onProgress({
        completed: gameIndex + 1,
        total: config.simulations,
        scenarioLabel: scenario.label,
        elapsedMs: Date.now() - startedAt,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return finalizeReport(config, startedAt, config.simulations, buckets, personalityBuckets, invasionBuckets, sampledGames);
}
