import { parentPort, workerData } from 'node:worker_threads';
import { runSingleSimulationGame } from './engine.js';

function buildSnapshot(game) {
  return {
    guardTriggered: Boolean(game.guardTriggered),
    guardReason: game.guardReason || null,
    empireFall: Boolean(game.empireFall),
    roundsPlayed: game.roundsPlayed,
    startingBasileusId: game.startingBasileusId,
    winners: (game.winners || []).map(winner => winner.playerId).sort((left, right) => left - right),
    topWealth: game.topWealth,
    totalRevocations: game.totalRevocations || 0,
    playerMetrics: (game.playerMetrics || [])
      .map(metric => ({
        playerId: metric.playerId,
        finalWealth: metric.finalWealth,
        finalGold: metric.finalGold,
        frontierTroops: metric.frontierTroops,
        capitalTroops: metric.capitalTroops,
        throneCaptures: metric.throneCaptures,
      }))
      .sort((left, right) => left.playerId - right.playerId),
  };
}

try {
  const result = runSingleSimulationGame(workerData.caseConfig || {});
  parentPort.postMessage({
    ok: true,
    result: buildSnapshot(result),
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error?.stack || error?.message || 'Unknown smoke-test worker error',
  });
}
