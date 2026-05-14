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
import { buildCandidateInputs } from './features.js';
import { selectActionWithNetwork, trainBatch } from './network.js';

const DEFAULT_MAX_STEPS = 2000;
const DEFAULT_MAX_COURT_ACTIONS_PER_PLAYER = 10;
const DEFAULT_PLAYER_MIN = 3;
const DEFAULT_PLAYER_MAX = 5;
const DEFAULT_ROUND_MIN = 6;
const DEFAULT_ROUND_MAX = 12;

export function createEntropySeed() {
  return ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0) || 1;
}

export function deriveEpisodeSeed(baseSeed, episodeIndex = 0) {
  let value = ((Number(baseSeed) || 1) >>> 0) + Math.imul((Number(episodeIndex) || 0) + 1, 0x9e3779b9);
  value >>>= 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) || 1;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value, min, max) {
  const number = finiteNumber(value);
  if (number == null) return null;
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

function addDistributionValue(stats, key, value) {
  if (!stats[key]) stats[key] = {};
  const normalized = String(value);
  stats[key][normalized] = (stats[key][normalized] || 0) + 1;
}

export function resolveEpisodeSeed(options = {}, episodeIndex = 0) {
  const explicitEpisodeSeed = finiteNumber(options.episodeSeed);
  if (explicitEpisodeSeed != null) return explicitEpisodeSeed;
  const baseSeed = finiteNumber(options.seed);
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

function chooseRandom(actions, rng) {
  return Math.floor(rng() * actions.length);
}

function increment(map, key, amount = 1) {
  const normalized = String(key ?? 'unknown');
  map[normalized] = (map[normalized] || 0) + amount;
}

function createActionStats() {
  return {
    total: 0,
    byKind: {},
    byPhase: {},
    courtActions: {},
    rewardChoices: {},
    orderDeployments: {
      frontier: 0,
      capital: 0,
    },
    titleAssignments: 0,
    confirmations: 0,
  };
}

export function mergeActionStats(target = createActionStats(), source = {}) {
  target.total += source.total || 0;
  for (const [key, value] of Object.entries(source.byKind || {})) increment(target.byKind, key, value);
  for (const [key, value] of Object.entries(source.byPhase || {})) increment(target.byPhase, key, value);
  for (const [key, value] of Object.entries(source.courtActions || {})) increment(target.courtActions, key, value);
  for (const [key, value] of Object.entries(source.rewardChoices || {})) increment(target.rewardChoices, key, value);
  for (const [key, value] of Object.entries(source.orderDeployments || {})) {
    target.orderDeployments[key] = (target.orderDeployments[key] || 0) + value;
  }
  target.titleAssignments += source.titleAssignments || 0;
  target.confirmations += source.confirmations || 0;
  return target;
}

function recordAction(stats, action) {
  if (!stats || !action) return;
  stats.total += 1;
  increment(stats.byKind, action.kind);
  increment(stats.byPhase, action.phase);
  if (action.kind === 'court') increment(stats.courtActions, action.payload?.action || 'court');
  if (action.kind === 'court-confirm') stats.confirmations += 1;
  if (action.kind === 'reward') increment(stats.rewardChoices, action.choice || 'unknown');
  if (action.kind === 'title-assignment') stats.titleAssignments += 1;
  if (action.kind === 'orders') {
    for (const destination of Object.values(action.orders?.deployments || {})) {
      if (destination === 'capital') stats.orderDeployments.capital += 1;
      else if (destination === 'frontier') stats.orderDeployments.frontier += 1;
    }
  }
}

function createPolicyMixStats() {
  return {
    learner: 0,
    random: 0,
    heuristic: 0,
    checkpoint: 0,
    custom: 0,
  };
}

export function mergePolicyMixStats(target = createPolicyMixStats(), source = {}) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + (value || 0);
  }
  return target;
}

