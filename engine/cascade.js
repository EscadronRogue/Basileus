// engine/cascade.js - Income: who receives the gold and troops of the empire.
//
//   Estate owner        profit (P) of each estate in an imperial province,
//                       plus ESTATE_DOMAIN_BONUS per domain (every
//                       ESTATE_DOMAIN_SIZE estates of one dynasty there)
//   Strategos           the troops (T) of its province, if imperial
//   Domestic / Admiral  the troops (T) of every imperial province of its region
//   Basileus            1 troop per BASILEUS_PROVINCES_PER_TROOP imperial provinces
//   Patriarch           the church value (C) of every imperial bishopric
//   Bishop              the church value (C) of its bishopric, imperial or lost
//
// Nothing is shared out: a Strategos's troops come on top of the Domestic's,
// and a Bishop's gold on top of the Patriarch's.
import { BALANCE } from '../data/balance.js';
import { REGIONS } from '../data/provinces.js';
import { getThemeChurchValue, getThemeTroopCount } from './rules.js';
import { getEstateHoldingIncome, getLeadingEstateHolder, getProvinceEstateHolders, getProvinceEstateTotal } from './estates.js';
import { findTitleHolder } from './state.js';

const ECONOMIC_REGIONS = [REGIONS.EAST, REGIONS.WEST, REGIONS.SEA];

const FLOW_RESOURCE_LABELS = {
  profit: 'Profit',
  troop: 'Troops',
  church: 'Church',
};

const REGION_ROUTE_KEYS = {
  [REGIONS.EAST]: 'east',
  [REGIONS.WEST]: 'west',
  [REGIONS.SEA]: 'sea',
};

export function getRegionalCommandKey(region) {
  if (region === REGIONS.EAST) return 'DOM_EAST';
  if (region === REGIONS.WEST) return 'DOM_WEST';
  if (region === REGIONS.SEA) return 'ADMIRAL';
  return null;
}

// A province of the empire (not Constantinople, not lost to invaders).
export function isImperialProvince(theme) {
  return Boolean(theme) && theme.id !== 'CPL' && !theme.lost;
}

export function countImperialProvinces(state) {
  return Object.values(state?.themes || {}).filter(isImperialProvince).length;
}

export function getBasileusTroopCount(state) {
  const perTroop = Math.max(1, Number(BALANCE.BASILEUS_PROVINCES_PER_TROOP) || 1);
  return Math.floor(countImperialProvinces(state) / perTroop);
}

export function isBishopric(theme) {
  return Boolean(theme) && theme.id !== 'CPL' && getThemeChurchValue(theme) > 0;
}

// Troop counts are plain numbers. Older states stored { normal, capitalLocked }.
export function readTroopCount(entry) {
  if (entry && typeof entry === 'object') {
    return Math.max(0, (Number(entry.normal) || 0) + (Number(entry.capitalLocked) || 0));
  }
  return Math.max(0, Number(entry) || 0);
}

function addIncome(income, playerId, amount) {
  if (playerId == null || amount <= 0) return;
  income[playerId] = (income[playerId] || 0) + amount;
}

function addTroops(troops, officeKey, amount) {
  const count = Math.max(0, Number(amount) || 0);
  if (!officeKey || count <= 0) return;
  troops[officeKey] = (troops[officeKey] || 0) + count;
}

function createFlowRoute(key, resource, label, rule = '') {
  return {
    key,
    resource,
    label,
    rule,
    total: 0,
    recipients: {},
    offices: {},
    sources: [],
  };
}

function createIncomeFlowDraft() {
  return {
    totals: { profit: 0, troop: 0, church: 0 },
    routes: {
      profit: {
        estates: createFlowRoute('estates', 'profit', 'Estates', 'Each estate pays its owner'),
      },
      troop: {
        strategoi: createFlowRoute('strategoi', 'troop', 'Strategoi', 'Each Strategos raises its province'),
        east: createFlowRoute('east', 'troop', 'East', 'Every imperial province of the East'),
        west: createFlowRoute('west', 'troop', 'West', 'Every imperial province of the West'),
        sea: createFlowRoute('sea', 'troop', 'Sea', 'Every imperial province of the Sea'),
        basileus: createFlowRoute('basileus', 'troop', 'Empire', `1 per ${BALANCE.BASILEUS_PROVINCES_PER_TROOP} imperial provinces`),
      },
      church: {
        bishops: createFlowRoute('bishops', 'church', 'Bishops', 'Each Bishop is paid by its bishopric'),
        patriarch: createFlowRoute('patriarch', 'church', 'Patriarch', 'Every imperial bishopric'),
      },
    },
    playerTotals: {},
  };
}

