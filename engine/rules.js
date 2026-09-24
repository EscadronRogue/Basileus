import { BALANCE } from '../data/balance.js';

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

// Rising price shared by mercenaries and estates: within one round the first
// costs `basePrice`, and each one after it costs 1 gold more than the last.
export function getRisingPriceTotal(count, basePrice = 1) {
  const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
  const base = Number(basePrice) || 0;
  return normalizedCount * base + (normalizedCount * (normalizedCount - 1)) / 2;
}

export function getRisingPriceCost(alreadyBought, additionalCount, basePrice = 1) {
  const currentCount = Math.max(0, Math.floor(Number(alreadyBought) || 0));
  const extraCount = Math.max(0, Math.floor(Number(additionalCount) || 0));
  return getRisingPriceTotal(currentCount + extraCount, basePrice) - getRisingPriceTotal(currentCount, basePrice);
}

// Gold a dynasty receives for troops it dismisses instead of fielding.
export function getDismissalGold(dismissedTroops) {
  return Math.max(0, Number(dismissedTroops) || 0) * (Number(BALANCE.GOLD_PER_DISMISSED_TROOP) || 0);
}

export function getMercenaryCostForCount(count) {
  return getRisingPriceTotal(count, BALANCE.MERCENARY_BASE_PRICE);
}

export function getMercenaryHireCost(alreadyHired, additionalCount) {
  return getRisingPriceCost(alreadyHired, additionalCount, BALANCE.MERCENARY_BASE_PRICE);
}

export function getThreatenedThemeIds(state, options = {}) {
  const includeCapital = Boolean(options.includeCapital);
  const includeLost = Boolean(options.includeLost);
  const route = Array.isArray(state?.currentInvasion?.route) ? state.currentInvasion.route : [];

  return route.filter((themeId) => {
    if (!includeCapital && themeId === 'CPL') return false;
    const theme = state?.themes?.[themeId];
    if (!theme) return false;
    if (!includeLost && theme.lost) return false;
    return true;
  });
}

export function isThemeThreatened(state, themeId, options = {}) {
  return getThreatenedThemeIds(state, options).includes(themeId);
}
