import {
  applyCourtAction,
  applyManualTitleReassignment,
  confirmCourt,
  submitHumanOrders,
} from '../engine/commands.js';
import {
  canBuyTheme,
  canDismissProfessional,
  canRecruitProfessional,
  getMinimumLandBid,
  validateMajorTitleAssignments,
} from '../engine/actions.js';
import {
  DEAL_CLAUSE_KINDS,
  DEAL_TRIGGER_TYPES,
  getDealParticipantIds,
  getIncomingDealsForPlayer,
  getSpendableGold,
} from '../engine/deals.js';
import {
  applyDefenderRewardChoice,
  getPendingDefenderRewards,
} from '../engine/turnflow.js';
import {
  findTitleHolder,
  getFreeThemes,
  getOfficeHolder,
  getPlayer,
  getPlayerMercenaryTroops,
  getPlayerMercenaryTotal,
  getPlayerThemes,
  MERCENARY_COMPANY_KEY,
} from '../engine/state.js';
import {
  getPlayerOrderOfficeKeys,
  isCapitalLockedOfficeKey,
} from '../engine/orders.js';
import { getMercenaryHireCost } from '../engine/rules.js';
import { MAJOR_TITLES } from '../data/titles.js';

const STRATEGOS_TITLE_BY_REGION = {
  east: 'DOM_EAST',
  west: 'DOM_WEST',
  sea: 'ADMIRAL',
};

function cloneForValidation(state) {
  const clone = JSON.parse(JSON.stringify(state));
  clone.rng = state.rng;
  if (state.courtActions) {
    clone.courtActions = {
      ...clone.courtActions,
      playerConfirmed: new Set([...(state.courtActions.playerConfirmed || new Set())]),
    };
  }
  return clone;
}

function sortPlain(value) {
  if (Array.isArray(value)) return value.map(sortPlain);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortPlain(value[key])]),
  );
}

function stablePayload(value) {
  return JSON.stringify(sortPlain(value));
}

function actionId(kind, payload) {
  return `${kind}:${stablePayload(payload)}`;
}

function uniqueActions(actions) {
  const seen = new Set();
  const unique = [];
  for (const action of actions) {
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    unique.push(action);
  }
  return unique;
}

function legalCourtAction(state, playerId, payload, label = payload.action) {
  const trial = cloneForValidation(state);
  const result = applyCourtAction(trial, playerId, payload);
  if (!result.ok) return null;
  return {
    id: actionId('court', payload),
    kind: 'court',
    phase: 'court',
    playerId,
    label,
    payload,
  };
}

function legalCourtConfirmation(state, playerId) {
  const trial = cloneForValidation(state);
  const result = confirmCourt(trial, playerId);
  if (!result.ok) return null;
  return {
    id: `court-confirm:${playerId}`,
    kind: 'court-confirm',
    phase: 'court',
    playerId,
    label: 'confirm court',
    payload: { action: 'confirm-court' },
  };
}

function pushLegalCourtAction(actions, state, playerId, payload, label) {
  const action = legalCourtAction(state, playerId, payload, label);
  if (action) actions.push(action);
}

function getOpenStrategosThemes(state, region = null) {
  return Object.values(state.themes || {}).filter((theme) => (
    !theme.occupied
    && theme.id !== 'CPL'
    && theme.owner !== 'church'
    && theme.strategos === null
    && (region == null || theme.region === region)
  ));
}

function getOpenBishopThemes(state) {
  return Object.values(state.themes || {}).filter((theme) => (
    !theme.occupied
    && theme.id !== 'CPL'
    && theme.bishop === null
    && (Number(theme.C) || 0) >= 1
  ));
}

function getAppointmentPlayerIds(state, appointerId) {
  const appointer = getPlayer(state, appointerId);
  return state.players
    .map((player) => player.id)
    .filter((playerId) => !(appointer?.appointmentCooldown?.selfLocked && playerId === appointerId));
}

