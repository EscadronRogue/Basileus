import { createGameState, makeRng } from '../engine/state.js';
import { setDealParticipantIds } from '../engine/deals.js';
import { buildFinalScores } from '../engine/scoring.js';
import {
  advanceToNextInteractivePhase,
  allOrdersSubmitted,
  hasPendingDefenderRewards,
  isCourtComplete,
  phaseCleanup,
  phaseOrders,
  phaseResolution,
} from '../engine/turnflow.js';
import {
  applyLegalAction,
  listLegalCourtActions,
  listLegalOrderActions,
  listLegalRewardActions,
  listLegalTitleAssignments,
} from './legalActions.js';
import {
  DEFAULT_HEURISTIC_ID,
  RANDOM_OPPONENT_ID,
  getHeuristicPersonality,
  personalityForSeat,
  selectHeuristicAction,
  selectRandomActionIndex,
} from './heuristics.js';

const DEFAULT_PLAYER_MIN = 3;
const DEFAULT_PLAYER_MAX = 5;
const DEFAULT_ROUND_MIN = 6;
const DEFAULT_ROUND_MAX = 12;
const MAX_OFFICIAL_SCORE = 12;

export function createEntropySeed() {
  return ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0) || 1;
}

export function deriveEpisodeSeed(baseSeed, episodeIndex = 0) {
  let value = ((Number(baseSeed) || 1) >>> 0) + Math.imul((Number(episodeIndex) || 0) + 1, 0x9e3779b9);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) || 1;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeRange(options, fixedKeys, minKey, maxKey, defaults, bounds) {
  for (const key of fixedKeys) {
    const fixed = clampInteger(options[key], bounds.min, bounds.max);
    if (fixed != null) return { fixed, min: fixed, max: fixed };
  }
  let min = clampInteger(options[minKey], bounds.min, bounds.max) ?? defaults.min;
  let max = clampInteger(options[maxKey], bounds.min, bounds.max) ?? defaults.max;
  if (min > max) [min, max] = [max, min];
  return { fixed: null, min, max };
}

