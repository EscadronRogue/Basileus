// engine/turnflow.js - turn controller for the updated ruleset.
import { readTroopCount, runIncome } from './cascade.js';
import { resolveInvasion, applyInvasionResult } from './combat.js';
import { applyTitleRedistribution, autoConfirmFinishedCourtPlayers, resolveCoup } from './actions.js';
import { settleEstatePlans } from './estates.js';
import { finalizeDealRound, startCourtDealRound } from './deals.js';
import { recordHistoryEvent } from './history.js';
import { BALANCE, getBalance } from '../data/balance.js';
import {
  canTriggerInvasion,
  createInvasionInstance,
  getOfficeDisplayName,
  getPlayer,
  getPlayerMercenaryOrder,
  pickTriggerableInvasionTemplate,
  prepareInvasionForDraw,
  rollInvasionStrength,
  getPlayerName,
} from './state.js';
import { formatGold, formatTroops } from './presentation.js';
import { getDismissalGold, getMercenaryHireCost } from './rules.js';
import { addTemporaryCapitalSupport, expireCapitalSupport, getPlayerCapitalSupport } from './capitalSupport.js';
import { getPreferredCoupCandidate, normalizeCoupChoices } from './coup.js';
import {
  getDefaultDeploymentFunding,
  getDeploymentArmyDisplayName,
  getDeploymentArmyTroopTotal,
  getPlayerDeploymentArmyKeys,
} from './deployment.js';

export const PHASES = ['invasion', 'title_redistribution', 'court', 'income', 'estates', 'deployment', 'resolution', 'cleanup'];

function shouldRedistributeMajorTitles(state) {
  return Boolean(state?.majorTitleRedistributionPending);
}

function phasePreCourt(state) {
  if (shouldRedistributeMajorTitles(state)) phaseTitleRedistribution(state);
  else phaseCourt(state);
}

function drawNextTriggerableInvasion(state) {
  const skipped = [];
  if (!Array.isArray(state.invasionDeck)) state.invasionDeck = [];

  const createReplacement = () => {
    return createInvasionInstance(pickTriggerableInvasionTemplate(state, state.rng), state.rng);
  };

  const maxDraws = Math.max(1, state.invasionDeck.length) + 20;
  for (let i = 0; i < maxDraws; i++) {
    if (state.invasionDeck.length === 0) {
      state.invasionDeck.push(createReplacement());
    }

    const invasion = state.invasionDeck.shift();
    if (canTriggerInvasion(state, invasion)) {
      return { invasion, skipped };
    }

    skipped.push(invasion);

    state.invasionDeck.push(createReplacement());
  }

  throw new Error('Unable to draw a triggerable invasion.');
}

function recordSkippedInvasions(state, skipped, attemptedRound) {
  if (!skipped.length) return;
  if (!Array.isArray(state.skippedInvasions)) state.skippedInvasions = [];
  state.skippedInvasions.push(...skipped.map((invasion) => ({
    id: invasion?.id || 'unknown_invasion',
    name: invasion?.name || invasion?.id || 'Unknown invasion',
    round: attemptedRound,
    reason: 'no_imperial_targets',
  })));

  for (const invasion of skipped) {
    const invaderName = invasion?.name || invasion?.id || 'Unknown invasion';
    state.log.push({
      type: 'invasion_skipped',
      invader: invaderName,
      reason: 'no_imperial_targets',
      round: attemptedRound,
    });
    recordHistoryEvent(state, {
      category: 'system',
      type: 'invasion_skipped',
      round: attemptedRound,
      summary: `${invaderName} does not launch because none of its target provinces remain under imperial control.`,
      details: {
        invader: invaderName,
        reason: 'no_imperial_targets',
        route: Array.isArray(invasion?.route) ? invasion.route.slice() : [],
      },
    });
  }
}

function isStartingIncome(state) {
  return state.round === 1 && !state.startingIncomeResolved;
}

function buildStartingIncome(state) {
  return Object.fromEntries(state.players.map((player) => [player.id, getBalance(state).STARTING_INCOME_GOLD]));
}

function officeName(state, officeKey) {
  return getOfficeDisplayName(state, officeKey);
}

function getOrderArmyKeys(state, playerId) {
  return getPlayerDeploymentArmyKeys(state, playerId);
}

function getArmySize(state, playerId, officeKey) {
  return getDeploymentArmyTroopTotal(state, playerId, officeKey);
}

