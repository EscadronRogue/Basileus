import { createGameState } from '../engine/state.js';
import { buildPrivateDealView, setDealParticipantIds } from '../engine/deals.js';
import { buildPrivateNotifications } from '../engine/notifications.js';
import {
  autoResolveUnavailableHumanAppointments,
  handleContinueAfterResolution,
  handleHumanCourtAction,
  handleHumanCourtConfirmation,
  handleHumanEstateAction,
  handleHumanOrders,
  handleEstatesConfirmation,
  resolvePendingTitleReassignment,
  settleAutomaticProgress,
  startInteractiveRuntime,
  handleManualTitleReassignment,
} from '../game/runtime.js';
import { AI_OPPONENT_MISSING_MESSAGE, createAIMeta, hydrateAiOpponent } from '../ai/brain.js';
import { getAiDisplayName } from '../ai/names.js';
import { getPersonality } from '../ai/personalities.js';
import { createMapSVG, focusProvince, setHoveredProvince } from '../render/mapRenderer.js';
import {
  applyProvinceInterfaceState,
  createDefaultUiState,
  getPhaseRenderKey,
  renderGameActionPanel,
  renderGameFrame,
  renderHiddenGameOverOverlay,
  renderPlayerTabs,
  scrollPhasePanelIntoView,
} from './sharedView.js';
import { buildLocalSave, clearLocalSave, restoreLocalSaveState, writeLocalSave } from './localSave.js';
import { addEstateToDraft } from './panels/estates.js';
import { setGlossaryMap } from './glossary.js';

const AUTOSAVE_DELAY_MS = 300;

export class GameController {
  constructor(config = {}) {
    this.config = {
      playerCount: config.playerCount || 5,
      turnCount: config.turnCount || config.deckSize || 9,
      deckSize: config.turnCount || config.deckSize || 9,
      mapId: config.mapId || 'classic',
      seed: config.seed || Date.now(),
      historyEnabled: config.historyEnabled !== false,
      mode: config.mode || 'hotseat',
      aiOpponentSelections: Array.isArray(config.aiOpponentSelections)
        ? config.aiOpponentSelections.slice()
        : [],
      humanPlayerIds: Array.isArray(config.humanPlayerIds)
        ? config.humanPlayerIds.slice()
        : Array.from({ length: config.playerCount || 5 }, (_, index) => index),
    };

    this.state = null;
    this.aiMeta = null;
    this.pendingAiTitleAssignment = null;
    this.selectedProvinceId = null;
    this.hoveredProvinceId = null;
    this.activePlayer = this.config.humanPlayerIds[0] ?? 0;
    this.uiState = createDefaultUiState();
    this.lastPhaseKey = null;
    this.autosaveEnabled = config.autosave !== false;
    this.autosaveTimer = null;
    // Called after every render; the tutorial follows the game through it.
    this.onRender = typeof config.onRender === 'function' ? config.onRender : null;
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

    await this.mountMap();
    this.renderPlayerTabs();
    startInteractiveRuntime(this.state, this.aiMeta, this);
    this.render();
  }

  // Continues a game from ui/localSave.js exactly where it was left.
  async resume(save) {
    const aiPlayers = this.config.mode === 'single' ? await this.loadAiPlayers() : {};
    const restored = restoreLocalSaveState(save, aiPlayers);
    this.state = restored.state;
    this.aiMeta = restored.aiMeta
      || (this.config.mode === 'single'
        ? createAIMeta(this.state, { humanPlayerIds: this.config.humanPlayerIds, aiPlayers })
        : null);
    this.pendingAiTitleAssignment = save.pendingAiTitleAssignment ?? null;
    if (save.mapFilter) this.uiState.mapFilter = save.mapFilter;
    if (Number.isInteger(save.activePlayer)) this.activePlayer = save.activePlayer;
    this.ensureHumanFocus();
    this.assignPlayerFirstNames();

    await this.mountMap();
    this.renderPlayerTabs();
    settleAutomaticProgress(this.state, this.aiMeta, this);
    this.render();
  }

