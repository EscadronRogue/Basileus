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

function createHeadToHeadPolicy(aiPolicy, opponent = {}, selfRole = 'learner') {
  const defensivePolicy = createDefensivePolicy();
  const policy = ({ state, playerId, actions, rng }) => {
    if (playerId === 0 && aiPolicy) return selectGreedy(aiPolicy, state, playerId, actions, rng);
    if (opponent.policy) return selectGreedy(opponent.policy, state, playerId, actions, rng);
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
  if (options.aiPolicy) {
    const policyVsRandom = createHeadToHeadPolicy(options.aiPolicy);
    matchups.policyVsRandom = {
      weight: 1,
      ...attachScore(evaluateHeadToHead(common, policyVsRandom)),
    };
    const policyVsHeuristic = createHeadToHeadPolicy(options.aiPolicy, { kind: 'heuristic' });
    matchups.policyVsHeuristic = {
      weight: 1,
      ...attachScore(evaluateHeadToHead(common, policyVsHeuristic)),
    };
    if (options.humanOpponentPolicy) {
      const policyVsHuman = createHeadToHeadPolicy(options.aiPolicy, {
        policy: options.humanOpponentPolicy,
        role: 'human',
      });
      matchups.policyVsHuman = {
        weight: 1,
        ...attachScore(evaluateHeadToHead(common, policyVsHuman)),
      };
      const humanVsPolicy = createHeadToHeadPolicy(
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
      const policyVsPrevious = createHeadToHeadPolicy(options.aiPolicy, {
        policy: options.previousPolicy,
        role: 'checkpoint',
      });
      matchups.policyVsPrevious = {
        weight: 1,
        ...attachScore(evaluateHeadToHead(common, policyVsPrevious)),
      };
      const previousVsPolicy = createHeadToHeadPolicy(
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
