// data/balance.js - every number that tunes how the game plays.
//
// The engine, the rules text and the AI all read these values, so a balance
// change is made here once. ai/simulate.js can override any of them for a run
// (`--set NAME=value`) through applyBalanceOverrides().

export const BALANCE = {
  // Income
  STARTING_INCOME_GOLD: 4,
  // The Basileus raises 1 troop for every this many provinces of the empire.
  BASILEUS_PROVINCES_PER_TROOP: 3,

  // Offices phase
  MAJOR_OFFICE_ACTION_LIMIT: 2,
  BASILEUS_REVOCATION_LIMIT: 4,
  ESTATE_REVOCATION_REFUND: 0,

  // Estates phase: the nth estate a dynasty builds in one round costs
  // ESTATE_BASE_PRICE + (n - 1) gold, like mercenaries.
  ESTATE_BASE_PRICE: 1,

  // Deployment
  MERCENARY_BASE_PRICE: 1,
  MAX_MERCENARIES: 10,
  GOLD_PER_DISMISSED_TROOP: 1,

  // Coup: how much of a dynasty's support its first and second choice get.
  COUP_CHOICE_WEIGHTS: [1, 0.5],
  THEODOSIAN_WALLS_SUPPORT: 5,
  PATRIARCH_INFLUENCE: 4,
  // The best defender of a won war earns gold and Triumph that rise like
  // mercenary prices: for N provinces won, base + (base + 1) + ... in all.
  WAR_REWARD_GOLD_BASE: 1,
  WAR_REWARD_TRIUMPH_BASE: 1,
  UNREST_PER_LOST_PROVINCE: 2,

  // Invasions: strength is drawn from a share of the empire's size, measured
  // as provinces x INVASION_STRENGTH_PER_PROVINCE.
  INVASION_STRENGTH_PER_PROVINCE: 1.85,
  INVASION_STRENGTH_RATIOS: {
    easy: [0.5, 0.9],
    medium: [0.6, 1],
    hard: [0.7, 1.1],
  },
  // Width of the strength range shown to players.
  INVASION_ESTIMATE_INTERVAL: 5,
  // Invasions drawn in the first rounds strike at most at easy strength, so a
  // game cannot be lost before dynasties have raised any troops.
  EARLY_INVASION_GRACE_ROUNDS: 2,
};

// Values that differ on some maps (data/maps). The Compact map has about
// half the provinces, each raising 1 troop, so what does not already scale
// with the map (coup support, starting gold, mercenary and revocation
// limits) is lowered too. Estates cost more there so estate income does not
// snowball, and invasions are a little stronger for the empire's size, which
// with the trained AIs gives about the same share of fallen empires as the
// Classic map.
export const MAP_BALANCE = {
  compact: {
    STARTING_INCOME_GOLD: 2,
    BASILEUS_REVOCATION_LIMIT: 2,
    ESTATE_BASE_PRICE: 2,
    MAX_MERCENARIES: 6,
    THEODOSIAN_WALLS_SUPPORT: 3,
    PATRIARCH_INFLUENCE: 2,
    UNREST_PER_LOST_PROVINCE: 1,
    INVASION_STRENGTH_PER_PROVINCE: 2,
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
