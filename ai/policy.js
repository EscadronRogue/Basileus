import {
  buildCandidateFeatures,
  FEATURE_SCHEMA,
  FEATURE_UNIT,
  OFFICIAL_MAX_SCORE,
} from './features.js';

export const EVOLVING_POLICY_SCHEMA = 'basileus.evolving-policy.v1';

export const PERSONALITY_PROFILES = Object.freeze([
  {
    id: 'steward',
    label: 'Steward',
    focusCategory: null,
    description: 'Balances the official scoring categories while keeping the empire alive.',
  },
  {
    id: 'magnate',
    label: 'Magnate',
    focusCategory: 'estate',
    description: 'Learns from estate-income pressure while still sharing the universal win objective.',
  },
  {
    id: 'treasurer',
    label: 'Treasurer',
    focusCategory: 'gold',
    description: 'Learns from gold-reserve pressure while still sharing the universal win objective.',
  },
  {
    id: 'tax_farmer',
    label: 'Tax Farmer',
    focusCategory: 'tax',
    description: 'Learns from tax-income pressure while still sharing the universal win objective.',
  },
  {
    id: 'patriarchal',
    label: 'Patriarchal',
    focusCategory: 'church',
    description: 'Learns from church-income pressure while still sharing the universal win objective.',
  },
]);

export const DEFAULT_PERSONALITY_ID = PERSONALITY_PROFILES[0].id;

const PROFILE_BY_ID = new Map(PERSONALITY_PROFILES.map((profile) => [profile.id, profile]));

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function defaultLearningRate() {
  return FEATURE_UNIT / Math.max(FEATURE_UNIT, OFFICIAL_MAX_SCORE);
}

function normalizePersonalityId(policy, personalityId) {
  if (personalityId && policy?.personalities?.[personalityId]) return personalityId;
  return DEFAULT_PERSONALITY_ID;
}

export function personalityForSeat(playerId) {
  const index = Math.abs(Math.floor(finiteNumber(playerId))) % PERSONALITY_PROFILES.length;
  return PERSONALITY_PROFILES[index].id;
}

function createPersonalityEntry(profile) {
  return {
    id: profile.id,
    label: profile.label,
    focusCategory: profile.focusCategory,
    description: profile.description,
    weights: {},
    observations: 0,
  };
}

export function createLearningPolicy(options = {}) {
  const profiles = Array.isArray(options.personalities) && options.personalities.length
    ? options.personalities
    : PERSONALITY_PROFILES;
  return {
    schema: EVOLVING_POLICY_SCHEMA,
    version: 1,
    featureSchema: FEATURE_SCHEMA,
    step: 0,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    sharedWeights: {},
    personalities: Object.fromEntries(profiles.map((profile) => [
      profile.id,
      createPersonalityEntry(PROFILE_BY_ID.get(profile.id) || profile),
    ])),
  };
}

function normalizeWeightMap(raw = {}) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const number = Number(value);
    if (Number.isFinite(number) && number !== 0) out[key] = number;
  }
  return out;
}

export function hydrateLearningPolicy(rawPolicy) {
  if (!rawPolicy) return null;
  const raw = rawPolicy.policy || rawPolicy;
  if (raw.schema && raw.schema !== EVOLVING_POLICY_SCHEMA) {
    throw new Error(`Invalid AI policy schema: ${raw.schema}.`);
  }
  const policy = createLearningPolicy();
  policy.step = Math.max(0, Math.floor(finiteNumber(raw.step)));
  policy.createdAt = raw.createdAt || policy.createdAt;
  policy.updatedAt = raw.updatedAt || null;
  policy.sharedWeights = normalizeWeightMap(raw.sharedWeights || raw.weights);
  for (const profile of PERSONALITY_PROFILES) {
    const incoming = raw.personalities?.[profile.id] || {};
    policy.personalities[profile.id] = {
      ...createPersonalityEntry(profile),
      ...incoming,
      id: profile.id,
      label: incoming.label || profile.label,
      focusCategory: Object.prototype.hasOwnProperty.call(incoming, 'focusCategory')
        ? incoming.focusCategory
        : profile.focusCategory,
      description: incoming.description || profile.description,
      observations: Math.max(0, Math.floor(finiteNumber(incoming.observations))),
      weights: normalizeWeightMap(incoming.weights),
    };
  }
  return policy;
}

