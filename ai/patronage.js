import { MAJOR_TITLES } from '../data/titles.js';

function titleKeys() {
  return Object.keys(MAJOR_TITLES);
}

export function estimateMajorTitleYield(state, titleKey) {
  if (titleKey === 'PATRIARCH') {
    return Object.values(state?.themes || {}).reduce((total, theme) => {
      if (!theme || theme.id === 'CPL' || theme.bishop != null) return total;
      return total + Math.max(0, Number(theme.C ?? theme.origin?.C) || 0);
    }, 0);
  }

  const region = MAJOR_TITLES[titleKey]?.region;
  if (!region) return 0;
  const pool = Object.values(state?.themes || {}).reduce((total, theme) => {
    if (!theme || theme.id === 'CPL' || theme.lost || theme.region !== region || theme.strategos != null) return total;
    return total + Math.max(0, Number(theme.T ?? theme.origin?.T) || 0);
  }, 0);
  return Math.ceil(pool * 2 / 3);
}

export function estimateMajorTitleValue(state, titleKey) {
  return Math.max(1, estimateMajorTitleYield(state, titleKey));
}

export function estimateTitlePackageValue(state, assignedTitleKeys = []) {
  return assignedTitleKeys.reduce((total, titleKey) => (
    total + estimateMajorTitleValue(state, titleKey)
  ), 0);
}

export function analyzeMajorTitleAssignments(state, basileusId, titleAssignments = {}) {
  const eligibleIds = (state?.players || [])
    .map((player) => player.id)
    .filter((playerId) => playerId !== basileusId);
  const packages = Object.fromEntries(eligibleIds.map((playerId) => [
    playerId,
    { playerId, titleKeys: [], value: 0 },
  ]));
  const titleValues = {};

  for (const titleKey of titleKeys()) {
    const holderId = Number(titleAssignments[titleKey]);
    const value = estimateMajorTitleValue(state, titleKey);
    titleValues[titleKey] = value;
    if (!packages[holderId]) continue;
    packages[holderId].titleKeys.push(titleKey);
    packages[holderId].value += value;
  }

  const entries = Object.values(packages).map((entry) => ({
    ...entry,
    count: entry.titleKeys.length,
  }));
  const totalPackageValue = entries.reduce((total, entry) => total + entry.value, 0);
  const averagePackageValue = entries.length ? totalPackageValue / entries.length : 0;
  const bestPackageValue = Math.max(0, ...entries.map((entry) => entry.value));
  const worstPackageValue = Math.min(bestPackageValue, ...entries.map((entry) => entry.value));
  const spread = Math.max(1, bestPackageValue - worstPackageValue);

  for (const entry of entries) {
    entry.quality = entry.value - averagePackageValue;
    entry.qualityShare = entry.quality / spread;
    entry.packageShare = bestPackageValue > 0 ? entry.value / bestPackageValue : 0;
  }

  return {
    titleValues,
    entries,
    packagesByPlayer: Object.fromEntries(entries.map((entry) => [entry.playerId, entry])),
    totalPackageValue,
    averagePackageValue,
    bestPackageValue,
    worstPackageValue,
    spread,
  };
}
