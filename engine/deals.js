import { recordHistoryEvent } from './history.js';
import {
  formatPlayerLabel,
  getOfficeDisplayName,
  getPlayer,
  getPlayerMercenaryTroops,
  MERCENARY_COMPANY_KEY,
} from './state.js';

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

const TROOP_CLAUSE_KINDS = new Set([
  DEAL_CLAUSE_KINDS.COUP_SUPPORT,
  DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT,
]);

const RECURRING_TROOP_KINDS = new Set(TROOP_CLAUSE_KINDS);
const CAPITAL_LOCKED_OFFICES = new Set(['EMPRESS', 'PATRIARCH', 'CHIEF_EUNUCHS']);

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function playerName(state, playerId) {
  const player = getPlayer(state, playerId);
  return player ? formatPlayerLabel(player) : `Player ${Number(playerId) + 1}`;
}

function themeName(state, themeId) {
  return state?.themes?.[themeId]?.name || themeId;
}

function uniqueInts(values = []) {
  return [...new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value))
  )].sort((left, right) => left - right);
}

function normalizePositiveInt(value, fieldLabel) {
  const normalized = toInt(value, null);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return fail(`${fieldLabel} must be a positive number.`);
  }
  return { ok: true, value: normalized };
}

function makePairKey(playerAId, playerBId) {
  return [Number(playerAId), Number(playerBId)].sort((left, right) => left - right).join(':');
}

function getThreadByPairKey(state, pairKey) {
  ensureDealState(state);
  return state.dealThreads.find((thread) => thread.pairKey === pairKey) || null;
}

function getThreadById(state, threadId) {
  ensureDealState(state);
  return state.dealThreads.find((thread) => thread.id === threadId) || null;
}

function nextThreadId(state) {
  ensureDealState(state);
  state.dealThreadSeq = (Number(state.dealThreadSeq) || 0) + 1;
  return `deal-thread-${state.dealThreadSeq}`;
}

function nextObligationId(state) {
  ensureDealState(state);
  state.dealObligationSeq = (Number(state.dealObligationSeq) || 0) + 1;
  return `deal-obligation-${state.dealObligationSeq}`;
}

function nextRevision(thread) {
  return Math.max(0, Number(thread?.revision) || 0) + 1;
}

function buildThreadHistoryEntry(state, type, actorId, revision, offer = null, extra = {}) {
  return {
    type,
    actorId,
    actorName: playerName(state, actorId),
    revision,
    round: state.round,
    phase: state.phase,
    offer: offer ? clonePlain(offer) : null,
    ...clonePlain(extra),
  };
}

function getTriggerKey(trigger) {
  if (!trigger || trigger.type === DEAL_TRIGGER_TYPES.IMMEDIATE) return DEAL_TRIGGER_TYPES.IMMEDIATE;
  if (trigger.type === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS) {
    return `${DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS}:${Number(trigger.playerId)}`;
  }
  return String(trigger.type || DEAL_TRIGGER_TYPES.IMMEDIATE);
}

function isTriggerSatisfied(state, startTrigger = null) {
  if (!startTrigger || startTrigger.type === DEAL_TRIGGER_TYPES.IMMEDIATE) return true;
  if (startTrigger.type === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS) {
    return Number(startTrigger.playerId) === Number(state.basileusId);
  }
  return false;
}

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

function getPlayerOrderChunks(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return [];

  const officeKeys = new Set();
  if (playerId === state.basileusId) officeKeys.add('BASILEUS');
  for (const titleKey of player.majorTitles || []) officeKeys.add(titleKey);
  if (state.empress === playerId) officeKeys.add('EMPRESS');
  if (state.chiefEunuchs === playerId) officeKeys.add('CHIEF_EUNUCHS');
  for (const theme of Object.values(state.themes || {})) {
    if (theme.strategos === playerId && !theme.occupied) {
      officeKeys.add(`STRAT_${theme.id}`);
    }
  }
  if (getPlayerMercenaryTroops(state, playerId) > 0) {
    officeKeys.add(MERCENARY_COMPANY_KEY);
  }

  return [...officeKeys]
    .map((officeKey) => {
      const professionals = officeKey === MERCENARY_COMPANY_KEY ? 0 : (player.professionalArmies?.[officeKey] || 0);
      const levies = officeKey === MERCENARY_COMPANY_KEY ? 0 : (state.currentLevies?.[officeKey] || 0);
      const mercenaries = officeKey === MERCENARY_COMPANY_KEY ? getPlayerMercenaryTroops(state, playerId) : 0;
      const troops = professionals + levies + mercenaries;
      return {
        officeKey,
        officeName: getOfficeDisplayName(state, officeKey),
        troops,
        capitalOnly: CAPITAL_LOCKED_OFFICES.has(officeKey),
      };
    })
    .filter((chunk) => chunk.troops > 0)
    .sort((left, right) => left.officeKey.localeCompare(right.officeKey));
}

