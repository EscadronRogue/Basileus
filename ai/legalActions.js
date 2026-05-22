import {
  applyCourtAction,
  applyEstateAction,
  applyManualTitleReassignment,
  confirmCourt,
  submitHumanOrders,
} from '../engine/commands.js';
import {
  canBuyTheme,
  getMinimumLandBid,
  suggestMajorTitleAssignments,
  validateMajorTitleAssignments,
} from '../engine/actions.js';
import { getSpendableGold } from '../engine/deals.js';
import { getMercenaryHireCost } from '../engine/rules.js';
import { applyDefenderRewardChoice, getPendingDefenderRewards } from '../engine/turnflow.js';
import { getFreeThemes, getPlayer } from '../engine/state.js';
import { getPlayerOrderOfficeKeys, normalizeHumanOrders } from '../engine/orders.js';
import { readTroopEntry } from '../engine/cascade.js';
import { MAJOR_TITLES } from '../data/titles.js';

export const AI_DEALS_ENABLED = false;
const MAX_ORDER_ACTIONS = 520;

function cloneValueForValidation(value) {
  if (value == null) return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
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
    pendingDefenderRewards: cloneValueForValidation(state.pendingDefenderRewards || []),
    landAuctions: cloneValueForValidation(state.landAuctions || {}),
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
    && !theme.occupied
    && theme.owner !== 'church'
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
  const player = getPlayer(state, appointerId);
  return state.players
    .map((candidate) => candidate.id)
    .filter((playerId) => !(player?.appointmentCooldown?.selfLocked && playerId === appointerId));
}

function appendAppointmentActions(actions, state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return;
  const appointees = appointmentPlayerIds(state, playerId);

  if (playerId === state.basileusId) {
    for (const appointeeId of appointees) {
      if (state.empress == null) pushCourt(actions, state, playerId, { action: 'appoint-court', titleType: 'EMPRESS', appointeeId }, 'appoint empress');
      if (state.chiefEunuchs == null) pushCourt(actions, state, playerId, { action: 'appoint-court', titleType: 'CHIEF_EUNUCHS', appointeeId }, 'appoint chief eunuchs');
    }
  }

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
    if (theme.strategos != null && requiredStrategosTitle && player.majorTitles.includes(requiredStrategosTitle)) {
      pushCourt(actions, state, playerId, { action: 'revoke', value: `minor:${theme.id}:strategos` }, 'revoke strategos');
    }
    if (theme.bishop != null && player.majorTitles.includes('PATRIARCH')) {
      pushCourt(actions, state, playerId, { action: 'revoke', value: `minor:${theme.id}:bishop` }, 'revoke bishop');
    }
    if (playerId === state.basileusId && theme.owner != null && !theme.occupied && theme.id !== 'CPL') {
      pushCourt(actions, state, playerId, { action: 'revoke', value: `theme:${theme.id}` }, 'revoke estate');
    }
  }
  if (playerId === state.basileusId && state.empress != null) {
    pushCourt(actions, state, playerId, { action: 'revoke', value: 'court:EMPRESS' }, 'revoke empress');
  }
  if (playerId === state.basileusId && state.chiefEunuchs != null) {
    pushCourt(actions, state, playerId, { action: 'revoke', value: 'court:CHIEF_EUNUCHS' }, 'revoke chief eunuchs');
  }
}

export function listLegalCourtActions(state, playerId) {
  if (!state || state.phase !== 'court') return [];
  if (state.courtActions?.playerConfirmed?.has(playerId)) return [];
  const actions = [];
  appendAppointmentActions(actions, state, playerId);
  appendRevocationActions(actions, state, playerId);
  pushCourt(actions, state, playerId, { action: 'skip' }, 'skip court action');
  pushConfirmation(actions, state, playerId);
  return uniqueActions(actions);
}

function buildEstateBidAmounts(state, playerId, theme) {
  const minimum = getMinimumLandBid(state, theme.id);
  const spendable = Math.max(0, Number(getSpendableGold(state, playerId)) || 0);
  return [...new Set([minimum, Math.min(spendable, minimum + 1), spendable])]
    .filter((amount) => amount >= minimum && canBuyTheme(state, playerId, theme.id, amount).ok)
    .sort((left, right) => left - right);
}

export function listLegalEstateActions(state, playerId) {
  if (!state || state.phase !== 'estates') return [];
  const actions = [];
  for (const theme of getFreeThemes(state)) {
    for (const amount of buildEstateBidAmounts(state, playerId, theme)) {
      const payload = { action: 'buy', themeId: theme.id, amount };
      actions.push({ id: actionId('estate', payload), kind: 'estate', phase: 'estates', playerId, label: 'bid on estate', payload });
    }
  }
  return actions;
}

