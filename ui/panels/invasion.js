// ui/panels/invasion.js - the invasion ladder: how much the invader must beat
// the frontier by to take each province, and what a war actually cost.

import { buildInvasionLadder, buildReconquestLadder } from '../../engine/combat.js';
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
  if (step.status === 'lost' && kind === 'invasion') value = '<span class="ladder-value free">already lost</span>';
  else if (step.status === 'imperial' && kind === 'reconquest') value = '<span class="ladder-value free">imperial</span>';
  else {
    const walls = step.walls ? `, the Theodosian Walls adding ${step.walls}` : '';
    value = `<span class="ladder-value" title="${escapeHtml(`Needs to win the war by ${step.needed} or more${walls}`)}">+${step.needed}</span>`;
  }
  return `<li class="ladder-step ${escapeHtml(step.status)}" data-ladder-step="${escapeHtml(step.themeId)}">${badge}${value}</li>`;
}

// The card shown before the war (Estates and Deployment).
export function renderInvasionCard(state) {
  const invasion = state?.currentInvasion;
  if (!invasion?.route?.length) return '';
  const ladder = buildInvasionLadder(state, invasion.route);
  const reconquest = buildReconquestLadder(state, invasion.route).filter((step) => step.status === 'lost');
  const reachesCapital = ladder.some((step) => step.status === 'capital');
  return `
    <section class="invasion-card" data-invasion-card>
      <header class="invasion-card-head">
        <span class="invasion-card-kicker">Invasion</span>
        <span class="invasion-card-name">${escapeHtml(invasion.name || 'Invaders')}</span>
        <span class="invasion-card-strength" title="Estimated strength">Strength ${formatTroopsHtml(0, { displayValue: formatStrengthRange(invasion) })}</span>
      </header>
      <p class="invasion-card-hint">The invader takes a province when it beats the frontier by at least the number shown. Lost provinces cost it nothing.${reachesCapital ? ` The Theodosian Walls make Constantinople cost ${escapeHtml(String(ladder.find((step) => step.status === 'capital')?.walls || 0))} more; if the invader takes it, the empire falls and nobody wins.` : ''}</p>
      <ol class="invasion-ladder">
        ${ladder.map((step) => renderLadderStep(state, step, 'invasion')).join('')}
      </ol>
      ${reconquest.length ? `
        <p class="invasion-card-hint">If the frontier wins, it retakes a lost province when it wins by at least the number shown.</p>
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
