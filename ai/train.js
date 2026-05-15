import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readdirSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import {
  cloneLearningPolicy,
  createLearningPolicy,
  hydrateLearningPolicy,
  serializeLearningPolicy,
  trainFeatureBatch,
} from './policy.js';
import {
  DEFAULT_CHECKPOINT_DIR,
  DEFAULT_POLICY_PATH,
  loadPolicyPayloadSync,
  loadPolicyFileSync,
  savePolicyFileSync,
  uniqueOpponentPolicyPathSync,
} from './policyStore.js';
import {
  DEFAULT_HUMAN_GAMES_DIR,
  loadHumanFeedbackDatasetSync,
} from './humanFeedbackStore.js';
import {
  createEntropySeed,
  normalizeTrainingMode,
  resolveEpisodeSeed,
  runTrainingEpisode,
  trainSelfPlay,
  trainTransitions,
  recordTrainingReturns,
  createPlayerOutcomeStats,
  recordPlayerOutcomes,
  createActionStats,
  mergeActionStats,
  mergePolicyMixStats,
  TRAINING_MODES,
  TERMINAL_REWARD_MODES,
  normalizeTerminalRewardMode,
} from './selfPlay.js';
import {
  runTournamentSuite,
  scoreTournamentReport,
} from './tournament.js';
import {
  FEATURE_UNIT,
  OFFICIAL_MAX_SCORE,
  SCORE_CATEGORY_KEYS,
} from './features.js';

const DEFAULT_LEARNING_RATE = FEATURE_UNIT / Math.max(FEATURE_UNIT, OFFICIAL_MAX_SCORE);
const DEFAULT_ROUND_MODE_RATE = FEATURE_UNIT / 2;
const DEFAULT_OPPONENT_RATE = FEATURE_UNIT / Math.max(FEATURE_UNIT, SCORE_CATEGORY_KEYS.length);
const DEFAULT_HEURISTIC_OPPONENT_RATE = DEFAULT_OPPONENT_RATE;
const DEFAULT_CHECKPOINT_EVAL_EPISODES = SCORE_CATEGORY_KEYS.length * 2;
const DEFAULT_CHECKPOINT_EVAL_SEED_COUNT = 3;

if (!isMainThread && workerData?.kind === 'self-play-episode') {
  const aiPolicy = hydrateLearningPolicy(workerData.aiPolicy);
  const result = runTrainingEpisode({
    ...(workerData.options || {}),
    aiPolicy,
    episodeSeed: workerData.seed,
    episodeIndex: workerData.episodeIndex,
  });
  parentPort.postMessage({
    transitions: result.transitions,
    stats: result.stats,
  });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue != null) {
      args[key] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[key] = argv[index + 1];
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function numberArg(args, key, fallback) {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : fallback;
}

function hasArg(args, key) {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function booleanArg(args, key, fallback = false) {
  if (args[key] == null) return fallback;
  if (args[key] === true) return true;
  const value = String(args[key]).toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

function unitIntervalArg(args, key, fallback) {
  const value = numberArg(args, key, fallback);
  return Math.max(0, Math.min(1, value));
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeRange(min, max) {
  return min <= max ? [min, max] : [max, min];
}

function autoWorkerCount() {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : 1;
  return Math.max(1, Math.floor(cores > 1 ? cores - 1 : 1));
}

function resolveWorkers(args) {
  if (!hasArg(args, 'workers') || String(args.workers).toLowerCase() === 'auto') {
    return { workers: autoWorkerCount(), workersAuto: true };
  }
  return {
    workers: Math.max(1, Math.floor(numberArg(args, 'workers', 1))),
    workersAuto: false,
  };
}

function resolvePlayerOptions(args) {
  if (hasArg(args, 'players')) {
    const playerCount = clampInteger(args.players, 3, 5, 4);
    return { playerCount, playerMin: playerCount, playerMax: playerCount };
  }
  const [playerMin, playerMax] = normalizeRange(
    clampInteger(args.playerMin, 3, 5, 3),
    clampInteger(args.playerMax, 3, 5, 5),
  );
  return { playerCount: undefined, playerMin, playerMax };
}

function resolveRoundOptions(args) {
  const fixedRounds = hasArg(args, 'rounds')
    ? args.rounds
    : (hasArg(args, 'deckSize') ? args.deckSize : null);
  if (fixedRounds != null) {
    const deckSize = clampInteger(fixedRounds, 1, 99, 9);
    return { deckSize, roundMin: deckSize, roundMax: deckSize };
  }
  const [roundMin, roundMax] = normalizeRange(
    clampInteger(args.roundMin, 1, 99, 6),
    clampInteger(args.roundMax, 1, 99, 12),
  );
  return { deckSize: undefined, roundMin, roundMax };
}

export function resolveTrainingOptions(args = {}) {
  const seedWasSpecified = hasArg(args, 'seed');
  const seed = seedWasSpecified ? numberArg(args, 'seed', 1) : undefined;
  const workerOptions = resolveWorkers(args);
  const episodes = numberArg(args, 'episodes', 10);
  const roundModeRate = hasArg(args, 'roundModeRate')
    ? unitIntervalArg(args, 'roundModeRate', DEFAULT_ROUND_MODE_RATE)
    : (
      hasArg(args, 'roundSnapshotRate')
        ? unitIntervalArg(args, 'roundSnapshotRate', DEFAULT_ROUND_MODE_RATE)
        : unitIntervalArg(args, 'snapshotModeRate', DEFAULT_ROUND_MODE_RATE)
    );
  const snapshotRound = hasArg(args, 'snapshotRound') ? clampInteger(args.snapshotRound, 1, 99, 1) : undefined;
  const hasSnapshotRange = hasArg(args, 'snapshotRoundMin') || hasArg(args, 'snapshotRoundMax');
  const [snapshotRoundMin, snapshotRoundMax] = hasSnapshotRange
    ? normalizeRange(
      clampInteger(args.snapshotRoundMin, 1, 99, 1),
      clampInteger(args.snapshotRoundMax, 1, 99, 99),
    )
    : [undefined, undefined];
  const checkpointInterval = Math.floor(numberArg(
    args,
    'checkpointInterval',
    Math.max(1, Math.floor(episodes / 5)),
  ));
  return {
    episodes,
    ...workerOptions,
    seed,
    seedWasSpecified,
    seedMode: seedWasSpecified ? 'deterministic-derived' : 'random-each-episode',
    policySeed: seedWasSpecified ? seed : createEntropySeed(),
    ...resolvePlayerOptions(args),
    ...resolveRoundOptions(args),
    learningRate: numberArg(args, 'learningRate', DEFAULT_LEARNING_RATE),
    temperature: numberArg(args, 'temperature', FEATURE_UNIT),
    trainingEpochs: Math.max(1, Math.floor(numberArg(args, 'trainingEpochs', FEATURE_UNIT))),
    trainingMode: normalizeTrainingMode(args.trainingMode ?? args.mode ?? TRAINING_MODES.HYBRID),
    roundModeRate,
    rolloutRounds: Math.max(1, Math.floor(numberArg(args, 'rolloutRounds', 1))),
    snapshotRound,
    snapshotRoundMin,
    snapshotRoundMax,
    terminalRewardMode: normalizeTerminalRewardMode(args.terminalRewardMode ?? args.rewardMode ?? TERMINAL_REWARD_MODES.SCORE),
    returnDiscount: unitIntervalArg(args, 'returnDiscount', 1),
    includeDeals: false,
    opponentMix: booleanArg(args, 'opponentMix', true),
    randomOpponentRate: Math.max(0, numberArg(args, 'randomOpponentRate', DEFAULT_OPPONENT_RATE)),
    heuristicOpponentRate: Math.max(0, numberArg(args, 'heuristicOpponentRate', DEFAULT_HEURISTIC_OPPONENT_RATE)),
    humanOpponentRate: Math.max(0, numberArg(args, 'humanOpponentRate', DEFAULT_OPPONENT_RATE)),
    humanOpponentEpochs: Math.max(1, Math.floor(numberArg(args, 'humanOpponentEpochs', SCORE_CATEGORY_KEYS.length))),
    humanOpponentLearningRate: numberArg(args, 'humanOpponentLearningRate', DEFAULT_LEARNING_RATE),
    checkpointOpponentRate: Math.max(0, numberArg(args, 'checkpointOpponentRate', DEFAULT_OPPONENT_RATE)),
    checkpointInterval: Math.max(0, checkpointInterval),
    checkpointEvalEpisodes: Math.max(1, Math.floor(numberArg(args, 'checkpointEvalEpisodes', DEFAULT_CHECKPOINT_EVAL_EPISODES))),
    checkpointEvalSeedCount: Math.max(1, Math.floor(numberArg(
      args,
      'checkpointEvalSeedCount',
      numberArg(args, 'checkpointEvalSeeds', DEFAULT_CHECKPOINT_EVAL_SEED_COUNT),
    ))),
    checkpointOpponentLimit: Math.max(0, Math.floor(numberArg(args, 'checkpointOpponentLimit', SCORE_CATEGORY_KEYS.length - FEATURE_UNIT))),
    humanFeedbackWeight: Math.max(0, numberArg(args, 'humanFeedbackWeight', 0)),
    humanFeedbackReturn: numberArg(args, 'humanFeedbackReturn', FEATURE_UNIT),
    quiet: booleanArg(args, 'quiet', false),
  };
}

function formatPercent(value) {
  return `${(100 * value).toFixed(1)}%`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
}

function describeRange(fixed, min, max, suffix = '') {
  return fixed == null ? `${min}-${max}${suffix} sampled` : `${fixed}${suffix} fixed`;
}

function clonePlain(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => clonePlain(entry));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clonePlain(entry)]));
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numericDelta(current, previous) {
  return numericValue(current) - numericValue(previous);
}

function countDelta(current, previous) {
  return Math.max(0, numericDelta(current, previous));
}

function subtractCountMap(current = {}, previous = {}) {
  const out = {};
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(previous || {})]);
  for (const key of keys) {
    const value = countDelta(current?.[key], previous?.[key]);
    if (value > 0) out[key] = value;
  }
  return out;
}

