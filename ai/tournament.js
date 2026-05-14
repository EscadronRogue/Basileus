import { buildCandidateInputs } from './features.js';
import { selectActionWithNetwork } from './network.js';
import {
  createDefensivePolicy,
  evaluatePolicy,
} from './selfPlay.js';

function selectGreedy(network, state, playerId, actions, rng) {
  const inputs = buildCandidateInputs(state, playerId, actions);
  return selectActionWithNetwork(network, inputs, rng, {
    greedy: true,
    temperature: 0,
  }).index;
}

function createHeadToHeadPolicy(network, opponent = {}) {
  const defensivePolicy = createDefensivePolicy();
  return ({ state, playerId, actions, rng }) => {
    if (playerId === 0 && network) return selectGreedy(network, state, playerId, actions, rng);
    if (opponent.network) return selectGreedy(opponent.network, state, playerId, actions, rng);
    if (opponent.kind === 'heuristic') return defensivePolicy({ state, playerId, actions, rng });
    return Math.floor(rng() * actions.length);
  };
}

export function scoreEvaluationStats(stats = {}) {
  const episodes = Math.max(1, stats.episodes || 1);
  const reward = Number(stats.rewardByPlayer?.[0] ?? stats.rewardByPlayer?.['0'] ?? -1);
  const survivalRate = Number(stats.survivalRate ?? ((stats.survivals || 0) / episodes));
  const fallRate = Number(stats.fallRate ?? ((stats.falls || 0) / episodes));
  const truncatedRate = Number(stats.truncatedRate ?? ((stats.truncated || 0) / episodes));
  const winRate = Number(stats.winRateByPlayer?.[0] ?? stats.winRateByPlayer?.['0'] ?? 0);
  return reward + survivalRate + (0.5 * winRate) - fallRate - truncatedRate;
}

function attachScore(stats) {
  return {
    ...stats,
    score: scoreEvaluationStats(stats),
  };
}

export function scoreTournamentReport(report = {}) {
  const entries = Object.values(report.matchups || {})
    .filter((entry) => Number.isFinite(entry?.score));
  if (!entries.length) return -Infinity;
  const totalWeight = entries.reduce((total, entry) => total + (entry.weight ?? 1), 0) || 1;
  return entries.reduce((total, entry) => total + entry.score * (entry.weight ?? 1), 0) / totalWeight;
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
    includeDeals: options.includeDeals,
    maxSteps: options.maxSteps,
    maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer,
    greedy: true,
  };

  const matchups = {};
  if (options.network) {
    matchups.modelVsRandom = {
      weight: 1,
      ...attachScore(evaluatePolicy({
        ...common,
        policy: createHeadToHeadPolicy(options.network),
      })),
    };
    matchups.modelVsHeuristic = {
      weight: 1,
      ...attachScore(evaluatePolicy({
        ...common,
        policy: createHeadToHeadPolicy(options.network, { kind: 'heuristic' }),
      })),
    };
    matchups.selfPlay = {
      weight: 0.5,
      ...attachScore(evaluatePolicy({
        ...common,
        network: options.network,
      })),
    };
    if (options.previousNetwork) {
      matchups.modelVsPrevious = {
        weight: 1,
        ...attachScore(evaluatePolicy({
          ...common,
          policy: createHeadToHeadPolicy(options.network, { network: options.previousNetwork }),
        })),
      };
      matchups.previousVsModel = {
        weight: 0.5,
        ...attachScore(evaluatePolicy({
          ...common,
          policy: createHeadToHeadPolicy(options.previousNetwork, { network: options.network }),
        })),
      };
    }
  }

  if (options.includeRandomBaseline) {
    matchups.randomBaseline = {
      weight: options.network ? 0 : 1,
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
