// engine/presentation.js — formatters for resource values.
//
// Two parallel APIs:
//   formatGold / formatTroops / formatMercenaries / formatProvinceYield
//     → plain text, used by history summaries, toast bodies, ARIA labels.
//
//   formatGoldHtml / formatTroopsHtml / formatChurchHtml / formatMercenariesHtml
//     → HTML fragment with the matching SVG icon, used inside DOM panels.
//
// UI panels SHOULD prefer the *Html variants for live displays. History
// strings and any sink that escapes its input MUST keep the plain ones.

import { renderValue, renderIcon } from '../ui/icons.js';

function normalizeDisplayNumber(value) {
  const numeric = Number(value) || 0;
  return Number.isInteger(numeric) ? numeric : Math.round(numeric * 100) / 100;
}

// ── Plain-text formatters (unchanged signatures) ─────────────────────

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

export function formatMercenaries(count) {
  const amount = Math.max(0, normalizeDisplayNumber(count));
  return `${amount} ${amount === 1 ? 'mercenary' : 'mercenaries'}`;
}

export function formatProvinceYield(theme, options = {}) {
  if (theme?.id === 'CPL') return '';
  const profit = Math.max(0, Number(theme?.P) || 0);
  const troops = Math.max(0, Number(theme?.T) || 0);
  const church = Math.max(0, Number(theme?.C) || 0);
  if (options.compact) return `P${profit} / T${troops} / C${church}`;
  return `Profit ${profit} / Troops ${troops} / Church ${church}`;
}

// ── HTML formatters (icon + number) ─────────────────────────────────
//
// Each returns a small inline `<span class="value …">` fragment. Pass
// {label: true} to include the spelled-out noun ("Troops", "Gold",
// "Church") next to the glyph when there's room.

export function formatGoldHtml(value, options = {}) {
  return renderValue('gold', normalizeDisplayNumber(value), options);
}

export function formatTroopsHtml(value, options = {}) {
  return renderValue('troop', Math.max(0, normalizeDisplayNumber(value)), options);
}

export function formatChurchHtml(value, options = {}) {
  return renderValue('church', Math.max(0, normalizeDisplayNumber(value)), options);
}

export function formatMercenariesHtml(value, options = {}) {
  // Mercenaries are still troops; the icon is the sword. We just label them.
  const opts = { ...options, label: options.label === true ? 'Mercenaries' : options.label };
  return renderValue('troop', Math.max(0, normalizeDisplayNumber(value)), opts);
}

export function formatProvinceYieldHtml(theme) {
  if (theme?.id === 'CPL') return '';
  const profit = Math.max(0, Number(theme?.P) || 0);
  const troops = Math.max(0, Number(theme?.T) || 0);
  const church = Math.max(0, Number(theme?.C) || 0);
  return `${formatGoldHtml(profit)} ${formatTroopsHtml(troops)} ${formatChurchHtml(church)}`;
}

// Re-export the bare icon helper so panels can use it without a second import.
export { renderIcon };
