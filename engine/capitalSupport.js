import { MAJOR_TITLES } from '../data/titles.js';
import { findTitleHolder, getPlayer } from './state.js';

export const BASILEUS_CAPITAL_SUPPORT = 2;
export const PATRIARCH_CAPITAL_SUPPORT = 1;

function ensureTemporaryCapitalSupport(state) {
  if (!Array.isArray(state.temporaryCapitalSupport)) state.temporaryCapitalSupport = [];
  return state.temporaryCapitalSupport;
}

function playerName(state, playerId) {
  const player = getPlayer(state, playerId);
  return player?.firstName ? `${player.firstName} ${player.dynasty}`.trim() : player?.dynasty || `Player ${Number(playerId) + 1}`;
}

function getTitleHolderForSupport(state, titleKey) {
  if (titleKey === 'BASILEUS') return state.basileusId;
  if (MAJOR_TITLES[titleKey]) return findTitleHolder(state, titleKey);
  return null;
}

export function addTemporaryCapitalSupport(state, entry = {}) {
  const support = ensureTemporaryCapitalSupport(state);
  const amount = Number(entry.amount) || 0;
  if (!amount) return null;
  const activeRound = Number.isInteger(Number(entry.activeRound))
    ? Number(entry.activeRound)
    : (Number(state.round) || 0) + 1;
  const normalized = {
    id: entry.id || `${entry.kind || 'support'}:${state.round}:${support.length}`,
    kind: entry.kind || 'temporary',
    label: entry.label || 'Capital support',
    playerId: Number.isInteger(Number(entry.playerId)) ? Number(entry.playerId) : null,
    titleKey: entry.titleKey || null,
    amount,
    activeRound,
    originRound: Number(state.round) || 0,
    themeIds: Array.isArray(entry.themeIds) ? entry.themeIds.slice() : [],
  };
  support.push(normalized);
  return normalized;
}

export function expireCapitalSupport(state) {
  const support = ensureTemporaryCapitalSupport(state);
  const round = Number(state.round) || 0;
  state.temporaryCapitalSupport = support.filter((entry) => (
    Number(entry.activeRound) > round
  ));
}

export function getCapitalSupportEntries(state, round = state?.round) {
  if (!state) return [];
  const activeRound = Number(round) || 0;
  const entries = [];
  const basileusId = getTitleHolderForSupport(state, 'BASILEUS');
  if (Number.isInteger(basileusId)) {
    entries.push({
      id: 'title:BASILEUS',
      kind: 'title',
      label: 'Basileus fortifications',
      playerId: basileusId,
      titleKey: 'BASILEUS',
      amount: BASILEUS_CAPITAL_SUPPORT,
      activeRound,
    });
  }

  const patriarchId = getTitleHolderForSupport(state, 'PATRIARCH');
  if (Number.isInteger(patriarchId)) {
    entries.push({
      id: 'title:PATRIARCH',
      kind: 'title',
      label: 'Patriarchal influence',
      playerId: patriarchId,
      titleKey: 'PATRIARCH',
      amount: PATRIARCH_CAPITAL_SUPPORT,
      activeRound,
    });
  }

  for (const entry of ensureTemporaryCapitalSupport(state)) {
    if (Number(entry.activeRound) !== activeRound) continue;
    const playerId = entry.titleKey ? getTitleHolderForSupport(state, entry.titleKey) : Number(entry.playerId);
    if (!Number.isInteger(playerId)) continue;
    entries.push({
      ...entry,
      playerId,
    });
  }

  return entries.filter((entry) => Number(entry.amount) !== 0);
}

export function getCapitalSupportByPlayer(state, round = state?.round) {
  const support = {};
  for (const entry of getCapitalSupportEntries(state, round)) {
    support[entry.playerId] = (support[entry.playerId] || 0) + (Number(entry.amount) || 0);
  }
  return support;
}

export function getPlayerCapitalSupport(state, playerId, round = state?.round) {
  return Number(getCapitalSupportByPlayer(state, round)?.[playerId]) || 0;
}

export function describeCapitalSupportEntry(state, entry) {
  const amount = Number(entry?.amount) || 0;
  const subject = entry?.titleKey === 'BASILEUS'
    ? 'the Basileus'
    : entry?.titleKey === 'PATRIARCH'
      ? 'the Patriarch'
      : playerName(state, entry?.playerId);
  const label = entry?.label || 'Capital support';
  return `${label}: ${amount > 0 ? '+' : ''}${amount} for ${subject}`;
}
