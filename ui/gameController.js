import { createGameState } from '../engine/state.js';
import {
  advanceToNextInteractivePhase,
  allOrdersSubmitted,
  phaseResolution,
} from '../engine/turnflow.js';
import {
  applyCourtAction,
  applyManualTitleReassignment,
  confirmCourt,
  submitHumanOrders,
} from '../engine/commands.js';
import {
  autoResolveUnavailableHumanAppointments,
  applyPendingAiTitleAssignment,
  continueAfterResolution,
  maybeAdvanceCourt,
  processAiFlow,
  processPostHumanAction,
} from '../engine/runtime.js';
import {
  createAIMeta,
  invalidateRoundContext,
} from '../ai/brain.js';
import { getAiDisplayName } from '../ai/names.js';
import { createMapSVG, updateMapState, drawInvasionRoute, setSelectedProvince } from '../render/mapRenderer.js';
import {
  renderCourtPanel,
  renderHistoryPanel,
  renderOrdersPanel,
  renderPlayerDashboard,
  renderResolutionPanelDetailed,
} from './panels.js';
import {
  bindUiChrome,
  createDefaultUiState,
  isPanelOpen,
  renderActionShell,
  renderHiddenGameOverOverlay,
  renderPlayerTabs,
  renderScoringHtml,
  renderSpectatorPanel,
  renderTopBar,
  setPanelOpen,
} from './sharedView.js';

export class GameController {
  constructor(config = {}) {
    this.config = {
      playerCount: config.playerCount || 4,
      deckSize: config.deckSize || 9,
      seed: config.seed || Date.now(),
      historyEnabled: config.historyEnabled !== false,
      mode: config.mode || 'hotseat',
      humanPlayerIds: Array.isArray(config.humanPlayerIds)
        ? config.humanPlayerIds.slice()
        : Array.from({ length: config.playerCount || 4 }, (_, index) => index),
      aiPopulationPreset: config.aiPopulationPreset || 'balanced',
      aiPersonalityIds: Array.isArray(config.aiPersonalityIds)
        ? config.aiPersonalityIds.slice()
        : null,
      aiSeatProfiles: config.aiSeatProfiles && typeof config.aiSeatProfiles === 'object'
        ? { ...config.aiSeatProfiles }
        : {},
    };

    this.state = null;
    this.aiMeta = null;
    this.pendingAiTitleAssignment = null;
    this.aiBusy = false;
    this.selectedProvinceId = null;
    this.activePlayer = this.config.humanPlayerIds[0] ?? 0;
    this.uiState = createDefaultUiState();
  }

  async init() {
    this.state = createGameState(this.config);
    if (this.config.mode === 'single') {
      this.aiMeta = createAIMeta(this.state, {
        humanPlayerIds: this.config.humanPlayerIds,
        populationPresetId: this.config.aiPopulationPreset,
        personalityIds: this.config.aiPersonalityIds,
        seatProfiles: this.config.aiSeatProfiles,
      });
      this.ensureHumanFocus();
    }
    this.assignPlayerFirstNames();

    await createMapSVG('mapContainer', {
      onProvinceSelect: (provinceId) => {
        this.selectedProvinceId = provinceId;
        this.render();
      },
    });

    this.renderPlayerTabs();
    advanceToNextInteractivePhase(this.state);
    if (!this.isSinglePlayer() || this.state.phase !== 'court') {
      this.processAiFlow();
    }
    this.render();
  }

  isSinglePlayer() {
    return this.config.mode === 'single' && this.aiMeta !== null;
  }

  assignPlayerFirstNames() {
    if (!this.state) return;
    for (const player of this.state.players) {
      if (this.isSinglePlayer() && this.isHumanPlayer(player.id)) {
        player.firstName = '(You)';
        continue;
      }
      const aiName = getAiDisplayName(this.aiMeta, player.id);
      if (aiName) player.firstName = aiName;
    }
  }

  isHumanPlayer(playerId) {
    return this.config.humanPlayerIds.includes(playerId);
  }

  isControllablePlayer(playerId) {
    return !this.isSinglePlayer() || this.isHumanPlayer(playerId);
  }

