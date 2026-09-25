// render/map/svgImport.js - loads the SVG assets and imports background, province shapes, and hatch patterns.

import { getProvinceRegionPalette, getRegionColor } from '../../ui/labels.js';
import {
  ESTATE_STRIPE_BAND,
  MAP_HEIGHT,
  MAP_WIDTH,
  MIN_THREAT_HATCH_SCALE,
  SVG_NS,
  mapRuntime,
  THREAT_HATCH_PRIMARY_STROKE,
  THREAT_HATCH_SPACING,
} from './state.js';

function mapProvinces() {
  return mapRuntime.map?.provinces || [];
}

export async function loadSvgAsset(relativePath, fallbackName) {
  if (typeof fetch === 'function') {
    try {
      const response = await fetch(new URL(relativePath, import.meta.url));
      if (response.ok) return await response.text();
    } catch {
      // Fall through to the embedded copy below.
    }
  }

  // The embedded copies are large, so only download them when the real
  // asset could not be fetched.
  const fallback = await import('../svgAssets.js');
  return fallback[fallbackName];
}

export function importBackgroundMap(rootSvg, layer, svgText) {
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

export function appendDimOverlay(parent) {
  const dimRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  dimRect.setAttribute('width', String(MAP_WIDTH));
  dimRect.setAttribute('height', String(MAP_HEIGHT));
  dimRect.setAttribute('fill', 'rgba(235, 214, 170, 0.05)');
  dimRect.setAttribute('class', 'map-dim-overlay');
  parent.appendChild(dimRect);
}

export function importProvinceShapes(rootSvg, visualLayer, regionStrokeLayer, threatLayer, hitboxLayer, svgText) {
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
    const province = mapProvinces().find((entry) => entry.id === provinceId);
    if (province) applyProvincePalette(path, province.region);
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

    // Apply region color variables so the overlay stroke matches the province outline
    const province = mapProvinces().find((p) => p.id === provinceId);
    if (province) applyProvincePalette(path, province.region);
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

export function applyProvincePalette(element, region) {
  const palette = getProvinceRegionPalette(region);
  element.style.setProperty('--province-region-color', palette.base);
  element.style.setProperty('--province-fill-color', palette.fill);
  element.style.setProperty('--province-cartouche-fill-color', palette.cartFill);
  element.style.setProperty('--province-outline-color', palette.outline);
  element.style.setProperty('--province-lost-fill-color', palette.lostFill);
  element.style.setProperty('--province-lost-cartouche-fill-color', palette.lostCartFill);
  element.style.setProperty('--province-lost-map-outline-color', palette.lostMapOutline);
  element.style.setProperty('--province-lost-outline-color', palette.lostOutline);
  element.style.setProperty('--region-border', palette.outline);
}

function applyInsetRegionBorder(rootSvg, path, provinceId) {
  const province = mapProvinces().find((entry) => entry.id === provinceId);
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
  applyProvincePalette(path, province.region);
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

export function configureThreatHatchPatterns(svg) {
  const defs = svg.querySelector('defs');
  if (!defs) return;

  defs.querySelectorAll('[data-threat-hatch-pattern="province"]').forEach((pattern) => pattern.remove());

  svg.querySelectorAll('.province-threat-overlay').forEach((path) => {
    const provinceId = path.getAttribute('data-id');
    if (!provinceId) return;

    const province = mapProvinces().find((p) => p.id === provinceId);
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

// A striped fill for a province shared by several dynasties: diagonal bands
// in each colour, each as wide as its share. Patterns are cached in <defs> by
// colours, shares and scale.
export function ensureStripePattern(svg, referencePath, stripes) {
  const defs = svg?.querySelector?.('defs');
  if (!defs || !stripes?.length) return null;
  const scale = Math.max(MIN_THREAT_HATCH_SCALE, Number(getElementLinearScale(referencePath)) || 1);
  const total = stripes.reduce((sum, stripe) => sum + Math.max(0, Number(stripe.weight) || 0), 0) || 1;
  // Every band stays visible, however small its share.
  const shares = stripes.map((stripe) => Math.max(0.15, (Math.max(0, Number(stripe.weight) || 0)) / total));
  const shareTotal = shares.reduce((sum, share) => sum + share, 0);
  const key = `${stripes.map((stripe, index) => `${stripe.color}:${(shares[index] / shareTotal).toFixed(3)}`).join('|')}@${scale.toFixed(6)}`;
  const id = `estate-stripes-${hashString(key)}`;
  if (defs.querySelector(`#${id}`)) return id;

  const period = (ESTATE_STRIPE_BAND * stripes.length) / scale;
  const pattern = document.createElementNS(SVG_NS, 'pattern');
  pattern.setAttribute('id', id);
  pattern.setAttribute('data-estate-stripes', 'true');
  pattern.setAttribute('width', String(period));
  pattern.setAttribute('height', String(period));
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  pattern.setAttribute('patternTransform', 'rotate(45)');
  let x = 0;
  stripes.forEach((stripe, index) => {
    const width = period * (shares[index] / shareTotal);
    const band = document.createElementNS(SVG_NS, 'rect');
    band.setAttribute('x', String(x));
    band.setAttribute('y', '0');
    band.setAttribute('width', String(width + period * 0.002));
    band.setAttribute('height', String(period));
    band.setAttribute('fill', stripe.color);
    pattern.appendChild(band);
    x += width;
  });
  defs.appendChild(pattern);
  return id;
}

function hashString(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}

function getElementLinearScale(element) {
  const matrix = element.getCTM?.();
  if (!matrix) return 1;

  const xScale = Math.hypot(matrix.a, matrix.b);
  const yScale = Math.hypot(matrix.c, matrix.d);
  const averageScale = (xScale + yScale) / 2;
  return Number.isFinite(averageScale) && averageScale > 0 ? averageScale : 1;
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

export function parseSvgRoot(svgText) {
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

export function createGroup(parent, id) {
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.id = id;
  parent.appendChild(group);
  return group;
}
