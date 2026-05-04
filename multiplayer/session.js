import { createGameState, getPlayer, formatPlayerLabel } from '../engine/state.js';
import {
  advanceToNextInteractivePhase,
  allOrdersSubmitted,
  phaseCleanup,
  phaseResolution,
} from '../engine/turnflow.js';
import { getMercenaryOrderCost } from '../engine/rules.js';
import {
  applyCourtAction,
  applyManualTitleReassignment,
  confirmCourt,
  submitHumanOrders,
} from '../engine/commands.js';
import {
  autoResolveUnavailableHumanAppointments as autoResolveCourtForPlayer,
  maybeAdvanceCourt,
  processAiFlow,
} from '../engine/runtime.js';
import {
  applyPlannedAiTitleAssignment,
  createAIMeta,
  handlePostResolutionAI,
  invalidateRoundContext,
  observeCourtAction,
} from '../ai/brain.js';
import { normalizeAiProfile } from '../ai/profileStore.js';

export const ROOM_STATUS = {
  LOBBY: 'lobby',
  IN_PROGRESS: 'in_progress',
  FINISHED: 'finished',
};

const PLAYER_COUNT_MIN = 3;
const PLAYER_COUNT_MAX = 5;
const DEFAULT_PLAYER_COUNT = 4;
const DEFAULT_DECK_SIZE = 9;
const DEFAULT_ROOM_CONFIG = {
  playerCount: DEFAULT_PLAYER_COUNT,
  deckSize: DEFAULT_DECK_SIZE,
  seed: '',
};

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function hashSeedInput(seedInput) {
  let seed = 0;
  for (let index = 0; index < seedInput.length; index += 1) {
    seed = ((seed << 5) - seed + seedInput.charCodeAt(index)) | 0;
  }
  return seed;
}

function resolveConfiguredSeed(rawSeed) {
  const text = String(rawSeed || '').trim();
  return text ? hashSeedInput(text) : Date.now();
}

function randomPick(rng, values) {
  if (!values.length) return null;
  return values[Math.floor(rng() * values.length)] ?? values[0] ?? null;
}

function assert(condition, reason) {
  if (!condition) throw new Error(reason);
}

function normalizeRoomConfig(rawConfig = {}) {
  return {
    playerCount: clamp(toInt(rawConfig.playerCount, DEFAULT_PLAYER_COUNT), PLAYER_COUNT_MIN, PLAYER_COUNT_MAX),
    deckSize: clamp(toInt(rawConfig.deckSize, DEFAULT_DECK_SIZE), 1, 30),
    seed: String(rawConfig.seed ?? DEFAULT_ROOM_CONFIG.seed).trim(),
  };
}

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

function serializeCourtActions(courtActions = null) {
  if (!courtActions) return null;
  return {
    ...courtActions,
    playerConfirmed: [...(courtActions.playerConfirmed || new Set())],
  };
}

function serializeCurrentInvasion(invasion) {
  if (!invasion) return null;
  return {
    ...clonePlain(invasion),
    route: Array.isArray(invasion.route) ? invasion.route.slice() : [],
    strength: Array.isArray(invasion.strength) ? invasion.strength.slice() : [],
    baseStrength: Array.isArray(invasion.baseStrength) ? invasion.baseStrength.slice() : [],
  };
}

function serializePlayersForViewer(state, viewerSeatId) {
  return state.players.map((player) => {
    const hiddenSpend = state.phase === 'orders' && viewerSeatId !== player.id
      ? getMercenaryOrderCost(state.allOrders?.[player.id]?.mercenaries || [])
      : 0;
    return {
      ...clonePlain(player),
      gold: player.gold + hiddenSpend,
    };
  });
}

function sanitizePublicHistory(state) {
  const history = Array.isArray(state.history) ? state.history : [];
  const currentRound = state.round;
  const inHiddenOrdersWindow = state.phase === 'orders';
  const sanitized = [];

  for (const event of history) {
    if (event?.type === 'hire_mercenaries' && inHiddenOrdersWindow && event.round === currentRound) {
      continue;
    }

    const nextEvent = {
      ...clonePlain(event),
      decision: null,
    };

    if (nextEvent.type === 'orders_submitted') {
      nextEvent.details = null;
      nextEvent.summary = `${nextEvent.summary || ''}`.trim() || 'Secret orders are sealed.';
    }

    sanitized.push(nextEvent);
  }

  return sanitized;
}

