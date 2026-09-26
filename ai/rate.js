// ai/rate.js - rates the trained roster against itself and decides which AIs
// players are offered.
//
// Every AI keeps its place in training, weak ones included: they are the
// opponents that tell a better AI from a worse one. But players only meet
// the AIs that hold their own at the table: a weak AI is weak for a reason.
//
//   npm run rate:ai -- [--games 480] [--seed 1] [--workers 4] [--no-save] [--json]
//
// Each AI plays an equal share of seats on both maps, at 4 and 5 dynasties
// and 6, 9 or 12 rounds, against the rest of the roster. Its strength is its
// wins over the fair share it would get by chance (1 / dynasties per game),
// relative to the roster's average: 1 is an average AI. A fallen empire is a
// loss for everyone, as in training.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRng } from '../engine/state.js';
import { defaultSimulationWorkers, simulateGameSpecsParallel } from './simulate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROSTER_PATH = resolve(__dirname, 'tunedOpponents.json');

// Relative strength at which an AI is "strong", and under which players are
// not offered it.
export const STRONG_TIER_MIN = 1.15;
export const OFFERED_MIN = 0.8;
// Players always have enough AIs to fill a 5-dynasty table without repeats.
export const MIN_OFFERED = 4;

const DEFAULT_OPTIONS = Object.freeze({
  games: 480,
  seed: 1,
  maps: ['classic', 'compact'],
  playerCounts: [4, 5],
  deckSizes: [6, 9, 12],
  workers: defaultSimulationWorkers(),
  rosterPath: DEFAULT_ROSTER_PATH,
  save: true,
});

function shuffle(list, rng) {
  const copy = list.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

// Tables where every AI sits about as often as every other, never twice at
// one table, on every map, table size and game length in turn.
export function buildRatingTables(opponents, options) {
  const rng = makeRng(options.seed);
  const specs = [];
  let bag = [];
  for (let index = 0; index < options.games; index += 1) {
    const playerCount = options.playerCounts[index % options.playerCounts.length];
    const deckSize = options.deckSizes[Math.floor(index / options.playerCounts.length) % options.deckSizes.length];
    const mapId = options.maps[index % options.maps.length];
    const seats = [];
    while (seats.length < playerCount) {
      if (!bag.length) bag = shuffle(opponents, rng);
      const next = bag.findIndex((entry) => !seats.includes(entry));
      if (next < 0) {
        bag = shuffle(opponents, rng);
        continue;
      }
      seats.push(bag.splice(next, 1)[0]);
    }
    specs.push({
      games: 1,
      playerCount,
      deckSize,
      mapId,
      seed: options.seed * 100_000 + index,
      historyEnabled: false,
      samples: 0,
      policies: seats,
    });
  }
  return specs;
}

// Wins over the fair share, per AI and per map, from played games.
export function summarizeRatingGames(opponents, specs, games) {
  const byId = Object.fromEntries(opponents.map((opponent) => [opponent.id, {
    games: 0, wins: 0, fairShare: 0, maps: {},
  }]));
  games.forEach((game, index) => {
    const spec = specs[index];
    const winners = game.fall ? [] : game.winnerIds || [];
    for (const [seat, label] of Object.entries(game.seatLabels || {})) {
      const entry = byId[label];
      if (!entry) continue;
      const won = winners.includes(Number(seat)) ? 1 / winners.length : 0;
      const fair = 1 / spec.playerCount;
      const map = entry.maps[spec.mapId] || (entry.maps[spec.mapId] = { games: 0, wins: 0, fairShare: 0 });
      for (const bucket of [entry, map]) {
        bucket.games += 1;
        bucket.wins += won;
        bucket.fairShare += fair;
      }
    }
  });
  const ratio = (bucket) => (bucket.fairShare > 0 ? bucket.wins / bucket.fairShare : 0);
  const ratios = Object.values(byId).map(ratio);
  const average = ratios.reduce((total, value) => total + value, 0) / Math.max(1, ratios.length) || 1;
  const ratings = Object.fromEntries(Object.entries(byId).map(([id, entry]) => [id, {
    strength: Math.round((ratio(entry) / average) * 100) / 100,
    games: entry.games,
    winRate: Math.round((entry.wins / Math.max(1, entry.games)) * 1000) / 1000,
    maps: Object.fromEntries(Object.entries(entry.maps).map(([mapId, map]) => [mapId, {
      games: map.games,
      winRate: Math.round((map.wins / Math.max(1, map.games)) * 1000) / 1000,
      strength: Math.round((ratio(map) / average) * 100) / 100,
    }])),
  }]));
  return assignTiers(ratings);
}

// Strong, average or weak; weak AIs are not offered to players, unless too
// few would be left to fill a table.
export function assignTiers(ratings) {
  const ranked = Object.entries(ratings).sort((left, right) => right[1].strength - left[1].strength);
  ranked.forEach(([, rating], index) => {
    rating.tier = rating.strength >= STRONG_TIER_MIN ? 'strong' : rating.strength >= OFFERED_MIN ? 'average' : 'weak';
    rating.offered = rating.tier !== 'weak' || index < MIN_OFFERED;
  });
  return ratings;
}

export async function rateRoster(rawOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...rawOptions };
  const payload = JSON.parse(readFileSync(options.rosterPath, 'utf8'));
  const opponents = payload.opponents || [];
  if (opponents.length < 5) throw new Error('The roster needs at least 5 trained AIs to be rated.');
  const specs = buildRatingTables(opponents, options);
  const games = await simulateGameSpecsParallel(specs, { workers: options.workers });
  const ratings = summarizeRatingGames(opponents, specs, games);
  const ratedAt = new Date().toISOString();
  for (const opponent of opponents) {
    const { offered, ...rating } = ratings[opponent.id];
    opponent.rating = { ...rating, ratedAt };
    opponent.offered = offered;
  }
  payload.rating = {
    ratedAt,
    games: options.games,
    seed: options.seed,
    maps: options.maps,
    playerCounts: options.playerCounts,
    deckSizes: options.deckSizes,
    strongTierMin: STRONG_TIER_MIN,
    offeredMin: OFFERED_MIN,
  };
  if (options.save) writeFileSync(options.rosterPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { ratings, payload };
}

function formatReport(ratings) {
  const rows = Object.entries(ratings).sort((left, right) => right[1].strength - left[1].strength);
  const lines = ['AI                         strength  tier     offered  win classic / compact'];
  for (const [id, rating] of rows) {
    const map = (mapId) => `${Math.round((rating.maps[mapId]?.winRate || 0) * 100)}%`;
    lines.push(`${id.padEnd(26)} ${rating.strength.toFixed(2).padStart(8)}  ${rating.tier.padEnd(8)} ${rating.offered ? 'yes' : 'no '}      ${map('classic')} / ${map('compact')}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-save') options.save = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--games') options.games = Number(argv[++index]);
    else if (arg === '--seed') options.seed = Number(argv[++index]);
    else if (arg === '--workers') options.workers = Number(argv[++index]);
    else if (arg === '--roster') options.rosterPath = resolve(argv[++index]);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const { ratings } = await rateRoster(options);
  console.log(options.json ? JSON.stringify(ratings, null, 2) : formatReport(ratings));
}
