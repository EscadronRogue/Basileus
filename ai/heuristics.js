import { runAdministration } from '../engine/cascade.js';
import {
  buildFinalScores,
  SCORE_CATEGORIES,
  SCORE_SHARE_THRESHOLDS,
} from '../engine/scoring.js';
import { getSpendableGold } from '../engine/deals.js';
import {
  findTitleHolder,
  getBishopThemes,
  getOfficeHolder,
  getPlayer,
  getPlayerMercenaryTotal,
  getPlayerMercenaryTroops,
  getPlayerThemes,
  getStrategosThemes,
  MERCENARY_COMPANY_KEY,
} from '../engine/state.js';
import {
  getPlayerOrderOfficeKeys,
  isCapitalLockedOfficeKey,
} from '../engine/orders.js';
import {
  getMercenaryHireCost,
  getThreatenedThemeIds,
} from '../engine/rules.js';
import { MAJOR_TITLES } from '../data/titles.js';
import { buildCandidateFeatures } from './features.js';
import {
  applyLegalAction,
  getActionTargetPlayerId,
  getActionThemeId,
} from './legalActions.js';

export const RANDOM_OPPONENT_ID = 'random';
export const DEFAULT_HEURISTIC_ID = 'alexios';

const MAX_OFFICIAL_SCORE = SCORE_CATEGORIES.length * SCORE_SHARE_THRESHOLDS.length;
const MAJOR_TITLE_COUNT = Object.keys(MAJOR_TITLES).length;

export const HEURISTIC_PERSONALITIES = Object.freeze([
  {
    id: 'alexios',
    firstName: 'Alexios',
    label: 'Balanced Usurper',
    description: 'Balances final-score growth, throne pressure, and enough frontier duty to keep the empire alive.',
    categoryWeights: { church: 1.0, estate: 1.15, tax: 1.25, gold: 1.05 },
    temperament: {
      ambition: 1.25,
      defense: 1.05,
      greed: 0.95,
      piety: 0.85,
      militarism: 1.0,
      intrigue: 1.0,
      risk: 0.95,
      titleHoarding: 1.12,
      estateGreed: 1.12,
      disruption: 0.75,
    },
  },
  {
    id: 'irene',
    firstName: 'Irene',
    label: 'Imperial Sentinel',
    description: 'Prioritizes survival, tax command, and controlled legitimacy over reckless coups.',
    categoryWeights: { church: 0.85, estate: 0.9, tax: 1.45, gold: 0.9 },
    temperament: {
      ambition: 0.75,
      defense: 1.75,
      greed: 0.45,
      piety: 1.0,
      militarism: 1.25,
      intrigue: 0.7,
      risk: 0.35,
      titleHoarding: 0.9,
      estateGreed: 0.75,
      disruption: 0.35,
    },
  },
  {
    id: 'zoe',
    firstName: 'Zoe',
    label: 'Court Spider',
    description: 'Wins through appointments, revocations, church income, and opportunistic capital coalitions.',
    categoryWeights: { church: 1.55, estate: 0.75, tax: 1.0, gold: 0.95 },
    temperament: {
      ambition: 1.2,
      defense: 0.7,
      greed: 0.75,
      piety: 1.45,
      militarism: 0.75,
      intrigue: 1.75,
      risk: 1.0,
      titleHoarding: 1.35,
      estateGreed: 0.65,
      disruption: 1.3,
    },
  },
  {
    id: 'niketas',
    firstName: 'Niketas',
    label: 'Treasury Hawk',
    description: 'Buys profitable land, protects gold share, and spends only when mercenaries convert wealth into wins.',
    categoryWeights: { church: 0.65, estate: 1.35, tax: 0.75, gold: 1.65 },
    temperament: {
      ambition: 0.9,
      defense: 0.65,
      greed: 1.6,
      piety: 0.45,
      militarism: 0.75,
      intrigue: 0.8,
      risk: 0.75,
      titleHoarding: 0.65,
      estateGreed: 1.6,
      disruption: 0.65,
    },
  },
  {
    id: 'basil',
    firstName: 'Basil',
    label: 'Border Hammer',
    description: 'Builds troop engines, contests the throne, and converts high-levy provinces into military leverage.',
    categoryWeights: { church: 0.75, estate: 1.05, tax: 1.1, gold: 0.85 },
    temperament: {
      ambition: 1.55,
      defense: 1.2,
      greed: 0.75,
      piety: 0.6,
      militarism: 1.7,
      intrigue: 0.9,
      risk: 1.25,
      titleHoarding: 1.1,
      estateGreed: 1.0,
      disruption: 0.9,
    },
  },
]);

