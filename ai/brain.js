import { AI_NUM, withAINumericTuning } from './numericConstants.js';
import {
  getFreeThemes,
  getPlayer,
  getPlayerThemes,
  shuffle,
  formatPlayerLabel,
  getPlayerMercenaryAssignments,
  getPlayerMercenaryTotal,
  hasSelfAppointmentLock,
  hasRevocationTargetLock,
  MERCENARY_COMPANY_KEY,
} from '../engine/state.js';
import { recordHistoryEvent, updateHistoryEvent } from '../engine/history.js';
import {
  appointBishop,
  appointCourtTitle,
  appointStrategos,
  applyCoupTitleReassignment,
  buyTheme,
  canPayAppointmentCost,
  canPayPatriarchBishopAppointmentCost,
  canPayPatriarchBishopRevocationCost,
  dismissProfessional,
  canRecruitProfessional,
  checkRevocationCurrentTurnAppointment,
  getPatriarchBishopAppointmentGoldCost,
  getPatriarchBishopRevocationGoldCost,
  getLandAuction,
  getMinimumLandBid,
  getNextAppointmentCost,
  giftToChurch,
  getPlayerProfessionalUpkeep,
  hireMercenaries,
  recruitProfessional,
  revokeMinorTitle,
  revokeTheme,
  revokeCourtTitle,
  canPayRevocationCost,
  getNextRevocationCost,
  validateMajorTitleAssignments,
} from '../engine/actions.js';
import {
  getMercenaryHireCost,
  getNormalOwnerIncome,
  getNormalTaxIncome,
  getThemeChurchValue,
  getThemeLandPrice,
  getThemeOwnerIncome,
} from '../engine/rules.js';
import { buildFinalScores, SCORE_SHARE_THRESHOLDS } from '../engine/scoring.js';
import { MAJOR_TITLES } from '../data/titles.js';
import {
  DEFAULT_META_PARAMS,
  DEFAULT_MIXED_DECK_SIZES,
  MAJOR_TITLE_KEYS,
  META_PARAM_KEYS,
  NEUTRAL_PROFILE,
  PERSONALITIES,
  POPULATION_PRESETS,
  PROFILE_TACTIC_KEYS,
  PROFILE_WEIGHT_KEYS,
  SUPPORTED_PLAYER_COUNTS,
} from './personalities.js';
import { normalizeAiProfile } from './profileStore.js';
import {
  DEAL_CLAUSE_KINDS,
  DEAL_TRIGGER_TYPES,
  autoRefuseAwaitingDeals,
  buildOrderLocksForPlayer,
  getIncomingDealsForPlayer,
  getOutgoingDealsForPlayer,
  getSpendableGold,
  normalizeOrdersWithDealLocks,
  previewDealOffer,
  respondToDeal,
  sendDealOffer,
  summarizeDealOfferImpact,
} from '../engine/deals.js';
import {
  ensureAIContext,
  invalidateAIContext as invalidateSystemicAIContext,
} from './context.js';
import {
  AI_ACTION_KINDS,
  AI_ACTION_PHASES,
} from './actionSpace.js';
import {
  normalizePolicyGenome,
  scorePolicyAction,
} from './policyGenome.js';
import {
  recordSelectedActionProjection,
  scoreActionPolicy,
} from './consequences.js';

