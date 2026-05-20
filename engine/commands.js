// engine/commands.js - shared command layer for UI, AI, and multiplayer.
import { recordHistoryEvent } from './history.js';
import { formatPlayerLabel, getPlayer } from './state.js';
import {
  confirmTitleRedistribution,
  phaseDeployment,
  phaseEstates,
  submitOrders,
} from './turnflow.js';
import {
  acceptDealOffer,
  autoRefuseAwaitingDeals,
  counterDealOffer,
  isPlayerProtectedFromRevocation,
  refuseDealOffer,
  sendDealOffer,
} from './deals.js';
import {
  appointBishop,
  appointCourtTitle,
  appointStrategos,
  buyTheme,
  canPlayerRevokeBishop,
  canPlayerRevokeStrategos,
  checkRevocationCurrentTurnAppointment,
  giftToChurch,
  hasCourtActionUsed,
  markCourtActionUsed,
  revokeChurchLand,
  revokeCourtTitle,
  revokeMinorTitle,
  revokeTheme,
  validateMajorTitleAssignments,
  applyTitleRedistribution,
} from './actions.js';
import { normalizeHumanOrders } from './orders.js';
import { observeCourtAction } from '../ai/brain.js';

function fail(reason) {
  return { ok: false, reason };
}

function playerLabel(state, playerId) {
  const player = getPlayer(state, playerId);
  return formatPlayerLabel(player) || `Player ${Number(playerId) + 1}`;
}

export function applyCourtAction(state, playerId, payload = {}) {
  const action = String(payload.action || '').trim();

  if (action === 'deal-send') return sendDealOffer(state, playerId, payload);
  if (action === 'deal-counter') return counterDealOffer(state, playerId, payload);
  if (action === 'deal-accept') return acceptDealOffer(state, playerId, payload);
  if (action === 'deal-refuse') return refuseDealOffer(state, playerId, payload);

  if (state.phase !== 'court') return fail('Court actions are not available right now.');
  if (state.courtActions?.playerConfirmed?.has(playerId)) return fail('Court actions already confirmed.');

  if (action === 'skip') {
    if (hasCourtActionUsed(state, playerId)) return fail('This player has already used their court action this turn.');
    markCourtActionUsed(state, playerId);
    return { ok: true };
  }

  if (action === 'gift') {
    const result = giftToChurch(state, playerId, payload.themeId);
    if (!result?.ok) return fail(result?.reason || 'Could not gift that estate.');
    return { ok: true, observation: { type: 'gift', actorId: playerId, themeId: payload.themeId } };
  }

  if (action === 'appoint-court') {
    const appointeeId = Number(payload.appointeeId);
    const result = appointCourtTitle(state, payload.titleType, appointeeId, playerId);
    if (!result?.ok) return fail(result?.reason || 'Could not appoint that court title.');
    return {
      ok: true,
      observation: { type: 'appointment', actorId: playerId, appointeeId, previousHolderId: null, value: 1.1 },
    };
  }

  if (action === 'basileus-appoint') {
    const titleType = payload.titleType;
    const appointeeId = Number(payload.appointeeId);
    if (titleType !== 'EMPRESS' && titleType !== 'CHIEF_EUNUCHS') {
      return fail('The Basileus may only appoint court titles.');
    }
    const result = appointCourtTitle(state, titleType, appointeeId, playerId);
    if (!result?.ok) return fail(result?.reason || 'Could not complete that appointment.');
    return {
      ok: true,
      observation: { type: 'appointment', actorId: playerId, appointeeId, previousHolderId: null, value: 1.1 },
    };
  }

  if (action === 'appoint-strategos') {
    const appointeeId = Number(payload.appointeeId);
    const result = appointStrategos(state, playerId, String(payload.themeId || '').trim(), appointeeId);
    if (!result?.ok) return fail(result?.reason || 'Could not appoint that strategos.');
    return {
      ok: true,
      observation: { type: 'appointment', actorId: playerId, appointeeId, previousHolderId: null, value: 0.95 },
    };
  }

  if (action === 'appoint-bishop') {
    const appointeeId = Number(payload.appointeeId);
    const result = appointBishop(state, playerId, String(payload.themeId || '').trim(), appointeeId);
    if (!result?.ok) return fail(result?.reason || 'Could not appoint that bishop.');
    return {
      ok: true,
      observation: { type: 'appointment', actorId: playerId, appointeeId, previousHolderId: null, value: 1.0 },
    };
  }

  if (action === 'revoke') {
    const value = String(payload.value || '').trim();
    const parts = value.split(':');
    const kind = parts[0];
    if (kind === 'major') return fail('Major titles are redistributed during Title Redistribution.');

    let targetPlayerId = null;
    if (kind === 'minor') {
      const theme = state.themes[parts[1]];
      targetPlayerId = parts[2] === 'strategos' ? theme?.strategos ?? null : theme?.bishop ?? null;
      const sameTurn = checkRevocationCurrentTurnAppointment(state, value);
      if (!sameTurn.ok) return fail(sameTurn.reason);
      if (targetPlayerId != null && isPlayerProtectedFromRevocation(state, playerId, targetPlayerId)) {
        return fail(`${playerLabel(state, targetPlayerId)} is protected by an accepted non-revocation deal.`);
      }
      if (parts[2] === 'strategos' && !canPlayerRevokeStrategos(state, playerId, parts[1])) {
        return fail('Only the regional Domestic or Admiral can revoke this strategos.');
      }
      if (parts[2] === 'bishop' && !canPlayerRevokeBishop(state, playerId)) {
        return fail('Only the Patriarch can revoke bishops.');
      }
      const result = revokeMinorTitle(state, parts[1], parts[2], playerId);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that minor title.');
    } else if (kind === 'court') {
      targetPlayerId = parts[1] === 'EMPRESS' ? state.empress : state.chiefEunuchs;
      if (targetPlayerId != null && isPlayerProtectedFromRevocation(state, playerId, targetPlayerId)) {
        return fail(`${playerLabel(state, targetPlayerId)} is protected by an accepted non-revocation deal.`);
      }
      const result = revokeCourtTitle(state, parts[1], playerId);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that court title.');
    } else if (kind === 'theme') {
      const theme = state.themes[parts[1]];
      targetPlayerId = theme?.owner ?? null;
      if (targetPlayerId != null && targetPlayerId !== 'church' && isPlayerProtectedFromRevocation(state, playerId, targetPlayerId)) {
        return fail(`${playerLabel(state, targetPlayerId)} is protected by an accepted non-revocation deal.`);
      }
      const result = theme?.owner === 'church'
        ? revokeChurchLand(state, parts[1], playerId)
        : revokeTheme(state, parts[1], playerId);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that estate.');
    } else {
      return fail('Choose a valid revocation target.');
    }
    return { ok: true, observation: { type: 'revocation', actorId: playerId, targetPlayerId } };
  }

  return fail('Unknown court action.');
}

