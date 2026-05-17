import {
  applyLegalAction,
  listLegalCourtActions,
  listLegalOrderActions,
  listLegalRewardActions,
  listLegalTitleAssignments,
} from './legalActions.js';
import { loadOpponentByIdSync, loadOpponentRosterSync } from './opponentRoster.js';
import {
  chooseAICourtActions,
  chooseAIDefenderRewardChoice as choosePolicyDefenderRewardChoice,
  chooseAIOrderAction,
  chooseAITitleAssignment,
  describeOrderDecision,
} from './policy.js';

export const AI_OPPONENT_MISSING_MESSAGE = 'AI placeholder opponent not found.';
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

function normalizeOpponent(rawOpponent, seatId = 0) {
  if (!rawOpponent) return loadOpponentByIdSync(null, seatId);
  if (typeof rawOpponent === 'string') return loadOpponentByIdSync(rawOpponent, seatId);
  return loadOpponentByIdSync(rawOpponent.id || rawOpponent.opponentId || null, seatId);
}

export function hydrateAiOpponent(rawOpponent, seatId = 0) {
  return normalizeOpponent(rawOpponent, seatId);
}

function opponentDisplayName(opponent, fallback = 'AI Placeholder') {
  return String(opponent?.firstName || opponent?.name || fallback).trim() || fallback;
}

function createPlayerMeta(player, humanPlayerIds, aiPlayer = null) {
  const isAI = !humanPlayerIds.has(player.id);
  const opponent = isAI
    ? normalizeOpponent(aiPlayer?.opponent || aiPlayer?.opponentId || aiPlayer?.id, player.id)
    : null;
  const displayName = aiPlayer?.displayName || aiPlayer?.firstName || opponentDisplayName(opponent);
  return {
    playerId: player.id,
    isAI,
    displayName: isAI ? displayName : null,
    opponent: isAI ? opponent : null,
    opponentId: isAI ? (opponent?.id || aiPlayer?.opponentId || null) : null,
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
        throw new Error(`Could not list AI placeholders: HTTP ${response.status}.`);
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
    placeholderOnly: false,
    publicLog: [],
    decisionLog: createDecisionLog(),
  };
}

export function setAIMetaOpponent(meta, opponent) {
  if (!meta) return meta;
  for (const player of Object.values(meta.players || {})) {
    if (!player?.isAI) continue;
    player.opponent = normalizeOpponent(opponent, player.playerId);
    player.opponentId = player.opponent?.id || player.opponentId;
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

function chooseCourtConfirmation(state, playerId) {
  return listLegalCourtActions(state, playerId, { includeDeals: false })
    .find((action) => action.kind === 'court-confirm') || null;
}

export function runAICourtAutomation(state, meta, options = {}) {
  if (!state || state.phase !== 'court' || !meta) return { ok: true, actions: 0 };
  const mode = options.mode || 'finish';
  const shouldConfirm = mode !== 'react';

  let applied = 0;
  for (const player of state.players || []) {
    if (!isAIPlayer(meta, player.id)) continue;
    if (state.courtActions?.playerConfirmed?.has(player.id)) continue;

    const plannedActions = chooseAICourtActions(state, player.id, {
      maxActions: options.maxActions || (shouldConfirm ? 3 : 1),
      depth: options.depth,
    });
    for (const action of plannedActions) {
      if (state.courtActions?.playerConfirmed?.has(player.id)) break;
      const result = applyLegalAction(state, action, meta);
      if (!result.ok) continue;
      applied += 1;
      meta?.decisionLog?.push?.(`court:${player.id}:ai:${action.label || action.kind}`);
    }

    if (!shouldConfirm) continue;
    const action = chooseCourtConfirmation(state, player.id);
    const result = applyLegalAction(state, action, meta);
    if (!result.ok) continue;
    applied += 1;
    meta?.decisionLog?.push?.(`court:${player.id}:ai:confirm`);
  }

  return { ok: true, actions: applied };
}

function choosePlaceholderOrderAction(state, playerId, actions) {
  if (!actions.length) return null;
  if (state.basileusId != null) {
    const incumbent = actions.find((action) => action.orders?.candidate === state.basileusId);
    if (incumbent) return incumbent;
  }
  return actions[0];
}

export function buildAIOrders(state, meta, playerId) {
  const actions = listLegalOrderActions(state, playerId);
  const chosen = chooseAIOrderAction(state, playerId);
  const action = chosen?.action || choosePlaceholderOrderAction(state, playerId, actions);
  if (!action) throw new Error(`No legal AI order available for AI player ${playerId}.`);
  const playerMeta = meta?.players?.[playerId];
  return {
    ...action.orders,
    debug: {
      decision: {
        title: `${playerMeta?.displayName || 'AI'} strategic order`,
        factors: [
          ...describeOrderDecision(state, playerId, chosen || { action }),
          {
            label: 'candidate actions',
            value: actions.length,
            impact: 'neutral',
            note: 'Chosen from engine-legal orders without reading hidden human orders.',
          },
        ],
      },
    },
  };
}

function cloneForOrderPlanning(state) {
  const clone = JSON.parse(JSON.stringify(state));
  clone.rng = state.rng;
  if (state.courtActions) {
    clone.courtActions = {
      ...clone.courtActions,
      playerConfirmed: new Set([...(state.courtActions.playerConfirmed || new Set())]),
    };
  }
  clone.allOrders = {};
  return clone;
}

export function buildSimultaneousAIOrders(state, meta) {
  const planningState = cloneForOrderPlanning(state);
  const plans = [];
  for (const player of state?.players || []) {
    if (!isAIPlayer(meta, player.id)) continue;
    if (state.allOrders?.[player.id]) continue;
    plans.push({
      playerId: player.id,
      orders: buildAIOrders(planningState, meta, player.id),
    });
  }
  return plans;
}

export function chooseAIDefenderRewardChoice(state, meta, reward = null) {
  void meta;
  if (!reward) return 'empire';
  return choosePolicyDefenderRewardChoice(state, reward.defenderId, reward);
}

export function planMajorTitleAssignment(state, meta, newBasileusId = state?.nextBasileusId) {
  void meta;
  return chooseAITitleAssignment(state, newBasileusId)
    || listLegalTitleAssignments(state, newBasileusId)[0]
    || null;
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
  if (!result.ok) throw new Error(result.reason || 'AI placeholder title assignment failed validation.');
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
