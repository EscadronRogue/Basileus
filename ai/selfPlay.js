import { runAdministration } from '../engine/cascade.js';
import {
  createGameState,
  getOfficeHolder,
  getPlayer,
  getPlayerMercenaryTroops,
  makeRng,
  MERCENARY_COMPANY_KEY,
} from '../engine/state.js';
import { setDealParticipantIds } from '../engine/deals.js';
import { getPlayerOrderOfficeKeys, isCapitalLockedOfficeKey } from '../engine/orders.js';
import {
  buildFinalScores,
  SCORE_CATEGORIES,
  SCORE_SHARE_THRESHOLDS,
} from '../engine/scoring.js';
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
const SCORE_CATEGORY_KEYS = ['church', 'estate', 'tax', 'gold'];
const MAX_OFFICIAL_SCORE = SCORE_CATEGORIES.length * SCORE_SHARE_THRESHOLDS.length;
export const TRAINING_MODES = Object.freeze({
  EPISODE: 'episode',
  ROUND: 'round',
  HYBRID: 'hybrid',
});
export const TERMINAL_REWARD_MODES = Object.freeze({
  SPARSE: 'sparse',
  SCORE: 'score',
});
export const DEFAULT_TERMINAL_REWARD_VALUES = Object.freeze({
  fall: -1,
  win: 1,
  survival: 0,
  scoreWinnerBase: 1,
  scoreWinnerPlacementWeight: 0.1,
  scoreLoserBase: -0.55,
  scoreLoserShareWeight: 0.35,
  scoreLoserPlacementWeight: 0.1,
});

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

export function normalizeTerminalRewardMode(value) {
  const mode = String(value ?? TERMINAL_REWARD_MODES.SPARSE).toLowerCase();
  if (['score', 'score-shaped', 'scores', 'legacy'].includes(mode)) return TERMINAL_REWARD_MODES.SCORE;
  return TERMINAL_REWARD_MODES.SPARSE;
}

export function normalizeTrainingMode(value) {
  const mode = String(value ?? TRAINING_MODES.EPISODE).toLowerCase();
  if (['round', 'rounds', 'snapshot', 'snapshots', 'short-rollout', 'short'].includes(mode)) {
    return TRAINING_MODES.ROUND;
  }
  if (['hybrid', 'mixed', 'mix', 'episode-round', 'round-episode'].includes(mode)) {
    return TRAINING_MODES.HYBRID;
  }
  return TRAINING_MODES.EPISODE;
}

function terminalRewardValues(options = {}) {
  const overrides = options.terminalRewardValues || {};
  return Object.fromEntries(
    Object.entries(DEFAULT_TERMINAL_REWARD_VALUES)
      .map(([key, fallback]) => [key, finiteNumber(overrides[key]) ?? fallback]),
  );
}

function normalizedReturnDiscount(options = {}) {
  const discount = finiteNumber(options.returnDiscount);
  if (discount == null) return 1;
  return Math.max(0, Math.min(1, discount));
}

function normalizedRoundModeRate(options = {}) {
  const rate = finiteNumber(options.roundModeRate);
  if (rate == null) return 0.5;
  return Math.max(0, Math.min(1, rate));
}

function gameProgress(state) {
  const maxRounds = Math.max(1, Number(state?.maxRounds) || 1);
  const round = Math.max(0, Math.min(maxRounds, Number(state?.round) || 0));
  return round / maxRounds;
}

export function computeScorePotentials(state) {
  const progress = gameProgress(state);
  try {
    const final = buildFinalScores(state);
    const scoreByPlayer = new Map(final.scores.map((entry) => [entry.playerId, Number(entry.points) || 0]));
    return Object.fromEntries((state.players || []).map((player) => [
      player.id,
      progress * (scoreByPlayer.get(player.id) || 0) / Math.max(1, MAX_OFFICIAL_SCORE),
    ]));
  } catch {
    return Object.fromEntries((state?.players || []).map((player) => [player.id, 0]));
  }
}

export function assignRoundPotentialRewards(transitions = [], startIndex = 0, before = {}, after = {}) {
  const first = Math.max(0, Math.min(transitions.length, Math.floor(Number(startIndex) || 0)));
  const lastTransitionByPlayer = new Map();
  for (let index = first; index < transitions.length; index += 1) {
    const playerId = transitions[index]?.playerId;
    if (playerId == null) continue;
    lastTransitionByPlayer.set(String(playerId), index);
  }

  const deltas = {};
  const playerIds = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const playerId of playerIds) {
    const index = lastTransitionByPlayer.get(String(playerId));
    if (index == null) continue;
    const delta = (finiteNumber(after?.[playerId]) ?? 0) - (finiteNumber(before?.[playerId]) ?? 0);
    if (delta === 0) continue;
    transitions[index].reward = (finiteNumber(transitions[index].reward) ?? 0) + delta;
    deltas[playerId] = delta;
  }
  return deltas;
}

function createRoundRewardTracker(state, transitions) {
  return {
    round: state.round,
    startIndex: transitions.length,
    potentials: computeScorePotentials(state),
  };
}

