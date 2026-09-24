// render/map/cartouches.js - province name cartouches and their holdings row.

import { PROVINCES } from '../../data/provinces.js';
import { getProvinceEstateHolders } from '../../engine/estates.js';
import { formatPlayerLabel } from '../../engine/state.js';
import { resolveProvinceOwnership } from './filters.js';
import { applyProvinceInteractionState } from './interaction.js';
import { MAP_FILTER_TO_MARKER_KIND, MAP_WIDTH, SVG_NS, mapRuntime } from './state.js';
import { applyProvincePalette } from './svgImport.js';

// Map labels are stacked SVG cartouches that mirror the HTML .province-token
// grammar: outline = darker region colour, fill = light region colour, gold
// inner hairline. Two lines: the province name, then what the province holds:
//
//   (3)(1)  one circle per dynasty with estates there, its count inside
//   [ ]     the Strategos seat, filled with the holder's colour or hollow
//   /\      the Bishop seat, only in bishoprics, filled or hollow
//
// Holdings of a lost province stay drawn, faded and dashed: they come back
// to their holders when the province is reconquered.
const MAP_CART_PAD_X = 1.0;
const MAP_CART_MIN_WIDTH = 7.8;
const MAP_CART_HEIGHT = 4.7;
const MAP_CART_INSET = 0.32;
const MAP_CART_NAME_BASELINE_Y = -0.35;
const MAP_CART_ROW_Y = 1.15;
const MARKER_RADIUS = 0.72;
const MARKER_SIZE = 1.3;
const MARKER_GAP = 0.3;
const MAX_ESTATE_CIRCLES = 4;
const PROMOTED_SCALE = 1.25;

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

  const markersGroup = document.createElementNS(SVG_NS, 'g');
  markersGroup.setAttribute('class', 'map-cart-markers');
  markersGroup.setAttribute('transform', `translate(0 ${MAP_CART_ROW_Y})`);
  markersGroup.setAttribute('data-marker-sig', '');
  markersGroup.dataset.width = '0';
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
  const markersGroup = g.querySelector('.map-cart-markers');
  if (!bg || !inner || !nameText) return;

  // Use normal alphabetic baselines. Firefox handles SVG baseline keywords
  // differently, so fixed baseline coordinates keep the text stable.
  nameText.setAttribute('y', MAP_CART_NAME_BASELINE_Y);
  const markersWidth = Number(markersGroup?.dataset?.width) || 0;

  const width = Math.max(
    MAP_CART_MIN_WIDTH,
    measureMapTextWidth(nameText) + MAP_CART_PAD_X * 2,
    markersWidth + MAP_CART_PAD_X * 2,
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

  if (markersGroup) markersGroup.setAttribute('transform', `translate(0 ${MAP_CART_ROW_Y})`);
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
  const nextName = theme.name || theme.id || '';
  if (nameText && nameText.textContent !== nextName) {
    nameText.textContent = nextName;
    layoutMapCartouche(cart);
  }
}

export function updateMapCartoucheMarkers(cart, state, theme) {
  const markersGroup = cart?.querySelector?.('.map-cart-markers');
  if (!markersGroup || !state || !theme) return;

  const markers = layoutMarkers(getMapCartoucheMarkers(state, theme));
  const nextSig = markers
    .map((marker) => `${marker.kind}:${marker.ownerId ?? '-'}:${marker.count ?? ''}:${marker.color}:${marker.promoted ? 'p' : ''}:${marker.disabled ? 'd' : ''}:${marker.vacant ? 'v' : ''}`)
    .join('|');
  if (markersGroup.getAttribute('data-marker-sig') === nextSig) return;

  markersGroup.replaceChildren();
  markersGroup.setAttribute('data-marker-sig', nextSig);
  markersGroup.dataset.width = String(markers.totalWidth || 0);
  markers.forEach((marker) => markersGroup.appendChild(createMapCartoucheMarker(marker)));

  layoutMapCartouche(cart);
}

function playerLabel(state, playerId) {
  const player = state.players.find((candidate) => candidate.id === playerId);
  return { player, name: formatPlayerLabel(player) || `Player ${Number(playerId) + 1}` };
}

