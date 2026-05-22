// engine/turnflow.js - turn controller for the updated ruleset.
import { readTroopEntry, runIncome } from './cascade.js';
import { resolveInvasion, applyInvasionResult } from './combat.js';
import { applyTitleRedistribution, autoConfirmFinishedCourtPlayers, resolveCoup, settleLandAuctions } from './actions.js';
import { finalizeDealRound, startCourtDealRound } from './deals.js';
import { recordHistoryEvent } from './history.js';
import { getOfficeDisplayName, getPlayer, getPlayerMercenaryOrder, rollInvasionStrength } from './state.js';
import { formatGold, formatTroops } from './presentation.js';
import { getDefenderRewardGold, getMercenaryHireCost, getThemeProfitValue } from './rules.js';
import {
  getDeploymentArmyDisplayName,
  getDeploymentArmyTroopEntry,
  getDeploymentArmyTroopTotal,
  getPlayerDeploymentArmyKeys,
} from './deployment.js';

export const PHASES = ['invasion', 'title_redistribution', 'court', 'income', 'estates', 'deployment', 'resolution', 'cleanup'];
export const STARTING_INCOME_GOLD = 4;

function isStartingIncome(state) {
  return state.round === 1 && !state.startingIncomeResolved;
}

function buildStartingIncome(state) {
  return Object.fromEntries(state.players.map((player) => [player.id, STARTING_INCOME_GOLD]));
}

function playerName(state, playerId) {
  const player = getPlayer(state, playerId);
  return player?.firstName ? `${player.firstName} ${player.dynasty}`.trim() : player?.dynasty || `Player ${Number(playerId) + 1}`;
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
    const pool = getDeploymentArmyTroopEntry(state, player.id, officeKey);
    const totalTroops = pool.normal + pool.capitalLocked;
    if (totalTroops <= 0) continue;
    const order = orders.armies?.[officeKey] || {};
    const funded = Math.max(0, Math.min(totalTroops, Number(order.funded) || 0));
    const fundedLocked = Math.min(pool.capitalLocked, funded);
    const fundedNormal = Math.min(pool.normal, Math.max(0, funded - fundedLocked));
    const destination = normalizeDestination(order.destination);
    const officeCapital = fundedLocked + (destination === 'capital' ? fundedNormal : 0);
    const officeFrontier = destination === 'frontier' ? fundedNormal : 0;

    capitalTroops += officeCapital;
    frontierTroops += officeFrontier;
    offices.push({
      officeKey,
      officeName: getDeploymentArmyDisplayName(state, player.id, officeKey),
      totalTroops,
      fundedTroops: funded,
      unfundedTroops: totalTroops - funded,
      normalTroops: pool.normal,
      capitalLockedTroops: pool.capitalLocked,
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

  return {
    playerId: player.id,
    playerName: playerName(state, player.id),
    candidateId: orders.candidate,
    candidateName: playerName(state, orders.candidate),
    capitalTroops,
    frontierTroops,
    offices,
    mercenaries,
    debug: orders.debug || null,
  };
}

export function phaseInvasion(state) {
  state.round += 1;
  state.phase = 'invasion';
  if (state.invasionDeck.length === 0) {
    state.finalScoringPending = true;
    phaseTitleRedistribution(state);
    return;
  }
  state.currentInvasion = state.invasionDeck.shift();
  state.invasionStrength = 0;
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
  if (state.phase !== 'title_redistribution') return { ok: false, reason: 'Title redistribution is not available right now.' };
  if (playerId !== state.basileusId) return { ok: false, reason: 'Only the Basileus may redistribute major titles.' };
  const result = applyTitleRedistribution(state, state.basileusId, assignments);
  if (!result.ok) return result;
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
        playerName: playerName(state, Number(playerId)),
        amount,
      })),
      troops: Object.entries(result.troops).map(([officeKey, entry]) => {
        const troopEntry = readTroopEntry(entry);
        return {
          officeKey,
          officeName: officeName(state, officeKey),
          normal: troopEntry.normal,
          capitalLocked: troopEntry.capitalLocked,
        };
      }),
    },
  });
  return result;
}

export function phaseCourt(state) {
  state.phase = 'court';
  const dealRound = startCourtDealRound(state);
  if (!dealRound.ok) throw new Error(dealRound.reason || 'Failed to prepare the court deal state.');
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
  state.landAuctions = {};
  state.estatesReady = {};
}

