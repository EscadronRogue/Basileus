import { runAdministration } from '../engine/cascade.js';
import { buildFinalScores } from '../engine/scoring.js';
import {
  getBishopThemes,
  getOfficeHolder,
  getPlayer,
  getPlayerMercenaryTroops,
  getStrategosThemes,
  MERCENARY_COMPANY_KEY,
} from '../engine/state.js';
import { getPlayerOrderOfficeKeys, isCapitalLockedOfficeKey } from '../engine/orders.js';
import { MAJOR_TITLES } from '../data/titles.js';
import { REGIONS } from '../data/provinces.js';
import {
  getActionTargetPlayerId,
  getActionThemeId,
} from './legalActions.js';

export const MAX_PLAYERS = 5;
export const OBSERVATION_SIZE = 256;
export const ACTION_FEATURE_SIZE = 128;
export const NETWORK_INPUT_SIZE = OBSERVATION_SIZE + ACTION_FEATURE_SIZE;

const PHASES = ['court', 'orders', 'resolution', 'scoring', 'setup', 'invasion', 'administration', 'cleanup'];
const COURT_ACTIONS = [
  'buy',
  'gift',
  'recruit',
  'dismiss',
  'hire-mercenaries',
  'basileus-appoint',
  'appoint-strategos',
  'appoint-bishop',
  'revoke',
  'deal-send',
  'deal-counter',
  'deal-accept',
  'deal-refuse',
  'confirm-court',
];
const ACTION_KINDS = ['court', 'court-confirm', 'orders', 'reward', 'title-assignment'];
const DEAL_KINDS = ['gold', 'estate', 'coup_support', 'frontier_support', 'appointment_promise', 'non_revocation'];
const TITLE_KEYS = Object.keys(MAJOR_TITLES);
const REGION_KEYS = [REGIONS.EAST, REGIONS.WEST, REGIONS.SEA];
const SCORE_CATEGORY_KEYS = ['church', 'estate', 'tax', 'gold'];

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function norm(value, scale) {
  if (!Number.isFinite(Number(value)) || !scale) return 0;
  return clamp01(Number(value) / scale);
}

function oneHot(features, values, active) {
  for (const value of values) features.push(value === active ? 1 : 0);
}

function relativePlayerIds(state, playerId) {
  const ids = state.players.map((player) => player.id);
  const ordered = ids.includes(playerId)
    ? [playerId, ...ids.filter((id) => id !== playerId)]
    : ids.slice();
  while (ordered.length < MAX_PLAYERS) ordered.push(null);
  return ordered.slice(0, MAX_PLAYERS);
}

function relativeIndex(state, viewerId, targetId) {
  if (!Number.isInteger(targetId)) return -1;
  return relativePlayerIds(state, viewerId).indexOf(targetId);
}

function toFixedSize(values, size) {
  const out = new Float64Array(size);
  for (let index = 0; index < Math.min(values.length, size); index += 1) {
    out[index] = clamp01(values[index]);
  }
  return out;
}

function sumProfessionalTroops(player) {
  return Object.values(player?.professionalArmies || {})
    .reduce((total, count) => total + Math.max(0, Number(count) || 0), 0);
}

function sumControlledLevies(state, playerId) {
  let total = 0;
  for (const officeKey of getPlayerOrderOfficeKeys(state, playerId)) {
    if (officeKey === MERCENARY_COMPANY_KEY) continue;
    if (getOfficeHolder(state, officeKey) !== playerId) continue;
    total += Math.max(0, Number(state.currentLevies?.[officeKey]) || 0);
  }
  return total;
}

function officeTroopSnapshot(state, playerId, orders = null) {
  const player = getPlayer(state, playerId);
  const officeKeys = getPlayerOrderOfficeKeys(state, playerId);
  const out = {
    offices: officeKeys.length,
    movableOffices: 0,
    lockedOffices: 0,
    professional: 0,
    levies: 0,
    mercenaries: 0,
    total: 0,
    frontierTroops: 0,
    capitalTroops: 0,
    frontierOffices: 0,
    capitalOffices: 0,
  };

  for (const officeKey of officeKeys) {
    const locked = isCapitalLockedOfficeKey(officeKey);
    if (locked) out.lockedOffices += 1;
    else out.movableOffices += 1;

    const professional = officeKey === MERCENARY_COMPANY_KEY
      ? 0
      : Math.max(0, Number(player?.professionalArmies?.[officeKey]) || 0);
    const levies = officeKey === MERCENARY_COMPANY_KEY
      ? 0
      : (getOfficeHolder(state, officeKey) === playerId ? Math.max(0, Number(state.currentLevies?.[officeKey]) || 0) : 0);
    const mercenaries = officeKey === MERCENARY_COMPANY_KEY
      ? getPlayerMercenaryTroops(state, playerId)
      : 0;
    const total = professional + levies + mercenaries;
    out.professional += professional;
    out.levies += levies;
    out.mercenaries += mercenaries;
    out.total += total;

    if (!orders) continue;
    const destination = locked ? 'capital' : (orders.deployments?.[officeKey] || 'frontier');
    if (destination === 'capital') {
      out.capitalTroops += total;
      out.capitalOffices += 1;
    } else {
      out.frontierTroops += total;
      out.frontierOffices += 1;
    }
  }

  return out;
}

