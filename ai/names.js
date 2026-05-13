export function getAiDisplayName(aiMeta, playerId) {
  const playerMeta = aiMeta?.players?.[playerId];
  if (!playerMeta?.isAI) return null;
  return playerMeta.displayName || `AI Seat ${Number(playerId) + 1}`;
}
