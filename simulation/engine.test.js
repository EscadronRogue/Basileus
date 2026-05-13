import test from 'node:test';
import assert from 'node:assert/strict';

import { NEUTRAL_PROFILE } from '../ai/personalities.js';
import { runSingleSimulationGame } from './engine.js';

function testProfile(id) {
  return {
    ...NEUTRAL_PROFILE,
    id: `test-${id}`,
    name: `Test AI ${id}`,
    source: 'trained',
    training: {},
  };
}

test('single-game simulation exposes score category, revocation, and deal metrics', () => {
  const game = runSingleSimulationGame({
    playerCount: 3,
    deckSize: 1,
    seed: 1234,
    strictTimeoutMs: 15000,
    maxLoopIterations: 128,
    maxRounds: 6,
    seatProfiles: {
      0: testProfile(0),
      1: testProfile(1),
      2: testProfile(2),
    },
  });

  assert.equal(typeof game.topScore, 'number');
  assert.equal(typeof game.totalRevocations, 'number');
  assert.equal(typeof game.totalDealsProposed, 'number');
  assert.equal(typeof game.totalDealUtility, 'number');
  assert.ok(game.playerMetrics.length > 0);

  const metric = game.playerMetrics[0];
  assert.equal(typeof metric.finalScore, 'number');
  assert.equal(typeof metric.finalCategoryShares.gold, 'number');
  assert.equal(typeof metric.finalCategoryPoints.gold, 'number');
  assert.equal(typeof metric.revocations, 'number');
  assert.equal(typeof metric.dealsProposed, 'number');
  assert.equal(typeof metric.dealAcceptanceRate, 'number');
  assert.equal(typeof metric.badAcceptedDeals, 'number');
});