function ensurePlayerFlowTotal(flow, playerId) {
  if (playerId == null) return null;
  const key = String(playerId);
  if (!flow.playerTotals[key]) {
    flow.playerTotals[key] = { playerId: Number(playerId), profit: 0, troop: 0, church: 0 };
  }
  return flow.playerTotals[key];
}

function addFlowSource(flow, route, amount, source = {}) {
  const count = Math.max(0, Number(amount) || 0);
  if (!route || count <= 0) return;
  route.total += count;
  flow.totals[route.resource] = (flow.totals[route.resource] || 0) + count;
  if (source.themeId) route.sources.push({ themeId: source.themeId, value: count });
}

function addFlowRecipient(flow, route, playerId, amount) {
  const count = Math.max(0, Number(amount) || 0);
  if (!route || playerId == null || count <= 0) return;
  const key = String(playerId);
  route.recipients[key] = (route.recipients[key] || 0) + count;
  const playerTotal = ensurePlayerFlowTotal(flow, playerId);
  if (playerTotal) playerTotal[route.resource] += count;
}

function addFlowOffice(route, officeKey, playerId, amount) {
  const count = Math.max(0, Number(amount) || 0);
  if (!route || !officeKey || count <= 0) return;
  const entry = route.offices[officeKey] || { officeKey, playerId, value: 0 };
  entry.playerId = playerId;
  entry.value += count;
  route.offices[officeKey] = entry;
}

function normalizeRecipients(recipients) {
  return Object.entries(recipients || {})
    .map(([playerId, value]) => ({ playerId: Number(playerId), value: Math.max(0, Number(value) || 0) }))
    .filter((entry) => entry.value > 0)
    .sort((left, right) => (right.value - left.value) || (left.playerId - right.playerId));
}

function normalizeOffices(offices) {
  return Object.values(offices || {})
    .map((entry) => ({
      officeKey: entry.officeKey,
      playerId: entry.playerId == null ? null : Number(entry.playerId),
      value: Math.max(0, Number(entry.value) || 0),
    }))
    .filter((entry) => entry.value > 0)
    .sort((left, right) => (right.value - left.value) || String(left.officeKey).localeCompare(String(right.officeKey)));
}

function normalizeSources(sources) {
  return (sources || [])
    .map((entry) => ({ themeId: entry.themeId, value: Math.max(0, Number(entry.value) || 0) }))
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
  const sections = Object.entries(flow.routes).map(([resource, routes]) => ({
    key: resource,
    label: FLOW_RESOURCE_LABELS[resource] || resource,
    total: Math.max(0, Number(flow.totals[resource]) || 0),
    routes: Object.values(routes).map(normalizeFlowRoute),
  }));

  const playerTotals = (state.players || []).map((player) => ({
    playerId: player.id,
    profit: Math.max(0, Number(flow.playerTotals[String(player.id)]?.profit) || 0),
    troop: Math.max(0, Number(flow.playerTotals[String(player.id)]?.troop) || 0),
    church: Math.max(0, Number(flow.playerTotals[String(player.id)]?.church) || 0),
  }));

  return { totals: { ...flow.totals }, sections, playerTotals };
}

// Map filters: who holds each province's minor offices and estates.
function createProvinceAttribution(theme, playerId, value, options = {}) {
  return {
    themeId: theme.id,
    playerId: playerId == null ? null : Number(playerId),
    value: Math.max(0, Number(value) || 0),
    route: options.route || null,
    officeKey: options.officeKey || null,
    mode: options.mode || 'direct',
    direct: options.direct !== false,
    disabled: Boolean(options.disabled),
  };
}

function pushProvinceAttribution(target, attribution) {
  if (!attribution?.themeId) return;
  target[attribution.themeId] = attribution;
}

// The dynasty with the most estates colours the province; a tie leaves it
// uncoloured, and `holders` lists everyone for the tooltip and markers.
export function buildProvinceEstateAttributions(state) {
  const attributions = {};
  for (const theme of Object.values(state?.themes || {})) {
    if (!theme || theme.id === 'CPL') continue;
    const holders = getProvinceEstateHolders(theme);
    if (!holders.length) continue;
    pushProvinceAttribution(attributions, {
      ...createProvinceAttribution(theme, getLeadingEstateHolder(theme), getProvinceEstateTotal(theme), {
        route: 'estates',
        mode: 'estate',
        disabled: Boolean(theme.lost),
      }),
      holders,
      tied: holders.length > 1 && holders[0].count === holders[1].count,
    });
  }
  return attributions;
}

// Only appointed Strategoi: a province without one is shown as vacant.
export function buildProvinceTroopAttributions(state) {
  const attributions = {};
  for (const theme of Object.values(state?.themes || {})) {
    if (!theme || theme.id === 'CPL' || theme.strategos == null) continue;
    pushProvinceAttribution(attributions, createProvinceAttribution(theme, theme.strategos, getThemeTroopCount(theme), {
      route: 'strategoi',
      officeKey: `STRAT_${theme.id}`,
      mode: 'strategos',
      disabled: Boolean(theme.lost),
    }));
  }
  return attributions;
}

