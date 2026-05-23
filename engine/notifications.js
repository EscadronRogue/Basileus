import { summarizeDealClause } from './deals.js';
import { formatPlayerLabel, getPlayer } from './state.js';

const NOTIFICATION_TONES = new Set(['negative', 'positive', 'neutral']);

function playerName(state, playerId) {
  const player = getPlayer(state, playerId);
  return player ? formatPlayerLabel(player) : `Player ${Number(playerId) + 1}`;
}

function normalizeNotificationTone(tone) {
  return NOTIFICATION_TONES.has(tone) ? tone : 'neutral';
}

function pushNotification(list, notification) {
  if (!notification?.id) return;
  if (list.some((entry) => entry.id === notification.id)) return;
  const urgent = Boolean(notification.urgent);
  list.push({
    priority: notification.priority ?? (urgent ? 2 : 1),
    round: notification.round ?? null,
    phase: notification.phase ?? null,
    ...notification,
    urgent,
    tone: normalizeNotificationTone(notification.tone),
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
        tone: 'neutral',
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
      const toneByType = {
        offer_countered: 'neutral',
        offer_accepted: 'positive',
        offer_refused: 'negative',
        auto_refused: 'negative',
      };
      pushNotification(notifications, {
        id: `deal:${thread.id}:${event.type}:${event.revision}:${event.actorId}`,
        kind: event.type === 'offer_accepted' ? 'deal_accepted' : 'deal_update',
        title: titleByType[event.type],
        body: `Negotiation with ${counterpartyName}.`,
        urgent: false,
        tone: toneByType[event.type],
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
      tone: 'neutral',
      action: 'open_deals',
      round: obligation.createdRound ?? state.round,
      phase: 'court',
    });
  }

  const locks = dealView?.orderLocks;
  if (locks?.ok && (locks.candidateId != null || locks.officeSelections?.length)) {
    const lockedBits = [];
    if (locks.candidateName) lockedBits.push(`coup rank: ${locks.candidateName}`);
    if (locks.officeSelections?.length) lockedBits.push(`${locks.officeSelections.length} deployment lock${locks.officeSelections.length === 1 ? '' : 's'}`);
    pushNotification(notifications, {
      id: `order-lock:${viewerId}:${state.round}:${locks.candidateId ?? 'none'}:${locks.officeSelections?.length || 0}`,
      kind: 'order_lock',
      title: 'Deal commitments affect your orders',
      body: lockedBits.join(', '),
      urgent: false,
      tone: 'neutral',
      action: 'open_deployment',
      round: state.round,
      phase: state.phase,
    });
  }
}

const REVOCATION_EVENT_TYPES = new Set([
  'revoke_minor_title',
  'revoke_theme',
]);

function normalizePlayerId(value) {
  if (value == null) return null;
  const playerId = Number(value);
  return Number.isInteger(playerId) ? playerId : null;
}

function getRevokedPlayerIds(event) {
  const details = event.details || {};
  const ids = [];
  if (Array.isArray(details.revokedPlayerIds)) {
    ids.push(...details.revokedPlayerIds.map(normalizePlayerId));
  }
  ids.push(normalizePlayerId(details.revokedPlayerId));
  return [...new Set(ids.filter(Number.isInteger))];
}

function buildRevocationNotifications(state, viewerId, notifications) {
  const normalizedViewerId = normalizePlayerId(viewerId);
  for (const event of state.history || []) {
    if (!REVOCATION_EVENT_TYPES.has(event.type)) continue;
    if (!getRevokedPlayerIds(event).includes(normalizedViewerId)) continue;
    pushNotification(notifications, {
      id: `history:${event.id}:revoked:${viewerId}`,
      kind: 'revocation',
      title: 'Something you held was revoked',
      body: event.summary || 'A title or estate was revoked.',
      urgent: true,
      tone: 'negative',
      action: 'open_history',
      round: event.round ?? state.round,
      phase: event.phase ?? 'court',
    });
  }
}

function eventDetails(event) {
  return event?.details && typeof event.details === 'object' ? event.details : {};
}

function pushHistoryNotification(notifications, event, viewerId, notification) {
  const kind = notification.kind || event.type || 'history';
  pushNotification(notifications, {
    id: `history:${event.id}:${kind}:${viewerId}`,
    kind,
    title: notification.title,
    body: notification.body ?? event.summary ?? '',
    action: notification.action || 'open_history',
    round: event.round,
    phase: event.phase,
    urgent: Boolean(notification.urgent),
    tone: notification.tone,
  });
}

function getViewerBid(details, viewerId) {
  const bids = Array.isArray(details.bids) ? details.bids : [];
  return bids.find((bid) => normalizePlayerId(bid?.bidderId) === viewerId) || null;
}

function getAssignedTitles(details, viewerId) {
  const assignments = details.assignments && typeof details.assignments === 'object'
    ? Object.values(details.assignments)
    : [];
  return assignments.filter((assignment) => normalizePlayerId(assignment?.playerId) === viewerId);
}

function getReconquestRewardRecipients(details) {
  if (Array.isArray(details.defenders)) {
    return details.defenders.map((entry) => normalizePlayerId(entry?.defenderId)).filter(Number.isInteger);
  }
  return [normalizePlayerId(details.defenderId)].filter(Number.isInteger);
}

function buildHistoryEventNotifications(state, viewerId, notifications) {
  const normalizedViewerId = normalizePlayerId(viewerId);
  if (!Number.isInteger(normalizedViewerId)) return;

  for (const event of state.history || []) {
    if (!event?.id) continue;
    const details = eventDetails(event);

    if (event.type === 'invasion_drawn') {
      pushHistoryNotification(notifications, event, viewerId, {
        kind: 'invasion_drawn',
        title: 'Invasion drawn',
        tone: 'negative',
      });
      continue;
    }

    if (event.type === 'invasion_skipped') {
      pushHistoryNotification(notifications, event, viewerId, {
        kind: 'invasion_skipped',
        title: 'Invasion skipped',
        tone: 'positive',
      });
      continue;
    }

    if (event.type === 'buy_theme') {
      const winnerId = normalizePlayerId(event.actorId);
      const viewerBid = getViewerBid(details, normalizedViewerId);
      if (winnerId === normalizedViewerId) {
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'estate_won',
          title: 'You won an estate',
          tone: 'positive',
        });
      } else if (viewerBid) {
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'estate_lost',
          title: `You lost the bid for ${details.themeName || 'an estate'}`,
          tone: 'negative',
        });
      }
      continue;
    }

    if (event.type === 'appoint_strategos' || event.type === 'appoint_bishop') {
      if (normalizePlayerId(details.appointeeId) === normalizedViewerId) {
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'appointment',
          title: event.type === 'appoint_bishop' ? 'You were appointed bishop' : 'You were appointed strategos',
          tone: 'positive',
        });
      }
      continue;
    }

    if (event.type === 'title_redistribution') {
      const assignedTitles = getAssignedTitles(details, normalizedViewerId);
      if (assignedTitles.length) {
        const titleNames = assignedTitles.map((assignment) => assignment.titleName).filter(Boolean).join(', ');
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'major_title_assignment',
          title: titleNames ? `You received ${titleNames}` : 'You received a major office',
          tone: 'positive',
        });
      } else {
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'title_redistribution',
          title: 'Major offices redistributed',
          tone: 'neutral',
        });
      }
      continue;
    }

    if (event.type === 'coup_result') {
      const winnerId = normalizePlayerId(details.winnerId);
      pushHistoryNotification(notifications, event, viewerId, {
        kind: 'coup_result',
        title: winnerId === normalizedViewerId ? 'You won the coup' : 'Coup result declared',
        tone: winnerId === normalizedViewerId ? 'positive' : 'neutral',
        action: 'open_resolution',
      });
      continue;
    }

    if (event.type === 'war_result') {
      const outcome = details.outcome || 'stalemate';
      pushHistoryNotification(notifications, event, viewerId, {
        kind: 'war_result',
        title: outcome === 'victory'
          ? 'The empire won the war'
          : outcome === 'defeat'
            ? 'The empire lost the war'
            : 'The war ended in stalemate',
        urgent: outcome === 'defeat' || Boolean(details.reachedCPL),
        tone: outcome === 'victory' ? 'positive' : outcome === 'defeat' ? 'negative' : 'neutral',
        action: 'open_resolution',
      });
      continue;
    }

    if (event.type === 'reconquest_reward') {
      if (getReconquestRewardRecipients(details).includes(normalizedViewerId)) {
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'reconquest_reward',
          title: 'You earned a reconquest reward',
          tone: 'positive',
          action: 'open_resolution',
        });
      }
      continue;
    }

    if (event.type === 'basileus_loss_penalty') {
      const penalizedId = normalizePlayerId(details.playerId ?? details.basileusId);
      if (penalizedId === normalizedViewerId) {
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'basileus_loss_penalty',
          title: 'Your capital support fell',
          urgent: true,
          tone: 'negative',
          action: 'open_resolution',
        });
      }
      continue;
    }

    if (event.type === 'defender_reward') {
      const defenderId = normalizePlayerId(details.defenderId ?? event.actorId);
      if (defenderId === normalizedViewerId) {
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'defender_reward_resolved',
          title: 'Your defender reward resolved',
          tone: 'positive',
          action: 'open_resolution',
        });
      }
      continue;
    }

    if (event.type === 'new_basileus') {
      const newBasileusId = normalizePlayerId(details.newBasileusId);
      const oldBasileusId = normalizePlayerId(details.oldBasileusId);
      pushHistoryNotification(notifications, event, viewerId, {
        kind: 'new_basileus',
        title: newBasileusId === normalizedViewerId
          ? 'You are Basileus'
          : oldBasileusId === normalizedViewerId
            ? 'You lost the throne'
            : 'A new Basileus took the throne',
        urgent: newBasileusId === normalizedViewerId || oldBasileusId === normalizedViewerId,
        tone: newBasileusId === normalizedViewerId
          ? 'positive'
          : oldBasileusId === normalizedViewerId
            ? 'negative'
            : 'neutral',
        action: 'open_history',
      });
      continue;
    }

    if (event.type === 'deal_gold_transfer') {
      const giverId = normalizePlayerId(details.giverId);
      const receiverId = normalizePlayerId(details.receiverId);
      if (receiverId === normalizedViewerId || giverId === normalizedViewerId) {
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'deal_gold_transfer',
          title: receiverId === normalizedViewerId ? 'You received deal gold' : 'You paid deal gold',
          tone: receiverId === normalizedViewerId ? 'positive' : 'negative',
          action: 'open_deals',
        });
      }
      continue;
    }

    if (event.type === 'deal_estate_transfer') {
      const giverId = normalizePlayerId(details.giverId);
      const receiverId = normalizePlayerId(details.receiverId);
      if (receiverId === normalizedViewerId || giverId === normalizedViewerId) {
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'deal_estate_transfer',
          title: receiverId === normalizedViewerId ? 'You received an estate' : 'You transferred an estate',
          tone: receiverId === normalizedViewerId ? 'positive' : 'negative',
          action: 'open_deals',
        });
      }
      continue;
    }

    if (event.type === 'deal_obligation_failed') {
      const giverId = normalizePlayerId(details.giverId);
      const receiverId = normalizePlayerId(details.receiverId);
      if (receiverId === normalizedViewerId || giverId === normalizedViewerId) {
        pushHistoryNotification(notifications, event, viewerId, {
          kind: 'deal_obligation_failed',
          title: receiverId === normalizedViewerId ? 'A promised obligation failed' : 'You failed a deal obligation',
          urgent: true,
          tone: 'negative',
          action: 'open_deals',
        });
      }
    }
  }
}

