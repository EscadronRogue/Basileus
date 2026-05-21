import { REGIONS } from '../data/provinces.js';
import { getThemeChurchValue, getThemeOwnerIncome, getThemeTroopCount } from './rules.js';
import { findTitleHolder, getOfficeHolder } from './state.js';

const ECONOMIC_REGIONS = [REGIONS.EAST, REGIONS.WEST, REGIONS.SEA];

const FLOW_RESOURCE_LABELS = {
  profit: 'Profit',
  troop: 'Troops',
  church: 'Church',
};

const FLOW_REGION_ROUTES = {
  [REGIONS.EAST]: 'east_pool',
  [REGIONS.WEST]: 'west_pool',
  [REGIONS.SEA]: 'sea_pool',
};

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

function createFlowRoute(key, resource, label, options = {}) {
  return {
    key,
    resource,
    label,
    rule: options.rule || '',
    total: 0,
    recipients: {},
    offices: {},
    sources: [],
  };
}

function createIncomeFlowDraft() {
  return {
    totals: {
      profit: 0,
      troop: 0,
      church: 0,
    },
    routes: {
      profit: {
        estates: createFlowRoute('estates', 'profit', 'Private Estates', {
          rule: 'Province profit to owners',
        }),
      },
      troop: {
        strategoi: createFlowRoute('strategoi', 'troop', 'Strategoi', {
          rule: 'Assigned themes go direct',
        }),
        east_pool: createFlowRoute('east_pool', 'troop', 'East Pool', {
          rule: '2 Domestic / 1 Basileus',
        }),
        west_pool: createFlowRoute('west_pool', 'troop', 'West Pool', {
          rule: '2 Domestic / 1 Basileus',
        }),
        sea_pool: createFlowRoute('sea_pool', 'troop', 'Sea Pool', {
          rule: '2 Admiral / 1 Basileus',
        }),
      },
      church: {
        bishops: createFlowRoute('bishops', 'church', 'Bishops', {
          rule: 'Assigned sees go direct',
        }),
        patriarch: createFlowRoute('patriarch', 'church', 'Patriarch Pool', {
          rule: 'Unassigned sees to Patriarch',
        }),
      },
    },
    playerTotals: {},
  };
}

function ensurePlayerFlowTotal(flow, playerId) {
  if (playerId == null) return null;
  const key = String(playerId);
  if (!flow.playerTotals[key]) {
    flow.playerTotals[key] = {
      playerId: Number(playerId),
      profit: 0,
      troop: 0,
      church: 0,
    };
  }
  return flow.playerTotals[key];
}

function addFlowSource(flow, route, amount, source = {}) {
  const count = Math.max(0, Number(amount) || 0);
  if (!route || count <= 0) return;
  route.total += count;
  flow.totals[route.resource] = (flow.totals[route.resource] || 0) + count;
  if (source.themeId) {
    route.sources.push({
      themeId: source.themeId,
      value: count,
    });
  }
}

function addFlowRecipient(flow, route, playerId, amount) {
  const count = Math.max(0, Number(amount) || 0);
  if (!route || playerId == null || count <= 0) return;
  const key = String(playerId);
  route.recipients[key] = (route.recipients[key] || 0) + count;
  const playerTotal = ensurePlayerFlowTotal(flow, playerId);
  if (playerTotal) playerTotal[route.resource] += count;
}

function addFlowOffice(route, officeKey, playerId, amount, options = {}) {
  const count = Math.max(0, Number(amount) || 0);
  if (!route || !officeKey || count <= 0) return;
  const entry = route.offices[officeKey] || {
    officeKey,
    playerId,
    value: 0,
    normal: 0,
    capitalLocked: 0,
  };
  entry.playerId = playerId;
  entry.value += count;
  entry.normal += Math.max(0, Number(options.normal) || 0);
  entry.capitalLocked += Math.max(0, Number(options.capitalLocked) || 0);
  route.offices[officeKey] = entry;
}

function normalizeRecipients(recipients) {
  return Object.entries(recipients || {})
    .map(([playerId, value]) => ({
      playerId: Number(playerId),
      value: Math.max(0, Number(value) || 0),
    }))
    .filter((entry) => entry.value > 0)
    .sort((left, right) => (right.value - left.value) || (left.playerId - right.playerId));
}

function normalizeOffices(offices) {
  return Object.values(offices || {})
    .map((entry) => ({
      officeKey: entry.officeKey,
      playerId: entry.playerId == null ? null : Number(entry.playerId),
      value: Math.max(0, Number(entry.value) || 0),
      normal: Math.max(0, Number(entry.normal) || 0),
      capitalLocked: Math.max(0, Number(entry.capitalLocked) || 0),
    }))
    .filter((entry) => entry.value > 0)
    .sort((left, right) => (right.value - left.value) || String(left.officeKey).localeCompare(String(right.officeKey)));
}

function normalizeSources(sources) {
  return (sources || [])
    .map((entry) => ({
      themeId: entry.themeId,
      value: Math.max(0, Number(entry.value) || 0),
    }))
    .filter((entry) => entry.themeId && entry.value > 0);
}

function normalizeFlowRoute(route) {
  const recipients = normalizeRecipients(route.recipients);
  const offices = normalizeOffices(route.offices);
  const sources = normalizeSources(route.sources);
  const recipientTotal = recipients.reduce((total, entry) => total + entry.value, 0);
  return {
    key: route.key,
    resource: route.resource,
    label: route.label,
    rule: route.rule,
    total: Math.max(0, Number(route.total) || 0),
    unclaimed: Math.max(0, (Number(route.total) || 0) - recipientTotal),
    recipients,
    offices,
    sources,
    sourceCount: sources.length,
  };
}

