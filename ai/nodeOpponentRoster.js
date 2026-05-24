import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FALLBACK_AI_OPPONENTS,
  mergeOpponentRosters,
  normalizeTunedOpponentRoster,
} from './opponentRoster.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TUNED_OPPONENTS_PATH = resolve(__dirname, 'tunedOpponents.json');

let tunedRosterCache = null;

function fallbackForSeat(seatId = 0) {
  const index = Math.max(0, Math.floor(Number(seatId) || 0)) % FALLBACK_AI_OPPONENTS.length;
  return FALLBACK_AI_OPPONENTS[index] || FALLBACK_AI_OPPONENTS[0];
}

export function loadTunedOpponentRosterSync() {
  if (tunedRosterCache) return tunedRosterCache.map((entry) => ({ ...entry }));
  try {
    const payload = JSON.parse(readFileSync(TUNED_OPPONENTS_PATH, 'utf8'));
    tunedRosterCache = normalizeTunedOpponentRoster(payload);
  } catch {
    tunedRosterCache = [];
  }
  return tunedRosterCache.map((entry) => ({ ...entry }));
}

export function loadOpponentRosterSync() {
  return mergeOpponentRosters(
    loadTunedOpponentRosterSync(),
    FALLBACK_AI_OPPONENTS.map((entry) => ({ ...entry, source: 'built-in' })),
  );
}

export function loadOpponentByIdSync(id = null, seatId = 0) {
  const normalizedId = String(id || '').trim();
  if (normalizedId) {
    const found = loadOpponentRosterSync().find((entry) => entry.id === normalizedId);
    if (found) return found;
  }
  return { ...fallbackForSeat(seatId), source: 'built-in' };
}
