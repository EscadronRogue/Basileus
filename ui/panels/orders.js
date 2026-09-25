// ui/panels/orders.js - Deployment panel: troops fielded, destinations, mercenaries, and coup choices.

import { BALANCE, getBalance } from '../../data/balance.js';
import { getDismissalGold, getMercenaryHireCost } from '../../engine/rules.js';
import { describeRisingPrices } from '../../engine/presentation.js';
import { getPlayer } from '../../engine/state.js';
import { getCapitalSupportEntries } from '../../engine/capitalSupport.js';
import {
  buildDefaultCoupChoices,
  getCoupChoiceShares,
  getCoupChoiceWeight,
  normalizeCoupChoices,
  placeRequiredCoupChoice,
} from '../../engine/coup.js';
import {
  getDefaultDeploymentFunding,
  getDeploymentArmySourceKeys,
  getDeploymentArmyTroopTotal,
  getPlayerDeploymentArmyKeys,
  isStrategosDeploymentArmyKey,
} from '../../engine/deployment.js';
import { formatGoldHtml, formatHalves, formatMercenariesHtml, formatSupportHtml, formatTroopsHtml, renderIcon } from '../icons.js';
import { escapeHtml } from '../html.js';
import { renderInvasionCard } from './invasion.js';
import { getPlayerStyleAttr, renderCartouchedText, renderPlayerChip } from '../labels.js';
import {
  bindSelectAction,
  getDraftBucket,
  playerDisplayLabel,
  playerInitial,
  renderArmyOfficeBadge,
  renderPickerStep,
} from './shared.js';

function getPlayerArmyKeys(state, playerId) {
  return getPlayerDeploymentArmyKeys(state, playerId);
}

function getArmyMaxTroops(state, playerId, officeKey) {
  return getDeploymentArmyTroopTotal(state, playerId, officeKey);
}

function ensureDeploymentDraft(state, playerId, draft, armyKeys) {
  for (const officeKey of armyKeys) {
    if (!draft.armies[officeKey]) draft.armies[officeKey] = {};
    const max = getArmyMaxTroops(state, playerId, officeKey);
    const funded = normalizedFunded(draft.armies[officeKey].funded, max);
    draft.armies[officeKey].funded = funded == null ? getDefaultDeploymentFunding(max) : funded;
  }
}

// A new draft backs the dynasty itself first.
function ensureCoupChoices(state, playerId, draft, lockedCandidateId = null) {
  if (!Array.isArray(draft.coupChoices)) draft.coupChoices = buildDefaultCoupChoices(state, playerId);
  draft.coupChoices = lockedCandidateId == null
    ? normalizeCoupChoices(state, draft.coupChoices)
    : placeRequiredCoupChoice(state, playerId, draft.coupChoices, lockedCandidateId);
  return draft.coupChoices;
}

function isDeploymentDestination(value) {
  return value === 'frontier' || value === 'capital';
}

function normalizedFunded(value, max) {
  if (value == null || value === '') return null;
  if (!Number.isInteger(Number(value))) return null;
  return Math.max(0, Math.min(max, Number(value)));
}

function getDeploymentReadiness(state, playerId, draft, armyKeys) {
  const missing = [];
  for (const officeKey of armyKeys) {
    const max = getArmyMaxTroops(state, playerId, officeKey);
    if (max <= 0) continue;
    const order = draft.armies?.[officeKey] || {};
    if (!isDeploymentDestination(order.destination)) missing.push(`${officeKey}:destination`);
  }
  const mercenaryCount = Math.max(0, Number(draft.mercenaries?.count) || 0);
  if (mercenaryCount > 0 && !isDeploymentDestination(draft.mercenaries?.destination)) {
    missing.push('mercenaries:destination');
  }
  return { ready: missing.length === 0, missing };
}

