// ui/balancePanel.js — Balance of Power sidebar panel.
//
// Renders the scoring-category pies (Estate, Church, Gold) together
// with a live ranking based on the official scoring rule (1 point per 25%
// share of the player-only pool, capped at 3 per category). The pies show a
// "free citizens" slice in any category where value isn't yet held by a
// dynasty, so players can see how much of each pool is still up for grabs.

import { buildBalanceOfPower } from '../engine/scoring.js';
import { getPlayerStyleAttr, renderPlayerRoleName } from './labels.js';
import { formatPlayerLabel, getPlayer } from '../engine/state.js';
import { renderIcon } from './icons.js';

const CATEGORY_ICON_KIND = {
  church: 'church',
  estate: 'gold',
  gold: 'gold',
};

const FREE_CITIZENS_COLOR = '#6a4a8a';
const FREE_CITIZENS_LABEL = 'Free citizens';

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
  if (slice.kind === 'free') return FREE_CITIZENS_COLOR;
  return getPlayer(state, slice.playerId)?.color || '#5a3810';
}

function getSliceLabel(state, slice) {
  if (slice.kind === 'free') return FREE_CITIZENS_LABEL;
  return formatPlayerLabel(getPlayer(state, slice.playerId)) || `Player ${Number(slice.playerId) + 1}`;
}

function renderPieSvg(state, category) {
  const radius = 42;
  const viewBox = `-50 -50 100 100`;

  if (category.total <= 0) {
    return `
      <svg class="balance-pie-svg" viewBox="${viewBox}" role="img" aria-label="${category.label} — no value yet">
        <circle r="${radius}" cx="0" cy="0" fill="rgba(168,116,32,0.10)" stroke="rgba(168,116,32,0.25)" stroke-width="1"></circle>
        <text x="0" y="4" text-anchor="middle" class="balance-pie-empty">—</text>
      </svg>
    `;
  }

  let cursor = 0;
  const paths = category.slices.filter((slice) => slice.share > 0).map((slice) => {
    const start = cursor;
    cursor += slice.share;
    const end = Math.min(cursor, 1);
    const color = getSliceColor(state, slice);
    const title = `${getSliceLabel(state, slice)} — ${formatShare(slice.share)}${slice.kind === 'player' ? ` (${slice.points} pt${slice.points === 1 ? '' : 's'})` : ''}`;
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
    return '<div class="balance-pie-legend-empty">No value generated yet.</div>';
  }

  const rows = category.slices.map((slice) => {
    if (slice.kind === 'free') {
      return `
        <div class="balance-legend-row free">
          <span class="balance-legend-dot" style="background:${FREE_CITIZENS_COLOR}"></span>
          <span class="balance-legend-name">${FREE_CITIZENS_LABEL}</span>
          <span class="balance-legend-share">${formatShare(slice.share)}</span>
        </div>
      `;
    }
    const player = getPlayer(state, slice.playerId);
    const name = formatPlayerLabel(player) || `Player ${Number(slice.playerId) + 1}`;
    return `
      <div class="balance-legend-row" style="${getPlayerStyleAttr(state, slice.playerId)}">
        <span class="balance-legend-dot" style="background:var(--player-color)"></span>
        <span class="balance-legend-name">${name}</span>
        <span class="balance-legend-share">${formatShare(slice.share)}</span>
        <span class="balance-legend-points" title="Each 25% of the player-only pool scores 1 point (max 3).">${slice.points}</span>
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

function renderRanking(state, scores) {
  if (!scores.length) return '';
  const topScore = scores[0]?.points ?? 0;
  return `
    <ol class="balance-ranking">
      ${scores.map((entry, index) => {
        const rank = scores.filter((other) => other.points > entry.points).length + 1;
        const isLeader = entry.points === topScore && topScore > 0;
        const tied = scores.filter((other) => other.points === entry.points).length > 1;
        return `
          <li class="balance-rank-row ${isLeader ? 'leader' : ''}" style="${getPlayerStyleAttr(state, entry.playerId)}">
            <span class="balance-rank-no">${rank}${tied && isLeader ? '*' : ''}</span>
            <span class="balance-rank-name">${renderPlayerRoleName(state, entry.player)}</span>
            <span class="balance-rank-points">${entry.points} pt${entry.points === 1 ? '' : 's'}</span>
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
  if (winners.length > 1) return `${winners.length}-way tie · ${top.points} pt${top.points === 1 ? '' : 's'}`;
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
          <p class="section-hint">Each 25% share of a category scores 1 point (max 3). Free citizens are shown for context only; estate bids convert their slice into yours.</p>
          ${renderRanking(state, balance.scores)}
          <div class="balance-pie-grid">
            ${balance.categories.map((category) => renderPieCard(state, category)).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}
