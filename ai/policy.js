import {
  applyLegalAction,
  getActionTargetPlayerId,
  getActionThemeId,
  listLegalCourtActions,
  listLegalOrderActions,
  listLegalTitleAssignments,
} from './legalActions.js';
import {
  evaluateState,
  getAverageInvasionStrength,
  getLeadingOpponentId,
  getScoreSnapshot,
  getTitleWeight,
  getWeakestOpponentId,
  summarizeOrders,
} from './evaluation.js';
import { cloneAiState } from './simulation.js';
import {
  applyDefenderRewardChoice,
  getPendingDefenderRewards,
  phaseResolution,
} from '../engine/turnflow.js';
import { getPlayer } from '../engine/state.js';
import { isCapitalLockedOfficeKey } from '../engine/orders.js';

const COURT_SEARCH_DEPTH = 3;
const COURT_BRANCH_LIMIT = 8;
const COURT_PREFILTER_LIMIT = 16;
const COURT_MIN_GAIN = 0.75;
const COURT_ACTIVITY_MIN_SCORE = 9;
const COURT_SAFETY_ACTION_LIMIT = 80;
const ORDER_RNG_SAMPLES = [0, 0.5, 0.999999];

function isDealAction(action) {
  return String(action?.payload?.action || '').startsWith('deal-');
}

function getCourtCandidateActions(state, playerId) {
  return listLegalCourtActions(state, playerId, { includeDeals: false })
    .filter((action) => action.kind === 'court' && !isDealAction(action));
}

function themeValue(theme) {
  if (!theme) return 0;
  return ((Number(theme.P) || 0) * 3.2)
    + ((Number(theme.T) || 0) * 2.2)
    + ((Number(theme.L) || 0) * 1.1)
    + ((Number(theme.C) || 0) * 1.4);
}

function courtActionBias(state, action, playerId, context = {}) {
  const payload = action?.payload || {};
  const targetPlayerId = getActionTargetPlayerId(state, action);
  const leaderId = context.leaderId ?? getLeadingOpponentId(state, playerId);
  const themeId = getActionThemeId(action);
  const theme = themeId ? state.themes?.[themeId] : null;

  if (payload.action === 'buy') {
    const amount = Math.max(0, Number(payload.amount) || 0);
    return themeValue(theme) - (amount * 0.55);
  }

  if (payload.action === 'gift') {
    return targetPlayerId === leaderId ? -8 : 2;
  }

  if (
    payload.action === 'basileus-appoint'
    || payload.action === 'appoint-strategos'
    || payload.action === 'appoint-bishop'
  ) {
    let bias = themeValue(theme) * 0.35;
    if (targetPlayerId === playerId) bias += 10;
    else bias += 2;
    if (targetPlayerId === leaderId) bias -= 18;
    if (payload.titleType === 'BISHOP' || payload.action === 'appoint-bishop') bias += 5;
    if (payload.titleType === 'STRATEGOS' || payload.action === 'appoint-strategos') bias += 4;
    return bias;
  }

  if (payload.action === 'recruit') return 8;
  if (payload.action === 'hire-mercenaries') return (Number(payload.count) || 0) * 3.2;
  if (payload.action === 'dismiss') return -18;

  if (payload.action === 'revoke') {
    if (targetPlayerId === playerId) return -40;
    return (targetPlayerId === leaderId ? 24 : 8) + (theme ? themeValue(theme) * 0.3 : 0);
  }

  return 0;
}

function courtActivityScore(state, action, playerId, context = {}) {
  const payload = action?.payload || {};
  const targetPlayerId = getActionTargetPlayerId(state, action);
  const leaderId = context.leaderId ?? getLeadingOpponentId(state, playerId);
  const themeId = getActionThemeId(action);
  const theme = themeId ? state.themes?.[themeId] : null;

  if (payload.action === 'buy') {
    const amount = Math.max(0, Number(payload.amount) || 0);
    return 24 + themeValue(theme) - (amount * 0.35);
  }
  if (
    payload.action === 'basileus-appoint'
    || payload.action === 'appoint-strategos'
    || payload.action === 'appoint-bishop'
  ) {
    let score = 14 + (theme ? themeValue(theme) * 0.32 : 0);
    if (targetPlayerId === playerId) score += 14;
    if (targetPlayerId === leaderId) score -= 22;
    return score;
  }
  if (payload.action === 'recruit') return 22;
  if (payload.action === 'hire-mercenaries') return 8 + ((Number(payload.count) || 0) * 2);
  if (payload.action === 'revoke') {
    if (targetPlayerId === playerId) return -50;
    return targetPlayerId === leaderId ? 34 : 14;
  }
  if (payload.action === 'gift') return 2 + (theme ? themeValue(theme) * 0.05 : 0);
  return -10;
}

