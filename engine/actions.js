// engine/actions.js - estates, court actions, title redistribution, and coups.
import {
  findTitleHolder,
  formatPlayerLabel,
  getPlayer,
  hasRevocationTargetLock,
  hasSelfAppointmentLock,
  recordAppointmentChoice,
  recordRevocationChoice,
} from './state.js';
import { recordHistoryEvent } from './history.js';
import { getPlayerFinalScore } from './scoring.js';
import {
  consumeAppointmentPromise,
  getSpendableGold,
  isThemeReservedByDeal,
  validateAppointmentPromiseChoice,
} from './deals.js';
import { getThemeLandPrice } from './rules.js';
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';
import { formatGold } from './presentation.js';

const STRATEGOS_TITLE_BY_REGION = {
  east: 'DOM_EAST',
  west: 'DOM_WEST',
  sea: 'ADMIRAL',
};

function playerName(state, playerId) {
  const player = getPlayer(state, playerId);
  return player ? formatPlayerLabel(player) : `Player ${Number(playerId) + 1}`;
}

function themeName(state, themeId) {
  return state.themes[themeId]?.name || themeId;
}

function courtTitleName(titleType) {
  return {
    EMPRESS: 'Empress',
    CHIEF_EUNUCHS: 'Chief of Eunuchs',
  }[titleType] || titleType;
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

export function getCourtTitleSlotKey(courtTitleType) {
  return `court:${courtTitleType}`;
}

export function getThemeOwnershipSlotKey(themeId) {
  return `theme:${themeId}`;
}

function ensureCourtActionState(state) {
  if (!state.courtActions) state.courtActions = {};
  if (!state.courtActions.actionUsed) state.courtActions.actionUsed = {};
  if (!state.courtActions.appointedThisTurn) state.courtActions.appointedThisTurn = {};
  if (!state.courtActions.revokedThisTurn) state.courtActions.revokedThisTurn = {};
  if (!state.courtActions.playerConfirmed) state.courtActions.playerConfirmed = new Set();
  return state.courtActions;
}

export function hasCourtActionUsed(state, playerId) {
  return Boolean(state?.courtActions?.actionUsed?.[playerId]);
}

export function markCourtActionUsed(state, playerId) {
  ensureCourtActionState(state).actionUsed[playerId] = true;
}

function checkCourtActionAvailable(state, playerId) {
  if (state.phase !== 'court') return fail('Court actions are only available during Court.');
  if (hasCourtActionUsed(state, playerId)) return fail('This player has already used their court action this turn.');
  return { ok: true };
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

function currentTurnTitleBlock(state, slotKey, label = 'That title') {
  return isTitleAppointedThisTurn(state, slotKey)
    ? fail(`${label} was appointed this turn and cannot be revoked until next turn.`)
    : { ok: true };
}

function currentTurnRevokedBlock(state, slotKey, label = 'That title') {
  return isTitleRevokedThisTurn(state, slotKey)
    ? fail(`${label} was revoked this turn and cannot be appointed until next turn.`)
    : { ok: true };
}

export function checkRevocationCurrentTurnAppointment(state, revocationValue) {
  const [kind, id, type] = String(revocationValue || '').split(':');
  if (kind === 'minor') {
    return currentTurnTitleBlock(state, getMinorTitleSlotKey(id, type), `The ${type} of ${themeName(state, id)}`);
  }
  if (kind === 'court') {
    return currentTurnTitleBlock(state, getCourtTitleSlotKey(id), `The ${courtTitleName(id)}`);
  }
  if (kind === 'theme') {
    const theme = state.themes?.[id];
    if (!theme) return { ok: true };
    const blocked = [];
    if (theme.strategos != null && isTitleAppointedThisTurn(state, getMinorTitleSlotKey(id, 'strategos'))) blocked.push('strategos');
    if (theme.bishop != null && isTitleAppointedThisTurn(state, getMinorTitleSlotKey(id, 'bishop'))) blocked.push('bishop');
    if (blocked.length > 0) return fail(`${themeName(state, id)} has a ${blocked.join(' and ')} appointed this turn and cannot be stripped until next turn.`);
  }
  return { ok: true };
}

function checkAppointmentTargetCooldown(state, appointerId, appointeeId) {
  if (appointeeId === appointerId && hasSelfAppointmentLock(state, appointerId)) {
    return fail('You cannot appoint yourself twice in a row. Appoint someone else first.');
  }
  return { ok: true };
}

function checkRevocationTargetCooldown(state, revokerId, targetPlayerId) {
  if (!hasRevocationTargetLock(state, revokerId, targetPlayerId)) return { ok: true };
  return fail(`${playerName(state, revokerId)} cannot revoke ${playerName(state, targetPlayerId)} twice in a row. Revoke someone else first.`);
}

function canAppointWithPromise(state, appointerId, appointeeId) {
  const cooldown = checkAppointmentTargetCooldown(state, appointerId, appointeeId);
  if (!cooldown.ok) return cooldown;
  return validateAppointmentPromiseChoice(state, appointerId, appointeeId);
}

function recordAppointment(state, appointerId, appointeeId, slotKey) {
  markTitleAppointedThisTurn(state, slotKey);
  consumeAppointmentPromise(state, appointerId, appointeeId);
  recordAppointmentChoice(state, appointerId, appointeeId);
  markCourtActionUsed(state, appointerId);
}

function recordRevocation(state, revokerId, targetPlayerId, slotKeys) {
  for (const slotKey of slotKeys.filter(Boolean)) markTitleRevokedThisTurn(state, slotKey);
  recordRevocationChoice(state, revokerId, targetPlayerId);
  markCourtActionUsed(state, revokerId);
}

function restoreOriginEconomy(theme) {
  if (!theme || theme.id === 'CPL') return;
  theme.P = Math.max(0, Number(theme.origin?.P) || 0);
  theme.T = Math.max(0, Number(theme.origin?.T) || 0);
  theme.C = Math.max(0, Number(theme.origin?.C) || 0);
}

// Estates
function ensureLandAuctions(state) {
  if (!state.landAuctions || typeof state.landAuctions !== 'object') state.landAuctions = {};
  return state.landAuctions;
}

export function getLandAuction(state, themeId) {
  return ensureLandAuctions(state)[themeId] || null;
}

export function getMinimumLandBid(state, themeId) {
  const theme = state.themes[themeId];
  const current = getLandAuction(state, themeId);
  return current ? current.amount + 1 : getThemeLandPrice(theme);
}

export function canBuyTheme(state, playerId, themeId, amount = null) {
  if (state.phase !== 'estates') return fail('Estate bidding is only available during Estates.');
  const theme = state.themes[themeId];
  if (!theme) return fail('Theme not found.');
  if (theme.occupied) return fail('Theme is occupied.');
  if (theme.owner !== null) return fail('Theme already owned.');
  if (theme.id === 'CPL') return fail('Cannot buy Constantinople.');
  const current = getLandAuction(state, themeId);
  const minimumBid = current ? current.amount + 1 : getThemeLandPrice(theme);
  const cost = amount == null ? minimumBid : Number(amount);
  if (!Number.isFinite(cost) || cost < minimumBid) {
    return fail(current ? `Bid must be higher than ${formatGold(current.amount)}.` : `Bid must be at least ${formatGold(minimumBid)}.`);
  }
  const existingOwnBid = current?.bidderId === playerId ? current.amount : 0;
  const dueNow = cost - existingOwnBid;
  const spendableGold = getSpendableGold(state, playerId);
  if (spendableGold < dueNow) return fail(`Need ${formatGold(dueNow)} of unreserved gold, have ${formatGold(spendableGold)}.`);
  return { ok: true, cost, dueNow, minimumBid, current };
}

export function buyTheme(state, playerId, themeId, amount = null) {
  const check = canBuyTheme(state, playerId, themeId, amount);
  if (!check.ok) return check;
  const player = getPlayer(state, playerId);
  const auctions = ensureLandAuctions(state);
  const previous = auctions[themeId] || null;
  if (previous && previous.bidderId !== playerId) {
    const previousBidder = getPlayer(state, previous.bidderId);
    if (previousBidder) previousBidder.gold += previous.amount;
  }
  player.gold -= check.dueNow;
  auctions[themeId] = { themeId, bidderId: playerId, amount: check.cost, round: state.round };
  state.log.push({ type: 'land_bid', player: playerId, theme: themeId, bid: check.cost, round: state.round });
  recordHistoryEvent(state, {
    category: 'estates',
    type: 'land_bid',
    actorId: playerId,
    summary: `${playerName(state, playerId)} bids ${formatGold(check.cost)} for ${themeName(state, themeId)}.`,
    details: { themeId, themeName: themeName(state, themeId), bid: check.cost },
  });
  return { ok: true };
}

export function settleLandAuctions(state) {
  const auctions = ensureLandAuctions(state);
  for (const [themeId, auction] of Object.entries(auctions)) {
    const theme = state.themes[themeId];
    const winner = getPlayer(state, Number(auction.bidderId));
    if (!theme || !winner || theme.occupied || theme.owner !== null || theme.id === 'CPL') {
      if (winner) winner.gold += Number(auction.amount) || 0;
      delete auctions[themeId];
      continue;
    }
    theme.owner = winner.id;
    state.log.push({ type: 'buy', player: winner.id, theme: themeId, cost: auction.amount, round: state.round });
    recordHistoryEvent(state, {
      category: 'estates',
      type: 'buy_theme',
      actorId: winner.id,
      summary: `${playerName(state, winner.id)} wins ${themeName(state, themeId)} for ${formatGold(auction.amount)}.`,
      details: { themeId, themeName: themeName(state, themeId), cost: auction.amount },
    });
    delete auctions[themeId];
  }
}

function relocateDisplacedBishop(state, themeId, playerId) {
  const candidates = Object.values(state.themes || {}).filter((theme) => (
    theme.id !== 'CPL'
    && theme.id !== themeId
    && !theme.occupied
    && theme.owner !== 'church'
    && theme.bishop == null
    && (Number(theme.origin?.C) || 0) >= 1
  ));
  if (candidates.length === 0) {
    recordHistoryEvent(state, {
      category: 'court',
      type: 'bishop_displaced',
      actorId: playerId,
      summary: `${playerName(state, playerId)} is displaced from the bishopric of ${themeName(state, themeId)} and finds no vacant see.`,
      details: { fromThemeId: themeId, displacedPlayerId: playerId, toThemeId: null },
    });
    return null;
  }
  if (typeof state.rng !== 'function') {
    // The engine guarantees a seeded RNG (see README "Deterministic core").
    // Falling back to Math.random would silently break reproducibility, so
    // surface the missing RNG as a hard error instead.
    throw new Error('engine/actions.js: state.rng is required (deterministic core).');
  }
  const nextTheme = candidates[Math.floor(state.rng() * candidates.length)];
  nextTheme.bishop = playerId;
  nextTheme.bishopIsDonor = false;
  markTitleAppointedThisTurn(state, getMinorTitleSlotKey(nextTheme.id, 'bishop'));
  recordHistoryEvent(state, {
    category: 'court',
    type: 'bishop_displaced',
    actorId: playerId,
    summary: `${playerName(state, playerId)} is displaced from ${themeName(state, themeId)} to ${themeName(state, nextTheme.id)}.`,
    details: { fromThemeId: themeId, displacedPlayerId: playerId, toThemeId: nextTheme.id },
  });
  return nextTheme.id;
}

export function giftToChurch(state, playerId, themeId) {
  const actionCheck = checkCourtActionAvailable(state, playerId);
  if (!actionCheck.ok) return actionCheck;
  const theme = state.themes[themeId];
  if (!theme || theme.owner !== playerId) return fail('You can only gift your own private estate.');
  if (theme.occupied) return fail('Occupied estates cannot be gifted.');
  if ((Number(theme.origin?.C) || 0) < 1) return fail('Only provinces with original church value can be gifted.');
  if (isThemeReservedByDeal(state, themeId)) return fail(`${themeName(state, themeId)} is reserved by an accepted deal and cannot be gifted away.`);

  const displacedBishop = theme.bishop;
  theme.owner = 'church';
  theme.suspendedOwner = null;
  theme.strategos = null;
  theme.bishop = playerId;
  theme.bishopIsDonor = true;
  theme.C = (Number(theme.origin.P) || 0) + (Number(theme.origin.T) || 0) + (Number(theme.origin.C) || 0);
  theme.P = 0;
  theme.T = 0;

  if (displacedBishop != null && displacedBishop !== playerId) {
    relocateDisplacedBishop(state, themeId, displacedBishop);
  }

  markTitleAppointedThisTurn(state, getMinorTitleSlotKey(themeId, 'bishop'));
  markCourtActionUsed(state, playerId);
  state.log.push({ type: 'gift_church', player: playerId, theme: themeId, round: state.round });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'gift_theme_to_church',
    actorId: playerId,
    summary: `${playerName(state, playerId)} gifts ${themeName(state, themeId)} to the church and becomes its bishop.`,
    details: { themeId, themeName: themeName(state, themeId), churchValue: theme.C },
  });
  return { ok: true };
}