function settleRoundPotentialRewards(tracker, state, transitions) {
  if (!tracker) return null;
  return assignRoundPotentialRewards(
    transitions,
    tracker.startIndex,
    tracker.potentials,
    computeScorePotentials(state),
  );
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

export function recordTrainingReturns(stats, transitions = []) {
  for (const transition of transitions) {
    const reward = Number(transition.return);
    if (!Number.isFinite(reward)) continue;
    stats.returnSum += reward;
    stats.returnCount += 1;
    if (reward > 0.05) stats.positiveReturns += 1;
    else if (reward < -0.05) stats.negativeReturns += 1;
    else stats.neutralReturns += 1;
  }
}

function createOutcomeBucket() {
  return {
    appearances: 0,
    wins: 0,
    survivals: 0,
    falls: 0,
    truncated: 0,
    roleCounts: {},
    playerCounts: {},
  };
}

export function createPlayerOutcomeStats() {
  return {
    byPlayer: {},
    byRole: {},
  };
}

function incrementOutcomeCounter(map, key) {
  const normalized = String(key ?? 'unknown');
  map[normalized] = (map[normalized] || 0) + 1;
}

function recordOutcomeBucket(bucket, outcome) {
  bucket.appearances += 1;
  bucket.wins += outcome.won ? 1 : 0;
  bucket.survivals += outcome.survived ? 1 : 0;
  bucket.falls += outcome.fell ? 1 : 0;
  bucket.truncated += outcome.truncated ? 1 : 0;
  incrementOutcomeCounter(bucket.roleCounts, outcome.role);
  incrementOutcomeCounter(bucket.playerCounts, outcome.playerId);
}

export function recordPlayerOutcomes(stats, outcomes = []) {
  if (!stats) return;
  if (!stats.byPlayer) stats.byPlayer = {};
  if (!stats.byRole) stats.byRole = {};
  for (const outcome of outcomes || []) {
    const playerKey = String(outcome.playerId);
    const roleKey = String(outcome.role || 'unknown');
    if (!stats.byPlayer[playerKey]) stats.byPlayer[playerKey] = createOutcomeBucket();
    if (!stats.byRole[roleKey]) stats.byRole[roleKey] = createOutcomeBucket();
    recordOutcomeBucket(stats.byPlayer[playerKey], outcome);
    recordOutcomeBucket(stats.byRole[roleKey], outcome);
  }
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

function createReturnBucket() {
  return {
    count: 0,
    returnSum: 0,
    positive: 0,
    negative: 0,
    neutral: 0,
    min: 0,
    max: 0,
  };
}

function recordReturn(map, key, value) {
  if (!map) return;
  const normalized = String(key ?? 'unknown');
  if (!map[normalized]) map[normalized] = createReturnBucket();
  const bucket = map[normalized];
  const reward = Number.isFinite(Number(value)) ? Number(value) : 0;
  bucket.count += 1;
  bucket.returnSum += reward;
  if (reward > 0.05) bucket.positive += 1;
  else if (reward < -0.05) bucket.negative += 1;
  else bucket.neutral += 1;
  bucket.min = bucket.count === 1 ? reward : Math.min(bucket.min, reward);
  bucket.max = bucket.count === 1 ? reward : Math.max(bucket.max, reward);
}

function mergeReturnBucket(target, source = {}) {
  target.count += source.count || 0;
  target.returnSum += source.returnSum || 0;
  target.positive += source.positive || 0;
  target.negative += source.negative || 0;
  target.neutral += source.neutral || 0;
  if (source.count) {
    target.min = target.count === source.count ? source.min : Math.min(target.min, source.min);
    target.max = target.count === source.count ? source.max : Math.max(target.max, source.max);
  }
}

function mergeReturnMaps(target = {}, source = {}) {
  for (const [key, value] of Object.entries(source || {})) {
    if (!target[key]) target[key] = createReturnBucket();
    mergeReturnBucket(target[key], value);
  }
  return target;
}

function createOutcomeStats() {
  return {
    byKind: {},
    courtActions: {},
    dealClauses: {},
    rewardChoices: {},
    actionValueBuckets: {},
    orderFrontierShare: {},
  };
}

function mergeOutcomeStats(target = createOutcomeStats(), source = {}) {
  mergeReturnMaps(target.byKind, source.byKind);
  mergeReturnMaps(target.courtActions, source.courtActions);
  mergeReturnMaps(target.dealClauses, source.dealClauses);
  mergeReturnMaps(target.rewardChoices, source.rewardChoices);
  mergeReturnMaps(target.actionValueBuckets, source.actionValueBuckets);
  mergeReturnMaps(target.orderFrontierShare, source.orderFrontierShare);
  return target;
}

function createAverageStat() {
  return { sum: 0, count: 0 };
}

function addAverage(stat, value) {
  if (!stat) return;
  const number = Number(value);
  if (!Number.isFinite(number)) return;
  stat.sum += number;
  stat.count += 1;
}

function mergeAverageStat(target, source = {}) {
  target.sum += source.sum || 0;
  target.count += source.count || 0;
  return target;
}

function createEconomicStats() {
  return {
    incomeShare: Object.fromEntries(SCORE_CATEGORY_KEYS.map((key) => [key, createAverageStat()])),
  };
}

function mergeEconomicStats(target = createEconomicStats(), source = {}) {
  for (const key of SCORE_CATEGORY_KEYS) {
    mergeAverageStat(target.incomeShare[key], source.incomeShare?.[key]);
  }
  return target;
}

export function createActionStats() {
  return {
    total: 0,
    byKind: {},
    byPhase: {},
    courtActions: {},
    dealClauses: {},
    dealClauseAmounts: {},
    actionValueBuckets: {},
    rewardChoices: {},
    orderDeployments: {
      frontier: 0,
      capital: 0,
    },
    orderTroops: {
      frontier: 0,
      capital: 0,
    },
    orderFrontierShare: createAverageStat(),
    titleAssignments: 0,
    confirmations: 0,
    outcomes: createOutcomeStats(),
    economics: createEconomicStats(),
  };
}

export function mergeActionStats(target = createActionStats(), source = {}) {
  target.total += source.total || 0;
  for (const [key, value] of Object.entries(source.byKind || {})) increment(target.byKind, key, value);
  for (const [key, value] of Object.entries(source.byPhase || {})) increment(target.byPhase, key, value);
  for (const [key, value] of Object.entries(source.courtActions || {})) increment(target.courtActions, key, value);
  for (const [key, value] of Object.entries(source.dealClauses || {})) increment(target.dealClauses, key, value);
  for (const [key, value] of Object.entries(source.dealClauseAmounts || {})) {
    target.dealClauseAmounts[key] = (target.dealClauseAmounts[key] || 0) + value;
  }
  for (const [key, value] of Object.entries(source.actionValueBuckets || {})) increment(target.actionValueBuckets, key, value);
  for (const [key, value] of Object.entries(source.rewardChoices || {})) increment(target.rewardChoices, key, value);
  for (const [key, value] of Object.entries(source.orderDeployments || {})) {
    target.orderDeployments[key] = (target.orderDeployments[key] || 0) + value;
  }
  for (const [key, value] of Object.entries(source.orderTroops || {})) {
    target.orderTroops[key] = (target.orderTroops[key] || 0) + value;
  }
  mergeAverageStat(target.orderFrontierShare, source.orderFrontierShare);
  target.titleAssignments += source.titleAssignments || 0;
  target.confirmations += source.confirmations || 0;
  mergeOutcomeStats(target.outcomes, source.outcomes);
  mergeEconomicStats(target.economics, source.economics);
  return target;
}

function rawClauseAmount(clause = {}) {
  if (!clause || typeof clause !== 'object') return 0;
  if (clause.kind === 'gold') return Number(clause.amount ?? clause.payload?.totalAmount) || 0;
  if (clause.kind === 'coup_support' || clause.kind === 'frontier_support') {
    return Number(clause.troopCount ?? clause.payload?.troopCount) || 0;
  }
  if (clause.kind === 'appointment_promise') return Number(clause.appointmentCount ?? clause.payload?.appointmentCount) || 1;
  if (clause.kind === 'non_revocation') return Number(clause.durationTurns ?? clause.turns) || 1;
  if (clause.kind === 'estate') return 4;
  return 1;
}

function dealClausesForAction(action) {
  return Array.isArray(action?.payload?.clauses) ? action.payload.clauses : [];
}

function orderTroopSplit(state, playerId, orders = {}) {
  const out = { frontier: 0, capital: 0 };
  if (!state) return out;
  const player = getPlayer(state, playerId);
  if (!player) return out;
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const professional = officeKey === MERCENARY_COMPANY_KEY
      ? 0
      : Math.max(0, Number(player.professionalArmies?.[officeKey]) || 0);
    const levies = officeKey === MERCENARY_COMPANY_KEY
      ? 0
      : (getOfficeHolder(state, officeKey) === playerId ? Math.max(0, Number(state.currentLevies?.[officeKey]) || 0) : 0);
    const mercenaries = officeKey === MERCENARY_COMPANY_KEY
      ? getPlayerMercenaryTroops(state, playerId)
      : 0;
    const total = professional + levies + mercenaries;
    const destination = isCapitalLockedOfficeKey(officeKey)
      ? 'capital'
      : (orders.deployments?.[officeKey] || 'frontier');
    if (destination === 'capital') out.capital += total;
    else out.frontier += total;
  }
  return out;
}

function orderFrontierShareBucket(share) {
  if (!Number.isFinite(share)) return 'none';
  if (share >= 0.8) return 'frontier-heavy';
  if (share >= 0.55) return 'frontier-lean';
  if (share >= 0.45) return 'balanced';
  if (share >= 0.2) return 'capital-lean';
  return 'capital-heavy';
}

function estimateActionMagnitude(action, state, playerId) {
  if (!action) return 0;
  if (action.kind === 'court-confirm') return 0;
  if (action.kind === 'reward') return action.choice === 'gold' ? 2 : 4;
  if (action.kind === 'title-assignment') return Math.max(1, Object.keys(action.assignments || {}).length);
  if (action.kind === 'orders') {
    const split = orderTroopSplit(state, playerId, action.orders);
    return split.frontier + split.capital;
  }
  if (action.kind !== 'court') return 1;

  const courtAction = action.payload?.action;
  if (courtAction === 'buy') return Number(action.payload?.amount) || 1;
  if (courtAction === 'hire-mercenaries' || courtAction === 'dismiss') return Number(action.payload?.count) || 1;
  if (courtAction === 'recruit') return 3;
  if (courtAction === 'gift' || courtAction === 'revoke') return 4;
  if (courtAction?.startsWith('appoint') || courtAction === 'basileus-appoint') return 3;
  if (courtAction?.startsWith('deal-')) {
    const clauses = dealClausesForAction(action);
    return clauses.reduce((total, clause) => total + Math.max(1, rawClauseAmount(clause)), 0);
  }
  return 1;
}

function actionValueBucket(action, state, playerId) {
  const magnitude = estimateActionMagnitude(action, state, playerId);
  const clauseCount = dealClausesForAction(action).length;
  if (action?.kind === 'court-confirm') return 'confirm';
  if (clauseCount >= 2 || magnitude >= 6) return 'major';
  if (magnitude >= 3) return 'standard';
  return 'minor';
}

function describeActionForStats(action, state, playerId) {
  const clauses = dealClausesForAction(action);
  let frontierShare = null;
  if (action?.kind === 'orders') {
    const split = orderTroopSplit(state, playerId, action.orders);
    const total = split.frontier + split.capital;
    frontierShare = total > 0 ? split.frontier / total : 0;
  }
  return {
    kind: action?.kind || 'unknown',
    phase: action?.phase || state?.phase || 'unknown',
    courtAction: action?.kind === 'court' ? (action.payload?.action || 'court') : null,
    rewardChoice: action?.kind === 'reward' ? (action.choice || 'unknown') : null,
    dealClauseKinds: clauses.map((clause) => clause.kind || 'unknown'),
    dealClauseCount: clauses.length,
    valueBucket: actionValueBucket(action, state, playerId),
    orderFrontierShare: frontierShare,
    orderFrontierShareBucket: frontierShare == null ? null : orderFrontierShareBucket(frontierShare),
  };
}

function recordAction(stats, action, state = null) {
  if (!stats || !action) return;
  const behavior = describeActionForStats(action, state, action.playerId);
  stats.total += 1;
  increment(stats.byKind, action.kind);
  increment(stats.byPhase, action.phase);
  increment(stats.actionValueBuckets, behavior.valueBucket);
  if (action.kind === 'court') increment(stats.courtActions, action.payload?.action || 'court');
  if (action.kind === 'court-confirm') stats.confirmations += 1;
  if (action.kind === 'reward') increment(stats.rewardChoices, action.choice || 'unknown');
  if (action.kind === 'title-assignment') stats.titleAssignments += 1;
  for (const clause of dealClausesForAction(action)) {
    increment(stats.dealClauses, clause.kind || 'unknown');
    stats.dealClauseAmounts[clause.kind || 'unknown'] = (stats.dealClauseAmounts[clause.kind || 'unknown'] || 0) + rawClauseAmount(clause);
  }
  if (action.kind === 'orders') {
    for (const destination of Object.values(action.orders?.deployments || {})) {
      if (destination === 'capital') stats.orderDeployments.capital += 1;
      else if (destination === 'frontier') stats.orderDeployments.frontier += 1;
    }
    if (state) {
      const split = orderTroopSplit(state, action.playerId, action.orders);
      stats.orderTroops.frontier += split.frontier;
      stats.orderTroops.capital += split.capital;
      const total = split.frontier + split.capital;
      if (total > 0) addAverage(stats.orderFrontierShare, split.frontier / total);
    }
  }
}

function recordTransitionOutcomes(actionStats, transitions = []) {
  if (!actionStats?.outcomes) return;
  for (const transition of transitions) {
    const behavior = transition.behavior;
    if (!behavior) continue;
    const reward = Number(transition.return) || 0;
    recordReturn(actionStats.outcomes.byKind, behavior.kind, reward);
    if (behavior.courtAction) recordReturn(actionStats.outcomes.courtActions, behavior.courtAction, reward);
    if (behavior.rewardChoice) recordReturn(actionStats.outcomes.rewardChoices, behavior.rewardChoice, reward);
    for (const clauseKind of behavior.dealClauseKinds || []) {
      recordReturn(actionStats.outcomes.dealClauses, clauseKind, reward);
    }
    recordReturn(actionStats.outcomes.actionValueBuckets, behavior.valueBucket, reward);
    if (behavior.orderFrontierShareBucket) {
      recordReturn(actionStats.outcomes.orderFrontierShare, behavior.orderFrontierShareBucket, reward);
    }
  }
}

function categoryValuesForPlayer(state, administration, playerId) {
  const player = getPlayer(state, playerId);
  return {
    church: Math.max(0, Number(administration.incomeBreakdown?.church?.[playerId]) || 0),
    estate: Math.max(0, Number(administration.incomeBreakdown?.estate?.[playerId]) || 0),
    tax: Math.max(0, Number(administration.incomeBreakdown?.tax?.[playerId]) || 0),
    gold: Math.max(0, Number(player?.gold) || 0),
  };
}

function recordEconomicSnapshot(economics, state, playerIds = []) {
  if (!economics || !state || !playerIds.length) return;
  let administration = null;
  try {
    administration = runAdministration(state);
  } catch {
    return;
  }
  const totals = Object.fromEntries(SCORE_CATEGORY_KEYS.map((key) => [key, 0]));
  for (const player of state.players || []) {
    const values = categoryValuesForPlayer(state, administration, player.id);
    for (const key of SCORE_CATEGORY_KEYS) totals[key] += values[key];
  }
  for (const playerId of playerIds) {
    const values = categoryValuesForPlayer(state, administration, playerId);
    for (const key of SCORE_CATEGORY_KEYS) {
      addAverage(economics.incomeShare[key], values[key] / Math.max(1, totals[key] || 1));
    }
  }
}

function createPolicyMixStats() {
  return {
    learner: 0,
    random: 0,
    heuristic: 0,
    human: 0,
    checkpoint: 0,
    custom: 0,
  };
}

function roleMapForPlayers(state, role) {
  return Object.fromEntries((state.players || []).map((player) => [player.id, role]));
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

export function computeTerminalRewards(state, options = {}) {
  const values = terminalRewardValues(options);
  if (state.gameOver?.type === 'fall') {
    const blameShares = computeFallBlameShares(state);
    if (blameShares) {
      return Object.fromEntries(state.players.map((player) => [
        player.id,
        (finiteNumber(blameShares[player.id]) ?? 0) === 0
          ? 0
          : values.fall * (finiteNumber(blameShares[player.id]) ?? 0),
      ]));
    }
    return Object.fromEntries(state.players.map((player) => [player.id, values.fall]));
  }

  const final = buildFinalScores(state);
  const winners = new Set(final.winners.map((entry) => entry.playerId));
  if (normalizeTerminalRewardMode(options.terminalRewardMode ?? options.rewardMode) === TERMINAL_REWARD_MODES.SPARSE) {
    return Object.fromEntries(state.players.map((player) => [
      player.id,
      winners.has(player.id) ? values.win : values.survival,
    ]));
  }

  const maxPoints = Math.max(1, final.topScore || 1);
  const scores = new Map(final.scores.map((entry, index) => [entry.playerId, { ...entry, rank: index + 1 }]));
  return Object.fromEntries(state.players.map((player) => {
    const score = scores.get(player.id);
    const share = (score?.points || 0) / maxPoints;
    const placement = 1 - ((score?.rank || state.players.length) - 1) / Math.max(1, state.players.length - 1);
    const value = winners.has(player.id)
      ? values.scoreWinnerBase + values.scoreWinnerPlacementWeight * placement
      : values.scoreLoserBase + values.scoreLoserShareWeight * share + values.scoreLoserPlacementWeight * placement;
    return [player.id, value];
  }));
}

export function computeFallBlameShares(state) {
  if (state?.gameOver?.type !== 'fall' || !state.lastWarResult?.reachedCPL) return null;

  const actualByPlayer = new Map((state.lastWarResult.contributions || [])
    .map((entry) => [Number(entry.playerId), Math.max(0, Number(entry.troops) || 0)]));
  const capacities = new Map((state.players || []).map((player) => [
    player.id,
    Math.max(0, orderTroopSplit(state, player.id, { deployments: {} }).frontier),
  ]));
  const totalCapacity = [...capacities.values()].reduce((sum, value) => sum + value, 0);
  if (totalCapacity <= 0) return null;

  const totalActual = [...actualByPlayer.values()].reduce((sum, value) => sum + value, 0);
  const gaps = new Map();
  let totalGap = 0;
  for (const player of state.players || []) {
    const expectedShare = (capacities.get(player.id) || 0) / totalCapacity;
    const actualShare = totalActual > 0 ? (actualByPlayer.get(player.id) || 0) / totalActual : 0;
    const gap = Math.max(0, expectedShare - actualShare);
    gaps.set(player.id, gap);
    totalGap += gap;
  }

  if (totalGap <= Number.EPSILON) {
    return Object.fromEntries((state.players || []).map((player) => [player.id, 0]));
  }
  return Object.fromEntries((state.players || []).map((player) => [
    player.id,
    (gaps.get(player.id) || 0) / totalGap,
  ]));
}

export function assignTerminalReturns(transitions = [], rewards = {}, options = {}) {
  const discount = normalizedReturnDiscount(options);
  const lastTransitionByPlayer = new Map();
  for (let index = 0; index < transitions.length; index += 1) {
    const playerId = transitions[index]?.playerId;
    if (playerId == null) continue;
    lastTransitionByPlayer.set(String(playerId), index);
  }

  const nextReturnByPlayer = new Map();
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const transition = transitions[index];
    const playerId = transition?.playerId;
    const key = String(playerId);
    const terminalReward = lastTransitionByPlayer.get(key) === index
      ? (finiteNumber(rewards?.[playerId]) ?? DEFAULT_TERMINAL_REWARD_VALUES.fall)
      : 0;
    const futureReturn = nextReturnByPlayer.get(key) || 0;
    const immediateReward = finiteNumber(transition.reward) ?? 0;
    const currentReturn = immediateReward + terminalReward + discount * futureReturn;
    transition.return = currentReturn;
    nextReturnByPlayer.set(key, currentReturn);
  }
  return transitions;
}

function computeScoreWinnerIds(state) {
  const final = buildFinalScores(state);
  return new Set(final.winners.map((entry) => entry.playerId));
}

function normalizeWinnerIds(winnerIds = null) {
  if (winnerIds instanceof Set) return winnerIds;
  if (Array.isArray(winnerIds)) return new Set(winnerIds);
  return null;
}

function computePlayerOutcomes(state, roleByPlayer = {}, terminalReason = null, options = {}) {
  const fell = options.fell == null
    ? state.gameOver?.type === 'fall'
    : Boolean(options.fell);
  const survived = !fell && (
    options.survived == null
      ? state.phase === 'scoring'
      : Boolean(options.survived)
  );
  const truncated = terminalReason === 'stalled' || terminalReason === 'max-steps';
  const winners = survived
    ? (normalizeWinnerIds(options.winnerIds) || computeScoreWinnerIds(state))
    : new Set();
  return (state.players || []).map((player) => ({
    playerId: player.id,
    role: roleByPlayer[player.id] || roleByPlayer[String(player.id)] || 'unknown',
    won: survived && winners.has(player.id),
    survived,
    fell,
    truncated,
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
        reward: 0,
        return: 0,
        behavior: describeActionForStats(actions[selection.index], state, playerId),
      });
    }
    return selection.index;
  };
}

