import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGameState, makeRng } from '../engine/state.js';
import { phaseCourt } from '../engine/turnflow.js';
import { applyCourtAction, submitHumanOrders } from '../engine/commands.js';
import { validateMajorTitleAssignments } from '../engine/actions.js';
import { getPreferredCoupCandidate } from '../engine/coup.js';
import { addEstates, getEstateCount } from '../engine/estates.js';
import { phaseEstates } from '../engine/turnflow.js';
import {
  handleContinueAfterResolution,
  handleManualTitleReassignment,
  startInteractiveRuntime,
} from '../game/runtime.js';
import {
  buildAIOrders,
  buildSimultaneousAIOrders,
  createAIMeta,
  isAIPlayer,
  loadBrowserAiOpponentRoster,
  planMajorTitleAssignment,
  runAICourtAutomation,
} from './brain.js';
import { applyLegalAction, listLegalCourtActions, listLegalEstateActions, listLegalOrderActions } from './legalActions.js';
import { getAiMemory, getRelationship } from './memory.js';
import { normalizeTunedOpponentRoster } from './opponentRoster.js';
import { simulateGame, simulateGames } from './simulate.js';
import { chooseStrategicEstateActions } from './strategy.js';
import {
  PLACEMENT_WEIGHT,
  mutatePersonalityWeights,
  personalitySeedWeights,
  scoreSeatOutcome,
  trainPersonalities,
} from './train.js';
import {
  PERSONALITIES,
  STRATEGY_WEIGHT_BOUNDS,
  getPersonality,
  isWithinPersonality,
} from './personalities.js';
import { GREEK_FIRST_NAMES, pickUniqueGreekFirstName } from './greekNames.js';

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

test('AI meta keeps declared human dynasties under human control', () => {
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

test('trained AI roster keeps saved weights and personality as written', () => {
  const roster = normalizeTunedOpponentRoster({
    opponents: [{
      id: 'usurper-leon',
      firstName: 'Leon',
      personality: 'usurper',
      label: 'Usurper',
      policy: { policyId: 'tuned', strategyWeights: { throneBase: 61, capitalRiskPenalty: 40 } },
      strayField: true,
    }],
  });

  assert.equal(roster.length, 1);
  assert.equal(roster[0].personality, 'usurper');
  assert.equal(roster[0].label, 'Usurper');
  assert.deepEqual(roster[0].policy.strategyWeights, { throneBase: 61, capitalRiskPenalty: 40 });
  assert.equal(roster[0].strayField, undefined);
});

test('strategic court automation only controls AI players', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  addEstates(state.themes.SAM, 1, 1, { recent: false });
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
    DOM_EAST: 2,
    PATRIARCH: 1,
  };

  const orders = buildAIOrders(state, meta, 1);
  const validation = submitHumanOrders(state, 1, orders);

  assert.equal(validation.ok, true);
  assert.equal(orders.coupChoices.length >= 1 && orders.coupChoices.length <= 2, true);
  assert.equal(orders.coupChoices.includes(1), true);
  assert.equal(orders.mercenaries.count >= 0, true);
  assert.equal(orders.armies.DOM_EAST.funded >= 0, true);
  assert.equal(orders.armies.PATRIARCH.funded >= 0, true);
  assert.equal(orders.debug.decision.title.includes('strategic'), true);
  assert.equal(orders.debug.decision.factors[0].label, 'frontier');
});