function randomIntInclusive(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export function resolveEpisodeSeed(options = {}, episodeIndex = 0) {
  const explicitEpisodeSeed = finiteNumber(options.episodeSeed, null);
  if (explicitEpisodeSeed != null) return explicitEpisodeSeed;
  const baseSeed = finiteNumber(options.seed, null);
  return baseSeed == null ? createEntropySeed() : deriveEpisodeSeed(baseSeed, episodeIndex);
}

export function resolveEpisodeSettings(options = {}, episodeIndex = 0) {
  const seed = resolveEpisodeSeed(options, episodeIndex);
  const configRng = makeRng(deriveEpisodeSeed(seed, 17));
  const playerRange = normalizeRange(
    options,
    ['playerCount'],
    'playerMin',
    'playerMax',
    { min: DEFAULT_PLAYER_MIN, max: DEFAULT_PLAYER_MAX },
    { min: DEFAULT_PLAYER_MIN, max: DEFAULT_PLAYER_MAX },
  );
  const roundRange = normalizeRange(
    options,
    ['deckSize', 'rounds'],
    'roundMin',
    'roundMax',
    { min: DEFAULT_ROUND_MIN, max: DEFAULT_ROUND_MAX },
    { min: 1, max: 99 },
  );
  return {
    seed,
    playerCount: playerRange.fixed ?? randomIntInclusive(configRng, playerRange.min, playerRange.max),
    deckSize: roundRange.fixed ?? randomIntInclusive(configRng, roundRange.min, roundRange.max),
    playerRange,
    roundRange,
  };
}

function defaultMaxCourtActionsPerPlayer(state) {
  const themeCount = Object.keys(state?.themes || {}).length;
  const playerCount = Math.max(1, state?.players?.length || DEFAULT_PLAYER_MIN);
  return Math.max(playerCount, themeCount + playerCount);
}

function defaultMaxSteps(state) {
  const rounds = Math.max(1, Number(state?.maxRounds) || DEFAULT_ROUND_MAX);
  const players = Math.max(1, state?.players?.length || DEFAULT_PLAYER_MIN);
  return rounds * players * defaultMaxCourtActionsPerPlayer(state);
}

export function createRandomController() {
  return ({ actions, rng }) => selectRandomActionIndex(actions, rng);
}

function createHeuristicControllerForRoles(roleForPlayer, options = {}) {
  return ({ state, playerId, actions, rng }) => {
    const role = roleForPlayer(playerId, state);
    if (role === RANDOM_OPPONENT_ID) return selectRandomActionIndex(actions, rng);
    return selectHeuristicAction(role || DEFAULT_HEURISTIC_ID, state, playerId, actions, rng, {
      searchDepth: Math.max(1, Math.floor(Number(options.searchDepth) || 1)),
    });
  };
}

function createRoleMap(state, role) {
  return Object.fromEntries((state.players || []).map((player) => [player.id, role]));
}

function defaultRoleForPlayer(playerId) {
  return personalityForSeat(playerId);
}

function createEpisodeController(options, state) {
  if (typeof options.controller === 'function') {
    const roleByPlayer = Object.fromEntries((state.players || []).map((player) => [
      player.id,
      typeof options.controllerRoleForPlayer === 'function'
        ? options.controllerRoleForPlayer(player.id, state)
        : (options.controllerRoles?.[player.id] || options.controllerRoles?.[String(player.id)] || options.controllerRole || 'custom'),
    ]));
    return {
      controller: ({ state: currentState, playerId, actions, rng }) => {
        const decision = options.controller({ state: currentState, playerId, actions, rng });
        if (decision && typeof decision === 'object') return decision;
        return Number.isInteger(decision) && decision >= 0 && decision < actions.length
          ? decision
          : selectRandomActionIndex(actions, rng);
      },
      roleByPlayer,
    };
  }

  const strategies = options.strategies || null;
  const strategyId = options.strategyId || options.aiOpponentId || null;
  const roleByPlayer = Object.fromEntries((state.players || []).map((player) => [
    player.id,
    strategies?.[player.id] || strategies?.[String(player.id)] || strategyId || defaultRoleForPlayer(player.id),
  ]));
  return {
    controller: createHeuristicControllerForRoles(
      (playerId) => roleByPlayer[playerId] || RANDOM_OPPONENT_ID,
      options,
    ),
    roleByPlayer,
  };
}

function chooseDecision(controller, context) {
  if (!context.actions.length) return null;
  const decision = controller(context);
  if (decision && typeof decision === 'object') {
    const index = Number.isInteger(decision.index) ? decision.index : context.actions.indexOf(decision.action);
    return {
      ...decision,
      index: index >= 0 ? index : 0,
      action: decision.action || context.actions[index] || context.actions[0],
    };
  }
  const index = Number.isInteger(decision) ? decision : 0;
  return {
    index,
    action: context.actions[index] || context.actions[0],
    score: null,
  };
}

function chooseAction(controller, context) {
  return chooseDecision(controller, context)?.action || null;
}

export function createActionStats() {
  return {
    total: 0,
    byKind: {},
    byPhase: {},
    courtActions: {},
    rewardChoices: {},
    confirmations: 0,
    titleAssignments: 0,
  };
}

function increment(map, key, amount = 1) {
  const normalized = String(key || 'unknown');
  map[normalized] = (map[normalized] || 0) + amount;
}

function recordAction(stats, action) {
  if (!stats || !action) return;
  stats.total += 1;
  increment(stats.byKind, action.kind);
  increment(stats.byPhase, action.phase || action.kind);
  if (action.kind === 'court') increment(stats.courtActions, action.payload?.action);
  if (action.kind === 'court-confirm') stats.confirmations += 1;
  if (action.kind === 'reward') increment(stats.rewardChoices, action.choice);
  if (action.kind === 'title-assignment') stats.titleAssignments += 1;
}

function confirmAction(actions) {
  return actions.find((action) => action.kind === 'court-confirm') || actions[actions.length - 1] || null;
}

function simulationCourtStopScoreFloor(step, state) {
  if (step <= 0) return -Infinity;
  const [low, high] = state?.currentInvasion?.strength || [0, 0];
  const invasionNeed = ((Number(low) || 0) + (Number(high) || 0)) / 2;
  const dangerBias = invasionNeed >= 22 ? -1.25 : invasionNeed >= 16 ? -0.5 : 0;
  return 3.25 + step * 0.85 + dangerBias;
}

function shouldConfirmSimulationCourt(decision, step, state) {
  if (!decision?.action || !Number.isFinite(Number(decision.score))) return false;
  if (decision.action.kind === 'court-confirm') return true;
  if (step >= 7 && decision.score < 12) return true;
  return decision.score < simulationCourtStopScoreFloor(step, state);
}

function runCourtPhase(state, controller, rng, options) {
  let madeProgress = false;
  const maxActions = options.maxCourtActionsPerPlayer || defaultMaxCourtActionsPerPlayer(state);
  for (const player of state.players) {
    if (state.courtActions?.playerConfirmed?.has(player.id)) continue;
    for (let step = 0; step < maxActions; step += 1) {
      const actions = listLegalCourtActions(state, player.id, { includeDeals: false });
      if (!actions.length) break;
      const decision = chooseDecision(controller, { state, playerId: player.id, actions, rng });
      const action = step === maxActions - 1 || shouldConfirmSimulationCourt(decision, step, state)
        ? confirmAction(actions)
        : decision?.action;
      if (!action) break;
      const result = applyLegalAction(state, action);
      if (!result.ok) {
        const fallback = confirmAction(actions);
        if (!fallback || fallback.id === action.id) break;
        const fallbackResult = applyLegalAction(state, fallback);
        if (!fallbackResult.ok) break;
        recordAction(options.actionStats, fallback);
      } else {
        recordAction(options.actionStats, action);
      }
      madeProgress = true;
      if (state.courtActions?.playerConfirmed?.has(player.id)) break;
    }
  }
  if (isCourtComplete(state)) {
    phaseOrders(state);
    return true;
  }
  return madeProgress;
}

function runOrdersPhase(state, controller, rng, actionStats = null) {
  let madeProgress = false;
  const planningState = JSON.parse(JSON.stringify(state));
  planningState.rng = state.rng;
  if (state.courtActions) {
    planningState.courtActions = {
      ...planningState.courtActions,
      playerConfirmed: new Set([...(state.courtActions.playerConfirmed || new Set())]),
    };
  }
  planningState.allOrders = {};
  for (const player of state.players) {
    if (state.allOrders?.[player.id]) continue;
    const actions = listLegalOrderActions(planningState, player.id);
    const action = chooseAction(controller, { state: planningState, playerId: player.id, actions, rng });
    if (!action) continue;
    const result = applyLegalAction(state, action);
    if (!result.ok) continue;
    recordAction(actionStats, action);
    madeProgress = true;
  }
  if (allOrdersSubmitted(state)) {
    phaseResolution(state);
    return true;
  }
  return madeProgress;
}

function runResolutionPhase(state, controller, rng, actionStats = null) {
  let madeProgress = false;
  let safety = 0;
  while (hasPendingDefenderRewards(state) && safety < 30) {
    safety += 1;
    const reward = state.pendingDefenderRewards.find((entry) => !entry.resolved);
    if (!reward) break;
    const actions = listLegalRewardActions(state, reward.defenderId).filter((action) => action.rewardId === reward.id);
    const action = chooseAction(controller, { state, playerId: reward.defenderId, actions, rng });
    if (!action) break;
    const result = applyLegalAction(state, action);
    if (!result.ok) break;
    recordAction(actionStats, action);
    madeProgress = true;
  }

  if (state.nextBasileusId !== state.basileusId) {
    const actions = listLegalTitleAssignments(state, state.nextBasileusId);
    const action = chooseAction(controller, { state, playerId: state.nextBasileusId, actions, rng });
    if (action) {
      const result = applyLegalAction(state, action);
      if (result.ok) {
        recordAction(actionStats, action);
        madeProgress = true;
      }
    }
  }

  if (!hasPendingDefenderRewards(state)) {
    phaseCleanup(state);
    advanceToNextInteractivePhase(state);
    return true;
  }
  return madeProgress;
}

function runSimulationStep(state, controller, rng, options = {}) {
  if (state.phase === 'court') {
    return runCourtPhase(state, controller, rng, {
      maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer || defaultMaxCourtActionsPerPlayer(state),
      actionStats: options.actionStats || null,
    });
  }
  if (state.phase === 'orders') return runOrdersPhase(state, controller, rng, options.actionStats || null);
  if (state.phase === 'resolution') return runResolutionPhase(state, controller, rng, options.actionStats || null);
  advanceToNextInteractivePhase(state);
  return true;
}

export function computeTerminalRewards(state) {
  if (state.gameOver?.type === 'fall') {
    return Object.fromEntries((state.players || []).map((player) => [player.id, -1]));
  }
  const final = buildFinalScores(state);
  const winners = new Set(final.winners.map((entry) => entry.playerId));
  return Object.fromEntries(final.scores.map((score) => [
    score.playerId,
    (score.points / MAX_OFFICIAL_SCORE) + (winners.has(score.playerId) ? 1 : 0),
  ]));
}

function computePlayerOutcomes(state, roleByPlayer, terminalReason = null) {
  const fell = state.gameOver?.type === 'fall';
  let winners = new Set();
  let pointsByPlayer = {};
  if (!fell && state.phase === 'scoring') {
    const final = buildFinalScores(state);
    winners = new Set(final.winners.map((entry) => entry.playerId));
    pointsByPlayer = Object.fromEntries(final.scores.map((entry) => [entry.playerId, entry.points]));
  }
  return (state.players || []).map((player) => ({
    playerId: player.id,
    role: roleByPlayer[player.id] || roleByPlayer[String(player.id)] || 'unknown',
    won: winners.has(player.id),
    survived: !fell && state.phase === 'scoring',
    fell,
    truncated: terminalReason === 'stalled' || terminalReason === 'max-steps',
    points: pointsByPlayer[player.id] || 0,
  }));
}

function createStrategyMix(roleByPlayer = {}) {
  const mix = {};
  for (const role of Object.values(roleByPlayer)) {
    increment(mix, role);
  }
  return mix;
}

export function runSelfPlayEpisode(options = {}) {
  const settings = resolveEpisodeSettings(options, options.episodeIndex || 0);
  const seed = settings.seed;
  const rng = makeRng(seed);
  const state = createGameState({
    playerCount: settings.playerCount,
    deckSize: settings.deckSize,
    seed,
    historyEnabled: false,
  });
  setDealParticipantIds(state, state.players.map((player) => player.id));
  const actionStats = createActionStats();
  const { controller, roleByPlayer } = createEpisodeController(options, state);

  advanceToNextInteractivePhase(state);
  let steps = 0;
  let terminalReason = null;
  const maxSteps = options.maxSteps || defaultMaxSteps(state);
  while (!state.gameOver && state.phase !== 'scoring' && steps < maxSteps) {
    steps += 1;
    const progressed = runSimulationStep(state, controller, rng, {
      maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer || defaultMaxCourtActionsPerPlayer(state),
      actionStats,
    });
    if (!progressed) {
      terminalReason = 'stalled';
      break;
    }
  }

  if (!state.gameOver && state.phase !== 'scoring' && steps >= maxSteps) {
    state.gameOver = { type: 'fall', message: 'Simulation reached its safety step limit.' };
    terminalReason = 'max-steps';
  }

  if (!state.gameOver && state.phase !== 'scoring') {
    state.gameOver = { type: 'fall', message: 'Simulation stalled before reaching a terminal state.' };
    terminalReason ||= 'stalled';
  }

  const rewards = computeTerminalRewards(state);
  const playerOutcomes = computePlayerOutcomes(state, roleByPlayer, terminalReason);
  return {
    state,
    rewards,
    stats: {
      steps,
      fell: state.gameOver?.type === 'fall',
      survived: state.phase === 'scoring' && state.gameOver?.type !== 'fall',
      truncated: terminalReason === 'stalled' || terminalReason === 'max-steps',
      terminalReason: terminalReason || (state.phase === 'scoring' ? 'scoring' : state.gameOver?.type || 'unknown'),
      rounds: state.round,
      playerCount: settings.playerCount,
      deckSize: settings.deckSize,
      seed,
      actionStats,
      strategyMix: createStrategyMix(roleByPlayer),
      playerOutcomes,
    },
  };
}

export const runSimulationEpisode = runSelfPlayEpisode;

function addDistributionValue(stats, key, value) {
  if (!stats[key]) stats[key] = {};
  increment(stats[key], value);
}

function addRoleValue(map, role, amount) {
  const key = String(role || 'unknown');
  map[key] = (map[key] || 0) + amount;
}

function mergeActionStats(target, source = {}) {
  target.total += source.total || 0;
  for (const key of ['byKind', 'byPhase', 'courtActions', 'rewardChoices']) {
    for (const [entry, value] of Object.entries(source[key] || {})) increment(target[key], entry, value);
  }
  target.confirmations += source.confirmations || 0;
  target.titleAssignments += source.titleAssignments || 0;
}

export function evaluateStrategy(options = {}) {
  const episodes = Math.max(1, Math.floor(Number(options.episodes) || 10));
  const stats = {
    episodes,
    falls: 0,
    survivals: 0,
    truncated: 0,
    averageRounds: 0,
    playerCounts: {},
    roundLengths: {},
    rewardByPlayer: {},
    appearancesByPlayer: {},
    winsByPlayer: {},
    winRateByPlayer: {},
    averagePointsByPlayer: {},
    survivalRateByPlayer: {},
    rewardByRole: {},
    appearancesByRole: {},
    winsByRole: {},
    survivalsByRole: {},
    fallsByRole: {},
    truncatedByRole: {},
    winRateByRole: {},
    averagePointsByRole: {},
    survivalRateByRole: {},
    fallRateByRole: {},
    truncatedRateByRole: {},
    actionStats: createActionStats(),
    strategyMix: {},
  };

  for (let episode = 0; episode < episodes; episode += 1) {
    const episodeSeed = resolveEpisodeSeed(options, episode);
    const episodeSettings = resolveEpisodeSettings({ ...options, episodeSeed }, episode);
    const episodeOverrides = typeof options.episodeOptions === 'function'
      ? options.episodeOptions({ episode, seed: episodeSeed, settings: episodeSettings }) || {}
      : {};
    const result = runSelfPlayEpisode({
      ...options,
      episodeSeed,
      episodeIndex: episode,
      ...episodeOverrides,
    });
    stats.falls += result.stats.fell ? 1 : 0;
    stats.survivals += result.stats.survived ? 1 : 0;
    stats.truncated += result.stats.truncated ? 1 : 0;
    stats.averageRounds += result.stats.rounds;
    addDistributionValue(stats, 'playerCounts', result.stats.playerCount);
    addDistributionValue(stats, 'roundLengths', result.stats.deckSize);
    mergeActionStats(stats.actionStats, result.stats.actionStats);
    for (const [role, count] of Object.entries(result.stats.strategyMix || {})) increment(stats.strategyMix, role, count);

    for (const [playerId, reward] of Object.entries(result.rewards)) {
      stats.rewardByPlayer[playerId] = (stats.rewardByPlayer[playerId] || 0) + reward;
      stats.appearancesByPlayer[playerId] = (stats.appearancesByPlayer[playerId] || 0) + 1;
    }
    for (const outcome of result.stats.playerOutcomes || []) {
      const role = String(outcome.role || 'unknown');
      const playerKey = String(outcome.playerId);
      const reward = Number(result.rewards?.[playerKey] ?? result.rewards?.[outcome.playerId]) || 0;
      addRoleValue(stats.rewardByRole, role, reward);
      increment(stats.appearancesByRole, role);
      if (outcome.won) {
        increment(stats.winsByRole, role);
        increment(stats.winsByPlayer, playerKey);
      }
      if (outcome.survived) increment(stats.survivalsByRole, role);
      if (outcome.fell) increment(stats.fallsByRole, role);
      if (outcome.truncated) increment(stats.truncatedByRole, role);
      stats.averagePointsByPlayer[playerKey] = (stats.averagePointsByPlayer[playerKey] || 0) + (outcome.points || 0);
      addRoleValue(stats.averagePointsByRole, role, outcome.points || 0);
    }
  }

  stats.averageRounds /= episodes;
  for (const playerId of Object.keys(stats.appearancesByPlayer)) {
    const appearances = stats.appearancesByPlayer[playerId] || 1;
    stats.rewardByPlayer[playerId] = (stats.rewardByPlayer[playerId] || 0) / appearances;
    stats.averagePointsByPlayer[playerId] = (stats.averagePointsByPlayer[playerId] || 0) / appearances;
    stats.winRateByPlayer[playerId] = (stats.winsByPlayer[playerId] || 0) / appearances;
    stats.survivalRateByPlayer[playerId] = stats.survivals / episodes;
  }
  for (const role of Object.keys(stats.appearancesByRole)) {
    const appearances = stats.appearancesByRole[role] || 1;
    stats.rewardByRole[role] = (stats.rewardByRole[role] || 0) / appearances;
    stats.averagePointsByRole[role] = (stats.averagePointsByRole[role] || 0) / appearances;
    stats.winRateByRole[role] = (stats.winsByRole[role] || 0) / appearances;
    stats.survivalRateByRole[role] = (stats.survivalsByRole[role] || 0) / appearances;
    stats.fallRateByRole[role] = (stats.fallsByRole[role] || 0) / appearances;
    stats.truncatedRateByRole[role] = (stats.truncatedByRole[role] || 0) / appearances;
  }
  stats.fallRate = stats.falls / episodes;
  stats.survivalRate = stats.survivals / episodes;
  stats.truncatedRate = stats.truncated / episodes;
  return stats;
}

export function createStrategyMatchController(primaryId, opponentId = RANDOM_OPPONENT_ID, primaryPlayerId = 0, options = {}) {
  const primary = primaryId === RANDOM_OPPONENT_ID ? RANDOM_OPPONENT_ID : getHeuristicPersonality(primaryId).id;
  const opponent = opponentId === RANDOM_OPPONENT_ID ? RANDOM_OPPONENT_ID : getHeuristicPersonality(opponentId).id;
  const controller = ({ state, playerId, actions, rng }) => {
    const role = playerId === primaryPlayerId ? primary : opponent;
    if (role === RANDOM_OPPONENT_ID) return selectRandomActionIndex(actions, rng);
    return selectHeuristicAction(role, state, playerId, actions, rng, {
      searchDepth: Math.max(1, Math.floor(Number(options.searchDepth) || 1)),
    });
  };
  controller.roleForPlayer = (playerId) => (playerId === primaryPlayerId ? primary : opponent);
  return controller;
}

export function rotatingPrimaryPlayerId(settings = {}, episode = 0) {
  const playerCount = Math.max(1, Math.floor(Number(settings.playerCount) || 1));
  return Math.max(0, Math.floor(Number(episode) || 0) % playerCount);
}

export function createMatchEpisodeOptions(primaryId, opponentId = RANDOM_OPPONENT_ID, options = {}) {
  return ({ episode, settings }) => {
    const primaryPlayerId = rotatingPrimaryPlayerId(settings, episode);
    const controller = createStrategyMatchController(primaryId, opponentId, primaryPlayerId, options);
    return {
      controller,
      controllerRoleForPlayer: controller.roleForPlayer,
    };
  };
}

export function describeStrategy(id) {
  if (id === RANDOM_OPPONENT_ID) return { id, firstName: 'Random', label: 'Random Baseline' };
  const profile = getHeuristicPersonality(id);
  return { id: profile.id, firstName: profile.firstName, label: profile.label };
}

export function strategyIdsForEvaluation() {
  return [
    DEFAULT_HEURISTIC_ID,
    'irene',
    'zoe',
    'niketas',
    'basil',
  ];
}
