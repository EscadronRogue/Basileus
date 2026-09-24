// engine/deals/threads.js - negotiation threads between two dynasties and their private views.

import { getPlayerLabel } from '../state.js';
import {
  normalizeDealClauses,
  summarizeDealOfferImpact,
  validateDealClausesAgainstState,
  validateDealParticipants,
} from './clauses.js';
import { acceptOfferIntoObligations } from './obligations.js';
import {
  DEAL_THREAD_STATUS,
  clonePlain,
  ensureDealState,
  fail,
  filterActiveObligations,
  getDealParticipantIds,
  toInt,
  uniqueInts,
} from './state.js';
import { buildOrderLocksForPlayer } from './troopLocks.js';

function makePairKey(playerAId, playerBId) {
  return [Number(playerAId), Number(playerBId)].sort((left, right) => left - right).join(':');
}

function getThreadByPairKey(state, pairKey) {
  ensureDealState(state);
  return state.dealThreads.find((thread) => thread.pairKey === pairKey) || null;
}

function getThreadById(state, threadId) {
  ensureDealState(state);
  return state.dealThreads.find((thread) => thread.id === threadId) || null;
}

function nextThreadId(state) {
  ensureDealState(state);
  state.dealThreadSeq = (Number(state.dealThreadSeq) || 0) + 1;
  return `deal-thread-${state.dealThreadSeq}`;
}

function nextRevision(thread) {
  return Math.max(0, Number(thread?.revision) || 0) + 1;
}

function buildThreadHistoryEntry(state, type, actorId, revision, offer = null, extra = {}) {
  return {
    type,
    actorId,
    actorName: getPlayerLabel(state, actorId),
    revision,
    round: state.round,
    phase: state.phase,
    offer: offer ? clonePlain(offer) : null,
    ...clonePlain(extra),
  };
}

function createThreadOffer(state, proposerId, counterpartyId, revision, clauses) {
  return {
    proposerId,
    proposerName: getPlayerLabel(state, proposerId),
    counterpartyId,
    counterpartyName: getPlayerLabel(state, counterpartyId),
    revision,
    round: state.round,
    clauses: clonePlain(clauses),
  };
}

function ensureThreadForPair(state, actorId, counterpartyId) {
  const pairKey = makePairKey(actorId, counterpartyId);
  let thread = getThreadByPairKey(state, pairKey);
  if (!thread) {
    thread = {
      id: nextThreadId(state),
      pairKey,
      playerIds: uniqueInts([actorId, counterpartyId]),
      status: DEAL_THREAD_STATUS.REFUSED,
      revision: 0,
      awaitingPlayerId: null,
      currentOffer: null,
      history: [],
    };
    state.dealThreads.push(thread);
  }
  return thread;
}

function enforceRevision(thread, expectedRevision) {
  const normalized = expectedRevision == null ? null : Number(expectedRevision);
  if (normalized == null) return { ok: true };
  if (Number(thread.revision) !== normalized) {
    return fail('This deal thread changed before your action could be applied. Refresh the court panel and try again.');
  }
  return { ok: true };
}

function getOpposingPlayerId(thread, actorId) {
  return thread.playerIds.find((playerId) => playerId !== actorId) ?? null;
}

function isPlayerConfirmedForDeals(state, playerId) {
  return Boolean(state.courtActions?.playerConfirmed?.has(playerId));
}

function finalizeThreadState(state, thread, status, actorId, extra = {}) {
  thread.status = status;
  if (status !== DEAL_THREAD_STATUS.OPEN) {
    thread.awaitingPlayerId = null;
  }
  thread.history.push(buildThreadHistoryEntry(
    state,
    extra.type || status,
    actorId,
    thread.revision,
    thread.currentOffer,
    extra,
  ));
}

export function autoRefuseAwaitingDeals(state, playerId) {
  ensureDealState(state);
  for (const thread of state.dealThreads) {
    if (thread.status !== DEAL_THREAD_STATUS.OPEN) continue;
    if (thread.awaitingPlayerId !== playerId) continue;
    finalizeThreadState(state, thread, DEAL_THREAD_STATUS.REFUSED, playerId, {
      type: 'auto_refused',
      reason: 'court_confirmed',
    });
  }
}