function countOwnedThemes(state, playerId) {
  return Object.values(state.themes || {})
    .filter((theme) => theme.owner === playerId && !theme.occupied)
    .length;
}

function scoreByPlayer(state) {
  try {
    return new Map(buildFinalScores(state).scores.map((entry, index) => [
      entry.playerId,
      { ...entry, rank: index + 1 },
    ]));
  } catch {
    return new Map();
  }
}

function categoryValuesForPlayer(state, administration, playerId) {
  const gold = Math.max(0, Number(getPlayer(state, playerId)?.gold) || 0);
  return {
    church: Math.max(0, Number(administration.incomeBreakdown?.church?.[playerId]) || 0),
    estate: Math.max(0, Number(administration.incomeBreakdown?.estate?.[playerId]) || 0),
    tax: Math.max(0, Number(administration.incomeBreakdown?.tax?.[playerId]) || 0),
    gold,
  };
}

function categoryTotals(state, administration) {
  const totals = Object.fromEntries(SCORE_CATEGORY_KEYS.map((key) => [key, 0]));
  for (const player of state.players || []) {
    const values = categoryValuesForPlayer(state, administration, player.id);
    for (const key of SCORE_CATEGORY_KEYS) totals[key] += values[key];
  }
  return totals;
}

function administrationSnapshot(state) {
  try {
    return runAdministration(state);
  } catch {
    return { income: {}, incomeBreakdown: {} };
  }
}

function invasionRouteThemes(state) {
  return (state.currentInvasion?.route || [])
    .map((themeId) => state.themes?.[themeId])
    .filter(Boolean);
}

function pushInvasionContext(features, state, playerId) {
  const route = invasionRouteThemes(state);
  const routeCount = Math.max(1, route.length);
  const low = Number(state.currentInvasion?.strength?.[0]) || 0;
  const high = Number(state.currentInvasion?.strength?.[1]) || 0;
  const midpoint = low || high ? (low + high) / 2 : 0;
  const occupied = route.filter((theme) => theme.occupied).length;
  const free = route.filter((theme) => !theme.occupied && theme.owner == null).length;
  const selfOwned = route.filter((theme) => !theme.occupied && theme.owner === playerId).length;
  const otherOwned = route.filter((theme) => !theme.occupied && Number.isInteger(theme.owner) && theme.owner !== playerId).length;
  const churchOwned = route.filter((theme) => !theme.occupied && theme.owner === 'church').length;
  const routeProfit = route.reduce((total, theme) => total + (Number(theme.P) || 0), 0);
  const routeTax = route.reduce((total, theme) => total + (Number(theme.T) || 0), 0);
  const routeLevies = route.reduce((total, theme) => total + (Number(theme.L) || 0), 0);
  const routeChurch = route.reduce((total, theme) => total + (Number(theme.C) || 0), 0);

  features.push(state.currentInvasion ? 1 : 0);
  features.push(norm(low, 30));
  features.push(norm(high, 30));
  features.push(norm(midpoint, 30));
  features.push(norm(Math.max(0, high - low), 30));
  features.push(norm(route.length, 12));
  features.push(norm(occupied, routeCount));
  features.push(norm(free, routeCount));
  features.push(norm(selfOwned, routeCount));
  features.push(norm(otherOwned, routeCount));
  features.push(norm(churchOwned, routeCount));
  features.push(norm(routeProfit, 80));
  features.push(norm(routeTax, 80));
  features.push(norm(routeLevies, 80));
  features.push(norm(routeChurch, 80));
  features.push(route.some((theme) => theme.id === 'CPL') ? 1 : 0);
}

