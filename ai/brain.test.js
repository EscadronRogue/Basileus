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
  handleContinueAfterResolution,
  handleManualTitleReassignment,
  startInteractiveRuntime,
} from '../engine/runtime.js';
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
import { getAiMemory, getRelationship } from './memory.js';
import { normalizeTunedOpponentRoster } from './opponentRoster.js';
import { simulateGames } from './simulate.js';
import { scoreAggregateTrainingShape, trainStrategyWeights } from './train.js';
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

function capitalTroopsFromOrders(orders) {
  const armyCapital = Object.values(orders.armies || {}).reduce((total, order) => (
    total + (order.destination === 'capital' ? Number(order.funded) || 0 : 0)
  ), 0);
  const mercenaryCapital = orders.mercenaries?.destination === 'capital'
    ? Number(orders.mercenaries.count) || 0
    : 0;
  return armyCapital + mercenaryCapital;
}

function frontierTroopsFromOrders(orders) {
  const armyFrontier = Object.values(orders.armies || {}).reduce((total, order) => (
    total + (order.destination === 'frontier' ? Number(order.funded) || 0 : 0)
  ), 0);
  const mercenaryFrontier = orders.mercenaries?.destination === 'frontier'
    ? Number(orders.mercenaries.count) || 0
    : 0;
  return armyFrontier + mercenaryFrontier;
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
    const policyIds = roster.map((entry) => entry.policy?.policyId);
    assert.equal(policyIds.includes('patron'), true);
    assert.equal(policyIds.includes('tyrant'), true);
    assert.equal(policyIds.includes('kingmaker'), true);
    assert.equal(policyIds.includes('freeRider'), true);
    assert.equal(policyIds.includes('overDefender'), true);
    assert.equal(policyIds.includes('estateShark'), true);
    assert.equal(policyIds.includes('antiLeader'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy tuned AI roster migrates to reserve-aware deployment weights', () => {
  const roster = normalizeTunedOpponentRoster({
    opponents: [{
      id: 'tuned-legacy',
      firstName: 'Legacy',
      policy: {
        policyId: 'tuned',
        strategyWeights: {
          invasionShortfallPenalty: 1.2,
          capitalRiskPenalty: 40,
          reserveValue: 0.1,
          mercenaryCostPenalty: 0.5,
        },
      },
      training: { objectiveVersion: 6 },
    }],
  });

  const weights = roster[0].policy.strategyWeights;

  assert.equal(weights.invasionShortfallPenalty >= 4.2, true);
  assert.equal(weights.capitalRiskPenalty >= 120, true);
  assert.equal(weights.reserveValue >= 0.35, true);
  assert.equal(weights.mercenaryCostPenalty <= 0.32, true);
});

test('strategic court automation only controls AI players', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  state.themes.SAM.owner = 1;
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

test('human basileus title confirmation runs AI court when basileus has no actions', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  state.round = 1;
  state.phase = 'title_redistribution';

  const result = handleManualTitleReassignment(state, meta, {}, 0, {
    DOM_EAST: 1,
    PATRIARCH: 1,
    DOM_WEST: 2,
    ADMIRAL: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(state.phase, 'estates');
  assert.equal(state.courtActions.playerConfirmed.size, state.players.length);
});

test('initial human basileus with skipped redistribution lets AI finish court', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  const context = {};

  const result = startInteractiveRuntime(state, meta, context);

  assert.equal(result.ok, true);
  assert.equal(state.round, 1);
  assert.equal(state.majorTitleRedistributionPending, false);
  assert.equal(state.phase, 'estates');
  assert.equal(state.courtActions.playerConfirmed.size, state.players.length);
});

test('initial human office holder keeps court interactive before AI finishes', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [1] });

  const result = startInteractiveRuntime(state, meta, {});

  assert.equal(result.ok, true);
  assert.equal(state.phase, 'court');
  assert.equal(state.courtActions.playerConfirmed.has(1), false);
});