// Appointments
export function appointStrategos(state, appointerId, themeId, appointeeId) {
  const actionCheck = checkCourtActionAvailable(state, appointerId);
  if (!actionCheck.ok) return actionCheck;
  const theme = state.themes[themeId];
  if (!theme || theme.occupied || theme.id === 'CPL') return fail('Invalid theme.');
  if (!isValidPlayerId(state, appointeeId)) return fail('Choose an appointee.');
  if (theme.owner === 'church') return fail('Church land cannot receive a strategos.');
  if (theme.strategos !== null) return fail('This strategos title is already appointed.');
  const requiredTitle = STRATEGOS_TITLE_BY_REGION[theme.region];
  if (!requiredTitle || !getPlayer(state, appointerId)?.majorTitles.includes(requiredTitle)) {
    return fail('Only the regional Domestic or Admiral can appoint this strategos.');
  }
  const slotKey = getMinorTitleSlotKey(themeId, 'strategos');
  const sameTurn = currentTurnRevokedBlock(state, slotKey, `The strategos of ${themeName(state, themeId)}`);
  if (!sameTurn.ok) return sameTurn;
  const appointmentCheck = canAppointWithPromise(state, appointerId, appointeeId);
  if (!appointmentCheck.ok) return appointmentCheck;

  theme.strategos = appointeeId;
  recordAppointment(state, appointerId, appointeeId, slotKey);
  state.log.push({ type: 'appoint_strategos', appointer: appointerId, appointee: appointeeId, theme: themeId, round: state.round });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'appoint_strategos',
    actorId: appointerId,
    summary: `${playerName(state, appointerId)} appoints ${playerName(state, appointeeId)} as strategos of ${themeName(state, themeId)}.`,
    details: { appointeeId, appointeeName: playerName(state, appointeeId), themeId, themeName: themeName(state, themeId) },
  });
  return { ok: true };
}

