import { MAJOR_TITLES } from '../data/titles.js';
import { BALANCE } from '../data/balance.js';
import { findTitleHolder, getPlayerName } from './state.js';

function ensureTemporaryCapitalSupport(state) {
  if (!Array.isArray(state.temporaryCapitalSupport)) state.temporaryCapitalSupport = [];
  return state.temporaryCapitalSupport;
}

function toIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function getTitleHolderForSupport(state, titleKey) {
  if (titleKey === 'BASILEUS') return state.basileusId;
  if (MAJOR_TITLES[titleKey]) return findTitleHolder(state, titleKey);
  return null;
}

function normalizeTemporarySupportSubject(state, entry, kind) {
  let playerId = toIntegerOrNull(entry.playerId);
  let titleKey = entry.titleKey || null;

  if (kind === 'lost_provinces') {
    // Unrest belongs to the ruler who lost the land, not whoever later holds the title.
    if (playerId == null && titleKey) playerId = getTitleHolderForSupport(state, titleKey);
    titleKey = null;
  }

  return { playerId, titleKey };
}

export function addTemporaryCapitalSupport(state, entry = {}) {
  const support = ensureTemporaryCapitalSupport(state);
  const amount = Number(entry.amount) || 0;
  if (!amount) return null;
  const kind = entry.kind || 'temporary';
  const activeRound = Number.isInteger(Number(entry.activeRound))
    ? Number(entry.activeRound)
    : (Number(state.round) || 0) + 1;
  const { playerId, titleKey } = normalizeTemporarySupportSubject(state, entry, kind);
  const normalized = {
    id: entry.id || `${kind}:${state.round}:${support.length}`,
    kind,
    label: entry.label || 'Support',
    playerId,
    titleKey,
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
      label: 'Theodosian Walls',
      playerId: basileusId,
      titleKey: 'BASILEUS',
      amount: BALANCE.THEODOSIAN_WALLS_SUPPORT,
      activeRound,
    });
  }

  const patriarchId = getTitleHolderForSupport(state, 'PATRIARCH');
  if (Number.isInteger(patriarchId)) {
    entries.push({
      id: 'title:PATRIARCH',
      kind: 'title',
      label: "Patriarch's influence",
      playerId: patriarchId,
      titleKey: 'PATRIARCH',
      amount: BALANCE.PATRIARCH_INFLUENCE,
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
      : getPlayerName(state, entry?.playerId);
  const label = entry?.label || 'Support';
  return `${label}: ${amount > 0 ? '+' : ''}${amount} for ${subject}`;
}
