import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoom, SAVE_VERSION } from './session.js';
import { getPlayerOrderOfficeKeys } from '../engine/orders.js';
import { loadOpponentRosterSync } from '../ai/nodeOpponentRoster.js';
import { getTunedAiOpponents } from '../ai/opponentRoster.js';

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

test('multiplayer room follows court, estates, deployment, resolution flow', async () => {
  const room = await makeStartedRoom();
  assert.equal(room.gameState.phase, 'court');

  for (const player of room.gameState.players) send(room, player.id, { type: 'confirm_court' });
  assert.equal(room.gameState.phase, 'estates');

  send(room, 1, { type: 'estate_action', action: 'buy', themeId: 'OPS', amount: 2 });
  send(room, 1, { type: 'confirm_estates' });
  assert.equal(room.gameState.phase, 'estates');
  assert.equal(room.gameState.estatesReady[1], true);
  for (const player of room.gameState.players) {
    if (player.id !== 1) send(room, player.id, { type: 'confirm_estates' });
  }
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

test('multiplayer roster exposes tuned opponents from disk', () => {
  const roster = loadOpponentRosterSync();
  const tuned = getTunedAiOpponents(roster);

  assert.equal(tuned.length > 0, true);
  assert.equal(roster[0].source, 'tuned');
});

test('new multiplayer AI seats default to a tuned opponent', () => {
  const tunedOpponent = {
    id: 'tuned-room-test',
    firstName: 'Tuned Room',
    label: 'Tuned Room',
    source: 'tuned',
    policy: { policyId: 'tuned', strategyWeights: { estateProfit: 4, estateBidCost: 0.35 } },
    strategyWeights: { estateProfit: 4, estateBidCost: 0.35 },
  };
  const room = createRoom({
    existingRoomCodes: new Set(),
    hostSessionId: 's0',
    hostPlayerName: 'Host',
    config: { playerCount: 3, deckSize: 1, seed: '31' },
    loadAiOpponentRoster: () => [tunedOpponent],
    loadAiOpponentById: (id) => (id === tunedOpponent.id ? tunedOpponent : null),
  });

  room.claimSeat('s0', 0, 'Host');
  const seat = room.setSeatKind('s0', 1, 'ai');

  assert.equal(seat.aiOpponentId, tunedOpponent.id);
  assert.equal(seat.playerName, tunedOpponent.firstName);
  assert.equal(room.createRoomSnapshotFor('s0').aiOpponents[0].id, tunedOpponent.id);
});
