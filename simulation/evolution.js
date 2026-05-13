import { AI_NUM } from '../ai/numericConstants.js';
import {
  DEFAULT_MIXED_DECK_SIZES,
  META_PARAM_DEFS,
  NEUTRAL_PROFILE,
  PROFILE_TACTIC_KEYS,
  PROFILE_WEIGHT_KEYS,
  SUPPORTED_PLAYER_COUNTS,
} from '../ai/personalities.js';
import { normalizeAiProfile } from '../ai/profileStore.js';
import {
  createFreshPolicyGenome,
  crossoverPolicyGenomes,
  mutatePolicyGenome,
  normalizePolicyGenome,
  POLICY_ACTION_KEYS,
  POLICY_DEAL_SCORE_KEYS,
  POLICY_DEAL_STRATEGIC_KEYS,
  POLICY_FEATURE_KEYS,
  POLICY_IMPACT_KEYS,
  POLICY_PHASE_KEYS,
} from '../ai/policyGenome.js';
import { runSingleSimulationGame } from './engine.js';

const WEIGHT_MIN = AI_NUM.N_0_15;
const WEIGHT_MAX = AI_NUM.N_4_5;
const TACTIC_MIN = AI_NUM.N_0_55;
const TACTIC_MAX = AI_NUM.N_2_4;
const OBJECTIVE_KEYS = [
  'survivalRate',
  'winShare',
  'scorePercentile',
  'scriptedWinRate',
  'hallOfFameWinRate',
  'emergentWinRate',
  'opponentRobustness',
  'seatRobustness',
  'novelty',
];

export const DEFAULT_TRAINING_CONFIG = {
  seed: null,
  playerCount: AI_NUM.N_4,
  playerCounts: SUPPORTED_PLAYER_COUNTS.slice(),
  deckSize: AI_NUM.N_6,
  deckSizes: DEFAULT_MIXED_DECK_SIZES.slice(),
  fitnessPresetId: 'balanced',
  populationSize: AI_NUM.N_48,
  generations: AI_NUM.N_45,
  matchesPerCandidate: AI_NUM.N_32,
  validationMatchesPerCandidate: AI_NUM.N_12,
  holdoutMatchesPerChampion: AI_NUM.N_1536,
  finalAuditMatchesPerChampion: AI_NUM.N_192,
  champions: AI_NUM.N_12,
  hallOfFameSize: AI_NUM.N_48,
  eliteFraction: AI_NUM.N_0_2,
  freshBloodRate: AI_NUM.N_0_12,
  hallOfFameMixFraction: AI_NUM.N_0_25,
  parallelWorkers: AI_NUM.N_0,
};

export const DEFAULT_FITNESS_WEIGHTS = {
  collapsePenalty: AI_NUM.N_12,
  survivalBonus: AI_NUM.N_1,
  winReward: AI_NUM.N_14,
  placementReward: AI_NUM.N_4,
  wealthReward: AI_NUM.N_2,
  dealUtilityReward: AI_NUM.N_0,
  dealAcceptanceReward: AI_NUM.N_0,
  badDealPenalty: AI_NUM.N_0,
  decisionQualityReward: AI_NUM.N_0,
  projectionErrorPenalty: AI_NUM.N_0,
};

export const FITNESS_PROFILES = {
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    summary: 'Outcome-only fitness: survival, placement, final score, and outright wins.',
    weights: { ...DEFAULT_FITNESS_WEIGHTS },
  },
  aggressive: {
    id: 'aggressive',
    name: 'Aggressive',
    summary: 'Rewards winning more heavily, accepting more collapse risk.',
    weights: {
      ...DEFAULT_FITNESS_WEIGHTS,
      collapsePenalty: AI_NUM.N_8,
      survivalBonus: AI_NUM.N_0_6,
      winReward: AI_NUM.N_18,
      placementReward: AI_NUM.N_5,
      wealthReward: AI_NUM.N_3,
    },
  },
  cooperative: {
    id: 'cooperative',
    name: 'Cooperative',
    summary: 'Rewards keeping the empire alive more heavily than high-variance wins.',
    weights: {
      ...DEFAULT_FITNESS_WEIGHTS,
      collapsePenalty: AI_NUM.N_16,
      survivalBonus: AI_NUM.N_1_6,
      winReward: AI_NUM.N_10,
      placementReward: AI_NUM.N_3,
      wealthReward: AI_NUM.N_1_4,
    },
  },
  prudent: {
    id: 'prudent',
    name: 'Prudent',
    summary: 'Treats imperial collapse as a major failure and prefers very robust play.',
    weights: {
      ...DEFAULT_FITNESS_WEIGHTS,
      collapsePenalty: AI_NUM.N_20,
      survivalBonus: AI_NUM.N_2,
      winReward: AI_NUM.N_8,
      placementReward: AI_NUM.N_2_4,
      wealthReward: AI_NUM.N_1,
    },
  },
};

export const FITNESS_TUNING_FIELDS = [
  { key: 'collapsePenalty', label: 'Empire Fall Penalty', step: AI_NUM.N_0_1, min: AI_NUM.N_0, max: AI_NUM.N_40, group: 'Outcome', hint: 'Penalty applied if the empire falls or a simulation guard aborts.' },
  { key: 'survivalBonus', label: 'Survival Bonus', step: AI_NUM.N_0_1, min: AI_NUM.N_0, max: AI_NUM.N_20, group: 'Outcome', hint: 'Flat reward when the empire survives to scoring.' },
  { key: 'winReward', label: 'Win Reward', step: AI_NUM.N_0_1, min: AI_NUM.N_0, max: AI_NUM.N_30, group: 'Outcome', hint: 'Reward for outright winning a surviving game.' },
  { key: 'placementReward', label: 'Placement Reward', step: AI_NUM.N_0_1, min: AI_NUM.N_0, max: AI_NUM.N_15, group: 'Outcome', hint: 'Reward for finishing high even without an outright win.' },
  { key: 'wealthReward', label: 'Score Reward', step: AI_NUM.N_0_1, min: AI_NUM.N_0, max: AI_NUM.N_15, group: 'Outcome', hint: 'Reward for final score relative to the table mean.' },
  { key: 'dealUtilityReward', label: 'Deal Utility Reward', step: AI_NUM.N_0_05, min: AI_NUM.N_0, max: AI_NUM.N_5, group: 'Deals', hint: 'Small reward for accepted deals that the AI evaluated as beneficial.' },
  { key: 'dealAcceptanceReward', label: 'Useful Deal Reward', step: AI_NUM.N_0_05, min: AI_NUM.N_0, max: AI_NUM.N_5, group: 'Deals', hint: 'Small reward for accepted deals after net utility and bad-deal penalties.' },
  { key: 'badDealPenalty', label: 'Bad Deal Penalty', step: AI_NUM.N_0_05, min: AI_NUM.N_0, max: AI_NUM.N_10, group: 'Deals', hint: 'Penalty for accepting deals the AI evaluated as negative.' },
  { key: 'decisionQualityReward', label: 'Decision Quality Reward', step: AI_NUM.N_0_05, min: AI_NUM.N_0, max: AI_NUM.N_5, group: 'Judgment', hint: 'Reward for consequence projections that align with realized game outcomes.' },
  { key: 'projectionErrorPenalty', label: 'Projection Error Penalty', step: AI_NUM.N_0_05, min: AI_NUM.N_0, max: AI_NUM.N_5, group: 'Judgment', hint: 'Penalty for large gaps between projected decision value and realized results.' },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, AI_NUM.N_10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundTo(value, digits = AI_NUM.N_4) {
  const scale = AI_NUM.N_10 ** digits;
  return Math.round(value * scale) / scale;
}

function average(values) {
  if (!values.length) return AI_NUM.N_0;
  return values.reduce((total, value) => total + value, AI_NUM.N_0) / values.length;
}

function variance(values) {
  if (values.length < AI_NUM.N_2) return AI_NUM.N_0;
  const mean = average(values);
  return average(values.map(value => (value - mean) ** AI_NUM.N_2));
}

function lowerConfidenceRate(rate, samples, z = AI_NUM.N_1_28) {
  const p = clamp(Number(rate) || AI_NUM.N_0, AI_NUM.N_0, AI_NUM.N_1);
  const n = Math.max(AI_NUM.N_1, Number(samples) || AI_NUM.N_1);
  return roundTo(Math.max(AI_NUM.N_0, p - z * Math.sqrt((p * (AI_NUM.N_1 - p)) / n)), AI_NUM.N_4);
}

function hashSeedString(value) {
  const text = String(value ?? '');
  let hash = AI_NUM.N_2166136261;
  for (let index = AI_NUM.N_0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, AI_NUM.N_16777619);
  }
  return hash >>> AI_NUM.N_0;
}

function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(AI_NUM.N_1);
    globalThis.crypto.getRandomValues(values);
    return values[AI_NUM.N_0] >>> AI_NUM.N_0;
  }
  return Math.floor(Math.random() * AI_NUM.N_4294967296) >>> AI_NUM.N_0;
}

function normalizeSeed(rawSeed) {
  if (rawSeed == null || rawSeed === '') return randomSeed();
  const text = String(rawSeed).trim();
  if (!text) return randomSeed();
  if (/^-?\d+$/.test(text)) return Number(text) >>> AI_NUM.N_0;
  return hashSeedString(text);
}

function createRng(seed) {
  let state = seed >>> AI_NUM.N_0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> AI_NUM.N_15), t | AI_NUM.N_1);
    t ^= t + Math.imul(t ^ (t >>> AI_NUM.N_7), t | AI_NUM.N_61);
    return ((t ^ (t >>> AI_NUM.N_14)) >>> AI_NUM.N_0) / AI_NUM.N_4294967296;
  };
}