  scheduleAutosave() {
    if (!this.autosaveEnabled || typeof window === 'undefined') return;
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => this.saveNow(), AUTOSAVE_DELAY_MS);
  }

  // Finished games are not offered for resuming.
  saveNow() {
    if (!this.autosaveEnabled || !this.state) return;
    if (this.autosaveTimer && typeof window !== 'undefined') window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    if (this.state.gameOver || this.state.phase === 'scoring') {
      clearLocalSave();
      return;
    }
    writeLocalSave(buildLocalSave(this));
  }

  async mountMap() {
    setGlossaryMap(this.state?.mapId);
    await createMapSVG('mapContainer', {
      mapId: this.state?.mapId,
      mapFilter: this.uiState.mapFilter,
      onMapFilterChange: (filterId) => {
        this.uiState.mapFilter = filterId;
        this.render();
      },
      onProvinceSelect: (provinceId) => {
        // During Estates a map click also plans an estate there.
        const canControl = !(this.isSinglePlayer() && !this.isControllablePlayer(this.activePlayer));
        if (canControl) addEstateToDraft(this.uiState, this.state, this.activePlayer, provinceId);
        this.selectProvince(provinceId);
      },
      onProvinceHover: (provinceId) => {
        this.previewProvince(provinceId, { fromMap: true });
      },
    });
  }

  async loadAiPlayers() {
    const selections = this.config.aiOpponentSelections || [];
    const aiPlayers = {};
    for (const selection of selections) {
      const playerId = Number(selection.playerId);
      if (!Number.isInteger(playerId)) continue;
      const opponent = hydrateAiOpponent(selection, playerId);
      aiPlayers[playerId] = {
        opponent,
        displayName: selection.firstName || selection.name || opponent?.firstName || null,
        opponentId: opponent?.id || selection.id || null,
        policy: selection.policy || opponent?.policy || null,
        strategyWeights: selection.strategyWeights || opponent?.strategyWeights || null,
      };
    }
    return aiPlayers;
  }

  isSinglePlayer() {
    return this.config.mode === 'single' && this.aiMeta !== null;
  }

  // The temperament of each AI seat, as shown next to its name.
  aiTemperament(playerId) {
    const selection = (this.config.aiOpponentSelections || []).find((entry) => Number(entry.playerId) === playerId);
    const personality = getPersonality(selection?.personality)
      || getPersonality(this.aiMeta?.players?.[playerId]?.opponent?.personality);
    return personality?.title || null;
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
        player.aiTemperament = this.aiTemperament(player.id) || player.aiTemperament || null;
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

  resolveAutomaticCourtProgress() {
    if (!this.state || this.state.phase !== 'court') return;
    const canControl = !(this.isSinglePlayer() && !this.isControllablePlayer(this.activePlayer));
    if (!canControl) return;
    autoResolveUnavailableHumanAppointments(this.state, this.activePlayer, this.aiMeta, this);
    this.ensureHumanFocus();
  }

  render() {
    this.resolveAutomaticCourtProgress();
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
      hoveredProvinceId: this.hoveredProvinceId,
      uiState: this.uiState,
      aiMeta: this.aiMeta,
      privateData,
      notificationScopeKey: `local:${this.config.seed}:${this.activePlayer}`,
      renderTabs: () => this.renderPlayerTabs(),
      renderActionPanel: () => this.renderActionPanel(),
      renderGameOverOverlay: () => this.renderGameOver(),
      onSelectProvince: (provinceId) => this.selectProvince(provinceId, { focusMap: true }),
      onHoverProvince: (provinceId) => this.previewProvince(provinceId),
      rerender: () => this.render(),
    });

    if (phaseChanged) {
      const initialPhase = this.lastPhaseKey === null;
      this.lastPhaseKey = phaseKey;
      scrollPhasePanelIntoView({ initial: initialPhase });
    }
    this.scheduleAutosave();
    this.onRender?.(this);
  }

  setActionError(reason) {
    this.uiState.actionError = reason || 'That action is not available.';
  }

  clearActionError() {
    this.uiState.actionError = '';
  }

  selectProvince(provinceId, options = {}) {
    const nextProvinceId = provinceId && this.state?.themes?.[provinceId] ? provinceId : null;
    this.selectedProvinceId = nextProvinceId;
    this.render();
    if (options.focusMap && nextProvinceId) {
      focusProvince(nextProvinceId, { center: true, pulse: true });
    }
  }

  previewProvince(provinceId, options = {}) {
    const nextProvinceId = provinceId && this.state?.themes?.[provinceId] ? provinceId : null;
    this.hoveredProvinceId = nextProvinceId;
    if (!options.fromMap) setHoveredProvince(nextProvinceId);
    applyProvinceInterfaceState({
      selectedProvinceId: this.selectedProvinceId,
      hoveredProvinceId: this.hoveredProvinceId,
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

    const spectatorMessage = state.phase === 'deployment'
      ? 'Switch back to your dynasty to continue.'
      : 'This dynasty is AI-controlled.';

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
      'submit-court-plan': ({ actions = [], passPowers = [] } = {}) => {
        let result = { ok: true };
        const isDone = () => this.state.phase !== 'court' || this.state.courtActions?.playerConfirmed?.has(playerId);
        for (const action of actions) {
          if (isDone()) break;
          result = handleHumanCourtAction(this.state, this.aiMeta, this, playerId, action);
          if (!result.ok) break;
        }
        if (result.ok) {
          for (const powerKey of passPowers) {
            if (isDone()) break;
            result = handleHumanCourtAction(this.state, this.aiMeta, this, playerId, {
              action: 'pass-court-power',
              powerKey,
            });
            if (!result.ok) break;
          }
        }
        if (result.ok && !isDone() && actions.length === 0 && passPowers.length === 0) {
          result = handleHumanCourtConfirmation(this.state, this.aiMeta, this, playerId);
        }
        if (!result.ok) {
          this.setActionError(result.reason);
          this.render();
          return;
        }
        this.clearActionError();
        this.ensureHumanFocus();
        this.render();
      },
      'appoint-strategos': (titleKey, themeId, appointeeId) => dispatch({
        action: 'appoint-strategos', titleKey, themeId, appointeeId,
      }),
      'appoint-bishop': (themeId, appointeeId) => dispatch({
        action: 'appoint-bishop', themeId, appointeeId,
      }),
      revoke: (value) => dispatch({ action: 'revoke', value }),
      'pass-court-power': (powerKey) => dispatch({ action: 'pass-court-power', powerKey }),
    };
  }

  createEstateHandlers(playerId) {
    return {
      // The whole plan is sent once, then the dynasty locks.
      submitEstatePlan: ({ plan = {} } = {}) => {
        let result = handleHumanEstateAction(this.state, this.aiMeta, this, playerId, { action: 'plan', plan });
        if (result.ok) result = handleEstatesConfirmation(this.state, this.aiMeta, this, playerId);
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
    const result = handleEstatesConfirmation(this.state, this.aiMeta, this, this.activePlayer);
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
