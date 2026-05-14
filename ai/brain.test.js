import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  AI_MODEL_MISSING_MESSAGE,
  buildAIOrders,
  createAIMeta,
  isAIPlayer,
  loadBrowserNeuralModel,
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
  assignRoundPotentialRewards,
  assignTerminalReturns,
  computeFallBlameShares,
  computeScorePotentials,
  computeTerminalRewards,
  evaluatePolicy,
  resolveEpisodeSettings,
  resolveEpisodeSeed,
  runSelfPlayEpisode,
  runSelfPlayRoundEpisode,
  runTrainingEpisode,
  trainSelfPlay,
} from './selfPlay.js';
import {
  checkpointPathFor,
  createCheckpointManager,
  createProgressReporter,
  resolveResumeEpisodeOffset,
  resolveTrainingOptions,
} from './train.js';
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

test('AI deal actions are temporarily disabled even when requested', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 2, seed: 26 });
  for (const player of state.players) player.gold = Math.max(player.gold, 8);

  const actions = listLegalCourtActions(state, 0, { includeDeals: true });
  const deals = actions.filter((action) => action.payload?.action?.startsWith('deal-'));

  assert.equal(AI_DEALS_ENABLED, false);
  assert.equal(deals.length, 0);
});

test('Constantinople fall gives every player a losing terminal reward', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 41 });
  state.gameOver = { type: 'fall', message: 'Constantinople has fallen.' };
  const rewards = computeTerminalRewards(state);
  assert.deepEqual(Object.values(rewards), [-1, -1, -1, -1]);
});

test('terminal rewards default to sparse outcomes with score shaping opt-in', () => {
  const state = createGameState({ playerCount: 3, deckSize: 1, seed: 42 });
  state.phase = 'scoring';
  state.players[0].gold = 12;
  state.players[1].gold = 0;
  state.players[2].gold = 0;

  const sparse = computeTerminalRewards(state);
  assert.deepEqual([sparse[0], sparse[1], sparse[2]], [1, 0, 0]);

  const scoreShaped = computeTerminalRewards(state, { terminalRewardMode: 'score' });
  assert.equal(scoreShaped[0], 1.1);
  assert.ok(scoreShaped[1] < 0);
  assert.notDeepEqual([scoreShaped[0], scoreShaped[1], scoreShaped[2]], [1, 0, 0]);
});

test('fall rewards punish defensive free-riding instead of every player equally', () => {
  const state = createGameState({ playerCount: 3, deckSize: 1, seed: 43 });
  state.gameOver = { type: 'fall', message: 'Constantinople has fallen.' };
  state.lastWarResult = {
    reachedCPL: true,
    contributions: [{ playerId: 1, troops: 4 }],
  };
  state.currentLevies = {};
  state.currentMercenaryTroops = {};
  state.basileusId = 0;
  for (const player of state.players) {
    player.majorTitles = [];
    player.professionalArmies = {};
  }
  state.players[0].professionalArmies.BASILEUS = 4;
  state.players[1].majorTitles = ['DOM_EAST'];
  state.players[1].professionalArmies.DOM_EAST = 4;
  state.players[2].majorTitles = ['PATRIARCH'];

  const blame = computeFallBlameShares(state);
  assert.deepEqual(blame, { 0: 1, 1: 0, 2: 0 });

  const rewards = computeTerminalRewards(state);
  assert.deepEqual(rewards, { 0: -1, 1: 0, 2: 0 });

  state.lastWarResult.contributions = [
    { playerId: 0, troops: 4 },
    { playerId: 1, troops: 4 },
  ];
  assert.deepEqual(computeTerminalRewards(state), { 0: 0, 1: 0, 2: 0 });
});

test('score potential follows official score points and game progress', () => {
  const state = createGameState({ playerCount: 3, deckSize: 2, seed: 44 });
  state.round = 1;
  for (const theme of Object.values(state.themes)) theme.occupied = true;
  state.players[0].gold = 12;
  state.players[1].gold = 0;
  state.players[2].gold = 0;

  const potentials = computeScorePotentials(state);
  assert.equal(potentials[0], 0.125);
  assert.equal(potentials[1], 0);
  assert.equal(potentials[2], 0);
});

