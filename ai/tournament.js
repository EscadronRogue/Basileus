import { buildCandidateFeatures } from './features.js';
import { selectActionWithPolicy } from './policy.js';
import {
  createDefensivePolicy,
  evaluatePolicy,
} from './selfPlay.js';

function selectGreedy(aiPolicy, state, playerId, actions, rng) {
  const features = buildCandidateFeatures(state, playerId, actions);
  return selectActionWithPolicy(aiPolicy, features, rng, {
    greedy: true,
    temperature: 0,
  }).index;
}

function opponentRole(opponent = {}) {
  if (opponent.role) return opponent.role;
  if (opponent.kind === 'heuristic') return 'heuristic';
  if (opponent.policy) return 'checkpoint';
  return 'random';
}

function createHeadToHeadPolicy(aiPolicy, opponent = {}, selfRole = 'learner', selfPlayerId = 0) {
  const defensivePolicy = createDefensivePolicy();
  const policy = ({ state, playerId, actions, rng }) => {
    if (playerId === selfPlayerId && aiPolicy) return selectGreedy(aiPolicy, state, playerId, actions, rng);
    if (opponent.policy) return selectGreedy(opponent.policy, state, playerId, actions, rng);
    if (opponent.kind === 'heuristic') return defensivePolicy({ state, playerId, actions, rng });
    return Math.floor(rng() * actions.length);
  };
  policy.roleForPlayer = (playerId) => (playerId === selfPlayerId ? selfRole : opponentRole(opponent));
  return policy;
}

function rotatingSelfPlayerId(settings = {}, episode = 0) {
  const playerCount = Math.max(1, Math.floor(Number(settings.playerCount) || 1));
  return Math.max(0, Math.floor(Number(episode) || 0) % playerCount);
}

function createHeadToHeadEpisodeOptions(aiPolicy, opponent = {}, selfRole = 'learner') {
  return ({ episode, settings }) => {
    const policy = createHeadToHeadPolicy(
      aiPolicy,
      opponent,
      selfRole,
      rotatingSelfPlayerId(settings, episode),
    );
    return {
      policy,
      policyRoleForPlayer: policy.roleForPlayer,
    };
  };
}

