// engine/state.js — Game state initialization and core state structure
import { PROVINCES, buildAdjacency, REGION_BORDER_COLORS, REGIONS } from '../data/provinces.js';
import { INVASIONS, DYNASTIES, DYNASTY_COLORS, INVASION_STRENGTH_RANGE, INVASION_ESTIMATE_INTERVAL } from '../data/invasions.js';
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';

// ─── Seeded RNG ───
export function makeRng(seed = Date.now()) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
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
    originPointId: template.originPointId || null,
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
      // Track self-appointment cooldown: { slotKey: lastRoundAppointed }
      appointmentCooldown: {},
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
      region: p.region,
      cx: p.cx,
      cy: p.cy,
      owner: null,           // null = free citizens, playerId = player, 'church' = church
      occupied: !!p.startOccupied,
      taxExempt: false,
      strategos: null,       // playerId or null
      bishop: null,          // playerId or null
      bishopIsDonor: false,  // true if set by church donation (protected)
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
    phase: 'setup',   // setup → invasion → administration → court → orders → resolution → cleanup

    basileusId: basileusIdx,
    nextBasileusId: basileusIdx,
    players,
    themes,

    // Court titles
    empress: null,        // playerId
    chiefEunuchs: null,   // playerId

    // Invasion state
    invasionDeck: deck,
    currentInvasion: null,
    invasionStrength: 0,

    // Orders (filled during orders phase)
    // Each player's orders: { deployments: { officeKey: 'capital'|'frontier' }, mercenaries: [{officeKey, count}], candidate: playerId }
    allOrders: {},
    mercenariesHiredThisRound: {},

    // Resolution results (for animation/display)
    lastCoupResult: null,
    lastWarResult: null,

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

// Returns "FirstName Dynasty" if the player has a first name attached, else just the dynasty.
export function formatPlayerLabel(player) {
  if (!player) return '';
  const dynasty = player.dynasty || '';
  if (player.firstName) {
    return `${player.firstName} ${dynasty}`.trim();
  }
  return dynasty;
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
