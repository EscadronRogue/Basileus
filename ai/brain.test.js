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

test('deployment submission rejects implicit army, claimant, and mercenary defaults', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.currentTroops = {
    BASILEUS: { normal: 2, capitalLocked: 0 },
  };

  const missingArmy = submitHumanOrders(state, 0, {
    mercenaries: { count: 0, destination: 'frontier' },
    candidate: 0,
  });
  assert.equal(missingArmy.ok, false);
  assert.match(missingArmy.reason, /funding/);

  const missingCandidate = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { funded: 2, destination: 'frontier' } },
    mercenaries: { count: 0, destination: 'frontier' },
  });
  assert.equal(missingCandidate.ok, false);
  assert.match(missingCandidate.reason, /candidate/);

  const missingMercenaryDestination = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { funded: 2, destination: 'frontier' } },
    mercenaries: { count: 1 },
    candidate: 0,
  });
  assert.equal(missingMercenaryDestination.ok, false);
  assert.match(missingMercenaryDestination.reason, /mercenaries/);
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

test('AI court legal actions use the shared two-action court power limit', () => {
  const state = makeState();
  state.themes.KAP.strategos = 3;
  state.phase = 'income';
  phaseCourt(state);

  const appointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(appointment.ok, true);

  const appointmentModeActions = listLegalCourtActions(state, 1);
  assert.equal(appointmentModeActions.some((action) => action.payload?.action === 'appoint-strategos'), true);
  assert.equal(appointmentModeActions.some((action) => action.payload?.action === 'revoke' && action.payload?.value === 'minor:KAP:strategos'), true);
  assert.equal(appointmentModeActions.some((action) => action.payload?.action === 'revoke' && action.payload?.value === 'minor:OPS:strategos'), false);

  const revokeState = makeState();
  revokeState.themes.OPS.strategos = 2;
  revokeState.phase = 'income';
  phaseCourt(revokeState);

  const revocation = applyCourtAction(revokeState, 1, { action: 'revoke', value: 'minor:OPS:strategos' });
  assert.equal(revocation.ok, true);

  const revocationModeActions = listLegalCourtActions(revokeState, 1);
  assert.equal(revocationModeActions.some((action) => action.payload?.action === 'appoint-strategos'), true);
});

test('AI court planner uses another appointment to unlock future self-appointments', () => {
  const state = makeState();
  state.players[1].appointmentCooldown = { selfLocked: true, lastAppointeeId: 1 };
  state.phase = 'income';
  phaseCourt(state);
  const meta = createAIMeta(state, {
    humanPlayerIds: [0, 2, 3],
    aiPlayers: {
      1: {
        policy: {
          policyId: 'tuned',
          strategyWeights: {
            rivalDenial: 0.7,
            appointmentUnlockBonus: 4,
          },
        },
      },
    },
  });

  const result = runAICourtAutomation(state, meta, { mode: 'finish' });
  const firstAppointment = state.history.find((event) => (
    ['appoint_strategos', 'appoint_bishop', 'appoint_court_title'].includes(event.type)
    && event.actorId === 1
  ));

  assert.equal(result.ok, true);
  assert.equal(Boolean(firstAppointment), true);
  assert.notEqual(firstAppointment.details.appointeeId, 1);
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
  assert.equal(result.options.opponentMix, 'robust');
  assert.equal(result.options.selfPlayEvery, 3);
  assert.deepEqual(result.options.playerCounts, [3, 4, 5]);
  assert.deepEqual(result.options.deckSizes, [1, 2]);
  assert.notEqual(result.options.seed, second.options.seed);
  assert.equal(Number.isFinite(result.best.metrics.objective), true);
  assert.equal(typeof result.best.weights.invasionMargin, 'number');
  assert.equal(typeof result.best.weights.appointmentUnlockBonus, 'number');
  assert.equal(typeof result.best.metrics.appointmentUnlockRate, 'number');
  assert.equal(result.saved, undefined);
});

test('AI training beginner mix preserves the original opponent proportions', () => {
  const result = trainStrategyWeights({
    opponentMix: 'beginner',
    generations: 1,
    population: 2,
    elite: 1,
    games: 1,
    playerCounts: [3],
    deckSizes: [1],
    save: false,
  });

  assert.equal(result.options.selfPlayEvery, 4);
  assert.equal(result.options.opponentSummary.exposure.selfPlay, 0.25);
  assert.equal(result.options.opponentSummary.exposure.random, 0.125);
  assert.equal(result.options.opponentSummary.exposure.copycat, 0.125);
});

