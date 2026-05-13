import { AI_NUM, withAINumericTuning } from './numericConstants.js';
import { getPlayer } from '../engine/state.js';
import { getMercenaryHireCost, getThemeOwnerIncome } from '../engine/rules.js';
import { DEFAULT_META_PARAMS, NEUTRAL_PROFILE, PERSONALITIES } from './personalities.js';
import { ensureAIContext, getAIPlayerIndicators, getAIPairIndicators } from './context.js';
import { AI_ACTION_KINDS, createActionDescriptor } from './actionSpace.js';
import { getPolicyImpactWeight } from './policyGenome.js';

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
  return values.reduce((total, value) => total + value, AI_NUM.N_0);
}

function roundTo(value, digits = AI_NUM.N_4) {
  const scale = AI_NUM.N_10 ** digits;
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
  return DEFAULT_META_PARAMS[key] ?? AI_NUM.N_1;
}

function getPolicy(meta, playerId) {
  return getProfile(meta, playerId)?.policy || {};
}

function emptyImpact() {
  return Object.fromEntries(IMPACT_KEYS.map(key => [key, AI_NUM.N_0]));
}

function addImpact(impact, key, value) {
  if (!IMPACT_KEYS.includes(key)) return;
  impact[key] = roundTo((impact[key] || AI_NUM.N_0) + (Number(value) || AI_NUM.N_0));
}

function addCostGainImpacts(impact, descriptor, actor) {
  const goldCost = Number(descriptor.costs.gold) || AI_NUM.N_0;
  const troopCost = Number(descriptor.costs.troops) || AI_NUM.N_0;
  const goldGain = Number(descriptor.gains.gold) || AI_NUM.N_0;
  const troopGain = Number(descriptor.gains.troops) || AI_NUM.N_0;
  const incomeGain = Number(descriptor.gains.income) || AI_NUM.N_0;
  const titleGain = Number(descriptor.gains.titles) || AI_NUM.N_0;
  const scoreGain = Number(descriptor.gains.score) || AI_NUM.N_0;

  addImpact(impact, 'economic', (goldGain - goldCost) * AI_NUM.N_0_12 + incomeGain * AI_NUM.N_0_55);
  addImpact(impact, 'military', (troopGain - troopCost) * AI_NUM.N_0_35);
  addImpact(impact, 'political', titleGain * AI_NUM.N_0_55);
  addImpact(impact, 'scoreGain', scoreGain * AI_NUM.N_0_7 + incomeGain * AI_NUM.N_0_18 + titleGain * AI_NUM.N_0_25);
  addImpact(impact, 'flexibility', -goldCost * AI_NUM.N_0_05 - troopCost * AI_NUM.N_0_18);
  if (actor?.gold != null && goldCost > actor.spendableGold) addImpact(impact, 'risk', AI_NUM.N_1_1);
}

function getThemeFromDescriptor(state, descriptor) {
  const theme = descriptor.payload.theme || state.themes?.[descriptor.payload.themeId];
  return theme || null;
}

function getRouteRiskFromState(state, themeId) {
  const route = state.currentInvasion?.route;
  if (!Array.isArray(route) || !route.length) return AI_NUM.N_0;
  const index = route.indexOf(themeId);
  if (index === -AI_NUM.N_1) return AI_NUM.N_0;
  return clamp(AI_NUM.N_1 - (index / Math.max(AI_NUM.N_1, route.length - AI_NUM.N_2)), AI_NUM.N_0, AI_NUM.N_1);
}

function scoreRelativeTarget(context, actorId, targetId) {
  const pair = getAIPairIndicators(context, actorId, targetId);
  if (!pair) return AI_NUM.N_0;
  const targetRank = pair.target.normalized.rank;
  const targetThreatened = pair.target.normalized.threatened;
  const actorBehind = pair.actor.positionScore < pair.target.positionScore ? AI_NUM.N_1 : AI_NUM.N_0;
  return clamp((targetRank * AI_NUM.N_0_6) + (actorBehind * AI_NUM.N_0_45) - (targetThreatened * AI_NUM.N_0_12), AI_NUM.N_0, AI_NUM.N_1_6);
}