function getMapCartoucheMarkers(state, theme) {
  if (theme.id === 'CPL') return [];
  const markers = [];
  const promotedKind = MAP_FILTER_TO_MARKER_KIND[mapRuntime.activeMapFilter] || null;
  const disabled = Boolean(theme.lost);
  const lostNote = disabled ? ' (lost province: not working until reconquered)' : '';

  const holders = getProvinceEstateHolders(theme);
  const shown = holders.length > MAX_ESTATE_CIRCLES ? holders.slice(0, MAX_ESTATE_CIRCLES - 1) : holders;
  for (const holder of shown) {
    const { player, name } = playerLabel(state, holder.playerId);
    markers.push({
      kind: 'estate',
      ownerId: holder.playerId,
      count: holder.count,
      color: player?.color || '#5a3810',
      title: `${name}: ${holder.count} estate${holder.count === 1 ? '' : 's'}${lostNote}`,
      promoted: promotedKind === 'estate',
      disabled,
    });
  }
  if (shown.length < holders.length) {
    const rest = holders.slice(shown.length);
    const restCount = rest.reduce((total, entry) => total + entry.count, 0);
    markers.push({
      kind: 'estate',
      ownerId: null,
      count: restCount,
      color: '#8c7a5c',
      title: rest.map((entry) => `${playerLabel(state, entry.playerId).name}: ${entry.count}`).join(', '),
      promoted: promotedKind === 'estate',
      disabled,
      overflow: true,
    });
  }

  const strategos = theme.strategos == null ? null : playerLabel(state, theme.strategos);
  markers.push({
    kind: 'strategos',
    ownerId: theme.strategos ?? null,
    color: strategos?.player?.color || 'transparent',
    title: strategos ? `Strategos: ${strategos.name}${lostNote}` : 'No Strategos',
    promoted: promotedKind === 'strategos',
    disabled: disabled && Boolean(strategos),
    vacant: !strategos,
  });

  if ((Number(theme.C) || 0) > 0) {
    const bishop = theme.bishop == null ? null : playerLabel(state, theme.bishop);
    markers.push({
      kind: 'bishop',
      ownerId: theme.bishop ?? null,
      color: bishop?.player?.color || 'transparent',
      title: bishop ? `Bishop: ${bishop.name}` : 'Bishopric: no Bishop',
      promoted: promotedKind === 'bishop',
      vacant: !bishop,
    });
  }
  return markers;
}

function markerWidth(marker) {
  const scale = marker.promoted ? PROMOTED_SCALE : 1;
  return (marker.kind === 'estate' ? MARKER_RADIUS * 2 : MARKER_SIZE) * scale;
}

// Lays the markers out left to right, centred under the name.
function layoutMarkers(markers) {
  const widths = markers.map(markerWidth);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, markers.length - 1) * MARKER_GAP;
  let cursor = -totalWidth / 2;
  const laid = markers.map((marker, index) => {
    const x = cursor + widths[index] / 2;
    cursor += widths[index] + MARKER_GAP;
    return { ...marker, x };
  });
  laid.totalWidth = totalWidth;
  return laid;
}

function createMapCartoucheMarker(marker) {
  const scale = marker.promoted ? PROMOTED_SCALE : 1;
  const group = document.createElementNS(SVG_NS, 'g');
  const classes = [
    'map-cart-marker',
    `map-cart-marker-${marker.kind}`,
    marker.promoted ? 'promoted' : '',
    marker.disabled ? 'disabled' : '',
    marker.vacant ? 'vacant' : '',
    marker.overflow ? 'overflow' : '',
  ].filter(Boolean).join(' ');
  group.setAttribute('class', classes);
  group.setAttribute('transform', `translate(${marker.x.toFixed(3)} 0)`);

  const shape = marker.kind === 'estate'
    ? createCircle(MARKER_RADIUS * scale)
    : marker.kind === 'strategos'
      ? createSquare(MARKER_SIZE * scale)
      : createTriangle(MARKER_SIZE * scale);
  shape.setAttribute('class', 'map-cart-marker-shape');
  if (!marker.vacant) shape.style.fill = marker.color;
  group.appendChild(shape);

  if (marker.kind === 'estate') {
    const count = document.createElementNS(SVG_NS, 'text');
    count.setAttribute('class', 'map-cart-marker-count');
    count.setAttribute('text-anchor', 'middle');
    count.setAttribute('x', '0');
    count.setAttribute('y', (0.36 * scale).toFixed(3));
    count.textContent = marker.overflow ? `+${marker.count}` : String(marker.count);
    group.appendChild(count);
  }

  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = marker.title;
  group.appendChild(title);
  return group;
}

function createCircle(radius) {
  const shape = document.createElementNS(SVG_NS, 'circle');
  shape.setAttribute('cx', '0');
  shape.setAttribute('cy', '0');
  shape.setAttribute('r', radius.toFixed(3));
  return shape;
}

function createSquare(size) {
  const shape = document.createElementNS(SVG_NS, 'rect');
  shape.setAttribute('x', (-size / 2).toFixed(3));
  shape.setAttribute('y', (-size / 2).toFixed(3));
  shape.setAttribute('width', size.toFixed(3));
  shape.setAttribute('height', size.toFixed(3));
  shape.setAttribute('rx', '0.08');
  return shape;
}

function createTriangle(size) {
  const half = size / 2;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', `M 0 ${(-half).toFixed(3)} L ${half.toFixed(3)} ${half.toFixed(3)} L ${(-half).toFixed(3)} ${half.toFixed(3)} Z`);
  return path;
}
