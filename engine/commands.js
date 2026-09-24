// engine/commands.js - shared command layer for UI, AI, and multiplayer.
import { recordHistoryEvent } from './history.js';
import { formatPlayerLabel, getPlayer, isDealsEnabled } from './state.js';
import {
  completeCourtPhase,
  confirmTitleRedistribution,
  submitOrders,
  toggleEstatesReady,
} from './turnflow.js';
import {
  acceptDealOffer,
  autoRefuseAwaitingDeals,
  counterDealOffer,
  isPlayerProtectedFromRevocation,
  refuseDealOffer,
  sendDealOffer,
} from './deals.js';
import {
  appointBishop,
  appointStrategos,
  autoConfirmFinishedCourtPlayer,
  canPlayerRevokeBishop,
  canPlayerRevokeStrategos,
  checkRevocationCurrentTurnAppointment,
  hasCourtActionUsed,
  markCourtActionUsed,
  passCourtPower,
  revokeEstates,
  revokeMinorTitle,
  validateMajorTitleAssignments,
  applyTitleRedistribution,
} from './actions.js';
import { normalizeHumanOrders } from './orders.js';
import { setEstatePlan } from './estates.js';

function fail(reason) {
  return { ok: false, reason };
}

function playerLabel(state, playerId) {
  const player = getPlayer(state, playerId);
  return formatPlayerLabel(player) || `Player ${Number(playerId) + 1}`;
}

export function applyCourtAction(state, playerId, payload = {}) {
  const action = String(payload.action || '').trim();

  if (action.startsWith('deal-') && !isDealsEnabled(state)) return fail('Deals are not available in this game.');
  if (action === 'deal-send') return sendDealOffer(state, playerId, payload);
  if (action === 'deal-counter') return counterDealOffer(state, playerId, payload);
  if (action === 'deal-accept') return acceptDealOffer(state, playerId, payload);
  if (action === 'deal-refuse') return refuseDealOffer(state, playerId, payload);

  if (state.phase !== 'court') return fail('Appointments and revocations are only possible in the Offices phase.');
  if (state.courtActions?.playerConfirmed?.has(playerId)) return fail('You already locked your offices this round.');

  if (action === 'skip') {
    return confirmCourt(state, playerId);
  }

  if (action === 'pass-court-power' || action === 'pass') {
    const result = passCourtPower(state, playerId, payload.powerKey);
    if (!result?.ok) return fail(result?.reason || 'Could not pass for that office.');
    autoConfirmFinishedCourtPlayer(state, playerId);
    return { ok: true };
  }

  if (action === 'appoint-strategos') {
    const appointeeId = Number(payload.appointeeId);
    const result = appointStrategos(state, playerId, String(payload.themeId || '').trim(), appointeeId);
    if (!result?.ok) return fail(result?.reason || 'Could not appoint that strategos.');
    autoConfirmFinishedCourtPlayer(state, playerId);
    return {
      ok: true,
      observation: { type: 'appointment', actorId: playerId, appointeeId, previousHolderId: null, value: 0.95 },
    };
  }

  if (action === 'appoint-bishop') {
    const appointeeId = Number(payload.appointeeId);
    const result = appointBishop(state, playerId, String(payload.themeId || '').trim(), appointeeId);
    if (!result?.ok) return fail(result?.reason || 'Could not appoint that bishop.');
    autoConfirmFinishedCourtPlayer(state, playerId);
    return {
      ok: true,
      observation: { type: 'appointment', actorId: playerId, appointeeId, previousHolderId: null, value: 1.0 },
    };
  }

  if (action === 'revoke') {
    const value = String(payload.value || '').trim();
    const parts = value.split(':');
    const kind = parts[0];

    let targetPlayerId = null;
    if (kind === 'minor') {
      const theme = state.themes[parts[1]];
      targetPlayerId = parts[2] === 'strategos' ? theme?.strategos ?? null : theme?.bishop ?? null;
      const sameTurn = checkRevocationCurrentTurnAppointment(state, value);
      if (!sameTurn.ok) return fail(sameTurn.reason);
      if (targetPlayerId != null && isPlayerProtectedFromRevocation(state, playerId, targetPlayerId)) {
        return fail(`${playerLabel(state, targetPlayerId)} is protected by an accepted non-revocation deal.`);
      }
      if (parts[2] === 'strategos' && !canPlayerRevokeStrategos(state, playerId, parts[1])) {
        return fail('Only the regional Domestic or Admiral can revoke this strategos.');
      }
      if (parts[2] === 'bishop' && !canPlayerRevokeBishop(state, playerId)) {
        return fail('Only the Patriarch can revoke bishops.');
      }
      const result = revokeMinorTitle(state, parts[1], parts[2], playerId);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that office.');
    } else if (kind === 'estates') {
      targetPlayerId = Number(parts[2]);
      if (Number.isInteger(targetPlayerId) && isPlayerProtectedFromRevocation(state, playerId, targetPlayerId)) {
        return fail(`${playerLabel(state, targetPlayerId)} is protected by an accepted non-revocation deal.`);
      }
      const result = revokeEstates(state, parts[1], targetPlayerId, playerId);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke those estates.');
    } else {
      return fail('Choose a valid revocation target.');
    }
    autoConfirmFinishedCourtPlayer(state, playerId);
    return { ok: true, observation: { type: 'revocation', actorId: playerId, targetPlayerId } };
  }

  return fail('Unknown office action.');
}

