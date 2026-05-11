import { buildFinalScores } from '../engine/scoring.js';
import { drawInvasionRoute, setSelectedProvince, updateMapState } from '../render/mapRenderer.js';
import { runAdministration } from '../engine/cascade.js';
import { getPlayer } from '../engine/state.js';
import {
  renderCourtPanel,
  renderHistoryPanel,
  renderOrdersPanel,
  renderPlayerDashboard,
  renderResolutionPanelDetailed,
} from './panels.js';
import { getPlayerStyleAttr, renderPlayerRoleName } from './labels.js';

export function createDefaultUiState() {
  return {
    panels: {
      dashboard: false,
      history: false,
      action: true,
    },
    sections: {},
    dashboardFocus: null,
    drafts: {},
  };
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
    document.getElementById('historyPanel'),
    document.getElementById('actionPanel'),
  ].filter(Boolean);

  for (const container of containers) {
    container.querySelectorAll('[data-ui-panel-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const panelKey = button.dataset.uiPanelToggle;
        setPanelOpen(uiState, panelKey, !isPanelOpen(uiState, panelKey, true));
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
  }
}

export const PHASE_NAMES = {
  setup: 'Setup',
  invasion: 'Invasion',
  administration: 'Administration',
  court: 'Court',
  orders: 'Secret Orders',
  resolution: 'Resolution',
  cleanup: 'Cleanup',
  scoring: 'Final Scoring',
};

export const PHASE_TOOLTIPS = {
  setup: 'Provinces, titles and starting gold are dealt out.',
  invasion: 'A new invasion is drawn. Its route shows which provinces are at risk.',
  administration: 'Provinces pay out gold and raise levies automatically.',
  court: 'Bid on estates, appoint officers, recruit troops, then confirm.',
  orders: 'Each player privately sends every troop to the Capital (coup) or Frontier (war), and picks who to back for the throne.',
  resolution: 'Coup is decided first by Capital troops, then the war by Frontier troops vs invader strength.',
  cleanup: 'Pay 1 gold per professional troop. Levies and mercenaries disband.',
  scoring: 'Each 25% share of church income, estate income, tax income, and gold reserves scores 1 point, up to 3 per category.',
};

export const ACTION_PANEL_TITLE_BY_PHASE = {
  court: 'Imperial Court',
  orders: 'Secret Orders',
  resolution: 'Resolution',
  scoring: 'Final Reckoning',
};

export const ACTION_PANEL_SUBTITLE_BY_PHASE = {
  court: '',
  orders: '',
  resolution: '',
  scoring: '',
};

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

function getPlayerMaintenance(player) {
  return Object.values(player?.professionalArmies || {}).reduce((total, count) => total + count, 0);
}

function formatCompactValue(value, mode = 'plain') {
  const numeric = Number(value) || 0;
  const normalized = Number.isInteger(numeric) ? numeric : Math.round(numeric * 100) / 100;
  const magnitude = Math.abs(normalized);
  if (mode === 'plus') return `+${magnitude}`;
  if (mode === 'minus') return `-${magnitude}`;
  return `${normalized}`;
}

export function getPlayerTabEconomy(player, administration) {
  const income = administration?.income?.[player.id] || 0;
  const upkeep = getPlayerMaintenance(player);
  return {
    reserve: formatCompactValue(player.gold),
    income: formatCompactValue(income, 'plus'),
    expense: formatCompactValue(upkeep, 'minus'),
  };
}

export function renderPlayerTabFinance(economy) {
  return `
    <span class="tab-finance" aria-label="Reserve, income, and upkeep" title="Reserve | income / upkeep">
      <span class="tab-finance-value" data-tab-finance="reserve">${economy.reserve}</span>
      <span class="tab-finance-separator" aria-hidden="true">|</span>
      <span class="tab-finance-value" data-tab-finance="income">${economy.income}</span>
      <span class="tab-finance-separator" aria-hidden="true">/</span>
      <span class="tab-finance-value" data-tab-finance="expense">${economy.expense}</span>
    </span>
  `;
}