export function appointBishop(state, appointerId, themeId, appointeeId) {
  const actionCheck = checkCourtActionAvailable(state, appointerId);
  if (!actionCheck.ok) return actionCheck;
  const theme = state.themes[themeId];
  if (!theme || theme.id === 'CPL') return fail('Invalid theme.');
  if (!isValidPlayerId(state, appointeeId)) return fail('Choose an appointee.');
  if (theme.bishop !== null) return fail('This bishop title is already appointed.');
  if ((Number(theme.origin?.C) || 0) < 1) return fail('A bishop can only be appointed in a province with original church value.');
  if (!getPlayer(state, appointerId)?.majorTitles.includes('PATRIARCH')) return fail('Only the Patriarch can appoint bishops.');
  const slotKey = getMinorTitleSlotKey(themeId, 'bishop');
  const sameTurn = currentTurnRevokedBlock(state, slotKey, `The bishop of ${themeName(state, themeId)}`);
  if (!sameTurn.ok) return sameTurn;
  const appointmentCheck = canAppointWithPromise(state, appointerId, appointeeId);
  if (!appointmentCheck.ok) return appointmentCheck;

  theme.bishop = appointeeId;
  theme.bishopIsDonor = false;
  recordAppointment(state, appointerId, appointeeId, slotKey);
  state.log.push({ type: 'appoint_bishop', appointer: appointerId, appointee: appointeeId, theme: themeId, round: state.round });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'appoint_bishop',
    actorId: appointerId,
    summary: `${playerName(state, appointerId)} appoints ${playerName(state, appointeeId)} as bishop of ${themeName(state, themeId)}.`,
    details: { appointeeId, appointeeName: playerName(state, appointeeId), themeId, themeName: themeName(state, themeId) },
  });
  return { ok: true };
}

