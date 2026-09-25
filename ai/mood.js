// ai/mood.js - what an AI dynasty is in the mood for this round.
//
// A mood sits on two axes, each a real either/or:
//
//   duty      +1 Duty      the empire must hold: defend the frontier
//             -1 Greed     let others defend, keep the troops and the gold
//   ambition  +1 Ambition  bring the sitting Basileus down (for itself or another)
//             -1 Loyalty   uphold the sitting Basileus
//
// The four corners are the moods players see: Guardian (duty, loyalty),
// Hero (duty, ambition), Profiteer (greed, loyalty) and Conspirator (greed,
// ambition). Guardian and Conspirator are opposites, and so are Hero and
// Profiteer.
//
// A temperament (ai/personalities.js) gives the resting point, how far
// events move the mood (volatility) and how freely the AI strays from its
// best move (whim). Events push the mood away from rest: a threat to its own
// land, a Basileus who revoked its estates, others letting the frontier
// down... The pushes come from the game state and the AI's memory, which
// fades with time, so moods change gradually and need no saved state.
import { getFrontierThresholds } from '../engine/combat.js';
import { getEstateHoldingIncome, getProvinceEstateHolders } from '../engine/estates.js';
import { buildFinalScores } from '../engine/scoring.js';
import { getPlayerName } from '../engine/state.js';
import { getRelationship } from './memory.js';

// `crownPhrase` is how the Basileus says it (it is never ambitious).
export const MOODS = Object.freeze({
  guardian: {
    id: 'guardian',
    title: 'Guardian',
    hint: 'Defends the frontier and upholds the Basileus.',
    phrase: 'rallies to the empire and to the throne',
    crownPhrase: 'rules for the empire and leads its defence',
  },
  hero: {
    id: 'hero',
    title: 'Hero',
    hint: 'Defends the frontier for glory, and means to take the throne with it.',
    phrase: 'sets out to win glory at the frontier, and the throne after it',
  },
  profiteer: {
    id: 'profiteer',
    title: 'Profiteer',
    hint: 'Keeps its troops and gold for itself, and leaves the throne alone.',
    phrase: 'withdraws to its estates and lets others fight',
    crownPhrase: 'rules from the palace and leaves the frontier to others',
  },
  conspirator: {
    id: 'conspirator',
    title: 'Conspirator',
    hint: 'Keeps its troops close to Constantinople to bring the Basileus down.',
    phrase: 'sets itself against the throne and keeps its troops close to Constantinople',
  },
});

// AIs without a personality (built-in strategies) keep to their best move.
export const DEFAULT_TEMPERAMENT = Object.freeze({ duty: 0, ambition: 0, volatility: 1, whim: 0 });

// A mood only flips to the other side of an axis once it is this far past
// the middle, so an AI does not change its mind every round.
const MOOD_HYSTERESIS = 0.15;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

