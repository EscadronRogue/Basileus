// ai/personalities.js - the temperaments trained AI dynasties are built on.
//
// Every AI plays with the same planner (ai/strategy.js); what differs is its
// strategy weights. A personality fixes the ranges of the few weights that
// define its temperament (an Usurper always prizes the throne, an Opportunist
// always leans on others to hold the frontier). Training (ai/train.js) is
// free to tune everything else, and to move within those ranges, to win as
// often as possible.
import { DEFAULT_STRATEGY_WEIGHTS } from './strategy.js';

// The full range training may explore for each weight.
export const STRATEGY_WEIGHT_BOUNDS = Object.freeze({
  ownRecipientBonus: [0, 8],
  appointmentUnlockBonus: [0, 8],
  leaderDenial: [0.2, 2.6],
  rivalDenial: [0, 1.2],
  estateProfit: [1, 9],
  estatePriceWeight: [0.35, 2.4],
  estateSpread: [0, 3],
  estateDomainWeight: [0, 2.4],
  estateThreatPenalty: [0, 5],
  invasionShortfallPenalty: [1, 12],
  invasionSafetyValue: [0, 4],
  invasionSurplusPenalty: [0.05, 3],
  capitalFallPenalty: [100, 1400],
  capitalRiskPenalty: [20, 500],
  recoveryBonus: [0, 2.5],
  throneBase: [0, 80],
  selfClaim: [0.05, 2.4],
  incumbentDefense: [0.1, 2.4],
  supportLeaderPenalty: [0.1, 2.4],
  supportOtherClaimant: [0, 1.8],
  reserveValue: [0.15, 1.4],
  mercenaryCostPenalty: [0, 0.55],
  reciprocityWeight: [0, 1.8],
  grudgeWeight: [0, 1.8],
  trustWeight: [0, 1.2],
  favorSeekingWeight: [0, 1.6],
  friendNeglectPenalty: [0, 1.6],
  relationshipCap: [1, 8],
  defenseContextWeight: [0, 2.4],
  fundingContextWeight: [0, 1.8],
  revocationContextWeight: [0, 1.6],
  relationshipCoupWeight: [0, 1.8],
  coupOpportunityWeight: [0.05, 2.4],
  basileusTitleExpectation: [0, 2.4],
  basileusRevocationFear: [0, 2.4],
  backerTitleReward: [0, 2.4],
  backerRevocationMercy: [0, 2.4],
  titleQualityWeight: [0, 2.4],
  regimeTreatmentWeight: [0, 2.4],
  regimeUrgencyWeight: [0, 2.4],
  allyDefenseReliance: [0.55, 1],
  kingmakerPenalty: [0, 1.2],
  estateShieldWeight: [0, 2.4],
  officeKeepWeight: [0, 2.4],
  spiteWeight: [0, 2.5],
  unrestOpportunism: [0, 2],
  bishopAppointBonus: [0, 6],
  bishopKeepWeight: [0, 6],
});

export const TRAINABLE_WEIGHT_KEYS = Object.freeze(Object.keys(STRATEGY_WEIGHT_BOUNDS));

