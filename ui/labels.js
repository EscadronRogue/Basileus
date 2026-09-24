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
import { escapeHtml } from './html.js';

const FREE_FILL = '#6a4a8a';
const CAPITAL_FILL = '#E49B0F';
const OCCUPIED_FILL = '#625c52';
const REGION_LABELS = { east: 'East', west: 'West', sea: 'Sea', cpl: 'Capital' };
const DARK_OUTLINE_MIX = '#1f1208';
const CARTOUCHE_FILL_BY_REGION = {
  cpl: '#E49B0F',
};
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
    cartFill: CARTOUCHE_FILL_BY_REGION[region] || mixColor(outline, 52, fill),
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
  if (Number.isInteger(theme.owner)) return getPlayer(state, theme.owner)?.color || '#5a3810';
  if (theme.id === 'CPL') return CAPITAL_FILL;
  return FREE_FILL;
}

export function getProvinceStyleAttr(state, theme) {
  return `--province-owner-color: ${getProvinceOwnerColor(state, theme)}; ${getProvincePaletteStyleAttr(theme)}`;
}

function getProvinceOwnerLabel(state, theme) {
  if (!theme || theme.owner == null) return '';
  if (!Number.isInteger(theme.owner)) return '';
  const player = getPlayer(state, theme.owner);
  return formatPlayerLabel(player) || `Player ${Number(theme.owner) + 1}`;
}

const OWNERSHIP_KIND_META = {
  estate: {
    label: 'Estate',
    title: 'Private estate',
  },
  strategos: {
    label: 'Strategos',
    title: 'Strategos',
  },
  bishop: {
    label: 'Bishop',
    title: 'Bishop',
  },
};

function getOwnershipHolderLabel(state, playerId) {
  const player = getPlayer(state, playerId);
  return formatPlayerLabel(player) || `Player ${Number(playerId) + 1}`;
}

export function getProvinceOwnershipEntries(state, themeOrId) {
  const theme = typeof themeOrId === 'string' ? state.themes[themeOrId] : themeOrId;
  if (!theme) return [];
  const entries = [];
  const palette = getProvinceRegionPalette(theme);

  if (Number.isInteger(theme.owner)) {
    entries.push({
      kind: 'estate',
      holderId: theme.owner,
      color: getPlayer(state, theme.owner)?.color || '#5a3810',
      accent: palette.outline,
    });
  }
  if (theme.strategos != null) {
    entries.push({
      kind: 'strategos',
      holderId: theme.strategos,
      color: getPlayer(state, theme.strategos)?.color || '#5a3810',
      accent: palette.outline,
    });
  }
  if (theme.bishop != null) {
    entries.push({
      kind: 'bishop',
      holderId: theme.bishop,
      color: getPlayer(state, theme.bishop)?.color || '#5a3810',
      accent: palette.outline,
    });
  }

  return entries;
}

export function renderOwnershipBadge(state, entry, options = {}) {
  if (!entry || !OWNERSHIP_KIND_META[entry.kind]) return '';
  const meta = OWNERSHIP_KIND_META[entry.kind];
  const holder = getOwnershipHolderLabel(state, entry.holderId);
  const text = options.label || (options.hideHolder ? meta.label : `${meta.label} ${holder}`);
  const title = options.title || `${meta.title}: ${holder}`;
  const classes = [
    'ownership-badge',
    `ownership-badge-${entry.kind}`,
    options.compact ? 'compact' : '',
  ].filter(Boolean).join(' ');
  return `
    <span class="${classes}" style="--ownership-color: ${entry.color}; --ownership-accent: ${entry.accent || 'rgba(20,8,0,0.75)'};" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
      <span class="ownership-mark" aria-hidden="true"></span>
      <span class="ownership-text">${escapeHtml(text)}</span>
    </span>
  `;
}