test('AI never backs its two least-liked claimants in 5-player games', () => {
  const state = createGameState({ playerCount: 5, deckSize: 1, seed: 22, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  for (const player of state.players) player.majorTitles = [];
  state.players[1].majorTitles = ['DOM_EAST'];
  state.round = 2;
  state.phase = 'deployment';
  state.currentTroops = {
    DOM_EAST: 3,
  };
  state.history.push(
    { id: 'h1', index: 1, round: 1, phase: 'court', category: 'court', type: 'revoke_minor_title', actorId: 3, details: { revokedPlayerId: 1, revokedPlayerIds: [1] } },
    { id: 'h2', index: 2, round: 1, phase: 'court', category: 'court', type: 'revoke_estates', actorId: 4, details: { revokedPlayerId: 1, revokedPlayerIds: [1], count: 1 } },
  );
  const meta = createAIMeta(state, { humanPlayerIds: [0, 2, 3, 4] });

  const orders = buildAIOrders(state, meta, 1);
  const choiceSets = listLegalOrderActions(state, 1, { memory: getAiMemory(state, meta) })
    .map((action) => action.orders.coupChoices.join(','));

  assert.equal(orders.coupChoices.some((candidateId) => candidateId === 3 || candidateId === 4), false);
  assert.deepEqual([...new Set(choiceSets)].sort(), ['0,1', '1', '1,0', '1,2', '2,1']);
});

test('AI never backs its least-liked claimant in 3-player games', () => {
  const state = createGameState({ playerCount: 3, deckSize: 1, seed: 23, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  for (const player of state.players) player.majorTitles = [];
  state.players[1].majorTitles = ['DOM_EAST'];
  state.round = 2;
  state.phase = 'deployment';
  state.currentTroops = {
    DOM_EAST: 3,
  };
  state.history.push(
    { id: 'h1', index: 1, round: 1, phase: 'court', category: 'court', type: 'revoke_minor_title', actorId: 2, details: { revokedPlayerId: 1, revokedPlayerIds: [1] } },
  );
  const meta = createAIMeta(state, { humanPlayerIds: [0, 2] });

  const orders = buildAIOrders(state, meta, 1);
  const choiceSets = listLegalOrderActions(state, 1, { memory: getAiMemory(state, meta) })
    .map((action) => action.orders.coupChoices.join(','));

  assert.equal(orders.coupChoices.includes(2), false);
  assert.deepEqual([...new Set(choiceSets)].sort(), ['0,1', '1', '1,0']);
});

test('AI memory values major title quality instead of treating every title as equal', () => {
  const state = createGameState({ playerCount: 5, deckSize: 1, seed: 24, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  state.round = 2;
  for (const theme of Object.values(state.themes)) {
    if (theme.id === 'CPL') continue;
    theme.lost = false;
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
    BASILEUS: 3,
    DOM_EAST: 5,
    DOM_WEST: 2,
    ADMIRAL: 2,
    PATRIARCH: 2,
  };
  state.history.push(
    { id: 'h1', index: 1, round: 1, phase: 'court', category: 'court', type: 'revoke_estates', actorId: 0, details: { revokedPlayerId: 1, revokedPlayerIds: [1], count: 1 } },
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

  assert.equal(orders.coupChoices.includes(0), false);
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
    DOM_EAST: 6,
  };
  return state;
}

const RESERVE_DEPLOYMENT_WEIGHTS = {
  reserveValue: 1.2,
  estateProfit: 8,
  estatePriceWeight: 0.6,
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

  assert.equal(funded < state.currentTroops.DOM_EAST, true);
  assert.equal(state.currentTroops.DOM_EAST - funded > 0, true);
  assert.equal(frontierTroopsFromOrders(orders) > 0, true);
});

test('AI deployment keeps funding troops when underfunding risks Constantinople', () => {
  const state = makeReserveDeploymentState([7, 9]);
  const meta = makeReserveDeploymentMeta(state);

  const orders = buildAIOrders(state, meta, 1);

  assert.equal(orders.armies.DOM_EAST.funded, state.currentTroops.DOM_EAST);
  assert.equal(frontierTroopsFromOrders(orders) >= state.currentTroops.DOM_EAST, true);
});

test('deployment submission defaults army funding but still rejects missing destinations', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.currentTroops = {
    BASILEUS: 2,
  };

  const missingArmyDestination = submitHumanOrders(state, 0, {
    mercenaries: { count: 0, destination: 'frontier' },
    coupChoices: [0],
  });
  assert.equal(missingArmyDestination.ok, false);
  assert.match(missingArmyDestination.reason, /destination/);

  const destinationOnly = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { destination: 'frontier' } },
    mercenaries: { count: 0, destination: 'frontier' },
    coupChoices: [0],
  });
  assert.equal(destinationOnly.ok, true);
  assert.equal(destinationOnly.orders.armies.BASILEUS.funded, 1);
  delete state.allOrders[0];

  const defaultChoices = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { funded: 2, destination: 'frontier' } },
    mercenaries: { count: 0, destination: 'frontier' },
  });
  assert.equal(defaultChoices.ok, true);
  assert.deepEqual(defaultChoices.orders.coupChoices, [0]);
  delete state.allOrders[0];

  const missingMercenaryDestination = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { funded: 2, destination: 'frontier' } },
    mercenaries: { count: 1 },
    coupChoices: [0],
  });
  assert.equal(missingMercenaryDestination.ok, false);
  assert.match(missingMercenaryDestination.reason, /mercenaries/);
});

