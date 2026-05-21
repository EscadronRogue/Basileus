// ui/balancePanel.js - Balance of Power sidebar panel.
//
// Renders scoring-category pies together with a live ranking based on the
// official scoring rule: 1 point per 25% share of each player-held category,
// capped at 3 points per category.

import { buildBalanceOfPower, buildPowerFlow } from '../engine/scoring.js';
import { getPlayerStyleAttr, renderPlayerRoleName } from './labels.js';
import { formatPlayerLabel, getPlayer } from '../engine/state.js';
import { renderIcon } from './icons.js';

const CATEGORY_ICON_KIND = {
  gold: 'gold',
  estate: 'estate',
  church: 'church',
  strategos: 'troop',
};

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

// ── Power Flow (Sankey) ─────────────────────────────────────────────────────
// One pool per resource (Profits / Troops / Church). Each pool draws three
// columns: source pool on the left, office channels in the middle, player
// recipients on the right. Ribbons widths are proportional to the amount that
// passes through them, and take the receiving player's dynasty colour so the
// flow reads at a glance.

const FLOW_SVG_WIDTH = 320;
const FLOW_SOURCE_X = 6;
const FLOW_SOURCE_W = 14;
const FLOW_OFFICE_X = 142;
const FLOW_OFFICE_W = 14;
const FLOW_PLAYER_X = 286;
const FLOW_PLAYER_W = 14;
const FLOW_NODE_GAP = 3;
const FLOW_UNIT_TARGET = 9; // pixels per unit (resource value)
const FLOW_MIN_HEIGHT = 60;
const FLOW_MAX_HEIGHT = 140;
const FLOW_VERT_PAD = 4;

