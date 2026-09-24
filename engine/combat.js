// engine/combat.js - invasion resolution and occupation effects.

export function resolveInvasion(state, frontierTroops, invaderStrength, invasion) {
  const F = frontierTroops;
  const S = invaderStrength;
  const route = invasion.route;
  const initiallyLost = new Set(
    Object.values(state.themes)
      .filter((theme) => theme.lost)
      .map((theme) => theme.id),
  );
  const result = {
    outcome: F > S ? 'victory' : F < S ? 'defeat' : 'stalemate',
    frontierTroops: F,
    invaderStrength: S,
    themesLost: [],
    themesRecovered: [],
    reconquestRewardProvinceCount: 0,
    reachedCPL: false,
    advancePath: [],
  };

  if (F === S) return result;

  if (F < S) {
    let remaining = S - F;
    let captureCost = 1;
    const projectedLost = new Set(initiallyLost);
    for (const themeId of route) {
      if (themeId === 'CPL') {
        if (remaining < captureCost) break;
        remaining -= captureCost;
        result.reachedCPL = true;
        result.advancePath.push('CPL');
        break;
      }
      const theme = state.themes[themeId];
      if (!theme) continue;
      if (projectedLost.has(themeId)) {
        result.advancePath.push(themeId);
        continue;
      }
      if (remaining < captureCost) break;
      remaining -= captureCost;
      captureCost += 1;
      projectedLost.add(themeId);
      result.themesLost.push(themeId);
      result.advancePath.push(themeId);
    }
    return result;
  }

  let surplus = F - S;
  let recoverCost = 1;
  const reverseRoute = route.slice().reverse().filter((themeId) => themeId !== 'CPL');
  result.reconquestRewardProvinceCount = countAffordableProvinceWins(state, surplus, reverseRoute);
  const projectedRecovered = new Set(initiallyLost);
  for (const themeId of reverseRoute) {
    if (surplus < recoverCost) break;
    const theme = state.themes[themeId];
    if (!theme || !projectedRecovered.has(themeId)) continue;
    surplus -= recoverCost;
    recoverCost += 1;
    projectedRecovered.delete(themeId);
    result.advancePath.push(themeId);
    result.themesRecovered.push(themeId);
  }
  return result;
}

function countAffordableProvinceWins(state, surplus, reverseRoute) {
  let wins = 0;
  let nextCost = 1;
  for (const themeId of reverseRoute) {
    if (!state.themes[themeId]) continue;
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
    state.gameOver = { type: 'fall', message: 'Constantinople has fallen. The Empire is no more. No dynasty wins.' };
  }
}
