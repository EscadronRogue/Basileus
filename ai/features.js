import { runAdministration } from '../engine/cascade.js';
import {
  buildFinalScores,
  SCORE_CATEGORIES,
  SCORE_SHARE_THRESHOLDS,
} from '../engine/scoring.js';
import {
  getBishopThemes,
  getOfficeHolder,
  getPlayer,
  getPlayerMercenaryTroops,
  getPlayerThemes,
  getStrategosThemes,
  MERCENARY_COMPANY_KEY,
} from '../engine/state.js';
import {
  getPlayerOrderOfficeKeys,
  isCapitalLockedOfficeKey,
} from '../engine/orders.js';
import { MAJOR_TITLES } from '../data/titles.js';
import {
  applyLegalAction,
  getActionTargetPlayerId,
  getActionThemeId,
} from './legalActions.js';

export const FEATURE_SCHEMA = 'basileus.semantic-action-features.v1';
export const SCORE_CATEGORY_KEYS = SCORE_CATEGORIES.map((category) => category.key);
export const OFFICIAL_MAX_SCORE = SCORE_CATEGORIES.length * SCORE_SHARE_THRESHOLDS.length;
export const FEATURE_UNIT = 1;

const FEATURE_MIN = -FEATURE_UNIT;
const FEATURE_MAX = FEATURE_UNIT;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampFeature(value) {
  const number = finiteNumber(value);
  return Math.max(FEATURE_MIN, Math.min(FEATURE_MAX, number));
}

function addFeature(features, key, value = FEATURE_UNIT) {
  const number = clampFeature(value);
  if (number === 0) return;
  features[key] = (features[key] || 0) + number;
}

function divideByObservedTotal(value, total) {
  const denominator = Math.abs(finiteNumber(total));
  if (denominator <= Number.EPSILON) return 0;
  return clampFeature(finiteNumber(value) / denominator);
}

function deltaShare(before, after, denominator) {
  return divideByObservedTotal(finiteNumber(after) - finiteNumber(before), denominator);
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

function actionAfterState(state, action) {
  const clone = cloneForAnalysis(state);
  const result = applyLegalAction(clone, action, null);
  return result.ok ? clone : null;
}

function officialScoreForPlayer(state, playerId) {
  try {
    const final = buildFinalScores(state);
    const scores = new Map(final.scores.map((entry, index) => [
      entry.playerId,
      { ...entry, rank: index + 1 },
    ]));
    const score = scores.get(playerId) || null;
    return {
      final,
      score,
      points: finiteNumber(score?.points),
      rank: finiteNumber(score?.rank, state.players.length),
      rankShare: state.players.length <= 1
        ? FEATURE_UNIT
        : FEATURE_UNIT - ((finiteNumber(score?.rank, state.players.length) - FEATURE_UNIT) / (state.players.length - FEATURE_UNIT)),
      categories: Object.fromEntries(SCORE_CATEGORY_KEYS.map((key) => {
        const entry = score?.categories?.find((category) => category.key === key);
        return [key, {
          value: finiteNumber(entry?.value),
          totalValue: finiteNumber(entry?.totalValue),
          share: finiteNumber(entry?.share),
          points: finiteNumber(entry?.points),
          pointShare: divideByObservedTotal(entry?.points || 0, SCORE_SHARE_THRESHOLDS.length),
        }];
      })),
    };
  } catch {
    return {
      final: null,
      score: null,
      points: 0,
      rank: state.players.length,
      rankShare: 0,
      categories: Object.fromEntries(SCORE_CATEGORY_KEYS.map((key) => [key, {
        value: 0,
        totalValue: 0,
        share: 0,
        points: 0,
        pointShare: 0,
      }])),
    };
  }
}

function administrationFor(state) {
  try {
    return runAdministration(state);
  } catch {
    return { income: {}, incomeBreakdown: {} };
  }
}

function incomeValuesForPlayer(state, administration, playerId) {
  const player = getPlayer(state, playerId);
  return {
    church: Math.max(0, finiteNumber(administration.incomeBreakdown?.church?.[playerId])),
    estate: Math.max(0, finiteNumber(administration.incomeBreakdown?.estate?.[playerId])),
    tax: Math.max(0, finiteNumber(administration.incomeBreakdown?.tax?.[playerId])),
    gold: Math.max(0, finiteNumber(player?.gold)),
  };
}

function incomeTotals(state, administration) {
  const totals = Object.fromEntries(SCORE_CATEGORY_KEYS.map((key) => [key, 0]));
  for (const player of state.players || []) {
    const values = incomeValuesForPlayer(state, administration, player.id);
    for (const key of SCORE_CATEGORY_KEYS) totals[key] += values[key];
  }
  return totals;
}

function ownedThemeTotals(state, playerId) {
  const owned = getPlayerThemes(state, playerId).filter((theme) => !theme.occupied);
  return owned.reduce((totals, theme) => {
    totals.count += FEATURE_UNIT;
    totals.profit += Math.max(0, finiteNumber(theme.P));
    totals.tax += Math.max(0, finiteNumber(theme.T));
    totals.levies += Math.max(0, finiteNumber(theme.L));
    totals.church += Math.max(0, finiteNumber(theme.C));
    return totals;
  }, {
    count: 0,
    profit: 0,
    tax: 0,
    levies: 0,
    church: 0,
  });
}

function themeUniverseTotals(state) {
  return Object.values(state.themes || {}).reduce((totals, theme) => {
    if (!theme || theme.id === 'CPL') return totals;
    totals.count += FEATURE_UNIT;
    totals.profit += Math.max(0, finiteNumber(theme.P));
    totals.tax += Math.max(0, finiteNumber(theme.T));
    totals.levies += Math.max(0, finiteNumber(theme.L));
    totals.church += Math.max(0, finiteNumber(theme.C));
    return totals;
  }, {
    count: 0,
    profit: 0,
    tax: 0,
    levies: 0,
    church: 0,
  });
}

function sumProfessionalTroops(player) {
  return Object.values(player?.professionalArmies || {})
    .reduce((total, count) => total + Math.max(0, finiteNumber(count)), 0);
}

function troopSnapshot(state, playerId, orders = null) {
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
    frontier: 0,
    capital: 0,
  };

  for (const officeKey of officeKeys) {
    const locked = isCapitalLockedOfficeKey(officeKey);
    if (locked) out.lockedOffices += FEATURE_UNIT;
    else out.movableOffices += FEATURE_UNIT;

    const professional = officeKey === MERCENARY_COMPANY_KEY
      ? 0
      : Math.max(0, finiteNumber(player?.professionalArmies?.[officeKey]));
    const levies = officeKey === MERCENARY_COMPANY_KEY
      ? 0
      : (getOfficeHolder(state, officeKey) === playerId
        ? Math.max(0, finiteNumber(state.currentLevies?.[officeKey]))
        : 0);
    const mercenaries = officeKey === MERCENARY_COMPANY_KEY
      ? getPlayerMercenaryTroops(state, playerId)
      : 0;
    const total = professional + levies + mercenaries;

    out.professional += professional;
    out.levies += levies;
    out.mercenaries += mercenaries;
    out.total += total;

    if (orders) {
      const destination = locked ? 'capital' : (orders.deployments?.[officeKey] || 'frontier');
      out[destination === 'capital' ? 'capital' : 'frontier'] += total;
    }
  }

  return out;
}