function serializePublicGameState(state, viewerSeatId) {
  const pendingTitleReassignment = Boolean(state.pendingTitleReassignment) || state.nextBasileusId !== state.basileusId;
  return {
    round: state.round,
    maxRounds: state.maxRounds,
    phase: state.phase,
    historyEnabled: true,
    historySeq: state.historySeq || 0,
    basileusId: state.basileusId,
    nextBasileusId: state.nextBasileusId,
    players: serializePlayersForViewer(state, viewerSeatId),
    themes: clonePlain(state.themes),
    empress: state.empress,
    chiefEunuchs: state.chiefEunuchs,
    currentInvasion: serializeCurrentInvasion(state.currentInvasion),
    invasionStrength: state.invasionStrength,
    currentLevies: clonePlain(state.currentLevies || {}),
    allOrders: Object.fromEntries(Object.keys(state.allOrders || {}).map((playerId) => [playerId, true])),
    lastCoupResult: clonePlain(state.lastCoupResult),
    lastWarResult: clonePlain(state.lastWarResult),
    gameOver: clonePlain(state.gameOver),
    history: sanitizePublicHistory(state),
    courtActions: serializeCourtActions(state.courtActions),
    pendingTitleReassignment,
    recruitedThisRound: clonePlain(state.recruitedThisRound || {}),
  };
}

function getPlayerOfficeKeys(state, playerId) {
  const offices = [];
  if (playerId === state.basileusId) offices.push('BASILEUS');
  const player = getPlayer(state, playerId);
  for (const titleKey of player?.majorTitles || []) {
    if (titleKey !== 'PATRIARCH') offices.push(titleKey);
  }
  for (const theme of Object.values(state.themes)) {
    if (theme.strategos === playerId && !theme.occupied) {
      offices.push(`STRAT_${theme.id}`);
    }
  }
  return offices;
}

function sanitizeMercenaries(mercenaries = []) {
  const totals = new Map();
  for (const entry of Array.isArray(mercenaries) ? mercenaries : []) {
    const officeKey = String(entry?.officeKey || '').trim();
    const count = toInt(entry?.count, 0);
    if (!officeKey || count <= 0) continue;
    totals.set(officeKey, (totals.get(officeKey) || 0) + count);
  }
  return [...totals.entries()].map(([officeKey, count]) => ({ officeKey, count }));
}

