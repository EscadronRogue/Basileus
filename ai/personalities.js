import { AI_NUM } from './numericConstants.js';
import { DEFAULT_POLICY_GENOME } from './policyGenome.js';

export const SUPPORTED_PLAYER_COUNTS = [AI_NUM.N_3, AI_NUM.N_4, AI_NUM.N_5];
export const DEFAULT_MIXED_DECK_SIZES = [AI_NUM.N_6, AI_NUM.N_9, AI_NUM.N_12];
export const MAJOR_TITLE_KEYS = ['DOM_EAST', 'DOM_WEST', 'ADMIRAL', 'PATRIARCH'];
export const PROFILE_WEIGHT_KEYS = ['wealth', 'land', 'frontier', 'capital', 'throne', 'church', 'loyalty', 'retaliation', 'selfAppointment', 'mercenary', 'revocation'];
export const PROFILE_TACTIC_KEYS = ['independence', 'frontierAlarm', 'churchReserve', 'incumbencyGrip'];




export const META_PARAM_DEFS = [

  ['affinitySlope',          AI_NUM.N_0_32, AI_NUM.N_0_05, AI_NUM.N_1_2, AI_NUM.N_0_18],
  ['bandwagonStrength',      AI_NUM.N_1_45, AI_NUM.N_0_4, AI_NUM.N_2_8, AI_NUM.N_0_3],
  ['independenceDamping',    AI_NUM.N_0_5, AI_NUM.N_0_05, AI_NUM.N_1_2, AI_NUM.N_0_18],

  ['selfThroneBoost',        AI_NUM.N_1_85, AI_NUM.N_0_3, AI_NUM.N_4, AI_NUM.N_0_4],
  ['incumbentGrip',          AI_NUM.N_2_35, AI_NUM.N_0_3, AI_NUM.N_4, AI_NUM.N_0_4],
  ['coupGrievanceFactor',    AI_NUM.N_1_28, AI_NUM.N_0_1, AI_NUM.N_3, AI_NUM.N_0_4],

  ['incomeHorizonBase',      AI_NUM.N_0_8, AI_NUM.N_0_2, AI_NUM.N_2, AI_NUM.N_0_25],
  ['incomeHorizonGrowth',    AI_NUM.N_0_35, AI_NUM.N_0, AI_NUM.N_1_2, AI_NUM.N_0_18],

  ['mercenaryThreshold',     AI_NUM.N_0_18, AI_NUM.N_0, AI_NUM.N_1_2, AI_NUM.N_0_2],
  ['frontierAlarmDanger',    AI_NUM.N_1_15, AI_NUM.N_0_2, AI_NUM.N_3, AI_NUM.N_0_35],

  ['recruitThreshold',       AI_NUM.N_1_1, AI_NUM.N_0, AI_NUM.N_4, AI_NUM.N_0_35],
  ['landPurchaseThreshold',  AI_NUM.N_0_15, -AI_NUM.N_1, AI_NUM.N_3, AI_NUM.N_0_3],
  ['churchGiftThreshold',    AI_NUM.N_2_75, AI_NUM.N_0, AI_NUM.N_6, AI_NUM.N_0_5],
  ['dismissalThreshold',     AI_NUM.N_0_75, AI_NUM.N_0, AI_NUM.N_3, AI_NUM.N_0_25],
  ['revocationThreshold',    AI_NUM.N_2_45, AI_NUM.N_0, AI_NUM.N_6, AI_NUM.N_0_45],
  ['dealCounterThreshold',   -AI_NUM.N_0_7, -AI_NUM.N_3, AI_NUM.N_2, AI_NUM.N_0_35],
  ['dealRiskTolerance',       AI_NUM.N_0_45, AI_NUM.N_0, AI_NUM.N_1_5, AI_NUM.N_0_18],
  ['courtTemperature',       AI_NUM.N_0_4, AI_NUM.N_0_05, AI_NUM.N_2_5, AI_NUM.N_0_25],
  ['orderTemperature',       AI_NUM.N_0_3, AI_NUM.N_0_05, AI_NUM.N_2, AI_NUM.N_0_2],
  ['supportTemperature',     AI_NUM.N_0_35, AI_NUM.N_0_05, AI_NUM.N_2, AI_NUM.N_0_2],

  ['opponentLearnRate',      AI_NUM.N_0_18, AI_NUM.N_0_01, AI_NUM.N_0_8, AI_NUM.N_0_12],
  ['opponentTrust',          AI_NUM.N_0_5, AI_NUM.N_0, AI_NUM.N_1, AI_NUM.N_0_2],

  ['consequenceSensitivity',  AI_NUM.N_0_85, AI_NUM.N_0, AI_NUM.N_2_5, AI_NUM.N_0_25],
  ['riskHorizon',             AI_NUM.N_0_9, AI_NUM.N_0, AI_NUM.N_2_5, AI_NUM.N_0_25],
  ['flexibilityValue',        AI_NUM.N_0_75, AI_NUM.N_0, AI_NUM.N_2_5, AI_NUM.N_0_22],
  ['rivalDenialValue',        AI_NUM.N_0_8, AI_NUM.N_0, AI_NUM.N_2_5, AI_NUM.N_0_24],
  ['uncertaintyTolerance',    AI_NUM.N_0_55, AI_NUM.N_0, AI_NUM.N_2, AI_NUM.N_0_2],
  ['cooperationValue',        AI_NUM.N_0_8, AI_NUM.N_0, AI_NUM.N_2_5, AI_NUM.N_0_22],
];

export const META_PARAM_KEYS = META_PARAM_DEFS.map(([key]) => key);

export const DEFAULT_META_PARAMS = Object.fromEntries(
  META_PARAM_DEFS.map(([key, value]) => [key, value])
);

export function getMetaBounds(key) {
  const def = META_PARAM_DEFS.find(entry => entry[AI_NUM.N_0] === key);
  if (!def) return { min: AI_NUM.N_0, max: AI_NUM.N_1, mutation: AI_NUM.N_0_2 };
  return { min: def[AI_NUM.N_2], max: def[AI_NUM.N_3], mutation: def[AI_NUM.N_4] };
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
    summary: 'AI seats are assigned from the policy profile library.',
    weights: {},
  },
  cooperative: {
    id: 'cooperative',
    name: 'Trained Roster',
    summary: 'AI seats are assigned from the policy profile library.',
    weights: {},
  },
  aggressive: {
    id: 'aggressive',
    name: 'Trained Roster',
    summary: 'AI seats are assigned from the policy profile library.',
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
    wealth: AI_NUM.N_1_25,
    land: AI_NUM.N_1_25,
    frontier: AI_NUM.N_1_35,
    capital: AI_NUM.N_1_25,
    throne: AI_NUM.N_1_35,
    church: AI_NUM.N_1,
    loyalty: AI_NUM.N_1_2,
    retaliation: AI_NUM.N_1,
    selfAppointment: AI_NUM.N_1,
    mercenary: AI_NUM.N_1_15,
    revocation: AI_NUM.N_1,
  },
  meta: { ...DEFAULT_META_PARAMS },
  policy: DEFAULT_POLICY_GENOME,
};
