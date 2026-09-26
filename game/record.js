// game/record.js - the record of a local game, kept for studying how humans
// play against the AIs.
//
// A record holds the setup (seed, map, the AI seats and their weights), every
// command the humans sent to the runtime, in order, the players' own notes, a
// short summary of each round, and at export the full game state, whose
// history carries every appointment, estate, order, war and coup, with each
// AI's reasons and hidden mood.
//
// Human commands go through RECORDED_CALLS both in the game and in a replay,
// so on the same code a replay rebuilds the game exactly and can stop before
// any human decision.
import { setDealParticipantIds } from '../engine/deals.js';
import { getProvinceEstateHolders } from '../engine/estates.js';
import { buildFinalScores } from '../engine/scoring.js';
import { RULES_VERSION, createGameState } from '../engine/state.js';
import { createAIMeta } from '../ai/brain.js';
import { buildAiPlayersFromSelections } from './aiSeats.js';
import {
  autoResolveUnavailableHumanAppointments,
  handleContinueAfterResolution,
  handleEstatesConfirmation,
  handleHumanCourtAction,
  handleHumanCourtConfirmation,
  handleHumanEstateAction,
  handleHumanOrders,
  handleManualTitleReassignment,
  resolvePendingTitleReassignment,
  settleAutomaticProgress,
  startInteractiveRuntime,
} from './runtime.js';
import { serializeAiMeta, serializeGameState } from './save.js';

export const GAME_RECORD_SCHEMA = 'basileus.game-record';
export const GAME_RECORD_VERSION = 1;

// Every runtime entry point a human reaches, by the name the record keeps.
export const RECORDED_CALLS = {
  courtAction: (state, aiMeta, context, playerId, args) => handleHumanCourtAction(state, aiMeta, context, playerId, args.payload),
  courtConfirm: (state, aiMeta, context, playerId) => handleHumanCourtConfirmation(state, aiMeta, context, playerId),
  autoResolveCourt: (state, aiMeta, context, playerId) => autoResolveUnavailableHumanAppointments(state, playerId, aiMeta, context),
  estateAction: (state, aiMeta, context, playerId, args) => handleHumanEstateAction(state, aiMeta, context, playerId, args.payload),
  estatesConfirm: (state, aiMeta, context, playerId) => handleEstatesConfirmation(state, aiMeta, context, playerId),
  titleRedistribution: (state, aiMeta, context, playerId, args) => handleManualTitleReassignment(state, aiMeta, context, playerId, args.assignments),
  orders: (state, aiMeta, context, playerId, args) => handleHumanOrders(state, aiMeta, context, playerId, args.orders),
  resolveTitleReassignment: (state, aiMeta, context, playerId, args) => (args.assignments
    ? resolvePendingTitleReassignment(state, aiMeta, context, args.assignments)
    : resolvePendingTitleReassignment(state, aiMeta, context)),
  continueAfterResolution: (state, aiMeta, context) => handleContinueAfterResolution(state, aiMeta, context),
  settle: (state, aiMeta, context) => settleAutomaticProgress(state, aiMeta, context),
};