function actionScore(action, state, playerId) {
  if (!action) return -Infinity;
  if (action.kind === 'court-confirm') return 0;
  if (action.kind === 'reward') return action.choice === 'empire' ? 6 : -1;
  if (action.kind === 'title-assignment') return 1;
  if (action.kind === 'orders') {
    const deployments = Object.values(action.orders?.deployments || {});
    const frontier = deployments.filter((destination) => destination === 'frontier').length;
    const capital = deployments.filter((destination) => destination === 'capital').length;
    const selfVote = action.orders?.candidate === playerId ? 0.25 : 0;
    return frontier * 2 + capital * 0.25 + selfVote;
  }
  if (action.kind !== 'court') return 0;

  const courtAction = action.payload?.action;
  const scores = {
    recruit: 5,
    'hire-mercenaries': 4,
    'basileus-appoint': 2,
    'appoint-strategos': 2,
    'appoint-bishop': 1.5,
    buy: 1.25,
    gift: 0.25,
    revoke: -0.25,
    dismiss: -2,
    'deal-send': -0.5,
    'deal-counter': -0.5,
    'deal-accept': 0,
    'deal-refuse': 0,
  };
  const affordability = Number(state?.players?.[playerId]?.gold) || 0;
  return (scores[courtAction] ?? 0) + Math.min(1, affordability / 30);
}

function chooseBestScored(actions, rng, scorer) {
  let bestScore = -Infinity;
  const best = [];
  for (let index = 0; index < actions.length; index += 1) {
    const score = scorer(actions[index]);
    if (score > bestScore) {
      bestScore = score;
      best.length = 0;
      best.push(index);
    } else if (score === bestScore) {
      best.push(index);
    }
  }
  return best.length ? best[Math.floor(rng() * best.length)] : chooseRandom(actions, rng);
}

export function createDefensivePolicy() {
  return ({ state, playerId, actions, rng }) => (
    chooseBestScored(actions, rng, (action) => actionScore(action, state, playerId))
  );
}

export function computeTerminalRewards(state) {
  if (state.gameOver?.type === 'fall') {
    return Object.fromEntries(state.players.map((player) => [player.id, -1]));
  }

  const final = buildFinalScores(state);
  const winners = new Set(final.winners.map((entry) => entry.playerId));
  const maxPoints = Math.max(1, final.topScore || 1);
  const scores = new Map(final.scores.map((entry, index) => [entry.playerId, { ...entry, rank: index + 1 }]));
  return Object.fromEntries(state.players.map((player) => {
    const score = scores.get(player.id);
    const share = (score?.points || 0) / maxPoints;
    const placement = 1 - ((score?.rank || state.players.length) - 1) / Math.max(1, state.players.length - 1);
    const value = winners.has(player.id)
      ? 1 + 0.1 * placement
      : -0.55 + 0.35 * share + 0.1 * placement;
    return [player.id, value];
  }));
}

export function createRandomPolicy() {
  return ({ actions, rng }) => chooseRandom(actions, rng);
}

export function createNetworkPolicy(network, options = {}) {
  const transitions = options.transitions || null;
  return ({ state, playerId, actions, rng }) => {
    const inputs = buildCandidateInputs(state, playerId, actions);
    const selection = selectActionWithNetwork(network, inputs, rng, {
      temperature: options.temperature ?? 1,
      greedy: options.greedy || false,
    });
    if (transitions) {
      transitions.push({
        playerId,
        inputs,
        chosenIndex: selection.index,
        return: 0,
      });
    }
    return selection.index;
  };
}

function roleFromRates(roleRng, options, opponentNetworks) {
  const randomRate = Math.max(0, Number(options.randomOpponentRate) || 0);
  const heuristicRate = Math.max(0, Number(options.heuristicOpponentRate) || 0);
  const checkpointRate = opponentNetworks.length
    ? Math.max(0, Number(options.checkpointOpponentRate) || 0)
    : 0;
  const roll = roleRng();
  if (roll < randomRate) return { kind: 'random' };
  if (roll < randomRate + heuristicRate) return { kind: 'heuristic' };
  if (roll < randomRate + heuristicRate + checkpointRate) {
    return {
      kind: 'checkpoint',
      network: opponentNetworks[Math.floor(roleRng() * opponentNetworks.length)],
    };
  }
  return { kind: 'learner' };
}

