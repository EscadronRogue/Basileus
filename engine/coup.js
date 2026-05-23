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

  const hasRawRanking = Array.isArray(rawRanking)
    ? rawRanking.length > 0
    : rawRanking && typeof rawRanking === 'object' && Object.keys(rawRanking).length > 0;

  if (hasRawRanking && Array.isArray(rawRanking)) {
    for (const candidateId of rawRanking) push(candidateId);
  } else if (hasRawRanking && rawRanking && typeof rawRanking === 'object') {
    for (const candidateId of Object.values(rawRanking)) push(candidateId);
  } else {
    push(playerId);
    if (preferredCandidateId != null) push(preferredCandidateId);
  }

  for (const candidateId of playerIds) push(candidateId);
  return ranking;
}

export function placeCoupCandidateAfterPlayer(state, playerId, rawRanking = null, candidateId = null) {
  const candidate = Number(candidateId);
  const ranking = normalizeCoupRanking(state, playerId, rawRanking);
  if (!Number.isInteger(candidate) || !ranking.includes(candidate) || candidate === playerId) return ranking;
  const nextRanking = ranking.filter((id) => id !== candidate);
  const playerIndex = nextRanking.indexOf(Number(playerId));
  const insertAt = playerIndex >= 0 ? playerIndex + 1 : 1;
  nextRanking.splice(insertAt, 0, candidate);
  return normalizeCoupRanking(state, playerId, nextRanking);
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

export function normalizeCoupSupport(state, rawSupport = null, requiredCandidateId = null) {
  const support = {};
  for (const candidateId of validPlayerIds(state)) support[candidateId] = true;

  if (rawSupport && typeof rawSupport === 'object') {
    for (const [key, value] of Object.entries(rawSupport)) {
      const candidateId = Number(key);
      if (!Number.isInteger(candidateId) || !Object.prototype.hasOwnProperty.call(support, candidateId)) continue;
      support[candidateId] = value !== false && value !== 'false' && value !== 0 && value !== '0';
    }
  }

  if (requiredCandidateId != null) {
    const required = Number(requiredCandidateId);
    if (Number.isInteger(required) && Object.prototype.hasOwnProperty.call(support, required)) {
      support[required] = true;
    }
  }
  return support;
}

export function isCoupCandidateSupported(state, orders = {}, candidateId) {
  const support = normalizeCoupSupport(state, orders?.candidateSupport);
  return support[Number(candidateId)] !== false;
}

export function getPreferredCoupCandidate(state, playerId, orders = {}) {
  const ranking = normalizeCoupRanking(state, playerId, orders?.ranking, orders?.candidate);
  const support = normalizeCoupSupport(state, orders?.candidateSupport);
  return ranking.find((candidateId) => candidateId !== playerId && support[candidateId] !== false)
    ?? ranking.find((candidateId) => support[candidateId] !== false)
    ?? playerId;
}
