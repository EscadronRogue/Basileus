// ui/panels.js - compact phase panels for the updated ruleset.
import { MAJOR_TITLES } from '../data/titles.js';
import { runIncome, readTroopEntry } from '../engine/cascade.js';
import { getMinimumLandBid, suggestMajorTitleAssignments } from '../engine/actions.js';
import { getMercenaryHireCost, getThemeLandPrice } from '../engine/rules.js';
import { getFreeThemes, getOfficeDisplayName, getOfficeHolder, getPlayer, getPlayerThemes } from '../engine/state.js';
import { formatGold, formatMercenaries, formatProvinceYield, formatTroops } from '../engine/presentation.js';
import {
  getPlayerStyleAttr,
  renderPlayerRoleName,
  renderPlayerRoleNameById,
  renderProvinceBadge,
  renderProvinceBadgeList,
  renderThemeOfficeBadge,
  renderTitleBadge,
} from './labels.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getDraftBucket(uiState, state, scope, playerId) {
  if (!uiState) return {};
  if (!uiState.drafts) uiState.drafts = {};
  const key = `${scope}:${state.round}:${playerId}`;
  if (!uiState.drafts[key]) uiState.drafts[key] = {};
  return uiState.drafts[key];
}

function getPlayerOptions(state, selectedId = '') {
  return state.players.map((player) => `
    <option value="${player.id}" ${Number(selectedId) === player.id ? 'selected' : ''}>${escapeHtml(player.firstName ? `${player.firstName} ${player.dynasty}` : player.dynasty)}</option>
  `).join('');
}

function actionUsed(state, playerId) {
  return Boolean(state.courtActions?.actionUsed?.[playerId]);
}

function roleKeysForCourt(state, playerId) {
  const player = getPlayer(state, playerId);
  return [
    playerId === state.basileusId ? 'BASILEUS' : null,
    ...(player?.majorTitles || []),
  ].filter(Boolean);
}

function regionTitleFor(theme) {
  return { east: 'DOM_EAST', west: 'DOM_WEST', sea: 'ADMIRAL' }[theme?.region] || null;
}

function getStrategosTargets(state, playerId) {
  const roles = new Set(roleKeysForCourt(state, playerId));
  return Object.values(state.themes || {}).filter((theme) => (
    theme.id !== 'CPL'
    && !theme.occupied
    && theme.owner !== 'church'
    && theme.strategos == null
    && roles.has(regionTitleFor(theme))
  ));
}

function getBishopTargets(state, playerId) {
  const roles = new Set(roleKeysForCourt(state, playerId));
  if (!roles.has('PATRIARCH')) return [];
  return Object.values(state.themes || {}).filter((theme) => (
    theme.id !== 'CPL'
    && theme.bishop == null
    && (Number(theme.origin?.C) || 0) >= 1
  ));
}

function getGiftTargets(state, playerId) {
  return getPlayerThemes(state, playerId).filter((theme) => (
    !theme.occupied && (Number(theme.origin?.C) || 0) >= 1
  ));
}

function getRevocationTargets(state, playerId) {
  const roles = new Set(roleKeysForCourt(state, playerId));
  const targets = [];
  for (const theme of Object.values(state.themes || {})) {
    if (theme.id === 'CPL') continue;
    if (theme.strategos != null && roles.has(regionTitleFor(theme))) {
      targets.push({ value: `minor:${theme.id}:strategos`, label: `Strategos of ${theme.name}` });
    }
    if (theme.bishop != null && roles.has('PATRIARCH')) {
      targets.push({ value: `minor:${theme.id}:bishop`, label: `Bishop of ${theme.name}` });
    }
    if (playerId === state.basileusId && theme.owner != null && !theme.occupied) {
      targets.push({ value: `theme:${theme.id}`, label: `${theme.owner === 'church' ? 'Church land' : 'Estate'} in ${theme.name}` });
    }
  }
  if (playerId === state.basileusId && state.empress != null) targets.push({ value: 'court:EMPRESS', label: 'Empress' });
  if (playerId === state.basileusId && state.chiefEunuchs != null) targets.push({ value: 'court:CHIEF_EUNUCHS', label: 'Chief of Eunuchs' });
  return targets;
}

function bindSelectAction(container, selector, callback) {
  container.querySelector(selector)?.addEventListener('click', () => callback?.());
}

