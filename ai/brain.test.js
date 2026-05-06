import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../engine/state.js';
import { normalizeAiProfile } from './profileStore.js';
import { DEFAULT_META_PARAMS, NEUTRAL_PROFILE } from './personalities.js';
import { __testing, createAIMeta } from './brain.js';

function makeProfile(id, metaOverrides = {}) {
  return normalizeAiProfile({
    id,
    name: id,
    source: 'emergent-trained',
    weights: { ...NEUTRAL_PROFILE.weights },
    tactics: {
      independence: 1,
      frontierAlarm: 1,
      churchReserve: 1,
      incumbencyGrip: 1,
    },
    meta: {
      ...DEFAULT_META_PARAMS,
      ...metaOverrides,
    },
  });
}

test('social memory decays old favors over time', () => {
  const state = createGameState({ playerCount: 3, deckSize: 6, seed: 1 });
  const meta = createAIMeta(state, {
    seatProfiles: {
      0: makeProfile('observer'),
      1: makeProfile('target'),
      2: makeProfile('third'),
    },
  });

  meta.currentRound = 1;
  __testing.updateSocialMemory(meta, 0, 1, { favorCredit: 4, reliability: 2 }, 1);
  const earlyAffinity = __testing.getAffinityScore(meta, 0, 1);

  meta.currentRound = 6;
  const lateAffinity = __testing.getAffinityScore(meta, 0, 1);

  assert.ok(earlyAffinity > lateAffinity, 'Old favor should lose influence as rounds pass.');
});

test('recent harm and threat can outweigh past favor', () => {
  const state = createGameState({ playerCount: 3, deckSize: 6, seed: 2 });
  const meta = createAIMeta(state, {
    seatProfiles: {
      0: makeProfile('observer'),
      1: makeProfile('target'),
      2: makeProfile('third'),
    },
  });

  meta.currentRound = 1;
  __testing.updateSocialMemory(meta, 0, 1, { favorCredit: 3, reliability: 1.5 }, 1);
  const favoredAffinity = __testing.getAffinityScore(meta, 0, 1);

  meta.currentRound = 2;
  __testing.updateSocialMemory(meta, 0, 1, { harmDebt: 4, threat: 4, opportunism: 2 }, 2);
  const threatenedAffinity = __testing.getAffinityScore(meta, 0, 1);

  assert.ok(favoredAffinity > threatenedAffinity);
  assert.ok(threatenedAffinity < 1.1, 'A dangerous rival should no longer read as strongly favorable.');
});

test('rival summaries react to public behavior patterns', () => {
  const state = createGameState({ playerCount: 3, deckSize: 6, seed: 3 });
  const meta = createAIMeta(state, {
    seatProfiles: {
      0: makeProfile('observer'),
      1: makeProfile('risky-rival'),
      2: makeProfile('steady-rival'),
    },
  });

  meta.currentRound = state.round;
  __testing.updateRecentBehavior(meta, 1, {
    landBuying: 3,
    mercenarySpikes: 2,
    selfSupport: 3,
    frontierCommitment: 0.1,
  }, state.round);
  __testing.updateRecentBehavior(meta, 2, {
    incumbentSupport: 2,
    frontierCommitment: 3,
    churchGifting: 1,
  }, state.round);

  const risky = __testing.getRivalSummary(state, meta, 0, 1);
  const steady = __testing.getRivalSummary(state, meta, 0, 2);

  assert.ok(risky.coupAmbition > steady.coupAmbition);
  assert.ok(risky.freeRiderRisk > steady.freeRiderRisk);
  assert.ok(steady.likelyFrontierCooperation > risky.likelyFrontierCooperation);
});

test('temperature-controlled softmax can preserve greed or allow exploration', () => {
  const options = [
    { label: 'best', score: 4 },
    { label: 'middle', score: 2 },
    { label: 'tail', score: 1 },
  ];
  const rng = () => 0.99;

  const greedy = __testing.softmaxPick(options, 0.05, rng);
  const exploratory = __testing.softmaxPick(options, 2.0, rng);

  assert.equal(greedy.label, 'best');
  assert.notEqual(exploratory.label, 'best');
});