function evaluateAppointment(state, context, actorId, descriptor, impact) {
  const appointeeId = Number(descriptor.payload.appointeeId ?? descriptor.beneficiaries[AI_NUM.N_0]);
  const type = descriptor.payload.type || descriptor.payload.titleType || '';
  const pair = getAIPairIndicators(context, actorId, appointeeId);
  const target = pair?.target;
  const targetAhead = pair?.targetAhead ? AI_NUM.N_1 : AI_NUM.N_0;
  const relationValue = target
    ? (target.relations.trustIn - target.relations.grievanceIn) * AI_NUM.N_0_04
    : AI_NUM.N_0;

  addImpact(impact, 'political', AI_NUM.N_0_75 + relationValue);
  addImpact(impact, 'diplomacy', AI_NUM.N_0_35 + relationValue);
  addImpact(impact, 'denial', targetAhead * -AI_NUM.N_0_25);
  addImpact(impact, 'risk', targetAhead * AI_NUM.N_0_22);
  if (type === 'STRATEGOS') addImpact(impact, 'military', AI_NUM.N_0_55);
  if (type === 'BISHOP') addImpact(impact, 'scoreGain', AI_NUM.N_0_35);
  if (type === 'EMPRESS' || type === 'CHIEF_EUNUCHS') addImpact(impact, 'political', AI_NUM.N_0_45);
}

function evaluateLandPurchase(state, context, actorId, descriptor, impact) {
  const actor = getAIPlayerIndicators(context, actorId);
  const theme = getThemeFromDescriptor(state, descriptor);
  if (!theme) return;
  const income = getThemeOwnerIncome(theme);
  const risk = getRouteRiskFromState(state, theme.id) * (context.invasion.present ? AI_NUM.N_1 : AI_NUM.N_0_35);
  const scarcity = actor?.themes === AI_NUM.N_0 ? AI_NUM.N_0_8 : actor?.themes <= AI_NUM.N_1 ? AI_NUM.N_0_35 : AI_NUM.N_0;

  addImpact(impact, 'economic', income * AI_NUM.N_0_5 + scarcity);
  addImpact(impact, 'scoreGain', income * AI_NUM.N_0_12 + (Number(theme.P) || AI_NUM.N_0) * AI_NUM.N_0_08);
  addImpact(impact, 'military', (Number(theme.L) || AI_NUM.N_0) * AI_NUM.N_0_08);
  addImpact(impact, 'risk', risk * AI_NUM.N_0_55);
  addImpact(impact, 'flexibility', -(Number(descriptor.costs.gold) || AI_NUM.N_0) * AI_NUM.N_0_08);
}

function evaluateChurchGift(state, context, actorId, descriptor, impact) {
  const theme = getThemeFromDescriptor(state, descriptor);
  if (!theme) return;
  const route = getRouteRiskFromState(state, theme.id);
  const income = getThemeOwnerIncome(theme);
  const churchYield = (Number(theme.P) || AI_NUM.N_0) + (Number(theme.T) || AI_NUM.N_0) + (Number(theme.C) || AI_NUM.N_0);
  addImpact(impact, 'scoreGain', churchYield * AI_NUM.N_0_18);
  addImpact(impact, 'political', AI_NUM.N_0_38);
  addImpact(impact, 'economic', -income * AI_NUM.N_0_48);
  addImpact(impact, 'flexibility', -AI_NUM.N_0_45);
  addImpact(impact, 'risk', -route * AI_NUM.N_0_22);
}