test('legal estate actions dispatch through the shared AI action path', () => {
  const state = makeState();
  phaseEstates(state);
  state.players[1].gold = 5;

  const actions = listLegalEstateActions(state, 1);
  assert.equal(actions.some((action) => action.payload?.plan?.ANT), false, 'no estates in lost provinces');
  const action = actions.find((entry) => entry.payload.plan.OPS === 1);
  const result = applyLegalAction(state, action);

  assert.equal(result.ok, true);
  assert.deepEqual(state.estatePlans[1], { OPS: 1 });
});

test('estate strategy spreads a plan over several provinces within its purse', () => {
  const state = makeState();
  phaseEstates(state);
  for (const player of state.players) player.gold = 12;
  const meta = createAIMeta(state, {
    humanPlayerIds: [0, 2, 3],
    aiPlayers: {
      1: {
        policy: {
          policyId: 'tuned',
          strategyWeights: { estateProfit: 6, estatePriceWeight: 0.35, estateSpread: 2 },
        },
      },
    },
  });

  const [action] = chooseStrategicEstateActions(state, meta, 1);
  const plan = action.payload.plan;
  const count = Object.values(plan).reduce((total, value) => total + value, 0);
  const cost = (count * (count + 1)) / 2;

  assert.equal(count >= 2, true, 'a cheap first estate is always worth building');
  assert.equal(cost <= 12, true);
  assert.equal(Object.keys(plan).length >= 2, true, 'a high spread weight avoids stacking');
  assert.equal(applyLegalAction(state, action).ok, true);
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
  assert.equal(appointmentModeActions.some((action) => action.payload?.action === 'appoint-strategos' && action.payload?.appointeeId === 2), false);
  assert.equal(appointmentModeActions.some((action) => action.payload?.action === 'appoint-strategos' && action.payload?.appointeeId === 3), true);
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

test('AI legal court actions exclude estates built last round', () => {
  const state = makeState();
  state.round = 2;
  addEstates(state.themes.OPS, 2, 1, { recent: true });
  addEstates(state.themes.SAM, 3, 1, { recent: false });
  state.themes.KAP.strategos = 1;
  state.phase = 'income';
  phaseCourt(state);

  const actions = listLegalCourtActions(state, state.basileusId);

  assert.equal(actions.some((action) => action.payload?.action === 'revoke' && action.payload?.value === 'estates:SAM:3'), true);
  assert.equal(actions.some((action) => action.payload?.action === 'revoke' && action.payload?.value === 'estates:OPS:2'), false);
  // The Basileus revokes estates only, never a Strategos.
  assert.equal(actions.some((action) => action.payload?.value === 'minor:KAP:strategos'), false);
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
  });

  assert.equal(result.games, 3);
  assert.equal(result.completed + result.stuck, 3);
  assert.equal(result.resolutions > 0, true);
  assert.equal(Number.isFinite(result.scoring.winnerScore), true);
  assert.equal(result.estates.builtPerGame > 0, true);
  assert.equal(result.estates.goldSpentPerGame > 0, true);
  assert.equal(result.fallPressure.target, 'acceptable 25%-75%, ideal 40%-50%');
  assert.equal(result.diagnostics.some((entry) => entry.includes('Low self-claim') || entry.includes('Low estate bidding')), false);
});

test('AI simulation runner uses saved tuned opponents by default', () => {
  const game = simulateGame({
    playerCount: 4,
    deckSize: 1,
    seed: 91,
    samples: 0,
  });

  const savedIds = new Set(normalizeTunedOpponentRoster(
    JSON.parse(readFileSync(new URL('./tunedOpponents.json', import.meta.url), 'utf8')),
  ).map((entry) => entry.id));
  assert.deepEqual([...new Set(Object.values(game.policyIds))], ['tuned']);
  assert.equal(Object.values(game.opponentIds).every((id) => savedIds.has(id)), true);
});

