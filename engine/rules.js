function readThemeProfit(themeOrProfit) {
  if (typeof themeOrProfit === 'number') return Math.max(0, Number(themeOrProfit) || 0);
  return Math.max(0, Number(themeOrProfit?.P ?? themeOrProfit?.profit ?? themeOrProfit?.G ?? 0) || 0);
}

function readThemeTax(themeOrTax) {
  if (typeof themeOrTax === 'number') return Math.max(0, Number(themeOrTax) || 0);
  return Math.max(0, Number(themeOrTax?.T ?? themeOrTax?.tax ?? 0) || 0);
}

function readThemeChurch(themeOrChurch) {
  if (typeof themeOrChurch === 'number') return Math.max(0, Number(themeOrChurch) || 0);
  return Math.max(0, Number(themeOrChurch?.C ?? themeOrChurch?.church ?? 0) || 0);
}

export function getThemeProfitValue(themeOrProfit) {
  return readThemeProfit(themeOrProfit);
}

export function getThemeTaxValue(themeOrTax) {
  return readThemeTax(themeOrTax);
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

export function getNormalTaxIncome(themeOrTax) {
  return readThemeTax(themeOrTax);
}

export function getThemeOwnerIncome(theme) {
  return getNormalOwnerIncome(theme);
}

export function getThemeTaxIncome(theme) {
  return getNormalTaxIncome(theme);
}

// The compensation handed to a best defender who leaves a reconquerable province
// occupied instead of restoring it to the empire: 2× the theme's profit.
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

export function getMercenaryTotalCount(mercenaries = []) {
  return (Array.isArray(mercenaries) ? mercenaries : []).reduce(
    (total, entry) => total + Math.max(0, Number(entry?.count) || 0),
    0,
  );
}

export function getMercenaryOrderCost(mercenaries = [], alreadyHired = 0) {
  return getMercenaryHireCost(alreadyHired, getMercenaryTotalCount(mercenaries));
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
