import { evaluateStrategy } from './selfPlay.js';
import { RANDOM_OPPONENT_ID } from './heuristics.js';
import {
  runHeuristicLeague,
  runTournament,
  runTournamentSuite,
} from './tournament.js';

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

function strategiesForRandom(playerCount = 5) {
  return Object.fromEntries(Array.from({ length: Math.max(1, playerCount) }, (_, index) => [index, RANDOM_OPPONENT_ID]));
}

export function runEvaluationCli(argv = process.argv) {
  const args = parseArgs(argv);
  const common = {
    episodes: numberArg(args, 'episodes', 20),
    seed: hasArg(args, 'seed') ? numberArg(args, 'seed', 10_000) : undefined,
    seedCount: Math.max(1, Math.floor(numberArg(args, 'seedCount', numberArg(args, 'seeds', 1)))),
    ...resolvePlayerOptions(args),
    ...resolveRoundOptions(args),
    maxSteps: hasArg(args, 'maxSteps') ? numberArg(args, 'maxSteps', 1000) : undefined,
    maxCourtActionsPerPlayer: hasArg(args, 'maxCourtActionsPerPlayer')
      ? numberArg(args, 'maxCourtActionsPerPlayer', 16)
      : undefined,
  };

  if (booleanArg(args, 'league', false) || booleanArg(args, 'tournament', false)) {
    const report = booleanArg(args, 'matchup', false)
      ? runTournamentSuite({
        ...common,
        primaryId: args.strategy || args.primary || 'alexios',
        opponentId: args.opponent || RANDOM_OPPONENT_ID,
      })
      : runHeuristicLeague(common);
    console.log(JSON.stringify({ ok: true, report }, null, 2));
    return report;
  }

  const strategy = args.strategy || args.ai || 'alexios';
  const stats = strategy === RANDOM_OPPONENT_ID
    ? evaluateStrategy({
      ...common,
      strategies: strategiesForRandom(common.playerCount || 5),
    })
    : evaluateStrategy({
      ...common,
      strategyId: strategy,
    });
  const oneMatch = args.opponent
    ? runTournament({
      ...common,
      primaryId: strategy,
      opponentId: args.opponent,
    })
    : null;
  console.log(JSON.stringify({
    ok: true,
    strategy,
    opponent: args.opponent || null,
    stats,
    matchup: oneMatch,
  }, null, 2));
  return stats;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  try {
    runEvaluationCli(process.argv);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
