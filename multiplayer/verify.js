import assert from 'node:assert/strict';

import { createRoom, SAVE_VERSION } from './session.js';
import { suggestMajorTitleAssignments } from '../engine/actions.js';
import { getPlayerOrderOfficeKeys } from '../engine/orders.js';

function claimAllSeats(room) {
  for (let seatId = 0; seatId < room.seats.length; seatId += 1) {
    room.claimSeat(`s${seatId}`, seatId, `Player ${seatId + 1}`);
  }
}

function seatSession(seatId) {
  return `s${seatId}`;
}

function send(room, seatId, message) {
  room.handleGameCommand(seatSession(seatId), {
    requestId: `${message.type}:${seatId}:${Date.now()}`,
    ...message,
  });
}

function buildCapitalOrders(state, playerId) {
  const armies = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    armies[officeKey] = { funded: 999, destination: 'capital' };
  }
  return {
    armies,
    mercenaries: { count: 0, destination: 'frontier' },
    candidate: state.basileusId,
  };
}

async function verifyMultiplayerRulePatchFlow() {
  const room = createRoom({
    existingRoomCodes: new Set(),
    hostSessionId: 's0',
    hostPlayerName: 'Host',
    config: { playerCount: 4, deckSize: 1, seed: '17' },
  });
  claimAllSeats(room);

  await room.startGame('s0');
  assert.equal(room.gameState.phase, 'title_redistribution');
  assert.equal(room.createSavePayload().version, SAVE_VERSION);
  assert.equal(SAVE_VERSION, 2);

  const basileusId = room.gameState.basileusId;
  send(room, basileusId, {
    type: 'reassign_major_titles',
    assignments: suggestMajorTitleAssignments(room.gameState, basileusId),
  });
  assert.equal(room.gameState.phase, 'court');
  assert.equal(room.gameState.players.every((player) => player.gold === 4), true);

  for (const player of room.gameState.players) {
    send(room, player.id, { type: 'confirm_court' });
  }
  assert.equal(room.gameState.phase, 'estates');

  send(room, 1, { type: 'estate_action', action: 'buy', themeId: 'OPS', amount: 2 });
  assert.equal(room.gameState.landAuctions.OPS.bidderId, 1);
  send(room, 1, { type: 'confirm_estates' });
  assert.equal(room.gameState.phase, 'deployment');
  assert.equal(room.gameState.themes.OPS.owner, 1);

  for (const player of room.gameState.players) {
    send(room, player.id, {
      type: 'submit_orders',
      orders: buildCapitalOrders(room.gameState, player.id),
    });
  }
  assert.equal(room.gameState.phase, 'resolution');
  assert.equal(Object.keys(room.gameState.allOrders).length, room.gameState.players.length);

  send(room, 0, { type: 'continue_after_resolution' });
  assert.equal(['cleanup', 'scoring'].includes(room.gameState.phase), true);
}

try {
  await verifyMultiplayerRulePatchFlow();
  console.log('multiplayer verification passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
