import { buildFinalScores } from '../engine/scoring.js';
import { drawInvasionRoute, setSelectedProvince, updateMapState } from '../render/mapRenderer.js';
import { readTroopEntry, runIncome } from '../engine/cascade.js';
import { getOfficeHolder, getPlayer } from '../engine/state.js';
import { formatGoldHtml, formatTroopsHtml } from '../engine/presentation.js';
import {
  renderCourtPanel,
  renderEstatesPanel,
  renderHistoryPanel,
  renderOrdersPanel,
  renderPlayerDashboard,
  renderResolutionPanelDetailed,
  renderTitleRedistributionPanel,
} from './panels.js';
import { renderBalancePanel } from './balancePanel.js';
import { getPlayerStyleAttr, renderPlayerRoleName, renderProvinceBadge, renderTitleBadge } from './labels.js';
import { renderIcon } from './icons.js';

export function createDefaultUiState() {
  return {
    panels: {
      dashboard: true,
      balance: false,
      notifications: false,
      history: false,
      action: true,
    },
    sections: {},
    dashboardFocus: null,
    drafts: {},
    actionError: '',
    notifications: {
      read: {},
      dismissedToasts: {},
    },
  };
}

export function getPhaseRenderKey(state) {
  if (!state) return 'none';
  const gameOverType = state.gameOver?.type || '';
  return `${state.round}:${state.phase}:${gameOverType}`;
}

export function scrollPhasePanelIntoView() {
  if (typeof document === 'undefined') return;
  const schedule = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (callback) => setTimeout(callback, 0);
  schedule(() => {
    const sidebar = document.getElementById('sidebar');
    const actionPanel = document.getElementById('actionPanel');
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 980px)').matches) {
      actionPanel?.scrollIntoView({ block: 'start' });
      return;
    }
    if (sidebar) sidebar.scrollTop = 0;
  });
}

export function isPanelOpen(uiState, panelKey, fallback = true) {
  const value = uiState?.panels?.[panelKey];
  return value == null ? fallback : Boolean(value);
}

export function setPanelOpen(uiState, panelKey, open) {
  if (!uiState.panels) uiState.panels = {};
  uiState.panels[panelKey] = Boolean(open);
}

export function bindUiChrome({ uiState, render }) {
  const containers = [
    document.getElementById('playerDashboard'),
    document.getElementById('balancePanel'),
    document.getElementById('notificationPanel'),
    document.getElementById('historyPanel'),
    document.getElementById('actionPanel'),
  ].filter(Boolean);

  for (const container of containers) {
    container.querySelectorAll('[data-ui-panel-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const panelKey = button.dataset.uiPanelToggle;
        const nextOpen = !isPanelOpen(uiState, panelKey, true);
        setPanelOpen(uiState, panelKey, nextOpen);
        if (panelKey === 'notifications' && nextOpen) {
          markRenderedNotificationsRead(uiState, container);
        }
        render();
      });
    });

    container.querySelectorAll('details[data-section-key]').forEach((section) => {
      section.addEventListener('toggle', () => {
        if (!uiState.sections) uiState.sections = {};
        uiState.sections[section.dataset.sectionKey] = section.open;
      });
    });

    container.querySelectorAll('[data-dashboard-focus]').forEach((button) => {
      button.addEventListener('click', () => {
        const focusKey = button.dataset.dashboardFocus;
        uiState.dashboardFocus = focusKey;
        if (!uiState.sections) uiState.sections = {};
        uiState.sections[`dashboard:${focusKey}`] = true;
        render();
      });
    });

    container.querySelectorAll('[data-notification-read]').forEach((button) => {
      button.addEventListener('click', () => {
        markNotificationRead(uiState, button.dataset.notificationScope, button.dataset.notificationRead);
        render();
      });
    });

    container.querySelectorAll('[data-notification-dismiss]').forEach((button) => {
      button.addEventListener('click', () => {
        markNotificationDismissed(uiState, button.dataset.notificationScope, button.dataset.notificationDismiss);
        render();
      });
    });
  }
}

