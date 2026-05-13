import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import {
  AI_RUNTIME_NOT_IMPLEMENTED_MESSAGE,
  applyPlannedAiTitleAssignment,
  buildAIOrders,
  chooseAIDefenderRewardChoice,
  createAIMeta,
  handlePostResolutionAI,
  isAIPlayer,
  planMajorTitleAssignment,
  runAICourtAutomation,
} from './brain.js';

function assertNotImplemented(fn) {
  assert.throws(fn, new RegExp(AI_RUNTIME_NOT_IMPLEMENTED_MESSAGE));
}

test('AI metadata preserves human and AI seat boundaries without model data', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 11 });
  const meta = createAIMeta(state, { humanPlayerIds: [1] });

  assert.equal(meta.pendingNeuralRuntime, true);
  assert.equal(meta.humanPlayerIds.has(1), true);
  assert.equal(isAIPlayer(meta, 0), true);
  assert.equal(isAIPlayer(meta, 1), false);
  assert.equal(meta.players[0].displayName, 'AI Seat 1');
  assert.equal(meta.players[0].profile, undefined);
});

test('AI decision hooks fail clearly until the neural runtime exists', () => {
  assertNotImplemented(() => runAICourtAutomation());
  assertNotImplemented(() => buildAIOrders());
  assertNotImplemented(() => chooseAIDefenderRewardChoice());
  assertNotImplemented(() => handlePostResolutionAI());
  assertNotImplemented(() => planMajorTitleAssignment());
  assertNotImplemented(() => applyPlannedAiTitleAssignment());
});
