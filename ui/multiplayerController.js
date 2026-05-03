import { computeFullWealth } from '../engine/actions.js';
import { runAdministration } from '../engine/cascade.js';
import { getPlayer } from '../engine/state.js';
import { getPlayerStyleAttr, renderPlayerRoleName } from './labels.js';
import { createMapSVG, drawInvasionRoute, setSelectedProvince, updateMapState } from '../render/mapRenderer.js';
import {
  renderCourtPanel,
  renderHistoryPanel,
  renderOrdersPanel,
  renderPlayerDashboard,
  renderResolutionPanelDetailed,
} from './panels.js';



function getPlayerMaintenance(player) {
  return Object.values(player.professionalArmies || {}).reduce((total, count) => total + count, 0);
}

function formatSignedGold(value, { expense = false } = {}) {
  const amount = Math.max(0, Number(value) || 0);
  if (expense) return amount > 0 ? `-${amount}` : '0';
  return amount > 0 ? `+${amount}` : '0';
}

function getPlayerTabEconomy(player, administration) {
  return {
    reserve: `${player.gold}g`,
    income: formatSignedGold(administration?.income?.[player.id] || 0),
    expense: formatSignedGold(getPlayerMaintenance(player), { expense: true }),
  };
}

function renderPlayerTabFinance(economy) {
  return `
    <span class="tab-finance" aria-label="Gold reserve, expected income, expected expenditure" title="Gold reserve / expected income / expected expenditure">
      <span class="tab-finance-value" data-tab-finance="reserve">${economy.reserve}</span>
      <span class="tab-finance-separator" aria-hidden="true">/</span>
      <span class="tab-finance-value" data-tab-finance="income">${economy.income}</span>
      <span class="tab-finance-separator" aria-hidden="true">/</span>
      <span class="tab-finance-value" data-tab-finance="expense">${economy.expense}</span>
    </span>
  `;
}

const STORAGE_KEY = 'basileus.multiplayer.sessions.v1';
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

function readStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStorage(store) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore storage failures.
  }
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

export function getStoredMultiplayerSession(roomCode) {
  return readStorage()[normalizeRoomCode(roomCode)] || null;
}

function saveMultiplayerSession(record) {
  if (!record?.roomCode) return;
  const store = readStorage();
  store[normalizeRoomCode(record.roomCode)] = {
    roomCode: normalizeRoomCode(record.roomCode),
    sessionToken: record.sessionToken || '',
    seatToken: record.seatToken || '',
    playerName: record.playerName || '',
  };
  writeStorage(store);
}

function clearMultiplayerSession(roomCode) {
  const normalized = normalizeRoomCode(roomCode);
  const store = readStorage();
  delete store[normalized];
  writeStorage(store);
}

function readBackendBase() {
  // Highest priority: explicit override via `window.BASILEUS_MULTIPLAYER_URL`.
  // Useful for ad-hoc testing without rebuilding the page.
  const override = typeof window !== 'undefined' && window.BASILEUS_MULTIPLAYER_URL;
  if (override && typeof override === 'string') {
    return override.trim().replace(/\/+$/, '');
  }
  // Then: a <meta name="basileus-multiplayer-url" content="..."> tag in the
  // page. The deployed GitHub Pages build sets this to the Render URL; the
  // local dev server leaves it blank so we fall back to same-origin.
  if (typeof document !== 'undefined') {
    const meta = document.querySelector('meta[name="basileus-multiplayer-url"]');
    const value = meta?.getAttribute('content');
    if (value && value.trim()) {
      return value.trim().replace(/\/+$/, '');
    }
  }
  return '';
}

