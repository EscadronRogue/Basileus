// engine/actions.js - Offices phase actions (appointments, revocations), title redistribution, and coups.
import {
  findTitleHolder,
  getPlayer,
  hasAppointmentTargetLock,
  hasRevocationTargetLock,
  recordAppointmentChoice,
  recordRevocationChoice,
  getPlayerLabel,
} from './state.js';
import { recordHistoryEvent } from './history.js';
import { getPlayerFinalScore } from './scoring.js';
import {
  autoRefuseAwaitingDeals,
  consumeAppointmentPromise,
  validateAppointmentPromiseChoice,
} from './deals.js';
import {
  canHoldEstates,
  getEstateCount,
  getProvinceEstateHolders,
  getRevocableEstateCount,
  removeRevocableEstates,
} from './estates.js';
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';
import { BALANCE } from '../data/balance.js';
import { getCapitalSupportEntries } from './capitalSupport.js';
import { buildDefaultCoupChoices, getCoupChoiceShares, normalizeCoupChoices } from './coup.js';

const STRATEGOS_TITLE_BY_REGION = {
  east: 'DOM_EAST',
  west: 'DOM_WEST',
  sea: 'ADMIRAL',
};

export function getCourtPowerAppointmentLimit(powerKey) {
  return powerKey === 'BASILEUS' ? 0 : BALANCE.MAJOR_OFFICE_ACTION_LIMIT;
}

export function getCourtPowerRevocationLimit(powerKey) {
  return powerKey === 'BASILEUS' ? BALANCE.BASILEUS_REVOCATION_LIMIT : BALANCE.MAJOR_OFFICE_ACTION_LIMIT;
}

export function getCourtPowerActionLimit(powerKey) {
  return powerKey === 'BASILEUS' ? BALANCE.BASILEUS_REVOCATION_LIMIT : BALANCE.MAJOR_OFFICE_ACTION_LIMIT;
}

function themeName(state, themeId) {
  return state.themes[themeId]?.name || themeId;
}

function courtPowerName(powerKey) {
  if (powerKey === 'BASILEUS') return 'Basileus';
  return MAJOR_TITLES[powerKey]?.name || powerKey || 'This office';
}

function isValidPlayerId(state, playerId) {
  return Number.isInteger(playerId) && Boolean(getPlayer(state, playerId));
}

function fail(reason) {
  return { ok: false, reason };
}

export function getMinorTitleSlotKey(themeId, titleType) {
  return `minor:${themeId}:${titleType}`;
}

function ensureCourtActionState(state) {
  if (!state.courtActions) state.courtActions = {};
  if (!state.courtActions.actionUsed) state.courtActions.actionUsed = {};
  if (!state.courtActions.powerUsed) state.courtActions.powerUsed = {};
  if (!state.courtActions.appointedThisTurn) state.courtActions.appointedThisTurn = {};
  if (!state.courtActions.revokedThisTurn) state.courtActions.revokedThisTurn = {};
  if (!state.courtActions.playerConfirmed) state.courtActions.playerConfirmed = new Set();
  return state.courtActions;
}

export function hasCourtActionUsed(state, playerId) {
  return Boolean(state?.courtActions?.actionUsed?.[playerId]);
}

function getPlayerPowerUseMap(state, playerId) {
  const courtActions = ensureCourtActionState(state);
  if (!courtActions.powerUsed[playerId] || typeof courtActions.powerUsed[playerId] !== 'object') {
    courtActions.powerUsed[playerId] = {};
  }
  return courtActions.powerUsed[playerId];
}

function normalizeCourtPowerUse(value) {
  if (!value) return { count: 0, kinds: [], passed: false };
  if (typeof value === 'string') {
    return value === 'pass'
      ? { count: 0, kinds: [], passed: true }
      : { count: 1, kinds: [value], passed: false };
  }
  if (Array.isArray(value)) {
    const entries = value.filter(Boolean).map((entry) => String(entry));
    const kinds = entries.filter((entry) => entry !== 'pass');
    return { count: kinds.length, kinds, passed: entries.includes('pass') };
  }
  if (typeof value === 'object') {
    let passed = Boolean(value.passed || value.pass);
    const kinds = Array.isArray(value.kinds)
      ? value.kinds.filter(Boolean).map((entry) => String(entry))
      : [];
    if (kinds.includes('pass')) passed = true;
    const filteredKinds = kinds.filter((entry) => entry !== 'pass');
    const fallbackKind = value.lastKind || value.kind || value.actionKind || null;
    if (!filteredKinds.length && fallbackKind) {
      if (String(fallbackKind) === 'pass') passed = true;
      else filteredKinds.push(String(fallbackKind));
    }
    const count = Math.max(
      filteredKinds.length,
      Number.isFinite(Number(value.count)) ? Number(value.count) : 0,
    );
    return { count, kinds: filteredKinds, passed };
  }
  return { count: 0, kinds: [], passed: false };
}

export function getCourtPowerActionKinds(state, playerId, powerKey) {
  return normalizeCourtPowerUse(getPlayerPowerUseMap(state, playerId)[powerKey]).kinds;
}

