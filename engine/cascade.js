import { REGIONS } from '../data/provinces.js';
import {
  getThemeChurchValue,
  getThemeTaxIncome,
  getThemeOwnerIncome,
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

// The church no longer takes from the regional tax pool. The Basileus and the
// regional domestic/admiral alternate (Basileus first); if the regional title is
// vacant, the Basileus collects every coin. The church is paid out of its own
// pool (sourced from province C values and church-owned land — see runAdministration).
export function computeRegionalTaxCascade(state, region, initialPool = 0) {
  let pool = Math.max(0, Number(initialPool) || 0);
  const domesticKey = getRegionalDomesticKey(region);
  const domesticId = findTitleHolder(state, domesticKey);
  const income = {};

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
  }

  return { income, churchPool: 0 };
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

// Distribute the church pool: the Patriarch takes 2 shares first, then each bishop
// (by appointment seniority) takes 1 share. If gold remains, the cycle restarts.
// A bishop whose province is occupied or lost keeps receiving their share — they
// stay appointed even though the province no longer contributes to the pool.
export function computeChurchCascade(state, regionalChurchPool) {
  let pool = Math.max(0, Number(regionalChurchPool) || 0);
  const patriarchId = findTitleHolder(state, 'PATRIARCH');
  const bishopOrder = Array.isArray(state.bishopAppointments) ? state.bishopAppointments : [];
  const seenBishopThemes = new Set(bishopOrder.map((entry) => entry.themeId));
  const fallbackBishops = Object.values(state.themes || {})
    .filter((theme) => theme?.bishop != null && !seenBishopThemes.has(theme.id))
    .map((theme) => ({ themeId: theme.id, playerId: theme.bishop }));
  // Filter to currently active bishops (the theme.bishop still matches the appointee).
  // Fallback entries keep older saves/tests with pre-registry bishops paying in
  // stable province order after registered senior bishops.
  const activeBishops = [...bishopOrder, ...fallbackBishops]
    .filter((entry) => state.themes?.[entry.themeId]?.bishop === entry.playerId);
  const income = {};

  const addIncome = (playerId, amount) => {
    if (playerId == null || amount <= 0) return;
    income[playerId] = (income[playerId] || 0) + amount;
  };

  while (pool > 0) {
    // Patriarch: two shares, in sequence.
    for (let index = 0; index < 2 && pool > 0; index += 1) {
      if (patriarchId != null) addIncome(patriarchId, 1);
      pool--;
    }
    // Bishops in seniority order: one share each.
    for (const bishop of activeBishops) {
      if (pool <= 0) break;
      addIncome(bishop.playerId, 1);
      pool--;
    }
    // If neither patriarch nor bishops exist, the pool is forfeited to avoid
    // an infinite loop.
    if (patriarchId == null && activeBishops.length === 0) break;
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
  const incomeBreakdown = {
    estate: {},
    tax: {},
    church: {},
  };
  const levies = {};

  const addIncome = (playerId, amount) => {
    if (playerId == null || amount <= 0) return;
    income[playerId] = (income[playerId] || 0) + amount;
  };
  const addCategorizedIncome = (category, playerId, amount) => {
    if (playerId == null || amount <= 0) return;
    addIncome(playerId, amount);
    incomeBreakdown[category][playerId] = (incomeBreakdown[category][playerId] || 0) + amount;
  };

  const addLevy = (officeKey, amount) => {
    if (!officeKey || amount <= 0) return;
    levies[officeKey] = (levies[officeKey] || 0) + amount;
  };

  for (const theme of Object.values(state.themes)) {
    if (theme.id === 'CPL' || theme.occupied) continue;

    const taxGold = getThemeTaxIncome(theme);
    const levyCount = Math.max(0, Number(theme.L) || 0);
    const churchValue = getThemeChurchValue(theme);

    // The province's church value adds to the church pool every round, regardless
    // of who owns it (as long as the province is not occupied).
    churchPool += churchValue;

    if (theme.owner === 'church') {
      // Church-owned land has zero profit/tax (set when gifted) but still raises
      // levies for the regional pool. Its C already contributed above.
      regionalLevyPools[theme.region] += levyCount;
      continue;
    }

    if (theme.owner !== null) {
      addCategorizedIncome('estate', theme.owner, getThemeOwnerIncome(theme));
    }

    if (theme.strategos !== null) {
      addCategorizedIncome('tax', theme.strategos, taxGold);
      addLevy(`STRAT_${theme.id}`, levyCount);
      continue;
    }

    regionalTaxPools[theme.region] += taxGold;
    regionalLevyPools[theme.region] += levyCount;
  }

  for (const region of regions) {
    const taxResult = computeRegionalTaxCascade(state, region, regionalTaxPools[region]);
    basileusRegionalGold += taxResult.income[state.basileusId] || 0;

    for (const [playerId, amount] of Object.entries(taxResult.income)) {
      if (Number(playerId) === state.basileusId) continue;
      addCategorizedIncome('tax', Number(playerId), amount);
    }

    const levyResult = computeRegionalLevyCascade(state, region, regionalLevyPools[region]);
    for (const [officeKey, amount] of Object.entries(levyResult)) {
      addLevy(officeKey, amount);
    }
  }

  const cplIncome = computeCPLCascade(state, basileusRegionalGold);
  for (const [playerId, amount] of Object.entries(cplIncome)) {
    addCategorizedIncome('tax', Number(playerId), amount);
  }

  const churchIncome = computeChurchCascade(state, churchPool);
  for (const [playerId, amount] of Object.entries(churchIncome)) {
    addCategorizedIncome('church', Number(playerId), amount);
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

  return { income, incomeBreakdown, levies };
}
