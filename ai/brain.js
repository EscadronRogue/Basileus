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
import {
  DEAL_CLAUSE_KINDS,
  getIncomingDealsForPlayer,
  getOutgoingDealsForPlayer,
  getSpendableGold,
  respondToDeal,
  sendDealOffer,
  summarizeDealOfferImpact,
} from '../engine/deals.js';

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

function ensureRelationBuckets(playerMeta) {
  if (!playerMeta) return null;
  if (!playerMeta.trust) playerMeta.trust = {};
  if (!playerMeta.grievance) playerMeta.grievance = {};
  if (!playerMeta.obligations) playerMeta.obligations = {};
  return playerMeta;
}

function addRelationValue(meta, subjectId, bucket, targetId, amount) {
  if (!meta || subjectId == null || targetId == null || subjectId === targetId) return;
  const subject = ensureRelationBuckets(meta.players?.[subjectId]);
  if (!subject) return;
  subject[bucket][targetId] = Math.max(-9, Math.min(9, (Number(subject[bucket][targetId]) || 0) + amount));
}

function observeRelations(meta, observation = null) {
  if (!meta || !observation) return;
  const actorId = Number(observation.actorId);
  if (!Number.isInteger(actorId)) return;
  if (observation.type === 'appointment') {
    const appointeeId = Number(observation.appointeeId);
    const previousHolderId = Number(observation.previousHolderId);
    const value = Math.max(0.4, Number(observation.value) || 1);
    if (Number.isInteger(appointeeId)) addRelationValue(meta, appointeeId, 'trust', actorId, value);
    if (Number.isInteger(previousHolderId) && previousHolderId !== appointeeId) {
      addRelationValue(meta, previousHolderId, 'grievance', actorId, value * 1.15);
    }
  }
  if (observation.type === 'revocation') {
    const targetPlayerId = Number(observation.targetPlayerId);
    if (Number.isInteger(targetPlayerId)) addRelationValue(meta, targetPlayerId, 'grievance', actorId, 1.6);
  }
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
  observeRelations(meta, line);
}

function getRng(state) {
  return typeof state?.rng === 'function' ? state.rng : Math.random;
}

function getPlayerOpponent(meta, playerId) {
  return meta?.players?.[playerId]?.opponent || getHeuristicPersonality(personalityForSeat(playerId));
}

function chooseHeuristicSelection(state, meta, playerId, actions, options = {}) {
  if (!actions.length) return null;
  const opponent = getPlayerOpponent(meta, playerId);
  const selection = selectHeuristicAction(opponent, state, playerId, actions, getRng(state), options);
  const action = actions[selection.index] || actions[0];
  meta?.decisionLog?.push?.(`${action.phase}:${playerId}:${opponent.id}:${action.label}:${selection.score.toFixed(2)}`);
  return { ...selection, action };
}

function chooseHeuristicAction(state, meta, playerId, actions, options = {}) {
  return chooseHeuristicSelection(state, meta, playerId, actions, options)?.action || null;
}

function confirmAction(actions) {
  return actions.find((action) => action.kind === 'court-confirm') || actions[actions.length - 1] || null;
}

function playableCourtActions(actions) {
  return actions.filter((action) => action.kind !== 'court-confirm');
}

function courtStopScoreFloor(step, state) {
  if (step <= 0) return -Infinity;
  const [low, high] = state?.currentInvasion?.strength || [0, 0];
  const invasionNeed = Math.max(0, ((Number(low) || 0) + (Number(high) || 0)) / 2);
  const dangerBias = invasionNeed >= 22 ? -1.25 : invasionNeed >= 16 ? -0.5 : 0;
  return 3.25 + step * 0.85 + dangerBias;
}

function shouldConfirmCourtInstead(state, selection, step, mode) {
  if (!selection?.action || mode === 'react') return false;
  if (selection.action.kind === 'court-confirm') return true;
  if (step >= 7 && selection.score < 12) return true;
  return selection.score < courtStopScoreFloor(step, state);
}

function scoreDealForAI(opponent, impact = {}) {
  const temperament = opponent?.temperament || {};
  const categoryWeights = opponent?.categoryWeights || {};
  const ambition = Number(temperament.ambition) || 1;
  const defense = Number(temperament.defense) || 1;
  const greed = Number(temperament.greed) || 1;
  const gold = Number(categoryWeights.gold) || 1;
  const estate = Number(categoryWeights.estate) || 1;
  return 0
    + (impact.goldReceived || 0) * (1.15 * gold + 0.45 * greed)
    - (impact.goldGiven || 0) * (0.95 * gold + 0.55 * Math.max(0.5, 1.5 - greed))
    + (impact.estatesReceived || 0) * (7 * estate)
    - (impact.estatesGiven || 0) * (8.5 * estate)
    + (impact.capitalTroopsRequested || 0) * (1.5 * ambition)
    - (impact.capitalTroopsPromised || 0) * (1.35 * ambition + 0.25 * defense)
    + (impact.frontierTroopsRequested || 0) * (1.35 * defense)
    - (impact.frontierTroopsPromised || 0) * (1.15 * defense)
    + (impact.appointmentsReceived || 0) * 3.5
    - (impact.appointmentsGiven || 0) * 4.5
    + (impact.protectionTurnsReceived || 0) * 1.2
    - (impact.protectionTurnsGiven || 0) * 0.8
    - (impact.triggerThronebound || 0) * 0.25;
}

