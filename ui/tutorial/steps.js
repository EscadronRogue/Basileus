// ui/tutorial/steps.js - the script of the tutorial game.
//
// The tutorial is a normal single-player game on a fixed setup: three
// dynasties, three rounds, and you (seat 0) holding the Patriarch and the
// Domestic of the East while another dynasty is Basileus. Round 1 is played
// step by step; rounds 2 and 3 are yours, with a tip per phase.
//
// Each step says when it applies (`when`), what to point at (`target`, a CSS
// selector or a function returning an element), what it explains (`body`)
// and what the player must do (`task`). A step with `done` advances by
// itself once the player has done it; a step without one waits for Next.
import { getPlayerName } from '../../engine/state.js';
import { buildFinalScores } from '../../engine/scoring.js';
import { getPendingDefenderRewards } from '../../engine/turnflow.js';

export const TUTORIAL_SEED = 254;
export const TUTORIAL_PLAYER_COUNT = 3;
export const TUTORIAL_TURN_COUNT = 3;
export const TUTORIAL_HUMAN_ID = 0;
// Who the AI rivals are: a personality from the trained roster when it is
// available, otherwise the built-in policy of the same temperament.
export const TUTORIAL_RIVALS = [
  { playerId: 1, personality: 'usurper', fallbackPolicy: 'usurper' },
  { playerId: 2, personality: 'landlord', fallbackPolicy: 'profiteer' },
];

const ME = TUTORIAL_HUMAN_ID;

function inRound(round, phase) {
  return ({ state }) => state.round === round && (!phase || [].concat(phase).includes(state.phase));
}

function name(state, playerId) {
  return getPlayerName(state, playerId);
}

// Planned appointments for one office (each is drawn as several rope parts).
function plannedIn(powerKey) {
  const keys = [...document.querySelectorAll(`[data-court-power="${powerKey}"] [data-plan-remove]`)]
    .map((element) => element.getAttribute('data-plan-remove'));
  return new Set(keys).size;
}

function tying(powerKey) {
  return Boolean(document.querySelector(`[data-court-power="${powerKey}"] .court-wire-board.tying`));
}

function firstOpenSeat(powerKey) {
  return document.querySelector(`[data-court-power="${powerKey}"] .court-wire-seat:not([aria-disabled="true"]) [data-wire-seat-start]`)
    || document.querySelector(`[data-court-power="${powerKey}"] [data-wire-seat-start]`);
}

function invasionText(state) {
  const invasion = state.currentInvasion;
  if (!invasion) return 'an invasion';
  const [low, high] = Array.isArray(invasion.strength) ? invasion.strength : [invasion.strength, invasion.strength];
  return `the ${invasion.name}, strength ${low} to ${high}`;
}

function armyCount() {
  return document.querySelectorAll('.army-card').length;
}

function myTroops(state, officeKey) {
  return Number(state.currentTroops?.[officeKey]?.normal) || 0;
}

function coupText(state) {
  const coup = state.lastCoupResult;
  if (!coup) return 'The coup has been decided.';
  const winner = name(state, coup.winner);
  return coup.winner === state.basileusId
    ? `${winner} keeps the throne: no claimant gathered more capital support than the Basileus.`
    : `${winner} wins the coup and will be crowned Basileus next round.`;
}

function warText(state) {
  const war = state.lastWarResult;
  if (!war) return 'There was no war this round.';
  const troops = Number(war.frontierTroops) || 0;
  const strength = Number(war.invaderStrength) || 0;
  if (war.outcome === 'victory') return `The empire sent ${troops} troops against ${strength}: a victory. Surplus troops reconquer lost provinces.`;
  if (war.outcome === 'defeat') return `The empire sent only ${troops} troops against ${strength}: a defeat, and the invader takes provinces along its route.`;
  return `The empire's ${troops} troops held the invader's ${strength} to a stalemate.`;
}

function resultText(state) {
  const { scores, winners } = buildFinalScores(state);
  const mine = scores.find((entry) => entry.playerId === ME);
  const points = `${mine?.points ?? 0} point${mine?.points === 1 ? '' : 's'}`;
  if (winners.some((entry) => entry.playerId === ME)) {
    return winners.length > 1
      ? `You share the victory with ${points}. The final standings show how each share was earned.`
      : `You win with ${points}. The final standings show how each share was earned.`;
  }
  const leader = winners[0];
  return `${leader ? name(state, leader.playerId) : 'A rival'} wins; you finish with ${points}. The final standings show where the points came from.`;
}

