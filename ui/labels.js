// ui/labels.js — Single source of truth for player and province cartouches.
//
// Visual contract (kept stable everywhere these helpers are used):
//   • Outline color = the *region* of the map / the *major role* tied to
//     that region (forest green East, crimson West, cobalt Sea, gold CPL,
//     black Patriarch).
//   • Background color = the *owner* (dynasty color for player-held themes,
//     church black, occupied grey, free amethyst, capital gold). For player
//     names the background is the dynasty color.
//
// All player+province name rendering goes through this module. Do NOT
// duplicate these helpers in controllers or panels — import from here.

import { REGION_BORDER_COLORS } from '../data/provinces.js';
import { getPlayer, formatPlayerLabel, getPlayerRoleTextStyle } from '../engine/state.js';

const FREE_FILL = '#6a4a8a';
const CAPITAL_FILL = '#9a7010';
const CHURCH_FILL = '#1a1a1a';
const OCCUPIED_FILL = '#625c52';
const REGION_LABELS = { east: 'East', west: 'West', sea: 'Sea', cpl: 'Capital' };

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

function getRegionColor(region) {
  return REGION_BORDER_COLORS[region] || '#2e1e0f';
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
  return `--province-owner-color: ${getProvinceOwnerColor(state, theme)}; --province-region-color: ${getRegionColor(theme?.region)};`;
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
  const values = options.showValues
    ? `<span class="province-token-values">P${theme.P} T${theme.T} L${theme.L}</span>`
    : '';
  const classes = [
    'province-token',
    options.compact ? 'compact' : '',
    theme.taxExempt ? 'tax-exempt' : '',
    theme.occupied ? 'occupied' : '',
    theme.owner === 'church' ? 'church' : '',
  ].filter(Boolean).join(' ');
  const tooltip = `${theme.name} — ${getRegionLabel(theme.region)} (${theme.id})`;
  return `<span class="${classes}" style="${getProvinceStyleAttr(state, theme)}" title="${tooltip}">${theme.name}${values}</span>`;
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
  BASILEUS: '#9a7010',       // CPL gold
  EMPRESS: '#9a7010',
  CHIEF_EUNUCHS: '#9a7010',
  PATRIARCH: '#000000',
  DOM_EAST: '#1e5c34',
  DOM_WEST: '#7a2020',
  ADMIRAL: '#1e3a7a',
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
