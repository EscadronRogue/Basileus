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

export const PERSONALITIES = {
  steward: {
    id: 'steward',
    name: 'Steward',
    shortName: 'Steward',
    theory: 'Repeated-game cooperator',
    summary: 'Protects the empire first, accepts slower personal growth, and backs stable coalitions.',
    weights: {
      wealth: 1.2,
      land: 1.0,
      frontier: 2.8,
      capital: 0.9,
      throne: 1.3,
      church: 0.7,
      loyalty: 1.7,
      retaliation: 0.5,
      selfAppointment: 1.0,
      mercenary: 1.1,
      revocation: 0.6,
    },
  },
  opportunist: {
    id: 'opportunist',
    name: 'Opportunist',
    shortName: 'Opportunist',
    theory: 'Profit-maximizing defector',
    summary: 'Defects whenever the throne, leverage, or tempo swing looks worth the imperial risk.',
    weights: {
      wealth: 1.6,
      land: 1.8,
      frontier: 0.9,
      capital: 2.3,
      throne: 2.5,
      church: 0.4,
      loyalty: 0.7,
      retaliation: 1.4,
      selfAppointment: 2.0,
      mercenary: 2.0,
      revocation: 1.5,
    },
  },
  reciprocator: {
    id: 'reciprocator',
    name: 'Reciprocator',
    shortName: 'Reciprocator',
    theory: 'Tit-for-tat coalition player',
    summary: 'Rewards recent favors, punishes betrayal, and adapts between cooperation and competition.',
    weights: {
      wealth: 1.3,
      land: 1.1,
      frontier: 1.9,
      capital: 1.3,
      throne: 1.6,
      church: 0.8,
      loyalty: 2.3,
      retaliation: 1.5,
      selfAppointment: 1.2,
      mercenary: 1.3,
      revocation: 1.0,
    },
  },
  zealot: {
    id: 'zealot',
    name: 'Zealot',
    shortName: 'Zealot',
    theory: 'Institutional church maximizer',
    summary: 'Funnels value into church structures, prizes bishoprics, and uses the Patriarchate as a power base.',
    weights: {
      wealth: 1.0,
      land: 0.9,
      frontier: 1.5,
      capital: 1.0,
      throne: 1.1,
      church: 2.8,
      loyalty: 1.4,
      retaliation: 0.8,
      selfAppointment: 1.0,
      mercenary: 0.8,
      revocation: 0.7,
    },
  },
  hawk: {
    id: 'hawk',
    name: 'Hawk',
    shortName: 'Hawk',
    theory: 'Risk-dominant militarist',
    summary: 'Spends hard on force projection, prefers decisive moves, and tolerates volatility for tempo.',
    weights: {
      wealth: 0.9,
      land: 0.8,
      frontier: 2.4,
      capital: 1.5,
      throne: 1.9,
      church: 0.3,
      loyalty: 0.6,
      retaliation: 1.1,
      selfAppointment: 1.5,
      mercenary: 2.4,
      revocation: 1.2,
    },
  },
  magnate: {
    id: 'magnate',
    name: 'Magnate',
    shortName: 'Magnate',
    theory: 'Long-horizon wealth optimizer',
    summary: 'Treats the empire as an investment landscape, buying cheaply and protecting revenue streams.',
    weights: {
      wealth: 2.4,
      land: 2.6,
      frontier: 1.0,
      capital: 1.0,
      throne: 1.2,
      church: 0.7,
      loyalty: 1.0,
      retaliation: 0.8,
      selfAppointment: 1.0,
      mercenary: 0.9,
      revocation: 0.8,
    },
  },
};

export const POPULATION_PRESETS = {
  balanced: {
    id: 'balanced',
    name: 'Balanced Court',
    summary: 'Even spread across all available personalities.',
    weights: {
      steward: 1.2,
      opportunist: 1.0,
      reciprocator: 1.1,
      zealot: 0.9,
      hawk: 1.0,
      magnate: 1.0,
    },
  },
  cooperative: {
    id: 'cooperative',
    name: 'Cooperative Court',
    summary: 'Rewards survival-oriented and reciprocity-based play.',
    weights: {
      steward: 2.8,
      opportunist: 0.7,
      reciprocator: 2.5,
      zealot: 1.2,
      hawk: 0.6,
      magnate: 1.0,
    },
  },
  aggressive: {
    id: 'aggressive',
    name: 'Aggressive Court',
    summary: 'Leans into coups, brinkmanship, and hard power.',
    weights: {
      steward: 0.7,
      opportunist: 2.8,
      reciprocator: 1.0,
      zealot: 0.6,
      hawk: 2.6,
      magnate: 1.3,
    },
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