function appendAppointmentActions(actions, state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return;
  const appointeeIds = getAppointmentPlayerIds(state, playerId);

  if (playerId === state.basileusId) {
    for (const appointeeId of appointeeIds) {
      if (state.empress === null) {
        pushLegalCourtAction(actions, state, playerId, {
          action: 'basileus-appoint',
          titleType: 'EMPRESS',
          appointeeId,
        }, 'appoint empress');
      }
      if (state.chiefEunuchs === null) {
        pushLegalCourtAction(actions, state, playerId, {
          action: 'basileus-appoint',
          titleType: 'CHIEF_EUNUCHS',
          appointeeId,
        }, 'appoint chief eunuchs');
      }
      for (const theme of getOpenStrategosThemes(state)) {
        pushLegalCourtAction(actions, state, playerId, {
          action: 'basileus-appoint',
          titleType: 'STRATEGOS',
          themeId: theme.id,
          appointeeId,
        }, 'appoint strategos');
      }
      for (const theme of getOpenBishopThemes(state)) {
        pushLegalCourtAction(actions, state, playerId, {
          action: 'basileus-appoint',
          titleType: 'BISHOP',
          themeId: theme.id,
          appointeeId,
        }, 'appoint bishop');
      }
    }
  }

  for (const titleKey of player.majorTitles || []) {
    if (titleKey === 'PATRIARCH') {
      for (const theme of getOpenBishopThemes(state)) {
        for (const appointeeId of appointeeIds) {
          pushLegalCourtAction(actions, state, playerId, {
            action: 'appoint-bishop',
            themeId: theme.id,
            appointeeId,
          }, 'appoint bishop');
        }
      }
      continue;
    }

    const region = MAJOR_TITLES[titleKey]?.region;
    if (!region) continue;
    for (const theme of getOpenStrategosThemes(state, region)) {
      for (const appointeeId of appointeeIds) {
        pushLegalCourtAction(actions, state, playerId, {
          action: 'appoint-strategos',
          titleKey,
          themeId: theme.id,
          appointeeId,
        }, 'appoint strategos');
      }
    }
  }
}

function appendEstateActions(actions, state, playerId) {
  for (const theme of getFreeThemes(state)) {
    const minimum = getMinimumLandBid(state, theme.id);
    if (canBuyTheme(state, playerId, theme.id, minimum).ok) {
      pushLegalCourtAction(actions, state, playerId, {
        action: 'buy',
        themeId: theme.id,
        amount: minimum,
      }, 'bid on estate');
    }
  }

  for (const theme of getPlayerThemes(state, playerId)) {
    pushLegalCourtAction(actions, state, playerId, {
      action: 'gift',
      themeId: theme.id,
    }, 'gift estate');
  }
}

function appendArmyActions(actions, state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return;
  const officeKeys = getPlayerOrderOfficeKeys(state, playerId);

  for (const officeKey of officeKeys) {
    if (officeKey === MERCENARY_COMPANY_KEY) continue;
    if (canRecruitProfessional(state, playerId, officeKey).ok) {
      pushLegalCourtAction(actions, state, playerId, {
        action: 'recruit',
        office: officeKey,
      }, 'recruit professional');
    }

    const professionalCount = Math.max(0, Number(player.professionalArmies?.[officeKey]) || 0);
    if (professionalCount > 0) {
      const counts = uniquePositiveInts([1, professionalCount]);
      for (const count of counts) {
        if (!canDismissProfessional(state, playerId, officeKey, count).ok) continue;
        pushLegalCourtAction(actions, state, playerId, {
          action: 'dismiss',
          office: officeKey,
          count,
        }, 'dismiss professional');
      }
    }
  }

  const nextMercenaryCost = getMercenaryHireCost(getPlayerMercenaryTotal(state, playerId), 1);
  if (getSpendableGold(state, playerId) >= nextMercenaryCost && nextMercenaryCost > 0) {
    pushLegalCourtAction(actions, state, playerId, {
      action: 'hire-mercenaries',
      office: MERCENARY_COMPANY_KEY,
      count: 1,
    }, 'hire mercenary');
  }
}

