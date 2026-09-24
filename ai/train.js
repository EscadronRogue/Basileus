// ai/train.js - trains one AI dynasty per personality by playing full games.
//
// The only thing training rewards is the result of the game: winning, and to
// a lesser degree finishing high. A fallen empire is a loss for every
// dynasty, exactly as in the rules. Nothing rewards prudence or duty for its
// own sake: an AI that lets others defend while it takes the throne is doing
// its job if that wins games, and one that over-defends is punished by the
// free-riders it plays against.
//
// Each personality (ai/personalities.js) keeps a champion. Every generation
// the champion and a handful of mutants play the same seeded tables (common
// random numbers, so luck mostly cancels out), the best mutants replay a
// second set of tables, and a mutant replaces the champion only when it did
// better on both. Opponents come from a league of the current champions of
// every personality plus built-in exploiters and baselines.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { makeRng } from '../engine/state.js';
import { createSimulationPool, defaultSimulationWorkers, simulateGame } from './simulate.js';
import { DEFAULT_STRATEGY_WEIGHTS } from './strategy.js';
import { POLICY_WEIGHT_PRESETS } from './policies.js';
import { pickUniqueGreekFirstName, slugifyGreekFirstName } from './greekNames.js';
import { normalizeTunedOpponentRoster } from './opponentRoster.js';
import {
  PERSONALITY_IDS,
  TRAINABLE_WEIGHT_KEYS,
  clampToPersonality,
  getPersonality,
  personalityWeightRange,
} from './personalities.js';

export const TRAINING_OBJECTIVE_VERSION = 8;
// Finishing order is worth a little, so a near-win beats last place, but a
// win is always worth several second places.
export const PLACEMENT_WEIGHT = 0.25;

// Built-in opponents the league draws from besides the personality
// champions. Free-riders and greedy players punish over-defending; the
// usurper and tyrant punish leaving the capital empty.
export const DEFAULT_LEAGUE_PRESETS = Object.freeze([
  'strategic',
  'freeRider',
  'greedy',
  'usurper',
  'tyrant',
  'profiteer',
  'kingmaker',
  'patron',
  'estateShark',
  'antiLeader',
  'defender',
]);

const DEFAULT_OPTIONS = Object.freeze({
  personalities: PERSONALITY_IDS,
  generations: 6,
  offspring: 6,
  finalists: 2,
  screeningGames: 36,
  confirmGames: 72,
  finalGames: 160,
  benchmarkGames: 60,
  playerCounts: [4, 5, 5],
  deckSizes: [9],
  mutation: 0.2,
  mutationRate: 0.35,
  championShare: 0.6,
  league: DEFAULT_LEAGUE_PRESETS,
  maxSteps: 500,
  seed: null,
  workers: null,
  save: true,
  outputPath: fileURLToPath(new URL('./tunedOpponents.json', import.meta.url)),
});

