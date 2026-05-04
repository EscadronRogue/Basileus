import assert from 'node:assert/strict';

import { createGameState, getPlayer, formatPlayerLabel } from '../engine/state.js';
import {
  handleContinueAfterResolution,
  handleHumanCourtAction,
  handleHumanCourtConfirmation,
  handleHumanOrders,
  handleManualTitleReassignment,
  startInteractiveRuntime,
} from '../engine/runtime.js';
import { clonePlain, serializePublicGameState } from '../engine/publicState.js';
import { DEFAULT_ROOM_CONFIG, normalizeRoomConfig, pickRandom, resolveConfiguredSeed, toInt } from '../engine/setup.js';
import { createAIMeta } from '../ai/brain.js';
import { getAiDisplayName } from '../ai/names.js';
import { normalizeAiProfile } from '../ai/profileStore.js';

export const ROOM_STATUS = {
  LOBBY: 'lobby',
  IN_PROGRESS: 'in_progress',
  FINISHED: 'finished',
};

function normalizeTrainedAiProfiles(rawProfiles = []) {
  if (!Array.isArray(rawProfiles)) return [];
  const profiles = [];
  const seen = new Set();
  for (const rawProfile of rawProfiles) {
    const profile = normalizeAiProfile(rawProfile);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  return profiles;
}

function createOpenSeat(seatId) {
  return {
    seatId,
    kind: 'human',
    playerName: null,
    sessionId: null,
    seatToken: null,
    connected: false,
  };
}

function getSeatStatus(seat) {
  if (seat.kind === 'ai') return 'ai';
  if (!seat.sessionId) return 'open';
  return seat.connected ? 'connected' : 'disconnected';
}

function createSeatSummary(room, seat, viewerSessionId) {
  const isViewerSeat = seat.sessionId != null && seat.sessionId === viewerSessionId;
  return {
    seatId: seat.seatId,
    kind: seat.kind,
    status: getSeatStatus(seat),
    claimed: seat.sessionId != null,
    connected: seat.connected,
    playerName: seat.kind === 'ai'
      ? seat.playerName || `AI Seat ${seat.seatId + 1}`
      : seat.playerName,
    isHostSeat: seat.sessionId != null && seat.sessionId === room.hostSessionId,
    isViewerSeat,
    dynasty: room.gameState ? (formatPlayerLabel(getPlayer(room.gameState, seat.seatId)) || null) : null,
  };
}

function getHumanSeatIds(room) {
  return room.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.seatId);
}

function getAiSeatIds(room) {
  return room.seats.filter((seat) => seat.kind === 'ai').map((seat) => seat.seatId);
}

export class MultiplayerRoom {
  constructor({ roomCode, hostSessionId, hostPlayerName, config = {} }) {
    this.roomCode = roomCode;
    this.hostSessionId = hostSessionId;
    this.config = normalizeRoomConfig(config);
    this.trainedAiProfiles = normalizeTrainedAiProfiles(config.aiProfiles);
    this.seats = Array.from({ length: this.config.playerCount }, (_, seatId) => createOpenSeat(seatId));
    this.connections = new Map();
    this.sessions = new Map();
    this.status = ROOM_STATUS.LOBBY;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.gameState = null;
    this.aiMeta = null;
    this.pendingAiTitleAssignment = null;
    this.gameOverSent = false;

    this.ensureSession(hostSessionId, hostPlayerName);
    this.claimSeat(hostSessionId, 0, hostPlayerName);
  }

  touch() {
    this.updatedAt = new Date().toISOString();
  }

  ensureSession(sessionId, playerName) {
    const existing = this.sessions.get(sessionId) || {};
    const next = {
      sessionId,
      playerName: String(playerName || existing.playerName || 'Guest').trim() || 'Guest',
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, next);
    return next;
  }

  findSeatBySession(sessionId) {
    return this.seats.find((seat) => seat.sessionId === sessionId) || null;
  }

  findSeatByToken(seatToken) {
    return this.seats.find((seat) => seat.seatToken && seat.seatToken === seatToken) || null;
  }

  isHostSession(sessionId) {
    return sessionId === this.hostSessionId;
  }

  canStartGame() {
    if (this.status !== ROOM_STATUS.LOBBY) return false;
    return this.seats.every((seat) => seat.kind === 'ai' || seat.sessionId != null);
  }