function uniquePositiveInts(values) {
  return [...new Set(values)]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right);
}

function appendRevocationActions(actions, state, playerId) {
  const actor = getPlayer(state, playerId);
  if (!actor) return;
  const isBasileus = playerId === state.basileusId;
  const canRevokeBishops = isBasileus || actor.majorTitles?.includes('PATRIARCH');

  for (const theme of Object.values(state.themes || {})) {
    const requiredStrategosTitle = STRATEGOS_TITLE_BY_REGION[theme.region];
    const canRevokeStrategos = isBasileus || actor.majorTitles?.includes(requiredStrategosTitle);
    if (!theme.occupied && theme.strategos != null && canRevokeStrategos) {
      pushLegalCourtAction(actions, state, playerId, {
        action: 'revoke',
        value: `minor:${theme.id}:strategos`,
      }, 'revoke strategos');
    }
    if (theme.bishop != null && canRevokeBishops) {
      pushLegalCourtAction(actions, state, playerId, {
        action: 'revoke',
        value: `minor:${theme.id}:bishop`,
      }, 'revoke bishop');
    }
    if (isBasileus && theme.owner !== null && theme.owner !== 'church' && !theme.occupied) {
      pushLegalCourtAction(actions, state, playerId, {
        action: 'revoke',
        value: `theme:${theme.id}`,
      }, 'revoke estate');
    }
  }

  if (isBasileus && state.empress != null) {
    pushLegalCourtAction(actions, state, playerId, {
      action: 'revoke',
      value: 'court:EMPRESS',
    }, 'revoke empress');
  }
  if (isBasileus && state.chiefEunuchs != null) {
    pushLegalCourtAction(actions, state, playerId, {
      action: 'revoke',
      value: 'court:CHIEF_EUNUCHS',
    }, 'revoke chief eunuchs');
  }
}

function getOtherDealPlayerIds(state, playerId) {
  return getDealParticipantIds(state)
    .filter((candidateId) => candidateId !== playerId)
    .filter((candidateId) => !state.courtActions?.playerConfirmed?.has(candidateId));
}

function getPrivateThemesOwnedBy(state, playerId) {
  return Object.values(state.themes || {})
    .filter((theme) => theme.owner === playerId && theme.owner !== 'church' && !theme.occupied)
    .sort((left, right) => ((right.P || 0) + (right.T || 0)) - ((left.P || 0) + (left.T || 0)));
}

function getOrderTroopCapacity(state, playerId, destination) {
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  let total = 0;
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    if (destination === 'frontier' && isCapitalLockedOfficeKey(officeKey)) continue;
    const professionals = officeKey === MERCENARY_COMPANY_KEY ? 0 : (player.professionalArmies?.[officeKey] || 0);
    const levies = officeKey === MERCENARY_COMPANY_KEY ? 0 : (state.currentLevies?.[officeKey] || 0);
    const mercenaries = officeKey === MERCENARY_COMPANY_KEY ? getPlayerMercenaryTroops(state, playerId) : 0;
    total += professionals + levies + mercenaries;
  }
  return total;
}

function rankedPositiveAmounts(maxValue, preferred = [5, 3, 1]) {
  const max = Math.max(0, Math.floor(Number(maxValue) || 0));
  if (max <= 0) return [];
  return [...new Set(
    preferred
      .map((amount) => Math.min(max, amount))
      .filter((amount) => amount > 0),
  )].sort((left, right) => right - left);
}

function dealClauseMagnitude(clause = {}) {
  if (clause.kind === DEAL_CLAUSE_KINDS.GOLD) return Number(clause.amount) || 0;
  if (clause.kind === DEAL_CLAUSE_KINDS.COUP_SUPPORT || clause.kind === DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT) {
    return Number(clause.troopCount) || 0;
  }
  if (clause.kind === DEAL_CLAUSE_KINDS.ESTATE) return 4;
  if (clause.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE) return 3;
  if (clause.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION) return Number(clause.durationTurns) || 1;
  return 1;
}

