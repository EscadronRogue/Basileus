// engine/turnflow.js — Streamlined turn flow controller
// Phases: invasion → administration → court → orders → resolution → cleanup
// Most phases auto-resolve. Only Court and Orders require player input.

import { runAdministration } from './cascade.js';
import { resolveInvasion, applyInvasionResult } from './combat.js';
import { resolveCoup, payMaintenance, restoreSuspendedProfessionals, disbandMercenaries } from './actions.js';
import { recordHistoryEvent } from './history.js';
import { rollInvasionStrength, getPlayer, formatPlayerLabel } from './state.js';
import { resetTurnCounters } from './turnCounters.js';
import { MAJOR_TITLES } from '../data/titles.js';

export const PHASES = ['invasion', 'administration', 'court', 'orders', 'resolution', 'cleanup'];
export const STARTING_ADMINISTRATION_GOLD = 4;

function isStartingAdministration(state) {
  return state.round === 1 && !state.startingAdministrationResolved;
}

function buildStartingAdministrationIncome(state) {
  return Object.fromEntries(state.players.map(player => [player.id, STARTING_ADMINISTRATION_GOLD]));
}

function playerName(state, playerId) {
  const player = getPlayer(state, playerId);
  return player ? formatPlayerLabel(player) : `Player ${Number(playerId) + 1}`;
}

function officeName(state, officeKey) {
  if (officeKey === 'BASILEUS') return 'Basileus';
  if (MAJOR_TITLES[officeKey]) return MAJOR_TITLES[officeKey].name;
  if (officeKey.startsWith('STRAT_')) {
    const themeId = officeKey.replace('STRAT_', '');
    return `Strategos of ${state.themes[themeId]?.name || themeId}`;
  }
  return officeKey;
}

function buildPlayerResolutionContribution(state, player, orders) {
  const officeKeys = new Set(Object.keys(player.professionalArmies || {}));

  if (state.currentLevies) {
    for (const officeKey of Object.keys(state.currentLevies)) {
      if (getOfficeHolder(state, officeKey) === player.id) {
        officeKeys.add(officeKey);
      }
    }
  }

  const offices = [];
  let capitalTroops = 0;
  let frontierTroops = 0;

  for (const officeKey of officeKeys) {
    const professionalTroops = player.professionalArmies?.[officeKey] || 0;
    const levyTroops = getOfficeHolder(state, officeKey) === player.id ? (state.currentLevies?.[officeKey] || 0) : 0;
    const totalTroops = professionalTroops + levyTroops;
    if (totalTroops <= 0) continue;

    // Court titles that grant capital-locked levies cannot send their troops to the
    // frontier. Their orders are always treated as 'capital' regardless of player input.
    const destination = CAPITAL_LOCKED_OFFICES.has(officeKey)
      ? 'capital'
      : (orders.deployments?.[officeKey] || 'frontier');
    if (destination === 'capital') capitalTroops += totalTroops;
    else frontierTroops += totalTroops;

    offices.push({
      officeKey,
      officeName: officeName(state, officeKey),
      professionalTroops,
      levyTroops,
      totalTroops,
      destination,
    });
  }

  // The mercenary army is a single pool, not tied to an office. The player
  // chooses one destination for the whole army during the orders phase.
  const mercenaryTroops = Math.max(0, Number(player.mercenaryArmy) || 0);
  if (mercenaryTroops > 0) {
    const destination = orders.mercenaryDeployment === 'capital' ? 'capital' : 'frontier';
    if (destination === 'capital') capitalTroops += mercenaryTroops;
    else frontierTroops += mercenaryTroops;
    offices.push({
      officeKey: 'MERCENARY_ARMY',
      officeName: 'Mercenary Army',
      professionalTroops: 0,
      levyTroops: 0,
      mercenaryTroops,
      totalTroops: mercenaryTroops,
      destination,
    });
  }

  return {
    playerId: player.id,
    playerName: playerName(state, player.id),
    candidateId: orders.candidate,
    candidateName: playerName(state, orders.candidate),
    capitalTroops,
    frontierTroops,
    offices,
    mercenaryArmy: mercenaryTroops,
    mercenaryDeployment: orders.mercenaryDeployment === 'capital' ? 'capital' : 'frontier',
    debug: orders.debug || null,
  };
}

