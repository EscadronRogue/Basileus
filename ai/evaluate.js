import {
  DEFAULT_MODEL_PATH,
  loadModelFileSync,
} from './modelStore.js';
import { evaluatePolicy } from './selfPlay.js';
import { buildCandidateInputs } from './features.js';
import { selectActionWithNetwork } from './network.js';
import { runTournament } from './tournament.js';

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

export function runEvaluationCli(argv = process.argv) {
  const args = parseArgs(argv);
  const modelPath = args.model || DEFAULT_MODEL_PATH;
  const network = args.baseline === 'random' ? null : loadModelFileSync(modelPath);
  if (!network && args.baseline !== 'random') {
    throw new Error(`No neural model found at ${modelPath}. Run npm run ai:train first.`);
  }
  const opponentPath = args.opponent || null;
  const opponentNetwork = opponentPath ? loadModelFileSync(opponentPath) : null;
  if (opponentPath && !opponentNetwork) {
    throw new Error(`No opponent model found at ${opponentPath}.`);
  }
  const common = {
    episodes: numberArg(args, 'episodes', 20),
    seed: hasArg(args, 'seed') ? numberArg(args, 'seed', 10_000) : undefined,
    includeDeals: false,
    ...resolvePlayerOptions(args),
    ...resolveRoundOptions(args),
  };
  if (booleanArg(args, 'tournament', false)) {
    const report = runTournament({
      network,
      previousNetwork: opponentNetwork,
      includeRandomBaseline: true,
      ...common,
    });
    console.log(JSON.stringify({
      ok: true,
      model: network ? modelPath : 'random',
      opponent: opponentNetwork ? opponentPath : null,
      tournament: report,
    }, null, 2));
    return report;
  }
  const policy = network && !args.selfPlay
    ? ({ state, playerId, actions, rng }) => {
      const model = playerId === 0 ? network : opponentNetwork;
      if (!model) return Math.floor(rng() * actions.length);
      const inputs = buildCandidateInputs(state, playerId, actions);
      return selectActionWithNetwork(model, inputs, rng, { greedy: true, temperature: 0 }).index;
    }
    : null;
  const policyRoleForPlayer = policy
    ? (playerId) => (playerId === 0 ? 'learner' : (opponentNetwork ? 'checkpoint' : 'random'))
    : null;
  const stats = evaluatePolicy({
    network,
    policy,
    policyRoleForPlayer,
    ...common,
    greedy: args.greedy !== 'false',
  });
  console.log(JSON.stringify({
    ok: true,
    model: network ? modelPath : 'random',
    opponent: opponentNetwork ? opponentPath : (network && !args.selfPlay ? 'random' : null),
    stats,
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
