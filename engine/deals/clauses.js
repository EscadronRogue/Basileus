// engine/deals/clauses.js - clause normalisation, validation against the game state, and summaries.

import { getPlayerLabel } from '../state.js';
import { getReservedThemeIds, hasActiveAppointmentPromise, hasActiveNonRevocationPromise } from './obligations.js';
import {
  DEAL_CLAUSE_KINDS,
  DEAL_TRIGGER_TYPES,
  ensureDealState,
  fail,
  getDealParticipantIds,
  getSpendableGold,
  normalizePositiveInt,
  themeName,
  toInt,
} from './state.js';
import { buildTroopCommitmentPlan, collectTroopCommitmentGroups, getPlayerOrderChunks } from './troopLocks.js';

function normalizeStartTrigger(state, rawClause = {}) {
  const rawType = String(
    rawClause.startTriggerType
    || rawClause.startTrigger
    || rawClause.triggerType
    || DEAL_TRIGGER_TYPES.IMMEDIATE
  ).trim();
  if (!rawType || rawType === DEAL_TRIGGER_TYPES.IMMEDIATE) {
    return { ok: true, trigger: { type: DEAL_TRIGGER_TYPES.IMMEDIATE } };
  }
  if (rawType !== DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS) {
    return fail('Choose a valid deal trigger.');
  }
  const playerId = toInt(
    rawClause.triggerPlayerId ?? rawClause.startTriggerPlayerId ?? rawClause.playerId,
    null,
  );
  if (!Number.isInteger(playerId) || !state.players.some((player) => player.id === playerId)) {
    return fail('Choose which player must become Basileus before this clause activates.');
  }
  return {
    ok: true,
    trigger: {
      type: DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS,
      playerId,
    },
  };
}

function splitGoldInstallments(amount, turns) {
  const base = Math.floor(amount / turns);
  const remainder = amount % turns;
  return Array.from({ length: turns }, (_, index) => base + (index < remainder ? 1 : 0)).filter((value) => value > 0);
}

function normalizeClauseDirection(actorId, counterpartyId, rawClause = {}) {
  const direction = String(rawClause.direction || 'give').trim();
  if (direction === 'give') {
    return { giverId: actorId, receiverId: counterpartyId };
  }
  if (direction === 'ask') {
    return { giverId: counterpartyId, receiverId: actorId };
  }
  return null;
}

