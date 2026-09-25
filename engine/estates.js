// engine/estates.js - estates: any number per province, for any dynasty.
//
// Each province keeps, per dynasty, how many estates it holds there. Every
// ESTATE_DOMAIN_SIZE of them form a domain, which pays extra gold.
//
// In the Estates phase every dynasty plans in secret how many estates to
// build where; the plans are paid and built together when Deployment opens.
// Every estate costs ESTATE_PRICE, however many are built.
import { getBalance } from '../data/balance.js';
import { getSpendableGold } from './deals/state.js';
import { recordHistoryEvent } from './history.js';
import { formatGold } from './presentation.js';
import { getThemeOwnerIncome } from './rules.js';
import { getPlayer, getPlayerName } from './state.js';

function fail(reason) {
  return { ok: false, reason };
}

function toCount(value) {
  const number = Math.floor(Number(value) || 0);
  return number > 0 ? number : 0;
}

function readEntry(entry) {
  if (typeof entry === 'number') return { count: toCount(entry) };
  return { count: toCount(entry?.count) };
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

// [{ playerId, count }] for every dynasty with estates in the province, most
// estates first.
export function getProvinceEstateHolders(theme) {
  return Object.entries(theme?.estates || {})
    .map(([playerId, entry]) => ({ playerId: Number(playerId), ...readEntry(entry) }))
    .filter((entry) => Number.isInteger(entry.playerId) && entry.count > 0)
    .sort((left, right) => (right.count - left.count) || (left.playerId - right.playerId));
}

export function getEstateCount(theme, playerId) {
  return readEntry(theme?.estates?.[playerId]).count;
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

// [{ themeId, count, lost }] for one dynasty.
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

// Estates a revocation would take: all of the dynasty's estates in the
// province, none in a lost province.
export function getRevocableEstateCount(theme, playerId) {
  if (!canHoldEstates(theme) || theme.lost) return 0;
  return readEntry(theme.estates?.[playerId]).count;
}

export function addEstates(theme, playerId, count) {
  const added = toCount(count);
  if (!canHoldEstates(theme) || !Number.isInteger(Number(playerId)) || added <= 0) return 0;
  const estates = ensureEstateMap(theme);
  estates[playerId] = { count: readEntry(estates[playerId]).count + added };
  return added;
}

// Removes every estate of the dynasty in the province. Returns how many were
// removed.
export function removeRevocableEstates(theme, playerId) {
  const removed = getRevocableEstateCount(theme, playerId);
  if (removed <= 0) return 0;
  delete ensureEstateMap(theme)[playerId];
  return removed;
}

// Moves all of one dynasty's estates in a province to another (deals).
export function transferEstates(theme, fromPlayerId, toPlayerId) {
  const moved = getEstateCount(theme, fromPlayerId);
  if (moved <= 0) return 0;
  delete ensureEstateMap(theme)[fromPlayerId];
  addEstates(theme, toPlayerId, moved);
  return moved;
}

// Domains: every ESTATE_DOMAIN_SIZE estates a dynasty holds in one province.
export function getDomainCount(estateCount, state = null) {
  const size = Math.max(1, Math.floor(Number(getBalance(state).ESTATE_DOMAIN_SIZE) || 1));
  return Math.floor(toCount(estateCount) / size);
}

// Gold `estateCount` estates of one dynasty pay in a province every income:
// the province's profit per estate, plus the bonus of each domain.
export function getEstateHoldingIncome(theme, estateCount, state = null) {
  const count = toCount(estateCount);
  const bonus = Math.max(0, Number(getBalance(state).ESTATE_DOMAIN_BONUS) || 0);
  return count * getThemeOwnerIncome(theme) + getDomainCount(count, state) * bonus;
}

// Prices depend on the map, so pass the game state.
export function getEstatePlanCost(count, state = null) {
  return toCount(count) * getNextEstatePrice(0, state);
}

export function getNextEstatePrice(alreadyPlanned, state = null) {
  return Math.max(0, Number(getBalance(state).ESTATE_PRICE) || 0);
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
  const cost = getEstatePlanCost(count, state);
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
    const cost = getEstatePlanCost(count, state);
    if (cost > Math.max(0, Number(getSpendableGold(state, player.id)) || 0)) continue;
    player.gold -= cost;
    const builds = [];
    for (const [themeId, planned] of Object.entries(plan)) {
      const theme = state.themes[themeId];
      addEstates(theme, player.id, planned);
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
