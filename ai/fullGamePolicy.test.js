import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createGameState } from '../engine/state.js';
import { AI_ACTION_KINDS } from './actionSpace.js';
import {
  buildAIOrders,
  chooseAIDefenderRewardChoice,
  collectAIDefenderRewardOptions,
  collectAIOrderActionOptions,
  collectAITitleAssignmentOptions,
  createAIMeta,
  planMajorTitleAssignment,
} from './brain.js';
import { NEUTRAL_PROFILE } from './personalities.js';
import { POLICY_ACTION_KEYS, POLICY_FEATURE_KEYS, normalizePolicyGenome } from './policyGenome.js';

function featurePolicy(featureWeights = {}, actionKind = null) {
  return normalizePolicyGenome({
    actionPriors: Object.fromEntries(POLICY_ACTION_KEYS.map((key) => [key, actionKind == null || key === actionKind ? 0 : -6])),
    featureWeights: {
      ...Object.fromEntries(POLICY_FEATURE_KEYS.map((key) => [key, 0])),
      ...featureWeights,
    },
    baseScoreWeight: 0,
    actionThreshold: -6,
    scoreTemperature: 0.05,
    orderPlanLimit: 256,
  });
}

function profileWithPolicy(id, policy) {
  return {
    ...NEUTRAL_PROFILE,
    id,
    name: id,
    policy,
  };
}

function makeOrdersState() {
  const state = createGameState({ playerCount: 3, deckSize: 2, seed: 701 });
  state.phase = 'orders';
  state.basileusId = 0;
  state.players[1].majorTitles = ['DOM_EAST'];
  state.players[1].professionalArmies = { DOM_EAST: 3 };
  state.currentLevies = { DOM_EAST: 2, BASILEUS: 2 };
  state.allOrders = {};
  return state;
}

function topOrderFor(policy) {
  const state = makeOrdersState();
  const meta = createAIMeta(state, {
    seatProfiles: {
      1: profileWithPolicy('orders-test', policy),
    },
  });
  const options = collectAIOrderActionOptions(state, meta, 1);
  const top = options[0];
  return { state, meta, options, top, built: buildAIOrders(state, meta, 1) };
}

test('orders expose legal descriptors and policy can choose candidate/deployment families', () => {
  const self = topOrderFor(featurePolicy({ selfClaim: 6 }, AI_ACTION_KINDS.ORDERS));
  assert.equal(self.options.every(option => option.descriptor?.phase === 'orders'), true);
  assert.equal(self.top.descriptor.payload.candidateId, 1);

  const incumbent = topOrderFor(featurePolicy({ incumbentSupport: 6 }, AI_ACTION_KINDS.ORDERS));
  assert.equal(incumbent.top.descriptor.payload.candidateId, 0);

  const rival = topOrderFor(featurePolicy({ rivalSupport: 6 }, AI_ACTION_KINDS.ORDERS));
  assert.equal(rival.top.descriptor.payload.candidateId, 2);

  const capital = topOrderFor(featurePolicy({ capitalCommitment: 6 }, AI_ACTION_KINDS.ORDERS));
  assert.equal(capital.built.deployments.DOM_EAST, 'capital');

  const frontier = topOrderFor(featurePolicy({ frontierCommitment: 6 }, AI_ACTION_KINDS.ORDERS));
  assert.equal(frontier.built.deployments.DOM_EAST, 'frontier');
});

function makeRewardState() {
  const state = createGameState({ playerCount: 3, deckSize: 6, seed: 702 });
  state.phase = 'resolution';
  state.round = 3;
  state.currentInvasion = {
    id: 'reward-test',
    name: 'Reward Test',
    route: ['OPS', 'THK', 'CPL'],
    strength: [14, 16],
  };
  state.currentLevies = { BASILEUS: 0, DOM_EAST: 0, DOM_WEST: 0, ADMIRAL: 0 };
  state.themes.OPS.occupied = true;
  state.themes.THK.occupied = true;
  state.pendingDefenderRewards = [{
    id: 'reward',
    themeId: 'OPS',
    originalThemeId: 'OPS',
    reconquestIndex: 0,
    defenderId: 1,
    rank: 1,
    troops: 5,
    goldValue: 4,
    resolved: false,
  }];
  return state;
}

