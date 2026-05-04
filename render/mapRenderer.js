import { PROVINCES } from '../data/provinces.js';
import { getProvinceOwnerColor, getRegionColor } from '../ui/labels.js';
import { getThreatenedThemeIds } from '../engine/rules.js';
import { HITZONES_SVG, MAP_BACKGROUND_SVG } from './svgAssets.js';
import {
  INVASION_ORIGIN_POINT_FALLBACKS,
  INVASION_ORIGIN_POINT_IDS,
  getInvasionOriginFallbackPoint,
  getProvinceLabelPoint,
} from '../data/mapPoints.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const THREAT_HATCH_SPACING = 3.6;
const THREAT_HATCH_PRIMARY_STROKE = 1.4;
const THREAT_HATCH_SECONDARY_STROKE = 0.7;
const MIN_THREAT_HATCH_SCALE = 0.001;
const MIN_MAP_ZOOM = 1;
const MAX_MAP_ZOOM = 4;
const MAP_ZOOM_STEP = 1.2;
const MAP_VIEWBOX_WIDTH = 297;
const MAP_VIEWBOX_HEIGHT = 210;

// Region outlines are rendered in their own layer and clipped to each
// province interior. The stroke itself is drawn at double the visible width,
// so clipping it to the province makes the outline behave like an inset inner
// stroke whose outer edge sits exactly on the true border. That way adjacent
// provinces both remain visible at shared edges with no gap between them.

let provinceCentroids = {};
let provinceSelectHandler = null;
let hoveredProvinceId = null;
let viewportLayer = null;
let invasionOriginPoints = {};
let mapView = { zoom: 1, panX: 0, panY: 0 };
let panState = {
  active: false,
  pointerId: null,
  startClientX: 0,
  startClientY: 0,
  startPanX: 0,
  startPanY: 0,
  moved: false,
  suppressClick: false,
};

export async function createMapSVG(containerId, options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return null;

  provinceSelectHandler = options.onProvinceSelect || null;
  provinceCentroids = {};
  hoveredProvinceId = null;
  viewportLayer = null;
  mapView = { zoom: 1, panX: 0, panY: 0 };
  panState = {
    active: false,
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    moved: false,
    suppressClick: false,
  };
  invasionOriginPoints = buildInvasionOriginPointsFromHitzones(HITZONES_SVG);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 297 210');
  svg.setAttribute('class', 'game-map');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('overflow', 'hidden');
  svg.id = 'gameMap';
  svg.innerHTML = `
    <defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="1.5" result="blur"/>
        <feComposite in="SourceGraphic" in2="blur" operator="over"/>
      </filter>
      <clipPath id="map-frame-clip">
        <rect width="297" height="210" rx="5" ry="5"/>
      </clipPath>
    </defs>
  `;

  svg.addEventListener('pointermove', (event) => {
    if (panState.active) {
      updateMapPan(svg, event);
      return;
    }

    const provinceId = findProvinceAtClientPoint(svg, event.clientX, event.clientY);
    updateHoveredProvince(provinceId);
    updateMapCursor(svg, provinceId);
  });

  svg.addEventListener('pointerdown', (event) => beginMapPan(svg, event));
  svg.addEventListener('pointerup', (event) => endMapPan(svg, event));
  svg.addEventListener('pointercancel', (event) => endMapPan(svg, event));
  svg.addEventListener('wheel', (event) => zoomMapAtPoint(svg, event), { passive: false });
  svg.addEventListener('dblclick', (event) => {
    event.preventDefault();
    resetMapView(svg);
  });

  svg.addEventListener('mouseleave', () => {
    updateHoveredProvince(null);
    updateMapCursor(svg, null);
  });

  svg.addEventListener('click', (event) => {
    if (panState.suppressClick) {
      panState.suppressClick = false;
      return;
    }

    provinceSelectHandler?.(findProvinceAtClientPoint(svg, event.clientX, event.clientY));
  });

  const frameLayer = createGroup(svg, 'layer-frame');
  frameLayer.setAttribute('clip-path', 'url(#map-frame-clip)');

  appendDimOverlay(frameLayer);

  viewportLayer = createGroup(frameLayer, 'layer-viewport');
  applyMapTransform();

  const bgLayer = createGroup(viewportLayer, 'layer-bg-map');
  const invasionLayer = createGroup(viewportLayer, 'layer-invasion');
  const provinceLayer = createGroup(viewportLayer, 'layer-hitzones');
  const regionStrokeLayer = createGroup(viewportLayer, 'layer-region-stroke');
  const threatLayer = createGroup(viewportLayer, 'layer-threats');
  const hitboxLayer = createGroup(viewportLayer, 'layer-hitboxes');
  const labelLayer = createGroup(viewportLayer, 'layer-labels');
  const badgeLayer = createGroup(viewportLayer, 'layer-badges');

  importBackgroundMap(svg, bgLayer, MAP_BACKGROUND_SVG);
  importProvinceShapes(svg, provinceLayer, regionStrokeLayer, threatLayer, hitboxLayer, HITZONES_SVG);

  container.replaceChildren(svg);
  configureThreatHatchPatterns(svg);

  requestAnimationFrame(() => {
    configureThreatHatchPatterns(svg);
    computeCentroids(svg);
    addProvinceLabels(labelLayer);
  });

  return svg;
}

function importBackgroundMap(rootSvg, layer, svgText) {
  const sourceSvg = parseSvgRoot(svgText);
  if (!sourceSvg) return;

  appendSvgDefs(rootSvg, sourceSvg);

  const backgroundLayer = sourceSvg.querySelector('g[id="layer1"]') || sourceSvg.querySelector('g');
  if (!backgroundLayer) return;

  const importedLayer = document.importNode(backgroundLayer, true);
  importedLayer.id = 'background-container';
  stripSvgClipping(importedLayer);
  layer.appendChild(importedLayer);
}

