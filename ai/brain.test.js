import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { buildFinalScores } from '../engine/scoring.js';
import { setDealParticipantIds } from '../engine/deals.js';
import { submitHumanOrders } from '../engine/commands.js';
import {
  advanceToNextInteractivePhase,
  phaseOrders,
} from '../engine/turnflow.js';
import {
  buildAIOrders,
  buildSimultaneousAIOrders,
  chooseAIDefenderRewardChoice,
  createAIMeta,
  getRecentPublicLog,
  hydrateAiOpponent,
  isAIPlayer,
  loadBrowserAiOpponentRoster,
  observeCourtAction,
  planMajorTitleAssignment,
  runAICourtAutomation,
} from './brain.js';
import {
  handleContinueAfterResolution,
  runAiRuntime,
  startInteractiveRuntime,
} from '../engine/runtime.js';
import {
  AI_DEALS_ENABLED,
  applyLegalAction,
  listLegalCourtActions,
  listLegalOrderActions,
  listLegalRewardActions,
  listLegalTitleAssignments,
} from './legalActions.js';
import { summarizeOrders } from './evaluation.js';
import {
  PLACEHOLDER_AI_OPPONENTS,
  loadOpponentByIdSync,
  loadOpponentRosterSync,
} from './opponentRoster.js';

function prepareInteractiveState(options = {}) {
  const state = createGameState({
    playerCount: options.playerCount || 4,
    deckSize: options.deckSize || 2,
    seed: options.seed || 11,
    historyEnabled: false,
  });
  setDealParticipantIds(state, state.players.map((player) => player.id));
  advanceToNextInteractivePhase(state);
  return state;
}

function cloneState(state) {
  const clone = JSON.parse(JSON.stringify(state));
  clone.rng = state.rng;
  if (state.courtActions) {
    clone.courtActions = {
      ...clone.courtActions,
      playerConfirmed: new Set([...(state.courtActions.playerConfirmed || new Set())]),
    };
  }
  return clone;
}

test('AI metadata preserves human and strategic AI seat boundaries', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 11 });
  const meta = createAIMeta(state, { humanPlayerIds: [1] });

  assert.equal(meta.placeholderOnly, false);
  assert.equal(meta.humanPlayerIds.has(1), true);
  assert.equal(isAIPlayer(meta, 0), true);
  assert.equal(isAIPlayer(meta, 1), false);
  assert.equal(meta.players[0].opponent.id, 'placeholder-1');
  assert.equal(meta.players[0].opponent.placeholder, true);
  assert.equal(typeof meta.players[0].displayName, 'string');
});

test('built-in AI placeholder roster keeps Greek names available', () => {
  const roster = loadOpponentRosterSync();
  assert.equal(roster.length, PLACEHOLDER_AI_OPPONENTS.length);
  assert.equal(roster[0].id, 'placeholder-1');
  assert.equal(roster[0].firstName, 'Achilleus');
  assert.equal(loadOpponentByIdSync('placeholder-2').firstName, 'Alexandros');
  assert.equal(loadOpponentByIdSync('missing', 2).id, 'placeholder-3');
  assert.equal(hydrateAiOpponent('placeholder-4').placeholder, true);
});

