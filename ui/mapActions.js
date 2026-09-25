// ui/mapActions.js - the province popover: play the phase from the map.
//
// Select a province and a small card opens beside it on the map, with what
// the dynasty can do there this phase:
//
//   Estates  plan estates with - and +, with the price and the domain.
//   Offices  revoke what is held there, or appoint a Strategos or a Bishop.
//
// It edits the same drafts as the side panel (nothing is committed until the
// panel's Lock), so the two always agree.

import { getBalance } from '../data/balance.js';
import {
  canBuildEstatesIn,
  countPlannedEstates,
  getDomainCount,
  getEstateCount,
  getEstatePlan,
  getEstatePlanCost,
  getRevocableEstateCount,
} from '../engine/estates.js';
import { getSpendableGold } from '../engine/deals.js';
import { getPlayer } from '../engine/state.js';
import { getProvinceAnchorPx, setMapViewChangeHandler } from '../render/mapRenderer.js';
import { escapeHtml } from './html.js';
import { formatGoldHtml } from './icons.js';
import { renderEstateStack, renderPlayerChip } from './labels.js';
import {
  getProvinceCourtOptions,
  planProvinceAppointment,
  removeProvincePlannedAction,
  toggleProvinceRevocation,
} from './panels/court.js';
import { addEstateToDraft, getEstateDraft, removeEstateFromDraft } from './panels/estates.js';
import { playerDisplayLabel } from './panels/shared.js';

const POPOVER_CLASS = 'map-province-actions';
const POPOVER_GAP_PX = 22;
const POPOVER_MARGIN_PX = 8;

function getShell() {
  return document.getElementById('mapContainer')?.querySelector('.map-shell') || null;
}

function goldFor(state, playerId) {
  return Math.max(0, Number(getSpendableGold(state, playerId)) || 0);
}

// Estates: the dynasty's plan in this province, with - and +.
function renderEstateSection(state, playerId, theme, uiState) {
  if (!canBuildEstatesIn(theme)) {
    return `<p class="map-actions-note">${theme.id === 'CPL' ? 'No estates can be built in Constantinople.' : 'No estates can be built in a lost province.'}</p>`;
  }
  const locked = Boolean(state.estatesReady?.[playerId]);
  const plan = locked ? getEstatePlan(state, playerId) : getEstateDraft(uiState, state, playerId).plan;
  const planned = Number(plan[theme.id]) || 0;
  const { ESTATE_PRICE: price, ESTATE_DOMAIN_SIZE: size, ESTATE_DOMAIN_BONUS: bonus } = getBalance(state);
  const gold = goldFor(state, playerId);
  const cost = getEstatePlanCost(countPlannedEstates(plan), state);
  const canAdd = !locked && cost + price <= gold;
  const held = getEstateCount(theme, playerId);
  const total = held + planned;
  const domains = getDomainCount(total, state);
  const toNext = size - (total % size);
  const domainText = total > 0
    ? `${domains ? `${domains} domain${domains === 1 ? '' : 's'} (+${domains * bonus} gold)` : 'No domain yet'}; ${toNext} more for ${domains ? 'the next' : 'one'}`
    : `Every ${size} of yours here form a domain (+${bonus} gold)`;
  return `
    <div class="map-actions-estates">
      <div class="map-actions-holders">
        ${renderEstateStack(state, theme, { compact: true, planned: { playerId, count: planned }, fallback: '<span class="muted">No estates yet</span>' })}
      </div>
      <div class="map-actions-stepper">
        <button type="button" class="estate-step" data-map-estate-remove aria-label="${escapeHtml(`Remove a planned estate in ${theme.name}`)}" ${planned > 0 && !locked ? '' : 'disabled'}>−</button>
        <span class="estate-step-count" aria-live="polite">${planned}</span>
        <button type="button" class="estate-step" data-map-estate-add aria-label="${escapeHtml(`Plan an estate in ${theme.name}`)}" ${canAdd ? '' : 'disabled'}>+</button>
        <span class="map-actions-price">${formatGoldHtml(price)} each · ${formatGoldHtml(Math.max(0, gold - cost))} left</span>
      </div>
      <p class="map-actions-note">${escapeHtml(domainText)}.</p>
      ${locked ? '<p class="map-actions-note">Your estates are locked: change the plan in the panel to edit it.</p>' : ''}
    </div>
  `;
}

