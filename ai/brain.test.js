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
  AI_POLICY_MISSING_MESSAGE,
  buildAIOrders,
  createAIMeta,
  isAIPlayer,
  loadBrowserAiPolicy,
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
  buildCandidateFeatures,
} from './features.js';
import {
  createLearningPolicy,
  hydrateLearningPolicy,
  scoreFeatureMap,
  trainFeatureBatch,
} from './policy.js';
import {
  loadOpponentRosterSync,
  loadPolicyFileSync,
  savePolicyFileSync,
} from './policyStore.js';
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
import {
  runTournament,
  runTournamentSuite,
  scoreTournamentReport,
} from './tournament.js';

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

function createConfirmFavoringPolicy() {
  const policy = createLearningPolicy();
  policy.sharedWeights['court.confirm'] = 10;
  return policy;
}

test('AI metadata preserves human and AI seat boundaries', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 11 });
  const meta = createAIMeta(state, { humanPlayerIds: [1] });

  assert.equal(meta.pendingPolicyRuntime, true);
  assert.equal(meta.humanPlayerIds.has(1), true);
  assert.equal(isAIPlayer(meta, 0), true);
  assert.equal(isAIPlayer(meta, 1), false);
  assert.equal(meta.players[0].displayName, 'Unnamed AI');
  assert.equal(typeof meta.players[0].personalityId, 'string');
});

