// engine/actions.js — Player actions: land purchase, gifting, appointments, revocations, coups

import { getPlayer, findTitleHolder } from './state.js';
import { recordHistoryEvent } from './history.js';
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';

function usedGenericSelfAppointmentLastRound(state, playerId) {
  return getPlayer(state, playerId)?.appointmentCooldown?.__SELF_ANY === state.round - 1;
}

function validateGenericSelfAppointment(state, appointerId, appointeeId) {
  if (appointerId !== appointeeId) return { ok: true };
  if (usedGenericSelfAppointmentLastRound(state, appointerId)) {
    return { ok: false, reason: 'Cannot appoint yourself in two consecutive rounds.' };
  }
  return { ok: true };
}

function markGenericSelfAppointment(state, appointerId, appointeeId) {
  if (appointerId !== appointeeId) return;
  const appointer = getPlayer(state, appointerId);
  appointer.appointmentCooldown.__SELF_ANY = state.round;
}

function playerName(state, playerId) {
  return getPlayer(state, playerId)?.dynasty || `Player ${Number(playerId) + 1}`;
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
  if (officeKey === 'BASILEUS') return 'Basileus';
  if (MAJOR_TITLES[officeKey]) return MAJOR_TITLES[officeKey].name;
  if (officeKey.startsWith('STRAT_')) {
    return `Strategos of ${themeName(state, officeKey.replace('STRAT_', ''))}`;
  }
  return officeKey;
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

// ─── Land Purchase ───
export function canBuyTheme(state, playerId, themeId) {
  const theme = state.themes[themeId];
  if (!theme) return { ok: false, reason: 'Theme not found' };
  if (theme.occupied) return { ok: false, reason: 'Theme is occupied' };
  if (theme.owner !== null) return { ok: false, reason: 'Theme already owned' };
  if (theme.id === 'CPL') return { ok: false, reason: 'Cannot buy Constantinople' };
  const cost = 2 * theme.G;
  const player = getPlayer(state, playerId);
  if (player.gold < cost) return { ok: false, reason: `Need ${cost}g, have ${player.gold}g` };
  return { ok: true, cost };
}

export function buyTheme(state, playerId, themeId) {
  const check = canBuyTheme(state, playerId, themeId);
  if (!check.ok) return check;
  const player = getPlayer(state, playerId);
  player.gold -= check.cost;
  state.themes[themeId].owner = playerId;
  state.log.push({ type: 'buy', player: playerId, theme: themeId, cost: check.cost, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'buy_theme',
    actorId: playerId,
    summary: `${playerName(state, playerId)} buys ${themeName(state, themeId)} for ${check.cost}g.`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
      cost: check.cost,
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

// ─── Gift Theme to Church ───
export function giftToChurch(state, playerId, themeId) {
  const theme = state.themes[themeId];
  if (!theme || theme.owner !== playerId) return { ok: false, reason: 'Not your theme' };
  extractOfficeArmy(state, `STRAT_${themeId}`);
  theme.owner = 'church';
  theme.taxExempt = false;
  theme.strategos = null;
  theme.bishop = playerId;
  theme.bishopIsDonor = true;
  state.log.push({ type: 'gift_church', player: playerId, theme: themeId, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'gift_theme_to_church',
    actorId: playerId,
    summary: `${playerName(state, playerId)} gifts ${themeName(state, themeId)} to the church.`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

// ─── Tax Exemption ───
export function grantTaxExemption(state, themeId) {
  const theme = state.themes[themeId];
  if (!theme || theme.occupied || theme.owner === null || theme.owner === 'church') {
    return { ok: false, reason: 'Invalid theme for exemption' };
  }
  theme.taxExempt = true;
  state.log.push({ type: 'tax_exempt', theme: themeId, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'grant_tax_exemption',
    summary: `Tax exemption granted to ${themeName(state, themeId)}.`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

// ─── Appointments ───
export function appointStrategos(state, appointerId, themeId, appointeeId) {
  const theme = state.themes[themeId];
  if (!theme || theme.occupied || theme.id === 'CPL') return { ok: false, reason: 'Invalid theme' };
  if (theme.strategos !== null) return { ok: false, reason: 'This strategos title is already appointed' };

  const regionTitleMap = { east: 'DOM_EAST', west: 'DOM_WEST', sea: 'ADMIRAL' };
  const requiredTitle = regionTitleMap[theme.region];
  if (!requiredTitle) return { ok: false, reason: 'No domestic for this region' };

  const appointer = getPlayer(state, appointerId);
  if (!appointer.majorTitles.includes(requiredTitle) && appointerId !== state.basileusId) {
    return { ok: false, reason: 'Not the Domestic/Admiral of this region' };
  }

  const selfAppointmentCheck = validateGenericSelfAppointment(state, appointerId, appointeeId);
  if (!selfAppointmentCheck.ok) return selfAppointmentCheck;

  const officeKey = `STRAT_${themeId}`;
  theme.strategos = appointeeId;
  transferOfficeArmy(state, officeKey, appointeeId, 1);
  markGenericSelfAppointment(state, appointerId, appointeeId);
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
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

export function appointBishop(state, appointerId, themeId, appointeeId) {
  const theme = state.themes[themeId];
  if (!theme || theme.occupied || theme.id === 'CPL') return { ok: false, reason: 'Invalid theme' };
  if (theme.bishop !== null) return { ok: false, reason: 'This bishop title is already appointed' };

  const appointer = getPlayer(state, appointerId);
  if (!appointer.majorTitles.includes('PATRIARCH') && appointerId !== state.basileusId) {
    return { ok: false, reason: 'Not the Patriarch' };
  }

  if (theme.bishopIsDonor) {
    return { ok: false, reason: 'This bishopric was granted by church donation and is protected' };
  }

  const selfAppointmentCheck = validateGenericSelfAppointment(state, appointerId, appointeeId);
  if (!selfAppointmentCheck.ok) return selfAppointmentCheck;

  theme.bishop = appointeeId;
  markGenericSelfAppointment(state, appointerId, appointeeId);
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
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

export function appointCourtTitle(state, titleType, appointeeId) {
  const selfAppointmentCheck = validateGenericSelfAppointment(state, state.basileusId, appointeeId);
  if (!selfAppointmentCheck.ok) return selfAppointmentCheck;

  if (titleType === 'EMPRESS') {
    if (state.empress !== null) return { ok: false, reason: 'The Empress title is already appointed' };
    state.empress = appointeeId;
  } else if (titleType === 'CHIEF_EUNUCHS') {
    if (state.chiefEunuchs !== null) return { ok: false, reason: 'The Chief of Eunuchs title is already appointed' };
    state.chiefEunuchs = appointeeId;
  } else {
    return { ok: false, reason: 'Invalid court title' };
  }

  markGenericSelfAppointment(state, state.basileusId, appointeeId);
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
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

// ─── Basileus Revocation ───
export function revokeMajorTitle(state, revokedPlayerId, titleKey, newHolderId) {
  const revokedPlayer = getPlayer(state, revokedPlayerId);
  const newHolder = getPlayer(state, newHolderId);

  if (!revokedPlayer.majorTitles.includes(titleKey)) return { ok: false, reason: 'Player does not hold this title' };
  if (newHolderId === state.basileusId) return { ok: false, reason: 'Basileus cannot hold major titles' };

  revokedPlayer.majorTitles = revokedPlayer.majorTitles.filter(t => t !== titleKey);
  newHolder.majorTitles.push(titleKey);
  transferOfficeArmy(state, titleKey, newHolderId);

  if (revokedPlayer.majorTitles.length === 0 && newHolder.majorTitles.length > 1) {
    const otherTitles = newHolder.majorTitles.filter(t => t !== titleKey);
    if (otherTitles.length > 0) {
      const swapTitle = otherTitles[0];
      newHolder.majorTitles = newHolder.majorTitles.filter(t => t !== swapTitle);
      revokedPlayer.majorTitles.push(swapTitle);
      transferOfficeArmy(state, swapTitle, revokedPlayerId);
    }
  }

  state.log.push({ type: 'revoke_major', revoked: revokedPlayerId, title: titleKey, newHolder: newHolderId, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_major_title',
    actorId: state.basileusId,
    summary: `${playerName(state, state.basileusId)} revokes ${MAJOR_TITLES[titleKey]?.name || titleKey} from ${playerName(state, revokedPlayerId)} and gives it to ${playerName(state, newHolderId)}.`,
    details: {
      titleKey,
      titleName: MAJOR_TITLES[titleKey]?.name || titleKey,
      revokedPlayerId,
      revokedPlayerName: playerName(state, revokedPlayerId),
      newHolderId,
      newHolderName: playerName(state, newHolderId),
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

export function revokeMinorTitle(state, themeId, titleType) {
  const theme = state.themes[themeId];
  if (!theme) return { ok: false };
  if (titleType === 'strategos') {
    extractOfficeArmy(state, `STRAT_${themeId}`);
    theme.strategos = null;
  } else if (titleType === 'bishop') {
    theme.bishop = null;
    theme.bishopIsDonor = false;
  }
  state.log.push({ type: 'revoke_minor', theme: themeId, titleType, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_minor_title',
    actorId: state.basileusId,
    summary: `${playerName(state, state.basileusId)} revokes the ${titleType} of ${themeName(state, themeId)}.`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
      titleType,
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

export function revokeTheme(state, themeId) {
  const theme = state.themes[themeId];
  if (!theme || theme.owner === null || theme.owner === 'church') return { ok: false };
  extractOfficeArmy(state, `STRAT_${themeId}`);
  theme.owner = null;
  theme.taxExempt = false;
  theme.strategos = null;
  theme.bishop = null;
  theme.bishopIsDonor = false;
  state.log.push({ type: 'revoke_theme', theme: themeId, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_theme',
    actorId: state.basileusId,
    summary: `${playerName(state, state.basileusId)} strips ${themeName(state, themeId)} from private ownership.`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
}

export function revokeTaxExemption(state, themeId) {
  const theme = state.themes[themeId];
  if (!theme || !theme.taxExempt) return { ok: false };
  theme.taxExempt = false;
  state.log.push({ type: 'revoke_exemption', theme: themeId, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'court',
    type: 'revoke_tax_exemption',
    actorId: state.basileusId,
    summary: `${playerName(state, state.basileusId)} revokes the tax exemption of ${themeName(state, themeId)}.`,
    details: {
      themeId,
      themeName: themeName(state, themeId),
    },
  });
  return { ok: true, historyId: historyEvent?.id || null };
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
  const cost = count * 3;
  if (player.gold < cost) return { ok: false, reason: `Need ${cost}g, have ${player.gold}g` };
  player.gold -= cost;
  state.log.push({ type: 'hire_mercs', player: playerId, office: officeKey, count, round: state.round });
  const historyEvent = recordHistoryEvent(state, {
    category: 'orders',
    type: 'hire_mercenaries',
    actorId: playerId,
    summary: `${playerName(state, playerId)} hires ${count} mercenary troop${count === 1 ? '' : 's'} for ${officeName(state, officeKey)}.`,
    details: {
      officeKey,
      officeName: officeName(state, officeKey),
      count,
      cost,
    },
  });
  return { ok: true, count, historyId: historyEvent?.id || null };
}

// ─── Professional Army ───
export function canRecruitProfessional(state, playerId, officeKey) {
  if (!state.recruitedThisRound) state.recruitedThisRound = {};
  const key = officeKey;
  if (state.recruitedThisRound[key] === state.round) {
    return { ok: false, reason: 'Already recruited for this office this round' };
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
  const upkeepDue = Object.values(player.professionalArmies)
    .reduce((total, count) => total + Math.max(0, count || 0), 0);
  player.gold -= upkeepDue;
  return {
    cost: upkeepDue,
    upkeepDue,
    unpaid: 0,
    disbanded: {},
  };
}

// ─── Scoring ───
export function computeWealth(state, playerId) {
  return getPlayer(state, playerId).gold;
}

export function computeFullWealth(state, playerId, projectedIncome) {
  return getPlayer(state, playerId).gold + (projectedIncome || 0);
}