function normalizeDestination(value) {
  return value === 'capital' ? 'capital' : 'frontier';
}

function buildPlayerResolutionContribution(state, player, orders = {}) {
  const offices = [];
  let capitalTroops = 0;
  let frontierTroops = 0;

  for (const officeKey of getOrderArmyKeys(state, player.id)) {
    const totalTroops = getDeploymentArmyTroopTotal(state, player.id, officeKey);
    if (totalTroops <= 0) continue;
    const order = orders.armies?.[officeKey] || {};
    const rawFunded = Number.isInteger(Number(order.funded)) ? Number(order.funded) : getDefaultDeploymentFunding(totalTroops);
    const funded = Math.max(0, Math.min(totalTroops, rawFunded));
    const destination = normalizeDestination(order.destination);
    const officeCapital = destination === 'capital' ? funded : 0;
    const officeFrontier = destination === 'frontier' ? funded : 0;

    capitalTroops += officeCapital;
    frontierTroops += officeFrontier;
    offices.push({
      officeKey,
      officeName: getDeploymentArmyDisplayName(state, player.id, officeKey),
      totalTroops,
      fundedTroops: funded,
      unfundedTroops: totalTroops - funded,
      destination,
      capitalTroops: officeCapital,
      frontierTroops: officeFrontier,
    });
  }

  const mercenaries = getPlayerMercenaryOrder(state, player.id);
  if (mercenaries.count > 0) {
    if (mercenaries.destination === 'capital') capitalTroops += mercenaries.count;
    else frontierTroops += mercenaries.count;
  }

  const coupChoices = normalizeCoupChoices(state, orders.coupChoices);
  const preferredCandidateId = getPreferredCoupCandidate(state, player.id, { coupChoices });
  const passiveCapitalSupport = getPlayerCapitalSupport(state, player.id);

  return {
    playerId: player.id,
    playerName: getPlayerName(state, player.id),
    candidateId: preferredCandidateId,
    candidateName: preferredCandidateId == null ? null : getPlayerName(state, preferredCandidateId),
    coupChoices,
    capitalTroops,
    passiveCapitalSupport,
    frontierTroops,
    offices,
    mercenaries,
    debug: orders.debug || null,
  };
}

export function phaseInvasion(state) {
  state.phase = 'invasion';
  if (state.round >= state.maxRounds) {
    state.finalScoringPending = true;
    phasePreCourt(state);
    return;
  }

  const attemptedRound = state.round + 1;
  const { invasion, skipped } = drawNextTriggerableInvasion(state);
  state.round = attemptedRound;
  state.currentInvasion = null;
  state.invasionStrength = 0;
  recordSkippedInvasions(state, skipped, attemptedRound);

  state.currentInvasion = prepareInvasionForDraw(state, invasion, state.rng);
  state.log.push({
    type: 'invasion',
    invader: state.currentInvasion.name,
    strengthRange: state.currentInvasion.strength,
    round: state.round,
  });
  recordHistoryEvent(state, {
    category: 'system',
    type: 'invasion_drawn',
    summary: `Round ${state.round} begins with the ${state.currentInvasion.name} invasion.`,
    details: {
      invader: state.currentInvasion.name,
      strengthRange: state.currentInvasion.strength,
      route: state.currentInvasion.route.slice(),
    },
  });
}

export function phaseTitleRedistribution(state) {
  state.phase = 'title_redistribution';
}

export function confirmTitleRedistribution(state, playerId, assignments) {
  if (state.phase !== 'title_redistribution') return { ok: false, reason: 'The major offices can only be handed out when a new Basileus takes the throne.' };
  if (playerId !== state.basileusId) return { ok: false, reason: 'Only the Basileus hands out the major offices.' };
  const result = applyTitleRedistribution(state, state.basileusId, assignments);
  if (!result.ok) return result;
  state.majorTitleRedistributionPending = false;
  phaseCourt(state);
  return { ok: true };
}

