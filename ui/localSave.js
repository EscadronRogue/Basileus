// ui/localSave.js - one autosave slot for single-player and hotseat games,
// kept in this browser's localStorage so a refresh or closed tab can resume.
import { getMapDefinition } from '../data/maps/index.js';
import {
  OUTDATED_SAVE_MESSAGE,
  hydrateAiMeta,
  hydrateGameState,
  isSaveStateCurrent,
  serializeAiMeta,
  serializeGameState,
} from '../game/save.js';

export { OUTDATED_SAVE_MESSAGE };

// A save made under older rules is still listed, so the player learns why it
// cannot be continued, but only Discard is offered.
export function isLocalSaveOutdated(save) {
  return !isSaveStateCurrent(save?.gameState);
}

export const LOCAL_SAVE_KEY = 'basileus.localGame';
export const LOCAL_SAVE_SCHEMA = 'basileus.local.save';
export const LOCAL_SAVE_VERSION = 1;

function getStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function buildLocalSave(controller) {
  return {
    schema: LOCAL_SAVE_SCHEMA,
    version: LOCAL_SAVE_VERSION,
    savedAt: new Date().toISOString(),
    config: controller.config,
    activePlayer: controller.activePlayer,
    pendingAiTitleAssignment: controller.pendingAiTitleAssignment ?? null,
    mapFilter: controller.uiState?.mapFilter ?? null,
    gameState: serializeGameState(controller.state),
    aiMeta: serializeAiMeta(controller.aiMeta),
    record: controller.record ?? null,
  };
}

// Returns false when the browser refuses to store the save (private mode,
// storage quota); the game keeps running either way.
export function writeLocalSave(save) {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(LOCAL_SAVE_KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

export function readLocalSave() {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const save = JSON.parse(storage.getItem(LOCAL_SAVE_KEY) || 'null');
    if (save?.schema !== LOCAL_SAVE_SCHEMA || save.version !== LOCAL_SAVE_VERSION) return null;
    if (!save.gameState || !save.config) return null;
    return save;
  } catch {
    return null;
  }
}

export function clearLocalSave() {
  try {
    getStorage()?.removeItem(LOCAL_SAVE_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function restoreLocalSaveState(save, aiPlayers) {
  const state = hydrateGameState(save.gameState);
  return { state, aiMeta: hydrateAiMeta(save.aiMeta, state, aiPlayers) };
}

// Short facts for the "continue your game" card on the setup screen.
export function describeLocalSave(save) {
  const state = save?.gameState || {};
  const config = save?.config || {};
  const humanIds = Array.isArray(config.humanPlayerIds) ? config.humanPlayerIds : [];
  const you = config.mode === 'single'
    ? (state.players || []).find((player) => player.id === humanIds[0])?.dynasty || null
    : null;
  return {
    mode: config.mode === 'single' ? 'Single player' : 'Hotseat',
    dynasty: you,
    round: Number(state.round) || 0,
    turnCount: Number(config.turnCount || config.deckSize) || null,
    playerCount: (state.players || []).length,
    mapName: getMapDefinition(state.mapId).name,
    savedAt: save?.savedAt || null,
  };
}

// The record of the last finished game (game/record.js), kept until the next
// one ends so it can still be downloaded from the setup screen.
export const LAST_RECORD_KEY = 'basileus.lastGameRecord';

export function writeLastGameRecord(record) {
  const storage = getStorage();
  if (!storage || !record) return false;
  try {
    storage.setItem(LAST_RECORD_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function readLastGameRecord() {
  const storage = getStorage();
  if (!storage) return null;
  try {
    return JSON.parse(storage.getItem(LAST_RECORD_KEY) || 'null');
  } catch {
    return null;
  }
}