test('browser opponent roster falls back to local placeholders', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });

  try {
    const roster = await loadBrowserAiOpponentRoster('/missing');
    assert.equal(roster.length, PLACEHOLDER_AI_OPPONENTS.length);
    await assert.rejects(
      () => loadBrowserAiOpponentRoster('/missing', { required: true }),
      /Could not list AI placeholders/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('strategic court automation acts before confirming during finish mode', () => {
  const state = prepareInteractiveState({ seed: 21 });
  const meta = createAIMeta(state, { humanPlayerIds: [1] });

  const reactive = runAICourtAutomation(state, meta, { mode: 'react' });
  assert.ok(reactive.actions > 0);
  for (const player of state.players.filter((entry) => entry.id !== 1)) {
    assert.equal(state.courtActions.playerConfirmed.has(player.id), false);
  }

  const finishing = runAICourtAutomation(state, meta, { mode: 'finish' });
  assert.ok(finishing.actions > 3);
  for (const player of state.players.filter((entry) => entry.id !== 1)) {
    assert.equal(state.courtActions.playerConfirmed.has(player.id), true);
  }
  assert.equal(state.courtActions.playerConfirmed.has(1), false);
  assert.ok(Object.keys(state.pendingProfessionalArmies || {}).length > 0);
  assert.ok(Object.keys(state.landAuctions || {}).length > 0);
  assert.ok(meta.decisionLog.lines.some((line) => line.includes(':ai:')));
});

test('strategic court automation is not stopped by the old small per-seat cap', () => {
  const state = prepareInteractiveState({ playerCount: 3, seed: 21 });
  const meta = createAIMeta(state, { humanPlayerIds: [] });

  runAICourtAutomation(state, meta, { mode: 'finish' });
  const realCourtActions = meta.decisionLog.lines
    .filter((line) => line.includes(':ai:') && !line.endsWith(':confirm'));

  assert.ok(realCourtActions.length > state.players.length * 4);
});

test('strategic AI orders submit legal scored orders', () => {
  const state = prepareInteractiveState({ seed: 23 });
  phaseOrders(state);

  const aiPlayerId = 2;
  assert.ok(listLegalOrderActions(state, aiPlayerId).length > 0);

  const meta = createAIMeta(state, { humanPlayerIds: [1] });
  const orders = buildAIOrders(state, meta, aiPlayerId);
  const result = submitHumanOrders(state, aiPlayerId, orders);

  assert.equal(result.ok, true);
  assert.ok(state.allOrders[aiPlayerId]);
  assert.equal(orders.debug.decision.factors[0].label, 'projected score');
  assert.ok(orders.debug.decision.factors.some((factor) => factor.label === 'frontier'));
});

test('strategic AI commits movable troops to a threatened frontier', () => {
  const state = prepareInteractiveState({ seed: 41 });
  phaseOrders(state);

  const aiPlayerId = 2;
  const meta = createAIMeta(state, { humanPlayerIds: [1] });
  const orders = buildAIOrders(state, meta, aiPlayerId);
  const summary = summarizeOrders(state, aiPlayerId, orders);

  assert.equal(summary.offices.some((entry) => entry.officeKey === 'ADMIRAL'), true);
  assert.ok(summary.frontierTroops > 0);
});

test('strategic AI does not always dump movable troops into the frontier', () => {
  const state = prepareInteractiveState({ seed: 21 });
  phaseOrders(state);

  const aiPlayerId = 2;
  const meta = createAIMeta(state, { humanPlayerIds: [1] });
  const orders = buildAIOrders(state, meta, aiPlayerId);
  const summary = summarizeOrders(state, aiPlayerId, orders);

  assert.equal(summary.offices.some((entry) => entry.officeKey === 'ADMIRAL'), true);
  assert.ok(summary.capitalTroops > 0);
  assert.ok(summary.frontierTroops < summary.totalTroops);
});

test('simultaneous strategic order planning ignores already submitted human orders', () => {
  const state = prepareInteractiveState({ seed: 24 });
  const cleanState = prepareInteractiveState({ seed: 24 });
  phaseOrders(state);
  phaseOrders(cleanState);
  const humanId = 1;
  const aiPlayerId = state.players.find((player) => player.id !== humanId).id;
  const humanAction = listLegalOrderActions(state, humanId).find((action) => action.orders.candidate === humanId);
  assert.ok(humanAction);
  assert.equal(applyLegalAction(state, humanAction).ok, true);

  const meta = createAIMeta(state, { humanPlayerIds: [humanId] });
  const cleanMeta = createAIMeta(cleanState, { humanPlayerIds: [humanId] });
  const planned = buildSimultaneousAIOrders(state, meta).find((entry) => entry.playerId === aiPlayerId);
  const independentlyPlanned = buildSimultaneousAIOrders(cleanState, cleanMeta).find((entry) => entry.playerId === aiPlayerId);

  assert.deepEqual(planned.orders.deployments, independentlyPlanned.orders.deployments);
  assert.equal(planned.orders.candidate, independentlyPlanned.orders.candidate);
});

test('generated court and order actions are accepted by engine validators', () => {
  const state = prepareInteractiveState({ seed: 21 });
  const courtActions = listLegalCourtActions(state, state.basileusId);
  assert.ok(courtActions.length > 0);
  for (const action of courtActions.slice(0, 30)) {
    const result = applyLegalAction(cloneState(state), action);
    assert.equal(result.ok, true, action.label);
  }

  for (const player of state.players) {
    const confirm = listLegalCourtActions(state, player.id).find((action) => action.kind === 'court-confirm');
    assert.ok(confirm);
    assert.equal(applyLegalAction(state, confirm).ok, true);
  }
  phaseOrders(state);

  const orderActions = listLegalOrderActions(state, 0);
  assert.ok(orderActions.length > 0);
  for (const action of orderActions.slice(0, 20)) {
    const result = applyLegalAction(cloneState(state), action);
    assert.equal(result.ok, true, action.label);
  }
});

test('generated reward and title-assignment actions are legal', () => {
  const state = prepareInteractiveState({ playerCount: 4, seed: 31 });
  state.phase = 'resolution';
  state.nextBasileusId = state.players.find((player) => player.id !== state.basileusId).id;

  const titleActions = listLegalTitleAssignments(state, state.nextBasileusId);
  assert.ok(titleActions.length > 0);
  assert.equal(applyLegalAction(cloneState(state), titleActions[0]).ok, true);

  const rewardState = prepareInteractiveState({ seed: 32 });
  rewardState.phase = 'resolution';
  rewardState.pendingDefenderRewards = [{
    id: 'test-reward',
    themeId: 'OPS',
    originalThemeId: 'OPS',
    defenderId: 0,
    rank: 1,
    troops: 4,
    goldValue: 2,
    resolved: false,
  }];
  const rewardActions = listLegalRewardActions(rewardState, 0);
  assert.equal(rewardActions.length, 2);
  for (const action of rewardActions) {
    assert.equal(applyLegalAction(cloneState(rewardState), action).ok, true);
  }
});

test('strategic title assignment picks a legal assignment when needed', () => {
  const state = prepareInteractiveState({ playerCount: 4, seed: 41 });
  state.phase = 'resolution';
  state.nextBasileusId = state.players.find((player) => player.id !== state.basileusId).id;
  const meta = createAIMeta(state, { humanPlayerIds: [state.basileusId] });

  const action = planMajorTitleAssignment(state, meta, state.nextBasileusId);
  assert.equal(action?.kind, 'title-assignment');
  assert.equal(applyLegalAction(cloneState(state), action, meta).ok, true);
});

test('strategic title assignment denies Patriarch to the leading opponent', () => {
  const state = prepareInteractiveState({ playerCount: 4, seed: 41 });
  state.phase = 'resolution';
  state.nextBasileusId = state.players.find((player) => player.id !== state.basileusId).id;
  const leaderId = buildFinalScores(state).scores.find((score) => score.playerId !== state.nextBasileusId).playerId;
  const meta = createAIMeta(state, { humanPlayerIds: [state.basileusId] });

  const action = planMajorTitleAssignment(state, meta, state.nextBasileusId);

  assert.equal(action?.kind, 'title-assignment');
  assert.notEqual(action.assignments.PATRIARCH, leaderId);
});

test('strategic defender reward can choose gold when it improves self-interest', () => {
  const state = prepareInteractiveState({ seed: 32 });
  state.phase = 'resolution';
  state.pendingDefenderRewards = [{
    id: 'test-reward',
    themeId: 'OPS',
    originalThemeId: 'OPS',
    defenderId: 0,
    rank: 1,
    troops: 4,
    goldValue: 4,
    resolved: false,
  }];
  const meta = createAIMeta(state, { humanPlayerIds: [1] });

  assert.equal(chooseAIDefenderRewardChoice(state, meta, state.pendingDefenderRewards[0]), 'gold');
});

test('generic AI deal action expansion remains disabled', () => {
  assert.equal(AI_DEALS_ENABLED, false);
});

test('strategic metadata records observations without an opinion model', () => {
  const state = prepareInteractiveState({ seed: 51 });
  const meta = createAIMeta(state, { humanPlayerIds: [1] });

  observeCourtAction(state, meta, {
    type: 'appointment',
    actorId: 1,
    appointeeId: 0,
    previousHolderId: 2,
    value: 1,
  });

  assert.equal(getRecentPublicLog(meta).length, 1);
  assert.equal(meta.players[0].trust, undefined);
  assert.equal(meta.players[0].grievance, undefined);
});

test('official final scoring remains category-share based', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 1, seed: 93 });
  const final = buildFinalScores(state);
  assert.equal(final.scores.length, 3);
  assert.equal(final.scores[0].categories.length, 4);
});

test('strategic AI smoke games complete for supported player counts', () => {
  for (const playerCount of [3, 4, 5]) {
    const state = createGameState({
      playerCount,
      deckSize: 1,
      seed: 800 + playerCount,
      historyEnabled: false,
    });
    setDealParticipantIds(state, state.players.map((player) => player.id));
    const meta = createAIMeta(state, { humanPlayerIds: [] });
    const context = { pendingAiTitleAssignment: null };
    startInteractiveRuntime(state, meta, context);

    let guard = 0;
    while (!state.gameOver && state.phase !== 'scoring' && guard < 12) {
      guard += 1;
      if (state.phase === 'resolution') {
        const result = handleContinueAfterResolution(state, meta, context);
        assert.equal(result.ok, true, result.reason);
      } else {
        runAiRuntime(state, meta, context, { courtMode: 'finish' });
      }
    }

    assert.ok(state.gameOver || state.phase === 'scoring');
    assert.equal(buildFinalScores(state).scores.length, playerCount);
  }
});
