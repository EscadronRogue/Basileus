// engine/state.js - game state initialization and shared lookups.
import { REGION_BORDER_COLORS, REGIONS } from '../data/provinces.js';
import { buildMapAdjacency, getMapInvasions, getMapProvinces, normalizeMapId } from '../data/maps/index.js';
import {
  getDynastyProfileForSeat,
  INVASION_OBJECTIVES,
} from '../data/invasions.js';
import { getBalance } from '../data/balance.js';
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';

// Bumped whenever a rule change makes older saves unplayable. A save made
// under other rules is refused instead of loading into a broken game.
export const RULES_VERSION = 4;

export function isCurrentRulesVersion(rawState) {
  return Number(rawState?.rulesVersion) === RULES_VERSION;
}

// Deals exist in the engine but have no screen yet, so they are off unless a
// caller (tests, future deal screen) turns them on.
export function isDealsEnabled(state) {
  return Boolean(state?.features?.deals);
}

export function makeRng(seed = Date.now(), initialState = null) {
  let s = initialState == null ? seed >>> 0 : initialState >>> 0;
  const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  rng.getState = () => s >>> 0;
  rng.setState = (nextState) => {
    s = nextState >>> 0;
  };
  return rng;
}

// Every gameplay roll must come from the seeded game RNG so matches replay
// identically. Fail loudly rather than silently falling back to Math.random.
export function requireRng(state) {
  if (typeof state?.rng !== 'function') {
    throw new Error('Game state is missing its seeded rng; gameplay randomness must use state.rng.');
  }
  return state.rng;
}

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function rollRange(min, max, rng) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pickWeightedInvasionTemplate(invasions, rng, emptyMessage) {
  const weightedInvasions = invasions
    .map((invasion) => ({
      invasion,
      weight: Math.max(0, Number(invasion.drawWeight) || 0),
    }))
    .filter(({ weight }) => weight > 0);
  const totalWeight = weightedInvasions.reduce((sum, { weight }) => sum + weight, 0);
  if (totalWeight <= 0) {
    throw new Error(emptyMessage);
  }

  const ticket = rng() * totalWeight;
  let cumulativeWeight = 0;
  for (const { invasion, weight } of weightedInvasions) {
    cumulativeWeight += weight;
    if (ticket < cumulativeWeight) return invasion;
  }
  return weightedInvasions[weightedInvasions.length - 1].invasion;
}

// `map` is a map id or a game state (data/maps).
export function pickInvasionTemplate(rng, map = null) {
  return pickWeightedInvasionTemplate(
    getMapInvasions(map),
    rng,
    'At least one invasion must have a positive draw weight.',
  );
}

export function pickTriggerableInvasionTemplate(state, rng) {
  return pickWeightedInvasionTemplate(
    getMapInvasions(state).filter((invasion) => canTriggerInvasion(state, invasion)),
    rng,
    'At least one triggerable invasion must have a positive draw weight.',
  );
}

const PLAYER_ROLE_TEXT_STYLES = {
  BASILEUS: { color: REGION_BORDER_COLORS[REGIONS.CPL], contrast: '#ffffff' },
  PATRIARCH: { color: '#000000', contrast: '#ffffff' },
  ADMIRAL: { color: REGION_BORDER_COLORS[REGIONS.SEA], contrast: '#ffffff' },
  DOM_EAST: { color: REGION_BORDER_COLORS[REGIONS.EAST], contrast: '#ffffff' },
  DOM_WEST: { color: REGION_BORDER_COLORS[REGIONS.WEST], contrast: '#ffffff' },
};

const PLAYER_ROLE_COLOR_PRIORITY = ['BASILEUS', 'PATRIARCH', 'ADMIRAL', 'DOM_EAST', 'DOM_WEST'];

// How far an invader comes from: the provinces on its route before
// Constantinople.
export function getInvasionReach(invasion) {
  return (Array.isArray(invasion?.route) ? invasion.route : []).filter((themeId) => themeId !== 'CPL').length;
}