export function appointCourtTitle(state, titleType, appointeeId, appointerId = state.basileusId) {
  const actionCheck = checkCourtActionAvailable(state, appointerId);
  if (!actionCheck.ok) return actionCheck;
  if (appointerId !== state.basileusId) return fail('Only the Basileus can appoint court titles.');
  if (!isValidPlayerId(state, appointeeId)) return fail('Choose an appointee.');
  if (titleType === 'EMPRESS') {
    if (state.empress !== null) return fail('The Empress title is already appointed.');
  } else if (titleType === 'CHIEF_EUNUCHS') {
    if (state.chiefEunuchs !== null) return fail('The Chief of Eunuchs title is already appointed.');
  } else {
    return fail('Invalid court title.');
  }
  const slotKey = getCourtTitleSlotKey(titleType);
  const sameTurn = currentTurnRevokedBlock(state, slotKey, `The ${courtTitleName(titleType)}`);
  if (!sameTurn.ok) return sameTurn;
  const appointmentCheck = canAppointWithPromise(state, appointerId, appointeeId);
  if (!appointmentCheck.ok) return appointmentCheck;

  if (titleType === 'EMPRESS') state.empress = appointeeId;
  else state.chiefEunuchs = appointeeId;
  recordAppointment(state, appointerId, appointeeId, slotKey);
  state.log.push({ type: 'appoint_court', title: titleType, appointee: appointeeId, round: state.round });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'appoint_court_title',
    actorId: appointerId,
    summary: `${playerName(state, appointerId)} appoints ${playerName(state, appointeeId)} as ${courtTitleName(titleType)}.`,
    details: { titleType, titleName: courtTitleName(titleType), appointeeId, appointeeName: playerName(state, appointeeId) },
  });
  return { ok: true };
}

