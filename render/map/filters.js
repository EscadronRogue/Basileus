// render/map/filters.js - map filters and per-state province styling, threats, and badges.

import {
  buildProvinceChurchAttributions,
  buildProvinceEstateAttributions,
  buildProvinceTroopAttributions,
} from '../../engine/cascade.js';
import { buildInvasionLadder } from '../../engine/combat.js';
import { getThreatenedThemeIds } from '../../engine/rules.js';
import { getProvinceEstateTotal } from '../../engine/estates.js';
import { applyLabelScale, updateMapCartoucheMarkers, updateMapCartoucheValues } from './cartouches.js';
import { applyProvinceInteractionState } from './interaction.js';
import { FILTER_VISUAL_PROPS, MAP_FILTERS, mapRuntime } from './state.js';

export function normalizeMapFilter(filterId) {
  return Object.values(MAP_FILTERS).includes(filterId) ? filterId : MAP_FILTERS.REGIONS;
}

export function setActiveMapFilter(filterId) {
  mapRuntime.activeMapFilter = normalizeMapFilter(filterId);
  updateMapFilterControlState();
}

export function updateMapFilterControlState(root = (typeof document !== 'undefined' ? document : null)) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('[data-map-filter]').forEach((button) => {
    const active = button.dataset.mapFilter === mapRuntime.activeMapFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

export function updateMapState(state, mapFilter = mapRuntime.activeMapFilter) {
  mapRuntime.latestMapState = state;
  setActiveMapFilter(mapFilter);
  const mapSvg = typeof document !== 'undefined' ? document.getElementById('gameMap') : null;
  applyMapFilterClass(mapSvg, mapRuntime.activeMapFilter);
  const filterAttributions = buildMapFilterAttributions(state, mapRuntime.activeMapFilter);

  for (const [provinceId, theme] of Object.entries(state.themes)) {
    const shape = document.querySelector(`.province-shape[data-id="${provinceId}"]`);
    const regionStroke = document.querySelector(`.region-stroke[data-id="${provinceId}"]`);
    const cart = document.querySelector(`.map-cartouche[data-id="${provinceId}"]`);

    const ownership = resolveProvinceOwnership(provinceId, theme);
    const filterStyle = resolveProvinceFilterStyle(state, theme, filterAttributions[provinceId]);
    const filterClasses = filterStyle?.classes || [];

    // Default map keeps the province region palette; active filters recolor
    // the land while the cartouche markers keep local title ownership visible.
    if (shape) {
      shape.className.baseVal = `province-shape province-${provinceId} ${ownership.classes.join(' ')} ${filterClasses.join(' ')}`.trim();
      applyProvinceFilterStyle(shape, filterStyle);
    }
    if (regionStroke) {
      regionStroke.className.baseVal = `region-stroke province-${provinceId} ${ownership.classes.join(' ')} ${filterClasses.join(' ')}`.trim();
      applyProvinceFilterStyle(regionStroke, filterStyle);
    }

    // Map cartouche follows the same region palette as the province.
    if (cart) {
      updateMapCartoucheValues(cart, theme);
      updateMapCartoucheMarkers(cart, state, theme);
      const baseClasses = `map-cartouche${provinceId === 'CPL' ? ' is-capital' : ''}`;
      cart.className.baseVal = `${baseClasses} ${ownership.classes.join(' ')} ${filterClasses.join(' ')}`.trim();
      applyProvinceFilterStyle(cart, filterStyle);
    }
  }

  updateThreatOverlay(state);
  updateBadges();
  applyLabelScale();
  applyProvinceInteractionState();
}

function applyMapFilterClass(svg, filterId) {
  if (!svg?.classList) return;
  for (const value of Object.values(MAP_FILTERS)) {
    svg.classList.toggle(`map-filter-${value}`, value === filterId);
  }
}

function buildMapFilterAttributions(state, filterId) {
  if (filterId === MAP_FILTERS.INVASION) return buildInvasionFilterAttributions(state);
  if (filterId === MAP_FILTERS.ESTATES) return buildProvinceEstateAttributions(state);
  if (filterId === MAP_FILTERS.STRATEGOI) return buildProvinceTroopAttributions(state);
  if (filterId === MAP_FILTERS.BISHOPS) return buildProvinceChurchAttributions(state);
  return {};
}

// Invasion filter: provinces on the route in red, the deepest red for the
// first ones the invader would take; lost provinces in grey.
function buildInvasionFilterAttributions(state) {
  const attributions = {};
  for (const theme of Object.values(state.themes || {})) {
    if (theme.lost) attributions[theme.id] = { invasion: 'lost' };
  }
  const steps = buildInvasionLadder(state, state.currentInvasion?.route || []).filter((step) => step.status !== 'lost');
  steps.forEach((step, index) => {
    attributions[step.themeId] = { invasion: 'route', order: index, count: steps.length };
  });
  return attributions;
}

function resolveInvasionFilterStyle(attribution) {
  if (attribution?.invasion === 'lost') {
    return {
      classes: ['map-filtered', 'map-filter-lost'],
      fill: '#8d8478',
      outline: 'rgba(46,30,15,0.5)',
      cartFill: '#6f675c',
      cartOutline: 'rgba(46,30,15,0.6)',
      cartInk: '#ffffff',
    };
  }
  if (attribution?.invasion === 'route') {
    const share = attribution.count > 1 ? attribution.order / (attribution.count - 1) : 0;
    const strength = Math.round(85 - share * 50);
    const color = `color-mix(in srgb, #a03030 ${strength}%, #fff4e8 ${100 - strength}%)`;
    return {
      classes: ['map-filtered', 'map-filter-route'],
      fill: color,
      outline: '#a03030',
      cartFill: color,
      cartOutline: '#a03030',
      cartInk: strength > 55 ? '#ffffff' : 'var(--umber-1)',
    };
  }
  return {
    classes: ['map-filtered', 'map-filter-neutral'],
    fill: '#ffffff',
    outline: 'rgba(46,30,15,0.22)',
    cartFill: '#ffffff',
    cartOutline: 'rgba(46,30,15,0.30)',
    cartInk: 'var(--umber-1)',
  };
}

function resolveProvinceFilterStyle(state, theme, attribution) {
  if (mapRuntime.activeMapFilter === MAP_FILTERS.REGIONS) return null;
  if (mapRuntime.activeMapFilter === MAP_FILTERS.INVASION) return resolveInvasionFilterStyle(attribution);
  if (!theme || theme.id === 'CPL' || !attribution || attribution.playerId == null) {
    return {
      classes: ['map-filtered', 'map-filter-neutral', attribution?.tied ? 'map-filter-tied' : ''].filter(Boolean),
      fill: '#ffffff',
      outline: 'rgba(46,30,15,0.22)',
      cartFill: '#ffffff',
      cartOutline: 'rgba(46,30,15,0.30)',
      cartInk: 'var(--umber-1)',
    };
  }

  const player = state.players.find((candidate) => candidate.id === attribution.playerId);
  if (!player) {
    return {
      classes: ['map-filtered', 'map-filter-neutral'],
      fill: '#ffffff',
      outline: 'rgba(46,30,15,0.22)',
      cartFill: '#ffffff',
      cartOutline: 'rgba(46,30,15,0.30)',
      cartInk: 'var(--umber-1)',
    };
  }

  const color = player.color || '#5a3810';
  // A lost province keeps its holder on record: shown in a faded colour.
  if (attribution.disabled) {
    const faded = `color-mix(in srgb, ${color} 38%, #d8cfbf 62%)`;
    return {
      classes: ['map-filtered', 'map-filter-disabled'],
      fill: faded,
      outline: color,
      cartFill: faded,
      cartOutline: color,
      cartInk: 'var(--umber-1)',
    };
  }
  return {
    classes: ['map-filtered', 'map-filter-direct'],
    fill: color,
    outline: color,
    cartFill: color,
    cartOutline: color,
    cartInk: '#ffffff',
  };
}

function applyProvinceFilterStyle(element, filterStyle) {
  if (!element?.style) return;
  FILTER_VISUAL_PROPS.forEach((property) => element.style.removeProperty(property));
  if (!filterStyle) return;
  if (filterStyle.fill) element.style.setProperty('--province-filter-fill-color', filterStyle.fill);
  if (filterStyle.outline) element.style.setProperty('--province-filter-outline-color', filterStyle.outline);
  if (filterStyle.cartFill) element.style.setProperty('--province-filter-cartouche-fill-color', filterStyle.cartFill);
  if (filterStyle.cartOutline) element.style.setProperty('--province-filter-cartouche-border-color', filterStyle.cartOutline);
  if (filterStyle.cartInk) element.style.setProperty('--province-filter-cartouche-ink-color', filterStyle.cartInk);
}

// Single source of truth for the ownership-derived state class set used by
// both the province shape and the map cartouche (and shared with the HTML
// .province-token via data/style conventions).
export function resolveProvinceOwnership(provinceId, theme) {
  const classes = [];
  if (theme.lost) classes.push('lost');
  else classes.push('imperial', provinceId === 'CPL' ? 'capital' : 'province');
  if ((Number(theme.C) || 0) > 0) classes.push('has-church');
  if (getProvinceEstateTotal(theme) > 0) classes.push('has-estates');
  return { classes };
}

function updateThreatOverlay(state) {
  const threatenedIds = new Set(getThreatenedThemeIds(state));
  document.querySelectorAll('.province-threat-overlay').forEach((path) => {
    const provinceId = path.getAttribute('data-id');
    const theme = provinceId ? state.themes[provinceId] : null;
    const active = provinceId && threatenedIds.has(provinceId) && theme && !theme.lost;
    path.classList.toggle('active', Boolean(active));
  });
}

function updateBadges() {
  document.getElementById('layer-badges')?.replaceChildren();
}
