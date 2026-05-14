import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGameState } from '../engine/state.js';
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
  AI_MODEL_MISSING_MESSAGE,
  buildAIOrders,
  createAIMeta,
  isAIPlayer,
  loadBrowserNeuralModel,
  runAICourtAutomation,
} from './brain.js';
import {
  applyLegalAction,
  listLegalCourtActions,
  listLegalOrderActions,
  listLegalRewardActions,
  listLegalTitleAssignments,
} from './legalActions.js';
import {
  appendHumanFeedbackSample,
  createHumanCourtActionSample,
  HUMAN_FEEDBACK_SCHEMA,
  humanFeedbackSamplesToTransitions,
} from './humanFeedback.js';
import {
  loadHumanFeedbackDatasetSync,
} from './humanFeedbackStore.js';
import {
  buildCandidateInputs,
  NETWORK_INPUT_SIZE,
  OBSERVATION_SIZE,
} from './features.js';
import { createNetwork } from './network.js';
import { loadModelFileSync, saveModelFileSync } from './modelStore.js';
import {
  computeTerminalRewards,
  evaluatePolicy,
  resolveEpisodeSettings,
  resolveEpisodeSeed,
  runSelfPlayEpisode,
  trainSelfPlay,
} from './selfPlay.js';
import { resolveTrainingOptions } from './train.js';
import { runTournament } from './tournament.js';

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

function createConfirmFavoringNetwork() {
  const weights = new Float64Array(NETWORK_INPUT_SIZE * 2);
  weights[OBSERVATION_SIZE + 1] = 10;
  return {
    version: 1,
    inputSize: NETWORK_INPUT_SIZE,
    hiddenSizes: [],
    outputSize: 2,
    step: 0,
    layers: [{
      inputSize: NETWORK_INPUT_SIZE,
      outputSize: 2,
      activation: 'linear',
      weights,
      biases: new Float64Array(2),
      weightMoments: new Float64Array(weights.length),
      weightVelocities: new Float64Array(weights.length),
      biasMoments: new Float64Array(2),
      biasVelocities: new Float64Array(2),
    }],
  };
}

test('AI metadata preserves human and AI seat boundaries', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 11 });
  const meta = createAIMeta(state, { humanPlayerIds: [1] });

  assert.equal(meta.pendingNeuralRuntime, true);
  assert.equal(meta.humanPlayerIds.has(1), true);
  assert.equal(isAIPlayer(meta, 0), true);
  assert.equal(isAIPlayer(meta, 1), false);
  assert.equal(meta.players[0].displayName, 'AI Seat 1');
});

test('AI decisions fail clearly when no local model exists', () => {
  const state = prepareInteractiveState();
  phaseOrders(state);
  const meta = createAIMeta(state, { humanPlayerIds: [1] });
  assert.throws(
    () => buildAIOrders(state, meta, 0),
    new RegExp(AI_MODEL_MISSING_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('bundled default AI model loads for runtime play', () => {
  const model = loadModelFileSync();
  assert.ok(model, 'ai/models/latest.json must be committed with the app');
  assert.equal(model.inputSize, NETWORK_INPUT_SIZE);
  assert.ok(model.layers.length > 0);
});

test('browser model loader can make missing models a startup error', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });

  try {
    assert.equal(await loadBrowserNeuralModel('missing-model.json'), null);
    await assert.rejects(
      () => loadBrowserNeuralModel('missing-model.json', { required: true }),
      /Neural AI model not found[\s\S]*HTTP 404/,
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

  const meta = createAIMeta(state, {
    humanPlayerIds: [1],
    model: createConfirmFavoringNetwork(),
  });
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

  const meta = createAIMeta(state, {
    humanPlayerIds: [1],
    model: createNetwork({ seed: 20260514 }),
  });
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
    reconquestIndex: 0,
    themeName: rewardState.themes.OPS.name,
    defenderId: 0,
    defenderName: 'AI Seat 1',
    rank: 1,
    troops: 3,
    goldValue: 4,
    resolved: false,
    choice: null,
    gold: 0,
  }];
  const rewardActions = listLegalRewardActions(rewardState, 0);
  assert.equal(rewardActions.length, 2);
  for (const action of rewardActions) {
    assert.equal(applyLegalAction(cloneState(rewardState), action).ok, true);
  }
});

test('deal action space includes scaled and bundled bargains', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 2, seed: 26 });
  for (const player of state.players) player.gold = Math.max(player.gold, 8);

  const actions = listLegalCourtActions(state, 0, { includeDeals: true });
  const deals = actions.filter((action) => action.payload?.action === 'deal-send');

  assert.ok(deals.some((action) => action.payload.clauses.length >= 2));
  assert.ok(deals.some((action) => action.payload.clauses.some((clause) => (
    Number(clause.amount || clause.troopCount || 0) >= 3
  ))));
});

