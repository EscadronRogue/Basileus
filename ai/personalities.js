export const SUPPORTED_PLAYER_COUNTS = [3, 4, 5];
export const DEFAULT_MIXED_DECK_SIZES = [6, 9, 12];
export const MAJOR_TITLE_KEYS = ['DOM_EAST', 'DOM_WEST', 'ADMIRAL', 'PATRIARCH'];
export const PROFILE_WEIGHT_KEYS = ['wealth', 'land', 'frontier', 'capital', 'throne', 'church', 'loyalty', 'retaliation', 'selfAppointment', 'mercenary', 'revocation'];
export const PROFILE_TACTIC_KEYS = ['independence', 'frontierAlarm', 'churchReserve', 'incumbencyGrip'];




export const META_PARAM_DEFS = [

  ['affinitySlope',          0.32, 0.05, 1.20, 0.18],
  ['bandwagonStrength',      1.45, 0.40, 2.80, 0.30],
  ['independenceDamping',    0.50, 0.05, 1.20, 0.18],

  ['selfThroneBoost',        1.85, 0.30, 4.00, 0.40],
  ['incumbentGrip',          2.35, 0.30, 4.00, 0.40],
  ['coupGrievanceFactor',    1.28, 0.10, 3.00, 0.40],

  ['incomeHorizonBase',      0.80, 0.20, 2.00, 0.25],
  ['incomeHorizonGrowth',    0.35, 0.00, 1.20, 0.18],

  ['mercenaryThreshold',     0.18, 0.00, 1.20, 0.20],
  ['frontierAlarmDanger',    1.15, 0.20, 3.00, 0.35],

  ['recruitThreshold',       1.10, 0.00, 4.00, 0.35],
  ['landPurchaseThreshold',  0.15, -1.00, 3.00, 0.30],
  ['churchGiftThreshold',    2.75, 0.00, 6.00, 0.50],
  ['dismissalThreshold',     0.75, 0.00, 3.00, 0.25],
  ['revocationThreshold',    2.45, 0.00, 6.00, 0.45],

  ['courtTemperature',       0.40, 0.05, 2.50, 0.25],
  ['orderTemperature',       0.30, 0.05, 2.00, 0.20],
  ['supportTemperature',     0.35, 0.05, 2.00, 0.20],

  ['opponentLearnRate',      0.18, 0.01, 0.80, 0.12],
  ['opponentTrust',          0.50, 0.00, 1.00, 0.20],
];

export const META_PARAM_KEYS = META_PARAM_DEFS.map(([key]) => key);

export const DEFAULT_META_PARAMS = Object.fromEntries(
  META_PARAM_DEFS.map(([key, value]) => [key, value])
);

export function getMetaBounds(key) {
  const def = META_PARAM_DEFS.find(entry => entry[0] === key);
  if (!def) return { min: 0, max: 1, mutation: 0.2 };
  return { min: def[2], max: def[3], mutation: def[4] };
}

export function getMetaParam(profile, key) {
  if (!profile) return DEFAULT_META_PARAMS[key];
  if (profile.meta && profile.meta[key] != null) return profile.meta[key];
  return DEFAULT_META_PARAMS[key];
}

export const PERSONALITIES = {};

export const POPULATION_PRESETS = {
  balanced: {
    id: 'balanced',
    name: 'Trained Roster',
    summary: 'AI seats are assigned from the trained profile library.',
    weights: {},
  },
  cooperative: {
    id: 'cooperative',
    name: 'Trained Roster',
    summary: 'AI seats are assigned from the trained profile library.',
    weights: {},
  },
  aggressive: {
    id: 'aggressive',
    name: 'Trained Roster',
    summary: 'AI seats are assigned from the trained profile library.',
    weights: {},
  },
};

export const NEUTRAL_PROFILE = {
  id: 'human',
  name: 'Human',
  shortName: 'Human',
  theory: 'Unrevealed',
  summary: 'Used internally as a neutral estimate when a human player has no assigned AI personality.',
  weights: {
    wealth: 1.25,
    land: 1.25,
    frontier: 1.35,
    capital: 1.25,
    throne: 1.35,
    church: 1.0,
    loyalty: 1.2,
    retaliation: 1.0,
    selfAppointment: 1.0,
    mercenary: 1.15,
    revocation: 1.0,
  },
  meta: { ...DEFAULT_META_PARAMS },
};