function evaluateRecruitDismiss(context, actorId, descriptor, impact) {
  const actor = getAIPlayerIndicators(context, actorId);
  const count = Number(descriptor.payload.count ?? AI_NUM.N_1) || AI_NUM.N_1;
  if (descriptor.kind === AI_ACTION_KINDS.RECRUIT) {
    addImpact(impact, 'military', AI_NUM.N_0_7 * count);
    addImpact(impact, 'survival', actor?.frontierNeed ? actor.frontierNeed * AI_NUM.N_0_12 : AI_NUM.N_0_08);
    addImpact(impact, 'flexibility', AI_NUM.N_0_18 * count);
    addImpact(impact, 'economic', -AI_NUM.N_0_2 * count);
  } else {
    addImpact(impact, 'military', -AI_NUM.N_0_55 * count);
    addImpact(impact, 'economic', AI_NUM.N_0_35 * count);
    addImpact(impact, 'flexibility', AI_NUM.N_0_3 * count);
    addImpact(impact, 'risk', actor?.frontierNeed ? actor.frontierNeed * AI_NUM.N_0_12 : AI_NUM.N_0_05);
  }
}

function evaluateMercenaryHire(context, actorId, descriptor, impact) {
  const actor = getAIPlayerIndicators(context, actorId);
  const count = Number(descriptor.payload.count ?? descriptor.gains.troops ?? AI_NUM.N_1) || AI_NUM.N_1;
  const demand = (actor?.frontierNeed || AI_NUM.N_0) + (actor?.normalized.rivalry || AI_NUM.N_0);
  addImpact(impact, 'military', AI_NUM.N_0_65 * count);
  addImpact(impact, 'survival', Math.min(AI_NUM.N_0_6, demand * AI_NUM.N_0_16 * count));
  addImpact(impact, 'political', AI_NUM.N_0_2 * count);
  addImpact(impact, 'economic', -(Number(descriptor.costs.gold) || AI_NUM.N_0) * AI_NUM.N_0_1);
  addImpact(impact, 'flexibility', AI_NUM.N_0_12 * count);
}

function evaluateRevocation(context, actorId, descriptor, impact) {
  const targetId = Number(descriptor.payload.targetPlayerId ?? descriptor.targets[AI_NUM.N_0]);
  const targetPressure = scoreRelativeTarget(context, actorId, targetId);
  addImpact(impact, 'denial', AI_NUM.N_0_65 + targetPressure);
  addImpact(impact, 'political', AI_NUM.N_0_35 + targetPressure * AI_NUM.N_0_25);
  addImpact(impact, 'diplomacy', -AI_NUM.N_0_75);
  addImpact(impact, 'risk', AI_NUM.N_0_35 + targetPressure * AI_NUM.N_0_15);
  addImpact(impact, 'flexibility', -(Number(descriptor.costs.troops) || AI_NUM.N_0) * AI_NUM.N_0_2);
}

function evaluateOrders(context, actorId, descriptor, impact) {
  const actor = getAIPlayerIndicators(context, actorId);
  const capital = Number(descriptor.commitments.capitalTroops) || AI_NUM.N_0;
  const frontier = Number(descriptor.commitments.frontierTroops) || AI_NUM.N_0;
  const total = Math.max(AI_NUM.N_1, capital + frontier);
  const frontierShare = frontier / total;
  const capitalShare = capital / total;
  const candidateId = Number(descriptor.payload.candidateId ?? descriptor.payload.candidate);
  const supportsLeader = Number.isInteger(candidateId) && getAIPlayerIndicators(context, candidateId)?.rank === AI_NUM.N_1;
  const selfClaim = candidateId === actorId;

  addImpact(impact, 'survival', frontierShare * (AI_NUM.N_0_55 + (context.invasion.expectedStrength * AI_NUM.N_0_04) + (actor?.frontierNeed || AI_NUM.N_0) * AI_NUM.N_0_18));
  addImpact(impact, 'political', capitalShare * (AI_NUM.N_0_5 + (selfClaim ? AI_NUM.N_0_55 : AI_NUM.N_0_2)));
  addImpact(impact, 'military', Math.min(AI_NUM.N_1_2, total * AI_NUM.N_0_08));
  addImpact(impact, 'denial', supportsLeader && !selfClaim ? -AI_NUM.N_0_25 : capitalShare * AI_NUM.N_0_25);
  addImpact(impact, 'risk', frontierShare < AI_NUM.N_0_35 && (actor?.frontierNeed || AI_NUM.N_0) > AI_NUM.N_0_8 ? AI_NUM.N_0_45 : AI_NUM.N_0);
  addImpact(impact, 'flexibility', -Math.abs(frontierShare - capitalShare) * AI_NUM.N_0_08);
}

