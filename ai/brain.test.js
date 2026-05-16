import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { buildFinalScores } from '../engine/scoring.js';
import {
  DEAL_CLAUSE_KINDS,
  setDealParticipantIds,
} from '../engine/deals.js';
import { submitHumanOrders } from '../engine/commands.js';
import {
  advanceToNextInteractivePhase,
  phaseOrders,
} from '../engine/turnflow.js';
import {
  buildAIOrders,
  createAIMeta,
  hydrateAiOpponent,
  isAIPlayer,
  loadBrowserAiOpponentRoster,
  runAICourtAutomation,
} from './brain.js';
import {
  AI_DEALS_ENABLED,
  applyLegalAction,
  listLegalCourtActions,
  listLegalOrderActions,
  listLegalRewardActions,
  listLegalTitleAssignments,
} from './legalActions.js';
import {
  DEFAULT_HEURISTIC_ID,
  HEURISTIC_PERSONALITIES,
  RANDOM_OPPONENT_ID,
  evaluateHeuristicActions,
  selectHeuristicActionIndex,
} from './heuristics.js';
import {
  createMatchEpisodeOptions,
  evaluateStrategy,
  resolveEpisodeSettings,
  runSelfPlayEpisode,
} from './selfPlay.js';
import {
  runHeuristicLeague,
  runTournament,
  runTournamentSuite,
  scoreTournamentReport,
} from './tournament.js';
import { loadOpponentByIdSync, loadOpponentRosterSync } from './opponentRoster.js';

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

test('AI metadata preserves human and heuristic seat boundaries', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 11 });
  const meta = createAIMeta(state, { humanPlayerIds: [1] });

  assert.equal(meta.humanPlayerIds.has(1), true);
  assert.equal(isAIPlayer(meta, 0), true);
  assert.equal(isAIPlayer(meta, 1), false);
  assert.equal(meta.players[0].opponent.id, DEFAULT_HEURISTIC_ID);
  assert.equal(typeof meta.players[0].displayName, 'string');
});

test('built-in heuristic opponent roster is available without external files', () => {
  const roster = loadOpponentRosterSync();
  assert.equal(roster.length, HEURISTIC_PERSONALITIES.length);
  assert.ok(roster.some((entry) => entry.id === 'alexios'));
  assert.equal(loadOpponentByIdSync('basil').firstName, 'Basil');
  assert.equal(hydrateAiOpponent('niketas').id, 'niketas');
});

