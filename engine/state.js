// engine/state.js — Game state initialization and core state structure
import { PROVINCES, buildAdjacency, REGION_BORDER_COLORS, REGIONS } from '../data/provinces.js';
import { INVASIONS, DYNASTIES, DYNASTY_COLORS, INVASION_STRENGTH_RANGE, INVASION_ESTIMATE_INTERVAL } from '../data/invasions.js';
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';

export const MERCENARY_COMPANY_KEY = 'MERCENARY_COMPANY';

// ─── Seeded RNG ───
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
  PATRIARCH:{ color: '#000000', contrast: '#ffffff' },
  ADMIRAL:  { color: REGION_BORDER_COLORS[REGIONS.SEA], contrast: '#ffffff' },
  DOM_EAST: { color: REGION_BORDER_COLORS[REGIONS.EAST], contrast: '#ffffff' },
  DOM_WEST: { color: REGION_BORDER_COLORS[REGIONS.WEST], contrast: '#ffffff' },
};

// A player may hold multiple major titles in 3-4 player games. The first matching
// entry is used as the public outline color in the interface. Patriarch is placed
// before regional military commands so a Patriarch holder gets the requested black
// outline even when they also hold another major office.
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

function countAvailableThemes(themes, predicate = () => true) {
  return Object.values(themes).filter((theme) => !theme.occupied && theme.id !== 'CPL' && predicate(theme)).length;
}

export function isMercenaryCompanyOfficeKey(officeKey) {
  return officeKey === MERCENARY_COMPANY_KEY;
}

export function getOfficeDisplayName(state, officeKey) {
  if (officeKey === MERCENARY_COMPANY_KEY) return 'Mercenary Company';
  if (officeKey === 'BASILEUS') return 'Basileus';
  if (MAJOR_TITLES[officeKey]) return MAJOR_TITLES[officeKey].name;
  if (String(officeKey).startsWith('STRAT_')) {
    const themeId = String(officeKey).replace('STRAT_', '');
    return `Strategos of ${state?.themes?.[themeId]?.name || themeId}`;
  }
  return officeKey;
}