function evaluateDeal(state, context, actorId, descriptor, impact) {
  const clauses = descriptor.payload.clauses || [];
  const counterpartyId = Number(descriptor.payload.counterpartyId ?? descriptor.targets[AI_NUM.N_0]);
  const targetPressure = scoreRelativeTarget(context, actorId, counterpartyId);
  let goldNet = AI_NUM.N_0;
  let troopCommitment = AI_NUM.N_0;
  let estateNet = AI_NUM.N_0;
  let appointmentPromises = AI_NUM.N_0;
  let protection = AI_NUM.N_0;

  for (const clause of clauses) {
    const actorGives = Number(clause.giverId) === Number(actorId);
    const sign = actorGives ? -AI_NUM.N_1 : AI_NUM.N_1;
    if (clause.kind === 'gold') goldNet += sign * (Number(clause.payload?.totalAmount) || AI_NUM.N_0);
    if (clause.kind === 'estate') estateNet += sign * AI_NUM.N_1;
    if (clause.kind === 'coup_support' || clause.kind === 'frontier_support') {
      troopCommitment += sign * (Number(clause.payload?.troopCount) || AI_NUM.N_0);
    }
    if (clause.kind === 'appointment_promise') appointmentPromises += sign * (Number(clause.payload?.appointmentCount) || AI_NUM.N_1);
    if (clause.kind === 'non_revocation') protection += sign * (Number(clause.durationTurns) || AI_NUM.N_1);
  }

  addImpact(impact, 'economic', goldNet * AI_NUM.N_0_1 + estateNet * AI_NUM.N_0_65);
  addImpact(impact, 'military', troopCommitment * AI_NUM.N_0_25);
  addImpact(impact, 'political', appointmentPromises * AI_NUM.N_0_45 + protection * AI_NUM.N_0_18);
  addImpact(impact, 'diplomacy', AI_NUM.N_0_35 + Math.max(AI_NUM.N_0, -targetPressure) * AI_NUM.N_0_1);
  addImpact(impact, 'flexibility', Math.min(AI_NUM.N_0_6, troopCommitment * AI_NUM.N_0_12) - Math.max(AI_NUM.N_0, -troopCommitment) * AI_NUM.N_0_3);
  addImpact(impact, 'risk', Math.max(AI_NUM.N_0, -goldNet) * AI_NUM.N_0_03 + Math.max(AI_NUM.N_0, -troopCommitment) * AI_NUM.N_0_16);
}

function evaluateDefenderReward(state, context, actorId, descriptor, impact) {
  const choice = descriptor.payload.choice;
  const theme = getThemeFromDescriptor(state, descriptor);
  const gold = Number(descriptor.gains.gold ?? descriptor.payload.gold ?? AI_NUM.N_0) || AI_NUM.N_0;
  const route = theme ? getRouteRiskFromState(state, theme.id) : AI_NUM.N_0;
  if (choice === 'gold') {
    addImpact(impact, 'economic', gold * AI_NUM.N_0_14);
    addImpact(impact, 'scoreGain', gold * AI_NUM.N_0_06);
    addImpact(impact, 'survival', -route * (AI_NUM.N_0_45 + context.invasion.expectedStrength * AI_NUM.N_0_03));
    addImpact(impact, 'risk', route * AI_NUM.N_0_45);
  } else {
    addImpact(impact, 'survival', AI_NUM.N_0_65 + route * AI_NUM.N_0_75);
    addImpact(impact, 'diplomacy', AI_NUM.N_0_25);
    addImpact(impact, 'economic', -gold * AI_NUM.N_0_08);
    addImpact(impact, 'risk', -route * AI_NUM.N_0_25);
  }
}

