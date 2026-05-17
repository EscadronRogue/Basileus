import { makeRng } from '../engine/state.js';

export function makeConstantRng(sample = 0.5) {
  const value = Math.max(0, Math.min(0.999999, Number(sample) || 0));
  const rng = () => value;
  rng.getState = () => 0;
  rng.setState = () => {};
  return rng;
}

function cloneCourtActions(courtActions = null) {
  if (!courtActions) return courtActions;
  return {
    ...courtActions,
    playerConfirmed: new Set([...(courtActions.playerConfirmed || new Set())]),
  };
}

function cloneRng(state, options = {}) {
  if (Number.isFinite(Number(options.rngSample))) {
    return makeConstantRng(Number(options.rngSample));
  }
  if (typeof state?.rng?.getState === 'function') {
    return makeRng(0, state.rng.getState());
  }
  return makeConstantRng(0.5);
}

export function cloneAiState(state, options = {}) {
  const clone = JSON.parse(JSON.stringify(state));
  clone.rng = cloneRng(state, options);
  clone.adjacency = state?.adjacency || clone.adjacency;
  clone.courtActions = cloneCourtActions(state?.courtActions);

  if (options.resetOrders) clone.allOrders = {};
  if (options.disableHistory !== false) {
    clone.historyEnabled = false;
    clone.history = null;
  }

  return clone;
}

export function stableActionKey(action = {}) {
  return JSON.stringify({
    kind: action.kind || '',
    playerId: action.playerId ?? null,
    payload: action.payload || null,
    orders: action.orders || null,
    assignments: action.assignments || null,
    rewardId: action.rewardId || null,
    choice: action.choice || null,
  });
}
