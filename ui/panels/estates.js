// ui/panels/estates.js - Estates panel: plan estates with + and -, then lock once.
//
// + adds one estate to the plan in that province, - takes back one that was
// only planned (built estates are never removed here). The plan stays secret
// and is paid and built when Deployment opens.

import {
  canBuildEstatesIn,
  countPlannedEstates,
  getEstatePlan,
  getEstatePlanCost,
  getNextEstatePrice,
} from '../../engine/estates.js';
import { getSpendableGold } from '../../engine/deals.js';
import { getRegionLabel, renderEstateStack, renderProvinceBadge } from '../labels.js';
import { formatGoldHtml } from '../icons.js';
import { escapeHtml } from '../html.js';
import { renderInvasionCard } from './invasion.js';
import { bindSelectAction, getDraftBucket } from './shared.js';

const REGION_ORDER = ['east', 'west', 'sea'];

function getEstateDraft(uiState, state, playerId) {
  const draft = getDraftBucket(uiState, state, 'estates', playerId);
  if (!draft.plan) draft.plan = { ...getEstatePlan(state, playerId) };
  return draft;
}

function planCost(plan) {
  return getEstatePlanCost(countPlannedEstates(plan));
}

function goldFor(state, playerId) {
  return Math.max(0, Number(getSpendableGold(state, playerId)) || 0);
}

// Adds one planned estate if the purse allows it. Also used by a map click
// during the Estates phase. Returns true when the plan changed.
export function addEstateToDraft(uiState, state, playerId, themeId) {
  if (state?.phase !== 'estates' || state.estatesReady?.[playerId]) return false;
  if (!canBuildEstatesIn(state.themes?.[themeId])) return false;
  const draft = getEstateDraft(uiState, state, playerId);
  const next = { ...draft.plan, [themeId]: (Number(draft.plan[themeId]) || 0) + 1 };
  if (planCost(next) > goldFor(state, playerId)) return false;
  draft.plan = next;
  return true;
}

function removeEstateFromDraft(uiState, state, playerId, themeId) {
  const draft = getEstateDraft(uiState, state, playerId);
  const current = Number(draft.plan[themeId]) || 0;
  if (current <= 0) return false;
  if (current === 1) delete draft.plan[themeId];
  else draft.plan[themeId] = current - 1;
  return true;
}

function isOnInvasionRoute(state, themeId) {
  return Boolean(state.currentInvasion?.route?.includes(themeId));
}

function renderEstateRow(state, playerId, theme, plan, canAddMore, locked) {
  const planned = Number(plan[theme.id]) || 0;
  const onRoute = isOnInvasionRoute(state, theme.id);
  return `
    <div class="estate-row${planned ? ' planned' : ''}${onRoute ? ' on-route' : ''}" data-estate="${theme.id}" data-map-province="${theme.id}">
      <span class="estate-row-province">${renderProvinceBadge(state, theme, { compact: true })}</span>
      <span class="estate-row-holders">
        ${renderEstateStack(state, theme, { compact: true, planned: { playerId, count: planned }, fallback: '<span class="muted" aria-label="No estates yet">—</span>' })}
      </span>
      ${onRoute ? `<span class="estate-route-tag" title="${escapeHtml(`On the route of the ${state.currentInvasion?.name || 'invasion'}: estates here stop paying if the province is lost.`)}">Invasion route</span>` : ''}
      <span class="estate-stepper">
        <button type="button" class="estate-step" data-estate-remove="${theme.id}" aria-label="${escapeHtml(`Remove a planned estate in ${theme.name}`)}" ${planned > 0 && !locked ? '' : 'disabled'}>−</button>
        <span class="estate-step-count" aria-live="polite">${planned}</span>
        <button type="button" class="estate-step" data-estate-add="${theme.id}" aria-label="${escapeHtml(`Plan an estate in ${theme.name}`)}" ${canAddMore && !locked ? '' : 'disabled'}>+</button>
      </span>
    </div>
  `;
}

