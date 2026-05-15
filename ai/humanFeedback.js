import { makeRng } from '../engine/state.js';
import { normalizeHumanOrders } from '../engine/orders.js';
import {
  listLegalActions,
  listLegalCourtActions,
  listLegalOrderActions,
  listLegalRewardActions,
  listLegalTitleAssignments,
} from './legalActions.js';
import { buildCandidateFeatures } from './features.js';

export const HUMAN_FEEDBACK_SCHEMA = 'basileus.human-feedback.v1';
const DEFAULT_MAX_SAMPLES = 1000;

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function serializeCourtActions(courtActions) {
  if (!courtActions) return null;
  return {
    ...clonePlain(courtActions),
    playerConfirmed: [...(courtActions.playerConfirmed || new Set())],
  };
}

function hydrateCourtActions(courtActions) {
  if (!courtActions) return null;
  return {
    ...clonePlain(courtActions),
    playerConfirmed: new Set(courtActions.playerConfirmed || []),
  };
}

export function serializeStateForHumanFeedback(state) {
  if (!state) return null;
  const { rng, courtActions, ...rest } = state;
  return {
    ...clonePlain(rest),
    rngState: typeof rng?.getState === 'function' ? rng.getState() : 0,
    courtActions: serializeCourtActions(courtActions),
  };
}

export function hydrateStateFromHumanFeedback(snapshot) {
  if (!snapshot) return null;
  const { rngState, courtActions, ...rest } = clonePlain(snapshot);
  return {
    ...rest,
    rng: makeRng(0, Number.isFinite(Number(rngState)) ? Number(rngState) : 0),
    courtActions: hydrateCourtActions(courtActions),
  };
}

function sortPlain(value) {
  if (Array.isArray(value)) return value.map(sortPlain);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortPlain(value[key])])
      .filter(([, entry]) => entry !== '' && entry != null),
  );
}

function stablePayload(value) {
  return JSON.stringify(sortPlain(value));
}

function findActionByPayload(actions, payload) {
  const target = stablePayload(payload);
  return actions.find((action) => stablePayload(action.payload || {}) === target) || null;
}

function createSample(state, playerId, action, source = 'human') {
  if (!state || !action) return null;
  return {
    source,
    round: state.round || 0,
    phase: state.phase || action.phase || 'unknown',
    playerId,
    actionId: action.id,
    action: clonePlain(action),
    state: serializeStateForHumanFeedback(state),
    createdAt: new Date().toISOString(),
  };
}

export function createHumanCourtActionSample(state, playerId, payload = {}) {
  const actions = listLegalCourtActions(state, playerId, { includeDeals: true });
  return createSample(state, playerId, findActionByPayload(actions, payload));
}

export function createHumanCourtConfirmationSample(state, playerId) {
  const action = listLegalCourtActions(state, playerId, { includeDeals: true })
    .find((entry) => entry.kind === 'court-confirm');
  return createSample(state, playerId, action);
}

export function createHumanOrdersSample(state, playerId, orders = {}) {
  const normalized = normalizeHumanOrders(state, playerId, orders, { resolveImpossibleLocks: true });
  if (!normalized.ok) return null;
  const key = stablePayload(normalized.orders);
  const action = listLegalOrderActions(state, playerId)
    .find((entry) => stablePayload(entry.orders) === key);
  return createSample(state, playerId, action);
}

export function createHumanRewardSample(state, playerId, rewardId, choice) {
  const action = listLegalRewardActions(state, playerId)
    .find((entry) => entry.rewardId === rewardId && entry.choice === choice);
  return createSample(state, playerId, action);
}

export function createHumanTitleAssignmentSample(state, playerId, assignments = {}) {
  const key = stablePayload(assignments);
  const action = listLegalTitleAssignments(state, playerId)
    .find((entry) => stablePayload(entry.assignments) === key);
  return createSample(state, playerId, action);
}

export function appendHumanFeedbackSample(meta, sample, options = {}) {
  if (!meta || !sample) return false;
  if (!meta.humanFeedback || meta.humanFeedback.schema !== HUMAN_FEEDBACK_SCHEMA) {
    meta.humanFeedback = {
      schema: HUMAN_FEEDBACK_SCHEMA,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      samples: [],
    };
  }
  meta.humanFeedback.samples.push(sample);
  const maxSamples = Math.max(1, Math.floor(Number(options.maxSamples) || DEFAULT_MAX_SAMPLES));
  if (meta.humanFeedback.samples.length > maxSamples) {
    meta.humanFeedback.samples.splice(0, meta.humanFeedback.samples.length - maxSamples);
  }
  meta.humanFeedback.updatedAt = new Date().toISOString();
  return true;
}

export function exportHumanFeedbackPayload(meta, metadata = {}) {
  const feedback = meta?.humanFeedback;
  return {
    schema: HUMAN_FEEDBACK_SCHEMA,
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: clonePlain(metadata),
    samples: Array.isArray(feedback?.samples) ? clonePlain(feedback.samples) : [],
  };
}

function actionFallbackKey(action = {}) {
  if (action.kind === 'court') return stablePayload(action.payload || {});
  if (action.kind === 'orders') return stablePayload(action.orders || {});
  if (action.kind === 'reward') return stablePayload({ rewardId: action.rewardId, choice: action.choice });
  if (action.kind === 'title-assignment') return stablePayload(action.assignments || {});
  return action.id || '';
}

function findSampleAction(state, sample) {
  const actions = listLegalActions(state, sample.playerId, { includeDeals: true });
  let chosenIndex = actions.findIndex((action) => action.id === sample.actionId);
  if (chosenIndex < 0 && sample.action) {
    const fallback = actionFallbackKey(sample.action);
    chosenIndex = actions.findIndex((action) => actionFallbackKey(action) === fallback);
  }
  return { actions, chosenIndex };
}

export function humanFeedbackSamplesToTransitions(samples = [], options = {}) {
  const targetReturn = Number.isFinite(Number(options.returnValue)) ? Number(options.returnValue) : 0.75;
  const transitions = [];
  for (const sample of samples || []) {
    const state = hydrateStateFromHumanFeedback(sample.state);
    if (!state) continue;
    const { actions, chosenIndex } = findSampleAction(state, sample);
    if (chosenIndex < 0 || !actions.length) continue;
    transitions.push({
      playerId: sample.playerId,
      features: buildCandidateFeatures(state, sample.playerId, actions),
      chosenIndex,
      return: targetReturn,
      source: sample.source || 'human',
    });
  }
  return transitions;
}
