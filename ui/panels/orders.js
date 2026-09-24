// ui/panels/orders.js - Deployment panel: funding, destinations, mercenaries, and claimant ranking.

import { getMercenaryHireCost } from '../../engine/rules.js';
import { getPlayer } from '../../engine/state.js';
import { getPlayerCapitalSupport } from '../../engine/capitalSupport.js';
import {
  getCoupRankWeight,
  getPreferredCoupCandidate,
  normalizeCoupRanking,
  normalizeCoupSupport,
  placeCoupCandidateAfterPlayer,
} from '../../engine/coup.js';
import {
  getDefaultDeploymentFunding,
  getDeploymentArmySourceKeys,
  getDeploymentArmyTroopEntry,
  getDeploymentArmyTroopTotal,
  getPlayerDeploymentArmyKeys,
  isStrategosDeploymentArmyKey,
} from '../../engine/deployment.js';
import { formatGoldHtml, formatMercenariesHtml, formatTroopsHtml, renderIcon, renderValue } from '../icons.js';
import { escapeHtml } from '../html.js';
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

function ensureDeploymentRanking(state, playerId, draft, preferredCandidateId = null) {
  draft.ranking = preferredCandidateId == null
    ? normalizeCoupRanking(state, playerId, draft.ranking, draft.candidate)
    : placeCoupCandidateAfterPlayer(state, playerId, draft.ranking, preferredCandidateId);
  draft.candidateSupport = normalizeCoupSupport(state, draft.candidateSupport, preferredCandidateId);
  draft.candidate = getPreferredCoupCandidate(state, playerId, draft);
  return draft.ranking;
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
  const ranking = ensureDeploymentRanking(state, playerId, draft);
  if (ranking.length !== state.players.length) missing.push('ranking');
  return { ready: missing.length === 0, missing };
}

function getDeploymentLockHelp(totals, readiness) {
  if (totals?.overBudget) return 'Mercenaries cost more gold than you have after idle troop income.';
  if (readiness?.ready) return 'Every army has a destination. Funding is already set and can be adjusted before lock.';
  const missing = Array.isArray(readiness?.missing) ? readiness.missing : [];
  const needsDestination = missing.some((entry) => String(entry).endsWith(':destination'));
  const needsRanking = missing.includes('ranking');
  const parts = [];
  if (needsDestination) parts.push('choose Frontier or Capital for each deployed force');
  if (needsRanking) parts.push('finish the coup ranking');
  return `To lock deployment, ${parts.join(', ')}.`;
}

function getActiveOrderLocks(options = {}) {
  const locks = options.privateData?.orderLocks;
  return locks && typeof locks === 'object' ? locks : null;
}

function applyOrderLocksToDraft(state, playerId, draft, orderLocks) {
  if (!orderLocks?.ok) return;
  if (orderLocks.candidateId != null) {
    draft.ranking = placeCoupCandidateAfterPlayer(state, playerId, draft.ranking, Number(orderLocks.candidateId));
    draft.candidateSupport = normalizeCoupSupport(state, draft.candidateSupport, Number(orderLocks.candidateId));
    draft.candidate = Number(orderLocks.candidateId);
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
    const pool = getDeploymentArmyTroopEntry(state, playerId, officeKey);
    const totalTroops = pool.normal + pool.capitalLocked;
    const order = draft.armies?.[officeKey] || {};
    const funded = normalizedFunded(order.funded, totalTroops) ?? getDefaultDeploymentFunding(totalTroops);
    const fundedLocked = Math.min(pool.capitalLocked, funded);
    const fundedNormal = Math.min(pool.normal, Math.max(0, funded - fundedLocked));
    const destination = isDeploymentDestination(order.destination) ? order.destination : null;

    capitalTroops += fundedLocked + (destination === 'capital' ? fundedNormal : 0);
    frontierTroops += destination === 'frontier' ? fundedNormal : 0;
    unfundedTroops += Math.max(0, totalTroops - funded);
  }

  const mercenaryCount = Math.max(0, Number(draft.mercenaries?.count) || 0);
  if (draft.mercenaries?.destination === 'capital') capitalTroops += mercenaryCount;
  else if (draft.mercenaries?.destination === 'frontier') frontierTroops += mercenaryCount;

  return {
    capitalTroops,
    passiveCapitalSupport: getPlayerCapitalSupport(state, playerId),
    frontierTroops,
    unfundedTroops,
  };
}

