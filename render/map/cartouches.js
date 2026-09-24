// render/map/cartouches.js - province name/value cartouches and their filter markers.

import { PROVINCES } from '../../data/provinces.js';
import { formatPlayerLabel } from '../../engine/state.js';
import { buildSvgValueGroup, measureSvgValueGroupWidth, provinceValueEntries } from '../../ui/icons.js';
import { resolveProvinceOwnership } from './filters.js';
import { applyProvinceInteractionState } from './interaction.js';
import { MAP_FILTER_TO_MARKER_KIND, MAP_WIDTH, SVG_NS, mapRuntime } from './state.js';
import { applyProvincePalette } from './svgImport.js';

// Map labels are stacked SVG cartouches that mirror the HTML
// .province-token grammar: outline = darker region color, fill = light region color,
// gold inner hairline. Two lines per cartouche: name / current values,
// with an optional marker row below the values.
//
// The values line replaces the legacy "P3 T2 C1" text with three icon+number
// pairs (gold → sword → church). Zero-value entries collapse so church-only
// land shows only the church glyph.
const MAP_CART_PAD_X = 1.0;
const MAP_CART_MIN_WIDTH = 7.8;
const MAP_CART_HEIGHT = 4.7;
const MAP_CART_INSET = 0.32;
const MAP_CART_NAME_BASELINE_Y = -0.35;
const MAP_CART_VALUES_BASELINE_Y = 1.55;
const MAP_CART_MARKER_EDGE_GAP = 0.24;
const MAP_CART_MARKER_RADIUS = 0.78;
const MAP_CART_MARKER_SIZE = 1.56;
const MAP_CART_MARKERS_Y = (MAP_CART_HEIGHT / 2) + MAP_CART_MARKER_EDGE_GAP + (MAP_CART_MARKER_SIZE / 2);

const MAP_MARKER_VALUE_KIND = Object.freeze({
  estate: 'gold',
  strategos: 'troop',
  bishop: 'church',
});

const MAP_CART_VALUE_OPTS = Object.freeze({
  iconSize: 1.5,
  iconGap: 0.18,
  pairGap: 0.85,
  digitWidth: 0.66,
  baselineY: 0,
  iconY: -1.18,
});

function valueEntriesSignature(entries) {
  return entries.map((entry) => `${entry.kind[0]}${entry.value}`).join('|');
}

// Cartouche text is sized in map units, so on a small or zoomed-out map the
// names shrink below legibility. Scale each cartouche about its anchor so a
// province name renders near LABEL_TARGET_NAME_PX, capped to limit overlap.
const LABEL_NAME_FONT_UNITS = 1.45;
const LABEL_TARGET_NAME_PX = 9;
const LABEL_MAX_SCALE = 1.7;

function getLabelScale() {
  const pxPerUnit = (mapRuntime.shellWidthPx / MAP_WIDTH) * (mapRuntime.mapView?.zoom || 1);
  if (!(pxPerUnit > 0)) return 1;
  const scale = LABEL_TARGET_NAME_PX / (LABEL_NAME_FONT_UNITS * pxPerUnit);
  return Math.min(LABEL_MAX_SCALE, Math.max(1, scale));
}

const LABEL_GAP_UNITS = 0.35;

// Largest common scale at which two cartouches, each scaled about its own
// anchor, stay apart on at least one axis. Boxes are in local (unscaled) units.
function maxSeparatedScale(a, b) {
  const axis = (ac, amin, amax, bc, bmin, bmax) => {
    if (ac <= bc) {
      const spread = amax - bmin;
      return spread > 0 ? (bc - ac - LABEL_GAP_UNITS) / spread : Infinity;
    }
    const spread = bmax - amin;
    return spread > 0 ? (ac - bc - LABEL_GAP_UNITS) / spread : Infinity;
  };
  const sx = axis(a.cx, a.box.x, a.box.x + a.box.width, b.cx, b.box.x, b.box.x + b.box.width);
  const sy = axis(a.cy, a.box.y, a.box.y + a.box.height, b.cy, b.box.y, b.box.y + b.box.height);
  return Math.max(sx, sy);
}

