import {
  applyLegalAction,
  listLegalCourtActions,
  listLegalEstateActions,
  listLegalOrderActions,
  listLegalRewardActions,
  listLegalTitleAssignments,
} from './legalActions.js';
import {
  buildCoupCoalitionContext,
  compareActionTieBreak,
  chooseStrategicCourtAction,
  chooseStrategicEstateActions,
  chooseStrategicOrderAction,
  chooseStrategicRewardChoice,
  chooseStrategicTitleAssignment,
  describeOrderChoice,
} from './strategy.js';

export { buildCoupCoalitionContext };

export const POLICY_WEIGHT_PRESETS = Object.freeze({
  strategic: {},
  tuned: {},
  defender: {
    invasionShortfallPenalty: 7.2,
    invasionSafetyValue: 1.8,
    invasionSurplusPenalty: 0.22,
    capitalFallPenalty: 980,
    capitalRiskPenalty: 260,
    recoveryBonus: 1.1,
    selfClaim: 0.58,
    throneBase: 12,
    mercenaryCostPenalty: 0.08,
    defenseContextWeight: 1.45,
    coupOpportunityWeight: 0.12,
    allyDefenseReliance: 0.68,
  },
  usurper: {
    throneBase: 44,
    selfClaim: 1.75,
    supportOtherClaimant: 0.25,
    invasionShortfallPenalty: 3.6,
    invasionSafetyValue: 0.55,
    invasionSurplusPenalty: 0.9,
    capitalFallPenalty: 280,
    capitalRiskPenalty: 80,
    reserveValue: 0.12,
    coupOpportunityWeight: 0.9,
    basileusTitleExpectation: 0.35,
  },
  profiteer: {
    estateProfit: 7.8,
    estateBidCost: 0.65,
    estateThreatPenalty: 0.28,
    reserveValue: 0.68,
    mercenaryCostPenalty: 0.25,
    selfClaim: 0.92,
    invasionShortfallPenalty: 4,
    invasionSafetyValue: 0.65,
    invasionSurplusPenalty: 0.85,
    coupOpportunityWeight: 0.36,
    basileusTitleExpectation: 1.2,
  },
  greedy: {
    ownRecipientBonus: 4.8,
    leaderDenial: 0.75,
    rivalDenial: 0.12,
    estateProfit: 6,
    estateBidCost: 0.95,
    selfClaim: 1.2,
    invasionShortfallPenalty: 4.4,
    invasionSafetyValue: 0.6,
    invasionSurplusPenalty: 0.7,
    capitalFallPenalty: 300,
    reciprocityWeight: 0.35,
    favorSeekingWeight: 0.25,
  },
  loyalist: {
    selfClaim: 0.25,
    incumbentDefense: 1.8,
    supportOtherClaimant: 0.1,
    invasionShortfallPenalty: 6.5,
    invasionSafetyValue: 1.4,
    invasionSurplusPenalty: 0.3,
    capitalFallPenalty: 720,
    coupOpportunityWeight: 0.18,
    allyDefenseReliance: 0.72,
    backerRevocationMercy: 1.35,
  },
  patron: {
    ownRecipientBonus: 2.2,
    leaderDenial: 0.95,
    rivalDenial: 0.22,
    throneBase: 36,
    selfClaim: 1.25,
    supportOtherClaimant: 0.75,
    invasionShortfallPenalty: 5.2,
    invasionSafetyValue: 1.1,
    invasionSurplusPenalty: 0.55,
    reciprocityWeight: 1.05,
    trustWeight: 0.7,
    favorSeekingWeight: 0.8,
    friendNeglectPenalty: 0.35,
    relationshipCoupWeight: 1,
    coupOpportunityWeight: 0.45,
    basileusTitleExpectation: 1.35,
    basileusRevocationFear: 0.55,
    backerTitleReward: 2.1,
    backerRevocationMercy: 2,
    titleQualityWeight: 1.6,
    regimeTreatmentWeight: 1.35,
    regimeUrgencyWeight: 0.9,
    kingmakerPenalty: 0.35,
  },
  tyrant: {
    ownRecipientBonus: 5.8,
    leaderDenial: 1.9,
    rivalDenial: 0.95,
    throneBase: 52,
    selfClaim: 1.7,
    supportOtherClaimant: 0.12,
    invasionShortfallPenalty: 3.4,
    invasionSafetyValue: 0.5,
    invasionSurplusPenalty: 1,
    capitalFallPenalty: 320,
    capitalRiskPenalty: 90,
    reserveValue: 0.18,
    reciprocityWeight: 0.15,
    grudgeWeight: 1.55,
    trustWeight: 0.05,
    favorSeekingWeight: 0.05,
    friendNeglectPenalty: 0.95,
    relationshipCap: 2.4,
    revocationContextWeight: 1.35,
    relationshipCoupWeight: 0.15,
    coupOpportunityWeight: 0.8,
    basileusTitleExpectation: 0.15,
    basileusRevocationFear: 1.95,
    backerTitleReward: 0.1,
    backerRevocationMercy: 0.05,
    titleQualityWeight: 0.35,
    regimeTreatmentWeight: 0.35,
    regimeUrgencyWeight: 1.15,
    kingmakerPenalty: 0.2,
  },
  kingmaker: {
    throneBase: 8,
    selfClaim: 0.22,
    supportOtherClaimant: 1.55,
    invasionShortfallPenalty: 5,
    invasionSafetyValue: 1,
    invasionSurplusPenalty: 0.6,
    reserveValue: 0.42,
    reciprocityWeight: 1,
    trustWeight: 0.65,
    favorSeekingWeight: 1.25,
    friendNeglectPenalty: 0.4,
    relationshipCoupWeight: 1.5,
    coupOpportunityWeight: 0.55,
    basileusTitleExpectation: 2,
    basileusRevocationFear: 1.45,
    supportLeaderPenalty: 1.4,
    titleQualityWeight: 1.75,
    regimeTreatmentWeight: 1.55,
    regimeUrgencyWeight: 1.35,
    allyDefenseReliance: 0.9,
    kingmakerPenalty: 0.75,
  },
  freeRider: {
    estateProfit: 5.8,
    estateBidCost: 0.9,
    invasionShortfallPenalty: 2.2,
    invasionSafetyValue: 0.2,
    invasionSurplusPenalty: 1.35,
    capitalFallPenalty: 180,
    capitalRiskPenalty: 50,
    recoveryBonus: 0.2,
    reserveValue: 0.95,
    mercenaryCostPenalty: 0.38,
    defenseContextWeight: 0.35,
    fundingContextWeight: 0.2,
    throneBase: 32,
    selfClaim: 1.3,
    supportOtherClaimant: 0.65,
    coupOpportunityWeight: 0.8,
    basileusTitleExpectation: 1.1,
    basileusRevocationFear: 0.9,
    allyDefenseReliance: 1,
  },
  overDefender: {
    invasionShortfallPenalty: 10,
    invasionSafetyValue: 2.7,
    invasionSurplusPenalty: 0.08,
    capitalFallPenalty: 1200,
    capitalRiskPenalty: 440,
    recoveryBonus: 1.8,
    reserveValue: 0.15,
    mercenaryCostPenalty: 0.04,
    throneBase: 8,
    selfClaim: 0.25,
    incumbentDefense: 1.4,
    supportOtherClaimant: 0.2,
    defenseContextWeight: 2.1,
    fundingContextWeight: 1.4,
    coupOpportunityWeight: 0.08,
    backerRevocationMercy: 1.1,
    allyDefenseReliance: 0.55,
  },
  estateShark: {
    ownRecipientBonus: 4.2,
    appointmentUnlockBonus: 5.5,
    leaderDenial: 1.25,
    rivalDenial: 0.6,
    estateProfit: 8.6,
    estateBidCost: 0.55,
    estateThreatPenalty: 0.15,
    invasionShortfallPenalty: 3.8,
    invasionSafetyValue: 0.6,
    invasionSurplusPenalty: 1,
    capitalFallPenalty: 260,
    capitalRiskPenalty: 70,
    reserveValue: 0.8,
    mercenaryCostPenalty: 0.28,
    throneBase: 30,
    selfClaim: 1,
    supportOtherClaimant: 0.75,
    coupOpportunityWeight: 0.5,
    basileusTitleExpectation: 1.4,
    backerTitleReward: 1,
    kingmakerPenalty: 0.55,
  },
  antiLeader: {
    leaderDenial: 2.4,
    rivalDenial: 0.1,
    invasionShortfallPenalty: 5,
    invasionSafetyValue: 0.9,
    invasionSurplusPenalty: 0.65,
    capitalFallPenalty: 580,
    capitalRiskPenalty: 200,
    reserveValue: 0.35,
    throneBase: 20,
    selfClaim: 0.7,
    supportLeaderPenalty: 2,
    supportOtherClaimant: 1,
    reciprocityWeight: 0.45,
    grudgeWeight: 1.2,
    relationshipCoupWeight: 0.65,
    coupOpportunityWeight: 0.65,
    basileusTitleExpectation: 0.9,
    basileusRevocationFear: 1.2,
    titleQualityWeight: 1.15,
    regimeTreatmentWeight: 0.95,
    regimeUrgencyWeight: 1.45,
    kingmakerPenalty: 1.1,
  },
  copycat: {
    selfClaim: 0.9,
    supportOtherClaimant: 0.9,
    invasionShortfallPenalty: 5.5,
    invasionSafetyValue: 1.1,
    invasionSurplusPenalty: 0.55,
  },
  random: {},
});