// Estates phase: the whole plan is sent at once ({ themeId: count }); it
// replaces the previous one and unlocks the dynasty if it had locked.
export function applyEstateAction(state, playerId, payload = {}) {
  if (state.phase !== 'estates') return fail('Estates can only be built during the Estates phase.');
  const action = String(payload.action || '').trim();
  if (action === 'plan') {
    const result = setEstatePlan(state, playerId, payload.plan || {});
    if (!result?.ok) return fail(result?.reason || 'Could not plan those estates.');
    if (state.estatesReady?.[playerId]) delete state.estatesReady[playerId];
    return { ok: true, count: result.count, cost: result.cost };
  }
  return fail('Unknown estate action.');
}

export function confirmCourt(state, playerId) {
  if (state.phase !== 'court') return fail('Offices can only be locked in the Offices phase.');
  if (state.courtActions?.playerConfirmed?.has(playerId)) return fail('You already locked your offices this round.');
  if (!hasCourtActionUsed(state, playerId)) markCourtActionUsed(state, playerId);
  state.courtActions.playerConfirmed.add(playerId);
  autoRefuseAwaitingDeals(state, playerId);
  recordHistoryEvent(state, {
    category: 'court',
    type: 'court_confirmed',
    actorId: playerId,
    actorAi: false,
    summary: `${playerLabel(state, playerId)} locks their offices for the round.`,
  });
  return { ok: true };
}

export function confirmEstates(state, playerId) {
  if (state.phase !== 'estates') return fail('Estates are not active.');
  return toggleEstatesReady(state, playerId);
}

export function submitHumanOrders(state, playerId, orders, options = {}) {
  if (state.phase !== 'deployment') return fail('Deployment orders cannot be submitted right now.');
  if (state.allOrders?.[playerId]) return fail('Your deployment is already locked.');
  const normalized = normalizeHumanOrders(state, playerId, orders, {
    ...options,
    resolveImpossibleLocks: options.resolveImpossibleLocks !== false,
  });
  if (!normalized.ok) return fail(normalized.reason || 'Invalid orders.');
  const result = submitOrders(state, playerId, normalized.orders);
  if (!result.ok) return result;
  return { ok: true, orders: normalized.orders, totalCost: normalized.totalCost };
}

// Returns one appointment observation per office so AI-aware callers can
// update their opponent models; the engine itself never talks to the AI.
export function applyManualTitleReassignment(state, basileusId, titleAssignments) {
  const validation = validateMajorTitleAssignments(state, basileusId, titleAssignments);
  if (!validation?.ok) return validation || fail('Hand out every major office.');
  const previousAssignments = {};
  for (const player of state.players) {
    for (const titleKey of player.majorTitles) previousAssignments[titleKey] = player.id;
  }
  const result = state.phase === 'title_redistribution'
    ? confirmTitleRedistribution(state, basileusId, titleAssignments)
    : applyTitleRedistribution(state, basileusId, titleAssignments);
  if (!result.ok) return result;

  const observations = Object.entries(titleAssignments).map(([titleKey, appointeeId]) => ({
    type: 'appointment',
    actorId: basileusId,
    appointeeId: Number(appointeeId),
    previousHolderId: previousAssignments[titleKey] ?? null,
    value: 1.25,
  }));
  return { ok: true, observations };
}

export function advanceFromCourtToEstates(state) {
  if (state.phase !== 'court') return fail('The Offices phase is not active.');
  completeCourtPhase(state);
  return { ok: true };
}
