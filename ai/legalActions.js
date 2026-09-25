import {
  applyCourtAction,
  applyEstateAction,
  applyManualTitleReassignment,
  confirmCourt,
  submitHumanOrders,
} from '../engine/commands.js';
import {
  canRevokeEstates,
  getAvailableCourtPowers,
  getEstateRevocationValue,
  suggestMajorTitleAssignments,
  validateMajorTitleAssignments,
} from '../engine/actions.js';
import { canBuildEstatesIn, getProvinceEstateHolders } from '../engine/estates.js';
import { getSpendableGold } from '../engine/deals.js';
import { getMercenaryHireCost } from '../engine/rules.js';
import { getPlayer, hasAppointmentTargetLock } from '../engine/state.js';
import { getPlayerOrderOfficeKeys, normalizeHumanOrders } from '../engine/orders.js';
import { getDeploymentArmyTroopTotal } from '../engine/deployment.js';
import { getPreferredCoupCandidate } from '../engine/coup.js';
import { MAJOR_TITLES } from '../data/titles.js';
import { BALANCE, getBalance } from '../data/balance.js';
import { clonePlainData } from '../engine/clone.js';
import { getPlayerMemory, getRelationship, relationshipScore } from './memory.js';

export const AI_DEALS_ENABLED = false;
const MAX_ORDER_ACTIONS = 1200;

function cloneValueForValidation(value) {
  return value == null ? value : clonePlainData(value);
}

function cloneForValidation(state) {
  const clone = {
    ...state,
    players: cloneValueForValidation(state.players || []),
    themes: cloneValueForValidation(state.themes || {}),
    courtActions: cloneValueForValidation(state.courtActions),
    activeDealObligations: cloneValueForValidation(state.activeDealObligations || []),
    reservedGold: cloneValueForValidation(state.reservedGold || {}),
    dealThreads: cloneValueForValidation(state.dealThreads || []),
    estatePlans: cloneValueForValidation(state.estatePlans || {}),
    estatesReady: cloneValueForValidation(state.estatesReady || {}),
    currentTroops: cloneValueForValidation(state.currentTroops || {}),
    allOrders: cloneValueForValidation(state.allOrders || {}),
    mercenaryOrders: cloneValueForValidation(state.mercenaryOrders || {}),
    log: [],
    historyEnabled: false,
    history: null,
  };
  if (state.courtActions && !(clone.courtActions?.playerConfirmed instanceof Set)) {
    clone.courtActions = {
      ...clone.courtActions,
      playerConfirmed: new Set([...(state.courtActions.playerConfirmed || [])]),
    };
  }
  clone.rng = state.rng;
  return clone;
}

function sortPlain(value) {
  if (Array.isArray(value)) return value.map(sortPlain);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortPlain(value[key])]));
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

function pushCourt(actions, state, playerId, payload, label = payload.action) {
  const trial = cloneForValidation(state);
  const result = applyCourtAction(trial, playerId, payload);
  if (!result.ok) return;
  actions.push({ id: actionId('court', payload), kind: 'court', phase: 'court', playerId, label, payload });
}

function pushConfirmation(actions, state, playerId) {
  const trial = cloneForValidation(state);
  const result = confirmCourt(trial, playerId);
  if (!result.ok) return;
  actions.push({
    id: `court-confirm:${playerId}`,
    kind: 'court-confirm',
    phase: 'court',
    playerId,
    label: 'confirm court',
    payload: { action: 'confirm-court' },
  });
}

function openStrategosThemes(state, region) {
  return Object.values(state.themes || {}).filter((theme) => (
    theme.id !== 'CPL'
    && !theme.lost
    && theme.strategos == null
    && theme.region === region
  ));
}

function openBishopThemes(state) {
  return Object.values(state.themes || {}).filter((theme) => (
    theme.id !== 'CPL'
    && theme.bishop == null
    && (Number(theme.origin?.C) || 0) >= 1
  ));
}