function subtractOutcomeBucket(current = {}, previous = {}) {
  return {
    appearances: countDelta(current.appearances, previous.appearances),
    wins: countDelta(current.wins, previous.wins),
    survivals: countDelta(current.survivals, previous.survivals),
    falls: countDelta(current.falls, previous.falls),
    truncated: countDelta(current.truncated, previous.truncated),
    roleCounts: subtractCountMap(current.roleCounts, previous.roleCounts),
    playerCounts: subtractCountMap(current.playerCounts, previous.playerCounts),
  };
}

function subtractOutcomeBucketMap(current = {}, previous = {}) {
  const out = {};
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(previous || {})]);
  for (const key of keys) {
    const bucket = subtractOutcomeBucket(current?.[key], previous?.[key]);
    if (bucket.appearances > 0) out[key] = bucket;
  }
  return out;
}

function subtractPlayerOutcomeStats(current = {}, previous = {}) {
  return {
    byPlayer: subtractOutcomeBucketMap(current.byPlayer, previous.byPlayer),
    byRole: subtractOutcomeBucketMap(current.byRole, previous.byRole),
  };
}

function subtractAverageStat(current = {}, previous = {}) {
  return {
    sum: numericDelta(current?.sum, previous?.sum),
    count: countDelta(current?.count, previous?.count),
  };
}

function subtractActionStats(current = {}, previous = {}) {
  const out = createActionStats();
  out.total = countDelta(current.total, previous.total);
  out.byKind = subtractCountMap(current.byKind, previous.byKind);
  out.byPhase = subtractCountMap(current.byPhase, previous.byPhase);
  out.courtActions = subtractCountMap(current.courtActions, previous.courtActions);
  out.dealClauses = subtractCountMap(current.dealClauses, previous.dealClauses);
  out.dealClauseAmounts = subtractCountMap(current.dealClauseAmounts, previous.dealClauseAmounts);
  out.actionValueBuckets = subtractCountMap(current.actionValueBuckets, previous.actionValueBuckets);
  out.rewardChoices = subtractCountMap(current.rewardChoices, previous.rewardChoices);
  out.orderDeployments = {
    frontier: countDelta(current.orderDeployments?.frontier, previous.orderDeployments?.frontier),
    capital: countDelta(current.orderDeployments?.capital, previous.orderDeployments?.capital),
  };
  out.orderTroops = {
    frontier: countDelta(current.orderTroops?.frontier, previous.orderTroops?.frontier),
    capital: countDelta(current.orderTroops?.capital, previous.orderTroops?.capital),
  };
  out.orderFrontierShare = subtractAverageStat(current.orderFrontierShare, previous.orderFrontierShare);
  out.titleAssignments = countDelta(current.titleAssignments, previous.titleAssignments);
  out.confirmations = countDelta(current.confirmations, previous.confirmations);
  return out;
}

function averageWindowValue(currentAverage, previousAverage, currentCount, previousCount) {
  const windowCount = Math.max(1, countDelta(currentCount, previousCount));
  const currentTotal = numericValue(currentAverage) * Math.max(0, numericValue(currentCount));
  const previousTotal = numericValue(previousAverage) * Math.max(0, numericValue(previousCount));
  return (currentTotal - previousTotal) / windowCount;
}