export function getCourtPowerActionCount(state, playerId, powerKey) {
  return normalizeCourtPowerUse(getPlayerPowerUseMap(state, playerId)[powerKey]).count;
}

export function getCourtPowerActionKind(state, playerId, powerKey) {
  const kinds = getCourtPowerActionKinds(state, playerId, powerKey);
  return kinds.at(-1) || null;
}

export function isCourtPowerPassed(state, playerId, powerKey) {
  return normalizeCourtPowerUse(getPlayerPowerUseMap(state, playerId)[powerKey]).passed;
}

function getCourtPowerKindCount(state, playerId, powerKey, actionKind) {
  return getCourtPowerActionKinds(state, playerId, powerKey)
    .filter((kind) => kind === actionKind).length;
}

export function getCourtPowerAppointmentCount(state, playerId, powerKey) {
  return getCourtPowerKindCount(state, playerId, powerKey, 'appoint');
}

export function getCourtPowerRevocationCount(state, playerId, powerKey) {
  return getCourtPowerKindCount(state, playerId, powerKey, 'revoke');
}

export function getCourtPowerUseMode(state, playerId, powerKey) {
  const revocations = getCourtPowerRevocationCount(state, playerId, powerKey);
  const appointments = getCourtPowerAppointmentCount(state, playerId, powerKey);
  if (revocations > 0 && appointments > 0) return 'mixed';
  if (revocations > 0) return 'revoke';
  if (appointments > 0) return 'appoint';
  return null;
}

export function isCourtPowerUsed(state, playerId, powerKey) {
  const use = normalizeCourtPowerUse(getPlayerPowerUseMap(state, playerId)[powerKey]);
  return use.count > 0 || use.passed;
}

export function isCourtPowerExhausted(state, playerId, powerKey) {
  if (isCourtPowerPassed(state, playerId, powerKey)) return true;
  const appointments = getCourtPowerAppointmentCount(state, playerId, powerKey);
  const revocations = getCourtPowerRevocationCount(state, playerId, powerKey);
  const totalActions = getCourtPowerActionCount(state, playerId, powerKey);
  if (totalActions >= getCourtPowerActionLimit(powerKey)) return true;
  const revocationLimit = getCourtPowerRevocationLimit(powerKey);
  const appointmentLimit = getCourtPowerAppointmentLimit(powerKey);
  if (revocationLimit > 0 && revocations >= revocationLimit) return true;
  if (appointmentLimit > 0 && appointments >= appointmentLimit) return true;
  return false;
}

export function getUsedCourtPowers(state, playerId) {
  return Object.keys(getPlayerPowerUseMap(state, playerId));
}

export function markCourtActionUsed(state, playerId, powerKey = 'PLAYER', actionKind = 'action') {
  const courtActions = ensureCourtActionState(state);
  courtActions.actionUsed[playerId] = true;
  const powerUse = getPlayerPowerUseMap(state, playerId);
  const current = normalizeCourtPowerUse(powerUse[powerKey]);
  const kinds = current.kinds.slice();
  kinds.push(actionKind);
  powerUse[powerKey] = {
    count: Math.max(current.count + 1, kinds.length),
    lastKind: actionKind,
    kinds,
    passed: current.passed,
  };
}

export function markCourtPowerPassed(state, playerId, powerKey) {
  const courtActions = ensureCourtActionState(state);
  courtActions.actionUsed[playerId] = true;
  const powerUse = getPlayerPowerUseMap(state, playerId);
  const current = normalizeCourtPowerUse(powerUse[powerKey]);
  powerUse[powerKey] = {
    count: current.count,
    lastKind: current.kinds.at(-1) || null,
    kinds: current.kinds.slice(),
    passed: true,
  };
}

function checkCourtActionAvailable(state, playerId, powerKey, actionKind) {
  if (state.phase !== 'court') return fail('Appointments and revocations are only possible in the Offices phase.');
  if (state.courtActions?.playerConfirmed?.has(playerId)) return fail('You already locked your offices this round.');
  if (isCourtPowerPassed(state, playerId, powerKey)) {
    return fail(`${courtPowerName(powerKey)} already passed this round.`);
  }

  const appointments = getCourtPowerAppointmentCount(state, playerId, powerKey);
  const revocations = getCourtPowerRevocationCount(state, playerId, powerKey);
  const totalActions = getCourtPowerActionCount(state, playerId, powerKey);
  if (actionKind === 'appoint') {
    const appointmentLimit = getCourtPowerAppointmentLimit(powerKey);
    if (appointmentLimit <= 0) {
      return fail(`${courtPowerName(powerKey)} cannot appoint.`);
    }
    if (appointments >= appointmentLimit) {
      return fail(`${courtPowerName(powerKey)} already used ${appointmentLimit} appointments this round and cannot appoint again until the next one.`);
    }
  } else if (actionKind === 'revoke') {
    const revocationLimit = getCourtPowerRevocationLimit(powerKey);
    if (revocations >= revocationLimit) {
      return fail(`${courtPowerName(powerKey)} already used ${revocationLimit} revocations this round and cannot revoke again until the next one.`);
    }
  }
  const actionLimit = getCourtPowerActionLimit(powerKey);
  if (totalActions >= actionLimit) {
    return fail(`${courtPowerName(powerKey)} already used its ${actionLimit} actions this round.`);
  }
  return { ok: true };
}

