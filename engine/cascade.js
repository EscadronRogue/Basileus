import { REGIONS } from '../data/provinces.js';
import { getThemeChurchValue, getThemeOwnerIncome, getThemeTroopCount } from './rules.js';
import { findTitleHolder } from './state.js';

const ECONOMIC_REGIONS = [REGIONS.EAST, REGIONS.WEST, REGIONS.SEA];

function getRegionalCommandKey(region) {
  if (region === REGIONS.EAST) return 'DOM_EAST';
  if (region === REGIONS.WEST) return 'DOM_WEST';
  if (region === REGIONS.SEA) return 'ADMIRAL';
  return null;
}

function emptyTroopEntry() {
  return { normal: 0, capitalLocked: 0 };
}

function addIncome(income, playerId, amount) {
  if (playerId == null || amount <= 0) return;
  income[playerId] = (income[playerId] || 0) + amount;
}

function addTroops(troops, officeKey, amount, options = {}) {
  const count = Math.max(0, Number(amount) || 0);
  if (!officeKey || count <= 0) return;
  const entry = troops[officeKey] || emptyTroopEntry();
  if (options.capitalLocked) entry.capitalLocked += count;
  else entry.normal += count;
  troops[officeKey] = entry;
}

function convertBasileusCourtTitleTroop(troops) {
  const entry = troops.BASILEUS || emptyTroopEntry();
  entry.normal = Math.max(0, (Number(entry.normal) || 0) - 1);
  entry.capitalLocked = (Number(entry.capitalLocked) || 0) + 1;
  troops.BASILEUS = entry;
}

export function readTroopEntry(entry) {
  if (typeof entry === 'number') {
    return { normal: Math.max(0, Number(entry) || 0), capitalLocked: 0 };
  }
  return {
    normal: Math.max(0, Number(entry?.normal) || 0),
    capitalLocked: Math.max(0, Number(entry?.capitalLocked) || 0),
  };
}

export function getTroopEntryTotal(entry) {
  const value = readTroopEntry(entry);
  return value.normal + value.capitalLocked;
}

export function computeRegionalTroopCascade(state, region, initialPool = 0) {
  let pool = Math.max(0, Number(initialPool) || 0);
  const domesticKey = getRegionalCommandKey(region);
  const domesticId = domesticKey ? findTitleHolder(state, domesticKey) : null;
  const troops = {};

  while (pool > 0) {
    for (let slot = 0; slot < 2 && pool > 0; slot += 1) {
      addTroops(troops, domesticId != null ? domesticKey : 'BASILEUS', 1);
      pool -= 1;
    }
    if (pool <= 0) break;
    addTroops(troops, 'BASILEUS', 1);
    pool -= 1;
  }

  return troops;
}

export function computeChurchCascade(state, churchPool = 0) {
  const income = {};
  const patriarchId = findTitleHolder(state, 'PATRIARCH');
  if (patriarchId != null) addIncome(income, patriarchId, Math.max(0, Number(churchPool) || 0));
  return income;
}

export function runIncome(state) {
  const regionalTroopPools = Object.fromEntries(ECONOMIC_REGIONS.map((region) => [region, 0]));
  let churchPool = 0;
  const income = {};
  const incomeBreakdown = {
    estate: {},
    church: {},
  };
  const troops = {};

  const addCategorizedIncome = (category, playerId, amount) => {
    const count = Math.max(0, Number(amount) || 0);
    if (playerId == null || count <= 0) return;
    addIncome(income, playerId, count);
    incomeBreakdown[category][playerId] = (incomeBreakdown[category][playerId] || 0) + count;
  };

  const routeChurchValue = (theme, amount) => {
    const value = Math.max(0, Number(amount) || 0);
    if (value <= 0) return;
    if (theme.bishop != null) addCategorizedIncome('church', theme.bishop, value);
    else churchPool += value;
  };

  for (const theme of Object.values(state.themes || {})) {
    if (!theme || theme.id === 'CPL') continue;

    if (theme.occupied) {
      if (theme.bishop != null) {
        addCategorizedIncome('church', theme.bishop, Math.max(0, Number(theme.origin?.C) || 0));
      }
      continue;
    }

    if (theme.owner === 'church') {
      routeChurchValue(theme, getThemeChurchValue(theme));
      continue;
    }

    if (theme.owner != null) {
      addCategorizedIncome('estate', theme.owner, getThemeOwnerIncome(theme));
    }

    if (theme.strategos != null) {
      addTroops(troops, `STRAT_${theme.id}`, getThemeTroopCount(theme));
    } else if (Object.prototype.hasOwnProperty.call(regionalTroopPools, theme.region)) {
      regionalTroopPools[theme.region] += getThemeTroopCount(theme);
    }

    routeChurchValue(theme, getThemeChurchValue(theme));
  }

  for (const region of ECONOMIC_REGIONS) {
    const result = computeRegionalTroopCascade(state, region, regionalTroopPools[region]);
    for (const [officeKey, entry] of Object.entries(result)) {
      const value = readTroopEntry(entry);
      addTroops(troops, officeKey, value.normal);
      addTroops(troops, officeKey, value.capitalLocked, { capitalLocked: true });
    }
  }

  for (const [playerId, amount] of Object.entries(computeChurchCascade(state, churchPool))) {
    addCategorizedIncome('church', Number(playerId), amount);
  }

  if (state.empress != null) convertBasileusCourtTitleTroop(troops);
  if (state.chiefEunuchs != null) convertBasileusCourtTitleTroop(troops);

  return { income, incomeBreakdown, troops };
}