function subtractTrainingStats(current = {}, previous = {}, completed = 0, previousCompleted = 0) {
  const episodes = Math.max(0, countDelta(completed, previousCompleted));
  return {
    episodes,
    outcomeEpisodes: countDelta(current.outcomeEpisodes ?? completed, previous.outcomeEpisodes ?? previousCompleted),
    falls: countDelta(current.falls, previous.falls),
    survivals: countDelta(current.survivals, previous.survivals),
    truncated: countDelta(current.truncated, previous.truncated),
    transitions: countDelta(current.transitions, previous.transitions),
    rounds: countDelta(current.rounds, previous.rounds),
    playerCounts: subtractCountMap(current.playerCounts, previous.playerCounts),
    roundLengths: subtractCountMap(current.roundLengths, previous.roundLengths),
    trainingModes: subtractCountMap(current.trainingModes, previous.trainingModes),
    actionStats: subtractActionStats(current.actionStats, previous.actionStats),
    policyMix: subtractCountMap(current.policyMix, previous.policyMix),
    playerOutcomes: subtractPlayerOutcomeStats(current.playerOutcomes, previous.playerOutcomes),
    loss: averageWindowValue(current.loss, previous.loss, completed, previousCompleted),
    policyLoss: averageWindowValue(current.policyLoss, previous.policyLoss, completed, previousCompleted),
    valueLoss: averageWindowValue(current.valueLoss, previous.valueLoss, completed, previousCompleted),
    returnSum: numericDelta(current.returnSum, previous.returnSum),
    returnCount: countDelta(current.returnCount, previous.returnCount),
    positiveReturns: countDelta(current.positiveReturns, previous.positiveReturns),
    negativeReturns: countDelta(current.negativeReturns, previous.negativeReturns),
    neutralReturns: countDelta(current.neutralReturns, previous.neutralReturns),
  };
}

function formatInteger(value) {
  return Math.round(numericValue(value)).toLocaleString('en-US');
}

function averageStatPercent(stat) {
  return stat?.count ? formatPercent(stat.sum / stat.count) : '-';
}

function averageReturn(stats = {}) {
  return stats.returnCount ? stats.returnSum / stats.returnCount : 0;
}

function roundMetric(value, digits = 4) {
  const number = numericValue(value);
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function formatReturnStats(stats = {}) {
  if (!stats.returnCount) return 'return=-';
  return `return=${averageReturn(stats).toFixed(2)} positive=${formatPercent(stats.positiveReturns / stats.returnCount)}`;
}

function formatDecisions(stats = {}) {
  const episodes = Math.max(1, numericValue(stats.episodes));
  const decisions = numericValue(stats.transitions);
  return `${formatInteger(decisions)} decisions (${(decisions / episodes).toFixed(1)}/ep)`;
}

function formatPolicyRoles(distribution = {}) {
  const order = ['learner', 'checkpoint', 'human', 'heuristic', 'random', 'custom'];
  const entries = Object.entries(distribution || {}).filter(([, value]) => numericValue(value) > 0);
  const total = entries.reduce((sum, [, value]) => sum + numericValue(value), 0);
  if (total <= 0) return '-';
  const ordered = [
    ...order.filter((key) => numericValue(distribution[key]) > 0),
    ...entries.map(([key]) => key).filter((key) => !order.includes(key)).sort(),
  ];
  return ordered
    .map((key) => `${key}:${formatPercent(numericValue(distribution[key]) / total)}`)
    .join(',');
}

function formatTrainingModes(distribution = {}) {
  const order = ['episode', 'round', 'hybrid'];
  const entries = Object.entries(distribution || {}).filter(([, value]) => numericValue(value) > 0);
  const total = entries.reduce((sum, [, value]) => sum + numericValue(value), 0);
  if (total <= 0) return '';
  const ordered = [
    ...order.filter((key) => numericValue(distribution[key]) > 0),
    ...entries.map(([key]) => key).filter((key) => !order.includes(key)).sort(),
  ];
  return ordered
    .map((key) => `${key}:${formatPercent(numericValue(distribution[key]) / total)}`)
    .join(',');
}

function topOutcomeLabel(counts = {}) {
  const entries = Object.entries(counts || {})
    .filter(([, count]) => numericValue(count) > 0)
    .sort((left, right) => numericValue(right[1]) - numericValue(left[1]) || String(left[0]).localeCompare(String(right[0])));
  if (!entries.length) return 'unknown';
  if (entries.length === 1) return entries[0][0];
  return entries.slice(0, 2).map(([key]) => key).join('/');
}

function formatOutcomeRates(bucket = {}) {
  const appearances = Math.max(1, numericValue(bucket.appearances));
  return `win:${formatPercent(numericValue(bucket.wins) / appearances)} surv:${formatPercent(numericValue(bucket.survivals) / appearances)}`;
}

function formatPlayerOutcomes(outcomes = {}) {
  const entries = Object.entries(outcomes.byPlayer || {})
    .filter(([, bucket]) => numericValue(bucket.appearances) > 0)
    .sort(([left], [right]) => Number(left) - Number(right));
  if (!entries.length) return '-';
  return entries
    .map(([playerId, bucket]) => `p${Number(playerId) + 1}(${topOutcomeLabel(bucket.roleCounts)}) ${formatOutcomeRates(bucket)}`)
    .join(';');
}

function formatRoleOutcomes(outcomes = {}) {
  const order = ['learner', 'checkpoint', 'human', 'heuristic', 'random', 'custom', 'unknown'];
  const entries = Object.entries(outcomes.byRole || {})
    .filter(([, bucket]) => numericValue(bucket.appearances) > 0);
  if (!entries.length) return '-';
  const keys = [
    ...order.filter((key) => outcomes.byRole?.[key]?.appearances > 0),
    ...entries.map(([key]) => key).filter((key) => !order.includes(key)).sort(),
  ];
  return keys
    .map((key) => `${key} ${formatOutcomeRates(outcomes.byRole[key])}`)
    .join(';');
}

function summarizeOutcomeBucket(bucket = {}) {
  const appearances = Math.max(1, numericValue(bucket.appearances));
  return {
    appearances: numericValue(bucket.appearances),
    winRate: roundMetric(numericValue(bucket.wins) / appearances, 4),
    survivalRate: roundMetric(numericValue(bucket.survivals) / appearances, 4),
    fallRate: roundMetric(numericValue(bucket.falls) / appearances, 4),
    stalledRate: roundMetric(numericValue(bucket.truncated) / appearances, 4),
    roles: summarizeCountShares(bucket.roleCounts),
    players: summarizeCountShares(bucket.playerCounts, true),
  };
}

function summarizeOutcomeBucketMap(map = {}, playerKeys = false) {
  return Object.fromEntries(
    Object.entries(map || {})
      .filter(([, bucket]) => numericValue(bucket.appearances) > 0)
      .sort(([left], [right]) => Number(left) - Number(right) || String(left).localeCompare(String(right)))
      .map(([key, bucket]) => [playerKeys ? `p${Number(key) + 1}` : key, summarizeOutcomeBucket(bucket)]),
  );
}

function summarizePlayerOutcomes(outcomes = {}) {
  return {
    byPlayer: summarizeOutcomeBucketMap(outcomes.byPlayer, true),
    byRole: summarizeOutcomeBucketMap(outcomes.byRole, false),
  };
}

function summarizePolicyRoles(distribution = {}) {
  const order = ['learner', 'checkpoint', 'human', 'heuristic', 'random', 'custom'];
  const entries = Object.entries(distribution || {}).filter(([, value]) => numericValue(value) > 0);
  const total = entries.reduce((sum, [, value]) => sum + numericValue(value), 0);
  if (total <= 0) return {};
  const ordered = [
    ...order.filter((key) => numericValue(distribution[key]) > 0),
    ...entries.map(([key]) => key).filter((key) => !order.includes(key)).sort(),
  ];
  return Object.fromEntries(
    ordered.map((key) => [key, roundMetric(numericValue(distribution[key]) / total, 4)]),
  );
}

function summarizeCountShares(counts = {}, playerKeys = false) {
  const entries = Object.entries(counts || {}).filter(([, value]) => numericValue(value) > 0);
  const total = entries.reduce((sum, [, value]) => sum + numericValue(value), 0);
  if (total <= 0) return {};
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => Number(left) - Number(right) || String(left).localeCompare(String(right)))
      .map(([key, value]) => [playerKeys ? `p${Number(key) + 1}` : key, roundMetric(numericValue(value) / total, 4)]),
  );
}

