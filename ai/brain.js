export const AI_RUNTIME_NOT_IMPLEMENTED_MESSAGE = 'AI runtime is not implemented yet.';

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

function notImplemented() {
  throw new Error(AI_RUNTIME_NOT_IMPLEMENTED_MESSAGE);
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
    publicLog: [],
    decisionLog: createDecisionLog(),
    pendingNeuralRuntime: true,
  };
}

export function isAIPlayer(meta, playerId) {
  return Boolean(meta) && !meta.humanPlayerIds?.has(playerId);
}

export function invalidateRoundContext(meta) {
  if (!meta) return;
  meta.roundContext = null;
  meta.fastCache = null;
}

export function observeCourtAction() {
}

export function runAICourtAutomation() {
  return notImplemented();
}

export function buildAIOrders() {
  return notImplemented();
}

export function chooseAIDefenderRewardChoice() {
  return notImplemented();
}

export function handlePostResolutionAI() {
  return notImplemented();
}

export function planMajorTitleAssignment() {
  return notImplemented();
}

export function applyPlannedAiTitleAssignment() {
  return notImplemented();
}

export function getRecentPublicLog(meta, limit = 10) {
  return (meta?.publicLog || []).slice(-limit);
}