function allTroops(state) {
  return (state.players || []).reduce((total, player) => total + troopSnapshot(state, player.id).total, 0);
}

function invasionRequiredTroops(state) {
  const [low, high] = state.currentInvasion?.strength || [0, 0];
  const estimateValues = [finiteNumber(low), finiteNumber(high)].filter((value) => value > 0);
  if (!estimateValues.length) return 0;
  return estimateValues.reduce((sum, value) => sum + value, 0) / estimateValues.length;
}

function resourceMetrics(state, playerId) {
  const administration = administrationFor(state);
  const totals = incomeTotals(state, administration);
  const values = incomeValuesForPlayer(state, administration, playerId);
  const universe = themeUniverseTotals(state);
  const owned = ownedThemeTotals(state, playerId);
  const player = getPlayer(state, playerId);
  const troopTotal = allTroops(state);
  const troops = troopSnapshot(state, playerId);

  return {
    income: Object.fromEntries(SCORE_CATEGORY_KEYS.map((key) => [key, {
      value: values[key],
      share: divideByObservedTotal(values[key], totals[key]),
    }])),
    owned,
    ownedShare: {
      count: divideByObservedTotal(owned.count, universe.count),
      profit: divideByObservedTotal(owned.profit, universe.profit),
      tax: divideByObservedTotal(owned.tax, universe.tax),
      levies: divideByObservedTotal(owned.levies, universe.levies),
      church: divideByObservedTotal(owned.church, universe.church),
    },
    titles: {
      major: divideByObservedTotal(player?.majorTitles?.length || 0, Object.keys(MAJOR_TITLES).length),
      strategos: divideByObservedTotal(getStrategosThemes(state, playerId).length, universe.count),
      bishop: divideByObservedTotal(getBishopThemes(state, playerId).length, universe.count),
      isBasileus: state.basileusId === playerId ? FEATURE_UNIT : 0,
    },
    troops: {
      ...troops,
      share: divideByObservedTotal(troops.total, troopTotal),
      professionalShare: divideByObservedTotal(troops.professional, troopTotal),
    },
    gold: Math.max(0, finiteNumber(player?.gold)),
  };
}