const PUBLIC_LOG_LIMIT = AI_NUM.N_48;
const DEAL_SINGLE_PAYLOAD_HARD_LIMIT = AI_NUM.N_36;
const DEAL_COMBO_ASK_HARD_LIMIT = AI_NUM.N_7;
const DEAL_COMBO_GIVE_HARD_LIMIT = AI_NUM.N_5;
const DEAL_TOTAL_PAYLOAD_HARD_LIMIT = AI_NUM.N_56;
const DEAL_INTENT_PAYLOAD_HARD_LIMIT = AI_NUM.N_24;
const DEAL_PROPOSAL_OPTION_HARD_LIMIT = AI_NUM.N_12;
const DEAL_COUNTER_OPTION_HARD_LIMIT = AI_NUM.N_8;
const ORDER_PLAN_HARD_LIMIT = AI_NUM.N_1024;
const TITLE_ASSIGNMENT_HARD_LIMIT = AI_NUM.N_1024;
const MERCENARY_HIRE_HARD_LIMIT = AI_NUM.N_12;
const DEAL_INTENTS = {
  GENERIC: 'generic',
  GENERIC_EXCHANGE: 'generic_exchange',
  COALITION_COORDINATION: 'coalition_coordination',
  SPLIT_FRONTIER_DEFENSE: 'split_frontier_defense',
  SUPPORT_FOR_REWARD: 'support_for_reward',
  PROTECTION_FOR_SUPPORT: 'protection_for_support',
  ESTATE_TRADE: 'estate_trade',
  GOLD_MAKEWEIGHT: 'gold_makeweight',
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sum(values) {
  return values.reduce((total, value) => total + value, AI_NUM.N_0);
}

function average(values) {
  return values.length ? sum(values) / values.length : AI_NUM.N_0;
}

function roundTo(value, digits = AI_NUM.N_2) {
  const scale = AI_NUM.N_10 ** digits;
  return Math.round(value * scale) / scale;
}

function incrementMapCount(map, key, amount = AI_NUM.N_1) {
  if (key == null) return;
  map.set(key, (map.get(key) || AI_NUM.N_0) + amount);
}

function getFastCache(state, meta) {
  if (!meta) return null;
  const key = `${state.round}|${state.phase}|${state.basileusId}`;
  if (meta.fastCache?.key === key) return meta.fastCache;

  const themes = Object.values(state.themes);
  const themesByOwner = new Map();
  const minorTitleCounts = new Map();
  const professionalCountByPlayer = new Map();
  const landIncomeByPlayer = new Map();
  const exposureByPlayer = new Map();
  const threatenedLandValueByPlayer = new Map();
  let occupiedThemeCount = AI_NUM.N_0;
  let totalThemeCount = AI_NUM.N_0;

  for (const player of state.players) {
    themesByOwner.set(player.id, []);
    minorTitleCounts.set(player.id, AI_NUM.N_0);
    professionalCountByPlayer.set(player.id, getPlayerProfessionalCount(player));
    landIncomeByPlayer.set(player.id, AI_NUM.N_0);
    exposureByPlayer.set(player.id, AI_NUM.N_0);
    threatenedLandValueByPlayer.set(player.id, AI_NUM.N_0);
  }

  incrementMapCount(minorTitleCounts, state.empress);
  incrementMapCount(minorTitleCounts, state.chiefEunuchs);

  for (const theme of themes) {
    if (theme.id !== 'CPL') {
      totalThemeCount++;
      if (theme.occupied) occupiedThemeCount++;
    }

    if (themesByOwner.has(theme.owner)) {
      themesByOwner.get(theme.owner).push(theme);
      landIncomeByPlayer.set(theme.owner, (landIncomeByPlayer.get(theme.owner) || AI_NUM.N_0) + getThemeOwnerIncome(theme));
      const routeRisk = getThemeRouteRisk(state, theme.id);
      exposureByPlayer.set(theme.owner, (exposureByPlayer.get(theme.owner) || AI_NUM.N_0) + routeRisk);
      threatenedLandValueByPlayer.set(
        theme.owner,
        (threatenedLandValueByPlayer.get(theme.owner) || AI_NUM.N_0) + (routeRisk * getThemeStrategicValue(theme))
      );
    }

    if (!theme.occupied) {
      incrementMapCount(minorTitleCounts, theme.strategos);
      incrementMapCount(minorTitleCounts, theme.bishop);
    }
  }

  meta.fastCache = {
    key,
    themes,
    themesByOwner,
    minorTitleCounts,
    professionalCountByPlayer,
    landIncomeByPlayer,
    exposureByPlayer,
    threatenedLandValueByPlayer,
    occupiedThemeCount,
    totalThemeCount,
    threatLevel: null,
    empireDanger: null,
    finalScores: null,
    standings: null,
    standingSnapshots: new Map(),
  };
  return meta.fastCache;
}

function getCachedPlayerThemes(state, meta, playerId) {
  const cache = getFastCache(state, meta);
  return cache?.themesByOwner.get(playerId) || getPlayerThemes(state, playerId);
}

function getCachedMinorTitleCount(state, meta, playerId) {
  const cache = getFastCache(state, meta);
  return cache?.minorTitleCounts.get(playerId) ?? getMinorTitleCount(state, playerId);
}

function getCachedProfessionalCount(state, meta, playerId) {
  const cache = getFastCache(state, meta);
  if (cache?.professionalCountByPlayer.has(playerId)) return cache.professionalCountByPlayer.get(playerId);
  return getPlayerProfessionalCount(getPlayer(state, playerId));
}

function createDecisionLog(enabled) {
  const lines = [];
  return {
    lines,
    push(message) {
      if (enabled) lines.push(message);
    },
  };
}

function uniqueList(items) {
  return [...new Set(items)];
}

function normalizeHumanPlayerIds(playerCount, humanPlayerIds = []) {
  return new Set(
    uniqueList(humanPlayerIds.map(value => Number(value)))
      .filter(value => Number.isInteger(value) && value >= AI_NUM.N_0 && value < playerCount)
  );
}

export function getPersonalityProfile(meta, playerId) {
  const playerMeta = meta.players[playerId];
  if (playerMeta?.profile) return playerMeta.profile;
  const personalityId = playerMeta?.personalityId;
  return PERSONALITIES[personalityId] || NEUTRAL_PROFILE;
}

// ---------------------------------------------------------------------------
// Tier 2: meta-parameter access. Trained profiles can store tuned constants
// under `meta`; missing keys fall back to the neutral engine defaults.
// ---------------------------------------------------------------------------
function getMeta(profile, key) {
  if (!profile) return DEFAULT_META_PARAMS[key];
  if (profile.meta && profile.meta[key] != null) return profile.meta[key];
  return DEFAULT_META_PARAMS[key];
}

function getMetaForPlayer(meta, playerId, key) {
  return getMeta(getPersonalityProfile(meta, playerId), key);
}

function getPolicyForPlayer(meta, playerId) {
  const profile = getPersonalityProfile(meta, playerId);
  const policySource = profile?.policy || null;
  const playerMeta = meta?.players?.[playerId] || null;
  if (playerMeta?.policyCache?.source === policySource) {
    return playerMeta.policyCache.policy;
  }
  const policy = normalizePolicyGenome(policySource || {});
  if (playerMeta) {
    playerMeta.policyCache = { source: policySource, policy };
  }
  return policy;
}

function withPolicyNumericTuning(meta, playerId, callback) {
  return withAINumericTuning(getPolicyForPlayer(meta, playerId).numericTuning, callback);
}

function getPolicyLimit(meta, playerId, key, hardLimit) {
  const policy = getPolicyForPlayer(meta, playerId);
  const value = Math.round(Number(policy[key]) || hardLimit);
  return Math.max(AI_NUM.N_1, Math.min(hardLimit, value));
}

function evaluateSystemicAction(state, meta, playerId, descriptor, baseScore = AI_NUM.N_0, stage = state.phase) {
  try {
    return scoreActionPolicy(
      state,
      meta,
      playerId,
      {
        phase: stage,
        ...descriptor,
      },
      baseScore,
      ensureAIContext(state, meta, stage),
    );
  } catch {
    return {
      descriptor,
      impact: {},
      total: AI_NUM.N_0,
      score: baseScore,
    };
  }
}

function applySystemicScore(state, meta, playerId, descriptor, baseScore = AI_NUM.N_0, stage = state.phase) {
  return evaluateSystemicAction(state, meta, playerId, descriptor, baseScore, stage).score;
}

function rememberSystemicDecision(state, meta, playerId, descriptor, baseScore = AI_NUM.N_0, stage = state.phase) {
  const evaluation = evaluateSystemicAction(state, meta, playerId, descriptor, baseScore, stage);
  recordSelectedActionProjection(meta, playerId, evaluation);
  return evaluation;
}

// ---------------------------------------------------------------------------
// Tier 5: opponent modeling. Each AI maintains a posterior over what kind of
// rival it is facing, updated from observed actions. Crucially, the posterior
// is defined over the active profile library in the current game rather than a
// hard-coded archetype set, which keeps self-play emergent.
//
// Important safety rule: decisions never blend in the rival's hidden, true
// profile. The AI can only use its prior plus observed evidence. The
// `opponentTrust` meta-parameter controls how strongly it trusts its posterior
// over its uninformed prior, not whether it gets privileged information.
// ---------------------------------------------------------------------------
function getProfileBasis(meta) {
  return Array.isArray(meta?.profileBasis) && meta.profileBasis.length
    ? meta.profileBasis
    : [NEUTRAL_PROFILE];
}

function ensureOpponentModel(meta, observerId, targetId) {
  const observerMeta = meta.players[observerId];
  if (!observerMeta) return null;
  if (!observerMeta.opponentModels) observerMeta.opponentModels = {};
  if (!observerMeta.opponentModels[targetId]) {
    const basisProfiles = getProfileBasis(meta);
    const basisIds = basisProfiles.map((profile, index) => profile.id || profile.name || `basis-${index}`);
    const uniform = AI_NUM.N_1 / Math.max(AI_NUM.N_1, basisIds.length);
    observerMeta.opponentModels[targetId] = {
      typePosterior: Object.fromEntries(basisIds.map(id => [id, uniform])),
      observations: AI_NUM.N_0,
      aggressionEstimate: AI_NUM.N_0_5,
      loyaltyEstimate: AI_NUM.N_0_5,
      frontierCooperationEstimate: AI_NUM.N_0_5,
      coupRiskEstimate: AI_NUM.N_0_5,
    };
  }
  return observerMeta.opponentModels[targetId];
}

function buildBeliefWeightedProfile(basisProfiles, distribution = null) {
  const basis = Array.isArray(basisProfiles) && basisProfiles.length ? basisProfiles : [NEUTRAL_PROFILE];
  const defaultWeight = AI_NUM.N_1 / Math.max(AI_NUM.N_1, basis.length);
  const weights = {};

  for (const key of PROFILE_WEIGHT_KEYS) {
    let inferred = AI_NUM.N_0;
    for (const [index, profile] of basis.entries()) {
      const basisId = profile.id || profile.name || `basis-${index}`;
      const probability = distribution?.[basisId] ?? defaultWeight;
      inferred += probability * (profile.weights?.[key] || AI_NUM.N_0);
    }
    weights[key] = inferred;
  }

  return {
    ...NEUTRAL_PROFILE,
    id: 'inferred-opponent',
    name: 'Inferred Opponent',
    shortName: 'Inferred',
    source: 'belief-model',
    weights,
  };
}

function blendedOpponentProfile(meta, observerId, targetId) {
  const truth = getPersonalityProfile(meta, targetId);
  if (observerId == null || observerId === targetId) return truth;
  const observerProfile = getPersonalityProfile(meta, observerId);
  const trust = getMeta(observerProfile, 'opponentTrust');
  const basisProfiles = getProfileBasis(meta);
  const defaultWeight = AI_NUM.N_1 / Math.max(AI_NUM.N_1, basisProfiles.length);
  const prior = Object.fromEntries(
    basisProfiles.map((profile, index) => [profile.id || profile.name || `basis-${index}`, defaultWeight])
  );
  if (trust <= AI_NUM.N_0_001) return buildBeliefWeightedProfile(basisProfiles, prior);
  const model = ensureOpponentModel(meta, observerId, targetId);
  if (!model) return buildBeliefWeightedProfile(basisProfiles, prior);

  const posterior = model.observations > AI_NUM.N_0 ? model.typePosterior : prior;
  const distribution = {};
  for (const basisId of Object.keys(prior)) {
    distribution[basisId] =
      ((AI_NUM.N_1 - trust) * (prior[basisId] || AI_NUM.N_0)) +
      (trust * (posterior[basisId] || AI_NUM.N_0));
  }
  return buildBeliefWeightedProfile(basisProfiles, distribution);
}

function updateOpponentPosterior(meta, observerId, targetId, observedFeatures) {
  if (observerId == null || targetId == null || observerId === targetId) return;
  const observerProfile = getPersonalityProfile(meta, observerId);
  const learnRate = getMeta(observerProfile, 'opponentLearnRate');
  if (learnRate <= AI_NUM.N_0) return;
  const model = ensureOpponentModel(meta, observerId, targetId);
  if (!model) return;
  // Compute likelihood of each profile basis entry given the observation.
  // observedFeatures: { gift, throneVoteAgainstIncumbent, mercenarySpend, recruit, revocation, frontierShare }
  // Each feature is a 0..1 normalised intensity.
  const basisProfiles = getProfileBasis(meta);
  const likelihoods = {};
  let total = AI_NUM.N_0;
  for (const [index, profile] of basisProfiles.entries()) {
    const basisId = profile.id || profile.name || `basis-${index}`;
    const w = profile.weights || NEUTRAL_PROFILE.weights;
    let logL = AI_NUM.N_0;
    if (observedFeatures.gift != null) {
      logL += observedFeatures.gift * Math.log(AI_NUM.N_0_2 + w.church);
      logL += (AI_NUM.N_1 - observedFeatures.gift) * Math.log(AI_NUM.N_0_5 + w.land);
    }
    if (observedFeatures.throneAgainstIncumbent != null) {
      logL += observedFeatures.throneAgainstIncumbent * Math.log(AI_NUM.N_0_3 + w.throne + w.retaliation);
    }
    if (observedFeatures.mercenarySpend != null) {
      logL += observedFeatures.mercenarySpend * Math.log(AI_NUM.N_0_2 + w.mercenary);
    }
    if (observedFeatures.recruit != null) {
      logL += observedFeatures.recruit * Math.log(AI_NUM.N_0_3 + w.frontier + w.mercenary * AI_NUM.N_0_5);
    }
    if (observedFeatures.revocation != null) {
      logL += observedFeatures.revocation * Math.log(AI_NUM.N_0_2 + w.revocation);
    }
    if (observedFeatures.frontierShare != null) {
      logL += observedFeatures.frontierShare * Math.log(AI_NUM.N_0_3 + w.frontier);
      logL += (AI_NUM.N_1 - observedFeatures.frontierShare) * Math.log(AI_NUM.N_0_3 + w.capital + w.throne);
    }
    likelihoods[basisId] = Math.exp(logL);
    total += likelihoods[basisId];
  }
  if (total <= AI_NUM.N_0 || !Number.isFinite(total)) return;
  // Bayesian update with learning-rate smoothing
  for (const basisId of Object.keys(model.typePosterior)) {
    const evidence = (likelihoods[basisId] || AI_NUM.N_0) / total;
    model.typePosterior[basisId] =
      (AI_NUM.N_1 - learnRate) * model.typePosterior[basisId] +
      learnRate * evidence;
  }
  // Renormalise (should already be ~1, but float drift)
  const norm = Object.values(model.typePosterior).reduce((s, v) => s + v, AI_NUM.N_0) || AI_NUM.N_1;
  for (const basisId of Object.keys(model.typePosterior)) {
    model.typePosterior[basisId] /= norm;
  }
  let aggression = AI_NUM.N_0;
  let loyalty = AI_NUM.N_0;
  let frontierCooperation = AI_NUM.N_0;
  let coupRisk = AI_NUM.N_0;
  for (const [index, profile] of basisProfiles.entries()) {
    const basisId = profile.id || profile.name || `basis-${index}`;
    const posterior = model.typePosterior[basisId] || AI_NUM.N_0;
    const weights = profile.weights || NEUTRAL_PROFILE.weights;
    aggression += posterior * clamp((weights.throne + weights.capital + weights.mercenary) / AI_NUM.N_9, AI_NUM.N_0, AI_NUM.N_1);
    loyalty += posterior * clamp(weights.loyalty / AI_NUM.N_4_5, AI_NUM.N_0, AI_NUM.N_1);
    frontierCooperation += posterior * clamp(weights.frontier / AI_NUM.N_4_5, AI_NUM.N_0, AI_NUM.N_1);
    coupRisk += posterior * clamp((weights.throne + weights.retaliation) / AI_NUM.N_9, AI_NUM.N_0, AI_NUM.N_1);
  }
  model.aggressionEstimate = aggression;
  model.loyaltyEstimate = loyalty;
  model.frontierCooperationEstimate = frontierCooperation;
  model.coupRiskEstimate = coupRisk;
  model.observations++;
}

// ---------------------------------------------------------------------------
// Tier 6: stochastic action selection. Replaces argmax with softmax sampling
// at evolvable temperature τ. Low τ approximates the original deterministic
// behaviour; higher τ unlocks exploration the GA can exploit.
// ---------------------------------------------------------------------------
function softmaxPick(rankedOptions, temperature, rng) {
  if (!rankedOptions.length) return null;
  const sortedOptions = [...rankedOptions].sort((left, right) => {
    const leftScore = Number.isFinite(left?.score) ? left.score : (left?.policyScore || AI_NUM.N_0);
    const rightScore = Number.isFinite(right?.score) ? right.score : (right?.policyScore || AI_NUM.N_0);
    return rightScore - leftScore;
  });
  if (temperature <= AI_NUM.N_0_05 || sortedOptions.length === AI_NUM.N_1) return sortedOptions[AI_NUM.N_0];
  // Numerical stability: subtract max
  const maxScore = Math.max(...sortedOptions.map(opt => Number.isFinite(opt?.score) ? opt.score : (opt?.policyScore || AI_NUM.N_0)));
  const weights = sortedOptions.map((opt) => {
    const score = Number.isFinite(opt?.score) ? opt.score : (opt?.policyScore || AI_NUM.N_0);
    return Math.exp((score - maxScore) / Math.max(AI_NUM.N_0_05, temperature));
  });
  const total = weights.reduce((s, v) => s + v, AI_NUM.N_0);
  if (total <= AI_NUM.N_0 || !Number.isFinite(total)) return sortedOptions[AI_NUM.N_0];
  let cursor = rng() * total;
  for (let index = AI_NUM.N_0; index < sortedOptions.length; index++) {
    cursor -= weights[index];
    if (cursor <= AI_NUM.N_0) return sortedOptions[index];
  }
  return sortedOptions[sortedOptions.length - AI_NUM.N_1];
}

export function getPlayerProfessionalCount(player) {
  return sum(Object.values(player.professionalArmies || {}));
}

export function getMinorTitleCount(state, playerId) {
  let count = AI_NUM.N_0;
  if (state.empress === playerId) count++;
  if (state.chiefEunuchs === playerId) count++;
  for (const theme of Object.values(state.themes)) {
    if (theme.occupied) continue;
    if (theme.strategos === playerId) count++;
    if (theme.bishop === playerId) count++;
  }
  return count;
}

function getPlayerInfluence(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  return (
    AI_NUM.N_1 +
    player.gold * AI_NUM.N_0_12 +
    getCachedPlayerThemes(state, meta, playerId).length * AI_NUM.N_0_9 +
    getCachedProfessionalCount(state, meta, playerId) * AI_NUM.N_1_1 +
    player.majorTitles.length * AI_NUM.N_1_7 +
    getCachedMinorTitleCount(state, meta, playerId) * AI_NUM.N_0_45 +
    (playerId === state.basileusId ? AI_NUM.N_1_8 : AI_NUM.N_0) +
    (meta.players[playerId]?.stats?.throneCaptures || AI_NUM.N_0) * AI_NUM.N_0_8
  );
}

export function getPlayerStrength(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  return (
    player.gold +
    getCachedPlayerThemes(state, meta, playerId).length * AI_NUM.N_1_5 +
    getCachedProfessionalCount(state, meta, playerId) * AI_NUM.N_1_2 +
    player.majorTitles.length * AI_NUM.N_2_2 +
    getCachedMinorTitleCount(state, meta, playerId) * AI_NUM.N_0_8 +
    (playerId === state.basileusId ? AI_NUM.N_3 : AI_NUM.N_0) +
    (meta.players[playerId]?.stats?.throneCaptures || AI_NUM.N_0) * AI_NUM.N_0_8
  );
}

function getPlayerIncomePotential(state, playerId, meta = null) {
  const cache = getFastCache(state, meta);
  if (cache?.landIncomeByPlayer.has(playerId)) return cache.landIncomeByPlayer.get(playerId);
  return getPlayerThemes(state, playerId).reduce((total, theme) => total + getThemeOwnerIncome(theme), AI_NUM.N_0);
}

function getThemeStrategicValue(theme) {
  return (theme.P * AI_NUM.N_1_35) + (theme.L * AI_NUM.N_0_95);
}

function getRemainingRounds(state) {
  return Math.max(AI_NUM.N_0, state.maxRounds - state.round);
}

function getThemeRouteRisk(state, themeId) {
  if (!state.currentInvasion) return AI_NUM.N_0;
  const routeIndex = state.currentInvasion.route.indexOf(themeId);
  if (routeIndex === -AI_NUM.N_1) return AI_NUM.N_0;
  const usableLength = Math.max(AI_NUM.N_1, state.currentInvasion.route.length - AI_NUM.N_2);
  return clamp(AI_NUM.N_1 - (routeIndex / usableLength), AI_NUM.N_0, AI_NUM.N_1);
}

function getPlayerExposure(state, playerId, meta = null) {
  const cache = getFastCache(state, meta);
  if (cache?.exposureByPlayer.has(playerId)) return cache.exposureByPlayer.get(playerId);
  return getPlayerThemes(state, playerId).reduce((total, theme) => total + getThemeRouteRisk(state, theme.id), AI_NUM.N_0);
}

function getPlayerThreatenedLandValue(state, playerId, meta = null) {
  const cache = getFastCache(state, meta);
  if (cache?.threatenedLandValueByPlayer.has(playerId)) return cache.threatenedLandValueByPlayer.get(playerId);
  return getPlayerThemes(state, playerId).reduce(
    (total, theme) => total + (getThemeRouteRisk(state, theme.id) * getThemeStrategicValue(theme)),
    AI_NUM.N_0
  );
}

function getRivalThreatenedLandValue(state, playerId, meta = null) {
  return state.players
    .filter(player => player.id !== playerId)
    .reduce((total, player) => total + getPlayerThreatenedLandValue(state, player.id, meta), AI_NUM.N_0);
}

export function getThreatLevel(state, meta = null) {
  if (!state.currentInvasion) return AI_NUM.N_0_25;
  const cache = getFastCache(state, meta);
  if (cache && cache.threatLevel != null) return cache.threatLevel;

  const [minStrength, maxStrength] = state.currentInvasion.strength;
  const invasionMean = (minStrength + maxStrength) / AI_NUM.N_2;
  const occupiedThemes = cache?.occupiedThemeCount ?? Object.values(state.themes).filter(theme => theme.occupied && theme.id !== 'CPL').length;
  const totalThemes = cache?.totalThemeCount ?? Object.values(state.themes).filter(theme => theme.id !== 'CPL').length;
  const totalPotentialTroops =
    sum(Object.values(state.currentLevies || {})) +
    sum(state.players.map(player => getCachedProfessionalCount(state, meta, player.id)));

  const occupationPressure = occupiedThemes / Math.max(AI_NUM.N_1, totalThemes);
  const troopPressure = (invasionMean - (totalPotentialTroops * AI_NUM.N_0_55)) / Math.max(AI_NUM.N_1, invasionMean);
  const threat = clamp(AI_NUM.N_0_35 + occupationPressure * AI_NUM.N_0_9 + troopPressure * AI_NUM.N_0_8, AI_NUM.N_0, AI_NUM.N_1_6);
  if (cache) cache.threatLevel = threat;
  return threat;
}

function getEmpireDanger(state, meta = null) {
  if (!state.currentInvasion) return AI_NUM.N_0_2;
  const cache = getFastCache(state, meta);
  if (cache && cache.empireDanger != null) return cache.empireDanger;
  const threat = getThreatLevel(state, meta);
  const occupiedThemes = cache?.occupiedThemeCount ?? Object.values(state.themes).filter(theme => theme.occupied && theme.id !== 'CPL').length;
  const totalThemes = Math.max(AI_NUM.N_1, cache?.totalThemeCount ?? Object.values(state.themes).filter(theme => theme.id !== 'CPL').length);
  const occupationRatio = occupiedThemes / totalThemes;
  const danger = clamp((threat * AI_NUM.N_0_95) + (occupationRatio * AI_NUM.N_0_7), AI_NUM.N_0, AI_NUM.N_2);
  if (cache) cache.empireDanger = danger;
  return danger;
}

function getFinalScoreModel(state, meta) {
  const cache = getFastCache(state, meta);
  if (cache?.finalScores) return cache.finalScores;
  const finalScores = buildFinalScores(state);
  if (cache) cache.finalScores = finalScores;
  return finalScores;
}

function getFinalScoreEntry(state, meta, playerId) {
  return getFinalScoreModel(state, meta).scores.find(score => score.playerId === playerId) || null;
}

function getCategoryScoreEntry(state, meta, playerId, categoryKey) {
  return getFinalScoreEntry(state, meta, playerId)?.categories.find(category => category.key === categoryKey) || null;
}

function getCategoryThresholdPressure(state, meta, playerId, categoryKey) {
  const category = getCategoryScoreEntry(state, meta, playerId, categoryKey);
  if (!category) return AI_NUM.N_0;
  const share = Math.max(AI_NUM.N_0, Number(category.share) || AI_NUM.N_0);
  const points = Math.max(AI_NUM.N_0, Number(category.points) || AI_NUM.N_0);
  const nextThreshold = SCORE_SHARE_THRESHOLDS[points] ?? null;
  const gainPressure = nextThreshold == null
    ? AI_NUM.N_0_25
    : clamp(AI_NUM.N_1 - ((nextThreshold - share) / AI_NUM.N_0_25), AI_NUM.N_0, AI_NUM.N_1_25);
  const currentThreshold = points > AI_NUM.N_0 ? SCORE_SHARE_THRESHOLDS[points - AI_NUM.N_1] : AI_NUM.N_0;
  const defensePressure = points > AI_NUM.N_0 ? clamp(AI_NUM.N_1 - ((share - currentThreshold) / AI_NUM.N_0_12), AI_NUM.N_0, AI_NUM.N_1) * AI_NUM.N_0_45 : AI_NUM.N_0;
  return gainPressure + defensePressure;
}

function getPendingRewardThemeForChoice(state, choice) {
  const pending = (Array.isArray(state.pendingDefenderRewards) ? state.pendingDefenderRewards : [])
    .filter((reward) => !reward.resolved)
    .slice()
    .sort((left, right) => (Number(left.reconquestIndex) || AI_NUM.N_0) - (Number(right.reconquestIndex) || AI_NUM.N_0));
  const entry = choice === 'gold' ? pending[pending.length - AI_NUM.N_1] : pending[AI_NUM.N_0];
  return entry?.themeId || entry?.originalThemeId || null;
}

function getOccupiedRoutePressure(state, themeId) {
  if (!themeId || !state.currentInvasion?.route?.length) return AI_NUM.N_0;
  const route = state.currentInvasion.route;
  const themeIndex = route.indexOf(themeId);
  if (themeIndex === -AI_NUM.N_1) return AI_NUM.N_0;
  let pressure = AI_NUM.N_0;
  for (let index = AI_NUM.N_0; index <= themeIndex; index++) {
    const routeTheme = state.themes?.[route[index]];
    if (routeTheme?.occupied) pressure += AI_NUM.N_0_2 + (AI_NUM.N_0_16 * (themeIndex - index));
  }
  return clamp(pressure, AI_NUM.N_0, AI_NUM.N_1_4);
}

export function collectAIDefenderRewardOptions(state, meta, reward) {
  const rewardPlayerId = reward?.defenderId;
  return withPolicyNumericTuning(meta, rewardPlayerId, () => {
  if (!state || !meta || !reward) return [];
  const playerId = reward.defenderId;
  if (playerId == null || !meta.players?.[playerId]) return [];
  const goldThemeId = getPendingRewardThemeForChoice(state, 'gold') || reward.themeId;
  const restoreThemeId = getPendingRewardThemeForChoice(state, 'empire') || reward.themeId;
  const gold = Math.max(AI_NUM.N_0, Number(reward.goldValue ?? reward.gold) || AI_NUM.N_0);
  const danger = getEmpireDanger(state, meta);
  const goldPressure = getCategoryThresholdPressure(state, meta, playerId, 'gold');
  const goldRouteRisk = getThemeRouteRisk(state, goldThemeId);
  const restoreRouteRisk = getThemeRouteRisk(state, restoreThemeId);
  const restorationPressure = getOccupiedRoutePressure(state, restoreThemeId) + getPlayerExposure(state, playerId, meta);
  const remainingRounds = getRemainingRounds(state);
  const endgame = remainingRounds <= AI_NUM.N_2 ? AI_NUM.N_1 : AI_NUM.N_0;
  const restoreTheme = state.themes?.[restoreThemeId];
  const ownerRelation = restoreTheme?.owner != null && restoreTheme.owner !== 'church'
    ? getAffinityScore(meta, playerId, Number(restoreTheme.owner))
    : AI_NUM.N_0;

  return [
    makePolicyAction(
      state,
      meta,
      playerId,
      AI_ACTION_KINDS.DEFENDER_REWARD,
      AI_ACTION_PHASES.RESOLUTION,
      AI_NUM.N_0,
      {
        payload: { choice: 'gold', themeId: goldThemeId, theme: state.themes?.[goldThemeId], gold },
        gains: { gold },
        timing: 'immediate',
        reversibility: 'low',
      },
      null,
      {
        economic: goldPressure + (gold * AI_NUM.N_0_25),
        goldPressure,
        endgame,
        endgameEconomic: endgame * Math.max(AI_NUM.N_1, gold),
        risk: danger * (goldRouteRisk + restorationPressure),
      },
    ),
    makePolicyAction(
      state,
      meta,
      playerId,
      AI_ACTION_KINDS.DEFENDER_REWARD,
      AI_ACTION_PHASES.RESOLUTION,
      AI_NUM.N_0,
      {
        payload: { choice: 'empire', themeId: restoreThemeId, theme: restoreTheme, gold },
        timing: 'immediate',
        reversibility: 'low',
      },
      null,
      {
        survival: danger * AI_NUM.N_2,
        urgency: danger + (restorationPressure * AI_NUM.N_1_5),
        routeSafety: (restoreRouteRisk + getOccupiedRoutePressure(state, restoreThemeId)) * AI_NUM.N_3,
        restorationPressure: restorationPressure * AI_NUM.N_2,
        frontierCommitment: getPlayerThreatenedLandValue(state, playerId, meta),
        relation: ownerRelation,
      },
    ),
  ];
  });
}

export function chooseAIDefenderRewardChoice(state, meta, reward) {
  const rewardPlayerId = reward?.defenderId;
  return withPolicyNumericTuning(meta, rewardPlayerId, () => {
  const playerId = reward?.defenderId;
  const options = collectAIDefenderRewardOptions(state, meta, reward);
  if (!options.length || playerId == null) return 'empire';
  const selected = selectPolicyOption(state, meta, playerId, options);
  const choice = selected?.descriptor?.payload?.choice || 'empire';
  const evaluation = evaluateSystemicAction(
    state,
    meta,
    playerId,
    selected.descriptor,
    selected.policyScore,
    AI_ACTION_PHASES.RESOLUTION,
  );
  recordSelectedActionProjection(meta, playerId, evaluation);
  return choice;
  });
}

function getVictoryPositionScore(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  const remainingRounds = getRemainingRounds(state);
  const landIncome = getPlayerIncomePotential(state, playerId, meta);
  const threatenedLoss = getPlayerThreatenedLandValue(state, playerId, meta);
  const finalScore = getFinalScoreEntry(state, meta, playerId);
  const thresholdPressure = ['church', 'estate', 'tax', 'gold'].reduce(
    (total, categoryKey) => total + getCategoryThresholdPressure(state, meta, playerId, categoryKey),
    AI_NUM.N_0,
  );
  return (
    ((finalScore?.points || AI_NUM.N_0) * AI_NUM.N_9) +
    (thresholdPressure * AI_NUM.N_1_4) +
    (player.gold * AI_NUM.N_0_35) +
    (landIncome * (AI_NUM.N_0_8 + (remainingRounds * AI_NUM.N_0_35))) +
    (getCachedProfessionalCount(state, meta, playerId) * AI_NUM.N_1_05) +
    (player.majorTitles.length * AI_NUM.N_1_45) +
    (getCachedMinorTitleCount(state, meta, playerId) * AI_NUM.N_0_55) +
    (meta.players[playerId]?.stats?.throneCaptures || AI_NUM.N_0) * AI_NUM.N_1_1 -
    (threatenedLoss * AI_NUM.N_0_3)
  );
}

function getStandings(state, meta) {
  const cache = getFastCache(state, meta);
  if (cache?.standings) return cache.standings;
  const standings = state.players
    .map(player => ({
      playerId: player.id,
      score: getVictoryPositionScore(state, meta, player.id),
      landIncome: getPlayerIncomePotential(state, player.id, meta),
      threatenedValue: getPlayerThreatenedLandValue(state, player.id, meta),
    }))
    .sort((left, right) => right.score - left.score);
  if (cache) cache.standings = standings;
  return standings;
}

function getStandingSnapshot(state, meta, playerId) {
  const cache = getFastCache(state, meta);
  if (cache?.standingSnapshots.has(playerId)) return cache.standingSnapshots.get(playerId);
  const standings = getStandings(state, meta);
  const rankIndex = Math.max(AI_NUM.N_0, standings.findIndex(entry => entry.playerId === playerId));
  const leader = standings[AI_NUM.N_0] || { playerId, score: AI_NUM.N_0 };
  const current = standings[rankIndex] || { playerId, score: AI_NUM.N_0 };
  const nextAhead = rankIndex > AI_NUM.N_0 ? standings[rankIndex - AI_NUM.N_1] : current;
  const nextBehind = standings[rankIndex + AI_NUM.N_1] || current;
  return {
    rank: rankIndex + AI_NUM.N_1,
    leaderId: leader.playerId,
    leaderScore: leader.score,
    myScore: current.score,
    gapToLeader: leader.score - current.score,
    gapToNextAhead: nextAhead.score - current.score,
    leadOverNextBehind: current.score - nextBehind.score,
  };
}

function getCompetenceScore(state, meta, playerId) {
  const profile = getPersonalityProfile(meta, playerId);
  return (
    profile.weights.frontier * AI_NUM.N_0_55 +
    profile.weights.loyalty * AI_NUM.N_0_15 +
    profile.weights.mercenary * AI_NUM.N_0_15 +
    getPlayerExposure(state, playerId, meta) * AI_NUM.N_0_2
  );
}

function getAmbitionScore(meta, playerId) {
  const profile = getPersonalityProfile(meta, playerId);
  return (profile.weights.throne * AI_NUM.N_0_6) + (profile.weights.capital * AI_NUM.N_0_25) + (profile.weights.mercenary * AI_NUM.N_0_15);
}

function getAITemperament(meta, playerId) {
  return {
    independence: meta.players[playerId]?.tactics?.independence ?? AI_NUM.N_1,
    frontierAlarm: meta.players[playerId]?.tactics?.frontierAlarm ?? AI_NUM.N_1,
    churchReserve: meta.players[playerId]?.tactics?.churchReserve ?? AI_NUM.N_1,
    incumbencyGrip: meta.players[playerId]?.tactics?.incumbencyGrip ?? AI_NUM.N_1,
  };
}

function ensurePlayerLink(meta, playerId, targetId, key, fallback = AI_NUM.N_0) {
  if (playerId == null || targetId == null || playerId === targetId) return fallback;
  if (meta.players[playerId][key][targetId] == null) {
    meta.players[playerId][key][targetId] = fallback;
  }
  return meta.players[playerId][key][targetId];
}

function getRelationValue(meta, fromId, toId) {
  if (fromId === toId) return AI_NUM.N_0;
  const trust = ensurePlayerLink(meta, fromId, toId, 'trust', AI_NUM.N_0);
  const grievance = ensurePlayerLink(meta, fromId, toId, 'grievance', AI_NUM.N_0);
  return trust - grievance;
}

function getAffinityScore(meta, fromId, toId) {
  if (fromId === toId) {
    return AI_NUM.N_1 + (getPersonalityProfile(meta, fromId).weights.selfAppointment * AI_NUM.N_0_25);
  }
  const relation = getRelationValue(meta, fromId, toId);
  // Tier 2: affinitySlope is now an evolvable meta-param (was 0.32)
  const slope = getMetaForPlayer(meta, fromId, 'affinitySlope');
  return clamp(AI_NUM.N_1 + (relation * slope), AI_NUM.N_0_15, AI_NUM.N_2_7);
}

function adjustRelation(meta, fromId, toId, trustDelta = AI_NUM.N_0, grievanceDelta = AI_NUM.N_0) {
  if (fromId == null || toId == null || fromId === toId) return;
  ensurePlayerLink(meta, fromId, toId, 'trust', AI_NUM.N_0);
  ensurePlayerLink(meta, fromId, toId, 'grievance', AI_NUM.N_0);
  meta.players[fromId].trust[toId] = clamp(meta.players[fromId].trust[toId] + trustDelta, -AI_NUM.N_3, AI_NUM.N_8);
  meta.players[fromId].grievance[toId] = clamp(meta.players[fromId].grievance[toId] + grievanceDelta, AI_NUM.N_0, AI_NUM.N_8);
}

function getObligation(meta, debtorId, creditorId) {
  if (debtorId == null || creditorId == null || debtorId === creditorId) return AI_NUM.N_0;
  return ensurePlayerLink(meta, debtorId, creditorId, 'obligations', AI_NUM.N_0);
}

function addObligation(meta, debtorId, creditorId, amount) {
  if (debtorId == null || creditorId == null || debtorId === creditorId || amount <= AI_NUM.N_0) return;
  ensurePlayerLink(meta, debtorId, creditorId, 'obligations', AI_NUM.N_0);
  meta.players[debtorId].obligations[creditorId] = clamp(meta.players[debtorId].obligations[creditorId] + amount, AI_NUM.N_0, AI_NUM.N_10);
}

function reduceObligation(meta, debtorId, creditorId, amount) {
  if (debtorId == null || creditorId == null || debtorId === creditorId || amount <= AI_NUM.N_0) return;
  ensurePlayerLink(meta, debtorId, creditorId, 'obligations', AI_NUM.N_0);
  meta.players[debtorId].obligations[creditorId] = clamp(meta.players[debtorId].obligations[creditorId] - amount, AI_NUM.N_0, AI_NUM.N_10);
}

function logDecision(meta, message) {
  meta.decisionLog.push(message);
}

function logPublic(meta, message) {
  if (!message || !meta?.sampled) return;
  meta.publicLog.push(message);
  if (meta.publicLog.length > PUBLIC_LOG_LIMIT) {
    meta.publicLog.splice(AI_NUM.N_0, meta.publicLog.length - PUBLIC_LOG_LIMIT);
  }
}

function factor(label, note, impact = 'for', value = null) {
  const entry = { label, note, impact };
  if (value != null) {
    entry.value = typeof value === 'number' ? roundTo(value, AI_NUM.N_2) : value;
  }
  return entry;
}

function attachHistoryDecision(state, historyId, decision) {
  if (!historyId || !decision) return;
  updateHistoryEvent(state, historyId, {
    actorAi: true,
    decision,
  });
}

function applyDecisionToResult(state, result, decision) {
  attachHistoryDecision(state, result?.historyId || null, decision);
}

function describeActor(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  const profile = getPersonalityProfile(meta, playerId);
  return `${player ? formatPlayerLabel(player) : `Player ${playerId + AI_NUM.N_1}`} (${profile.shortName})`;
}

function publicActor(state, playerId) {
  const player = getPlayer(state, playerId);
  return player ? formatPlayerLabel(player) : `Player ${playerId + AI_NUM.N_1}`;
}

function courtTitleName(titleType) {
  return {
    EMPRESS: 'Empress',
    CHIEF_EUNUCHS: 'Chief of Eunuchs',
  }[titleType] || titleType;
}

function getOfficeList(state, playerId, options = {}) {
  const offices = [];
  if (playerId === state.basileusId) {
    offices.push({ key: 'BASILEUS', label: 'Basileus', region: 'cpl' });
  }

  const player = getPlayer(state, playerId);
  for (const titleKey of player.majorTitles) {
    if (titleKey === 'PATRIARCH') {
      offices.push({
        key: 'PATRIARCH',
        label: MAJOR_TITLES.PATRIARCH?.name || 'Patriarch',
        region: 'cpl',
        capitalLocked: true,
      });
      continue;
    }
    offices.push({
      key: titleKey,
      label: MAJOR_TITLES[titleKey]?.name || titleKey,
      region: MAJOR_TITLES[titleKey]?.region || null,
    });
  }

  if (state.empress === playerId) {
    offices.push({ key: 'EMPRESS', label: 'Empress', region: 'cpl', capitalLocked: true });
  }
  if (state.chiefEunuchs === playerId) {
    offices.push({ key: 'CHIEF_EUNUCHS', label: 'Chief of Eunuchs', region: 'cpl', capitalLocked: true });
  }

  for (const theme of Object.values(state.themes)) {
    if (!theme.occupied && theme.strategos === playerId) {
      offices.push({
        key: `STRAT_${theme.id}`,
        label: `Strategos of ${theme.name}`,
        region: theme.region,
        themeId: theme.id,
      });
    }
  }

  if (options.includeMercenaryCompany && getPlayerMercenaryTotal(state, playerId) > AI_NUM.N_0) {
    offices.push({
      key: MERCENARY_COMPANY_KEY,
      label: 'Mercenary Company',
      region: null,
    });
  }

  return offices;
}

const CAPITAL_LOCKED_OFFICE_KEYS = new Set(['EMPRESS', 'PATRIARCH', 'CHIEF_EUNUCHS']);

function buildMinorAppointmentDecision(state, meta, actorId, option) {
  const context = ensureRoundContext(state, meta, 'court');
  const theme = option.themeId ? state.themes[option.themeId] : null;
  const actorPact = context.pactByPlayer[actorId];
  const appointeePact = context.pactByPlayer[option.appointeeId];
  const sharedCandidate = actorPact && appointeePact && actorPact.candidateId === appointeePact.candidateId;
  const relation = getAffinityScore(meta, actorId, option.appointeeId);
  const debtRepayment = getObligation(meta, actorId, option.appointeeId);
  const ambitionRisk = getAmbitionScore(meta, option.appointeeId);

  let strategicNote = `${publicActor(state, option.appointeeId)} was a useful patronage target.`;
  if (option.type === 'EMPRESS' || option.type === 'CHIEF_EUNUCHS') {
    strategicNote = `${courtTitleName(option.type)} is a strong court reward with direct palace influence.`;
  } else if (option.type === 'STRATEGOS' && theme) {
    strategicNote = `${theme.name} matters for frontier control and levy access.`;
  } else if (option.type === 'BISHOP' && theme) {
    strategicNote = `${theme.name} creates a valuable bishopric with income and church leverage.`;
  }

  return {
    title: 'AI reasoning',
    factors: [
      factor('Strategic value', strategicNote, 'for', option.score),
      factor('Relationship', `${publicActor(state, actorId)} rates ${publicActor(state, option.appointeeId)} at ${roundTo(relation, AI_NUM.N_2)} affinity.`, relation >= AI_NUM.N_1 ? 'for' : 'neutral'),
      factor('Debt and repayment', debtRepayment > AI_NUM.N_0
        ? `This helps repay obligations owed to ${publicActor(state, option.appointeeId)}.`
        : `${publicActor(state, actorId)} was trying to create future loyalty with a new favor.`, debtRepayment > AI_NUM.N_0 ? 'for' : 'neutral', debtRepayment),
      factor('Coalition fit', sharedCandidate
        ? `Both dynasties were leaning toward the same throne plan this round.`
        : `This appointment was made despite a weaker coalition link.`, sharedCandidate ? 'for' : 'neutral'),
      factor('Ambition risk', `${publicActor(state, option.appointeeId)} carries ${roundTo(ambitionRisk, AI_NUM.N_2)} ambition pressure.`, ambitionRisk > AI_NUM.N_1_4 ? 'against' : 'neutral', ambitionRisk),
    ],
  };
}

function buildLandPurchaseDecision(state, meta, playerId, action) {
  const theme = action.theme;
  const remainingRounds = getRemainingRounds(state);
  const standing = getStandingSnapshot(state, meta, playerId);
  const ownedThemeCount = getPlayerThemes(state, playerId).length;
  const leaderThemeCount = getPlayerThemes(state, standing.leaderId).length;
  const routeRisk = getThemeRouteRisk(state, theme.id);
  const empireDanger = getEmpireDanger(state, meta);
  const auction = getLandAuction(state, theme.id);
  const bid = getMinimumLandBid(state, theme.id);
  const dueNow = auction?.bidderId === playerId ? Math.max(AI_NUM.N_0, bid - auction.amount) : bid;
  const ownerIncome = getNormalOwnerIncome(theme);
  const goldAfter = getPlayer(state, playerId).gold - dueNow;

  return {
    title: 'AI reasoning',
    factors: [
      factor('Income horizon', `${theme.name} is P${theme.P} T${theme.T} L${theme.L}, yielding ${ownerIncome}g to the owner each round under normal taxation.`, 'for', action.score),
      factor('Auction price', auction
        ? `The current high bid was ${auction.amount}g, so the legal raise was ${bid}g with ${dueNow}g due now.`
        : `The opening bid was ${bid}g.`, dueNow > getThemeLandPrice(theme) ? 'against' : 'neutral', bid),
      factor('Catch-up pressure', leaderThemeCount > ownedThemeCount
        ? `${publicActor(state, playerId)} was behind the land leader and needed to close the gap.`
        : `${publicActor(state, playerId)} still valued land growth even without trailing in estates.`, leaderThemeCount > ownedThemeCount ? 'for' : 'neutral'),
      factor('Reserve after bid', `${goldAfter}g would remain after the escrow payment.`, goldAfter < AI_NUM.N_2 ? 'against' : 'neutral', goldAfter),
      factor('Route risk', `${theme.name} sits at route risk ${roundTo(routeRisk, AI_NUM.N_2)} while empire danger is ${roundTo(empireDanger, AI_NUM.N_2)}.`, routeRisk > AI_NUM.N_0_55 && empireDanger > AI_NUM.N_1 ? 'against' : 'neutral', routeRisk),
      factor('Estate scarcity', ownedThemeCount === AI_NUM.N_0
        ? 'Owning no land made the first purchase especially urgent.'
        : `${publicActor(state, playerId)} already held ${ownedThemeCount} theme${ownedThemeCount === AI_NUM.N_1 ? '' : 's'}.`, ownedThemeCount === AI_NUM.N_0 ? 'for' : 'neutral'),
    ],
  };
}

function buildChurchGiftDecision(state, meta, playerId, action) {
  const theme = action.theme;
  const remainingRounds = getRemainingRounds(state);
  const churchWeight = getPersonalityProfile(meta, playerId).weights.church;
  const churchReserve = getAITemperament(meta, playerId).churchReserve;
  const routeRisk = getThemeRouteRisk(state, theme.id);

  return {
    title: 'AI reasoning',
    factors: [
      factor('Church leverage', `${theme.name} created a church-aligned holding worth ${roundTo(churchWeight, AI_NUM.N_2)} on this profile.`, 'for', action.score),
      factor('Bishop control', 'Gifting the theme guarantees a bishopric tied to the donor dynasty unless revoked later.', 'for'),
      factor('Opportunity cost', `${remainingRounds} round${remainingRounds === AI_NUM.N_1 ? '' : 's'} of private income were being sacrificed.`, remainingRounds >= AI_NUM.N_4 ? 'against' : 'neutral'),
      factor('Estate restraint', `This AI carried a land-preservation pressure of ${roundTo(churchReserve, AI_NUM.N_2)} before agreeing to donate.`, churchReserve > AI_NUM.N_1_2 ? 'against' : 'neutral', churchReserve),
      factor('Exposure', `${theme.name} faced route risk ${roundTo(routeRisk, AI_NUM.N_2)}.`, routeRisk > AI_NUM.N_0_5 ? 'for' : 'neutral', routeRisk),
    ],
  };
}

function buildRecruitmentDecision(state, meta, playerId, action, candidateId, commitment) {
  const capitalPotential = scoreOfficeDestination(state, meta, playerId, action.office, AI_NUM.N_1, 'capital', candidateId, commitment);
  const frontierPotential = scoreOfficeDestination(state, meta, playerId, action.office, AI_NUM.N_1, 'frontier', candidateId, commitment);
  const standing = getStandingSnapshot(state, meta, playerId);
  const player = getPlayer(state, playerId);
  const leaning = capitalPotential > frontierPotential ? 'capital' : 'frontier';

  return {
    title: 'AI reasoning',
    factors: [
      factor('Best office', `${action.office.label} had the best marginal troop value this round.`, 'for', action.score),
      factor('Strategic leaning', `One extra troop was more valuable on the ${leaning} plan (${roundTo(Math.max(capitalPotential, frontierPotential), AI_NUM.N_2)}).`, 'for'),
      factor('Standings pressure', standing.rank > AI_NUM.N_1
        ? `${publicActor(state, playerId)} trailed the leader by ${roundTo(standing.gapToLeader, AI_NUM.N_2)} score and wanted more leverage.`
        : `${publicActor(state, playerId)} still valued military flexibility from the lead.`, standing.rank > AI_NUM.N_1 ? 'for' : 'neutral'),
      factor('Gold position', `${player.gold}g remained before maintenance.`, player.gold <= AI_NUM.N_1 ? 'against' : 'neutral', player.gold),
    ],
  };
}

function buildDismissalDecision(state, meta, playerId, action) {
  const player = getPlayer(state, playerId);
  const standing = getStandingSnapshot(state, meta, playerId);

  return {
    title: 'AI reasoning',
    factors: [
      factor('Upkeep pressure', `${publicActor(state, playerId)} was carrying ${action.maintenanceBefore} upkeep against ${player.gold}g on hand.`, 'for', action.score),
      factor('Office priority', `${action.office.label} had the weakest marginal military value among available armies.`, 'for'),
      factor('Survival reserve', `The dismissal kept a safer treasury buffer while ${standing.rank === AI_NUM.N_1 ? 'protecting the lead' : 'avoiding a forced collapse later'}.`, 'for'),
      factor('Scale', `${action.count} troop${action.count === AI_NUM.N_1 ? '' : 's'} were dismissed from this office.`, 'neutral', action.count),
    ],
  };
}

function buildRevocationDecision(state, meta, actorId, best) {
  const threat = getThreatLevel(state, meta);
  const targetId = best.targetPlayerId ?? best.revokedPlayerId ?? null;
  const targetStrength = targetId == null ? AI_NUM.N_0 : getPlayerStrength(state, meta, targetId);
  const actorStrength = getPlayerStrength(state, meta, actorId);
  const obligation = targetId == null ? AI_NUM.N_0 : getObligation(meta, actorId, targetId);

  return {
    title: 'AI reasoning',
    factors: [
      factor('Target pressure', targetId == null
        ? 'This revocation hit a useful imperial lever rather than a specific dynasty.'
        : `${publicActor(state, targetId)} looked dangerous enough to justify a crackdown.`, 'for', targetStrength - actorStrength),
      factor('Loyalty debt', obligation > AI_NUM.N_0
        ? `${publicActor(state, actorId)} overrode an existing obligation because the revocation still scored higher.`
        : 'There was little reason to spare the target out of loyalty.', obligation > AI_NUM.N_0 ? 'against' : 'for', obligation),
      factor('Imperial danger', `Current invasion pressure sat at ${roundTo(threat, AI_NUM.N_2)}.`, threat > AI_NUM.N_0_85 ? 'against' : 'neutral', threat),
      factor('Replacement value', best.newHolderId != null
        ? `${publicActor(state, best.newHolderId)} looked like a safer replacement.`
        : `${publicActor(state, actorId)} preferred removing the asset outright instead of reassigning it.`, best.newHolderId != null ? 'for' : 'neutral'),
    ],
  };
}

function buildOrdersDecision(state, meta, playerId, candidateId, pact, officePlans, mercenaries, capitalTroops, frontierTroops, context) {
  const standing = getStandingSnapshot(state, meta, playerId);
  const empireDanger = getEmpireDanger(state, meta);
  const ownStake = getPlayerThreatenedLandValue(state, playerId, meta);
  const rivalStake = getRivalThreatenedLandValue(state, playerId, meta);
  const supportSignal = context.supportSignal[candidateId] || AI_NUM.N_0;
  const throneNote = pact?.kind === 'self'
    ? `${publicActor(state, playerId)} judged its own claim viable.`
    : pact?.kind === 'defense'
      ? `Empire danger and coalition math favored defending ${publicActor(state, candidateId)}.`
      : `${publicActor(state, playerId)} joined a challenger coalition around ${publicActor(state, candidateId)}.`;
  const keyDeployments = officePlans
    .filter(plan => plan.troopCount > AI_NUM.N_0)
    .sort((left, right) => Math.abs((right.capitalScore || AI_NUM.N_0) - (right.frontierScore || AI_NUM.N_0)) - Math.abs((left.capitalScore || AI_NUM.N_0) - (left.frontierScore || AI_NUM.N_0)))
    .slice(AI_NUM.N_0, AI_NUM.N_2)
    .map(plan => `${plan.office.label} -> ${plan.destination}`)
    .join(', ');
  const mercCount = sum(mercenaries.map(entry => entry.count));
  const mercCost = getMercenaryHireCost(AI_NUM.N_0, mercCount);

  return {
    title: 'AI reasoning',
    factors: [
      factor('Throne plan', throneNote, 'for', supportSignal),
      factor('Standings pressure', standing.rank > AI_NUM.N_1
        ? `${publicActor(state, playerId)} was chasing a leader gap of ${roundTo(standing.gapToLeader, AI_NUM.N_2)}.`
        : `${publicActor(state, playerId)} was already leading and leaned more toward preservation.`, standing.rank > AI_NUM.N_1 ? 'for' : 'neutral'),
      factor('Frontier stake', ownStake >= rivalStake
        ? `Its own threatened estates made frontier defense expensive to ignore.`
        : `More threatened land belonged to rivals, so frontier caution was weaker.`, ownStake >= rivalStake ? 'for' : 'neutral'),
      factor('Troop split', `${capitalTroops} capital troop${capitalTroops === AI_NUM.N_1 ? '' : 's'} and ${frontierTroops} frontier troop${frontierTroops === AI_NUM.N_1 ? '' : 's'}; key calls: ${keyDeployments || 'no major offices'}.`, 'neutral'),
      factor('Mercenary spend', mercCount > AI_NUM.N_0
        ? `Spent ${mercCost}g on mercenaries where marginal troop value was highest.`
        : 'Held gold back because the court policy did not select a mercenary hire.', mercCount > AI_NUM.N_0 ? 'for' : 'neutral', mercCount),
      factor('Empire danger', `Overall empire danger was ${roundTo(empireDanger, AI_NUM.N_2)}.`, empireDanger > AI_NUM.N_1_1 ? 'for' : 'neutral', empireDanger),
    ],
  };
}

function buildMercenaryDecision(action, cost) {
  const count = Math.max(AI_NUM.N_0, Number(action?.count) || Number(action?.descriptor?.payload?.count) || AI_NUM.N_0);
  return {
    title: 'AI reasoning',
    factors: [
      factor('Mercenary count', `${count} mercenary troop${count === AI_NUM.N_1 ? '' : 's'} became available for the next orders phase.`, 'for', count),
      factor('Policy score', `The unified court policy selected this hire from legal count options.`, 'for', action?.score ?? action?.policyScore ?? AI_NUM.N_0),
      factor('Gold spend', `${cost}g was committed to the mercenary company.`, 'neutral', cost),
    ],
  };
}

function buildTitleAssignmentDecision(state, meta, newBasileusId, plan) {
  const rewardedSupporters = Object.entries(plan.best.assignment)
    .filter(([, holderId]) => state.allOrders?.[holderId]?.candidate === newBasileusId)
    .map(([, holderId]) => publicActor(state, holderId));

  return {
    title: 'AI reasoning',
    factors: [
      factor('Loyalty', 'Major offices were pushed toward dynasties the new Basileus trusted or owed.', 'for'),
      factor('Competence', 'Military and church offices were matched against each holder’s practical fit.', 'for'),
      factor('Support repayment', rewardedSupporters.length
        ? `Supporters rewarded here: ${rewardedSupporters.join(', ')}.`
        : 'No direct throne supporters needed repayment in this distribution.', rewardedSupporters.length ? 'for' : 'neutral'),
      factor('Continuity', 'Keeping some offices with current holders reduced immediate disruption when it scored well.', 'neutral'),
    ],
  };
}

export function samplePersonalityIds(rng, playerCount, allowedPersonalityIds, populationPresetId, humanPlayerIds = []) {
  const humanIds = normalizeHumanPlayerIds(playerCount, humanPlayerIds);
  const preset = POPULATION_PRESETS[populationPresetId] || POPULATION_PRESETS.balanced;
  const pool = allowedPersonalityIds
    .filter(personalityId => PERSONALITIES[personalityId])
    .map(personalityId => ({
      id: personalityId,
      weight: preset.weights[personalityId] || AI_NUM.N_0_01,
    }));

  const totalWeight = sum(pool.map(entry => entry.weight));
  const pickOne = () => {
    if (!pool.length || totalWeight <= AI_NUM.N_0) return null;
    let cursor = rng() * totalWeight;
    for (const entry of pool) {
      cursor -= entry.weight;
      if (cursor <= AI_NUM.N_0) return entry.id;
    }
    return pool[pool.length - AI_NUM.N_1]?.id || null;
  };

  const personalities = [];
  for (let playerId = AI_NUM.N_0; playerId < playerCount; playerId++) {
    personalities[playerId] = humanIds.has(playerId) ? null : pickOne();
  }
  return personalities;
}

export function invalidateRoundContext(meta) {
  if (!meta) return;
  meta.roundContext = null;
  meta.fastCache = null;
  invalidateSystemicAIContext(meta);
}

export function isAIPlayer(meta, playerId) {
  return !meta.humanPlayerIds.has(playerId);
}

function buildProfileTactics(profile, rng) {
  const variation = () => AI_NUM.N_0_85 + (rng() * AI_NUM.N_0_5);
  return {
    independence: clamp((AI_NUM.N_0_95 + (profile.weights.retaliation * AI_NUM.N_0_12) - (profile.weights.loyalty * AI_NUM.N_0_05)) * variation(), AI_NUM.N_0_72, AI_NUM.N_1_75),
    frontierAlarm: clamp((AI_NUM.N_0_9 + (profile.weights.frontier * AI_NUM.N_0_18) + (profile.weights.wealth * AI_NUM.N_0_05)) * variation(), AI_NUM.N_0_85, AI_NUM.N_2_15),
    churchReserve: clamp((AI_NUM.N_1 + (profile.weights.wealth * AI_NUM.N_0_12) + (profile.weights.land * AI_NUM.N_0_1) - (profile.weights.church * AI_NUM.N_0_12)) * variation(), AI_NUM.N_0_7, AI_NUM.N_2_2),
    incumbencyGrip: clamp((AI_NUM.N_0_95 + (profile.weights.throne * AI_NUM.N_0_16) + (profile.weights.loyalty * AI_NUM.N_0_08)) * variation(), AI_NUM.N_0_9, AI_NUM.N_2_1),
  };
}

export function createAIMeta(state, options = {}) {
  const humanPlayerIds = normalizeHumanPlayerIds(state.players.length, options.humanPlayerIds || []);
  const allowedPersonalities = (options.allowedPersonalityIds || Object.keys(PERSONALITIES))
    .filter(personalityId => PERSONALITIES[personalityId]);
  const populationPresetId = POPULATION_PRESETS[options.populationPresetId] ? options.populationPresetId : 'balanced';
  const sampledPersonalityIds = samplePersonalityIds(
    state.rng,
    state.players.length,
    allowedPersonalities,
    populationPresetId,
    [...humanPlayerIds]
  );
  const personalityIds = Array.isArray(options.personalityIds)
    ? sampledPersonalityIds.map((sampledId, index) => options.personalityIds[index] || sampledId)
    : sampledPersonalityIds;

  const players = {};
  for (const player of state.players) {
    const customProfile = humanPlayerIds.has(player.id) ? null : normalizeAiProfile(options.seatProfiles?.[player.id]);
    const personalityId = humanPlayerIds.has(player.id)
      ? null
      : (customProfile?.id || personalityIds[player.id] || allowedPersonalities[AI_NUM.N_0] || null);
    const profile = customProfile || (personalityId ? PERSONALITIES[personalityId] : null) || NEUTRAL_PROFILE;
    const tactics = customProfile?.tactics
      ? PROFILE_TACTIC_KEYS.reduce((accumulator, key) => {
        accumulator[key] = customProfile.tactics[key];
        return accumulator;
      }, {})
      : buildProfileTactics(profile, state.rng);
    players[player.id] = {
      personalityId,
      profile: customProfile,
      trust: {},
      grievance: {},
      obligations: {},
      tactics,
      // Tier 5: per-rival posterior over opponent type. Initialised lazily via
      // ensureOpponentModel() the first time the AI scores against a rival.
      opponentModels: {},
      courtBudget: {
        round: -AI_NUM.N_1,
        landPurchasesRemaining: AI_NUM.N_0,
        churchGiftsRemaining: AI_NUM.N_0,
        recruitOpportunitiesSeen: {},
      },
      stats: {
        landBuys: AI_NUM.N_0,
        themesGifted: AI_NUM.N_0,
        recruits: AI_NUM.N_0,
        recruitOpportunities: AI_NUM.N_0,
        revocations: AI_NUM.N_0,
        mercSpend: AI_NUM.N_0,
        mercsHired: AI_NUM.N_0,
        frontierTroops: AI_NUM.N_0,
        capitalTroops: AI_NUM.N_0,
        coupVotes: AI_NUM.N_0,
        supportIncumbentVotes: AI_NUM.N_0,
        supportSelfVotes: AI_NUM.N_0,
        throneCaptures: AI_NUM.N_0,
        defenderRewards: AI_NUM.N_0,
        defenderGoldChoices: AI_NUM.N_0,
        defenderRestoreChoices: AI_NUM.N_0,
        defenderRewardGold: AI_NUM.N_0,
        titleShuffles: AI_NUM.N_0,
        supporterTitleRewards: AI_NUM.N_0,
        rivalOfficeDenials: AI_NUM.N_0,
        dealsProposed: AI_NUM.N_0,
        dealsAccepted: AI_NUM.N_0,
        dealsCountered: AI_NUM.N_0,
        dealsRefused: AI_NUM.N_0,
        dealUtility: AI_NUM.N_0,
        badAcceptedDeals: AI_NUM.N_0,
        coordinatedClaimantDeals: AI_NUM.N_0,
        frontierCoordinationDeals: AI_NUM.N_0,
        systemicDecisionCount: AI_NUM.N_0,
        projectedUtilityTotal: AI_NUM.N_0,
        projectedRiskTotal: AI_NUM.N_0,
        projectedFlexibilityTotal: AI_NUM.N_0,
        acceptedDealClauseKinds: {},
        proposedDealIntents: {},
        acceptedDealIntents: {},
      },
    };
  }

  for (const sourcePlayer of state.players) {
    for (const targetPlayer of state.players) {
      if (sourcePlayer.id === targetPlayer.id) continue;
      players[sourcePlayer.id].trust[targetPlayer.id] = AI_NUM.N_0;
      players[sourcePlayer.id].grievance[targetPlayer.id] = AI_NUM.N_0;
      players[sourcePlayer.id].obligations[targetPlayer.id] = AI_NUM.N_0;
    }
  }

  const profileBasisMap = new Map([[NEUTRAL_PROFILE.id, NEUTRAL_PROFILE]]);
  for (const player of state.players) {
    const playerMeta = players[player.id];
    const profile = playerMeta.profile || PERSONALITIES[playerMeta.personalityId] || NEUTRAL_PROFILE;
    const profileId = profile.id || playerMeta.personalityId || `player-${player.id}`;
    if (!profileBasisMap.has(profileId)) {
      profileBasisMap.set(profileId, { ...profile, id: profileId });
    }
  }

  return {
    sampled: Boolean(options.sampled),
    scenario: options.scenario || null,
    populationPresetId,
    humanPlayerIds,
    profileBasis: [...profileBasisMap.values()],
    publicLog: [],
    roundContext: null,
    decisionLog: createDecisionLog(Boolean(options.sampled)),
    players,
    totals: {
      landBuys: AI_NUM.N_0,
      gifts: AI_NUM.N_0,
      recruits: AI_NUM.N_0,
      recruitOpportunities: AI_NUM.N_0,
      revocations: AI_NUM.N_0,
      defenderRewards: AI_NUM.N_0,
      defenderGoldChoices: AI_NUM.N_0,
      defenderRestoreChoices: AI_NUM.N_0,
      defenderRewardGold: AI_NUM.N_0,
      throneChanges: AI_NUM.N_0,
      titleShuffles: AI_NUM.N_0,
      supporterTitleRewards: AI_NUM.N_0,
      rivalOfficeDenials: AI_NUM.N_0,
      mercSpend: AI_NUM.N_0,
      dealsProposed: AI_NUM.N_0,
      dealsAccepted: AI_NUM.N_0,
      dealsCountered: AI_NUM.N_0,
      dealsRefused: AI_NUM.N_0,
      dealUtility: AI_NUM.N_0,
      badAcceptedDeals: AI_NUM.N_0,
      coordinatedClaimantDeals: AI_NUM.N_0,
      frontierCoordinationDeals: AI_NUM.N_0,
      systemicDecisionCount: AI_NUM.N_0,
      projectedUtilityTotal: AI_NUM.N_0,
      projectedRiskTotal: AI_NUM.N_0,
      projectedFlexibilityTotal: AI_NUM.N_0,
      acceptedDealClauseKinds: {},
      proposedDealIntents: {},
      acceptedDealIntents: {},
    },
    wars: [],
    roundSnapshots: [],
  };
}

function ensureCourtBudget(state, meta, playerId) {
  const profile = getPersonalityProfile(meta, playerId);
  const policy = getPolicyForPlayer(meta, playerId);
  const playerMeta = meta.players[playerId];
  if (!playerMeta.courtBudget) {
    playerMeta.courtBudget = {
      round: -AI_NUM.N_1,
      landPurchasesRemaining: AI_NUM.N_0,
      churchGiftsRemaining: AI_NUM.N_0,
      recruitOpportunitiesSeen: {},
    };
  }

  if (playerMeta.courtBudget.round !== state.round) {
    playerMeta.courtBudget.round = state.round;
    playerMeta.courtBudget.landPurchasesRemaining = Math.max(AI_NUM.N_0, Math.min(policy.maxActionRepeatsPerKind, Math.round(profile.weights.land + policy.maxActionRepeatsPerKind / AI_NUM.N_2)));
    playerMeta.courtBudget.churchGiftsRemaining = Math.max(AI_NUM.N_0, Math.min(policy.maxActionRepeatsPerKind, Math.round(AI_NUM.N_1 + (profile.weights.church - AI_NUM.N_1) * AI_NUM.N_0_5)));
    playerMeta.courtBudget.recruitOpportunitiesSeen = {};
  }

  return playerMeta.courtBudget;
}

function noteRecruitOpportunity(state, meta, playerId, officeKey) {
  const budget = ensureCourtBudget(state, meta, playerId);
  if (budget.recruitOpportunitiesSeen[officeKey]) return;
  budget.recruitOpportunitiesSeen[officeKey] = true;
  meta.players[playerId].stats.recruitOpportunities++;
  meta.totals.recruitOpportunities++;
}

function estimateCandidateRewardPotential(state, meta, candidateId, beneficiaryId) {
  const candidate = getPlayer(state, candidateId);
  const beneficiary = getPlayer(state, beneficiaryId);
  const candidateOwesBeneficiary = getObligation(meta, candidateId, beneficiaryId);
  const beneficiaryTitleNeed = clamp(AI_NUM.N_2_25 - candidate.majorTitles.length - (getMinorTitleCount(state, beneficiaryId) * AI_NUM.N_0_35), AI_NUM.N_0, AI_NUM.N_2_5);
  const beneficiaryInfluence = getPlayerInfluence(state, meta, beneficiaryId);

  let value = AI_NUM.N_0_35 + (candidateOwesBeneficiary * AI_NUM.N_0_8);
  if (candidateId === state.basileusId) {
    value += AI_NUM.N_0_95;
    if (!state.courtActions?.basileusAppointed) value += AI_NUM.N_0_55;
    const revocationsUsed = state.courtActions?.revocationsUsed?.[candidateId] || AI_NUM.N_0;
    if (revocationsUsed === AI_NUM.N_0) value += AI_NUM.N_0_2;
  } else {
    value += beneficiaryTitleNeed * AI_NUM.N_0_75;
    value += Math.max(AI_NUM.N_0, AI_NUM.N_1_6 - beneficiary.majorTitles.length) * AI_NUM.N_0_25;
  }
  value += beneficiaryInfluence * AI_NUM.N_0_06;
  return value;
}

function scoreCandidateBase(state, meta, playerId, candidateId) {
  const profile = getPersonalityProfile(meta, playerId);
  const temperament = getAITemperament(meta, playerId);
  const threat = getThreatLevel(state, meta);
  const empireDanger = getEmpireDanger(state, meta);
  const exposure = getPlayerExposure(state, playerId, meta);
  const threatenedValue = getPlayerThreatenedLandValue(state, playerId, meta);
  const playerStrength = getPlayerStrength(state, meta, playerId);
  const candidateStrength = getPlayerStrength(state, meta, candidateId);
  const relation = getAffinityScore(meta, playerId, candidateId);
  const obligationToCandidate = getObligation(meta, playerId, candidateId);
  const candidateOwesPlayer = getObligation(meta, candidateId, playerId);
  const grievanceAgainstBasileus = state.basileusId === playerId ? AI_NUM.N_0 : ensurePlayerLink(meta, playerId, state.basileusId, 'grievance', AI_NUM.N_0);
  const ambitionRisk = getAmbitionScore(meta, candidateId);
  const rewardPotential = estimateCandidateRewardPotential(state, meta, candidateId, playerId);
  const remainingRounds = getRemainingRounds(state);
  const myStanding = getStandingSnapshot(state, meta, playerId);
  const candidateStanding = getStandingSnapshot(state, meta, candidateId);
  const basileusStanding = getStandingSnapshot(state, meta, state.basileusId);
  const comebackPressure = Math.max(AI_NUM.N_0, myStanding.gapToLeader);
  const endgamePressure = remainingRounds <= AI_NUM.N_2 ? AI_NUM.N_1_15 : remainingRounds <= AI_NUM.N_4 ? AI_NUM.N_0_35 : AI_NUM.N_0;

  let score = relation * profile.weights.loyalty;
  score += obligationToCandidate * AI_NUM.N_1_05;
  score += candidateOwesPlayer * AI_NUM.N_0_85;
  score += (candidateStrength - playerStrength) * AI_NUM.N_0_05;
  score += rewardPotential * AI_NUM.N_0_58;

  // Tier 2: selfThroneBoost (was 1.85), incumbentGrip (was 2.35),
  // coupGrievanceFactor (was 1.28) are now evolvable meta-params.
  const selfThroneBoost = getMeta(profile, 'selfThroneBoost');
  const incumbentGrip = getMeta(profile, 'incumbentGrip');
  const coupGrievanceFactor = getMeta(profile, 'coupGrievanceFactor');

  if (candidateId === playerId) {
    score += profile.weights.throne * selfThroneBoost;
    score += getPlayerInfluence(state, meta, playerId) * AI_NUM.N_0_04;
    score += grievanceAgainstBasileus * AI_NUM.N_0_42;
    score += (comebackPressure * AI_NUM.N_0_12) + endgamePressure;
    score -= threat * AI_NUM.N_0_3;
    if (playerId === state.basileusId) {
      score += (incumbentGrip * temperament.incumbencyGrip) + (rewardPotential * AI_NUM.N_0_32);
      if (myStanding.rank === AI_NUM.N_1) score += AI_NUM.N_1_05 + (empireDanger * AI_NUM.N_0_35);
      if (empireDanger > AI_NUM.N_1_05) score += AI_NUM.N_0_85 + (exposure * AI_NUM.N_0_28);
    }
    if (myStanding.rank === AI_NUM.N_1) score -= AI_NUM.N_0_8 + (empireDanger * AI_NUM.N_0_25);
    if (threatenedValue > AI_NUM.N_0 && empireDanger > AI_NUM.N_1_15) score -= AI_NUM.N_0_45;
  } else if (candidateId === state.basileusId) {
    score += AI_NUM.N_0_95 + (empireDanger * ((profile.weights.frontier * AI_NUM.N_0_95) + (exposure * AI_NUM.N_0_65)));
    score += threatenedValue * AI_NUM.N_0_06;
    score -= grievanceAgainstBasileus * AI_NUM.N_0_82;
    if (basileusStanding.rank === AI_NUM.N_1 && myStanding.rank > AI_NUM.N_1) {
      score -= AI_NUM.N_1_25 + (comebackPressure * AI_NUM.N_0_08);
    }
    if (myStanding.rank === AI_NUM.N_1) score += AI_NUM.N_0_85;
    if (empireDanger > AI_NUM.N_1_05) score += threatenedValue * AI_NUM.N_0_03;
  } else {
    score += grievanceAgainstBasileus * coupGrievanceFactor;
    score += profile.weights.capital * AI_NUM.N_1_02;
    score += (comebackPressure * AI_NUM.N_0_09) + (endgamePressure * AI_NUM.N_0_55);
    score -= empireDanger * AI_NUM.N_0_3;
    if (candidateStanding.rank === AI_NUM.N_1) {
      score -= AI_NUM.N_1_55 + (Math.max(AI_NUM.N_0, candidateStanding.leadOverNextBehind) * AI_NUM.N_0_12);
    }
    if (basileusStanding.rank === AI_NUM.N_1) score += AI_NUM.N_0_95;
    if (candidateStanding.rank > myStanding.rank) score += AI_NUM.N_0_25;
    if (candidateStanding.rank < myStanding.rank) score -= AI_NUM.N_0_4;
  }

  score -= ambitionRisk * AI_NUM.N_0_34;
  return score;
}

function getCandidateMomentum(state, meta, candidateId) {
  const standing = getStandingSnapshot(state, meta, candidateId);
  const influence = getPlayerInfluence(state, meta, candidateId);
  const officeWeight = candidateId === state.basileusId ? AI_NUM.N_1_1 : AI_NUM.N_0_18;
  const rankPressure = Math.max(AI_NUM.N_0, AI_NUM.N_3 - standing.rank) * AI_NUM.N_0_22;
  return (influence * AI_NUM.N_0_28) + officeWeight + rankPressure;
}

function buildRoundContext(state, meta, stage = 'court') {
  const aiPlayerIds = state.players.filter(player => isAIPlayer(meta, player.id)).map(player => player.id);
  const candidateIds = state.players.map(player => player.id);
  const candidateBaseScores = {};
  const candidateChoice = {};
  const candidateMargins = {};

  for (const playerId of aiPlayerIds) {
    candidateBaseScores[playerId] = {};
    for (const candidateId of candidateIds) {
      candidateBaseScores[playerId][candidateId] = scoreCandidateBase(state, meta, playerId, candidateId);
    }
    const ranked = [...candidateIds]
      .map(candidateId => ({ candidateId, score: candidateBaseScores[playerId][candidateId] }))
      .sort((left, right) => right.score - left.score);
    candidateChoice[playerId] = ranked[AI_NUM.N_0]?.candidateId ?? playerId;
    candidateMargins[playerId] = (ranked[AI_NUM.N_0]?.score || AI_NUM.N_0) - (ranked[AI_NUM.N_1]?.score || AI_NUM.N_0);
  }

  for (let iteration = AI_NUM.N_0; iteration < AI_NUM.N_3; iteration++) {
    const supportSignal = Object.fromEntries(candidateIds.map(candidateId => [candidateId, AI_NUM.N_0]));
    for (const candidateId of candidateIds) {
      supportSignal[candidateId] += getCandidateMomentum(state, meta, candidateId);
    }
    for (const playerId of aiPlayerIds) {
      supportSignal[candidateChoice[playerId]] += getPlayerInfluence(state, meta, playerId);
    }

    const challengerFrontRunner = candidateIds
      .filter(candidateId => candidateId !== state.basileusId)
      .map(candidateId => ({ candidateId, signal: supportSignal[candidateId] }))
      .sort((left, right) => right.signal - left.signal)[AI_NUM.N_0] || { candidateId: state.basileusId, signal: AI_NUM.N_0 };
    const strongestChallengerSignal = Math.max(
      AI_NUM.N_0,
      ...candidateIds.filter(candidateId => candidateId !== state.basileusId).map(candidateId => supportSignal[candidateId])
    );

    for (const playerId of aiPlayerIds) {
      const profile = getPersonalityProfile(meta, playerId);
      const temperament = getAITemperament(meta, playerId);
      const exposure = getPlayerExposure(state, playerId, meta);
      const threat = getThreatLevel(state, meta);
      const bandwagonScale = clamp(AI_NUM.N_1_45 - (temperament.independence * AI_NUM.N_0_5), AI_NUM.N_0_3, AI_NUM.N_1_05);
      const selfResolve = AI_NUM.N_0_9 + (temperament.independence * AI_NUM.N_0_28);

      const ranked = candidateIds.map(candidateId => {
        let coordination = supportSignal[candidateId] * AI_NUM.N_0_1 * profile.weights.loyalty * bandwagonScale;
        if (candidateId === challengerFrontRunner.candidateId && candidateId !== state.basileusId) {
          coordination += (AI_NUM.N_0_35 + (challengerFrontRunner.signal * AI_NUM.N_0_045)) * bandwagonScale;
        }
        if (candidateId === state.basileusId && supportSignal[state.basileusId] >= challengerFrontRunner.signal) {
          coordination += (AI_NUM.N_0_45 + (supportSignal[state.basileusId] * AI_NUM.N_0_03)) * bandwagonScale;
        }
        if (candidateId === playerId && supportSignal[candidateId] < (challengerFrontRunner.signal * AI_NUM.N_0_55)) {
          coordination -= AI_NUM.N_0_55 / selfResolve;
        }
        if (candidateId !== playerId && candidateId !== state.basileusId && supportSignal[candidateId] > supportSignal[playerId]) {
          coordination += AI_NUM.N_0_24 * bandwagonScale;
        }
        const stabilityBoost = candidateId === state.basileusId
          ? Math.max(AI_NUM.N_0, supportSignal[state.basileusId] - strongestChallengerSignal) * AI_NUM.N_0_1 + threat * exposure * AI_NUM.N_0_45
          : Math.max(AI_NUM.N_0, supportSignal[candidateId] - supportSignal[state.basileusId]) * AI_NUM.N_0_16;
        const obligationBoost = getObligation(meta, playerId, candidateId) * AI_NUM.N_0_6;
        const repaymentHope = getObligation(meta, candidateId, playerId) * AI_NUM.N_0_45;
        const momentumBoost = getCandidateMomentum(state, meta, candidateId) * AI_NUM.N_0_07;
        const score = candidateBaseScores[playerId][candidateId] + coordination + stabilityBoost + obligationBoost + repaymentHope + momentumBoost;
        return { candidateId, score };
      }).sort((left, right) => right.score - left.score);

      candidateChoice[playerId] = ranked[AI_NUM.N_0]?.candidateId ?? playerId;
      candidateMargins[playerId] = (ranked[AI_NUM.N_0]?.score || AI_NUM.N_0) - (ranked[AI_NUM.N_1]?.score || AI_NUM.N_0);
    }
  }

  const supportersByCandidate = Object.fromEntries(candidateIds.map(candidateId => [candidateId, []]));
  const supportSignal = Object.fromEntries(candidateIds.map(candidateId => [candidateId, AI_NUM.N_0]));
  for (const playerId of aiPlayerIds) {
    supportersByCandidate[candidateChoice[playerId]].push(playerId);
    supportSignal[candidateChoice[playerId]] += getPlayerInfluence(state, meta, playerId);
  }

  const strongestChallenger = candidateIds
    .filter(candidateId => candidateId !== state.basileusId)
    .map(candidateId => ({ candidateId, signal: supportSignal[candidateId] }))
    .sort((left, right) => right.signal - left.signal)[AI_NUM.N_0] || { candidateId: state.basileusId, signal: AI_NUM.N_0 };

  const pactByPlayer = {};
  for (const playerId of aiPlayerIds) {
    const candidateId = candidateChoice[playerId];
    const supporters = supportersByCandidate[candidateId];
    const profile = getPersonalityProfile(meta, playerId);
    const temperament = getAITemperament(meta, playerId);
    const threat = getThreatLevel(state, meta);
    const empireDanger = getEmpireDanger(state, meta);
    const exposure = getPlayerExposure(state, playerId, meta);
    const ownStake = getPlayerThreatenedLandValue(state, playerId, meta);
    const rivalStake = getRivalThreatenedLandValue(state, playerId, meta);
    const standing = getStandingSnapshot(state, meta, playerId);
    const endgamePressure = getRemainingRounds(state) <= AI_NUM.N_2 ? AI_NUM.N_0_8 : AI_NUM.N_0;
    const candidateNeed = candidateId === state.basileusId
      ? Math.max(AI_NUM.N_0, strongestChallenger.signal - supportSignal[state.basileusId])
      : Math.max(AI_NUM.N_0, supportSignal[state.basileusId] - supportSignal[candidateId] + AI_NUM.N_1_5);
    const opportunismDiscount = empireDanger < AI_NUM.N_1_05 ? Math.max(AI_NUM.N_0, rivalStake - ownStake) * AI_NUM.N_0_12 : AI_NUM.N_0;

    pactByPlayer[playerId] = {
      candidateId,
      kind: candidateId === state.basileusId ? 'defense' : (candidateId === playerId ? 'self' : 'coalition'),
      sameCandidateAllies: supporters.filter(otherId => otherId !== playerId),
      commitment: clamp(candidateMargins[playerId] + profile.weights.loyalty * AI_NUM.N_0_25, AI_NUM.N_0_2, AI_NUM.N_4_5),
      capitalBias: Math.max(AI_NUM.N_0, (candidateNeed * AI_NUM.N_0_32) + (getObligation(meta, playerId, candidateId) * AI_NUM.N_0_32) + (Math.max(AI_NUM.N_0, standing.gapToLeader) * AI_NUM.N_0_04) + endgamePressure - (empireDanger * AI_NUM.N_0_18 * temperament.frontierAlarm)),
      frontierBias: Math.max(AI_NUM.N_0, ((empireDanger * (AI_NUM.N_0_95 + (profile.weights.frontier * AI_NUM.N_0_82))) + (ownStake * AI_NUM.N_0_12) + (exposure * AI_NUM.N_1_05) - opportunismDiscount + (threat * AI_NUM.N_0_42)) * temperament.frontierAlarm),
      rewardExpectation: estimateCandidateRewardPotential(state, meta, candidateId, playerId),
    };
  }

  return {
    round: state.round,
    stage,
    candidateBaseScores,
    candidateChoice,
    candidateMargins,
    supportersByCandidate,
    supportSignal,
    strongestChallengerId: strongestChallenger.candidateId,
    strongestChallengerSignal: strongestChallenger.signal,
    pactByPlayer,
  };
}

function buildFallbackRoundContext(state, meta, stage = 'court') {
  const aiPlayerIds = state.players.filter(player => isAIPlayer(meta, player.id)).map(player => player.id);
  const candidateIds = state.players.map(player => player.id);
  const candidateBaseScores = {};
  const candidateChoice = {};
  const candidateMargins = {};
  const supportersByCandidate = Object.fromEntries(candidateIds.map(candidateId => [candidateId, []]));
  const supportSignal = Object.fromEntries(candidateIds.map(candidateId => [candidateId, AI_NUM.N_0]));
  const pactByPlayer = {};

  for (const playerId of aiPlayerIds) {
    candidateBaseScores[playerId] = Object.fromEntries(candidateIds.map(candidateId => [candidateId, candidateId === state.basileusId ? AI_NUM.N_1 : AI_NUM.N_0]));
    candidateChoice[playerId] = state.basileusId;
    candidateMargins[playerId] = AI_NUM.N_0;
    supportersByCandidate[state.basileusId].push(playerId);
    supportSignal[state.basileusId] += AI_NUM.N_1;
    pactByPlayer[playerId] = {
      candidateId: state.basileusId,
      kind: playerId === state.basileusId ? 'self' : 'defense',
      sameCandidateAllies: aiPlayerIds.filter(otherId => otherId !== playerId),
      commitment: AI_NUM.N_0_2,
      capitalBias: AI_NUM.N_0,
      frontierBias: AI_NUM.N_0_6,
      rewardExpectation: AI_NUM.N_0,
    };
  }

  return {
    round: state.round,
    stage,
    candidateBaseScores,
    candidateChoice,
    candidateMargins,
    supportersByCandidate,
    supportSignal,
    strongestChallengerId: state.basileusId,
    strongestChallengerSignal: AI_NUM.N_0,
    pactByPlayer,
  };
}

function ensureRoundContext(state, meta, stage = 'court') {
  if (!meta.roundContext || meta.roundContext.round !== state.round || meta.roundContext.stage !== stage) {
    try {
      meta.roundContext = buildRoundContext(state, meta, stage);
    } catch (error) {
      meta.roundContext = buildFallbackRoundContext(state, meta, stage);
      logDecision(meta, `Round ${state.round} ${stage}: round-context fallback after error: ${error?.message || 'unknown error'}.`);
    }
  }
  return meta.roundContext;
}

function finalizeCourtAutomation(state, meta, aiOrder) {
  for (const playerId of aiOrder) {
    if (!state.courtActions.playerConfirmed.has(playerId)) {
      recordHistoryEvent(state, {
        category: 'court',
        type: 'court_confirmed',
        actorId: playerId,
        actorAi: true,
        summary: `${publicActor(state, playerId)} ends court business for the round.`,
      });
    }
    state.courtActions.playerConfirmed.add(playerId);
  }
}

function appointmentDescriptor(actorId, type, themeId, appointeeId, appointmentCost = AI_NUM.N_0, paymentType = 'troops') {
  return {
    kind: AI_ACTION_KINDS.APPOINTMENT,
    phase: AI_ACTION_PHASES.COURT,
    payload: { type, themeId: themeId || null, appointeeId },
    costs: paymentType === 'gold' ? { gold: appointmentCost } : { troops: appointmentCost },
    gains: { titles: AI_NUM.N_1 },
    beneficiaries: [appointeeId],
    targets: [],
    timing: 'immediate',
    reversibility: type === 'EMPRESS' || type === 'CHIEF_EUNUCHS' ? 'medium' : 'low',
  };
}

function revocationDescriptor(actorId, option, cost = AI_NUM.N_0, paymentType = 'troops') {
  return {
    kind: AI_ACTION_KINDS.REVOCATION,
    phase: AI_ACTION_PHASES.COURT,
    payload: {
      kind: option.kind,
      themeId: option.themeId || null,
      titleType: option.titleType || option.kind,
      targetPlayerId: option.targetPlayerId ?? null,
    },
    costs: paymentType === 'gold' ? { gold: cost } : { troops: cost },
    targets: option.targetPlayerId == null ? [] : [option.targetPlayerId],
    timing: 'immediate',
    reversibility: 'medium',
  };
}

function landPurchaseDescriptor(state, playerId, theme, cost) {
  return {
    kind: AI_ACTION_KINDS.LAND_PURCHASE,
    phase: AI_ACTION_PHASES.COURT,
    payload: { themeId: theme.id, theme },
    costs: { gold: cost },
    gains: { income: getThemeOwnerIncome(theme), score: getThemeStrategicValue(theme) * AI_NUM.N_0_08 },
    beneficiaries: [playerId],
    timing: 'future',
    reversibility: 'medium',
  };
}

function churchGiftDescriptor(playerId, theme) {
  return {
    kind: AI_ACTION_KINDS.CHURCH_GIFT,
    phase: AI_ACTION_PHASES.COURT,
    payload: { themeId: theme.id, theme },
    gains: { score: ((Number(theme.P) || AI_NUM.N_0) + (Number(theme.T) || AI_NUM.N_0) + (Number(theme.C) || AI_NUM.N_0)) * AI_NUM.N_0_2 },
    beneficiaries: [playerId],
    timing: 'future',
    reversibility: 'low',
  };
}

function troopManagementDescriptor(kind, officeKey, count = AI_NUM.N_1, extra = {}) {
  return {
    kind,
    phase: AI_ACTION_PHASES.COURT,
    payload: { officeKey, count, ...extra },
    gains: kind === AI_ACTION_KINDS.RECRUIT ? { troops: count } : {},
    costs: kind === AI_ACTION_KINDS.DISMISS ? { troops: count } : {},
    timing: kind === AI_ACTION_KINDS.RECRUIT ? 'future' : 'immediate',
    reversibility: 'high',
  };
}

function scoreMinorSlot(state, meta, actorId, type, theme, appointeeId) {
  const actorProfile = getPersonalityProfile(meta, actorId);
  const context = ensureRoundContext(state, meta, 'court');
  const actorPact = context.pactByPlayer[actorId];
  const appointeePact = context.pactByPlayer[appointeeId];
  const threat = getThreatLevel(state, meta);
  const remainingRounds = getRemainingRounds(state);
  const routeRisk = theme ? getThemeRouteRisk(state, theme.id) : AI_NUM.N_0;
  const appointeeAffinity = getAffinityScore(meta, actorId, appointeeId);
  const appointeeAmbition = getAmbitionScore(meta, appointeeId);
  const actorOwesAppointee = getObligation(meta, actorId, appointeeId);
  const appointeeOwesActor = getObligation(meta, appointeeId, actorId);
  const sharedCandidate = actorPact && appointeePact && actorPact.candidateId === appointeePact.candidateId;
  const supportLeverage = getPlayerInfluence(state, meta, appointeeId) * AI_NUM.N_0_16;
  const actor = getPlayer(state, actorId);
  const bishopGoldAppointment = type === 'BISHOP'
    && actorId !== state.basileusId
    && actor?.majorTitles?.includes('PATRIARCH');
  const appointmentCost = bishopGoldAppointment
    ? getPatriarchBishopAppointmentGoldCost(state, actorId, appointeeId)
    : getNextAppointmentCost(state, actorId, appointeeId);
  const appointmentCostPenalty = bishopGoldAppointment ? appointmentCost * AI_NUM.N_0_7 : appointmentCost * AI_NUM.N_1_15;
  const recipientPressure =
    (getCategoryThresholdPressure(state, meta, appointeeId, 'tax') * AI_NUM.N_0_45) +
    (getCategoryThresholdPressure(state, meta, appointeeId, 'church') * AI_NUM.N_0_35) +
    (getCategoryThresholdPressure(state, meta, appointeeId, 'gold') * AI_NUM.N_0_15);

  let slotValue = AI_NUM.N_1_5;
  if (type === 'EMPRESS' || type === 'CHIEF_EUNUCHS') {
    slotValue = AI_NUM.N_2_05 + (actorProfile.weights.throne * AI_NUM.N_0_7) + (threat * AI_NUM.N_0_75);
    const currentHolder = type === 'EMPRESS' ? state.empress : state.chiefEunuchs;
    if (currentHolder != null && currentHolder !== appointeeId) {
      slotValue += Math.max(AI_NUM.N_0, getPlayerStrength(state, meta, currentHolder) - getPlayerStrength(state, meta, actorId)) * AI_NUM.N_0_08;
    }
  } else if (type === 'STRATEGOS') {
    slotValue = AI_NUM.N_1_9 + theme.L + (theme.P * AI_NUM.N_0_25) + (actorProfile.weights.frontier * AI_NUM.N_0_6) + (threat * AI_NUM.N_1_15) - (routeRisk * AI_NUM.N_0_35);
    if (theme.owner === appointeeId) slotValue += AI_NUM.N_1_15;
    slotValue += getPlayerExposure(state, appointeeId) * AI_NUM.N_0_3;
  } else if (type === 'BISHOP') {
    slotValue = AI_NUM.N_1_8 + (theme.P * AI_NUM.N_0_95) + (actorProfile.weights.church * AI_NUM.N_0_9) - (routeRisk * AI_NUM.N_0_2) + (remainingRounds * AI_NUM.N_0_08);
    if (theme.owner === appointeeId || theme.bishop === appointeeId) slotValue += AI_NUM.N_0_6;
  }

  const sharedCoalitionBonus = sharedCandidate ? AI_NUM.N_0_9 : -AI_NUM.N_0_18;
  const debtRepayment = actorOwesAppointee * AI_NUM.N_1_25;
  const leverageGain = (supportLeverage * AI_NUM.N_0_6) + ((appointeePact?.capitalBias || AI_NUM.N_0) * AI_NUM.N_0_25);
  const patronageRetention = appointeeOwesActor * AI_NUM.N_0_22;
  const selfBias = appointeeId === actorId ? actorProfile.weights.selfAppointment * AI_NUM.N_0_85 : AI_NUM.N_0;
  const controlBias = actorProfile.weights.loyalty * appointeeAffinity;
  const riskPenalty = appointeeAmbition * AI_NUM.N_0_32;

  const baseScore = slotValue + sharedCoalitionBonus + debtRepayment + leverageGain + patronageRetention + selfBias + controlBias + recipientPressure - riskPenalty - appointmentCostPenalty;
  return applySystemicScore(
    state,
    meta,
    actorId,
    appointmentDescriptor(actorId, type, theme?.id || null, appointeeId, appointmentCost, bishopGoldAppointment ? 'gold' : 'troops'),
    baseScore,
    AI_ACTION_PHASES.COURT,
  );
}

function registerFavor(meta, actorId, recipientId, amount) {
  adjustRelation(meta, recipientId, actorId, AI_NUM.N_0_8, AI_NUM.N_0);
  adjustRelation(meta, actorId, recipientId, AI_NUM.N_0_22, AI_NUM.N_0);
  addObligation(meta, recipientId, actorId, amount);
  reduceObligation(meta, actorId, recipientId, amount * AI_NUM.N_0_4);
}

function rankBasileusAppointmentOptions(state, meta) {
  const actorId = state.basileusId;
  const themes = Object.values(state.themes).filter(theme => !theme.occupied && theme.id !== 'CPL');
  const selfLocked = hasSelfAppointmentLock(state, actorId);
  const options = [];

  for (const appointee of state.players) {
    if (selfLocked && appointee.id === actorId) continue;
    options.push({ type: 'EMPRESS', appointeeId: appointee.id });
    options.push({ type: 'CHIEF_EUNUCHS', appointeeId: appointee.id });
    for (const theme of themes) {
      if (theme.owner !== 'church' && theme.strategos == null) {
        options.push({ type: 'STRATEGOS', themeId: theme.id, appointeeId: appointee.id });
      }
      // Bishops can only be appointed in provinces with at least 1 church value.
      if (theme.bishop == null && (Number(theme.C) || AI_NUM.N_0) >= AI_NUM.N_1) {
        options.push({ type: 'BISHOP', themeId: theme.id, appointeeId: appointee.id });
      }
    }
  }

  return options
    .filter(option => canPayAppointmentCost(state, actorId, option.appointeeId).ok)
    .map(option => ({
      ...option,
      score: scoreMinorSlot(state, meta, actorId, option.type, option.themeId ? state.themes[option.themeId] : null, option.appointeeId),
    }))
    .sort((left, right) => right.score - left.score);
}

function executeBasileusAppointmentOption(state, meta, option) {
  const actorId = state.basileusId;
  if (!option) return false;
  let result = null;
  if (option.type === 'EMPRESS' || option.type === 'CHIEF_EUNUCHS') {
    result = appointCourtTitle(state, option.type, option.appointeeId);
  } else if (option.type === 'STRATEGOS') {
    result = appointStrategos(state, actorId, option.themeId, option.appointeeId);
  } else if (option.type === 'BISHOP') {
    result = appointBishop(state, actorId, option.themeId, option.appointeeId);
  }
  if (!result?.ok) return false;

  state.courtActions.basileusAppointed = true;
  invalidateRoundContext(meta);
  registerFavor(meta, actorId, option.appointeeId, option.type === 'EMPRESS' || option.type === 'CHIEF_EUNUCHS' ? AI_NUM.N_1_2 : AI_NUM.N_1);
  rememberSystemicDecision(state, meta, actorId, appointmentDescriptor(actorId, option.type, option.themeId || null, option.appointeeId), option.score || AI_NUM.N_0, AI_ACTION_PHASES.COURT);
  applyDecisionToResult(state, result, buildMinorAppointmentDecision(state, meta, actorId, option));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, actorId)} appoints ${describeActor(state, meta, option.appointeeId)} to ${option.type}${option.themeId ? ` in ${option.themeId}` : ''}.`);
  logPublic(meta, `${publicActor(state, actorId)} grants ${option.type}${option.themeId ? ` in ${option.themeId}` : ''} to ${publicActor(state, option.appointeeId)}.`);
  return true;
}

function executeRegionalStrategosAppointmentOption(state, meta, titleKey, option) {
  const actorId = state.players.find(player => player.majorTitles.includes(titleKey))?.id ?? null;
  if (actorId == null || !option) return false;
  const previousHolder = state.themes[option.themeId]?.strategos;
  const result = appointStrategos(state, actorId, option.themeId, option.appointeeId);
  if (!result?.ok) return false;

  state.courtActions[`${titleKey}_appointed`] = true;
  if (titleKey === 'DOM_EAST') state.courtActions.domesticEastAppointed = true;
  if (titleKey === 'DOM_WEST') state.courtActions.domesticWestAppointed = true;
  if (titleKey === 'ADMIRAL') state.courtActions.admiralAppointed = true;

  invalidateRoundContext(meta);
  registerFavor(meta, actorId, option.appointeeId, AI_NUM.N_0_95);
  rememberSystemicDecision(state, meta, actorId, appointmentDescriptor(actorId, 'STRATEGOS', option.themeId, option.appointeeId), option.score || AI_NUM.N_0, AI_ACTION_PHASES.COURT);
  if (previousHolder != null && previousHolder !== option.appointeeId) {
    adjustRelation(meta, previousHolder, actorId, AI_NUM.N_0, AI_NUM.N_0_55);
    reduceObligation(meta, actorId, previousHolder, AI_NUM.N_0_6);
  }
  applyDecisionToResult(state, result, buildMinorAppointmentDecision(state, meta, actorId, { ...option, type: 'STRATEGOS' }));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, actorId)} names ${describeActor(state, meta, option.appointeeId)} strategos of ${option.themeId}.`);
  logPublic(meta, `${publicActor(state, actorId)} names ${publicActor(state, option.appointeeId)} strategos of ${option.themeId}.`);
  return true;
}

