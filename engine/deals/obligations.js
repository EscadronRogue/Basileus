// engine/deals/obligations.js - accepted obligations: gold reservations, estate transfers, promises, round hooks.

import { recordHistoryEvent } from '../history.js';
import { getPlayer, getPlayerLabel } from '../state.js';
import {
  DEAL_CLAUSE_KINDS,
  RECURRING_TROOP_KINDS,
  clonePlain,
  ensureDealState,
  fail,
  filterActiveObligations,
  isTriggerSatisfied,
  themeName,
} from './state.js';

function nextObligationId(state) {
  ensureDealState(state);
  state.dealObligationSeq = (Number(state.dealObligationSeq) || 0) + 1;
  return `deal-obligation-${state.dealObligationSeq}`;
}

export function getReservedThemeIds(state) {
  const reserved = new Set();
  for (const obligation of state.activeDealObligations || []) {
    if (obligation.status === 'completed') continue;
    if (obligation.kind !== DEAL_CLAUSE_KINDS.ESTATE) continue;
    if (obligation.payload?.themeId) reserved.add(obligation.payload.themeId);
  }
  return reserved;
}

export function hasActiveAppointmentPromise(state, giverId) {
  return (state.activeDealObligations || []).some((obligation) => (
    obligation.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE
    && obligation.status !== 'completed'
    && obligation.giverId === giverId
    && Number(obligation.remainingAppointments || 0) > 0
  ));
}

export function hasActiveNonRevocationPromise(state, giverId, receiverId) {
  return (state.activeDealObligations || []).some((obligation) => (
    obligation.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION
    && obligation.status !== 'completed'
    && obligation.giverId === giverId
    && obligation.receiverId === receiverId
  ));
}

function reserveGoldForClauses(state, clauses = []) {
  for (const clause of clauses) {
    if (clause.kind !== DEAL_CLAUSE_KINDS.GOLD) continue;
    state.reservedGold[clause.giverId] = (state.reservedGold[clause.giverId] || 0) + (Number(clause.payload.totalAmount) || 0);
  }
}

function releaseGoldReservation(state, giverId, amount) {
  if (!Number.isInteger(giverId)) return;
  const current = Number(state.reservedGold[giverId]) || 0;
  state.reservedGold[giverId] = Math.max(0, current - Math.max(0, Number(amount) || 0));
}

function recordPublicGoldTransfer(state, giverId, receiverId, amount) {
  recordHistoryEvent(state, {
    category: 'court',
    type: 'deal_gold_transfer',
    actorId: giverId,
    summary: `${getPlayerLabel(state, giverId)} transfers ${amount} gold to ${getPlayerLabel(state, receiverId)}.`,
    details: {
      giverId,
      giverName: getPlayerLabel(state, giverId),
      receiverId,
      receiverName: getPlayerLabel(state, receiverId),
      amount,
    },
  });
}

function recordPublicEstateTransfer(state, giverId, receiverId, themeId) {
  recordHistoryEvent(state, {
    category: 'court',
    type: 'deal_estate_transfer',
    actorId: giverId,
    summary: `${getPlayerLabel(state, giverId)} transfers ${themeName(state, themeId)} to ${getPlayerLabel(state, receiverId)}.`,
    details: {
      giverId,
      giverName: getPlayerLabel(state, giverId),
      receiverId,
      receiverName: getPlayerLabel(state, receiverId),
      themeId,
      themeName: themeName(state, themeId),
    },
  });
}

export function recordPublicObligationFailure(state, obligation, reason) {
  recordHistoryEvent(state, {
    category: 'court',
    type: 'deal_obligation_failed',
    actorId: obligation.giverId,
    summary: `${getPlayerLabel(state, obligation.giverId)} can no longer fulfill a deal obligation to ${getPlayerLabel(state, obligation.receiverId)}.`,
    details: {
      obligationId: obligation.id,
      threadId: obligation.threadId,
      giverId: obligation.giverId,
      giverName: getPlayerLabel(state, obligation.giverId),
      receiverId: obligation.receiverId,
      receiverName: getPlayerLabel(state, obligation.receiverId),
      kind: obligation.kind,
      reason,
    },
  });
}

function transferDealGold(state, giverId, receiverId, amount) {
  const giver = getPlayer(state, giverId);
  const receiver = getPlayer(state, receiverId);
  if (!giver || !receiver || amount <= 0) return;
  giver.gold -= amount;
  receiver.gold += amount;
  releaseGoldReservation(state, giverId, amount);
  recordPublicGoldTransfer(state, giverId, receiverId, amount);
}