test('Constantinople fall gives every player a losing terminal reward', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 41 });
  state.gameOver = { type: 'fall', message: 'Constantinople has fallen.' };
  const rewards = computeTerminalRewards(state);
  assert.deepEqual(Object.values(rewards), [-1, -1, -1, -1]);
});

test('trainer defaults sample varied legal player counts, round lengths, and seeds', () => {
  const samples = Array.from({ length: 24 }, (_, index) => resolveEpisodeSettings({ seed: 1234 }, index));
  const playerCounts = new Set(samples.map((sample) => sample.playerCount));
  const roundLengths = new Set(samples.map((sample) => sample.deckSize));
  const seeds = new Set(samples.map((sample) => sample.seed));

  assert.equal(seeds.size, samples.length);
  assert.ok([...playerCounts].every((count) => count >= 3 && count <= 5));
  assert.ok([...roundLengths].every((rounds) => rounds >= 6 && rounds <= 12));
  assert.ok(playerCounts.size > 1);
  assert.ok(roundLengths.size > 1);

  const fixed = resolveEpisodeSettings({ seed: 1234, playerCount: 4, deckSize: 8 }, 3);
  assert.equal(fixed.playerCount, 4);
  assert.equal(fixed.deckSize, 8);

  const randomSeeds = Array.from({ length: 8 }, (_, index) => resolveEpisodeSeed({}, index));
  assert.equal(new Set(randomSeeds).size, randomSeeds.length);
  assert.equal(resolveEpisodeSeed({ seed: 88 }, 2), resolveEpisodeSeed({ seed: 88 }, 2));
});

test('training CLI defaults to automatic workers and sampled game setup', () => {
  const defaults = resolveTrainingOptions({});
  assert.equal(defaults.workersAuto, true);
  assert.ok(defaults.workers >= 1);
  assert.equal(defaults.seed, undefined);
  assert.equal(defaults.seedWasSpecified, false);
  assert.equal(defaults.seedMode, 'random-each-episode');
  assert.ok(Number.isInteger(defaults.modelSeed));
  assert.equal(defaults.playerCount, undefined);
  assert.deepEqual([defaults.playerMin, defaults.playerMax], [3, 5]);
  assert.equal(defaults.deckSize, undefined);
  assert.deepEqual([defaults.roundMin, defaults.roundMax], [6, 12]);
  assert.equal(defaults.includeDeals, false);
  assert.equal(defaults.opponentMix, true);
  assert.equal(defaults.heuristicOpponentRate, 0);
  assert.equal(defaults.humanOpponentRate, 0.25);
  assert.equal(defaults.trainingEpochs, 3);
  assert.equal(defaults.humanOpponentEpochs, 8);
  assert.equal(defaults.humanFeedbackWeight, 0);
  assert.equal(defaults.humanFeedbackReturn, 0.75);
  assert.ok(defaults.checkpointInterval >= 1);

  const fixed = resolveTrainingOptions({
    players: '4',
    rounds: '8',
    workers: '2',
    seed: '99',
  });
  assert.equal(fixed.workersAuto, false);
  assert.equal(fixed.workers, 2);
  assert.equal(fixed.seedWasSpecified, true);
  assert.equal(fixed.seedMode, 'deterministic-derived');
  assert.equal(fixed.playerCount, 4);
  assert.equal(fixed.deckSize, 8);
});

test('local trainer smoke run writes and reloads a neural model', () => {
  const network = createNetwork({ seed: 51 });
  const progress = [];
  const stats = trainSelfPlay(network, {
    episodes: 1,
    playerCount: 3,
    deckSize: 1,
    seed: 51,
    maxSteps: 200,
    maxCourtActionsPerPlayer: 2,
    onProgress: (entry) => progress.push(entry),
  });
  assert.equal(stats.episodes, 1);
  assert.ok(stats.transitions > 0);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].completed, 1);
  assert.equal(progress[0].stats.transitions, stats.transitions);

  const dir = mkdtempSync(join(tmpdir(), 'basileus-ai-'));
  const path = join(dir, 'model.json');
  saveModelFileSync(network, path, { test: true });
  const loaded = loadModelFileSync(path);
  assert.equal(loaded.inputSize, network.inputSize);
});

test('unseeded trainer episodes use independent random seeds', () => {
  const network = createNetwork({ seed: 55 });
  const progress = [];
  const stats = trainSelfPlay(network, {
    episodes: 2,
    playerCount: 3,
    deckSize: 1,
    maxSteps: 200,
    maxCourtActionsPerPlayer: 2,
    onProgress: (entry) => progress.push(entry),
  });
  const seeds = progress.map((entry) => entry.last.seed);
  assert.equal(stats.episodes, 2);
  assert.equal(seeds.length, 2);
  assert.equal(new Set(seeds).size, 2);
});