  ensureHumanFocus() {
    if (!this.isSinglePlayer()) return;
    if (this.isControllablePlayer(this.activePlayer)) return;
    this.activePlayer = this.config.humanPlayerIds[0] ?? 0;
  }

  invalidateAiPlans() {
    if (this.aiMeta) invalidateRoundContext(this.aiMeta);
  }

  isPanelOpen(panelKey, fallback = true) {
    return isPanelOpen(this.uiState, panelKey, fallback);
  }

  setPanelOpen(panelKey, open) {
    setPanelOpen(this.uiState, panelKey, open);
  }

  bindUiChrome() {
    bindUiChrome({ uiState: this.uiState, render: () => this.render() });
  }

  processAiFlow(options = {}) {
    if (!this.aiMeta || this.aiBusy) return;
    this.aiBusy = true;
    try {
      const result = processAiFlow(this.state, this.aiMeta, {
        ...options,
        pendingAiTitleAssignment: this.pendingAiTitleAssignment,
      });
      if (result) this.pendingAiTitleAssignment = result.pendingAiTitleAssignment;
      this.ensureHumanFocus();
    } finally {
      this.aiBusy = false;
    }
  }

  afterHumanAction(observation = null, options = {}) {
    if (this.aiBusy) return;
    this.aiBusy = true;
    try {
      const result = processPostHumanAction(this.state, this.aiMeta, {
        ...options,
        observation,
        pendingAiTitleAssignment: this.pendingAiTitleAssignment,
      });
      if (result) this.pendingAiTitleAssignment = result.pendingAiTitleAssignment;
      this.ensureHumanFocus();
    } finally {
      this.aiBusy = false;
    }
    this.render();
  }

  handleCourtActionUpdate(observation = null, options = {}) {
    const finalize = Boolean(options.finalize);
    if (!this.isSinglePlayer()) maybeAdvanceCourt(this.state, this.aiMeta);
    this.afterHumanAction(observation, {
      courtMode: this.state.phase === 'court' && this.isSinglePlayer() && !finalize ? 'react' : 'finish',
    });
  }

  render() {
    const state = this.state;
    if (!state) return;
    renderTopBar(state);
    updateMapState(state);
    setSelectedProvince(this.selectedProvinceId);
    drawInvasionRoute(state.currentInvasion);
    renderPlayerDashboard(
      document.getElementById('playerDashboard'),
      state,
      this.activePlayer,
      this.selectedProvinceId,
      {
        aiMeta: this.aiMeta,
        uiState: this.uiState,
      }
    );
    this.renderActionPanel();
    renderHistoryPanel(document.getElementById('historyPanel'), state, {
      aiMeta: this.aiMeta,
      uiState: this.uiState,
    });
    this.renderPlayerTabs();
    this.bindUiChrome();
    if (state.gameOver || state.phase === 'scoring') this.renderGameOver();
  }

  renderTopBar() {
    renderTopBar(this.state);
  }

  renderPlayerTabs() {
    renderPlayerTabs({
      state: this.state,
      activePlayerId: this.activePlayer,
      onSelectPlayer: (playerId) => {
        this.activePlayer = playerId;
        this.render();
      },
      getBadges: (player) => this.isSinglePlayer() && this.isHumanPlayer(player.id)
        ? ['<span class="tab-you">You</span>']
        : [],
    });
  }