test('round score shaping is attached once to the latest player decision', () => {
  const transitions = [
    { playerId: 0, reward: 0 },
    { playerId: 1, reward: 0 },
    { playerId: 0, reward: 0 },
  ];

  const deltas = assignRoundPotentialRewards(
    transitions,
    0,
    { 0: 0.1, 1: 0.2 },
    { 0: 0.3, 1: 0.1 },
  );

  assert.deepEqual(deltas, { 0: 0.19999999999999998, 1: -0.1 });
  assert.deepEqual(transitions.map((transition) => transition.reward), [0, -0.1, 0.19999999999999998]);
});

test('terminal returns are assigned to every neural decision', () => {
  const transitions = [
    { playerId: 0, reward: 0 },
    { playerId: 1, reward: 0 },
    { playerId: 0, reward: 0 },
    { playerId: 0, reward: 0 },
  ];

  assignTerminalReturns(transitions, { 0: 1, 1: -1 }, { returnDiscount: 0.5 });

  assert.deepEqual(transitions.map((transition) => transition.return), [0.25, -1, 0.5, 1]);
});

test('cumulative returns include intermediate shaped rewards', () => {
  const transitions = [
    { playerId: 0, reward: 0.25 },
    { playerId: 0, reward: 0.5 },
  ];

  assignTerminalReturns(transitions, { 0: 1 }, { returnDiscount: 0.5 });

  assert.deepEqual(transitions.map((transition) => transition.return), [1, 1.5]);
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
  assert.equal(resolveTrainingOptions({ includeDeals: 'true' }).includeDeals, false);
  assert.equal(defaults.opponentMix, true);
  assert.equal(defaults.heuristicOpponentRate, 0);
  assert.equal(defaults.humanOpponentRate, 0.25);
  assert.equal(defaults.trainingEpochs, 3);
  assert.equal(defaults.terminalRewardMode, 'sparse');
  assert.equal(defaults.returnDiscount, 1);
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

test('training CLI exposes round snapshot rollout mode', () => {
  const options = resolveTrainingOptions({
    mode: 'snapshot',
    rolloutRounds: '3',
    snapshotRoundMin: '4',
    snapshotRoundMax: '2',
  });

  assert.equal(options.trainingMode, 'round');
  assert.equal(options.rolloutRounds, 3);
  assert.equal(options.snapshotRound, undefined);
  assert.equal(options.snapshotRoundMin, 2);
  assert.equal(options.snapshotRoundMax, 4);
  assert.equal(resolveTrainingOptions({ trainingMode: 'episode' }).trainingMode, 'episode');
});

test('training CLI exposes hybrid episode and round rollout mode', () => {
  const options = resolveTrainingOptions({
    trainingMode: 'mixed',
    roundModeRate: '0.25',
  });

  assert.equal(options.trainingMode, 'hybrid');
  assert.equal(options.roundModeRate, 0.25);
  assert.equal(resolveTrainingOptions({ mode: 'mix', roundSnapshotRate: '0.75' }).roundModeRate, 0.75);
});

test('resume training continues checkpoint numbering from previous work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basileus-checkpoints-'));
  const out = join(dir, 'latest.json');
  writeFileSync(join(dir, 'latest-ep000405.json'), '{}');
  writeFileSync(join(dir, 'latest-ep001000.json'), '{}');

  assert.equal(
    resolveResumeEpisodeOffset({ metadata: { episodes: 1000 } }, out, out, dir),
    1000,
  );
  assert.equal(
    checkpointPathFor(out, dir, 1210),
    join(dir, 'latest-ep001210.json'),
  );

  writeFileSync(join(dir, 'latest-ep001210.json'), '{}');
  assert.equal(
    resolveResumeEpisodeOffset({ metadata: { episodes: 1000 } }, out, out, dir),
    1210,
  );

  const checkpointPayload = {
    metadata: {
      checkpoint: true,
      checkpointEpisode: 810,
      episodes: 1000,
    },
  };
  const emptyDir = mkdtempSync(join(tmpdir(), 'basileus-empty-checkpoints-'));
  assert.equal(
    resolveResumeEpisodeOffset(
      checkpointPayload,
      join(emptyDir, 'latest-ep000810.json'),
      out,
      emptyDir,
    ),
    810,
  );
  assert.equal(
    resolveResumeEpisodeOffset(
      checkpointPayload,
      join(dir, 'latest-ep000810.json'),
      out,
      dir,
      false,
    ),
    810,
  );
});

