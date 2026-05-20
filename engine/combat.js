// engine/combat.js - invasion resolution and occupation effects.

export function resolveInvasion(state, frontierTroops, invaderStrength, invasion) {
  const F = frontierTroops;
  const S = invaderStrength;
  const route = invasion.route;
  const initiallyOccupied = new Set(
    Object.values(state.themes)
      .filter((theme) => theme.occupied)
      .map((theme) => theme.id),
  );
  const result = {
    outcome: F > S ? 'victory' : F < S ? 'defeat' : 'stalemate',
    frontierTroops: F,
    invaderStrength: S,
    themesLost: [],
    themesRecovered: [],
    reachedCPL: false,
    advancePath: [],
  };

  if (F === S) return result;

  if (F < S) {
    let remaining = S - F;
    let captureCost = 1;
    const projectedOccupied = new Set(initiallyOccupied);
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
      if (projectedOccupied.has(themeId)) {
        result.advancePath.push(themeId);
        continue;
      }
      if (remaining < captureCost) break;
      remaining -= captureCost;
      captureCost += 1;
      projectedOccupied.add(themeId);
      result.themesLost.push(themeId);
      result.advancePath.push(themeId);
    }
    return result;
  }

  let surplus = F - S;
  let recoverCost = 1;
  const reverseRoute = route.slice().reverse().filter((themeId) => themeId !== 'CPL');
  const projectedRecovered = new Set(initiallyOccupied);
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

function suspendOwnerOnLoss(theme) {
  if (theme.owner == null) return;
  theme.suspendedOwner = theme.owner;
  theme.owner = null;
}

export function applyInvasionResult(state, result) {
  for (const themeId of result.themesLost) {
    const theme = state.themes[themeId];
    if (!theme) continue;
    suspendOwnerOnLoss(theme);
    theme.occupied = true;
    theme.strategos = null;
    // Bishops remain seated. Occupied-province church income uses origin.C.
  }

  for (const themeId of result.themesRecovered) {
    const theme = state.themes[themeId];
    if (!theme) continue;
    theme.occupied = false;
    if (theme.suspendedOwner != null) {
      theme.owner = theme.suspendedOwner;
      if (theme.owner === 'church') {
        theme.P = 0;
        theme.T = 0;
        theme.C = (Number(theme.origin?.P) || 0) + (Number(theme.origin?.T) || 0) + (Number(theme.origin?.C) || 0);
      }
      theme.suspendedOwner = null;
    } else {
      theme.owner = null;
    }
    theme.strategos = null;
  }

  if (result.reachedCPL) {
    state.gameOver = { type: 'fall', message: 'Constantinople has fallen. The Empire is no more.' };
  }
}
