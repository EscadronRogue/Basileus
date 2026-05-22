import { normalizeOrdersWithDealLocks, getSpendableGold } from './deals.js';
import { getPlayer } from './state.js';
import { getMercenaryHireCost } from './rules.js';
import {
  getDeploymentArmyDisplayName,
  getDeploymentArmySourceKeys,
  getDeploymentArmyTroopTotal,
  getPlayerDeploymentArmyKeys,
  isStrategosDeploymentArmyKey,
} from './deployment.js';

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
  return getPlayerDeploymentArmyKeys(state, playerId);
}

function getOfficeMaxTroops(state, playerId, officeKey) {
  return getDeploymentArmyTroopTotal(state, playerId, officeKey);
}

function normalizeLegacyStrategosOrder(state, playerId, rawOrders, armyKey) {
  if (!isStrategosDeploymentArmyKey(armyKey)) return null;
  const oldDeployments = rawOrders?.deployments || {};
  const legacyFunded = rawOrders?.funded || {};
  const rawArmies = rawOrders?.armies || {};
  const destinations = new Set();
  let funded = 0;
  let hasFunded = false;
  let hasDestination = false;

  for (const sourceKey of getDeploymentArmySourceKeys(state, playerId, armyKey)) {
    const rawArmy = rawArmies[sourceKey] || {};
    const sourceMax = getOfficeMaxTroops(state, playerId, sourceKey);
    if (Object.prototype.hasOwnProperty.call(rawArmy, 'funded')) {
      funded += Math.max(0, Math.min(sourceMax, toInt(rawArmy.funded, 0)));
      hasFunded = true;
    } else if (Object.prototype.hasOwnProperty.call(legacyFunded, sourceKey)) {
      funded += Math.max(0, Math.min(sourceMax, toInt(legacyFunded[sourceKey], 0)));
      hasFunded = true;
    }

    if (Object.prototype.hasOwnProperty.call(rawArmy, 'destination')) {
      destinations.add(normalizeDestination(rawArmy.destination));
      hasDestination = true;
    } else if (Object.prototype.hasOwnProperty.call(oldDeployments, sourceKey)) {
      destinations.add(normalizeDestination(oldDeployments[sourceKey]));
      hasDestination = true;
    }
  }

  return {
    hasFunded,
    funded,
    hasDestination,
    destination: hasDestination && destinations.size === 1 ? [...destinations][0] : null,
  };
}

function normalizeArmyOrders(state, playerId, rawOrders = {}) {
  const armies = {};
  const oldDeployments = rawOrders?.deployments || {};
  const legacyFunded = rawOrders?.funded || {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const hasCurrentArmy = Object.prototype.hasOwnProperty.call(rawOrders?.armies || {}, officeKey);
    const rawArmy = rawOrders?.armies?.[officeKey] || {};
    const legacyStrategos = hasCurrentArmy ? null : normalizeLegacyStrategosOrder(state, playerId, rawOrders, officeKey);
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
      funded: hasFunded ? toInt(rawFunded, NaN) : (legacyStrategos?.hasFunded ? legacyStrategos.funded : null),
      destination: hasDestination
        ? normalizeDestination(rawDestination)
        : (legacyStrategos?.hasDestination ? legacyStrategos.destination : null),
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
    const max = getOfficeMaxTroops(state, playerId, officeKey);
    const order = armies?.[officeKey] || {};
    if (max <= 0) {
      normalized[officeKey] = {
        funded: 0,
        destination: normalizeDestination(order.destination) || 'frontier',
      };
      continue;
    }
    if (order.funded == null || order.funded === '' || !Number.isInteger(Number(order.funded))) {
      return orderFailure(`Choose troop funding for ${getDeploymentArmyDisplayName(state, playerId, officeKey)}.`);
    }
    const destination = normalizeDestination(order.destination);
    if (!destination) return orderFailure(`Choose a destination for ${getDeploymentArmyDisplayName(state, playerId, officeKey)}.`);
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

function getUnfundedGold(state, playerId, armies) {
  return Object.entries(armies).reduce((total, [officeKey, order]) => (
    total + Math.max(0, getOfficeMaxTroops(state, playerId, officeKey) - (Number(order.funded) || 0))
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

  const unfundedGold = getUnfundedGold(state, playerId, normalizedOrders.armies);
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
