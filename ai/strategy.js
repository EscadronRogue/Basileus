import { runIncome } from '../engine/cascade.js';
import { resolveInvasion } from '../engine/combat.js';
import { getMercenaryHireCost } from '../engine/rules.js';
import { buildFinalScores, getScorePointsForShare, SCORE_SHARE_THRESHOLDS } from '../engine/scoring.js';
import { getPlayer } from '../engine/state.js';
import {
  getDeploymentArmyTroopEntry,
  getDeploymentArmyTroopTotal,
  getPlayerDeploymentArmyKeys,
} from '../engine/deployment.js';
import { getCoupRankWeight, getPreferredCoupCandidate, normalizeCoupRanking, normalizeCoupSupport } from '../engine/coup.js';
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
import {
  getAiMemory,
  getPlayerMemory,
  getRelationship,
  relationshipScore,
} from './memory.js';

const COURT_GAIN_FLOOR = 0.35;
const ESTATE_GAIN_FLOOR = 0.2;
const MAX_ESTATE_BIDS_PER_AI = 3;
const SCORE_TIE_EPSILON = 0.001;

export const DEFAULT_STRATEGY_WEIGHTS = Object.freeze({
  ownRecipientBonus: 3,
  appointmentUnlockBonus: 4,
  leaderDenial: 1.2,
  rivalDenial: 0.35,
  courtGainFloor: COURT_GAIN_FLOOR,
  estateGainFloor: ESTATE_GAIN_FLOOR,
  estateProfit: 4,
  estateBidCost: 1.15,
  estateThreatPenalty: 1.5,
  invasionShortfallPenalty: 5.5,
  invasionSafetyValue: 1.2,
  invasionSurplusPenalty: 0.55,
  capitalFallPenalty: 760,
  capitalRiskPenalty: 260,
  recoveryBonus: 0.8,
  throneBase: 18,
  selfClaim: 1.1,
  incumbentDefense: 0.85,
  supportLeaderPenalty: 0.9,
  supportOtherClaimant: 0.6,
  reserveValue: 0.32,
  mercenaryCostPenalty: 0.12,
  reciprocityWeight: 0.6,
  grudgeWeight: 0.8,
  trustWeight: 0.35,
  favorSeekingWeight: 0.3,
  friendNeglectPenalty: 0.55,
  relationshipCap: 4.5,
  defenseContextWeight: 1.15,
  fundingContextWeight: 0.7,
  revocationContextWeight: 0.65,
  relationshipCoupWeight: 0.6,
  coupOpportunityWeight: 0.28,
  basileusTitleExpectation: 0.7,
  basileusRevocationFear: 0.8,
  backerTitleReward: 0.9,
  backerRevocationMercy: 0.9,
  allyDefenseReliance: 1,
  kingmakerPenalty: 0.25,
});