export function previewDealOffer(state, actorId, payload = {}, options = {}) {
  ensureDealState(state);
  if (state.phase !== 'court') return fail('Deals may only be negotiated during the Court phase.');
  if (isPlayerConfirmedForDeals(state, actorId)) return fail('You already confirmed court actions this round.');

  const mode = options.mode || (payload.threadId ? 'counter' : 'send');
  let thread = null;
  let counterpartyId = null;
  let pairKey = null;
  let revision = 0;
  let participantsValidated = false;

  if (mode === 'counter') {
    thread = getThreadById(state, String(payload.threadId || '').trim());
    if (!thread) return fail('That deal thread does not exist anymore.');
    if (thread.status !== DEAL_THREAD_STATUS.OPEN) return fail('That deal is already closed.');
    if (thread.awaitingPlayerId !== actorId) return fail('Only the dynasty currently holding the offer may counter it.');
    const revisionCheck = enforceRevision(thread, payload.expectedRevision);
    if (!revisionCheck.ok) return revisionCheck;
    counterpartyId = getOpposingPlayerId(thread, actorId);
    pairKey = thread.pairKey;
    revision = nextRevision(thread);
  } else {
    counterpartyId = toInt(payload.counterpartyId, null);
    const participantCheck = validateDealParticipants(state, actorId, counterpartyId);
    if (!participantCheck.ok) return participantCheck;
    participantsValidated = true;
    pairKey = makePairKey(actorId, counterpartyId);
    thread = getThreadByPairKey(state, pairKey);
    if (thread?.status === DEAL_THREAD_STATUS.OPEN) {
      return fail('That deal thread is still open. Counter, accept, or refuse it first.');
    }
    const revisionCheck = enforceRevision(thread || { revision: 0 }, payload.expectedRevision);
    if (!revisionCheck.ok) return revisionCheck;
    revision = thread ? nextRevision(thread) : 1;
  }

  if (!participantsValidated) {
    const participantCheck = validateDealParticipants(state, actorId, counterpartyId);
    if (!participantCheck.ok) return participantCheck;
  }
  if (isPlayerConfirmedForDeals(state, counterpartyId)) {
    return fail(`${getPlayerLabel(state, counterpartyId)} already confirmed court actions and cannot receive a new deal this round.`);
  }

  const clauseResult = normalizeDealClauses(state, actorId, counterpartyId, payload.clauses);
  if (!clauseResult.ok) return clauseResult;
  const validation = validateDealClausesAgainstState(state, clauseResult.clauses, pairKey, {
    troopPlanCache: options.troopPlanCache,
  });
  if (!validation.ok) return validation;

  return {
    ok: true,
    mode,
    threadId: thread?.id || null,
    counterpartyId,
    pairKey,
    revision,
    clauses: clonePlain(clauseResult.clauses),
    actorImpact: summarizeDealOfferImpact(clauseResult.clauses, actorId),
    counterpartyImpact: summarizeDealOfferImpact(clauseResult.clauses, counterpartyId),
  };
}

export function sendDealOffer(state, actorId, payload = {}) {
  ensureDealState(state);
  if (state.phase !== 'court') return fail('Deals may only be negotiated during the Court phase.');
  if (isPlayerConfirmedForDeals(state, actorId)) return fail('You already confirmed court actions this round.');

  const counterpartyId = toInt(payload.counterpartyId, null);
  const participantCheck = validateDealParticipants(state, actorId, counterpartyId);
  if (!participantCheck.ok) return participantCheck;
  if (isPlayerConfirmedForDeals(state, counterpartyId)) {
    return fail(`${getPlayerLabel(state, counterpartyId)} already confirmed court actions and cannot receive a new deal this round.`);
  }

  const clauseResult = normalizeDealClauses(state, actorId, counterpartyId, payload.clauses);
  if (!clauseResult.ok) return clauseResult;

  const pairKey = makePairKey(actorId, counterpartyId);
  const validation = validateDealClausesAgainstState(state, clauseResult.clauses, pairKey);
  if (!validation.ok) return validation;

  const thread = ensureThreadForPair(state, actorId, counterpartyId);
  if (thread.status === DEAL_THREAD_STATUS.OPEN) {
    return fail('That deal thread is still open. Counter, accept, or refuse it first.');
  }
  const revisionCheck = enforceRevision(thread, payload.expectedRevision);
  if (!revisionCheck.ok) return revisionCheck;

  const revision = nextRevision(thread);
  const offer = createThreadOffer(state, actorId, counterpartyId, revision, clauseResult.clauses);
  thread.status = DEAL_THREAD_STATUS.OPEN;
  thread.revision = revision;
  thread.awaitingPlayerId = counterpartyId;
  thread.currentOffer = offer;
  thread.history.push(buildThreadHistoryEntry(state, 'offer_sent', actorId, revision, offer));
  return { ok: true, threadId: thread.id, revision };
}

