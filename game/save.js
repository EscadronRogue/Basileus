// game/save.js - serialise and restore a live match: the full game state,
// including the seeded RNG position, plus the AI seat metadata.
//
// Shared by multiplayer save files and the browser's local autosave.
import { buildAdjacency } from '../data/provinces.js';
import { isCurrentRulesVersion, makeRng } from '../engine/state.js';

export const OUTDATED_SAVE_MESSAGE = "This save uses older rules and can't be continued.";

export function isSaveStateCurrent(rawState) {
  return isCurrentRulesVersion(rawState);
}
import { clonePlain, hydrateCourtActions, serializeCourtActions } from '../engine/publicState.js';
import { createAIMeta } from '../ai/brain.js';

const PUBLIC_LOG_LIMIT = 80;

// The province adjacency map holds Sets and is static data, so it is rebuilt on
// restore instead of being saved (JSON would flatten each Set to {}).
export function serializeGameState(state) {
  const { rng, courtActions, adjacency, ...rest } = state;
  void adjacency;
  return {
    ...clonePlain(rest),
    rngState: typeof rng?.getState === 'function' ? rng.getState() : 0,
    courtActions: serializeCourtActions(courtActions),
  };
}

export function hydrateGameState(rawState) {
  if (!isSaveStateCurrent(rawState)) throw new Error(OUTDATED_SAVE_MESSAGE);
  const { rngState, courtActions, adjacency, ...rest } = clonePlain(rawState);
  void adjacency;
  return {
    ...rest,
    adjacency: buildAdjacency(),
    rng: makeRng(0, Number.isFinite(Number(rngState)) ? Number(rngState) : 0),
    courtActions: hydrateCourtActions(courtActions),
  };
}

// Drops runtime caches and the live opponent objects; opponents are reloaded
// by id (multiplayer) or from the saved setup (local games) on restore.
export function serializeAiMeta(aiMeta) {
  if (!aiMeta) return null;
  const {
    humanPlayerIds,
    decisionLog,
    fastCache,
    roundContext,
    opponent,
    ...rest
  } = aiMeta;
  void fastCache;
  void roundContext;
  void opponent;
  const plain = clonePlain(rest);
  if (plain.players) {
    for (const player of Object.values(plain.players)) {
      if (player && typeof player === 'object') delete player.opponent;
    }
  }
  return {
    ...plain,
    humanPlayerIds: [...(humanPlayerIds || new Set())],
    decisionLog: {
      lines: Array.isArray(decisionLog?.lines) ? decisionLog.lines.slice() : [],
    },
  };
}

// Rebuilds AI metadata for `aiPlayers` and restores what it observed so far.
// AI memory itself is derived from the game state, so nothing else is needed.
export function hydrateAiMeta(rawMeta, state, aiPlayers = {}) {
  if (!rawMeta) return null;
  const { humanPlayerIds = [], publicLog = [], totals = null } = clonePlain(rawMeta);
  const meta = createAIMeta(state, { humanPlayerIds, aiPlayers });
  meta.publicLog = Array.isArray(publicLog) ? publicLog.slice(-PUBLIC_LOG_LIMIT) : [];
  if (totals && typeof totals === 'object') meta.totals = totals;
  return meta;
}
