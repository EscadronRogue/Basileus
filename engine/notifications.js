import { summarizeDealClause } from './deals.js';
import { formatPlayerLabel, getPlayer } from './state.js';

function playerName(state, playerId) {
  const player = getPlayer(state, playerId);
  return player ? formatPlayerLabel(player) : `Player ${Number(playerId) + 1}`;
}

function pushNotification(list, notification) {
  if (!notification?.id) return;
  if (list.some((entry) => entry.id === notification.id)) return;
  list.push({
    priority: notification.urgent ? 2 : 1,
    round: notification.round ?? null,
    phase: notification.phase ?? null,
    ...notification,
  });
}

function summarizeObligation(state, obligation, viewerId) {
  return summarizeDealClause(state, {
    kind: obligation.kind,
    giverId: obligation.giverId,
    receiverId: obligation.receiverId,
    startTrigger: obligation.startTrigger,
    durationTurns: obligation.durationTurns,
    payload: obligation.payload || {},
  }, viewerId);
}

function getThreadCounterparty(thread, viewerId) {
  return thread.playerIds?.find((playerId) => Number(playerId) !== Number(viewerId)) ?? null;
}

function buildDealNotifications(state, viewerId, dealView, notifications) {
  const threads = Array.isArray(dealView?.dealThreads) ? dealView.dealThreads : [];
  for (const thread of threads) {
    const counterpartyId = getThreadCounterparty(thread, viewerId);
    const counterpartyName = playerName(state, counterpartyId);
    const latest = Array.isArray(thread.history) ? thread.history.at(-1) : null;
    const offerRevision = Number(thread.revision) || 0;

    if (thread.status === 'open' && Number(thread.awaitingPlayerId) === Number(viewerId)) {
      const verb = latest?.type === 'offer_countered' ? 'counteroffer' : 'offer';
      pushNotification(notifications, {
        id: `deal:${thread.id}:awaiting:${offerRevision}`,
        kind: 'deal_incoming',
        title: `New ${verb} from ${counterpartyName}`,
        body: `A deal is waiting for your reply.`,
        urgent: true,
        action: 'open_deals',
        round: thread.currentOffer?.round ?? state.round,
        phase: 'court',
      });
    }

    for (const event of thread.history || []) {
      if (!['offer_countered', 'offer_accepted', 'offer_refused', 'auto_refused'].includes(event.type)) continue;
      if (event.type === 'offer_countered' && Number(thread.awaitingPlayerId) === Number(viewerId)) continue;
      const actorName = playerName(state, event.actorId);
      const titleByType = {
        offer_countered: `${actorName} sent a counteroffer`,
        offer_accepted: `${actorName} accepted a deal`,
        offer_refused: `${actorName} refused a deal`,
        auto_refused: `${actorName} left a deal unanswered`,
      };
      pushNotification(notifications, {
        id: `deal:${thread.id}:${event.type}:${event.revision}:${event.actorId}`,
        kind: event.type === 'offer_accepted' ? 'deal_accepted' : 'deal_update',
        title: titleByType[event.type],
        body: `Negotiation with ${counterpartyName}.`,
        urgent: false,
        action: 'open_deals',
        round: event.round ?? state.round,
        phase: event.phase ?? 'court',
      });
    }
  }
}

function buildObligationNotifications(state, viewerId, dealView, notifications) {
  const obligations = (state.activeDealObligations || []).filter((obligation) => (
    obligation.status !== 'completed'
    && (Number(obligation.giverId) === Number(viewerId) || Number(obligation.receiverId) === Number(viewerId))
  ));

  for (const obligation of obligations) {
    pushNotification(notifications, {
      id: `obligation:${obligation.id}:${obligation.status}`,
      kind: 'deal_obligation',
      title: obligation.status === 'dormant' ? 'Dormant deal obligation' : 'Active deal obligation',
      body: summarizeObligation(state, obligation, viewerId),
      urgent: false,
      action: 'open_deals',
      round: obligation.createdRound ?? state.round,
      phase: 'court',
    });
  }

  const locks = dealView?.orderLocks;
  if (locks?.ok && (locks.candidateId != null || locks.officeSelections?.length)) {
    const lockedBits = [];
    if (locks.candidateName) lockedBits.push(`claimant: ${locks.candidateName}`);
    if (locks.officeSelections?.length) lockedBits.push(`${locks.officeSelections.length} deployment lock${locks.officeSelections.length === 1 ? '' : 's'}`);
    pushNotification(notifications, {
      id: `order-lock:${viewerId}:${state.round}:${locks.candidateId ?? 'none'}:${locks.officeSelections?.length || 0}`,
      kind: 'order_lock',
      title: 'Deal commitments affect your orders',
      body: lockedBits.join(', '),
      urgent: false,
      action: 'open_orders',
      round: state.round,
      phase: state.phase,
    });
  }
}

function buildRevocationNotifications(state, viewerId, notifications) {
  for (const event of state.history || []) {
    if (!['revoke_minor_title', 'revoke_court_title', 'revoke_theme'].includes(event.type)) continue;
    const revokedPlayerId = event.details?.revokedPlayerId;
    if (Number(revokedPlayerId) !== Number(viewerId)) continue;
    pushNotification(notifications, {
      id: `history:${event.id}:revoked:${viewerId}`,
      kind: 'revocation',
      title: 'Something you held was revoked',
      body: event.summary || 'A title or estate was revoked.',
      urgent: true,
      action: 'open_history',
      round: event.round ?? state.round,
      phase: event.phase ?? 'court',
    });
  }
}

function buildPendingActionNotifications(state, viewerId, notifications) {
  if (state.pendingTitleReassignment && Number(state.nextBasileusId) === Number(viewerId)) {
    pushNotification(notifications, {
      id: `title-reassignment:${viewerId}:${state.round}`,
      kind: 'title_reassignment',
      title: 'Redistribute the major offices',
      body: 'Your dynasty has taken the throne and must assign the major titles.',
      urgent: true,
      action: 'open_resolution',
      round: state.round,
      phase: state.phase,
    });
  }

  for (const reward of state.pendingDefenderRewards || []) {
    if (reward.resolved || Number(reward.defenderId) !== Number(viewerId)) continue;
    pushNotification(notifications, {
      id: `defender-reward:${reward.id}`,
      kind: 'defender_reward',
      title: 'Choose a defender reward',
      body: `${reward.themeName || reward.themeId} can be restored or converted into gold.`,
      urgent: true,
      action: 'open_resolution',
      round: state.round,
      phase: state.phase,
    });
  }
}

export function buildPrivateNotifications(state, viewerId, dealView = null) {
  const notifications = [];
  if (!state || viewerId == null) {
    return {
      notifications,
      notificationCounts: { total: 0, urgent: 0 },
    };
  }

  buildDealNotifications(state, viewerId, dealView, notifications);
  buildObligationNotifications(state, viewerId, dealView, notifications);
  buildRevocationNotifications(state, viewerId, notifications);
  buildPendingActionNotifications(state, viewerId, notifications);

  notifications.sort((left, right) => (
    (right.urgent ? 1 : 0) - (left.urgent ? 1 : 0)
    || (right.round ?? 0) - (left.round ?? 0)
    || String(right.id).localeCompare(String(left.id))
  ));

  return {
    notifications,
    notificationCounts: {
      total: notifications.length,
      urgent: notifications.filter((entry) => entry.urgent).length,
    },
  };
}
