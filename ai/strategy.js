import { runIncome, readTroopEntry } from '../engine/cascade.js';
import { resolveInvasion } from '../engine/combat.js';
import { getMercenaryHireCost } from '../engine/rules.js';
import { buildFinalScores, SCORE_SHARE_THRESHOLDS } from '../engine/scoring.js';
import { getOfficeHolder, getPlayer } from '../engine/state.js';
import { MAJOR_TITLES } from '../data/titles.js';
import {
  applyLegalAction,
  getActionThemeId,
  getActionTargetPlayerId,
  listLegalCourtActions,
  listLegalEstateActions,
  listLegalOrderActions,
  listLegalRewardActions,
  listLegalTitleAssignments,
} from './legalActions.js';

const COURT_GAIN_FLOOR = 0.35;
const ESTATE_GAIN_FLOOR = 0.2;
const MAX_ESTATE_BIDS_PER_AI = 3;

export const DEFAULT_STRATEGY_WEIGHTS = Object.freeze({
  ownRecipientBonus: 3,
  leaderDenial: 1.2,
  rivalDenial: 0.35,
  courtGainFloor: COURT_GAIN_FLOOR,
  estateGainFloor: ESTATE_GAIN_FLOOR,
  estateProfit: 4,
  estateBidCost: 1.15,
  estateThreatPenalty: 1.5,
  invasionMargin: 0.9,
  capitalFallPenalty: 420,
  capitalRiskPenalty: 120,
  invasionVictoryBonus: 6,
  invasionDefeatPenalty: 8,
  recoveryBonus: 0.8,
  throneBase: 18,
  throneProgress: 34,
  selfClaim: 1,
  incumbentDefense: 1,
  supportLeaderPenalty: 0.9,
  supportOtherClaimant: 0.6,
  reserveValue: 0.25,
  mercenaryCostPenalty: 0.12,
});

function getStrategyWeights(meta, playerId) {
  return {
    ...DEFAULT_STRATEGY_WEIGHTS,
    ...(meta?.strategyWeights || {}),
    ...(meta?.players?.[playerId]?.strategyWeights || {}),
  };
}

function cloneStateForAI(state) {
  let clone;
  try {
    clone = structuredClone({ ...state, rng: null });
  } catch {
    clone = JSON.parse(JSON.stringify(state));
    if (state.courtActions) {
      clone.courtActions = {
        ...clone.courtActions,
        playerConfirmed: new Set([...(state.courtActions.playerConfirmed || new Set())]),
      };
    }
  }
  clone.rng = state.rng;
  return clone;
}

function materializeAuctions(state) {
  for (const auction of Object.values(state.landAuctions || {})) {
    const theme = state.themes?.[auction.themeId];
    const bidderId = Number(auction.bidderId);
    if (!theme || theme.id === 'CPL' || theme.occupied || theme.owner != null) continue;
    if (!state.players.some((player) => player.id === bidderId)) continue;
    theme.owner = bidderId;
  }
}

function projectedScoring(state, options = {}) {
  const projected = cloneStateForAI(state);
  materializeAuctions(projected);
  const income = runIncome(projected);
  if (options.addIncomeGold !== false) {
    for (const [playerId, amount] of Object.entries(income.income || {})) {
      const player = getPlayer(projected, Number(playerId));
      if (player) player.gold += Number(amount) || 0;
    }
  }
  projected.lastIncome = income;
  return buildFinalScores(projected);
}

function scoreEntry(final, playerId) {
  return final.scores.find((entry) => entry.playerId === playerId) || null;
}

function thresholdPressure(category) {
  const share = Math.max(0, Number(category?.share) || 0);
  let value = 0;
  for (const threshold of SCORE_SHARE_THRESHOLDS) {
    if (share >= threshold) {
      value += 1.2;
      if (share - threshold < 0.04) value += 1.8;
      continue;
    }
    const gap = threshold - share;
    if (gap < 0.08) value += (0.08 - gap) * 70;
  }
  return value;
}