test('browser opponent roster falls back to built-in heuristics', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });

  try {
    const roster = await loadBrowserAiOpponentRoster('/missing');
    assert.equal(roster.length, HEURISTIC_PERSONALITIES.length);
    await assert.rejects(
      () => loadBrowserAiOpponentRoster('/missing', { required: true }),
      /Could not list AI opponents/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('reactive AI court turns do not spend their one action confirming', () => {
  const state = prepareInteractiveState({ seed: 21 });
  const aiPlayerId = state.players.find((player) => player.id !== 1).id;
  const legalActions = listLegalCourtActions(state, aiPlayerId);
  assert.ok(legalActions.some((action) => action.kind !== 'court-confirm'));
  assert.ok(legalActions.some((action) => action.kind === 'court-confirm'));

  const meta = createAIMeta(state, { humanPlayerIds: [1] });
  const result = runAICourtAutomation(state, meta, { mode: 'react' });

  assert.ok(result.actions > 0);
  for (const player of state.players.filter((entry) => entry.id !== 1)) {
    assert.equal(state.courtActions.playerConfirmed.has(player.id), false);
  }
});

test('AI orders fail impossible troop commitments instead of crashing', () => {
  const state = prepareInteractiveState({ seed: 23 });
  state.historyEnabled = true;
  state.history = [];
  state.historySeq = 0;
  state.round = 3;
  phaseOrders(state);

  const aiPlayerId = 2;
  state.activeDealObligations.push({
    id: 'test-impossible-frontier',
    threadId: 'test-thread',
    pairKey: '0:2',
    giverId: aiPlayerId,
    receiverId: 0,
    kind: DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT,
    startTrigger: { type: 'immediate' },
    durationTurns: 1,
    payload: { troopCount: 99 },
    status: 'active',
    createdRound: 2,
    activatedRound: 3,
    nextDueRound: 3,
    remainingTurns: 1,
  });

  assert.ok(listLegalOrderActions(state, aiPlayerId).length > 0);

  const meta = createAIMeta(state, { humanPlayerIds: [1] });
  const orders = buildAIOrders(state, meta, aiPlayerId);
  const result = submitHumanOrders(state, aiPlayerId, orders);

  assert.equal(result.ok, true);
  assert.ok(state.allOrders[aiPlayerId]);
  assert.equal(state.activeDealObligations.some((entry) => entry.id === 'test-impossible-frontier'), false);
  assert.equal(state.history.some((entry) => entry.type === 'deal_obligation_failed'), true);
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

test('AI deal actions stay disabled until deal heuristics are intentionally enabled', () => {
  assert.equal(AI_DEALS_ENABLED, false);
});

test('heuristic action scoring chooses legal action indexes', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 2, seed: 66 });
  const actions = listLegalCourtActions(state, 0, { includeDeals: false });
  const evaluation = evaluateHeuristicActions('alexios', state, 0, actions);
  const index = selectHeuristicActionIndex('alexios', state, 0, actions, state.rng);

  assert.equal(evaluation.scores.length, actions.length);
  assert.ok(index >= 0 && index < actions.length);
  assert.equal(typeof evaluation.scores[index].total, 'number');
});

test('simulation settings sample varied legal player counts and round lengths', () => {
  const first = resolveEpisodeSettings({}, 0);
  const second = resolveEpisodeSettings({}, 1);
  assert.ok(first.playerCount >= 3 && first.playerCount <= 5);
  assert.ok(first.deckSize >= 6 && first.deckSize <= 12);
  assert.notEqual(first.seed, second.seed);
});

test('self-play episode completes with legal heuristic decisions', () => {
  const result = runSelfPlayEpisode({
    strategyId: 'alexios',
    playerCount: 3,
    deckSize: 1,
    seed: 61,
    maxSteps: 400,
    maxCourtActionsPerPlayer: 4,
  });
  assert.ok(result.stats.fell || result.state.phase === 'scoring');
  assert.ok(result.stats.actionStats.total > 0);
});

test('evaluation reports survival, scoring, action, and role metrics', () => {
  const stats = evaluateStrategy({
    episodes: 1,
    playerCount: 3,
    deckSize: 1,
    seed: 81,
    strategyId: 'irene',
    maxSteps: 400,
    maxCourtActionsPerPlayer: 4,
  });
  assert.equal(stats.episodes, 1);
  assert.equal(typeof stats.fallRate, 'number');
  assert.equal(typeof stats.survivalRate, 'number');
  assert.ok(stats.actionStats.total > 0);
  assert.ok(Object.keys(stats.strategyMix).length > 0);
});

test('tournament harness compares heuristic strategies against baselines', () => {
  const report = runTournament({
    primaryId: 'basil',
    opponentId: RANDOM_OPPONENT_ID,
    episodes: 1,
    playerCount: 3,
    deckSize: 1,
    seed: 91,
    maxSteps: 400,
    maxCourtActionsPerPlayer: 4,
  });
  assert.equal(report.episodes, 1);
  assert.equal(typeof report.primary.score, 'number');
  assert.equal(typeof report.opponent.score, 'number');

  const suite = runTournamentSuite({
    primaryId: 'basil',
    opponentId: RANDOM_OPPONENT_ID,
    episodes: 1,
    seedCount: 2,
    playerCount: 3,
    deckSize: 1,
    seed: 91,
    maxSteps: 400,
    maxCourtActionsPerPlayer: 4,
  });
  assert.equal(suite.seedCount, 2);
  assert.equal(suite.runs.length, 2);
  assert.equal(typeof scoreTournamentReport(suite), 'number');
});

test('heuristic league includes random control groups', () => {
  const report = runHeuristicLeague({
    strategies: ['alexios', 'irene'],
    episodes: 1,
    seedCount: 1,
    playerCount: 3,
    deckSize: 1,
    seed: 95,
    maxSteps: 400,
    maxCourtActionsPerPlayer: 4,
  });
  assert.ok(report.randomSelf.summary);
  assert.ok(report.selfPlay.alexios.summary);
  assert.ok(report.vsRandom.alexios.primary);
  assert.ok(report.pairwise.alexios_vs_irene.primary);
  assert.equal(typeof report.validation.alexios.scoreDelta, 'number');
});

test('custom match episode options rotate the evaluated seat', () => {
  const episodeOptions = createMatchEpisodeOptions('alexios', RANDOM_OPPONENT_ID);
  const first = episodeOptions({ episode: 0, settings: { playerCount: 3 } });
  const second = episodeOptions({ episode: 1, settings: { playerCount: 3 } });

  assert.equal(first.controllerRoleForPlayer(0), 'alexios');
  assert.equal(first.controllerRoleForPlayer(1), RANDOM_OPPONENT_ID);
  assert.equal(second.controllerRoleForPlayer(0), RANDOM_OPPONENT_ID);
  assert.equal(second.controllerRoleForPlayer(1), 'alexios');
});

test('official final scoring remains category-share based', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 1, seed: 93 });
  const final = buildFinalScores(state);
  assert.equal(final.scores.length, 3);
  assert.equal(final.scores[0].categories.length, 4);
});
