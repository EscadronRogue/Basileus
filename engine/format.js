// engine/format.js — player-facing numeric terminology.
// Keep labels centralized so UI, history, and validation messages use the same vocabulary.

function normalizeNumber(value) {
  const number = Number(value) || 0;
  return Math.round(number * 100) / 100;
}

export function formatGold(value, options = {}) {
  const amount = normalizeNumber(value);
  const absolute = Math.abs(amount);
  const sign = options.signed
    ? (amount > 0 ? '+' : amount < 0 ? '-' : '')
    : '';
  return `${sign}${absolute} gold`;
}

export function formatTroops(value, label = 'troop') {
  const amount = normalizeNumber(value);
  return `${amount} ${label}${amount === 1 ? '' : 's'}`;
}

export function formatLevy(value) {
  return formatTroops(value, 'levy');
}