export function serializeLearningPolicy(policy) {
  const hydrated = hydrateLearningPolicy(policy) || createLearningPolicy();
  return {
    schema: EVOLVING_POLICY_SCHEMA,
    version: hydrated.version || 1,
    featureSchema: hydrated.featureSchema || FEATURE_SCHEMA,
    step: hydrated.step || 0,
    createdAt: hydrated.createdAt || null,
    updatedAt: hydrated.updatedAt || null,
    sharedWeights: normalizeWeightMap(hydrated.sharedWeights),
    personalities: Object.fromEntries(PERSONALITY_PROFILES.map((profile) => {
      const entry = hydrated.personalities?.[profile.id] || createPersonalityEntry(profile);
      return [profile.id, {
        id: profile.id,
        label: entry.label || profile.label,
        focusCategory: Object.prototype.hasOwnProperty.call(entry, 'focusCategory')
          ? entry.focusCategory
          : profile.focusCategory,
        description: entry.description || profile.description,
        observations: Math.max(0, Math.floor(finiteNumber(entry.observations))),
        weights: normalizeWeightMap(entry.weights),
      }];
    })),
  };
}

export function cloneLearningPolicy(policy) {
  return hydrateLearningPolicy(serializeLearningPolicy(policy));
}

function combinedWeight(policy, personalityId, featureName) {
  const personality = policy.personalities?.[normalizePersonalityId(policy, personalityId)];
  return finiteNumber(policy.sharedWeights?.[featureName])
    + finiteNumber(personality?.weights?.[featureName]);
}

export function scoreFeatureMap(policy, features, personalityId = DEFAULT_PERSONALITY_ID) {
  const hydrated = hydrateLearningPolicy(policy) || createLearningPolicy();
  let score = 0;
  for (const [featureName, value] of Object.entries(features || {})) {
    score += finiteNumber(value) * combinedWeight(hydrated, personalityId, featureName);
  }
  return score;
}

function softmax(scores, temperature = FEATURE_UNIT) {
  const safeTemperature = Math.max(Number.EPSILON, finiteNumber(temperature, FEATURE_UNIT));
  const max = Math.max(...scores);
  const exp = scores.map((score) => Math.exp((score - max) / safeTemperature));
  const total = exp.reduce((sum, value) => sum + value, 0) || FEATURE_UNIT;
  return exp.map((value) => value / total);
}

function chooseGreedy(scores, rng = Math.random) {
  let bestScore = -Infinity;
  const bestIndexes = [];
  for (let index = 0; index < scores.length; index += 1) {
    const score = scores[index];
    if (score > bestScore) {
      bestScore = score;
      bestIndexes.length = 0;
      bestIndexes.push(index);
    } else if (score === bestScore) {
      bestIndexes.push(index);
    }
  }
  if (!bestIndexes.length) return 0;
  return bestIndexes[Math.floor(rng() * bestIndexes.length)];
}

function chooseWeighted(probabilities, rng = Math.random) {
  const roll = rng();
  let cumulative = 0;
  for (let index = 0; index < probabilities.length; index += 1) {
    cumulative += probabilities[index];
    if (roll <= cumulative) return index;
  }
  return probabilities.length - 1;
}

export function evaluateCandidateFeatures(policy, featureMaps, personalityId = DEFAULT_PERSONALITY_ID, options = {}) {
  const hydrated = hydrateLearningPolicy(policy) || createLearningPolicy();
  const normalizedPersonalityId = normalizePersonalityId(hydrated, personalityId);
  const scores = featureMaps.map((features) => scoreFeatureMap(hydrated, features, normalizedPersonalityId));
  const probabilities = softmax(scores, options.temperature ?? FEATURE_UNIT);
  return {
    scores,
    probabilities,
    personalityId: normalizedPersonalityId,
  };
}