function ensureNotificationUi(uiState) {
  if (!uiState.notifications) uiState.notifications = {};
  if (!uiState.notifications.read) uiState.notifications.read = {};
  if (!uiState.notifications.dismissedToasts) uiState.notifications.dismissedToasts = {};
  return uiState.notifications;
}

function notificationKey(scopeKey, id) {
  return `${scopeKey || 'default'}:${id}`;
}

function isNotificationRead(uiState, scopeKey, id) {
  return Boolean(ensureNotificationUi(uiState).read[notificationKey(scopeKey, id)]);
}

function isNotificationDismissed(uiState, scopeKey, id) {
  return Boolean(ensureNotificationUi(uiState).dismissedToasts[notificationKey(scopeKey, id)]);
}

function markNotificationRead(uiState, scopeKey, id) {
  if (!id) return;
  ensureNotificationUi(uiState).read[notificationKey(scopeKey, id)] = true;
}

function markNotificationDismissed(uiState, scopeKey, id) {
  if (!id) return;
  const key = notificationKey(scopeKey, id);
  const notificationUi = ensureNotificationUi(uiState);
  notificationUi.dismissedToasts[key] = true;
  notificationUi.read[key] = true;
}

function markRenderedNotificationsRead(uiState, container) {
  container.querySelectorAll('[data-notification-id]').forEach((entry) => {
    markNotificationRead(uiState, entry.dataset.notificationScope, entry.dataset.notificationId);
  });
}

export const PHASE_NAMES = {
  setup: 'Setup',
  invasion: 'Invasion',
  title_redistribution: 'Title Redistribution',
  income: 'Income',
  court: 'Court',
  estates: 'Estates',
  deployment: 'Deployment',
  resolution: 'Resolution',
  cleanup: 'Cleanup',
  scoring: 'Final Scoring',
};

export const PHASE_TOOLTIPS = {
  setup: 'Provinces, titles and starting gold are dealt out.',
  invasion: 'A new invasion is drawn. Its route shows which provinces are at risk.',
  title_redistribution: 'The Basileus confirms or redistributes the major titles.',
  income: 'Provinces pay out gold and raise troops automatically.',
  court: 'Each player takes one appointment, revocation, church gift, or skip action.',
  estates: 'Dynasties bid for private land.',
  deployment: 'Each player funds armies, hires mercenaries, chooses destinations, and backs a claimant.',
  resolution: 'Coup is decided first by Capital troops, then the war by Frontier troops vs invader strength.',
  cleanup: 'Per-turn state clears before the next invasion.',
  scoring: 'Each 25% share of church income, estate income, and gold reserves scores 1 point, up to 3 per category.',
};

export const ACTION_PANEL_TITLE_BY_PHASE = {
  title_redistribution: 'Redistribute Major Titles',
  court: 'Imperial Court',
  estates: 'Estates',
  deployment: 'Deployment',
  resolution: 'Resolution',
  scoring: 'Final Reckoning',
};

export const ACTION_PANEL_SUBTITLE_BY_PHASE = {
  title_redistribution: '',
  court: '',
  estates: '',
  deployment: '',
  resolution: '',
  scoring: '',
};

function getActionPanelTitle(state) {
  if (state?.gameOver || state?.phase === 'scoring') return 'Final Reckoning';
  return ACTION_PANEL_TITLE_BY_PHASE[state?.phase] || 'Action Panel';
}

export function renderTopBar(state) {
  if (!state) return;
  const roundEl = document.getElementById('roundDisplay');
  const phaseEl = document.getElementById('phaseDisplay');
  const invasionEl = document.getElementById('invasionDisplay');

  if (roundEl) {
    roundEl.textContent = `Round ${state.round} / ${state.maxRounds}`;
    roundEl.title = `Game ends after ${state.maxRounds} invasions, or sooner if Constantinople falls. Each 25% category share scores 1 point, up to 3; highest total wins.`;
  }
  if (phaseEl) {
    if (state.gameOver?.type === 'fall') {
      phaseEl.textContent = 'Empire Fallen';
      phaseEl.className = 'phase-badge phase-empire-fallen';
      phaseEl.title = 'Constantinople has fallen. The game ends.';
    } else {
      phaseEl.textContent = PHASE_NAMES[state.phase] || state.phase;
      phaseEl.className = `phase-badge phase-${state.phase}`;
      phaseEl.title = PHASE_TOOLTIPS[state.phase] || '';
    }
  }

  renderEmpireFallenBanner(state);

  if (invasionEl) {
    invasionEl.textContent = '';
    invasionEl.style.display = 'none';
  }
}