test('AI training can save Greek-named tuned champions', () => {
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
    assert.equal(payload.opponents.length, 2);
    assert.equal(result.saved.opponents.length, 2);
    assert.equal(result.champions.length, 2);
    assert.equal(GREEK_FIRST_NAMES.includes(payload.opponents[0].firstName), true);
    assert.equal(payload.opponents[0].policy.policyId, 'tuned');
    assert.equal(typeof payload.opponents[0].strategyWeights.invasionMargin, 'number');
    assert.equal(typeof payload.opponents[0].training.appointmentUnlockRate, 'number');
    assert.equal(typeof payload.opponents[0].training.screeningGamesPerCandidate, 'number');
    assert.equal(payload.opponents[0].training.championRank, 1);
    assert.equal(payload.opponents[1].training.championRank, 2);
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

function coalitionWeights() {
  return {
    selfClaim: 0.2,
    coalitionWillingness: 2.2,
    relationshipCoupWeight: 1.8,
    favorSeekingWeight: 1.2,
    supportLeaderPenalty: 1.8,
    supportOtherClaimant: 0.2,
    selfClaimThreshold: 1.6,
  };
}

function prepareCoalitionDeploymentState() {
  const state = makeState();
  state.phase = 'deployment';
  state.currentTroops = {
    BASILEUS: { normal: 4, capitalLocked: 0 },
    DOM_EAST: { normal: 1, capitalLocked: 0 },
    DOM_WEST: { normal: 1, capitalLocked: 0 },
    ADMIRAL: { normal: 1, capitalLocked: 0 },
  };
  return state;
}

test('AI coup coalition planning rallies weak AI seats behind one friendly claimant', () => {
  const state = prepareCoalitionDeploymentState();
  state.history.push(
    { id: 'h1', index: 1, round: 1, phase: 'court', category: 'court', type: 'appoint_strategos', actorId: 2, details: { appointeeId: 1 } },
    { id: 'h2', index: 2, round: 1, phase: 'court', category: 'court', type: 'appoint_strategos', actorId: 2, details: { appointeeId: 3 } },
  );
  const weights = coalitionWeights();
  const meta = createAIMeta(state, {
    humanPlayerIds: [0],
    aiPlayers: {
      1: { policy: { policyId: 'tuned', strategyWeights: weights } },
      2: { policy: { policyId: 'tuned', strategyWeights: weights } },
      3: { policy: { policyId: 'tuned', strategyWeights: weights } },
    },
  });

  const plans = buildSimultaneousAIOrders(state, meta);

  assert.deepEqual(plans.map((plan) => [plan.playerId, plan.orders.candidate]), [[1, 2], [2, 2], [3, 2]]);
});

test('AI coup coalition planning can support a human claimant with good relations', () => {
  const state = prepareCoalitionDeploymentState();
  state.currentTroops.ADMIRAL = { normal: 2, capitalLocked: 0 };
  state.history.push(
    { id: 'h1', index: 1, round: 1, phase: 'court', category: 'court', type: 'appoint_strategos', actorId: 3, details: { appointeeId: 1 } },
    { id: 'h2', index: 2, round: 1, phase: 'court', category: 'court', type: 'appoint_strategos', actorId: 3, details: { appointeeId: 2 } },
  );
  const weights = coalitionWeights();
  const meta = createAIMeta(state, {
    humanPlayerIds: [0, 3],
    aiPlayers: {
      1: { policy: { policyId: 'tuned', strategyWeights: weights } },
      2: { policy: { policyId: 'tuned', strategyWeights: weights } },
    },
  });

  const plans = buildSimultaneousAIOrders(state, meta);

  assert.deepEqual(plans.map((plan) => [plan.playerId, plan.orders.candidate]), [[1, 3], [2, 3]]);
});

test('tuned deployment turns safe frontier surplus into coup pressure', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.currentInvasion = {
    id: 'test_invasion',
    name: 'Test invasion',
    strength: [4, 6],
    route: ['OPS', 'OPT', 'CPL'],
  };
  state.currentTroops = {
    BASILEUS: { normal: 6, capitalLocked: 0 },
    DOM_EAST: { normal: 6, capitalLocked: 0 },
    DOM_WEST: { normal: 6, capitalLocked: 0 },
    ADMIRAL: { normal: 6, capitalLocked: 0 },
  };
  const meta = createAIMeta(state, {
    humanPlayerIds: [0, 2, 3],
    aiPlayers: {
      1: {
        policy: {
          policyId: 'tuned',
          strategyWeights: {
            invasionMargin: 2.4,
            capitalFallPenalty: 665.876428553347,
            capitalRiskPenalty: 48.353426978309265,
            throneBase: 13.837714739693313,
            selfClaim: 0.19356171899110766,
            supportOtherClaimant: 0.12764954809536314,
            relationshipCoupWeight: 0.31294053312187564,
            surplusDefensePenalty: 0.4,
            frontierSurplusValue: 0.35,
            frontierSurplusCap: 6,
            coupOpportunityWeight: 0.75,
            allyDefenseReliance: 0.82,
          },
        },
      },
    },
  });

  const orders = buildAIOrders(state, meta, 1);
  const fundedFrontier = Object.values(orders.armies)
    .filter((entry) => entry.destination === 'frontier')
    .reduce((total, entry) => total + entry.funded, 0);
  const capitalMercs = orders.mercenaries.destination === 'capital' ? orders.mercenaries.count : 0;

  assert.equal(orders.candidate, 1);
  assert.equal(fundedFrontier < state.currentTroops.DOM_EAST.normal, true);
  assert.equal(capitalMercs > 0 || Object.values(orders.armies).some((entry) => entry.destination === 'capital' && entry.funded > 0), true);
});

test('AI title planning returns a legal title redistribution action', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  state.phase = 'title_redistribution';

  const action = planMajorTitleAssignment(state, meta, state.basileusId);

  assert.equal(action.kind, 'title-assignment');
  assert.equal(validateMajorTitleAssignments(state, state.basileusId, action.assignments).ok, true);
});
