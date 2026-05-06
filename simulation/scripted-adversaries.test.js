import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIMeta } from '../ai/brain.js';
import { createGameState } from '../engine/state.js';
import { phaseCourt } from '../engine/turnflow.js';
import {
  SCRIPTED_ADVERSARY_FAMILIES,
  SCRIPTED_ADVERSARY_FAMILY_IDS_BY_CATEGORY,
  __testing,
  createScriptedSeatConfig,
  runControllerCourtAutomation,
} from './scripted-adversaries.js';

function buildScriptedState() {
  const state = createGameState({ playerCount: 4, deckSize: 6, seed: 'scripted-axis-tests' });
  state.round = 1;
  state.basileusId = 0;
  state.nextBasileusId = 0;
  state.players.forEach(player => {
    player.gold = 0;
    player.majorTitles = [];
    player.professionalArmies = {};
  });

  state.players[0].gold = 18;
  state.players[0].professionalArmies.BASILEUS = 2;
  state.players[1].gold = 9;
  state.players[1].majorTitles = ['DOM_EAST'];
  state.players[1].professionalArmies.DOM_EAST = 4;
  state.players[2].gold = 14;
  state.players[2].majorTitles = ['ADMIRAL'];
  state.players[2].professionalArmies.ADMIRAL = 1;
  state.players[3].gold = 2;
  state.players[3].majorTitles = ['PATRIARCH'];

  state.currentLevies = {
    BASILEUS: 1,
    DOM_EAST: 2,
    ADMIRAL: 1,
  };
  state.currentMercenaryTroops = { 0: 2 };

  const themeIds = Object.keys(state.themes).filter(themeId => themeId !== 'CPL');
  const [freeThemeId, ownedThemeId, otherOwnedThemeId, churchThemeId] = themeIds;
  state.themes[freeThemeId].occupied = false;
  state.themes[freeThemeId].owner = null;
  state.themes[ownedThemeId].occupied = false;
  state.themes[ownedThemeId].owner = 0;
  state.themes[otherOwnedThemeId].occupied = false;
  state.themes[otherOwnedThemeId].owner = 2;
  state.themes[churchThemeId].occupied = false;
  state.themes[churchThemeId].owner = 'church';

  return {
    state,
    freeThemeId,
    ownedThemeId,
    otherOwnedThemeId,
  };
}

function buildMeta(state, seatFamilies = { 0: 'base-coupPolicy-self' }) {
  const seatProfiles = {};
  for (const [playerId, familyId] of Object.entries(seatFamilies)) {
    seatProfiles[playerId] = createScriptedSeatConfig(familyId, `${familyId}:${playerId}`);
  }
  return createAIMeta(state, { seatProfiles });
}

test('scripted family catalog exposes base, composite, and alternator groups', () => {
  assert.ok(SCRIPTED_ADVERSARY_FAMILIES.length > 0);
  assert.ok(SCRIPTED_ADVERSARY_FAMILY_IDS_BY_CATEGORY.base.length > 0);
  assert.ok(SCRIPTED_ADVERSARY_FAMILY_IDS_BY_CATEGORY.composite.length > 0);
  assert.ok(SCRIPTED_ADVERSARY_FAMILY_IDS_BY_CATEGORY.alternator.length > 0);
});

test('coup policies pick self, incumbent, and strongest rival as intended', () => {
  const { state } = buildScriptedState();
  const meta = buildMeta(state);

  const selfTarget = __testing.pickCoupCandidate(state, meta, 0, { coupPolicy: 'self' });
  const incumbentTarget = __testing.pickCoupCandidate(state, meta, 2, { coupPolicy: 'incumbent' });
  const strongestTarget = __testing.pickCoupCandidate(state, meta, 0, { coupPolicy: 'strongestNonIncumbent' });

  assert.equal(selfTarget, 0);
  assert.equal(incumbentTarget, 0);
  assert.equal(strongestTarget, 1);
});

test('deployment policies can force all-frontier and all-capital plans', () => {
  const { state } = buildScriptedState();
  const meta = buildMeta(state);

  const frontierDeployments = __testing.buildScriptedDeployments(state, meta, 0, { deploymentPolicy: 'allFrontier' });
  const capitalDeployments = __testing.buildScriptedDeployments(state, meta, 0, { deploymentPolicy: 'allCapital' });

  assert.ok(Object.values(frontierDeployments).every(destination => destination === 'frontier' || destination === 'capital'));
  assert.ok(Object.entries(frontierDeployments).every(([officeKey, destination]) => officeKey === 'PATRIARCH' ? destination === 'capital' : destination === 'frontier'));
  assert.ok(Object.values(capitalDeployments).every(destination => destination === 'capital'));
});

