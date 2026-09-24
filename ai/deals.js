// ai/deals.js - how AI dynasties judge formal deal offers.
//
// Each clause is valued from the AI's side (what it receives minus what it
// gives), conditional clauses are discounted, and the total must clear a bar
// that drops for trusted partners and rises for rivals and runaway leaders.
import { DEAL_CLAUSE_KINDS, DEAL_TRIGGER_TYPES } from '../engine/deals.js';
import { getPlayer } from '../engine/state.js';
import { getAiMemory, relationshipScore } from './memory.js';

// Value of one unit of each clause, per turn where the clause repeats.
const CLAUSE_UNIT_VALUES = {
  goldReceived: 1,
  goldGiven: 1.15,
  capitalTroopReceived: 0.8,
  capitalTroopGiven: 1.0,
  frontierTroopReceived: 0.45,
  frontierTroopGiven: 0.5,
  appointmentReceived: 1.4,
  appointmentGiven: 1.6,
  protectionTurnReceived: 0.7,
  protectionTurnGiven: 0.55,
};
const ESTATE_BASE_VALUE = 1.5;
const ESTATE_VALUE_PER_REMAINING_ROUND = 0.7;
// A clause that only starts once someone becomes Basileus may never start.
const CONDITIONAL_CLAUSE_DISCOUNT = 0.5;
const BASE_ACCEPT_THRESHOLD = 1;
const RELATIONSHIP_THRESHOLD_WEIGHT = 0.4;
const LEADER_THRESHOLD_PENALTY = 1;

function remainingRounds(state) {
  return Math.max(1, (Number(state.maxRounds) || 1) - (Number(state.round) || 0) + 1);
}

function estateValue(state, themeId) {
  const theme = state.themes?.[themeId];
  const profit = Math.max(1, Number(theme?.P) || 1);
  return ESTATE_BASE_VALUE + ESTATE_VALUE_PER_REMAINING_ROUND * profit * remainingRounds(state);
}

// Positive when the clause benefits `aiPlayerId`, negative when it costs it.
export function valueClauseForPlayer(state, clause, aiPlayerId) {
  const gives = clause.giverId === aiPlayerId;
  const receives = clause.receiverId === aiPlayerId;
  if (!gives && !receives) return 0;
  const sign = receives ? 1 : -1;
  const turns = Math.max(1, Number(clause.durationTurns) || 1);
  let value = 0;
  switch (clause.kind) {
    case DEAL_CLAUSE_KINDS.GOLD: {
      const amount = Number(clause.payload?.totalAmount) || 0;
      value = amount * (receives ? CLAUSE_UNIT_VALUES.goldReceived : CLAUSE_UNIT_VALUES.goldGiven);
      break;
    }
    case DEAL_CLAUSE_KINDS.ESTATE:
      value = estateValue(state, clause.payload?.themeId);
      break;
    case DEAL_CLAUSE_KINDS.COUP_SUPPORT: {
      const troops = Number(clause.payload?.troopCount) || 0;
      value = troops * turns * (receives ? CLAUSE_UNIT_VALUES.capitalTroopReceived : CLAUSE_UNIT_VALUES.capitalTroopGiven);
      break;
    }
    case DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT: {
      const troops = Number(clause.payload?.troopCount) || 0;
      value = troops * turns * (receives ? CLAUSE_UNIT_VALUES.frontierTroopReceived : CLAUSE_UNIT_VALUES.frontierTroopGiven);
      break;
    }
    case DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE: {
      const count = Number(clause.payload?.appointmentCount) || 0;
      value = count * (receives ? CLAUSE_UNIT_VALUES.appointmentReceived : CLAUSE_UNIT_VALUES.appointmentGiven);
      break;
    }
    case DEAL_CLAUSE_KINDS.NON_REVOCATION:
      value = turns * (receives ? CLAUSE_UNIT_VALUES.protectionTurnReceived : CLAUSE_UNIT_VALUES.protectionTurnGiven);
      break;
    default:
      return 0;
  }
  const conditional = clause.startTrigger?.type === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS;
  return sign * value * (conditional ? CONDITIONAL_CLAUSE_DISCOUNT : 1);
}

function isRunawayLeader(state, playerId, aiPlayerId) {
  const gold = (id) => Math.max(0, Number(getPlayer(state, id)?.gold) || 0);
  const others = (state.players || []).filter((player) => player.id !== playerId);
  const richestOther = Math.max(0, ...others.map((player) => gold(player.id)));
  return gold(playerId) >= 6 && gold(playerId) > richestOther * 1.5 && gold(playerId) > gold(aiPlayerId);
}

export function evaluateDealOfferForAi(state, meta, aiPlayerId, thread) {
  const offer = thread?.currentOffer;
  const clauses = Array.isArray(offer?.clauses) ? offer.clauses : [];
  const partnerId = offer?.proposerId === aiPlayerId ? offer?.counterpartyId : offer?.proposerId;
  const value = clauses.reduce((total, clause) => total + valueClauseForPlayer(state, clause, aiPlayerId), 0);
  const relationship = Math.max(-2, Math.min(2, relationshipScore(getAiMemory(state, meta), aiPlayerId, partnerId) || 0));
  let threshold = BASE_ACCEPT_THRESHOLD - relationship * RELATIONSHIP_THRESHOLD_WEIGHT;
  if (isRunawayLeader(state, partnerId, aiPlayerId)) threshold += LEADER_THRESHOLD_PENALTY;
  return {
    partnerId,
    value: Math.round(value * 100) / 100,
    threshold: Math.round(threshold * 100) / 100,
    accept: clauses.length > 0 && value >= threshold,
  };
}
