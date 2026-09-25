import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { addEstates } from '../engine/estates.js';
import { createAIMeta, announceAiMoods, buildAIOrders } from './brain.js';
import { getAiMemory } from './memory.js';
import { MOODS, applyMoodToWeights, computeAiMood } from './mood.js';
import { DEFAULT_STRATEGY_WEIGHTS } from './strategy.js';
import { clonePlainData } from '../engine/clone.js';

function makeState() {
  const state = createGameState({ playerCount: 4, deckSize: 9, seed: 21, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  state.round = 3;
  state.phase = 'deployment';
  state.currentTroops = { BASILEUS: 3, DOM_EAST: 5, DOM_WEST: 4, ADMIRAL: 3 };
  return state;
}

function makeMeta(state, temperaments = {}) {
  const meta = createAIMeta(state, { humanPlayerIds: [] });
  for (const [playerId, temperament] of Object.entries(temperaments)) meta.players[playerId].temperament = temperament;
  return meta;
}

function moodOf(state, meta, playerId, previous = null) {
  return computeAiMood(state, meta, getAiMemory(state, meta), playerId, previous);
}

test('the Basileus upholds its own throne', () => {
  const state = makeState();
  const meta = makeMeta(state, { 0: { duty: 0, ambition: 0.9, volatility: 1, whim: 0 } });
  const mood = moodOf(state, meta, 0);
  assert.equal(mood.ambition, -1);
  assert.ok(mood.mood === MOODS.guardian || mood.mood === MOODS.profiteer);
});

test('a dynasty whose estates the Basileus revoked turns against the throne, and says why', () => {
  const state = makeState();
  const meta = makeMeta(state, { 1: { duty: 0, ambition: -0.2, volatility: 1, whim: 0 } });
  const before = moodOf(state, meta, 1);
  assert.ok(before.ambition < 0, 'loyal at rest');

  state.history.push({
    id: 'h1', index: 1, round: 3, phase: 'court', category: 'court', type: 'revoke_estates', actorId: 0,
    details: { revokedPlayerId: 1, revokedPlayerIds: [1], count: 3 },
  });
  const after = moodOf(state, meta, 1);
  assert.ok(after.ambition > 0, `ambition ${after.ambition}`);
  assert.ok(after.mood === MOODS.conspirator || after.mood === MOODS.hero);
  assert.match(after.reason, /revoked|estates|took its land/);
  assert.equal(after.target, 0);
});

test('an invasion that threatens its own land stirs a dynasty to defend', () => {
  const state = makeState();
  const meta = makeMeta(state, { 2: { duty: -0.3, ambition: -0.3, volatility: 1, whim: 0 } });
  state.currentInvasion = { id: 'test', name: 'Raiders', route: ['OPS', 'OPT', 'CPL'], strength: [2, 2] };
  const safe = moodOf(state, meta, 2);
  addEstates(state.themes.OPS, 2, 6);
  const threatened = moodOf(state, meta, 2);
  assert.ok(threatened.duty > safe.duty, `${safe.duty} -> ${threatened.duty}`);
  assert.match(threatened.reason || '', /its own land|its estates|Constantinople/);
});

test('moods tilt the weights: duty toward the frontier, ambition toward the throne', () => {
  const dutiful = applyMoodToWeights(DEFAULT_STRATEGY_WEIGHTS, { duty: 1, ambition: -1 });
  const scheming = applyMoodToWeights(DEFAULT_STRATEGY_WEIGHTS, { duty: -1, ambition: 1 });
  assert.ok(dutiful.invasionShortfallPenalty > scheming.invasionShortfallPenalty);
  assert.ok(dutiful.reserveValue < scheming.reserveValue);
  assert.ok(scheming.throneBase > dutiful.throneBase);
  assert.ok(scheming.incumbentDefense < dutiful.incumbentDefense);
});

test('an AI tells the table when its mood changes, once', () => {
  const state = makeState();
  const meta = makeMeta(state, { 1: { duty: 0, ambition: -0.2, volatility: 1, whim: 0 } });
  announceAiMoods(state, meta);
  state.history.push({
    id: 'h1', index: 1, round: 3, phase: 'court', category: 'court', type: 'revoke_estates', actorId: 0,
    details: { revokedPlayerId: 1, revokedPlayerIds: [1], count: 3 },
  });
  const first = announceAiMoods(state, meta).filter((event) => event.actorId === 1);
  assert.equal(first.length, 1);
  assert.match(first[0].summary, /against the throne|glory/);
  assert.equal(announceAiMoods(state, meta).filter((event) => event.actorId === 1).length, 0, 'unchanged moods are not repeated');
});

test('a whimsical AI still replays the same game the same way', () => {
  const state = makeState();
  state.currentInvasion = { id: 'test', name: 'Raiders', route: ['OPS', 'OPT', 'CPL'], strength: [9, 9] };
  const meta = makeMeta(state, { 1: { duty: 0, ambition: 0, volatility: 1, whim: 0.9 } });
  const first = buildAIOrders(clonePlainData(state), meta, 1);
  const second = buildAIOrders(clonePlainData(state), makeMeta(state, { 1: { duty: 0, ambition: 0, volatility: 1, whim: 0.9 } }), 1);
  assert.deepEqual({ ...first, debug: null }, { ...second, debug: null });
});

test('the Basileus keeps valuing its own throne whatever its temperament', () => {
  const state = makeState();
  const meta = makeMeta(state, { 0: { duty: 0, ambition: 0.7, volatility: 1, whim: 0 } });
  const mood = moodOf(state, meta, 0);
  const weights = applyMoodToWeights(DEFAULT_STRATEGY_WEIGHTS, mood);
  assert.equal(weights.throneBase, DEFAULT_STRATEGY_WEIGHTS.throneBase);
  assert.equal(weights.selfClaim, DEFAULT_STRATEGY_WEIGHTS.selfClaim);
});

test('at rest an AI plays its trained weights', () => {
  const temperament = { duty: -0.7, ambition: 0.4, volatility: 1, whim: 0 };
  const weights = applyMoodToWeights(DEFAULT_STRATEGY_WEIGHTS, { duty: -0.7, ambition: 0.4, temperament });
  assert.deepEqual(weights, { ...DEFAULT_STRATEGY_WEIGHTS });
});