function appendSvgDefs(rootSvg, sourceSvg) {
  for (const child of sourceSvg.children) {
    const tag = child.tagName?.toLowerCase() || '';
    if (tag !== 'defs') continue;

    const imported = document.importNode(child, true);
    const firstGroup = rootSvg.querySelector('g');
    rootSvg.insertBefore(imported, firstGroup || null);
  }
}

function appendDimOverlay(parent) {
  const dimRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  dimRect.setAttribute('width', '297');
  dimRect.setAttribute('height', '210');
  dimRect.setAttribute('fill', 'rgba(235, 214, 170, 0.05)');
  dimRect.setAttribute('class', 'map-dim-overlay');
  parent.appendChild(dimRect);
}

function importProvinceShapes(rootSvg, visualLayer, regionStrokeLayer, threatLayer, hitboxLayer, svgText) {
  const sourceSvg = parseSvgRoot(svgText);
  if (!sourceSvg) return;

  const provinceGroup = extractProvinceGroup(sourceSvg);
  if (!provinceGroup) return;

  const visualImported = document.importNode(provinceGroup, true);
  visualImported.id = 'province-container';
  stripSvgClipping(visualImported);
  removeNonProvinceGeometry(visualImported);

  for (const path of visualImported.querySelectorAll('path')) {
    const provinceId = path.getAttribute('id') || '';
    if (!isProvinceId(provinceId)) continue;

    configureProvincePath(path, provinceId, `province-shape province-${provinceId}`, 'province');
  }

  const regionStrokeImported = document.importNode(provinceGroup, true);
  regionStrokeImported.id = 'region-stroke-container';
  stripSvgClipping(regionStrokeImported);
  removeNonProvinceGeometry(regionStrokeImported);

  for (const path of regionStrokeImported.querySelectorAll('path')) {
    const provinceId = path.getAttribute('id') || '';
    if (!isProvinceId(provinceId)) continue;

    configureProvincePath(path, provinceId, 'region-stroke', 'region-stroke');
    applyInsetRegionBorder(rootSvg, path, provinceId);
  }

  const hitboxImported = document.importNode(provinceGroup, true);
  hitboxImported.id = 'province-hitbox-container';
  stripSvgClipping(hitboxImported);
  removeNonProvinceGeometry(hitboxImported);

  for (const path of hitboxImported.querySelectorAll('path')) {
    const provinceId = path.getAttribute('id') || '';
    if (!isProvinceId(provinceId)) continue;

    configureProvincePath(path, provinceId, 'province-hitbox', 'province-hitbox');
  }

  const threatImported = document.importNode(provinceGroup, true);
  threatImported.id = 'province-threat-container';
  stripSvgClipping(threatImported);
  removeNonProvinceGeometry(threatImported);

  for (const path of threatImported.querySelectorAll('path')) {
    const provinceId = path.getAttribute('id') || '';
    if (!isProvinceId(provinceId)) continue;

    configureProvincePath(path, provinceId, 'province-threat-overlay', 'province-threat');
    path.style.fill = 'url(#threat-hatch)';
    path.style.fillOpacity = '1';

    // Apply region border color so the overlay stroke matches the province outline
    const province = PROVINCES.find((p) => p.id === provinceId);
    if (province) {
      const regionColor = getRegionColor(province.region);
      if (regionColor) path.style.setProperty('--region-border', regionColor);
    }
  }

  visualLayer.appendChild(visualImported);
  regionStrokeLayer.appendChild(regionStrokeImported);
  threatLayer.appendChild(threatImported);
  hitboxLayer.appendChild(hitboxImported);
}

function configureProvincePath(path, provinceId, className, idPrefix) {
  path.removeAttribute('style');
  path.setAttribute('id', `${idPrefix}-${provinceId}`);
  path.setAttribute('class', className);
  path.setAttribute('data-id', provinceId);
  path.setAttribute('fill-rule', 'evenodd');
  path.setAttribute('clip-rule', 'evenodd');
}

function removeNonProvinceGeometry(root) {
  root.querySelectorAll('path, circle, ellipse, rect, polygon, polyline, line, use').forEach((element) => {
    const elementId = element.getAttribute('id') || '';
    if (!isProvinceId(elementId)) element.remove();
  });
}

function applyInsetRegionBorder(rootSvg, path, provinceId) {
  const province = PROVINCES.find((entry) => entry.id === provinceId);
  if (!province) return;

  const regionColor = getRegionColor(province.region);
  if (!regionColor) return;

  // Kypros is the only province path with its own transform inside the imported
  // hitzone group. Clipping that transformed island against a cloned path in
  // root <defs> drops the visible outline in browsers, so let its normal stroke
  // render un-clipped. It has no shared land border, so this does not hide any
  // neighbouring outline.
  const shouldUseInsetClip = !path.hasAttribute('transform');
  const clipId = shouldUseInsetClip ? ensureRegionStrokeClipPath(rootSvg, provinceId, path) : null;
  if (clipId) path.setAttribute('clip-path', `url(#${clipId})`);

  path.setAttribute('data-region', province.region);
  path.style.setProperty('--region-border', regionColor);
}

