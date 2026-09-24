// render/map/geometry.js - SVG path bounds, transforms, and marker/anchor parsing.

import { PROVINCES } from '../../data/provinces.js';
import {
  CURVE_EPSILON,
  MAP_HEIGHT,
  MAP_WIDTH,
  PATH_PARAM_COUNTS,
  PROVINCE_LABEL_SUFFIX,
  SVG_PATH_TOKEN_PATTERN,
} from './state.js';
import { parseSvgRoot } from './svgImport.js';

export function parseProvinceLabelAnchors(originSvgText) {
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

function parseFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseInvasionOrigins(svgText) {
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
