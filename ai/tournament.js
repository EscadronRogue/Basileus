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

function opponentRole(opponent = {}) {
  if (opponent.role) return opponent.role;
  if (opponent.kind === 'heuristic') return 'heuristic';
  if (opponent.network) return 'checkpoint';
  return 'random';
}

function createHeadToHeadPolicy(network, opponent = {}, selfRole = 'learner') {
  const defensivePolicy = createDefensivePolicy();
  const policy = ({ state, playerId, actions, rng }) => {
    if (playerId === 0 && network) return selectGreedy(network, state, playerId, actions, rng);
    if (opponent.network) return selectGreedy(opponent.network, state, playerId, actions, rng);
    if (opponent.kind === 'heuristic') return defensivePolicy({ state, playerId, actions, rng });
    return Math.floor(rng() * actions.length);
  };
  policy.roleForPlayer = (playerId) => (playerId === 0 ? selfRole : opponentRole(opponent));
  return policy;
}

function evaluateHeadToHead(common, policy) {
  return evaluatePolicy({
    ...common,
    policy,
    policyRoleForPlayer: policy.roleForPlayer,
  });
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
    includeDeals: false,
    maxSteps: options.maxSteps,
    maxCourtActionsPerPlayer: options.maxCourtActionsPerPlayer,
    greedy: true,
  };

  const matchups = {};
  if (options.network) {
    const modelVsRandom = createHeadToHeadPolicy(options.network);
    matchups.modelVsRandom = {
      weight: 1,
      ...attachScore(evaluateHeadToHead(common, modelVsRandom)),
    };
    const modelVsHeuristic = createHeadToHeadPolicy(options.network, { kind: 'heuristic' });
    matchups.modelVsHeuristic = {
      weight: 1,
      ...attachScore(evaluateHeadToHead(common, modelVsHeuristic)),
    };
    if (options.humanOpponentNetwork) {
      const modelVsHuman = createHeadToHeadPolicy(options.network, {
        network: options.humanOpponentNetwork,
        role: 'human',
      });
      matchups.modelVsHuman = {
        weight: 1,
        ...attachScore(evaluateHeadToHead(common, modelVsHuman)),
      };
      const humanVsModel = createHeadToHeadPolicy(
        options.humanOpponentNetwork,
        { network: options.network, role: 'learner' },
        'human',
      );
      matchups.humanVsModel = {
        weight: 0,
        ...attachScore(evaluateHeadToHead(common, humanVsModel)),
      };
    }
    matchups.selfPlay = {
      weight: 0.5,
      ...attachScore(evaluatePolicy({
        ...common,
        network: options.network,
      })),
    };
    if (options.previousNetwork) {
      const modelVsPrevious = createHeadToHeadPolicy(options.network, {
        network: options.previousNetwork,
        role: 'checkpoint',
      });
      matchups.modelVsPrevious = {
        weight: 1,
        ...attachScore(evaluateHeadToHead(common, modelVsPrevious)),
      };
      const previousVsModel = createHeadToHeadPolicy(
        options.previousNetwork,
        { network: options.network, role: 'learner' },
        'checkpoint',
      );
      matchups.previousVsModel = {
        weight: 0.5,
        ...attachScore(evaluateHeadToHead(common, previousVsModel)),
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