// An invasion's strength is known as soon as it is drawn: the farther the
// invader comes from, the stronger it is, and the threat grows every round.
export function getInvasionStrength(invasion, state) {
  const balance = getBalance(state);
  const round = Math.max(1, Number(state?.round) || 1);
  const strength = getInvasionReach(invasion) * (Number(balance.INVASION_STRENGTH_PER_REACH) || 0)
    + round * (Number(balance.INVASION_STRENGTH_PER_ROUND) || 0);
  return Math.max(1, Math.round(strength));
}

// A copy of an invasion template; with a game state, it gets its strength
// for the current round. `strength` stays a [low, high] pair, both the same.
export function createInvasionInstance(template, rng, state = null) {
  const instance = {
    ...template,
    route: Array.isArray(template.route) ? template.route.slice() : [],
    originMarker: template.originMarker || null,
    strength: Array.isArray(template.strength) ? template.strength.slice() : template.strength,
  };
  if (!state) return instance;
  const strength = getInvasionStrength(instance, state);
  return { ...instance, reach: getInvasionReach(instance), strength: [strength, strength] };
}

export function prepareInvasionForDraw(state, invasion, rng) {
  return createInvasionInstance(invasion, rng, state);
}

function invasionRequiresImperialTarget(invasion) {
  return Boolean(invasion?.requiresImperialTarget)
    || invasion?.objective === INVASION_OBJECTIVES.PROVINCES;
}

export function hasImperialTargetOnInvasionRoute(state, invasion) {
  const route = Array.isArray(invasion?.route) ? invasion.route : [];
  return route.some((themeId) => {
    if (themeId === 'CPL') return false;
    const theme = state?.themes?.[themeId];
    return Boolean(theme && !theme.lost);
  });
}

export function canTriggerInvasion(state, invasion) {
  if (!invasion) return false;
  if (!invasionRequiresImperialTarget(invasion)) return true;
  return hasImperialTargetOnInvasionRoute(state, invasion);
}

export function rollInvasionStrength(invasion, rng) {
  const [estimateMin, estimateMax] = invasion?.strength || invasion?.strengthBounds || [1, 1];
  return rollRange(estimateMin, estimateMax, rng);
}

function createThemeState(province) {
  const hasEconomy = province.id !== 'CPL';
  const origin = {
    P: hasEconomy ? Math.max(0, Number(province.P) || 0) : 0,
    T: hasEconomy ? Math.max(0, Number(province.T) || 0) : 0,
    C: hasEconomy ? Math.max(0, Number(province.C) || 0) : 0,
  };
  return {
    id: province.id,
    name: province.name,
    ...(hasEconomy ? { P: origin.P, T: origin.T, C: origin.C } : {}),
    origin,
    region: province.region,
    cx: province.cx,
    cy: province.cy,
    // { [dynastyId]: { count, recent } } - see engine/estates.js
    estates: {},
    lost: Boolean(province.startLost),
    strategos: null,
    bishop: null,
  };
}