function ensureRegionStrokeClipPath(rootSvg, provinceId, sourcePath) {
  const defs = rootSvg.querySelector('defs');
  if (!defs) return null;

  const clipId = `region-stroke-clip-${provinceId}`;
  if (defs.querySelector(`#${clipId}`)) return clipId;

  const clipPath = document.createElementNS(SVG_NS, 'clipPath');
  clipPath.setAttribute('id', clipId);
  clipPath.setAttribute('data-region-stroke-clip', 'true');
  clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse');

  const clipShape = sourcePath.cloneNode(true);
  clipShape.removeAttribute('id');
  clipShape.removeAttribute('class');
  clipShape.removeAttribute('data-id');
  clipShape.removeAttribute('clip-path');
  clipShape.removeAttribute('style');
  clipShape.setAttribute('fill-rule', 'evenodd');
  clipShape.setAttribute('clip-rule', 'evenodd');
  clipPath.appendChild(clipShape);
  defs.appendChild(clipPath);
  return clipId;
}

function configureThreatHatchPatterns(svg) {
  const defs = svg.querySelector('defs');
  if (!defs) return;

  defs.querySelectorAll('[data-threat-hatch-pattern="province"]').forEach((pattern) => pattern.remove());

  svg.querySelectorAll('.province-threat-overlay').forEach((path) => {
    const provinceId = path.getAttribute('data-id');
    if (!provinceId) return;

    const province = PROVINCES.find((p) => p.id === provinceId);
    const regionColor = getRegionColor(province?.region);

    const patternId = `threat-hatch-${provinceId}`;
    const visualPath = svg.querySelector(`.province-shape[data-id="${provinceId}"]`);
    appendThreatHatchPattern(defs, patternId, getElementLinearScale(visualPath || path), regionColor);
    path.setAttribute('fill', `url(#${patternId})`);
    path.style.fill = `url(#${patternId})`;
  });
}

function appendThreatHatchPattern(defs, patternId, linearScale, regionColor) {
  const scale = Math.max(MIN_THREAT_HATCH_SCALE, Number(linearScale) || 1);
  const spacing = THREAT_HATCH_SPACING / scale;

  const pattern = document.createElementNS(SVG_NS, 'pattern');
  pattern.setAttribute('id', patternId);
  pattern.setAttribute('data-threat-hatch-pattern', 'province');
  pattern.setAttribute('width', String(spacing));
  pattern.setAttribute('height', String(spacing));
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  pattern.setAttribute('patternTransform', 'rotate(45)');

  // Single-color hatch using the province's region border color
  pattern.appendChild(createThreatHatchLine(0, spacing, THREAT_HATCH_PRIMARY_STROKE / scale, regionColor, '0.85'));
  defs.appendChild(pattern);
}

function createThreatHatchLine(x, height, strokeWidth, stroke, strokeOpacity) {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', String(x));
  line.setAttribute('y1', '0');
  line.setAttribute('x2', String(x));
  line.setAttribute('y2', String(height));
  line.setAttribute('stroke', stroke);
  line.setAttribute('stroke-opacity', strokeOpacity);
  line.setAttribute('stroke-width', String(strokeWidth));
  return line;
}

function getElementLinearScale(element) {
  const matrix = element.getCTM?.();
  if (!matrix) return 1;

  const xScale = Math.hypot(matrix.a, matrix.b);
  const yScale = Math.hypot(matrix.c, matrix.d);
  const averageScale = (xScale + yScale) / 2;
  return Number.isFinite(averageScale) && averageScale > 0 ? averageScale : 1;
}

function computeCentroids() {
  provinceCentroids = {};

  for (const province of PROVINCES) {
    const anchor = getProvinceLabelPoint(province.id);
    if (anchor) provinceCentroids[province.id] = anchor;
  }
}

// Map labels are stacked SVG cartouches that mirror the HTML
// .province-token grammar: outline = region color, fill = owner color,
// gold inner hairline. Two lines per cartouche: name / profit-tax-levy.
const MAP_CART_PAD_X = 1.0;

function addProvinceLabels(layer) {
  layer.replaceChildren();

  for (const province of PROVINCES) {
    const centroid = provinceCentroids[province.id];
    if (!centroid) continue;

    const g = buildMapCartouche(province, centroid);
    layer.appendChild(g);
    layoutMapCartouche(g);
  }
}

function buildMapCartouche(province, centroid) {
  const isCapital = province.id === 'CPL';
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', `map-cartouche${isCapital ? ' is-capital' : ''}`);
  g.setAttribute('data-id', province.id);
  g.setAttribute('transform', `translate(${centroid.cx} ${centroid.cy})`);

  const regionColor = getRegionColor(province.region) || '#2e1e0f';
  g.style.setProperty('--cart-border', regionColor);

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('class', 'map-cart-bg');
  g.appendChild(bg);

  const inner = document.createElementNS(SVG_NS, 'rect');
  inner.setAttribute('class', 'map-cart-inner');
  g.appendChild(inner);

  appendCartLine(g, 'map-cart-name', province.name);
  appendCartLine(g, 'map-cart-values', `P${province.P} T${province.T} L${province.L}`);

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
  const valuesText = g.querySelector('.map-cart-values');

  // Vertical layout — y is the text baseline (dominant-baseline: middle).
  nameText.setAttribute('y', -0.75);
  valuesText.setAttribute('y', 0.95);

  // Compute width from the widest line (getBBox needs the node attached).
  let maxW = 0;
  for (const t of [nameText, valuesText]) {
    if (!t) continue;
    const w = t.getBBox().width;
    if (w > maxW) maxW = w;
  }

  const width = maxW + MAP_CART_PAD_X * 2;
  const height = 4.7;

  bg.setAttribute('x', -width / 2);
  bg.setAttribute('y', -height / 2);
  bg.setAttribute('width', width);
  bg.setAttribute('height', height);
  bg.setAttribute('rx', 0.45);

  // Gold-leaf inner hairline, inset slightly inside the role outline.
  const inset = 0.32;
  inner.setAttribute('x', -width / 2 + inset);
  inner.setAttribute('y', -height / 2 + inset);
  inner.setAttribute('width', width - inset * 2);
  inner.setAttribute('height', height - inset * 2);
  inner.setAttribute('rx', 0.25);
}

