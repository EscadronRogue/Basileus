// engine/runtime.js — single source of truth for live game progression.
// Mode adapters may authorize users, project visibility, render, broadcast, or
// reconnect. They must not reimplement court, orders, AI timing, resolution, or
// phase advancement semantics.

import {
  advanceToNextInteractivePhase,
  applyDefenderRewardChoice,
  allOrdersSubmitted,
  getPendingDefenderRewards,
  hasPendingDefenderRewards,
  isCourtComplete,
  phaseCleanup,
  phaseOrders,
  phaseResolution,
  submitOrders,
} from './turnflow.js';
import { getPlayer } from './state.js';
import {
  applyCourtAction,
  applyManualTitleReassignment,
  confirmCourt,
  submitHumanOrders,
} from './commands.js';
import {
  applyPlannedAiTitleAssignment,
  buildAIOrders,
  chooseAIDefenderRewardChoice,
  handlePostResolutionAI,
  invalidateRoundContext,
  isAIPlayer,
  observeCourtAction,
  runAICourtAutomation,
} from '../ai/brain.js';

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function ensureRuntimeContext(context = {}) {
  if (!Object.prototype.hasOwnProperty.call(context, 'pendingAiTitleAssignment')) {
    context.pendingAiTitleAssignment = null;
  }
  return context;
}

function writePending(context, result) {
  if (result && Object.prototype.hasOwnProperty.call(result, 'pendingAiTitleAssignment')) {
    ensureRuntimeContext(context).pendingAiTitleAssignment = result.pendingAiTitleAssignment;
  }
  return result;
}

function recordDefenderRewardsForTraining(meta, rewards = []) {
  if (!meta || !Array.isArray(rewards)) return;
  if (!meta.totals) meta.totals = {};
  if (!Number.isFinite(meta.totals.defenderRewards)) meta.totals.defenderRewards = 0;
  if (!Number.isFinite(meta.totals.defenderGoldChoices)) meta.totals.defenderGoldChoices = 0;
  if (!Number.isFinite(meta.totals.defenderRestoreChoices)) meta.totals.defenderRestoreChoices = 0;
  if (!Number.isFinite(meta.totals.defenderRewardGold)) meta.totals.defenderRewardGold = 0;
  for (const reward of rewards) {
    const playerMeta = meta.players?.[reward.defenderId];
    if (!playerMeta) continue;
    if (!playerMeta.stats) playerMeta.stats = {};
    playerMeta.stats.defenderRewards = (Number(playerMeta.stats.defenderRewards) || 0) + 1;
    meta.totals.defenderRewards += 1;
    if (reward.choice === 'gold') {
      playerMeta.stats.defenderGoldChoices = (Number(playerMeta.stats.defenderGoldChoices) || 0) + 1;
      playerMeta.stats.defenderRewardGold = (Number(playerMeta.stats.defenderRewardGold) || 0) + (Number(reward.gold) || 0);
      meta.totals.defenderGoldChoices += 1;
      meta.totals.defenderRewardGold += Number(reward.gold) || 0;
    } else if (reward.choice === 'empire') {
      playerMeta.stats.defenderRestoreChoices = (Number(playerMeta.stats.defenderRestoreChoices) || 0) + 1;
      meta.totals.defenderRestoreChoices += 1;
    }
  }
}

function autoResolveAiDefenderRewards(state, meta) {
  if (!state || !meta) return [];
  const resolved = [];
  let safety = 0;
  while (safety < 20) {
    safety += 1;
    const reward = getPendingDefenderRewards(state).find((entry) => isAIPlayer(meta, entry.defenderId));
    if (!reward) break;
    const choice = chooseAIDefenderRewardChoice(state, meta, reward);
    let result = applyDefenderRewardChoice(state, reward.id, reward.defenderId, choice);
    if (!result.ok && choice !== 'empire') {
      result = applyDefenderRewardChoice(state, reward.id, reward.defenderId, 'empire');
    }
    if (!result.ok) break;
    resolved.push(result.reward);
  }
  recordDefenderRewardsForTraining(meta, resolved);
  return resolved;
}

