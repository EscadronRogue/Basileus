import { getPlayer } from '../engine/state.js';
import { getMercenaryHireCost, getThemeOwnerIncome } from '../engine/rules.js';
import { DEFAULT_META_PARAMS, NEUTRAL_PROFILE, PERSONALITIES } from './personalities.js';
import { ensureAIContext, getAIPlayerIndicators, getAIPairIndicators } from './context.js';
import { AI_ACTION_KINDS, createActionDescriptor } from './actionSpace.js';

export const IMPACT_KEYS = Object.freeze([
  'scoreGain',
  'survival',
  'military',
  'political',
  'economic',
  'denial',
  'diplomacy',
  'risk',
  'flexibility',
  'timing',
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function roundTo(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function getProfile(meta, playerId) {
  const playerMeta = meta?.players?.[playerId];
  if (playerMeta?.profile) return playerMeta.profile;
  if (playerMeta?.personalityId && PERSONALITIES[playerMeta.personalityId]) {
    return PERSONALITIES[playerMeta.personalityId];
  }
  return NEUTRAL_PROFILE;
}

function getMeta(meta, playerId, key) {
  const profile = getProfile(meta, playerId);
  if (profile?.meta && profile.meta[key] != null) return profile.meta[key];
  return DEFAULT_META_PARAMS[key] ?? 1;
}

function emptyImpact() {
  return Object.fromEntries(IMPACT_KEYS.map(key => [key, 0]));
}

function addImpact(impact, key, value) {
  if (!IMPACT_KEYS.includes(key)) return;
  impact[key] = roundTo((impact[key] || 0) + (Number(value) || 0));
}

function addCostGainImpacts(impact, descriptor, actor) {
  const goldCost = Number(descriptor.costs.gold) || 0;
  const troopCost = Number(descriptor.costs.troops) || 0;
  const goldGain = Number(descriptor.gains.gold) || 0;
  const troopGain = Number(descriptor.gains.troops) || 0;
  const incomeGain = Number(descriptor.gains.income) || 0;
  const titleGain = Number(descriptor.gains.titles) || 0;
  const scoreGain = Number(descriptor.gains.score) || 0;

  addImpact(impact, 'economic', (goldGain - goldCost) * 0.12 + incomeGain * 0.55);
  addImpact(impact, 'military', (troopGain - troopCost) * 0.35);
  addImpact(impact, 'political', titleGain * 0.55);
  addImpact(impact, 'scoreGain', scoreGain * 0.7 + incomeGain * 0.18 + titleGain * 0.25);
  addImpact(impact, 'flexibility', -goldCost * 0.05 - troopCost * 0.18);
  if (actor?.gold != null && goldCost > actor.spendableGold) addImpact(impact, 'risk', 1.1);
}

function getThemeFromDescriptor(state, descriptor) {
  const theme = descriptor.payload.theme || state.themes?.[descriptor.payload.themeId];
  return theme || null;
}

function getRouteRiskFromState(state, themeId) {
  const route = state.currentInvasion?.route;
  if (!Array.isArray(route) || !route.length) return 0;
  const index = route.indexOf(themeId);
  if (index === -1) return 0;
  return clamp(1 - (index / Math.max(1, route.length - 2)), 0, 1);
}

function scoreRelativeTarget(context, actorId, targetId) {
  const pair = getAIPairIndicators(context, actorId, targetId);
  if (!pair) return 0;
  const targetRank = pair.target.normalized.rank;
  const targetThreatened = pair.target.normalized.threatened;
  const actorBehind = pair.actor.positionScore < pair.target.positionScore ? 1 : 0;
  return clamp((targetRank * 0.6) + (actorBehind * 0.45) - (targetThreatened * 0.12), 0, 1.6);
}

function evaluateAppointment(state, context, actorId, descriptor, impact) {
  const appointeeId = Number(descriptor.payload.appointeeId ?? descriptor.beneficiaries[0]);
  const type = descriptor.payload.type || descriptor.payload.titleType || '';
  const pair = getAIPairIndicators(context, actorId, appointeeId);
  const target = pair?.target;
  const targetAhead = pair?.targetAhead ? 1 : 0;
  const relationValue = target
    ? (target.relations.trustIn - target.relations.grievanceIn) * 0.04
    : 0;

  addImpact(impact, 'political', 0.75 + relationValue);
  addImpact(impact, 'diplomacy', 0.35 + relationValue);
  addImpact(impact, 'denial', targetAhead * -0.25);
  addImpact(impact, 'risk', targetAhead * 0.22);
  if (type === 'STRATEGOS') addImpact(impact, 'military', 0.55);
  if (type === 'BISHOP') addImpact(impact, 'scoreGain', 0.35);
  if (type === 'EMPRESS' || type === 'CHIEF_EUNUCHS') addImpact(impact, 'political', 0.45);
}

function evaluateLandPurchase(state, context, actorId, descriptor, impact) {
  const actor = getAIPlayerIndicators(context, actorId);
  const theme = getThemeFromDescriptor(state, descriptor);
  if (!theme) return;
  const income = getThemeOwnerIncome(theme);
  const risk = getRouteRiskFromState(state, theme.id) * (context.invasion.present ? 1 : 0.35);
  const scarcity = actor?.themes === 0 ? 0.8 : actor?.themes <= 1 ? 0.35 : 0;

  addImpact(impact, 'economic', income * 0.5 + scarcity);
  addImpact(impact, 'scoreGain', income * 0.12 + (Number(theme.P) || 0) * 0.08);
  addImpact(impact, 'military', (Number(theme.L) || 0) * 0.08);
  addImpact(impact, 'risk', risk * 0.55);
  addImpact(impact, 'flexibility', -(Number(descriptor.costs.gold) || 0) * 0.08);
}

function evaluateChurchGift(state, context, actorId, descriptor, impact) {
  const theme = getThemeFromDescriptor(state, descriptor);
  if (!theme) return;
  const route = getRouteRiskFromState(state, theme.id);
  const income = getThemeOwnerIncome(theme);
  const churchYield = (Number(theme.P) || 0) + (Number(theme.T) || 0) + (Number(theme.C) || 0);
  addImpact(impact, 'scoreGain', churchYield * 0.18);
  addImpact(impact, 'political', 0.38);
  addImpact(impact, 'economic', -income * 0.48);
  addImpact(impact, 'flexibility', -0.45);
  addImpact(impact, 'risk', -route * 0.22);
}

function evaluateRecruitDismiss(context, actorId, descriptor, impact) {
  const actor = getAIPlayerIndicators(context, actorId);
  const count = Number(descriptor.payload.count ?? 1) || 1;
  if (descriptor.kind === AI_ACTION_KINDS.RECRUIT) {
    addImpact(impact, 'military', 0.7 * count);
    addImpact(impact, 'survival', actor?.frontierNeed ? actor.frontierNeed * 0.12 : 0.08);
    addImpact(impact, 'flexibility', 0.18 * count);
    addImpact(impact, 'economic', -0.2 * count);
  } else {
    addImpact(impact, 'military', -0.55 * count);
    addImpact(impact, 'economic', 0.35 * count);
    addImpact(impact, 'flexibility', 0.3 * count);
    addImpact(impact, 'risk', actor?.frontierNeed ? actor.frontierNeed * 0.12 : 0.05);
  }
}

function evaluateMercenaryHire(context, actorId, descriptor, impact) {
  const actor = getAIPlayerIndicators(context, actorId);
  const count = Number(descriptor.payload.count ?? descriptor.gains.troops ?? 1) || 1;
  const demand = (actor?.frontierNeed || 0) + (actor?.normalized.rivalry || 0);
  addImpact(impact, 'military', 0.65 * count);
  addImpact(impact, 'survival', Math.min(0.6, demand * 0.16 * count));
  addImpact(impact, 'political', 0.2 * count);
  addImpact(impact, 'economic', -(Number(descriptor.costs.gold) || 0) * 0.1);
  addImpact(impact, 'flexibility', 0.12 * count);
}

function evaluateRevocation(context, actorId, descriptor, impact) {
  const targetId = Number(descriptor.payload.targetPlayerId ?? descriptor.targets[0]);
  const targetPressure = scoreRelativeTarget(context, actorId, targetId);
  addImpact(impact, 'denial', 0.65 + targetPressure);
  addImpact(impact, 'political', 0.35 + targetPressure * 0.25);
  addImpact(impact, 'diplomacy', -0.75);
  addImpact(impact, 'risk', 0.35 + targetPressure * 0.15);
  addImpact(impact, 'flexibility', -(Number(descriptor.costs.troops) || 0) * 0.2);
}

function evaluateOrders(context, actorId, descriptor, impact) {
  const actor = getAIPlayerIndicators(context, actorId);
  const capital = Number(descriptor.commitments.capitalTroops) || 0;
  const frontier = Number(descriptor.commitments.frontierTroops) || 0;
  const total = Math.max(1, capital + frontier);
  const frontierShare = frontier / total;
  const capitalShare = capital / total;
  const candidateId = Number(descriptor.payload.candidateId ?? descriptor.payload.candidate);
  const supportsLeader = Number.isInteger(candidateId) && getAIPlayerIndicators(context, candidateId)?.rank === 1;
  const selfClaim = candidateId === actorId;

  addImpact(impact, 'survival', frontierShare * (0.55 + (context.invasion.expectedStrength * 0.04) + (actor?.frontierNeed || 0) * 0.18));
  addImpact(impact, 'political', capitalShare * (0.5 + (selfClaim ? 0.55 : 0.2)));
  addImpact(impact, 'military', Math.min(1.2, total * 0.08));
  addImpact(impact, 'denial', supportsLeader && !selfClaim ? -0.25 : capitalShare * 0.25);
  addImpact(impact, 'risk', frontierShare < 0.35 && (actor?.frontierNeed || 0) > 0.8 ? 0.45 : 0);
  addImpact(impact, 'flexibility', -Math.abs(frontierShare - capitalShare) * 0.08);
}

function evaluateDeal(state, context, actorId, descriptor, impact) {
  const clauses = descriptor.payload.clauses || [];
  const counterpartyId = Number(descriptor.payload.counterpartyId ?? descriptor.targets[0]);
  const targetPressure = scoreRelativeTarget(context, actorId, counterpartyId);
  let goldNet = 0;
  let troopCommitment = 0;
  let estateNet = 0;
  let appointmentPromises = 0;
  let protection = 0;

  for (const clause of clauses) {
    const actorGives = Number(clause.giverId) === Number(actorId);
    const sign = actorGives ? -1 : 1;
    if (clause.kind === 'gold') goldNet += sign * (Number(clause.payload?.totalAmount) || 0);
    if (clause.kind === 'estate') estateNet += sign * 1;
    if (clause.kind === 'coup_support' || clause.kind === 'frontier_support') {
      troopCommitment += sign * (Number(clause.payload?.troopCount) || 0);
    }
    if (clause.kind === 'appointment_promise') appointmentPromises += sign * (Number(clause.payload?.appointmentCount) || 1);
    if (clause.kind === 'non_revocation') protection += sign * (Number(clause.durationTurns) || 1);
  }

  addImpact(impact, 'economic', goldNet * 0.1 + estateNet * 0.65);
  addImpact(impact, 'military', troopCommitment * 0.25);
  addImpact(impact, 'political', appointmentPromises * 0.45 + protection * 0.18);
  addImpact(impact, 'diplomacy', 0.35 + Math.max(0, -targetPressure) * 0.1);
  addImpact(impact, 'flexibility', Math.min(0.6, troopCommitment * 0.12) - Math.max(0, -troopCommitment) * 0.3);
  addImpact(impact, 'risk', Math.max(0, -goldNet) * 0.03 + Math.max(0, -troopCommitment) * 0.16);
}

function evaluateDefenderReward(state, context, actorId, descriptor, impact) {
  const choice = descriptor.payload.choice;
  const theme = getThemeFromDescriptor(state, descriptor);
  const gold = Number(descriptor.gains.gold ?? descriptor.payload.gold ?? 0) || 0;
  const route = theme ? getRouteRiskFromState(state, theme.id) : 0;
  if (choice === 'gold') {
    addImpact(impact, 'economic', gold * 0.14);
    addImpact(impact, 'scoreGain', gold * 0.06);
    addImpact(impact, 'survival', -route * (0.45 + context.invasion.expectedStrength * 0.03));
    addImpact(impact, 'risk', route * 0.45);
  } else {
    addImpact(impact, 'survival', 0.65 + route * 0.75);
    addImpact(impact, 'diplomacy', 0.25);
    addImpact(impact, 'economic', -gold * 0.08);
    addImpact(impact, 'risk', -route * 0.25);
  }
}

function evaluateTitleAssignment(context, actorId, descriptor, impact) {
  const assignment = descriptor.payload.assignment || {};
  let loyalHolders = 0;
  let leaderTitles = 0;
  let rivalDenials = 0;
  for (const holderId of Object.values(assignment).map(Number)) {
    const pair = getAIPairIndicators(context, actorId, holderId);
    if (!pair) continue;
    if (pair.target.relations.trustIn >= pair.target.relations.grievanceIn) loyalHolders++;
    if (pair.target.rank === 1 && holderId !== actorId) leaderTitles++;
    if (pair.targetAhead) rivalDenials++;
  }
  addImpact(impact, 'political', loyalHolders * 0.32);
  addImpact(impact, 'diplomacy', loyalHolders * 0.12);
  addImpact(impact, 'denial', rivalDenials * 0.18 - leaderTitles * 0.2);
  addImpact(impact, 'risk', leaderTitles * 0.16);
}

function evaluateByKind(state, context, actorId, descriptor, impact) {
  if (descriptor.kind === AI_ACTION_KINDS.APPOINTMENT) evaluateAppointment(state, context, actorId, descriptor, impact);
  else if (descriptor.kind === AI_ACTION_KINDS.LAND_PURCHASE) evaluateLandPurchase(state, context, actorId, descriptor, impact);
  else if (descriptor.kind === AI_ACTION_KINDS.CHURCH_GIFT) evaluateChurchGift(state, context, actorId, descriptor, impact);
  else if (descriptor.kind === AI_ACTION_KINDS.RECRUIT || descriptor.kind === AI_ACTION_KINDS.DISMISS) evaluateRecruitDismiss(context, actorId, descriptor, impact);
  else if (descriptor.kind === AI_ACTION_KINDS.MERCENARY_HIRE) evaluateMercenaryHire(context, actorId, descriptor, impact);
  else if (descriptor.kind === AI_ACTION_KINDS.REVOCATION) evaluateRevocation(context, actorId, descriptor, impact);
  else if (descriptor.kind === AI_ACTION_KINDS.ORDERS) evaluateOrders(context, actorId, descriptor, impact);
  else if (descriptor.kind === AI_ACTION_KINDS.DEAL) evaluateDeal(state, context, actorId, descriptor, impact);
  else if (descriptor.kind === AI_ACTION_KINDS.DEFENDER_REWARD) evaluateDefenderReward(state, context, actorId, descriptor, impact);
  else if (descriptor.kind === AI_ACTION_KINDS.TITLE_ASSIGNMENT) evaluateTitleAssignment(context, actorId, descriptor, impact);
}

function weightedTotal(meta, actorId, impact) {
  const sensitivity = getMeta(meta, actorId, 'consequenceSensitivity');
  const riskHorizon = getMeta(meta, actorId, 'riskHorizon');
  const flexibilityValue = getMeta(meta, actorId, 'flexibilityValue');
  const rivalDenialValue = getMeta(meta, actorId, 'rivalDenialValue');
  const uncertaintyTolerance = getMeta(meta, actorId, 'uncertaintyTolerance');
  const cooperationValue = getMeta(meta, actorId, 'cooperationValue');

  return roundTo(sensitivity * (
    impact.scoreGain * 1.05 +
    impact.survival * (0.85 + riskHorizon * 0.18) +
    impact.military * 0.72 +
    impact.political * 0.82 +
    impact.economic * 0.76 +
    impact.denial * (0.62 + rivalDenialValue * 0.22) +
    impact.diplomacy * (0.48 + cooperationValue * 0.18) +
    impact.flexibility * (0.45 + flexibilityValue * 0.22) +
    impact.timing * 0.28 -
    impact.risk * (0.72 + riskHorizon * 0.16 - uncertaintyTolerance * 0.18)
  ));
}

export function evaluateActionConsequences(state, meta, actorId, rawDescriptor, context = null) {
  const descriptor = rawDescriptor.kind ? createActionDescriptor(rawDescriptor) : rawDescriptor;
  const world = context || ensureAIContext(state, meta, descriptor.phase || state.phase);
  const actor = getAIPlayerIndicators(world, actorId);
  const impact = emptyImpact();

  addCostGainImpacts(impact, descriptor, actor);
  evaluateByKind(state, world, actorId, descriptor, impact);

  if (descriptor.timing === 'future') addImpact(impact, 'timing', -0.18);
  if (descriptor.reversibility === 'low') addImpact(impact, 'flexibility', -0.28);
  if (descriptor.reversibility === 'high') addImpact(impact, 'flexibility', 0.16);

  const total = weightedTotal(meta, actorId, impact);
  return {
    descriptor,
    impact,
    total,
    score: roundTo((Number(descriptor.baseScore) || 0) + total),
  };
}

export function scoreActionPolicy(state, meta, actorId, rawDescriptor, baseScore = 0, context = null) {
  const descriptor = createActionDescriptor({
    ...rawDescriptor,
    actorId,
    baseScore,
  });
  return evaluateActionConsequences(state, meta, actorId, descriptor, context);
}

export function rankWithConsequences(state, meta, actorId, actions, options = {}) {
  const limit = Math.max(1, Number(options.limit) || 8);
  const stage = options.stage || state.phase;
  const context = ensureAIContext(state, meta, stage);
  return actions
    .slice()
    .sort((left, right) => (right.score || 0) - (left.score || 0))
    .slice(0, limit)
    .map(action => {
      const evaluation = scoreActionPolicy(
        state,
        meta,
        actorId,
        action.descriptor || {
          kind: action.kind,
          phase: stage,
          payload: action.payload || {},
          costs: action.costs || {},
          gains: action.gains || {},
          commitments: action.commitments || {},
          targets: action.targets || [],
          beneficiaries: action.beneficiaries || [],
          tags: action.tags || [],
        },
        action.score || 0,
        context,
      );
      return {
        ...action,
        score: evaluation.score,
        consequence: evaluation,
      };
    })
    .sort((left, right) => right.score - left.score);
}

export function projectAction(state, rawDescriptor) {
  const descriptor = createActionDescriptor(rawDescriptor);
  const projected = clonePlain(state);
  if (!projected) return { ok: false, reason: 'Cannot clone state.' };
  const actor = getPlayer(projected, descriptor.actorId);
  const payload = descriptor.payload || {};

  if (descriptor.kind === AI_ACTION_KINDS.LAND_PURCHASE && actor && payload.themeId) {
    const cost = Number(descriptor.costs.gold ?? payload.cost ?? 0) || 0;
    actor.gold -= cost;
    projected.landAuctions = projected.landAuctions || {};
    projected.landAuctions[payload.themeId] = {
      themeId: payload.themeId,
      bidderId: descriptor.actorId,
      amount: cost,
      round: projected.round,
    };
  } else if (descriptor.kind === AI_ACTION_KINDS.CHURCH_GIFT && payload.themeId && projected.themes?.[payload.themeId]) {
    projected.themes[payload.themeId].owner = 'church';
    projected.themes[payload.themeId].bishop = descriptor.actorId;
    projected.themes[payload.themeId].bishopIsDonor = true;
  } else if (descriptor.kind === AI_ACTION_KINDS.RECRUIT && payload.officeKey) {
    projected.pendingProfessionalArmies = projected.pendingProfessionalArmies || {};
    projected.pendingProfessionalArmies[descriptor.actorId] = projected.pendingProfessionalArmies[descriptor.actorId] || {};
    projected.pendingProfessionalArmies[descriptor.actorId][payload.officeKey] =
      (Number(projected.pendingProfessionalArmies[descriptor.actorId][payload.officeKey]) || 0) + 1;
  } else if (descriptor.kind === AI_ACTION_KINDS.DISMISS && actor && payload.officeKey) {
    const count = Number(payload.count ?? 1) || 1;
    actor.professionalArmies[payload.officeKey] = Math.max(0, (Number(actor.professionalArmies[payload.officeKey]) || 0) - count);
    if (actor.professionalArmies[payload.officeKey] <= 0) delete actor.professionalArmies[payload.officeKey];
  } else if (descriptor.kind === AI_ACTION_KINDS.MERCENARY_HIRE && actor) {
    const count = Number(payload.count ?? 1) || 1;
    const cost = Number(descriptor.costs.gold ?? getMercenaryHireCost(0, count)) || 0;
    actor.gold -= cost;
    projected.currentMercenaryTroops = projected.currentMercenaryTroops || {};
    projected.currentMercenaryTroops[descriptor.actorId] = (Number(projected.currentMercenaryTroops[descriptor.actorId]) || 0) + count;
  } else if (descriptor.kind === AI_ACTION_KINDS.APPOINTMENT) {
    const appointeeId = Number(payload.appointeeId);
    if (payload.type === 'EMPRESS') projected.empress = appointeeId;
    else if (payload.type === 'CHIEF_EUNUCHS') projected.chiefEunuchs = appointeeId;
    else if (payload.themeId && payload.type === 'STRATEGOS') projected.themes[payload.themeId].strategos = appointeeId;
    else if (payload.themeId && payload.type === 'BISHOP') projected.themes[payload.themeId].bishop = appointeeId;
  } else if (descriptor.kind === AI_ACTION_KINDS.REVOCATION && payload.themeId) {
    const theme = projected.themes?.[payload.themeId];
    if (theme && payload.titleType === 'strategos') theme.strategos = null;
    else if (theme && payload.titleType === 'bishop') theme.bishop = null;
    else if (theme) theme.owner = null;
  } else if (descriptor.kind === AI_ACTION_KINDS.ORDERS) {
    projected.allOrders = projected.allOrders || {};
    projected.allOrders[descriptor.actorId] = clonePlain(payload.orders || {
      deployments: payload.deployments || {},
      candidate: payload.candidateId ?? payload.candidate,
    });
  } else if (descriptor.kind === AI_ACTION_KINDS.DEFENDER_REWARD && payload.themeId && projected.themes?.[payload.themeId]) {
    if (payload.choice === 'gold') {
      if (actor) actor.gold += Number(payload.gold || descriptor.gains.gold || 0) || 0;
      projected.themes[payload.themeId].occupied = true;
    } else {
      projected.themes[payload.themeId].occupied = false;
      projected.themes[payload.themeId].owner = null;
    }
  } else if (descriptor.kind === AI_ACTION_KINDS.TITLE_ASSIGNMENT) {
    const assignment = payload.assignment || {};
    for (const player of projected.players || []) {
      player.majorTitles = [];
    }
    for (const [titleKey, holderId] of Object.entries(assignment)) {
      const holder = getPlayer(projected, Number(holderId));
      if (holder) holder.majorTitles.push(titleKey);
    }
    projected.basileusId = descriptor.actorId;
  }

  return { ok: true, state: projected, descriptor };
}

export function recordSelectedActionProjection(meta, playerId, evaluation) {
  const stats = meta?.players?.[playerId]?.stats;
  if (!stats || !evaluation) return;
  stats.systemicDecisionCount = (stats.systemicDecisionCount || 0) + 1;
  stats.projectedUtilityTotal = (stats.projectedUtilityTotal || 0) + (Number(evaluation.total) || 0);
  stats.projectedRiskTotal = (stats.projectedRiskTotal || 0) + (Number(evaluation.impact?.risk) || 0);
  stats.projectedFlexibilityTotal = (stats.projectedFlexibilityTotal || 0) + (Number(evaluation.impact?.flexibility) || 0);
}

export function summarizePredictionStats(stats = {}, realizedUtility = 0) {
  const count = Math.max(1, Number(stats.systemicDecisionCount) || 0);
  const projectedUtility = (Number(stats.projectedUtilityTotal) || 0) / count;
  const projectedRisk = (Number(stats.projectedRiskTotal) || 0) / count;
  const projectedFlexibility = (Number(stats.projectedFlexibilityTotal) || 0) / count;
  const normalizedRealized = clamp(Number(realizedUtility) || 0, -4, 4);
  return {
    systemicDecisionCount: Number(stats.systemicDecisionCount) || 0,
    projectedUtility: roundTo(projectedUtility),
    projectedRisk: roundTo(projectedRisk),
    projectedFlexibility: roundTo(projectedFlexibility),
    projectionError: roundTo(Math.abs(projectedUtility - normalizedRealized) / 4),
    decisionQuality: roundTo(clamp(1 - (Math.abs(projectedUtility - normalizedRealized) / 4), 0, 1)),
  };
}