test('AI simulation runner rejects untuned policies outside training', () => {
  assert.throws(() => simulateGames({
    games: 1,
    playerCount: 4,
    deckSize: 1,
    seed: 91,
    policies: ['strategic', 'random'],
  }), /not a saved tuned AI/);
});

test('training scores only the result: a fallen empire is a loss for everyone', () => {
  const finished = {
    reason: 'complete',
    fall: false,
    winnerIds: [2],
    finalScores: [
      { playerId: 0, points: 3 },
      { playerId: 1, points: 5 },
      { playerId: 2, points: 9 },
      { playerId: 3, points: 5 },
    ],
  };
  assert.deepEqual(scoreSeatOutcome(finished, 2), { win: 1, placement: 1, value: 1 + PLACEMENT_WEIGHT, fall: false });
  assert.equal(scoreSeatOutcome(finished, 0).value, 0);
  // Tied for second of four: halfway between second and third place.
  assert.equal(scoreSeatOutcome(finished, 1).placement, 0.5);
  assert.equal(scoreSeatOutcome(finished, 1).win, 0);

  const tie = { ...finished, winnerIds: [1, 3] };
  assert.equal(scoreSeatOutcome(tie, 1).win, 0.5);

  const fallen = { ...finished, fall: true };
  for (const seat of [0, 1, 2, 3]) assert.equal(scoreSeatOutcome(fallen, seat).value, 0);
  assert.equal(scoreSeatOutcome({ ...finished, reason: 'stuck' }, 2).value, 0);
});

test('personality seeds and mutations stay inside their temperament', () => {
  const rng = makeRng(5);
  for (const personality of PERSONALITIES) {
    let weights = personalitySeedWeights(personality.id);
    assert.equal(isWithinPersonality(personality, weights), true, personality.id);
    for (let step = 0; step < 25; step += 1) {
      weights = mutatePersonalityWeights(personality.id, weights, rng, 0.45, 0.6);
      assert.equal(isWithinPersonality(personality, weights), true, personality.id);
    }
    for (const [key, [min, max]] of Object.entries(personality.traits)) {
      const [globalMin, globalMax] = STRATEGY_WEIGHT_BOUNDS[key];
      assert.equal(min >= globalMin && max <= globalMax && min < max, true, `${personality.id}.${key}`);
    }
  }
});

test('training evolves every personality and saves one Greek-named champion each', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basileus-ai-'));
  const outputPath = join(dir, 'tunedOpponents.json');
  try {
    const events = [];
    const result = await trainPersonalities({
      personalities: 'usurper,opportunist',
      generations: 1,
      offspring: 1,
      finalists: 1,
      screeningGames: 1,
      confirmGames: 1,
      finalGames: 1,
      benchmarkGames: 1,
      playerCounts: [3],
      deckSizes: [1],
      seed: 133,
      workers: 1,
      outputPath,
      onProgress: (event) => events.push(event.type),
    });
    const payload = JSON.parse(readFileSync(outputPath, 'utf8'));
    const roster = normalizeTunedOpponentRoster(payload);

    assert.equal(result.generations.length, 1);
    assert.deepEqual(Object.keys(result.finals).sort(), ['opportunist', 'usurper']);
    assert.deepEqual(events, ['training-start', 'generation-end', 'finals-end', 'saved']);
    assert.equal(typeof result.benchmark.strategic.byPersonality.usurper.winRate, 'number');
    assert.equal(roster.length, 2);
    for (const entry of roster) {
      const personality = getPersonality(entry.personality);
      assert.equal(GREEK_FIRST_NAMES.includes(entry.firstName), true);
      assert.equal(entry.label, personality.title);
      assert.equal(entry.policy.policyId, 'tuned');
      assert.equal(isWithinPersonality(personality, entry.strategyWeights), true);
      assert.equal(typeof entry.metrics.capitalBidRate, 'number');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the saved roster has one AI per personality, each inside its temperament', () => {
  const payload = JSON.parse(readFileSync(new URL('./tunedOpponents.json', import.meta.url), 'utf8'));
  const roster = normalizeTunedOpponentRoster(payload);
  assert.deepEqual(roster.map((entry) => entry.personality).sort(), PERSONALITIES.map((entry) => entry.id).sort());
  for (const entry of roster) {
    const personality = getPersonality(entry.personality);
    assert.equal(entry.label, personality.title);
    assert.equal(isWithinPersonality(personality, entry.strategyWeights), true, entry.id);
  }
});

test('Greek AI name picker avoids already saved names', () => {
  const reservedNames = GREEK_FIRST_NAMES.filter((name) => name !== 'Nikephoros');
  assert.equal(pickUniqueGreekFirstName('reserved-test', reservedNames), 'Nikephoros');

  const fallbackName = pickUniqueGreekFirstName('full-roster-test', GREEK_FIRST_NAMES);
  assert.equal(GREEK_FIRST_NAMES.includes(fallbackName), false);
  assert.match(fallbackName, / \d+$/);
});

test('simultaneous AI planning ignores already submitted human deployment orders', () => {
  const state = makeState();
  const meta = createAIMeta(state, { humanPlayerIds: [0] });
  state.phase = 'deployment';
  state.currentTroops = {
    BASILEUS: 1,
    DOM_EAST: 1,
    DOM_WEST: 1,
    ADMIRAL: 1,
  };

  const humanSubmit = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { funded: 1, destination: 'capital' } },
    mercenaries: { count: 0, destination: 'frontier' },
    coupChoices: [0],
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
    BASILEUS: 4,
    DOM_EAST: 1,
    DOM_WEST: 1,
    ADMIRAL: 1,
  };
  return state;
}

