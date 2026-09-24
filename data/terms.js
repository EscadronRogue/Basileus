// data/terms.js - the words the game uses for its concepts.
//
// Every player-facing text (rules, glossary, panels, notifications, history,
// error messages) names a concept the way it is written here, so one idea is
// never called two things. scripts/terms.test.js fails when a retired word
// comes back into player-facing text.

// The phases a player sees. The engine runs more steps than these (drawing
// the invasion, paying income, clearing the round); those happen between
// phases on their own and are never shown as phases.
export const PLAYER_PHASES = Object.freeze([
  {
    id: 'offices',
    name: 'Offices',
    enginePhases: ['title_redistribution', 'court'],
    summary: 'A new Basileus hands out the major offices; then major offices appoint and revoke Strategoi and Bishops, and the Basileus may revoke.',
  },
  {
    id: 'estates',
    name: 'Estates',
    enginePhases: ['estates'],
    summary: 'Each dynasty secretly builds estates in the provinces of the empire.',
  },
  {
    id: 'deployment',
    name: 'Deployment',
    enginePhases: ['deployment'],
    summary: 'Each dynasty secretly sends its troops to the frontier or Constantinople, hires mercenaries and chooses who it backs in the coup.',
  },
  {
    id: 'resolution',
    name: 'Resolution',
    enginePhases: ['resolution'],
    summary: 'Orders are revealed. The coup is decided, then the war is fought.',
  },
]);

export const GAME_OVER_LABEL = 'Game Over';

const PLAYER_PHASE_BY_ENGINE_PHASE = new Map(
  PLAYER_PHASES.flatMap((phase) => phase.enginePhases.map((enginePhase) => [enginePhase, phase])),
);

// The player phase an engine phase belongs to, or null for automatic steps.
export function getPlayerPhase(enginePhase) {
  return PLAYER_PHASE_BY_ENGINE_PHASE.get(enginePhase) || null;
}

export function getPlayerPhaseName(enginePhase) {
  if (enginePhase === 'scoring') return GAME_OVER_LABEL;
  return getPlayerPhase(enginePhase)?.name || '';
}

// Canonical names. `plural` is given when it is not name + 's'.
export const TERMS = Object.freeze({
  round: { name: 'round' },
  dynasty: { name: 'dynasty', plural: 'dynasties' },
  province: { name: 'province' },
  lostProvince: { name: 'lost province' },
  bishopric: { name: 'bishopric' },
  estate: { name: 'estate' },
  basileus: { name: 'Basileus' },
  majorOffice: { name: 'major office' },
  minorOffice: { name: 'minor office' },
  domesticEast: { name: 'Domestic of the East' },
  domesticWest: { name: 'Domestic of the West' },
  admiral: { name: 'Admiral' },
  patriarch: { name: 'Patriarch' },
  strategos: { name: 'Strategos', plural: 'Strategoi' },
  bishop: { name: 'Bishop' },
  appointment: { name: 'appointment' },
  revocation: { name: 'revocation' },
  troop: { name: 'troop' },
  mercenary: { name: 'mercenary', plural: 'mercenaries' },
  field: { name: 'field' },
  dismiss: { name: 'dismiss' },
  frontier: { name: 'frontier' },
  constantinople: { name: 'Constantinople' },
  coup: { name: 'coup' },
  claimant: { name: 'claimant' },
  firstChoice: { name: 'first choice' },
  secondChoice: { name: 'second choice' },
  support: { name: 'support' },
  theodosianWalls: { name: 'Theodosian Walls', plural: 'Theodosian Walls' },
  patriarchInfluence: { name: "Patriarch's influence", plural: "Patriarch's influence" },
  triumph: { name: 'Triumph', plural: 'Triumph' },
  unrest: { name: 'Unrest', plural: 'Unrest' },
  invasion: { name: 'invasion' },
  bestDefender: { name: 'best defender' },
  reconquer: { name: 'reconquer' },
  balanceOfPower: { name: 'Balance of Power', plural: 'Balance of Power' },
  lock: { name: 'lock' },
  temperament: { name: 'temperament' },
});

export function termName(id, count = 1) {
  const term = TERMS[id];
  if (!term) throw new Error(`Unknown term: ${id}`);
  if (count === 1) return term.name;
  return term.plural || `${term.name}s`;
}