function comparePlanKeys(leftKeys = [], rightKeys = []) {
  const left = leftKeys.join(',');
  const right = rightKeys.join(',');
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function buildTroopCommitmentPlan(state, playerId, capitalRequired, frontierRequired) {
  const chunks = getPlayerOrderChunks(state, playerId);
  const requiredCapital = Math.max(0, Number(capitalRequired) || 0);
  const requiredFrontier = Math.max(0, Number(frontierRequired) || 0);
  if (requiredCapital === 0 && requiredFrontier === 0) {
    return {
      ok: true,
      capitalCommitted: 0,
      frontierCommitted: 0,
      capitalOffices: [],
      frontierOffices: [],
      chunks: [],
    };
  }

  let best = null;

  function consider(frontierOffices, capitalOffices, frontierCommitted, capitalCommitted) {
    if (frontierCommitted < requiredFrontier || capitalCommitted < requiredCapital) return;
    const overshoot = (frontierCommitted - requiredFrontier) + (capitalCommitted - requiredCapital);
    const totalCommitted = frontierCommitted + capitalCommitted;
    const officeCount = frontierOffices.length + capitalOffices.length;
    const frontierKeys = frontierOffices.map((entry) => entry.officeKey);
    const capitalKeys = capitalOffices.map((entry) => entry.officeKey);
    const candidate = {
      overshoot,
      totalCommitted,
      officeCount,
      frontierCommitted,
      capitalCommitted,
      frontierOffices: frontierOffices.slice(),
      capitalOffices: capitalOffices.slice(),
      key: `${frontierKeys.join(',')}|${capitalKeys.join(',')}`,
    };
    if (!best) {
      best = candidate;
      return;
    }
    if (candidate.overshoot !== best.overshoot) {
      if (candidate.overshoot < best.overshoot) best = candidate;
      return;
    }
    if (candidate.totalCommitted !== best.totalCommitted) {
      if (candidate.totalCommitted < best.totalCommitted) best = candidate;
      return;
    }
    if (candidate.officeCount !== best.officeCount) {
      if (candidate.officeCount < best.officeCount) best = candidate;
      return;
    }
    const frontierCmp = comparePlanKeys(frontierKeys, best.frontierOffices.map((entry) => entry.officeKey));
    if (frontierCmp !== 0) {
      if (frontierCmp < 0) best = candidate;
      return;
    }
    const capitalCmp = comparePlanKeys(capitalKeys, best.capitalOffices.map((entry) => entry.officeKey));
    if (capitalCmp < 0) best = candidate;
  }

  function walk(index, frontierOffices, capitalOffices, frontierCommitted, capitalCommitted) {
    if (index >= chunks.length) {
      consider(frontierOffices, capitalOffices, frontierCommitted, capitalCommitted);
      return;
    }

    const chunk = chunks[index];
    walk(index + 1, frontierOffices, capitalOffices, frontierCommitted, capitalCommitted);

    capitalOffices.push(chunk);
    walk(index + 1, frontierOffices, capitalOffices, frontierCommitted, capitalCommitted + chunk.troops);
    capitalOffices.pop();

    if (!chunk.capitalOnly) {
      frontierOffices.push(chunk);
      walk(index + 1, frontierOffices, capitalOffices, frontierCommitted + chunk.troops, capitalCommitted);
      frontierOffices.pop();
    }
  }

  walk(0, [], [], 0, 0);

  if (!best) {
    return fail(`${playerName(state, playerId)} cannot cover ${requiredCapital} capital troop${requiredCapital === 1 ? '' : 's'} and ${requiredFrontier} frontier troop${requiredFrontier === 1 ? '' : 's'} with the current office layout.`);
  }

  return {
    ok: true,
    capitalCommitted: best.capitalCommitted,
    frontierCommitted: best.frontierCommitted,
    capitalOffices: best.capitalOffices,
    frontierOffices: best.frontierOffices,
    chunks,
  };
}

function summarizeLocks(state, playerId, candidateId, capitalRequired, frontierRequired, plan, sources) {
  const committedOfficeKeys = {};
  const officeSelections = [];
  for (const office of plan.frontierOffices || []) {
    committedOfficeKeys[office.officeKey] = 'frontier';
    officeSelections.push({
      officeKey: office.officeKey,
      officeName: office.officeName,
      troops: office.troops,
      destination: 'frontier',
    });
  }
  for (const office of plan.capitalOffices || []) {
    committedOfficeKeys[office.officeKey] = 'capital';
    officeSelections.push({
      officeKey: office.officeKey,
      officeName: office.officeName,
      troops: office.troops,
      destination: 'capital',
    });
  }
  officeSelections.sort((left, right) => left.officeKey.localeCompare(right.officeKey));

  return {
    ok: true,
    playerId,
    candidateId,
    candidateName: candidateId == null ? null : playerName(state, candidateId),
    capitalRequired,
    frontierRequired,
    capitalCommitted: plan.capitalCommitted,
    frontierCommitted: plan.frontierCommitted,
    committedOfficeKeys,
    officeSelections,
    sources: clonePlain(sources),
  };
}

function buildDueTroopRequirements(state, playerId, extraClauses = []) {
  ensureDealState(state);
  let candidateId = null;
  let capitalRequired = 0;
  let frontierRequired = 0;
  const sources = [];

  const pushTroopRequirement = (entry, origin) => {
    if (entry.kind === DEAL_CLAUSE_KINDS.COUP_SUPPORT) {
      const nextCandidateId = Number(entry.payload.candidateId);
      if (candidateId != null && candidateId !== nextCandidateId) {
        return fail(`${playerName(state, playerId)} already owes coup support to another claimant in the same trigger window.`);
      }
      candidateId = nextCandidateId;
      capitalRequired += Number(entry.payload.troopCount) || 0;
    } else if (entry.kind === DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT) {
      frontierRequired += Number(entry.payload.troopCount) || 0;
    }
    sources.push({
      kind: entry.kind,
      giverId: entry.giverId,
      receiverId: entry.receiverId,
      candidateId: entry.payload?.candidateId ?? null,
      troopCount: entry.payload?.troopCount ?? null,
      trigger: clonePlain(entry.startTrigger),
      origin,
    });
    return { ok: true };
  };

  for (const obligation of state.activeDealObligations || []) {
    if (obligation.giverId !== playerId) continue;
    if (!TROOP_CLAUSE_KINDS.has(obligation.kind)) continue;
    if (obligation.status === 'completed') continue;
    if (obligation.status === 'dormant') continue;
    if (Number(obligation.nextDueRound) !== Number(state.round)) continue;
    const result = pushTroopRequirement(obligation, 'existing');
    if (!result.ok) return result;
  }

  for (const clause of extraClauses) {
    if (clause.giverId !== playerId) continue;
    if (!TROOP_CLAUSE_KINDS.has(clause.kind)) continue;
    if (!isTriggerSatisfied(state, clause.startTrigger)) continue;
    const result = pushTroopRequirement(clause, 'incoming');
    if (!result.ok) return result;
  }

  return {
    ok: true,
    candidateId,
    capitalRequired,
    frontierRequired,
    sources,
  };
}

function collectTroopCommitmentGroups(state, incomingClauses = []) {
  const groups = new Map();

  const pushClause = (entry) => {
    if (!TROOP_CLAUSE_KINDS.has(entry.kind)) return;
    const key = `${entry.giverId}|${getTriggerKey(entry.startTrigger)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        playerId: entry.giverId,
        triggerKey: getTriggerKey(entry.startTrigger),
        candidateId: null,
        capitalRequired: 0,
        frontierRequired: 0,
      });
    }
    const group = groups.get(key);
    if (entry.kind === DEAL_CLAUSE_KINDS.COUP_SUPPORT) {
      const candidateId = Number(entry.payload.candidateId);
      if (group.candidateId != null && group.candidateId !== candidateId) {
        group.error = `${playerName(state, entry.giverId)} cannot promise coup support to multiple claimants inside the same trigger window.`;
        return;
      }
      group.candidateId = candidateId;
      group.capitalRequired += Number(entry.payload.troopCount) || 0;
    } else {
      group.frontierRequired += Number(entry.payload.troopCount) || 0;
    }
  };

  for (const obligation of state.activeDealObligations || []) {
    if (obligation.status === 'completed') continue;
    if (obligation.kind == null) continue;
    pushClause(obligation);
  }
  for (const clause of incomingClauses) {
    pushClause(clause);
  }

  return [...groups.values()];
}

function getReservedThemeIds(state) {
  const reserved = new Set();
  for (const obligation of state.activeDealObligations || []) {
    if (obligation.status === 'completed') continue;
    if (obligation.kind !== DEAL_CLAUSE_KINDS.ESTATE) continue;
    if (obligation.payload?.themeId) reserved.add(obligation.payload.themeId);
  }
  return reserved;
}

function hasActiveAppointmentPromise(state, giverId) {
  return (state.activeDealObligations || []).some((obligation) => (
    obligation.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE
    && obligation.status !== 'completed'
    && obligation.giverId === giverId
    && Number(obligation.remainingAppointments || 0) > 0
  ));
}

function hasActiveNonRevocationPromise(state, giverId, receiverId) {
  return (state.activeDealObligations || []).some((obligation) => (
    obligation.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION
    && obligation.status !== 'completed'
    && obligation.giverId === giverId
    && obligation.receiverId === receiverId
  ));
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
      return fail(`${playerName(state, direction.giverId)} does not currently own ${themeName(state, themeId)}.`);
    }
    if (theme.owner === 'church' || theme.owner == null) {
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
      return fail(`${playerName(state, direction.giverId)} cannot currently promise ${troopResult.value} capital troop${troopResult.value === 1 ? '' : 's'}.`);
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
      return fail(`${playerName(state, direction.giverId)} cannot currently promise ${troopResult.value} frontier troop${troopResult.value === 1 ? '' : 's'}.`);
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

function normalizeDealClauses(state, actorId, counterpartyId, rawClauses = []) {
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

function validateDealParticipants(state, actorId, counterpartyId) {
  ensureDealState(state);
  const eligibleIds = getDealParticipantIds(state);
  if (!eligibleIds.includes(actorId)) {
    return fail('Only human dynasties can negotiate formal deals.');
  }
  if (!eligibleIds.includes(counterpartyId)) {
    return fail('Formal deals are only available between human dynasties.');
  }
  if (actorId === counterpartyId) {
    return fail('Choose another dynasty for this deal.');
  }
  return { ok: true };
}

function validateDealClausesAgainstState(state, clauses, pairKey) {
  const reservedThemes = getReservedThemeIds(state);
  const extraGoldReserved = new Map();
  const promisedAppointmentGivers = new Set();
  const promisedProtectionPairs = new Set();

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
        return fail(`${playerName(state, clause.giverId)} no longer owns ${themeName(state, themeId)}.`);
      }
    }

    if (clause.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE) {
      if (promisedAppointmentGivers.has(clause.giverId)) {
        return fail(`${playerName(state, clause.giverId)} cannot promise multiple overlapping appointment streams in the same deal.`);
      }
      if (hasActiveAppointmentPromise(state, clause.giverId)) {
        return fail(`${playerName(state, clause.giverId)} already owes promised appointments under another active deal.`);
      }
      promisedAppointmentGivers.add(clause.giverId);
    }

    if (clause.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION) {
      const protectionKey = `${clause.giverId}:${clause.receiverId}`;
      if (promisedProtectionPairs.has(protectionKey)) {
        return fail(`${playerName(state, clause.giverId)} cannot promise the same title protection twice in one deal.`);
      }
      if (hasActiveNonRevocationPromise(state, clause.giverId, clause.receiverId)) {
        return fail(`${playerName(state, clause.giverId)} already owes title protection to ${playerName(state, clause.receiverId)}.`);
      }
      promisedProtectionPairs.add(protectionKey);
    }
  }

  for (const [playerId, requiredGold] of extraGoldReserved.entries()) {
    if (getSpendableGold(state, playerId) < requiredGold) {
      return fail(`${playerName(state, playerId)} does not currently have enough unreserved gold to guarantee this offer.`);
    }
  }

  const structuralTroopGroups = collectTroopCommitmentGroups(state, clauses);
  for (const group of structuralTroopGroups) {
    if (group.error) return fail(group.error);
    if (group.capitalRequired <= 0 && group.frontierRequired <= 0) continue;
    const plan = buildTroopCommitmentPlan(state, group.playerId, group.capitalRequired, group.frontierRequired);
    if (!plan.ok) return plan;
  }

  return { ok: true, pairKey };
}

function createThreadOffer(state, proposerId, counterpartyId, revision, clauses) {
  return {
    proposerId,
    proposerName: playerName(state, proposerId),
    counterpartyId,
    counterpartyName: playerName(state, counterpartyId),
    revision,
    round: state.round,
    clauses: clonePlain(clauses),
  };
}

function ensureThreadForPair(state, actorId, counterpartyId) {
  const pairKey = makePairKey(actorId, counterpartyId);
  let thread = getThreadByPairKey(state, pairKey);
  if (!thread) {
    thread = {
      id: nextThreadId(state),
      pairKey,
      playerIds: uniqueInts([actorId, counterpartyId]),
      status: DEAL_THREAD_STATUS.REFUSED,
      revision: 0,
      awaitingPlayerId: null,
      currentOffer: null,
      history: [],
    };
    state.dealThreads.push(thread);
  }
  return thread;
}

function enforceRevision(thread, expectedRevision) {
  const normalized = expectedRevision == null ? null : Number(expectedRevision);
  if (normalized == null) return { ok: true };
  if (Number(thread.revision) !== normalized) {
    return fail('This deal thread changed before your action could be applied. Refresh the court panel and try again.');
  }
  return { ok: true };
}

function getOpposingPlayerId(thread, actorId) {
  return thread.playerIds.find((playerId) => playerId !== actorId) ?? null;
}

function isPlayerConfirmedForDeals(state, playerId) {
  return Boolean(state.courtActions?.playerConfirmed?.has(playerId));
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
    summary: `${playerName(state, giverId)} transfers ${amount} gold to ${playerName(state, receiverId)}.`,
    details: {
      giverId,
      giverName: playerName(state, giverId),
      receiverId,
      receiverName: playerName(state, receiverId),
      amount,
    },
  });
}

function recordPublicEstateTransfer(state, giverId, receiverId, themeId) {
  recordHistoryEvent(state, {
    category: 'court',
    type: 'deal_estate_transfer',
    actorId: giverId,
    summary: `${playerName(state, giverId)} transfers ${themeName(state, themeId)} to ${playerName(state, receiverId)}.`,
    details: {
      giverId,
      giverName: playerName(state, giverId),
      receiverId,
      receiverName: playerName(state, receiverId),
      themeId,
      themeName: themeName(state, themeId),
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
    return fail(`${playerName(state, giverId)} no longer controls ${themeName(state, themeId)}.`);
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
    if (!result.ok) return result;
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

function acceptOfferIntoObligations(state, thread, clauses) {
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

function finalizeThreadState(state, thread, status, actorId, extra = {}) {
  thread.status = status;
  if (status !== DEAL_THREAD_STATUS.OPEN) {
    thread.awaitingPlayerId = null;
  }
  thread.history.push(buildThreadHistoryEntry(
    state,
    extra.type || status,
    actorId,
    thread.revision,
    thread.currentOffer,
    extra,
  ));
}

function filterActiveObligations(state) {
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

  const beneficiaryId = obligation.receiverId;
  const beneficiarySelfLocked = beneficiaryId === appointerId
    && getPlayer(state, appointerId)?.appointmentCooldown?.__SELF_ANY === state.round - 1;
  if (beneficiarySelfLocked) return { ok: true };

  if (Number(appointeeId) !== Number(beneficiaryId)) {
    return fail(`${playerName(state, appointerId)} owes the next legal appointment to ${playerName(state, beneficiaryId)} under an accepted deal.`);
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
  const beneficiarySelfLocked = obligation.receiverId === appointerId
    && getPlayer(state, appointerId)?.appointmentCooldown?.__SELF_ANY === state.round - 1;
  if (beneficiarySelfLocked) return;
  obligation.remainingAppointments = Math.max(0, (Number(obligation.remainingAppointments) || 0) - 1);
  if (obligation.remainingAppointments <= 0) {
    obligation.status = 'completed';
    filterActiveObligations(state);
  }
}

export function validateDismissAgainstDeals(state, playerId, officeKey, count) {
  if (!TROOP_CLAUSE_KINDS.size) return { ok: true };
  const player = getPlayer(state, playerId);
  if (!player) return { ok: true };
  const dismissCount = Math.max(0, Number(count) || 0);
  if (dismissCount <= 0) return { ok: true };
  const current = player.professionalArmies?.[officeKey] || 0;
  if (dismissCount > current) return { ok: true };

  const snapshot = clonePlain({
    professionalArmies: player.professionalArmies || {},
  });
  player.professionalArmies[officeKey] = Math.max(0, current - dismissCount);
  if (player.professionalArmies[officeKey] === 0) delete player.professionalArmies[officeKey];

  const groups = collectTroopCommitmentGroups(state, []);
  let result = { ok: true };
  for (const group of groups) {
    if (group.playerId !== playerId) continue;
    if (group.error) {
      result = fail(group.error);
      break;
    }
    const plan = buildTroopCommitmentPlan(state, playerId, group.capitalRequired, group.frontierRequired);
    if (!plan.ok) {
      result = fail(`${playerName(state, playerId)} cannot dismiss those troops without breaking accepted deal commitments.`);
      break;
    }
  }

  player.professionalArmies = snapshot.professionalArmies;
  return result;
}

export function buildOrderLocksForPlayer(state, playerId) {
  ensureDealState(state);
  const requirements = buildDueTroopRequirements(state, playerId);
  if (!requirements.ok) return requirements;
  if (requirements.capitalRequired <= 0 && requirements.frontierRequired <= 0) {
    return {
      ok: true,
      playerId,
      candidateId: null,
      candidateName: null,
      capitalRequired: 0,
      frontierRequired: 0,
      capitalCommitted: 0,
      frontierCommitted: 0,
      committedOfficeKeys: {},
      officeSelections: [],
      sources: [],
    };
  }
  const plan = buildTroopCommitmentPlan(
    state,
    playerId,
    requirements.capitalRequired,
    requirements.frontierRequired,
  );
  if (!plan.ok) return plan;
  return summarizeLocks(
    state,
    playerId,
    requirements.candidateId,
    requirements.capitalRequired,
    requirements.frontierRequired,
    plan,
    requirements.sources,
  );
}

export function normalizeOrdersWithDealLocks(state, playerId, orders) {
  const locks = buildOrderLocksForPlayer(state, playerId);
  if (!locks.ok) return locks;
  const nextOrders = {
    ...orders,
    deployments: {
      ...(orders.deployments || {}),
    },
  };
  if (locks.candidateId != null) {
    nextOrders.candidate = locks.candidateId;
  }
  for (const [officeKey, destination] of Object.entries(locks.committedOfficeKeys || {})) {
    nextOrders.deployments[officeKey] = destination;
  }
  return { ok: true, orders: nextOrders, orderLocks: locks };
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

export function autoRefuseAwaitingDeals(state, playerId) {
  ensureDealState(state);
  for (const thread of state.dealThreads) {
    if (thread.status !== DEAL_THREAD_STATUS.OPEN) continue;
    if (thread.awaitingPlayerId !== playerId) continue;
    finalizeThreadState(state, thread, DEAL_THREAD_STATUS.REFUSED, playerId, {
      type: 'auto_refused',
      reason: 'court_confirmed',
    });
  }
}

export function sendDealOffer(state, actorId, payload = {}) {
  ensureDealState(state);
  if (state.phase !== 'court') return fail('Deals may only be negotiated during the Court phase.');
  if (isPlayerConfirmedForDeals(state, actorId)) return fail('You already confirmed court actions this round.');

  const counterpartyId = toInt(payload.counterpartyId, null);
  const participantCheck = validateDealParticipants(state, actorId, counterpartyId);
  if (!participantCheck.ok) return participantCheck;
  if (isPlayerConfirmedForDeals(state, counterpartyId)) {
    return fail(`${playerName(state, counterpartyId)} already confirmed court actions and cannot receive a new deal this round.`);
  }

  const clauseResult = normalizeDealClauses(state, actorId, counterpartyId, payload.clauses);
  if (!clauseResult.ok) return clauseResult;

  const pairKey = makePairKey(actorId, counterpartyId);
  const validation = validateDealClausesAgainstState(state, clauseResult.clauses, pairKey);
  if (!validation.ok) return validation;

  const thread = ensureThreadForPair(state, actorId, counterpartyId);
  if (thread.status === DEAL_THREAD_STATUS.OPEN) {
    return fail('That deal thread is still open. Counter, accept, or refuse it first.');
  }
  const revisionCheck = enforceRevision(thread, payload.expectedRevision);
  if (!revisionCheck.ok) return revisionCheck;

  const revision = nextRevision(thread);
  const offer = createThreadOffer(state, actorId, counterpartyId, revision, clauseResult.clauses);
  thread.status = DEAL_THREAD_STATUS.OPEN;
  thread.revision = revision;
  thread.awaitingPlayerId = counterpartyId;
  thread.currentOffer = offer;
  thread.history.push(buildThreadHistoryEntry(state, 'offer_sent', actorId, revision, offer));
  return { ok: true, threadId: thread.id, revision };
}

export function counterDealOffer(state, actorId, payload = {}) {
  ensureDealState(state);
  if (state.phase !== 'court') return fail('Deals may only be negotiated during the Court phase.');
  if (isPlayerConfirmedForDeals(state, actorId)) return fail('You already confirmed court actions this round.');

  const thread = getThreadById(state, String(payload.threadId || '').trim());
  if (!thread) return fail('That deal thread does not exist anymore.');
  if (thread.status !== DEAL_THREAD_STATUS.OPEN) return fail('That deal is already closed.');
  if (thread.awaitingPlayerId !== actorId) return fail('Only the dynasty currently holding the offer may counter it.');
  const revisionCheck = enforceRevision(thread, payload.expectedRevision);
  if (!revisionCheck.ok) return revisionCheck;

  const counterpartyId = getOpposingPlayerId(thread, actorId);
  const participantCheck = validateDealParticipants(state, actorId, counterpartyId);
  if (!participantCheck.ok) return participantCheck;
  if (isPlayerConfirmedForDeals(state, counterpartyId)) {
    return fail(`${playerName(state, counterpartyId)} already confirmed court actions and cannot receive a counteroffer this round.`);
  }

  const clauseResult = normalizeDealClauses(state, actorId, counterpartyId, payload.clauses);
  if (!clauseResult.ok) return clauseResult;
  const validation = validateDealClausesAgainstState(state, clauseResult.clauses, thread.pairKey);
  if (!validation.ok) return validation;

  const revision = nextRevision(thread);
  const offer = createThreadOffer(state, actorId, counterpartyId, revision, clauseResult.clauses);
  thread.status = DEAL_THREAD_STATUS.OPEN;
  thread.revision = revision;
  thread.awaitingPlayerId = counterpartyId;
  thread.currentOffer = offer;
  thread.history.push(buildThreadHistoryEntry(state, 'offer_countered', actorId, revision, offer));
  return { ok: true, threadId: thread.id, revision };
}

export function acceptDealOffer(state, actorId, payload = {}) {
  ensureDealState(state);
  if (state.phase !== 'court') return fail('Deals may only be accepted during the Court phase.');
  if (isPlayerConfirmedForDeals(state, actorId)) return fail('You already confirmed court actions this round.');

  const thread = getThreadById(state, String(payload.threadId || '').trim());
  if (!thread) return fail('That deal thread does not exist anymore.');
  if (thread.status !== DEAL_THREAD_STATUS.OPEN) return fail('That deal is already closed.');
  if (thread.awaitingPlayerId !== actorId) return fail('Only the dynasty currently holding the offer may accept it.');
  const revisionCheck = enforceRevision(thread, payload.expectedRevision);
  if (!revisionCheck.ok) return revisionCheck;

  const clauses = thread.currentOffer?.clauses || [];
  const validation = validateDealClausesAgainstState(state, clauses, thread.pairKey);
  if (!validation.ok) return validation;
  const acceptance = acceptOfferIntoObligations(state, thread, clauses);
  if (!acceptance.ok) return acceptance;

  finalizeThreadState(state, thread, DEAL_THREAD_STATUS.ACCEPTED, actorId, { type: 'offer_accepted' });
  filterActiveObligations(state);
  return { ok: true, threadId: thread.id, revision: thread.revision };
}

export function refuseDealOffer(state, actorId, payload = {}) {
  ensureDealState(state);
  if (state.phase !== 'court') return fail('Deals may only be refused during the Court phase.');
  if (isPlayerConfirmedForDeals(state, actorId)) return fail('You already confirmed court actions this round.');

  const thread = getThreadById(state, String(payload.threadId || '').trim());
  if (!thread) return fail('That deal thread does not exist anymore.');
  if (thread.status !== DEAL_THREAD_STATUS.OPEN) return fail('That deal is already closed.');
  if (thread.awaitingPlayerId !== actorId) return fail('Only the dynasty currently holding the offer may refuse it.');
  const revisionCheck = enforceRevision(thread, payload.expectedRevision);
  if (!revisionCheck.ok) return revisionCheck;

  finalizeThreadState(state, thread, DEAL_THREAD_STATUS.REFUSED, actorId, {
    type: 'offer_refused',
    reason: String(payload.reason || '').trim() || null,
  });
  return { ok: true, threadId: thread.id, revision: thread.revision };
}

export function summarizeDealClause(state, clause, viewerId = null) {
  const youGive = viewerId != null && clause.giverId === viewerId;
  const youReceive = viewerId != null && clause.receiverId === viewerId;
  const actorText = youGive ? 'You give' : youReceive ? 'You receive' : `${playerName(state, clause.giverId)} gives`;
  const targetText = youGive ? playerName(state, clause.receiverId) : youReceive ? playerName(state, clause.giverId) : playerName(state, clause.receiverId);
  const triggerText = clause.startTrigger?.type === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS
    ? ` when ${playerName(state, clause.startTrigger.playerId)} becomes Basileus`
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
    return `${actorText} ${clause.payload.troopCount} coup troop${clause.payload.troopCount === 1 ? '' : 's'} for ${playerName(state, clause.payload.candidateId)} for ${turns} turn${turns === 1 ? '' : 's'}${triggerText}.`;
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
    return `${playerName(state, clause.giverId)} promises not to revoke ${playerName(state, clause.receiverId)}'s titles for ${turns} turn${turns === 1 ? '' : 's'}${triggerText}.`;
  }
  return clause.kind;
}

export function buildPrivateDealView(state, viewerId) {
  ensureDealState(state);
  const threads = state.dealThreads
    .filter((thread) => thread.playerIds.includes(viewerId))
    .map((thread) => ({
      id: thread.id,
      pairKey: thread.pairKey,
      playerIds: thread.playerIds.slice(),
      status: thread.status,
      revision: thread.revision,
      awaitingPlayerId: thread.awaitingPlayerId,
      currentOffer: clonePlain(thread.currentOffer),
      history: clonePlain(thread.history),
    }))
    .sort((left, right) => right.revision - left.revision);

  const pendingInbox = threads.filter((thread) => thread.status === DEAL_THREAD_STATUS.OPEN && thread.awaitingPlayerId === viewerId).length;
  const pendingOutbox = threads.filter((thread) => thread.status === DEAL_THREAD_STATUS.OPEN && thread.awaitingPlayerId !== viewerId).length;
  const obligationCount = (state.activeDealObligations || []).filter((obligation) => (
    obligation.status !== 'completed'
    && (obligation.giverId === viewerId || obligation.receiverId === viewerId)
  )).length;

  const orderLocks = buildOrderLocksForPlayer(state, viewerId);

  return {
    dealEligiblePlayerIds: getDealParticipantIds(state).filter((playerId) => playerId !== viewerId),
    dealThreads: threads,
    dealCounts: {
      pendingInbox,
      pendingOutbox,
      activeObligations: obligationCount,
    },
    orderLocks: orderLocks.ok ? orderLocks : { ok: false, reason: orderLocks.reason || 'Accepted deal commitments can no longer be fulfilled.' },
  };
}
