// render/map/shell.js - builds the map SVG, its shell, resize handling, and controls.

import { ensureSvgIconSymbols } from '../../ui/icons.js';
import { addProvinceLabels } from './cartouches.js';
import { normalizeMapFilter, setActiveMapFilter, updateMapFilterControlState, updateMapState } from './filters.js';
import { parseInvasionOrigins, parseProvinceLabelAnchors } from './geometry.js';
import { applyMapTransform, installMapInteractions, resetMapView, zoomMapAtCenter } from './interaction.js';
import {
  DEFAULT_MAP_MAX_WIDTH_PX,
  MAP_ASPECT,
  MAP_FILTERS,
  MAP_FILTER_LABELS,
  MAP_HEIGHT,
  MAP_MAX_WIDTH_CSS_VAR,
  MAP_WIDTH,
  MAP_ZOOM_STEP,
  SVG_ASSET_PATHS,
  createGestureState,
  mapRuntime,
} from './state.js';
import {
  appendDimOverlay,
  configureThreatHatchPatterns,
  createGroup,
  importBackgroundMap,
  importProvinceShapes,
  loadSvgAsset,
} from './svgImport.js';

export async function createMapSVG(containerId, options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return null;

  mapRuntime.provinceSelectHandler = options.onProvinceSelect || null;
  mapRuntime.provinceHoverHandler = options.onProvinceHover || null;
  mapRuntime.mapFilterChangeHandler = options.onMapFilterChange || null;
  mapRuntime.activeMapFilter = normalizeMapFilter(options.mapFilter || MAP_FILTERS.REGIONS);
  mapRuntime.provinceCentroids = {};
  mapRuntime.invasionOrigins = {};
  mapRuntime.selectedProvinceId = null;
  mapRuntime.hoveredProvinceId = null;
  mapRuntime.viewportLayer = null;
  mapRuntime.latestMapState = null;
  mapRuntime.mapView = { zoom: 1, panX: 0, panY: 0 };
  mapRuntime.gestureState = createGestureState();

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`);
  svg.setAttribute('class', 'game-map');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('overflow', 'hidden');
  svg.id = 'gameMap';
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'Province map. Use plus and minus to zoom, arrow keys to pan when zoomed, and Escape to reset.');
  svg.setAttribute('tabindex', '0');
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

  installMapInteractions(svg);

  const frameLayer = createGroup(svg, 'layer-frame');
  frameLayer.setAttribute('clip-path', 'url(#map-frame-clip)');

  appendDimOverlay(frameLayer);

  mapRuntime.viewportLayer = createGroup(frameLayer, 'layer-viewport');
  applyMapTransform();

  const bgLayer = createGroup(mapRuntime.viewportLayer, 'layer-bg-map');
  const provinceLayer = createGroup(mapRuntime.viewportLayer, 'layer-hitzones');
  const regionStrokeLayer = createGroup(mapRuntime.viewportLayer, 'layer-region-stroke');
  const threatLayer = createGroup(mapRuntime.viewportLayer, 'layer-threats');
  const hitboxLayer = createGroup(mapRuntime.viewportLayer, 'layer-hitboxes');
  createGroup(mapRuntime.viewportLayer, 'layer-invasion-route');
  const labelLayer = createGroup(mapRuntime.viewportLayer, 'layer-labels');
  createGroup(mapRuntime.viewportLayer, 'layer-badges');
  createGroup(mapRuntime.viewportLayer, 'layer-invasion');

  const [backgroundSvg, hitzonesSvg, originSvg] = await Promise.all([
    loadSvgAsset(SVG_ASSET_PATHS.background, 'MAP_BACKGROUND_SVG'),
    loadSvgAsset(SVG_ASSET_PATHS.hitzones, 'HITZONES_SVG'),
    loadSvgAsset(SVG_ASSET_PATHS.origin, 'ORIGIN_SVG'),
  ]);

  importBackgroundMap(svg, bgLayer, backgroundSvg);
  importProvinceShapes(svg, provinceLayer, regionStrokeLayer, threatLayer, hitboxLayer, hitzonesSvg);
  mapRuntime.invasionOrigins = parseInvasionOrigins(originSvg);

  const shell = createMapShell(svg, createMapControls(svg));
  container.replaceChildren(shell);
  installMapShellResize(container, shell);
  ensureSvgIconSymbols(svg);
  configureThreatHatchPatterns(svg);

  mapRuntime.provinceCentroids = parseProvinceLabelAnchors(originSvg);

  requestAnimationFrame(() => {
    configureThreatHatchPatterns(svg);
    addProvinceLabels(labelLayer);
  });

  return svg;
}

function createMapShell(svg, controls) {
  const shell = document.createElement('div');
  shell.className = 'map-shell';
  shell.append(svg, controls);
  return shell;
}

function installMapShellResize(container, shell) {
  mapRuntime.mapShellResizeObserver?.disconnect?.();
  mapRuntime.mapShellResizeObserver = null;
  if (mapRuntime.mapShellResizeHandler && typeof window !== 'undefined') {
    window.removeEventListener?.('resize', mapRuntime.mapShellResizeHandler);
  }
  mapRuntime.mapShellResizeHandler = null;

  const sync = () => syncMapShellSize(container, shell);
  if (typeof ResizeObserver !== 'undefined') {
    mapRuntime.mapShellResizeObserver = new ResizeObserver(sync);
    mapRuntime.mapShellResizeObserver.observe(container);
  } else if (typeof window !== 'undefined') {
    mapRuntime.mapShellResizeHandler = sync;
    window.addEventListener?.('resize', sync, { passive: true });
  }

  sync();
  const requestFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (callback) => setTimeout(callback, 0);
  requestFrame(sync);
}

function syncMapShellSize(container, shell) {
  if (!container || !shell) return;
  const styles = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
  const paddingX = readCssPixels(styles?.paddingLeft) + readCssPixels(styles?.paddingRight);
  const paddingY = readCssPixels(styles?.paddingTop) + readCssPixels(styles?.paddingBottom);
  const availableWidth = Math.max(0, container.clientWidth - paddingX);
  const availableHeight = Math.max(0, container.clientHeight - paddingY);
  if (availableWidth <= 0 || availableHeight <= 0) return;

  const maxWidth = readMapMaxWidth(shell);
  const width = Math.max(1, Math.min(availableWidth, maxWidth, availableHeight * MAP_ASPECT));
  const height = width / MAP_ASPECT;
  shell.style.width = `${width.toFixed(2)}px`;
  shell.style.height = `${height.toFixed(2)}px`;
}

function readMapMaxWidth(shell) {
  if (typeof getComputedStyle !== 'function') return DEFAULT_MAP_MAX_WIDTH_PX;
  const raw = getComputedStyle(shell).getPropertyValue(MAP_MAX_WIDTH_CSS_VAR);
  const parsed = readCssPixels(raw);
  return parsed > 0 ? parsed : DEFAULT_MAP_MAX_WIDTH_PX;
}

function readCssPixels(value) {
  const parsed = Number.parseFloat(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function createMapControls(svg) {
  const root = document.createElement('div');
  root.className = 'map-controls-root';

  const filterControls = document.createElement('div');
  filterControls.className = 'map-filter-controls';
  filterControls.setAttribute('aria-label', 'Map filters');

  for (const [filterId, label] of Object.entries(MAP_FILTER_LABELS)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-filter-btn';
    button.textContent = label;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('data-map-filter', filterId);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setActiveMapFilter(filterId);
      if (typeof mapRuntime.mapFilterChangeHandler === 'function') {
        mapRuntime.mapFilterChangeHandler(filterId);
      } else if (mapRuntime.latestMapState) {
        updateMapState(mapRuntime.latestMapState, filterId);
      }
    });
    filterControls.appendChild(button);
  }

  const controls = document.createElement('div');
  controls.className = 'map-controls map-zoom-controls';
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

  controls.append(
    makeButton('+', 'Zoom in', () => zoomMapAtCenter(svg, MAP_ZOOM_STEP)),
    makeButton('-', 'Zoom out', () => zoomMapAtCenter(svg, 1 / MAP_ZOOM_STEP)),
    makeButton('1:1', 'Reset map view', () => resetMapView(svg)),
  );
  root.append(filterControls, controls);
  updateMapFilterControlState(root);
  return root;
}

export function getCentroids() {
  return mapRuntime.provinceCentroids;
}