// `basePolicy` names the ai/policies.js preset training starts from.
// `traits` are the weight ranges that make the temperament; each must sit
// inside STRATEGY_WEIGHT_BOUNDS. `temperament` sets its moods (ai/mood.js):
// where it rests between duty (+1) and greed (-1) and between ambition (+1)
// and loyalty (-1), how far events move it (volatility), and how freely it
// strays from its best move (whim).
export const PERSONALITIES = Object.freeze([
  {
    id: 'usurper',
    title: 'Usurper',
    summary: 'Wants the purple for itself. Pulls troops back to Constantinople whenever the frontier looks safe enough and gambles on seizing the throne.',
    temperament: { duty: -0.3, ambition: 0.7, volatility: 1.0, whim: 0.5 },
    basePolicy: 'usurper',
    traits: {
      throneBase: [40, 80],
      selfClaim: [1.4, 2.4],
      coupOpportunityWeight: [0.8, 2.4],
      incumbentDefense: [0.1, 0.8],
      supportOtherClaimant: [0, 0.6],
      capitalFallPenalty: [100, 600],
    },
  },
  {
    id: 'opportunist',
    title: 'Opportunist',
    summary: 'Lets the others bleed at the frontier. Keeps its troops and gold for its own schemes and only fights when the empire is truly about to fall.',
    temperament: { duty: -0.7, ambition: 0.0, volatility: 1.0, whim: 0.5 },
    basePolicy: 'freeRider',
    traits: {
      allyDefenseReliance: [0.9, 1],
      invasionShortfallPenalty: [1, 4],
      invasionSafetyValue: [0, 0.6],
      invasionSurplusPenalty: [0.8, 3],
      defenseContextWeight: [0, 0.8],
      reserveValue: [0.5, 1.4],
      unrestOpportunism: [0.6, 2],
    },
  },
  {
    id: 'landlord',
    title: 'Landlord',
    summary: 'Builds estates wherever they pay and lives off the rents. Often leaves the frontier to others and cares little who wears the crown.',
    temperament: { duty: -0.2, ambition: -0.2, volatility: 0.8, whim: 0.4 },
    basePolicy: 'profiteer',
    traits: {
      estateProfit: [5.5, 9],
      estatePriceWeight: [0.35, 1.2],
      estateSpread: [0.3, 1.5],
      estateShieldWeight: [1, 2.4],
      reserveValue: [0.15, 0.4],
      throneBase: [0, 28],
      selfClaim: [0.05, 1.1],
    },
  },
  {
    id: 'tyrant',
    title: 'Tyrant',
    summary: 'Takes power and uses it. Will strip the frontier bare to seize the throne, keeps offices for itself, strips rivals of theirs, and never forgets a slight.',
    temperament: { duty: -0.4, ambition: 0.8, volatility: 0.7, whim: 0.4 },
    basePolicy: 'tyrant',
    traits: {
      ownRecipientBonus: [5, 8],
      leaderDenial: [1.6, 2.6],
      rivalDenial: [0.7, 1.2],
      grudgeWeight: [1.2, 1.8],
      trustWeight: [0, 0.3],
      backerRevocationMercy: [0, 0.5],
      throneBase: [35, 80],
      spiteWeight: [1.2, 2.5],
    },
  },
  {
    id: 'patron',
    title: 'Patron',
    summary: 'Rules through favours. Hands offices to allies and backers, builds a coalition, and expects loyalty in return.',
    temperament: { duty: 0.0, ambition: -0.2, volatility: 0.8, whim: 0.4 },
    basePolicy: 'patron',
    traits: {
      ownRecipientBonus: [0, 2.5],
      backerTitleReward: [1.5, 2.4],
      backerRevocationMercy: [1.4, 2.4],
      reciprocityWeight: [0.9, 1.8],
      favorSeekingWeight: [0.6, 1.6],
      trustWeight: [0.5, 1.2],
    },
  },
  // Four ways of serving yourself at the empire's expense.
  {
    id: 'miser',
    title: 'Miser',
    summary: 'Hoards gold. Dismisses most of its troops for gold, buys little, and leaves the war and the throne to others.',
    temperament: { duty: -0.6, ambition: -0.4, volatility: 0.6, whim: 0.3 },
    basePolicy: 'strategic',
    traits: {
      reserveValue: [1, 1.4],
      invasionShortfallPenalty: [1, 3],
      invasionSurplusPenalty: [1.5, 3],
      allyDefenseReliance: [0.95, 1],
      estatePriceWeight: [1.4, 2.4],
      mercenaryCostPenalty: [0.35, 0.55],
      throneBase: [0, 12],
    },
  },
  {
    id: 'hoarder',
    title: 'Hoarder',
    summary: 'Keeps every office it can for its own dynasty and strips rivals of theirs, even when the empire raises fewer troops for it.',
    temperament: { duty: 0.1, ambition: 0.0, volatility: 0.7, whim: 0.4 },
    basePolicy: 'strategic',
    traits: {
      ownRecipientBonus: [5.5, 8],
      appointmentUnlockBonus: [0, 1.5],
      rivalDenial: [0.8, 1.2],
      leaderDenial: [1.6, 2.6],
      backerRevocationMercy: [0, 0.6],
      throneBase: [0, 30],
    },
  },
  {
    id: 'saboteur',
    title: 'Saboteur',
    summary: 'Defends only where its own estates stand, and lets provinces fall when rivals it dislikes, or the leader, hold land or offices there.',
    temperament: { duty: -0.3, ambition: 0.2, volatility: 1.1, whim: 0.6 },
    basePolicy: 'strategic',
    traits: {
      spiteWeight: [1.8, 2.5],
      grudgeWeight: [1, 1.8],
      leaderDenial: [1.6, 2.6],
      allyDefenseReliance: [0.85, 1],
      invasionShortfallPenalty: [1, 4],
      capitalFallPenalty: [100, 700],
    },
  },
  {
    id: 'glory',
    title: 'Glory Hunter',
    summary: 'Fights hard at the frontier to be the best defender, then spends the gold and Triumph on seizing the throne.',
    temperament: { duty: 0.6, ambition: 0.6, volatility: 1.0, whim: 0.5 },
    basePolicy: 'strategic',
    traits: {
      recoveryBonus: [1.6, 2.5],
      invasionSafetyValue: [1.8, 4],
      throneBase: [30, 80],
      selfClaim: [1.2, 2.4],
      coupOpportunityWeight: [1.2, 2.4],
    },
  },
  // Three more ways to play, to widen what training meets.
  {
    id: 'turncoat',
    title: 'Turncoat',
    summary: 'Owes nobody anything: forgets favours and grudges alike, backs whoever serves it this round, and never rewards those who backed it.',
    temperament: { duty: -0.1, ambition: 0.3, volatility: 1.6, whim: 0.9 },
    basePolicy: 'strategic',
    traits: {
      reciprocityWeight: [0, 0.3],
      trustWeight: [0, 0.2],
      grudgeWeight: [0, 0.3],
      relationshipCoupWeight: [0, 0.3],
      backerTitleReward: [0, 0.4],
      backerRevocationMercy: [0, 0.4],
    },
  },
  {
    id: 'loyalist',
    title: 'Loyalist',
    summary: 'Stands by the sitting Basileus in the coup and holds the frontier, counting on offices and a Basileus who spares its estates.',
    temperament: { duty: 0.6, ambition: -0.8, volatility: 0.5, whim: 0.3 },
    basePolicy: 'loyalist',
    traits: {
      supportOtherClaimant: [0, 0.3],
      regimeUrgencyWeight: [0, 0.5],
      selfClaim: [0.05, 0.6],
      throneBase: [0, 15],
      basileusTitleExpectation: [1, 2.4],
      allyDefenseReliance: [0.55, 0.8],
    },
  },
  {
    id: 'prelate',
    title: 'Prelate',
    summary: 'Builds up the Church: as Patriarch it fills every bishopric it can, rivals included, and keeps the Bishops it finds instead of revoking them.',
    temperament: { duty: 0.3, ambition: -0.1, volatility: 0.8, whim: 0.4 },
    basePolicy: 'strategic',
    traits: {
      bishopAppointBonus: [3, 6],
      bishopKeepWeight: [3, 6],
    },
  },
  // An explorer: no temperament at all. It starts from its own random point
  // of the whole weight space and trains with bolder steps, to find ways of
  // winning the others do not try.
  {
    id: 'maverick',
    title: 'Maverick',
    summary: 'Found its own way from a random start: seizes the throne with troops in Constantinople, keeps for itself the offices it hands out, leaves rivals\' offices alone, and backs other challengers as its second choice.',
    temperament: { duty: -0.2, ambition: 0.6, volatility: 1.2, whim: 0.8 },
    basePolicy: 'strategic',
    explore: { seed: 1101 },
    traits: {},
  },
  {
    id: 'strategist',
    title: 'Strategist',
    summary: 'No fixed temperament. Weighs every move by how much it raises its own chance to win: it defends when it must and goes for the throne when the odds are good.',
    temperament: { duty: 0.0, ambition: 0.0, volatility: 1.0, whim: 0.4 },
    basePolicy: 'strategic',
    traits: {},
  },
]);

