// engine/commands.js — shared command layer used by singleplayer and multiplayer.
// Each command returns { ok, reason?, observation? }. Mode adapters convert
// !ok into either a silent re-render (singleplayer) or a transport rejection
// (multiplayer). Observations feed AI relations (observeCourtAction).

import { recordHistoryEvent } from './history.js';
import { getPlayer, formatPlayerLabel } from './state.js';
import { submitOrders } from './turnflow.js';
import {
  applyCoupTitleReassignment,
  appointBishop,
  appointCourtTitle,
  appointStrategos,
  buyTheme,
  canPayRevocationCostFor,
  dismissProfessional,
  giftToChurch,
  grantTaxExemption,
  hireMercenaries,
  recruitProfessional,
  revokeCourtTitle,
  revokeMajorTitle,
  revokeMinorTitle,
  revokeTaxExemption,
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

// ─── Court actions ─────────────────────────────────────────────────────────
// Returns { ok, reason?, observation? }.
// observation is an AI-relations payload to be fed to observeCourtAction when
// the player is non-AI (i.e. the action came from a human seat).
export function applyCourtAction(state, playerId, payload = {}) {
  const action = String(payload.action || '').trim();

  if (action === 'buy') {
    const result = buyTheme(state, playerId, payload.themeId);
    if (!result?.ok) return fail(result?.reason || 'Could not buy that theme.');
    return { ok: true };
  }

  if (action === 'gift') {
    const result = giftToChurch(state, playerId, payload.themeId);
    if (!result?.ok) return fail(result?.reason || 'Could not gift that theme.');
    return { ok: true };
  }

  if (action === 'exempt') {
    const result = grantTaxExemption(state, playerId, payload.themeId);
    if (!result?.ok) return fail(result?.reason || 'Could not buy that tax exemption.');
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

  if (action === 'hire-mercs') {
    const count = Math.max(0, Number(payload.count) || 0);
    if (count <= 0) return fail('Choose at least one mercenary.');
    const result = hireMercenaries(state, playerId, count);
    if (!result?.ok) return fail(result?.reason || 'Could not hire those mercenaries.');
    return { ok: true };
  }

  if (action === 'basileus-appoint') {
    if (playerId !== state.basileusId) return fail('Only the Basileus can use this appointment.');

    const titleType = payload.titleType;
    const appointeeId = Number(payload.appointeeId);
    const themeId = payload.themeId || null;

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
    const region = { DOM_EAST: 'east', DOM_WEST: 'west', ADMIRAL: 'sea' }[titleKey];
    const theme = state.themes[themeId];
    if (!theme || theme.region !== region) return fail('Choose a valid strategos theme.');

    const previousHolderId = theme.strategos;
    const result = appointStrategos(state, playerId, themeId, appointeeId);
    if (!result?.ok) return fail(result?.reason || 'Could not appoint that strategos.');

    return {
      ok: true,
      observation: { type: 'appointment', actorId: playerId, appointeeId, previousHolderId, value: 0.95 },
    };
  }

  if (action === 'appoint-bishop') {
    const themeId = String(payload.themeId || '').trim();
    const appointeeId = Number(payload.appointeeId);
    const previousHolderId = state.themes[themeId]?.bishop ?? null;
    const result = appointBishop(state, playerId, themeId, appointeeId);
    if (!result?.ok) return fail(result?.reason || 'Could not appoint that bishop.');

    return {
      ok: true,
      observation: { type: 'appointment', actorId: playerId, appointeeId, previousHolderId, value: 1.0 },
    };
  }

  if (action === 'revoke') {
    if (playerId !== state.basileusId) return fail('Only the Basileus can revoke titles or land.');

    const value = String(payload.value || '').trim();
    const parts = value.split(':');
    let observation = { type: 'revocation', actorId: state.basileusId };

    // Compute target player up front so the cost check honors the self/other
    // rule (self-revoke is free).
    const resolveTargetPlayerId = () => {
      if (parts[0] === 'major') return Number(parts[1]);
      if (parts[0] === 'minor') {
        const theme = state.themes[parts[1]];
        return parts[2] === 'strategos' ? theme?.strategos ?? null : theme?.bishop ?? null;
      }
      if (parts[0] === 'court') return parts[1] === 'EMPRESS' ? state.empress : state.chiefEunuchs;
      if (parts[0] === 'exempt') return state.themes[parts[1]]?.owner ?? null;
      if (parts[0] === 'theme') return state.themes[parts[1]]?.owner ?? null;
      return null;
    };
    const targetPlayerId = resolveTargetPlayerId();
    const costCheck = canPayRevocationCostFor(state, targetPlayerId);
    if (!costCheck.ok) {
      const need = costCheck.cost;
      return fail(`The Basileus needs ${need} troop${need === 1 ? '' : 's'} to revoke (has ${costCheck.available || 0}).`);
    }

    if (parts[0] === 'major') {
      const revokedPlayerId = Number(parts[1]);
      const titleKey = parts[2];
      const eligible = state.players.filter((candidate) =>
        candidate.id !== state.basileusId && candidate.id !== revokedPlayerId
      );
      if (eligible.length === 0) return fail('No eligible recipient exists for that major office.');
      const newHolderId = eligible[0].id;
      const result = revokeMajorTitle(state, revokedPlayerId, titleKey, newHolderId);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that major title.');
      observation = { ...observation, targetPlayerId: revokedPlayerId, newHolderId };
    } else if (parts[0] === 'minor') {
      const result = revokeMinorTitle(state, parts[1], parts[2]);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that minor title.');
      observation = { ...observation, targetPlayerId };
    } else if (parts[0] === 'court') {
      const result = revokeCourtTitle(state, parts[1]);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that court title.');
      observation = { ...observation, targetPlayerId };
    } else if (parts[0] === 'exempt') {
      const result = revokeTaxExemption(state, parts[1]);
      if (!result?.ok) return fail(result?.reason || 'Could not revoke that tax exemption.');
    } else if (parts[0] === 'theme') {
      const result = revokeTheme(state, parts[1]);
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
  state.courtActions.playerConfirmed.add(playerId);
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
// Single source of truth for human order locking. Mercenaries are hired during
// court; order submission only seals deployments and the throne vote.
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
