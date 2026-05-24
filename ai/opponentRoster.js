export const DEFAULT_FALLBACK_OPPONENT_ID = 'strategic-default';
export const TUNED_OPPONENT_ROSTER_URL = './ai/tunedOpponents.json';
export const RANDOM_TUNED_OPPONENT_ID = '__random-trained-opponent__';

export const FALLBACK_AI_OPPONENTS = Object.freeze([
  {
    id: DEFAULT_FALLBACK_OPPONENT_ID,
    firstName: 'Strategic AI',
    label: 'Strategic AI',
    description: 'Balanced phase-aware planner.',
    policy: { policyId: 'strategic' },
  },
  {
    id: 'defender-default',
    firstName: 'Defender AI',
    label: 'Defender AI',
    description: 'Prioritizes frontier survival and empire stability.',
    policy: { policyId: 'defender' },
  },
  {
    id: 'usurper-default',
    firstName: 'Usurper AI',
    label: 'Usurper AI',
    description: 'Looks harder for throne-taking windows.',
    policy: { policyId: 'usurper' },
  },
  {
    id: 'profiteer-default',
    firstName: 'Profiteer AI',
    label: 'Profiteer AI',
    description: 'Leans toward estates, gold, and income-share plays.',
    policy: { policyId: 'profiteer' },
  },
  {
    id: 'patron-default',
    firstName: 'Patron AI',
    label: 'Patron AI',
    description: 'Seeks the throne and rewards useful backers with real power.',
    policy: { policyId: 'patron' },
  },
  {
    id: 'tyrant-default',
    firstName: 'Tyrant AI',
    label: 'Tyrant AI',
    description: 'Seeks the throne, centralizes power, and revokes aggressively.',
    policy: { policyId: 'tyrant' },
  },
  {
    id: 'kingmaker-default',
    firstName: 'Kingmaker AI',
    label: 'Kingmaker AI',
    description: 'Backs promising claimants instead of chasing every crown itself.',
    policy: { policyId: 'kingmaker' },
  },
  {
    id: 'free-rider-default',
    firstName: 'Free Rider AI',
    label: 'Free Rider AI',
    description: 'Trusts others to defend while it keeps resources for politics.',
    policy: { policyId: 'freeRider' },
  },
  {
    id: 'over-defender-default',
    firstName: 'Over-Defender AI',
    label: 'Over-Defender AI',
    description: 'Overcommits to the frontier and leaves political openings.',
    policy: { policyId: 'overDefender' },
  },
  {
    id: 'estate-shark-default',
    firstName: 'Estate Shark AI',
    label: 'Estate Shark AI',
    description: 'Turns estates and offices into sharp victory pressure.',
    policy: { policyId: 'estateShark' },
  },
  {
    id: 'anti-leader-default',
    firstName: 'Anti-Leader AI',
    label: 'Anti-Leader AI',
    description: 'Targets the score leader and avoids easy kingmaking.',
    policy: { policyId: 'antiLeader' },
  },
]);

function fallbackForSeat(seatId = 0) {
  const index = Math.max(0, Math.floor(Number(seatId) || 0)) % FALLBACK_AI_OPPONENTS.length;
  return FALLBACK_AI_OPPONENTS[index] || FALLBACK_AI_OPPONENTS[0];
}

