import { getMercenaryOrderCost } from './rules.js';

const NON_PUBLIC_STATE_KEYS = [
  'rng',
  'adjacency',
  'invasionDeck',
  'log',
  'mercenariesHiredThisRound',
];

export function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

export function serializeCourtActions(courtActions = null) {
  if (!courtActions) return null;
  return {
    ...courtActions,
    playerConfirmed: [...(courtActions.playerConfirmed || new Set())],
  };
}

export function hydrateCourtActions(courtActions = null) {
  if (!courtActions) return null;
  return {
    ...courtActions,
    playerConfirmed: new Set(courtActions.playerConfirmed || []),
  };
}

export function serializeCurrentInvasion(invasion) {
  if (!invasion) return null;
  return {
    ...clonePlain(invasion),
    route: Array.isArray(invasion.route) ? invasion.route.slice() : [],
    strength: Array.isArray(invasion.strength) ? invasion.strength.slice() : [],
    baseStrength: Array.isArray(invasion.baseStrength) ? invasion.baseStrength.slice() : [],
  };
}

export function serializePlayersForViewer(state, viewerSeatId) {
  return state.players.map((player) => {
    const hiddenSpend = state.phase === 'orders' && viewerSeatId !== player.id
      ? getMercenaryOrderCost(state.allOrders?.[player.id]?.mercenaries || [])
      : 0;
    return {
      ...clonePlain(player),
      gold: player.gold + hiddenSpend,
    };
  });
}

export function sanitizePublicHistory(state) {
  const history = Array.isArray(state.history) ? state.history : [];
  const currentRound = state.round;
  const inHiddenOrdersWindow = state.phase === 'orders';
  const sanitized = [];

  for (const event of history) {
    if (event?.type === 'hire_mercenaries' && inHiddenOrdersWindow && event.round === currentRound) {
      continue;
    }

    const nextEvent = {
      ...clonePlain(event),
      decision: null,
    };

    if (nextEvent.type === 'orders_submitted') {
      nextEvent.details = null;
      nextEvent.summary = `${nextEvent.summary || ''}`.trim() || 'Secret orders are sealed.';
    }

    sanitized.push(nextEvent);
  }

  return sanitized;
}

export function serializeSubmittedOrders(state) {
  return Object.fromEntries(Object.keys(state.allOrders || {}).map((playerId) => [playerId, true]));
}

export function serializePublicGameState(state, viewerSeatId = null) {
  const publicState = clonePlain(state) || {};
  for (const key of NON_PUBLIC_STATE_KEYS) delete publicState[key];

  publicState.historyEnabled = true;
  publicState.players = serializePlayersForViewer(state, viewerSeatId);
  publicState.themes = clonePlain(state.themes || {});
  publicState.currentInvasion = serializeCurrentInvasion(state.currentInvasion);
  publicState.currentLevies = clonePlain(state.currentLevies || {});
  publicState.allOrders = serializeSubmittedOrders(state);
  publicState.lastCoupResult = clonePlain(state.lastCoupResult);
  publicState.lastWarResult = clonePlain(state.lastWarResult);
  publicState.gameOver = clonePlain(state.gameOver);
  publicState.history = sanitizePublicHistory(state);
  publicState.courtActions = serializeCourtActions(state.courtActions);
  publicState.recruitedThisRound = clonePlain(state.recruitedThisRound || {});
  publicState.pendingTitleReassignment = Boolean(state.pendingTitleReassignment)
    || state.nextBasileusId !== state.basileusId;

  return publicState;
}

export function hydratePublicState(rawState = {}) {
  return {
    ...rawState,
    historyEnabled: true,
    history: Array.isArray(rawState.history) ? rawState.history : [],
    players: Array.isArray(rawState.players) ? rawState.players : [],
    themes: rawState.themes && typeof rawState.themes === 'object' ? rawState.themes : {},
    currentLevies: rawState.currentLevies && typeof rawState.currentLevies === 'object' ? rawState.currentLevies : {},
    allOrders: rawState.allOrders && typeof rawState.allOrders === 'object' ? rawState.allOrders : {},
    recruitedThisRound: rawState.recruitedThisRound && typeof rawState.recruitedThisRound === 'object'
      ? rawState.recruitedThisRound
      : {},
    courtActions: hydrateCourtActions(rawState.courtActions),
  };
}