function normalizeDealClause(state, actorId, counterpartyId, rawClause = {}) {
  const kind = String(rawClause.kind || '').trim();
  if (!Object.values(DEAL_CLAUSE_KINDS).includes(kind)) {
    return fail('Choose a valid deal clause type.');
  }

  const direction = normalizeClauseDirection(actorId, counterpartyId, rawClause);
  if (!direction) return fail('Choose whether you give this clause or ask for it.');

  const triggerResult = normalizeStartTrigger(state, rawClause);
  if (!triggerResult.ok) return triggerResult;

  if (kind === DEAL_CLAUSE_KINDS.GOLD) {
    const amountResult = normalizePositiveInt(rawClause.amount, 'Gold amount');
    if (!amountResult.ok) return amountResult;
    const turnsResult = normalizePositiveInt(rawClause.durationTurns || rawClause.turns || 1, 'Gold turns');
    if (!turnsResult.ok) return turnsResult;
    if (amountResult.value < turnsResult.value) {
      return fail('Gold spread cannot use more turns than coins.');
    }
    const installments = splitGoldInstallments(amountResult.value, turnsResult.value);
    return {
      ok: true,
      clause: {
        kind,
        giverId: direction.giverId,
        receiverId: direction.receiverId,
        startTrigger: triggerResult.trigger,
        durationTurns: installments.length,
        payload: {
          totalAmount: amountResult.value,
          installments,
        },
      },
    };
  }

  if (kind === DEAL_CLAUSE_KINDS.ESTATE) {
    const themeId = String(rawClause.themeId || '').trim();
    if (!themeId || !state.themes?.[themeId]) {
      return fail('Choose a valid estate.');
    }
    const theme = state.themes[themeId];
    if (theme.owner !== direction.giverId) {
      return fail(`${getPlayerLabel(state, direction.giverId)} does not currently own ${themeName(state, themeId)}.`);
    }
    if (theme.owner == null) {
      return fail('Only private estates can be traded.');
    }
    return {
      ok: true,
      clause: {
        kind,
        giverId: direction.giverId,
        receiverId: direction.receiverId,
        startTrigger: triggerResult.trigger,
        durationTurns: 1,
        payload: {
          themeId,
        },
      },
    };
  }

  if (kind === DEAL_CLAUSE_KINDS.COUP_SUPPORT) {
    const troopResult = normalizePositiveInt(rawClause.troopCount, 'Coup support troops');
    if (!troopResult.ok) return troopResult;
    const turnsResult = normalizePositiveInt(rawClause.durationTurns || rawClause.turns || 1, 'Coup support turns');
    if (!turnsResult.ok) return turnsResult;
    const candidateId = toInt(rawClause.candidateId, null);
    if (!Number.isInteger(candidateId) || !state.players.some((player) => player.id === candidateId)) {
      return fail('Choose which claimant must receive the coup support.');
    }
    const maxCapitalTroops = getPlayerOrderChunks(state, direction.giverId).reduce((total, chunk) => total + chunk.troops, 0);
    if (troopResult.value > maxCapitalTroops) {
      return fail(`${getPlayerLabel(state, direction.giverId)} cannot currently promise ${troopResult.value} capital troop${troopResult.value === 1 ? '' : 's'}.`);
    }
    return {
      ok: true,
      clause: {
        kind,
        giverId: direction.giverId,
        receiverId: direction.receiverId,
        startTrigger: triggerResult.trigger,
        durationTurns: turnsResult.value,
        payload: {
          candidateId,
          troopCount: troopResult.value,
        },
      },
    };
  }

  if (kind === DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT) {
    const troopResult = normalizePositiveInt(rawClause.troopCount, 'Frontier support troops');
    if (!troopResult.ok) return troopResult;
    const turnsResult = normalizePositiveInt(rawClause.durationTurns || rawClause.turns || 1, 'Frontier support turns');
    if (!turnsResult.ok) return turnsResult;
    const maxFrontierTroops = getPlayerOrderChunks(state, direction.giverId)
      .filter((chunk) => !chunk.capitalOnly)
      .reduce((total, chunk) => total + chunk.troops, 0);
    if (troopResult.value > maxFrontierTroops) {
      return fail(`${getPlayerLabel(state, direction.giverId)} cannot currently promise ${troopResult.value} frontier troop${troopResult.value === 1 ? '' : 's'}.`);
    }
    return {
      ok: true,
      clause: {
        kind,
        giverId: direction.giverId,
        receiverId: direction.receiverId,
        startTrigger: triggerResult.trigger,
        durationTurns: turnsResult.value,
        payload: {
          troopCount: troopResult.value,
        },
      },
    };
  }

  if (kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE) {
    const countResult = normalizePositiveInt(rawClause.appointmentCount, 'Appointment count');
    if (!countResult.ok) return countResult;
    return {
      ok: true,
      clause: {
        kind,
        giverId: direction.giverId,
        receiverId: direction.receiverId,
        startTrigger: triggerResult.trigger,
        durationTurns: null,
        payload: {
          appointmentCount: countResult.value,
        },
      },
    };
  }

  if (kind === DEAL_CLAUSE_KINDS.NON_REVOCATION) {
    const turnsResult = normalizePositiveInt(rawClause.durationTurns || rawClause.turns || 1, 'Protection turns');
    if (!turnsResult.ok) return turnsResult;
    return {
      ok: true,
      clause: {
        kind,
        giverId: direction.giverId,
        receiverId: direction.receiverId,
        startTrigger: triggerResult.trigger,
        durationTurns: turnsResult.value,
        payload: {},
      },
    };
  }

  return fail('Choose a valid deal clause type.');
}

export function normalizeDealClauses(state, actorId, counterpartyId, rawClauses = []) {
  if (!Array.isArray(rawClauses) || rawClauses.length === 0) {
    return fail('Add at least one clause to the deal.');
  }

  const clauses = [];
  for (const rawClause of rawClauses) {
    const result = normalizeDealClause(state, actorId, counterpartyId, rawClause);
    if (!result.ok) return result;
    clauses.push(result.clause);
  }

  return { ok: true, clauses };
}

export function validateDealParticipants(state, actorId, counterpartyId) {
  ensureDealState(state);
  const eligibleIds = getDealParticipantIds(state);
  if (!eligibleIds.includes(actorId)) {
    return fail('You cannot start a formal deal right now.');
  }
  if (!eligibleIds.includes(counterpartyId)) {
    return fail('That dynasty cannot enter a formal deal right now.');
  }
  if (actorId === counterpartyId) {
    return fail('Choose another dynasty for this deal.');
  }
  return { ok: true };
}