export function renderProvinceOwnershipBadges(state, themeOrId, options = {}) {
  const entries = getProvinceOwnershipEntries(state, themeOrId);
  if (!entries.length) return options.fallback || '';
  const classes = [
    'ownership-badges',
    options.compact ? 'compact' : '',
  ].filter(Boolean).join(' ');
  return `<span class="${classes}">${entries.map((entry) => renderOwnershipBadge(state, entry, options)).join('')}</span>`;
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
  if (!player) return escapeHtml(fallback);
  const label = escapeHtml(formatPlayerLabel(player));
  return `<span class="player-role-name" style="${getPlayerStyleAttr(state, player.id)}" title="${label}">${label}</span>`;
}

export function renderPlayerRoleNameById(state, playerId, fallback = null) {
  const player = getPlayer(state, playerId);
  return renderPlayerRoleName(state, player, fallback ?? `Player ${Number(playerId) + 1}`);
}

function getPlayerChipInitial(player, label = '') {
  const source = (player?.dynasty || label || '').trim();
  return source ? source[0].toUpperCase() : '?';
}

function normalizeCartoucheVariant(options = {}) {
  if (options === 'light' || options === 'strong') return options;
  if (options?.light) return 'light';
  return options?.variant || '';
}

export function renderPlayerChip(state, player, fallback = '', options = {}) {
  if (fallback && typeof fallback === 'object') {
    options = fallback;
    fallback = '';
  }
  const labelText = player ? formatPlayerLabel(player) : fallback;
  if (!labelText) return '';
  if (!player) return escapeHtml(labelText);
  const label = escapeHtml(labelText);
  const variant = normalizeCartoucheVariant(options);
  const classes = ['player-chip', variant ? `cartouche-${variant}` : ''].filter(Boolean).join(' ');
  return `
    <span class="${classes}" style="${getPlayerStyleAttr(state, player.id)}" title="${label}">
      <span class="chip-initial" aria-hidden="true">${escapeHtml(getPlayerChipInitial(player, labelText))}</span>
      <span class="chip-label">${label}</span>
    </span>
  `;
}

export function renderPlayerChipById(state, playerId, fallback = null, options = {}) {
  const player = getPlayer(state, playerId);
  return renderPlayerChip(state, player, fallback ?? `Player ${Number(playerId) + 1}`, options);
}

export function renderProvinceBadge(state, themeOrId, options = {}) {
  const theme = typeof themeOrId === 'string' ? state.themes[themeOrId] : themeOrId;
  if (!theme) return options.fallback || '';
  const churchValue = Math.max(0, Number(theme.C) || 0);
  const valuesHtml = renderProvinceValuesHtml(theme);
  const values = options.showValues && valuesHtml
    ? `<span class="province-token-values">${valuesHtml}</span>`
    : '';
  const ownership = options.showOwnership
    ? renderProvinceOwnershipBadges(state, theme, {
      compact: options.compactOwnership ?? true,
      hideHolder: options.hideOwnershipHolder ?? false,
    })
    : '';
  const variant = normalizeCartoucheVariant(options);
  const classes = [
    'province-token',
    options.compact ? 'compact' : '',
    variant ? `cartouche-${variant}` : '',
    ownership ? 'has-ownership' : '',
    churchValue > 0 ? 'has-church' : '',
    theme.occupied ? 'occupied' : '',
  ].filter(Boolean).join(' ');
  // Keep plain-text value codes in the tooltip so screen-readers and text-only
  // summaries still convey the values.
  const valuesText = formatProvinceValuesText(theme);
  const tooltip = valuesText
    ? `${theme.name} — ${getRegionLabel(theme.region)} (${theme.id}) · ${valuesText}`
    : `${theme.name} — ${getRegionLabel(theme.region)} (${theme.id})`;
  return `<span class="${classes}" data-province-token="${escapeHtml(theme.id)}" style="${getProvinceStyleAttr(state, theme)}" title="${escapeHtml(tooltip)}"><span class="province-token-name">${escapeHtml(theme.name)}</span>${values}${ownership}</span>`;
}

