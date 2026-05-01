// engine/cascade.js — Administration phase: tax, levy, church, and CPL cascade computation
import { REGIONS } from '../data/provinces.js';
import { findTitleHolder, getThemesInRegion } from './state.js';

// ─── Tax Cascade (per region) ───
// Pool = sum of (G−1) for each non-occupied, non-church, non-tax-exempt theme in the region
// Cycle: Basileus 1 → Domestic/Admiral 1 → each Strategos 1 → Church 1 → repeat
function computeRegionalTaxPool(state, region) {
  const themes = getThemesInRegion(state, region);
  let pool = 0;
  for (const t of themes) {
    if (t.occupied) continue;
    if (t.owner === 'church') continue;
    if (t.taxExempt) continue;
    pool += Math.max(0, t.G - 1);
  }
  return pool;
}

function getRegionalDomesticKey(region) {
  if (region === REGIONS.EAST) return 'DOM_EAST';
  if (region === REGIONS.WEST) return 'DOM_WEST';
  if (region === REGIONS.SEA) return 'ADMIRAL';
  return null;
}

function getStrategosInRegion(state, region) {
  // Returns list of { playerId, themeId } for each strategos in this region
  const themes = getThemesInRegion(state, region);
  const result = [];
  for (const t of themes) {
    if (!t.occupied && t.strategos !== null) {
      result.push({ playerId: t.strategos, themeId: t.id });
    }
  }
  return result;
}

export function computeRegionalTaxCascade(state, region) {
  let pool = computeRegionalTaxPool(state, region);
  const domesticKey = getRegionalDomesticKey(region);

  // Recipients
  const basileusId = state.basileusId;
  const domesticId = findTitleHolder(state, domesticKey);
  const strategoi = getStrategosInRegion(state, region);

  const income = {}; // playerId → gold
  let churchPool = 0;
  const addIncome = (pid, amt) => { income[pid] = (income[pid] || 0) + amt; };

  while (pool > 0) {
    // Basileus 1
    if (pool > 0) { addIncome(basileusId, 1); pool--; }
    // Domestic/Admiral 1
    if (pool > 0 && domesticId !== null) { addIncome(domesticId, 1); pool--; }
    // Each Strategos 1
    for (const s of strategoi) {
      if (pool > 0) { addIncome(s.playerId, 1); pool--; }
    }
    // Church 1
    if (pool > 0) { churchPool++; pool--; }
  }

  return { income, churchPool };
}

// ─── Levy Cascade (per region) ───
// Pool = sum L for free-citizen themes + (L-1) for player-owned themes (min 0)
// Church and occupied = 0
// Cycle: Basileus 1 → Domestic/Admiral 1 → each Strategos 1 → repeat (no church)
function computeRegionalLevyPool(state, region) {
  const themes = getThemesInRegion(state, region);
  let pool = 0;
  for (const t of themes) {
    if (t.occupied) continue;
    if (t.owner === 'church') continue;
    if (t.owner === null) {
      pool += t.L;  // free citizens
    } else {
      pool += Math.max(0, t.L - 1);  // player-owned
    }
  }
  return pool;
}

export function computeRegionalLevyCascade(state, region) {
  let pool = computeRegionalLevyPool(state, region);
  const domesticKey = getRegionalDomesticKey(region);

  const basileusId = state.basileusId;
  const domesticId = findTitleHolder(state, domesticKey);
  const strategoi = getStrategosInRegion(state, region);

  // Levies go to offices, tracked as { officeKey: count }
  // officeKey = 'BASILEUS', 'DOM_EAST', etc., or 'STRAT_<themeId>'
  const levies = {};
  const addLevy = (key, amt) => { levies[key] = (levies[key] || 0) + amt; };

  while (pool > 0) {
    if (pool > 0) { addLevy('BASILEUS', 1); pool--; }
    if (pool > 0 && domesticId !== null) {
      addLevy(domesticKey, 1); pool--;
    }
    for (const s of strategoi) {
      if (pool > 0) {
        addLevy(`STRAT_${s.themeId}`, 1); pool--;
      }
    }
  }

  return levies;
}

