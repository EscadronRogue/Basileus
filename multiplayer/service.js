import { randomUUID } from 'node:crypto';

import { createRoom, createRoomFromSave } from './session.js';
import { attachWebSocketServer } from './wsServer.js';

export function createMultiplayerError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function parseMultiplayerRequestJson(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        rejectBody(createMultiplayerError(413, 'Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(body));
      } catch {
        rejectBody(createMultiplayerError(400, 'Request body must be valid JSON.'));
      }
    });
    req.on('error', rejectBody);
  });
}

function normalizePlayerName(rawName) {
  const text = String(rawName || '').trim();
  return text || 'Guest';
}

export class MultiplayerRoomManager {
  constructor(options = {}) {
    this.rooms = new Map();
    this.loadAiOpponentById = typeof options.loadAiOpponentById === 'function' ? options.loadAiOpponentById : undefined;
    this.loadAiOpponentRoster = typeof options.loadAiOpponentRoster === 'function' ? options.loadAiOpponentRoster : undefined;
  }

  createSessionToken() {
    return randomUUID();
  }

  createRoom({ playerName, config, saveGame = null }) {
    const sessionToken = this.createSessionToken();
    const room = saveGame
      ? createRoomFromSave({
        existingRoomCodes: new Set(this.rooms.keys()),
        hostSessionId: sessionToken,
        hostPlayerName: normalizePlayerName(playerName),
        saveGame,
        loadAiOpponentById: this.loadAiOpponentById,
        loadAiOpponentRoster: this.loadAiOpponentRoster,
      })
      : createRoom({
        existingRoomCodes: new Set(this.rooms.keys()),
        hostSessionId: sessionToken,
        hostPlayerName: normalizePlayerName(playerName),
        config,
        loadAiOpponentById: this.loadAiOpponentById,
        loadAiOpponentRoster: this.loadAiOpponentRoster,
      });
    this.rooms.set(room.roomCode, room);

    return {
      room,
      sessionToken,
      seatToken: null,
      claimResult: null,
    };
  }

  joinRoom(roomCode, { playerName }) {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw createMultiplayerError(404, 'Room not found.');
    }

    const sessionToken = this.createSessionToken();
    room.ensureSession(sessionToken, normalizePlayerName(playerName));

    return {
      room,
      sessionToken,
      seatToken: null,
      claimResult: null,
    };
  }

  getRoom(roomCode) {
    return this.rooms.get(String(roomCode || '').trim().toUpperCase()) || null;
  }

  getAiOpponentRoster() {
    const roster = this.loadAiOpponentRoster ? this.loadAiOpponentRoster() : [];
    return roster.map(({ path, ...entry }) => entry);
  }
}

export async function handleMultiplayerApiRequest(manager, req, url) {
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const body = await parseMultiplayerRequestJson(req);
    const result = manager.createRoom({
      playerName: body.playerName,
      config: body.config || {},
      saveGame: body.saveGame || null,
    });
    return {
      statusCode: 201,
      payload: {
        roomCode: result.room.roomCode,
        sessionToken: result.sessionToken,
        seatToken: result.seatToken,
        claimResult: result.claimResult,
        roomSnapshot: result.room.createRoomSnapshotFor(result.sessionToken),
      },
    };
  }

  const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
  if (req.method === 'POST' && joinMatch) {
    const body = await parseMultiplayerRequestJson(req);
    const result = manager.joinRoom(joinMatch[1], {
      playerName: body.playerName,
    });
    return {
      statusCode: 200,
      payload: {
        roomCode: result.room.roomCode,
        sessionToken: result.sessionToken,
        seatToken: result.seatToken,
        claimResult: result.claimResult,
        roomSnapshot: result.room.createRoomSnapshotFor(result.sessionToken),
      },
    };
  }

  throw createMultiplayerError(404, 'Unknown API route.');
}

// Per-connection rate limit. The legitimate client sends a handful of
// messages per second at peak (orders submission, deal back-and-forth,
// heartbeats); a token-bucket of 30 messages with 30/s refill leaves
// plenty of headroom for bursts while killing flooders.
const RATE_BUCKET_SIZE = 30;
const RATE_REFILL_PER_MS = 30 / 1000;

function createRateLimiter() {
  let tokens = RATE_BUCKET_SIZE;
  let lastRefill = Date.now();
  return function consume() {
    const now = Date.now();
    tokens = Math.min(RATE_BUCKET_SIZE, tokens + (now - lastRefill) * RATE_REFILL_PER_MS);
    lastRefill = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export function attachMultiplayerSocketServer(server, manager, options = {}) {
  attachWebSocketServer(server, (connection) => {
    let activeRoom = null;
    let activeSessionId = null;
    // Serialise message processing per connection. handleClientMessage is
    // async and mutates game state, so without a chain two messages from
    // the same socket could interleave their writes (e.g. submit_orders +
    // start_game). The chain only resolves; rejections from a single
    // message must not poison subsequent ones.
    let messageChain = Promise.resolve();
    const consumeRateToken = createRateLimiter();

    connection.onMessage((message) => {
      if (!consumeRateToken()) {
        // Don't let a flooder amplify the message chain.
        connection.sendJson({
          type: 'action_rejected',
          requestId: message?.requestId || null,
          reason: 'Rate limit exceeded. Slow down.',
        });
        return;
      }

      messageChain = messageChain.then(async () => {
        try {
          if (!activeRoom) {
            if (message?.type !== 'hello') {
              connection.sendJson({
                type: 'action_rejected',
                reason: 'Send hello before any other WebSocket message.',
              });
              return;
            }

            const room = manager.getRoom(message.roomCode);
            if (!room) {
              connection.sendJson({
                type: 'action_rejected',
                reason: 'Room not found.',
              });
              connection.close();
              return;
            }

            const sessionToken = String(message.sessionToken || '').trim();
            if (!sessionToken || !room.sessions.has(sessionToken)) {
              connection.sendJson({
                type: 'action_rejected',
                reason: 'Session token is invalid for this room.',
              });
              connection.close();
              return;
            }

            activeRoom = room;
            activeSessionId = sessionToken;
            room.attachConnection(activeSessionId, connection);

            room.sendInitialSync(activeSessionId);
            room.broadcastRoomSnapshot();
            if (room.gameState) room.broadcastGameSnapshots();
            return;
          }

          if (message?.type === 'heartbeat') {
            return;
          }

          await activeRoom.handleClientMessage(activeSessionId, message);
        } catch (error) {
          activeRoom?.reject(activeSessionId, message?.requestId || null, error?.message || 'WebSocket command failed.');
        }
      }).catch(() => { /* swallow so the chain keeps running */ });
    });

    connection.onClose(() => {
      if (!activeRoom || !activeSessionId) return;
      activeRoom.detachConnection(activeSessionId);
    });
  }, options);
}

export function closeMultiplayerConnections(manager) {
  for (const room of manager.rooms.values()) {
    for (const connection of room.connections.values()) {
      connection.close();
    }
    room.connections.clear();
  }
}
