import { PROVINCES, REGION_BORDER_COLORS } from '../data/provinces.js';
import { getThreatenedThemeIds } from '../engine/rules.js';
import { HITZONES_SVG, MAP_BACKGROUND_SVG } from './svgAssets.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const THREAT_HATCH_SPACING = 3.6;
const THREAT_HATCH_PRIMARY_STROKE = 1.4;
const THREAT_HATCH_SECONDARY_STROKE = 0.7;
const MIN_THREAT_HATCH_SCALE = 0.001;

// Region outlines are rendered in their own layer and clipped to each
// province interior. The stroke itself is drawn at double the visible width,
// so clipping it to the province makes the outline behave like an inset inner
// stroke whose outer edge sits exactly on the true border. That way adjacent
// provinces both remain visible at shared edges with no gap between them.

let provinceCentroids = {};
let provinceSelectHandler = null;
let hoveredProvinceId = null;
let viewportLayer = null;
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

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 297 210');
  svg.setAttribute('class', 'game-map');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
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

  for (const path of visualImported.querySelectorAll('path')) {
    const provinceId = path.getAttribute('id') || '';
    if (!isProvinceId(provinceId)) continue;

    configureProvincePath(path, provinceId, `province-shape province-${provinceId}`, 'province');
  }

  const regionStrokeImported = document.importNode(provinceGroup, true);
  regionStrokeImported.id = 'region-stroke-container';
  stripSvgClipping(regionStrokeImported);

  for (const path of regionStrokeImported.querySelectorAll('path')) {
    const provinceId = path.getAttribute('id') || '';
    if (!isProvinceId(provinceId)) continue;

    configureProvincePath(path, provinceId, 'region-stroke', 'region-stroke');
    applyInsetRegionBorder(rootSvg, path, provinceId);
  }

  const hitboxImported = document.importNode(provinceGroup, true);
  hitboxImported.id = 'province-hitbox-container';
  stripSvgClipping(hitboxImported);

  for (const path of hitboxImported.querySelectorAll('path')) {
    const provinceId = path.getAttribute('id') || '';
    if (!isProvinceId(provinceId)) continue;

    configureProvincePath(path, provinceId, 'province-hitbox', 'province-hitbox');
  }

  const threatImported = document.importNode(provinceGroup, true);
  threatImported.id = 'province-threat-container';
  stripSvgClipping(threatImported);

  for (const path of threatImported.querySelectorAll('path')) {
    const provinceId = path.getAttribute('id') || '';
    if (!isProvinceId(provinceId)) continue;

    configureProvincePath(path, provinceId, 'province-threat-overlay', 'province-threat');
    path.style.fill = 'url(#threat-hatch)';
    path.style.fillOpacity = '1';

    // Apply region border color so the overlay stroke matches the province outline
    const province = PROVINCES.find((p) => p.id === provinceId);
    if (province) {
      const regionColor = REGION_BORDER_COLORS[province.region];
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

function applyInsetRegionBorder(rootSvg, path, provinceId) {
  const province = PROVINCES.find((entry) => entry.id === provinceId);
  if (!province) return;

  const regionColor = REGION_BORDER_COLORS[province.region];
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
    const regionColor = REGION_BORDER_COLORS[province?.region] || '#2e1e0f';

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

function computeCentroids(svg) {
  provinceCentroids = {};

  for (const path of document.querySelectorAll('.province-shape')) {
    const provinceId = path.getAttribute('data-id');
    if (!provinceId) continue;

    try {
      const bbox = path.getBBox();
      const point = svg.createSVGPoint();
      point.x = bbox.x + bbox.width / 2;
      point.y = bbox.y + bbox.height / 2;

      const ctm = path.getCTM();
      const svgCtm = svg.getCTM();
      if (!ctm || !svgCtm) continue;

      const screenPoint = point.matrixTransform(ctm);
      const svgPoint = screenPoint.matrixTransform(svgCtm.inverse());
      provinceCentroids[provinceId] = { cx: svgPoint.x, cy: svgPoint.y };
    } catch {
      // Ignore shapes that have not been laid out yet.
    }
  }
}

// Map labels are stacked SVG cartouches that mirror the HTML
// .province-token grammar: outline = region color, fill = owner color,
// gold inner hairline. Three lines per cartouche: id / name / profit-tax-levy.
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

  const regionColor = REGION_BORDER_COLORS[province.region] || '#2e1e0f';
  g.style.setProperty('--cart-border', regionColor);

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('class', 'map-cart-bg');
  g.appendChild(bg);

  const inner = document.createElementNS(SVG_NS, 'rect');
  inner.setAttribute('class', 'map-cart-inner');
  g.appendChild(inner);

  appendCartLine(g, 'map-cart-id', province.id);
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
  const idText = g.querySelector('.map-cart-id');
  const nameText = g.querySelector('.map-cart-name');
  const valuesText = g.querySelector('.map-cart-values');

  // Vertical layout — y is the text baseline (dominant-baseline: middle).
  idText.setAttribute('y', -1.7);
  nameText.setAttribute('y', 0.2);
  valuesText.setAttribute('y', 1.95);

  // Compute width from the widest line (getBBox needs the node attached).
  let maxW = 0;
  for (const t of [idText, nameText, valuesText]) {
    if (!t) continue;
    const w = t.getBBox().width;
    if (w > maxW) maxW = w;
  }

  const width = maxW + MAP_CART_PAD_X * 2;
  const height = 6.4;

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
  if (theme.occupied) {
    return { classes: ['occupied'], ownerColor: null };
  }
  if (theme.owner === 'church') {
    return { classes: ['imperial', 'church'], ownerColor: null };
  }
  if (theme.owner !== null) {
    const player = state.players.find((candidate) => candidate.id === theme.owner);
    const classes = ['imperial', 'owned'];
    if (theme.taxExempt) classes.push('tax-exempt');
    return { classes, ownerColor: player?.color || null };
  }
  if (provinceId === 'CPL') {
    return { classes: ['imperial', 'capital'], ownerColor: null };
  }
  return { classes: ['imperial', 'free'], ownerColor: null };
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
  if (invasion.originPos) {
    points.push({
      cx: invasion.originPos.cx * (297 / 1150),
      cy: invasion.originPos.cy * (210 / 560),
    });
  }

  for (const provinceId of invasion.route) {
    const centroid = provinceCentroids[provinceId];
    if (centroid) points.push(centroid);
  }

  if (points.length < 2) return;

  let pathData = `M ${points[0].cx} ${points[0].cy}`;
  for (let index = 1; index < points.length; index += 1) {
    pathData += ` L ${points[index].cx} ${points[index].cy}`;
  }

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('class', 'invasion-route');
  path.style.stroke = invasion.color;
  layer.appendChild(path);

  for (let index = 1; index < points.length; index += 1) {
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    marker.setAttribute('cx', points[index].cx);
    marker.setAttribute('cy', points[index].cy);
    marker.setAttribute('r', 0.8);
    marker.setAttribute('class', 'invasion-marker');
    marker.style.fill = invasion.color;
    layer.appendChild(marker);
  }

  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('x', points[0].cx);
  label.setAttribute('y', points[0].cy - 1.5);
  label.setAttribute('class', 'invasion-label');
  label.style.fill = invasion.color;
  label.textContent = invasion.name;
  layer.appendChild(label);
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

  const point = clientPointToSvg(svg, event.clientX, event.clientY);
  if (!point) return;

  const nextZoom = clampValue(mapView.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 4);
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
  if (mapView.zoom <= 1.001) {
    mapView.zoom = 1;
    mapView.panX = 0;
    mapView.panY = 0;
    return;
  }

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