// Revocations
export function canPlayerRevokeStrategos(state, playerId, themeId) {
  const theme = state.themes[themeId];
  if (!theme) return false;
  const requiredTitle = STRATEGOS_TITLE_BY_REGION[theme.region];
  return Boolean(requiredTitle && getPlayer(state, playerId)?.majorTitles?.includes(requiredTitle));
}

export function canPlayerRevokeBishop(state, playerId) {
  return Boolean(getPlayer(state, playerId)?.majorTitles?.includes('PATRIARCH'));
}

export function revokeMajorTitle() {
  return fail('Major titles are redistributed in the Title Redistribution phase.');
}

export function revokeMinorTitle(state, themeId, titleType, revokerId = state.basileusId) {
  const actionCheck = checkCourtActionAvailable(state, revokerId);
  if (!actionCheck.ok) return actionCheck;
  const theme = state.themes[themeId];
  if (!theme) return fail('Theme not found.');
  if (titleType !== 'strategos' && titleType !== 'bishop') return fail('Invalid minor title.');
  if (titleType === 'strategos' && theme.strategos == null) return fail('That strategos title is already vacant.');
  if (titleType === 'bishop' && theme.bishop == null) return fail('That bishop title is already vacant.');
  const slotKey = getMinorTitleSlotKey(themeId, titleType);
  const sameTurn = currentTurnTitleBlock(state, slotKey, `The ${titleType} of ${themeName(state, themeId)}`);
  if (!sameTurn.ok) return sameTurn;
  if (titleType === 'strategos' && !canPlayerRevokeStrategos(state, revokerId, themeId)) {
    return fail('Only the regional Domestic or Admiral can revoke this strategos.');
  }
  if (titleType === 'bishop' && !canPlayerRevokeBishop(state, revokerId)) {
    return fail('Only the Patriarch can revoke bishops.');
  }
  const targetPlayerId = titleType === 'strategos' ? theme.strategos : theme.bishop;
  const targetCheck = checkRevocationTargetCooldown(state, revokerId, targetPlayerId);
  if (!targetCheck.ok) return targetCheck;

  if (titleType === 'strategos') theme.strategos = null;
  else {
    theme.bishop = null;
    theme.bishopIsDonor = false;
  }
  recordRevocation(state, revokerId, targetPlayerId, [slotKey]);
  state.log.push({ type: 'revoke_minor', theme: themeId, titleType, round: state.round, revokerId });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_minor_title',
    actorId: revokerId,
    summary: `${playerName(state, revokerId)} revokes the ${titleType} of ${themeName(state, themeId)}.`,
    details: { themeId, themeName: themeName(state, themeId), titleType, revokedPlayerId: targetPlayerId, revokedPlayerName: playerName(state, targetPlayerId) },
  });
  return { ok: true };
}