function sanitizeOrdersForPlayer(state, playerId, rawOrders = {}) {
  const player = getPlayer(state, playerId);
  assert(player, 'Player not found.');

  const officeKeySet = new Set(getPlayerOfficeKeys(state, playerId));
  const deployments = {};
  for (const officeKey of officeKeySet) {
    const rawDestination = rawOrders?.deployments?.[officeKey];
    deployments[officeKey] = rawDestination === 'capital' ? 'capital' : 'frontier';
  }

  const mercenaries = sanitizeMercenaries(rawOrders?.mercenaries);
  for (const mercenary of mercenaries) {
    assert(officeKeySet.has(mercenary.officeKey), 'Mercenaries can only be assigned to your offices.');
  }

  const candidate = toInt(rawOrders?.candidate, playerId);
  assert(candidate >= 0 && candidate < state.players.length, 'Choose a valid Basileus candidate.');

  const totalCost = getMercenaryOrderCost(mercenaries);
  assert(player.gold >= totalCost, `Need ${totalCost}g, have ${player.gold}g.`);

  return { deployments, mercenaries, candidate, totalCost };
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
    this.aiBusy = false;
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
      const profile = randomPick(this.gameState.rng, trainedRoster);
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
    advanceToNextInteractivePhase(this.gameState);
    this.processAiFlow({ courtMode: 'finish' });
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
      const aiMetaForPlayer = this.aiMeta?.players?.[player.id];
      const profile = aiMetaForPlayer?.profile;
      const personalityId = aiMetaForPlayer?.personalityId;
      const personalityName = profile?.name
        || (personalityId ? (personalityId.charAt(0).toUpperCase() + personalityId.slice(1)) : null);
      if (personalityName) {
        player.firstName = personalityName;
      }
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

  autoResolveUnavailableHumanAppointments() {
    if (!this.gameState) return;
    for (const seat of this.seats) {
      if (seat.kind === 'human') autoResolveCourtForPlayer(this.gameState, seat.seatId);
    }
    maybeAdvanceCourt(this.gameState, this.aiMeta);
  }

  afterHumanCourtAction(observation = null, options = {}) {
    if (this.aiMeta) {
      if (observation) observeCourtAction(this.gameState, this.aiMeta, observation);
      else invalidateRoundContext(this.aiMeta);
    }
    this.processAiFlow(options);
  }

  processAiFlow(options = {}) {
    if (!this.aiMeta || !this.gameState || this.aiBusy) return;
    this.aiBusy = true;
    try {
      const result = processAiFlow(this.gameState, this.aiMeta, {
        ...options,
        pendingAiTitleAssignment: this.pendingAiTitleAssignment,
      });
      if (result) this.pendingAiTitleAssignment = result.pendingAiTitleAssignment;
    } finally {
      this.aiBusy = false;
      this.refreshStatusFromGame();
    }
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
        assert(this.gameState.phase === 'court', 'Court actions are not available right now.');
        assert(!this.gameState.courtActions?.playerConfirmed?.has(seat.seatId), 'You already confirmed court actions this round.');
        this.autoResolveUnavailableHumanAppointments();
        const result = applyCourtAction(this.gameState, seat.seatId, message);
        assert(result.ok, result.reason);
        maybeAdvanceCourt(this.gameState, this.aiMeta);
        this.afterHumanCourtAction(result.observation || null, { courtMode: 'react' });
        this.finalizeMutation(sessionId, requestId, previousPhase, { action: message.type });
        return;
      }

      if (message.type === 'confirm_court') {
        const seat = this.requireHumanSeatForSession(sessionId);
        const result = confirmCourt(this.gameState, seat.seatId);
        assert(result.ok, result.reason);
        maybeAdvanceCourt(this.gameState, this.aiMeta);
        this.afterHumanCourtAction(null, { courtMode: 'finish' });
        this.finalizeMutation(sessionId, requestId, previousPhase, { action: message.type });
        return;
      }

      if (message.type === 'submit_orders') {
        const seat = this.requireHumanSeatForSession(sessionId);
        const sanitized = sanitizeOrdersForPlayer(this.gameState, seat.seatId, message.orders);
        const submitResult = submitHumanOrders(this.gameState, seat.seatId, sanitized);
        assert(submitResult.ok, submitResult.reason);
        this.processAiFlow();
        if (allOrdersSubmitted(this.gameState) && this.gameState.phase === 'orders') {
          const previousBasileusId = this.gameState.basileusId;
          phaseResolution(this.gameState);
          const aftermath = handlePostResolutionAI(this.gameState, this.aiMeta, {
            previousBasileusId,
            autoApplyTitleAssignments: false,
          });
          this.pendingAiTitleAssignment = aftermath.plannedAssignment;
        }
        this.finalizeMutation(sessionId, requestId, previousPhase, { action: message.type });
        return;
      }

      if (message.type === 'reassign_major_titles') {
        const seat = this.requireHumanSeatForSession(sessionId);
        assert(this.gameState.phase === 'resolution', 'Major title reassignment is only allowed during resolution.');
        assert(this.gameState.nextBasileusId !== this.gameState.basileusId, 'No new Basileus needs to reassign titles.');
        assert(seat.seatId === this.gameState.nextBasileusId, 'Only the new Basileus may assign major titles.');
        const assignments = message.assignments && typeof message.assignments === 'object' ? message.assignments : {};
        const result = applyManualTitleReassignment(this.gameState, this.aiMeta, seat.seatId, assignments);
        assert(result.ok, result.reason);
        this.pendingAiTitleAssignment = null;
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
        if (this.pendingAiTitleAssignment && this.aiMeta) {
          applyPlannedAiTitleAssignment(
            this.gameState,
            this.aiMeta,
            this.pendingAiTitleAssignment,
            this.gameState.nextBasileusId,
          );
          this.pendingAiTitleAssignment = null;
        }
        phaseCleanup(this.gameState);
        advanceToNextInteractivePhase(this.gameState);
        if (this.aiMeta) invalidateRoundContext(this.aiMeta);
        if (this.status !== ROOM_STATUS.FINISHED) {
          this.processAiFlow({ courtMode: 'finish' });
        }
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
