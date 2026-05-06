import {
  DEFAULT_MIXED_DECK_SIZES,
  DEFAULT_META_PARAMS,
  META_PARAM_DEFS,
  NEUTRAL_PROFILE,
  PROFILE_TACTIC_KEYS,
  PROFILE_WEIGHT_KEYS,
  SUPPORTED_PLAYER_COUNTS,
} from '../ai/personalities.js';
import { normalizeAiProfile } from '../ai/profileStore.js';
import { runSingleSimulationGame } from './engine.js';

const WEIGHT_MIN = 0.15;
const WEIGHT_MAX = 4.5;
const TACTIC_MIN = 0.55;
const TACTIC_MAX = 2.4;
const OBJECTIVE_KEYS = [
  'winShare',
  'finalScorePlacement',
  'finalScoreAdvantage',
  'survivingFinalScoreMean',
  'scriptedWinRate',
  'hallOfFameWinRate',
  'emergentWinRate',
  'opponentRobustness',
  'seatRobustness',
];

export const DEFAULT_TRAINING_CONFIG = {
  seed: 20260429,
  scenarioMode: 'generalist',
  playerCount: 4,
  deckSize: 6,
  playerCounts: SUPPORTED_PLAYER_COUNTS.slice(),
  deckSizes: DEFAULT_MIXED_DECK_SIZES.slice(),
  fitnessPresetId: 'balanced',
  populationSize: 32,
  generations: 30,
  matchesPerCandidate: 24,
  validationMatchesPerCandidate: 8,
  holdoutMatchesPerChampion: 128,
  champions: 4,
  hallOfFameSize: 32,
  eliteFraction: 0.2,
  freshBloodRate: 0.12,
  parallelWorkers: 0,
};

export const DEFAULT_FITNESS_WEIGHTS = {
  collapsePenalty: 12.0,
  survivalBonus: 1.0,
  winReward: 14.0,
  placementReward: 4.0,
  scoreAdvantageReward: 2.0,
};

export const FITNESS_PROFILES = {
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    summary: 'Outcome-only fitness: survival, placement, wealth, and outright wins.',
    weights: { ...DEFAULT_FITNESS_WEIGHTS },
  },
  aggressive: {
    id: 'aggressive',
    name: 'Aggressive',
    summary: 'Rewards winning more heavily, accepting more collapse risk.',
    weights: {
      ...DEFAULT_FITNESS_WEIGHTS,
      collapsePenalty: 8.0,
      survivalBonus: 0.6,
      winReward: 18.0,
      placementReward: 5.0,
      scoreAdvantageReward: 3.0,
    },
  },
  cooperative: {
    id: 'cooperative',
    name: 'Cooperative',
    summary: 'Rewards keeping the empire alive more heavily than high-variance wins.',
    weights: {
      ...DEFAULT_FITNESS_WEIGHTS,
      collapsePenalty: 16.0,
      survivalBonus: 1.6,
      winReward: 10.0,
      placementReward: 3.0,
      scoreAdvantageReward: 1.4,
    },
  },
  prudent: {
    id: 'prudent',
    name: 'Prudent',
    summary: 'Treats imperial collapse as a major failure and prefers very robust play.',
    weights: {
      ...DEFAULT_FITNESS_WEIGHTS,
      collapsePenalty: 20.0,
      survivalBonus: 2.0,
      winReward: 8.0,
      placementReward: 2.4,
      scoreAdvantageReward: 1.0,
    },
  },
};