  claimSeat(sessionId, seatId, playerName) {
    assert(this.status === ROOM_STATUS.LOBBY, 'Seats can only be claimed in the lobby.');
    const seat = this.seats[seatId];
    assert(seat, 'Seat not found.');
    assert(seat.kind === 'human', 'Seat is AI-controlled.');
    const currentSeat = this.findSeatBySession(sessionId);
    assert(!currentSeat || currentSeat.seatId === seatId, 'You already control another seat.');
    assert(seat.sessionId == null || seat.sessionId === sessionId, 'Seat is already claimed.');

    const session = this.ensureSession(sessionId, playerName);
    seat.playerName = session.playerName;
    seat.sessionId = sessionId;
    seat.seatToken = seat.seatToken || crypto.randomUUID();
    seat.connected = this.connections.has(sessionId);
    this.touch();
    return { seatId: seat.seatId, seatToken: seat.seatToken };
  }

  reclaimSeat(sessionId, seatToken, playerName) {
    const seat = this.findSeatByToken(String(seatToken || '').trim());
    assert(seat, 'Seat reclaim token is invalid.');
    const previousSessionId = seat.sessionId;
    const currentSeat = this.findSeatBySession(sessionId);
    assert(!currentSeat || currentSeat.seatId === seat.seatId, 'This session already controls another seat.');

    this.ensureSession(sessionId, playerName);
    seat.playerName = String(playerName || seat.playerName || 'Guest').trim() || 'Guest';
    seat.sessionId = sessionId;
    seat.connected = this.connections.has(sessionId);
    if (previousSessionId && previousSessionId !== sessionId) {
      const previousConnection = this.connections.get(previousSessionId);
      previousConnection?.sendJson({
        type: 'seat_disconnected',
        roomCode: this.roomCode,
        seatId: seat.seatId,
        reason: 'reclaimed',
      });
      previousConnection?.close();
      if (this.hostSessionId === previousSessionId) {
        this.hostSessionId = sessionId;
      }
    }

    if (this.hostSessionId === previousSessionId) {
      this.hostSessionId = sessionId;
    }

    this.touch();
    return { seatId: seat.seatId, seatToken: seat.seatToken };
  }

  releaseLobbySeat(sessionId) {
    assert(this.status === ROOM_STATUS.LOBBY, 'Seats can only be released in the lobby.');
    assert(!this.isHostSession(sessionId), 'The host seat cannot be released.');
    const seat = this.findSeatBySession(sessionId);
    assert(seat, 'You do not control a seat.');
    seat.playerName = null;
    seat.sessionId = null;
    seat.seatToken = null;
    seat.connected = false;
    this.touch();
    return seat;
  }

  setSeatKind(sessionId, seatId, kind) {
    assert(this.status === ROOM_STATUS.LOBBY, 'Seat types can only be changed in the lobby.');
    assert(this.isHostSession(sessionId), 'Only the host can change seat types.');
    assert(kind === 'human' || kind === 'ai', 'Seat type must be human or ai.');

    const seat = this.seats[seatId];
    assert(seat, 'Seat not found.');
    assert(seat.sessionId == null, 'Claimed seats cannot change type.');

    seat.kind = kind;
    seat.playerName = kind === 'ai' ? `AI Seat ${seatId + 1}` : null;
    seat.connected = false;
    seat.seatToken = null;
    this.touch();
    return seat;
  }

  setRoomConfig(sessionId, rawPatch = {}) {
    assert(this.status === ROOM_STATUS.LOBBY, 'Room settings can only change in the lobby.');
    assert(this.isHostSession(sessionId), 'Only the host can change room settings.');

    const nextConfig = normalizeRoomConfig({ ...this.config, ...rawPatch });
    if (nextConfig.playerCount < this.seats.length) {
      const removedSeats = this.seats.slice(nextConfig.playerCount);
      const hasClaimedSeat = removedSeats.some((seat) => seat.sessionId != null);
      assert(!hasClaimedSeat, 'Cannot remove a claimed seat from the room.');
      this.seats = this.seats.slice(0, nextConfig.playerCount);
    } else if (nextConfig.playerCount > this.seats.length) {
      for (let seatId = this.seats.length; seatId < nextConfig.playerCount; seatId += 1) {
        this.seats.push(createOpenSeat(seatId));
      }
    }

    this.config = nextConfig;
    this.touch();
    return this.config;
  }