function clonePlain(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

const NAME_FIELDS = ['firstName', 'isAIControlled', 'aiTemperament'];

// The names GameController gives the seats, kept as they were so a replay
// names them the same way.
function playerNames(state) {
  return (state?.players || []).map((player) => {
    const entry = { id: player.id };
    for (const field of NAME_FIELDS) {
      if (player[field] !== undefined) entry[field] = player[field];
    }
    return entry;
  });
}

function applyPlayerNames(state, names = []) {
  for (const entry of names || []) {
    const player = state.players.find((candidate) => candidate.id === entry.id);
    if (!player) continue;
    for (const field of NAME_FIELDS) {
      if (Object.hasOwn(entry, field)) player[field] = entry[field];
    }
  }
}

// Started once the players are named and before the runtime first runs.
export function createGameRecord(config, state) {
  const humanIds = new Set(config.humanPlayerIds || []);
  const selections = config.aiOpponentSelections || [];
  return {
    schema: GAME_RECORD_SCHEMA,
    version: GAME_RECORD_VERSION,
    rulesVersion: RULES_VERSION,
    startedAt: new Date().toISOString(),
    config: clonePlain(config),
    seats: (state?.players || []).map((player) => {
      const selection = selections.find((entry) => Number(entry.playerId) === player.id);
      return {
        playerId: player.id,
        human: humanIds.has(player.id),
        name: player.firstName || null,
        dynasty: player.dynasty || null,
        opponentId: selection?.id || null,
        personality: selection?.personality || null,
      };
    }),
    playerNames: playerNames(state),
    commands: [],
    notes: {},
    rounds: [],
    resumes: 0,
  };
}

// Where the game stood when a round's Resolution closed: enough to follow
// the game at a glance without replaying it.
export function summarizeRound(state) {
  const scores = new Map(buildFinalScores(state).scores.map((entry) => [entry.playerId, entry]));
  const themes = Object.values(state.themes || {}).filter((theme) => theme.id !== 'CPL');
  return {
    round: state.round,
    invasion: state.currentInvasion?.id || null,
    war: state.lastWarResult?.outcome || null,
    basileusId: state.basileusId,
    newBasileusId: state.lastCoupResult?.winnerId ?? null,
    lostProvinces: themes.filter((theme) => theme.lost).length,
    fallen: state.gameOver?.type === 'fall',
    players: state.players.map((player) => ({
      id: player.id,
      gold: player.gold,
      points: scores.get(player.id)?.points ?? 0,
      majorTitles: (player.majorTitles || []).slice(),
      strategoi: themes.filter((theme) => theme.strategos === player.id).length,
      bishops: themes.filter((theme) => theme.bishop === player.id).length,
      estates: themes.reduce((total, theme) => total + (getProvinceEstateHolders(theme)
        .find((holder) => holder.playerId === player.id)?.count || 0), 0),
    })),
  };
}

// Runs one human command and, when a record is kept, writes it down. An
// automatic court step is only kept when it changed the game.
export function performRecordedCall(record, state, aiMeta, context, call, playerId, args = {}) {
  const run = RECORDED_CALLS[call];
  if (!run) throw new Error(`Unknown recorded call: ${call}`);
  const round = state?.round ?? null;
  const phase = state?.phase ?? null;
  if (record && call === 'continueAfterResolution' && phase === 'resolution'
    && !record.rounds.some((entry) => entry.round === round)) {
    record.rounds.push(summarizeRound(state));
  }
  const storedArgs = clonePlain(args);
  const result = run(state, aiMeta, context, playerId, args);
  if (!record) return result;
  if (call === 'autoResolveCourt' && !result?.changed) return result;
  const entry = {
    seq: record.commands.length,
    round,
    phase,
    call,
    playerId: playerId ?? null,
    args: storedArgs,
    ok: Boolean(result?.ok),
  };
  if (!result?.ok && result?.reason) entry.reason = result.reason;
  record.commands.push(entry);
  return result;
}

export function setRecordNote(record, key, text) {
  if (!record) return;
  const value = String(text ?? '');
  if (value.trim()) record.notes[key] = value;
  else delete record.notes[key];
}

export function getRecordNote(record, key) {
  return record?.notes?.[key] ?? '';
}

// The file a player sends: the record plus the game as it stands, with its
// full history and the AIs' memory and moods.
export function buildGameRecordExport(record, state, aiMeta) {
  const finished = Boolean(state?.gameOver) || state?.phase === 'scoring';
  const final = finished ? buildFinalScores(state) : null;
  return {
    ...clonePlain(record),
    exportedAt: new Date().toISOString(),
    finished,
    fallen: state?.gameOver?.type === 'fall',
    round: state?.round ?? null,
    phase: state?.phase ?? null,
    finalScores: final
      ? final.scores.map((entry) => ({ playerId: entry.playerId, points: entry.points, gold: entry.gold }))
      : null,
    winnerIds: final ? final.winners.map((entry) => entry.playerId) : null,
    gameState: serializeGameState(state),
    aiMeta: serializeAiMeta(aiMeta),
  };
}

export function gameRecordFilename(record, date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const map = record?.config?.mapId || 'classic';
  const players = record?.config?.playerCount || '';
  return `basileus-record-${stamp}-${map}-${players}p.json`;
}

export function isGameRecord(value) {
  return value?.schema === GAME_RECORD_SCHEMA && Array.isArray(value?.commands) && Boolean(value?.config);
}

// Plays a record's game again from its seed. With `stopBefore`, stops just
// before that command, to look at what a human faced then. `mismatches`
// lists commands whose success differs from the original game: on the code
// the game was played with there are none.
export function replayGameRecord(record, options = {}) {
  if (!isGameRecord(record)) throw new Error('Not a Basileus game record.');
  const config = clonePlain(record.config);
  const state = createGameState(config);
  setDealParticipantIds(state, state.players.map((player) => player.id));
  const aiMeta = config.mode === 'single'
    ? createAIMeta(state, {
      humanPlayerIds: config.humanPlayerIds,
      aiPlayers: buildAiPlayersFromSelections(config.aiOpponentSelections),
    })
    : null;
  applyPlayerNames(state, record.playerNames);
  const context = {};
  startInteractiveRuntime(state, aiMeta, context);

  const stopBefore = Number.isInteger(options.stopBefore) ? options.stopBefore : Infinity;
  const mismatches = [];
  let applied = 0;
  for (const entry of record.commands) {
    if (entry.seq >= stopBefore) break;
    const result = RECORDED_CALLS[entry.call](state, aiMeta, context, entry.playerId, clonePlain(entry.args) || {});
    if (Boolean(result?.ok) !== Boolean(entry.ok)) mismatches.push(entry.seq);
    applied += 1;
  }
  return { state, aiMeta, context, applied, mismatches };
}