function migrateLegacyTunedWeights(entry, weights) {
  if ((Number(entry?.training?.objectiveVersion) || 0) >= 2) return weights;
  if ((entry?.policy?.policyId || entry?.policyId || 'tuned') !== 'tuned') return weights;
  return {
    ...weights,
    invasionMargin: Math.min(Number(weights.invasionMargin) || 0.82, 1.35),
    capitalFallPenalty: Math.min(Number(weights.capitalFallPenalty) || 520, 520),
    capitalRiskPenalty: Math.min(Number(weights.capitalRiskPenalty) || 160, 160),
    throneBase: Math.max(Number(weights.throneBase) || 0, 24),
    selfClaim: Math.max(Number(weights.selfClaim) || 0, 0.85),
    incumbentDefense: Math.min(Number(weights.incumbentDefense) || 0.8, 1.1),
    supportLeaderPenalty: Math.min(Number(weights.supportLeaderPenalty) || 0.9, 1.05),
    supportOtherClaimant: Math.max(Number(weights.supportOtherClaimant) || 0, 0.55),
    coalitionWillingness: Math.max(Number(weights.coalitionWillingness) || 0, 0.85),
    relationshipCoupWeight: Math.max(Number(weights.relationshipCoupWeight) || 0, 0.7),
    surplusDefensePenalty: Math.max(Number(weights.surplusDefensePenalty) || 0, 0.28),
    frontierSurplusValue: Math.min(Number(weights.frontierSurplusValue) || 0.35, 0.35),
    frontierSurplusCap: Math.min(Number(weights.frontierSurplusCap) || 7, 7),
    coupOpportunityWeight: Math.max(Number(weights.coupOpportunityWeight) || 0, 0.65),
    selfClaimThreshold: Math.min(Number(weights.selfClaimThreshold) || 0.95, 1),
  };
}

function migrateDangerBandTunedWeights(entry, weights) {
  if ((Number(entry?.training?.objectiveVersion) || 0) >= 3) return weights;
  if ((entry?.policy?.policyId || entry?.policyId || 'tuned') !== 'tuned') return weights;
  return {
    ...weights,
    invasionMargin: Math.min(Number(weights.invasionMargin) || 1.65, 1.65),
    capitalFallPenalty: Math.min(Number(weights.capitalFallPenalty) || 680, 680),
    capitalRiskPenalty: Math.min(Number(weights.capitalRiskPenalty) || 230, 230),
    invasionDefeatPenalty: Math.min(Number(weights.invasionDefeatPenalty) || 10, 14),
    selfClaim: Math.max(Number(weights.selfClaim) || 0, 0.9),
    incumbentDefense: Math.min(Number(weights.incumbentDefense) || 0.85, 1.1),
    supportOtherClaimant: Math.max(Number(weights.supportOtherClaimant) || 0, 0.5),
    reserveValue: Math.max(Number(weights.reserveValue) || 0, 0.48),
    surplusDefensePenalty: Math.max(Number(weights.surplusDefensePenalty) || 0, 0.28),
    frontierSurplusValue: Math.min(Number(weights.frontierSurplusValue) || 0.5, 0.5),
    frontierSurplusCap: Math.min(Number(weights.frontierSurplusCap) || 12, 12),
    coupOpportunityWeight: Math.max(Number(weights.coupOpportunityWeight) || 0, 0.42),
    selfClaimThreshold: Math.min(Number(weights.selfClaimThreshold) || 0.98, 1.05),
  };
}

function withoutDeprecatedTrainingWeights(weights) {
  const migrated = { ...weights };
  delete migrated.invasionMargin;
  delete migrated.invasionVictoryBonus;
  delete migrated.invasionDefeatPenalty;
  delete migrated.throneProgress;
  delete migrated.coalitionWillingness;
  delete migrated.coalitionDefectionPenalty;
  delete migrated.surplusDefensePenalty;
  delete migrated.frontierSurplusValue;
  delete migrated.frontierSurplusCap;
  delete migrated.selfClaimThreshold;
  return migrated;
}

function migratePatronageTunedWeights(entry, weights) {
  if ((entry?.policy?.policyId || entry?.policyId || 'tuned') !== 'tuned') return weights;
  const objectiveVersion = Number(entry?.training?.objectiveVersion) || 0;
  if (objectiveVersion >= 4) return withoutDeprecatedTrainingWeights(weights);
  const legacyMargin = Number(weights.invasionMargin) || 1.65;
  const legacySurplusPenalty = Number(weights.surplusDefensePenalty) || 0.28;
  const legacySafetyValue = Number(weights.frontierSurplusValue) || 0.5;
  return {
    ...withoutDeprecatedTrainingWeights(weights),
    invasionShortfallPenalty: Math.max(1, Math.min(12, legacyMargin * 3.1)),
    invasionSafetyValue: Math.max(0, Math.min(4, legacySafetyValue * 2.4)),
    invasionSurplusPenalty: Math.max(0.05, Math.min(3, legacySurplusPenalty)),
    basileusTitleExpectation: Number(weights.basileusTitleExpectation) || 0.7,
    basileusRevocationFear: Number(weights.basileusRevocationFear) || 0.8,
    backerTitleReward: Number(weights.backerTitleReward) || 0.9,
    backerRevocationMercy: Number(weights.backerRevocationMercy) || 0.9,
  };
}

