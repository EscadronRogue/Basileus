import { AI_NUM_DEFAULTS as AI_NUM } from './numericConstants.js';
import { AI_ACTION_KINDS, AI_ACTION_PHASES } from './actionSpace.js';

export const POLICY_FEATURE_KEYS = Object.freeze([
  'baseScore',
  'scoreRatio',
  'gold',
  'troops',
  'income',
  'titles',
  'relation',
  'risk',
  'urgency',
  'scarcity',
  'repeat',
  'tempo',
  'survival',
  'political',
  'economic',
  'military',
  'diplomacy',
  'denial',
  'flexibility',
  'endgame',
  'candidateAlignment',
  'capitalCommitment',
  'frontierCommitment',
  'dealLock',
  'selfClaim',
  'incumbentSupport',
  'rivalSupport',
  'routeSafety',
  'goldPressure',
  'restorationPressure',
  'titleContinuity',
  'supporterReward',
  'rivalSuppression',
  'roleFit',
  'obligationPayoff',
  'militaryCompetence',
  'survivalMilitary',
  'relationRisk',
  'endgameEconomic',
  'urgencyScarcity',
  'politicalDenial',
]);

export const POLICY_ACTION_KEYS = Object.freeze([
  AI_ACTION_KINDS.APPOINTMENT,
  AI_ACTION_KINDS.REVOCATION,
  AI_ACTION_KINDS.DEAL,
  AI_ACTION_KINDS.LAND_PURCHASE,
  AI_ACTION_KINDS.CHURCH_GIFT,
  AI_ACTION_KINDS.RECRUIT,
  AI_ACTION_KINDS.DISMISS,
  AI_ACTION_KINDS.MERCENARY_HIRE,
  AI_ACTION_KINDS.CONFIRM_COURT,
  AI_ACTION_KINDS.ORDERS,
  AI_ACTION_KINDS.DEFENDER_REWARD,
  AI_ACTION_KINDS.TITLE_ASSIGNMENT,
]);

export const POLICY_IMPACT_KEYS = Object.freeze([
  'scoreGain',
  'survival',
  'military',
  'political',
  'economic',
  'denial',
  'diplomacy',
  'risk',
  'flexibility',
  'timing',
]);

export const POLICY_DEAL_SCORE_KEYS = Object.freeze([
  'actorUtility',
  'counterpartySurplus',
  'strategicBias',
  'relation',
  'counterpartyLoss',
  'actorLoss',
]);

export const POLICY_PHASE_KEYS = Object.freeze([
  AI_ACTION_PHASES.COURT,
  AI_ACTION_PHASES.ORDERS,
  AI_ACTION_PHASES.RESOLUTION,
]);

export const POLICY_DEAL_STRATEGIC_KEYS = Object.freeze([
  'coordination',
  'reciprocity',
  'frontier',
  'reward',
  'goldMakeweight',
  'leaderPenalty',
  'speculationPenalty',
]);

export const POLICY_NUMERIC_TUNING_KEYS = Object.freeze([]);

const ACTION_PRIOR_BOUNDS = [-AI_NUM.N_6, AI_NUM.N_6];
const PHASE_PRIOR_BOUNDS = [-AI_NUM.N_4, AI_NUM.N_4];
const FEATURE_WEIGHT_BOUNDS = [-AI_NUM.N_4, AI_NUM.N_4];
const IMPACT_WEIGHT_BOUNDS = [-AI_NUM.N_3, AI_NUM.N_3];
const DEAL_SCORE_WEIGHT_BOUNDS = [-AI_NUM.N_4, AI_NUM.N_4];
const DEAL_STRATEGIC_WEIGHT_BOUNDS = [-AI_NUM.N_4, AI_NUM.N_4];
const SCALAR_BOUNDS = {
  scoreTemperature: [AI_NUM.N_0_05, AI_NUM.N_3],
  actionThreshold: [-AI_NUM.N_6, AI_NUM.N_6],
  maxCourtActionsPerRound: [AI_NUM.N_1, AI_NUM.N_24],
  maxActionRepeatsPerKind: [AI_NUM.N_1, AI_NUM.N_10],
  baseScoreWeight: [-AI_NUM.N_2, AI_NUM.N_2],
  dealCounterpartySurplusCap: [AI_NUM.N_0, AI_NUM.N_5],
  dealSingleTemplateLimit: [AI_NUM.N_4, AI_NUM.N_36],
  dealComboAskLimit: [AI_NUM.N_1, AI_NUM.N_7],
  dealComboGiveLimit: [AI_NUM.N_1, AI_NUM.N_5],
  dealTotalPayloadLimit: [AI_NUM.N_8, AI_NUM.N_56],
  dealIntentPayloadLimit: [AI_NUM.N_4, AI_NUM.N_24],
  dealProposalOptionLimit: [AI_NUM.N_1, AI_NUM.N_12],
  dealCounterOptionLimit: [AI_NUM.N_1, AI_NUM.N_8],
  orderPlanLimit: [AI_NUM.N_8, AI_NUM.N_1024],
  titleAssignmentLimit: [AI_NUM.N_4, AI_NUM.N_1024],
  mercenaryHireLimit: [AI_NUM.N_1, AI_NUM.N_12],
};