// Enlarges every cartouche toward the target scale, but caps each pair at the
// scale where they would start to touch, so enlarging never adds overlaps.
export function applyLabelScale() {
  const root = mapRuntime.viewportLayer;
  if (!root) return;
  const target = getLabelScale();
  const labels = [...root.querySelectorAll('.map-cartouche[data-cx]')].map((g) => ({
    g,
    cx: Number(g.dataset.cx),
    cy: Number(g.dataset.cy),
    box: typeof g.getBBox === 'function' ? g.getBBox() : null,
    scale: target,
  }));
  if (target > 1.001) {
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const a = labels[i];
        const b = labels[j];
        if (!a.box || !b.box) continue;
        const limit = Math.max(1, maxSeparatedScale(a, b));
        a.scale = Math.min(a.scale, limit);
        b.scale = Math.min(b.scale, limit);
      }
    }
  }
  for (const label of labels) {
    label.g.setAttribute('transform', label.scale > 1.001
      ? `translate(${label.cx} ${label.cy}) scale(${label.scale.toFixed(3)})`
      : `translate(${label.cx} ${label.cy})`);
  }
}

export function addProvinceLabels(layer) {
  layer.replaceChildren();

  for (const province of PROVINCES) {
    const centroid = mapRuntime.provinceCentroids[province.id];
    if (!centroid) continue;

    const theme = mapRuntime.latestMapState?.themes?.[province.id] || province;
    const g = buildMapCartouche(province, centroid, theme);
    layer.appendChild(g);
    layoutMapCartouche(g);
    if (mapRuntime.latestMapState) updateMapCartoucheMarkers(g, mapRuntime.latestMapState, theme);
  }

  applyLabelScale();
  applyProvinceInteractionState();
}

function buildMapCartouche(province, centroid, theme = province) {
  const isCapital = province.id === 'CPL';
  const ownership = resolveProvinceOwnership(province.id, theme);
  const g = document.createElementNS(SVG_NS, 'g');
  const baseClasses = `map-cartouche${isCapital ? ' is-capital' : ''}`;
  g.setAttribute('class', `${baseClasses} ${ownership.classes.join(' ')}`.trim());
  g.setAttribute('data-id', province.id);
  g.dataset.cx = String(centroid.cx);
  g.dataset.cy = String(centroid.cy);
  g.setAttribute('transform', `translate(${centroid.cx} ${centroid.cy})`);

  applyProvincePalette(g, province.region);

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('class', 'map-cart-bg');
  g.appendChild(bg);

  const inner = document.createElementNS(SVG_NS, 'rect');
  inner.setAttribute('class', 'map-cart-inner');
  g.appendChild(inner);

  appendCartLine(g, 'map-cart-name', theme.name || province.name);

  // Values line: icon + number pairs replacing the old "P? T? C?" run.
  const entries = provinceValueEntries(theme);
  const valuesGroup = buildSvgValueGroup(entries, MAP_CART_VALUE_OPTS);
  valuesGroup.setAttribute('class', 'map-cart-values');
  valuesGroup.setAttribute('transform', `translate(0 ${MAP_CART_VALUES_BASELINE_Y})`);
  valuesGroup.setAttribute('data-values-sig', valueEntriesSignature(entries));
  g.appendChild(valuesGroup);

  const markersGroup = document.createElementNS(SVG_NS, 'g');
  markersGroup.setAttribute('class', 'map-cart-markers');
  markersGroup.setAttribute('transform', `translate(0 ${MAP_CART_MARKERS_Y})`);
  markersGroup.setAttribute('data-marker-sig', '');
  g.appendChild(markersGroup);

  return g;
}

function appendCartLine(parent, className, text) {
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('class', className);
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('x', 0);
  t.textContent = text;
  parent.appendChild(t);
  return t;
}

