import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { createAIMeta } from './brain.js';
import { ensureAIContext, invalidateAIContext } from './context.js';

test('AI context caches indicators until explicitly invalidated', () => {
  const state = createGameState({ playerCount: 3, deckSize: 1, seed: 101 });
  const meta = createAIMeta(state);

  state.players[0].gold = 5;
  const first = ensureAIContext(state, meta, 'court');
  const second = ensureAIContext(state, meta, 'court');

  assert.equal(first, second);
  assert.equal(first.playersById.get(0).gold, 5);

  state.players[0].gold = 9;
  assert.equal(ensureAIContext(state, meta, 'court'), first);

  invalidateAIContext(meta);
  const refreshed = ensureAIContext(state, meta, 'court');
  assert.notEqual(refreshed, first);
  assert.equal(refreshed.playersById.get(0).gold, 9);
});

test('AI context exposes normalized position, resources, threat, and obligations', () => {
  const state = createGameState({ playerCount: 3, deckSize: 1, seed: 202 });
  const meta = createAIMeta(state);
  const theme = Object.values(state.themes).find(entry => entry.id !== 'CPL' && !entry.occupied);

  state.players[0].gold = 6;
  state.players[0].professionalArmies.BASILEUS = 2;
  theme.owner = 0;
  meta.players[0].obligations[1] = 2;

  const context = ensureAIContext(state, meta, 'court');
  const player = context.playersById.get(0);

  assert.equal(player.playerId, 0);
  assert.equal(player.gold, 6);
  assert.equal(player.themes, 1);
  assert.equal(player.professionals >= 2, true);
  assert.equal(player.relations.obligationOut >= 2, true);
  assert.equal(typeof player.normalized.score, 'number');
  assert.equal(typeof player.normalized.threatened, 'number');
});