function scoreAppliedAction(state, playerId, action, context = {}) {
  const trial = cloneAiState(state);
  const result = applyLegalAction(trial, action);
  if (!result.ok) return null;
  const trialScore = evaluateState(trial, playerId);
  const baseScore = Number.isFinite(Number(context.baseScore))
    ? Number(context.baseScore)
    : evaluateState(state, playerId);
  return {
    action,
    trial,
    score: trialScore + courtActionBias(state, action, playerId, context),
    delta: trialScore - baseScore,
  };
}

function rankCourtActions(state, playerId) {
  const context = {
    leaderId: getLeadingOpponentId(state, playerId),
    baseScore: evaluateState(state, playerId),
  };
  return getCourtCandidateActions(state, playerId)
    .sort((left, right) => (
      courtActionBias(state, right, playerId, context)
      - courtActionBias(state, left, playerId, context)
      || left.id.localeCompare(right.id)
    ))
    .slice(0, COURT_PREFILTER_LIMIT)
    .map((action) => scoreAppliedAction(state, playerId, action, context))
    .filter(Boolean)
    .sort((left, right) => (
      (right.score - left.score)
      || (right.delta - left.delta)
      || left.action.id.localeCompare(right.action.id)
    ));
}

function searchCourt(state, playerId, depth) {
  const baseScore = evaluateState(state, playerId);
  let best = { score: baseScore, actions: [], gain: 0, state };
  let beam = [best];

  for (let level = 0; level < depth; level += 1) {
    const expanded = [];
    for (const entry of beam) {
      const ranked = rankCourtActions(entry.state, playerId).slice(0, COURT_BRANCH_LIMIT);
      for (const candidate of ranked) {
        expanded.push({
          state: candidate.trial,
          score: candidate.score,
          actions: [...entry.actions, candidate.action],
          gain: candidate.score - baseScore,
        });
      }
    }

    if (!expanded.length) break;
    expanded.sort((left, right) => (
      (right.score - left.score)
      || (left.actions.length - right.actions.length)
    ));
    beam = expanded.slice(0, COURT_BRANCH_LIMIT);
    if (beam[0].score > best.score) {
      best = beam[0];
    }
  }

  if (best.gain < COURT_MIN_GAIN) return { score: baseScore, actions: [], gain: 0 };
  return best;
}

function actionAlreadyChosen(actions, candidate) {
  const payload = candidate?.payload || {};
  return actions.some((action) => {
    const existing = action?.payload || {};
    if (existing.action !== payload.action) return false;
    if (payload.themeId && existing.themeId === payload.themeId) return true;
    if (payload.office && existing.office === payload.office) return true;
    if (payload.value && existing.value === payload.value) return true;
    return JSON.stringify(existing) === JSON.stringify(payload);
  });
}

function fillCourtAgenda(state, playerId, actions, maxActions = Infinity) {
  const hasActionLimit = Number.isFinite(maxActions);
  const actionLimit = hasActionLimit
    ? Math.max(0, Number(maxActions) || 0)
    : COURT_SAFETY_ACTION_LIMIT;
  const planState = cloneAiState(state);
  const plan = [];
  for (const action of actions) {
    if (plan.length >= actionLimit) break;
    const result = applyLegalAction(planState, action);
    if (result.ok) plan.push(action);
  }

  while (plan.length < actionLimit) {
    const baseScore = evaluateState(planState, playerId);
    const context = {
      leaderId: getLeadingOpponentId(planState, playerId),
      baseScore,
    };
    const candidate = rankCourtActions(planState, playerId)
      .filter((entry) => !actionAlreadyChosen(plan, entry.action))
      .map((entry) => ({
        ...entry,
        activityScore: courtActivityScore(planState, entry.action, playerId, context),
        expectedGain: entry.score - baseScore,
      }))
      .filter((entry) => (
        entry.expectedGain > COURT_MIN_GAIN
        || entry.activityScore > COURT_ACTIVITY_MIN_SCORE
      ))
      .sort((left, right) => (
        (right.expectedGain - left.expectedGain)
        || (right.activityScore - left.activityScore)
        || left.action.id.localeCompare(right.action.id)
      ))[0] || null;

    if (!candidate) break;
    const result = applyLegalAction(planState, candidate.action);
    if (!result.ok) break;
    plan.push(candidate.action);
  }

  return plan;
}

