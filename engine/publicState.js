const NON_PUBLIC_STATE_KEYS = [
  'rng',
  'adjacency',
  'invasionDeck',
  'log',
  'dealThreads',
  'activeDealObligations',
  'reservedGold',
  'dealParticipantIds',
  'dealThreadSeq',
  'dealObligationSeq',
  'landAuctionTieBreakers',
];

export function clonePlain(value) {
  if (value == null) return value;
  // structuredClone preserves Sets/Maps/Dates and avoids the silent
  // data loss of the JSON round-trip. Fall back to the JSON path only
  // for the unusual case of a value structuredClone refuses.
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
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
  return state.players.map((player) => clonePlain(player));
}

export function sanitizePublicHistory(state) {
  const history = Array.isArray(state.history) ? state.history : [];
  const sanitized = [];

  for (const event of history) {
    const nextEvent = {
      ...clonePlain(event),
      decision: null,
    };

    if (nextEvent.type === 'orders_submitted') {
      nextEvent.details = null;
      nextEvent.summary = `${nextEvent.summary || ''}`.trim() || 'Deployment orders are sealed.';
    }

    sanitized.push(nextEvent);
  }

  return sanitized;
}

export function serializeSubmittedOrders(state) {
  return Object.fromEntries(Object.keys(state.allOrders || {}).map((playerId) => [playerId, true]));
}

function getLandAuctionBidEntries(auction = null) {
  if (!auction || typeof auction !== 'object') return [];
  if (auction.bids && typeof auction.bids === 'object') {
    return Object.entries(auction.bids)
      .map(([playerId, bid]) => ({
        bidderId: Number(bid?.bidderId ?? playerId),
        amount: Number(bid?.amount),
        round: bid?.round,
      }))
      .filter((bid) => Number.isInteger(bid.bidderId) && Number.isFinite(bid.amount) && bid.amount > 0)
      .sort((left, right) => left.bidderId - right.bidderId);
  }
  const bidderId = Number(auction.bidderId);
  const amount = Number(auction.amount);
  return Number.isInteger(bidderId) && Number.isFinite(amount) && amount > 0
    ? [{ bidderId, amount, round: auction.round }]
    : [];
}

export function serializeLandAuctionsForViewer(state, viewerSeatId = null) {
  const viewerId = Number(viewerSeatId);
  const includeOwnBid = Number.isInteger(viewerId);
  const auctions = {};
  for (const [themeId, auction] of Object.entries(state.landAuctions || {})) {
    const ownBid = includeOwnBid
      ? getLandAuctionBidEntries(auction).find((bid) => bid.bidderId === viewerId)
      : null;
    auctions[themeId] = {
      themeId,
      round: auction?.round ?? state.round,
      sealed: true,
      bids: ownBid
        ? { [viewerId]: { bidderId: viewerId, amount: ownBid.amount, round: ownBid.round ?? state.round } }
        : {},
    };
  }
  return auctions;
}

export function serializePublicGameState(state, viewerSeatId = null) {
  const publicState = clonePlain(state) || {};
  for (const key of NON_PUBLIC_STATE_KEYS) delete publicState[key];

  publicState.historyEnabled = true;
  publicState.players = serializePlayersForViewer(state, viewerSeatId);
  publicState.themes = clonePlain(state.themes || {});
  publicState.currentInvasion = serializeCurrentInvasion(state.currentInvasion);
  publicState.currentTroops = clonePlain(state.currentTroops || {});
  publicState.allOrders = serializeSubmittedOrders(state);
  publicState.lastCoupResult = clonePlain(state.lastCoupResult);
  publicState.lastWarResult = clonePlain(state.lastWarResult);
  publicState.gameOver = clonePlain(state.gameOver);
  publicState.history = sanitizePublicHistory(state);
  publicState.courtActions = serializeCourtActions(state.courtActions);
  publicState.mercenaryOrders = clonePlain(state.mercenaryOrders || {});
  publicState.landAuctions = serializeLandAuctionsForViewer(state, viewerSeatId);

  return publicState;
}

export function hydratePublicState(rawState = {}) {
  return {
    ...rawState,
    historyEnabled: true,
    history: Array.isArray(rawState.history) ? rawState.history : [],
    players: Array.isArray(rawState.players) ? rawState.players : [],
    themes: rawState.themes && typeof rawState.themes === 'object' ? rawState.themes : {},
    currentTroops: rawState.currentTroops && typeof rawState.currentTroops === 'object' ? rawState.currentTroops : {},
    mercenaryOrders: rawState.mercenaryOrders && typeof rawState.mercenaryOrders === 'object' ? rawState.mercenaryOrders : {},
    allOrders: rawState.allOrders && typeof rawState.allOrders === 'object' ? rawState.allOrders : {},
    courtActions: hydrateCourtActions(rawState.courtActions),
  };
}
