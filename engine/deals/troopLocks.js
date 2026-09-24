// engine/deals/troopLocks.js - deployment order locks owed under accepted troop clauses.

import { getPlayerLabel } from '../state.js';
import {
  getDeploymentArmyDisplayName,
  getDeploymentArmyTroopTotal,
  getPlayerDeploymentArmyKeys,
} from '../deployment.js';
import { normalizeCoupSupport, placeCoupCandidateAfterPlayer } from '../coup.js';
import { recordPublicObligationFailure } from './obligations.js';
import {
  DEAL_CLAUSE_KINDS,
  TROOP_CLAUSE_KINDS,
  clonePlain,
  ensureDealState,
  fail,
  filterActiveObligations,
  getTriggerKey,
  isTriggerSatisfied,
} from './state.js';

export function getPlayerOrderChunks(state, playerId) {
  return getPlayerDeploymentArmyKeys(state, playerId)
    .map((officeKey) => {
      const troops = getDeploymentArmyTroopTotal(state, playerId, officeKey);
      return {
        officeKey,
        officeName: getDeploymentArmyDisplayName(state, playerId, officeKey),
        troops,
        capitalOnly: false,
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

function compareTroopPlans(left, right, requiredFrontier, requiredCapital) {
  const leftOvershoot = (left.frontierCommitted - requiredFrontier) + (left.capitalCommitted - requiredCapital);
  const rightOvershoot = (right.frontierCommitted - requiredFrontier) + (right.capitalCommitted - requiredCapital);
  if (leftOvershoot !== rightOvershoot) return leftOvershoot - rightOvershoot;

  const leftTotal = left.frontierCommitted + left.capitalCommitted;
  const rightTotal = right.frontierCommitted + right.capitalCommitted;
  if (leftTotal !== rightTotal) return leftTotal - rightTotal;

  const leftOfficeCount = left.frontierOffices.length + left.capitalOffices.length;
  const rightOfficeCount = right.frontierOffices.length + right.capitalOffices.length;
  if (leftOfficeCount !== rightOfficeCount) return leftOfficeCount - rightOfficeCount;

  const frontierCmp = comparePlanKeys(
    left.frontierOffices.map((entry) => entry.officeKey),
    right.frontierOffices.map((entry) => entry.officeKey),
  );
  if (frontierCmp !== 0) return frontierCmp;

  return comparePlanKeys(
    left.capitalOffices.map((entry) => entry.officeKey),
    right.capitalOffices.map((entry) => entry.officeKey),
  );
}

export function buildTroopCommitmentPlan(state, playerId, capitalRequired, frontierRequired) {
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

  const maxChunkTroops = Math.max(0, ...chunks.map((chunk) => Number(chunk.troops) || 0));
  const frontierCap = requiredFrontier + maxChunkTroops;
  const capitalCap = requiredCapital + maxChunkTroops;

  const keyFor = (frontierCommitted, capitalCommitted) => (
    `${Math.min(frontierCap, frontierCommitted)}:${Math.min(capitalCap, capitalCommitted)}`
  );
  const store = (map, candidate) => {
    const key = keyFor(candidate.frontierCommitted, candidate.capitalCommitted);
    const existing = map.get(key);
    if (!existing || compareTroopPlans(candidate, existing, requiredFrontier, requiredCapital) < 0) {
      map.set(key, candidate);
    }
  };

  let states = new Map();
  states.set('0:0', {
    frontierCommitted: 0,
    capitalCommitted: 0,
    frontierOffices: [],
    capitalOffices: [],
  });

  for (const chunk of chunks) {
    const nextStates = new Map(states);
    for (const plan of states.values()) {
      store(nextStates, {
        frontierCommitted: plan.frontierCommitted,
        capitalCommitted: plan.capitalCommitted + chunk.troops,
        frontierOffices: plan.frontierOffices,
        capitalOffices: [...plan.capitalOffices, chunk],
      });
      if (!chunk.capitalOnly) {
        store(nextStates, {
          frontierCommitted: plan.frontierCommitted + chunk.troops,
          capitalCommitted: plan.capitalCommitted,
          frontierOffices: [...plan.frontierOffices, chunk],
          capitalOffices: plan.capitalOffices,
        });
      }
    }
    states = nextStates;
  }

  let best = null;
  for (const plan of states.values()) {
    if (plan.frontierCommitted < requiredFrontier || plan.capitalCommitted < requiredCapital) continue;
    if (!best || compareTroopPlans(plan, best, requiredFrontier, requiredCapital) < 0) {
      best = plan;
    }
  }

  if (!best) {
    return fail(`${getPlayerLabel(state, playerId)} cannot cover ${requiredCapital} capital troop${requiredCapital === 1 ? '' : 's'} and ${requiredFrontier} frontier troop${requiredFrontier === 1 ? '' : 's'} with the current office layout.`);
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
    candidateName: candidateId == null ? null : getPlayerLabel(state, candidateId),
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
        return fail(`${getPlayerLabel(state, playerId)} already owes coup support to another claimant in the same trigger window.`);
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

export function collectTroopCommitmentGroups(state, incomingClauses = []) {
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
        group.error = `${getPlayerLabel(state, entry.giverId)} cannot promise coup support to multiple claimants inside the same trigger window.`;
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

function failDueTroopObligations(state, playerId, reason) {
  ensureDealState(state);
  let failed = 0;
  for (const obligation of state.activeDealObligations || []) {
    if (obligation.giverId !== playerId) continue;
    if (!TROOP_CLAUSE_KINDS.has(obligation.kind)) continue;
    if (obligation.status !== 'active') continue;
    if (Number(obligation.nextDueRound) !== Number(state.round)) continue;
    obligation.status = 'completed';
    obligation.failedRound = state.round;
    obligation.failureReason = reason;
    recordPublicObligationFailure(state, obligation, reason);
    failed += 1;
  }
  if (failed > 0) filterActiveObligations(state);
  return failed;
}

export function normalizeOrdersWithDealLocks(state, playerId, orders, options = {}) {
  let locks = buildOrderLocksForPlayer(state, playerId);
  if (!locks.ok && options.resolveImpossibleLocks) {
    const reason = locks.reason || 'Accepted deal commitments can no longer be fulfilled.';
    if (failDueTroopObligations(state, playerId, reason) > 0) {
      locks = buildOrderLocksForPlayer(state, playerId);
    }
  }
  if (!locks.ok) return locks;
  const nextOrders = {
    ...orders,
    armies: {
      ...(orders.armies || {}),
    },
    mercenaries: {
      count: Math.max(0, Number(orders.mercenaries?.count) || 0),
      destination: ['capital', 'frontier'].includes(orders.mercenaries?.destination)
        ? orders.mercenaries.destination
        : null,
    },
  };
  if (locks.candidateId != null) {
    nextOrders.candidate = locks.candidateId;
    nextOrders.ranking = placeCoupCandidateAfterPlayer(state, playerId, nextOrders.ranking, locks.candidateId);
    nextOrders.candidateSupport = normalizeCoupSupport(state, nextOrders.candidateSupport, locks.candidateId);
  }
  for (const [officeKey, destination] of Object.entries(locks.committedOfficeKeys || {})) {
    const max = getDeploymentArmyTroopTotal(state, playerId, officeKey);
    nextOrders.armies[officeKey] = {
      funded: max,
      destination,
    };
  }
  return { ok: true, orders: nextOrders, orderLocks: locks };
}