function summarizeTrainingStats(stats = {}) {
  const episodes = Math.max(1, Number(stats.episodes) || 1);
  const outcomeEpisodes = Math.max(1, Number(stats.outcomeEpisodes ?? stats.episodes) || 1);
  const decisions = numericValue(stats.transitions);
  const frontier = stats.actionStats?.orderFrontierShare;
  return {
    episodes: Number(stats.episodes) || 0,
    decisions,
    decisionsPerEpisode: roundMetric(decisions / episodes, 2),
    loss: roundMetric(stats.loss),
    policyLoss: roundMetric(stats.policyLoss),
    valueLoss: roundMetric(stats.valueLoss),
    averageReturn: roundMetric(averageReturn(stats), 3),
    positiveReturnRate: stats.returnCount ? roundMetric(stats.positiveReturns / stats.returnCount, 4) : 0,
    outcomeEpisodes: Number(stats.outcomeEpisodes ?? stats.episodes) || 0,
    survivalRate: roundMetric((stats.survivals || 0) / outcomeEpisodes, 4),
    fallRate: roundMetric((stats.falls || 0) / outcomeEpisodes, 4),
    stalledRate: roundMetric((stats.truncated || 0) / outcomeEpisodes, 4),
    averageRounds: roundMetric(stats.averageRounds ?? ((stats.rounds || 0) / episodes), 2),
    frontierTroopShare: frontier?.count ? roundMetric(frontier.sum / frontier.count, 4) : null,
    trainingModes: summarizeCountShares(stats.trainingModes),
    roles: summarizePolicyRoles(stats.policyMix),
    outcomes: summarizePlayerOutcomes(stats.playerOutcomes),
  };
}

