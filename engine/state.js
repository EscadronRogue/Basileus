// engine/state.js - game state initialization and shared lookups.
import { PROVINCES, buildAdjacency, REGION_BORDER_COLORS, REGIONS } from '../data/provinces.js';
import { INVASIONS, DYNASTIES, DYNASTY_COLORS, INVASION_STRENGTH_RANGE, INVASION_ESTIMATE_INTERVAL } from '../data/invasions.js';
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';

export function makeRng(seed = Date.now(), initialState = null) {
  let s = initialState == null ? seed >>> 0 : initialState >>> 0;
  const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  rng.getState = () => s >>> 0;
  rng.setState = (nextState) => {
    s = nextState >>> 0;
  };
  return rng;
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

const PLAYER_ROLE_TEXT_STYLES = {
  BASILEUS: { color: REGION_BORDER_COLORS[REGIONS.CPL], contrast: '#ffffff' },
  PATRIARCH: { color: '#000000', contrast: '#ffffff' },
  ADMIRAL: { color: REGION_BORDER_COLORS[REGIONS.SEA], contrast: '#ffffff' },
  DOM_EAST: { color: REGION_BORDER_COLORS[REGIONS.EAST], contrast: '#ffffff' },
  DOM_WEST: { color: REGION_BORDER_COLORS[REGIONS.WEST], contrast: '#ffffff' },
};

const PLAYER_ROLE_COLOR_PRIORITY = ['BASILEUS', 'PATRIARCH', 'ADMIRAL', 'DOM_EAST', 'DOM_WEST'];

function createInvasionStrengthRange(rng) {
  const [baseMin, baseMax] = INVASION_STRENGTH_RANGE;
  if (baseMax - baseMin < INVASION_ESTIMATE_INTERVAL) {
    throw new Error('Invasion strength bounds must be at least as wide as the estimate interval.');
  }
  const estimateMin = rollRange(baseMin, baseMax - INVASION_ESTIMATE_INTERVAL, rng);
  return [estimateMin, estimateMin + INVASION_ESTIMATE_INTERVAL];
}

function createInvasionInstance(template, rng) {
  return {
    ...template,
    route: Array.isArray(template.route) ? template.route.slice() : [],
    originMarker: template.originMarker || null,
    strength: createInvasionStrengthRange(rng),
  };
}

export function rollInvasionStrength(invasion, rng) {
  const [estimateMin, estimateMax] = invasion?.strength || [1, 1];
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
    owner: null,
    suspendedOwner: null,
    occupied: Boolean(province.startOccupied),
    strategos: null,
    bishop: null,
    bishopIsDonor: false,
  };
}

export function createGameState({ playerCount = 4, deckSize = 9, seed, historyEnabled = false } = {}) {
  const rng = makeRng(seed);
  const dynastyPool = shuffle(DYNASTIES, rng);
  const players = [];

  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: i,
      dynasty: dynastyPool[i],
      color: DYNASTY_COLORS[i % DYNASTY_COLORS.length],
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

  const themes = Object.fromEntries(PROVINCES.map((province) => [province.id, createThemeState(province)]));
  const deck = Array.from({ length: deckSize }, () => (
    createInvasionInstance(INVASIONS[Math.floor(rng() * INVASIONS.length)], rng)
  ));

  return {
    rng,
    adjacency: buildAdjacency(),
    historyEnabled,
    historySeq: 0,
    round: 0,
    maxRounds: deck.length,
    startingIncomeResolved: false,
    phase: 'setup',

    basileusId: basileusIdx,
    nextBasileusId: basileusIdx,
    players,
    themes,

    empress: null,
    chiefEunuchs: null,

    invasionDeck: deck,
    currentInvasion: null,
    invasionStrength: 0,

    allOrders: {},
    currentTroops: {},
    mercenaryOrders: {},

    dealThreads: [],
    activeDealObligations: [],
    reservedGold: {},
    dealParticipantIds: [],
    dealThreadSeq: 0,
    dealObligationSeq: 0,
    landAuctions: {},

    lastCoupResult: null,
    lastWarResult: null,
    pendingDefenderRewards: [],

    gameOver: null,
    log: [],
    history: historyEnabled ? [] : null,
  };
}

export function getPlayer(state, id) {
  return state.players.find((p) => p.id === id);
}

export function hasSelfAppointmentLock(state, playerId) {
  const player = getPlayer(state, playerId);
  return Boolean(player?.appointmentCooldown?.selfLocked);
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
  return player.isAIControlled ? `${label} (AI)`.trim() : label;
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

export function getPlayerThemes(state, playerId) {
  return Object.values(state.themes).filter((t) => t.owner === playerId);
}

export function getChurchThemes(state) {
  return Object.values(state.themes).filter((t) => t.owner === 'church');
}

export function getOccupiedThemes(state) {
  return Object.values(state.themes).filter((t) => t.occupied);
}

export function getFreeThemes(state) {
  return Object.values(state.themes).filter((t) => !t.occupied && t.owner === null && t.id !== 'CPL');
}

export function findTitleHolder(state, titleKey) {
  return state.players.find((p) => p.majorTitles.includes(titleKey))?.id ?? null;
}

export function getStrategosThemes(state, playerId) {
  return Object.values(state.themes).filter((t) => t.strategos === playerId && !t.occupied);
}

export function getBishopThemes(state, playerId, options = {}) {
  const includeOccupied = Boolean(options.includeOccupied);
  return Object.values(state.themes).filter((t) => (
    t.bishop === playerId && (includeOccupied || !t.occupied)
  ));
}

export function getOfficeDisplayName(state, officeKey) {
  if (officeKey === 'BASILEUS') return 'Basileus';
  if (MAJOR_TITLES[officeKey]) return MAJOR_TITLES[officeKey].name;
  if (officeKey === 'EMPRESS') return 'Empress';
  if (officeKey === 'CHIEF_EUNUCHS') return 'Chief of Eunuchs';
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
  if (officeKey === 'EMPRESS') return state.empress ?? null;
  if (officeKey === 'CHIEF_EUNUCHS') return state.chiefEunuchs ?? null;
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
