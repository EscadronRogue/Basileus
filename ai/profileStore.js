import {
  DEFAULT_META_PARAMS,
  META_PARAM_DEFS,
  META_PARAM_KEYS,
  NEUTRAL_PROFILE,
  PERSONALITIES,
  PROFILE_TACTIC_KEYS,
  PROFILE_WEIGHT_KEYS,
} from './personalities.js';

const STORAGE_KEY = 'basileus.savedAiProfiles.v1';
const EXPORTED_PROFILE_INDEX_PATH = '/api/personalities/exported';
const GITHUB_PERSONALITY_FOLDER = 'trained-personalities';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundTo(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function createProfileId(name = 'trained-ai') {
  const base = slugify(name) || 'trained-ai';
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}

function buildUniqueProfileName(name, existingNames) {
  const baseName = String(name || 'Trained AI').trim() || 'Trained AI';
  if (!existingNames.has(baseName)) return baseName;
  let copyIndex = 2;
  while (existingNames.has(`${baseName} (${copyIndex})`)) {
    copyIndex += 1;
  }
  return `${baseName} (${copyIndex})`;
}

function profilesEquivalent(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function prepareProfileForLibrary(profile, existingProfiles) {
  const conflictingIdProfile = existingProfiles.find(existing => existing.id === profile.id) || null;
  const conflictingName = existingProfiles.some(existing => existing.name === profile.name);

  if (conflictingIdProfile && profilesEquivalent(conflictingIdProfile, profile)) {
    return null;
  }

  if (!conflictingIdProfile && !conflictingName) {
    return profile;
  }

  const uniqueName = buildUniqueProfileName(
    profile.name,
    new Set(existingProfiles.map(existing => existing.name))
  );

  return {
    ...profile,
    id: createProfileId(uniqueName),
    name: uniqueName,
    shortName: uniqueName,
  };
}

function getStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readStore() {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.profiles) ? parsed.profiles : Array.isArray(parsed) ? parsed : [];
    return list.map(profile => normalizeAiProfile(profile)).filter(Boolean);
  } catch {
    return [];
  }
}

function writeStore(profiles) {
  const storage = getStorage();
  if (!storage) return [];
  const normalized = profiles.map(profile => normalizeAiProfile(profile)).filter(Boolean);
  storage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    profiles: normalized,
  }));
  return normalized;
}

function sortProfiles(profiles) {
  return profiles
    .slice()
    .sort((left, right) => {
      const timeDelta = Date.parse(right.training?.trainedAt || '') - Date.parse(left.training?.trainedAt || '');
      if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
      return left.name.localeCompare(right.name);
    });
}