function rankRegionalStrategosAppointmentOptions(state, meta, titleKey) {
  const actorId = state.players.find(player => player.majorTitles.includes(titleKey))?.id ?? null;
  if (actorId == null) return { actorId: null, ranked: [] };
  const region = MAJOR_TITLES[titleKey].region;
  const selfLocked = hasSelfAppointmentLock(state, actorId);
  const themes = Object.values(state.themes).filter(theme =>
    theme.region === region &&
    !theme.occupied &&
    theme.id !== 'CPL' &&
    theme.owner !== 'church'
  );
  const options = [];
  for (const theme of themes) {
    for (const appointee of state.players) {
      if (selfLocked && appointee.id === actorId) continue;
      options.push({ themeId: theme.id, appointeeId: appointee.id });
    }
  }

  const ranked = options
    .filter(option => canPayAppointmentCost(state, actorId, option.appointeeId).ok)
    .map(option => ({
      ...option,
      score: scoreMinorSlot(state, meta, actorId, 'STRATEGOS', state.themes[option.themeId], option.appointeeId),
    }))
    .sort((left, right) => right.score - left.score);
  return { actorId, ranked };
}

function rankPatriarchAppointmentOptions(state, meta) {
  const actorId = state.players.find(player => player.majorTitles.includes('PATRIARCH'))?.id ?? null;
  if (actorId == null) return { actorId: null, ranked: [] };

  const selfLocked = hasSelfAppointmentLock(state, actorId);
  // The Patriarch can only seat a bishop in a province with at least 1 church
  // value, and only if the seat is vacant.
  const themes = Object.values(state.themes).filter(theme =>
    !theme.occupied &&
    theme.id !== 'CPL' &&
    theme.bishop == null &&
    (Number(theme.C) || AI_NUM.N_0) >= AI_NUM.N_1
  );
  const options = [];
  for (const theme of themes) {
    for (const appointee of state.players) {
      if (selfLocked && appointee.id === actorId) continue;
      options.push({ themeId: theme.id, appointeeId: appointee.id });
    }
  }

  const ranked = options
    .filter(option => canPayPatriarchBishopAppointmentCost(state, actorId, option.appointeeId).ok)
    .map(option => ({
      ...option,
      score: scoreMinorSlot(state, meta, actorId, 'BISHOP', state.themes[option.themeId], option.appointeeId),
    }))
    .sort((left, right) => right.score - left.score);
  return { actorId, ranked };
}

