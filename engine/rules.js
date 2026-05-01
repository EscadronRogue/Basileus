function readThemeGold(themeOrGold) {
  if (typeof themeOrGold === 'number') return themeOrGold;
  return Number(themeOrGold?.G || 0);
}

export function getThemeLandPrice(themeOrGold) {
  return readThemeGold(themeOrGold) * 2;
}

export function getTaxExemptionCost(themeOrGold) {
  return getThemeLandPrice(themeOrGold);
}

export function getNormalOwnerIncome(themeOrGold) {
  return Math.ceil(readThemeGold(themeOrGold) / 2);
}

export function getNormalTaxIncome(themeOrGold) {
  return Math.floor(readThemeGold(themeOrGold) / 2);
}

export function getTaxExemptOwnerIncome(themeOrGold) {
  return readThemeGold(themeOrGold);
}

export function getThemeOwnerIncome(theme) {
  return theme?.taxExempt
    ? getTaxExemptOwnerIncome(theme)
    : getNormalOwnerIncome(theme);
}

export function getThemeTaxIncome(theme) {
  return theme?.taxExempt
    ? 0
    : getNormalTaxIncome(theme);
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