export function renderTitleRedistributionPanel(container, state, playerId, callbacks = {}, options = {}) {
  const assignments = options.assignments || suggestMajorTitleAssignments(state, state.basileusId);
  container.innerHTML = `
    <section class="phase-card title-redistribution-panel">
      <h3>Redistribute Major Titles</h3>
      <div class="section-list">
        ${Object.entries(MAJOR_TITLES).map(([titleKey, title]) => `
          <label class="form-row">
            <span>${escapeHtml(title.name)}</span>
            <select data-title-assignment="${titleKey}" ${playerId === state.basileusId ? '' : 'disabled'}>
              ${state.players
                .filter((player) => player.id !== state.basileusId)
                .map((player) => `<option value="${player.id}" ${Number(assignments[titleKey]) === player.id ? 'selected' : ''}>${escapeHtml(player.firstName ? `${player.firstName} ${player.dynasty}` : player.dynasty)}</option>`)
                .join('')}
            </select>
          </label>
        `).join('')}
      </div>
      <p class="form-error" data-role="title-reassignment-error"></p>
      <div class="panel-actions">
        <button type="button" class="btn-primary" data-action="confirm-title-redistribution" ${playerId === state.basileusId ? '' : 'disabled'}>Confirm Titles</button>
      </div>
    </section>
  `;
  bindSelectAction(container, '[data-action="confirm-title-redistribution"]', () => {
    const payload = Object.fromEntries(
      Array.from(container.querySelectorAll('[data-title-assignment]')).map((select) => [select.dataset.titleAssignment, Number(select.value)]),
    );
    callbacks.confirmTitleRedistribution?.(payload);
  });
}

export function renderHistoryPanel(container, state, options = {}) {
  if (!container || !state) return;
  const isOpen = options.uiState?.panels?.history ?? false;
  container.classList?.toggle?.('panel-collapsed', !isOpen);
  const history = Array.isArray(state.history) ? state.history.slice(-30).reverse() : [];
  container.innerHTML = `
    <div class="sidebar-panel${isOpen ? '' : ' is-collapsed'}">
      <button class="sidebar-panel-head" type="button" data-ui-panel-toggle="history" aria-expanded="${isOpen}">
        <span class="sidebar-panel-head-copy">
          <span class="sidebar-panel-kicker">Chronicle</span>
          <span class="sidebar-panel-title">History</span>
        </span>
      </button>
      ${isOpen ? `
        <div class="sidebar-panel-body history-list">
          ${history.length ? history.map((entry) => `
            <article class="history-entry">
              <span class="history-meta">R${entry.round} ${escapeHtml(entry.phase)}</span>
              <strong>${escapeHtml(entry.summary)}</strong>
            </article>
          `).join('') : '<div class="panel-empty">No history yet.</div>'}
        </div>
      ` : ''}
    </div>
  `;
}

