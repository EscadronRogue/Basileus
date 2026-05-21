// ui/labels.js — Single source of truth for player and province cartouches.
//
// Visual contract (kept stable everywhere these helpers are used):
//   - Province land background = a light wash of the province region.
//   - Province cartouche background = midway between the outline and land fill.
//   - Province land/cartouche outline = the same region, darkened.
//   - Occupied/lost provinces keep the hue with lighter fill and outline.
//   - Player/title cartouches still use dynasty/role colors.
//
// All player+province name rendering goes through this module. Do NOT
// duplicate these helpers in controllers or panels — import from here.

import { REGION_BORDER_COLORS } from '../data/provinces.js';
import { getPlayer, formatPlayerLabel, getPlayerRoleTextStyle } from '../engine/state.js';
import { renderIcon, provinceValueEntries } from './icons.js';

const FREE_FILL = '#6a4a8a';
const CAPITAL_FILL = '#9a7010';
const CHURCH_FILL = '#1a1a1a';
const OCCUPIED_FILL = '#625c52';
const REGION_LABELS = { east: 'East', west: 'West', sea: 'Sea', cpl: 'Capital' };
const DARK_OUTLINE_MIX = '#1f1208';
const LOST_CART_FILL_PERCENT_BY_REGION = {
  east: 28,
  west: 14,
  sea: 28,
  cpl: 18,
};

const LOST_CART_OUTLINE_PERCENT_BY_REGION = {
  west: 42,
};

const LOST_LAND_FILL_PERCENT_BY_REGION = {
  east: 18,
  west: 8,
  sea: 18,
  cpl: 10,
};

const LOST_LAND_OUTLINE_PERCENT_BY_REGION = {
  east: 36,
  west: 28,
  sea: 36,
  cpl: 32,
};

// ── CSS variable plumbing ─────────────────────────────────────────────
//
// One canonical attr setter. Sets four variables that the CSS reads:
//   --player-color     dynasty/owner color  → cartouche background
//   --role-color       region/role color    → cartouche outline
//   --role-outline-color  alias of --role-color, kept for legacy CSS
//   --role-contrast    readable foreground on the dynasty color

export function getPlayerStyleAttr(state, playerId) {
  const style = getPlayerRoleTextStyle(state, playerId);
  const player = getPlayer(state, playerId);
  const playerColor = player?.color || '#5a3810';
  const roleColor = style.color;
  const contrast = style.contrast || '#ffffff';
  return `--player-color: ${playerColor}; --role-color: ${roleColor}; --role-outline-color: ${roleColor}; --role-contrast: ${contrast};`;
}

// ── Region helpers ────────────────────────────────────────────────────

export function getRegionLabel(region) {
  return REGION_LABELS[region] || region || '';
}

export function getRegionColor(region) {
  return REGION_BORDER_COLORS[region] || '#2e1e0f';
}

function mixColor(color, colorPercent, otherColor) {
  const otherPercent = 100 - colorPercent;
  return `color-mix(in srgb, ${color} ${colorPercent}%, ${otherColor} ${otherPercent}%)`;
}

export function getProvinceRegionPalette(themeOrRegion) {
  const region = typeof themeOrRegion === 'string' ? themeOrRegion : themeOrRegion?.region;
  const base = getRegionColor(region);
  const lostCartFillPercent = LOST_CART_FILL_PERCENT_BY_REGION[region] ?? 24;
  const lostCartOutlinePercent = LOST_CART_OUTLINE_PERCENT_BY_REGION[region] ?? 52;
  const lostLandFillPercent = LOST_LAND_FILL_PERCENT_BY_REGION[region] ?? 16;
  const lostLandOutlinePercent = LOST_LAND_OUTLINE_PERCENT_BY_REGION[region] ?? 34;
  const fill = mixColor(base, 42, 'var(--parch-0)');
  const outline = mixColor(base, 76, DARK_OUTLINE_MIX);
  const lostFill = mixColor(base, lostLandFillPercent, 'var(--parch-0)');
  const lostCartReferenceFill = mixColor(base, lostCartFillPercent, 'var(--parch-0)');
  const lostMapOutline = mixColor(base, lostLandOutlinePercent, 'var(--parch-2)');
  const lostOutline = mixColor(base, lostCartOutlinePercent, 'var(--parch-2)');
  return {
    base,
    fill,
    cartFill: mixColor(outline, 52, fill),
    outline,
    lostFill,
    lostCartFill: mixColor(lostOutline, 62, lostCartReferenceFill),
    lostMapOutline,
    lostOutline,
  };
}