export const POLICY_IDS = Object.freeze(Object.keys(POLICY_WEIGHT_PRESETS));

export function normalizePolicyConfig(raw = null) {
  if (typeof raw === 'string') {
    const policyId = raw || 'strategic';
    return {
      policyId,
      strategyWeights: { ...(POLICY_WEIGHT_PRESETS[policyId] || {}) },
    };
  }
  const policyId = raw?.policyId || raw?.id || raw?.policy || 'strategic';
  return {
    policyId,
    label: raw?.label || null,
    strategyWeights: {
      ...(POLICY_WEIGHT_PRESETS[policyId] || {}),
      ...(raw?.strategyWeights || raw?.weights || {}),
    },
  };
}

function getPolicyId(meta, playerId) {
  return meta?.players?.[playerId]?.policyId || 'strategic';
}

function pickAction(state, actions) {
  if (!actions.length) return null;
  const rng = typeof state?.rng === 'function' ? state.rng : Math.random;
  return actions[Math.floor(rng() * actions.length)] || actions[0] || null;
}

function firstSubmittedOrders(state) {
  return Object.values(state?.allOrders || {}).find((orders) => orders?.armies) || null;
}

function destinationShare(orders, destination) {
  const entries = Object.values(orders?.armies || {});
  if (!entries.length) return 0;
  return entries.filter((entry) => entry.destination === destination).length / entries.length;
}

