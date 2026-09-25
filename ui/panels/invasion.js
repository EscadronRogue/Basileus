// ui/panels/invasion.js - the invasion ladder: how much the invader must beat
// the frontier by to take each province, and what a war actually cost.

import { getBalance } from '../../data/balance.js';
import { buildInvasionLadder, buildReconquestLadder, getFrontierThresholds } from '../../engine/combat.js';
import { formatTroopsHtml } from '../icons.js';
import { escapeHtml } from '../html.js';
import { renderProvinceBadge } from '../labels.js';

function formatStrengthRange(invasion) {
  const [low, high] = Array.isArray(invasion?.strength) ? invasion.strength : [];
  if (!Number.isFinite(Number(low)) || !Number.isFinite(Number(high))) return '?';
  return Number(low) === Number(high) ? String(low) : `${low}–${high}`;
}

function renderLadderStep(state, step, kind) {
  const badge = renderProvinceBadge(state, step.themeId, { compact: true });
  let value;
  if (step.status === 'imperial' && kind === 'reconquest') {
    value = '<span class="ladder-value free">imperial</span>';
  } else if (step.status === 'lost' && kind === 'invasion') {
    value = '<span class="ladder-value free" title="Already lost: the invader crosses it for free.">lost</span>';
  } else {
    const walls = step.walls ? ` (Theodosian Walls ${step.walls})` : '';
    const verb = kind === 'reconquest' ? 'Retaking' : 'Taking';
    const title = `${verb} ${state.themes?.[step.themeId]?.name || step.themeId} costs ${step.cost}${walls}; reached with a lead of ${step.needed}.`;
    value = `<span class="ladder-value" title="${escapeHtml(title)}">+${step.cost}${walls}</span>`;
  }
  return `<li class="ladder-step ${escapeHtml(step.status)}" data-ladder-step="${escapeHtml(step.themeId)}">${badge}${value}</li>`;
}

// Where the strength comes from, as fixed when the invasion was drawn.
function renderStrengthParts(state, invasion) {
  const reach = Number(invasion.reach);
  const round = Number(invasion.drawnRound);
  if (!Number.isFinite(reach) || !Number.isFinite(round)) return '';
  const { INVASION_STRENGTH_PER_PROVINCE: perProvince, INVASION_STRENGTH_PER_ROUND: perRound } = getBalance(state);
  const strength = Number(invasion.strength?.[0]) || 0;
  const provinces = `${reach} imperial province${reach === 1 ? '' : 's'} on its route`;
  return `<p class="invasion-card-hint" data-invasion-strength-parts>Strength ${strength} = ${perProvince} × ${provinces} + ${perRound} × round ${round}.</p>`;
}

// The card shown before the war (Estates and Deployment).
export function renderInvasionCard(state) {
  const invasion = state?.currentInvasion;
  if (!invasion?.route?.length) return '';
  const ladder = buildInvasionLadder(state, invasion.route);
  const reconquest = buildReconquestLadder(state, invasion.route).filter((step) => step.status === 'lost');
  const strength = Number(invasion.strength?.[0]) || 0;
  const thresholds = getFrontierThresholds(state, strength, invasion.route);
  return `
    <section class="invasion-card" data-invasion-card>
      <header class="invasion-card-head">
        <span class="invasion-card-kicker">Invasion</span>
        <span class="invasion-card-name">${escapeHtml(invasion.name || 'Invaders')}</span>
        <span class="invasion-card-strength" title="Strength">Strength ${formatTroopsHtml(0, { displayValue: formatStrengthRange(invasion) })}</span>
      </header>
      ${renderStrengthParts(state, invasion)}
      <p class="invasion-card-needs" data-invasion-needs>
        <span>Hold every province: <strong>${formatTroopsHtml(thresholds.holdAll)}</strong> at the frontier</span>
        ${thresholds.saveCapital > 0 ? `<span>Save Constantinople: <strong>${formatTroopsHtml(thresholds.saveCapital)}</strong></span>` : ''}
        ${thresholds.saveCapital === 0 ? '<span>Constantinople is out of its reach</span>' : ''}
      </p>
      <p class="invasion-card-hint">What the invader beats the frontier by pays for its route, step by step: the cost of each is shown. It stops at the first it cannot pay for.${thresholds.saveCapital != null ? ' If it takes Constantinople, the empire falls and nobody wins.' : ''}</p>
      <ol class="invasion-ladder">
        ${ladder.map((step) => renderLadderStep(state, step, 'invasion')).join('')}
      </ol>
      ${reconquest.length ? `
        <p class="invasion-card-hint">If the frontier wins, its lead retakes lost provinces on the route, starting nearest Constantinople, at the cost shown.</p>
        <ol class="invasion-ladder reconquest">
          ${reconquest.map((step) => renderLadderStep(state, step, 'reconquest')).join('')}
        </ol>
      ` : ''}
    </section>
  `;
}

const OUTCOME_LABELS = {
  taken: 'taken',
  crossed: 'crossed, already lost',
  held: 'held',
  retaken: 'retaken',
  out_of_reach: 'out of reach',
};

// The war ledger shown in Resolution: what each province cost and what was left.
export function renderWarLedger(state, war) {
  const steps = Array.isArray(war?.steps) ? war.steps : [];
  if (!steps.length) return '';
  const defeat = war.outcome === 'defeat';
  const who = defeat ? 'The invader' : 'The frontier';
  return `
    <div class="war-ledger" data-war-ledger>
      <div class="war-ledger-title">${defeat ? `The invader won by ${war.margin}` : `The frontier won by ${war.margin}`}</div>
      <ol class="war-ledger-list">
        ${steps.map((step) => `
          <li class="war-ledger-step ${escapeHtml(step.outcome)}">
            ${renderProvinceBadge(state, step.themeId, { compact: true })}
            <span class="war-ledger-cost">${step.cost > 0 ? `costs ${step.cost}` : 'free'}</span>
            <span class="war-ledger-outcome">${escapeHtml(OUTCOME_LABELS[step.outcome] || step.outcome)}</span>
          </li>
        `).join('')}
      </ol>
      <div class="war-ledger-total">${escapeHtml(who)} spent ${war.spent} and had ${war.leftover} left over.</div>
    </div>
  `;
}
