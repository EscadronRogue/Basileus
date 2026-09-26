import test from 'node:test';
import assert from 'node:assert/strict';

import { MIN_OFFERED, OFFERED_MIN, assignTiers, buildRatingTables, summarizeRatingGames } from './rate.js';
import { getOfferedAiOpponents, getSelectableAiOpponents, pickRandomTunedOpponent } from './opponentRoster.js';

const opponents = Array.from({ length: 7 }, (_, index) => ({ id: `ai-${index}` }));

test('rating tables seat every AI about as often, never twice at a table', () => {
  const specs = buildRatingTables(opponents, {
    games: 70, seed: 3, maps: ['classic', 'compact'], playerCounts: [4, 5], deckSizes: [6, 9, 12],
  });
  const seats = {};
  for (const spec of specs) {
    const ids = spec.policies.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, 'no AI twice at one table');
    assert.equal(ids.length, spec.playerCount);
    for (const id of ids) seats[id] = (seats[id] || 0) + 1;
  }
  const counts = Object.values(seats);
  assert.equal(counts.length, opponents.length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 5, JSON.stringify(seats));
  assert.deepEqual(new Set(specs.map((spec) => spec.mapId)), new Set(['classic', 'compact']));
});

test('strength is wins over the fair share, and a fallen empire is a loss for all', () => {
  const specs = [
    { playerCount: 4, mapId: 'classic' },
    { playerCount: 4, mapId: 'compact' },
  ];
  const games = [
    { seatLabels: { 0: 'ai-0', 1: 'ai-1', 2: 'ai-2', 3: 'ai-3' }, winnerIds: [0] },
    { seatLabels: { 0: 'ai-0', 1: 'ai-1', 2: 'ai-2', 3: 'ai-3' }, winnerIds: [1], fall: true },
  ];
  const ratings = summarizeRatingGames(opponents.slice(0, 4), specs, games);
  assert.equal(ratings['ai-0'].winRate, 0.5);
  assert.equal(ratings['ai-1'].winRate, 0);
  assert.equal(ratings['ai-0'].strength, 4, 'the only winner is 4 times the average');
  assert.equal(ratings['ai-0'].maps.compact.winRate, 0);
});

test('weak AIs are not offered, but enough stay to fill a table', () => {
  const ratings = assignTiers({
    a: { strength: 1.6 }, b: { strength: 1.1 }, c: { strength: OFFERED_MIN }, d: { strength: 0.5 }, e: { strength: 0.3 },
  });
  assert.deepEqual(Object.entries(ratings).map(([id, rating]) => [id, rating.tier, rating.offered]), [
    ['a', 'strong', true], ['b', 'average', true], ['c', 'average', true], ['d', 'weak', MIN_OFFERED >= 4], ['e', 'weak', false],
  ]);
});

test('players are only offered, and randomly dealt, the AIs rated strong enough', () => {
  const roster = [
    { id: 'good', policy: { policyId: 'tuned' }, source: 'tuned', offered: true },
    { id: 'weak', policy: { policyId: 'tuned' }, source: 'tuned', offered: false },
    { id: 'built-in', policy: { policyId: 'strategic' }, source: 'built-in' },
  ];
  assert.deepEqual(getOfferedAiOpponents(roster).map((entry) => entry.id), ['good']);
  assert.deepEqual(getSelectableAiOpponents(roster).map((entry) => entry.id), ['good']);
  for (const draw of [0, 0.5, 0.99]) assert.equal(pickRandomTunedOpponent(roster, () => draw).id, 'good');
  // A roster rated before ratings existed offers every trained AI.
  const unrated = roster.map(({ offered, ...entry }) => entry);
  assert.deepEqual(getOfferedAiOpponents(unrated).map((entry) => entry.id), ['good', 'weak']);
});
