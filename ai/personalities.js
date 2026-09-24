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
  estateBidCost: [0.35, 2.4],
  estateBidPressure: [0, 3],
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
});

export const TRAINABLE_WEIGHT_KEYS = Object.freeze(Object.keys(STRATEGY_WEIGHT_BOUNDS));

// `basePolicy` names the ai/policies.js preset training starts from.
// `traits` are the weight ranges that make the temperament; each must sit
// inside STRATEGY_WEIGHT_BOUNDS.
export const PERSONALITIES = Object.freeze([
  {
    id: 'usurper',
    title: 'Usurper',
    summary: 'Wants the purple for itself. Pulls troops back to the capital whenever the frontier looks safe enough and gambles on seizing the throne.',
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
    basePolicy: 'freeRider',
    traits: {
      allyDefenseReliance: [0.9, 1],
      invasionShortfallPenalty: [1, 4],
      invasionSafetyValue: [0, 0.6],
      invasionSurplusPenalty: [0.8, 3],
      defenseContextWeight: [0, 0.8],
      reserveValue: [0.5, 1.4],
    },
  },
  {
    id: 'landlord',
    title: 'Landlord',
    summary: 'Buys every estate it can afford and lives off the rents. Cares little who wears the crown as long as its lands stay safe.',
    basePolicy: 'profiteer',
    traits: {
      estateProfit: [5.5, 9],
      estateBidCost: [0.35, 1.2],
      estateBidPressure: [0.5, 3],
      reserveValue: [0.15, 0.4],
      throneBase: [0, 28],
      selfClaim: [0.05, 1.1],
    },
  },
  {
    id: 'kingmaker',
    title: 'Kingmaker',
    summary: 'Rarely claims the throne itself. Backs whichever claimant will pay best in offices, and remembers who kept their word.',
    basePolicy: 'kingmaker',
    traits: {
      throneBase: [0, 20],
      selfClaim: [0.05, 0.7],
      supportOtherClaimant: [1.1, 1.8],
      relationshipCoupWeight: [1, 1.8],
      basileusTitleExpectation: [1.2, 2.4],
      reciprocityWeight: [0.8, 1.8],
    },
  },
  {
    id: 'tyrant',
    title: 'Tyrant',
    summary: 'Takes power and uses it. Keeps offices for itself, strips titles from rivals, and never forgets a slight.',
    basePolicy: 'tyrant',
    traits: {
      ownRecipientBonus: [5, 8],
      leaderDenial: [1.6, 2.6],
      rivalDenial: [0.7, 1.2],
      grudgeWeight: [1.2, 1.8],
      trustWeight: [0, 0.3],
      backerRevocationMercy: [0, 0.5],
      throneBase: [35, 80],
    },
  },
  {
    id: 'patron',
    title: 'Patron',
    summary: 'Rules through favours. Hands offices to allies and backers, builds a coalition, and expects loyalty in return.',
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
  {
    id: 'strategist',
    title: 'Strategist',
    summary: 'No fixed temperament. Weighs every move by how much it raises its own chance to win, and adapts to the table.',
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
