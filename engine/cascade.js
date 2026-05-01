import { REGIONS } from '../data/provinces.js';
import {
  getNormalOwnerIncome,
  getNormalTaxIncome,
  getTaxExemptOwnerIncome,
} from './rules.js';
import { findTitleHolder } from './state.js';

function getRegionalDomesticKey(region) {
  if (region === REGIONS.EAST) return 'DOM_EAST';
  if (region === REGIONS.WEST) return 'DOM_WEST';
  if (region === REGIONS.SEA) return 'ADMIRAL';
  return null;
}

export function computeRegionalTaxCascade(state, region, initialPool = 0) {
  let pool = Math.max(0, Number(initialPool) || 0);
  const domesticKey = getRegionalDomesticKey(region);
  const domesticId = findTitleHolder(state, domesticKey);
  const income = {};
  let churchPool = 0;

  const addIncome = (playerId, amount) => {
    if (playerId == null || amount <= 0) return;
    income[playerId] = (income[playerId] || 0) + amount;
  };

  while (pool > 0) {
    addIncome(state.basileusId, 1);
    pool--;
    if (pool <= 0) break;

    if (domesticId != null) {
      addIncome(domesticId, 1);
      pool--;
    }
    if (pool <= 0) break;

    churchPool++;
    pool--;
  }

  return { income, churchPool };
}

export function computeRegionalLevyCascade(state, region, initialPool = 0) {
  let pool = Math.max(0, Number(initialPool) || 0);
  const domesticKey = getRegionalDomesticKey(region);
  const domesticId = findTitleHolder(state, domesticKey);
  const levies = {};

  const addLevy = (officeKey, amount) => {
    if (!officeKey || amount <= 0) return;
    levies[officeKey] = (levies[officeKey] || 0) + amount;
  };

  while (pool > 0) {
    addLevy('BASILEUS', 1);
    pool--;
    if (pool <= 0) break;

    if (domesticId != null) {
      addLevy(domesticKey, 1);
      pool--;
    }
  }

  return levies;
}

export function computeCPLCascade(state, basileusRegionalGold) {
  let pool = Math.max(0, Number(basileusRegionalGold) || 0);
  const income = {};
  const addIncome = (playerId, amount) => {
    if (playerId == null || amount <= 0) return;
    income[playerId] = (income[playerId] || 0) + amount;
  };

  while (pool > 0) {
    addIncome(state.basileusId, 1);
    pool--;
    if (pool <= 0) break;

    if (state.empress !== null) {
      addIncome(state.empress, 1);
      pool--;
    }
    if (pool <= 0) break;

    if (state.chiefEunuchs !== null) {
      addIncome(state.chiefEunuchs, 1);
      pool--;
    }
  }

  return income;
}

export function computeChurchCascade(state, regionalChurchPool) {
  let pool = Math.max(0, Number(regionalChurchPool) || 0);
  const patriarchId = findTitleHolder(state, 'PATRIARCH');
  const bishops = Object.values(state.themes).filter((theme) => theme.bishop !== null && !theme.occupied);
  const income = {};

  const addIncome = (playerId, amount) => {
    if (playerId == null || amount <= 0) return;
    income[playerId] = (income[playerId] || 0) + amount;
  };

  while (pool > 0) {
    for (let index = 0; index < 2 && pool > 0; index += 1) {
      if (patriarchId !== null) addIncome(patriarchId, 1);
      pool--;
    }

    for (const bishop of bishops) {
      if (pool <= 0) break;
      addIncome(bishop.bishop, 1);
      pool--;
    }
  }

  return income;
}

export function runAdministration(state) {
  const regions = [REGIONS.EAST, REGIONS.WEST, REGIONS.SEA];
  const regionalTaxPools = {
    [REGIONS.EAST]: 0,
    [REGIONS.WEST]: 0,
    [REGIONS.SEA]: 0,
  };
  const regionalLevyPools = {
    [REGIONS.EAST]: 0,
    [REGIONS.WEST]: 0,
    [REGIONS.SEA]: 0,
  };
  let churchPool = 0;
  let basileusRegionalGold = 0;
  const income = {};
  const levies = {};

  const addIncome = (playerId, amount) => {
    if (playerId == null || amount <= 0) return;
    income[playerId] = (income[playerId] || 0) + amount;
  };

  const addLevy = (officeKey, amount) => {
    if (!officeKey || amount <= 0) return;
    levies[officeKey] = (levies[officeKey] || 0) + amount;
  };

  for (const theme of Object.values(state.themes)) {
    if (theme.id === 'CPL' || theme.occupied) continue;

    if (theme.owner === 'church') {
      churchPool += theme.G;
      continue;
    }

    const ownerGold = theme.taxExempt
      ? getTaxExemptOwnerIncome(theme)
      : getNormalOwnerIncome(theme);
    const taxGold = theme.taxExempt
      ? 0
      : getNormalTaxIncome(theme);

    if (theme.owner !== null) {
      addIncome(theme.owner, ownerGold);
    }

    if (theme.strategos !== null) {
      addIncome(theme.strategos, taxGold);
      addLevy(`STRAT_${theme.id}`, theme.L);
      continue;
    }

    regionalTaxPools[theme.region] += taxGold;
    regionalLevyPools[theme.region] += theme.L;
  }

  for (const region of regions) {
    const taxResult = computeRegionalTaxCascade(state, region, regionalTaxPools[region]);
    churchPool += taxResult.churchPool;
    basileusRegionalGold += taxResult.income[state.basileusId] || 0;

    for (const [playerId, amount] of Object.entries(taxResult.income)) {
      if (Number(playerId) === state.basileusId) continue;
      addIncome(Number(playerId), amount);
    }

    const levyResult = computeRegionalLevyCascade(state, region, regionalLevyPools[region]);
    for (const [officeKey, amount] of Object.entries(levyResult)) {
      addLevy(officeKey, amount);
    }
  }

  const cplIncome = computeCPLCascade(state, basileusRegionalGold);
  for (const [playerId, amount] of Object.entries(cplIncome)) {
    addIncome(Number(playerId), amount);
  }

  const churchIncome = computeChurchCascade(state, churchPool);
  for (const [playerId, amount] of Object.entries(churchIncome)) {
    addIncome(Number(playerId), amount);
  }

  return { income, levies };
}