function evaluateTitleAssignment(context, actorId, descriptor, impact) {
  const assignment = descriptor.payload.assignment || {};
  let loyalHolders = AI_NUM.N_0;
  let leaderTitles = AI_NUM.N_0;
  let rivalDenials = AI_NUM.N_0;
  for (const holderId of Object.values(assignment).map(Number)) {
    const pair = getAIPairIndicators(context, actorId, holderId);
    if (!pair) continue;
    if (pair.target.relations.trustIn >= pair.target.relations.grievanceIn) loyalHolders++;
    if (pair.target.rank === AI_NUM.N_1 && holderId !== actorId) leaderTitles++;
    if (pair.targetAhead) rivalDenials++;
  }
  addImpact(impact, 'political', loyalHolders * AI_NUM.N_0_32);
  addImpact(impact, 'diplomacy', loyalHolders * AI_NUM.N_0_12);
  addImpact(impact, 'denial', rivalDenials * AI_NUM.N_0_18 - leaderTitles * AI_NUM.N_0_2);
  addImpact(impact, 'risk', leaderTitles * AI_NUM.N_0_16);
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
  const policy = getPolicy(meta, actorId);

  return roundTo(sensitivity * (
    impact.scoreGain * getPolicyImpactWeight(policy, 'scoreGain') +
    impact.survival * (getPolicyImpactWeight(policy, 'survival') + riskHorizon * AI_NUM.N_0_18) +
    impact.military * getPolicyImpactWeight(policy, 'military') +
    impact.political * getPolicyImpactWeight(policy, 'political') +
    impact.economic * getPolicyImpactWeight(policy, 'economic') +
    impact.denial * (getPolicyImpactWeight(policy, 'denial') + rivalDenialValue * AI_NUM.N_0_22) +
    impact.diplomacy * (getPolicyImpactWeight(policy, 'diplomacy') + cooperationValue * AI_NUM.N_0_18) +
    impact.flexibility * (getPolicyImpactWeight(policy, 'flexibility') + flexibilityValue * AI_NUM.N_0_22) +
    impact.timing * getPolicyImpactWeight(policy, 'timing') +
    impact.risk * (getPolicyImpactWeight(policy, 'risk') - riskHorizon * AI_NUM.N_0_16 + uncertaintyTolerance * AI_NUM.N_0_18)
  ));
}

export function evaluateActionConsequences(state, meta, actorId, rawDescriptor, context = null) {
  return withAINumericTuning(getPolicy(meta, actorId).numericTuning, () => {
  const descriptor = rawDescriptor.kind ? createActionDescriptor(rawDescriptor) : rawDescriptor;
  const world = context || ensureAIContext(state, meta, descriptor.phase || state.phase);
  const actor = getAIPlayerIndicators(world, actorId);
  const impact = emptyImpact();

  addCostGainImpacts(impact, descriptor, actor);
  evaluateByKind(state, world, actorId, descriptor, impact);

  if (descriptor.timing === 'future') addImpact(impact, 'timing', -AI_NUM.N_0_18);
  if (descriptor.reversibility === 'low') addImpact(impact, 'flexibility', -AI_NUM.N_0_28);
  if (descriptor.reversibility === 'high') addImpact(impact, 'flexibility', AI_NUM.N_0_16);

  const total = weightedTotal(meta, actorId, impact);
  return {
    descriptor,
    impact,
    total,
    score: roundTo((Number(descriptor.baseScore) || AI_NUM.N_0) + total),
  };
  });
}

export function scoreActionPolicy(state, meta, actorId, rawDescriptor, baseScore = AI_NUM.N_0, context = null) {
  const descriptor = createActionDescriptor({
    ...rawDescriptor,
    actorId,
    baseScore,
  });
  return evaluateActionConsequences(state, meta, actorId, descriptor, context);
}