function layoutMapCartouche(g) {
  const bg = g.querySelector('.map-cart-bg');
  const inner = g.querySelector('.map-cart-inner');
  const nameText = g.querySelector('.map-cart-name');
  const valuesGroup = g.querySelector('.map-cart-values');
  const markersGroup = g.querySelector('.map-cart-markers');
  if (!bg || !inner || !nameText) return;

  // Use normal alphabetic baselines. Firefox handles SVG baseline keywords
  // differently, so fixed baseline coordinates keep the text stable.
  nameText.setAttribute('y', MAP_CART_NAME_BASELINE_Y);

  const provinceId = g.getAttribute('data-id');
  const theme = mapRuntime.latestMapState?.themes?.[provinceId];
  const valuesEntries = theme ? provinceValueEntries(theme).filter((e) => e.value > 0) : [];
  const valuesWidth = measureSvgValueGroupWidth(valuesEntries, MAP_CART_VALUE_OPTS);

  const width = Math.max(
    MAP_CART_MIN_WIDTH,
    measureMapTextWidth(nameText) + MAP_CART_PAD_X * 2,
    valuesWidth + MAP_CART_PAD_X * 2,
  );
  const height = MAP_CART_HEIGHT;

  bg.setAttribute('x', (-width / 2).toFixed(3));
  bg.setAttribute('y', (-height / 2).toFixed(3));
  bg.setAttribute('width', width.toFixed(3));
  bg.setAttribute('height', height.toFixed(3));
  bg.setAttribute('rx', '0.45');

  // Gold-leaf inner hairline, inset slightly inside the role outline.
  inner.setAttribute('x', (-width / 2 + MAP_CART_INSET).toFixed(3));
  inner.setAttribute('y', (-height / 2 + MAP_CART_INSET).toFixed(3));
  inner.setAttribute('width', (width - MAP_CART_INSET * 2).toFixed(3));
  inner.setAttribute('height', (height - MAP_CART_INSET * 2).toFixed(3));
  inner.setAttribute('rx', '0.25');

  // Re-place the values group on its baseline (group is centered at x=0 by
  // construction in buildSvgValueGroup).
  if (valuesGroup) {
    valuesGroup.setAttribute('transform', `translate(0 ${MAP_CART_VALUES_BASELINE_Y})`);
  }
  if (markersGroup) {
    markersGroup.setAttribute('transform', `translate(0 ${MAP_CART_MARKERS_Y})`);
  }
}

function measureMapTextWidth(textElement) {
  try {
    const computedLength = textElement.getComputedTextLength?.();
    if (Number.isFinite(computedLength) && computedLength > 0) return computedLength;

    const bboxWidth = textElement.getBBox?.().width;
    if (Number.isFinite(bboxWidth) && bboxWidth > 0) return bboxWidth;
  } catch {
    // Fall through to deterministic estimate.
  }

  const fontSize = textElement.classList.contains('map-cart-values') ? 1.15 : 1.45;
  return estimateTextWidth(textElement.textContent || '', fontSize);
}

function estimateTextWidth(text, fontSize) {
  let units = 0;

  for (const char of text) {
    if (/\s/.test(char)) {
      units += 0.32;
    } else if (/[MW]/.test(char)) {
      units += 0.82;
    } else if (/[A-Z0-9]/.test(char)) {
      units += 0.62;
    } else if (/[ilI.,:;]/.test(char)) {
      units += 0.32;
    } else {
      units += 0.52;
    }
  }

  return units * fontSize;
}

export function updateMapCartoucheValues(cart, theme) {
  if (!cart || !theme) return;

  const nameText = cart.querySelector('.map-cart-name');
  const valuesGroup = cart.querySelector('.map-cart-values');
  let changed = false;

  const nextName = theme.name || theme.id || '';
  if (nameText && nameText.textContent !== nextName) {
    nameText.textContent = nextName;
    changed = true;
  }

  const entries = provinceValueEntries(theme);
  const nextSig = valueEntriesSignature(entries);
  const prevSig = valuesGroup?.getAttribute('data-values-sig');
  if (valuesGroup && nextSig !== prevSig) {
    // Rebuild the icon+number group in place (cheap — at most 3 pairs).
    const rebuilt = buildSvgValueGroup(entries, MAP_CART_VALUE_OPTS);
    rebuilt.setAttribute('class', 'map-cart-values');
    rebuilt.setAttribute('transform', `translate(0 ${MAP_CART_VALUES_BASELINE_Y})`);
    rebuilt.setAttribute('data-values-sig', nextSig);
    valuesGroup.replaceWith(rebuilt);
    changed = true;
  }

  if (changed) layoutMapCartouche(cart);
}

