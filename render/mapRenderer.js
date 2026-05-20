import { PROVINCES } from '../data/provinces.js';
import { getProvinceOwnerColor, getRegionColor } from '../ui/labels.js';
import {
  ensureSvgIconSymbols,
  buildSvgValueGroup,
  measureSvgValueGroupWidth,
  provinceValueEntries,
} from '../ui/icons.js';
import { getThreatenedThemeIds } from '../engine/rules.js';
import { HITZONES_SVG, MAP_BACKGROUND_SVG, ORIGIN_SVG } from './svgAssets.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAP_WIDTH = 297;
const MAP_HEIGHT = 210;
const LEGACY_ORIGIN_WIDTH = 1150;
const LEGACY_ORIGIN_HEIGHT = 560;

const SVG_ASSET_PATHS = Object.freeze({
  background: '../assets/map.svg',
  hitzones: '../assets/hitzones.svg',
  origin: '../assets/origin.svg',
});

const INVASION_ORIGIN_IDS = Object.freeze({
  aghlabids: 'AGH',
  kievan_rus: 'RUS',
  normans: 'NOR',
  venetians: 'VEN',
  bulgars: 'BBUULL',
  serbs: 'SSRRBB',
  hungarians: 'HON',
  turks: 'TUR',
  caliphate: 'CAL',
});
const PROVINCE_LABEL_SUFFIX = 'LAB';
const THREAT_HATCH_SPACING = 3.6;
const THREAT_HATCH_PRIMARY_STROKE = 1.4;
const THREAT_HATCH_SECONDARY_STROKE = 0.7;
const MIN_THREAT_HATCH_SCALE = 0.001;
const MIN_MAP_ZOOM = 1;
const MAX_MAP_ZOOM = 4;
const MAP_ZOOM_STEP = 1.2;
const MAP_DRAG_THRESHOLD_PX = 4;
const MIN_PINCH_DISTANCE_PX = 8;
const SVG_PATH_TOKEN_PATTERN = /[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const PATH_PARAM_COUNTS = Object.freeze({
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
});
const CURVE_EPSILON = 1e-9;

// Region outlines are rendered in their own layer and clipped to each
// province interior. The stroke itself is drawn at double the visible width,
// so clipping it to the province makes the outline behave like an inset inner
// stroke whose outer edge sits exactly on the true border. That way adjacent
// provinces both remain visible at shared edges with no gap between them.

let provinceCentroids = {};
let invasionOrigins = {};
let provinceSelectHandler = null;
let hoveredProvinceId = null;
let viewportLayer = null;
let latestMapState = null;
let mapView = { zoom: 1, panX: 0, panY: 0 };
let gestureState = createGestureState();

export async function createMapSVG(containerId, options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return null;

  provinceSelectHandler = options.onProvinceSelect || null;
  provinceCentroids = {};
  invasionOrigins = {};
  hoveredProvinceId = null;
  viewportLayer = null;
  latestMapState = null;
  mapView = { zoom: 1, panX: 0, panY: 0 };
  gestureState = createGestureState();

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`);
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
        <rect width="${MAP_WIDTH}" height="${MAP_HEIGHT}" rx="5" ry="5"/>
      </clipPath>
    </defs>
  `;

  svg.addEventListener('pointermove', (event) => {
    if (gestureState.pointers.has(event.pointerId)) {
      updateMapGesture(svg, event);
      return;
    }

    if (event.pointerType !== 'mouse') return;

    const provinceId = findProvinceAtClientPoint(svg, event.clientX, event.clientY);
    updateHoveredProvince(provinceId);
    updateMapCursor(svg, provinceId);
  });

  svg.addEventListener('pointerdown', (event) => beginMapGesture(svg, event));
  svg.addEventListener('pointerup', (event) => endMapGesture(svg, event));
  svg.addEventListener('pointercancel', (event) => endMapGesture(svg, event));
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
    if (gestureState.suppressClick) {
      gestureState.suppressClick = false;
      return;
    }

    provinceSelectHandler?.(findProvinceAtEvent(svg, event));
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

  const [backgroundSvg, hitzonesSvg, originSvg] = await Promise.all([
    loadSvgAsset(SVG_ASSET_PATHS.background, MAP_BACKGROUND_SVG),
    loadSvgAsset(SVG_ASSET_PATHS.hitzones, HITZONES_SVG),
    loadSvgAsset(SVG_ASSET_PATHS.origin, ORIGIN_SVG),
  ]);

  importBackgroundMap(svg, bgLayer, backgroundSvg);
  importProvinceShapes(svg, provinceLayer, regionStrokeLayer, threatLayer, hitboxLayer, hitzonesSvg);
  invasionOrigins = parseInvasionOrigins(originSvg);

  container.replaceChildren(svg, createMapControls(svg));
  ensureSvgIconSymbols(svg);
  configureThreatHatchPatterns(svg);

  provinceCentroids = parseProvinceLabelAnchors(originSvg);

  requestAnimationFrame(() => {
    configureThreatHatchPatterns(svg);
    addProvinceLabels(labelLayer);
  });

  return svg;
}

function createMapControls(svg) {
  const controls = document.createElement('div');
  controls.className = 'map-controls';
  controls.setAttribute('aria-label', 'Map zoom controls');

  const makeButton = (label, title, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-control-btn';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return button;
  };

  const zoomAtCenter = (factor) => {
    const rect = svg.getBoundingClientRect();
    zoomMapAtClientPoint(svg, rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  controls.append(
    makeButton('+', 'Zoom in', () => zoomAtCenter(MAP_ZOOM_STEP)),
    makeButton('-', 'Zoom out', () => zoomAtCenter(1 / MAP_ZOOM_STEP)),
    makeButton('1:1', 'Reset map view', () => resetMapView(svg)),
  );
  return controls;
}


async function loadSvgAsset(relativePath, fallbackText) {
  if (typeof fetch !== 'function') return fallbackText;

  try {
    const response = await fetch(new URL(relativePath, import.meta.url));
    if (response.ok) return await response.text();
  } catch {
    // Local file previews can block fetch; embedded SVG keeps the map usable.
  }

  return fallbackText;
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
  dimRect.setAttribute('width', String(MAP_WIDTH));
  dimRect.setAttribute('height', String(MAP_HEIGHT));
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


function parseProvinceLabelAnchors(originSvgText) {
  const sourceSvg = parseSvgRoot(originSvgText);
  const markers = sourceSvg ? parseSvgPointMarkers(sourceSvg) : {};
  const anchors = {};

  for (const province of PROVINCES) {
    const marker = markers[`${province.id}${PROVINCE_LABEL_SUFFIX}`];
    if (marker) anchors[province.id] = marker;
  }

  return anchors;
}

function parseSvgPointMarkers(sourceSvg) {
  const viewBox = parseSvgViewBox(sourceSvg.getAttribute('viewBox'));
  const markers = {};

  for (const element of sourceSvg.querySelectorAll('[id]')) {
    const markerId = element.getAttribute('id')?.trim().toUpperCase();
    if (!markerId || !/^[A-Z0-9]+$/.test(markerId)) continue;

    const center = readSvgElementCenter(element);
    if (!center) continue;

    markers[markerId] = normalizeSvgPoint(applyElementTransforms(sourceSvg, element, center), viewBox);
  }

  return markers;
}

function readSvgElementCenter(element) {
  const tag = element.tagName?.toLowerCase?.().replace(/^.*:/, '') || '';

  if (tag === 'circle' || tag === 'ellipse') {
    const cx = parseFiniteNumber(element.getAttribute('cx'));
    const cy = parseFiniteNumber(element.getAttribute('cy'));
    return Number.isFinite(cx) && Number.isFinite(cy) ? { cx, cy } : null;
  }

  if (tag === 'rect') {
    const x = parseFiniteNumber(element.getAttribute('x')) || 0;
    const y = parseFiniteNumber(element.getAttribute('y')) || 0;
    const width = parseFiniteNumber(element.getAttribute('width'));
    const height = parseFiniteNumber(element.getAttribute('height'));
    return Number.isFinite(width) && Number.isFinite(height) ? { cx: x + width / 2, cy: y + height / 2 } : null;
  }

  if (tag === 'path') {
    const bounds = getPathBounds(element.getAttribute('d'));
    return bounds ? { cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2 } : null;
  }

  return null;
}

function getPathBounds(pathData) {
  const cursor = createPathCursor(pathData);
  if (!cursor.tokens.length) return null;

  const bounds = createEmptyBounds();
  let command = null;
  let current = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  let lastCubicControl = null;
  let lastQuadraticControl = null;
  let previousCommand = null;

  while (cursor.hasMore()) {
    if (cursor.hasCommand()) command = cursor.readCommand();
    if (!command) break;

    const upperCommand = command.toUpperCase();
    const isRelative = command !== upperCommand;

    if (upperCommand === 'Z') {
      addPointToBounds(bounds, subpathStart.x, subpathStart.y);
      current = { ...subpathStart };
      lastCubicControl = null;
      lastQuadraticControl = null;
      previousCommand = command;
      command = null;
      continue;
    }

    if (upperCommand === 'M') {
      if (!cursor.hasNumber()) break;

      const point = readPathPoint(cursor, current, isRelative);
      current = point;
      subpathStart = { ...point };
      addPointToBounds(bounds, current.x, current.y);
      lastCubicControl = null;
      lastQuadraticControl = null;
      previousCommand = command;
      command = isRelative ? 'l' : 'L';
      continue;
    }

    const paramCount = PATH_PARAM_COUNTS[upperCommand];
    if (!paramCount) break;

    while (cursor.hasNumber()) {
      if (!cursor.hasParams(paramCount)) break;

      if (upperCommand === 'L') {
        current = readPathPoint(cursor, current, isRelative);
        addPointToBounds(bounds, current.x, current.y);
        lastCubicControl = null;
        lastQuadraticControl = null;
      } else if (upperCommand === 'H') {
        const x = readPathNumber(cursor) + (isRelative ? current.x : 0);
        current = { x, y: current.y };
        addPointToBounds(bounds, current.x, current.y);
        lastCubicControl = null;
        lastQuadraticControl = null;
      } else if (upperCommand === 'V') {
        const y = readPathNumber(cursor) + (isRelative ? current.y : 0);
        current = { x: current.x, y };
        addPointToBounds(bounds, current.x, current.y);
        lastCubicControl = null;
        lastQuadraticControl = null;
      } else if (upperCommand === 'C') {
        const control1 = readPathPoint(cursor, current, isRelative);
        const control2 = readPathPoint(cursor, current, isRelative);
        const end = readPathPoint(cursor, current, isRelative);
        addCubicBounds(bounds, current, control1, control2, end);
        current = end;
        lastCubicControl = control2;
        lastQuadraticControl = null;
      } else if (upperCommand === 'S') {
        const control1 = previousCommand && ['C', 'S'].includes(previousCommand.toUpperCase()) && lastCubicControl
          ? reflectPoint(lastCubicControl, current)
          : { ...current };
        const control2 = readPathPoint(cursor, current, isRelative);
        const end = readPathPoint(cursor, current, isRelative);
        addCubicBounds(bounds, current, control1, control2, end);
        current = end;
        lastCubicControl = control2;
        lastQuadraticControl = null;
      } else if (upperCommand === 'Q') {
        const control = readPathPoint(cursor, current, isRelative);
        const end = readPathPoint(cursor, current, isRelative);
        addQuadraticBounds(bounds, current, control, end);
        current = end;
        lastQuadraticControl = control;
        lastCubicControl = null;
      } else if (upperCommand === 'T') {
        const control = previousCommand && ['Q', 'T'].includes(previousCommand.toUpperCase()) && lastQuadraticControl
          ? reflectPoint(lastQuadraticControl, current)
          : { ...current };
        const end = readPathPoint(cursor, current, isRelative);
        addQuadraticBounds(bounds, current, control, end);
        current = end;
        lastQuadraticControl = control;
        lastCubicControl = null;
      } else if (upperCommand === 'A') {
        const values = Array.from({ length: 7 }, () => readPathNumber(cursor));
        const end = {
          x: values[5] + (isRelative ? current.x : 0),
          y: values[6] + (isRelative ? current.y : 0),
        };
        // Province hitzones currently do not use arcs. Include the endpoint so
        // future accidental arcs fail gracefully instead of breaking all labels.
        addPointToBounds(bounds, current.x, current.y);
        addPointToBounds(bounds, end.x, end.y);
        current = end;
        lastCubicControl = null;
        lastQuadraticControl = null;
      }

      previousCommand = command;
    }
  }

  return Number.isFinite(bounds.minX) ? bounds : null;
}

function createPathCursor(pathData) {
  const tokens = String(pathData || '').match(SVG_PATH_TOKEN_PATTERN) || [];
  let index = 0;

  return {
    tokens,
    hasMore: () => index < tokens.length,
    hasCommand: () => /^[A-Za-z]$/.test(tokens[index] || ''),
    hasNumber: () => index < tokens.length && !/^[A-Za-z]$/.test(tokens[index]),
    hasParams: (count) => index + count <= tokens.length && tokens.slice(index, index + count).every((token) => !/^[A-Za-z]$/.test(token)),
    readCommand: () => tokens[index++],
    readNumber: () => Number(tokens[index++]),
  };
}

function readPathNumber(cursor) {
  const value = cursor.readNumber();
  return Number.isFinite(value) ? value : 0;
}

function readPathPoint(cursor, current, isRelative) {
  const x = readPathNumber(cursor);
  const y = readPathNumber(cursor);
  return {
    x: x + (isRelative ? current.x : 0),
    y: y + (isRelative ? current.y : 0),
  };
}

function createEmptyBounds() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function addPointToBounds(bounds, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
}

function addQuadraticBounds(bounds, start, control, end) {
  addPointToBounds(bounds, start.x, start.y);
  addPointToBounds(bounds, end.x, end.y);

  for (const axis of ['x', 'y']) {
    const denominator = start[axis] - (2 * control[axis]) + end[axis];
    if (Math.abs(denominator) < CURVE_EPSILON) continue;

    const t = (start[axis] - control[axis]) / denominator;
    if (t > 0 && t < 1) {
      const point = evaluateQuadratic(start, control, end, t);
      addPointToBounds(bounds, point.x, point.y);
    }
  }
}

function addCubicBounds(bounds, start, control1, control2, end) {
  addPointToBounds(bounds, start.x, start.y);
  addPointToBounds(bounds, end.x, end.y);

  for (const axis of ['x', 'y']) {
    const roots = solveQuadratic(
      -start[axis] + (3 * control1[axis]) - (3 * control2[axis]) + end[axis],
      (2 * start[axis]) - (4 * control1[axis]) + (2 * control2[axis]),
      -start[axis] + control1[axis],
    );

    for (const t of roots) {
      if (t > 0 && t < 1) {
        const point = evaluateCubic(start, control1, control2, end, t);
        addPointToBounds(bounds, point.x, point.y);
      }
    }
  }
}

function solveQuadratic(a, b, c) {
  if (Math.abs(a) < CURVE_EPSILON) {
    return Math.abs(b) < CURVE_EPSILON ? [] : [-c / b];
  }

  const discriminant = (b * b) - (4 * a * c);
  if (discriminant < -CURVE_EPSILON) return [];
  if (Math.abs(discriminant) < CURVE_EPSILON) return [-b / (2 * a)];

  const root = Math.sqrt(discriminant);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)];
}

function evaluateQuadratic(start, control, end, t) {
  const inverse = 1 - t;
  return {
    x: (inverse * inverse * start.x) + (2 * inverse * t * control.x) + (t * t * end.x),
    y: (inverse * inverse * start.y) + (2 * inverse * t * control.y) + (t * t * end.y),
  };
}

function evaluateCubic(start, control1, control2, end, t) {
  const inverse = 1 - t;
  return {
    x: (inverse ** 3 * start.x) + (3 * inverse * inverse * t * control1.x) + (3 * inverse * t * t * control2.x) + (t ** 3 * end.x),
    y: (inverse ** 3 * start.y) + (3 * inverse * inverse * t * control1.y) + (3 * inverse * t * t * control2.y) + (t ** 3 * end.y),
  };
}

function reflectPoint(point, around) {
  return {
    x: (2 * around.x) - point.x,
    y: (2 * around.y) - point.y,
  };
}

function computeCentroids(svg) {
  provinceCentroids = {};

  for (const path of svg.querySelectorAll('.province-shape')) {
    const provinceId = path.getAttribute('data-id');
    if (!provinceId) continue;

    const bounds = getPathBounds(path.getAttribute('d'));
    if (!bounds) continue;

    provinceCentroids[provinceId] = {
      cx: (bounds.minX + bounds.maxX) / 2,
      cy: (bounds.minY + bounds.maxY) / 2,
    };
  }
}

function parseFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Map labels are stacked SVG cartouches that mirror the HTML
// .province-token grammar: outline = region color, fill = owner color,
// gold inner hairline. Two lines per cartouche: name / current values.
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

function addProvinceLabels(layer) {
  layer.replaceChildren();

  for (const province of PROVINCES) {
    const centroid = provinceCentroids[province.id];
    if (!centroid) continue;

    const theme = latestMapState?.themes?.[province.id] || province;
    const g = buildMapCartouche(province, centroid, theme);
    layer.appendChild(g);
    layoutMapCartouche(g);
  }
}

function buildMapCartouche(province, centroid, theme = province) {
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

  appendCartLine(g, 'map-cart-name', theme.name || province.name);

  // Values line: icon + number pairs replacing the old "P? T? C?" run.
  const entries = provinceValueEntries(theme);
  const valuesGroup = buildSvgValueGroup(entries, MAP_CART_VALUE_OPTS);
  valuesGroup.setAttribute('class', 'map-cart-values');
  valuesGroup.setAttribute('transform', `translate(0 ${MAP_CART_VALUES_BASELINE_Y})`);
  valuesGroup.setAttribute('data-values-sig', valueEntriesSignature(entries));
  g.appendChild(valuesGroup);

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
  if (!bg || !inner || !nameText) return;

  // Use normal alphabetic baselines. Firefox handles SVG baseline keywords
  // differently, so fixed baseline coordinates keep the text stable.
  nameText.setAttribute('y', MAP_CART_NAME_BASELINE_Y);

  const provinceId = g.getAttribute('data-id');
  const theme = latestMapState?.themes?.[provinceId];
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

function updateMapCartoucheValues(cart, theme) {
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

export function updateMapState(state) {
  latestMapState = state;
  for (const [provinceId, theme] of Object.entries(state.themes)) {
    const shape = document.querySelector(`.province-shape[data-id="${provinceId}"]`);
    const cart = document.querySelector(`.map-cartouche[data-id="${provinceId}"]`);

    const ownership = resolveProvinceOwnership(state, provinceId, theme);

    // Province shape: low-saturation parchment-tinted fill via class.
    if (shape) {
      shape.className.baseVal = `province-shape province-${provinceId} ${ownership.classes.join(' ')}`.trim();
      if (ownership.ownerColor) {
        shape.style.setProperty('--owner-color', ownership.ownerColor);
      } else {
        shape.style.removeProperty('--owner-color');
      }
    }

    // Map cartouche: same class set drives full-saturation owner color.
    if (cart) {
      updateMapCartoucheValues(cart, theme);
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
  const withChurchMarker = (classes) => (
    (Number(theme.C) || 0) > 0 ? [...classes, 'has-church'] : classes
  );
  if (theme.occupied) {
    return { classes: withChurchMarker(['occupied']), ownerColor };
  }
  if (theme.owner === 'church') {
    return { classes: withChurchMarker(['imperial', 'church']), ownerColor };
  }
  if (theme.owner !== null) {
    return { classes: withChurchMarker(['imperial', 'owned']), ownerColor };
  }
  if (provinceId === 'CPL') {
    return { classes: withChurchMarker(['imperial', 'capital']), ownerColor };
  }
  return { classes: withChurchMarker(['imperial', 'free']), ownerColor };
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
    const centroid = provinceCentroids[provinceId];
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

    if (!theme.occupied && theme.strategos !== null) {
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
  const originPoint = resolveInvasionOrigin(invasion);
  if (originPoint) points.push(originPoint);

  for (const provinceId of invasion.route) {
    const centroid = provinceCentroids[provinceId];
    if (centroid) points.push(centroid);
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


function resolveInvasionOrigin(invasion) {
  if (!invasion) return null;

  const markerId = invasion.originMarker || INVASION_ORIGIN_IDS[invasion.id];
  if (markerId && invasionOrigins[markerId]) return { ...invasionOrigins[markerId] };

  // Backward-compatible fallback for old saved states or custom invasion data.
  if (invasion.originPos) {
    return {
      cx: invasion.originPos.cx * (MAP_WIDTH / LEGACY_ORIGIN_WIDTH),
      cy: invasion.originPos.cy * (MAP_HEIGHT / LEGACY_ORIGIN_HEIGHT),
    };
  }

  return null;
}

function parseInvasionOrigins(svgText) {
  const sourceSvg = parseSvgRoot(svgText);
  if (!sourceSvg) return {};

  const viewBox = parseSvgViewBox(sourceSvg.getAttribute('viewBox'));
  const origins = {};

  for (const circle of sourceSvg.querySelectorAll('circle[id]')) {
    const id = circle.getAttribute('id')?.trim().toUpperCase();
    const center = readSvgElementCenter(circle);
    if (!id || !/^[A-Z0-9]+$/.test(id) || id.endsWith(PROVINCE_LABEL_SUFFIX) || !center) continue;

    const point = applyElementTransforms(sourceSvg, circle, center);
    origins[id] = normalizeSvgPoint(point, viewBox);
  }

  return origins;
}

function parseSvgViewBox(value) {
  const parts = String(value || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);

  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || parts[2] === 0 || parts[3] === 0) {
    return { x: 0, y: 0, width: MAP_WIDTH, height: MAP_HEIGHT };
  }

  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

function normalizeSvgPoint(point, viewBox) {
  return {
    cx: ((point.cx - viewBox.x) / viewBox.width) * MAP_WIDTH,
    cy: ((point.cy - viewBox.y) / viewBox.height) * MAP_HEIGHT,
  };
}

function applyElementTransforms(sourceSvg, element, point) {
  const chain = [];
  let current = element;

  while (current && current !== sourceSvg) {
    chain.push(current);
    current = current.parentNode;
  }

  return chain.reduce((accumulator, node) => {
    return applyTransformList(accumulator, node.getAttribute?.('transform'));
  }, point);
}

function applyTransformList(point, transform) {
  let next = { ...point };
  const transformText = String(transform || '').trim();
  if (!transformText) return next;

  const transformPattern = /(matrix|translate|scale|rotate)\(([^)]*)\)/g;
  let match;
  while ((match = transformPattern.exec(transformText))) {
    const [, type, rawArgs] = match;
    const args = rawArgs.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    next = applyTransform(next, type, args);
  }

  return next;
}

function applyTransform(point, type, args) {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = args;

  if (type === 'matrix' && args.length >= 6) {
    return { cx: (a * point.cx) + (c * point.cy) + e, cy: (b * point.cx) + (d * point.cy) + f };
  }

  if (type === 'translate') {
    return { cx: point.cx + a, cy: point.cy + b };
  }

  if (type === 'scale') {
    const sy = args.length > 1 ? b : a;
    return { cx: point.cx * a, cy: point.cy * sy };
  }

  if (type === 'rotate') {
    const angle = a * (Math.PI / 180);
    const originX = args.length >= 3 ? b : 0;
    const originY = args.length >= 3 ? c : 0;
    const x = point.cx - originX;
    const y = point.cy - originY;
    return {
      cx: originX + (x * Math.cos(angle)) - (y * Math.sin(angle)),
      cy: originY + (x * Math.sin(angle)) + (y * Math.cos(angle)),
    };
  }

  return point;
}

function appendInvasionCartouche(layer, invasion, point) {
  if (!point) return;

  const strengthText = Array.isArray(invasion.strength) && invasion.strength.length === 2
    ? `Strength ${invasion.strength[0]}-${invasion.strength[1]}`
    : 'Strength ?';
  const nameText = invasion.name || 'Invasion';
  const width = Math.max(26, Math.min(44, Math.max(nameText.length, strengthText.length) * 1.45 + 7));
  const height = 9.6;
  const x = clampValue(point.cx, (width / 2) + 1.2, MAP_WIDTH - (width / 2) - 1.2);
  const y = clampValue(point.cy - 7.3, 1.2, MAP_HEIGHT - height - 1.2);

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'invasion-cartouche');
  group.setAttribute('transform', `translate(${x - (width / 2)} ${y})`);

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

function findProvinceAtEvent(svg, event) {
  const eventTargetHit = findProvinceElement(event.target)?.getAttribute?.('data-id');
  if (eventTargetHit) return eventTargetHit;

  return findProvinceAtClientPoint(svg, event.clientX, event.clientY);
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

function createGestureState() {
  return {
    mode: 'idle',
    pointers: new Map(),
    primaryPointerId: null,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    pinchStartDistance: 0,
    pinchStartZoom: 1,
    pinchContentX: 0,
    pinchContentY: 0,
    moved: false,
    suppressClick: false,
  };
}

function beginMapGesture(svg, event) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  gestureState.pointers.set(event.pointerId, getEventClientPoint(event));
  svg.setPointerCapture?.(event.pointerId);

  if (event.pointerType !== 'mouse') updateHoveredProvince(null);

  if (gestureState.pointers.size >= 2) {
    beginMapPinch(svg);
  } else {
    beginSinglePointerPan(event);
  }

  updateMapCursor(svg, hoveredProvinceId);
}

function beginSinglePointerPan(event) {
  gestureState.mode = 'pan';
  gestureState.primaryPointerId = event.pointerId;
  gestureState.startClientX = event.clientX;
  gestureState.startClientY = event.clientY;
  gestureState.startPanX = mapView.panX;
  gestureState.startPanY = mapView.panY;
}

function beginMapPinch(svg) {
  const pointers = getPrimaryGesturePointers();
  if (pointers.length < 2) return;

  const center = getClientCenter(pointers[0], pointers[1]);
  const centerPoint = clientPointToSvg(svg, center.clientX, center.clientY);
  if (!centerPoint) return;

  const distance = getClientDistance(pointers[0], pointers[1]);
  gestureState.mode = 'pinch';
  gestureState.pinchStartDistance = Math.max(MIN_PINCH_DISTANCE_PX, distance);
  gestureState.pinchStartZoom = mapView.zoom;
  gestureState.pinchContentX = (centerPoint.x - mapView.panX) / mapView.zoom;
  gestureState.pinchContentY = (centerPoint.y - mapView.panY) / mapView.zoom;
}

function updateMapGesture(svg, event) {
  gestureState.pointers.set(event.pointerId, getEventClientPoint(event));

  if (gestureState.pointers.size >= 2) {
    updateMapPinch(svg);
    return;
  }

  updateMapPan(svg, event);
}

function updateMapPan(svg, event) {
  if (gestureState.mode !== 'pan' || event.pointerId !== gestureState.primaryPointerId) return;

  const dragDistance = Math.hypot(event.clientX - gestureState.startClientX, event.clientY - gestureState.startClientY);
  if (dragDistance > MAP_DRAG_THRESHOLD_PX) {
    gestureState.moved = true;
    updateHoveredProvince(null);
  }

  if (mapView.zoom <= 1.001) {
    updateMapCursor(svg, null);
    return;
  }

  const startPoint = clientPointToSvg(svg, gestureState.startClientX, gestureState.startClientY);
  const currentPoint = clientPointToSvg(svg, event.clientX, event.clientY);
  if (!startPoint || !currentPoint) return;

  mapView.panX = gestureState.startPanX + (currentPoint.x - startPoint.x);
  mapView.panY = gestureState.startPanY + (currentPoint.y - startPoint.y);
  clampMapView();
  applyMapTransform();
  updateMapCursor(svg, null);
}

function updateMapPinch(svg) {
  const pointers = getPrimaryGesturePointers();
  if (pointers.length < 2 || gestureState.mode !== 'pinch') return;

  const distance = getClientDistance(pointers[0], pointers[1]);
  const center = getClientCenter(pointers[0], pointers[1]);
  const centerPoint = clientPointToSvg(svg, center.clientX, center.clientY);
  if (!centerPoint || distance < MIN_PINCH_DISTANCE_PX) return;

  const nextZoom = clampValue(
    gestureState.pinchStartZoom * (distance / gestureState.pinchStartDistance),
    MIN_MAP_ZOOM,
    MAX_MAP_ZOOM,
  );

  mapView.zoom = nextZoom;
  mapView.panX = centerPoint.x - gestureState.pinchContentX * mapView.zoom;
  mapView.panY = centerPoint.y - gestureState.pinchContentY * mapView.zoom;
  clampMapView();
  applyMapTransform();

  gestureState.moved = true;
  updateHoveredProvince(null);
  updateMapCursor(svg, null);
}

function endMapGesture(svg, event) {
  if (!gestureState.pointers.has(event.pointerId)) return;

  svg.releasePointerCapture?.(event.pointerId);
  gestureState.pointers.delete(event.pointerId);

  if (gestureState.mode === 'pinch' && gestureState.pointers.size === 1) {
    const [remainingPointer] = gestureState.pointers.entries();
    gestureState.primaryPointerId = remainingPointer[0];
    gestureState.startClientX = remainingPointer[1].clientX;
    gestureState.startClientY = remainingPointer[1].clientY;
    gestureState.startPanX = mapView.panX;
    gestureState.startPanY = mapView.panY;
    gestureState.mode = 'pan';
    updateMapCursor(svg, null);
    return;
  }

  if (gestureState.mode === 'pinch' && gestureState.pointers.size >= 2) {
    beginMapPinch(svg);
    updateMapCursor(svg, null);
    return;
  }

  if (gestureState.pointers.size > 0) return;

  if (gestureState.moved) gestureState.suppressClick = true;

  gestureState.mode = 'idle';
  gestureState.primaryPointerId = null;
  gestureState.moved = false;
  updateMapCursor(svg, hoveredProvinceId);
}

function getEventClientPoint(event) {
  return { clientX: event.clientX, clientY: event.clientY };
}

function getPrimaryGesturePointers() {
  return [...gestureState.pointers.values()].slice(0, 2);
}

function getClientCenter(first, second) {
  return {
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
  };
}

function getClientDistance(first, second) {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
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
  gestureState.suppressClick = true;
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

  const minPanX = MAP_WIDTH * (1 - mapView.zoom);
  const minPanY = MAP_HEIGHT * (1 - mapView.zoom);
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
  if ((gestureState.mode === 'pinch' || gestureState.mode === 'pan') && mapView.zoom > 1.001) {
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