function executePatriarchAppointmentOption(state, meta, option) {
  const actorId = state.players.find(player => player.majorTitles.includes('PATRIARCH'))?.id ?? null;
  if (actorId == null || !option) return false;
  const previousHolder = state.themes[option.themeId]?.bishop;
  const result = appointBishop(state, actorId, option.themeId, option.appointeeId);
  if (!result?.ok) return false;

  state.courtActions.patriarchAppointed = true;
  invalidateRoundContext(meta);
  registerFavor(meta, actorId, option.appointeeId, AI_NUM.N_1);
  rememberSystemicDecision(state, meta, actorId, appointmentDescriptor(actorId, 'BISHOP', option.themeId, option.appointeeId), option.score || AI_NUM.N_0, AI_ACTION_PHASES.COURT);
  if (previousHolder != null && previousHolder !== option.appointeeId) {
    adjustRelation(meta, previousHolder, actorId, AI_NUM.N_0, AI_NUM.N_0_45);
    reduceObligation(meta, actorId, previousHolder, AI_NUM.N_0_45);
  }
  applyDecisionToResult(state, result, buildMinorAppointmentDecision(state, meta, actorId, { ...option, type: 'BISHOP' }));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, actorId)} names ${describeActor(state, meta, option.appointeeId)} bishop of ${option.themeId}.`);
  logPublic(meta, `${publicActor(state, actorId)} names ${publicActor(state, option.appointeeId)} bishop of ${option.themeId}.`);
  return true;
}

function scoreLandPurchase(state, meta, playerId, theme) {
  const profile = getPersonalityProfile(meta, playerId);
  const remainingRounds = getRemainingRounds(state);
  const routeRisk = getThemeRouteRisk(state, theme.id);
  const exposure = getPlayerExposure(state, playerId, meta);
  const empireDanger = getEmpireDanger(state, meta);
  const standing = getStandingSnapshot(state, meta, playerId);
  const ownedThemeCount = getPlayerThemes(state, playerId).length;
  const leaderThemeCount = getPlayerThemes(state, standing.leaderId).length;
  const minimumBid = getMinimumLandBid(state, theme.id);
  const auction = getLandAuction(state, theme.id);
  const ownBid = auction?.bidderId === playerId ? auction.amount : AI_NUM.N_0;
  const dueNow = Math.max(AI_NUM.N_0, minimumBid - ownBid);
  const ownerIncome = getNormalOwnerIncome(theme);
  const player = getPlayer(state, playerId);
  const privateValue = (ownerIncome * (AI_NUM.N_1_8 + (remainingRounds * AI_NUM.N_0_56))) + (theme.L * AI_NUM.N_0_25) + (remainingRounds * profile.weights.wealth * AI_NUM.N_0_18);
  const landControl = profile.weights.land * AI_NUM.N_1_2;
  const cheapness = (AI_NUM.N_4 - theme.P) * AI_NUM.N_0_35;
  const scarcityBonus = ownedThemeCount === AI_NUM.N_0 ? AI_NUM.N_4_5 : Math.max(AI_NUM.N_0, AI_NUM.N_2 - ownedThemeCount) * AI_NUM.N_1_6;
  const catchUpBonus = Math.max(AI_NUM.N_0, leaderThemeCount - ownedThemeCount) * AI_NUM.N_0_55;
  const churchOptionality = profile.weights.church * theme.P * AI_NUM.N_0_08;
  const estatePressure = getCategoryThresholdPressure(state, meta, playerId, 'estate') * AI_NUM.N_1_15;
  const goldPressure = getCategoryThresholdPressure(state, meta, playerId, 'gold') * AI_NUM.N_0_35;
  const overbidPenalty = auction && auction.bidderId !== playerId ? (minimumBid - getThemeLandPrice(theme)) * AI_NUM.N_0_35 : AI_NUM.N_0;
  const reservePenalty = (player.gold - dueNow) < AI_NUM.N_2 ? AI_NUM.N_0_9 + (empireDanger * AI_NUM.N_0_25) : AI_NUM.N_0;
  const riskPenalty = routeRisk * (empireDanger < AI_NUM.N_1 ? AI_NUM.N_0_45 : AI_NUM.N_0_85);
  const selfProtection = exposure > AI_NUM.N_0 ? theme.L * AI_NUM.N_0_15 : AI_NUM.N_0;
  const zeroIncomeRelief = getPlayerIncomePotential(state, playerId, meta) === AI_NUM.N_0 ? AI_NUM.N_2_2 : AI_NUM.N_0;
  const baseScore = privateValue + landControl + cheapness + scarcityBonus + catchUpBonus + churchOptionality + selfProtection + zeroIncomeRelief + estatePressure - (dueNow * AI_NUM.N_0_7) - overbidPenalty - reservePenalty - riskPenalty - goldPressure - (profile.weights.frontier * AI_NUM.N_0_15);
  return applySystemicScore(
    state,
    meta,
    playerId,
    landPurchaseDescriptor(state, playerId, theme, dueNow),
    baseScore,
    AI_ACTION_PHASES.COURT,
  );
}

function scoreChurchGift(state, meta, playerId, theme) {
  const profile = getPersonalityProfile(meta, playerId);
  const temperament = getAITemperament(meta, playerId);
  const remainingRounds = getRemainingRounds(state);
  const empireDanger = getEmpireDanger(state, meta);
  const ownedThemeCount = getPlayerThemes(state, playerId).length;
  const threatenedValue = getPlayerThreatenedLandValue(state, playerId, meta);
  const ownerIncome = getThemeOwnerIncome(theme);
  const keepsValue =
    (remainingRounds * profile.weights.wealth * AI_NUM.N_0_95) +
    (ownerIncome * (AI_NUM.N_2_2 + (profile.weights.land * AI_NUM.N_0_55))) +
    (ownedThemeCount <= AI_NUM.N_1 ? AI_NUM.N_2_4 : ownedThemeCount <= AI_NUM.N_2 ? AI_NUM.N_1_15 : AI_NUM.N_0);
  // Gifting now sets the province's church value to P + T (all profit and tax
  // becomes church revenue). The bigger the combined yield, the larger the
  // permanent contribution to the church pool the donor (now a bishop) will share.
  const futureChurchPool = (Number(theme.P) || AI_NUM.N_0) + (Number(theme.T) || AI_NUM.N_0) + getThemeChurchValue(theme);
  const churchValue = (futureChurchPool * profile.weights.church * AI_NUM.N_0_95) + AI_NUM.N_0_45;
  const patriarchBonus = getPlayer(state, playerId).majorTitles.includes('PATRIARCH') ? AI_NUM.N_1_2 : AI_NUM.N_0;
  const bishopLockBonus = AI_NUM.N_0_35 + (profile.weights.church * AI_NUM.N_0_28);
  const routeRiskRelief = getThemeRouteRisk(state, theme.id) * (empireDanger < AI_NUM.N_1 ? AI_NUM.N_1_05 : AI_NUM.N_0_35);
  const reservePenalty = temperament.churchReserve * (AI_NUM.N_1_25 + (threatenedValue * AI_NUM.N_0_02));
  const churchPressure = getCategoryThresholdPressure(state, meta, playerId, 'church') * AI_NUM.N_1_35;
  const estatePressure = getCategoryThresholdPressure(state, meta, playerId, 'estate') * AI_NUM.N_0_9;
  const baseScore = churchValue + patriarchBonus + bishopLockBonus + routeRiskRelief + churchPressure - keepsValue - reservePenalty - estatePressure;
  return applySystemicScore(
    state,
    meta,
    playerId,
    churchGiftDescriptor(playerId, theme),
    baseScore,
    AI_ACTION_PHASES.COURT,
  );
}

function findBestRecruitmentAction(state, meta, playerId) {
  return buildRecruitmentActions(state, meta, playerId)[AI_NUM.N_0] || null;
}

function buildRecruitmentActions(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  const offices = getOfficeList(state, playerId);
  const profile = getPersonalityProfile(meta, playerId);
  const commitment = ensureRoundContext(state, meta, 'court').pactByPlayer[playerId];
  const standing = getStandingSnapshot(state, meta, playerId);
  const candidateId = commitment?.candidateId ?? state.basileusId;
  const actions = [];

  for (const office of offices) {
    noteRecruitOpportunity(state, meta, playerId, office.key);
    if (!canRecruitProfessional(state, playerId, office.key).ok) continue;

    const capitalPotential = scoreOfficeDestination(state, meta, playerId, office, AI_NUM.N_1, 'capital', candidateId, commitment);
    const frontierPotential = scoreOfficeDestination(state, meta, playerId, office, AI_NUM.N_1, 'frontier', candidateId, commitment);
    const baseScore =
      (Math.max(capitalPotential, frontierPotential) * AI_NUM.N_0_38) +
      (profile.weights.mercenary * AI_NUM.N_0_35) +
      (standing.rank > AI_NUM.N_1 ? standing.gapToLeader * AI_NUM.N_0_03 : AI_NUM.N_0) -
      (player.gold <= AI_NUM.N_0 ? AI_NUM.N_0_3 : AI_NUM.N_0_05);
    const score = applySystemicScore(
      state,
      meta,
      playerId,
      troopManagementDescriptor(AI_ACTION_KINDS.RECRUIT, office.key, AI_NUM.N_1),
      baseScore,
      AI_ACTION_PHASES.COURT,
    );

    actions.push({ kind: 'recruit', office, score });
  }

  return actions.sort((left, right) => right.score - left.score);
}

function runRecruitmentStrategy(state, meta, playerId, plannedAction = null) {
  const action = plannedAction || findBestRecruitmentAction(state, meta, playerId);
  // Tier 2: evolvable recruitment threshold (was 1.10)
  const threshold = getMetaForPlayer(meta, playerId, 'recruitThreshold');
  if (!action || (!action.policySelected && action.score <= threshold)) return false;
  const commitment = ensureRoundContext(state, meta, 'court').pactByPlayer[playerId];
  const candidateId = commitment?.candidateId ?? state.basileusId;

  const result = recruitProfessional(state, playerId, action.office.key);
  if (!result?.ok) return false;

  invalidateRoundContext(meta);
  meta.players[playerId].stats.recruits++;
  meta.totals.recruits++;
  rememberSystemicDecision(state, meta, playerId, troopManagementDescriptor(AI_ACTION_KINDS.RECRUIT, action.office.key, AI_NUM.N_1), action.score, AI_ACTION_PHASES.COURT);
  applyDecisionToResult(state, result, buildRecruitmentDecision(state, meta, playerId, action, candidateId, commitment));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} recruits 1 professional troop for ${action.office.key}.`);
  logPublic(meta, `${publicActor(state, playerId)} recruits a professional troop for ${action.office.key}.`);
  return true;
}

function estimateProjectedIncomeBuffer(state, playerId) {
  const player = getPlayer(state, playerId);
  const baseLandIncome = getPlayerThemes(state, playerId).reduce(
    (total, theme) => total + getThemeOwnerIncome(theme),
    AI_NUM.N_0
  );
  const officeIncome = (player.majorTitles.length * AI_NUM.N_0_9) + (getMinorTitleCount(state, playerId) * AI_NUM.N_0_45) + (playerId === state.basileusId ? AI_NUM.N_2_3 : AI_NUM.N_0);
  return baseLandIncome + officeIncome;
}

function findBestDismissalAction(state, meta, playerId) {
  const threshold = getMetaForPlayer(meta, playerId, 'dismissalThreshold');
  return buildDismissalActions(state, meta, playerId)
    .find(action => action.score > threshold) || null;
}

function buildDismissalActions(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  const maintenance = getPlayerProfessionalUpkeep(state, playerId);
  if (maintenance <= AI_NUM.N_0) return [];

  const temperament = getAITemperament(meta, playerId);
  const threat = getThreatLevel(state, meta);
  const empireDanger = getEmpireDanger(state, meta);
  const standing = getStandingSnapshot(state, meta, playerId);
  const reserveTarget = AI_NUM.N_2_5 + (standing.rank === AI_NUM.N_1 ? AI_NUM.N_1 : AI_NUM.N_0) + (threat > AI_NUM.N_0_95 ? AI_NUM.N_1 : AI_NUM.N_0);
  const projectedBuffer = estimateProjectedIncomeBuffer(state, playerId);
  const immediateStrain = maintenance - Math.max(AI_NUM.N_0, player.gold - reserveTarget);
  const longTermStrain = maintenance - Math.max(AI_NUM.N_2, projectedBuffer + (player.gold * AI_NUM.N_0_2));

  const pact = ensureRoundContext(state, meta, 'court').pactByPlayer[playerId];
  const candidateId = pact?.candidateId ?? state.basileusId;
  const rankedOffices = getOfficeList(state, playerId)
    .map((office) => {
      const count = player.professionalArmies[office.key] || AI_NUM.N_0;
      if (count <= AI_NUM.N_0) return null;
      const capitalValue = scoreOfficeDestination(state, meta, playerId, office, AI_NUM.N_1, 'capital', candidateId, pact);
      const frontierValue = scoreOfficeDestination(state, meta, playerId, office, AI_NUM.N_1, 'frontier', candidateId, pact);
      return {
        office,
        count,
        marginalValue: Math.max(capitalValue, frontierValue),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.marginalValue - right.marginalValue);

  const targetCuts = Math.max(immediateStrain, longTermStrain * AI_NUM.N_0_7);
  const desiredCuts = Math.max(AI_NUM.N_1, targetCuts);
  return rankedOffices
    .map((entry) => {
      const count = Math.max(AI_NUM.N_1, Math.min(entry.count, Math.ceil(desiredCuts / Math.max(AI_NUM.N_0_9, temperament.frontierAlarm))));
      const baseScore = (targetCuts * AI_NUM.N_1_1) - (entry.marginalValue * AI_NUM.N_0_28) - (empireDanger * AI_NUM.N_0_25);
      const score = applySystemicScore(
        state,
        meta,
        playerId,
        troopManagementDescriptor(AI_ACTION_KINDS.DISMISS, entry.office.key, count),
        baseScore,
        AI_ACTION_PHASES.COURT,
      );
      return {
        kind: 'dismiss',
        office: entry.office,
        count,
        score,
        maintenanceBefore: maintenance,
      };
    })
    .sort((left, right) => right.score - left.score);
}

function runDismissalStrategy(state, meta, playerId, plannedAction = null) {
  const action = plannedAction || findBestDismissalAction(state, meta, playerId);
  if (!action) return false;

  const result = dismissProfessional(state, playerId, action.office.key, action.count);
  if (!result?.ok) return false;

  invalidateRoundContext(meta);
  rememberSystemicDecision(state, meta, playerId, troopManagementDescriptor(AI_ACTION_KINDS.DISMISS, action.office.key, action.count), action.score, AI_ACTION_PHASES.COURT);
  applyDecisionToResult(state, result, buildDismissalDecision(state, meta, playerId, action));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} dismisses ${action.count} troop${action.count === AI_NUM.N_1 ? '' : 's'} from ${action.office.key}.`);
  logPublic(meta, `${publicActor(state, playerId)} dismisses ${action.count} troop${action.count === AI_NUM.N_1 ? '' : 's'} from ${action.office.key}.`);
  return true;
}

function findBestLandPurchaseAction(state, meta, playerId) {
  return buildLandPurchaseActions(state, meta, playerId)[AI_NUM.N_0] || null;
}

function buildLandPurchaseActions(state, meta, playerId) {
  const budget = ensureCourtBudget(state, meta, playerId);
  if (budget.landPurchasesRemaining <= AI_NUM.N_0) return [];

  const player = getPlayer(state, playerId);
  return getFreeThemes(state)
    .map(theme => ({ kind: 'buy', theme, score: scoreLandPurchase(state, meta, playerId, theme) }))
    .filter(entry => getLandAuction(state, entry.theme.id)?.bidderId !== playerId)
    .filter(entry => getMinimumLandBid(state, entry.theme.id) <= player.gold)
    .sort((left, right) => right.score - left.score);
}

function runLandStrategy(state, meta, playerId, plannedAction = null) {
  const budget = ensureCourtBudget(state, meta, playerId);
  if (budget.landPurchasesRemaining <= AI_NUM.N_0) return false;

  const action = plannedAction || findBestLandPurchaseAction(state, meta, playerId);
  // Tier 2: evolvable land-purchase threshold (was 0.15)
  const threshold = getMetaForPlayer(meta, playerId, 'landPurchaseThreshold');
  if (!action || (!action.policySelected && action.score <= threshold)) return false;

  const bidAmount = getMinimumLandBid(state, action.theme.id);
  const result = buyTheme(state, playerId, action.theme.id);
  if (!result?.ok) return false;

  invalidateRoundContext(meta);
  budget.landPurchasesRemaining--;
  meta.players[playerId].stats.landBuys++;
  meta.totals.landBuys++;
  rememberSystemicDecision(state, meta, playerId, landPurchaseDescriptor(state, playerId, action.theme, bidAmount), action.score, AI_ACTION_PHASES.COURT);
  applyDecisionToResult(state, result, buildLandPurchaseDecision(state, meta, playerId, action));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} bids for ${action.theme.id} at ${bidAmount}g (score ${roundTo(action.score, AI_NUM.N_2)}).`);
  logPublic(meta, `${publicActor(state, playerId)} bids for ${action.theme.id}.`);
  return true;
}

function findBestChurchGiftAction(state, meta, playerId) {
  return buildChurchGiftActions(state, meta, playerId)[AI_NUM.N_0] || null;
}

function buildChurchGiftActions(state, meta, playerId) {
  const budget = ensureCourtBudget(state, meta, playerId);
  if (budget.churchGiftsRemaining <= AI_NUM.N_0) return [];

  return getPlayerThemes(state, playerId)
    .map(theme => ({ kind: 'gift', theme, score: scoreChurchGift(state, meta, playerId, theme) }))
    .sort((left, right) => right.score - left.score);
}

