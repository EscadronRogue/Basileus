// engine/combat.js - Invasion resolution: advance or reconquest

function clearStrategosArmy(state, themeId) {
  const officeKey = `STRAT_${themeId}`;
  for (const player of state.players) {
    if (player.professionalArmies[officeKey] != null) {
      delete player.professionalArmies[officeKey];
    }
  }
}

/**
 * Resolve the frontier battle.
 * @param {object} state - game state
 * @param {number} frontierTroops - total troops sent to frontier (F)
 * @param {number} invaderStrength - rolled strength (S)
 * @param {object} invasion - the invasion card
 * @returns {{ outcome, themesLost: string[], themesRecovered: string[], reachedCPL: boolean }}
 */
export function resolveInvasion(state, frontierTroops, invaderStrength, invasion) {
  const F = frontierTroops;
  const S = invaderStrength;
  const route = invasion.route;
  const initiallyOccupied = new Set(
    Object.values(state.themes)
      .filter((theme) => theme.occupied)
      .map((theme) => theme.id)
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

  if (F === S) {
    return result;
  }

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
  const reverseRoute = route
    .slice()
    .reverse()
    .filter((themeId) => themeId !== 'CPL');
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

/**
 * Apply invasion results to state (mutates).
 */
export function applyInvasionResult(state, result) {
  for (const themeId of result.themesLost) {
    const theme = state.themes[themeId];
    if (!theme) continue;
    clearStrategosArmy(state, themeId);
    theme.occupied = true;
    theme.owner = null;
    theme.taxExempt = false;
    theme.strategos = null;
    theme.bishop = null;
    theme.bishopIsDonor = false;
  }

  for (const themeId of result.themesRecovered) {
    const theme = state.themes[themeId];
    if (!theme) continue;
    clearStrategosArmy(state, themeId);
    theme.occupied = false;
    theme.owner = null;
    theme.taxExempt = false;
    theme.strategos = null;
    theme.bishop = null;
    theme.bishopIsDonor = false;
  }

  if (result.reachedCPL) {
    state.gameOver = { type: 'fall', message: 'Constantinople has fallen. The Empire is no more.' };
  }
}