export function phaseDeployment(state) {
  settleLandAuctions(state);
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
  if (state.allOrders?.[playerId]) return { ok: false, reason: 'Orders are already locked for this seat.' };

  let unfundedGold = 0;
  for (const officeKey of getOrderArmyKeys(state, playerId)) {
    const total = getArmySize(state, playerId, officeKey);
    const funded = Math.max(0, Math.min(total, Number(orders.armies?.[officeKey]?.funded) || 0));
    unfundedGold += total - funded;
  }

  const mercCount = Math.max(0, Math.min(10, Number(orders.mercenaries?.count) || 0));
  const mercCost = getMercenaryHireCost(0, mercCount);
  player.gold += unfundedGold;
  player.gold -= mercCost;
  if (mercCount > 0) {
    state.mercenaryOrders[playerId] = {
      count: mercCount,
      destination: normalizeDestination(orders.mercenaries?.destination),
    };
  }

  state.allOrders[playerId] = orders;
  recordHistoryEvent(state, {
    category: 'orders',
    type: 'orders_submitted',
    actorId: playerId,
    summary: `${playerName(state, playerId)} locks deployment orders.`,
    details: { candidateId: orders.candidate, candidateName: playerName(state, orders.candidate) },
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
      summary: `${breakdown.playerName} reveals orders: ${formatTroops(breakdown.capitalTroops)} support ${breakdown.candidateName} in the capital, and ${formatTroops(breakdown.frontierTroops)} go to the frontier.`,
      details: {
        candidateId: breakdown.candidateId,
        candidateName: breakdown.candidateName,
        capitalTroops: breakdown.capitalTroops,
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
      ? `${playerName(state, coupResult.winner)} remains Basileus.`
      : `${playerName(state, coupResult.winner)} wins the coup and claims the throne.`,
    details: {
      winnerId: coupResult.winner,
      winnerName: playerName(state, coupResult.winner),
      votes: Object.entries(coupResult.votes).map(([candidateId, troops]) => ({
        candidateId: Number(candidateId),
        candidateName: playerName(state, Number(candidateId)),
        troops,
      })),
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
    state.pendingDefenderRewards = createDefenderRewardQueue(state, warResult, frontierContributions);
    preparePendingReconquestRewards(state, state.pendingDefenderRewards);
    warResult.defenderRewards = state.pendingDefenderRewards;
    state.lastWarResult = warResult;
    state.log.push({
      type: 'war',
      invader: invasion.name,
      strength: rolled,
      frontier: totalFrontier,
      outcome: warResult.outcome,
      themesLost: warResult.themesLost,
      themesRecovered: warResult.themesRecovered,
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
        contributions: frontierContributions,
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

function restoreReconqueredTheme(state, theme) {
  if (!theme || theme.id === 'CPL') return false;
  theme.occupied = false;
  if (theme.suspendedOwner != null) {
    theme.owner = theme.suspendedOwner;
    theme.suspendedOwner = null;
  } else {
    theme.owner = null;
  }
  theme.strategos = null;
  return true;
}

function setReconquestThemeStatus(state, themeId, recovered) {
  const theme = state.themes[themeId];
  if (!theme || theme.id === 'CPL') return false;
  if (recovered) return restoreReconqueredTheme(state, theme);
  theme.occupied = true;
  theme.strategos = null;
  return true;
}

function syncRewardTheme(reward, state, themeId) {
  const theme = state.themes[themeId];
  reward.themeId = themeId;
  reward.themeName = theme?.name || themeId;
  reward.goldValue = getDefenderRewardGold(theme);
}

function getReconquestThemeOrder(rewards) {
  return rewards
    .map((reward, fallbackIndex) => ({
      themeId: reward.originalThemeId || reward.themeId,
      index: Number.isFinite(Number(reward.reconquestIndex)) ? Number(reward.reconquestIndex) : fallbackIndex,
    }))
    .filter((entry) => Boolean(entry.themeId))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.themeId);
}

function getRemainingReconquestThemeIds(rewards) {
  const assigned = new Set(rewards.filter((reward) => reward.resolved && reward.themeId).map((reward) => reward.themeId));
  return getReconquestThemeOrder(rewards).filter((themeId) => !assigned.has(themeId));
}

function reassignUnresolvedDefenderRewards(state, rewards) {
  const remaining = getRemainingReconquestThemeIds(rewards);
  let nextIndex = 0;
  for (const reward of rewards) {
    if (reward.resolved) continue;
    const themeId = remaining[nextIndex];
    if (themeId) syncRewardTheme(reward, state, themeId);
    nextIndex += 1;
  }
}

function preparePendingReconquestRewards(state, rewards) {
  if (!Array.isArray(rewards) || rewards.length === 0) return;
  for (const themeId of getReconquestThemeOrder(rewards)) setReconquestThemeStatus(state, themeId, false);
  reassignUnresolvedDefenderRewards(state, rewards);
}

export function createDefenderRewardQueue(state, warResult, contributions) {
  const themes = Array.isArray(warResult?.themesRecovered) ? warResult.themesRecovered : [];
  const defenders = rankedDefenders(contributions);
  if (themes.length === 0 || defenders.length === 0) return [];
  return themes.map((themeId, i) => {
    const defender = defenders[i % defenders.length];
    const theme = state.themes[themeId];
    return {
      id: `${state.round}:${i}:${themeId}:${defender.playerId}`,
      themeId,
      originalThemeId: themeId,
      reconquestIndex: i,
      themeName: theme?.name || themeId,
      defenderId: defender.playerId,
      defenderName: defender.playerName,
      rank: (i % defenders.length) + 1,
      troops: defender.troops,
      goldValue: getDefenderRewardGold(theme),
      resolved: false,
      choice: null,
      gold: 0,
    };
  });
}

export function getPendingDefenderRewards(state, playerId = null) {
  const rewards = Array.isArray(state.pendingDefenderRewards) ? state.pendingDefenderRewards : [];
  return rewards.filter((reward) => !reward.resolved && (playerId == null || reward.defenderId === playerId));
}

export function hasPendingDefenderRewards(state) {
  return getPendingDefenderRewards(state).length > 0;
}

export function applyDefenderRewardChoice(state, rewardId, playerId, choice = 'land') {
  const rewards = Array.isArray(state.pendingDefenderRewards) ? state.pendingDefenderRewards : [];
  const reward = rewards.find((entry) => entry.id === rewardId);
  if (!reward) return { ok: false, reason: 'No such defender reward.' };
  if (reward.resolved) return { ok: false, reason: 'That defender reward is already resolved.' };
  if (reward.defenderId !== playerId) return { ok: false, reason: 'Only the rewarded defender may choose this reward.' };

  const remainingThemeIds = getRemainingReconquestThemeIds(rewards);
  const normalizedChoice = choice === 'gold' ? 'gold' : 'empire';
  const affectedThemeId = normalizedChoice === 'gold' ? remainingThemeIds[remainingThemeIds.length - 1] : remainingThemeIds[0];
  const theme = state.themes[affectedThemeId];
  if (!theme) return { ok: false, reason: 'Rewarded province no longer exists.' };
  syncRewardTheme(reward, state, affectedThemeId);

  if (normalizedChoice === 'empire') {
    if (!setReconquestThemeStatus(state, affectedThemeId, true)) return { ok: false, reason: 'That province can no longer be restored.' };
    reward.choice = 'empire';
    reward.gold = 0;
  } else {
    const player = getPlayer(state, playerId);
    const gold = getDefenderRewardGold(theme);
    if (player) player.gold += gold;
    setReconquestThemeStatus(state, affectedThemeId, false);
    reward.choice = 'gold';
    reward.gold = gold;
  }

  reward.resolved = true;
  reassignUnresolvedDefenderRewards(state, rewards);
  state.log.push({ type: 'defender_reward', player: playerId, theme: reward.themeId, choice: reward.choice, gold: reward.gold || 0, round: state.round });
  recordHistoryEvent(state, {
    category: 'resolution',
    type: 'defender_reward',
    actorId: playerId,
    summary: reward.choice === 'empire'
      ? `${playerName(state, playerId)} restores ${theme?.name || reward.themeId} to the empire as free-citizen land.`
      : `${playerName(state, playerId)} takes ${formatGold(reward.gold || 0)} while ${theme?.name || reward.themeId} remains occupied.`,
    details: {
      themeId: reward.themeId,
      themeName: theme?.name || reward.themeId,
      defenderId: playerId,
      rank: reward.rank,
      contribution: reward.troops,
      choice: reward.choice,
      gold: reward.gold || 0,
      profit: getThemeProfitValue(theme),
    },
  });
  return { ok: true, reward };
}

export function autoResolveDefenderRewards(state, shouldResolvePlayer = () => true) {
  const resolved = [];
  for (const reward of getPendingDefenderRewards(state)) {
    if (!shouldResolvePlayer(reward.defenderId, reward)) continue;
    const result = applyDefenderRewardChoice(state, reward.id, reward.defenderId, 'empire');
    if (result.ok) resolved.push(result.reward);
  }
  return resolved;
}

export function applyDefenderRewards(state, warResult, contributions) {
  state.pendingDefenderRewards = createDefenderRewardQueue(state, warResult, contributions);
  preparePendingReconquestRewards(state, state.pendingDefenderRewards);
  if (warResult) warResult.defenderRewards = state.pendingDefenderRewards;
  return autoResolveDefenderRewards(state);
}

export function phaseCleanup(state) {
  state.phase = 'cleanup';
  finalizeDealRound(state);

  if (state.nextBasileusId !== state.basileusId) {
    const oldBasileus = state.basileusId;
    state.basileusId = state.nextBasileusId;
    state.log.push({ type: 'new_basileus', old: oldBasileus, new: state.basileusId, round: state.round });
    recordHistoryEvent(state, {
      category: 'system',
      type: 'new_basileus',
      summary: `${playerName(state, state.basileusId)} takes the throne from ${playerName(state, oldBasileus)}.`,
      details: { oldBasileusId: oldBasileus, newBasileusId: state.basileusId },
    });
  }

  if (state.gameOver) return;
  const shouldRunFinalIncome = state.invasionDeck.length === 0 && state.round >= state.maxRounds;

  state.allOrders = {};
  state.mercenaryOrders = {};
  state.estatesReady = {};
  state.currentTroops = {};
  state.currentInvasion = null;
  state.lastCoupResult = null;
  state.lastWarResult = null;
  state.pendingDefenderRewards = [];
  state.courtActions = null;

  if (shouldRunFinalIncome) {
    state.finalScoringPending = true;
    phaseTitleRedistribution(state);
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
      phaseTitleRedistribution(state);
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