// The temperament set on the AI's meta (ai/brain.js, from its personality).
export function getTemperament(meta, playerId) {
  return { ...DEFAULT_TEMPERAMENT, ...(meta?.players?.[playerId]?.temperament || {}) };
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function raisedTroops(state) {
  const income = state?.lastIncome?.round === state?.round ? state.lastIncome : null;
  const troops = sum(Object.values(income?.troops || state?.currentTroops || {}));
  return Math.max(1, troops);
}

// Share of the dynasty's income that the current invasion's route puts at
// risk: its estates and offices there.
function stakeOnRoute(state, playerId) {
  const route = state?.currentInvasion?.route || [];
  let atRisk = 0;
  let total = 0;
  for (const theme of Object.values(state?.themes || {})) {
    if (!theme || theme.id === 'CPL' || theme.lost) continue;
    let own = 0;
    for (const holder of getProvinceEstateHolders(theme)) {
      if (holder.playerId === playerId) own += getEstateHoldingIncome(theme, holder.count, state);
    }
    if (theme.strategos === playerId) own += 1;
    if (theme.bishop === playerId) own += 1;
    total += own;
    if (route.includes(theme.id)) atRisk += own;
  }
  return total > 0 ? atRisk / total : 0;
}

function standing(state, playerId) {
  const scores = buildFinalScores(state).scores || [];
  const own = scores.find((entry) => entry.playerId === playerId);
  const best = scores.reduce((top, entry) => Math.max(top, Number(entry.points) || 0), 0);
  const others = scores.filter((entry) => entry.playerId !== playerId);
  const bestOther = others.reduce((top, entry) => Math.max(top, Number(entry.points) || 0), 0);
  const points = Number(own?.points) || 0;
  return {
    leading: points > 0 && points >= best && points > bestOther,
    gap: points - bestOther,
  };
}

// A small deterministic hash, so the same game always words things the same
// way.
function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// One of a reason's wordings, picked per dynasty and round so a table of
// AIs does not all say the same sentence.
function wordReason(reason, state, playerId) {
  if (!Array.isArray(reason)) return reason || null;
  if (!reason.length) return null;
  return reason[hashText(`${state?.seed ?? ''}:${state?.round ?? 0}:${playerId}`) % reason.length];
}

function holdsTriumph(state, playerId) {
  return (state?.temporaryCapitalSupport || []).some((entry) => (
    entry.kind === 'reconquest' && entry.playerId === playerId && Number(entry.activeRound) >= Number(state.round)
  ));
}

// The pushes on each axis, each with the reason players are told when it
// is the one that changes the AI's mood (a list gives several wordings).
// `target` names the dynasty a push is about, when there is one.
function computePushes(state, memory, playerId) {
  const pushes = [];
  const add = (axis, value, reason, target = null) => {
    if (Math.abs(value) > 1e-6) pushes.push({ axis, value, reason, target });
  };

  const invasion = state?.currentInvasion;
  const troops = raisedTroops(state);
  if (invasion?.route?.length) {
    const strength = Number(invasion.strength?.[0]) || 0;
    const thresholds = getFrontierThresholds(state, strength, invasion.route);
    const invaders = invasion.name || 'the invaders';
    if (thresholds.saveCapital != null && thresholds.saveCapital > 0) {
      add('duty', 0.9 * clamp((thresholds.saveCapital / troops) * 2.2, 0, 1), [
        'Constantinople itself is in danger',
        `the ${invaders} could reach Constantinople`,
        'the capital must not fall',
      ]);
    }
    const holdShare = thresholds.holdAll / troops;
    if (holdShare < 0.3) {
      add('duty', -0.35, [
        'the empire looks safe enough without it',
        `there is little to fear from the ${invaders}`,
        'a few troops will do at the frontier',
      ]);
    }
    add('duty', 0.9 * clamp(stakeOnRoute(state, playerId) * 1.6, 0, 1), [
      `its own land lies in the path of the ${invaders}`,
      `its estates stand in the way of the ${invaders}`,
    ]);
  }

  const table = memory?.table || {};
  add('duty', 0.55 * clamp(table.underDefense, 0, 1), [
    'the others have let the frontier down',
    'no one else will defend the empire',
  ]);
  add('duty', -0.55 * clamp(table.overDefense, 0, 1), [
    'the others will hold the frontier anyway',
    'the others send more than enough to the frontier',
  ]);

  const { leading, gap } = standing(state, playerId);
  if (leading) {
    add('duty', 0.2, 'it has the most to lose if the empire falls');
    add('ambition', -0.25, ['it is ahead and wants no upheaval', 'it leads and wants things to stay as they are']);
  }
  const roundsLeft = Math.max(0, (Number(state?.maxRounds) || 0) - (Number(state?.round) || 0));
  if (!leading && roundsLeft <= 2 && gap < 0) add('ambition', 0.35, ['time is running out and it is behind', 'the end is near and it must catch up']);
  if (!leading && gap < -4) add('duty', -0.25, ['it is falling behind and needs gold', 'it must rebuild its fortune first']);

  const basileusId = state?.basileusId;
  if (Number.isInteger(basileusId) && basileusId !== playerId) {
    const relation = getRelationship(memory, playerId, basileusId);
    // One revoked estate stirs about half a push; more estates, or a
    // grudge on top, fill it. Loyal temperaments swallow a small loss.
    const revoked = Number(relation.revokedMe) || 0;
    const grievance = 0.35 * clamp(revoked, 0, 2.5)
      + 0.12 * clamp((Number(relation.harm) || 0) - revoked, 0, 2.5)
      + 0.25 * clamp(relation.titleJealousy, 0, 2.5);
    const basileus = getPlayerName(state, basileusId);
    if (grievance > 0) {
      const reason = relation.revokedMe > 0.2
        ? [`${basileus} revoked what it held`, `it has not forgiven ${basileus} for its estates`, `${basileus} took its land`]
        : [`${basileus} has wronged it`, `it has a score to settle with ${basileus}`];
      add('ambition', clamp(grievance, 0, 1), reason, basileusId);
    }
    const favour = 0.4 * clamp(relation.favor, 0, 1.6) + 0.4 * clamp(relation.titleFavor, 0, 1.6);
    if (favour > 0) {
      add('ambition', -clamp(favour, 0, 0.9), [`${basileus} has favoured it`, `it owes ${basileus} its offices`], basileusId);
    }
  }
  // Wearing the crown needs no explaining.
  if (basileusId === playerId) add('ambition', -1, null);
  if (holdsTriumph(state, playerId)) add('ambition', 0.45, ['it holds a Triumph to spend', 'its Triumph gives it a claim to the throne']);

  return pushes;
}

function isDutiful(mood) {
  return mood?.id === 'hero' || mood?.id === 'guardian';
}

function isAmbitious(mood) {
  return mood?.id === 'hero' || mood?.id === 'conspirator';
}

export function moodFromAxes(duty, ambition) {
  if (duty >= 0) return ambition >= 0 ? MOODS.hero : MOODS.guardian;
  return ambition >= 0 ? MOODS.conspirator : MOODS.profiteer;
}

// The mood with hysteresis: a value close to the middle of an axis keeps
// the side of `previous`.
function labelMood(duty, ambition, previous) {
  const previousDuty = previous ? (isDutiful(previous) ? 1 : -1) : 0;
  const previousAmbition = previous ? (isAmbitious(previous) ? 1 : -1) : 0;
  const side = (value, before) => {
    if (!before || Math.abs(value) >= MOOD_HYSTERESIS) return value >= 0 ? 1 : -1;
    return before;
  };
  return moodFromAxes(side(duty, previousDuty), side(ambition, previousAmbition));
}

// { duty, ambition, mood, reason, target, temperament } for one AI now.
// `previous` is the mood it last showed, if any.
export function computeAiMood(state, meta, memory, playerId, previous = null) {
  const temperament = getTemperament(meta, playerId);
  const pushes = computePushes(state, memory, playerId);
  const scale = Math.max(0, Number(temperament.volatility) || 0);
  let duty = Number(temperament.duty) || 0;
  let ambition = Number(temperament.ambition) || 0;
  for (const push of pushes) {
    if (push.axis === 'duty') duty += push.value * scale;
    else ambition += push.value * scale;
  }
  // The Basileus upholds its own throne.
  if (state?.basileusId === playerId) ambition = -1;
  duty = clamp(duty, -1, 1);
  ambition = clamp(ambition, -1, 1);
  const mood = labelMood(duty, ambition, previous);

  // The reason given is the strongest push toward the new mood, on the axis
  // that changed since the mood it last showed (or its resting mood).
  const wantsDuty = isDutiful(mood);
  const wantsAmbition = isAmbitious(mood);
  const baseline = previous || restingMood(state, meta, playerId);
  const changed = {
    duty: isDutiful(baseline) !== wantsDuty,
    ambition: isAmbitious(baseline) !== wantsAmbition,
  };
  const anyChanged = changed.duty || changed.ambition;
  const toward = pushes
    .filter((push) => !anyChanged || changed[push.axis])
    .filter((push) => (push.axis === 'duty' ? (push.value > 0) === wantsDuty : (push.value > 0) === wantsAmbition))
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))[0] || null;
  return {
    duty,
    ambition,
    mood,
    onThrone: state?.basileusId === playerId,
    reason: wordReason(toward?.reason, state, playerId),
    target: toward?.target ?? null,
    temperament,
  };
}