  async startGame(sessionId, availableAiProfiles = []) {
    assert(this.status === ROOM_STATUS.LOBBY, 'The game has already started.');
    assert(this.isHostSession(sessionId), 'Only the host can start the room.');
    assert(this.canStartGame(), 'Every human seat must be claimed before starting.');

    const seed = resolveConfiguredSeed(this.config.seed);
    this.gameState = createGameState({
      playerCount: this.config.playerCount,
      deckSize: this.config.deckSize,
      seed,
      historyEnabled: true,
    });

    const humanPlayerIds = getHumanSeatIds(this);
    const aiSeatIds = getAiSeatIds(this);
    const trainedRoster = this.trainedAiProfiles.length
      ? this.trainedAiProfiles
      : normalizeTrainedAiProfiles(availableAiProfiles);
    assert(!aiSeatIds.length || trainedRoster.length > 0, 'No trained AI profiles are available for AI seats. Export trained personalities or create the room from a client with saved trained profiles.');

    const seatProfiles = {};
    for (const seatId of aiSeatIds) {
      const profile = pickRandom(this.gameState.rng, trainedRoster, null);
      if (profile) seatProfiles[seatId] = profile;
    }

    this.aiMeta = createAIMeta(this.gameState, {
      humanPlayerIds,
      seatProfiles,
    });
    this.assignPlayerFirstNames();
    this.pendingAiTitleAssignment = null;
    this.status = ROOM_STATUS.IN_PROGRESS;
    this.gameOverSent = false;
    startInteractiveRuntime(this.gameState, this.aiMeta, this);
    this.refreshStatusFromGame();
    this.touch();
    return this.gameState;
  }

  refreshStatusFromGame() {
    if (!this.gameState) return;
    if (this.gameState.gameOver || this.gameState.phase === 'scoring') {
      this.status = ROOM_STATUS.FINISHED;
    } else {
      this.status = ROOM_STATUS.IN_PROGRESS;
    }
  }

  assignPlayerFirstNames() {
    if (!this.gameState) return;
    for (const player of this.gameState.players) {
      const seat = this.seats[player.id];
      if (seat?.kind === 'human') {
        const trimmed = String(seat.playerName || '').trim();
        if (trimmed) {
          player.firstName = trimmed;
          continue;
        }
      }
      const aiName = getAiDisplayName(this.aiMeta, player.id);
      if (aiName) player.firstName = aiName;
    }
  }

  attachConnection(sessionId, connection) {
    this.connections.set(sessionId, connection);
    const seat = this.findSeatBySession(sessionId);
    if (seat) seat.connected = true;
    this.touch();
  }

  detachConnection(sessionId) {
    this.connections.delete(sessionId);
    const seat = this.findSeatBySession(sessionId);
    if (seat) {
      seat.connected = false;
      this.broadcast({
        type: 'seat_disconnected',
        roomCode: this.roomCode,
        seatId: seat.seatId,
      });
      this.broadcastRoomSnapshot();
    }
    this.touch();
  }