function pushTroopContext(features, state, playerId) {
  const self = officeTroopSnapshot(state, playerId);
  const all = (state.players || []).reduce((totals, player) => {
    const entry = officeTroopSnapshot(state, player.id);
    totals.professional += entry.professional;
    totals.levies += entry.levies;
    totals.mercenaries += entry.mercenaries;
    totals.total += entry.total;
    totals.offices += entry.offices;
    totals.movableOffices += entry.movableOffices;
    totals.lockedOffices += entry.lockedOffices;
    return totals;
  }, {
    professional: 0,
    levies: 0,
    mercenaries: 0,
    total: 0,
    offices: 0,
    movableOffices: 0,
    lockedOffices: 0,
  });

  features.push(norm(self.professional, 30));
  features.push(norm(self.levies, 40));
  features.push(norm(self.mercenaries, 10));
  features.push(norm(self.total, 50));
  features.push(norm(self.offices, 20));
  features.push(norm(self.movableOffices, 20));
  features.push(norm(self.lockedOffices, 20));
  features.push(norm(all.professional, 120));
  features.push(norm(all.levies, 160));
  features.push(norm(all.mercenaries, 40));
  features.push(norm(all.total, 220));
  features.push(norm(all.movableOffices, 60));
  features.push(norm(all.lockedOffices, 30));
}

export function encodeObservation(state, playerId) {
  const features = [];
  const scores = scoreByPlayer(state);
  const administration = administrationSnapshot(state);
  const categoryTotalsByKey = categoryTotals(state, administration);
  const selfScore = scores.get(playerId);
  const topScore = Math.max(0, ...[...scores.values()].map((entry) => Number(entry.points) || 0));

  oneHot(features, PHASES, state.phase);
  features.push(norm(state.players.length, MAX_PLAYERS));
  features.push(norm(state.round, Math.max(1, state.maxRounds || 1)));
  features.push(norm(Math.max(0, (state.maxRounds || 0) - (state.round || 0)), Math.max(1, state.maxRounds || 1)));
  features.push(norm(state.invasionDeck?.length || 0, Math.max(1, state.maxRounds || 1)));
  features.push(state.gameOver?.type === 'fall' ? 1 : 0);
  features.push(state.gameOver && state.gameOver.type !== 'fall' ? 1 : 0);
  features.push(state.pendingTitleReassignment ? 1 : 0);
  features.push(norm(state.pendingDefenderRewards?.filter((reward) => !reward.resolved).length || 0, 12));
  features.push(norm(state.currentInvasion?.strength?.[0] || 0, 30));
  features.push(norm(state.currentInvasion?.strength?.[1] || 0, 30));
  features.push(norm(state.invasionStrength || 0, 30));
  features.push(norm(selfScore?.points || 0, 12));
  features.push(norm(topScore, 12));
  features.push(norm((MAX_PLAYERS + 1) - (selfScore?.rank || MAX_PLAYERS), MAX_PLAYERS));
  pushInvasionContext(features, state, playerId);
  pushTroopContext(features, state, playerId);

  for (const relativeId of relativePlayerIds(state, playerId)) {
    const player = Number.isInteger(relativeId) ? getPlayer(state, relativeId) : null;
    const score = player ? scores.get(relativeId) : null;
    const categories = player ? categoryValuesForPlayer(state, administration, relativeId) : {};
    features.push(player ? 1 : 0);
    features.push(relativeId === playerId ? 1 : 0);
    features.push(norm(player?.gold || 0, 60));
    features.push(norm(score?.points || 0, 12));
    features.push(norm(administration.income?.[relativeId] || 0, 40));
    for (const key of SCORE_CATEGORY_KEYS) {
      features.push(norm(categories[key] || 0, key === 'gold' ? 60 : 40));
      features.push(norm(categories[key] || 0, Math.max(1, categoryTotalsByKey[key] || 1)));
    }
    features.push(relativeId === state.basileusId ? 1 : 0);
    for (const titleKey of TITLE_KEYS) features.push(player?.majorTitles?.includes(titleKey) ? 1 : 0);
    features.push(state.empress === relativeId ? 1 : 0);
    features.push(state.chiefEunuchs === relativeId ? 1 : 0);
    features.push(norm(sumProfessionalTroops(player), 30));
    features.push(norm(sumControlledLevies(state, relativeId), 40));
    features.push(norm(getPlayerMercenaryTroops(state, relativeId), 10));
    features.push(norm(countOwnedThemes(state, relativeId), 40));
    features.push(norm(getStrategosThemes(state, relativeId).length, 40));
    features.push(norm(getBishopThemes(state, relativeId).length, 40));
  }

  const route = new Set(state.currentInvasion?.route || []);
  for (const region of REGION_KEYS) {
    const themes = Object.values(state.themes || {}).filter((theme) => theme.region === region && theme.id !== 'CPL');
    const free = themes.filter((theme) => !theme.occupied && theme.owner === null).length;
    const selfOwned = themes.filter((theme) => !theme.occupied && theme.owner === playerId).length;
    const otherOwned = themes.filter((theme) => !theme.occupied && Number.isInteger(theme.owner) && theme.owner !== playerId).length;
    const churchOwned = themes.filter((theme) => !theme.occupied && theme.owner === 'church').length;
    const occupied = themes.filter((theme) => theme.occupied).length;
    const threatened = themes.filter((theme) => route.has(theme.id) && !theme.occupied).length;
    const profit = themes.reduce((total, theme) => total + (Number(theme.P) || 0), 0);
    const tax = themes.reduce((total, theme) => total + (Number(theme.T) || 0), 0);
    features.push(norm(free, themes.length || 1));
    features.push(norm(selfOwned, themes.length || 1));
    features.push(norm(otherOwned, themes.length || 1));
    features.push(norm(churchOwned, themes.length || 1));
    features.push(norm(occupied, themes.length || 1));
    features.push(norm(threatened, themes.length || 1));
    features.push(norm(profit, 80));
    features.push(norm(tax, 80));
  }

  return toFixedSize(features, OBSERVATION_SIZE);
}