const PROFILE_BY_ID = new Map(HEURISTIC_PERSONALITIES.map((profile) => [profile.id, profile]));
const STRATEGOS_TITLE_BY_REGION = {
  east: 'DOM_EAST',
  west: 'DOM_WEST',
  sea: 'ADMIRAL',
};

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, finiteNumber(value)));
}

function divide(value, denominator) {
  const bottom = Math.abs(finiteNumber(denominator));
  return bottom <= Number.EPSILON ? 0 : finiteNumber(value) / bottom;
}

function positive(value) {
  return Math.max(0, finiteNumber(value));
}

function profileTemperament(profile, key, fallback = 1) {
  return finiteNumber(profile?.temperament?.[key], fallback);
}

function profileCategoryWeight(profile, key, fallback = 1) {
  return finiteNumber(profile?.categoryWeights?.[key], fallback);
}

export function getHeuristicPersonality(id = DEFAULT_HEURISTIC_ID) {
  if (id && PROFILE_BY_ID.has(String(id))) return PROFILE_BY_ID.get(String(id));
  return PROFILE_BY_ID.get(DEFAULT_HEURISTIC_ID);
}

export function personalityForSeat(playerId) {
  const index = Math.max(0, Math.floor(finiteNumber(playerId))) % HEURISTIC_PERSONALITIES.length;
  return HEURISTIC_PERSONALITIES[index].id;
}

export function listHeuristicOpponents() {
  return HEURISTIC_PERSONALITIES.map((profile) => ({
    id: profile.id,
    firstName: profile.firstName,
    label: profile.label,
    description: profile.description,
  }));
}

function cloneForAnalysis(state) {
  const clone = JSON.parse(JSON.stringify(state));
  clone.rng = state.rng;
  if (state.courtActions) {
    clone.courtActions = {
      ...clone.courtActions,
      playerConfirmed: new Set([...(state.courtActions.playerConfirmed || new Set())]),
    };
  }
  return clone;
}

function stateAfterAction(state, action) {
  try {
    const clone = cloneForAnalysis(state);
    const result = applyLegalAction(clone, action, null);
    return result.ok ? clone : null;
  } catch {
    return null;
  }
}

function scoreByPlayer(state) {
  try {
    const final = buildFinalScores(state);
    return {
      final,
      byPlayer: new Map(final.scores.map((entry, index) => [
        entry.playerId,
        { ...entry, rank: index + 1 },
      ])),
    };
  } catch {
    return { final: null, byPlayer: new Map() };
  }
}

function administrationFor(state) {
  try {
    return runAdministration(state);
  } catch {
    return { income: {}, incomeBreakdown: {} };
  }
}

function categoryIncome(state, administration, playerId, key) {
  if (key === 'gold') return positive(getPlayer(state, playerId)?.gold);
  return positive(administration.incomeBreakdown?.[key]?.[playerId]);
}

function categoryTotals(state, administration) {
  return Object.fromEntries(SCORE_CATEGORIES.map((category) => [
    category.key,
    (state.players || []).reduce((total, player) => (
      total + categoryIncome(state, administration, player.id, category.key)
    ), 0),
  ]));
}