function sortDealClausesBySignal(clauses) {
  return clauses.slice().sort((left, right) => {
    const rightSignal = dealClauseMagnitude(right) + (right.startTriggerType === DEAL_TRIGGER_TYPES.IMMEDIATE ? 0.25 : 0);
    const leftSignal = dealClauseMagnitude(left) + (left.startTriggerType === DEAL_TRIGGER_TYPES.IMMEDIATE ? 0.25 : 0);
    return rightSignal - leftSignal;
  });
}

function buildDealClauseTemplates(state, actorId, counterpartyId) {
  const clauses = [];
  const triggers = [
    { startTriggerType: DEAL_TRIGGER_TYPES.IMMEDIATE },
    { startTriggerType: DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS, triggerPlayerId: actorId },
    { startTriggerType: DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS, triggerPlayerId: counterpartyId },
  ];
  const directions = ['give', 'ask'];
  const candidateIds = [...new Set([actorId, counterpartyId, state.basileusId])]
    .filter((playerId) => Number.isInteger(playerId));

  for (const trigger of triggers) {
    for (const direction of directions) {
      const giverId = direction === 'give' ? actorId : counterpartyId;
      for (const amount of rankedPositiveAmounts(getSpendableGold(state, giverId), [5, 3, 1])) {
        clauses.push({
          kind: DEAL_CLAUSE_KINDS.GOLD,
          direction,
          amount,
          durationTurns: 1,
          ...trigger,
        });
        if (amount >= 4) {
          clauses.push({
            kind: DEAL_CLAUSE_KINDS.GOLD,
            direction,
            amount,
            durationTurns: 2,
            ...trigger,
          });
        }
      }

      for (const theme of getPrivateThemesOwnedBy(state, giverId).slice(0, 2)) {
        clauses.push({
          kind: DEAL_CLAUSE_KINDS.ESTATE,
          direction,
          themeId: theme.id,
          ...trigger,
        });
      }

      const capitalCapacity = getOrderTroopCapacity(state, giverId, 'capital');
      if (capitalCapacity > 0) {
        for (const candidateId of candidateIds) {
          for (const troopCount of rankedPositiveAmounts(capitalCapacity, [5, 3, 1])) {
            clauses.push({
              kind: DEAL_CLAUSE_KINDS.COUP_SUPPORT,
              direction,
              candidateId,
              troopCount,
              durationTurns: 1,
              ...trigger,
            });
          }
        }
      }

      const frontierCapacity = getOrderTroopCapacity(state, giverId, 'frontier');
      if (frontierCapacity > 0) {
        for (const troopCount of rankedPositiveAmounts(frontierCapacity, [5, 3, 1])) {
          clauses.push({
            kind: DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT,
            direction,
            troopCount,
            durationTurns: 1,
            ...trigger,
          });
        }
      }

      clauses.push({
        kind: DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE,
        direction,
        appointmentCount: 1,
        ...trigger,
      });
      clauses.push({
        kind: DEAL_CLAUSE_KINDS.NON_REVOCATION,
        direction,
        durationTurns: 2,
        ...trigger,
      });
      clauses.push({
        kind: DEAL_CLAUSE_KINDS.NON_REVOCATION,
        direction,
        durationTurns: 1,
        ...trigger,
      });
    }
  }

  return sortDealClausesBySignal(clauses);
}

function uniqueDealTemplates(templates) {
  const seen = new Set();
  const out = [];
  for (const clauses of templates) {
    if (!Array.isArray(clauses) || clauses.length === 0) continue;
    const key = stablePayload(clauses);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clauses);
  }
  return out;
}