export function createGameState({
  playerCount = 5,
  turnCount: configuredTurnCount = null,
  deckSize = 9,
  seed,
  historyEnabled = false,
  features = null,
  mapId: requestedMapId = null,
} = {}) {
  const rng = makeRng(seed);
  const mapId = normalizeMapId(requestedMapId);
  const turnCount = Math.max(1, Math.floor(Number(configuredTurnCount ?? deckSize) || 9));
  const players = [];

  for (let i = 0; i < playerCount; i++) {
    const { name: dynasty, color } = getDynastyProfileForSeat(i);
    players.push({
      id: i,
      dynasty,
      color,
      gold: 0,
      majorTitles: [],
      minorTitles: [],
      orders: null,
      appointmentCooldown: {},
      revocationCooldown: {},
    });
  }

  const basileusIdx = Math.floor(rng() * playerCount);
  const nonBasileus = players.filter((p) => p.id !== basileusIdx).map((p) => p.id);
  const distribution = MAJOR_TITLE_DISTRIBUTION[playerCount];
  const shuffledTitles = shuffle(Object.keys(MAJOR_TITLES), rng);
  let titleIdx = 0;
  for (let pi = 0; pi < nonBasileus.length; pi++) {
    for (let t = 0; t < distribution[pi]; t++) {
      players[nonBasileus[pi]].majorTitles.push(shuffledTitles[titleIdx]);
      titleIdx++;
    }
  }

  const themes = Object.fromEntries(getMapProvinces(mapId).map((province) => [province.id, createThemeState(province)]));
  const deck = Array.from({ length: turnCount }, () => (
    createInvasionInstance(pickInvasionTemplate(rng, mapId), rng)
  ));

  return {
    rulesVersion: RULES_VERSION,
    mapId,
    features: { deals: Boolean(features?.deals) },
    rng,
    adjacency: buildMapAdjacency(mapId),
    historyEnabled,
    historySeq: 0,
    round: 0,
    maxRounds: turnCount,
    startingIncomeResolved: false,
    finalScoringPending: false,
    majorTitleRedistributionPending: false,
    phase: 'setup',

    basileusId: basileusIdx,
    nextBasileusId: basileusIdx,
    players,
    themes,

    invasionDeck: deck,
    currentInvasion: null,
    invasionStrength: 0,

    allOrders: {},
    currentTroops: {},
    lastIncome: null,
    mercenaryOrders: {},
    temporaryCapitalSupport: [],

    dealThreads: [],
    activeDealObligations: [],
    reservedGold: {},
    dealParticipantIds: [],
    dealThreadSeq: 0,
    dealObligationSeq: 0,
    estatePlans: {},
    estatesReady: {},

    lastCoupResult: null,
    lastWarResult: null,

    gameOver: null,
    log: [],
    history: historyEnabled ? [] : null,
  };
}

export function getPlayer(state, id) {
  return state.players.find((p) => p.id === id);
}

export function hasAppointmentTargetLock(state, appointerId, appointeeId) {
  if (!Number.isInteger(appointeeId)) return false;
  const player = getPlayer(state, appointerId);
  const lastAppointeeId = Number(player?.appointmentCooldown?.lastAppointeeId);
  if (Number.isInteger(lastAppointeeId) && lastAppointeeId === appointeeId) return true;
  return appointeeId === appointerId && Boolean(player?.appointmentCooldown?.selfLocked);
}

export function hasSelfAppointmentLock(state, playerId) {
  const player = getPlayer(state, playerId);
  return hasAppointmentTargetLock(state, playerId, playerId)
    || Boolean(player?.appointmentCooldown?.selfLocked);
}

export function recordAppointmentChoice(state, appointerId, appointeeId) {
  const player = getPlayer(state, appointerId);
  if (!player) return;
  if (!player.appointmentCooldown || typeof player.appointmentCooldown !== 'object') {
    player.appointmentCooldown = {};
  }
  player.appointmentCooldown.lastAppointeeId = appointeeId;
  player.appointmentCooldown.selfLocked = appointeeId === appointerId;
}

export function hasRevocationTargetLock(state, revokerId, targetPlayerId) {
  if (!Number.isInteger(targetPlayerId)) return false;
  const player = getPlayer(state, revokerId);
  return player?.revocationCooldown?.lastRevokedPlayerId === targetPlayerId;
}

export function recordRevocationChoice(state, revokerId, targetPlayerId) {
  if (!Number.isInteger(targetPlayerId)) return;
  const player = getPlayer(state, revokerId);
  if (!player) return;
  if (!player.revocationCooldown || typeof player.revocationCooldown !== 'object') {
    player.revocationCooldown = {};
  }
  player.revocationCooldown.lastRevokedPlayerId = targetPlayerId;
}

