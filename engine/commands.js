// engine/commands.js — shared command layer used by singleplayer and multiplayer.
// Each command returns { ok, reason?, observation? }. Mode adapters convert
// !ok into either a silent re-render (singleplayer) or a transport rejection
// (multiplayer). Observations feed AI relations (observeCourtAction).

import { recordHistoryEvent } from './history.js';
import {
  getPlayer,
  formatPlayerLabel,
  getPlayerMercenaryTroops,
  MERCENARY_COMPANY_KEY,
} from './state.js';
import { submitOrders } from './turnflow.js';
import {
  acceptDealOffer,
  autoRefuseAwaitingDeals,
  counterDealOffer,
  isPlayerProtectedFromRevocation,
  refuseDealOffer,
  sendDealOffer,
} from './deals.js';
import {
  applyCoupTitleReassignment,
  appointBishop,
  appointCourtTitle,
  appointStrategos,
  buyTheme,
  canPayPatriarchBishopRevocationCost,
  canPayRevocationCost,
  canPlayerRevokeBishop,
  canPlayerRevokeStrategos,
  checkRevocationCurrentTurnAppointment,
  dismissProfessional,
  giftToChurch,
  hireMercenaries,
  recruitProfessional,
  revokeCourtTitle,
  revokeMinorTitle,
  revokeTheme,
  validateMajorTitleAssignments,
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

function passMandatoryAppointmentsForPlayer(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player || !state.courtActions) return;
  if (playerId === state.basileusId) state.courtActions.basileusAppointed = true;
  if (player.majorTitles.includes('DOM_EAST')) {
    state.courtActions.domesticEastAppointed = true;
    state.courtActions.DOM_EAST_appointed = true;
  }
  if (player.majorTitles.includes('DOM_WEST')) {
    state.courtActions.domesticWestAppointed = true;
    state.courtActions.DOM_WEST_appointed = true;
  }
  if (player.majorTitles.includes('ADMIRAL')) {
    state.courtActions.admiralAppointed = true;
    state.courtActions.ADMIRAL_appointed = true;
  }
  if (player.majorTitles.includes('PATRIARCH')) {
    state.courtActions.patriarchAppointed = true;
  }
}

