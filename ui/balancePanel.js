// ui/balancePanel.js - Balance of Power sidebar panel.
//
// Renders scoring-category pies together with a live ranking based on the
// official scoring rule: 1 point per 25% share of each player-held category,
// capped at 3 points per category.

import { buildBalanceOfPower } from '../engine/scoring.js';
import { buildIncomeFlow } from '../engine/cascade.js';
import { getPlayerStyleAttr, renderPlayerRoleName, renderTitleBadge } from './labels.js';
import { formatPlayerLabel, getOfficeDisplayName, getOfficeHolder, getPlayer } from '../engine/state.js';
import { renderIcon } from './icons.js';
import { REGION_BORDER_COLORS, REGIONS } from '../data/provinces.js';

const CATEGORY_ICON_KIND = {
  gold: 'gold',
  estate: 'estate',
  church: 'church',
  strategos: 'troop',
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

const SANKEY_WIDTH = 900;
const SANKEY_HEIGHT = 620;
const SANKEY_SIDE_PAD = 24;
const SANKEY_GAP = 18;
const SANKEY_COLUMNS = {
  source: 24,
  route: 150,
  office: 325,
  player: 505,
};
const SANKEY_NODE_WIDTHS = {
  source: 100,
  route: 112,
  office: 138,
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
const SANKEY_CASCADE_ROUTE_KEYS = new Set(['east_pool', 'west_pool', 'sea_pool', 'patriarch']);
const SANKEY_OFFICE_ORDER = ['DOM_EAST', 'BASILEUS', 'DOM_WEST', 'ADMIRAL', 'PATRIARCH'];

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
    return `<path d="${describeSlicePath(start, end, radius)}" fill="${color}" stroke="rgba(20,8,0,0.45)" stroke-width="0.6"><title>${title}</title></path>`;
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
        <span class="balance-legend-name">${name}</span>
        <span class="balance-legend-share">${formatShare(slice.share)}</span>
        <span class="balance-legend-points" title="Each 25% of this category scores 1 point (max 3).">${slice.points}</span>
      </div>
    `;
  }).join('');

  return `<div class="balance-pie-legend">${rows}</div>`;
}

function renderPieCard(state, category) {
  const iconKind = CATEGORY_ICON_KIND[category.key];
  const iconHtml = iconKind ? renderIcon(iconKind, 'balance-pie-icon') : '';
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

  const order = ['gold', 'estate', 'church', 'strategos'];
  const parts = [];
  for (const key of order) {
    const cat = entry.categories.find((c) => c.key === key);
    if (!cat) continue;
    const iconKind = CATEGORY_ICON_KIND[key] || key;
    const value = Math.max(0, Math.round(Number(cat.value) || 0));
    parts.push(renderValueChip(iconKind, value, cat.label));
  }
  return parts.join('');
}

function renderValueChip(iconKind, value, label) {
  const title = label ? ` title="${label}"` : '';
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

function getOrderedSankeyNodes(nodes, layer) {
  const list = [...nodes.values()].filter((node) => node.layer === layer);
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
    node.y = SANKEY_COLUMNS[node.layer];
    x += node.width + gap;
  }
}

function layoutIncomeSankey(nodes, links) {
  for (const link of links) {
    link.source = nodes.get(link.sourceKey);
    link.target = nodes.get(link.targetKey);
  }

  const sourceNodes = getOrderedSankeyNodes(nodes, 'source');
  const routeNodes = getOrderedSankeyNodes(nodes, 'route');
  const officeNodes = getOrderedSankeyNodes(nodes, 'office');
  const playerNodes = getOrderedSankeyNodes(nodes, 'player');
  const columns = [sourceNodes, routeNodes, officeNodes, playerNodes];
  const maxNodeValue = Math.max(...[...nodes.values()].map((node) => Math.max(0, Number(node.value) || 0)), 1);
  const scale = Math.max(3.2, Math.min(8, 96 / maxNodeValue));

  for (const link of links) {
    link.width = Math.max(4, link.value * scale);
    link.source.linksOut.push(link);
    link.target.linksIn.push(link);
  }

  for (const node of nodes.values()) {
    const outWidth = node.linksOut.reduce((sum, link) => sum + link.width, 0);
    const inWidth = node.linksIn.reduce((sum, link) => sum + link.width, 0);
    node.height = getNodeMinHeight(node);
    node.width = Math.max(getNodeWidth(node), outWidth + 18, inWidth + 18);
  }

  columns.forEach(layoutSankeyRow);

  for (const node of nodes.values()) {
    const outgoing = node.linksOut.slice().sort((left, right) => (left.target.x - right.target.x) || (left.target.y - right.target.y));
    const incoming = node.linksIn.slice().sort((left, right) => (left.source.x - right.source.x) || (left.source.y - right.source.y));
    let outCursor = (node.width - outgoing.reduce((sum, link) => sum + link.width, 0)) / 2;
    for (const link of outgoing) {
      link.sx = node.x + outCursor + link.width / 2;
      link.sy = node.y + node.height;
      outCursor += link.width;
    }
    let inCursor = (node.width - incoming.reduce((sum, link) => sum + link.width, 0)) / 2;
    for (const link of incoming) {
      link.tx = node.x + inCursor + link.width / 2;
      link.ty = node.y;
      inCursor += link.width;
    }
  }

  return {
    nodes: [...nodes.values()],
    links,
  };
}

function getSankeyLinkGeometry(link) {
  const sourceY = link.sy;
  const targetY = link.ty;
  const curve = Math.max(44, (targetY - sourceY) * 0.48);
  return {
    x0: link.sx,
    y0: sourceY,
    x1: link.sx,
    y1: sourceY + curve,
    x2: link.tx,
    y2: targetY - curve,
    x3: link.tx,
    y3: targetY,
  };
}

function describeSankeyLinkPath(link) {
  const p = getSankeyLinkGeometry(link);
  return `M ${p.x0.toFixed(2)} ${p.y0.toFixed(2)} C ${p.x1.toFixed(2)} ${p.y1.toFixed(2)}, ${p.x2.toFixed(2)} ${p.y2.toFixed(2)}, ${p.x3.toFixed(2)} ${p.y3.toFixed(2)}`;
}

function getBezierPoint(p, t) {
  const mt = 1 - t;
  return {
    x: (mt ** 3) * p.x0 + 3 * (mt ** 2) * t * p.x1 + 3 * mt * (t ** 2) * p.x2 + (t ** 3) * p.x3,
    y: (mt ** 3) * p.y0 + 3 * (mt ** 2) * t * p.y1 + 3 * mt * (t ** 2) * p.y2 + (t ** 3) * p.y3,
  };
}

function getLinkLabelT(link) {
  if (link.source.layer === 'source') return 0.42;
  if (link.target.layer === 'player') return 0.58;
  return 0.5;
}

function renderSankeyLink(link) {
  const path = describeSankeyLinkPath(link);
  const title = `${link.label}: ${roundFlowValue(link.value)}`;
  return `<path class="income-sankey-link income-sankey-${link.resource}" d="${path}" stroke="${link.color}" stroke-width="${link.width.toFixed(2)}"><title>${escapeHtml(title)}</title></path>`;
}

function renderSankeyIconValue(resource, value, x, y, width = 72, extraClass = '', height = 24) {
  return `
    <foreignObject class="income-sankey-foreign" x="${x}" y="${y}" width="${width}" height="${height}">
      <div xmlns="http://www.w3.org/1999/xhtml" class="income-sankey-icon-value income-sankey-icon-${resource}${extraClass ? ` ${extraClass}` : ''}">
        ${renderFlowValue(resource, value)}
      </div>
    </foreignObject>
  `;
}

function renderSankeyLinkLabel(link) {
  const point = getBezierPoint(getSankeyLinkGeometry(link), getLinkLabelT(link));
  const width = 64;
  const height = 28;
  return renderSankeyIconValue(
    link.resource,
    link.value,
    (point.x - width / 2).toFixed(2),
    (point.y - height / 2).toFixed(2),
    width,
    'income-sankey-band-value',
    height,
  );
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
  return renderTitleBadge(state, officeKey, {
    holderId,
    compact: true,
    label: node.label,
  });
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
    return renderSankeyOfficeCartouche(state, node) || renderSankeyGenericCartouche(node, escapeHtml(node.label));
  }

  if (node.layer === 'player') {
    if (!node.isUnclaimed) return renderSankeyPlayerCartouche(state, flow, node);
    return renderSankeyGenericCartouche(
      node,
      `<span class="income-sankey-unclaimed">${escapeHtml(node.label)} ${renderFlowValue(node.resource, node.value)}</span>`,
    );
  }

  return renderSankeyGenericCartouche(node, escapeHtml(node.label));
}

function renderSankeyNode(state, flow, node) {
  const classes = [
    'income-sankey-node',
    `income-sankey-node-${node.layer}`,
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
  const linkLabels = model.links
    .slice()
    .sort((left, right) => (left.width - right.width) || left.sourceKey.localeCompare(right.sourceKey))
    .map(renderSankeyLinkLabel)
    .join('');
  const nodes = model.nodes.map((node) => renderSankeyNode(state, flow, node)).join('');

  return `
    <svg class="income-flow-sankey" viewBox="0 0 ${SANKEY_WIDTH} ${SANKEY_HEIGHT}" role="img" aria-label="Imperial income Sankey diagram">
      <g class="income-sankey-links">${links}</g>
      <g class="income-sankey-link-labels">${linkLabels}</g>
      <g class="income-sankey-nodes">${nodes}</g>
    </svg>
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
      ${renderIncomeSankeySvg(state, flow)}
    </section>
  `;
}

function renderRanking(state, scores) {
  if (!scores.length) return '';
  const topScore = scores[0]?.points ?? 0;
  return `
    <ol class="balance-ranking">
      ${scores.map((entry) => {
        const rank = scores.filter((other) => other.points > entry.points).length + 1;
        const isLeader = entry.points === topScore && topScore > 0;
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
  const incomeFlow = buildIncomeFlow(state);
  const badge = getHeaderBadge(state, balance.scores, balance.winners);

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
          <p class="section-hint">Each 25% share of a category scores 1 point (max 3).</p>
          ${renderRanking(state, balance.scores)}
          <div class="balance-pie-grid">
            ${balance.categories.map((category) => renderPieCard(state, category)).join('')}
          </div>
          ${renderIncomeFlowDiagram(state, incomeFlow)}
        </div>
      ` : ''}
    </div>
  `;
}