function appointmentPlayerIds(state, appointerId) {
  return state.players
    .map((candidate) => candidate.id)
    .filter((playerId) => !hasAppointmentTargetLock(state, appointerId, playerId));
}

function appendAppointmentActions(actions, state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return;
  const appointees = appointmentPlayerIds(state, playerId);

  for (const titleKey of player.majorTitles || []) {
    if (titleKey === 'PATRIARCH') {
      for (const theme of openBishopThemes(state)) {
        for (const appointeeId of appointees) {
          pushCourt(actions, state, playerId, { action: 'appoint-bishop', themeId: theme.id, appointeeId }, 'appoint bishop');
        }
      }
      continue;
    }
    const region = MAJOR_TITLES[titleKey]?.region;
    if (!region) continue;
    for (const theme of openStrategosThemes(state, region)) {
      for (const appointeeId of appointees) {
        pushCourt(actions, state, playerId, { action: 'appoint-strategos', titleKey, themeId: theme.id, appointeeId }, 'appoint strategos');
      }
    }
  }
}

function appendRevocationActions(actions, state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return;
  for (const theme of Object.values(state.themes || {})) {
    const requiredStrategosTitle = MAJOR_TITLES.DOM_EAST.region === theme.region
      ? 'DOM_EAST'
      : MAJOR_TITLES.DOM_WEST.region === theme.region
        ? 'DOM_WEST'
        : theme.region === MAJOR_TITLES.ADMIRAL.region
          ? 'ADMIRAL'
          : null;
    if (theme.strategos != null && !theme.lost && requiredStrategosTitle && player.majorTitles.includes(requiredStrategosTitle)) {
      pushCourt(actions, state, playerId, { action: 'revoke', value: `minor:${theme.id}:strategos` }, 'revoke strategos');
    }
    if (theme.bishop != null && player.majorTitles.includes('PATRIARCH')) {
      pushCourt(actions, state, playerId, { action: 'revoke', value: `minor:${theme.id}:bishop` }, 'revoke bishop');
    }
    if (playerId === state.basileusId && !theme.lost && theme.id !== 'CPL') {
      for (const holder of getProvinceEstateHolders(theme)) {
        if (!canRevokeEstates(state, theme.id, holder.playerId, playerId).ok) continue;
        pushCourt(actions, state, playerId, { action: 'revoke', value: getEstateRevocationValue(theme.id, holder.playerId) }, 'revoke estates');
      }
    }
  }
}

function appendCourtPowerPassActions(actions, state, playerId) {
  for (const powerKey of getAvailableCourtPowers(state, playerId)) {
    pushCourt(actions, state, playerId, { action: 'pass-court-power', powerKey }, 'pass court office');
  }
}

export function listLegalCourtActions(state, playerId) {
  if (!state || state.phase !== 'court') return [];
  if (state.courtActions?.playerConfirmed?.has(playerId)) return [];
  const actions = [];
  appendAppointmentActions(actions, state, playerId);
  appendRevocationActions(actions, state, playerId);
  appendCourtPowerPassActions(actions, state, playerId);
  pushCourt(actions, state, playerId, { action: 'skip' }, 'skip court action');
  pushConfirmation(actions, state, playerId);
  return uniqueActions(actions);
}

// Provinces where the dynasty may build estates this round.
export function listEstateSites(state) {
  return Object.values(state?.themes || {}).filter(canBuildEstatesIn);
}

export function buildEstatePlanAction(playerId, plan = {}) {
  const payload = { action: 'plan', plan };
  return { id: actionId('estate', payload), kind: 'estate', phase: 'estates', playerId, label: 'plan estates', payload };
}

// One action per site: a plan of a single estate there. The strategic AI
// builds its real plan greedily in ai/strategy.js; this list serves the
// random policy and tests.
export function listLegalEstateActions(state, playerId) {
  if (!state || state.phase !== 'estates') return [];
  return listEstateSites(state).map((theme) => buildEstatePlanAction(playerId, { [theme.id]: 1 }));
}