export function updateMapCartoucheMarkers(cart, state, theme) {
  const markersGroup = cart?.querySelector?.('.map-cart-markers');
  if (!markersGroup || !state || !theme) return;

  const valuePositions = getMapValuePairCenters(cart, provinceValueEntries(theme));
  const markers = getMapCartoucheMarkers(state, theme, valuePositions);
  const nextSig = markers.map((marker) => `${marker.kind}:${marker.ownerId}:${marker.color}:${marker.x.toFixed(3)}:${marker.promoted ? 'promoted' : 'normal'}`).join('|');
  if (markersGroup.getAttribute('data-marker-sig') === nextSig) return;

  markersGroup.replaceChildren();
  markersGroup.setAttribute('data-marker-sig', nextSig);

  markers.forEach((marker) => {
    markersGroup.appendChild(createMapCartoucheMarker(marker));
  });

  layoutMapCartouche(cart);
}

function getRenderedMapValuePairCenters(cart) {
  const valuesGroup = cart?.querySelector?.('.map-cart-values');
  const centers = new Map();
  if (!valuesGroup) return centers;

  for (const kind of Object.values(MAP_MARKER_VALUE_KIND)) {
    const icon = valuesGroup.querySelector(`.map-cart-glyph-${kind}`);
    const num = valuesGroup.querySelector(`.map-cart-glyph-num-${kind}`);
    if (!icon || !num) continue;

    const left = Number(icon.getAttribute('x'));
    const iconWidth = Number(icon.getAttribute('width'));
    const numX = Number(num.getAttribute('x'));
    if (!Number.isFinite(left) || !Number.isFinite(iconWidth) || !Number.isFinite(numX)) continue;

    let numWidth = 0;
    try {
      const measured = num.getComputedTextLength?.();
      if (Number.isFinite(measured) && measured > 0) numWidth = measured;
    } catch {
      // Fall back to deterministic sizing below.
    }
    if (numWidth <= 0) {
      try {
        const bboxWidth = num.getBBox?.().width;
        if (Number.isFinite(bboxWidth) && bboxWidth > 0) numWidth = bboxWidth;
      } catch {
        // Fall back to deterministic sizing below.
      }
    }
    if (numWidth <= 0) {
      const digits = Math.max(1, String(num.textContent || '').length);
      numWidth = digits * MAP_CART_VALUE_OPTS.digitWidth;
    }

    centers.set(kind, (left + Math.max(left + iconWidth, numX + numWidth)) / 2);
  }

  return centers;
}

function estimateMapValuePairCenters(entries) {
  const iconSize = MAP_CART_VALUE_OPTS.iconSize;
  const iconGap = MAP_CART_VALUE_OPTS.iconGap;
  const pairGap = MAP_CART_VALUE_OPTS.pairGap;
  const digitWidth = MAP_CART_VALUE_OPTS.digitWidth;

  const pairs = entries
    .filter((entry) => entry && entry.value > 0)
    .map((entry) => {
      const digits = Math.max(1, String(entry.value).length);
      const width = iconSize + iconGap + digits * digitWidth;
      return { kind: entry.kind, width };
    });

  const totalWidth = pairs.reduce((sum, pair) => sum + pair.width, 0)
    + Math.max(0, pairs.length - 1) * pairGap;
  const centers = new Map();
  let cursor = -totalWidth / 2;

  for (const pair of pairs) {
    centers.set(pair.kind, cursor + pair.width / 2);
    cursor += pair.width + pairGap;
  }

  return centers;
}

