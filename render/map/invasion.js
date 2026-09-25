// render/map/invasion.js - the current invasion route, its origin cartouche,
// and on the route the amount the invader must beat the frontier by to take
// each province (the invasion ladder).

import { buildInvasionLadder } from '../../engine/combat.js';
import { svgUseIcon } from '../../ui/icons.js';
import {
  INVASION_ORIGIN_IDS,
  LEGACY_ORIGIN_HEIGHT,
  LEGACY_ORIGIN_WIDTH,
  MAP_HEIGHT,
  MAP_WIDTH,
  SVG_NS,
  clampValue,
  mapRuntime,
} from './state.js';

// `state` gives the ladder tags; without it (or once the war is fought) the
// route is drawn bare.
export function drawInvasionRoute(invasion, state = null) {
  const routeLayer = document.getElementById('layer-invasion-route');
  const cartoucheLayer = document.getElementById('layer-invasion');
  if (!routeLayer || !cartoucheLayer) return;

  routeLayer.replaceChildren();
  cartoucheLayer.replaceChildren();
  if (!invasion) return;

  const points = [];
  const originPoint = resolveInvasionOrigin(invasion);
  if (originPoint) points.push(originPoint);

  const routeIds = [];
  for (const provinceId of invasion.route) {
    const centroid = mapRuntime.provinceCentroids[provinceId];
    if (centroid) {
      points.push(centroid);
      routeIds.push(provinceId);
    }
  }

  if (points.length < 2) return;

  let pathData = `M ${points[0].cx} ${points[0].cy}`;
  for (let index = 1; index < points.length; index += 1) {
    pathData += ` L ${points[index].cx} ${points[index].cy}`;
  }

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('class', 'invasion-route');
  routeLayer.appendChild(path);

  for (let index = 1; index < points.length; index += 1) {
    const marker = document.createElementNS(SVG_NS, 'circle');
    marker.setAttribute('cx', points[index].cx);
    marker.setAttribute('cy', points[index].cy);
    marker.setAttribute('r', 0.8);
    marker.setAttribute('class', 'invasion-marker');
    routeLayer.appendChild(marker);
  }

  if (state && state.phase !== 'resolution' && originPoint) {
    appendLadderTags(cartoucheLayer, state, invasion, points, routeIds);
  }
  appendInvasionCartouche(cartoucheLayer, invasion, points[0]);
}

// A tag on the route just before each province: what that step costs the
// invader out of its lead over the frontier ("+3" to take an imperial
// province, "+1" to cross a lost one; Constantinople adds the Walls).
function appendLadderTags(layer, state, invasion, points, routeIds) {
  const ladder = new Map(buildInvasionLadder(state, invasion.route).map((step) => [step.themeId, step]));
  routeIds.forEach((provinceId, index) => {
    const step = ladder.get(provinceId);
    if (!step) return;
    const from = points[index];
    const to = points[index + 1];
    if (!from || !to) return;
    const cx = from.cx + (to.cx - from.cx) * 0.55;
    const cy = from.cy + (to.cy - from.cy) * 0.55;
    const text = `+${step.cost}`;
    const width = 2 + text.length * 1.5;
    const height = 4;
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', `invasion-ladder-tag${step.status === 'capital' ? ' capital' : ''}${step.status === 'lost' ? ' lost' : ''}`);
    group.setAttribute('data-ladder-tag', provinceId);
    group.setAttribute('transform', `translate(${(cx - width / 2).toFixed(2)} ${(cy - height / 2).toFixed(2)})`);
    const title = document.createElementNS(SVG_NS, 'title');
    const name = state.themes?.[provinceId]?.name || provinceId;
    const walls = step.walls ? `, the Theodosian Walls adding ${step.walls}` : '';
    const verb = step.status === 'lost' ? 'Crossing' : 'Taking';
    title.textContent = `${verb} ${name} costs the invader ${step.cost}${walls}. It gets that far if it beats the frontier by ${step.needed} or more.`;
    group.appendChild(title);
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('class', 'invasion-ladder-tag-bg');
    bg.setAttribute('width', width.toFixed(2));
    bg.setAttribute('height', height.toFixed(2));
    bg.setAttribute('rx', (height / 2).toFixed(2));
    group.appendChild(bg);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'invasion-ladder-tag-text');
    label.setAttribute('x', (width / 2).toFixed(2));
    label.setAttribute('y', (height / 2).toFixed(2));
    label.textContent = text;
    group.appendChild(label);
    layer.appendChild(group);
  });
}

function resolveInvasionOrigin(invasion) {
  if (!invasion) return null;

  const markerId = invasion.originMarker || INVASION_ORIGIN_IDS[invasion.id];
  if (markerId && mapRuntime.invasionOrigins[markerId]) return { ...mapRuntime.invasionOrigins[markerId] };

  // Backward-compatible fallback for old saved states or custom invasion data.
  if (invasion.originPos) {
    return {
      cx: invasion.originPos.cx * (MAP_WIDTH / LEGACY_ORIGIN_WIDTH),
      cy: invasion.originPos.cy * (MAP_HEIGHT / LEGACY_ORIGIN_HEIGHT),
    };
  }

  return null;
}

function appendInvasionCartouche(layer, invasion, point) {
  if (!point) return;

  const strengthValue = Array.isArray(invasion.strength) && invasion.strength.length === 2
    ? (Number(invasion.strength[0]) === Number(invasion.strength[1]) ? String(invasion.strength[0]) : `${invasion.strength[0]}-${invasion.strength[1]}`)
    : '?';
  const nameText = invasion.name || 'Invasion';
  const width = Math.max(26, Math.min(44, Math.max(nameText.length, strengthValue.length + 3) * 1.45 + 7));
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

  const strengthGroup = document.createElementNS(SVG_NS, 'g');
  strengthGroup.setAttribute('class', 'invasion-cartouche-strength');
  strengthGroup.setAttribute('transform', `translate(${(width / 2).toFixed(2)} 7.15)`);
  const iconSize = 1.72;
  const iconGap = 0.45;
  const valueWidth = Math.max(1.4, strengthValue.length * 0.82);
  const totalWidth = iconSize + iconGap + valueWidth;
  const iconX = -(totalWidth / 2);
  const strengthIcon = svgUseIcon('troop', {
    x: iconX.toFixed(2),
    y: (-(iconSize / 2)).toFixed(2),
    width: iconSize.toFixed(2),
    height: iconSize.toFixed(2),
    className: 'invasion-cartouche-strength-icon',
  });
  if (strengthIcon) strengthGroup.appendChild(strengthIcon);

  const strength = document.createElementNS(SVG_NS, 'text');
  strength.setAttribute('class', 'invasion-cartouche-strength-value');
  strength.setAttribute('x', (iconX + iconSize + iconGap).toFixed(2));
  strength.setAttribute('y', '0');
  strength.setAttribute('text-anchor', 'start');
  strength.textContent = strengthValue;
  strengthGroup.appendChild(strength);
  group.appendChild(strengthGroup);

  layer.appendChild(group);
}
