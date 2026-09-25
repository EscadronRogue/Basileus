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

// Gold one estate pays its owner every Income.
export function getThemeOwnerIncome(theme) {
  return readThemeProfit(theme);
}

// The rising price shared by mercenaries, estates, the war ladder and war
// rewards: the first RISING_PRICE_GROUP items cost RISING_PRICE_START each,
// and every next group 1 more (2, 2, 2, 3, 3, 3, 4, 4, 4...). `balance` is
// BALANCE or a map's values (getBalance).
function risingPriceShape(balance = BALANCE) {
  return {
    start: Number(balance?.RISING_PRICE_START) || 0,
    group: Math.max(1, Math.floor(Number(balance?.RISING_PRICE_GROUP) || 1)),
  };
}

// The price of the nth item (n from 1).
export function getRisingStepPrice(position, balance = BALANCE) {
  const { start, group } = risingPriceShape(balance);
  const index = Math.max(1, Math.floor(Number(position) || 1));
  return start + Math.floor((index - 1) / group);
}

// The price of the first `count` items together.
export function getRisingPriceTotal(count, balance = BALANCE) {
  const { start, group } = risingPriceShape(balance);
  const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
  const fullGroups = Math.floor(normalizedCount / group);
  const rest = normalizedCount % group;
  return group * (fullGroups * start + (fullGroups * (fullGroups - 1)) / 2) + rest * (start + fullGroups);
}

// The price of `additionalCount` more items after `alreadyBought`.
export function getRisingPriceCost(alreadyBought, additionalCount, balance = BALANCE) {
  const currentCount = Math.max(0, Math.floor(Number(alreadyBought) || 0));
  const extraCount = Math.max(0, Math.floor(Number(additionalCount) || 0));
  return getRisingPriceTotal(currentCount + extraCount, balance) - getRisingPriceTotal(currentCount, balance);
}

// How many items `budget` pays for, and what they cost.
export function getRisingPriceAffordable(budget, balance = BALANCE) {
  const available = Math.max(0, Number(budget) || 0);
  let count = 0;
  let spent = 0;
  while (spent + getRisingStepPrice(count + 1, balance) <= available) {
    spent += getRisingStepPrice(count + 1, balance);
    count += 1;
  }
  return { count, spent };
}

// Gold a dynasty receives for troops it dismisses instead of fielding.
export function getDismissalGold(dismissedTroops) {
  return Math.max(0, Number(dismissedTroops) || 0) * (Number(BALANCE.GOLD_PER_DISMISSED_TROOP) || 0);
}

export function getMercenaryCostForCount(count) {
  return getRisingPriceTotal(count);
}

export function getMercenaryHireCost(alreadyHired, additionalCount) {
  return getRisingPriceCost(alreadyHired, additionalCount);
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