export function counterDealOffer(state, actorId, payload = {}) {
  ensureDealState(state);
  if (state.phase !== 'court') return fail('Deals may only be negotiated during the Court phase.');
  if (isPlayerConfirmedForDeals(state, actorId)) return fail('You already confirmed court actions this round.');

  const thread = getThreadById(state, String(payload.threadId || '').trim());
  if (!thread) return fail('That deal thread does not exist anymore.');
  if (thread.status !== DEAL_THREAD_STATUS.OPEN) return fail('That deal is already closed.');
  if (thread.awaitingPlayerId !== actorId) return fail('Only the dynasty currently holding the offer may counter it.');
  const revisionCheck = enforceRevision(thread, payload.expectedRevision);
  if (!revisionCheck.ok) return revisionCheck;

  const counterpartyId = getOpposingPlayerId(thread, actorId);
  const participantCheck = validateDealParticipants(state, actorId, counterpartyId);
  if (!participantCheck.ok) return participantCheck;
  if (isPlayerConfirmedForDeals(state, counterpartyId)) {
    return fail(`${getPlayerLabel(state, counterpartyId)} already confirmed court actions and cannot receive a counteroffer this round.`);
  }

  const clauseResult = normalizeDealClauses(state, actorId, counterpartyId, payload.clauses);
  if (!clauseResult.ok) return clauseResult;
  const validation = validateDealClausesAgainstState(state, clauseResult.clauses, thread.pairKey);
  if (!validation.ok) return validation;

  const revision = nextRevision(thread);
  const offer = createThreadOffer(state, actorId, counterpartyId, revision, clauseResult.clauses);
  thread.status = DEAL_THREAD_STATUS.OPEN;
  thread.revision = revision;
  thread.awaitingPlayerId = counterpartyId;
  thread.currentOffer = offer;
  thread.history.push(buildThreadHistoryEntry(state, 'offer_countered', actorId, revision, offer));
  return { ok: true, threadId: thread.id, revision };
}

export function acceptDealOffer(state, actorId, payload = {}) {
  ensureDealState(state);
  if (state.phase !== 'court') return fail('Deals may only be accepted during the Court phase.');
  if (isPlayerConfirmedForDeals(state, actorId)) return fail('You already confirmed court actions this round.');

  const thread = getThreadById(state, String(payload.threadId || '').trim());
  if (!thread) return fail('That deal thread does not exist anymore.');
  if (thread.status !== DEAL_THREAD_STATUS.OPEN) return fail('That deal is already closed.');
  if (thread.awaitingPlayerId !== actorId) return fail('Only the dynasty currently holding the offer may accept it.');
  const revisionCheck = enforceRevision(thread, payload.expectedRevision);
  if (!revisionCheck.ok) return revisionCheck;

  const clauses = thread.currentOffer?.clauses || [];
  const validation = validateDealClausesAgainstState(state, clauses, thread.pairKey);
  if (!validation.ok) return validation;
  const acceptance = acceptOfferIntoObligations(state, thread, clauses);
  if (!acceptance.ok) return acceptance;

  finalizeThreadState(state, thread, DEAL_THREAD_STATUS.ACCEPTED, actorId, { type: 'offer_accepted' });
  filterActiveObligations(state);
  return { ok: true, threadId: thread.id, revision: thread.revision };
}

