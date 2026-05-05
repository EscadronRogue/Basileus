import { hydratePublicState } from '../engine/publicState.js';
import { createMapSVG } from '../render/mapRenderer.js';
import {
  createDefaultUiState,
  renderGameActionPanel,
  renderGameFrame,
  renderHiddenGameOverOverlay,
  renderPlayerTabs,
} from './sharedView.js';

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
    const message = response.status === 404 && String(path).startsWith('/api/rooms')
      ? 'This server does not have the multiplayer backend yet. Stop the current local server and start it again.'
      : body?.error || 'Request failed.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function joinRoomPayload(roomCode, playerName, stored) {
  try {
    return await requestJson(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
      playerName,
    });
  } catch (error) {
    if (error?.status !== 409 || !stored?.seatToken) throw error;
    return requestJson(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
      playerName,
      seatToken: stored.seatToken,
    });
  }
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
    ? await joinRoomPayload(roomCode, playerName, stored)
    : await requestJson('/api/rooms', {
      playerName,
      config: options.config || {},
    });

  const controller = new MultiplayerController({
    setupDialog: options.setupDialog,
    roomCode: payload.roomCode,
    playerName,
    sessionToken: payload.sessionToken,
    seatToken: payload.seatToken || '',
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
    this.viewPlayerId = null;
    this.socket = null;
    this.connectionState = 'connecting';
    this.lastError = '';
    this.requestSeq = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.intentionalClose = false;
    this.uiState = createDefaultUiState();
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
      this.seatToken = message.seatToken || '';
      this.persistSession();
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

  renderPlayerTabs() {
    const controlledSeatId = this.getControlledSeatId();
    const seatMap = new Map((this.roomSnapshot?.seats || []).map((seat) => [seat.seatId, seat]));
    renderPlayerTabs({
      state: this.state,
      activePlayerId: this.viewPlayerId,
      onSelectPlayer: (playerId) => {
        this.viewPlayerId = playerId;
        this.render();
      },
      getBadges: (player) => {
        const badges = [];
        const seat = seatMap.get(player.id);
        if (player.id === controlledSeatId) badges.push('<span class="tab-you">You</span>');
        if (seat?.status === 'disconnected') badges.push('<span class="tab-you">Away</span>');
        return badges;
      },
    });
  }

  renderActionPanel() {
    const controlledSeatId = this.getControlledSeatId();
    const state = this.state;
    if (!state) return;

    const waitingForHumanReassignment = state.phase === 'resolution'
      && state.nextBasileusId !== state.basileusId
      && state.pendingTitleReassignment
      && controlledSeatId !== state.nextBasileusId
      && !this.privateSnapshot?.pendingAiTitleAssignment;

    const canAssignTitles = state.phase === 'resolution'
      && controlledSeatId != null
      && state.nextBasileusId !== state.basileusId
      && controlledSeatId === state.nextBasileusId
      && !this.privateSnapshot?.pendingAiTitleAssignment;

    const resolution = {};
    if (canAssignTitles) {
      resolution.allowManualTitleReassignment = true;
      resolution.submitText = 'Submit Titles';
      resolution.submitTitleAssignments = (assignments) => this.send('reassign_major_titles', { assignments });
    } else if (waitingForHumanReassignment) {
      resolution.disabledText = 'Waiting For New Basileus';
    } else if (!this.isHost() && state.phase === 'resolution') {
      resolution.disabledText = 'Host Continues';
    } else {
      resolution.continue = () => this.send('continue_after_resolution');
    }

    renderGameActionPanel({
      panel: document.getElementById('actionPanel'),
      state,
      uiState: this.uiState,
      activePlayerId: controlledSeatId ?? this.viewPlayerId,
      selectedProvinceId: this.selectedProvinceId,
      canControl: controlledSeatId != null || state.phase === 'scoring',
      spectatorMessage: 'Claim a human seat in the lobby to control a dynasty.',
      error: this.lastError,
      handlers: {
        court: this.createCourtHandlers(),
        lockOrders: (orders) => this.send('submit_orders', { orders }),
      },
      resolution,
    });
  }

  createCourtHandlers() {
    return {
      buy: (themeId) => this.send('court_action', { action: 'buy', themeId }),
      gift: (themeId) => this.send('court_action', { action: 'gift', themeId }),
      exempt: (themeId) => this.send('court_action', { action: 'exempt', themeId }),
      recruit: (_, data) => this.send('court_action', { action: 'recruit', office: data.office }),
      dismiss: (_, data) => this.send('court_action', { action: 'dismiss', office: data.office, count: data.count }),
      'hire-mercs': (_, data) => this.send('court_action', { action: 'hire-mercs', count: data.count }),
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
    };
  }

  renderGameOverOverlay() {
    renderHiddenGameOverOverlay();
  }

  renderLobby() {
    if (!this.setupDialog || !this.roomSnapshot) return;
    const isHost = this.isHost();
    const seats = this.roomSnapshot.seats || [];
    const config = this.roomSnapshot.config || {};
    const controlledSeatId = this.getControlledSeatId();
    const previousCard = this.setupDialog.querySelector('.setup-card');
    const previousDialogScrollTop = this.setupDialog.scrollTop;
    const previousCardScrollTop = previousCard?.scrollTop ?? 0;

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
                  <span>${seat.dynasty || (seat.kind === 'ai' ? 'AI seat' : (seat.claimed ? 'Human dynasty claimed' : 'Awaiting dynasty'))}</span>
                  <span class="setup-hint">${seat.isViewerSeat ? 'You' : (seat.playerName || (seat.kind === 'ai' ? 'AI-controlled' : 'Open human seat'))} - ${seat.status}</span>
                </div>
                <div class="multiplayer-seat-actions">
                  ${seat.kind === 'human' && !seat.claimed && controlledSeatId == null ? `
                    <button class="btn-start btn-claim-seat" type="button" data-seat-id="${seat.seatId}">Claim</button>
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
          ${isHost && controlledSeatId == null ? '<span class="setup-hint">Claim one human seat before starting the match.</span>' : ''}
          ${isHost ? `<button class="btn-start" type="button" id="btnStartRoom" ${this.roomSnapshot.canStart ? '' : 'disabled'}>Start Match</button>` : '<span class="setup-hint">Waiting for host to start the match.</span>'}
          <button class="btn-secondary-link" type="button" id="btnLeaveRoom">${controlledSeatId != null ? 'Leave Seat' : 'Close Connection'}</button>
        </div>
      </div>
    `;

    const restoreLobbyScroll = () => {
      this.setupDialog.scrollTop = previousDialogScrollTop;
      const nextCard = this.setupDialog.querySelector('.setup-card');
      if (nextCard) nextCard.scrollTop = previousCardScrollTop;
    };
    restoreLobbyScroll();
    window.requestAnimationFrame?.(restoreLobbyScroll);

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
      if (controlledSeatId != null) {
        this.send('leave_room');
        return;
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
      renderGameFrame({
        state: this.state,
        activePlayerId: this.viewPlayerId,
        selectedProvinceId: this.selectedProvinceId,
        uiState: this.uiState,
        aiMeta: null,
        renderTabs: () => this.renderPlayerTabs(),
        renderActionPanel: () => this.renderActionPanel(),
        renderConnectionBadge: () => this.renderConnectionBadge(),
        renderGameOverOverlay: () => this.renderGameOverOverlay(),
        rerender: () => this.render(),
      });
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