function fullFundingArmies(state, playerId, destination = 'frontier') {
  const armies = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const max = getDeploymentArmyTroopTotal(state, playerId, officeKey);
    armies[officeKey] = { funded: max, destination };
  }
  return armies;
}

function partialFundingArmies(state, playerId, ratio, destination = 'frontier') {
  const armies = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const max = getDeploymentArmyTroopTotal(state, playerId, officeKey);
    armies[officeKey] = { funded: Math.ceil(max * ratio), destination };
  }
  return armies;
}

function idleArmies(state, playerId) {
  const armies = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    armies[officeKey] = { funded: 0, destination: 'frontier' };
  }
  return armies;
}

function mixedFundingArmies(state, playerId, pivotOfficeKey, pivotDestination, otherDestination) {
  const armies = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const max = getDeploymentArmyTroopTotal(state, playerId, officeKey);
    armies[officeKey] = {
      funded: max,
      destination: officeKey === pivotOfficeKey ? pivotDestination : otherDestination,
    };
  }
  return armies;
}

function sparseFundingArmies(state, playerId, activeOfficeKey, destination) {
  const armies = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const max = getDeploymentArmyTroopTotal(state, playerId, officeKey);
    armies[officeKey] = {
      funded: officeKey === activeOfficeKey ? max : 0,
      destination,
    };
  }
  return armies;
}

function getUnfundedGoldFromArmies(state, playerId, armies) {
  return Object.entries(armies || {}).reduce((total, [officeKey, order]) => {
    const max = getDeploymentArmyTroopTotal(state, playerId, officeKey);
    return total + Math.max(0, max - (Number(order?.funded) || 0));
  }, 0);
}

function getMaxMercenariesForBudget(budget, maxMercenaries = BALANCE.MAX_MERCENARIES) {
  let count = 0;
  while (count < maxMercenaries && getMercenaryHireCost(0, count + 1) <= budget) count += 1;
  return count;
}

function buildMercenaryPlans(state, playerId, armies) {
  const spendable = Math.max(0, Number(getSpendableGold(state, playerId)) || 0);
  const budget = spendable + getUnfundedGoldFromArmies(state, playerId, armies);
  const maxAffordable = getMaxMercenariesForBudget(budget, getBalance(state).MAX_MERCENARIES);
  const counts = [...new Set([0, Math.min(2, maxAffordable), Math.floor(maxAffordable / 2), maxAffordable])]
    .filter((count) => count >= 0 && count <= maxAffordable)
    .sort((left, right) => left - right);
  const plans = [];
  for (const count of counts) {
    plans.push({ count, destination: 'frontier' });
    if (count > 0) plans.push({ count, destination: 'capital' });
  }
  return plans;
}

function buildArmyPlans(state, playerId) {
  const officeKeys = getPlayerOrderOfficeKeys(state, playerId);
  const plans = [
    fullFundingArmies(state, playerId, 'frontier'),
    fullFundingArmies(state, playerId, 'capital'),
    partialFundingArmies(state, playerId, 2 / 3, 'frontier'),
    partialFundingArmies(state, playerId, 2 / 3, 'capital'),
    partialFundingArmies(state, playerId, 1 / 2, 'frontier'),
    partialFundingArmies(state, playerId, 1 / 2, 'capital'),
    partialFundingArmies(state, playerId, 1 / 3, 'frontier'),
    partialFundingArmies(state, playerId, 1 / 3, 'capital'),
    idleArmies(state, playerId),
  ];
  for (const officeKey of officeKeys) {
    plans.push(mixedFundingArmies(state, playerId, officeKey, 'capital', 'frontier'));
    plans.push(mixedFundingArmies(state, playerId, officeKey, 'frontier', 'capital'));
    plans.push(sparseFundingArmies(state, playerId, officeKey, 'frontier'));
    plans.push(sparseFundingArmies(state, playerId, officeKey, 'capital'));
  }
  return uniqueActions(plans.map((armies) => ({ id: actionId('army-plan', armies), armies }))).map((entry) => entry.armies);
}

