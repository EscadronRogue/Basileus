// engine/estates.js - estates: any number per province, for any dynasty.
//
// Each province keeps, per dynasty, how many estates it holds there and how
// many of them were built in the latest Estates phase (`recent`). Recent
// estates cannot be revoked in the next Offices phase.
//
// In the Estates phase every dynasty plans in secret how many estates to
// build where; the plans are paid and built together when Deployment opens.
// Within one round the first estate a dynasty builds costs ESTATE_BASE_PRICE
// and each further one costs 1 gold more, like mercenaries.
import { BALANCE } from '../data/balance.js';
import { getSpendableGold } from './deals/state.js';
import { recordHistoryEvent } from './history.js';
import { formatGold } from './presentation.js';
import { getRisingPriceCost, getRisingPriceTotal } from './rules.js';
import { getPlayer, getPlayerName } from './state.js';

function fail(reason) {
  return { ok: false, reason };
}

function toCount(value) {
  const number = Math.floor(Number(value) || 0);
  return number > 0 ? number : 0;
}

function readEntry(entry) {
  if (typeof entry === 'number') return { count: toCount(entry), recent: 0 };
  const count = toCount(entry?.count);
  return { count, recent: Math.min(count, toCount(entry?.recent)) };
}

function ensureEstateMap(theme) {
  if (!theme.estates || typeof theme.estates !== 'object') theme.estates = {};
  return theme.estates;
}

// Provinces where estates can be built: the empire's, not Constantinople.
export function canHoldEstates(theme) {
  return Boolean(theme) && theme.id !== 'CPL';
}

export function canBuildEstatesIn(theme) {
  return canHoldEstates(theme) && !theme.lost;
}

// [{ playerId, count, recent }] for every dynasty with estates in the
// province, most estates first.
export function getProvinceEstateHolders(theme) {
  return Object.entries(theme?.estates || {})
    .map(([playerId, entry]) => ({ playerId: Number(playerId), ...readEntry(entry) }))
    .filter((entry) => Number.isInteger(entry.playerId) && entry.count > 0)
    .sort((left, right) => (right.count - left.count) || (left.playerId - right.playerId));
}

export function getEstateCount(theme, playerId) {
  return readEntry(theme?.estates?.[playerId]).count;
}

export function getRecentEstateCount(theme, playerId) {
  return readEntry(theme?.estates?.[playerId]).recent;
}

export function getProvinceEstateTotal(theme) {
  return getProvinceEstateHolders(theme).reduce((total, entry) => total + entry.count, 0);
}

export function hasEstates(theme) {
  return getProvinceEstateTotal(theme) > 0;
}

// The dynasty with the most estates in a province (null when tied or empty).
export function getLeadingEstateHolder(theme) {
  const [first, second] = getProvinceEstateHolders(theme);
  if (!first) return null;
  if (second && second.count === first.count) return null;
  return first.playerId;
}