function roleFromRates(roleRng, options, opponentNetworks) {
  const randomRate = Math.max(0, Number(options.randomOpponentRate) || 0);
  const heuristicRate = Math.max(0, Number(options.heuristicOpponentRate) || 0);
  const humanRate = options.humanOpponentNetwork
    ? Math.max(0, Number(options.humanOpponentRate) || 0)
    : 0;
  const checkpointRate = opponentNetworks.length
    ? Math.max(0, Number(options.checkpointOpponentRate) || 0)
    : 0;
  const roll = roleRng();
  if (roll < randomRate) return { kind: 'random' };
  if (roll < randomRate + heuristicRate) return { kind: 'heuristic' };
  if (roll < randomRate + heuristicRate + humanRate) {
    return { kind: 'human', network: options.humanOpponentNetwork };
  }
  if (roll < randomRate + heuristicRate + humanRate + checkpointRate) {
    return {
      kind: 'checkpoint',
      network: opponentNetworks[Math.floor(roleRng() * opponentNetworks.length)],
    };
  }
  return { kind: 'learner' };
}

function createEpisodePolicy(options, state, transitions, seed) {
  if (options.policy) {
    const roleByPlayer = options.policyRoles
      ? Object.fromEntries((state.players || []).map((player) => [
        player.id,
        options.policyRoles[player.id] || options.policyRoles[String(player.id)] || options.policyRole || 'custom',
      ]))
      : Object.fromEntries((state.players || []).map((player) => [
        player.id,
        typeof options.policyRoleForPlayer === 'function'
          ? (options.policyRoleForPlayer(player.id, state) || options.policyRole || 'custom')
          : (options.policyRole || 'custom'),
      ]));
    return {
      policy: options.policy,
      policyMix: { ...createPolicyMixStats(), custom: state.players.length },
      roleByPlayer,
    };
  }

  if (!options.network) {
    return {
      policy: createRandomPolicy(),
      policyMix: { ...createPolicyMixStats(), random: state.players.length },
      roleByPlayer: roleMapForPlayers(state, 'random'),
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
      roleByPlayer: roleMapForPlayers(state, 'learner'),
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
      if (role.kind === 'human' && role.network) {
        const inputs = buildCandidateInputs(currentState, playerId, actions);
        return selectActionWithNetwork(role.network, inputs, rng, {
          greedy: options.humanOpponentGreedy ?? true,
          temperature: options.humanOpponentTemperature ?? 0,
        }).index;
      }
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
        reward: 0,
        return: 0,
        behavior: describeActionForStats(actions[selection.index], currentState, playerId),
      });
      return selection.index;
    },
    policyMix,
    roleByPlayer: Object.fromEntries([...roles.entries()].map(([playerId, role]) => [playerId, role.kind])),
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
        : listLegalCourtActions(state, player.id, { includeDeals: false });
      const action = chooseAction(policy, { state, playerId: player.id, actions, rng });
      if (!action) break;
      const result = applyLegalAction(state, action);
      if (!result.ok) break;
      recordAction(options.actionStats, action, state);
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
    recordAction(actionStats, action, state);
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
        recordAction(actionStats, action, state);
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
    recordAction(actionStats, action, state);
    madeProgress = true;
  }

  if (!hasPendingDefenderRewards(state)) {
    phaseCleanup(state);
    advanceToNextInteractivePhase(state);
    return true;
  }
  return madeProgress;
}