function canCourtPowerUseActionKind(state, playerId, powerKey, actionKind) {
  return checkCourtActionAvailable(state, playerId, powerKey, actionKind).ok;
}

export function isTitleAppointedThisTurn(state, slotKey) {
  return Boolean(state?.courtActions?.appointedThisTurn?.[slotKey]);
}

export function isTitleRevokedThisTurn(state, slotKey) {
  return Boolean(state?.courtActions?.revokedThisTurn?.[slotKey]);
}

function markTitleAppointedThisTurn(state, slotKey) {
  ensureCourtActionState(state).appointedThisTurn[slotKey] = true;
}

function markTitleRevokedThisTurn(state, slotKey) {
  ensureCourtActionState(state).revokedThisTurn[slotKey] = true;
}

function currentTurnTitleBlock(state, slotKey, label = 'That office') {
  return isTitleAppointedThisTurn(state, slotKey)
    ? fail(`${label} was appointed this round and cannot be revoked until the next one.`)
    : { ok: true };
}

function currentTurnRevokedBlock(state, slotKey, label = 'That office') {
  return isTitleRevokedThisTurn(state, slotKey)
    ? fail(`${label} was revoked this round and cannot be filled again until the next one.`)
    : { ok: true };
}

export function checkRevocationCurrentTurnAppointment(state, revocationValue) {
  const [kind, id, type] = String(revocationValue || '').split(':');
  if (kind === 'minor') {
    return currentTurnTitleBlock(state, getMinorTitleSlotKey(id, type), `The ${type} of ${themeName(state, id)}`);
  }
  return { ok: true };
}

function checkAppointmentTargetCooldown(state, appointerId, appointeeId) {
  if (!hasAppointmentTargetLock(state, appointerId, appointeeId)) return { ok: true };
  const targetLabel = appointeeId === appointerId ? 'yourself' : getPlayerLabel(state, appointeeId);
  return fail(`You cannot appoint ${targetLabel} twice in a row. Appoint someone else first.`);
}

function checkRevocationTargetCooldown(state, revokerId, targetPlayerId) {
  if (!hasRevocationTargetLock(state, revokerId, targetPlayerId)) return { ok: true };
  return fail(`${getPlayerLabel(state, revokerId)} cannot revoke ${getPlayerLabel(state, targetPlayerId)} twice in a row. Revoke someone else first.`);
}

function canAppointWithPromise(state, appointerId, appointeeId) {
  const cooldown = checkAppointmentTargetCooldown(state, appointerId, appointeeId);
  if (!cooldown.ok) return cooldown;
  return validateAppointmentPromiseChoice(state, appointerId, appointeeId);
}

function recordAppointment(state, appointerId, appointeeId, slotKey, powerKey) {
  markTitleAppointedThisTurn(state, slotKey);
  consumeAppointmentPromise(state, appointerId, appointeeId);
  recordAppointmentChoice(state, appointerId, appointeeId);
  markCourtActionUsed(state, appointerId, powerKey, 'appoint');
}

function recordRevocation(state, revokerId, targetPlayerId, slotKeys, powerKey) {
  for (const slotKey of slotKeys.filter(Boolean)) markTitleRevokedThisTurn(state, slotKey);
  recordRevocationChoice(state, revokerId, targetPlayerId);
  markCourtActionUsed(state, revokerId, powerKey, 'revoke');
}

// Appointments
export function appointStrategos(state, appointerId, themeId, appointeeId) {
  const theme = state.themes[themeId];
  if (!theme || theme.id === 'CPL') return fail('Choose a province.');
  if (theme.lost) return fail(`${theme.name} is lost: no Strategos can be appointed there until it is retaken.`);
  if (!isValidPlayerId(state, appointeeId)) return fail('Choose a dynasty to appoint.');
  if (theme.strategos !== null) return fail(`${theme.name} already has a Strategos.`);
  const requiredTitle = STRATEGOS_TITLE_BY_REGION[theme.region];
  if (!requiredTitle || !getPlayer(state, appointerId)?.majorTitles.includes(requiredTitle)) {
    return fail('Only the regional Domestic or Admiral can appoint this strategos.');
  }
  const actionCheck = checkCourtActionAvailable(state, appointerId, requiredTitle, 'appoint');
  if (!actionCheck.ok) return actionCheck;
  const slotKey = getMinorTitleSlotKey(themeId, 'strategos');
  const sameTurn = currentTurnRevokedBlock(state, slotKey, `The strategos of ${themeName(state, themeId)}`);
  if (!sameTurn.ok) return sameTurn;
  const appointmentCheck = canAppointWithPromise(state, appointerId, appointeeId);
  if (!appointmentCheck.ok) return appointmentCheck;

  theme.strategos = appointeeId;
  recordAppointment(state, appointerId, appointeeId, slotKey, requiredTitle);
  state.log.push({ type: 'appoint_strategos', appointer: appointerId, appointee: appointeeId, theme: themeId, round: state.round });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'appoint_strategos',
    actorId: appointerId,
    summary: `${getPlayerLabel(state, appointerId)} appoints ${getPlayerLabel(state, appointeeId)} as strategos of ${themeName(state, themeId)}.`,
    details: { appointeeId, appointeeName: getPlayerLabel(state, appointeeId), themeId, themeName: themeName(state, themeId) },
  });
  return { ok: true };
}

