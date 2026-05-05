// engine/turnCounters.js — Centralized per-turn counters for appointments and
// revocations. Both follow the same shape: each "actor" tracks `self`, `others`,
// and `otherPerPlayer` for a particular bucket. The cost helpers project the
// new rules consistently across self/other actions, so callers never duplicate
// arithmetic.
//
// Self appointment cost  : max(1, self + 1 - others)
// Other appointment cost : otherPerPlayer[targetId]   (0,1,2,...)
// Self revocation cost   : 0  (free, accumulates a discount toward others)
// Other revocation cost  : max(1, others + 1 - self)
//
// "Other" appointments and "self" revocations both make the next "self
// appointment / other revocation" cheaper by 1, never below the minimum.
//
// Counters live on the player so that when a title is reassigned the player's
// own counters follow them — see `transferAppointmentCounters` below.

import { getPlayer } from './state.js';

function ensurePlayerCounters(player) {
  if (!player.turnCounters) {
    player.turnCounters = { appointments: {} };
  }
  if (!player.turnCounters.appointments) player.turnCounters.appointments = {};
  return player.turnCounters;
}

function ensureAppointmentBucket(player, titleKey) {
  const counters = ensurePlayerCounters(player);
  if (!counters.appointments[titleKey]) {
    counters.appointments[titleKey] = { self: 0, others: 0, otherPerPlayer: {} };
  }
  return counters.appointments[titleKey];
}

function ensureRevocationCounter(state) {
  if (!state.turnCounters) state.turnCounters = {};
  if (!state.turnCounters.revocation) state.turnCounters.revocation = { self: 0, others: 0 };
  return state.turnCounters.revocation;
}

// ─── Reset (called at the start of court each round) ───
export function resetTurnCounters(state) {
  state.turnCounters = { revocation: { self: 0, others: 0 } };
  for (const player of state.players) {
    player.turnCounters = { appointments: {} };
  }
}

// ─── Appointments ───
export function getAppointmentCost(state, appointerId, titleKey, appointeeId) {
  const player = getPlayer(state, appointerId);
  if (!player) return 0;
  const bucket = ensureAppointmentBucket(player, titleKey);
  if (appointerId === appointeeId) {
    return Math.max(1, bucket.self + 1 - bucket.others);
  }
  return bucket.otherPerPlayer[appointeeId] || 0;
}

export function recordAppointment(state, appointerId, titleKey, appointeeId) {
  const player = getPlayer(state, appointerId);
  if (!player) return;
  const bucket = ensureAppointmentBucket(player, titleKey);
  if (appointerId === appointeeId) {
    bucket.self += 1;
  } else {
    bucket.others += 1;
    bucket.otherPerPlayer[appointeeId] = (bucket.otherPerPlayer[appointeeId] || 0) + 1;
  }
}

// When a major title is taken from one player and given to another mid-turn,
// the LOSING player's appointment activity for that title key follows them to
// the new title key they were given (so any escalating self-cost continues to
// affect them on the new role). The receiving player starts fresh.
export function transferAppointmentCounters(state, losingPlayerId, fromTitleKey, toTitleKey) {
  const player = getPlayer(state, losingPlayerId);
  if (!player) return;
  const counters = ensurePlayerCounters(player);
  const bucket = counters.appointments[fromTitleKey];
  if (!bucket) return;
  delete counters.appointments[fromTitleKey];
  if (toTitleKey) counters.appointments[toTitleKey] = bucket;
}

// ─── Revocations (basileus-only today, but keyed on the actor for symmetry) ───
export function getRevocationCost(state, isSelfTarget) {
  const counter = ensureRevocationCounter(state);
  if (isSelfTarget) return 0;
  return Math.max(1, counter.others + 1 - counter.self);
}

export function recordRevocation(state, isSelfTarget) {
  const counter = ensureRevocationCounter(state);
  if (isSelfTarget) counter.self += 1;
  else counter.others += 1;
}