const MIN_SIGMA = 0.05;
const MAX_SIGMA = 0.45;

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toList(value, fallback) {
  if (Array.isArray(value)) return value.length ? value : fallback;
  if (value == null || value === '') return fallback;
  const list = String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

function toIntList(value, fallback, min, max) {
  const list = toList(value, fallback).flatMap((entry) => {
    const text = String(entry);
    const range = text.match(/^(\d+)-(\d+)$/);
    if (!range) return [toInt(text, NaN)];
    const values = [];
    for (let next = Number(range[1]); next <= Number(range[2]); next += 1) values.push(next);
    return values;
  }).filter((entry) => Number.isFinite(entry) && entry >= min && entry <= max);
  return list.length ? list : fallback;
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function randomTrainingSeed() {
  return randomBytes(4).readUInt32BE(0);
}

function gaussian(rng) {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

export function normalizeTrainingOptions(rawOptions = {}) {
  const personalities = toList(rawOptions.personalities, DEFAULT_OPTIONS.personalities)
    .filter((id) => getPersonality(id));
  if (!personalities.length) throw new Error('No known personalities to train.');
  const league = toList(rawOptions.league, DEFAULT_OPTIONS.league)
    .filter((id) => Object.hasOwn(POLICY_WEIGHT_PRESETS, id));
  return {
    personalities,
    generations: Math.max(0, toInt(rawOptions.generations, DEFAULT_OPTIONS.generations)),
    offspring: Math.max(1, toInt(rawOptions.offspring, DEFAULT_OPTIONS.offspring)),
    finalists: Math.max(1, toInt(rawOptions.finalists, DEFAULT_OPTIONS.finalists)),
    screeningGames: Math.max(1, toInt(rawOptions.screeningGames, DEFAULT_OPTIONS.screeningGames)),
    confirmGames: Math.max(1, toInt(rawOptions.confirmGames, DEFAULT_OPTIONS.confirmGames)),
    finalGames: Math.max(1, toInt(rawOptions.finalGames, DEFAULT_OPTIONS.finalGames)),
    benchmarkGames: Math.max(0, toInt(rawOptions.benchmarkGames, DEFAULT_OPTIONS.benchmarkGames)),
    playerCounts: toIntList(rawOptions.playerCounts, DEFAULT_OPTIONS.playerCounts, 3, 5),
    deckSizes: toIntList(rawOptions.deckSizes, DEFAULT_OPTIONS.deckSizes, 1, 9),
    mutation: Math.min(MAX_SIGMA, Math.max(MIN_SIGMA, toFloat(rawOptions.mutation, DEFAULT_OPTIONS.mutation))),
    mutationRate: Math.min(1, Math.max(0.05, toFloat(rawOptions.mutationRate, DEFAULT_OPTIONS.mutationRate))),
    championShare: Math.min(1, Math.max(0, toFloat(rawOptions.championShare, DEFAULT_OPTIONS.championShare))),
    league: league.length ? league : ['strategic'],
    maxSteps: Math.max(50, toInt(rawOptions.maxSteps, DEFAULT_OPTIONS.maxSteps)),
    seed: rawOptions.seed == null || rawOptions.seed === '' ? randomTrainingSeed() : toInt(rawOptions.seed, 1),
    workers: Math.max(1, toInt(rawOptions.workers, defaultSimulationWorkers())),
    save: rawOptions.save !== false,
    outputPath: rawOptions.outputPath || DEFAULT_OPTIONS.outputPath,
    onProgress: typeof rawOptions.onProgress === 'function' ? rawOptions.onProgress : null,
  };
}

// ---------------------------------------------------------------------------
// Outcomes and behaviour

// What one game was worth to the dynasty in `seat`: 1 for an outright win
// (shared on a tie), plus PLACEMENT_WEIGHT times its finishing position
// (1 for first, 0 for last). A fallen empire, or a game that did not finish,
// is worth 0 to everyone.
export function scoreSeatOutcome(game, seat) {
  if (!game || game.fall || game.reason !== 'complete') {
    return { win: 0, placement: 0, value: 0, fall: Boolean(game?.fall) };
  }
  const scores = Array.isArray(game.finalScores) ? game.finalScores : [];
  const mine = scores.find((entry) => entry.playerId === seat);
  const winners = Array.isArray(game.winnerIds) ? game.winnerIds : [];
  const win = winners.includes(seat) ? 1 / winners.length : 0;
  let placement = 0;
  if (mine && scores.length > 1) {
    const points = Number(mine.points) || 0;
    const better = scores.filter((entry) => (Number(entry.points) || 0) > points).length;
    const tied = scores.filter((entry) => entry !== mine && (Number(entry.points) || 0) === points).length;
    const rank = better + tied / 2;
    placement = 1 - rank / (scores.length - 1);
  }
  return { win, placement, value: win + PLACEMENT_WEIGHT * placement, fall: false };
}

// How the dynasty in `seat` played: counts that tell personalities apart.
export function summarizeSeatBehavior(game, seat) {
  const stats = game?.playerStatsByPlayer?.[String(seat)] || {};
  const behavior = game?.behaviorByPlayer?.[seat] || game?.behaviorByPlayer?.[String(seat)] || {};
  return {
    orders: Number(stats.orders) || 0,
    lowFrontierOrders: Number(stats.lowFrontierOrders) || 0,
    burnedWhileHoldingBack: Number(stats.burnedWhileHoldingBack) || 0,
    capitalBids: Number(stats.capitalBids) || 0,
    throneWins: Number(stats.throneWins) || 0,
    throneRounds: Number(stats.throneRounds) || 0,
    frontierTroops: Number(stats.frontierTroops) || 0,
    capitalTroops: Number(stats.capitalTroops) || 0,
    estatesBought: Number(behavior.estatesBought) || 0,
    revocations: Number(behavior.revocations) || 0,
    appointmentsToOthers: Number(behavior.appointmentsToOthers) || 0,
    appointmentsToSelf: Number(behavior.appointmentsToSelf) || 0,
  };
}

export function createEvaluation() {
  return {
    games: 0,
    value: 0,
    wins: 0,
    placement: 0,
    falls: 0,
    orders: 0,
    lowFrontierOrders: 0,
    burnedWhileHoldingBack: 0,
    capitalBids: 0,
    throneWins: 0,
    throneRounds: 0,
    frontierTroops: 0,
    capitalTroops: 0,
    estatesBought: 0,
    revocations: 0,
    appointmentsToOthers: 0,
    appointmentsToSelf: 0,
  };
}

export function addGameToEvaluation(evaluation, game, seat) {
  const outcome = scoreSeatOutcome(game, seat);
  const behavior = summarizeSeatBehavior(game, seat);
  evaluation.games += 1;
  evaluation.value += outcome.value;
  evaluation.wins += outcome.win;
  evaluation.placement += outcome.placement;
  if (outcome.fall) evaluation.falls += 1;
  for (const [key, value] of Object.entries(behavior)) evaluation[key] += value;
  return evaluation;
}

export function mergeEvaluations(...evaluations) {
  const merged = createEvaluation();
  for (const evaluation of evaluations) {
    if (!evaluation) continue;
    for (const key of Object.keys(merged)) merged[key] += Number(evaluation[key]) || 0;
  }
  return merged;
}

// Rates a person can read: how often it wins, and how it plays.
export function describeEvaluation(evaluation) {
  const games = Math.max(1, evaluation.games);
  const orders = Math.max(1, evaluation.orders);
  return {
    games: evaluation.games,
    value: round(evaluation.value / games),
    winRate: round(evaluation.wins / games),
    placement: round(evaluation.placement / games),
    fallRate: round(evaluation.falls / games),
    holdBackRate: round(evaluation.lowFrontierOrders / orders),
    burnedWhileHoldingBackRate: round(evaluation.burnedWhileHoldingBack / orders),
    capitalBidRate: round(evaluation.capitalBids / orders),
    throneSeizuresPerGame: round(evaluation.throneWins / games, 2),
    reignShare: round(evaluation.throneRounds / orders),
    frontierTroopsPerOrder: round(evaluation.frontierTroops / orders, 2),
    capitalTroopsPerOrder: round(evaluation.capitalTroops / orders, 2),
    estatesPerGame: round(evaluation.estatesBought / games, 2),
    revocationsPerGame: round(evaluation.revocations / games, 2),
    appointmentsToOthersPerGame: round(evaluation.appointmentsToOthers / games, 2),
    // Share of its appointments that went to other dynasties.
    generosity: round(evaluation.appointmentsToOthers
      / Math.max(1, evaluation.appointmentsToOthers + evaluation.appointmentsToSelf)),
  };
}

// ---------------------------------------------------------------------------
// Weights

export function personalitySeedWeights(personalityId) {
  const personality = getPersonality(personalityId);
  if (!personality) throw new Error(`Unknown personality "${personalityId}".`);
  const weights = {
    ...DEFAULT_STRATEGY_WEIGHTS,
    ...(POLICY_WEIGHT_PRESETS[personality.basePolicy] || {}),
  };
  // Start from the bidding pressure the preset's valuation implies.
  return clampToPersonality(personality, weights);
}

// Moves a random subset of weights by a Gaussian step scaled to each
// weight's allowed range, then clamps back into the personality.
export function mutatePersonalityWeights(personalityId, weights, rng, sigma, rate = DEFAULT_OPTIONS.mutationRate) {
  const personality = getPersonality(personalityId);
  const next = { ...weights };
  let changed = 0;
  for (const key of TRAINABLE_WEIGHT_KEYS) {
    if (rng() >= rate) continue;
    const [min, max] = personalityWeightRange(personality, key);
    if (max <= min) continue;
    next[key] = Number(next[key]) + gaussian(rng) * sigma * (max - min);
    changed += 1;
  }
  if (!changed) {
    const key = pick(rng, TRAINABLE_WEIGHT_KEYS);
    const [min, max] = personalityWeightRange(personality, key);
    next[key] = Number(next[key]) + gaussian(rng) * sigma * (max - min);
  }
  return clampToPersonality(personality, next);
}

function compactWeights(weights) {
  return Object.fromEntries(TRAINABLE_WEIGHT_KEYS.map((key) => [key, round(weights[key], 4)]));
}

function weightsSignature(weights) {
  return TRAINABLE_WEIGHT_KEYS.map((key) => round(weights[key], 3)).join('|');
}

// ---------------------------------------------------------------------------
// League and scenarios

function tunedPolicy(id, label, weights) {
  return {
    id,
    firstName: label,
    policy: { policyId: 'tuned', strategyWeights: weights },
    strategyWeights: weights,
  };
}

// One table: its seed and size, the seat the evaluated AI sits in, and who
// fills the other seats. The same scenario is replayed for every candidate.
export function buildScenarios(rng, count, options) {
  const scenarios = [];
  for (let index = 0; index < count; index += 1) {
    const playerCount = pick(rng, options.playerCounts);
    const opponents = [];
    for (let seat = 0; seat < playerCount - 1; seat += 1) {
      opponents.push(rng() < options.championShare
        ? { champion: pick(rng, options.personalities) }
        : { preset: pick(rng, options.league) });
    }
    scenarios.push({
      seed: Math.floor(rng() * 2 ** 31),
      playerCount,
      deckSize: pick(rng, options.deckSizes),
      seat: index % playerCount,
      opponents,
    });
  }
  return scenarios;
}

function resolveOpponent(entry, league) {
  if (entry.preset) return entry.preset;
  const champion = league[entry.champion];
  return tunedPolicy(`league-${entry.champion}`, entry.champion, champion);
}

function buildSpec(scenario, candidatePolicy, league, options) {
  const policies = [];
  let next = 0;
  for (let seat = 0; seat < scenario.playerCount; seat += 1) {
    policies.push(seat === scenario.seat ? candidatePolicy : resolveOpponent(scenario.opponents[next++], league));
  }
  return {
    seed: scenario.seed,
    playerCount: scenario.playerCount,
    deckSize: scenario.deckSize,
    policies,
    allowUntunedPolicies: true,
    historyEnabled: false,
    samples: 0,
    maxSteps: options.maxSteps,
  };
}

function createRunner(workers) {
  if (workers <= 1) {
    return {
      run: async (specs) => specs.map((spec) => simulateGame(spec, 0)),
      close: async () => {},
    };
  }
  return createSimulationPool({ workers });
}

// Plays every candidate on every scenario and returns one evaluation per
// candidate, in order. Candidates are { id, personalityId, weights }.
async function evaluateCandidates(runner, candidates, scenarios, league, options) {
  const specs = [];
  for (const candidate of candidates) {
    const policy = tunedPolicy(candidate.id, candidate.personalityId, candidate.weights);
    for (const scenario of scenarios) specs.push(buildSpec(scenario, policy, league, options));
  }
  const games = await runner.run(specs);
  return candidates.map((candidate, candidateIndex) => {
    const evaluation = createEvaluation();
    scenarios.forEach((scenario, scenarioIndex) => {
      addGameToEvaluation(evaluation, games[candidateIndex * scenarios.length + scenarioIndex], scenario.seat);
    });
    return evaluation;
  });
}

// ---------------------------------------------------------------------------
// Training loop

function emit(options, event) {
  options.onProgress?.({ ...event, elapsedMs: Date.now() - options.startedAt });
}

function leagueSnapshot(lines) {
  return Object.fromEntries(Object.entries(lines).map(([id, line]) => [id, line.champion.weights]));
}

function meanValue(evaluation) {
  return evaluation.games ? evaluation.value / evaluation.games : 0;
}

async function runGeneration(runner, lines, generation, rng, options) {
  const league = leagueSnapshot(lines);
  const personalities = Object.keys(lines);

  const screening = buildScenarios(rng, options.screeningGames, options);
  const pools = personalities.map((personalityId) => {
    const line = lines[personalityId];
    const candidates = [{ id: `${personalityId}-champion`, personalityId, weights: line.champion.weights, champion: true }];
    for (let index = 0; index < options.offspring; index += 1) {
      candidates.push({
        id: `${personalityId}-g${generation}-m${index + 1}`,
        personalityId,
        weights: mutatePersonalityWeights(personalityId, line.champion.weights, rng, line.sigma, options.mutationRate),
      });
    }
    return candidates;
  });
  const screened = await evaluateCandidates(runner, pools.flat(), screening, league, options);
  let cursor = 0;
  for (const candidates of pools) {
    for (const candidate of candidates) candidate.screening = screened[cursor++];
  }

  const confirm = buildScenarios(rng, options.confirmGames, options);
  const confirmPools = pools.map((candidates) => [
    candidates[0],
    ...candidates.slice(1)
      .sort((left, right) => meanValue(right.screening) - meanValue(left.screening))
      .slice(0, options.finalists),
  ]);
  const confirmed = await evaluateCandidates(runner, confirmPools.flat(), confirm, league, options);
  cursor = 0;
  for (const candidates of confirmPools) {
    for (const candidate of candidates) candidate.confirm = confirmed[cursor++];
  }

  const summary = {};
  personalities.forEach((personalityId, index) => {
    const line = lines[personalityId];
    const [champion, ...challengers] = confirmPools[index];
    const championScreen = meanValue(champion.screening);
    const championConfirm = meanValue(champion.confirm);
    const championTotal = mergeEvaluations(champion.screening, champion.confirm);
    // A mutant must beat the champion on both sets of tables.
    const winner = challengers
      .filter((candidate) => meanValue(candidate.screening) > championScreen && meanValue(candidate.confirm) > championConfirm)
      .sort((left, right) => meanValue(mergeEvaluations(right.screening, right.confirm))
        - meanValue(mergeEvaluations(left.screening, left.confirm)))[0] || null;
    for (const candidate of confirmPools[index]) {
      line.archive.push({
        weights: candidate.weights,
        generation,
        value: meanValue(mergeEvaluations(candidate.screening, candidate.confirm)),
      });
    }
    if (winner) {
      line.champion = { weights: winner.weights, generation };
      line.sigma = Math.min(MAX_SIGMA, line.sigma * 1.2);
    } else {
      line.sigma = Math.max(MIN_SIGMA, line.sigma * 0.8);
    }
    summary[personalityId] = {
      replaced: Boolean(winner),
      championValue: round(meanValue(championTotal)),
      bestChallengerValue: round(Math.max(...challengers.map((candidate) => meanValue(mergeEvaluations(candidate.screening, candidate.confirm))))),
      winnerValue: winner ? round(meanValue(mergeEvaluations(winner.screening, winner.confirm))) : null,
      sigma: round(line.sigma),
      champion: describeEvaluation(championTotal),
    };
  });
  return summary;
}

// Replays the current champion and the best archived versions of each
// personality on one large set of fresh tables and keeps the best.
async function runFinals(runner, lines, rng, options) {
  const league = leagueSnapshot(lines);
  const scenarios = buildScenarios(rng, options.finalGames, options);
  const pools = Object.entries(lines).map(([personalityId, line]) => {
    const seen = new Set([weightsSignature(line.champion.weights)]);
    const contenders = [{ id: `${personalityId}-final-champion`, personalityId, weights: line.champion.weights }];
    for (const entry of [...line.archive].sort((left, right) => right.value - left.value)) {
      if (contenders.length >= 3) break;
      const signature = weightsSignature(entry.weights);
      if (seen.has(signature)) continue;
      seen.add(signature);
      contenders.push({ id: `${personalityId}-final-${contenders.length}`, personalityId, weights: entry.weights });
    }
    return contenders;
  });
  const evaluations = await evaluateCandidates(runner, pools.flat(), scenarios, league, options);
  let cursor = 0;
  const finals = {};
  for (const contenders of pools) {
    for (const contender of contenders) contender.evaluation = evaluations[cursor++];
    const best = [...contenders].sort((left, right) => meanValue(right.evaluation) - meanValue(left.evaluation))[0];
    finals[best.personalityId] = {
      personalityId: best.personalityId,
      weights: best.weights,
      evaluation: best.evaluation,
      metrics: describeEvaluation(best.evaluation),
      contenders: contenders.map((contender) => round(meanValue(contender.evaluation))),
    };
  }
  return finals;
}

// Each new champion against tables of fixed opponents: the default planner,
// and the roster that was saved before this run.
async function runBenchmarks(runner, finals, previousRoster, rng, options) {
  if (!options.benchmarkGames) return null;
  const opponentSets = [{ id: 'strategic', label: 'default planner', opponents: ['strategic'] }];
  if (previousRoster.length) {
    opponentSets.push({
      id: 'previous',
      label: 'previous roster',
      opponents: previousRoster.map((entry) => tunedPolicy(entry.id, entry.firstName, entry.strategyWeights)),
    });
  }
  const benchmark = {};
  for (const set of opponentSets) {
    const scenarios = [];
    for (let index = 0; index < options.benchmarkGames; index += 1) {
      const playerCount = pick(rng, options.playerCounts);
      scenarios.push({
        seed: Math.floor(rng() * 2 ** 31),
        playerCount,
        deckSize: pick(rng, options.deckSizes),
        seat: index % playerCount,
        opponents: Array.from({ length: playerCount - 1 }, () => pick(rng, set.opponents)),
      });
    }
    const specsFor = (candidatePolicy) => scenarios.map((scenario) => {
      const policies = [];
      let next = 0;
      for (let seat = 0; seat < scenario.playerCount; seat += 1) {
        policies.push(seat === scenario.seat ? candidatePolicy : scenario.opponents[next++]);
      }
      return { ...buildSpec(scenario, candidatePolicy, {}, options), policies };
    });
    const entries = Object.values(finals);
    const specs = entries.flatMap((entry) => specsFor(tunedPolicy(`bench-${entry.personalityId}`, entry.personalityId, entry.weights)));
    const games = await runner.run(specs);
    benchmark[set.id] = { label: set.label, games: options.benchmarkGames, byPersonality: {} };
    entries.forEach((entry, entryIndex) => {
      const evaluation = createEvaluation();
      scenarios.forEach((scenario, index) => addGameToEvaluation(evaluation, games[entryIndex * scenarios.length + index], scenario.seat));
      benchmark[set.id].byPersonality[entry.personalityId] = describeEvaluation(evaluation);
    });
  }
  return benchmark;
}

function readSavedRoster(path) {
  try {
    return normalizeTunedOpponentRoster(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return [];
  }
}

function buildRosterPayload(result) {
  const usedNames = [];
  const trainedAt = new Date().toISOString();
  const opponents = result.options.personalities.map((personalityId, index) => {
    const final = result.finals[personalityId];
    const personality = getPersonality(personalityId);
    const firstName = pickUniqueGreekFirstName(`${result.options.seed}:${personalityId}:${index}`, usedNames);
    usedNames.push(firstName);
    const weights = compactWeights(final.weights);
    return {
      id: `${personalityId}-${slugifyGreekFirstName(firstName)}`,
      firstName,
      personality: personalityId,
      label: personality.title,
      description: personality.summary,
      policy: { policyId: 'tuned', strategyWeights: weights },
      strategyWeights: weights,
      metrics: final.metrics,
      training: {
        trainedAt,
        objectiveVersion: TRAINING_OBJECTIVE_VERSION,
        generations: result.options.generations,
        seed: result.options.seed,
        playerCounts: result.options.playerCounts,
        deckSizes: result.options.deckSizes,
        finalGames: result.options.finalGames,
      },
    };
  });
  return {
    version: 2,
    updatedAt: trainedAt,
    objective: 'Win share plus a quarter of finishing position; a fallen empire is a loss for everyone.',
    benchmark: result.benchmark,
    opponents,
  };
}

export async function trainPersonalities(rawOptions = {}) {
  const options = { ...normalizeTrainingOptions(rawOptions), startedAt: Date.now() };
  const rng = makeRng(options.seed);
  const previousRoster = readSavedRoster(options.outputPath);
  const lines = Object.fromEntries(options.personalities.map((personalityId) => [personalityId, {
    champion: { weights: personalitySeedWeights(personalityId), generation: 0 },
    sigma: options.mutation,
    archive: [],
  }]));
  const runner = createRunner(options.workers);
  const generations = [];
  emit(options, {
    type: 'training-start',
    personalities: options.personalities,
    generations: options.generations,
    gamesPerGeneration: options.personalities.length
      * ((options.offspring + 1) * options.screeningGames + (options.finalists + 1) * options.confirmGames),
    seed: options.seed,
    workers: options.workers,
  });
  try {
    for (let generation = 1; generation <= options.generations; generation += 1) {
      const summary = await runGeneration(runner, lines, generation, rng, options);
      generations.push({ generation, personalities: summary });
      emit(options, { type: 'generation-end', generation, generations: options.generations, summary });
    }
    const finals = await runFinals(runner, lines, rng, options);
    emit(options, { type: 'finals-end', finals });
    const benchmark = await runBenchmarks(runner, finals, previousRoster, rng, options);
    const result = {
      options: { ...options, onProgress: undefined },
      generations,
      finals,
      benchmark,
    };
    if (options.save) {
      const payload = buildRosterPayload(result);
      writeFileSync(options.outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      result.saved = { path: options.outputPath, opponents: payload.opponents.map((entry) => entry.id) };
      emit(options, { type: 'saved', path: options.outputPath, count: payload.opponents.length });
    }
    return result;
  } finally {
    await runner.close();
  }
}

// Plays each listed opponent in `seat`-rotating tables against a league and
// reports outcomes and behaviour, without training anything.
export async function profileOpponents(entries, rawOptions = {}) {
  const options = { ...normalizeTrainingOptions(rawOptions), startedAt: Date.now() };
  const rng = makeRng(options.seed);
  const league = Object.fromEntries(options.personalities.map((id) => [id, personalitySeedWeights(id)]));
  for (const entry of entries) {
    if (entry.personalityId && league[entry.personalityId] && entry.useAsLeague) league[entry.personalityId] = entry.weights;
  }
  const runner = createRunner(options.workers);
  try {
    const scenarios = buildScenarios(rng, options.finalGames, options);
    const evaluations = await evaluateCandidates(runner, entries, scenarios, league, options);
    return entries.map((entry, index) => ({ id: entry.id, ...describeEvaluation(evaluations[index]) }));
  } finally {
    await runner.close();
  }
}

// ---------------------------------------------------------------------------
// Command line

function parseArgs(argv) {
  const options = {};
  const flags = {
    generations: 'generations',
    offspring: 'offspring',
    finalists: 'finalists',
    'screening-games': 'screeningGames',
    'confirm-games': 'confirmGames',
    'final-games': 'finalGames',
    'benchmark-games': 'benchmarkGames',
    players: 'playerCounts',
    'player-counts': 'playerCounts',
    decks: 'deckSizes',
    deck: 'deckSizes',
    mutation: 'mutation',
    'mutation-rate': 'mutationRate',
    'champion-share': 'championShare',
    personalities: 'personalities',
    league: 'league',
    seed: 'seed',
    workers: 'workers',
    output: 'outputPath',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'json') options.json = true;
    else if (key === 'no-save') options.save = false;
    else if (key === 'quiet') options.quiet = true;
    else if (flags[key]) {
      const value = argv[index + 1];
      index += 1;
      options[flags[key]] = key === 'output' ? resolve(String(value)) : value;
    }
  }
  return options;
}

function percent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function minutes(ms) {
  return `${round((Number(ms) || 0) / 60000, 1)}m`;
}

export function formatBehavior(metrics) {
  return [
    `win ${percent(metrics.winRate)}`,
    `value ${metrics.value}`,
    `fall ${percent(metrics.fallRate)}`,
    `holds back ${percent(metrics.holdBackRate)}`,
    `burns ${percent(metrics.burnedWhileHoldingBackRate)}`,
    `throne bids ${percent(metrics.capitalBidRate)}`,
    `seizures ${metrics.throneSeizuresPerGame}/game`,
    `reigns ${percent(metrics.reignShare)}`,
    `estates ${metrics.estatesPerGame}/game`,
    `revokes ${metrics.revocationsPerGame}/game`,
    `gives ${percent(metrics.generosity)} of offices away`,
  ].join(', ');
}

function createCliProgressLogger() {
  return (event) => {
    const stamp = `[train ${minutes(event.elapsedMs)}]`;
    if (event.type === 'training-start') {
      console.log(`${stamp} ${event.personalities.join(', ')}: ${event.generations} generations of about ${event.gamesPerGeneration} games, seed ${event.seed}, ${event.workers} workers.`);
    } else if (event.type === 'generation-end') {
      console.log(`${stamp} Generation ${event.generation}/${event.generations}`);
      for (const [personalityId, entry] of Object.entries(event.summary)) {
        const change = entry.replaced ? `new champion ${entry.winnerValue}` : `champion kept (best challenger ${entry.bestChallengerValue})`;
        console.log(`  ${personalityId}: champion ${entry.championValue}, ${change}, sigma ${entry.sigma}; ${formatBehavior(entry.champion)}`);
      }
    } else if (event.type === 'finals-end') {
      console.log(`${stamp} Finals`);
      for (const entry of Object.values(event.finals)) {
        console.log(`  ${entry.personalityId}: contenders ${entry.contenders.join(' / ')}; ${formatBehavior(entry.metrics)}`);
      }
    } else if (event.type === 'saved') {
      console.log(`${stamp} Saved ${event.count} opponents to ${event.path}.`);
    }
  };
}

function formatTrainingReport(result) {
  const lines = ['Trained personalities:'];
  for (const entry of Object.values(result.finals)) {
    lines.push(`- ${entry.personalityId}: ${formatBehavior(entry.metrics)}`);
  }
  for (const set of Object.values(result.benchmark || {})) {
    lines.push(`Against the ${set.label} (${set.games} games each):`);
    for (const [personalityId, metrics] of Object.entries(set.byPersonality)) {
      lines.push(`- ${personalityId}: win ${percent(metrics.winRate)}, fall ${percent(metrics.fallRate)}`);
    }
  }
  if (result.saved) lines.push(`Saved to ${result.saved.path}: ${result.saved.opponents.join(', ')}`);
  return lines.join('\n');
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.json && !options.quiet) options.onProgress = createCliProgressLogger();
  const result = await trainPersonalities(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatTrainingReport(result));
}
