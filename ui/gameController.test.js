import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { GameController } from './gameController.js';

test('resolution continue does not submit empty title reassignment when throne is unchanged', () => {
  const controller = new GameController({ playerCount: 4, deckSize: 1, seed: 7 });
  controller.state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  controller.state.phase = 'resolution';
  controller.state.nextBasileusId = controller.state.basileusId;

  const panelWithoutTitleControls = {
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  const result = controller.tryResolveTitleReassignment(panelWithoutTitleControls);
  assert.equal(result.ok, true);
});