function actionThemeFeatures(state, action) {
  const theme = state.themes?.[getActionThemeId(action)];
  if (!theme) return Array(24).fill(0);
  const values = [];
  const route = state.currentInvasion?.route || [];
  const routeIndex = route.indexOf(theme.id);
  oneHot(values, REGION_KEYS, theme.region);
  values.push(theme.owner === action.playerId ? 1 : 0);
  values.push(Number.isInteger(theme.owner) && theme.owner !== action.playerId ? 1 : 0);
  values.push(theme.owner === 'church' ? 1 : 0);
  values.push(theme.owner == null ? 1 : 0);
  values.push(theme.occupied ? 1 : 0);
  values.push(routeIndex >= 0 ? 1 : 0);
  values.push(routeIndex >= 0 ? norm(routeIndex + 1, Math.max(1, route.length)) : 0);
  values.push(theme.id === 'CPL' ? 1 : 0);
  values.push(theme.strategos == null ? 1 : 0);
  values.push(theme.strategos === action.playerId ? 1 : 0);
  values.push(Number.isInteger(theme.strategos) && theme.strategos !== action.playerId ? 1 : 0);
  values.push(theme.bishop == null ? 1 : 0);
  values.push(theme.bishop === action.playerId ? 1 : 0);
  values.push(Number.isInteger(theme.bishop) && theme.bishop !== action.playerId ? 1 : 0);
  values.push(norm(theme.P || 0, 12));
  values.push(norm(theme.T || 0, 12));
  values.push(norm(theme.L || 0, 12));
  values.push(norm(theme.C || 0, 12));
  values.push(norm((Number(theme.P) || 0) + (Number(theme.T) || 0) + (Number(theme.L) || 0) + (Number(theme.C) || 0), 36));
  return values;
}

function actionOrderFeatures(state, playerId, action) {
  const orders = action.orders || {};
  const officeKeys = getPlayerOrderOfficeKeys(state, playerId);
  const troopSnapshot = officeTroopSnapshot(state, playerId, orders);
  let frontier = 0;
  let capital = 0;
  for (const officeKey of officeKeys) {
    const destination = isCapitalLockedOfficeKey(officeKey)
      ? 'capital'
      : (orders.deployments?.[officeKey] || 'frontier');
    if (destination === 'capital') capital += 1;
    else frontier += 1;
  }
  const total = Math.max(1, officeKeys.length);
  const troopTotal = Math.max(1, troopSnapshot.frontierTroops + troopSnapshot.capitalTroops);
  const candidate = Number.isInteger(orders.candidate) ? getPlayer(state, orders.candidate) : null;
  const candidateScore = Number.isInteger(orders.candidate)
    ? scoreByPlayer(state).get(orders.candidate)
    : null;
  return [
    norm(frontier, total),
    norm(capital, total),
    norm(troopSnapshot.frontierTroops, 60),
    norm(troopSnapshot.capitalTroops, 60),
    norm(troopSnapshot.frontierTroops, troopTotal),
    norm(troopSnapshot.capitalTroops, troopTotal),
    norm(troopSnapshot.professional, 30),
    norm(troopSnapshot.levies, 40),
    norm(troopSnapshot.mercenaries, 10),
    norm(troopSnapshot.movableOffices, 20),
    norm(troopSnapshot.lockedOffices, 20),
    orders.candidate === playerId ? 1 : 0,
    orders.candidate === state.basileusId ? 1 : 0,
    norm(candidate?.gold || 0, 60),
    norm(candidateScore?.points || 0, 12),
    norm(candidate?.majorTitles?.length || 0, TITLE_KEYS.length),
    ...relativePlayerOneHot(state, playerId, orders.candidate),
  ];
}