function getProvinceOfficeHolderId(theme, kind, explicitHolderId = undefined) {
  if (explicitHolderId !== undefined) return explicitHolderId;
  if (kind === 'estate') return theme.owner;
  if (kind === 'strategos') return theme.strategos;
  if (kind === 'bishop') return theme.bishop;
  return null;
}

export function renderProvinceOfficeBadge(state, kind, themeOrId, options = {}) {
  const theme = typeof themeOrId === 'string' ? state.themes[themeOrId] : themeOrId;
  const meta = OWNERSHIP_KIND_META[kind];
  if (!theme || !meta) return options.fallback || '';
  const holderId = getProvinceOfficeHolderId(theme, kind, options.holderId);
  const holder = holderId != null && holderId !== '' && Number.isInteger(Number(holderId))
    ? getPlayer(state, Number(holderId))
    : null;
  const officeColor = holder?.color || 'rgba(255,252,240,0.96)';
  const valuesHtml = renderProvinceValuesHtml(theme);
  const values = options.showValues && valuesHtml
    ? `<span class="province-token-values">${valuesHtml}</span>`
    : '';
  const ownership = options.showOwnership
    ? renderProvinceOwnershipBadges(state, theme, {
      compact: options.compactOwnership ?? true,
      hideHolder: options.hideOwnershipHolder ?? false,
    })
    : '';
  const variant = normalizeCartoucheVariant(options);
  const label = options.label || meta.label;
  const classes = [
    'province-token',
    'province-office-token',
    `province-office-token-${kind}`,
    options.compact ? 'compact' : '',
    variant ? `cartouche-${variant}` : '',
    holder ? '' : 'vacant-office',
    ownership ? 'has-ownership' : '',
    Math.max(0, Number(theme.C) || 0) > 0 ? 'has-church' : '',
    theme.occupied ? 'occupied' : '',
  ].filter(Boolean).join(' ');
  const valuesText = formatProvinceValuesText(theme);
  const holderText = holder ? `: ${formatPlayerLabel(holder)}` : '';
  const title = `${label} in ${theme.name}${holderText}${valuesText ? ` - ${valuesText}` : ''}`;
  const styleAttr = `${getProvinceStyleAttr(state, theme)} --office-holder-color: ${officeColor};`;
  return `
    <span class="${classes}" data-province-token="${escapeHtml(theme.id)}" style="${styleAttr}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
      <span class="province-office-prefix">
        <span class="province-office-mark" aria-hidden="true"></span>
        <span class="province-office-kind">${escapeHtml(label)}</span>
      </span>
      <span class="province-token-name">${escapeHtml(theme.name)}</span>
      ${values}${ownership}
    </span>
  `;
}

export function renderProvinceOwnerMarker(state, themeOrId, options = {}) {
  const theme = typeof themeOrId === 'string' ? state.themes[themeOrId] : themeOrId;
  if (!theme || !Number.isInteger(theme.owner)) return options.fallback || '';
  const ownerLabel = getProvinceOwnerLabel(state, theme);
  const markerLabel = `Estate owner: ${ownerLabel}`;
  const classes = [
    'province-owner-marker',
    options.compact ? 'compact' : '',
  ].filter(Boolean).join(' ');
  return `<span class="${classes}" style="--province-owner-color: ${getProvinceOwnerColor(state, theme)};" title="${escapeHtml(markerLabel)}" aria-label="${escapeHtml(markerLabel)}"></span>`;
}

export function renderProvinceBadgeList(state, themeIds = []) {
  const badges = themeIds
    .map((themeId) => renderProvinceBadge(state, themeId, { compact: true }))
    .filter(Boolean);
  return badges.length ? badges.join(' ') : 'none';
}

function isMentionBoundary(char) {
  return !char || !/[\p{L}\p{N}]/u.test(char);
}

function mentionFitsAt(text, token, index) {
  if (!token?.text || !text.startsWith(token.text, index)) return false;
  return isMentionBoundary(text[index - 1]) && isMentionBoundary(text[index + token.text.length]);
}