export function formatPlayerLabel(player) {
  if (!player) return '';
  const dynasty = player.dynasty || '';
  const label = player.firstName ? `${player.firstName} ${dynasty}`.trim() : dynasty;
  if (!player.isAIControlled) return label;
  // `aiTemperament` is display text set by the UI, such as "Usurper".
  return `${label} (${player.aiTemperament ? `${player.aiTemperament} AI` : 'AI'})`.trim();
}

// Name without the "(AI)" marker, for narrative history text.
export function getPlayerName(state, playerId) {
  const player = getPlayer(state, playerId);
  return player?.firstName ? `${player.firstName} ${player.dynasty}`.trim() : player?.dynasty || `Player ${Number(playerId) + 1}`;
}

export function getPlayerLabel(state, playerId, fallback = null) {
  const player = getPlayer(state, playerId);
  if (!player) return fallback ?? `Player ${Number(playerId) + 1}`;
  return formatPlayerLabel(player);
}

export function getNonBasileusPlayers(state) {
  return state.players.filter((p) => p.id !== state.basileusId);
}

export function getPlayerMajorTitle(state, playerId, titleKey) {
  return state.players.find((p) => p.id === playerId)?.majorTitles.includes(titleKey);
}

export function getThemesInRegion(state, region) {
  return Object.values(state.themes).filter((t) => t.region === region && t.id !== 'CPL');
}

export function getLostThemes(state) {
  return Object.values(state.themes).filter((t) => t.lost);
}

export function findTitleHolder(state, titleKey) {
  return state.players.find((p) => p.majorTitles.includes(titleKey))?.id ?? null;
}

export function getStrategosThemes(state, playerId) {
  return Object.values(state.themes).filter((t) => t.strategos === playerId && !t.lost);
}

export function getBishopThemes(state, playerId, options = {}) {
  const includeLost = Boolean(options.includeLost);
  return Object.values(state.themes).filter((t) => (
    t.bishop === playerId && (includeLost || !t.lost)
  ));
}

export function getOfficeDisplayName(state, officeKey) {
  if (officeKey === 'BASILEUS') return 'Basileus';
  if (MAJOR_TITLES[officeKey]) return MAJOR_TITLES[officeKey].name;
  if (String(officeKey).startsWith('STRAT_')) {
    const themeId = String(officeKey).replace('STRAT_', '');
    return `Strategos of ${state?.themes?.[themeId]?.name || themeId}`;
  }
  return officeKey;
}

export function getOfficeHolder(state, officeKey) {
  if (officeKey === 'BASILEUS') return state.basileusId;
  if (officeKey === 'DOM_EAST' || officeKey === 'DOM_WEST' || officeKey === 'ADMIRAL' || officeKey === 'PATRIARCH') {
    return findTitleHolder(state, officeKey);
  }
  if (String(officeKey).startsWith('STRAT_')) {
    const themeId = String(officeKey).replace('STRAT_', '');
    return state.themes[themeId]?.strategos ?? null;
  }
  return null;
}

export function getPlayerMercenaryOrder(state, playerId) {
  const order = state?.mercenaryOrders?.[playerId];
  return {
    count: Math.max(0, Number(order?.count) || 0),
    destination: order?.destination === 'capital' ? 'capital' : 'frontier',
  };
}

export function getPlayerPrimaryRoleKey(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return null;
  if (playerId === state.basileusId) return 'BASILEUS';
  return PLAYER_ROLE_COLOR_PRIORITY.find((roleKey) => player.majorTitles.includes(roleKey)) || null;
}

export function getPlayerRoleTextStyle(state, playerId) {
  const roleKey = getPlayerPrimaryRoleKey(state, playerId);
  return roleKey ? PLAYER_ROLE_TEXT_STYLES[roleKey] : { color: '#2f2215', contrast: '#ffffff' };
}
