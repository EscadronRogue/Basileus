import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoom, SAVE_VERSION } from './session.js';
import { suggestMajorTitleAssignments } from '../engine/actions.js';
import { getPlayerOrderOfficeKeys } from '../engine/orders.js';

function makeStartedRoom() {
  const room = createRoom({
    existingRoomCodes: new Set(),
    hostSessionId: 's0',
    hostPlayerName: 'Host',
    config: { playerCount: 4, deckSize: 1, seed: '23' },
  });
  for (let seatId = 0; seatId < 4; seatId += 1) {
    room.claimSeat(`s${seatId}`, seatId, `Player ${seatId + 1}`);
  }
  return room.startGame('s0').then(() => room);
}

function send(room, seatId, message) {
  room.handleGameCommand(`s${seatId}`, { requestId: `${message.type}:${seatId}`, ...message });
}

function capitalOrders(state, playerId) {
  const armies = {};
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    armies[officeKey] = { funded: 999, destination: 'capital' };
  }
  return { armies, mercenaries: { count: 0, destination: 'frontier' }, candidate: state.basileusId };
}

test('multiplayer room follows title, court, estates, deployment, resolution flow', async () => {
  const room = await makeStartedRoom();
  assert.equal(room.gameState.phase, 'title_redistribution');

  const basileusId = room.gameState.basileusId;
  send(room, basileusId, {
    type: 'reassign_major_titles',
    assignments: suggestMajorTitleAssignments(room.gameState, basileusId),
  });
  assert.equal(room.gameState.phase, 'court');

  for (const player of room.gameState.players) send(room, player.id, { type: 'confirm_court' });
  assert.equal(room.gameState.phase, 'estates');

  send(room, 1, { type: 'estate_action', action: 'buy', themeId: 'OPS', amount: 2 });
  send(room, 1, { type: 'confirm_estates' });
  assert.equal(room.gameState.phase, 'deployment');
  assert.equal(room.gameState.themes.OPS.owner, 1);

  for (const player of room.gameState.players) {
    send(room, player.id, { type: 'submit_orders', orders: capitalOrders(room.gameState, player.id) });
  }
  assert.equal(room.gameState.phase, 'resolution');
});

test('multiplayer saves use the patched schema version', async () => {
  const room = await makeStartedRoom();
  const save = room.createSavePayload();

  assert.equal(save.version, SAVE_VERSION);
  assert.equal(save.version, 2);
});