function shuffle(array, rng) {
  const copy = array.slice();
  for (let index = copy.length - AI_NUM.N_1; index > AI_NUM.N_0; index--) {
    const swapIndex = Math.floor(rng() * (index + AI_NUM.N_1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function normalizeRange(value, min, max) {
  if (max <= min) return AI_NUM.N_0;
  return clamp((value - min) / (max - min), AI_NUM.N_0, AI_NUM.N_1);
}

function euclideanDistance(left, right) {
  const length = Math.min(left.length, right.length);
  let total = AI_NUM.N_0;
  for (let index = AI_NUM.N_0; index < length; index++) {
    const delta = (left[index] || AI_NUM.N_0) - (right[index] || AI_NUM.N_0);
    total += delta * delta;
  }
  return Math.sqrt(total);
}

function sanitizePlayerCount(value) {
  const parsed = toInt(value, DEFAULT_TRAINING_CONFIG.playerCount);
  return SUPPORTED_PLAYER_COUNTS.includes(parsed) ? parsed : DEFAULT_TRAINING_CONFIG.playerCount;
}

function normalizeListInput(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean);
  if (value == null || value === '') return [];
  return [value];
}

function sanitizePlayerCounts(value, fallback = DEFAULT_TRAINING_CONFIG.playerCounts) {
  const cleaned = [...new Set(
    normalizeListInput(value)
      .map(entry => toInt(entry, NaN))
      .filter(entry => SUPPORTED_PLAYER_COUNTS.includes(entry))
  )].sort((left, right) => left - right);
  return cleaned.length ? cleaned : fallback.slice();
}

function sanitizeDeckSizes(value, fallback = DEFAULT_TRAINING_CONFIG.deckSizes) {
  const cleaned = [...new Set(
    normalizeListInput(value)
      .map(entry => clamp(toInt(entry, NaN), AI_NUM.N_1, AI_NUM.N_30))
      .filter(Number.isFinite)
  )].sort((left, right) => left - right);
  return cleaned.length ? cleaned : fallback.slice();
}

function resolveFitnessPresetId(rawPresetId) {
  return FITNESS_PROFILES[rawPresetId] ? rawPresetId : DEFAULT_TRAINING_CONFIG.fitnessPresetId;
}

function normalizeFitnessWeights(rawWeights = {}, presetId = DEFAULT_TRAINING_CONFIG.fitnessPresetId) {
  const baseWeights = FITNESS_PROFILES[resolveFitnessPresetId(presetId)]?.weights || DEFAULT_FITNESS_WEIGHTS;
  const normalized = {};
  for (const field of FITNESS_TUNING_FIELDS) {
    normalized[field.key] = roundTo(clamp(toNumber(rawWeights[field.key], baseWeights[field.key]), field.min, field.max), AI_NUM.N_4);
  }
  return normalized;
}

function createInternalProfile(candidate) {
  return normalizeAiProfile({
    id: candidate.id,
    name: candidate.name,
    shortName: candidate.name,
    theory: 'Self-play policy genome',
    summary: candidate.summary,
    source: 'emergent-trained',
    basePersonalityId: null,
    policy: candidate.policy,
    training: candidate.training,
  });
}

function rankRecordKeys(record, labels, count = AI_NUM.N_2, positiveOnly = true) {
  return Object.entries(record || {})
    .filter(([, value]) => Number.isFinite(Number(value)))
    .filter(([, value]) => !positiveOnly || Number(value) > AI_NUM.N_0)
    .sort((left, right) => Math.abs(Number(right[AI_NUM.N_1])) - Math.abs(Number(left[AI_NUM.N_1])))
    .slice(AI_NUM.N_0, count)
    .map(([key]) => labels[key] || key);
}

function getPolicySignature(policyInput, count = AI_NUM.N_2) {
  const policy = normalizePolicyGenome(policyInput);
  const actionLabels = {
    appointment: 'Court',
    revocation: 'Edict',
    deal: 'Accord',
    land_purchase: 'Estate',
    church_gift: 'Synod',
    recruit: 'Levy',
    dismiss: 'Reserve',
    mercenary_hire: 'Iron',
    confirm_court: 'Tempo',
    orders: 'Command',
    defender_reward: 'Aegis',
    title_assignment: 'Crown',
  };
  const featureLabels = {
    survival: 'Aegis',
    economic: 'Coin',
    political: 'Palace',
    military: 'Spear',
    diplomacy: 'Accord',
    denial: 'Denial',
    flexibility: 'Reserve',
    endgame: 'Endgame',
    candidateAlignment: 'Crown',
    frontierCommitment: 'Frontier',
    capitalCommitment: 'Capital',
    routeSafety: 'Route',
    goldPressure: 'Treasury',
    restorationPressure: 'Restoration',
    supporterReward: 'Patron',
    rivalSuppression: 'Rival',
  };
  const actions = rankRecordKeys(policy.actionPriors, actionLabels, count);
  const features = rankRecordKeys(policy.featureWeights, featureLabels, count);
  return [...actions, ...features].slice(AI_NUM.N_0, count);
}

function buildChampionName(candidate, rank) {
  const [primary = 'Policy', secondary = 'Pattern'] = getPolicySignature(candidate.policy, AI_NUM.N_2);
  return `${primary} ${secondary} Mk ${rank}`;
}

function createNeutralCandidate(rng, index) {
  const candidate = {
    id: `cand-neut-${index}-${Math.floor(rng() * AI_NUM.N_1000000000)}`,
    name: `Emergent Seed ${index + AI_NUM.N_1}`,
    summary: '',
    basePersonalityId: null,
    policy: createFreshPolicyGenome(rng),
    training: {},
  };
  candidate.profile = createInternalProfile(candidate);
  return candidate;
}

function cloneCandidate(candidate, generation, suffix) {
  const clone = {
    id: `${candidate.id}-${suffix}`,
    name: candidate.name,
    summary: candidate.summary,
    basePersonalityId: null,
    policy: normalizePolicyGenome(candidate.policy),
    training: { ...(candidate.training || {}), generation },
  };
  clone.profile = createInternalProfile(clone);
  return clone;
}

function crossoverCandidates(parentA, parentB, rng, generation, index, mutationScale = AI_NUM.N_1) {
  const policy = crossoverPolicyGenomes(parentA.policy, parentB.policy, rng, mutationScale);

  const dominantParent = rng() < AI_NUM.N_0_5 ? parentA : parentB;
  const candidate = {
    id: `child-${generation}-${index}-${Math.floor(rng() * AI_NUM.N_1000000000)}`,
    name: dominantParent.name,
    summary: '',
    basePersonalityId: null,
    policy,
    training: { generation },
  };
  candidate.profile = createInternalProfile(candidate);
  return candidate;
}

function mutateCandidate(parent, rng, generation, index, mutationScale = AI_NUM.N_1) {
  const candidate = cloneCandidate(parent, generation, `m${index}`);
  candidate.policy = mutatePolicyGenome(candidate.policy, rng, mutationScale);
  candidate.profile = createInternalProfile(candidate);
  return candidate;
}

function buildInitialPopulation(config, rng) {
  return Array.from({ length: config.populationSize }, (_, index) => createNeutralCandidate(rng, index));
}

function createStaticProfile(id, name, summary, weightOverrides = {}, tacticOverrides = {}, metaOverrides = {}) {
  const weights = Object.fromEntries(
    PROFILE_WEIGHT_KEYS.map(key => [key, roundTo(clamp(weightOverrides[key] ?? AI_NUM.N_1, WEIGHT_MIN, WEIGHT_MAX))])
  );
  const tactics = {
    independence: roundTo(clamp(tacticOverrides.independence ?? AI_NUM.N_1, TACTIC_MIN, TACTIC_MAX)),
    frontierAlarm: roundTo(clamp(tacticOverrides.frontierAlarm ?? AI_NUM.N_1, TACTIC_MIN, TACTIC_MAX)),
    churchReserve: roundTo(clamp(tacticOverrides.churchReserve ?? AI_NUM.N_1, TACTIC_MIN, TACTIC_MAX)),
    incumbencyGrip: roundTo(clamp(tacticOverrides.incumbencyGrip ?? AI_NUM.N_1, TACTIC_MIN, TACTIC_MAX)),
  };
  const meta = {};
  for (const [key, fallback, min, max] of META_PARAM_DEFS) {
    meta[key] = roundTo(clamp(metaOverrides[key] ?? fallback, min, max), AI_NUM.N_4);
  }
  return normalizeAiProfile({
    id,
    name,
    shortName: name,
    theory: 'Adversarial evaluation bot',
    summary,
    source: 'scripted-evaluator',
    basePersonalityId: null,
    weights,
    tactics,
    meta,
    policy: normalizePolicyGenome(metaOverrides.policy || {}),
  });
}

const SCRIPTED_OPPONENTS = [
  {
    id: 'always_coup_leader',
    bucket: 'scripted:always_coup_leader',
    profile: createStaticProfile(
      'scripted-always-coup-leader',
      'Coup Leader',
      'Pushes hard on capital leverage and throne pressure.',
      { frontier: AI_NUM.N_0_3, capital: AI_NUM.N_4_2, throne: AI_NUM.N_4_4, loyalty: AI_NUM.N_0_2, mercenary: AI_NUM.N_4, retaliation: AI_NUM.N_2_6, revocation: AI_NUM.N_2 },
      { independence: AI_NUM.N_1_6, frontierAlarm: AI_NUM.N_0_7, incumbencyGrip: AI_NUM.N_0_8 },
      { supportTemperature: AI_NUM.N_0_05, orderTemperature: AI_NUM.N_0_05 }
    ),
  },
  {
    id: 'free_rider',
    bucket: 'scripted:free_rider',
    profile: createStaticProfile(
      'scripted-free-rider',
      'Free Rider',
      'Optimizes for private gain while under-contributing to the frontier.',
      { wealth: AI_NUM.N_3_5, land: AI_NUM.N_3_8, frontier: AI_NUM.N_0_2, capital: AI_NUM.N_2_8, throne: AI_NUM.N_2_7, loyalty: AI_NUM.N_0_2, mercenary: AI_NUM.N_2_5 },
      { independence: AI_NUM.N_1_4, frontierAlarm: AI_NUM.N_0_55, churchReserve: AI_NUM.N_1_2 }
    ),
  },
  {
    id: 'frontier_defender',
    bucket: 'scripted:frontier_defender',
    profile: createStaticProfile(
      'scripted-frontier-defender',
      'Frontier Defender',
      'Over-indexes on imperial defense and stabilizing the incumbent.',
      { frontier: AI_NUM.N_4_4, loyalty: AI_NUM.N_2_8, capital: AI_NUM.N_0_6, throne: AI_NUM.N_0_5, wealth: AI_NUM.N_0_8, mercenary: AI_NUM.N_2_2 },
      { independence: AI_NUM.N_0_8, frontierAlarm: AI_NUM.N_2_1, incumbencyGrip: AI_NUM.N_1_8 }
    ),
  },
  {
    id: 'land_buyer',
    bucket: 'scripted:always_buy_land',
    profile: createStaticProfile(
      'scripted-land-buyer',
      'Land Buyer',
      'Treats the empire as a land rush and buys aggressively.',
      { wealth: AI_NUM.N_2_8, land: AI_NUM.N_4_4, frontier: AI_NUM.N_0_7, capital: AI_NUM.N_1_4, throne: AI_NUM.N_1_1, loyalty: AI_NUM.N_0_8 },
      { churchReserve: AI_NUM.N_1_6 },
      { landPurchaseThreshold: -AI_NUM.N_0_6 }
    ),
  },
  {
    id: 'church_gifter',
    bucket: 'scripted:always_gift_to_church',
    profile: createStaticProfile(
      'scripted-church-gifter',
      'Church Gifter',
      'Converts private themes into church leverage whenever possible.',
      { church: AI_NUM.N_4_4, loyalty: AI_NUM.N_2, land: AI_NUM.N_0_5, wealth: AI_NUM.N_0_8, frontier: AI_NUM.N_1_1, capital: AI_NUM.N_0_9, throne: AI_NUM.N_0_8 },
      { churchReserve: AI_NUM.N_0_55 },
      { churchGiftThreshold: AI_NUM.N_0_15 }
    ),
  },
  {
    id: 'punish_revocations',
    bucket: 'scripted:always_punish_revocations',
    profile: createStaticProfile(
      'scripted-punish-revocations',
      'Revocation Punisher',
      'Treats court aggression as a threat and leans into retaliation.',
      { retaliation: AI_NUM.N_4_2, revocation: AI_NUM.N_3_4, capital: AI_NUM.N_2_5, throne: AI_NUM.N_2_6, loyalty: AI_NUM.N_0_5, frontier: AI_NUM.N_0_8 },
      { independence: AI_NUM.N_1_5 }
    ),
  },
  {
    id: 'support_incumbent',
    bucket: 'scripted:always_support_incumbent',
    profile: createStaticProfile(
      'scripted-support-incumbent',
      'Incumbent Supporter',
      'Stabilizes the existing Basileus and avoids opportunistic coups.',
      { loyalty: AI_NUM.N_3_8, frontier: AI_NUM.N_2_6, capital: AI_NUM.N_0_5, throne: AI_NUM.N_0_4, selfAppointment: AI_NUM.N_0_5, retaliation: AI_NUM.N_0_6 },
      { independence: AI_NUM.N_0_7, incumbencyGrip: AI_NUM.N_2_2 },
      { supportTemperature: AI_NUM.N_0_05 }
    ),
  },
  {
    id: 'support_richest_rival',
    bucket: 'scripted:always_support_richest_rival',
    profile: createStaticProfile(
      'scripted-support-richest-rival',
      'Richest Rival Supporter',
      'Acts as a capital kingmaker behind the strongest non-incumbent challenger.',
      { capital: AI_NUM.N_3_8, throne: AI_NUM.N_3_4, loyalty: AI_NUM.N_0_6, frontier: AI_NUM.N_0_5, wealth: AI_NUM.N_1, mercenary: AI_NUM.N_2_8 },
      { independence: AI_NUM.N_1_5, frontierAlarm: AI_NUM.N_0_6 },
      { supportTemperature: AI_NUM.N_0_05, orderTemperature: AI_NUM.N_0_05 }
    ),
  },
  {
    id: 'deal_broker',
    bucket: 'scripted:deal_broker',
    profile: createStaticProfile(
      'scripted-deal-broker',
      'Deal Broker',
      'Actively trades gold, protection, and support when both sides can profit.',
      { wealth: AI_NUM.N_2_4, land: AI_NUM.N_1_8, frontier: AI_NUM.N_2, capital: AI_NUM.N_2_3, throne: AI_NUM.N_2, loyalty: AI_NUM.N_3_2, retaliation: AI_NUM.N_0_8, revocation: AI_NUM.N_0_8 },
      { independence: AI_NUM.N_0_9, frontierAlarm: AI_NUM.N_1_2, incumbencyGrip: AI_NUM.N_1_1 },
      { dealCounterThreshold: -AI_NUM.N_1_4 }
    ),
  },
  {
    id: 'hard_bargainer',
    bucket: 'scripted:hard_bargainer',
    profile: createStaticProfile(
      'scripted-hard-bargainer',
      'Hard Bargainer',
      'Uses deals opportunistically and rejects lopsided obligations.',
      { wealth: AI_NUM.N_3_2, land: AI_NUM.N_2_8, frontier: AI_NUM.N_0_9, capital: AI_NUM.N_2_6, throne: AI_NUM.N_2_8, loyalty: AI_NUM.N_0_6, retaliation: AI_NUM.N_2_4, revocation: AI_NUM.N_2_1 },
      { independence: AI_NUM.N_1_7, frontierAlarm: AI_NUM.N_0_8, incumbencyGrip: AI_NUM.N_0_9 },
      { dealCounterThreshold: -AI_NUM.N_0_25, dealRiskTolerance: AI_NUM.N_0_2 }
    ),
  },
];

function buildEmergentCentroids() {
  const centroids = [];
  for (let index = AI_NUM.N_0; index < AI_NUM.N_4; index++) {
    const rng = createRng(hashSeedString(`emergent-centroid:${index}`));
    centroids.push(createNeutralCandidate(rng, AI_NUM.N_5000 + index));
  }
  return centroids.map((candidate, index) => ({
    id: `cluster_${index}`,
    vector: encodeGenomeVector(candidate),
  }));
}

function encodeGenomeVector(candidateLike) {
  const vector = [];
  const policy = normalizePolicyGenome(candidateLike.policy || {});
  for (const key of POLICY_ACTION_KEYS) vector.push(normalizeRange(policy.actionPriors[key] ?? AI_NUM.N_0, -AI_NUM.N_6, AI_NUM.N_6));
  for (const key of POLICY_PHASE_KEYS) vector.push(normalizeRange(policy.phasePriors[key] ?? AI_NUM.N_0, -AI_NUM.N_4, AI_NUM.N_4));
  for (const key of POLICY_FEATURE_KEYS) vector.push(normalizeRange(policy.featureWeights[key] ?? AI_NUM.N_0, -AI_NUM.N_4, AI_NUM.N_4));
  for (const key of POLICY_IMPACT_KEYS) vector.push(normalizeRange(policy.impactWeights[key] ?? AI_NUM.N_0, -AI_NUM.N_3, AI_NUM.N_3));
  for (const key of POLICY_DEAL_SCORE_KEYS) vector.push(normalizeRange(policy.dealScoreWeights[key] ?? AI_NUM.N_0, -AI_NUM.N_4, AI_NUM.N_4));
  for (const key of POLICY_DEAL_STRATEGIC_KEYS) vector.push(normalizeRange(policy.dealStrategicWeights[key] ?? AI_NUM.N_0, -AI_NUM.N_4, AI_NUM.N_4));
  vector.push(normalizeRange(policy.scoreTemperature, AI_NUM.N_0_05, AI_NUM.N_3));
  vector.push(normalizeRange(policy.actionThreshold, -AI_NUM.N_6, AI_NUM.N_6));
  vector.push(normalizeRange(policy.maxCourtActionsPerRound, AI_NUM.N_1, AI_NUM.N_24));
  vector.push(normalizeRange(policy.maxActionRepeatsPerKind, AI_NUM.N_1, AI_NUM.N_10));
  vector.push(normalizeRange(policy.baseScoreWeight, -AI_NUM.N_2, AI_NUM.N_2));
  vector.push(normalizeRange(policy.dealCounterpartySurplusCap, AI_NUM.N_0, AI_NUM.N_5));
  vector.push(normalizeRange(policy.dealSingleTemplateLimit, AI_NUM.N_4, AI_NUM.N_36));
  vector.push(normalizeRange(policy.dealComboAskLimit, AI_NUM.N_1, AI_NUM.N_7));
  vector.push(normalizeRange(policy.dealComboGiveLimit, AI_NUM.N_1, AI_NUM.N_5));
  vector.push(normalizeRange(policy.dealTotalPayloadLimit, AI_NUM.N_8, AI_NUM.N_56));
  vector.push(normalizeRange(policy.dealIntentPayloadLimit, AI_NUM.N_4, AI_NUM.N_24));
  vector.push(normalizeRange(policy.dealProposalOptionLimit, AI_NUM.N_1, AI_NUM.N_12));
  vector.push(normalizeRange(policy.dealCounterOptionLimit, AI_NUM.N_1, AI_NUM.N_8));
  vector.push(normalizeRange(policy.orderPlanLimit, AI_NUM.N_8, AI_NUM.N_1024));
  vector.push(normalizeRange(policy.titleAssignmentLimit, AI_NUM.N_4, AI_NUM.N_1024));
  vector.push(normalizeRange(policy.mercenaryHireLimit, AI_NUM.N_1, AI_NUM.N_12));
  return vector;
}

const EMERGENT_CLUSTER_CENTROIDS = buildEmergentCentroids();

function getEmergentClusterId(candidateLike) {
  const vector = encodeGenomeVector(candidateLike);
  let bestId = 'cluster_0';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const centroid of EMERGENT_CLUSTER_CENTROIDS) {
    const distance = euclideanDistance(vector, centroid.vector);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = centroid.id;
    }
  }
  return bestId;
}

function getEmergentBucket(profile, prefix = 'emergent') {
  return `${prefix}:${getEmergentClusterId(profile)}`;
}

function getGenerationBucketTag(generation) {
  return `hof:generation_bucket_${Math.max(AI_NUM.N_0, Math.floor((Math.max(AI_NUM.N_1, generation) - AI_NUM.N_1) / AI_NUM.N_10))}`;
}

function trainingStage(generation, totalGenerations) {
  const progress = (generation - AI_NUM.N_1) / Math.max(AI_NUM.N_1, totalGenerations - AI_NUM.N_1);
  if (progress < AI_NUM.N_0_34) return 'early';
  if (progress < AI_NUM.N_0_67) return 'mid';
  return 'late';
}

function getPatternForSuite(scope, stage) {
  if (scope === 'validation') return ['scripted', 'emergent', 'hof', 'worst'];
  if (scope === 'holdout') return ['scripted', 'hof', 'worst', 'emergent', 'scripted'];
  if (scope === 'audit') return ['scripted', 'emergent', 'hof', 'worst', 'emergent'];
  if (stage === 'early') return ['population', 'emergent', 'scripted'];
  if (stage === 'mid') return ['population', 'scripted', 'emergent', 'hof'];
  return ['population', 'hof', 'worst', 'scripted', 'emergent'];
}

function createFreshEmergentProfile(seedKey) {
  const rng = createRng(hashSeedString(seedKey));
  return createNeutralCandidate(rng, hashSeedString(`${seedKey}:candidate`)).profile;
}

function buildSuiteDescriptor(source, scope, generation, matchIndex, slotIndex) {
  if (source === 'legacy') {
    const profile = createFreshEmergentProfile(`${scope}:g${generation}:m${matchIndex}:s${slotIndex}:legacy-removed`);
    return {
      source: 'emergent',
      bucket: getEmergentBucket(profile),
      profile,
    };
  }

  if (source === 'scripted') {
    const bot = SCRIPTED_OPPONENTS[(matchIndex + slotIndex) % SCRIPTED_OPPONENTS.length];
    return {
      source,
      bucket: bot.bucket,
      profile: bot.profile,
    };
  }

  if (source === 'emergent') {
    const seedKey = `${scope}:g${generation}:m${matchIndex}:s${slotIndex}:emergent`;
    const profile = createFreshEmergentProfile(seedKey);
    return {
      source,
      bucket: getEmergentBucket(profile),
      profile,
    };
  }

  if (source === 'worst') {
    return { source, offset: (matchIndex * AI_NUM.N_11) + (slotIndex * AI_NUM.N_17) };
  }

  return {
    source,
    offset: (matchIndex * AI_NUM.N_7) + (slotIndex * AI_NUM.N_13),
  };
}

function buildEvaluationSuite(config, scope, generation, matchCount, stage) {
  const pattern = getPatternForSuite(scope, stage);
  const playerCounts = config.playerCounts?.length ? config.playerCounts : [config.playerCount];
  const deckSizes = config.deckSizes?.length ? config.deckSizes : [config.deckSize];
  const scenarioCount = Math.max(AI_NUM.N_1, playerCounts.length * deckSizes.length);
  const scenarioOffset = (generation + (scope === 'validation' ? AI_NUM.N_1 : scope === 'holdout' ? AI_NUM.N_2 : scope === 'audit' ? AI_NUM.N_3 : AI_NUM.N_0)) % scenarioCount;
  const suite = [];

  for (let matchIndex = AI_NUM.N_0; matchIndex < matchCount; matchIndex++) {
    const scenarioIndex = (matchIndex + scenarioOffset) % scenarioCount;
    const playerCount = playerCounts[scenarioIndex % playerCounts.length];
    const deckSize = deckSizes[Math.floor(scenarioIndex / playerCounts.length) % deckSizes.length];
    const opponentCount = Math.max(AI_NUM.N_0, playerCount - AI_NUM.N_1);
    const descriptors = [];
    for (let slotIndex = AI_NUM.N_0; slotIndex < opponentCount; slotIndex++) {
      const source = pattern[(matchIndex + slotIndex) % pattern.length];
      descriptors.push(buildSuiteDescriptor(source, scope, generation, matchIndex, slotIndex));
    }
    suite.push({
      scope,
      generation,
      matchIndex,
      seed: `${config.seed}:${scope}:g${generation}:m${matchIndex}:${playerCount}p:${deckSize}d`,
      playerCount,
      deckSize,
      focalSeat: matchIndex % playerCount,
      descriptors,
    });
  }

  return suite;
}

function pickPopulationOpponent(population, focalId, offset) {
  if (!population.length) return null;
  for (let step = AI_NUM.N_0; step < population.length; step++) {
    const candidate = population[(offset + step) % population.length];
    if (candidate.id === focalId) continue;
    return {
      bucket: getEmergentBucket(candidate.profile),
      profile: candidate.profile,
    };
  }
  return null;
}

function pickHallOfFameOpponent(hallOfFame, offset) {
  if (!hallOfFame.length) return null;
  const entry = hallOfFame[offset % hallOfFame.length];
  return {
    bucket: entry.bucketTag,
    profile: entry.profile,
  };
}

function materializeOpponentDescriptor(descriptor, candidate, population, hallOfFame) {
  if (descriptor.profile) {
    return {
      bucket: descriptor.bucket,
      profile: descriptor.profile,
    };
  }

  if (descriptor.source === 'population') {
    return pickPopulationOpponent(population, candidate.id, descriptor.offset) || {
      bucket: getEmergentBucket(NEUTRAL_PROFILE),
      profile: createFreshEmergentProfile(`population-fallback:${descriptor.offset}`),
    };
  }

  if (descriptor.source === 'hof') {
    return pickHallOfFameOpponent(hallOfFame, descriptor.offset) || {
      bucket: getEmergentBucket(NEUTRAL_PROFILE),
      profile: createFreshEmergentProfile(`hof-fallback:${descriptor.offset}`),
    };
  }

  if (descriptor.source === 'worst') {
    const worstBucket = candidate.training?.worstMatchup?.bucket || candidate.profile?.training?.worstMatchup?.bucket || '';
    const scripted = SCRIPTED_OPPONENTS.find(bot => bot.bucket === worstBucket || bot.bucket.includes(worstBucket));
    if (scripted) return { bucket: scripted.bucket, profile: scripted.profile };
    if (String(worstBucket).startsWith('hof:')) {
      return pickHallOfFameOpponent(hallOfFame, descriptor.offset) || {
        bucket: getEmergentBucket(NEUTRAL_PROFILE),
        profile: createFreshEmergentProfile(`worst-hof-fallback:${descriptor.offset}`),
      };
    }
    const profile = createFreshEmergentProfile(`worst:${worstBucket || 'unknown'}:${descriptor.offset}`);
    return { bucket: getEmergentBucket(profile, 'worst'), profile };
  }

  return {
    bucket: getEmergentBucket(NEUTRAL_PROFILE),
    profile: createFreshEmergentProfile(`descriptor-fallback:${descriptor.source}:${descriptor.offset || AI_NUM.N_0}`),
  };
}

function buildMatchSeatProfiles(candidate, matchSpec, population, hallOfFame, playerCount) {
  const seatProfiles = {};
  const opponentBuckets = [];
  const seatIds = Array.from({ length: playerCount }, (_, index) => index);
  const opponentSeats = seatIds.filter(seatId => seatId !== matchSpec.focalSeat);

  seatProfiles[matchSpec.focalSeat] = candidate.profile;
  matchSpec.descriptors.forEach((descriptor, index) => {
    const seatId = opponentSeats[index];
    if (seatId == null) return;
    const opponent = materializeOpponentDescriptor(descriptor, candidate, population, hallOfFame);
    opponentBuckets.push(opponent.bucket);
    seatProfiles[seatId] = opponent.profile;
  });

  return {
    seatProfiles,
    opponentBuckets,
  };
}

function computePlacementScore(game, playerMetric) {
  const orderedScores = game.playerMetrics.map(metric => metric.finalScore ?? metric.finalWealth).sort((left, right) => right - left);
  const playerScore = playerMetric.finalScore ?? playerMetric.finalWealth;
  const placement = orderedScores.findIndex(score => score === playerScore);
  if (placement === -AI_NUM.N_1) return AI_NUM.N_0;
  return (game.playerMetrics.length - placement - AI_NUM.N_1) / Math.max(AI_NUM.N_1, game.playerMetrics.length - AI_NUM.N_1);
}

function computeScoreRatio(game, playerMetric) {
  const meanScore = average(game.playerMetrics.map(metric => metric.finalScore ?? metric.finalWealth));
  const playerScore = playerMetric.finalScore ?? playerMetric.finalWealth;
  return meanScore > AI_NUM.N_0 ? playerScore / meanScore : AI_NUM.N_1;
}

function computeWealthRatio(game, playerMetric) {
  return computeScoreRatio(game, playerMetric);
}

function getWarContribution(war, playerId) {
  const contributions = Array.isArray(war?.contributions) ? war.contributions : [];
  return contributions
    .filter(entry => entry.playerId === playerId)
    .reduce((total, entry) => total + Math.max(AI_NUM.N_0, Number(entry.troops) || AI_NUM.N_0), AI_NUM.N_0);
}

function computeCollapseDefenseProfile(game, playerMetric) {
  const wars = Array.isArray(game?.wars) ? game.wars.filter(war => (Number(war?.strength) || AI_NUM.N_0) > AI_NUM.N_0) : [];
  if (!wars.length) {
    return {
      defenseCoverage: AI_NUM.N_0,
      fatalCoverage: AI_NUM.N_0,
      commitmentRate: AI_NUM.N_0,
    };
  }

  const totalThreat = wars.reduce((total, war) => total + Math.max(AI_NUM.N_0, Number(war.strength) || AI_NUM.N_0), AI_NUM.N_0);
  const defendedThreat = wars.reduce((total, war) => {
    const threat = Math.max(AI_NUM.N_0, Number(war.strength) || AI_NUM.N_0);
    const contribution = getWarContribution(war, playerMetric.playerId);
    return total + Math.min(contribution, threat);
  }, AI_NUM.N_0);
  const fatalWar = wars.find(war => Boolean(war.reachedCPL)) || wars[wars.length - AI_NUM.N_1];
  const fatalThreat = Math.max(AI_NUM.N_0, Number(fatalWar?.strength) || AI_NUM.N_0);
  const fatalContribution = fatalWar ? getWarContribution(fatalWar, playerMetric.playerId) : AI_NUM.N_0;
  const totalTroopsCommitted = Math.max(AI_NUM.N_0, Number(playerMetric.frontierTroops) || AI_NUM.N_0) + Math.max(AI_NUM.N_0, Number(playerMetric.capitalTroops) || AI_NUM.N_0);

  return {
    defenseCoverage: totalThreat > AI_NUM.N_0 ? defendedThreat / totalThreat : AI_NUM.N_0,
    fatalCoverage: fatalThreat > AI_NUM.N_0 ? Math.min(fatalContribution, fatalThreat) / fatalThreat : AI_NUM.N_0,
    commitmentRate: totalTroopsCommitted > AI_NUM.N_0
      ? Math.max(AI_NUM.N_0, Number(playerMetric.frontierTroops) || AI_NUM.N_0) / totalTroopsCommitted
      : AI_NUM.N_0,
  };
}

function computeCollapseFitness(game, playerMetric, fitnessWeights) {
  if (game.guardTriggered) return -fitnessWeights.collapsePenalty;

  const collapse = computeCollapseDefenseProfile(game, playerMetric);
  const defenseSignal = clamp(
    (collapse.defenseCoverage * AI_NUM.N_0_5) +
    (collapse.fatalCoverage * AI_NUM.N_0_35) +
    (collapse.commitmentRate * AI_NUM.N_0_15),
    AI_NUM.N_0,
    AI_NUM.N_1
  );
  const defenseCredit = defenseSignal * fitnessWeights.collapsePenalty * AI_NUM.N_0_65;
  const freeRidePenalty = (AI_NUM.N_1 - defenseSignal) * fitnessWeights.collapsePenalty * AI_NUM.N_0_2;

  return roundTo(-fitnessWeights.collapsePenalty + defenseCredit - freeRidePenalty, AI_NUM.N_4);
}

function computeFitness(game, playerMetric, fitnessWeights) {
  if (game.guardTriggered || game.empireFall) {
    return computeCollapseFitness(game, playerMetric, fitnessWeights);
  }

  const placementScore = computePlacementScore(game, playerMetric);
  const winnerBonus = playerMetric.isWinner ? AI_NUM.N_1 / Math.max(AI_NUM.N_1, game.winners.length) : AI_NUM.N_0;
  const scoreRatio = computeScoreRatio(game, playerMetric);
  const dealUtility = clamp(Number(playerMetric.dealUtility) || AI_NUM.N_0, -AI_NUM.N_8, AI_NUM.N_8);
  const badAcceptedDeals = Math.max(AI_NUM.N_0, Number(playerMetric.badAcceptedDeals) || AI_NUM.N_0);
  const dealAttempts = Math.max(AI_NUM.N_1, (Number(playerMetric.dealsProposed) || AI_NUM.N_0) + (Number(playerMetric.dealsCountered) || AI_NUM.N_0));
  const usefulDealRate = clamp(((Number(playerMetric.dealsAccepted) || AI_NUM.N_0) - badAcceptedDeals) / dealAttempts, AI_NUM.N_0, AI_NUM.N_1);
  const decisionQuality = clamp(Number(playerMetric.decisionQuality) || AI_NUM.N_0, AI_NUM.N_0, AI_NUM.N_1);
  const projectionError = clamp(Number(playerMetric.projectionError) || AI_NUM.N_0, AI_NUM.N_0, AI_NUM.N_2);

  return roundTo(
    fitnessWeights.survivalBonus +
    (winnerBonus * fitnessWeights.winReward) +
    (placementScore * fitnessWeights.placementReward) +
    (Math.min(scoreRatio, AI_NUM.N_3) * fitnessWeights.wealthReward) +
    (dealUtility * (fitnessWeights.dealUtilityReward ?? AI_NUM.N_0)) +
    (usefulDealRate * (fitnessWeights.dealAcceptanceReward ?? AI_NUM.N_0)) -
    (badAcceptedDeals * (fitnessWeights.badDealPenalty ?? AI_NUM.N_0)) +
    (decisionQuality * (fitnessWeights.decisionQualityReward ?? AI_NUM.N_0)) -
    (projectionError * (fitnessWeights.projectionErrorPenalty ?? AI_NUM.N_0)),
    AI_NUM.N_4
  );
}

function createBucketMap() {
  return new Map();
}

function addWeightedBucketStats(bucketMap, bucketKey, weight, winCredit, fitness) {
  if (!bucketMap.has(bucketKey)) {
    bucketMap.set(bucketKey, { matches: AI_NUM.N_0, wins: AI_NUM.N_0, fitnessTotal: AI_NUM.N_0 });
  }
  const bucket = bucketMap.get(bucketKey);
  bucket.matches += weight;
  bucket.wins += winCredit * weight;
  bucket.fitnessTotal += fitness * weight;
}

function createEvaluationAccumulator(candidate, generation, scope) {
  return {
    candidate,
    generation,
    scope,
    matches: AI_NUM.N_0,
    weightedWins: AI_NUM.N_0,
    fitnessTotal: AI_NUM.N_0,
    fitnessSamples: [],
    scoreTotal: AI_NUM.N_0,
    scorePercentileTotal: AI_NUM.N_0,
    scoreRatioTotal: AI_NUM.N_0,
    wealthTotal: AI_NUM.N_0,
    wealthPercentileTotal: AI_NUM.N_0,
    wealthRatioTotal: AI_NUM.N_0,
    empireFalls: AI_NUM.N_0,
    guardAborts: AI_NUM.N_0,
    scenarioStats: new Map(),
    seatStats: new Map(),
    opponentTypeStats: createBucketMap(),
    opponentClassStats: createBucketMap(),
    behaviorTotals: {
      frontierShare: AI_NUM.N_0,
      capitalShare: AI_NUM.N_0,
      landBuys: AI_NUM.N_0,
      churchGifts: AI_NUM.N_0,
      revocations: AI_NUM.N_0,
      defenderRewards: AI_NUM.N_0,
      defenderGoldChoices: AI_NUM.N_0,
      defenderRestoreChoices: AI_NUM.N_0,
      defenderRewardGold: AI_NUM.N_0,
      throneCaptures: AI_NUM.N_0,
      titleShuffles: AI_NUM.N_0,
      supporterTitleRewards: AI_NUM.N_0,
      rivalOfficeDenials: AI_NUM.N_0,
      incumbentSupportRate: AI_NUM.N_0,
      selfSupportRate: AI_NUM.N_0,
      goldHoardingRate: AI_NUM.N_0,
      mercSpend: AI_NUM.N_0,
      recruitmentUtilization: AI_NUM.N_0,
      dealsProposed: AI_NUM.N_0,
      dealsAccepted: AI_NUM.N_0,
      dealsCountered: AI_NUM.N_0,
      dealsRefused: AI_NUM.N_0,
      dealUtility: AI_NUM.N_0,
      badAcceptedDeals: AI_NUM.N_0,
      coordinatedClaimantDeals: AI_NUM.N_0,
      frontierCoordinationDeals: AI_NUM.N_0,
      systemicDecisionCount: AI_NUM.N_0,
      projectedUtility: AI_NUM.N_0,
      projectedRisk: AI_NUM.N_0,
      projectedFlexibility: AI_NUM.N_0,
      projectionError: AI_NUM.N_0,
      decisionQuality: AI_NUM.N_0,
    },
    collapseDiagnostics: {
      matches: AI_NUM.N_0,
      defenseCoverage: AI_NUM.N_0,
      fatalCoverage: AI_NUM.N_0,
      commitmentRate: AI_NUM.N_0,
    },
    basileusSeatWins: AI_NUM.N_0,
    basileusSeatMatches: AI_NUM.N_0,
    nonBasileusSeatWins: AI_NUM.N_0,
    nonBasileusSeatMatches: AI_NUM.N_0,
  };
}

function updateSeatStats(seatStats, seatId, winCredit, fitness) {
  if (!seatStats.has(seatId)) {
    seatStats.set(seatId, { matches: AI_NUM.N_0, wins: AI_NUM.N_0, fitnessTotal: AI_NUM.N_0 });
  }
  const bucket = seatStats.get(seatId);
  bucket.matches++;
  bucket.wins += winCredit;
  bucket.fitnessTotal += fitness;
}

function finalizeWinRateMap(statsMap) {
  const finalized = {};
  for (const [key, bucket] of statsMap.entries()) {
    finalized[key] = {
      matches: bucket.matches,
      winRate: roundTo(bucket.wins / Math.max(AI_NUM.N_1, bucket.matches), AI_NUM.N_4),
      averageFitness: roundTo(bucket.fitnessTotal / Math.max(AI_NUM.N_1, bucket.matches), AI_NUM.N_4),
    };
  }
  return finalized;
}

function finalizeBucketStats(bucketMap) {
  const finalized = {};
  for (const [bucketKey, bucket] of bucketMap.entries()) {
    finalized[bucketKey] = {
      matches: roundTo(bucket.matches, AI_NUM.N_4),
      winRate: roundTo(bucket.wins / Math.max(AI_NUM.N_0_0001, bucket.matches), AI_NUM.N_4),
      averageFitness: roundTo(bucket.fitnessTotal / Math.max(AI_NUM.N_0_0001, bucket.matches), AI_NUM.N_4),
    };
  }
  return finalized;
}

function pickMatchupExtremes(perOpponentTypeWinRate) {
  const entries = Object.entries(perOpponentTypeWinRate).filter(([, value]) => value.matches > AI_NUM.N_0);
  if (!entries.length) {
    return {
      bestMatchup: null,
      worstMatchup: null,
    };
  }

  const best = entries.slice().sort((left, right) => right[AI_NUM.N_1].winRate - left[AI_NUM.N_1].winRate || right[AI_NUM.N_1].matches - left[AI_NUM.N_1].matches)[AI_NUM.N_0];
  const worst = entries.slice().sort((left, right) => left[AI_NUM.N_1].winRate - right[AI_NUM.N_1].winRate || right[AI_NUM.N_1].matches - left[AI_NUM.N_1].matches)[AI_NUM.N_0];
  return {
    bestMatchup: { tag: best[AI_NUM.N_0], ...best[AI_NUM.N_1] },
    worstMatchup: { tag: worst[AI_NUM.N_0], ...worst[AI_NUM.N_1] },
  };
}

function buildBehaviorVector(summary) {
  const behavior = summary.behaviorProfile;
  return [
    clamp(behavior.frontierTroopShare, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.capitalTroopShare, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageLandBuys / AI_NUM.N_3, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageChurchGifts / AI_NUM.N_3, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageRevocations / AI_NUM.N_2, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageDefenderRewards / AI_NUM.N_3, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.defenderGoldChoiceRate, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageThroneCaptures / AI_NUM.N_2, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageTitleShuffles / AI_NUM.N_4, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.supporterTitleRewardRate, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.incumbentSupportRate, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.selfSupportRate, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.goldHoardingRate, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageMercSpend / AI_NUM.N_15, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.recruitmentUtilization, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageDealsProposed / AI_NUM.N_2, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.dealAcceptanceRate, AI_NUM.N_0, AI_NUM.N_1),
    clamp((behavior.averageDealUtility + AI_NUM.N_4) / AI_NUM.N_8, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.badAcceptedDealRate, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageCoordinatedClaimantDeals / AI_NUM.N_2, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageFrontierCoordinationDeals / AI_NUM.N_2, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageSystemicDecisions / AI_NUM.N_8, AI_NUM.N_0, AI_NUM.N_1),
    clamp((behavior.averageProjectedUtility + AI_NUM.N_4) / AI_NUM.N_8, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageProjectionError, AI_NUM.N_0, AI_NUM.N_1),
    clamp(behavior.averageDecisionQuality, AI_NUM.N_0, AI_NUM.N_1),
  ];
}

function finalizeEvaluationSummary(accumulator) {
  const perOpponentTypeWinRate = finalizeBucketStats(accumulator.opponentTypeStats);
  const perOpponentClassWinRate = finalizeBucketStats(accumulator.opponentClassStats);
  const perScenarioWinRate = finalizeWinRateMap(accumulator.scenarioStats);
  const perSeatWinRate = finalizeWinRateMap(accumulator.seatStats);

  const scenarioVariance = variance(Object.values(perScenarioWinRate).map(bucket => bucket.winRate));
  const opponentVariance = variance(Object.values(perOpponentTypeWinRate).map(bucket => bucket.winRate));
  const seatVariance = variance(Object.values(perSeatWinRate).map(bucket => bucket.winRate));
  const totalTroopShare = Math.max(AI_NUM.N_0_0001, accumulator.behaviorTotals.frontierShare + accumulator.behaviorTotals.capitalShare);
  const basileusSeatWinShare = accumulator.basileusSeatMatches
    ? accumulator.basileusSeatWins / accumulator.basileusSeatMatches
    : AI_NUM.N_0;
  const nonBasileusSeatWinShare = accumulator.nonBasileusSeatMatches
    ? accumulator.nonBasileusSeatWins / accumulator.nonBasileusSeatMatches
    : AI_NUM.N_0;
  const matchupExtremes = pickMatchupExtremes(perOpponentTypeWinRate);
  const dealAttempts = accumulator.behaviorTotals.dealsProposed + accumulator.behaviorTotals.dealsCountered;
  const dealAccepted = accumulator.behaviorTotals.dealsAccepted;
  const defenderChoices = accumulator.behaviorTotals.defenderGoldChoices + accumulator.behaviorTotals.defenderRestoreChoices;
  const titleShuffles = accumulator.behaviorTotals.titleShuffles;

  const summary = {
    generation: accumulator.generation,
    scope: accumulator.scope,
    matches: accumulator.matches,
    wins: roundTo(accumulator.weightedWins, AI_NUM.N_4),
    winShare: roundTo(accumulator.weightedWins / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
    averageFitness: roundTo(accumulator.fitnessTotal / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
    averageScore: roundTo(accumulator.scoreTotal / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_2),
    scorePercentile: roundTo(accumulator.scorePercentileTotal / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
    lowerConfidenceWinShare: lowerConfidenceRate(accumulator.weightedWins / Math.max(AI_NUM.N_1, accumulator.matches), accumulator.matches),
    lowerConfidenceScorePercentile: lowerConfidenceRate(accumulator.scorePercentileTotal / Math.max(AI_NUM.N_1, accumulator.matches), accumulator.matches),
    scoreRatio: roundTo(accumulator.scoreRatioTotal / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
    averageWealth: roundTo(accumulator.wealthTotal / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_2),
    wealthPercentile: roundTo(accumulator.wealthPercentileTotal / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
    wealthRatio: roundTo(accumulator.wealthRatioTotal / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
    empireFallRate: roundTo(accumulator.empireFalls / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
    guardRate: roundTo(accumulator.guardAborts / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
    fitnessVariance: roundTo(variance(accumulator.fitnessSamples), AI_NUM.N_4),
    scenarioVariance: roundTo(scenarioVariance, AI_NUM.N_4),
    opponentVariance: roundTo(opponentVariance, AI_NUM.N_4),
    seatVariance: roundTo(seatVariance, AI_NUM.N_4),
    perScenarioWinRate,
    perOpponentTypeWinRate,
    perOpponentClassWinRate,
    perSeatWinRate,
    bestMatchup: matchupExtremes.bestMatchup,
    worstMatchup: matchupExtremes.worstMatchup,
    startingBasileusSeatBias: roundTo(basileusSeatWinShare - nonBasileusSeatWinShare, AI_NUM.N_4),
    behaviorProfile: {
      frontierTroopShare: roundTo(accumulator.behaviorTotals.frontierShare / totalTroopShare, AI_NUM.N_4),
      capitalTroopShare: roundTo(accumulator.behaviorTotals.capitalShare / totalTroopShare, AI_NUM.N_4),
      averageLandBuys: roundTo(accumulator.behaviorTotals.landBuys / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageChurchGifts: roundTo(accumulator.behaviorTotals.churchGifts / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageRevocations: roundTo(accumulator.behaviorTotals.revocations / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageDefenderRewards: roundTo(accumulator.behaviorTotals.defenderRewards / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      defenderGoldChoiceRate: roundTo(accumulator.behaviorTotals.defenderGoldChoices / Math.max(AI_NUM.N_1, defenderChoices), AI_NUM.N_4),
      averageDefenderRewardGold: roundTo(accumulator.behaviorTotals.defenderRewardGold / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageThroneCaptures: roundTo(accumulator.behaviorTotals.throneCaptures / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageTitleShuffles: roundTo(titleShuffles / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      supporterTitleRewardRate: roundTo(accumulator.behaviorTotals.supporterTitleRewards / Math.max(AI_NUM.N_1, titleShuffles), AI_NUM.N_4),
      rivalOfficeDenialRate: roundTo(accumulator.behaviorTotals.rivalOfficeDenials / Math.max(AI_NUM.N_1, titleShuffles), AI_NUM.N_4),
      incumbentSupportRate: roundTo(accumulator.behaviorTotals.incumbentSupportRate / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      selfSupportRate: roundTo(accumulator.behaviorTotals.selfSupportRate / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      goldHoardingRate: roundTo(accumulator.behaviorTotals.goldHoardingRate / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageMercSpend: roundTo(accumulator.behaviorTotals.mercSpend / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      recruitmentUtilization: roundTo(accumulator.behaviorTotals.recruitmentUtilization / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageDealsProposed: roundTo(accumulator.behaviorTotals.dealsProposed / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageDealsAccepted: roundTo(dealAccepted / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageDealsCountered: roundTo(accumulator.behaviorTotals.dealsCountered / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageDealsRefused: roundTo(accumulator.behaviorTotals.dealsRefused / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      dealAcceptanceRate: roundTo(dealAccepted / Math.max(AI_NUM.N_1, dealAttempts), AI_NUM.N_4),
      averageDealUtility: roundTo(accumulator.behaviorTotals.dealUtility / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      badAcceptedDealRate: roundTo(accumulator.behaviorTotals.badAcceptedDeals / Math.max(AI_NUM.N_1, dealAccepted), AI_NUM.N_4),
      averageCoordinatedClaimantDeals: roundTo(accumulator.behaviorTotals.coordinatedClaimantDeals / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageFrontierCoordinationDeals: roundTo(accumulator.behaviorTotals.frontierCoordinationDeals / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageSystemicDecisions: roundTo(accumulator.behaviorTotals.systemicDecisionCount / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageProjectedUtility: roundTo(accumulator.behaviorTotals.projectedUtility / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageProjectedRisk: roundTo(accumulator.behaviorTotals.projectedRisk / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageProjectedFlexibility: roundTo(accumulator.behaviorTotals.projectedFlexibility / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageProjectionError: roundTo(accumulator.behaviorTotals.projectionError / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
      averageDecisionQuality: roundTo(accumulator.behaviorTotals.decisionQuality / Math.max(AI_NUM.N_1, accumulator.matches), AI_NUM.N_4),
    },
    collapseDiagnostics: {
      defenseCoverage: roundTo(accumulator.collapseDiagnostics.defenseCoverage / Math.max(AI_NUM.N_1, accumulator.collapseDiagnostics.matches), AI_NUM.N_4),
      fatalCoverage: roundTo(accumulator.collapseDiagnostics.fatalCoverage / Math.max(AI_NUM.N_1, accumulator.collapseDiagnostics.matches), AI_NUM.N_4),
      commitmentRate: roundTo(accumulator.collapseDiagnostics.commitmentRate / Math.max(AI_NUM.N_1, accumulator.collapseDiagnostics.matches), AI_NUM.N_4),
    },
  };
  summary.behaviorVector = buildBehaviorVector(summary);
  return summary;
}

function evaluateCandidateOnSuite(candidate, suite, context, fitnessWeights) {
  const accumulator = createEvaluationAccumulator(candidate, context.generation, context.scope);
  for (const matchSpec of suite) {
    const { seatProfiles, opponentBuckets } = buildMatchSeatProfiles(
      candidate,
      matchSpec,
      context.population,
      context.hallOfFame,
      matchSpec.playerCount
    );
    const game = runSingleSimulationGame({
      playerCount: matchSpec.playerCount,
      deckSize: matchSpec.deckSize,
      seed: matchSpec.seed,
      seatProfiles,
      strictTimeoutMs: AI_NUM.N_15000,
      maxLoopIterations: AI_NUM.N_256,
      maxRounds: Math.max(matchSpec.deckSize + AI_NUM.N_2, AI_NUM.N_40),
    });
    const playerMetric = game.playerMetrics.find(metric => metric.playerId === matchSpec.focalSeat);
    if (!playerMetric) continue;

    const winCredit = playerMetric.isWinner ? AI_NUM.N_1 / Math.max(AI_NUM.N_1, game.winners.length) : AI_NUM.N_0;
    const fitness = computeFitness(game, playerMetric, fitnessWeights);
    const placementScore = computePlacementScore(game, playerMetric);
    const scoreRatio = computeScoreRatio(game, playerMetric);
    const finalScore = playerMetric.finalScore ?? playerMetric.finalWealth;
    const totalTroops = Math.max(AI_NUM.N_0, playerMetric.frontierTroops) + Math.max(AI_NUM.N_0, playerMetric.capitalTroops);
    const frontierShare = totalTroops > AI_NUM.N_0 ? playerMetric.frontierTroops / totalTroops : AI_NUM.N_0;
    const capitalShare = totalTroops > AI_NUM.N_0 ? playerMetric.capitalTroops / totalTroops : AI_NUM.N_0;
    const recruitUtilization = playerMetric.recruitOpportunities > AI_NUM.N_0
      ? playerMetric.recruits / playerMetric.recruitOpportunities
      : AI_NUM.N_0;
    const incumbentSupportRate = playerMetric.coupVotes > AI_NUM.N_0
      ? playerMetric.supportIncumbentVotes / playerMetric.coupVotes
      : AI_NUM.N_0;
    const selfSupportRate = playerMetric.coupVotes > AI_NUM.N_0
      ? playerMetric.supportSelfVotes / playerMetric.coupVotes
      : AI_NUM.N_0;
    const goldHoardingRate = clamp(Number(playerMetric.finalCategoryShares?.gold) || AI_NUM.N_0, AI_NUM.N_0, AI_NUM.N_1);

    accumulator.matches++;
    accumulator.weightedWins += winCredit;
    accumulator.fitnessTotal += fitness;
    accumulator.fitnessSamples.push(fitness);
    accumulator.scoreTotal += finalScore;
    accumulator.scorePercentileTotal += placementScore;
    accumulator.scoreRatioTotal += scoreRatio;
    accumulator.wealthTotal += finalScore;
    accumulator.wealthPercentileTotal += placementScore;
    accumulator.wealthRatioTotal += scoreRatio;
    if (game.empireFall) accumulator.empireFalls++;
    if (game.guardTriggered) accumulator.guardAborts++;

    updateSeatStats(accumulator.scenarioStats, `${matchSpec.playerCount}p-${matchSpec.deckSize}d`, winCredit, fitness);
    updateSeatStats(accumulator.seatStats, matchSpec.focalSeat, winCredit, fitness);
    if (game.startingBasileusId === playerMetric.playerId) {
      accumulator.basileusSeatMatches++;
      accumulator.basileusSeatWins += winCredit;
    } else {
      accumulator.nonBasileusSeatMatches++;
      accumulator.nonBasileusSeatWins += winCredit;
    }

    const bucketCounts = new Map();
    for (const bucket of opponentBuckets) {
      bucketCounts.set(bucket, (bucketCounts.get(bucket) || AI_NUM.N_0) + AI_NUM.N_1);
    }
    for (const [bucketKey, count] of bucketCounts.entries()) {
      const weight = count / Math.max(AI_NUM.N_1, opponentBuckets.length);
      addWeightedBucketStats(accumulator.opponentTypeStats, bucketKey, weight, winCredit, fitness);
      const bucketClass = String(bucketKey).split(':')[AI_NUM.N_0];
      addWeightedBucketStats(accumulator.opponentClassStats, bucketClass, weight, winCredit, fitness);
    }

    accumulator.behaviorTotals.frontierShare += frontierShare;
    accumulator.behaviorTotals.capitalShare += capitalShare;
    accumulator.behaviorTotals.landBuys += playerMetric.landBuys;
    accumulator.behaviorTotals.churchGifts += playerMetric.themesGifted;
    accumulator.behaviorTotals.revocations += playerMetric.revocations;
    accumulator.behaviorTotals.defenderRewards += playerMetric.defenderRewards || AI_NUM.N_0;
    accumulator.behaviorTotals.defenderGoldChoices += playerMetric.defenderGoldChoices || AI_NUM.N_0;
    accumulator.behaviorTotals.defenderRestoreChoices += playerMetric.defenderRestoreChoices || AI_NUM.N_0;
    accumulator.behaviorTotals.defenderRewardGold += playerMetric.defenderRewardGold || AI_NUM.N_0;
    accumulator.behaviorTotals.throneCaptures += playerMetric.throneCaptures;
    accumulator.behaviorTotals.titleShuffles += playerMetric.titleShuffles || AI_NUM.N_0;
    accumulator.behaviorTotals.supporterTitleRewards += playerMetric.supporterTitleRewards || AI_NUM.N_0;
    accumulator.behaviorTotals.rivalOfficeDenials += playerMetric.rivalOfficeDenials || AI_NUM.N_0;
    accumulator.behaviorTotals.incumbentSupportRate += incumbentSupportRate;
    accumulator.behaviorTotals.selfSupportRate += selfSupportRate;
    accumulator.behaviorTotals.goldHoardingRate += goldHoardingRate;
    accumulator.behaviorTotals.mercSpend += playerMetric.mercSpend;
    accumulator.behaviorTotals.recruitmentUtilization += recruitUtilization;
    accumulator.behaviorTotals.dealsProposed += playerMetric.dealsProposed || AI_NUM.N_0;
    accumulator.behaviorTotals.dealsAccepted += playerMetric.dealsAccepted || AI_NUM.N_0;
    accumulator.behaviorTotals.dealsCountered += playerMetric.dealsCountered || AI_NUM.N_0;
    accumulator.behaviorTotals.dealsRefused += playerMetric.dealsRefused || AI_NUM.N_0;
    accumulator.behaviorTotals.dealUtility += playerMetric.dealUtility || AI_NUM.N_0;
    accumulator.behaviorTotals.badAcceptedDeals += playerMetric.badAcceptedDeals || AI_NUM.N_0;
    accumulator.behaviorTotals.coordinatedClaimantDeals += playerMetric.coordinatedClaimantDeals || AI_NUM.N_0;
    accumulator.behaviorTotals.frontierCoordinationDeals += playerMetric.frontierCoordinationDeals || AI_NUM.N_0;
    accumulator.behaviorTotals.systemicDecisionCount += playerMetric.systemicDecisionCount || AI_NUM.N_0;
    accumulator.behaviorTotals.projectedUtility += playerMetric.projectedUtility || AI_NUM.N_0;
    accumulator.behaviorTotals.projectedRisk += playerMetric.projectedRisk || AI_NUM.N_0;
    accumulator.behaviorTotals.projectedFlexibility += playerMetric.projectedFlexibility || AI_NUM.N_0;
    accumulator.behaviorTotals.projectionError += playerMetric.projectionError || AI_NUM.N_0;
    accumulator.behaviorTotals.decisionQuality += playerMetric.decisionQuality || AI_NUM.N_0;

    if (game.empireFall) {
      const collapse = computeCollapseDefenseProfile(game, playerMetric);
      accumulator.collapseDiagnostics.matches++;
      accumulator.collapseDiagnostics.defenseCoverage += collapse.defenseCoverage;
      accumulator.collapseDiagnostics.fatalCoverage += collapse.fatalCoverage;
      accumulator.collapseDiagnostics.commitmentRate += collapse.commitmentRate;
    }
  }

  return finalizeEvaluationSummary(accumulator);
}

export function evaluateWorkerPayload(payload = {}) {
  const {
    mode = 'generation',
    candidates = [],
    trainingSuite = [],
    validationSuite = [],
    holdoutSuite = [],
    population = [],
    hallOfFame = [],
    config = {},
    generation = AI_NUM.N_1,
    fitnessWeights = DEFAULT_FITNESS_WEIGHTS,
  } = payload;

  const evaluateSuite = (candidate, suite, scope) => evaluateCandidateOnSuite(candidate, suite, {
    config,
    generation,
    scope,
    population,
    hallOfFame,
  }, fitnessWeights);

  if (mode === 'generation') {
    return candidates.map(candidate => ({
      candidateId: candidate.id,
      trainSummary: evaluateSuite(candidate, trainingSuite, 'training'),
      validationSummary: evaluateSuite(candidate, validationSuite, 'validation'),
    }));
  }

  if (mode === 'holdout' || mode === 'audit') {
    const suite = mode === 'audit' ? payload.auditSuite || holdoutSuite : holdoutSuite;
    return candidates.map(candidate => ({
      candidateId: candidate.id,
      holdoutSummary: evaluateSuite(candidate, suite, mode),
    }));
  }

  throw new Error(`Unknown evaluation worker mode: ${mode}`);
}

function getClassWinRate(summary, bucketClass) {
  const bucket = summary.perOpponentClassWinRate[bucketClass];
  return bucket ? bucket.winRate : summary.winShare;
}

function computeNoveltyScore(vector, archiveVectors, peerVectors) {
  const comparisons = [];
  for (const other of archiveVectors) {
    if (other) comparisons.push(euclideanDistance(vector, other));
  }
  for (const other of peerVectors) {
    if (other && other !== vector) comparisons.push(euclideanDistance(vector, other));
  }
  if (!comparisons.length) return AI_NUM.N_1;
  const distances = comparisons.sort((left, right) => left - right);
  const k = Math.min(AI_NUM.N_5, distances.length);
  return roundTo(average(distances.slice(AI_NUM.N_0, k)), AI_NUM.N_4);
}

function computeDisplayScore(summary, noveltyScore) {
  return roundTo(
    ((summary.lowerConfidenceWinShare ?? summary.winShare) * AI_NUM.N_10) +
    ((AI_NUM.N_1 - summary.empireFallRate - summary.guardRate) * AI_NUM.N_8) +
    ((summary.lowerConfidenceScorePercentile ?? summary.scorePercentile ?? summary.wealthPercentile) * AI_NUM.N_4) +
    (getClassWinRate(summary, 'scripted') * AI_NUM.N_4) +
    (getClassWinRate(summary, 'hof') * AI_NUM.N_4) +
    (noveltyScore * AI_NUM.N_2) -
    (Math.sqrt(summary.opponentVariance) * AI_NUM.N_2_5) -
    (Math.sqrt(summary.seatVariance) * AI_NUM.N_1_5),
    AI_NUM.N_4
  );
}

function buildSelectionEntry(candidate, generation, trainSummary, validationSummary, noveltyScore) {
  candidate.training = {
    ...(candidate.training || {}),
    worstMatchup: validationSummary.worstMatchup || null,
  };
  candidate.profile = createInternalProfile(candidate);
  return {
    candidate,
    generation,
    trainSummary,
    validationSummary,
    holdoutSummary: null,
    noveltyScore,
    displayScore: computeDisplayScore(validationSummary, noveltyScore),
    objectives: {
      survivalRate: roundTo(AI_NUM.N_1 - validationSummary.empireFallRate - validationSummary.guardRate, AI_NUM.N_4),
      winShare: validationSummary.lowerConfidenceWinShare ?? validationSummary.winShare,
      scorePercentile: validationSummary.lowerConfidenceScorePercentile ?? validationSummary.scorePercentile ?? validationSummary.wealthPercentile,
      wealthPercentile: validationSummary.wealthPercentile,
      scriptedWinRate: getClassWinRate(validationSummary, 'scripted'),
      hallOfFameWinRate: getClassWinRate(validationSummary, 'hof'),
      emergentWinRate: getClassWinRate(validationSummary, 'emergent'),
      opponentRobustness: roundTo(AI_NUM.N_1 - Math.min(AI_NUM.N_1, Math.sqrt(validationSummary.opponentVariance)), AI_NUM.N_4),
      seatRobustness: roundTo(AI_NUM.N_1 - Math.min(AI_NUM.N_1, Math.sqrt(validationSummary.seatVariance) * AI_NUM.N_4), AI_NUM.N_4),
      novelty: noveltyScore,
    },
    paretoRank: Number.POSITIVE_INFINITY,
    crowdingDistance: AI_NUM.N_0,
  };
}

function dominates(left, right) {
  let strictlyBetter = false;
  for (const key of OBJECTIVE_KEYS) {
    const leftValue = left.objectives[key] ?? AI_NUM.N_0;
    const rightValue = right.objectives[key] ?? AI_NUM.N_0;
    if (leftValue + AI_NUM.N_0_000000001 < rightValue) return false;
    if (leftValue > rightValue + AI_NUM.N_0_000000001) strictlyBetter = true;
  }
  return strictlyBetter;
}

function assignCrowdingDistance(front) {
  if (!front.length) return;
  for (const entry of front) entry.crowdingDistance = AI_NUM.N_0;
  if (front.length <= AI_NUM.N_2) {
    for (const entry of front) entry.crowdingDistance = Number.POSITIVE_INFINITY;
    return;
  }

  for (const key of OBJECTIVE_KEYS) {
    const sorted = front.slice().sort((left, right) => (left.objectives[key] ?? AI_NUM.N_0) - (right.objectives[key] ?? AI_NUM.N_0));
    const minValue = sorted[AI_NUM.N_0].objectives[key] ?? AI_NUM.N_0;
    const maxValue = sorted[sorted.length - AI_NUM.N_1].objectives[key] ?? AI_NUM.N_0;
    sorted[AI_NUM.N_0].crowdingDistance = Number.POSITIVE_INFINITY;
    sorted[sorted.length - AI_NUM.N_1].crowdingDistance = Number.POSITIVE_INFINITY;
    if (maxValue <= minValue) continue;
    for (let index = AI_NUM.N_1; index < sorted.length - AI_NUM.N_1; index++) {
      if (!Number.isFinite(sorted[index].crowdingDistance)) continue;
      const previous = sorted[index - AI_NUM.N_1].objectives[key] ?? AI_NUM.N_0;
      const next = sorted[index + AI_NUM.N_1].objectives[key] ?? AI_NUM.N_0;
      sorted[index].crowdingDistance += (next - previous) / (maxValue - minValue);
    }
  }
}

function compareSelectionEntries(left, right) {
  return (
    (left.paretoRank - right.paretoRank) ||
    ((right.crowdingDistance || AI_NUM.N_0) - (left.crowdingDistance || AI_NUM.N_0)) ||
    (right.displayScore - left.displayScore) ||
    (right.validationSummary.winShare - left.validationSummary.winShare) ||
    left.candidate.id.localeCompare(right.candidate.id)
  );
}

function sortByPareto(entries) {
  const working = entries.slice();
  const dominationCounts = new Map();
  const dominatesMap = new Map();
  const fronts = [];
  const firstFront = [];

  for (const entry of working) {
    dominationCounts.set(entry, AI_NUM.N_0);
    dominatesMap.set(entry, []);
    for (const rival of working) {
      if (entry === rival) continue;
      if (dominates(entry, rival)) {
        dominatesMap.get(entry).push(rival);
      } else if (dominates(rival, entry)) {
        dominationCounts.set(entry, (dominationCounts.get(entry) || AI_NUM.N_0) + AI_NUM.N_1);
      }
    }
    if ((dominationCounts.get(entry) || AI_NUM.N_0) === AI_NUM.N_0) {
      entry.paretoRank = AI_NUM.N_1;
      firstFront.push(entry);
    }
  }

  fronts.push(firstFront);
  let frontIndex = AI_NUM.N_0;
  while (frontIndex < fronts.length && fronts[frontIndex].length) {
    const nextFront = [];
    for (const entry of fronts[frontIndex]) {
      for (const dominated of dominatesMap.get(entry) || []) {
        const nextCount = (dominationCounts.get(dominated) || AI_NUM.N_0) - AI_NUM.N_1;
        dominationCounts.set(dominated, nextCount);
        if (nextCount === AI_NUM.N_0) {
          dominated.paretoRank = frontIndex + AI_NUM.N_2;
          nextFront.push(dominated);
        }
      }
    }
    if (nextFront.length) fronts.push(nextFront);
    frontIndex++;
  }

  for (const front of fronts) assignCrowdingDistance(front);
  return fronts.flat().sort(compareSelectionEntries);
}

function tournamentSelect(entries, rng) {
  let best = null;
  const sampleSize = Math.min(AI_NUM.N_3, entries.length);
  for (let index = AI_NUM.N_0; index < sampleSize; index++) {
    const entry = entries[Math.floor(rng() * entries.length)];
    if (!best || compareSelectionEntries(entry, best) < AI_NUM.N_0) {
      best = entry;
    }
  }
  return best;
}

function createHallOfFameEntry(entry, generation, index) {
  const clone = cloneCandidate(entry.candidate, generation, `hof${generation}-${index}`);
  return {
    profile: clone.profile,
    generation,
    bucketTag: getGenerationBucketTag(generation),
    behaviorVector: entry.validationSummary.behaviorVector.slice(),
    winShare: entry.validationSummary.winShare,
  };
}

function computeAdaptiveMutationScale(generation, totalGenerations, averageNoveltyScore) {
  const progress = (generation - AI_NUM.N_1) / Math.max(AI_NUM.N_1, totalGenerations - AI_NUM.N_1);
  const noveltyPressure = averageNoveltyScore < AI_NUM.N_0_18 ? AI_NUM.N_1_25 : averageNoveltyScore > AI_NUM.N_0_35 ? AI_NUM.N_0_9 : AI_NUM.N_1;
  return clamp((AI_NUM.N_1_15 - (progress * AI_NUM.N_0_45)) * noveltyPressure, AI_NUM.N_0_65, AI_NUM.N_1_4);
}

function describeBehaviorProfile(summary) {
  const behavior = summary.behaviorProfile;
  const levels = [];
  levels.push(`${behavior.frontierTroopShare >= AI_NUM.N_0_58 ? 'high' : behavior.frontierTroopShare <= AI_NUM.N_0_35 ? 'low' : 'moderate'} frontier defense`);
  levels.push(`${behavior.averageLandBuys >= AI_NUM.N_1_2 ? 'high' : behavior.averageLandBuys <= AI_NUM.N_0_4 ? 'low' : 'moderate'} land buying`);
  levels.push(`${behavior.averageChurchGifts >= AI_NUM.N_0_4 ? 'high' : behavior.averageChurchGifts <= AI_NUM.N_0_1 ? 'low' : 'moderate'} church giving`);
  levels.push(`${behavior.averageRevocations >= AI_NUM.N_0_6 ? 'high' : behavior.averageRevocations <= AI_NUM.N_0_15 ? 'low' : 'moderate'} revocation`);
  levels.push(`${behavior.averageDealsProposed >= AI_NUM.N_0_8 ? 'active' : behavior.averageDealsProposed <= AI_NUM.N_0_15 ? 'rare' : 'selective'} dealmaking`);
  return levels.join(', ');
}

function buildChampionSummary(candidate, holdoutSummary) {
  const topSignals = getPolicySignature(candidate.policy, AI_NUM.N_3)
    .map(label => label.toLowerCase());
  const focus = topSignals.length ? topSignals.join(' and ') : 'balanced policy scoring';
  return `Self-play policy champion focused on ${focus}, with holdout behavior showing ${describeBehaviorProfile(holdoutSummary)}.`;
}

function chunkArray(items, chunkCount) {
  if (chunkCount <= AI_NUM.N_1 || items.length <= AI_NUM.N_1) return [items.slice()];
  const chunks = Array.from({ length: Math.min(chunkCount, items.length) }, () => []);
  items.forEach((item, index) => {
    chunks[index % chunks.length].push(item);
  });
  return chunks.filter(chunk => chunk.length);
}

function getRecommendedParallelWorkerCount(config, candidateCount) {
  if (config.parallelWorkers > AI_NUM.N_0) {
    return Math.max(AI_NUM.N_1, Math.min(config.parallelWorkers, candidateCount));
  }
  if (typeof Worker !== 'function') return AI_NUM.N_1;
  const hardware = Math.max(AI_NUM.N_1, Number(globalThis.navigator?.hardwareConcurrency) || AI_NUM.N_1);
  return Math.max(AI_NUM.N_1, Math.min(candidateCount, Math.max(AI_NUM.N_1, hardware - AI_NUM.N_1), AI_NUM.N_6));
}

function runEvaluationWorkerTask(worker, payload) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (event) => {
      const message = event.data || {};
      cleanup();
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error?.stack || message.error?.message || 'Parallel evaluation worker failed.'));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    worker.addEventListener('message', onMessage, { once: true });
    worker.addEventListener('error', onError, { once: true });
    worker.postMessage(payload);
  });
}

class EvaluationWorkerPool {
  constructor(workerCount) {
    this.workerCount = Math.max(AI_NUM.N_0, workerCount);
    this.workers = [];
    this.nextWorkerIndex = AI_NUM.N_0;
  }

  ensureWorkers() {
    if (this.workerCount <= AI_NUM.N_1 || this.workers.length) return;
    for (let index = AI_NUM.N_0; index < this.workerCount; index++) {
      this.workers.push(new Worker(new URL('./evaluation.worker.js', import.meta.url), { type: 'module' }));
    }
  }

  async runPayloads(payloads) {
    if (!payloads.length) return [];
    this.ensureWorkers();
    if (!this.workers.length) throw new Error('No reusable evaluation workers are available.');

    const results = Array.from({ length: payloads.length });
    let cursor = AI_NUM.N_0;
    const activeWorkers = this.workers.slice(AI_NUM.N_0, Math.min(this.workers.length, payloads.length));
    const runNext = async (worker) => {
      while (cursor < payloads.length) {
        const taskIndex = cursor;
        cursor++;
        results[taskIndex] = await runEvaluationWorkerTask(worker, payloads[taskIndex]);
      }
    };

    await Promise.all(activeWorkers.map(worker => runNext(worker)));
    return results.flat();
  }

  async close() {
    const workers = this.workers.splice(AI_NUM.N_0);
    await Promise.all(workers.map(worker => Promise.resolve(worker.terminate()).catch(() => null)));
  }
}

async function runParallelEvaluationPayloads(payloads, workerPool = null) {
  if (workerPool) return workerPool.runPayloads(payloads);
  const transientPool = new EvaluationWorkerPool(payloads.length);
  try {
    return await transientPool.runPayloads(payloads);
  } finally {
    await transientPool.close();
  }
}

async function evaluateGenerationPopulation({
  population,
  trainingSuite,
  validationSuite,
  config,
  generation,
  hallOfFame,
  workerCount,
  workerPool = null,
  onWorkerFallback = null,
  onEntry = null,
}) {
  const candidateById = new Map(population.map(candidate => [candidate.id, candidate]));
  const candidateOrder = new Map(population.map((candidate, index) => [candidate.id, index]));
  const evaluationEntries = [];
  const sortEntriesByCandidateOrder = () => evaluationEntries.sort((left, right) => (
    (candidateOrder.get(left.candidate.id) ?? AI_NUM.N_0) - (candidateOrder.get(right.candidate.id) ?? AI_NUM.N_0)
  ));

  const consumeChunk = (chunkResults) => {
    for (const result of chunkResults) {
      const candidate = candidateById.get(result.candidateId);
      if (!candidate) continue;
      const entry = {
        candidate,
        trainSummary: result.trainSummary,
        validationSummary: result.validationSummary,
      };
      evaluationEntries.push(entry);
      onEntry?.(entry);
    }
  };

  if (workerCount > AI_NUM.N_1) {
    try {
      const payloads = chunkArray(population, workerCount).map(candidates => ({
        mode: 'generation',
        candidates,
        trainingSuite,
        validationSuite,
        population,
        hallOfFame,
        config,
        generation,
        fitnessWeights: config.fitness,
      }));
      const chunkResults = await runParallelEvaluationPayloads(payloads, workerPool);
      consumeChunk(chunkResults);
      return sortEntriesByCandidateOrder();
    } catch {
      onWorkerFallback?.();
      // Fall through to deterministic sequential evaluation if nested workers
      // are unavailable in the current runtime.
    }
  }

  for (const candidate of population) {
    const entry = {
      candidate,
      trainSummary: evaluateCandidateOnSuite(candidate, trainingSuite, {
        config,
        generation,
        scope: 'training',
        population,
        hallOfFame,
      }, config.fitness),
      validationSummary: evaluateCandidateOnSuite(candidate, validationSuite, {
        config,
        generation,
        scope: 'validation',
        population,
        hallOfFame,
      }, config.fitness),
    };
    evaluationEntries.push(entry);
    onEntry?.(entry);
  }

  return sortEntriesByCandidateOrder();
}

function buildEvaluatedFinalistEntry(finalist, holdoutSummary, hallOfFameVectors, finalistVectors) {
  return {
    ...finalist,
    holdoutSummary,
    displayScore: computeDisplayScore(holdoutSummary, finalist.noveltyScore),
    objectives: {
      survivalRate: roundTo(AI_NUM.N_1 - holdoutSummary.empireFallRate - holdoutSummary.guardRate, AI_NUM.N_4),
      winShare: holdoutSummary.lowerConfidenceWinShare ?? holdoutSummary.winShare,
      scorePercentile: holdoutSummary.lowerConfidenceScorePercentile ?? holdoutSummary.scorePercentile ?? holdoutSummary.wealthPercentile,
      wealthPercentile: holdoutSummary.wealthPercentile,
      scriptedWinRate: getClassWinRate(holdoutSummary, 'scripted'),
      hallOfFameWinRate: getClassWinRate(holdoutSummary, 'hof'),
      emergentWinRate: getClassWinRate(holdoutSummary, 'emergent'),
      opponentRobustness: roundTo(AI_NUM.N_1 - Math.min(AI_NUM.N_1, Math.sqrt(holdoutSummary.opponentVariance)), AI_NUM.N_4),
      seatRobustness: roundTo(AI_NUM.N_1 - Math.min(AI_NUM.N_1, Math.sqrt(holdoutSummary.seatVariance) * AI_NUM.N_4), AI_NUM.N_4),
      novelty: computeNoveltyScore(holdoutSummary.behaviorVector, hallOfFameVectors, finalistVectors),
    },
  };
}

async function evaluateHoldoutPopulation({
  finalists,
  holdoutSuite,
  config,
  generation,
  population,
  hallOfFame,
  workerCount,
  workerPool = null,
  mode = 'holdout',
  onWorkerFallback = null,
  onEntry = null,
}) {
  const candidateById = new Map(finalists.map(entry => [entry.candidate.id, entry]));
  const finalistOrder = new Map(finalists.map((entry, index) => [entry.candidate.id, index]));
  const holdoutEntries = [];
  const sortEntriesByFinalistOrder = () => holdoutEntries.sort((left, right) => (
    (finalistOrder.get(left.candidate.id) ?? AI_NUM.N_0) - (finalistOrder.get(right.candidate.id) ?? AI_NUM.N_0)
  ));
  const hallOfFameVectors = hallOfFame.map(item => item.behaviorVector);
  const finalistVectors = finalists.map(item => item.trainSummary.behaviorVector);

  const consumeChunk = (chunkResults) => {
    for (const result of chunkResults) {
      const finalist = candidateById.get(result.candidateId);
      if (!finalist) continue;
      const holdoutSummary = result.holdoutSummary;
      const entry = buildEvaluatedFinalistEntry(finalist, holdoutSummary, hallOfFameVectors, finalistVectors);
      holdoutEntries.push(entry);
      onEntry?.(entry);
    }
  };

  if (workerCount > AI_NUM.N_1) {
    try {
      const payloads = chunkArray(finalists.map(entry => entry.candidate), workerCount).map(candidates => ({
        mode,
        candidates,
        holdoutSuite,
        auditSuite: mode === 'audit' ? holdoutSuite : undefined,
        population,
        hallOfFame,
        config,
        generation,
        fitnessWeights: config.fitness,
      }));
      const chunkResults = await runParallelEvaluationPayloads(payloads, workerPool);
      consumeChunk(chunkResults);
      return sortEntriesByFinalistOrder();
    } catch {
      onWorkerFallback?.();
      // Fall through to sequential evaluation.
    }
  }

  for (const finalist of finalists) {
    const holdoutSummary = evaluateCandidateOnSuite(finalist.candidate, holdoutSuite, {
      config,
      generation,
      scope: mode,
      population,
      hallOfFame,
    }, config.fitness);
    const entry = buildEvaluatedFinalistEntry(finalist, holdoutSummary, hallOfFameVectors, finalistVectors);
    holdoutEntries.push(entry);
    onEntry?.(entry);
  }

  return sortEntriesByFinalistOrder();
}

function materializeChampion(entry, rank, config, noveltyPercentile) {
  const holdoutSummary = entry.holdoutSummary || entry.validationSummary;
  const name = buildChampionName(entry.candidate, rank);
  return normalizeAiProfile({
    id: `${entry.candidate.id}-champion-${rank}`,
    name,
    shortName: name,
    theory: 'Self-play champion',
    summary: buildChampionSummary(entry.candidate, holdoutSummary),
    source: 'emergent-trained',
    basePersonalityId: null,
    policy: entry.candidate.policy,
    training: {
      generation: entry.generation,
      matches: holdoutSummary.matches,
      wins: holdoutSummary.wins,
      winShare: holdoutSummary.winShare,
      championScore: computeDisplayScore(holdoutSummary, entry.noveltyScore),
      averageFitness: holdoutSummary.averageFitness,
      averageScore: holdoutSummary.averageScore,
      averageWealth: holdoutSummary.averageWealth,
      empireFallRate: holdoutSummary.empireFallRate,
      fitnessVariance: holdoutSummary.fitnessVariance,
      perOpponentTypeWinRate: holdoutSummary.perOpponentTypeWinRate,
      perSeatWinRate: holdoutSummary.perSeatWinRate,
      fitnessPresetId: config.fitnessPresetId,
      playerCount: config.playerCount,
      playerCounts: config.playerCounts,
      deckSize: config.deckSize,
      deckSizes: config.deckSizes,
      populationPresetId: 'emergent-self-play',
      seed: config.seed,
      trainedAt: new Date().toISOString(),
      trainMatches: entry.trainSummary.matches,
      validationMatches: entry.validationSummary.matches,
      holdoutMatches: holdoutSummary.matches,
      trainWinShare: entry.trainSummary.winShare,
      validationWinShare: entry.validationSummary.winShare,
      holdoutWinShare: holdoutSummary.winShare,
      trainEmpireFallRate: entry.trainSummary.empireFallRate,
      validationEmpireFallRate: entry.validationSummary.empireFallRate,
      holdoutEmpireFallRate: holdoutSummary.empireFallRate,
      trainWealthPercentile: entry.trainSummary.wealthPercentile,
      validationWealthPercentile: entry.validationSummary.wealthPercentile,
      holdoutWealthPercentile: holdoutSummary.wealthPercentile,
      trainScorePercentile: entry.trainSummary.scorePercentile,
      validationScorePercentile: entry.validationSummary.scorePercentile,
      holdoutScorePercentile: holdoutSummary.scorePercentile,
      guardRate: holdoutSummary.guardRate,
      paretoFront: entry.paretoRank,
      crowdingDistance: roundTo(entry.crowdingDistance, AI_NUM.N_4),
      noveltyScore: entry.noveltyScore,
      noveltyPercentile,
      seatBias: holdoutSummary.startingBasileusSeatBias,
      bestMatchup: holdoutSummary.bestMatchup?.tag || '',
      worstMatchup: holdoutSummary.worstMatchup?.tag || '',
      averageProjectionError: holdoutSummary.behaviorProfile?.averageProjectionError || AI_NUM.N_0,
      averageDecisionQuality: holdoutSummary.behaviorProfile?.averageDecisionQuality || AI_NUM.N_0,
      behaviorProfile: holdoutSummary.behaviorProfile,
      mainBehavior: describeBehaviorProfile(holdoutSummary),
    },
  });
}

function buildFinalAuditEntry(entry, rank, auditSummary) {
  return {
    rank,
    candidateId: entry.candidate.id,
    name: entry.candidate.name,
    matches: auditSummary.matches,
    winShare: auditSummary.winShare,
    scorePercentile: auditSummary.scorePercentile ?? auditSummary.wealthPercentile,
    empireFallRate: auditSummary.empireFallRate,
    guardRate: auditSummary.guardRate,
    robustness: {
      scenario: roundTo(AI_NUM.N_1 - Math.min(AI_NUM.N_1, Math.sqrt(auditSummary.scenarioVariance || AI_NUM.N_0)), AI_NUM.N_4),
      seat: roundTo(AI_NUM.N_1 - Math.min(AI_NUM.N_1, Math.sqrt(auditSummary.seatVariance || AI_NUM.N_0) * AI_NUM.N_4), AI_NUM.N_4),
      opponent: roundTo(AI_NUM.N_1 - Math.min(AI_NUM.N_1, Math.sqrt(auditSummary.opponentVariance || AI_NUM.N_0)), AI_NUM.N_4),
    },
    perScenarioWinRate: auditSummary.perScenarioWinRate,
    perSeatWinRate: auditSummary.perSeatWinRate,
    perOpponentTypeWinRate: auditSummary.perOpponentTypeWinRate,
    bestMatchup: auditSummary.bestMatchup,
    worstMatchup: auditSummary.worstMatchup,
  };
}

export function normalizeTrainingConfig(rawConfig = {}) {
  const playerCounts = sanitizePlayerCounts(rawConfig.playerCounts ?? (
    rawConfig.playerCount == null ? DEFAULT_TRAINING_CONFIG.playerCounts : [rawConfig.playerCount]
  ));
  const deckSizes = sanitizeDeckSizes(rawConfig.deckSizes ?? (
    rawConfig.deckSize == null ? DEFAULT_TRAINING_CONFIG.deckSizes : [rawConfig.deckSize]
  ));
  const playerCount = playerCounts[AI_NUM.N_0] ?? sanitizePlayerCount(rawConfig.playerCount);
  const deckSize = deckSizes[AI_NUM.N_0] ?? DEFAULT_TRAINING_CONFIG.deckSize;
  const fitnessPresetId = rawConfig.fitnessPresetId === 'custom'
    ? 'custom'
    : resolveFitnessPresetId(rawConfig.fitnessPresetId);
  const fitness = normalizeFitnessWeights(rawConfig.fitness, rawConfig.fitnessPresetId);

  return {
    seed: normalizeSeed(rawConfig.seed),
    playerCount,
    playerCounts,
    deckSize,
    deckSizes,
    fitnessPresetId,
    fitness,
    populationSize: Math.max(Math.max(...playerCounts), toInt(rawConfig.populationSize, DEFAULT_TRAINING_CONFIG.populationSize)),
    generations: Math.max(AI_NUM.N_1, toInt(rawConfig.generations, DEFAULT_TRAINING_CONFIG.generations)),
    matchesPerCandidate: Math.max(AI_NUM.N_1, toInt(rawConfig.matchesPerCandidate, DEFAULT_TRAINING_CONFIG.matchesPerCandidate)),
    validationMatchesPerCandidate: Math.max(AI_NUM.N_1, toInt(rawConfig.validationMatchesPerCandidate, DEFAULT_TRAINING_CONFIG.validationMatchesPerCandidate)),
    holdoutMatchesPerChampion: Math.max(AI_NUM.N_1, toInt(rawConfig.holdoutMatchesPerChampion, DEFAULT_TRAINING_CONFIG.holdoutMatchesPerChampion)),
    finalAuditMatchesPerChampion: Math.max(AI_NUM.N_0, toInt(rawConfig.finalAuditMatchesPerChampion, DEFAULT_TRAINING_CONFIG.finalAuditMatchesPerChampion)),
    champions: Math.max(AI_NUM.N_1, toInt(rawConfig.champions, DEFAULT_TRAINING_CONFIG.champions)),
    hallOfFameSize: Math.max(AI_NUM.N_0, toInt(rawConfig.hallOfFameSize, DEFAULT_TRAINING_CONFIG.hallOfFameSize)),
    eliteFraction: clamp(toNumber(rawConfig.eliteFraction, DEFAULT_TRAINING_CONFIG.eliteFraction), AI_NUM.N_0_1, AI_NUM.N_0_4),
    freshBloodRate: clamp(toNumber(rawConfig.freshBloodRate, DEFAULT_TRAINING_CONFIG.freshBloodRate), AI_NUM.N_0_05, AI_NUM.N_0_25),
    hallOfFameMixFraction: clamp(toNumber(rawConfig.hallOfFameMixFraction, DEFAULT_TRAINING_CONFIG.hallOfFameMixFraction), AI_NUM.N_0, AI_NUM.N_1),
    parallelWorkers: Math.max(AI_NUM.N_0, toInt(rawConfig.parallelWorkers, DEFAULT_TRAINING_CONFIG.parallelWorkers)),
  };
}

function getHoldoutFinalistCount(config) {
  return Math.min(config.populationSize, Math.max(config.champions * AI_NUM.N_3, AI_NUM.N_8));
}

function getFinalAuditChampionCount(config) {
  return Math.min(config.champions, getHoldoutFinalistCount(config));
}

export function estimateTrainingMatches(rawConfig = {}) {
  const config = normalizeTrainingConfig(rawConfig);
  return (
    config.generations * config.populationSize * (config.matchesPerCandidate + config.validationMatchesPerCandidate) +
    (getHoldoutFinalistCount(config) * config.holdoutMatchesPerChampion) +
    (getFinalAuditChampionCount(config) * config.finalAuditMatchesPerChampion)
  );
}

function createPerformanceTracker() {
  return {
    phases: {
      training: AI_NUM.N_0,
      validation: AI_NUM.N_0,
      holdout: AI_NUM.N_0,
      audit: AI_NUM.N_0,
    },
    workerFallbacks: AI_NUM.N_0,
  };
}

function recordSplitPhaseDuration(performance, durationMs, split) {
  const totalWeight = Object.values(split).reduce((total, value) => total + value, AI_NUM.N_0);
  if (totalWeight <= AI_NUM.N_0) return;
  for (const [phase, weight] of Object.entries(split)) {
    performance.phases[phase] = (performance.phases[phase] || AI_NUM.N_0) + (durationMs * (weight / totalWeight));
  }
}

function buildProgressPayload(config, startedAt, completedMatches, totalMatches, extra = {}) {
  const {
    phaseStartedAt = startedAt,
    phaseCompletedMatches = completedMatches,
    workerCount = AI_NUM.N_1,
    activeWorkerCount = workerCount,
    ...rest
  } = extra;
  const elapsedMs = Math.max(AI_NUM.N_1, Date.now() - startedAt);
  const phaseElapsedMs = Math.max(AI_NUM.N_1, Date.now() - phaseStartedAt);
  const matchesPerSecond = completedMatches / (elapsedMs / AI_NUM.N_1000);
  const phaseMatchesPerSecond = phaseCompletedMatches / (phaseElapsedMs / AI_NUM.N_1000);
  const remaining = Math.max(AI_NUM.N_0, totalMatches - completedMatches);
  return {
    ...rest,
    completed: completedMatches,
    total: totalMatches,
    matchesPerSecond: roundTo(matchesPerSecond, AI_NUM.N_2),
    phaseMatchesPerSecond: roundTo(phaseMatchesPerSecond, AI_NUM.N_2),
    workerUtilization: roundTo(clamp(activeWorkerCount / Math.max(AI_NUM.N_1, workerCount), AI_NUM.N_0, AI_NUM.N_1), AI_NUM.N_4),
    etaMs: matchesPerSecond > AI_NUM.N_0 ? Math.round((remaining / matchesPerSecond) * AI_NUM.N_1000) : null,
    matchSplit: {
      training: config.generations * config.populationSize * config.matchesPerCandidate,
      validation: config.generations * config.populationSize * config.validationMatchesPerCandidate,
      holdout: getHoldoutFinalistCount(config) * config.holdoutMatchesPerChampion,
      audit: getFinalAuditChampionCount(config) * config.finalAuditMatchesPerChampion,
    },
  };
}

function buildPerformanceOverview(config, performance, workerCount) {
  const split = {
    training: config.generations * config.populationSize * config.matchesPerCandidate,
    validation: config.generations * config.populationSize * config.validationMatchesPerCandidate,
    holdout: getHoldoutFinalistCount(config) * config.holdoutMatchesPerChampion,
    audit: getFinalAuditChampionCount(config) * config.finalAuditMatchesPerChampion,
  };
  const phaseMs = Object.fromEntries(Object.entries(performance.phases).map(([phase, ms]) => [phase, Math.round(ms)]));
  const phaseMatchesPerSecond = Object.fromEntries(Object.entries(split).map(([phase, matches]) => [
    phase,
    phaseMs[phase] > AI_NUM.N_0 ? roundTo(matches / (phaseMs[phase] / AI_NUM.N_1000), AI_NUM.N_2) : AI_NUM.N_0,
  ]));
  return {
    workerCount,
    workerFallbacks: performance.workerFallbacks,
    phaseMs,
    phaseMatchesPerSecond,
  };
}

export async function runEvolutionTraining(rawConfig = {}, onProgress = null) {
  const startedAt = Date.now();
  const config = normalizeTrainingConfig(rawConfig);
  const rng = createRng(config.seed);
  const generationWorkerCount = getRecommendedParallelWorkerCount(config, config.populationSize);
  const performance = createPerformanceTracker();
  const evaluationWorkerPool = generationWorkerCount > AI_NUM.N_1 ? new EvaluationWorkerPool(generationWorkerCount) : null;
  let population = buildInitialPopulation(config, rng);
  const validationSuite = buildEvaluationSuite(config, 'validation', AI_NUM.N_0, config.validationMatchesPerCandidate, 'late');
  const holdoutSuite = buildEvaluationSuite(config, 'holdout', AI_NUM.N_0, config.holdoutMatchesPerChampion, 'late');
  const totalMatches = estimateTrainingMatches(config);
  let completedMatches = AI_NUM.N_0;
  const generationHistory = [];
  const hallOfFame = [];
  let finalRankedEntries = [];

  try {
  for (let generation = AI_NUM.N_1; generation <= config.generations; generation++) {
    const stage = trainingStage(generation, config.generations);
    const trainingSuite = buildEvaluationSuite(config, 'training', generation, config.matchesPerCandidate, stage);
    const archiveVectors = hallOfFame.map(entry => entry.behaviorVector);
    let evaluatedCandidateCount = AI_NUM.N_0;
    let phaseCompletedMatches = AI_NUM.N_0;
    let partialLeader = null;
    const phaseStartedAt = Date.now();
    const activeWorkerCount = Math.min(generationWorkerCount, Math.max(AI_NUM.N_1, population.length));
    const evaluationEntries = await evaluateGenerationPopulation({
      population,
      trainingSuite,
      validationSuite,
      config,
      generation,
      hallOfFame,
      workerCount: generationWorkerCount,
      workerPool: evaluationWorkerPool,
      onWorkerFallback: () => {
        performance.workerFallbacks++;
      },
      onEntry: (entry) => {
        evaluatedCandidateCount++;
        const entryMatches = entry.trainSummary.matches + entry.validationSummary.matches;
        completedMatches += entryMatches;
        phaseCompletedMatches += entryMatches;
        const entryDisplayScore = computeDisplayScore(entry.validationSummary, AI_NUM.N_0);
        if (!partialLeader || entryDisplayScore > partialLeader.displayScore) {
          partialLeader = { entry, displayScore: entryDisplayScore };
        }

        onProgress?.(buildProgressPayload(config, startedAt, completedMatches, totalMatches, {
          mode: 'training',
          generation,
          generations: config.generations,
          matchesThisGeneration: population.length,
          currentMatch: evaluatedCandidateCount,
          leaderName: partialLeader?.entry?.candidate?.name || 'Evaluating',
          leaderFitness: partialLeader?.displayScore || AI_NUM.N_0,
          stage,
          phaseStartedAt,
          phaseCompletedMatches,
          workerCount: generationWorkerCount,
          activeWorkerCount,
          hallOfFameSize: hallOfFame.length,
        }));
      },
    });
    recordSplitPhaseDuration(performance, Date.now() - phaseStartedAt, {
      training: config.matchesPerCandidate,
      validation: config.validationMatchesPerCandidate,
    });

    const peerVectors = evaluationEntries.map(entry => entry.trainSummary.behaviorVector);
    const selectionEntries = evaluationEntries.map(entry => buildSelectionEntry(
      entry.candidate,
      generation,
      entry.trainSummary,
      entry.validationSummary,
      computeNoveltyScore(entry.trainSummary.behaviorVector, archiveVectors, peerVectors)
    ));
    const rankedEntries = sortByPareto(selectionEntries);
    finalRankedEntries = rankedEntries;

    generationHistory.push({
      generation,
      stage,
      leaderName: rankedEntries[AI_NUM.N_0]?.candidate?.name || 'Unknown',
      leaderParetoFront: rankedEntries[AI_NUM.N_0]?.paretoRank || AI_NUM.N_0,
      leaderCrowdingDistance: roundTo(rankedEntries[AI_NUM.N_0]?.crowdingDistance || AI_NUM.N_0, AI_NUM.N_4),
      trainWinShare: rankedEntries[AI_NUM.N_0]?.trainSummary?.winShare || AI_NUM.N_0,
      validationWinShare: rankedEntries[AI_NUM.N_0]?.validationSummary?.winShare || AI_NUM.N_0,
      validationEmpireFallRate: rankedEntries[AI_NUM.N_0]?.validationSummary?.empireFallRate || AI_NUM.N_0,
      validationGuardRate: rankedEntries[AI_NUM.N_0]?.validationSummary?.guardRate || AI_NUM.N_0,
      validationScorePercentile: rankedEntries[AI_NUM.N_0]?.validationSummary?.scorePercentile || AI_NUM.N_0,
      validationWealthPercentile: rankedEntries[AI_NUM.N_0]?.validationSummary?.wealthPercentile || AI_NUM.N_0,
      leaderNovelty: rankedEntries[AI_NUM.N_0]?.noveltyScore || AI_NUM.N_0,
      averageValidationWinShare: roundTo(average(rankedEntries.map(entry => entry.validationSummary.winShare)), AI_NUM.N_4),
      averageValidationFallRate: roundTo(average(rankedEntries.map(entry => entry.validationSummary.empireFallRate)), AI_NUM.N_4),
      hallOfFameSize: hallOfFame.length,
    });

    const hofAdditions = rankedEntries.slice(AI_NUM.N_0, Math.min(AI_NUM.N_2, rankedEntries.length));
    hofAdditions.forEach((entry, index) => hallOfFame.push(createHallOfFameEntry(entry, generation, index)));
    hallOfFame.sort((left, right) => right.winShare - left.winShare);
    while (hallOfFame.length > config.hallOfFameSize) hallOfFame.pop();

    if (generation === config.generations) break;

    const eliteCount = Math.max(AI_NUM.N_2, Math.ceil(config.populationSize * config.eliteFraction));
    const freshCount = Math.max(AI_NUM.N_1, Math.round(config.populationSize * config.freshBloodRate));
    const mutationScale = computeAdaptiveMutationScale(generation, config.generations, average(rankedEntries.map(entry => entry.noveltyScore)));
    const nextPopulation = rankedEntries
      .slice(AI_NUM.N_0, eliteCount)
      .map((entry, index) => cloneCandidate(entry.candidate, generation + AI_NUM.N_1, `elite${index}`));

    for (let index = AI_NUM.N_0; index < freshCount && nextPopulation.length < config.populationSize; index++) {
      nextPopulation.push(createNeutralCandidate(rng, (generation * AI_NUM.N_1000) + index));
    }

    while (nextPopulation.length < config.populationSize) {
      const parentA = tournamentSelect(rankedEntries, rng)?.candidate || rankedEntries[AI_NUM.N_0].candidate;
      const parentB = tournamentSelect(rankedEntries, rng)?.candidate || rankedEntries[AI_NUM.N_0].candidate;
      const child = rng() < AI_NUM.N_0_6
        ? crossoverCandidates(parentA, parentB, rng, generation + AI_NUM.N_1, nextPopulation.length, mutationScale)
        : mutateCandidate(parentA, rng, generation + AI_NUM.N_1, nextPopulation.length, mutationScale);
      nextPopulation.push(child);
    }

    population = shuffle(nextPopulation, rng);
  }

  const finalistCount = getHoldoutFinalistCount(config);
  const finalists = finalRankedEntries.slice(AI_NUM.N_0, finalistCount);
  const holdoutWorkerCount = getRecommendedParallelWorkerCount(config, finalists.length);
  let holdoutEvaluated = AI_NUM.N_0;
  let holdoutPhaseCompletedMatches = AI_NUM.N_0;
  let partialHoldoutLeader = null;
  const holdoutPhaseStartedAt = Date.now();
  const activeHoldoutWorkers = Math.min(holdoutWorkerCount, Math.max(AI_NUM.N_1, finalists.length));
  const holdoutEntries = await evaluateHoldoutPopulation({
    finalists,
    holdoutSuite,
    config,
    generation: config.generations,
    population,
    hallOfFame,
    workerCount: holdoutWorkerCount,
    workerPool: evaluationWorkerPool,
    onWorkerFallback: () => {
      performance.workerFallbacks++;
    },
    onEntry: (entry) => {
      holdoutEvaluated++;
      completedMatches += entry.holdoutSummary.matches;
      holdoutPhaseCompletedMatches += entry.holdoutSummary.matches;
      if (!partialHoldoutLeader || entry.displayScore > partialHoldoutLeader.displayScore) {
        partialHoldoutLeader = entry;
      }
      onProgress?.(buildProgressPayload(config, startedAt, completedMatches, totalMatches, {
        mode: 'training',
        generation: config.generations,
        generations: config.generations,
        matchesThisGeneration: finalists.length,
        currentMatch: holdoutEvaluated,
        leaderName: partialHoldoutLeader?.candidate?.name || 'Holdout',
        leaderFitness: partialHoldoutLeader?.displayScore || AI_NUM.N_0,
        stage: 'holdout',
        phaseStartedAt: holdoutPhaseStartedAt,
        phaseCompletedMatches: holdoutPhaseCompletedMatches,
        workerCount: holdoutWorkerCount,
        activeWorkerCount: activeHoldoutWorkers,
        hallOfFameSize: hallOfFame.length,
      }));
    },
  });
  performance.phases.holdout += Date.now() - holdoutPhaseStartedAt;

  const finalChampions = sortByPareto(holdoutEntries);
  const noveltyScores = finalChampions.map(entry => entry.noveltyScore).slice().sort((left, right) => left - right);
  const champions = finalChampions.slice(AI_NUM.N_0, config.champions).map((entry, index) => {
    const lowerCount = noveltyScores.filter(score => score <= entry.noveltyScore).length;
    const noveltyPercentile = roundTo(lowerCount / Math.max(AI_NUM.N_1, noveltyScores.length), AI_NUM.N_4);
    return materializeChampion(entry, index + AI_NUM.N_1, config, noveltyPercentile);
  });
  const finalAuditSuite = buildEvaluationSuite(config, 'audit', config.generations + AI_NUM.N_1, config.finalAuditMatchesPerChampion, 'late');
  const finalAuditChampionCount = Math.min(config.champions, finalChampions.length);
  const auditFinalists = finalChampions.slice(AI_NUM.N_0, config.champions);
  const auditRankByCandidateId = new Map(auditFinalists.map((entry, index) => [entry.candidate.id, index]));
  let finalAudit = [];
  if (finalAuditSuite.length) {
    let auditEvaluated = AI_NUM.N_0;
    let auditPhaseCompletedMatches = AI_NUM.N_0;
    const auditWorkerCount = getRecommendedParallelWorkerCount(config, auditFinalists.length);
    const activeAuditWorkers = Math.min(auditWorkerCount, Math.max(AI_NUM.N_1, auditFinalists.length));
    const auditPhaseStartedAt = Date.now();
    const auditEntries = await evaluateHoldoutPopulation({
      finalists: auditFinalists,
      holdoutSuite: finalAuditSuite,
      config,
      generation: config.generations + AI_NUM.N_1,
      population,
      hallOfFame,
      workerCount: auditWorkerCount,
      workerPool: evaluationWorkerPool,
      mode: 'audit',
      onWorkerFallback: () => {
        performance.workerFallbacks++;
      },
      onEntry: (entry) => {
        auditEvaluated++;
        completedMatches += entry.holdoutSummary.matches;
        auditPhaseCompletedMatches += entry.holdoutSummary.matches;
        onProgress?.(buildProgressPayload(config, startedAt, completedMatches, totalMatches, {
          mode: 'training',
          generation: config.generations,
          generations: config.generations,
          matchesThisGeneration: finalAuditChampionCount,
          currentMatch: auditEvaluated,
          leaderName: entry.candidate.name,
          leaderFitness: entry.holdoutSummary?.winShare || AI_NUM.N_0,
          stage: 'audit',
          phaseStartedAt: auditPhaseStartedAt,
          phaseCompletedMatches: auditPhaseCompletedMatches,
          workerCount: auditWorkerCount,
          activeWorkerCount: activeAuditWorkers,
          hallOfFameSize: hallOfFame.length,
        }));
      },
    });
    performance.phases.audit += Date.now() - auditPhaseStartedAt;
    finalAudit = auditEntries
      .sort((left, right) => (auditRankByCandidateId.get(left.candidate.id) ?? AI_NUM.N_0) - (auditRankByCandidateId.get(right.candidate.id) ?? AI_NUM.N_0))
      .map((entry, index) => buildFinalAuditEntry(entry, index + AI_NUM.N_1, entry.holdoutSummary));
  }

  return {
    generatedAt: new Date().toISOString(),
    runtimeMs: Date.now() - startedAt,
    config,
    overview: {
      generations: config.generations,
      populationSize: config.populationSize,
      totalMatches: completedMatches,
      trainingMatchesPerCandidate: config.matchesPerCandidate,
      validationMatchesPerCandidate: config.validationMatchesPerCandidate,
      holdoutMatchesPerChampion: config.holdoutMatchesPerChampion,
      finalAuditMatchesPerChampion: config.finalAuditMatchesPerChampion,
      playerCounts: config.playerCounts,
      deckSizes: config.deckSizes,
      parallelWorkers: Math.max(generationWorkerCount, holdoutWorkerCount),
      performance: buildPerformanceOverview(config, performance, Math.max(generationWorkerCount, holdoutWorkerCount)),
      selectionMethod: 'pareto-crowding',
      bestFitness: finalChampions[AI_NUM.N_0]?.displayScore || AI_NUM.N_0,
      bestAverageScore: finalChampions[AI_NUM.N_0]?.holdoutSummary?.averageScore || AI_NUM.N_0,
      bestAverageWealth: finalChampions[AI_NUM.N_0]?.holdoutSummary?.averageWealth || AI_NUM.N_0,
      bestEmpireFallRate: finalChampions[AI_NUM.N_0]?.holdoutSummary?.empireFallRate || AI_NUM.N_0,
      bestRobustnessVariance: finalChampions[AI_NUM.N_0]?.holdoutSummary?.opponentVariance || AI_NUM.N_0,
      bestHoldoutWinShare: finalChampions[AI_NUM.N_0]?.holdoutSummary?.winShare || AI_NUM.N_0,
      bestAuditWinShare: finalAudit[AI_NUM.N_0]?.winShare || AI_NUM.N_0,
      bestGuardRate: finalChampions[AI_NUM.N_0]?.holdoutSummary?.guardRate || AI_NUM.N_0,
    },
    generationHistory,
    champions,
    finalAudit,
    hallOfFame: hallOfFame.map(entry => entry.profile),
  };
  } finally {
    await evaluationWorkerPool?.close();
  }
}