function addScoreDeltaFeatures(features, before, after) {
  addFeature(features, 'score.delta.totalPoints', deltaShare(before.points, after.points, OFFICIAL_MAX_SCORE));
  addFeature(features, 'score.delta.rank', after.rankShare - before.rankShare);
  for (const key of SCORE_CATEGORY_KEYS) {
    addFeature(features, `score.delta.${key}.share`, after.categories[key].share - before.categories[key].share);
    addFeature(
      features,
      `score.delta.${key}.points`,
      divideByObservedTotal(after.categories[key].points - before.categories[key].points, SCORE_SHARE_THRESHOLDS.length),
    );
  }
}

function addResourceDeltaFeatures(features, before, after) {
  for (const key of SCORE_CATEGORY_KEYS) {
    addFeature(features, `income.delta.${key}.share`, after.income[key].share - before.income[key].share);
  }
  for (const key of ['count', 'profit', 'tax', 'levies', 'church']) {
    addFeature(features, `estate.delta.${key}.share`, after.ownedShare[key] - before.ownedShare[key]);
  }
  addFeature(features, 'power.delta.majorTitleShare', after.titles.major - before.titles.major);
  addFeature(features, 'power.delta.strategosShare', after.titles.strategos - before.titles.strategos);
  addFeature(features, 'power.delta.bishopShare', after.titles.bishop - before.titles.bishop);
  addFeature(features, 'military.delta.troopShare', after.troops.share - before.troops.share);
  addFeature(features, 'military.delta.professionalShare', after.troops.professionalShare - before.troops.professionalShare);

  const goldDenominator = Math.max(before.gold, after.gold, FEATURE_UNIT);
  addFeature(features, 'treasury.delta.goldShare', deltaShare(before.gold, after.gold, goldDenominator));
  addFeature(features, 'treasury.spendShare', before.gold > after.gold ? deltaShare(after.gold, before.gold, goldDenominator) : 0);
}

function actionPhaseName(action) {
  if (action?.kind === 'court-confirm') return 'court';
  return action?.phase || action?.kind || 'unknown';
}

function addThemeFeatures(features, state, action) {
  const theme = state.themes?.[getActionThemeId(action)];
  if (!theme) return;
  const universe = themeUniverseTotals(state);
  addFeature(features, `theme.region.${theme.region}`, FEATURE_UNIT);
  addFeature(features, 'theme.owner.self', theme.owner === action.playerId ? FEATURE_UNIT : 0);
  addFeature(features, 'theme.owner.rival', Number.isInteger(theme.owner) && theme.owner !== action.playerId ? FEATURE_UNIT : 0);
  addFeature(features, 'theme.owner.church', theme.owner === 'church' ? FEATURE_UNIT : 0);
  addFeature(features, 'theme.owner.free', theme.owner == null ? FEATURE_UNIT : 0);
  addFeature(features, 'theme.occupied', theme.occupied ? FEATURE_UNIT : 0);
  addFeature(features, 'theme.threatened', state.currentInvasion?.route?.includes(theme.id) ? FEATURE_UNIT : 0);
  addFeature(features, 'theme.isCapital', theme.id === 'CPL' ? FEATURE_UNIT : 0);
  addFeature(features, 'theme.profitShare', divideByObservedTotal(theme.P, universe.profit));
  addFeature(features, 'theme.taxShare', divideByObservedTotal(theme.T, universe.tax));
  addFeature(features, 'theme.levyShare', divideByObservedTotal(theme.L, universe.levies));
  addFeature(features, 'theme.churchShare', divideByObservedTotal(theme.C, universe.church));
}

function addTargetFeatures(features, state, playerId, action) {
  const targetId = getActionTargetPlayerId(state, action);
  if (!Number.isInteger(targetId)) return;
  const self = officialScoreForPlayer(state, playerId);
  const target = officialScoreForPlayer(state, targetId);
  const final = self.final;
  const topScore = finiteNumber(final?.topScore);
  addFeature(features, 'target.self', targetId === playerId ? FEATURE_UNIT : 0);
  addFeature(features, 'target.basileus', targetId === state.basileusId ? FEATURE_UNIT : 0);
  addFeature(features, 'target.leadingScore', target.points === topScore && topScore > 0 ? FEATURE_UNIT : 0);
  addFeature(features, 'target.scoreGapVsSelf', divideByObservedTotal(target.points - self.points, OFFICIAL_MAX_SCORE));
}