function transferDealEstate(state, giverId, receiverId, themeId) {
  const theme = state.themes?.[themeId];
  if (!theme || theme.owner !== giverId) {
    return fail(`${getPlayerLabel(state, giverId)} no longer controls ${themeName(state, themeId)}.`);
  }
  theme.owner = receiverId;
  recordPublicEstateTransfer(state, giverId, receiverId, themeId);
  return { ok: true };
}

function markObligationCompleted(obligation) {
  obligation.status = 'completed';
  obligation.completedRound = obligation.completedRound || null;
}

function settleGoldObligationNow(state, obligation) {
  const installments = obligation.payload.installments || [];
  const index = Number(obligation.nextInstallmentIndex) || 0;
  const amount = Number(installments[index]) || 0;
  if (amount <= 0) {
    obligation.nextInstallmentIndex = index + 1;
    if (obligation.nextInstallmentIndex >= installments.length) {
      markObligationCompleted(obligation);
    }
    return { ok: true };
  }

  transferDealGold(state, obligation.giverId, obligation.receiverId, amount);
  obligation.nextInstallmentIndex = index + 1;
  obligation.remainingTurns = Math.max(0, (Number(obligation.remainingTurns) || installments.length) - 1);
  if (obligation.nextInstallmentIndex >= installments.length || obligation.remainingTurns <= 0) {
    markObligationCompleted(obligation);
  } else {
    obligation.nextDueRound = state.round + 1;
  }
  return { ok: true };
}

function activateObligation(state, obligation) {
  if (obligation.status !== 'dormant') return { ok: true };
  obligation.status = 'active';
  obligation.activatedRound = state.round;

  if (obligation.kind === DEAL_CLAUSE_KINDS.ESTATE) {
    const result = transferDealEstate(state, obligation.giverId, obligation.receiverId, obligation.payload.themeId);
    if (!result.ok) {
      obligation.status = 'completed';
      obligation.failedRound = state.round;
      obligation.failureReason = result.reason;
      recordPublicObligationFailure(state, obligation, result.reason);
      return { ok: true };
    }
    markObligationCompleted(obligation);
    return { ok: true };
  }

  if (obligation.kind === DEAL_CLAUSE_KINDS.GOLD) {
    obligation.nextDueRound = state.round;
    return settleGoldObligationNow(state, obligation);
  }

  if (RECURRING_TROOP_KINDS.has(obligation.kind)) {
    obligation.nextDueRound = state.round;
    return { ok: true };
  }

  if (obligation.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE) {
    obligation.remainingAppointments = Number(obligation.remainingAppointments) || Number(obligation.payload.appointmentCount) || 0;
    return { ok: true };
  }

  if (obligation.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION) {
    obligation.activeThroughRound = state.round + (Number(obligation.durationTurns) || 1) - 1;
    return { ok: true };
  }

  return { ok: true };
}

function createAcceptedObligation(state, thread, clause) {
  return {
    id: nextObligationId(state),
    threadId: thread.id,
    pairKey: thread.pairKey,
    giverId: clause.giverId,
    receiverId: clause.receiverId,
    kind: clause.kind,
    startTrigger: clonePlain(clause.startTrigger),
    durationTurns: clause.durationTurns,
    payload: clonePlain(clause.payload),
    status: isTriggerSatisfied(state, clause.startTrigger) ? 'active' : 'dormant',
    createdRound: state.round,
    activatedRound: isTriggerSatisfied(state, clause.startTrigger) ? state.round : null,
    nextDueRound: isTriggerSatisfied(state, clause.startTrigger) && RECURRING_TROOP_KINDS.has(clause.kind)
      ? state.round
      : (isTriggerSatisfied(state, clause.startTrigger) && clause.kind === DEAL_CLAUSE_KINDS.GOLD ? state.round : null),
    nextInstallmentIndex: 0,
    remainingTurns: Number(clause.durationTurns) || (Array.isArray(clause.payload.installments) ? clause.payload.installments.length : null),
    remainingAppointments: clause.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE
      ? Number(clause.payload.appointmentCount) || 0
      : null,
    activeThroughRound: clause.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION && isTriggerSatisfied(state, clause.startTrigger)
      ? state.round + (Number(clause.durationTurns) || 1) - 1
      : null,
  };
}