const DEFAULT_ACTION_PRIORS = {
  [AI_ACTION_KINDS.APPOINTMENT]: AI_NUM.N_0_85,
  [AI_ACTION_KINDS.REVOCATION]: -AI_NUM.N_0_25,
  [AI_ACTION_KINDS.DEAL]: AI_NUM.N_0_1,
  [AI_ACTION_KINDS.LAND_PURCHASE]: AI_NUM.N_0_35,
  [AI_ACTION_KINDS.CHURCH_GIFT]: -AI_NUM.N_0_05,
  [AI_ACTION_KINDS.RECRUIT]: AI_NUM.N_0_25,
  [AI_ACTION_KINDS.DISMISS]: -AI_NUM.N_0_35,
  [AI_ACTION_KINDS.MERCENARY_HIRE]: -AI_NUM.N_0_1,
  [AI_ACTION_KINDS.CONFIRM_COURT]: -AI_NUM.N_0_75,
  [AI_ACTION_KINDS.ORDERS]: AI_NUM.N_0,
  [AI_ACTION_KINDS.DEFENDER_REWARD]: AI_NUM.N_0,
  [AI_ACTION_KINDS.TITLE_ASSIGNMENT]: AI_NUM.N_0,
};

const DEFAULT_FEATURE_WEIGHTS = {
  baseScore: AI_NUM.N_0_05,
  scoreRatio: AI_NUM.N_0_1,
  gold: -AI_NUM.N_0_18,
  troops: -AI_NUM.N_0_25,
  income: AI_NUM.N_0_45,
  titles: AI_NUM.N_0_35,
  relation: AI_NUM.N_0_3,
  risk: -AI_NUM.N_0_55,
  urgency: AI_NUM.N_0_55,
  scarcity: AI_NUM.N_0_35,
  repeat: -AI_NUM.N_0_4,
  tempo: AI_NUM.N_0_2,
  survival: AI_NUM.N_0_65,
  political: AI_NUM.N_0_5,
  economic: AI_NUM.N_0_5,
  military: AI_NUM.N_0_45,
  diplomacy: AI_NUM.N_0_28,
  denial: AI_NUM.N_0_24,
  flexibility: AI_NUM.N_0_22,
  endgame: AI_NUM.N_0_22,
  candidateAlignment: AI_NUM.N_0_55,
  capitalCommitment: AI_NUM.N_0_42,
  frontierCommitment: AI_NUM.N_0_5,
  dealLock: AI_NUM.N_0_32,
  selfClaim: AI_NUM.N_0_2,
  incumbentSupport: AI_NUM.N_0_12,
  rivalSupport: AI_NUM.N_0_18,
  routeSafety: AI_NUM.N_0_58,
  goldPressure: AI_NUM.N_0_42,
  restorationPressure: AI_NUM.N_0_55,
  titleContinuity: AI_NUM.N_0_16,
  supporterReward: AI_NUM.N_0_46,
  rivalSuppression: AI_NUM.N_0_32,
  roleFit: AI_NUM.N_0_44,
  obligationPayoff: AI_NUM.N_0_38,
  militaryCompetence: AI_NUM.N_0_36,
  survivalMilitary: AI_NUM.N_0_42,
  relationRisk: -AI_NUM.N_0_18,
  endgameEconomic: AI_NUM.N_0_3,
  urgencyScarcity: AI_NUM.N_0_28,
  politicalDenial: AI_NUM.N_0_34,
};