export function updateMapState(state) {
  for (const [provinceId, theme] of Object.entries(state.themes)) {
    const shape = document.querySelector(`.province-shape[data-id="${provinceId}"]`);
    const cart = document.querySelector(`.map-cartouche[data-id="${provinceId}"]`);
    if (!shape) continue;

    const ownership = resolveProvinceOwnership(state, provinceId, theme);

    // Province shape: low-saturation parchment-tinted fill via class.
    shape.className.baseVal = `province-shape province-${provinceId} ${ownership.classes.join(' ')}`.trim();
    if (ownership.ownerColor) {
      shape.style.setProperty('--owner-color', ownership.ownerColor);
    } else {
      shape.style.removeProperty('--owner-color');
    }

    // Map cartouche: same class set drives full-saturation owner color.
    if (cart) {
      const baseClasses = `map-cartouche${provinceId === 'CPL' ? ' is-capital' : ''}`;
      cart.className.baseVal = `${baseClasses} ${ownership.classes.join(' ')}`.trim();
      if (ownership.ownerColor) {
        cart.style.setProperty('--cart-bg', ownership.ownerColor);
      } else {
        cart.style.removeProperty('--cart-bg');
      }
    }
  }

  updateThreatOverlay(state);
  updateBadges(state);
}

// Single source of truth for the ownership-derived state class set used by
// both the province shape and the map cartouche (and shared with the HTML
// .province-token via data/style conventions).
function resolveProvinceOwnership(state, provinceId, theme) {
  const ownerColor = getProvinceOwnerColor(state, theme);
  if (theme.occupied) {
    return { classes: ['occupied'], ownerColor };
  }
  if (theme.owner === 'church') {
    return { classes: ['imperial', 'church'], ownerColor };
  }
  if (theme.owner !== null) {
    const classes = ['imperial', 'owned'];
    if (theme.taxExempt) classes.push('tax-exempt');
    return { classes, ownerColor };
  }
  if (provinceId === 'CPL') {
    return { classes: ['imperial', 'capital'], ownerColor };
  }
  return { classes: ['imperial', 'free'], ownerColor };
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
    if (theme.occupied) continue;

    const centroid = provinceCentroids[provinceId];
    if (!centroid) continue;

    if (theme.strategos !== null) {
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      badge.setAttribute('cx', centroid.cx - 1.8);
      badge.setAttribute('cy', centroid.cy - 2.2);
      badge.setAttribute('r', 0.8);
      badge.setAttribute('class', 'officer-badge');
      const player = state.players.find((candidate) => candidate.id === theme.strategos);
      if (player) badge.style.fill = player.color;
      badge.style.stroke = '#000';
      badge.style.strokeWidth = '0.15';
      layer.appendChild(badge);
    }

    if (theme.bishop !== null) {
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      badge.setAttribute('cx', centroid.cx + 1.8);
      badge.setAttribute('cy', centroid.cy - 2.2);
      badge.setAttribute('r', 0.8);
      badge.setAttribute('class', 'officer-badge bishop-dot');
      const player = state.players.find((candidate) => candidate.id === theme.bishop);
      if (player) badge.style.fill = player.color;
      badge.style.stroke = '#000';
      badge.style.strokeWidth = '0.15';
      layer.appendChild(badge);
    }
  }
}

export function drawInvasionRoute(invasion) {
  const layer = document.getElementById('layer-invasion');
  if (!layer) return;

  layer.replaceChildren();
  if (!invasion) return;

  const points = [];
  const originPoint = resolveInvasionOriginPoint(invasion);
  if (originPoint) points.push(originPoint);

  for (const provinceId of invasion.route) {
    const centroid = provinceCentroids[provinceId];
    if (centroid && !isSameMapPoint(points[points.length - 1], centroid)) points.push(centroid);
  }

  if (points.length < 2) return;

  let pathData = `M ${points[0].cx} ${points[0].cy}`;
  for (let index = 1; index < points.length; index += 1) {
    pathData += ` L ${points[index].cx} ${points[index].cy}`;
  }

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('class', 'invasion-route');
  layer.appendChild(path);

  for (let index = 1; index < points.length; index += 1) {
    const marker = document.createElementNS(SVG_NS, 'circle');
    marker.setAttribute('cx', points[index].cx);
    marker.setAttribute('cy', points[index].cy);
    marker.setAttribute('r', 0.8);
    marker.setAttribute('class', 'invasion-marker');
    layer.appendChild(marker);
  }

  appendInvasionCartouche(layer, invasion, points[0]);
}

function resolveInvasionOriginPoint(invasion) {
  const pointId = invasion?.originPointId;
  const point = pointId ? invasionOriginPoints[pointId] || getInvasionOriginFallbackPoint(pointId) : null;
  if (point) return { ...point };

  const legacyPoint = invasion?.originPos;
  if (legacyPoint) {
    return {
      cx: legacyPoint.cx * (MAP_VIEWBOX_WIDTH / 1150),
      cy: legacyPoint.cy * (MAP_VIEWBOX_HEIGHT / 560),
    };
  }

  return provinceCentroids[invasion?.origin] || null;
}

function isSameMapPoint(a, b) {
  return Boolean(a && b && Math.hypot(a.cx - b.cx, a.cy - b.cy) < 0.01);
}

