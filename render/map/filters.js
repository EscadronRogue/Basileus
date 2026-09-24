// render/map/filters.js - map filters and per-state province styling, threats, and badges.

import {
  buildProvinceChurchAttributions,
  buildProvinceEstateAttributions,
  buildProvinceTroopAttributions,
} from '../../engine/cascade.js';
import { getThreatenedThemeIds } from '../../engine/rules.js';
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
  updateBadges(state);
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
  if (filterId === MAP_FILTERS.ESTATES) return buildProvinceEstateAttributions(state);
  if (filterId === MAP_FILTERS.STRATEGOI) return buildProvinceTroopAttributions(state);
  if (filterId === MAP_FILTERS.BISHOPS) return buildProvinceChurchAttributions(state);
  return {};
}

function resolveProvinceFilterStyle(state, theme, attribution) {
  if (mapRuntime.activeMapFilter === MAP_FILTERS.REGIONS) return null;
  if (!theme || theme.id === 'CPL' || !attribution || attribution.playerId == null) {
    return {
      classes: ['map-filtered', 'map-filter-neutral'],
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
  const direct = Boolean(attribution.direct);
  return {
    classes: ['map-filtered', direct ? 'map-filter-direct' : 'map-filter-indirect'],
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
  const withChurchMarker = (classes) => (
    (Number(theme.C) || 0) > 0 ? [...classes, 'has-church'] : classes
  );
  if (theme.occupied) {
    return { classes: withChurchMarker(['occupied']) };
  }
  if (theme.owner === 'church') {
    return { classes: withChurchMarker(['imperial', 'church']) };
  }
  if (theme.owner !== null) {
    return { classes: withChurchMarker(['imperial', 'owned']) };
  }
  if (provinceId === 'CPL') {
    return { classes: withChurchMarker(['imperial', 'capital']) };
  }
  return { classes: withChurchMarker(['imperial', 'free']) };
}

function updateThreatOverlay(state) {
  const threatenedIds = new Set(getThreatenedThemeIds(state));
  document.querySelectorAll('.province-threat-overlay').forEach((path) => {
    const provinceId = path.getAttribute('data-id');
    const theme = provinceId ? state.themes[provinceId] : null;
    const active = provinceId && threatenedIds.has(provinceId) && theme && !theme.occupied;
    path.classList.toggle('active', Boolean(active));
  });
}

function updateBadges(state) {
  const layer = document.getElementById('layer-badges');
  if (!layer) return;

  layer.replaceChildren();

  for (const [provinceId, theme] of Object.entries(state.themes)) {
    const centroid = mapRuntime.provinceCentroids[provinceId];
    if (!centroid) continue;

    if (theme.occupied && theme.suspendedOwner !== null) {
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const x = centroid.cx;
      const y = centroid.cy - 3.2;
      badge.setAttribute('d', `M ${x.toFixed(2)} ${y.toFixed(2)} L ${(x + 1.0).toFixed(2)} ${(y + 1.5).toFixed(2)} L ${(x - 1.0).toFixed(2)} ${(y + 1.5).toFixed(2)} Z`);
      badge.setAttribute('class', 'officer-badge suspended-owner-chevron');
      const player = state.players.find((candidate) => candidate.id === theme.suspendedOwner);
      if (player) badge.style.fill = player.color;
      badge.style.stroke = '#000';
      badge.style.strokeWidth = '0.15';
      layer.appendChild(badge);
    }

  }
}