const DEFAULT_IMPACT_WEIGHTS = {
  scoreGain: AI_NUM.N_1_05,
  survival: AI_NUM.N_0_85,
  military: AI_NUM.N_0_72,
  political: AI_NUM.N_0_82,
  economic: AI_NUM.N_0_76,
  denial: AI_NUM.N_0_62,
  diplomacy: AI_NUM.N_0_48,
  risk: -AI_NUM.N_0_72,
  flexibility: AI_NUM.N_0_45,
  timing: AI_NUM.N_0_28,
};

const DEFAULT_DEAL_SCORE_WEIGHTS = {
  actorUtility: AI_NUM.N_1,
  counterpartySurplus: AI_NUM.N_0_55,
  strategicBias: AI_NUM.N_0_35,
  relation: AI_NUM.N_0_2,
  counterpartyLoss: -AI_NUM.N_1_25,
  actorLoss: -AI_NUM.N_0_75,
};

const DEFAULT_PHASE_PRIORS = {
  [AI_ACTION_PHASES.COURT]: AI_NUM.N_0,
  [AI_ACTION_PHASES.ORDERS]: AI_NUM.N_0,
  [AI_ACTION_PHASES.RESOLUTION]: AI_NUM.N_0,
};

const DEFAULT_DEAL_STRATEGIC_WEIGHTS = {
  coordination: AI_NUM.N_1,
  reciprocity: AI_NUM.N_1,
  frontier: AI_NUM.N_1,
  reward: AI_NUM.N_1,
  goldMakeweight: AI_NUM.N_1,
  leaderPenalty: -AI_NUM.N_1,
  speculationPenalty: -AI_NUM.N_1,
};

const DEFAULT_NUMERIC_TUNING = Object.freeze({});

export const DEFAULT_POLICY_GENOME = Object.freeze({
  version: AI_NUM.N_2,
  actionPriors: Object.freeze({ ...DEFAULT_ACTION_PRIORS }),
  phasePriors: Object.freeze({ ...DEFAULT_PHASE_PRIORS }),
  featureWeights: Object.freeze({ ...DEFAULT_FEATURE_WEIGHTS }),
  impactWeights: Object.freeze({ ...DEFAULT_IMPACT_WEIGHTS }),
  dealScoreWeights: Object.freeze({ ...DEFAULT_DEAL_SCORE_WEIGHTS }),
  dealStrategicWeights: Object.freeze({ ...DEFAULT_DEAL_STRATEGIC_WEIGHTS }),
  numericTuning: Object.freeze({ ...DEFAULT_NUMERIC_TUNING }),
  scoreTemperature: AI_NUM.N_0_45,
  actionThreshold: -AI_NUM.N_0_3,
  maxCourtActionsPerRound: AI_NUM.N_12,
  maxActionRepeatsPerKind: AI_NUM.N_4,
  baseScoreWeight: AI_NUM.N_0_08,
  dealCounterpartySurplusCap: AI_NUM.N_1_8,
  dealSingleTemplateLimit: AI_NUM.N_24,
  dealComboAskLimit: AI_NUM.N_5,
  dealComboGiveLimit: AI_NUM.N_4,
  dealTotalPayloadLimit: AI_NUM.N_40,
  dealIntentPayloadLimit: AI_NUM.N_16,
  dealProposalOptionLimit: AI_NUM.N_8,
  dealCounterOptionLimit: AI_NUM.N_6,
  orderPlanLimit: AI_NUM.N_192,
  titleAssignmentLimit: AI_NUM.N_512,
  mercenaryHireLimit: AI_NUM.N_5,
});