export function phaseIncome(state) {
  state.phase = 'income';
  const computed = runIncome(state);
  const result = {
    ...computed,
    income: isStartingIncome(state) ? buildStartingIncome(state) : computed.income,
  };

  for (const [pidStr, amount] of Object.entries(result.income)) {
    const player = getPlayer(state, Number(pidStr));
    if (player) player.gold += amount;
  }
  state.startingIncomeResolved = state.startingIncomeResolved || state.round === 1;
  state.currentTroops = result.troops;
  state.lastIncome = {
    round: state.round,
    income: result.income,
    incomeBreakdown: result.incomeBreakdown,
    troops: result.troops,
    flow: result.flow,
  };

  state.log.push({
    type: 'income_complete',
    income: result.income,
    troops: result.troops,
    round: state.round,
  });
  recordHistoryEvent(state, {
    category: 'system',
    type: 'income',
    summary: `Income pays gold and raises troops for round ${state.round}.`,
    details: {
      income: Object.entries(result.income).map(([playerId, amount]) => ({
        playerId: Number(playerId),
        playerName: getPlayerName(state, Number(playerId)),
        amount,
      })),
      troops: Object.entries(result.troops).map(([officeKey, entry]) => ({
        officeKey,
        officeName: officeName(state, officeKey),
        troops: readTroopCount(entry),
      })),
    },
  });
  return result;
}

export function phaseCourt(state) {
  state.phase = 'court';
  const dealRound = startCourtDealRound(state);
  if (!dealRound.ok) throw new Error(dealRound.reason || 'Failed to prepare deals for the Offices phase.');
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  autoConfirmFinishedCourtPlayers(state);
  completeCourtPhase(state);
}

export function isCourtComplete(state) {
  return (state.courtActions?.playerConfirmed?.size || 0) === state.players.length;
}

export function completeCourtPhase(state) {
  if (!state || state.phase !== 'court' || !isCourtComplete(state)) return false;
  phaseIncome(state);
  if (state.finalScoringPending) {
    state.finalScoringPending = false;
    state.phase = 'scoring';
    return true;
  }
  phaseEstates(state);
  return true;
}

export function phaseEstates(state) {
  state.phase = 'estates';
  state.estatePlans = {};
  state.estatesReady = {};
}

export function phaseDeployment(state) {
  settleEstatePlans(state);
  state.phase = 'deployment';
  state.allOrders = {};
  state.mercenaryOrders = {};
  state.estatesReady = {};
}

export function setEstatesReady(state, playerId, ready) {
  if (state.phase !== 'estates') return { ok: false, reason: 'Estates are not active.' };
  if (!getPlayer(state, playerId)) return { ok: false, reason: 'Player not found.' };
  if (!state.estatesReady || typeof state.estatesReady !== 'object') state.estatesReady = {};
  if (ready) state.estatesReady[playerId] = true;
  else delete state.estatesReady[playerId];
  return { ok: true, ready: Boolean(state.estatesReady[playerId]) };
}

export function areEstatesReady(state) {
  if (state.phase !== 'estates') return false;
  return state.players.every((player) => Boolean(state.estatesReady?.[player.id]));
}

export function toggleEstatesReady(state, playerId) {
  const ready = !Boolean(state.estatesReady?.[playerId]);
  const result = setEstatesReady(state, playerId, ready);
  if (!result.ok) return result;
  if (areEstatesReady(state)) phaseDeployment(state);
  return { ...result, advanced: state.phase === 'deployment' };
}

export function submitOrders(state, playerId, orders) {
  const player = getPlayer(state, playerId);
  if (!player) return { ok: false, reason: 'Player not found.' };
  if (state.allOrders?.[playerId]) return { ok: false, reason: 'Your deployment is already locked.' };

  const normalizedOrders = {
    ...(orders || {}),
    armies: { ...(orders?.armies || {}) },
  };
  let dismissedTroops = 0;
  for (const officeKey of getOrderArmyKeys(state, playerId)) {
    const total = getArmySize(state, playerId, officeKey);
    const order = normalizedOrders.armies?.[officeKey] || {};
    const rawFunded = Number.isInteger(Number(order.funded)) ? Number(order.funded) : getDefaultDeploymentFunding(total);
    const funded = Math.max(0, Math.min(total, rawFunded));
    normalizedOrders.armies[officeKey] = {
      ...order,
      funded,
      destination: normalizeDestination(order.destination),
    };
    dismissedTroops += total - funded;
  }

  const mercCount = Math.max(0, Math.min(getBalance(state).MAX_MERCENARIES, Number(normalizedOrders.mercenaries?.count) || 0));
  normalizedOrders.mercenaries = {
    ...(normalizedOrders.mercenaries || {}),
    count: mercCount,
    destination: normalizeDestination(normalizedOrders.mercenaries?.destination),
  };
  const mercCost = getMercenaryHireCost(0, mercCount);
  const unfundedGold = getDismissalGold(dismissedTroops);
  player.gold += unfundedGold;
  player.gold -= mercCost;
  if (mercCount > 0) {
    state.mercenaryOrders[playerId] = {
      count: mercCount,
      destination: normalizedOrders.mercenaries.destination,
    };
  }

  state.allOrders[playerId] = normalizedOrders;
  const coupChoices = normalizeCoupChoices(state, normalizedOrders.coupChoices);
  const preferredCandidateId = getPreferredCoupCandidate(state, playerId, { coupChoices });
  recordHistoryEvent(state, {
    category: 'orders',
    type: 'orders_submitted',
    actorId: playerId,
    summary: `${getPlayerName(state, playerId)} locks deployment orders.`,
    details: {
      candidateId: preferredCandidateId,
      candidateName: preferredCandidateId == null ? null : getPlayerName(state, preferredCandidateId),
      coupChoices,
    },
  });
  return { ok: true, unfundedGold, mercCost };
}

