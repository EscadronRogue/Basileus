export function getCoupRankWeight(playerCount, rankIndex) {
  const count = Math.max(1, Number(playerCount) || 1);
  const index = Math.max(0, Number(rankIndex) || 0);
  if (count <= 1) return 1;
  return Math.max(0, 1 - (index / (count - 1)));
}

function validPlayerIds(state) {
  return (state?.players || []).map((player) => player.id);
}

export function normalizeCoupRanking(state, playerId, rawRanking = null, preferredCandidateId = null) {
  const playerIds = validPlayerIds(state);
  const validIds = new Set(playerIds);
  const ranking = [];
  const push = (value) => {
    const id = Number(value);
    if (!Number.isInteger(id) || !validIds.has(id) || ranking.includes(id)) return;
    ranking.push(id);
  };

  push(playerId);
  if (preferredCandidateId != null) push(preferredCandidateId);

  if (Array.isArray(rawRanking)) {
    for (const candidateId of rawRanking) push(candidateId);
  } else if (rawRanking && typeof rawRanking === 'object') {
    for (const candidateId of Object.values(rawRanking)) push(candidateId);
  }

  for (const candidateId of playerIds) push(candidateId);
  return ranking;
}

export function buildDefaultCoupRanking(state, playerId, preferredCandidateId = null) {
  return normalizeCoupRanking(state, playerId, null, preferredCandidateId);
}

export function isCompleteCoupRanking(state, ranking) {
  const playerIds = validPlayerIds(state);
  if (!Array.isArray(ranking) || ranking.length !== playerIds.length) return false;
  const validIds = new Set(playerIds);
  const seen = new Set();
  for (const candidateId of ranking) {
    const id = Number(candidateId);
    if (!Number.isInteger(id) || !validIds.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

export function getPreferredCoupCandidate(state, playerId, orders = {}) {
  const ranking = normalizeCoupRanking(state, playerId, orders?.ranking, orders?.candidate);
  return ranking.find((candidateId) => candidateId !== playerId) ?? playerId;
}