function relativePlayerOneHot(state, viewerId, targetId) {
  const index = relativeIndex(state, viewerId, Number(targetId));
  return Array.from({ length: MAX_PLAYERS }, (_, i) => i === index ? 1 : 0);
}

function firstDealClause(action) {
  return action?.payload?.clauses?.[0] || null;
}

function dealClauses(action) {
  return Array.isArray(action?.payload?.clauses) ? action.payload.clauses : [];
}

function clauseAmount(clause = {}) {
  if (clause.kind === 'gold') return Number(clause.amount ?? clause.payload?.totalAmount) || 0;
  if (clause.kind === 'coup_support' || clause.kind === 'frontier_support') {
    return Number(clause.troopCount ?? clause.payload?.troopCount) || 0;
  }
  if (clause.kind === 'appointment_promise') return Number(clause.appointmentCount ?? clause.payload?.appointmentCount) || 1;
  if (clause.kind === 'non_revocation') return Number(clause.durationTurns ?? clause.turns) || 1;
  if (clause.kind === 'estate') return 4;
  return 1;
}

function actionDealShape(action) {
  const totals = {
    clauseCount: 0,
    goldGiven: 0,
    goldAsked: 0,
    troopPromised: 0,
    troopAsked: 0,
    estateGiven: 0,
    estateAsked: 0,
    protectionGiven: 0,
    protectionAsked: 0,
    thronebound: 0,
  };
  for (const clause of dealClauses(action)) {
    totals.clauseCount += 1;
    const amount = clauseAmount(clause);
    const give = clause.direction === 'give';
    const ask = clause.direction === 'ask';
    if (clause.startTriggerType === 'when_player_is_basileus') totals.thronebound += 1;
    if (clause.kind === 'gold') {
      if (give) totals.goldGiven += amount;
      if (ask) totals.goldAsked += amount;
    } else if (clause.kind === 'coup_support' || clause.kind === 'frontier_support') {
      if (give) totals.troopPromised += amount;
      if (ask) totals.troopAsked += amount;
    } else if (clause.kind === 'estate') {
      if (give) totals.estateGiven += 1;
      if (ask) totals.estateAsked += 1;
    } else if (clause.kind === 'non_revocation') {
      if (give) totals.protectionGiven += amount;
      if (ask) totals.protectionAsked += amount;
    }
  }
  return totals;
}

function estimateActionScale(action) {
  if (!action) return 0;
  if (action.kind === 'court-confirm') return 0;
  if (action.kind === 'orders') {
    const orders = action.orders || {};
    return Object.keys(orders.deployments || {}).length || 1;
  }
  if (action.kind === 'reward') return action.choice === 'empire' ? 4 : 2;
  if (action.kind === 'title-assignment') return Object.keys(action.assignments || {}).length || 1;
  if (action.kind !== 'court') return 1;
  const courtAction = action.payload?.action;
  if (courtAction === 'buy') return Number(action.payload?.amount) || 1;
  if (courtAction === 'hire-mercenaries' || courtAction === 'dismiss') return Number(action.payload?.count) || 1;
  if (courtAction === 'recruit') return 3;
  if (courtAction === 'gift' || courtAction === 'revoke') return 4;
  if (courtAction === 'basileus-appoint' || courtAction === 'appoint-strategos' || courtAction === 'appoint-bishop') return 3;
  if (courtAction?.startsWith('deal-')) {
    return dealClauses(action).reduce((total, clause) => total + Math.max(1, clauseAmount(clause)), 0);
  }
  return 1;
}

