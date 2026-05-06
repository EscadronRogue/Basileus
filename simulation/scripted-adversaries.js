import { applyCourtAction, applyManualTitleReassignment } from '../engine/commands.js';
import {
  canPayRevocationCost,
  revokeCourtTitle,
  revokeMajorTitle,
  revokeMinorTitle,
  revokeTaxExemption,
  revokeTheme,
  suggestMajorTitleAssignments,
  validateMajorTitleAssignments,
} from '../engine/actions.js';
import { getMercenaryHireCost, getThemeLandPrice, getThemeOwnerIncome } from '../engine/rules.js';
import {
  getPlayer,
  getPlayerMercenaryAssignments,
  getPlayerMercenaryTotal,
  getPlayerThemes,
  MERCENARY_COMPANY_KEY,
} from '../engine/state.js';
import {
  applyPlannedAiTitleAssignment,
  buildAIOrders,
  handlePostResolutionAI,
  invalidateRoundContext,
  isAIPlayer,
  observeCourtAction,
  runAICourtAutomation,
} from '../ai/brain.js';
import { DEFAULT_META_PARAMS, NEUTRAL_PROFILE } from '../ai/personalities.js';
import { normalizeAiProfile } from '../ai/profileStore.js';
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';

const SCRIPTED_DEFAULT_POLICY = Object.freeze({
  coupPolicy: 'antiLeader',
  deploymentPolicy: 'professionalsCapitalLeviesFrontier',
  courtPolicy: 'prioritySpend',
  appointmentPolicy: 'richestOther',
  revocationPolicy: 'never',
  titleReassignmentPolicy: 'richestDistinct',
  schedulePolicy: 'static',
});

const SCRIPTED_ALTERNATE_DEFAULT_POLICY = Object.freeze({
  coupPolicy: 'incumbent',
  deploymentPolicy: 'allFrontier',
  courtPolicy: 'hoard',
  appointmentPolicy: 'weakestOther',
  revocationPolicy: 'randomLegal',
  titleReassignmentPolicy: 'weakestDistinct',
  schedulePolicy: 'static',
});

export const SCRIPTED_POLICY_VALUES = Object.freeze({
  coupPolicy: ['self', 'incumbent', 'strongestNonIncumbent', 'richestNonIncumbent', 'weakestNonIncumbent', 'antiLeader', 'antiIncumbent', 'randomNonSelf'],
  deploymentPolicy: ['allFrontier', 'allCapital', 'professionalsCapitalLeviesFrontier', 'mercenariesCapitalRestFrontier', 'highestTroopOfficeCapitalRestFrontier'],
  courtPolicy: ['buyMax', 'giftMax', 'recruitMax', 'mercMax', 'dismissMax', 'revokeMax', 'hoard', 'prioritySpend'],
  appointmentPolicy: ['selfIfLegalElseRichestOther', 'richestOther', 'weakestOther', 'themeOwnerElseRandomOther', 'randomOther'],
  revocationPolicy: ['never', 'themeOwner', 'majorTitleHolder', 'courtTitleHolder', 'churchPowerHolder', 'richestTarget', 'randomLegal'],
  titleReassignmentPolicy: ['selfFirst', 'richestDistinct', 'weakestDistinct', 'randomDistinct'],
  schedulePolicy: ['static', 'oddEvenSwap', 'winLossSwap', 'everyTwoRoundsSwap', 'seededRandom'],
});