// ─── Initial State Factory ───
export function createGameState({ playerCount = 4, deckSize = 9, seed, historyEnabled = false } = {}) {
  const rng = makeRng(seed);
  const adj = buildAdjacency();

  // Pick dynasties
  const dynastyPool = shuffle(DYNASTIES, rng);
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: i,
      dynasty: dynastyPool[i],
      color: DYNASTY_COLORS[i % DYNASTY_COLORS.length],
      gold: 0,
      // Titles held — list of title keys
      majorTitles: [],
      minorTitles: [],   // { type, themeId? }
      // Professional armies per office: { officeKey: count }
      professionalArmies: {},
      // Secret orders (filled during Orders phase)
      orders: null,
      // Tracks whether this player's latest appointment was to themselves.
      appointmentCooldown: {},
      // Tracks the last player this dynasty revoked, to prevent repeat targeting.
      revocationCooldown: {},
    });
  }

  // Randomly designate Basileus
  const basileusIdx = Math.floor(rng() * playerCount);
  // Build provinces state
  const themes = {};
  for (const p of PROVINCES) {
    themes[p.id] = {
      id: p.id,
      name: p.name,
      P: p.P,
      T: p.T,
      L: p.L,
      C: Number(p.C) || 0,   // Church contribution: 1 gold per point to the church pool
      region: p.region,
      cx: p.cx,
      cy: p.cy,
      owner: null,           // null = free citizens, playerId = player, 'church' = church
      occupied: !!p.startOccupied,
      strategos: null,       // playerId or null
      bishop: null,          // playerId or null
      bishopIsDonor: false,  // true if set by church donation (kept for legacy/UI; no protection)
      privateLevyReduced: false, // true once private acquisition has reduced provincial levy by 1
    };
  }

  // Distribute major titles to non-Basileus players
  const nonBasileus = players.filter(p => p.id !== basileusIdx).map(p => p.id);
  const distribution = MAJOR_TITLE_DISTRIBUTION[playerCount];
  const titleKeys = Object.keys(MAJOR_TITLES); // DOM_EAST, DOM_WEST, ADMIRAL, PATRIARCH
  const shuffledTitles = shuffle(titleKeys, rng);
  let titleIdx = 0;
  for (let pi = 0; pi < nonBasileus.length; pi++) {
    const count = distribution[pi];
    for (let t = 0; t < count; t++) {
      players[nonBasileus[pi]].majorTitles.push(shuffledTitles[titleIdx]);
      titleIdx++;
    }
  }

  const startingOfficeTroops = {
    BASILEUS: 2,
    DOM_EAST: 2,
    DOM_WEST: 2,
    ADMIRAL: 2,
  };

  if (startingOfficeTroops.BASILEUS > 0) {
    players[basileusIdx].professionalArmies.BASILEUS = startingOfficeTroops.BASILEUS;
  }

  for (const player of players) {
    for (const titleKey of player.majorTitles) {
      const troopCount = startingOfficeTroops[titleKey] || 0;
      if (troopCount > 0) {
        player.professionalArmies[titleKey] = troopCount;
      }
    }
  }

  // Build invasion deck by sampling with replacement so repeated invasions
  // remain possible and some invaders may never appear in a given game.
  const deck = Array.from({ length: deckSize }, () => (
    createInvasionInstance(INVASIONS[Math.floor(rng() * INVASIONS.length)], rng)
  ));

  return {
    rng,
    adjacency: adj,
    historyEnabled,
    historySeq: 0,
    round: 0,
    maxRounds: deck.length,
    startingAdministrationResolved: false,
    phase: 'setup',   // setup → invasion → administration → court → orders → resolution → cleanup

    basileusId: basileusIdx,
    nextBasileusId: basileusIdx,
    players,
    themes,

    // Court titles
    empress: null,        // playerId
    chiefEunuchs: null,   // playerId

    // Bishop seniority — ordered list of { themeId, playerId } in appointment order.
    // The first entry is the most senior bishop. Used by the church cascade.
    bishopAppointments: [],

    // Invasion state
    invasionDeck: deck,
    currentInvasion: null,
    invasionStrength: 0,

    // Orders (filled during orders phase)
    // Each player's orders: { deployments: { officeKey: 'capital'|'frontier' }, candidate: playerId }
    allOrders: {},
    currentMercenaryTroops: {},
    pendingProfessionalArmies: {},

    // Formal court deals (private to participating dynasties)
    dealThreads: [],
    activeDealObligations: [],
    reservedGold: {},
    dealParticipantIds: [],
    dealThreadSeq: 0,
    dealObligationSeq: 0,
    landAuctions: {},

    // Resolution results (for animation/display)
    lastCoupResult: null,
    lastWarResult: null,
    pendingDefenderRewards: [],

    // Game over
    gameOver: null,    // null | { type: 'victory', winner } | { type: 'fall' }

    // History log
    log: [],
    history: historyEnabled ? [] : null,
  };
}

// ─── Utility getters ───
export function getPlayer(state, id) {
  return state.players.find(p => p.id === id);
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

// Returns "FirstName Dynasty" if the player has a first name attached, else just the dynasty.
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
  return state.players.filter(p => p.id !== state.basileusId);
}

export function getPlayerMajorTitle(state, playerId, titleKey) {
  return state.players.find(p => p.id === playerId)?.majorTitles.includes(titleKey);
}

export function getThemesInRegion(state, region) {
  return Object.values(state.themes).filter(t => t.region === region && t.id !== 'CPL');
}

export function getPlayerThemes(state, playerId) {
  return Object.values(state.themes).filter(t => t.owner === playerId);
}

export function getPlayerMercenaryTroops(state, playerId) {
  return Math.max(0, Number(state.currentMercenaryTroops?.[playerId]) || 0);
}

export function getPlayerMercenaryAssignments(state, playerId) {
  const count = getPlayerMercenaryTroops(state, playerId);
  return count > 0 ? [{ officeKey: MERCENARY_COMPANY_KEY, count }] : [];
}

