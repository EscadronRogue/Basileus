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
export const OBSERVATION_SIZE = 192;
export const ACTION_FEATURE_SIZE = 96;
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

function administrationSnapshot(state) {
  try {
    return runAdministration(state);
  } catch {
    return { income: {}, incomeBreakdown: {} };
  }
}

export function encodeObservation(state, playerId) {
  const features = [];
  const scores = scoreByPlayer(state);
  const administration = administrationSnapshot(state);
  const selfScore = scores.get(playerId);
  const topScore = Math.max(0, ...[...scores.values()].map((entry) => Number(entry.points) || 0));

  oneHot(features, PHASES, state.phase);
  features.push(norm(state.players.length, MAX_PLAYERS));
  features.push(norm(state.round, Math.max(1, state.maxRounds || 1)));
  features.push(norm(state.invasionDeck?.length || 0, Math.max(1, state.maxRounds || 1)));
  features.push(state.gameOver?.type === 'fall' ? 1 : 0);
  features.push(state.gameOver && state.gameOver.type !== 'fall' ? 1 : 0);
  features.push(state.pendingTitleReassignment ? 1 : 0);
  features.push(norm(state.currentInvasion?.strength?.[0] || 0, 30));
  features.push(norm(state.currentInvasion?.strength?.[1] || 0, 30));
  features.push(norm(state.invasionStrength || 0, 30));
  features.push(norm(selfScore?.points || 0, 12));
  features.push(norm(topScore, 12));
  features.push(norm((MAX_PLAYERS + 1) - (selfScore?.rank || MAX_PLAYERS), MAX_PLAYERS));

  for (const relativeId of relativePlayerIds(state, playerId)) {
    const player = Number.isInteger(relativeId) ? getPlayer(state, relativeId) : null;
    const score = player ? scores.get(relativeId) : null;
    features.push(player ? 1 : 0);
    features.push(relativeId === playerId ? 1 : 0);
    features.push(norm(player?.gold || 0, 60));
    features.push(norm(score?.points || 0, 12));
    features.push(norm(administration.income?.[relativeId] || 0, 40));
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
  if (!theme) return Array(12).fill(0);
  const values = [];
  oneHot(values, REGION_KEYS, theme.region);
  values.push(theme.owner === action.playerId ? 1 : 0);
  values.push(Number.isInteger(theme.owner) && theme.owner !== action.playerId ? 1 : 0);
  values.push(theme.owner === 'church' ? 1 : 0);
  values.push(theme.owner == null ? 1 : 0);
  values.push(theme.occupied ? 1 : 0);
  values.push(norm(theme.P || 0, 12));
  values.push(norm(theme.T || 0, 12));
  values.push(norm(theme.L || 0, 12));
  values.push(norm(theme.C || 0, 12));
  return values;
}

function actionOrderFeatures(state, playerId, action) {
  const orders = action.orders || {};
  const officeKeys = getPlayerOrderOfficeKeys(state, playerId);
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
  return [
    norm(frontier, total),
    norm(capital, total),
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

export function encodeAction(state, playerId, action) {
  const features = [];
  const payloadAction = action?.payload?.action || (action?.kind === 'court-confirm' ? 'confirm-court' : '');
  const clause = firstDealClause(action);

  oneHot(features, ACTION_KINDS, action?.kind);
  oneHot(features, COURT_ACTIONS, payloadAction);
  features.push(...relativePlayerOneHot(state, playerId, getActionTargetPlayerId(state, action)));
  features.push(...actionThemeFeatures(state, action));
  features.push(norm(action?.payload?.amount || action?.payload?.count || clause?.amount || clause?.troopCount || 0, 20));
  features.push(norm(clause?.durationTurns || 0, 5));

  features.push(...actionOrderFeatures(state, playerId, action));

  oneHot(features, DEAL_KINDS, clause?.kind || '');
  features.push(clause?.direction === 'give' ? 1 : 0);
  features.push(clause?.direction === 'ask' ? 1 : 0);
  features.push(clause?.startTriggerType === 'when_player_is_basileus' ? 1 : 0);

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
