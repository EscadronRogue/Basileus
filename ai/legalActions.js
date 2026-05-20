import {
  applyCourtAction,
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
import { applyDefenderRewardChoice, getPendingDefenderRewards } from '../engine/turnflow.js';
import { getFreeThemes, getPlayer, getPlayerThemes } from '../engine/state.js';
import { getPlayerOrderOfficeKeys } from '../engine/orders.js';
import { MAJOR_TITLES } from '../data/titles.js';

export const AI_DEALS_ENABLED = false;

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

function appendGiftActions(actions, state, playerId) {
  for (const theme of getPlayerThemes(state, playerId)) {
    if (!theme.occupied && (Number(theme.origin?.C) || 0) >= 1) {
      pushCourt(actions, state, playerId, { action: 'gift', themeId: theme.id }, 'gift estate');
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
  appendGiftActions(actions, state, playerId);
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
    const entry = state.currentTroops?.[officeKey];
    const max = Math.max(0, Number(entry?.normal) || 0) + Math.max(0, Number(entry?.capitalLocked) || 0);
    armies[officeKey] = { funded: max, destination };
  }
  return armies;
}

function leanFundingArmies(state, playerId) {
  const armies = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const entry = state.currentTroops?.[officeKey];
    const max = Math.max(0, Number(entry?.normal) || 0) + Math.max(0, Number(entry?.capitalLocked) || 0);
    armies[officeKey] = { funded: Math.ceil(max / 2), destination: 'frontier' };
  }
  return armies;
}

export function listLegalOrderActions(state, playerId) {
  if (!state || state.phase !== 'deployment') return [];
  if (state.allOrders?.[playerId]) return [];
  const actions = [];
  const seen = new Set();
  const armyPlans = [fullFundingArmies(state, playerId, 'frontier'), fullFundingArmies(state, playerId, 'capital'), leanFundingArmies(state, playerId)];
  for (const armies of armyPlans) {
    for (const candidate of state.players.map((player) => player.id)) {
      const orders = { armies, mercenaries: { count: 0, destination: 'frontier' }, candidate };
      const trial = cloneForValidation(state);
      const result = submitHumanOrders(trial, playerId, orders);
      if (!result.ok) continue;
      const key = stablePayload(result.orders);
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push({ id: actionId('orders', result.orders), kind: 'orders', phase: 'deployment', playerId, label: 'submit orders', orders: result.orders });
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
