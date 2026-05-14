import {
  applyLegalAction,
  listLegalCourtActions,
  listLegalOrderActions,
  listLegalRewardActions,
  listLegalTitleAssignments,
} from './legalActions.js';
import { buildCandidateInputs } from './features.js';
import {
  deserializeNetwork,
  selectActionWithNetwork,
} from './network.js';

export const AI_MODEL_MISSING_MESSAGE = 'Neural AI model not found. Run npm run ai:train to create ai/models/latest.json.';
export const DEFAULT_BROWSER_MODEL_URL = 'ai/models/latest.json';

function normalizeHumanPlayerIds(playerCount, humanPlayerIds = []) {
  return new Set(
    [...new Set(humanPlayerIds.map(value => Number(value)))]
      .filter(value => Number.isInteger(value) && value >= 0 && value < playerCount),
  );
}

function createDecisionLog() {
  return {
    lines: [],
    push(message) {
      this.lines.push(message);
    },
  };
}

function createPlayerMeta(player, humanPlayerIds) {
  const isAI = !humanPlayerIds.has(player.id);
  return {
    playerId: player.id,
    isAI,
    displayName: isAI ? `AI Seat ${player.id + 1}` : null,
    stats: {},
  };
}

export function hydrateNeuralModel(rawModel) {
  if (!rawModel) return null;
  return deserializeNetwork(rawModel.network || rawModel);
}

function modelLoadError(url, detail = '') {
  return new Error(`${AI_MODEL_MISSING_MESSAGE} Could not load ${url}${detail ? `: ${detail}` : ''}.`);
}

export async function loadBrowserNeuralModel(url = DEFAULT_BROWSER_MODEL_URL, options = {}) {
  const required = Boolean(options.required);
  if (typeof fetch !== 'function') {
    if (required) throw modelLoadError(url, 'browser fetch is unavailable');
    return null;
  }
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      if (required) throw modelLoadError(url, `HTTP ${response.status}`);
      return null;
    }
    return hydrateNeuralModel(await response.json());
  } catch (error) {
    if (required) {
      if (error?.message?.startsWith(AI_MODEL_MISSING_MESSAGE)) throw error;
      throw modelLoadError(url, error?.message || 'request failed');
    }
    return null;
  }
}

export function createAIMeta(state, options = {}) {
  const humanPlayerIds = normalizeHumanPlayerIds(state?.players?.length || 0, options.humanPlayerIds || []);
  const players = {};
  for (const player of state?.players || []) {
    players[player.id] = createPlayerMeta(player, humanPlayerIds);
  }

  return {
    humanPlayerIds,
    players,
    model: options.model || null,
    neuralModelAvailable: Boolean(options.model),
    runtimeTemperature: Number.isFinite(Number(options.runtimeTemperature)) ? Number(options.runtimeTemperature) : 0,
    publicLog: [],
    decisionLog: createDecisionLog(),
    humanFeedback: options.humanFeedback || null,
    pendingNeuralRuntime: !options.model,
  };
}

export function setAIMetaModel(meta, model) {
  if (!meta) return meta;
  meta.model = model || null;
  meta.neuralModelAvailable = Boolean(model);
  meta.pendingNeuralRuntime = !model;
  return meta;
}

export function isAIPlayer(meta, playerId) {
  return Boolean(meta) && !meta.humanPlayerIds?.has(playerId);
}

export function invalidateRoundContext(meta) {
  if (!meta) return;
  meta.roundContext = null;
  meta.fastCache = null;
}

export function observeCourtAction(state, meta, observation = null) {
  if (!meta || !observation) return;
  const line = {
    round: state?.round || 0,
    phase: state?.phase || 'court',
    ...observation,
  };
  meta.publicLog.push(line);
  if (meta.publicLog.length > 80) meta.publicLog.splice(0, meta.publicLog.length - 80);
}

function requireModel(meta) {
  if (!meta?.model) throw new Error(AI_MODEL_MISSING_MESSAGE);
  return meta.model;
}

function getRng(state) {
  return typeof state?.rng === 'function' ? state.rng : Math.random;
}

function chooseNeuralAction(state, meta, playerId, actions, options = {}) {
  if (!actions.length) return null;
  const model = requireModel(meta);
  const inputs = buildCandidateInputs(state, playerId, actions);
  const selection = selectActionWithNetwork(model, inputs, getRng(state), {
    greedy: options.greedy ?? true,
    temperature: options.temperature ?? meta.runtimeTemperature ?? 0,
  });
  const action = actions[selection.index] || actions[0];
  meta.decisionLog?.push?.(`${action.phase}:${playerId}:${action.label}`);
  return action;
}