export function createProgressReporter(options, outputPath, resumed) {
  if (options.quiet) {
    return {
      start() {},
      update() {},
      finish() {},
    };
  }

  const startedAt = Date.now();
  const total = Math.max(1, Number(options.episodes) || 1);
  const interval = Math.max(1, Math.floor(Number(options.logInterval) || 1));
  let lastPrinted = 0;
  let lastPrintedAt = startedAt;
  let lastPrintedStats = null;

  return {
    start() {
      const source = resumed ? 'resuming policy' : 'new policy';
      const workers = options.workersAuto ? `${options.workers} auto` : `${options.workers} fixed`;
      const seed = options.seedWasSpecified ? `${options.seed} explicit` : 'random per-episode';
      console.log(
        `[ai:train] ${source}`
        + ` | episodes=${total}`
        + ` | workers=${workers}`
        + ` | mode=${options.trainingMode || 'episode'}`
        + ` | players=${describeRange(options.playerCount, options.playerMin, options.playerMax, 'p')}`
        + ` | rounds=${describeRange(options.deckSize, options.roundMin, options.roundMax, 'r')}`
        + ` | seed=${seed}`
        + ` | includeDeals=${options.includeDeals ? 'true' : 'false'}`
        + ` | opponentMix=${options.opponentMix ? 'true' : 'false'}`
        + ` | epochs=${options.trainingEpochs}`,
      );
      console.log(
        `[ai:train] learningRate=${options.learningRate}`
        + ` temperature=${options.temperature}`
        + ` reward=${options.terminalRewardMode}`
        + ` returnDiscount=${options.returnDiscount}`
        + ` rolloutRounds=${options.rolloutRounds}`
        + ` roundModeRate=${options.roundModeRate}`
        + ` out=${outputPath}`,
      );
      if (options.humanFeedbackTransitions?.length) {
        console.log(
          `[ai:train] humanGames=${options.humanFeedbackFiles?.length || 0} files`
          + ` samples=${options.humanFeedbackSampleCount || options.humanFeedbackTransitions.length}`
          + ` transitions=${options.humanFeedbackTransitions.length}`
          + ` opponentRate=${options.humanOpponentRate}`
          + ` imitationWeight=${options.humanFeedbackWeight}`
          + ` targetReturn=${options.humanFeedbackReturn}`,
        );
      }
      console.log(`[ai:train] feedbackEvery=${interval} episodes | progress stats are since the previous feedback line`);
      lastPrintedAt = Date.now();
    },
    update(snapshot) {
      const completed = Math.min(total, Number(snapshot.completed) || 0);
      if (completed < total && completed - lastPrinted < interval) return;

      const stats = snapshot.stats || {};
      const now = Date.now();
      const previousCompleted = lastPrinted;
      const windowStats = subtractTrainingStats(stats, lastPrintedStats || {}, completed, previousCompleted);
      const windowEpisodes = Math.max(1, windowStats.episodes);
      const elapsed = now - startedAt;
      const windowElapsed = now - lastPrintedAt;
      const episodesPerSecond = windowEpisodes / Math.max(Number.EPSILON, windowElapsed / 1000);
      const windowOutcomeEpisodes = Math.max(1, Number(windowStats.outcomeEpisodes ?? windowEpisodes) || 0);
      const survivalRate = windowStats.survivals / windowOutcomeEpisodes;
      const fallRate = windowStats.falls / windowOutcomeEpisodes;
      const truncatedRate = windowStats.truncated / windowOutcomeEpisodes;
      const averageRounds = windowStats.rounds / windowEpisodes;
      const loss = Number.isFinite(windowStats.loss) ? windowStats.loss : 0;
      const policyLoss = Number.isFinite(windowStats.policyLoss) ? windowStats.policyLoss : 0;
      const valueLoss = Number.isFinite(windowStats.valueLoss) ? windowStats.valueLoss : 0;
      const frontierShare = averageStatPercent(windowStats.actionStats?.orderFrontierShare);
      const trainingModes = formatTrainingModes(windowStats.trainingModes);
      const roleMix = formatPolicyRoles(windowStats.policyMix);
      const playerOutcomes = formatPlayerOutcomes(windowStats.playerOutcomes);
      const roleOutcomes = formatRoleOutcomes(windowStats.playerOutcomes);
      const lastSeed = snapshot.last?.seed ? ` | lastSeed=${snapshot.last.seed}` : '';
      lastPrinted = completed;
      lastPrintedAt = now;
      lastPrintedStats = clonePlain(stats);

      console.log(
        `[ai:train] episode ${completed}/${total} (${formatPercent(completed / total)})`
        + ` | window=${formatInteger(windowEpisodes)} eps`
        + ` | speed=${episodesPerSecond.toFixed(2)} ep/s`
        + ` | ${formatDecisions(windowStats)}`
        + (trainingModes ? ` | samples=${trainingModes}` : '')
        + ` | loss=${loss.toFixed(4)} policy=${policyLoss.toFixed(4)} value=${valueLoss.toFixed(4)}`
        + ` | ${formatReturnStats(windowStats)}`
        + ` | survived=${formatPercent(survivalRate)}`
        + ` | fell=${formatPercent(fallRate)}`
        + ` | stalled=${formatPercent(truncatedRate)}`
        + ` | avgRounds=${averageRounds.toFixed(2)}`
        + ` | frontier=${frontierShare}`
        + ` | roles=${roleMix}`
        + ` | players=${playerOutcomes}`
        + ` | controllers=${roleOutcomes}`
        + lastSeed
        + ` | elapsed=${formatDuration(elapsed)}`,
      );
    },
    finish(stats) {
      const elapsed = Date.now() - startedAt;
      const episodes = Math.max(1, Number(stats.episodes) || 1);
      const outcomeEpisodes = Math.max(1, Number(stats.outcomeEpisodes ?? stats.episodes) || 1);
      const trainingModes = formatTrainingModes(stats.trainingModes);
      console.log(
        `[ai:train] done | episodes=${stats.episodes}`
        + (trainingModes ? ` samples=${trainingModes}` : '')
        + ` survived=${formatPercent((stats.survivals || 0) / outcomeEpisodes)}`
        + ` fell=${formatPercent((stats.falls || 0) / outcomeEpisodes)}`
        + ` stalled=${formatPercent((stats.truncated || 0) / outcomeEpisodes)}`
        + ` avgRounds=${Number(stats.averageRounds || 0).toFixed(2)}`
        + ` decisions=${formatInteger(stats.transitions || 0)}`
        + ` ${formatReturnStats(stats)}`
        + ` loss=${Number(stats.loss || 0).toFixed(4)}`
        + ` policy=${Number(stats.policyLoss || 0).toFixed(4)}`
        + ` value=${Number(stats.valueLoss || 0).toFixed(4)}`
        + ` frontier=${averageStatPercent(stats.actionStats?.orderFrontierShare)}`
        + ` players=${formatPlayerOutcomes(stats.playerOutcomes)}`
        + ` controllers=${formatRoleOutcomes(stats.playerOutcomes)}`
        + ` elapsed=${formatDuration(elapsed)}`,
      );
      console.log(`[ai:train] saved ${outputPath}`);
    },
  };
}

function mergeEpisodeStats(target, result) {
  const outcomeCounted = result.stats.outcomeCounted !== false;
  target.outcomeEpisodes += outcomeCounted ? 1 : 0;
  target.falls += outcomeCounted && result.stats.fell ? 1 : 0;
  target.survivals += outcomeCounted && result.stats.survived ? 1 : 0;
  target.truncated += outcomeCounted && result.stats.truncated ? 1 : 0;
  target.transitions += result.transitions.length;
  target.rounds += result.stats.rounds;
  target.trainingModes[result.stats.trainingMode || 'episode'] = (
    target.trainingModes[result.stats.trainingMode || 'episode'] || 0
  ) + 1;
  const playerCount = String(result.stats.playerCount);
  const roundLength = String(result.stats.deckSize);
  target.playerCounts[playerCount] = (target.playerCounts[playerCount] || 0) + 1;
  target.roundLengths[roundLength] = (target.roundLengths[roundLength] || 0) + 1;
  mergeActionStats(target.actionStats, result.stats.actionStats);
  mergePolicyMixStats(target.policyMix, result.stats.policyMix);
}

function runWorkerEpisode(aiPolicy, options, seed, episodeIndex) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        kind: 'self-play-episode',
        aiPolicy: serializeLearningPolicy(aiPolicy),
        options,
        seed,
        episodeIndex,
      },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`AI worker stopped with exit code ${code}.`));
    });
  });
}

