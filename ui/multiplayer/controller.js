// ui/multiplayer/controller.js - live WebSocket connection, keepalives, and in-game rendering.

import { hydratePublicState } from '../../engine/publicState.js';
import { createMapSVG, focusProvince, getRenderedMapId, setHoveredProvince } from '../../render/mapRenderer.js';
import {
  applyProvinceInterfaceState,
  createDefaultUiState,
  getPhaseRenderKey,
  renderGameActionPanel,
  renderGameFrame,
  renderHiddenGameOverOverlay,
  renderPlayerTabs,
  scrollPhasePanelIntoView,
} from '../sharedView.js';
import { escapeHtml } from '../html.js';
import {
  ACTIVE_ROOM_KEEPALIVE_MS,
  FINISHED_ROOM_KEEPALIVE_MS,
  HEARTBEAT_INTERVAL_MS,
  HTTP_KEEPALIVE_INTERVAL_MS,
  ROOM_CODE_PATTERN,
  buildWebSocketUrl,
  clearMultiplayerSession,
  joinRoomPayload,
  maxTimestampMs,
  normalizeRoomCode,
  parseTimestampMs,
  requestJson,
  resolveApiUrl,
  saveMultiplayerSession,
} from './connection.js';
import { dynastyNameForSeat, renderMultiplayerLobby } from './lobby.js';
import { addEstateToDraft } from '../panels/estates.js';
import { setGlossaryMap } from '../glossary.js';

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
  const payload = intent === 'join'
    ? await joinRoomPayload(roomCode, playerName)
    : await requestJson('/api/rooms', {
      playerName,
      config: options.config || {},
      saveGame: options.saveGame || null,
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
    this.hoveredProvinceId = null;
    this.viewPlayerId = null;
    this.socket = null;
    this.connectionState = 'connecting';
    this.lastError = '';
    this.requestSeq = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.httpKeepaliveTimer = null;
    this.httpKeepaliveInFlight = false;
    this.localPlayerActivityAtMs = 0;
    this.localFinishedAtMs = 0;
    this.intentionalClose = false;
    this.uiState = createDefaultUiState();
    this.lastPhaseKey = null;
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
      this.updateHeartbeatSchedule();
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
      this.stopKeepalives();
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
    if (!this.shouldKeepHeartbeatAlive()) return;
    this.sendHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  startHttpKeepalive() {
    this.stopHttpKeepalive();
    if (!this.shouldKeepHeartbeatAlive()) return;
    this.sendHttpKeepalive();
    this.httpKeepaliveTimer = window.setInterval(() => {
      this.sendHttpKeepalive();
    }, HTTP_KEEPALIVE_INTERVAL_MS);
  }

  stopHttpKeepalive() {
    if (!this.httpKeepaliveTimer) return;
    window.clearInterval(this.httpKeepaliveTimer);
    this.httpKeepaliveTimer = null;
  }

  stopKeepalives() {
    this.stopHeartbeat();
    this.stopHttpKeepalive();
  }

  sendHeartbeat() {
    if (!this.shouldKeepHeartbeatAlive()) {
      this.stopKeepalives();
      return;
    }
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'heartbeat',
      roomCode: this.roomCode,
      sentAt: new Date().toISOString(),
    }));
  }

  async sendHttpKeepalive(now = Date.now()) {
    if (!this.shouldKeepHeartbeatAlive(now)) {
      this.stopKeepalives();
      return;
    }
    if (typeof fetch !== 'function' || this.httpKeepaliveInFlight) return;

    this.httpKeepaliveInFlight = true;
    try {
      await fetch(resolveApiUrl(`/healthz?keepalive=${Math.trunc(now)}`), {
        method: 'GET',
        credentials: 'omit',
      });
    } catch {
      // The request still wakes Render even if the browser blocks the response.
    } finally {
      this.httpKeepaliveInFlight = false;
    }
  }

  updateHeartbeatSchedule() {
    if (typeof WebSocket === 'undefined' || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.shouldKeepHeartbeatAlive()) {
      if (!this.heartbeatTimer) this.startHeartbeat();
      if (!this.httpKeepaliveTimer) this.startHttpKeepalive();
      return;
    }
    this.stopKeepalives();
  }

  noteLocalPlayerActivity(now = Date.now()) {
    this.localPlayerActivityAtMs = Math.max(this.localPlayerActivityAtMs, now);
    this.updateHeartbeatSchedule();
  }

  noteRoomFinished(finishedAt = null, now = Date.now()) {
    const parsedFinishedAt = parseTimestampMs(finishedAt);
    if (parsedFinishedAt) {
      this.localFinishedAtMs = parsedFinishedAt;
    } else if (!this.localFinishedAtMs) {
      this.localFinishedAtMs = now;
    }
    this.updateHeartbeatSchedule();
  }

  isRoomFinished() {
    return this.roomSnapshot?.status === 'finished'
      || this.publicSnapshot?.status === 'finished'
      || Boolean(this.state?.gameOver)
      || this.state?.phase === 'scoring';
  }

  getLastRoomActivityAtMs(now = Date.now()) {
    return Math.max(
      maxTimestampMs(this.roomSnapshot?.createdAt, this.roomSnapshot?.updatedAt),
      maxTimestampMs(this.publicSnapshot?.createdAt, this.publicSnapshot?.updatedAt),
      this.localPlayerActivityAtMs,
      now && !this.roomSnapshot && !this.publicSnapshot ? now : 0,
    );
  }

  getRoomFinishedAtMs(now = Date.now()) {
    const snapshotFinishedAt = maxTimestampMs(this.roomSnapshot?.finishedAt, this.publicSnapshot?.finishedAt);
    if (snapshotFinishedAt) return snapshotFinishedAt;
    if (!this.isRoomFinished()) return 0;
    if (!this.localFinishedAtMs) this.localFinishedAtMs = now;
    return this.localFinishedAtMs;
  }

  getHeartbeatDeadlineMs(now = Date.now()) {
    if (this.isRoomFinished()) {
      return this.getRoomFinishedAtMs(now) + FINISHED_ROOM_KEEPALIVE_MS;
    }
    return this.getLastRoomActivityAtMs(now) + ACTIVE_ROOM_KEEPALIVE_MS;
  }

  shouldKeepHeartbeatAlive(now = Date.now()) {
    return now <= this.getHeartbeatDeadlineMs(now);
  }

  disconnect() {
    this.intentionalClose = true;
    this.stopKeepalives();
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
    if (type !== 'heartbeat') this.noteLocalPlayerActivity();
    return requestId;
  }

  handleMessage(message = {}) {
    if (message.type === 'room_snapshot') {
      this.roomSnapshot = message;
      if (message.status === 'finished') this.noteRoomFinished(message.finishedAt);
      else this.updateHeartbeatSchedule();
      if (message.yourSession?.claimedSeatId != null && this.viewPlayerId == null) {
        this.viewPlayerId = message.yourSession.claimedSeatId;
      }
      this.render();
      return;
    }

    if (message.type === 'game_snapshot') {
      this.publicSnapshot = message;
      this.state = hydratePublicState(message.state || {});
      if (message.status === 'finished' || this.state.gameOver || this.state.phase === 'scoring') {
        this.noteRoomFinished(message.finishedAt);
      } else {
        this.updateHeartbeatSchedule();
      }
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

    if (message.type === 'room_save') {
      this.downloadSaveFile(message.save, message.filename);
      this.lastError = '';
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
      this.lastError = 'This dynasty was reclaimed from another connection.';
      this.render();
      return;
    }

    if (message.type === 'game_over') {
      this.noteRoomFinished(message.finishedAt);
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

    const waitingForHumanReassignment = state.phase === 'title_redistribution'
      && controlledSeatId !== state.nextBasileusId
      && !this.privateSnapshot?.pendingAiTitleAssignment;

    const canAssignTitles = state.phase === 'title_redistribution'
      && controlledSeatId != null
      && controlledSeatId === state.basileusId
      && !this.privateSnapshot?.pendingAiTitleAssignment;

    const resolution = {};
    if (waitingForHumanReassignment) {
      resolution.disabledText = 'Waiting For New Basileus';
    } else if (!this.isHost() && state.phase === 'resolution' && this.roomSnapshot?.hostConnected !== false) {
      resolution.disabledText = 'Host Continues';
    } else {
      resolution.continue = () => this.send('continue_after_resolution');
    }

    const body = renderGameActionPanel({
      panel: document.getElementById('actionPanel'),
      state,
      uiState: this.uiState,
      activePlayerId: controlledSeatId ?? this.viewPlayerId,
      selectedProvinceId: this.selectedProvinceId,
      privateData: this.privateSnapshot || null,
      canControl: controlledSeatId != null || state.phase === 'scoring',
      spectatorMessage: 'Claim a human dynasty in the lobby to control it.',
      error: this.lastError,
      handlers: {
        court: this.createCourtHandlers(),
        estates: this.createEstateHandlers(),
        confirmEstates: () => this.send('confirm_estates'),
        confirmTitleRedistribution: canAssignTitles
          ? (assignments) => this.send('reassign_major_titles', { assignments })
          : null,
        lockOrders: (orders) => this.send('submit_orders', { orders }),
      },
      resolution,
    });
    this.renderMultiplayerRecoveryControls(body);
  }

  getClaimableHumanSeats() {
    const controlledSeatId = this.getControlledSeatId();
    if (controlledSeatId != null || this.roomSnapshot?.status !== 'in_progress') return [];
    return (this.roomSnapshot?.seats || []).filter((seat) =>
      seat.kind === 'human' && !seat.connected
    );
  }

  renderMultiplayerRecoveryControls(body) {
    if (!body || !this.publicSnapshot) return;
    const claimableSeats = this.getClaimableHumanSeats();
    const seatButtons = claimableSeats.map((seat) => {
      const dynasty = dynastyNameForSeat(seat);
      const status = seat.status === 'disconnected' ? 'Away' : 'Open';
      return `
        <button class="btn-secondary btn-live-claim-seat" type="button" data-seat-id="${seat.seatId}">
          Claim ${escapeHtml(dynasty)} (${status})
        </button>
      `;
    }).join('');

    const section = document.createElement('div');
    section.className = 'multiplayer-recovery-controls';
    section.innerHTML = `
      ${claimableSeats.length ? `
        <div class="multiplayer-banner">
          <strong>Rejoin Control</strong>
          <span>Choose an open or disconnected human dynasty to control it.</span>
          <div class="setup-actions">${seatButtons}</div>
        </div>
      ` : ''}
      <details class="multiplayer-banner multiplayer-save-fold">
        <summary>
          <strong>Recovery Save</strong>
          <span>Download the full server state if the host service restarts.</span>
        </summary>
        <div class="setup-actions multiplayer-save-actions">
          <button class="btn-secondary btn-save" type="button" data-action="save-multiplayer-room">Save Match</button>
        </div>
      </details>
    `;
    body.appendChild(section);

    section.querySelectorAll('.btn-live-claim-seat').forEach((button) => {
      button.addEventListener('click', () => {
        this.send('claim_seat', {
          seatId: Number(button.dataset.seatId),
          playerName: this.playerName,
        });
      });
    });

    section.querySelector('[data-action="save-multiplayer-room"]')?.addEventListener('click', () => {
      this.send('request_save');
    });
  }

  downloadSaveFile(save, filename = '') {
    if (!save || typeof Blob === 'undefined' || typeof document === 'undefined') return;
    const safeFilename = String(filename || `basileus-${this.roomCode}.json`)
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      || `basileus-${this.roomCode}.json`;
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safeFilename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  createCourtHandlers() {
    return {
      'deal-send': (payload) => this.send('court_action', { action: 'deal-send', ...payload }),
      'deal-counter': (payload) => this.send('court_action', { action: 'deal-counter', ...payload }),
      'deal-accept': (payload) => this.send('court_action', { action: 'deal-accept', ...payload }),
      'deal-refuse': (payload) => this.send('court_action', { action: 'deal-refuse', ...payload }),
      'confirm-court': () => this.send('confirm_court'),
      'submit-court-plan': ({ actions = [], passPowers = [] } = {}) => {
        actions.forEach((action) => this.send('court_action', action));
        passPowers.forEach((powerKey) => this.send('court_action', {
          action: 'pass-court-power',
          powerKey,
        }));
        if (!actions.length && !passPowers.length) this.send('confirm_court');
      },
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
      'pass-court-power': (powerKey) => this.send('court_action', {
        action: 'pass-court-power',
        powerKey,
      }),
    };
  }

  createEstateHandlers() {
    return {
      // The whole plan is sent once, then the dynasty locks.
      submitEstatePlan: ({ plan = {} } = {}) => {
        this.send('estate_action', { action: 'plan', plan });
        this.send('confirm_estates');
      },
    };
  }

  renderGameOverOverlay() {
    renderHiddenGameOverOverlay();
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

  renderLobby() {
    renderMultiplayerLobby(this);
  }

  async ensureMap() {
    setGlossaryMap(this.state?.mapId);
    if (document.getElementById('gameMap') && getRenderedMapId() === (this.state?.mapId || 'classic')) return;
    await createMapSVG('mapContainer', {
      mapId: this.state?.mapId,
      mapFilter: this.uiState.mapFilter,
      onMapFilterChange: (filterId) => {
        this.uiState.mapFilter = filterId;
        this.renderGame();
      },
      onProvinceSelect: (provinceId) => {
        // During Estates a map click also plans an estate there.
        const seatId = this.getControlledSeatId();
        if (seatId != null) addEstateToDraft(this.uiState, this.state, seatId, provinceId);
        this.selectProvince(provinceId);
      },
      onProvinceHover: (provinceId) => {
        this.previewProvince(provinceId, { fromMap: true });
      },
    });
  }

  renderGame() {
    const state = this.state;
    if (!state) return;
    const phaseKey = getPhaseRenderKey(state);
    const phaseChanged = phaseKey !== this.lastPhaseKey;
    if (phaseChanged) {
      this.uiState.panels.action = true;
    }
    this.ensureMap().then(() => {
      if (this.state !== state) return;
      renderGameFrame({
        state,
        activePlayerId: this.viewPlayerId,
        selectedProvinceId: this.selectedProvinceId,
        hoveredProvinceId: this.hoveredProvinceId,
        uiState: this.uiState,
        aiMeta: null,
        privateData: this.privateSnapshot || null,
        notificationScopeKey: `room:${this.roomCode || 'local'}:${this.privateSnapshot?.seatId ?? this.viewPlayerId ?? 'spectator'}`,
        renderTabs: () => this.renderPlayerTabs(),
        renderActionPanel: () => this.renderActionPanel(),
        renderConnectionBadge: () => this.renderConnectionBadge(),
        renderGameOverOverlay: () => this.renderGameOverOverlay(),
        onSelectProvince: (provinceId) => this.selectProvince(provinceId, { focusMap: true }),
        onHoverProvince: (provinceId) => this.previewProvince(provinceId),
        rerender: () => this.render(),
        mapActions: {
          playerId: this.getControlledSeatId(),
          canControl: this.getControlledSeatId() != null,
        },
      });
      if (phaseChanged) {
        const initialPhase = this.lastPhaseKey === null;
        this.lastPhaseKey = phaseKey;
        scrollPhasePanelIntoView({ initial: initialPhase });
      }
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