export function renderEmpireFallenBanner(state) {
  const topBar = document.getElementById('topBar');
  if (!topBar) return;
  let banner = document.getElementById('empireFallenBanner');

  if (state?.gameOver?.type !== 'fall') {
    banner?.remove();
    return;
  }

  if (!banner) {
    banner = document.createElement('span');
    banner.id = 'empireFallenBanner';
    banner.className = 'empire-fallen-banner';
    const invasionEl = document.getElementById('invasionDisplay');
    topBar.insertBefore(banner, invasionEl || null);
  }

  banner.innerHTML = '<strong>Empire Fallen</strong><span>Constantinople has been sacked. The game ends now; the highest-scoring dynasty wins.</span>';
}

export function getPlayerTabEconomy(player, administration, state = null) {
  const income = administration?.income?.[player.id] || 0;
  const troops = Object.keys(state?.currentTroops || {}).reduce((total, officeKey) => {
    if (getOfficeHolder(state, officeKey) !== player.id) return total;
    const entry = readTroopEntry(state.currentTroops?.[officeKey]);
    return total + entry.normal + entry.capitalLocked;
  }, 0);
  return {
    reserve: Number(player.gold) || 0,
    income: Number(income) || 0,
    troops,
  };
}

export function renderPlayerTabFinance(economy) {
  const incomeTone = Number(economy.income) < 0 ? 'upkeep' : 'income';
  return `
    <span class="tab-finance" aria-label="Reserve, income, and troops" title="Gold reserve, next income, and office troops">
      ${formatGoldHtml(economy.reserve, { displayValue: economy.reserve })}
      ${formatGoldHtml(economy.income, { signed: true, tone: incomeTone, displayValue: economy.income })}
      ${formatTroopsHtml(economy.troops, { displayValue: economy.troops })}
    </span>
  `;
}

export function renderPlayerTabs({ state, activePlayerId, onSelectPlayer, getBadges = null }) {
  const tabBar = document.getElementById('playerTabBar');
  if (!tabBar || !state) return;

  const administration = runIncome(state);

  tabBar.innerHTML = state.players.map((player) => {
    const economy = getPlayerTabEconomy(player, administration, state);
    const badges = typeof getBadges === 'function' ? getBadges(player) : [];
    const badgeHtml = badges.filter(Boolean).join('');
    const basileusBadge = player.id === state.basileusId
      ? renderTitleBadge(state, 'BASILEUS', { holderId: player.id, compact: true })
      : '';
    return `
      <button class="player-tab ${player.id === activePlayerId ? 'active' : ''}"
        data-player="${player.id}" style="${getPlayerStyleAttr(state, player.id)}">
        <span class="tab-body">
          <span class="tab-name">${player.dynasty}</span>
          ${renderPlayerTabFinance(economy)}
        </span>
        <span class="tab-flags">${badgeHtml}${basileusBadge}</span>
      </button>
    `;
  }).join('');

  tabBar.querySelectorAll('.player-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      onSelectPlayer?.(Number.parseInt(tab.dataset.player || '0', 10));
    });
  });
}