const normalizedPolicyCache = new WeakMap();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundTo(value, digits = AI_NUM.N_4) {
  const scale = AI_NUM.N_10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizeRecord(rawRecord, keys, defaults, bounds) {
  const [min, max] = bounds;
  const raw = rawRecord && typeof rawRecord === 'object' ? rawRecord : {};
  return Object.fromEntries(keys.map((key) => [
    key,
    roundTo(clamp(numberOr(raw[key], defaults[key] ?? AI_NUM.N_0), min, max)),
  ]));
}

function getNumericTuningBounds(key) {
  const fallback = Number(AI_NUM[key]) || AI_NUM.N_0;
  const span = Math.max(Math.abs(fallback) * AI_NUM.N_4, AI_NUM.N_0_25);
  return [-span, span];
}

function normalizeNumericTuning(rawRecord) {
  return Object.fromEntries(POLICY_NUMERIC_TUNING_KEYS.map((key) => {
    const [min, max] = getNumericTuningBounds(key);
    return [key, roundTo(clamp(numberOr(rawRecord?.[key], DEFAULT_NUMERIC_TUNING[key]), min, max))];
  }));
}

export function normalizePolicyGenome(rawPolicy = {}) {
  const raw = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  const cached = normalizedPolicyCache.get(raw);
  if (cached) return cached;
  const normalized = {
    version: AI_NUM.N_2,
    actionPriors: normalizeRecord(raw.actionPriors, POLICY_ACTION_KEYS, DEFAULT_ACTION_PRIORS, ACTION_PRIOR_BOUNDS),
    phasePriors: normalizeRecord(raw.phasePriors, POLICY_PHASE_KEYS, DEFAULT_PHASE_PRIORS, PHASE_PRIOR_BOUNDS),
    featureWeights: normalizeRecord(raw.featureWeights, POLICY_FEATURE_KEYS, DEFAULT_FEATURE_WEIGHTS, FEATURE_WEIGHT_BOUNDS),
    impactWeights: normalizeRecord(raw.impactWeights, POLICY_IMPACT_KEYS, DEFAULT_IMPACT_WEIGHTS, IMPACT_WEIGHT_BOUNDS),
    dealScoreWeights: normalizeRecord(raw.dealScoreWeights, POLICY_DEAL_SCORE_KEYS, DEFAULT_DEAL_SCORE_WEIGHTS, DEAL_SCORE_WEIGHT_BOUNDS),
    dealStrategicWeights: normalizeRecord(raw.dealStrategicWeights, POLICY_DEAL_STRATEGIC_KEYS, DEFAULT_DEAL_STRATEGIC_WEIGHTS, DEAL_STRATEGIC_WEIGHT_BOUNDS),
    numericTuning: normalizeNumericTuning(raw.numericTuning),
  };

  for (const [key, [min, max]] of Object.entries(SCALAR_BOUNDS)) {
    normalized[key] = roundTo(clamp(numberOr(raw[key], DEFAULT_POLICY_GENOME[key]), min, max));
  }

  normalized.maxCourtActionsPerRound = Math.round(normalized.maxCourtActionsPerRound);
  normalized.maxActionRepeatsPerKind = Math.round(normalized.maxActionRepeatsPerKind);
  normalized.dealSingleTemplateLimit = Math.round(normalized.dealSingleTemplateLimit);
  normalized.dealComboAskLimit = Math.round(normalized.dealComboAskLimit);
  normalized.dealComboGiveLimit = Math.round(normalized.dealComboGiveLimit);
  normalized.dealTotalPayloadLimit = Math.round(normalized.dealTotalPayloadLimit);
  normalized.dealIntentPayloadLimit = Math.round(normalized.dealIntentPayloadLimit);
  normalized.dealProposalOptionLimit = Math.round(normalized.dealProposalOptionLimit);
  normalized.dealCounterOptionLimit = Math.round(normalized.dealCounterOptionLimit);
  normalized.orderPlanLimit = Math.round(normalized.orderPlanLimit);
  normalized.titleAssignmentLimit = Math.round(normalized.titleAssignmentLimit);
  normalized.mercenaryHireLimit = Math.round(normalized.mercenaryHireLimit);
  normalizedPolicyCache.set(raw, normalized);
  return normalized;
}

export function getPolicyFeatureValue(policy, key) {
  return normalizePolicyGenome(policy).featureWeights[key] ?? AI_NUM.N_0;
}

export function getPolicyImpactWeight(policy, key) {
  return normalizePolicyGenome(policy).impactWeights[key] ?? AI_NUM.N_0;
}

export function getPolicyDealScoreWeight(policy, key) {
  return normalizePolicyGenome(policy).dealScoreWeights[key] ?? AI_NUM.N_0;
}

export function getPolicyActionPrior(policy, kind) {
  return normalizePolicyGenome(policy).actionPriors[kind] ?? AI_NUM.N_0;
}

export function getPolicyNumericTuning(policy, key) {
  return normalizePolicyGenome(policy).numericTuning[key] ?? AI_NUM[key] ?? AI_NUM.N_0;
}

export function scorePolicyAction(policyInput, descriptor, features = {}) {
  const policy = normalizePolicyGenome(policyInput);
  const kind = descriptor?.kind || '';
  const phase = descriptor?.phase || AI_ACTION_PHASES.COURT;
  let score = policy.actionPriors[kind] ?? AI_NUM.N_0;
  score += policy.phasePriors[phase] || AI_NUM.N_0;
  score += (Number(descriptor?.baseScore) || AI_NUM.N_0) * policy.baseScoreWeight;

  for (const key of POLICY_FEATURE_KEYS) {
    const value = Number(features[key]) || AI_NUM.N_0;
    score += value * (policy.featureWeights[key] || AI_NUM.N_0);
  }

  return roundTo(score);
}

export function createFreshPolicyGenome(rng) {
  const randomize = (defaults, keys, bounds, spread) => {
    const [min, max] = bounds;
    return Object.fromEntries(keys.map((key) => {
      const fallback = defaults[key] ?? AI_NUM.N_0;
      const swing = ((rng() + rng() + rng()) - AI_NUM.N_1_5) * spread;
      return [key, roundTo(clamp(fallback + swing, min, max))];
    }));
  };

  return normalizePolicyGenome({
    actionPriors: randomize(DEFAULT_ACTION_PRIORS, POLICY_ACTION_KEYS, ACTION_PRIOR_BOUNDS, AI_NUM.N_1_2),
    phasePriors: randomize(DEFAULT_PHASE_PRIORS, POLICY_PHASE_KEYS, PHASE_PRIOR_BOUNDS, AI_NUM.N_0_7),
    featureWeights: randomize(DEFAULT_FEATURE_WEIGHTS, POLICY_FEATURE_KEYS, FEATURE_WEIGHT_BOUNDS, AI_NUM.N_0_9),
    impactWeights: randomize(DEFAULT_IMPACT_WEIGHTS, POLICY_IMPACT_KEYS, IMPACT_WEIGHT_BOUNDS, AI_NUM.N_0_55),
    dealScoreWeights: randomize(DEFAULT_DEAL_SCORE_WEIGHTS, POLICY_DEAL_SCORE_KEYS, DEAL_SCORE_WEIGHT_BOUNDS, AI_NUM.N_0_55),
    dealStrategicWeights: randomize(DEFAULT_DEAL_STRATEGIC_WEIGHTS, POLICY_DEAL_STRATEGIC_KEYS, DEAL_STRATEGIC_WEIGHT_BOUNDS, AI_NUM.N_0_45),
    scoreTemperature: DEFAULT_POLICY_GENOME.scoreTemperature + ((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_0_3,
    actionThreshold: DEFAULT_POLICY_GENOME.actionThreshold + ((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_0_9,
    maxCourtActionsPerRound: DEFAULT_POLICY_GENOME.maxCourtActionsPerRound + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_4),
    maxActionRepeatsPerKind: DEFAULT_POLICY_GENOME.maxActionRepeatsPerKind + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_2),
    baseScoreWeight: DEFAULT_POLICY_GENOME.baseScoreWeight + ((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_0_7,
    dealCounterpartySurplusCap: DEFAULT_POLICY_GENOME.dealCounterpartySurplusCap + ((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_0_8,
    dealSingleTemplateLimit: DEFAULT_POLICY_GENOME.dealSingleTemplateLimit + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_8),
    dealComboAskLimit: DEFAULT_POLICY_GENOME.dealComboAskLimit + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_2),
    dealComboGiveLimit: DEFAULT_POLICY_GENOME.dealComboGiveLimit + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_2),
    dealTotalPayloadLimit: DEFAULT_POLICY_GENOME.dealTotalPayloadLimit + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_12),
    dealIntentPayloadLimit: DEFAULT_POLICY_GENOME.dealIntentPayloadLimit + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_6),
    dealProposalOptionLimit: DEFAULT_POLICY_GENOME.dealProposalOptionLimit + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_3),
    dealCounterOptionLimit: DEFAULT_POLICY_GENOME.dealCounterOptionLimit + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_2),
    orderPlanLimit: DEFAULT_POLICY_GENOME.orderPlanLimit + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_80),
    titleAssignmentLimit: DEFAULT_POLICY_GENOME.titleAssignmentLimit + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_180),
    mercenaryHireLimit: DEFAULT_POLICY_GENOME.mercenaryHireLimit + Math.round(((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_3),
  });
}