async function trainSelfPlayWithWorkers(aiPolicy, options = {}) {
  const episodes = Math.max(1, Number(options.episodes) || 1);
  const workers = Math.max(1, Math.floor(Number(options.workers) || 1));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const onCheckpoint = typeof options.onCheckpoint === 'function' ? options.onCheckpoint : null;
  const checkpointInterval = Math.max(0, Math.floor(Number(options.checkpointInterval) || 0));
  const stats = {
    episodes,
    outcomeEpisodes: 0,
    falls: 0,
    survivals: 0,
    truncated: 0,
    transitions: 0,
    rounds: 0,
    playerCounts: {},
    roundLengths: {},
    trainingModes: {},
    actionStats: createActionStats(),
    policyMix: {},
    playerOutcomes: createPlayerOutcomeStats(),
    loss: 0,
    policyLoss: 0,
    valueLoss: 0,
    returnSum: 0,
    returnCount: 0,
    positiveReturns: 0,
    negativeReturns: 0,
    neutralReturns: 0,
  };

  let completed = 0;
  let nextCheckpoint = checkpointInterval;
  while (completed < episodes) {
    const batchSize = Math.min(workers, episodes - completed);
    const workerOptions = {
      ...options,
      humanFeedbackTransitions: undefined,
      onProgress: undefined,
      onCheckpoint: undefined,
      quiet: undefined,
      logInterval: undefined,
    };
    const jobs = Array.from({ length: batchSize }, (_, index) => (
      runWorkerEpisode(
        aiPolicy,
        workerOptions,
        resolveEpisodeSeed(options, completed + index),
        completed + index,
      )
    ));
    const results = await Promise.all(jobs);
    const transitions = [];
    for (const result of results) {
      transitions.push(...result.transitions);
      mergeEpisodeStats(stats, result);
      recordPlayerOutcomes(stats.playerOutcomes, result.stats.playerOutcomes);
      recordTrainingReturns(stats, result.transitions);
    }
    const report = trainTransitions(aiPolicy, transitions, options);
    stats.loss += report.loss * batchSize;
    stats.policyLoss += report.policyLoss * batchSize;
    stats.valueLoss += report.valueLoss * batchSize;
    completed += batchSize;
    if (onProgress) {
      onProgress({
        completed,
        batchSize,
        episodes,
        stats: {
          ...stats,
          loss: stats.loss / completed,
          policyLoss: stats.policyLoss / completed,
          valueLoss: stats.valueLoss / completed,
        },
        last: {
          loss: report.loss,
          transitions: transitions.length,
          seed: results.at(-1)?.stats?.seed,
          trainingEpochs: report.epochs,
        },
      });
    }
    const shouldCheckpoint = onCheckpoint
      && checkpointInterval > 0
      && (completed >= nextCheckpoint || completed === episodes);
    if (shouldCheckpoint) {
      while (nextCheckpoint <= completed) nextCheckpoint += checkpointInterval;
      onCheckpoint({
        completed,
        batchSize,
        episodes,
        aiPolicy,
        stats: {
          ...stats,
          loss: stats.loss / completed,
          policyLoss: stats.policyLoss / completed,
          valueLoss: stats.valueLoss / completed,
        },
        last: {
          loss: report.loss,
          transitions: transitions.length,
          seed: results.at(-1)?.stats?.seed,
          trainingEpochs: report.epochs,
        },
      });
    }
  }

  stats.loss /= episodes;
  stats.policyLoss /= episodes;
  stats.valueLoss /= episodes;
  stats.averageRounds = stats.rounds / episodes;
  return stats;
}

function clonePolicy(aiPolicy) {
  return cloneLearningPolicy(aiPolicy);
}

function createHumanOpponentPolicy(transitions = [], options = {}) {
  if (!transitions.length) return null;
  const aiPolicy = createLearningPolicy({ seed: deriveStableSeed(options.policySeed || options.seed || 1, 211) });
  const epochs = Math.max(1, Math.floor(Number(options.humanOpponentEpochs) || 1));
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    trainFeatureBatch(aiPolicy, transitions, {
      learningRate: options.humanOpponentLearningRate || options.learningRate || DEFAULT_LEARNING_RATE,
      temperature: FEATURE_UNIT,
    });
  }
  return aiPolicy;
}

