import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGameState } from '../engine/state.js';
import { phaseCourt } from '../engine/turnflow.js';
import { applyCourtAction, submitHumanOrders } from '../engine/commands.js';
import { validateMajorTitleAssignments } from '../engine/actions.js';
import {
  buildAIOrders,
  buildSimultaneousAIOrders,
  createAIMeta,
  isAIPlayer,
  loadBrowserAiOpponentRoster,
  planMajorTitleAssignment,
  runAICourtAutomation,
} from './brain.js';
import { applyLegalAction, listLegalCourtActions, listLegalEstateActions } from './legalActions.js';
import { simulateGames } from './simulate.js';
import { trainStrategyWeights } from './train.js';
import { GREEK_FIRST_NAMES } from './greekNames.js';

function makeState() {
  const state = createGameState({ playerCount: 4, deckSize: 2, seed: 13, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  for (const player of state.players) player.majorTitles = [];
  state.players[1].majorTitles = ['DOM_EAST', 'PATRIARCH'];
  state.players[2].majorTitles = ['DOM_WEST'];
  state.players[3].majorTitles = ['ADMIRAL'];
  return state;
}

test('AI meta keeps declared human seats under human control', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0, 2] });

  assert.equal(isAIPlayer(meta, 0), false);
  assert.equal(isAIPlayer(meta, 1), true);
  assert.equal(isAIPlayer(meta, 2), false);
  assert.equal(isAIPlayer(meta, 3), true);
});

test('browser AI roster defaults to bundled opponents without probing API', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: false, status: 404 };
  };
  try {
    const roster = await loadBrowserAiOpponentRoster();
    assert.equal(called, false);
    assert.equal(roster.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('strategic court automation only controls AI players', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  state.phase = 'income';
  phaseCourt(state);

  const result = runAICourtAutomation(state, meta, { mode: 'finish' });

  assert.equal(result.ok, true);
  assert.equal(result.actions >= 3, true);
  assert.equal(state.courtActions.playerConfirmed.has(0), false);
  assert.equal(state.courtActions.playerConfirmed.has(1), true);
  assert.equal(state.courtActions.playerConfirmed.has(2), true);
  assert.equal(state.courtActions.playerConfirmed.has(3), true);
});

test('strategic orders use the deployment schema and include decision metadata', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  state.phase = 'deployment';
  state.currentTroops = {
    DOM_EAST: { normal: 2, capitalLocked: 0 },
    PATRIARCH: { normal: 1, capitalLocked: 0 },
  };

  const orders = buildAIOrders(state, meta, 1);
  const validation = submitHumanOrders(state, 1, orders);

  assert.equal(validation.ok, true);
  assert.equal(Number.isInteger(orders.candidate), true);
  assert.equal(orders.mercenaries.count >= 0, true);
  assert.equal(orders.armies.DOM_EAST.funded >= 0, true);
  assert.equal(orders.armies.PATRIARCH.funded >= 0, true);
  assert.equal(orders.debug.decision.title.includes('strategic'), true);
  assert.equal(orders.debug.decision.factors[0].label, 'frontier');
});

test('legal estate actions dispatch through the shared AI action path', () => {
  const state = makeState();
  state.phase = 'estates';
  state.players[1].gold = 4;

  const action = listLegalEstateActions(state, 1)[0];
  const result = applyLegalAction(state, action);

  assert.equal(result.ok, true);
  assert.equal(Boolean(state.landAuctions[action.payload.themeId]), true);
});

test('AI court legal actions respect appointment-or-revocation office mode', () => {
  const state = makeState();
  state.themes.KAP.strategos = 3;
  state.phase = 'income';
  phaseCourt(state);

  const appointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(appointment.ok, true);

  const appointmentModeActions = listLegalCourtActions(state, 1);
  assert.equal(appointmentModeActions.some((action) => action.payload?.action === 'appoint-strategos'), true);
  assert.equal(appointmentModeActions.some((action) => action.payload?.action === 'revoke' && action.payload?.value?.endsWith(':strategos')), false);

  const revokeState = makeState();
  revokeState.themes.OPS.strategos = 2;
  revokeState.phase = 'income';
  phaseCourt(revokeState);

  const revocation = applyCourtAction(revokeState, 1, { action: 'revoke', value: 'minor:OPS:strategos' });
  assert.equal(revocation.ok, true);

  const revocationModeActions = listLegalCourtActions(revokeState, 1);
  assert.equal(revocationModeActions.some((action) => action.payload?.action === 'appoint-strategos'), false);
});