async function fetchJsonMaybe(path) {
  if (typeof fetch !== 'function') return null;
  try {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function readMetaContent(name) {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return '';
  const value = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function readConfiguredPersonalityBase() {
  const browserWindow = typeof window !== 'undefined' ? window : null;
  return normalizeBaseUrl(
    browserWindow?.BASILEUS_PERSONALITIES_URL
      || browserWindow?.BASILEUS_MULTIPLAYER_URL
      || readMetaContent('basileus-personalities-url')
      || readMetaContent('basileus-multiplayer-url')
  );
}

function resolveGithubPagesPersonalitySource() {
  if (typeof window === 'undefined' || !window.location) return null;
  const { hostname, pathname } = window.location;
  if (!String(hostname || '').endsWith('.github.io')) return null;

  const owner = String(hostname).replace(/\.github\.io$/i, '').trim();
  const repo = String(pathname || '').split('/').filter(Boolean)[0] || '';
  if (!owner || !repo) return null;

  return {
    type: 'github-contents',
    path: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${GITHUB_PERSONALITY_FOLDER}?ref=main`,
  };
}

function resolveExportedProfileSources() {
  const configuredBase = readConfiguredPersonalityBase();
  const sources = [];

  if (configuredBase) {
    sources.push({ type: 'api', path: `${configuredBase}${EXPORTED_PROFILE_INDEX_PATH}` });
  }

  const githubSource = resolveGithubPagesPersonalitySource();
  if (githubSource) {
    sources.push(githubSource);
  } else if (!configuredBase) {
    sources.push({ type: 'api', path: EXPORTED_PROFILE_INDEX_PATH });
  }

  return sources;
}

function isLoadableProfileFileName(fileName) {
  const lower = String(fileName || '').toLowerCase();
  return lower.endsWith('.json') && lower !== 'manifest.json' && lower !== 'latest-manifest.json';
}

async function loadProfilesFromIndexApi(endpointPath) {
  const payload = await fetchJsonMaybe(endpointPath);
  const rawProfiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
  if (!rawProfiles.length) return [];
  return rawProfiles
    .map(profile => normalizeAiProfile(profile))
    .filter(Boolean)
    .map(profile => ({ ...profile, librarySource: 'exported' }));
}

async function loadProfilesFromGithubContentsApi(endpointPath) {
  const entries = await fetchJsonMaybe(endpointPath);
  if (!Array.isArray(entries) || !entries.length) return [];

  const files = entries
    .filter(entry => entry?.type === 'file' && isLoadableProfileFileName(entry.name) && entry.download_url)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));

  const profiles = await Promise.all(files.map(async (entry) => {
    const rawProfile = await fetchJsonMaybe(entry.download_url);
    const profile = normalizeAiProfile(rawProfile);
    return profile ? { ...profile, librarySource: 'exported', file: entry.name } : null;
  }));

  return profiles.filter(Boolean);
}

async function loadProfilesFromSource(source) {
  if (source.type === 'github-contents') return loadProfilesFromGithubContentsApi(source.path);
  return loadProfilesFromIndexApi(source.path);
}

async function readExportedProfiles() {
  const merged = new Map();
  const exportedProfiles = await Promise.all(
    resolveExportedProfileSources().map(source => loadProfilesFromSource(source))
  );

  for (const profile of exportedProfiles.flat()) {
    if (!merged.has(profile.id)) {
      merged.set(profile.id, profile);
    }
  }
  return [...merged.values()];
}
function safeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function dominantWeightLabels(weights) {
  const labels = {
    wealth: 'wealth',
    land: 'land',
    frontier: 'frontier defense',
    capital: 'capital intrigue',
    throne: 'throne pressure',
    church: 'church leverage',
    loyalty: 'coalition loyalty',
    retaliation: 'retaliation',
    selfAppointment: 'self-promotion',
    mercenary: 'mercenary force',
    revocation: 'revocations',
  };

  return PROFILE_WEIGHT_KEYS
    .map(key => ({ key, label: labels[key] || key, value: weights[key] || 0 }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 2)
    .map(entry => entry.label);
}

function buildAutoSummary(profile) {
  const topLabels = dominantWeightLabels(profile.weights);
  const topText = topLabels.length ? topLabels.join(' and ') : 'balanced play';
  const sourceText = 'Self-play evolved';
  return `${sourceText}, leaning on ${topText}.`;
}

function normalizeWeights(rawWeights = {}) {
  const normalized = {};
  for (const key of PROFILE_WEIGHT_KEYS) {
    normalized[key] = roundTo(clamp(safeNumber(rawWeights[key], NEUTRAL_PROFILE.weights[key] || 1), 0.15, 4.5));
  }
  return normalized;
}

function normalizeTactics(rawTactics = {}) {
  return {
    independence: roundTo(clamp(safeNumber(rawTactics.independence, 1), 0.6, 2.1)),
    frontierAlarm: roundTo(clamp(safeNumber(rawTactics.frontierAlarm, 1.2), 0.7, 2.4)),
    churchReserve: roundTo(clamp(safeNumber(rawTactics.churchReserve, 1), 0.55, 2.4)),
    incumbencyGrip: roundTo(clamp(safeNumber(rawTactics.incumbencyGrip, 1.2), 0.7, 2.4)),
  };
}

function normalizeMetaParams(rawMeta = {}) {
  const normalized = {};
  for (const [key, fallback, min, max] of META_PARAM_DEFS) {
    normalized[key] = roundTo(clamp(safeNumber(rawMeta[key], fallback), min, max), 4);
  }
  return normalized;
}

function inferBasePersonalityId(weights) {
  let bestId = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [personalityId, personality] of Object.entries(PERSONALITIES)) {
    let distance = 0;
    for (const key of PROFILE_WEIGHT_KEYS) {
      distance += Math.abs((weights[key] || 0) - (personality.weights[key] || 0));
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = personalityId;
    }
  }
  return bestId;
}

function normalizeTrainingMetadata(rawTraining = {}) {
  const generation = safeInteger(rawTraining.generation, 0);
  const matches = safeInteger(rawTraining.matches, 0);
  const wins = safeNumber(rawTraining.wins, 0);
  const winShare = clamp(safeNumber(rawTraining.winShare, matches ? wins / matches : 0), 0, 1);
  const averageFitness = safeNumber(rawTraining.averageFitness, 0);
  const championScore = safeNumber(rawTraining.championScore, rawTraining.rankingScore ?? averageFitness);
  const finalScoreMean = safeNumber(rawTraining.finalScoreMean, rawTraining.averageFinalScore ?? rawTraining.averageWealth);
  const finalScoreAdvantage = safeNumber(rawTraining.finalScoreAdvantage, 0);
  const finalScorePlacement = clamp(safeNumber(rawTraining.finalScorePlacement, rawTraining.holdoutWealthPercentile ?? rawTraining.wealthPercentile), 0, 1);
  const survivingFinalScoreMean = safeNumber(rawTraining.survivingFinalScoreMean, rawTraining.holdoutSurvivingFinalScoreMean ?? finalScoreMean);
  const unsafeRate = clamp(safeNumber(rawTraining.unsafeRate, safeNumber(rawTraining.empireFallRate, 0) + safeNumber(rawTraining.guardRate, 0)), 0, 1);
  const averageWealth = finalScoreMean;
  const empireFallRate = clamp(safeNumber(rawTraining.empireFallRate, 0), 0, 1);
  const mirroredSeatEquity = clamp(safeNumber(rawTraining.mirroredSeatEquity, 1), 0, 1);
  const mirroredSeatVariance = Math.max(0, safeNumber(rawTraining.mirroredSeatVariance, 0));
  const fitnessVariance = Math.max(0, safeNumber(rawTraining.fitnessVariance, 0));
  const trainedAt = rawTraining.trainedAt ? String(rawTraining.trainedAt) : new Date().toISOString();
  const behaviorProfile = safeRecord(rawTraining.behaviorProfile);
  const perScenario = safeArray(rawTraining.perScenario).map(entry => ({
    key: String(entry?.key || ''),
    playerCount: safeInteger(entry?.playerCount, 4),
    deckSize: safeInteger(entry?.deckSize, 9),
    matches: safeInteger(entry?.matches, 0),
    winShare: roundTo(clamp(safeNumber(entry?.winShare, 0), 0, 1), 4),
    finalScoreMean: roundTo(safeNumber(entry?.finalScoreMean, entry?.averageWinnerWealth ?? 0), 2),
    finalScoreAdvantage: roundTo(safeNumber(entry?.finalScoreAdvantage, 0), 4),
    finalScorePlacement: roundTo(clamp(safeNumber(entry?.finalScorePlacement, 0), 0, 1), 4),
    survivingFinalScoreMean: roundTo(safeNumber(entry?.survivingFinalScoreMean, 0), 2),
    empireFallRate: roundTo(clamp(safeNumber(entry?.empireFallRate, 0), 0, 1), 4),
    guardRate: roundTo(clamp(safeNumber(entry?.guardRate, 0), 0, 1), 4),
    unsafeRate: roundTo(clamp(safeNumber(entry?.unsafeRate, 0), 0, 1), 4),
  })).filter(entry => entry.key);

  return {
    generation,
    matches,
    wins: roundTo(wins, 2),
    winShare: roundTo(winShare, 4),
    championScore: roundTo(championScore, 3),
    averageFitness: roundTo(averageFitness, 3),
    finalScoreMean: roundTo(finalScoreMean, 2),
    finalScoreAdvantage: roundTo(finalScoreAdvantage, 4),
    finalScorePlacement: roundTo(finalScorePlacement, 4),
    survivingFinalScoreMean: roundTo(survivingFinalScoreMean, 2),
    unsafeRate: roundTo(unsafeRate, 4),
    averageFinalScore: roundTo(finalScoreMean, 2),
    averageWealth: roundTo(averageWealth, 2),
    empireFallRate: roundTo(empireFallRate, 4),
    mirroredSeatEquity: roundTo(mirroredSeatEquity, 4),
    mirroredSeatVariance: roundTo(mirroredSeatVariance, 4),
    fitnessVariance: roundTo(fitnessVariance, 4),
    fitnessPresetId: rawTraining.fitnessPresetId ? String(rawTraining.fitnessPresetId) : 'balanced',
    scenarioMode: rawTraining.scenarioMode === 'focused' ? 'focused' : 'generalist',
    playerCount: safeInteger(rawTraining.playerCount, 4),
    deckSize: safeInteger(rawTraining.deckSize, 9),
    playerCounts: safeArray(rawTraining.playerCounts).map(value => safeInteger(value, 0)).filter(Boolean),
    deckSizes: safeArray(rawTraining.deckSizes).map(value => safeInteger(value, 0)).filter(Boolean),
    populationPresetId: rawTraining.populationPresetId ? String(rawTraining.populationPresetId) : 'balanced',
    seed: rawTraining.seed == null ? '' : String(rawTraining.seed),
    trainedAt,
    trainMatches: safeInteger(rawTraining.trainMatches, 0),
    validationMatches: safeInteger(rawTraining.validationMatches, 0),
    holdoutMatches: safeInteger(rawTraining.holdoutMatches, 0),
    trainWinShare: roundTo(clamp(safeNumber(rawTraining.trainWinShare, 0), 0, 1), 4),
    validationWinShare: roundTo(clamp(safeNumber(rawTraining.validationWinShare, 0), 0, 1), 4),
    holdoutWinShare: roundTo(clamp(safeNumber(rawTraining.holdoutWinShare, 0), 0, 1), 4),
    trainFinalScoreMean: roundTo(safeNumber(rawTraining.trainFinalScoreMean, rawTraining.averageFinalScore ?? 0), 2),
    validationFinalScoreMean: roundTo(safeNumber(rawTraining.validationFinalScoreMean, 0), 2),
    holdoutFinalScoreMean: roundTo(safeNumber(rawTraining.holdoutFinalScoreMean, finalScoreMean), 2),
    trainFinalScoreAdvantage: roundTo(safeNumber(rawTraining.trainFinalScoreAdvantage, 0), 4),
    validationFinalScoreAdvantage: roundTo(safeNumber(rawTraining.validationFinalScoreAdvantage, 0), 4),
    holdoutFinalScoreAdvantage: roundTo(safeNumber(rawTraining.holdoutFinalScoreAdvantage, finalScoreAdvantage), 4),
    trainSurvivingFinalScoreMean: roundTo(safeNumber(rawTraining.trainSurvivingFinalScoreMean, 0), 2),
    validationSurvivingFinalScoreMean: roundTo(safeNumber(rawTraining.validationSurvivingFinalScoreMean, 0), 2),
    holdoutSurvivingFinalScoreMean: roundTo(safeNumber(rawTraining.holdoutSurvivingFinalScoreMean, survivingFinalScoreMean), 2),
    trainEmpireFallRate: roundTo(clamp(safeNumber(rawTraining.trainEmpireFallRate, 0), 0, 1), 4),
    validationEmpireFallRate: roundTo(clamp(safeNumber(rawTraining.validationEmpireFallRate, 0), 0, 1), 4),
    holdoutEmpireFallRate: roundTo(clamp(safeNumber(rawTraining.holdoutEmpireFallRate, 0), 0, 1), 4),
    trainMirroredSeatEquity: roundTo(clamp(safeNumber(rawTraining.trainMirroredSeatEquity, 1), 0, 1), 4),
    validationMirroredSeatEquity: roundTo(clamp(safeNumber(rawTraining.validationMirroredSeatEquity, 1), 0, 1), 4),
    holdoutMirroredSeatEquity: roundTo(clamp(safeNumber(rawTraining.holdoutMirroredSeatEquity, mirroredSeatEquity), 0, 1), 4),
    trainMirroredSeatVariance: roundTo(Math.max(0, safeNumber(rawTraining.trainMirroredSeatVariance, 0)), 4),
    validationMirroredSeatVariance: roundTo(Math.max(0, safeNumber(rawTraining.validationMirroredSeatVariance, 0)), 4),
    holdoutMirroredSeatVariance: roundTo(Math.max(0, safeNumber(rawTraining.holdoutMirroredSeatVariance, mirroredSeatVariance)), 4),
    trainWealthPercentile: roundTo(clamp(safeNumber(rawTraining.trainWealthPercentile, 0), 0, 1), 4),
    validationWealthPercentile: roundTo(clamp(safeNumber(rawTraining.validationWealthPercentile, 0), 0, 1), 4),
    holdoutWealthPercentile: roundTo(clamp(safeNumber(rawTraining.holdoutWealthPercentile, 0), 0, 1), 4),
    guardRate: roundTo(clamp(safeNumber(rawTraining.guardRate, 0), 0, 1), 4),
    paretoFront: safeInteger(rawTraining.paretoFront, 0),
    crowdingDistance: roundTo(Math.max(0, safeNumber(rawTraining.crowdingDistance, 0)), 4),
    noveltyScore: roundTo(Math.max(0, safeNumber(rawTraining.noveltyScore, 0)), 4),
    noveltyPercentile: roundTo(clamp(safeNumber(rawTraining.noveltyPercentile, 0), 0, 1), 4),
    seatBias: roundTo(safeNumber(rawTraining.seatBias, 0), 4),
    bestMatchup: rawTraining.bestMatchup ? String(rawTraining.bestMatchup) : '',
    worstMatchup: rawTraining.worstMatchup ? String(rawTraining.worstMatchup) : '',
    mainBehavior: rawTraining.mainBehavior ? String(rawTraining.mainBehavior) : '',
    safetyMode: rawTraining.safetyMode ? String(rawTraining.safetyMode) : 'win-rate-first',
    behaviorProfile: {
      frontierTroopShare: roundTo(clamp(safeNumber(behaviorProfile.frontierTroopShare, 0), 0, 1), 4),
      capitalTroopShare: roundTo(clamp(safeNumber(behaviorProfile.capitalTroopShare, 0), 0, 1), 4),
      averageLandBuys: roundTo(Math.max(0, safeNumber(behaviorProfile.averageLandBuys, 0)), 4),
      averageChurchGifts: roundTo(Math.max(0, safeNumber(behaviorProfile.averageChurchGifts, 0)), 4),
      averageRevocations: roundTo(Math.max(0, safeNumber(behaviorProfile.averageRevocations, 0)), 4),
      averageThroneCaptures: roundTo(Math.max(0, safeNumber(behaviorProfile.averageThroneCaptures, 0)), 4),
      incumbentSupportRate: roundTo(clamp(safeNumber(behaviorProfile.incumbentSupportRate, 0), 0, 1), 4),
      selfSupportRate: roundTo(clamp(safeNumber(behaviorProfile.selfSupportRate, 0), 0, 1), 4),
      goldHoardingRate: roundTo(clamp(safeNumber(behaviorProfile.goldHoardingRate, 0), 0, 1), 4),
      averageMercSpend: roundTo(Math.max(0, safeNumber(behaviorProfile.averageMercSpend, 0)), 4),
      recruitmentUtilization: roundTo(clamp(safeNumber(behaviorProfile.recruitmentUtilization, 0), 0, 1), 4),
    },
    perOpponentTypeWinRate: safeRecord(rawTraining.perOpponentTypeWinRate),
    perSeatWinRate: safeRecord(rawTraining.perSeatWinRate),
    perScenario,
  };
}

export function normalizeAiProfile(rawProfile = null) {
  if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) return null;

  const weights = normalizeWeights(rawProfile.weights || {});
  const tactics = normalizeTactics(rawProfile.tactics || {});
  const meta = normalizeMetaParams(rawProfile.meta || {});
  const hasExplicitBase = Object.prototype.hasOwnProperty.call(rawProfile, 'basePersonalityId');
  let basePersonalityId = null;
  if (PERSONALITIES[rawProfile.basePersonalityId]) {
    basePersonalityId = rawProfile.basePersonalityId;
  } else if (!hasExplicitBase && !['trained', 'emergent-trained'].includes(String(rawProfile.source || '').trim())) {
    basePersonalityId = inferBasePersonalityId(weights);
  }
  const fallbackName = ['trained', 'emergent-trained'].includes(String(rawProfile.source || '').trim())
    ? 'Emergent AI'
    : 'Custom AI';
  const name = String(rawProfile.name || fallbackName).trim() || fallbackName;
  const id = String(rawProfile.id || createProfileId(name)).trim() || createProfileId(name);
  const profile = {
    id,
    name,
    shortName: String(rawProfile.shortName || name).trim() || name,
    theory: String(rawProfile.theory || 'Self-play trained profile').trim() || 'Self-play trained profile',
    summary: String(rawProfile.summary || '').trim(),
    source: String(rawProfile.source || 'trained').trim() || 'trained',
    basePersonalityId,
    weights,
    tactics,
    meta,
    training: normalizeTrainingMetadata(rawProfile.training || {}),
  };
  if (!profile.summary) profile.summary = buildAutoSummary(profile);
  return profile;
}

export function listSavedAiProfiles() {
  return sortProfiles(readStore());
}

export async function listAvailableAiProfiles() {
  const savedProfiles = listSavedAiProfiles().map(profile => ({ ...profile, librarySource: 'saved' }));
  const exportedProfiles = await readExportedProfiles();
  const merged = new Map(savedProfiles.map(profile => [profile.id, profile]));

  for (const profile of exportedProfiles) {
    const existing = merged.get(profile.id);
    if (existing) {
      merged.set(profile.id, {
        ...existing,
        librarySource: existing.librarySource === 'saved' ? 'saved+exported' : existing.librarySource,
      });
      continue;
    }
    merged.set(profile.id, profile);
  }

  return sortProfiles([...merged.values()]);
}

export function getSavedAiProfile(profileId) {
  return listSavedAiProfiles().find(profile => profile.id === profileId) || null;
}

export function saveAiProfiles(rawProfiles, options = {}) {
  const incoming = (Array.isArray(rawProfiles) ? rawProfiles : [rawProfiles])
    .map(profile => normalizeAiProfile(profile))
    .filter(Boolean);
  const existing = options.replace ? [] : listSavedAiProfiles();
  const merged = new Map(existing.map(profile => [profile.id, profile]));
  const workingSet = existing.slice();
  for (const profile of incoming) {
    const preparedProfile = options.replace ? profile : prepareProfileForLibrary(profile, workingSet);
    if (!preparedProfile) continue;
    merged.set(preparedProfile.id, preparedProfile);
    workingSet.push(preparedProfile);
  }
  return writeStore([...merged.values()]);
}

export function upsertSavedAiProfile(profile) {
  const normalized = normalizeAiProfile(profile);
  if (!normalized) return listSavedAiProfiles();
  const existing = listSavedAiProfiles().filter(entry => entry.id !== normalized.id);
  existing.push(normalized);
  return writeStore(existing);
}

export function deleteSavedAiProfile(profileId) {
  const remaining = listSavedAiProfiles().filter(profile => profile.id !== profileId);
  return writeStore(remaining);
}

export function clearSavedAiProfiles() {
  return writeStore([]);
}

export function formatProfileSnapshot(profile) {
  const normalized = normalizeAiProfile(profile);
  if (!normalized) return '';
  const topLabels = dominantWeightLabels(normalized.weights);
  const focus = topLabels.length ? topLabels.join(', ') : 'balanced';
  return `${normalized.name} - ${focus}`;
}

export { STORAGE_KEY as AI_PROFILE_STORAGE_KEY };
