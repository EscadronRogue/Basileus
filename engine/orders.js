import { getPlayer } from './state.js';

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

// Mercenaries are now hired during the court phase. Order submission only
// covers troop deployment + the throne vote.
export function normalizeHumanOrders(state, playerId, rawOrders = {}) {
  const player = getPlayer(state, playerId);
  if (!player) return orderFailure('Player not found.');

  const officeKeys = getPlayerOrderOfficeKeys(state, playerId);
  const deployments = {};
  for (const officeKey of officeKeys) {
    const rawDestination = rawOrders?.deployments?.[officeKey];
    deployments[officeKey] = isCapitalLockedOfficeKey(officeKey)
      ? 'capital'
      : (rawDestination === 'capital' ? 'capital' : 'frontier');
  }

  const mercenaryDeployment = rawOrders?.mercenaryDeployment === 'capital' ? 'capital' : 'frontier';

  const candidate = toInt(rawOrders?.candidate, playerId);
  if (candidate < 0 || candidate >= state.players.length) {
    return orderFailure('Choose a valid Basileus candidate.');
  }

  return {
    ok: true,
    orders: { deployments, mercenaryDeployment, candidate },
    totalCost: 0,
  };
}