function resolveApiUrl(path) {
  const base = readBackendBase();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function buildWebSocketUrl() {
  const base = readBackendBase();
  if (base) {
    // Translate http(s):// → ws(s):// while keeping host + path intact.
    const url = new URL(base);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${url.host}${url.pathname.replace(/\/$/, '')}/ws`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function hydratePublicState(rawState = {}) {
  return {
    ...rawState,
    historyEnabled: true,
    history: Array.isArray(rawState.history) ? rawState.history : [],
    players: Array.isArray(rawState.players) ? rawState.players : [],
    themes: rawState.themes && typeof rawState.themes === 'object' ? rawState.themes : {},
    currentLevies: rawState.currentLevies && typeof rawState.currentLevies === 'object' ? rawState.currentLevies : {},
    allOrders: rawState.allOrders && typeof rawState.allOrders === 'object' ? rawState.allOrders : {},
    recruitedThisRound: rawState.recruitedThisRound && typeof rawState.recruitedThisRound === 'object'
      ? rawState.recruitedThisRound
      : {},
    courtActions: rawState.courtActions
      ? {
        ...rawState.courtActions,
        playerConfirmed: new Set(rawState.courtActions.playerConfirmed || []),
      }
      : null,
  };
}

async function requestJson(path, payload) {
  const url = resolveApiUrl(path);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404 && String(path).startsWith('/api/rooms')) {
      throw new Error('This server does not have the multiplayer backend yet. Stop the current local server and start it again.');
    }
    throw new Error(body?.error || 'Request failed.');
  }
  return body;
}

export async function launchMultiplayerClient(options = {}) {
  const playerName = String(options.playerName || '').trim() || 'Guest';
  const roomCode = normalizeRoomCode(options.roomCode);
  const intent = options.intent === 'join'
    ? 'join'
    : options.intent === 'create'
      ? 'create'
      : (roomCode ? 'join' : 'create');

  if (intent === 'join' && !ROOM_CODE_PATTERN.test(roomCode)) {
    throw new Error('Enter a full 6-character room code to join, or leave it blank to create a room.');
  }
  const stored = roomCode ? getStoredMultiplayerSession(roomCode) : null;

  const payload = intent === 'join'
    ? await requestJson(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
      playerName,
      seatToken: stored?.seatToken || '',
    })
    : await requestJson('/api/rooms', {
      playerName,
      config: options.config || {},
    });

  const controller = new MultiplayerController({
    setupDialog: options.setupDialog,
    roomCode: payload.roomCode,
    playerName,
    sessionToken: payload.sessionToken,
    seatToken: payload.seatToken || stored?.seatToken || '',
    roomSnapshot: payload.roomSnapshot || null,
  });

  controller.persistSession();
  controller.render();
  controller.connect();
  return controller;
}

export class MultiplayerController {
  constructor(options = {}) {
    this.setupDialog = options.setupDialog;
    this.roomCode = normalizeRoomCode(options.roomCode);
    this.playerName = String(options.playerName || '').trim() || 'Guest';
    this.sessionToken = String(options.sessionToken || '').trim();
    this.seatToken = String(options.seatToken || '').trim();
    this.roomSnapshot = options.roomSnapshot || null;
    this.publicSnapshot = null;
    this.privateSnapshot = null;
    this.state = null;
    this.selectedProvinceId = null;
    this.viewPlayerId = 0;
    this.socket = null;
    this.connectionState = 'connecting';
    this.lastError = '';
    this.requestSeq = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.intentionalClose = false;
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

  persistSession() {
    saveMultiplayerSession({
      roomCode: this.roomCode,
      sessionToken: this.sessionToken,
      seatToken: this.seatToken,
      playerName: this.playerName,
    });
  }

  clearSession() {
    clearMultiplayerSession(this.roomCode);
  }

  getControlledSeatId() {
    return this.privateSnapshot?.seatId ?? this.roomSnapshot?.yourSession?.claimedSeatId ?? null;
  }

  isHost() {
    return Boolean(this.roomSnapshot?.yourSession?.isHost);
  }

  connect() {
    this.intentionalClose = false;
    this.connectionState = 'connecting';
    this.render();

    const socket = new WebSocket(buildWebSocketUrl());
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.connectionState = 'connected';
      this.lastError = '';
      this.send('hello', {
        roomCode: this.roomCode,
        sessionToken: this.sessionToken,
        seatToken: this.seatToken,
        playerName: this.playerName,
      }, false);
      this.startHeartbeat();
      this.render();
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch {
        this.lastError = 'Received an unreadable multiplayer message.';
        this.render();
      }
    });

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.stopHeartbeat();
      this.socket = null;
      if (this.intentionalClose) return;
      this.connectionState = 'disconnected';
      if (event?.reason) {
        this.lastError = event.reason;
      } else if (!this.lastError) {
        this.lastError = 'Disconnected from the multiplayer server. Reconnecting...';
      }
      this.scheduleReconnect();
      this.render();
    });

    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      this.lastError = 'Connection error while talking to the multiplayer server.';
      this.render();
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      this.socket.send(JSON.stringify({ type: 'heartbeat' }));
    }, 25_000);
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  disconnect() {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  nextRequestId() {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  send(type, payload = {}, withRequestId = true) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.lastError = 'The multiplayer connection is not ready.';
      this.render();
      return null;
    }

    const requestId = withRequestId ? this.nextRequestId() : null;
    this.socket.send(JSON.stringify({
      type,
      ...(requestId ? { requestId } : {}),
      ...payload,
    }));
    return requestId;
  }

  handleMessage(message = {}) {
    if (message.type === 'room_snapshot') {
      this.roomSnapshot = message;
      if (message.yourSession?.claimedSeatId != null && this.viewPlayerId == null) {
        this.viewPlayerId = message.yourSession.claimedSeatId;
      }
      this.render();
      return;
    }

    if (message.type === 'game_snapshot') {
      this.publicSnapshot = message;
      this.state = hydratePublicState(message.state || {});
      const controlledSeatId = this.getControlledSeatId();
      if (controlledSeatId != null && !Number.isInteger(this.viewPlayerId)) {
        this.viewPlayerId = controlledSeatId;
      }
      if (!Number.isInteger(this.viewPlayerId) || !this.state.players.some((player) => player.id === this.viewPlayerId)) {
        this.viewPlayerId = controlledSeatId ?? this.state.players[0]?.id ?? 0;
      }
      if (this.setupDialog && this.roomSnapshot?.status !== 'lobby') {
        this.setupDialog.style.display = 'none';
      }
      this.render();
      return;
    }

    if (message.type === 'private_snapshot') {
      this.privateSnapshot = message;
      if (message.seatToken) {
        this.seatToken = message.seatToken;
        this.persistSession();
      }
      this.render();
      return;
    }

    if (message.type === 'action_rejected') {
      this.lastError = message.reason || 'The server rejected that action.';
      this.render();
      return;
    }

    if (message.type === 'action_accepted') {
      this.lastError = '';
      this.render();
      return;
    }

    if (message.type === 'seat_disconnected' && message.reason === 'reclaimed') {
      this.lastError = 'This seat was reclaimed from another connection.';
      this.render();
      return;
    }

    if (message.type === 'game_over') {
      this.render();
      return;
    }

    if (message.type === 'phase_changed') {
      this.lastError = '';
      this.render();
    }
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
          this.uiState.panels[panelKey] = !(this.uiState.panels[panelKey] ?? true);
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

  renderConnectionBadge() {
    const badge = document.getElementById('connectionDisplay');
    if (!badge) return;

    const labels = {
      connecting: 'Connecting',
      connected: 'Connected',
      disconnected: 'Reconnecting',
    };

    badge.hidden = false;
    badge.textContent = labels[this.connectionState] || 'Connected';
    badge.className = `connection-badge ${this.connectionState}`;
  }

  renderTopBar() {
    if (!this.state) return;
    const roundEl = document.getElementById('roundDisplay');
    const phaseEl = document.getElementById('phaseDisplay');
    const invasionEl = document.getElementById('invasionDisplay');

    if (roundEl) roundEl.textContent = `Round ${this.state.round} / ${this.state.maxRounds}`;
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
      if (this.state.gameOver?.type === 'fall') {
        phaseEl.textContent = 'Empire Fallen';
        phaseEl.className = 'phase-badge phase-empire-fallen';
      } else {
        phaseEl.textContent = phaseNames[this.state.phase] || this.state.phase;
        phaseEl.className = `phase-badge phase-${this.state.phase}`;
      }
    }
    this.renderEmpireFallenBanner();

    if (invasionEl) {
      invasionEl.textContent = '';
      invasionEl.style.display = 'none';
    }
  }

  renderEmpireFallenBanner() {
    const topBar = document.getElementById('topBar');
    if (!topBar) return;
    let banner = document.getElementById('empireFallenBanner');

    if (this.state?.gameOver?.type !== 'fall') {
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
    if (!tabBar || !this.state) return;

    const administration = runAdministration(this.state);
    const controlledSeatId = this.getControlledSeatId();
    const seatMap = new Map((this.roomSnapshot?.seats || []).map((seat) => [seat.seatId, seat]));

    tabBar.innerHTML = this.state.players.map((player) => {
      const economy = getPlayerTabEconomy(player, administration);
      const seat = seatMap.get(player.id);
      const viewing = player.id === this.viewPlayerId;
      const youBadge = player.id === controlledSeatId ? '<span class="tab-you">You</span>' : '';
      const crown = player.id === this.state.basileusId ? '<span class="tab-crown" title="Basileus">B</span>' : '';
      const connectionBadge = seat?.status === 'disconnected' ? '<span class="tab-you">Away</span>' : '';
      return `
        <button class="player-tab ${viewing ? 'active' : ''}"
          data-player="${player.id}" style="${getPlayerStyleAttr(this.state, player.id)}">
          <span class="tab-body">
            <span class="tab-name">${player.dynasty}</span>
            ${renderPlayerTabFinance(economy)}
          </span>
          <span class="tab-flags">${youBadge}${connectionBadge}${crown}</span>
        </button>
      `;
    }).join('');

    tabBar.querySelectorAll('.player-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.viewPlayerId = Number.parseInt(tab.dataset.player || '0', 10);
        this.render();
      });
    });
  }

  isPanelOpen(panelKey, fallback = true) {
    const value = this.uiState.panels[panelKey];
    return value == null ? fallback : Boolean(value);
  }

  renderActionPanel() {
    const panel = document.getElementById('actionPanel');
    if (!panel || !this.state) return;

    const controlledSeatId = this.getControlledSeatId();
    const isOpen = this.isPanelOpen('action', true);
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

    panel.classList.toggle('panel-collapsed', !isOpen);
    panel.innerHTML = `
      <div class="sidebar-panel action-shell${isOpen ? '' : ' is-collapsed'}">
        <button class="sidebar-panel-head" type="button" data-ui-panel-toggle="action" aria-expanded="${isOpen}">
          <span class="sidebar-panel-head-copy">
            <span class="sidebar-panel-kicker">Phase Panel</span>
            <span class="sidebar-panel-title">${panelTitleByPhase[this.state.phase] || 'Action Panel'}</span>
            <span class="sidebar-panel-subtitle">${panelSubtitleByPhase[this.state.phase] || 'Current phase controls and details'}</span>
          </span>
        </button>
        ${isOpen ? '<div class="sidebar-panel-body" data-role="action-panel-body"></div>' : ''}
      </div>
    `;
    if (!isOpen) return;

    const body = panel.querySelector('[data-role="action-panel-body"]');
    if (!body) return;

    if (!controlledSeatId && this.state.phase !== 'scoring') {
      body.innerHTML = `<div class="panel-empty spectator-panel"><p>Claim a human seat in the lobby to control a dynasty.</p></div>`;
      return;
    }

    if (this.lastError) {
      body.innerHTML = `<div class="multiplayer-banner error">${this.lastError}</div>`;
    }

    const shell = document.createElement('div');
    body.appendChild(shell);

    if (this.state.phase === 'court') {
      renderCourtPanel(shell, this.state, controlledSeatId, {
        buy: (themeId) => this.send('court_action', { action: 'buy', themeId }),
        gift: (themeId) => this.send('court_action', { action: 'gift', themeId }),
        exempt: (themeId) => this.send('court_action', { action: 'exempt', themeId }),
        recruit: (_, data) => this.send('court_action', { action: 'recruit', office: data.office }),
        dismiss: (_, data) => this.send('court_action', { action: 'dismiss', office: data.office, count: data.count }),
        'confirm-court': () => this.send('confirm_court'),
        'basileus-appoint': (titleType, appointeeId, themeId) => this.send('court_action', {
          action: 'basileus-appoint',
          titleType,
          appointeeId,
          themeId,
        }),
        'appoint-strategos': (titleKey, themeId, appointeeId) => this.send('court_action', {
          action: 'appoint-strategos',
          titleKey,
          themeId,
          appointeeId,
        }),
        'appoint-bishop': (themeId, appointeeId) => this.send('court_action', {
          action: 'appoint-bishop',
          themeId,
          appointeeId,
        }),
        revoke: (value) => this.send('court_action', {
          action: 'revoke',
          value,
        }),
      }, {
        selectedProvinceId: this.selectedProvinceId,
        uiState: this.uiState,
      });
      return;
    }

    if (this.state.phase === 'orders') {
      renderOrdersPanel(shell, this.state, controlledSeatId, {
        lockOrders: (orders) => this.send('submit_orders', { orders }),
      }, {
        uiState: this.uiState,
      });
      return;
    }

    if (this.state.phase === 'resolution') {
      const controlledSeat = this.getControlledSeatId();
      const canAssignTitles = controlledSeat != null &&
        this.state.nextBasileusId !== this.state.basileusId &&
        controlledSeat === this.state.nextBasileusId &&
        !this.privateSnapshot?.pendingAiTitleAssignment;

      renderResolutionPanelDetailed(shell, this.state, {
        allowManualTitleReassignment: canAssignTitles,
      });

      const continueButton = shell.querySelector('[data-action="continue"]');
      const waitingForHumanReassignment = this.state.nextBasileusId !== this.state.basileusId &&
        this.state.pendingTitleReassignment &&
        controlledSeat !== this.state.nextBasileusId &&
        !this.privateSnapshot?.pendingAiTitleAssignment;

      if (continueButton) {
        if (canAssignTitles) {
          continueButton.textContent = this.isHost() ? 'Submit Titles' : 'Submit Titles';
          continueButton.addEventListener('click', () => {
            const assignments = {};
            shell.querySelectorAll('[data-title-assignment]').forEach((select) => {
              assignments[select.dataset.titleAssignment] = Number(select.value);
            });
            this.send('reassign_major_titles', { assignments });
          });
          return;
        }

        if (waitingForHumanReassignment) {
          continueButton.textContent = 'Waiting For New Basileus';
          continueButton.disabled = true;
          return;
        }

        if (!this.isHost()) {
          continueButton.textContent = 'Host Continues';
          continueButton.disabled = true;
          return;
        }

        continueButton.textContent = 'Continue';
        continueButton.addEventListener('click', () => {
          this.send('continue_after_resolution');
        });
      }
      return;
    }

    if (this.state.phase === 'scoring' || this.state.gameOver) {
      shell.innerHTML = this.renderScoringHtml();
      return;
    }

    shell.innerHTML = '<div class="panel-empty"><p>Waiting for the server...</p></div>';
  }

  renderScoringHtml() {
    const state = this.state;
    const adminResult = runAdministration(state);
    const scores = state.players.map((player) => {
      const projected = adminResult.income[player.id] || 0;
      const wealth = computeFullWealth(state, player.id, projected);
      return { player, wealth, gold: player.gold, projected };
    }).sort((left, right) => right.wealth - left.wealth);

    return `
      <div class="scoring-panel">
        <h3>Final Reckoning</h3>
        <div class="score-list">
          ${scores.map((score, index) => `
            <div class="score-row ${index === 0 ? 'winner' : ''}" style="--player-color: ${score.player.color}">
              <span class="score-rank">${index + 1}</span>
              <span class="score-dynasty">${renderPlayerRoleName(state, score.player)}</span>
              <span class="score-breakdown">${score.gold}g + ${score.projected} projected</span>
              <span class="score-total">${score.wealth}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  renderGameOverOverlay() {
    const overlay = document.getElementById('gameOverOverlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    overlay.style.display = 'none';
  }

  renderLobby() {
    if (!this.setupDialog || !this.roomSnapshot) return;
    const isHost = this.isHost();
    const seats = this.roomSnapshot.seats || [];
    const config = this.roomSnapshot.config || {};
    const controlledSeatId = this.getControlledSeatId();

    this.setupDialog.style.display = 'flex';
    this.setupDialog.innerHTML = `
      <div class="setup-card multiplayer-lobby-card">
        <h1>BASILEUS</h1>
        <p class="setup-subtitle">Private live room</p>
        <div class="multiplayer-room-meta">
          <div><strong>Room code:</strong> <span class="room-code">${this.roomSnapshot.roomCode}</span></div>
          <div><strong>Status:</strong> ${this.connectionState === 'connected' ? 'Connected' : this.connectionState}</div>
          <div><strong>You:</strong> ${this.playerName}</div>
        </div>
        ${this.lastError ? `<div class="multiplayer-banner error">${this.lastError}</div>` : ''}
        <div class="setup-field">
          <label>Players</label>
          ${isHost ? `
            <select id="roomPlayerCount">
              ${[3, 4, 5].map((count) => `<option value="${count}" ${count === config.playerCount ? 'selected' : ''}>${count} players</option>`).join('')}
            </select>
          ` : `<div class="setup-hint">${config.playerCount} players</div>`}
        </div>
        <div class="setup-field">
          <label>Game Length</label>
          ${isHost ? `
            <select id="roomDeckSize">
              ${[6, 9, 12].map((count) => `<option value="${count}" ${count === config.deckSize ? 'selected' : ''}>${count} invasions</option>`).join('')}
            </select>
          ` : `<div class="setup-hint">${config.deckSize} invasions</div>`}
        </div>
        <div class="setup-field">
          <label>Seed</label>
          ${isHost ? `<input type="text" id="roomSeedInput" value="${config.seed || ''}" placeholder="Leave blank for random">`
            : `<div class="setup-hint">${config.seed || 'Random on start'}</div>`}
        </div>
        <div class="setup-field">
          <label>Seats</label>
          <div class="multiplayer-seat-list">
            ${seats.map((seat) => `
              <div class="multiplayer-seat ${seat.isViewerSeat ? 'is-you' : ''}">
                <div class="multiplayer-seat-copy">
                  <strong>Seat ${seat.seatId + 1}</strong>
                  <span>${seat.dynasty || (seat.kind === 'ai' ? 'AI seat' : 'Awaiting dynasty')}</span>
                  <span class="setup-hint">${seat.playerName || (seat.kind === 'ai' ? 'AI-controlled' : 'Open human seat')} - ${seat.status}</span>
                </div>
                <div class="multiplayer-seat-actions">
                  ${seat.kind === 'human' && !seat.claimed ? `
                    <button class="btn-start btn-claim-seat" data-seat-id="${seat.seatId}">Claim</button>
                  ` : ''}
                  ${isHost && !seat.claimed ? `
                    <button class="btn-secondary-link btn-seat-kind" type="button" data-seat-id="${seat.seatId}" data-kind="${seat.kind === 'ai' ? 'human' : 'ai'}">
                      ${seat.kind === 'ai' ? 'Set Human' : 'Set AI'}
                    </button>
                  ` : ''}
                  ${seat.isViewerSeat ? '<span class="setup-hint">You</span>' : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="setup-actions">
          ${isHost ? `<button class="btn-start" id="btnStartRoom" ${this.roomSnapshot.canStart ? '' : 'disabled'}>Start Match</button>` : '<span class="setup-hint">Waiting for host to start the match.</span>'}
          <button class="btn-secondary-link" type="button" id="btnLeaveRoom">${controlledSeatId != null && !isHost ? 'Leave Seat' : 'Close Connection'}</button>
        </div>
      </div>
    `;

    this.setupDialog.querySelectorAll('.btn-claim-seat').forEach((button) => {
      button.addEventListener('click', () => {
        this.send('claim_seat', { seatId: Number(button.dataset.seatId), playerName: this.playerName });
      });
    });

    this.setupDialog.querySelectorAll('.btn-seat-kind').forEach((button) => {
      button.addEventListener('click', () => {
        this.send('set_seat_kind', {
          seatId: Number(button.dataset.seatId),
          kind: button.dataset.kind,
        });
      });
    });

    this.setupDialog.querySelector('#btnStartRoom')?.addEventListener('click', () => {
      const playerCount = Number(this.setupDialog.querySelector('#roomPlayerCount')?.value || config.playerCount || 4);
      const deckSize = Number(this.setupDialog.querySelector('#roomDeckSize')?.value || config.deckSize || 9);
      const seed = this.setupDialog.querySelector('#roomSeedInput')?.value?.trim() || '';
      this.send('set_room_config', {
        config: { playerCount, deckSize, seed },
      });
      this.send('start_game');
    });

    this.setupDialog.querySelector('#btnLeaveRoom')?.addEventListener('click', () => {
      if (!isHost && controlledSeatId != null) {
        this.send('leave_room');
        this.clearSession();
      }
      this.disconnect();
      window.location.reload();
    });
  }

  async ensureMap() {
    if (document.getElementById('gameMap')) return;
    await createMapSVG('mapContainer', {
      onProvinceSelect: (provinceId) => {
        this.selectedProvinceId = provinceId;
        this.render();
      },
    });
  }

  renderGame() {
    if (!this.state) return;
    this.ensureMap().then(() => {
      this.renderTopBar();
      this.renderConnectionBadge();
      updateMapState(this.state);
      setSelectedProvince(this.selectedProvinceId);
      drawInvasionRoute(this.state.currentInvasion);
      renderPlayerDashboard(
        document.getElementById('playerDashboard'),
        this.state,
        this.viewPlayerId,
        this.selectedProvinceId,
        {
          aiMeta: null,
          uiState: this.uiState,
        },
      );
      renderHistoryPanel(document.getElementById('historyPanel'), this.state, {
        aiMeta: null,
        uiState: this.uiState,
      });
      this.renderPlayerTabs();
      this.renderActionPanel();
      this.bindUiChrome();
      this.renderGameOverOverlay();
    });
  }

  render() {
    if (this.roomSnapshot?.status === 'lobby' || !this.publicSnapshot) {
      this.renderLobby();
      return;
    }
    this.renderGame();
  }
}