function appendInvasionCartouche(layer, invasion, point) {
  if (!point) return;

  const strengthText = Array.isArray(invasion.strength) && invasion.strength.length === 2
    ? `Strength ${invasion.strength[0]}-${invasion.strength[1]}`
    : 'Strength ?';
  const nameText = invasion.name || 'Invasion';
  const width = Math.max(26, Math.min(44, Math.max(nameText.length, strengthText.length) * 1.45 + 7));
  const height = 9.6;
  const x = point.cx - (width / 2);
  const y = point.cy - (height / 2);

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'invasion-cartouche');
  group.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('class', 'invasion-cartouche-bg');
  bg.setAttribute('width', width.toFixed(2));
  bg.setAttribute('height', height.toFixed(2));
  bg.setAttribute('rx', '1.6');
  bg.setAttribute('ry', '1.6');
  group.appendChild(bg);

  const inner = document.createElementNS(SVG_NS, 'rect');
  inner.setAttribute('class', 'invasion-cartouche-inner');
  inner.setAttribute('x', '0.8');
  inner.setAttribute('y', '0.8');
  inner.setAttribute('width', (width - 1.6).toFixed(2));
  inner.setAttribute('height', (height - 1.6).toFixed(2));
  inner.setAttribute('rx', '1.1');
  inner.setAttribute('ry', '1.1');
  group.appendChild(inner);

  const name = document.createElementNS(SVG_NS, 'text');
  name.setAttribute('class', 'invasion-cartouche-name');
  name.setAttribute('x', (width / 2).toFixed(2));
  name.setAttribute('y', '3.75');
  name.textContent = nameText;
  group.appendChild(name);

  const strength = document.createElementNS(SVG_NS, 'text');
  strength.setAttribute('class', 'invasion-cartouche-strength');
  strength.setAttribute('x', (width / 2).toFixed(2));
  strength.setAttribute('y', '7.15');
  strength.textContent = strengthText;
  group.appendChild(strength);

  layer.appendChild(group);
}

export function getCentroids() {
  return provinceCentroids;
}

export function setSelectedProvince(provinceId) {
  document.querySelectorAll('.province-shape.selected, .region-stroke.selected, .map-cartouche.selected')
    .forEach((element) => element.classList.remove('selected'));

  if (!provinceId) return;

  document.querySelector(`.province-shape[data-id="${provinceId}"]`)?.classList.add('selected');
  document.querySelector(`.region-stroke[data-id="${provinceId}"]`)?.classList.add('selected');
  document.querySelector(`.map-cartouche[data-id="${provinceId}"]`)?.classList.add('selected');
}

function findProvinceAtClientPoint(svg, clientX, clientY) {
  const directHit = findProvinceFromHitStack(clientX, clientY);
  if (directHit) return directHit;

  const screenPoint = svg.createSVGPoint();
  screenPoint.x = clientX;
  screenPoint.y = clientY;

  for (const path of document.querySelectorAll('.province-hitbox, .province-shape')) {
    if (typeof path.isPointInFill !== 'function') continue;

    const screenMatrix = path.getScreenCTM();
    if (!screenMatrix) continue;

    const localPoint = screenPoint.matrixTransform(screenMatrix.inverse());
    if (path.isPointInFill(localPoint)) {
      return path.getAttribute('data-id');
    }
  }

  return null;
}


function findProvinceFromHitStack(clientX, clientY) {
  if (typeof document.elementsFromPoint !== 'function') return null;

  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const provinceElement = findProvinceElement(element);
    const provinceId = provinceElement?.getAttribute?.('data-id');
    if (provinceId) return provinceId;
  }

  return null;
}

function findProvinceElement(element) {
  let current = element;
  while (current && current !== document.documentElement) {
    if (current.matches?.('.province-hitbox, .province-shape, .region-stroke, .map-cartouche')) return current;
    current = current.parentElement || current.parentNode;
  }
  return null;
}

function updateHoveredProvince(provinceId) {
  if (hoveredProvinceId && hoveredProvinceId !== provinceId) {
    document.querySelector(`.province-shape[data-id="${hoveredProvinceId}"]`)?.classList.remove('hovered');
    document.querySelector(`.region-stroke[data-id="${hoveredProvinceId}"]`)?.classList.remove('hovered');
  }

  if (provinceId) {
    document.querySelector(`.province-shape[data-id="${provinceId}"]`)?.classList.add('hovered');
    document.querySelector(`.region-stroke[data-id="${provinceId}"]`)?.classList.add('hovered');
  }

  hoveredProvinceId = provinceId;
}

function beginMapPan(svg, event) {
  if (event.button !== 0) return;

  panState.active = true;
  panState.pointerId = event.pointerId;
  panState.startClientX = event.clientX;
  panState.startClientY = event.clientY;
  panState.startPanX = mapView.panX;
  panState.startPanY = mapView.panY;
  panState.moved = false;

  svg.setPointerCapture?.(event.pointerId);
  updateMapCursor(svg, hoveredProvinceId);
}

function updateMapPan(svg, event) {
  if (!panState.active || event.pointerId !== panState.pointerId || mapView.zoom <= 1.001) return;

  const startPoint = clientPointToSvg(svg, panState.startClientX, panState.startClientY);
  const currentPoint = clientPointToSvg(svg, event.clientX, event.clientY);
  if (!startPoint || !currentPoint) return;

  mapView.panX = panState.startPanX + (currentPoint.x - startPoint.x);
  mapView.panY = panState.startPanY + (currentPoint.y - startPoint.y);
  clampMapView();
  applyMapTransform();

  if (Math.hypot(event.clientX - panState.startClientX, event.clientY - panState.startClientY) > 4) {
    panState.moved = true;
    updateHoveredProvince(null);
  }

  updateMapCursor(svg, null);
}