  createRoomSnapshotFor(sessionId) {
    const viewerSeat = this.findSeatBySession(sessionId);
    return {
      type: 'room_snapshot',
      roomCode: this.roomCode,
      status: this.status,
      config: clonePlain(this.config),
      hostSessionId: this.hostSessionId === sessionId ? this.hostSessionId : null,
      seats: this.seats.map((seat) => createSeatSummary(this, seat, sessionId)),
      yourSession: {
        sessionId,
        playerName: this.sessions.get(sessionId)?.playerName || null,
        claimedSeatId: viewerSeat?.seatId ?? null,
        isHost: this.isHostSession(sessionId),
      },
      canStart: this.canStartGame() && this.isHostSession(sessionId),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  createGameSnapshotFor(sessionId) {
    if (!this.gameState) return null;
    const viewerSeatId = this.findSeatBySession(sessionId)?.seatId ?? null;
    return {
      type: 'game_snapshot',
      roomCode: this.roomCode,
      status: this.status,
      yourSeatId: viewerSeatId,
      hostSeatId: this.findSeatBySession(this.hostSessionId)?.seatId ?? 0,
      state: serializePublicGameState(this.gameState, viewerSeatId),
    };
  }

  createPrivateSnapshotFor(sessionId) {
    const seat = this.findSeatBySession(sessionId);
    return {
      type: 'private_snapshot',
      roomCode: this.roomCode,
      sessionToken: sessionId,
      seatId: seat?.seatId ?? null,
      seatToken: seat?.seatToken ?? null,
      reconnectAllowed: Boolean(seat?.seatToken),
      submittedOrders: seat && this.gameState?.allOrders ? Boolean(this.gameState.allOrders[seat.seatId]) : false,
      pendingAiTitleAssignment: Boolean(this.pendingAiTitleAssignment),
    };
  }

  sendToSession(sessionId, payload) {
    this.connections.get(sessionId)?.sendJson(payload);
  }

  broadcast(payload) {
    for (const connection of this.connections.values()) {
      connection.sendJson(payload);
    }
  }

  broadcastRoomSnapshot() {
    for (const sessionId of this.connections.keys()) {
      this.sendToSession(sessionId, this.createRoomSnapshotFor(sessionId));
    }
  }

  broadcastGameSnapshots({ previousPhase = null } = {}) {
    for (const sessionId of this.connections.keys()) {
      const gameSnapshot = this.createGameSnapshotFor(sessionId);
      const privateSnapshot = this.createPrivateSnapshotFor(sessionId);
      if (previousPhase && this.gameState && previousPhase !== this.gameState.phase) {
        this.sendToSession(sessionId, {
          type: 'phase_changed',
          roomCode: this.roomCode,
          phase: this.gameState.phase,
          round: this.gameState.round,
        });
      }
      if (gameSnapshot) this.sendToSession(sessionId, gameSnapshot);
      if (privateSnapshot) this.sendToSession(sessionId, privateSnapshot);
    }

    if (this.status === ROOM_STATUS.FINISHED && !this.gameOverSent) {
      this.broadcast({
        type: 'game_over',
        roomCode: this.roomCode,
        gameOver: clonePlain(this.gameState?.gameOver || null),
        phase: this.gameState?.phase || null,
      });
      this.gameOverSent = true;
    }
  }

  sendInitialSync(sessionId) {
    this.sendToSession(sessionId, this.createRoomSnapshotFor(sessionId));
    if (!this.gameState) return;
    this.sendToSession(sessionId, this.createGameSnapshotFor(sessionId));
    this.sendToSession(sessionId, this.createPrivateSnapshotFor(sessionId));
  }

  reject(sessionId, requestId, reason) {
    this.sendToSession(sessionId, {
      type: 'action_rejected',
      roomCode: this.roomCode,
      requestId: requestId || null,
      reason,
    });
  }

  accept(sessionId, requestId, extra = {}) {
    this.sendToSession(sessionId, {
      type: 'action_accepted',
      roomCode: this.roomCode,
      requestId: requestId || null,
      ...extra,
    });
  }

  finalizeMutation(sessionId, requestId, previousPhase = null, extra = {}) {
    this.refreshStatusFromGame();
    this.touch();
    this.accept(sessionId, requestId, extra);
    this.broadcastRoomSnapshot();
    if (this.gameState) this.broadcastGameSnapshots({ previousPhase });
    else this.sendToSession(sessionId, this.createPrivateSnapshotFor(sessionId));
  }

  requireHumanSeatForSession(sessionId) {
    assert(this.status !== ROOM_STATUS.LOBBY, 'The game has not started.');
    assert(this.gameState, 'The game has not started.');
    const seat = this.findSeatBySession(sessionId);
    assert(seat, 'You do not control a seat in this room.');
    assert(seat.kind === 'human', 'Only human seats can submit commands.');
    return seat;
  }

  handleGameCommand(sessionId, message = {}) {
    const requestId = message.requestId || null;
    const previousPhase = this.gameState?.phase || null;

    try {
      if (message.type === 'court_action') {
        const seat = this.requireHumanSeatForSession(sessionId);
        const result = handleHumanCourtAction(this.gameState, this.aiMeta, this, seat.seatId, message);
        assert(result.ok, result.reason);
        this.finalizeMutation(sessionId, requestId, previousPhase, { action: message.type });
        return;
      }

      if (message.type === 'confirm_court') {
        const seat = this.requireHumanSeatForSession(sessionId);
        const result = handleHumanCourtConfirmation(this.gameState, this.aiMeta, this, seat.seatId);
        assert(result.ok, result.reason);
        this.finalizeMutation(sessionId, requestId, previousPhase, { action: message.type });
        return;
      }

      if (message.type === 'submit_orders') {
        const seat = this.requireHumanSeatForSession(sessionId);
        const submitResult = handleHumanOrders(this.gameState, this.aiMeta, this, seat.seatId, message.orders);
        assert(submitResult.ok, submitResult.reason);
        this.finalizeMutation(sessionId, requestId, previousPhase, { action: message.type });
        return;
      }

      if (message.type === 'reassign_major_titles') {
        const seat = this.requireHumanSeatForSession(sessionId);
        const assignments = message.assignments && typeof message.assignments === 'object' ? message.assignments : {};
        const result = handleManualTitleReassignment(this.gameState, this.aiMeta, this, seat.seatId, assignments);
        assert(result.ok, result.reason);
        this.finalizeMutation(sessionId, requestId, previousPhase, { action: message.type });
        return;
      }

      if (message.type === 'continue_after_resolution') {
        assert(this.isHostSession(sessionId), 'Only the host can advance past resolution.');
        assert(this.gameState.phase === 'resolution', 'Continue is only available during resolution.');
        const needsHumanReassignment = this.gameState.nextBasileusId !== this.gameState.basileusId
          && this.seats[this.gameState.nextBasileusId]?.kind === 'human'
          && this.pendingAiTitleAssignment == null;
        assert(!needsHumanReassignment, 'The new Basileus must reassign major titles first.');
        const continuation = handleContinueAfterResolution(this.gameState, this.aiMeta, this);
        assert(continuation.ok, continuation.reason);
        this.finalizeMutation(sessionId, requestId, previousPhase, { action: message.type });
        return;
      }

      throw new Error('Unknown in-game command.');
    } catch (error) {
      this.reject(sessionId, requestId, error?.message || 'Command failed.');
    }
  }

  async handleClientMessage(sessionId, message = {}, availableAiProfiles = []) {
    const requestId = message.requestId || null;
    try {
      if (message.type === 'claim_seat') {
        const claimResult = this.claimSeat(sessionId, toInt(message.seatId, -1), message.playerName);
        this.broadcast({
          type: 'seat_claimed',
          roomCode: this.roomCode,
          seatId: claimResult.seatId,
        });
        this.finalizeMutation(sessionId, requestId, null, { action: message.type, seatId: claimResult.seatId });
        return;
      }

      if (message.type === 'reclaim_seat') {
        const claimResult = this.reclaimSeat(sessionId, message.seatToken, message.playerName);
        this.broadcast({
          type: 'seat_claimed',
          roomCode: this.roomCode,
          seatId: claimResult.seatId,
        });
        this.finalizeMutation(sessionId, requestId, this.gameState?.phase || null, { action: message.type, seatId: claimResult.seatId });
        return;
      }

      if (message.type === 'set_seat_kind') {
        const seat = this.setSeatKind(sessionId, toInt(message.seatId, -1), message.kind);
        this.finalizeMutation(sessionId, requestId, null, { action: message.type, seatId: seat.seatId, kind: seat.kind });
        return;
      }

      if (message.type === 'set_room_config') {
        this.setRoomConfig(sessionId, message.config || {});
        this.finalizeMutation(sessionId, requestId, null, { action: message.type });
        return;
      }

      if (message.type === 'start_game') {
        const previousPhase = this.gameState?.phase || null;
        await this.startGame(sessionId, availableAiProfiles);
        this.finalizeMutation(sessionId, requestId, previousPhase, { action: message.type });
        return;
      }

      if (message.type === 'leave_room') {
        if (this.status === ROOM_STATUS.LOBBY) {
          const seat = this.releaseLobbySeat(sessionId);
          this.connections.get(sessionId)?.close();
          this.finalizeMutation(sessionId, requestId, null, { action: message.type, seatId: seat.seatId });
          return;
        }

        const seat = this.findSeatBySession(sessionId);
        if (seat) {
          seat.connected = false;
          this.broadcast({
            type: 'seat_disconnected',
            roomCode: this.roomCode,
            seatId: seat.seatId,
          });
          this.broadcastRoomSnapshot();
        }
        this.connections.get(sessionId)?.close();
        this.accept(sessionId, requestId, { action: message.type });
        return;
      }

      if (this.gameState) {
        this.handleGameCommand(sessionId, message);
        return;
      }

      throw new Error('Unknown lobby command.');
    } catch (error) {
      this.reject(sessionId, requestId, error?.message || 'Command failed.');
    }
  }
}

export function createRoomCode(existingRoomCodes = new Set()) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  while (true) {
    let code = '';
    for (let index = 0; index < 6; index += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    if (!existingRoomCodes.has(code)) return code;
  }
}

export function createRoom({ existingRoomCodes, hostSessionId, hostPlayerName, config }) {
  return new MultiplayerRoom({
    roomCode: createRoomCode(existingRoomCodes),
    hostSessionId,
    hostPlayerName,
    config,
  });
}

export { DEFAULT_ROOM_CONFIG, normalizeRoomConfig };