export function renderPlayerDashboard(container, state, playerId, selectedProvinceId = null) {
  if (!container || !state) return;
  const player = getPlayer(state, playerId);
  const selected = selectedProvinceId ? state.themes[selectedProvinceId] : null;
  const titles = [
    playerId === state.basileusId ? renderTitleBadge(state, 'BASILEUS', { holderId: playerId, compact: true }) : '',
    ...(player?.majorTitles || []).map((titleKey) => renderTitleBadge(state, titleKey, { holderId: playerId, compact: true })),
  ].filter(Boolean).join(' ');
  container.innerHTML = `
    <div class="sidebar-panel dashboard-panel">
      <button class="sidebar-panel-head" type="button" data-ui-panel-toggle="dashboard">
        <span class="sidebar-panel-head-copy">
          <span class="sidebar-panel-kicker">Dynasty</span>
          <span class="sidebar-panel-title">${player ? renderPlayerRoleName(state, player) : 'No dynasty'}</span>
        </span>
      </button>
      <div class="sidebar-panel-body">
        <div class="dashboard-stat-row">
          <span>Gold</span><strong>${formatGold(player?.gold || 0)}</strong>
        </div>
        <div class="dashboard-token-row">${titles || '<span class="muted">No major office</span>'}</div>
        ${selected ? `
          <div class="selected-province">
            ${renderProvinceBadge(state, selected, { showValues: true })}
            <span>${escapeHtml(formatProvinceYield(selected))}</span>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderCourtAppointments(state, playerId, draft) {
  const strategoi = getStrategosTargets(state, playerId);
  const bishops = getBishopTargets(state, playerId);
  const courtTargets = playerId === state.basileusId
    ? [
      state.empress == null ? { titleType: 'EMPRESS', label: 'Empress' } : null,
      state.chiefEunuchs == null ? { titleType: 'CHIEF_EUNUCHS', label: 'Chief of Eunuchs' } : null,
    ].filter(Boolean)
    : [];
  if (!strategoi.length && !bishops.length && !courtTargets.length) return '';
  return `
    <details class="action-fold" open>
      <summary>Appoint</summary>
      ${courtTargets.length ? `
        <div class="form-grid">
          <select data-appoint-court-title>${courtTargets.map((entry) => `<option value="${entry.titleType}">${entry.label}</option>`).join('')}</select>
          <select data-appoint-court-player>${getPlayerOptions(state, draft.appointeeId)}</select>
          <button type="button" class="btn-primary" data-action="appoint-court">Appoint</button>
        </div>
      ` : ''}
      ${strategoi.length ? `
        <div class="form-grid">
          <select data-appoint-strategos-theme>${strategoi.map((theme) => `<option value="${theme.id}">${escapeHtml(theme.name)}</option>`).join('')}</select>
          <select data-appoint-strategos-player>${getPlayerOptions(state, draft.appointeeId)}</select>
          <button type="button" class="btn-primary" data-action="appoint-strategos">Appoint Strategos</button>
        </div>
      ` : ''}
      ${bishops.length ? `
        <div class="form-grid">
          <select data-appoint-bishop-theme>${bishops.map((theme) => `<option value="${theme.id}">${escapeHtml(theme.name)}</option>`).join('')}</select>
          <select data-appoint-bishop-player>${getPlayerOptions(state, draft.appointeeId)}</select>
          <button type="button" class="btn-primary" data-action="appoint-bishop">Appoint Bishop</button>
        </div>
      ` : ''}
    </details>
  `;
}

function renderCourtRevocations(state, playerId) {
  const targets = getRevocationTargets(state, playerId);
  if (!targets.length) return '';
  return `
    <details class="action-fold">
      <summary>Revoke</summary>
      <div class="form-grid">
        <select data-revoke-target>${targets.map((entry) => `<option value="${entry.value}">${escapeHtml(entry.label)}</option>`).join('')}</select>
        <button type="button" class="btn-danger" data-action="revoke">Revoke</button>
      </div>
    </details>
  `;
}

function renderCourtGifts(state, playerId) {
  const targets = getGiftTargets(state, playerId);
  if (!targets.length) return '';
  return `
    <details class="action-fold">
      <summary>Gift Land</summary>
      <div class="form-grid">
        <select data-gift-theme>${targets.map((theme) => `<option value="${theme.id}">${escapeHtml(theme.name)}</option>`).join('')}</select>
        <button type="button" class="btn-primary" data-action="gift">Gift</button>
      </div>
    </details>
  `;
}

export function renderCourtPanel(container, state, activePlayerId, callbacks = {}, options = {}) {
  if (!container || !state) return;
  const player = getPlayer(state, activePlayerId);
  const draft = getDraftBucket(options.uiState, state, 'court', activePlayerId);
  const used = actionUsed(state, activePlayerId);
  container.innerHTML = `
    <section class="phase-card court-panel">
      <h3>${player ? renderPlayerRoleName(state, player) : 'Court'}</h3>
      <div class="dashboard-token-row">${roleKeysForCourt(state, activePlayerId).map((role) => renderTitleBadge(state, role, { holderId: activePlayerId, compact: true })).join(' ')}</div>
      ${used ? '<div class="panel-empty">Court action recorded.</div>' : `
        ${renderCourtAppointments(state, activePlayerId, draft)}
        ${renderCourtRevocations(state, activePlayerId)}
        ${renderCourtGifts(state, activePlayerId)}
        <div class="panel-actions">
          <button type="button" class="btn-secondary" data-action="skip">Skip Action</button>
        </div>
      `}
      <div class="panel-actions">
        <button type="button" class="btn-primary" data-action="confirm-court">Confirm Court</button>
      </div>
    </section>
  `;
  bindSelectAction(container, '[data-action="appoint-court"]', () => {
    callbacks['appoint-court']?.(
      container.querySelector('[data-appoint-court-title]')?.value,
      Number(container.querySelector('[data-appoint-court-player]')?.value),
    );
  });
  bindSelectAction(container, '[data-action="appoint-strategos"]', () => {
    const themeId = container.querySelector('[data-appoint-strategos-theme]')?.value;
    callbacks['appoint-strategos']?.(
      regionTitleFor(state.themes[themeId]),
      themeId,
      Number(container.querySelector('[data-appoint-strategos-player]')?.value),
    );
  });
  bindSelectAction(container, '[data-action="appoint-bishop"]', () => {
    callbacks['appoint-bishop']?.(
      container.querySelector('[data-appoint-bishop-theme]')?.value,
      Number(container.querySelector('[data-appoint-bishop-player]')?.value),
    );
  });
  bindSelectAction(container, '[data-action="revoke"]', () => callbacks.revoke?.(container.querySelector('[data-revoke-target]')?.value));
  bindSelectAction(container, '[data-action="gift"]', () => callbacks.gift?.(container.querySelector('[data-gift-theme]')?.value));
  bindSelectAction(container, '[data-action="skip"]', () => callbacks.skip?.());
  bindSelectAction(container, '[data-action="confirm-court"]', () => callbacks['confirm-court']?.());
}

export function renderEstatesPanel(container, state, playerId, callbacks = {}) {
  const freeThemes = getFreeThemes(state);
  container.innerHTML = `
    <section class="phase-card estates-panel">
      <h3>Estates</h3>
      <div class="estate-grid">
        ${freeThemes.map((theme) => {
          const minimum = getMinimumLandBid(state, theme.id);
          return `
            <article class="estate-card">
              ${renderProvinceBadge(state, theme, { showValues: true })}
              <span>${formatGold(getThemeLandPrice(theme))} value</span>
              <input type="number" min="${minimum}" value="${minimum}" data-estate-bid="${theme.id}">
              <button type="button" class="btn-secondary" data-action="bid-estate" data-theme="${theme.id}">Bid</button>
            </article>
          `;
        }).join('')}
      </div>
      <div class="panel-actions">
        <button type="button" class="btn-primary" data-action="confirm-estates">Open Deployment</button>
      </div>
    </section>
  `;
  container.querySelectorAll('[data-action="bid-estate"]').forEach((button) => {
    button.addEventListener('click', () => {
      const themeId = button.dataset.theme;
      callbacks.buy?.(themeId, { amount: Number(container.querySelector(`[data-estate-bid="${themeId}"]`)?.value) });
    });
  });
  bindSelectAction(container, '[data-action="confirm-estates"]', () => callbacks.confirmEstates?.());
}

function getPlayerArmyKeys(state, playerId) {
  return Object.keys(state.currentTroops || {})
    .filter((officeKey) => getOfficeHolder(state, officeKey) === playerId)
    .sort((left, right) => left.localeCompare(right));
}

export function renderOrdersPanel(container, state, playerId, callbacks = {}, options = {}) {
  if (!container || !state) return;
  const draft = getDraftBucket(options.uiState, state, 'deployment', playerId);
  if (!draft.armies) draft.armies = {};
  if (!draft.mercenaries) draft.mercenaries = { count: 0, destination: 'frontier' };
  const alreadyLocked = state.allOrders?.[playerId] != null;
  const armyKeys = getPlayerArmyKeys(state, playerId);
  container.innerHTML = `
    <section class="phase-card orders-panel">
      <h3>Deployment</h3>
      ${alreadyLocked ? '<div class="panel-empty">Deployment orders locked.</div>' : `
        <div class="army-card-stack">
          ${armyKeys.map((officeKey) => {
            const entry = readTroopEntry(state.currentTroops?.[officeKey]);
            const max = entry.normal + entry.capitalLocked;
            const current = draft.armies[officeKey] || { funded: max, destination: 'frontier' };
            draft.armies[officeKey] = current;
            return `
              <article class="army-card" data-army-card="${officeKey}">
                <header><strong>${escapeHtml(getOfficeDisplayName(state, officeKey))}</strong><span>${formatTroops(max)}</span></header>
                ${entry.capitalLocked ? `<p class="section-hint">${formatTroops(entry.capitalLocked)} capital locked.</p>` : ''}
                <label>Funding <input type="range" min="0" max="${max}" value="${current.funded}" data-army-funded="${officeKey}"><span data-funded-readout="${officeKey}">${current.funded}</span></label>
                <div class="segmented-control">
                  <button type="button" class="${current.destination === 'frontier' ? 'active' : ''}" data-army-destination="${officeKey}" data-destination="frontier">Frontier</button>
                  <button type="button" class="${current.destination === 'capital' ? 'active' : ''}" data-army-destination="${officeKey}" data-destination="capital">Capital</button>
                </div>
              </article>
            `;
          }).join('')}
          <article class="army-card mercenary-card">
            <header><strong>Mercenaries</strong><span>${formatMercenaries(draft.mercenaries.count || 0)}</span></header>
            <label>Recruit <input type="range" min="0" max="10" value="${draft.mercenaries.count || 0}" data-mercenary-count><span data-mercenary-cost>${formatGold(getMercenaryHireCost(0, draft.mercenaries.count || 0))}</span></label>
            <div class="segmented-control">
              <button type="button" class="${draft.mercenaries.destination !== 'capital' ? 'active' : ''}" data-mercenary-destination="frontier">Frontier</button>
              <button type="button" class="${draft.mercenaries.destination === 'capital' ? 'active' : ''}" data-mercenary-destination="capital">Capital</button>
            </div>
          </article>
        </div>
        <div class="form-grid">
          <label>Claimant <select data-order-candidate>${getPlayerOptions(state, draft.candidate ?? state.basileusId)}</select></label>
        </div>
        <div class="panel-actions">
          <button type="button" class="btn-primary" data-action="lock-orders">Lock Deployment</button>
        </div>
      `}
    </section>
  `;
  container.querySelectorAll('[data-army-funded]').forEach((input) => {
    input.addEventListener('input', () => {
      const officeKey = input.dataset.armyFunded;
      if (!draft.armies[officeKey]) draft.armies[officeKey] = { funded: 0, destination: 'frontier' };
      draft.armies[officeKey].funded = Number(input.value) || 0;
      const readout = container.querySelector(`[data-funded-readout="${officeKey}"]`);
      if (readout) readout.textContent = input.value;
    });
  });
  container.querySelectorAll('[data-army-destination]').forEach((button) => {
    button.addEventListener('click', () => {
      const officeKey = button.dataset.armyDestination;
      if (!draft.armies[officeKey]) draft.armies[officeKey] = { funded: 0, destination: 'frontier' };
      draft.armies[officeKey].destination = button.dataset.destination;
      renderOrdersPanel(container, state, playerId, callbacks, options);
    });
  });
  container.querySelector('[data-mercenary-count]')?.addEventListener('input', (event) => {
    draft.mercenaries.count = Number(event.target.value) || 0;
    const cost = container.querySelector('[data-mercenary-cost]');
    if (cost) cost.textContent = formatGold(getMercenaryHireCost(0, draft.mercenaries.count));
  });
  container.querySelectorAll('[data-mercenary-destination]').forEach((button) => {
    button.addEventListener('click', () => {
      draft.mercenaries.destination = button.dataset.mercenaryDestination;
      renderOrdersPanel(container, state, playerId, callbacks, options);
    });
  });
  bindSelectAction(container, '[data-action="lock-orders"]', () => {
    callbacks.lockOrders?.({
      armies: draft.armies,
      mercenaries: draft.mercenaries,
      candidate: Number(container.querySelector('[data-order-candidate]')?.value),
    });
  });
}

export function renderResolutionPanel(container, state, options = {}) {
  return renderResolutionPanelDetailed(container, state, options);
}

export function renderResolutionPanelDetailed(container, state, options = {}) {
  if (!container || !state) return;
  const rewards = Array.isArray(state.pendingDefenderRewards) ? state.pendingDefenderRewards.filter((reward) => !reward.resolved) : [];
  container.innerHTML = `
    <section class="phase-card resolution-panel">
      <h3>Resolution</h3>
      ${state.lastCoupResult ? `
        <article class="result-card">
          <strong>Coup</strong>
          <span>${renderPlayerRoleNameById(state, state.lastCoupResult.winner)} ${state.lastCoupResult.winner === state.basileusId ? 'holds the throne' : 'claims the throne'}.</span>
        </article>
      ` : ''}
      ${state.lastWarResult ? `
        <article class="result-card">
          <strong>War</strong>
          <span>${escapeHtml(state.lastWarResult.outcome)} against ${escapeHtml(state.currentInvasion?.name || 'the invader')}.</span>
          ${state.lastWarResult.themesLost?.length ? `<span>Lost: ${renderProvinceBadgeList(state, state.lastWarResult.themesLost)}</span>` : ''}
          ${state.lastWarResult.themesRecovered?.length ? `<span>Recovered: ${renderProvinceBadgeList(state, state.lastWarResult.themesRecovered)}</span>` : ''}
        </article>
      ` : ''}
      ${rewards.length ? `
        <div class="reward-list">
          ${rewards.map((reward) => `
            <article class="reward-card">
              <strong>${escapeHtml(reward.themeName || reward.themeId)}</strong>
              <span>${renderPlayerRoleNameById(state, reward.defenderId)} may restore it or take ${formatGold(reward.goldValue || 0)}.</span>
              <button type="button" data-defender-reward-choice data-reward-id="${reward.id}" data-choice="empire">Restore</button>
              <button type="button" data-defender-reward-choice data-reward-id="${reward.id}" data-choice="gold">Take Gold</button>
            </article>
          `).join('')}
        </div>
      ` : ''}
      <div class="panel-actions">
        <button type="button" class="btn-primary" data-action="continue">Continue</button>
      </div>
    </section>
  `;
}
