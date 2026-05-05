function normalizeDisplayNumber(value) {
  const numeric = Number(value) || 0;
  return Number.isInteger(numeric) ? numeric : Math.round(numeric * 100) / 100;
}

export function formatGold(value, options = {}) {
  const amount = normalizeDisplayNumber(value);
  const signed = Boolean(options.signed);
  const showPlus = Boolean(options.showPlus || signed);
  const prefix = amount > 0 && showPlus ? '+' : '';
  return `${prefix}${amount} gold`;
}

export function formatTroops(count, noun = 'troop') {
  const amount = Math.max(0, normalizeDisplayNumber(count));
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`;
}

export function formatLevies(count) {
  const amount = Math.max(0, normalizeDisplayNumber(count));
  return `${amount} ${amount === 1 ? 'levy' : 'levies'}`;
}

export function formatMercenaries(count) {
  const amount = Math.max(0, normalizeDisplayNumber(count));
  return `${amount} ${amount === 1 ? 'mercenary' : 'mercenaries'}`;
}

export function formatProvinceYield(theme, options = {}) {
  const profit = Math.max(0, Number(theme?.P) || 0);
  const tax = Math.max(0, Number(theme?.T) || 0);
  const levies = Math.max(0, Number(theme?.L) || 0);
  if (options.compact) return `P${profit} / T${tax} / L${levies}`;
  return `Profit ${profit} / Tax ${tax} / Levies ${levies}`;
}
