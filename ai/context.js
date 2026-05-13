import {
  getPlayerMercenaryTotal,
  getPlayerThemes,
} from '../engine/state.js';
import { buildFinalScores } from '../engine/scoring.js';
import {
  getNormalOwnerIncome,
  getThemeOwnerIncome,
} from '../engine/rules.js';
import { getSpendableGold } from '../engine/deals.js';

const CONTEXT_CACHE_KEY = 'systemicAIContext';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function roundTo(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function stableInvasionKey(invasion) {
  if (!invasion) return 'none';
  const route = Array.isArray(invasion.route) ? invasion.route.join(',') : '';
  const strength = Array.isArray(invasion.strength) ? invasion.strength.join('-') : '';
  return `${invasion.id || invasion.name || 'invasion'}:${route}:${strength}`;
}

function contextKeyFor(state, stage) {
  const levies = state.currentLevies
    ? Object.entries(state.currentLevies).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join('|')
    : '';
  const mercenaries = state.currentMercenaryTroops
    ? Object.entries(state.currentMercenaryTroops).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join('|')
    : '';
  const auctions = state.landAuctions
    ? Object.entries(state.landAuctions).sort(([left], [right]) => left.localeCompare(right)).map(([themeId, auction]) => `${themeId}:${auction?.bidderId}:${auction?.amount}`).join('|')
    : '';
  return [
    stage,
    state.round,
    state.phase,
    state.basileusId,
    state.nextBasileusId,
    stableInvasionKey(state.currentInvasion),
    levies,
    mercenaries,
    auctions,
    state.activeDealObligations?.length || 0,
  ].join('::');
}

function getMinorTitleCount(state, playerId) {
  let count = 0;
  if (state.empress === playerId) count++;
  if (state.chiefEunuchs === playerId) count++;
  for (const theme of Object.values(state.themes || {})) {
    if (theme.occupied) continue;
    if (theme.strategos === playerId) count++;
    if (theme.bishop === playerId) count++;
  }
  return count;
}

function getProfessionalCount(player) {
  return sum(Object.values(player?.professionalArmies || {}).map(value => Math.max(0, Number(value) || 0)));
}

function getLevyCount(state, playerId) {
  let total = 0;
  for (const [officeKey, count] of Object.entries(state.currentLevies || {})) {
    const holder = getOfficeHolder(state, officeKey);
    if (holder === playerId) total += Math.max(0, Number(count) || 0);
  }
  return total;
}

function getOfficeHolder(state, officeKey) {
  if (officeKey === 'BASILEUS') return state.basileusId;
  if (officeKey === 'EMPRESS') return state.empress ?? null;
  if (officeKey === 'CHIEF_EUNUCHS') return state.chiefEunuchs ?? null;
  if (officeKey === 'DOM_EAST' || officeKey === 'DOM_WEST' || officeKey === 'ADMIRAL' || officeKey === 'PATRIARCH') {
    return state.players.find(player => player.majorTitles?.includes(officeKey))?.id ?? null;
  }
  if (String(officeKey).startsWith('STRAT_')) {
    const themeId = String(officeKey).replace('STRAT_', '');
    return state.themes?.[themeId]?.strategos ?? null;
  }
  return null;
}

function getThemeRouteRisk(state, themeId) {
  const route = state.currentInvasion?.route;
  if (!Array.isArray(route) || !route.length) return 0;
  const routeIndex = route.indexOf(themeId);
  if (routeIndex === -1) return 0;
  const usableLength = Math.max(1, route.length - 2);
  return clamp(1 - (routeIndex / usableLength), 0, 1);
}

function getThemeStrategicValue(theme) {
  return (Number(theme?.P) || 0) * 1.35 + (Number(theme?.L) || 0) * 0.95;
}

function getPlayerExposure(state, playerId) {
  return getPlayerThemes(state, playerId).reduce((total, theme) => total + getThemeRouteRisk(state, theme.id), 0);
}

function getPlayerThreatenedValue(state, playerId) {
  return getPlayerThemes(state, playerId).reduce(
    (total, theme) => total + getThemeRouteRisk(state, theme.id) * getThemeStrategicValue(theme),
    0,
  );
}

function getPlayerIncome(state, playerId) {
  return getPlayerThemes(state, playerId).reduce((total, theme) => total + getThemeOwnerIncome(theme), 0);
}

function getFreeIncome(state) {
  return Object.values(state.themes || {})
    .filter(theme => !theme.occupied && theme.owner == null && theme.id !== 'CPL')
    .reduce((total, theme) => total + getNormalOwnerIncome(theme), 0);
}

function getRelationSums(meta, playerId) {
  const playerMeta = meta?.players?.[playerId] || {};
  const trustOut = sum(Object.values(playerMeta.trust || {}).map(Number));
  const grievanceOut = sum(Object.values(playerMeta.grievance || {}).map(Number));
  const obligationOut = sum(Object.values(playerMeta.obligations || {}).map(Number));
  let obligationIn = 0;
  let trustIn = 0;
  let grievanceIn = 0;
  for (const [otherId, otherMeta] of Object.entries(meta?.players || {})) {
    if (Number(otherId) === Number(playerId)) continue;
    obligationIn += Number(otherMeta.obligations?.[playerId]) || 0;
    trustIn += Number(otherMeta.trust?.[playerId]) || 0;
    grievanceIn += Number(otherMeta.grievance?.[playerId]) || 0;
  }
  return { trustOut, trustIn, grievanceOut, grievanceIn, obligationOut, obligationIn };
}

function getActiveObligationPressure(state, playerId) {
  let dueNow = 0;
  let future = 0;
  for (const obligation of state.activeDealObligations || []) {
    if (obligation.status === 'completed' || obligation.status === 'dormant') continue;
    if (Number(obligation.giverId) !== Number(playerId) && Number(obligation.receiverId) !== Number(playerId)) continue;
    const weight = Number(obligation.giverId) === Number(playerId) ? 1 : 0.45;
    if (Number(obligation.nextDueRound) === Number(state.round)) dueNow += weight;
    else future += weight;
  }
  return { dueNow, future, total: dueNow + future };
}

function getInvasionIndicators(state) {
  const invasion = state.currentInvasion;
  if (!invasion) {
    return {
      present: false,
      estimatedMin: 0,
      estimatedMax: 0,
      expectedStrength: 0,
      uncertainty: 0,
      routeLength: 0,
      occupiedOnRoute: 0,
    };
  }
  const [estimatedMin = 0, estimatedMax = estimatedMin] = invasion.strength || [];
  const route = Array.isArray(invasion.route) ? invasion.route : [];
  const occupiedOnRoute = route.filter(themeId => state.themes?.[themeId]?.occupied).length;
  return {
    present: true,
    estimatedMin,
    estimatedMax,
    expectedStrength: (estimatedMin + estimatedMax) / 2,
    uncertainty: clamp((estimatedMax - estimatedMin) / Math.max(1, estimatedMax), 0, 1),
    routeLength: route.length,
    occupiedOnRoute,
  };
}

function buildStandings(rawPlayers) {
  return rawPlayers
    .slice()
    .sort((left, right) => right.positionScore - left.positionScore || right.gold - left.gold || left.playerId - right.playerId)
    .map((entry, index, ordered) => {
      const leader = ordered[0] || entry;
      const nextAhead = index > 0 ? ordered[index - 1] : entry;
      const nextBehind = ordered[index + 1] || entry;
      return {
        ...entry,
        rank: index + 1,
        leaderId: leader.playerId,
        gapToLeader: leader.positionScore - entry.positionScore,
        gapToNextAhead: nextAhead.positionScore - entry.positionScore,
        leadOverNextBehind: entry.positionScore - nextBehind.positionScore,
      };
    });
}

function normalizePlayers(standingPlayers, state) {
  const maxGold = Math.max(1, ...standingPlayers.map(entry => entry.gold));
  const maxSpendableGold = Math.max(1, ...standingPlayers.map(entry => entry.spendableGold));
  const maxScore = Math.max(1, ...standingPlayers.map(entry => entry.positionScore));
  const maxIncome = Math.max(1, ...standingPlayers.map(entry => entry.income));
  const maxTroops = Math.max(1, ...standingPlayers.map(entry => entry.totalTroops));
  const maxTitles = Math.max(1, ...standingPlayers.map(entry => entry.majorTitles + entry.minorTitles));
  const maxThreatened = Math.max(1, ...standingPlayers.map(entry => entry.threatenedValue));
  const maxExposure = Math.max(1, ...standingPlayers.map(entry => entry.exposure));
  const maxRivalGap = Math.max(1, ...standingPlayers.map(entry => entry.gapToLeader));
  const playerCount = Math.max(1, state.players.length);

  return standingPlayers.map(entry => ({
    ...entry,
    normalized: {
      score: clamp(entry.positionScore / maxScore, 0, 2),
      gold: clamp(entry.gold / maxGold, 0, 2),
      spendableGold: clamp(entry.spendableGold / maxSpendableGold, 0, 2),
      income: clamp(entry.income / maxIncome, 0, 2),
      troops: clamp(entry.totalTroops / maxTroops, 0, 2),
      titles: clamp((entry.majorTitles + entry.minorTitles) / maxTitles, 0, 2),
      rank: clamp(1 - ((entry.rank - 1) / Math.max(1, playerCount - 1)), 0, 1),
      rivalry: clamp(entry.gapToLeader / maxRivalGap, 0, 1.5),
      exposure: clamp(entry.exposure / maxExposure, 0, 2),
      threatened: clamp(entry.threatenedValue / maxThreatened, 0, 2),
      obligationPressure: clamp(entry.obligations.total / 5, 0, 2),
      uncertainty: entry.uncertainty,
    },
  }));
}

function buildPlayerIndicators(state, meta, invasion) {
  const finalScores = buildFinalScores(state);
  const scoreByPlayer = new Map(finalScores.scores.map(score => [score.playerId, score]));
  const freeIncome = getFreeIncome(state);
  const rawPlayers = state.players.map(player => {
    const scoreEntry = scoreByPlayer.get(player.id);
    const themes = getPlayerThemes(state, player.id);
    const professionals = getProfessionalCount(player);
    const levies = getLevyCount(state, player.id);
    const mercenaries = getPlayerMercenaryTotal(state, player.id);
    const totalTroops = professionals + levies + mercenaries;
    const exposure = getPlayerExposure(state, player.id);
    const threatenedValue = getPlayerThreatenedValue(state, player.id);
    const income = getPlayerIncome(state, player.id);
    const relations = getRelationSums(meta, player.id);
    const obligations = getActiveObligationPressure(state, player.id);
    const positionScore =
      (scoreEntry?.points || 0) * 9 +
      player.gold * 0.35 +
      income * 1.35 +
      themes.length * 1.1 +
      player.majorTitles.length * 1.45 +
      getMinorTitleCount(state, player.id) * 0.55 +
      totalTroops * 0.75 -
      threatenedValue * 0.25;

    return {
      playerId: player.id,
      dynasty: player.dynasty,
      isBasileus: player.id === state.basileusId,
      gold: Number(player.gold) || 0,
      spendableGold: getSpendableGold(state, player.id),
      score: scoreEntry?.points || 0,
      projectedIncome: scoreEntry?.projectedIncome || 0,
      positionScore,
      themes: themes.length,
      majorTitles: player.majorTitles.length,
      minorTitles: getMinorTitleCount(state, player.id),
      professionals,
      levies,
      mercenaries,
      totalTroops,
      income,
      freeIncomeShare: freeIncome > 0 ? income / freeIncome : 0,
      exposure,
      threatenedValue,
      frontierNeed: clamp((exposure * 0.35) + (threatenedValue * 0.035) + (invasion.expectedStrength * 0.04), 0, 3),
      politicalLeverage: player.majorTitles.length * 1.2 + getMinorTitleCount(state, player.id) * 0.45 + totalTroops * 0.25,
      militaryLeverage: totalTroops + player.majorTitles.length * 0.6,
      obligations,
      relations,
      uncertainty: clamp(invasion.uncertainty + obligations.total * 0.04, 0, 1.5),
    };
  });
  return normalizePlayers(buildStandings(rawPlayers), state);
}

export function invalidateAIContext(meta) {
  if (!meta) return;
  meta[CONTEXT_CACHE_KEY] = null;
}

export function ensureAIContext(state, meta, stage = state?.phase || 'unknown') {
  if (!state || !meta) return null;
  const key = contextKeyFor(state, stage);
  if (meta[CONTEXT_CACHE_KEY]?.key === key) return meta[CONTEXT_CACHE_KEY].context;

  const invasion = getInvasionIndicators(state);
  const players = buildPlayerIndicators(state, meta, invasion);
  const playersById = new Map(players.map(player => [player.playerId, player]));
  const leader = players[0] || null;
  const totalThreatenedValue = sum(players.map(player => player.threatenedValue));
  const totalTroops = sum(players.map(player => player.totalTroops));
  const totalIncome = sum(players.map(player => player.income));
  const unresolvedOrders = state.phase === 'orders'
    ? state.players.length - Object.keys(state.allOrders || {}).length
    : 0;

  const context = {
    key,
    stage,
    round: state.round,
    phase: state.phase,
    remainingRounds: Math.max(0, (state.maxRounds || 0) - (state.round || 0)),
    progress: state.maxRounds ? clamp(state.round / Math.max(1, state.maxRounds), 0, 1) : 0,
    basileusId: state.basileusId,
    nextBasileusId: state.nextBasileusId,
    invasion,
    players,
    playersById,
    leaderId: leader?.playerId ?? null,
    totals: {
      threatenedValue: roundTo(totalThreatenedValue),
      troops: roundTo(totalTroops),
      income: roundTo(totalIncome),
      unresolvedOrders,
      activeObligations: (state.activeDealObligations || []).filter(entry => entry.status !== 'completed').length,
    },
  };

  meta[CONTEXT_CACHE_KEY] = { key, context };
  return context;
}

export function getAIPlayerIndicators(context, playerId) {
  return context?.playersById?.get(Number(playerId)) || null;
}

export function getAIRivalIndicators(context, playerId) {
  return (context?.players || []).filter(player => player.playerId !== Number(playerId));
}

export function getAIPairIndicators(context, actorId, targetId) {
  const actor = getAIPlayerIndicators(context, actorId);
  const target = getAIPlayerIndicators(context, targetId);
  if (!actor || !target) return null;
  return {
    actor,
    target,
    targetAhead: target.positionScore > actor.positionScore,
    targetLeaderGap: actor.positionScore - target.positionScore,
    targetThreatenedShare: context.totals.threatenedValue > 0
      ? target.threatenedValue / context.totals.threatenedValue
      : 0,
  };
}
