import { createGameState } from '../engine/state.js';
import { buildPrivateDealView, setDealParticipantIds } from '../engine/deals.js';
import { buildPrivateNotifications } from '../engine/notifications.js';
import {
  autoResolveUnavailableHumanAppointments,
  handleContinueAfterResolution,
  handleDefenderRewardChoice,
  handleHumanCourtAction,
  handleHumanCourtConfirmation,
  handleHumanEstateAction,
  handleHumanOrders,
  handleEstatesConfirmation,
  resolvePendingTitleReassignment,
  startInteractiveRuntime,
  handleManualTitleReassignment,
} from '../engine/runtime.js';
import { AI_OPPONENT_MISSING_MESSAGE, createAIMeta, hydrateAiOpponent } from '../ai/brain.js';
import { getAiDisplayName } from '../ai/names.js';
import { createMapSVG } from '../render/mapRenderer.js';
import {
  createDefaultUiState,
  getPhaseRenderKey,
  renderGameActionPanel,
  renderGameFrame,
  renderHiddenGameOverOverlay,
  renderPlayerTabs,
  scrollPhasePanelIntoView,
} from './sharedView.js';

export class GameController {
  constructor(config = {}) {
    this.config = {
      playerCount: config.playerCount || 4,
      deckSize: config.deckSize || 9,
      seed: config.seed || Date.now(),
      historyEnabled: config.historyEnabled !== false,
      mode: config.mode || 'hotseat',
      aiOpponentSelections: Array.isArray(config.aiOpponentSelections)
        ? config.aiOpponentSelections.slice()
        : [],
      humanPlayerIds: Array.isArray(config.humanPlayerIds)
        ? config.humanPlayerIds.slice()
        : Array.from({ length: config.playerCount || 4 }, (_, index) => index),
    };

    this.state = null;
    this.aiMeta = null;
    this.pendingAiTitleAssignment = null;
    this.selectedProvinceId = null;
    this.activePlayer = this.config.humanPlayerIds[0] ?? 0;
    this.uiState = createDefaultUiState();
    this.lastPhaseKey = null;
  }