function createEpisodePolicy(options, state, transitions, seed) {
  if (options.policy) {
    return {
      policy: options.policy,
      policyMix: { ...createPolicyMixStats(), custom: state.players.length },
    };
  }

  if (!options.network) {
    return {
      policy: createRandomPolicy(),
      policyMix: { ...createPolicyMixStats(), random: state.players.length },
    };
  }

  if (!options.opponentMix) {
    return {
      policy: createNetworkPolicy(options.network, {
        transitions,
        temperature: options.temperature ?? 1,
        greedy: options.greedy || false,
      }),
      policyMix: { ...createPolicyMixStats(), learner: state.players.length },
    };
  }

  const opponentNetworks = (Array.isArray(options.opponentNetworks) ? options.opponentNetworks : [])
    .filter(Boolean);
  const roleRng = makeRng(deriveEpisodeSeed(seed, 29));
  const roles = new Map();
  const policyMix = createPolicyMixStats();
  for (const player of state.players) {
    const role = roleFromRates(roleRng, options, opponentNetworks);
    roles.set(player.id, role);
    policyMix[role.kind] = (policyMix[role.kind] || 0) + 1;
  }

  if (policyMix.learner <= 0) {
    const player = state.players[Math.floor(roleRng() * state.players.length)];
    const previous = roles.get(player.id);
    if (previous) policyMix[previous.kind] = Math.max(0, (policyMix[previous.kind] || 0) - 1);
    roles.set(player.id, { kind: 'learner' });
    policyMix.learner += 1;
  }

  const defensivePolicy = createDefensivePolicy();
  return {
    policy: ({ state: currentState, playerId, actions, rng }) => {
      const role = roles.get(playerId) || { kind: 'learner' };
      if (role.kind === 'random') return chooseRandom(actions, rng);
      if (role.kind === 'heuristic') return defensivePolicy({ state: currentState, playerId, actions, rng });
      if (role.kind === 'checkpoint' && role.network) {
        const inputs = buildCandidateInputs(currentState, playerId, actions);
        return selectActionWithNetwork(role.network, inputs, rng, {
          greedy: options.opponentGreedy ?? true,
          temperature: options.opponentTemperature ?? 0,
        }).index;
      }
      const inputs = buildCandidateInputs(currentState, playerId, actions);
      const selection = selectActionWithNetwork(options.network, inputs, rng, {
        temperature: options.temperature ?? 1,
        greedy: options.greedy || false,
      });
      transitions.push({
        playerId,
        inputs,
        chosenIndex: selection.index,
        return: 0,
      });
      return selection.index;
    },
    policyMix,
  };
}

function chooseAction(policy, context) {
  if (!context.actions.length) return null;
  const index = policy(context);
  const normalized = Number.isInteger(index) && index >= 0 && index < context.actions.length
    ? index
    : chooseRandom(context.actions, context.rng);
  return context.actions[normalized];
}

function forceCourtConfirmation(state, playerId) {
  return listLegalCourtActions(state, playerId, { includeDeals: false })
    .find((action) => action.kind === 'court-confirm') || null;
}

function runCourtPhase(state, policy, rng, options) {
  let madeProgress = false;
  for (const player of state.players) {
    let courtActions = 0;
    while (
      state.phase === 'court'
      && !state.courtActions?.playerConfirmed?.has(player.id)
      && courtActions < options.maxCourtActionsPerPlayer
    ) {
      const actions = courtActions >= options.maxCourtActionsPerPlayer - 1
        ? [forceCourtConfirmation(state, player.id)].filter(Boolean)
        : listLegalCourtActions(state, player.id, { includeDeals: options.includeDeals });
      const action = chooseAction(policy, { state, playerId: player.id, actions, rng });
      if (!action) break;
      const result = applyLegalAction(state, action);
      if (!result.ok) break;
      recordAction(options.actionStats, action);
      madeProgress = true;
      courtActions += 1;
      if (isCourtComplete(state)) {
        phaseOrders(state);
        return true;
      }
    }
  }
  if (state.phase === 'court' && isCourtComplete(state)) {
    phaseOrders(state);
    return true;
  }
  return madeProgress;
}