test('resume checkpoint manager keeps the loaded model as promotion baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basileus-promotion-'));
  const out = join(dir, 'latest.json');
  const network = createNetwork({ seed: 57 });
  const manager = createCheckpointManager({
    episodes: 1,
    playerCount: 3,
    deckSize: 1,
    seed: 57,
    checkpointEvalEpisodes: 1,
    checkpointOpponentLimit: 1,
    includeDeals: false,
    quiet: true,
    promotionBaselineNetwork: network,
    promotionBaselinePath: out,
    trainingEpisodeOffset: 1000,
  }, out, {
    checkpointDir: dir,
    checkpointEvalSeed: 57,
  });

  assert.equal(manager.best.baseline, true);
  assert.equal(manager.best.episode, 1000);
  const result = manager.saveCheckpoint({
    completed: 1,
    network,
    stats: { episodes: 1, survivals: 0, falls: 1, truncated: 0 },
  });

  assert.equal(result.path, join(dir, 'latest-ep001001.json'));
  assert.equal(manager.best.baseline, true);
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
  assert.equal(typeof stats.policyLoss, 'number');
  assert.equal(typeof stats.valueLoss, 'number');
  assert.equal(typeof stats.returnSum, 'number');
  assert.equal(stats.returnCount, stats.transitions);
  assert.ok(stats.playerOutcomes.byPlayer['0'].appearances > 0);
  assert.ok(stats.playerOutcomes.byRole.learner.appearances > 0);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].completed, 1);
  assert.equal(progress[0].stats.transitions, stats.transitions);
  assert.equal(typeof progress[0].stats.policyLoss, 'number');
  assert.equal(typeof progress[0].stats.valueLoss, 'number');

  const dir = mkdtempSync(join(tmpdir(), 'basileus-ai-'));
  const path = join(dir, 'model.json');
  saveModelFileSync(network, path, { test: true });
  const loaded = loadModelFileSync(path);
  assert.equal(loaded.inputSize, network.inputSize);
});

test('round snapshot episode trains from a legal short rollout', () => {
  const network = createNetwork({ seed: 73 });
  const result = runSelfPlayRoundEpisode({
    network,
    playerCount: 3,
    deckSize: 3,
    seed: 73,
    snapshotRound: 2,
    rolloutRounds: 1,
    maxSteps: 300,
    maxCourtActionsPerPlayer: 2,
    opponentMix: false,
  });

  assert.equal(result.stats.trainingMode, 'round');
  assert.equal(result.stats.snapshotRound, 2);
  assert.equal(result.stats.rolloutRounds, 1);
  assert.equal(result.stats.rounds, 1);
  assert.ok(result.stats.preludeSteps > 0);
  assert.ok(result.state.round >= 2);
  assert.ok(result.transitions.length > 0);
  assert.equal(result.transitions.every((transition) => Number.isFinite(transition.return)), true);
});