function uniqueMentionTokens(tokens) {
  const seen = new Set();
  return tokens
    .filter((token) => token?.text && token.text.trim())
    .filter((token) => {
      if (seen.has(token.text)) return false;
      seen.add(token.text);
      return true;
    })
    .sort((left, right) => right.text.length - left.text.length);
}

function buildCartoucheMentionTokens(state, options = {}) {
  if (!state) return [];
  const tokens = [];
  const variant = options.variant || 'light';
  if (options.players !== false) {
    for (const player of state.players || []) {
      const fallbackLabel = Number.isInteger(Number(player?.id)) ? `Player ${Number(player.id) + 1}` : '';
      for (const text of [formatPlayerLabel(player), player?.dynasty, fallbackLabel]) {
        if (!text) continue;
        tokens.push({
          text,
          html: () => renderPlayerChip(state, player, '', { variant }),
        });
      }
    }
  }
  if (options.provinces !== false) {
    for (const theme of Object.values(state.themes || {})) {
      if (!theme?.name) continue;
      tokens.push({
        text: theme.name,
        html: () => renderProvinceBadge(state, theme, { compact: true, variant }),
      });
    }
  }
  return uniqueMentionTokens(tokens);
}

export function renderCartouchedText(state, text, options = {}) {
  const raw = String(text ?? '');
  if (!raw) return '';
  const tokens = buildCartoucheMentionTokens(state, options);
  if (!tokens.length) return escapeHtml(raw);

  let html = '';
  let index = 0;
  while (index < raw.length) {
    const token = tokens.find((candidate) => mentionFitsAt(raw, candidate, index));
    if (token) {
      html += token.html();
      index += token.text.length;
      continue;
    }
    html += escapeHtml(raw[index]);
    index += 1;
  }
  return html;
}

// ── Title cartouche ───────────────────────────────────────────────────
//
// Rules (single source of truth):
//   • Outline color encodes the role's region:
//       BASILEUS                            → Constantinople gold
//       PATRIARCH                          → black
//       DOM_EAST / DOM_WEST / ADMIRAL      → that region's color
//       STRATEGOS / BISHOP                 → the linked land's region color
//   • Background color is the holder's dynasty color, or parchment-white
//     when the title is vacant.
//
// Default labels are provided; callers can override via options.label.

const TITLE_OUTLINE_COLORS = {
  BASILEUS: REGION_BORDER_COLORS.cpl,
  PATRIARCH: '#000000',
  DOM_EAST: REGION_BORDER_COLORS.east,
  DOM_WEST: REGION_BORDER_COLORS.west,
  ADMIRAL: REGION_BORDER_COLORS.sea,
};

const TITLE_DEFAULT_LABELS = {
  BASILEUS: 'Basileus',
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
  return getPlayer(state, holderId)?.color || '#5a3810';
}

function renderTitleBadgeMarker(kind) {
  if (kind !== 'STRATEGOS' && kind !== 'BISHOP') return '';
  const markerKind = kind.toLowerCase();
  return `<span class="title-token-mark title-token-mark-${markerKind}" aria-hidden="true"></span>`;
}

// Render a title cartouche. Callers can fold contextual land names into
// options.label when a single combined cartouche reads better.
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
  return `<span class="${classes}" style="${styleAttr}" title="${escapeHtml(text)}">${renderTitleBadgeMarker(kind)}<span class="title-token-text">${escapeHtml(text)}</span></span>`;
}

// Convenience: "<Strategos> of <Land>" or "<Bishop> of <Land>", both as
// cartouches in the established grammar. Single helper so every callsite
// renders the pairing identically.
export function renderThemeOfficeBadge(state, kind, themeId) {
  const theme = state.themes[themeId];
  if (!theme) return '';
  const officeKind = kind === 'BISHOP' ? 'bishop' : 'strategos';
  const holderId = officeKind === 'strategos' ? theme.strategos : theme.bishop;
  return renderProvinceOfficeBadge(state, officeKind, theme, {
    holderId,
    compact: true,
  });
}