function endMapPan(svg, event) {
  if (!panState.active || (event && event.pointerId !== panState.pointerId)) return;

  if (panState.moved) {
    panState.suppressClick = true;
  }

  svg.releasePointerCapture?.(panState.pointerId);
  panState.active = false;
  panState.pointerId = null;
  panState.moved = false;
  updateMapCursor(svg, hoveredProvinceId);
}

function zoomMapAtPoint(svg, event) {
  event.preventDefault();
  zoomMapAtClientPoint(svg, event.clientX, event.clientY, event.deltaY < 0 ? MAP_ZOOM_STEP : 1 / MAP_ZOOM_STEP);
}

function zoomMapAtClientPoint(svg, clientX, clientY, factor) {
  const point = clientPointToSvg(svg, clientX, clientY);
  if (!point) return;

  const nextZoom = clampValue(mapView.zoom * factor, MIN_MAP_ZOOM, MAX_MAP_ZOOM);
  if (Math.abs(nextZoom - mapView.zoom) < 0.001) return;

  const contentX = (point.x - mapView.panX) / mapView.zoom;
  const contentY = (point.y - mapView.panY) / mapView.zoom;

  mapView.zoom = nextZoom;
  mapView.panX = point.x - contentX * mapView.zoom;
  mapView.panY = point.y - contentY * mapView.zoom;
  clampMapView();
  applyMapTransform();
  updateHoveredProvince(null);
  updateMapCursor(svg, null);
}

function resetMapView(svg) {
  mapView.zoom = 1;
  mapView.panX = 0;
  mapView.panY = 0;
  panState.suppressClick = true;
  applyMapTransform();
  updateHoveredProvince(null);
  updateMapCursor(svg, null);
}

function applyMapTransform() {
  if (!viewportLayer) return;
  viewportLayer.setAttribute(
    'transform',
    `translate(${mapView.panX.toFixed(3)} ${mapView.panY.toFixed(3)}) scale(${mapView.zoom.toFixed(3)})`,
  );
}

function clampMapView() {
  if (mapView.zoom <= MIN_MAP_ZOOM + 0.001) {
    mapView.zoom = 1;
    mapView.panX = 0;
    mapView.panY = 0;
    return;
  }

  mapView.zoom = clampValue(mapView.zoom, MIN_MAP_ZOOM, MAX_MAP_ZOOM);

  const minPanX = 297 * (1 - mapView.zoom);
  const minPanY = 210 * (1 - mapView.zoom);
  mapView.panX = clampValue(mapView.panX, minPanX, 0);
  mapView.panY = clampValue(mapView.panY, minPanY, 0);
}

function clientPointToSvg(svg, clientX, clientY) {
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;

  const matrix = svg.getScreenCTM();
  return matrix ? point.matrixTransform(matrix.inverse()) : null;
}

function updateMapCursor(svg, provinceId) {
  if (panState.active && mapView.zoom > 1.001) {
    svg.style.cursor = 'grabbing';
    return;
  }

  if (provinceId) {
    svg.style.cursor = 'pointer';
    return;
  }

  svg.style.cursor = mapView.zoom > 1.001 ? 'grab' : '';
}

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function stripSvgClipping(root) {
  if (!root?.querySelectorAll) return;
  if (root.removeAttribute) {
    root.removeAttribute('clip-path');
    root.removeAttribute('mask');
  }

  root.querySelectorAll('[clip-path],[mask]').forEach((element) => {
    element.removeAttribute('clip-path');
    element.removeAttribute('mask');
  });
}

function buildInvasionOriginPointsFromHitzones(svgText) {
  const fallbackPoints = Object.fromEntries(
    Object.entries(INVASION_ORIGIN_POINT_FALLBACKS).map(([id, point]) => [id, { ...point }]),
  );
  const referencePoints = assignOriginMarkersToInvasions(extractOriginReferenceMarkers(svgText));
  return Object.freeze({ ...fallbackPoints, ...referencePoints });
}

function extractOriginReferenceMarkers(svgText) {
  const sourceSvg = parseSvgRoot(svgText);
  if (!sourceSvg) return [];

  const markers = [];
  sourceSvg.querySelectorAll('circle, ellipse, path').forEach((element) => {
    if (!isReferenceCircleElement(element)) return;

    const localCenter = getReferenceCircleLocalCenter(element);
    if (!localCenter) return;

    const mapPoint = transformSvgPointToMap(element, localCenter);
    if (!isPointInsideLooseMapFrame(mapPoint)) return;

    markers.push({
      id: element.getAttribute('id') || '',
      cx: roundMapUnit(mapPoint.cx),
      cy: roundMapUnit(mapPoint.cy),
    });
  });

  return markers;
}

function isReferenceCircleElement(element) {
  const tag = getLocalTagName(element);
  if (tag === 'circle' || tag === 'ellipse') return true;
  if (tag !== 'path') return false;
  return readSvgAttribute(element, 'type', 'sodipodi') === 'arc' || isBlackReferencePath(element);
}

function getReferenceCircleLocalCenter(element) {
  const cx = readFiniteNumber(element, 'cx') ?? readFiniteNumber(element, 'cx', 'sodipodi');
  const cy = readFiniteNumber(element, 'cy') ?? readFiniteNumber(element, 'cy', 'sodipodi');
  if (Number.isFinite(cx) && Number.isFinite(cy)) return { cx, cy };
  return readPathCenterFromBounds(element);
}

