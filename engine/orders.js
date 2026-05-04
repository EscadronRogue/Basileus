import { getPlayer } from './state.js';
import { getMercenaryOrderCost } from './rules.js';

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function orderFailure(reason) {
  return { ok: false, reason };
}

export function isCapitalLockedOfficeKey(officeKey) {
  return officeKey === 'PATRIARCH' || officeKey === 'EMPRESS' || officeKey === 'CHIEF_EUNUCHS';
}

export function getPlayerOrderOfficeKeys(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return [];

  const officeKeys = [];
  if (playerId === state.basileusId) officeKeys.push('BASILEUS');
  for (const titleKey of player.majorTitles || []) officeKeys.push(titleKey);
  if (state.empress === playerId) officeKeys.push('EMPRESS');
  if (state.chiefEunuchs === playerId) officeKeys.push('CHIEF_EUNUCHS');
  for (const theme of Object.values(state.themes || {})) {
    if (theme.strategos === playerId && !theme.occupied) {
      officeKeys.push(`STRAT_${theme.id}`);
    }
  }
  return [...new Set(officeKeys)];
}

export function normalizeMercenaryOrders(rawMercenaries = []) {
  const totals = new Map();
  for (const entry of Array.isArray(rawMercenaries) ? rawMercenaries : []) {
    const officeKey = String(entry?.officeKey || '').trim();
    const count = toInt(entry?.count, 0);
    if (!officeKey || count <= 0) continue;
    totals.set(officeKey, (totals.get(officeKey) || 0) + count);
  }
  return [...totals.entries()].map(([officeKey, count]) => ({ officeKey, count }));
}

export function normalizeHumanOrders(state, playerId, rawOrders = {}) {
  const player = getPlayer(state, playerId);
  if (!player) return orderFailure('Player not found.');

  const officeKeys = getPlayerOrderOfficeKeys(state, playerId);
  const officeKeySet = new Set(officeKeys);
  const deployments = {};

  for (const officeKey of officeKeys) {
    const rawDestination = rawOrders?.deployments?.[officeKey];
    deployments[officeKey] = isCapitalLockedOfficeKey(officeKey)
      ? 'capital'
      : (rawDestination === 'capital' ? 'capital' : 'frontier');
  }

  const mercenaries = normalizeMercenaryOrders(rawOrders?.mercenaries);
  for (const mercenary of mercenaries) {
    if (!officeKeySet.has(mercenary.officeKey)) {
      return orderFailure('Mercenaries can only be assigned to your offices.');
    }
    if (isCapitalLockedOfficeKey(mercenary.officeKey)) {
      return orderFailure('Mercenaries cannot be assigned to court-only offices.');
    }
  }

  const candidate = toInt(rawOrders?.candidate, playerId);
  if (candidate < 0 || candidate >= state.players.length) {
    return orderFailure('Choose a valid Basileus candidate.');
  }

  const totalCost = getMercenaryOrderCost(mercenaries);
  if (player.gold < totalCost) return orderFailure(`Need ${totalCost}g, have ${player.gold}g.`);

  return {
    ok: true,
    orders: { deployments, mercenaries, candidate },
    totalCost,
  };
}