export function renderActionShell(panel, state, uiState) {
  if (!panel || !state) return null;
  const isOpen = isPanelOpen(uiState, 'action', true);
  panel.classList.toggle('panel-collapsed', !isOpen);
  panel.innerHTML = `
    <div class="sidebar-panel action-shell${isOpen ? '' : ' is-collapsed'}">
      <button class="sidebar-panel-head" type="button" data-ui-panel-toggle="action" aria-expanded="${isOpen}">
        <span class="sidebar-panel-head-copy">
          <span class="sidebar-panel-kicker">Phase Panel</span>
          <span class="sidebar-panel-title">${getActionPanelTitle(state)}</span>
          ${ACTION_PANEL_SUBTITLE_BY_PHASE[state.phase] ? `<span class="sidebar-panel-subtitle">${ACTION_PANEL_SUBTITLE_BY_PHASE[state.phase]}</span>` : ''}
        </span>
      </button>
      ${isOpen ? '<div class="sidebar-panel-body" data-role="action-panel-body"></div>' : ''}
    </div>
  `;
  return isOpen ? panel.querySelector('[data-role="action-panel-body"]') : null;
}

function renderSelectedProvinceCue(state, selectedProvinceId) {
  const selected = selectedProvinceId ? state?.themes?.[selectedProvinceId] : null;
  if (!selected) return '';
  return `
    <div class="selected-province-cue" aria-live="polite">
      <span class="selected-province-cue-label">Selected</span>
      ${renderProvinceBadge(state, selected, { showValues: true })}
    </div>
  `;
}

function getNotificationActionLabel(action) {
  return {
    open_deals: 'Deals',
    open_orders: 'Deployment',
    open_deployment: 'Deployment',
    open_history: 'History',
    open_resolution: 'Resolution',
    open_title_redistribution: 'Titles',
  }[action] || 'Notice';
}

function renderNotificationCard(notification, uiState, scopeKey) {
  const read = isNotificationRead(uiState, scopeKey, notification.id);
  return `
    <div class="notification-card${notification.urgent ? ' urgent' : ''}${read ? ' read' : ''}"
      data-notification-id="${notification.id}"
      data-notification-scope="${scopeKey}">
      <div class="notification-card-main">
        <div class="notification-title">${notification.title}</div>
        <div class="notification-body">${notification.body || ''}</div>
      </div>
      <div class="notification-meta">
        <span>${getNotificationActionLabel(notification.action)}</span>
        ${read ? '' : `<button type="button" class="btn-secondary notification-read-btn" data-notification-scope="${scopeKey}" data-notification-read="${notification.id}">Mark read</button>`}
      </div>
    </div>
  `;
}

function renderNotificationToasts(notifications, uiState, scopeKey) {
  const toasts = notifications
    .filter((notification) => notification.urgent)
    .filter((notification) => !isNotificationRead(uiState, scopeKey, notification.id))
    .filter((notification) => !isNotificationDismissed(uiState, scopeKey, notification.id))
    .slice(0, 3);
  if (!toasts.length) return '';
  return `
    <div class="notification-toast-rail" aria-live="polite">
      ${toasts.map((notification) => `
        <div class="notification-toast" data-notification-id="${notification.id}" data-notification-scope="${scopeKey}">
          <div>
            <strong>${notification.title}</strong>
            <span>${notification.body || ''}</span>
          </div>
          <button type="button" aria-label="Dismiss notification" data-notification-scope="${scopeKey}" data-notification-dismiss="${notification.id}">&times;</button>
        </div>
      `).join('')}
    </div>
  `;
}

export function renderNotificationsPanel(panel, state, privateData, uiState, scopeKey = 'default') {
  if (!panel || !state) return;
  const notifications = Array.isArray(privateData?.notifications) ? privateData.notifications : [];
  const unreadCount = notifications.filter((entry) => !isNotificationRead(uiState, scopeKey, entry.id)).length;
  const urgentUnreadCount = notifications.filter((entry) => entry.urgent && !isNotificationRead(uiState, scopeKey, entry.id)).length;
  const isOpen = isPanelOpen(uiState, 'notifications', true);
  panel.classList.toggle('panel-collapsed', !isOpen);
  const badge = urgentUnreadCount > 0
    ? `${urgentUnreadCount} urgent`
    : unreadCount > 0
      ? `${unreadCount} new`
      : `${notifications.length} notices`;

  panel.innerHTML = `
    <div class="notification-panel sidebar-panel${isOpen ? '' : ' is-collapsed'}">
      <button class="sidebar-panel-head" type="button" data-ui-panel-toggle="notifications" aria-expanded="${isOpen}">
        <span class="sidebar-panel-head-copy">
          <span class="sidebar-panel-kicker">Private Inbox</span>
          <span class="sidebar-panel-title">Notifications</span>
        </span>
        <span class="sidebar-panel-badge${urgentUnreadCount > 0 ? ' urgent' : ''}">${badge}</span>
      </button>
      ${isOpen ? `
        <div class="sidebar-panel-body">
          ${notifications.length ? `
            <div class="notification-list">
              ${notifications.map((notification) => renderNotificationCard(notification, uiState, scopeKey)).join('')}
            </div>
          ` : '<div class="notification-empty">No private notices right now.</div>'}
        </div>
      ` : ''}
      ${renderNotificationToasts(notifications, uiState, scopeKey)}
    </div>
  `;
}