function buildReciprocalDealTemplates(state, actorId, counterpartyId) {
  const immediate = { startTriggerType: DEAL_TRIGGER_TYPES.IMMEDIATE };
  const actorGold = rankedPositiveAmounts(getSpendableGold(state, actorId), [5, 3, 1]).slice(0, 2);
  const counterpartyGold = rankedPositiveAmounts(getSpendableGold(state, counterpartyId), [5, 3, 1]).slice(0, 2);
  const actorFrontier = rankedPositiveAmounts(getOrderTroopCapacity(state, actorId, 'frontier'), [5, 3, 1]).slice(0, 2);
  const counterpartyFrontier = rankedPositiveAmounts(getOrderTroopCapacity(state, counterpartyId, 'frontier'), [5, 3, 1]).slice(0, 2);
  const actorCapital = rankedPositiveAmounts(getOrderTroopCapacity(state, actorId, 'capital'), [5, 3, 1]).slice(0, 2);
  const counterpartyCapital = rankedPositiveAmounts(getOrderTroopCapacity(state, counterpartyId, 'capital'), [5, 3, 1]).slice(0, 2);
  const templates = [];

  for (const amount of actorGold) {
    for (const troopCount of counterpartyFrontier) {
      templates.push([
        { kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'give', amount, durationTurns: 1, ...immediate },
        { kind: DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, direction: 'ask', troopCount, durationTurns: 1, ...immediate },
      ]);
    }
    for (const troopCount of counterpartyCapital) {
      templates.push([
        { kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'give', amount, durationTurns: 1, ...immediate },
        { kind: DEAL_CLAUSE_KINDS.COUP_SUPPORT, direction: 'ask', candidateId: actorId, troopCount, durationTurns: 1, ...immediate },
      ]);
    }
  }

  for (const amount of counterpartyGold) {
    for (const troopCount of actorFrontier) {
      templates.push([
        { kind: DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, direction: 'give', troopCount, durationTurns: 1, ...immediate },
        { kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'ask', amount, durationTurns: 1, ...immediate },
      ]);
    }
    for (const troopCount of actorCapital) {
      templates.push([
        { kind: DEAL_CLAUSE_KINDS.COUP_SUPPORT, direction: 'give', candidateId: counterpartyId, troopCount, durationTurns: 1, ...immediate },
        { kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'ask', amount, durationTurns: 1, ...immediate },
      ]);
    }
  }

  for (const amount of actorGold) {
    templates.push([
      { kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'give', amount, durationTurns: 1, ...immediate },
      { kind: DEAL_CLAUSE_KINDS.NON_REVOCATION, direction: 'ask', durationTurns: 2, ...immediate },
    ]);
  }
  for (const amount of counterpartyGold) {
    templates.push([
      { kind: DEAL_CLAUSE_KINDS.NON_REVOCATION, direction: 'give', durationTurns: 2, ...immediate },
      { kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'ask', amount, durationTurns: 1, ...immediate },
    ]);
  }

  return templates;
}

function buildDealOfferTemplates(state, actorId, counterpartyId) {
  const reciprocal = buildReciprocalDealTemplates(state, actorId, counterpartyId);
  const singleClauses = buildDealClauseTemplates(state, actorId, counterpartyId).map((clause) => [clause]);
  return uniqueDealTemplates([...reciprocal, ...singleClauses]);
}

function appendDealActions(actions, state, playerId) {
  for (const thread of getIncomingDealsForPlayer(state, playerId)) {
    const basePayload = {
      threadId: thread.id,
      expectedRevision: thread.revision,
    };
    pushLegalCourtAction(actions, state, playerId, {
      action: 'deal-accept',
      ...basePayload,
    }, 'accept deal');
    pushLegalCourtAction(actions, state, playerId, {
      action: 'deal-refuse',
      ...basePayload,
    }, 'refuse deal');

    const counterpartyId = thread.playerIds.find((id) => id !== playerId);
    for (const clauses of buildDealOfferTemplates(state, playerId, counterpartyId).slice(0, 72)) {
      pushLegalCourtAction(actions, state, playerId, {
        action: 'deal-counter',
        ...basePayload,
        counterpartyId,
        clauses,
      }, 'counter deal');
    }
  }

  for (const counterpartyId of getOtherDealPlayerIds(state, playerId)) {
    for (const clauses of buildDealOfferTemplates(state, playerId, counterpartyId).slice(0, 72)) {
      pushLegalCourtAction(actions, state, playerId, {
        action: 'deal-send',
        counterpartyId,
        clauses,
      }, 'send deal');
    }
  }
}