export function allOrdersSubmitted(state) {
  return Object.keys(state.allOrders || {}).length === state.players.length;
}

export function phaseResolution(state) {
  state.phase = 'resolution';

  const capitalTroops = {};
  const orderBreakdowns = [];
  const frontierContributions = [];
  let totalFrontier = 0;

  for (const player of state.players) {
    const orders = state.allOrders[player.id];
    if (!orders) continue;
    const breakdown = buildPlayerResolutionContribution(state, player, orders);
    orderBreakdowns.push(breakdown);
    capitalTroops[player.id] = breakdown.capitalTroops;
    totalFrontier += breakdown.frontierTroops;
    if (breakdown.frontierTroops > 0) {
      frontierContributions.push({ playerId: player.id, playerName: breakdown.playerName, troops: breakdown.frontierTroops });
    }
  }

  for (const breakdown of orderBreakdowns) {
    recordHistoryEvent(state, {
      category: 'orders',
      type: 'orders_revealed',
      actorId: breakdown.playerId,
      actorAi: Boolean(breakdown.debug?.decision),
      summary: `${breakdown.playerName} reveals orders: ${formatTroops(breakdown.capitalTroops)} to Constantinople, ${formatTroops(breakdown.frontierTroops)} to the frontier.`,
      details: {
        candidateId: breakdown.candidateId,
        candidateName: breakdown.candidateName,
        coupChoices: breakdown.coupChoices,
        capitalTroops: breakdown.capitalTroops,
        passiveCapitalSupport: breakdown.passiveCapitalSupport,
        frontierTroops: breakdown.frontierTroops,
        offices: breakdown.offices,
        mercenaries: breakdown.mercenaries,
      },
      decision: breakdown.debug?.decision || null,
    });
  }

  const coupResult = resolveCoup(state, state.allOrders, capitalTroops);
  state.lastCoupResult = coupResult;
  state.nextBasileusId = coupResult.winner;
  recordHistoryEvent(state, {
    category: 'resolution',
    type: 'coup_result',
    summary: coupResult.winner === state.basileusId
      ? `${getPlayerName(state, coupResult.winner)} remains Basileus.`
      : `${getPlayerName(state, coupResult.winner)} wins the coup and claims the throne.`,
    details: {
      winnerId: coupResult.winner,
      winnerName: getPlayerName(state, coupResult.winner),
      votes: Object.entries(coupResult.votes).map(([candidateId, troops]) => ({
        candidateId: Number(candidateId),
        candidateName: getPlayerName(state, Number(candidateId)),
        troops,
      })),
      passiveSupport: coupResult.passiveSupport,
      tieBreak: coupResult.tieBreak,
    },
  });

  const invasion = state.currentInvasion;
  let warResult = null;
  if (invasion) {
    const rolled = rollInvasionStrength(invasion, state.rng);
    state.invasionStrength = rolled;
    warResult = {
      ...resolveInvasion(state, totalFrontier, rolled, invasion),
      contributions: frontierContributions,
    };
    applyInvasionResult(state, warResult);
    warResult.reconquestReward = applyAutomaticReconquestRewards(state, warResult, frontierContributions);
    applyBasileusLossPenalty(state, warResult);
    state.lastWarResult = warResult;
    state.log.push({
      type: 'war',
      invader: invasion.name,
      strength: rolled,
      frontier: totalFrontier,
      outcome: warResult.outcome,
      themesLost: warResult.themesLost,
      themesRecovered: warResult.themesRecovered,
      reconquestRewardProvinceCount: warResult.reconquestRewardProvinceCount,
      round: state.round,
    });
    recordHistoryEvent(state, {
      category: 'resolution',
      type: 'war_result',
      summary: warResult.outcome === 'victory'
        ? `The empire defeats the ${invasion.name}.`
        : warResult.outcome === 'defeat'
          ? `The empire fails to stop the ${invasion.name}.`
          : `The empire fights the ${invasion.name} to a stalemate.`,
      details: {
        invader: invasion.name,
        estimatedStrengthRange: invasion.strength.slice(),
        invaderStrength: rolled,
        frontierTroops: totalFrontier,
        outcome: warResult.outcome,
        reachedCPL: Boolean(warResult.reachedCPL),
        themesLost: warResult.themesLost.slice(),
        themesRecovered: warResult.themesRecovered.slice(),
        reconquestRewardProvinceCount: warResult.reconquestRewardProvinceCount,
        contributions: frontierContributions,
        reconquestReward: warResult.reconquestReward,
      },
    });
  }

  return { coupResult, warResult };
}