test('AI decisions fail clearly when no local policy exists', () => {
  const state = prepareInteractiveState();
  phaseOrders(state);
  const meta = createAIMeta(state, { humanPlayerIds: [1] });
  assert.throws(
    () => buildAIOrders(state, meta, 0),
    new RegExp(AI_POLICY_MISSING_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('bundled default AI policy loads for runtime play', () => {
  const [opponent] = loadOpponentRosterSync();
  assert.ok(opponent, 'ai/opponents must contain at least one committed AI opponent');
  const policy = loadPolicyFileSync(opponent.path);
  assert.ok(policy, 'opponent policy must load from ai/opponents');
  assert.equal(policy.schema, 'basileus.evolving-policy.v1');
  assert.ok(policy.identity?.firstName);
  assert.equal(Object.keys(policy.personalities).length, 1);
});

test('browser policy loader can make missing policies a startup error', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });

  try {
    assert.equal(await loadBrowserAiPolicy('missing-policy.json'), null);
    await assert.rejects(
      () => loadBrowserAiPolicy('missing-policy.json', { required: true }),
      /Evolving AI opponent not found[\s\S]*HTTP 404/,
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
    policy: createConfirmFavoringPolicy(),
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
    policy: createLearningPolicy({ seed: 20260514 }),
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

test('AI deal actions stay disabled until deal policy is intentionally enabled', () => {
  assert.equal(AI_DEALS_ENABLED, false);
});

test('terminal reward punishes only fall free riding when blame can be assigned', () => {
  const state = prepareInteractiveState({ playerCount: 3, seed: 41 });
  state.gameOver = { type: 'fall' };
  state.lastWarResult = {
    reachedCPL: true,
    contributions: [
      { playerId: 0, troops: 10 },
      { playerId: 1, troops: 0 },
      { playerId: 2, troops: 0 },
    ],
  };

  const blame = computeFallBlameShares(state);
  assert.ok(blame);
  const rewards = computeTerminalRewards(state);
  assert.equal(rewards[0], 0);
  assert.ok(rewards[1] <= 0);
  assert.ok(rewards[2] <= 0);
});

test('official scoring potential follows score shares and round progress', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 3, seed: 42 });
  const before = computeScorePotentials(state);
  assert.equal(Object.keys(before).length, 3);
  assert.ok(Object.values(before).every((value) => value >= 0 && value <= 1));

  const transitions = [{ playerId: 0, reward: 0 }, { playerId: 1, reward: 0 }];
  const after = { ...before, 0: before[0] + 0.25 };
  const deltas = assignRoundPotentialRewards(transitions, 0, before, after);
  assert.equal(deltas[0], 0.25);
  assert.equal(transitions[0].reward, 0.25);
});

test('terminal returns are assigned to every policy decision', () => {
  const transitions = [
    { playerId: 0, reward: 0 },
    { playerId: 0, reward: 0.25 },
    { playerId: 1, reward: 0 },
  ];
  assignTerminalReturns(transitions, { 0: 1, 1: -1 });
  assert.equal(transitions[1].return, 1.25);
  assert.equal(transitions[0].return, 1.25);
  assert.equal(transitions[2].return, -1);
});

test('trainer defaults sample varied legal player counts, round lengths, and seeds', () => {
  const first = resolveEpisodeSettings({}, 0);
  const second = resolveEpisodeSettings({}, 1);
  assert.ok(first.playerCount >= 3 && first.playerCount <= 5);
  assert.ok(first.deckSize >= 6 && first.deckSize <= 12);
  assert.notEqual(resolveEpisodeSeed({}, 0), resolveEpisodeSeed({}, 1));
  assert.notEqual(first.seed, second.seed);
});

test('learning CLI defaults to automatic workers and sampled game setup', () => {
  const defaults = resolveTrainingOptions({});
  assert.ok(defaults.workers >= 1);
  assert.equal(defaults.workersAuto, true);
  assert.equal(defaults.seedWasSpecified, false);
  assert.equal(defaults.seedMode, 'random-each-episode');
  assert.ok(Number.isInteger(defaults.policySeed));
  assert.equal(defaults.playerCount, undefined);
  assert.equal(defaults.playerMin, 3);
  assert.equal(defaults.playerMax, 5);
  assert.equal(defaults.deckSize, undefined);
  assert.equal(defaults.roundMin, 6);
  assert.equal(defaults.roundMax, 12);
  assert.equal(resolveTrainingOptions({ includeDeals: 'true' }).includeDeals, false);
  assert.equal(defaults.trainingMode, 'hybrid');
  assert.equal(defaults.terminalRewardMode, 'score');
  assert.equal(defaults.opponentMix, true);
  assert.ok(defaults.randomOpponentRate > 0);
  assert.ok(defaults.heuristicOpponentRate > 0);
  assert.equal(defaults.humanFeedbackWeight, 0);
  assert.equal(defaults.humanFeedbackReturn, 1);
  assert.ok(defaults.checkpointEvalEpisodes > 4);
  assert.ok(defaults.checkpointEvalSeedCount > 1);

  const fixed = resolveTrainingOptions({
    players: '3',
    rounds: '2',
    seed: '44',
    workers: '1',
  });
  assert.equal(fixed.playerCount, 3);
  assert.equal(fixed.deckSize, 2);
  assert.equal(fixed.seed, 44);
  assert.equal(fixed.workers, 1);
  assert.equal(fixed.workersAuto, false);
});

test('learning CLI exposes round and hybrid rollout modes', () => {
  assert.equal(resolveTrainingOptions({ trainingMode: 'round' }).trainingMode, 'round');
  assert.equal(resolveTrainingOptions({ trainingMode: 'episode' }).trainingMode, 'episode');
  assert.equal(resolveTrainingOptions({ trainingMode: 'mixed' }).trainingMode, 'hybrid');
  assert.equal(resolveTrainingOptions({ mode: 'mix', roundSnapshotRate: '0.75' }).roundModeRate, 0.75);
});

test('feature training does not duplicate core weights into the personality bucket', () => {
  const policy = createLearningPolicy({ seed: 52 });
  const report = trainFeatureBatch(policy, [{
    playerId: 0,
    personalityId: 'core',
    chosenIndex: 0,
    return: 1,
    features: [
      { 'court.confirm': 1 },
      { 'court.confirm': -1 },
    ],
  }], {
    learningRate: 1,
    temperature: 1,
  });

  assert.equal(report.count, 1);
  assert.ok(policy.sharedWeights['court.confirm'] > 0);
  assert.deepEqual(policy.personalities.core.weights, {});
});

test('legacy duplicated personality weights collapse on policy hydration', () => {
  const policy = hydrateLearningPolicy({
    schema: 'basileus.evolving-policy.v1',
    sharedWeights: { 'court.confirm': 1.5 },
    personalities: {
      core: {
        weights: { 'court.confirm': 1.5 },
      },
    },
  });

  assert.equal(scoreFeatureMap(policy, { 'court.confirm': 1 }), 1.5);
  assert.deepEqual(policy.personalities.core.weights, {});
});

test('resume learning continues checkpoint numbering from previous work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basileus-policy-checkpoints-'));
  const out = join(dir, 'latest.json');
  writeFileSync(join(dir, 'latest-ep000020.json'), '{}');
  assert.equal(resolveResumeEpisodeOffset({ metadata: { totalTrainingEpisodes: 10 } }, out, out, dir), 20);
  assert.equal(resolveResumeEpisodeOffset({ metadata: { totalTrainingEpisodes: 30 } }, out, out, dir), 30);
});