function scoreStrategicPosition(state, playerId) {
  const final = projectedScoring(state, {
    addIncomeGold: state.phase !== 'scoring' && !state.gameOver,
  });
  const own = scoreEntry(final, playerId);
  if (!own) return -Infinity;
  const rivals = final.scores.filter((entry) => entry.playerId !== playerId);
  const bestRival = rivals[0] || null;
  const rank = final.scores.findIndex((entry) => entry.playerId === playerId);
  const progress = Math.max(0, Math.min(1, (Number(state.round) || 0) / Math.max(1, Number(state.maxRounds) || 1)));

  let value = own.points * 95;
  value += (final.scores.length - rank) * 8;
  value += Math.max(0, Number(own.gold) || 0) * 0.45;
  value += Math.max(0, Number(own.projectedIncome) || 0) * 0.5;
  if (bestRival) {
    value += (own.points - bestRival.points) * 34;
    value += ((Number(own.gold) || 0) - (Number(bestRival.gold) || 0)) * 0.18;
  }
  value -= rivals.reduce((total, rival) => total + rival.points, 0) * 3;

  for (const category of own.categories || []) {
    value += category.points * 18;
    value += Math.max(0, Number(category.share) || 0) * 12;
    value += thresholdPressure(category);
  }

  if (playerId === state.basileusId) value += 16 + progress * 20;
  if (state.gameOver?.type === 'fall') value -= 260;
  return value;
}

function currentLeaderId(state, excludePlayerId = null) {
  const final = projectedScoring(state);
  return getLeaderIdFromScores(final, excludePlayerId);
}

function getLeaderIdFromScores(final, excludePlayerId = null) {
  const leader = final.scores.find((entry) => entry.playerId !== excludePlayerId) || final.scores[0];
  return leader?.playerId ?? null;
}

function categoryFor(final, playerId, categoryKey) {
  return scoreEntry(final, playerId)?.categories?.find((entry) => entry.key === categoryKey) || null;
}

function scoreResourceGain(final, playerId, categoryKey, amount) {
  const category = categoryFor(final, playerId, categoryKey);
  if (!category || amount <= 0) return 0;
  const total = Math.max(0, Number(category.totalValue) || 0);
  const value = Math.max(0, Number(category.value) || 0);
  const before = thresholdPressure(category) + (Number(category.points) || 0) * 20;
  const nextTotal = total + amount;
  const nextValue = value + amount;
  const nextShare = nextTotal > 0 ? nextValue / nextTotal : 0;
  const nextCategory = {
    ...category,
    value: nextValue,
    totalValue: nextTotal,
    share: nextShare,
    points: SCORE_SHARE_THRESHOLDS.filter((threshold) => nextShare >= threshold).length,
  };
  const after = thresholdPressure(nextCategory) + nextCategory.points * 20;
  return after - before + amount * 0.8;
}

function scoreRecipientGain(final, playerId, recipientId, leaderId, categoryKey, amount, weights = DEFAULT_STRATEGY_WEIGHTS) {
  const value = scoreResourceGain(final, recipientId, categoryKey, amount);
  if (recipientId === playerId) return value + weights.ownRecipientBonus;
  if (recipientId === leaderId) return -value * weights.leaderDenial - 4;
  return -value * weights.rivalDenial;
}