function migrateReserveConversionTunedWeights(entry, weights) {
  if ((entry?.policy?.policyId || entry?.policyId || 'tuned') !== 'tuned') return weights;
  const objectiveVersion = Number(entry?.training?.objectiveVersion) || 0;
  if (objectiveVersion >= 7) return weights;
  return {
    ...weights,
    invasionShortfallPenalty: Math.max(Number(weights.invasionShortfallPenalty) || 0, 4.2),
    capitalRiskPenalty: Math.max(Number(weights.capitalRiskPenalty) || 0, 120),
    reserveValue: Math.max(Number(weights.reserveValue) || 0, 0.35),
    mercenaryCostPenalty: Math.min(Number(weights.mercenaryCostPenalty) || 0.12, 0.32),
  };
}

function normalizeTunedOpponent(entry, index = 0) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || `tuned-${index + 1}`).trim();
  const firstName = String(entry.firstName || entry.name || '').trim();
  if (!id || !firstName) return null;
  const legacyWeights = migrateLegacyTunedWeights(
    entry,
    entry.strategyWeights || entry.policy?.strategyWeights || entry.weights || {},
  );
  const dangerBandWeights = migrateDangerBandTunedWeights(entry, legacyWeights);
  const patronageWeights = migratePatronageTunedWeights(entry, dangerBandWeights);
  const strategyWeights = migrateReserveConversionTunedWeights(entry, patronageWeights);
  return {
    id,
    firstName,
    label: entry.label || 'Tuned AI',
    description: entry.description || 'Saved tuned strategy weights.',
    policy: {
      policyId: entry.policy?.policyId || entry.policyId || 'tuned',
      strategyWeights,
    },
    strategyWeights,
    metrics: entry.metrics || null,
    source: 'tuned',
  };
}

export function normalizeTunedOpponentRoster(payload) {
  const entries = Array.isArray(payload) ? payload : payload?.opponents;
  if (!Array.isArray(entries)) return [];
  return entries.map(normalizeTunedOpponent).filter(Boolean);
}

export function loadOpponentRosterSync() {
  return FALLBACK_AI_OPPONENTS.map((entry) => ({
    ...entry,
    source: 'built-in',
  }));
}

export function mergeOpponentRosters(tunedOpponents = [], fallbackOpponents = loadOpponentRosterSync()) {
  const seen = new Set();
  const merged = [];
  for (const entry of [...tunedOpponents, ...fallbackOpponents]) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

export function getTunedAiOpponents(roster = []) {
  return (Array.isArray(roster) ? roster : []).filter((opponent) => (
    opponent?.source === 'tuned'
    || opponent?.policy?.policyId === 'tuned'
    || opponent?.policyId === 'tuned'
  ));
}

export function pickRandomTunedOpponent(roster = [], rng = Math.random) {
  const tuned = getTunedAiOpponents(roster);
  if (!tuned.length) return null;
  const random = typeof rng === 'function' ? rng : Math.random;
  const index = Math.floor(random() * tuned.length);
  return tuned[Math.max(0, Math.min(tuned.length - 1, index))] || tuned[0] || null;
}

export function loadOpponentByIdSync(id = DEFAULT_FALLBACK_OPPONENT_ID, seatId = 0) {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) return FALLBACK_AI_OPPONENTS[0];
  return FALLBACK_AI_OPPONENTS.find((entry) => entry.id === normalizedId) || fallbackForSeat(seatId);
}

export function opponentFirstName(opponent, fallback = 'AI') {
  return String(opponent?.firstName || opponent?.name || fallback).trim() || fallback;
}