function scoreCopycatOrder(source, action) {
  const orders = action.orders || {};
  let score = 0;
  if (orders.candidate === source.candidate) score += 12;
  if (orders.mercenaries?.destination === source.mercenaries?.destination) score += 3;
  score -= Math.abs((Number(orders.mercenaries?.count) || 0) - (Number(source.mercenaries?.count) || 0)) * 0.8;
  score -= Math.abs(destinationShare(orders, 'frontier') - destinationShare(source, 'frontier')) * 6;
  return score;
}

function chooseCopycatOrderAction(state, meta, playerId, options = {}) {
  const source = firstSubmittedOrders(state);
  if (!source) return chooseStrategicOrderAction(state, meta, playerId);
  return listLegalOrderActions(state, playerId, options)
    .map((action) => ({ action, score: scoreCopycatOrder(source, action) }))
    .sort((left, right) => (
      (right.score - left.score)
      || compareActionTieBreak(state, playerId, left.action, right.action, 'copycat')
    ))[0]?.action || null;
}

export function choosePolicyCourtAction(state, meta, playerId) {
  if (getPolicyId(meta, playerId) === 'random') return pickAction(state, listLegalCourtActions(state, playerId));
  return chooseStrategicCourtAction(state, meta, playerId);
}

export function choosePolicyOrderAction(state, meta, playerId, options = {}) {
  const policyId = getPolicyId(meta, playerId);
  if (policyId === 'random') return pickAction(state, listLegalOrderActions(state, playerId, options));
  if (policyId === 'copycat') return chooseCopycatOrderAction(state, meta, playerId, options);
  return chooseStrategicOrderAction(state, meta, playerId, options);
}

export function describePolicyOrderChoice(state, playerId, action, meta = null, options = {}) {
  return describeOrderChoice(state, playerId, action, meta, options);
}

export function choosePolicyEstateActions(state, meta, playerId) {
  if (getPolicyId(meta, playerId) === 'random') {
    const action = pickAction(state, listLegalEstateActions(state, playerId));
    return action ? [action] : [];
  }
  return chooseStrategicEstateActions(state, meta, playerId);
}

export function applyPolicyEstateActions(state, meta, playerId) {
  const applied = [];
  for (const action of choosePolicyEstateActions(state, meta, playerId)) {
    const result = applyLegalAction(state, action);
    if (!result.ok) continue;
    applied.push(action);
  }
  return applied;
}

export function choosePolicyRewardChoice(state, meta, reward) {
  if (getPolicyId(meta, reward?.defenderId) === 'random') {
    const action = pickAction(
      state,
      listLegalRewardActions(state, reward?.defenderId).filter((entry) => entry.rewardId === reward?.id),
    );
    return action?.choice || 'empire';
  }
  return chooseStrategicRewardChoice(state, meta, reward);
}

export function choosePolicyTitleAssignment(state, meta, basileusId) {
  if (getPolicyId(meta, basileusId) === 'random') {
    return pickAction(state, listLegalTitleAssignments(state, basileusId));
  }
  return chooseStrategicTitleAssignment(state, meta, basileusId);
}