export function validateDealClausesAgainstState(state, clauses, pairKey, options = {}) {
  const reservedThemes = getReservedThemeIds(state);
  const extraGoldReserved = new Map();
  const promisedAppointmentGivers = new Set();
  const promisedProtectionPairs = new Set();
  const troopPlanCache = options.troopPlanCache instanceof Map ? options.troopPlanCache : null;

  for (const clause of clauses) {
    if (clause.kind === DEAL_CLAUSE_KINDS.GOLD) {
      const totalAmount = Number(clause.payload.totalAmount) || 0;
      extraGoldReserved.set(
        clause.giverId,
        (extraGoldReserved.get(clause.giverId) || 0) + totalAmount,
      );
    }

    if (clause.kind === DEAL_CLAUSE_KINDS.ESTATE) {
      const themeId = clause.payload.themeId;
      if (reservedThemes.has(themeId)) {
        return fail(`${themeName(state, themeId)} is already reserved by another accepted deal.`);
      }
      reservedThemes.add(themeId);
      const theme = state.themes?.[themeId];
      if (!theme || theme.owner !== clause.giverId) {
        return fail(`${getPlayerLabel(state, clause.giverId)} no longer owns ${themeName(state, themeId)}.`);
      }
    }

    if (clause.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE) {
      if (promisedAppointmentGivers.has(clause.giverId)) {
        return fail(`${getPlayerLabel(state, clause.giverId)} cannot promise multiple overlapping appointment streams in the same deal.`);
      }
      if (hasActiveAppointmentPromise(state, clause.giverId)) {
        return fail(`${getPlayerLabel(state, clause.giverId)} already owes promised appointments under another active deal.`);
      }
      promisedAppointmentGivers.add(clause.giverId);
    }

    if (clause.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION) {
      const protectionKey = `${clause.giverId}:${clause.receiverId}`;
      if (promisedProtectionPairs.has(protectionKey)) {
        return fail(`${getPlayerLabel(state, clause.giverId)} cannot promise the same title protection twice in one deal.`);
      }
      if (hasActiveNonRevocationPromise(state, clause.giverId, clause.receiverId)) {
        return fail(`${getPlayerLabel(state, clause.giverId)} already owes title protection to ${getPlayerLabel(state, clause.receiverId)}.`);
      }
      promisedProtectionPairs.add(protectionKey);
    }
  }

  for (const [playerId, requiredGold] of extraGoldReserved.entries()) {
    if (getSpendableGold(state, playerId) < requiredGold) {
      return fail(`${getPlayerLabel(state, playerId)} does not currently have enough unreserved gold to guarantee this offer.`);
    }
  }

  const structuralTroopGroups = collectTroopCommitmentGroups(state, clauses);
  for (const group of structuralTroopGroups) {
    if (group.error) return fail(group.error);
    if (group.capitalRequired <= 0 && group.frontierRequired <= 0) continue;
    const cacheKey = `${group.playerId}:${group.capitalRequired}:${group.frontierRequired}`;
    let plan = troopPlanCache?.get(cacheKey);
    if (!plan) {
      plan = buildTroopCommitmentPlan(state, group.playerId, group.capitalRequired, group.frontierRequired);
      troopPlanCache?.set(cacheKey, plan);
    }
    if (!plan.ok) return plan;
  }

  return { ok: true, pairKey };
}