test('completed round rollouts count as survival with current score leaders as winners', () => {
  const network = createNetwork({ seed: 78 });
  const result = runSelfPlayRoundEpisode({
    network,
    playerCount: 3,
    deckSize: 3,
    seed: 78,
    snapshotRound: 2,
    rolloutRounds: 1,
    maxSteps: 300,
    maxCourtActionsPerPlayer: 2,
    opponentMix: false,
  });
  const expectedWinners = new Set(buildFinalScores(result.state).winners.map((entry) => entry.playerId));
  const actualWinners = new Set(result.stats.playerOutcomes
    .filter((outcome) => outcome.won)
    .map((outcome) => outcome.playerId));

  for (const player of result.state.players) {
    assert.equal(result.rewards[player.id], expectedWinners.has(player.id) ? 1 : 0);
  }
  assert.equal(result.stats.fell, false);
  assert.equal(result.stats.survived, true);
  assert.equal(result.stats.outcomeCounted, true);
  assert.equal(result.stats.playerOutcomes.every((outcome) => outcome.survived), true);
  assert.deepEqual(actualWinners, expectedWinners);
});

test('round rollout feedback and rewards ignore snapshots that fall before learner play', () => {
  const result = runSelfPlayRoundEpisode({
    network: createNetwork({ seed: 79 }),
    playerCount: 3,
    deckSize: 3,
    seed: 79,
    snapshotRound: 3,
    snapshotMaxSteps: 1,
    rolloutRounds: 1,
    maxCourtActionsPerPlayer: 2,
    opponentMix: false,
  });

  assert.equal(result.transitions.length, 0);
  assert.equal(result.stats.outcomeCounted, false);
  assert.equal(result.stats.fell, false);
  assert.equal(result.stats.survived, false);
  assert.equal(result.stats.truncated, false);
  assert.deepEqual(result.stats.playerOutcomes, []);
  assert.deepEqual(Object.values(result.rewards), [0, 0, 0]);
});

test('trainer can run full training using only round snapshot rollouts', () => {
  const network = createNetwork({ seed: 74 });
  const stats = trainSelfPlay(network, {
    episodes: 2,
    trainingMode: 'round',
    playerCount: 3,
    deckSize: 3,
    seed: 74,
    snapshotRound: 2,
    rolloutRounds: 1,
    maxSteps: 300,
    maxCourtActionsPerPlayer: 2,
    opponentMix: false,
  });

  assert.equal(stats.episodes, 2);
  assert.equal(stats.outcomeEpisodes, 2);
  assert.ok(stats.transitions > 0);
  assert.equal(stats.averageRounds, 1);
  assert.equal(stats.survivals, 2);
  assert.ok(stats.returnCount > 0);
});

test('hybrid training can select full games and round rollouts', () => {
  const roundResult = runTrainingEpisode({
    network: createNetwork({ seed: 75 }),
    trainingMode: 'hybrid',
    roundModeRate: 1,
    playerCount: 3,
    deckSize: 3,
    seed: 75,
    snapshotRound: 2,
    rolloutRounds: 1,
    maxSteps: 300,
    maxCourtActionsPerPlayer: 2,
    opponentMix: false,
  });
  assert.equal(roundResult.stats.trainingMode, 'round');
  assert.equal(roundResult.stats.rounds, 1);

  const episodeResult = runTrainingEpisode({
    network: createNetwork({ seed: 76 }),
    trainingMode: 'hybrid',
    roundModeRate: 0,
    playerCount: 3,
    deckSize: 1,
    seed: 76,
    maxSteps: 300,
    maxCourtActionsPerPlayer: 2,
    opponentMix: false,
  });
  assert.equal(episodeResult.stats.trainingMode, 'episode');
  assert.ok(episodeResult.stats.fell || episodeResult.state.phase === 'scoring');
});

test('trainer records the actual mix used by hybrid training', () => {
  const network = createNetwork({ seed: 77 });
  const stats = trainSelfPlay(network, {
    episodes: 8,
    trainingMode: 'hybrid',
    roundModeRate: 0.5,
    playerCount: 3,
    deckSize: 3,
    seed: 77,
    snapshotRound: 2,
    rolloutRounds: 1,
    maxSteps: 300,
    maxCourtActionsPerPlayer: 2,
    opponentMix: false,
  });

  assert.equal(stats.episodes, 8);
  assert.ok((stats.trainingModes.episode || 0) > 0);
  assert.ok((stats.trainingModes.round || 0) > 0);
});

