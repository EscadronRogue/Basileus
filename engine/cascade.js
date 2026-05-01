import { REGIONS } from '../data/provinces.js';
import {
  getNormalOwnerIncome,
  getNormalTaxIncome,
  getTaxExemptOwnerIncome,
} from './rules.js';
import { findTitleHolder } from './state.js';

// Each holder of a capital court title (Empress, Patriarch, Chief of Eunuchs)
// receives this many capital-locked levies every administration phase.
export const CAPITAL_LOCKED_TITLE_LEVIES = 2;
export const CAPITAL_LOCKED_TITLE_OFFICES = ['EMPRESS', 'PATRIARCH', 'CHIEF_EUNUCHS'];

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

  // Distribution per cycle: first 2 go to the regional domesticus/admiral, 3rd goes to the Basileus.
  // If the regional office is vacant, those slots fall through to the Basileus.
  while (pool > 0) {
    for (let slot = 0; slot < 2 && pool > 0; slot += 1) {
      if (domesticId != null) {
        addLevy(domesticKey, 1);
      } else {
        addLevy('BASILEUS', 1);
      }
      pool--;
    }
    if (pool <= 0) break;

    addLevy('BASILEUS', 1);
    pool--;
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

  // Capital-locked levies from court titles. Each title grants 2 levies that may only
  // be deployed in the capital. The levies are tied to the office (resolved via the
  // current title holder at resolution), so revoking the title mid-turn instantly moves
  // the levies to the new holder rather than leaving them with the previous one.
  if (state.empress != null) {
    addLevy('EMPRESS', CAPITAL_LOCKED_TITLE_LEVIES);
  }
  if (state.chiefEunuchs != null) {
    addLevy('CHIEF_EUNUCHS', CAPITAL_LOCKED_TITLE_LEVIES);
  }
  if (findTitleHolder(state, 'PATRIARCH') != null) {
    addLevy('PATRIARCH', CAPITAL_LOCKED_TITLE_LEVIES);
  }

  return { income, levies };
}
