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
    this.loadAiModel = typeof options.loadAiModel === 'function' ? options.loadAiModel : undefined;
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
        loadAiModel: this.loadAiModel,
      })
      : createRoom({
        existingRoomCodes: new Set(this.rooms.keys()),
        hostSessionId: sessionToken,
        hostPlayerName: normalizePlayerName(playerName),
        config,
        loadAiModel: this.loadAiModel,
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

export function attachMultiplayerSocketServer(server, manager, options = {}) {
  attachWebSocketServer(server, (connection) => {
    let activeRoom = null;
    let activeSessionId = null;

    connection.onMessage(async (message) => {
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
