import { DEFAULT_MAP_ID, normalizeMapId } from '../data/maps/index.js';

export const PLAYER_COUNT_MIN = 3;
export const PLAYER_COUNT_MAX = 5;
export const DEFAULT_PLAYER_COUNT = 5;
export const DEFAULT_TURN_COUNT = 9;
export const DEFAULT_DECK_SIZE = DEFAULT_TURN_COUNT;

export const DEFAULT_ROOM_CONFIG = {
  playerCount: DEFAULT_PLAYER_COUNT,
  turnCount: DEFAULT_TURN_COUNT,
  deckSize: DEFAULT_TURN_COUNT,
  mapId: DEFAULT_MAP_ID,
  seed: '',
};

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function hashSeedInput(seedInput) {
  let seed = 0;
  const text = String(seedInput || '');
  for (let index = 0; index < text.length; index += 1) {
    seed = ((seed << 5) - seed + text.charCodeAt(index)) | 0;
  }
  return seed;
}

export function resolveConfiguredSeed(rawSeed) {
  const text = String(rawSeed || '').trim();
  return text ? hashSeedInput(text) : Date.now();
}

export function makeChoiceRng(seed = Date.now()) {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function pickRandom(rng, values, fallback = null) {
  if (!values.length) return fallback;
  return values[Math.floor(rng() * values.length)] ?? values[0] ?? fallback;
}

export function normalizeRoomConfig(rawConfig = {}) {
  const turnCount = clamp(
    toInt(rawConfig.turnCount ?? rawConfig.deckSize, DEFAULT_TURN_COUNT),
    1,
    30,
  );
  return {
    playerCount: clamp(toInt(rawConfig.playerCount, DEFAULT_PLAYER_COUNT), PLAYER_COUNT_MIN, PLAYER_COUNT_MAX),
    turnCount,
    deckSize: turnCount,
    mapId: normalizeMapId(rawConfig.mapId),
    seed: String(rawConfig.seed ?? DEFAULT_ROOM_CONFIG.seed).trim(),
  };
}
