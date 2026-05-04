import { PERSONALITIES } from './personalities.js';

export function getPersonalityNameById(personalityId) {
  const built = PERSONALITIES?.[personalityId]?.name;
  if (built) return built;
  if (typeof personalityId !== 'string' || !personalityId.length) return null;
  return personalityId.charAt(0).toUpperCase() + personalityId.slice(1);
}

export function getAiDisplayName(aiMeta, playerId) {
  const aiMetaForPlayer = aiMeta?.players?.[playerId];
  const profile = aiMetaForPlayer?.profile;
  const personalityId = aiMetaForPlayer?.personalityId;
  return profile?.name || (personalityId ? getPersonalityNameById(personalityId) : null);
}