function actionRewardFeatures(state, action) {
  if (action?.kind !== 'reward') return Array(8).fill(0);
  const reward = (state.pendingDefenderRewards || []).find((entry) => entry.id === action.rewardId);
  const theme = state.themes?.[reward?.themeId || reward?.originalThemeId];
  return [
    norm(reward?.rank || 0, MAX_PLAYERS),
    norm(reward?.troops || 0, 60),
    norm(reward?.goldValue || 0, 30),
    norm(reward?.reconquestIndex || 0, 12),
    norm(theme?.P || 0, 12),
    norm(theme?.T || 0, 12),
    norm(theme?.L || 0, 12),
    norm(theme?.C || 0, 12),
  ];
}

function actionMagnitudeFeatures(state, playerId, action, clause) {
  const amount = Number(action?.payload?.amount || action?.payload?.count || clause?.amount || clause?.troopCount || 0) || 0;
  const player = getPlayer(state, playerId);
  const spendable = Math.max(0, Number(player?.gold) || 0);
  const dealShape = actionDealShape(action);
  const netGold = dealShape.goldAsked - dealShape.goldGiven;
  const netTroops = dealShape.troopAsked - dealShape.troopPromised;
  const netEstates = dealShape.estateAsked - dealShape.estateGiven;
  const scale = estimateActionScale(action);
  return [
    norm(amount, 20),
    norm(clause?.durationTurns || 0, 5),
    norm(spendable, 60),
    amount > 0 ? norm(amount, Math.max(1, spendable)) : 0,
    spendable >= amount && amount > 0 ? 1 : 0,
    norm(dealShape.clauseCount, 4),
    dealShape.clauseCount > 1 ? 1 : 0,
    norm(dealShape.goldGiven, 20),
    norm(dealShape.goldAsked, 20),
    norm(netGold, 20),
    norm(dealShape.troopPromised, 20),
    norm(dealShape.troopAsked, 20),
    norm(netTroops, 20),
    norm(netEstates, 4),
    norm(dealShape.protectionGiven - dealShape.protectionAsked, 5),
    norm(dealShape.thronebound, 4),
    norm(scale, 20),
    scale >= 6 ? 1 : 0,
    action?.kind === 'court-confirm' ? 0 : 1,
  ];
}

export function encodeAction(state, playerId, action) {
  const features = [];
  const payloadAction = action?.payload?.action || (action?.kind === 'court-confirm' ? 'confirm-court' : '');
  const clause = firstDealClause(action);

  oneHot(features, ACTION_KINDS, action?.kind);
  oneHot(features, COURT_ACTIONS, payloadAction);
  features.push(...relativePlayerOneHot(state, playerId, getActionTargetPlayerId(state, action)));
  features.push(...actionThemeFeatures(state, action));
  features.push(...actionMagnitudeFeatures(state, playerId, action, clause));

  features.push(...actionOrderFeatures(state, playerId, action));
  features.push(...actionRewardFeatures(state, action));

  oneHot(features, DEAL_KINDS, clause?.kind || '');
  features.push(clause?.direction === 'give' ? 1 : 0);
  features.push(clause?.direction === 'ask' ? 1 : 0);
  features.push(clause?.startTriggerType === 'when_player_is_basileus' ? 1 : 0);
  features.push(Number.isInteger(clause?.candidateId) ? 1 : 0);
  features.push(...relativePlayerOneHot(state, playerId, clause?.candidateId));

  features.push(action?.choice === 'empire' ? 1 : 0);
  features.push(action?.choice === 'gold' ? 1 : 0);

  const assignmentCounts = new Map();
  for (const targetId of Object.values(action?.assignments || {})) {
    assignmentCounts.set(Number(targetId), (assignmentCounts.get(Number(targetId)) || 0) + 1);
  }
  for (const relativeId of relativePlayerIds(state, playerId)) {
    features.push(norm(assignmentCounts.get(relativeId) || 0, TITLE_KEYS.length));
  }

  return toFixedSize(features, ACTION_FEATURE_SIZE);
}

export function buildNetworkInput(state, playerId, action) {
  const observation = encodeObservation(state, playerId);
  const actionFeatures = encodeAction(state, playerId, action);
  const input = new Float64Array(NETWORK_INPUT_SIZE);
  input.set(observation, 0);
  input.set(actionFeatures, OBSERVATION_SIZE);
  return input;
}

export function buildCandidateInputs(state, playerId, actions) {
  return actions.map((action) => buildNetworkInput(state, playerId, action));
}