function getDeploymentLockHelp(totals, readiness) {
  if (totals?.overBudget) return 'Your mercenaries cost more gold than you have, counting the gold from dismissed troops.';
  if (readiness?.ready) return 'Every army has a destination. You can still change how many troops you field.';
  return 'To lock deployment, send each army to the Frontier or to Constantinople.';
}

function getActiveOrderLocks(options = {}) {
  const locks = options.privateData?.orderLocks;
  return locks && typeof locks === 'object' ? locks : null;
}

function applyOrderLocksToDraft(state, playerId, draft, orderLocks) {
  if (!orderLocks?.ok) return;
  if (orderLocks.candidateId != null) {
    ensureCoupChoices(state, playerId, draft, Number(orderLocks.candidateId));
  }
  for (const [officeKey, destination] of Object.entries(orderLocks.committedOfficeKeys || {})) {
    if (!draft.armies[officeKey]) draft.armies[officeKey] = { funded: 0, destination: 'frontier' };
    draft.armies[officeKey].funded = getArmyMaxTroops(state, playerId, officeKey);
    draft.armies[officeKey].destination = destination === 'capital' ? 'capital' : 'frontier';
  }
}

function getDraftArmyBreakdown(state, playerId, draft, armyKeys) {
  let capitalTroops = 0;
  let frontierTroops = 0;
  let unfundedTroops = 0;

  for (const officeKey of armyKeys) {
    const totalTroops = getArmyMaxTroops(state, playerId, officeKey);
    const order = draft.armies?.[officeKey] || {};
    const funded = normalizedFunded(order.funded, totalTroops) ?? getDefaultDeploymentFunding(totalTroops);
    const destination = isDeploymentDestination(order.destination) ? order.destination : null;

    capitalTroops += destination === 'capital' ? funded : 0;
    frontierTroops += destination === 'frontier' ? funded : 0;
    unfundedTroops += Math.max(0, totalTroops - funded);
  }

  const mercenaryCount = Math.max(0, Number(draft.mercenaries?.count) || 0);
  if (draft.mercenaries?.destination === 'capital') capitalTroops += mercenaryCount;
  else if (draft.mercenaries?.destination === 'frontier') frontierTroops += mercenaryCount;

  return {
    capitalTroops,
      frontierTroops,
    unfundedTroops,
  };
}

function getDeploymentTotals(state, playerId, draft, armyKeys, reserve) {
  const unfundedGold = armyKeys.reduce((sum, key) => {
    const max = getArmyMaxTroops(state, playerId, key);
    const funded = normalizedFunded(draft.armies[key]?.funded, max) ?? getDefaultDeploymentFunding(max);
    return sum + getDismissalGold(Math.max(0, max - funded));
  }, 0);
  const mercCost = getMercenaryHireCost(0, draft.mercenaries.count || 0);
  return {
    mercCost,
    unfundedGold,
    overBudget: reserve + unfundedGold < mercCost,
  };
}

function renderOrderLockNotice(state, orderLocks) {
  if (!orderLocks) return '';
  if (!orderLocks.ok) {
    return `
      <div class="order-lock-notice warning">
        <span class="order-lock-kicker">Deal commitments</span>
        <span>${escapeHtml(orderLocks.reason || 'Accepted deal commitments cannot be fulfilled right now.')}</span>
      </div>
    `;
  }

  const rows = [];
  if (orderLocks.candidateId != null) {
    const candidate = getPlayer(state, Number(orderLocks.candidateId));
    rows.push(`Coup choice: ${renderPlayerChip(state, candidate, `Player ${Number(orderLocks.candidateId) + 1}`, { variant: 'light' })} stays pledged`);
  }
  for (const office of orderLocks.officeSelections || []) {
    const destination = office.destination === 'capital' ? 'Constantinople' : 'Frontier';
    rows.push(`${renderCartouchedText(state, office.officeName || office.officeKey)} -> ${destination}`);
  }
  if (!rows.length) return '';

  return `
    <div class="order-lock-notice">
      <span class="order-lock-kicker">Deal commitments</span>
      <span>These choices are already pledged and will be applied when you lock deployment.</span>
      <div class="order-lock-list">
        ${rows.map((row) => `<span>${row}</span>`).join('')}
      </div>
    </div>
  `;
}

