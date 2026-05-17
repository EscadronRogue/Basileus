import {
  SCORE_SHARE_THRESHOLDS,
  buildFinalScores,
} from '../engine/scoring.js';
import {
  findTitleHolder,
  getBishopThemes,
  getOfficeHolder,
  getPlayer,
  getPlayerMercenaryTroops,
  getPlayerPendingProfessionalTotal,
  getPlayerThemes,
  getStrategosThemes,
} from '../engine/state.js';
import {
  getPlayerOrderOfficeKeys,
  isCapitalLockedOfficeKey,
} from '../engine/orders.js';

const CATEGORY_VALUE_WEIGHT = {
  church: 4.2,
  estate: 3.2,
  tax: 3.6,
  gold: 1.2,
};

const MAJOR_TITLE_WEIGHT = {
  PATRIARCH: 34,
  DOM_EAST: 24,
  DOM_WEST: 24,
  ADMIRAL: 22,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sum(values = []) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

export function getAverageInvasionStrength(state) {
  const [low, high] = state?.currentInvasion?.strength || [0, 0];
  const values = [low, high]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? sum(values) / values.length : 0;
}

export function getOfficeTroopCount(state, playerId, officeKey) {
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  if (officeKey === 'MERCENARY_COMPANY') return getPlayerMercenaryTroops(state, playerId);
  const professionals = Math.max(0, Number(player.professionalArmies?.[officeKey]) || 0);
  const levies = getOfficeHolder(state, officeKey) === playerId
    ? Math.max(0, Number(state.currentLevies?.[officeKey]) || 0)
    : 0;
  return professionals + levies;
}

export function summarizeOrders(state, playerId, orders = {}) {
  let capitalTroops = 0;
  let frontierTroops = 0;
  const offices = [];

  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    const troops = getOfficeTroopCount(state, playerId, officeKey);
    if (troops <= 0) continue;
    const destination = isCapitalLockedOfficeKey(officeKey)
      ? 'capital'
      : (orders.deployments?.[officeKey] || 'frontier');
    if (destination === 'capital') capitalTroops += troops;
    else frontierTroops += troops;
    offices.push({ officeKey, troops, destination });
  }

  return {
    capitalTroops,
    frontierTroops,
    totalTroops: capitalTroops + frontierTroops,
    candidate: Number.isInteger(orders.candidate) ? orders.candidate : playerId,
    offices,
  };
}

function thresholdPressure(share) {
  const normalized = clamp(Number(share) || 0, 0, 1);
  let pressure = 0;
  for (const threshold of SCORE_SHARE_THRESHOLDS) {
    if (normalized >= threshold) {
      pressure += 9;
      continue;
    }
    const progress = normalized / threshold;
    if (progress >= 0.55) pressure += progress * 8;
    break;
  }
  return pressure;
}

function scoreCategory(category) {
  const value = Math.max(0, Number(category?.value) || 0);
  const share = Math.max(0, Number(category?.share) || 0);
  const points = Math.max(0, Number(category?.points) || 0);
  const weight = CATEGORY_VALUE_WEIGHT[category?.key] || 1;
  return (points * 18) + (value * weight) + thresholdPressure(share);
}

function scoreOfficePosition(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return 0;

  let score = 0;
  if (state.basileusId === playerId) score += 32;
  if (state.nextBasileusId === playerId && state.nextBasileusId !== state.basileusId) score += 28;
  if (state.nextBasileusId != null && state.nextBasileusId !== playerId && state.nextBasileusId !== state.basileusId) {
    score -= 12;
  }

  for (const titleKey of player.majorTitles || []) {
    score += MAJOR_TITLE_WEIGHT[titleKey] || 16;
  }
  if (state.empress === playerId) score += 12;
  if (state.chiefEunuchs === playerId) score += 12;

  for (const theme of getStrategosThemes(state, playerId)) {
    score += 6 + ((Number(theme.T) || 0) * 3) + ((Number(theme.L) || 0) * 1.5);
  }
  for (const theme of getBishopThemes(state, playerId)) {
    score += 8 + ((Number(theme.C) || 0) * 2);
  }
  for (const theme of getPlayerThemes(state, playerId)) {
    score += ((Number(theme.P) || 0) * 2.5) + ((Number(theme.T) || 0) * 0.8);
  }

  return score;
}

function scoreMilitary(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  const activeProfessionals = sum(Object.values(player.professionalArmies || {}));
  const pendingProfessionals = getPlayerPendingProfessionalTotal(state, playerId);
  const mercenaries = getPlayerMercenaryTroops(state, playerId);
  const controlledLevies = getPlayerOrderOfficeKeys(state, playerId).reduce(
    (total, officeKey) => total + (getOfficeHolder(state, officeKey) === playerId
      ? Math.max(0, Number(state.currentLevies?.[officeKey]) || 0)
      : 0),
    0,
  );
  return (activeProfessionals * 2.2)
    + (pendingProfessionals * 1.7)
    + (mercenaries * 1.6)
    + (controlledLevies * 0.7);
}

function scorePlayerEntry(state, entry) {
  const playerId = entry.playerId;
  const player = getPlayer(state, playerId);
  const gold = Math.max(0, Number(entry.gold ?? player?.gold) || 0);
  const debt = Math.max(0, -(Number(player?.gold) || 0));
  const categories = Array.isArray(entry.categories) ? entry.categories : [];

  return (entry.points * 125)
    + (gold * 1.35)
    + ((Number(entry.projectedIncome) || 0) * 4.2)
    + categories.reduce((total, category) => total + scoreCategory(category), 0)
    + scoreOfficePosition(state, playerId)
    + scoreMilitary(state, playerId)
    - (debt * 18);
}

export function getScoreSnapshot(state) {
  const final = buildFinalScores(state);
  const entries = final.scores.map((entry, rank) => ({
    ...entry,
    rank,
    profileScore: scorePlayerEntry(state, entry),
  }));
  return {
    ...final,
    scores: entries,
    byPlayer: new Map(entries.map((entry) => [entry.playerId, entry])),
  };
}

export function getLeadingOpponentId(state, playerId) {
  return getScoreSnapshot(state).scores.find((entry) => entry.playerId !== playerId)?.playerId ?? null;
}

export function getWeakestOpponentId(state, playerId) {
  const opponents = getScoreSnapshot(state).scores.filter((entry) => entry.playerId !== playerId);
  return opponents[opponents.length - 1]?.playerId ?? null;
}

export function evaluateState(state, playerId) {
  if (!state || !Number.isInteger(playerId)) return -Infinity;
  if (state.gameOver?.type === 'fall') return -1200;

  const snapshot = getScoreSnapshot(state);
  const own = snapshot.byPlayer.get(playerId);
  if (!own) return -Infinity;

  const strongestOpponent = snapshot.scores.find((entry) => entry.playerId !== playerId);
  const rankBonus = (state.players.length - own.rank) * 8;
  const opponentPressure = strongestOpponent ? strongestOpponent.profileScore * 0.66 : 0;
  const leaderPointGap = strongestOpponent
    ? Math.max(0, strongestOpponent.points - own.points) * 35
    : 0;
  const empireSafety = state.gameOver ? -400 : 0;

  return own.profileScore - opponentPressure - leaderPointGap + rankBonus + empireSafety;
}

export function evaluateDelta(beforeState, afterState, playerId) {
  return evaluateState(afterState, playerId) - evaluateState(beforeState, playerId);
}

export function getTitleWeight(titleKey) {
  return MAJOR_TITLE_WEIGHT[titleKey] || 16;
}

export function getCurrentPatriarchId(state) {
  return findTitleHolder(state, 'PATRIARCH');
}
