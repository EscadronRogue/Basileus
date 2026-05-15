import { createGameState } from '../engine/state.js';
import { buildPrivateDealView, setDealParticipantIds } from '../engine/deals.js';
import { buildPrivateNotifications } from '../engine/notifications.js';
import {
  autoResolveUnavailableHumanAppointments,
  handleContinueAfterResolution,
  handleDefenderRewardChoice,
  handleHumanCourtAction,
  handleHumanCourtConfirmation,
  handleHumanOrders,
  resolvePendingTitleReassignment,
  startInteractiveRuntime,
} from '../engine/runtime.js';
import { createAIMeta, hydrateAiPolicy, loadBrowserAiPolicy } from '../ai/brain.js';
import { exportHumanFeedbackPayload } from '../ai/humanFeedback.js';
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
      aiPolicy: config.aiPolicy || null,
      aiPolicyPayload: config.aiPolicyPayload || null,
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
  }

  async init() {
    this.state = createGameState(this.config);
    // Every dynasty (human or AI) is a deal participant. Engine + AI brain
    // already validate per-actor; gating belonged to UI copy, not state.
    setDealParticipantIds(this.state, this.state.players.map((player) => player.id));
    if (this.config.mode === 'single') {
      const policy = this.config.aiPolicy
        || (this.config.aiPolicyPayload ? hydrateAiPolicy(this.config.aiPolicyPayload) : null)
        || await loadBrowserAiPolicy(undefined, { required: true });
      this.aiMeta = createAIMeta(this.state, {
        humanPlayerIds: this.config.humanPlayerIds,
        policy,
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

  exportHumanFeedback() {
    return exportHumanFeedbackPayload(this.aiMeta, {
      mode: this.config.mode,
      playerCount: this.config.playerCount,
      deckSize: this.config.deckSize,
      seed: this.config.seed,
      humanPlayerIds: this.config.humanPlayerIds,
    });
  }

  downloadHumanFeedback() {
    const payload = this.exportHumanFeedback();
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `basileus-human-feedback-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return payload;
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

    const spectatorMessage = state.phase === 'orders'
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
      handlers: {
        court: this.createCourtHandlers(this.activePlayer),
        lockOrders: (orders) => this.lockOrders(orders),
        includeNewGame: true,
        downloadHumanFeedback: this.isSinglePlayer() ? () => this.downloadHumanFeedback() : null,
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
            this.render();
            return;
          }
          this.render();
        },
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
      buy: (themeId, data = {}) => dispatch({ action: 'buy', themeId, amount: data.amount }),
      gift: (themeId) => dispatch({ action: 'gift', themeId }),
      recruit: (_, data) => dispatch({ action: 'recruit', office: data.office }),
      hireMercenaries: (_, data) => dispatch({ action: 'hire-mercenaries', office: data.office, count: data.count }),
      dismiss: (_, data) => dispatch({ action: 'dismiss', office: data.office, count: data.count }),
      'deal-send': (payload) => dispatch({ action: 'deal-send', ...payload }),
      'deal-counter': (payload) => dispatch({ action: 'deal-counter', ...payload }),
      'deal-accept': (payload) => dispatch({ action: 'deal-accept', ...payload }),
      'deal-refuse': (payload) => dispatch({ action: 'deal-refuse', ...payload }),
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