function rankedDefenders(contributions = []) {
  return contributions
    .filter((entry) => (Number(entry.troops) || 0) > 0)
    .slice()
    .sort((a, b) => (b.troops - a.troops) || (a.playerId - b.playerId));
}

function topRankedDefenders(contributions = []) {
  const ranked = rankedDefenders(contributions);
  const topTroops = Number(ranked[0]?.troops) || 0;
  if (topTroops <= 0) return [];
  return ranked.filter((entry) => Math.abs((Number(entry.troops) || 0) - topTroops) < 1e-9);
}

function formatPlayerNameList(state, playerIds = []) {
  const names = playerIds.map((playerId) => getPlayerName(state, playerId));
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function applyAutomaticReconquestRewards(state, warResult, contributions) {
  const recovered = Array.isArray(warResult?.themesRecovered) ? warResult.themesRecovered : [];
  const rewardProvinceCount = getReconquestRewardProvinceCount(warResult);
  if (rewardProvinceCount <= 0) return null;
  const defenders = topRankedDefenders(contributions);
  if (!defenders.length) return null;
  // So much gold and so much Triumph for each province won.
  const balance = getBalance(state);
  const totalGold = rewardProvinceCount * (Number(balance.WAR_REWARD_GOLD_PER_PROVINCE) || 0);
  const totalTriumph = rewardProvinceCount * (Number(balance.WAR_REWARD_TRIUMPH_PER_PROVINCE) || 0);
  const gold = Math.ceil(totalGold / defenders.length);
  const capitalSupport = Math.floor(totalTriumph / defenders.length);
  const recipients = defenders.map((defender) => {
    const player = getPlayer(state, defender.playerId);
    if (player) player.gold += gold;
    const support = capitalSupport > 0
      ? addTemporaryCapitalSupport(state, {
        kind: 'reconquest',
        label: 'Triumph',
        playerId: defender.playerId,
        amount: capitalSupport,
        activeRound: state.round + 1,
        themeIds: recovered,
      })
      : null;
    return {
      defenderId: defender.playerId,
      defenderName: defender.playerName,
      troops: defender.troops,
      gold,
      capitalSupport: support?.amount || capitalSupport,
    };
  });
  const reward = {
    defenderId: recipients.length === 1 ? recipients[0].defenderId : null,
    defenderName: recipients.length === 1 ? recipients[0].defenderName : null,
    troops: recipients[0]?.troops || 0,
    defenders: recipients,
    themeIds: recovered.slice(),
    rewardProvinceCount,
    totalGold,
    totalCapitalSupport: totalTriumph,
    shareCount: defenders.length,
    gold,
    capitalSupport,
    activeRound: state.round + 1,
  };
  state.log.push({
    type: 'reconquest_reward',
    player: reward.defenderId,
    players: recipients.map((entry) => entry.defenderId),
    themes: recovered.slice(),
    rewardProvinceCount,
    gold,
    capitalSupport,
    shareCount: defenders.length,
    round: state.round,
  });
  const recipientIds = recipients.map((entry) => entry.defenderId);
  const recipientText = formatPlayerNameList(state, recipientIds);
  const gainText = `${formatGold(gold)} plus ${formatTroops(capitalSupport)} of Triumph support`;
  const actionText = recovered.length ? 'reconquest' : 'repulse';
  recordHistoryEvent(state, {
    category: 'resolution',
    type: 'reconquest_reward',
    actorId: recipients.length === 1 ? recipients[0].defenderId : null,
    summary: recipients.length === 1
      ? `${recipientText} leads the ${actionText} and gains ${gainText} next round.`
      : `${recipientText} tie for the ${actionText} and each gain ${gainText} next round.`,
    details: reward,
  });
  return reward;
}

function getReconquestRewardProvinceCount(warResult) {
  const rewardProvinceCount = Number(warResult?.reconquestRewardProvinceCount);
  if (Number.isFinite(rewardProvinceCount) && rewardProvinceCount > 0) {
    return Math.floor(rewardProvinceCount);
  }
  return Array.isArray(warResult?.themesRecovered) ? warResult.themesRecovered.length : 0;
}

function applyBasileusLossPenalty(state, warResult) {
  const lost = Array.isArray(warResult?.themesLost) ? warResult.themesLost.length : 0;
  if (lost <= 0) return null;
  const penalizedBasileusId = state.basileusId;
  const unrest = lost * getBalance(state).UNREST_PER_LOST_PROVINCE;
  const penalty = addTemporaryCapitalSupport(state, {
    kind: 'lost_provinces',
    label: 'Unrest',
    playerId: penalizedBasileusId,
    amount: -unrest,
    activeRound: state.round + 1,
    themeIds: warResult.themesLost,
  });
  recordHistoryEvent(state, {
    category: 'resolution',
    type: 'basileus_loss_penalty',
    actorId: penalizedBasileusId,
    summary: `${getPlayerName(state, penalizedBasileusId)} loses ${formatTroops(lost, 'province')}: Unrest costs the Basileus ${unrest} support in the next coup.`,
    details: {
      basileusId: penalizedBasileusId,
      playerId: penalizedBasileusId,
      themesLost: warResult.themesLost.slice(),
      capitalSupport: penalty?.amount || -unrest,
      activeRound: state.round + 1,
    },
  });
  return penalty;
}

export function phaseCleanup(state) {
  state.phase = 'cleanup';
  finalizeDealRound(state);
  expireCapitalSupport(state);

  const basileusChanged = state.nextBasileusId !== state.basileusId;
  state.majorTitleRedistributionPending = basileusChanged;

  if (basileusChanged) {
    const oldBasileus = state.basileusId;
    state.basileusId = state.nextBasileusId;
    state.log.push({ type: 'new_basileus', old: oldBasileus, new: state.basileusId, round: state.round });
    recordHistoryEvent(state, {
      category: 'system',
      type: 'new_basileus',
      summary: `${getPlayerName(state, state.basileusId)} takes the throne from ${getPlayerName(state, oldBasileus)}.`,
      details: { oldBasileusId: oldBasileus, newBasileusId: state.basileusId },
    });
  }

  if (state.gameOver) return;
  const shouldRunFinalIncome = state.round >= state.maxRounds;

  state.allOrders = {};
  state.mercenaryOrders = {};
  state.estatesReady = {};
  state.currentTroops = {};
  state.currentInvasion = null;
  state.lastCoupResult = null;
  state.lastWarResult = null;
  state.courtActions = null;

  if (shouldRunFinalIncome) {
    state.finalScoringPending = true;
    phasePreCourt(state);
  }
}

export function advanceToNextInteractivePhase(state) {
  while (true) {
    if (state.gameOver || state.phase === 'scoring') return;
    if (state.phase === 'setup' || state.phase === 'cleanup') {
      phaseInvasion(state);
      continue;
    }
    if (state.phase === 'invasion') {
      if (state.phase === 'scoring') return;
      phasePreCourt(state);
      return;
    }
    if (state.phase === 'title_redistribution') return;
    if (state.phase === 'income') {
      if (state.finalScoringPending) {
        state.finalScoringPending = false;
        state.phase = 'scoring';
        return;
      }
      phaseEstates(state);
      return;
    }
    if (state.phase === 'court' || state.phase === 'estates' || state.phase === 'deployment' || state.phase === 'resolution') return;
    break;
  }
}