export function renderSpectatorPanel(panel, state, playerId, message) {
  const player = getPlayer(state, playerId);
  panel.innerHTML = `
    <div class="panel-empty spectator-panel">
      <h3>${player ? renderPlayerRoleName(state, player) : 'Dynasty View'}</h3>
      <p>${message}</p>
    </div>
  `;
}

export function buildScores(state) {
  return buildFinalScores(state).scores;
}

function formatScoreShare(share) {
  return `${Math.round((Number(share) || 0) * 100)}%`;
}

export function renderScoringHtml(state, options = {}) {
  const scores = buildScores(state);
  const topScore = scores[0]?.points ?? 0;
  const newGameButton = options.includeNewGame
    ? '<button class="btn-primary" type="button" onclick="location.reload()">New Game</button>'
    : '';
  const actionButtons = [newGameButton].filter(Boolean).join('');

  const CATEGORY_ICON = { church: 'church', estate: 'gold', gold: 'gold' };

  return `
    <div class="scoring-panel">
      <h3>Final Reckoning</h3>
      <p class="section-hint">Highest point total wins. Each 25% share of Church income, Estate income, and Gold reserves is worth 1 point, up to 3 per category.</p>
      <div class="score-list">
        ${scores.map((score) => {
          const rank = scores.filter((other) => other.points > score.points).length + 1;
          const isWinner = score.points === topScore && topScore > 0;
          return `
          <div class="score-row ${isWinner ? 'winner' : ''}" style="${getPlayerStyleAttr(state, score.player.id)}">
            <span class="score-rank" aria-label="${isWinner ? 'Winner, rank' : 'Rank'} ${rank}">${rank}</span>
            <span class="score-dynasty">${renderPlayerRoleName(state, score.player)}</span>
            <span class="score-breakdown">
              ${score.categories.map((category) => {
                const iconKind = CATEGORY_ICON[category.key];
                const iconHtml = iconKind ? renderIcon(iconKind) : '';
                return `
                  <span class="score-cat" title="${escapeHtml(category.label)} — ${formatScoreShare(category.share)} share, ${category.points} point${category.points === 1 ? '' : 's'}">
                    ${iconHtml}
                    <span class="score-cat-share">${formatScoreShare(category.share)}</span>
                    <span class="score-cat-pts">${category.points} pt${category.points === 1 ? '' : 's'}</span>
                  </span>
                `;
              }).join('')}
            </span>
            <span class="score-total">${score.points}</span>
          </div>`;
        }).join('')}
      </div>
      ${actionButtons ? `<div class="scoring-actions">${actionButtons}</div>` : ''}
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderHiddenGameOverOverlay() {
  const overlay = document.getElementById('gameOverOverlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  overlay.style.display = 'none';
}


export function collectTitleAssignments(container) {
  const assignments = {};
  container?.querySelectorAll('[data-title-assignment]').forEach((select) => {
    assignments[select.dataset.titleAssignment] = Number(select.value);
  });
  return assignments;
}

export function renderGameActionPanel({
  panel,
  state,
  uiState,
  activePlayerId,
  selectedProvinceId = null,
  privateData = null,
  canControl = true,
  spectatorMessage = 'You can inspect this dynasty, but cannot issue commands.',
  error = '',
  handlers = {},
  resolution = {},
}) {
  const body = renderActionShell(panel, state, uiState);
  if (!body) return null;

  if (!canControl && state.phase !== 'scoring' && !state.gameOver) {
    renderSpectatorPanel(body, state, activePlayerId, spectatorMessage);
    return body;
  }

  if (error) {
    body.innerHTML = `<div class="action-error" role="alert">${escapeHtml(error)}</div>`;
  }

  const selectedProvinceCue = renderSelectedProvinceCue(state, selectedProvinceId);
  if (selectedProvinceCue) body.insertAdjacentHTML('beforeend', selectedProvinceCue);

  const shell = document.createElement('div');
  body.appendChild(shell);

  if (state.gameOver || state.phase === 'scoring') {
    shell.innerHTML = renderScoringHtml(state, {
      includeNewGame: Boolean(handlers.includeNewGame),
    });
    return body;
  }

  switch (state.phase) {
    case 'title_redistribution':
      renderTitleRedistributionPanel(shell, state, activePlayerId, {
        confirmTitleRedistribution: handlers.confirmTitleRedistribution,
      }, { uiState });
      break;

    case 'court':
      renderCourtPanel(shell, state, activePlayerId, handlers.court || {}, {
        selectedProvinceId,
        uiState,
        privateData,
      });
      break;

    case 'estates':
      renderEstatesPanel(shell, state, activePlayerId, {
        buy: handlers.estates?.buy,
        confirmEstates: handlers.confirmEstates,
      }, { uiState });
      break;

    case 'deployment':
      renderOrdersPanel(shell, state, activePlayerId, {
        lockOrders: handlers.lockOrders,
      }, {
        uiState,
        privateData,
      });
      break;

    case 'resolution': {
      renderResolutionPanelDetailed(shell, state, {
        allowManualTitleReassignment: Boolean(resolution.allowManualTitleReassignment),
        activePlayerId,
      });
      shell.querySelectorAll('[data-defender-reward-choice]').forEach((button) => {
        button.addEventListener('click', () => {
          resolution.defenderRewardChoice?.(button.dataset.rewardId, button.dataset.choice);
        });
      });
      const continueButton = shell.querySelector('[data-action="continue"]');
      if (!continueButton) break;

      if (resolution.submitTitleAssignments) {
        continueButton.textContent = resolution.submitText || 'Submit Titles';
        continueButton.addEventListener('click', () => {
          resolution.submitTitleAssignments(collectTitleAssignments(shell));
        });
        break;
      }

      if (resolution.disabledText) {
        continueButton.textContent = resolution.disabledText;
        continueButton.disabled = true;
        break;
      }

      continueButton.textContent = resolution.continueText || 'Continue';
      continueButton.addEventListener('click', () => {
        resolution.continue?.(shell);
      });
      break;
    }

    default:
      shell.innerHTML = '<div class="panel-empty"><p>Processing...</p></div>';
      break;
  }

  return body;
}


export function renderGameFrame({
  state,
  activePlayerId,
  selectedProvinceId = null,
  uiState,
  aiMeta = null,
  privateData = null,
  notificationScopeKey = 'default',
  renderTabs,
  renderActionPanel,
  renderConnectionBadge = null,
  renderGameOverOverlay = null,
  rerender = null,
}) {
  if (!state) return;
  renderTopBar(state);
  renderConnectionBadge?.();
  updateMapState(state);
  setSelectedProvince(selectedProvinceId);
  drawInvasionRoute(state.currentInvasion);
  renderPlayerDashboard(
    document.getElementById('playerDashboard'),
    state,
    activePlayerId,
    selectedProvinceId,
    { aiMeta, uiState },
  );
  renderBalancePanel(document.getElementById('balancePanel'), state, { uiState });
  renderNotificationsPanel(document.getElementById('notificationPanel'), state, privateData, uiState, notificationScopeKey);
  renderHistoryPanel(document.getElementById('historyPanel'), state, { aiMeta, uiState });
  renderTabs?.();
  renderActionPanel?.();
  bindUiChrome({ uiState, render: rerender || (() => {}) });
  if (state.gameOver || state.phase === 'scoring') renderGameOverOverlay?.();
}