export function getOfficeMercenaryCount(state, playerId, officeKey) {
  return isMercenaryCompanyOfficeKey(officeKey) ? getPlayerMercenaryTroops(state, playerId) : 0;
}

export function getPlayerMercenaryTotal(state, playerId) {
  return getPlayerMercenaryTroops(state, playerId);
}

export function getOfficeHolder(state, officeKey) {
  if (officeKey === MERCENARY_COMPANY_KEY) return null;
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

function ensurePendingProfessionalArmies(state) {
  if (!state.pendingProfessionalArmies || typeof state.pendingProfessionalArmies !== 'object') {
    state.pendingProfessionalArmies = {};
  }
  return state.pendingProfessionalArmies;
}

export function getPendingProfessionalCount(state, playerId, officeKey) {
  return Math.max(0, Number(state?.pendingProfessionalArmies?.[playerId]?.[officeKey]) || 0);
}

export function getPlayerPendingProfessionalTotal(state, playerId) {
  const pending = state?.pendingProfessionalArmies?.[playerId];
  if (!pending || typeof pending !== 'object') return 0;
  return Object.values(pending).reduce((total, count) => total + Math.max(0, Number(count) || 0), 0);
}

export function addPendingProfessionalArmies(state, playerId, officeKey, count) {
  const normalizedCount = Math.max(0, Number(count) || 0);
  if (!Number.isInteger(playerId) || !officeKey || normalizedCount <= 0) return 0;
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  const pending = ensurePendingProfessionalArmies(state);
  if (!pending[playerId]) pending[playerId] = {};
  pending[playerId][officeKey] = (Number(pending[playerId][officeKey]) || 0) + normalizedCount;
  return normalizedCount;
}

export function extractPendingOfficeArmies(state, officeKey) {
  const pending = ensurePendingProfessionalArmies(state);
  let total = 0;
  for (const [playerId, offices] of Object.entries(pending)) {
    const count = Math.max(0, Number(offices?.[officeKey]) || 0);
    if (count <= 0) continue;
    total += count;
    delete offices[officeKey];
    if (Object.keys(offices).length === 0) delete pending[playerId];
  }
  return total;
}

export function clearPendingOfficeArmies(state, officeKey) {
  extractPendingOfficeArmies(state, officeKey);
}

export function activatePendingProfessionalArmies(state) {
  const pending = ensurePendingProfessionalArmies(state);
  const activated = [];
  for (const [playerIdText, offices] of Object.entries(pending)) {
    const playerId = Number(playerIdText);
    const player = getPlayer(state, playerId);
    if (!player || !offices || typeof offices !== 'object') continue;
    for (const [officeKey, countValue] of Object.entries(offices)) {
      const count = Math.max(0, Number(countValue) || 0);
      if (count <= 0) continue;
      if (getOfficeHolder(state, officeKey) !== playerId) continue;
      player.professionalArmies[officeKey] = (player.professionalArmies[officeKey] || 0) + count;
      activated.push({ playerId, officeKey, count });
    }
  }
  state.pendingProfessionalArmies = {};
  return activated;
}

export function getChurchThemes(state) {
  return Object.values(state.themes).filter(t => t.owner === 'church');
}

export function getOccupiedThemes(state) {
  return Object.values(state.themes).filter(t => t.occupied);
}

export function getFreeThemes(state) {
  return Object.values(state.themes).filter(t => !t.occupied && t.owner === null && t.id !== 'CPL');
}

export function findTitleHolder(state, titleKey) {
  return state.players.find(p => p.majorTitles.includes(titleKey))?.id ?? null;
}

export function getStrategosThemes(state, playerId) {
  return Object.values(state.themes).filter(t => t.strategos === playerId && !t.occupied);
}

export function getBishopThemes(state, playerId) {
  return Object.values(state.themes).filter(t => t.bishop === playerId && !t.occupied);
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

// Note: cartouche/CSS-variable plumbing for player names lives in
// ui/labels.js (single source of truth for the player+province visual
// language). state.js exposes only the data lookups above.