test('self-play episode completes with legal neural decisions', () => {
  const network = createNetwork({ seed: 61 });
  const result = runSelfPlayEpisode({
    network,
    playerCount: 3,
    deckSize: 1,
    seed: 61,
    maxSteps: 200,
    maxCourtActionsPerPlayer: 2,
  });
  assert.ok(result.stats.fell || result.state.phase === 'scoring');
  assert.ok(result.transitions.length > 0);
});

test('self-play stats expose behavior returns, frontier share, and income shares', () => {
  const network = createNetwork({ seed: 64 });
  const result = runSelfPlayEpisode({
    network,
    playerCount: 3,
    deckSize: 1,
    seed: 64,
    maxSteps: 200,
    maxCourtActionsPerPlayer: 2,
  });

  assert.ok(Object.keys(result.stats.actionStats.outcomes.byKind).length > 0);
  assert.ok(result.stats.actionStats.orderFrontierShare.count > 0);
  assert.ok(result.stats.actionStats.economics.incomeShare.gold.count > 0);
});

test('human feedback samples replay as imitation transitions', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 1, seed: 65 });
  const meta = createAIMeta(state, { humanPlayerIds: [0], model: createNetwork({ seed: 65 }) });
  const actions = listLegalCourtActions(state, 0, { includeDeals: false });
  const action = actions.find((entry) => entry.kind === 'court') || actions[0];

  const sample = createHumanCourtActionSample(state, 0, action.payload);
  assert.equal(appendHumanFeedbackSample(meta, sample), true);

  const transitions = humanFeedbackSamplesToTransitions(meta.humanFeedback.samples, { returnValue: 0.5 });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].return, 0.5);
  assert.ok(transitions[0].inputs.length > 0);

  const dir = mkdtempSync(join(tmpdir(), 'basileus-human-games-'));
  const nested = join(dir, 'nested');
  mkdirSync(nested);
  const payload = JSON.stringify({
    schema: HUMAN_FEEDBACK_SCHEMA,
    version: 1,
    samples: [sample],
  });
  writeFileSync(join(dir, 'one.json'), payload);
  writeFileSync(join(nested, 'two.json'), payload);

  const dataset = loadHumanFeedbackDatasetSync(dir, { returnValue: 0.5 });
  assert.equal(dataset.files.length, 2);
  assert.equal(dataset.samples.length, 2);
  assert.equal(dataset.transitions.length, 2);
});

test('neural inputs expose extended neutral game indicators', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 2, seed: 66 });
  const actions = listLegalCourtActions(state, 0, { includeDeals: false });
  assert.ok(actions.length > 0);
  const [input] = buildCandidateInputs(state, 0, actions.slice(0, 1));
  assert.equal(input.length, NETWORK_INPUT_SIZE);
  assert.ok(NETWORK_INPUT_SIZE > 288);
  assert.ok(Array.from(input.slice(288)).some((value) => Math.abs(value) > 0));
});

test('stalled or step-limited training episodes receive losing terminal rewards', () => {
  const network = createNetwork({ seed: 71 });
  const result = runSelfPlayEpisode({
    network,
    playerCount: 3,
    deckSize: 6,
    seed: 71,
    maxSteps: 1,
    includeDeals: false,
  });
  assert.equal(result.stats.fell, true);
  assert.equal(result.stats.truncated, true);
  assert.equal(result.stats.terminalReason, 'max-steps');
  assert.deepEqual(Object.values(result.rewards), [-1, -1, -1]);
});

test('evaluation reports survival, scoring, action, and policy metrics', () => {
  const stats = evaluatePolicy({
    episodes: 1,
    playerCount: 3,
    deckSize: 1,
    seed: 81,
    includeDeals: false,
  });
  assert.equal(stats.episodes, 1);
  assert.equal(typeof stats.fallRate, 'number');
  assert.equal(typeof stats.survivalRate, 'number');
  assert.ok(stats.actionStats.total > 0);
  assert.ok(Object.keys(stats.policyMix).length > 0);
});

test('tournament harness compares a model against baselines', () => {
  const network = createNetwork({ seed: 91 });
  const report = runTournament({
    network,
    humanOpponentNetwork: createNetwork({ seed: 92 }),
    episodes: 1,
    playerCount: 3,
    deckSize: 1,
    seed: 91,
    includeDeals: false,
    includeRandomBaseline: true,
  });
  assert.equal(report.episodes, 1);
  assert.equal(typeof report.score, 'number');
  assert.ok(report.matchups.modelVsRandom);
  assert.ok(report.matchups.modelVsHeuristic);
  assert.ok(report.matchups.modelVsHuman);
  assert.ok(report.matchups.humanVsModel);
  assert.equal(report.matchups.humanVsModel.weight, 0);
  assert.ok(report.matchups.selfPlay);
  assert.ok(report.matchups.randomBaseline);
});
