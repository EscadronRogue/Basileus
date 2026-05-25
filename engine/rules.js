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

export function getMercenaryCostForCount(count) {
  const normalizedCount = Math.max(0, Number(count) || 0);
  return (normalizedCount * (normalizedCount + 1)) / 2;
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