function scoreCourtIntent(state, final, playerId, action, leaderId = getLeaderIdFromScores(final, playerId), weights = DEFAULT_STRATEGY_WEIGHTS) {
  const payloadAction = String(action?.payload?.action || '');
  const targetId = getActionTargetPlayerId(state, action);
  const themeId = getActionThemeId(action);
  const theme = themeId ? state.themes?.[themeId] : null;

  if (payloadAction === 'appoint-strategos') {
    return scoreRecipientGain(final, playerId, targetId, leaderId, 'strategos', Math.max(1, Number(theme?.T ?? theme?.origin?.T) || 1), weights);
  }
  if (payloadAction === 'appoint-bishop') {
    return scoreRecipientGain(final, playerId, targetId, leaderId, 'church', Math.max(1, Number(theme?.C ?? theme?.origin?.C) || 1), weights);
  }
  if (payloadAction === 'appoint-court') {
    if (targetId === playerId) return 4;
    if (targetId === leaderId) return -5;
    return -0.5;
  }

  if (payloadAction === 'revoke') {
    if (targetId === playerId) return -100;
    let deniedValue = 1.5;
    if (action.payload?.value?.startsWith('minor:') && action.payload?.value?.endsWith(':strategos')) {
      deniedValue += scoreResourceGain(final, targetId, 'strategos', Math.max(1, Number(theme?.T ?? theme?.origin?.T) || 1));
    } else if (action.payload?.value?.startsWith('minor:') && action.payload?.value?.endsWith(':bishop')) {
      deniedValue += scoreResourceGain(final, targetId, 'church', Math.max(1, Number(theme?.C ?? theme?.origin?.C) || 1));
    } else if (action.payload?.value?.startsWith('theme:')) {
      deniedValue += scoreResourceGain(final, targetId, 'estate', Math.max(1, Number(theme?.P ?? theme?.origin?.P) || 1));
    }
    if (targetId === leaderId) return deniedValue * weights.leaderDenial + 3;
    return deniedValue * weights.rivalDenial;
  }
  return 0;
}

function scoreAppliedAction(state, playerId, action, options = {}) {
  const trial = cloneStateForAI(state);
  const result = applyLegalAction(trial, action, null);
  if (!result.ok) return null;
  let score = scoreStrategicPosition(trial, playerId);
  if (options.includeCourtIntent) score += scoreCourtIntent(state, options.courtFinal, playerId, action, options.courtLeaderId);
  if (options.extraScore) score += options.extraScore(trial, action) || 0;
  return { action, score, result };
}

function chooseScoredAction(state, playerId, actions, options = {}) {
  const scored = actions
    .map((action) => scoreAppliedAction(state, playerId, action, options))
    .filter(Boolean)
    .sort((left, right) => (
      (right.score - left.score)
      || String(left.action.id).localeCompare(String(right.action.id))
    ));
  return scored[0] || null;
}

export function chooseStrategicTitleAssignment(state, meta, basileusId = state?.basileusId) {
  void meta;
  const actions = listLegalTitleAssignments(state, basileusId);
  const final = projectedScoring(state);
  const leaderId = getLeaderIdFromScores(final, basileusId);
  const weights = getStrategyWeights(meta, basileusId);
  return actions
    .map((action) => ({ action, score: scoreTitleAssignment(state, final, basileusId, leaderId, action, weights) }))
    .sort((left, right) => (
      (right.score - left.score)
      || String(left.action.id).localeCompare(String(right.action.id))
    ))[0]?.action || actions[0] || null;
}

function estimateTitleYield(state, titleKey) {
  if (titleKey === 'PATRIARCH') {
    return Object.values(state.themes || {}).reduce((total, theme) => {
      if (!theme || theme.id === 'CPL' || theme.bishop != null) return total;
      return total + Math.max(0, Number(theme.C ?? theme.origin?.C) || 0);
    }, 0);
  }
  const region = MAJOR_TITLES[titleKey]?.region;
  if (!region) return 0;
  const pool = Object.values(state.themes || {}).reduce((total, theme) => {
    if (!theme || theme.id === 'CPL' || theme.occupied || theme.region !== region || theme.strategos != null) return total;
    return total + Math.max(0, Number(theme.T ?? theme.origin?.T) || 0);
  }, 0);
  return Math.ceil(pool * 2 / 3);
}

function scoreTitleAssignment(state, final, basileusId, leaderId, action, weights) {
  let score = 0;
  for (const [titleKey, holderId] of Object.entries(action.assignments || {})) {
    const categoryKey = titleKey === 'PATRIARCH' ? 'church' : 'strategos';
    const amount = estimateTitleYield(state, titleKey);
    score += scoreRecipientGain(final, basileusId, Number(holderId), leaderId, categoryKey, amount, weights);
    if (Number(holderId) === leaderId) score -= 5;
  }
  return score;
}