test('training progress logs use only the latest feedback window', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const reporter = createProgressReporter({
      episodes: 4,
      logInterval: 2,
      quiet: false,
    }, 'ai/models/test.json', false);
    reporter.update({
      completed: 2,
      stats: {
        survivals: 1,
        falls: 1,
        truncated: 0,
        rounds: 12,
        transitions: 20,
        loss: 2,
        policyLoss: 0.75,
        valueLoss: 1.25,
        returnSum: 0,
        returnCount: 2,
        positiveReturns: 1,
        negativeReturns: 1,
        policyMix: { learner: 4, random: 2 },
        playerOutcomes: {
          byPlayer: {
            0: { appearances: 2, wins: 1, survivals: 1, falls: 1, truncated: 0, roleCounts: { learner: 2 }, playerCounts: { 0: 2 } },
            1: { appearances: 2, wins: 0, survivals: 1, falls: 1, truncated: 0, roleCounts: { random: 2 }, playerCounts: { 1: 2 } },
          },
          byRole: {
            learner: { appearances: 2, wins: 1, survivals: 1, falls: 1, truncated: 0, roleCounts: { learner: 2 }, playerCounts: { 0: 2 } },
            random: { appearances: 2, wins: 0, survivals: 1, falls: 1, truncated: 0, roleCounts: { random: 2 }, playerCounts: { 1: 2 } },
          },
        },
      },
      last: { seed: 11 },
    });
    reporter.update({
      completed: 4,
      stats: {
        survivals: 3,
        falls: 1,
        truncated: 0,
        rounds: 30,
        transitions: 50,
        loss: 3,
        policyLoss: 1.25,
        valueLoss: 1.75,
        returnSum: 2,
        returnCount: 4,
        positiveReturns: 3,
        negativeReturns: 1,
        policyMix: { learner: 10, random: 3 },
        playerOutcomes: {
          byPlayer: {
            0: { appearances: 4, wins: 3, survivals: 3, falls: 1, truncated: 0, roleCounts: { learner: 4 }, playerCounts: { 0: 4 } },
            1: { appearances: 4, wins: 0, survivals: 3, falls: 1, truncated: 0, roleCounts: { random: 4 }, playerCounts: { 1: 4 } },
          },
          byRole: {
            learner: { appearances: 4, wins: 3, survivals: 3, falls: 1, truncated: 0, roleCounts: { learner: 4 }, playerCounts: { 0: 4 } },
            random: { appearances: 4, wins: 0, survivals: 3, falls: 1, truncated: 0, roleCounts: { random: 4 }, playerCounts: { 1: 4 } },
          },
        },
      },
      last: { seed: 12 },
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.length, 2);
  assert.match(lines[0], /window=2 eps/);
  assert.match(lines[0], /survived=50\.0%/);
  assert.match(lines[0], /loss=2\.0000 policy=0\.7500 value=1\.2500/);
  assert.match(lines[1], /window=2 eps/);
  assert.match(lines[1], /30 decisions \(15\.0\/ep\)/);
  assert.match(lines[1], /survived=100\.0%/);
  assert.match(lines[1], /fell=0\.0%/);
  assert.match(lines[1], /loss=4\.0000 policy=1\.7500 value=2\.2500/);
  assert.match(lines[1], /return=1\.00 positive=100\.0%/);
  assert.match(lines[1], /players=p1\(learner\) win:100\.0% surv:100\.0%;p2\(random\) win:0\.0% surv:100\.0%/);
  assert.match(lines[1], /controllers=learner win:100\.0% surv:100\.0%;random win:0\.0% surv:100\.0%/);
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
  assert.equal(typeof stats.survivalRateByPlayer[0], 'number');
  assert.ok(stats.playerOutcomes.byPlayer[0].appearances > 0);
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
