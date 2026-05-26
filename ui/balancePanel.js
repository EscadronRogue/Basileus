// ui/balancePanel.js - Balance of Power sidebar panel.
//
// Renders scoring-category pies together with a live ranking based on the
// official scoring rule: 1 point per 10% share of each scoring category,
// capped at 10 points per category.

import {
  buildBalanceOfPower,
  SCORE_MAX_POINTS_PER_CATEGORY,
  SCORE_SHARE_STEP_PERCENT,
} from '../engine/scoring.js';
import { buildIncomeFlow } from '../engine/cascade.js';
import { getPlayerStyleAttr, renderPlayerRoleName, renderTitleBadge } from './labels.js';
import { formatPlayerLabel, getOfficeDisplayName, getOfficeHolder, getPlayer } from '../engine/state.js';
import { renderIcon, renderIconSet } from './icons.js';
import { REGION_BORDER_COLORS, REGIONS } from '../data/provinces.js';

const CATEGORY_ICON_KINDS = {
  gold: ['gold'],
  estate: ['estate'],
  office: ['church', 'troop'],
};

const FLOW_ICON_KIND = {
  profit: 'gold',
  troop: 'troop',
  church: 'church',
};

const FLOW_SOURCE_LABEL = {
  profit: 'Profit',
  troop: 'Troops',
  church: 'Church',
};