export function acceptOfferIntoObligations(state, thread, clauses) {
  reserveGoldForClauses(state, clauses);
  const created = [];
  for (const clause of clauses) {
    const obligation = createAcceptedObligation(state, thread, clause);
    if (obligation.kind === DEAL_CLAUSE_KINDS.ESTATE && obligation.status === 'active') {
      const result = transferDealEstate(state, obligation.giverId, obligation.receiverId, obligation.payload.themeId);
      if (!result.ok) return result;
      continue;
    }
    if (obligation.kind === DEAL_CLAUSE_KINDS.GOLD && obligation.status === 'active') {
      const result = settleGoldObligationNow(state, obligation);
      if (!result.ok) return result;
      if (obligation.status !== 'completed') created.push(obligation);
      continue;
    }
    if (obligation.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION && obligation.status === 'active') {
      obligation.activeThroughRound = state.round + (Number(obligation.durationTurns) || 1) - 1;
    }
    if (obligation.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE && obligation.status === 'active') {
      obligation.remainingAppointments = Number(obligation.payload.appointmentCount) || 0;
    }
    created.push(obligation);
  }
  state.activeDealObligations.push(...created.filter((entry) => entry.status !== 'completed'));
  return { ok: true };
}

export function isThemeReservedByDeal(state, themeId) {
  return getReservedThemeIds(state).has(themeId);
}

export function isPlayerProtectedFromRevocation(state, actorId, protectedPlayerId) {
  return (state.activeDealObligations || []).some((obligation) => (
    obligation.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION
    && obligation.status === 'active'
    && obligation.giverId === actorId
    && obligation.receiverId === protectedPlayerId
    && Number(state.round) <= Number(obligation.activeThroughRound || 0)
  ));
}

export function validateAppointmentPromiseChoice(state, appointerId, appointeeId) {
  const obligation = (state.activeDealObligations || []).find((entry) => (
    entry.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE
    && entry.status === 'active'
    && entry.giverId === appointerId
    && Number(entry.remainingAppointments || 0) > 0
  ));
  if (!obligation) return { ok: true };

  if (Number(appointeeId) !== Number(obligation.receiverId)) {
    return fail(`${getPlayerLabel(state, appointerId)} owes the next legal appointment to ${getPlayerLabel(state, obligation.receiverId)} under an accepted deal.`);
  }
  return { ok: true };
}

export function consumeAppointmentPromise(state, appointerId, appointeeId) {
  const obligation = (state.activeDealObligations || []).find((entry) => (
    entry.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE
    && entry.status === 'active'
    && entry.giverId === appointerId
    && Number(entry.remainingAppointments || 0) > 0
  ));
  if (!obligation) return;
  if (Number(obligation.receiverId) !== Number(appointeeId)) return;
  obligation.remainingAppointments = Math.max(0, (Number(obligation.remainingAppointments) || 0) - 1);
  if (obligation.remainingAppointments <= 0) {
    obligation.status = 'completed';
    filterActiveObligations(state);
  }
}

export function startCourtDealRound(state) {
  ensureDealState(state);
  filterActiveObligations(state);

  for (const obligation of state.activeDealObligations) {
    if (obligation.status === 'dormant' && isTriggerSatisfied(state, obligation.startTrigger)) {
      const activation = activateObligation(state, obligation);
      if (!activation.ok) return activation;
    }
  }

  for (const obligation of state.activeDealObligations) {
    if (obligation.kind !== DEAL_CLAUSE_KINDS.GOLD) continue;
    if (obligation.status !== 'active') continue;
    if (Number(obligation.nextDueRound) !== Number(state.round)) continue;
    const settlement = settleGoldObligationNow(state, obligation);
    if (!settlement.ok) return settlement;
  }

  filterActiveObligations(state);
  return { ok: true };
}

export function finalizeDealRound(state) {
  ensureDealState(state);
  for (const obligation of state.activeDealObligations) {
    if (!RECURRING_TROOP_KINDS.has(obligation.kind)) continue;
    if (obligation.status !== 'active') continue;
    if (Number(obligation.nextDueRound) !== Number(state.round)) continue;
    obligation.remainingTurns = Math.max(0, (Number(obligation.remainingTurns) || 0) - 1);
    if (obligation.remainingTurns <= 0) {
      obligation.status = 'completed';
      continue;
    }
    obligation.nextDueRound = state.round + 1;
  }
  filterActiveObligations(state);
}