function renderDeploymentPreview(state, playerId, draft, armyKeys) {
  const breakdown = getDraftArmyBreakdown(state, playerId, draft, armyKeys);
  return `
    <div class="deployment-preview" data-deployment-preview>
      <div class="deployment-preview-row">
        <span class="deployment-preview-label">Frontier</span>
        <span class="deployment-preview-value">${formatTroopsHtml(breakdown.frontierTroops)}</span>
      </div>
      <div class="deployment-preview-row">
        <span class="deployment-preview-label">Constantinople</span>
        <span class="deployment-preview-value">${formatTroopsHtml(breakdown.capitalTroops)}</span>
      </div>
      <div class="deployment-preview-row">
        <span class="deployment-preview-label">Dismissed</span>
        <span class="deployment-preview-value">${formatTroopsHtml(breakdown.unfundedTroops)} ${formatGoldHtml(getDismissalGold(breakdown.unfundedTroops), { signed: true, tone: 'income' })}</span>
      </div>
    </div>
  `;
}

// What this dynasty gives each claimant: its troops in Constantinople, plus
// the Patriarch's influence when it holds that office.
function getOwnCoupSupport(state, playerId, draft, armyKeys) {
  const { capitalTroops } = getDraftArmyBreakdown(state, playerId, draft, armyKeys);
  const influence = getCapitalSupportEntries(state)
    .filter((entry) => entry.titleKey === 'PATRIARCH' && Number(entry.playerId) === playerId)
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) || 0), 0);
  const byCandidate = {};
  for (const share of getCoupChoiceShares(draft.coupChoices || [])) {
    byCandidate[share.candidateId] = (capitalTroops + influence) * share.weight;
  }
  return { capitalTroops, influence, byCandidate };
}

function renderCoupSupportCards(state, playerId, draft, own) {
  const cards = getCapitalSupportEntries(state).map((entry) => {
    const holderId = Number(entry.playerId);
    const holder = getPlayer(state, holderId);
    const chip = renderPlayerChip(state, holder, `Player ${holderId + 1}`, { variant: 'light' });
    const amount = Number(entry.amount) || 0;
    const mine = holderId === playerId;
    let body;
    if (entry.titleKey === 'PATRIARCH') {
      const choices = mine ? (draft.coupChoices || []) : [];
      const split = getCoupChoiceShares(choices)
        .map((share) => `${formatSupportHtml(amount * share.weight)} to ${renderPlayerChip(state, getPlayer(state, share.candidateId), '', { variant: 'light' })}`)
        .join(', ');
      body = mine
        ? (split ? `${formatSupportHtml(amount)} follows your choices: ${split}.` : `${formatSupportHtml(amount)} backs nobody until you choose.`)
        : `${formatSupportHtml(amount)} follows the choices of the Patriarch, ${chip}.`;
    } else if (entry.titleKey === 'BASILEUS') {
      body = `${formatSupportHtml(amount, { signed: true })} for the Basileus, ${chip}.`;
    } else if (entry.kind === 'lost_provinces') {
      body = `${formatSupportHtml(amount, { signed: true })} for ${chip}, who lost provinces last round.`;
    } else if (entry.kind === 'reconquest') {
      body = `${formatSupportHtml(amount, { signed: true })} for ${chip}, best defender last round.`;
    } else {
      body = `${formatSupportHtml(amount, { signed: true })} for ${chip}.`;
    }
    return `
      <div class="coup-support-card${mine ? ' mine' : ''}${amount < 0 ? ' negative' : ''}">
        <span class="coup-support-name">${escapeHtml(entry.label || 'Support')}</span>
        <span class="coup-support-body">${body}</span>
      </div>
    `;
  });
  if (!cards.length) return '';
  return `
    <div class="coup-support-cards" data-coup-support-cards>
      <span class="coup-support-kicker">Other support in Constantinople</span>
      ${cards.join('')}
    </div>
  `;
}

