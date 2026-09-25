// Seeded full-game balance guard (roadmap item: head-to-head balance tests).
// Deterministic for a given codebase, so it never flakes; it fails when a
// change makes games stall, makes the empire unlosable or doomed, or hands
// one seat a runaway advantage. Bounds are deliberately loose; use
// `npm run simulate:ai` for real tuning numbers.
import test from 'node:test';
import assert from 'node:assert/strict';

import { simulateGames, simulateGamesParallel } from './simulate.js';

const OPTIONS = { games: 24, playerCount: 5, deckSize: 9, seed: 2026, samples: 0, historyEnabled: false };

test('seeded all-AI games complete with plausible balance', { timeout: 300_000 }, async () => {
  const result = await simulateGamesParallel({ ...OPTIONS, workers: 4 });

  assert.equal(result.completed, OPTIONS.games, 'every game reaches an end');
  assert.equal(result.stuck, 0);
  // Invasions must matter without dooming the empire: they call for a real
  // share of the troops the empire raises, and most games survive. (How
  // often the empire falls depends on how the AIs play, so it is not
  // bounded from below here.)
  assert.ok(result.wars.invasionNeedShare > 0.25 && result.wars.invasionNeedShare < 1, `invasions call for ${result.wars.invasionNeedShare} of the troops raised`);
  assert.ok(result.fallRate < 0.8, `empire-fall rate ${result.fallRate}`);

  const survivingGames = OPTIONS.games * (1 - result.fallRate);
  for (const [seat, rate] of Object.entries(result.seatWinRates)) {
    const shareOfWins = (rate * OPTIONS.games) / Math.max(1, survivingGames);
    assert.ok(shareOfWins < 0.5, `seat ${Number(seat) + 1} wins ${Math.round(shareOfWins * 100)}% of surviving games`);
  }
  assert.ok(Number.isFinite(result.scoring.pointGap) && result.scoring.pointGap >= 0);
  // No AI temperament runs away with the game. With twelve AIs each plays
  // only about ten of these games, so the bound allows two standard errors
  // of sampling noise on top of 2.5x the fair share.
  for (const [id, entry] of Object.entries(result.opponentWinRates)) {
    const noise = 2 * Math.sqrt((result.fairShare * (1 - result.fairShare)) / Math.max(1, entry.games));
    assert.ok(entry.winRate < result.fairShare * 2.5 + noise, `${id} wins ${Math.round(entry.winRate * 100)}% of its ${entry.games} games`);
  }
});

test('playing it safe everywhere does not pay', { timeout: 300_000 }, async () => {
  const result = await simulateGamesParallel({ ...OPTIONS, games: 20, probe: 'cautious', workers: 4 });
  assert.ok(result.probe.winRate < result.fairShare, `cautious probe wins ${Math.round(result.probe.winRate * 100)}%`);
});

test('parallel simulation reproduces the serial result exactly', { timeout: 300_000 }, async () => {
  const options = { ...OPTIONS, games: 4, deckSize: 6 };
  const serial = simulateGames(options);
  const parallel = await simulateGamesParallel({ ...options, workers: 2 });
  assert.deepEqual({ ...parallel, options: null }, { ...serial, options: null });
});
