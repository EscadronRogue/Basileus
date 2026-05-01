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
const EXPORTED_PROFILE_MANIFEST_PATHS = [
  'trained-personalities/latest/latest-manifest.json',
  'trained-personalities/latest/manifest.json',
  'trained-personalities/definitive/manifest.json',
];

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

function resolveManifestBaseDir(manifestPath, manifest) {
  const manifestDir = manifestPath.replace(/[^/]+$/, '');
  if (manifestPath.endsWith('/latest/latest-manifest.json') && manifest?.runId) {
    return `${manifestDir}${manifest.runId}/`;
  }
  return manifestDir;
}

async function loadProfilesFromManifest(manifestPath) {
  const manifest = await fetchJsonMaybe(manifestPath);
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) return [];

  const baseDir = resolveManifestBaseDir(manifestPath, manifest);
  const loadedProfiles = await Promise.all(
    manifest.files
      .map(entry => entry?.file)
      .filter(Boolean)
      .map(fileName => fetchJsonMaybe(`${baseDir}${fileName}`))
  );

  return loadedProfiles
    .map(profile => normalizeAiProfile(profile))
    .filter(Boolean)
    .map(profile => ({ ...profile, librarySource: 'exported' }));
}

async function readExportedProfiles() {
  const manifestProfiles = await Promise.all(
    EXPORTED_PROFILE_MANIFEST_PATHS.map(path => loadProfilesFromManifest(path))
  );
  const merged = new Map();
  for (const profile of manifestProfiles.flat()) {
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
  const sourceText = profile.basePersonalityId && PERSONALITIES[profile.basePersonalityId]
    ? `Evolved from ${PERSONALITIES[profile.basePersonalityId].name.toLowerCase()} instincts`
    : 'Self-play evolved';
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
  let bestId = 'reciprocator';
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
  const averageWealth = safeNumber(rawTraining.averageWealth, 0);
  const empireFallRate = clamp(safeNumber(rawTraining.empireFallRate, 0), 0, 1);
  const fitnessVariance = Math.max(0, safeNumber(rawTraining.fitnessVariance, 0));
  const trainedAt = rawTraining.trainedAt ? String(rawTraining.trainedAt) : new Date().toISOString();
  const behaviorProfile = safeRecord(rawTraining.behaviorProfile);

  return {
    generation,
    matches,
    wins: roundTo(wins, 2),
    winShare: roundTo(winShare, 4),
    championScore: roundTo(championScore, 3),
    averageFitness: roundTo(averageFitness, 3),
    averageWealth: roundTo(averageWealth, 2),
    empireFallRate: roundTo(empireFallRate, 4),
    fitnessVariance: roundTo(fitnessVariance, 4),
    fitnessPresetId: rawTraining.fitnessPresetId ? String(rawTraining.fitnessPresetId) : 'balanced',
    playerCount: safeInteger(rawTraining.playerCount, 4),
    deckSize: safeInteger(rawTraining.deckSize, 9),
    populationPresetId: rawTraining.populationPresetId ? String(rawTraining.populationPresetId) : 'balanced',
    seed: rawTraining.seed == null ? '' : String(rawTraining.seed),
    trainedAt,
    trainMatches: safeInteger(rawTraining.trainMatches, 0),
    validationMatches: safeInteger(rawTraining.validationMatches, 0),
    holdoutMatches: safeInteger(rawTraining.holdoutMatches, 0),
    trainWinShare: roundTo(clamp(safeNumber(rawTraining.trainWinShare, 0), 0, 1), 4),
    validationWinShare: roundTo(clamp(safeNumber(rawTraining.validationWinShare, 0), 0, 1), 4),
    holdoutWinShare: roundTo(clamp(safeNumber(rawTraining.holdoutWinShare, 0), 0, 1), 4),
    trainEmpireFallRate: roundTo(clamp(safeNumber(rawTraining.trainEmpireFallRate, 0), 0, 1), 4),
    validationEmpireFallRate: roundTo(clamp(safeNumber(rawTraining.validationEmpireFallRate, 0), 0, 1), 4),
    holdoutEmpireFallRate: roundTo(clamp(safeNumber(rawTraining.holdoutEmpireFallRate, 0), 0, 1), 4),
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
  const fallbackName = PERSONALITIES[basePersonalityId]?.name
    ? `Trained ${PERSONALITIES[basePersonalityId].name}`
    : (['trained', 'emergent-trained'].includes(String(rawProfile.source || '').trim()) ? 'Emergent AI' : 'Custom AI');
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
