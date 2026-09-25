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
import { readTroopCount } from '../../engine/cascade.js';
import { buildFinalScores } from '../../engine/scoring.js';
import { BALANCE } from '../../data/balance.js';
import { describeRisingPrices } from '../../engine/presentation.js';

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

// The first office circle still open for this major office.
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
  return readTroopCount(state.currentTroops?.[officeKey]);
}

function coupText(state) {
  const coup = state.lastCoupResult;
  if (!coup) return 'The coup has been decided.';
  const winner = name(state, coup.winner);
  return coup.winner === state.basileusId
    ? `${winner} keeps the throne: no claimant gathered more support than the Basileus.`
    : `${winner} wins the coup and will be crowned Basileus next round.`;
}

function warText(state) {
  const war = state.lastWarResult;
  if (!war) return 'There was no war this round.';
  const troops = Number(war.frontierTroops) || 0;
  const strength = Number(war.invaderStrength) || 0;
  if (war.outcome === 'victory') return `The empire sent ${troops} troops against ${strength}: a victory. The frontier's lead retakes lost provinces on the route.`;
  if (war.outcome === 'defeat') return `The empire sent only ${troops} troops against ${strength}: a defeat. The invader spends its lead taking provinces along its route: 1 for the first, 2 for the next, and so on.`;
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
    body: 'When the last round ends, each dynasty scores the Balance of Power: 1 point for every 10% share it holds of all the gold, estate income and office income. The highest total wins. But if invaders take Constantinople, the empire falls and nobody wins.',
    task: 'Tip: you need the empire to survive, but not necessarily at your own expense.',
  },
  {
    id: 'dynasties',
    when: inRound(1),
    target: '#playerTabBar',
    title: 'The three dynasties',
    body: ({ state }) => `${name(state, state.basileusId)} is the Basileus, the emperor. Below the throne are the four major offices: you are the Patriarch and the Domestic of the East; ${name(state, 2)} is the Admiral and the Domestic of the West. Offices give troops, gold and the power to appoint.`,
    task: 'Your rivals are AI dynasties, each with its own temperament: hover their names to read it.',
  },
  {
    id: 'invasion',
    when: inRound(1),
    target: () => document.querySelector('#mapContainer .invasion-cartouche') || document.querySelector('#mapArea'),
    title: 'The threat',
    body: ({ state }) => `Every round an invasion marches on the empire. This round it is ${invasionText(state)}, coming along the dotted route. The "+N" tags on the route show how much it must beat the frontier by to take each province.`,
    task: 'The Invasion filter above the map shows the same route in red; grey provinces are already lost.',
  },
  {
    id: 'court-intro',
    when: inRound(1, 'court'),
    target: '.court-panel',
    title: 'Offices',
    body: `Each round starts with the Offices phase. Every major office may make up to ${BALANCE.MAJOR_OFFICE_ACTION_LIMIT} appointments or revocations. As Patriarch you appoint Bishops, who receive 1 gold from their bishopric every round. As Domestic of the East you appoint Strategoi, who raise 1 troop in their province every round.`,
    task: 'Tip: offices you give away earn gratitude, offices you keep earn income. Let us do both.',
  },
  {
    id: 'bishop-seat',
    when: inRound(1, 'court'),
    target: () => firstOpenSeat('PATRIARCH'),
    title: 'Appoint a Bishop',
    body: 'On the left are the bishoprics that have no Bishop, on the right the dynasties. You connect them with a rope.',
    task: 'Click the circle next to the highlighted bishopric.',
    done: () => tying('PATRIARCH') || plannedIn('PATRIARCH') >= 1,
  },
  {
    id: 'bishop-player',
    when: (context) => inRound(1, 'court')(context) && (tying('PATRIARCH') || plannedIn('PATRIARCH') >= 1),
    fallback: 'bishop-seat',
    target: `[data-court-power="PATRIARCH"] [data-wire-player-finish="${ME}"]`,
    title: 'Choose who gets it',
    body: 'The rope follows your pointer. A Bishop is paid 1 gold by the bishopric every round, even if invaders take it.',
    task: 'Click the circle next to your own dynasty to make yourself Bishop.',
    done: () => plannedIn('PATRIARCH') >= 1,
  },
  {
    id: 'bishop-second',
    when: inRound(1, 'court'),
    target: () => firstOpenSeat('PATRIARCH'),
    title: 'A gift',
    body: 'You cannot appoint the same dynasty twice in a row, with any of your offices, so your next appointment must go to someone else.',
    task: 'Tie another bishopric to one of your rivals. Tip: AI dynasties remember favours and back those who treat them well.',
    done: () => plannedIn('PATRIARCH') >= 2,
  },
  {
    id: 'strategos',
    when: inRound(1, 'court'),
    target: () => firstOpenSeat('DOM_EAST'),
    title: 'Appoint a Strategos',
    body: 'Scroll down to your second office, the Domestic of the East. A Strategos raises 1 troop in their province every round, on top of the troops you raise as Domestic.',
    task: () => (plannedIn('PATRIARCH') >= 2
      ? 'Your last appointment went to a rival, so you may appoint yourself again: click a province circle, then the circle next to your dynasty.'
      : 'Your last appointment went to you, so this one must go to a rival: click a province circle, then a rival\'s circle.'),
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
    body: 'The Offices phase is over and income was paid: estates paid their owners, Bishops and the Patriarch received church gold, and offices raised troops. Your gold and income are here.',
    task: 'Tip: gold counts twice. You spend it on estates and mercenaries, and what you hold at the end counts for the Balance of Power.',
  },
  {
    id: 'estates-bid',
    when: inRound(1, 'estates'),
    target: () => document.querySelector('.estate-row:not(.on-route) [data-estate-add]:not([disabled])')
      || document.querySelector('[data-estate-add]:not([disabled])'),
    title: 'Build estates',
    body: `Each estate pays you 1 gold every round, and estate income is one of the three scores. This round your estates cost the rising price: ${describeRisingPrices()} Every ${BALANCE.ESTATE_DOMAIN_SIZE} of yours in one province form a domain that pays ${BALANCE.ESTATE_DOMAIN_BONUS} more, but the Basileus can revoke all your estates in a province at once.`,
    task: 'Press + to plan an estate in this province.',
    done: () => Boolean(document.querySelector('.estate-row.planned')),
  },
  {
    id: 'estates-lock',
    when: inRound(1, 'estates'),
    target: '[data-action="confirm-estates"]',
    title: 'Lock your estates',
    body: 'Rivals plan in secret too. Every plan is paid and built when Deployment opens. If invaders take a province, its estates stop paying until it is retaken.',
    task: 'Click Lock Estates.',
    done: ({ state }) => state.phase !== 'estates' || Boolean(state.estatesReady?.[ME]),
  },
  {
    id: 'deploy-intro',
    when: inRound(1, 'deployment'),
    target: () => document.querySelector('.army-card') || document.querySelector('#actionPanel'),
    title: 'Deployment: the real decision',
    body: ({ state }) => `Every dynasty now decides, in secret, where its troops go. Troops at the frontier fight ${invasionText(state)}. Troops in Constantinople support claimants in the coup: whoever gathers the most support takes the throne.`,
    task: 'Tip: every troop in Constantinople is one less at the frontier. Let the others defend and you may win the throne, or lose the empire.',
  },
  {
    id: 'deploy-frontier',
    when: inRound(1, 'deployment'),
    target: () => document.querySelector('.army-card.unresolved [data-destination="frontier"]')
      || document.querySelector('[data-army-destination][data-destination="frontier"]'),
    title: 'Defend your provinces',
    body: ({ state }) => `Your Domestic of the East has ${myTroops(state, 'DOM_EAST')} troops. The dynasty that sends the most troops to a won war is the best defender and earns gold and Triumph.`,
    task: () => (armyCount() > 1
      ? 'Send each of your armies to the Frontier: the Domestic of the East and your Strategoi.'
      : 'Send the Domestic of the East to the Frontier.'),
    done: () => armyCount() > 0 && !document.querySelector('.army-card.unresolved'),
  },
  {
    id: 'deploy-fund',
    when: inRound(1, 'deployment'),
    target: '[data-army-funded]',
    title: 'Field or dismiss',
    body: `The slider sets how many troops of the army you field. Each troop you do not field is dismissed and pays you ${BALANCE.GOLD_PER_DISMISSED_TROOP} gold instead.`,
    task: 'Drag each slider to the right to field every troop, then press Next.',
  },
  {
    id: 'deploy-coup',
    when: inRound(1, 'deployment'),
    target: () => document.querySelector('[data-coup-section]') || null,
    title: 'Back a claimant',
    body: `Choose who your troops in Constantinople back for the throne: your first choice gets all their support, your second gets half. As Patriarch, your influence (${BALANCE.PATRIARCH_INFLUENCE} support) follows the same choices, even with no troops there.`,
    task: 'Keep yourself as first choice and press Next.',
  },
  {
    id: 'deploy-lock',
    when: inRound(1, 'deployment'),
    target: () => document.querySelector('.army-card.unresolved') || document.querySelector('[data-action="lock-orders"]'),
    title: 'Commit',
    body: 'Orders stay secret until everyone has locked.',
    task: () => (document.querySelector('.army-card.unresolved')
      ? 'This army has no destination yet: choose Frontier or Constantinople, then click Lock Deployment.'
      : 'Click Lock Deployment.'),
    done: ({ state }) => state.phase !== 'deployment' || Boolean(state.allOrders?.[ME]),
  },
  {
    id: 'resolution-coup',
    when: inRound(1, 'resolution'),
    target: () => document.querySelector('.resolution-panel .coup-result') || document.querySelector('.resolution-panel'),
    title: 'The coup',
    body: ({ state }) => `Orders are revealed. The coup is decided first. ${coupText(state)}`,
    task: `The Theodosian Walls give the Basileus ${BALANCE.THEODOSIAN_WALLS} support in every coup (and make Constantinople harder for invaders to take). Tip: a challenger needs real troops in Constantinople, or friends.`,
  },
  {
    id: 'resolution-war',
    when: inRound(1, 'resolution'),
    target: () => document.querySelector('.resolution-panel .war-result') || document.querySelector('.resolution-panel'),
    title: 'The war',
    body: ({ state }) => warText(state),
    task: 'The ledger shows what each province cost and what was left over. Lost provinces produce nothing until the empire retakes them.',
  },
  {
    id: 'resolution-continue',
    when: inRound(1, 'resolution'),
    target: '[data-action="continue"]',
    title: 'End of the round',
    body: 'That was a whole round: Offices, Estates, Deployment, Resolution. Every round follows the same order.',
    task: 'Click Continue to start round 2.',
    done: ({ state }) => state.round > 1 || state.phase !== 'resolution',
  },
  {
    id: 'on-your-own',
    when: ({ state }) => state.round >= 2 && !state.gameOver && state.phase !== 'scoring',
    title: 'On your own',
    body: 'Finish the game on your own: this is the last guided step. A short tip for each phase stays in this card; collapse it whenever you like.',
    task: 'Tip: watch your rivals. The Usurper wants the throne and pulls troops back to Constantinople when it can; the Landlord buys land and often leaves the fighting to others.',
    free: true,
  },
  {
    id: 'game-over',
    when: ({ state }) => Boolean(state.gameOver) || state.phase === 'scoring',
    title: 'The game is over',
    body: ({ state }) => (state.gameOver?.type === 'fall'
      ? 'Constantinople has fallen: nobody wins. It happens when everyone waits for the others to defend.'
      : resultText(state)),
    task: 'Ready for a real game? Choose how many rivals you face, their temperaments, and how long the game lasts.',
    final: true,
  },
];

// Short reminders for the phases of the rounds you play alone.
export const TUTORIAL_PHASE_TIPS = {
  title_redistribution: 'A new Basileus hands out the major offices. Whoever gets an office gets its troops and appointments.',
  court: 'Appoint or revoke with your major offices, then lock. You cannot appoint the same dynasty twice in a row.',
  estates: 'Tip: estates away from the invasion route are safer. Keep some gold for mercenaries.',
  deployment: 'Tip: compare the invasion strength with what the table can send. Hold troops back only if others will defend.',
  resolution: 'Read what everyone did. Tip: remember who defended and who went for the throne.',
};
