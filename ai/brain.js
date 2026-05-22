import {
  applyLegalAction,
} from './legalActions.js';
import {
  loadOpponentByIdSync,
  loadOpponentRosterSync,
  mergeOpponentRosters,
  normalizeTunedOpponentRoster,
  TUNED_OPPONENT_ROSTER_URL,
} from './opponentRoster.js';
import {
  applyPolicyEstateActions,
  choosePolicyCourtAction,
  choosePolicyOrderAction,
  choosePolicyRewardChoice,
  choosePolicyTitleAssignment,
  describePolicyOrderChoice,
  normalizePolicyConfig,
} from './policies.js';

export const AI_OPPONENT_MISSING_MESSAGE = 'AI opponent not found.';
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
  return {
    ...loadOpponentByIdSync(rawOpponent.id || rawOpponent.opponentId || null, seatId),
    ...rawOpponent,
  };
}

export function hydrateAiOpponent(rawOpponent, seatId = 0) {
  return normalizeOpponent(rawOpponent, seatId);
}

function opponentDisplayName(opponent, fallback = 'AI Opponent') {
  return String(opponent?.firstName || opponent?.name || fallback).trim() || fallback;
}

function createPlayerMeta(player, humanPlayerIds, aiPlayer = null) {
  const isAI = !humanPlayerIds.has(player.id);
  const opponent = isAI
    ? normalizeOpponent(aiPlayer?.opponent || aiPlayer?.opponentId || aiPlayer?.id, player.id)
    : null;
  const displayName = aiPlayer?.displayName || aiPlayer?.firstName || opponentDisplayName(opponent);
  const policy = isAI
    ? normalizePolicyConfig(aiPlayer?.policy ?? opponent?.policy ?? {
      policyId: aiPlayer?.policyId || opponent?.policyId,
      strategyWeights: aiPlayer?.strategyWeights || aiPlayer?.weights || opponent?.strategyWeights || opponent?.weights,
    })
    : null;
  return {
    playerId: player.id,
    isAI,
    displayName: isAI ? displayName : null,
    opponent: isAI ? opponent : null,
    opponentId: isAI ? (opponent?.id || aiPlayer?.opponentId || null) : null,
    policyId: isAI ? policy.policyId : null,
    policyLabel: isAI ? policy.label : null,
    strategyWeights: isAI ? policy.strategyWeights : null,
    stats: {},
  };
}

export async function loadBrowserAiOpponentRoster(url = null, options = {}) {
  const required = Boolean(options.required);
  const remoteUrl = url || (options.remote ? DEFAULT_BROWSER_OPPONENT_ROSTER_URL : null);
  let tunedOpponents = [];
  if (!remoteUrl && typeof window !== 'undefined' && typeof fetch === 'function') {
    try {
      const response = await fetch(TUNED_OPPONENT_ROSTER_URL, { cache: 'no-store' });
      if (response.ok) tunedOpponents = normalizeTunedOpponentRoster(await response.json());
    } catch {
      tunedOpponents = [];
    }
  }
  if (remoteUrl && typeof fetch === 'function') {
    try {
      const response = await fetch(remoteUrl, { cache: 'no-store' });
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
  return mergeOpponentRosters(tunedOpponents, loadOpponentRosterSync());
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

export function runAICourtAutomation(state, meta, options = {}) {
  if (!state || state.phase !== 'court' || !meta) return { ok: true, actions: 0 };
  if ((options.mode || 'finish') === 'react') return { ok: true, actions: 0 };

  let applied = 0;
  for (const player of state.players || []) {
    if (!isAIPlayer(meta, player.id)) continue;
    let safety = 0;
    while (!state.courtActions?.playerConfirmed?.has(player.id) && safety < 8) {
      safety += 1;
      const action = choosePolicyCourtAction(state, meta, player.id);
      if (!action) break;
      const result = applyLegalAction(state, action, meta);
      if (!result.ok) break;
      applied += 1;
      meta?.decisionLog?.push?.(`court:${player.id}:${meta.players?.[player.id]?.policyId || 'strategic'}:${action.label || action.kind}`);
      if (action.kind === 'court-confirm' || action.payload?.action === 'skip') break;
    }
  }

  return { ok: true, actions: applied };
}

export function buildAIOrders(state, meta, playerId) {
  const action = choosePolicyOrderAction(state, meta, playerId);
  if (!action) throw new Error(`No legal order available for AI player ${playerId}.`);
  const playerMeta = meta?.players?.[playerId];
  return {
    ...action.orders,
    debug: {
      decision: {
        ...describePolicyOrderChoice(state, playerId, action),
        title: `${playerMeta?.displayName || 'AI'} ${playerMeta?.policyId || 'strategic'} order`,
      },
    },
  };
}

function cloneForOrderPlanning(state) {
  // structuredClone preserves Sets/Maps; the JSON fallback flattens them
  // so we rebuild the one Set the engine relies on. The RNG is a function
  // and never survives either clone path, so re-attach it explicitly.
  let clone;
  try {
    clone = structuredClone(state);
  } catch {
    clone = JSON.parse(JSON.stringify(state));
    if (state.courtActions) {
      clone.courtActions = {
        ...clone.courtActions,
        playerConfirmed: new Set([...(state.courtActions.playerConfirmed || new Set())]),
      };
    }
  }
  clone.rng = state.rng;
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

export function chooseAIDefenderRewardChoice(state, meta, reward) {
  return choosePolicyRewardChoice(state, meta, reward);
}

export function planMajorTitleAssignment(state, meta, newBasileusId = state?.nextBasileusId) {
  return choosePolicyTitleAssignment(state, meta, newBasileusId);
}

export function runAIEstateAutomation(state, meta, playerId) {
  if (!state || state.phase !== 'estates' || !meta || !isAIPlayer(meta, playerId)) return [];
  const actions = applyPolicyEstateActions(state, meta, playerId);
  for (const action of actions) {
    meta?.decisionLog?.push?.(`estates:${playerId}:${meta.players?.[playerId]?.policyId || 'strategic'}:${action.payload?.themeId || 'bid'}`);
  }
  return actions;
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