export function applyEstateAction(state, playerId, payload = {}) {
  if (state.phase !== 'estates') return fail('Estate bidding is not available right now.');
  const action = String(payload.action || '').trim();
  if (action === 'buy') {
    const result = buyTheme(state, playerId, payload.themeId, payload.amount);
    if (!result?.ok) return fail(result?.reason || 'Could not bid on that estate.');
    return { ok: true };
  }
  return fail('Unknown estate action.');
}

export function confirmCourt(state, playerId) {
  if (state.phase !== 'court') return fail('Court confirmation is not available right now.');
  if (state.courtActions?.playerConfirmed?.has(playerId)) return fail('Court actions already confirmed.');
  if (!hasCourtActionUsed(state, playerId)) markCourtActionUsed(state, playerId);
  state.courtActions.playerConfirmed.add(playerId);
  autoRefuseAwaitingDeals(state, playerId);
  recordHistoryEvent(state, {
    category: 'court',
    type: 'court_confirmed',
    actorId: playerId,
    actorAi: false,
    summary: `${playerLabel(state, playerId)} ends court business for the round.`,
  });
  return { ok: true };
}

export function confirmEstates(state) {
  if (state.phase !== 'estates') return fail('Estates are not active.');
  phaseDeployment(state);
  return { ok: true };
}

export function submitHumanOrders(state, playerId, orders, options = {}) {
  if (state.phase !== 'deployment') return fail('Deployment orders cannot be submitted right now.');
  if (state.allOrders?.[playerId]) return fail('Orders are already locked for this seat.');
  const normalized = normalizeHumanOrders(state, playerId, orders, {
    ...options,
    resolveImpossibleLocks: options.resolveImpossibleLocks !== false,
  });
  if (!normalized.ok) return fail(normalized.reason || 'Invalid orders.');
  const result = submitOrders(state, playerId, normalized.orders);
  if (!result.ok) return result;
  return { ok: true, orders: normalized.orders, totalCost: normalized.totalCost };
}

export function applyManualTitleReassignment(state, aiMeta, basileusId, titleAssignments) {
  const validation = validateMajorTitleAssignments(state, basileusId, titleAssignments);
  if (!validation?.ok) return validation || fail('Invalid major title assignments.');
  const previousAssignments = {};
  for (const player of state.players) {
    for (const titleKey of player.majorTitles) previousAssignments[titleKey] = player.id;
  }
  const result = state.phase === 'title_redistribution'
    ? confirmTitleRedistribution(state, basileusId, titleAssignments)
    : applyTitleRedistribution(state, basileusId, titleAssignments);
  if (!result.ok) return result;

  if (aiMeta) {
    for (const [titleKey, appointeeId] of Object.entries(titleAssignments)) {
      observeCourtAction(state, aiMeta, {
        type: 'appointment',
        actorId: basileusId,
        appointeeId: Number(appointeeId),
        previousHolderId: previousAssignments[titleKey] ?? null,
        value: 1.25,
      });
    }
  }
  return { ok: true };
}

export function advanceFromCourtToEstates(state) {
  if (state.phase !== 'court') return fail('Court is not active.');
  phaseEstates(state);
  return { ok: true };
}
