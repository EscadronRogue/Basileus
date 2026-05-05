import { createGameState } from '../engine/state.js';
import {
  autoResolveUnavailableHumanAppointments,
  handleContinueAfterResolution,
  handleHumanCourtAction,
  handleHumanCourtConfirmation,
  handleHumanOrders,
  resolvePendingTitleReassignment,
  startInteractiveRuntime,
} from '../engine/runtime.js';
import { createAIMeta } from '../ai/brain.js';
import { getAiDisplayName } from '../ai/names.js';
import { createMapSVG } from '../render/mapRenderer.js';
import {
  createDefaultUiState,
  renderGameActionPanel,
  renderGameFrame,
  renderHiddenGameOverOverlay,
  renderPlayerTabs,
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
    startInteractiveRuntime(this.state, this.aiMeta, this);
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

  render() {
    renderGameFrame({
      state: this.state,
      activePlayerId: this.activePlayer,
      selectedProvinceId: this.selectedProvinceId,
      uiState: this.uiState,
      aiMeta: this.aiMeta,
      renderTabs: () => this.renderPlayerTabs(),
      renderActionPanel: () => this.renderActionPanel(),
      renderGameOverOverlay: () => this.renderGameOver(),
      rerender: () => this.render(),
    });
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
    const state = this.state;
    const canControl = !(this.isSinglePlayer() && !this.isControllablePlayer(this.activePlayer));

    if (state.phase === 'court' && canControl) {
      autoResolveUnavailableHumanAppointments(state, this.activePlayer);
    }

    const spectatorMessage = state.phase === 'orders'
      ? 'AI orders stay hidden until resolution. Switch back to your dynasty to lock your own orders.'
      : 'This dynasty is AI-controlled during court. You can inspect its public position but not issue commands.';

    renderGameActionPanel({
      panel: document.getElementById('actionPanel'),
      state,
      uiState: this.uiState,
      activePlayerId: this.activePlayer,
      selectedProvinceId: this.selectedProvinceId,
      canControl,
      spectatorMessage,
      handlers: {
        court: this.createCourtHandlers(this.activePlayer),
        lockOrders: (orders) => this.lockOrders(orders),
        includeNewGame: true,
      },
      resolution: {
        allowManualTitleReassignment: !this.pendingAiTitleAssignment,
        continue: (shell) => {
          const reassignment = this.tryResolveTitleReassignment(shell);
          if (!reassignment.ok) return;
          handleContinueAfterResolution(this.state, this.aiMeta, this);
          this.render();
        },
      },
    });
  }

  createCourtHandlers(playerId) {
    const dispatch = (payload) => {
      const result = handleHumanCourtAction(this.state, this.aiMeta, this, playerId, payload);
      if (!result.ok) {
        this.render();
        return;
      }
      this.ensureHumanFocus();
      this.render();
    };

    return {
      buy: (themeId) => dispatch({ action: 'buy', themeId }),
      gift: (themeId) => dispatch({ action: 'gift', themeId }),
      exempt: (themeId) => dispatch({ action: 'exempt', themeId }),
      recruit: (_, data) => dispatch({ action: 'recruit', office: data.office }),
      dismiss: (_, data) => dispatch({ action: 'dismiss', office: data.office, count: data.count }),
      'confirm-court': () => {
        const result = handleHumanCourtConfirmation(this.state, this.aiMeta, this, playerId);
        if (!result.ok) {
          this.render();
          return;
        }
        this.ensureHumanFocus();
        this.render();
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
    };
  }

  lockOrders(orders) {
    const result = handleHumanOrders(this.state, this.aiMeta, this, this.activePlayer, orders);
    if (!result.ok) {
      this.render();
      return;
    }
    this.render();
  }

  tryResolveTitleReassignment(panel) {
    if (this.pendingAiTitleAssignment && this.aiMeta) {
      return resolvePendingTitleReassignment(this.state, this.aiMeta, this);
    }

    const assignmentControls = Array.from(panel.querySelectorAll('[data-title-assignment]'));
    const titleAssignments = assignmentControls.length
      ? Object.fromEntries(assignmentControls.map((select) => [
        select.dataset.titleAssignment,
        Number(select.value),
      ]))
      : null;

    const result = titleAssignments
      ? resolvePendingTitleReassignment(this.state, this.aiMeta, this, titleAssignments)
      : resolvePendingTitleReassignment(this.state, this.aiMeta, this);
    const errorEl = panel.querySelector('[data-role="title-reassignment-error"]');
    if (!result.ok && errorEl) errorEl.textContent = result.reason || '';
    else if (errorEl) errorEl.textContent = '';
    return result;
  }

  renderGameOver() {
    if (this.state.gameOver?.type === 'fall') renderHiddenGameOverOverlay();
  }
}