  renderActionPanel() {
    const body = renderActionShell(document.getElementById('actionPanel'), this.state, this.uiState);
    if (!body) return;

    switch (this.state.phase) {
      case 'court':
        if (this.isSinglePlayer() && !this.isControllablePlayer(this.activePlayer)) {
          renderSpectatorPanel(body, this.state, this.activePlayer, 'This dynasty is AI-controlled during court. You can inspect its public position but not issue commands.');
        } else {
          this.renderCourtPhase(body);
        }
        break;

      case 'orders':
        if (this.isSinglePlayer() && !this.isControllablePlayer(this.activePlayer)) {
          renderSpectatorPanel(body, this.state, this.activePlayer, 'AI orders stay hidden until resolution. Switch back to your dynasty to lock your own orders.');
          break;
        }
        renderOrdersPanel(body, this.state, this.activePlayer, {
          lockOrders: (orders) => this.lockOrders(orders),
        }, {
          uiState: this.uiState,
        });
        break;

      case 'resolution':
        renderResolutionPanelDetailed(body, this.state, {
          allowManualTitleReassignment: !this.pendingAiTitleAssignment,
        });
        body.querySelector('[data-action="continue"]')?.addEventListener('click', () => {
          const reassignment = this.tryResolveTitleReassignment(body);
          if (!reassignment.ok) return;
          const continuation = continueAfterResolution(this.state, this.aiMeta, null);
          this.pendingAiTitleAssignment = continuation.pendingAiTitleAssignment;
          if (!this.isSinglePlayer() || this.state.phase !== 'court') this.processAiFlow();
          this.render();
        });
        break;

      case 'scoring':
        body.innerHTML = renderScoringHtml(this.state, { includeNewGame: true });
        break;

      default:
        body.innerHTML = '<div class="panel-empty"><p>Processing...</p></div>';
        break;
    }
  }

  lockOrders(orders) {
    const result = submitHumanOrders(this.state, this.activePlayer, orders);
    if (!result.ok) {
      this.render();
      return;
    }
    if (this.aiMeta) {
      this.processAiFlow();
    } else if (allOrdersSubmitted(this.state)) {
      phaseResolution(this.state);
    }
    this.render();
  }

  tryResolveTitleReassignment(panel) {
    if (this.pendingAiTitleAssignment && this.aiMeta) {
      this.pendingAiTitleAssignment = applyPendingAiTitleAssignment(this.state, this.aiMeta, this.pendingAiTitleAssignment);
      return { ok: true };
    }

    const titleAssignments = {};
    panel.querySelectorAll('[data-title-assignment]').forEach((select) => {
      titleAssignments[select.dataset.titleAssignment] = Number(select.value);
    });

    const result = applyManualTitleReassignment(this.state, this.aiMeta, this.state.nextBasileusId, titleAssignments);
    const errorEl = panel.querySelector('[data-role="title-reassignment-error"]');
    if (!result.ok && errorEl) errorEl.textContent = result.reason || '';
    else if (errorEl) errorEl.textContent = '';
    return result;
  }

  renderCourtPhase(panel) {
    const state = this.state;
    const playerId = this.activePlayer;
    autoResolveUnavailableHumanAppointments(state, playerId);
    if (state.phase !== 'court') {
      this.render();
      return;
    }

    const dispatch = (payload) => {
      const result = applyCourtAction(state, playerId, payload);
      if (!result.ok) {
        this.render();
        return;
      }
      this.handleCourtActionUpdate(result.observation || null);
    };

    renderCourtPanel(panel, state, playerId, {
      buy: (themeId) => dispatch({ action: 'buy', themeId }),
      gift: (themeId) => dispatch({ action: 'gift', themeId }),
      exempt: (themeId) => dispatch({ action: 'exempt', themeId }),
      recruit: (_, data) => dispatch({ action: 'recruit', office: data.office }),
      dismiss: (_, data) => dispatch({ action: 'dismiss', office: data.office, count: data.count }),
      'confirm-court': () => {
        const result = confirmCourt(state, playerId);
        if (!result.ok) {
          this.render();
          return;
        }
        this.handleCourtActionUpdate(null, { finalize: true });
      },
      'basileus-appoint': (titleType, appointeeId, themeId) => dispatch({
        action: 'basileus-appoint', titleType, appointeeId, themeId,
      }),
      'appoint-strategos': (titleKey, themeId, appointeeId) => dispatch({
        action: 'appoint-strategos', titleKey, themeId, appointeeId,
      }),
      'appoint-bishop': (themeId, appointeeId) => dispatch({
        action: 'appoint-bishop', themeId, appointeeId,
      }),
      revoke: (value) => dispatch({ action: 'revoke', value }),
    }, {
      selectedProvinceId: this.selectedProvinceId,
      uiState: this.uiState,
    });
  }

  renderScoring(panel) {
    panel.innerHTML = renderScoringHtml(this.state, { includeNewGame: true });
  }

  renderGameOver() {
    if (this.state.gameOver?.type === 'fall') renderHiddenGameOverOverlay();
  }
}
