import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { setDealParticipantIds } from '../engine/deals.js';
import { listLegalCourtActions } from '../ai/legalActions.js';
import { buildAIOrders, createAIMeta, planMajorTitleAssignment } from '../ai/brain.js';
import { loadTunedOpponentRosterSync } from '../ai/nodeOpponentRoster.js';
import { buildAiPlayersFromSelections } from './aiSeats.js';
import { startInteractiveRuntime } from './runtime.js';
import { serializeGameState } from './save.js';
import {
  buildGameRecordExport,
  createGameRecord,
  isGameRecord,
  performRecordedCall,
  replayGameRecord,
  setRecordNote,
} from './record.js';

const HUMAN = 0;

function gameConfig(seed) {
  const roster = loadTunedOpponentRosterSync();
  return {
    playerCount: 4,
    turnCount: 5,
    deckSize: 5,
    mapId: 'classic',
    seed,
    historyEnabled: true,
    mode: 'single',
    humanPlayerIds: [HUMAN],
    aiOpponentSelections: [1, 2, 3].map((playerId, index) => {
      const opponent = roster[(seed + index) % roster.length];
      return {
        playerId,
        id: opponent.id,
        firstName: opponent.firstName,
        personality: opponent.personality,
        label: opponent.label,
        policy: opponent.policy,
        strategyWeights: opponent.strategyWeights,
      };
    }),
  };
}

// Plays a single-player game the way the browser controller does, with the
// human seat choosing like an AI would, and every command recorded.
function playRecordedGame(seed) {
  const config = gameConfig(seed);
  const state = createGameState(config);
  setDealParticipantIds(state, state.players.map((player) => player.id));
  const aiMeta = createAIMeta(state, {
    humanPlayerIds: config.humanPlayerIds,
    aiPlayers: buildAiPlayersFromSelections(config.aiOpponentSelections),
  });
  state.players[HUMAN].firstName = '(You)';
  const record = createGameRecord(config, state);
  const context = {};
  startInteractiveRuntime(state, aiMeta, context);
  const perform = (call, playerId, args) => performRecordedCall(record, state, aiMeta, context, call, playerId, args);

  for (let step = 0; step < 400 && !state.gameOver && state.phase !== 'scoring'; step += 1) {
    if (state.phase === 'resolution') {
      perform('resolveTitleReassignment', null, { assignments: null });
      perform('continueAfterResolution', null);
    } else if (state.phase === 'title_redistribution') {
      const planned = planMajorTitleAssignment(state, aiMeta, state.basileusId);
      perform('titleRedistribution', HUMAN, { assignments: planned?.assignments || planned });
    } else if (state.phase === 'court') {
      perform('autoResolveCourt', HUMAN);
      if (state.phase !== 'court') continue;
      const appointment = listLegalCourtActions(state, HUMAN)
        .find((action) => String(action.payload?.action).startsWith('appoint-'));
      if (appointment) perform('courtAction', HUMAN, { payload: appointment.payload });
      // A refused command is recorded too.
      perform('courtAction', HUMAN, { payload: { action: 'revoke', value: 'minor:NOWHERE:bishop' } });
      perform('courtConfirm', HUMAN);
    } else if (state.phase === 'estates') {
      perform('estateAction', HUMAN, { payload: { action: 'plan', plan: {} } });
      perform('estatesConfirm', HUMAN);
    } else if (state.phase === 'deployment') {
      const { debug, ...orders } = buildAIOrders(state, aiMeta, HUMAN);
      void debug;
      perform('orders', HUMAN, { orders });
    } else {
      break;
    }
  }
  return { state, aiMeta, record };
}

const asJson = (value) => JSON.parse(JSON.stringify(value));

test('a recorded game replays exactly from its downloaded file', () => {
  const { state, aiMeta, record } = playRecordedGame(11);
  assert.ok(state.gameOver || state.phase === 'scoring', 'the game finished');
  setRecordNote(record, 'round-1', 'Kept my troops home.');
  setRecordNote(record, 'round-2', '   ');

  const file = asJson(buildGameRecordExport(record, state, aiMeta));
  assert.equal(isGameRecord(file), true);
  assert.equal(file.finished, true);
  assert.deepEqual(file.notes, { 'round-1': 'Kept my troops home.' });
  assert.ok(file.commands.some((entry) => entry.call === 'orders'));
  assert.ok(file.commands.some((entry) => entry.ok === false && entry.reason), 'refused commands keep their reason');
  assert.ok(file.rounds.length >= 1 && file.rounds[0].players.length === 4);
  assert.ok(file.gameState.history.some((event) => event.type === 'orders_revealed' && event.decision));
  assert.equal(file.seats.find((seat) => seat.playerId === HUMAN).human, true);

  const replay = replayGameRecord(file);
  assert.deepEqual(replay.mismatches, []);
  assert.equal(replay.applied, file.commands.length);
  assert.deepEqual(asJson(serializeGameState(replay.state)), asJson(serializeGameState(state)));
});

test('a replay can stop just before a human decision', () => {
  const { record } = playRecordedGame(12);
  const file = asJson(record);
  const firstOrders = file.commands.find((entry) => entry.call === 'orders');
  const replay = replayGameRecord(file, { stopBefore: firstOrders.seq });
  assert.equal(replay.state.phase, 'deployment');
  assert.equal(replay.state.round, firstOrders.round);
  assert.equal(replay.state.allOrders?.[HUMAN], undefined);
});