function troopSplit(state, playerId, orders = null) {
  const player = getPlayer(state, playerId);
  const split = {
    offices: 0,
    movableOffices: 0,
    total: 0,
    frontier: 0,
    capital: 0,
    professional: 0,
    levies: 0,
    mercenaries: 0,
  };
  if (!player) return split;

  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    split.offices += 1;
    if (!isCapitalLockedOfficeKey(officeKey)) split.movableOffices += 1;
    const professionals = officeKey === MERCENARY_COMPANY_KEY
      ? 0
      : positive(player.professionalArmies?.[officeKey]);
    const levies = officeKey === MERCENARY_COMPANY_KEY
      ? 0
      : (getOfficeHolder(state, officeKey) === playerId ? positive(state.currentLevies?.[officeKey]) : 0);
    const mercenaries = officeKey === MERCENARY_COMPANY_KEY ? getPlayerMercenaryTroops(state, playerId) : 0;
    const total = professionals + levies + mercenaries;
    split.professional += professionals;
    split.levies += levies;
    split.mercenaries += mercenaries;
    split.total += total;
    const destination = orders
      ? (isCapitalLockedOfficeKey(officeKey) ? 'capital' : (orders.deployments?.[officeKey] || 'frontier'))
      : 'frontier';
    split[destination === 'capital' ? 'capital' : 'frontier'] += total;
  }
  return split;
}

function totalTroops(state) {
  return (state.players || []).reduce((total, player) => total + troopSplit(state, player.id).total, 0);
}

