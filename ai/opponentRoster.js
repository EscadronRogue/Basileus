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

function normalizeTunedOpponent(entry, index = 0) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || `tuned-${index + 1}`).trim();
  const firstName = String(entry.firstName || entry.name || '').trim();
  if (!id || !firstName) return null;
  const strategyWeights = { ...(entry.strategyWeights || entry.policy?.strategyWeights || entry.weights || {}) };
  return {
    id,
    firstName,
    personality: entry.personality ? String(entry.personality) : null,
    label: entry.label || 'Trained AI',
    description: entry.description || 'Saved trained strategy weights.',
    policy: {
      policyId: entry.policy?.policyId || entry.policyId || 'tuned',
      strategyWeights,
    },
    strategyWeights,
    metrics: entry.metrics || null,
    // How strong it proved against the rest of the roster (ai/rate.js), and
    // whether players are offered it: weak AIs stay for training only.
    rating: entry.rating || null,
    offered: entry.offered !== false,
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

// The trained AIs players meet: those rated strong enough. A roster rated
// before ratings existed offers every trained AI.
export function getOfferedAiOpponents(roster = []) {
  const tuned = getTunedAiOpponents(roster);
  const offered = tuned.filter((opponent) => opponent.offered !== false);
  return offered.length ? offered : tuned;
}

// The opponents a player picks from: the offered trained AIs when there are
// any, otherwise the built-in styles.
export function getSelectableAiOpponents(roster = []) {
  const offered = getOfferedAiOpponents(roster);
  return offered.length ? offered : (Array.isArray(roster) ? roster : []);
}

// "Leon, Usurper" for a trained AI with a personality, else its name.
export function describeAiOpponentChoice(opponent) {
  if (!opponent) return '';
  const name = opponent.firstName || opponent.id;
  return opponent.personality && opponent.label ? `${name}, ${opponent.label}` : name;
}

export function pickRandomTunedOpponent(roster = [], rng = Math.random) {
  const tuned = getOfferedAiOpponents(roster);
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