// ─── Phase: Invasion ───
export function phaseInvasion(state) {
  state.round++;
  state.phase = 'invasion';

  if (state.invasionDeck.length === 0) {
    // No more invasions → game ends
    state.phase = 'scoring';
    return;
  }

  state.currentInvasion = state.invasionDeck.shift();
  state.invasionStrength = 0; // Will be rolled at resolution
  state.log.push({
    type: 'invasion',
    invader: state.currentInvasion.name,
    strengthRange: state.currentInvasion.strength,
    round: state.round
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

// ─── Phase: Administration (auto-resolved) ───
export function phaseAdministration(state) {
  state.phase = 'administration';
  const administration = runAdministration(state);
  const result = {
    ...administration,
    income: isStartingAdministration(state)
      ? buildStartingAdministrationIncome(state)
      : administration.income,
  };

  // Apply gold income
  for (const [pidStr, amount] of Object.entries(result.income)) {
    const pid = Number(pidStr);
    const player = state.players.find(p => p.id === pid);
    if (player) player.gold += amount;
  }
  state.startingAdministrationResolved = state.startingAdministrationResolved || state.round === 1;

  // Store levies for deployment phase
  state.currentLevies = result.levies;

  state.log.push({ type: 'admin_complete', income: result.income, levies: result.levies, round: state.round });
  recordHistoryEvent(state, {
    category: 'system',
    type: 'administration',
    summary: `Administration resolves for round ${state.round}.`,
    details: {
      income: Object.entries(result.income).map(([playerId, amount]) => ({
        playerId: Number(playerId),
        playerName: playerName(state, Number(playerId)),
        amount,
      })),
      levies: Object.entries(result.levies).map(([officeKey, amount]) => ({
        officeKey,
        officeName: officeName(state, officeKey),
        amount,
      })),
    },
  });
  return result;
}

// ─── Phase: Court (requires player input) ───
// This phase doesn't auto-resolve — the UI drives it.
// Players perform actions: appointments, purchases, gifts, mercenary hiring,
// negotiations, revocations. The phase ends when every player confirms.
// Appointments are no longer mandatory: cost-gated multiple appointments
// replace the old "exactly one mandatory appointment" requirement.
export function phaseCourt(state) {
  state.phase = 'court';
  resetTurnCounters(state);
  state.mercenariesHiredThisRound = {};
  for (const player of state.players) {
    player.mercenaryArmy = 0;
  }
  state.courtActions = { playerConfirmed: new Set() };
}

export function isCourtComplete(state) {
  const ca = state.courtActions;
  return ca?.playerConfirmed?.size === state.players.length;
}

// ─── Phase: Orders (secret, simultaneous — requires player input) ───
export function phaseOrders(state) {
  state.phase = 'orders';
  state.allOrders = {};
  // Each player submits: deployments (per-office capital/frontier), the
  // mercenary army's destination, and a Basileus candidate. Mercenary hiring
  // already happened in the court phase.
}

export function submitOrders(state, playerId, orders) {
  // orders: { deployments: { officeKey: 'capital'|'frontier' }, mercenaryDeployment: 'capital'|'frontier', candidate: playerId }
  state.allOrders[playerId] = orders;
  recordHistoryEvent(state, {
    category: 'orders',
    type: 'orders_submitted',
    actorId: playerId,
    summary: `${playerName(state, playerId)} seals secret orders.`,
    details: {
      candidateId: orders.candidate,
      candidateName: playerName(state, orders.candidate),
      mercenaryDeployment: orders.mercenaryDeployment === 'capital' ? 'capital' : 'frontier',
    },
  });
}

export function allOrdersSubmitted(state) {
  return Object.keys(state.allOrders).length === state.players.length;
}

// ─── Phase: Resolution (auto after all orders revealed) ───
export function phaseResolution(state) {
  state.phase = 'resolution';

  // 1. Compute capital and frontier troops
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
      frontierContributions.push({
        playerId: player.id,
        playerName: breakdown.playerName,
        troops: breakdown.frontierTroops,
      });
    }
  }

  for (const breakdown of orderBreakdowns) {
    recordHistoryEvent(state, {
      category: 'orders',
      type: 'orders_revealed',
      actorId: breakdown.playerId,
      actorAi: Boolean(breakdown.debug?.decision),
      summary: `${breakdown.playerName} reveals orders: ${breakdown.capitalTroops} capital troop${breakdown.capitalTroops === 1 ? '' : 's'} for ${breakdown.candidateName}, ${breakdown.frontierTroops} frontier troop${breakdown.frontierTroops === 1 ? '' : 's'} for the empire.`,
      details: {
        candidateId: breakdown.candidateId,
        candidateName: breakdown.candidateName,
        capitalTroops: breakdown.capitalTroops,
        frontierTroops: breakdown.frontierTroops,
        offices: breakdown.offices,
        mercenaryArmy: breakdown.mercenaryArmy,
        mercenaryDeployment: breakdown.mercenaryDeployment,
      },
      decision: breakdown.debug?.decision || null,
    });
  }

  // 2. COUP
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
      contributions: coupResult.contributions.map(entry => ({
        ...entry,
        playerName: playerName(state, entry.playerId),
        candidateName: playerName(state, entry.candidateId),
      })),
    },
  });

  // 3. WAR
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
    state.lastWarResult = warResult;

    state.log.push({
      type: 'war',
      invader: invasion.name,
      strength: rolled,
      frontier: totalFrontier,
      outcome: warResult.outcome,
      themesLost: warResult.themesLost,
      themesRecovered: warResult.themesRecovered,
      round: state.round
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

// ─── Phase: Cleanup ───
export function phaseCleanup(state) {
  state.phase = 'cleanup';

  // 1. Pay professional army maintenance
  for (const player of state.players) {
    payMaintenance(state, player.id);
  }

  // Professional troops suspended this round (spent on appointments or
  // revocations) rejoin their offices now that maintenance is paid.
  restoreSuspendedProfessionals(state);

  // 2. Levies and mercenaries expire at the end of every round.
  state.currentLevies = {};
  disbandMercenaries(state);

  // 3. New Basileus takes office (if coup succeeded)
  if (state.nextBasileusId !== state.basileusId) {
    const oldBasileus = state.basileusId;
    state.basileusId = state.nextBasileusId;
    // New basileus must reassign all major titles — UI will handle this
    state.pendingTitleReassignment = true;
    state.log.push({ type: 'new_basileus', old: oldBasileus, new: state.basileusId, round: state.round });
    recordHistoryEvent(state, {
      category: 'system',
      type: 'new_basileus',
      summary: `${playerName(state, state.basileusId)} takes the throne from ${playerName(state, oldBasileus)}.`,
      details: {
        oldBasileusId: oldBasileus,
        oldBasileusName: playerName(state, oldBasileus),
        newBasileusId: state.basileusId,
        newBasileusName: playerName(state, state.basileusId),
      },
    });
  } else {
    state.pendingTitleReassignment = false;
  }

  // 4. Check end of game
  if (state.gameOver) return; // Constantinople fell during war
  if (state.invasionDeck.length === 0 && state.round >= state.maxRounds) {
    state.phase = 'scoring';
    return;
  }

  // 5. Clear orders
  state.allOrders = {};
  state.mercenariesHiredThisRound = {};
  state.turnCounters = { revocation: { self: 0, others: 0 } };
  for (const player of state.players) {
    player.turnCounters = { appointments: {} };
  }
  state.currentInvasion = null;
  state.lastCoupResult = null;
  state.lastWarResult = null;
}

// ─── Helper: who holds an office ───
function getOfficeHolder(state, officeKey) {
  if (officeKey === 'BASILEUS') return state.basileusId;
  if (officeKey === 'DOM_EAST' || officeKey === 'DOM_WEST' || officeKey === 'ADMIRAL' || officeKey === 'PATRIARCH') {
    for (const p of state.players) {
      if (p.majorTitles.includes(officeKey)) return p.id;
    }
    return null;
  }
  if (officeKey === 'EMPRESS') return state.empress ?? null;
  if (officeKey === 'CHIEF_EUNUCHS') return state.chiefEunuchs ?? null;
  // Strategos: STRAT_<themeId>
  if (officeKey.startsWith('STRAT_')) {
    const themeId = officeKey.replace('STRAT_', '');
    return state.themes[themeId]?.strategos ?? null;
  }
  return null;
}

// Capital-locked offices: troops from these offices may only be deployed in the capital.
const CAPITAL_LOCKED_OFFICES = new Set(['EMPRESS', 'PATRIARCH', 'CHIEF_EUNUCHS']);

export function isCapitalLockedOffice(officeKey) {
  return CAPITAL_LOCKED_OFFICES.has(officeKey);
}

// ─── Auto-advance through non-interactive phases ───
export function advanceToNextInteractivePhase(state) {
  // From current phase, auto-resolve everything until we hit court or orders
  while (true) {
    if (state.gameOver || state.phase === 'scoring') return;

    if (state.phase === 'setup' || state.phase === 'cleanup') {
      phaseInvasion(state);
      continue;
    }

    if (state.phase === 'invasion') {
      if (state.phase === 'scoring') return;
      phaseAdministration(state);
      continue;
    }

    if (state.phase === 'administration') {
      phaseCourt(state);
      return; // Court requires input
    }

    if (state.phase === 'court') {
      return; // Waiting for player input
    }

    if (state.phase === 'orders') {
      return; // Waiting for player input
    }

    if (state.phase === 'resolution') {
      phaseCleanup(state);
      continue;
    }

    break;
  }
}