export function renderPlayerTabs({ state, activePlayerId, onSelectPlayer, getBadges = null }) {
  const tabBar = document.getElementById('playerTabBar');
  if (!tabBar || !state) return;

  const administration = runAdministration(state);

  tabBar.innerHTML = state.players.map((player) => {
    const economy = getPlayerTabEconomy(player, administration);
    const badges = typeof getBadges === 'function' ? getBadges(player) : [];
    const badgeHtml = badges.filter(Boolean).join('');
    const crown = player.id === state.basileusId ? '<span class="tab-crown" title="Basileus">B</span>' : '';
    return `
      <button class="player-tab ${player.id === activePlayerId ? 'active' : ''}"
        data-player="${player.id}" style="${getPlayerStyleAttr(state, player.id)}">
        <span class="tab-body">
          <span class="tab-name">${player.dynasty}</span>
          ${renderPlayerTabFinance(economy)}
        </span>
        <span class="tab-flags">${badgeHtml}${crown}</span>
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
          <span class="sidebar-panel-title">${ACTION_PANEL_TITLE_BY_PHASE[state.phase] || 'Action Panel'}</span>
          ${ACTION_PANEL_SUBTITLE_BY_PHASE[state.phase] ? `<span class="sidebar-panel-subtitle">${ACTION_PANEL_SUBTITLE_BY_PHASE[state.phase]}</span>` : ''}
        </span>
      </button>
      ${isOpen ? '<div class="sidebar-panel-body" data-role="action-panel-body"></div>' : ''}
    </div>
  `;
  return isOpen ? panel.querySelector('[data-role="action-panel-body"]') : null;
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
    ? '<button class="btn-new-game" onclick="location.reload()">New Game</button>'
    : '';

  return `
    <div class="scoring-panel">
      <h3>Final Reckoning</h3>
      <p class="section-hint">Highest point total wins. Each 25% share of Church income, Estate income, Tax income, and Gold reserves is worth 1 point, up to 3 per category.</p>
      <div class="score-list">
        ${scores.map((score) => {
          const rank = scores.filter((other) => other.points > score.points).length + 1;
          return `
          <div class="score-row ${score.points === topScore ? 'winner' : ''}" style="${getPlayerStyleAttr(state, score.player.id)}">
            <span class="score-rank">${rank}</span>
            <span class="score-dynasty">${renderPlayerRoleName(state, score.player)}</span>
            <span class="score-breakdown">${score.categories.map((category) => `${category.label}: ${formatScoreShare(category.share)} -> ${category.points}`).join(' | ')}</span>
            <span class="score-total">${score.points}</span>
          </div>`;
        }).join('')}
      </div>
      ${newGameButton}
    </div>
  `;
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

  if (!canControl && state.phase !== 'scoring') {
    renderSpectatorPanel(body, state, activePlayerId, spectatorMessage);
    return body;
  }

  if (error) {
    body.innerHTML = `<div class="multiplayer-banner error">${error}</div>`;
  }

  const shell = document.createElement('div');
  body.appendChild(shell);

  switch (state.phase) {
    case 'court':
      renderCourtPanel(shell, state, activePlayerId, handlers.court || {}, {
        selectedProvinceId,
        uiState,
        privateData,
      });
      break;

    case 'orders':
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

    case 'scoring':
      shell.innerHTML = renderScoringHtml(state, { includeNewGame: Boolean(handlers.includeNewGame) });
      break;

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
  renderHistoryPanel(document.getElementById('historyPanel'), state, { aiMeta, uiState });
  renderTabs?.();
  renderActionPanel?.();
  bindUiChrome({ uiState, render: rerender || (() => {}) });
  if (state.gameOver || state.phase === 'scoring') renderGameOverOverlay?.();
}