function runChurchGiftStrategy(state, meta, playerId, plannedAction = null) {
  const budget = ensureCourtBudget(state, meta, playerId);
  if (budget.churchGiftsRemaining <= AI_NUM.N_0) return false;

  const action = plannedAction || findBestChurchGiftAction(state, meta, playerId);
  // Tier 2: evolvable church-gift threshold (was 2.75)
  const threshold = getMetaForPlayer(meta, playerId, 'churchGiftThreshold');
  if (!action || (!action.policySelected && action.score <= threshold)) return false;

  const previousBishop = state.themes[action.theme.id].bishop;
  const result = giftToChurch(state, playerId, action.theme.id);
  if (!result?.ok) return false;

  invalidateRoundContext(meta);
  budget.churchGiftsRemaining--;
  meta.players[playerId].stats.themesGifted++;
  meta.totals.gifts++;
  rememberSystemicDecision(state, meta, playerId, churchGiftDescriptor(playerId, action.theme), action.score, AI_ACTION_PHASES.COURT);
  if (previousBishop != null && previousBishop !== playerId) {
    adjustRelation(meta, previousBishop, playerId, AI_NUM.N_0, AI_NUM.N_0_35);
  }
  applyDecisionToResult(state, result, buildChurchGiftDecision(state, meta, playerId, action));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} gifts ${action.theme.id} to the church (score ${roundTo(action.score, AI_NUM.N_2)}).`);
  logPublic(meta, `${publicActor(state, playerId)} gifts ${action.theme.id} to the church.`);
  return true;
}

function buildRevocationOptions(state, meta, basileusId) {
  const options = [];
  const profile = getPersonalityProfile(meta, basileusId);
  const basileusStrength = getPlayerStrength(state, meta, basileusId);
  const context = ensureRoundContext(state, meta, 'court');
  const threat = getThreatLevel(state, meta);

  for (const player of state.players) {
    if (player.id === basileusId) continue;
    if (hasRevocationTargetLock(state, basileusId, player.id)) continue;

    const wealthLead = getPlayer(state, player.id).gold - getPlayer(state, basileusId).gold;
    for (const theme of getPlayerThemes(state, player.id)) {
      if (!checkRevocationCurrentTurnAppointment(state, `theme:${theme.id}`).ok) continue;
      let score = (wealthLead * AI_NUM.N_0_35) + profile.weights.revocation + (theme.P * AI_NUM.N_0_25) + (theme.L * AI_NUM.N_0_25) + (getCategoryThresholdPressure(state, meta, player.id, 'estate') * AI_NUM.N_1_3);
      score -= getObligation(meta, basileusId, player.id) * AI_NUM.N_1_25;
      if (context.pactByPlayer[player.id]?.candidateId === basileusId) score -= AI_NUM.N_1_8;
      if (getThemeRouteRisk(state, theme.id) > AI_NUM.N_0_6 && threat > AI_NUM.N_0_75) score -= AI_NUM.N_0_7;
      options.push({
        kind: 'theme',
        themeId: theme.id,
        targetPlayerId: player.id,
        score,
      });
    }
  }

  for (const theme of Object.values(state.themes)) {
    if (!theme.occupied && theme.strategos != null && !hasRevocationTargetLock(state, basileusId, theme.strategos)) {
      if (checkRevocationCurrentTurnAppointment(state, `minor:${theme.id}:strategos`).ok) {
        let score = (getPlayerStrength(state, meta, theme.strategos) - basileusStrength) * AI_NUM.N_0_18 + profile.weights.revocation + theme.L + (getCategoryThresholdPressure(state, meta, theme.strategos, 'tax') * AI_NUM.N_1_1);
        score -= getObligation(meta, basileusId, theme.strategos) * AI_NUM.N_1_15;
        if (context.pactByPlayer[theme.strategos]?.candidateId === basileusId) score -= AI_NUM.N_1_7;
        options.push({
          kind: 'minor',
          themeId: theme.id,
          titleType: 'strategos',
          targetPlayerId: theme.strategos,
          score,
        });
      }
    }
    if (theme.bishop != null && !hasRevocationTargetLock(state, basileusId, theme.bishop)) {
      if (!checkRevocationCurrentTurnAppointment(state, `minor:${theme.id}:bishop`).ok) continue;
      let score = (getPlayerStrength(state, meta, theme.bishop) - basileusStrength) * AI_NUM.N_0_12 + profile.weights.revocation + (theme.P * AI_NUM.N_0_8) + (getCategoryThresholdPressure(state, meta, theme.bishop, 'church') * AI_NUM.N_1_1);
      score -= getObligation(meta, basileusId, theme.bishop) * AI_NUM.N_1_1;
      if (context.pactByPlayer[theme.bishop]?.candidateId === basileusId) score -= AI_NUM.N_1_5;
      options.push({
        kind: 'minor',
        themeId: theme.id,
        titleType: 'bishop',
        targetPlayerId: theme.bishop,
        score,
      });
    }
  }

  if (state.empress != null && !hasRevocationTargetLock(state, basileusId, state.empress)) {
    if (checkRevocationCurrentTurnAppointment(state, 'court:EMPRESS').ok) {
      let score = profile.weights.revocation + (getPlayerStrength(state, meta, state.empress) - basileusStrength) * AI_NUM.N_0_15;
      score -= getObligation(meta, basileusId, state.empress) * AI_NUM.N_1_1;
      if (context.pactByPlayer[state.empress]?.candidateId === basileusId) score -= AI_NUM.N_1_6;
      options.push({
        kind: 'court',
        titleType: 'EMPRESS',
        targetPlayerId: state.empress,
        score,
      });
    }
  }
  if (state.chiefEunuchs != null && !hasRevocationTargetLock(state, basileusId, state.chiefEunuchs)) {
    if (checkRevocationCurrentTurnAppointment(state, 'court:CHIEF_EUNUCHS').ok) {
      let score = profile.weights.revocation + (getPlayerStrength(state, meta, state.chiefEunuchs) - basileusStrength) * AI_NUM.N_0_15;
      score -= getObligation(meta, basileusId, state.chiefEunuchs) * AI_NUM.N_1_1;
      if (context.pactByPlayer[state.chiefEunuchs]?.candidateId === basileusId) score -= AI_NUM.N_1_6;
      options.push({
        kind: 'court',
        titleType: 'CHIEF_EUNUCHS',
        targetPlayerId: state.chiefEunuchs,
        score,
      });
    }
  }

  const cost = getNextRevocationCost(state, basileusId);
  return options
    .map(option => ({
      ...option,
      score: applySystemicScore(
        state,
        meta,
        basileusId,
        revocationDescriptor(basileusId, option, cost),
        option.score,
        AI_ACTION_PHASES.COURT,
      ),
    }))
    .sort((left, right) => right.score - left.score);
}

function executeBasileusRevocationOption(state, meta, best) {
  const basileusId = state.basileusId;
  if (!best) return false;
  const costCheck = canPayRevocationCost(state, basileusId);
  if (!costCheck.ok) return false;
  const cost = costCheck.cost;
  let result = null;
  if (best.kind === 'minor') {
    result = revokeMinorTitle(state, best.themeId, best.titleType);
    if (result?.ok && best.targetPlayerId != null) {
      adjustRelation(meta, best.targetPlayerId, basileusId, AI_NUM.N_0, AI_NUM.N_0_95);
      reduceObligation(meta, basileusId, best.targetPlayerId, AI_NUM.N_0_6);
      logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, basileusId)} revokes the ${best.titleType} of ${best.themeId}.`);
      logPublic(meta, `${publicActor(state, basileusId)} revokes the ${best.titleType} of ${best.themeId}.`);
    }
  } else if (best.kind === 'theme') {
    result = revokeTheme(state, best.themeId);
    if (result?.ok && best.targetPlayerId != null) {
      adjustRelation(meta, best.targetPlayerId, basileusId, AI_NUM.N_0, AI_NUM.N_1_15);
      reduceObligation(meta, basileusId, best.targetPlayerId, AI_NUM.N_0_75);
      logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, basileusId)} strips ${best.themeId} from ${describeActor(state, meta, best.targetPlayerId)}.`);
      logPublic(meta, `${publicActor(state, basileusId)} strips ${best.themeId} from ${publicActor(state, best.targetPlayerId)}.`);
    }
  } else if (best.kind === 'court') {
    result = revokeCourtTitle(state, best.titleType);
    if (result?.ok && best.targetPlayerId != null) {
      adjustRelation(meta, best.targetPlayerId, basileusId, AI_NUM.N_0, AI_NUM.N_0_8);
      reduceObligation(meta, basileusId, best.targetPlayerId, AI_NUM.N_0_5);
      logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, basileusId)} revokes the ${best.titleType} court title.`);
      logPublic(meta, `${publicActor(state, basileusId)} revokes the ${best.titleType} court title.`);
    }
  }

  if (!result?.ok) return false;
  rememberSystemicDecision(state, meta, basileusId, revocationDescriptor(basileusId, best, cost), best.score, AI_ACTION_PHASES.COURT);
  applyDecisionToResult(state, result, buildRevocationDecision(state, meta, basileusId, best));
  meta.players[basileusId].stats.revocations++;
  meta.totals.revocations++;
  invalidateRoundContext(meta);
  return true;
}

// ── Patriarch / regional revocations (non-Basileus authorities) ───────────────
// The Patriarch may revoke any bishop. A Domestic of the East/West or the
// Admiral may revoke a strategos in their region. Patriarch bishop revocations
// use doubled per-revoker gold costs; regional revocations use troops.
const REGIONAL_REVOKE_REGIONS = { DOM_EAST: 'east', DOM_WEST: 'west', ADMIRAL: 'sea' };

function buildTitleHolderRevocationOptions(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  const profile = getPersonalityProfile(meta, playerId);
  const options = [];
  const playerStrength = getPlayerStrength(state, meta, playerId);

  const considerStrategos = (titleKey) => {
    const region = REGIONAL_REVOKE_REGIONS[titleKey];
    for (const theme of Object.values(state.themes)) {
      if (theme.region !== region || theme.occupied || theme.strategos == null) continue;
      if (theme.strategos === playerId) continue;
      if (hasRevocationTargetLock(state, playerId, theme.strategos)) continue;
      if (!checkRevocationCurrentTurnAppointment(state, `minor:${theme.id}:strategos`).ok) continue;
      let score = (getPlayerStrength(state, meta, theme.strategos) - playerStrength) * AI_NUM.N_0_18
        + profile.weights.revocation + (theme.L * AI_NUM.N_0_4)
        + (getCategoryThresholdPressure(state, meta, theme.strategos, 'tax') * AI_NUM.N_0_9);
      score -= getObligation(meta, playerId, theme.strategos) * AI_NUM.N_1_2;
      options.push({
        kind: 'minor',
        titleType: 'strategos',
        themeId: theme.id,
        targetPlayerId: theme.strategos,
        score,
      });
    }
  };

  if (player.majorTitles.includes('DOM_EAST')) considerStrategos('DOM_EAST');
  if (player.majorTitles.includes('DOM_WEST')) considerStrategos('DOM_WEST');
  if (player.majorTitles.includes('ADMIRAL')) considerStrategos('ADMIRAL');

  if (player.majorTitles.includes('PATRIARCH')) {
    for (const theme of Object.values(state.themes)) {
      if (theme.bishop == null) continue;
      if (theme.bishop === playerId) continue;
      if (hasRevocationTargetLock(state, playerId, theme.bishop)) continue;
      if (!checkRevocationCurrentTurnAppointment(state, `minor:${theme.id}:bishop`).ok) continue;
      let score = (getPlayerStrength(state, meta, theme.bishop) - playerStrength) * AI_NUM.N_0_18
        + profile.weights.revocation + (Number(theme.C) || AI_NUM.N_0) * AI_NUM.N_0_6
        + (getCategoryThresholdPressure(state, meta, theme.bishop, 'church') * AI_NUM.N_0_95);
      score -= getObligation(meta, playerId, theme.bishop) * AI_NUM.N_1_2;
      options.push({
        kind: 'minor',
        titleType: 'bishop',
        themeId: theme.id,
        targetPlayerId: theme.bishop,
        score,
      });
    }
  }

  return options.sort((left, right) => right.score - left.score);
}

