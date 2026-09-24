// ui/panels/dashboard.js - the active dynasty's dashboard card.

import { readTroopCount, runIncome } from '../../engine/cascade.js';
import {
  getOfficeDisplayName,
  getOfficeHolder,
  getPlayer,
  getPlayerPrimaryRoleKey,
} from '../../engine/state.js';
import { formatGoldHtml, formatTroopsHtml, renderIcon } from '../icons.js';
import { escapeHtml } from '../html.js';
import { getPlayerStyleAttr, renderOwnershipBadge, renderProvinceBadge, renderTitleBadge } from '../labels.js';
import { countDynastyEstates, getDynastyEstates } from '../../engine/estates.js';
import { playerInitial } from './shared.js';

function getDashboardEconomy(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return { reserve: 0, income: 0, estates: 0, troops: 0 };
  let income = 0;
  let troops = 0;
  try {
    const admin = runIncome(state);
    income = Number(admin?.income?.[playerId]) || 0;
  } catch (err) {
    income = 0;
  }
  const estates = countDynastyEstates(state, playerId);
  for (const officeKey of Object.keys(state.currentTroops || {})) {
    if (getOfficeHolder(state, officeKey) !== playerId) continue;
    troops += readTroopCount(state.currentTroops[officeKey]);
  }
  return {
    reserve: Math.max(0, Number(player.gold) || 0),
    income,
    estates,
    troops,
  };
}

function getPlayerPrimaryRoleLabel(state, playerId) {
  const roleKey = getPlayerPrimaryRoleKey(state, playerId);
  if (!roleKey) return '';
  return getOfficeDisplayName(state, roleKey);
}

function getDashboardHoldings(state, playerId) {
  const themes = Object.values(state?.themes || {}).filter((theme) => theme?.id !== 'CPL');
  return {
    // Holdings in lost provinces are listed too, drawn as switched off.
    estate: getDynastyEstates(state, playerId).map((entry) => ({ theme: state.themes[entry.themeId], count: entry.count })),
    strategos: themes.filter((theme) => theme.strategos === playerId).map((theme) => ({ theme })),
    bishop: themes.filter((theme) => theme.bishop === playerId).map((theme) => ({ theme })),
  };
}

function renderHoldingEntry(state, entry) {
  const badge = renderProvinceBadge(state, entry.theme, { compact: true });
  if (!entry.count) return badge;
  return `<span class="dashboard-estate-entry${entry.theme.lost ? ' disabled' : ''}">${badge}<span class="dashboard-estate-count">×${entry.count}</span></span>`;
}

function renderDashboardHoldingRow(state, playerId, kind, entries) {
  if (!entries.length) return '';
  const player = getPlayer(state, playerId);
  const label = renderOwnershipBadge(state, {
    kind,
    holderId: playerId,
    color: player?.color || '#5a3810',
    accent: 'rgba(20,8,0,0.76)',
  }, {
    compact: true,
    hideHolder: true,
    label: kind === 'estate' ? `Estates ×${countDynastyEstates(state, playerId)}` : undefined,
  });
  return `
    <div class="dashboard-holding-row dashboard-holding-${kind}">
      <span class="dashboard-holding-kind">${label}</span>
      <span class="dashboard-holding-list">
        ${entries.map((entry) => renderHoldingEntry(state, entry)).join(' ')}
      </span>
    </div>
  `;
}

function renderDashboardHoldings(state, playerId) {
  const holdings = getDashboardHoldings(state, playerId);
  const rows = [
    renderDashboardHoldingRow(state, playerId, 'estate', holdings.estate),
    renderDashboardHoldingRow(state, playerId, 'strategos', holdings.strategos),
    renderDashboardHoldingRow(state, playerId, 'bishop', holdings.bishop),
  ].filter(Boolean);
  if (!rows.length) return '';
  return `<div class="dashboard-holdings">${rows.join('')}</div>`;
}

export function renderPlayerDashboard(container, state, playerId, selectedProvinceId = null, options = {}) {
  if (!container || !state) return;
  void selectedProvinceId;
  const player = getPlayer(state, playerId);
  const isOpen = options.uiState?.panels?.dashboard ?? true;
  const titles = [
    playerId === state.basileusId ? renderTitleBadge(state, 'BASILEUS', { holderId: playerId, compact: true }) : '',
    ...(player?.majorTitles || []).map((titleKey) => renderTitleBadge(state, titleKey, { holderId: playerId, compact: true })),
  ].filter(Boolean).join(' ');
  const economy = player ? getDashboardEconomy(state, playerId) : null;
  const roleLabel = player ? getPlayerPrimaryRoleLabel(state, playerId) : '';
  const crestLetter = player ? playerInitial(player) : '?';
  const dynastyName = player ? escapeHtml(player.dynasty || 'Dynasty') : 'No dynasty';

  container.classList?.toggle?.('panel-collapsed', !isOpen);
  container.innerHTML = `
    <div class="player-dashboard sidebar-panel${isOpen ? '' : ' is-collapsed'}" style="${player ? getPlayerStyleAttr(state, player.id) : ''}">
      <button class="sidebar-panel-head dashboard-cartouche-head" type="button" data-ui-panel-toggle="dashboard" aria-expanded="${isOpen}">
        <span class="dashboard-cartouche" role="presentation">
          <span class="dc-crest" aria-hidden="true">${crestLetter}</span>
          <span class="dc-identity">
            <span class="dc-name">${dynastyName}</span>
            <span class="dc-role${roleLabel ? '' : ' muted'}">${roleLabel || 'No major office'}</span>
          </span>
          ${economy ? `
            <span class="dc-finance">
              <span class="dc-reserve">${formatGoldHtml(economy.reserve)}</span>
              <span class="dc-delta">
                ${formatGoldHtml(economy.income, { signed: true, tone: economy.income < 0 ? 'upkeep' : 'income' })}
                ${formatTroopsHtml(economy.troops)}
              </span>
            </span>
          ` : ''}
        </span>
      </button>
      ${isOpen ? `
      <div class="sidebar-panel-body">
        ${economy ? `
          <div class="finance-grid" aria-label="Next-round projection">
            <div class="finance-card">
              <span class="finance-label">${renderIcon('gold')}Gold</span>
              <span class="finance-value">${formatGoldHtml(economy.reserve)}</span>
            </div>
            <div class="finance-card ${economy.income < 0 ? 'upkeep' : 'income'}">
              <span class="finance-label">${renderIcon('gold')}Next Income</span>
              <span class="finance-value">${formatGoldHtml(economy.income, { signed: true })}</span>
            </div>
            <div class="finance-card">
              <span class="finance-label">${renderIcon('troop')}Troops</span>
              <span class="finance-value">${formatTroopsHtml(economy.troops)}</span>
            </div>
            <div class="finance-card">
              <span class="finance-label">${renderIcon('estate')}Estates</span>
              <span class="finance-value">${escapeHtml(String(economy.estates))}</span>
            </div>
          </div>
        ` : ''}
        <div class="dashboard-token-row">${titles || '<span class="muted">No major office</span>'}</div>
        ${renderDashboardHoldings(state, playerId)}
      </div>
      ` : ''}
    </div>
  `;
}