function isBlackReferencePath(element) {
  const elementId = element.getAttribute('id') || '';
  if (isProvinceId(elementId) || isInsideSvgDefs(element)) return false;

  const style = element.getAttribute('style') || '';
  const fill = element.getAttribute('fill') || '';
  const stroke = element.getAttribute('stroke') || '';
  const colorSource = `${style};fill:${fill};stroke:${stroke}`.toLowerCase();
  if (!/(^|[;\s:])(?:#000|#000000|black)(?:[;\s]|$)/.test(colorSource)) return false;

  return Boolean(element.getAttribute('d'));
}

function readPathCenterFromBounds(element) {
  const bounds = getSvgPathCoordinateBounds(element.getAttribute('d'));
  if (!bounds) return null;
  return {
    cx: (bounds.minX + bounds.maxX) / 2,
    cy: (bounds.minY + bounds.maxY) / 2,
  };
}

function getSvgPathCoordinateBounds(pathData) {
  const tokens = String(pathData || '').match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) || [];
  let command = null;
  let index = 0;
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  const xs = [];
  const ys = [];

  const isCommand = (token) => /^[a-zA-Z]$/.test(token);
  const readNumber = () => {
    const value = Number(tokens[index]);
    index += 1;
    return Number.isFinite(value) ? value : null;
  };
  const record = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    xs.push(x);
    ys.push(y);
  };
  const readPoint = (relative) => {
    const x = readNumber();
    const y = readNumber();
    if (x === null || y === null) return null;
    return {
      x: relative ? current.x + x : x,
      y: relative ? current.y + y : y,
    };
  };

  while (index < tokens.length) {
    if (isCommand(tokens[index])) {
      command = tokens[index];
      index += 1;
    }
    if (!command) break;

    const relative = command === command.toLowerCase();
    const type = command.toLowerCase();

    if (type === 'z') {
      current = { ...start };
      record(current.x, current.y);
      command = null;
      continue;
    }

    if (type === 'm' || type === 'l' || type === 't') {
      const point = readPoint(relative);
      if (!point) break;
      current = point;
      if (type === 'm') start = { ...point };
      record(current.x, current.y);
      if (type === 'm') command = relative ? 'l' : 'L';
      continue;
    }

    if (type === 'h') {
      const x = readNumber();
      if (x === null) break;
      current = { x: relative ? current.x + x : x, y: current.y };
      record(current.x, current.y);
      continue;
    }

    if (type === 'v') {
      const y = readNumber();
      if (y === null) break;
      current = { x: current.x, y: relative ? current.y + y : y };
      record(current.x, current.y);
      continue;
    }

    if (type === 'c') {
      for (let pointIndex = 0; pointIndex < 3; pointIndex += 1) {
        const point = readPoint(relative);
        if (!point) return finalizeSvgPathBounds(xs, ys);
        record(point.x, point.y);
        if (pointIndex === 2) current = point;
      }
      continue;
    }

    if (type === 's' || type === 'q') {
      for (let pointIndex = 0; pointIndex < 2; pointIndex += 1) {
        const point = readPoint(relative);
        if (!point) return finalizeSvgPathBounds(xs, ys);
        record(point.x, point.y);
        if (pointIndex === 1) current = point;
      }
      continue;
    }

    if (type === 'a') {
      const rx = readNumber();
      const ry = readNumber();
      readNumber();
      readNumber();
      readNumber();
      const x = readNumber();
      const y = readNumber();
      if ([rx, ry, x, y].some((value) => value === null)) break;
      const end = { x: relative ? current.x + x : x, y: relative ? current.y + y : y };
      record(current.x - Math.abs(rx), current.y - Math.abs(ry));
      record(current.x + Math.abs(rx), current.y + Math.abs(ry));
      record(end.x - Math.abs(rx), end.y - Math.abs(ry));
      record(end.x + Math.abs(rx), end.y + Math.abs(ry));
      current = end;
      record(current.x, current.y);
      continue;
    }

    break;
  }

  return finalizeSvgPathBounds(xs, ys);
}

