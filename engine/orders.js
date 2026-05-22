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
  return value === 'capital' || value === 'frontier' ? value : null;
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
  const legacyFunded = rawOrders?.funded || {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const rawArmy = rawOrders?.armies?.[officeKey] || {};
    const hasFunded = Object.prototype.hasOwnProperty.call(rawArmy, 'funded')
      || Object.prototype.hasOwnProperty.call(legacyFunded, officeKey);
    const hasDestination = Object.prototype.hasOwnProperty.call(rawArmy, 'destination')
      || Object.prototype.hasOwnProperty.call(oldDeployments, officeKey);
    const rawFunded = Object.prototype.hasOwnProperty.call(rawArmy, 'funded')
      ? rawArmy.funded
      : legacyFunded[officeKey];
    const rawDestination = Object.prototype.hasOwnProperty.call(rawArmy, 'destination')
      ? rawArmy.destination
      : oldDeployments[officeKey];
    armies[officeKey] = {
      funded: hasFunded ? toInt(rawFunded, NaN) : null,
      destination: hasDestination ? normalizeDestination(rawDestination) : null,
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

function validateArmyOrders(state, playerId, armies) {
  const normalized = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const max = getOfficeMaxTroops(state, officeKey);
    const order = armies?.[officeKey] || {};
    if (max <= 0) {
      normalized[officeKey] = {
        funded: 0,
        destination: normalizeDestination(order.destination) || 'frontier',
      };
      continue;
    }
    if (order.funded == null || order.funded === '' || !Number.isInteger(Number(order.funded))) {
      return orderFailure(`Choose troop funding for ${officeKey}.`);
    }
    const destination = normalizeDestination(order.destination);
    if (!destination) return orderFailure(`Choose a destination for ${officeKey}.`);
    normalized[officeKey] = {
      funded: Math.max(0, Math.min(max, toInt(order.funded, 0))),
      destination,
    };
  }
  return { ok: true, armies: normalized };
}

function validateMercenaryOrder(mercenaries) {
  const count = Math.max(0, Math.min(10, toInt(mercenaries?.count, 0)));
  const destination = normalizeDestination(mercenaries?.destination);
  if (count > 0 && !destination) return orderFailure('Choose a destination for hired mercenaries.');
  return {
    ok: true,
    mercenaries: {
      count,
      destination: destination || 'frontier',
    },
  };
}

function validateCandidate(state, orders) {
  const candidate = toInt(orders?.candidate, NaN);
  if (!Number.isInteger(candidate) || candidate < 0 || candidate >= state.players.length) {
    return orderFailure('Choose a valid Basileus candidate.');
  }
  return { ok: true, candidate };
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
  const candidate = Object.prototype.hasOwnProperty.call(rawOrders || {}, 'candidate')
    ? toInt(rawOrders?.candidate, NaN)
    : null;
  const rawNormalizedOrders = { armies, mercenaries, candidate };
  if (rawOrders?.debug) rawNormalizedOrders.debug = rawOrders.debug;

  const dealLocks = normalizeOrdersWithDealLocks(state, playerId, rawNormalizedOrders, {
    resolveImpossibleLocks: Boolean(options.resolveImpossibleLocks),
  });
  if (!dealLocks.ok) return orderFailure(dealLocks.reason || 'Accepted deal commitments can no longer be fulfilled.');

  const armyValidation = validateArmyOrders(state, playerId, dealLocks.orders.armies);
  if (!armyValidation.ok) return armyValidation;

  const mercenaryValidation = validateMercenaryOrder(dealLocks.orders.mercenaries);
  if (!mercenaryValidation.ok) return mercenaryValidation;

  const candidateValidation = validateCandidate(state, dealLocks.orders);
  if (!candidateValidation.ok) return candidateValidation;

  const normalizedOrders = {
    ...dealLocks.orders,
    armies: armyValidation.armies,
    mercenaries: mercenaryValidation.mercenaries,
    candidate: candidateValidation.candidate,
  };

  const unfundedGold = getUnfundedGold(state, normalizedOrders.armies);
  const mercenaryCost = getMercenaryHireCost(0, normalizedOrders.mercenaries.count);
  if (getSpendableGold(state, playerId) + unfundedGold < mercenaryCost) {
    return orderFailure(`Not enough gold for those mercenaries after unfunded troops are paid out.`);
  }

  return {
    ok: true,
    orders: normalizedOrders,
    totalCost: mercenaryCost,
    unfundedGold,
  };
}
