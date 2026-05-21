// ui/balancePanel.js - Balance of Power sidebar panel.
//
// Renders scoring-category pies together with a live ranking based on the
// official scoring rule: 1 point per 25% share of each player-held category,
// capped at 3 points per category.

import { buildBalanceOfPower } from '../engine/scoring.js';
import { buildIncomeFlow } from '../engine/cascade.js';
import { getPlayerStyleAttr, renderPlayerRoleName } from './labels.js';
import { formatPlayerLabel, getOfficeDisplayName, getPlayer } from '../engine/state.js';
import { renderIcon } from './icons.js';

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
const SANKEY_HEIGHT = 470;
const SANKEY_NODE_WIDTH = 16;
const SANKEY_TOP = 30;
const SANKEY_BOTTOM = 30;
const SANKEY_GAP = 16;
const SANKEY_COLUMNS = {
  source: 20,
  route: 220,
  office: 470,
  player: 705,
};
const SANKEY_RESOURCE_COLORS = {
  profit: '#c8921e',
  troop: '#6b4a28',
  church: '#2e5490',
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

function truncateSvgLabel(value, maxLength = 18) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function getResourceColor(resource) {
  return SANKEY_RESOURCE_COLORS[resource] || '#8c6840';
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

function formatPlayerFlowReceipt(flow, playerId) {
  const total = getPlayerFlowTotal(flow, playerId);
  return `P${total.profit} T${total.troop} C${total.church}`;
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

function addSankeyLink(nodes, links, sourceKey, targetKey, value, resource, label) {
  const amount = Math.max(0, Number(value) || 0);
  if (amount <= 0 || !nodes.has(sourceKey) || !nodes.has(targetKey)) return;
  const link = {
    sourceKey,
    targetKey,
    value: amount,
    resource,
    label,
    color: getResourceColor(resource),
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
      createSankeyNode(nodes, routeKey, {
        layer: 'route',
        label: route.label,
        rule: route.rule,
        resource: route.resource,
        value: route.total,
        fill: getResourceColor(route.resource),
        stroke: 'rgba(20,8,0,0.42)',
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
      );

      if (SANKEY_CASCADE_ROUTE_KEYS.has(route.key)) {
        for (const office of route.offices || []) {
          const officeKey = `office:${office.officeKey}`;
          const holderColor = office.playerId == null ? getResourceColor(route.resource) : getPlayerColor(state, office.playerId);
          createSankeyNode(nodes, officeKey, {
            layer: 'office',
            label: getOfficeDisplayName(state, office.officeKey),
            resource: route.resource,
            addValue: office.value,
            fill: holderColor,
            stroke: getResourceColor(route.resource),
            playerId: office.playerId,
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
          );

          const terminalKey = `${officeKey}:${office.playerId ?? 'unclaimed'}:${route.resource}`;
          const terminal = officeTerminals.get(terminalKey) || {
            sourceKey: officeKey,
            playerId: office.playerId,
            resource: route.resource,
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
          );
        }
      }

      if (route.unclaimed > 0) {
        const unclaimed = ensureUnclaimedNode(nodes, route.resource);
        unclaimed.value += route.unclaimed;
        addSankeyLink(nodes, links, routeKey, unclaimed.key, route.unclaimed, route.resource, `${route.label} unclaimed`);
      }
    }
  }

  for (const terminal of officeTerminals.values()) {
    if (terminal.playerId == null) {
      const unclaimed = ensureUnclaimedNode(nodes, terminal.resource);
      unclaimed.value += terminal.value;
      addSankeyLink(nodes, links, terminal.sourceKey, unclaimed.key, terminal.value, terminal.resource, `${terminal.label} unclaimed`);
    } else {
      addSankeyLink(
        nodes,
        links,
        terminal.sourceKey,
        `player:${terminal.playerId}`,
        terminal.value,
        terminal.resource,
        `${terminal.label} to ${getFlowRecipientName(state, terminal.playerId)}`,
      );
    }
  }

  return layoutIncomeSankey(nodes, links);
}

function getNodeMinHeight(node) {
  if (node.layer === 'source') return 42;
  if (node.layer === 'player') return 38;
  if (node.layer === 'route') return 28;
  return 26;
}

function getOrderedSankeyNodes(nodes, layer) {
  const list = [...nodes.values()].filter((node) => node.layer === layer);
  return list.sort((left, right) => {
    const leftOrder = left.order < 0 ? 999 : left.order;
    const rightOrder = right.order < 0 ? 999 : right.order;
    return (leftOrder - rightOrder) || left.label.localeCompare(right.label);
  });
}

function layoutSankeyColumn(list) {
  if (!list.length) return;
  const availableHeight = SANKEY_HEIGHT - SANKEY_TOP - SANKEY_BOTTOM;
  const totalHeight = list.reduce((sum, node) => sum + node.height, 0);
  const preferredGapTotal = Math.max(0, list.length - 1) * SANKEY_GAP;
  const gap = list.length > 1
    ? Math.max(8, Math.min(SANKEY_GAP, (availableHeight - totalHeight) / (list.length - 1)))
    : 0;
  const usedHeight = totalHeight + Math.max(0, list.length - 1) * gap;
  let y = SANKEY_TOP + Math.max(0, (availableHeight - usedHeight) / 2);
  for (const node of list) {
    node.x = SANKEY_COLUMNS[node.layer];
    node.y = y;
    y += node.height + gap;
  }
  void preferredGapTotal;
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
  const maxNodeCount = Math.max(...columns.map((column) => column.length), 1);
  const availableHeight = SANKEY_HEIGHT - SANKEY_TOP - SANKEY_BOTTOM - Math.max(0, maxNodeCount - 1) * SANKEY_GAP;
  const maxColumnValue = Math.max(
    ...columns.map((column) => column.reduce((sum, node) => sum + Math.max(0, Number(node.value) || 0), 0)),
    1,
  );
  const scale = Math.max(2.4, Math.min(7.2, availableHeight / maxColumnValue));

  for (const link of links) {
    link.width = Math.max(2.5, link.value * scale);
    link.source.linksOut.push(link);
    link.target.linksIn.push(link);
  }

  for (const node of nodes.values()) {
    const outWidth = node.linksOut.reduce((sum, link) => sum + link.width, 0);
    const inWidth = node.linksIn.reduce((sum, link) => sum + link.width, 0);
    node.height = Math.max(getNodeMinHeight(node), node.value * scale, outWidth, inWidth);
  }

  columns.forEach(layoutSankeyColumn);

  for (const node of nodes.values()) {
    const outgoing = node.linksOut.slice().sort((left, right) => (left.target.y - right.target.y) || (left.target.x - right.target.x));
    const incoming = node.linksIn.slice().sort((left, right) => (left.source.y - right.source.y) || (left.source.x - right.source.x));
    let outCursor = (node.height - outgoing.reduce((sum, link) => sum + link.width, 0)) / 2;
    for (const link of outgoing) {
      link.sy = node.y + outCursor + link.width / 2;
      outCursor += link.width;
    }
    let inCursor = (node.height - incoming.reduce((sum, link) => sum + link.width, 0)) / 2;
    for (const link of incoming) {
      link.ty = node.y + inCursor + link.width / 2;
      inCursor += link.width;
    }
  }

  return {
    nodes: [...nodes.values()],
    links,
  };
}

function renderSankeyLink(link) {
  const sourceX = link.source.x + SANKEY_NODE_WIDTH;
  const targetX = link.target.x;
  const curve = Math.max(60, (targetX - sourceX) * 0.54);
  const path = `M ${sourceX.toFixed(2)} ${link.sy.toFixed(2)} C ${(sourceX + curve).toFixed(2)} ${link.sy.toFixed(2)}, ${(targetX - curve).toFixed(2)} ${link.ty.toFixed(2)}, ${targetX.toFixed(2)} ${link.ty.toFixed(2)}`;
  const title = `${link.label}: ${roundFlowValue(link.value)}`;
  return `<path class="income-sankey-link income-sankey-${link.resource}" d="${path}" stroke="${link.color}" stroke-width="${link.width.toFixed(2)}"><title>${escapeHtml(title)}</title></path>`;
}

function renderSankeyNodeText(node, flow) {
  const labelX = node.x + SANKEY_NODE_WIDTH + 8;
  const midY = node.y + node.height / 2;
  let label = node.label;
  let meta = `${roundFlowValue(node.value)}`;
  let maxLabel = 19;

  if (node.layer === 'source') {
    meta = `${roundFlowValue(node.value)} ${node.resource === 'troop' ? 'troops' : node.resource}`;
  } else if (node.layer === 'route') {
    meta = node.rule || `${roundFlowValue(node.value)}`;
    maxLabel = 18;
  } else if (node.layer === 'office') {
    meta = `${roundFlowValue(node.value)}`;
    maxLabel = 18;
  } else if (node.layer === 'player') {
    meta = node.isUnclaimed ? `${roundFlowValue(node.value)} unclaimed` : formatPlayerFlowReceipt(flow, node.playerId);
    maxLabel = 21;
  }

  label = truncateSvgLabel(label, maxLabel);
  const hasRoomForMeta = node.height >= 24;
  const labelY = hasRoomForMeta ? midY - 3 : midY + 4;
  const metaY = midY + 10;

  return `
    <text class="income-sankey-node-label" x="${labelX}" y="${labelY.toFixed(2)}">${escapeHtml(label)}</text>
    ${hasRoomForMeta ? `<text class="income-sankey-node-meta" x="${labelX}" y="${metaY.toFixed(2)}">${escapeHtml(meta)}</text>` : ''}
  `;
}

function renderSankeyNode(node, flow) {
  const classes = [
    'income-sankey-node',
    `income-sankey-node-${node.layer}`,
    node.resource ? `income-sankey-node-${node.resource}` : '',
    node.isUnclaimed ? 'is-unclaimed' : '',
  ].filter(Boolean).join(' ');
  return `
    <g class="${classes}">
      <rect x="${node.x}" y="${node.y.toFixed(2)}" width="${SANKEY_NODE_WIDTH}" height="${node.height.toFixed(2)}" rx="2.4" fill="${node.fill}" stroke="${node.stroke}">
        <title>${escapeHtml(`${node.label}: ${roundFlowValue(node.value)}`)}</title>
      </rect>
      ${renderSankeyNodeText(node, flow)}
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
  const nodes = model.nodes.map((node) => renderSankeyNode(node, flow)).join('');

  return `
    <svg class="income-flow-sankey" viewBox="0 0 ${SANKEY_WIDTH} ${SANKEY_HEIGHT}" role="img" aria-label="Imperial income Sankey diagram">
      <g class="income-sankey-links">${links}</g>
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