export function chooseAICourtActions(state, playerId, options = {}) {
  const maxActions = Number.isFinite(Number(options.maxActions))
    ? Math.max(0, Number(options.maxActions))
    : Infinity;
  const candidateCount = getCourtCandidateActions(state, playerId).length;
  const adaptiveDepth = candidateCount > 90 ? 2 : COURT_SEARCH_DEPTH;
  const depth = Math.max(1, Number(options.depth) || adaptiveDepth);
  const result = searchCourt(state, playerId, depth);
  const startingActions = Number.isFinite(maxActions)
    ? result.actions.slice(0, maxActions)
    : result.actions;
  return fillCourtAgenda(state, playerId, startingActions, maxActions);
}

function orderShapeScore(state, playerId, action, options = {}) {
  const orders = action?.orders || {};
  const summary = summarizeOrders(state, playerId, orders);
  const leaderId = getLeadingOpponentId(state, playerId);
  const averageStrength = getAverageInvasionStrength(state);
  const fairShare = averageStrength > 0 ? averageStrength / Math.max(1, state.players.length) : 0;
  const projectedOpponent = Boolean(options.projectedOpponent);
  const movableTroops = summary.offices
    .filter((entry) => !isCapitalLockedOfficeKey(entry.officeKey))
    .reduce((total, entry) => total + entry.troops, 0);
  const targetMultiplier = projectedOpponent ? 1.15 : 0.78;
  const targetFrontier = fairShare > 0
    ? Math.min(movableTroops, Math.max(1, fairShare * targetMultiplier))
    : 0;
  const frontierShortfall = targetFrontier > 0
    ? Math.max(0, targetFrontier - summary.frontierTroops)
    : 0;
  const frontierSurplus = targetFrontier > 0
    ? Math.max(0, summary.frontierTroops - targetFrontier)
    : 0;
  const frontierReward = projectedOpponent ? 3 : 1.9;
  const shortfallPenalty = projectedOpponent ? 3.4 : 1.35;
  const surplusPenalty = projectedOpponent ? 0.2 : 1.25;
  const frontierContribution = targetFrontier > 0
    ? (Math.min(summary.frontierTroops, targetFrontier) * frontierReward)
      - (frontierShortfall * shortfallPenalty)
      - (frontierSurplus * surplusPenalty)
    : 0;
  const zeroFrontierPenalty = targetFrontier > 0 && summary.frontierTroops <= 0
    ? (projectedOpponent ? -20 : -8)
    : 0;
  let candidateScore = 0;

  if (projectedOpponent) {
    if (summary.candidate === playerId) candidateScore += summary.capitalTroops * 0.35 + 2;
    else if (summary.candidate === state.basileusId) candidateScore += summary.capitalTroops * 0.15 + 1;
    else candidateScore += summary.capitalTroops * 0.25;
  } else if (summary.candidate === playerId) candidateScore += summary.capitalTroops * 1.85 + 8;
  else if (summary.candidate === state.basileusId) candidateScore += summary.capitalTroops * 0.2 + 2;
  else candidateScore += summary.capitalTroops * 0.45;

  if (summary.candidate === leaderId) {
    candidateScore -= projectedOpponent
      ? summary.capitalTroops * 0.8 + 4
      : summary.capitalTroops * 1.35 + 9;
  }
  if (projectedOpponent && summary.candidate === playerId) candidateScore += 2;

  return frontierContribution + zeroFrontierPenalty + candidateScore;
}

function chooseProjectedOrderAction(state, playerId) {
  const actions = listLegalOrderActions(state, playerId);
  if (!actions.length) return null;
  return actions
    .slice()
    .sort((left, right) => (
      orderShapeScore(state, playerId, right, { projectedOpponent: true })
      - orderShapeScore(state, playerId, left, { projectedOpponent: true })
      || left.id.localeCompare(right.id)
    ))[0];
}

function buildProjectedOrderMap(state, playerId) {
  const projected = new Map();
  for (const player of state.players || []) {
    if (player.id === playerId) continue;
    const action = chooseProjectedOrderAction(state, player.id);
    if (action) projected.set(player.id, action);
  }
  return projected;
}

function fillProjectedOpponentOrders(state, playerId, projectedOrders) {
  for (const player of state.players || []) {
    if (player.id === playerId || state.allOrders?.[player.id]) continue;
    const action = projectedOrders?.get(player.id) || chooseProjectedOrderAction(state, player.id);
    if (!action) continue;
    applyLegalAction(state, action);
  }
}

function resolveSimulatedRewards(state, playerId) {
  let safety = 0;
  while (safety < 30) {
    safety += 1;
    const reward = getPendingDefenderRewards(state)[0];
    if (!reward) return;
    const choice = reward.defenderId === playerId
      ? chooseAIDefenderRewardChoice(state, playerId, reward)
      : 'empire';
    const result = applyDefenderRewardChoice(state, reward.id, reward.defenderId, choice);
    if (!result.ok && choice !== 'empire') {
      applyDefenderRewardChoice(state, reward.id, reward.defenderId, 'empire');
    }
  }
}