export function revokeCourtTitle(state, courtTitleType, revokerId = state.basileusId) {
  const actionCheck = checkCourtActionAvailable(state, revokerId);
  if (!actionCheck.ok) return actionCheck;
  if (revokerId !== state.basileusId) return fail('Only the Basileus can revoke court titles.');
  if (courtTitleType !== 'EMPRESS' && courtTitleType !== 'CHIEF_EUNUCHS') return fail('Invalid court title.');
  const holderId = courtTitleType === 'EMPRESS' ? state.empress : state.chiefEunuchs;
  if (holderId == null) return fail('Title is vacant.');
  const slotKey = getCourtTitleSlotKey(courtTitleType);
  const sameTurn = currentTurnTitleBlock(state, slotKey, `The ${courtTitleName(courtTitleType)}`);
  if (!sameTurn.ok) return sameTurn;
  const targetCheck = checkRevocationTargetCooldown(state, revokerId, holderId);
  if (!targetCheck.ok) return targetCheck;

  if (courtTitleType === 'EMPRESS') state.empress = null;
  else state.chiefEunuchs = null;
  recordRevocation(state, revokerId, holderId, [slotKey]);
  state.log.push({ type: 'revoke_court', title: courtTitleType, holder: holderId, round: state.round, revokerId });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_court_title',
    actorId: revokerId,
    summary: `${playerName(state, revokerId)} revokes the ${courtTitleName(courtTitleType)} from ${playerName(state, holderId)}.`,
    details: { titleType: courtTitleType, titleName: courtTitleName(courtTitleType), revokedPlayerId: holderId, revokedPlayerName: playerName(state, holderId) },
  });
  return { ok: true };
}

export function revokeTheme(state, themeId, revokerId = state.basileusId) {
  const actionCheck = checkCourtActionAvailable(state, revokerId);
  if (!actionCheck.ok) return actionCheck;
  const theme = state.themes[themeId];
  if (!theme || theme.owner == null || theme.owner === 'church') return fail('No private estate to revoke.');
  if (revokerId !== state.basileusId) return fail('Only the Basileus can revoke private estates.');
  const sameTurn = checkRevocationCurrentTurnAppointment(state, `theme:${themeId}`);
  if (!sameTurn.ok) return sameTurn;
  const targetPlayerId = theme.owner;
  const targetCheck = checkRevocationTargetCooldown(state, revokerId, targetPlayerId);
  if (!targetCheck.ok) return targetCheck;

  const revokedSlots = [getThemeOwnershipSlotKey(themeId)];
  if (theme.strategos != null) revokedSlots.push(getMinorTitleSlotKey(themeId, 'strategos'));
  if (theme.bishop != null) revokedSlots.push(getMinorTitleSlotKey(themeId, 'bishop'));
  theme.owner = null;
  theme.strategos = null;
  theme.bishop = null;
  theme.bishopIsDonor = false;
  recordRevocation(state, revokerId, targetPlayerId, revokedSlots);
  state.log.push({ type: 'revoke_theme', theme: themeId, round: state.round, revokerId });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_theme',
    actorId: revokerId,
    summary: `${playerName(state, revokerId)} strips ${themeName(state, themeId)} from private ownership.`,
    details: { themeId, themeName: themeName(state, themeId), revokedPlayerId: targetPlayerId, revokedPlayerName: playerName(state, targetPlayerId) },
  });
  return { ok: true };
}

