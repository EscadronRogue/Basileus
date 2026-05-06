import {
  getFreeThemes,
  getOfficeDisplayName,
  getPlayer,
  getPlayerThemes,
  shuffle,
  formatPlayerLabel,
  getPlayerMercenaryAssignments,
  getPlayerMercenaryTotal,
  MERCENARY_COMPANY_KEY,
} from '../engine/state.js';
import { recordHistoryEvent, updateHistoryEvent } from '../engine/history.js';
import {
  appointBishop,
  appointCourtTitle,
  appointStrategos,
  applyCoupTitleReassignment,
  buyTheme,
  dismissProfessional,
  canRecruitProfessional,
  giftToChurch,
  hireMercenaries,
  recruitProfessional,
  revokeMajorTitle,
  revokeMinorTitle,
  revokeTaxExemption,
  revokeTheme,
  revokeCourtTitle,
  canPayRevocationCost,
  getNextRevocationCost,
  validateMajorTitleAssignments,
} from '../engine/actions.js';
import {
  getMercenaryHireCost,
  getNormalOwnerIncome,
  getThemeLandPrice,
  getThemeOwnerIncome,
} from '../engine/rules.js';
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

const PUBLIC_LOG_LIMIT = 48;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function roundTo(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function incrementMapCount(map, key, amount = 1) {
  if (key == null) return;
  map.set(key, (map.get(key) || 0) + amount);
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
  let occupiedThemeCount = 0;
  let totalThemeCount = 0;

  for (const player of state.players) {
    themesByOwner.set(player.id, []);
    minorTitleCounts.set(player.id, 0);
    professionalCountByPlayer.set(player.id, getPlayerProfessionalCount(player));
    landIncomeByPlayer.set(player.id, 0);
    exposureByPlayer.set(player.id, 0);
    threatenedLandValueByPlayer.set(player.id, 0);
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
      landIncomeByPlayer.set(theme.owner, (landIncomeByPlayer.get(theme.owner) || 0) + getThemeOwnerIncome(theme));
      const routeRisk = getThemeRouteRisk(state, theme.id);
      exposureByPlayer.set(theme.owner, (exposureByPlayer.get(theme.owner) || 0) + routeRisk);
      threatenedLandValueByPlayer.set(
        theme.owner,
        (threatenedLandValueByPlayer.get(theme.owner) || 0) + (routeRisk * getThemeStrategicValue(theme))
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
      .filter(value => Number.isInteger(value) && value >= 0 && value < playerCount)
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
    const uniform = 1 / Math.max(1, basisIds.length);
    observerMeta.opponentModels[targetId] = {
      typePosterior: Object.fromEntries(basisIds.map(id => [id, uniform])),
      observations: 0,
      aggressionEstimate: 0.5,
      loyaltyEstimate: 0.5,
      frontierCooperationEstimate: 0.5,
      coupRiskEstimate: 0.5,
    };
  }
  return observerMeta.opponentModels[targetId];
}

function buildBeliefWeightedProfile(basisProfiles, distribution = null) {
  const basis = Array.isArray(basisProfiles) && basisProfiles.length ? basisProfiles : [NEUTRAL_PROFILE];
  const defaultWeight = 1 / Math.max(1, basis.length);
  const weights = {};

  for (const key of PROFILE_WEIGHT_KEYS) {
    let inferred = 0;
    for (const [index, profile] of basis.entries()) {
      const basisId = profile.id || profile.name || `basis-${index}`;
      const probability = distribution?.[basisId] ?? defaultWeight;
      inferred += probability * (profile.weights?.[key] || 0);
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
  const defaultWeight = 1 / Math.max(1, basisProfiles.length);
  const prior = Object.fromEntries(
    basisProfiles.map((profile, index) => [profile.id || profile.name || `basis-${index}`, defaultWeight])
  );
  if (trust <= 0.001) return buildBeliefWeightedProfile(basisProfiles, prior);
  const model = ensureOpponentModel(meta, observerId, targetId);
  if (!model) return buildBeliefWeightedProfile(basisProfiles, prior);

  const posterior = model.observations > 0 ? model.typePosterior : prior;
  const distribution = {};
  for (const basisId of Object.keys(prior)) {
    distribution[basisId] =
      ((1 - trust) * (prior[basisId] || 0)) +
      (trust * (posterior[basisId] || 0));
  }
  return buildBeliefWeightedProfile(basisProfiles, distribution);
}

function updateOpponentPosterior(meta, observerId, targetId, observedFeatures) {
  if (observerId == null || targetId == null || observerId === targetId) return;
  const observerProfile = getPersonalityProfile(meta, observerId);
  const learnRate = getMeta(observerProfile, 'opponentLearnRate');
  if (learnRate <= 0) return;
  const model = ensureOpponentModel(meta, observerId, targetId);
  if (!model) return;
  // Compute likelihood of each profile basis entry given the observation.
  // observedFeatures: { gift, throneVoteAgainstIncumbent, mercenarySpend, recruit, revocation, frontierShare }
  // Each feature is a 0..1 normalised intensity.
  const basisProfiles = getProfileBasis(meta);
  const likelihoods = {};
  let total = 0;
  for (const [index, profile] of basisProfiles.entries()) {
    const basisId = profile.id || profile.name || `basis-${index}`;
    const w = profile.weights || NEUTRAL_PROFILE.weights;
    let logL = 0;
    if (observedFeatures.gift != null) {
      logL += observedFeatures.gift * Math.log(0.2 + w.church);
      logL += (1 - observedFeatures.gift) * Math.log(0.5 + w.land);
    }
    if (observedFeatures.throneAgainstIncumbent != null) {
      logL += observedFeatures.throneAgainstIncumbent * Math.log(0.3 + w.throne + w.retaliation);
    }
    if (observedFeatures.mercenarySpend != null) {
      logL += observedFeatures.mercenarySpend * Math.log(0.2 + w.mercenary);
    }
    if (observedFeatures.recruit != null) {
      logL += observedFeatures.recruit * Math.log(0.3 + w.frontier + w.mercenary * 0.5);
    }
    if (observedFeatures.revocation != null) {
      logL += observedFeatures.revocation * Math.log(0.2 + w.revocation);
    }
    if (observedFeatures.frontierShare != null) {
      logL += observedFeatures.frontierShare * Math.log(0.3 + w.frontier);
      logL += (1 - observedFeatures.frontierShare) * Math.log(0.3 + w.capital + w.throne);
    }
    likelihoods[basisId] = Math.exp(logL);
    total += likelihoods[basisId];
  }
  if (total <= 0 || !Number.isFinite(total)) return;
  // Bayesian update with learning-rate smoothing
  for (const basisId of Object.keys(model.typePosterior)) {
    const evidence = (likelihoods[basisId] || 0) / total;
    model.typePosterior[basisId] =
      (1 - learnRate) * model.typePosterior[basisId] +
      learnRate * evidence;
  }
  // Renormalise (should already be ~1, but float drift)
  const norm = Object.values(model.typePosterior).reduce((s, v) => s + v, 0) || 1;
  for (const basisId of Object.keys(model.typePosterior)) {
    model.typePosterior[basisId] /= norm;
  }
  let aggression = 0;
  let loyalty = 0;
  let frontierCooperation = 0;
  let coupRisk = 0;
  for (const [index, profile] of basisProfiles.entries()) {
    const basisId = profile.id || profile.name || `basis-${index}`;
    const posterior = model.typePosterior[basisId] || 0;
    const weights = profile.weights || NEUTRAL_PROFILE.weights;
    aggression += posterior * clamp((weights.throne + weights.capital + weights.mercenary) / 9, 0, 1);
    loyalty += posterior * clamp(weights.loyalty / 4.5, 0, 1);
    frontierCooperation += posterior * clamp(weights.frontier / 4.5, 0, 1);
    coupRisk += posterior * clamp((weights.throne + weights.retaliation) / 9, 0, 1);
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
  if (temperature <= 0.05 || rankedOptions.length === 1) return rankedOptions[0];
  // Numerical stability: subtract max
  const maxScore = Math.max(...rankedOptions.map(opt => opt.score));
  const weights = rankedOptions.map(opt => Math.exp((opt.score - maxScore) / Math.max(0.05, temperature)));
  const total = weights.reduce((s, v) => s + v, 0);
  if (total <= 0 || !Number.isFinite(total)) return rankedOptions[0];
  let cursor = rng() * total;
  for (let index = 0; index < rankedOptions.length; index++) {
    cursor -= weights[index];
    if (cursor <= 0) return rankedOptions[index];
  }
  return rankedOptions[rankedOptions.length - 1];
}

export function getPlayerProfessionalCount(player) {
  return sum(Object.values(player.professionalArmies || {}));
}

export function getMinorTitleCount(state, playerId) {
  let count = 0;
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
    1 +
    player.gold * 0.12 +
    getCachedPlayerThemes(state, meta, playerId).length * 0.9 +
    getCachedProfessionalCount(state, meta, playerId) * 1.1 +
    player.majorTitles.length * 1.7 +
    getCachedMinorTitleCount(state, meta, playerId) * 0.45 +
    (playerId === state.basileusId ? 1.8 : 0) +
    (meta.players[playerId]?.stats?.throneCaptures || 0) * 0.8
  );
}

export function getPlayerStrength(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  return (
    player.gold +
    getCachedPlayerThemes(state, meta, playerId).length * 1.5 +
    getCachedProfessionalCount(state, meta, playerId) * 1.2 +
    player.majorTitles.length * 2.2 +
    getCachedMinorTitleCount(state, meta, playerId) * 0.8 +
    (playerId === state.basileusId ? 3 : 0) +
    (meta.players[playerId]?.stats?.throneCaptures || 0) * 0.8
  );
}

function getPlayerIncomePotential(state, playerId, meta = null) {
  const cache = getFastCache(state, meta);
  if (cache?.landIncomeByPlayer.has(playerId)) return cache.landIncomeByPlayer.get(playerId);
  return getPlayerThemes(state, playerId).reduce((total, theme) => total + getThemeOwnerIncome(theme), 0);
}

function getThemeStrategicValue(theme) {
  return (theme.P * 1.35) + (theme.L * 0.95);
}

function getRemainingRounds(state) {
  return Math.max(0, state.maxRounds - state.round);
}

function getThemeRouteRisk(state, themeId) {
  if (!state.currentInvasion) return 0;
  const routeIndex = state.currentInvasion.route.indexOf(themeId);
  if (routeIndex === -1) return 0;
  const usableLength = Math.max(1, state.currentInvasion.route.length - 2);
  return clamp(1 - (routeIndex / usableLength), 0, 1);
}

function getPlayerExposure(state, playerId, meta = null) {
  const cache = getFastCache(state, meta);
  if (cache?.exposureByPlayer.has(playerId)) return cache.exposureByPlayer.get(playerId);
  return getPlayerThemes(state, playerId).reduce((total, theme) => total + getThemeRouteRisk(state, theme.id), 0);
}

function getPlayerThreatenedLandValue(state, playerId, meta = null) {
  const cache = getFastCache(state, meta);
  if (cache?.threatenedLandValueByPlayer.has(playerId)) return cache.threatenedLandValueByPlayer.get(playerId);
  return getPlayerThemes(state, playerId).reduce(
    (total, theme) => total + (getThemeRouteRisk(state, theme.id) * getThemeStrategicValue(theme)),
    0
  );
}

function getRivalThreatenedLandValue(state, playerId, meta = null) {
  return state.players
    .filter(player => player.id !== playerId)
    .reduce((total, player) => total + getPlayerThreatenedLandValue(state, player.id, meta), 0);
}

export function getThreatLevel(state, meta = null) {
  if (!state.currentInvasion) return 0.25;
  const cache = getFastCache(state, meta);
  if (cache && cache.threatLevel != null) return cache.threatLevel;

  const [minStrength, maxStrength] = state.currentInvasion.strength;
  const invasionMean = (minStrength + maxStrength) / 2;
  const occupiedThemes = cache?.occupiedThemeCount ?? Object.values(state.themes).filter(theme => theme.occupied && theme.id !== 'CPL').length;
  const totalThemes = cache?.totalThemeCount ?? Object.values(state.themes).filter(theme => theme.id !== 'CPL').length;
  const totalPotentialTroops =
    sum(Object.values(state.currentLevies || {})) +
    sum(state.players.map(player => getCachedProfessionalCount(state, meta, player.id)));

  const occupationPressure = occupiedThemes / Math.max(1, totalThemes);
  const troopPressure = (invasionMean - (totalPotentialTroops * 0.55)) / Math.max(1, invasionMean);
  const threat = clamp(0.35 + occupationPressure * 0.9 + troopPressure * 0.8, 0, 1.6);
  if (cache) cache.threatLevel = threat;
  return threat;
}

function getEmpireDanger(state, meta = null) {
  if (!state.currentInvasion) return 0.2;
  const cache = getFastCache(state, meta);
  if (cache && cache.empireDanger != null) return cache.empireDanger;
  const threat = getThreatLevel(state, meta);
  const occupiedThemes = cache?.occupiedThemeCount ?? Object.values(state.themes).filter(theme => theme.occupied && theme.id !== 'CPL').length;
  const totalThemes = Math.max(1, cache?.totalThemeCount ?? Object.values(state.themes).filter(theme => theme.id !== 'CPL').length);
  const occupationRatio = occupiedThemes / totalThemes;
  const danger = clamp((threat * 0.95) + (occupationRatio * 0.7), 0, 2);
  if (cache) cache.empireDanger = danger;
  return danger;
}

function getVictoryPositionScore(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  const remainingRounds = getRemainingRounds(state);
  const landIncome = getPlayerIncomePotential(state, playerId, meta);
  const threatenedLoss = getPlayerThreatenedLandValue(state, playerId, meta);
  return (
    player.gold +
    (landIncome * (0.8 + (remainingRounds * 0.35))) +
    (getCachedProfessionalCount(state, meta, playerId) * 1.05) +
    (player.majorTitles.length * 1.45) +
    (getCachedMinorTitleCount(state, meta, playerId) * 0.55) +
    (meta.players[playerId]?.stats?.throneCaptures || 0) * 1.1 -
    (threatenedLoss * 0.3)
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
  const rankIndex = Math.max(0, standings.findIndex(entry => entry.playerId === playerId));
  const leader = standings[0] || { playerId, score: 0 };
  const current = standings[rankIndex] || { playerId, score: 0 };
  const nextAhead = rankIndex > 0 ? standings[rankIndex - 1] : current;
  const nextBehind = standings[rankIndex + 1] || current;
  return {
    rank: rankIndex + 1,
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
    profile.weights.frontier * 0.55 +
    profile.weights.loyalty * 0.15 +
    profile.weights.mercenary * 0.15 +
    getPlayerExposure(state, playerId, meta) * 0.2
  );
}

function getAmbitionScore(meta, playerId) {
  const profile = getPersonalityProfile(meta, playerId);
  return (profile.weights.throne * 0.6) + (profile.weights.capital * 0.25) + (profile.weights.mercenary * 0.15);
}

function getAITemperament(meta, playerId) {
  return {
    independence: meta.players[playerId]?.tactics?.independence ?? 1,
    frontierAlarm: meta.players[playerId]?.tactics?.frontierAlarm ?? 1,
    churchReserve: meta.players[playerId]?.tactics?.churchReserve ?? 1,
    incumbencyGrip: meta.players[playerId]?.tactics?.incumbencyGrip ?? 1,
  };
}

function ensurePlayerLink(meta, playerId, targetId, key, fallback = 0) {
  if (playerId == null || targetId == null || playerId === targetId) return fallback;
  if (meta.players[playerId][key][targetId] == null) {
    meta.players[playerId][key][targetId] = fallback;
  }
  return meta.players[playerId][key][targetId];
}

function decayTowardZero(value, rounds, factor = 0.82) {
  if (!rounds) return value;
  return value * (factor ** rounds);
}

function createSocialMemory(round = 0) {
  return {
    favorCredit: 0,
    harmDebt: 0,
    strategicAlignment: 0,
    reliability: 0,
    opportunism: 0,
    threat: 0,
    lastUpdatedRound: round,
  };
}

function createRecentBehavior(round = 0) {
  return {
    landBuying: 0,
    churchGifting: 0,
    mercenarySpikes: 0,
    revocationFrequency: 0,
    incumbentSupport: 0,
    selfSupport: 0,
    frontierCommitment: 0,
    observations: 0,
    lastUpdatedRound: round,
  };
}

function ensureRecentBehavior(meta, playerId, round = meta.currentRound || 0) {
  const playerMeta = meta.players[playerId];
  if (!playerMeta) return createRecentBehavior(round);
  if (!playerMeta.recentBehavior) {
    playerMeta.recentBehavior = createRecentBehavior(round);
  }
  const behavior = playerMeta.recentBehavior;
  const elapsed = Math.max(0, round - (behavior.lastUpdatedRound || 0));
  if (elapsed > 0) {
    behavior.landBuying = decayTowardZero(behavior.landBuying, elapsed, 0.76);
    behavior.churchGifting = decayTowardZero(behavior.churchGifting, elapsed, 0.76);
    behavior.mercenarySpikes = decayTowardZero(behavior.mercenarySpikes, elapsed, 0.72);
    behavior.revocationFrequency = decayTowardZero(behavior.revocationFrequency, elapsed, 0.74);
    behavior.incumbentSupport = decayTowardZero(behavior.incumbentSupport, elapsed, 0.74);
    behavior.selfSupport = decayTowardZero(behavior.selfSupport, elapsed, 0.74);
    behavior.frontierCommitment = decayTowardZero(behavior.frontierCommitment, elapsed, 0.72);
    behavior.observations = decayTowardZero(behavior.observations, elapsed, 0.8);
    behavior.lastUpdatedRound = round;
  }
  return behavior;
}

function updateRecentBehavior(meta, playerId, deltas = {}, round = meta.currentRound || 0) {
  const behavior = ensureRecentBehavior(meta, playerId, round);
  for (const [key, delta] of Object.entries(deltas)) {
    if (key === 'observations' || !Number.isFinite(delta)) continue;
    behavior[key] = clamp((behavior[key] || 0) + delta, 0, 12);
  }
  behavior.observations = clamp((behavior.observations || 0) + 1, 0, 24);
  behavior.lastUpdatedRound = round;
}

function ensureSocialMemory(meta, playerId, targetId, round = meta.currentRound || 0) {
  if (playerId == null || targetId == null || playerId === targetId) return createSocialMemory(round);
  const playerMeta = meta.players[playerId];
  if (!playerMeta) return createSocialMemory(round);
  if (!playerMeta.social) playerMeta.social = {};
  if (!playerMeta.social[targetId]) {
    playerMeta.social[targetId] = createSocialMemory(round);
  }
  const memory = playerMeta.social[targetId];
  const elapsed = Math.max(0, round - (memory.lastUpdatedRound || 0));
  if (elapsed > 0) {
    memory.favorCredit = decayTowardZero(memory.favorCredit, elapsed, 0.8);
    memory.harmDebt = decayTowardZero(memory.harmDebt, elapsed, 0.84);
    memory.strategicAlignment = decayTowardZero(memory.strategicAlignment, elapsed, 0.78);
    memory.reliability = decayTowardZero(memory.reliability, elapsed, 0.82);
    memory.opportunism = decayTowardZero(memory.opportunism, elapsed, 0.85);
    memory.threat = decayTowardZero(memory.threat, elapsed, 0.8);
    memory.lastUpdatedRound = round;
  }
  return memory;
}

function updateSocialMemory(meta, playerId, targetId, deltas = {}, round = meta.currentRound || 0) {
  if (playerId == null || targetId == null || playerId === targetId) return;
  const memory = ensureSocialMemory(meta, playerId, targetId, round);
  memory.favorCredit = clamp(memory.favorCredit + (Number(deltas.favorCredit) || 0), 0, 8);
  memory.harmDebt = clamp(memory.harmDebt + (Number(deltas.harmDebt) || 0), 0, 8);
  memory.strategicAlignment = clamp(memory.strategicAlignment + (Number(deltas.strategicAlignment) || 0), -4, 4);
  memory.reliability = clamp(memory.reliability + (Number(deltas.reliability) || 0), -3, 6);
  memory.opportunism = clamp(memory.opportunism + (Number(deltas.opportunism) || 0), 0, 6);
  memory.threat = clamp(memory.threat + (Number(deltas.threat) || 0), 0, 8);
  memory.lastUpdatedRound = round;
}

function getRivalSummary(state, meta, observerId, targetId) {
  const round = state?.round ?? meta.currentRound ?? 0;
  const behavior = ensureRecentBehavior(meta, targetId, round);
  const social = ensureSocialMemory(meta, observerId, targetId, round);
  const opponentModel = ensureOpponentModel(meta, observerId, targetId);
  const inferred = blendedOpponentProfile(meta, observerId, targetId);
  const targetStanding = getStandingSnapshot(state, meta, targetId);
  const observerStanding = getStandingSnapshot(state, meta, observerId);
  const likelyThroneAlignment = clamp(
    0.5 +
    (behavior.incumbentSupport * 0.12) -
    (behavior.selfSupport * 0.08) +
    ((opponentModel?.loyaltyEstimate || 0.5) - (opponentModel?.coupRiskEstimate || 0.5)) * 0.45,
    0,
    1
  );
  const likelyFrontierCooperation = clamp(
    ((opponentModel?.frontierCooperationEstimate || 0.5) * 0.55) +
    (behavior.frontierCommitment * 0.08) +
    (inferred.weights.frontier * 0.06),
    0,
    1
  );
  const freeRiderRisk = clamp(
    (1 - likelyFrontierCooperation) * 0.65 +
    (behavior.landBuying * 0.04) +
    (behavior.mercenarySpikes * 0.03),
    0,
    1.5
  );
  const coupAmbition = clamp(
    ((opponentModel?.coupRiskEstimate || 0.5) * 0.55) +
    (behavior.selfSupport * 0.08) +
    (inferred.weights.throne * 0.08) +
    (inferred.weights.capital * 0.05),
    0,
    2
  );
  const patronageValue = clamp(
    (getPlayerInfluence(state, meta, targetId) * 0.1) +
    (social.reliability * 0.35) +
    (likelyThroneAlignment * 0.8) -
    (coupAmbition * 0.3),
    0,
    6
  );
  const currentThreatToMe = clamp(
    Math.max(0, targetStanding.score - observerStanding.score) * 0.18 +
    Math.max(0, observerStanding.rank - targetStanding.rank) * 0.18 +
    (coupAmbition * 0.35) +
    (freeRiderRisk * 0.18),
    0,
    6
  );

  return {
    recentActionProfile: {
      landBuying: roundTo(behavior.landBuying, 3),
      churchGifting: roundTo(behavior.churchGifting, 3),
      mercenarySpikes: roundTo(behavior.mercenarySpikes, 3),
      revocationFrequency: roundTo(behavior.revocationFrequency, 3),
    },
    likelyThroneAlignment,
    likelyFrontierCooperation,
    freeRiderRisk,
    coupAmbition,
    patronageValue,
    currentThreatToMe,
    reliability: clamp(0.5 + (social.reliability * 0.1), 0, 1.5),
    strategicAlignment: clamp(social.strategicAlignment, -2, 2),
  };
}

function getRelationValue(meta, fromId, toId) {
  if (fromId === toId) return 0;
  const trust = ensurePlayerLink(meta, fromId, toId, 'trust', 0);
  const grievance = ensurePlayerLink(meta, fromId, toId, 'grievance', 0);
  const social = ensureSocialMemory(meta, fromId, toId, meta.currentRound || 0);
  return (
    trust -
    grievance +
    (social.favorCredit * 0.7) +
    (social.strategicAlignment * 0.75) +
    (social.reliability * 0.5) -
    (social.harmDebt * 0.95) -
    (social.opportunism * 0.65) -
    (social.threat * 0.8)
  );
}

function getAffinityScore(meta, fromId, toId) {
  if (fromId === toId) {
    return 1 + (getPersonalityProfile(meta, fromId).weights.selfAppointment * 0.25);
  }
  const relation = getRelationValue(meta, fromId, toId);
  // Tier 2: affinitySlope is now an evolvable meta-param (was 0.32)
  const slope = getMetaForPlayer(meta, fromId, 'affinitySlope');
  return clamp(1 + (relation * slope), 0.15, 2.7);
}

function adjustRelation(meta, fromId, toId, trustDelta = 0, grievanceDelta = 0) {
  if (fromId == null || toId == null || fromId === toId) return;
  ensurePlayerLink(meta, fromId, toId, 'trust', 0);
  ensurePlayerLink(meta, fromId, toId, 'grievance', 0);
  meta.players[fromId].trust[toId] = clamp(meta.players[fromId].trust[toId] + trustDelta, -3, 8);
  meta.players[fromId].grievance[toId] = clamp(meta.players[fromId].grievance[toId] + grievanceDelta, 0, 8);
  updateSocialMemory(meta, fromId, toId, {
    favorCredit: Math.max(0, trustDelta) * 0.55,
    harmDebt: Math.max(0, grievanceDelta) * 0.7,
    strategicAlignment: trustDelta * 0.18,
    reliability: trustDelta * 0.12,
    opportunism: grievanceDelta * 0.08,
  });
}

function getObligation(meta, debtorId, creditorId) {
  if (debtorId == null || creditorId == null || debtorId === creditorId) return 0;
  return ensurePlayerLink(meta, debtorId, creditorId, 'obligations', 0);
}

function addObligation(meta, debtorId, creditorId, amount) {
  if (debtorId == null || creditorId == null || debtorId === creditorId || amount <= 0) return;
  ensurePlayerLink(meta, debtorId, creditorId, 'obligations', 0);
  meta.players[debtorId].obligations[creditorId] = clamp(meta.players[debtorId].obligations[creditorId] + amount, 0, 10);
  updateSocialMemory(meta, debtorId, creditorId, {
    favorCredit: amount * 0.25,
    strategicAlignment: amount * 0.08,
  });
}

function reduceObligation(meta, debtorId, creditorId, amount) {
  if (debtorId == null || creditorId == null || debtorId === creditorId || amount <= 0) return;
  ensurePlayerLink(meta, debtorId, creditorId, 'obligations', 0);
  meta.players[debtorId].obligations[creditorId] = clamp(meta.players[debtorId].obligations[creditorId] - amount, 0, 10);
  updateSocialMemory(meta, debtorId, creditorId, {
    favorCredit: -amount * 0.12,
  });
}

function logDecision(meta, message) {
  meta.decisionLog.push(message);
}

function logPublic(meta, message) {
  if (!message || !meta?.sampled) return;
  meta.publicLog.push(message);
  if (meta.publicLog.length > PUBLIC_LOG_LIMIT) {
    meta.publicLog.splice(0, meta.publicLog.length - PUBLIC_LOG_LIMIT);
  }
}

function factor(label, note, impact = 'for', value = null) {
  const entry = { label, note, impact };
  if (value != null) {
    entry.value = typeof value === 'number' ? roundTo(value, 2) : value;
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
  return `${player ? formatPlayerLabel(player) : `Player ${playerId + 1}`} (${profile.shortName})`;
}

function publicActor(state, playerId) {
  const player = getPlayer(state, playerId);
  return player ? formatPlayerLabel(player) : `Player ${playerId + 1}`;
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

  if (options.includeMercenaryCompany && getPlayerMercenaryTotal(state, playerId) > 0) {
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
      factor('Relationship', `${publicActor(state, actorId)} rates ${publicActor(state, option.appointeeId)} at ${roundTo(relation, 2)} affinity.`, relation >= 1 ? 'for' : 'neutral'),
      factor('Debt and repayment', debtRepayment > 0
        ? `This helps repay obligations owed to ${publicActor(state, option.appointeeId)}.`
        : `${publicActor(state, actorId)} was trying to create future loyalty with a new favor.`, debtRepayment > 0 ? 'for' : 'neutral', debtRepayment),
      factor('Coalition fit', sharedCandidate
        ? `Both dynasties were leaning toward the same throne plan this round.`
        : `This appointment was made despite a weaker coalition link.`, sharedCandidate ? 'for' : 'neutral'),
      factor('Ambition risk', `${publicActor(state, option.appointeeId)} carries ${roundTo(ambitionRisk, 2)} ambition pressure.`, ambitionRisk > 1.4 ? 'against' : 'neutral', ambitionRisk),
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
  const cost = getThemeLandPrice(theme);
  const ownerIncome = getNormalOwnerIncome(theme);
  const goldAfter = getPlayer(state, playerId).gold - cost;

  return {
    title: 'AI reasoning',
    factors: [
      factor('Income horizon', `${theme.name} is P${theme.P} T${theme.T} L${theme.L}, yielding ${ownerIncome}g to the owner each round under normal taxation.`, 'for', action.score),
      factor('Catch-up pressure', leaderThemeCount > ownedThemeCount
        ? `${publicActor(state, playerId)} was behind the land leader and needed to close the gap.`
        : `${publicActor(state, playerId)} still valued land growth even without trailing in estates.`, leaderThemeCount > ownedThemeCount ? 'for' : 'neutral'),
      factor('Reserve after purchase', `${goldAfter}g would remain after paying ${cost}g.`, goldAfter < 2 ? 'against' : 'neutral', goldAfter),
      factor('Route risk', `${theme.name} sits at route risk ${roundTo(routeRisk, 2)} while empire danger is ${roundTo(empireDanger, 2)}.`, routeRisk > 0.55 && empireDanger > 1 ? 'against' : 'neutral', routeRisk),
      factor('Estate scarcity', ownedThemeCount === 0
        ? 'Owning no land made the first purchase especially urgent.'
        : `${publicActor(state, playerId)} already held ${ownedThemeCount} theme${ownedThemeCount === 1 ? '' : 's'}.`, ownedThemeCount === 0 ? 'for' : 'neutral'),
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
      factor('Church leverage', `${theme.name} created a church-aligned holding worth ${roundTo(churchWeight, 2)} on this profile.`, 'for', action.score),
      factor('Bishop control', 'Gifting the theme guarantees a bishopric tied to the donor dynasty unless revoked later.', 'for'),
      factor('Opportunity cost', `${remainingRounds} round${remainingRounds === 1 ? '' : 's'} of private income were being sacrificed.`, remainingRounds >= 4 ? 'against' : 'neutral'),
      factor('Estate restraint', `This AI carried a land-preservation pressure of ${roundTo(churchReserve, 2)} before agreeing to donate.`, churchReserve > 1.2 ? 'against' : 'neutral', churchReserve),
      factor('Exposure', `${theme.name} faced route risk ${roundTo(routeRisk, 2)}.`, routeRisk > 0.5 ? 'for' : 'neutral', routeRisk),
    ],
  };
}

function buildRecruitmentDecision(state, meta, playerId, action, candidateId, commitment) {
  const capitalPotential = scoreOfficeDestination(state, meta, playerId, action.office, 1, 'capital', candidateId, commitment);
  const frontierPotential = scoreOfficeDestination(state, meta, playerId, action.office, 1, 'frontier', candidateId, commitment);
  const standing = getStandingSnapshot(state, meta, playerId);
  const player = getPlayer(state, playerId);
  const leaning = capitalPotential > frontierPotential ? 'capital' : 'frontier';

  return {
    title: 'AI reasoning',
    factors: [
      factor('Best office', `${action.office.label} had the best marginal troop value this round.`, 'for', action.score),
      factor('Strategic leaning', `One extra troop was more valuable on the ${leaning} plan (${roundTo(Math.max(capitalPotential, frontierPotential), 2)}).`, 'for'),
      factor('Standings pressure', standing.rank > 1
        ? `${publicActor(state, playerId)} trailed the leader by ${roundTo(standing.gapToLeader, 2)} score and wanted more leverage.`
        : `${publicActor(state, playerId)} still valued military flexibility from the lead.`, standing.rank > 1 ? 'for' : 'neutral'),
      factor('Gold position', `${player.gold}g remained before maintenance.`, player.gold <= 1 ? 'against' : 'neutral', player.gold),
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
      factor('Survival reserve', `The dismissal kept a safer treasury buffer while ${standing.rank === 1 ? 'protecting the lead' : 'avoiding a forced collapse later'}.`, 'for'),
      factor('Scale', `${action.count} troop${action.count === 1 ? '' : 's'} were dismissed from this office.`, 'neutral', action.count),
    ],
  };
}

function buildRevocationDecision(state, meta, basileusId, best) {
  const threat = getThreatLevel(state, meta);
  const targetId = best.targetPlayerId ?? best.revokedPlayerId ?? null;
  const targetStrength = targetId == null ? 0 : getPlayerStrength(state, meta, targetId);
  const basileusStrength = getPlayerStrength(state, meta, basileusId);
  const obligation = targetId == null ? 0 : getObligation(meta, basileusId, targetId);

  return {
    title: 'AI reasoning',
    factors: [
      factor('Target pressure', targetId == null
        ? 'This revocation hit a useful imperial lever rather than a specific dynasty.'
        : `${publicActor(state, targetId)} looked dangerous enough to justify a crackdown.`, 'for', targetStrength - basileusStrength),
      factor('Loyalty debt', obligation > 0
        ? `The Basileus overrode an existing obligation because the revocation still scored higher.`
        : 'There was little reason to spare the target out of loyalty.', obligation > 0 ? 'against' : 'for', obligation),
      factor('Imperial danger', `Current invasion pressure sat at ${roundTo(threat, 2)}.`, threat > 0.85 ? 'against' : 'neutral', threat),
      factor('Replacement value', best.newHolderId != null
        ? `${publicActor(state, best.newHolderId)} looked like a safer replacement.`
        : 'The Basileus preferred removing the asset outright instead of reassigning it.', best.newHolderId != null ? 'for' : 'neutral'),
    ],
  };
}

function buildOrdersDecision(state, meta, playerId, candidateId, pact, officePlans, mercenaries, capitalTroops, frontierTroops, context) {
  const standing = getStandingSnapshot(state, meta, playerId);
  const empireDanger = getEmpireDanger(state, meta);
  const ownStake = getPlayerThreatenedLandValue(state, playerId, meta);
  const rivalStake = getRivalThreatenedLandValue(state, playerId, meta);
  const supportSignal = context.supportSignal[candidateId] || 0;
  const throneNote = pact?.kind === 'self'
    ? `${publicActor(state, playerId)} judged its own claim viable.`
    : pact?.kind === 'defense'
      ? `Empire danger and coalition math favored defending ${publicActor(state, candidateId)}.`
      : `${publicActor(state, playerId)} joined a challenger coalition around ${publicActor(state, candidateId)}.`;
  const keyDeployments = officePlans
    .filter(plan => plan.troopCount > 0)
    .sort((left, right) => Math.abs((right.capitalScore || 0) - (right.frontierScore || 0)) - Math.abs((left.capitalScore || 0) - (left.frontierScore || 0)))
    .slice(0, 2)
    .map(plan => `${plan.office.label} -> ${plan.destination}`)
    .join(', ');
  const mercCount = sum(mercenaries.map(entry => entry.count));
  const mercCost = getMercenaryHireCost(0, mercCount);

  return {
    title: 'AI reasoning',
    factors: [
      factor('Throne plan', throneNote, 'for', supportSignal),
      factor('Standings pressure', standing.rank > 1
        ? `${publicActor(state, playerId)} was chasing a leader gap of ${roundTo(standing.gapToLeader, 2)}.`
        : `${publicActor(state, playerId)} was already leading and leaned more toward preservation.`, standing.rank > 1 ? 'for' : 'neutral'),
      factor('Frontier stake', ownStake >= rivalStake
        ? `Its own threatened estates made frontier defense expensive to ignore.`
        : `More threatened land belonged to rivals, so frontier caution was weaker.`, ownStake >= rivalStake ? 'for' : 'neutral'),
      factor('Troop split', `${capitalTroops} capital troop${capitalTroops === 1 ? '' : 's'} and ${frontierTroops} frontier troop${frontierTroops === 1 ? '' : 's'}; key calls: ${keyDeployments || 'no major offices'}.`, 'neutral'),
      factor('Mercenary spend', mercCount > 0
        ? `Spent ${mercCost}g on mercenaries where marginal troop value was highest.`
        : 'Held gold back because mercenary value stayed below the spending threshold.', mercCount > 0 ? 'for' : 'neutral', mercCount),
      factor('Empire danger', `Overall empire danger was ${roundTo(empireDanger, 2)}.`, empireDanger > 1.1 ? 'for' : 'neutral', empireDanger),
    ],
  };
}

function buildMercenaryDecision(ordersDebug, mercenary, cost) {
  const officePlan = ordersDebug?.officePlans?.find(plan => plan.officeKey === mercenary.anchorOfficeKey);
  const topScore = officePlan ? Math.max(officePlan.capitalScore, officePlan.frontierScore) : null;

  return {
    title: 'AI reasoning',
    factors: [
      factor('Marginal troop value', officePlan
        ? `${officePlan.officeLabel} had the best remaining value on the ${officePlan.destination} line.`
        : 'The mercenary company still had strong value on the best line.', 'for', topScore),
      factor('Strategic plan', ordersDebug?.pactKind === 'defense'
        ? 'The AI was reinforcing a defensive plan around the current Basileus.'
        : ordersDebug?.pactKind === 'self'
          ? 'The AI was pressing its own throne bid with extra force.'
          : 'The AI was reinforcing a coalition challenge with extra force.', 'for'),
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
      weight: preset.weights[personalityId] || 0.01,
    }));

  const totalWeight = sum(pool.map(entry => entry.weight));
  const pickOne = () => {
    if (!pool.length || totalWeight <= 0) return null;
    let cursor = rng() * totalWeight;
    for (const entry of pool) {
      cursor -= entry.weight;
      if (cursor <= 0) return entry.id;
    }
    return pool[pool.length - 1]?.id || null;
  };

  const personalities = [];
  for (let playerId = 0; playerId < playerCount; playerId++) {
    personalities[playerId] = humanIds.has(playerId) ? null : pickOne();
  }
  return personalities;
}

export function invalidateRoundContext(meta) {
  if (!meta) return;
  meta.roundContext = null;
  meta.fastCache = null;
}

export function isAIPlayer(meta, playerId) {
  return !meta.humanPlayerIds.has(playerId);
}

function buildProfileTactics(profile, rng) {
  const variation = () => 0.85 + (rng() * 0.5);
  return {
    independence: clamp((0.95 + (profile.weights.retaliation * 0.12) - (profile.weights.loyalty * 0.05)) * variation(), 0.72, 1.75),
    frontierAlarm: clamp((0.9 + (profile.weights.frontier * 0.18) + (profile.weights.wealth * 0.05)) * variation(), 0.85, 2.15),
    churchReserve: clamp((1.0 + (profile.weights.wealth * 0.12) + (profile.weights.land * 0.1) - (profile.weights.church * 0.12)) * variation(), 0.7, 2.2),
    incumbencyGrip: clamp((0.95 + (profile.weights.throne * 0.16) + (profile.weights.loyalty * 0.08)) * variation(), 0.9, 2.1),
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
      : (customProfile?.id || personalityIds[player.id] || allowedPersonalities[0] || null);
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
      social: {},
      recentBehavior: createRecentBehavior(state.round),
      tactics,
      // Tier 5: per-rival posterior over opponent type. Initialised lazily via
      // ensureOpponentModel() the first time the AI scores against a rival.
      opponentModels: {},
      courtBudget: {
        round: -1,
        landPurchasesRemaining: 0,
        churchGiftsRemaining: 0,
        recruitOpportunitiesSeen: {},
      },
      stats: {
        landBuys: 0,
        themesGifted: 0,
        recruits: 0,
        recruitOpportunities: 0,
        revocations: 0,
        mercSpend: 0,
        mercsHired: 0,
        frontierTroops: 0,
        capitalTroops: 0,
        coupVotes: 0,
        supportIncumbentVotes: 0,
        supportSelfVotes: 0,
        throneCaptures: 0,
      },
    };
  }

  for (const sourcePlayer of state.players) {
    for (const targetPlayer of state.players) {
      if (sourcePlayer.id === targetPlayer.id) continue;
      players[sourcePlayer.id].trust[targetPlayer.id] = 0;
      players[sourcePlayer.id].grievance[targetPlayer.id] = 0;
      players[sourcePlayer.id].obligations[targetPlayer.id] = 0;
      players[sourcePlayer.id].social[targetPlayer.id] = createSocialMemory(state.round);
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
    currentRound: state.round,
    populationPresetId,
    humanPlayerIds,
    profileBasis: [...profileBasisMap.values()],
    publicLog: [],
    roundContext: null,
    decisionLog: createDecisionLog(Boolean(options.sampled)),
    players,
    totals: {
      landBuys: 0,
      gifts: 0,
      recruits: 0,
      recruitOpportunities: 0,
      revocations: 0,
      throneChanges: 0,
      mercSpend: 0,
    },
    wars: [],
    roundSnapshots: [],
  };
}

function ensureCourtBudget(state, meta, playerId) {
  const profile = getPersonalityProfile(meta, playerId);
  const playerMeta = meta.players[playerId];
  if (!playerMeta.courtBudget) {
    playerMeta.courtBudget = {
      round: -1,
      landPurchasesRemaining: 0,
      churchGiftsRemaining: 0,
      recruitOpportunitiesSeen: {},
    };
  }

  if (playerMeta.courtBudget.round !== state.round) {
    playerMeta.courtBudget.round = state.round;
    playerMeta.courtBudget.landPurchasesRemaining = Math.max(1, Math.min(5, Math.round(profile.weights.land + 1)));
    playerMeta.courtBudget.churchGiftsRemaining = 1;
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
  const beneficiaryTitleNeed = clamp(2.25 - candidate.majorTitles.length - (getMinorTitleCount(state, beneficiaryId) * 0.35), 0, 2.5);
  const beneficiaryInfluence = getPlayerInfluence(state, meta, beneficiaryId);

  let value = 0.35 + (candidateOwesBeneficiary * 0.8);
  if (candidateId === state.basileusId) {
    value += 0.95;
    if (!state.courtActions?.basileusAppointed) value += 0.55;
    const revocationsUsed = state.courtActions?.basileusRevocationsUsed || 0;
    if (revocationsUsed === 0) value += 0.2;
  } else {
    value += beneficiaryTitleNeed * 0.75;
    value += Math.max(0, 1.6 - beneficiary.majorTitles.length) * 0.25;
  }
  value += beneficiaryInfluence * 0.06;
  return value;
}

function scoreCandidateBase(state, meta, playerId, candidateId) {
  const profile = getPersonalityProfile(meta, playerId);
  const temperament = getAITemperament(meta, playerId);
  const threat = getThreatLevel(state, meta);
  const empireDanger = getEmpireDanger(state, meta);
  const frontierAlarmDanger = getMeta(profile, 'frontierAlarmDanger');
  const exposure = getPlayerExposure(state, playerId, meta);
  const threatenedValue = getPlayerThreatenedLandValue(state, playerId, meta);
  const playerStrength = getPlayerStrength(state, meta, playerId);
  const candidateStrength = getPlayerStrength(state, meta, candidateId);
  const relation = getAffinityScore(meta, playerId, candidateId);
  const obligationToCandidate = getObligation(meta, playerId, candidateId);
  const candidateOwesPlayer = getObligation(meta, candidateId, playerId);
  const grievanceAgainstBasileus = state.basileusId === playerId ? 0 : ensurePlayerLink(meta, playerId, state.basileusId, 'grievance', 0);
  const ambitionRisk = getAmbitionScore(meta, candidateId);
  const rewardPotential = estimateCandidateRewardPotential(state, meta, candidateId, playerId);
  const remainingRounds = getRemainingRounds(state);
  const myStanding = getStandingSnapshot(state, meta, playerId);
  const candidateStanding = getStandingSnapshot(state, meta, candidateId);
  const basileusStanding = getStandingSnapshot(state, meta, state.basileusId);
  const comebackPressure = Math.max(0, myStanding.gapToLeader);
  const endgamePressure = remainingRounds <= 2 ? 1.15 : remainingRounds <= 4 ? 0.35 : 0;
  const rivalSummary = getRivalSummary(state, meta, playerId, candidateId);
  const dangerWeight = empireDanger * frontierAlarmDanger;

  let score = relation * profile.weights.loyalty;
  score += obligationToCandidate * 1.05;
  score += candidateOwesPlayer * 0.85;
  score += (candidateStrength - playerStrength) * 0.05;
  score += rewardPotential * 0.58;
  score += rivalSummary.patronageValue * 0.18;
  score += rivalSummary.likelyFrontierCooperation * threat * 0.28;
  score -= rivalSummary.currentThreatToMe * 0.22;
  score -= rivalSummary.coupAmbition * 0.18;

  // Tier 2: selfThroneBoost (was 1.85), incumbentGrip (was 2.35),
  // coupGrievanceFactor (was 1.28) are now evolvable meta-params.
  const selfThroneBoost = getMeta(profile, 'selfThroneBoost');
  const incumbentGrip = getMeta(profile, 'incumbentGrip');
  const coupGrievanceFactor = getMeta(profile, 'coupGrievanceFactor');

  if (candidateId === playerId) {
    score += profile.weights.throne * selfThroneBoost;
    score += getPlayerInfluence(state, meta, playerId) * 0.04;
    score += grievanceAgainstBasileus * 0.42;
    score += (comebackPressure * 0.12) + endgamePressure;
    score -= threat * 0.3 * frontierAlarmDanger;
    if (playerId === state.basileusId) {
      score += (incumbentGrip * temperament.incumbencyGrip) + (rewardPotential * 0.32);
      if (myStanding.rank === 1) score += 1.05 + (dangerWeight * 0.28);
      if (empireDanger > 1.05) score += 0.85 + (exposure * 0.28 * frontierAlarmDanger);
    }
    if (myStanding.rank === 1) score -= 0.8 + (dangerWeight * 0.2);
    if (threatenedValue > 0 && empireDanger > 1.15) score -= 0.45;
  } else if (candidateId === state.basileusId) {
    score += 0.95 + (dangerWeight * ((profile.weights.frontier * 0.95) + (exposure * 0.65)));
    score += threatenedValue * 0.06;
    score -= grievanceAgainstBasileus * 0.82;
    if (basileusStanding.rank === 1 && myStanding.rank > 1) {
      score -= 1.25 + (comebackPressure * 0.08);
    }
    if (myStanding.rank === 1) score += 0.85;
    if (empireDanger > 1.05) score += threatenedValue * 0.03;
  } else {
    score += grievanceAgainstBasileus * coupGrievanceFactor;
    score += profile.weights.capital * 1.02;
    score += (comebackPressure * 0.09) + (endgamePressure * 0.55);
    score -= dangerWeight * 0.22;
    if (candidateStanding.rank === 1) {
      score -= 1.55 + (Math.max(0, candidateStanding.leadOverNextBehind) * 0.12);
    }
    if (basileusStanding.rank === 1) score += 0.95;
    if (candidateStanding.rank > myStanding.rank) score += 0.25;
    if (candidateStanding.rank < myStanding.rank) score -= 0.4;
  }

  score -= ambitionRisk * 0.34;
  return score;
}

function getCandidateMomentum(state, meta, candidateId) {
  const standing = getStandingSnapshot(state, meta, candidateId);
  const influence = getPlayerInfluence(state, meta, candidateId);
  const officeWeight = candidateId === state.basileusId ? 1.1 : 0.18;
  const rankPressure = Math.max(0, 3 - standing.rank) * 0.22;
  return (influence * 0.28) + officeWeight + rankPressure;
}

function buildRoundContext(state, meta, stage = 'court') {
  const aiPlayerIds = state.players.filter(player => isAIPlayer(meta, player.id)).map(player => player.id);
  const candidateIds = state.players.map(player => player.id);
  const candidateBaseScores = {};
  const candidateChoice = {};
  const candidateMargins = {};
  const rivalSummaries = {};

  for (const playerId of aiPlayerIds) {
    rivalSummaries[playerId] = {};
    candidateBaseScores[playerId] = {};
    for (const candidateId of candidateIds) {
      rivalSummaries[playerId][candidateId] = getRivalSummary(state, meta, playerId, candidateId);
      updateSocialMemory(meta, playerId, candidateId, {
        threat: rivalSummaries[playerId][candidateId].currentThreatToMe * 0.08,
        strategicAlignment: rivalSummaries[playerId][candidateId].strategicAlignment * 0.04,
      }, state.round);
      candidateBaseScores[playerId][candidateId] = scoreCandidateBase(state, meta, playerId, candidateId);
    }
    const ranked = [...candidateIds]
      .map(candidateId => ({ candidateId, score: candidateBaseScores[playerId][candidateId] }))
      .sort((left, right) => right.score - left.score);
    const supportTemperature = getMetaForPlayer(meta, playerId, 'supportTemperature');
    candidateChoice[playerId] = softmaxPick(ranked.slice(0, 4), supportTemperature, state.rng)?.candidateId ?? ranked[0]?.candidateId ?? playerId;
    candidateMargins[playerId] = (ranked[0]?.score || 0) - (ranked[1]?.score || 0);
  }

  for (let iteration = 0; iteration < 3; iteration++) {
    const supportSignal = Object.fromEntries(candidateIds.map(candidateId => [candidateId, 0]));
    for (const candidateId of candidateIds) {
      supportSignal[candidateId] += getCandidateMomentum(state, meta, candidateId);
    }
    for (const playerId of aiPlayerIds) {
      supportSignal[candidateChoice[playerId]] += getPlayerInfluence(state, meta, playerId);
    }

    const challengerFrontRunner = candidateIds
      .filter(candidateId => candidateId !== state.basileusId)
      .map(candidateId => ({ candidateId, signal: supportSignal[candidateId] }))
      .sort((left, right) => right.signal - left.signal)[0] || { candidateId: state.basileusId, signal: 0 };
    const strongestChallengerSignal = Math.max(
      0,
      ...candidateIds.filter(candidateId => candidateId !== state.basileusId).map(candidateId => supportSignal[candidateId])
    );

    for (const playerId of aiPlayerIds) {
      const profile = getPersonalityProfile(meta, playerId);
      const temperament = getAITemperament(meta, playerId);
      const exposure = getPlayerExposure(state, playerId, meta);
      const threat = getThreatLevel(state, meta);
      const bandwagonStrength = getMeta(profile, 'bandwagonStrength');
      const independenceDamping = getMeta(profile, 'independenceDamping');
      const bandwagonScale = clamp(bandwagonStrength / Math.max(0.8, temperament.independence + independenceDamping), 0.2, 1.8);
      const selfResolve = 0.9 + (temperament.independence * 0.28) + independenceDamping;
      const supportTemperature = getMeta(profile, 'supportTemperature');

      const ranked = candidateIds.map(candidateId => {
        const rivalSummary = rivalSummaries[playerId][candidateId] || getRivalSummary(state, meta, playerId, candidateId);
        let coordination = supportSignal[candidateId] * 0.1 * profile.weights.loyalty * bandwagonScale;
        if (candidateId === challengerFrontRunner.candidateId && candidateId !== state.basileusId) {
          coordination += (0.35 + (challengerFrontRunner.signal * 0.045)) * bandwagonScale;
        }
        if (candidateId === state.basileusId && supportSignal[state.basileusId] >= challengerFrontRunner.signal) {
          coordination += (0.45 + (supportSignal[state.basileusId] * 0.03)) * bandwagonScale;
        }
        if (candidateId === playerId && supportSignal[candidateId] < (challengerFrontRunner.signal * 0.55)) {
          coordination -= 0.55 / selfResolve;
        }
        if (candidateId !== playerId && candidateId !== state.basileusId && supportSignal[candidateId] > supportSignal[playerId]) {
          coordination += 0.24 * bandwagonScale;
        }
        const stabilityBoost = candidateId === state.basileusId
          ? Math.max(0, supportSignal[state.basileusId] - strongestChallengerSignal) * 0.1 + threat * exposure * 0.45
          : Math.max(0, supportSignal[candidateId] - supportSignal[state.basileusId]) * 0.16;
        const obligationBoost = getObligation(meta, playerId, candidateId) * 0.6;
        const repaymentHope = getObligation(meta, candidateId, playerId) * 0.45;
        const momentumBoost = getCandidateMomentum(state, meta, candidateId) * 0.07;
        const reliabilityBoost = rivalSummary.reliability * 0.35;
        const frontierTrustBoost = rivalSummary.likelyFrontierCooperation * threat * 0.45;
        const threatPenalty = rivalSummary.currentThreatToMe * 0.28;
        const freeRiderPenalty = rivalSummary.freeRiderRisk * 0.18;
        const score = candidateBaseScores[playerId][candidateId] + coordination + stabilityBoost + obligationBoost + repaymentHope + momentumBoost + reliabilityBoost + frontierTrustBoost - threatPenalty - freeRiderPenalty;
        return { candidateId, score };
      }).sort((left, right) => right.score - left.score);

      candidateChoice[playerId] = softmaxPick(ranked.slice(0, 4), supportTemperature, state.rng)?.candidateId ?? ranked[0]?.candidateId ?? playerId;
      candidateMargins[playerId] = (ranked[0]?.score || 0) - (ranked[1]?.score || 0);
    }
  }

  const supportersByCandidate = Object.fromEntries(candidateIds.map(candidateId => [candidateId, []]));
  const supportSignal = Object.fromEntries(candidateIds.map(candidateId => [candidateId, 0]));
  for (const playerId of aiPlayerIds) {
    supportersByCandidate[candidateChoice[playerId]].push(playerId);
    supportSignal[candidateChoice[playerId]] += getPlayerInfluence(state, meta, playerId);
  }

  const strongestChallenger = candidateIds
    .filter(candidateId => candidateId !== state.basileusId)
    .map(candidateId => ({ candidateId, signal: supportSignal[candidateId] }))
    .sort((left, right) => right.signal - left.signal)[0] || { candidateId: state.basileusId, signal: 0 };

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
    const endgamePressure = getRemainingRounds(state) <= 2 ? 0.8 : 0;
    const candidateNeed = candidateId === state.basileusId
      ? Math.max(0, strongestChallenger.signal - supportSignal[state.basileusId])
      : Math.max(0, supportSignal[state.basileusId] - supportSignal[candidateId] + 1.5);
    const opportunismDiscount = empireDanger < 1.05 ? Math.max(0, rivalStake - ownStake) * 0.12 : 0;

    pactByPlayer[playerId] = {
      candidateId,
      kind: candidateId === state.basileusId ? 'defense' : (candidateId === playerId ? 'self' : 'coalition'),
      sameCandidateAllies: supporters.filter(otherId => otherId !== playerId),
      commitment: clamp(candidateMargins[playerId] + profile.weights.loyalty * 0.25, 0.2, 4.5),
      capitalBias: Math.max(0, (candidateNeed * 0.32) + (getObligation(meta, playerId, candidateId) * 0.32) + (Math.max(0, standing.gapToLeader) * 0.04) + endgamePressure - (empireDanger * 0.18 * temperament.frontierAlarm)),
      frontierBias: Math.max(0, ((empireDanger * (0.95 + (profile.weights.frontier * 0.82))) + (ownStake * 0.12) + (exposure * 1.05) - opportunismDiscount + (threat * 0.42)) * temperament.frontierAlarm),
      rewardExpectation: estimateCandidateRewardPotential(state, meta, candidateId, playerId),
    };
  }

  return {
    round: state.round,
    stage,
    candidateBaseScores,
    candidateChoice,
    candidateMargins,
    rivalSummaries,
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
  const supportSignal = Object.fromEntries(candidateIds.map(candidateId => [candidateId, 0]));
  const pactByPlayer = {};

  for (const playerId of aiPlayerIds) {
    candidateBaseScores[playerId] = Object.fromEntries(candidateIds.map(candidateId => [candidateId, candidateId === state.basileusId ? 1 : 0]));
    candidateChoice[playerId] = state.basileusId;
    candidateMargins[playerId] = 0;
    supportersByCandidate[state.basileusId].push(playerId);
    supportSignal[state.basileusId] += 1;
    pactByPlayer[playerId] = {
      candidateId: state.basileusId,
      kind: playerId === state.basileusId ? 'self' : 'defense',
      sameCandidateAllies: aiPlayerIds.filter(otherId => otherId !== playerId),
      commitment: 0.2,
      capitalBias: 0,
      frontierBias: 0.6,
      rewardExpectation: 0,
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
    strongestChallengerSignal: 0,
    pactByPlayer,
  };
}

function ensureRoundContext(state, meta, stage = 'court') {
  meta.currentRound = state.round;
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

function markCourtMandatoryActionPassed(state, meta, flagKey, label) {
  if (!state?.courtActions || state.courtActions[flagKey]) return true;
  state.courtActions[flagKey] = true;
  invalidateRoundContext(meta);
  logDecision(meta, `Round ${state.round} court: ${label} could not resolve cleanly and the mandatory slot is forced to pass.`);
  return true;
}

function finalizeCourtAutomation(state, meta, aiOrder) {
  markCourtMandatoryActionPassed(state, meta, 'basileusAppointed', 'The Basileus appointment');
  markCourtMandatoryActionPassed(state, meta, 'domesticEastAppointed', 'The Domestic of the East appointment');
  markCourtMandatoryActionPassed(state, meta, 'domesticWestAppointed', 'The Domestic of the West appointment');
  markCourtMandatoryActionPassed(state, meta, 'admiralAppointed', 'The Admiral appointment');
  markCourtMandatoryActionPassed(state, meta, 'patriarchAppointed', 'The Patriarch appointment');

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

function scoreMinorSlot(state, meta, actorId, type, theme, appointeeId) {
  const actorProfile = getPersonalityProfile(meta, actorId);
  const context = ensureRoundContext(state, meta, 'court');
  const actorPact = context.pactByPlayer[actorId];
  const appointeePact = context.pactByPlayer[appointeeId];
  const threat = getThreatLevel(state, meta);
  const remainingRounds = getRemainingRounds(state);
  const routeRisk = theme ? getThemeRouteRisk(state, theme.id) : 0;
  const appointeeAffinity = getAffinityScore(meta, actorId, appointeeId);
  const appointeeAmbition = getAmbitionScore(meta, appointeeId);
  const appointeeSummary = getRivalSummary(state, meta, actorId, appointeeId);
  const actorOwesAppointee = getObligation(meta, actorId, appointeeId);
  const appointeeOwesActor = getObligation(meta, appointeeId, actorId);
  const sharedCandidate = actorPact && appointeePact && actorPact.candidateId === appointeePact.candidateId;
  const supportLeverage = getPlayerInfluence(state, meta, appointeeId) * 0.16;

  let slotValue = 1.5;
  if (type === 'EMPRESS' || type === 'CHIEF_EUNUCHS') {
    slotValue = 2.05 + (actorProfile.weights.throne * 0.7) + (threat * 0.75);
    const currentHolder = type === 'EMPRESS' ? state.empress : state.chiefEunuchs;
    if (currentHolder != null && currentHolder !== appointeeId) {
      slotValue += Math.max(0, getPlayerStrength(state, meta, currentHolder) - getPlayerStrength(state, meta, actorId)) * 0.08;
    }
  } else if (type === 'STRATEGOS') {
    slotValue = 1.9 + theme.L + (theme.P * 0.25) + (actorProfile.weights.frontier * 0.6) + (threat * 1.15) - (routeRisk * 0.35);
    if (theme.owner === appointeeId) slotValue += 1.15;
    slotValue += getPlayerExposure(state, appointeeId) * 0.3;
  } else if (type === 'BISHOP') {
    slotValue = 1.8 + (theme.P * 0.95) + (actorProfile.weights.church * 0.9) - (routeRisk * 0.2) + (remainingRounds * 0.08);
    if (theme.owner === appointeeId || theme.bishop === appointeeId) slotValue += 0.6;
  }

  const sharedCoalitionBonus = sharedCandidate ? 0.9 : -0.18;
  const debtRepayment = actorOwesAppointee * 1.25;
  const leverageGain = supportLeverage * 0.6 + appointeePact?.capitalBias * 0.25 + (appointeeSummary.patronageValue * 0.22);
  const patronageRetention = appointeeOwesActor * 0.22;
  const selfBias = appointeeId === actorId ? actorProfile.weights.selfAppointment * 0.85 : 0;
  const controlBias = actorProfile.weights.loyalty * appointeeAffinity + (appointeeSummary.reliability * 0.2);
  const riskPenalty = (appointeeAmbition * 0.32) + (appointeeSummary.coupAmbition * 0.18) + (appointeeSummary.currentThreatToMe * 0.1);

  return slotValue + sharedCoalitionBonus + debtRepayment + leverageGain + patronageRetention + selfBias + controlBias - riskPenalty;
}

function registerFavor(meta, actorId, recipientId, amount) {
  adjustRelation(meta, recipientId, actorId, 0.8, 0);
  adjustRelation(meta, actorId, recipientId, 0.22, 0);
  addObligation(meta, recipientId, actorId, amount);
  reduceObligation(meta, actorId, recipientId, amount * 0.4);
  updateSocialMemory(meta, recipientId, actorId, {
    favorCredit: amount * 0.95,
    reliability: amount * 0.35,
    strategicAlignment: amount * 0.2,
  });
  updateSocialMemory(meta, actorId, recipientId, {
    reliability: amount * 0.1,
  });
}

function handleBasileusAppointment(state, meta) {
  const actorId = state.basileusId;
  const themes = Object.values(state.themes).filter(theme => !theme.occupied && theme.id !== 'CPL');
  const options = [];

  for (const appointee of state.players) {
    options.push({ type: 'EMPRESS', appointeeId: appointee.id });
    options.push({ type: 'CHIEF_EUNUCHS', appointeeId: appointee.id });
    for (const theme of themes) {
      if (theme.owner !== 'church') {
        options.push({ type: 'STRATEGOS', themeId: theme.id, appointeeId: appointee.id });
      }
      if (!theme.bishopIsDonor) {
        options.push({ type: 'BISHOP', themeId: theme.id, appointeeId: appointee.id });
      }
    }
  }

  const ranked = options
    .map(option => ({
      ...option,
      score: scoreMinorSlot(state, meta, actorId, option.type, option.themeId ? state.themes[option.themeId] : null, option.appointeeId),
    }))
    .sort((left, right) => right.score - left.score);

  // Tier 6: stochastic court appointment — softmax over the top candidates so
  // training can explore unconventional patronage patterns instead of locking
  // into greedy argmax forever.
  const temperature = getMetaForPlayer(meta, actorId, 'courtTemperature');
  const candidates = ranked.slice(0, 6);
  const orderedAttempts = [softmaxPick(candidates, temperature, state.rng), ...candidates].filter(Boolean);
  const seen = new Set();
  for (const option of orderedAttempts) {
    const key = `${option.type}:${option.themeId || ''}:${option.appointeeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let result = null;
    if (option.type === 'EMPRESS' || option.type === 'CHIEF_EUNUCHS') {
      result = appointCourtTitle(state, option.type, option.appointeeId);
    } else if (option.type === 'STRATEGOS') {
      result = appointStrategos(state, actorId, option.themeId, option.appointeeId);
    } else if (option.type === 'BISHOP') {
      result = appointBishop(state, actorId, option.themeId, option.appointeeId);
    }
    if (!result?.ok) continue;

    state.courtActions.basileusAppointed = true;
    invalidateRoundContext(meta);
    registerFavor(meta, actorId, option.appointeeId, option.type === 'EMPRESS' || option.type === 'CHIEF_EUNUCHS' ? 1.2 : 1.0);
    applyDecisionToResult(state, result, buildMinorAppointmentDecision(state, meta, actorId, option));
    logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, actorId)} appoints ${describeActor(state, meta, option.appointeeId)} to ${option.type}${option.themeId ? ` in ${option.themeId}` : ''}.`);
    logPublic(meta, `${publicActor(state, actorId)} grants ${option.type}${option.themeId ? ` in ${option.themeId}` : ''} to ${publicActor(state, option.appointeeId)}.`);
    return true;
  }

  state.courtActions.basileusAppointed = true;
  invalidateRoundContext(meta);
  return true;
}

function handleRegionalStrategosAppointment(state, meta, titleKey) {
  const actorId = state.players.find(player => player.majorTitles.includes(titleKey))?.id ?? null;
  if (actorId == null) {
    if (titleKey === 'DOM_EAST') return markCourtMandatoryActionPassed(state, meta, 'domesticEastAppointed', 'The Domestic of the East');
    if (titleKey === 'DOM_WEST') return markCourtMandatoryActionPassed(state, meta, 'domesticWestAppointed', 'The Domestic of the West');
    if (titleKey === 'ADMIRAL') return markCourtMandatoryActionPassed(state, meta, 'admiralAppointed', 'The Admiral');
    return true;
  }

  const region = MAJOR_TITLES[titleKey].region;
  const themes = Object.values(state.themes).filter(theme =>
    theme.region === region &&
    !theme.occupied &&
    theme.id !== 'CPL' &&
    theme.owner !== 'church'
  );
  const options = [];
  for (const theme of themes) {
    for (const appointee of state.players) {
      options.push({ themeId: theme.id, appointeeId: appointee.id });
    }
  }

  if (!options.length) {
    state.courtActions[`${titleKey}_appointed`] = true;
    if (titleKey === 'DOM_EAST') state.courtActions.domesticEastAppointed = true;
    if (titleKey === 'DOM_WEST') state.courtActions.domesticWestAppointed = true;
    if (titleKey === 'ADMIRAL') state.courtActions.admiralAppointed = true;
    invalidateRoundContext(meta);
    return true;
  }

  const ranked = options
    .map(option => ({
      ...option,
      score: scoreMinorSlot(state, meta, actorId, 'STRATEGOS', state.themes[option.themeId], option.appointeeId),
    }))
    .sort((left, right) => right.score - left.score);

  for (const option of ranked) {
    const previousHolder = state.themes[option.themeId].strategos;
    const result = appointStrategos(state, actorId, option.themeId, option.appointeeId);
    if (!result?.ok) continue;

    state.courtActions[`${titleKey}_appointed`] = true;
    if (titleKey === 'DOM_EAST') state.courtActions.domesticEastAppointed = true;
    if (titleKey === 'DOM_WEST') state.courtActions.domesticWestAppointed = true;
    if (titleKey === 'ADMIRAL') state.courtActions.admiralAppointed = true;

    invalidateRoundContext(meta);
    registerFavor(meta, actorId, option.appointeeId, 0.95);
    if (previousHolder != null && previousHolder !== option.appointeeId) {
      adjustRelation(meta, previousHolder, actorId, 0, 0.55);
      reduceObligation(meta, actorId, previousHolder, 0.6);
    }
    applyDecisionToResult(state, result, buildMinorAppointmentDecision(state, meta, actorId, { ...option, type: 'STRATEGOS' }));
    logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, actorId)} names ${describeActor(state, meta, option.appointeeId)} strategos of ${option.themeId}.`);
    logPublic(meta, `${publicActor(state, actorId)} names ${publicActor(state, option.appointeeId)} strategos of ${option.themeId}.`);
    return true;
  }

  if (titleKey === 'DOM_EAST') return markCourtMandatoryActionPassed(state, meta, 'domesticEastAppointed', 'The Domestic of the East');
  if (titleKey === 'DOM_WEST') return markCourtMandatoryActionPassed(state, meta, 'domesticWestAppointed', 'The Domestic of the West');
  if (titleKey === 'ADMIRAL') return markCourtMandatoryActionPassed(state, meta, 'admiralAppointed', 'The Admiral');
  return true;
}

function handlePatriarchAppointment(state, meta) {
  const actorId = state.players.find(player => player.majorTitles.includes('PATRIARCH'))?.id ?? null;
  if (actorId == null) return markCourtMandatoryActionPassed(state, meta, 'patriarchAppointed', 'The Patriarch');

  const themes = Object.values(state.themes).filter(theme => !theme.occupied && theme.id !== 'CPL' && !theme.bishopIsDonor);
  const options = [];
  for (const theme of themes) {
    for (const appointee of state.players) {
      options.push({ themeId: theme.id, appointeeId: appointee.id });
    }
  }

  if (!options.length) {
    state.courtActions.patriarchAppointed = true;
    invalidateRoundContext(meta);
    return true;
  }

  const ranked = options
    .map(option => ({
      ...option,
      score: scoreMinorSlot(state, meta, actorId, 'BISHOP', state.themes[option.themeId], option.appointeeId),
    }))
    .sort((left, right) => right.score - left.score);

  for (const option of ranked) {
    const previousHolder = state.themes[option.themeId].bishop;
    const result = appointBishop(state, actorId, option.themeId, option.appointeeId);
    if (!result?.ok) continue;

    state.courtActions.patriarchAppointed = true;
    invalidateRoundContext(meta);
    registerFavor(meta, actorId, option.appointeeId, 1.0);
    if (previousHolder != null && previousHolder !== option.appointeeId) {
      adjustRelation(meta, previousHolder, actorId, 0, 0.45);
      reduceObligation(meta, actorId, previousHolder, 0.45);
    }
    applyDecisionToResult(state, result, buildMinorAppointmentDecision(state, meta, actorId, { ...option, type: 'BISHOP' }));
    logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, actorId)} names ${describeActor(state, meta, option.appointeeId)} bishop of ${option.themeId}.`);
    logPublic(meta, `${publicActor(state, actorId)} names ${publicActor(state, option.appointeeId)} bishop of ${option.themeId}.`);
    return true;
  }

  return markCourtMandatoryActionPassed(state, meta, 'patriarchAppointed', 'The Patriarch');
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
  const cost = getThemeLandPrice(theme);
  const ownerIncome = getNormalOwnerIncome(theme);
  const player = getPlayer(state, playerId);
  const incomeHorizon = getMeta(profile, 'incomeHorizonBase') + (remainingRounds * getMeta(profile, 'incomeHorizonGrowth'));
  const treasuryAfter = player.gold - cost;
  const diminishingReturns = Math.max(0, ownedThemeCount - 1) * (0.65 + (profile.weights.land * 0.08));
  const privateValue = (ownerIncome * (1.25 + (incomeHorizon * 1.55))) + (theme.L * 0.18) + (remainingRounds * profile.weights.wealth * 0.08);
  const landControl = profile.weights.land * 0.78;
  const cheapness = (4 - cost) * 0.28;
  const scarcityBonus = ownedThemeCount === 0 ? 1.6 : Math.max(0, 2 - ownedThemeCount) * 0.7;
  const catchUpBonus = Math.max(0, leaderThemeCount - ownedThemeCount) * 0.32;
  const churchOptionality = profile.weights.church * theme.P * 0.14;
  const reservePenalty = treasuryAfter < 2 ? (1.1 + (empireDanger * 0.4)) : treasuryAfter < 4 ? 0.35 + (empireDanger * 0.12) : 0;
  const dangerPenalty = routeRisk * empireDanger * (0.55 + (profile.weights.frontier * 0.08));
  const selfProtection = exposure > 0 ? theme.L * 0.12 : 0;
  const zeroIncomeRelief = getPlayerIncomePotential(state, playerId, meta) === 0 ? 1.1 : 0;
  return privateValue + landControl + cheapness + scarcityBonus + catchUpBonus + churchOptionality + selfProtection + zeroIncomeRelief - (cost * 0.82) - reservePenalty - dangerPenalty - diminishingReturns;
}

function scoreChurchGift(state, meta, playerId, theme) {
  const profile = getPersonalityProfile(meta, playerId);
  const temperament = getAITemperament(meta, playerId);
  const remainingRounds = getRemainingRounds(state);
  const empireDanger = getEmpireDanger(state, meta);
  const ownedThemeCount = getPlayerThemes(state, playerId).length;
  const threatenedValue = getPlayerThreatenedLandValue(state, playerId, meta);
  const ownerIncome = getThemeOwnerIncome(theme);
  const incomeHorizon = getMeta(profile, 'incomeHorizonBase') + (remainingRounds * getMeta(profile, 'incomeHorizonGrowth'));
  const routeRisk = getThemeRouteRisk(state, theme.id);
  const keepsValue =
    (remainingRounds * profile.weights.wealth * 0.42) +
    (ownerIncome * (1.2 + (incomeHorizon * 0.95) + (profile.weights.land * 0.18))) +
    (ownedThemeCount <= 1 ? 1.1 : ownedThemeCount <= 2 ? 0.45 : 0);
  const churchValue = (theme.P * profile.weights.church * 1.18) + (theme.T * 0.25) + 0.8;
  const patriarchBonus = getPlayer(state, playerId).majorTitles.includes('PATRIARCH') ? 1.2 : 0;
  const bishopLockBonus = 0.75 + (profile.weights.church * 0.34);
  const routeRiskRelief = routeRisk * (0.85 + (empireDanger * 0.28));
  const dangerRelief = threatenedValue * 0.018;
  const saturationBonus = Math.max(0, ownedThemeCount - 2) * 0.32;
  const reservePenalty = temperament.churchReserve * (0.85 + (threatenedValue * 0.01));
  return churchValue + patriarchBonus + bishopLockBonus + routeRiskRelief + dangerRelief + saturationBonus - keepsValue - reservePenalty;
}

function findBestRecruitmentAction(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  const offices = getOfficeList(state, playerId);
  const profile = getPersonalityProfile(meta, playerId);
  const commitment = ensureRoundContext(state, meta, 'court').pactByPlayer[playerId];
  const standing = getStandingSnapshot(state, meta, playerId);
  const candidateId = commitment?.candidateId ?? state.basileusId;
  let best = null;

  for (const office of offices) {
    noteRecruitOpportunity(state, meta, playerId, office.key);
    if (!canRecruitProfessional(state, playerId, office.key).ok) continue;

    const capitalPotential = scoreOfficeDestination(state, meta, playerId, office, 1, 'capital', candidateId, commitment);
    const frontierPotential = scoreOfficeDestination(state, meta, playerId, office, 1, 'frontier', candidateId, commitment);
    const score =
      (Math.max(capitalPotential, frontierPotential) * 0.38) +
      (profile.weights.mercenary * 0.35) +
      (standing.rank > 1 ? standing.gapToLeader * 0.03 : 0) -
      (player.gold <= 0 ? 0.3 : 0.05);

    if (!best || score > best.score) {
      best = { kind: 'recruit', office, score };
    }
  }

  return best;
}

function runRecruitmentStrategy(state, meta, playerId, plannedAction = null) {
  const action = plannedAction || findBestRecruitmentAction(state, meta, playerId);
  // Tier 2: evolvable recruitment threshold (was 1.10)
  const threshold = getMetaForPlayer(meta, playerId, 'recruitThreshold');
  if (!action || action.score <= threshold) return false;
  const commitment = ensureRoundContext(state, meta, 'court').pactByPlayer[playerId];
  const candidateId = commitment?.candidateId ?? state.basileusId;

  const result = recruitProfessional(state, playerId, action.office.key);
  if (!result?.ok) return false;

  invalidateRoundContext(meta);
  meta.players[playerId].stats.recruits++;
  meta.totals.recruits++;
  updateRecentBehavior(meta, playerId, { frontierCommitment: 0.35 }, state.round);
  applyDecisionToResult(state, result, buildRecruitmentDecision(state, meta, playerId, action, candidateId, commitment));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} recruits 1 professional troop for ${action.office.key}.`);
  logPublic(meta, `${publicActor(state, playerId)} recruits a professional troop for ${action.office.key}.`);
  return true;
}

function estimateProjectedIncomeBuffer(state, playerId) {
  const player = getPlayer(state, playerId);
  const baseLandIncome = getPlayerThemes(state, playerId).reduce(
    (total, theme) => total + getThemeOwnerIncome(theme),
    0
  );
  const officeIncome = (player.majorTitles.length * 0.9) + (getMinorTitleCount(state, playerId) * 0.45) + (playerId === state.basileusId ? 2.3 : 0);
  return baseLandIncome + officeIncome;
}

function findBestDismissalAction(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  const maintenance = getPlayerProfessionalCount(player);
  if (maintenance <= 0) return null;

  const temperament = getAITemperament(meta, playerId);
  const threat = getThreatLevel(state, meta);
  const empireDanger = getEmpireDanger(state, meta);
  const standing = getStandingSnapshot(state, meta, playerId);
  const reserveTarget = 2.5 + (standing.rank === 1 ? 1 : 0) + (threat > 0.95 ? 1 : 0);
  const projectedBuffer = estimateProjectedIncomeBuffer(state, playerId);
  const immediateStrain = maintenance - Math.max(0, player.gold - reserveTarget);
  const longTermStrain = maintenance - Math.max(2, projectedBuffer + (player.gold * 0.2));

  if (immediateStrain <= 0.2 && (longTermStrain <= 1 || empireDanger > 1.05)) {
    return null;
  }

  const pact = ensureRoundContext(state, meta, 'court').pactByPlayer[playerId];
  const candidateId = pact?.candidateId ?? state.basileusId;
  const rankedOffices = getOfficeList(state, playerId)
    .map((office) => {
      const count = player.professionalArmies[office.key] || 0;
      if (count <= 0) return null;
      const capitalValue = scoreOfficeDestination(state, meta, playerId, office, 1, 'capital', candidateId, pact);
      const frontierValue = scoreOfficeDestination(state, meta, playerId, office, 1, 'frontier', candidateId, pact);
      return {
        office,
        count,
        marginalValue: Math.max(capitalValue, frontierValue),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.marginalValue - right.marginalValue);

  const weakestOffice = rankedOffices[0];
  if (!weakestOffice) return null;

  const targetCuts = Math.max(immediateStrain, longTermStrain * 0.7);
  const count = Math.max(1, Math.min(weakestOffice.count, Math.ceil(targetCuts / Math.max(0.9, temperament.frontierAlarm))));
  const score = (targetCuts * 1.1) - (weakestOffice.marginalValue * 0.28) - (empireDanger * 0.25);
  // Tier 2: evolvable dismissal threshold (was 0.75)
  const threshold = getMetaForPlayer(meta, playerId, 'dismissalThreshold');
  if (score <= threshold) return null;

  return {
    kind: 'dismiss',
    office: weakestOffice.office,
    count,
    score,
    maintenanceBefore: maintenance,
  };
}

function runDismissalStrategy(state, meta, playerId, plannedAction = null) {
  const action = plannedAction || findBestDismissalAction(state, meta, playerId);
  if (!action) return false;

  const result = dismissProfessional(state, playerId, action.office.key, action.count);
  if (!result?.ok) return false;

  invalidateRoundContext(meta);
  applyDecisionToResult(state, result, buildDismissalDecision(state, meta, playerId, action));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} dismisses ${action.count} troop${action.count === 1 ? '' : 's'} from ${action.office.key}.`);
  logPublic(meta, `${publicActor(state, playerId)} dismisses ${action.count} troop${action.count === 1 ? '' : 's'} from ${action.office.key}.`);
  return true;
}

function findBestLandPurchaseAction(state, meta, playerId) {
  const budget = ensureCourtBudget(state, meta, playerId);
  if (budget.landPurchasesRemaining <= 0) return null;

  const player = getPlayer(state, playerId);
  return getFreeThemes(state)
    .map(theme => ({ kind: 'buy', theme, score: scoreLandPurchase(state, meta, playerId, theme) }))
    .filter(entry => getThemeLandPrice(entry.theme) <= player.gold)
    .sort((left, right) => right.score - left.score)[0] || null;
}

function runLandStrategy(state, meta, playerId, plannedAction = null) {
  const budget = ensureCourtBudget(state, meta, playerId);
  if (budget.landPurchasesRemaining <= 0) return false;

  const action = plannedAction || findBestLandPurchaseAction(state, meta, playerId);
  // Tier 2: evolvable land-purchase threshold (was 0.15)
  const threshold = getMetaForPlayer(meta, playerId, 'landPurchaseThreshold');
  if (!action || action.score <= threshold) return false;

  const result = buyTheme(state, playerId, action.theme.id);
  if (!result?.ok) return false;

  invalidateRoundContext(meta);
  budget.landPurchasesRemaining--;
  meta.players[playerId].stats.landBuys++;
  meta.totals.landBuys++;
  updateRecentBehavior(meta, playerId, { landBuying: 1 }, state.round);
  applyDecisionToResult(state, result, buildLandPurchaseDecision(state, meta, playerId, action));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} buys ${action.theme.id} for ${getThemeLandPrice(action.theme)}g (score ${roundTo(action.score, 2)}).`);
  logPublic(meta, `${publicActor(state, playerId)} buys ${action.theme.id}.`);
  return true;
}

function findBestChurchGiftAction(state, meta, playerId) {
  const budget = ensureCourtBudget(state, meta, playerId);
  if (budget.churchGiftsRemaining <= 0) return null;

  return getPlayerThemes(state, playerId)
    .map(theme => ({ kind: 'gift', theme, score: scoreChurchGift(state, meta, playerId, theme) }))
    .sort((left, right) => right.score - left.score)[0] || null;
}

function runChurchGiftStrategy(state, meta, playerId, plannedAction = null) {
  const budget = ensureCourtBudget(state, meta, playerId);
  if (budget.churchGiftsRemaining <= 0) return false;

  const action = plannedAction || findBestChurchGiftAction(state, meta, playerId);
  // Tier 2: evolvable church-gift threshold (was 2.75)
  const threshold = getMetaForPlayer(meta, playerId, 'churchGiftThreshold');
  if (!action || action.score <= threshold) return false;

  const previousBishop = state.themes[action.theme.id].bishop;
  const result = giftToChurch(state, playerId, action.theme.id);
  if (!result?.ok) return false;

  invalidateRoundContext(meta);
  budget.churchGiftsRemaining--;
  meta.players[playerId].stats.themesGifted++;
  meta.totals.gifts++;
  updateRecentBehavior(meta, playerId, { churchGifting: 1 }, state.round);
  if (previousBishop != null && previousBishop !== playerId) {
    adjustRelation(meta, previousBishop, playerId, 0, 0.35);
  }
  applyDecisionToResult(state, result, buildChurchGiftDecision(state, meta, playerId, action));
  logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} gifts ${action.theme.id} to the church (score ${roundTo(action.score, 2)}).`);
  logPublic(meta, `${publicActor(state, playerId)} gifts ${action.theme.id} to the church.`);
  return true;
}

function takeOneStrategicCourtAction(state, meta, playerId) {
  const options = [
    findBestRecruitmentAction(state, meta, playerId),
    findBestLandPurchaseAction(state, meta, playerId),
    findBestChurchGiftAction(state, meta, playerId),
    findBestDismissalAction(state, meta, playerId),
    findBestMercenaryAction(state, meta, playerId),
    playerId === state.basileusId ? findBestRevocationAction(state, meta, playerId) : null,
  ]
    .filter(Boolean)
    .map(action => ({
      ...action,
      selectionScore: normalizeCourtActionScore(meta, playerId, action),
    }))
    .filter(action => action.selectionScore > 0)
    .sort((left, right) => right.selectionScore - left.selectionScore || right.score - left.score);

  const best = softmaxPick(options.slice(0, 6), getMetaForPlayer(meta, playerId, 'courtTemperature'), state.rng);
  if (!best) return false;
  if (best.kind === 'recruit') return runRecruitmentStrategy(state, meta, playerId, best);
  if (best.kind === 'buy') return runLandStrategy(state, meta, playerId, best);
  if (best.kind === 'gift') return runChurchGiftStrategy(state, meta, playerId, best);
  if (best.kind === 'dismiss') return runDismissalStrategy(state, meta, playerId, best);
  if (best.kind === 'mercenaries') return runMercenaryStrategy(state, meta, playerId, best);
  if (best.kind === 'revoke') return handleBasileusRevocation(state, meta, best);
  return false;
}

function buildRevocationOptions(state, meta, basileusId) {
  const options = [];
  const profile = getPersonalityProfile(meta, basileusId);
  const basileusStrength = getPlayerStrength(state, meta, basileusId);
  const context = ensureRoundContext(state, meta, 'court');
  const threat = getThreatLevel(state, meta);

  for (const player of state.players) {
    if (player.id === basileusId) continue;

    for (const titleKey of player.majorTitles) {
      for (const candidate of state.players) {
        if (candidate.id === basileusId || candidate.id === player.id) continue;
        const targetSummary = getRivalSummary(state, meta, basileusId, player.id);
        const replacementSummary = getRivalSummary(state, meta, basileusId, candidate.id);
        const targetThreat = getPlayerStrength(state, meta, player.id) - basileusStrength;
        const loyaltyGain = getAffinityScore(meta, basileusId, candidate.id) * 1.2;
        const stability = titleKey === 'PATRIARCH'
          ? getPersonalityProfile(meta, candidate.id).weights.church
          : getCompetenceScore(state, meta, candidate.id);
        let score = (targetThreat * 0.22) + (targetSummary.currentThreatToMe * 0.28) + (profile.weights.revocation * 1.3) + loyaltyGain + (stability * 0.32) + (replacementSummary.reliability * 0.35) - (getAmbitionScore(meta, candidate.id) * 0.42);
        score -= getObligation(meta, basileusId, player.id) * 1.6;
        score -= getObligation(meta, candidate.id, basileusId) * 0.2;
        if (context.pactByPlayer[player.id]?.candidateId === basileusId) score -= 2.4;
        if (threat > 0.85) score -= 0.9;
        options.push({
          kind: 'major',
          revokedPlayerId: player.id,
          newHolderId: candidate.id,
          titleKey,
          score,
        });
      }
    }

    const wealthLead = getPlayer(state, player.id).gold - getPlayer(state, basileusId).gold;
    const targetSummary = getRivalSummary(state, meta, basileusId, player.id);
    for (const theme of getPlayerThemes(state, player.id)) {
      let score = (wealthLead * 0.35) + (targetSummary.currentThreatToMe * 0.24) + profile.weights.revocation + (theme.P * 0.25) + (theme.L * 0.25);
      score -= getObligation(meta, basileusId, player.id) * 1.25;
      if (context.pactByPlayer[player.id]?.candidateId === basileusId) score -= 1.8;
      if (getThemeRouteRisk(state, theme.id) > 0.6 && threat > 0.75) score -= 0.7;
      options.push({
        kind: 'theme',
        themeId: theme.id,
        targetPlayerId: player.id,
        score,
      });
    }
  }

  for (const theme of Object.values(state.themes)) {
    if (theme.occupied) continue;
    if (theme.strategos != null) {
      const targetSummary = getRivalSummary(state, meta, basileusId, theme.strategos);
      let score = (getPlayerStrength(state, meta, theme.strategos) - basileusStrength) * 0.18 + (targetSummary.currentThreatToMe * 0.2) + profile.weights.revocation + theme.L;
      score -= getObligation(meta, basileusId, theme.strategos) * 1.15;
      if (context.pactByPlayer[theme.strategos]?.candidateId === basileusId) score -= 1.7;
      options.push({
        kind: 'minor',
        themeId: theme.id,
        titleType: 'strategos',
        targetPlayerId: theme.strategos,
        score,
      });
    }
    if (theme.bishop != null) {
      const targetSummary = getRivalSummary(state, meta, basileusId, theme.bishop);
      let score = (getPlayerStrength(state, meta, theme.bishop) - basileusStrength) * 0.12 + (targetSummary.currentThreatToMe * 0.14) + profile.weights.revocation + (theme.P * 0.8);
      score -= getObligation(meta, basileusId, theme.bishop) * 1.1;
      if (context.pactByPlayer[theme.bishop]?.candidateId === basileusId) score -= 1.5;
      options.push({
        kind: 'minor',
        themeId: theme.id,
        titleType: 'bishop',
        targetPlayerId: theme.bishop,
        score,
      });
    }
    if (theme.taxExempt) {
      options.push({
        kind: 'exempt',
        themeId: theme.id,
        score: profile.weights.revocation + (theme.P * 0.8),
      });
    }
  }

  if (state.empress != null) {
    let score = profile.weights.revocation + (getPlayerStrength(state, meta, state.empress) - basileusStrength) * 0.15;
    score -= getObligation(meta, basileusId, state.empress) * 1.1;
    if (context.pactByPlayer[state.empress]?.candidateId === basileusId) score -= 1.6;
    options.push({
      kind: 'court',
      titleType: 'EMPRESS',
      targetPlayerId: state.empress,
      score,
    });
  }
  if (state.chiefEunuchs != null) {
    let score = profile.weights.revocation + (getPlayerStrength(state, meta, state.chiefEunuchs) - basileusStrength) * 0.15;
    score -= getObligation(meta, basileusId, state.chiefEunuchs) * 1.1;
    if (context.pactByPlayer[state.chiefEunuchs]?.candidateId === basileusId) score -= 1.6;
    options.push({
      kind: 'court',
      titleType: 'CHIEF_EUNUCHS',
      targetPlayerId: state.chiefEunuchs,
      score,
    });
  }

  return options.sort((left, right) => right.score - left.score);
}

function handleBasileusRevocation(state, meta, plannedAction = null) {
  const basileusId = state.basileusId;
  // Each revocation costs more troops than the last. Skip the action entirely if
  // the Basileus does not have enough troops left to pay the next cost.
  const costCheck = canPayRevocationCost(state);
  if (!costCheck.ok) return false;
  const best = plannedAction?.revocation || findBestRevocationAction(state, meta, basileusId)?.revocation;
  if (!best) return false;

  let result = null;
  if (best.kind === 'major') {
    result = revokeMajorTitle(state, best.revokedPlayerId, best.titleKey, best.newHolderId);
    if (result?.ok) {
      adjustRelation(meta, best.revokedPlayerId, basileusId, 0, 1.4);
      adjustRelation(meta, best.newHolderId, basileusId, 0.7, 0);
      addObligation(meta, best.newHolderId, basileusId, 0.9);
      reduceObligation(meta, basileusId, best.revokedPlayerId, 0.8);
      logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, basileusId)} revokes ${best.titleKey} from ${describeActor(state, meta, best.revokedPlayerId)} and hands it to ${describeActor(state, meta, best.newHolderId)}.`);
      logPublic(meta, `${publicActor(state, basileusId)} revokes ${best.titleKey} from ${publicActor(state, best.revokedPlayerId)} and grants it to ${publicActor(state, best.newHolderId)}.`);
    }
  } else if (best.kind === 'minor') {
    result = revokeMinorTitle(state, best.themeId, best.titleType);
    if (result?.ok && best.targetPlayerId != null) {
      adjustRelation(meta, best.targetPlayerId, basileusId, 0, 0.95);
      reduceObligation(meta, basileusId, best.targetPlayerId, 0.6);
      logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, basileusId)} revokes the ${best.titleType} of ${best.themeId}.`);
      logPublic(meta, `${publicActor(state, basileusId)} revokes the ${best.titleType} of ${best.themeId}.`);
    }
  } else if (best.kind === 'theme') {
    result = revokeTheme(state, best.themeId);
    if (result?.ok && best.targetPlayerId != null) {
      adjustRelation(meta, best.targetPlayerId, basileusId, 0, 1.15);
      reduceObligation(meta, basileusId, best.targetPlayerId, 0.75);
      logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, basileusId)} strips ${best.themeId} from ${describeActor(state, meta, best.targetPlayerId)}.`);
      logPublic(meta, `${publicActor(state, basileusId)} strips ${best.themeId} from ${publicActor(state, best.targetPlayerId)}.`);
    }
  } else if (best.kind === 'exempt') {
    result = revokeTaxExemption(state, best.themeId);
    if (result?.ok) {
      logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, basileusId)} revokes the tax exemption of ${best.themeId}.`);
      logPublic(meta, `${publicActor(state, basileusId)} revokes the tax exemption of ${best.themeId}.`);
    }
  } else if (best.kind === 'court') {
    result = revokeCourtTitle(state, best.titleType);
    if (result?.ok && best.targetPlayerId != null) {
      adjustRelation(meta, best.targetPlayerId, basileusId, 0, 0.8);
      reduceObligation(meta, basileusId, best.targetPlayerId, 0.5);
      logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, basileusId)} revokes the ${best.titleType} court title.`);
      logPublic(meta, `${publicActor(state, basileusId)} revokes the ${best.titleType} court title.`);
    }
  }

  if (result?.ok) {
    applyDecisionToResult(state, result, buildRevocationDecision(state, meta, basileusId, best));
    meta.players[basileusId].stats.revocations++;
    meta.totals.revocations++;
    updateRecentBehavior(meta, basileusId, { revocationFrequency: 1 }, state.round);
    invalidateRoundContext(meta);
    return true;
  }

  return false;
}

function scoreOfficeDestination(state, meta, playerId, office, troopCount, destination, candidateId, pact) {
  const profile = getPersonalityProfile(meta, playerId);
  const temperament = getAITemperament(meta, playerId);
  const threat = getThreatLevel(state, meta);
  const empireDanger = getEmpireDanger(state, meta);
  const frontierAlarmDanger = getMeta(profile, 'frontierAlarmDanger');
  const candidateAffinity = getAffinityScore(meta, playerId, candidateId);
  const exposure = getPlayerExposure(state, playerId, meta);
  const ownStake = getPlayerThreatenedLandValue(state, playerId, meta);
  const rivalStake = getRivalThreatenedLandValue(state, playerId, meta);
  const officeRouteRisk = office.themeId ? getThemeRouteRisk(state, office.themeId) : 0;
  const coalitionNeed = pact?.capitalBias || 0;
  const standing = getStandingSnapshot(state, meta, playerId);
  const basileusStanding = getStandingSnapshot(state, meta, state.basileusId);
  const candidateStanding = getStandingSnapshot(state, meta, candidateId);
  const endgamePressure = getRemainingRounds(state) <= 2 ? 0.6 : 0;
  const rivalSummary = getRivalSummary(state, meta, playerId, candidateId);
  const dangerWeight = empireDanger * frontierAlarmDanger;

  if (destination === 'frontier') {
    let score = troopCount * ((profile.weights.frontier * (1.05 + (dangerWeight * temperament.frontierAlarm))) + 0.55);
    score += exposure * (0.9 + (0.22 * temperament.frontierAlarm));
    score += ownStake * 0.12;
    score += dangerWeight * (1.05 + (0.45 * temperament.frontierAlarm));
    score += threat * (0.55 + (0.4 * temperament.frontierAlarm));
    score += rivalSummary.likelyFrontierCooperation * 0.45;
    score -= rivalSummary.freeRiderRisk * 0.12;
    if (office.key.startsWith('STRAT_')) score += 0.95;
    if (officeRouteRisk > 0) score += officeRouteRisk * (2 + (0.65 * temperament.frontierAlarm));
    if (office.region && getPlayerThemes(state, playerId).some(theme => theme.region === office.region)) score += 0.7;
    if (candidateId === state.basileusId) score += 0.35;
    if (empireDanger > 1.15) score += troopCount * 0.5;
    if (standing.rank > 1 && empireDanger < 1.05 && rivalStake > ownStake) {
      score -= (rivalStake - ownStake) * 0.08;
    }
    if (standing.rank > 1 && basileusStanding.rank === 1 && candidateId !== state.basileusId) score -= 0.2;
    return score;
  }

  let score = troopCount * ((profile.weights.capital * 0.96) + (profile.weights.throne * 0.82) + (candidateAffinity * 0.45));
  score += coalitionNeed * (1.55 / Math.max(0.8, temperament.independence));
  score += getObligation(meta, playerId, candidateId) * 0.8;
  score += Math.max(0, standing.gapToLeader) * 0.07;
  score += endgamePressure;
  score += rivalSummary.patronageValue * 0.18;
  score -= rivalSummary.currentThreatToMe * 0.12;
  if (candidateId === playerId) score += troopCount * 1.6;
  if (candidateId === state.basileusId) score += troopCount * 0.62 + (standing.rank === 1 ? 0.5 : 0);
  if (candidateId !== state.basileusId && basileusStanding.rank === 1) score += troopCount * 0.58;
  if (candidateId !== playerId && candidateStanding.rank === 1) score -= troopCount * 0.55;
  if (empireDanger > 1.05) score -= troopCount * (0.28 + (0.22 * temperament.frontierAlarm * frontierAlarmDanger));
  if (empireDanger > 1.2 && candidateId !== state.basileusId) score -= troopCount * 0.45;
  if (exposure > 1.25 && empireDanger > 1.1) score -= exposure * 0.58;
  return score;
}

function planMercenaries(state, meta, playerId, officePlans, pact) {
  const profile = getPersonalityProfile(meta, playerId);
  const remainingRounds = getRemainingRounds(state);
  const incomeHorizon = getMeta(profile, 'incomeHorizonBase') + (remainingRounds * getMeta(profile, 'incomeHorizonGrowth'));
  const goldOpportunity = profile.weights.wealth * (0.75 + (incomeHorizon * 0.38));
  const threat = getThreatLevel(state, meta);
  const threshold = getMeta(profile, 'mercenaryThreshold');
  let availableGold = getPlayer(state, playerId).gold;
  let totalPlannedMercenaries = getPlayerMercenaryTotal(state, playerId);

  const rankedOffices = officePlans
    .filter(plan => !plan.capitalLocked)
    .map(plan => ({ ...plan, baseValue: Math.max(plan.frontierScore, plan.capitalScore) }))
    .sort((left, right) => right.baseValue - left.baseValue);

  const bestOffice = rankedOffices[0];
  if (!bestOffice) return [];

  const maxMercenaries = Math.max(1, Math.min(5, Math.ceil(profile.weights.mercenary + ((pact?.capitalBias || 0) * 0.35))));
  let count = 0;

  while (count < maxMercenaries) {
    const nextCost = getMercenaryHireCost(totalPlannedMercenaries, 1);
    if (availableGold < nextCost) break;
    const crisisDemand = (pact?.capitalBias || 0) + (pact?.frontierBias || 0) + threat;
    const marginalValue = (bestOffice.baseValue * (0.4 + (profile.weights.mercenary * 0.24) + (crisisDemand * 0.1))) - goldOpportunity - (count * 0.72);
    if (marginalValue <= threshold) break;
    availableGold -= nextCost;
    count++;
    totalPlannedMercenaries++;
  }

  return count > 0 ? [{
    officeKey: MERCENARY_COMPANY_KEY,
    count,
    anchorOfficeKey: bestOffice.office.key,
  }] : [];
}

function findBestMercenaryAction(state, meta, playerId) {
  const context = ensureRoundContext(state, meta, 'court');
  const pact = context.pactByPlayer[playerId];
  const candidateId = pact?.candidateId ?? state.basileusId;
  const { officePlans } = planOfficeDeployments(state, meta, playerId, candidateId, pact);
  const mercenaryPlan = planMercenaries(state, meta, playerId, officePlans, pact);
  if (!mercenaryPlan.length) return null;

  const count = mercenaryPlan.reduce((total, entry) => total + (entry.count || 0), 0);
  const baseValue = Math.max(0, ...officePlans.map(plan => Math.max(plan.frontierScore, plan.capitalScore)));
  return {
    kind: 'mercenaries',
    mercenaryPlan,
    officePlans,
    candidateId,
    pact,
    score: (baseValue * 0.78) + (count * 0.65),
  };
}

function findBestRevocationAction(state, meta, basileusId) {
  if (basileusId !== state.basileusId) return null;
  const costCheck = canPayRevocationCost(state);
  if (!costCheck.ok) return null;
  const threshold = getMetaForPlayer(meta, basileusId, 'revocationThreshold') + (costCheck.cost - 1) * 0.85;
  const ranked = buildRevocationOptions(state, meta, basileusId);
  const plausible = ranked.filter(option => option.score > threshold).slice(0, 6);
  const selected = softmaxPick(plausible, getMetaForPlayer(meta, basileusId, 'courtTemperature'), state.rng);
  if (!selected) return null;
  return {
    kind: 'revoke',
    score: selected.score,
    revocation: selected,
  };
}

function getMercCount(mercenaries, officeKey) {
  return mercenaries.find(entry => entry.officeKey === officeKey)?.count || 0;
}

function planOfficeDeployments(state, meta, playerId, candidateId, pact) {
  const player = getPlayer(state, playerId);
  const offices = getOfficeList(state, playerId, { includeMercenaryCompany: getPlayerMercenaryTotal(state, playerId) > 0 });
  const deployments = {};
  const officePlans = [];
  const orderTemperature = getMetaForPlayer(meta, playerId, 'orderTemperature');

  for (const office of offices) {
    const professionalTroops = office.key === MERCENARY_COMPANY_KEY ? 0 : (player.professionalArmies[office.key] || 0);
    const levyTroops = office.key === MERCENARY_COMPANY_KEY ? 0 : (state.currentLevies?.[office.key] || 0);
    const mercenaryTroops = office.key === MERCENARY_COMPANY_KEY ? getPlayerMercenaryTotal(state, playerId) : 0;
    const troopCount = professionalTroops + levyTroops + mercenaryTroops;
    const capitalLocked = office.capitalLocked || CAPITAL_LOCKED_OFFICE_KEYS.has(office.key);
    let frontierScore;
    let capitalScore;
    let destination;
    if (capitalLocked) {
      frontierScore = -Infinity;
      capitalScore = scoreOfficeDestination(state, meta, playerId, office, troopCount || 1, 'capital', candidateId, pact);
      destination = 'capital';
    } else {
      frontierScore = scoreOfficeDestination(state, meta, playerId, office, troopCount || 1, 'frontier', candidateId, pact);
      capitalScore = scoreOfficeDestination(state, meta, playerId, office, troopCount || 1, 'capital', candidateId, pact);
      const picked = softmaxPick([
        { destination: 'frontier', score: frontierScore },
        { destination: 'capital', score: capitalScore },
      ], orderTemperature, state.rng);
      destination = picked?.destination || (capitalScore > frontierScore ? 'capital' : 'frontier');
    }
    deployments[office.key] = destination;
    officePlans.push({
      office,
      officeKey: office.key,
      officeLabel: office.label,
      troopCount,
      frontierScore,
      capitalScore,
      destination,
      capitalLocked,
    });
  }

  return { player, deployments, officePlans };
}

export function buildAIOrders(state, meta, playerId) {
  const context = ensureRoundContext(state, meta, 'orders');
  const pact = context.pactByPlayer[playerId];
  const candidateId = pact?.candidateId ?? state.basileusId;
  const { deployments, officePlans } = planOfficeDeployments(state, meta, playerId, candidateId, pact);
  const mercenaries = getPlayerMercenaryAssignments(state, playerId);

  let frontierTroops = 0;
  let capitalTroops = 0;
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
  logDecision(meta, `Round ${state.round} orders: ${describeActor(state, meta, playerId)} backs ${describeActor(state, meta, candidateId)} with ${capitalTroops} capital troops and ${frontierTroops} frontier troops.`);
  const debug = {
    pactKind: pact?.kind || 'defense',
    candidateId,
    candidateName: publicActor(state, candidateId),
    officePlans: officePlans.map(plan => ({
      officeKey: plan.officeKey,
      officeLabel: plan.officeLabel,
      troopCount: plan.troopCount,
      frontierScore: roundTo(plan.frontierScore, 2),
      capitalScore: roundTo(plan.capitalScore, 2),
      destination: plan.destination,
    })),
    decision: buildOrdersDecision(state, meta, playerId, candidateId, pact, officePlans, mercenaries, capitalTroops, frontierTroops, context),
  };

  return { deployments, candidate: candidateId, debug };
}

function runMercenaryStrategy(state, meta, playerId, plannedAction = null) {
  const context = ensureRoundContext(state, meta, 'court');
  const pact = plannedAction?.pact || context.pactByPlayer[playerId];
  const candidateId = plannedAction?.candidateId ?? pact?.candidateId ?? state.basileusId;
  const officePlans = plannedAction?.officePlans || planOfficeDeployments(state, meta, playerId, candidateId, pact).officePlans;
  const mercenaryPlan = plannedAction?.mercenaryPlan || planMercenaries(state, meta, playerId, officePlans, pact);
  if (!mercenaryPlan.length) return false;

  const debug = {
    pactKind: pact?.kind || 'defense',
    candidateId,
    candidateName: publicActor(state, candidateId),
    officePlans: officePlans.map(plan => ({
      officeKey: plan.officeKey,
      officeLabel: plan.officeLabel,
      troopCount: plan.troopCount,
      frontierScore: roundTo(plan.frontierScore, 2),
      capitalScore: roundTo(plan.capitalScore, 2),
      destination: plan.destination,
    })),
  };

  let hiredAny = false;
  for (const mercenary of mercenaryPlan) {
    const result = hireMercenaries(state, playerId, mercenary.officeKey, mercenary.count);
    if (!result?.ok) continue;
    meta.players[playerId].stats.mercsHired += mercenary.count;
    meta.players[playerId].stats.mercSpend += result.cost || 0;
    meta.totals.mercSpend += result.cost || 0;
    updateRecentBehavior(meta, playerId, { mercenarySpikes: clamp(mercenary.count / 5, 0, 1) }, state.round);
    applyDecisionToResult(state, result, buildMercenaryDecision(debug, mercenary, result.cost || 0));
    const officeLabel = getOfficeDisplayName(state, mercenary.officeKey);
    logDecision(meta, `Round ${state.round} court: ${describeActor(state, meta, playerId)} hires ${mercenary.count} mercenary troop${mercenary.count === 1 ? '' : 's'} for ${officeLabel}.`);
    logPublic(meta, `${publicActor(state, playerId)} hires ${mercenary.count} mercenary troop${mercenary.count === 1 ? '' : 's'} for ${officeLabel}.`);
    hiredAny = true;
  }

  if (hiredAny) invalidateRoundContext(meta);
  return hiredAny;
}

function normalizeCourtActionScore(meta, playerId, action) {
  const thresholds = {
    recruit: getMetaForPlayer(meta, playerId, 'recruitThreshold'),
    buy: getMetaForPlayer(meta, playerId, 'landPurchaseThreshold'),
    gift: getMetaForPlayer(meta, playerId, 'churchGiftThreshold'),
    dismiss: getMetaForPlayer(meta, playerId, 'dismissalThreshold'),
    revoke: getMetaForPlayer(meta, playerId, 'revocationThreshold'),
    mercenaries: getMetaForPlayer(meta, playerId, 'mercenaryThreshold'),
  };
  const scales = {
    recruit: 1,
    buy: 0.58,
    gift: 0.72,
    dismiss: 0.9,
    revoke: 0.82,
    mercenaries: 0.92,
  };
  const threshold = thresholds[action.kind] ?? 0;
  const scale = scales[action.kind] ?? 1;
  return (action.score - threshold) * scale;
}

function computeOrderTotals(state, playerId, orders) {
  const player = getPlayer(state, playerId);
  const mercenaries = getPlayerMercenaryAssignments(state, playerId);
  let capital = 0;
  let frontier = 0;

  for (const office of getOfficeList(state, playerId, { includeMercenaryCompany: getPlayerMercenaryTotal(state, playerId) > 0 })) {
    const professionalTroops = office.key === MERCENARY_COMPANY_KEY ? 0 : (player.professionalArmies[office.key] || 0);
    const levyTroops = office.key === MERCENARY_COMPANY_KEY ? 0 : (state.currentLevies?.[office.key] || 0);
    const mercenaryTroops = getMercCount(mercenaries, office.key);
    const totalTroops = professionalTroops + levyTroops + mercenaryTroops;
    if ((orders.deployments?.[office.key] || 'frontier') === 'capital') capital += totalTroops;
    else frontier += totalTroops;
  }

  return { capital, frontier };
}

function updatePostResolutionRelations(state, meta) {
  meta.currentRound = state.round;
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
      const frontierShare = totalTroops > 0 ? totals.frontier / totalTroops : 0.5;
      const mercSpend = getPlayerMercenaryTotal(state, target.id);
      const mercNorm = clamp(mercSpend / 5, 0, 1);
      const throneAgainst = targetOrders.candidate != null && targetOrders.candidate !== incumbentId ? 1 : 0;
      updateRecentBehavior(meta, target.id, {
        incumbentSupport: targetOrders.candidate === incumbentId ? 1 : 0,
        selfSupport: targetOrders.candidate === target.id ? 1 : 0,
        frontierCommitment: frontierShare,
        mercenarySpikes: mercNorm,
      }, state.round);
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
      adjustRelation(meta, player.id, winnerId, 0.7, 0);
      adjustRelation(meta, winnerId, player.id, 0.35, 0);
      addObligation(meta, winnerId, player.id, 0.55 + (totals.capital * 0.22) + (defenderWon ? 0.2 : 0.35));
      reduceObligation(meta, player.id, winnerId, 0.8 + (totals.capital * 0.12));
      updateSocialMemory(meta, player.id, winnerId, {
        strategicAlignment: 0.45,
        reliability: 0.25,
      }, state.round);
      updateSocialMemory(meta, winnerId, player.id, {
        favorCredit: 0.25,
        reliability: 0.18,
      }, state.round);
    } else if (orders.candidate === player.id && player.id !== winnerId) {
      adjustRelation(meta, player.id, winnerId, 0, 0.35);
      updateSocialMemory(meta, winnerId, player.id, {
        opportunism: 0.35,
        threat: 0.25,
      }, state.round);
    } else if (orders.candidate === state.basileusId && winnerId !== state.basileusId) {
      adjustRelation(meta, player.id, state.basileusId, 0.15, 0.15);
      updateSocialMemory(meta, player.id, state.basileusId, {
        strategicAlignment: 0.08,
      }, state.round);
    }

    if (totals.frontier > totals.capital && state.lastWarResult?.outcome === 'victory') {
      addObligation(meta, state.basileusId, player.id, 0.15 + (totals.frontier * 0.05));
      updateSocialMemory(meta, state.basileusId, player.id, {
        reliability: 0.22,
        strategicAlignment: 0.14,
      }, state.round);
    } else if ((state.lastWarResult?.invaderStrength || 0) > 0 && totals.frontier <= totals.capital) {
      updateSocialMemory(meta, state.basileusId, player.id, {
        opportunism: 0.16,
      }, state.round);
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
      walk(index + 1, current);
    }
  }

  walk(0, {});
  return assignments;
}

function scoreTitleAssignment(state, meta, newBasileusId, assignment, previousHolders) {
  let totalScore = 0;
  for (const titleKey of MAJOR_TITLE_KEYS) {
    const holderId = assignment[titleKey];
    const loyalty = getAffinityScore(meta, newBasileusId, holderId);
    const competence = getCompetenceScore(state, meta, holderId);
    const ambition = getAmbitionScore(meta, holderId);
    const rivalSummary = getRivalSummary(state, meta, newBasileusId, holderId);
    // Tier 5: when judging the holder's likely church alignment, use the new
    // Basileus's INFERRED view of them, not their true profile. This is the
    // crux of opponent-modeled play.
    const inferredHolderProfile = blendedOpponentProfile(meta, newBasileusId, holderId);
    const churchBonus = titleKey === 'PATRIARCH' ? inferredHolderProfile.weights.church * 0.45 : 0;
    const continuity = previousHolders[titleKey] === holderId ? 0.42 : 0;
    const supporterBonus = (state.allOrders?.[holderId]?.candidate === newBasileusId) ? 1.25 : 0;
    const debtRepayment = getObligation(meta, newBasileusId, holderId) * 1.3;
    totalScore += (loyalty * 1.1) + (competence * 0.58) + (rivalSummary.reliability * 0.32) + (rivalSummary.patronageValue * 0.18) + churchBonus + continuity + supporterBonus + debtRepayment - (ambition * 0.42) - (rivalSummary.currentThreatToMe * 0.16);
  }
  return totalScore;
}

function planMajorTitleAssignment(state, meta, newBasileusId) {
  const previousHolders = {};
  for (const titleKey of MAJOR_TITLE_KEYS) {
    previousHolders[titleKey] = state.players.find(player => player.majorTitles.includes(titleKey))?.id ?? null;
  }

  const assignments = enumerateTitleAssignments(state, newBasileusId)
    .map(assignment => ({
      assignment,
      score: scoreTitleAssignment(state, meta, newBasileusId, assignment, previousHolders),
    }))
    .sort((left, right) => right.score - left.score);

  return { previousHolders, best: assignments[0] || null };
}

function applyMajorTitleAssignment(state, meta, newBasileusId, plan) {
  if (!plan?.best) return null;
  const result = applyCoupTitleReassignment(state, newBasileusId, plan.best.assignment);
  meta.players[newBasileusId].stats.throneCaptures++;
  meta.totals.throneChanges++;

  for (const [titleKey, holderId] of Object.entries(plan.best.assignment)) {
    adjustRelation(meta, holderId, newBasileusId, 1.0, 0);
    adjustRelation(meta, newBasileusId, holderId, 0.35, 0);
    reduceObligation(meta, newBasileusId, holderId, 1.0);
    const previousHolderId = plan.previousHolders[titleKey];
    if (previousHolderId != null && previousHolderId !== holderId) {
      adjustRelation(meta, previousHolderId, newBasileusId, 0, 0.85);
    }
  }

  applyDecisionToResult(state, result, buildTitleAssignmentDecision(state, meta, newBasileusId, plan));
  logDecision(meta, `Round ${state.round} resolution: ${describeActor(state, meta, newBasileusId)} captures the throne and redistributes the four major offices.`);
  logPublic(meta, `${publicActor(state, newBasileusId)} captures the throne and redistributes the major offices.`);
  return plan.best.assignment;
}

function takeOneAiCourtAction(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return false;

  if (playerId === state.basileusId && !state.courtActions.basileusAppointed) {
    return handleBasileusAppointment(state, meta);
  }

  if (player.majorTitles.includes('DOM_EAST') && !state.courtActions.domesticEastAppointed) {
    return handleRegionalStrategosAppointment(state, meta, 'DOM_EAST');
  }
  if (player.majorTitles.includes('DOM_WEST') && !state.courtActions.domesticWestAppointed) {
    return handleRegionalStrategosAppointment(state, meta, 'DOM_WEST');
  }
  if (player.majorTitles.includes('ADMIRAL') && !state.courtActions.admiralAppointed) {
    return handleRegionalStrategosAppointment(state, meta, 'ADMIRAL');
  }
  if (player.majorTitles.includes('PATRIARCH') && !state.courtActions.patriarchAppointed) {
    return handlePatriarchAppointment(state, meta);
  }

  return takeOneStrategicCourtAction(state, meta, playerId);
}

export function runAICourtAutomation(state, meta, options = {}) {
  ensureRoundContext(state, meta, 'court');
  const mode = options.mode || 'finish';
  const aiOrder = shuffle(state.players.filter(player => isAIPlayer(meta, player.id)).map(player => player.id), state.rng);
  let actionsTaken = 0;

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
  let safety = 0;
  const maxPasses = Math.max(12, aiOrder.length * 8);
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
  if (!meta || !action) return;
  meta.currentRound = state.round;
  invalidateRoundContext(meta);

  if (action.type === 'appointment') {
    registerFavor(meta, action.actorId, action.appointeeId, action.value ?? 1.0);
    if (action.previousHolderId != null && action.previousHolderId !== action.appointeeId) {
      adjustRelation(meta, action.previousHolderId, action.actorId, 0, 0.55);
      reduceObligation(meta, action.actorId, action.previousHolderId, 0.45);
      updateSocialMemory(meta, action.previousHolderId, action.actorId, {
        harmDebt: 0.45,
        opportunism: 0.2,
      }, state.round);
    }
  }

  if (action.type === 'revocation') {
    updateRecentBehavior(meta, action.actorId, { revocationFrequency: 1 }, state.round);
    if (action.targetPlayerId != null) {
      adjustRelation(meta, action.targetPlayerId, action.actorId, 0, 1.15);
      reduceObligation(meta, action.actorId, action.targetPlayerId, 0.8);
      updateSocialMemory(meta, action.targetPlayerId, action.actorId, {
        harmDebt: 0.9,
        threat: 0.45,
      }, state.round);
    }
    if (action.newHolderId != null) {
      adjustRelation(meta, action.newHolderId, action.actorId, 0.65, 0);
      addObligation(meta, action.newHolderId, action.actorId, 0.8);
      updateSocialMemory(meta, action.newHolderId, action.actorId, {
        favorCredit: 0.55,
        reliability: 0.2,
      }, state.round);
    }
    // Tier 5: every other AI updates its posterior on the actor as a revoker
    for (const observer of state.players) {
      if (observer.id === action.actorId) continue;
      if (!isAIPlayer(meta, observer.id)) continue;
      updateOpponentPosterior(meta, observer.id, action.actorId, { revocation: 1.0 });
    }
  }

  if (action.type === 'gift') {
    updateRecentBehavior(meta, action.actorId, { churchGifting: 1 }, state.round);
    for (const observer of state.players) {
      if (observer.id === action.actorId) continue;
      if (!isAIPlayer(meta, observer.id)) continue;
      updateOpponentPosterior(meta, observer.id, action.actorId, { gift: 1.0 });
    }
  }

  if (action.type === 'recruit') {
    updateRecentBehavior(meta, action.actorId, { frontierCommitment: 0.35 }, state.round);
    for (const observer of state.players) {
      if (observer.id === action.actorId) continue;
      if (!isAIPlayer(meta, observer.id)) continue;
      updateOpponentPosterior(meta, observer.id, action.actorId, { recruit: 1.0 });
    }
  }

  if (action.type === 'mercenaries') {
    const mercNorm = clamp((Number(action.count) || 0) / 5, 0, 1);
    updateRecentBehavior(meta, action.actorId, { mercenarySpikes: mercNorm }, state.round);
    for (const observer of state.players) {
      if (observer.id === action.actorId) continue;
      if (!isAIPlayer(meta, observer.id)) continue;
      updateOpponentPosterior(meta, observer.id, action.actorId, { mercenarySpend: mercNorm });
    }
  }

  if (action.type === 'buy_theme') {
    updateRecentBehavior(meta, action.actorId, { landBuying: 1 }, state.round);
  }
}

export function handlePostResolutionAI(state, meta, options = {}) {
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
}

export function applyPlannedAiTitleAssignment(state, meta, plan, newBasileusId) {
  return applyMajorTitleAssignment(state, meta, newBasileusId, plan);
}

export function getRecentPublicLog(meta, limit = 10) {
  return meta.publicLog.slice(-limit);
}

export const __testing = {
  softmaxPick,
  buildRoundContext,
  ensureSocialMemory,
  updateSocialMemory,
  ensureRecentBehavior,
  updateRecentBehavior,
  getAffinityScore,
  getRivalSummary,
};

export {
  DEFAULT_MIXED_DECK_SIZES,
  PERSONALITIES,
  POPULATION_PRESETS,
  SUPPORTED_PLAYER_COUNTS,
};