export function mutatePolicyGenome(rawPolicy, rng, intensity = AI_NUM.N_1) {
  const policy = normalizePolicyGenome(rawPolicy);
  const mutateRecord = (record, keys, bounds, spread) => {
    const [min, max] = bounds;
    return Object.fromEntries(keys.map((key) => {
      const swing = ((rng() + rng() + rng()) - AI_NUM.N_1_5) * spread * intensity;
      return [key, roundTo(clamp(record[key] + swing, min, max))];
    }));
  };

  const next = {
    ...policy,
    actionPriors: mutateRecord(policy.actionPriors, POLICY_ACTION_KEYS, ACTION_PRIOR_BOUNDS, AI_NUM.N_0_42),
    phasePriors: mutateRecord(policy.phasePriors, POLICY_PHASE_KEYS, PHASE_PRIOR_BOUNDS, AI_NUM.N_0_24),
    featureWeights: mutateRecord(policy.featureWeights, POLICY_FEATURE_KEYS, FEATURE_WEIGHT_BOUNDS, AI_NUM.N_0_34),
    impactWeights: mutateRecord(policy.impactWeights, POLICY_IMPACT_KEYS, IMPACT_WEIGHT_BOUNDS, AI_NUM.N_0_24),
    dealScoreWeights: mutateRecord(policy.dealScoreWeights, POLICY_DEAL_SCORE_KEYS, DEAL_SCORE_WEIGHT_BOUNDS, AI_NUM.N_0_24),
    dealStrategicWeights: mutateRecord(policy.dealStrategicWeights, POLICY_DEAL_STRATEGIC_KEYS, DEAL_STRATEGIC_WEIGHT_BOUNDS, AI_NUM.N_0_22),
    numericTuning: normalizeNumericTuning(policy.numericTuning),
  };

  for (const [key, [min, max]] of Object.entries(SCALAR_BOUNDS)) {
    const swing = ((rng() + rng() + rng()) - AI_NUM.N_1_5) * AI_NUM.N_0_22 * intensity * (max - min);
    next[key] = roundTo(clamp(policy[key] + swing, min, max));
  }

  return normalizePolicyGenome(next);
}