function leastLikedSupportBlockCount(state) {
  const playerCount = state?.players?.length || 0;
  if (playerCount <= 2) return 0;
  return playerCount === 3 ? 1 : 2;
}

// Which other dynasties the AI is willing to back at all: it leaves out the
// ones it likes least and a Basileus that has wronged it.
export function buildAiCoupSupport(state, playerId, memory = null) {
  const support = Object.fromEntries((state?.players || []).map((player) => [player.id, true]));
  const blockCount = leastLikedSupportBlockCount(state);
  const restoreFallbackCandidate = () => {
    const candidateIds = (state?.players || [])
      .map((player) => player.id)
      .filter((candidateId) => candidateId !== playerId);
    if (candidateIds.some((candidateId) => support[candidateId] !== false)) return;
    const fallback = candidateIds
      .map((candidateId) => ({
        candidateId,
        score: relationshipScore(memory, playerId, candidateId),
      }))
      .sort((left, right) => (
        (right.score - left.score)
        || (left.candidateId - right.candidateId)
      ))[0];
    if (fallback) support[fallback.candidateId] = true;
  };
  const basileusId = state?.basileusId;
  if (Number.isInteger(basileusId) && basileusId !== playerId && memory) {
    const relationToBasileus = getRelationship(memory, playerId, basileusId);
    const basileusPattern = getPlayerMemory(memory, basileusId);
    if (
      Math.max(0, Number(relationToBasileus.revokedMe) || 0) >= 0.75
      || Number(relationToBasileus.score) <= -1.5
      || (
        Math.max(0, Number(basileusPattern.revocationAggression) || 0) > 0.9
        && Number(relationToBasileus.score) < 0
      )
    ) {
      support[basileusId] = false;
    }
  }
  if (blockCount <= 0) {
    restoreFallbackCandidate();
    return support;
  }

  const leastLiked = (state.players || [])
    .map((player) => player.id)
    .filter((candidateId) => candidateId !== playerId)
    .map((candidateId) => ({
      candidateId,
      score: relationshipScore(memory, playerId, candidateId),
    }))
    .sort((left, right) => (
      (left.score - right.score)
      || (left.candidateId - right.candidateId)
    ))
    .slice(0, blockCount);

  for (const { candidateId } of leastLiked) support[candidateId] = false;
  restoreFallbackCandidate();
  return support;
}

// Coup choices an AI considers with a given ally: claim the throne itself
// with the ally second, or back the ally with itself second.
export function buildAiCoupChoiceSets(state, playerId, allyId) {
  return [
    [playerId, allyId],
    [allyId, playerId],
  ];
}

export function listLegalOrderActions(state, playerId, options = {}) {
  if (!state || state.phase !== 'deployment') return [];
  if (state.allOrders?.[playerId]) return [];
  const actions = [];
  const seen = new Set();
  const armyPlans = buildArmyPlans(state, playerId);
  const allySupport = buildAiCoupSupport(state, playerId, options.memory || null);
  const allyIds = state.players
    .map((player) => player.id)
    .filter((candidateId) => candidateId !== playerId && allySupport[candidateId] !== false);
  const choiceSets = [[playerId], ...allyIds.flatMap((allyId) => buildAiCoupChoiceSets(state, playerId, allyId))];
  for (const armies of armyPlans) {
    for (const mercenaries of buildMercenaryPlans(state, playerId, armies)) {
      for (const coupChoices of choiceSets) {
        const orders = { armies, mercenaries, coupChoices };
        const normalized = normalizeHumanOrders(state, playerId, orders, { resolveImpossibleLocks: true });
        if (!normalized.ok) continue;
        const key = stablePayload(normalized.orders);
        if (seen.has(key)) continue;
        seen.add(key);
        actions.push({ id: actionId('orders', normalized.orders), kind: 'orders', phase: 'deployment', playerId, label: 'submit orders', orders: normalized.orders });
        if (actions.length >= MAX_ORDER_ACTIONS) return actions;
      }
    }
  }
  return actions;
}