function buildPendingActionNotifications(state, viewerId, notifications) {
  const normalizedViewerId = normalizePlayerId(viewerId);
  if (state.phase === 'title_redistribution' && Number(state.basileusId) === Number(viewerId)) {
    pushNotification(notifications, {
      id: `title-reassignment:${viewerId}:${state.round}`,
      kind: 'title_reassignment',
      title: 'Redistribute the major offices',
      body: 'As the newly installed Basileus, redistribute the major titles before Court.',
      urgent: true,
      tone: 'neutral',
      action: 'open_title_redistribution',
      round: state.round,
      phase: state.phase,
    });
  }

  if (state.phase === 'court' && Number.isInteger(normalizedViewerId)) {
    const confirmed = state.courtActions?.playerConfirmed;
    const isConfirmed = confirmed instanceof Set
      ? confirmed.has(normalizedViewerId)
      : Array.isArray(confirmed)
        ? confirmed.includes(normalizedViewerId)
        : Boolean(confirmed?.[normalizedViewerId]);
    if (!isConfirmed) {
      pushNotification(notifications, {
        id: `court-action:${viewerId}:${state.round}`,
        kind: 'court_action',
        title: 'Court business awaits',
        body: 'Use or pass your office powers, answer deals, then confirm Court.',
        urgent: true,
        tone: 'neutral',
        action: 'open_court',
        round: state.round,
        phase: state.phase,
      });
    }
  }

  if (state.phase === 'estates' && Number.isInteger(normalizedViewerId) && !state.estatesReady?.[normalizedViewerId]) {
    pushNotification(notifications, {
      id: `estate-action:${viewerId}:${state.round}`,
      kind: 'estate_action',
      title: 'Estate bidding awaits',
      body: 'Place sealed estate bids or confirm that you are ready for deployment.',
      urgent: true,
      tone: 'neutral',
      action: 'open_estates',
      round: state.round,
      phase: state.phase,
    });
  }

  if (state.phase === 'deployment' && Number.isInteger(normalizedViewerId) && !state.allOrders?.[normalizedViewerId]) {
    pushNotification(notifications, {
      id: `deployment-orders:${viewerId}:${state.round}`,
      kind: 'deployment_orders',
      title: 'Lock deployment orders',
      body: 'Fund armies, hire mercenaries, rank coup candidates, then lock your orders.',
      urgent: true,
      tone: 'neutral',
      action: 'open_deployment',
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
      tone: 'positive',
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
  buildHistoryEventNotifications(state, viewerId, notifications);
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