export function getProvincePaletteStyleAttr(themeOrRegion) {
  const palette = getProvinceRegionPalette(themeOrRegion);
  return [
    `--province-region-color: ${palette.base}`,
    `--province-fill-color: ${palette.fill}`,
    `--province-cartouche-fill-color: ${palette.cartFill}`,
    `--province-outline-color: ${palette.outline}`,
    `--province-lost-fill-color: ${palette.lostFill}`,
    `--province-lost-cartouche-fill-color: ${palette.lostCartFill}`,
    `--province-lost-map-outline-color: ${palette.lostMapOutline}`,
    `--province-lost-outline-color: ${palette.lostOutline}`,
  ].join('; ') + ';';
}

// ── Province color resolution ─────────────────────────────────────────

export function getProvinceOwnerColor(state, theme) {
  if (!theme) return FREE_FILL;
  if (theme.occupied) return OCCUPIED_FILL;
  if (theme.owner === 'church') return CHURCH_FILL;
  if (theme.owner !== null) return getPlayer(state, theme.owner)?.color || '#5a3810';
  if (theme.id === 'CPL') return CAPITAL_FILL;
  return FREE_FILL;
}

export function getProvinceStyleAttr(state, theme) {
  return `--province-owner-color: ${getProvinceOwnerColor(state, theme)}; ${getProvincePaletteStyleAttr(theme)}`;
}

// Plain-text value codes stay available for history summaries, ARIA labels,
// tooltips, and tests even though visible DOM uses icon cartouches.
export function formatProvinceValuesText(theme) {
  if (theme?.id === 'CPL') return '';
  const profit = Math.max(0, Number(theme?.P) || 0);
  const troops = Math.max(0, Number(theme?.T) || 0);
  const church = Math.max(0, Number(theme?.C) || 0);
  return `P${profit} T${troops} C${church}`;
}

// HTML variant — three icon+number chips, with zero-value entries collapsed.
// Use this anywhere the values render in a DOM (province token, dashboards,
// tooltips). The map renderer has its own SVG version in icons.js.
export function renderProvinceValuesHtml(theme) {
  if (theme?.id === 'CPL') return '';
  const entries = provinceValueEntries(theme).filter((entry) => entry.value > 0);
  if (!entries.length) return '';
  return entries
    .map((entry) => `<span class="province-token-value">${renderIcon(entry.kind)}<span class="province-token-num">${entry.value}</span></span>`)
    .join('');
}


// ── Cartouche renderers ───────────────────────────────────────────────

export function renderPlayerRoleName(state, player, fallback = '') {
  if (!player) return fallback;
  return `<span class="player-role-name" style="${getPlayerStyleAttr(state, player.id)}" title="${formatPlayerLabel(player)}">${formatPlayerLabel(player)}</span>`;
}

export function renderPlayerRoleNameById(state, playerId, fallback = null) {
  const player = getPlayer(state, playerId);
  return renderPlayerRoleName(state, player, fallback ?? `Player ${Number(playerId) + 1}`);
}

export function renderProvinceBadge(state, themeOrId, options = {}) {
  const theme = typeof themeOrId === 'string' ? state.themes[themeOrId] : themeOrId;
  if (!theme) return options.fallback || '';
  const churchValue = Math.max(0, Number(theme.C) || 0);
  const valuesHtml = renderProvinceValuesHtml(theme);
  const values = options.showValues && valuesHtml
    ? `<span class="province-token-values">${valuesHtml}</span>`
    : '';
  const classes = [
    'province-token',
    options.compact ? 'compact' : '',
    churchValue > 0 ? 'has-church' : '',
    theme.occupied ? 'occupied' : '',
    theme.owner === 'church' ? 'church' : '',
  ].filter(Boolean).join(' ');
  // Keep plain-text value codes in the tooltip so screen-readers and text-only
  // summaries still convey the values.
  const valuesText = formatProvinceValuesText(theme);
  const tooltip = valuesText
    ? `${theme.name} — ${getRegionLabel(theme.region)} (${theme.id}) · ${valuesText}`
    : `${theme.name} — ${getRegionLabel(theme.region)} (${theme.id})`;
  return `<span class="${classes}" data-province-token="${theme.id}" style="${getProvinceStyleAttr(state, theme)}" title="${tooltip}">${theme.name}${values}</span>`;
}

