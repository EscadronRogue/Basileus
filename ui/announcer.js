// ui/announcer.js - screen-reader announcements for game progress.
//
// Writes short summaries of new phases, invasions, and turn results into a
// polite live region (#liveAnnouncer) so non-visual players hear what changed.
import { getPlayerName } from '../engine/state.js';

const PHASE_ANNOUNCEMENTS = {
  title_redistribution: 'Assign offices',
  court: 'Court: appoint and revoke',
  estates: 'Estates: bid for land',
  deployment: 'Deployment: send armies',
  resolution: 'Resolution',
  scoring: 'Final score',
};

let lastAnnouncementKey = null;

export function announce(message) {
  const region = typeof document !== 'undefined' ? document.getElementById('liveAnnouncer') : null;
  if (!region || !message) return;
  // Clear first so repeating the same sentence is still announced.
  region.textContent = '';
  const requestFrame = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));
  requestFrame(() => {
    region.textContent = message;
  });
}

function describeInvasion(invasion) {
  if (!invasion?.name) return '';
  const [low, high] = Array.isArray(invasion.strength) ? invasion.strength : [];
  const target = invasion.objective === 'provinces' ? 'the frontier provinces' : 'Constantinople';
  const strength = Number.isFinite(low) && Number.isFinite(high) ? `, estimated strength ${low} to ${high}` : '';
  return `${invasion.name} threaten ${target}${strength}.`;
}

function describeResolution(state) {
  const parts = [];
  const war = state.lastWarResult;
  if (war) {
    const name = state.currentInvasion?.name || 'The invaders';
    const tally = Number.isFinite(war.frontierTroops) && Number.isFinite(war.invaderStrength)
      ? ` (${war.frontierTroops} frontier troops against ${war.invaderStrength})`
      : '';
    if (war.reachedCPL) parts.push(`${name} reached Constantinople${tally}.`);
    else if (war.outcome === 'victory') parts.push(`The empire defeated ${name}${tally}.`);
    else if (war.outcome === 'defeat') parts.push(`${name} broke through${tally}.`);
    else parts.push(`The war against ${name} ended in a stalemate${tally}.`);
  }
  const coup = state.lastCoupResult;
  if (Number.isInteger(coup?.winner)) {
    const winner = getPlayerName(state, coup.winner);
    parts.push(coup.winner === state.basileusId ? `${winner} remains Basileus.` : `${winner} seizes the throne.`);
  }
  return parts.join(' ');
}

export function describeGameProgress(state) {
  if (!state) return '';
  if (state.gameOver?.type === 'fall' && state.phase !== 'resolution') {
    return 'Constantinople has fallen. No dynasty wins.';
  }
  if (state.gameOver || state.phase === 'scoring') return 'The game is over. Final standings are shown.';
  if (state.phase === 'resolution') return `Round ${state.round} resolved. ${describeResolution(state)}`.trim();
  const phase = PHASE_ANNOUNCEMENTS[state.phase];
  if (!phase) return '';
  const invasion = state.phase === 'court' || state.phase === 'title_redistribution' ? describeInvasion(state.currentInvasion) : '';
  return `Round ${state.round} of ${state.maxRounds}. ${phase}. ${invasion}`.trim();
}

// Announces once per round/phase change; re-renders within a phase stay quiet.
export function announceGameProgress(state) {
  if (!state) return;
  const key = `${state.round}:${state.phase}:${state.gameOver?.type || ''}`;
  if (key === lastAnnouncementKey) return;
  lastAnnouncementKey = key;
  announce(describeGameProgress(state));
}
