// engine/coup.js - who a dynasty backs in the coup.
//
// Each dynasty chooses up to two claimants, itself allowed. Its troops in
// Constantinople, and the Patriarch's influence if it is the Patriarch, give
// their full support to the first choice and COUP_CHOICE_WEIGHTS[1] of it to
// the second. With no choice at all, its troops in Constantinople back nobody.
import { BALANCE } from '../data/balance.js';

export const MAX_COUP_CHOICES = 2;

function validPlayerIds(state) {
  return (state?.players || []).map((player) => player.id);
}

export function getCoupChoiceWeight(choiceIndex) {
  const weights = Array.isArray(BALANCE.COUP_CHOICE_WEIGHTS) ? BALANCE.COUP_CHOICE_WEIGHTS : [1, 0.5];
  return Math.max(0, Number(weights[choiceIndex]) || 0);
}

// Up to two distinct claimants, first choice first. Accepts the raw order
// value or an order object with `coupChoices`.
export function normalizeCoupChoices(state, rawChoices = null) {
  const valid = new Set(validPlayerIds(state));
  const source = Array.isArray(rawChoices) ? rawChoices : Array.isArray(rawChoices?.coupChoices) ? rawChoices.coupChoices : [];
  const choices = [];
  for (const value of source) {
    const id = Number(value);
    if (value == null || value === '' || !Number.isInteger(id) || !valid.has(id) || choices.includes(id)) continue;
    choices.push(id);
    if (choices.length >= MAX_COUP_CHOICES) break;
  }
  return choices;
}

// A dynasty that says nothing backs itself.
export function buildDefaultCoupChoices(state, playerId) {
  return normalizeCoupChoices(state, [playerId]);
}

// [{ candidateId, choiceIndex, weight }] for a set of choices.
export function getCoupChoiceShares(choices = []) {
  return choices.map((candidateId, choiceIndex) => ({
    candidateId,
    choiceIndex,
    weight: getCoupChoiceWeight(choiceIndex),
  }));
}

// Places a claimant a deal requires among the choices: kept where it is, or
// made the second choice (the first stays the dynasty's own).
export function placeRequiredCoupChoice(state, playerId, rawChoices, requiredCandidateId) {
  const required = Number(requiredCandidateId);
  const choices = normalizeCoupChoices(state, rawChoices);
  if (!Number.isInteger(required) || !validPlayerIds(state).includes(required) || choices.includes(required)) return choices;
  const first = choices[0] ?? playerId;
  if (first === required) return [required];
  return normalizeCoupChoices(state, [first, required]);
}

// The claimant a dynasty mainly backs other than itself, for AI memory and
// history: its first choice, or its second when it put itself first.
export function getPreferredCoupCandidate(state, playerId, orders = {}) {
  const choices = normalizeCoupChoices(state, orders?.coupChoices ?? orders);
  return choices.find((candidateId) => candidateId !== playerId) ?? choices[0] ?? null;
}
