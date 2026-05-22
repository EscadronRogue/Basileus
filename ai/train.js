import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

import { makeRng } from '../engine/state.js';
import { simulateGame } from './simulate.js';
import { DEFAULT_STRATEGY_WEIGHTS } from './strategy.js';
import { POLICY_WEIGHT_PRESETS } from './policies.js';
import { pickGreekFirstName, slugifyGreekFirstName } from './greekNames.js';
import { normalizeTunedOpponentRoster } from './opponentRoster.js';

const DEFAULT_OPTIONS = {
  generations: 3,
  population: 10,
  elite: 3,
  games: 24,
  playerCount: 4,
  deckSize: 9,
  seed: 1000,
  maxSteps: 500,
  mutation: 0.35,
  fallPenalty: 130,
  selfPlayEvery: 4,
  save: true,
  outputPath: fileURLToPath(new URL('./tunedOpponents.json', import.meta.url)),
  league: ['strategic', 'defender', 'usurper', 'profiteer', 'random', 'copycat'],
};

export const STRATEGY_WEIGHT_BOUNDS = Object.freeze({
  ownRecipientBonus: [0, 8],
  leaderDenial: [0.2, 2.6],
  rivalDenial: [0, 1.2],
  estateProfit: [1, 9],
  estateBidCost: [0.35, 2.4],
  estateThreatPenalty: [0, 5],
  invasionMargin: [0.35, 2.4],
  capitalFallPenalty: [100, 1400],
  capitalRiskPenalty: [20, 500],
  invasionVictoryBonus: [0, 24],
  invasionDefeatPenalty: [0, 34],
  recoveryBonus: [0, 2.5],
  throneBase: [0, 80],
  throneProgress: [0, 120],
  selfClaim: [0.05, 2.4],
  incumbentDefense: [0.1, 2.4],
  supportLeaderPenalty: [0.1, 2.4],
  supportOtherClaimant: [0, 1.8],
  reserveValue: [0, 1.2],
  mercenaryCostPenalty: [0, 0.55],
});

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function toFloat(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clamp(value, [min, max]) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function boundedWeights(raw = {}) {
  const weights = { ...DEFAULT_STRATEGY_WEIGHTS, ...raw };
  for (const [key, bounds] of Object.entries(STRATEGY_WEIGHT_BOUNDS)) {
    weights[key] = clamp(weights[key], bounds);
  }
  return weights;
}

function mutateWeights(base, rng, mutation) {
  const weights = boundedWeights(base);
  for (const [key, bounds] of Object.entries(STRATEGY_WEIGHT_BOUNDS)) {
    const current = weights[key];
    const span = bounds[1] - bounds[0];
    const scaleNoise = 1 + (rng() * 2 - 1) * mutation;
    const additiveNoise = (rng() * 2 - 1) * span * mutation * 0.08;
    weights[key] = clamp(current * scaleNoise + additiveNoise, bounds);
  }
  return weights;
}

function seedPopulation(options, rng) {
  const namedProfiles = [
    ['strategic', {}],
    ['defender', POLICY_WEIGHT_PRESETS.defender],
    ['usurper', POLICY_WEIGHT_PRESETS.usurper],
    ['profiteer', POLICY_WEIGHT_PRESETS.profiteer],
    ['greedy', POLICY_WEIGHT_PRESETS.greedy],
    ['loyalist', POLICY_WEIGHT_PRESETS.loyalist],
  ];
  const population = namedProfiles.map(([name, weights]) => ({
    name,
    weights: boundedWeights(weights),
  }));
  while (population.length < options.population) {
    population.push({
      name: `mutant-${population.length + 1}`,
      weights: mutateWeights(DEFAULT_STRATEGY_WEIGHTS, rng, 0.85),
    });
  }
  return population.slice(0, options.population);
}

function buildPoliciesForGame(weights, options, gameIndex, profileIndex) {
  const candidateSeat = gameIndex % options.playerCount;
  const selfPlay = options.selfPlayEvery > 0 && gameIndex % options.selfPlayEvery === 0;
  const policies = [];
  for (let seatId = 0; seatId < options.playerCount; seatId += 1) {
    if (selfPlay || seatId === candidateSeat) {
      policies.push({ policyId: 'tuned', label: 'candidate', strategyWeights: weights });
    } else {
      const leagueIndex = (gameIndex + seatId + profileIndex) % options.league.length;
      policies.push(options.league[leagueIndex] || 'strategic');
    }
  }
  return { candidateSeat, policies };
}

function scoreCandidateGame(game, candidateSeat, playerCount, options) {
  const rankIndex = game.finalScores.findIndex((entry) => entry.playerId === candidateSeat);
  const rank = rankIndex >= 0 ? rankIndex + 1 : playerCount;
  const entry = game.finalScores[rankIndex] || { points: 0, gold: 0, projectedIncome: 0 };
  const resolutions = Math.max(1, Number(game.stats?.resolutions) || 0);
  const victoryRate = (Number(game.stats?.wars?.victory) || 0) / resolutions;
  const defeatRate = (Number(game.stats?.wars?.defeat) || 0) / resolutions;
  const won = game.winnerIds.includes(candidateSeat);

  let objective = won ? 160 : 0;
  objective += (playerCount - rank) * 34;
  objective += (Number(entry.points) || 0) * 8;
  objective += (Number(entry.gold) || 0) * 0.25;
  objective += (Number(entry.projectedIncome) || 0) * 0.5;
  objective += victoryRate * 24;
  objective -= defeatRate * 34;
  if (game.fall) objective -= options.fallPenalty;
  if (game.reason === 'stuck') objective -= 100;

  return { objective, won, rank, points: Number(entry.points) || 0, fall: Boolean(game.fall) };
}

export function evaluateStrategyWeights(weights, rawOptions = {}, profileIndex = 0) {
  const options = normalizeOptions(rawOptions);
  let total = 0;
  let wins = 0;
  let rankTotal = 0;
  let pointTotal = 0;
  let falls = 0;
  let stuck = 0;

  for (let gameIndex = 0; gameIndex < options.games; gameIndex += 1) {
    const { candidateSeat, policies } = buildPoliciesForGame(weights, options, gameIndex, profileIndex);
    const game = simulateGame({
      playerCount: options.playerCount,
      deckSize: options.deckSize,
      seed: options.seed + profileIndex * 100000 + gameIndex,
      maxSteps: options.maxSteps,
      policies,
      historyEnabled: false,
      samples: 0,
    }, 0);
    const score = scoreCandidateGame(game, candidateSeat, options.playerCount, options);
    total += score.objective;
    wins += score.won ? 1 : 0;
    rankTotal += score.rank;
    pointTotal += score.points;
    falls += score.fall ? 1 : 0;
    stuck += game.reason === 'stuck' ? 1 : 0;
  }

  return {
    objective: round(total / options.games),
    winRate: round(wins / options.games),
    averageRank: round(rankTotal / options.games),
    averagePoints: round(pointTotal / options.games),
    fallRate: round(falls / options.games),
    stuck,
  };
}

function compactWeights(weights) {
  return Object.fromEntries(
    Object.entries(weights)
      .filter(([key, value]) => Math.abs(value - DEFAULT_STRATEGY_WEIGHTS[key]) > 0.001)
      .map(([key, value]) => [key, round(value, 4)]),
  );
}

function readSavedOpponents(path) {
  try {
    return normalizeTunedOpponentRoster(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return [];
  }
}

function uniqueTunedId(name, existing) {
  const used = new Set(existing.map((entry) => entry.id));
  const base = `tuned-${slugifyGreekFirstName(name)}`;
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function saveBestOpponent(result) {
  const existing = readSavedOpponents(result.options.outputPath);
  const firstName = pickGreekFirstName(`${result.options.seed}:${Date.now()}:${result.best.metrics.objective}`);
  const entry = {
    id: uniqueTunedId(firstName, existing),
    firstName,
    label: 'Tuned AI',
    description: `Tuned against ${result.options.league.join(', ')}.`,
    policy: {
      policyId: 'tuned',
      strategyWeights: result.best.weights,
    },
    strategyWeights: result.best.weights,
    metrics: result.best.metrics,
    training: {
      trainedAt: new Date().toISOString(),
      generations: result.options.generations,
      population: result.options.population,
      gamesPerCandidate: result.options.games,
      playerCount: result.options.playerCount,
      deckSize: result.options.deckSize,
      seed: result.options.seed,
      league: result.options.league,
      selfPlayEvery: result.options.selfPlayEvery,
      fallPenalty: result.options.fallPenalty,
    },
  };
  const payload = {
    version: 1,
    updatedAt: entry.training.trainedAt,
    opponents: [entry, ...existing].slice(0, 24),
  };
  writeFileSync(result.options.outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path: result.options.outputPath, opponent: entry };
}

function normalizeOptions(rawOptions = {}) {
  const population = Math.max(2, toInt(rawOptions.population, DEFAULT_OPTIONS.population));
  return {
    ...DEFAULT_OPTIONS,
    ...rawOptions,
    generations: Math.max(1, toInt(rawOptions.generations, DEFAULT_OPTIONS.generations)),
    population,
    elite: Math.max(1, Math.min(population, toInt(rawOptions.elite, DEFAULT_OPTIONS.elite))),
    games: Math.max(1, toInt(rawOptions.games, DEFAULT_OPTIONS.games)),
    playerCount: Math.max(3, Math.min(5, toInt(rawOptions.playerCount, DEFAULT_OPTIONS.playerCount))),
    deckSize: Math.max(1, toInt(rawOptions.deckSize, DEFAULT_OPTIONS.deckSize)),
    seed: toInt(rawOptions.seed, DEFAULT_OPTIONS.seed),
    maxSteps: Math.max(20, toInt(rawOptions.maxSteps, DEFAULT_OPTIONS.maxSteps)),
    mutation: Math.max(0.01, Math.min(1.5, toFloat(rawOptions.mutation, DEFAULT_OPTIONS.mutation))),
    fallPenalty: Math.max(0, toFloat(rawOptions.fallPenalty, DEFAULT_OPTIONS.fallPenalty)),
    selfPlayEvery: Math.max(0, toInt(rawOptions.selfPlayEvery, DEFAULT_OPTIONS.selfPlayEvery)),
    save: rawOptions.save !== false,
    outputPath: rawOptions.outputPath || DEFAULT_OPTIONS.outputPath,
    league: Array.isArray(rawOptions.league) && rawOptions.league.length ? rawOptions.league : DEFAULT_OPTIONS.league,
  };
}

function emitProgress(options, event) {
  if (typeof options.onProgress === 'function') options.onProgress(event);
}

export function trainStrategyWeights(rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const rng = makeRng(options.seed);
  let population = seedPopulation(options, rng);
  const generations = [];
  let best = null;
  const startedAt = Date.now();

  emitProgress(options, {
    type: 'training-start',
    generations: options.generations,
    population: options.population,
    games: options.games,
    totalGames: options.generations * options.population * options.games,
    league: options.league,
    seed: options.seed,
    elapsedMs: 0,
  });

  for (let generation = 0; generation < options.generations; generation += 1) {
    emitProgress(options, {
      type: 'generation-start',
      generation: generation + 1,
      generations: options.generations,
      elapsedMs: Date.now() - startedAt,
    });

    const evaluated = [];
    for (let index = 0; index < population.length; index += 1) {
      const profile = population[index];
      emitProgress(options, {
        type: 'candidate-start',
        generation: generation + 1,
        generations: options.generations,
        candidate: index + 1,
        population: options.population,
        name: profile.name,
        games: options.games,
        elapsedMs: Date.now() - startedAt,
      });
      const metrics = evaluateStrategyWeights(profile.weights, options, generation * options.population + index);
      const candidate = { ...profile, metrics };
      evaluated.push(candidate);
      emitProgress(options, {
        type: 'candidate-end',
        generation: generation + 1,
        generations: options.generations,
        candidate: index + 1,
        population: options.population,
        name: profile.name,
        metrics,
        elapsedMs: Date.now() - startedAt,
      });
    }
    evaluated.sort((left, right) => right.metrics.objective - left.metrics.objective);

    if (!best || evaluated[0].metrics.objective > best.metrics.objective) best = evaluated[0];
    generations.push({
      generation: generation + 1,
      best: {
        name: evaluated[0].name,
        metrics: evaluated[0].metrics,
        weights: compactWeights(evaluated[0].weights),
      },
    });
    emitProgress(options, {
      type: 'generation-end',
      generation: generation + 1,
      generations: options.generations,
      bestName: evaluated[0].name,
      bestMetrics: evaluated[0].metrics,
      globalBestName: best.name,
      globalBestMetrics: best.metrics,
      elapsedMs: Date.now() - startedAt,
    });

    const elites = evaluated.slice(0, options.elite);
    population = elites.map((profile) => ({ name: profile.name, weights: profile.weights }));
    while (population.length < options.population) {
      const parent = elites[Math.floor(rng() * elites.length)];
      population.push({
        name: `${parent.name}-g${generation + 1}-${population.length + 1}`,
        weights: mutateWeights(parent.weights, rng, options.mutation),
      });
    }
  }

  const result = {
    options,
    best: {
      name: best.name,
      metrics: best.metrics,
      weights: best.weights,
      compactWeights: compactWeights(best.weights),
    },
    generations,
  };
  if (options.save) {
    result.saved = saveBestOpponent(result);
    emitProgress(options, {
      type: 'saved',
      firstName: result.saved.opponent.firstName,
      id: result.saved.opponent.id,
      path: result.saved.path,
      elapsedMs: Date.now() - startedAt,
    });
  }
  emitProgress(options, {
    type: 'training-end',
    bestName: result.best.name,
    bestMetrics: result.best.metrics,
    saved: result.saved || null,
    elapsedMs: Date.now() - startedAt,
  });
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'json') {
      options.json = true;
      continue;
    }
    if (key === 'no-save') {
      options.save = false;
      continue;
    }
    if (key === 'quiet') {
      options.quiet = true;
      continue;
    }
    const value = argv[index + 1];
    index += 1;
    if (key === 'generations') options.generations = toInt(value, DEFAULT_OPTIONS.generations);
    else if (key === 'population') options.population = toInt(value, DEFAULT_OPTIONS.population);
    else if (key === 'elite') options.elite = toInt(value, DEFAULT_OPTIONS.elite);
    else if (key === 'games') options.games = toInt(value, DEFAULT_OPTIONS.games);
    else if (key === 'players') options.playerCount = toInt(value, DEFAULT_OPTIONS.playerCount);
    else if (key === 'deck') options.deckSize = toInt(value, DEFAULT_OPTIONS.deckSize);
    else if (key === 'seed') options.seed = toInt(value, DEFAULT_OPTIONS.seed);
    else if (key === 'mutation') options.mutation = toFloat(value, DEFAULT_OPTIONS.mutation);
    else if (key === 'fall-penalty') options.fallPenalty = toFloat(value, DEFAULT_OPTIONS.fallPenalty);
    else if (key === 'self-play-every') options.selfPlayEvery = toInt(value, DEFAULT_OPTIONS.selfPlayEvery);
    else if (key === 'output') options.outputPath = resolve(String(value || DEFAULT_OPTIONS.outputPath));
    else if (key === 'league') options.league = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return options;
}

function percent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function seconds(ms) {
  return `${round((Number(ms) || 0) / 1000, 1)}s`;
}

function compactMetrics(metrics) {
  return `objective ${metrics.objective}, win ${percent(metrics.winRate)}, rank ${metrics.averageRank}, fall ${percent(metrics.fallRate)}`;
}

function createCliProgressLogger() {
  return (event) => {
    if (event.type === 'training-start') {
      console.log(`[train ${seconds(event.elapsedMs)}] Starting ${event.generations} generations x ${event.population} profiles x ${event.games} games (${event.totalGames} games total), seed ${event.seed}.`);
    } else if (event.type === 'generation-start') {
      console.log(`[train ${seconds(event.elapsedMs)}] Generation ${event.generation}/${event.generations} started.`);
    } else if (event.type === 'candidate-start') {
      console.log(`[train ${seconds(event.elapsedMs)}]   Candidate ${event.candidate}/${event.population}: ${event.name} (${event.games} games)`);
    } else if (event.type === 'candidate-end') {
      console.log(`[train ${seconds(event.elapsedMs)}]   -> ${event.name}: ${compactMetrics(event.metrics)}`);
    } else if (event.type === 'generation-end') {
      console.log(`[train ${seconds(event.elapsedMs)}] Generation ${event.generation}/${event.generations} winner: ${event.bestName} (${compactMetrics(event.bestMetrics)}). Global best: ${event.globalBestName}.`);
    } else if (event.type === 'saved') {
      console.log(`[train ${seconds(event.elapsedMs)}] Saved ${event.firstName} (${event.id}) to ${event.path}.`);
    } else if (event.type === 'training-end') {
      console.log(`[train ${seconds(event.elapsedMs)}] Finished. Best: ${event.bestName} (${compactMetrics(event.bestMetrics)}).`);
    }
  };
}

function formatTrainingReport(result) {
  const lines = [
    `AI training: ${result.options.generations} generations, ${result.options.population} profiles, ${result.options.games} games/profile`,
    `League: ${result.options.league.join(', ')}; self-play every ${result.options.selfPlayEvery || 'never'} games`,
    `Best: ${result.best.name}, objective ${result.best.metrics.objective}, win ${Math.round(result.best.metrics.winRate * 100)}%, rank ${result.best.metrics.averageRank}, fall ${Math.round(result.best.metrics.fallRate * 100)}%`,
    'Generation winners:',
    ...result.generations.map((entry) => (
      `- g${entry.generation}: ${entry.best.name}, objective ${entry.best.metrics.objective}, win ${Math.round(entry.best.metrics.winRate * 100)}%, rank ${entry.best.metrics.averageRank}`
    )),
    'Best compact weights:',
    JSON.stringify(result.best.compactWeights, null, 2),
  ];
  if (result.saved) {
    lines.push(`Saved opponent: ${result.saved.opponent.firstName} (${result.saved.opponent.id})`);
    lines.push(`Saved to: ${result.saved.path}`);
  }
  return lines.join('\n');
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.json && !options.quiet) options.onProgress = createCliProgressLogger();
  const result = trainStrategyWeights(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatTrainingReport(result));
}
