import {
  applyLegalAction,
  listLegalCourtActions,
  listLegalOrderActions,
  listLegalRewardActions,
  listLegalTitleAssignments,
} from './legalActions.js';
import {
  DEFAULT_HEURISTIC_ID,
  getHeuristicPersonality,
  personalityForSeat,
  selectHeuristicAction,
} from './heuristics.js';
import { loadOpponentRosterSync } from './opponentRoster.js';

export const AI_OPPONENT_MISSING_MESSAGE = 'Heuristic AI opponent not found.';
export const DEFAULT_BROWSER_OPPONENT_ROSTER_URL = '/api/ai-opponents';

function normalizeHumanPlayerIds(playerCount, humanPlayerIds = []) {
  return new Set(
    [...new Set(humanPlayerIds.map((value) => Number(value)))]
      .filter((value) => Number.isInteger(value) && value >= 0 && value < playerCount),
  );
}

function createDecisionLog() {
  return {
    lines: [],
    push(message) {
      this.lines.push(message);
    },
  };
}

function normalizeOpponent(rawOpponent, fallbackId = DEFAULT_HEURISTIC_ID) {
  if (!rawOpponent) return getHeuristicPersonality(fallbackId);
  if (typeof rawOpponent === 'string') return getHeuristicPersonality(rawOpponent);
  return getHeuristicPersonality(rawOpponent.id || rawOpponent.strategyId || rawOpponent.opponentId || fallbackId);
}

export function hydrateAiOpponent(rawOpponent) {
  return normalizeOpponent(rawOpponent);
}

function opponentDisplayName(opponent, fallback = 'Unnamed AI') {
  return String(opponent?.firstName || opponent?.name || fallback).trim() || fallback;
}

function createPlayerMeta(player, humanPlayerIds, aiPlayer = null) {
  const isAI = !humanPlayerIds.has(player.id);
  const opponent = isAI
    ? normalizeOpponent(
      aiPlayer?.opponent || aiPlayer?.strategy || aiPlayer?.strategyId || aiPlayer?.opponentId,
      personalityForSeat(player.id),
    )
    : null;
  const displayName = aiPlayer?.displayName || aiPlayer?.firstName || opponentDisplayName(opponent);
  return {
    playerId: player.id,
    isAI,
    displayName: isAI ? displayName : null,
    opponent: isAI ? opponent : null,
    opponentId: isAI ? (opponent?.id || aiPlayer?.opponentId || null) : null,
    strategyId: isAI ? (opponent?.id || DEFAULT_HEURISTIC_ID) : null,
    stats: {},
  };
}

export async function loadBrowserAiOpponentRoster(url = DEFAULT_BROWSER_OPPONENT_ROSTER_URL, options = {}) {
  const required = Boolean(options.required);
  if (typeof fetch === 'function') {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) {
        const payload = await response.json();
        if (Array.isArray(payload?.opponents)) return payload.opponents;
      } else if (required) {
        throw new Error(`Could not list AI opponents: HTTP ${response.status}.`);
      }
    } catch (error) {
      if (required) throw error;
    }
  }
  return loadOpponentRosterSync();
}

export function createAIMeta(state, options = {}) {
  const humanPlayerIds = normalizeHumanPlayerIds(state?.players?.length || 0, options.humanPlayerIds || []);
  const aiPlayers = options.aiPlayers || {};
  const players = {};
  for (const player of state?.players || []) {
    players[player.id] = createPlayerMeta(player, humanPlayerIds, aiPlayers[player.id] || aiPlayers[String(player.id)]);
  }

  return {
    humanPlayerIds,
    players,
    opponentAvailable: true,
    publicLog: [],
    decisionLog: createDecisionLog(),
  };
}

export function setAIMetaOpponent(meta, opponent) {
  if (!meta) return meta;
  for (const player of Object.values(meta.players || {})) {
    if (!player?.isAI) continue;
    player.opponent = normalizeOpponent(opponent, player.strategyId || DEFAULT_HEURISTIC_ID);
    player.opponentId = player.opponent?.id || player.opponentId;
    player.strategyId = player.opponent?.id || player.strategyId;
    player.displayName = opponentDisplayName(player.opponent, player.displayName);
  }
  return meta;
}

export function isAIPlayer(meta, playerId) {
  return Boolean(meta) && !meta.humanPlayerIds?.has(playerId);
}

export function invalidateRoundContext(meta) {
  if (!meta) return;
  meta.roundContext = null;
  meta.fastCache = null;
}

export function observeCourtAction(state, meta, observation = null) {
  if (!meta || !observation) return;
  const line = {
    round: state?.round || 0,
    phase: state?.phase || 'court',
    ...observation,
  };
  meta.publicLog.push(line);
  if (meta.publicLog.length > 80) meta.publicLog.splice(0, meta.publicLog.length - 80);
}

function getRng(state) {
  return typeof state?.rng === 'function' ? state.rng : Math.random;
}

function getPlayerOpponent(meta, playerId) {
  return meta?.players?.[playerId]?.opponent || getHeuristicPersonality(personalityForSeat(playerId));
}