function runTrainingStep(state, policy, rng, options = {}) {
  if (state.phase === 'court') {
    return runCourtPhase(state, policy, rng, {
      maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer || DEFAULT_MAX_COURT_ACTIONS_PER_PLAYER,
      includeDeals: false,
      actionStats: options.actionStats || null,
    });
  }
  if (state.phase === 'orders') return runOrdersPhase(state, policy, rng, options.actionStats || null);
  if (state.phase === 'resolution') return runResolutionPhase(state, policy, rng, options.actionStats || null);
  advanceToNextInteractivePhase(state);
  return true;
}

function snapshotRoundRange(options = {}, deckSize = 1) {
  const maxRound = Math.max(1, Math.floor(Number(deckSize) || 1));
  const fixed = clampInteger(options.snapshotRound ?? options.startRound, 1, maxRound);
  if (fixed != null) return { min: fixed, max: fixed };
  const min = clampInteger(options.snapshotRoundMin, 1, maxRound) ?? 1;
  const max = clampInteger(options.snapshotRoundMax, 1, maxRound) ?? maxRound;
  return min <= max ? { min, max } : { min: max, max: min };
}

function chooseSnapshotRound(settings, seed, options = {}) {
  const range = snapshotRoundRange(options, settings.deckSize);
  const rng = makeRng(deriveEpisodeSeed(seed, 53));
  return randomIntInclusive(rng, range.min, range.max);
}

