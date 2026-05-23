import assert from 'node:assert/strict';

import { createRoom, SAVE_VERSION } from './session.js';
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
  assert.equal(room.gameState.phase, 'court');
  assert.equal(room.createSavePayload().version, SAVE_VERSION);
  assert.equal(SAVE_VERSION, 2);

  assert.equal(room.gameState.players.every((player) => player.gold === 0), true);

  for (const player of room.gameState.players) {
    send(room, player.id, { type: 'confirm_court' });
  }
  assert.equal(room.gameState.phase, 'estates');
  assert.equal(room.gameState.players.every((player) => player.gold === 4), true);

  send(room, 1, { type: 'estate_action', action: 'buy', themeId: 'OPS', amount: 2 });
  assert.equal(room.gameState.landAuctions.OPS.bidderId, 1);
  send(room, 1, { type: 'confirm_estates' });
  assert.equal(room.gameState.phase, 'estates');
  assert.equal(room.gameState.estatesReady[1], true);
  send(room, 1, { type: 'confirm_estates' });
  assert.equal(room.gameState.estatesReady[1], undefined);
  send(room, 1, { type: 'confirm_estates' });
  for (const player of room.gameState.players) {
    if (player.id !== 1) send(room, player.id, { type: 'confirm_estates' });
  }
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
  if (!room.gameState.gameOver) {
    assert.equal(room.gameState.phase, 'court');
    for (const player of room.gameState.players) {
      send(room, player.id, { type: 'confirm_court' });
    }
    assert.equal(room.gameState.phase, 'scoring');
  } else {
    assert.equal(room.gameState.phase, 'cleanup');
  }
}

try {
  await verifyMultiplayerRulePatchFlow();
  console.log('multiplayer verification passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
