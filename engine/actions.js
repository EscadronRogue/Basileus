// engine/actions.js — Player actions: land purchase, gifting, appointments, revocations, coups

import {
  getPlayer,
  findTitleHolder,
  formatPlayerLabel,
  getOfficeDisplayName,
  getPlayerMercenaryTotal,
  getPlayerMercenaryTroops,
  hasSelfAppointmentLock,
  hasRevocationTargetLock,
  MERCENARY_COMPANY_KEY,
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
  validateDismissAgainstDeals,
} from './deals.js';
import {
  getMercenaryHireCost,
  getThemeLandPrice,
} from './rules.js';
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';
import { formatGold, formatMercenaries } from './presentation.js';

const PROFESSIONAL_BANNED_OFFICES = new Set(['PATRIARCH', 'EMPRESS', 'CHIEF_EUNUCHS']);

function canOfficeHoldProfessionals(officeKey) {
  return !PROFESSIONAL_BANNED_OFFICES.has(officeKey);
}

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

function officeName(state, officeKey) {
  return getOfficeDisplayName(state, officeKey);
}

function extractOfficeArmy(state, officeKey) {
  let total = 0;
  for (const player of state.players) {
    const count = player.professionalArmies[officeKey] || 0;
    if (count <= 0) continue;
    total += count;
    delete player.professionalArmies[officeKey];
  }
  return total;
}

function assignOfficeArmy(state, officeKey, playerId, count) {
  if (!canOfficeHoldProfessionals(officeKey)) return 0;
  if (!Number.isInteger(playerId) || count <= 0) return 0;
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  player.professionalArmies[officeKey] = (player.professionalArmies[officeKey] || 0) + count;
  return count;
}

function transferOfficeArmy(state, officeKey, playerId, minimumCount = 0) {
  const total = Math.max(minimumCount, extractOfficeArmy(state, officeKey));
  return assignOfficeArmy(state, officeKey, playerId, total);
}

function ensureCourtActionState(state) {
  if (!state.courtActions) state.courtActions = {};
  if (!state.courtActions.appointmentsByRecipient) state.courtActions.appointmentsByRecipient = {};
  if (!state.courtActions.revocationsUsed) state.courtActions.revocationsUsed = {};
  return state.courtActions;
}

function isValidPlayerId(state, playerId) {
  return Number.isInteger(playerId) && Boolean(getPlayer(state, playerId));
}

function getOfficeHolder(state, officeKey) {
  if (officeKey === MERCENARY_COMPANY_KEY) return null;
  if (officeKey === 'BASILEUS') return state.basileusId;
  if (officeKey === 'DOM_EAST' || officeKey === 'DOM_WEST' || officeKey === 'ADMIRAL' || officeKey === 'PATRIARCH') {
    return findTitleHolder(state, officeKey);
  }
  if (officeKey === 'EMPRESS') return state.empress ?? null;
  if (officeKey === 'CHIEF_EUNUCHS') return state.chiefEunuchs ?? null;
  if (String(officeKey).startsWith('STRAT_')) {
    const themeId = String(officeKey).replace('STRAT_', '');
    return state.themes[themeId]?.strategos ?? null;
  }
  return null;
}

function getPlayerControlledOfficeKeys(state, playerId) {
  const keys = new Set();
  for (const officeKey of Object.keys(state.currentLevies || {})) {
    if (getOfficeHolder(state, officeKey) === playerId) keys.add(officeKey);
  }
  const player = getPlayer(state, playerId);
  for (const officeKey of Object.keys(player?.professionalArmies || {})) {
    if (getOfficeHolder(state, officeKey) === playerId) keys.add(officeKey);
  }
  return [...keys];
}

export function getPlayerAvailableAppointmentTroops(state, playerId) {
  const player = getPlayer(state, playerId);
  let levies = 0;
  let professionals = 0;
  for (const officeKey of getPlayerControlledOfficeKeys(state, playerId)) {
    levies += state.currentLevies?.[officeKey] || 0;
    professionals += player?.professionalArmies?.[officeKey] || 0;
  }
  return { levies, professionals, total: levies + professionals };
}

export function getNextAppointmentCost(state, appointerId, appointeeId) {
  if (!isValidPlayerId(state, appointeeId)) return 0;
  const courtActions = ensureCourtActionState(state);
  const byAppointer = courtActions.appointmentsByRecipient[appointerId] || {};
  return Math.max(0, Number(byAppointer[appointeeId]) || 0);
}

export function canPayAppointmentCost(state, appointerId, appointeeId) {
  if (!isValidPlayerId(state, appointeeId)) {
    return { ok: false, cost: 0, available: getPlayerAvailableAppointmentTroops(state, appointerId).total, reason: 'Choose an appointee.' };
  }
  const cost = getNextAppointmentCost(state, appointerId, appointeeId);
  const { total } = getPlayerAvailableAppointmentTroops(state, appointerId);
  if (appointeeId === appointerId && hasSelfAppointmentLock(state, appointerId)) {
    return {
      ok: false,
      cost,
      available: total,
      reason: 'You cannot appoint yourself twice in a row. Appoint someone else first.',
    };
  }
  if (cost <= 0) return { ok: true, cost, available: total };
  return total >= cost
    ? { ok: true, cost, available: total }
    : { ok: false, cost, available: total, reason: `Not enough troops to appoint (need ${cost}, have ${total}).` };
}

export function getPatriarchBishopAppointmentGoldCost(state, appointerId, appointeeId) {
  return getNextAppointmentCost(state, appointerId, appointeeId) * 2;
}