function runOrdersPhase(state, policy, rng, actionStats = null) {
  let madeProgress = false;
  for (const player of state.players) {
    if (state.allOrders?.[player.id]) continue;
    const actions = listLegalOrderActions(state, player.id);
    const action = chooseAction(policy, { state, playerId: player.id, actions, rng });
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

function runResolutionPhase(state, policy, rng, actionStats = null) {
  let madeProgress = false;
  if (state.nextBasileusId !== state.basileusId) {
    const actions = listLegalTitleAssignments(state, state.nextBasileusId);
    const action = chooseAction(policy, {
      state,
      playerId: state.nextBasileusId,
      actions,
      rng,
    });
    if (action) {
      const result = applyLegalAction(state, action);
      if (result.ok) {
        recordAction(actionStats, action);
        madeProgress = true;
      }
    }
  }

  let safety = 0;
  while (hasPendingDefenderRewards(state) && safety < 50) {
    safety += 1;
    const reward = state.pendingDefenderRewards.find((entry) => !entry.resolved);
    if (!reward) break;
    const actions = listLegalRewardActions(state, reward.defenderId);
    const action = chooseAction(policy, {
      state,
      playerId: reward.defenderId,
      actions,
      rng,
    });
    if (!action) break;
    const result = applyLegalAction(state, action);
    if (!result.ok) break;
    recordAction(actionStats, action);
    madeProgress = true;
  }

  if (!hasPendingDefenderRewards(state)) {
    phaseCleanup(state);
    advanceToNextInteractivePhase(state);
    return true;
  }
  return madeProgress;
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
  const transitions = [];
  const actionStats = createActionStats();
  const { policy, policyMix } = createEpisodePolicy(options, state, transitions, seed);

  advanceToNextInteractivePhase(state);
  let steps = 0;
  let terminalReason = null;
  while (!state.gameOver && state.phase !== 'scoring' && steps < (options.maxSteps || DEFAULT_MAX_STEPS)) {
    steps += 1;
    let progressed = false;
    if (state.phase === 'court') {
      progressed = runCourtPhase(state, policy, rng, {
        maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer || DEFAULT_MAX_COURT_ACTIONS_PER_PLAYER,
        includeDeals: options.includeDeals,
        actionStats,
      });
    } else if (state.phase === 'orders') {
      progressed = runOrdersPhase(state, policy, rng, actionStats);
    } else if (state.phase === 'resolution') {
      progressed = runResolutionPhase(state, policy, rng, actionStats);
    } else {
      advanceToNextInteractivePhase(state);
      progressed = true;
    }
    if (!progressed) {
      terminalReason = 'stalled';
      break;
    }
  }

  if (!state.gameOver && state.phase !== 'scoring' && steps >= (options.maxSteps || DEFAULT_MAX_STEPS)) {
    state.gameOver = { type: 'fall', message: 'Training episode reached its safety step limit.' };
    terminalReason = 'max-steps';
  }

  if (!state.gameOver && state.phase !== 'scoring') {
    state.gameOver = { type: 'fall', message: 'Training episode stalled before reaching a terminal state.' };
    terminalReason ||= 'stalled';
  }

  const rewards = computeTerminalRewards(state);
  for (const transition of transitions) {
    transition.return = rewards[transition.playerId] ?? -1;
  }

  return {
    state,
    transitions,
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
      policyMix,
    },
  };
}

function trainingEpochCount(options = {}) {
  return Math.max(1, Math.floor(Number(options.trainingEpochs) || 1));
}

export function trainTransitions(network, transitions, options = {}) {
  const epochs = trainingEpochCount(options);
  let loss = 0;
  let policyLoss = 0;
  let valueLoss = 0;
  let count = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const report = trainBatch(network, transitions, {
      learningRate: options.learningRate || 0.001,
      entropyBeta: options.entropyBeta ?? 0.01,
      temperature: options.temperature ?? 1,
    });
    loss += report.loss;
    policyLoss += report.policyLoss;
    valueLoss += report.valueLoss;
    count = Math.max(count, report.count || 0);
  }
  return {
    loss: loss / epochs,
    policyLoss: policyLoss / epochs,
    valueLoss: valueLoss / epochs,
    count,
    epochs,
  };
}