// Only appointed Bishops: a bishopric without one is shown as vacant.
export function buildProvinceChurchAttributions(state) {
  const attributions = {};
  for (const theme of Object.values(state?.themes || {})) {
    if (!isBishopric(theme) || theme.bishop == null) continue;
    pushProvinceAttribution(attributions, createProvinceAttribution(theme, theme.bishop, getThemeChurchValue(theme), {
      route: 'bishops',
      officeKey: `BISHOP_${theme.id}`,
      mode: 'bishop',
    }));
  }
  return attributions;
}

export function runIncome(state) {
  const flow = createIncomeFlowDraft();
  const income = {};
  const incomeBreakdown = { estate: {}, church: {} };
  const troops = {};

  const addCategorizedIncome = (category, playerId, amount) => {
    const count = Math.max(0, Number(amount) || 0);
    if (playerId == null || count <= 0) return;
    addIncome(income, playerId, count);
    incomeBreakdown[category][playerId] = (incomeBreakdown[category][playerId] || 0) + count;
  };

  const regionHolders = Object.fromEntries(ECONOMIC_REGIONS.map((region) => {
    const officeKey = getRegionalCommandKey(region);
    return [region, { officeKey, holderId: findTitleHolder(state, officeKey) }];
  }));
  const patriarchId = findTitleHolder(state, 'PATRIARCH');

  for (const theme of Object.values(state.themes || {})) {
    if (!theme || theme.id === 'CPL') continue;
    const imperial = isImperialProvince(theme);

    if (imperial) {
      const route = flow.routes.profit.estates;
      for (const holder of getProvinceEstateHolders(theme)) {
        const profit = getEstateHoldingIncome(theme, holder.count, state);
        addFlowSource(flow, route, profit, { themeId: theme.id });
        addFlowRecipient(flow, route, holder.playerId, profit);
        addCategorizedIncome('estate', holder.playerId, profit);
      }
    }

    const troopCount = imperial ? getThemeTroopCount(theme) : 0;
    if (troopCount > 0 && theme.strategos != null) {
      const officeKey = `STRAT_${theme.id}`;
      const route = flow.routes.troop.strategoi;
      addFlowSource(flow, route, troopCount, { themeId: theme.id });
      addFlowRecipient(flow, route, theme.strategos, troopCount);
      addFlowOffice(route, officeKey, theme.strategos, troopCount);
      addTroops(troops, officeKey, troopCount);
    }
    const region = regionHolders[theme.region];
    if (troopCount > 0 && region?.officeKey) {
      const route = flow.routes.troop[REGION_ROUTE_KEYS[theme.region]];
      addFlowSource(flow, route, troopCount, { themeId: theme.id });
      if (region.holderId != null) {
        addFlowRecipient(flow, route, region.holderId, troopCount);
        addFlowOffice(route, region.officeKey, region.holderId, troopCount);
        addTroops(troops, region.officeKey, troopCount);
      }
    }

    const churchValue = isBishopric(theme) ? getThemeChurchValue(theme) : 0;
    if (churchValue > 0 && theme.bishop != null) {
      const route = flow.routes.church.bishops;
      addFlowSource(flow, route, churchValue, { themeId: theme.id });
      addFlowRecipient(flow, route, theme.bishop, churchValue);
      addFlowOffice(route, `BISHOP_${theme.id}`, theme.bishop, churchValue);
      addCategorizedIncome('church', theme.bishop, churchValue);
    }
    if (churchValue > 0 && imperial) {
      const route = flow.routes.church.patriarch;
      addFlowSource(flow, route, churchValue, { themeId: theme.id });
      if (patriarchId != null) {
        addFlowRecipient(flow, route, patriarchId, churchValue);
        addFlowOffice(route, 'PATRIARCH', patriarchId, churchValue);
        addCategorizedIncome('church', patriarchId, churchValue);
      }
    }
  }

  const basileusTroops = getBasileusTroopCount(state);
  if (basileusTroops > 0) {
    const route = flow.routes.troop.basileus;
    addFlowSource(flow, route, basileusTroops);
    if (state.basileusId != null) {
      addFlowRecipient(flow, route, state.basileusId, basileusTroops);
      addFlowOffice(route, 'BASILEUS', state.basileusId, basileusTroops);
      addTroops(troops, 'BASILEUS', basileusTroops);
    }
  }

  return { income, incomeBreakdown, troops, flow: normalizeIncomeFlow(flow, state) };
}

export function buildIncomeFlow(state) {
  return runIncome(state).flow;
}