export function canPayPatriarchBishopAppointmentCost(state, appointerId, appointeeId) {
  if (!isValidPlayerId(state, appointeeId)) {
    const availableGold = getSpendableGold(state, appointerId);
    return {
      ok: false,
      cost: 0,
      goldCost: 0,
      available: availableGold,
      availableGold,
      paymentType: 'gold',
      reason: 'Choose an appointee.',
    };
  }
  const goldCost = getPatriarchBishopAppointmentGoldCost(state, appointerId, appointeeId);
  const availableGold = getSpendableGold(state, appointerId);
  if (appointeeId === appointerId && hasSelfAppointmentLock(state, appointerId)) {
    return {
      ok: false,
      cost: goldCost,
      goldCost,
      available: availableGold,
      availableGold,
      paymentType: 'gold',
      reason: 'You cannot appoint yourself twice in a row. Appoint someone else first.',
    };
  }
  if (goldCost <= 0) {
    return { ok: true, cost: goldCost, goldCost, available: availableGold, availableGold, paymentType: 'gold' };
  }
  return availableGold >= goldCost
    ? { ok: true, cost: goldCost, goldCost, available: availableGold, availableGold, paymentType: 'gold' }
    : {
        ok: false,
        cost: goldCost,
        goldCost,
        available: availableGold,
        availableGold,
        paymentType: 'gold',
        reason: `Not enough gold to appoint (need ${goldCost}, have ${availableGold}).`,
      };
}

function payAppointmentCost(state, appointerId, appointeeId) {
  const check = canPayAppointmentCost(state, appointerId, appointeeId);
  if (!check.ok) return check;
  const cost = check.cost;
  if (cost <= 0) return { ok: true, cost, leviesSpent: 0, professionalsSpent: 0 };

  const player = getPlayer(state, appointerId);
  const offices = getPlayerControlledOfficeKeys(state, appointerId);
  let remaining = cost;
  let leviesSpent = 0;
  let professionalsSpent = 0;

  for (const officeKey of offices) {
    if (remaining <= 0) break;
    const available = state.currentLevies?.[officeKey] || 0;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    state.currentLevies[officeKey] = available - take;
    remaining -= take;
    leviesSpent += take;
  }

  if (remaining > 0) {
    if (!state.suspendedProfessionals) state.suspendedProfessionals = {};
    if (!state.suspendedProfessionals[appointerId]) state.suspendedProfessionals[appointerId] = {};
    for (const officeKey of offices) {
      if (remaining <= 0) break;
      const available = player?.professionalArmies?.[officeKey] || 0;
      if (available <= 0) continue;
      const take = Math.min(available, remaining);
      player.professionalArmies[officeKey] = available - take;
      if (player.professionalArmies[officeKey] === 0) delete player.professionalArmies[officeKey];
      state.suspendedProfessionals[appointerId][officeKey] =
        (state.suspendedProfessionals[appointerId][officeKey] || 0) + take;
      remaining -= take;
      professionalsSpent += take;
    }
  }

  return { ok: true, cost, leviesSpent, professionalsSpent };
}

function payPatriarchBishopAppointmentCost(state, appointerId, appointeeId) {
  const check = canPayPatriarchBishopAppointmentCost(state, appointerId, appointeeId);
  if (!check.ok) return check;
  const cost = check.goldCost;
  if (cost > 0) getPlayer(state, appointerId).gold -= cost;
  return {
    ok: true,
    cost,
    goldCost: cost,
    goldSpent: cost,
    leviesSpent: 0,
    professionalsSpent: 0,
    paymentType: 'gold',
  };
}

function recordRevocationCostUse(state, revokerId) {
  const courtActions = ensureCourtActionState(state);
  courtActions.revocationsUsed[revokerId] = (Number(courtActions.revocationsUsed[revokerId]) || 0) + 1;
}

export function getPatriarchBishopRevocationGoldCost(state, revokerId, targetPlayerId) {
  if (!isValidPlayerId(state, targetPlayerId)) return 0;
  return getNextRevocationCost(state, revokerId) * 2;
}

export function canPayPatriarchBishopRevocationCost(state, revokerId, targetPlayerId) {
  const availableGold = getSpendableGold(state, revokerId);
  if (!isValidPlayerId(state, targetPlayerId)) {
    return {
      ok: false,
      cost: 0,
      goldCost: 0,
      available: availableGold,
      availableGold,
      paymentType: 'gold',
      reason: 'Choose a bishop to revoke.',
    };
  }
  const targetCheck = checkRevocationTargetCooldown(state, revokerId, targetPlayerId);
  const goldCost = getPatriarchBishopRevocationGoldCost(state, revokerId, targetPlayerId);
  if (!targetCheck.ok) {
    return {
      ok: false,
      cost: goldCost,
      goldCost,
      available: availableGold,
      availableGold,
      paymentType: 'gold',
      reason: targetCheck.reason,
    };
  }
  return availableGold >= goldCost
    ? { ok: true, cost: goldCost, goldCost, available: availableGold, availableGold, paymentType: 'gold' }
    : {
        ok: false,
        cost: goldCost,
        goldCost,
        available: availableGold,
        availableGold,
        paymentType: 'gold',
        reason: `Not enough gold to revoke (need ${goldCost}, have ${availableGold}).`,
      };
}

function payPatriarchBishopRevocationCost(state, revokerId, targetPlayerId) {
  const check = canPayPatriarchBishopRevocationCost(state, revokerId, targetPlayerId);
  if (!check.ok) return check;
  const cost = check.goldCost;
  if (cost > 0) getPlayer(state, revokerId).gold -= cost;
  recordRevocationCostUse(state, revokerId);
  return {
    ok: true,
    cost,
    goldCost: cost,
    goldSpent: cost,
    leviesSpent: 0,
    professionalsSpent: 0,
    paymentType: 'gold',
  };
}

function recordAppointmentCostUse(state, appointerId, appointeeId) {
  const courtActions = ensureCourtActionState(state);
  if (!courtActions.appointmentsByRecipient[appointerId]) {
    courtActions.appointmentsByRecipient[appointerId] = {};
  }
  const byRecipient = courtActions.appointmentsByRecipient[appointerId];
  byRecipient[appointeeId] = (Number(byRecipient[appointeeId]) || 0) + 1;
  recordAppointmentChoice(state, appointerId, appointeeId);
}

function describeAppointmentCost(payment) {
  return {
    cost: payment?.cost || 0,
    leviesSpent: payment?.leviesSpent || 0,
    professionalsSpent: payment?.professionalsSpent || 0,
    goldSpent: payment?.goldSpent || 0,
    paymentType: payment?.paymentType || 'troops',
  };
}