function buildAffordableTitleHolderRevocationOptions(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  return buildTitleHolderRevocationOptions(state, meta, playerId)
    .map((option) => {
      const goldRevocation = option.titleType === 'bishop' && player.majorTitles.includes('PATRIARCH');
      const paymentCheck = goldRevocation
        ? canPayPatriarchBishopRevocationCost(state, playerId, option.targetPlayerId)
        : canPayRevocationCost(state, playerId);
      if (!paymentCheck.ok) return null;
      const costStep = goldRevocation
        ? Math.max(AI_NUM.N_0, (getPatriarchBishopRevocationGoldCost(state, playerId, option.targetPlayerId) / AI_NUM.N_2) - AI_NUM.N_1)
        : Math.max(AI_NUM.N_0, paymentCheck.cost - AI_NUM.N_1);
      const systemicScore = applySystemicScore(
        state,
        meta,
        playerId,
        revocationDescriptor(playerId, option, paymentCheck.cost || paymentCheck.goldCost || AI_NUM.N_0, goldRevocation ? 'gold' : 'troops'),
        option.score,
        AI_ACTION_PHASES.COURT,
      );
      return {
        ...option,
        score: systemicScore,
        paymentCheck: {
          ...paymentCheck,
          paymentType: goldRevocation ? 'gold' : 'troops',
        },
        threshold: getMetaForPlayer(meta, playerId, 'revocationThreshold') + costStep * AI_NUM.N_0_85,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
}

function executeTitleHolderRevocationOption(state, meta, playerId, best) {
  if (playerId === state.basileusId || !best) return false;
  const result = revokeMinorTitle(state, best.themeId, best.titleType, playerId);
  if (!result?.ok) return false;

  if (best.targetPlayerId != null) {
    adjustRelation(meta, best.targetPlayerId, playerId, AI_NUM.N_0, AI_NUM.N_0_95);
    reduceObligation(meta, playerId, best.targetPlayerId, AI_NUM.N_0_55);
  }
  rememberSystemicDecision(
    state,
    meta,
    playerId,
    revocationDescriptor(playerId, best, best.paymentCheck?.cost || best.paymentCheck?.goldCost || AI_NUM.N_0, best.paymentCheck?.paymentType || 'troops'),
    best.score,
    AI_ACTION_PHASES.COURT,
  );
  applyDecisionToResult(state, result, buildRevocationDecision(state, meta, playerId, best));
  meta.players[playerId].stats.revocations++;
  meta.totals.revocations++;
  invalidateRoundContext(meta);
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} revokes the ${best.titleType} of ${best.themeId}.`);
  logPublic(meta, `${publicActor(state, playerId)} revokes the ${best.titleType} of ${best.themeId}.`);
  return true;
}

function scoreOfficeDestination(state, meta, playerId, office, troopCount, destination, candidateId, pact) {
  const profile = getPersonalityProfile(meta, playerId);
  const temperament = getAITemperament(meta, playerId);
  const threat = getThreatLevel(state, meta);
  const empireDanger = getEmpireDanger(state, meta);
  const candidateAffinity = getAffinityScore(meta, playerId, candidateId);
  const exposure = getPlayerExposure(state, playerId, meta);
  const ownStake = getPlayerThreatenedLandValue(state, playerId, meta);
  const rivalStake = getRivalThreatenedLandValue(state, playerId, meta);
  const officeRouteRisk = office.themeId ? getThemeRouteRisk(state, office.themeId) : AI_NUM.N_0;
  const coalitionNeed = pact?.capitalBias || AI_NUM.N_0;
  const standing = getStandingSnapshot(state, meta, playerId);
  const basileusStanding = getStandingSnapshot(state, meta, state.basileusId);
  const candidateStanding = getStandingSnapshot(state, meta, candidateId);
  const endgamePressure = getRemainingRounds(state) <= AI_NUM.N_2 ? AI_NUM.N_0_6 : AI_NUM.N_0;

  if (destination === 'frontier') {
    let score = troopCount * ((profile.weights.frontier * (AI_NUM.N_1_05 + (empireDanger * temperament.frontierAlarm))) + AI_NUM.N_0_55);
    score += exposure * (AI_NUM.N_0_9 + (AI_NUM.N_0_22 * temperament.frontierAlarm));
    score += ownStake * AI_NUM.N_0_12;
    score += empireDanger * (AI_NUM.N_1_15 + (AI_NUM.N_0_45 * temperament.frontierAlarm));
    score += threat * (AI_NUM.N_0_55 + (AI_NUM.N_0_4 * temperament.frontierAlarm));
    if (office.key.startsWith('STRAT_')) score += AI_NUM.N_0_95;
    if (officeRouteRisk > AI_NUM.N_0) score += officeRouteRisk * (AI_NUM.N_2 + (AI_NUM.N_0_65 * temperament.frontierAlarm));
    if (office.region && getPlayerThemes(state, playerId).some(theme => theme.region === office.region)) score += AI_NUM.N_0_7;
    if (candidateId === state.basileusId) score += AI_NUM.N_0_35;
    if (empireDanger > AI_NUM.N_1_15) score += troopCount * AI_NUM.N_0_5;
    if (standing.rank > AI_NUM.N_1 && empireDanger < AI_NUM.N_1_05 && rivalStake > ownStake) {
      score -= (rivalStake - ownStake) * AI_NUM.N_0_08;
    }
    if (standing.rank > AI_NUM.N_1 && basileusStanding.rank === AI_NUM.N_1 && candidateId !== state.basileusId) score -= AI_NUM.N_0_2;
    return applySystemicScore(
      state,
      meta,
      playerId,
      {
        kind: AI_ACTION_KINDS.ORDERS,
        phase: AI_ACTION_PHASES.ORDERS,
        payload: { candidateId, officeKey: office.key, destination },
        commitments: { frontierTroops: troopCount },
      },
      score,
      AI_ACTION_PHASES.ORDERS,
    );
  }

  let score = troopCount * ((profile.weights.capital * AI_NUM.N_0_96) + (profile.weights.throne * AI_NUM.N_0_82) + (candidateAffinity * AI_NUM.N_0_45));
  score += coalitionNeed * (AI_NUM.N_1_55 / Math.max(AI_NUM.N_0_8, temperament.independence));
  score += getObligation(meta, playerId, candidateId) * AI_NUM.N_0_8;
  score += Math.max(AI_NUM.N_0, standing.gapToLeader) * AI_NUM.N_0_07;
  score += endgamePressure;
  if (candidateId === playerId) score += troopCount * AI_NUM.N_1_6;
  if (candidateId === state.basileusId) score += troopCount * AI_NUM.N_0_62 + (standing.rank === AI_NUM.N_1 ? AI_NUM.N_0_5 : AI_NUM.N_0);
  if (candidateId !== state.basileusId && basileusStanding.rank === AI_NUM.N_1) score += troopCount * AI_NUM.N_0_58;
  if (candidateId !== playerId && candidateStanding.rank === AI_NUM.N_1) score -= troopCount * AI_NUM.N_0_55;
  if (empireDanger > AI_NUM.N_1_05) score -= troopCount * (AI_NUM.N_0_28 + (AI_NUM.N_0_22 * temperament.frontierAlarm));
  if (empireDanger > AI_NUM.N_1_2 && candidateId !== state.basileusId) score -= troopCount * AI_NUM.N_0_45;
  if (exposure > AI_NUM.N_1_25 && empireDanger > AI_NUM.N_1_1) score -= exposure * AI_NUM.N_0_58;
  return applySystemicScore(
    state,
    meta,
    playerId,
    {
      kind: AI_ACTION_KINDS.ORDERS,
      phase: AI_ACTION_PHASES.ORDERS,
      payload: { candidateId, officeKey: office.key, destination },
      commitments: { capitalTroops: troopCount },
    },
    score,
    AI_ACTION_PHASES.ORDERS,
  );
}

function getMercCount(mercenaries, officeKey) {
  return mercenaries.find(entry => entry.officeKey === officeKey)?.count || AI_NUM.N_0;
}

function buildFallbackOrdersFromLegalState(state, playerId, candidateId) {
  const offices = getOfficeList(state, playerId, { includeMercenaryCompany: getPlayerMercenaryTotal(state, playerId) > AI_NUM.N_0 });
  const deployments = {};
  const locks = buildOrderLocksForPlayer(state, playerId);

  for (const office of offices) {
    const lockedDestination = locks?.committedOfficeKeys?.[office.key] || null;
    deployments[office.key] = lockedDestination || (office.capitalLocked || CAPITAL_LOCKED_OFFICE_KEYS.has(office.key) ? 'capital' : 'frontier');
  }

  const requested = { candidate: locks?.candidateId ?? candidateId, deployments };
  const normalized = normalizeOrdersWithDealLocks(state, playerId, requested);
  return normalized?.ok ? normalized.orders : requested;
}

function getOfficeTroopTotalForOrders(state, playerId, office) {
  const player = getPlayer(state, playerId);
  const mercenaries = getPlayerMercenaryAssignments(state, playerId);
  const professionalTroops = office.key === MERCENARY_COMPANY_KEY ? AI_NUM.N_0 : (player.professionalArmies[office.key] || AI_NUM.N_0);
  const levyTroops = office.key === MERCENARY_COMPANY_KEY ? AI_NUM.N_0 : (state.currentLevies?.[office.key] || AI_NUM.N_0);
  const mercenaryTroops = getMercCount(mercenaries, office.key);
  return professionalTroops + levyTroops + mercenaryTroops;
}

function buildOrderOfficePlansFromOrders(state, playerId, orders) {
  return getOfficeList(state, playerId, { includeMercenaryCompany: getPlayerMercenaryTotal(state, playerId) > AI_NUM.N_0 })
    .map((office) => {
      const destination = orders.deployments?.[office.key] || 'frontier';
      const capitalLocked = office.capitalLocked || CAPITAL_LOCKED_OFFICE_KEYS.has(office.key);
      return {
        office,
        officeKey: office.key,
        officeLabel: office.label,
        troopCount: getOfficeTroopTotalForOrders(state, playerId, office),
        frontierScore: destination === 'frontier' ? AI_NUM.N_1 : AI_NUM.N_0,
        capitalScore: destination === 'capital' ? AI_NUM.N_1 : AI_NUM.N_0,
        destination,
        capitalLocked,
      };
    });
}

function uniqueOrderKey(candidateId, deployments) {
  return `${candidateId}|${Object.entries(deployments || {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join(',')}`;
}

function buildDeploymentVariants(fixedDeployments, flexibleOfficeKeys, limit) {
  const variants = [];
  const seen = new Set();
  const pushMask = (mask) => {
    const deployments = { ...fixedDeployments };
    flexibleOfficeKeys.forEach((officeKey, index) => {
      deployments[officeKey] = (mask & (AI_NUM.N_1 << index)) ? 'capital' : 'frontier';
    });
    const key = Object.entries(deployments).sort(([left], [right]) => left.localeCompare(right)).map(([officeKey, value]) => `${officeKey}:${value}`).join(',');
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(deployments);
  };

  if (!flexibleOfficeKeys.length) return [{ ...fixedDeployments }];
  const safeBits = Math.min(flexibleOfficeKeys.length, AI_NUM.N_30);
  const totalMasks = AI_NUM.N_2 ** safeBits;
  if (flexibleOfficeKeys.length === safeBits && totalMasks <= limit) {
    for (let mask = AI_NUM.N_0; mask < totalMasks; mask++) pushMask(mask);
    return variants;
  }

  pushMask(AI_NUM.N_0);
  pushMask(totalMasks - AI_NUM.N_1);
  let alternatingA = AI_NUM.N_0;
  let alternatingB = AI_NUM.N_0;
  for (let index = AI_NUM.N_0; index < safeBits; index++) {
    if (index % AI_NUM.N_2 === AI_NUM.N_0) alternatingA |= AI_NUM.N_1 << index;
    else alternatingB |= AI_NUM.N_1 << index;
  }
  pushMask(alternatingA);
  pushMask(alternatingB);

  const stride = Math.max(AI_NUM.N_1, Math.floor(totalMasks / Math.max(AI_NUM.N_1, limit - variants.length)));
  for (let mask = stride; mask < totalMasks && variants.length < limit; mask += stride) {
    pushMask(mask);
  }
  return variants.slice(AI_NUM.N_0, limit);
}

function getOrderPolicyFeatures(state, meta, playerId, candidateId, orders, locks, context, officeTroopTotals = null) {
  const totals = computeOrderTotals(state, playerId, orders, officeTroopTotals);
  const totalTroops = Math.max(AI_NUM.N_1, totals.capital + totals.frontier);
  const candidateAlignment = context.candidateBaseScores?.[playerId]?.[candidateId] ?? scoreCandidateBase(state, meta, playerId, candidateId);
  const relation = getAffinityScore(meta, playerId, candidateId);
  const empireDanger = getEmpireDanger(state, meta);
  const endgame = getRemainingRounds(state) <= AI_NUM.N_2 ? AI_NUM.N_1 : AI_NUM.N_0;
  const dealLockCount = Object.keys(locks?.committedOfficeKeys || {}).length + (locks?.candidateId != null ? AI_NUM.N_1 : AI_NUM.N_0);
  const standing = getStandingSnapshot(state, meta, playerId);
  const candidateStanding = getStandingSnapshot(state, meta, candidateId);
  return {
    totals,
    extra: {
      candidateAlignment,
      relation,
      capitalCommitment: totals.capital,
      frontierCommitment: totals.frontier,
      dealLock: dealLockCount,
      selfClaim: candidateId === playerId ? AI_NUM.N_1 : AI_NUM.N_0,
      incumbentSupport: candidateId === state.basileusId ? AI_NUM.N_1 : AI_NUM.N_0,
      rivalSupport: candidateId !== playerId && candidateId !== state.basileusId ? AI_NUM.N_1 : AI_NUM.N_0,
      survival: empireDanger,
      military: totalTroops,
      political: totals.capital / totalTroops,
      risk: candidateStanding.rank === AI_NUM.N_1 && candidateId !== playerId ? AI_NUM.N_0_5 : AI_NUM.N_0,
      urgency: empireDanger + Math.max(AI_NUM.N_0, standing.gapToLeader / AI_NUM.N_8),
      routeSafety: (totals.frontier / totalTroops) * empireDanger,
      endgame,
      endgameEconomic: endgame * getCategoryThresholdPressure(state, meta, playerId, 'gold'),
      denial: candidateId !== state.basileusId ? totals.capital / totalTroops : AI_NUM.N_0,
    },
  };
}

export function collectAIOrderActionOptions(state, meta, playerId) {
  return withPolicyNumericTuning(meta, playerId, () => {
  if (!state || state.phase !== 'orders') return [];
  if (!isAIPlayer(meta, playerId) || state.allOrders?.[playerId]) return [];
  const player = getPlayer(state, playerId);
  if (!player) return [];
  const locks = buildOrderLocksForPlayer(state, playerId);
  if (!locks?.ok) return [];
  const context = ensureRoundContext(state, meta, 'orders');
  const offices = getOfficeList(state, playerId, { includeMercenaryCompany: getPlayerMercenaryTotal(state, playerId) > AI_NUM.N_0 });
  const officeTroopTotals = buildOrderOfficeTroopTotals(state, playerId, offices);
  const candidateIds = locks.candidateId != null ? [locks.candidateId] : state.players.map(candidate => candidate.id);
  const fixedDeployments = {};
  const flexibleOfficeKeys = [];
  for (const office of offices) {
    const lockedDestination = locks.committedOfficeKeys?.[office.key] || null;
    if (lockedDestination) fixedDeployments[office.key] = lockedDestination;
    else if (office.capitalLocked || CAPITAL_LOCKED_OFFICE_KEYS.has(office.key)) fixedDeployments[office.key] = 'capital';
    else flexibleOfficeKeys.push(office.key);
  }

  const optionLimit = getPolicyLimit(meta, playerId, 'orderPlanLimit', ORDER_PLAN_HARD_LIMIT);
  const variants = buildDeploymentVariants(fixedDeployments, flexibleOfficeKeys, optionLimit);
  const seen = new Set();
  const options = [];

  for (const candidateId of candidateIds) {
    for (const deployments of variants) {
      if (options.length >= optionLimit) break;
      const normalized = normalizeOrdersWithDealLocks(state, playerId, { candidate: candidateId, deployments });
      if (!normalized?.ok) continue;
      const orders = normalized.orders;
      const key = uniqueOrderKey(orders.candidate, orders.deployments);
      if (seen.has(key)) continue;
      seen.add(key);
      const { totals, extra } = getOrderPolicyFeatures(state, meta, playerId, orders.candidate, orders, normalized.orderLocks || locks, context, officeTroopTotals);
      options.push(makePolicyAction(
        state,
        meta,
        playerId,
        AI_ACTION_KINDS.ORDERS,
        AI_ACTION_PHASES.ORDERS,
        AI_NUM.N_0,
        {
          payload: { candidateId: orders.candidate, orders },
          targets: [orders.candidate],
          commitments: { capitalTroops: totals.capital, frontierTroops: totals.frontier },
          timing: 'immediate',
          reversibility: 'low',
        },
        null,
        extra,
      ));
    }
  }

  return options.sort((left, right) => right.policyScore - left.policyScore);
  });
}

export function buildAIOrders(state, meta, playerId) {
  return withPolicyNumericTuning(meta, playerId, () => {
  const context = ensureRoundContext(state, meta, 'orders');
  const option = selectPolicyOption(state, meta, playerId, collectAIOrderActionOptions(state, meta, playerId));
  const fallbackPact = context.pactByPlayer[playerId];
  const fallbackCandidateId = fallbackPact?.candidateId ?? state.basileusId;
  const fallbackOrders = buildFallbackOrdersFromLegalState(state, playerId, fallbackCandidateId);
  const orders = option?.descriptor?.payload?.orders || fallbackOrders;
  const candidateId = orders.candidate;
  const deployments = orders.deployments || {};
  const officePlans = buildOrderOfficePlansFromOrders(state, playerId, orders);
  const mercenaries = getPlayerMercenaryAssignments(state, playerId);

  let frontierTroops = AI_NUM.N_0;
  let capitalTroops = AI_NUM.N_0;
  for (const plan of officePlans) {
    const totalTroops = plan.troopCount + getMercCount(mercenaries, plan.office.key);
    if (plan.destination === 'frontier') frontierTroops += totalTroops;
    else capitalTroops += totalTroops;
  }

  meta.players[playerId].stats.frontierTroops += frontierTroops;
  meta.players[playerId].stats.capitalTroops += capitalTroops;
  meta.players[playerId].stats.coupVotes++;
  if (candidateId === state.basileusId) meta.players[playerId].stats.supportIncumbentVotes++;
  if (candidateId === playerId) meta.players[playerId].stats.supportSelfVotes++;
  rememberSystemicDecision(
    state,
    meta,
    playerId,
    {
      kind: AI_ACTION_KINDS.ORDERS,
      phase: AI_ACTION_PHASES.ORDERS,
      payload: { candidateId, orders: { deployments, candidate: candidateId } },
      commitments: { capitalTroops, frontierTroops },
      timing: 'immediate',
      reversibility: 'low',
    },
    option?.policyScore || AI_NUM.N_0,
    AI_ACTION_PHASES.ORDERS,
  );
  logDecision(meta, `Round ${state.round} orders: ${describeActor(state, meta, playerId)} backs ${describeActor(state, meta, candidateId)} with ${capitalTroops} capital troops and ${frontierTroops} frontier troops.`);
  const pact = fallbackPact;
  const debug = {
    pactKind: pact?.kind || 'defense',
    candidateId,
    candidateName: publicActor(state, candidateId),
    officePlans: officePlans.map(plan => ({
      officeKey: plan.officeKey,
      officeLabel: plan.officeLabel,
      troopCount: plan.troopCount,
      frontierScore: roundTo(plan.frontierScore, AI_NUM.N_2),
      capitalScore: roundTo(plan.capitalScore, AI_NUM.N_2),
      destination: plan.destination,
    })),
    decision: buildOrdersDecision(state, meta, playerId, candidateId, pact, officePlans, mercenaries, capitalTroops, frontierTroops, context),
  };

  return { deployments, candidate: candidateId, debug };
  });
}

function buildMercenaryHireActions(state, meta, playerId) {
  const spendableGold = getSpendableGold(state, playerId);
  const alreadyHired = getPlayerMercenaryTotal(state, playerId);
  const limit = getPolicyLimit(meta, playerId, 'mercenaryHireLimit', MERCENARY_HIRE_HARD_LIMIT);
  const actions = [];
  for (let count = AI_NUM.N_1; count <= limit; count++) {
    const cost = getMercenaryHireCost(alreadyHired, count);
    if (cost > spendableGold) break;
    actions.push({
      officeKey: MERCENARY_COMPANY_KEY,
      count,
      cost,
    });
  }
  return actions;
}

function runMercenaryStrategy(state, meta, playerId, plannedAction = null) {
  const selected = plannedAction || selectPolicyOption(state, meta, playerId, getMercenaryPoolActions(state, meta, playerId));
  const count = Math.round(Number(selected?.count ?? selected?.descriptor?.payload?.count) || AI_NUM.N_0);
  if (count <= AI_NUM.N_0) return false;

  const result = hireMercenaries(state, playerId, MERCENARY_COMPANY_KEY, count);
  if (!result?.ok) return false;

  invalidateRoundContext(meta);
  meta.players[playerId].stats.mercsHired += count;
  meta.players[playerId].stats.mercSpend += result.cost || AI_NUM.N_0;
  meta.totals.mercSpend += result.cost || AI_NUM.N_0;
  rememberSystemicDecision(
    state,
    meta,
    playerId,
    {
      kind: AI_ACTION_KINDS.MERCENARY_HIRE,
      phase: AI_ACTION_PHASES.COURT,
      payload: { officeKey: MERCENARY_COMPANY_KEY, count },
      costs: { gold: result.cost || AI_NUM.N_0 },
      gains: { troops: count },
      timing: 'immediate',
      reversibility: 'medium',
    },
    selected?.score ?? selected?.policyScore ?? AI_NUM.N_0,
    AI_ACTION_PHASES.COURT,
  );
  applyDecisionToResult(state, result, buildMercenaryDecision({ ...selected, count }, result.cost || AI_NUM.N_0));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} hires ${count} mercenary troop${count === AI_NUM.N_1 ? '' : 's'}.`);
  logPublic(meta, `${publicActor(state, playerId)} hires ${count} mercenary troop${count === AI_NUM.N_1 ? '' : 's'}.`);
  return true;
}

function buildOrderOfficeTroopTotals(state, playerId, offices = null) {
  const player = getPlayer(state, playerId);
  const mercenaries = getPlayerMercenaryAssignments(state, playerId);
  const officeList = offices || getOfficeList(state, playerId, { includeMercenaryCompany: getPlayerMercenaryTotal(state, playerId) > AI_NUM.N_0 });
  const totals = new Map();
  for (const office of officeList) {
    const professionalTroops = office.key === MERCENARY_COMPANY_KEY ? AI_NUM.N_0 : (player.professionalArmies[office.key] || AI_NUM.N_0);
    const levyTroops = office.key === MERCENARY_COMPANY_KEY ? AI_NUM.N_0 : (state.currentLevies?.[office.key] || AI_NUM.N_0);
    const mercenaryTroops = getMercCount(mercenaries, office.key);
    totals.set(office.key, professionalTroops + levyTroops + mercenaryTroops);
  }
  return totals;
}

function computeOrderTotalsFromOfficeTroops(officeTroopTotals, orders) {
  let capital = AI_NUM.N_0;
  let frontier = AI_NUM.N_0;

  for (const [officeKey, totalTroops] of officeTroopTotals.entries()) {
    if ((orders.deployments?.[officeKey] || 'frontier') === 'capital') capital += totalTroops;
    else frontier += totalTroops;
  }

  return { capital, frontier };
}

function computeOrderTotals(state, playerId, orders, officeTroopTotals = null) {
  return computeOrderTotalsFromOfficeTroops(
    officeTroopTotals || buildOrderOfficeTroopTotals(state, playerId),
    orders,
  );
}

function updatePostResolutionRelations(state, meta) {
  const winnerId = state.lastCoupResult?.winner ?? state.basileusId;
  const defenderWon = winnerId === state.basileusId;
  const incumbentId = state.basileusId;

  // Tier 5: every AI updates its posterior on every other player using the
  // observed troop split + coup vote + mercenary spend from this round.
  for (const observer of state.players) {
    if (!isAIPlayer(meta, observer.id)) continue;
    for (const target of state.players) {
      if (target.id === observer.id) continue;
      const targetOrders = state.allOrders[target.id];
      if (!targetOrders) continue;
      const totals = computeOrderTotals(state, target.id, targetOrders);
      const totalTroops = totals.capital + totals.frontier;
      const frontierShare = totalTroops > AI_NUM.N_0 ? totals.frontier / totalTroops : AI_NUM.N_0_5;
      const mercSpend = getPlayerMercenaryTotal(state, target.id);
      const mercNorm = clamp(mercSpend / AI_NUM.N_5, AI_NUM.N_0, AI_NUM.N_1);
      const throneAgainst = targetOrders.candidate != null && targetOrders.candidate !== incumbentId ? AI_NUM.N_1 : AI_NUM.N_0;
      updateOpponentPosterior(meta, observer.id, target.id, {
        frontierShare,
        mercenarySpend: mercNorm,
        throneAgainstIncumbent: throneAgainst,
      });
    }
  }

  for (const player of state.players) {
    const orders = state.allOrders[player.id];
    if (!orders) continue;
    const totals = computeOrderTotals(state, player.id, orders);
    const supportedWinner = orders.candidate === winnerId;

    if (supportedWinner && player.id !== winnerId) {
      adjustRelation(meta, player.id, winnerId, AI_NUM.N_0_7, AI_NUM.N_0);
      adjustRelation(meta, winnerId, player.id, AI_NUM.N_0_35, AI_NUM.N_0);
      addObligation(meta, winnerId, player.id, AI_NUM.N_0_55 + (totals.capital * AI_NUM.N_0_22) + (defenderWon ? AI_NUM.N_0_2 : AI_NUM.N_0_35));
      reduceObligation(meta, player.id, winnerId, AI_NUM.N_0_8 + (totals.capital * AI_NUM.N_0_12));
    } else if (orders.candidate === player.id && player.id !== winnerId) {
      adjustRelation(meta, player.id, winnerId, AI_NUM.N_0, AI_NUM.N_0_35);
    } else if (orders.candidate === state.basileusId && winnerId !== state.basileusId) {
      adjustRelation(meta, player.id, state.basileusId, AI_NUM.N_0_15, AI_NUM.N_0_15);
    }

    if (totals.frontier > totals.capital && state.lastWarResult?.outcome === 'victory') {
      addObligation(meta, state.basileusId, player.id, AI_NUM.N_0_15 + (totals.frontier * AI_NUM.N_0_05));
    }
  }
}

function enumerateTitleAssignments(state, newBasileusId) {
  const assignments = [];
  const eligibleIds = state.players.filter(player => player.id !== newBasileusId).map(player => player.id);

  function walk(index, current) {
    if (index >= MAJOR_TITLE_KEYS.length) {
      const validation = validateMajorTitleAssignments(state, newBasileusId, current);
      if (validation.ok) assignments.push({ ...current });
      return;
    }

    const titleKey = MAJOR_TITLE_KEYS[index];
    for (const playerId of eligibleIds) {
      current[titleKey] = playerId;
      walk(index + AI_NUM.N_1, current);
    }
  }

  walk(AI_NUM.N_0, {});
  return assignments;
}

function getTitleRoleFitScore(state, meta, newBasileusId, holderId, titleKey, orders, totals) {
  const inferredHolderProfile = blendedOpponentProfile(meta, newBasileusId, holderId);
  const regionalStake = getPlayerThemes(state, holderId)
    .filter((theme) => !theme.occupied && MAJOR_TITLES[titleKey]?.region && theme.region === MAJOR_TITLES[titleKey].region)
    .reduce((total, theme) => total + AI_NUM.N_0_22 + (theme.L * AI_NUM.N_0_18) + (theme.P * AI_NUM.N_0_05), AI_NUM.N_0);
  const frontierCommitment = totals.frontier * AI_NUM.N_0_18 + (meta.players?.[holderId]?.stats?.frontierTroops || AI_NUM.N_0) * AI_NUM.N_0_035;
  const capitalCommitment = totals.capital * AI_NUM.N_0_1;

  if (titleKey === 'PATRIARCH') {
    return (
      (inferredHolderProfile.weights.church * AI_NUM.N_0_64) +
      (inferredHolderProfile.weights.loyalty * AI_NUM.N_0_18) -
      (inferredHolderProfile.weights.revocation * AI_NUM.N_0_22) -
      (orders?.candidate != null && orders.candidate !== newBasileusId ? AI_NUM.N_0_35 : AI_NUM.N_0)
    );
  }

  const officeRegion = MAJOR_TITLES[titleKey]?.region || null;
  const regionalNeed = officeRegion === 'sea' ? AI_NUM.N_0_42 : AI_NUM.N_0_58;
  return (
    (inferredHolderProfile.weights.frontier * AI_NUM.N_0_46) +
    (inferredHolderProfile.weights.loyalty * AI_NUM.N_0_22) +
    (inferredHolderProfile.weights.mercenary * AI_NUM.N_0_14) +
    frontierCommitment +
    capitalCommitment +
    (regionalStake * regionalNeed)
  );
}

function buildTitleAssignmentFeatureCache(state, meta, newBasileusId) {
  const holderCache = new Map();
  const roleFitCache = new Map();
  for (const player of state.players) {
    const holderId = player.id;
    const orders = state.allOrders?.[holderId] || null;
    const totals = orders ? computeOrderTotals(state, holderId, orders) : { capital: AI_NUM.N_0, frontier: AI_NUM.N_0 };
    const standing = getStandingSnapshot(state, meta, holderId);
    holderCache.set(holderId, {
      orders,
      totals,
      standing,
      loyalty: getAffinityScore(meta, newBasileusId, holderId),
      competence: getCompetenceScore(state, meta, holderId),
      obligation: getObligation(meta, newBasileusId, holderId),
      supported: orders?.candidate === newBasileusId && holderId !== newBasileusId,
      opposed: orders?.candidate != null && orders.candidate !== newBasileusId,
      selfClaim: orders?.candidate === holderId && holderId !== newBasileusId,
    });
    for (const titleKey of MAJOR_TITLE_KEYS) {
      roleFitCache.set(
        `${holderId}:${titleKey}`,
        getTitleRoleFitScore(state, meta, newBasileusId, holderId, titleKey, orders, totals),
      );
    }
  }
  return { holderCache, roleFitCache };
}

function buildTitleAssignmentPolicyFeatures(state, meta, newBasileusId, assignment, previousHolders, cache = null) {
  let relationTotal = AI_NUM.N_0;
  let titleContinuity = AI_NUM.N_0;
  let supporterReward = AI_NUM.N_0;
  let rivalSuppression = AI_NUM.N_0;
  let roleFit = AI_NUM.N_0;
  let obligationPayoff = AI_NUM.N_0;
  let militaryCompetence = AI_NUM.N_0;
  let politicalRisk = AI_NUM.N_0;
  for (const titleKey of MAJOR_TITLE_KEYS) {
    const holderId = assignment[titleKey];
    const holder = cache?.holderCache.get(holderId) || {};
    const orders = holder.orders || state.allOrders?.[holderId] || null;
    const totals = holder.totals || { capital: AI_NUM.N_0, frontier: AI_NUM.N_0 };
    const standing = holder.standing || getStandingSnapshot(state, meta, holderId);
    const supported = holder.supported ?? (orders?.candidate === newBasileusId && holderId !== newBasileusId);
    const opposed = holder.opposed ?? (orders?.candidate != null && orders.candidate !== newBasileusId);
    const selfClaim = holder.selfClaim ?? (orders?.candidate === holderId && holderId !== newBasileusId);
    relationTotal += holder.loyalty ?? getAffinityScore(meta, newBasileusId, holderId);
    militaryCompetence += holder.competence ?? getCompetenceScore(state, meta, holderId);
    roleFit += cache?.roleFitCache.get(`${holderId}:${titleKey}`) ?? getTitleRoleFitScore(state, meta, newBasileusId, holderId, titleKey, orders, totals);
    if (previousHolders[titleKey] === holderId) titleContinuity += AI_NUM.N_1;
    if (supported) supporterReward += AI_NUM.N_1 + (totals.capital * AI_NUM.N_0_16) + (totals.frontier * AI_NUM.N_0_08);
    obligationPayoff += holder.obligation ?? getObligation(meta, newBasileusId, holderId);
    if (opposed) rivalSuppression += AI_NUM.N_1 + (selfClaim ? AI_NUM.N_0_45 : AI_NUM.N_0) + (totals.capital * AI_NUM.N_0_1);
    if (standing.rank === AI_NUM.N_1 && holderId !== newBasileusId) politicalRisk += AI_NUM.N_1 + Math.max(AI_NUM.N_0, standing.leadOverNextBehind) * AI_NUM.N_0_05;
  }
  return {
    relation: relationTotal / Math.max(AI_NUM.N_1, MAJOR_TITLE_KEYS.length),
    titleContinuity,
    supporterReward,
    rivalSuppression,
    roleFit,
    obligationPayoff,
    militaryCompetence,
    political: AI_NUM.N_1,
    denial: rivalSuppression,
    risk: politicalRisk,
    politicalDenial: rivalSuppression,
  };
}

export function collectAITitleAssignmentOptions(state, meta, newBasileusId) {
  return withPolicyNumericTuning(meta, newBasileusId, () => {
  const previousHolders = {};
  for (const titleKey of MAJOR_TITLE_KEYS) {
    previousHolders[titleKey] = state.players.find(player => player.majorTitles.includes(titleKey))?.id ?? null;
  }
  const featureCache = buildTitleAssignmentFeatureCache(state, meta, newBasileusId);
  const limit = getPolicyLimit(meta, newBasileusId, 'titleAssignmentLimit', TITLE_ASSIGNMENT_HARD_LIMIT);
  return enumerateTitleAssignments(state, newBasileusId)
    .slice(AI_NUM.N_0, TITLE_ASSIGNMENT_HARD_LIMIT)
    .map((assignment) => makePolicyAction(
      state,
      meta,
      newBasileusId,
      AI_ACTION_KINDS.TITLE_ASSIGNMENT,
      AI_ACTION_PHASES.RESOLUTION,
      AI_NUM.N_0,
      {
        payload: { assignment },
        beneficiaries: Object.values(assignment).map(Number),
        timing: 'future',
        reversibility: 'low',
      },
      null,
      buildTitleAssignmentPolicyFeatures(state, meta, newBasileusId, assignment, previousHolders, featureCache),
    ))
    .sort((left, right) => right.policyScore - left.policyScore)
    .slice(AI_NUM.N_0, limit)
    .map(option => ({ ...option, previousHolders }));
  });
}

export function planMajorTitleAssignment(state, meta, newBasileusId) {
  return withPolicyNumericTuning(meta, newBasileusId, () => {
  const options = collectAITitleAssignmentOptions(state, meta, newBasileusId);
  const picked = selectPolicyOption(state, meta, newBasileusId, options);
  const previousHolders = picked?.previousHolders || Object.fromEntries(MAJOR_TITLE_KEYS.map((titleKey) => [
    titleKey,
    state.players.find(player => player.majorTitles.includes(titleKey))?.id ?? null,
  ]));
  return {
    previousHolders,
    best: picked ? {
      assignment: picked.descriptor.payload.assignment,
      score: picked.policyScore,
    } : null,
  };
  });
}

function applyMajorTitleAssignment(state, meta, newBasileusId, plan) {
  if (!plan?.best) return null;
  const result = applyCoupTitleReassignment(state, newBasileusId, plan.best.assignment);
  meta.players[newBasileusId].stats.throneCaptures++;
  meta.totals.throneChanges++;
  let titleShuffles = AI_NUM.N_0;
  let supporterTitleRewards = AI_NUM.N_0;
  let rivalOfficeDenials = AI_NUM.N_0;

  for (const [titleKey, holderId] of Object.entries(plan.best.assignment)) {
    adjustRelation(meta, holderId, newBasileusId, AI_NUM.N_1, AI_NUM.N_0);
    adjustRelation(meta, newBasileusId, holderId, AI_NUM.N_0_35, AI_NUM.N_0);
    reduceObligation(meta, newBasileusId, holderId, AI_NUM.N_1);
    if (state.allOrders?.[holderId]?.candidate === newBasileusId && holderId !== newBasileusId) {
      supporterTitleRewards++;
    }
    const previousHolderId = plan.previousHolders[titleKey];
    if (previousHolderId != null && previousHolderId !== holderId) {
      titleShuffles++;
      if (state.allOrders?.[previousHolderId]?.candidate != null && state.allOrders[previousHolderId].candidate !== newBasileusId) {
        rivalOfficeDenials++;
      }
      adjustRelation(meta, previousHolderId, newBasileusId, AI_NUM.N_0, AI_NUM.N_0_85);
    }
  }
  const stats = meta.players[newBasileusId].stats;
  stats.titleShuffles = (stats.titleShuffles || AI_NUM.N_0) + titleShuffles;
  stats.supporterTitleRewards = (stats.supporterTitleRewards || AI_NUM.N_0) + supporterTitleRewards;
  stats.rivalOfficeDenials = (stats.rivalOfficeDenials || AI_NUM.N_0) + rivalOfficeDenials;
  meta.totals.titleShuffles = (meta.totals.titleShuffles || AI_NUM.N_0) + titleShuffles;
  meta.totals.supporterTitleRewards = (meta.totals.supporterTitleRewards || AI_NUM.N_0) + supporterTitleRewards;
  meta.totals.rivalOfficeDenials = (meta.totals.rivalOfficeDenials || AI_NUM.N_0) + rivalOfficeDenials;

  rememberSystemicDecision(
    state,
    meta,
    newBasileusId,
    {
      kind: AI_ACTION_KINDS.TITLE_ASSIGNMENT,
      phase: AI_ACTION_PHASES.RESOLUTION,
      payload: { assignment: plan.best.assignment },
      beneficiaries: Object.values(plan.best.assignment).map(Number),
      timing: 'future',
      reversibility: 'low',
    },
    plan.best.score || AI_NUM.N_0,
    AI_ACTION_PHASES.RESOLUTION,
  );
  applyDecisionToResult(state, result, buildTitleAssignmentDecision(state, meta, newBasileusId, plan));
  logDecision(meta, `Round ${state.round} resolution: ${describeActor(state, meta, newBasileusId)} captures the throne and redistributes the four major offices.`);
  logPublic(meta, `${publicActor(state, newBasileusId)} captures the throne and redistributes the major offices.`);
  return plan.best.assignment;
}

// AI deal policy. The game emits legal deal options; the evolved court policy
// decides whether to accept, counter, refuse, or propose.

function ensureDealBudget(state, meta, playerId) {
  const playerMeta = meta.players[playerId];
  if (!playerMeta.dealBudget) {
    playerMeta.dealBudget = { round: -AI_NUM.N_1, proposals: AI_NUM.N_0, proposalSearches: AI_NUM.N_0, proposalOptions: null, proposalFingerprint: null };
  }
  if (playerMeta.dealBudget.round !== state.round) {
    playerMeta.dealBudget.round = state.round;
    playerMeta.dealBudget.proposals = AI_NUM.N_0;
    playerMeta.dealBudget.proposalSearches = AI_NUM.N_0;
    playerMeta.dealBudget.proposalOptions = null;
    playerMeta.dealBudget.proposalFingerprint = null;
  }
  return playerMeta.dealBudget;
}

function getDealTriggerVariants(state, playerId, counterpartyId, rawClause) {
  const variants = [{ ...rawClause, startTriggerType: DEAL_TRIGGER_TYPES.IMMEDIATE }];
  if (playerId !== state.basileusId) {
    variants.push({
      ...rawClause,
      startTriggerType: DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS,
      triggerPlayerId: playerId,
    });
  }
  if (counterpartyId !== state.basileusId) {
    variants.push({
      ...rawClause,
      startTriggerType: DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS,
      triggerPlayerId: counterpartyId,
    });
  }
  return variants;
}

function getBestTradeableTheme(state, ownerId, scorer) {
  return getPlayerThemes(state, ownerId)
    .filter((theme) => !theme.occupied && theme.owner === ownerId)
    .map((theme) => ({ theme, score: scorer(theme) }))
    .sort((left, right) => right.score - left.score)[AI_NUM.N_0]?.theme || null;
}

function getDealThemeValue(state, meta, viewerId, themeId) {
  const theme = state.themes?.[themeId];
  if (!theme) return AI_NUM.N_0;
  const remainingRounds = Math.max(AI_NUM.N_1, getRemainingRounds(state));
  const routeRisk = getThemeRouteRisk(state, theme.id);
  const income = getThemeOwnerIncome(theme) * Math.min(AI_NUM.N_4, remainingRounds) * AI_NUM.N_0_55;
  return income + (getThemeStrategicValue(theme) * AI_NUM.N_0_18) - (routeRisk * getEmpireDanger(state, meta) * AI_NUM.N_0_65);
}

function scoreDealClauseForViewer(state, meta, viewerId, clause) {
  const profile = getPersonalityProfile(meta, viewerId);
  const youGive = Number(clause.giverId) === Number(viewerId);
  const youReceive = Number(clause.receiverId) === Number(viewerId);
  if (!youGive && !youReceive) return AI_NUM.N_0;

  let value = AI_NUM.N_0;
  if (clause.kind === DEAL_CLAUSE_KINDS.GOLD) {
    value = (Number(clause.payload?.totalAmount) || AI_NUM.N_0) * (AI_NUM.N_0_28 + profile.weights.wealth * AI_NUM.N_0_035);
  } else if (clause.kind === DEAL_CLAUSE_KINDS.ESTATE) {
    value = getDealThemeValue(state, meta, viewerId, clause.payload?.themeId);
  } else if (clause.kind === DEAL_CLAUSE_KINDS.COUP_SUPPORT) {
    const troops = Number(clause.payload?.troopCount) || AI_NUM.N_0;
    const candidateId = Number(clause.payload?.candidateId);
    const candidateScore = scoreCandidateBase(state, meta, viewerId, candidateId);
    value = troops * (AI_NUM.N_0_75 + profile.weights.capital * AI_NUM.N_0_16 + profile.weights.throne * AI_NUM.N_0_14 + Math.max(AI_NUM.N_0, candidateScore) * AI_NUM.N_0_04);
  } else if (clause.kind === DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT) {
    const troops = Number(clause.payload?.troopCount) || AI_NUM.N_0;
    value = troops * (AI_NUM.N_0_72 + profile.weights.frontier * AI_NUM.N_0_18 + getEmpireDanger(state, meta) * AI_NUM.N_0_45);
  } else if (clause.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE) {
    const count = Number(clause.payload?.appointmentCount) || AI_NUM.N_0;
    const giverInfluence = getPlayerInfluence(state, meta, clause.giverId);
    const titleNeed = Math.max(AI_NUM.N_0_4, AI_NUM.N_2_4 - getMinorTitleCount(state, viewerId) * AI_NUM.N_0_35 - getPlayer(state, viewerId).majorTitles.length * AI_NUM.N_0_55);
    value = count * (AI_NUM.N_0_95 + titleNeed + giverInfluence * AI_NUM.N_0_08);
  } else if (clause.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION) {
    const turns = Number(clause.durationTurns) || AI_NUM.N_1;
    const giverThreat = clause.giverId === state.basileusId ? AI_NUM.N_1_2 : AI_NUM.N_0_45;
    value = turns * (AI_NUM.N_0_65 + giverThreat + profile.weights.revocation * AI_NUM.N_0_08);
  }

  if (clause.startTrigger?.type === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS) {
    const triggerPlayerId = Number(clause.startTrigger.playerId);
    const triggerPressure = triggerPlayerId === state.basileusId
      ? AI_NUM.N_1
      : clamp(scoreCandidateBase(state, meta, triggerPlayerId, triggerPlayerId) / AI_NUM.N_8, AI_NUM.N_0_2, AI_NUM.N_0_85);
    value *= triggerPressure;
  }

  return youReceive ? value : -value * (AI_NUM.N_1_05 - Math.min(AI_NUM.N_0_35, getMetaForPlayer(meta, viewerId, 'dealRiskTolerance') * AI_NUM.N_0_18));
}

function scoreDealClausesForViewer(state, meta, viewerId, clauses = []) {
  const counterpartyIds = new Set();
  let score = AI_NUM.N_0;
  for (const clause of clauses) {
    score += scoreDealClauseForViewer(state, meta, viewerId, clause);
    if (Number(clause.giverId) !== Number(viewerId)) counterpartyIds.add(clause.giverId);
    if (Number(clause.receiverId) !== Number(viewerId)) counterpartyIds.add(clause.receiverId);
  }
  for (const counterpartyId of counterpartyIds) {
    score += getAffinityScore(meta, viewerId, Number(counterpartyId)) * AI_NUM.N_0_18;
    score += getObligation(meta, Number(counterpartyId), viewerId) * AI_NUM.N_0_12;
  }
  return score;
}

function makeScorableDealClause(playerId, counterpartyId, rawClause) {
  const giverId = rawClause.direction === 'ask' ? counterpartyId : playerId;
  const receiverId = rawClause.direction === 'ask' ? playerId : counterpartyId;
  const startTrigger = rawClause.startTriggerType === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS
    ? { type: DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS, playerId: Number(rawClause.triggerPlayerId) }
    : { type: DEAL_TRIGGER_TYPES.IMMEDIATE };

  const clause = {
    kind: rawClause.kind,
    giverId,
    receiverId,
    startTrigger,
    durationTurns: Number(rawClause.durationTurns) || null,
    payload: {},
  };

  if (rawClause.kind === DEAL_CLAUSE_KINDS.GOLD) {
    clause.payload.totalAmount = Number(rawClause.amount) || AI_NUM.N_0;
  } else if (rawClause.kind === DEAL_CLAUSE_KINDS.ESTATE) {
    clause.payload.themeId = rawClause.themeId;
  } else if (rawClause.kind === DEAL_CLAUSE_KINDS.COUP_SUPPORT) {
    clause.payload.candidateId = Number(rawClause.candidateId);
    clause.payload.troopCount = Number(rawClause.troopCount) || AI_NUM.N_0;
  } else if (rawClause.kind === DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT) {
    clause.payload.troopCount = Number(rawClause.troopCount) || AI_NUM.N_0;
  } else if (rawClause.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE) {
    clause.payload.appointmentCount = Number(rawClause.appointmentCount) || AI_NUM.N_0;
  }

  return clause;
}

function getDealTemplateFamilyKey(rawClause) {
  const trigger = rawClause.startTriggerType === DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS
    ? `${DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS}:${rawClause.triggerPlayerId}`
    : DEAL_TRIGGER_TYPES.IMMEDIATE;
  return `${rawClause.kind}:${rawClause.direction}:${trigger}`;
}

function rankDealTemplates(state, meta, playerId, counterpartyId, clauses) {
  return clauses.map((clause, index) => {
    const scorable = makeScorableDealClause(playerId, counterpartyId, clause);
    const actorUtility = scoreDealClauseForViewer(state, meta, playerId, scorable);
    const counterpartyUtility = scoreDealClauseForViewer(state, meta, counterpartyId, scorable);
    return {
      clause,
      index,
      familyKey: getDealTemplateFamilyKey(clause),
      actorUtility,
      counterpartyUtility,
      cooperativeScore: actorUtility + Math.max(AI_NUM.N_0, counterpartyUtility * AI_NUM.N_0_65),
    };
  });
}

function selectRankedDealTemplates(ranked, limit, compare) {
  const sorted = ranked.slice().sort(compare);
  const selected = [];
  const selectedIndexes = new Set();
  const familySeen = new Set();

  for (const entry of sorted) {
    if (familySeen.has(entry.familyKey)) continue;
    selected.push(entry);
    selectedIndexes.add(entry.index);
    familySeen.add(entry.familyKey);
    if (selected.length >= limit) break;
  }

  for (const entry of sorted) {
    if (selected.length >= limit) break;
    if (selectedIndexes.has(entry.index)) continue;
    selected.push(entry);
    selectedIndexes.add(entry.index);
  }

  return selected.map((entry) => entry.clause);
}

function buildSingleDealClauseTemplates(state, meta, playerId, counterpartyId) {
  const clauses = [];
  const player = getPlayer(state, playerId);
  const counterparty = getPlayer(state, counterpartyId);
  const context = ensureRoundContext(state, meta, 'court');
  const playerPact = context.pactByPlayer[playerId];
  const counterpartyPact = context.pactByPlayer[counterpartyId];
  const playerCandidateId = playerPact?.candidateId ?? state.basileusId;
  const counterpartyCandidateId = counterpartyPact?.candidateId ?? counterpartyId;
  const playerGold = Math.max(AI_NUM.N_0, getSpendableGold(state, playerId));
  const counterpartyGold = Math.max(AI_NUM.N_0, getSpendableGold(state, counterpartyId));

  const pushVariants = (rawClause) => {
    for (const variant of getDealTriggerVariants(state, playerId, counterpartyId, rawClause)) {
      clauses.push(variant);
    }
  };

  if (counterpartyGold > AI_NUM.N_0) {
    pushVariants({ kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'ask', amount: Math.min(AI_NUM.N_3, counterpartyGold), durationTurns: AI_NUM.N_1 });
  }
  if (playerGold > AI_NUM.N_0) {
    pushVariants({ kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'give', amount: Math.min(AI_NUM.N_3, playerGold), durationTurns: AI_NUM.N_1 });
  }
  if (counterpartyGold >= AI_NUM.N_2) {
    pushVariants({ kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'ask', amount: Math.min(AI_NUM.N_4, counterpartyGold), durationTurns: AI_NUM.N_2 });
  }
  if (playerGold >= AI_NUM.N_2) {
    pushVariants({ kind: DEAL_CLAUSE_KINDS.GOLD, direction: 'give', amount: Math.min(AI_NUM.N_4, playerGold), durationTurns: AI_NUM.N_2 });
  }

  const askEstate = getBestTradeableTheme(state, counterpartyId, (theme) => getDealThemeValue(state, meta, playerId, theme.id));
  if (askEstate) pushVariants({ kind: DEAL_CLAUSE_KINDS.ESTATE, direction: 'ask', themeId: askEstate.id });
  const giveEstate = getBestTradeableTheme(state, playerId, (theme) => -getDealThemeValue(state, meta, playerId, theme.id));
  if (giveEstate) pushVariants({ kind: DEAL_CLAUSE_KINDS.ESTATE, direction: 'give', themeId: giveEstate.id });

  pushVariants({ kind: DEAL_CLAUSE_KINDS.COUP_SUPPORT, direction: 'ask', candidateId: playerCandidateId, troopCount: AI_NUM.N_1, durationTurns: AI_NUM.N_1 });
  pushVariants({ kind: DEAL_CLAUSE_KINDS.COUP_SUPPORT, direction: 'give', candidateId: counterpartyCandidateId, troopCount: AI_NUM.N_1, durationTurns: AI_NUM.N_1 });
  pushVariants({ kind: DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, direction: 'ask', troopCount: AI_NUM.N_1, durationTurns: AI_NUM.N_1 });
  pushVariants({ kind: DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, direction: 'give', troopCount: AI_NUM.N_1, durationTurns: AI_NUM.N_1 });
  pushVariants({ kind: DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE, direction: 'ask', appointmentCount: AI_NUM.N_1 });
  pushVariants({ kind: DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE, direction: 'give', appointmentCount: AI_NUM.N_1 });
  pushVariants({ kind: DEAL_CLAUSE_KINDS.NON_REVOCATION, direction: 'ask', durationTurns: AI_NUM.N_1 });
  pushVariants({ kind: DEAL_CLAUSE_KINDS.NON_REVOCATION, direction: 'give', durationTurns: AI_NUM.N_1 });
  if (state.round < state.maxRounds) {
    pushVariants({ kind: DEAL_CLAUSE_KINDS.NON_REVOCATION, direction: 'ask', durationTurns: AI_NUM.N_2 });
    pushVariants({ kind: DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, direction: 'ask', troopCount: AI_NUM.N_1, durationTurns: AI_NUM.N_2 });
  }

  return clauses.filter((clause) => {
    if (clause.direction === 'give' && !player) return false;
    if (clause.direction === 'ask' && !counterparty) return false;
    return true;
  });
}

function makeDealPayload(intent, clauses) {
  return { intent, clauses: clauses.filter(Boolean) };
}

function getDealPayloadClauses(payload) {
  return Array.isArray(payload) ? payload : (Array.isArray(payload?.clauses) ? payload.clauses : []);
}

function getDealPayloadIntent(payload, clauses, playerId, counterpartyId) {
  return Array.isArray(payload) || !payload?.intent
    ? inferDealIntent(clauses, playerId, counterpartyId)
    : payload.intent;
}

function rawDealClause(kind, direction, payload = {}) {
  return { kind, direction, durationTurns: AI_NUM.N_1, ...payload };
}

function triggeredDealClause(state, rawClause, triggerPlayerId) {
  if (triggerPlayerId == null || Number(triggerPlayerId) === Number(state.basileusId)) return rawClause;
  return {
    ...rawClause,
    startTriggerType: DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS,
    triggerPlayerId: Number(triggerPlayerId),
  };
}

function inferDealIntent(clauses = [], playerId = null, counterpartyId = null) {
  const kinds = new Set(clauses.map((clause) => clause.kind));
  const coupClauses = clauses.filter((clause) => clause.kind === DEAL_CLAUSE_KINDS.COUP_SUPPORT);
  const coupCandidates = new Set(coupClauses.map((clause) => Number(clause.payload?.candidateId ?? clause.candidateId)).filter(Number.isInteger));
  const reciprocalCoup = playerId != null && counterpartyId != null && coupClauses.some((clause) => Number(clause.giverId) === Number(playerId)) && coupClauses.some((clause) => Number(clause.giverId) === Number(counterpartyId));

  if (kinds.has(DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT) && kinds.has(DEAL_CLAUSE_KINDS.COUP_SUPPORT)) {
    return DEAL_INTENTS.SPLIT_FRONTIER_DEFENSE;
  }
  if (kinds.has(DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE) && kinds.has(DEAL_CLAUSE_KINDS.COUP_SUPPORT)) {
    return DEAL_INTENTS.SUPPORT_FOR_REWARD;
  }
  if (kinds.has(DEAL_CLAUSE_KINDS.NON_REVOCATION) && kinds.has(DEAL_CLAUSE_KINDS.COUP_SUPPORT)) {
    return DEAL_INTENTS.PROTECTION_FOR_SUPPORT;
  }
  if (kinds.has(DEAL_CLAUSE_KINDS.ESTATE)) return DEAL_INTENTS.ESTATE_TRADE;
  if (kinds.has(DEAL_CLAUSE_KINDS.GOLD) && kinds.size > AI_NUM.N_1) return DEAL_INTENTS.GOLD_MAKEWEIGHT;
  if (reciprocalCoup || (coupClauses.length >= AI_NUM.N_2 && coupCandidates.size === AI_NUM.N_1)) {
    return DEAL_INTENTS.COALITION_COORDINATION;
  }
  return clauses.length > AI_NUM.N_1 ? DEAL_INTENTS.GENERIC_EXCHANGE : DEAL_INTENTS.GENERIC;
}

function chooseCoordinationCandidates(state, meta, playerId, counterpartyId) {
  const context = ensureRoundContext(state, meta, 'court');
  const playerCandidateId = context.pactByPlayer[playerId]?.candidateId ?? state.basileusId;
  const counterpartyCandidateId = context.pactByPlayer[counterpartyId]?.candidateId ?? state.basileusId;
  return uniqueList([
    playerCandidateId,
    counterpartyCandidateId,
    context.strongestChallengerId,
    state.basileusId,
  ]).filter(candidateId => candidateId != null && state.players.some(player => player.id === Number(candidateId)));
}

function buildIntentDealPayloads(state, meta, playerId, counterpartyId) {
  const payloads = [];
  const context = ensureRoundContext(state, meta, 'court');
  const playerPact = context.pactByPlayer[playerId];
  const counterpartyPact = context.pactByPlayer[counterpartyId];
  const playerCandidateId = playerPact?.candidateId ?? state.basileusId;
  const counterpartyCandidateId = counterpartyPact?.candidateId ?? state.basileusId;
  const playerGold = Math.max(AI_NUM.N_0, getSpendableGold(state, playerId));
  const counterpartyGold = Math.max(AI_NUM.N_0, getSpendableGold(state, counterpartyId));
  const danger = getEmpireDanger(state, meta);
  const candidates = chooseCoordinationCandidates(state, meta, playerId, counterpartyId);
  const push = (intent, clauses) => {
    if (clauses?.length) payloads.push(makeDealPayload(intent, clauses));
  };

  for (const candidateId of candidates.slice(AI_NUM.N_0, AI_NUM.N_3)) {
    push(DEAL_INTENTS.COALITION_COORDINATION, [
      rawDealClause(DEAL_CLAUSE_KINDS.COUP_SUPPORT, 'ask', { candidateId, troopCount: AI_NUM.N_1 }),
      rawDealClause(DEAL_CLAUSE_KINDS.COUP_SUPPORT, 'give', { candidateId, troopCount: AI_NUM.N_1 }),
    ]);
    if (playerCandidateId !== counterpartyCandidateId) {
      push(DEAL_INTENTS.COALITION_COORDINATION, [
        rawDealClause(DEAL_CLAUSE_KINDS.COUP_SUPPORT, 'ask', { candidateId, troopCount: AI_NUM.N_1 }),
        playerGold > AI_NUM.N_0 ? rawDealClause(DEAL_CLAUSE_KINDS.GOLD, 'give', { amount: Math.min(AI_NUM.N_2, playerGold), durationTurns: AI_NUM.N_1 }) : null,
      ].filter(Boolean));
    }
  }

  if (danger >= AI_NUM.N_0_45) {
    const sharedCandidateId = candidates[AI_NUM.N_0] ?? state.basileusId;
    push(DEAL_INTENTS.SPLIT_FRONTIER_DEFENSE, [
      rawDealClause(DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, 'ask', { troopCount: AI_NUM.N_1 }),
      rawDealClause(DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, 'give', { troopCount: AI_NUM.N_1 }),
    ]);
    push(DEAL_INTENTS.SPLIT_FRONTIER_DEFENSE, [
      rawDealClause(DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, 'ask', { troopCount: AI_NUM.N_1 }),
      rawDealClause(DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, 'give', { troopCount: AI_NUM.N_1 }),
      rawDealClause(DEAL_CLAUSE_KINDS.COUP_SUPPORT, 'ask', { candidateId: sharedCandidateId, troopCount: AI_NUM.N_1 }),
      rawDealClause(DEAL_CLAUSE_KINDS.COUP_SUPPORT, 'give', { candidateId: sharedCandidateId, troopCount: AI_NUM.N_1 }),
    ]);
  }

  if (counterpartyId !== state.basileusId) {
    push(DEAL_INTENTS.SUPPORT_FOR_REWARD, [
      rawDealClause(DEAL_CLAUSE_KINDS.COUP_SUPPORT, 'give', { candidateId: counterpartyId, troopCount: AI_NUM.N_1 }),
      triggeredDealClause(state, rawDealClause(DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE, 'ask', { appointmentCount: AI_NUM.N_1 }), counterpartyId),
    ]);
    push(DEAL_INTENTS.PROTECTION_FOR_SUPPORT, [
      rawDealClause(DEAL_CLAUSE_KINDS.COUP_SUPPORT, 'give', { candidateId: counterpartyId, troopCount: AI_NUM.N_1 }),
      rawDealClause(DEAL_CLAUSE_KINDS.NON_REVOCATION, 'ask', { durationTurns: AI_NUM.N_2 }),
    ]);
  }

  if (playerId === state.basileusId || playerPact?.candidateId === playerId) {
    push(DEAL_INTENTS.PROTECTION_FOR_SUPPORT, [
      rawDealClause(DEAL_CLAUSE_KINDS.COUP_SUPPORT, 'ask', { candidateId: playerCandidateId, troopCount: AI_NUM.N_1 }),
      rawDealClause(DEAL_CLAUSE_KINDS.NON_REVOCATION, 'give', { durationTurns: AI_NUM.N_1 }),
    ]);
  }

  const askEstate = getBestTradeableTheme(state, counterpartyId, (theme) => getDealThemeValue(state, meta, playerId, theme.id));
  if (askEstate && playerGold > AI_NUM.N_0) {
    push(DEAL_INTENTS.ESTATE_TRADE, [
      rawDealClause(DEAL_CLAUSE_KINDS.ESTATE, 'ask', { themeId: askEstate.id }),
      rawDealClause(DEAL_CLAUSE_KINDS.GOLD, 'give', { amount: Math.min(AI_NUM.N_4, playerGold), durationTurns: Math.min(AI_NUM.N_2, playerGold) }),
    ]);
  }

  if (counterpartyGold > AI_NUM.N_0) {
    push(DEAL_INTENTS.GOLD_MAKEWEIGHT, [
      rawDealClause(DEAL_CLAUSE_KINDS.COUP_SUPPORT, 'give', { candidateId: counterpartyCandidateId, troopCount: AI_NUM.N_1 }),
      rawDealClause(DEAL_CLAUSE_KINDS.GOLD, 'ask', { amount: Math.min(AI_NUM.N_2, counterpartyGold), durationTurns: AI_NUM.N_1 }),
    ]);
  }
  if (playerGold > AI_NUM.N_0) {
    push(DEAL_INTENTS.GOLD_MAKEWEIGHT, [
      rawDealClause(DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT, 'ask', { troopCount: AI_NUM.N_1 }),
      rawDealClause(DEAL_CLAUSE_KINDS.GOLD, 'give', { amount: Math.min(AI_NUM.N_2, playerGold), durationTurns: AI_NUM.N_1 }),
    ]);
  }

  return payloads.slice(AI_NUM.N_0, getPolicyLimit(meta, playerId, 'dealIntentPayloadLimit', DEAL_INTENT_PAYLOAD_HARD_LIMIT));
}

function scoreDealStrategicOutcomeForViewer(state, meta, viewerId, counterpartyId, clauses = [], intent = null) {
  const profile = getPersonalityProfile(meta, viewerId);
  const policy = getPolicyForPlayer(meta, viewerId);
  const strategicWeights = policy.dealStrategicWeights || {};
  const weight = (key) => Number(strategicWeights[key]) || AI_NUM.N_0;
  const context = ensureRoundContext(state, meta, 'court');
  const pact = context.pactByPlayer[viewerId];
  const preferredCandidateId = pact?.candidateId ?? state.basileusId;
  const coordinationWeight = AI_NUM.N_1;
  const reciprocityWeight = AI_NUM.N_1;
  const danger = getEmpireDanger(state, meta);
  const coupClauses = clauses.filter((clause) => clause.kind === DEAL_CLAUSE_KINDS.COUP_SUPPORT);
  const frontierClauses = clauses.filter((clause) => clause.kind === DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT);
  let score = AI_NUM.N_0;

  if (intent === DEAL_INTENTS.COALITION_COORDINATION || intent === DEAL_INTENTS.SPLIT_FRONTIER_DEFENSE) {
    const candidateIds = uniqueList(coupClauses.map(clause => Number(clause.payload?.candidateId)).filter(Number.isInteger));
    const sharedCandidateId = candidateIds.length === AI_NUM.N_1 ? candidateIds[AI_NUM.N_0] : null;
    if (sharedCandidateId != null) {
      const candidateSignal = context.supportSignal?.[sharedCandidateId] || AI_NUM.N_0;
      const incumbentSignal = context.supportSignal?.[state.basileusId] || AI_NUM.N_0;
      const marginalNeed = sharedCandidateId === state.basileusId
        ? Math.max(AI_NUM.N_0, context.strongestChallengerSignal - incumbentSignal)
        : Math.max(AI_NUM.N_0, incumbentSignal - candidateSignal + AI_NUM.N_1_5);
      score += weight('coordination') * coordinationWeight * (AI_NUM.N_0_35 + Math.min(AI_NUM.N_1_8, marginalNeed * AI_NUM.N_0_12));
      if (sharedCandidateId === preferredCandidateId) score += weight('coordination') * coordinationWeight * AI_NUM.N_0_75;
      if (sharedCandidateId !== viewerId && getStandingSnapshot(state, meta, sharedCandidateId).rank === AI_NUM.N_1) {
        score += weight('leaderPenalty') * (AI_NUM.N_0_45 + profile.weights.throne * AI_NUM.N_0_08);
      }
    }
    const givesCoup = coupClauses.some(clause => Number(clause.giverId) === Number(viewerId));
    const receivesCoup = coupClauses.some(clause => Number(clause.giverId) === Number(counterpartyId));
    if (givesCoup && receivesCoup) score += weight('reciprocity') * reciprocityWeight * AI_NUM.N_0_55;
  }

  if (intent === DEAL_INTENTS.SPLIT_FRONTIER_DEFENSE || frontierClauses.length) {
    const givesFrontier = frontierClauses.some(clause => Number(clause.giverId) === Number(viewerId));
    const receivesFrontier = frontierClauses.some(clause => Number(clause.giverId) === Number(counterpartyId));
    if (receivesFrontier) score += weight('frontier') * danger * (AI_NUM.N_0_5 + profile.weights.frontier * AI_NUM.N_0_08) * coordinationWeight;
    if (givesFrontier && receivesFrontier) score += weight('reciprocity') * reciprocityWeight * Math.max(AI_NUM.N_0_25, danger * AI_NUM.N_0_35);
    if (givesFrontier && danger < AI_NUM.N_0_35) score += weight('frontier') * -AI_NUM.N_0_35;
  }

  if (intent === DEAL_INTENTS.SUPPORT_FOR_REWARD || intent === DEAL_INTENTS.PROTECTION_FOR_SUPPORT) {
    const rewardClauses = clauses.filter(clause => (
      clause.kind === DEAL_CLAUSE_KINDS.APPOINTMENT_PROMISE
      || clause.kind === DEAL_CLAUSE_KINDS.NON_REVOCATION
      || clause.kind === DEAL_CLAUSE_KINDS.ESTATE
    ));
    if (rewardClauses.some(clause => Number(clause.receiverId) === Number(viewerId))) score += weight('reward') * (AI_NUM.N_0_45 + getCategoryThresholdPressure(state, meta, viewerId, 'tax') * AI_NUM.N_0_2);
    if (coupClauses.some(clause => Number(clause.giverId) === Number(viewerId) && Number(clause.payload?.candidateId) === preferredCandidateId)) score += weight('coordination') * coordinationWeight * AI_NUM.N_0_3;
  }

  if (intent === DEAL_INTENTS.GOLD_MAKEWEIGHT) {
    score += weight('goldMakeweight') * Math.min(AI_NUM.N_0_35, Math.abs(scoreDealClausesForViewer(state, meta, viewerId, clauses)) * AI_NUM.N_0_08);
  }

  return score;
}

function estimateSpeculativeDealPenalty(state, meta, viewerId, clauses = []) {
  let penalty = AI_NUM.N_0;
  for (const clause of clauses) {
    const trigger = clause.startTrigger;
    if (!trigger || trigger.type !== DEAL_TRIGGER_TYPES.WHEN_PLAYER_IS_BASILEUS) continue;
    const triggerPlayerId = Number(trigger.playerId);
    if (triggerPlayerId === state.basileusId) continue;
    const plausibility = clamp((scoreCandidateBase(state, meta, triggerPlayerId, triggerPlayerId) + AI_NUM.N_2) / AI_NUM.N_10, AI_NUM.N_0_08, AI_NUM.N_0_95);
    const viewerRelevant = Number(clause.giverId) === Number(viewerId) || Number(clause.receiverId) === Number(viewerId);
    if (viewerRelevant) penalty += (AI_NUM.N_1 - plausibility) * (AI_NUM.N_0_65 + Math.max(AI_NUM.N_0, -scoreDealClauseForViewer(state, meta, viewerId, clause)) * AI_NUM.N_0_12);
  }
  return penalty;
}

function scoreDealUtilityForViewer(state, meta, viewerId, counterpartyId, clauses = [], intent = null) {
  const policy = getPolicyForPlayer(meta, viewerId);
  const strategicWeights = policy.dealStrategicWeights || {};
  const strategic = scoreDealStrategicOutcomeForViewer(state, meta, viewerId, counterpartyId, clauses, intent);
  const baseScore = scoreDealClausesForViewer(state, meta, viewerId, clauses)
    + strategic
    + (Number(strategicWeights.speculationPenalty) || AI_NUM.N_0) * estimateSpeculativeDealPenalty(state, meta, viewerId, clauses);
  return applySystemicScore(
    state,
    meta,
    viewerId,
    {
      kind: AI_ACTION_KINDS.DEAL,
      phase: AI_ACTION_PHASES.COURT,
      payload: { counterpartyId, clauses, intent },
      targets: counterpartyId == null ? [] : [counterpartyId],
      timing: 'future',
      reversibility: 'low',
    },
    baseScore,
    AI_ACTION_PHASES.COURT,
  );
}

function buildDealCandidatePayloads(state, meta, playerId, counterpartyId) {
  const singles = buildSingleDealClauseTemplates(state, meta, playerId, counterpartyId);
  const ranked = rankDealTemplates(state, meta, playerId, counterpartyId, singles);
  const byCooperativeScore = (left, right) => (
    right.cooperativeScore - left.cooperativeScore
    || right.actorUtility - left.actorUtility
    || left.index - right.index
  );
  const byAskScore = (left, right) => (
    right.actorUtility - left.actorUtility
    || right.counterpartyUtility - left.counterpartyUtility
    || left.index - right.index
  );
  const byGiveScore = (left, right) => (
    right.counterpartyUtility - left.counterpartyUtility
    || right.actorUtility - left.actorUtility
    || left.index - right.index
  );
  const selectedSingles = selectRankedDealTemplates(ranked, getPolicyLimit(meta, playerId, 'dealSingleTemplateLimit', DEAL_SINGLE_PAYLOAD_HARD_LIMIT), byCooperativeScore);
  const asks = selectRankedDealTemplates(
    ranked.filter((entry) => entry.clause.direction === 'ask'),
    getPolicyLimit(meta, playerId, 'dealComboAskLimit', DEAL_COMBO_ASK_HARD_LIMIT),
    byAskScore,
  );
  const gives = selectRankedDealTemplates(
    ranked.filter((entry) => entry.clause.direction === 'give'),
    getPolicyLimit(meta, playerId, 'dealComboGiveLimit', DEAL_COMBO_GIVE_HARD_LIMIT),
    byGiveScore,
  );
  const payloads = [
    ...buildIntentDealPayloads(state, meta, playerId, counterpartyId),
    ...selectedSingles.map((clause) => makeDealPayload(DEAL_INTENTS.GENERIC, [clause])),
  ];

  for (const ask of asks) {
    for (const give of gives) {
      if (ask.kind === give.kind && ask.kind === DEAL_CLAUSE_KINDS.ESTATE) continue;
      payloads.push(makeDealPayload(inferDealIntent([ask, give], playerId, counterpartyId), [ask, give]));
    }
  }

  return payloads.slice(AI_NUM.N_0, getPolicyLimit(meta, playerId, 'dealTotalPayloadLimit', DEAL_TOTAL_PAYLOAD_HARD_LIMIT));
}

function evaluateDealPayload(state, meta, playerId, counterpartyId, payload, payloadBase = {}, searchCache = null) {
  const clauses = getDealPayloadClauses(payload);
  const preview = previewDealOffer(state, playerId, {
    ...payloadBase,
    counterpartyId,
    clauses,
  }, {
    mode: payloadBase.threadId ? 'counter' : 'send',
    troopPlanCache: searchCache?.troopPlanCache,
  });
  if (!preview.ok) return null;

  const intent = getDealPayloadIntent(payload, preview.clauses, playerId, counterpartyId);
  const actorUtility = scoreDealUtilityForViewer(state, meta, playerId, counterpartyId, preview.clauses, intent);
  const counterpartyUtility = scoreDealUtilityForViewer(state, meta, counterpartyId, playerId, preview.clauses, intent);
  const acceptanceFloor = getMetaForPlayer(meta, counterpartyId, 'dealCounterThreshold');
  const relation = getAffinityScore(meta, playerId, counterpartyId);
  const strategicBias = scoreDealStrategicOutcomeForViewer(state, meta, playerId, counterpartyId, preview.clauses, intent);
  const policy = getPolicyForPlayer(meta, playerId);
  const dealWeights = policy.dealScoreWeights || {};
  const counterpartySurplus = Math.min(counterpartyUtility - acceptanceFloor, policy.dealCounterpartySurplusCap);
  const score =
    actorUtility * (dealWeights.actorUtility || AI_NUM.N_0) +
    counterpartySurplus * (dealWeights.counterpartySurplus || AI_NUM.N_0) +
    strategicBias * (dealWeights.strategicBias || AI_NUM.N_0) +
    relation * (dealWeights.relation || AI_NUM.N_0) +
    Math.max(AI_NUM.N_0, -counterpartyUtility) * (dealWeights.counterpartyLoss || AI_NUM.N_0) +
    Math.max(AI_NUM.N_0, -actorUtility) * (dealWeights.actorLoss || AI_NUM.N_0);

  return {
    counterpartyId,
    clauses,
    normalizedClauses: preview.clauses,
    intent,
    actorUtility,
    counterpartyUtility,
    score,
  };
}

function buildDealProposalOptions(state, meta, playerId, payloadBase = {}, { counterpartyIds = null, limit = null } = {}) {
  const optionLimit = Math.min(
    limit ?? getPolicyLimit(meta, playerId, 'dealProposalOptionLimit', DEAL_PROPOSAL_OPTION_HARD_LIMIT),
    DEAL_PROPOSAL_OPTION_HARD_LIMIT,
  );
  const eligibleIds = (Array.isArray(counterpartyIds) && counterpartyIds.length
    ? counterpartyIds
    : state.players.map((player) => player.id)
  ).filter((id) => id !== playerId);
  const candidates = [];
  const searchCache = { troopPlanCache: new Map() };

  for (const counterpartyId of eligibleIds) {
    for (const payload of buildDealCandidatePayloads(state, meta, playerId, counterpartyId)) {
      const evaluated = evaluateDealPayload(state, meta, playerId, counterpartyId, payload, payloadBase, searchCache);
      if (evaluated) candidates.push(evaluated);
    }
  }

  return candidates.sort((left, right) => right.score - left.score).slice(AI_NUM.N_0, optionLimit);
}

function getDealProposalCacheFingerprint(state, playerId, payloadBase = {}, counterpartyIds = null, limit = null) {
  const incoming = getIncomingDealsForPlayer(state, playerId).map(thread => `${thread.id}:${thread.revision}`).join('|');
  const outgoing = getOutgoingDealsForPlayer(state, playerId).map(thread => `${thread.id}:${thread.revision}`).join('|');
  const counterparties = Array.isArray(counterpartyIds) ? counterpartyIds.join('|') : 'all';
  return [
    state.round,
    state.phase,
    playerId,
    getSpendableGold(state, playerId),
    payloadBase.threadId || '',
    payloadBase.expectedRevision ?? '',
    counterparties,
    limit ?? '',
    incoming,
    outgoing,
  ].join(';');
}

function buildDealCounterOptions(state, meta, playerId, thread) {
  const counterpartyId = getThreadCounterpartyId(thread, playerId);
  if (counterpartyId == null || Number(thread.revision) >= AI_NUM.N_3) return [];
  return buildDealProposalOptions(state, meta, playerId, {
    threadId: thread.id,
    expectedRevision: thread.revision,
  }, { counterpartyIds: [counterpartyId], limit: getPolicyLimit(meta, playerId, 'dealCounterOptionLimit', DEAL_COUNTER_OPTION_HARD_LIMIT) });
}

function getThreadCounterpartyId(thread, playerId) {
  return thread.playerIds.find((id) => Number(id) !== Number(playerId)) ?? null;
}

// Snapshot of the live deal context for one player. Designed as a feature
// vector: every value is either a small int or a normalized scalar so it
// can feed directly into a model without further wrangling.
export function getDealFeatureSnapshot(state, meta, playerId) {
  return withPolicyNumericTuning(meta, playerId, () => {
  const incoming = getIncomingDealsForPlayer(state, playerId).map((thread) => ({
    threadId: thread.id,
    counterpartyId: thread.playerIds.find((id) => id !== playerId) ?? null,
    revision: thread.revision,
    impact: summarizeDealOfferImpact(thread.currentOffer?.clauses || [], playerId),
  }));
  const outgoing = getOutgoingDealsForPlayer(state, playerId).map((thread) => ({
    threadId: thread.id,
    counterpartyId: thread.playerIds.find((id) => id !== playerId) ?? null,
    revision: thread.revision,
    impact: summarizeDealOfferImpact(thread.currentOffer?.clauses || [], playerId),
  }));
  return {
    playerId,
    round: state.round,
    isBasileus: playerId === state.basileusId,
    incoming,
    outgoing,
    activeObligations: (state.activeDealObligations || []).filter((entry) => (
      entry.status !== 'completed' && (entry.giverId === playerId || entry.receiverId === playerId)
    )).length,
  };
  });
}

// Hook for AI relation / posterior updates triggered by deal events. Currently
// a no-op; training can plug in here without touching the dispatch loop.
function incrementPlainCount(record, key, amount = AI_NUM.N_1) {
  if (!record || key == null) return;
  record[key] = (Number(record[key]) || AI_NUM.N_0) + amount;
}

function recordDealIntentStats(meta, actorStats, event, intent) {
  if (event.type === 'deal_propose') {
    if (!actorStats.proposedDealIntents) actorStats.proposedDealIntents = {};
    if (!meta.totals.proposedDealIntents) meta.totals.proposedDealIntents = {};
    incrementPlainCount(actorStats.proposedDealIntents, intent);
    incrementPlainCount(meta.totals.proposedDealIntents, intent);
  }
  if (event.type === 'deal_accept') {
    if (!actorStats.acceptedDealIntents) actorStats.acceptedDealIntents = {};
    if (!actorStats.acceptedDealClauseKinds) actorStats.acceptedDealClauseKinds = {};
    if (!meta.totals.acceptedDealIntents) meta.totals.acceptedDealIntents = {};
    if (!meta.totals.acceptedDealClauseKinds) meta.totals.acceptedDealClauseKinds = {};
    incrementPlainCount(actorStats.acceptedDealIntents, intent);
    incrementPlainCount(meta.totals.acceptedDealIntents, intent);
    for (const clause of event.clauses || []) {
      incrementPlainCount(actorStats.acceptedDealClauseKinds, clause.kind);
      incrementPlainCount(meta.totals.acceptedDealClauseKinds, clause.kind);
    }
  }
}

function recordCoordinationDealStats(meta, actorStats, event, intent) {
  if (event.type !== 'deal_accept') return;
  const clauses = event.clauses || [];
  const coupClauses = clauses.filter((clause) => clause.kind === DEAL_CLAUSE_KINDS.COUP_SUPPORT);
  const frontierClauses = clauses.filter((clause) => clause.kind === DEAL_CLAUSE_KINDS.FRONTIER_SUPPORT);
  const sharedCandidates = uniqueList(coupClauses.map(clause => Number(clause.payload?.candidateId)).filter(Number.isInteger));
  const multiGiverCoup = uniqueList(coupClauses.map(clause => Number(clause.giverId)).filter(Number.isInteger)).length >= AI_NUM.N_2;
  const coordinated = intent === DEAL_INTENTS.COALITION_COORDINATION
    || (sharedCandidates.length === AI_NUM.N_1 && (multiGiverCoup || coupClauses.length >= AI_NUM.N_2));
  const frontierCoordination = intent === DEAL_INTENTS.SPLIT_FRONTIER_DEFENSE
    || (frontierClauses.length > AI_NUM.N_0 && coupClauses.length > AI_NUM.N_0);

  if (coordinated) {
    actorStats.coordinatedClaimantDeals = (actorStats.coordinatedClaimantDeals || AI_NUM.N_0) + AI_NUM.N_1;
    meta.totals.coordinatedClaimantDeals = (meta.totals.coordinatedClaimantDeals || AI_NUM.N_0) + AI_NUM.N_1;
  }
  if (frontierCoordination) {
    actorStats.frontierCoordinationDeals = (actorStats.frontierCoordinationDeals || AI_NUM.N_0) + AI_NUM.N_1;
    meta.totals.frontierCoordinationDeals = (meta.totals.frontierCoordinationDeals || AI_NUM.N_0) + AI_NUM.N_1;
  }
}

export function observeDealEvent(state, meta, event) {
  return withPolicyNumericTuning(meta, event?.actorId, () => {
  if (!meta || !event) return;
  const actorStats = meta.players?.[event.actorId]?.stats;
  if (!actorStats) return;
  const utility = Number(event.actorUtility ?? event.utility ?? AI_NUM.N_0) || AI_NUM.N_0;
  const intent = event.intent || inferDealIntent(event.clauses || [], event.actorId, event.counterpartyId);
  recordDealIntentStats(meta, actorStats, event, intent);
  if (event.type === 'deal_propose') {
    actorStats.dealsProposed++;
    meta.totals.dealsProposed++;
  } else if (event.type === 'deal_counter') {
    actorStats.dealsCountered++;
    meta.totals.dealsCountered++;
  } else if (event.type === 'deal_accept') {
    actorStats.dealsAccepted++;
    actorStats.dealUtility += utility;
    meta.totals.dealsAccepted++;
    meta.totals.dealUtility += utility;
    if (utility < AI_NUM.N_0) {
      actorStats.badAcceptedDeals++;
      meta.totals.badAcceptedDeals++;
    }
    recordCoordinationDealStats(meta, actorStats, event, intent);
    adjustRelation(meta, event.actorId, event.counterpartyId, AI_NUM.N_0_28, AI_NUM.N_0);
    adjustRelation(meta, event.counterpartyId, event.actorId, AI_NUM.N_0_18, AI_NUM.N_0);
    if (event.proposerId != null && event.proposerId !== event.actorId) {
      const proposerStats = meta.players?.[event.proposerId]?.stats;
      const proposerUtility = Number(event.proposerUtility ?? AI_NUM.N_0) || AI_NUM.N_0;
      if (proposerStats) {
        proposerStats.dealUtility += proposerUtility;
        meta.totals.dealUtility += proposerUtility;
      }
    }
  } else if (event.type === 'deal_refuse') {
    actorStats.dealsRefused++;
    meta.totals.dealsRefused++;
    adjustRelation(meta, event.counterpartyId, event.actorId, AI_NUM.N_0, AI_NUM.N_0_12);
  }
  invalidateRoundContext(meta);
  });
}

function buildIncomingDealResponseOptions(state, meta, playerId) {
  return getIncomingDealsForPlayer(state, playerId).flatMap((thread) => {
    const clauses = thread.currentOffer?.clauses || [];
    const counterpartyId = getThreadCounterpartyId(thread, playerId);
    const intent = inferDealIntent(clauses, playerId, counterpartyId);
    const actorUtility = counterpartyId == null
      ? scoreDealClausesForViewer(state, meta, playerId, clauses)
      : scoreDealUtilityForViewer(state, meta, playerId, counterpartyId, clauses, intent);
    const proposerUtility = counterpartyId == null
      ? AI_NUM.N_0
      : scoreDealUtilityForViewer(state, meta, counterpartyId, playerId, clauses, intent);
    const base = {
      thread,
      counterpartyId,
      intent,
      actorUtility,
      proposerUtility,
    };
    const accept = {
      ...base,
      action: 'accept',
      score: actorUtility,
      clauses,
      normalizedClauses: clauses,
    };
    const refuse = {
      ...base,
      action: 'refuse',
      reason: 'ai_unfavorable_deal',
      score: Math.max(AI_NUM.N_0_2, -actorUtility),
      clauses,
      normalizedClauses: clauses,
    };
    const counters = buildDealCounterOptions(state, meta, playerId, thread).map(candidate => ({
      ...base,
      ...candidate,
      action: 'counter',
      score: candidate.score,
    }));
    return [accept, ...counters, refuse];
  });
}

function getOutgoingDealProposalOptions(state, meta, playerId) {
  const budget = ensureDealBudget(state, meta, playerId);
  if (budget.proposals >= AI_NUM.N_1) return [];
  if (getIncomingDealsForPlayer(state, playerId).length || getOutgoingDealsForPlayer(state, playerId).length) return [];
  const fingerprint = getDealProposalCacheFingerprint(state, playerId);
  if (!budget.proposalOptions || budget.proposalFingerprint !== fingerprint) {
    budget.proposalSearches++;
    budget.proposalFingerprint = fingerprint;
    budget.proposalOptions = buildDealProposalOptions(state, meta, playerId);
  }
  return budget.proposalOptions;
}

function executeIncomingDealResponseOption(state, meta, playerId, decision) {
  if (!decision?.thread || !decision.action) return false;
  const thread = decision.thread;
  const offeredClauses = thread.currentOffer?.clauses || [];
  const payload = {
    threadId: thread.id,
    expectedRevision: thread.revision,
    action: decision.action,
  };
  if (decision.action === 'counter') payload.clauses = decision.clauses || [];
  if (decision.action === 'refuse' && decision.reason) payload.reason = decision.reason;
  const result = respondToDeal(state, playerId, payload);
  if (!result?.ok) return false;
  const counterpartyId = thread.playerIds.find((id) => id !== playerId) ?? null;
  if (decision.action === 'accept' || decision.action === 'counter') {
    rememberSystemicDecision(
      state,
      meta,
      playerId,
      {
        kind: AI_ACTION_KINDS.DEAL,
        phase: AI_ACTION_PHASES.COURT,
        payload: {
          counterpartyId,
          clauses: decision.action === 'counter' ? (decision.normalizedClauses || decision.clauses || []) : offeredClauses,
          intent: decision.intent,
        },
        targets: counterpartyId == null ? [] : [counterpartyId],
        timing: 'future',
        reversibility: 'low',
      },
      decision.actorUtility || decision.score || AI_NUM.N_0,
      AI_ACTION_PHASES.COURT,
    );
  }
  observeDealEvent(state, meta, {
    type: `deal_${decision.action}`,
    actorId: playerId,
    counterpartyId,
    proposerId: thread.currentOffer?.proposerId ?? counterpartyId,
    threadId: thread.id,
    actorUtility: decision.actorUtility,
    proposerUtility: decision.proposerUtility,
    intent: decision.intent,
    clauses: decision.action === 'counter' ? (decision.normalizedClauses || decision.clauses || []) : offeredClauses,
  });
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} ${decision.action}s a deal with ${describeActor(state, meta, counterpartyId)}.`);
  return true;
}

function executeOutgoingDealProposalOption(state, meta, playerId, proposal) {
  if (!proposal || proposal.counterpartyId == null) return false;
  const budget = ensureDealBudget(state, meta, playerId);
  if (budget.proposals >= AI_NUM.N_1) return false;
  if (getIncomingDealsForPlayer(state, playerId).length || getOutgoingDealsForPlayer(state, playerId).length) return false;
  const result = sendDealOffer(state, playerId, proposal);
  if (!result?.ok) return false;
  budget.proposals++;
  rememberSystemicDecision(
    state,
    meta,
    playerId,
    {
      kind: AI_ACTION_KINDS.DEAL,
      phase: AI_ACTION_PHASES.COURT,
      payload: {
        counterpartyId: Number(proposal.counterpartyId),
        clauses: proposal.normalizedClauses || proposal.clauses || [],
        intent: proposal.intent,
      },
      targets: [Number(proposal.counterpartyId)],
      timing: 'future',
      reversibility: 'low',
    },
    proposal.actorUtility || proposal.score || AI_NUM.N_0,
    AI_ACTION_PHASES.COURT,
  );
  observeDealEvent(state, meta, {
    type: 'deal_propose',
    actorId: playerId,
    counterpartyId: Number(proposal.counterpartyId),
    threadId: result.threadId,
    actorUtility: proposal.actorUtility,
    proposerUtility: proposal.counterpartyUtility,
    intent: proposal.intent,
    clauses: proposal.normalizedClauses || proposal.clauses || [],
  });
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} proposes a deal to ${describeActor(state, meta, Number(proposal.counterpartyId))}.`);
  return true;
}

function clampFeature(value, scale = AI_NUM.N_1) {
  return clamp((Number(value) || AI_NUM.N_0) / Math.max(AI_NUM.N_0_0001, scale), -AI_NUM.N_2, AI_NUM.N_2);
}

function ensureCourtPolicyState(state, meta, playerId) {
  const playerMeta = meta.players[playerId];
  if (!playerMeta.courtPolicy || playerMeta.courtPolicy.round !== state.round) {
    playerMeta.courtPolicy = {
      round: state.round,
      actionsTaken: AI_NUM.N_0,
      repeatsByKind: {},
    };
  }
  return playerMeta.courtPolicy;
}

function markCourtPolicyAction(state, meta, playerId, kind) {
  const policyState = ensureCourtPolicyState(state, meta, playerId);
  policyState.actionsTaken++;
  policyState.repeatsByKind[kind] = (Number(policyState.repeatsByKind[kind]) || AI_NUM.N_0) + AI_NUM.N_1;
}

function getCourtPolicyRepeat(state, meta, playerId, kind) {
  return Number(ensureCourtPolicyState(state, meta, playerId).repeatsByKind[kind]) || AI_NUM.N_0;
}

function buildPolicyFeatures(state, meta, playerId, descriptor, baseScore = AI_NUM.N_0, extra = {}) {
  const player = getPlayer(state, playerId);
  const policy = getPolicyForPlayer(meta, playerId);
  const isCourt = descriptor.phase === AI_ACTION_PHASES.COURT;
  const courtPolicy = isCourt ? ensureCourtPolicyState(state, meta, playerId) : { actionsTaken: AI_NUM.N_0 };
  const costs = descriptor.costs || {};
  const gains = descriptor.gains || {};
  const relationTargets = [
    ...(descriptor.targets || []),
    ...(descriptor.beneficiaries || []),
    ...(descriptor.affectedPlayers || []),
  ].filter(targetId => targetId != null && targetId !== playerId);
  const relation = relationTargets.length
    ? average(relationTargets.map(targetId => getRelationValue(meta, playerId, targetId)))
    : (Number(extra.relation ?? AI_NUM.N_0) || AI_NUM.N_0);
  const repeat = isCourt ? getCourtPolicyRepeat(state, meta, playerId, descriptor.kind) : AI_NUM.N_0;
  const actionBudget = Math.max(AI_NUM.N_1, policy.maxCourtActionsPerRound);
  const repeatBudget = Math.max(AI_NUM.N_1, policy.maxActionRepeatsPerKind);
  const urgency = Number(extra.urgency ?? AI_NUM.N_0) || AI_NUM.N_0;
  const scarcity = Number(extra.scarcity ?? AI_NUM.N_0) || AI_NUM.N_0;
  const survival = Number(extra.survival ?? AI_NUM.N_0) || AI_NUM.N_0;
  const military = Number(extra.military ?? AI_NUM.N_0) || AI_NUM.N_0;
  const relationRisk = (Number(extra.risk ?? AI_NUM.N_0) || AI_NUM.N_0) * Math.max(AI_NUM.N_0, -relation);
  const political = Number(extra.political ?? AI_NUM.N_0) || AI_NUM.N_0;
  const denial = Number(extra.denial ?? AI_NUM.N_0) || AI_NUM.N_0;
  const economic = Number(extra.economic ?? AI_NUM.N_0) || AI_NUM.N_0;
  const endgame = Number(extra.endgame ?? (getRemainingRounds(state) <= AI_NUM.N_2 ? AI_NUM.N_1 : AI_NUM.N_0)) || AI_NUM.N_0;

  return {
    baseScore: clampFeature(baseScore, AI_NUM.N_10),
    scoreRatio: clampFeature(baseScore, Math.max(AI_NUM.N_1, Math.abs(baseScore) + AI_NUM.N_4)),
    gold: clampFeature((Number(gains.gold) || AI_NUM.N_0) - (Number(costs.gold) || AI_NUM.N_0), AI_NUM.N_10),
    troops: clampFeature((Number(gains.troops) || AI_NUM.N_0) - (Number(costs.troops) || AI_NUM.N_0), AI_NUM.N_5),
    income: clampFeature(Number(gains.income) || AI_NUM.N_0, AI_NUM.N_8),
    titles: clampFeature(Number(gains.titles) || AI_NUM.N_0, AI_NUM.N_3),
    relation: clampFeature(relation, AI_NUM.N_3),
    risk: clampFeature(extra.risk ?? AI_NUM.N_0, AI_NUM.N_2),
    urgency: clampFeature(urgency, AI_NUM.N_2),
    scarcity: clampFeature(scarcity, AI_NUM.N_2),
    repeat: clampFeature(repeat, repeatBudget),
    tempo: clampFeature(courtPolicy.actionsTaken, actionBudget),
    survival: clampFeature(survival, AI_NUM.N_2),
    political: clampFeature(political, AI_NUM.N_2),
    economic: clampFeature(economic, AI_NUM.N_2),
    military: clampFeature(military, AI_NUM.N_2),
    diplomacy: clampFeature(extra.diplomacy ?? AI_NUM.N_0, AI_NUM.N_2),
    denial: clampFeature(denial, AI_NUM.N_2),
    flexibility: clampFeature((player?.gold || AI_NUM.N_0) - (Number(costs.gold) || AI_NUM.N_0), AI_NUM.N_12),
    endgame: clampFeature(endgame, AI_NUM.N_2),
    candidateAlignment: clampFeature(extra.candidateAlignment ?? AI_NUM.N_0, AI_NUM.N_8),
    capitalCommitment: clampFeature(extra.capitalCommitment ?? AI_NUM.N_0, AI_NUM.N_12),
    frontierCommitment: clampFeature(extra.frontierCommitment ?? AI_NUM.N_0, AI_NUM.N_12),
    dealLock: clampFeature(extra.dealLock ?? AI_NUM.N_0, AI_NUM.N_4),
    selfClaim: clampFeature(extra.selfClaim ?? AI_NUM.N_0, AI_NUM.N_1),
    incumbentSupport: clampFeature(extra.incumbentSupport ?? AI_NUM.N_0, AI_NUM.N_1),
    rivalSupport: clampFeature(extra.rivalSupport ?? AI_NUM.N_0, AI_NUM.N_1),
    routeSafety: clampFeature(extra.routeSafety ?? AI_NUM.N_0, AI_NUM.N_2),
    goldPressure: clampFeature(extra.goldPressure ?? AI_NUM.N_0, AI_NUM.N_2),
    restorationPressure: clampFeature(extra.restorationPressure ?? AI_NUM.N_0, AI_NUM.N_2),
    titleContinuity: clampFeature(extra.titleContinuity ?? AI_NUM.N_0, AI_NUM.N_4),
    supporterReward: clampFeature(extra.supporterReward ?? AI_NUM.N_0, AI_NUM.N_4),
    rivalSuppression: clampFeature(extra.rivalSuppression ?? AI_NUM.N_0, AI_NUM.N_4),
    roleFit: clampFeature(extra.roleFit ?? AI_NUM.N_0, AI_NUM.N_4),
    obligationPayoff: clampFeature(extra.obligationPayoff ?? AI_NUM.N_0, AI_NUM.N_4),
    militaryCompetence: clampFeature(extra.militaryCompetence ?? AI_NUM.N_0, AI_NUM.N_4),
    survivalMilitary: clampFeature(survival * military, AI_NUM.N_8),
    relationRisk: clampFeature(extra.relationRisk ?? relationRisk, AI_NUM.N_4),
    endgameEconomic: clampFeature(extra.endgameEconomic ?? (endgame * economic), AI_NUM.N_4),
    urgencyScarcity: clampFeature(extra.urgencyScarcity ?? (urgency * scarcity), AI_NUM.N_4),
    politicalDenial: clampFeature(extra.politicalDenial ?? (political * denial), AI_NUM.N_4),
  };
}

function makePolicyAction(state, meta, playerId, kind, phase, baseScore, descriptor, execute, extraFeatures = {}) {
  const normalizedDescriptor = {
    ...descriptor,
    kind,
    phase,
    actorId: playerId,
    baseScore,
  };
  const features = buildPolicyFeatures(state, meta, playerId, normalizedDescriptor, baseScore, extraFeatures);
  const policyScore = scorePolicyAction(getPolicyForPlayer(meta, playerId), normalizedDescriptor, features);
  return {
    kind,
    descriptor: normalizedDescriptor,
    features,
    policyScore,
    score: policyScore,
    execute,
  };
}

function makeCourtPoolAction(state, meta, playerId, kind, baseScore, descriptor, execute, extraFeatures = {}) {
  return makePolicyAction(state, meta, playerId, kind, AI_ACTION_PHASES.COURT, baseScore, descriptor, execute, extraFeatures);
}

function selectPolicyOption(state, meta, playerId, options) {
  const policy = getPolicyForPlayer(meta, playerId);
  const available = (options || []).filter(Boolean);
  if (!available.length) return null;
  const plausible = available.filter(option => option.policyScore >= policy.actionThreshold);
  const pool = plausible.length ? plausible : available;
  return softmaxPick(pool, policy.scoreTemperature, state.rng) || available[AI_NUM.N_0] || null;
}

function getBasileusAppointmentPoolActions(state, meta, playerId) {
  if (playerId !== state.basileusId) return [];
  return rankBasileusAppointmentOptions(state, meta).map((option) => makeCourtPoolAction(
    state,
    meta,
    playerId,
    AI_ACTION_KINDS.APPOINTMENT,
    option.score,
    appointmentDescriptor(
      playerId,
      option.type,
      option.themeId || null,
      option.appointeeId,
      getNextAppointmentCost(state, playerId, option.appointeeId),
    ),
    () => executeBasileusAppointmentOption(state, meta, option),
    { political: AI_NUM.N_1, diplomacy: option.appointeeId === playerId ? AI_NUM.N_0 : AI_NUM.N_1, urgency: state.courtActions.basileusAppointed ? AI_NUM.N_0 : AI_NUM.N_0_5 },
  ));
}

function getRegionalAppointmentPoolActions(state, meta, playerId, titleKey) {
  const player = getPlayer(state, playerId);
  if (!player?.majorTitles.includes(titleKey)) return [];
  return rankRegionalStrategosAppointmentOptions(state, meta, titleKey).ranked.map((option) => makeCourtPoolAction(
    state,
    meta,
    playerId,
    AI_ACTION_KINDS.APPOINTMENT,
    option.score,
    appointmentDescriptor(playerId, 'STRATEGOS', option.themeId, option.appointeeId, getNextAppointmentCost(state, playerId, option.appointeeId)),
    () => executeRegionalStrategosAppointmentOption(state, meta, titleKey, option),
    { political: AI_NUM.N_0_8, military: AI_NUM.N_0_6, diplomacy: option.appointeeId === playerId ? AI_NUM.N_0 : AI_NUM.N_0_8 },
  ));
}

function getPatriarchAppointmentPoolActions(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  if (!player?.majorTitles.includes('PATRIARCH')) return [];
  return rankPatriarchAppointmentOptions(state, meta).ranked.map((option) => makeCourtPoolAction(
    state,
    meta,
    playerId,
    AI_ACTION_KINDS.APPOINTMENT,
    option.score,
    appointmentDescriptor(
      playerId,
      'BISHOP',
      option.themeId,
      option.appointeeId,
      getPatriarchBishopAppointmentGoldCost(state, playerId, option.appointeeId),
      'gold',
    ),
    () => executePatriarchAppointmentOption(state, meta, option),
    { political: AI_NUM.N_0_7, diplomacy: option.appointeeId === playerId ? AI_NUM.N_0 : AI_NUM.N_0_8, economic: AI_NUM.N_0_4 },
  ));
}

function getRevocationPoolActions(state, meta, playerId) {
  if (playerId === state.basileusId) {
    const paymentCheck = canPayRevocationCost(state, playerId);
    if (!paymentCheck.ok) return [];
    return buildRevocationOptions(state, meta, playerId).map((option) => makeCourtPoolAction(
      state,
      meta,
      playerId,
      AI_ACTION_KINDS.REVOCATION,
      option.score,
      revocationDescriptor(playerId, option, getNextRevocationCost(state, playerId)),
      () => executeBasileusRevocationOption(state, meta, option),
      { political: AI_NUM.N_0_5, denial: AI_NUM.N_1, risk: AI_NUM.N_0_7 },
    ));
  }
  return buildAffordableTitleHolderRevocationOptions(state, meta, playerId).map((option) => makeCourtPoolAction(
    state,
    meta,
    playerId,
    AI_ACTION_KINDS.REVOCATION,
    option.score,
    revocationDescriptor(playerId, option, option.paymentCheck?.cost || option.paymentCheck?.goldCost || AI_NUM.N_0, option.paymentCheck?.paymentType || 'troops'),
    () => executeTitleHolderRevocationOption(state, meta, playerId, option),
    { political: AI_NUM.N_0_4, denial: AI_NUM.N_0_8, risk: AI_NUM.N_0_5 },
  ));
}

function getMercenaryPoolActions(state, meta, playerId) {
  const context = ensureRoundContext(state, meta, 'court');
  const pact = context.pactByPlayer[playerId];
  const empireDanger = getEmpireDanger(state, meta);
  const threat = getThreatLevel(state, meta);
  const spendableGold = Math.max(AI_NUM.N_1, getSpendableGold(state, playerId));
  return buildMercenaryHireActions(state, meta, playerId).map((action) => makeCourtPoolAction(
    state,
    meta,
    playerId,
    AI_ACTION_KINDS.MERCENARY_HIRE,
    AI_NUM.N_0,
    {
      payload: { officeKey: MERCENARY_COMPANY_KEY, count: action.count },
      costs: { gold: action.cost },
      gains: { troops: action.count },
      timing: 'immediate',
      reversibility: 'medium',
    },
    () => runMercenaryStrategy(state, meta, playerId, { ...action, policySelected: true }),
    {
      military: action.count,
      survival: empireDanger,
      urgency: threat + (pact?.capitalBias || AI_NUM.N_0) + (pact?.frontierBias || AI_NUM.N_0),
      economic: -action.cost,
      scarcity: action.cost / spendableGold,
      capitalCommitment: (pact?.capitalBias || AI_NUM.N_0) * action.count,
      frontierCommitment: (empireDanger + (pact?.frontierBias || AI_NUM.N_0)) * action.count,
      survivalMilitary: empireDanger * action.count,
    },
  ));
}

function dealOptionDescriptor(playerId, option) {
  const clauses = option.normalizedClauses || option.clauses || [];
  const counterpartyId = option.counterpartyId == null ? null : Number(option.counterpartyId);
  return {
    payload: {
      action: option.action || 'propose',
      counterpartyId,
      clauses,
      intent: option.intent,
      threadId: option.thread?.id,
    },
    targets: counterpartyId == null ? [] : [counterpartyId],
    beneficiaries: option.action === 'refuse' ? [playerId] : [],
    timing: 'future',
    reversibility: option.action === 'refuse' ? 'medium' : 'low',
  };
}

function getDealPoolActions(state, meta, playerId) {
  const incoming = buildIncomingDealResponseOptions(state, meta, playerId).map((option) => makeCourtPoolAction(
    state,
    meta,
    playerId,
    AI_ACTION_KINDS.DEAL,
    option.score ?? option.actorUtility ?? AI_NUM.N_0,
    dealOptionDescriptor(playerId, option),
    () => executeIncomingDealResponseOption(state, meta, playerId, option),
    {
      diplomacy: option.action === 'refuse' ? AI_NUM.N_0_2 : AI_NUM.N_1,
      political: AI_NUM.N_0_4,
      urgency: AI_NUM.N_1,
      risk: option.actorUtility < AI_NUM.N_0 ? Math.abs(option.actorUtility) : AI_NUM.N_0,
    },
  ));

  const outgoing = getOutgoingDealProposalOptions(state, meta, playerId).map((option) => makeCourtPoolAction(
    state,
    meta,
    playerId,
    AI_ACTION_KINDS.DEAL,
    option.score ?? option.actorUtility ?? AI_NUM.N_0,
    dealOptionDescriptor(playerId, { ...option, action: 'propose' }),
    () => executeOutgoingDealProposalOption(state, meta, playerId, option),
    {
      diplomacy: AI_NUM.N_1,
      political: AI_NUM.N_0_4,
      urgency: AI_NUM.N_0_25,
      risk: option.actorUtility < AI_NUM.N_0 ? Math.abs(option.actorUtility) : AI_NUM.N_0,
    },
  ));

  return [...incoming, ...outgoing];
}

function executeAiCourtConfirmation(state, meta, playerId) {
  if (state.courtActions.playerConfirmed.has(playerId)) return false;
  recordHistoryEvent(state, {
    category: 'court',
    type: 'court_confirmed',
    actorId: playerId,
    actorAi: true,
    summary: `${publicActor(state, playerId)} ends court business for the round.`,
  });
  state.courtActions.playerConfirmed.add(playerId);
  autoRefuseAwaitingDeals(state, playerId);
  invalidateRoundContext(meta);
  return true;
}

function getConfirmPoolAction(state, meta, playerId) {
  if (state.courtActions.playerConfirmed.has(playerId)) return null;
  const policyState = ensureCourtPolicyState(state, meta, playerId);
  const policy = getPolicyForPlayer(meta, playerId);
  const actionBudgetPressure = policyState.actionsTaken / Math.max(AI_NUM.N_1, policy.maxCourtActionsPerRound);
  return makeCourtPoolAction(
    state,
    meta,
    playerId,
    AI_ACTION_KINDS.CONFIRM_COURT,
    actionBudgetPressure,
    {
      payload: {},
      timing: 'immediate',
      reversibility: 'low',
    },
    () => executeAiCourtConfirmation(state, meta, playerId),
    { tempo: actionBudgetPressure, urgency: actionBudgetPressure },
  );
}

export function collectAICourtActionOptions(state, meta, playerId) {
  return withPolicyNumericTuning(meta, playerId, () => {
  if (!state?.courtActions || state.phase !== 'court') return [];
  if (!isAIPlayer(meta, playerId) || state.courtActions.playerConfirmed.has(playerId)) return [];
  const recruits = buildRecruitmentActions(state, meta, playerId);
  const landPurchases = buildLandPurchaseActions(state, meta, playerId);
  const churchGifts = buildChurchGiftActions(state, meta, playerId);
  const dismissals = buildDismissalActions(state, meta, playerId);

  return [
    ...getBasileusAppointmentPoolActions(state, meta, playerId),
    ...getRegionalAppointmentPoolActions(state, meta, playerId, 'DOM_EAST'),
    ...getRegionalAppointmentPoolActions(state, meta, playerId, 'DOM_WEST'),
    ...getRegionalAppointmentPoolActions(state, meta, playerId, 'ADMIRAL'),
    ...getPatriarchAppointmentPoolActions(state, meta, playerId),
    ...getRevocationPoolActions(state, meta, playerId),
    ...getDealPoolActions(state, meta, playerId),
    ...recruits.map((recruit) => makeCourtPoolAction(
      state,
      meta,
      playerId,
      AI_ACTION_KINDS.RECRUIT,
      recruit.score,
      troopManagementDescriptor(AI_ACTION_KINDS.RECRUIT, recruit.office.key, AI_NUM.N_1),
      () => runRecruitmentStrategy(state, meta, playerId, { ...recruit, policySelected: true }),
      { military: AI_NUM.N_0_8, survival: getEmpireDanger(state, meta), urgency: getThreatLevel(state, meta) },
    )),
    ...landPurchases.map((land) => makeCourtPoolAction(
      state,
      meta,
      playerId,
      AI_ACTION_KINDS.LAND_PURCHASE,
      land.score,
      landPurchaseDescriptor(state, playerId, land.theme, getMinimumLandBid(state, land.theme.id)),
      () => runLandStrategy(state, meta, playerId, { ...land, policySelected: true }),
      { economic: AI_NUM.N_1, scarcity: getPlayerThemes(state, playerId).length <= AI_NUM.N_1 ? AI_NUM.N_1 : AI_NUM.N_0 },
    )),
    ...churchGifts.map((gift) => makeCourtPoolAction(
      state,
      meta,
      playerId,
      AI_ACTION_KINDS.CHURCH_GIFT,
      gift.score,
      churchGiftDescriptor(playerId, gift.theme),
      () => runChurchGiftStrategy(state, meta, playerId, { ...gift, policySelected: true }),
      { economic: AI_NUM.N_0_4, political: AI_NUM.N_0_3, survival: getThemeRouteRisk(state, gift.theme.id) },
    )),
    ...dismissals.map((dismiss) => makeCourtPoolAction(
      state,
      meta,
      playerId,
      AI_ACTION_KINDS.DISMISS,
      dismiss.score,
      troopManagementDescriptor(AI_ACTION_KINDS.DISMISS, dismiss.office.key, dismiss.count),
      () => runDismissalStrategy(state, meta, playerId, { ...dismiss, policySelected: true }),
      { economic: AI_NUM.N_0_7, military: -AI_NUM.N_0_5 },
    )),
    ...getMercenaryPoolActions(state, meta, playerId),
    getConfirmPoolAction(state, meta, playerId),
  ].filter(Boolean);
  });
}

function selectAICourtActionOption(state, meta, playerId) {
  const policy = getPolicyForPlayer(meta, playerId);
  const policyState = ensureCourtPolicyState(state, meta, playerId);
  const options = collectAICourtActionOptions(state, meta, playerId)
    .filter(option => getCourtPolicyRepeat(state, meta, playerId, option.kind) < policy.maxActionRepeatsPerKind);
  const confirm = options.find(option => option.kind === AI_ACTION_KINDS.CONFIRM_COURT) || getConfirmPoolAction(state, meta, playerId);
  const nonConfirm = options.filter(option => option.kind !== AI_ACTION_KINDS.CONFIRM_COURT);

  if (policyState.actionsTaken >= policy.maxCourtActionsPerRound) return confirm;
  if (!nonConfirm.length) return confirm;

  const plausible = options.filter(option => option.policyScore >= policy.actionThreshold);
  const pool = plausible.length ? plausible : [...nonConfirm, confirm].filter(Boolean);
  return softmaxPick(pool, policy.scoreTemperature, state.rng) || confirm;
}

function takeOneAiCourtAction(state, meta, playerId) {
  return withPolicyNumericTuning(meta, playerId, () => {
  const player = getPlayer(state, playerId);
  if (!player) return false;
  const option = selectAICourtActionOption(state, meta, playerId);
  if (!option) return false;
  const acted = Boolean(option.execute?.());
  if (acted) markCourtPolicyAction(state, meta, playerId, option.kind);
  return acted;
  });
}

export function runAICourtAutomation(state, meta, options = {}) {
  ensureRoundContext(state, meta, 'court');
  const mode = options.mode || 'finish';
  const aiOrder = shuffle(state.players.filter(player => isAIPlayer(meta, player.id)).map(player => player.id), state.rng);
  let actionsTaken = AI_NUM.N_0;

  const safeTakeOneAiCourtAction = (playerId) => {
    try {
      return Boolean(takeOneAiCourtAction(state, meta, playerId));
    } catch (error) {
      invalidateRoundContext(meta);
      logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} hit an automation error and is forced to pass (${error?.message || 'unknown error'}).`);
      return false;
    }
  };

  if (mode === 'react') {
    for (const playerId of aiOrder) {
      if (safeTakeOneAiCourtAction(playerId)) {
        actionsTaken++;
      }
    }
    return { actionsTaken };
  }

  let progress = true;
  let safety = AI_NUM.N_0;
  const maxPasses = Math.max(AI_NUM.N_12, aiOrder.length * AI_NUM.N_8);
  while (progress && safety < maxPasses) {
    progress = false;
    safety++;
    for (const playerId of aiOrder) {
      if (safeTakeOneAiCourtAction(playerId)) {
        actionsTaken++;
        progress = true;
      }
    }
  }
  finalizeCourtAutomation(state, meta, aiOrder);

  return { actionsTaken };
}

export function observeCourtAction(state, meta, action) {
  return withPolicyNumericTuning(meta, action?.actorId, () => {
  if (!meta || !action) return;
  invalidateRoundContext(meta);

  if (action.type === 'appointment') {
    registerFavor(meta, action.actorId, action.appointeeId, action.value ?? AI_NUM.N_1);
    if (action.previousHolderId != null && action.previousHolderId !== action.appointeeId) {
      adjustRelation(meta, action.previousHolderId, action.actorId, AI_NUM.N_0, AI_NUM.N_0_55);
      reduceObligation(meta, action.actorId, action.previousHolderId, AI_NUM.N_0_45);
    }
  }

  if (action.type === 'revocation') {
    if (action.targetPlayerId != null) {
      adjustRelation(meta, action.targetPlayerId, action.actorId, AI_NUM.N_0, AI_NUM.N_1_15);
      reduceObligation(meta, action.actorId, action.targetPlayerId, AI_NUM.N_0_8);
    }
    if (action.newHolderId != null) {
      adjustRelation(meta, action.newHolderId, action.actorId, AI_NUM.N_0_65, AI_NUM.N_0);
      addObligation(meta, action.newHolderId, action.actorId, AI_NUM.N_0_8);
    }
    // Tier 5: every other AI updates its posterior on the actor as a revoker
    for (const observer of state.players) {
      if (observer.id === action.actorId) continue;
      if (!isAIPlayer(meta, observer.id)) continue;
      updateOpponentPosterior(meta, observer.id, action.actorId, { revocation: AI_NUM.N_1 });
    }
  }

  if (action.type === 'gift') {
    for (const observer of state.players) {
      if (observer.id === action.actorId) continue;
      if (!isAIPlayer(meta, observer.id)) continue;
      updateOpponentPosterior(meta, observer.id, action.actorId, { gift: AI_NUM.N_1 });
    }
  }

  if (action.type === 'recruit') {
    for (const observer of state.players) {
      if (observer.id === action.actorId) continue;
      if (!isAIPlayer(meta, observer.id)) continue;
      updateOpponentPosterior(meta, observer.id, action.actorId, { recruit: AI_NUM.N_1 });
    }
  }

  if (action.type === 'mercenaries') {
    const mercNorm = clamp((Number(action.count) || AI_NUM.N_0) / AI_NUM.N_5, AI_NUM.N_0, AI_NUM.N_1);
    for (const observer of state.players) {
      if (observer.id === action.actorId) continue;
      if (!isAIPlayer(meta, observer.id)) continue;
      updateOpponentPosterior(meta, observer.id, action.actorId, { mercenarySpend: mercNorm });
    }
  }
  });
}

export function handlePostResolutionAI(state, meta, options = {}) {
  const winnerIdForTuning = state.lastCoupResult?.winner ?? state.basileusId;
  return withPolicyNumericTuning(meta, winnerIdForTuning, () => {
  const autoApplyTitleAssignments = options.autoApplyTitleAssignments !== false;
  const winnerId = state.lastCoupResult?.winner ?? state.basileusId;
  const previousBasileusId = options.previousBasileusId ?? state.basileusId;

  updatePostResolutionRelations(state, meta);

  if (state.lastWarResult) {
    meta.wars.push({
      id: state.currentInvasion?.id || `round-${state.round}`,
      name: state.currentInvasion?.name || 'Invasion',
      outcome: state.lastWarResult.outcome,
      reachedCPL: Boolean(state.lastWarResult.reachedCPL),
      themesLost: state.lastWarResult.themesLost.length,
      themesRecovered: state.lastWarResult.themesRecovered.length,
      strength: state.invasionStrength,
      frontierTroops: state.lastWarResult.frontierTroops,
      contributions: Array.isArray(state.lastWarResult.contributions)
        ? state.lastWarResult.contributions.map(entry => ({
          playerId: entry.playerId,
          troops: entry.troops,
        }))
        : [],
    });
    logDecision(meta, `Round ${state.round} resolution: ${state.currentInvasion?.name || 'Invasion'} ends in ${state.lastWarResult.outcome}; frontier ${state.lastWarResult.frontierTroops} vs invasion ${state.lastWarResult.invaderStrength}.`);
    logPublic(meta, `${state.currentInvasion?.name || 'Invasion'} ends in ${state.lastWarResult.outcome}.`);
  }

  if (winnerId !== previousBasileusId) {
    const winnerIsAI = isAIPlayer(meta, winnerId);
    const plan = winnerIsAI ? planMajorTitleAssignment(state, meta, winnerId) : null;
    if (winnerIsAI && autoApplyTitleAssignments) {
      applyMajorTitleAssignment(state, meta, winnerId, plan);
      return { plannedAssignment: null };
    }
    return { plannedAssignment: winnerIsAI ? plan : null };
  }

  return { plannedAssignment: null };
  });
}

export function applyPlannedAiTitleAssignment(state, meta, plan, newBasileusId) {
  return withPolicyNumericTuning(meta, newBasileusId, () => applyMajorTitleAssignment(state, meta, newBasileusId, plan));
}

export function getRecentPublicLog(meta, limit = AI_NUM.N_10) {
  return meta.publicLog.slice(-limit);
}

export {
  DEFAULT_MIXED_DECK_SIZES,
  PERSONALITIES,
  POPULATION_PRESETS,
  SUPPORTED_PLAYER_COUNTS,
};
