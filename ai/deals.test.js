import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { setDealParticipantIds } from '../engine/deals.js';
import { phaseCourt } from '../engine/turnflow.js';
import { createAIMeta } from './brain.js';
import { valueClauseForPlayer } from './deals.js';
import { handleHumanCourtAction } from '../game/runtime.js';

const HUMAN = 1;
const AI = 2;

// Seats 1 and 2 hold offices, so neither is auto-confirmed when Court opens
// (a dynasty with nothing to do at Court confirms at once and cannot deal).
function courtWithAiSeats() {
  const state = createGameState({ playerCount: 4, deckSize: 6, seed: 11, historyEnabled: true });
  setDealParticipantIds(state, state.players.map((player) => player.id));
  for (const player of state.players) player.gold = 10;
  state.phase = 'income';
  phaseCourt(state);
  const meta = createAIMeta(state, { humanPlayerIds: [HUMAN], aiPlayers: {} });
  return { state, meta };
}

function offer(state, meta, clauses) {
  const result = handleHumanCourtAction(state, meta, {}, HUMAN, { action: 'deal-send', counterpartyId: AI, clauses });
  assert.equal(result.ok, true, result.reason);
  return state.dealThreads.at(-1);
}

test('an AI dynasty accepts a clearly favourable offer right away', () => {
  const { state, meta } = courtWithAiSeats();
  const thread = offer(state, meta, [{ kind: 'gold', direction: 'give', amount: 3 }]);

  assert.equal(thread.status, 'accepted');
  assert.equal(state.players[AI].gold, 13);
  assert.equal(state.players[HUMAN].gold, 7);
});

test('an AI dynasty refuses an offer that only costs it', () => {
  const { state, meta } = courtWithAiSeats();
  const thread = offer(state, meta, [{ kind: 'gold', direction: 'ask', amount: 4 }]);

  assert.equal(thread.status, 'refused');
  assert.equal(state.players[AI].gold, 10);
  assert.equal(state.players[HUMAN].gold, 10);
});

test('an AI weighs both sides: a fair trade passes, a lopsided one does not', () => {
  const fair = courtWithAiSeats();
  const fairThread = offer(fair.state, fair.meta, [
    { kind: 'gold', direction: 'give', amount: 4 },
    { kind: 'non_revocation', direction: 'ask', durationTurns: 1 },
  ]);
  assert.equal(fairThread.status, 'accepted');

  const lopsided = courtWithAiSeats();
  const lopsidedThread = offer(lopsided.state, lopsided.meta, [
    { kind: 'gold', direction: 'give', amount: 1 },
    { kind: 'non_revocation', direction: 'ask', durationTurns: 3 },
  ]);
  assert.equal(lopsidedThread.status, 'refused');
});

test('clause values are signed by direction and discounted when conditional', () => {
  const { state } = courtWithAiSeats();
  const gift = { kind: 'gold', giverId: HUMAN, receiverId: AI, durationTurns: 1, payload: { totalAmount: 4 } };
  const ask = { ...gift, giverId: AI, receiverId: HUMAN };
  const conditional = { ...gift, startTrigger: { type: 'when_player_is_basileus', playerId: HUMAN } };

  assert.ok(valueClauseForPlayer(state, gift, AI) > 0);
  assert.ok(valueClauseForPlayer(state, ask, AI) < 0);
  assert.ok(valueClauseForPlayer(state, conditional, AI) < valueClauseForPlayer(state, gift, AI));
  assert.equal(valueClauseForPlayer(state, gift, 3), 0, 'bystanders are unaffected');
});
