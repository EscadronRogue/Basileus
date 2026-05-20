import { readTroopEntry } from './cascade.js';
import { normalizeOrdersWithDealLocks, getSpendableGold } from './deals.js';
import { getOfficeHolder, getPlayer } from './state.js';
import { getMercenaryHireCost } from './rules.js';

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function orderFailure(reason) {
  return { ok: false, reason };
}

function normalizeDestination(value) {
  return value === 'capital' ? 'capital' : 'frontier';
}

export function isCapitalLockedOfficeKey(officeKey) {
  void officeKey;
  return false;
}

export function getPlayerOrderOfficeKeys(state, playerId) {
  return Object.keys(state.currentTroops || {})
    .filter((officeKey) => getOfficeHolder(state, officeKey) === playerId)
    .sort((left, right) => left.localeCompare(right));
}

function getOfficeMaxTroops(state, officeKey) {
  const entry = readTroopEntry(state.currentTroops?.[officeKey]);
  return entry.normal + entry.capitalLocked;
}

function normalizeArmyOrders(state, playerId, rawOrders = {}) {
  const armies = {};
  const oldDeployments = rawOrders?.deployments || {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const max = getOfficeMaxTroops(state, officeKey);
    const rawArmy = rawOrders?.armies?.[officeKey] || {};
    const rawFunded = rawArmy.funded ?? rawOrders?.funded?.[officeKey] ?? max;
    const funded = Math.max(0, Math.min(max, toInt(rawFunded, max)));
    armies[officeKey] = {
      funded,
      destination: normalizeDestination(rawArmy.destination ?? oldDeployments[officeKey]),
    };
  }
  return armies;
}

function normalizeMercenaryOrder(rawMercenaries = {}) {
  if (Array.isArray(rawMercenaries)) {
    const count = rawMercenaries.reduce((total, entry) => total + Math.max(0, toInt(entry?.count, 0)), 0);
    return { count: Math.min(10, count), destination: normalizeDestination(rawMercenaries[0]?.destination) };
  }
  return {
    count: Math.max(0, Math.min(10, toInt(rawMercenaries?.count, 0))),
    destination: normalizeDestination(rawMercenaries?.destination),
  };
}

function getUnfundedGold(state, armies) {
  return Object.entries(armies).reduce((total, [officeKey, order]) => (
    total + Math.max(0, getOfficeMaxTroops(state, officeKey) - (Number(order.funded) || 0))
  ), 0);
}

export function normalizeHumanOrders(state, playerId, rawOrders = {}, options = {}) {
  const player = getPlayer(state, playerId);
  if (!player) return orderFailure('Player not found.');

  const armies = normalizeArmyOrders(state, playerId, rawOrders);
  const mercenaries = normalizeMercenaryOrder(rawOrders?.mercenaries);
  const candidate = toInt(rawOrders?.candidate, playerId);
  if (candidate < 0 || candidate >= state.players.length) return orderFailure('Choose a valid Basileus candidate.');

  const unfundedGold = getUnfundedGold(state, armies);
  const mercenaryCost = getMercenaryHireCost(0, mercenaries.count);
  if (getSpendableGold(state, playerId) + unfundedGold < mercenaryCost) {
    return orderFailure(`Not enough gold for those mercenaries after unfunded troops are paid out.`);
  }

  const normalizedOrders = { armies, mercenaries, candidate };
  if (rawOrders?.debug) normalizedOrders.debug = rawOrders.debug;

  const dealLocks = normalizeOrdersWithDealLocks(state, playerId, normalizedOrders, {
    resolveImpossibleLocks: Boolean(options.resolveImpossibleLocks),
  });
  if (!dealLocks.ok) return orderFailure(dealLocks.reason || 'Accepted deal commitments can no longer be fulfilled.');

  return {
    ok: true,
    orders: dealLocks.orders,
    totalCost: mercenaryCost,
    unfundedGold,
  };
}
