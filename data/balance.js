// data/balance.js - every number that tunes how the game plays.
//
// The engine, the rules text and the AI all read these values, so a balance
// change is made here once. ai/simulate.js can override any of them for a run
// (`--set NAME=value`) through applyBalanceOverrides().

export const BALANCE = {
  // Prices do not rise with quantity: every estate and every mercenary costs
  // the same.
  ESTATE_PRICE: 3,
  MERCENARY_PRICE: 3,

  // Income
  STARTING_INCOME_GOLD: 4,
  // The Basileus raises 1 troop for every this many provinces of the empire.
  BASILEUS_PROVINCES_PER_TROOP: 3,
  // Every ESTATE_DOMAIN_SIZE estates a dynasty holds in one province form a
  // domain, which pays ESTATE_DOMAIN_BONUS gold more every income.
  ESTATE_DOMAIN_SIZE: 3,
  ESTATE_DOMAIN_BONUS: 1,

  // Offices phase
  MAJOR_OFFICE_ACTION_LIMIT: 2,
  BASILEUS_REVOCATION_LIMIT: 4,
  ESTATE_REVOCATION_REFUND: 0,

  // Deployment
  MAX_MERCENARIES: 10,
  GOLD_PER_DISMISSED_TROOP: 1,

  // Coup: how much of a dynasty's support its first and second choice get.
  COUP_CHOICE_WEIGHTS: [1, 0.5],
  // The Theodosian Walls: support for the Basileus in every coup, and the
  // extra strength an invader needs to take Constantinople.
  THEODOSIAN_WALLS: 3,
  PATRIARCH_INFLUENCE: 2.5,
  UNREST_PER_LOST_PROVINCE: 2,

  // The war. Walking its route, the invader pays PROVINCE_WAR_COST of its
  // lead over the frontier to take each imperial province, and
  // LOST_PROVINCE_CROSSING_COST to cross one already lost; Constantinople
  // costs PROVINCE_WAR_COST plus the Walls. When the frontier wins, its lead
  // retakes lost provinces at PROVINCE_WAR_COST each.
  PROVINCE_WAR_COST: 3,
  LOST_PROVINCE_CROSSING_COST: 1,
  // The best defender of a won war earns, for every province the lead could
  // pay for on the route, this much gold and this much Triumph.
  WAR_REWARD_GOLD_PER_PROVINCE: 3,
  WAR_REWARD_TRIUMPH_PER_PROVINCE: 3,

  // Invasions: the strength of an invasion is known when it is drawn. The
  // farther the invader comes from, the stronger it is: it grows with the
  // number of provinces on its route before Constantinople (its reach). And
  // the threat grows every round.
  INVASION_STRENGTH_PER_REACH: 1,
  INVASION_STRENGTH_PER_ROUND: 2,
};

// Values that differ on some maps (data/maps). The Compact map has about
// half the provinces, each raising 1 troop, so what does not already scale
// with the map (coup support, mercenary and revocation limits, how fast the
// threat grows) is lowered too. Starting gold still buys one estate.
export const MAP_BALANCE = {
  compact: {
    STARTING_INCOME_GOLD: 3,
    BASILEUS_REVOCATION_LIMIT: 2,
    MAX_MERCENARIES: 6,
    THEODOSIAN_WALLS: 2,
    PATRIARCH_INFLUENCE: 1.5,
    UNREST_PER_LOST_PROVINCE: 1,
    INVASION_STRENGTH_PER_ROUND: 1,
  },
};

const DEFAULT_BALANCE = structuredClone(BALANCE);
const DEFAULT_MAP_BALANCE = structuredClone(MAP_BALANCE);

// The values for a map (its id, or a game state): BALANCE with the map's
// own values on top.
export function getBalance(mapOrState = null) {
  const mapId = typeof mapOrState === 'string' ? mapOrState : mapOrState?.mapId;
  const overlay = mapId ? MAP_BALANCE[mapId] : null;
  return overlay ? { ...BALANCE, ...overlay } : BALANCE;
}

// Replaces some values for the rest of this process (simulation and training
// only). Unknown names are refused so a typo cannot silently do nothing.
// "NAME" changes the value for every map without its own; "compact.NAME"
// changes it for the Compact map only.
export function applyBalanceOverrides(overrides = {}) {
  for (const [rawKey, value] of Object.entries(overrides || {})) {
    const [mapId, key] = rawKey.includes('.') ? rawKey.split('.') : [null, rawKey];
    if (!Object.hasOwn(DEFAULT_BALANCE, key)) throw new Error(`Unknown balance setting: ${rawKey}`);
    if (mapId) {
      if (!Object.hasOwn(MAP_BALANCE, mapId)) throw new Error(`Unknown map in balance setting: ${rawKey}`);
      MAP_BALANCE[mapId][key] = structuredClone(value);
    } else {
      BALANCE[key] = structuredClone(value);
    }
  }
  return BALANCE;
}

export function resetBalance() {
  for (const key of Object.keys(BALANCE)) delete BALANCE[key];
  Object.assign(BALANCE, structuredClone(DEFAULT_BALANCE));
  for (const mapId of Object.keys(MAP_BALANCE)) delete MAP_BALANCE[mapId];
  Object.assign(MAP_BALANCE, structuredClone(DEFAULT_MAP_BALANCE));
  return BALANCE;
}

export function getDefaultBalance() {
  return structuredClone(DEFAULT_BALANCE);
}