function confirmAction(actions) {
  return actions.find((action) => action.kind === 'court-confirm') || actions[actions.length - 1] || null;
}

function playableCourtActions(actions) {
  return actions.filter((action) => action.kind !== 'court-confirm');
}

export function runAICourtAutomation(state, meta, options = {}) {
  if (!state || state.phase !== 'court' || !meta) return { ok: true, actions: 0 };
  const mode = options.mode || 'finish';
  if (!meta.model && mode === 'react') return { ok: true, actions: 0, skipped: true };
  const maxActions = mode === 'react' ? 1 : Math.max(1, Number(options.maxActionsPerPlayer) || 10);
  let applied = 0;

  for (const player of state.players) {
    if (!isAIPlayer(meta, player.id)) continue;
    if (state.courtActions?.playerConfirmed?.has(player.id)) continue;

    for (let step = 0; step < maxActions; step += 1) {
      const actions = listLegalCourtActions(state, player.id);
      if (!actions.length) break;
      const actionCandidates = mode === 'react' ? playableCourtActions(actions) : actions;
      const action = step === maxActions - 1 && mode !== 'react'
        ? confirmAction(actions)
        : chooseNeuralAction(state, meta, player.id, actionCandidates.length ? actionCandidates : actions);
      if (!action) break;
      const result = applyLegalAction(state, action, meta);
      if (!result.ok) {
        const fallback = mode === 'react' ? null : confirmAction(actions);
        if (!fallback || fallback.id === action.id) break;
        const fallbackResult = applyLegalAction(state, fallback, meta);
        if (!fallbackResult.ok) break;
      }
      applied += 1;
      observeCourtAction(state, meta, {
        type: 'ai_action',
        actorId: player.id,
        action: action.label,
      });
      if (state.courtActions?.playerConfirmed?.has(player.id) || mode === 'react') break;
    }
  }

  return { ok: true, actions: applied };
}

export function buildAIOrders(state, meta, playerId) {
  const actions = listLegalOrderActions(state, playerId);
  const action = chooseNeuralAction(state, meta, playerId, actions);
  if (!action) throw new Error(`No legal order action available for AI player ${playerId}.`);
  return {
    ...action.orders,
    debug: {
      decision: {
        title: 'Neural order selection',
        factors: [
          { label: 'candidate actions', value: actions.length, impact: 'neutral', note: 'Chosen from engine-legal orders.' },
        ],
      },
    },
  };
}

export function chooseAIDefenderRewardChoice(state, meta, reward) {
  const actions = listLegalRewardActions(state, reward.defenderId)
    .filter((action) => action.rewardId === reward.id);
  const action = chooseNeuralAction(state, meta, reward.defenderId, actions);
  return action?.choice || 'empire';
}

export function planMajorTitleAssignment(state, meta, newBasileusId = state?.nextBasileusId) {
  const actions = listLegalTitleAssignments(state, newBasileusId);
  return chooseNeuralAction(state, meta, newBasileusId, actions);
}

export function applyPlannedAiTitleAssignment(state, meta, pendingAssignment = null, newBasileusId = state?.nextBasileusId) {
  const action = pendingAssignment?.kind === 'title-assignment'
    ? pendingAssignment
    : pendingAssignment
      ? {
        kind: 'title-assignment',
        phase: 'resolution',
        playerId: newBasileusId,
        newBasileusId,
        assignments: pendingAssignment.assignments || pendingAssignment,
        label: 'assign major titles',
      }
      : null;
  if (!action) return null;
  const result = applyLegalAction(state, action, meta);
  if (!result.ok) throw new Error(result.reason || 'AI title assignment failed validation.');
  return null;
}

export function handlePostResolutionAI(state, meta, options = {}) {
  const newBasileusId = state?.nextBasileusId;
  const previousBasileusId = options.previousBasileusId;
  let plannedAssignment = null;
  if (
    newBasileusId != null
    && newBasileusId !== previousBasileusId
    && isAIPlayer(meta, newBasileusId)
  ) {
    plannedAssignment = planMajorTitleAssignment(state, meta, newBasileusId);
    if (plannedAssignment && options.autoApplyTitleAssignments) {
      applyPlannedAiTitleAssignment(state, meta, plannedAssignment, newBasileusId);
      plannedAssignment = null;
    }
  }
  return { plannedAssignment };
}

export function getRecentPublicLog(meta, limit = 10) {
  return (meta?.publicLog || []).slice(-limit);
}