export function chooseStrategicCourtAction(state, meta, playerId) {
  void meta;
  const actions = listLegalCourtActions(state, playerId);
  const confirmation = actions.find((action) => action.kind === 'court-confirm')
    || actions.find((action) => action.payload?.action === 'skip')
    || null;
  const candidates = actions.filter((action) => (
    action.kind !== 'court-confirm'
    && action.payload?.action !== 'skip'
  ));
  if (!candidates.length) return confirmation;

  const final = projectedScoring(state);
  const leaderId = getLeaderIdFromScores(final, playerId);
  const weights = getStrategyWeights(meta, playerId);
  const best = candidates
    .map((action) => ({ action, score: scoreCourtIntent(state, final, playerId, action, leaderId, weights) }))
    .sort((left, right) => (
      (right.score - left.score)
      || String(left.action.id).localeCompare(String(right.action.id))
    ))[0] || null;
  if (best && best.score > weights.courtGainFloor) return best.action;
  return confirmation;
}

function orderOfficeKeys(state, playerId) {
  return Object.keys(state.currentTroops || {})
    .filter((officeKey) => getOfficeHolder(state, officeKey) === playerId)
    .sort((left, right) => left.localeCompare(right));
}

function summarizeOrders(state, playerId, orders = {}) {
  let capitalTroops = 0;
  let frontierTroops = 0;
  let fundedTroops = 0;
  let idleTroops = 0;

  for (const officeKey of orderOfficeKeys(state, playerId)) {
    const pool = readTroopEntry(state.currentTroops?.[officeKey]);
    const total = pool.normal + pool.capitalLocked;
    const order = orders.armies?.[officeKey] || {};
    const funded = Math.max(0, Math.min(total, Number(order.funded) || 0));
    const fundedLocked = Math.min(pool.capitalLocked, funded);
    const fundedNormal = Math.min(pool.normal, Math.max(0, funded - fundedLocked));
    const destination = order.destination === 'capital' ? 'capital' : 'frontier';
    capitalTroops += fundedLocked + (destination === 'capital' ? fundedNormal : 0);
    frontierTroops += destination === 'frontier' ? fundedNormal : 0;
    fundedTroops += funded;
    idleTroops += total - funded;
  }

  const mercCount = Math.max(0, Math.min(10, Number(orders.mercenaries?.count) || 0));
  if (orders.mercenaries?.destination === 'capital') capitalTroops += mercCount;
  else frontierTroops += mercCount;

  return {
    candidate: Number.isInteger(Number(orders.candidate)) ? Number(orders.candidate) : state.basileusId,
    capitalTroops,
    frontierTroops,
    fundedTroops,
    idleTroops,
    mercCount,
    mercCost: getMercenaryHireCost(0, mercCount),
  };
}

function estimateOtherDeployment(state, playerId) {
  const invasion = state.currentInvasion;
  const estimate = Array.isArray(invasion?.strength)
    ? (Number(invasion.strength[0]) + Number(invasion.strength[1])) / 2
    : 0;
  const frontierRatio = invasion ? Math.max(0.38, Math.min(0.72, 0.46 + estimate / 80)) : 0.35;
  const capitalRatio = invasion ? 0.22 : 0.34;
  let frontierTroops = 0;
  let maxCapitalTroops = 0;
  let incumbentCapitalTroops = 0;
  let contributingPlayers = 0;

  for (const player of state.players || []) {
    if (player.id === playerId) continue;
    const total = orderOfficeKeys(state, player.id).reduce((sum, officeKey) => {
      const entry = readTroopEntry(state.currentTroops?.[officeKey]);
      return sum + entry.normal + entry.capitalLocked;
    }, 0);
    if (total <= 0) continue;
    contributingPlayers += 1;
    frontierTroops += total * frontierRatio;
    const expectedCapital = total * capitalRatio;
    maxCapitalTroops = Math.max(maxCapitalTroops, expectedCapital);
    if (player.id === state.basileusId) incumbentCapitalTroops += expectedCapital;
  }

  return {
    frontierTroops,
    maxCapitalTroops,
    incumbentCapitalTroops,
    averageFrontierTroops: contributingPlayers ? frontierTroops / contributingPlayers : 0,
  };
}