export function summarizeDealClause(state, clause, viewerId = null) {
  const youGive = viewerId != null && clause.giverId === viewerId;
  const youReceive = viewerId != null && clause.receiverId === viewerId;
  const actorText = youGive ? 'You give' : youReceive ? 'You receive' : `${getPlayerLabel(state, clause.giverId)} gives`;
  const targetText = youGive ? getPlayerLabel(state, clause.receiverId) : youReceive ? getPlayerLabel(state, clause.giverId) : getPlayerLabel(state, clause.receiverId);
  const triggerText = clause.startTrigger?.type === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS
    ? ` when ${getPlayerLabel(state, clause.startTrigger.playerId)} becomes Basileus`
    : '';

  if (clause.kind === DEAL_CLAUSE_KINDS.GOLD) {
    const total = Number(clause.payload.totalAmount) || 0;
    const turns = Number(clause.durationTurns) || 1;
    return turns > 1
      ? `${actorText} ${total} gold over ${turns} court phases to ${targetText}${triggerText}.`
      : `${actorText} ${total} gold to ${targetText}${triggerText}.`;
  }
  if (clause.kind === DEAL_CLAUSE_KINDS.ESTATE) {
    return `${actorText} ${themeName(state, clause.payload.themeId)} to ${targetText}${triggerText}.`;
  }
  if (clause.kind === DEAL_CLAUSE_KINDS.COUP_SUPPORT) {
    const turns = Number(clause.durationTurns) || 1;
    return `${actorText} ${clause.payload.troopCount} coup troop${clause.payload.troopCount === 1 ? '' : 's'} for ${getPlayerLabel(state, clause.payload.candidateId)} for ${turns} turn${turns === 1 ? '' : 's'}${triggerText}.`;
  }
  if (clause.kind === DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT) {
    const turns = Number(clause.durationTurns) || 1;
    return `${actorText} ${clause.payload.troopCount} frontier troop${clause.payload.troopCount === 1 ? '' : 's'} for ${turns} turn${turns === 1 ? '' : 's'}${triggerText}.`;
  }
  if (clause.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE) {
    return `${actorText} the next ${clause.payload.appointmentCount} legal appointment${clause.payload.appointmentCount === 1 ? '' : 's'} to ${targetText}${triggerText}.`;
  }
  if (clause.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION) {
    const turns = Number(clause.durationTurns) || 1;
    return `${getPlayerLabel(state, clause.giverId)} promises not to revoke ${getPlayerLabel(state, clause.receiverId)}'s posts or estates for ${turns} turn${turns === 1 ? '' : 's'}${triggerText}.`;
  }
  return clause.kind;
}

// Aggregate numeric snapshot of an offer from a viewer's perspective.
export function summarizeDealOfferImpact(clauses = [], viewerId = null) {
  const totals = {
    clauseCount: Array.isArray(clauses) ? clauses.length : 0,
    goldGiven: 0,
    goldReceived: 0,
    estatesGiven: 0,
    estatesReceived: 0,
    capitalTroopsPromised: 0,
    capitalTroopsRequested: 0,
    frontierTroopsPromised: 0,
    frontierTroopsRequested: 0,
    appointmentsGiven: 0,
    appointmentsReceived: 0,
    protectionTurnsGiven: 0,
    protectionTurnsReceived: 0,
    triggerThronebound: 0,
  };
  if (!Array.isArray(clauses)) return totals;
  for (const clause of clauses) {
    const youGive = viewerId != null && clause.giverId === viewerId;
    const youReceive = viewerId != null && clause.receiverId === viewerId;
    if (clause.startTrigger?.type === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS) {
      totals.triggerThronebound += 1;
    }
    switch (clause.kind) {
      case DEAL_CLAUSE_KINDS.GOLD: {
        const amount = Number(clause.payload?.totalAmount) || 0;
        if (youGive) totals.goldGiven += amount;
        if (youReceive) totals.goldReceived += amount;
        break;
      }
      case DEAL_CLAUSE_KINDS.ESTATE:
        if (youGive) totals.estatesGiven += 1;
        if (youReceive) totals.estatesReceived += 1;
        break;
      case DEAL_CLAUSE_KINDS.COUP_SUPPORT: {
        const troops = Number(clause.payload?.troopCount) || 0;
        if (youGive) totals.capitalTroopsPromised += troops;
        if (youReceive) totals.capitalTroopsRequested += troops;
        break;
      }
      case DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT: {
        const troops = Number(clause.payload?.troopCount) || 0;
        if (youGive) totals.frontierTroopsPromised += troops;
        if (youReceive) totals.frontierTroopsRequested += troops;
        break;
      }
      case DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE: {
        const count = Number(clause.payload?.appointmentCount) || 0;
        if (youGive) totals.appointmentsGiven += count;
        if (youReceive) totals.appointmentsReceived += count;
        break;
      }
      case DEAL_CLAUSE_KINDS.NON_REVOCATION: {
        const turns = Number(clause.durationTurns) || 0;
        if (youGive) totals.protectionTurnsGiven += turns;
        if (youReceive) totals.protectionTurnsReceived += turns;
        break;
      }
      default:
        break;
    }
  }
  return totals;
}
