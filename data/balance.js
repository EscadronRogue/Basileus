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
  THEODOSIAN_WALLS_SUPPORT: 2,
  PATRIARCH_INFLUENCE: 1,
  TRIUMPH_PER_PROVINCE: 1,
  BEST_DEFENDER_GOLD_PER_PROVINCE: 1,
  UNREST_PER_LOST_PROVINCE: 1,

  // Invasions: strength is drawn from a share of the empire's size, measured
  // as provinces x INVASION_STRENGTH_PER_PROVINCE.
  INVASION_STRENGTH_PER_PROVINCE: 1,
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

const DEFAULT_BALANCE = structuredClone(BALANCE);

// Replaces some values for the rest of this process (simulation and training
// only). Unknown names are refused so a typo cannot silently do nothing.
export function applyBalanceOverrides(overrides = {}) {
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!Object.hasOwn(DEFAULT_BALANCE, key)) throw new Error(`Unknown balance setting: ${key}`);
    BALANCE[key] = structuredClone(value);
  }
  return BALANCE;
}

export function resetBalance() {
  for (const key of Object.keys(BALANCE)) delete BALANCE[key];
  Object.assign(BALANCE, structuredClone(DEFAULT_BALANCE));
  return BALANCE;
}

export function getDefaultBalance() {
  return structuredClone(DEFAULT_BALANCE);
}