// "3 estates", "Strategos" or "Bishop": the holder's chip says whose.
function describeHolding(state, theme, option) {
  if (option.kind === 'estate') {
    const count = getRevocableEstateCount(theme, option.holderId);
    return `${count} estate${count === 1 ? '' : 's'}`;
  }
  return option.kind === 'bishop' ? 'Bishop' : 'Strategos';
}

function renderRevocation(state, theme, option) {
  const planned = Boolean(option.plannedAction);
  const holder = getPlayer(state, option.holderId);
  const label = planned ? 'Planned: undo' : 'Revoke';
  return `
    <div class="map-actions-row${planned ? ' is-planned' : ''}" title="${escapeHtml(option.label)}">
      <span class="map-actions-row-label">${holder ? renderPlayerChip(state, holder, { compact: true }) : ''} ${escapeHtml(describeHolding(state, theme, option))}</span>
      <button type="button" class="map-actions-btn${planned ? ' is-planned' : ' is-revoke'}"
        data-map-revoke="${escapeHtml(option.revokeValue)}" data-map-power="${escapeHtml(option.powerKey)}"
        ${!planned && option.disabledReason ? `disabled title="${escapeHtml(option.disabledReason)}"` : ''}>${label}</button>
    </div>
  `;
}

function renderAppointment(state, option) {
  const seat = option.kind === 'bishop' ? 'Bishop' : 'Strategos';
  if (option.plannedAction) {
    const appointee = getPlayer(state, Number(option.plannedAction.appointeeId));
    return `
      <div class="map-actions-row is-planned">
        <span class="map-actions-row-label">${seat}: ${appointee ? renderPlayerChip(state, appointee, { compact: true }) : ''}</span>
        <button type="button" class="map-actions-btn is-planned" data-map-plan-remove="${escapeHtml(option.plannedKey)}">Planned: undo</button>
      </div>
    `;
  }
  const choices = option.appointees.map((entry) => {
    const player = getPlayer(state, entry.playerId);
    if (!player) return '';
    return `
      <button type="button" class="map-actions-appointee"
        data-map-appoint="${entry.playerId}" data-map-kind="${escapeHtml(option.kind)}" data-map-power="${escapeHtml(option.powerKey)}"
        aria-label="${escapeHtml(`Appoint ${playerDisplayLabel(player)} ${seat}`)}"
        ${entry.disabledReason ? `disabled title="${escapeHtml(entry.disabledReason)}"` : ''}>
        ${renderPlayerChip(state, player, { compact: true })}
      </button>
    `;
  }).join('');
  return `
    <div class="map-actions-row map-actions-appoint">
      <span class="map-actions-row-label">Appoint ${seat}</span>
      <span class="map-actions-appointees">${choices}</span>
    </div>
  `;
}

// Offices: grouped by the office that acts (Basileus, Domestic, Patriarch...).
function renderCourtSection(state, playerId, theme, uiState) {
  const { options, planError } = getProvinceCourtOptions(state, playerId, theme.id, uiState);
  if (!options.length) return '';
  const groups = new Map();
  for (const option of options) {
    if (!groups.has(option.powerKey)) groups.set(option.powerKey, { label: option.powerLabel, options: [] });
    groups.get(option.powerKey).options.push(option);
  }
  return `
    <div class="map-actions-court">
      ${[...groups.values()].map((group) => `
        <div class="map-actions-group">
          <span class="map-actions-group-title">As ${escapeHtml(group.label)}</span>
          ${group.options.map((option) => (option.mode === 'open' ? renderAppointment(state, option) : renderRevocation(state, theme, option))).join('')}
        </div>
      `).join('')}
      ${planError ? `<p class="form-error" role="alert">${escapeHtml(planError)}</p>` : ''}
      <p class="map-actions-note">Nothing is done until you lock your offices.</p>
    </div>
  `;
}

function renderBody(state, playerId, theme, uiState) {
  if (state.phase === 'estates') return renderEstateSection(state, playerId, theme, uiState);
  if (state.phase === 'court') return renderCourtSection(state, playerId, theme, uiState);
  return '';
}

