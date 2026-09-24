// engine/deals/state.js - deal constants, per-game deal state, and shared helpers.

import { getPlayer } from '../state.js';

export const DEAL_THREAD_STATUS = {
  OPEN: 'open',
  ACCEPTED: 'accepted',
  REFUSED: 'refused',
};

export const DEAL_TRIGGER_TYPES = {
  IMMEDIATE: 'immediate',
  WHEN_PLAYER_IS_BASILEUS: 'when_player_is_basileus',
};

export const DEAL_CLAUSE_KINDS = {
  GOLD: 'gold',
  ESTATE: 'estate',
  COUP_SUPPORT: 'coup_support',
  FRONTIER_SUPPORT: 'frontier_support',
  APPOINTMENT_PROMISE: 'appointment_promise',
  NON_REVOCATION: 'non_revocation',
};

export const TROOP_CLAUSE_KINDS = new Set([
  DEAL_CLAUSE_KINDS.COUP_SUPPORT,
  DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT,
]);

export const RECURRING_TROOP_KINDS = new Set(TROOP_CLAUSE_KINDS);
export function clonePlain(value) {
  if (value == null) return value;
  // structuredClone preserves Sets/Maps/Dates; JSON-stringify silently
  // flattens them. Fall back to JSON only if structuredClone refuses.
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

export function toInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

export function themeName(state, themeId) {
  return state?.themes?.[themeId]?.name || themeId;
}

export function uniqueInts(values = []) {
  return [...new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value))
  )].sort((left, right) => left - right);
}

export function normalizePositiveInt(value, fieldLabel) {
  const normalized = toInt(value, null);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return fail(`${fieldLabel} must be a positive number.`);
  }
  return { ok: true, value: normalized };
}

export function getTriggerKey(trigger) {
  if (!trigger || trigger.type === DEAL_TRIGGER_TYPES.IMMEDIATE) return DEAL_TRIGGER_TYPES.IMMEDIATE;
  if (trigger.type === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS) {
    return `${DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS}:${Number(trigger.playerId)}`;
  }
  return String(trigger.type || DEAL_TRIGGER_TYPES.IMMEDIATE);
}

export function isTriggerSatisfied(state, startTrigger = null) {
  if (!startTrigger || startTrigger.type === DEAL_TRIGGER_TYPES.IMMEDIATE) return true;
  if (startTrigger.type === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS) {
    return Number(startTrigger.playerId) === Number(state.basileusId);
  }
  return false;
}

export function filterActiveObligations(state) {
  state.activeDealObligations = (state.activeDealObligations || []).filter((obligation) => {
    if (obligation.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION && obligation.status === 'active') {
      if ((Number(obligation.activeThroughRound) || 0) < Number(state.round)) {
        obligation.status = 'completed';
      }
    }
    if (obligation.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE && obligation.status !== 'completed') {
      if ((Number(obligation.remainingAppointments) || 0) <= 0) {
        obligation.status = 'completed';
      }
    }
    return obligation.status !== 'completed';
  });
}

export function ensureDealState(state) {
  if (!state) return state;
  if (!Array.isArray(state.dealThreads)) state.dealThreads = [];
  if (!Array.isArray(state.activeDealObligations)) state.activeDealObligations = [];
  if (!state.reservedGold || typeof state.reservedGold !== 'object') state.reservedGold = {};
  if (!Array.isArray(state.dealParticipantIds)) state.dealParticipantIds = [];
  if (!Number.isInteger(state.dealThreadSeq)) state.dealThreadSeq = 0;
  if (!Number.isInteger(state.dealObligationSeq)) state.dealObligationSeq = 0;
  return state;
}

export function setDealParticipantIds(state, playerIds = []) {
  ensureDealState(state);
  state.dealParticipantIds = uniqueInts(playerIds).filter((playerId) => state.players.some((player) => player.id === playerId));
}

export function getDealParticipantIds(state) {
  ensureDealState(state);
  return state.dealParticipantIds.slice();
}

export function getSpendableGold(state, playerId) {
  ensureDealState(state);
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  return player.gold - (Number(state.reservedGold?.[playerId]) || 0);
}