// ─── Constantinople Cascade ───
// Basileus carries his tax collections from all 3 regions to CPL
// Then distribute: Basileus 1 → Empress 1 → Chief of Eunuchs 1 → repeat
export function computeCPLCascade(state, basileusRegionalGold) {
  let pool = basileusRegionalGold;  // gold the Basileus collected from 3 regional cascades
  const income = {};
  const addIncome = (pid, amt) => {
    if (pid !== null && pid !== undefined) income[pid] = (income[pid] || 0) + amt;
  };

  while (pool > 0) {
    if (pool > 0) { addIncome(state.basileusId, 1); pool--; }
    if (pool > 0 && state.empress !== null) { addIncome(state.empress, 1); pool--; }
    if (pool > 0 && state.chiefEunuchs !== null) { addIncome(state.chiefEunuchs, 1); pool--; }
  }

  return income;
}

// ─── Church Cascade ───
// Pool = church shares from regional cascades + full G of every church-owned theme
// Cycle: Patriarch 2 → each Bishop 1 → repeat
export function computeChurchCascade(state, regionalChurchPool) {
  // Add income from church-owned themes
  let pool = regionalChurchPool;
  for (const t of Object.values(state.themes)) {
    if (t.owner === 'church' && !t.occupied) {
      pool += t.G;
    }
  }

  const patriarchId = findTitleHolder(state, 'PATRIARCH');
  // Collect all bishops
  const bishops = [];
  for (const t of Object.values(state.themes)) {
    if (t.bishop !== null && !t.occupied) {
      bishops.push({ playerId: t.bishop, themeId: t.id });
    }
  }

  const income = {};
  const addIncome = (pid, amt) => {
    if (pid !== null && pid !== undefined) income[pid] = (income[pid] || 0) + amt;
  };

  while (pool > 0) {
    // Patriarch 2
    for (let i = 0; i < 2 && pool > 0; i++) {
      if (patriarchId !== null) { addIncome(patriarchId, 1); pool--; }
      else pool--; // lost if no patriarch
    }
    // Each Bishop 1
    for (const b of bishops) {
      if (pool > 0) { addIncome(b.playerId, 1); pool--; }
    }
  }

  return income;
}

// ─── Private Income ───
// Each player collects 1g per owned non-occupied theme, or full G if tax-exempt
export function computePrivateIncome(state) {
  const income = {};
  for (const t of Object.values(state.themes)) {
    if (t.occupied || t.owner === null || t.owner === 'church') continue;
    const pid = t.owner;
    if (!income[pid]) income[pid] = 0;
    income[pid] += t.taxExempt ? t.G : 1;
  }
  return income;
}

// ─── Full Administration ───
export function runAdministration(state) {
  const regions = [REGIONS.EAST, REGIONS.WEST, REGIONS.SEA];
  let totalChurchPool = 0;
  let basileusRegionalGold = 0;
  const allIncome = {};
  const allLevies = {};

  const mergeIncome = (src) => {
    for (const [pid, amt] of Object.entries(src)) {
      const id = Number(pid);
      allIncome[id] = (allIncome[id] || 0) + amt;
    }
  };

  const mergeLevies = (src) => {
    for (const [key, amt] of Object.entries(src)) {
      allLevies[key] = (allLevies[key] || 0) + amt;
    }
  };

  // 1-2. Regional tax cascades
  for (const region of regions) {
    const taxResult = computeRegionalTaxCascade(state, region);
    totalChurchPool += taxResult.churchPool;

    // Track how much the Basileus got from regional cascades (for CPL redistribution)
    const basGold = taxResult.income[state.basileusId] || 0;
    basileusRegionalGold += basGold;

    // Non-basileus income goes directly to players
    for (const [pid, amt] of Object.entries(taxResult.income)) {
      if (Number(pid) !== state.basileusId) {
        mergeIncome({ [pid]: amt });
      }
    }

    // Levy cascade
    const levyResult = computeRegionalLevyCascade(state, region);
    mergeLevies(levyResult);
  }

  // 3. CPL cascade — Basileus redistributes his regional gold
  const cplIncome = computeCPLCascade(state, basileusRegionalGold);
  mergeIncome(cplIncome);

  // 4. Church cascade
  const churchIncome = computeChurchCascade(state, totalChurchPool);
  mergeIncome(churchIncome);

  // 5. Private income
  const privateIncome = computePrivateIncome(state);
  mergeIncome(privateIncome);

  return { income: allIncome, levies: allLevies };
}
