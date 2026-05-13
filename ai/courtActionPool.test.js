import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { setDealParticipantIds, startCourtDealRound } from '../engine/deals.js';
import { AI_ACTION_KINDS } from './actionSpace.js';
import { collectAICourtActionOptions, createAIMeta } from './brain.js';
import { NEUTRAL_PROFILE } from './personalities.js';
import { POLICY_ACTION_KEYS, POLICY_FEATURE_KEYS, normalizePolicyGenome } from './policyGenome.js';

function policyFavoring(kind) {
  return normalizePolicyGenome({
    actionPriors: Object.fromEntries(POLICY_ACTION_KEYS.map((key) => [key, key === kind ? 6 : -6])),
    featureWeights: Object.fromEntries(POLICY_FEATURE_KEYS.map((key) => [key, 0])),
    baseScoreWeight: 0,
    actionThreshold: -6,
    maxCourtActionsPerRound: 12,
    maxActionRepeatsPerKind: 8,
  });
}

function makeProfile(kind = AI_ACTION_KINDS.CONFIRM_COURT, metaOverrides = {}) {
  return {
    ...NEUTRAL_PROFILE,
    id: `pool-${kind}`,
    name: `Pool ${kind}`,
    source: 'trained',
    meta: {
      ...NEUTRAL_PROFILE.meta,
      dismissalThreshold: -6,
      recruitThreshold: -6,
      revocationThreshold: -6,
      landPurchaseThreshold: -6,
      churchGiftThreshold: -6,
      ...metaOverrides,
    },
    policy: policyFavoring(kind),
  };
}

function makeCourtState() {
  const state = createGameState({ playerCount: 3, deckSize: 1, seed: 77 });
  state.phase = 'court';
  state.basileusId = 0;
  state.nextBasileusId = 0;
  state.players[0].gold = 12;
  state.players[0].majorTitles = ['DOM_EAST', 'PATRIARCH'];
  state.players[0].professionalArmies.BASILEUS = 14;
  state.players[1].majorTitles = ['DOM_WEST'];
  state.players[2].majorTitles = ['ADMIRAL'];
  state.empress = 1;
  state.currentLevies = { BASILEUS: 6 };
  state.courtActions = {
    basileusAppointed: false,
    domesticEastAppointed: false,
    domesticWestAppointed: false,
    admiralAppointed: false,
    patriarchAppointed: false,
    revocationsUsed: {},
    appointedThisTurn: {},
    appointmentsByRecipient: {},
    playerConfirmed: new Set(),
  };
  setDealParticipantIds(state, state.players.map(player => player.id));
  startCourtDealRound(state);

  const freeTheme = Object.values(state.themes).find(theme => theme.id !== 'CPL' && !theme.occupied && theme.owner == null);
  const ownedTheme = Object.values(state.themes).find(theme => theme.id !== 'CPL' && theme !== freeTheme);
  ownedTheme.owner = 0;
  ownedTheme.C = 1;
  const bishopTheme = Object.values(state.themes).find(theme => theme.id !== 'CPL' && theme !== ownedTheme && theme.bishop == null);
  bishopTheme.C = 1;
  return state;
}

function collectKindsFor(policyKind) {
  const state = makeCourtState();
  const profile = makeProfile(policyKind);
  const meta = createAIMeta(state, {
    seatProfiles: {
      0: profile,
      1: makeProfile(),
      2: makeProfile(),
    },
  });
  const options = collectAICourtActionOptions(state, meta, 0);
  return {
    options,
    kinds: new Set(options.map(option => option.kind)),
    topKind: options.slice().sort((left, right) => right.policyScore - left.policyScore)[0]?.kind,
  };
}

function collectKindsForProfile(profile) {
  const state = makeCourtState();
  const meta = createAIMeta(state, {
    seatProfiles: {
      0: profile,
      1: makeProfile(),
      2: makeProfile(),
    },
  });
  const options = collectAICourtActionOptions(state, meta, 0);
  return {
    options,
    kinds: new Set(options.map(option => option.kind)),
  };
}

test('AI court action generation exposes legal descriptors for every court family', () => {
  const { kinds, options } = collectKindsFor(AI_ACTION_KINDS.CONFIRM_COURT);

  assert.equal(options.every(option => option.descriptor?.phase === 'court'), true);
  assert.equal(kinds.has(AI_ACTION_KINDS.APPOINTMENT), true);
  assert.equal(kinds.has(AI_ACTION_KINDS.REVOCATION), true);
  assert.equal(kinds.has(AI_ACTION_KINDS.DEAL), true);
  assert.equal(kinds.has(AI_ACTION_KINDS.LAND_PURCHASE), true);
  assert.equal(kinds.has(AI_ACTION_KINDS.CHURCH_GIFT), true);
  assert.equal(kinds.has(AI_ACTION_KINDS.RECRUIT), true);
  assert.equal(kinds.has(AI_ACTION_KINDS.DISMISS), true);
  assert.equal(kinds.has(AI_ACTION_KINDS.MERCENARY_HIRE), true);
  assert.equal(kinds.has(AI_ACTION_KINDS.CONFIRM_COURT), true);
});

test('deal and dismissal descriptors are exposed without legacy threshold gates', () => {
  const { kinds } = collectKindsForProfile(makeProfile(AI_ACTION_KINDS.CONFIRM_COURT, {
    dismissalThreshold: 999,
  }));

  assert.equal(kinds.has(AI_ACTION_KINDS.DEAL), true);
  assert.equal(kinds.has(AI_ACTION_KINDS.DISMISS), true);
});

test('unified court scorer follows policy weights without family priority', () => {
  for (const kind of [
    AI_ACTION_KINDS.APPOINTMENT,
    AI_ACTION_KINDS.REVOCATION,
    AI_ACTION_KINDS.DEAL,
    AI_ACTION_KINDS.LAND_PURCHASE,
    AI_ACTION_KINDS.CHURCH_GIFT,
    AI_ACTION_KINDS.RECRUIT,
    AI_ACTION_KINDS.DISMISS,
    AI_ACTION_KINDS.MERCENARY_HIRE,
    AI_ACTION_KINDS.CONFIRM_COURT,
  ]) {
    assert.equal(collectKindsFor(kind).topKind, kind);
  }
});