function generateLegalSnapshot(options, settings, seed) {
  const targetRound = chooseSnapshotRound(settings, seed, options);
  const state = createGameState({
    playerCount: settings.playerCount,
    deckSize: settings.deckSize,
    seed,
    historyEnabled: false,
  });
  setDealParticipantIds(state, state.players.map((player) => player.id));
  const rng = makeRng(seed);
  const preludePolicy = createRandomPolicy();
  advanceToNextInteractivePhase(state);

  let steps = 0;
  let terminalReason = null;
  const maxSteps = options.snapshotMaxSteps || options.maxSteps || DEFAULT_MAX_STEPS;
  while (
    !state.gameOver
    && state.phase !== 'scoring'
    && state.round < targetRound
    && steps < maxSteps
  ) {
    steps += 1;
    const progressed = runTrainingStep(state, preludePolicy, rng, {
      maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer || DEFAULT_MAX_COURT_ACTIONS_PER_PLAYER,
      actionStats: null,
    });
    if (!progressed) {
      terminalReason = 'stalled';
      break;
    }
  }

  if (terminalReason === 'stalled' && !state.gameOver && state.phase !== 'scoring') {
    state.gameOver = { type: 'fall', message: 'Training snapshot generation stalled before reaching the sampled round.' };
  }

  if (!state.gameOver && state.phase !== 'scoring' && steps >= maxSteps) {
    state.gameOver = { type: 'fall', message: 'Training snapshot generation reached its safety step limit.' };
    terminalReason = 'max-steps';
  }

  return {
    state,
    rng,
    targetRound,
    preludeSteps: steps,
    terminalReason,
  };
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
  const { policy, policyMix, roleByPlayer } = createEpisodePolicy(options, state, transitions, seed);

  advanceToNextInteractivePhase(state);
  let roundRewardTracker = createRoundRewardTracker(state, transitions);
  let steps = 0;
  let terminalReason = null;
  while (!state.gameOver && state.phase !== 'scoring' && steps < (options.maxSteps || DEFAULT_MAX_STEPS)) {
    steps += 1;
    const progressed = runTrainingStep(state, policy, rng, {
      maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer || DEFAULT_MAX_COURT_ACTIONS_PER_PLAYER,
      actionStats,
    });
    if (
      progressed
      && roundRewardTracker
      && (state.gameOver || state.phase === 'scoring' || state.round !== roundRewardTracker.round)
    ) {
      settleRoundPotentialRewards(roundRewardTracker, state, transitions);
      roundRewardTracker = state.gameOver || state.phase === 'scoring'
        ? null
        : createRoundRewardTracker(state, transitions);
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

  if (roundRewardTracker && (state.gameOver || state.phase === 'scoring')) {
    settleRoundPotentialRewards(roundRewardTracker, state, transitions);
    roundRewardTracker = null;
  }

  const rewards = computeTerminalRewards(state, options);
  assignTerminalReturns(transitions, rewards, options);
  const playerOutcomes = computePlayerOutcomes(state, roleByPlayer, terminalReason);
  recordTransitionOutcomes(actionStats, transitions);
  recordEconomicSnapshot(actionStats.economics, state, [...new Set(transitions.map((entry) => entry.playerId))]);

  return {
    state,
    transitions,
    rewards,
    stats: {
      steps,
      fell: state.gameOver?.type === 'fall',
      survived: state.phase === 'scoring' && state.gameOver?.type !== 'fall',
      outcomeCounted: true,
      truncated: terminalReason === 'stalled' || terminalReason === 'max-steps',
      terminalReason: terminalReason || (state.phase === 'scoring' ? 'scoring' : state.gameOver?.type || 'unknown'),
      trainingMode: TRAINING_MODES.EPISODE,
      rounds: state.round,
      playerCount: settings.playerCount,
      deckSize: settings.deckSize,
      seed,
      actionStats,
      policyMix,
      playerOutcomes,
    },
  };
}

export function runSelfPlayRoundEpisode(options = {}) {
  const settings = resolveEpisodeSettings(options, options.episodeIndex || 0);
  const seed = settings.seed;
  const snapshot = generateLegalSnapshot(options, settings, seed);
  const { state, rng, targetRound, preludeSteps } = snapshot;
  const transitions = [];
  const actionStats = createActionStats();
  const { policy, policyMix, roleByPlayer } = createEpisodePolicy(options, state, transitions, seed);
  const rolloutRoundsTarget = Math.max(1, Math.floor(Number(options.rolloutRounds) || 1));
  const maxSteps = options.rolloutMaxSteps || options.maxSteps || DEFAULT_MAX_STEPS;

  let roundRewardTracker = state.gameOver || state.phase === 'scoring'
    ? null
    : createRoundRewardTracker(state, transitions);
  let steps = 0;
  let completedRolloutRounds = 0;
  let terminalReason = snapshot.terminalReason;
  while (
    !state.gameOver
    && state.phase !== 'scoring'
    && completedRolloutRounds < rolloutRoundsTarget
    && steps < maxSteps
  ) {
    steps += 1;
    const progressed = runTrainingStep(state, policy, rng, {
      maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer || DEFAULT_MAX_COURT_ACTIONS_PER_PLAYER,
      actionStats,
    });
    if (
      progressed
      && roundRewardTracker
      && (state.gameOver || state.phase === 'scoring' || state.round !== roundRewardTracker.round)
    ) {
      settleRoundPotentialRewards(roundRewardTracker, state, transitions);
      completedRolloutRounds += 1;
      roundRewardTracker = state.gameOver
        || state.phase === 'scoring'
        || completedRolloutRounds >= rolloutRoundsTarget
        ? null
        : createRoundRewardTracker(state, transitions);
    }
    if (!progressed) {
      terminalReason = 'stalled';
      break;
    }
  }

  if (!state.gameOver && state.phase !== 'scoring' && steps >= maxSteps) {
    state.gameOver = { type: 'fall', message: 'Training round rollout reached its safety step limit.' };
    terminalReason = 'max-steps';
  }

  if (roundRewardTracker && (state.gameOver || state.phase === 'scoring')) {
    settleRoundPotentialRewards(roundRewardTracker, state, transitions);
    completedRolloutRounds += 1;
    roundRewardTracker = null;
  }

  const playedRollout = transitions.length > 0;
  const fell = state.gameOver?.type === 'fall';
  const terminal = state.gameOver || state.phase === 'scoring';
  const rolloutSurvived = playedRollout
    && !fell
    && (state.phase === 'scoring' || completedRolloutRounds >= rolloutRoundsTarget);
  const rolloutOutcome = playedRollout && (terminal || completedRolloutRounds >= rolloutRoundsTarget);
  const rewards = rolloutOutcome
    ? computeTerminalRewards(state, options)
    : Object.fromEntries((state.players || []).map((player) => [player.id, 0]));
  assignTerminalReturns(transitions, rewards, options);
  const playerOutcomes = playedRollout
    ? computePlayerOutcomes(
      state,
      roleByPlayer,
      terminalReason || (terminal ? null : 'round-rollout'),
      {
        fell,
        survived: rolloutSurvived,
        winnerIds: rolloutSurvived ? computeScoreWinnerIds(state) : null,
      },
    )
    : [];
  recordTransitionOutcomes(actionStats, transitions);
  recordEconomicSnapshot(actionStats.economics, state, [...new Set(transitions.map((entry) => entry.playerId))]);

  return {
    state,
    transitions,
    rewards,
    stats: {
      steps,
      preludeSteps,
      snapshotRound: targetRound,
      rolloutRounds: completedRolloutRounds,
      trainingMode: TRAINING_MODES.ROUND,
      fell: playedRollout && fell,
      survived: rolloutSurvived,
      outcomeCounted: playedRollout,
      truncated: playedRollout && (terminalReason === 'stalled' || terminalReason === 'max-steps'),
      terminalReason: terminalReason || (state.phase === 'scoring' ? 'scoring' : state.gameOver?.type || 'round-rollout'),
      rounds: completedRolloutRounds,
      playerCount: settings.playerCount,
      deckSize: settings.deckSize,
      seed,
      actionStats,
      policyMix,
      playerOutcomes,
    },
  };
}

export function runTrainingEpisode(options = {}) {
  const mode = normalizeTrainingMode(options.trainingMode);
  if (mode === TRAINING_MODES.ROUND) return runSelfPlayRoundEpisode(options);
  if (mode === TRAINING_MODES.HYBRID) {
    const seed = resolveEpisodeSeed(options, options.episodeIndex || 0);
    const rng = makeRng(deriveEpisodeSeed(seed, 71));
    const selectedMode = rng() < normalizedRoundModeRate(options)
      ? TRAINING_MODES.ROUND
      : TRAINING_MODES.EPISODE;
    const selectedOptions = {
      ...options,
      episodeSeed: seed,
      trainingMode: selectedMode,
    };
    return selectedMode === TRAINING_MODES.ROUND
      ? runSelfPlayRoundEpisode(selectedOptions)
      : runSelfPlayEpisode(selectedOptions);
  }
  return runSelfPlayEpisode(options);
}

function trainingEpochCount(options = {}) {
  return Math.max(1, Math.floor(Number(options.trainingEpochs) || 1));
}

function blendHumanFeedbackTransitions(network, transitions, options = {}) {
  const human = Array.isArray(options.humanFeedbackTransitions) ? options.humanFeedbackTransitions : [];
  const weight = Math.max(0, Number(options.humanFeedbackWeight) || 0);
  if (!human.length || weight <= 0) return transitions;
  const baseCount = Math.max(1, transitions.length || human.length);
  const targetCount = Math.max(1, Math.ceil(baseCount * weight));
  const start = Math.max(0, Number(network?.step) || 0) % human.length;
  const mixed = transitions.slice();
  for (let index = 0; index < targetCount; index += 1) {
    mixed.push(human[(start + index) % human.length]);
  }
  return mixed;
}

export function trainTransitions(network, transitions, options = {}) {
  const epochs = trainingEpochCount(options);
  let loss = 0;
  let policyLoss = 0;
  let valueLoss = 0;
  let count = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const report = trainBatch(network, blendHumanFeedbackTransitions(network, transitions, options), {
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
    outcomeEpisodes: 0,
    falls: 0,
    survivals: 0,
    truncated: 0,
    transitions: 0,
    rounds: 0,
    playerCounts: {},
    roundLengths: {},
    trainingModes: {},
    actionStats: createActionStats(),
    policyMix: createPolicyMixStats(),
    playerOutcomes: createPlayerOutcomeStats(),
    loss: 0,
    policyLoss: 0,
    valueLoss: 0,
    returnSum: 0,
    returnCount: 0,
    positiveReturns: 0,
    negativeReturns: 0,
    neutralReturns: 0,
  };

  for (let episode = 0; episode < episodes; episode += 1) {
    const result = runTrainingEpisode({
      ...options,
      network,
      episodeSeed: resolveEpisodeSeed(options, episode),
      episodeIndex: episode,
    });
    const report = trainTransitions(network, result.transitions, options);
    const outcomeCounted = result.stats.outcomeCounted !== false;
    stats.outcomeEpisodes += outcomeCounted ? 1 : 0;
    stats.falls += outcomeCounted && result.stats.fell ? 1 : 0;
    stats.survivals += outcomeCounted && result.stats.survived ? 1 : 0;
    stats.truncated += outcomeCounted && result.stats.truncated ? 1 : 0;
    stats.transitions += result.transitions.length;
    stats.rounds += result.stats.rounds;
    addDistributionValue(stats, 'playerCounts', result.stats.playerCount);
    addDistributionValue(stats, 'roundLengths', result.stats.deckSize);
    addDistributionValue(stats, 'trainingModes', result.stats.trainingMode || TRAINING_MODES.EPISODE);
    mergeActionStats(stats.actionStats, result.stats.actionStats);
    mergePolicyMixStats(stats.policyMix, result.stats.policyMix);
    recordPlayerOutcomes(stats.playerOutcomes, result.stats.playerOutcomes);
    recordTrainingReturns(stats, result.transitions);
    stats.loss += report.loss;
    stats.policyLoss += report.policyLoss;
    stats.valueLoss += report.valueLoss;
    const completed = episode + 1;
    if (onProgress) {
      onProgress({
        completed,
        batchSize: 1,
        episodes,
        stats: {
          ...stats,
          loss: stats.loss / completed,
          policyLoss: stats.policyLoss / completed,
          valueLoss: stats.valueLoss / completed,
        },
        last: {
          fell: result.stats.fell,
          survived: result.stats.survived,
          outcomeCounted: result.stats.outcomeCounted,
          truncated: result.stats.truncated,
          terminalReason: result.stats.terminalReason,
          rounds: result.stats.rounds,
          trainingMode: result.stats.trainingMode,
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
        stats: {
          ...stats,
          loss: stats.loss / completed,
          policyLoss: stats.policyLoss / completed,
          valueLoss: stats.valueLoss / completed,
        },
        last: {
          seed: result.stats.seed,
          trainingMode: result.stats.trainingMode,
          loss: report.loss,
          transitions: result.transitions.length,
          trainingEpochs: report.epochs,
        },
      });
    }
  }

  stats.loss /= episodes;
  stats.policyLoss /= episodes;
  stats.valueLoss /= episodes;
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
    survivalRateByPlayer: {},
    playerOutcomes: createPlayerOutcomeStats(),
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
    recordPlayerOutcomes(stats.playerOutcomes, result.stats.playerOutcomes);
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
    stats.survivalRateByPlayer[playerId] = (stats.playerOutcomes.byPlayer[playerId]?.survivals || 0) / appearances;
  }
  stats.fallRate = stats.falls / episodes;
  stats.survivalRate = stats.survivals / episodes;
  stats.truncatedRate = stats.truncated / episodes;
  return stats;
}
