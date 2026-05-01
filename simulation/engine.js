import { createGameState, getPlayer, getPlayerThemes } from '../engine/state.js';
import { runAdministration } from '../engine/cascade.js';
import {
  phaseAdministration,
  phaseCleanup,
  phaseCourt,
  phaseInvasion,
  phaseOrders,
  phaseResolution,
  isCourtComplete,
  allOrdersSubmitted,
  submitOrders,
} from '../engine/turnflow.js';
import { computeFullWealth } from '../engine/actions.js';
import {
  applyAIOrderCosts,
  buildAIOrders,
  createAIMeta,
  handlePostResolutionAI,
  runAICourtAutomation,
  SUPPORTED_PLAYER_COUNTS,
} from '../ai/brain.js';
import { normalizeAiProfile } from '../ai/profileStore.js';
import { DEFAULT_MIXED_DECK_SIZES } from './constants.js';

export const DEFAULT_BATCH_CONFIG = {
  mode: 'mixed',
  simulations: 1000,
  samplePercent: 1,
  seed: 20260429,
  allowedProfiles: [],
  mixed: {
    playerCounts: SUPPORTED_PLAYER_COUNTS,
    deckSizes: DEFAULT_MIXED_DECK_SIZES,
  },
  focused: {
    playerCount: 4,
    deckSize: 9,
  },
};