test('court policy builders stay systematic by action family', () => {
  const { state } = buildScriptedState();
  const meta = buildMeta(state);

  const buyPayloads = __testing.buildStrategicCourtPayloads(state, meta, 0, { courtPolicy: 'buyMax' });
  const giftPayloads = __testing.buildStrategicCourtPayloads(state, meta, 0, { courtPolicy: 'giftMax' });
  const recruitPayloads = __testing.buildStrategicCourtPayloads(state, meta, 0, { courtPolicy: 'recruitMax' });
  const dismissPayloads = __testing.buildStrategicCourtPayloads(state, meta, 0, { courtPolicy: 'dismissMax' });

  assert.ok(buyPayloads.length > 0 && buyPayloads.every(payload => payload.action === 'buy'));
  assert.ok(giftPayloads.length > 0 && giftPayloads.every(payload => payload.action === 'gift'));
  assert.ok(recruitPayloads.length > 0 && recruitPayloads.every(payload => payload.action === 'recruit'));
  assert.ok(dismissPayloads.length > 0 && dismissPayloads.every(payload => payload.action === 'dismiss'));
});

test('appointment policies prioritize self or the theme owner when requested', () => {
  const { state, otherOwnedThemeId } = buildScriptedState();
  const meta = buildMeta(state);
  const theme = state.themes[otherOwnedThemeId];

  const selfFirstOrder = __testing.getCandidateAppointeeOrder(state, meta, 0, { appointmentPolicy: 'selfIfLegalElseRichestOther' }, { theme });
  const ownerFirstOrder = __testing.getCandidateAppointeeOrder(state, meta, 0, { appointmentPolicy: 'themeOwnerElseRandomOther' }, { theme });

  assert.equal(selfFirstOrder[0], 0);
  assert.equal(ownerFirstOrder[0], 2);
});

test('title reassignment self-first policy rewards coup supporters', () => {
  const { state } = buildScriptedState();
  state.allOrders = {
    0: { candidate: 0 },
    1: { candidate: 0 },
    2: { candidate: 2 },
    3: { candidate: 2 },
  };
  const meta = buildMeta(state, { 0: 'base-titleReassignmentPolicy-selfFirst' });
  const assignments = __testing.planScriptedTitleAssignment(state, meta, 0);

  assert.ok(Object.values(assignments).includes(1));
});

test('alternator schedules swap policies deterministically', () => {
  const { state } = buildScriptedState();

  const oddEvenMeta = buildMeta(state, { 0: 'alternator-frontier-turtle-vs-capital-usurper' });
  const oddRoundPolicy = __testing.getActiveScriptedPolicy(state, oddEvenMeta, 0);
  state.round = 2;
  const evenRoundPolicy = __testing.getActiveScriptedPolicy(state, oddEvenMeta, 0);
  assert.equal(oddRoundPolicy.courtPolicy, 'hoard');
  assert.equal(evenRoundPolicy.courtPolicy, 'mercMax');

  const winLossMeta = buildMeta(state, { 0: 'alternator-revoker-vs-hoarder' });
  const beforeLossPolicy = __testing.getActiveScriptedPolicy(state, winLossMeta, 0);
  winLossMeta.players[0].scriptedState.lastOutcome = 'loss';
  const afterLossPolicy = __testing.getActiveScriptedPolicy(state, winLossMeta, 0);
  assert.equal(beforeLossPolicy.courtPolicy, 'revokeMax');
  assert.equal(afterLossPolicy.courtPolicy, 'hoard');

  const seededRandomMeta = buildMeta(state, { 0: 'alternator-richest-kingmaker-vs-weakest-kingmaker' });
  const seededPolicyA = __testing.getActiveScriptedPolicy(state, seededRandomMeta, 0);
  const seededPolicyB = __testing.getActiveScriptedPolicy(state, seededRandomMeta, 0);
  assert.deepEqual(seededPolicyA, seededPolicyB);
});

test('scripted court automation passes cleanly when no legal action exists', () => {
  const { state } = buildScriptedState();
  phaseCourt(state);
  state.players.forEach(player => {
    player.gold = 0;
    player.professionalArmies = {};
  });
  state.currentMercenaryTroops = {};
  state.courtActions.basileusAppointed = true;
  state.courtActions.domesticEastAppointed = true;
  state.courtActions.domesticWestAppointed = true;
  state.courtActions.admiralAppointed = true;
  state.courtActions.patriarchAppointed = true;

  const meta = buildMeta(state, {
    0: 'base-courtPolicy-hoard',
    1: 'base-courtPolicy-hoard',
    2: 'base-courtPolicy-hoard',
    3: 'base-courtPolicy-hoard',
  });
  const result = runControllerCourtAutomation(state, meta, { mode: 'finish' });

  assert.equal(result.actionsTaken, 0);
  assert.equal(state.courtActions.playerConfirmed.size, 4);
});