// ─── Land Purchase ───
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
  const theme = state.themes[themeId];
  if (!theme) return { ok: false, reason: 'Theme not found' };
  if (theme.occupied) return { ok: false, reason: 'Theme is occupied' };
  if (theme.owner !== null) return { ok: false, reason: 'Theme already owned' };
  if (theme.id === 'CPL') return { ok: false, reason: 'Cannot buy Constantinople' };
  const current = getLandAuction(state, themeId);
  const minimumBid = current ? current.amount + 1 : getThemeLandPrice(theme);
  const cost = amount == null ? minimumBid : Number(amount);
  if (!Number.isFinite(cost) || cost < minimumBid) {
    return {
      ok: false,
      reason: current
        ? `Bid must be higher than ${formatGold(current.amount)}.`
        : `Bid must be at least ${formatGold(minimumBid)}.`,
      cost,
      minimumBid,
      current,
    };
  }
  const existingOwnBid = current?.bidderId === playerId ? current.amount : 0;
  const dueNow = cost - existingOwnBid;
  const spendableGold = getSpendableGold(state, playerId);
  if (spendableGold < dueNow) {
    return {
      ok: false,
      reason: `Need ${formatGold(dueNow)} of unreserved gold, have ${formatGold(spendableGold)}.`,
      cost,
      dueNow,
      minimumBid,
      current,
    };
  }
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
  auctions[themeId] = {
    themeId,
    bidderId: playerId,
    amount: check.cost,
    round: state.round,
  };
  state.log.push({ type: 'land_bid', player: playerId, theme: themeId, bid: check.cost, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'land_bid',
    actorId: playerId,
    summary: `${playerName(state, playerId)} bids ${formatGold(check.cost)} for ${themeName(state, themeId)}.`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
      bid: check.cost,
      minimumBid: check.minimumBid,
      previousBidderId: previous?.bidderId ?? null,
      previousBid: previous?.amount ?? null,
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
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
    if (!theme.privateLevyReduced) {
      theme.L = Math.max(0, (Number(theme.L) || 0) - 1);
      theme.privateLevyReduced = true;
    }
    state.log.push({ type: 'buy', player: winner.id, theme: themeId, cost: auction.amount, round: state.round });
    recordHistoryEvent(state, {
      category: 'court',
      type: 'buy_theme',
      actorId: winner.id,
      summary: `${playerName(state, winner.id)} wins ${themeName(state, themeId)} for ${formatGold(auction.amount)}.`,
      details: {
        themeId,
        themeName: themeName(state, themeId),
        cost: auction.amount,
      },
    });
    delete auctions[themeId];
  }
}

// ─── Bishop seniority registry ───
function ensureBishopAppointments(state) {
  if (!Array.isArray(state.bishopAppointments)) state.bishopAppointments = [];
  return state.bishopAppointments;
}

function registerBishopAppointment(state, themeId, playerId) {
  const list = ensureBishopAppointments(state);
  // Remove any existing entry for this theme so seniority cannot be duplicated.
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].themeId === themeId) list.splice(i, 1);
  }
  list.push({ themeId, playerId });
}

function removeBishopAppointment(state, themeId) {
  const list = ensureBishopAppointments(state);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].themeId === themeId) list.splice(i, 1);
  }
}