function renderCoupSummary(state, playerId, draft, own) {
  const choices = draft.coupChoices || [];
  if (!choices.length) {
    return own.capitalTroops > 0 || own.influence > 0
      ? 'You back nobody: your troops in Constantinople will not count in the coup.'
      : 'You back nobody in the coup.';
  }
  if (own.capitalTroops <= 0 && own.influence <= 0) {
    return 'You send no troops to Constantinople, so your choices add no support this round.';
  }
  const parts = getCoupChoiceShares(choices).map((share) => {
    const name = share.candidateId === playerId ? 'yourself' : playerDisplayLabel(getPlayer(state, share.candidateId));
    return `${name} with ${formatHalves(own.byCandidate[share.candidateId] || 0)}`;
  });
  return `You back ${parts.join(' and ')}.`;
}

function renderCoupChoices(state, playerId, draft, armyKeys, lockedCandidateId = null) {
  const own = getOwnCoupSupport(state, playerId, draft, armyKeys);
  const choices = draft.coupChoices || [];
  const secondWeight = getCoupChoiceWeight(1);
  return `
    <div class="coup-choice-list" role="group" aria-label="Coup choices">
      ${state.players.map((candidate) => {
        const candidateId = candidate.id;
        const choiceIndex = choices.indexOf(candidateId);
        const isSelf = candidateId === playerId;
        const isLocked = lockedCandidateId != null && candidateId === lockedCandidateId;
        const isBasileus = candidateId === state.basileusId;
        const gain = own.byCandidate[candidateId] || 0;
        const name = playerDisplayLabel(candidate);
        const choiceButton = (index, label) => {
          const active = choiceIndex === index;
          const disabled = isLocked || (index === 1 && !choices.length);
          return `<button type="button" class="coup-choice-btn${active ? ' active' : ''}" data-coup-choice="${index}" data-coup-candidate="${candidateId}" aria-pressed="${active ? 'true' : 'false'}" aria-label="${escapeHtml(`${label} choice: ${name}`)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
        };
        return `
          <div class="candidate-row coup-choice-row${choiceIndex === 0 ? ' first' : choiceIndex === 1 ? ' second' : ''}${isSelf ? ' self' : ''}" data-coup-row="${candidateId}" style="${getPlayerStyleAttr(state, candidateId)}">
            <span class="candidate-crest">${playerInitial(candidate)}</span>
            <span class="candidate-name">${escapeHtml(name)}${isSelf ? ' <span class="coup-choice-you">(you)</span>' : ''}${isBasileus ? ' <span class="coup-choice-you">Basileus</span>' : ''}</span>
            <span class="coup-choice-gain">${choiceIndex >= 0 ? formatSupportHtml(gain, { signed: true }) : ''}</span>
            <span class="coup-choice-buttons">
              ${choiceButton(0, '1st')}
              ${choiceButton(1, '2nd')}
            </span>
          </div>
        `;
      }).join('')}
    </div>
    <p class="coup-choice-summary" data-coup-summary>${escapeHtml(renderCoupSummary(state, playerId, draft, own))}</p>
    ${renderCoupSupportCards(state, playerId, draft, own)}
    <p class="coup-choice-note">1st choice gets all your support, 2nd choice gets ${Math.round(secondWeight * 100)}%. The most support wins the throne; if nobody is backed, the Basileus stays.</p>
  `;
}

// Sets `candidateId` as the first (0) or second (1) choice, or clears it when
// it already holds that place. A claimant moved to the other place swaps with
// whoever was there; a claimant a deal requires cannot be dropped.
export function toggleCoupChoice(state, draft, candidateId, index, lockedCandidateId = null) {
  const [first = null, second = null] = draft.coupChoices || [];
  let next;
  if (index === 0) {
    if (first === candidateId) next = [second];
    else if (second === candidateId) next = [candidateId, first];
    else next = [candidateId, second];
  } else if (second === candidateId) {
    next = [first];
  } else if (first === candidateId) {
    next = second == null ? [first] : [second, candidateId];
  } else {
    next = [first ?? candidateId, first == null ? null : candidateId];
  }
  next = normalizeCoupChoices(state, next.filter((id) => id != null));
  if (lockedCandidateId != null && !next.includes(lockedCandidateId)) return false;
  const changed = next.join(',') !== (draft.coupChoices || []).join(',');
  draft.coupChoices = next;
  return changed;
}

export function renderOrdersPanel(container, state, playerId, callbacks = {}, options = {}) {
  if (!container || !state) return;
  const draft = getDraftBucket(options.uiState, state, 'deployment', playerId);
  if (!draft.armies) draft.armies = {};
  if (!draft.mercenaries) draft.mercenaries = { count: 0, destination: null };
  if (!Object.prototype.hasOwnProperty.call(draft.mercenaries, 'destination')) draft.mercenaries.destination = null;
  const alreadyLocked = state.allOrders?.[playerId] != null;
  const armyKeys = getPlayerArmyKeys(state, playerId);
  const player = getPlayer(state, playerId);
  const reserve = Math.max(0, Number(player?.gold) || 0);
  ensureDeploymentDraft(state, playerId, draft, armyKeys);
  const orderLocks = getActiveOrderLocks(options);
  applyOrderLocksToDraft(state, playerId, draft, orderLocks);
  ensureCoupChoices(state, playerId, draft, orderLocks?.ok && orderLocks.candidateId != null ? Number(orderLocks.candidateId) : null);
  const totals = getDeploymentTotals(state, playerId, draft, armyKeys, reserve);
  const readiness = getDeploymentReadiness(state, playerId, draft, armyKeys);
  const candidateLockedId = orderLocks?.ok && orderLocks.candidateId != null ? Number(orderLocks.candidateId) : null;
  const lockedDestinations = orderLocks?.ok ? (orderLocks.committedOfficeKeys || {}) : {};
  const deploymentPreview = renderDeploymentPreview(state, playerId, draft, armyKeys);
  const lockNotice = renderOrderLockNotice(state, orderLocks);
  const coupChoices = renderCoupChoices(state, playerId, draft, armyKeys, candidateLockedId);
  const lockHelp = getDeploymentLockHelp(totals, readiness);

  container.innerHTML = `
    <section class="phase-card orders-panel">
      <header class="orders-head">
        <h3>Deployment</h3>
        <div class="orders-budget${totals.overBudget ? ' over' : ''}" title="Mercenary cost, and the gold you can spend on them (your gold plus gold from dismissed troops)" data-orders-budget>
          <span class="orders-budget-label">Mercenaries</span>
          <span data-orders-merc-cost>${formatGoldHtml(totals.mercCost, { signed: false })}</span>
          <span class="orders-budget-of">of</span>
          <span data-orders-reserve>${formatGoldHtml(reserve + totals.unfundedGold, { signed: false })}</span>
        </div>
      </header>
      <p class="section-hint">Send each army to the Frontier to fight the invasion, or to Constantinople to back a claimant in the coup. Troops you do not field are dismissed and pay you ${formatGoldHtml(BALANCE.GOLD_PER_DISMISSED_TROOP)} each.</p>
      ${alreadyLocked ? '<div class="panel-empty">Deployment orders locked.</div>' : `
        ${lockNotice}
        ${renderInvasionCard(state)}
        ${deploymentPreview}
        <div class="army-card-stack">
          ${armyKeys.map((officeKey) => {
            const max = getArmyMaxTroops(state, playerId, officeKey);
            const current = draft.armies[officeKey];
            const currentFunded = normalizedFunded(current.funded, max) ?? getDefaultDeploymentFunding(max);
            const sliderValue = currentFunded;
            const idleGold = getDismissalGold(Math.max(0, max - currentFunded));
            const lockedDestination = lockedDestinations[officeKey] || null;
            const lockedLabel = lockedDestination === 'capital' ? 'Constantinople' : lockedDestination === 'frontier' ? 'Frontier' : null;
            const needsDestination = !isDeploymentDestination(current.destination);
            const fundingText = `${currentFunded} of ${max}`;
            const destinationText = needsDestination
              ? 'Choose destination'
              : current.destination === 'capital'
                ? 'Constantinople'
                : 'Frontier';
            const sourceCount = isStrategosDeploymentArmyKey(officeKey)
              ? getDeploymentArmySourceKeys(state, playerId, officeKey).length
              : 0;
            return `
              <article class="army-card${needsDestination ? ' unresolved' : ''}" data-army-card="${officeKey}">
                <header class="army-card-head">
                  <span class="army-card-title">${renderArmyOfficeBadge(state, officeKey, playerId)}</span>
                  <span class="army-card-count">${formatTroopsHtml(max, { label: 'Troops' })}</span>
                </header>
                ${sourceCount > 1 ? `<p class="army-card-sub">${sourceCount} Strategos commands combined.</p>` : ''}
                ${lockedLabel ? `<p class="army-card-sub order-locked-sub">Deal lock: must deploy to ${lockedLabel}.</p>` : ''}
                <div class="army-card-readiness">
                  <span class="readiness-pill ready">Fielded: ${escapeHtml(fundingText)}</span>
                  <span class="readiness-pill${needsDestination ? ' missing' : ' ready'}">Destination: ${escapeHtml(destinationText)}</span>
                </div>
                <label class="army-card-slider">
                  <span class="army-slider-label">Field</span>
                  <input type="range" min="0" max="${max}" value="${sliderValue}" data-army-funded="${officeKey}" ${lockedDestination ? 'disabled' : ''}>
                  <span class="army-slider-readout">
                    <span class="army-slider-num" data-funded-readout="${officeKey}">${currentFunded}</span>
                    <span class="army-slider-cost" data-funded-cost="${officeKey}" title="Gold from dismissed troops">${formatGoldHtml(idleGold, { signed: true, tone: 'income' })}</span>
                  </span>
                </label>
                <div class="segmented-control">
                  <button type="button" class="${current.destination === 'frontier' ? 'active' : ''}" data-army-destination="${officeKey}" data-destination="frontier" aria-pressed="${current.destination === 'frontier' ? 'true' : 'false'}" ${lockedDestination ? 'disabled' : ''}>Frontier</button>
                  <button type="button" class="${current.destination === 'capital' ? 'active' : ''}" data-army-destination="${officeKey}" data-destination="capital" aria-pressed="${current.destination === 'capital' ? 'true' : 'false'}" ${lockedDestination ? 'disabled' : ''}>Constantinople</button>
                </div>
              </article>
            `;
          }).join('')}
          <article class="army-card mercenary-card${(Number(draft.mercenaries.count) || 0) > 0 && !isDeploymentDestination(draft.mercenaries.destination) ? ' unresolved' : ''}">
            <header class="army-card-head">
              <span class="army-card-title">${renderIcon('troop')} Mercenaries</span>
              <span class="army-card-count">${formatMercenariesHtml(draft.mercenaries.count || 0)}</span>
            </header>
            <p class="army-card-sub">They cost the rising price: ${escapeHtml(describeRisingPrices())}</p>
            <div class="army-card-readiness">
              <span class="readiness-pill${totals.overBudget ? ' missing' : ' ready'}">Gold: ${totals.overBudget ? 'Too expensive' : 'Affordable'}</span>
              <span class="readiness-pill${(Number(draft.mercenaries.count) || 0) > 0 && !isDeploymentDestination(draft.mercenaries.destination) ? ' missing' : ' ready'}">Destination: ${(Number(draft.mercenaries.count) || 0) > 0 ? (draft.mercenaries.destination === 'capital' ? 'Constantinople' : draft.mercenaries.destination === 'frontier' ? 'Frontier' : 'Choose destination') : 'None hired'}</span>
            </div>
            <label class="army-card-slider">
              <span class="army-slider-label">Hire</span>
              <input type="range" min="0" max="${getBalance(state).MAX_MERCENARIES}" value="${draft.mercenaries.count || 0}" data-mercenary-count>
              <span class="army-slider-readout">
                <span class="army-slider-num" data-mercenary-num>${draft.mercenaries.count || 0}</span>
                <span class="army-slider-cost" data-mercenary-cost>${formatGoldHtml(-totals.mercCost, { tone: 'upkeep' })}</span>
              </span>
            </label>
            <div class="segmented-control">
              <button type="button" class="${draft.mercenaries.destination === 'frontier' ? 'active' : ''}" data-mercenary-destination="frontier" aria-pressed="${draft.mercenaries.destination === 'frontier' ? 'true' : 'false'}">Frontier</button>
              <button type="button" class="${draft.mercenaries.destination === 'capital' ? 'active' : ''}" data-mercenary-destination="capital" aria-pressed="${draft.mercenaries.destination === 'capital' ? 'true' : 'false'}">Constantinople</button>
            </div>
          </article>
        </div>

        <div class="candidate-section coup-section" data-coup-section>
          <div class="candidate-section-head">
            ${renderPickerStep('★', 'Coup: who do you back for the throne?')}
          </div>
          ${coupChoices}
        </div>

        <div class="panel-actions action-priority">
          <p class="deployment-lock-help${readiness.ready && !totals.overBudget ? ' ready' : ''}" data-deployment-lock-help>${escapeHtml(lockHelp)}</p>
          <button type="button" class="btn-primary btn-commit" data-action="lock-orders" ${totals.overBudget || !readiness.ready ? 'disabled' : ''}>${totals.overBudget ? 'Need More Gold' : readiness.ready ? 'Lock Deployment' : 'Finish Deployment'}</button>
        </div>
      `}
    </section>
  `;

  const rerender = () => renderOrdersPanel(container, state, playerId, callbacks, options);
  const updateBudgetReadout = () => {
    const nextTotals = getDeploymentTotals(state, playerId, draft, armyKeys, reserve);
    const nextReadiness = getDeploymentReadiness(state, playerId, draft, armyKeys);
    const budget = container.querySelector('[data-orders-budget]');
    budget?.classList.toggle('over', nextTotals.overBudget);
    const mercCost = container.querySelector('[data-orders-merc-cost]');
    if (mercCost) mercCost.innerHTML = formatGoldHtml(nextTotals.mercCost, { signed: false });
    const reserveEl = container.querySelector('[data-orders-reserve]');
    if (reserveEl) reserveEl.innerHTML = formatGoldHtml(reserve + nextTotals.unfundedGold, { signed: false });
    const lockButton = container.querySelector('[data-action="lock-orders"]');
    if (lockButton) {
      lockButton.disabled = nextTotals.overBudget || !nextReadiness.ready;
      lockButton.textContent = nextTotals.overBudget ? 'Need More Gold' : nextReadiness.ready ? 'Lock Deployment' : 'Finish Deployment';
    }
    const lockHelpEl = container.querySelector('[data-deployment-lock-help]');
    if (lockHelpEl) {
      lockHelpEl.textContent = getDeploymentLockHelp(nextTotals, nextReadiness);
      lockHelpEl.classList.toggle('ready', nextReadiness.ready && !nextTotals.overBudget);
    }
    const preview = container.querySelector('[data-deployment-preview]');
    if (preview) preview.outerHTML = renderDeploymentPreview(state, playerId, draft, armyKeys);
    const own = getOwnCoupSupport(state, playerId, draft, armyKeys);
    const summary = container.querySelector('[data-coup-summary]');
    if (summary) summary.textContent = renderCoupSummary(state, playerId, draft, own);
    container.querySelectorAll('[data-coup-row]').forEach((row) => {
      const gain = row.querySelector('.coup-choice-gain');
      const candidateId = Number(row.dataset.coupRow);
      if (gain && (draft.coupChoices || []).includes(candidateId)) gain.innerHTML = formatSupportHtml(own.byCandidate[candidateId] || 0, { signed: true });
    });
  };

  const commitArmyFunding = (input) => {
    const officeKey = input.dataset.armyFunded;
    if (!draft.armies[officeKey]) draft.armies[officeKey] = {};
    const next = Number(input.value) || 0;
    draft.armies[officeKey].funded = next;
    const max = getArmyMaxTroops(state, playerId, officeKey);
    const readout = container.querySelector(`[data-funded-readout="${officeKey}"]`);
    if (readout) readout.textContent = next;
    const costEl = container.querySelector(`[data-funded-cost="${officeKey}"]`);
    if (costEl) costEl.innerHTML = formatGoldHtml(getDismissalGold(Math.max(0, max - next)), { signed: true, tone: 'income' });
    updateBudgetReadout();
  };
  container.querySelectorAll('[data-army-funded]').forEach((input) => {
    input.addEventListener('pointerdown', () => commitArmyFunding(input));
    input.addEventListener('keydown', () => commitArmyFunding(input));
    input.addEventListener('input', () => commitArmyFunding(input));
    input.addEventListener('change', rerender);
  });
  container.querySelectorAll('[data-army-destination]').forEach((button) => {
    button.addEventListener('click', () => {
      const officeKey = button.dataset.armyDestination;
      if (!draft.armies[officeKey]) draft.armies[officeKey] = {};
      draft.armies[officeKey].destination = button.dataset.destination;
      rerender();
    });
  });
  container.querySelector('[data-mercenary-count]')?.addEventListener('input', (event) => {
    draft.mercenaries.count = Number(event.target.value) || 0;
    const cost = container.querySelector('[data-mercenary-cost]');
    if (cost) cost.innerHTML = formatGoldHtml(-getMercenaryHireCost(0, draft.mercenaries.count), { tone: 'upkeep' });
    const num = container.querySelector('[data-mercenary-num]');
    if (num) num.textContent = String(draft.mercenaries.count);
    updateBudgetReadout();
  });
  container.querySelector('[data-mercenary-count]')?.addEventListener('change', rerender);
  container.querySelectorAll('[data-mercenary-destination]').forEach((button) => {
    button.addEventListener('click', () => {
      draft.mercenaries.destination = button.dataset.mercenaryDestination;
      rerender();
    });
  });
  container.querySelectorAll('[data-coup-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      const candidateId = Number(button.dataset.coupCandidate);
      const index = Number(button.dataset.coupChoice);
      if (toggleCoupChoice(state, draft, candidateId, index, candidateLockedId)) rerender();
    });
  });
  bindSelectAction(container, '[data-action="lock-orders"]', () => {
    ensureDeploymentDraft(state, playerId, draft, armyKeys);
    ensureCoupChoices(state, playerId, draft, candidateLockedId);
    const armies = Object.fromEntries(armyKeys.map((officeKey) => {
      const max = getArmyMaxTroops(state, playerId, officeKey);
      return [officeKey, {
        ...draft.armies[officeKey],
        funded: normalizedFunded(draft.armies[officeKey]?.funded, max) ?? getDefaultDeploymentFunding(max),
      }];
    }));
    callbacks.lockOrders?.({
      armies,
      mercenaries: draft.mercenaries,
      coupChoices: draft.coupChoices.slice(),
    });
  });
}
