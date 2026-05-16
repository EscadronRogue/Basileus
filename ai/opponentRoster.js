import { GREEK_FIRST_NAMES } from './greekNames.js';

export const DEFAULT_PLACEHOLDER_OPPONENT_ID = 'placeholder-1';

const PLACEHOLDER_COUNT = Math.min(8, GREEK_FIRST_NAMES.length);

export const PLACEHOLDER_AI_OPPONENTS = Object.freeze(
  GREEK_FIRST_NAMES.slice(0, PLACEHOLDER_COUNT).map((firstName, index) => ({
    id: `placeholder-${index + 1}`,
    firstName,
    label: 'AI Placeholder',
    description: 'Named seat placeholder. No AI decision system is installed.',
    placeholder: true,
  })),
);

function placeholderForSeat(seatId = 0) {
  const index = Math.max(0, Math.floor(Number(seatId) || 0)) % PLACEHOLDER_AI_OPPONENTS.length;
  return PLACEHOLDER_AI_OPPONENTS[index] || PLACEHOLDER_AI_OPPONENTS[0];
}

export function loadOpponentRosterSync() {
  return PLACEHOLDER_AI_OPPONENTS.map((entry) => ({
    ...entry,
    source: 'placeholder',
  }));
}

export function loadOpponentByIdSync(id = DEFAULT_PLACEHOLDER_OPPONENT_ID, seatId = 0) {
  const normalizedId = String(id || '').trim();
  return PLACEHOLDER_AI_OPPONENTS.find((entry) => entry.id === normalizedId) || placeholderForSeat(seatId);
}

export function opponentFirstName(opponent, fallback = 'AI') {
  return String(opponent?.firstName || opponent?.name || fallback).trim() || fallback;
}
