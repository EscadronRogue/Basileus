// engine/combat.js - invasion resolution and occupation effects.
import {
  getAffordableTriangularCount,
  getInvasionAdvanceScaleTargets,
  getInvasionReconquestScaleTargets,
  getTriangularStepCost,
} from './rules.js';

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
    reconquestRewardProvinceCount: 0,
    reachedCPL: false,
    advancePath: [],
    advanceScaleTargets: getInvasionAdvanceScaleTargets(state, invasion),
    reconquestScaleTargets: getInvasionReconquestScaleTargets(state, invasion, { occupiedFirst: true }),
  };

  if (F === S) return result;

  if (F < S) {
    let remaining = S - F;
    let captureStep = 1;
    const projectedOccupied = new Set(initiallyOccupied);
    for (const themeId of route) {
      const captureCost = getTriangularStepCost(captureStep);
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
      captureStep += 1;
      projectedOccupied.add(themeId);
      result.themesLost.push(themeId);
      result.advancePath.push(themeId);
    }
    return result;
  }

  let surplus = F - S;
  let recoverStep = 1;
  const reverseRoute = route.slice().reverse().filter((themeId) => themeId !== 'CPL');
  result.reconquestRewardProvinceCount = countAffordableProvinceWins(state, surplus, reverseRoute);
  const projectedRecovered = new Set(initiallyOccupied);
  for (const themeId of reverseRoute) {
    const recoverCost = getTriangularStepCost(recoverStep);
    if (surplus < recoverCost) break;
    const theme = state.themes[themeId];
    if (!theme || !projectedRecovered.has(themeId)) continue;
    surplus -= recoverCost;
    recoverStep += 1;
    projectedRecovered.delete(themeId);
    result.advancePath.push(themeId);
    result.themesRecovered.push(themeId);
  }
  return result;
}

function countAffordableProvinceWins(state, surplus, reverseRoute) {
  const validRouteLength = reverseRoute.filter((themeId) => state.themes[themeId]).length;
  return getAffordableTriangularCount(surplus, validRouteLength);
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
      theme.suspendedOwner = null;
    } else {
      theme.owner = null;
    }
    theme.strategos = null;
  }

  if (result.reachedCPL) {
    state.gameOver = { type: 'fall', message: 'Constantinople has fallen. The Empire is no more. No dynasty wins.' };
  }
}