export function revokeChurchLand(state, themeId, revokerId = state.basileusId) {
  const actionCheck = checkCourtActionAvailable(state, revokerId);
  if (!actionCheck.ok) return actionCheck;
  const theme = state.themes[themeId];
  if (!theme || theme.owner !== 'church') return fail('No church land to revoke.');
  if (revokerId !== state.basileusId) return fail('Only the Basileus can revoke church land.');
  const sameTurn = checkRevocationCurrentTurnAppointment(state, `theme:${themeId}`);
  if (!sameTurn.ok) return sameTurn;
  const formerBishop = theme.bishop;
  restoreOriginEconomy(theme);
  theme.owner = null;
  theme.bishop = null;
  theme.bishopIsDonor = false;
  recordRevocation(state, revokerId, Number.isInteger(formerBishop) ? formerBishop : revokerId, [
    getThemeOwnershipSlotKey(themeId),
    getMinorTitleSlotKey(themeId, 'bishop'),
  ]);
  state.log.push({ type: 'revoke_church_land', theme: themeId, round: state.round, revokerId });
  recordHistoryEvent(state, {
    category: 'court',
    type: 'church_land_revoked',
    actorId: revokerId,
    summary: `${playerName(state, revokerId)} restores ${themeName(state, themeId)} from church ownership.`,
    details: { themeId, themeName: themeName(state, themeId), formerBishopId: formerBishop },
  });
  return { ok: true };
}

export function resolveCoup(state, allOrders, capitalTroops) {
  const candidateVotes = {};
  const contributions = [];
  for (const [pidStr, orders] of Object.entries(allOrders || {})) {
    const pid = Number(pidStr);
    const candidate = Number.isInteger(Number(orders?.candidate)) ? Number(orders.candidate) : state.basileusId;
    const troops = Math.max(0, Number(capitalTroops[pid]) || 0);
    candidateVotes[candidate] = (candidateVotes[candidate] || 0) + troops;
    if (troops > 0) contributions.push({ playerId: pid, candidateId: candidate, troops });
  }

  let winner = state.basileusId;
  const candidates = Object.entries(candidateVotes)
    .filter(([, troops]) => troops > 0)
    .sort((a, b) => b[1] - a[1]);
  if (candidates.length > 0) {
    const maxVotes = candidates[0][1];
    const tied = candidates.filter((candidate) => candidate[1] === maxVotes);
    winner = tied.some(([candidateId]) => Number(candidateId) === state.basileusId)
      ? state.basileusId
      : Number(tied[0][0]);
  }
  return { winner, votes: candidateVotes, contributions };
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
    if (assignedPlayerId === basileusId) return fail('The Basileus cannot keep a major title.');
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
    return fail(`Major titles must be distributed as ${expectedDistribution.join('-')} among the non-Basileus players.`);
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
  state.log.push({ type: 'title_redistribution', basileus: basileusId, round: state.round });
  recordHistoryEvent(state, {
    category: 'system',
    type: 'title_redistribution',
    actorId: basileusId,
    summary: `${playerName(state, basileusId)} redistributes the major offices.`,
    details: {
      assignments: Object.fromEntries(Object.entries(titleAssignments).map(([titleKey, playerId]) => [
        titleKey,
        { playerId: Number(playerId), playerName: playerName(state, Number(playerId)), titleName: MAJOR_TITLES[titleKey]?.name || titleKey },
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
  return { ok: true };
}

export function computeWealth(state, playerId) {
  return getPlayerFinalScore(state, playerId)?.points ?? getPlayer(state, playerId)?.gold ?? 0;
}

export function computeFullWealth(state, playerId, projectedIncome) {
  void projectedIncome;
  return computeWealth(state, playerId);
}