export function renderProvinceBadgeList(state, themeIds = []) {
  const badges = themeIds
    .map((themeId) => renderProvinceBadge(state, themeId, { compact: true }))
    .filter(Boolean);
  return badges.length ? badges.join(' ') : 'none';
}

// ── Title cartouche ───────────────────────────────────────────────────
//
// Rules (single source of truth):
//   • Outline color encodes the role's region:
//       BASILEUS / EMPRESS / CHIEF_EUNUCHS → Constantinople gold
//       PATRIARCH                          → black
//       DOM_EAST / DOM_WEST / ADMIRAL      → that region's color
//       STRATEGOS / BISHOP                 → the linked land's region color
//   • Background color is the holder's dynasty color, or parchment-white
//     when the title is vacant.
//
// Default labels are provided; callers can override via options.label.

const TITLE_OUTLINE_COLORS = {
  BASILEUS: REGION_BORDER_COLORS.cpl,
  EMPRESS: REGION_BORDER_COLORS.cpl,
  CHIEF_EUNUCHS: REGION_BORDER_COLORS.cpl,
  PATRIARCH: '#000000',
  DOM_EAST: REGION_BORDER_COLORS.east,
  DOM_WEST: REGION_BORDER_COLORS.west,
  ADMIRAL: REGION_BORDER_COLORS.sea,
};

const TITLE_DEFAULT_LABELS = {
  BASILEUS: 'Basileus',
  EMPRESS: 'Empress',
  CHIEF_EUNUCHS: 'Chief of Eunuchs',
  PATRIARCH: 'Patriarch',
  DOM_EAST: 'Domestic of the East',
  DOM_WEST: 'Domestic of the West',
  ADMIRAL: 'Admiral',
  STRATEGOS: 'Strategos',
  BISHOP: 'Bishop',
};

function getTitleOutlineColor(state, kind, themeId) {
  if (kind === 'STRATEGOS' || kind === 'BISHOP') {
    const theme = themeId ? state.themes[themeId] : null;
    return REGION_BORDER_COLORS[theme?.region] || '#2e1e0f';
  }
  return TITLE_OUTLINE_COLORS[kind] || '#2e1e0f';
}

function getTitleBackgroundColor(state, holderId) {
  if (holderId == null) return null;                 // vacant — parchment fill
  if (holderId === 'church') return CHURCH_FILL;
  return getPlayer(state, holderId)?.color || '#5a3810';
}

// Render a title cartouche. For STRATEGOS/BISHOP the caller is expected
// to pair it with the land's province cartouche (e.g. "<title> of <land>").
export function renderTitleBadge(state, kind, options = {}) {
  const { holderId = null, themeId = null, label = null, compact = false } = options;
  const outline = getTitleOutlineColor(state, kind, themeId);
  const bg = getTitleBackgroundColor(state, holderId);
  const vacant = bg == null;
  const styleAttr = vacant
    ? `--cart-border: ${outline};`
    : `--cart-bg: ${bg}; --cart-border: ${outline};`;
  const text = label || TITLE_DEFAULT_LABELS[kind] || kind;
  const classes = ['title-token', vacant ? 'vacant' : '', compact ? 'compact' : ''].filter(Boolean).join(' ');
  return `<span class="${classes}" style="${styleAttr}" title="${text}">${text}</span>`;
}

// Convenience: "<Strategos> of <Land>" or "<Bishop> of <Land>", both as
// cartouches in the established grammar. Single helper so every callsite
// renders the pairing identically.
export function renderThemeOfficeBadge(state, kind, themeId) {
  const theme = state.themes[themeId];
  if (!theme) return '';
  const holderId = kind === 'STRATEGOS' ? theme.strategos : theme.bishop;
  return `${renderTitleBadge(state, kind, { holderId, themeId, compact: true })} of ${renderProvinceBadge(state, theme, { compact: true })}`;
}
