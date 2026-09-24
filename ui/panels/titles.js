// ui/panels/titles.js - Title Redistribution panel (the Basileus assigns the major offices).

import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../../data/titles.js';
import { validateMajorTitleAssignments } from '../../engine/actions.js';
import { getPlayer } from '../../engine/state.js';
import { escapeHtml } from '../html.js';
import { getPlayerStyleAttr, renderPlayerChip, renderTitleBadge } from '../labels.js';
import { bindSelectAction, getDraftBucket, playerDisplayLabel } from './shared.js';
import {
  bindWireDraftMotion,
  bindWireFocus,
  bindWireGeometry,
  renderCourtDraftWire,
  renderCourtWireLine,
} from './wires.js';

export function renderTitleRedistributionPanel(container, state, playerId, callbacks = {}, options = {}) {
  const isBasileus = playerId === state.basileusId;
  const draft = getDraftBucket(options.uiState, state, 'title-redist', playerId);
  const initial = options.assignments || {};
  if (!draft.assignments) draft.assignments = { ...initial };
  const titleEntries = Object.entries(MAJOR_TITLES);
  const titleKeys = titleEntries.map(([titleKey]) => titleKey);
  const eligible = state.players.filter((player) => player.id !== state.basileusId);
  const distribution = MAJOR_TITLE_DISTRIBUTION[state.players.length] || eligible.map(() => 1);
  const sortedDistribution = distribution.slice().sort((a, b) => b - a);
  const maxCopies = Math.max(1, ...sortedDistribution);
  const hasAssignment = (titleKey) => {
    const value = draft.assignments[titleKey];
    return value != null && value !== '' && Number.isInteger(Number(value));
  };
  const countAssignments = (skipTitleKey = null) => Object.entries(draft.assignments || {})
    .reduce((counts, [titleKey, assignedPlayerId]) => {
      if (titleKey === skipTitleKey) return counts;
      const assigned = Number(assignedPlayerId);
      if (!Number.isInteger(assigned)) return counts;
      counts[assigned] = (counts[assigned] || 0) + 1;
      return counts;
    }, {});
  const assignedCounts = countAssignments();
  const complete = titleKeys.every(hasAssignment);
  const validation = complete
    ? validateMajorTitleAssignments(state, state.basileusId, draft.assignments)
    : { ok: false, reason: 'Assign every major office before confirming.' };
  const canConfirm = isBasileus && validation.ok;
  const rerender = () => renderTitleRedistributionPanel(container, state, playerId, callbacks, options);
  const wireTitleKey = titleKeys.includes(draft.titleWireStart?.titleKey) ? draft.titleWireStart.titleKey : null;
  const selectedTitleKey = wireTitleKey || (titleKeys.includes(draft.selectedTitleKey) ? draft.selectedTitleKey : null);
  const selectedPlayerId = Number.isInteger(Number(draft.selectedTitlePlayerId))
    ? Number(draft.selectedTitlePlayerId)
    : null;
  const selectedCopyIndex = Number.isInteger(Number(draft.selectedTitleCopyIndex))
    ? Number(draft.selectedTitleCopyIndex)
    : null;
  const ruleText = sortedDistribution.length
    ? `Final spread must be ${sortedDistribution.join('-')} among the non-Basileus players.`
    : 'Assign each office to a non-Basileus player.';
  const tokenKey = (playerIdForToken, copyIndex) => `${playerIdForToken}:${copyIndex}`;
  const usedByTitle = {};
  const usedSoFar = {};
  titleEntries.forEach(([titleKey]) => {
    if (!hasAssignment(titleKey)) return;
    const assignedPlayerId = Number(draft.assignments[titleKey]);
    const copyIndex = usedSoFar[assignedPlayerId] || 0;
    usedByTitle[titleKey] = copyIndex;
    usedSoFar[assignedPlayerId] = copyIndex + 1;
  });
  const playerTokens = eligible.flatMap((player) => (
    Array.from({ length: maxCopies }, (_, copyIndex) => ({
      player,
      copyIndex,
      available: copyIndex >= (assignedCounts[player.id] || 0),
    }))
  ));
  const tokenRowByKey = new Map(playerTokens.map((token, index) => [tokenKey(token.player.id, token.copyIndex), index]));
  const titleRowByKey = new Map();
  const usedTitleRows = new Set();
  titleEntries.forEach(([titleKey], index) => {
    if (hasAssignment(titleKey)) {
      const assignedPlayerId = Number(draft.assignments[titleKey]);
      const copyIndex = usedByTitle[titleKey];
      const tokenRow = tokenRowByKey.get(tokenKey(assignedPlayerId, copyIndex));
      if (tokenRow != null) {
        titleRowByKey.set(titleKey, tokenRow);
        usedTitleRows.add(tokenRow);
        return;
      }
    }
    const nextRow = Array.from({ length: Math.max(titleEntries.length, playerTokens.length, 1) }, (_, row) => row)
      .find((row) => !usedTitleRows.has(row)) ?? index;
    titleRowByKey.set(titleKey, nextRow);
    usedTitleRows.add(nextRow);
  });
  const selectedToken = playerTokens.find((token) => (
    token.available
    && token.player.id === selectedPlayerId
    && token.copyIndex === selectedCopyIndex
  )) || null;
  const rows = Math.max(titleEntries.length, playerTokens.length, Math.max(-1, ...titleRowByKey.values()) + 1, 1);
  const height = rows * 58;
  const selectedTitle = selectedTitleKey ? MAJOR_TITLES[selectedTitleKey] : null;
  const titleLineHtml = titleEntries.map(([titleKey, title], titleIndex) => {
    if (!hasAssignment(titleKey)) return '';
    const assignedPlayerId = Number(draft.assignments[titleKey]);
    const assignedPlayer = getPlayer(state, assignedPlayerId);
    const copyIndex = usedByTitle[titleKey];
    const tokenRow = tokenRowByKey.get(tokenKey(assignedPlayerId, copyIndex));
    if (!assignedPlayer || tokenRow == null) return '';
    return renderCourtWireLine({ key: titleKey, label: title.name }, titleRowByKey.get(titleKey) ?? titleIndex, tokenRow, assignedPlayer, {
      kind: 'bound',
      lineKey: titleKey,
      toCopyIndex: copyIndex,
      label: `Cut ${title.name} from ${playerDisplayLabel(assignedPlayer)}`,
      actionAttrs: `data-title-clear="${escapeHtml(titleKey)}" aria-label="${escapeHtml(`Cut ${title.name} from ${playerDisplayLabel(assignedPlayer)}`)}"`,
    });
  }).join('');
  const draftLineHtml = wireTitleKey && selectedTitle && !hasAssignment(wireTitleKey)
    ? renderCourtDraftWire({ key: wireTitleKey, label: selectedTitle.name }, titleRowByKey.get(wireTitleKey) ?? titleKeys.indexOf(wireTitleKey))
    : '';
  const selectedSummary = wireTitleKey && selectedTitle
    ? `Guide the rope from ${selectedTitle.name} to a dynasty circle.`
    : selectedTitleKey
      ? hasAssignment(selectedTitleKey)
        ? `Click the tied rope to cut ${MAJOR_TITLES[selectedTitleKey].name}.`
        : 'Click the office circle, then a dynasty circle.'
      : 'Click an office circle, then a dynasty circle.';

  container.innerHTML = `
    <section class="phase-card title-redistribution-panel">
      <h3>Assign Major Offices</h3>
      <p class="section-hint">${isBasileus ? `Tie each office to a dynasty. ${ruleText}` : 'Waiting for the Basileus to assign the major offices.'}</p>
      <section class="court-link-section court-wire-section title-redist-wire-section">
        <header class="court-link-section-head">
          <span class="appointment-section-title">Links</span>
          <span class="court-link-section-note">Click an office circle, guide the rope, then click a dynasty circle. Click a tied rope to cut it.</span>
        </header>
        <div class="title-redist-board title-redist-wire-board court-wire-board${wireTitleKey ? ' tying' : ''}" style="--wire-rows: ${rows};" data-court-wire-board>
          <div class="court-wire-col-head seats">Offices</div>
          <div class="court-wire-col-head players">Dynasties</div>
          <div class="court-wire-seats title-redist-offices">
            ${titleEntries.map(([titleKey, title], index) => {
          const assigned = hasAssignment(titleKey) ? Number(draft.assignments[titleKey]) : null;
          const assignedPlayer = Number.isInteger(assigned) ? getPlayer(state, assigned) : null;
          const isSelected = selectedTitleKey === titleKey;
          return `
            <button type="button"
              class="court-wire-seat title-redist-slot${isSelected ? ' selected' : ''}${isBasileus && !assignedPlayer ? ' can-fill' : ''}${assignedPlayer ? ' filled' : ''}"
              style="--wire-row: ${(titleRowByKey.get(titleKey) ?? index) + 1}; ${assignedPlayer ? getPlayerStyleAttr(state, assignedPlayer.id) : ''}"
              data-title-slot="${titleKey}"
              data-wire-row-key="${escapeHtml(titleKey)}"
              tabindex="${isBasileus ? '0' : '-1'}"
              aria-pressed="${isSelected ? 'true' : 'false'}">
              <span class="court-wire-seat-copy title-redist-office-copy">
                ${renderTitleBadge(state, titleKey, { holderId: assignedPlayer?.id, compact: true, label: title.name })}
                <span class="title-redist-slot-state">${assignedPlayer ? 'Tied' : isSelected ? 'Selected' : 'Open'}</span>
              </span>
              <span class="court-wire-socket court-wire-seat-socket" ${isBasileus && !assignedPlayer ? `data-title-wire-start="${escapeHtml(titleKey)}"` : ''} aria-hidden="true"></span>
            </button>
          `;
        }).join('')}
          </div>
          <svg class="court-wire-svg title-redist-wire-svg" viewBox="0 0 1000 ${height}" preserveAspectRatio="none" aria-hidden="false">
            ${titleLineHtml}
            ${draftLineHtml}
          </svg>
          <div class="court-wire-players title-redist-token-grid">
            ${playerTokens.map((token, index) => {
            const selected = selectedToken?.player.id === token.player.id && selectedToken?.copyIndex === token.copyIndex;
            return `
              <button type="button"
                class="court-wire-player title-redist-player-token${selected ? ' selected' : ''}${token.available ? '' : ' used'}"
                style="--wire-row: ${index + 1}; ${getPlayerStyleAttr(state, token.player.id)}"
                data-wire-player-row="${token.player.id}"
                data-wire-player-copy="${token.copyIndex}"
                data-title-token-player="${token.player.id}"
                data-title-token-copy="${token.copyIndex}"
                draggable="${isBasileus && token.available ? 'true' : 'false'}"
                ${isBasileus && !token.available ? 'disabled' : ''}
                aria-pressed="${selected ? 'true' : 'false'}">
                <span class="court-wire-socket court-wire-player-socket" ${isBasileus && token.available ? `data-title-wire-finish="${token.player.id}" data-title-wire-copy="${token.copyIndex}"` : ''} aria-hidden="true"></span>
                ${renderPlayerChip(state, token.player)}
                <span class="candidate-tag">${token.available ? `Copy ${token.copyIndex + 1}` : 'Tied'}</span>
              </button>
            `;
          }).join('')}
          </div>
        </div>
      </section>
      ${isBasileus ? `<div class="appointment-preview title-redist-link-preview">${escapeHtml(selectedSummary)}</div>` : ''}
      <p class="form-error" role="alert" data-role="title-reassignment-error">${complete && !validation.ok ? escapeHtml(validation.reason || '') : ''}</p>
      <div class="panel-actions action-priority">
        <button type="button" class="btn-primary btn-commit" data-action="confirm-title-redistribution" ${canConfirm ? '' : 'disabled'}>${validation.ok ? 'Lock Offices' : 'Finish Office Slots'}</button>
      </div>
    </section>
  `;

  bindWireGeometry(container);
  bindWireDraftMotion(container);
  bindWireFocus(container);

  if (isBasileus) {
    const assignTitle = (titleKey, nextPlayerId) => {
      if (!titleKeys.includes(titleKey) || !Number.isInteger(nextPlayerId)) return false;
      if (hasAssignment(titleKey)) return false;
      const nextCounts = countAssignments(titleKey);
      if ((nextCounts[nextPlayerId] || 0) >= maxCopies) return false;
      draft.assignments[titleKey] = nextPlayerId;
      const nextAssignedCounts = countAssignments();
      const remainingAfterAssign = maxCopies - ((nextAssignedCounts[nextPlayerId] || 0));
      if (draft.selectedTitlePlayerId === nextPlayerId && remainingAfterAssign <= 0) {
        delete draft.selectedTitlePlayerId;
        delete draft.selectedTitleCopyIndex;
      } else if (draft.selectedTitlePlayerId === nextPlayerId) {
        draft.selectedTitleCopyIndex = nextAssignedCounts[nextPlayerId] || 0;
      }
      const nextOpenTitle = titleKeys.find((key) => !hasAssignment(key));
      if (nextOpenTitle) draft.selectedTitleKey = nextOpenTitle;
      else delete draft.selectedTitleKey;
      return true;
    };

    container.querySelectorAll('[data-title-wire-start]').forEach((socket) => {
      socket.addEventListener('click', (event) => {
        event.stopPropagation();
        const titleKey = socket.dataset.titleWireStart;
        if (!titleKeys.includes(titleKey) || hasAssignment(titleKey)) return;
        draft.titleWireStart = { titleKey };
        draft.selectedTitleKey = titleKey;
        delete draft.selectedTitlePlayerId;
        delete draft.selectedTitleCopyIndex;
        rerender();
      });
    });

    container.querySelectorAll('[data-title-wire-finish]').forEach((socket) => {
      socket.addEventListener('click', (event) => {
        event.stopPropagation();
        const titleKey = draft.titleWireStart?.titleKey;
        const nextPlayerId = Number(socket.dataset.titleWireFinish);
        if (!titleKeys.includes(titleKey) || !Number.isInteger(nextPlayerId)) return;
        if (assignTitle(titleKey, nextPlayerId)) {
          delete draft.titleWireStart;
          rerender();
        }
      });
    });

    container.querySelectorAll('[data-title-token-player]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        draft.selectedTitlePlayerId = Number(button.dataset.titleTokenPlayer);
        draft.selectedTitleCopyIndex = Number(button.dataset.titleTokenCopy);
        if (!titleKeys.includes(draft.selectedTitleKey) || hasAssignment(draft.selectedTitleKey)) {
          draft.selectedTitleKey = titleKeys.find((key) => !hasAssignment(key)) || draft.selectedTitleKey;
        }
        rerender();
      });
      button.addEventListener('dragstart', (event) => {
        if (button.disabled) return;
        event.dataTransfer?.setData('text/plain', button.dataset.titleTokenPlayer || '');
        event.dataTransfer?.setData('application/x-title-player', button.dataset.titleTokenPlayer || '');
      });
    });

    container.querySelectorAll('[data-title-slot]').forEach((slot) => {
      slot.addEventListener('click', (event) => {
        if (event.target?.closest?.('[data-title-clear]')) return;
        draft.selectedTitleKey = slot.dataset.titleSlot;
        rerender();
      });
      slot.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        draft.selectedTitleKey = slot.dataset.titleSlot;
        rerender();
      });
      slot.addEventListener('dragover', (event) => {
        event.preventDefault();
      });
      slot.addEventListener('drop', (event) => {
        event.preventDefault();
        const raw = event.dataTransfer?.getData('application/x-title-player') || event.dataTransfer?.getData('text/plain');
        if (assignTitle(slot.dataset.titleSlot, Number(raw))) rerender();
      });
    });

    container.querySelectorAll('[data-title-tie]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        if (node.getAttribute('aria-disabled') === 'true') return;
        if (assignTitle(node.dataset.titleTie, Number(node.dataset.titleTiePlayer))) rerender();
      });
    });

    container.querySelectorAll('[data-title-clear]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        delete draft.assignments[button.dataset.titleClear];
        delete draft.titleWireStart;
        draft.selectedTitleKey = button.dataset.titleClear;
        rerender();
      });
    });
  }

  bindSelectAction(container, '[data-action="confirm-title-redistribution"]', () => {
    callbacks.confirmTitleRedistribution?.({ ...draft.assignments });
  });
}