test('AI coup coalition planning rallies weak AI dynasties behind one friendly claimant', () => {
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

  // Dynasty 2 appointed both others, so they choose it first and it claims
  // the throne itself: all three put the same claimant first.
  assert.deepEqual(plans.map((plan) => [plan.playerId, plan.orders.coupChoices[0]]), [
    [1, 2],
    [2, 2],
    [3, 2],
  ]);
});

test('AI coup coalition planning can support a human claimant with good relations', () => {
  const state = prepareCoalitionDeploymentState();
  state.currentTroops.ADMIRAL = 2;
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

  assert.deepEqual(plans.map((plan) => [plan.playerId, getPreferredCoupCandidate(state, plan.playerId, plan.orders)]), [[1, 3], [2, 3]]);
});

function safeSurplusDeploymentState() {
  const state = makeState();
  state.phase = 'deployment';
  state.currentInvasion = {
    id: 'test_invasion',
    name: 'Test invasion',
    strength: [4, 6],
    route: ['OPS', 'OPT', 'CPL'],
  };
  state.currentTroops = {
    BASILEUS: 6,
    DOM_EAST: 6,
    DOM_WEST: 6,
    ADMIRAL: 6,
  };
  return state;
}

function capitalCommitment(orders) {
  const armies = Object.values(orders.armies)
    .filter((entry) => entry.destination === 'capital')
    .reduce((total, entry) => total + entry.funded, 0);
  return armies + (orders.mercenaries.destination === 'capital' ? orders.mercenaries.count : 0);
}

test('an ambitious AI turns a safe frontier surplus into a throne bid', () => {
  const state = safeSurplusDeploymentState();
  const meta = createAIMeta(state, {
    humanPlayerIds: [0, 2, 3],
    aiPlayers: { 1: { policy: { policyId: 'tuned', strategyWeights: { throneBase: 44, selfClaim: 1.75, coupOpportunityWeight: 0.9 } } } },
  });

  const orders = buildAIOrders(state, meta, 1);

  assert.equal(orders.coupChoices[0], 1);
  assert.equal(capitalCommitment(orders) >= 3, true);
});

test('a defence-minded AI that barely values the throne keeps its troops at the frontier', () => {
  const state = safeSurplusDeploymentState();
  const strategyWeights = {
    invasionShortfallPenalty: 7.4,
    invasionSafetyValue: 1.4,
    invasionSurplusPenalty: 0.4,
    capitalFallPenalty: 665.9,
    capitalRiskPenalty: 48.4,
    throneBase: 13.8,
    selfClaim: 0.19,
    supportOtherClaimant: 0.13,
    relationshipCoupWeight: 0.31,
    coupOpportunityWeight: 0.75,
    allyDefenseReliance: 0.82,
  };
  const meta = createAIMeta(state, {
    humanPlayerIds: [0, 2, 3],
    aiPlayers: { 1: { policy: { policyId: 'tuned', strategyWeights } } },
  });

  const orders = buildAIOrders(state, meta, 1);

  assert.equal(capitalCommitment(orders), 0);
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
    theme.lost = false;
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