export const FITNESS_TUNING_FIELDS = [
  { key: 'collapsePenalty', label: 'Empire Fall Penalty', step: 0.1, min: 0, max: 40, group: 'Outcome', hint: 'Penalty applied if the empire falls or a simulation guard aborts.' },
  { key: 'survivalBonus', label: 'Survival Bonus', step: 0.1, min: 0, max: 20, group: 'Outcome', hint: 'Flat reward when the empire survives to scoring.' },
  { key: 'winReward', label: 'Win Reward', step: 0.1, min: 0, max: 30, group: 'Outcome', hint: 'Reward for outright winning a surviving game.' },
  { key: 'placementReward', label: 'Placement Reward', step: 0.1, min: 0, max: 15, group: 'Outcome', hint: 'Reward for finishing high even without an outright win.' },
  { key: 'scoreAdvantageReward', label: 'Score Advantage Reward', step: 0.1, min: 0, max: 15, group: 'Outcome', hint: 'Reward for ending ahead of the table mean on final score (gold + projected income).' },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundTo(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function variance(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return average(values.map(value => (value - mean) ** 2));
}

function hashSeedString(value) {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeSeed(rawSeed) {
  if (rawSeed == null || rawSeed === '') return Date.now() >>> 0;
  const text = String(rawSeed).trim();
  if (!text) return Date.now() >>> 0;
  if (/^-?\d+$/.test(text)) return Number(text) >>> 0;
  return hashSeedString(text);
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(array, rng) {
  const copy = array.slice();
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function normalizeRange(value, min, max) {
  if (max <= min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

function euclideanDistance(left, right) {
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index++) {
    const delta = (left[index] || 0) - (right[index] || 0);
    total += delta * delta;
  }
  return Math.sqrt(total);
}

function sanitizePlayerCount(value) {
  const parsed = toInt(value, DEFAULT_TRAINING_CONFIG.playerCount);
  return SUPPORTED_PLAYER_COUNTS.includes(parsed) ? parsed : DEFAULT_TRAINING_CONFIG.playerCount;
}

function uniqueList(items) {
  return [...new Set(items)];
}

function sanitizeDeckSizes(rawDeckSizes) {
  const list = Array.isArray(rawDeckSizes) ? rawDeckSizes : [];
  const cleaned = uniqueList(list.map(value => clamp(toInt(value, DEFAULT_TRAINING_CONFIG.deckSize), 1, 30))).sort((a, b) => a - b);
  return cleaned.length ? cleaned : DEFAULT_TRAINING_CONFIG.deckSizes.slice();
}

function sanitizePlayerCounts(rawPlayerCounts) {
  const list = Array.isArray(rawPlayerCounts) ? rawPlayerCounts : [];
  const cleaned = uniqueList(list.map(value => toInt(value, DEFAULT_TRAINING_CONFIG.playerCount)).filter(value => SUPPORTED_PLAYER_COUNTS.includes(value))).sort((a, b) => a - b);
  return cleaned.length ? cleaned : DEFAULT_TRAINING_CONFIG.playerCounts.slice();
}

function resolveFitnessPresetId(rawPresetId) {
  return FITNESS_PROFILES[rawPresetId] ? rawPresetId : DEFAULT_TRAINING_CONFIG.fitnessPresetId;
}

function normalizeFitnessWeights(rawWeights = {}, presetId = DEFAULT_TRAINING_CONFIG.fitnessPresetId) {
  const baseWeights = FITNESS_PROFILES[resolveFitnessPresetId(presetId)]?.weights || DEFAULT_FITNESS_WEIGHTS;
  const normalized = {};
  for (const field of FITNESS_TUNING_FIELDS) {
    const legacyKey = field.key === 'scoreAdvantageReward' ? 'wealthReward' : field.key;
    normalized[field.key] = roundTo(clamp(toNumber(rawWeights[field.key], toNumber(rawWeights[legacyKey], baseWeights[field.key])), field.min, field.max), 4);
  }
  return normalized;
}

function freshTactics(rng) {
  return {
    independence: roundTo(clamp(0.85 + (rng() - 0.5) * 0.6, 0.72, 1.75)),
    frontierAlarm: roundTo(clamp(1.2 + (rng() - 0.5) * 0.7, 0.85, 2.15)),
    churchReserve: roundTo(clamp(1.0 + (rng() - 0.5) * 0.7, 0.7, 2.2)),
    incumbencyGrip: roundTo(clamp(1.2 + (rng() - 0.5) * 0.7, 0.9, 2.1)),
  };
}

function freshMetaParams(rng) {
  const meta = {};
  for (const [key, fallback, min, max] of META_PARAM_DEFS) {
    const sampled = min + rng() * (max - min);
    meta[key] = roundTo(clamp((fallback * 0.5) + (sampled * 0.5), min, max), 4);
  }
  return meta;
}

function mutateValue(value, rng, intensity, min, max, scale = 1) {
  const swing = ((rng() + rng() + rng()) - 1.5) * intensity * scale;
  return roundTo(clamp(value + swing, min, max));
}

function dominantWeightKeys(weights, count = 2) {
  return PROFILE_WEIGHT_KEYS
    .map(key => ({ key, value: weights[key] || 0 }))
    .sort((left, right) => right.value - left.value)
    .slice(0, count)
    .map(entry => entry.key);
}

function buildProfileSignature(weights, count = 2) {
  const topKeys = dominantWeightKeys(weights, count);
  return topKeys.length ? topKeys.join('+') : 'balanced';
}

function createInternalProfile(candidate) {
  return normalizeAiProfile({
    id: candidate.id,
    name: candidate.name,
    shortName: candidate.name,
    theory: 'Self-play training genome',
    summary: candidate.summary,
    source: 'emergent-trained',
    basePersonalityId: null,
    weights: candidate.weights,
    tactics: candidate.tactics,
    meta: candidate.meta,
    training: candidate.training,
  });
}

function buildChampionName(candidate, rank) {
  const [primaryKey, secondaryKey] = dominantWeightKeys(candidate.weights, 2);
  const epithets = {
    wealth: 'Treasury',
    land: 'Estate',
    frontier: 'Aegis',
    capital: 'Palace',
    throne: 'Crown',
    church: 'Synod',
    loyalty: 'Accord',
    retaliation: 'Vendetta',
    selfAppointment: 'Patron',
    mercenary: 'Iron',
    revocation: 'Edict',
  };
  const primary = epithets[primaryKey] || 'Emergent';
  const secondary = epithets[secondaryKey] || 'Pattern';
  return `${primary} ${secondary} Mk ${rank}`;
}

function createNeutralCandidate(rng, index) {
  const weights = {};
  for (const key of PROFILE_WEIGHT_KEYS) {
    const sampled = WEIGHT_MIN + rng() * (WEIGHT_MAX - WEIGHT_MIN);
    weights[key] = roundTo(clamp((1.0 * 0.4) + (sampled * 0.6), WEIGHT_MIN, WEIGHT_MAX));
  }

  const candidate = {
    id: `cand-neut-${index}-${Math.floor(rng() * 1e9)}`,
    name: `Emergent Seed ${index + 1}`,
    summary: '',
    basePersonalityId: null,
    weights,
    tactics: freshTactics(rng),
    meta: freshMetaParams(rng),
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
    weights: { ...candidate.weights },
    tactics: { ...candidate.tactics },
    meta: { ...(candidate.meta || DEFAULT_META_PARAMS) },
    training: { ...(candidate.training || {}), generation },
  };
  clone.profile = createInternalProfile(clone);
  return clone;
}

function crossoverCandidates(parentA, parentB, rng, generation, index, mutationScale = 1) {
  const weights = {};
  for (const key of PROFILE_WEIGHT_KEYS) {
    const blend = 0.3 + (rng() * 0.4);
    const mixed = (parentA.weights[key] * blend) + (parentB.weights[key] * (1 - blend));
    weights[key] = mutateValue(mixed, rng, 0.36, WEIGHT_MIN, WEIGHT_MAX, mutationScale);
  }

  const tactics = {};
  for (const key of PROFILE_TACTIC_KEYS) {
    const source = rng() < 0.5 ? parentA.tactics[key] : parentB.tactics[key];
    tactics[key] = mutateValue(source, rng, 0.14, TACTIC_MIN, TACTIC_MAX, mutationScale);
  }

  const meta = {};
  for (const [key, , min, max, mutation] of META_PARAM_DEFS) {
    const source = rng() < 0.5
      ? (parentA.meta?.[key] ?? DEFAULT_META_PARAMS[key])
      : (parentB.meta?.[key] ?? DEFAULT_META_PARAMS[key]);
    meta[key] = mutateValue(source, rng, mutation, min, max, mutationScale);
  }

  const dominantParent = rng() < 0.5 ? parentA : parentB;
  const candidate = {
    id: `child-${generation}-${index}-${Math.floor(rng() * 1e9)}`,
    name: dominantParent.name,
    summary: '',
    basePersonalityId: null,
    weights,
    tactics,
    meta,
    training: { generation },
  };
  candidate.profile = createInternalProfile(candidate);
  return candidate;
}

function mutateCandidate(parent, rng, generation, index, mutationScale = 1) {
  const candidate = cloneCandidate(parent, generation, `m${index}`);
  for (const key of PROFILE_WEIGHT_KEYS) {
    candidate.weights[key] = mutateValue(candidate.weights[key], rng, 0.3, WEIGHT_MIN, WEIGHT_MAX, mutationScale);
  }
  for (const key of PROFILE_TACTIC_KEYS) {
    candidate.tactics[key] = mutateValue(candidate.tactics[key], rng, 0.12, TACTIC_MIN, TACTIC_MAX, mutationScale);
  }
  for (const [key, , min, max, mutation] of META_PARAM_DEFS) {
    const source = candidate.meta?.[key] ?? DEFAULT_META_PARAMS[key];
    candidate.meta[key] = mutateValue(source, rng, mutation, min, max, mutationScale);
  }
  candidate.profile = createInternalProfile(candidate);
  return candidate;
}

function buildInitialPopulation(config, rng) {
  return Array.from({ length: config.populationSize }, (_, index) => createNeutralCandidate(rng, index));
}

function createStaticProfile(id, name, summary, weightOverrides = {}, tacticOverrides = {}, metaOverrides = {}) {
  const weights = Object.fromEntries(
    PROFILE_WEIGHT_KEYS.map(key => [key, roundTo(clamp(weightOverrides[key] ?? 1.0, WEIGHT_MIN, WEIGHT_MAX))])
  );
  const tactics = {
    independence: roundTo(clamp(tacticOverrides.independence ?? 1.0, TACTIC_MIN, TACTIC_MAX)),
    frontierAlarm: roundTo(clamp(tacticOverrides.frontierAlarm ?? 1.0, TACTIC_MIN, TACTIC_MAX)),
    churchReserve: roundTo(clamp(tacticOverrides.churchReserve ?? 1.0, TACTIC_MIN, TACTIC_MAX)),
    incumbencyGrip: roundTo(clamp(tacticOverrides.incumbencyGrip ?? 1.0, TACTIC_MIN, TACTIC_MAX)),
  };
  const meta = {};
  for (const [key, fallback, min, max] of META_PARAM_DEFS) {
    meta[key] = roundTo(clamp(metaOverrides[key] ?? fallback, min, max), 4);
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
      { frontier: 0.3, capital: 4.2, throne: 4.4, loyalty: 0.2, mercenary: 4.0, retaliation: 2.6, revocation: 2.0 },
      { independence: 1.6, frontierAlarm: 0.7, incumbencyGrip: 0.8 },
      { supportTemperature: 0.05, orderTemperature: 0.05 }
    ),
  },
  {
    id: 'free_rider',
    bucket: 'scripted:free_rider',
    profile: createStaticProfile(
      'scripted-free-rider',
      'Free Rider',
      'Optimizes for private gain while under-contributing to the frontier.',
      { wealth: 3.5, land: 3.8, frontier: 0.2, capital: 2.8, throne: 2.7, loyalty: 0.2, mercenary: 2.5 },
      { independence: 1.4, frontierAlarm: 0.55, churchReserve: 1.2 }
    ),
  },
  {
    id: 'frontier_defender',
    bucket: 'scripted:frontier_defender',
    profile: createStaticProfile(
      'scripted-frontier-defender',
      'Frontier Defender',
      'Over-indexes on imperial defense and stabilizing the incumbent.',
      { frontier: 4.4, loyalty: 2.8, capital: 0.6, throne: 0.5, wealth: 0.8, mercenary: 2.2 },
      { independence: 0.8, frontierAlarm: 2.1, incumbencyGrip: 1.8 }
    ),
  },
  {
    id: 'land_buyer',
    bucket: 'scripted:always_buy_land',
    profile: createStaticProfile(
      'scripted-land-buyer',
      'Land Buyer',
      'Treats the empire as a land rush and buys aggressively.',
      { wealth: 2.8, land: 4.4, frontier: 0.7, capital: 1.4, throne: 1.1, loyalty: 0.8 },
      { churchReserve: 1.6 },
      { landPurchaseThreshold: -0.6 }
    ),
  },
  {
    id: 'church_gifter',
    bucket: 'scripted:always_gift_to_church',
    profile: createStaticProfile(
      'scripted-church-gifter',
      'Church Gifter',
      'Converts private themes into church leverage whenever possible.',
      { church: 4.4, loyalty: 2.0, land: 0.5, wealth: 0.8, frontier: 1.1, capital: 0.9, throne: 0.8 },
      { churchReserve: 0.55 },
      { churchGiftThreshold: 0.15 }
    ),
  },
  {
    id: 'punish_revocations',
    bucket: 'scripted:always_punish_revocations',
    profile: createStaticProfile(
      'scripted-punish-revocations',
      'Revocation Punisher',
      'Treats court aggression as a threat and leans into retaliation.',
      { retaliation: 4.2, revocation: 3.4, capital: 2.5, throne: 2.6, loyalty: 0.5, frontier: 0.8 },
      { independence: 1.5 }
    ),
  },
  {
    id: 'support_incumbent',
    bucket: 'scripted:always_support_incumbent',
    profile: createStaticProfile(
      'scripted-support-incumbent',
      'Incumbent Supporter',
      'Stabilizes the existing Basileus and avoids opportunistic coups.',
      { loyalty: 3.8, frontier: 2.6, capital: 0.5, throne: 0.4, selfAppointment: 0.5, retaliation: 0.6 },
      { independence: 0.7, incumbencyGrip: 2.2 },
      { supportTemperature: 0.05 }
    ),
  },
  {
    id: 'support_richest_rival',
    bucket: 'scripted:always_support_richest_rival',
    profile: createStaticProfile(
      'scripted-support-richest-rival',
      'Richest Rival Supporter',
      'Acts as a capital kingmaker behind the strongest non-incumbent challenger.',
      { capital: 3.8, throne: 3.4, loyalty: 0.6, frontier: 0.5, wealth: 1.0, mercenary: 2.8 },
      { independence: 1.5, frontierAlarm: 0.6 },
      { supportTemperature: 0.05, orderTemperature: 0.05 }
    ),
  },
];

function buildEmergentCentroids() {
  const centroids = [];
  for (let index = 0; index < 4; index++) {
    const rng = createRng(hashSeedString(`emergent-centroid:${index}`));
    centroids.push(createNeutralCandidate(rng, 5000 + index));
  }
  return centroids.map((candidate, index) => ({
    id: `cluster_${index}`,
    vector: encodeGenomeVector(candidate),
  }));
}

function encodeGenomeVector(candidateLike) {
  const vector = [];
  for (const key of PROFILE_WEIGHT_KEYS) {
    vector.push(normalizeRange(candidateLike.weights?.[key] ?? 1, WEIGHT_MIN, WEIGHT_MAX));
  }
  for (const key of PROFILE_TACTIC_KEYS) {
    vector.push(normalizeRange(candidateLike.tactics?.[key] ?? 1, TACTIC_MIN, TACTIC_MAX));
  }
  for (const [key, fallback, min, max] of META_PARAM_DEFS) {
    vector.push(normalizeRange(candidateLike.meta?.[key] ?? fallback, min, max));
  }
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
  return `hof:generation_bucket_${Math.max(0, Math.floor((Math.max(1, generation) - 1) / 10))}`;
}

function trainingStage(generation, totalGenerations) {
  const progress = (generation - 1) / Math.max(1, totalGenerations - 1);
  if (progress < 0.34) return 'early';
  if (progress < 0.67) return 'mid';
  return 'late';
}

export function buildTrainingScenarioPlan(config) {
  if (config.scenarioMode === 'focused') {
    return [{
      key: `${config.playerCount}p-${config.deckSize}d`,
      playerCount: config.playerCount,
      deckSize: config.deckSize,
    }];
  }

  const scenarios = [];
  for (const playerCount of config.playerCounts) {
    for (const deckSize of config.deckSizes) {
      scenarios.push({
        key: `${playerCount}p-${deckSize}d`,
        playerCount,
        deckSize,
      });
    }
  }
  return scenarios.length ? scenarios : [{
    key: `${config.playerCount}p-${config.deckSize}d`,
    playerCount: config.playerCount,
    deckSize: config.deckSize,
  }];
}

function getPatternForSuite(scope, stage) {
  if (scope === 'validation') return ['scripted', 'emergent', 'hof'];
  if (scope === 'holdout') return ['scripted', 'hof', 'emergent', 'scripted'];
  if (stage === 'early') return ['population', 'emergent', 'scripted'];
  if (stage === 'mid') return ['population', 'scripted', 'emergent', 'hof'];
  return ['population', 'hof', 'scripted', 'emergent'];
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

  return {
    source,
    offset: (matchIndex * 7) + (slotIndex * 13),
  };
}

export function buildEvaluationSuite(config, scope, generation, matchCount, stage) {
  const pattern = getPatternForSuite(scope, stage);
  const scenarios = buildTrainingScenarioPlan(config);
  const suite = [];

  for (let matchIndex = 0; matchIndex < matchCount; matchIndex++) {
    const scenario = scenarios[matchIndex % scenarios.length];
    const opponentCount = Math.max(0, scenario.playerCount - 1);
    const descriptors = [];
    for (let slotIndex = 0; slotIndex < opponentCount; slotIndex++) {
      const source = pattern[(matchIndex + slotIndex) % pattern.length];
      descriptors.push(buildSuiteDescriptor(source, scope, generation, matchIndex, slotIndex));
    }
    suite.push({
      scope,
      generation,
      matchIndex,
      seed: `${config.seed}:${scope}:${scenario.key}:g${generation}:m${matchIndex}`,
      focalSeat: matchIndex % scenario.playerCount,
      playerCount: scenario.playerCount,
      deckSize: scenario.deckSize,
      scenarioKey: scenario.key,
      descriptors,
    });
  }

  return suite;
}

function pickPopulationOpponent(population, focalId, offset) {
  if (!population.length) return null;
  for (let step = 0; step < population.length; step++) {
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

  return {
    bucket: getEmergentBucket(NEUTRAL_PROFILE),
    profile: createFreshEmergentProfile(`descriptor-fallback:${descriptor.source}:${descriptor.offset || 0}`),
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

function getFinalScoreValue(metric) {
  return Number(metric?.finalScore ?? metric?.finalWealth ?? 0);
}

function computeFinalScorePlacement(game, playerMetric) {
  const orderedScores = game.playerMetrics.map(metric => getFinalScoreValue(metric)).sort((left, right) => right - left);
  const placement = orderedScores.findIndex(score => score === getFinalScoreValue(playerMetric));
  if (placement === -1) return 0;
  return (game.playerMetrics.length - placement - 1) / Math.max(1, game.playerMetrics.length - 1);
}

function computeFinalScoreAdvantage(game, playerMetric) {
  const finalScore = getFinalScoreValue(playerMetric);
  const meanFinalScore = average(game.playerMetrics.map(metric => getFinalScoreValue(metric)));
  return finalScore - meanFinalScore;
}

function computeFinalScoreRatio(game, playerMetric) {
  const meanFinalScore = average(game.playerMetrics.map(metric => getFinalScoreValue(metric)));
  return meanFinalScore > 0 ? getFinalScoreValue(playerMetric) / meanFinalScore : 1;
}

function getWarContribution(war, playerId) {
  const contributions = Array.isArray(war?.contributions) ? war.contributions : [];
  return contributions
    .filter(entry => entry.playerId === playerId)
    .reduce((total, entry) => total + Math.max(0, Number(entry.troops) || 0), 0);
}

function computeCollapseDefenseProfile(game, playerMetric) {
  const wars = Array.isArray(game?.wars) ? game.wars.filter(war => (Number(war?.strength) || 0) > 0) : [];
  if (!wars.length) {
    return {
      defenseCoverage: 0,
      fatalCoverage: 0,
      commitmentRate: 0,
    };
  }

  const totalThreat = wars.reduce((total, war) => total + Math.max(0, Number(war.strength) || 0), 0);
  const defendedThreat = wars.reduce((total, war) => {
    const threat = Math.max(0, Number(war.strength) || 0);
    const contribution = getWarContribution(war, playerMetric.playerId);
    return total + Math.min(contribution, threat);
  }, 0);
  const fatalWar = wars.find(war => Boolean(war.reachedCPL)) || wars[wars.length - 1];
  const fatalThreat = Math.max(0, Number(fatalWar?.strength) || 0);
  const fatalContribution = fatalWar ? getWarContribution(fatalWar, playerMetric.playerId) : 0;
  const totalTroopsCommitted = Math.max(0, Number(playerMetric.frontierTroops) || 0) + Math.max(0, Number(playerMetric.capitalTroops) || 0);

  return {
    defenseCoverage: totalThreat > 0 ? defendedThreat / totalThreat : 0,
    fatalCoverage: fatalThreat > 0 ? Math.min(fatalContribution, fatalThreat) / fatalThreat : 0,
    commitmentRate: totalTroopsCommitted > 0
      ? Math.max(0, Number(playerMetric.frontierTroops) || 0) / totalTroopsCommitted
      : 0,
  };
}

function computeFitness(game, playerMetric, fitnessWeights) {
  if (game.guardTriggered || game.empireFall) {
    return roundTo(-fitnessWeights.collapsePenalty, 4);
  }

  const placementScore = computeFinalScorePlacement(game, playerMetric);
  const winnerBonus = playerMetric.isWinner ? 1 / Math.max(1, game.winners.length) : 0;
  const finalScoreAdvantage = clamp(computeFinalScoreAdvantage(game, playerMetric), -10, 10);

  return roundTo(
    fitnessWeights.survivalBonus +
    (winnerBonus * fitnessWeights.winReward) +
    (placementScore * fitnessWeights.placementReward) +
    (finalScoreAdvantage * fitnessWeights.scoreAdvantageReward),
    4
  );
}

function createBucketMap() {
  return new Map();
}

function addWeightedBucketStats(bucketMap, bucketKey, weight, winCredit, fitness) {
  if (!bucketMap.has(bucketKey)) {
    bucketMap.set(bucketKey, { matches: 0, wins: 0, fitnessTotal: 0 });
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
    matches: 0,
    weightedWins: 0,
    fitnessTotal: 0,
    fitnessSamples: [],
    finalScoreTotal: 0,
    finalScorePlacementTotal: 0,
    finalScoreAdvantageTotal: 0,
    finalScoreRatioTotal: 0,
    survivingFinalScoreTotal: 0,
    survivingMatches: 0,
    empireFalls: 0,
    guardAborts: 0,
    seatStats: new Map(),
    opponentTypeStats: createBucketMap(),
    opponentClassStats: createBucketMap(),
    scenarioStats: new Map(),
    behaviorTotals: {
      frontierShare: 0,
      capitalShare: 0,
      landBuys: 0,
      churchGifts: 0,
      revocations: 0,
      throneCaptures: 0,
      incumbentSupportRate: 0,
      selfSupportRate: 0,
      goldHoardingRate: 0,
      mercSpend: 0,
      recruitmentUtilization: 0,
    },
    collapseDiagnostics: {
      matches: 0,
      defenseCoverage: 0,
      fatalCoverage: 0,
      commitmentRate: 0,
    },
    basileusSeatWins: 0,
    basileusSeatMatches: 0,
    nonBasileusSeatWins: 0,
    nonBasileusSeatMatches: 0,
  };
}

function ensureScenarioAccumulatorBucket(accumulator, matchSpec) {
  const key = matchSpec.scenarioKey || `${matchSpec.playerCount}p-${matchSpec.deckSize}d`;
  if (!accumulator.scenarioStats.has(key)) {
    accumulator.scenarioStats.set(key, {
      key,
      playerCount: matchSpec.playerCount,
      deckSize: matchSpec.deckSize,
      matches: 0,
      wins: 0,
      finalScoreTotal: 0,
      finalScoreAdvantageTotal: 0,
      finalScorePlacementTotal: 0,
      survivingFinalScoreTotal: 0,
      survivingMatches: 0,
      empireFalls: 0,
      guardAborts: 0,
    });
  }
  return accumulator.scenarioStats.get(key);
}

function updateSeatStats(seatStats, seatId, winCredit, fitness) {
  if (!seatStats.has(seatId)) {
    seatStats.set(seatId, { matches: 0, wins: 0, fitnessTotal: 0 });
  }
  const bucket = seatStats.get(seatId);
  bucket.matches++;
  bucket.wins += winCredit;
  bucket.fitnessTotal += fitness;
}

function finalizeBucketStats(bucketMap) {
  const finalized = {};
  for (const [bucketKey, bucket] of bucketMap.entries()) {
    finalized[bucketKey] = {
      matches: roundTo(bucket.matches, 4),
      winRate: roundTo(bucket.wins / Math.max(0.0001, bucket.matches), 4),
      averageFitness: roundTo(bucket.fitnessTotal / Math.max(0.0001, bucket.matches), 4),
    };
  }
  return finalized;
}

function pickMatchupExtremes(perOpponentTypeWinRate) {
  const entries = Object.entries(perOpponentTypeWinRate).filter(([, value]) => value.matches > 0);
  if (!entries.length) {
    return {
      bestMatchup: null,
      worstMatchup: null,
    };
  }

  const best = entries.slice().sort((left, right) => right[1].winRate - left[1].winRate || right[1].matches - left[1].matches)[0];
  const worst = entries.slice().sort((left, right) => left[1].winRate - right[1].winRate || right[1].matches - left[1].matches)[0];
  return {
    bestMatchup: { tag: best[0], ...best[1] },
    worstMatchup: { tag: worst[0], ...worst[1] },
  };
}

function buildBehaviorVector(summary) {
  const behavior = summary.behaviorProfile;
  return [
    clamp(behavior.frontierTroopShare, 0, 1),
    clamp(behavior.capitalTroopShare, 0, 1),
    clamp(behavior.averageLandBuys / 3, 0, 1),
    clamp(behavior.averageChurchGifts / 3, 0, 1),
    clamp(behavior.averageRevocations / 2, 0, 1),
    clamp(behavior.averageThroneCaptures / 2, 0, 1),
    clamp(behavior.incumbentSupportRate, 0, 1),
    clamp(behavior.selfSupportRate, 0, 1),
    clamp(behavior.goldHoardingRate, 0, 1),
    clamp(behavior.averageMercSpend / 15, 0, 1),
    clamp(behavior.recruitmentUtilization, 0, 1),
  ];
}

function finalizeScenarioStats(scenarioStats) {
  return [...scenarioStats.values()]
    .map(bucket => ({
      key: bucket.key,
      playerCount: bucket.playerCount,
      deckSize: bucket.deckSize,
      matches: bucket.matches,
      winShare: roundTo(bucket.wins / Math.max(1, bucket.matches), 4),
      finalScoreMean: roundTo(bucket.finalScoreTotal / Math.max(1, bucket.matches), 2),
      finalScoreAdvantage: roundTo(bucket.finalScoreAdvantageTotal / Math.max(1, bucket.matches), 4),
      finalScorePlacement: roundTo(bucket.finalScorePlacementTotal / Math.max(1, bucket.matches), 4),
      survivingFinalScoreMean: roundTo(bucket.survivingFinalScoreTotal / Math.max(1, bucket.survivingMatches), 2),
      empireFallRate: roundTo(bucket.empireFalls / Math.max(1, bucket.matches), 4),
      guardRate: roundTo(bucket.guardAborts / Math.max(1, bucket.matches), 4),
      unsafeRate: roundTo((bucket.empireFalls + bucket.guardAborts) / Math.max(1, bucket.matches), 4),
    }))
    .sort((left, right) => left.playerCount - right.playerCount || left.deckSize - right.deckSize);
}

function finalizeEvaluationSummary(accumulator) {
  const perOpponentTypeWinRate = finalizeBucketStats(accumulator.opponentTypeStats);
  const perOpponentClassWinRate = finalizeBucketStats(accumulator.opponentClassStats);
  const perSeatWinRate = {};
  for (const [seatId, bucket] of accumulator.seatStats.entries()) {
    perSeatWinRate[seatId] = {
      matches: bucket.matches,
      winRate: roundTo(bucket.wins / Math.max(1, bucket.matches), 4),
      averageFitness: roundTo(bucket.fitnessTotal / Math.max(1, bucket.matches), 4),
    };
  }

  const opponentVariance = variance(Object.values(perOpponentTypeWinRate).map(bucket => bucket.winRate));
  const seatVariance = variance(Object.values(perSeatWinRate).map(bucket => bucket.winRate));
  const totalTroopShare = Math.max(0.0001, accumulator.behaviorTotals.frontierShare + accumulator.behaviorTotals.capitalShare);
  const basileusSeatWinShare = accumulator.basileusSeatMatches
    ? accumulator.basileusSeatWins / accumulator.basileusSeatMatches
    : 0;
  const nonBasileusSeatWinShare = accumulator.nonBasileusSeatMatches
    ? accumulator.nonBasileusSeatWins / accumulator.nonBasileusSeatMatches
    : 0;
  const matchupExtremes = pickMatchupExtremes(perOpponentTypeWinRate);
  const perScenario = finalizeScenarioStats(accumulator.scenarioStats);

  const summary = {
    generation: accumulator.generation,
    scope: accumulator.scope,
    matches: accumulator.matches,
    wins: roundTo(accumulator.weightedWins, 4),
    winShare: roundTo(accumulator.weightedWins / Math.max(1, accumulator.matches), 4),
    averageFitness: roundTo(accumulator.fitnessTotal / Math.max(1, accumulator.matches), 4),
    finalScoreMean: roundTo(accumulator.finalScoreTotal / Math.max(1, accumulator.matches), 2),
    finalScorePlacement: roundTo(accumulator.finalScorePlacementTotal / Math.max(1, accumulator.matches), 4),
    finalScoreAdvantage: roundTo(accumulator.finalScoreAdvantageTotal / Math.max(1, accumulator.matches), 4),
    finalScoreRatio: roundTo(accumulator.finalScoreRatioTotal / Math.max(1, accumulator.matches), 4),
    survivingFinalScoreMean: roundTo(accumulator.survivingFinalScoreTotal / Math.max(1, accumulator.survivingMatches), 2),
    empireFallRate: roundTo(accumulator.empireFalls / Math.max(1, accumulator.matches), 4),
    guardRate: roundTo(accumulator.guardAborts / Math.max(1, accumulator.matches), 4),
    unsafeRate: roundTo((accumulator.empireFalls + accumulator.guardAborts) / Math.max(1, accumulator.matches), 4),
    fitnessVariance: roundTo(variance(accumulator.fitnessSamples), 4),
    opponentVariance: roundTo(opponentVariance, 4),
    seatVariance: roundTo(seatVariance, 4),
    perOpponentTypeWinRate,
    perOpponentClassWinRate,
    perSeatWinRate,
    perScenario,
    bestMatchup: matchupExtremes.bestMatchup,
    worstMatchup: matchupExtremes.worstMatchup,
    startingBasileusSeatBias: roundTo(basileusSeatWinShare - nonBasileusSeatWinShare, 4),
    behaviorProfile: {
      frontierTroopShare: roundTo(accumulator.behaviorTotals.frontierShare / totalTroopShare, 4),
      capitalTroopShare: roundTo(accumulator.behaviorTotals.capitalShare / totalTroopShare, 4),
      averageLandBuys: roundTo(accumulator.behaviorTotals.landBuys / Math.max(1, accumulator.matches), 4),
      averageChurchGifts: roundTo(accumulator.behaviorTotals.churchGifts / Math.max(1, accumulator.matches), 4),
      averageRevocations: roundTo(accumulator.behaviorTotals.revocations / Math.max(1, accumulator.matches), 4),
      averageThroneCaptures: roundTo(accumulator.behaviorTotals.throneCaptures / Math.max(1, accumulator.matches), 4),
      incumbentSupportRate: roundTo(accumulator.behaviorTotals.incumbentSupportRate / Math.max(1, accumulator.matches), 4),
      selfSupportRate: roundTo(accumulator.behaviorTotals.selfSupportRate / Math.max(1, accumulator.matches), 4),
      goldHoardingRate: roundTo(accumulator.behaviorTotals.goldHoardingRate / Math.max(1, accumulator.matches), 4),
      averageMercSpend: roundTo(accumulator.behaviorTotals.mercSpend / Math.max(1, accumulator.matches), 4),
      recruitmentUtilization: roundTo(accumulator.behaviorTotals.recruitmentUtilization / Math.max(1, accumulator.matches), 4),
    },
    collapseDiagnostics: {
      defenseCoverage: roundTo(accumulator.collapseDiagnostics.defenseCoverage / Math.max(1, accumulator.collapseDiagnostics.matches), 4),
      fatalCoverage: roundTo(accumulator.collapseDiagnostics.fatalCoverage / Math.max(1, accumulator.collapseDiagnostics.matches), 4),
      commitmentRate: roundTo(accumulator.collapseDiagnostics.commitmentRate / Math.max(1, accumulator.collapseDiagnostics.matches), 4),
    },
  };
  summary.averageFinalScore = summary.finalScoreMean;
  summary.averageWealth = summary.finalScoreMean;
  summary.wealthPercentile = summary.finalScorePlacement;
  summary.wealthRatio = summary.finalScoreRatio;
  summary.behaviorVector = buildBehaviorVector(summary);
  return summary;
}

export function evaluateCandidateOnSuite(candidate, suite, context, fitnessWeights) {
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
      scenarioKey: matchSpec.scenarioKey,
      seed: matchSpec.seed,
      seatProfiles,
      strictTimeoutMs: 15000,
      maxLoopIterations: 256,
      maxRounds: Math.max(matchSpec.deckSize + 2, 40),
    });
    const playerMetric = game.playerMetrics.find(metric => metric.playerId === matchSpec.focalSeat);
    if (!playerMetric) continue;

    const winCredit = playerMetric.isWinner ? 1 / Math.max(1, game.winners.length) : 0;
    const fitness = computeFitness(game, playerMetric, fitnessWeights);
    const placementScore = computeFinalScorePlacement(game, playerMetric);
    const finalScore = getFinalScoreValue(playerMetric);
    const finalScoreAdvantage = computeFinalScoreAdvantage(game, playerMetric);
    const finalScoreRatio = computeFinalScoreRatio(game, playerMetric);
    const totalTroops = Math.max(0, playerMetric.frontierTroops) + Math.max(0, playerMetric.capitalTroops);
    const frontierShare = totalTroops > 0 ? playerMetric.frontierTroops / totalTroops : 0;
    const capitalShare = totalTroops > 0 ? playerMetric.capitalTroops / totalTroops : 0;
    const recruitUtilization = playerMetric.recruitOpportunities > 0
      ? playerMetric.recruits / playerMetric.recruitOpportunities
      : 0;
    const incumbentSupportRate = playerMetric.coupVotes > 0
      ? playerMetric.supportIncumbentVotes / playerMetric.coupVotes
      : 0;
    const selfSupportRate = playerMetric.coupVotes > 0
      ? playerMetric.supportSelfVotes / playerMetric.coupVotes
      : 0;
    const goldHoardingRate = finalScore > 0
      ? playerMetric.finalGold / finalScore
      : 0;

    accumulator.matches++;
    accumulator.weightedWins += winCredit;
    accumulator.fitnessTotal += fitness;
    accumulator.fitnessSamples.push(fitness);
    accumulator.finalScoreTotal += finalScore;
    accumulator.finalScorePlacementTotal += placementScore;
    accumulator.finalScoreAdvantageTotal += finalScoreAdvantage;
    accumulator.finalScoreRatioTotal += finalScoreRatio;
    if (game.empireFall) accumulator.empireFalls++;
    if (game.guardTriggered) accumulator.guardAborts++;
    if (!game.empireFall && !game.guardTriggered) {
      accumulator.survivingMatches++;
      accumulator.survivingFinalScoreTotal += finalScore;
    }

    const scenarioBucket = ensureScenarioAccumulatorBucket(accumulator, matchSpec);
    scenarioBucket.matches++;
    scenarioBucket.wins += winCredit;
    scenarioBucket.finalScoreTotal += finalScore;
    scenarioBucket.finalScoreAdvantageTotal += finalScoreAdvantage;
    scenarioBucket.finalScorePlacementTotal += placementScore;
    scenarioBucket.empireFalls += game.empireFall ? 1 : 0;
    scenarioBucket.guardAborts += game.guardTriggered ? 1 : 0;
    if (!game.empireFall && !game.guardTriggered) {
      scenarioBucket.survivingMatches++;
      scenarioBucket.survivingFinalScoreTotal += finalScore;
    }

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
      bucketCounts.set(bucket, (bucketCounts.get(bucket) || 0) + 1);
    }
    for (const [bucketKey, count] of bucketCounts.entries()) {
      const weight = count / Math.max(1, opponentBuckets.length);
      addWeightedBucketStats(accumulator.opponentTypeStats, bucketKey, weight, winCredit, fitness);
      const bucketClass = String(bucketKey).split(':')[0];
      addWeightedBucketStats(accumulator.opponentClassStats, bucketClass, weight, winCredit, fitness);
    }

    accumulator.behaviorTotals.frontierShare += frontierShare;
    accumulator.behaviorTotals.capitalShare += capitalShare;
    accumulator.behaviorTotals.landBuys += playerMetric.landBuys;
    accumulator.behaviorTotals.churchGifts += playerMetric.themesGifted;
    accumulator.behaviorTotals.revocations += playerMetric.revocations;
    accumulator.behaviorTotals.throneCaptures += playerMetric.throneCaptures;
    accumulator.behaviorTotals.incumbentSupportRate += incumbentSupportRate;
    accumulator.behaviorTotals.selfSupportRate += selfSupportRate;
    accumulator.behaviorTotals.goldHoardingRate += goldHoardingRate;
    accumulator.behaviorTotals.mercSpend += playerMetric.mercSpend;
    accumulator.behaviorTotals.recruitmentUtilization += recruitUtilization;

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
    generation = 1,
    fitnessWeights = DEFAULT_FITNESS_WEIGHTS,
  } = payload;

  if (mode === 'generation') {
    return candidates.map(candidate => ({
      candidateId: candidate.id,
      trainSummary: evaluateCandidateOnSuite(candidate, trainingSuite, {
        config,
        generation,
        scope: 'training',
        population,
        hallOfFame,
      }, fitnessWeights),
      validationSummary: evaluateCandidateOnSuite(candidate, validationSuite, {
        config,
        generation,
        scope: 'validation',
        population,
        hallOfFame,
      }, fitnessWeights),
    }));
  }

  if (mode === 'holdout') {
    return candidates.map(candidate => ({
      candidateId: candidate.id,
      holdoutSummary: evaluateCandidateOnSuite(candidate, holdoutSuite, {
        config,
        generation,
        scope: 'holdout',
        population,
        hallOfFame,
      }, fitnessWeights),
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
  if (!comparisons.length) return 1;
  const distances = comparisons.sort((left, right) => left - right);
  const k = Math.min(5, distances.length);
  return roundTo(average(distances.slice(0, k)), 4);
}

function computeTrainingScore(summary) {
  return roundTo(
    (summary.winShare * 8) +
    (summary.finalScorePlacement * 4) +
    (summary.finalScoreAdvantage * 1.1) +
    ((summary.survivingFinalScoreMean || summary.finalScoreMean) * 0.45) +
    (getClassWinRate(summary, 'scripted') * 3) +
    (getClassWinRate(summary, 'hof') * 3) +
    (getClassWinRate(summary, 'emergent') * 2) -
    (Math.sqrt(summary.opponentVariance) * 2.2) -
    (Math.sqrt(summary.seatVariance) * 1.3),
    4
  );
}

function isSafeSummary(summary) {
  return (summary.guardRate || 0) <= 1e-9 && (summary.empireFallRate || 0) <= 1e-9;
}

function compareRiskSummary(leftSummary, rightSummary) {
  return (
    ((leftSummary.guardRate || 0) - (rightSummary.guardRate || 0)) ||
    ((leftSummary.empireFallRate || 0) - (rightSummary.empireFallRate || 0)) ||
    ((leftSummary.unsafeRate || 0) - (rightSummary.unsafeRate || 0))
  );
}

function findViableRiskPool(entries, summarySelector = entry => entry.validationSummary) {
  const safeEntries = entries.filter(entry => isSafeSummary(summarySelector(entry)));
  if (safeEntries.length) {
    return {
      entries: safeEntries,
      safetyMode: 'safe-only',
    };
  }

  let bestGuardRate = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    bestGuardRate = Math.min(bestGuardRate, summarySelector(entry).guardRate || 0);
  }
  const guardPool = entries.filter(entry => Math.abs((summarySelector(entry).guardRate || 0) - bestGuardRate) <= 1e-9);

  let bestFallRate = Number.POSITIVE_INFINITY;
  for (const entry of guardPool) {
    bestFallRate = Math.min(bestFallRate, summarySelector(entry).empireFallRate || 0);
  }

  return {
    entries: guardPool.filter(entry => Math.abs((summarySelector(entry).empireFallRate || 0) - bestFallRate) <= 1e-9),
    safetyMode: 'minimum-risk',
    bestGuardRate,
    bestFallRate,
  };
}

function buildObjectivesFromSummary(summary) {
  return {
    winShare: summary.winShare,
    finalScorePlacement: summary.finalScorePlacement,
    finalScoreAdvantage: summary.finalScoreAdvantage,
    survivingFinalScoreMean: summary.survivingFinalScoreMean,
    scriptedWinRate: getClassWinRate(summary, 'scripted'),
    hallOfFameWinRate: getClassWinRate(summary, 'hof'),
    emergentWinRate: getClassWinRate(summary, 'emergent'),
    opponentRobustness: roundTo(1 - Math.min(1, Math.sqrt(summary.opponentVariance)), 4),
    seatRobustness: roundTo(1 - Math.min(1, Math.sqrt(summary.seatVariance) * 4), 4),
  };
}

export function buildSelectionEntry(candidate, generation, trainSummary, validationSummary, noveltyScore) {
  return {
    candidate,
    generation,
    trainSummary,
    validationSummary,
    selectionSummary: validationSummary,
    holdoutSummary: null,
    noveltyScore,
    championScore: computeTrainingScore(validationSummary),
    objectives: buildObjectivesFromSummary(validationSummary),
    paretoRank: Number.POSITIVE_INFINITY,
    crowdingDistance: 0,
  };
}

function dominates(left, right) {
  let strictlyBetter = false;
  for (const key of OBJECTIVE_KEYS) {
    const leftValue = left.objectives[key] ?? 0;
    const rightValue = right.objectives[key] ?? 0;
    if (leftValue + 1e-9 < rightValue) return false;
    if (leftValue > rightValue + 1e-9) strictlyBetter = true;
  }
  return strictlyBetter;
}

function assignCrowdingDistance(front) {
  if (!front.length) return;
  for (const entry of front) entry.crowdingDistance = 0;
  if (front.length <= 2) {
    for (const entry of front) entry.crowdingDistance = Number.POSITIVE_INFINITY;
    return;
  }

  for (const key of OBJECTIVE_KEYS) {
    const sorted = front.slice().sort((left, right) => (left.objectives[key] ?? 0) - (right.objectives[key] ?? 0));
    const minValue = sorted[0].objectives[key] ?? 0;
    const maxValue = sorted[sorted.length - 1].objectives[key] ?? 0;
    sorted[0].crowdingDistance = Number.POSITIVE_INFINITY;
    sorted[sorted.length - 1].crowdingDistance = Number.POSITIVE_INFINITY;
    if (maxValue <= minValue) continue;
    for (let index = 1; index < sorted.length - 1; index++) {
      if (!Number.isFinite(sorted[index].crowdingDistance)) continue;
      const previous = sorted[index - 1].objectives[key] ?? 0;
      const next = sorted[index + 1].objectives[key] ?? 0;
      sorted[index].crowdingDistance += (next - previous) / (maxValue - minValue);
    }
  }
}

function compareSelectionEntries(left, right) {
  return (
    compareRiskSummary(left.selectionSummary || left.validationSummary, right.selectionSummary || right.validationSummary) ||
    (left.paretoRank - right.paretoRank) ||
    ((right.crowdingDistance || 0) - (left.crowdingDistance || 0)) ||
    (right.championScore - left.championScore) ||
    (right.noveltyScore - left.noveltyScore) ||
    ((right.selectionSummary?.winShare || right.validationSummary.winShare) - (left.selectionSummary?.winShare || left.validationSummary.winShare)) ||
    left.candidate.id.localeCompare(right.candidate.id)
  );
}

function sortByPareto(entries, summarySelector = entry => entry.validationSummary) {
  const working = entries.slice();
  const dominationCounts = new Map();
  const dominatesMap = new Map();
  const fronts = [];
  const firstFront = [];

  for (const entry of working) {
    dominationCounts.set(entry, 0);
    dominatesMap.set(entry, []);
    for (const rival of working) {
      if (entry === rival) continue;
      if (dominates(entry, rival)) {
        dominatesMap.get(entry).push(rival);
      } else if (dominates(rival, entry)) {
        dominationCounts.set(entry, (dominationCounts.get(entry) || 0) + 1);
      }
    }
    if ((dominationCounts.get(entry) || 0) === 0) {
      entry.paretoRank = 1;
      firstFront.push(entry);
    }
  }

  fronts.push(firstFront);
  let frontIndex = 0;
  while (frontIndex < fronts.length && fronts[frontIndex].length) {
    const nextFront = [];
    for (const entry of fronts[frontIndex]) {
      for (const dominated of dominatesMap.get(entry) || []) {
        const nextCount = (dominationCounts.get(dominated) || 0) - 1;
        dominationCounts.set(dominated, nextCount);
        if (nextCount === 0) {
          dominated.paretoRank = frontIndex + 2;
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

export function rankSelectionEntries(entries, summarySelector = entry => entry.validationSummary) {
  if (!entries.length) return { rankedEntries: [], safetyMode: 'none' };
  const viablePool = findViableRiskPool(entries, summarySelector);
  const viableSet = new Set(viablePool.entries);
  const rankedViable = sortByPareto(viablePool.entries, summarySelector);
  const rankedRemainder = entries
    .filter(entry => !viableSet.has(entry))
    .sort((left, right) => (
      compareRiskSummary(summarySelector(left), summarySelector(right)) ||
      (right.championScore - left.championScore) ||
      (right.noveltyScore - left.noveltyScore) ||
      left.candidate.id.localeCompare(right.candidate.id)
    ));

  return {
    rankedEntries: [...rankedViable, ...rankedRemainder],
    safetyMode: viablePool.safetyMode,
  };
}

function tournamentSelect(entries, rng) {
  let best = null;
  const sampleSize = Math.min(3, entries.length);
  for (let index = 0; index < sampleSize; index++) {
    const entry = entries[Math.floor(rng() * entries.length)];
    if (!best || compareSelectionEntries(entry, best) < 0) {
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
  const progress = (generation - 1) / Math.max(1, totalGenerations - 1);
  const noveltyPressure = averageNoveltyScore < 0.18 ? 1.25 : averageNoveltyScore > 0.35 ? 0.9 : 1;
  return clamp((1.15 - (progress * 0.45)) * noveltyPressure, 0.65, 1.4);
}

function describeBehaviorProfile(summary) {
  const behavior = summary.behaviorProfile;
  const levels = [];
  levels.push(`${behavior.frontierTroopShare >= 0.58 ? 'high' : behavior.frontierTroopShare <= 0.35 ? 'low' : 'moderate'} frontier defense`);
  levels.push(`${behavior.averageLandBuys >= 1.2 ? 'high' : behavior.averageLandBuys <= 0.4 ? 'low' : 'moderate'} land buying`);
  levels.push(`${behavior.averageRevocations >= 0.6 ? 'high' : behavior.averageRevocations <= 0.15 ? 'low' : 'moderate'} revocation`);
  return levels.join(', ');
}

function buildChampionSummary(candidate, holdoutSummary) {
  const traitLabels = {
    wealth: 'wealth extraction',
    land: 'land acquisition',
    frontier: 'frontier defense',
    capital: 'capital intrigue',
    throne: 'throne pressure',
    church: 'church leverage',
    loyalty: 'coalition loyalty',
    retaliation: 'retaliation',
    selfAppointment: 'self-promotion',
    mercenary: 'mercenary spending',
    revocation: 'revocations',
  };
  const topTraits = dominantWeightKeys(candidate.weights, 2).map(key => traitLabels[key] || key);
  return `Self-play champion focused on ${topTraits.join(' and ')}, with holdout behavior showing ${describeBehaviorProfile(holdoutSummary)}.`;
}

function chunkArray(items, chunkCount) {
  if (chunkCount <= 1 || items.length <= 1) return [items.slice()];
  const chunks = Array.from({ length: Math.min(chunkCount, items.length) }, () => []);
  items.forEach((item, index) => {
    chunks[index % chunks.length].push(item);
  });
  return chunks.filter(chunk => chunk.length);
}

function getRecommendedParallelWorkerCount(config, candidateCount) {
  if (config.parallelWorkers > 0) {
    return Math.max(1, Math.min(config.parallelWorkers, candidateCount));
  }
  if (typeof Worker !== 'function') return 1;
  const hardware = Math.max(1, Number(globalThis.navigator?.hardwareConcurrency) || 1);
  return Math.max(1, Math.min(candidateCount, Math.max(1, hardware - 1), 6));
}

function runEvaluationWorkerPayload(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./evaluation.worker.js', import.meta.url), { type: 'module' });
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
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

async function runParallelEvaluationPayloads(payloads, onChunkComplete = null) {
  const results = await Promise.all(payloads.map(payload =>
    runEvaluationWorkerPayload(payload).then(result => {
      onChunkComplete?.(result);
      return result;
    })
  ));
  return results.flat();
}

async function evaluateGenerationPopulation({
  population,
  trainingSuite,
  validationSuite,
  config,
  generation,
  hallOfFame,
  workerCount,
  onEntry = null,
}) {
  const candidateById = new Map(population.map(candidate => [candidate.id, candidate]));
  const evaluationEntries = [];

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

  if (workerCount > 1) {
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
      const chunkResults = await runParallelEvaluationPayloads(payloads);
      consumeChunk(chunkResults);
      return evaluationEntries;
    } catch {
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

  return evaluationEntries;
}

async function evaluateHoldoutPopulation({
  finalists,
  holdoutSuite,
  config,
  generation,
  population,
  hallOfFame,
  workerCount,
  onEntry = null,
}) {
  const candidateById = new Map(finalists.map(entry => [entry.candidate.id, entry]));
  const holdoutEntries = [];

  const consumeChunk = (chunkResults) => {
    for (const result of chunkResults) {
      const finalist = candidateById.get(result.candidateId);
      if (!finalist) continue;
      const holdoutSummary = result.holdoutSummary;
      const holdoutNovelty = computeNoveltyScore(
        holdoutSummary.behaviorVector,
        hallOfFame.map(item => item.behaviorVector),
        finalists.map(item => item.trainSummary.behaviorVector)
      );
      const entry = {
        ...finalist,
        selectionSummary: holdoutSummary,
        holdoutSummary,
        noveltyScore: holdoutNovelty,
        championScore: computeTrainingScore(holdoutSummary),
        objectives: buildObjectivesFromSummary(holdoutSummary),
      };
      holdoutEntries.push(entry);
      onEntry?.(entry);
    }
  };

  if (workerCount > 1) {
    try {
      const payloads = chunkArray(finalists.map(entry => entry.candidate), workerCount).map(candidates => ({
        mode: 'holdout',
        candidates,
        holdoutSuite,
        population,
        hallOfFame,
        config,
        generation,
        fitnessWeights: config.fitness,
      }));
      const chunkResults = await runParallelEvaluationPayloads(payloads);
      consumeChunk(chunkResults);
      return holdoutEntries;
    } catch {
      // Fall through to sequential evaluation.
    }
  }

  for (const finalist of finalists) {
    const holdoutSummary = evaluateCandidateOnSuite(finalist.candidate, holdoutSuite, {
      config,
      generation,
      scope: 'holdout',
      population,
      hallOfFame,
    }, config.fitness);
    const holdoutNovelty = computeNoveltyScore(
      holdoutSummary.behaviorVector,
      hallOfFame.map(item => item.behaviorVector),
      finalists.map(item => item.trainSummary.behaviorVector)
    );
    const entry = {
      ...finalist,
      selectionSummary: holdoutSummary,
      holdoutSummary,
      noveltyScore: holdoutNovelty,
      championScore: computeTrainingScore(holdoutSummary),
      objectives: buildObjectivesFromSummary(holdoutSummary),
    };
    holdoutEntries.push(entry);
    onEntry?.(entry);
  }

  return holdoutEntries;
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
    weights: entry.candidate.weights,
    tactics: entry.candidate.tactics,
    meta: entry.candidate.meta,
    training: {
      generation: entry.generation,
      matches: holdoutSummary.matches,
      wins: holdoutSummary.wins,
      winShare: holdoutSummary.winShare,
      championScore: entry.championScore,
      averageFitness: holdoutSummary.averageFitness,
      finalScoreMean: holdoutSummary.finalScoreMean,
      finalScoreAdvantage: holdoutSummary.finalScoreAdvantage,
      finalScorePlacement: holdoutSummary.finalScorePlacement,
      survivingFinalScoreMean: holdoutSummary.survivingFinalScoreMean,
      unsafeRate: holdoutSummary.unsafeRate,
      averageFinalScore: holdoutSummary.finalScoreMean,
      averageWealth: holdoutSummary.averageWealth,
      empireFallRate: holdoutSummary.empireFallRate,
      fitnessVariance: holdoutSummary.fitnessVariance,
      perOpponentTypeWinRate: holdoutSummary.perOpponentTypeWinRate,
      perSeatWinRate: holdoutSummary.perSeatWinRate,
      perScenario: holdoutSummary.perScenario,
      fitnessPresetId: config.fitnessPresetId,
      scenarioMode: config.scenarioMode,
      playerCount: config.playerCount,
      deckSize: config.deckSize,
      playerCounts: config.playerCounts,
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
      trainFinalScoreMean: entry.trainSummary.finalScoreMean,
      validationFinalScoreMean: entry.validationSummary.finalScoreMean,
      holdoutFinalScoreMean: holdoutSummary.finalScoreMean,
      trainFinalScoreAdvantage: entry.trainSummary.finalScoreAdvantage,
      validationFinalScoreAdvantage: entry.validationSummary.finalScoreAdvantage,
      holdoutFinalScoreAdvantage: holdoutSummary.finalScoreAdvantage,
      trainSurvivingFinalScoreMean: entry.trainSummary.survivingFinalScoreMean,
      validationSurvivingFinalScoreMean: entry.validationSummary.survivingFinalScoreMean,
      holdoutSurvivingFinalScoreMean: holdoutSummary.survivingFinalScoreMean,
      trainEmpireFallRate: entry.trainSummary.empireFallRate,
      validationEmpireFallRate: entry.validationSummary.empireFallRate,
      holdoutEmpireFallRate: holdoutSummary.empireFallRate,
      trainWealthPercentile: entry.trainSummary.wealthPercentile,
      validationWealthPercentile: entry.validationSummary.wealthPercentile,
      holdoutWealthPercentile: holdoutSummary.wealthPercentile,
      guardRate: holdoutSummary.guardRate,
      paretoFront: entry.paretoRank,
      crowdingDistance: roundTo(entry.crowdingDistance, 4),
      noveltyScore: entry.noveltyScore,
      noveltyPercentile,
      safetyMode: entry.safetyMode || 'safe-only',
      seatBias: holdoutSummary.startingBasileusSeatBias,
      bestMatchup: holdoutSummary.bestMatchup?.tag || '',
      worstMatchup: holdoutSummary.worstMatchup?.tag || '',
      behaviorProfile: holdoutSummary.behaviorProfile,
      mainBehavior: describeBehaviorProfile(holdoutSummary),
    },
  });
}

export function normalizeTrainingConfig(rawConfig = {}) {
  const playerCount = sanitizePlayerCount(rawConfig.playerCount);
  const scenarioMode = rawConfig.scenarioMode === 'focused' ? 'focused' : DEFAULT_TRAINING_CONFIG.scenarioMode;
  const playerCounts = sanitizePlayerCounts(rawConfig.playerCounts);
  const deckSizes = sanitizeDeckSizes(rawConfig.deckSizes);
  const fitnessPresetId = rawConfig.fitnessPresetId === 'custom'
    ? 'custom'
    : resolveFitnessPresetId(rawConfig.fitnessPresetId);
  const fitness = normalizeFitnessWeights(rawConfig.fitness, rawConfig.fitnessPresetId);

  return {
    seed: normalizeSeed(rawConfig.seed ?? DEFAULT_TRAINING_CONFIG.seed),
    scenarioMode,
    playerCount,
    deckSize: clamp(toInt(rawConfig.deckSize, DEFAULT_TRAINING_CONFIG.deckSize), 1, 30),
    playerCounts,
    deckSizes,
    fitnessPresetId,
    fitness,
    populationSize: clamp(toInt(rawConfig.populationSize, DEFAULT_TRAINING_CONFIG.populationSize), playerCount, 64),
    generations: clamp(toInt(rawConfig.generations, DEFAULT_TRAINING_CONFIG.generations), 1, 60),
    matchesPerCandidate: clamp(toInt(rawConfig.matchesPerCandidate, DEFAULT_TRAINING_CONFIG.matchesPerCandidate), 1, 64),
    validationMatchesPerCandidate: clamp(toInt(rawConfig.validationMatchesPerCandidate, DEFAULT_TRAINING_CONFIG.validationMatchesPerCandidate), 1, 32),
    holdoutMatchesPerChampion: clamp(toInt(rawConfig.holdoutMatchesPerChampion, DEFAULT_TRAINING_CONFIG.holdoutMatchesPerChampion), 16, 256),
    champions: clamp(toInt(rawConfig.champions, DEFAULT_TRAINING_CONFIG.champions), 1, 10),
    hallOfFameSize: clamp(toInt(rawConfig.hallOfFameSize, DEFAULT_TRAINING_CONFIG.hallOfFameSize), 0, 64),
    eliteFraction: clamp(toNumber(rawConfig.eliteFraction, DEFAULT_TRAINING_CONFIG.eliteFraction), 0.1, 0.4),
    freshBloodRate: clamp(toNumber(rawConfig.freshBloodRate, DEFAULT_TRAINING_CONFIG.freshBloodRate), 0.05, 0.25),
    parallelWorkers: clamp(toInt(rawConfig.parallelWorkers, DEFAULT_TRAINING_CONFIG.parallelWorkers), 0, 16),
  };
}

function getHoldoutFinalistCount(config) {
  return Math.min(config.populationSize, Math.max(config.champions * 3, 8));
}

export function estimateTrainingMatches(rawConfig = {}) {
  const config = normalizeTrainingConfig(rawConfig);
  return (
    config.generations * config.populationSize * (config.matchesPerCandidate + config.validationMatchesPerCandidate) +
    (getHoldoutFinalistCount(config) * config.holdoutMatchesPerChampion)
  );
}

export async function runEvolutionTraining(rawConfig = {}, onProgress = null) {
  const startedAt = Date.now();
  const config = normalizeTrainingConfig(rawConfig);
  const rng = createRng(config.seed);
  const generationWorkerCount = getRecommendedParallelWorkerCount(config, config.populationSize);
  let population = buildInitialPopulation(config, rng);
  const validationSuite = buildEvaluationSuite(config, 'validation', 0, config.validationMatchesPerCandidate, 'late');
  const holdoutSuite = buildEvaluationSuite(config, 'holdout', 0, config.holdoutMatchesPerChampion, 'late');
  const totalMatches = estimateTrainingMatches(config);
  let completedMatches = 0;
  const generationHistory = [];
  const hallOfFame = [];
  let finalRankedEntries = [];

  for (let generation = 1; generation <= config.generations; generation++) {
    const stage = trainingStage(generation, config.generations);
    const trainingSuite = buildEvaluationSuite(config, 'training', generation, config.matchesPerCandidate, stage);
    const archiveVectors = hallOfFame.map(entry => entry.behaviorVector);
    let evaluatedCandidateCount = 0;
    const partialGenerationEntries = [];
    const evaluationEntries = await evaluateGenerationPopulation({
      population,
      trainingSuite,
      validationSuite,
      config,
      generation,
      hallOfFame,
      workerCount: generationWorkerCount,
      onEntry: (entry) => {
        partialGenerationEntries.push(entry);
        evaluatedCandidateCount++;
        completedMatches += entry.trainSummary.matches + entry.validationSummary.matches;
        const partialRank = rankSelectionEntries(partialGenerationEntries.map(item => buildSelectionEntry(
          item.candidate,
          generation,
          item.trainSummary,
          item.validationSummary,
          0
        )));
        const partialLeader = partialRank.rankedEntries[0];

        onProgress?.({
          mode: 'training',
          generation,
          generations: config.generations,
          completed: completedMatches,
          total: totalMatches,
          matchesThisGeneration: population.length,
          currentMatch: evaluatedCandidateCount,
          leaderName: partialLeader?.candidate?.name || 'Evaluating',
          leaderFitness: partialLeader?.championScore || 0,
          stage,
          hallOfFameSize: hallOfFame.length,
        });
      },
    });

    const peerVectors = evaluationEntries.map(entry => entry.trainSummary.behaviorVector);
    const selectionEntries = evaluationEntries.map(entry => buildSelectionEntry(
      entry.candidate,
      generation,
      entry.trainSummary,
      entry.validationSummary,
      computeNoveltyScore(entry.trainSummary.behaviorVector, archiveVectors, peerVectors)
    ));
    const { rankedEntries, safetyMode } = rankSelectionEntries(selectionEntries, entry => entry.validationSummary);
    rankedEntries.forEach(entry => {
      entry.safetyMode = safetyMode;
    });
    finalRankedEntries = rankedEntries;

    generationHistory.push({
      generation,
      stage,
      safetyMode,
      leaderName: rankedEntries[0]?.candidate?.name || 'Unknown',
      leaderParetoFront: rankedEntries[0]?.paretoRank || 0,
      leaderCrowdingDistance: roundTo(rankedEntries[0]?.crowdingDistance || 0, 4),
      leaderChampionScore: rankedEntries[0]?.championScore || 0,
      trainWinShare: rankedEntries[0]?.trainSummary?.winShare || 0,
      validationWinShare: rankedEntries[0]?.validationSummary?.winShare || 0,
      validationEmpireFallRate: rankedEntries[0]?.validationSummary?.empireFallRate || 0,
      validationGuardRate: rankedEntries[0]?.validationSummary?.guardRate || 0,
      validationFinalScoreMean: rankedEntries[0]?.validationSummary?.finalScoreMean || 0,
      validationFinalScoreAdvantage: rankedEntries[0]?.validationSummary?.finalScoreAdvantage || 0,
      leaderNovelty: rankedEntries[0]?.noveltyScore || 0,
      averageValidationWinShare: roundTo(average(rankedEntries.map(entry => entry.validationSummary.winShare)), 4),
      averageValidationFallRate: roundTo(average(rankedEntries.map(entry => entry.validationSummary.empireFallRate)), 4),
      hallOfFameSize: hallOfFame.length,
    });

    const hofAdditions = rankedEntries.slice(0, Math.min(2, rankedEntries.length));
    hofAdditions.forEach((entry, index) => hallOfFame.push(createHallOfFameEntry(entry, generation, index)));
    hallOfFame.sort((left, right) => right.winShare - left.winShare);
    while (hallOfFame.length > config.hallOfFameSize) hallOfFame.pop();

    if (generation === config.generations) break;

    const eliteCount = Math.max(2, Math.ceil(config.populationSize * config.eliteFraction));
    const freshCount = Math.max(1, Math.round(config.populationSize * config.freshBloodRate));
    const mutationScale = computeAdaptiveMutationScale(generation, config.generations, average(rankedEntries.map(entry => entry.noveltyScore)));
    const nextPopulation = rankedEntries
      .slice(0, eliteCount)
      .map((entry, index) => cloneCandidate(entry.candidate, generation + 1, `elite${index}`));

    for (let index = 0; index < freshCount && nextPopulation.length < config.populationSize; index++) {
      nextPopulation.push(createNeutralCandidate(rng, (generation * 1000) + index));
    }

    while (nextPopulation.length < config.populationSize) {
      const parentA = tournamentSelect(rankedEntries, rng)?.candidate || rankedEntries[0].candidate;
      const parentB = tournamentSelect(rankedEntries, rng)?.candidate || rankedEntries[0].candidate;
      const child = rng() < 0.6
        ? crossoverCandidates(parentA, parentB, rng, generation + 1, nextPopulation.length, mutationScale)
        : mutateCandidate(parentA, rng, generation + 1, nextPopulation.length, mutationScale);
      nextPopulation.push(child);
    }

    population = shuffle(nextPopulation, rng);
  }

  const finalistCount = getHoldoutFinalistCount(config);
  const finalists = finalRankedEntries.slice(0, finalistCount);
  const holdoutWorkerCount = getRecommendedParallelWorkerCount(config, finalists.length);
  let holdoutEvaluated = 0;
  const partialHoldoutEntries = [];
  const holdoutEntries = await evaluateHoldoutPopulation({
    finalists,
    holdoutSuite,
    config,
    generation: config.generations,
    population,
    hallOfFame,
    workerCount: holdoutWorkerCount,
    onEntry: (entry) => {
      partialHoldoutEntries.push(entry);
      holdoutEvaluated++;
      completedMatches += entry.holdoutSummary.matches;
      const partialRank = rankSelectionEntries(partialHoldoutEntries, item => item.holdoutSummary || item.validationSummary);
      const partialLeader = partialRank.rankedEntries[0];
      onProgress?.({
        mode: 'training',
        generation: config.generations,
        generations: config.generations,
        completed: completedMatches,
        total: totalMatches,
        matchesThisGeneration: finalists.length,
        currentMatch: holdoutEvaluated,
        leaderName: partialLeader?.candidate?.name || 'Holdout',
        leaderFitness: partialLeader?.championScore || 0,
        stage: 'holdout',
        hallOfFameSize: hallOfFame.length,
      });
    },
  });

  const { rankedEntries: finalChampions, safetyMode: finalSafetyMode } = rankSelectionEntries(holdoutEntries, entry => entry.holdoutSummary || entry.validationSummary);
  finalChampions.forEach(entry => {
    entry.safetyMode = finalSafetyMode;
  });
  const noveltyScores = finalChampions.map(entry => entry.noveltyScore).slice().sort((left, right) => left - right);
  const champions = finalChampions.slice(0, config.champions).map((entry, index) => {
    const lowerCount = noveltyScores.filter(score => score <= entry.noveltyScore).length;
    const noveltyPercentile = roundTo(lowerCount / Math.max(1, noveltyScores.length), 4);
    return materializeChampion(entry, index + 1, config, noveltyPercentile);
  });

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
      parallelWorkers: Math.max(generationWorkerCount, holdoutWorkerCount),
      scenarioMode: config.scenarioMode,
      playerCounts: config.playerCounts,
      deckSizes: config.deckSizes,
      selectionMethod: 'survival-gated-pareto',
      safetyMode: finalSafetyMode,
      bestFitness: finalChampions[0]?.championScore || 0,
      bestFinalScore: finalChampions[0]?.holdoutSummary?.finalScoreMean || 0,
      bestAverageWealth: finalChampions[0]?.holdoutSummary?.averageWealth || 0,
      bestFinalScoreAdvantage: finalChampions[0]?.holdoutSummary?.finalScoreAdvantage || 0,
      bestSurvivingFinalScore: finalChampions[0]?.holdoutSummary?.survivingFinalScoreMean || 0,
      bestEmpireFallRate: finalChampions[0]?.holdoutSummary?.empireFallRate || 0,
      bestRobustnessVariance: finalChampions[0]?.holdoutSummary?.opponentVariance || 0,
      bestHoldoutWinShare: finalChampions[0]?.holdoutSummary?.winShare || 0,
      bestGuardRate: finalChampions[0]?.holdoutSummary?.guardRate || 0,
      bestUnsafeRate: finalChampions[0]?.holdoutSummary?.unsafeRate || 0,
    },
    generationHistory,
    champions,
    hallOfFame: hallOfFame.map(entry => entry.profile),
  };
}
