import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoom, createRoomFromSave, SAVE_VERSION } from './session.js';
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

const TEST_AI = {
  id: 'test-ai',
  firstName: 'Test AI',
  label: 'Test AI',
  source: 'test',
};

function makeAiRoom(config = {}) {
  return createRoom({
    existingRoomCodes: new Set(),
    hostSessionId: 's0',
    hostPlayerName: 'Host',
    config,
    loadAiOpponentRoster: () => [TEST_AI],
    loadAiOpponentById: () => TEST_AI,
  });
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

test('multiplayer launch advances when the only human is the opening Basileus', async () => {
  const room = makeAiRoom({ playerCount: 4, deckSize: 1, seed: '\u0001' });
  room.claimSeat('s0', 0, 'Host');
  for (let seatId = 1; seatId < 4; seatId += 1) {
    room.setSeatKind('s0', seatId, 'ai', TEST_AI.id);
  }

  await room.startGame('s0');

  assert.equal(room.gameState.basileusId, 0);
  assert.equal(room.gameState.phase, 'estates');
  assert.equal(room.gameState.courtActions.playerConfirmed.size, room.gameState.players.length);
});

test('multiplayer auto-confirms a human court seat after its last option disappears', async () => {
  const room = await makeStartedRoom();
  const state = room.gameState;
  const eastTheme = Object.values(state.themes).find((theme) => theme.region === 'east' && theme.id !== 'CPL');
  assert.ok(eastTheme);

  state.phase = 'court';
  state.basileusId = 0;
  state.nextBasileusId = 0;
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set([2, 3]),
  };
  for (const player of state.players) player.majorTitles = [];
  state.players[1].majorTitles = ['DOM_EAST'];
  for (const theme of Object.values(state.themes)) {
    if (theme.region === 'east' && theme.id !== eastTheme.id) theme.lost = true;
    theme.owner = null;
    theme.strategos = null;
    theme.bishop = null;
  }
  eastTheme.lost = false;
  eastTheme.strategos = 2;

  send(room, 1, { type: 'court_action', action: 'revoke', value: `minor:${eastTheme.id}:strategos` });

  assert.equal(state.phase, 'estates');
  assert.equal(state.courtActions.playerConfirmed.has(0), true);
  assert.equal(state.courtActions.playerConfirmed.has(1), true);
});

test('restored rooms settle AI-only launch work before players reconnect', async () => {
  const room = makeAiRoom({ playerCount: 4, deckSize: 1, seed: '\u0001' });
  room.claimSeat('s0', 0, 'Host');
  for (let seatId = 1; seatId < 4; seatId += 1) {
    room.setSeatKind('s0', seatId, 'ai', TEST_AI.id);
  }
  await room.startGame('s0');
  const save = room.createSavePayload();
  save.room.gameState.phase = 'setup';
  save.room.gameState.round = 0;
  save.room.gameState.courtActions = null;
  save.room.gameState.startingIncomeResolved = false;
  save.room.gameState.players.forEach((player) => { player.gold = 0; });
  for (const theme of Object.values(save.room.gameState.themes)) {
    theme.owner = null;
    theme.strategos = null;
    theme.bishop = null;
  }

  const restored = createRoomFromSave({
    existingRoomCodes: new Set([room.roomCode]),
    hostSessionId: 'restore-host',
    hostPlayerName: 'Restorer',
    saveGame: save,
    loadAiOpponentRoster: () => [TEST_AI],
    loadAiOpponentById: () => TEST_AI,
  });

  assert.equal(restored.gameState.basileusId, 0);
  assert.equal(restored.gameState.phase, 'estates');
  assert.equal(restored.gameState.courtActions.playerConfirmed.size, restored.gameState.players.length);
});

test('non-host can continue resolution when the host connection is gone', async () => {
  const room = await makeStartedRoom();
  room.attachConnection('s1', { sendJson() {}, close() {} });
  room.gameState.phase = 'resolution';
  room.gameState.pendingDefenderRewards = [];

  assert.equal(room.canAdvancePastResolution('s1'), true);
  send(room, 1, { type: 'continue_after_resolution' });

  assert.notEqual(room.gameState.phase, 'resolution');
});
