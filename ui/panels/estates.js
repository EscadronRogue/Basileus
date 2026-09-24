// ui/panels/estates.js - Estates panel: sealed bids on free land.

import { getAvailableLandBidGold, getLandBidCommitment, getMinimumLandBid, getPlayerLandBid } from '../../engine/actions.js';
import { getThemeLandPrice } from '../../engine/rules.js';
import { getFreeThemes } from '../../engine/state.js';
import { formatGoldHtml } from '../icons.js';
import { escapeHtml } from '../html.js';
import { renderProvinceBadge } from '../labels.js';
import { bindSelectAction, getDraftBucket } from './shared.js';

export function renderEstatesPanel(container, state, playerId, callbacks = {}, options = {}) {
  const freeThemes = getFreeThemes(state);
  const activeBidderId = Number(playerId);
  const draft = getDraftBucket(options.uiState, state, 'estates', playerId);
  if (!draft.bids) {
    draft.bids = {};
    freeThemes.forEach((theme) => {
      const ownBid = getPlayerLandBid(state, theme.id, activeBidderId);
      if (ownBid) draft.bids[theme.id] = Number(ownBid.amount) || 0;
    });
  }
  const spendableGold = getAvailableLandBidGold(state, activeBidderId) + getLandBidCommitment(state, activeBidderId);
  const draftCommitment = Object.values(draft.bids).reduce((sum, amount) => sum + (Number(amount) || 0), 0);
  const reserve = Math.max(0, spendableGold - draftCommitment);
  const ready = Boolean(state.estatesReady?.[playerId]);
  const readyCount = state.players.filter((entry) => Boolean(state.estatesReady?.[entry.id])).length;
  container.innerHTML = `
    <section class="phase-card estates-panel">
      <header class="estates-head">
        <h3>Buy Land</h3>
        <div class="estates-head-meta">
          <span class="estates-ready-count">${readyCount}/${state.players.length} ready</span>
          <span class="estates-reserve" title="Your unreserved gold">
            <span class="reserve-label">Gold available</span>
            ${formatGoldHtml(reserve)}
          </span>
        </div>
      </header>
      ${freeThemes.length ? `
        <div class="estate-grid">
          ${freeThemes.map((theme) => {
            const minimum = getMinimumLandBid(state, theme.id);
            const value = getThemeLandPrice(theme);
            const ownBid = getPlayerLandBid(state, theme.id, activeBidderId);
            const plannedAmount = Number(draft.bids[theme.id]) || 0;
            const committedElsewhere = draftCommitment - plannedAmount;
            const maxBid = Math.max(0, spendableGold - committedElsewhere);
            const cannotAfford = maxBid < minimum;
            const inputValue = plannedAmount || minimum;
            const bidButtonLabel = ownBid ? 'Update Bid' : plannedAmount ? 'Update Plan' : 'Plan Bid';
            return `
              <article class="estate-card${cannotAfford ? ' disabled' : ''}${plannedAmount ? ' selected' : ''}" data-estate="${theme.id}" data-map-province="${theme.id}">
                <div class="estate-card-province">
                  ${renderProvinceBadge(state, theme, { showValues: true })}
                </div>
                <dl class="estate-card-stats">
                  <div>
                    <dt>Estate value</dt>
                    <dd>${formatGoldHtml(value)}</dd>
                  </div>
                  <div>
                    <dt>Minimum bid</dt>
                    <dd>${formatGoldHtml(minimum)}</dd>
                  </div>
                </dl>
                ${plannedAmount ? `
                  <div class="estate-current-bid owned sealed">
                    <span class="estate-current-label">Your bid</span>
                    <span class="estate-current-bidder">Not locked yet</span>
                    <span class="estate-current-amount">${formatGoldHtml(plannedAmount)}</span>
                  </div>
                ` : ''}
                <div class="estate-card-bid">
                  <div class="estate-bid-stepper">
                    <button type="button" class="estate-bid-step" data-estate-bid-step="${theme.id}" data-delta="-1" aria-label="Lower bid for ${escapeHtml(theme.name)}" ${cannotAfford ? 'disabled' : ''}>-</button>
                    <input type="number" min="${minimum}" max="${maxBid}" step="1" inputmode="numeric" value="${inputValue}" data-estate-bid="${theme.id}" aria-label="Bid for ${escapeHtml(theme.name)}" ${cannotAfford ? 'disabled' : ''}>
                    <button type="button" class="estate-bid-step" data-estate-bid-step="${theme.id}" data-delta="1" aria-label="Raise bid for ${escapeHtml(theme.name)}" ${cannotAfford ? 'disabled' : ''}>+</button>
                  </div>
                  <button type="button" class="btn-primary estate-bid-btn" data-action="bid-estate" data-theme="${theme.id}" ${cannotAfford ? 'disabled' : ''}>${bidButtonLabel}</button>
                </div>
                ${cannotAfford ? `<div class="estate-card-warn">Need ${formatGoldHtml(minimum)} of unreserved gold to bid.</div>` : ''}
              </article>
            `;
          }).join('')}
        </div>
      ` : '<div class="panel-empty">No free citizen land this round.</div>'}
      <div class="appointment-preview estate-plan-preview">
        ${draftCommitment ? `${formatGoldHtml(draftCommitment)} planned in sealed bids. Lock to commit, or reset to restore your current bids.` : 'Plan sealed bids first. Nothing is committed until you lock.'}
      </div>
      <div class="panel-actions action-priority">
        <button type="button" class="btn-secondary btn-reset" data-action="reset-estate-plan" ${draftCommitment ? '' : 'disabled'}>Reset Bids</button>
        <button type="button" class="${ready ? 'btn-secondary btn-reset' : 'btn-primary btn-commit'}" data-action="confirm-estates">${ready ? 'Keep Editing Bids' : 'Lock Bids'}</button>
      </div>
    </section>
  `;
  container.querySelectorAll('[data-estate-bid-step]').forEach((button) => {
    button.addEventListener('click', () => {
      const themeId = button.dataset.estateBidStep;
      const input = container.querySelector(`[data-estate-bid="${themeId}"]`);
      if (!input) return;
      const min = Number(input.min) || 0;
      const max = Number(input.max) || min;
      const delta = Number(button.dataset.delta) || 0;
      const current = Number(input.value) || min;
      input.value = String(Math.max(min, Math.min(max, current + delta)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
  container.querySelectorAll('[data-action="bid-estate"]').forEach((button) => {
    button.addEventListener('click', () => {
      const themeId = button.dataset.theme;
      container.querySelector(`[data-estate="${themeId}"]`)?.classList.add('is-pressing');
      draft.bids[themeId] = Number(container.querySelector(`[data-estate-bid="${themeId}"]`)?.value) || 0;
      renderEstatesPanel(container, state, playerId, callbacks, options);
    });
  });
  bindSelectAction(container, '[data-action="reset-estate-plan"]', () => {
    delete draft.bids;
    renderEstatesPanel(container, state, playerId, callbacks, options);
  });
  bindSelectAction(container, '[data-action="confirm-estates"]', () => {
    if (ready) {
      callbacks.confirmEstates?.();
      return;
    }
    const bids = Object.entries(draft.bids || {})
      .filter(([, amount]) => Number(amount) > 0)
      .map(([themeId, amount]) => ({ themeId, amount: Number(amount) }));
    callbacks.submitEstatePlan?.({ bids });
  });
}