function finalizeSvgPathBounds(xs, ys) {
  if (!xs.length || !ys.length) return null;
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function isInsideSvgDefs(element) {
  let current = element.parentElement;
  while (current) {
    if (getLocalTagName(current) === 'defs') return true;
    current = current.parentElement;
  }
  return false;
}

function assignOriginMarkersToInvasions(markers) {
  const assigned = {};
  const remaining = [];

  for (const marker of markers) {
    const originId = normalizeOriginMarkerId(marker.id);
    if (originId && INVASION_ORIGIN_POINT_IDS.includes(originId) && !assigned[originId]) {
      assigned[originId] = { cx: marker.cx, cy: marker.cy };
    } else {
      remaining.push(marker);
    }
  }

  const pairs = [];
  INVASION_ORIGIN_POINT_IDS.forEach((originId) => {
    if (assigned[originId]) return;
    const fallback = INVASION_ORIGIN_POINT_FALLBACKS[originId];
    if (!fallback) return;

    remaining.forEach((marker, markerIndex) => {
      pairs.push({
        originId,
        markerIndex,
        distance: Math.hypot(marker.cx - fallback.cx, marker.cy - fallback.cy),
      });
    });
  });

  const usedMarkers = new Set();
  pairs.sort((left, right) => left.distance - right.distance);
  for (const pair of pairs) {
    if (assigned[pair.originId] || usedMarkers.has(pair.markerIndex)) continue;
    const marker = remaining[pair.markerIndex];
    assigned[pair.originId] = { cx: marker.cx, cy: marker.cy };
    usedMarkers.add(pair.markerIndex);
  }

  return assigned;
}

function normalizeOriginMarkerId(rawId) {
  const key = String(rawId || '')
    .trim()
    .toLowerCase()
    .replace(/^invasion[-_\s]*/, '')
    .replace(/^origin[-_\s]*/, '')
    .replace(/[-_\s]*origin$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return ORIGIN_MARKER_ID_ALIASES[key] || null;
}

const ORIGIN_MARKER_ID_ALIASES = Object.freeze({
  west_libya: 'west_libya',
  westlibya: 'west_libya',
  ifriqiya: 'west_libya',
  aghlabids: 'west_libya',
  aghlabid: 'west_libya',
  steppe: 'steppe',
  steppes: 'steppe',
  pontic_steppe: 'steppe',
  kievan_rus: 'steppe',
  rus: 'steppe',
  norman_italy: 'norman_italy',
  normanitaly: 'norman_italy',
  normans: 'norman_italy',
  norman: 'norman_italy',
  venice: 'venice',
  venetians: 'venice',
  venetian: 'venice',
  bulgaria: 'bulgaria',
  bulgars: 'bulgaria',
  bulgar: 'bulgaria',
  serbia_interior: 'serbia_interior',
  serbiainterior: 'serbia_interior',
  serbia: 'serbia_interior',
  serbs: 'serbia_interior',
  pannonia: 'pannonia',
  hungarians: 'pannonia',
  hungary: 'pannonia',
  turkic_east: 'turkic_east',
  turkiceast: 'turkic_east',
  persia: 'turkic_east',
  turks: 'turkic_east',
  turk: 'turkic_east',
  levant: 'levant',
  caliphate: 'levant',
});

function transformSvgPointToMap(element, point) {
  const chain = [];
  let current = element;

  while (current && current.nodeType === 1) {
    chain.unshift(current);
    if (getLocalTagName(current) === 'svg') break;
    current = current.parentElement;
  }

  const matrix = chain.reduce(
    (acc, node) => multiplySvgMatrices(acc, parseSvgTransform(node.getAttribute('transform'))),
    identitySvgMatrix(),
  );

  return applySvgMatrix(matrix, point);
}

function parseSvgTransform(transform) {
  if (!transform) return identitySvgMatrix();

  const transformPattern = /([a-zA-Z]+)\(([^)]*)\)/g;
  let matrix = identitySvgMatrix();
  let match;

  while ((match = transformPattern.exec(transform)) !== null) {
    const fn = match[1].toLowerCase();
    const values = parseSvgNumberList(match[2]);
    matrix = multiplySvgMatrices(matrix, matrixForSvgTransform(fn, values));
  }

  return matrix;
}

function matrixForSvgTransform(fn, values) {
  if (fn === 'matrix' && values.length >= 6) {
    return { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] };
  }

  if (fn === 'translate') {
    return { a: 1, b: 0, c: 0, d: 1, e: values[0] || 0, f: values[1] || 0 };
  }

  if (fn === 'scale') {
    const sx = Number.isFinite(values[0]) ? values[0] : 1;
    const sy = Number.isFinite(values[1]) ? values[1] : sx;
    return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
  }

  if (fn === 'rotate') {
    const radians = ((values[0] || 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const rotation = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
    if (values.length >= 3) {
      return multiplySvgMatrices(
        multiplySvgMatrices(
          { a: 1, b: 0, c: 0, d: 1, e: values[1], f: values[2] },
          rotation,
        ),
        { a: 1, b: 0, c: 0, d: 1, e: -values[1], f: -values[2] },
      );
    }
    return rotation;
  }

  return identitySvgMatrix();
}

function parseSvgNumberList(value) {
  return String(value || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
}

function identitySvgMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplySvgMatrices(left, right) {
  return {
    a: (left.a * right.a) + (left.c * right.b),
    b: (left.b * right.a) + (left.d * right.b),
    c: (left.a * right.c) + (left.c * right.d),
    d: (left.b * right.c) + (left.d * right.d),
    e: (left.a * right.e) + (left.c * right.f) + left.e,
    f: (left.b * right.e) + (left.d * right.f) + left.f,
  };
}

function applySvgMatrix(matrix, point) {
  return {
    cx: (matrix.a * point.cx) + (matrix.c * point.cy) + matrix.e,
    cy: (matrix.b * point.cx) + (matrix.d * point.cy) + matrix.f,
  };
}

function isPointInsideLooseMapFrame(point) {
  return point.cx >= -1
    && point.cx <= MAP_VIEWBOX_WIDTH + 1
    && point.cy >= -1
    && point.cy <= MAP_VIEWBOX_HEIGHT + 1;
}

function readFiniteNumber(element, name, namespacePrefix = null) {
  const value = readSvgAttribute(element, name, namespacePrefix);
  if (value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readSvgAttribute(element, name, namespacePrefix = null) {
  if (!namespacePrefix) return element.getAttribute(name);
  return element.getAttribute(`${namespacePrefix}:${name}`)
    || element.getAttributeNS?.('http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd', name)
    || null;
}

function getLocalTagName(element) {
  return (element.localName || element.tagName || '').toLowerCase();
}

function roundMapUnit(value) {
  return Math.round(value * 100) / 100;
}

function parseSvgRoot(svgText) {
  if (!svgText) return null;
  const parser = new DOMParser();
  const documentRoot = parser.parseFromString(svgText, 'image/svg+xml');
  return documentRoot.querySelector('svg');
}

function extractProvinceGroup(svgRoot) {
  for (const group of svgRoot.querySelectorAll('g')) {
    const transform = group.getAttribute('transform') || '';
    if (transform.includes('matrix') && transform.includes('0.023')) {
      return group;
    }
  }
  return null;
}

function isProvinceId(value) {
  return /^[A-Z]{2,3}$/.test(value);
}

function createGroup(parent, id) {
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.id = id;
  parent.appendChild(group);
  return group;
}
