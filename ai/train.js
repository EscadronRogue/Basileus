import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { createNetwork } from './network.js';
import {
  deserializeNetwork,
  serializeNetwork,
} from './network.js';
import {
  DEFAULT_CHECKPOINT_DIR,
  DEFAULT_MODEL_PATH,
  loadModelFileSync,
  saveModelFileSync,
} from './modelStore.js';
import {
  createEntropySeed,
  resolveEpisodeSeed,
  runSelfPlayEpisode,
  trainSelfPlay,
  trainTransitions,
  mergeActionStats,
  mergePolicyMixStats,
} from './selfPlay.js';
import {
  runTournament,
  scoreTournamentReport,
} from './tournament.js';

if (!isMainThread && workerData?.kind === 'self-play-episode') {
  const network = deserializeNetwork(workerData.network);
  const result = runSelfPlayEpisode({
    ...(workerData.options || {}),
    network,
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
    modelSeed: seedWasSpecified ? seed : createEntropySeed(),
    ...resolvePlayerOptions(args),
    ...resolveRoundOptions(args),
    learningRate: numberArg(args, 'learningRate', 0.001),
    entropyBeta: numberArg(args, 'entropyBeta', 0.01),
    temperature: numberArg(args, 'temperature', 1),
    trainingEpochs: Math.max(1, Math.floor(numberArg(args, 'trainingEpochs', 3))),
    rewardShaping: booleanArg(args, 'rewardShaping', true),
    includeDeals: booleanArg(args, 'includeDeals', false),
    opponentMix: booleanArg(args, 'opponentMix', true),
    randomOpponentRate: Math.max(0, numberArg(args, 'randomOpponentRate', 0.3)),
    heuristicOpponentRate: Math.max(0, numberArg(args, 'heuristicOpponentRate', 0.25)),
    checkpointOpponentRate: Math.max(0, numberArg(args, 'checkpointOpponentRate', 0.2)),
    checkpointInterval: Math.max(0, checkpointInterval),
    checkpointEvalEpisodes: Math.max(1, Math.floor(numberArg(args, 'checkpointEvalEpisodes', 4))),
    checkpointOpponentLimit: Math.max(0, Math.floor(numberArg(args, 'checkpointOpponentLimit', 3))),
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

function formatDistribution(distribution, suffix) {
  const entries = Object.entries(distribution || {})
    .sort(([left], [right]) => Number(left) - Number(right));
  return entries.length ? entries.map(([key, count]) => `${key}${suffix}:${count}`).join(',') : '-';
}

function createProgressReporter(options, outputPath, resumed) {
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

  return {
    start() {
      const source = resumed ? 'resuming model' : 'new model';
      const workers = options.workersAuto ? `${options.workers} auto` : `${options.workers} fixed`;
      const seed = options.seedWasSpecified ? `${options.seed} explicit` : 'random per-episode';
      console.log(
        `[ai:train] ${source}`
        + ` | episodes=${total}`
        + ` | workers=${workers}`
        + ` | players=${describeRange(options.playerCount, options.playerMin, options.playerMax, 'p')}`
        + ` | rounds=${describeRange(options.deckSize, options.roundMin, options.roundMax, 'r')}`
        + ` | seed=${seed}`
        + ` | includeDeals=${options.includeDeals ? 'true' : 'false'}`
        + ` | opponentMix=${options.opponentMix ? 'true' : 'false'}`
        + ` | rewardShaping=${options.rewardShaping ? 'true' : 'false'}`
        + ` | epochs=${options.trainingEpochs}`,
      );
      console.log(`[ai:train] learningRate=${options.learningRate} entropyBeta=${options.entropyBeta} temperature=${options.temperature} out=${outputPath}`);
    },
    update(snapshot) {
      const completed = Math.min(total, Number(snapshot.completed) || 0);
      if (completed < total && completed - lastPrinted < interval) return;
      lastPrinted = completed;

      const stats = snapshot.stats || {};
      const elapsed = Date.now() - startedAt;
      const episodesPerSecond = completed / Math.max(0.001, elapsed / 1000);
      const survivalRate = (stats.survivals || 0) / Math.max(1, completed);
      const fallRate = (stats.falls || 0) / Math.max(1, completed);
      const truncatedRate = (stats.truncated || 0) / Math.max(1, completed);
      const averageRounds = (stats.rounds || 0) / Math.max(1, completed);
      const loss = Number.isFinite(stats.loss) ? stats.loss : 0;
      const transitions = stats.transitions || 0;
      const playerMix = formatDistribution(stats.playerCounts, 'p');
      const roundMix = formatDistribution(stats.roundLengths, 'r');
      const policyMix = formatDistribution(stats.policyMix, '');
      const courtMix = formatDistribution(stats.actionStats?.courtActions, '');
      const shaping = (stats.shapingRewards || 0) / Math.max(1, completed);
      const lastSeed = snapshot.last?.seed ? ` | lastSeed=${snapshot.last.seed}` : '';

      console.log(
        `[ai:train] episode ${completed}/${total} (${formatPercent(completed / total)})`
        + ` | ${episodesPerSecond.toFixed(2)} ep/s`
        + ` | loss=${loss.toFixed(4)}`
        + ` | survived=${formatPercent(survivalRate)}`
        + ` | fell=${formatPercent(fallRate)}`
        + ` | truncated=${formatPercent(truncatedRate)}`
        + ` | avgRounds=${averageRounds.toFixed(2)}`
        + ` | players=${playerMix}`
        + ` | rounds=${roundMix}`
        + ` | policies=${policyMix}`
        + ` | court=${courtMix}`
        + ` | shaping=${shaping.toFixed(3)}`
        + ` | transitions=${transitions}`
        + lastSeed
        + ` | elapsed=${formatDuration(elapsed)}`,
      );
    },
    finish(stats) {
      const elapsed = Date.now() - startedAt;
      console.log(
        `[ai:train] done | episodes=${stats.episodes}`
        + ` survived=${stats.survivals}`
        + ` fell=${stats.falls}`
        + ` truncated=${stats.truncated || 0}`
        + ` avgRounds=${Number(stats.averageRounds || 0).toFixed(2)}`
        + ` avgLoss=${Number(stats.loss || 0).toFixed(4)}`
        + ` elapsed=${formatDuration(elapsed)}`,
      );
      console.log(`[ai:train] saved ${outputPath}`);
    },
  };
}

function mergeEpisodeStats(target, result) {
  target.falls += result.stats.fell ? 1 : 0;
  target.survivals += result.stats.survived ? 1 : 0;
  target.truncated += result.stats.truncated ? 1 : 0;
  target.transitions += result.transitions.length;
  target.rounds += result.stats.rounds;
  target.shapingRewards += result.stats.shapingRewards || 0;
  const playerCount = String(result.stats.playerCount);
  const roundLength = String(result.stats.deckSize);
  target.playerCounts[playerCount] = (target.playerCounts[playerCount] || 0) + 1;
  target.roundLengths[roundLength] = (target.roundLengths[roundLength] || 0) + 1;
  mergeActionStats(target.actionStats, result.stats.actionStats);
  mergePolicyMixStats(target.policyMix, result.stats.policyMix);
}

function runWorkerEpisode(network, options, seed, episodeIndex) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        kind: 'self-play-episode',
        network: serializeNetwork(network),
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

async function trainSelfPlayWithWorkers(network, options = {}) {
  const episodes = Math.max(1, Number(options.episodes) || 1);
  const workers = Math.max(1, Math.floor(Number(options.workers) || 1));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const onCheckpoint = typeof options.onCheckpoint === 'function' ? options.onCheckpoint : null;
  const checkpointInterval = Math.max(0, Math.floor(Number(options.checkpointInterval) || 0));
  const stats = {
    episodes,
    falls: 0,
    survivals: 0,
    truncated: 0,
    transitions: 0,
    rounds: 0,
    playerCounts: {},
    roundLengths: {},
    actionStats: {
      total: 0,
      byKind: {},
      byPhase: {},
      courtActions: {},
      rewardChoices: {},
      orderDeployments: { frontier: 0, capital: 0 },
      titleAssignments: 0,
      confirmations: 0,
    },
    policyMix: {},
    shapingRewards: 0,
    loss: 0,
  };

  let completed = 0;
  let nextCheckpoint = checkpointInterval;
  while (completed < episodes) {
    const batchSize = Math.min(workers, episodes - completed);
    const workerOptions = { ...options, onProgress: undefined, onCheckpoint: undefined, quiet: undefined, logInterval: undefined };
    const jobs = Array.from({ length: batchSize }, (_, index) => (
      runWorkerEpisode(
        network,
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
    }
    const report = trainTransitions(network, transitions, options);
    stats.loss += report.loss * batchSize;
    completed += batchSize;
    if (onProgress) {
      onProgress({
        completed,
        batchSize,
        episodes,
        stats: { ...stats, loss: stats.loss / completed },
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
        network,
        stats: { ...stats, loss: stats.loss / completed },
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
  stats.averageRounds = stats.rounds / episodes;
  return stats;
}

function cloneNetwork(network) {
  return deserializeNetwork(serializeNetwork(network));
}

function checkpointPathFor(outputPath, checkpointDir, completed) {
  const extension = extname(outputPath) || '.json';
  const stem = basename(outputPath, extension) || 'model';
  return resolve(checkpointDir, `${stem}-ep${String(completed).padStart(6, '0')}${extension}`);
}

function createCheckpointManager(trainingOptions, outputPath, args = {}) {
  const checkpointDir = args.checkpointDir || DEFAULT_CHECKPOINT_DIR;
  const evaluationSeed = hasArg(args, 'checkpointEvalSeed')
    ? numberArg(args, 'checkpointEvalSeed', 90_000)
    : deriveCheckpointSeed(trainingOptions);
  const checkpointOpponents = [];
  let best = null;
  let previousCheckpointNetwork = null;

  function evaluateCheckpoint(network, previousNetwork) {
    return runTournament({
      network,
      previousNetwork,
      episodes: trainingOptions.checkpointEvalEpisodes,
      seed: evaluationSeed,
      includeDeals: trainingOptions.includeDeals,
      playerCount: trainingOptions.playerCount,
      playerMin: trainingOptions.playerMin,
      playerMax: trainingOptions.playerMax,
      deckSize: trainingOptions.deckSize,
      roundMin: trainingOptions.roundMin,
      roundMax: trainingOptions.roundMax,
      includeRandomBaseline: true,
    });
  }

  function saveCheckpoint(snapshot) {
    const candidate = cloneNetwork(snapshot.network);
    const previousNetwork = previousCheckpointNetwork ? cloneNetwork(previousCheckpointNetwork) : null;
    const tournament = evaluateCheckpoint(candidate, previousNetwork);
    const score = scoreTournamentReport(tournament);
    const path = checkpointPathFor(outputPath, checkpointDir, snapshot.completed);
    const metadata = {
      ...snapshot.stats,
      checkpoint: true,
      checkpointEpisode: snapshot.completed,
      checkpointScore: score,
      checkpointTournament: tournament,
    };
    saveModelFileSync(candidate, path, metadata);

    if (!best || score > best.score) {
      best = {
        score,
        path,
        episode: snapshot.completed,
        network: cloneNetwork(candidate),
        tournament,
      };
    }

    checkpointOpponents.unshift(cloneNetwork(candidate));
    checkpointOpponents.splice(trainingOptions.checkpointOpponentLimit);
    trainingOptions.opponentNetworks = checkpointOpponents.slice();
    previousCheckpointNetwork = cloneNetwork(candidate);
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
  return deriveStableSeed(options.modelSeed || options.seed || 90_000, 113);
}

function deriveStableSeed(baseSeed, salt) {
  let value = ((Number(baseSeed) || 1) >>> 0) ^ Math.imul(Number(salt) || 1, 0x9e3779b9);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) || 1;
}

export async function runTrainingCli(argv = process.argv) {
  const args = parseArgs(argv);
  const resumePath = args.resume === true ? DEFAULT_MODEL_PATH : args.resume;
  const trainingOptions = resolveTrainingOptions(args);
  const network = resumePath
    ? (loadModelFileSync(resumePath) || createNetwork({ seed: trainingOptions.modelSeed }))
    : createNetwork({ seed: trainingOptions.modelSeed });
  const out = args.out || DEFAULT_MODEL_PATH;
  trainingOptions.logInterval = Math.max(
    1,
    Math.floor(numberArg(args, 'logInterval', Math.max(1, Math.floor(trainingOptions.episodes / 20)))),
  );

  const progress = createProgressReporter(trainingOptions, out, Boolean(resumePath));
  trainingOptions.onProgress = progress.update;
  const checkpoints = createCheckpointManager(trainingOptions, out, args);
  trainingOptions.onCheckpoint = (snapshot) => {
    const result = checkpoints.saveCheckpoint(snapshot);
    if (!trainingOptions.quiet) {
      console.log(`[ai:train] checkpoint ${result.path} | score=${result.score.toFixed(4)}`);
    }
  };
  progress.start();

  const stats = trainingOptions.workers > 1
    ? await trainSelfPlayWithWorkers(network, trainingOptions)
    : trainSelfPlay(network, trainingOptions);
  const promoted = checkpoints.best || {
    score: -Infinity,
    path: null,
    episode: trainingOptions.episodes,
    network: cloneNetwork(network),
    tournament: runTournament({
      network,
      episodes: trainingOptions.checkpointEvalEpisodes,
      seed: deriveCheckpointSeed(trainingOptions),
      includeDeals: trainingOptions.includeDeals,
      playerCount: trainingOptions.playerCount,
      playerMin: trainingOptions.playerMin,
      playerMax: trainingOptions.playerMax,
      deckSize: trainingOptions.deckSize,
      roundMin: trainingOptions.roundMin,
      roundMax: trainingOptions.roundMax,
      includeRandomBaseline: true,
    }),
  };
  if (!Number.isFinite(promoted.score)) promoted.score = scoreTournamentReport(promoted.tournament);
  saveModelFileSync(promoted.network, out, {
    ...stats,
    workers: trainingOptions.workers,
    workersAuto: trainingOptions.workersAuto,
    seed: trainingOptions.seed,
    seedWasSpecified: trainingOptions.seedWasSpecified,
    seedMode: trainingOptions.seedMode,
    modelSeed: trainingOptions.modelSeed,
    playerCount: trainingOptions.playerCount,
    playerRange: [trainingOptions.playerMin, trainingOptions.playerMax],
    deckSize: trainingOptions.deckSize,
    roundRange: [trainingOptions.roundMin, trainingOptions.roundMax],
    includeDeals: trainingOptions.includeDeals,
    rewardShaping: trainingOptions.rewardShaping,
    opponentMix: trainingOptions.opponentMix,
    randomOpponentRate: trainingOptions.randomOpponentRate,
    heuristicOpponentRate: trainingOptions.heuristicOpponentRate,
    checkpointOpponentRate: trainingOptions.checkpointOpponentRate,
    trainingEpochs: trainingOptions.trainingEpochs,
    checkpointInterval: trainingOptions.checkpointInterval,
    checkpointEvalEpisodes: trainingOptions.checkpointEvalEpisodes,
    checkpointDir: checkpoints.checkpointDir,
    promotedCheckpoint: promoted.path,
    promotedCheckpointEpisode: promoted.episode,
    promotedCheckpointScore: promoted.score,
    promotedTournament: promoted.tournament,
    logInterval: trainingOptions.logInterval,
  });
  progress.finish(stats);
  if (!trainingOptions.quiet) {
    console.log(`[ai:train] promoted ${promoted.path || 'final network'} -> ${out} | score=${promoted.score.toFixed(4)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    out,
    stats,
    promoted: {
      path: promoted.path,
      episode: promoted.episode,
      score: promoted.score,
    },
  }, null, 2));
  return { network: promoted.network, out, stats, promoted };
}

if (isMainThread && process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  try {
    await runTrainingCli(process.argv);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
