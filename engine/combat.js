// engine/combat.js - the war against the invasion, and what it does to provinces.
//
// The invasion walks its route and pays, out of its lead over the frontier,
// PROVINCE_WAR_COST for each imperial province it takes and
// LOST_PROVINCE_CROSSING_COST for each province already lost that it crosses;
// Constantinople, at the end of a full route, costs PROVINCE_WAR_COST plus
// the Theodosian Walls. It stops at the first step it cannot pay for. When
// the frontier wins instead, its lead retakes lost provinces on the route,
// walking back from Constantinople, at PROVINCE_WAR_COST each.
import { getBalance } from '../data/balance.js';

function warCosts(state) {
  const balance = getBalance(state);
  return {
    province: Math.max(0, Number(balance.PROVINCE_WAR_COST) || 0),
    crossing: Math.max(0, Number(balance.LOST_PROVINCE_CROSSING_COST) || 0),
    walls: Math.max(0, Number(balance.THEODOSIAN_WALLS) || 0),
  };
}

function currentLostIds(state) {
  return new Set(
    Object.values(state?.themes || {})
      .filter((theme) => theme.lost)
      .map((theme) => theme.id),
  );
}

// [{ themeId, status: 'imperial' | 'lost' | 'capital', cost, needed, walls }].
// `cost` is what the invader pays for that step, `needed` how far it must
// beat the frontier to get that far; Constantinople's cost includes its
// `walls`.
export function buildInvasionLadder(state, route = state?.currentInvasion?.route || [], lostIds = currentLostIds(state)) {
  const costs = warCosts(state);
  const steps = [];
  let needed = 0;
  for (const themeId of route || []) {
    if (!state?.themes?.[themeId]) continue;
    if (themeId === 'CPL') {
      const cost = costs.province + costs.walls;
      needed += cost;
      steps.push({ themeId, status: 'capital', cost, needed, walls: costs.walls });
      break;
    }
    const status = lostIds.has(themeId) ? 'lost' : 'imperial';
    const cost = status === 'lost' ? costs.crossing : costs.province;
    needed += cost;
    steps.push({ themeId, status, cost, needed });
  }
  return steps;
}

// [{ themeId, status: 'lost' | 'imperial', cost, needed }], walking back from
// Constantinople. `needed` is how far the frontier must beat the invader to
// retake that lost province.
export function buildReconquestLadder(state, route = state?.currentInvasion?.route || [], lostIds = currentLostIds(state)) {
  const costs = warCosts(state);
  const steps = [];
  let needed = 0;
  for (const themeId of (route || []).slice().reverse()) {
    if (themeId === 'CPL' || !state?.themes?.[themeId]) continue;
    if (!lostIds.has(themeId)) {
      steps.push({ themeId, status: 'imperial', cost: 0, needed });
      continue;
    }
    needed += costs.province;
    steps.push({ themeId, status: 'lost', cost: costs.province, needed });
  }
  return steps;
}

// The troops the frontier needs against an invasion of `strength`: to hold
// every province, and to keep Constantinople (null when the route does not
// reach it).
export function getFrontierThresholds(state, strength, route = state?.currentInvasion?.route || []) {
  const value = Math.max(0, Number(strength) || 0);
  const capital = buildInvasionLadder(state, route).find((step) => step.status === 'capital');
  return {
    holdAll: value,
    saveCapital: capital ? Math.max(0, value - capital.needed + 1) : null,
  };
}

export function resolveInvasion(state, frontierTroops, invaderStrength, invasion) {
  const F = frontierTroops;
  const S = invaderStrength;
  const route = invasion.route;
  const lostIds = currentLostIds(state);
  const result = {
    outcome: F > S ? 'victory' : F < S ? 'defeat' : 'stalemate',
    frontierTroops: F,
    invaderStrength: S,
    margin: Math.abs(F - S),
    themesLost: [],
    themesRecovered: [],
    reconquestRewardProvinceCount: 0,
    reachedCPL: false,
    advancePath: [],
    // Every step of the ladder that was fought over, with the strength spent
    // on it, and the strength left once the next step was out of reach.
    steps: [],
    spent: 0,
    leftover: 0,
  };

  if (F === S) return result;

  if (F < S) {
    const margin = S - F;
    for (const step of buildInvasionLadder(state, route, lostIds)) {
      if (step.needed > margin) {
        result.steps.push({ ...step, outcome: 'held', spent: 0 });
        break;
      }
      if (step.status === 'lost') {
        result.steps.push({ ...step, outcome: 'crossed', spent: step.cost });
        result.spent += step.cost;
        result.advancePath.push(step.themeId);
        continue;
      }
      result.steps.push({ ...step, outcome: 'taken', spent: step.cost });
      result.spent += step.cost;
      result.advancePath.push(step.themeId);
      if (step.status === 'capital') result.reachedCPL = true;
      else result.themesLost.push(step.themeId);
    }
    result.leftover = margin - result.spent;
    return result;
  }

  const surplus = F - S;
  result.reconquestRewardProvinceCount = countAffordableProvinceWins(state, surplus, route);
  for (const step of buildReconquestLadder(state, route, lostIds)) {
    if (step.status === 'imperial') continue;
    if (step.needed > surplus) {
      result.steps.push({ ...step, outcome: 'out_of_reach', spent: 0 });
      break;
    }
    result.steps.push({ ...step, outcome: 'retaken', spent: step.cost });
    result.spent += step.cost;
    result.advancePath.push(step.themeId);
    result.themesRecovered.push(step.themeId);
  }
  result.leftover = surplus - result.spent;
  return result;
}

// How many provinces of the route the surplus could pay for at
// PROVINCE_WAR_COST each, whether or not they are lost: the best defender's
// reward.
function countAffordableProvinceWins(state, surplus, route) {
  const cost = warCosts(state).province;
  const provinces = (route || []).filter((themeId) => themeId !== 'CPL' && state.themes[themeId]).length;
  if (cost <= 0) return provinces;
  return Math.min(provinces, Math.floor(Math.max(0, surplus) / cost));
}

// A lost province keeps its estates, Strategos and Bishop on record, as if
// the administration in Constantinople still held the deeds. Estates and the
// Strategos stop working until the province is reconquered, when they return
// to their holders; the Bishop keeps being paid throughout.
export function applyInvasionResult(state, result) {
  for (const themeId of result.themesLost) {
    const theme = state.themes[themeId];
    if (theme) theme.lost = true;
  }

  for (const themeId of result.themesRecovered) {
    const theme = state.themes[themeId];
    if (theme) theme.lost = false;
  }

  if (result.reachedCPL) {
    state.gameOver = { type: 'fall', message: 'Constantinople has fallen. The empire is no more. No dynasty wins.' };
  }
}