export function crossoverPolicyGenomes(leftInput, rightInput, rng, intensity = AI_NUM.N_1) {
  const left = normalizePolicyGenome(leftInput);
  const right = normalizePolicyGenome(rightInput);
  const blendRecord = (leftRecord, rightRecord, keys, bounds, spread) => {
    const [min, max] = bounds;
    return Object.fromEntries(keys.map((key) => {
      const blend = rng();
      const mixed = (leftRecord[key] * blend) + (rightRecord[key] * (AI_NUM.N_1 - blend));
      const swing = ((rng() + rng() + rng()) - AI_NUM.N_1_5) * spread * intensity;
      return [key, roundTo(clamp(mixed + swing, min, max))];
    }));
  };

  const child = {
    actionPriors: blendRecord(left.actionPriors, right.actionPriors, POLICY_ACTION_KEYS, ACTION_PRIOR_BOUNDS, AI_NUM.N_0_28),
    phasePriors: blendRecord(left.phasePriors, right.phasePriors, POLICY_PHASE_KEYS, PHASE_PRIOR_BOUNDS, AI_NUM.N_0_18),
    featureWeights: blendRecord(left.featureWeights, right.featureWeights, POLICY_FEATURE_KEYS, FEATURE_WEIGHT_BOUNDS, AI_NUM.N_0_24),
    impactWeights: blendRecord(left.impactWeights, right.impactWeights, POLICY_IMPACT_KEYS, IMPACT_WEIGHT_BOUNDS, AI_NUM.N_0_18),
    dealScoreWeights: blendRecord(left.dealScoreWeights, right.dealScoreWeights, POLICY_DEAL_SCORE_KEYS, DEAL_SCORE_WEIGHT_BOUNDS, AI_NUM.N_0_18),
    dealStrategicWeights: blendRecord(left.dealStrategicWeights, right.dealStrategicWeights, POLICY_DEAL_STRATEGIC_KEYS, DEAL_STRATEGIC_WEIGHT_BOUNDS, AI_NUM.N_0_16),
    numericTuning: normalizeNumericTuning(left.numericTuning),
  };

  for (const [key, [min, max]] of Object.entries(SCALAR_BOUNDS)) {
    const source = rng() < AI_NUM.N_0_5 ? left[key] : right[key];
    const swing = ((rng() + rng()) - AI_NUM.N_1) * AI_NUM.N_0_08 * intensity * (max - min);
    child[key] = roundTo(clamp(source + swing, min, max));
  }

  return normalizePolicyGenome(child);
}
