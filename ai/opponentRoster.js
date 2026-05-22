export const DEFAULT_FALLBACK_OPPONENT_ID = 'strategic-default';
export const TUNED_OPPONENT_ROSTER_URL = './ai/tunedOpponents.json';

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
]);

function fallbackForSeat(seatId = 0) {
  const index = Math.max(0, Math.floor(Number(seatId) || 0)) % FALLBACK_AI_OPPONENTS.length;
  return FALLBACK_AI_OPPONENTS[index] || FALLBACK_AI_OPPONENTS[0];
}

function normalizeTunedOpponent(entry, index = 0) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || `tuned-${index + 1}`).trim();
  const firstName = String(entry.firstName || entry.name || '').trim();
  if (!id || !firstName) return null;
  const strategyWeights = entry.strategyWeights || entry.policy?.strategyWeights || entry.weights || {};
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

export function loadOpponentByIdSync(id = DEFAULT_FALLBACK_OPPONENT_ID, seatId = 0) {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) return FALLBACK_AI_OPPONENTS[0];
  return FALLBACK_AI_OPPONENTS.find((entry) => entry.id === normalizedId) || fallbackForSeat(seatId);
}

export function opponentFirstName(opponent, fallback = 'AI') {
  return String(opponent?.firstName || opponent?.name || fallback).trim() || fallback;
}
