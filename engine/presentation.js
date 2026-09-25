// engine/presentation.js - plain-text formatters for resource values.
//
// Used by history summaries, notifications, and other text sinks. The HTML
// variants with SVG icons live in ui/icons.js so the engine never depends on
// the UI layer.
import { getRisingStepPrice } from './rules.js';

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

// The rising price as players read it: "2, 2, 2, 3, 3, 3, 4…".
export function describeRisingPrices(balance = undefined, count = 7) {
  return `${Array.from({ length: count }, (_, index) => getRisingStepPrice(index + 1, balance)).join(', ')}…`;
}