export function rankWithConsequences(state, meta, actorId, actions, options = {}) {
  const limit = Math.max(AI_NUM.N_1, Number(options.limit) || AI_NUM.N_8);
  const stage = options.stage || state.phase;
  const context = ensureAIContext(state, meta, stage);
  return actions
    .slice()
    .sort((left, right) => (right.score || AI_NUM.N_0) - (left.score || AI_NUM.N_0))
    .slice(AI_NUM.N_0, limit)
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
        action.score || AI_NUM.N_0,
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
    const cost = Number(descriptor.costs.gold ?? payload.cost ?? AI_NUM.N_0) || AI_NUM.N_0;
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
      (Number(projected.pendingProfessionalArmies[descriptor.actorId][payload.officeKey]) || AI_NUM.N_0) + AI_NUM.N_1;
  } else if (descriptor.kind === AI_ACTION_KINDS.DISMISS && actor && payload.officeKey) {
    const count = Number(payload.count ?? AI_NUM.N_1) || AI_NUM.N_1;
    actor.professionalArmies[payload.officeKey] = Math.max(AI_NUM.N_0, (Number(actor.professionalArmies[payload.officeKey]) || AI_NUM.N_0) - count);
    if (actor.professionalArmies[payload.officeKey] <= AI_NUM.N_0) delete actor.professionalArmies[payload.officeKey];
  } else if (descriptor.kind === AI_ACTION_KINDS.MERCENARY_HIRE && actor) {
    const count = Number(payload.count ?? AI_NUM.N_1) || AI_NUM.N_1;
    const cost = Number(descriptor.costs.gold ?? getMercenaryHireCost(AI_NUM.N_0, count)) || AI_NUM.N_0;
    actor.gold -= cost;
    projected.currentMercenaryTroops = projected.currentMercenaryTroops || {};
    projected.currentMercenaryTroops[descriptor.actorId] = (Number(projected.currentMercenaryTroops[descriptor.actorId]) || AI_NUM.N_0) + count;
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
      if (actor) actor.gold += Number(payload.gold || descriptor.gains.gold || AI_NUM.N_0) || AI_NUM.N_0;
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
  stats.systemicDecisionCount = (stats.systemicDecisionCount || AI_NUM.N_0) + AI_NUM.N_1;
  stats.projectedUtilityTotal = (stats.projectedUtilityTotal || AI_NUM.N_0) + (Number(evaluation.total) || AI_NUM.N_0);
  stats.projectedRiskTotal = (stats.projectedRiskTotal || AI_NUM.N_0) + (Number(evaluation.impact?.risk) || AI_NUM.N_0);
  stats.projectedFlexibilityTotal = (stats.projectedFlexibilityTotal || AI_NUM.N_0) + (Number(evaluation.impact?.flexibility) || AI_NUM.N_0);
}

export function summarizePredictionStats(stats = {}, realizedUtility = AI_NUM.N_0) {
  const count = Math.max(AI_NUM.N_1, Number(stats.systemicDecisionCount) || AI_NUM.N_0);
  const projectedUtility = (Number(stats.projectedUtilityTotal) || AI_NUM.N_0) / count;
  const projectedRisk = (Number(stats.projectedRiskTotal) || AI_NUM.N_0) / count;
  const projectedFlexibility = (Number(stats.projectedFlexibilityTotal) || AI_NUM.N_0) / count;
  const normalizedRealized = clamp(Number(realizedUtility) || AI_NUM.N_0, -AI_NUM.N_4, AI_NUM.N_4);
  return {
    systemicDecisionCount: Number(stats.systemicDecisionCount) || AI_NUM.N_0,
    projectedUtility: roundTo(projectedUtility),
    projectedRisk: roundTo(projectedRisk),
    projectedFlexibility: roundTo(projectedFlexibility),
    projectionError: roundTo(Math.abs(projectedUtility - normalizedRealized) / AI_NUM.N_4),
    decisionQuality: roundTo(clamp(AI_NUM.N_1 - (Math.abs(projectedUtility - normalizedRealized) / AI_NUM.N_4), AI_NUM.N_0, AI_NUM.N_1)),
  };
}
