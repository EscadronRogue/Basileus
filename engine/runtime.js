// engine/runtime.js — shared AI/phase automation used by singleplayer and multiplayer.
// One authoritative game runtime; mode adapters (UI controller, server room) only handle
// transport, rendering, and authorization on top of these primitives.

import { getPlayer } from './state.js';
import {
  advanceToNextInteractivePhase,
  allOrdersSubmitted,
  isCourtComplete,
  phaseOrders,
  phaseResolution,
  submitOrders,
} from './turnflow.js';
import {
  applyAIOrderCosts,
  buildAIOrders,
  handlePostResolutionAI,
  invalidateRoundContext,
  isAIPlayer,
  runAICourtAutomation,
} from '../ai/brain.js';

// Auto-resolves mandatory court appointments that cannot be filled — e.g. when
// no eligible target exists for a Strategos slot the player holds. Singleplayer
// calls this for the active human at render-time; multiplayer calls it when a
// human submits a court command.
export function autoResolveUnavailableHumanAppointments(state, playerId) {
  if (!state || state.phase !== 'court') return;
  const player = getPlayer(state, playerId);
  if (!player) return;

  const hasOpenStrategos = (region = null) => Object.values(state.themes).some((theme) =>
    !theme.occupied
    && theme.id !== 'CPL'
    && theme.owner !== 'church'
    && theme.strategos === null
    && (region == null || theme.region === region)
  );
  const hasOpenBishop = () => Object.values(state.themes).some((theme) =>
    !theme.occupied
    && theme.id !== 'CPL'
    && !theme.bishopIsDonor
    && theme.bishop === null
  );

  if (playerId === state.basileusId && !state.courtActions?.basileusAppointed) {
    const canAppointMinor =
      state.empress === null
      || state.chiefEunuchs === null
      || hasOpenStrategos()
      || hasOpenBishop();
    if (!canAppointMinor) state.courtActions.basileusAppointed = true;
  }

  if (player.majorTitles.includes('DOM_EAST') && !state.courtActions?.domesticEastAppointed && !hasOpenStrategos('east')) {
    state.courtActions.domesticEastAppointed = true;
    state.courtActions.DOM_EAST_appointed = true;
  }
  if (player.majorTitles.includes('DOM_WEST') && !state.courtActions?.domesticWestAppointed && !hasOpenStrategos('west')) {
    state.courtActions.domesticWestAppointed = true;
    state.courtActions.DOM_WEST_appointed = true;
  }
  if (player.majorTitles.includes('ADMIRAL') && !state.courtActions?.admiralAppointed && !hasOpenStrategos('sea')) {
    state.courtActions.admiralAppointed = true;
    state.courtActions.ADMIRAL_appointed = true;
  }
  if (player.majorTitles.includes('PATRIARCH') && !state.courtActions?.patriarchAppointed && !hasOpenBishop()) {
    state.courtActions.patriarchAppointed = true;
  }
}

export function maybeAdvanceCourt(state, aiMeta = null) {
  if (state && isCourtComplete(state)) {
    phaseOrders(state);
    if (aiMeta) invalidateRoundContext(aiMeta);
  }
}

// Drives AI through their automated phases (court, orders) and auto-advances
// non-interactive phases. Returns the planned AI title assignment when a
// resolution requires title reassignment; otherwise null. Callers own the
// re-entry guard (aiBusy) so they can avoid recursive entry from callbacks.
export function processAiFlow(state, aiMeta, options = {}) {
  if (!aiMeta || !state) return null;
  const courtMode = options.courtMode || 'finish';
  let pendingAiTitleAssignment = options.pendingAiTitleAssignment ?? null;

  let safety = 0;
  while (safety < 20) {
    safety += 1;

    if (state.gameOver || state.phase === 'scoring' || state.phase === 'resolution') break;

    if (state.phase === 'court') {
      runAICourtAutomation(state, aiMeta, { mode: courtMode });
      if (courtMode === 'finish' && isCourtComplete(state)) {
        phaseOrders(state);
        invalidateRoundContext(aiMeta);
        continue;
      }
      break;
    }

    if (state.phase === 'orders') {
      for (const player of state.players) {
        if (!isAIPlayer(aiMeta, player.id)) continue;
        if (state.allOrders[player.id]) continue;
        const orders = buildAIOrders(state, aiMeta, player.id);
        applyAIOrderCosts(state, aiMeta, player.id, orders);
        submitOrders(state, player.id, orders);
      }

      if (allOrdersSubmitted(state)) {
        const previousBasileusId = state.basileusId;
        phaseResolution(state);
        const aftermath = handlePostResolutionAI(state, aiMeta, {
          previousBasileusId,
          autoApplyTitleAssignments: false,
        });
        pendingAiTitleAssignment = aftermath.plannedAssignment;
      }
      break;
    }

    advanceToNextInteractivePhase(state);
  }

  return { pendingAiTitleAssignment };
}