const DEFAULT_SIMULATION_GUARDS = {
  maxLoopIterations: 256,
  maxRounds: 40,
  strictTimeoutMs: 15000,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function roundTo(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function hashSeedString(value) {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeSeed(rawSeed) {
  if (rawSeed == null || rawSeed === '') return Date.now() >>> 0;
  const text = String(rawSeed).trim();
  if (!text) return Date.now() >>> 0;
  if (/^-?\d+$/.test(text)) return (Number(text) >>> 0);
  return hashSeedString(text);
}

function uniqueList(items) {
  return [...new Set(items)];
}

function sanitizeDeckSizes(rawDeckSizes) {
  const list = Array.isArray(rawDeckSizes) ? rawDeckSizes : [];
  const cleaned = uniqueList(list.map(value => clamp(toInt(value, 9), 1, 30))).sort((a, b) => a - b);
  return cleaned.length ? cleaned : DEFAULT_MIXED_DECK_SIZES.slice();
}

function sanitizePlayerCounts(rawPlayerCounts) {
  const list = Array.isArray(rawPlayerCounts) ? rawPlayerCounts : [];
  const cleaned = uniqueList(list.map(value => toInt(value, 4)).filter(value => SUPPORTED_PLAYER_COUNTS.includes(value))).sort((a, b) => a - b);
  return cleaned.length ? cleaned : SUPPORTED_PLAYER_COUNTS.slice();
}

function sanitizeProfilePool(rawProfiles) {
  const list = Array.isArray(rawProfiles) ? rawProfiles : [];
  const cleaned = [];
  const seenIds = new Set();
  for (const rawProfile of list) {
    const profile = normalizeAiProfile(rawProfile);
    if (!profile || seenIds.has(profile.id)) continue;
    seenIds.add(profile.id);
    cleaned.push(profile);
  }
  return cleaned;
}

export function normalizeBatchConfig(rawConfig = {}) {
  const mode = rawConfig.mode === 'focused' ? 'focused' : 'mixed';
  const simulations = clamp(toInt(rawConfig.simulations, DEFAULT_BATCH_CONFIG.simulations), 1, 20000);
  const samplePercent = clamp(toNumber(rawConfig.samplePercent, DEFAULT_BATCH_CONFIG.samplePercent), 0, 100);
  const seed = normalizeSeed(rawConfig.seed ?? DEFAULT_BATCH_CONFIG.seed);
  const allowedProfiles = sanitizeProfilePool(rawConfig.allowedProfiles);

  const mixed = {
    playerCounts: sanitizePlayerCounts(rawConfig.mixed?.playerCounts),
    deckSizes: sanitizeDeckSizes(rawConfig.mixed?.deckSizes),
  };

  const focused = {
    playerCount: sanitizePlayerCounts([rawConfig.focused?.playerCount])[0],
    deckSize: clamp(toInt(rawConfig.focused?.deckSize, DEFAULT_BATCH_CONFIG.focused.deckSize), 1, 30),
  };

  return {
    mode,
    simulations,
    samplePercent,
    seed,
    allowedProfiles,
    mixed,
    focused,
  };
}

function buildScenarioPlan(config) {
  if (config.mode === 'focused') {
    return [{
      key: `${config.focused.playerCount}p-${config.focused.deckSize}d-trained`,
      label: `${config.focused.playerCount} players / ${config.focused.deckSize} invasions / trained roster`,
      playerCount: config.focused.playerCount,
      deckSize: config.focused.deckSize,
    }];
  }

  const plan = [];
  for (const playerCount of config.mixed.playerCounts) {
    for (const deckSize of config.mixed.deckSizes) {
      plan.push({
        key: `${playerCount}p-${deckSize}d-trained`,
        label: `${playerCount} players / ${deckSize} invasions / trained roster`,
        playerCount,
        deckSize,
      });
    }
  }
  return plan;
}

function sampleSeatProfiles(rng, playerCount, allowedProfiles) {
  if (!allowedProfiles.length) {
    throw new Error('No trained AI profiles were supplied to the simulation engine.');
  }

  const seatProfiles = {};
  for (let playerId = 0; playerId < playerCount; playerId++) {
    seatProfiles[playerId] = allowedProfiles[Math.floor(rng() * allowedProfiles.length)];
  }
  return seatProfiles;
}

function buildSampleIndexSet(totalGames, samplePercent) {
  const rawCount = Math.round(totalGames * (samplePercent / 100));
  const sampleCount = samplePercent > 0 ? clamp(rawCount || 1, 1, totalGames) : 0;
  const sampleIndices = new Set();
  if (!sampleCount) return sampleIndices;

  const step = totalGames / sampleCount;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const absoluteIndex = Math.min(totalGames - 1, Math.floor((sampleIndex + 0.5) * step));
    sampleIndices.add(absoluteIndex);
  }
  return sampleIndices;
}

function getProfileById(meta, playerId) {
  return meta.players[playerId]?.profile || null;
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

function getMinorTitleCount(state, playerId) {
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

function getOfficeList(state, playerId) {
  const offices = [];
  if (playerId === state.basileusId) {
    offices.push({ key: 'BASILEUS', label: 'Basileus' });
  }

  const player = getPlayer(state, playerId);
  for (const titleKey of player.majorTitles) {
    if (titleKey === 'PATRIARCH') continue;
    offices.push({ key: titleKey, label: MAJOR_TITLES[titleKey]?.name || titleKey });
  }

  for (const theme of Object.values(state.themes)) {
    if (!theme.occupied && theme.strategos === playerId) {
      offices.push({ key: `STRAT_${theme.id}`, label: `Strategos of ${theme.name}` });
    }
  }

  return offices;
}

function getPlayerProfessionalCount(player) {
  return sum(Object.values(player.professionalArmies));
}

function getPlayerStrength(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  return (
    player.gold +
    getPlayerThemes(state, playerId).length * 1.5 +
    getPlayerProfessionalCount(player) * 1.2 +
    player.majorTitles.length * 2.2 +
    getMinorTitleCount(state, playerId) * 0.8 +
    (playerId === state.basileusId ? 3 : 0) +
    meta.players[playerId].stats.throneCaptures * 0.8
  );
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

function getThreatLevel(state) {
  if (!state.currentInvasion) return 0.25;

  const [minStrength, maxStrength] = state.currentInvasion.strength;
  const invasionMean = (minStrength + maxStrength) / 2;
  const occupiedThemes = Object.values(state.themes).filter(theme => theme.occupied && theme.id !== 'CPL').length;
  const totalThemes = Object.values(state.themes).filter(theme => theme.id !== 'CPL').length;
  const totalPotentialTroops =
    sum(Object.values(state.currentLevies || {})) +
    sum(state.players.map(player => getPlayerProfessionalCount(player)));

  const occupationPressure = occupiedThemes / Math.max(1, totalThemes);
  const troopPressure = (invasionMean - (totalPotentialTroops * 0.55)) / Math.max(1, invasionMean);

  return clamp(0.35 + occupationPressure * 0.9 + troopPressure * 0.8, 0, 1.5);
}

function getCompetenceScore(meta, playerId) {
  const weights = getProfileById(meta, playerId).weights;
  return (weights.frontier * 0.7) + (weights.loyalty * 0.2) + (weights.mercenary * 0.1);
}

function getAmbitionScore(meta, playerId) {
  const weights = getProfileById(meta, playerId).weights;
  return (weights.throne * 0.6) + (weights.capital * 0.25) + (weights.mercenary * 0.15);
}

function getRelationValue(meta, fromId, toId) {
  if (fromId === toId) return 0;
  const fromPlayer = meta.players[fromId];
  return (fromPlayer.trust[toId] || 0) - (fromPlayer.grievance[toId] || 0);
}

function getAffinityScore(meta, fromId, toId) {
  if (fromId === toId) {
    return 1 + (getProfileById(meta, fromId).weights.selfAppointment * 0.25);
  }
  const relation = getRelationValue(meta, fromId, toId);
  return clamp(1 + (relation * 0.32), 0.2, 2.5);
}

function adjustRelation(meta, fromId, toId, trustDelta = 0, grievanceDelta = 0) {
  if (fromId == null || toId == null || fromId === toId) return;
  const fromPlayer = meta.players[fromId];
  fromPlayer.trust[toId] = clamp((fromPlayer.trust[toId] || 0) + trustDelta, -3, 6);
  fromPlayer.grievance[toId] = clamp((fromPlayer.grievance[toId] || 0) + grievanceDelta, 0, 6);
}

function describeActor(state, meta, playerId) {
  const player = getPlayer(state, playerId);
  const personality = getProfileById(meta, playerId);
  return `${player.dynasty} (${personality.shortName})`;
}

function scoreMinorSlot(state, meta, actorId, type, theme, appointeeId) {
  const actorProfile = getProfileById(meta, actorId);
  const threat = getThreatLevel(state);
  const remainingRounds = getRemainingRounds(state);
  const routeRisk = theme ? getThemeRouteRisk(state, theme.id) : 0;
  const appointeeAffinity = getAffinityScore(meta, actorId, appointeeId);
  const appointeeAmbition = getAmbitionScore(meta, appointeeId);

  let slotValue = 1.5;
  if (type === 'EMPRESS' || type === 'CHIEF_EUNUCHS') {
    slotValue = 2.1 + (actorProfile.weights.throne * 0.7) + (threat * 0.8);
    const currentHolder = type === 'EMPRESS' ? state.empress : state.chiefEunuchs;
    if (currentHolder != null && currentHolder !== appointeeId) {
      slotValue += Math.max(0, getRelationValue(meta, actorId, currentHolder)) * -0.25;
      slotValue += Math.max(0, getPlayerStrength(state, meta, currentHolder) - getPlayerStrength(state, meta, actorId)) * 0.08;
    }
  } else if (type === 'STRATEGOS') {
    slotValue = 2.0 + theme.L + (theme.G * 0.25) + (actorProfile.weights.frontier * 0.6) + (threat * 1.3) - (routeRisk * 0.5);
    if (theme.strategos != null && theme.strategos !== appointeeId) {
      slotValue += Math.max(0, getPlayerStrength(state, meta, theme.strategos) - getPlayerStrength(state, meta, actorId)) * 0.08;
    }
  } else if (type === 'BISHOP') {
    slotValue = 1.8 + (theme.G * 0.9) + (actorProfile.weights.church * 0.9) - (routeRisk * 0.3) + (remainingRounds * 0.08);
    if (theme.bishop != null && theme.bishop !== appointeeId) {
      slotValue += Math.max(0, getPlayerStrength(state, meta, theme.bishop) - getPlayerStrength(state, meta, actorId)) * 0.05;
    }
  }

  const selfBias = appointeeId === actorId ? actorProfile.weights.selfAppointment * 0.9 : 0;
  const controlBias = actorProfile.weights.loyalty * appointeeAffinity;
  const riskPenalty = appointeeAmbition * 0.35;

  return slotValue + selfBias + controlBias - riskPenalty;
}

function sortedByScore(options, scoreFn) {
  return options
    .map(option => ({ ...option, score: scoreFn(option) }))
    .sort((left, right) => right.score - left.score);
}

function handleBasileusAppointment(state, meta, logger) {
  const actorId = state.basileusId;
  const themes = Object.values(state.themes).filter(theme => !theme.occupied && theme.id !== 'CPL');
  const options = [];

  for (const appointee of state.players) {
    options.push({ type: 'EMPRESS', appointeeId: appointee.id });
    options.push({ type: 'CHIEF_EUNUCHS', appointeeId: appointee.id });
    for (const theme of themes) {
      options.push({ type: 'STRATEGOS', themeId: theme.id, appointeeId: appointee.id });
      if (!theme.bishopIsDonor) {
        options.push({ type: 'BISHOP', themeId: theme.id, appointeeId: appointee.id });
      }
    }
  }

  const ranked = sortedByScore(options, option => {
    const theme = option.themeId ? state.themes[option.themeId] : null;
    return scoreMinorSlot(state, meta, actorId, option.type, theme, option.appointeeId);
  });

  for (const option of ranked) {
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
    adjustRelation(meta, option.appointeeId, actorId, 0.8, 0);
    adjustRelation(meta, actorId, option.appointeeId, 0.3, 0);
    logger.push(`Round ${state.round} court: ${describeActor(state, meta, actorId)} appoints ${describeActor(state, meta, option.appointeeId)} to ${option.type}${option.themeId ? ` in ${option.themeId}` : ''}.`);
    return;
  }

  state.courtActions.basileusAppointed = true;
  logger.push(`Round ${state.round} court: ${describeActor(state, meta, actorId)} had no valid minor appointment and passes the mandatory slot.`);
}

function handleRegionalStrategosAppointment(state, meta, logger, titleKey) {
  const actorId = state.players.find(player => player.majorTitles.includes(titleKey))?.id ?? null;
  if (actorId == null) return;

  const region = MAJOR_TITLES[titleKey].region;
  const themes = Object.values(state.themes).filter(theme => theme.region === region && !theme.occupied && theme.id !== 'CPL');
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
    logger.push(`Round ${state.round} court: ${describeActor(state, meta, actorId)} has no eligible strategos slot in ${region}.`);
    return;
  }

  const ranked = sortedByScore(options, option => scoreMinorSlot(state, meta, actorId, 'STRATEGOS', state.themes[option.themeId], option.appointeeId));
  for (const option of ranked) {
    const previousHolder = state.themes[option.themeId].strategos;
    const result = appointStrategos(state, actorId, option.themeId, option.appointeeId);
    if (!result?.ok) continue;

    state.courtActions[`${titleKey}_appointed`] = true;
    if (titleKey === 'DOM_EAST') state.courtActions.domesticEastAppointed = true;
    if (titleKey === 'DOM_WEST') state.courtActions.domesticWestAppointed = true;
    if (titleKey === 'ADMIRAL') state.courtActions.admiralAppointed = true;

    adjustRelation(meta, option.appointeeId, actorId, 0.7, 0);
    adjustRelation(meta, actorId, option.appointeeId, 0.3, 0);
    if (previousHolder != null && previousHolder !== option.appointeeId) {
      adjustRelation(meta, previousHolder, actorId, 0, 0.6);
    }
    logger.push(`Round ${state.round} court: ${describeActor(state, meta, actorId)} names ${describeActor(state, meta, option.appointeeId)} strategos of ${option.themeId}.`);
    return;
  }
}

function handlePatriarchAppointment(state, meta, logger) {
  const actorId = state.players.find(player => player.majorTitles.includes('PATRIARCH'))?.id ?? null;
  if (actorId == null) return;

  const themes = Object.values(state.themes).filter(theme => !theme.occupied && theme.id !== 'CPL' && !theme.bishopIsDonor);
  const options = [];
  for (const theme of themes) {
    for (const appointee of state.players) {
      options.push({ themeId: theme.id, appointeeId: appointee.id });
    }
  }

  if (!options.length) {
    state.courtActions.patriarchAppointed = true;
    logger.push(`Round ${state.round} court: ${describeActor(state, meta, actorId)} has no eligible bishopric to assign.`);
    return;
  }

  const ranked = sortedByScore(options, option => scoreMinorSlot(state, meta, actorId, 'BISHOP', state.themes[option.themeId], option.appointeeId));
  for (const option of ranked) {
    const previousHolder = state.themes[option.themeId].bishop;
    const result = appointBishop(state, actorId, option.themeId, option.appointeeId);
    if (!result?.ok) continue;

    state.courtActions.patriarchAppointed = true;
    adjustRelation(meta, option.appointeeId, actorId, 0.8, 0);
    adjustRelation(meta, actorId, option.appointeeId, 0.35, 0);
    if (previousHolder != null && previousHolder !== option.appointeeId) {
      adjustRelation(meta, previousHolder, actorId, 0, 0.5);
    }
    logger.push(`Round ${state.round} court: ${describeActor(state, meta, actorId)} names ${describeActor(state, meta, option.appointeeId)} bishop of ${option.themeId}.`);
    return;
  }
}

function scoreLandPurchase(state, meta, playerId, theme) {
  const profile = getProfileById(meta, playerId);
  const remainingRounds = getRemainingRounds(state);
  const routeRisk = getThemeRouteRisk(state, theme.id);
  const cost = 2 * theme.G;
  const privateValue = remainingRounds * profile.weights.wealth * 0.95;
  const landControl = profile.weights.land * 1.1;
  const cheapness = (4 - theme.G) * 0.5;
  const churchOptionality = profile.weights.church * theme.G * 0.15;
  const empireCost = remainingRounds * profile.weights.frontier * 0.65;
  const riskPenalty = routeRisk * (0.8 + (remainingRounds * 0.15));
  return privateValue + landControl + cheapness + churchOptionality - empireCost - riskPenalty - cost;
}

function runRecruitmentStrategy(state, meta, logger, playerId) {
  const offices = getOfficeList(state, playerId);
  for (const office of offices) {
    meta.players[playerId].stats.recruitOpportunities++;
    meta.totals.recruitOpportunities++;

    const result = recruitProfessional(state, playerId, office.key);
    if (!result?.ok) continue;

    meta.players[playerId].stats.recruits++;
    meta.totals.recruits++;
    logger.push(`Round ${state.round} court: ${describeActor(state, meta, playerId)} recruits 1 professional troop for ${office.key}.`);
  }
}

function runLandStrategy(state, meta, logger, playerId) {
  const profile = getProfileById(meta, playerId);
  const purchaseLimit = Math.max(1, Math.min(5, Math.round(profile.weights.land + 1)));
  let purchases = 0;

  while (purchases < purchaseLimit) {
    const player = getPlayer(state, playerId);
    const candidates = getFreeThemes(state)
      .map(theme => ({ theme, score: scoreLandPurchase(state, meta, playerId, theme) }))
      .filter(entry => (2 * entry.theme.G) <= player.gold)
      .sort((left, right) => right.score - left.score);

    const best = candidates[0];
    if (!best || best.score <= 0.5) break;

    const result = buyTheme(state, playerId, best.theme.id);
    if (!result?.ok) break;

    purchases++;
    meta.players[playerId].stats.landBuys++;
    meta.totals.landBuys++;
    logger.push(`Round ${state.round} court: ${describeActor(state, meta, playerId)} buys ${best.theme.id} for ${2 * best.theme.G}g (score ${roundTo(best.score, 2)}).`);
  }
}

function scoreChurchGift(state, meta, playerId, theme) {
  const profile = getProfileById(meta, playerId);
  const remainingRounds = getRemainingRounds(state);
  const keepsValue = remainingRounds * profile.weights.wealth * 0.8;
  const churchValue = (theme.G * profile.weights.church * 1.3) + 1.2;
  const patriarchBonus = getPlayer(state, playerId).majorTitles.includes('PATRIARCH') ? 2.2 : 0;
  const bishopLockBonus = 1.0 + (profile.weights.church * 0.5);
  const routeRisk = getThemeRouteRisk(state, theme.id) * 0.5;
  return churchValue + patriarchBonus + bishopLockBonus - keepsValue - routeRisk;
}

function runChurchGiftStrategy(state, meta, logger, playerId) {
  const giftLimit = 2;
  let gifts = 0;

  while (gifts < giftLimit) {
    const candidates = getPlayerThemes(state, playerId)
      .map(theme => ({ theme, score: scoreChurchGift(state, meta, playerId, theme) }))
      .sort((left, right) => right.score - left.score);

    const best = candidates[0];
    if (!best || best.score <= 1.5) break;

    const previousBishop = state.themes[best.theme.id].bishop;
    const result = giftToChurch(state, playerId, best.theme.id);
    if (!result?.ok) break;

    gifts++;
    meta.players[playerId].stats.themesGifted++;
    meta.totals.gifts++;
    if (previousBishop != null && previousBishop !== playerId) {
      adjustRelation(meta, previousBishop, playerId, 0, 0.4);
    }
    logger.push(`Round ${state.round} court: ${describeActor(state, meta, playerId)} gifts ${best.theme.id} to the church (score ${roundTo(best.score, 2)}).`);
  }
}

function buildRevocationOptions(state, meta, basileusId) {
  const options = [];
  const profile = getProfileById(meta, basileusId);
  const basileusStrength = getPlayerStrength(state, meta, basileusId);

  for (const player of state.players) {
    if (player.id === basileusId) continue;

    for (const titleKey of player.majorTitles) {
      for (const candidate of state.players) {
        if (candidate.id === basileusId || candidate.id === player.id) continue;
        const targetThreat = getPlayerStrength(state, meta, player.id) - basileusStrength;
        const loyaltyGain = getAffinityScore(meta, basileusId, candidate.id) * 1.3;
        const stability = titleKey === 'PATRIARCH' ? getProfileById(meta, candidate.id).weights.church : getCompetenceScore(meta, candidate.id);
        const score = (targetThreat * 0.25) + (profile.weights.revocation * 1.4) + loyaltyGain + (stability * 0.35) - (getAmbitionScore(meta, candidate.id) * 0.45);
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
    for (const theme of getPlayerThemes(state, player.id)) {
      options.push({
        kind: 'theme',
        themeId: theme.id,
        targetPlayerId: player.id,
        score: (wealthLead * 0.35) + profile.weights.revocation + (theme.G * 0.25) + (theme.L * 0.25),
      });
    }
  }

  for (const theme of Object.values(state.themes)) {
    if (theme.occupied) continue;
    if (theme.strategos != null) {
      const holderId = theme.strategos;
      options.push({
        kind: 'minor',
        themeId: theme.id,
        titleType: 'strategos',
        targetPlayerId: holderId,
        score: (getPlayerStrength(state, meta, holderId) - basileusStrength) * 0.18 + profile.weights.revocation + theme.L,
      });
    }
    if (theme.bishop != null) {
      const holderId = theme.bishop;
      options.push({
        kind: 'minor',
        themeId: theme.id,
        titleType: 'bishop',
        targetPlayerId: holderId,
        score: (getPlayerStrength(state, meta, holderId) - basileusStrength) * 0.12 + profile.weights.revocation + (theme.G * 0.8),
      });
    }
    if (theme.taxExempt) {
      options.push({
        kind: 'exempt',
        themeId: theme.id,
        score: profile.weights.revocation + (theme.G * 0.8),
      });
    }
  }

  if (state.empress != null) {
    options.push({
      kind: 'court',
      titleType: 'EMPRESS',
      targetPlayerId: state.empress,
      score: profile.weights.revocation + (getPlayerStrength(state, meta, state.empress) - basileusStrength) * 0.15,
    });
  }
  if (state.chiefEunuchs != null) {
    options.push({
      kind: 'court',
      titleType: 'CHIEF_EUNUCHS',
      targetPlayerId: state.chiefEunuchs,
      score: profile.weights.revocation + (getPlayerStrength(state, meta, state.chiefEunuchs) - basileusStrength) * 0.15,
    });
  }

  return options.sort((left, right) => right.score - left.score);
}

function handleBasileusRevocation(state, meta, logger) {
  const basileusId = state.basileusId;
  const ranked = buildRevocationOptions(state, meta, basileusId);
  const best = ranked[0];
  if (!best || best.score <= 2.2) return;

  let result = null;
  if (best.kind === 'major') {
    result = revokeMajorTitle(state, best.revokedPlayerId, best.titleKey, best.newHolderId);
    if (result?.ok) {
      adjustRelation(meta, best.revokedPlayerId, basileusId, 0, 1.5);
      adjustRelation(meta, best.newHolderId, basileusId, 0.9, 0);
      logger.push(`Round ${state.round} court: ${describeActor(state, meta, basileusId)} revokes ${best.titleKey} from ${describeActor(state, meta, best.revokedPlayerId)} and hands it to ${describeActor(state, meta, best.newHolderId)}.`);
    }
  } else if (best.kind === 'minor') {
    result = revokeMinorTitle(state, best.themeId, best.titleType);
    if (result?.ok && best.targetPlayerId != null) {
      adjustRelation(meta, best.targetPlayerId, basileusId, 0, 1.0);
      logger.push(`Round ${state.round} court: ${describeActor(state, meta, basileusId)} revokes the ${best.titleType} of ${best.themeId}.`);
    }
  } else if (best.kind === 'theme') {
    result = revokeTheme(state, best.themeId);
    if (result?.ok && best.targetPlayerId != null) {
      adjustRelation(meta, best.targetPlayerId, basileusId, 0, 1.2);
      logger.push(`Round ${state.round} court: ${describeActor(state, meta, basileusId)} strips ${best.themeId} from ${describeActor(state, meta, best.targetPlayerId)}.`);
    }
  } else if (best.kind === 'exempt') {
    result = revokeTaxExemption(state, best.themeId);
    if (result?.ok) {
      logger.push(`Round ${state.round} court: ${describeActor(state, meta, basileusId)} revokes the tax exemption of ${best.themeId}.`);
    }
  } else if (best.kind === 'court') {
    if (best.titleType === 'EMPRESS') state.empress = null;
    if (best.titleType === 'CHIEF_EUNUCHS') state.chiefEunuchs = null;
    result = { ok: true };
    if (best.targetPlayerId != null) {
      adjustRelation(meta, best.targetPlayerId, basileusId, 0, 0.8);
      logger.push(`Round ${state.round} court: ${describeActor(state, meta, basileusId)} revokes the ${best.titleType} court title.`);
    }
  }

  if (result?.ok) {
    state.courtActions.basileusRevoked = true;
  }
}

function chooseCandidate(state, meta, playerId) {
  const profile = getProfileById(meta, playerId);
  const threat = getThreatLevel(state);
  const playerStrength = getPlayerStrength(state, meta, playerId);

  const ranked = state.players
    .map(candidate => {
      const affinity = getAffinityScore(meta, playerId, candidate.id);
      const candidateStrength = getPlayerStrength(state, meta, candidate.id);
      const ambitionRisk = getAmbitionScore(meta, candidate.id);

      let score = affinity * profile.weights.loyalty;
      score += (candidate.id === playerId ? profile.weights.throne * 4.2 : 0);
      score += (candidate.id === state.basileusId ? 0.8 + (profile.weights.frontier * threat) : 0);
      score += (candidateStrength - playerStrength) * 0.08;
      score -= ambitionRisk * 0.5;
      score -= (candidate.id !== state.basileusId && threat > 0.75 ? threat * 0.9 : 0);
      score += Math.max(0, getRelationValue(meta, candidate.id, playerId)) * 0.2;

      return { candidateId: candidate.id, score };
    })
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.candidateId ?? playerId;
}

function scoreOfficeDestination(state, meta, playerId, officeKey, troopCount, destination, candidateId) {
  const profile = getProfileById(meta, playerId);
  const threat = getThreatLevel(state);
  const candidateAffinity = getAffinityScore(meta, playerId, candidateId);

  if (destination === 'frontier') {
    let score = troopCount * ((profile.weights.frontier * (1.1 + threat)) + 0.6);
    if (officeKey.startsWith('STRAT_')) score += 0.8;
    if (state.currentInvasion && state.currentInvasion.route.some(themeId => officeKey.endsWith(themeId))) score += 0.8;
    return score;
  }

  let score = troopCount * ((profile.weights.capital * 0.95) + (profile.weights.throne * 0.65) + (candidateAffinity * 0.4));
  if (candidateId === playerId) score += troopCount * 1.4;
  if (candidateId === state.basileusId) score += troopCount * 0.5;
  if (threat > 0.9 && candidateId !== state.basileusId) score -= troopCount * 0.6;
  return score;
}

function planMercenaries(state, meta, playerId, officePlans) {
  const profile = getProfileById(meta, playerId);
  const remainingRounds = getRemainingRounds(state);
  const goldOpportunity = profile.weights.wealth * (1.1 + ((remainingRounds / Math.max(1, state.maxRounds)) * 0.8));
  let availableGold = getPlayer(state, playerId).gold;
  const mercenaries = [];

  const rankedOffices = officePlans
    .map(plan => ({ ...plan, baseValue: Math.max(plan.frontierScore, plan.capitalScore) }))
    .sort((left, right) => right.baseValue - left.baseValue);

  for (const office of rankedOffices) {
    const maxMercsForOffice = Math.max(1, Math.min(4, Math.ceil(profile.weights.mercenary)));
    let hiredForOffice = 0;

    while (availableGold >= 3 && hiredForOffice < maxMercsForOffice) {
      const marginalValue = (office.baseValue * (0.4 + (profile.weights.mercenary * 0.25))) - goldOpportunity - (hiredForOffice * 0.75);
      if (marginalValue <= 0.15) break;
      availableGold -= 3;
      hiredForOffice++;
    }

    if (hiredForOffice > 0) {
      mercenaries.push({ officeKey: office.officeKey, count: hiredForOffice });
    }
  }

  return mercenaries;
}

function buildOrdersForPlayer(state, meta, logger, playerId) {
  const player = getPlayer(state, playerId);
  const offices = getOfficeList(state, playerId);
  const candidateId = chooseCandidate(state, meta, playerId);
  const deployments = {};
  const officePlans = [];

  for (const office of offices) {
    const professionalTroops = player.professionalArmies[office.key] || 0;
    const levyTroops = state.currentLevies?.[office.key] || 0;
    const troopCount = professionalTroops + levyTroops;
    const frontierScore = scoreOfficeDestination(state, meta, playerId, office.key, troopCount || 1, 'frontier', candidateId);
    const capitalScore = scoreOfficeDestination(state, meta, playerId, office.key, troopCount || 1, 'capital', candidateId);
    const destination = capitalScore > frontierScore ? 'capital' : 'frontier';
    deployments[office.key] = destination;
    officePlans.push({ officeKey: office.key, troopCount, frontierScore, capitalScore, destination });
  }

  const mercenaries = planMercenaries(state, meta, playerId, officePlans);

  let frontierTroops = 0;
  let capitalTroops = 0;
  for (const office of officePlans) {
    const mercs = mercenaries.find(entry => entry.officeKey === office.officeKey)?.count || 0;
    const totalTroops = office.troopCount + mercs;
    if (office.destination === 'frontier') frontierTroops += totalTroops;
    else capitalTroops += totalTroops;
  }

  meta.players[playerId].stats.frontierTroops += frontierTroops;
  meta.players[playerId].stats.capitalTroops += capitalTroops;
  meta.players[playerId].stats.coupVotes++;
  logger.push(`Round ${state.round} orders: ${describeActor(state, meta, playerId)} backs ${describeActor(state, meta, candidateId)} with ${capitalTroops} capital troops and ${frontierTroops} frontier troops.`);

  return { deployments, mercenaries, candidate: candidateId };
}

function buildStandingsSnapshot(state, meta) {
  return state.players
    .map(player => ({
      playerId: player.id,
      dynasty: player.dynasty,
      personalityId: meta.players[player.id].personalityId,
      gold: player.gold,
      themes: getPlayerThemes(state, player.id).length,
      majorTitles: player.majorTitles.slice(),
      minorTitles: getMinorTitleCount(state, player.id),
      professionalTroops: getPlayerProfessionalCount(player),
      basileus: state.basileusId === player.id,
    }))
    .sort((left, right) => right.gold - left.gold);
}

function recordRoundSnapshot(state, meta) {
  meta.roundSnapshots.push({
    round: state.round,
    invasion: state.currentInvasion?.name || null,
    basileusId: state.basileusId,
    occupiedThemes: Object.values(state.themes).filter(theme => theme.occupied && theme.id !== 'CPL').length,
    standings: buildStandingsSnapshot(state, meta),
  });
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
  const profile = getProfileById(meta, newBasileusId);
  let totalScore = 0;
  for (const titleKey of MAJOR_TITLE_KEYS) {
    const holderId = assignment[titleKey];
    const loyalty = getAffinityScore(meta, newBasileusId, holderId);
    const competence = getCompetenceScore(meta, holderId);
    const ambition = getAmbitionScore(meta, holderId);
    const churchBonus = titleKey === 'PATRIARCH' ? getProfileById(meta, holderId).weights.church * 0.45 : 0;
    const continuity = previousHolders[titleKey] === holderId ? 0.45 : 0;
    totalScore += (loyalty * profile.weights.loyalty) + (competence * 0.55) + churchBonus + continuity - (ambition * 0.45);
  }
  return totalScore;
}

function handleCoupReassignment(state, meta, logger, previousBasileusId) {
  if (state.gameOver) return;
  const newBasileusId = state.nextBasileusId;
  if (newBasileusId == null || newBasileusId === previousBasileusId) return;

  const previousHolders = {};
  for (const titleKey of MAJOR_TITLE_KEYS) {
    previousHolders[titleKey] = state.players.find(player => player.majorTitles.includes(titleKey))?.id ?? null;
  }

  const assignments = enumerateTitleAssignments(state, newBasileusId)
    .map(assignment => ({ assignment, score: scoreTitleAssignment(state, meta, newBasileusId, assignment, previousHolders) }))
    .sort((left, right) => right.score - left.score);

  const best = assignments[0];
  if (!best) return;

  applyCoupTitleReassignment(state, newBasileusId, best.assignment);
  meta.players[newBasileusId].stats.throneCaptures++;
  meta.totals.throneChanges++;

  for (const [titleKey, holderId] of Object.entries(best.assignment)) {
    adjustRelation(meta, holderId, newBasileusId, 1.2, 0);
    adjustRelation(meta, newBasileusId, holderId, 0.45, 0);
    const previousHolderId = previousHolders[titleKey];
    if (previousHolderId != null && previousHolderId !== holderId) {
      adjustRelation(meta, previousHolderId, newBasileusId, 0, 0.9);
    }
  }

  logger.push(`Round ${state.round} resolution: ${describeActor(state, meta, newBasileusId)} captures the throne and redistributes the four major offices.`);
}

function applyOrderCosts(state, meta, logger, playerId, orders) {
  for (const mercenary of orders.mercenaries) {
    const result = hireMercenaries(state, playerId, mercenary.officeKey, mercenary.count);
    if (!result?.ok) continue;
    meta.players[playerId].stats.mercsHired += mercenary.count;
    meta.players[playerId].stats.mercSpend += mercenary.count * 3;
    meta.totals.mercSpend += mercenary.count * 3;
    logger.push(`Round ${state.round} orders: ${describeActor(state, meta, playerId)} hires ${mercenary.count} mercenary troops for ${mercenary.officeKey}.`);
  }
}

function updatePostResolutionRelations(state, meta) {
  const winnerId = state.lastCoupResult?.winner ?? state.basileusId;
  for (const player of state.players) {
    const orders = state.allOrders[player.id];
    if (!orders) continue;
    if (orders.candidate === winnerId) {
      adjustRelation(meta, player.id, winnerId, 0.55, 0);
      adjustRelation(meta, winnerId, player.id, 0.35, 0);
    } else if (orders.candidate === player.id && player.id !== winnerId) {
      adjustRelation(meta, player.id, winnerId, 0, 0.35);
    }
  }
}

function simulateCourtPhase(state, meta) {
  phaseCourt(state);
  meta.decisionLog.push(`Round ${state.round}: ${state.currentInvasion.name} enters with strength ${state.currentInvasion.strength[0]}-${state.currentInvasion.strength[1]}.`);
  runAICourtAutomation(state, meta);
  if (isCourtComplete(state)) {
    phaseOrders(state);
  }
}

function simulateOrdersAndResolution(state, meta) {
  if (state.phase !== 'orders') {
    phaseOrders(state);
  }
  for (const player of state.players) {
    const orders = buildAIOrders(state, meta, player.id);
    applyAIOrderCosts(state, meta, player.id, orders);
    submitOrders(state, player.id, orders);
  }

  const previousBasileusId = state.basileusId;
  const invasionId = state.currentInvasion.id;
  const invasionName = state.currentInvasion.name;

  if (allOrdersSubmitted(state)) {
    phaseResolution(state);
  }

  handlePostResolutionAI(state, meta, { previousBasileusId, autoApplyTitleAssignments: true });

  recordRoundSnapshot(state, meta);
  phaseCleanup(state);
}

function buildFinalScores(state, meta) {
  const projectedAdministration = runAdministration(state);
  const scores = state.players.map(player => {
    const projectedIncome = projectedAdministration.income[player.id] || 0;
    return {
      playerId: player.id,
      dynasty: player.dynasty,
      personalityId: meta.players[player.id].personalityId,
      gold: player.gold,
      projectedIncome,
      wealth: computeFullWealth(state, player.id, projectedIncome),
      themes: getPlayerThemes(state, player.id).length,
      majorTitles: player.majorTitles.slice(),
      minorTitles: getMinorTitleCount(state, player.id),
      professionalTroops: getPlayerProfessionalCount(player),
      basileus: state.basileusId === player.id,
    };
  }).sort((left, right) => right.wealth - left.wealth);

  const topWealth = scores[0]?.wealth ?? 0;
  const winners = scores.filter(score => score.wealth === topWealth);
  return { scores, winners, topWealth };
}

function buildSampleGame(state, meta, scenario, seed, finalScores) {
  return {
    seed,
    scenario: {
      label: scenario.label,
      playerCount: scenario.playerCount,
      deckSize: scenario.deckSize,
    },
    empireFall: Boolean(state.gameOver?.type === 'fall'),
    guardTriggered: state.gameOver?.type === 'guard_abort',
    guardReason: state.gameOver?.reason || null,
    roundsPlayed: state.round,
    startingBasileusId: meta.startingBasileusId,
    finalBasileusId: state.basileusId,
    personalities: state.players.map(player => ({
      playerId: player.id,
      dynasty: player.dynasty,
      personalityId: meta.players[player.id].personalityId,
      personalityName: meta.players[player.id].profile?.name || getProfileById(meta, player.id)?.name || 'Unknown',
    })),
    finalScores: finalScores.scores,
    decisionLog: meta.decisionLog.lines.slice(),
    engineLog: state.log.slice(),
    roundSnapshots: meta.roundSnapshots.slice(),
  };
}

function runSingleGame(config, scenario, gameIndex, sampled) {
  const startedAt = Date.now();
  const seed = hashSeedString(`${config.seed}:${gameIndex}:${scenario.key}`);
  const state = createGameState({
    playerCount: scenario.playerCount,
    deckSize: scenario.deckSize,
    seed,
  });

  const seatProfiles = config.seatProfiles && Object.keys(config.seatProfiles).length
    ? { ...config.seatProfiles }
    : sampleSeatProfiles(state.rng, state.players.length, config.allowedProfiles || []);

  const meta = createAIMeta(state, {
    sampled,
    scenario,
    seatProfiles,
  });
  meta.startingBasileusId = state.basileusId;

  const guards = {
    maxLoopIterations: Math.max(8, toInt(config.maxLoopIterations, DEFAULT_SIMULATION_GUARDS.maxLoopIterations)),
    maxRounds: Math.max(scenario.deckSize + 2, toInt(config.maxRounds, Math.max(DEFAULT_SIMULATION_GUARDS.maxRounds, scenario.deckSize + 2))),
    strictTimeoutMs: Math.max(250, toInt(config.strictTimeoutMs, DEFAULT_SIMULATION_GUARDS.strictTimeoutMs)),
  };
  let loopIterations = 0;

  const abortForGuard = (reason) => {
    state.gameOver = {
      type: 'guard_abort',
      reason,
    };
    state.phase = 'scoring';
  };

  while (!state.gameOver && state.phase !== 'scoring') {
    loopIterations++;
    if (loopIterations > guards.maxLoopIterations) {
      abortForGuard('loop_limit');
      break;
    }
    if (state.round > guards.maxRounds) {
      abortForGuard('round_limit');
      break;
    }
    if ((Date.now() - startedAt) > guards.strictTimeoutMs) {
      abortForGuard('timeout');
      break;
    }

    phaseInvasion(state);
    if (state.phase === 'scoring' || state.gameOver) break;
    phaseAdministration(state);
    simulateCourtPhase(state, meta);
    if (!isCourtComplete(state)) {
      abortForGuard('court_incomplete');
      break;
    }
    simulateOrdersAndResolution(state, meta);
  }

  const finalScores = buildFinalScores(state, meta);
  const frontierTroops = sum(state.players.map(player => meta.players[player.id].stats.frontierTroops));
  const capitalTroops = sum(state.players.map(player => meta.players[player.id].stats.capitalTroops));
  const sampleGame = sampled ? buildSampleGame(state, meta, scenario, seed, finalScores) : null;

  return {
    index: gameIndex,
    seed,
    scenarioKey: scenario.key,
    scenarioLabel: scenario.label,
    playerCount: scenario.playerCount,
    deckSize: scenario.deckSize,
    empireFall: Boolean(state.gameOver?.type === 'fall'),
    guardTriggered: state.gameOver?.type === 'guard_abort',
    guardReason: state.gameOver?.reason || null,
    roundsPlayed: state.round,
    startingBasileusId: meta.startingBasileusId,
    winners: state.gameOver ? [] : finalScores.winners,
    scores: finalScores.scores,
    topWealth: finalScores.topWealth,
    frontierTroops,
    capitalTroops,
    totalLandBuys: meta.totals.landBuys,
    totalGifts: meta.totals.gifts,
    totalRecruits: meta.totals.recruits,
    totalRecruitOpportunities: meta.totals.recruitOpportunities,
    totalRevocations: meta.totals.revocations,
    totalMercSpend: meta.totals.mercSpend,
    throneChanges: meta.totals.throneChanges,
    occupiedThemesEnd: Object.values(state.themes).filter(theme => theme.occupied && theme.id !== 'CPL').length,
    playerMetrics: state.players.map(player => ({
      playerId: player.id,
      dynasty: player.dynasty,
      personalityId: meta.players[player.id].personalityId,
      profileName: meta.players[player.id].profile?.name || 'Unknown',
      profileTheory: meta.players[player.id].profile?.theory || 'Trained AI',
      frontierTroops: meta.players[player.id].stats.frontierTroops,
      capitalTroops: meta.players[player.id].stats.capitalTroops,
      mercSpend: meta.players[player.id].stats.mercSpend,
      mercsHired: meta.players[player.id].stats.mercsHired,
      landBuys: meta.players[player.id].stats.landBuys,
      themesGifted: meta.players[player.id].stats.themesGifted,
      recruits: meta.players[player.id].stats.recruits,
      recruitOpportunities: meta.players[player.id].stats.recruitOpportunities,
      coupVotes: meta.players[player.id].stats.coupVotes,
      revocations: meta.players[player.id].stats.revocations,
      throneCaptures: meta.players[player.id].stats.throneCaptures,
      supportIncumbentVotes: meta.players[player.id].stats.supportIncumbentVotes,
      supportSelfVotes: meta.players[player.id].stats.supportSelfVotes,
      finalWealth: finalScores.scores.find(score => score.playerId === player.id)?.wealth || 0,
      finalThemes: getPlayerThemes(state, player.id).length,
      finalTitles: player.majorTitles.length + getMinorTitleCount(state, player.id),
      finalGold: player.gold,
      isWinner: finalScores.winners.some(winner => winner.playerId === player.id) && !state.gameOver,
    })),
    wars: meta.wars,
    sampleGame,
  };
}

export function runSingleSimulationGame(options = {}) {
  const playerCount = sanitizePlayerCounts([options.playerCount])[0];
  const deckSize = clamp(toInt(options.deckSize, DEFAULT_BATCH_CONFIG.focused.deckSize), 1, 30);
  const allowedProfiles = sanitizeProfilePool(options.allowedProfiles);
  const seed = normalizeSeed(options.seed ?? Date.now());
  const scenario = {
    key: options.scenarioKey || `${playerCount}p-${deckSize}d-trained-custom`,
    label: options.scenarioLabel || `${playerCount} players / ${deckSize} invasions / trained roster`,
    playerCount,
    deckSize,
  };

  return runSingleGame({
    seed,
    allowedProfiles,
    seatProfiles: options.seatProfiles && typeof options.seatProfiles === 'object' ? { ...options.seatProfiles } : {},
    maxLoopIterations: options.maxLoopIterations,
    maxRounds: options.maxRounds,
    strictTimeoutMs: options.strictTimeoutMs,
  }, scenario, toInt(options.gameIndex, 0), Boolean(options.sampled));
}

function createBucket(key, label) {
  return {
    key,
    label,
    games: 0,
    empireFalls: 0,
    guardAborts: 0,
    roundsTotal: 0,
    winnerWealthTotal: 0,
    scoringGames: 0,
    ties: 0,
    throneChangesTotal: 0,
    mercSpendTotal: 0,
    frontierTroopsTotal: 0,
    capitalTroopsTotal: 0,
    landBuysTotal: 0,
    giftsTotal: 0,
    recruitsTotal: 0,
    recruitOpportunitiesTotal: 0,
    occupiedThemesTotal: 0,
  };
}

function applyGameToBucket(bucket, game) {
  bucket.games++;
  bucket.roundsTotal += game.roundsPlayed;
  bucket.empireFalls += game.empireFall ? 1 : 0;
  bucket.guardAborts += game.guardTriggered ? 1 : 0;
  bucket.throneChangesTotal += game.throneChanges;
  bucket.mercSpendTotal += game.totalMercSpend;
  bucket.frontierTroopsTotal += game.frontierTroops;
  bucket.capitalTroopsTotal += game.capitalTroops;
  bucket.landBuysTotal += game.totalLandBuys;
  bucket.giftsTotal += game.totalGifts;
  bucket.recruitsTotal += game.totalRecruits;
  bucket.recruitOpportunitiesTotal += game.totalRecruitOpportunities;
  bucket.occupiedThemesTotal += game.occupiedThemesEnd;
  if (!game.empireFall && !game.guardTriggered) {
    bucket.scoringGames++;
    bucket.winnerWealthTotal += game.topWealth;
    if (game.winners.length > 1) bucket.ties++;
  }
}

function finalizeBucket(bucket) {
  const totalTroops = bucket.frontierTroopsTotal + bucket.capitalTroopsTotal;
  return {
    key: bucket.key,
    label: bucket.label,
    games: bucket.games,
    empireFallRate: bucket.games ? bucket.empireFalls / bucket.games : 0,
    guardAbortRate: bucket.games ? bucket.guardAborts / bucket.games : 0,
    averageRounds: bucket.games ? bucket.roundsTotal / bucket.games : 0,
    averageWinnerWealth: bucket.scoringGames ? bucket.winnerWealthTotal / bucket.scoringGames : 0,
    tieRate: bucket.scoringGames ? bucket.ties / bucket.scoringGames : 0,
    averageThroneChanges: bucket.games ? bucket.throneChangesTotal / bucket.games : 0,
    averageMercSpend: bucket.games ? bucket.mercSpendTotal / bucket.games : 0,
    frontierShare: totalTroops ? bucket.frontierTroopsTotal / totalTroops : 0,
    averageLandBuys: bucket.games ? bucket.landBuysTotal / bucket.games : 0,
    averageGifts: bucket.games ? bucket.giftsTotal / bucket.games : 0,
    averageRecruits: bucket.games ? bucket.recruitsTotal / bucket.games : 0,
    recruitmentUtilization: bucket.recruitOpportunitiesTotal ? bucket.recruitsTotal / bucket.recruitOpportunitiesTotal : 0,
    averageOccupiedThemes: bucket.games ? bucket.occupiedThemesTotal / bucket.games : 0,
  };
}

function createPersonalityBucket(profileId, name, theory) {
  return {
    personalityId: profileId,
    name,
    theory,
    seats: 0,
    weightedWins: 0,
    wealthTotal: 0,
    frontierTroopsTotal: 0,
    capitalTroopsTotal: 0,
    mercSpendTotal: 0,
    landBuysTotal: 0,
    giftsTotal: 0,
    recruitsTotal: 0,
    recruitOpportunitiesTotal: 0,
    throneCapturesTotal: 0,
    titlesTotal: 0,
    themesTotal: 0,
    goldTotal: 0,
  };
}

function finalizePersonalityBucket(bucket) {
  const totalTroops = bucket.frontierTroopsTotal + bucket.capitalTroopsTotal;
  return {
    personalityId: bucket.personalityId,
    name: bucket.name,
    theory: bucket.theory,
    seats: bucket.seats,
    winShare: bucket.seats ? bucket.weightedWins / bucket.seats : 0,
    averageWealth: bucket.seats ? bucket.wealthTotal / bucket.seats : 0,
    frontierShare: totalTroops ? bucket.frontierTroopsTotal / totalTroops : 0,
    averageMercSpend: bucket.seats ? bucket.mercSpendTotal / bucket.seats : 0,
    averageLandBuys: bucket.seats ? bucket.landBuysTotal / bucket.seats : 0,
    averageGifts: bucket.seats ? bucket.giftsTotal / bucket.seats : 0,
    averageRecruits: bucket.seats ? bucket.recruitsTotal / bucket.seats : 0,
    recruitmentUtilization: bucket.recruitOpportunitiesTotal ? bucket.recruitsTotal / bucket.recruitOpportunitiesTotal : 0,
    averageThroneCaptures: bucket.seats ? bucket.throneCapturesTotal / bucket.seats : 0,
    averageTitles: bucket.seats ? bucket.titlesTotal / bucket.seats : 0,
    averageThemes: bucket.seats ? bucket.themesTotal / bucket.seats : 0,
    averageGold: bucket.seats ? bucket.goldTotal / bucket.seats : 0,
  };
}

function createInvasionBucket(id, name) {
  return {
    id,
    name,
    appearances: 0,
    victories: 0,
    defeats: 0,
    stalemates: 0,
    cplFalls: 0,
    themesLostTotal: 0,
    themesRecoveredTotal: 0,
  };
}

function finalizeInvasionBucket(bucket) {
  return {
    id: bucket.id,
    name: bucket.name,
    appearances: bucket.appearances,
    victoryRate: bucket.appearances ? bucket.victories / bucket.appearances : 0,
    defeatRate: bucket.appearances ? bucket.defeats / bucket.appearances : 0,
    stalemateRate: bucket.appearances ? bucket.stalemates / bucket.appearances : 0,
    cplFallRate: bucket.appearances ? bucket.cplFalls / bucket.appearances : 0,
    averageThemesLost: bucket.appearances ? bucket.themesLostTotal / bucket.appearances : 0,
    averageThemesRecovered: bucket.appearances ? bucket.themesRecoveredTotal / bucket.appearances : 0,
  };
}

function buildHighlights(report) {
  const highlights = [];
  const worstScenario = report.byScenario[0];
  const bestScenario = report.byScenario[report.byScenario.length - 1];
  const bestWinningProfile = report.byPersonality[0];
  const mostCooperativeProfile = report.byPersonality.slice().sort((left, right) => right.frontierShare - left.frontierShare)[0];
  const mostDangerousInvasion = report.invasions[0];
  const longestDeck = report.byDeckSize[report.byDeckSize.length - 1];
  const shortestDeck = report.byDeckSize[0];

  highlights.push(
    `Empire fall rate: ${roundTo(report.overview.empireFallRate * 100, 1)}% across ${report.overview.games} runs, with games lasting ${roundTo(report.overview.averageRounds, 2)} rounds on average.`
  );

  if (worstScenario) {
    highlights.push(
      `Least stable scenario: ${worstScenario.label} collapsed ${roundTo(worstScenario.empireFallRate * 100, 1)}% of the time.`
    );
  }

  if (bestScenario) {
    highlights.push(
      `Most resilient scenario: ${bestScenario.label} finished with only ${roundTo(bestScenario.empireFallRate * 100, 1)}% empire falls and an average winner wealth of ${roundTo(bestScenario.averageWinnerWealth, 1)}.`
    );
  }

  if (shortestDeck && longestDeck && shortestDeck.key !== longestDeck.key) {
    highlights.push(
      `Deck length effect: ${shortestDeck.label} fell ${roundTo(shortestDeck.empireFallRate * 100, 1)}% of the time versus ${roundTo(longestDeck.empireFallRate * 100, 1)}% for ${longestDeck.label}.`
    );
  }

  if (bestWinningProfile) {
    highlights.push(
      `Best conversion rate: ${bestWinningProfile.name} posted a ${roundTo(bestWinningProfile.winShare * 100, 1)}% seat win share.`
    );
  }

  if (mostCooperativeProfile) {
    highlights.push(
      `Most frontier-committed profile: ${mostCooperativeProfile.name} sent ${roundTo(mostCooperativeProfile.frontierShare * 100, 1)}% of its troops to the frontier.`
    );
  }

  if (mostDangerousInvasion) {
    highlights.push(
      `Most punishing invader: ${mostDangerousInvasion.name} triggered Constantinople falls in ${roundTo(mostDangerousInvasion.cplFallRate * 100, 1)}% of its appearances.`
    );
  }

  if (report.overview.recruitmentUtilization > 0.9) {
    highlights.push(
      `Recruitment pattern: AIs used ${roundTo(report.overview.recruitmentUtilization * 100, 1)}% of available professional recruitment slots, suggesting the current free-before-cleanup recruit rule is close to a dominant play.`
    );
  }

  return highlights;
}

function finalizeReport(config, startedAt, completedGames, buckets, personalityBuckets, invasionBuckets, sampledGames) {
  const overview = finalizeBucket(buckets.overview);
  const byScenario = Object.values(buckets.byScenario).map(finalizeBucket).sort((left, right) => right.empireFallRate - left.empireFallRate || right.games - left.games);
  const byPlayerCount = Object.values(buckets.byPlayerCount).map(finalizeBucket).sort((left, right) => left.key.localeCompare(right.key));
  const byDeckSize = Object.values(buckets.byDeckSize).map(finalizeBucket).sort((left, right) => Number(left.key) - Number(right.key));
  const byPersonality = Object.values(personalityBuckets).map(finalizePersonalityBucket).sort((left, right) => right.winShare - left.winShare || right.averageWealth - left.averageWealth);
  const invasions = Object.values(invasionBuckets).map(finalizeInvasionBucket).sort((left, right) => right.cplFallRate - left.cplFallRate || right.defeatRate - left.defeatRate);

  const report = {
    generatedAt: new Date().toISOString(),
    config,
    runtimeMs: Date.now() - startedAt,
    overview: {
      ...overview,
      games: completedGames,
      empireFallRate: overview.empireFallRate,
      averageRounds: overview.averageRounds,
      recruitmentUtilization: overview.recruitmentUtilization,
    },
    byScenario,
    byPlayerCount,
    byDeckSize,
    byPersonality,
    invasions,
    sampledGames,
  };

  report.highlights = buildHighlights(report);
  return report;
}

export async function runSimulationBatch(rawConfig = {}, onProgress = null) {
  const startedAt = Date.now();
  const config = normalizeBatchConfig(rawConfig);
  const scenarioPlan = buildScenarioPlan(config);
  const sampleIndices = buildSampleIndexSet(config.simulations, config.samplePercent);

  const buckets = {
    overview: createBucket('overview', 'Overview'),
    byScenario: {},
    byPlayerCount: {},
    byDeckSize: {},
  };

  const personalityBuckets = {};
  const invasionBuckets = {};
  const sampledGames = [];
  if (!config.allowedProfiles.length) {
    throw new Error('No trained AI profiles were selected for this simulation batch.');
  }

  for (let gameIndex = 0; gameIndex < config.simulations; gameIndex++) {
    const scenario = scenarioPlan[gameIndex % scenarioPlan.length];
    const sampled = sampleIndices.has(gameIndex);
    const game = runSingleGame(config, scenario, gameIndex, sampled);

    applyGameToBucket(buckets.overview, game);

    if (!buckets.byScenario[game.scenarioKey]) {
      buckets.byScenario[game.scenarioKey] = createBucket(game.scenarioKey, game.scenarioLabel);
    }
    applyGameToBucket(buckets.byScenario[game.scenarioKey], game);

    const playerCountKey = `${game.playerCount}`;
    if (!buckets.byPlayerCount[playerCountKey]) {
      buckets.byPlayerCount[playerCountKey] = createBucket(playerCountKey, `${game.playerCount} players`);
    }
    applyGameToBucket(buckets.byPlayerCount[playerCountKey], game);

    const deckKey = `${game.deckSize}`;
    if (!buckets.byDeckSize[deckKey]) {
      buckets.byDeckSize[deckKey] = createBucket(deckKey, `${game.deckSize} invasions`);
    }
    applyGameToBucket(buckets.byDeckSize[deckKey], game);

    const winnerShare = game.empireFall || !game.winners.length ? 0 : (1 / game.winners.length);
    for (const playerMetric of game.playerMetrics) {
      if (!personalityBuckets[playerMetric.personalityId]) {
        personalityBuckets[playerMetric.personalityId] = createPersonalityBucket(
          playerMetric.personalityId,
          playerMetric.profileName || playerMetric.personalityId,
          playerMetric.profileTheory || 'Trained AI'
        );
      }
      const bucket = personalityBuckets[playerMetric.personalityId];
      bucket.seats++;
      bucket.weightedWins += playerMetric.isWinner ? winnerShare : 0;
      bucket.wealthTotal += playerMetric.finalWealth;
      bucket.frontierTroopsTotal += playerMetric.frontierTroops;
      bucket.capitalTroopsTotal += playerMetric.capitalTroops;
      bucket.mercSpendTotal += playerMetric.mercSpend;
      bucket.landBuysTotal += playerMetric.landBuys;
      bucket.giftsTotal += playerMetric.themesGifted;
      bucket.recruitsTotal += playerMetric.recruits;
      bucket.recruitOpportunitiesTotal += playerMetric.recruitOpportunities;
      bucket.throneCapturesTotal += playerMetric.throneCaptures;
      bucket.titlesTotal += playerMetric.finalTitles;
      bucket.themesTotal += playerMetric.finalThemes;
      bucket.goldTotal += playerMetric.finalGold;
    }

    for (const war of game.wars) {
      if (!invasionBuckets[war.id]) {
        invasionBuckets[war.id] = createInvasionBucket(war.id, war.name);
      }
      const bucket = invasionBuckets[war.id];
      bucket.appearances++;
      if (war.outcome === 'victory') bucket.victories++;
      if (war.outcome === 'defeat') bucket.defeats++;
      if (war.outcome === 'stalemate') bucket.stalemates++;
      if (war.reachedCPL) bucket.cplFalls++;
      bucket.themesLostTotal += war.themesLost;
      bucket.themesRecoveredTotal += war.themesRecovered;
    }

    if (game.sampleGame) sampledGames.push(game.sampleGame);

    if (onProgress && ((gameIndex + 1) % 10 === 0 || gameIndex + 1 === config.simulations)) {
      onProgress({
        completed: gameIndex + 1,
        total: config.simulations,
        scenarioLabel: scenario.label,
        elapsedMs: Date.now() - startedAt,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return finalizeReport(config, startedAt, config.simulations, buckets, personalityBuckets, invasionBuckets, sampledGames);
}
