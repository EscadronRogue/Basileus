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

const FLOW_ROUTE_DETAIL_KEYS = new Set(['east_pool', 'west_pool', 'sea_pool', 'patriarch']);

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

function renderFlowBar(state, route) {
  const total = Math.max(0, Number(route?.total) || 0);
  if (total <= 0) {
    return '<div class="income-flow-bar is-empty" aria-hidden="true"><span></span></div>';
  }

  const segments = (route.recipients || []).map((entry) => {
    const value = Math.max(0, Number(entry.value) || 0);
    const share = total > 0 ? (value / total) * 100 : 0;
    const name = getFlowRecipientName(state, entry.playerId);
    return `
      <span class="income-flow-segment" style="${getPlayerStyleAttr(state, entry.playerId)} --flow-share:${share.toFixed(3)}%;" title="${escapeHtml(`${name}: ${value}`)}"></span>
    `;
  });

  if (route.unclaimed > 0) {
    const share = total > 0 ? (route.unclaimed / total) * 100 : 0;
    segments.push(`<span class="income-flow-segment unclaimed" style="--flow-share:${share.toFixed(3)}%;" title="Unclaimed: ${route.unclaimed}"></span>`);
  }

  return `<div class="income-flow-bar" aria-hidden="true">${segments.join('')}</div>`;
}

function renderFlowRecipientChips(state, route) {
  const chips = (route.recipients || []).map((entry) => {
    const player = getPlayer(state, entry.playerId);
    const name = formatPlayerLabel(player) || `Player ${Number(entry.playerId) + 1}`;
    return `
      <span class="income-flow-recipient-chip" style="${getPlayerStyleAttr(state, entry.playerId)}" title="${escapeHtml(name)}">
        <span class="income-flow-chip-dot" aria-hidden="true"></span>
        <span class="income-flow-chip-name">${escapeHtml(name)}</span>
        <span class="income-flow-chip-value">${Math.max(0, Math.round(Number(entry.value) || 0))}</span>
      </span>
    `;
  });

  if (route.unclaimed > 0) {
    chips.push(`
      <span class="income-flow-recipient-chip unclaimed" title="Unclaimed">
        <span class="income-flow-chip-dot" aria-hidden="true"></span>
        <span class="income-flow-chip-name">Unclaimed</span>
        <span class="income-flow-chip-value">${Math.max(0, Math.round(Number(route.unclaimed) || 0))}</span>
      </span>
    `);
  }

  return chips.length ? `<div class="income-flow-chip-row">${chips.join('')}</div>` : '';
}

function renderFlowOfficeDetails(state, route) {
  if (!FLOW_ROUTE_DETAIL_KEYS.has(route.key) || !route.offices?.length) return '';
  const rows = route.offices.map((office) => {
    const holderName = office.playerId == null ? 'Vacant' : getFlowRecipientName(state, office.playerId);
    const style = office.playerId == null ? '' : getPlayerStyleAttr(state, office.playerId);
    return `
      <span class="income-flow-office-chip" style="${style}" title="${escapeHtml(holderName)}">
        <span class="income-flow-office-name">${escapeHtml(getOfficeDisplayName(state, office.officeKey))}</span>
        <span class="income-flow-office-value">${Math.max(0, Math.round(Number(office.value) || 0))}</span>
      </span>
    `;
  }).join('');
  return `<div class="income-flow-office-row">${rows}</div>`;
}

function renderFlowRoute(state, route) {
  const total = Math.max(0, Number(route.total) || 0);
  const sourceText = route.sourceCount === 1 ? '1 source' : `${route.sourceCount} sources`;
  return `
    <article class="income-flow-route income-flow-${route.resource}${total <= 0 ? ' is-empty' : ''}">
      <div class="income-flow-route-head">
        <span class="income-flow-route-label">${escapeHtml(route.label)}</span>
        <span class="income-flow-route-rule">${escapeHtml(route.rule || sourceText)}</span>
        <span class="income-flow-route-value">${renderFlowValue(route.resource, total, route.label)}</span>
      </div>
      ${renderFlowBar(state, route)}
      ${renderFlowRecipientChips(state, route)}
      ${renderFlowOfficeDetails(state, route)}
    </article>
  `;
}

function renderFlowSection(state, section) {
  const iconKind = getFlowIconKind(section.key);
  const total = Math.max(0, Number(section.total) || 0);
  return `
    <section class="income-flow-section income-flow-${section.key}">
      <div class="income-flow-source-node">
        <span class="income-flow-source-icon">${renderIcon(iconKind)}</span>
        <span class="income-flow-source-copy">
          <span class="income-flow-source-label">${escapeHtml(FLOW_SOURCE_LABEL[section.key] || section.label)}</span>
          <span class="income-flow-source-value">${renderFlowValue(section.key, total, section.label)}</span>
        </span>
      </div>
      <div class="income-flow-route-stack">
        ${section.routes.map((route) => renderFlowRoute(state, route)).join('')}
      </div>
    </section>
  `;
}

function renderFlowPlayerRows(state, flow) {
  return (flow.playerTotals || []).map((entry) => {
    const player = getPlayer(state, entry.playerId);
    const total = (Number(entry.profit) || 0) + (Number(entry.troop) || 0) + (Number(entry.church) || 0);
    return `
      <article class="income-flow-player${total <= 0 ? ' is-empty' : ''}" style="${getPlayerStyleAttr(state, entry.playerId)}">
        <span class="income-flow-player-dot" aria-hidden="true"></span>
        <span class="income-flow-player-name">${renderPlayerRoleName(state, player)}</span>
        <span class="income-flow-player-values">
          ${renderFlowValue('profit', entry.profit, 'Profit')}
          ${renderFlowValue('troop', entry.troop, 'Troops')}
          ${renderFlowValue('church', entry.church, 'Church')}
        </span>
      </article>
    `;
  }).join('');
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
      <div class="income-flow-board">
        <div class="income-flow-main">
          ${flow.sections.map((section) => renderFlowSection(state, section)).join('')}
        </div>
        <aside class="income-flow-players" aria-label="Dynasty receipts">
          <div class="income-flow-players-title">Dynasties</div>
          ${renderFlowPlayerRows(state, flow)}
        </aside>
      </div>
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
