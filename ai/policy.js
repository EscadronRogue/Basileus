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

const COURT_SEARCH_DEPTH = 3;
const COURT_BRANCH_LIMIT = 8;
const COURT_PREFILTER_LIMIT = 16;
const COURT_MIN_GAIN = 0.75;
const COURT_MAX_ACTIONS = 3;
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

export function chooseAICourtActions(state, playerId, options = {}) {
  const maxActions = Math.max(0, Number(options.maxActions) || COURT_MAX_ACTIONS);
  const candidateCount = getCourtCandidateActions(state, playerId).length;
  const adaptiveDepth = candidateCount > 90 ? 2 : COURT_SEARCH_DEPTH;
  const depth = Math.max(1, Number(options.depth) || adaptiveDepth);
  const result = searchCourt(state, playerId, depth);
  return result.actions.slice(0, maxActions);
}

function orderShapeScore(state, playerId, action, options = {}) {
  const orders = action?.orders || {};
  const summary = summarizeOrders(state, playerId, orders);
  const leaderId = getLeadingOpponentId(state, playerId);
  const averageStrength = getAverageInvasionStrength(state);
  const fairShare = averageStrength > 0 ? averageStrength / Math.max(1, state.players.length) : 0;
  const frontierFit = fairShare > 0
    ? -Math.abs(summary.frontierTroops - fairShare) * 1.4
    : 0;
  const frontierContribution = Math.min(summary.frontierTroops, fairShare || summary.frontierTroops) * 1.2;
  let candidateScore = 0;

  if (summary.candidate === playerId) candidateScore += summary.capitalTroops * 1.4 + 8;
  else if (summary.candidate === state.basileusId) candidateScore += summary.capitalTroops * 0.25 + 3;
  else candidateScore += summary.capitalTroops * 0.45;

  if (summary.candidate === leaderId) candidateScore -= summary.capitalTroops * 1.2 + 8;
  if (options.projectedOpponent && summary.candidate === playerId) candidateScore += 3;

  return frontierFit + frontierContribution + candidateScore;
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
      || (right.summary.frontierTroops - left.summary.frontierTroops)
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
