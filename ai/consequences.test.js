import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { NEUTRAL_PROFILE } from './personalities.js';
import { normalizeAiProfile } from './profileStore.js';
import { createAIMeta } from './brain.js';
import { AI_ACTION_KINDS, AI_ACTION_PHASES } from './actionSpace.js';
import {
  evaluateActionConsequences,
  projectAction,
  summarizePredictionStats,
} from './consequences.js';

function makeMeta(state) {
  return createAIMeta(state, {
    seatProfiles: Object.fromEntries(state.players.map(player => [
      player.id,
      {
        ...NEUTRAL_PROFILE,
        id: `neutral-${player.id}`,
        name: `Neutral ${player.id}`,
      },
    ])),
  });
}

function firstFreeTheme(state) {
  return Object.values(state.themes).find(theme => theme.id !== 'CPL' && !theme.occupied);
}

test('projection clones state and does not mutate the live game', () => {
  const state = createGameState({ playerCount: 3, deckSize: 1, seed: 303 });
  const theme = firstFreeTheme(state);
  state.players[0].gold = 8;

  const result = projectAction(state, {
    kind: AI_ACTION_KINDS.LAND_PURCHASE,
    phase: AI_ACTION_PHASES.COURT,
    actorId: 0,
    payload: { themeId: theme.id },
    costs: { gold: 3 },
  });

  assert.equal(result.ok, true);
  assert.equal(state.players[0].gold, 8);
  assert.equal(state.landAuctions[theme.id], undefined);
  assert.equal(result.state.players[0].gold, 5);
  assert.equal(result.state.landAuctions[theme.id].bidderId, 0);
});

test('similar military consequences produce comparable impact vectors', () => {
  const state = createGameState({ playerCount: 3, deckSize: 1, seed: 404 });
  const meta = makeMeta(state);

  const recruit = evaluateActionConsequences(state, meta, 0, {
    kind: AI_ACTION_KINDS.RECRUIT,
    phase: AI_ACTION_PHASES.COURT,
    actorId: 0,
    payload: { officeKey: 'BASILEUS', count: 1 },
    gains: { troops: 1 },
  });
  const mercenary = evaluateActionConsequences(state, meta, 0, {
    kind: AI_ACTION_KINDS.MERCENARY_HIRE,
    phase: AI_ACTION_PHASES.COURT,
    actorId: 0,
    payload: { count: 1 },
    gains: { troops: 1 },
  });

  assert.equal(recruit.impact.military > 0, true);
  assert.equal(mercenary.impact.military > 0, true);
  assert.equal(Math.abs(recruit.impact.military - mercenary.impact.military) < 0.8, true);
});

test('public-belief scoring ignores hidden rival profile truth', () => {
  const state = createGameState({ playerCount: 3, deckSize: 1, seed: 505 });
  const meta = makeMeta(state);
  const theme = firstFreeTheme(state);
  const descriptor = {
    kind: AI_ACTION_KINDS.LAND_PURCHASE,
    phase: AI_ACTION_PHASES.COURT,
    actorId: 0,
    payload: { themeId: theme.id, theme },
    costs: { gold: 2 },
  };

  const first = evaluateActionConsequences(state, meta, 0, descriptor).score;
  meta.players[1].profile = {
    ...meta.players[1].profile,
    weights: {
      ...meta.players[1].profile.weights,
      throne: 4.5,
      frontier: 0.15,
      revocation: 4.5,
    },
  };
  const second = evaluateActionConsequences(state, meta, 0, descriptor).score;

  assert.equal(second, first);
});

test('old profiles receive new consequence meta defaults', () => {
  const profile = normalizeAiProfile({
    id: 'old-trained-profile',
    name: 'Old Trained Profile',
    weights: { wealth: 1.5 },
    meta: { dealProposalThreshold: 0.5 },
  });

  assert.equal(typeof profile.meta.consequenceSensitivity, 'number');
  assert.equal(typeof profile.meta.riskHorizon, 'number');
  assert.equal(typeof profile.meta.flexibilityValue, 'number');
  assert.equal(profile.meta.dealProposalThreshold, 0.5);
});

test('prediction stats compare projected and realized utility', () => {
  const summary = summarizePredictionStats({
    systemicDecisionCount: 2,
    projectedUtilityTotal: 4,
    projectedRiskTotal: 1,
    projectedFlexibilityTotal: 0.5,
  }, 1.5);

  assert.equal(summary.systemicDecisionCount, 2);
  assert.equal(summary.projectedUtility, 2);
  assert.equal(summary.projectionError > 0, true);
  assert.equal(summary.decisionQuality <= 1, true);
});
