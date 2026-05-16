import {
  DEFAULT_HEURISTIC_ID,
  getHeuristicPersonality,
  listHeuristicOpponents,
} from './heuristics.js';

export function loadOpponentRosterSync() {
  return listHeuristicOpponents().map((entry) => ({
    ...entry,
    source: 'built-in-heuristic',
  }));
}

export function loadOpponentByIdSync(id = DEFAULT_HEURISTIC_ID) {
  return getHeuristicPersonality(id);
}

export function opponentFirstName(opponent, fallback = 'AI') {
  return String(opponent?.firstName || opponent?.name || fallback).trim() || fallback;
}