export function trainSelfPlay(network, options = {}) {
  const episodes = Math.max(1, Number(options.episodes) || 1);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const onCheckpoint = typeof options.onCheckpoint === 'function' ? options.onCheckpoint : null;
  const checkpointInterval = Math.max(0, Math.floor(Number(options.checkpointInterval) || 0));
  const stats = {
    episodes,
    falls: 0,
    survivals: 0,
    truncated: 0,
    transitions: 0,
    rounds: 0,
    playerCounts: {},
    roundLengths: {},
    actionStats: createActionStats(),
    policyMix: createPolicyMixStats(),
    loss: 0,
  };

  for (let episode = 0; episode < episodes; episode += 1) {
    const result = runSelfPlayEpisode({
      ...options,
      network,
      episodeSeed: resolveEpisodeSeed(options, episode),
      episodeIndex: episode,
    });
    const report = trainTransitions(network, result.transitions, options);
    stats.falls += result.stats.fell ? 1 : 0;
    stats.survivals += result.stats.survived ? 1 : 0;
    stats.truncated += result.stats.truncated ? 1 : 0;
    stats.transitions += result.transitions.length;
    stats.rounds += result.stats.rounds;
    addDistributionValue(stats, 'playerCounts', result.stats.playerCount);
    addDistributionValue(stats, 'roundLengths', result.stats.deckSize);
    mergeActionStats(stats.actionStats, result.stats.actionStats);
    mergePolicyMixStats(stats.policyMix, result.stats.policyMix);
    stats.loss += report.loss;
    const completed = episode + 1;
    if (onProgress) {
      onProgress({
        completed,
        batchSize: 1,
        episodes,
        stats: { ...stats, loss: stats.loss / completed },
        last: {
          fell: result.stats.fell,
          survived: result.stats.survived,
          truncated: result.stats.truncated,
          terminalReason: result.stats.terminalReason,
          rounds: result.stats.rounds,
          playerCount: result.stats.playerCount,
          deckSize: result.stats.deckSize,
          seed: result.stats.seed,
          transitions: result.transitions.length,
          loss: report.loss,
          trainingEpochs: report.epochs,
        },
      });
    }
    if (onCheckpoint && checkpointInterval > 0 && (completed % checkpointInterval === 0 || completed === episodes)) {
      onCheckpoint({
        completed,
        batchSize: 1,
        episodes,
        network,
        stats: { ...stats, loss: stats.loss / completed },
        last: {
          seed: result.stats.seed,
          loss: report.loss,
          transitions: result.transitions.length,
          trainingEpochs: report.epochs,
        },
      });
    }
  }

  stats.loss /= episodes;
  stats.averageRounds = stats.rounds / episodes;
  return stats;
}

export function evaluatePolicy(options = {}) {
  const episodes = Math.max(1, Number(options.episodes) || 10);
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
    topScoreRateByPlayer: {},
    actionStats: createActionStats(),
    policyMix: createPolicyMixStats(),
  };

  for (let episode = 0; episode < episodes; episode += 1) {
    const result = runSelfPlayEpisode({
      ...options,
      episodeSeed: resolveEpisodeSeed(options, episode),
      episodeIndex: episode,
      greedy: options.greedy ?? true,
    });
    stats.falls += result.stats.fell ? 1 : 0;
    stats.survivals += result.stats.survived ? 1 : 0;
    stats.truncated += result.stats.truncated ? 1 : 0;
    stats.averageRounds += result.stats.rounds;
    addDistributionValue(stats, 'playerCounts', result.stats.playerCount);
    addDistributionValue(stats, 'roundLengths', result.stats.deckSize);
    mergeActionStats(stats.actionStats, result.stats.actionStats);
    mergePolicyMixStats(stats.policyMix, result.stats.policyMix);
    for (const [playerId, reward] of Object.entries(result.rewards)) {
      stats.rewardByPlayer[playerId] = (stats.rewardByPlayer[playerId] || 0) + reward;
      stats.appearancesByPlayer[playerId] = (stats.appearancesByPlayer[playerId] || 0) + 1;
    }
    if (result.state.phase === 'scoring' && !result.state.gameOver) {
      const final = buildFinalScores(result.state);
      const winners = new Set(final.winners.map((entry) => String(entry.playerId)));
      for (const entry of final.scores) {
        const key = String(entry.playerId);
        stats.averagePointsByPlayer[key] = (stats.averagePointsByPlayer[key] || 0) + entry.points;
        if (winners.has(key)) stats.winsByPlayer[key] = (stats.winsByPlayer[key] || 0) + 1;
      }
    }
  }

  stats.averageRounds /= episodes;
  for (const playerId of Object.keys(stats.rewardByPlayer)) {
    const appearances = stats.appearancesByPlayer[playerId] || episodes;
    stats.rewardByPlayer[playerId] /= appearances;
    stats.averagePointsByPlayer[playerId] = (stats.averagePointsByPlayer[playerId] || 0) / appearances;
    stats.winRateByPlayer[playerId] = (stats.winsByPlayer[playerId] || 0) / appearances;
    stats.topScoreRateByPlayer[playerId] = stats.winRateByPlayer[playerId];
  }
  stats.fallRate = stats.falls / episodes;
  stats.survivalRate = stats.survivals / episodes;
  stats.truncatedRate = stats.truncated / episodes;
  return stats;
}
