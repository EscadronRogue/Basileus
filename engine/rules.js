function readThemeProfit(themeOrProfit) {
  if (typeof themeOrProfit === 'number') return Math.max(0, Number(themeOrProfit) || 0);
  return Math.max(0, Number(themeOrProfit?.P ?? themeOrProfit?.profit ?? themeOrProfit?.G ?? 0) || 0);
}

function readThemeTroops(themeOrTroops) {
  if (typeof themeOrTroops === 'number') return Math.max(0, Number(themeOrTroops) || 0);
  return Math.max(0, Number(themeOrTroops?.T ?? themeOrTroops?.troops ?? 0) || 0);
}

function readThemeChurch(themeOrChurch) {
  if (typeof themeOrChurch === 'number') return Math.max(0, Number(themeOrChurch) || 0);
  return Math.max(0, Number(themeOrChurch?.C ?? themeOrChurch?.church ?? 0) || 0);
}

export function getThemeProfitValue(themeOrProfit) {
  return readThemeProfit(themeOrProfit);
}

export function getThemeTroopCount(themeOrTroops) {
  return readThemeTroops(themeOrTroops);
}

export function getThemeChurchValue(theme) {
  return readThemeChurch(theme);
}

export function getThemeLandPrice(themeOrProfit) {
  return readThemeProfit(themeOrProfit) * 2;
}

export function getNormalOwnerIncome(themeOrProfit) {
  return readThemeProfit(themeOrProfit);
}

export function getThemeOwnerIncome(theme) {
  return getNormalOwnerIncome(theme);
}

export function getDefenderRewardGold(theme) {
  return readThemeProfit(theme) * 2;
}

export const TRIANGULAR_SCALE_STEP_LIMIT = 10;

function normalizeTriangularCount(count) {
  return Math.max(0, Math.floor(Number(count) || 0));
}

function normalizeTriangularLimit(limit = TRIANGULAR_SCALE_STEP_LIMIT) {
  return Math.max(0, Math.min(TRIANGULAR_SCALE_STEP_LIMIT, Math.floor(Number(limit) || 0)));
}

export function getTriangularCostForCount(count) {
  const normalizedCount = normalizeTriangularCount(count);
  return (normalizedCount * (normalizedCount + 1)) / 2;
}

export function getTriangularStepCost(step) {
  return Math.max(0, Math.floor(Number(step) || 0));
}

export function getTriangularScaleSteps(limit = TRIANGULAR_SCALE_STEP_LIMIT) {
  const normalizedLimit = normalizeTriangularLimit(limit);
  return Array.from({ length: normalizedLimit }, (_, index) => {
    const count = index + 1;
    return {
      count,
      stepCost: getTriangularStepCost(count),
      totalCost: getTriangularCostForCount(count),
    };
  });
}

export function getAffordableTriangularCount(force, limit = TRIANGULAR_SCALE_STEP_LIMIT) {
  let remaining = Math.max(0, Math.floor(Number(force) || 0));
  const normalizedLimit = normalizeTriangularLimit(limit);
  let count = 0;
  for (const step of getTriangularScaleSteps(normalizedLimit)) {
    if (remaining < step.stepCost) break;
    remaining -= step.stepCost;
    count = step.count;
  }
  return count;
}

function getThemeScaleName(state, themeId) {
  if (themeId === 'CPL') return 'Constantinople';
  return state?.themes?.[themeId]?.name || themeId;
}

function withTriangularScaleCosts(targets) {
  return targets.map((target, index) => {
    const count = index + 1;
    return {
      ...target,
      count,
      stepCost: getTriangularStepCost(count),
      totalCost: getTriangularCostForCount(count),
    };
  });
}

export function getInvasionAdvanceScaleTargets(state, invasion, options = {}) {
  const limit = normalizeTriangularLimit(options.limit);
  const route = Array.isArray(invasion?.route) ? invasion.route : [];
  const targets = [];

  for (const themeId of route) {
    if (targets.length >= limit) break;
    const isCapital = themeId === 'CPL';
    const theme = state?.themes?.[themeId];
    if (!isCapital && (!theme || theme.occupied)) continue;
    targets.push({
      themeId,
      name: getThemeScaleName(state, themeId),
      kind: isCapital ? 'capital' : 'province',
      occupied: Boolean(theme?.occupied),
    });
    if (isCapital) break;
  }

  return withTriangularScaleCosts(targets);
}

export function getInvasionReconquestScaleTargets(state, invasion, options = {}) {
  const limit = normalizeTriangularLimit(options.limit);
  const occupiedOnly = Boolean(options.occupiedOnly);
  const occupiedFirst = Boolean(options.occupiedFirst);
  const route = (Array.isArray(invasion?.route) ? invasion.route : [])
    .slice()
    .reverse()
    .filter((themeId) => themeId !== 'CPL');
  const targets = [];

  for (const themeId of route) {
    if (!occupiedFirst && targets.length >= limit) break;
    const theme = state?.themes?.[themeId];
    if (!theme) continue;
    if (occupiedOnly && !theme.occupied) continue;
    targets.push({
      themeId,
      name: getThemeScaleName(state, themeId),
      kind: 'province',
      occupied: Boolean(theme.occupied),
    });
  }

  const orderedTargets = occupiedFirst
    ? [
      ...targets.filter((target) => target.occupied),
      ...targets.filter((target) => !target.occupied),
    ].slice(0, limit)
    : targets;

  return withTriangularScaleCosts(orderedTargets);
}

export function getMercenaryCostForCount(count) {
  return getTriangularCostForCount(count);
}

export function getMercenaryHireCost(alreadyHired, additionalCount) {
  const currentCount = Math.max(0, Number(alreadyHired) || 0);
  const extraCount = Math.max(0, Number(additionalCount) || 0);
  return getMercenaryCostForCount(currentCount + extraCount) - getMercenaryCostForCount(currentCount);
}

export function getThreatenedThemeIds(state, options = {}) {
  const includeCapital = Boolean(options.includeCapital);
  const includeOccupied = Boolean(options.includeOccupied);
  const route = Array.isArray(state?.currentInvasion?.route) ? state.currentInvasion.route : [];

  return route.filter((themeId) => {
    if (!includeCapital && themeId === 'CPL') return false;
    const theme = state?.themes?.[themeId];
    if (!theme) return false;
    if (!includeOccupied && theme.occupied) return false;
    return true;
  });
}

export function isThemeThreatened(state, themeId, options = {}) {
  return getThreatenedThemeIds(state, options).includes(themeId);
}