test('defender reward policy can choose gold or restoration without hard overrides', () => {
  const goldState = makeRewardState();
  const goldMeta = createAIMeta(goldState, {
    seatProfiles: {
      1: profileWithPolicy('reward-gold', featurePolicy({ economic: 5, goldPressure: 5, survival: -2 }, AI_ACTION_KINDS.DEFENDER_REWARD)),
    },
  });
  assert.equal(collectAIDefenderRewardOptions(goldState, goldMeta, goldState.pendingDefenderRewards[0]).length, 2);
  assert.equal(chooseAIDefenderRewardChoice(goldState, goldMeta, goldState.pendingDefenderRewards[0]), 'gold');

  const restoreState = makeRewardState();
  const restoreMeta = createAIMeta(restoreState, {
    seatProfiles: {
      1: profileWithPolicy('reward-restore', featurePolicy({ survival: 5, routeSafety: 5, restorationPressure: 5, economic: -2 }, AI_ACTION_KINDS.DEFENDER_REWARD)),
    },
  });
  assert.equal(chooseAIDefenderRewardChoice(restoreState, restoreMeta, restoreState.pendingDefenderRewards[0]), 'empire');
});

function makeTitleState(policy) {
  const state = createGameState({ playerCount: 4, deckSize: 3, seed: 703 });
  state.phase = 'resolution';
  state.basileusId = 0;
  for (const player of state.players) {
    player.majorTitles = [];
    player.professionalArmies = {};
  }
  state.players[2].majorTitles = ['DOM_EAST', 'PATRIARCH'];
  state.players[3].majorTitles = ['DOM_WEST'];
  state.players[1].majorTitles = ['ADMIRAL'];
  state.allOrders = {
    0: { candidate: 0, deployments: { BASILEUS: 'capital' } },
    1: { candidate: 1, deployments: { ADMIRAL: 'capital' } },
    2: { candidate: 2, deployments: { DOM_EAST: 'capital' } },
    3: { candidate: 1, deployments: { DOM_WEST: 'capital' } },
  };
  const meta = createAIMeta(state, {
    seatProfiles: {
      1: profileWithPolicy('title-test', policy),
      2: profileWithPolicy('title-test-2', policy),
      3: profileWithPolicy('title-test-3', policy),
    },
  });
  return { state, meta };
}

test('title assignment policy exposes descriptors and can reward supporters or preserve continuity', () => {
  const supporter = makeTitleState(featurePolicy({ supporterReward: 6, rivalSuppression: 3 }, AI_ACTION_KINDS.TITLE_ASSIGNMENT));
  const supporterOptions = collectAITitleAssignmentOptions(supporter.state, supporter.meta, 1);
  assert.equal(supporterOptions.every(option => option.descriptor?.phase === 'resolution'), true);
  assert.ok(Object.values(planMajorTitleAssignment(supporter.state, supporter.meta, 1).best.assignment).includes(3));

  const continuity = makeTitleState(featurePolicy({ titleContinuity: 6, supporterReward: -1, rivalSuppression: -1 }, AI_ACTION_KINDS.TITLE_ASSIGNMENT));
  const continuityPlan = planMajorTitleAssignment(continuity.state, continuity.meta, 1).best.assignment;
  assert.equal(continuityPlan.DOM_EAST, 2);
  assert.equal(continuityPlan.DOM_WEST, 3);
});

test('removed legacy AI thresholds do not reappear in decision code', () => {
  const searched = [
    readFileSync(new URL('./brain.js', import.meta.url), 'utf8'),
    readFileSync(new URL('./personalities.js', import.meta.url), 'utf8'),
  ].join('\n');
  const legacyName = (...parts) => parts.join('');
  for (const name of [
    legacyName('deal', 'Proposal', 'Threshold'),
    legacyName('deal', 'Acceptance', 'Threshold'),
    legacyName('deal', 'Temperature'),
    legacyName('defender', 'Reward', 'Greed'),
    legacyName('defender', 'Reward', 'Safety'),
    legacyName('title', 'Continuity', 'Bias'),
    legacyName('title', 'Supporter', 'Reward'),
    legacyName('title', 'Rival', 'Suppression'),
  ]) {
    assert.equal(searched.includes(name), false, `${name} should stay out of AI decision code`);
  }
});
