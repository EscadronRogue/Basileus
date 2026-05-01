export function recordHistoryEvent(state, entry = {}) {
  if (!state?.historyEnabled || !Array.isArray(state.history)) return null;

  const nextIndex = (state.historySeq || 0) + 1;
  state.historySeq = nextIndex;

  const event = {
    id: `history-${nextIndex}`,
    index: nextIndex,
    round: entry.round ?? state.round ?? 0,
    phase: entry.phase ?? state.phase ?? 'setup',
    category: entry.category || 'general',
    type: entry.type || 'event',
    actorId: entry.actorId ?? null,
    summary: entry.summary || '',
    details: entry.details ? { ...entry.details } : null,
    decision: entry.decision ? { ...entry.decision } : null,
    actorAi: entry.actorAi ?? null,
  };

  state.history.push(event);
  return event;
}

export function updateHistoryEvent(state, eventId, patch = {}) {
  if (!state?.historyEnabled || !Array.isArray(state.history) || !eventId) return null;

  const event = state.history.find(entry => entry.id === eventId);
  if (!event) return null;

  if (patch.details) {
    event.details = { ...(event.details || {}), ...patch.details };
  }

  if (patch.decision) {
    event.decision = {
      ...(event.decision || {}),
      ...patch.decision,
      factors: patch.decision.factors || event.decision?.factors || [],
    };
  }

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'details' || key === 'decision') continue;
    event[key] = value;
  }

  return event;
}