export function listLegalCourtActions(state, playerId, options = {}) {
  if (!state || state.phase !== 'court') return [];
  if (state.courtActions?.playerConfirmed?.has(playerId)) return [];

  const actions = [];
  appendAppointmentActions(actions, state, playerId);
  appendEstateActions(actions, state, playerId);
  appendArmyActions(actions, state, playerId);
  appendRevocationActions(actions, state, playerId);
  if (options.includeDeals !== false) appendDealActions(actions, state, playerId);

  const confirmation = legalCourtConfirmation(state, playerId);
  if (confirmation) actions.push(confirmation);
  return uniqueActions(actions);
}

function buildBaseDeployments(state, officeKeys, defaultDestination) {
  const deployments = {};
  for (const officeKey of officeKeys) {
    deployments[officeKey] = isCapitalLockedOfficeKey(officeKey)
      ? 'capital'
      : defaultDestination;
  }
  return deployments;
}

function buildDeploymentPlans(state, playerId) {
  const officeKeys = getPlayerOrderOfficeKeys(state, playerId);
  const movable = officeKeys.filter((officeKey) => !isCapitalLockedOfficeKey(officeKey));
  const plans = [
    buildBaseDeployments(state, officeKeys, 'frontier'),
    buildBaseDeployments(state, officeKeys, 'capital'),
  ];

  for (const officeKey of movable) {
    const plan = buildBaseDeployments(state, officeKeys, 'frontier');
    plan[officeKey] = 'capital';
    plans.push(plan);
  }

  for (const officeKey of movable) {
    const plan = buildBaseDeployments(state, officeKeys, 'capital');
    plan[officeKey] = 'frontier';
    plans.push(plan);
  }

  return plans;
}

export function listLegalOrderActions(state, playerId) {
  if (!state || state.phase !== 'orders') return [];
  if (state.allOrders?.[playerId]) return [];

  const actions = [];
  const seenOrders = new Set();
  for (const deployments of buildDeploymentPlans(state, playerId)) {
    for (const candidate of state.players.map((player) => player.id)) {
      const trial = cloneForValidation(state);
      const result = submitHumanOrders(trial, playerId, { deployments, candidate });
      if (!result.ok) continue;
      const orders = result.orders;
      const key = stablePayload(orders);
      if (seenOrders.has(key)) continue;
      seenOrders.add(key);
      actions.push({
        id: actionId('orders', orders),
        kind: 'orders',
        phase: 'orders',
        playerId,
        label: 'submit orders',
        orders,
      });
    }
  }
  return actions;
}

export function listLegalRewardActions(state, playerId) {
  if (!state || state.phase !== 'resolution') return [];
  const actions = [];
  for (const reward of getPendingDefenderRewards(state, playerId)) {
    for (const choice of ['empire', 'gold']) {
      const trial = cloneForValidation(state);
      const result = applyDefenderRewardChoice(trial, reward.id, playerId, choice);
      if (!result.ok) continue;
      actions.push({
        id: actionId('reward', { rewardId: reward.id, choice }),
        kind: 'reward',
        phase: 'resolution',
        playerId,
        label: `defender reward ${choice}`,
        rewardId: reward.id,
        choice,
      });
    }
  }
  return actions;
}