export function renderEstatesPanel(container, state, playerId, callbacks = {}, options = {}) {
  if (!container || !state) return;
  const locked = Boolean(state.estatesReady?.[playerId]);
  const draft = getEstateDraft(options.uiState, state, playerId);
  const plan = locked ? getEstatePlan(state, playerId) : draft.plan;
  const gold = goldFor(state, playerId);
  const plannedCount = countPlannedEstates(plan);
  const cost = planCost(plan);
  const nextPrice = getNextEstatePrice(plannedCount);
  const canAddMore = cost + nextPrice <= gold;
  const readyCount = state.players.filter((entry) => Boolean(state.estatesReady?.[entry.id])).length;
  const sites = Object.values(state.themes || {}).filter(canBuildEstatesIn);

  const regions = REGION_ORDER
    .map((region) => ({
      region,
      themes: sites
        .filter((theme) => theme.region === region)
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .filter((group) => group.themes.length);

  container.innerHTML = `
    <section class="phase-card estates-panel">
      <header class="estates-head">
        <h3>Estates</h3>
        <div class="estates-head-meta">
          <span class="estates-ready-count">${readyCount}/${state.players.length} locked</span>
          <span class="estates-reserve" title="Your gold">
            <span class="reserve-label">Gold</span>
            ${formatGoldHtml(gold)}
          </span>
        </div>
      </header>
      <p class="section-hint">Each estate pays its owner 1 gold every round. This round your first estate costs ${formatGoldHtml(getNextEstatePrice(0))} and each one after costs 1 more. Plans stay secret and are built when Deployment opens.</p>
      <div class="estate-plan-summary" data-estate-summary>
        <span><strong>${plannedCount}</strong> estate${plannedCount === 1 ? '' : 's'} planned</span>
        <span>Cost ${formatGoldHtml(cost)}</span>
        <span>Left ${formatGoldHtml(Math.max(0, gold - cost))}</span>
        <span>${canAddMore ? `Next one ${formatGoldHtml(nextPrice)}` : `Next one ${formatGoldHtml(nextPrice)}: not enough gold`}</span>
      </div>
      ${locked ? '<p class="panel-empty estate-locked-note">Your estates are locked. Change the plan to edit it.</p>' : ''}
      ${renderInvasionCard(state)}
      ${regions.map((group) => `
        <div class="estate-region">
          <h4 class="estate-region-title">${escapeHtml(getRegionLabel(group.region))}</h4>
          <div class="estate-list">
            ${group.themes.map((theme) => renderEstateRow(state, playerId, theme, plan, canAddMore, locked)).join('')}
          </div>
        </div>
      `).join('')}
      <div class="panel-actions action-priority">
        <button type="button" class="btn-secondary btn-reset" data-action="reset-estate-plan" ${plannedCount && !locked ? '' : 'disabled'}>Clear Plan</button>
        <button type="button" class="${locked ? 'btn-secondary btn-reset' : 'btn-primary btn-commit'}" data-action="confirm-estates">${locked ? 'Change Plan' : plannedCount ? 'Lock Estates' : 'Lock No Estates'}</button>
      </div>
    </section>
  `;

  const rerender = () => renderEstatesPanel(container, state, playerId, callbacks, options);
  container.querySelectorAll('[data-estate-add]').forEach((button) => {
    button.addEventListener('click', () => {
      if (addEstateToDraft(options.uiState, state, playerId, button.dataset.estateAdd)) rerender();
    });
  });
  container.querySelectorAll('[data-estate-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      if (removeEstateFromDraft(options.uiState, state, playerId, button.dataset.estateRemove)) rerender();
    });
  });
  bindSelectAction(container, '[data-action="reset-estate-plan"]', () => {
    draft.plan = {};
    rerender();
  });
  bindSelectAction(container, '[data-action="confirm-estates"]', () => {
    if (locked) {
      draft.plan = { ...getEstatePlan(state, playerId) };
      callbacks.confirmEstates?.();
      return;
    }
    callbacks.submitEstatePlan?.({ plan: { ...draft.plan } });
  });
}