const SANKEY_WIDTH = 1280;
const SANKEY_HEIGHT = 1000;
const SANKEY_SIDE_PAD = 84;
const SANKEY_GAP = 56;
const SANKEY_ROWS = {
  troopSource: 40,
  troopRoute: 210,
  troopOffice: 380,
  player: 510,
  lowerOffice: 650,
  lowerRoute: 700,
  lowerSource: 870,
};
const SANKEY_NODE_WIDTHS = {
  source: 108,
  route: 140,
  office: 156,
  player: 170,
};
const SANKEY_NODE_HEIGHTS = {
  source: 54,
  route: 54,
  office: 54,
  player: 72,
};
const SANKEY_RESOURCE_COLORS = {
  profit: '#c8921e',
  troop: '#6b4a28',
  church: '#2e5490',
};
const SANKEY_ROUTE_COLORS = {
  east_pool: REGION_BORDER_COLORS[REGIONS.EAST],
  west_pool: REGION_BORDER_COLORS[REGIONS.WEST],
  sea_pool: REGION_BORDER_COLORS[REGIONS.SEA],
};
const SANKEY_ROUTE_LABELS = {
  estates: 'Estates',
  strategoi: 'Strategoi',
  east_pool: 'East',
  west_pool: 'West',
  sea_pool: 'Sea',
  bishops: 'Bishops',
  patriarch: 'Patriarch',
};
const SANKEY_ROUTE_META = {
  estates: '',
  strategoi: '',
  east_pool: '',
  west_pool: '',
  sea_pool: '',
  bishops: '',
  patriarch: '',
};
const SANKEY_OFFICE_LABELS = {
  BASILEUS: 'Basileus',
  DOM_EAST: 'Dom. East',
  DOM_WEST: 'Dom. West',
  ADMIRAL: 'Admiral',
  PATRIARCH: 'Patriarch',
};
const SANKEY_ROUTE_ORDER = ['estates', 'strategoi', 'east_pool', 'west_pool', 'sea_pool', 'bishops', 'patriarch'];
const SANKEY_CASCADE_ROUTE_KEYS = new Set(['east_pool', 'west_pool', 'sea_pool']);
const SANKEY_OFFICE_ORDER = ['DOM_EAST', 'BASILEUS', 'DOM_WEST', 'ADMIRAL', 'PATRIARCH'];
const INCOME_FLOW_MIN_ZOOM = 0.25;
const INCOME_FLOW_MAX_ZOOM = 4;
const INCOME_FLOW_HOME_ZOOM = 0.78;
const INCOME_FLOW_ZOOM_STEP = 1.2;
const INCOME_FLOW_DRAG_THRESHOLD_PX = 1;
const INCOME_FLOW_MIN_PINCH_DISTANCE_PX = 8;
const incomeFlowViews = new WeakMap();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Polar -> cartesian on a unit circle anchored at (0, 0). Angles are taken in
// turns (0..1) so accumulating fractional shares stays numerically clean.
function polar(turns) {
  const angle = (turns - 0.25) * 2 * Math.PI; // start at 12 o'clock
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function describeSlicePath(startTurn, endTurn, radius) {
  // Single-slice degenerate case (a whole circle): two half-arcs to render fill.
  if (endTurn - startTurn >= 0.999999) {
    return `M 0 ${-radius} A ${radius} ${radius} 0 1 1 0 ${radius} A ${radius} ${radius} 0 1 1 0 ${-radius} Z`;
  }
  const start = polar(startTurn);
  const end = polar(endTurn);
  const largeArc = endTurn - startTurn > 0.5 ? 1 : 0;
  return `M 0 0 L ${(start.x * radius).toFixed(3)} ${(start.y * radius).toFixed(3)} `
    + `A ${radius} ${radius} 0 ${largeArc} 1 ${(end.x * radius).toFixed(3)} ${(end.y * radius).toFixed(3)} Z`;
}

function formatShare(share) {
  const pct = Math.round((Number(share) || 0) * 100);
  return `${pct}%`;
}

function getSliceColor(state, slice) {
  return getPlayer(state, slice.playerId)?.color || '#5a3810';
}

function getSliceLabel(state, slice) {
  return formatPlayerLabel(getPlayer(state, slice.playerId)) || `Player ${Number(slice.playerId) + 1}`;
}

function renderPieSvg(state, category) {
  const radius = 42;
  const viewBox = `-50 -50 100 100`;

  if (category.total <= 0) {
    return `
      <svg class="balance-pie-svg" viewBox="${viewBox}" role="img" aria-label="${category.label} - no value yet">
        <circle r="${radius}" cx="0" cy="0" fill="rgba(168,116,32,0.10)" stroke="rgba(168,116,32,0.25)" stroke-width="1"></circle>
        <text x="0" y="4" text-anchor="middle" class="balance-pie-empty">-</text>
      </svg>
    `;
  }

  let cursor = 0;
  const paths = category.slices.filter((slice) => slice.share > 0).map((slice) => {
    const start = cursor;
    cursor += slice.share;
    const end = Math.min(cursor, 1);
    const color = getSliceColor(state, slice);
    const title = `${getSliceLabel(state, slice)} - ${formatShare(slice.share)} (${slice.points} pt${slice.points === 1 ? '' : 's'})`;
    return `<path d="${describeSlicePath(start, end, radius)}" fill="${color}" stroke="rgba(20,8,0,0.45)" stroke-width="0.6"><title>${escapeHtml(title)}</title></path>`;
  }).join('');

  return `
    <svg class="balance-pie-svg" viewBox="${viewBox}" role="img" aria-label="${category.label} shares">
      ${paths}
    </svg>
  `;
}

function renderLegend(state, category) {
  if (category.total <= 0) {
    return '<div class="balance-pie-legend-empty">No value yet.</div>';
  }

  const rows = category.slices.map((slice) => {
    const player = getPlayer(state, slice.playerId);
    const name = formatPlayerLabel(player) || `Player ${Number(slice.playerId) + 1}`;
    return `
      <div class="balance-legend-row" style="${getPlayerStyleAttr(state, slice.playerId)}">
        <span class="balance-legend-dot" style="background:var(--player-color)"></span>
        <span class="balance-legend-name">${escapeHtml(name)}</span>
        <span class="balance-legend-share">${formatShare(slice.share)}</span>
        <span class="balance-legend-points" title="Each ${SCORE_SHARE_STEP_PERCENT}% of this category scores 1 point (max ${SCORE_MAX_POINTS_PER_CATEGORY}).">${slice.points}</span>
      </div>
    `;
  }).join('');

  return `<div class="balance-pie-legend">${rows}</div>`;
}

function renderPieCard(state, category) {
  const iconHtml = renderCategoryIconSet(category, 'balance-pie-iconset');
  return `
    <div class="balance-pie" title="${category.description}">
      <div class="balance-pie-head">
        <span class="balance-pie-title">${iconHtml}<span>${category.label}</span></span>
      </div>
      ${renderPieSvg(state, category)}
      ${renderLegend(state, category)}
    </div>
  `;
}

function renderRankingBreakdown(entry) {
  if (!Array.isArray(entry?.categories)) return '';

  const parts = [];
  for (const cat of entry.categories) {
    const value = Math.max(0, Math.round(Number(cat.value) || 0));
    parts.push(renderCategoryValueChip(cat, value));
  }
  return parts.join('');
}

function getCategoryIconKinds(category) {
  return (Array.isArray(category?.iconKinds) && category.iconKinds.length)
    ? category.iconKinds
    : CATEGORY_ICON_KINDS[category?.key] || [];
}

function renderCategoryIconSet(category, extraClass = '') {
  return renderIconSet(getCategoryIconKinds(category), extraClass);
}

function renderCategoryValueChip(category, value) {
  const title = category?.label ? ` title="${escapeHtml(category.label)}"` : '';
  return `<span class="value ${category?.key || ''}"${title}>${renderCategoryIconSet(category)}<span class="value-num">${value}</span></span>`;
}

function renderValueChip(iconKind, value, label) {
  const title = label ? ` title="${escapeHtml(label)}"` : '';
  return `<span class="value ${iconKind}"${title}>${renderIcon(iconKind)}<span class="value-num">${value}</span></span>`;
}

function getFlowIconKind(resource) {
  return FLOW_ICON_KIND[resource] || resource;
}

function renderFlowValue(resource, value, label = '') {
  const iconKind = getFlowIconKind(resource);
  return renderValueChip(iconKind, Math.max(0, Math.round(Number(value) || 0)), label);
}

function getFlowRecipientName(state, playerId) {
  const player = getPlayer(state, playerId);
  return formatPlayerLabel(player) || `Player ${Number(playerId) + 1}`;
}

function roundFlowValue(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function getResourceColor(resource) {
  return SANKEY_RESOURCE_COLORS[resource] || '#8c6840';
}

function getRouteColor(route) {
  return SANKEY_ROUTE_COLORS[route?.key] || getResourceColor(route?.resource);
}

function getRouteLabel(route) {
  return SANKEY_ROUTE_LABELS[route?.key] || route?.label || '';
}

function getRouteMeta(route) {
  return SANKEY_ROUTE_META[route?.key] || '';
}

function getOfficeShortLabel(state, officeKey) {
  return SANKEY_OFFICE_LABELS[officeKey] || getOfficeDisplayName(state, officeKey);
}

function getPlayerColor(state, playerId) {
  return getPlayer(state, playerId)?.color || '#8c6840';
}

function getFlowSection(flow, key) {
  return (flow.sections || []).find((section) => section.key === key) || null;
}

function getPlayerFlowTotal(flow, playerId) {
  const entry = (flow.playerTotals || []).find((row) => Number(row.playerId) === Number(playerId));
  return {
    profit: roundFlowValue(entry?.profit),
    troop: roundFlowValue(entry?.troop),
    church: roundFlowValue(entry?.church),
  };
}

function createSankeyNode(nodes, key, attrs = {}) {
  if (!nodes.has(key)) {
    nodes.set(key, {
      key,
      layer: attrs.layer || 'route',
      label: attrs.label || key,
      rule: attrs.rule || '',
      resource: attrs.resource || null,
      value: 0,
      fill: attrs.fill || '#8c6840',
      stroke: attrs.stroke || 'rgba(20,8,0,0.35)',
      playerId: attrs.playerId ?? null,
      isUnclaimed: Boolean(attrs.isUnclaimed),
      iconResource: attrs.iconResource || attrs.resource || null,
      officeKey: attrs.officeKey || null,
      rowKey: attrs.rowKey || null,
      width: attrs.width || null,
      order: attrs.order ?? 0,
      linksIn: [],
      linksOut: [],
    });
  }
  const node = nodes.get(key);
  if (attrs.value != null) node.value = Math.max(node.value, Math.max(0, Number(attrs.value) || 0));
  if (attrs.addValue != null) node.value += Math.max(0, Number(attrs.addValue) || 0);
  return node;
}

function addSankeyLink(nodes, links, sourceKey, targetKey, value, resource, label, color = null) {
  const amount = Math.max(0, Number(value) || 0);
  if (amount <= 0 || !nodes.has(sourceKey) || !nodes.has(targetKey)) return;
  const link = {
    sourceKey,
    targetKey,
    value: amount,
    resource,
    label,
    color: color || getResourceColor(resource),
  };
  links.push(link);
}

function ensureUnclaimedNode(nodes, resource) {
  return createSankeyNode(nodes, `unclaimed:${resource}`, {
    layer: 'player',
    rowKey: 'player',
    label: 'Unclaimed',
    resource,
    addValue: 0,
    fill: '#d8c8a8',
    stroke: 'rgba(107,74,40,0.48)',
    isUnclaimed: true,
    order: 999,
  });
}

function buildIncomeSankeyModel(state, flow) {
  const nodes = new Map();
  const links = [];
  const officeTerminals = new Map();

  for (const resource of ['profit', 'troop', 'church']) {
    const section = getFlowSection(flow, resource);
    createSankeyNode(nodes, `source:${resource}`, {
      layer: 'source',
      rowKey: resource === 'troop' ? 'troopSource' : 'lowerSource',
      label: FLOW_SOURCE_LABEL[resource] || resource,
      resource,
      iconResource: resource,
      value: section?.total || 0,
      fill: getResourceColor(resource),
      stroke: 'rgba(20,8,0,0.46)',
      order: ['profit', 'troop', 'church'].indexOf(resource),
    });
  }

  for (const player of state.players || []) {
    const totals = getPlayerFlowTotal(flow, player.id);
    createSankeyNode(nodes, `player:${player.id}`, {
      layer: 'player',
      rowKey: 'player',
      label: formatPlayerLabel(player) || `Player ${Number(player.id) + 1}`,
      value: totals.profit + totals.troop + totals.church,
      fill: player.color || '#8c6840',
      stroke: 'rgba(20,8,0,0.48)',
      playerId: player.id,
      order: player.id,
    });
  }

  for (const section of flow.sections || []) {
    for (const route of section.routes || []) {
      const routeKey = `route:${route.key}`;
      const routeColor = getRouteColor(route);
      createSankeyNode(nodes, routeKey, {
        layer: 'route',
        rowKey: route.resource === 'troop' ? 'troopRoute' : 'lowerRoute',
        label: getRouteLabel(route),
        rule: getRouteMeta(route),
        resource: route.resource,
        iconResource: route.resource,
        value: route.total,
        fill: routeColor,
        stroke: routeColor,
        order: SANKEY_ROUTE_ORDER.indexOf(route.key),
      });
      addSankeyLink(
        nodes,
        links,
        `source:${section.key}`,
        routeKey,
        route.total,
        route.resource,
        `${FLOW_SOURCE_LABEL[section.key] || section.label} to ${route.label}`,
        routeColor,
      );

      if (SANKEY_CASCADE_ROUTE_KEYS.has(route.key)) {
        for (const office of route.offices || []) {
          const officeKey = `office:${office.officeKey}`;
          const holderColor = office.playerId == null ? getResourceColor(route.resource) : getPlayerColor(state, office.playerId);
          createSankeyNode(nodes, officeKey, {
            layer: 'office',
            rowKey: route.resource === 'troop' ? 'troopOffice' : 'lowerOffice',
            label: getOfficeShortLabel(state, office.officeKey),
            resource: route.resource,
            iconResource: route.resource,
            addValue: office.value,
            fill: holderColor,
            stroke: routeColor,
            playerId: office.playerId,
            officeKey: office.officeKey,
            order: SANKEY_OFFICE_ORDER.indexOf(office.officeKey),
          });
          addSankeyLink(
            nodes,
            links,
            routeKey,
            officeKey,
            office.value,
            route.resource,
            `${route.label} to ${getOfficeDisplayName(state, office.officeKey)}`,
            routeColor,
          );

          const terminalKey = `${officeKey}:${office.playerId ?? 'unclaimed'}:${route.resource}`;
          const terminal = officeTerminals.get(terminalKey) || {
            sourceKey: officeKey,
            playerId: office.playerId,
            resource: route.resource,
            color: routeColor,
            value: 0,
            label: getOfficeDisplayName(state, office.officeKey),
          };
          terminal.value += Math.max(0, Number(office.value) || 0);
          officeTerminals.set(terminalKey, terminal);
        }
      } else {
        for (const recipient of route.recipients || []) {
          addSankeyLink(
            nodes,
            links,
            routeKey,
            `player:${recipient.playerId}`,
            recipient.value,
            route.resource,
            `${route.label} to ${getFlowRecipientName(state, recipient.playerId)}`,
            routeColor,
          );
        }
      }

      if (route.unclaimed > 0) {
        const unclaimed = ensureUnclaimedNode(nodes, route.resource);
        unclaimed.value += route.unclaimed;
        addSankeyLink(nodes, links, routeKey, unclaimed.key, route.unclaimed, route.resource, `${route.label} unclaimed`, routeColor);
      }
    }
  }

  for (const terminal of officeTerminals.values()) {
    if (terminal.playerId == null) {
      const unclaimed = ensureUnclaimedNode(nodes, terminal.resource);
      unclaimed.value += terminal.value;
      addSankeyLink(nodes, links, terminal.sourceKey, unclaimed.key, terminal.value, terminal.resource, `${terminal.label} unclaimed`, terminal.color);
    } else {
      addSankeyLink(
        nodes,
        links,
        terminal.sourceKey,
        `player:${terminal.playerId}`,
        terminal.value,
        terminal.resource,
        `${terminal.label} to ${getFlowRecipientName(state, terminal.playerId)}`,
        terminal.color,
      );
    }
  }

  return layoutIncomeSankey(nodes, links);
}

function getNodeMinHeight(node) {
  return SANKEY_NODE_HEIGHTS[node.layer] || 46;
}

function getNodeWidth(node) {
  return node.width || SANKEY_NODE_WIDTHS[node.layer] || 88;
}

function getNodeRowKey(node) {
  if (node.rowKey) return node.rowKey;
  if (node.layer === 'player') return 'player';
  if (node.resource === 'troop') {
    if (node.layer === 'source') return 'troopSource';
    if (node.layer === 'route') return 'troopRoute';
    return 'troopOffice';
  }
  if (node.layer === 'source') return 'lowerSource';
  if (node.layer === 'route') return 'lowerRoute';
  if (node.layer === 'office') return 'lowerOffice';
  return 'player';
}

function getNodeRowY(node) {
  return SANKEY_ROWS[getNodeRowKey(node)] ?? SANKEY_ROWS.player;
}

function getOrderedSankeyNodes(nodes, rowKey) {
  const list = [...nodes.values()].filter((node) => getNodeRowKey(node) === rowKey);
  return list.sort((left, right) => {
    const leftOrder = left.order < 0 ? 999 : left.order;
    const rightOrder = right.order < 0 ? 999 : right.order;
    return (leftOrder - rightOrder) || left.label.localeCompare(right.label);
  });
}

function layoutSankeyRow(list) {
  if (!list.length) return;
  const availableWidth = SANKEY_WIDTH - SANKEY_SIDE_PAD * 2;
  const totalWidth = list.reduce((sum, node) => sum + node.width, 0);
  const gap = list.length > 1
    ? Math.max(8, Math.min(SANKEY_GAP, (availableWidth - totalWidth) / (list.length - 1)))
    : 0;
  const usedWidth = totalWidth + Math.max(0, list.length - 1) * gap;
  let x = SANKEY_SIDE_PAD + Math.max(0, (availableWidth - usedWidth) / 2);
  for (const node of list) {
    node.x = x;
    node.y = getNodeRowY(node);
    x += node.width + gap;
  }
}

function getLinksWidth(links) {
  return links.reduce((sum, link) => sum + link.width, 0);
}

function assignSankeyEdgePoints(links, edge, assign) {
  if (!links.length) return;
  const firstNode = assign === 'source' ? links[0].source : links[0].target;
  const totalWidth = getLinksWidth(links);
  let cursor = (firstNode.width - totalWidth) / 2;
  for (const link of links) {
    const node = assign === 'source' ? link.source : link.target;
    const x = node.x + cursor + link.width / 2;
    const y = edge === 'top' ? node.y : node.y + node.height;
    if (assign === 'source') {
      link.sx = x;
      link.sy = y;
    } else {
      link.tx = x;
      link.ty = y;
    }
    cursor += link.width;
  }
}

function layoutIncomeSankey(nodes, links) {
  for (const link of links) {
    link.source = nodes.get(link.sourceKey);
    link.target = nodes.get(link.targetKey);
  }

  const rows = [
    getOrderedSankeyNodes(nodes, 'troopSource'),
    getOrderedSankeyNodes(nodes, 'troopRoute'),
    getOrderedSankeyNodes(nodes, 'troopOffice'),
    getOrderedSankeyNodes(nodes, 'player'),
    getOrderedSankeyNodes(nodes, 'lowerOffice'),
    getOrderedSankeyNodes(nodes, 'lowerRoute'),
    getOrderedSankeyNodes(nodes, 'lowerSource'),
  ];
  const maxNodeValue = Math.max(...[...nodes.values()].map((node) => Math.max(0, Number(node.value) || 0)), 1);
  const scale = Math.max(3.2, Math.min(8, 96 / maxNodeValue));

  for (const node of nodes.values()) {
    node.height = getNodeMinHeight(node);
    node.y = getNodeRowY(node);
  }

  for (const link of links) {
    link.width = Math.max(4, link.value * scale);
    link.source.linksOut.push(link);
    link.target.linksIn.push(link);
  }

  for (const node of nodes.values()) {
    const outgoingUp = node.linksOut.filter((link) => getNodeRowY(link.target) < getNodeRowY(node));
    const outgoingDown = node.linksOut.filter((link) => getNodeRowY(link.target) >= getNodeRowY(node));
    const incomingFromAbove = node.linksIn.filter((link) => getNodeRowY(link.source) < getNodeRowY(node));
    const incomingFromBelow = node.linksIn.filter((link) => getNodeRowY(link.source) >= getNodeRowY(node));
    const maxEdgeWidth = Math.max(
      getLinksWidth(outgoingUp),
      getLinksWidth(outgoingDown),
      getLinksWidth(incomingFromAbove),
      getLinksWidth(incomingFromBelow),
    );
    node.width = Math.max(getNodeWidth(node), maxEdgeWidth + 18);
  }

  rows.forEach(layoutSankeyRow);

  for (const node of nodes.values()) {
    const outgoing = node.linksOut.slice().sort((left, right) => (left.target.x - right.target.x) || (left.target.y - right.target.y));
    const incoming = node.linksIn.slice().sort((left, right) => (left.source.x - right.source.x) || (left.source.y - right.source.y));
    assignSankeyEdgePoints(
      outgoing.filter((link) => link.target.y < node.y),
      'top',
      'source',
    );
    assignSankeyEdgePoints(
      outgoing.filter((link) => link.target.y >= node.y),
      'bottom',
      'source',
    );
    assignSankeyEdgePoints(
      incoming.filter((link) => link.source.y < node.y),
      'top',
      'target',
    );
    assignSankeyEdgePoints(
      incoming.filter((link) => link.source.y >= node.y),
      'bottom',
      'target',
    );
  }

  return {
    nodes: [...nodes.values()],
    links,
  };
}

function getSankeyLinkGeometry(link) {
  const sourceY = link.sy;
  const targetY = link.ty;
  const direction = targetY >= sourceY ? 1 : -1;
  const curve = Math.max(44, Math.abs(targetY - sourceY) * 0.48);
  return {
    x0: link.sx,
    y0: sourceY,
    x1: link.sx,
    y1: sourceY + direction * curve,
    x2: link.tx,
    y2: targetY - direction * curve,
    x3: link.tx,
    y3: targetY,
  };
}

function describeSankeyLinkPath(link) {
  const p = getSankeyLinkGeometry(link);
  return `M ${p.x0.toFixed(2)} ${p.y0.toFixed(2)} C ${p.x1.toFixed(2)} ${p.y1.toFixed(2)}, ${p.x2.toFixed(2)} ${p.y2.toFixed(2)}, ${p.x3.toFixed(2)} ${p.y3.toFixed(2)}`;
}

function renderSankeyLink(link) {
  const path = describeSankeyLinkPath(link);
  const title = `${link.label}: ${roundFlowValue(link.value)}`;
  return `<path class="income-sankey-link income-sankey-${link.resource}" d="${path}" stroke="${link.color}" stroke-width="${link.width.toFixed(2)}"><title>${escapeHtml(title)}</title></path>`;
}

function renderSankeyNodeTotal(node) {
  if (!node.iconResource && !node.resource) return '';
  return `<span class="income-sankey-node-total">${renderFlowValue(node.iconResource || node.resource, node.value)}</span>`;
}

function renderSankeyLabeledNodeContent(node) {
  return `
    <span class="income-sankey-node-name">${escapeHtml(node.label)}</span>
    ${renderSankeyNodeTotal(node)}
  `;
}

function renderSankeyGenericCartouche(node, content, title = '') {
  const label = title || `${node.label}: ${roundFlowValue(node.value)}`;
  return `
    <span class="title-token compact income-sankey-generic-token"
      style="--cart-bg: ${node.fill}; --cart-border: ${node.stroke};"
      title="${escapeHtml(label)}">
      ${content}
    </span>
  `;
}

function renderSankeyOfficeCartouche(state, node) {
  const officeKey = node.officeKey || String(node.key || '').replace(/^office:/, '');
  if (!officeKey) return '';
  const holderId = getOfficeHolder(state, officeKey);
  const badge = renderTitleBadge(state, officeKey, {
    holderId,
    compact: true,
    label: node.label,
  });
  const title = escapeHtml(`${node.label}: ${roundFlowValue(node.value)}`);
  return badge
    .replace(/ title="[^"]*"/, ` title="${title}"`)
    .replace('</span>', `${renderSankeyNodeTotal(node)}</span>`);
}

function renderSankeyPlayerCartouche(state, flow, node) {
  const totals = getPlayerFlowTotal(flow, node.playerId);
  const player = getPlayer(state, node.playerId);
  const name = escapeHtml(player?.dynasty || getFlowRecipientName(state, node.playerId));
  return `
    <div class="player-tab income-sankey-player-cartouche" style="${getPlayerStyleAttr(state, node.playerId)}" title="${escapeHtml(getFlowRecipientName(state, node.playerId))}">
      <span class="tab-body">
        <span class="tab-name">${name}</span>
        <span class="tab-finance income-sankey-player-values">
          ${renderFlowValue('profit', totals.profit)}
          ${renderFlowValue('troop', totals.troop)}
          ${renderFlowValue('church', totals.church)}
        </span>
      </span>
    </div>
  `;
}

function renderSankeyNodeHtml(state, flow, node) {
  if (node.layer === 'source') {
    return renderSankeyGenericCartouche(
      node,
      `<span class="income-sankey-source-value">${renderFlowValue(node.iconResource, node.value)}</span>`,
      node.label,
    );
  }

  if (node.layer === 'office') {
    return renderSankeyOfficeCartouche(state, node) || renderSankeyGenericCartouche(node, renderSankeyLabeledNodeContent(node));
  }

  if (node.layer === 'player') {
    if (!node.isUnclaimed) return renderSankeyPlayerCartouche(state, flow, node);
    return renderSankeyGenericCartouche(
      node,
      `<span class="income-sankey-unclaimed">${renderSankeyLabeledNodeContent(node)}</span>`,
    );
  }

  if (node.layer === 'route' && node.key === 'route:patriarch') {
    return renderSankeyOfficeCartouche(state, { ...node, officeKey: 'PATRIARCH' });
  }

  return renderSankeyGenericCartouche(node, renderSankeyLabeledNodeContent(node));
}

function renderSankeyNode(state, flow, node) {
  const classes = [
    'income-sankey-node',
    `income-sankey-node-${node.layer}`,
    `income-sankey-row-${getNodeRowKey(node)}`,
    node.resource ? `income-sankey-node-${node.resource}` : '',
    node.isUnclaimed ? 'is-unclaimed' : '',
  ].filter(Boolean).join(' ');
  return `
    <g class="${classes}">
      <foreignObject class="income-sankey-node-foreign" x="${node.x.toFixed(2)}" y="${node.y.toFixed(2)}" width="${node.width.toFixed(2)}" height="${node.height.toFixed(2)}">
        <div xmlns="http://www.w3.org/1999/xhtml" class="income-sankey-node-html income-sankey-node-html-${node.layer}">
          ${renderSankeyNodeHtml(state, flow, node)}
        </div>
      </foreignObject>
    </g>
  `;
}

function renderIncomeSankeySvg(state, flow) {
  const model = buildIncomeSankeyModel(state, flow);
  const links = model.links
    .slice()
    .sort((left, right) => (right.width - left.width) || left.sourceKey.localeCompare(right.sourceKey))
    .map(renderSankeyLink)
    .join('');
  const nodes = model.nodes.map((node) => renderSankeyNode(state, flow, node)).join('');

  return `
    <svg class="income-flow-sankey" viewBox="0 0 ${SANKEY_WIDTH} ${SANKEY_HEIGHT}" role="img" aria-label="Imperial income Sankey diagram" overflow="hidden">
      <g class="income-sankey-viewport">
        <g class="income-sankey-links">${links}</g>
        <g class="income-sankey-nodes">${nodes}</g>
      </g>
    </svg>
  `;
}

function renderIncomeFlowControls() {
  return `
    <div class="income-flow-controls" aria-label="Income flow zoom controls">
      <button class="map-control-btn" type="button" data-income-flow-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>
      <button class="map-control-btn" type="button" data-income-flow-zoom="out" title="Zoom out" aria-label="Zoom out">-</button>
      <button class="map-control-btn" type="button" data-income-flow-zoom="reset" title="Reset diagram view" aria-label="Reset diagram view">1:1</button>
    </div>
  `;
}

function renderIncomeFlowDiagram(state, flow) {
  if (!flow?.sections?.length) return '';
  return `
    <section class="income-flow-diagram" aria-label="Imperial income flow">
      <header class="income-flow-head">
        <span class="income-flow-title">Imperial Flow</span>
        <span class="income-flow-totals">
          ${renderFlowValue('profit', flow.totals?.profit || 0, 'Profit')}
          ${renderFlowValue('troop', flow.totals?.troop || 0, 'Troops')}
          ${renderFlowValue('church', flow.totals?.church || 0, 'Church')}
        </span>
      </header>
      <div class="income-flow-scroll">
        <div class="income-flow-canvas">
          ${renderIncomeSankeySvg(state, flow)}
        </div>
      </div>
      ${renderIncomeFlowControls()}
    </section>
  `;
}

function createIncomeFlowGestureState() {
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
  };
}

function createIncomeFlowHomeView() {
  const zoom = INCOME_FLOW_HOME_ZOOM;
  return {
    zoom,
    panX: (SANKEY_WIDTH - SANKEY_WIDTH * zoom) / 2,
    panY: (SANKEY_HEIGHT - SANKEY_HEIGHT * zoom) / 2,
    didCenterScroll: false,
  };
}

function getIncomeFlowView(container) {
  const existing = incomeFlowViews.get(container);
  if (existing) return existing;
  const view = createIncomeFlowHomeView();
  incomeFlowViews.set(container, view);
  return view;
}

function bindIncomeFlowInteractions(container) {
  const svg = container?.querySelector?.('.income-flow-sankey');
  const viewport = svg?.querySelector?.('.income-sankey-viewport');
  if (!svg || !viewport) return;

  const scrollFrame = container.querySelector?.('.income-flow-scroll');
  const view = getIncomeFlowView(container);
  const gesture = createIncomeFlowGestureState();

  const applyTransform = () => {
    clampIncomeFlowView(view);
    viewport.setAttribute(
      'transform',
      `translate(${view.panX.toFixed(3)} ${view.panY.toFixed(3)}) scale(${view.zoom.toFixed(3)})`,
    );
    svg.classList.toggle('is-zoomed', isIncomeFlowZoomed(view));
  };

  const updateCursor = () => {
    if (gesture.mode === 'pinch' || gesture.mode === 'pan') {
      svg.style.cursor = 'grabbing';
      return;
    }
    svg.style.cursor = 'grab';
  };

  const zoomAtClientPoint = (clientX, clientY, factor) => {
    const point = clientPointToIncomeFlowSvg(svg, clientX, clientY);
    if (!point) return;

    const nextZoom = clampValue(view.zoom * factor, INCOME_FLOW_MIN_ZOOM, INCOME_FLOW_MAX_ZOOM);
    if (Math.abs(nextZoom - view.zoom) < 0.001) return;

    const contentX = (point.x - view.panX) / view.zoom;
    const contentY = (point.y - view.panY) / view.zoom;

    view.zoom = nextZoom;
    view.panX = point.x - contentX * view.zoom;
    view.panY = point.y - contentY * view.zoom;
    applyTransform();
    updateCursor();
  };

  const zoomAtCenter = (factor) => {
    const rect = svg.getBoundingClientRect();
    zoomAtClientPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  const resetView = () => {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    applyTransform();
    updateCursor();
  };

  const beginPinch = () => {
    const pointers = getPrimaryIncomeFlowPointers(gesture);
    if (pointers.length < 2) return;

    const center = getClientCenter(pointers[0], pointers[1]);
    const centerPoint = clientPointToIncomeFlowSvg(svg, center.clientX, center.clientY);
    if (!centerPoint) return;

    const distance = getClientDistance(pointers[0], pointers[1]);
    gesture.mode = 'pinch';
    gesture.pinchStartDistance = Math.max(INCOME_FLOW_MIN_PINCH_DISTANCE_PX, distance);
    gesture.pinchStartZoom = view.zoom;
    gesture.pinchContentX = (centerPoint.x - view.panX) / view.zoom;
    gesture.pinchContentY = (centerPoint.y - view.panY) / view.zoom;
  };

  const updatePinch = () => {
    const pointers = getPrimaryIncomeFlowPointers(gesture);
    if (pointers.length < 2 || gesture.mode !== 'pinch') return;

    const distance = getClientDistance(pointers[0], pointers[1]);
    const center = getClientCenter(pointers[0], pointers[1]);
    const centerPoint = clientPointToIncomeFlowSvg(svg, center.clientX, center.clientY);
    if (!centerPoint || distance < INCOME_FLOW_MIN_PINCH_DISTANCE_PX) return;

    view.zoom = clampValue(
      gesture.pinchStartZoom * (distance / gesture.pinchStartDistance),
      INCOME_FLOW_MIN_ZOOM,
      INCOME_FLOW_MAX_ZOOM,
    );
    view.panX = centerPoint.x - gesture.pinchContentX * view.zoom;
    view.panY = centerPoint.y - gesture.pinchContentY * view.zoom;
    gesture.moved = true;
    applyTransform();
    updateCursor();
  };

  const beginPan = (event) => {
    gesture.mode = 'pan';
    gesture.primaryPointerId = event.pointerId;
    gesture.startClientX = event.clientX;
    gesture.startClientY = event.clientY;
    gesture.startPanX = view.panX;
    gesture.startPanY = view.panY;
  };

  const updatePan = (event) => {
    if (gesture.mode !== 'pan' || event.pointerId !== gesture.primaryPointerId) return;

    const dragDistance = Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY);
    if (dragDistance > INCOME_FLOW_DRAG_THRESHOLD_PX) gesture.moved = true;

    const startPoint = clientPointToIncomeFlowSvg(svg, gesture.startClientX, gesture.startClientY);
    const currentPoint = clientPointToIncomeFlowSvg(svg, event.clientX, event.clientY);
    if (!startPoint || !currentPoint) return;

    view.panX = gesture.startPanX + (currentPoint.x - startPoint.x);
    view.panY = gesture.startPanY + (currentPoint.y - startPoint.y);
    applyTransform();
    updateCursor();
  };

  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomAtClientPoint(event.clientX, event.clientY, event.deltaY < 0 ? INCOME_FLOW_ZOOM_STEP : 1 / INCOME_FLOW_ZOOM_STEP);
  }, { passive: false });

  svg.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    gesture.pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    svg.setPointerCapture?.(event.pointerId);
    if (gesture.pointers.size >= 2) beginPinch();
    else beginPan(event);
    updateCursor();
  });

  svg.addEventListener('pointermove', (event) => {
    if (!gesture.pointers.has(event.pointerId)) return;
    event.preventDefault();
    gesture.pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (gesture.pointers.size >= 2) updatePinch();
    else updatePan(event);
  });

  const endGesture = (event) => {
    if (!gesture.pointers.has(event.pointerId)) return;
    svg.releasePointerCapture?.(event.pointerId);
    gesture.pointers.delete(event.pointerId);

    if (gesture.mode === 'pinch' && gesture.pointers.size === 1) {
      const [remainingPointer] = gesture.pointers.entries();
      gesture.primaryPointerId = remainingPointer[0];
      gesture.startClientX = remainingPointer[1].clientX;
      gesture.startClientY = remainingPointer[1].clientY;
      gesture.startPanX = view.panX;
      gesture.startPanY = view.panY;
      gesture.mode = 'pan';
      updateCursor();
      return;
    }

    if (gesture.mode === 'pinch' && gesture.pointers.size >= 2) {
      beginPinch();
      updateCursor();
      return;
    }

    if (gesture.pointers.size > 0) return;
    gesture.mode = 'idle';
    gesture.primaryPointerId = null;
    gesture.moved = false;
    updateCursor();
  };

  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', endGesture);
  svg.addEventListener('dblclick', (event) => {
    event.preventDefault();
    resetView();
  });

  container.querySelectorAll?.('[data-income-flow-zoom]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.incomeFlowZoom;
      if (action === 'in') zoomAtCenter(INCOME_FLOW_ZOOM_STEP);
      else if (action === 'out') zoomAtCenter(1 / INCOME_FLOW_ZOOM_STEP);
      else resetView();
    });
  });

  applyTransform();
  if (scrollFrame && !view.didCenterScroll) {
    scrollFrame.scrollLeft = Math.max(0, (scrollFrame.scrollWidth - scrollFrame.clientWidth) / 2);
    view.didCenterScroll = true;
  }
  updateCursor();
}