// ─── Court actions ─────────────────────────────────────────────────────────
// Returns { ok, reason?, observation? }.
// observation is an AI-relations payload to be fed to observeCourtAction when
// the player is non-AI (i.e. the action came from a human seat).
export function applyCourtAction(state, playerId, payload = {}) {
  const action = String(payload.action || '').trim();

  if (action === 'deal-send') {
    return sendDealOffer(state, playerId, payload);
  }

  if (action === 'deal-counter') {
    return counterDealOffer(state, playerId, payload);
  }

  if (action === 'deal-accept') {
    return acceptDealOffer(state, playerId, payload);
  }

  if (action === 'deal-refuse') {
    return refuseDealOffer(state, playerId, payload);
  }

  if (action === 'buy') {
    const result = buyTheme(state, playerId, payload.themeId, payload.amount);
    if (!result?.ok) return fail(result?.reason || 'Could not bid on that estate.');
    return { ok: true };
  }

  if (action === 'gift') {
    const result = giftToChurch(state, playerId, payload.themeId);
    if (!result?.ok) return fail(result?.reason || 'Could not gift that estate.');
    return { ok: true };
  }

  if (action === 'recruit') {
    const result = recruitProfessional(state, playerId, payload.office);
    if (!result?.ok) return fail(result?.reason || 'Could not recruit for that office.');
    return { ok: true };
  }

  if (action === 'dismiss') {
    const result = dismissProfessional(state, playerId, payload.office, Number(payload.count));
    if (!result?.ok) return fail(result?.reason || 'Could not dismiss those troops.');
    return { ok: true };
  }

  if (action === 'hire-mercenaries') {
    const count = Number(payload.count) || 1;
    const result = hireMercenaries(state, playerId, MERCENARY_COMPANY_KEY, count);
    if (!result?.ok) return fail(result?.reason || 'Could not hire mercenaries.');
    return {
      ok: true,
      observation: {
        type: 'mercenaries',
        actorId: playerId,
        officeKey: MERCENARY_COMPANY_KEY,
        count,
        totalMercenaryTroops: getPlayerMercenaryTroops(state, playerId),
      },
    };
  }

  if (action === 'basileus-appoint') {
    if (playerId !== state.basileusId) return fail('Only the Basileus can use this appointment.');

    const titleType = payload.titleType;
    const appointeeId = Number(payload.appointeeId);
    const themeId = payload.themeId || null;
    if (!Number.isInteger(appointeeId) || !getPlayer(state, appointeeId)) {
      return fail('Choose an appointee.');
    }

    let previousHolderId = null;
    if (titleType === 'EMPRESS') previousHolderId = state.empress;
    else if (titleType === 'CHIEF_EUNUCHS') previousHolderId = state.chiefEunuchs;
    else if (titleType === 'STRATEGOS' && themeId) previousHolderId = state.themes[themeId]?.strategos ?? null;
    else if (titleType === 'BISHOP' && themeId) previousHolderId = state.themes[themeId]?.bishop ?? null;

    let result = null;
    if (titleType === 'EMPRESS' || titleType === 'CHIEF_EUNUCHS') {
      result = appointCourtTitle(state, titleType, appointeeId);
    } else if (titleType === 'STRATEGOS' && themeId) {
      result = appointStrategos(state, state.basileusId, themeId, appointeeId);
    } else if (titleType === 'BISHOP' && themeId) {
      result = appointBishop(state, state.basileusId, themeId, appointeeId);
    }

    if (!result?.ok) return fail(result?.reason || 'Could not complete that appointment.');
    state.courtActions.basileusAppointed = true;
    return {
      ok: true,
      observation: {
        type: 'appointment',
        actorId: state.basileusId,
        appointeeId,
        previousHolderId,
        value: (titleType === 'EMPRESS' || titleType === 'CHIEF_EUNUCHS') ? 1.2 : 1.0,
      },
    };
  }

  if (action === 'appoint-strategos') {
    const titleKey = String(payload.titleKey || '').trim();
    const themeId = String(payload.themeId || '').trim();
    const appointeeId = Number(payload.appointeeId);
    if (!Number.isInteger(appointeeId) || !getPlayer(state, appointeeId)) {
      return fail('Choose an appointee.');
    }
    const region = { DOM_EAST: 'east', DOM_WEST: 'west', ADMIRAL: 'sea' }[titleKey];
    const theme = state.themes[themeId];
    if (!theme || theme.region !== region) return fail('Choose a valid strategos province.');

    const previousHolderId = theme.strategos;
    const result = appointStrategos(state, playerId, themeId, appointeeId);
    if (!result?.ok) return fail(result?.reason || 'Could not appoint that strategos.');

    state.courtActions[`${titleKey}_appointed`] = true;
    if (titleKey === 'DOM_EAST') state.courtActions.domesticEastAppointed = true;
    if (titleKey === 'DOM_WEST') state.courtActions.domesticWestAppointed = true;
    if (titleKey === 'ADMIRAL') state.courtActions.admiralAppointed = true;
    return {
      ok: true,
      observation: { type: 'appointment', actorId: playerId, appointeeId, previousHolderId, value: 0.95 },
    };
  }

  if (action === 'appoint-bishop') {
    const themeId = String(payload.themeId || '').trim();
    const appointeeId = Number(payload.appointeeId);
    if (!Number.isInteger(appointeeId) || !getPlayer(state, appointeeId)) {
      return fail('Choose an appointee.');
    }
    const previousHolderId = state.themes[themeId]?.bishop ?? null;
    const result = appointBishop(state, playerId, themeId, appointeeId);
    if (!result?.ok) return fail(result?.reason || 'Could not appoint that bishop.');

    state.courtActions.patriarchAppointed = true;
    return {
      ok: true,
      observation: { type: 'appointment', actorId: playerId, appointeeId, previousHolderId, value: 1.0 },
    };
  }

  if (action === 'revoke') {
    const value = String(payload.value || '').trim();
    const parts = value.split(':');
    const kind = parts[0];

    if (kind === 'major') {
      return fail('Major titles can only be reassigned during the post-coup purge.');
    }

    // Authority: Basileus may revoke minor titles and estates. Patriarch may revoke bishops.
    // Regional commanders (Domestic East/West, Admiral) may revoke strategoi in
    // their region. All other revocations are restricted to the Basileus.
    const isBasileus = playerId === state.basileusId;
    if (!isBasileus) {
      if (kind === 'minor' && parts[2] === 'bishop') {
        if (!canPlayerRevokeBishop(state, playerId)) return fail('Only the Basileus or the Patriarch can revoke a bishop.');
      } else if (kind === 'minor' && parts[2] === 'strategos') {
        if (!canPlayerRevokeStrategos(state, playerId, parts[1])) return fail('You do not command this theme — only its regional title-holder or the Basileus can revoke its strategos.');
      } else {
        return fail('Only the Basileus can perform this revocation.');
      }
    }

    let observation = { type: 'revocation', actorId: playerId };

    if (kind === 'minor') {
      const theme = state.themes[parts[1]];
      const targetPlayerId = parts[2] === 'strategos' ? theme?.strategos ?? null : theme?.bishop ?? null;
      const sameTurnAppointmentCheck = checkRevocationCurrentTurnAppointment(state, action.value);
      if (!sameTurnAppointmentCheck.ok) return fail(sameTurnAppointmentCheck.reason);
      if (targetPlayerId != null && isPlayerProtectedFromRevocation(state, playerId, targetPlayerId)) {
        return fail(`${playerLabel(state, targetPlayerId)} is protected by an accepted non-revocation deal.`);
      }
      const patriarchGoldRevocation = !isBasileus && parts[2] === 'bishop' && canPlayerRevokeBishop(state, playerId);
      const costCheck = patriarchGoldRevocation
        ? canPayPatriarchBishopRevocationCost(state, playerId, targetPlayerId)
        : canPayRevocationCost(state, playerId);
      if (!costCheck.ok) {
        return fail(costCheck.reason || `You need ${costCheck.cost} troop${costCheck.cost === 1 ? '' : 's'} to revoke (have ${costCheck.available || 0}).`);
      }
      const result = revokeMinorTitle(state, parts[1], parts[2], playerId);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that minor title.');
      observation = { ...observation, targetPlayerId };
    } else if (kind === 'court') {
      const targetPlayerId = parts[1] === 'EMPRESS' ? state.empress : state.chiefEunuchs;
      const sameTurnAppointmentCheck = checkRevocationCurrentTurnAppointment(state, action.value);
      if (!sameTurnAppointmentCheck.ok) return fail(sameTurnAppointmentCheck.reason);
      if (targetPlayerId != null && isPlayerProtectedFromRevocation(state, playerId, targetPlayerId)) {
        return fail(`${playerLabel(state, targetPlayerId)} is protected by an accepted non-revocation deal.`);
      }
      const costCheck = canPayRevocationCost(state, playerId);
      if (!costCheck.ok) {
        return fail(`You need ${costCheck.cost} troop${costCheck.cost === 1 ? '' : 's'} to revoke (have ${costCheck.available || 0}).`);
      }
      const result = revokeCourtTitle(state, parts[1], playerId);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that court title.');
      observation = { ...observation, targetPlayerId };
    } else if (kind === 'theme') {
      const targetPlayerId = state.themes[parts[1]]?.owner ?? null;
      const sameTurnAppointmentCheck = checkRevocationCurrentTurnAppointment(state, action.value);
      if (!sameTurnAppointmentCheck.ok) return fail(sameTurnAppointmentCheck.reason);
      if (targetPlayerId != null && isPlayerProtectedFromRevocation(state, playerId, targetPlayerId)) {
        return fail(`${playerLabel(state, targetPlayerId)} is protected by an accepted non-revocation deal.`);
      }
      const costCheck = canPayRevocationCost(state, playerId);
      if (!costCheck.ok) {
        return fail(`You need ${costCheck.cost} troop${costCheck.cost === 1 ? '' : 's'} to revoke (have ${costCheck.available || 0}).`);
      }
      const result = revokeTheme(state, parts[1], playerId);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that estate.');
      observation = { ...observation, targetPlayerId };
    } else {
      return fail('Choose a valid revocation target.');
    }

    return { ok: true, observation };
  }

  return fail('Unknown court action.');
}