function estimateInvasionStrength(invasion) {
  if (!Array.isArray(invasion?.strength)) return 0;
  return Math.ceil((Number(invasion.strength[0]) + Number(invasion.strength[1])) / 2);
}

function themeStake(state, playerId, themeId) {
  const theme = state.themes?.[themeId];
  if (!theme) return 0;
  let value = 0;
  if (theme.owner === playerId) value += 5;
  if (theme.strategos === playerId) value += 3;
  if (theme.bishop === playerId) value += 2.5;
  if (theme.owner != null && theme.owner !== playerId) value -= 0.6;
  if (theme.strategos != null && theme.strategos !== playerId) value -= 0.4;
  if (theme.bishop != null && theme.bishop !== playerId) value -= 0.35;
  return value;
}

function scoreWarPlan(state, playerId, summary, estimates, weights) {
  const invasion = state.currentInvasion;
  if (!invasion) return 0;
  const totalFrontier = summary.frontierTroops + estimates.frontierTroops;
  const expectedStrength = estimateInvasionStrength(invasion);
  const highStrength = Math.max(expectedStrength, Number(invasion.strength?.[1]) || expectedStrength);
  const expected = resolveInvasion(state, totalFrontier, expectedStrength, invasion);
  const high = resolveInvasion(state, totalFrontier, highStrength, invasion);
  const margin = totalFrontier - expectedStrength;

  let value = Math.max(-28, Math.min(24, margin)) * weights.invasionMargin;
  if (expected.reachedCPL) value -= weights.capitalFallPenalty;
  else if (high.reachedCPL) value -= weights.capitalRiskPenalty;
  if (expected.outcome === 'victory') value += weights.invasionVictoryBonus;
  if (expected.outcome === 'defeat') value -= weights.invasionDefeatPenalty;

  for (const themeId of expected.themesLost || []) value -= themeStake(state, playerId, themeId);
  for (const themeId of expected.themesRecovered || []) value += Math.max(0.5, themeStake(state, playerId, themeId) * 0.5);

  if (summary.frontierTroops > 0 && expected.themesRecovered?.length) {
    value += Math.min(summary.frontierTroops, 8) * weights.recoveryBonus;
    if (summary.frontierTroops >= estimates.averageFrontierTroops) value += expected.themesRecovered.length * 3;
  }
  return value;
}

function scoreCoupPlan(state, playerId, summary, estimates, leaderId = currentLeaderId(state, playerId), weights = DEFAULT_STRATEGY_WEIGHTS) {
  const progress = Math.max(0, Math.min(1, (Number(state.round) || 0) / Math.max(1, Number(state.maxRounds) || 1)));
  const throneValue = weights.throneBase + progress * weights.throneProgress;

  if (summary.candidate === playerId) {
    const rivalCapital = Math.max(estimates.maxCapitalTroops, estimates.incumbentCapitalTroops);
    if (summary.capitalTroops > rivalCapital + 0.5) return throneValue * weights.selfClaim;
    if (summary.capitalTroops > 0) return (summary.capitalTroops / (rivalCapital + 1)) * throneValue * 0.45 * weights.selfClaim;
    return -5;
  }

  if (summary.candidate === state.basileusId) {
    if (playerId === state.basileusId) return summary.capitalTroops * (1.5 + progress) * weights.incumbentDefense;
    if (state.basileusId === leaderId) return -summary.capitalTroops * weights.supportLeaderPenalty;
    return summary.capitalTroops * 0.25 * weights.incumbentDefense;
  }

  if (summary.candidate === leaderId) return -summary.capitalTroops * weights.supportLeaderPenalty * 1.35;
  return summary.capitalTroops * weights.supportOtherClaimant;
}

function scoreDeploymentTactics(state, playerId, action, context = {}) {
  const summary = summarizeOrders(state, playerId, action.orders);
  const estimates = estimateOtherDeployment(state, playerId);
  const weights = context.weights || DEFAULT_STRATEGY_WEIGHTS;
  let value = scoreWarPlan(state, playerId, summary, estimates, weights);
  value += scoreCoupPlan(state, playerId, summary, estimates, context.leaderId, weights);
  value += Math.min(summary.idleTroops, 10) * weights.reserveValue;
  value -= summary.mercCost * weights.mercenaryCostPenalty;
  return value;
}