  async init() {
    this.state = createGameState(this.config);
    // Every dynasty (human or AI) is a deal participant. Engine + AI brain
    // already validate per-actor; gating belonged to UI copy, not state.
    setDealParticipantIds(this.state, this.state.players.map((player) => player.id));
    if (this.config.mode === 'single') {
      const aiPlayers = await this.loadAiPlayers();
      if (!Object.keys(aiPlayers).length) throw new Error(AI_OPPONENT_MISSING_MESSAGE);
      this.aiMeta = createAIMeta(this.state, {
        humanPlayerIds: this.config.humanPlayerIds,
        aiPlayers,
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

  async loadAiPlayers() {
    const selections = this.config.aiOpponentSelections || [];
    const aiPlayers = {};
    for (const selection of selections) {
      const playerId = Number(selection.playerId);
      if (!Number.isInteger(playerId)) continue;
      const opponent = hydrateAiOpponent(selection.id || selection.opponentId, playerId);
      aiPlayers[playerId] = {
        opponent,
        displayName: selection.firstName || selection.name || opponent?.firstName || null,
        opponentId: opponent?.id || selection.id || null,
      };
    }
    return aiPlayers;
  }

  isSinglePlayer() {
    return this.config.mode === 'single' && this.aiMeta !== null;
  }

  assignPlayerFirstNames() {
    if (!this.state) return;
    for (const player of this.state.players) {
      if (this.isSinglePlayer() && this.isHumanPlayer(player.id)) {
        player.firstName = '(You)';
        player.isAIControlled = false;
        continue;
      }
      const aiName = getAiDisplayName(this.aiMeta, player.id);
      if (aiName) {
        player.firstName = aiName;
        player.isAIControlled = true;
      }
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
    const phaseKey = getPhaseRenderKey(this.state);
    const phaseChanged = phaseKey !== this.lastPhaseKey;
    if (phaseChanged) {
      this.clearActionError();
      this.uiState.panels.action = true;
    }

    const privateData = this.buildPrivateData(this.activePlayer);
    renderGameFrame({
      state: this.state,
      activePlayerId: this.activePlayer,
      selectedProvinceId: this.selectedProvinceId,
      uiState: this.uiState,
      aiMeta: this.aiMeta,
      privateData,
      notificationScopeKey: `local:${this.config.seed}:${this.activePlayer}`,
      renderTabs: () => this.renderPlayerTabs(),
      renderActionPanel: () => this.renderActionPanel(),
      renderGameOverOverlay: () => this.renderGameOver(),
      rerender: () => this.render(),
    });

    if (phaseChanged) {
      this.lastPhaseKey = phaseKey;
      scrollPhasePanelIntoView();
    }
  }

  setActionError(reason) {
    this.uiState.actionError = reason || 'That action is not available.';
  }

  clearActionError() {
    this.uiState.actionError = '';
  }

  buildPrivateData(playerId) {
    const dealView = buildPrivateDealView(this.state, playerId);
    return {
      ...dealView,
      ...buildPrivateNotifications(this.state, playerId, dealView),
    };
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

    const spectatorMessage = state.phase === 'deployment'
      ? 'Switch back to your dynasty to continue.'
      : 'This dynasty is AI-controlled.';
    const pendingHumanDefenderReward = state.pendingDefenderRewards?.some((reward) => (
      !reward.resolved && (!this.aiMeta || this.isHumanPlayer(reward.defenderId))
    ));

    renderGameActionPanel({
      panel: document.getElementById('actionPanel'),
      state,
      uiState: this.uiState,
      activePlayerId: this.activePlayer,
      selectedProvinceId: this.selectedProvinceId,
      privateData: this.buildPrivateData(this.activePlayer),
      canControl,
      spectatorMessage,
      error: this.uiState.actionError,
      handlers: {
        court: this.createCourtHandlers(this.activePlayer),
        estates: this.createEstateHandlers(this.activePlayer),
        confirmEstates: () => this.confirmEstates(),
        confirmTitleRedistribution: (assignments) => this.confirmTitleRedistribution(assignments),
        lockOrders: (orders) => this.lockOrders(orders),
        includeNewGame: true,
      },
      resolution: {
        allowManualTitleReassignment: !this.pendingAiTitleAssignment,
        disabledText: pendingHumanDefenderReward
          && this.state.nextBasileusId === this.state.basileusId
          ? 'Resolve Rewards'
          : null,
        defenderRewardChoice: (rewardId, choice) => {
          const result = handleDefenderRewardChoice(this.state, this.aiMeta, this, this.activePlayer, rewardId, choice);
          if (!result.ok) {
            this.setActionError(result.reason);
            this.render();
            return;
          }
          this.clearActionError();
          this.render();
        },
        continue: (shell) => {
          const reassignment = this.tryResolveTitleReassignment(shell);
          if (!reassignment.ok) {
            this.setActionError(reassignment.reason);
            this.render();
            return;
          }
          handleContinueAfterResolution(this.state, this.aiMeta, this);
          this.clearActionError();
          this.render();
        },
      },
    });
  }

  createCourtHandlers(playerId) {
    const dispatch = (payload) => {
      const result = handleHumanCourtAction(this.state, this.aiMeta, this, playerId, payload);
      if (!result.ok) {
        this.setActionError(result.reason);
        this.render();
        return;
      }
      this.clearActionError();
      this.ensureHumanFocus();
      this.render();
    };

    return {
      gift: (themeId) => dispatch({ action: 'gift', themeId }),
      'deal-send': (payload) => dispatch({ action: 'deal-send', ...payload }),
      'deal-counter': (payload) => dispatch({ action: 'deal-counter', ...payload }),
      'deal-accept': (payload) => dispatch({ action: 'deal-accept', ...payload }),
      'deal-refuse': (payload) => dispatch({ action: 'deal-refuse', ...payload }),
      'confirm-court': () => {
        const result = handleHumanCourtConfirmation(this.state, this.aiMeta, this, playerId);
        if (!result.ok) {
          this.setActionError(result.reason);
          this.render();
          return;
        }
        this.clearActionError();
        this.ensureHumanFocus();
        this.render();
      },
      'basileus-appoint': (titleType, appointeeId, themeId) => dispatch({
        action: 'basileus-appoint', titleType, appointeeId, themeId,
      }),
      'appoint-court': (titleType, appointeeId) => dispatch({
        action: 'appoint-court', titleType, appointeeId,
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

  createEstateHandlers(playerId) {
    return {
      buy: (themeId, data = {}) => {
        const result = handleHumanEstateAction(this.state, this.aiMeta, this, playerId, {
          action: 'buy',
          themeId,
          amount: data.amount,
        });
        if (!result.ok) {
          this.setActionError(result.reason);
          this.render();
          return;
        }
        this.clearActionError();
        this.render();
      },
    };
  }

  confirmEstates() {
    const result = handleEstatesConfirmation(this.state, this.aiMeta, this);
    if (!result.ok) {
      this.setActionError(result.reason);
      this.render();
      return;
    }
    this.clearActionError();
    this.render();
  }

  confirmTitleRedistribution(assignments) {
    const result = handleManualTitleReassignment(this.state, this.aiMeta, this, this.activePlayer, assignments);
    if (!result.ok) {
      this.setActionError(result.reason);
      this.render();
      return;
    }
    this.clearActionError();
    this.renderPlayerTabs();
    this.render();
  }

  lockOrders(orders) {
    const result = handleHumanOrders(this.state, this.aiMeta, this, this.activePlayer, orders);
    if (!result.ok) {
      this.setActionError(result.reason);
      this.render();
      return;
    }
    this.clearActionError();
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