// [{ themeId, count, recent, lost }] for one dynasty.
export function getDynastyEstates(state, playerId) {
  return Object.values(state?.themes || {})
    .filter(canHoldEstates)
    .map((theme) => ({ themeId: theme.id, lost: Boolean(theme.lost), ...readEntry(theme.estates?.[playerId]) }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => (right.count - left.count) || left.themeId.localeCompare(right.themeId));
}

export function countDynastyEstates(state, playerId, { activeOnly = false } = {}) {
  return getDynastyEstates(state, playerId)
    .filter((entry) => !activeOnly || !entry.lost)
    .reduce((total, entry) => total + entry.count, 0);
}

// Estates a revocation would take: none in a lost province, and never the
// ones built in the latest Estates phase.
export function getRevocableEstateCount(theme, playerId) {
  if (!canHoldEstates(theme) || theme.lost) return 0;
  const entry = readEntry(theme.estates?.[playerId]);
  return Math.max(0, entry.count - entry.recent);
}

export function addEstates(theme, playerId, count, { recent = true } = {}) {
  const added = toCount(count);
  if (!canHoldEstates(theme) || !Number.isInteger(Number(playerId)) || added <= 0) return 0;
  const estates = ensureEstateMap(theme);
  const entry = readEntry(estates[playerId]);
  estates[playerId] = {
    count: entry.count + added,
    recent: entry.recent + (recent ? added : 0),
  };
  return added;
}

// Removes every estate of the dynasty in the province except the protected
// recent ones. Returns how many were removed.
export function removeRevocableEstates(theme, playerId) {
  const removed = getRevocableEstateCount(theme, playerId);
  if (removed <= 0) return 0;
  const estates = ensureEstateMap(theme);
  const entry = readEntry(estates[playerId]);
  const remaining = entry.count - removed;
  if (remaining > 0) estates[playerId] = { count: remaining, recent: entry.recent };
  else delete estates[playerId];
  return removed;
}

// Moves all of one dynasty's estates in a province to another (deals).
export function transferEstates(theme, fromPlayerId, toPlayerId) {
  const moved = getEstateCount(theme, fromPlayerId);
  if (moved <= 0) return 0;
  delete ensureEstateMap(theme)[fromPlayerId];
  addEstates(theme, toPlayerId, moved, { recent: false });
  return moved;
}

export function clearRecentEstateMarks(state) {
  for (const theme of Object.values(state?.themes || {})) {
    for (const [playerId, entry] of Object.entries(theme?.estates || {})) {
      const { count } = readEntry(entry);
      if (count > 0) theme.estates[playerId] = { count, recent: 0 };
      else delete theme.estates[playerId];
    }
  }
}

// Prices
export function getEstatePlanCost(count) {
  return getRisingPriceTotal(count, BALANCE.ESTATE_BASE_PRICE);
}

export function getNextEstatePrice(alreadyPlanned) {
  return getRisingPriceCost(alreadyPlanned, 1, BALANCE.ESTATE_BASE_PRICE);
}

// Plans
function ensureEstatePlans(state) {
  if (!state.estatePlans || typeof state.estatePlans !== 'object') state.estatePlans = {};
  return state.estatePlans;
}

export function normalizeEstatePlan(state, rawPlan = {}) {
  const plan = {};
  for (const [themeId, rawCount] of Object.entries(rawPlan || {})) {
    const count = toCount(rawCount);
    if (count > 0 && canBuildEstatesIn(state.themes?.[themeId])) plan[themeId] = count;
  }
  return plan;
}

export function getEstatePlan(state, playerId) {
  return normalizeEstatePlan(state, state?.estatePlans?.[playerId] || {});
}

export function countPlannedEstates(plan = {}) {
  return Object.values(plan || {}).reduce((total, count) => total + toCount(count), 0);
}

export function validateEstatePlan(state, playerId, rawPlan = {}) {
  if (state?.phase !== 'estates') return fail('Estates can only be built during the Estates phase.');
  if (!getPlayer(state, playerId)) return fail('Dynasty not found.');
  for (const [themeId, rawCount] of Object.entries(rawPlan || {})) {
    if (toCount(rawCount) <= 0) continue;
    const theme = state.themes?.[themeId];
    if (!canHoldEstates(theme)) return fail('Estates can only be built in the provinces of the empire.');
    if (theme.lost) return fail(`${theme.name} is lost to invaders; no estate can be built there.`);
  }
  const plan = normalizeEstatePlan(state, rawPlan);
  const count = countPlannedEstates(plan);
  const cost = getEstatePlanCost(count);
  const gold = Math.max(0, Number(getSpendableGold(state, playerId)) || 0);
  if (cost > gold) {
    return fail(`${count} estate${count === 1 ? '' : 's'} cost ${formatGold(cost)}; you have ${formatGold(gold)}.`);
  }
  return { ok: true, plan, count, cost };
}

export function setEstatePlan(state, playerId, rawPlan = {}) {
  const check = validateEstatePlan(state, playerId, rawPlan);
  if (!check.ok) return check;
  const plans = ensureEstatePlans(state);
  if (check.count > 0) plans[playerId] = check.plan;
  else delete plans[playerId];
  return check;
}

// Builds every locked plan and charges its price. Called when Deployment opens.
export function settleEstatePlans(state) {
  const plans = ensureEstatePlans(state);
  const results = [];
  for (const player of state.players || []) {
    const plan = normalizeEstatePlan(state, plans[player.id] || {});
    const count = countPlannedEstates(plan);
    if (count <= 0) continue;
    const cost = getEstatePlanCost(count);
    if (cost > Math.max(0, Number(getSpendableGold(state, player.id)) || 0)) continue;
    player.gold -= cost;
    const builds = [];
    for (const [themeId, planned] of Object.entries(plan)) {
      const theme = state.themes[themeId];
      addEstates(theme, player.id, planned, { recent: true });
      builds.push({ themeId, themeName: theme.name, count: planned });
    }
    builds.sort((left, right) => (right.count - left.count) || left.themeName.localeCompare(right.themeName));
    state.log?.push({ type: 'build_estates', player: player.id, builds, cost, round: state.round });
    const where = builds.map((entry) => (entry.count > 1 ? `${entry.themeName} ×${entry.count}` : entry.themeName)).join(', ');
    recordHistoryEvent(state, {
      category: 'estates',
      type: 'build_estates',
      actorId: player.id,
      summary: `${getPlayerName(state, player.id)} builds ${count} estate${count === 1 ? '' : 's'} for ${formatGold(cost)}: ${where}.`,
      details: { builds, count, cost },
    });
    results.push({ playerId: player.id, builds, count, cost });
  }
  state.estatePlans = {};
  return results;
}