// Places the card under the province's name, or above it near the bottom
// edge, inside the map.
function positionPopover(popover, provinceId) {
  const anchor = getProvinceAnchorPx(provinceId);
  if (!anchor) {
    popover.hidden = true;
    return;
  }
  const inView = anchor.x >= 0 && anchor.x <= anchor.width && anchor.y >= 0 && anchor.y <= anchor.height;
  popover.hidden = !inView;
  if (!inView) return;
  const width = popover.offsetWidth || 260;
  const height = popover.offsetHeight || 120;
  let left = anchor.x - width / 2;
  left = Math.max(POPOVER_MARGIN_PX, Math.min(anchor.width - width - POPOVER_MARGIN_PX, left));
  let top = anchor.y + POPOVER_GAP_PX;
  if (top + height > anchor.height - POPOVER_MARGIN_PX) top = anchor.y - POPOVER_GAP_PX - height;
  top = Math.max(POPOVER_MARGIN_PX, top);
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function removePopover() {
  getShell()?.querySelector(`.${POPOVER_CLASS}`)?.remove();
  setMapViewChangeHandler(null);
}

// The last popover drawn, redrawn when a side panel changes a draft.
let lastArgs = null;
let listening = false;

function listenForDraftChanges() {
  if (listening || typeof document?.addEventListener !== 'function') return;
  listening = true;
  document.addEventListener('basileus:draft-change', () => {
    if (lastArgs) renderMapProvinceActions(lastArgs);
  });
}

// Draws (or hides) the popover for the selected province. `canControl` is
// whether the viewer plays `playerId`; `rerender` redraws the whole game.
export function renderMapProvinceActions(args) {
  const { state, playerId, provinceId, uiState, canControl, rerender, onClose } = args;
  lastArgs = args;
  listenForDraftChanges();
  const shell = getShell();
  const theme = provinceId ? state?.themes?.[provinceId] : null;
  const body = shell && theme && canControl && Number.isInteger(playerId) ? renderBody(state, playerId, theme, uiState) : '';
  if (!body) {
    removePopover();
    return;
  }

  let popover = shell.querySelector(`.${POPOVER_CLASS}`);
  if (!popover) {
    popover = document.createElement('section');
    popover.className = POPOVER_CLASS;
    popover.setAttribute('role', 'dialog');
    shell.appendChild(popover);
  }
  popover.setAttribute('aria-label', `${theme.name}: ${state.phase === 'estates' ? 'estates' : 'offices'}`);
  popover.dataset.provinceId = theme.id;
  popover.innerHTML = `
    <header class="map-actions-head">
      <span class="map-actions-title">${escapeHtml(theme.name)}</span>
      <button type="button" class="map-actions-close" data-map-actions-close aria-label="Close">×</button>
    </header>
    ${body}
  `;

  const after = (changed) => {
    if (changed) rerender?.();
  };
  // Keep map gestures (pan, click-through) off the card.
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick', 'wheel']) {
    popover.addEventListener(type, (event) => event.stopPropagation(), { passive: true });
  }
  popover.querySelector('[data-map-actions-close]')?.addEventListener('click', () => onClose?.());
  popover.querySelector('[data-map-estate-add]')?.addEventListener('click', () => {
    after(addEstateToDraft(uiState, state, playerId, theme.id));
  });
  popover.querySelector('[data-map-estate-remove]')?.addEventListener('click', () => {
    after(removeEstateFromDraft(uiState, state, playerId, theme.id));
  });
  popover.querySelectorAll('[data-map-revoke]').forEach((button) => {
    button.addEventListener('click', () => {
      toggleProvinceRevocation(state, playerId, uiState, button.dataset.mapPower, button.dataset.mapRevoke);
      after(true);
    });
  });
  popover.querySelectorAll('[data-map-appoint]').forEach((button) => {
    button.addEventListener('click', () => {
      planProvinceAppointment(state, playerId, uiState, button.dataset.mapPower, button.dataset.mapKind, theme.id, Number(button.dataset.mapAppoint));
      after(true);
    });
  });
  popover.querySelectorAll('[data-map-plan-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      after(removeProvincePlannedAction(state, playerId, uiState, button.dataset.mapPlanRemove));
    });
  });

  positionPopover(popover, theme.id);
  setMapViewChangeHandler(() => positionPopover(popover, theme.id));
}