function clampIncomeFlowView(view) {
  view.zoom = clampValue(view.zoom, INCOME_FLOW_MIN_ZOOM, INCOME_FLOW_MAX_ZOOM);
}

function isIncomeFlowZoomed(view) {
  return Math.abs((Number(view?.zoom) || 1) - 1) > 0.001;
}

function clientPointToIncomeFlowSvg(svg, clientX, clientY) {
  const point = svg.createSVGPoint?.();
  const matrix = svg.getScreenCTM?.();
  if (!point || !matrix) return null;

  point.x = clientX;
  point.y = clientY;
  return point.matrixTransform(matrix.inverse());
}

function getPrimaryIncomeFlowPointers(gesture) {
  return [...gesture.pointers.values()].slice(0, 2);
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

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function renderRanking(state, scores) {
  if (!scores.length) return '';
  const empireFallen = state?.gameOver?.type === 'fall';
  const topScore = scores[0]?.points ?? 0;
  return `
    <ol class="balance-ranking">
      ${scores.map((entry) => {
        const rank = scores.filter((other) => other.points > entry.points).length + 1;
        const isLeader = !empireFallen && entry.points === topScore && topScore > 0;
        const tied = scores.filter((other) => other.points === entry.points).length > 1;
        const breakdown = renderRankingBreakdown(entry);
        return `
          <li class="balance-rank-row ${isLeader ? 'leader' : ''}" style="${getPlayerStyleAttr(state, entry.playerId)}">
            <span class="balance-rank-no" aria-label="rank ${rank}">${rank}${tied && isLeader ? '*' : ''}</span>
            <span class="balance-rank-dot" aria-hidden="true"></span>
            <span class="balance-rank-name">${renderPlayerRoleName(state, entry.player)}</span>
            <span class="balance-rank-breakdown" aria-hidden="${breakdown ? 'false' : 'true'}">${breakdown}</span>
            <span class="balance-rank-points" aria-label="${entry.points} point${entry.points === 1 ? '' : 's'}">${entry.points}</span>
          </li>
        `;
      }).join('')}
    </ol>
  `;
}

function getHeaderBadge(state, scores, winners) {
  if (!scores.length) return '';
  const top = scores[0];
  if (state?.gameOver?.type === 'fall') return 'No winner';
  if (!top || top.points === 0) return 'Tied';
  if (winners.length > 1) return `${winners.length}-way tie - ${top.points} pt${top.points === 1 ? '' : 's'}`;
  return `${renderPlayerRoleName(state, top.player)} <span class="balance-header-points">${top.points} pt${top.points === 1 ? '' : 's'}</span>`;
}

function panelOpen(uiState) {
  const value = uiState?.panels?.balance;
  return value == null ? true : Boolean(value);
}

export function renderBalancePanel(container, state, options = {}) {
  if (!container || !state) return;

  const uiState = options.uiState || null;
  const isOpen = panelOpen(uiState);
  const balance = buildBalanceOfPower(state);
  const incomeFlow = balance.income?.flow || buildIncomeFlow(state);
  const badge = getHeaderBadge(state, balance.scores, balance.winners);
  const usesLiveProjection = state.phase !== 'scoring' && !state.gameOver;
  const hint = balance.empireFallen
    ? 'The empire has fallen. These standings rank the final balance of power, but no dynasty wins.'
    : usesLiveProjection
      ? 'Gold is current; Profit and Office shares project from the board as it stands now.'
      : 'Gold reserves score alongside Profit and combined Office income shares.';

  container.classList.toggle('panel-collapsed', !isOpen);
  container.innerHTML = `
    <div class="balance-panel sidebar-panel${isOpen ? '' : ' is-collapsed'}">
      <button class="sidebar-panel-head" type="button" data-ui-panel-toggle="balance" aria-expanded="${isOpen}">
        <span class="sidebar-panel-head-copy">
          <span class="sidebar-panel-kicker">Standings</span>
          <span class="sidebar-panel-title">Balance of Power</span>
        </span>
        ${badge ? `<span class="sidebar-panel-badge">${badge}</span>` : ''}
      </button>
      ${isOpen ? `
        <div class="sidebar-panel-body">
          <p class="section-hint">${hint}</p>
          ${renderRanking(state, balance.scores)}
          <div class="balance-pie-grid">
            ${balance.categories.map((category) => renderPieCard(state, category)).join('')}
          </div>
          ${renderIncomeFlowDiagram(state, incomeFlow)}
        </div>
      ` : ''}
    </div>
  `;

  if (isOpen) bindIncomeFlowInteractions(container);
}