test('checkpoint manager keeps the loaded policy as promotion baseline', () => {
  const policy = createLearningPolicy({ seed: 57 });
  const checkpoints = createCheckpointManager({
    promotionBaselinePolicy: policy,
    promotionBaselinePath: 'baseline.json',
    trainingEpisodeOffset: 1000,
    checkpointEvalEpisodes: 1,
    checkpointEvalSeedCount: 1,
    checkpointOpponentLimit: 1,
    playerCount: 3,
    deckSize: 1,
    maxSteps: 200,
    maxCourtActionsPerPlayer: 2,
    quiet: true,
  }, 'ai/opponents/latest.json', { checkpointDir: mkdtempSync(join(tmpdir(), 'basileus-policy-baseline-')) });
  assert.equal(checkpoints.best.baseline, true);
  assert.equal(checkpoints.best.episode, 1000);
  assert.ok(checkpoints.best.aiPolicy);
});

test('local learner smoke run writes and reloads an evolving policy', () => {
  const policy = createLearningPolicy({ seed: 51 });
  const stats = trainSelfPlay(policy, {
    episodes: 1,
    playerCount: 3,
    deckSize: 1,
    seed: 51,
    maxSteps: 200,
    maxCourtActionsPerPlayer: 2,
    opponentMix: false,
  });
  assert.equal(stats.episodes, 1);
  assert.ok(policy.step > 0);

  const dir = mkdtempSync(join(tmpdir(), 'basileus-policy-'));
  const path = join(dir, 'policy.json');
  savePolicyFileSync(policy, path, { test: true });
  const loaded = loadPolicyFileSync(path);
  assert.equal(loaded.schema, policy.schema);
  assert.deepEqual(Object.keys(loaded.personalities), Object.keys(policy.personalities));
});