export function selectActionWithPolicy(policy, featureMaps, rng = Math.random, options = {}) {
  if (!featureMaps.length) return { index: -1, score: 0, probabilities: [] };
  const evaluation = evaluateCandidateFeatures(policy, featureMaps, options.personalityId, options);
  const index = options.greedy
    ? chooseGreedy(evaluation.scores, rng)
    : chooseWeighted(evaluation.probabilities, rng);
  return {
    ...evaluation,
    index,
    score: evaluation.scores[index] || 0,
  };
}

function featureUnion(featureMaps = []) {
  return [...new Set(featureMaps.flatMap((features) => Object.keys(features || {})))];
}

function expectedFeatureValue(featureMaps, probabilities, featureName) {
  let total = 0;
  for (let index = 0; index < featureMaps.length; index += 1) {
    total += finiteNumber(featureMaps[index]?.[featureName]) * finiteNumber(probabilities[index]);
  }
  return total;
}

function updateWeights(weights, featureName, delta) {
  const next = finiteNumber(weights[featureName]) + delta;
  if (Math.abs(next) <= Number.EPSILON) delete weights[featureName];
  else weights[featureName] = next;
}

export function trainFeatureBatch(policy, transitions, options = {}) {
  const hydrated = hydrateLearningPolicy(policy) || createLearningPolicy();
  const usable = transitions.filter((entry) => (
    Array.isArray(entry?.features)
    && entry.features.length
    && Number.isInteger(entry.chosenIndex)
    && entry.chosenIndex >= 0
    && entry.chosenIndex < entry.features.length
  ));
  if (!usable.length) {
    return { loss: 0, policyLoss: 0, valueLoss: 0, count: 0, averageReturn: 0 };
  }

  const learningRate = Math.max(0, finiteNumber(options.learningRate, defaultLearningRate()));
  const temperature = options.temperature ?? FEATURE_UNIT;
  let policyLoss = 0;
  let returnSum = 0;

  for (const transition of usable) {
    const personalityId = normalizePersonalityId(hydrated, transition.personalityId);
    const evaluation = evaluateCandidateFeatures(hydrated, transition.features, personalityId, { temperature });
    const chosen = transition.chosenIndex;
    const chosenFeatures = transition.features[chosen] || {};
    const actionReturn = finiteNumber(transition.return);
    const personalityReturn = finiteNumber(transition.personalityReturn, actionReturn);
    const names = featureUnion(transition.features);
    const personality = hydrated.personalities[personalityId];

    for (const featureName of names) {
      const expected = expectedFeatureValue(transition.features, evaluation.probabilities, featureName);
      const chosenValue = finiteNumber(chosenFeatures[featureName]);
      const advantageSignal = chosenValue - expected;
      updateWeights(hydrated.sharedWeights, featureName, learningRate * actionReturn * advantageSignal);
      updateWeights(personality.weights, featureName, learningRate * personalityReturn * advantageSignal);
    }

    personality.observations += FEATURE_UNIT;
    policyLoss += -Math.log(Math.max(Number.EPSILON, evaluation.probabilities[chosen] || Number.EPSILON)) * Math.abs(actionReturn);
    returnSum += actionReturn;
  }

  hydrated.step += usable.length;
  hydrated.updatedAt = new Date().toISOString();

  Object.assign(policy, hydrated);
  return {
    loss: policyLoss / usable.length,
    policyLoss: policyLoss / usable.length,
    valueLoss: 0,
    count: usable.length,
    averageReturn: returnSum / usable.length,
  };
}

export function choosePolicyActionIndex(policy, state, playerId, actions, rng = Math.random, options = {}) {
  const features = buildCandidateFeatures(state, playerId, actions);
  return selectActionWithPolicy(policy, features, rng, options).index;
}