export function appointBishop(state, appointerId, themeId, appointeeId) {
  const theme = state.themes[themeId];
  if (!theme || theme.id === 'CPL') return fail('Choose a bishopric.');
  if (!isValidPlayerId(state, appointeeId)) return fail('Choose a dynasty to appoint.');
  if (theme.bishop !== null) return fail(`${theme.name} already has a Bishop.`);
  if ((Number(theme.origin?.C) || 0) < 1) return fail(`${theme.name} is not a bishopric.`);
  if (!getPlayer(state, appointerId)?.majorTitles.includes('PATRIARCH')) return fail('Only the Patriarch can appoint bishops.');
  const actionCheck = checkCourtActionAvailable(state, appointerId, 'PATRIARCH', 'appoint');
  if (!actionCheck.ok) return actionCheck;
  const slotKey = getMinorTitleSlotKey(themeId, 'bishop');
  const sameTurn = currentTurnRevokedBlock(state, slotKey, `The bishop of ${themeName(state, themeId)}`);
  if (!sameTurn.ok) return sameTurn;
  const appointmentCheck = canAppointWithPromise(state, appointerId, appointeeId);
  if (!appointmentCheck.ok) return appointmentCheck;

  theme.bishop = appointeeId;
  recordAppointment(state, appointerId, appointeeId, slotKey, 'PATRIARCH');
  state.log.push({ type: 'appoint_bishop', appointer: appointerId, appointee: appointeeId, theme: themeId, round: state.round });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'appoint_bishop',
    actorId: appointerId,
    summary: `${getPlayerLabel(state, appointerId)} appoints ${getPlayerLabel(state, appointeeId)} as bishop of ${themeName(state, themeId)}.`,
    details: { appointeeId, appointeeName: getPlayerLabel(state, appointeeId), themeId, themeName: themeName(state, themeId) },
  });
  return { ok: true };
}

// Revocations
export function canPlayerRevokeStrategos(state, playerId, themeId) {
  const theme = state.themes[themeId];
  if (!theme) return false;
  if (playerId === state.basileusId) return true;
  const requiredTitle = STRATEGOS_TITLE_BY_REGION[theme.region];
  return Boolean(requiredTitle && getPlayer(state, playerId)?.majorTitles?.includes(requiredTitle));
}

export function canPlayerRevokeBishop(state, playerId) {
  return Boolean(getPlayer(state, playerId)?.majorTitles?.includes('PATRIARCH'));
}

export function revokeMinorTitle(state, themeId, titleType, revokerId = state.basileusId) {
  const theme = state.themes[themeId];
  if (!theme) return fail('Choose a province.');
  if (titleType !== 'strategos' && titleType !== 'bishop') return fail('Choose a Strategos or a Bishop.');
  if (titleType === 'strategos' && theme.strategos == null) return fail(`${theme.name} has no Strategos.`);
  if (titleType === 'bishop' && theme.bishop == null) return fail(`${theme.name} has no Bishop.`);
  if (titleType === 'strategos' && theme.lost) {
    return fail(`${themeName(state, themeId)} is lost; its Strategos cannot be revoked until it is reconquered.`);
  }
  const slotKey = getMinorTitleSlotKey(themeId, titleType);
  const sameTurn = currentTurnTitleBlock(state, slotKey, `The ${titleType} of ${themeName(state, themeId)}`);
  if (!sameTurn.ok) return sameTurn;
  const powerKey = titleType === 'strategos' && revokerId === state.basileusId
    ? 'BASILEUS'
    : titleType === 'strategos'
      ? STRATEGOS_TITLE_BY_REGION[theme.region]
      : 'PATRIARCH';
  if (titleType === 'strategos' && !canPlayerRevokeStrategos(state, revokerId, themeId)) {
    return fail('Only the regional Domestic or Admiral can revoke this strategos.');
  }
  if (titleType === 'bishop' && !canPlayerRevokeBishop(state, revokerId)) {
    return fail('Only the Patriarch can revoke bishops.');
  }
  const actionCheck = checkCourtActionAvailable(state, revokerId, powerKey, 'revoke');
  if (!actionCheck.ok) return actionCheck;
  const targetPlayerId = titleType === 'strategos' ? theme.strategos : theme.bishop;
  const targetCheck = checkRevocationTargetCooldown(state, revokerId, targetPlayerId);
  if (!targetCheck.ok) return targetCheck;

  if (titleType === 'strategos') theme.strategos = null;
  else theme.bishop = null;
  recordRevocation(state, revokerId, targetPlayerId, [slotKey], powerKey);
  state.log.push({ type: 'revoke_minor', theme: themeId, titleType, round: state.round, revokerId });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_minor_title',
    actorId: revokerId,
    summary: `${getPlayerLabel(state, revokerId)} revokes the ${titleType} of ${themeName(state, themeId)}.`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
      titleType,
      revokedPlayerId: targetPlayerId,
      revokedPlayerIds: [targetPlayerId],
      revokedPlayerName: getPlayerLabel(state, targetPlayerId),
    },
  });
  return { ok: true };
}