export function confirmCourt(state, playerId) {
  if (state.phase !== 'court') return fail('Court confirmation is not available right now.');
  if (state.courtActions?.playerConfirmed?.has(playerId)) return fail('Court actions already confirmed.');
  passMandatoryAppointmentsForPlayer(state, playerId);
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

// ─── Order submission ──────────────────────────────────────────────────────
// Single source of truth for human order locking: validates the deployment plan
// and candidate, then seals the orders.
export function submitHumanOrders(state, playerId, orders) {
  if (state.phase !== 'orders') return fail('Orders cannot be submitted right now.');
  if (state.allOrders?.[playerId]) return fail('Orders are already locked for this seat.');

  const normalized = normalizeHumanOrders(state, playerId, orders);
  if (!normalized.ok) return fail(normalized.reason || 'Invalid orders.');
  submitOrders(state, playerId, normalized.orders);
  return { ok: true, orders: normalized.orders, totalCost: normalized.totalCost };
}

// ─── Resolution / title reassignment ───────────────────────────────────────
// Applies a manual reassignment from a new Basileus. When aiMeta is provided,
// observes each appointment so AI relations stay in sync.
export function applyManualTitleReassignment(state, aiMeta, newBasileusId, titleAssignments) {
  if (newBasileusId == null || newBasileusId === state.basileusId) return { ok: true };

  const validation = validateMajorTitleAssignments(state, newBasileusId, titleAssignments);
  if (!validation?.ok) return validation || fail('Invalid major title assignments.');

  const previousAssignments = {};
  for (const player of state.players) {
    for (const titleKey of player.majorTitles) {
      previousAssignments[titleKey] = player.id;
    }
  }
  applyCoupTitleReassignment(state, newBasileusId, titleAssignments);

  if (aiMeta) {
    for (const [titleKey, appointeeId] of Object.entries(titleAssignments)) {
      observeCourtAction(state, aiMeta, {
        type: 'appointment',
        actorId: newBasileusId,
        appointeeId: Number(appointeeId),
        previousHolderId: previousAssignments[titleKey] ?? null,
        value: 1.25,
      });
    }
  }
  return { ok: true };
}