function resolveHumanGamesPath(args = {}) {
  return args.humanGames || args.humanData || args.humanFeedback || DEFAULT_HUMAN_GAMES_DIR;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function checkpointPathFor(outputPath, checkpointDir, completed) {
  const extension = extname(outputPath) || '.json';
  const stem = basename(outputPath, extension) || 'policy';
  return resolve(checkpointDir, `${stem}-ep${String(completed).padStart(6, '0')}${extension}`);
}

function checkpointEpisodeFromName(name, outputPath) {
  const extension = extname(outputPath) || '.json';
  const stem = basename(outputPath, extension) || 'policy';
  const pattern = new RegExp(`^${escapeRegExp(stem)}-ep(\\d+)${escapeRegExp(extension)}$`);
  const match = pattern.exec(name);
  return match ? Number(match[1]) : 0;
}

function latestCheckpointEpisode(outputPath, checkpointDir) {
  try {
    return readdirSync(checkpointDir)
      .map((name) => checkpointEpisodeFromName(name, outputPath))
      .filter((episode) => Number.isFinite(episode) && episode > 0)
      .reduce((max, episode) => Math.max(max, episode), 0);
  } catch {
    return 0;
  }
}

function checkpointEpisodeFromPath(path) {
  const extension = extname(path) || '';
  const name = basename(path, extension);
  const match = /-ep(\d+)$/.exec(name);
  return match ? Number(match[1]) : 0;
}

function metadataEpisodeOffset(metadata = {}, resumePath = null) {
  if (metadata.checkpoint && Number.isFinite(Number(metadata.checkpointEpisode))) {
    return Math.max(0, Math.floor(Number(metadata.checkpointEpisode)));
  }
  if (Number.isFinite(Number(metadata.totalTrainingEpisodes))) {
    return Math.max(0, Math.floor(Number(metadata.totalTrainingEpisodes)));
  }
  if (
    Number.isFinite(Number(metadata.trainingEpisodeOffset))
    && Number.isFinite(Number(metadata.episodes))
  ) {
    return Math.max(0, Math.floor(Number(metadata.trainingEpisodeOffset) + Number(metadata.episodes)));
  }
  if (Number.isFinite(Number(metadata.episodes))) {
    return Math.max(0, Math.floor(Number(metadata.episodes)));
  }
  return resumePath ? checkpointEpisodeFromPath(resumePath) : 0;
}

export function resolveResumeEpisodeOffset(
  resumePayload,
  resumePath,
  outputPath,
  checkpointDir,
  includeMatchingCheckpoints = true,
) {
  if (!resumePath) return 0;
  const metadata = resumePayload?.metadata || {};
  const policyOffset = metadataEpisodeOffset(metadata, resumePath);
  const checkpointOffset = includeMatchingCheckpoints ? latestCheckpointEpisode(outputPath, checkpointDir) : 0;
  return Math.max(policyOffset, checkpointOffset);
}

export function createCheckpointManager(trainingOptions, outputPath, args = {}) {
  const checkpointDir = args.checkpointDir || DEFAULT_CHECKPOINT_DIR;
  const evaluationSeed = hasArg(args, 'checkpointEvalSeed')
    ? numberArg(args, 'checkpointEvalSeed', 90_000)
    : deriveCheckpointSeed(trainingOptions);
  const checkpointOpponents = [];
  const episodeOffset = Math.max(0, Math.floor(Number(trainingOptions.trainingEpisodeOffset) || 0));
  const baselinePolicy = trainingOptions.promotionBaselinePolicy
    ? clonePolicy(trainingOptions.promotionBaselinePolicy)
    : null;
  let best = null;
  let previousCheckpointPolicy = null;

  function evaluateCheckpoint(aiPolicy, previousPolicy) {
    return runTournamentSuite({
      aiPolicy,
      previousPolicy: baselinePolicy || previousPolicy,
      humanOpponentPolicy: trainingOptions.humanOpponentPolicy,
      episodes: trainingOptions.checkpointEvalEpisodes,
      seedCount: trainingOptions.checkpointEvalSeedCount,
      seed: evaluationSeed,
      includeDeals: trainingOptions.includeDeals,
      playerCount: trainingOptions.playerCount,
      playerMin: trainingOptions.playerMin,
      playerMax: trainingOptions.playerMax,
      deckSize: trainingOptions.deckSize,
      roundMin: trainingOptions.roundMin,
      roundMax: trainingOptions.roundMax,
      maxSteps: trainingOptions.maxSteps,
      maxCourtActionsPerPlayer: trainingOptions.maxCourtActionsPerPlayer,
      terminalRewardMode: trainingOptions.terminalRewardMode,
      returnDiscount: trainingOptions.returnDiscount,
      includeRandomBaseline: true,
    });
  }

  if (baselinePolicy) {
    const baselineTournament = evaluateCheckpoint(baselinePolicy, baselinePolicy);
    best = {
      baseline: true,
      score: scoreTournamentReport(baselineTournament),
      path: trainingOptions.promotionBaselinePath || null,
      episode: episodeOffset,
      runEpisode: 0,
      aiPolicy: clonePolicy(baselinePolicy),
      tournament: baselineTournament,
    };
    if (!trainingOptions.quiet) {
      console.log(
        `[ai:train] resume baseline ${best.path || 'loaded policy'}`
        + ` | episodeOffset=${episodeOffset}`
        + ` | score=${best.score.toFixed(4)}`,
      );
    }
    if (trainingOptions.checkpointOpponentLimit > 0) {
      checkpointOpponents.unshift(clonePolicy(baselinePolicy));
      checkpointOpponents.splice(trainingOptions.checkpointOpponentLimit);
      trainingOptions.opponentPolicies = checkpointOpponents.slice();
      previousCheckpointPolicy = clonePolicy(baselinePolicy);
    }
  }

  function saveCheckpoint(snapshot) {
    const candidate = clonePolicy(snapshot.aiPolicy);
    const previousPolicy = previousCheckpointPolicy ? clonePolicy(previousCheckpointPolicy) : null;
    const tournament = evaluateCheckpoint(candidate, previousPolicy);
    const score = scoreTournamentReport(tournament);
    const checkpointEpisode = episodeOffset + snapshot.completed;
    const path = checkpointPathFor(outputPath, checkpointDir, checkpointEpisode);
    const metadata = {
      ...snapshot.stats,
      checkpoint: true,
      completedEpisodes: snapshot.completed,
      trainingEpisodeOffset: episodeOffset,
      totalTrainingEpisodes: checkpointEpisode,
      checkpointEpisode,
      checkpointRunEpisode: snapshot.completed,
      checkpointScore: score,
      checkpointTournament: tournament,
      trainingMode: trainingOptions.trainingMode,
      roundModeRate: trainingOptions.roundModeRate,
      rolloutRounds: trainingOptions.rolloutRounds,
      snapshotRound: trainingOptions.snapshotRound,
      snapshotRoundMin: trainingOptions.snapshotRoundMin,
      snapshotRoundMax: trainingOptions.snapshotRoundMax,
      terminalRewardMode: trainingOptions.terminalRewardMode,
      returnDiscount: trainingOptions.returnDiscount,
    };
    savePolicyFileSync(candidate, path, metadata);

    if (!best || score > best.score) {
      best = {
        score,
        path,
        episode: checkpointEpisode,
        runEpisode: snapshot.completed,
        aiPolicy: clonePolicy(candidate),
        tournament,
        baseline: false,
      };
    }

    checkpointOpponents.unshift(clonePolicy(candidate));
    checkpointOpponents.splice(trainingOptions.checkpointOpponentLimit);
    trainingOptions.opponentPolicies = checkpointOpponents.slice();
    previousCheckpointPolicy = clonePolicy(candidate);
    return { path, score, tournament };
  }

  return {
    checkpointDir,
    get best() {
      return best;
    },
    saveCheckpoint,
  };
}

function deriveCheckpointSeed(options) {
  return deriveStableSeed(options.policySeed || options.seed || 90_000, 113);
}

function deriveStableSeed(baseSeed, salt) {
  let value = ((Number(baseSeed) || 1) >>> 0) ^ Math.imul(Number(salt) || 1, 0x9e3779b9);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) || 1;
}