function getDeploymentTotals(state, playerId, draft, armyKeys, reserve) {
  const unfundedGold = armyKeys.reduce((sum, key) => {
    const max = getArmyMaxTroops(state, playerId, key);
    const funded = normalizedFunded(draft.armies[key]?.funded, max) ?? getDefaultDeploymentFunding(max);
    return sum + Math.max(0, max - funded);
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
    rows.push(`Coup rank: ${renderPlayerChip(state, candidate, `Player ${Number(orderLocks.candidateId) + 1}`, { variant: 'light' })} stays pledged`);
  }
  for (const office of orderLocks.officeSelections || []) {
    const destination = office.destination === 'capital' ? 'Capital' : 'Frontier';
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
  const ranking = ensureDeploymentRanking(state, playerId, draft);
  const candidateSupport = normalizeCoupSupport(state, draft.candidateSupport);
  const topSupportedId = ranking.find((candidateId) => candidateSupport[candidateId] !== false);
  const topPreference = getPlayer(state, topSupportedId ?? playerId);
  const preferenceLabel = topPreference ? renderPlayerChip(state, topPreference, '', { variant: 'light' }) : 'Rank claimants';
  return `
    <div class="deployment-preview" data-deployment-preview>
      <div class="deployment-preview-row">
        <span class="deployment-preview-label">Capital troops</span>
        <span class="deployment-preview-value">${formatTroopsHtml(breakdown.capitalTroops)} through ranking</span>
      </div>
      <div class="deployment-preview-row">
        <span class="deployment-preview-label">Passive support</span>
        <span class="deployment-preview-value">${renderValue('troop', breakdown.passiveCapitalSupport, { signed: true, displayValue: breakdown.passiveCapitalSupport })}</span>
      </div>
      <div class="deployment-preview-row">
        <span class="deployment-preview-label">Frontier</span>
        <span class="deployment-preview-value">${formatTroopsHtml(breakdown.frontierTroops)}</span>
      </div>
      <div class="deployment-preview-row">
        <span class="deployment-preview-label">Idle payout</span>
        <span class="deployment-preview-value">${formatGoldHtml(breakdown.unfundedTroops, { signed: true, tone: 'income' })}</span>
      </div>
      <p class="deployment-preview-note">
        ${breakdown.capitalTroops > 0
          ? `Your strongest active preference is ${preferenceLabel}.`
          : 'No funded troops or mercenaries are entering the capital ranking.'}
      </p>
    </div>
  `;
}

function renderCandidateRanking(state, playerId, draft, lockedCandidateId = null) {
  const ranking = ensureDeploymentRanking(state, playerId, draft, lockedCandidateId);
  const candidateSupport = normalizeCoupSupport(state, draft.candidateSupport, lockedCandidateId);
  const playerCount = state.players.length;
  const hasDragging = Number.isInteger(Number(draft.draggedCandidateId));
  return `
    <div class="candidate-rank-list${hasDragging ? ' drag-active' : ''}" data-candidate-rank-list role="list" aria-label="Coup claimant ranking">
      ${ranking.map((candidateId, index) => {
        const candidate = getPlayer(state, candidateId);
        const isSelf = candidateId === playerId;
        const isLockedCandidate = lockedCandidateId != null && candidateId === lockedCandidateId;
        const isDragging = Number(draft.draggedCandidateId) === Number(candidateId);
        const needsKeyboardFocus = Number(draft.keyboardFocusCandidateId) === Number(candidateId);
        const isEnabled = candidateSupport[candidateId] !== false;
        const weight = getCoupRankWeight(playerCount, index);
        const tag = isEnabled ? `${Math.round(weight * 100)}%` : '0%';
        const candidateName = playerDisplayLabel(candidate);
        const supportLabel = isEnabled ? `${Math.round(weight * 100)} percent support` : 'no support';
        const moveHint = isLockedCandidate ? 'Locked by deal.' : 'Use arrow keys to move this claimant.';
        return `
          <div class="candidate-row candidate-rank-row${isSelf ? ' self' : ''}${isLockedCandidate ? ' deal-locked' : ''}${isDragging ? ' dragging' : ''}${isEnabled ? '' : ' support-off'}"
            data-candidate-rank="${candidateId}"
            ${needsKeyboardFocus ? 'data-candidate-autofocus="true"' : ''}
            draggable="false"
            role="listitem"
            tabindex="${isLockedCandidate ? '-1' : '0'}"
            aria-label="${escapeHtml(`${candidateName}, rank ${index + 1} of ${playerCount}, ${supportLabel}. ${moveHint}`)}"
            style="${getPlayerStyleAttr(state, candidateId)}">
            <span class="candidate-drag-handle" aria-hidden="true"></span>
            <span class="candidate-rank-no">${index + 1}</span>
            <span class="candidate-crest">${playerInitial(candidate)}</span>
            <span class="candidate-name">${escapeHtml(candidateName)}</span>
            <span class="candidate-tag">${isLockedCandidate ? `Deal ${tag}` : tag}</span>
            <button type="button"
              class="candidate-support-toggle${isEnabled ? ' is-on' : ''}"
              data-candidate-support="${candidateId}"
              aria-pressed="${isEnabled ? 'true' : 'false'}"
              title="Toggle coup support"
              ${isLockedCandidate ? 'disabled' : ''}>
              <span aria-hidden="true"></span>
            </button>
          </div>
        `;
      }).join('')}
    </div>
  `;
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
  ensureDeploymentRanking(state, playerId, draft, orderLocks?.ok ? orderLocks.candidateId : null);
  const totals = getDeploymentTotals(state, playerId, draft, armyKeys, reserve);
  const readiness = getDeploymentReadiness(state, playerId, draft, armyKeys);
  const candidateLockedId = orderLocks?.ok && orderLocks.candidateId != null ? Number(orderLocks.candidateId) : null;
  const lockedDestinations = orderLocks?.ok ? (orderLocks.committedOfficeKeys || {}) : {};
  const deploymentPreview = renderDeploymentPreview(state, playerId, draft, armyKeys);
  const lockNotice = renderOrderLockNotice(state, orderLocks);
  const candidateRanking = renderCandidateRanking(state, playerId, draft, candidateLockedId);
  const lockHelp = getDeploymentLockHelp(totals, readiness);

  container.innerHTML = `
    <section class="phase-card orders-panel">
      <header class="orders-head">
        <h3>Send Armies</h3>
        <div class="orders-budget${totals.overBudget ? ' over' : ''}" title="Mercenary cost after idle troop income" data-orders-budget>
          <span class="orders-budget-label">Mercs</span>
          <span data-orders-merc-cost>${formatGoldHtml(totals.mercCost, { signed: false })}</span>
          <span class="orders-budget-of">of</span>
          <span data-orders-reserve>${formatGoldHtml(reserve + totals.unfundedGold, { signed: false })}</span>
        </div>
      </header>
      <p class="section-hint">Funding starts in the middle of each army. Choose Frontier or Capital for every deployed force, then adjust funding if you want.</p>
      ${alreadyLocked ? '<div class="panel-empty">Deployment orders locked.</div>' : `
        ${lockNotice}
        ${deploymentPreview}
        <div class="army-card-stack">
          ${armyKeys.map((officeKey) => {
            const entry = getDeploymentArmyTroopEntry(state, playerId, officeKey);
            const max = getArmyMaxTroops(state, playerId, officeKey);
            const current = draft.armies[officeKey];
            const currentFunded = normalizedFunded(current.funded, max) ?? getDefaultDeploymentFunding(max);
            const sliderValue = currentFunded;
            const idleGold = Math.max(0, max - currentFunded);
            const lockedDestination = lockedDestinations[officeKey] || null;
            const lockedLabel = lockedDestination === 'capital' ? 'Capital' : lockedDestination === 'frontier' ? 'Frontier' : null;
            const needsDestination = !isDeploymentDestination(current.destination);
            const fundingText = `${currentFunded}/${max} funded`;
            const destinationText = needsDestination
              ? 'Choose destination'
              : current.destination === 'capital'
                ? 'Capital'
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
                ${entry.capitalLocked ? `<p class="army-card-sub">${formatTroopsHtml(entry.capitalLocked)} capital locked</p>` : ''}
                ${lockedLabel ? `<p class="army-card-sub order-locked-sub">Deal lock: must deploy to ${lockedLabel}.</p>` : ''}
                <div class="army-card-readiness">
                  <span class="readiness-pill ready">Funding: ${escapeHtml(fundingText)}</span>
                  <span class="readiness-pill${needsDestination ? ' missing' : ' ready'}">Destination: ${escapeHtml(destinationText)}</span>
                </div>
                <label class="army-card-slider">
                  <span class="army-slider-label">Fund</span>
                  <input type="range" min="0" max="${max}" value="${sliderValue}" data-army-funded="${officeKey}" ${lockedDestination ? 'disabled' : ''}>
                  <span class="army-slider-readout">
                    <span class="army-slider-num" data-funded-readout="${officeKey}">${currentFunded}</span>
                    <span class="army-slider-cost" data-funded-cost="${officeKey}" title="Gold from idle troops">${formatGoldHtml(idleGold, { signed: true, tone: 'income' })}</span>
                  </span>
                </label>
                <div class="segmented-control">
                  <button type="button" class="${current.destination === 'frontier' ? 'active' : ''}" data-army-destination="${officeKey}" data-destination="frontier" aria-pressed="${current.destination === 'frontier' ? 'true' : 'false'}" ${lockedDestination ? 'disabled' : ''}>Frontier</button>
                  <button type="button" class="${current.destination === 'capital' ? 'active' : ''}" data-army-destination="${officeKey}" data-destination="capital" aria-pressed="${current.destination === 'capital' ? 'true' : 'false'}" ${lockedDestination ? 'disabled' : ''}>Capital</button>
                </div>
              </article>
            `;
          }).join('')}
          <article class="army-card mercenary-card${(Number(draft.mercenaries.count) || 0) > 0 && !isDeploymentDestination(draft.mercenaries.destination) ? ' unresolved' : ''}">
            <header class="army-card-head">
              <span class="army-card-title">${renderIcon('troop')} Mercenaries</span>
              <span class="army-card-count">${formatMercenariesHtml(draft.mercenaries.count || 0)}</span>
            </header>
            <p class="army-card-sub">Triangular cost: 1, +2, +3 …</p>
            <div class="army-card-readiness">
              <span class="readiness-pill${totals.overBudget ? ' missing' : ' ready'}">Gold: ${totals.overBudget ? 'Too expensive' : 'Affordable'}</span>
              <span class="readiness-pill${(Number(draft.mercenaries.count) || 0) > 0 && !isDeploymentDestination(draft.mercenaries.destination) ? ' missing' : ' ready'}">Destination: ${(Number(draft.mercenaries.count) || 0) > 0 ? (draft.mercenaries.destination === 'capital' ? 'Capital' : draft.mercenaries.destination === 'frontier' ? 'Frontier' : 'Choose destination') : 'No mercs'}</span>
            </div>
            <label class="army-card-slider">
              <span class="army-slider-label">Hire</span>
              <input type="range" min="0" max="10" value="${draft.mercenaries.count || 0}" data-mercenary-count>
              <span class="army-slider-readout">
                <span class="army-slider-num" data-mercenary-num>${draft.mercenaries.count || 0}</span>
                <span class="army-slider-cost" data-mercenary-cost>${formatGoldHtml(-totals.mercCost, { tone: 'upkeep' })}</span>
              </span>
            </label>
            <div class="segmented-control">
              <button type="button" class="${draft.mercenaries.destination === 'frontier' ? 'active' : ''}" data-mercenary-destination="frontier" aria-pressed="${draft.mercenaries.destination === 'frontier' ? 'true' : 'false'}">Frontier</button>
              <button type="button" class="${draft.mercenaries.destination === 'capital' ? 'active' : ''}" data-mercenary-destination="capital" aria-pressed="${draft.mercenaries.destination === 'capital' ? 'true' : 'false'}">Capital</button>
            </div>
          </article>
        </div>

        <div class="candidate-section">
          <div class="candidate-section-head">
            ${renderPickerStep('★', 'Rank claimants for the throne')}
          </div>
          ${candidateRanking}
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
    if (costEl) costEl.innerHTML = formatGoldHtml(Math.max(0, max - next), { signed: true, tone: 'income' });
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
  const getDraggedCandidateId = () => (
    Number.isInteger(Number(draft.draggedCandidateId)) ? Number(draft.draggedCandidateId) : null
  );
  const clearDraggedCandidateId = () => {
    delete draft.draggedCandidateId;
  };
  const moveRankedCandidateToIndex = (candidateId, insertIndex) => {
    if (!Number.isInteger(candidateId)) return false;
    if (candidateLockedId != null && candidateId === candidateLockedId) return false;
    const ranking = ensureDeploymentRanking(state, playerId, draft, candidateLockedId);
    const previousRanking = ranking.join(',');
    const moving = ranking.indexOf(candidateId);
    if (moving < 0) return false;
    const minIndex = 0;
    let targetIndex = Math.max(minIndex, Math.min(ranking.length, Number(insertIndex) || minIndex));
    const [entry] = ranking.splice(moving, 1);
    if (targetIndex > moving) targetIndex -= 1;
    targetIndex = Math.max(minIndex, Math.min(ranking.length, targetIndex));
    ranking.splice(targetIndex, 0, entry);
    draft.ranking = candidateLockedId == null
      ? normalizeCoupRanking(state, playerId, ranking)
      : placeCoupCandidateAfterPlayer(state, playerId, ranking, candidateLockedId);
    draft.candidate = getPreferredCoupCandidate(state, playerId, draft);
    return draft.ranking.join(',') !== previousRanking;
  };
  const getRankInsertIndexFromPointer = (clientY) => {
    const list = container.querySelector('[data-candidate-rank-list]');
    const rows = Array.from(list?.querySelectorAll?.('[data-candidate-rank]') || []);
    const draggedCandidateId = getDraggedCandidateId();
    const ranking = ensureDeploymentRanking(state, playerId, draft, candidateLockedId);
    for (const row of rows) {
      const rowCandidateId = Number(row.dataset.candidateRank);
      if (rowCandidateId === draggedCandidateId) continue;
      const rect = row.getBoundingClientRect?.();
      if (!rect) continue;
      if (clientY < rect.top + rect.height / 2) {
        const rowIndex = ranking.indexOf(rowCandidateId);
        if (rowIndex >= 0) return rowIndex;
      }
    }
    return ranking.length;
  };
  const moveDraggedCandidateNearPointer = (event) => {
    const draggedCandidateId = getDraggedCandidateId();
    if (draggedCandidateId == null) return false;
    const insertIndex = getRankInsertIndexFromPointer(Number(event.clientY) || 0);
    return moveRankedCandidateToIndex(draggedCandidateId, insertIndex);
  };
  container.querySelectorAll('[data-candidate-rank]').forEach((row) => {
    row.addEventListener('keydown', (event) => {
      const candidateId = Number(row.dataset.candidateRank);
      if (!Number.isInteger(candidateId)) return;
      if (candidateLockedId != null && candidateId === candidateLockedId) return;

      const ranking = ensureDeploymentRanking(state, playerId, draft, candidateLockedId);
      const currentIndex = ranking.indexOf(candidateId);
      if (currentIndex < 0) return;

      const nextIndex = {
        ArrowUp: currentIndex - 1,
        ArrowLeft: currentIndex - 1,
        ArrowDown: currentIndex + 2,
        ArrowRight: currentIndex + 2,
        Home: 0,
        End: ranking.length,
      }[event.key];
      if (nextIndex == null) return;

      event.preventDefault();
      if (moveRankedCandidateToIndex(candidateId, nextIndex)) {
        draft.keyboardFocusCandidateId = candidateId;
        rerender();
      }
    });

    row.addEventListener('pointerdown', (event) => {
      if (event.button != null && event.button !== 0) return;
      if (event.target?.closest?.('[data-candidate-support]')) return;
      const candidateId = Number(row.dataset.candidateRank);
      if (!Number.isInteger(candidateId)) return;
      if (candidateLockedId != null && candidateId === candidateLockedId) return;
      const ownerDocument = container.ownerDocument || globalThis.document;
      draft.draggedCandidateId = candidateId;
      row.classList.add('dragging');
      row.setPointerCapture?.(event.pointerId);
      event.preventDefault();

      const handlePointerMove = (moveEvent) => {
        moveEvent.preventDefault?.();
        if (moveDraggedCandidateNearPointer(moveEvent)) rerender();
      };
      const finishDrag = (upEvent) => {
        upEvent?.preventDefault?.();
        ownerDocument?.removeEventListener?.('pointermove', handlePointerMove);
        ownerDocument?.removeEventListener?.('pointerup', finishDrag);
        ownerDocument?.removeEventListener?.('pointercancel', finishDrag);
        clearDraggedCandidateId();
        rerender();
      };
      ownerDocument?.addEventListener?.('pointermove', handlePointerMove);
      ownerDocument?.addEventListener?.('pointerup', finishDrag, { once: true });
      ownerDocument?.addEventListener?.('pointercancel', finishDrag, { once: true });
    });
  });
  container.querySelectorAll('[data-candidate-support]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const candidateId = Number(button.dataset.candidateSupport);
      draft.candidateSupport = normalizeCoupSupport(state, draft.candidateSupport, candidateLockedId);
      draft.candidateSupport[candidateId] = button.getAttribute('aria-pressed') !== 'true';
      if (candidateLockedId != null) draft.candidateSupport[candidateLockedId] = true;
      draft.candidate = getPreferredCoupCandidate(state, playerId, draft);
      rerender();
    });
  });
  container.querySelector('[data-candidate-rank-list]')?.addEventListener('pointermove', (event) => {
    if (getDraggedCandidateId() == null) return;
    event.preventDefault();
    if (moveDraggedCandidateNearPointer(event)) rerender();
  });
  container.querySelector('[data-candidate-rank-list]')?.addEventListener('pointerleave', (event) => {
    if (getDraggedCandidateId() == null) return;
    if (moveDraggedCandidateNearPointer(event)) rerender();
  });
  container.querySelector('[data-candidate-rank-list]')?.addEventListener('pointerup', (event) => {
    if (getDraggedCandidateId() == null) return;
    event.preventDefault();
    if (moveDraggedCandidateNearPointer(event)) rerender();
    else {
      clearDraggedCandidateId();
      rerender();
    }
  });
  const autofocusCandidate = container.querySelector('[data-candidate-autofocus="true"]');
  if (autofocusCandidate) {
    delete draft.keyboardFocusCandidateId;
    const requestFrame = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    requestFrame(() => autofocusCandidate.focus?.());
  }
  bindSelectAction(container, '[data-action="lock-orders"]', () => {
    ensureDeploymentDraft(state, playerId, draft, armyKeys);
    ensureDeploymentRanking(state, playerId, draft, candidateLockedId);
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
      ranking: draft.ranking.slice(),
      candidateSupport: { ...normalizeCoupSupport(state, draft.candidateSupport, candidateLockedId) },
      candidate: draft.candidate == null ? null : Number(draft.candidate),
    });
  });
}