// Auto-resolves mandatory court appointments that cannot be filled — e.g. when
// no eligible target exists for a Strategos slot the player holds. It is always
// scoped to the acting human player. Multiplayer must not sweep every human seat
// here, because singleplayer only resolves the currently controlled dynasty.
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
    && (Number(theme.C) || 0) >= 1
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
// resolution requires title reassignment; otherwise null.
export function processAiFlow(state, aiMeta, options = {}) {
  if (!aiMeta || !state) return { pendingAiTitleAssignment: options.pendingAiTitleAssignment ?? null };
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

export function processPostHumanAction(state, aiMeta, options = {}) {
  if (!aiMeta || !state) return { pendingAiTitleAssignment: options.pendingAiTitleAssignment ?? null };
  if (options.observation) observeCourtAction(state, aiMeta, options.observation);
  else invalidateRoundContext(aiMeta);
  return processAiFlow(state, aiMeta, options);
}

export function applyPendingAiTitleAssignment(state, aiMeta, pendingAiTitleAssignment = null) {
  if (!pendingAiTitleAssignment || !aiMeta) return null;
  applyPlannedAiTitleAssignment(
    state,
    aiMeta,
    pendingAiTitleAssignment,
    state.nextBasileusId,
  );
  return null;
}

export function continueAfterResolution(state, aiMeta, pendingAiTitleAssignment = null) {
  if (!state || state.phase !== 'resolution') {
    return { ok: false, reason: 'Continue is only available during resolution.', pendingAiTitleAssignment };
  }

  applyPendingAiTitleAssignment(state, aiMeta, pendingAiTitleAssignment);
  autoResolveAiDefenderRewards(state, aiMeta);
  if (hasPendingDefenderRewards(state)) {
    return { ok: false, reason: 'Resolve all best-defender rewards before continuing.', pendingAiTitleAssignment };
  }

  phaseCleanup(state);
  advanceToNextInteractivePhase(state);
  if (aiMeta) invalidateRoundContext(aiMeta);
  return { ok: true, pendingAiTitleAssignment: null };
}

export function startInteractiveRuntime(state, aiMeta = null, context = {}) {
  ensureRuntimeContext(context);
  advanceToNextInteractivePhase(state);
  if (!aiMeta || state.phase !== 'court') {
    writePending(context, processAiFlow(state, aiMeta, {
      pendingAiTitleAssignment: context.pendingAiTitleAssignment,
      courtMode: 'finish',
    }));
  }
  return { ok: true, pendingAiTitleAssignment: context.pendingAiTitleAssignment };
}

export function runAiRuntime(state, aiMeta, context = {}, options = {}) {
  ensureRuntimeContext(context);
  return writePending(context, processAiFlow(state, aiMeta, {
    ...options,
    pendingAiTitleAssignment: context.pendingAiTitleAssignment,
  }));
}

export function handleHumanCourtAction(state, aiMeta, context = {}, playerId, payload = {}, options = {}) {
  ensureRuntimeContext(context);
  if (!state || state.phase !== 'court') return fail('Court actions are not available right now.');
  if (state.courtActions?.playerConfirmed?.has(playerId)) return fail('You already confirmed court actions this round.');

  autoResolveUnavailableHumanAppointments(state, playerId);
  const result = applyCourtAction(state, playerId, payload);
  if (!result.ok) return result;

  writePending(context, processPostHumanAction(state, aiMeta, {
    ...options,
    observation: result.observation || null,
    courtMode: options.finalize ? 'finish' : (options.courtMode || 'react'),
    pendingAiTitleAssignment: context.pendingAiTitleAssignment,
  }));
  if (!aiMeta) maybeAdvanceCourt(state, aiMeta);
  return { ...result, pendingAiTitleAssignment: context.pendingAiTitleAssignment };
}

export function handleHumanCourtConfirmation(state, aiMeta, context = {}, playerId, options = {}) {
  ensureRuntimeContext(context);
  autoResolveUnavailableHumanAppointments(state, playerId);
  const result = confirmCourt(state, playerId);
  if (!result.ok) return result;

  writePending(context, processPostHumanAction(state, aiMeta, {
    ...options,
    observation: null,
    courtMode: 'finish',
    pendingAiTitleAssignment: context.pendingAiTitleAssignment,
  }));
  if (!aiMeta) maybeAdvanceCourt(state, aiMeta);
  return { ...result, pendingAiTitleAssignment: context.pendingAiTitleAssignment };
}

export function handleHumanOrders(state, aiMeta, context = {}, playerId, orders = {}, options = {}) {
  ensureRuntimeContext(context);
  const result = submitHumanOrders(state, playerId, orders);
  if (!result.ok) return result;

  if (aiMeta) {
    writePending(context, processAiFlow(state, aiMeta, {
      ...options,
      pendingAiTitleAssignment: context.pendingAiTitleAssignment,
    }));
  } else if (allOrdersSubmitted(state)) {
    phaseResolution(state);
  }

  return { ...result, pendingAiTitleAssignment: context.pendingAiTitleAssignment };
}

export function handleManualTitleReassignment(state, aiMeta, context = {}, playerId, assignments = {}) {
  ensureRuntimeContext(context);
  if (!state || state.phase !== 'resolution') return fail('Major title reassignment is only allowed during resolution.');
  if (state.nextBasileusId === state.basileusId) return fail('No new Basileus needs to reassign titles.');
  if (playerId !== state.nextBasileusId) return fail('Only the new Basileus may assign major titles.');
  const result = applyManualTitleReassignment(state, aiMeta, playerId, assignments);
  if (!result.ok) return result;
  context.pendingAiTitleAssignment = null;
  return { ok: true, pendingAiTitleAssignment: null };
}

export function handleDefenderRewardChoice(state, aiMeta, context = {}, playerId, rewardId, choice) {
  ensureRuntimeContext(context);
  if (!state || state.phase !== 'resolution') return fail('Defender rewards are only available during resolution.');
  const result = applyDefenderRewardChoice(state, String(rewardId || ''), playerId, choice);
  if (!result.ok) return result;
  recordDefenderRewardsForTraining(aiMeta, [result.reward]);
  return { ok: true, pendingAiTitleAssignment: context.pendingAiTitleAssignment };
}

export function resolvePendingTitleReassignment(state, aiMeta, context = {}, assignments = null) {
  ensureRuntimeContext(context);
  if (context.pendingAiTitleAssignment && aiMeta) {
    context.pendingAiTitleAssignment = applyPendingAiTitleAssignment(state, aiMeta, context.pendingAiTitleAssignment);
    return { ok: true, pendingAiTitleAssignment: context.pendingAiTitleAssignment };
  }

  if (assignments) {
    return handleManualTitleReassignment(state, aiMeta, context, state.nextBasileusId, assignments);
  }

  return { ok: true, pendingAiTitleAssignment: context.pendingAiTitleAssignment };
}

export function handleContinueAfterResolution(state, aiMeta, context = {}, options = {}) {
  ensureRuntimeContext(context);
  const continuation = continueAfterResolution(state, aiMeta, context.pendingAiTitleAssignment);
  if (!continuation.ok) return continuation;
  context.pendingAiTitleAssignment = continuation.pendingAiTitleAssignment;

  // Singleplayer source of truth: after resolution, do not immediately run AI
  // court if the next interactive phase is court. AI reacts after a human court
  // action or confirmation instead of racing ahead at round start.
  if (aiMeta && state.phase !== 'court' && options.processAi !== false) {
    writePending(context, processAiFlow(state, aiMeta, {
      ...options,
      pendingAiTitleAssignment: context.pendingAiTitleAssignment,
    }));
  }

  return { ok: true, pendingAiTitleAssignment: context.pendingAiTitleAssignment };
}