function buildTitleAssignmentCandidates(state, basileusId) {
  const titleKeys = Object.keys(MAJOR_TITLES);
  const eligibleIds = state.players.map((player) => player.id).filter((playerId) => playerId !== basileusId);
  const assignments = [];
  const suggested = suggestMajorTitleAssignments(state, basileusId);
  if (validateMajorTitleAssignments(state, basileusId, suggested).ok) assignments.push(suggested);

  function walk(index, current) {
    if (assignments.length > 48) return;
    if (index >= titleKeys.length) {
      const candidate = { ...current };
      if (validateMajorTitleAssignments(state, basileusId, candidate).ok) assignments.push(candidate);
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
  return uniqueActions(assignments.map((entry) => ({ id: actionId('title-assignment', entry), assignments: entry }))).map((entry) => entry.assignments);
}

export function listLegalTitleAssignments(state, basileusId = state?.basileusId) {
  if (!state || state.phase !== 'title_redistribution') return [];
  return buildTitleAssignmentCandidates(state, basileusId).map((assignments) => ({
    id: actionId('title-assignment', assignments),
    kind: 'title-assignment',
    phase: 'title_redistribution',
    playerId: basileusId,
    label: 'redistribute major titles',
    newBasileusId: basileusId,
    assignments,
  }));
}

export function listLegalActions(state, playerId, options = {}) {
  if (state?.phase === 'title_redistribution') return listLegalTitleAssignments(state, playerId);
  if (state?.phase === 'court') return listLegalCourtActions(state, playerId);
  if (state?.phase === 'estates') return listLegalEstateActions(state, playerId);
  if (state?.phase === 'deployment') return listLegalOrderActions(state, playerId, options);
  return [];
}

export function applyLegalAction(state, action) {
  if (!action) return { ok: false, reason: 'No action selected.' };
  if (action.kind === 'court') return applyCourtAction(state, action.playerId, action.payload);
  if (action.kind === 'court-confirm') return confirmCourt(state, action.playerId);
  if (action.kind === 'estate') return applyEstateAction(state, action.playerId, action.payload);
  if (action.kind === 'orders') return submitHumanOrders(state, action.playerId, action.orders);
  if (action.kind === 'title-assignment') {
    return applyManualTitleReassignment(state, action.newBasileusId, action.assignments);
  }
  return { ok: false, reason: `Unknown legal action kind: ${action.kind}` };
}

export function getActionTargetPlayerId(state, action) {
  const payload = action?.payload || {};
  if (Number.isInteger(payload.appointeeId)) return payload.appointeeId;
  if (Array.isArray(action?.orders?.coupChoices)) {
    return getPreferredCoupCandidate(state, action.playerId, action.orders);
  }
  if (payload.value) {
    const [kind, id, titleType] = String(payload.value).split(':');
    if (kind === 'minor') {
      const theme = state.themes?.[id];
      return titleType === 'strategos' ? theme?.strategos ?? null : theme?.bishop ?? null;
    }
    if (kind === 'estates') return Number.isInteger(Number(titleType)) ? Number(titleType) : null;
    if (kind === 'court') return null;
  }
  return null;
}

export function getActionThemeId(action) {
  const payload = action?.payload || {};
  if (payload.themeId) return payload.themeId;
  if (payload.value) {
    const [kind, id] = String(payload.value).split(':');
    if (kind === 'minor' || kind === 'estates') return id;
  }
  return null;
}

export function getOfficeControllerId(state, officeKey) {
  return state ? state.currentTroops?.[officeKey] : null;
}

export function getMajorTitleHolderId(state, titleKey) {
  return state.players.find((player) => player.majorTitles.includes(titleKey))?.id ?? null;
}