function respondToIncomingAIDeals(state, meta, playerId) {
  const incoming = getIncomingDealsForPlayer(state, playerId);
  if (!incoming.length) return 0;
  const opponent = getPlayerOpponent(meta, playerId);
  let handled = 0;
  for (const thread of incoming) {
    const impact = summarizeDealOfferImpact(thread.currentOffer?.clauses || [], playerId);
    const score = scoreDealForAI(opponent, impact);
    const action = score > 1.25 ? 'accept' : 'refuse';
    const result = respondToDeal(state, playerId, {
      action,
      threadId: thread.id,
      expectedRevision: thread.revision,
    });
    if (!result.ok) continue;
    handled += 1;
    meta?.decisionLog?.push?.(`court:${playerId}:${opponent.id}:deal-${action}:${score.toFixed(2)}`);
    observeCourtAction(state, meta, {
      type: 'ai_action',
      actorId: playerId,
      action: `${action} deal`,
    });
  }
  return handled;
}

function openDealCountForPlayer(state, playerId) {
  return getIncomingDealsForPlayer(state, playerId).length + getOutgoingDealsForPlayer(state, playerId).length;
}

function candidateDealTargets(state, actorId) {
  return (state?.players || [])
    .filter((player) => player.id !== actorId)
    .filter((player) => !state.courtActions?.playerConfirmed?.has(player.id));
}

function relationNet(meta, subjectId, targetId) {
  const subject = ensureRelationBuckets(meta?.players?.[subjectId]);
  if (!subject) return 0;
  return (Number(subject.trust?.[targetId]) || 0) - (Number(subject.grievance?.[targetId]) || 0);
}

function maybeSendAIDealOffer(state, meta, playerId) {
  const playerMeta = meta?.players?.[playerId];
  if (!playerMeta || playerMeta.lastDealOfferRound === state.round) return 0;
  if (openDealCountForPlayer(state, playerId) > 0) return 0;
  const spendableGold = Math.max(0, getSpendableGold(state, playerId));
  if (spendableGold <= 0) return 0;

  const opponent = getPlayerOpponent(meta, playerId);
  const temperament = opponent?.temperament || {};
  const [low, high] = state?.currentInvasion?.strength || [0, 0];
  const invasionNeed = ((Number(low) || 0) + (Number(high) || 0)) / 2;
  const wantsFrontier = invasionNeed >= 16 && (Number(temperament.defense) || 1) >= 0.8;
  const wantsCoup = !wantsFrontier && (Number(temperament.ambition) || 1) >= 1.05;
  if (!wantsFrontier && !wantsCoup) return 0;

  const goldOffer = Math.min(spendableGold, wantsFrontier ? 2 : 3);
  const targets = candidateDealTargets(state, playerId)
    .sort((left, right) => (
      relationNet(meta, playerId, right.id) - relationNet(meta, playerId, left.id)
    ) || (left.id - right.id));
  for (const target of targets) {
    const clauses = wantsFrontier
      ? [
        { kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'give', amount: goldOffer, durationTurns: 1 },
        { kind: DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, direction: 'ask', troopCount: 1, durationTurns: 1 },
      ]
      : [
        { kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'give', amount: goldOffer, durationTurns: 1 },
        { kind: DEAL_CLAUSE_KINDS.COUP_SUPPORT, direction: 'ask', candidateId: playerId, troopCount: 1, durationTurns: 1 },
      ];
    const result = sendDealOffer(state, playerId, {
      counterpartyId: target.id,
      clauses,
    });
    if (!result.ok) continue;
    playerMeta.lastDealOfferRound = state.round;
    meta?.decisionLog?.push?.(`court:${playerId}:${opponent.id}:deal-send:${wantsFrontier ? 'frontier' : 'coup'}`);
    observeCourtAction(state, meta, {
      type: 'ai_action',
      actorId: playerId,
      action: wantsFrontier ? 'offer gold for frontier support' : 'offer gold for coup support',
    });
    return 1;
  }
  playerMeta.lastDealOfferRound = state.round;
  return 0;
}

export function runAICourtAutomation(state, meta, options = {}) {
  if (!state || state.phase !== 'court' || !meta) return { ok: true, actions: 0 };
  const mode = options.mode || 'finish';
  const maxActions = mode === 'react' ? 1 : Math.max(1, Number(options.maxActionsPerPlayer) || 10);
  let applied = 0;

  for (const player of state.players) {
    if (!isAIPlayer(meta, player.id)) continue;
    if (state.courtActions?.playerConfirmed?.has(player.id)) continue;

    const dealResponses = respondToIncomingAIDeals(state, meta, player.id);
    applied += dealResponses;
    if (dealResponses === 0) applied += maybeSendAIDealOffer(state, meta, player.id);

    for (let step = 0; step < maxActions; step += 1) {
      const actions = listLegalCourtActions(state, player.id, { includeDeals: false });
      if (!actions.length) break;
      const actionCandidates = mode === 'react' ? playableCourtActions(actions) : actions;
      const selection = chooseHeuristicSelection(
        state,
        meta,
        player.id,
        actionCandidates.length ? actionCandidates : actions,
        { searchDepth: mode === 'react' ? 1 : 2 },
      );
      const action = (step === maxActions - 1 && mode !== 'react') || shouldConfirmCourtInstead(state, selection, step, mode)
        ? confirmAction(actions)
        : selection?.action;
      if (!action) break;
      let appliedAction = action;
      let result = applyLegalAction(state, action, meta);
      if (!result.ok) {
        const fallback = mode === 'react' ? null : confirmAction(actions);
        if (!fallback || fallback.id === action.id) break;
        appliedAction = fallback;
        result = applyLegalAction(state, fallback, meta);
        if (!result.ok) break;
      }
      applied += 1;
      observeCourtAction(state, meta, result.observation || {
        type: 'ai_action',
        actorId: player.id,
        action: appliedAction.label,
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