export function getEstateRevocationValue(themeId, playerId) {
  return `estates:${themeId}:${playerId}`;
}

// One Basileus action takes every estate a dynasty holds in one province,
// except the ones it built in the latest Estates phase.
export function canRevokeEstates(state, themeId, targetPlayerId, revokerId = state.basileusId) {
  const theme = state.themes[themeId];
  const targetId = Number(targetPlayerId);
  if (!theme || !canHoldEstates(theme) || !Number.isInteger(targetId) || getEstateCount(theme, targetId) <= 0) {
    return fail('No estates to revoke there.');
  }
  if (revokerId !== state.basileusId) return fail('Only the Basileus can revoke estates.');
  if (theme.lost) return fail(`${themeName(state, themeId)} is lost; its estates cannot be revoked until it is reconquered.`);
  if (getRevocableEstateCount(theme, targetId) <= 0) {
    return fail(`${getPlayerLabel(state, targetId)}'s estates in ${themeName(state, themeId)} were built last round and cannot be revoked yet.`);
  }
  const actionCheck = checkCourtActionAvailable(state, revokerId, 'BASILEUS', 'revoke');
  if (!actionCheck.ok) return actionCheck;
  const targetCheck = checkRevocationTargetCooldown(state, revokerId, targetId);
  if (!targetCheck.ok) return targetCheck;
  return { ok: true, theme, targetPlayerId: targetId, count: getRevocableEstateCount(theme, targetId) };
}

export function revokeEstates(state, themeId, targetPlayerId, revokerId = state.basileusId) {
  const check = canRevokeEstates(state, themeId, targetPlayerId, revokerId);
  if (!check.ok) return check;
  const { theme, targetPlayerId: targetId } = check;
  const removed = removeRevocableEstates(theme, targetId);
  const refund = removed * (Number(BALANCE.ESTATE_REVOCATION_REFUND) || 0);
  if (refund > 0) getPlayer(state, targetId).gold += refund;
  recordRevocation(state, revokerId, targetId, [getEstateRevocationValue(themeId, targetId)], 'BASILEUS');
  state.log.push({ type: 'revoke_estates', theme: themeId, player: targetId, count: removed, round: state.round, revokerId });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_estates',
    actorId: revokerId,
    summary: `${getPlayerLabel(state, revokerId)} revokes ${removed} estate${removed === 1 ? '' : 's'} of ${getPlayerLabel(state, targetId)} in ${themeName(state, themeId)}.`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
      count: removed,
      refund,
      revokedPlayerId: targetId,
      revokedPlayerIds: [targetId],
      revokedPlayerName: getPlayerLabel(state, targetId),
    },
  });
  return { ok: true, count: removed, refund };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hasBasileusRevocationTarget(state) {
  return Object.values(state.themes || {}).some((theme) => (
    theme.id !== 'CPL'
    && (
      (
        theme.strategos != null
        && !theme.lost
        && !isTitleAppointedThisTurn(state, getMinorTitleSlotKey(theme.id, 'strategos'))
      )
      || getProvinceEstateHolders(theme).some((holder) => (
        canRevokeEstates(state, theme.id, holder.playerId, state.basileusId).ok
      ))
    )
  ));
}

function hasStrategosAppointmentTarget(state, powerKey) {
  const region = MAJOR_TITLES[powerKey]?.region;
  if (!region) return false;
  return Object.values(state.themes || {}).some((theme) => (
    theme.id !== 'CPL'
    && !theme.lost
    && theme.strategos == null
    && theme.region === region
    && !isTitleRevokedThisTurn(state, getMinorTitleSlotKey(theme.id, 'strategos'))
  ));
}

function hasStrategosRevocationTarget(state, powerKey) {
  const region = MAJOR_TITLES[powerKey]?.region;
  if (!region) return false;
  return Object.values(state.themes || {}).some((theme) => (
    theme.id !== 'CPL'
    && theme.region === region
    && theme.strategos != null
    && !theme.lost
    && !isTitleAppointedThisTurn(state, getMinorTitleSlotKey(theme.id, 'strategos'))
  ));
}

function hasBishopAppointmentTarget(state) {
  return Object.values(state.themes || {}).some((theme) => (
    theme.id !== 'CPL'
    && theme.bishop == null
    && (Number(theme.origin?.C) || 0) >= 1
    && !isTitleRevokedThisTurn(state, getMinorTitleSlotKey(theme.id, 'bishop'))
  ));
}

function hasBishopRevocationTarget(state) {
  return Object.values(state.themes || {}).some((theme) => (
    theme.id !== 'CPL'
    && theme.bishop != null
    && !isTitleAppointedThisTurn(state, getMinorTitleSlotKey(theme.id, 'bishop'))
  ));
}