function buildTitleAssignmentCandidates(state, newBasileusId) {
  const titleKeys = Object.keys(MAJOR_TITLES);
  const eligibleIds = state.players
    .map((player) => player.id)
    .filter((playerId) => playerId !== newBasileusId);
  const assignments = [];

  function walk(index, current) {
    if (index >= titleKeys.length) {
      const candidate = { ...current };
      if (validateMajorTitleAssignments(state, newBasileusId, candidate).ok) {
        assignments.push(candidate);
      }
      return;
    }
    const titleKey = titleKeys[index];
    for (const playerId of eligibleIds) {
      current[titleKey] = playerId;
      walk(index + 1, current);
    }
    delete current[titleKey];
  }

  walk(0, {});
  return assignments;
}

export function listLegalTitleAssignments(state, newBasileusId = state?.nextBasileusId) {
  if (!state || state.phase !== 'resolution') return [];
  if (newBasileusId == null || newBasileusId === state.basileusId) return [];
  return buildTitleAssignmentCandidates(state, newBasileusId).map((assignments) => ({
    id: actionId('title-assignment', assignments),
    kind: 'title-assignment',
    phase: 'resolution',
    playerId: newBasileusId,
    label: 'assign major titles',
    newBasileusId,
    assignments,
  }));
}

export function listLegalActions(state, playerId, options = {}) {
  if (state?.phase === 'court') return listLegalCourtActions(state, playerId, options);
  if (state?.phase === 'orders') return listLegalOrderActions(state, playerId);
  if (state?.phase === 'resolution') {
    return [
      ...listLegalRewardActions(state, playerId),
      ...listLegalTitleAssignments(state, playerId),
    ];
  }
  return [];
}

export function applyLegalAction(state, action, aiMeta = null) {
  if (!action) return { ok: false, reason: 'No action selected.' };
  if (action.kind === 'court') return applyCourtAction(state, action.playerId, action.payload);
  if (action.kind === 'court-confirm') return confirmCourt(state, action.playerId);
  if (action.kind === 'orders') return submitHumanOrders(state, action.playerId, action.orders);
  if (action.kind === 'reward') return applyDefenderRewardChoice(state, action.rewardId, action.playerId, action.choice);
  if (action.kind === 'title-assignment') {
    return applyManualTitleReassignment(
      state,
      aiMeta,
      action.newBasileusId,
      action.assignments,
    );
  }
  return { ok: false, reason: `Unknown legal action kind: ${action.kind}` };
}

export function getActionTargetPlayerId(state, action) {
  const payload = action?.payload || {};
  if (Number.isInteger(payload.appointeeId)) return payload.appointeeId;
  if (Number.isInteger(payload.counterpartyId)) return payload.counterpartyId;
  if (Number.isInteger(action?.orders?.candidate)) return action.orders.candidate;
  if (action?.kind === 'reward') return action.playerId;
  if (payload.value) {
    const [kind, id, titleType] = String(payload.value).split(':');
    if (kind === 'minor') {
      const theme = state.themes?.[id];
      return titleType === 'strategos' ? theme?.strategos ?? null : theme?.bishop ?? null;
    }
    if (kind === 'theme') return state.themes?.[id]?.owner ?? null;
    if (kind === 'court') return id === 'EMPRESS' ? state.empress : state.chiefEunuchs;
  }
  return null;
}

export function getActionThemeId(action) {
  const payload = action?.payload || {};
  if (payload.themeId) return payload.themeId;
  if (payload.value) {
    const [kind, id] = String(payload.value).split(':');
    if (kind === 'minor' || kind === 'theme') return id;
  }
  for (const clause of payload.clauses || []) {
    if (clause.themeId) return clause.themeId;
  }
  return null;
}

export function getOfficeControllerId(state, officeKey) {
  if (officeKey === MERCENARY_COMPANY_KEY) return null;
  return getOfficeHolder(state, officeKey);
}

export function getMajorTitleHolderId(state, titleKey) {
  return findTitleHolder(state, titleKey);
}