// ─── Gift Theme to Church ───
// When a player gifts an estate to the church, the province pays no profit and no
// tax anymore — its church value becomes the former P+T so the church receives the
// full former economic output of the land. Levy stays at the current value (it has
// already been reduced when the land was privately bought). The donor automatically
// becomes the bishop of the gifted province.
export function giftToChurch(state, playerId, themeId) {
  const theme = state.themes[themeId];
  if (!theme || theme.owner !== playerId) return { ok: false, reason: 'Not your theme' };
  if (isThemeReservedByDeal(state, themeId)) {
    return { ok: false, reason: `${themeName(state, themeId)} is reserved by an accepted deal and cannot be gifted away.` };
  }
  extractOfficeArmy(state, `STRAT_${themeId}`);
  const formerProfit = Number(theme.P) || 0;
  const formerTax = Number(theme.T) || 0;
  theme.owner = 'church';
  theme.strategos = null;
  theme.P = 0;
  theme.T = 0;
  theme.C = formerProfit + formerTax;
  theme.bishop = playerId;
  theme.bishopIsDonor = true;
  registerBishopAppointment(state, themeId, playerId);
  state.log.push({ type: 'gift_church', player: playerId, theme: themeId, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'gift_theme_to_church',
    actorId: playerId,
    summary: `${playerName(state, playerId)} gifts ${themeName(state, themeId)} to the church and becomes its bishop.`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
      churchValue: theme.C,
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

// ─── Appointments ───
export function appointStrategos(state, appointerId, themeId, appointeeId) {
  const theme = state.themes[themeId];
  if (!theme || theme.occupied || theme.id === 'CPL') return { ok: false, reason: 'Invalid theme' };
  if (!isValidPlayerId(state, appointeeId)) return { ok: false, reason: 'Choose an appointee.' };
  if (theme.owner === 'church') return { ok: false, reason: 'Church land cannot receive a strategos' };
  if (theme.strategos !== null) return { ok: false, reason: 'This strategos title is already appointed' };

  const regionTitleMap = { east: 'DOM_EAST', west: 'DOM_WEST', sea: 'ADMIRAL' };
  const requiredTitle = regionTitleMap[theme.region];
  if (!requiredTitle) return { ok: false, reason: 'No domestic for this region' };

  const appointer = getPlayer(state, appointerId);
  if (!appointer.majorTitles.includes(requiredTitle) && appointerId !== state.basileusId) {
    return { ok: false, reason: 'Not the Domestic/Admiral of this region' };
  }

  const dealCheck = validateAppointmentPromiseChoice(state, appointerId, appointeeId);
  if (!dealCheck.ok) return dealCheck;
  const payment = payAppointmentCost(state, appointerId, appointeeId);
  if (!payment.ok) return { ok: false, reason: payment.reason };

  const officeKey = `STRAT_${themeId}`;
  theme.strategos = appointeeId;
  transferOfficeArmy(state, officeKey, appointeeId, 1);
  consumeAppointmentPromise(state, appointerId, appointeeId);
  recordAppointmentCostUse(state, appointerId, appointeeId);
  state.log.push({ type: 'appoint_strategos', appointer: appointerId, appointee: appointeeId, theme: themeId, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'appoint_strategos',
    actorId: appointerId,
    summary: `${playerName(state, appointerId)} appoints ${playerName(state, appointeeId)} as strategos of ${themeName(state, themeId)}, with 1 professional troop attached to the office.`,
    details: {
      appointeeId,
      appointeeName: playerName(state, appointeeId),
      themeId,
      themeName: themeName(state, themeId),
      appointmentCost: describeAppointmentCost(payment),
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

export function appointBishop(state, appointerId, themeId, appointeeId) {
  const theme = state.themes[themeId];
  if (!theme || theme.occupied || theme.id === 'CPL') return { ok: false, reason: 'Invalid theme' };
  if (!isValidPlayerId(state, appointeeId)) return { ok: false, reason: 'Choose an appointee.' };
  if (theme.bishop !== null) return { ok: false, reason: 'This bishop title is already appointed' };
  if ((Number(theme.C) || 0) < 1) {
    return { ok: false, reason: 'A bishop can only be appointed in a province with at least 1 church value.' };
  }

  const appointer = getPlayer(state, appointerId);
  if (!appointer.majorTitles.includes('PATRIARCH') && appointerId !== state.basileusId) {
    return { ok: false, reason: 'Not the Patriarch' };
  }

  const dealCheck = validateAppointmentPromiseChoice(state, appointerId, appointeeId);
  if (!dealCheck.ok) return dealCheck;
  const paysGold = appointerId !== state.basileusId && appointer.majorTitles.includes('PATRIARCH');
  const payment = paysGold
    ? payPatriarchBishopAppointmentCost(state, appointerId, appointeeId)
    : payAppointmentCost(state, appointerId, appointeeId);
  if (!payment.ok) return { ok: false, reason: payment.reason };

  theme.bishop = appointeeId;
  theme.bishopIsDonor = false;
  registerBishopAppointment(state, themeId, appointeeId);
  consumeAppointmentPromise(state, appointerId, appointeeId);
  recordAppointmentCostUse(state, appointerId, appointeeId);
  state.log.push({ type: 'appoint_bishop', appointer: appointerId, appointee: appointeeId, theme: themeId, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'appoint_bishop',
    actorId: appointerId,
    summary: `${playerName(state, appointerId)} appoints ${playerName(state, appointeeId)} as bishop of ${themeName(state, themeId)}.`,
    details: {
      appointeeId,
      appointeeName: playerName(state, appointeeId),
      themeId,
      themeName: themeName(state, themeId),
      appointmentCost: describeAppointmentCost(payment),
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

export function appointCourtTitle(state, titleType, appointeeId) {
  if (!isValidPlayerId(state, appointeeId)) return { ok: false, reason: 'Choose an appointee.' };
  const dealCheck = validateAppointmentPromiseChoice(state, state.basileusId, appointeeId);
  if (!dealCheck.ok) return dealCheck;

  if (titleType === 'EMPRESS') {
    if (state.empress !== null) return { ok: false, reason: 'The Empress title is already appointed' };
  } else if (titleType === 'CHIEF_EUNUCHS') {
    if (state.chiefEunuchs !== null) return { ok: false, reason: 'The Chief of Eunuchs title is already appointed' };
  } else {
    return { ok: false, reason: 'Invalid court title' };
  }

  const payment = payAppointmentCost(state, state.basileusId, appointeeId);
  if (!payment.ok) return { ok: false, reason: payment.reason };

  if (titleType === 'EMPRESS') state.empress = appointeeId;
  else state.chiefEunuchs = appointeeId;

  consumeAppointmentPromise(state, state.basileusId, appointeeId);
  recordAppointmentCostUse(state, state.basileusId, appointeeId);
  state.log.push({ type: 'appoint_court', title: titleType, appointee: appointeeId, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'appoint_court_title',
    actorId: state.basileusId,
    summary: `${playerName(state, state.basileusId)} appoints ${playerName(state, appointeeId)} as ${courtTitleName(titleType)}.`,
    details: {
      titleType,
      titleName: courtTitleName(titleType),
      appointeeId,
      appointeeName: playerName(state, appointeeId),
      appointmentCost: describeAppointmentCost(payment),
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

// ─── Revocation Cost ───
// Most revocations in the same round (per player) cost more troops: 1 for the
// first, 2 for the second, 3 for the third, and so on. Patriarch bishop
// revocations use the same per-revoker escalation, doubled and paid in gold.
// Professional troops sent on a revocation or appointment mission still count
// for upkeep.
export function getNextRevocationCost(state, playerId = state.basileusId) {
  const counts = state.courtActions?.revocationsUsed || {};
  return (Number(counts[playerId]) || 0) + 1;
}

export function getPlayerAvailableRevocationTroops(state, playerId = state.basileusId) {
  return getPlayerAvailableAppointmentTroops(state, playerId);
}

// Back-compat: older callers passed the Basileus implicitly. Keep the alias.
export function getBasileusAvailableTroops(state) {
  return getPlayerAvailableRevocationTroops(state, state.basileusId);
}

export function canPayRevocationCost(state, playerId = state.basileusId) {
  const cost = getNextRevocationCost(state, playerId);
  const { total } = getPlayerAvailableRevocationTroops(state, playerId);
  return total >= cost ? { ok: true, cost } : { ok: false, cost, available: total };
}

function payRevocationCost(state, playerId = state.basileusId) {
  const cost = getNextRevocationCost(state, playerId);
  const { total } = getPlayerAvailableRevocationTroops(state, playerId);
  if (total < cost) {
    return { ok: false, cost, available: total, reason: `Not enough troops to revoke (need ${cost}, have ${total}).` };
  }

  const player = getPlayer(state, playerId);
  const offices = getPlayerControlledOfficeKeys(state, playerId);
  let remaining = cost;
  let leviesSpent = 0;
  let professionalsSpent = 0;

  // Drain levies first.
  for (const officeKey of offices) {
    if (remaining <= 0) break;
    const available = state.currentLevies?.[officeKey] || 0;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    state.currentLevies[officeKey] = available - take;
    remaining -= take;
    leviesSpent += take;
  }

  // Then suspend professional troops, which return next round.
  if (remaining > 0) {
    if (!state.suspendedProfessionals) state.suspendedProfessionals = {};
    if (!state.suspendedProfessionals[playerId]) state.suspendedProfessionals[playerId] = {};
    for (const officeKey of offices) {
      if (remaining <= 0) break;
      const available = player.professionalArmies?.[officeKey] || 0;
      if (available <= 0) continue;
      const take = Math.min(available, remaining);
      player.professionalArmies[officeKey] = available - take;
      if (player.professionalArmies[officeKey] === 0) {
        delete player.professionalArmies[officeKey];
      }
      state.suspendedProfessionals[playerId][officeKey] =
        (state.suspendedProfessionals[playerId][officeKey] || 0) + take;
      remaining -= take;
      professionalsSpent += take;
    }
  }

  recordRevocationCostUse(state, playerId);

  return { ok: true, cost, leviesSpent, professionalsSpent };
}

// Restore professional troops that were suspended during revocations/appointments.
// Mission troops are paid for the round they were spent (upkeep applies to suspended
// pools too), then returned at end of cleanup so they're available next round.
export function restoreSuspendedProfessionals(state) {
  if (!state.suspendedProfessionals) return;
  for (const [pidStr, pools] of Object.entries(state.suspendedProfessionals)) {
    const player = getPlayer(state, Number(pidStr));
    if (!player) continue;
    for (const [officeKey, count] of Object.entries(pools)) {
      if (!count) continue;
      player.professionalArmies[officeKey] = (player.professionalArmies[officeKey] || 0) + count;
    }
  }
  state.suspendedProfessionals = {};
}

// Count of professional troops currently on mission (suspended) for a player.
export function getSuspendedProfessionalCount(state, playerId) {
  const pools = state.suspendedProfessionals?.[playerId];
  if (!pools) return 0;
  return Object.values(pools).reduce((total, count) => total + (Number(count) || 0), 0);
}

export function getPlayerProfessionalUpkeep(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  const activeUpkeep = Object.values(player.professionalArmies || {})
    .reduce((total, count) => total + Math.max(0, Number(count) || 0), 0);
  return activeUpkeep + getSuspendedProfessionalCount(state, playerId);
}

// ─── Revocation ───
// Major titles move only during the post-coup purge. During Court, the Basileus
// can revoke minor titles or estates, the Patriarch can revoke bishops, and the
// regional title-holders (Domestic of the East/West, Admiral) can revoke strategoi
// inside their jurisdiction. Patriarch bishop revocations are paid in gold;
// other Court revocations use the escalating troop-cost rule.
function describeRevocationCost(payment) {
  if (!payment) return null;
  return {
    cost: payment.cost,
    leviesSpent: payment.leviesSpent || 0,
    professionalsSpent: payment.professionalsSpent || 0,
    goldSpent: payment.goldSpent || 0,
    paymentType: payment.paymentType || 'troops',
  };
}

function formatCourtCostSummary(payment) {
  if (!payment) return '0 troops spent';
  if (payment.paymentType === 'gold') return `${formatGold(payment.goldSpent || payment.cost || 0)} spent`;
  return `${payment.cost} troop${payment.cost === 1 ? '' : 's'} spent`;
}

function checkRevocationTargetCooldown(state, revokerId, targetPlayerId) {
  if (!hasRevocationTargetLock(state, revokerId, targetPlayerId)) return { ok: true };
  return {
    ok: false,
    reason: `${playerName(state, revokerId)} cannot revoke ${playerName(state, targetPlayerId)} twice in a row. Revoke someone else first.`,
  };
}

const REGIONAL_REVOCATION_TITLES = {
  east: 'DOM_EAST',
  west: 'DOM_WEST',
  sea: 'ADMIRAL',
};

export function canPlayerRevokeStrategos(state, playerId, themeId) {
  if (playerId === state.basileusId) return true;
  const theme = state.themes[themeId];
  if (!theme) return false;
  const requiredTitle = REGIONAL_REVOCATION_TITLES[theme.region];
  if (!requiredTitle) return false;
  return Boolean(getPlayer(state, playerId)?.majorTitles?.includes(requiredTitle));
}

export function canPlayerRevokeBishop(state, playerId) {
  if (playerId === state.basileusId) return true;
  return Boolean(getPlayer(state, playerId)?.majorTitles?.includes('PATRIARCH'));
}

export function revokeMajorTitle(state, revokedPlayerId, titleKey, newHolderId, revokerId = state.basileusId) {
  return { ok: false, reason: 'Major titles can only be reassigned during the post-coup purge.' };
}

export function revokeMinorTitle(state, themeId, titleType, revokerId = state.basileusId) {
  const theme = state.themes[themeId];
  if (!theme) return { ok: false };
  if (titleType !== 'strategos' && titleType !== 'bishop') {
    return { ok: false, reason: 'Invalid minor title.' };
  }
  if (titleType === 'strategos' && theme.strategos == null) {
    return { ok: false, reason: 'That strategos title is already vacant.' };
  }
  if (titleType === 'bishop' && theme.bishop == null) {
    return { ok: false, reason: 'That bishop title is already vacant.' };
  }

  // Authority check: Basileus may revoke either; regional commanders revoke
  // their strategoi; the Patriarch revokes bishops.
  if (titleType === 'strategos' && !canPlayerRevokeStrategos(state, revokerId, themeId)) {
    return { ok: false, reason: 'You do not have authority to revoke this strategos.' };
  }
  if (titleType === 'bishop' && !canPlayerRevokeBishop(state, revokerId)) {
    return { ok: false, reason: 'Only the Basileus or the Patriarch can revoke a bishop.' };
  }
  const targetPlayerId = titleType === 'strategos' ? theme.strategos : theme.bishop;
  const targetCheck = checkRevocationTargetCooldown(state, revokerId, targetPlayerId);
  if (!targetCheck.ok) return targetCheck;

  const patriarchGoldRevocation = titleType === 'bishop'
    && revokerId !== state.basileusId
    && getPlayer(state, revokerId)?.majorTitles?.includes('PATRIARCH');
  const payment = patriarchGoldRevocation
    ? payPatriarchBishopRevocationCost(state, revokerId, targetPlayerId)
    : payRevocationCost(state, revokerId);
  if (!payment.ok) return { ok: false, reason: payment.reason };

  if (titleType === 'strategos') {
    extractOfficeArmy(state, `STRAT_${themeId}`);
    theme.strategos = null;
  } else {
    theme.bishop = null;
    theme.bishopIsDonor = false;
    removeBishopAppointment(state, themeId);
  }
  state.log.push({
    type: 'revoke_minor',
    theme: themeId,
    titleType,
    round: state.round,
    troopCost: payment.paymentType === 'gold' ? 0 : payment.cost,
    goldCost: payment.paymentType === 'gold' ? payment.cost : 0,
    revokerId,
  });
  recordRevocationChoice(state, revokerId, targetPlayerId);
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_minor_title',
    actorId: revokerId,
    summary: `${playerName(state, revokerId)} revokes the ${titleType} of ${themeName(state, themeId)} (${formatCourtCostSummary(payment)}).`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
      titleType,
      revocationCost: describeRevocationCost(payment),
    },
  });
  return { ok: true, cost: payment.cost, historyId: historyEvent?.id || null };
}

export function revokeCourtTitle(state, courtTitleType, revokerId = state.basileusId) {
  if (courtTitleType !== 'EMPRESS' && courtTitleType !== 'CHIEF_EUNUCHS') {
    return { ok: false, reason: 'Invalid court title' };
  }
  if (revokerId !== state.basileusId) return { ok: false, reason: 'Only the Basileus can revoke court titles' };
  const holderId = courtTitleType === 'EMPRESS' ? state.empress : state.chiefEunuchs;
  if (holderId == null) return { ok: false, reason: 'Title is vacant' };
  const targetCheck = checkRevocationTargetCooldown(state, revokerId, holderId);
  if (!targetCheck.ok) return targetCheck;

  const payment = payRevocationCost(state, revokerId);
  if (!payment.ok) return { ok: false, reason: payment.reason };

  if (courtTitleType === 'EMPRESS') state.empress = null;
  else state.chiefEunuchs = null;

  state.log.push({ type: 'revoke_court', title: courtTitleType, holder: holderId, round: state.round, troopCost: payment.cost, revokerId });
  recordRevocationChoice(state, revokerId, holderId);
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_court_title',
    actorId: revokerId,
    summary: `${playerName(state, revokerId)} revokes the ${courtTitleName(courtTitleType)} from ${playerName(state, holderId)} (${payment.cost} troop${payment.cost === 1 ? '' : 's'} spent).`,
    details: {
      titleType: courtTitleType,
      titleName: courtTitleName(courtTitleType),
      revokedPlayerId: holderId,
      revokedPlayerName: playerName(state, holderId),
      revocationCost: describeRevocationCost(payment),
    },
  });
  return { ok: true, cost: payment.cost, historyId: historyEvent?.id || null };
}

export function revokeTheme(state, themeId, revokerId = state.basileusId) {
  const theme = state.themes[themeId];
  if (!theme || theme.owner === null || theme.owner === 'church') return { ok: false };
  if (revokerId !== state.basileusId) return { ok: false, reason: 'Only the Basileus can revoke private estates' };
  const targetPlayerId = theme.owner;
  const targetCheck = checkRevocationTargetCooldown(state, revokerId, targetPlayerId);
  if (!targetCheck.ok) return targetCheck;

  const payment = payRevocationCost(state, revokerId);
  if (!payment.ok) return { ok: false, reason: payment.reason };

  extractOfficeArmy(state, `STRAT_${themeId}`);
  theme.owner = null;
  if (theme.privateLevyReduced) {
    theme.L = Math.max(0, (Number(theme.L) || 0) + 1);
    theme.privateLevyReduced = false;
  }
  theme.strategos = null;
  theme.bishop = null;
  theme.bishopIsDonor = false;
  removeBishopAppointment(state, themeId);
  state.log.push({ type: 'revoke_theme', theme: themeId, round: state.round, troopCost: payment.cost, revokerId });
  recordRevocationChoice(state, revokerId, targetPlayerId);
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_theme',
    actorId: revokerId,
    summary: `${playerName(state, revokerId)} strips ${themeName(state, themeId)} from private ownership (${payment.cost} troop${payment.cost === 1 ? '' : 's'} spent).`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
      revocationCost: describeRevocationCost(payment),
    },
  });
  return { ok: true, cost: payment.cost, historyId: historyEvent?.id || null };
}

// ─── Coup Resolution ───
export function resolveCoup(state, allOrders, capitalTroops) {
  const candidateVotes = {};
  const contributions = [];
  for (const [pidStr, orders] of Object.entries(allOrders)) {
    const pid = Number(pidStr);
    const candidate = orders.candidate;
    const troops = capitalTroops[pid] || 0;
    candidateVotes[candidate] = (candidateVotes[candidate] || 0) + troops;
    if (troops > 0) {
      contributions.push({
        playerId: pid,
        candidateId: candidate,
        troops,
      });
    }
  }

  let maxVotes = -1;
  let winner = state.basileusId;
  const candidates = Object.entries(candidateVotes)
    .filter(([, troops]) => troops > 0)
    .sort((a, b) => b[1] - a[1]);

  if (candidates.length > 0) {
    maxVotes = candidates[0][1];
    const tied = candidates.filter(c => c[1] === maxVotes);
    if (tied.some(c => Number(c[0]) === state.basileusId)) {
      winner = state.basileusId;
    } else {
      winner = Number(tied[0][0]);
    }
  }

  return { winner, votes: candidateVotes, contributions };
}

// ─── Coup Title Reassignment ───
export function validateMajorTitleAssignments(state, newBasileusId, titleAssignments) {
  const titleKeys = Object.keys(MAJOR_TITLES);
  const nonBasileusIds = state.players
    .filter(player => player.id !== newBasileusId)
    .map(player => player.id);
  const playerIdSet = new Set(state.players.map(player => player.id));

  for (const titleKey of titleKeys) {
    const assignedPlayerId = Number(titleAssignments[titleKey]);
    if (!Number.isInteger(assignedPlayerId) || !playerIdSet.has(assignedPlayerId)) {
      return { ok: false, reason: `Choose a holder for ${MAJOR_TITLES[titleKey].name}.` };
    }
    if (assignedPlayerId === newBasileusId) {
      return { ok: false, reason: 'The Basileus cannot keep a major title.' };
    }
  }

  const assignedCounts = {};
  for (const assignedPlayerId of Object.values(titleAssignments)) {
    assignedCounts[assignedPlayerId] = (assignedCounts[assignedPlayerId] || 0) + 1;
  }

  const expectedDistribution = [...MAJOR_TITLE_DISTRIBUTION[state.players.length]].sort((a, b) => b - a);
  const actualDistribution = nonBasileusIds
    .map(playerId => assignedCounts[playerId] || 0)
    .sort((a, b) => b - a);

  const distributionMatches = expectedDistribution.length === actualDistribution.length &&
    expectedDistribution.every((count, index) => count === actualDistribution[index]);

  if (!distributionMatches) {
    return {
      ok: false,
      reason: `Major titles must be distributed as ${expectedDistribution.join('-')} among the non-Basileus players.`,
    };
  }

  return { ok: true, assignedCounts };
}

export function suggestMajorTitleAssignments(state, newBasileusId) {
  const titleKeys = Object.keys(MAJOR_TITLES);
  const expectedDistribution = [...MAJOR_TITLE_DISTRIBUTION[state.players.length]].sort((a, b) => b - a);
  const eligiblePlayers = state.players
    .filter(player => player.id !== newBasileusId)
    .map(player => ({
      id: player.id,
      currentCount: player.majorTitles.filter(titleKey => titleKeys.includes(titleKey)).length,
    }))
    .sort((a, b) => (b.currentCount - a.currentCount) || (a.id - b.id));

  const quotas = new Map(eligiblePlayers.map((player, index) => [player.id, expectedDistribution[index] || 0]));
  const assignedCounts = new Map(eligiblePlayers.map(player => [player.id, 0]));
  const assignments = {};

  for (const titleKey of titleKeys) {
    const currentHolderId = findTitleHolder(state, titleKey);
    if (
      currentHolderId !== null &&
      currentHolderId !== newBasileusId &&
      quotas.has(currentHolderId) &&
      assignedCounts.get(currentHolderId) < quotas.get(currentHolderId)
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
      .find(player => assignedCounts.get(player.id) < quotas.get(player.id));

    if (nextPlayer) {
      assignments[titleKey] = nextPlayer.id;
      assignedCounts.set(nextPlayer.id, assignedCounts.get(nextPlayer.id) + 1);
    }
  }

  return assignments;
}

export function applyCoupTitleReassignment(state, newBasileusId, titleAssignments) {
  const officeArmies = {
    BASILEUS: extractOfficeArmy(state, 'BASILEUS'),
    DOM_EAST: extractOfficeArmy(state, 'DOM_EAST'),
    DOM_WEST: extractOfficeArmy(state, 'DOM_WEST'),
    ADMIRAL: extractOfficeArmy(state, 'ADMIRAL'),
  };

  for (const p of state.players) {
    p.majorTitles = [];
  }
  for (const [titleKey, playerId] of Object.entries(titleAssignments)) {
    if (playerId === newBasileusId) continue;
    const player = getPlayer(state, playerId);
    player.majorTitles.push(titleKey);
    assignOfficeArmy(state, titleKey, playerId, officeArmies[titleKey] || 0);
  }
  state.basileusId = newBasileusId;
  assignOfficeArmy(state, 'BASILEUS', newBasileusId, officeArmies.BASILEUS || 0);
  state.pendingTitleReassignment = false;
  state.log.push({ type: 'coup', newBasileus: newBasileusId, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'resolution',
    type: 'major_title_reassignment',
    actorId: newBasileusId,
    summary: `${playerName(state, newBasileusId)} redistributes the major offices.`,
    details: {
      assignments: Object.fromEntries(
        Object.entries(titleAssignments).map(([titleKey, playerId]) => [
          titleKey,
          {
            playerId,
            playerName: playerName(state, playerId),
            titleName: MAJOR_TITLES[titleKey]?.name || titleKey,
          },
        ])
      ),
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

// ─── Mercenary Hiring ───
export function hireMercenaries(state, playerId, officeKey, count) {
  const player = getPlayer(state, playerId);
  const normalizedCount = Number(count);
  if (!Number.isInteger(normalizedCount) || normalizedCount <= 0) {
    return { ok: false, reason: 'Choose at least one mercenary troop.' };
  }
  if (!state.currentMercenaryTroops) state.currentMercenaryTroops = {};
  const hiredSoFar = getPlayerMercenaryTotal(state, playerId);
  const cost = getMercenaryHireCost(hiredSoFar, normalizedCount);
  const spendableGold = getSpendableGold(state, playerId);
  if (spendableGold < cost) return { ok: false, reason: `Need ${formatGold(cost)} of unreserved gold, have ${formatGold(spendableGold)}.` };
  player.gold -= cost;
  state.currentMercenaryTroops[playerId] = getPlayerMercenaryTroops(state, playerId) + normalizedCount;
  state.log.push({ type: 'hire_mercs', player: playerId, office: MERCENARY_COMPANY_KEY, count: normalizedCount, cost, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'hire_mercenaries',
    actorId: playerId,
    summary: `${playerName(state, playerId)} hires ${formatMercenaries(normalizedCount)} for the Mercenary Company.`,
    details: {
      officeKey: MERCENARY_COMPANY_KEY,
      officeName: officeName(state, MERCENARY_COMPANY_KEY),
      count: normalizedCount,
      cost,
      totalMercenaryTroops: getPlayerMercenaryTroops(state, playerId),
    },
  });
  return { ok: true, count: normalizedCount, cost, historyId: historyEvent?.id || null };
}

// ─── Professional Army ───
export function canRecruitProfessional(state, playerId, officeKey) {
  if (!canOfficeHoldProfessionals(officeKey)) {
    return { ok: false, reason: 'This office cannot hold professional troops' };
  }
  if (!state.recruitedThisRound) state.recruitedThisRound = {};
  const key = officeKey;
  if (state.recruitedThisRound[key] === state.round) {
    return { ok: false, reason: 'Already recruited for this office this round' };
  }
  // A player cannot raise new professional troops while their treasury is in debt.
  const player = getPlayer(state, playerId);
  if (player && (Number(player.gold) || 0) < 0) {
    return { ok: false, reason: 'You cannot recruit new troops while your treasury is in debt.' };
  }
  return { ok: true };
}

export function recruitProfessional(state, playerId, officeKey) {
  const check = canRecruitProfessional(state, playerId, officeKey);
  if (!check.ok) return check;

  const player = getPlayer(state, playerId);
  if (!player.professionalArmies[officeKey]) {
    player.professionalArmies[officeKey] = 0;
  }
  player.professionalArmies[officeKey]++;

  if (!state.recruitedThisRound) state.recruitedThisRound = {};
  state.recruitedThisRound[officeKey] = state.round;

  state.log.push({ type: 'recruit_pro', player: playerId, office: officeKey, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'recruit_professional',
    actorId: playerId,
    summary: `${playerName(state, playerId)} recruits 1 professional troop for ${officeName(state, officeKey)}.`,
    details: {
      officeKey,
      officeName: officeName(state, officeKey),
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

export function canDismissProfessional(state, playerId, officeKey, count) {
  const dismissCount = Number(count);
  if (!Number.isInteger(dismissCount) || dismissCount <= 0) {
    return { ok: false, reason: 'Choose a positive number of troops to dismiss' };
  }

  const player = getPlayer(state, playerId);
  const currentCount = player.professionalArmies[officeKey] || 0;
  if (currentCount <= 0) {
    return { ok: false, reason: 'No professional troops are stationed in this office' };
  }
  if (dismissCount > currentCount) {
    return { ok: false, reason: `Cannot dismiss ${dismissCount} troops from ${currentCount} available` };
  }
  const dealCheck = validateDismissAgainstDeals(state, playerId, officeKey, dismissCount);
  if (!dealCheck.ok) return dealCheck;
  return { ok: true, count: dismissCount, currentCount };
}

export function dismissProfessional(state, playerId, officeKey, count) {
  const check = canDismissProfessional(state, playerId, officeKey, count);
  if (!check.ok) return check;

  const player = getPlayer(state, playerId);
  player.professionalArmies[officeKey] = Math.max(0, (player.professionalArmies[officeKey] || 0) - check.count);
  if (player.professionalArmies[officeKey] === 0) {
    delete player.professionalArmies[officeKey];
  }

  state.log.push({
    type: 'dismiss_pro',
    player: playerId,
    office: officeKey,
    count: check.count,
    round: state.round,
  });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'dismiss_professional',
    actorId: playerId,
    summary: `${playerName(state, playerId)} dismisses ${check.count} professional troop${check.count === 1 ? '' : 's'} from ${officeName(state, officeKey)}.`,
    details: {
      officeKey,
      officeName: officeName(state, officeKey),
      count: check.count,
      remaining: player.professionalArmies[officeKey] || 0,
    },
  });
  return { ok: true, count: check.count, historyId: historyEvent?.id || null };
}

export function payMaintenance(state, playerId) {
  const player = getPlayer(state, playerId);
  // Professional troops on mission (suspended for appointments/revocations) are
  // paid this round even though they are away from their office. They will be
  // restored to their armies immediately after maintenance.
  const onMission = getSuspendedProfessionalCount(state, playerId);
  const upkeepDue = getPlayerProfessionalUpkeep(state, playerId);
  player.gold -= upkeepDue;
  return {
    cost: upkeepDue,
    upkeepDue,
    onMission,
    unpaid: 0,
    disbanded: {},
  };
}

// During automatic administration, after income is paid, a player still in debt
// automatically loses 1 random professional troop per gold owed. The discarded
// troops come from anywhere in their professional army.
export function applyDebtDisbanding(state, playerId, rng = state.rng) {
  const player = getPlayer(state, playerId);
  if (!player) return { disbanded: 0, lost: {} };
  const debt = -Math.min(0, Number(player.gold) || 0);
  if (debt <= 0) return { disbanded: 0, lost: {} };

  const lost = {};
  let disbanded = 0;
  const drawOne = () => {
    const entries = Object.entries(player.professionalArmies).filter(([, count]) => count > 0);
    if (entries.length === 0) return false;
    const totalTroops = entries.reduce((total, [, count]) => total + (Number(count) || 0), 0);
    let pick = Math.floor((rng ? rng() : Math.random()) * totalTroops);
    let officeKey = entries[0][0];
    for (const [candidateOffice, count] of entries) {
      pick -= Number(count) || 0;
      if (pick < 0) {
        officeKey = candidateOffice;
        break;
      }
    }
    player.professionalArmies[officeKey] = Math.max(0, (player.professionalArmies[officeKey] || 0) - 1);
    if (player.professionalArmies[officeKey] === 0) delete player.professionalArmies[officeKey];
    lost[officeKey] = (lost[officeKey] || 0) + 1;
    disbanded++;
    return true;
  };

  for (let i = 0; i < debt; i++) {
    if (!drawOne()) break;
  }
  if (disbanded > 0) {
    state.log.push({ type: 'debt_disband', player: playerId, count: disbanded, debt, round: state.round });
    recordHistoryEvent(state, {
      category: 'system',
      type: 'debt_disband',
      actorId: playerId,
      summary: `${playerName(state, playerId)} loses ${disbanded} professional troop${disbanded === 1 ? '' : 's'} to debt (${debt}g owed).`,
      details: { count: disbanded, debt, lost },
    });
  }
  return { disbanded, lost };
}

// ─── Scoring ───
export function computeWealth(state, playerId) {
  return getPlayerFinalScore(state, playerId)?.points ?? getPlayer(state, playerId).gold;
}

export function computeFullWealth(state, playerId, projectedIncome) {
  void projectedIncome;
  return computeWealth(state, playerId);
}