function getMapValuePairCenters(cart, entries) {
  const rendered = getRenderedMapValuePairCenters(cart);
  const estimated = estimateMapValuePairCenters(entries);
  for (const [kind, x] of estimated) {
    if (!rendered.has(kind)) rendered.set(kind, x);
  }
  return rendered;
}

function getMapCartoucheMarkers(state, theme, valuePositions) {
  const markers = [];
  const promotedKind = MAP_FILTER_TO_MARKER_KIND[mapRuntime.activeMapFilter] || null;

  if (!theme.occupied && theme.owner !== null && theme.owner !== 'church') {
    markers.push(createMapCartoucheMarkerData(state, 'estate', theme.owner, 'Private estate', valuePositions, { promoted: promotedKind === 'estate' }));
  }
  if (!theme.occupied && theme.strategos !== null) {
    markers.push(createMapCartoucheMarkerData(state, 'strategos', theme.strategos, 'Strategos', valuePositions, { promoted: promotedKind === 'strategos' }));
  }
  if (theme.bishop !== null) {
    markers.push(createMapCartoucheMarkerData(state, 'bishop', theme.bishop, 'Bishop', valuePositions, { promoted: promotedKind === 'bishop' }));
  }

  return markers.filter(Boolean);
}

function createMapCartoucheMarkerData(state, kind, ownerId, label, valuePositions, options = {}) {
  const player = state.players.find((candidate) => candidate.id === ownerId);
  if (!player) return null;
  const x = valuePositions.get(MAP_MARKER_VALUE_KIND[kind]);
  if (!Number.isFinite(x)) return null;
  const ownerName = formatPlayerLabel(player) || `Player ${Number(ownerId) + 1}`;
  return {
    kind,
    ownerId,
    x,
    color: player.color || '#5a3810',
    title: `${label}: ${ownerName}`,
    promoted: Boolean(options.promoted),
  };
}

function createMapCartoucheMarker(marker) {
  const shape = marker.kind === 'estate'
    ? createMapCartoucheCircleMarker(marker.x, marker.promoted)
    : marker.kind === 'strategos'
      ? createMapCartoucheSquareMarker(marker.x, marker.promoted)
      : createMapCartoucheTriangleMarker(marker.x, marker.promoted);

  shape.setAttribute('class', `map-cart-marker map-cart-marker-${marker.kind}${marker.promoted ? ' promoted' : ''}`);
  shape.style.fill = marker.color;

  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = marker.title;
  shape.appendChild(title);
  return shape;
}

function createMapCartoucheCircleMarker(x, promoted = false) {
  const shape = document.createElementNS(SVG_NS, 'circle');
  shape.setAttribute('cx', x.toFixed(3));
  shape.setAttribute('cy', '0');
  shape.setAttribute('r', String(promoted ? MAP_CART_MARKER_RADIUS * 1.32 : MAP_CART_MARKER_RADIUS));
  return shape;
}

function createMapCartoucheSquareMarker(x, promoted = false) {
  const shape = document.createElementNS(SVG_NS, 'rect');
  const size = promoted ? MAP_CART_MARKER_SIZE * 1.32 : MAP_CART_MARKER_SIZE;
  shape.setAttribute('x', (x - size / 2).toFixed(3));
  shape.setAttribute('y', (-size / 2).toFixed(3));
  shape.setAttribute('width', String(size));
  shape.setAttribute('height', String(size));
  shape.setAttribute('rx', '0.04');
  return shape;
}

function createMapCartoucheTriangleMarker(x, promoted = false) {
  const size = promoted ? MAP_CART_MARKER_SIZE * 1.32 : MAP_CART_MARKER_SIZE;
  const half = size / 2;
  const top = -half;
  const bottom = half;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    [
      `M ${x.toFixed(3)} ${top.toFixed(3)}`,
      `L ${(x + half).toFixed(3)} ${bottom.toFixed(3)}`,
      `L ${(x - half).toFixed(3)} ${bottom.toFixed(3)}`,
      'Z',
    ].join(' '),
  );
  return path;
}
