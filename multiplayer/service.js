import { randomUUID } from 'node:crypto';

import { listAvailableAiProfiles } from '../ai/profileStore.js';
import { createRoom } from './session.js';
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
      if (body.length > 1_000_000) {
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
  constructor() {
    this.rooms = new Map();
    this.aiProfilesPromise = null;
  }

  async getAvailableAiProfiles() {
    if (!this.aiProfilesPromise) {
      this.aiProfilesPromise = listAvailableAiProfiles().catch(() => []);
    }
    return this.aiProfilesPromise;
  }

  createSessionToken() {
    return randomUUID();
  }

  createRoom({ playerName, config }) {
    const sessionToken = this.createSessionToken();
    const room = createRoom({
      existingRoomCodes: new Set(this.rooms.keys()),
      hostSessionId: sessionToken,
      hostPlayerName: normalizePlayerName(playerName),
      config,
    });
    this.rooms.set(room.roomCode, room);
    const hostSeat = room.findSeatBySession(sessionToken);

    return {
      room,
      sessionToken,
      seatToken: hostSeat?.seatToken ?? null,
      claimResult: hostSeat ? { seatId: hostSeat.seatId } : null,
    };
  }

  joinRoom(roomCode, { playerName, seatToken = '' }) {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw createMultiplayerError(404, 'Room not found.');
    }

    const sessionToken = this.createSessionToken();
    room.ensureSession(sessionToken, normalizePlayerName(playerName));

    let claimResult = null;
    let nextSeatToken = null;
    const reclaimToken = String(seatToken || '').trim();

    if (reclaimToken) {
      const reclaim = room.reclaimSeat(sessionToken, reclaimToken, playerName);
      claimResult = { seatId: reclaim.seatId };
      nextSeatToken = reclaim.seatToken;
    } else if (room.status !== 'lobby') {
      throw createMultiplayerError(409, 'The game is already in progress. Rejoin with your seat token.');
    }

    return {
      room,
      sessionToken,
      seatToken: nextSeatToken,
      claimResult,
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
      seatToken: body.seatToken,
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

          if (message.seatToken && !room.findSeatBySession(activeSessionId)) {
            try {
              room.reclaimSeat(activeSessionId, message.seatToken, message.playerName);
            } catch {
              // Ignore reclaim failures here; the explicit reclaim command can retry.
            }
          }

          room.sendInitialSync(activeSessionId);
          room.broadcastRoomSnapshot();
          if (room.gameState) room.broadcastGameSnapshots();
          return;
        }

        const aiProfiles = message?.type === 'start_game'
          ? await manager.getAvailableAiProfiles()
          : [];
        await activeRoom.handleClientMessage(activeSessionId, message, aiProfiles);
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
