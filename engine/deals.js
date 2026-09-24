// engine/deals.js - public API for formal deals between dynasties.
//
// The implementation lives in engine/deals/:
//   state.js       constants, deal state, participants, shared helpers
//   clauses.js     clause normalisation, validation, and summaries
//   troopLocks.js  deployment locks owed under troop clauses
//   obligations.js accepted obligations, gold/estate settlement, promises
//   threads.js     offer threads: preview, send, counter, accept, refuse

export {
  DEAL_THREAD_STATUS,
  DEAL_TRIGGER_TYPES,
  DEAL_CLAUSE_KINDS,
  ensureDealState,
  setDealParticipantIds,
  getDealParticipantIds,
  getSpendableGold,
} from './deals/state.js';
export {
  isThemeReservedByDeal,
  isPlayerProtectedFromRevocation,
  validateAppointmentPromiseChoice,
  consumeAppointmentPromise,
  startCourtDealRound,
  finalizeDealRound,
} from './deals/obligations.js';
export { buildOrderLocksForPlayer, normalizeOrdersWithDealLocks } from './deals/troopLocks.js';
export {
  autoRefuseAwaitingDeals,
  previewDealOffer,
  sendDealOffer,
  counterDealOffer,
  acceptDealOffer,
  refuseDealOffer,
  getIncomingDealsForPlayer,
  getOutgoingDealsForPlayer,
  respondToDeal,
  buildPrivateDealView,
} from './deals/threads.js';
export { summarizeDealClause, summarizeDealOfferImpact } from './deals/clauses.js';