function addOrderFeatures(features, state, playerId, action) {
  if (action?.kind !== 'orders') return;
  const split = troopSnapshot(state, playerId, action.orders);
  const required = invasionRequiredTroops(state);
  const totalCommitted = split.frontier + split.capital;
  addFeature(features, 'orders.frontierTroopShare', divideByObservedTotal(split.frontier, totalCommitted));
  addFeature(features, 'orders.capitalTroopShare', divideByObservedTotal(split.capital, totalCommitted));
  addFeature(features, 'orders.frontierCoverage', divideByObservedTotal(split.frontier, required));
  addFeature(features, 'orders.candidate.self', action.orders?.candidate === playerId ? FEATURE_UNIT : 0);
  addFeature(features, 'orders.candidate.currentBasileus', action.orders?.candidate === state.basileusId ? FEATURE_UNIT : 0);
  addFeature(features, 'orders.frontierNeedExists', required > 0 ? FEATURE_UNIT : 0);
}

function addRewardFeatures(features, action) {
  if (action?.kind !== 'reward') return;
  addFeature(features, 'reward.restoreEmpire', action.choice === 'empire' ? FEATURE_UNIT : 0);
  addFeature(features, 'reward.takeGold', action.choice === 'gold' ? FEATURE_UNIT : 0);
}

function addTitleAssignmentFeatures(features, state, playerId, action) {
  if (action?.kind !== 'title-assignment') return;
  const assignments = Object.values(action.assignments || {});
  addFeature(features, 'titleAssignment.countShare', divideByObservedTotal(assignments.length, Object.keys(MAJOR_TITLES).length));
  const selfScore = officialScoreForPlayer(state, playerId);
  let giftsToLeader = 0;
  for (const targetId of assignments) {
    const targetScore = officialScoreForPlayer(state, targetId);
    if (targetScore.points >= selfScore.points) giftsToLeader += FEATURE_UNIT;
  }
  addFeature(features, 'titleAssignment.giftsToHigherScorers', divideByObservedTotal(giftsToLeader, assignments.length));
}

function addBeforeContextFeatures(features, state, playerId) {
  const score = officialScoreForPlayer(state, playerId);
  const resources = resourceMetrics(state, playerId);
  addFeature(features, `phase.${state.phase || 'unknown'}`, FEATURE_UNIT);
  addFeature(features, 'context.roundProgress', divideByObservedTotal(state.round || 0, state.maxRounds || 0));
  addFeature(features, 'context.roundsRemaining', divideByObservedTotal((state.maxRounds || 0) - (state.round || 0), state.maxRounds || 0));
  addFeature(features, 'context.empireThreatened', state.currentInvasion ? FEATURE_UNIT : 0);
  addFeature(features, 'context.playerCountShare', divideByObservedTotal(state.players?.length || 0, state.players?.length || 0));
  addFeature(features, 'self.basileus', resources.titles.isBasileus);
  addFeature(features, 'score.current.totalPointShare', divideByObservedTotal(score.points, OFFICIAL_MAX_SCORE));
  addFeature(features, 'score.current.rankShare', score.rankShare);
  addFeature(features, 'self.scoreShare', divideByObservedTotal(score.points, OFFICIAL_MAX_SCORE));
  addFeature(features, 'self.rankShare', score.rankShare);
  addFeature(features, 'self.troopShare', resources.troops.share);
  addFeature(features, 'self.majorTitleShare', resources.titles.major);
}

export function buildActionFeatureMap(state, playerId, action) {
  const features = {};
  addFeature(features, 'bias', FEATURE_UNIT);
  addBeforeContextFeatures(features, state, playerId);

  addFeature(features, `action.kind.${action?.kind || 'unknown'}`, FEATURE_UNIT);
  addFeature(features, `action.phase.${actionPhaseName(action)}`, FEATURE_UNIT);
  if (action?.kind === 'court') addFeature(features, `court.${action.payload?.action || 'unknown'}`, FEATURE_UNIT);
  if (action?.kind === 'court-confirm') addFeature(features, 'court.confirm', FEATURE_UNIT);

  addThemeFeatures(features, state, action);
  addTargetFeatures(features, state, playerId, action);
  addOrderFeatures(features, state, playerId, action);
  addRewardFeatures(features, action);
  addTitleAssignmentFeatures(features, state, playerId, action);

  const beforeScore = officialScoreForPlayer(state, playerId);
  const beforeResources = resourceMetrics(state, playerId);
  const afterState = actionAfterState(state, action);
  if (afterState) {
    addScoreDeltaFeatures(features, beforeScore, officialScoreForPlayer(afterState, playerId));
    addResourceDeltaFeatures(features, beforeResources, resourceMetrics(afterState, playerId));
  }

  return features;
}

export function buildCandidateFeatures(state, playerId, actions) {
  return actions.map((action) => buildActionFeatureMap(state, playerId, action));
}

export function featureNames(featureMap) {
  return Object.keys(featureMap || {}).sort();
}

export function mergeFeatureNames(featureMaps = []) {
  return [...new Set(featureMaps.flatMap((features) => featureNames(features)))].sort();
}

// Compatibility name for older callers: these are semantic feature maps now,
// not dense tensors.
export const buildCandidateInputs = buildCandidateFeatures;