export const TUTORIAL_STEPS = [
  {
    id: 'welcome',
    when: inRound(1),
    title: 'Welcome to Basileus',
    body: ({ state }) => `Three great families serve the Byzantine Empire and scheme against each other. You lead the ${state.players[ME].dynasty || 'Phokas'} dynasty. This tutorial walks you through one full round, then lets you finish a short three-round game on your own.`,
    task: 'Hover any bold word for its definition. Keep hovering and the tooltip locks, so you can read the bold words inside it too.',
  },
  {
    id: 'goal',
    when: inRound(1),
    target: '#balancePanel',
    title: 'How to win',
    body: 'When the last round ends, each dynasty scores the Balance of Power: 1 point for every 10% share it holds of gold reserves, profit income and office income. The highest total wins.',
    task: 'One exception matters more than anything: if invaders take Constantinople, the empire falls and everyone loses. You need the empire to survive, but not necessarily at your own expense.',
  },
  {
    id: 'dynasties',
    when: inRound(1),
    target: '#playerTabBar',
    title: 'The three dynasties',
    body: ({ state }) => `${name(state, state.basileusId)} is the Basileus, the emperor. The other offices are the major titles: you hold the Patriarch and the Domestic of the East; ${name(state, 2)} holds the Admiral and the Domestic of the West. Offices are where gold, troops and power come from.`,
    task: 'Your rivals are AI dynasties with their own temperament. Hover their names later in the game to see it.',
  },
  {
    id: 'invasion',
    when: inRound(1),
    target: () => document.querySelector('#mapContainer .invasion-cartouche') || document.querySelector('#mapArea'),
    title: 'The threat',
    body: ({ state }) => `Every round an invasion marches on the empire. This round it is ${invasionText(state)}, coming along the dotted route. If the frontier holds, nothing is lost; if not, provinces fall one by one toward Constantinople.`,
    task: 'The provinces on this route are in the east: the region you command as Domestic of the East.',
  },
  {
    id: 'court-intro',
    when: inRound(1, 'court'),
    target: '.court-panel',
    title: 'Court',
    body: 'Each round starts at Court. Every office may make up to 2 appointments or revocations. As Patriarch you appoint Bishops, who collect church gold. As Domestic of the East you appoint Strategoi, who command the troops of their province.',
    task: 'Offices you give away earn gratitude; offices you keep earn income. Let us do both.',
  },
  {
    id: 'bishop-seat',
    when: inRound(1, 'court'),
    target: () => firstOpenSeat('PATRIARCH'),
    title: 'Appoint a Bishop',
    body: 'On the left are the Bishop seats you can fill, on the right the dynasties. You connect them with a rope.',
    task: 'Click the circle next to the highlighted Bishop seat.',
    done: () => tying('PATRIARCH') || plannedIn('PATRIARCH') >= 1,
  },
  {
    id: 'bishop-player',
    when: (context) => inRound(1, 'court')(context) && (tying('PATRIARCH') || plannedIn('PATRIARCH') >= 1),
    fallback: 'bishop-seat',
    target: `[data-court-power="PATRIARCH"] [data-wire-player-finish="${ME}"]`,
    title: 'Choose who gets it',
    body: 'The rope follows your pointer. A Bishop collects the church gold (C) of the province every round.',
    task: 'Click the circle next to your own dynasty to make yourself Bishop.',
    done: () => plannedIn('PATRIARCH') >= 1,
  },
  {
    id: 'bishop-second',
    when: inRound(1, 'court'),
    target: () => firstOpenSeat('PATRIARCH'),
    title: 'A gift',
    body: 'You cannot appoint the same dynasty twice in a row, with any of your offices, so your next appointment must go to someone else. AI dynasties remember favours: they back those who treat them well, in coups and in deals.',
    task: 'Tie another Bishop seat to one of your rivals.',
    done: () => plannedIn('PATRIARCH') >= 2,
  },
  {
    id: 'strategos',
    when: inRound(1, 'court'),
    target: () => firstOpenSeat('DOM_EAST'),
    title: 'Appoint a Strategos',
    body: 'Scroll down to your second office, the Domestic of the East. A Strategos commands the troops raised by one province.',
    task: () => (plannedIn('PATRIARCH') >= 2
      ? 'Your last appointment went to a rival, so you may appoint yourself again: click a Strategos seat circle, then the circle next to your dynasty.'
      : 'Your last appointment went to you, so this one must go to a rival: click a Strategos seat circle, then a rival\'s circle.'),
    done: () => plannedIn('DOM_EAST') >= 1,
  },
  {
    id: 'court-lock',
    when: inRound(1, 'court'),
    target: '[data-action="confirm-court-plan"]',
    title: 'Lock your plan',
    body: 'Nothing happens until you lock. Rivals decide at the same time; you will see their appointments on the map and in the history.',
    task: 'Click Lock Planned Actions.',
    done: ({ state }) => state.phase !== 'court' || Boolean(state.courtActions?.playerConfirmed?.has(ME)),
  },
  {
    id: 'income',
    when: inRound(1, 'estates'),
    target: '#playerDashboard',
    title: 'Income',
    body: 'Court is over and Income ran by itself: estates paid their owners, Bishops collected church gold, and offices raised troops. Your gold and next income are here.',
    task: 'Gold matters twice: you spend it on land and troops, and what you still hold at the end counts for the Balance of Power.',
  },
  {
    id: 'estates-bid',
    when: inRound(1, 'estates'),
    target: () => document.querySelector('.estate-card:not(.disabled) [data-action="bid-estate"]'),
    title: 'Buy land',
    body: 'Free provinces are sold by sealed bid. An estate pays its profit (P) to you every round, and profit income is one of the three scores.',
    task: 'Plan a bid on this estate at the minimum price.',
    done: () => Boolean(document.querySelector('.estate-card.selected')),
  },
  {
    id: 'estates-lock',
    when: inRound(1, 'estates'),
    target: '[data-action="confirm-estates"]',
    title: 'Lock your bids',
    body: 'Rivals bid in secret too. The highest bid wins when Deployment opens; a tie goes to one of the tied bidders at random.',
    task: 'Click Lock Bids.',
    done: ({ state }) => state.phase !== 'estates' || Boolean(state.estatesReady?.[ME]),
  },
  {
    id: 'deploy-intro',
    when: inRound(1, 'deployment'),
    target: () => document.querySelector('.army-card') || document.querySelector('#actionPanel'),
    title: 'Deployment: the real decision',
    body: ({ state }) => `Every dynasty now decides, in secret, where its troops go. Frontier troops fight ${invasionText(state)}. Capital troops vote in the coup: whoever gathers the most capital support takes the throne.`,
    task: 'The dilemma of the game: every troop at the capital is one less at the frontier. Let the others defend and you may win the throne, or lose the empire.',
  },
  {
    id: 'deploy-frontier',
    when: inRound(1, 'deployment'),
    target: () => document.querySelector('.army-card.unresolved [data-destination="frontier"]')
      || document.querySelector('[data-army-destination][data-destination="frontier"]'),
    title: 'Defend your provinces',
    body: ({ state }) => `Your Domestic of the East has ${myTroops(state, 'DOM_EAST')} troops, and the invaders are marching through your own region. The dynasty that sends the most troops to a won war is the best defender and earns gold and Triumph.`,
    task: () => (armyCount() > 1
      ? 'Send each of your armies to the Frontier: the Domestic of the East and your Strategoi.'
      : 'Send the Domestic of the East to the Frontier.'),
    done: () => armyCount() > 0 && !document.querySelector('.army-card.unresolved'),
  },
  {
    id: 'deploy-fund',
    when: inRound(1, 'deployment'),
    target: '[data-army-funded]',
    title: 'Pay your troops',
    body: 'Troops only march if you fund them. Each unfunded troop stays home and pays you 1 gold instead, which is sometimes the better deal.',
    task: 'Drag each slider to the right to fund every troop, then press Next.',
  },
  {
    id: 'deploy-rank',
    when: inRound(1, 'deployment'),
    target: () => document.querySelector('[data-candidate-rank]')?.parentElement || null,
    title: 'Rank the claimants',
    body: 'Every dynasty ranks all claimants to the throne, itself included. Capital troops support that ranking: full support to first place, none to last. As Patriarch you also bring 1 passive capital support, which follows your ranking even with no troops in the capital.',
    task: 'Keep yourself first and press Next.',
  },
  {
    id: 'deploy-lock',
    when: inRound(1, 'deployment'),
    target: () => document.querySelector('.army-card.unresolved') || document.querySelector('[data-action="lock-orders"]'),
    title: 'Commit',
    body: 'Orders stay secret until everyone has locked.',
    task: () => (document.querySelector('.army-card.unresolved')
      ? 'This army has no destination yet: choose Frontier or Capital, then click Lock Deployment.'
      : 'Click Lock Deployment.'),
    done: ({ state }) => state.phase !== 'deployment' || Boolean(state.allOrders?.[ME]),
  },
  {
    id: 'resolution-coup',
    when: inRound(1, 'resolution'),
    target: () => document.querySelector('.resolution-panel .coup-result') || document.querySelector('.resolution-panel'),
    title: 'The coup',
    body: ({ state }) => `Orders are revealed. The coup is decided first. ${coupText(state)}`,
    task: 'The Basileus starts every coup with 2 passive capital support, so a challenger needs real troops in the capital, or friends.',
  },
  {
    id: 'resolution-war',
    when: inRound(1, 'resolution'),
    target: () => document.querySelector('.resolution-panel .war-result') || document.querySelector('.resolution-panel'),
    title: 'The war',
    body: ({ state }) => warText(state),
    task: 'Look at the map: occupied provinces pay nothing to their owners until they are reconquered.',
  },
  {
    id: 'defender-reward',
    when: ({ state }) => inRound(1, 'resolution')({ state }) && getPendingDefenderRewards(state, ME).length > 0,
    target: '[data-defender-reward-choice][data-choice="empire"]',
    title: 'The best defender chooses',
    body: 'You led the defence. For each province the war recovers, you choose: restore it to the empire as free land, or take gold and leave it occupied.',
    task: 'Pick one of the two rewards.',
    done: ({ state }) => getPendingDefenderRewards(state, ME).length === 0,
  },
  {
    id: 'resolution-continue',
    when: inRound(1, 'resolution'),
    target: '[data-action="continue"]',
    title: 'End of the round',
    body: 'That was a whole round: Court, Income, Estates, Deployment, Resolution. Every round follows the same order.',
    task: 'Click Continue to start round 2.',
    done: ({ state }) => state.round > 1 || state.phase !== 'resolution',
  },
  {
    id: 'on-your-own',
    when: ({ state }) => state.round >= 2 && !state.gameOver && state.phase !== 'scoring',
    title: 'Your turn',
    body: 'Finish the game on your own: this is the last guided step. A short tip for each phase stays in this card; collapse it whenever you like.',
    task: 'Watch your rivals. The Usurper wants the throne and will pull troops back to the capital when it can; the Landlord outbids you for land and often leaves the fighting to others.',
    free: true,
  },
  {
    id: 'game-over',
    when: ({ state }) => Boolean(state.gameOver) || state.phase === 'scoring',
    title: 'The game is over',
    body: ({ state }) => (state.gameOver?.type === 'fall'
      ? 'Constantinople has fallen and every dynasty lost. It happens: when everyone waits for the others to defend, nobody does.'
      : resultText(state)),
    task: 'Ready for a real game? Choose how many rivals you face, their temperaments, and how long the game lasts.',
    final: true,
  },
];

// Short reminders for the phases of the rounds you play alone.
export const TUTORIAL_PHASE_TIPS = {
  title_redistribution: 'A new Basileus hands out the major titles. Whoever gets an office gets its troops and appointments.',
  court: 'Appoint or revoke with your offices, then lock. You cannot appoint the same dynasty twice in a row.',
  estates: 'Bid on land that pays well and lies away from the invasion route. Keep gold for troops.',
  deployment: 'Check the invasion strength against what the table can send. Hold troops back only if others will defend.',
  resolution: 'Read what everyone did. Remember who defended and who went for the throne.',
};
