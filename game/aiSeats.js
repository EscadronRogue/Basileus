// game/aiSeats.js - turns the AI opponents chosen at setup into the seats
// createAIMeta expects. Shared by the browser game and record replays, so a
// replay seats exactly the AIs the game was played against.
import { hydrateAiOpponent } from '../ai/brain.js';

export function buildAiPlayersFromSelections(selections = []) {
  const aiPlayers = {};
  for (const selection of selections || []) {
    const playerId = Number(selection.playerId);
    if (!Number.isInteger(playerId)) continue;
    const opponent = hydrateAiOpponent(selection, playerId);
    aiPlayers[playerId] = {
      opponent,
      displayName: selection.firstName || selection.name || opponent?.firstName || null,
      opponentId: opponent?.id || selection.id || null,
      policy: selection.policy || opponent?.policy || null,
      strategyWeights: selection.strategyWeights || opponent?.strategyWeights || null,
    };
  }
  return aiPlayers;
}