const CONTRAST_POLICY = Object.freeze({
  coupPolicy: {
    self: 'incumbent',
    incumbent: 'antiIncumbent',
    strongestNonIncumbent: 'weakestNonIncumbent',
    richestNonIncumbent: 'weakestNonIncumbent',
    weakestNonIncumbent: 'strongestNonIncumbent',
    antiLeader: 'incumbent',
    antiIncumbent: 'incumbent',
    randomNonSelf: 'self',
  },
  deploymentPolicy: {
    allFrontier: 'allCapital',
    allCapital: 'allFrontier',
    professionalsCapitalLeviesFrontier: 'mercenariesCapitalRestFrontier',
    mercenariesCapitalRestFrontier: 'professionalsCapitalLeviesFrontier',
    highestTroopOfficeCapitalRestFrontier: 'allFrontier',
  },
  courtPolicy: {
    buyMax: 'giftMax',
    giftMax: 'buyMax',
    recruitMax: 'dismissMax',
    mercMax: 'hoard',
    dismissMax: 'recruitMax',
    revokeMax: 'hoard',
    hoard: 'revokeMax',
    prioritySpend: 'hoard',
  },
  appointmentPolicy: {
    selfIfLegalElseRichestOther: 'randomOther',
    richestOther: 'weakestOther',
    weakestOther: 'richestOther',
    themeOwnerElseRandomOther: 'randomOther',
    randomOther: 'selfIfLegalElseRichestOther',
  },
  revocationPolicy: {
    never: 'randomLegal',
    themeOwner: 'majorTitleHolder',
    majorTitleHolder: 'themeOwner',
    courtTitleHolder: 'churchPowerHolder',
    churchPowerHolder: 'courtTitleHolder',
    richestTarget: 'randomLegal',
    randomLegal: 'never',
  },
  titleReassignmentPolicy: {
    selfFirst: 'weakestDistinct',
    richestDistinct: 'weakestDistinct',
    weakestDistinct: 'richestDistinct',
    randomDistinct: 'richestDistinct',
  },
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stableShuffle(values, seedKey) {
  const rng = createRng(hashSeedString(seedKey));
  const copy = values.slice();
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function buildScriptedProfile(family) {
  return normalizeAiProfile({
    id: `scripted-${family.id}`,
    name: family.name,
    shortName: family.name,
    theory: 'Training exploit adversary',
    summary: family.summary,
    source: 'scripted-evaluator',
    basePersonalityId: null,
    weights: { ...NEUTRAL_PROFILE.weights },
    tactics: {
      independence: 1,
      frontierAlarm: 1,
      churchReserve: 1,
      incumbencyGrip: 1,
    },
    meta: { ...DEFAULT_META_PARAMS },
  });
}

function buildContrastingPolicyTuple(policy) {
  return {
    coupPolicy: CONTRAST_POLICY.coupPolicy[policy.coupPolicy] || SCRIPTED_ALTERNATE_DEFAULT_POLICY.coupPolicy,
    deploymentPolicy: CONTRAST_POLICY.deploymentPolicy[policy.deploymentPolicy] || SCRIPTED_ALTERNATE_DEFAULT_POLICY.deploymentPolicy,
    courtPolicy: CONTRAST_POLICY.courtPolicy[policy.courtPolicy] || SCRIPTED_ALTERNATE_DEFAULT_POLICY.courtPolicy,
    appointmentPolicy: CONTRAST_POLICY.appointmentPolicy[policy.appointmentPolicy] || SCRIPTED_ALTERNATE_DEFAULT_POLICY.appointmentPolicy,
    revocationPolicy: CONTRAST_POLICY.revocationPolicy[policy.revocationPolicy] || SCRIPTED_ALTERNATE_DEFAULT_POLICY.revocationPolicy,
    titleReassignmentPolicy: CONTRAST_POLICY.titleReassignmentPolicy[policy.titleReassignmentPolicy] || SCRIPTED_ALTERNATE_DEFAULT_POLICY.titleReassignmentPolicy,
    schedulePolicy: 'static',
  };
}

function createFamilyRecord(definition) {
  const family = {
    ...definition,
    policy: { ...SCRIPTED_DEFAULT_POLICY, ...definition.policy },
  };
  family.alternatePolicy = {
    ...SCRIPTED_DEFAULT_POLICY,
    ...(definition.alternatePolicy || buildContrastingPolicyTuple(family.policy)),
    schedulePolicy: 'static',
  };
  family.profile = buildScriptedProfile(family);
  return family;
}

function buildBaseFamilies() {
  const families = [];
  for (const axis of Object.keys(SCRIPTED_POLICY_VALUES)) {
    for (const value of SCRIPTED_POLICY_VALUES[axis]) {
      families.push(createFamilyRecord({
        id: `base-${axis}-${value}`,
        category: 'base',
        name: `Base ${axis} ${value}`,
        summary: `A training exploit bot that fixes ${axis} to ${value} while keeping the other axes neutral.`,
        policy: { [axis]: value },
      }));
    }
  }
  return families;
}

function buildCompositeFamilies() {
  const families = [];
  for (const coupPolicy of SCRIPTED_POLICY_VALUES.coupPolicy) {
    for (const courtPolicy of SCRIPTED_POLICY_VALUES.courtPolicy) {
      families.push(createFamilyRecord({
        id: `composite-coup-${coupPolicy}-court-${courtPolicy}`,
        category: 'composite',
        name: `Composite ${coupPolicy} ${courtPolicy}`,
        summary: `A training exploit bot that couples ${coupPolicy} coup behavior with ${courtPolicy} court pressure.`,
        policy: { coupPolicy, courtPolicy },
      }));
    }
  }
  for (const deploymentPolicy of SCRIPTED_POLICY_VALUES.deploymentPolicy) {
    for (const appointmentPolicy of SCRIPTED_POLICY_VALUES.appointmentPolicy) {
      families.push(createFamilyRecord({
        id: `composite-deploy-${deploymentPolicy}-appoint-${appointmentPolicy}`,
        category: 'composite',
        name: `Composite ${deploymentPolicy} ${appointmentPolicy}`,
        summary: `A training exploit bot that couples ${deploymentPolicy} troop deployment with ${appointmentPolicy} patronage.`,
        policy: { deploymentPolicy, appointmentPolicy },
      }));
    }
  }
  return families;
}

function buildAlternatorFamilies() {
  return [
    createFamilyRecord({
      id: 'alternator-frontier-turtle-vs-capital-usurper',
      category: 'alternator',
      name: 'Frontier Turtle vs Capital Usurper',
      summary: 'Alternates between hyper-defensive frontier play and capital throne grabs.',
      policy: {
        coupPolicy: 'incumbent',
        deploymentPolicy: 'allFrontier',
        courtPolicy: 'hoard',
        appointmentPolicy: 'richestOther',
        revocationPolicy: 'never',
        titleReassignmentPolicy: 'richestDistinct',
        schedulePolicy: 'oddEvenSwap',
      },
      alternatePolicy: {
        coupPolicy: 'self',
        deploymentPolicy: 'allCapital',
        courtPolicy: 'mercMax',
        appointmentPolicy: 'selfIfLegalElseRichestOther',
        revocationPolicy: 'randomLegal',
        titleReassignmentPolicy: 'selfFirst',
      },
    }),
    createFamilyRecord({
      id: 'alternator-land-rush-vs-church-gifter',
      category: 'alternator',
      name: 'Land Rush vs Church Gifter',
      summary: 'Alternates between land hoarding and offloading estates to the church.',
      policy: {
        coupPolicy: 'richestNonIncumbent',
        deploymentPolicy: 'professionalsCapitalLeviesFrontier',
        courtPolicy: 'buyMax',
        appointmentPolicy: 'richestOther',
        revocationPolicy: 'themeOwner',
        titleReassignmentPolicy: 'richestDistinct',
        schedulePolicy: 'oddEvenSwap',
      },
      alternatePolicy: {
        coupPolicy: 'incumbent',
        deploymentPolicy: 'allFrontier',
        courtPolicy: 'giftMax',
        appointmentPolicy: 'themeOwnerElseRandomOther',
        revocationPolicy: 'churchPowerHolder',
        titleReassignmentPolicy: 'weakestDistinct',
      },
    }),
    createFamilyRecord({
      id: 'alternator-recruit-max-vs-dismiss-max',
      category: 'alternator',
      name: 'Recruit Max vs Dismiss Max',
      summary: 'Alternates between endless professional growth and deleting those troops back down.',
      policy: {
        coupPolicy: 'antiLeader',
        deploymentPolicy: 'professionalsCapitalLeviesFrontier',
        courtPolicy: 'recruitMax',
        appointmentPolicy: 'richestOther',
        revocationPolicy: 'never',
        titleReassignmentPolicy: 'richestDistinct',
        schedulePolicy: 'everyTwoRoundsSwap',
      },
      alternatePolicy: {
        coupPolicy: 'weakestNonIncumbent',
        deploymentPolicy: 'allFrontier',
        courtPolicy: 'dismissMax',
        appointmentPolicy: 'weakestOther',
        revocationPolicy: 'never',
        titleReassignmentPolicy: 'weakestDistinct',
      },
    }),
    createFamilyRecord({
      id: 'alternator-revoker-vs-hoarder',
      category: 'alternator',
      name: 'Revoker vs Hoarder',
      summary: 'Flips between constant court aggression and doing almost nothing when its last coup bet fails.',
      policy: {
        coupPolicy: 'antiIncumbent',
        deploymentPolicy: 'allCapital',
        courtPolicy: 'revokeMax',
        appointmentPolicy: 'richestOther',
        revocationPolicy: 'richestTarget',
        titleReassignmentPolicy: 'selfFirst',
        schedulePolicy: 'winLossSwap',
      },
      alternatePolicy: {
        coupPolicy: 'incumbent',
        deploymentPolicy: 'allFrontier',
        courtPolicy: 'hoard',
        appointmentPolicy: 'randomOther',
        revocationPolicy: 'never',
        titleReassignmentPolicy: 'richestDistinct',
      },
    }),
    createFamilyRecord({
      id: 'alternator-self-crown-vs-other-patron',
      category: 'alternator',
      name: 'Self Crown vs Other Patron',
      summary: 'Alternates between backing itself and pumping titles into everyone else.',
      policy: {
        coupPolicy: 'self',
        deploymentPolicy: 'allCapital',
        courtPolicy: 'prioritySpend',
        appointmentPolicy: 'selfIfLegalElseRichestOther',
        revocationPolicy: 'never',
        titleReassignmentPolicy: 'selfFirst',
        schedulePolicy: 'oddEvenSwap',
      },
      alternatePolicy: {
        coupPolicy: 'randomNonSelf',
        deploymentPolicy: 'professionalsCapitalLeviesFrontier',
        courtPolicy: 'giftMax',
        appointmentPolicy: 'randomOther',
        revocationPolicy: 'themeOwner',
        titleReassignmentPolicy: 'randomDistinct',
      },
    }),
    createFamilyRecord({
      id: 'alternator-richest-kingmaker-vs-weakest-kingmaker',
      category: 'alternator',
      name: 'Richest Kingmaker vs Weakest Kingmaker',
      summary: 'Uses deterministic seeded switching to crown either the richest or weakest rival.',
      policy: {
        coupPolicy: 'richestNonIncumbent',
        deploymentPolicy: 'highestTroopOfficeCapitalRestFrontier',
        courtPolicy: 'mercMax',
        appointmentPolicy: 'richestOther',
        revocationPolicy: 'richestTarget',
        titleReassignmentPolicy: 'richestDistinct',
        schedulePolicy: 'seededRandom',
      },
      alternatePolicy: {
        coupPolicy: 'weakestNonIncumbent',
        deploymentPolicy: 'allFrontier',
        courtPolicy: 'hoard',
        appointmentPolicy: 'weakestOther',
        revocationPolicy: 'randomLegal',
        titleReassignmentPolicy: 'weakestDistinct',
      },
    }),
  ];
}

export const SCRIPTED_ADVERSARY_FAMILIES = Object.freeze([
  ...buildBaseFamilies(),
  ...buildCompositeFamilies(),
  ...buildAlternatorFamilies(),
]);

export const SCRIPTED_ADVERSARY_FAMILY_BY_ID = Object.freeze(
  Object.fromEntries(SCRIPTED_ADVERSARY_FAMILIES.map(family => [family.id, family]))
);

export const SCRIPTED_ADVERSARY_FAMILY_IDS_BY_CATEGORY = Object.freeze(
  Object.fromEntries(
    ['base', 'composite', 'alternator'].map(category => [
      category,
      SCRIPTED_ADVERSARY_FAMILIES.filter(family => family.category === category).map(family => family.id),
    ])
  )
);

export function getScriptedAdversaryFamily(familyId) {
  return SCRIPTED_ADVERSARY_FAMILY_BY_ID[familyId] || null;
}

export function createScriptedSeatConfig(familyId, policySeed) {
  const family = getScriptedAdversaryFamily(familyId);
  if (!family) throw new Error(`Unknown scripted adversary family: ${familyId}`);
  return {
    controller: 'scripted',
    profile: family.profile,
    scriptedFamilyId: family.id,
    scriptedCategory: family.category,
    scriptedSchedule: family.policy.schedulePolicy,
    policySeed: hashSeedString(policySeed ?? family.id),
  };
}

export function hasScriptedControllers(meta) {
  return Object.values(meta?.players || {}).some(player => player?.controller === 'scripted');
}

export function getSeatController(meta, playerId) {
  return meta?.players?.[playerId]?.controller === 'scripted' ? 'scripted' : 'emergent';
}

function getScriptedConfig(meta, playerId) {
  return meta?.players?.[playerId]?.controllerConfig || null;
}

function getPolicySeed(meta, playerId, salt = '') {
  const config = getScriptedConfig(meta, playerId);
  return hashSeedString(`${config?.policySeed ?? playerId}:${salt}`);
}

function getActiveScriptedPolicy(state, meta, playerId) {
  const config = getScriptedConfig(meta, playerId);
  const family = getScriptedAdversaryFamily(config?.scriptedFamilyId);
  if (!family) return SCRIPTED_DEFAULT_POLICY;
  const lastOutcome = meta.players[playerId]?.scriptedState?.lastOutcome || null;
  if (family.policy.schedulePolicy === 'static') return family.policy;
  if (family.policy.schedulePolicy === 'oddEvenSwap') return state.round % 2 === 1 ? family.policy : family.alternatePolicy;
  if (family.policy.schedulePolicy === 'everyTwoRoundsSwap') return Math.floor((Math.max(1, state.round) - 1) / 2) % 2 === 0 ? family.policy : family.alternatePolicy;
  if (family.policy.schedulePolicy === 'winLossSwap') return lastOutcome === 'loss' ? family.alternatePolicy : family.policy;
  if (family.policy.schedulePolicy === 'seededRandom') {
    const rng = createRng(getPolicySeed(meta, playerId, `schedule:${state.round}`));
    return rng() < 0.5 ? family.policy : family.alternatePolicy;
  }
  return family.policy;
}

function getMercCount(assignments, officeKey) {
  return assignments
    .filter(entry => entry.officeKey === officeKey)
    .reduce((total, entry) => total + (entry.count || 0), 0);
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

function getOfficeList(state, playerId, options = {}) {
  const offices = [];
  if (playerId === state.basileusId) {
    offices.push({ key: 'BASILEUS', label: 'Basileus', region: 'cpl' });
  }
  const player = getPlayer(state, playerId);
  for (const titleKey of player.majorTitles) {
    if (titleKey === 'PATRIARCH') {
      offices.push({ key: 'PATRIARCH', label: MAJOR_TITLES.PATRIARCH?.name || 'Patriarch', region: 'cpl', capitalLocked: true });
      continue;
    }
    offices.push({
      key: titleKey,
      label: MAJOR_TITLES[titleKey]?.name || titleKey,
      region: MAJOR_TITLES[titleKey]?.region || null,
    });
  }
  if (state.empress === playerId) offices.push({ key: 'EMPRESS', label: 'Empress', region: 'cpl', capitalLocked: true });
  if (state.chiefEunuchs === playerId) offices.push({ key: 'CHIEF_EUNUCHS', label: 'Chief of Eunuchs', region: 'cpl', capitalLocked: true });
  for (const theme of Object.values(state.themes)) {
    if (!theme.occupied && theme.strategos === playerId) {
      offices.push({ key: `STRAT_${theme.id}`, label: `Strategos of ${theme.name}`, region: theme.region, themeId: theme.id });
    }
  }
  if (options.includeMercenaryCompany && getPlayerMercenaryTotal(state, playerId) > 0) {
    offices.push({ key: MERCENARY_COMPANY_KEY, label: 'Mercenary Company', region: null });
  }
  return offices;
}

function buildStandingRow(state, playerId) {
  const player = getPlayer(state, playerId);
  const themes = getPlayerThemes(state, playerId);
  const finalScore = (player.gold || 0) + themes.length * 2 + player.majorTitles.length * 2 + getMinorTitleCount(state, playerId);
  const troopCount = Object.values(player.professionalArmies || {}).reduce((total, value) => total + value, 0) + getPlayerMercenaryTotal(state, playerId);
  const strength = troopCount + (player.majorTitles.length * 2) + getMinorTitleCount(state, playerId) + themes.length;
  return {
    playerId,
    gold: player.gold || 0,
    themes: themes.length,
    finalScore,
    strength,
  };
}

function getStandingRows(state, playerIds = state.players.map(player => player.id)) {
  return playerIds.map(playerId => buildStandingRow(state, playerId));
}

function stableOrderRows(rows, seedKey, accessor, descending = true) {
  const withShuffle = stableShuffle(rows, seedKey);
  return withShuffle.sort((left, right) => {
    const leftValue = accessor(left);
    const rightValue = accessor(right);
    return descending ? rightValue - leftValue : leftValue - rightValue;
  });
}

function pickRankedPlayerId(rows, seedKey, accessor, descending, excludedIds = new Set()) {
  return stableOrderRows(rows.filter(row => !excludedIds.has(row.playerId)), seedKey, accessor, descending)[0]?.playerId ?? null;
}

function pickSeededRandomPlayerId(playerIds, seedKey, excludedIds = new Set()) {
  const filtered = playerIds.filter(playerId => !excludedIds.has(playerId));
  return stableShuffle(filtered, seedKey)[0] ?? null;
}

function pickCoupCandidate(state, meta, playerId, policy) {
  const allRows = getStandingRows(state);
  const nonIncumbentRows = allRows.filter(row => row.playerId !== state.basileusId);
  const nonSelfRows = allRows.filter(row => row.playerId !== playerId);
  if (policy.coupPolicy === 'self') return playerId;
  if (policy.coupPolicy === 'incumbent') return state.basileusId;
  if (policy.coupPolicy === 'strongestNonIncumbent') {
    return pickRankedPlayerId(nonIncumbentRows, `${playerId}:strongestNonIncumbent:${state.round}`, row => row.strength, true, new Set([playerId])) ?? state.basileusId;
  }
  if (policy.coupPolicy === 'richestNonIncumbent') {
    return pickRankedPlayerId(nonIncumbentRows, `${playerId}:richestNonIncumbent:${state.round}`, row => row.gold, true, new Set([playerId])) ?? state.basileusId;
  }
  if (policy.coupPolicy === 'weakestNonIncumbent') {
    return pickRankedPlayerId(nonIncumbentRows, `${playerId}:weakestNonIncumbent:${state.round}`, row => row.gold, false, new Set([playerId])) ?? state.basileusId;
  }
  if (policy.coupPolicy === 'antiLeader') {
    return pickRankedPlayerId(nonSelfRows, `${playerId}:antiLeader:${state.round}`, row => row.finalScore, true) ?? state.basileusId;
  }
  if (policy.coupPolicy === 'antiIncumbent') {
    return pickRankedPlayerId(nonIncumbentRows, `${playerId}:antiIncumbent:${state.round}`, row => row.finalScore, true) ?? state.basileusId;
  }
  if (policy.coupPolicy === 'randomNonSelf') {
    return pickSeededRandomPlayerId(state.players.map(player => player.id), `${playerId}:randomNonSelf:${state.round}`, new Set([playerId])) ?? state.basileusId;
  }
  return state.basileusId;
}

function getOfficeTotalTroops(state, playerId, office) {
  const player = getPlayer(state, playerId);
  const mercenaries = getPlayerMercenaryAssignments(state, playerId);
  const professional = office.key === MERCENARY_COMPANY_KEY ? 0 : (player.professionalArmies?.[office.key] || 0);
  const levies = office.key === MERCENARY_COMPANY_KEY ? 0 : (state.currentLevies?.[office.key] || 0);
  const mercenaryTroops = getMercCount(mercenaries, office.key);
  return professional + levies + mercenaryTroops;
}

function buildScriptedDeployments(state, meta, playerId, policy) {
  const deployments = {};
  const offices = getOfficeList(state, playerId, { includeMercenaryCompany: getPlayerMercenaryTotal(state, playerId) > 0 });
  const mercAssignments = getPlayerMercenaryAssignments(state, playerId);
  const highestTroopOffice = stableOrderRows(
    offices.map(office => ({ office, totalTroops: getOfficeTotalTroops(state, playerId, office) })),
    `${playerId}:highestTroopOffice:${state.round}`,
    entry => entry.totalTroops,
    true
  )[0]?.office?.key || null;
  const mercenaryOfficeKeys = new Set(mercAssignments.map(entry => entry.officeKey));
  for (const office of offices) {
    if (office.capitalLocked) {
      deployments[office.key] = 'capital';
      continue;
    }
    if (policy.deploymentPolicy === 'allFrontier') {
      deployments[office.key] = 'frontier';
      continue;
    }
    if (policy.deploymentPolicy === 'allCapital') {
      deployments[office.key] = 'capital';
      continue;
    }
    if (policy.deploymentPolicy === 'professionalsCapitalLeviesFrontier') {
      deployments[office.key] = (getPlayer(state, playerId).professionalArmies?.[office.key] || 0) > 0 ? 'capital' : 'frontier';
      continue;
    }
    if (policy.deploymentPolicy === 'mercenariesCapitalRestFrontier') {
      deployments[office.key] = mercenaryOfficeKeys.has(office.key) ? 'capital' : 'frontier';
      continue;
    }
    if (policy.deploymentPolicy === 'highestTroopOfficeCapitalRestFrontier') {
      deployments[office.key] = office.key === highestTroopOffice ? 'capital' : 'frontier';
      continue;
    }
    deployments[office.key] = 'frontier';
  }
  return deployments;
}

function getCandidateAppointeeOrder(state, meta, actorId, policy, options = {}) {
  const theme = options.theme || null;
  const playerIds = state.players.map(player => player.id);
  const otherIds = playerIds.filter(playerId => playerId !== actorId);
  const rows = getStandingRows(state, otherIds);
  if (policy.appointmentPolicy === 'selfIfLegalElseRichestOther') {
    return [actorId, ...stableOrderRows(rows, `${actorId}:appointRichest:${state.round}`, row => row.gold, true).map(row => row.playerId)];
  }
  if (policy.appointmentPolicy === 'richestOther') {
    return stableOrderRows(rows, `${actorId}:appointRichest:${state.round}`, row => row.gold, true).map(row => row.playerId);
  }
  if (policy.appointmentPolicy === 'weakestOther') {
    return stableOrderRows(rows, `${actorId}:appointWeakest:${state.round}`, row => row.gold, false).map(row => row.playerId);
  }
  if (policy.appointmentPolicy === 'themeOwnerElseRandomOther') {
    const ownerId = theme?.owner != null && theme.owner !== 'church' ? Number(theme.owner) : null;
    const randomOthers = stableShuffle(otherIds, `${actorId}:appointThemeOwner:${theme?.id || 'court'}:${state.round}`);
    return ownerId != null && ownerId !== actorId
      ? [ownerId, ...randomOthers.filter(playerId => playerId !== ownerId)]
      : randomOthers;
  }
  if (policy.appointmentPolicy === 'randomOther') {
    return stableShuffle(otherIds, `${actorId}:appointRandom:${theme?.id || 'court'}:${state.round}`);
  }
  return otherIds;
}

function buildBasileusAppointmentPayloads(state, meta, actorId, policy) {
  const payloads = [];
  const slotOptions = [];
  if (state.empress == null) slotOptions.push({ titleType: 'EMPRESS' });
  if (state.chiefEunuchs == null) slotOptions.push({ titleType: 'CHIEF_EUNUCHS' });
  for (const theme of Object.values(state.themes)) {
    if (theme.occupied || theme.id === 'CPL' || theme.owner === 'church') continue;
    if (theme.strategos == null) slotOptions.push({ titleType: 'STRATEGOS', themeId: theme.id, theme });
    if (!theme.bishopIsDonor && theme.bishop == null) slotOptions.push({ titleType: 'BISHOP', themeId: theme.id, theme });
  }
  for (const slot of slotOptions) {
    for (const appointeeId of getCandidateAppointeeOrder(state, meta, actorId, policy, { theme: slot.theme || null })) {
      payloads.push({
        action: 'basileus-appoint',
        titleType: slot.titleType,
        appointeeId,
        themeId: slot.themeId || null,
      });
    }
  }
  return payloads;
}

function buildRegionalAppointmentPayloads(state, meta, actorId, policy, titleKey) {
  const payloads = [];
  const region = { DOM_EAST: 'east', DOM_WEST: 'west', ADMIRAL: 'sea' }[titleKey];
  for (const theme of Object.values(state.themes)) {
    if (theme.occupied || theme.id === 'CPL' || theme.owner === 'church' || theme.region !== region || theme.strategos != null) continue;
    for (const appointeeId of getCandidateAppointeeOrder(state, meta, actorId, policy, { theme })) {
      payloads.push({
        action: 'appoint-strategos',
        titleKey,
        themeId: theme.id,
        appointeeId,
      });
    }
  }
  return payloads;
}

function buildPatriarchAppointmentPayloads(state, meta, actorId, policy) {
  const payloads = [];
  for (const theme of Object.values(state.themes)) {
    if (theme.occupied || theme.id === 'CPL' || theme.bishopIsDonor || theme.bishop != null) continue;
    for (const appointeeId of getCandidateAppointeeOrder(state, meta, actorId, policy, { theme })) {
      payloads.push({
        action: 'appoint-bishop',
        themeId: theme.id,
        appointeeId,
      });
    }
  }
  return payloads;
}

function getOwnedThemeOrder(state, playerId, seedKey, compareFn) {
  return stableShuffle(getPlayerThemes(state, playerId), seedKey).sort(compareFn);
}

function getFreeThemeOrder(state, seedKey, compareFn) {
  return stableShuffle(
    Object.values(state.themes).filter(theme => !theme.occupied && theme.id !== 'CPL' && (theme.owner == null || theme.owner === 'church')),
    seedKey
  ).sort(compareFn);
}

function getOfficeOrder(state, playerId, seedKey, compareFn) {
  return stableShuffle(getOfficeList(state, playerId), seedKey).sort(compareFn);
}

function getMaxAffordableMercenaries(state, playerId) {
  const player = getPlayer(state, playerId);
  const hiredSoFar = getPlayerMercenaryTotal(state, playerId);
  let count = 0;
  while (count < 8) {
    const nextCount = count + 1;
    const cost = getMercenaryHireCost(hiredSoFar, nextCount);
    if (player.gold < cost) break;
    count = nextCount;
  }
  return count;
}

function buildRevocationCandidates(state, meta, basileusId, policy) {
  const candidates = [];
  const playerRows = getStandingRows(state).filter(row => row.playerId !== basileusId);
  const richestOtherId = pickRankedPlayerId(playerRows, `${basileusId}:revokeRichest:${state.round}`, row => row.gold, true) ?? null;
  for (const player of state.players) {
    if (player.id === basileusId) continue;
    for (const titleKey of player.majorTitles) {
      const eligibleRecipients = state.players
        .filter(candidate => candidate.id !== basileusId && candidate.id !== player.id)
        .map(candidate => candidate.id);
      const orderedRecipients = getCandidateAppointeeOrder(state, meta, basileusId, policy, {})
        .filter(candidateId => eligibleRecipients.includes(candidateId));
      if (!orderedRecipients.length) continue;
      candidates.push({
        kind: 'major',
        targetPlayerId: player.id,
        value: `major:${player.id}:${titleKey}`,
        titleKey,
        newHolderId: orderedRecipients[0],
      });
    }
  }
  for (const theme of Object.values(state.themes)) {
    if (theme.occupied || theme.id === 'CPL') continue;
    if (theme.owner != null && theme.owner !== 'church') {
      candidates.push({ kind: 'theme', targetPlayerId: Number(theme.owner), value: `theme:${theme.id}`, themeId: theme.id });
    }
    if (theme.taxExempt) {
      candidates.push({ kind: 'exempt', targetPlayerId: theme.owner != null && theme.owner !== 'church' ? Number(theme.owner) : null, value: `exempt:${theme.id}`, themeId: theme.id });
    }
    if (theme.strategos != null) {
      candidates.push({ kind: 'minor', targetPlayerId: Number(theme.strategos), value: `minor:${theme.id}:strategos`, themeId: theme.id });
    }
    if (theme.bishop != null) {
      candidates.push({ kind: 'minor', targetPlayerId: Number(theme.bishop), value: `minor:${theme.id}:bishop`, themeId: theme.id });
    }
  }
  if (state.empress != null) {
    candidates.push({ kind: 'court', targetPlayerId: Number(state.empress), value: 'court:EMPRESS' });
  }
  if (state.chiefEunuchs != null) {
    candidates.push({ kind: 'court', targetPlayerId: Number(state.chiefEunuchs), value: 'court:CHIEF_EUNUCHS' });
  }

  const sorted = stableShuffle(candidates, `${basileusId}:revocations:${state.round}`);
  if (policy.revocationPolicy === 'themeOwner') {
    return sorted.filter(candidate => candidate.kind === 'theme' || candidate.kind === 'exempt');
  }
  if (policy.revocationPolicy === 'majorTitleHolder') {
    return sorted.filter(candidate => candidate.kind === 'major');
  }
  if (policy.revocationPolicy === 'courtTitleHolder') {
    return sorted.filter(candidate => candidate.kind === 'court');
  }
  if (policy.revocationPolicy === 'churchPowerHolder') {
    const churchCandidates = sorted.filter(candidate => candidate.kind === 'minor' || (candidate.kind === 'major' && candidate.titleKey === 'PATRIARCH'));
    return churchCandidates.length ? churchCandidates : sorted.filter(candidate => candidate.kind === 'minor');
  }
  if (policy.revocationPolicy === 'richestTarget' && richestOtherId != null) {
    return sorted.filter(candidate => candidate.targetPlayerId === richestOtherId);
  }
  if (policy.revocationPolicy === 'randomLegal') {
    return sorted;
  }
  return [];
}

function buildStrategicCourtPayloads(state, meta, playerId, policy) {
  if (policy.courtPolicy === 'hoard') return [];

  const buyPayloads = getFreeThemeOrder(
    state,
    `${playerId}:buy:${state.round}`,
    (left, right) => getThemeLandPrice(left) - getThemeLandPrice(right) || getThemeOwnerIncome(right) - getThemeOwnerIncome(left) || left.id.localeCompare(right.id)
  ).map(theme => ({ action: 'buy', themeId: theme.id }));

  const giftPayloads = getOwnedThemeOrder(
    state,
    playerId,
    `${playerId}:gift:${state.round}`,
    (left, right) => getThemeOwnerIncome(left) - getThemeOwnerIncome(right) || left.id.localeCompare(right.id)
  ).map(theme => ({ action: 'gift', themeId: theme.id }));

  const recruitPayloads = getOfficeOrder(
    state,
    playerId,
    `${playerId}:recruit:${state.round}`,
    (left, right) => left.key.localeCompare(right.key)
  ).map(office => ({ action: 'recruit', office: office.key }));

  const mercCount = getMaxAffordableMercenaries(state, playerId);
  const mercPayloads = mercCount > 0 ? [{ action: 'hire-mercenaries', count: mercCount }] : [];

  const dismissPayloads = stableShuffle(
    getOfficeList(state, playerId).map(office => ({
      office,
      count: getPlayer(state, playerId).professionalArmies?.[office.key] || 0,
    })).filter(entry => entry.count > 0),
    `${playerId}:dismiss:${state.round}`
  )
    .sort((left, right) => right.count - left.count || left.office.key.localeCompare(right.office.key))
    .map(entry => ({ action: 'dismiss', office: entry.office.key, count: entry.count }));

  const revocationPayloads = playerId === state.basileusId && canPayRevocationCost(state).ok
    ? buildRevocationCandidates(state, meta, playerId, policy).map(candidate => ({
      action: 'revoke-scripted',
      revokeKind: candidate.kind,
      revokeValue: candidate.value,
      targetPlayerId: candidate.targetPlayerId ?? null,
      titleKey: candidate.titleKey || null,
      themeId: candidate.themeId || null,
      newHolderId: candidate.newHolderId || null,
    }))
    : [];

  if (policy.courtPolicy === 'buyMax') return buyPayloads;
  if (policy.courtPolicy === 'giftMax') return giftPayloads;
  if (policy.courtPolicy === 'recruitMax') return recruitPayloads;
  if (policy.courtPolicy === 'mercMax') return mercPayloads;
  if (policy.courtPolicy === 'dismissMax') return dismissPayloads;
  if (policy.courtPolicy === 'revokeMax') return revocationPayloads;
  if (policy.courtPolicy === 'prioritySpend') {
    return [
      ...recruitPayloads,
      ...buyPayloads,
      ...mercPayloads,
      ...giftPayloads,
      ...revocationPayloads,
      ...dismissPayloads,
    ];
  }
  return [];
}

function buildScriptedObservation(playerId, payload, result) {
  if (payload.action === 'buy') return { type: 'buy_theme', actorId: playerId, themeId: payload.themeId };
  if (payload.action === 'gift') return { type: 'gift', actorId: playerId, themeId: payload.themeId };
  if (payload.action === 'recruit') return { type: 'recruit', actorId: playerId, officeKey: payload.office };
  if (payload.action === 'dismiss') return { type: 'dismiss', actorId: playerId, officeKey: payload.office, count: payload.count };
  if (payload.action === 'hire-mercenaries') {
    return {
      type: 'mercenaries',
      actorId: playerId,
      officeKey: MERCENARY_COMPANY_KEY,
      count: payload.count,
      totalMercenaryTroops: result?.totalMercenaryTroops || 0,
    };
  }
  if (payload.action === 'revoke-scripted') {
    return {
      type: 'revocation',
      actorId: playerId,
      targetPlayerId: payload.targetPlayerId ?? null,
      newHolderId: payload.newHolderId ?? null,
    };
  }
  return result?.observation || null;
}

function applyScriptedRevocation(state, payload) {
  if (payload.revokeKind === 'major') {
    return revokeMajorTitle(state, payload.targetPlayerId, payload.titleKey, payload.newHolderId);
  }
  if (payload.revokeKind === 'minor') {
    const parts = String(payload.revokeValue).split(':');
    return revokeMinorTitle(state, parts[1], parts[2]);
  }
  if (payload.revokeKind === 'court') {
    const parts = String(payload.revokeValue).split(':');
    return revokeCourtTitle(state, parts[1]);
  }
  if (payload.revokeKind === 'exempt') {
    const parts = String(payload.revokeValue).split(':');
    return revokeTaxExemption(state, parts[1]);
  }
  if (payload.revokeKind === 'theme') {
    const parts = String(payload.revokeValue).split(':');
    return revokeTheme(state, parts[1]);
  }
  return { ok: false, reason: 'Unknown scripted revocation payload.' };
}

function applyScriptedCourtPayload(state, meta, playerId, payload) {
  let result = null;
  if (payload.action === 'revoke-scripted') result = applyScriptedRevocation(state, payload);
  else result = applyCourtAction(state, playerId, payload);
  if (!result?.ok) return false;

  if (payload.action === 'buy') {
    meta.players[playerId].stats.landBuys++;
    meta.totals.landBuys++;
  } else if (payload.action === 'gift') {
    meta.players[playerId].stats.themesGifted++;
    meta.totals.gifts++;
  } else if (payload.action === 'recruit') {
    meta.players[playerId].stats.recruits++;
    meta.totals.recruits++;
  } else if (payload.action === 'revoke-scripted') {
    meta.players[playerId].stats.revocations++;
    meta.totals.revocations++;
  } else if (payload.action === 'hire-mercenaries') {
    meta.players[playerId].stats.mercsHired += payload.count;
    meta.players[playerId].stats.mercSpend += result.cost || 0;
    meta.totals.mercSpend += result.cost || 0;
    result.totalMercenaryTroops = getPlayerMercenaryTotal(state, playerId);
  }

  const observation = buildScriptedObservation(playerId, payload, result);
  if (observation) observeCourtAction(state, meta, observation);
  else invalidateRoundContext(meta);
  return true;
}

function takeOneScriptedCourtAction(state, meta, playerId) {
  const policy = getActiveScriptedPolicy(state, meta, playerId);
  const player = getPlayer(state, playerId);
  if (!player) return false;

  let payloads = [];
  if (playerId === state.basileusId && !state.courtActions.basileusAppointed) {
    payloads = buildBasileusAppointmentPayloads(state, meta, playerId, policy);
  } else if (player.majorTitles.includes('DOM_EAST') && !state.courtActions.domesticEastAppointed) {
    payloads = buildRegionalAppointmentPayloads(state, meta, playerId, policy, 'DOM_EAST');
  } else if (player.majorTitles.includes('DOM_WEST') && !state.courtActions.domesticWestAppointed) {
    payloads = buildRegionalAppointmentPayloads(state, meta, playerId, policy, 'DOM_WEST');
  } else if (player.majorTitles.includes('ADMIRAL') && !state.courtActions.admiralAppointed) {
    payloads = buildRegionalAppointmentPayloads(state, meta, playerId, policy, 'ADMIRAL');
  } else if (player.majorTitles.includes('PATRIARCH') && !state.courtActions.patriarchAppointed) {
    payloads = buildPatriarchAppointmentPayloads(state, meta, playerId, policy);
  } else {
    payloads = buildStrategicCourtPayloads(state, meta, playerId, policy);
  }

  for (const payload of payloads) {
    if (applyScriptedCourtPayload(state, meta, playerId, payload)) return true;
  }
  return false;
}

function finalizeControllerCourt(state, playerIds) {
  if (state.courtActions) {
    state.courtActions.basileusAppointed = true;
    state.courtActions.domesticEastAppointed = true;
    state.courtActions.domesticWestAppointed = true;
    state.courtActions.admiralAppointed = true;
    state.courtActions.patriarchAppointed = true;
  }
  for (const playerId of playerIds) {
    state.courtActions?.playerConfirmed?.add(playerId);
  }
}

export function runControllerCourtAutomation(state, meta, options = {}) {
  const mode = options.mode || 'finish';
  const aiOrder = stableShuffle(
    state.players.filter(player => isAIPlayer(meta, player.id)).map(player => player.id),
    `${state.round}:${state.phase}:${state.basileusId}`
  );
  let actionsTaken = 0;

  const takeOneAction = (playerId) => {
    try {
      if (getSeatController(meta, playerId) === 'scripted') return takeOneScriptedCourtAction(state, meta, playerId);
      return (runAICourtAutomation(state, meta, { mode: 'react', playerIds: [playerId] }).actionsTaken || 0) > 0;
    } catch {
      invalidateRoundContext(meta);
      return false;
    }
  };

  if (mode === 'react') {
    for (const playerId of aiOrder) {
      if (takeOneAction(playerId)) actionsTaken++;
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
      if (takeOneAction(playerId)) {
        actionsTaken++;
        progress = true;
      }
    }
  }
  finalizeControllerCourt(state, aiOrder);
  return { actionsTaken };
}

function buildScriptedOrders(state, meta, playerId) {
  const policy = getActiveScriptedPolicy(state, meta, playerId);
  const candidateId = pickCoupCandidate(state, meta, playerId, policy);
  const deployments = buildScriptedDeployments(state, meta, playerId, policy);
  const mercenaries = getPlayerMercenaryAssignments(state, playerId);
  const offices = getOfficeList(state, playerId, { includeMercenaryCompany: getPlayerMercenaryTotal(state, playerId) > 0 });
  let frontierTroops = 0;
  let capitalTroops = 0;
  for (const office of offices) {
    const totalTroops = getOfficeTotalTroops(state, playerId, office);
    if ((deployments[office.key] || 'frontier') === 'capital') capitalTroops += totalTroops;
    else frontierTroops += totalTroops;
  }

  meta.players[playerId].stats.frontierTroops += frontierTroops;
  meta.players[playerId].stats.capitalTroops += capitalTroops;
  meta.players[playerId].stats.coupVotes++;
  if (candidateId === state.basileusId) meta.players[playerId].stats.supportIncumbentVotes++;
  if (candidateId === playerId) meta.players[playerId].stats.supportSelfVotes++;
  meta.players[playerId].scriptedState.lastSupportedCandidate = candidateId;

  return {
    deployments,
    candidate: candidateId,
    debug: {
      controller: 'scripted',
      familyId: getScriptedConfig(meta, playerId)?.scriptedFamilyId || null,
      policy,
      officePlans: offices.map(office => ({
        officeKey: office.key,
        destination: deployments[office.key] || 'frontier',
        troopCount: getOfficeTotalTroops(state, playerId, office),
        mercenaries: getMercCount(mercenaries, office.key),
      })),
    },
  };
}

export function buildControllerOrders(state, meta, playerId) {
  if (getSeatController(meta, playerId) === 'scripted') return buildScriptedOrders(state, meta, playerId);
  return buildAIOrders(state, meta, playerId);
}

function buildTitlePreferenceOrder(state, meta, basileusId, policy) {
  const supporterIds = stableShuffle(
    state.players
      .filter(player => player.id !== basileusId && state.allOrders?.[player.id]?.candidate === basileusId)
      .map(player => player.id),
    `${basileusId}:supporters:${state.round}`
  );
  const otherRows = getStandingRows(state, state.players.filter(player => player.id !== basileusId).map(player => player.id));
  if (policy.titleReassignmentPolicy === 'selfFirst') {
    const richestRest = stableOrderRows(otherRows, `${basileusId}:titleSelfFirst:${state.round}`, row => row.gold, true)
      .map(row => row.playerId)
      .filter(playerId => !supporterIds.includes(playerId));
    return [...supporterIds, ...richestRest];
  }
  if (policy.titleReassignmentPolicy === 'richestDistinct') {
    return stableOrderRows(otherRows, `${basileusId}:titleRichest:${state.round}`, row => row.gold, true).map(row => row.playerId);
  }
  if (policy.titleReassignmentPolicy === 'weakestDistinct') {
    return stableOrderRows(otherRows, `${basileusId}:titleWeakest:${state.round}`, row => row.gold, false).map(row => row.playerId);
  }
  if (policy.titleReassignmentPolicy === 'randomDistinct') {
    return stableShuffle(otherRows.map(row => row.playerId), `${basileusId}:titleRandom:${state.round}`);
  }
  return stableOrderRows(otherRows, `${basileusId}:titleFallback:${state.round}`, row => row.gold, true).map(row => row.playerId);
}

function planScriptedTitleAssignment(state, meta, basileusId) {
  const policy = getActiveScriptedPolicy(state, meta, basileusId);
  const titleKeys = Object.keys(MAJOR_TITLES);
  const preferredOrder = buildTitlePreferenceOrder(state, meta, basileusId, policy);
  const quotas = new Map(preferredOrder.map((playerId, index) => [playerId, [...MAJOR_TITLE_DISTRIBUTION[state.players.length]].sort((left, right) => right - left)[index] || 0]));
  const assignedCounts = new Map(preferredOrder.map(playerId => [playerId, 0]));
  const assignments = {};

  for (const titleKey of titleKeys) {
    const nextHolder = preferredOrder.find(playerId => (assignedCounts.get(playerId) || 0) < (quotas.get(playerId) || 0));
    if (nextHolder == null) continue;
    assignments[titleKey] = nextHolder;
    assignedCounts.set(nextHolder, (assignedCounts.get(nextHolder) || 0) + 1);
  }

  const validation = validateMajorTitleAssignments(state, basileusId, assignments);
  return validation?.ok ? assignments : suggestMajorTitleAssignments(state, basileusId);
}

function updateScriptedRoundOutcomes(state, meta) {
  const winningCandidate = state.lastCoupResult?.winner ?? state.basileusId;
  for (const player of state.players) {
    if (getSeatController(meta, player.id) !== 'scripted') continue;
    const supportedCandidate = meta.players[player.id]?.scriptedState?.lastSupportedCandidate;
    meta.players[player.id].scriptedState.lastOutcome = supportedCandidate === winningCandidate ? 'win' : 'loss';
  }
}

export function applyPlannedControllerTitleAssignment(state, meta, pendingAssignment = null) {
  if (!pendingAssignment) return null;
  if (pendingAssignment.type === 'scripted') {
    applyManualTitleReassignment(state, meta, pendingAssignment.winnerId, pendingAssignment.assignments);
    return null;
  }
  applyPlannedAiTitleAssignment(state, meta, pendingAssignment, state.nextBasileusId);
  return null;
}

export function handleControllerPostResolution(state, meta, options = {}) {
  const previousBasileusId = options.previousBasileusId ?? state.basileusId;
  const aftermath = handlePostResolutionAI(state, meta, {
    ...options,
    autoApplyTitleAssignments: false,
    previousBasileusId,
  });
  updateScriptedRoundOutcomes(state, meta);

  const winnerId = state.lastCoupResult?.winner ?? state.basileusId;
  if (winnerId === previousBasileusId) return { plannedAssignment: null };
  if (getSeatController(meta, winnerId) === 'scripted') {
    const assignments = planScriptedTitleAssignment(state, meta, winnerId);
    if (options.autoApplyTitleAssignments !== false) {
      applyManualTitleReassignment(state, meta, winnerId, assignments);
      return { plannedAssignment: null };
    }
    return {
      plannedAssignment: {
        type: 'scripted',
        winnerId,
        assignments,
      },
    };
  }

  if (options.autoApplyTitleAssignments !== false && aftermath.plannedAssignment) {
    applyPlannedAiTitleAssignment(state, meta, aftermath.plannedAssignment, winnerId);
    return { plannedAssignment: null };
  }
  return aftermath;
}

export const __testing = {
  getActiveScriptedPolicy,
  pickCoupCandidate,
  buildScriptedDeployments,
  buildStrategicCourtPayloads,
  getCandidateAppointeeOrder,
  planScriptedTitleAssignment,
};
