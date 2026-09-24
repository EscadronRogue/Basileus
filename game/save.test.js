import test from 'node:test';
import assert from 'node:assert/strict';

import { RULES_VERSION, createGameState } from '../engine/state.js';
import { setDealParticipantIds } from '../engine/deals.js';
import { createAIMeta, observeCourtAction } from '../ai/brain.js';
import { startInteractiveRuntime } from './runtime.js';
import { hydrateAiMeta, hydrateGameState, serializeAiMeta, serializeGameState } from './save.js';

function startedGame() {
  const state = createGameState({ playerCount: 4, deckSize: 6, seed: 42, historyEnabled: true });
  setDealParticipantIds(state, state.players.map((player) => player.id));
  startInteractiveRuntime(state, null, {});
  return state;
}

test('game state survives a JSON round trip, including the RNG position', () => {
  const state = startedGame();
  state.courtActions?.playerConfirmed?.add(1);
  const restored = hydrateGameState(JSON.parse(JSON.stringify(serializeGameState(state))));

  const asJson = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(asJson(serializeGameState(restored)), asJson(serializeGameState(state)));
  assert.deepEqual(restored.adjacency, state.adjacency, 'adjacency Sets are rebuilt');
  assert.ok(restored.courtActions.playerConfirmed instanceof Set);
  assert.equal(restored.courtActions.playerConfirmed.has(1), true);
  const expected = [state.rng(), state.rng(), state.rng()];
  assert.deepEqual([restored.rng(), restored.rng(), restored.rng()], expected);
});

test('AI metadata restores human seats and what the AI observed', () => {
  const state = startedGame();
  const meta = createAIMeta(state, { humanPlayerIds: [0], aiPlayers: {} });
  observeCourtAction(state, meta, { type: 'appointment', actorId: 0, appointeeId: 2, value: 1 });

  const saved = JSON.parse(JSON.stringify(serializeAiMeta(meta)));
  const restored = hydrateAiMeta(saved, state, {});

  assert.deepEqual([...restored.humanPlayerIds], [0]);
  assert.equal(restored.players[1].isAI, true);
  assert.equal(restored.players[0].isAI, false);
  assert.deepEqual(restored.publicLog, meta.publicLog);
  assert.equal(hydrateAiMeta(null, state, {}), null);
});

test('a save made under older rules is refused instead of loading broken', () => {
  const saved = JSON.parse(JSON.stringify(serializeGameState(startedGame())));
  delete saved.rulesVersion;
  assert.throws(() => hydrateGameState(saved), /older rules/);
  saved.rulesVersion = RULES_VERSION - 1;
  assert.throws(() => hydrateGameState(saved), /older rules/);
});