export async function runTrainingCli(argv = process.argv) {
  const args = parseArgs(argv);
  const resumePath = args.resume === true ? DEFAULT_POLICY_PATH : args.resume;
  const trainingOptions = resolveTrainingOptions(args);
  let out = args.out || null;
  const checkpointDir = args.checkpointDir || DEFAULT_CHECKPOINT_DIR;
  const humanGamesPath = resolveHumanGamesPath(args);
  const explicitHumanGamesPath = Boolean(args.humanGames || args.humanData || args.humanFeedback);
  const humanDataset = loadHumanFeedbackDatasetSync(humanGamesPath, {
    returnValue: trainingOptions.humanFeedbackReturn,
    required: explicitHumanGamesPath,
  });
  if (humanDataset.transitions.length) {
    trainingOptions.humanFeedbackTransitions = humanDataset.transitions;
    trainingOptions.humanFeedbackPath = resolve(humanGamesPath);
    trainingOptions.humanFeedbackFiles = humanDataset.files;
    trainingOptions.humanFeedbackSampleCount = humanDataset.samples.length;
    trainingOptions.humanOpponentPolicy = createHumanOpponentPolicy(
      humanDataset.transitions,
      trainingOptions,
    );
  } else {
    trainingOptions.humanOpponentRate = 0;
  }
  const resumePayload = resumePath ? loadPolicyPayloadSync(resumePath) : null;
  const resumedPolicy = resumePath ? loadPolicyFileSync(resumePath) : null;
  const aiPolicy = resumedPolicy || createLearningPolicy({ seed: trainingOptions.policySeed });
  if (!out) {
    out = resumedPolicy && resumePath
      ? resolve(resumePath)
      : uniqueOpponentPolicyPathSync(aiPolicy);
  }
  const shouldContinueMatchingCheckpoints = Boolean(
    resumedPolicy
    && resumePath
    && resolve(resumePath) === resolve(out),
  );
  trainingOptions.trainingEpisodeOffset = resumedPolicy
    ? resolveResumeEpisodeOffset(
      resumePayload,
      resumePath,
      out,
      checkpointDir,
      shouldContinueMatchingCheckpoints,
    )
    : 0;
  if (resumedPolicy) {
    trainingOptions.promotionBaselinePolicy = clonePolicy(resumedPolicy);
    trainingOptions.promotionBaselinePath = resolve(resumePath);
  }
  trainingOptions.logInterval = Math.max(
    1,
    Math.floor(numberArg(args, 'logInterval', Math.max(1, Math.floor(trainingOptions.episodes / 20)))),
  );

  const progress = createProgressReporter(trainingOptions, out, Boolean(resumedPolicy));
  trainingOptions.onProgress = progress.update;
  progress.start();
  const checkpoints = createCheckpointManager(trainingOptions, out, args);
  trainingOptions.onCheckpoint = (snapshot) => {
    const result = checkpoints.saveCheckpoint(snapshot);
    if (!trainingOptions.quiet) {
      console.log(`[ai:train] checkpoint ${result.path} | score=${result.score.toFixed(4)}`);
    }
  };

  const stats = trainingOptions.workers > 1
    ? await trainSelfPlayWithWorkers(aiPolicy, trainingOptions)
    : trainSelfPlay(aiPolicy, trainingOptions);
  const promoted = checkpoints.best || {
    score: -Infinity,
    path: null,
    episode: trainingOptions.trainingEpisodeOffset + trainingOptions.episodes,
    runEpisode: trainingOptions.episodes,
    aiPolicy: clonePolicy(aiPolicy),
    tournament: runTournamentSuite({
      aiPolicy,
      humanOpponentPolicy: trainingOptions.humanOpponentPolicy,
      episodes: trainingOptions.checkpointEvalEpisodes,
      seedCount: trainingOptions.checkpointEvalSeedCount,
      seed: deriveCheckpointSeed(trainingOptions),
      includeDeals: trainingOptions.includeDeals,
      playerCount: trainingOptions.playerCount,
      playerMin: trainingOptions.playerMin,
      playerMax: trainingOptions.playerMax,
      deckSize: trainingOptions.deckSize,
      roundMin: trainingOptions.roundMin,
      roundMax: trainingOptions.roundMax,
      maxSteps: trainingOptions.maxSteps,
      maxCourtActionsPerPlayer: trainingOptions.maxCourtActionsPerPlayer,
      terminalRewardMode: trainingOptions.terminalRewardMode,
      returnDiscount: trainingOptions.returnDiscount,
      includeRandomBaseline: true,
    }),
  };
  if (!Number.isFinite(promoted.score)) promoted.score = scoreTournamentReport(promoted.tournament);
  savePolicyFileSync(promoted.aiPolicy, out, {
    ...stats,
    workers: trainingOptions.workers,
    workersAuto: trainingOptions.workersAuto,
    runEpisodes: stats.episodes,
    trainingEpisodeOffset: trainingOptions.trainingEpisodeOffset,
    totalTrainingEpisodes: trainingOptions.trainingEpisodeOffset + stats.episodes,
    resumedFrom: resumedPolicy ? resolve(resumePath) : null,
    seed: trainingOptions.seed,
    seedWasSpecified: trainingOptions.seedWasSpecified,
    seedMode: trainingOptions.seedMode,
    policySeed: trainingOptions.policySeed,
    playerCount: trainingOptions.playerCount,
    playerRange: [trainingOptions.playerMin, trainingOptions.playerMax],
    deckSize: trainingOptions.deckSize,
    roundRange: [trainingOptions.roundMin, trainingOptions.roundMax],
    includeDeals: trainingOptions.includeDeals,
    trainingMode: trainingOptions.trainingMode,
    roundModeRate: trainingOptions.roundModeRate,
    rolloutRounds: trainingOptions.rolloutRounds,
    snapshotRound: trainingOptions.snapshotRound,
    snapshotRoundMin: trainingOptions.snapshotRoundMin,
    snapshotRoundMax: trainingOptions.snapshotRoundMax,
    terminalRewardMode: trainingOptions.terminalRewardMode,
    returnDiscount: trainingOptions.returnDiscount,
    opponentMix: trainingOptions.opponentMix,
    randomOpponentRate: trainingOptions.randomOpponentRate,
    heuristicOpponentRate: trainingOptions.heuristicOpponentRate,
    humanOpponentRate: trainingOptions.humanOpponentRate,
    humanOpponentEpochs: trainingOptions.humanOpponentEpochs,
    checkpointOpponentRate: trainingOptions.checkpointOpponentRate,
    trainingEpochs: trainingOptions.trainingEpochs,
    humanFeedbackPath: trainingOptions.humanFeedbackPath || null,
    humanFeedbackFiles: trainingOptions.humanFeedbackFiles || [],
    humanFeedbackSamples: trainingOptions.humanFeedbackSampleCount || 0,
    humanFeedbackTransitions: trainingOptions.humanFeedbackTransitions?.length || 0,
    humanFeedbackWeight: trainingOptions.humanFeedbackWeight,
    humanFeedbackReturn: trainingOptions.humanFeedbackReturn,
    checkpointInterval: trainingOptions.checkpointInterval,
    checkpointEvalEpisodes: trainingOptions.checkpointEvalEpisodes,
    checkpointEvalSeedCount: trainingOptions.checkpointEvalSeedCount,
    checkpointDir: checkpoints.checkpointDir,
    promotedCheckpoint: promoted.path,
    promotedCheckpointEpisode: promoted.episode,
    promotedCheckpointRunEpisode: promoted.runEpisode ?? null,
    promotedCheckpointScore: promoted.score,
    promotedBaseline: Boolean(promoted.baseline),
    promotedTournament: promoted.tournament,
    logInterval: trainingOptions.logInterval,
  });
  progress.finish(stats);
  if (!trainingOptions.quiet) {
    console.log(`[ai:train] promoted ${promoted.path || 'final policy'} -> ${out} | score=${promoted.score.toFixed(4)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    out,
    stats: summarizeTrainingStats(stats),
    promoted: {
      path: promoted.path,
      episode: promoted.episode,
      runEpisode: promoted.runEpisode ?? null,
      score: promoted.score,
      baseline: Boolean(promoted.baseline),
    },
  }, null, 2));
  return { aiPolicy: promoted.aiPolicy, out, stats, promoted };
}

if (isMainThread && process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  try {
    await runTrainingCli(process.argv);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