test('round snapshot episode learns from a legal short rollout', () => {
  const policy = createLearningPolicy({ seed: 73 });
  const result = runSelfPlayRoundEpisode({
    aiPolicy: policy,
    trainingMode: 'round',
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
  assert.ok(result.stats.outcomeCounted || result.transitions.length === 0);
});

test('hybrid learning can select full games and round rollouts', () => {
  const roundResult = runTrainingEpisode({
    aiPolicy: createLearningPolicy({ seed: 75 }),
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

  const episodeResult = runTrainingEpisode({
    aiPolicy: createLearningPolicy({ seed: 76 }),
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
});

test('learning progress logs use only the latest feedback window', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const reporter = createProgressReporter({
      episodes: 4,
      logInterval: 2,
      quiet: false,
    }, 'ai/opponents/test.json', false);
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
        valueLoss: 0,
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
        valueLoss: 0,
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
  assert.match(lines[1], /30 decisions/);
  assert.match(lines[1], /controllers=learner/);
});

test('unseeded learner episodes use independent random seeds', () => {
  const policy = createLearningPolicy({ seed: 55 });
  const progress = [];
  const stats = trainSelfPlay(policy, {
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

test('self-play episode completes with legal policy decisions', () => {
  const policy = createLearningPolicy({ seed: 61 });
  const result = runSelfPlayEpisode({
    aiPolicy: policy,
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
  const policy = createLearningPolicy({ seed: 64 });
  const result = runSelfPlayEpisode({
    aiPolicy: policy,
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

test('human feedback samples replay as learning transitions', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 1, seed: 65 });
  const meta = createAIMeta(state, { humanPlayerIds: [0], policy: createLearningPolicy({ seed: 65 }) });
  const actions = listLegalCourtActions(state, 0, { includeDeals: false });
  const action = actions.find((entry) => entry.kind === 'court') || actions[0];

  const sample = createHumanCourtActionSample(state, 0, action.payload);
  assert.equal(appendHumanFeedbackSample(meta, sample), true);

  const transitions = humanFeedbackSamplesToTransitions(meta.humanFeedback.samples, { returnValue: 0.5 });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].return, 0.5);
  assert.ok(transitions[0].features.length > 0);

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

test('semantic action features expose neutral game indicators', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 2, seed: 66 });
  const actions = listLegalCourtActions(state, 0, { includeDeals: false });
  assert.ok(actions.length > 0);
  const [features] = buildCandidateFeatures(state, 0, actions.slice(0, 1));
  assert.equal(features.bias, 1);
  assert.ok(Object.keys(features).some((key) => key.startsWith('score.')));
  assert.ok(Object.keys(features).some((key) => key.startsWith('context.')));
});

test('stalled or step-limited learning episodes receive losing terminal rewards', () => {
  const policy = createLearningPolicy({ seed: 71 });
  const result = runSelfPlayEpisode({
    aiPolicy: policy,
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

test('tournament harness compares a policy against baselines', () => {
  const policy = createLearningPolicy({ seed: 91 });
  const report = runTournament({
    aiPolicy: policy,
    humanOpponentPolicy: createLearningPolicy({ seed: 92 }),
    episodes: 1,
    playerCount: 3,
    deckSize: 1,
    seed: 91,
    includeDeals: false,
    includeRandomBaseline: true,
    maxSteps: 200,
    maxCourtActionsPerPlayer: 2,
  });
  assert.equal(report.episodes, 1);
  assert.equal(typeof report.score, 'number');
  assert.ok(report.matchups.policyVsRandom);
  assert.equal(typeof report.matchups.policyVsRandom.rewardByRole.learner, 'number');
  assert.ok(report.matchups.policyVsHeuristic);
  assert.ok(report.matchups.policyVsHuman);
  assert.ok(report.matchups.humanVsPolicy);
  assert.equal(report.matchups.humanVsPolicy.weight, 0);
  assert.ok(report.matchups.selfPlay);
  assert.ok(report.matchups.randomBaseline);

  const suite = runTournamentSuite({
    aiPolicy: policy,
    episodes: 1,
    seedCount: 2,
    playerCount: 3,
    deckSize: 1,
    seed: 91,
    maxSteps: 200,
    maxCourtActionsPerPlayer: 2,
  });
  assert.equal(suite.seedCount, 2);
  assert.equal(suite.runs.length, 2);
  assert.equal(suite.confidence.count, 2);
  assert.equal(scoreTournamentReport(suite), suite.adjustedScore);
});

test('official final scoring remains category-share based', () => {
  const state = prepareInteractiveState({ playerCount: 3, deckSize: 1, seed: 93 });
  const final = buildFinalScores(state);
  assert.equal(final.scores.length, 3);
  assert.equal(final.scores[0].categories.length, 4);
});