function evaluateHeadToHead(common, episodeOptions) {
  return evaluatePolicy({
    ...common,
    episodeOptions,
  });
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roleMetric(stats = {}, key, role = 'learner') {
  return finiteNumber(stats?.[key]?.[role] ?? stats?.[key]?.[String(role)]);
}

export function scoreEvaluationStats(stats = {}) {
  const episodes = Math.max(1, stats.episodes || 1);
  const reward = roleMetric(stats, 'rewardByRole') ?? Number(stats.rewardByPlayer?.[0] ?? stats.rewardByPlayer?.['0'] ?? -1);
  const survivalRate = roleMetric(stats, 'survivalRateByRole') ?? Number(stats.survivalRate ?? ((stats.survivals || 0) / episodes));
  const fallRate = roleMetric(stats, 'fallRateByRole') ?? Number(stats.fallRate ?? ((stats.falls || 0) / episodes));
  const truncatedRate = roleMetric(stats, 'truncatedRateByRole') ?? Number(stats.truncatedRate ?? ((stats.truncated || 0) / episodes));
  const winRate = roleMetric(stats, 'winRateByRole') ?? Number(stats.winRateByPlayer?.[0] ?? stats.winRateByPlayer?.['0'] ?? 0);
  return reward + survivalRate + (0.5 * winRate) - fallRate - truncatedRate;
}

function attachScore(stats) {
  return {
    ...stats,
    score: scoreEvaluationStats(stats),
  };
}

export function scoreTournamentReport(report = {}) {
  if (Number.isFinite(report.adjustedScore)) return report.adjustedScore;
  if (Array.isArray(report.runs) && Number.isFinite(report.score)) return report.score;
  const entries = Object.values(report.matchups || {})
    .filter((entry) => Number.isFinite(entry?.score));
  if (!entries.length) return -Infinity;
  const totalWeight = entries.reduce((total, entry) => total + (entry.weight ?? 1), 0) || 1;
  return entries.reduce((total, entry) => total + entry.score * (entry.weight ?? 1), 0) / totalWeight;
}

function summarizeConfidence(values = []) {
  const samples = values.filter((value) => Number.isFinite(value));
  const count = samples.length;
  if (!count) {
    return {
      count: 0,
      mean: -Infinity,
      standardDeviation: 0,
      standardError: 0,
      margin95: Infinity,
      lower95: -Infinity,
      upper95: Infinity,
    };
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / count;
  const variance = count > 1
    ? samples.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (count - 1)
    : 0;
  const standardDeviation = Math.sqrt(variance);
  const standardError = standardDeviation / Math.sqrt(count);
  const margin95 = count > 1 ? 1.96 * standardError : 0;
  return {
    count,
    mean,
    standardDeviation,
    standardError,
    margin95,
    lower95: mean - margin95,
    upper95: mean + margin95,
  };
}

function deriveTournamentSeed(baseSeed, index = 0) {
  const base = Number.isFinite(Number(baseSeed)) ? Number(baseSeed) : 90_000;
  let value = (base >>> 0) + Math.imul(Math.floor(Number(index) || 0), 0x9e3779b9);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) || 1;
}

function summarizeSuiteMatchups(runs = []) {
  const keys = new Set(runs.flatMap((run) => Object.keys(run.matchups || {})));
  return Object.fromEntries([...keys].map((key) => {
    const entries = runs.map((run) => run.matchups?.[key]).filter(Boolean);
    const confidence = summarizeConfidence(entries.map((entry) => entry.score));
    return [key, {
      weight: entries[0]?.weight ?? 1,
      score: confidence.mean,
      adjustedScore: confidence.lower95,
      confidence,
    }];
  }));
}

export function runTournament(options = {}) {
  const common = {
    episodes: Math.max(1, Number(options.episodes) || 8),
    seed: options.seed,
    playerCount: options.playerCount,
    playerMin: options.playerMin,
    playerMax: options.playerMax,
    deckSize: options.deckSize,
    roundMin: options.roundMin,
    roundMax: options.roundMax,
    includeDeals: false,
    maxSteps: options.maxSteps,
    maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer,
    greedy: true,
  };

  const matchups = {};
  if (options.aiPolicy) {
    matchups.policyVsRandom = {
      weight: 1,
      ...attachScore(evaluateHeadToHead(
        common,
        createHeadToHeadEpisodeOptions(options.aiPolicy),
      )),
    };
    matchups.policyVsHeuristic = {
      weight: 1,
      ...attachScore(evaluateHeadToHead(
        common,
        createHeadToHeadEpisodeOptions(options.aiPolicy, { kind: 'heuristic' }),
      )),
    };
    if (options.humanOpponentPolicy) {
      matchups.policyVsHuman = {
        weight: 1,
        ...attachScore(evaluateHeadToHead(
          common,
          createHeadToHeadEpisodeOptions(options.aiPolicy, {
            policy: options.humanOpponentPolicy,
            role: 'human',
          }),
        )),
      };
      const humanVsPolicy = createHeadToHeadEpisodeOptions(
        options.humanOpponentPolicy,
        { policy: options.aiPolicy, role: 'learner' },
        'human',
      );
      matchups.humanVsPolicy = {
        weight: 0,
        ...attachScore(evaluateHeadToHead(common, humanVsPolicy)),
      };
    }
    matchups.selfPlay = {
      weight: 0.5,
      ...attachScore(evaluatePolicy({
        ...common,
        aiPolicy: options.aiPolicy,
      })),
    };
    if (options.previousPolicy) {
      matchups.policyVsPrevious = {
        weight: 1,
        ...attachScore(evaluateHeadToHead(
          common,
          createHeadToHeadEpisodeOptions(options.aiPolicy, {
            policy: options.previousPolicy,
            role: 'checkpoint',
          }),
        )),
      };
      const previousVsPolicy = createHeadToHeadEpisodeOptions(
        options.previousPolicy,
        { policy: options.aiPolicy, role: 'learner' },
        'checkpoint',
      );
      matchups.previousVsPolicy = {
        weight: 0.5,
        ...attachScore(evaluateHeadToHead(common, previousVsPolicy)),
      };
    }
  }

  if (options.includeRandomBaseline) {
    matchups.randomBaseline = {
      weight: options.aiPolicy ? 0 : 1,
      ...attachScore(evaluatePolicy({
        ...common,
      })),
    };
  }

  const report = {
    episodes: common.episodes,
    seed: common.seed,
    includeDeals: common.includeDeals,
    matchups,
  };
  report.score = scoreTournamentReport(report);
  return report;
}

export function runTournamentSuite(options = {}) {
  const seedCount = Math.max(1, Math.floor(Number(
    options.seedCount ?? options.evalSeedCount ?? options.checkpointEvalSeedCount ?? 1,
  ) || 1));
  const runs = Array.from({ length: seedCount }, (_, index) => runTournament({
    ...options,
    seed: deriveTournamentSeed(options.seed, index),
  }));
  const scores = runs.map((run) => scoreTournamentReport(run));
  const confidence = summarizeConfidence(scores);
  const report = {
    episodes: Math.max(1, Number(options.episodes) || 8),
    seed: Number.isFinite(Number(options.seed)) ? Number(options.seed) : null,
    seedCount,
    totalEpisodes: runs.reduce((total, run) => total + (run.episodes || 0), 0),
    includeDeals: false,
    confidence,
    score: confidence.mean,
    adjustedScore: confidence.lower95,
    matchups: summarizeSuiteMatchups(runs),
    runs,
  };
  return report;
}