test('post-resolution human basileus with no court actions lets AI finish court', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  state.round = 1;
  state.phase = 'resolution';
  state.nextBasileusId = state.basileusId;

  const result = handleContinueAfterResolution(state, meta, {});

  assert.equal(result.ok, true);
  assert.equal(state.round, 2);
  assert.equal(state.majorTitleRedistributionPending, false);
  assert.equal(state.phase, 'estates');
  assert.equal(state.courtActions.playerConfirmed.size, state.players.length);
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
  assert.deepEqual(orders.ranking.slice(0, 1), [1]);
  assert.equal(orders.ranking.length, state.players.length);
  assert.equal(orders.mercenaries.count >= 0, true);
  assert.equal(orders.armies.DOM_EAST.funded >= 0, true);
  assert.equal(orders.armies.PATRIARCH.funded >= 0, true);
  assert.equal(orders.debug.decision.title.includes('strategic'), true);
  assert.equal(orders.debug.decision.factors[0].label, 'frontier');
});

test('AI coup support blocks the two least-liked claimants in 5-player games', () => {
  const state = createGameState({ playerCount: 5, deckSize: 1, seed: 22, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  for (const player of state.players) player.majorTitles = [];
  state.players[1].majorTitles = ['DOM_EAST'];
  state.round = 2;
  state.phase = 'deployment';
  state.currentTroops = {
    DOM_EAST: { normal: 3, capitalLocked: 0 },
  };
  state.history.push(
    { id: 'h1', index: 1, round: 1, phase: 'court', category: 'court', type: 'revoke_minor_title', actorId: 3, details: { revokedPlayerId: 1, revokedPlayerIds: [1] } },
    { id: 'h2', index: 2, round: 1, phase: 'court', category: 'court', type: 'revoke_theme', actorId: 4, details: { revokedPlayerId: 1, revokedPlayerIds: [1] } },
  );
  const meta = createAIMeta(state, { humanPlayerIds: [0, 2, 3, 4] });

  const orders = buildAIOrders(state, meta, 1);

  assert.equal(orders.candidateSupport[1], true);
  assert.equal(orders.candidateSupport[0], true);
  assert.equal(orders.candidateSupport[2], true);
  assert.equal(orders.candidateSupport[3], false);
  assert.equal(orders.candidateSupport[4], false);
});

test('AI coup support blocks the single least-liked claimant in 3-player games', () => {
  const state = createGameState({ playerCount: 3, deckSize: 1, seed: 23, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  for (const player of state.players) player.majorTitles = [];
  state.players[1].majorTitles = ['DOM_EAST'];
  state.round = 2;
  state.phase = 'deployment';
  state.currentTroops = {
    DOM_EAST: { normal: 3, capitalLocked: 0 },
  };
  state.history.push(
    { id: 'h1', index: 1, round: 1, phase: 'court', category: 'court', type: 'revoke_minor_title', actorId: 2, details: { revokedPlayerId: 1, revokedPlayerIds: [1] } },
  );
  const meta = createAIMeta(state, { humanPlayerIds: [0, 2] });

  const orders = buildAIOrders(state, meta, 1);

  assert.equal(orders.candidateSupport[1], true);
  assert.equal(orders.candidateSupport[0], true);
  assert.equal(orders.candidateSupport[2], false);
});

test('AI memory values major title quality instead of treating every title as equal', () => {
  const state = createGameState({ playerCount: 5, deckSize: 1, seed: 24, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  state.round = 2;
  for (const theme of Object.values(state.themes)) {
    if (theme.id === 'CPL') continue;
    theme.occupied = false;
    theme.strategos = null;
    theme.bishop = null;
    theme.T = theme.region === 'east' ? 6 : 1;
    theme.C = 0;
  }
  state.history.push({
    id: 'h1',
    index: 1,
    round: 1,
    phase: 'title_redistribution',
    category: 'system',
    type: 'title_redistribution',
    actorId: 0,
    details: {
      assignments: {
        DOM_EAST: { playerId: 1 },
        DOM_WEST: { playerId: 2 },
        ADMIRAL: { playerId: 3 },
        PATRIARCH: { playerId: 4 },
      },
    },
  });

  const memory = getAiMemory(state);
  const favored = getRelationship(memory, 1, 0);
  const slighted = getRelationship(memory, 4, 0);

  assert.equal(favored.titleFavor > slighted.titleFavor, true);
  assert.equal(slighted.titleJealousy > 0, true);
  assert.equal(favored.score > slighted.score, true);
});

test('AI deployment creates urgent opposition to a hostile incumbent Basileus', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.currentInvasion = {
    id: 'test_invasion',
    name: 'Test invasion',
    strength: [1, 2],
    route: ['OPS', 'CPL'],
  };
  for (const player of state.players) player.gold = 8;
  state.currentTroops = {
    BASILEUS: { normal: 3, capitalLocked: 0 },
    DOM_EAST: { normal: 5, capitalLocked: 0 },
    DOM_WEST: { normal: 2, capitalLocked: 0 },
    ADMIRAL: { normal: 2, capitalLocked: 0 },
    PATRIARCH: { normal: 2, capitalLocked: 0 },
  };
  state.history.push(
    { id: 'h1', index: 1, round: 1, phase: 'court', category: 'court', type: 'revoke_theme', actorId: 0, details: { revokedPlayerId: 1, revokedPlayerIds: [1] } },
    { id: 'h2', index: 2, round: 1, phase: 'court', category: 'court', type: 'revoke_minor_title', actorId: 0, details: { revokedPlayerId: 1, revokedPlayerIds: [1] } },
  );
  const meta = createAIMeta(state, {
    humanPlayerIds: [0, 2, 3],
    aiPlayers: {
      1: {
        policy: {
          policyId: 'tuned',
          strategyWeights: {
            selfClaim: 0.7,
            supportOtherClaimant: 1.1,
            relationshipCoupWeight: 1.4,
            coupOpportunityWeight: 0.9,
            basileusRevocationFear: 2,
            regimeTreatmentWeight: 1.5,
            regimeUrgencyWeight: 2,
            allyDefenseReliance: 0.9,
          },
        },
      },
    },
  });

  const orders = buildAIOrders(state, meta, 1);
  const regimeFactor = orders.debug.decision.factors.find((factor) => factor.label === 'regime');

  assert.equal(orders.candidateSupport[0], false);
  assert.notEqual(orders.candidate, 0);
  assert.equal(capitalTroopsFromOrders(orders) > 0, true);
  assert.equal(regimeFactor.value > 0, true);
});

function makeReserveDeploymentState(strength, route = ['OPS', 'CPL']) {
  const state = createGameState({ playerCount: 4, deckSize: 2, seed: 41, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  for (const player of state.players) {
    player.majorTitles = [];
    player.gold = 1;
  }
  state.players[1].majorTitles = ['DOM_EAST'];
  state.phase = 'deployment';
  state.currentInvasion = {
    id: 'test_invasion',
    name: 'Test invasion',
    strength,
    route,
  };
  state.currentTroops = {
    DOM_EAST: { normal: 6, capitalLocked: 0 },
  };
  return state;
}

const RESERVE_DEPLOYMENT_WEIGHTS = {
  reserveValue: 1.2,
  estateProfit: 8,
  estateBidCost: 0.6,
  invasionShortfallPenalty: 8,
  invasionSafetyValue: 0.2,
  invasionSurplusPenalty: 1.4,
  capitalFallPenalty: 800,
  capitalRiskPenalty: 200,
  throneBase: 2,
  selfClaim: 0.1,
  supportOtherClaimant: 0.1,
  coupOpportunityWeight: 0.05,
  mercenaryCostPenalty: 0.3,
};

function makeReserveDeploymentMeta(state) {
  return createAIMeta(state, {
    humanPlayerIds: [0, 2, 3],
    aiPlayers: {
      1: {
        policy: {
          policyId: 'tuned',
          strategyWeights: RESERVE_DEPLOYMENT_WEIGHTS,
        },
      },
    },
  });
}

test('AI deployment defunds surplus troops when frontier and coup urgency are low', () => {
  const state = makeReserveDeploymentState([1, 1]);
  const meta = makeReserveDeploymentMeta(state);

  const orders = buildAIOrders(state, meta, 1);
  const funded = Number(orders.armies.DOM_EAST.funded) || 0;

  assert.equal(funded < state.currentTroops.DOM_EAST.normal, true);
  assert.equal(state.currentTroops.DOM_EAST.normal - funded > 0, true);
  assert.equal(frontierTroopsFromOrders(orders) > 0, true);
});

test('AI deployment keeps funding troops when underfunding risks Constantinople', () => {
  const state = makeReserveDeploymentState([7, 9]);
  const meta = makeReserveDeploymentMeta(state);

  const orders = buildAIOrders(state, meta, 1);

  assert.equal(orders.armies.DOM_EAST.funded, state.currentTroops.DOM_EAST.normal);
  assert.equal(frontierTroopsFromOrders(orders) >= state.currentTroops.DOM_EAST.normal, true);
});

test('deployment submission rejects implicit army and mercenary defaults', () => {
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

  const defaultRanking = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { funded: 2, destination: 'frontier' } },
    mercenaries: { count: 0, destination: 'frontier' },
  });
  assert.equal(defaultRanking.ok, true);
  assert.deepEqual(defaultRanking.orders.ranking, [0, 1, 2, 3]);
  delete state.allOrders[0];

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
    ['appoint_strategos', 'appoint_bishop'].includes(event.type)
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
  assert.equal(typeof result.best.weights.invasionShortfallPenalty, 'number');
  assert.equal(typeof result.best.weights.appointmentUnlockBonus, 'number');
  assert.equal(typeof result.best.metrics.appointmentUnlockRate, 'number');
  assert.equal(typeof result.best.metrics.frontierTroopsPerOrder, 'number');
  assert.equal(typeof result.best.metrics.invasionDefeatRate, 'number');
  assert.equal(result.saved, undefined);
});

test('AI training fall pressure is centered around 50 percent', () => {
  const options = { fallPenalty: 220 };
  const baseMetrics = {
    selfClaimRate: 0.16,
    credibleSelfClaimRate: 0.16,
    averageWarMargin: 4,
    fundedTroopsPerOrder: 4,
  };
  const scoreAt = (fallRate) => scoreAggregateTrainingShape({ ...baseMetrics, fallRate }, options);

  assert.equal(scoreAt(0.5) > scoreAt(0.25), true);
  assert.equal(scoreAt(0.5) > scoreAt(0.75), true);
  assert.equal(scoreAt(0.5) - scoreAt(0.25) > 100, true);
  assert.equal(scoreAt(0.25) > scoreAt(0.1), true);
  assert.equal(scoreAt(0.75) > scoreAt(0.9), true);
});

test('AI training fall pressure sanctions directional behavior', () => {
  const options = { fallPenalty: 220 };
  const balanced = {
    averageWarMargin: 3,
    invasionDefeatRate: 0.25,
    frontierTroopsPerOrder: 2.4,
    capitalTroopsPerOrder: 0.8,
    idleTroopsPerOrder: 1,
    fundedTroopsPerOrder: 4,
    selfClaimRate: 0.16,
    credibleSelfClaimRate: 0.16,
  };
  const prudent = {
    ...balanced,
    averageWarMargin: 8,
    invasionDefeatRate: 0.05,
    frontierTroopsPerOrder: 5,
    capitalTroopsPerOrder: 0.1,
    idleTroopsPerOrder: 0.1,
    fundedTroopsPerOrder: 6,
    selfClaimRate: 0.12,
    credibleSelfClaimRate: 0.13,
  };
  const fearless = {
    ...balanced,
    averageWarMargin: -2,
    invasionDefeatRate: 0.6,
    frontierTroopsPerOrder: 0.4,
    capitalTroopsPerOrder: 2.2,
    idleTroopsPerOrder: 3,
    fundedTroopsPerOrder: 2.4,
    selfClaimRate: 0.32,
    credibleSelfClaimRate: 0.3,
  };
  const score = (fallRate, metrics) => scoreAggregateTrainingShape({ ...metrics, fallRate }, options);

  assert.equal(score(0.3, prudent) < score(0.3, balanced), true);
  assert.equal(score(0.3, fearless) > score(0.3, balanced), true);
  assert.equal(score(0.7, fearless) < score(0.7, balanced), true);
  assert.equal(score(0.7, prudent) > score(0.7, balanced), true);
});

test('AI training beginner mix includes the built-in curriculum with low noise', () => {
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
  assert.equal(result.options.opponentSummary.exposure.patron > 0, true);
  assert.equal(result.options.opponentSummary.exposure.tyrant > 0, true);
  assert.equal(result.options.opponentSummary.exposure.kingmaker > 0, true);
  assert.equal(result.options.opponentSummary.exposure.freeRider > 0, true);
  assert.equal(result.options.opponentSummary.exposure.overDefender > 0, true);
  assert.equal(result.options.opponentSummary.exposure.estateShark > 0, true);
  assert.equal(result.options.opponentSummary.exposure.antiLeader > 0, true);
  assert.equal(result.options.opponentSummary.exposure.random < result.options.opponentSummary.exposure.defender, true);
  assert.equal(result.options.opponentSummary.exposure.copycat < result.options.opponentSummary.exposure.usurper, true);
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
    assert.equal(typeof payload.opponents[0].strategyWeights.invasionShortfallPenalty, 'number');
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
    relationshipCoupWeight: 1.8,
    favorSeekingWeight: 1.2,
    supportLeaderPenalty: 1.8,
    supportOtherClaimant: 0.2,
    basileusTitleExpectation: 1.3,
    basileusRevocationFear: 1.2,
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

  assert.deepEqual(plans.map((plan) => [plan.playerId, plan.orders.ranking[0], plan.orders.ranking[1]]), [
    [1, 1, 2],
    [2, 2, 3],
    [3, 3, 2],
  ]);
  assert.equal(plans.filter((plan) => plan.orders.ranking[1] === 2).length >= 2, true);
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
            invasionShortfallPenalty: 7.4,
            invasionSafetyValue: 1.4,
            invasionSurplusPenalty: 0.4,
            capitalFallPenalty: 665.876428553347,
            capitalRiskPenalty: 48.353426978309265,
            throneBase: 13.837714739693313,
            selfClaim: 0.19356171899110766,
            supportOtherClaimant: 0.12764954809536314,
            relationshipCoupWeight: 0.31294053312187564,
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

  assert.equal(orders.ranking[0], 1);
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

test('AI Basileus title planning rewards loyal backers with stronger offices', () => {
  const state = createGameState({ playerCount: 5, deckSize: 1, seed: 31, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  state.phase = 'title_redistribution';
  state.round = 2;
  for (const theme of Object.values(state.themes)) {
    if (theme.id === 'CPL') continue;
    theme.occupied = false;
    theme.strategos = null;
    theme.bishop = null;
    theme.T = theme.region === 'east' ? 6 : 1;
    theme.C = 0;
  }
  state.history.push({
    id: 'h1',
    index: 1,
    round: 1,
    phase: 'resolution',
    category: 'orders',
    type: 'orders_revealed',
    actorId: 1,
    details: {
      candidateId: 0,
      capitalTroops: 5,
      frontierTroops: 0,
      offices: [{ totalTroops: 5, fundedTroops: 5, unfundedTroops: 0 }],
      mercenaries: { count: 0 },
    },
  });
  const meta = createAIMeta(state, {
    aiPlayers: {
      0: {
        policy: {
          policyId: 'tuned',
          strategyWeights: {
            backerTitleReward: 2.4,
            titleQualityWeight: 2,
            friendNeglectPenalty: 1.2,
            kingmakerPenalty: 0.1,
          },
        },
      },
    },
  });

  const action = planMajorTitleAssignment(state, meta, 0);

  assert.equal(action.assignments.DOM_EAST, 1);
  assert.equal(validateMajorTitleAssignments(state, 0, action.assignments).ok, true);
});