export function refuseDealOffer(state, actorId, payload = {}) {
  ensureDealState(state);
  if (state.phase !== 'court') return fail('Deals may only be refused during the Court phase.');
  if (isPlayerConfirmedForDeals(state, actorId)) return fail('You already confirmed court actions this round.');

  const thread = getThreadById(state, String(payload.threadId || '').trim());
  if (!thread) return fail('That deal thread does not exist anymore.');
  if (thread.status !== DEAL_THREAD_STATUS.OPEN) return fail('That deal is already closed.');
  if (thread.awaitingPlayerId !== actorId) return fail('Only the dynasty currently holding the offer may refuse it.');
  const revisionCheck = enforceRevision(thread, payload.expectedRevision);
  if (!revisionCheck.ok) return revisionCheck;

  finalizeThreadState(state, thread, DEAL_THREAD_STATUS.REFUSED, actorId, {
    type: 'offer_refused',
    reason: String(payload.reason || '').trim() || null,
  });
  return { ok: true, threadId: thread.id, revision: thread.revision };
}

// ─── AI / automation surface ───────────────────────────────────────────────
// These helpers let non-UI agents inspect open deals and dispatch responses
// through the same engine path the UI uses.

export function getIncomingDealsForPlayer(state, playerId) {
  ensureDealState(state);
  return state.dealThreads.filter((thread) => (
    thread.status === DEAL_THREAD_STATUS.OPEN
    && thread.awaitingPlayerId === playerId
  ));
}

export function getOutgoingDealsForPlayer(state, playerId) {
  ensureDealState(state);
  return state.dealThreads.filter((thread) => (
    thread.status === DEAL_THREAD_STATUS.OPEN
    && thread.playerIds.includes(playerId)
    && thread.awaitingPlayerId !== playerId
  ));
}

// Single dispatch point for accept / refuse / counter. Mirrors the human
// command surface so AI calls go through the exact same validation path.
export function respondToDeal(state, actorId, payload = {}) {
  const action = String(payload.action || '').trim();
  if (action === 'accept') return acceptDealOffer(state, actorId, payload);
  if (action === 'refuse') return refuseDealOffer(state, actorId, payload);
  if (action === 'counter') return counterDealOffer(state, actorId, payload);
  return fail('Choose accept, refuse, or counter.');
}

export function buildPrivateDealView(state, viewerId) {
  ensureDealState(state);
  const threads = state.dealThreads
    .filter((thread) => thread.playerIds.includes(viewerId))
    .map((thread) => ({
      id: thread.id,
      pairKey: thread.pairKey,
      playerIds: thread.playerIds.slice(),
      status: thread.status,
      revision: thread.revision,
      awaitingPlayerId: thread.awaitingPlayerId,
      currentOffer: clonePlain(thread.currentOffer),
      history: clonePlain(thread.history),
    }))
    .sort((left, right) => right.revision - left.revision);

  const pendingInbox = threads.filter((thread) => thread.status === DEAL_THREAD_STATUS.OPEN && thread.awaitingPlayerId === viewerId).length;
  const pendingOutbox = threads.filter((thread) => thread.status === DEAL_THREAD_STATUS.OPEN && thread.awaitingPlayerId !== viewerId).length;
  const obligationCount = (state.activeDealObligations || []).filter((obligation) => (
    obligation.status !== 'completed'
    && (obligation.giverId === viewerId || obligation.receiverId === viewerId)
  )).length;

  const orderLocks = buildOrderLocksForPlayer(state, viewerId);

  return {
    dealEligiblePlayerIds: getDealParticipantIds(state).filter((playerId) => playerId !== viewerId),
    dealThreads: threads,
    dealCounts: {
      pendingInbox,
      pendingOutbox,
      activeObligations: obligationCount,
    },
    orderLocks: orderLocks.ok ? orderLocks : { ok: false, reason: orderLocks.reason || 'Accepted deal commitments can no longer be fulfilled.' },
  };
}