export function getCourtPowerKeys(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return [];
  return unique([
    playerId === state.basileusId ? 'BASILEUS' : null,
    ...(player.majorTitles || []),
    ...getUsedCourtPowers(state, playerId),
  ]);
}

function canPlayerUseCourtPower(state, playerId, powerKey) {
  const player = getPlayer(state, playerId);
  if (!player) return false;
  if (powerKey === 'BASILEUS') return playerId === state.basileusId;
  return (player.majorTitles || []).includes(powerKey);
}

export function passCourtPower(state, playerId, powerKey) {
  const normalizedPowerKey = String(powerKey || '').trim();
  if (state.phase !== 'court') return fail('Appointments and revocations are only possible in the Offices phase.');
  if (state.courtActions?.playerConfirmed?.has(playerId)) return fail('You already locked your offices this round.');
  if (!normalizedPowerKey || !canPlayerUseCourtPower(state, playerId, normalizedPowerKey)) {
    return fail('Choose one of your major offices to pass.');
  }
  if (isCourtPowerPassed(state, playerId, normalizedPowerKey)) {
    return fail(`${courtPowerName(normalizedPowerKey)} already passed this round.`);
  }
  if (isCourtPowerExhausted(state, playerId, normalizedPowerKey)) {
    return fail(`${courtPowerName(normalizedPowerKey)} already used its ${getCourtPowerActionLimit(normalizedPowerKey)} actions this round.`);
  }
  markCourtPowerPassed(state, playerId, normalizedPowerKey);
  return { ok: true };
}

export function hasCourtPowerOptions(state, playerId, powerKey) {
  if (state.phase !== 'court') return false;
  if (state.courtActions?.playerConfirmed?.has(playerId)) return false;
  if (isCourtPowerExhausted(state, playerId, powerKey)) return false;
  const canAppoint = canCourtPowerUseActionKind(state, playerId, powerKey, 'appoint');
  const canRevoke = canCourtPowerUseActionKind(state, playerId, powerKey, 'revoke');
  if (powerKey === 'BASILEUS') {
    return playerId === state.basileusId
      && canRevoke
      && hasBasileusRevocationTarget(state);
  }
  if (powerKey === 'PATRIARCH') {
    return getPlayer(state, playerId)?.majorTitles?.includes('PATRIARCH')
      && (
        (canAppoint && hasBishopAppointmentTarget(state))
        || (canRevoke && hasBishopRevocationTarget(state))
      );
  }
  if (powerKey === 'DOM_EAST' || powerKey === 'DOM_WEST' || powerKey === 'ADMIRAL') {
    return getPlayer(state, playerId)?.majorTitles?.includes(powerKey)
      && (
        (canAppoint && hasStrategosAppointmentTarget(state, powerKey))
        || (canRevoke && hasStrategosRevocationTarget(state, powerKey))
      );
  }
  return false;
}

export function getAvailableCourtPowers(state, playerId) {
  return getCourtPowerKeys(state, playerId).filter((powerKey) => (
    hasCourtPowerOptions(state, playerId, powerKey)
  ));
}

export function isCourtPlayerFinished(state, playerId) {
  if (state.phase !== 'court') return false;
  if (state.courtActions?.playerConfirmed?.has(playerId)) return true;
  return getAvailableCourtPowers(state, playerId).length === 0;
}

export function autoConfirmFinishedCourtPlayer(state, playerId) {
  if (!state || state.phase !== 'court') return false;
  const courtActions = ensureCourtActionState(state);
  if (courtActions.playerConfirmed.has(playerId)) return false;
  if (!isCourtPlayerFinished(state, playerId)) return false;
  courtActions.playerConfirmed.add(playerId);
  autoRefuseAwaitingDeals(state, playerId);
  return true;
}

export function autoConfirmFinishedCourtPlayers(state) {
  if (!state || state.phase !== 'court') return 0;
  let confirmed = 0;
  for (const player of state.players || []) {
    if (autoConfirmFinishedCourtPlayer(state, player.id)) confirmed += 1;
  }
  return confirmed;
}

// Where a coup contribution comes from, for the Resolution panel and history.
function getSupportSource(entry) {
  if (entry?.titleKey === 'BASILEUS') return 'walls';
  if (entry?.titleKey === 'PATRIARCH') return 'patriarch';
  if (entry?.kind === 'reconquest') return 'triumph';
  if (entry?.kind === 'lost_provinces') return 'unrest';
  return 'support';
}

const COUP_TIE_EPSILON = 1e-9;

function getPatriarchSupportByCandidate(contributions) {
  const support = {};
  for (const entry of contributions || []) {
    if (entry?.titleKey !== 'PATRIARCH') continue;
    const candidateId = Number(entry.candidateId);
    const votes = Number(entry.votes ?? entry.troops) || 0;
    if (!Number.isInteger(candidateId) || votes <= 0) continue;
    support[candidateId] = (support[candidateId] || 0) + votes;
  }
  return support;
}