function fullFundingArmies(state, playerId, destination = 'frontier') {
  const armies = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const entry = readTroopEntry(state.currentTroops?.[officeKey]);
    const max = entry.normal + entry.capitalLocked;
    armies[officeKey] = { funded: max, destination };
  }
  return armies;
}

function partialFundingArmies(state, playerId, ratio, destination = 'frontier') {
  const armies = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const entry = readTroopEntry(state.currentTroops?.[officeKey]);
    const max = entry.normal + entry.capitalLocked;
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
    const entry = readTroopEntry(state.currentTroops?.[officeKey]);
    const max = entry.normal + entry.capitalLocked;
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
    const entry = readTroopEntry(state.currentTroops?.[officeKey]);
    const max = entry.normal + entry.capitalLocked;
    armies[officeKey] = {
      funded: officeKey === activeOfficeKey ? max : 0,
      destination,
    };
  }
  return armies;
}

function getUnfundedGoldFromArmies(state, armies) {
  return Object.entries(armies || {}).reduce((total, [officeKey, order]) => {
    const entry = readTroopEntry(state.currentTroops?.[officeKey]);
    const max = entry.normal + entry.capitalLocked;
    return total + Math.max(0, max - (Number(order?.funded) || 0));
  }, 0);
}

function getMaxMercenariesForBudget(budget) {
  let count = 0;
  while (count < 10 && getMercenaryHireCost(0, count + 1) <= budget) count += 1;
  return count;
}

function buildMercenaryPlans(state, playerId, armies) {
  const spendable = Math.max(0, Number(getSpendableGold(state, playerId)) || 0);
  const budget = spendable + getUnfundedGoldFromArmies(state, armies);
  const maxAffordable = getMaxMercenariesForBudget(budget);
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

export function listLegalOrderActions(state, playerId) {
  if (!state || state.phase !== 'deployment') return [];
  if (state.allOrders?.[playerId]) return [];
  const actions = [];
  const seen = new Set();
  const armyPlans = buildArmyPlans(state, playerId);
  for (const armies of armyPlans) {
    for (const mercenaries of buildMercenaryPlans(state, playerId, armies)) {
      for (const candidate of state.players.map((player) => player.id)) {
        const orders = { armies, mercenaries, candidate };
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

export function listLegalRewardActions(state, playerId) {
  if (!state || state.phase !== 'resolution') return [];
  const actions = [];
  for (const reward of getPendingDefenderRewards(state, playerId)) {
    for (const choice of ['empire', 'gold']) {
      const trial = cloneForValidation(state);
      const result = applyDefenderRewardChoice(trial, reward.id, playerId, choice);
      if (!result.ok) continue;
      actions.push({ id: actionId('reward', { rewardId: reward.id, choice }), kind: 'reward', phase: 'resolution', playerId, label: `defender reward ${choice}`, rewardId: reward.id, choice });
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
  void options;
  if (state?.phase === 'title_redistribution') return listLegalTitleAssignments(state, playerId);
  if (state?.phase === 'court') return listLegalCourtActions(state, playerId);
  if (state?.phase === 'estates') return listLegalEstateActions(state, playerId);
  if (state?.phase === 'deployment') return listLegalOrderActions(state, playerId);
  if (state?.phase === 'resolution') return listLegalRewardActions(state, playerId);
  return [];
}

export function applyLegalAction(state, action, aiMeta = null) {
  if (!action) return { ok: false, reason: 'No action selected.' };
  if (action.kind === 'court') return applyCourtAction(state, action.playerId, action.payload);
  if (action.kind === 'court-confirm') return confirmCourt(state, action.playerId);
  if (action.kind === 'estate') return applyEstateAction(state, action.playerId, action.payload);
  if (action.kind === 'orders') return submitHumanOrders(state, action.playerId, action.orders);
  if (action.kind === 'reward') return applyDefenderRewardChoice(state, action.rewardId, action.playerId, action.choice);
  if (action.kind === 'title-assignment') {
    return applyManualTitleReassignment(state, aiMeta, action.newBasileusId, action.assignments);
  }
  return { ok: false, reason: `Unknown legal action kind: ${action.kind}` };
}

export function getActionTargetPlayerId(state, action) {
  const payload = action?.payload || {};
  if (Number.isInteger(payload.appointeeId)) return payload.appointeeId;
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
  return null;
}

export function getOfficeControllerId(state, officeKey) {
  return state ? state.currentTroops?.[officeKey] : null;
}

export function getMajorTitleHolderId(state, titleKey) {
  return state.players.find((player) => player.majorTitles.includes(titleKey))?.id ?? null;
}
