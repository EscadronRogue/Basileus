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
    invasionMargin: 1.45,
    capitalFallPenalty: 980,
    capitalRiskPenalty: 260,
    invasionDefeatPenalty: 18,
    invasionVictoryBonus: 10,
    recoveryBonus: 1.1,
    selfClaim: 0.58,
    throneBase: 12,
    mercenaryCostPenalty: 0.08,
    defenseContextWeight: 1.45,
    surplusDefensePenalty: 0.05,
    coupOpportunityWeight: 0.12,
    allyDefenseReliance: 0.68,
  },
  usurper: {
    throneBase: 44,
    selfClaim: 1.75,
    supportOtherClaimant: 0.25,
    invasionMargin: 0.72,
    capitalFallPenalty: 280,
    capitalRiskPenalty: 80,
    reserveValue: 0.12,
    coalitionWillingness: 0.55,
    surplusDefensePenalty: 0.28,
    coupOpportunityWeight: 0.9,
  },
  profiteer: {
    estateProfit: 7.2,
    estateBidCost: 0.78,
    estateThreatPenalty: 0.45,
    reserveValue: 0.55,
    mercenaryCostPenalty: 0.22,
    selfClaim: 0.92,
    invasionMargin: 0.74,
    surplusDefensePenalty: 0.32,
    coupOpportunityWeight: 0.28,
  },
  greedy: {
    ownRecipientBonus: 4.8,
    leaderDenial: 0.75,
    rivalDenial: 0.12,
    estateProfit: 6,
    estateBidCost: 0.95,
    selfClaim: 1.2,
    invasionMargin: 0.82,
    capitalFallPenalty: 300,
    reciprocityWeight: 0.35,
    favorSeekingWeight: 0.25,
    surplusDefensePenalty: 0.25,
  },
  loyalist: {
    selfClaim: 0.25,
    incumbentDefense: 1.8,
    supportOtherClaimant: 0.1,
    invasionMargin: 1.2,
    capitalFallPenalty: 720,
    coalitionWillingness: 0.45,
    surplusDefensePenalty: 0.08,
    coupOpportunityWeight: 0.18,
    allyDefenseReliance: 0.72,
  },
  copycat: {
    selfClaim: 0.9,
    supportOtherClaimant: 0.9,
    invasionMargin: 1,
    coalitionWillingness: 1.25,
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

function chooseCopycatOrderAction(state, meta, playerId) {
  const source = firstSubmittedOrders(state);
  if (!source) return chooseStrategicOrderAction(state, meta, playerId);
  return listLegalOrderActions(state, playerId)
    .map((action) => ({ action, score: scoreCopycatOrder(source, action) }))
    .sort((left, right) => (
      (right.score - left.score)
      || String(left.action.id).localeCompare(String(right.action.id))
    ))[0]?.action || null;
}

export function choosePolicyCourtAction(state, meta, playerId) {
  if (getPolicyId(meta, playerId) === 'random') return pickAction(state, listLegalCourtActions(state, playerId));
  return chooseStrategicCourtAction(state, meta, playerId);
}

export function choosePolicyOrderAction(state, meta, playerId, options = {}) {
  const policyId = getPolicyId(meta, playerId);
  if (policyId === 'random') return pickAction(state, listLegalOrderActions(state, playerId));
  if (policyId === 'copycat') return chooseCopycatOrderAction(state, meta, playerId);
  return chooseStrategicOrderAction(state, meta, playerId, options);
}

export function describePolicyOrderChoice(state, playerId, action) {
  return describeOrderChoice(state, playerId, action);
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
    const result = applyLegalAction(state, action, meta);
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