export function chooseStrategicOrderAction(state, meta, playerId) {
  void meta;
  const actions = listLegalOrderActions(state, playerId);
  const context = { leaderId: currentLeaderId(state, playerId), weights: getStrategyWeights(meta, playerId) };
  return actions
    .map((action) => ({ action, score: scoreDeploymentTactics(state, playerId, action, context) }))
    .sort((left, right) => (
      (right.score - left.score)
      || String(left.action.id).localeCompare(String(right.action.id))
    ))[0]?.action || null;
}

export function describeOrderChoice(state, playerId, action) {
  const summary = summarizeOrders(state, playerId, action?.orders || {});
  const invasion = state.currentInvasion;
  return {
    title: 'Strategic deployment',
    factors: [
      {
        label: 'frontier',
        value: Math.round(summary.frontierTroops),
        impact: invasion ? 'positive' : 'neutral',
        note: invasion ? `${invasion.name} estimate ${invasion.strength?.join('-')}` : 'No active invasion pressure.',
      },
      {
        label: 'capital',
        value: Math.round(summary.capitalTroops),
        impact: summary.candidate === playerId ? 'positive' : 'neutral',
        note: summary.candidate === playerId ? 'Backing its own claim to the throne.' : 'Supporting the selected claimant.',
      },
      {
        label: 'reserve',
        value: summary.idleTroops - summary.mercCost,
        impact: summary.idleTroops >= summary.mercCost ? 'positive' : 'negative',
        note: 'Idle troop gold minus mercenary cost.',
      },
    ],
  };
}

export function chooseStrategicEstateActions(state, meta, playerId) {
  void meta;
  const chosen = [];
  let planningState = cloneStateForAI(state);
  for (let step = 0; step < MAX_ESTATE_BIDS_PER_AI; step += 1) {
    const actions = listLegalEstateActions(planningState, playerId);
    if (!actions.length) break;
    const final = projectedScoring(planningState);
    const weights = getStrategyWeights(meta, playerId);
    const best = actions
      .map((action) => ({ action, score: scoreEstateAction(planningState, final, playerId, action, weights) }))
      .sort((left, right) => (
        (right.score - left.score)
        || String(left.action.id).localeCompare(String(right.action.id))
      ))[0] || null;
    if (!best || best.score <= weights.estateGainFloor) break;
    chosen.push(best.action);
    const result = applyLegalAction(planningState, best.action, null);
    if (!result.ok) break;
  }
  return chosen;
}

function scoreEstateAction(state, final, playerId, action, weights) {
  const theme = state.themes?.[action.payload?.themeId];
  if (!theme) return -Infinity;
  const bid = Math.max(0, Number(action.payload?.amount) || 0);
  const profit = Math.max(1, Number(theme.P ?? theme.origin?.P) || 1);
  const threatened = Array.isArray(state.currentInvasion?.route)
    && state.currentInvasion.route.includes(theme.id);
  return scoreResourceGain(final, playerId, 'estate', profit) + profit * weights.estateProfit - bid * weights.estateBidCost - (threatened ? weights.estateThreatPenalty : 0);
}

export function chooseStrategicRewardChoice(state, meta, reward) {
  void meta;
  if (!reward) return 'empire';
  const actions = listLegalRewardActions(state, reward.defenderId)
    .filter((action) => action.rewardId === reward.id);
  const best = chooseScoredAction(state, reward.defenderId, actions, {
    extraScore: (trial, action) => {
      const theme = trial.themes?.[reward.themeId];
      if (action.choice === 'empire') return theme?.owner === reward.defenderId ? 2.5 : 0.8;
      return 0;
    },
  });
  return best?.action?.choice || 'empire';
}

export function applyStrategicEstateActions(state, meta, playerId) {
  const applied = [];
  for (const action of chooseStrategicEstateActions(state, meta, playerId)) {
    const result = applyLegalAction(state, action, meta);
    if (!result.ok) continue;
    applied.push(action);
  }
  return applied;
}
