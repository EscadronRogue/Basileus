// engine/combat.js - the war against the invasion, and what it does to provinces.
//
// The invasion walks its route. Each imperial province costs it 1 more
// strength than the one before (1, 2, 3...); provinces already lost are
// crossed for free; Constantinople, at the end of a full route, costs the
// next step. The invader takes provinces while it beats the frontier by
// enough. When the frontier wins instead, its surplus retakes lost provinces
// on the route, walking back from Constantinople at the same rising cost.

function currentLostIds(state) {
  return new Set(
    Object.values(state?.themes || {})
      .filter((theme) => theme.lost)
      .map((theme) => theme.id),
  );
}

// [{ themeId, status: 'imperial' | 'lost' | 'capital', cost, needed }].
// `needed` is how far the invader must beat the frontier to take that step.
export function buildInvasionLadder(state, route = state?.currentInvasion?.route || [], lostIds = currentLostIds(state)) {
  const steps = [];
  let cost = 1;
  let needed = 0;
  for (const themeId of route || []) {
    if (!state?.themes?.[themeId]) continue;
    if (themeId === 'CPL') {
      needed += cost;
      steps.push({ themeId, status: 'capital', cost, needed });
      break;
    }
    if (lostIds.has(themeId)) {
      steps.push({ themeId, status: 'lost', cost: 0, needed });
      continue;
    }
    needed += cost;
    steps.push({ themeId, status: 'imperial', cost, needed });
    cost += 1;
  }
  return steps;
}

// [{ themeId, status: 'lost' | 'imperial', cost, needed }], walking back from
// Constantinople. `needed` is how far the frontier must beat the invader to
// retake that lost province.
export function buildReconquestLadder(state, route = state?.currentInvasion?.route || [], lostIds = currentLostIds(state)) {
  const steps = [];
  let cost = 1;
  let needed = 0;
  for (const themeId of (route || []).slice().reverse()) {
    if (themeId === 'CPL' || !state?.themes?.[themeId]) continue;
    if (!lostIds.has(themeId)) {
      steps.push({ themeId, status: 'imperial', cost: 0, needed });
      continue;
    }
    needed += cost;
    steps.push({ themeId, status: 'lost', cost, needed });
    cost += 1;
  }
  return steps;
}

export function resolveInvasion(state, frontierTroops, invaderStrength, invasion) {
  const F = frontierTroops;
  const S = invaderStrength;
  const route = invasion.route;
  const lostIds = currentLostIds(state);
  const result = {
    outcome: F > S ? 'victory' : F < S ? 'defeat' : 'stalemate',
    frontierTroops: F,
    invaderStrength: S,
    margin: Math.abs(F - S),
    themesLost: [],
    themesRecovered: [],
    reconquestRewardProvinceCount: 0,
    reachedCPL: false,
    advancePath: [],
    // Every step of the ladder that was fought over, with the strength spent
    // on it, and the strength left once the next step was out of reach.
    steps: [],
    spent: 0,
    leftover: 0,
  };

  if (F === S) return result;

  if (F < S) {
    const margin = S - F;
    for (const step of buildInvasionLadder(state, route, lostIds)) {
      if (step.status === 'lost') {
        result.steps.push({ ...step, outcome: 'crossed', spent: 0 });
        result.advancePath.push(step.themeId);
        continue;
      }
      if (step.needed > margin) {
        result.steps.push({ ...step, outcome: 'held', spent: 0 });
        break;
      }
      result.steps.push({ ...step, outcome: 'taken', spent: step.cost });
      result.spent += step.cost;
      result.advancePath.push(step.themeId);
      if (step.status === 'capital') result.reachedCPL = true;
      else result.themesLost.push(step.themeId);
    }
    result.leftover = margin - result.spent;
    return result;
  }

  const surplus = F - S;
  result.reconquestRewardProvinceCount = countAffordableProvinceWins(state, surplus, route);
  for (const step of buildReconquestLadder(state, route, lostIds)) {
    if (step.status === 'imperial') continue;
    if (step.needed > surplus) {
      result.steps.push({ ...step, outcome: 'out_of_reach', spent: 0 });
      break;
    }
    result.steps.push({ ...step, outcome: 'retaken', spent: step.cost });
    result.spent += step.cost;
    result.advancePath.push(step.themeId);
    result.themesRecovered.push(step.themeId);
  }
  result.leftover = surplus - result.spent;
  return result;
}

// How many provinces the surplus could win walking back along the route at
// the rising cost, whether or not they are lost: the best defender's Triumph.
function countAffordableProvinceWins(state, surplus, route) {
  let wins = 0;
  let nextCost = 1;
  for (const themeId of (route || []).slice().reverse()) {
    if (themeId === 'CPL' || !state.themes[themeId]) continue;
    if (surplus < nextCost) break;
    surplus -= nextCost;
    nextCost += 1;
    wins += 1;
  }
  return wins;
}

// A lost province keeps its estates, Strategos and Bishop on record, as if
// the administration in Constantinople still held the deeds. Estates and the
// Strategos stop working until the province is reconquered, when they return
// to their holders; the Bishop keeps being paid throughout.
export function applyInvasionResult(state, result) {
  for (const themeId of result.themesLost) {
    const theme = state.themes[themeId];
    if (theme) theme.lost = true;
  }

  for (const themeId of result.themesRecovered) {
    const theme = state.themes[themeId];
    if (theme) theme.lost = false;
  }

  if (result.reachedCPL) {
    state.gameOver = { type: 'fall', message: 'Constantinople has fallen. The empire is no more. No dynasty wins.' };
  }
}