function invasionNeed(state) {
  const [low, high] = state.currentInvasion?.strength || [0, 0];
  const values = [low, high].map((value) => finiteNumber(value)).filter((value) => value > 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function allFrontierCapacity(state) {
  return (state.players || []).reduce((total, player) => total + troopSplit(state, player.id).frontier, 0);
}

function submittedFrontierCommitment(state) {
  return (state.players || []).reduce((total, player) => {
    const orders = state.allOrders?.[player.id] || state.allOrders?.[String(player.id)];
    return total + (orders ? troopSplit(state, player.id, orders).frontier : 0);
  }, 0);
}

function frontierShortfall(state, extraFrontier = 0) {
  const need = invasionNeed(state);
  if (need <= 0) return 0;
  return Math.max(0, need - submittedFrontierCommitment(state) - positive(extraFrontier));
}

function empireDanger(state) {
  const need = invasionNeed(state);
  if (need <= 0) return 0;
  const capacityCoverage = clamp(allFrontierCapacity(state) / need, 0, 1.5);
  const committedCoverage = clamp(submittedFrontierCommitment(state) / need, 0, 1.5);
  const route = state.currentInvasion?.route || [];
  const occupiedOnRoute = route.filter((themeId) => state.themes?.[themeId]?.occupied).length;
  const routePressure = divide(occupiedOnRoute, Math.max(1, route.length - 1));
  return clamp((1 - Math.min(capacityCoverage, committedCoverage || capacityCoverage)) + routePressure, 0, 1.5);
}

function strategicSnapshot(state, playerId) {
  const { final, byPlayer } = scoreByPlayer(state);
  const score = byPlayer.get(playerId);
  const administration = administrationFor(state);
  const totals = categoryTotals(state, administration);
  const player = getPlayer(state, playerId);
  const ownThemes = getPlayerThemes(state, playerId).filter((theme) => !theme.occupied);
  const universeThemes = Object.values(state.themes || {}).filter((theme) => theme.id !== 'CPL' && !theme.occupied);
  const troopTotal = totalTroops(state);
  const ownTroops = troopSplit(state, playerId);
  const leaderPoints = final?.topScore || 0;

  const categoryShares = Object.fromEntries(SCORE_CATEGORIES.map((category) => [
    category.key,
    divide(categoryIncome(state, administration, playerId, category.key), totals[category.key]),
  ]));
  const categoryPoints = Object.fromEntries(SCORE_CATEGORIES.map((category) => {
    const entry = score?.categories?.find((candidate) => candidate.key === category.key);
    return [category.key, finiteNumber(entry?.points)];
  }));

  return {
    points: finiteNumber(score?.points),
    rank: finiteNumber(score?.rank, state.players?.length || 1),
    rankShare: state.players?.length > 1
      ? 1 - ((finiteNumber(score?.rank, state.players.length) - 1) / (state.players.length - 1))
      : 1,
    leaderGap: leaderPoints - finiteNumber(score?.points),
    categoryShares,
    categoryPoints,
    gold: positive(player?.gold),
    spendableGold: positive(getSpendableGold(state, playerId)),
    troopShare: divide(ownTroops.total, troopTotal),
    troops: ownTroops,
    estateCountShare: divide(ownThemes.length, Math.max(1, universeThemes.length)),
    estateValueShare: divide(
      ownThemes.reduce((total, theme) => total + positive(theme.P) + positive(theme.T), 0),
      universeThemes.reduce((total, theme) => total + positive(theme.P) + positive(theme.T), 0),
    ),
    majorTitleShare: divide(player?.majorTitles?.length || 0, MAJOR_TITLE_COUNT),
    strategosShare: divide(getStrategosThemes(state, playerId).length, Math.max(1, universeThemes.length)),
    bishopShare: divide(getBishopThemes(state, playerId).length, Math.max(1, universeThemes.length)),
    isBasileus: state.basileusId === playerId,
    danger: empireDanger(state),
  };
}

function strategicStateScore(profile, state, playerId) {
  const snap = strategicSnapshot(state, playerId);
  let score = 0;
  score += snap.points * 18;
  score += snap.rankShare * 8;
  score -= snap.leaderGap * 1.8;
  for (const category of SCORE_CATEGORIES) {
    const weight = profileCategoryWeight(profile, category.key);
    score += (snap.categoryPoints[category.key] || 0) * 8 * weight;
    score += (snap.categoryShares[category.key] || 0) * 7 * weight;
  }
  score += snap.troopShare * 7 * profileTemperament(profile, 'militarism');
  score += snap.majorTitleShare * 5 * profileTemperament(profile, 'titleHoarding');
  score += snap.strategosShare * 4 * (profileCategoryWeight(profile, 'tax') + profileTemperament(profile, 'militarism')) / 2;
  score += snap.bishopShare * 4 * profileTemperament(profile, 'piety');
  score += snap.estateValueShare * 7 * profileTemperament(profile, 'estateGreed');
  score += snap.estateCountShare * 3 * profileTemperament(profile, 'estateGreed');
  score += Math.sqrt(snap.gold) * 1.2 * profileCategoryWeight(profile, 'gold');
  score += (snap.isBasileus ? 4 : 0) * profileTemperament(profile, 'ambition');
  score -= snap.danger * 14 * (0.65 + profileTemperament(profile, 'defense') * 0.35);
  return score;
}

function featureScore(profile, features = {}) {
  let score = 0;
  score += finiteNumber(features['score.delta.totalPoints']) * 70;
  score += finiteNumber(features['score.delta.rank']) * 35;
  for (const category of SCORE_CATEGORIES) {
    const weight = profileCategoryWeight(profile, category.key);
    score += finiteNumber(features[`score.delta.${category.key}.points`]) * 35 * weight;
    score += finiteNumber(features[`score.delta.${category.key}.share`]) * 22 * weight;
    score += finiteNumber(features[`income.delta.${category.key}.share`]) * 18 * weight;
  }
  score += finiteNumber(features['estate.delta.profit.share']) * 20 * profileTemperament(profile, 'estateGreed');
  score += finiteNumber(features['estate.delta.tax.share']) * 16 * profileCategoryWeight(profile, 'tax');
  score += finiteNumber(features['estate.delta.levies.share']) * 14 * profileTemperament(profile, 'militarism');
  score += finiteNumber(features['estate.delta.church.share']) * 12 * profileTemperament(profile, 'piety');
  score += finiteNumber(features['power.delta.majorTitleShare']) * 18 * profileTemperament(profile, 'titleHoarding');
  score += finiteNumber(features['power.delta.strategosShare']) * 14 * profileCategoryWeight(profile, 'tax');
  score += finiteNumber(features['power.delta.bishopShare']) * 16 * profileTemperament(profile, 'piety');
  score += finiteNumber(features['military.delta.troopShare']) * 18 * profileTemperament(profile, 'militarism');
  score += finiteNumber(features['military.delta.professionalShare']) * 18 * profileTemperament(profile, 'militarism');
  score += finiteNumber(features['treasury.delta.goldShare']) * 16 * profileCategoryWeight(profile, 'gold');
  score -= finiteNumber(features['treasury.spendShare']) * 8 * Math.max(0.25, 1.4 - profileTemperament(profile, 'greed'));
  score += finiteNumber(features['reward.restoreEmpire']) * 7 * profileTemperament(profile, 'defense');
  score += finiteNumber(features['reward.takeGold']) * 2.5 * profileTemperament(profile, 'greed');
  score += finiteNumber(features['orders.frontierCoverage']) * 12 * profileTemperament(profile, 'defense');
  score += finiteNumber(features['orders.candidate.self']) * 3.5 * profileTemperament(profile, 'ambition');
  score += finiteNumber(features['orders.candidate.currentBasileus']) * (profileTemperament(profile, 'defense') - profileTemperament(profile, 'ambition')) * 1.5;
  score -= finiteNumber(features['titleAssignment.giftsToHigherScorers']) * 18;
  return score;
}

function themeValueForProfile(profile, theme) {
  if (!theme) return 0;
  return positive(theme.P) * (2.2 * profileCategoryWeight(profile, 'estate') + 0.5 * profileTemperament(profile, 'estateGreed'))
    + positive(theme.T) * (1.8 * profileCategoryWeight(profile, 'tax'))
    + positive(theme.L) * (1.2 * profileTemperament(profile, 'militarism') + 0.5 * profileTemperament(profile, 'defense'))
    + positive(theme.C) * (1.3 * profileCategoryWeight(profile, 'church') + 0.4 * profileTemperament(profile, 'piety'));
}

function targetPressure(state, playerId, targetId) {
  if (!Number.isInteger(targetId) || targetId === playerId) return 0;
  const { final, byPlayer } = scoreByPlayer(state);
  const self = byPlayer.get(playerId);
  const target = byPlayer.get(targetId);
  if (!self || !target) return 0.25;
  const gap = finiteNumber(target.points) - finiteNumber(self.points);
  const leaderBonus = target.points === final?.topScore ? 0.6 : 0;
  return clamp(0.25 + divide(gap, MAX_OFFICIAL_SCORE) + leaderBonus, 0, 1.5);
}

function appointmentScore(profile, state, playerId, action) {
  const payload = action.payload || {};
  const targetId = Number(payload.appointeeId);
  const targetIsSelf = targetId === playerId;
  const theme = state.themes?.[payload.themeId];
  const targetPenalty = targetIsSelf ? 0 : targetPressure(state, playerId, targetId);
  let score = targetIsSelf
    ? 6 * profileTemperament(profile, 'titleHoarding')
    : 1.25 - (6 * targetPenalty);

  if (payload.titleType === 'EMPRESS' || payload.titleType === 'CHIEF_EUNUCHS') {
    score += 2.5 * profileTemperament(profile, 'intrigue');
    score += targetIsSelf ? 3 * profileTemperament(profile, 'ambition') : 0;
  }
  if (payload.titleType === 'STRATEGOS' || payload.action === 'appoint-strategos') {
    score += themeValueForProfile(profile, theme) * 0.9;
    score += positive(theme?.T) * profileCategoryWeight(profile, 'tax');
    score += positive(theme?.L) * profileTemperament(profile, 'militarism');
  }
  if (payload.titleType === 'BISHOP' || payload.action === 'appoint-bishop') {
    score += (positive(theme?.C) + positive(theme?.P) + positive(theme?.T) * 0.5) * profileTemperament(profile, 'piety');
    score += targetIsSelf ? 2.5 * profileCategoryWeight(profile, 'church') : 0;
  }
  return score;
}

function courtActionScore(profile, state, playerId, action) {
  const payload = action.payload || {};
  const player = getPlayer(state, playerId);
  const theme = state.themes?.[payload.themeId] || state.themes?.[getActionThemeId(action)];
  const need = invasionNeed(state);
  const capacityShortfall = need > 0 ? clamp((need - allFrontierCapacity(state)) / need, 0, 1.5) : 0;
  const defensivePressure = Math.max(empireDanger(state), capacityShortfall);

  if (action.kind === 'court-confirm') return defensivePressure > 0.75 ? 1.25 * profileTemperament(profile, 'defense') : -0.1;
  if (payload.action === 'buy') {
    const amount = positive(payload.amount);
    const value = themeValueForProfile(profile, theme);
    const threatenedPenalty = getThreatenedThemeIds(state, { includeOccupied: true }).includes(theme?.id)
      ? 2.5 * Math.max(0.3, 1.4 - profileTemperament(profile, 'risk'))
      : 0;
    const cashAfterBid = positive(player?.gold) - amount;
    const reservePenalty = cashAfterBid < 1 ? (1 - cashAfterBid) * (2.5 * profileCategoryWeight(profile, 'gold')) : 0;
    return value * profileTemperament(profile, 'estateGreed')
      - amount * 0.75
      - threatenedPenalty
      - reservePenalty
      - defensivePressure * 3 * Math.max(0.3, 1.2 - profileTemperament(profile, 'greed'));
  }
  if (payload.action === 'gift') {
    const churchGain = (positive(theme?.P) + positive(theme?.T)) * profileTemperament(profile, 'piety');
    const lostEstate = positive(theme?.P) * profileCategoryWeight(profile, 'estate')
      + positive(theme?.T) * profileCategoryWeight(profile, 'tax');
    return churchGain * 1.6 - lostEstate * 2.1;
  }
  if (payload.action === 'recruit') {
    const office = String(payload.office || '');
    const isRegional = Object.keys(MAJOR_TITLES).includes(office) || office.startsWith('STRAT_');
    const debtRisk = positive(player?.gold) <= 0 ? 4 : 0;
    return (isRegional ? 3.5 : 2.5) * profileTemperament(profile, 'militarism')
      + (1.5 + defensivePressure * 8) * profileTemperament(profile, 'defense')
      - debtRisk * Math.max(0.25, 1.3 - profileTemperament(profile, 'greed'));
  }
  if (payload.action === 'hire-mercenaries') {
    const alreadyHired = getPlayerMercenaryTotal(state, playerId);
    const cost = getMercenaryHireCost(alreadyHired, positive(payload.count));
    const need = invasionNeed(state);
    const danger = empireDanger(state);
    const coupUse = profileTemperament(profile, 'ambition') * (state.basileusId === playerId ? 0.7 : 1.2);
    return (danger * 10 * profileTemperament(profile, 'defense'))
      + (capacityShortfall * 12 * profileTemperament(profile, 'defense'))
      + (coupUse * 2)
      + (profileTemperament(profile, 'militarism') * 2.5)
      - cost * (0.8 + profileCategoryWeight(profile, 'gold') * 0.35)
      + (need > 0 ? 1 : 0);
  }
  if (payload.action === 'dismiss') {
    const upkeepPressure = positive(player?.gold) < 0 ? 7 : positive(player?.gold) < 2 ? 2 : 0;
    return upkeepPressure * profileCategoryWeight(profile, 'gold') - 7 * profileTemperament(profile, 'militarism');
  }
  if (payload.action === 'revoke') {
    const targetId = getActionTargetPlayerId(state, action);
    const pressure = targetPressure(state, playerId, targetId);
    const disruption = profileTemperament(profile, 'disruption');
    const themeSwing = theme ? themeValueForProfile(profile, theme) * 0.45 : 1.5;
    return pressure * 9 * disruption
      + themeSwing
      - defensivePressure * 7 * Math.max(0.25, 1.4 - profileTemperament(profile, 'disruption'))
      - (targetId === playerId ? 25 : 0);
  }
  if (
    payload.action === 'basileus-appoint'
    || payload.action === 'appoint-strategos'
    || payload.action === 'appoint-bishop'
  ) {
    const appointment = appointmentScore(profile, state, playerId, action);
    const isMilitaryAppointment = payload.titleType === 'STRATEGOS' || payload.action === 'appoint-strategos';
    const defenseAppointmentBonus = isMilitaryAppointment ? defensivePressure * 2.5 * profileTemperament(profile, 'defense') : 0;
    return appointment
      + defenseAppointmentBonus
      - defensivePressure * (isMilitaryAppointment ? 1.5 : 4) * Math.max(0.4, 1.25 - profileTemperament(profile, 'intrigue'));
  }
  return 0;
}

function projectedCoupVotes(state, playerId, orders) {
  const votes = {};
  for (const [pidText, existingOrders] of Object.entries(state.allOrders || {})) {
    const pid = Number(pidText);
    const split = troopSplit(state, pid, existingOrders);
    votes[existingOrders.candidate] = (votes[existingOrders.candidate] || 0) + split.capital;
  }
  const ownSplit = troopSplit(state, playerId, orders);
  votes[orders.candidate] = (votes[orders.candidate] || 0) + ownSplit.capital;
  return votes;
}

function orderActionScore(profile, state, playerId, action) {
  const orders = action.orders || {};
  const split = troopSplit(state, playerId, orders);
  const need = invasionNeed(state);
  const danger = empireDanger(state);
  const frontierCoverage = need > 0 ? clamp(split.frontier / need, 0, 1.4) : 0;
  const shortfallBefore = frontierShortfall(state);
  const shortfallAfter = frontierShortfall(state, split.frontier);
  const missingPressure = need > 0 ? clamp(shortfallBefore / need, 0, 1.5) : 0;
  const marginalCoverage = shortfallBefore > 0
    ? clamp((shortfallBefore - shortfallAfter) / shortfallBefore, 0, 1.25)
    : frontierCoverage;
  const overcommit = need > 0 && shortfallBefore <= 0
    ? Math.max(0, split.frontier - need * 0.75) / Math.max(1, split.total)
    : 0;
  const leavesEmpireExposed = need > 0 && shortfallAfter > Math.max(1, need * 0.08);
  const selfCandidate = orders.candidate === playerId;
  const incumbentCandidate = orders.candidate === state.basileusId;
  const votes = projectedCoupVotes(state, playerId, orders);
  const selfVoteLead = finiteNumber(votes[playerId]) - Math.max(
    0,
    ...Object.entries(votes)
      .filter(([candidate]) => Number(candidate) !== playerId)
      .map(([, troops]) => finiteNumber(troops)),
  );
  const coupPressure = leavesEmpireExposed ? 0.55 : 1.25;

  let score = 0;
  score += frontierCoverage * 10 * profileTemperament(profile, 'defense') * (0.6 + danger);
  score += marginalCoverage * 30 * profileTemperament(profile, 'defense') * (0.8 + missingPressure + danger * 0.5);
  score -= overcommit * 4 * profileTemperament(profile, 'ambition');
  score += split.capital * 1.2 * profileTemperament(profile, 'ambition') * (selfCandidate ? 1.25 : 0.35) * coupPressure;
  score += selfCandidate ? 5.75 * profileTemperament(profile, 'ambition') * coupPressure : 0;
  score += selfVoteLead > 0 ? 4.25 * profileTemperament(profile, 'ambition') * coupPressure : selfVoteLead * 0.5;
  score += incumbentCandidate ? 2.5 * Math.max(0, profileTemperament(profile, 'defense') - profileTemperament(profile, 'ambition')) : 0;
  score -= !selfCandidate && !incumbentCandidate
    ? targetPressure(state, playerId, orders.candidate) * 5
    : 0;
  score += split.frontier > 0 && need > 0 ? 1.5 : 0;
  if (leavesEmpireExposed) {
    score -= (split.capital + (selfCandidate ? 1 : 0)) * 11 * profileTemperament(profile, 'defense') * (0.75 + missingPressure);
  }
  return score;
}

function rewardActionScore(profile, state, playerId, action) {
  const reward = (state.pendingDefenderRewards || []).find((entry) => entry.id === action.rewardId);
  const gold = positive(reward?.goldValue);
  const danger = empireDanger(state);
  if (action.choice === 'gold') {
    return gold * 1.2 * profileTemperament(profile, 'greed')
      + gold * 0.8 * profileCategoryWeight(profile, 'gold')
      - (4 + danger * 6) * profileTemperament(profile, 'defense');
  }
  return (4 + danger * 6) * profileTemperament(profile, 'defense')
    + 2 * profileTemperament(profile, 'piety')
    - gold * 0.35 * profileTemperament(profile, 'greed');
}

function titleAssignmentScore(profile, state, playerId, action) {
  const assignments = action.assignments || {};
  const { byPlayer, final } = scoreByPlayer(state);
  let score = 0;
  for (const [titleKey, targetIdValue] of Object.entries(assignments)) {
    const targetId = Number(targetIdValue);
    const target = byPlayer.get(targetId);
    const targetPoints = finiteNumber(target?.points);
    const leaderPenalty = targetPoints === final?.topScore ? 7 : 0;
    const gapBehindSelf = finiteNumber(byPlayer.get(playerId)?.points) - targetPoints;
    const weakVassalBonus = clamp(divide(gapBehindSelf, MAX_OFFICIAL_SCORE), -1, 1) * 6;
    score += weakVassalBonus - leaderPenalty;
    if (titleKey === 'PATRIARCH') score += profileTemperament(profile, 'piety') * (targetId === playerId ? -99 : 1);
    else score += profileTemperament(profile, 'militarism') * 0.5;
  }
  return score;
}

function actionSpecificScore(profile, state, playerId, action) {
  if (action.kind === 'court' || action.kind === 'court-confirm') {
    return courtActionScore(profile, state, playerId, action);
  }
  if (action.kind === 'orders') return orderActionScore(profile, state, playerId, action);
  if (action.kind === 'reward') return rewardActionScore(profile, state, playerId, action);
  if (action.kind === 'title-assignment') return titleAssignmentScore(profile, state, playerId, action);
  return 0;
}

function featureTieBreak(action) {
  const payload = action?.payload || {};
  if (payload.action === 'buy') return 0.04;
  if (payload.action === 'recruit') return 0.03;
  if (payload.action === 'hire-mercenaries') return 0.02;
  if (payload.action === 'dismiss') return -0.08;
  if (action?.kind === 'court-confirm') return -0.05;
  return 0;
}

function scoreAction(profile, state, playerId, action, features = {}) {
  const before = strategicStateScore(profile, state, playerId);
  const afterState = stateAfterAction(state, action);
  const after = afterState ? strategicStateScore(profile, afterState, playerId) : before - 30;
  return {
    total: (after - before)
      + featureScore(profile, features)
      + actionSpecificScore(profile, state, playerId, action)
      + featureTieBreak(action),
    before,
    after,
  };
}

function chooseBest(scores, rng = Math.random) {
  let bestScore = -Infinity;
  const bestIndexes = [];
  for (let index = 0; index < scores.length; index += 1) {
    const score = finiteNumber(scores[index]?.total, -Infinity);
    if (score > bestScore + Number.EPSILON) {
      bestScore = score;
      bestIndexes.length = 0;
      bestIndexes.push(index);
    } else if (Math.abs(score - bestScore) <= Number.EPSILON) {
      bestIndexes.push(index);
    }
  }
  return bestIndexes.length ? bestIndexes[Math.floor(rng() * bestIndexes.length)] : 0;
}

export function selectRandomActionIndex(actions, rng = Math.random) {
  return actions.length ? Math.floor(rng() * actions.length) : -1;
}

export function evaluateHeuristicActions(strategyId, state, playerId, actions) {
  const profile = typeof strategyId === 'object' ? strategyId : getHeuristicPersonality(strategyId);
  const featureMaps = buildCandidateFeatures(state, playerId, actions);
  const scores = actions.map((action, index) => scoreAction(
    profile,
    state,
    playerId,
    action,
    featureMaps[index] || {},
  ));
  return {
    profile,
    scores,
    featureMaps,
  };
}

export function selectHeuristicAction(strategyId, state, playerId, actions, rng = Math.random) {
  if (!actions.length) return { index: -1, action: null, scores: [] };
  const evaluation = evaluateHeuristicActions(strategyId, state, playerId, actions);
  const index = chooseBest(evaluation.scores, rng);
  return {
    ...evaluation,
    index,
    action: actions[index] || actions[0],
    score: evaluation.scores[index]?.total ?? 0,
  };
}

export function selectHeuristicActionIndex(strategyId, state, playerId, actions, rng = Math.random) {
  return selectHeuristicAction(strategyId, state, playerId, actions, rng).index;
}

export function createHeuristicController(strategyId = DEFAULT_HEURISTIC_ID) {
  const profile = getHeuristicPersonality(strategyId);
  return ({ state, playerId, actions, rng }) => (
    selectHeuristicActionIndex(profile, state, playerId, actions, rng)
  );
}