test('AI simulation runner completes deterministic all-AI games', () => {
  const result = simulateGames({
    games: 3,
    playerCount: 4,
    deckSize: 2,
    seed: 91,
    samples: 2,
    policies: ['strategic', 'random', 'defender', 'profiteer'],
  });

  assert.equal(result.games, 3);
  assert.equal(result.completed + result.stuck, 3);
  assert.equal(result.resolutions > 0, true);
  assert.equal(Number.isFinite(result.scoring.winnerScore), true);
});

test('AI training harness evaluates strategy weight profiles', () => {
  const result = trainStrategyWeights({
    generations: 1,
    population: 2,
    elite: 1,
    games: 2,
    playerCounts: '3-5',
    deckSizes: '1,2',
    seed: 133,
    save: false,
  });
  const second = trainStrategyWeights({
    generations: 1,
    population: 2,
    elite: 1,
    games: 1,
    playerCounts: [3],
    deckSizes: [1],
    seed: 133,
    save: false,
  });

  assert.equal(result.generations.length, 1);
  assert.deepEqual(result.options.playerCounts, [3, 4, 5]);
  assert.deepEqual(result.options.deckSizes, [1, 2]);
  assert.notEqual(result.options.seed, second.options.seed);
  assert.equal(Number.isFinite(result.best.metrics.objective), true);
  assert.equal(typeof result.best.weights.invasionMargin, 'number');
  assert.equal(result.saved, undefined);
});

test('AI training can save a Greek-named tuned opponent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basileus-ai-'));
  const outputPath = join(dir, 'tunedOpponents.json');
  try {
    const result = trainStrategyWeights({
      generations: 1,
      population: 2,
      elite: 1,
      games: 1,
      playerCounts: [5],
      deckSizes: [1],
      seed: 144,
      outputPath,
    });
    const payload = JSON.parse(readFileSync(outputPath, 'utf8'));

    assert.equal(result.saved.path, outputPath);
    assert.equal(payload.opponents.length, 1);
    assert.equal(GREEK_FIRST_NAMES.includes(payload.opponents[0].firstName), true);
    assert.equal(payload.opponents[0].policy.policyId, 'tuned');
    assert.equal(typeof payload.opponents[0].strategyWeights.invasionMargin, 'number');
    assert.deepEqual(payload.opponents[0].training.playerCounts, [5]);
    assert.deepEqual(payload.opponents[0].training.deckSizes, [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simultaneous AI planning ignores already submitted human deployment orders', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  state.phase = 'deployment';
  state.currentTroops = {
    BASILEUS: { normal: 1, capitalLocked: 0 },
    DOM_EAST: { normal: 1, capitalLocked: 0 },
    DOM_WEST: { normal: 1, capitalLocked: 0 },
    ADMIRAL: { normal: 1, capitalLocked: 0 },
  };

  const humanSubmit = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { funded: 1, destination: 'capital' } },
    mercenaries: { count: 0, destination: 'frontier' },
    candidate: 0,
  });
  assert.equal(humanSubmit.ok, true);

  const plans = buildSimultaneousAIOrders(state, meta);

  assert.deepEqual(plans.map((plan) => plan.playerId).sort(), [1, 2, 3]);
  assert.equal(Object.hasOwn(state.allOrders, 1), false);
});

test('AI title planning returns a legal title redistribution action', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  state.phase = 'title_redistribution';

  const action = planMajorTitleAssignment(state, meta, state.basileusId);

  assert.equal(action.kind, 'title-assignment');
  assert.equal(validateMajorTitleAssignments(state, state.basileusId, action.assignments).ok, true);
});