function shortPlayerName(player) {
  if (!player) return '?';
  const label = formatPlayerLabel(player) || `Player ${Number(player.id) + 1}`;
  return label.length > 12 ? `${label.slice(0, 11)}…` : label;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function describeRibbon(x1, y1a, y1b, x2, y2a, y2b) {
  const mid = (x1 + x2) / 2;
  return `M ${x1.toFixed(2)} ${y1a.toFixed(2)} `
    + `C ${mid.toFixed(2)} ${y1a.toFixed(2)}, ${mid.toFixed(2)} ${y2a.toFixed(2)}, ${x2.toFixed(2)} ${y2a.toFixed(2)} `
    + `L ${x2.toFixed(2)} ${y2b.toFixed(2)} `
    + `C ${mid.toFixed(2)} ${y2b.toFixed(2)}, ${mid.toFixed(2)} ${y1b.toFixed(2)}, ${x1.toFixed(2)} ${y1b.toFixed(2)} Z`;
}

function getPoolTint(kind) {
  if (kind === 'gold')   return { fill: '#c8921e', stroke: '#7c5416' };
  if (kind === 'troop')  return { fill: '#7a2020', stroke: '#4a1010' };
  if (kind === 'church') return { fill: '#1e3a5f', stroke: '#0f1e34' };
  return { fill: '#5a3810', stroke: '#2e1e0f' };
}

function renderFlowEmpty(pool) {
  return `<div class="power-flow-empty">No ${pool.label.toLowerCase()} flowing this turn.</div>`;
}

function renderFlowSvg(state, pool) {
  // Determine vertical scale so the three columns share a common height.
  const targetH = Math.max(FLOW_MIN_HEIGHT, Math.min(FLOW_MAX_HEIGHT, pool.total * FLOW_UNIT_TARGET));
  const offices = pool.offices.filter((o) => o.total > 0);
  if (!offices.length) return renderFlowEmpty(pool);

  // Aggregate player totals so the player column orders consistently with the
  // ranking (largest first, then by playerId for stability).
  const playerTotals = new Map();
  for (const office of offices) {
    for (const slice of office.slices) {
      playerTotals.set(slice.playerId, (playerTotals.get(slice.playerId) || 0) + slice.amount);
    }
  }
  const playerOrder = Array.from(playerTotals.entries())
    .sort(([aId, aAmt], [bId, bAmt]) => (bAmt - aAmt) || (aId - bId))
    .map(([playerId, amount]) => ({ playerId, amount }));

  // Vacant office capacity (e.g. unclaimed Patriarchate). Tracked so the
  // ribbon can still be drawn into a faded node without a player target.
  const officeVacantAmount = (office) => {
    const claimed = office.slices.reduce((sum, slice) => sum + slice.amount, 0);
    return Math.max(0, office.total - claimed);
  };
  const totalVacant = offices.reduce((sum, office) => sum + officeVacantAmount(office), 0);

  const unitH = targetH / pool.total;
  const sourceH = pool.total * unitH;
  const officeColumnH = offices.reduce((sum, o) => sum + o.total * unitH, 0)
    + (offices.length - 1) * FLOW_NODE_GAP;
  const playerNodeCount = playerOrder.length + (totalVacant > 0 ? 1 : 0);
  const playerColumnH = playerOrder.reduce((sum, p) => sum + p.amount * unitH, 0)
    + totalVacant * unitH
    + Math.max(0, playerNodeCount - 1) * FLOW_NODE_GAP;

  const H = Math.max(sourceH, officeColumnH, playerColumnH) + FLOW_VERT_PAD * 2;
  const sourceY = (H - sourceH) / 2;
  let officeY = (H - officeColumnH) / 2;
  let playerY = (H - playerColumnH) / 2;

  const officeLayout = new Map();
  for (const office of offices) {
    const h = office.total * unitH;
    officeLayout.set(office.key, { y: officeY, h, cursor: officeY });
    officeY += h + FLOW_NODE_GAP;
  }
  const playerLayout = new Map();
  for (const player of playerOrder) {
    const h = player.amount * unitH;
    playerLayout.set(player.playerId, { y: playerY, h, cursor: playerY });
    playerY += h + FLOW_NODE_GAP;
  }
  let vacantLayout = null;
  if (totalVacant > 0) {
    vacantLayout = { y: playerY, h: totalVacant * unitH, cursor: playerY };
  }

  const poolTint = getPoolTint(pool.kind);

  // ── Source → Office ribbons ───────────────────────────────────────────────
  const sourceRibbons = [];
  let sourceCursor = sourceY;
  for (const office of offices) {
    const oMeta = officeLayout.get(office.key);
    const officeH = office.total * unitH;
    // Ribbon colour: tint by the holder's dynasty colour for single-holder
    // offices; for multi-holder groups (Strategoi, Bishops, Landowners) use the
    // pool tint, since the office aggregates many players.
    let ribbonColor = poolTint.fill;
    if (office.slices.length === 1 && office.slices[0].amount === office.total) {
      ribbonColor = getPlayer(state, office.slices[0].playerId)?.color || poolTint.fill;
    } else if (office.vacant) {
      ribbonColor = '#8c6840';
    }
    sourceRibbons.push(
      `<path class="power-flow-ribbon source-ribbon" d="${describeRibbon(
        FLOW_SOURCE_X + FLOW_SOURCE_W, sourceCursor, sourceCursor + officeH,
        FLOW_OFFICE_X, oMeta.y, oMeta.y + officeH,
      )}" fill="${ribbonColor}" fill-opacity="0.32"></path>`,
    );
    sourceCursor += officeH;
  }

  // ── Office → Player ribbons (per slice) ───────────────────────────────────
  const playerRibbons = [];
  const orderIndex = new Map(playerOrder.map(({ playerId }, idx) => [playerId, idx]));
  for (const office of offices) {
    const oMeta = officeLayout.get(office.key);
    // Sort slices by the player column's order so ribbons don't cross unnecessarily.
    const sortedSlices = office.slices.slice().sort((a, b) => (
      (orderIndex.get(a.playerId) ?? 99) - (orderIndex.get(b.playerId) ?? 99)
    ));
    for (const slice of sortedSlices) {
      const pMeta = playerLayout.get(slice.playerId);
      if (!pMeta) continue;
      const h = slice.amount * unitH;
      const oStart = oMeta.cursor;
      const oEnd = oMeta.cursor + h;
      const pStart = pMeta.cursor;
      const pEnd = pMeta.cursor + h;
      oMeta.cursor += h;
      pMeta.cursor += h;
      const playerColor = getPlayer(state, slice.playerId)?.color || '#5a3810';
      const title = `${getPlayer(state, slice.playerId) ? formatPlayerLabel(getPlayer(state, slice.playerId)) : `Player ${Number(slice.playerId) + 1}`}`
        + ` ← ${office.label}: +${slice.amount}`;
      playerRibbons.push(
        `<path class="power-flow-ribbon player-ribbon" d="${describeRibbon(
          FLOW_OFFICE_X + FLOW_OFFICE_W, oStart, oEnd,
          FLOW_PLAYER_X, pStart, pEnd,
        )}" fill="${playerColor}" fill-opacity="0.55"><title>${escapeXml(title)}</title></path>`,
      );
    }
    // Vacant share: this office has capacity that nobody fills (e.g. unclaimed Patriarchate).
    const vacant = officeVacantAmount(office);
    if (vacant > 0 && vacantLayout) {
      const h = vacant * unitH;
      const oStart = oMeta.cursor;
      const oEnd = oMeta.cursor + h;
      const pStart = vacantLayout.cursor;
      const pEnd = vacantLayout.cursor + h;
      oMeta.cursor += h;
      vacantLayout.cursor += h;
      playerRibbons.push(
        `<path class="power-flow-ribbon vacant-ribbon" d="${describeRibbon(
          FLOW_OFFICE_X + FLOW_OFFICE_W, oStart, oEnd,
          FLOW_PLAYER_X, pStart, pEnd,
        )}" fill="#b08050" fill-opacity="0.32"><title>${escapeXml(`Unclaimed: ${vacant}`)}</title></path>`,
      );
    }
  }

  // ── Nodes ────────────────────────────────────────────────────────────────
  const nodes = [];
  // Source node
  nodes.push(
    `<rect class="power-flow-source" x="${FLOW_SOURCE_X}" y="${sourceY.toFixed(2)}" `
    + `width="${FLOW_SOURCE_W}" height="${sourceH.toFixed(2)}" rx="2" `
    + `fill="${poolTint.fill}" stroke="${poolTint.stroke}" stroke-width="0.8"></rect>`,
  );

  // Office nodes
  for (const office of offices) {
    const oMeta = officeLayout.get(office.key);
    let officeFill = poolTint.fill;
    let officeOpacity = '0.78';
    if (office.slices.length === 1 && office.slices[0].amount === office.total) {
      officeFill = getPlayer(state, office.slices[0].playerId)?.color || poolTint.fill;
      officeOpacity = '0.92';
    } else if (office.slices.length > 1) {
      officeFill = poolTint.fill;
      officeOpacity = '0.72';
    } else if (office.vacant) {
      officeFill = '#8c6840';
      officeOpacity = '0.55';
    }
    nodes.push(
      `<rect class="power-flow-office${office.vacant ? ' vacant' : ''}" `
      + `x="${FLOW_OFFICE_X}" y="${oMeta.y.toFixed(2)}" `
      + `width="${FLOW_OFFICE_W}" height="${oMeta.h.toFixed(2)}" rx="2" `
      + `fill="${officeFill}" fill-opacity="${officeOpacity}" stroke="rgba(20,8,0,0.55)" stroke-width="0.6"></rect>`,
    );
    // Office label sits to the left of the office node, right-aligned, in the
    // space between the source column and the office column.
    const labelX = FLOW_OFFICE_X - 4;
    const labelY = oMeta.y + oMeta.h / 2;
    const amountSuffix = office.vacant ? ' (vacant)' : '';
    nodes.push(
      `<text class="power-flow-office-label${office.vacant ? ' vacant' : ''}" `
      + `x="${labelX}" y="${(labelY + 2).toFixed(2)}" text-anchor="end">`
      + `${escapeXml(office.label)} <tspan class="power-flow-amount">${office.total}${amountSuffix}</tspan>`
      + `</text>`,
    );
  }

  // Player nodes
  for (const player of playerOrder) {
    const pMeta = playerLayout.get(player.playerId);
    const playerColor = getPlayer(state, player.playerId)?.color || '#5a3810';
    nodes.push(
      `<rect class="power-flow-player" x="${FLOW_PLAYER_X}" y="${pMeta.y.toFixed(2)}" `
      + `width="${FLOW_PLAYER_W}" height="${pMeta.h.toFixed(2)}" rx="2" `
      + `fill="${playerColor}" stroke="rgba(20,8,0,0.55)" stroke-width="0.6"></rect>`,
    );
    const name = escapeXml(shortPlayerName(getPlayer(state, player.playerId)));
    const labelX = FLOW_PLAYER_X + FLOW_PLAYER_W + 4;
    const labelY = pMeta.y + pMeta.h / 2;
    nodes.push(
      `<text class="power-flow-player-label" x="${labelX}" y="${(labelY + 2).toFixed(2)}">`
      + `${name} <tspan class="power-flow-amount">+${player.amount}</tspan>`
      + `</text>`,
    );
  }
  if (vacantLayout && vacantLayout.h > 0) {
    nodes.push(
      `<rect class="power-flow-player vacant" x="${FLOW_PLAYER_X}" y="${vacantLayout.y.toFixed(2)}" `
      + `width="${FLOW_PLAYER_W}" height="${vacantLayout.h.toFixed(2)}" rx="2" `
      + `fill="#b08050" fill-opacity="0.35" stroke="rgba(20,8,0,0.45)" stroke-width="0.6" `
      + `stroke-dasharray="2 2"></rect>`,
    );
    nodes.push(
      `<text class="power-flow-player-label vacant" x="${FLOW_PLAYER_X + FLOW_PLAYER_W + 4}" `
      + `y="${(vacantLayout.y + vacantLayout.h / 2 + 2).toFixed(2)}">`
      + `Unclaimed <tspan class="power-flow-amount">+${totalVacant}</tspan></text>`,
    );
  }

  return `
    <svg class="power-flow-svg" viewBox="0 0 ${FLOW_SVG_WIDTH} ${H.toFixed(2)}" `
    + `preserveAspectRatio="xMidYMid meet" role="img" `
    + `aria-label="${escapeXml(pool.label)} flow diagram">
      <g class="power-flow-ribbons">${sourceRibbons.join('')}${playerRibbons.join('')}</g>
      <g class="power-flow-nodes">${nodes.join('')}</g>
    </svg>
  `;
}

function renderPowerFlowCard(state, pool) {
  const iconHtml = renderIcon(pool.kind, 'power-flow-icon');
  const body = pool.total > 0 ? renderFlowSvg(state, pool) : renderFlowEmpty(pool);
  return `
    <div class="power-flow-card" title="${escapeXml(pool.description)}">
      <div class="power-flow-head">
        <span class="power-flow-title">${iconHtml}<span>${escapeXml(pool.label)}</span></span>
        <span class="power-flow-total">${pool.total}</span>
      </div>
      ${body}
    </div>
  `;
}

function renderPowerFlow(state) {
  const flow = buildPowerFlow(state);
  return `
    <div class="power-flow-section">
      <div class="power-flow-section-head">
        <span class="power-flow-section-title">Income Flow</span>
        <span class="power-flow-section-legend">Source → Office → Dynasty</span>
      </div>
      <p class="section-hint">How each turn's profits, troops and church income reach the dynasties through the offices that channel them.</p>
      <div class="power-flow-list">
        ${flow.pools.map((pool) => renderPowerFlowCard(state, pool)).join('')}
      </div>
    </div>
  `;
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
          <p class="section-hint">Each 25% share of a category scores 1 point (max 3).</p>
          ${renderRanking(state, balance.scores)}
          <div class="balance-pie-grid">
            ${balance.categories.map((category) => renderPieCard(state, category)).join('')}
          </div>
          ${renderPowerFlow(state)}
        </div>
      ` : ''}
    </div>
  `;
}
