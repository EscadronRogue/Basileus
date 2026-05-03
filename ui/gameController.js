import { createGameState, getPlayer, formatPlayerLabel } from '../engine/state.js';
import { getPlayerStyleAttr, renderPlayerRoleName } from './labels.js';
import { recordHistoryEvent } from '../engine/history.js';
import { runAdministration } from '../engine/cascade.js';
import {
  advanceToNextInteractivePhase,
  allOrdersSubmitted,
  isCourtComplete,
  phaseCleanup,
  phaseOrders,
  phaseResolution,
  submitOrders,
} from '../engine/turnflow.js';
import {
  applyCoupTitleReassignment,
  buyTheme,
  computeFullWealth,
  dismissProfessional,
  giftToChurch,
  grantTaxExemption,
  hireMercenaries,
  recruitProfessional,
  appointStrategos,
  appointBishop,
  appointCourtTitle,
  revokeMajorTitle,
  revokeMinorTitle,
  revokeTheme,
  revokeTaxExemption,
  revokeCourtTitle,
  canPayRevocationCost,
  getNextRevocationCost,
  validateMajorTitleAssignments,
} from '../engine/actions.js';
import { getMercenaryOrderCost } from '../engine/rules.js';
import {
  applyAIOrderCosts,
  applyPlannedAiTitleAssignment,
  buildAIOrders,
  createAIMeta,
  handlePostResolutionAI,
  invalidateRoundContext,
  isAIPlayer,
  observeCourtAction,
  runAICourtAutomation,
} from '../ai/brain.js';
import { PERSONALITIES } from '../ai/personalities.js';
import { createMapSVG, updateMapState, drawInvasionRoute, setSelectedProvince } from '../render/mapRenderer.js';
import {
  renderCourtPanel,
  renderHistoryPanel,
  renderOrdersPanel,
  renderPlayerDashboard,
  renderResolutionPanelDetailed,
} from './panels.js';



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
    this.orderRevealed = false;
    this.selectedProvinceId = null;
    this.activePlayer = this.config.humanPlayerIds[0] ?? 0;
    this.uiState = {
      panels: {
        dashboard: false,
        history: false,
        action: true,
      },
      sections: {
        'court:land': true,
      },
      dashboardFocus: null,
    };
    this.gameOverDismissed = false;
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
      const aiMetaForPlayer = this.aiMeta?.players?.[player.id];
      const profile = aiMetaForPlayer?.profile;
      const personalityId = aiMetaForPlayer?.personalityId;
      const personalityName = profile?.name
        || (personalityId ? this.getPersonalityNameById(personalityId) : null);
      if (personalityName) {
        player.firstName = personalityName;
      }
    }
  }

  getPersonalityNameById(personalityId) {
    const built = PERSONALITIES?.[personalityId]?.name;
    if (built) return built;
    if (typeof personalityId !== 'string' || !personalityId.length) return null;
    return personalityId.charAt(0).toUpperCase() + personalityId.slice(1);
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
    const value = this.uiState.panels[panelKey];
    return value == null ? fallback : Boolean(value);
  }

  setPanelOpen(panelKey, open) {
    this.uiState.panels[panelKey] = Boolean(open);
  }

  bindUiChrome() {
    const containers = [
      document.getElementById('playerDashboard'),
      document.getElementById('historyPanel'),
      document.getElementById('actionPanel'),
    ].filter(Boolean);

    for (const container of containers) {
      container.querySelectorAll('[data-ui-panel-toggle]').forEach((button) => {
        button.addEventListener('click', () => {
          const panelKey = button.dataset.uiPanelToggle;
          this.setPanelOpen(panelKey, !this.isPanelOpen(panelKey, true));
          this.render();
        });
      });

      container.querySelectorAll('details[data-section-key]').forEach((section) => {
        section.addEventListener('toggle', () => {
          this.uiState.sections[section.dataset.sectionKey] = section.open;
        });
      });

      container.querySelectorAll('[data-dashboard-focus]').forEach((button) => {
        button.addEventListener('click', () => {
          const focusKey = button.dataset.dashboardFocus;
          this.uiState.dashboardFocus = focusKey;
          this.uiState.sections[`dashboard:${focusKey}`] = true;
          this.render();
        });
      });
    }
  }

  handleCourtActionUpdate(observation = null, options = {}) {
    const finalize = Boolean(options.finalize);
    if (!this.isSinglePlayer()) {
      this.maybeAdvanceCourt();
    }
    this.afterHumanAction(observation, {
      courtMode: this.isSinglePlayer() && this.state.phase === 'court'
        ? (finalize ? 'finish' : 'react')
        : 'finish',
    });
  }

  processAiFlow(options = {}) {
    if (!this.aiMeta || this.aiBusy) return;
    this.aiBusy = true;
    const courtMode = options.courtMode || 'finish';

    try {
      let safety = 0;
      while (safety < 20) {
        safety++;

        if (this.state.gameOver || this.state.phase === 'scoring' || this.state.phase === 'resolution') {
          break;
        }

        if (this.state.phase === 'court') {
          runAICourtAutomation(this.state, this.aiMeta, { mode: courtMode });
          if (courtMode === 'finish' && isCourtComplete(this.state)) {
            phaseOrders(this.state);
            this.invalidateAiPlans();
            continue;
          }
          break;
        }

        if (this.state.phase === 'orders') {
          for (const player of this.state.players) {
            if (!isAIPlayer(this.aiMeta, player.id)) continue;
            if (this.state.allOrders[player.id]) continue;

            const orders = buildAIOrders(this.state, this.aiMeta, player.id);
            applyAIOrderCosts(this.state, this.aiMeta, player.id, orders);
            submitOrders(this.state, player.id, orders);
          }

          if (allOrdersSubmitted(this.state)) {
            const previousBasileusId = this.state.basileusId;
            phaseResolution(this.state);
            const aftermath = handlePostResolutionAI(this.state, this.aiMeta, {
              previousBasileusId,
              autoApplyTitleAssignments: false,
            });
            this.pendingAiTitleAssignment = aftermath.plannedAssignment;
          }
          break;
        }

        advanceToNextInteractivePhase(this.state);
      }

      this.ensureHumanFocus();
    } finally {
      this.aiBusy = false;
    }
  }

  afterHumanAction(observation = null, options = {}) {
    if (observation && this.aiMeta) {
      observeCourtAction(this.state, this.aiMeta, observation);
    } else {
      this.invalidateAiPlans();
    }
    this.processAiFlow(options);
    this.render();
  }

  render() {
    const state = this.state;
    this.renderTopBar();
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
    this.updatePlayerTabs();
    this.bindUiChrome();
    if (state.gameOver || state.phase === 'scoring') {
      this.renderGameOver();
    }
  }

  renderTopBar() {
    const state = this.state;
    const roundEl = document.getElementById('roundDisplay');
    const phaseEl = document.getElementById('phaseDisplay');
    const invasionEl = document.getElementById('invasionDisplay');

    if (roundEl) roundEl.textContent = `Round ${state.round} / ${state.maxRounds}`;
    if (phaseEl) {
      const phaseNames = {
        setup: 'Setup',
        invasion: 'Invasion',
        administration: 'Administration',
        court: 'Court',
        orders: 'Secret Orders',
        resolution: 'Resolution',
        cleanup: 'Cleanup',
        scoring: 'Final Scoring',
      };
      if (state.gameOver?.type === 'fall') {
        phaseEl.textContent = 'Empire Fallen';
        phaseEl.className = 'phase-badge phase-empire-fallen';
      } else {
        phaseEl.textContent = phaseNames[state.phase] || state.phase;
        phaseEl.className = `phase-badge phase-${state.phase}`;
      }
    }
    this.renderEmpireFallenBanner();

    if (!invasionEl) return;
    if (state.currentInvasion) {
      const invasion = state.currentInvasion;
      invasionEl.innerHTML = `
        <span class="invasion-name" style="color:${invasion.color}">War: ${invasion.name}</span>
        <span class="invasion-strength">Est. ${invasion.strength[0]}-${invasion.strength[1]}</span>
      `;
      invasionEl.style.display = '';
      return;
    }
    invasionEl.style.display = 'none';
  }

  renderEmpireFallenBanner() {
    const topBar = document.getElementById('topBar');
    if (!topBar) return;
    let banner = document.getElementById('empireFallenBanner');

    if (this.state.gameOver?.type !== 'fall') {
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

    banner.innerHTML = '<strong>Empire Fallen</strong><span>Final state, last turn, and history remain available.</span>';
  }

  renderPlayerTabs() {
    const tabBar = document.getElementById('playerTabBar');
    if (!tabBar) return;

    tabBar.innerHTML = this.state.players.map((player) => {
      const youBadge = this.isSinglePlayer() && this.isHumanPlayer(player.id)
        ? '<span class="tab-you">You</span>'
        : '';
      const crown = player.id === this.state.basileusId ? '<span class="tab-crown">C</span>' : '';
      return `
        <button class="player-tab ${player.id === this.activePlayer ? 'active' : ''}"
          data-player="${player.id}" style="${getPlayerStyleAttr(this.state, player.id)}">
          <span class="tab-crest">${player.dynasty.charAt(0)}</span>
          <span class="tab-name">${renderPlayerRoleName(this.state, player)}</span>
          ${youBadge}
          <span class="tab-gold">${player.gold}g</span>
          ${crown}
        </button>
      `;
    }).join('');

    tabBar.querySelectorAll('.player-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.activePlayer = parseInt(tab.dataset.player, 10);
        this.render();
      });
    });
  }

  updatePlayerTabs() {
    const tabBar = document.getElementById('playerTabBar');
    if (!tabBar) return;

    tabBar.querySelectorAll('.player-tab').forEach((tab) => {
      const playerId = parseInt(tab.dataset.player, 10);
      const player = getPlayer(this.state, playerId);
      tab.classList.toggle('active', playerId === this.activePlayer);
      const goldEl = tab.querySelector('.tab-gold');
      if (goldEl) goldEl.textContent = `${player.gold}g`;
      const crown = tab.querySelector('.tab-crown');
      if (crown) crown.style.display = playerId === this.state.basileusId ? '' : 'none';
    });
  }

  renderActionPanel() {
    const panel = document.getElementById('actionPanel');
    if (!panel) return;
    const panelTitleByPhase = {
      court: 'Imperial Court',
      orders: 'Secret Orders',
      resolution: 'Resolution',
      scoring: 'Final Reckoning',
    };
    const panelSubtitleByPhase = {
      court: 'Appointments, land, exemptions, revocations, and army upkeep',
      orders: 'Troop deployments, mercenaries, and the throne vote',
      resolution: 'Reveal orders and settle the round',
      scoring: 'Projected wealth at the end of the game',
    };
    const isOpen = this.isPanelOpen('action', true);
    panel.classList.toggle('panel-collapsed', !isOpen);
    panel.innerHTML = `
      <div class="sidebar-panel action-shell${isOpen ? '' : ' is-collapsed'}">
        <button class="sidebar-panel-head" type="button" data-ui-panel-toggle="action" aria-expanded="${isOpen}">
          <span class="sidebar-panel-head-copy">
            <span class="sidebar-panel-kicker">Phase Panel</span>
            <span class="sidebar-panel-title">${panelTitleByPhase[this.state.phase] || 'Action Panel'}</span>
            <span class="sidebar-panel-subtitle">${panelSubtitleByPhase[this.state.phase] || 'Current phase controls and details'}</span>
          </span>
          <span class="sidebar-panel-badge">${renderPlayerRoleName(this.state, getPlayer(this.state, this.activePlayer))}</span>
        </button>
        ${isOpen ? '<div class="sidebar-panel-body" data-role="action-panel-body"></div>' : ''}
      </div>
    `;
    if (!isOpen) return;
    const body = panel.querySelector('[data-role="action-panel-body"]');
    if (!body) return;

    switch (this.state.phase) {
      case 'court':
        if (this.isSinglePlayer() && !this.isControllablePlayer(this.activePlayer)) {
          this.renderSpectatorPanel(body, 'This dynasty is AI-controlled during court. You can inspect its public position but not issue commands.');
        } else {
          this.renderCourtPhase(body);
        }
        break;

      case 'orders':
        if (this.isSinglePlayer() && !this.isControllablePlayer(this.activePlayer)) {
          this.renderSpectatorPanel(body, 'AI orders stay hidden until resolution. Switch back to your dynasty to lock your own orders.');
          break;
        }

        renderOrdersPanel(body, this.state, this.activePlayer, {
          lockOrders: (orders) => {
            const totalCost = getMercenaryOrderCost(orders.mercenaries);
            if (getPlayer(this.state, this.activePlayer)?.gold < totalCost) {
              this.render();
              return;
            }
            for (const mercenary of orders.mercenaries) {
              hireMercenaries(this.state, this.activePlayer, mercenary.officeKey, mercenary.count);
            }
            submitOrders(this.state, this.activePlayer, orders);

            if (this.aiMeta) {
              this.processAiFlow();
            } else if (allOrdersSubmitted(this.state)) {
              phaseResolution(this.state);
            }
            this.render();
          },
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

          this.pendingAiTitleAssignment = null;
          phaseCleanup(this.state);
          advanceToNextInteractivePhase(this.state);
          this.invalidateAiPlans();
          this.orderRevealed = false;
          if (!this.isSinglePlayer() || this.state.phase !== 'court') {
            this.processAiFlow();
          }
          this.render();
        });
        break;

      case 'scoring':
        this.renderScoring(body);
        break;

      default:
        body.innerHTML = `<div class="panel-empty"><p>Processing...</p></div>`;
        break;
    }
  }

  renderSpectatorPanel(panel, message) {
    const player = getPlayer(this.state, this.activePlayer);
    panel.innerHTML = `
      <div class="panel-empty spectator-panel">
        <h3>${player ? renderPlayerRoleName(this.state, player) : 'Dynasty View'}</h3>
        <p>${message}</p>
      </div>
    `;
  }

  maybeAdvanceCourt() {
    if (isCourtComplete(this.state)) {
      phaseOrders(this.state);
      this.invalidateAiPlans();
    }
  }

  autoResolveUnavailableHumanAppointments(playerId) {
    if (this.state.phase !== 'court') return;
    const player = getPlayer(this.state, playerId);
    if (!player) return;

    const hasOpenStrategos = (region = null) => Object.values(this.state.themes).some(theme =>
      !theme.occupied &&
      theme.id !== 'CPL' &&
      theme.owner !== 'church' &&
      theme.strategos === null &&
      (region == null || theme.region === region)
    );
    const hasOpenBishop = () => Object.values(this.state.themes).some(theme =>
      !theme.occupied &&
      theme.id !== 'CPL' &&
      !theme.bishopIsDonor &&
      theme.bishop === null
    );

    let changed = false;
    if (playerId === this.state.basileusId && !this.state.courtActions.basileusAppointed) {
      const canAppointMinorTitle =
        this.state.empress === null ||
        this.state.chiefEunuchs === null ||
        hasOpenStrategos() ||
        hasOpenBishop();
      if (!canAppointMinorTitle) {
        this.state.courtActions.basileusAppointed = true;
        changed = true;
      }
    }

    if (player.majorTitles.includes('DOM_EAST') && !this.state.courtActions.domesticEastAppointed && !hasOpenStrategos('east')) {
      this.state.courtActions.domesticEastAppointed = true;
      this.state.courtActions.DOM_EAST_appointed = true;
      changed = true;
    }
    if (player.majorTitles.includes('DOM_WEST') && !this.state.courtActions.domesticWestAppointed && !hasOpenStrategos('west')) {
      this.state.courtActions.domesticWestAppointed = true;
      this.state.courtActions.DOM_WEST_appointed = true;
      changed = true;
    }
    if (player.majorTitles.includes('ADMIRAL') && !this.state.courtActions.admiralAppointed && !hasOpenStrategos('sea')) {
      this.state.courtActions.admiralAppointed = true;
      this.state.courtActions.ADMIRAL_appointed = true;
      changed = true;
    }
    if (player.majorTitles.includes('PATRIARCH') && !this.state.courtActions.patriarchAppointed && !hasOpenBishop()) {
      this.state.courtActions.patriarchAppointed = true;
      changed = true;
    }

    if (changed) {
      this.maybeAdvanceCourt();
    }
  }

  tryResolveTitleReassignment(panel) {
    if (this.pendingAiTitleAssignment && this.aiMeta) {
      applyPlannedAiTitleAssignment(
        this.state,
        this.aiMeta,
        this.pendingAiTitleAssignment,
        this.state.nextBasileusId
      );
      return { ok: true };
    }

    const newBasileusId = this.state.nextBasileusId;
    if (newBasileusId === null || newBasileusId === this.state.basileusId) {
      return { ok: true };
    }

    const titleAssignments = {};
    panel.querySelectorAll('[data-title-assignment]').forEach((select) => {
      titleAssignments[select.dataset.titleAssignment] = Number(select.value);
    });

    const validation = validateMajorTitleAssignments(this.state, newBasileusId, titleAssignments);
    const errorEl = panel.querySelector('[data-role="title-reassignment-error"]');
    if (!validation.ok) {
      if (errorEl) errorEl.textContent = validation.reason;
      return validation;
    }

    if (errorEl) errorEl.textContent = '';
    const previousAssignments = {};
    this.state.players.forEach((player) => {
      player.majorTitles.forEach((titleKey) => {
        previousAssignments[titleKey] = player.id;
      });
    });
    applyCoupTitleReassignment(this.state, newBasileusId, titleAssignments);
    if (this.aiMeta) {
      Object.entries(titleAssignments).forEach(([titleKey, appointeeId]) => {
        observeCourtAction(this.state, this.aiMeta, {
          type: 'appointment',
          actorId: newBasileusId,
          appointeeId: Number(appointeeId),
          previousHolderId: previousAssignments[titleKey] ?? null,
          value: 1.25,
        });
      });
    }
    return { ok: true };
  }

  renderCourtPhase(panel) {
    const state = this.state;
    const playerId = this.activePlayer;
    this.autoResolveUnavailableHumanAppointments(playerId);
    if (this.state.phase !== 'court') {
      this.render();
      return;
    }

    renderCourtPanel(panel, state, playerId, {
      buy: (themeId) => {
        buyTheme(state, playerId, themeId);
        this.handleCourtActionUpdate();
      },
      gift: (themeId) => {
        giftToChurch(state, playerId, themeId);
        this.handleCourtActionUpdate();
      },
      exempt: (themeId) => {
        const result = grantTaxExemption(state, playerId, themeId);
        if (!result?.ok) {
          this.render();
          return;
        }
        this.handleCourtActionUpdate();
      },
      recruit: (_, data) => {
        const result = recruitProfessional(state, playerId, data.office);
        if (!result?.ok) {
          this.render();
          return;
        }
        this.handleCourtActionUpdate();
      },
      dismiss: (_, data) => {
        const count = Number(data.count);
        const result = dismissProfessional(state, playerId, data.office, count);
        if (!result?.ok) {
          this.render();
          return;
        }
        this.handleCourtActionUpdate();
      },
      'confirm-court': () => {
        state.courtActions.playerConfirmed.add(playerId);
        recordHistoryEvent(state, {
          category: 'court',
          type: 'court_confirmed',
          actorId: playerId,
          actorAi: false,
          summary: `${formatPlayerLabel(getPlayer(state, playerId)) || `Player ${playerId + 1}`} ends court business for the round.`,
        });
        this.handleCourtActionUpdate(null, { finalize: true });
      },
      'basileus-appoint': (titleType, appointeeId, themeId) => {
        if (state.courtActions.basileusAppointed) return;

        let result = null;
        let previousHolderId = null;
        if (titleType === 'EMPRESS') previousHolderId = state.empress;
        if (titleType === 'CHIEF_EUNUCHS') previousHolderId = state.chiefEunuchs;
        if (titleType === 'STRATEGOS' && themeId) previousHolderId = state.themes[themeId]?.strategos ?? null;
        if (titleType === 'BISHOP' && themeId) previousHolderId = state.themes[themeId]?.bishop ?? null;

        if (titleType === 'EMPRESS' || titleType === 'CHIEF_EUNUCHS') {
          result = appointCourtTitle(state, titleType, appointeeId);
        } else if (titleType === 'STRATEGOS' && themeId) {
          result = appointStrategos(state, state.basileusId, themeId, appointeeId);
        } else if (titleType === 'BISHOP' && themeId) {
          result = appointBishop(state, state.basileusId, themeId, appointeeId);
        }

        if (!result?.ok) {
          this.render();
          return;
        }

        state.courtActions.basileusAppointed = true;
        this.handleCourtActionUpdate({
          type: 'appointment',
          actorId: state.basileusId,
          appointeeId,
          previousHolderId,
          value: (titleType === 'EMPRESS' || titleType === 'CHIEF_EUNUCHS') ? 1.2 : 1.0,
        });
      },
      'appoint-strategos': (titleKey, themeId, appointeeId) => {
        const region = { DOM_EAST: 'east', DOM_WEST: 'west', ADMIRAL: 'sea' }[titleKey];
        const theme = state.themes[themeId];
        if (!theme || theme.region !== region) return;

        const previousHolderId = theme.strategos;
        const result = appointStrategos(state, playerId, themeId, appointeeId);
        if (!result?.ok) {
          this.render();
          return;
        }

        state.courtActions[`${titleKey}_appointed`] = true;
        if (titleKey === 'DOM_EAST') state.courtActions.domesticEastAppointed = true;
        if (titleKey === 'DOM_WEST') state.courtActions.domesticWestAppointed = true;
        if (titleKey === 'ADMIRAL') state.courtActions.admiralAppointed = true;
        this.handleCourtActionUpdate({
          type: 'appointment',
          actorId: playerId,
          appointeeId,
          previousHolderId,
          value: 0.95,
        });
      },
      'appoint-bishop': (themeId, appointeeId) => {
        const previousHolderId = state.themes[themeId]?.bishop ?? null;
        const result = appointBishop(state, playerId, themeId, appointeeId);
        if (!result?.ok) {
          this.render();
          return;
        }

        state.courtActions.patriarchAppointed = true;
        this.handleCourtActionUpdate({
          type: 'appointment',
          actorId: playerId,
          appointeeId,
          previousHolderId,
          value: 1.0,
        });
      },
      revoke: (value) => {
        const check = canPayRevocationCost(state);
        if (!check.ok) {
          this.render();
          return;
        }
        const parts = value.split(':');
        let observation = { type: 'revocation', actorId: state.basileusId };
        let result = null;

        if (parts[0] === 'major') {
          const revokedPlayerId = parseInt(parts[1], 10);
          const titleKey = parts[2];
          const eligible = state.players.filter(player => player.id !== state.basileusId && player.id !== revokedPlayerId);
          if (eligible.length > 0) {
            const newHolderId = eligible[0].id;
            result = revokeMajorTitle(state, revokedPlayerId, titleKey, newHolderId);
            if (result?.ok) observation = { ...observation, targetPlayerId: revokedPlayerId, newHolderId };
          }
        } else if (parts[0] === 'minor') {
          const theme = state.themes[parts[1]];
          const targetPlayerId = parts[2] === 'strategos' ? theme?.strategos ?? null : theme?.bishop ?? null;
          result = revokeMinorTitle(state, parts[1], parts[2]);
          if (result?.ok) observation = { ...observation, targetPlayerId };
        } else if (parts[0] === 'court') {
          const targetPlayerId = parts[1] === 'EMPRESS' ? state.empress : state.chiefEunuchs;
          result = revokeCourtTitle(state, parts[1]);
          if (result?.ok) observation = { ...observation, targetPlayerId };
        } else if (parts[0] === 'exempt') {
          result = revokeTaxExemption(state, parts[1]);
        } else if (parts[0] === 'theme') {
          const targetPlayerId = state.themes[parts[1]]?.owner ?? null;
          result = revokeTheme(state, parts[1]);
          if (result?.ok) observation = { ...observation, targetPlayerId };
        }

        if (result?.ok) {
          this.handleCourtActionUpdate(observation);
        } else {
          this.render();
        }
      },
    }, {
      selectedProvinceId: this.selectedProvinceId,
      uiState: this.uiState,
    });

  }

  renderScoring(panel) {
    const state = this.state;
    const adminResult = runAdministration(state);

    const scores = state.players.map((player) => {
      const projected = adminResult.income[player.id] || 0;
      const wealth = computeFullWealth(state, player.id, projected);
      return { player, wealth, gold: player.gold, projected };
    }).sort((left, right) => right.wealth - left.wealth);

    panel.innerHTML = `
      <div class="scoring-panel">
        <h3>Final Reckoning</h3>
        <div class="score-list">
          ${scores.map((score, index) => `
            <div class="score-row ${index === 0 ? 'winner' : ''}" style="--player-color: ${score.player.color}">
              <span class="score-rank">${index === 0 ? '1' : index + 1}</span>
              <span class="score-dynasty">${renderPlayerRoleName(state, score.player)}</span>
              <span class="score-breakdown">${score.gold}g + ${score.projected} projected</span>
              <span class="score-total">${score.wealth}</span>
            </div>
          `).join('')}
        </div>
        <button class="btn-new-game" onclick="location.reload()">New Game</button>
      </div>
    `;
  }

  renderGameOver() {
    const overlay = document.getElementById('gameOverOverlay');
    if (!overlay) return;

    if (this.state.gameOver?.type === 'fall') {
      overlay.innerHTML = '';
      overlay.style.display = 'none';
      return;
    }
  }
}