function getStrategyWeights(meta, playerId) {
  const overrides = {
    ...(meta?.strategyWeights || {}),
    ...(meta?.players?.[playerId]?.strategyWeights || {}),
  };
  const raw = {
    ...DEFAULT_STRATEGY_WEIGHTS,
    ...overrides,
  };
  if (overrides.invasionMargin != null && overrides.invasionShortfallPenalty == null) {
    raw.invasionShortfallPenalty = clamp(Number(overrides.invasionMargin), 0.35, 2.4) * 3.1;
  }
  if (overrides.frontierSurplusValue != null && overrides.invasionSafetyValue == null) {
    raw.invasionSafetyValue = clamp(Number(overrides.frontierSurplusValue), 0, 0.8) * 2.4;
  }
  if (overrides.surplusDefensePenalty != null && overrides.invasionSurplusPenalty == null) {
    raw.invasionSurplusPenalty = clamp(Number(overrides.surplusDefensePenalty), 0.05, 2.4);
  }
  return raw;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tieSeed(state, playerId, salt = '') {
  const rngState = typeof state?.rng?.getState === 'function' ? state.rng.getState() : 0;
  return `${state?.round ?? 0}:${state?.phase || ''}:${playerId}:${rngState}:${salt}`;
}

export function actionTieBreakValue(state, playerId, action, salt = '') {
  const identity = action?.id || JSON.stringify(action || {});
  return hashString(`${tieSeed(state, playerId, salt)}:${identity}`) / 0x100000000;
}

function neutralTieBreakValue(state, playerId, identity, salt = '') {
  return hashString(`${tieSeed(state, playerId, salt)}:${identity}`) / 0x100000000;
}

export function compareActionTieBreak(state, playerId, leftAction, rightAction, salt = '') {
  const left = actionTieBreakValue(state, playerId, leftAction, salt);
  const right = actionTieBreakValue(state, playerId, rightAction, salt);
  return (left - right) || String(leftAction?.id || '').localeCompare(String(rightAction?.id || ''));
}

function compareScoredActions(state, playerId, left, right, salt = '') {
  const diff = right.score - left.score;
  if (Math.abs(diff) > SCORE_TIE_EPSILON) return diff;
  return compareActionTieBreak(state, playerId, left.action, right.action, salt);
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

  if (playerId === state.basileusId) value += 16;
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
    points: getScorePointsForShare(nextShare),
  };
  const after = thresholdPressure(nextCategory) + nextCategory.points * 20;
  return after - before + amount * 0.8;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function scoreThreatPenalty(final, playerId, targetId, leaderId, weights = DEFAULT_STRATEGY_WEIGHTS) {
  if (!Number.isInteger(targetId) || targetId === playerId) return 0;
  const own = scoreEntry(final, playerId);
  const target = scoreEntry(final, targetId);
  if (!own || !target) return 0;
  let penalty = 0;
  if (targetId === leaderId) penalty += 1.8;
  const pointGap = (Number(target.points) || 0) - (Number(own.points) || 0);
  if (pointGap > 0) penalty += pointGap * 0.9;
  if ((Number(target.gold) || 0) > (Number(own.gold) || 0) + 3) penalty += 0.6;
  return penalty * Math.max(0.2, Number(weights.kingmakerPenalty) || 0);
}

function coupSupportGivenTo(memory, candidateId, supporterId) {
  if (!memory || candidateId === supporterId) return 0;
  return Math.max(0, Number(getRelationship(memory, candidateId, supporterId).coupSupport) || 0);
}

function scoreExpectedMajorTitlePatronage(state, final, supporterId) {
  void final;
  void supporterId;
  const titleKeys = Object.keys(MAJOR_TITLES);
  if (!titleKeys.length) return 0;
  const bestYield = titleKeys.reduce((best, titleKey) => Math.max(best, estimateTitleYield(state, titleKey)), 0);
  if (bestYield <= 0) return 0;
  return Math.min(16, bestYield) * 0.8;
}

function scoreBasileusPreference(state, memory, supporterId, candidateId, final, leaderId, weights) {
  if (!Number.isInteger(candidateId)) return 0;
  if (candidateId === supporterId) return weights.throneBase * weights.selfClaim;

  const relationToCandidate = getRelationship(memory, supporterId, candidateId);
  const candidatePattern = getPlayerMemory(memory, candidateId);
  const own = scoreEntry(final, supporterId);
  const candidate = scoreEntry(final, candidateId);
  const pointGap = candidate && own ? Math.max(0, (Number(candidate.points) || 0) - (Number(own.points) || 0)) : 0;
  const titleExpectation = scoreExpectedMajorTitlePatronage(state, final, supporterId)
    * weights.basileusTitleExpectation
    * (0.18 + (Number(candidatePattern.patronageGenerosity) || 0) * 0.85 + Math.max(0, relationToCandidate.trust) * 0.04);
  const revocationFear = (
    (Number(candidatePattern.revocationAggression) || 0) * 4
    + Math.max(0, Number(relationToCandidate.harm) || 0) * 0.45
    + Math.max(0, -Number(relationToCandidate.trust) || 0) * 0.35
  ) * weights.basileusRevocationFear;
  const relationship = scoreRelationshipModifier(memory, supporterId, candidateId, weights, 0.9);
  const leaderPenalty = candidateId === leaderId ? weights.supportLeaderPenalty * 2.4 : 0;
  return titleExpectation + relationship - revocationFear - leaderPenalty - pointGap * weights.kingmakerPenalty;
}

function scoreRelationshipModifier(memory, viewerId, otherId, weights = DEFAULT_STRATEGY_WEIGHTS, scale = 1) {
  if (!memory || viewerId === otherId || !Number.isInteger(otherId)) return 0;
  const rel = getRelationship(memory, viewerId, otherId);
  const raw = (rel.score * weights.reciprocityWeight)
    + (rel.trust * weights.trustWeight)
    - (rel.neglect * weights.friendNeglectPenalty);
  const cap = Math.max(0.5, Number(weights.relationshipCap) || DEFAULT_STRATEGY_WEIGHTS.relationshipCap);
  return clamp(raw * scale, -cap, cap);
}

function scoreFavorInvestment(memory, recipientId, weights = DEFAULT_STRATEGY_WEIGHTS, amount = 1) {
  if (!memory || !Number.isInteger(recipientId)) return 0;
  const pattern = getPlayerMemory(memory, recipientId);
  const generosity = Number(pattern.patronageGenerosity) || 0;
  const trustworthiness = Math.max(0, 1 - (Number(pattern.revocationAggression) || 0) * 0.35);
  return Math.min(2.5, Math.max(0, amount) * 0.28)
    * weights.favorSeekingWeight
    * (0.5 + generosity)
    * trustworthiness;
}

function scoreRecipientGain(final, playerId, recipientId, leaderId, categoryKey, amount, weights = DEFAULT_STRATEGY_WEIGHTS, context = {}) {
  const value = scoreResourceGain(final, recipientId, categoryKey, amount);
  if (recipientId === playerId) return value + weights.ownRecipientBonus;
  const relationship = scoreRelationshipModifier(context.memory, playerId, recipientId, weights, 0.65);
  const investment = recipientId === leaderId
    ? scoreFavorInvestment(context.memory, recipientId, weights, amount) * 0.25
    : scoreFavorInvestment(context.memory, recipientId, weights, amount);
  const threatPenalty = scoreThreatPenalty(final, playerId, recipientId, leaderId, weights);
  if (recipientId === leaderId) return -value * weights.leaderDenial - 4 + relationship + investment - threatPenalty;
  return -value * weights.rivalDenial + relationship + investment - threatPenalty;
}

function scoreAppointmentUnlock(state, playerId, recipientId, leaderId = null, weights = DEFAULT_STRATEGY_WEIGHTS) {
  if (!getPlayer(state, playerId)?.appointmentCooldown?.selfLocked) return 0;
  if (!Number.isInteger(recipientId) || recipientId === playerId) return 0;
  if (recipientId === leaderId) return 0;
  return weights.appointmentUnlockBonus;
}

function scoreRevocationRelationship(state, final, playerId, targetId, leaderId, weights = DEFAULT_STRATEGY_WEIGHTS, context = {}) {
  if (!Number.isInteger(targetId) || targetId === playerId) return 0;
  const rel = getRelationship(context.memory, playerId, targetId);
  const friendPenalty = Math.max(0, rel.score) * weights.reciprocityWeight * 0.85;
  const grudgeBonus = Math.max(0, rel.harm + rel.revokedMe * 0.5 - rel.favor * 0.3) * weights.grudgeWeight;
  const targetThreat = scoreThreatPenalty(final, playerId, targetId, leaderId, weights);
  const table = context.memory?.table || {};
  const tablePenalty = (table.overRevoking || 0) * weights.revocationContextWeight;
  const tableOpportunity = (table.underRevoking || 0)
    * weights.revocationContextWeight
    * (targetId === leaderId ? 1.2 : Math.min(0.8, Math.max(0, targetThreat)));
  const backerMercy = Math.min(6, coupSupportGivenTo(context.memory, playerId, targetId))
    * weights.backerRevocationMercy;
  return clamp(
    grudgeBonus + targetThreat + tableOpportunity - friendPenalty - tablePenalty - backerMercy,
    -weights.relationshipCap,
    weights.relationshipCap,
  );
}

function scoreCourtIntent(state, final, playerId, action, leaderId = getLeaderIdFromScores(final, playerId), weights = DEFAULT_STRATEGY_WEIGHTS, context = {}) {
  const payloadAction = String(action?.payload?.action || '');
  const targetId = getActionTargetPlayerId(state, action);
  const themeId = getActionThemeId(action);
  const theme = themeId ? state.themes?.[themeId] : null;

  if (payloadAction === 'appoint-strategos') {
    return scoreRecipientGain(final, playerId, targetId, leaderId, 'office', Math.max(1, Number(theme?.T ?? theme?.origin?.T) || 1), weights, context)
      + scoreAppointmentUnlock(state, playerId, targetId, leaderId, weights);
  }
  if (payloadAction === 'appoint-bishop') {
    return scoreRecipientGain(final, playerId, targetId, leaderId, 'office', Math.max(1, Number(theme?.C ?? theme?.origin?.C) || 1), weights, context)
      + scoreAppointmentUnlock(state, playerId, targetId, leaderId, weights);
  }
  if (payloadAction === 'revoke') {
    if (targetId === playerId) return -100;
    let deniedValue = 1.5;
    if (action.payload?.value?.startsWith('minor:') && action.payload?.value?.endsWith(':strategos')) {
      deniedValue += scoreResourceGain(final, targetId, 'office', Math.max(1, Number(theme?.T ?? theme?.origin?.T) || 1));
    } else if (action.payload?.value?.startsWith('minor:') && action.payload?.value?.endsWith(':bishop')) {
      deniedValue += scoreResourceGain(final, targetId, 'office', Math.max(1, Number(theme?.C ?? theme?.origin?.C) || 1));
    } else if (action.payload?.value?.startsWith('theme:')) {
      deniedValue += scoreResourceGain(final, targetId, 'estate', Math.max(1, Number(theme?.P ?? theme?.origin?.P) || 1));
    }
    const relationship = scoreRevocationRelationship(state, final, playerId, targetId, leaderId, weights, context);
    if (targetId === leaderId) return deniedValue * weights.leaderDenial + 3 + relationship;
    return deniedValue * weights.rivalDenial + relationship;
  }
  return 0;
}

function scoreAppliedAction(state, playerId, action, options = {}) {
  const trial = cloneStateForAI(state);
  const result = applyLegalAction(trial, action, null);
  if (!result.ok) return null;
  let score = scoreStrategicPosition(trial, playerId);
  if (options.includeCourtIntent) {
    score += scoreCourtIntent(state, options.courtFinal, playerId, action, options.courtLeaderId, options.weights, options);
  }
  if (options.extraScore) score += options.extraScore(trial, action) || 0;
  return { action, score, result };
}

function chooseScoredAction(state, playerId, actions, options = {}) {
  const scored = actions
    .map((action) => scoreAppliedAction(state, playerId, action, options))
    .filter(Boolean)
    .sort((left, right) => compareScoredActions(state, playerId, left, right, options.tieSalt || 'scored'));
  return scored[0] || null;
}

export function chooseStrategicTitleAssignment(state, meta, basileusId = state?.basileusId) {
  const actions = listLegalTitleAssignments(state, basileusId);
  const final = projectedScoring(state);
  const leaderId = getLeaderIdFromScores(final, basileusId);
  const weights = getStrategyWeights(meta, basileusId);
  const memory = getAiMemory(state, meta);
  const context = { memory };
  return actions
    .map((action) => ({ action, score: scoreTitleAssignment(state, final, basileusId, leaderId, action, weights, context) }))
    .sort((left, right) => compareScoredActions(state, basileusId, left, right, 'title-assignment'))[0]?.action || actions[0] || null;
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

function scoreTitleAssignment(state, final, basileusId, leaderId, action, weights, context = {}) {
  let score = 0;
  for (const [titleKey, holderId] of Object.entries(action.assignments || {})) {
    const amount = estimateTitleYield(state, titleKey);
    const recipientId = Number(holderId);
    const support = Math.min(6, coupSupportGivenTo(context.memory, basileusId, recipientId));
    const titlePower = Math.max(1, amount);
    score += scoreRecipientGain(final, basileusId, recipientId, leaderId, 'office', amount, weights, context);
    score += support * weights.backerTitleReward * (0.65 + Math.min(12, titlePower) / 12);
    if (recipientId === leaderId) score -= 5 + titlePower * weights.kingmakerPenalty;
  }
  return score;
}

export function chooseStrategicCourtAction(state, meta, playerId) {
  const actions = listLegalCourtActions(state, playerId);
  const confirmation = actions.find((action) => action.kind === 'court-confirm')
    || actions.find((action) => action.payload?.action === 'skip')
    || actions.find((action) => action.payload?.action === 'pass-court-power')
    || null;
  const candidates = actions.filter((action) => (
    action.kind !== 'court-confirm'
    && action.payload?.action !== 'skip'
    && action.payload?.action !== 'pass-court-power'
    && action.payload?.action !== 'pass'
  ));
  if (!candidates.length) return confirmation;

  const final = projectedScoring(state);
  const leaderId = getLeaderIdFromScores(final, playerId);
  const weights = getStrategyWeights(meta, playerId);
  const memory = getAiMemory(state, meta);
  const context = { memory };
  const best = candidates
    .map((action) => ({ action, score: scoreCourtIntent(state, final, playerId, action, leaderId, weights, context) }))
    .sort((left, right) => compareScoredActions(state, playerId, left, right, 'court'))[0] || null;
  if (best && best.score > weights.courtGainFloor) return best.action;
  return confirmation;
}

function orderOfficeKeys(state, playerId) {
  return getPlayerDeploymentArmyKeys(state, playerId);
}

function summarizeOrders(state, playerId, orders = {}) {
  let capitalTroops = 0;
  let frontierTroops = 0;
  let fundedTroops = 0;
  let idleTroops = 0;

  for (const officeKey of orderOfficeKeys(state, playerId)) {
    const pool = getDeploymentArmyTroopEntry(state, playerId, officeKey);
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

  const ranking = normalizeCoupRanking(state, playerId, orders.ranking, orders.candidate);
  const candidateSupport = normalizeCoupSupport(state, orders.candidateSupport);
  return {
    candidate: Number.isInteger(Number(orders.candidate))
      ? Number(orders.candidate)
      : getPreferredCoupCandidate(state, playerId, { ...orders, ranking, candidateSupport }),
    ranking,
    candidateSupport,
    capitalTroops,
    frontierTroops,
    fundedTroops,
    idleTroops,
    mercCount,
    mercCost: getMercenaryHireCost(0, mercCount),
  };
}

function getMaxMercenariesForBudget(budget) {
  let count = 0;
  while (count < 10 && getMercenaryHireCost(0, count + 1) <= budget) count += 1;
  return count;
}

function estimatePotentialCapitalTroops(state, playerId) {
  const officeTroops = orderOfficeKeys(state, playerId).reduce((sum, officeKey) => {
    return sum + getDeploymentArmyTroopTotal(state, playerId, officeKey);
  }, 0);
  const gold = Math.max(0, Number(getPlayer(state, playerId)?.gold) || 0);
  return officeTroops + getMaxMercenariesForBudget(gold);
}

function patternAdjustedDeploymentRatios(state, playerId, playerMemory, table) {
  const invasion = state.currentInvasion;
  const estimate = Array.isArray(invasion?.strength)
    ? (Number(invasion.strength[0]) + Number(invasion.strength[1])) / 2
    : 0;
  const baseFrontierRatio = invasion ? Math.max(0.38, Math.min(0.72, 0.46 + estimate / 80)) : 0.35;
  const baseCapitalRatio = invasion ? 0.22 : 0.34;
  if (!playerMemory || playerMemory.orders <= 0) {
    return { frontierRatio: baseFrontierRatio, capitalRatio: baseCapitalRatio };
  }
  const frontierRatio = clamp(
    baseFrontierRatio * 0.45
      + playerMemory.defenseReliability * 0.42
      - playerMemory.fundingGreed * 0.18
      + (table?.underDefense || 0) * 0.08,
    0.12,
    0.86,
  );
  const capitalRatio = clamp(
    baseCapitalRatio * 0.45
      + playerMemory.coupPressure * 0.34
      + (table?.overCouping || 0) * 0.08
      - playerMemory.fundingGreed * 0.08,
    0.05,
    0.78,
  );
  return { frontierRatio, capitalRatio };
}

function estimateOtherDeployment(state, playerId, memory = null) {
  let frontierTroops = 0;
  let maxCapitalTroops = 0;
  let incumbentCapitalTroops = 0;
  let contributingPlayers = 0;

  for (const player of state.players || []) {
    if (player.id === playerId) continue;
    const ratios = patternAdjustedDeploymentRatios(state, player.id, getPlayerMemory(memory, player.id), memory?.table);
    const total = orderOfficeKeys(state, player.id).reduce((sum, officeKey) => {
      return sum + getDeploymentArmyTroopTotal(state, player.id, officeKey);
    }, 0);
    if (total <= 0) continue;
    contributingPlayers += 1;
    frontierTroops += total * ratios.frontierRatio;
    const expectedCapital = total * ratios.capitalRatio;
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

function estimateHighInvasionStrength(invasion) {
  const expected = estimateInvasionStrength(invasion);
  return Math.max(expected, Number(invasion?.strength?.[1]) || expected);
}

function estimateRecoveryCost(state, invasion) {
  if (!Array.isArray(invasion?.route)) return 0;
  const occupied = new Set(
    Object.values(state.themes || {})
      .filter((theme) => theme?.occupied)
      .map((theme) => theme.id),
  );
  let cost = 0;
  let nextCost = 1;
  for (const themeId of invasion.route.slice().reverse()) {
    if (themeId === 'CPL') continue;
    if (!occupied.has(themeId)) continue;
    cost += nextCost;
    nextCost += 1;
  }
  return cost;
}

function usefulFrontierTarget(state, invasion, highStrength) {
  return highStrength + Math.min(6, estimateRecoveryCost(state, invasion));
}

function reliableEstimatedFrontier(estimates, weights) {
  const reliance = clamp(
    Number(weights.allyDefenseReliance) || DEFAULT_STRATEGY_WEIGHTS.allyDefenseReliance,
    0.45,
    1,
  );
  return Math.max(0, Number(estimates?.frontierTroops) || 0) * reliance;
}

function scoreFrontierDiscipline(totalFrontier, expectedStrength, targetFrontier, weights) {
  const shortfall = Math.max(0, expectedStrength - totalFrontier);
  const safeMargin = Math.max(0, Math.min(totalFrontier, targetFrontier) - expectedStrength);
  const surplus = Math.max(0, totalFrontier - targetFrontier);
  return -shortfall * weights.invasionShortfallPenalty
    + safeMargin * weights.invasionSafetyValue
    - surplus * weights.invasionSurplusPenalty;
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

function scoreWarPlan(state, playerId, summary, estimates, weights, context = {}) {
  const invasion = state.currentInvasion;
  if (!invasion) return 0;
  const totalFrontier = summary.frontierTroops + reliableEstimatedFrontier(estimates, weights);
  const expectedStrength = estimateInvasionStrength(invasion);
  const highStrength = estimateHighInvasionStrength(invasion);
  const expected = resolveInvasion(state, totalFrontier, expectedStrength, invasion);
  const high = resolveInvasion(state, totalFrontier, highStrength, invasion);
  const targetFrontier = usefulFrontierTarget(state, invasion, highStrength);

  let value = scoreFrontierDiscipline(totalFrontier, expectedStrength, targetFrontier, weights);
  if (expected.reachedCPL) value -= weights.capitalFallPenalty;
  else if (high.reachedCPL) value -= weights.capitalRiskPenalty;

  for (const themeId of expected.themesLost || []) value -= themeStake(state, playerId, themeId);
  for (const themeId of expected.themesRecovered || []) value += Math.max(0.5, themeStake(state, playerId, themeId) * 0.5);

  const recoveredCount = Array.isArray(expected.themesRecovered) ? expected.themesRecovered.length : 0;
  const rewardProvinceCount = Math.max(recoveredCount, Number(expected.reconquestRewardProvinceCount) || 0);
  if (summary.frontierTroops > 0 && recoveredCount) {
    value += Math.min(summary.frontierTroops, 8) * weights.recoveryBonus;
    if (summary.frontierTroops >= estimates.averageFrontierTroops) value += rewardProvinceCount * 3;
  } else if (summary.frontierTroops > 0 && rewardProvinceCount && summary.frontierTroops >= estimates.averageFrontierTroops) {
    value += rewardProvinceCount * weights.recoveryBonus;
  }
  const table = context.memory?.table || {};
  value += summary.frontierTroops * (table.underDefense || 0) * weights.defenseContextWeight;
  value -= summary.frontierTroops * (table.overDefense || 0) * weights.defenseContextWeight * 0.8;
  if ((table.underDefense || 0) > 0.2 || (table.underFunding || 0) > 0.2) {
    value -= summary.idleTroops * ((table.underDefense || 0) + (table.underFunding || 0)) * weights.fundingContextWeight;
  }
  if ((table.overFunding || 0) > 0) {
    value += summary.idleTroops * table.overFunding * weights.fundingContextWeight * 0.25;
  }
  return value;
}

function getAiPlayerIds(state, meta) {
  const humanIds = meta?.humanPlayerIds instanceof Set ? meta.humanPlayerIds : new Set(meta?.humanPlayerIds || []);
  return (state.players || [])
    .map((player) => player.id)
    .filter((playerId) => !humanIds.has(playerId));
}

function existingCapitalVotes(state) {
  const votes = {};
  for (const [playerId, orders] of Object.entries(state.allOrders || {})) {
    const summary = summarizeOrders(state, Number(playerId), orders);
    summary.ranking.forEach((candidateId, rankIndex) => {
      if (summary.candidateSupport[candidateId] === false) return;
      const support = summary.capitalTroops * getCoupRankWeight(state.players.length, rankIndex);
      votes[candidateId] = (votes[candidateId] || 0) + support;
    });
  }
  return votes;
}

function selfClaimStatus(ownPotential, rivalPotential) {
  if (ownPotential >= rivalPotential + 0.5) return 'strong';
  if (ownPotential >= rivalPotential * 0.72) return 'weak';
  return 'dead';
}

function scoreCoalitionCandidate(state, memory, supporterId, candidateId, final, leaderId, weights) {
  if (supporterId === candidateId) return weights.throneBase * weights.selfClaim * 0.18;
  return scoreBasileusPreference(state, memory, supporterId, candidateId, final, leaderId, weights)
    + weights.supportOtherClaimant;
}

export function buildCoupCoalitionContext(state, meta = null, memory = getAiMemory(state, meta)) {
  if (!state || state.phase !== 'deployment') return { recommendations: {}, candidates: [] };
  const aiPlayerIds = getAiPlayerIds(state, meta);
  if (!aiPlayerIds.length) return { recommendations: {}, candidates: [] };
  const final = projectedScoring(state);
  const leaderId = getLeaderIdFromScores(final, null);
  const potentials = Object.fromEntries((state.players || []).map((player) => [
    player.id,
    estimatePotentialCapitalTroops(state, player.id),
  ]));
  const fixedVotes = existingCapitalVotes(state);
  const viability = {};
  for (const playerId of aiPlayerIds) {
    const rivalPotential = Math.max(
      1,
      ...Object.entries(potentials)
        .filter(([otherId]) => Number(otherId) !== playerId)
        .map(([, value]) => value),
    );
    viability[playerId] = selfClaimStatus(potentials[playerId] || 0, rivalPotential);
  }

  const candidates = [];
  for (const candidate of state.players || []) {
    const candidateId = candidate.id;
    let expectedVotes = (potentials[candidateId] || 0) + (fixedVotes[candidateId] || 0);
    let supportValue = 0;
    const supporters = [];
    for (const supporterId of aiPlayerIds) {
      const weights = getStrategyWeights(meta, supporterId);
      if (supporterId !== candidateId && viability[supporterId] === 'strong') continue;
      const willingness = scoreCoalitionCandidate(state, memory, supporterId, candidateId, final, leaderId, weights);
      const threshold = supporterId === candidateId ? -0.2 : 2;
      if (willingness <= threshold) continue;
      supporters.push({ playerId: supporterId, willingness });
      supportValue += willingness;
      if (supporterId !== candidateId) expectedVotes += potentials[supporterId] || 0;
    }
    if (!supporters.length) continue;
    const candidateMemory = getPlayerMemory(memory, candidateId);
    const threatPenalty = candidateId === leaderId ? 2.5 : 0;
    const incumbentPenalty = candidateId === state.basileusId ? 3.5 : 0;
    const score = expectedVotes
      + supportValue * 0.8
      - threatPenalty
      - incumbentPenalty
      - candidateMemory.revocationAggression * 0.7;
    candidates.push({ candidateId, expectedVotes, supporters, score });
  }

  candidates.sort((left, right) => {
    const scoreDiff = right.score - left.score;
    if (Math.abs(scoreDiff) > SCORE_TIE_EPSILON) return scoreDiff;
    const voteDiff = right.expectedVotes - left.expectedVotes;
    if (Math.abs(voteDiff) > SCORE_TIE_EPSILON) return voteDiff;
    return neutralTieBreakValue(state, 'coalition', left.candidateId, 'candidate')
      - neutralTieBreakValue(state, 'coalition', right.candidateId, 'candidate');
  });

  const recommendations = {};
  for (const supporterId of aiPlayerIds) {
    if (viability[supporterId] === 'strong') continue;
    const best = candidates
      .filter((candidate) => candidate.supporters.some((supporter) => supporter.playerId === supporterId))
      .map((candidate) => {
        const supporter = candidate.supporters.find((entry) => entry.playerId === supporterId);
        return {
          ...candidate,
          supporterScore: supporter?.willingness || 0,
          personalScore: (supporter?.willingness || 0) + candidate.score * 0.18,
        };
      })
      .sort((left, right) => {
        const personalDiff = right.personalScore - left.personalScore;
        if (Math.abs(personalDiff) > SCORE_TIE_EPSILON) return personalDiff;
        const voteDiff = right.expectedVotes - left.expectedVotes;
        if (Math.abs(voteDiff) > SCORE_TIE_EPSILON) return voteDiff;
        return neutralTieBreakValue(state, supporterId, left.candidateId, 'supporter-candidate')
          - neutralTieBreakValue(state, supporterId, right.candidateId, 'supporter-candidate');
      })[0] || null;
    if (best && best.personalScore > 0.25) {
      recommendations[supporterId] = {
        candidateId: best.candidateId,
        expectedVotes: best.expectedVotes,
        supporterScore: best.supporterScore,
        coalitionScore: best.score,
        viability: viability[supporterId],
      };
    }
  }

  return { recommendations, candidates, viability, potentials, leaderId };
}

function scoreCoalitionFit(state, playerId, summary, leaderId, weights, context = {}) {
  const recommendation = context.coalitionContext?.recommendations?.[playerId];
  if (!recommendation || summary.capitalTroops <= 0) return 0;
  const candidateId = summary.candidate;
  const relation = Number.isInteger(candidateId)
    ? relationshipScore(context.memory, playerId, candidateId)
    : 0;
  if (candidateId === recommendation.candidateId) {
    const targetIsLeader = candidateId === leaderId && candidateId !== playerId;
    const leaderPenalty = targetIsLeader ? weights.supportLeaderPenalty * 0.8 : 0;
    return summary.capitalTroops
      * (1.1 + Math.max(0, relation) * 0.06 + Math.max(0, recommendation.supporterScore) * 0.16)
      - leaderPenalty;
  }
  const selfException = candidateId === playerId && recommendation.viability === 'weak';
  if (selfException) return -summary.capitalTroops * 0.35;
  return -summary.capitalTroops * 1.1;
}

function frontierSafetyScale(state, summary, estimates, weights = DEFAULT_STRATEGY_WEIGHTS) {
  const invasion = state.currentInvasion;
  if (!invasion) return 1;
  const expectedStrength = estimateInvasionStrength(invasion);
  const highStrength = estimateHighInvasionStrength(invasion);
  const totalFrontier = summary.frontierTroops + reliableEstimatedFrontier(estimates, weights);
  const low = Math.max(0, expectedStrength - 2);
  const high = Math.max(low + 1, highStrength);
  return clamp((totalFrontier - low) / (high - low), 0.25, 1);
}

function scoreSupportRelationship(state, playerId, candidateId, capitalTroops, leaderId, weights, context = {}) {
  if (!Number.isInteger(candidateId) || candidateId === playerId || capitalTroops <= 0) return 0;
  const relScore = relationshipScore(context.memory, playerId, candidateId);
  const candidateMemory = getPlayerMemory(context.memory, candidateId);
  let value = relScore * weights.relationshipCoupWeight * Math.min(1.6, capitalTroops * 0.25);
  value += weights.favorSeekingWeight
    * capitalTroops
    * (0.22 + candidateMemory.patronageGenerosity * 0.28)
    * Math.max(0.25, 1 - candidateMemory.revocationAggression * 0.25);
  if (candidateId === leaderId && candidateId !== playerId) value -= capitalTroops * weights.supportLeaderPenalty * 0.5;
  return clamp(value, -weights.relationshipCap * 1.4, weights.relationshipCap * 1.4);
}

function scoreCoupPlan(state, playerId, summary, estimates, leaderId = currentLeaderId(state, playerId), weights = DEFAULT_STRATEGY_WEIGHTS, context = {}) {
  const safetyScale = frontierSafetyScale(state, summary, estimates, weights);
  const table = context.memory?.table || {};
  const final = context.final || projectedScoring(state);
  const rivalCapital = Math.max(estimates.maxCapitalTroops, estimates.incumbentCapitalTroops);
  const ownCapital = Math.max(0, summary.capitalTroops);
  const leverage = clamp(ownCapital / Math.max(1, rivalCapital + 1), 0, 1.25);
  const decisiveTroops = Math.max(0, ownCapital - rivalCapital);
  const candidatePreference = scoreBasileusPreference(
    state,
    context.memory,
    playerId,
    summary.candidate,
    final,
    leaderId,
    weights,
  );
  const opportunity = ownCapital
    * weights.coupOpportunityWeight
    * safetyScale
    * (0.45 + Math.min(1, leverage) + (table.underCouping || 0) * 0.25);

  if (summary.candidate === playerId) {
    let value = candidatePreference * Math.min(1, leverage) * safetyScale
      + ownCapital * weights.selfClaim * 1.2 * safetyScale
      + decisiveTroops * weights.selfClaim * 1.1 * safetyScale
      + opportunity;
    if (ownCapital <= 0) value -= 5;
    value += scoreCoalitionFit(state, playerId, summary, leaderId, weights, context);
    value -= ownCapital * (table.overCouping || 0) * 0.18;
    return value;
  }

  if (summary.candidate === state.basileusId) {
    let value = 0;
    if (playerId === state.basileusId) value = ownCapital * 1.5 * weights.incumbentDefense + opportunity * 0.45;
    else value = candidatePreference * Math.min(1, leverage) + ownCapital * 0.25 * weights.incumbentDefense;
    if (playerId === state.basileusId) {
      value += ownCapital * weights.coupOpportunityWeight * safetyScale * 0.35;
    }
    value += scoreSupportRelationship(state, playerId, summary.candidate, ownCapital, leaderId, weights, context);
    value += scoreCoalitionFit(state, playerId, summary, leaderId, weights, context);
    return value;
  }

  let value = candidatePreference * Math.min(1, leverage)
    + ownCapital * weights.supportOtherClaimant
    + opportunity;
  value += scoreSupportRelationship(state, playerId, summary.candidate, ownCapital, leaderId, weights, context);
  value += scoreCoalitionFit(state, playerId, summary, leaderId, weights, context);
  value -= ownCapital * (table.overCouping || 0) * 0.18;
  return value;
}

function scoreDeploymentTactics(state, playerId, action, context = {}) {
  const summary = summarizeOrders(state, playerId, action.orders);
  const estimates = context.estimates || estimateOtherDeployment(state, playerId, context.memory);
  const weights = context.weights || DEFAULT_STRATEGY_WEIGHTS;
  const nonCoupKey = [
    summary.frontierTroops,
    summary.idleTroops,
    summary.mercCost,
  ].join(':');
  let nonCoupValue = context.nonCoupScoreCache?.get(nonCoupKey);
  if (nonCoupValue == null) {
    nonCoupValue = scoreWarPlan(state, playerId, summary, estimates, weights, context)
      + Math.min(summary.idleTroops, 10) * weights.reserveValue
      - summary.mercCost * weights.mercenaryCostPenalty;
    context.nonCoupScoreCache?.set(nonCoupKey, nonCoupValue);
  }

  const coupKey = [
    summary.candidate,
    summary.capitalTroops,
    estimates.maxCapitalTroops,
    estimates.incumbentCapitalTroops,
  ].join(':');
  let coupValue = context.coupScoreCache?.get(coupKey);
  if (coupValue == null) {
    coupValue = scoreCoupPlan(state, playerId, summary, estimates, context.leaderId, weights, context);
    context.coupScoreCache?.set(coupKey, coupValue);
  }

  return nonCoupValue + coupValue;
}

export function chooseStrategicOrderAction(state, meta, playerId, options = {}) {
  const memory = options.memory || getAiMemory(state, meta);
  const actions = listLegalOrderActions(state, playerId, { ...options, memory });
  const coalitionContext = options.coalitionContext || buildCoupCoalitionContext(state, meta, memory);
  const context = {
    leaderId: currentLeaderId(state, playerId),
    final: projectedScoring(state),
    weights: getStrategyWeights(meta, playerId),
    memory,
    coalitionContext,
    estimates: estimateOtherDeployment(state, playerId, memory),
    nonCoupScoreCache: new Map(),
    coupScoreCache: new Map(),
  };
  return actions
    .map((action) => ({ action, score: scoreDeploymentTactics(state, playerId, action, context) }))
    .sort((left, right) => compareScoredActions(state, playerId, left, right, 'orders'))[0]?.action || null;
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
        impact: summary.capitalTroops > 0 ? 'positive' : 'neutral',
        note: 'Capital troops follow the ranked claimant list.',
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
      .sort((left, right) => compareScoredActions(planningState, playerId, left, right, `estate-${step}`))[0] || null;
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
  if (!reward) return 'empire';
  const memory = getAiMemory(state, meta);
  const weights = getStrategyWeights(meta, reward.defenderId);
  const actions = listLegalRewardActions(state, reward.defenderId)
    .filter((action) => action.rewardId === reward.id);
  const best = chooseScoredAction(state, reward.defenderId, actions, {
    extraScore: (trial, action) => {
      const theme = trial.themes?.[reward.themeId];
      const stakeholders = [theme?.owner, theme?.strategos, theme?.bishop]
        .map((value) => Number(value))
        .filter(Number.isInteger);
      const relationshipValue = [...new Set(stakeholders)]
        .filter((playerId) => playerId !== reward.defenderId)
        .reduce((total, playerId) => total + relationshipScore(memory, reward.defenderId, playerId), 0);
      if (action.choice === 'empire') {
        return (theme?.owner === reward.defenderId ? 2.5 : 0.8)
          + clamp(relationshipValue * weights.reciprocityWeight * 0.25, -2.5, 2.5);
      }
      return clamp(-relationshipValue * weights.reciprocityWeight * 0.2, -2, 2);
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