function resolveCoupTie(state, tied, patriarchSupport) {
  const tiedCandidateIds = tied.map(([candidateId]) => Number(candidateId));
  const patriarchRanked = tied
    .map(([candidateId]) => ({
      candidateId: Number(candidateId),
      support: patriarchSupport[Number(candidateId)] || 0,
    }))
    .sort((left, right) => (right.support - left.support) || (left.candidateId - right.candidateId));
  const topPatriarchSupport = patriarchRanked[0]?.support || 0;
  const patriarchTied = patriarchRanked.filter((entry) => (
    Math.abs(entry.support - topPatriarchSupport) < COUP_TIE_EPSILON
  ));

  if (topPatriarchSupport > 0 && patriarchTied.length === 1) {
    return {
      winner: patriarchTied[0].candidateId,
      tieBreak: {
        method: 'patriarch',
        tiedCandidateIds,
        patriarchSupport: Object.fromEntries(
          patriarchRanked.map((entry) => [entry.candidateId, entry.support]),
        ),
      },
    };
  }

  if (tiedCandidateIds.includes(state.basileusId)) {
    return {
      winner: state.basileusId,
      tieBreak: {
        method: 'incumbent',
        tiedCandidateIds,
        patriarchSupport: Object.fromEntries(
          patriarchRanked.map((entry) => [entry.candidateId, entry.support]),
        ),
      },
    };
  }

  return {
    winner: Number(tied[0][0]),
    tieBreak: {
      method: 'seat_order',
      tiedCandidateIds,
      patriarchSupport: Object.fromEntries(
        patriarchRanked.map((entry) => [entry.candidateId, entry.support]),
      ),
    },
  };
}

// Every claimant's support: troops in Constantinople and the Patriarch's
// influence follow their owner's first and second choice; the Theodosian
// Walls, Triumph and Unrest apply to their holder directly. Most support
// wins; with nobody supported, the Basileus keeps the throne.
export function resolveCoup(state, allOrders, capitalTroops) {
  const ballots = [];
  const candidateVotes = {};
  const contributions = [];

  const addChoices = (pid, choices, sourceTroops, source, passiveEntry = null) => {
    const shares = getCoupChoiceShares(choices);
    for (const share of shares) {
      const votes = sourceTroops * share.weight;
      if (!(votes > 0)) continue;
      candidateVotes[share.candidateId] = (candidateVotes[share.candidateId] || 0) + votes;
      contributions.push({
        playerId: pid,
        candidateId: share.candidateId,
        troops: votes,
        votes,
        sourceTroops,
        choice: share.choiceIndex + 1,
        weight: share.weight,
        source,
        passive: Boolean(passiveEntry),
        supportId: passiveEntry?.id,
        supportKind: passiveEntry?.kind,
        supportLabel: passiveEntry?.label,
        titleKey: passiveEntry?.titleKey || null,
      });
    }
    return shares;
  };

  for (const [pidStr, orders] of Object.entries(allOrders || {})) {
    const pid = Number(pidStr);
    const troops = Math.max(0, Number(capitalTroops[pid]) || 0);
    const choices = normalizeCoupChoices(state, orders?.coupChoices);
    const shares = addChoices(pid, choices, troops, 'troops');
    ballots.push({
      playerId: pid,
      candidateId: choices[0] ?? null,
      coupChoices: choices,
      troops,
      shares: shares.map((share) => ({ ...share, votes: troops * share.weight })),
    });
  }

  const passiveSupport = getCapitalSupportEntries(state);
  for (const entry of passiveSupport) {
    const holderId = Number(entry.playerId);
    const amount = Number(entry.amount) || 0;
    if (!Number.isInteger(holderId) || amount === 0) continue;
    const source = getSupportSource(entry);
    if (source === 'patriarch') {
      const choices = normalizeCoupChoices(state, allOrders?.[holderId]?.coupChoices ?? buildDefaultCoupChoices(state, holderId));
      addChoices(holderId, choices, Math.max(0, amount), source, entry);
      continue;
    }
    candidateVotes[holderId] = (candidateVotes[holderId] || 0) + amount;
    contributions.push({
      playerId: holderId,
      candidateId: holderId,
      troops: amount,
      votes: amount,
      sourceTroops: amount,
      choice: 0,
      weight: 1,
      source,
      passive: true,
      supportId: entry.id,
      supportKind: entry.kind,
      supportLabel: entry.label,
      titleKey: entry.titleKey || null,
    });
  }

  let winner = state.basileusId;
  let tieBreak = null;
  const candidates = Object.entries(candidateVotes)
    .filter(([, votes]) => votes > 0)
    .sort((a, b) => (b[1] - a[1]) || (Number(a[0]) - Number(b[0])));
  if (candidates.length > 0) {
    const maxVotes = candidates[0][1];
    const tied = candidates.filter((candidate) => Math.abs(candidate[1] - maxVotes) < COUP_TIE_EPSILON);
    if (tied.length > 1) {
      const resolved = resolveCoupTie(state, tied, getPatriarchSupportByCandidate(contributions));
      winner = resolved.winner;
      tieBreak = resolved.tieBreak;
    } else {
      winner = Number(tied[0][0]);
    }
  }
  return { winner, votes: candidateVotes, contributions, ballots, passiveSupport, tieBreak };
}