function scoreOrderActionForSample(state, playerId, action, projectedOrders, rngSample) {
  const trial = cloneAiState(state, { resetOrders: true, rngSample });
  const result = applyLegalAction(trial, action);
  if (!result.ok) return -Infinity;

  fillProjectedOpponentOrders(trial, playerId, projectedOrders);
  if (Object.keys(trial.allOrders || {}).length === trial.players.length) {
    phaseResolution(trial);
    resolveSimulatedRewards(trial, playerId);
  }

  return evaluateState(trial, playerId);
}

function scoreOrderAction(state, playerId, action, projectedOrders) {
  const sampleScore = ORDER_RNG_SAMPLES.reduce(
    (total, sample) => total + scoreOrderActionForSample(state, playerId, action, projectedOrders, sample),
    0,
  ) / ORDER_RNG_SAMPLES.length;
  return sampleScore + orderShapeScore(state, playerId, action);
}

export function chooseAIOrderAction(state, playerId) {
  const actions = listLegalOrderActions(state, playerId);
  if (!actions.length) return null;
  const projectedOrders = buildProjectedOrderMap(state, playerId);
  const scored = actions
    .map((action) => ({
      action,
      score: scoreOrderAction(state, playerId, action, projectedOrders),
      summary: summarizeOrders(state, playerId, action.orders),
    }))
    .sort((left, right) => (
      (right.score - left.score)
      || (right.summary.capitalTroops - left.summary.capitalTroops)
      || (left.summary.frontierTroops - right.summary.frontierTroops)
      || left.action.id.localeCompare(right.action.id)
    ));
  return scored[0] || null;
}

export function chooseAIDefenderRewardChoice(state, playerId, reward) {
  const choices = ['empire', 'gold'];
  const scored = choices.map((choice) => {
    const trial = cloneAiState(state);
    const result = applyDefenderRewardChoice(trial, reward.id, playerId, choice);
    return {
      choice,
      score: result.ok ? evaluateState(trial, playerId) : -Infinity,
    };
  }).sort((left, right) => (
    (right.score - left.score)
    || (left.choice === 'gold' ? -1 : 1)
  ));
  return scored[0]?.choice || 'empire';
}

function titleAssignmentBias(state, newBasileusId, action) {
  const snapshot = getScoreSnapshot(state);
  const leaderId = snapshot.scores.find((entry) => entry.playerId !== newBasileusId)?.playerId ?? null;
  const weakestId = getWeakestOpponentId(state, newBasileusId);
  let bias = 0;

  for (const [titleKey, assignedPlayerIdValue] of Object.entries(action.assignments || {})) {
    const assignedPlayerId = Number(assignedPlayerIdValue);
    const weight = getTitleWeight(titleKey);
    if (assignedPlayerId === leaderId) bias -= weight * 1.6;
    if (assignedPlayerId === weakestId) bias += weight * 0.45;
    if (titleKey === 'PATRIARCH' && assignedPlayerId === leaderId) bias -= 20;
  }

  return bias;
}

export function chooseAITitleAssignment(state, newBasileusId) {
  const actions = listLegalTitleAssignments(state, newBasileusId);
  if (!actions.length) return null;
  const scored = actions.map((action) => {
    const trial = cloneAiState(state);
    const result = applyLegalAction(trial, action);
    return {
      action,
      score: result.ok
        ? evaluateState(trial, newBasileusId) + titleAssignmentBias(state, newBasileusId, action)
        : -Infinity,
    };
  }).sort((left, right) => (
    (right.score - left.score)
    || left.action.id.localeCompare(right.action.id)
  ));
  return scored[0]?.action || null;
}

export function describeOrderDecision(state, playerId, scoredOrder) {
  const summary = scoredOrder?.summary || summarizeOrders(state, playerId, scoredOrder?.action?.orders || {});
  const candidate = getPlayer(state, summary.candidate);
  return [
    {
      label: 'projected score',
      value: Math.round(Number(scoredOrder?.score) || 0),
      impact: 'positive',
      note: 'Average evaluation over low, middle, and high invasion strength samples.',
    },
    {
      label: 'frontier',
      value: summary.frontierTroops,
      impact: summary.frontierTroops > 0 ? 'positive' : 'negative',
      note: 'Troops committed against the current invasion.',
    },
    {
      label: 'capital',
      value: summary.capitalTroops,
      impact: summary.capitalTroops > 0 ? 'positive' : 'neutral',
      note: `Capital support backs ${candidate?.firstName || candidate?.dynasty || `Player ${summary.candidate + 1}`}.`,
    },
  ];
}