function normalizeIncomeFlow(flow, state) {
  const sectionRoutes = {
    profit: [flow.routes.profit.estates],
    troop: [
      flow.routes.troop.strategoi,
      flow.routes.troop.east_pool,
      flow.routes.troop.west_pool,
      flow.routes.troop.sea_pool,
    ],
    church: [
      flow.routes.church.bishops,
      flow.routes.church.patriarch,
    ],
  };

  const sections = Object.entries(sectionRoutes).map(([resource, routes]) => ({
    key: resource,
    label: FLOW_RESOURCE_LABELS[resource] || resource,
    total: Math.max(0, Number(flow.totals[resource]) || 0),
    routes: routes.map(normalizeFlowRoute),
  }));

  const playerTotals = (state.players || []).map((player) => ({
    playerId: player.id,
    profit: Math.max(0, Number(flow.playerTotals[String(player.id)]?.profit) || 0),
    troop: Math.max(0, Number(flow.playerTotals[String(player.id)]?.troop) || 0),
    church: Math.max(0, Number(flow.playerTotals[String(player.id)]?.church) || 0),
  }));

  return {
    totals: { ...flow.totals },
    sections,
    playerTotals,
  };
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
  const flow = createIncomeFlowDraft();
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
    if (theme.bishop != null) {
      const route = flow.routes.church.bishops;
      addFlowSource(flow, route, value, { themeId: theme.id });
      addFlowRecipient(flow, route, theme.bishop, value);
      addFlowOffice(route, `BISHOP_${theme.id}`, theme.bishop, value);
      addCategorizedIncome('church', theme.bishop, value);
    } else {
      addFlowSource(flow, flow.routes.church.patriarch, value, { themeId: theme.id });
      churchPool += value;
    }
  };

  for (const theme of Object.values(state.themes || {})) {
    if (!theme || theme.id === 'CPL') continue;

    if (theme.occupied) {
      if (theme.bishop != null) {
        const occupiedChurchValue = Math.max(0, Number(theme.origin?.C) || 0);
        const route = flow.routes.church.bishops;
        addFlowSource(flow, route, occupiedChurchValue, { themeId: theme.id });
        addFlowRecipient(flow, route, theme.bishop, occupiedChurchValue);
        addFlowOffice(route, `BISHOP_${theme.id}`, theme.bishop, occupiedChurchValue);
        addCategorizedIncome('church', theme.bishop, occupiedChurchValue);
      }
      continue;
    }

    if (theme.owner === 'church') {
      routeChurchValue(theme, getThemeChurchValue(theme));
      continue;
    }

    if (theme.owner != null) {
      const profit = getThemeOwnerIncome(theme);
      const route = flow.routes.profit.estates;
      addFlowSource(flow, route, profit, { themeId: theme.id });
      addFlowRecipient(flow, route, theme.owner, profit);
      addCategorizedIncome('estate', theme.owner, profit);
    }

    if (theme.strategos != null) {
      const troopCount = getThemeTroopCount(theme);
      const officeKey = `STRAT_${theme.id}`;
      const route = flow.routes.troop.strategoi;
      addFlowSource(flow, route, troopCount, { themeId: theme.id });
      addFlowRecipient(flow, route, theme.strategos, troopCount);
      addFlowOffice(route, officeKey, theme.strategos, troopCount, { normal: troopCount });
      addTroops(troops, officeKey, troopCount);
    } else if (Object.prototype.hasOwnProperty.call(regionalTroopPools, theme.region)) {
      const troopCount = getThemeTroopCount(theme);
      const routeKey = FLOW_REGION_ROUTES[theme.region];
      if (routeKey) addFlowSource(flow, flow.routes.troop[routeKey], troopCount, { themeId: theme.id });
      regionalTroopPools[theme.region] += troopCount;
    }

    routeChurchValue(theme, getThemeChurchValue(theme));
  }

  for (const region of ECONOMIC_REGIONS) {
    const result = computeRegionalTroopCascade(state, region, regionalTroopPools[region]);
    const route = flow.routes.troop[FLOW_REGION_ROUTES[region]];
    for (const [officeKey, entry] of Object.entries(result)) {
      const value = readTroopEntry(entry);
      const total = value.normal + value.capitalLocked;
      const holderId = getOfficeHolder(state, officeKey);
      addFlowRecipient(flow, route, holderId, total);
      addFlowOffice(route, officeKey, holderId, total, value);
      addTroops(troops, officeKey, value.normal);
      addTroops(troops, officeKey, value.capitalLocked, { capitalLocked: true });
    }
  }

  for (const [playerId, amount] of Object.entries(computeChurchCascade(state, churchPool))) {
    const holderId = Number(playerId);
    const route = flow.routes.church.patriarch;
    addFlowRecipient(flow, route, holderId, amount);
    addFlowOffice(route, 'PATRIARCH', holderId, amount);
    addCategorizedIncome('church', holderId, amount);
  }

  if (state.empress != null) convertBasileusCourtTitleTroop(troops);
  if (state.chiefEunuchs != null) convertBasileusCourtTitleTroop(troops);

  return { income, incomeBreakdown, troops, flow: normalizeIncomeFlow(flow, state) };
}

export function buildIncomeFlow(state) {
  return runIncome(state).flow;
}