function chooseHeuristicAction(state, meta, playerId, actions) {
  if (!actions.length) return null;
  const opponent = getPlayerOpponent(meta, playerId);
  const selection = selectHeuristicAction(opponent, state, playerId, actions, getRng(state));
  const action = actions[selection.index] || actions[0];
  meta?.decisionLog?.push?.(`${action.phase}:${playerId}:${opponent.id}:${action.label}:${selection.score.toFixed(2)}`);
  return action;
}

function confirmAction(actions) {
  return actions.find((action) => action.kind === 'court-confirm') || actions[actions.length - 1] || null;
}

function playableCourtActions(actions) {
  return actions.filter((action) => action.kind !== 'court-confirm');
}

export function runAICourtAutomation(state, meta, options = {}) {
  if (!state || state.phase !== 'court' || !meta) return { ok: true, actions: 0 };
  const mode = options.mode || 'finish';
  const maxActions = mode === 'react' ? 1 : Math.max(1, Number(options.maxActionsPerPlayer) || 10);
  let applied = 0;

  for (const player of state.players) {
    if (!isAIPlayer(meta, player.id)) continue;
    if (state.courtActions?.playerConfirmed?.has(player.id)) continue;

    for (let step = 0; step < maxActions; step += 1) {
      const actions = listLegalCourtActions(state, player.id, { includeDeals: false });
      if (!actions.length) break;
      const actionCandidates = mode === 'react' ? playableCourtActions(actions) : actions;
      const action = step === maxActions - 1 && mode !== 'react'
        ? confirmAction(actions)
        : chooseHeuristicAction(state, meta, player.id, actionCandidates.length ? actionCandidates : actions);
      if (!action) break;
      const result = applyLegalAction(state, action, meta);
      if (!result.ok) {
        const fallback = mode === 'react' ? null : confirmAction(actions);
        if (!fallback || fallback.id === action.id) break;
        const fallbackResult = applyLegalAction(state, fallback, meta);
        if (!fallbackResult.ok) break;
      }
      applied += 1;
      observeCourtAction(state, meta, {
        type: 'ai_action',
        actorId: player.id,
        action: action.label,
      });
      if (state.courtActions?.playerConfirmed?.has(player.id) || mode === 'react') break;
    }
  }

  return { ok: true, actions: applied };
}

export function buildAIOrders(state, meta, playerId) {
  const actions = listLegalOrderActions(state, playerId);
  const action = chooseHeuristicAction(state, meta, playerId, actions);
  if (!action) throw new Error(`No legal order action available for AI player ${playerId}.`);
  const opponent = getPlayerOpponent(meta, playerId);
  return {
    ...action.orders,
    debug: {
      decision: {
        title: `${opponent.firstName} heuristic order selection`,
        factors: [
          { label: 'strategy', value: opponent.label || opponent.id, impact: 'neutral', note: opponent.description },
          { label: 'candidate actions', value: actions.length, impact: 'neutral', note: 'Chosen from engine-legal orders.' },
        ],
      },
    },
  };
}

export function chooseAIDefenderRewardChoice(state, meta, reward) {
  const actions = listLegalRewardActions(state, reward.defenderId)
    .filter((action) => action.rewardId === reward.id);
  const action = chooseHeuristicAction(state, meta, reward.defenderId, actions);
  return action?.choice || 'empire';
}

export function planMajorTitleAssignment(state, meta, newBasileusId = state?.nextBasileusId) {
  const actions = listLegalTitleAssignments(state, newBasileusId);
  return chooseHeuristicAction(state, meta, newBasileusId, actions);
}

export function applyPlannedAiTitleAssignment(state, meta, pendingAssignment = null, newBasileusId = state?.nextBasileusId) {
  const action = pendingAssignment?.kind === 'title-assignment'
    ? pendingAssignment
    : pendingAssignment
      ? {
        kind: 'title-assignment',
        phase: 'resolution',
        playerId: newBasileusId,
        newBasileusId,
        assignments: pendingAssignment.assignments || pendingAssignment,
        label: 'assign major titles',
      }
      : null;
  if (!action) return null;
  const result = applyLegalAction(state, action, meta);
  if (!result.ok) throw new Error(result.reason || 'AI title assignment failed validation.');
  return null;
}

export function handlePostResolutionAI(state, meta, options = {}) {
  const newBasileusId = state?.nextBasileusId;
  const previousBasileusId = options.previousBasileusId;
  let plannedAssignment = null;
  if (
    newBasileusId != null
    && newBasileusId !== previousBasileusId
    && isAIPlayer(meta, newBasileusId)
  ) {
    plannedAssignment = planMajorTitleAssignment(state, meta, newBasileusId);
    if (plannedAssignment && options.autoApplyTitleAssignments) {
      applyPlannedAiTitleAssignment(state, meta, plannedAssignment, newBasileusId);
      plannedAssignment = null;
    }
  }
  return { plannedAssignment };
}

export function getRecentPublicLog(meta, limit = 10) {
  return (meta?.publicLog || []).slice(-limit);
}