// The mood an AI falls back to when nothing pushes it: its temperament's
// corner (the Basileus upholds its own throne).
export function restingMood(state, meta, playerId) {
  const temperament = getTemperament(meta, playerId);
  const ambition = state?.basileusId === playerId ? -1 : Number(temperament.ambition) || 0;
  return moodFromAxes(Number(temperament.duty) || 0, ambition);
}

// Strategy weights as this mood tilts them: duty weighs the frontier more
// and gold less, ambition weighs the throne more and the sitting Basileus
// less. Only the distance from the resting mood tilts them: the trained
// weights already play the personality at rest. The Basileus's loyalty is
// to its own throne, which the throne weights already value, so they stay
// as trained.
export function applyMoodToWeights(weights, moodState) {
  if (!moodState) return weights;
  const rest = moodState.temperament || DEFAULT_TEMPERAMENT;
  const duty = clamp(clamp(moodState.duty, -1, 1) - (Number(rest.duty) || 0), -1, 1);
  const ambition = moodState.onThrone
    ? 0
    : clamp(clamp(moodState.ambition, -1, 1) - (Number(rest.ambition) || 0), -1, 1);
  const scale = (value, factor) => Math.max(0, (Number(value) || 0) * factor);
  return {
    ...weights,
    invasionShortfallPenalty: scale(weights.invasionShortfallPenalty, 1 + 0.5 * duty),
    invasionSafetyValue: scale(weights.invasionSafetyValue, 1 + 0.6 * duty),
    invasionSurplusPenalty: scale(weights.invasionSurplusPenalty, 1 - 0.5 * duty),
    capitalFallPenalty: scale(weights.capitalFallPenalty, 1 + 0.3 * duty),
    recoveryBonus: scale(weights.recoveryBonus, 1 + 0.4 * duty),
    reserveValue: scale(weights.reserveValue, 1 - 0.45 * duty),
    estateProfit: scale(weights.estateProfit, 1 - 0.2 * duty),
    allyDefenseReliance: clamp((Number(weights.allyDefenseReliance) || 1) - 0.15 * duty, 0.5, 1),
    throneBase: scale(weights.throneBase, 1 + 0.7 * ambition),
    selfClaim: scale(weights.selfClaim, 1 + 0.5 * ambition),
    coupOpportunityWeight: scale(weights.coupOpportunityWeight, 1 + 0.6 * ambition),
    supportOtherClaimant: scale(weights.supportOtherClaimant, 1 + 0.6 * ambition),
    regimeUrgencyWeight: scale(weights.regimeUrgencyWeight, 1 + 0.5 * ambition),
    incumbentDefense: scale(weights.incumbentDefense, 1 - 0.5 * ambition),
  };
}

// The mood an AI last showed, from the chronicle.
export function lastShownMood(state, playerId) {
  const history = Array.isArray(state?.history) ? state.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event?.type === 'ai_mood' && event.actorId === playerId) return MOODS[event.details?.mood] || null;
  }
  return null;
}

// "Doukas sets itself against the throne and keeps its troops close to
// Constantinople: Komnenos revoked what it held."
export function describeMoodChange(state, playerId, moodState) {
  const reason = moodState.reason ? `: ${moodState.reason}` : '';
  const phrase = state?.basileusId === playerId && moodState.mood.crownPhrase ? moodState.mood.crownPhrase : moodState.mood.phrase;
  return `${getPlayerName(state, playerId)} ${phrase}${reason}.`;
}