export const PERSONALITY_IDS = Object.freeze(PERSONALITIES.map((personality) => personality.id));

export function getPersonality(id) {
  return PERSONALITIES.find((personality) => personality.id === id) || null;
}

// The range training may use for one weight under this personality.
export function personalityWeightRange(personality, key) {
  return personality?.traits?.[key] || STRATEGY_WEIGHT_BOUNDS[key] || null;
}

// Clamps every trainable weight into the personality's ranges. Weights the
// trainer does not tune (such as courtGainFloor) pass through unchanged.
export function clampToPersonality(personality, weights = {}) {
  const clamped = { ...weights };
  for (const key of TRAINABLE_WEIGHT_KEYS) {
    const [min, max] = personalityWeightRange(personality, key);
    const value = Number(clamped[key]);
    const fallback = Number(DEFAULT_STRATEGY_WEIGHTS[key]);
    const base = Number.isFinite(value) ? value : Number.isFinite(fallback) ? fallback : (min + max) / 2;
    clamped[key] = Math.min(max, Math.max(min, base));
  }
  return clamped;
}

export function isWithinPersonality(personality, weights = {}) {
  return TRAINABLE_WEIGHT_KEYS.every((key) => {
    const [min, max] = personalityWeightRange(personality, key);
    const value = Number(weights[key]);
    return Number.isFinite(value) && value >= min - 1e-9 && value <= max + 1e-9;
  });
}