export function validateMajorTitleAssignments(state, basileusId, titleAssignments) {
  const titleKeys = Object.keys(MAJOR_TITLES);
  const nonBasileusIds = state.players.filter((player) => player.id !== basileusId).map((player) => player.id);
  const playerIdSet = new Set(state.players.map((player) => player.id));

  for (const titleKey of titleKeys) {
    const assignedPlayerId = Number(titleAssignments[titleKey]);
    if (!Number.isInteger(assignedPlayerId) || !playerIdSet.has(assignedPlayerId)) {
      return fail(`Choose a holder for ${MAJOR_TITLES[titleKey].name}.`);
    }
    if (assignedPlayerId === basileusId) return fail('The Basileus cannot hold a major office.');
  }

  const assignedCounts = {};
  for (const assignedPlayerId of Object.values(titleAssignments)) {
    assignedCounts[assignedPlayerId] = (assignedCounts[assignedPlayerId] || 0) + 1;
  }

  const expectedDistribution = [...MAJOR_TITLE_DISTRIBUTION[state.players.length]].sort((a, b) => b - a);
  const actualDistribution = nonBasileusIds.map((playerId) => assignedCounts[playerId] || 0).sort((a, b) => b - a);
  const distributionMatches = expectedDistribution.length === actualDistribution.length
    && expectedDistribution.every((count, index) => count === actualDistribution[index]);
  if (!distributionMatches) {
    return fail(`Hand out the major offices ${expectedDistribution.join('-')} among the other dynasties.`);
  }
  return { ok: true, assignedCounts };
}

export function suggestMajorTitleAssignments(state, basileusId = state.basileusId) {
  const titleKeys = Object.keys(MAJOR_TITLES);
  const expectedDistribution = [...MAJOR_TITLE_DISTRIBUTION[state.players.length]].sort((a, b) => b - a);
  const eligiblePlayers = state.players
    .filter((player) => player.id !== basileusId)
    .map((player) => ({
      id: player.id,
      currentCount: player.majorTitles.filter((titleKey) => titleKeys.includes(titleKey)).length,
    }))
    .sort((a, b) => (b.currentCount - a.currentCount) || (a.id - b.id));

  const quotas = new Map(eligiblePlayers.map((player, index) => [player.id, expectedDistribution[index] || 0]));
  const assignedCounts = new Map(eligiblePlayers.map((player) => [player.id, 0]));
  const assignments = {};

  for (const titleKey of titleKeys) {
    const currentHolderId = findTitleHolder(state, titleKey);
    if (
      currentHolderId !== null
      && currentHolderId !== basileusId
      && quotas.has(currentHolderId)
      && assignedCounts.get(currentHolderId) < quotas.get(currentHolderId)
    ) {
      assignments[titleKey] = currentHolderId;
      assignedCounts.set(currentHolderId, assignedCounts.get(currentHolderId) + 1);
    }
  }

  for (const titleKey of titleKeys) {
    if (assignments[titleKey] != null) continue;
    const nextPlayer = eligiblePlayers
      .slice()
      .sort((a, b) => {
        const remainingA = quotas.get(a.id) - assignedCounts.get(a.id);
        const remainingB = quotas.get(b.id) - assignedCounts.get(b.id);
        return (remainingB - remainingA) || (a.id - b.id);
      })
      .find((player) => assignedCounts.get(player.id) < quotas.get(player.id));
    if (nextPlayer) {
      assignments[titleKey] = nextPlayer.id;
      assignedCounts.set(nextPlayer.id, assignedCounts.get(nextPlayer.id) + 1);
    }
  }
  return assignments;
}

export function applyTitleRedistribution(state, basileusId = state.basileusId, titleAssignments = suggestMajorTitleAssignments(state, basileusId)) {
  const validation = validateMajorTitleAssignments(state, basileusId, titleAssignments);
  if (!validation.ok) return validation;
  for (const player of state.players) player.majorTitles = [];
  for (const [titleKey, playerId] of Object.entries(titleAssignments)) {
    if (Number(playerId) === basileusId) continue;
    getPlayer(state, Number(playerId))?.majorTitles.push(titleKey);
  }
  state.basileusId = basileusId;
  state.nextBasileusId = basileusId;
  state.majorTitleRedistributionPending = false;
  state.log.push({ type: 'title_redistribution', basileus: basileusId, round: state.round });
  recordHistoryEvent(state, {
    category: 'system',
    type: 'title_redistribution',
    actorId: basileusId,
    summary: `${getPlayerLabel(state, basileusId)} redistributes the major offices.`,
    details: {
      assignments: Object.fromEntries(Object.entries(titleAssignments).map(([titleKey, playerId]) => [
        titleKey,
        { playerId: Number(playerId), playerName: getPlayerLabel(state, Number(playerId)), titleName: MAJOR_TITLES[titleKey]?.name || titleKey },
      ])),
    },
  });
  return { ok: true };
}

export function computeWealth(state, playerId) {
  return getPlayerFinalScore(state, playerId)?.points ?? getPlayer(state, playerId)?.gold ?? 0;
}

export function computeFullWealth(state, playerId, projectedIncome) {
  void projectedIncome;
  return computeWealth(state, playerId);
}
