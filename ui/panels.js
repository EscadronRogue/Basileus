// ui/panels.js - compact phase panels for the updated ruleset.
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';
import { readTroopEntry, runIncome } from '../engine/cascade.js';
import { applyCourtAction } from '../engine/commands.js';
import {
  getCourtPowerActionLimit,
  getCourtPowerActionCount,
  getCourtPowerAppointmentCount,
  getCourtPowerActionKinds,
  getCourtPowerActionKind,
  getCourtPowerRevocationCount,
  getCourtPowerUseMode,
  getUsedCourtPowers,
  getAvailableLandBidGold,
  getLandBidAmountOptions,
  isCourtPowerExhausted,
  isCourtPowerPassed,
  isCourtPowerUsed,
  getMinimumLandBid,
  getPlayerLandBid,
  validateMajorTitleAssignments,
} from '../engine/actions.js';
import { getMercenaryHireCost, getThemeLandPrice } from '../engine/rules.js';
import { getFreeThemes, getOfficeDisplayName, getOfficeHolder, getPlayer, getPlayerPrimaryRoleKey, getBishopThemes } from '../engine/state.js';
import { getPlayerCapitalSupport } from '../engine/capitalSupport.js';
import {
  getCoupRankWeight,
  getPreferredCoupCandidate,
  normalizeCoupRanking,
  normalizeCoupSupport,
  placeCoupCandidateAfterPlayer,
} from '../engine/coup.js';
import {
  getDeploymentArmyDisplayName,
  getDeploymentArmySourceKeys,
  getDeploymentArmyTroopEntry,
  getDeploymentArmyTroopTotal,
  getPlayerDeploymentArmyKeys,
  isStrategosDeploymentArmyKey,
} from '../engine/deployment.js';
import {
  formatGoldHtml,
  formatTroopsHtml,
  formatChurchHtml,
  formatMercenariesHtml,
} from '../engine/presentation.js';
import { renderIcon, renderValue } from './icons.js';
import {
  getPlayerStyleAttr,
  renderPlayerRoleName,
  renderOwnershipBadge,
  renderProvinceBadge,
  renderThemeOfficeBadge,
  renderTitleBadge,
} from './labels.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cloneStateForValidation(state) {
  let clone;
  try {
    clone = structuredClone({ ...state, rng: null });
  } catch {
    clone = JSON.parse(JSON.stringify({ ...state, rng: null }));
    if (state.courtActions) {
      clone.courtActions = {
        ...clone.courtActions,
        playerConfirmed: new Set([...(state.courtActions.playerConfirmed || new Set())]),
      };
    }
  }
  clone.rng = state.rng;
  clone.log = [];
  clone.historyEnabled = false;
  clone.history = null;
  clone.activeDealObligations = Array.isArray(clone.activeDealObligations) ? clone.activeDealObligations : [];
  clone.reservedGold = clone.reservedGold && typeof clone.reservedGold === 'object' ? clone.reservedGold : {};
  clone.dealThreads = Array.isArray(clone.dealThreads) ? clone.dealThreads : [];
  return clone;
}

function validateCourtPayload(state, playerId, payload) {
  if (!payload) return { ok: false, reason: 'Choose a legal court action.' };
  try {
    const result = applyCourtAction(cloneStateForValidation(state), playerId, payload);
    return result?.ok ? { ok: true } : { ok: false, reason: result?.reason || 'Not legal right now.' };
  } catch (error) {
    return { ok: false, reason: error?.message || 'Not legal right now.' };
  }
}

function choiceDisabledReason(entry, value, options = {}) {
  const reason = typeof options.getDisabledReason === 'function'
    ? options.getDisabledReason(entry, value)
    : null;
  return reason ? String(reason) : '';
}

function disabledChoiceAttrs(reason, label) {
  if (!reason) return '';
  const title = label ? `${label} - ${reason}` : reason;
  return ` disabled aria-disabled="true" title="${escapeHtml(title)}"`;
}

function getDraftBucket(uiState, state, scope, playerId) {
  if (!uiState) return {};
  if (!uiState.drafts) uiState.drafts = {};
  const key = `${scope}:${state.round}:${playerId}`;
  if (!uiState.drafts[key]) uiState.drafts[key] = {};
  return uiState.drafts[key];
}

function getPlayerOptions(state, selectedId = '') {
  return state.players.map((player) => `
    <option value="${player.id}" ${Number(selectedId) === player.id ? 'selected' : ''}>${escapeHtml(player.firstName ? `${player.firstName} ${player.dynasty}` : player.dynasty)}</option>
  `).join('');
}

function playerDisplayLabel(player) {
  return player?.firstName ? `${player.firstName} ${player.dynasty}` : (player?.dynasty || 'Player');
}

function playerInitial(player) {
  const name = (player?.dynasty || '').trim();
  return name ? name[0].toUpperCase() : '?';
}

function roleKeysForCourt(state, playerId) {
  const player = getPlayer(state, playerId);
  return [
    playerId === state.basileusId ? 'BASILEUS' : null,
    ...(player?.majorTitles || []),
  ].filter(Boolean);
}

function regionTitleFor(theme) {
  return { east: 'DOM_EAST', west: 'DOM_WEST', sea: 'ADMIRAL' }[theme?.region] || null;
}

function getStrategosTargets(state, playerId, powerKey = null) {
  const roles = new Set(powerKey ? [powerKey] : roleKeysForCourt(state, playerId));
  return Object.values(state.themes || {}).filter((theme) => (
    theme.id !== 'CPL'
    && !theme.occupied
    && theme.strategos == null
    && roles.has(regionTitleFor(theme))
  ));
}

function getBishopTargets(state, playerId) {
  const roles = new Set(roleKeysForCourt(state, playerId));
  if (!roles.has('PATRIARCH')) return [];
  return Object.values(state.themes || {}).filter((theme) => (
    theme.id !== 'CPL'
    && theme.bishop == null
    && (Number(theme.origin?.C) || 0) >= 1
  ));
}

function getRevocationTargets(state, playerId, powerKey = null) {
  const roles = new Set(powerKey ? [powerKey] : roleKeysForCourt(state, playerId));
  const targets = [];
  const seen = new Set();
  const isBasileusPower = (powerKey == null || powerKey === 'BASILEUS') && playerId === state.basileusId;
  const pushTarget = (target) => {
    if (!target?.value || seen.has(target.value)) return;
    seen.add(target.value);
    targets.push(target);
  };
  for (const theme of Object.values(state.themes || {})) {
    if (theme.id === 'CPL') continue;
    if (theme.strategos != null && (roles.has(regionTitleFor(theme)) || isBasileusPower)) {
      pushTarget({ value: `minor:${theme.id}:strategos`, label: `Strategos of ${theme.name}` });
    }
    if (theme.bishop != null && roles.has('PATRIARCH')) {
      pushTarget({ value: `minor:${theme.id}:bishop`, label: `Bishop of ${theme.name}` });
    }
    if (isBasileusPower && Number.isInteger(theme.owner) && !theme.occupied) {
      pushTarget({ value: `theme:${theme.id}`, label: `Estate in ${theme.name}` });
    }
  }
  return targets;
}

function bindSelectAction(container, selector, callback) {
  container.querySelectorAll(selector).forEach((node) => {
    node.addEventListener('click', () => callback?.(node));
  });
}

function datasetKeyFromSelector(selector) {
  const match = String(selector || '').match(/\[data-([a-z0-9-]+)/i);
  if (!match) return null;
  return match[1].replace(/-([a-z0-9])/gi, (_, char) => char.toUpperCase());
}

function renderPickerStep(num, label) {
  return `<div class="picker-step"><span class="picker-step-no">${num}</span><span class="picker-step-label">${label}</span></div>`;
}

function renderPlayerChoiceGrid(state, options = {}) {
  const {
    attr,
    selectedId = null,
    excludeIds = [],
    players = state.players,
    emptyLabel = 'No eligible players',
  } = options;
  const list = players.filter((p) => !excludeIds.includes(p.id));
  if (!list.length) return `<div class="choice-grid-empty">${emptyLabel}</div>`;
  return `
    <div class="choice-grid player-choice-grid">
      ${list.map((player) => {
        const disabledReason = choiceDisabledReason(player, player.id, options);
        const label = playerDisplayLabel(player);
        const isSelected = Number(selectedId) === player.id;
        return `
          <button type="button" class="choice-btn player-choice-btn${isSelected ? ' selected' : ''}${disabledReason ? ' disabled' : ''}"
            data-${attr}="${player.id}"
            aria-pressed="${isSelected ? 'true' : 'false'}"
            style="${getPlayerStyleAttr(state, player.id)}"
            title="${escapeHtml(disabledReason ? `${label} - ${disabledReason}` : label)}"
            ${disabledReason ? 'disabled aria-disabled="true"' : ''}>
            <span class="choice-crest">${playerInitial(player)}</span>
            <span class="choice-label">${escapeHtml(label)}</span>
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderProvinceChoiceGrid(state, themes, options = {}) {
  const { attr, selectedId = null, emptyLabel = 'No eligible provinces' } = options;
  if (!themes.length) return `<div class="choice-grid-empty">${emptyLabel}</div>`;
  return `
    <div class="choice-grid province-choice-grid">
      ${themes.map((theme) => {
        const disabledReason = choiceDisabledReason(theme, theme.id, options);
        const isSelected = selectedId === theme.id;
        return `
          <button type="button" class="choice-btn province-choice-btn${isSelected ? ' selected' : ''}${disabledReason ? ' disabled' : ''}"
            data-${attr}="${theme.id}"
            data-map-province="${theme.id}"
            aria-pressed="${isSelected ? 'true' : 'false'}"
            title="${escapeHtml(disabledReason ? `${theme.name} - ${disabledReason}` : theme.name)}"
            ${disabledReason ? 'disabled aria-disabled="true"' : ''}>
            ${renderProvinceBadge(state, theme, { showValues: true, showOwnership: true })}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderTitleChoiceGrid(state, entries, options = {}) {
  const { attr, selectedKey = null, holderId = null, emptyLabel = 'Nothing to choose' } = options;
  if (!entries.length) return `<div class="choice-grid-empty">${emptyLabel}</div>`;
  return `
    <div class="choice-grid title-choice-grid">
      ${entries.map((entry) => {
        const disabledReason = choiceDisabledReason(entry, entry.key, options);
        const isSelected = entry.key === selectedKey;
        const badge = renderTitleBadge(state, entry.kind, {
          holderId,
          label: entry.label,
          compact: true,
        });
        return `
          <button type="button" class="choice-btn title-choice-btn${isSelected ? ' selected' : ''}${disabledReason ? ' disabled' : ''}"
            aria-pressed="${isSelected ? 'true' : 'false'}"
            data-${attr}="${entry.key}"
            ${disabledChoiceAttrs(disabledReason, entry.label)}>
            ${badge}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderRevocationChoiceGrid(state, targets, options = {}) {
  const { attr, selectedValue = null } = options;
  if (!targets.length) return `<div class="choice-grid-empty">Nothing to revoke right now</div>`;
  return `
    <div class="choice-grid revocation-choice-grid">
      ${targets.map((target) => {
        const disabledReason = choiceDisabledReason(target, target.value, options);
        const isSelected = target.value === selectedValue;
        return `
          <button type="button" class="choice-btn revocation-choice-btn${isSelected ? ' selected' : ''}${disabledReason ? ' disabled' : ''}"
            aria-pressed="${isSelected ? 'true' : 'false'}"
            data-${attr}="${target.value}"
            ${disabledChoiceAttrs(disabledReason, target.label)}>
            ${target.badge || escapeHtml(target.label)}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderRevocationTargetBadge(state, target) {
  const [kind, themeId, titleType] = String(target?.value || '').split(':');
  const theme = state.themes?.[themeId];
  if (!theme) return escapeHtml(target?.label || '');

  if (kind === 'minor') {
    const titleKind = titleType === 'strategos' ? 'STRATEGOS' : 'BISHOP';
    const holderId = titleType === 'strategos' ? theme.strategos : theme.bishop;
    const holder = getPlayer(state, holderId);
    const ownershipKind = titleType === 'strategos' ? 'strategos' : 'bishop';
    return `
      <span class="revocation-target-card ${escapeHtml(titleType)}">
        <span class="revocation-target-kind">
          ${renderOwnershipBadge(state, {
            kind: ownershipKind,
            holderId,
            color: holder?.color || '#5a3810',
            accent: 'rgba(20,8,0,0.78)',
          }, { compact: true })}
        </span>
        <span class="revocation-target-place">
          ${renderTitleBadge(state, titleKind, { holderId, themeId, compact: true, label: titleType === 'strategos' ? 'Strategos seat' : 'Bishop seat' })}
          ${renderProvinceBadge(state, theme, { compact: true })}
        </span>
      </span>
    `;
  }

  if (kind === 'theme') {
    const holderId = theme.owner;
    const holder = getPlayer(state, holderId);
    return `
      <span class="revocation-target-card estate">
        <span class="revocation-target-kind">
          ${renderOwnershipBadge(state, {
            kind: 'estate',
            holderId,
            color: holder?.color || '#5a3810',
            accent: 'rgba(20,8,0,0.78)',
          }, { compact: true })}
        </span>
        <span class="revocation-target-place">
          ${renderProvinceBadge(state, theme, { compact: true })}
        </span>
      </span>
    `;
  }

  return escapeHtml(target?.label || '');
}

function renderArmyOfficeBadge(state, officeKey, playerId) {
  if (isStrategosDeploymentArmyKey(officeKey)) {
    return renderTitleBadge(state, 'STRATEGOS', {
      holderId: playerId,
      label: getDeploymentArmyDisplayName(state, playerId, officeKey),
      compact: true,
    });
  }
  if (String(officeKey).startsWith('STRAT_')) {
    return renderThemeOfficeBadge(state, 'STRATEGOS', String(officeKey).replace('STRAT_', ''));
  }
  return renderTitleBadge(state, officeKey, {
    holderId: getOfficeHolder(state, officeKey),
    label: getOfficeDisplayName(state, officeKey),
    compact: true,
  });
}

export function renderTitleRedistributionPanel(container, state, playerId, callbacks = {}, options = {}) {
  const isBasileus = playerId === state.basileusId;
  const draft = getDraftBucket(options.uiState, state, 'title-redist', playerId);
  const initial = options.assignments || {};
  if (!draft.assignments) draft.assignments = { ...initial };
  const titleKeys = Object.keys(MAJOR_TITLES);
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
  const selectedPlayerId = Number.isInteger(Number(draft.selectedTitlePlayerId))
    ? Number(draft.selectedTitlePlayerId)
    : null;
  const selectedPlayer = selectedPlayerId == null ? null : getPlayer(state, selectedPlayerId);
  const ruleText = sortedDistribution.length
    ? `Final spread must be ${sortedDistribution.join('-')} among the non-Basileus players.`
    : 'Assign each office to a non-Basileus player.';

  container.innerHTML = `
    <section class="phase-card title-redistribution-panel">
      <h3>Assign Major Offices</h3>
      <p class="section-hint">${isBasileus ? `Place player cards into the four office slots. ${ruleText}` : 'Waiting for the Basileus to assign the major offices.'}</p>
      <div class="title-redist-board">
        ${Object.entries(MAJOR_TITLES).map(([titleKey, title]) => {
          const assigned = hasAssignment(titleKey) ? Number(draft.assignments[titleKey]) : null;
          const assignedPlayer = Number.isInteger(assigned) ? getPlayer(state, assigned) : null;
          return `
            <section class="title-redist-slot${selectedPlayer ? ' can-fill' : ''}${assignedPlayer ? ' filled' : ''}" data-title-slot="${titleKey}" tabindex="${isBasileus ? '0' : '-1'}">
              <header class="title-redist-slot-head">
                ${renderTitleBadge(state, titleKey, { holderId: assignedPlayer?.id, compact: false, label: title.name })}
                <span class="title-redist-slot-state">${assignedPlayer ? 'Assigned' : selectedPlayer ? 'Click to place' : 'Empty'}</span>
              </header>
              <div class="title-redist-slot-body">
                <span class="title-redist-rope ${assignedPlayer ? 'bound' : 'open'}" aria-hidden="${assignedPlayer ? 'false' : 'true'}">
                  <span class="rope-knot"></span>
                  <span class="rope-strand"></span>
                  ${assignedPlayer && isBasileus
                    ? `<button type="button" class="rope-cut-btn title-redist-clear" data-title-clear="${titleKey}" aria-label="Cut link from ${escapeHtml(title.name)}">&#9986;</button>`
                    : '<span class="rope-loose-end"></span>'}
                  <span class="rope-strand"></span>
                  <span class="rope-knot"></span>
                </span>
                ${assignedPlayer ? `
                  <div class="title-redist-assigned" style="${getPlayerStyleAttr(state, assignedPlayer.id)}">
                    <span class="candidate-crest">${playerInitial(assignedPlayer)}</span>
                    <span class="candidate-name">${escapeHtml(playerDisplayLabel(assignedPlayer))}</span>
                  </div>
                ` : `
                  <span class="title-redist-empty">${selectedPlayer ? `Place ${escapeHtml(playerDisplayLabel(selectedPlayer))}` : 'Choose a player card below'}</span>
                `}
              </div>
            </section>
          `;
        }).join('')}
      </div>
      ${isBasileus ? `
        <div class="title-redist-tray" aria-label="Available players">
          <div class="title-redist-tray-head">
            <span>Player cards</span>
            <span>${selectedPlayer ? `Selected: ${escapeHtml(playerDisplayLabel(selectedPlayer))}` : 'Click or drag a card into a slot'}</span>
          </div>
          <div class="title-redist-token-grid">
            ${eligible.flatMap((player) => (
              Array.from({ length: maxCopies }, (_, copyIndex) => {
                const used = assignedCounts[player.id] || 0;
                const available = copyIndex >= used;
                const selected = selectedPlayerId === player.id && available;
                return `
                  <button type="button"
                    class="title-redist-player-token${selected ? ' selected' : ''}${available ? '' : ' used'}"
                    style="${getPlayerStyleAttr(state, player.id)}"
                    data-title-token-player="${player.id}"
                    data-title-token-copy="${copyIndex}"
                    draggable="${available ? 'true' : 'false'}"
                    ${available ? '' : 'disabled'}
                    aria-pressed="${selected ? 'true' : 'false'}">
                    <span class="candidate-crest">${playerInitial(player)}</span>
                    <span class="candidate-name">${escapeHtml(playerDisplayLabel(player))}</span>
                    <span class="candidate-tag">${available ? `Card ${copyIndex + 1}` : 'Placed'}</span>
                  </button>
                `;
              })
            )).join('')}
          </div>
        </div>
      ` : ''}
      <p class="form-error" data-role="title-reassignment-error">${complete && !validation.ok ? escapeHtml(validation.reason || '') : ''}</p>
      <div class="panel-actions">
        <button type="button" class="btn-primary" data-action="confirm-title-redistribution" ${canConfirm ? '' : 'disabled'}>${validation.ok ? 'Lock Offices' : 'Finish Office Slots'}</button>
      </div>
    </section>
  `;

  if (isBasileus) {
    const assignTitle = (titleKey, nextPlayerId) => {
      if (!titleKeys.includes(titleKey) || !Number.isInteger(nextPlayerId)) return false;
      const nextCounts = countAssignments(titleKey);
      if ((nextCounts[nextPlayerId] || 0) >= maxCopies) return false;
      draft.assignments[titleKey] = nextPlayerId;
      const remainingAfterAssign = maxCopies - ((countAssignments()[nextPlayerId] || 0));
      if (draft.selectedTitlePlayerId === nextPlayerId && remainingAfterAssign <= 0) delete draft.selectedTitlePlayerId;
      return true;
    };

    container.querySelectorAll('[data-title-token-player]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        draft.selectedTitlePlayerId = Number(button.dataset.titleTokenPlayer);
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
        if (draft.selectedTitlePlayerId == null) return;
        if (assignTitle(slot.dataset.titleSlot, Number(draft.selectedTitlePlayerId))) rerender();
      });
      slot.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (draft.selectedTitlePlayerId == null) return;
        event.preventDefault();
        if (assignTitle(slot.dataset.titleSlot, Number(draft.selectedTitlePlayerId))) rerender();
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

    container.querySelectorAll('[data-title-clear]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        delete draft.assignments[button.dataset.titleClear];
        rerender();
      });
    });
  }

  bindSelectAction(container, '[data-action="confirm-title-redistribution"]', () => {
    callbacks.confirmTitleRedistribution?.({ ...draft.assignments });
  });
}

export function renderHistoryPanel(container, state, options = {}) {
  if (!container || !state) return;
  const isOpen = options.uiState?.panels?.history ?? false;
  container.classList?.toggle?.('panel-collapsed', !isOpen);
  const history = Array.isArray(state.history) ? state.history.slice().reverse() : [];
  const countLabel = history.length ? `${history.length} entries` : 'Empty';
  container.innerHTML = `
    <div class="history-panel sidebar-panel${isOpen ? '' : ' is-collapsed'}">
      <button class="sidebar-panel-head" type="button" data-ui-panel-toggle="history" aria-expanded="${isOpen}">
        <span class="sidebar-panel-head-copy">
          <span class="sidebar-panel-kicker">Chronicle</span>
          <span class="sidebar-panel-title">History</span>
        </span>
        <span class="sidebar-panel-badge">${countLabel}</span>
      </button>
      ${isOpen ? `
        <div class="sidebar-panel-body history-list">
          ${history.length ? history.map((entry) => `
            <article class="history-entry-card">
              <header class="history-entry-head">
                <span class="history-entry-round">R${entry.round}</span>
                <span class="history-entry-phase">${escapeHtml(entry.phase)}</span>
              </header>
              <div class="history-entry-summary">${escapeHtml(entry.summary)}</div>
            </article>
          `).join('') : '<div class="panel-empty">No history yet.</div>'}
        </div>
      ` : ''}
    </div>
  `;
}

function getDashboardEconomy(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return { reserve: 0, income: 0, churchYield: 0, troops: 0 };
  let income = 0;
  let churchYield = 0;
  let troops = 0;
  try {
    const admin = runIncome(state);
    income = Number(admin?.income?.[playerId]) || 0;
  } catch (err) {
    income = 0;
  }
  try {
    const bishopThemes = getBishopThemes(state, playerId);
    churchYield = bishopThemes.reduce((sum, theme) => sum + Math.max(0, Number(theme?.C) || 0), 0);
  } catch (err) { churchYield = 0; }
  for (const officeKey of Object.keys(state.currentTroops || {})) {
    if (getOfficeHolder(state, officeKey) !== playerId) continue;
    const entry = readTroopEntry(state.currentTroops[officeKey]);
    troops += entry.normal + entry.capitalLocked;
  }
  return {
    reserve: Math.max(0, Number(player.gold) || 0),
    income,
    churchYield,
    troops,
  };
}

function getPlayerPrimaryRoleLabel(state, playerId) {
  const roleKey = getPlayerPrimaryRoleKey(state, playerId);
  if (!roleKey) return '';
  return getOfficeDisplayName(state, roleKey);
}

function getDashboardHoldings(state, playerId) {
  const themes = Object.values(state?.themes || {}).filter((theme) => theme?.id !== 'CPL');
  return {
    estate: themes.filter((theme) => !theme.occupied && theme.owner === playerId),
    strategos: themes.filter((theme) => !theme.occupied && theme.strategos === playerId),
    bishop: themes.filter((theme) => theme.bishop === playerId),
  };
}

function renderDashboardHoldingRow(state, playerId, kind, themes) {
  if (!themes.length) return '';
  const player = getPlayer(state, playerId);
  const label = renderOwnershipBadge(state, {
    kind,
    holderId: playerId,
    color: player?.color || '#5a3810',
    accent: 'rgba(20,8,0,0.76)',
  }, { compact: true, hideHolder: true });
  return `
    <div class="dashboard-holding-row dashboard-holding-${kind}">
      <span class="dashboard-holding-kind">${label}</span>
      <span class="dashboard-holding-list">
        ${themes.map((theme) => renderProvinceBadge(state, theme, { compact: true })).join(' ')}
      </span>
    </div>
  `;
}

function renderDashboardHoldings(state, playerId) {
  const holdings = getDashboardHoldings(state, playerId);
  const rows = [
    renderDashboardHoldingRow(state, playerId, 'estate', holdings.estate),
    renderDashboardHoldingRow(state, playerId, 'strategos', holdings.strategos),
    renderDashboardHoldingRow(state, playerId, 'bishop', holdings.bishop),
  ].filter(Boolean);
  if (!rows.length) return '';
  return `<div class="dashboard-holdings">${rows.join('')}</div>`;
}

export function renderPlayerDashboard(container, state, playerId, selectedProvinceId = null, options = {}) {
  if (!container || !state) return;
  void selectedProvinceId;
  const player = getPlayer(state, playerId);
  const isOpen = options.uiState?.panels?.dashboard ?? true;
  const titles = [
    playerId === state.basileusId ? renderTitleBadge(state, 'BASILEUS', { holderId: playerId, compact: true }) : '',
    ...(player?.majorTitles || []).map((titleKey) => renderTitleBadge(state, titleKey, { holderId: playerId, compact: true })),
  ].filter(Boolean).join(' ');
  const economy = player ? getDashboardEconomy(state, playerId) : null;
  const roleLabel = player ? getPlayerPrimaryRoleLabel(state, playerId) : '';
  const crestLetter = player ? playerInitial(player) : '?';
  const dynastyName = player ? escapeHtml(player.dynasty || 'Dynasty') : 'No dynasty';

  container.classList?.toggle?.('panel-collapsed', !isOpen);
  container.innerHTML = `
    <div class="player-dashboard sidebar-panel${isOpen ? '' : ' is-collapsed'}" style="${player ? getPlayerStyleAttr(state, player.id) : ''}">
      <button class="sidebar-panel-head dashboard-cartouche-head" type="button" data-ui-panel-toggle="dashboard" aria-expanded="${isOpen}">
        <span class="dashboard-cartouche" role="presentation">
          <span class="dc-crest" aria-hidden="true">${crestLetter}</span>
          <span class="dc-identity">
            <span class="dc-name">${dynastyName}</span>
            <span class="dc-role${roleLabel ? '' : ' muted'}">${roleLabel || 'No major office'}</span>
          </span>
          ${economy ? `
            <span class="dc-finance">
              <span class="dc-reserve">${formatGoldHtml(economy.reserve)}</span>
              <span class="dc-delta">
                ${formatGoldHtml(economy.income, { signed: true, tone: economy.income < 0 ? 'upkeep' : 'income' })}
                ${formatTroopsHtml(economy.troops)}
              </span>
            </span>
          ` : ''}
        </span>
      </button>
      ${isOpen ? `
      <div class="sidebar-panel-body">
        ${economy ? `
          <div class="finance-grid" aria-label="Next-round projection">
            <div class="finance-card">
              <span class="finance-label">${renderIcon('gold')}Reserve</span>
              <span class="finance-value">${formatGoldHtml(economy.reserve)}</span>
            </div>
            <div class="finance-card ${economy.income < 0 ? 'upkeep' : 'income'}">
              <span class="finance-label">${renderIcon('gold')}Next Income</span>
              <span class="finance-value">${formatGoldHtml(economy.income, { signed: true })}</span>
            </div>
            <div class="finance-card">
              <span class="finance-label">${renderIcon('troop')}Troops</span>
              <span class="finance-value">${formatTroopsHtml(economy.troops)}</span>
            </div>
            <div class="finance-card">
              <span class="finance-label">${renderIcon('church')}Church Yield</span>
              <span class="finance-value">${formatChurchHtml(economy.churchYield)}</span>
            </div>
          </div>
        ` : ''}
        <div class="dashboard-token-row">${titles || '<span class="muted">No major office</span>'}</div>
        ${renderDashboardHoldings(state, playerId)}
      </div>
      ` : ''}
    </div>
  `;
}

// One self-contained appointment block: title → step 1 picker → step 2
// picker → preview line → confirm button. The selection state lives in
// the panel draft so the picker keeps its visual feedback across
// re-renders.
function renderAppointmentSection({
  kind,
  title,
  targetPicker,
  playerPicker,
  preview,
  buttonLabel,
  buttonAttr,
  disabled,
}) {
  return `
    <section class="appointment-section" data-appointment="${kind}">
      <header class="appointment-section-head">
        <span class="appointment-section-title">${title}</span>
      </header>
      <div class="appointment-step">
        ${renderPickerStep(1, 'Pick the office')}
        ${targetPicker}
      </div>
      <div class="appointment-step">
        ${renderPickerStep(2, 'Pick the appointee')}
        ${playerPicker}
      </div>
      <div class="appointment-preview">${preview || '<span class="muted">Make both picks to confirm</span>'}</div>
      <div class="panel-actions appointment-actions">
        <button type="button" class="btn-primary" data-action="${buttonAttr}" ${disabled ? 'disabled' : ''}>${buttonLabel}</button>
      </div>
    </section>
  `;
}

function renderCourtAppointments(state, playerId, draft) {
  const strategoi = getStrategosTargets(state, playerId);
  const bishops = getBishopTargets(state, playerId);
  if (!strategoi.length && !bishops.length) return '';

  const sections = [];

  // Strategoi (regional governors)
  if (strategoi.length) {
    const appoint = draft.appointStrategos || {};
    const target = appoint.themeId ? state.themes[appoint.themeId] : null;
    const appointee = appoint.playerId != null ? getPlayer(state, appoint.playerId) : null;
    const ready = Boolean(target && appointee);
    const preview = ready
      ? `${renderPlayerRoleName(state, appointee)} → ${renderTitleBadge(state, 'STRATEGOS', { holderId: appointee.id, themeId: target.id, compact: true })} of ${renderProvinceBadge(state, target, { compact: true, showOwnership: true })}`
      : null;
    sections.push(renderAppointmentSection({
      kind: 'strategos',
      title: 'Strategos',
      targetPicker: renderProvinceChoiceGrid(state, strategoi, { attr: 'strategos-theme-pick', selectedId: appoint.themeId }),
      playerPicker: renderPlayerChoiceGrid(state, { attr: 'strategos-player-pick', selectedId: appoint.playerId }),
      preview,
      buttonLabel: 'Appoint Strategos',
      buttonAttr: 'appoint-strategos',
      disabled: !ready,
    }));
  }

  // Bishops (Patriarch only)
  if (bishops.length) {
    const appoint = draft.appointBishop || {};
    const target = appoint.themeId ? state.themes[appoint.themeId] : null;
    const appointee = appoint.playerId != null ? getPlayer(state, appoint.playerId) : null;
    const ready = Boolean(target && appointee);
    const preview = ready
      ? `${renderPlayerRoleName(state, appointee)} → ${renderTitleBadge(state, 'BISHOP', { holderId: appointee.id, themeId: target.id, compact: true })} of ${renderProvinceBadge(state, target, { compact: true, showOwnership: true })}`
      : null;
    sections.push(renderAppointmentSection({
      kind: 'bishop',
      title: 'Bishop',
      targetPicker: renderProvinceChoiceGrid(state, bishops, { attr: 'bishop-theme-pick', selectedId: appoint.themeId }),
      playerPicker: renderPlayerChoiceGrid(state, { attr: 'bishop-player-pick', selectedId: appoint.playerId }),
      preview,
      buttonLabel: 'Appoint Bishop',
      buttonAttr: 'appoint-bishop',
      disabled: !ready,
    }));
  }

  return `
    <details class="action-fold" open>
      <summary>Appoint</summary>
      <div class="appointment-stack">${sections.join('')}</div>
    </details>
  `;
}

function renderCourtRevocations(state, playerId, draft) {
  const rawTargets = getRevocationTargets(state, playerId);
  if (!rawTargets.length) return '';
  const targets = decorateRevocationTargets(state, rawTargets);
  const selectedValue = draft.revoke?.target || null;
  const selectedTarget = targets.find((t) => t.value === selectedValue);
  const ready = Boolean(selectedTarget);
  return `
    <details class="action-fold">
      <summary>Revoke</summary>
      <div class="appointment-section">
        <div class="appointment-step">
          ${renderPickerStep(1, 'Pick what to revoke')}
          ${renderRevocationChoiceGrid(state, targets, { attr: 'revoke-pick', selectedValue })}
        </div>
        <div class="appointment-preview">
          ${selectedTarget ? `<span class="danger">Revoke</span> ${selectedTarget.badge}` : '<span class="muted">Pick a target to revoke</span>'}
        </div>
        <div class="panel-actions">
          <button type="button" class="btn-danger" data-action="revoke" ${ready ? '' : 'disabled'}>Revoke</button>
        </div>
      </div>
    </details>
  `;
}

function getCourtPowerLabel(powerKey) {
  if (powerKey === 'BASILEUS') return 'Basileus';
  return MAJOR_TITLES[powerKey]?.name || powerKey;
}

function getAppointmentPayload(powerKey, targetKey, appointeeId) {
  if (!targetKey || appointeeId == null) return null;
  const normalizedAppointeeId = Number(appointeeId);
  if (!Number.isInteger(normalizedAppointeeId)) return null;
  if (powerKey === 'BASILEUS') {
    return null;
  }
  if (powerKey === 'PATRIARCH') {
    return { action: 'appoint-bishop', themeId: targetKey, appointeeId: normalizedAppointeeId };
  }
  return { action: 'appoint-strategos', titleKey: powerKey, themeId: targetKey, appointeeId: normalizedAppointeeId };
}

function getAppointmentDisabledReason(state, playerId, powerKey, targetKey, appointeeId) {
  const payload = getAppointmentPayload(powerKey, targetKey, appointeeId);
  if (!payload) return 'Make both picks first.';
  const result = validateCourtPayload(state, playerId, payload);
  return result.ok ? '' : result.reason;
}

function getTargetDisabledReason(state, playerId, powerKey, targetKey) {
  let firstReason = '';
  for (const player of state.players || []) {
    const reason = getAppointmentDisabledReason(state, playerId, powerKey, targetKey, player.id);
    if (!reason) return '';
    if (!firstReason) firstReason = reason;
  }
  return firstReason || 'No legal appointee right now.';
}

function getAppointeeDisabledReason(state, playerId, powerKey, targets, appointeeId, selectedTargetKey = null) {
  if (selectedTargetKey) {
    return getAppointmentDisabledReason(state, playerId, powerKey, selectedTargetKey, appointeeId);
  }
  let firstReason = '';
  for (const target of targets || []) {
    const targetKey = target.key || target.id;
    const reason = getAppointmentDisabledReason(state, playerId, powerKey, targetKey, appointeeId);
    if (!reason) return '';
    if (!firstReason) firstReason = reason;
  }
  return firstReason || 'No legal office for this appointee right now.';
}

function renderCourtPowerBadge(state, playerId, powerKey) {
  return renderTitleBadge(state, powerKey, {
    holderId: playerId,
    label: getCourtPowerLabel(powerKey),
    compact: true,
  });
}

function courtSeatLabel(kind) {
  if (kind === 'strategos') return 'Strategos seat';
  if (kind === 'bishop') return 'Bishop seat';
  if (kind === 'estate') return 'Private estate';
  return 'Seat';
}

function renderCourtLinkSeat(state, kind, theme, holderId = null) {
  if (!theme) return '';
  const titleKind = kind === 'bishop' ? 'BISHOP' : kind === 'strategos' ? 'STRATEGOS' : null;
  return `
    <span class="court-link-seat-token ${escapeHtml(kind)}">
      ${titleKind
        ? renderTitleBadge(state, titleKind, { holderId, themeId: theme.id, compact: true, label: courtSeatLabel(kind) })
        : `<span class="revocation-target-label">Estate</span>`}
      ${renderProvinceBadge(state, theme, { compact: true, showOwnership: kind === 'estate' })}
    </span>
  `;
}

function renderCourtLinkHolder(state, kind, holderId) {
  const holder = getPlayer(state, holderId);
  if (!holder) {
    return `<span class="court-link-open-end">${escapeHtml(courtSeatLabel(kind))} open</span>`;
  }
  return `
    <span class="court-link-holder-card" style="${getPlayerStyleAttr(state, holder.id)}">
      <span class="candidate-crest">${playerInitial(holder)}</span>
      <span class="candidate-name">${escapeHtml(playerDisplayLabel(holder))}</span>
      ${renderOwnershipBadge(state, {
        kind,
        holderId,
        color: holder.color || '#5a3810',
        accent: 'rgba(20,8,0,0.78)',
      })}
    </span>
  `;
}

function renderCourtLinkRope({ bound = false, targetValue = '', disabledReason = '', label = 'Cut link' } = {}) {
  const stateClass = bound ? 'bound' : 'open';
  return `
    <span class="court-link-rope ${stateClass}" aria-hidden="${bound ? 'false' : 'true'}">
      <span class="rope-knot"></span>
      <span class="rope-strand"></span>
      ${bound
        ? `<button type="button" class="rope-cut-btn" data-link-revoke="${escapeHtml(targetValue)}" aria-label="${escapeHtml(label)}" ${disabledChoiceAttrs(disabledReason, label)}>&#9986;</button>`
        : '<span class="rope-loose-end"></span>'}
      <span class="rope-strand"></span>
      <span class="rope-knot"></span>
    </span>
  `;
}

function renderCourtAppointmentLinkSection({
  state,
  playerId,
  powerKey,
  draft,
  targets,
  kind,
  targetAttr,
  playerAttr,
  action,
  buttonLabel,
}) {
  if (!targets.length) return '';
  const activeThemeId = draft.themeId || targets[0]?.id || null;
  const selectedTheme = draft.themeId ? state.themes?.[draft.themeId] : null;
  const selectedPlayer = draft.playerId != null ? getPlayer(state, draft.playerId) : null;
  const selectedReason = selectedTheme && selectedPlayer
    ? getAppointmentDisabledReason(state, playerId, powerKey, selectedTheme.id, selectedPlayer.id)
    : '';
  const selectedReady = Boolean(
    selectedTheme
    && selectedPlayer
    && targets.some((theme) => theme.id === selectedTheme.id)
    && !selectedReason
  );
  return `
    <section class="court-link-section court-appoint-section" data-appointment="${kind}">
      <header class="court-link-section-head">
        <span class="appointment-section-title">Appoint</span>
        <span class="court-link-section-note">Tie a seat to a dynasty</span>
      </header>
      <div class="court-link-board">
        ${targets.map((theme) => {
          const targetDisabledReason = getTargetDisabledReason(state, playerId, powerKey, theme.id);
          const isPicked = draft.themeId === theme.id;
          const isActive = activeThemeId === theme.id;
          const rowReason = isPicked ? selectedReason : targetDisabledReason;
          return `
            <article class="court-link-row court-link-row-open${isPicked ? ' selected' : ''}${targetDisabledReason ? ' disabled' : ''}" data-link-kind="${kind}">
              <button type="button"
                class="court-link-seat-btn${isPicked ? ' selected' : ''}"
                data-${targetAttr}="${theme.id}"
                data-map-province="${theme.id}"
                aria-pressed="${isPicked ? 'true' : 'false'}"
                ${disabledChoiceAttrs(targetDisabledReason, `${courtSeatLabel(kind)} in ${theme.name}`)}>
                ${renderCourtLinkSeat(state, kind, theme)}
              </button>
              ${renderCourtLinkRope({ bound: false })}
              <div class="court-link-holder court-link-holder-open">
                ${isActive ? `
                  <div class="court-link-player-grid">
                    ${renderPlayerChoiceGrid(state, {
                      attr: playerAttr,
                      selectedId: draft.playerId,
                      getDisabledReason: (player) => getAppointeeDisabledReason(state, playerId, powerKey, targets, player.id, theme.id),
                    })}
                  </div>
                  ${rowReason ? `<div class="court-link-warning">${escapeHtml(rowReason)}</div>` : ''}
                  <div class="panel-actions court-link-actions">
                    <button type="button" class="btn-primary" data-action="${action}" aria-label="${escapeHtml(buttonLabel)}" ${selectedReady && isPicked ? '' : 'disabled'}>Tie Rope</button>
                  </div>
                ` : `<span class="court-link-open-end">Pick this seat to choose a player</span>`}
              </div>
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function describeRevocationLinkTarget(state, target) {
  const [kind, themeId, titleType] = String(target?.value || '').split(':');
  const theme = state.themes?.[themeId];
  if (!theme) return null;
  if (kind === 'minor') {
    const linkKind = titleType === 'bishop' ? 'bishop' : 'strategos';
    const holderId = linkKind === 'bishop' ? theme.bishop : theme.strategos;
    return {
      kind: linkKind,
      theme,
      holderId,
      seatHtml: renderCourtLinkSeat(state, linkKind, theme, holderId),
      holderHtml: renderCourtLinkHolder(state, linkKind, holderId),
      label: target?.label || `${courtSeatLabel(linkKind)} in ${theme.name}`,
    };
  }
  if (kind === 'theme') {
    return {
      kind: 'estate',
      theme,
      holderId: theme.owner,
      seatHtml: renderCourtLinkSeat(state, 'estate', theme, theme.owner),
      holderHtml: renderCourtLinkHolder(state, 'estate', theme.owner),
      label: target?.label || `Estate in ${theme.name}`,
    };
  }
  return null;
}

function renderCourtRevocationLinkRow(state, target, selectedValue) {
  const link = describeRevocationLinkTarget(state, target);
  if (!link) return '';
  const disabledReason = target.disabledReason || '';
  const selected = target.value === selectedValue;
  return `
    <article class="court-link-row court-link-row-bound${selected ? ' selected' : ''}${disabledReason ? ' disabled' : ''}"
      data-revoke-pick="${escapeHtml(target.value)}"
      data-map-province="${escapeHtml(link.theme.id)}"
      data-link-kind="${escapeHtml(link.kind)}"
      aria-pressed="${selected ? 'true' : 'false'}"
      ${disabledReason ? 'aria-disabled="true"' : ''}
      title="${escapeHtml(disabledReason || link.label)}">
      <div class="court-link-seat-static">${link.seatHtml}</div>
      ${renderCourtLinkRope({
        bound: true,
        targetValue: target.value,
        disabledReason,
        label: `Cut ${link.label}`,
      })}
      <div class="court-link-holder">${link.holderHtml}</div>
      ${disabledReason ? `<div class="court-link-warning">${escapeHtml(disabledReason)}</div>` : ''}
    </article>
  `;
}

function renderCourtAppointmentsForPowerLinked(state, playerId, draft, powerKey) {
  if (powerKey === 'BASILEUS') return '';
  if (powerKey === 'PATRIARCH') {
    return renderCourtAppointmentLinkSection({
      state,
      playerId,
      powerKey,
      draft: draft.appointBishop || {},
      targets: getBishopTargets(state, playerId),
      kind: 'bishop',
      targetAttr: 'bishop-theme-pick',
      playerAttr: 'bishop-player-pick',
      action: 'appoint-bishop',
      buttonLabel: 'Appoint Bishop',
    });
  }
  return renderCourtAppointmentLinkSection({
    state,
    playerId,
    powerKey,
    draft: draft.appointStrategos || {},
    targets: getStrategosTargets(state, playerId, powerKey),
    kind: 'strategos',
    targetAttr: 'strategos-theme-pick',
    playerAttr: 'strategos-player-pick',
    action: 'appoint-strategos',
    buttonLabel: 'Appoint Strategos',
  });
}

function renderCourtRevocationsForPowerLinked(state, playerId, draft, powerKey) {
  const targets = getRevocationTargets(state, playerId, powerKey)
    .map((target) => {
      const result = validateCourtPayload(state, playerId, { action: 'revoke', value: target.value });
      return { ...target, disabledReason: result.ok ? '' : result.reason };
    });
  if (!targets.length) return '';
  const selectedValue = draft.revoke?.target || null;
  const selectedTarget = targets.find((target) => target.value === selectedValue);
  return `
    <section class="court-link-section court-revoke-section">
      <header class="court-link-section-head">
        <span class="appointment-section-title">Revoke</span>
        <span class="court-link-section-note">Cut the rope from a seat or estate</span>
      </header>
      <div class="court-link-board">
        ${targets.map((target) => renderCourtRevocationLinkRow(state, target, selectedValue)).join('')}
      </div>
      <div class="appointment-preview court-link-preview">
        ${selectedTarget
          ? selectedTarget.disabledReason
            ? `<span class="muted">Cannot cut this link: ${escapeHtml(selectedTarget.disabledReason)}</span>`
            : `<span class="danger">Ready to cut</span> ${describeRevocationLinkTarget(state, selectedTarget)?.seatHtml || escapeHtml(selectedTarget.label)}`
          : '<span class="muted">Pick a link for details, or cut it with the scissors.</span>'}
      </div>
    </section>
  `;
}

function courtConnectionKey(kind, themeId) {
  return `${kind}:${themeId}`;
}

function getCourtAppointmentDraft(draft, kind) {
  return kind === 'bishop' ? (draft.appointBishop || {}) : (draft.appointStrategos || {});
}

function buildCourtConnectionEntries(state, playerId, powerKey) {
  const entries = [];
  const seen = new Set();
  const addEntry = (entry) => {
    if (!entry?.key || seen.has(entry.key)) return;
    seen.add(entry.key);
    entries.push(entry);
  };

  getRevocationTargets(state, playerId, powerKey)
    .map((target) => {
      const result = validateCourtPayload(state, playerId, { action: 'revoke', value: target.value });
      return { ...target, disabledReason: result.ok ? '' : result.reason };
    })
    .forEach((target) => {
      const link = describeRevocationLinkTarget(state, target);
      if (!link) return;
      addEntry({
        key: courtConnectionKey(link.kind, link.theme.id),
        mode: 'bound',
        kind: link.kind,
        theme: link.theme,
        holderId: link.holderId,
        label: link.label,
        seatHtml: link.seatHtml,
        holderHtml: link.holderHtml,
        revokeValue: target.value,
        revokeDisabledReason: target.disabledReason || '',
      });
    });

  if (powerKey === 'BASILEUS') return entries;

  const addOpenAppointment = (kind, theme) => {
    if (!theme) return;
    const action = kind === 'bishop' ? 'appoint-bishop' : 'appoint-strategos';
    const targetAttr = kind === 'bishop' ? 'bishop-theme-pick' : 'strategos-theme-pick';
    const playerAttr = kind === 'bishop' ? 'bishop-player-pick' : 'strategos-player-pick';
    const buttonLabel = kind === 'bishop' ? 'Appoint Bishop' : 'Appoint Strategos';
    addEntry({
      key: courtConnectionKey(kind, theme.id),
      mode: 'open',
      kind,
      theme,
      holderId: null,
      label: `${courtSeatLabel(kind)} in ${theme.name}`,
      seatHtml: renderCourtLinkSeat(state, kind, theme),
      action,
      targetAttr,
      playerAttr,
      buttonLabel,
      targetDisabledReason: getTargetDisabledReason(state, playerId, powerKey, theme.id),
    });
  };

  if (powerKey === 'PATRIARCH') {
    getBishopTargets(state, playerId).forEach((theme) => addOpenAppointment('bishop', theme));
  } else {
    getStrategosTargets(state, playerId, powerKey).forEach((theme) => addOpenAppointment('strategos', theme));
  }
  return entries;
}

function renderCourtPlayerNode(state, entry, draft, playerId, powerKey, active) {
  if (entry.mode === 'bound') {
    return `<div class="court-link-player-cell bound">${entry.holderHtml}</div>`;
  }
  if (!active) {
    return `<div class="court-link-player-cell open"><span class="court-link-open-end">Choose this seat</span></div>`;
  }
  const appoint = getCourtAppointmentDraft(draft, entry.kind);
  const targets = entry.kind === 'bishop'
    ? getBishopTargets(state, playerId)
    : getStrategosTargets(state, playerId, powerKey);
  return `
    <div class="court-link-player-cell active">
      <div class="choice-grid player-choice-grid">
        ${(state.players || []).map((player) => {
          const disabledReason = getAppointeeDisabledReason(state, playerId, powerKey, targets, player.id, entry.theme.id);
          const label = playerDisplayLabel(player);
          const isSelected = Number(appoint.playerId) === player.id && appoint.themeId === entry.theme.id;
          return `
            <button type="button" class="choice-btn player-choice-btn${isSelected ? ' selected' : ''}${disabledReason ? ' disabled' : ''}"
              data-${entry.targetAttr}="${entry.theme.id}"
              data-${entry.playerAttr}="${player.id}"
              aria-pressed="${isSelected ? 'true' : 'false'}"
              style="${getPlayerStyleAttr(state, player.id)}"
              title="${escapeHtml(disabledReason ? `${label} - ${disabledReason}` : label)}"
              ${disabledReason ? 'disabled aria-disabled="true"' : ''}>
              <span class="choice-crest">${playerInitial(player)}</span>
              <span class="choice-label">${escapeHtml(label)}</span>
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderCourtConnector(state, entry, draft, playerId, powerKey, active) {
  if (entry.mode === 'bound') {
    const disabledReason = entry.revokeDisabledReason || '';
    return `
      <button type="button"
        class="court-link-connector bound${disabledReason ? ' disabled' : ''}"
        data-link-revoke="${escapeHtml(entry.revokeValue)}"
        aria-label="${escapeHtml(`Revoke ${entry.label}`)}"
        ${disabledChoiceAttrs(disabledReason, `Revoke ${entry.label}`)}>
        <span class="court-link-line"></span>
        <span class="court-link-mid court-link-cut">&#9986;</span>
        <span class="court-link-line"></span>
      </button>
    `;
  }

  const appoint = getCourtAppointmentDraft(draft, entry.kind);
  const selectedPlayer = appoint.playerId != null ? getPlayer(state, appoint.playerId) : null;
  const selectedReason = active && selectedPlayer
    ? getAppointmentDisabledReason(state, playerId, powerKey, entry.theme.id, selectedPlayer.id)
    : '';
  const ready = Boolean(active && selectedPlayer && appoint.themeId === entry.theme.id && !entry.targetDisabledReason && !selectedReason);
  const selectAttrs = ready
    ? `data-action="${entry.action}" aria-label="${escapeHtml(entry.buttonLabel)}"`
    : `data-${entry.targetAttr}="${entry.theme.id}" data-map-province="${entry.theme.id}" aria-label="${escapeHtml(`Choose ${entry.label}`)}"`;
  const disabled = entry.targetDisabledReason && !ready;
  return `
    <button type="button"
      class="court-link-connector open${active ? ' active' : ''}${ready ? ' ready' : ''}${disabled ? ' disabled' : ''}"
      ${selectAttrs}
      ${disabled ? disabledChoiceAttrs(entry.targetDisabledReason, entry.label) : ''}>
      <span class="court-link-line"></span>
      <span class="court-link-mid">${ready ? 'Tie' : ''}</span>
      <span class="court-link-line"></span>
    </button>
  `;
}

function renderCourtConnectionRow(state, entry, draft, playerId, powerKey, active) {
  const selectedClass = active ? ' selected' : '';
  const disabledReason = entry.mode === 'bound' ? entry.revokeDisabledReason : entry.targetDisabledReason;
  return `
    <article class="court-link-connection ${entry.mode}${selectedClass}${disabledReason ? ' disabled' : ''}"
      data-link-kind="${escapeHtml(entry.kind)}"
      ${entry.revokeValue ? `data-revoke-pick="${escapeHtml(entry.revokeValue)}"` : ''}
      data-map-province="${escapeHtml(entry.theme.id)}"
      ${disabledReason ? 'aria-disabled="true"' : ''}>
      <button type="button"
        class="court-link-seat-node${selectedClass}"
        ${entry.mode === 'open' ? `data-${entry.targetAttr}="${entry.theme.id}"` : ''}
        data-map-province="${entry.theme.id}"
        aria-pressed="${active ? 'true' : 'false'}"
        ${entry.mode === 'open' && entry.targetDisabledReason ? disabledChoiceAttrs(entry.targetDisabledReason, entry.label) : ''}>
        ${entry.seatHtml}
      </button>
      ${renderCourtConnector(state, entry, draft, playerId, powerKey, active)}
      ${renderCourtPlayerNode(state, entry, draft, playerId, powerKey, active)}
      ${disabledReason ? `<div class="court-link-warning">${escapeHtml(disabledReason)}</div>` : ''}
    </article>
  `;
}

function renderCourtConnectionsForPower(state, playerId, draft, powerKey) {
  const entries = buildCourtConnectionEntries(state, playerId, powerKey);
  if (!entries.length) return '';
  const openEntries = entries.filter((entry) => entry.mode === 'open');
  const selectedStrategos = draft.appointStrategos?.themeId
    ? courtConnectionKey('strategos', draft.appointStrategos.themeId)
    : null;
  const selectedBishop = draft.appointBishop?.themeId
    ? courtConnectionKey('bishop', draft.appointBishop.themeId)
    : null;
  const selectedKeys = new Set([selectedStrategos, selectedBishop].filter(Boolean));
  const fallbackOpenKey = openEntries[0]?.key || null;
  const activeKey = openEntries.find((entry) => selectedKeys.has(entry.key))?.key || fallbackOpenKey;
  const openCount = openEntries.length;
  const boundCount = entries.length - openCount;
  return `
    <section class="court-link-section court-connection-section">
      <header class="court-link-section-head">
        <span class="appointment-section-title">Links</span>
        <span class="court-link-section-note">${boundCount} tied, ${openCount} open. Click an open rope to tie it; click a tied rope to Revoke it.</span>
      </header>
      <div class="court-link-matrix" role="group" aria-label="${escapeHtml(`${getCourtPowerLabel(powerKey)} links`)}">
        <div class="court-link-col-head">Seats</div>
        <div class="court-link-col-head center">Rope</div>
        <div class="court-link-col-head right">Dynasty</div>
        ${entries.map((entry) => renderCourtConnectionRow(state, entry, draft, playerId, powerKey, entry.key === activeKey)).join('')}
      </div>
    </section>
  `;
}

function renderCourtAppointmentsForPower(state, playerId, draft, powerKey) {
  if (powerKey === 'BASILEUS') {
    void state;
    void playerId;
    void draft;
    return '';
  }

  if (powerKey === 'PATRIARCH') {
    const bishops = getBishopTargets(state, playerId);
    if (!bishops.length) return '';
    const appoint = draft.appointBishop || {};
    const target = appoint.themeId ? state.themes[appoint.themeId] : null;
    const appointee = appoint.playerId != null ? getPlayer(state, appoint.playerId) : null;
    const selectedReason = target && appointee
      ? getAppointmentDisabledReason(state, playerId, powerKey, target.id, appointee.id)
      : '';
    const ready = Boolean(target && appointee && bishops.some((theme) => theme.id === target.id) && !selectedReason);
    const preview = ready
      ? `${renderPlayerRoleName(state, appointee)} → ${renderTitleBadge(state, 'BISHOP', { holderId: appointee.id, themeId: target.id, compact: true })} of ${renderProvinceBadge(state, target, { compact: true, showOwnership: true })}`
      : selectedReason
        ? `<span class="muted">Cannot appoint: ${escapeHtml(selectedReason)}</span>`
        : null;
    return renderAppointmentSection({
      kind: 'bishop',
      title: 'Appoint',
      targetPicker: renderProvinceChoiceGrid(state, bishops, {
        attr: 'bishop-theme-pick',
        selectedId: appoint.themeId,
        getDisabledReason: (theme) => getTargetDisabledReason(state, playerId, powerKey, theme.id),
      }),
      playerPicker: renderPlayerChoiceGrid(state, {
        attr: 'bishop-player-pick',
        selectedId: appoint.playerId,
        getDisabledReason: (player) => getAppointeeDisabledReason(state, playerId, powerKey, bishops, player.id, target?.id || null),
      }),
      preview,
      buttonLabel: 'Appoint Bishop',
      buttonAttr: 'appoint-bishop',
      disabled: !ready,
    });
  }

  const strategoi = getStrategosTargets(state, playerId, powerKey);
  if (!strategoi.length) return '';
  const appoint = draft.appointStrategos || {};
  const target = appoint.themeId ? state.themes[appoint.themeId] : null;
  const appointee = appoint.playerId != null ? getPlayer(state, appoint.playerId) : null;
  const selectedReason = target && appointee
    ? getAppointmentDisabledReason(state, playerId, powerKey, target.id, appointee.id)
    : '';
  const ready = Boolean(target && appointee && strategoi.some((theme) => theme.id === target.id) && !selectedReason);
  const preview = ready
    ? `${renderPlayerRoleName(state, appointee)} → ${renderTitleBadge(state, 'STRATEGOS', { holderId: appointee.id, themeId: target.id, compact: true })} of ${renderProvinceBadge(state, target, { compact: true, showOwnership: true })}`
    : selectedReason
      ? `<span class="muted">Cannot appoint: ${escapeHtml(selectedReason)}</span>`
      : null;
  return renderAppointmentSection({
    kind: 'strategos',
    title: 'Appoint',
    targetPicker: renderProvinceChoiceGrid(state, strategoi, {
      attr: 'strategos-theme-pick',
      selectedId: appoint.themeId,
      getDisabledReason: (theme) => getTargetDisabledReason(state, playerId, powerKey, theme.id),
    }),
    playerPicker: renderPlayerChoiceGrid(state, {
      attr: 'strategos-player-pick',
      selectedId: appoint.playerId,
      getDisabledReason: (player) => getAppointeeDisabledReason(state, playerId, powerKey, strategoi, player.id, target?.id || null),
    }),
    preview,
    buttonLabel: 'Appoint Strategos',
    buttonAttr: 'appoint-strategos',
    disabled: !ready,
  });
}

function decorateRevocationTargets(state, targets) {
  return targets.map((target) => ({ ...target, badge: renderRevocationTargetBadge(state, target) }));
}

function renderCourtRevocationsForPower(state, playerId, draft, powerKey) {
  const targets = decorateRevocationTargets(state, getRevocationTargets(state, playerId, powerKey))
    .map((target) => {
      const result = validateCourtPayload(state, playerId, { action: 'revoke', value: target.value });
      return { ...target, disabledReason: result.ok ? '' : result.reason };
    });
  if (!targets.length) return '';
  const selectedValue = draft.revoke?.target || null;
  const selectedTarget = targets.find((t) => t.value === selectedValue);
  const ready = Boolean(selectedTarget && !selectedTarget.disabledReason);
  return `
    <section class="appointment-section revocation-section">
      <header class="appointment-section-head">
        <span class="appointment-section-title">Revoke</span>
      </header>
      <div class="appointment-step">
        ${renderPickerStep(1, 'Pick what to revoke')}
        ${renderRevocationChoiceGrid(state, targets, {
          attr: 'revoke-pick',
          selectedValue,
          getDisabledReason: (target) => target.disabledReason,
        })}
      </div>
      <div class="appointment-preview">
        ${ready
          ? `<span class="danger">Revoke</span> ${selectedTarget.badge}`
          : selectedTarget?.disabledReason
            ? `<span class="muted">Cannot revoke: ${escapeHtml(selectedTarget.disabledReason)}</span>`
            : '<span class="muted">Pick a target to revoke</span>'}
      </div>
      <div class="panel-actions">
        <button type="button" class="btn-danger" data-action="revoke" ${ready ? '' : 'disabled'}>Revoke</button>
      </div>
    </section>
  `;
}

function hasCourtAppointmentOptionsForPower(state, playerId, powerKey) {
  if (powerKey === 'BASILEUS') return false;
  if (powerKey === 'PATRIARCH') return getBishopTargets(state, playerId).length > 0;
  return getStrategosTargets(state, playerId, powerKey).length > 0;
}

function hasCourtRevocationOptionsForPower(state, playerId, powerKey) {
  return getRevocationTargets(state, playerId, powerKey).length > 0;
}

function getVisibleCourtPowerKeys(state, playerId) {
  const powers = new Set([
    ...roleKeysForCourt(state, playerId),
    ...getUsedCourtPowers(state, playerId),
  ]);
  return [...powers].filter((powerKey) => (
    isCourtPowerUsed(state, playerId, powerKey)
    || hasCourtAppointmentOptionsForPower(state, playerId, powerKey)
    || hasCourtRevocationOptionsForPower(state, playerId, powerKey)
  ));
}

function courtPowerCountLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function renderCourtPowerCard(state, playerId, draft, powerKey) {
  const usedKinds = getCourtPowerActionKinds(state, playerId, powerKey);
  const appointmentCount = getCourtPowerAppointmentCount(state, playerId, powerKey);
  const revocationCount = getCourtPowerRevocationCount(state, playerId, powerKey);
  const actionCount = getCourtPowerActionCount(state, playerId, powerKey);
  const mode = getCourtPowerUseMode(state, playerId, powerKey);
  const passed = isCourtPowerPassed(state, playerId, powerKey);
  const exhausted = isCourtPowerExhausted(state, playerId, powerKey);
  const usedSummary = usedKinds.length ? usedKinds.join(', ') : getCourtPowerActionKind(state, playerId, powerKey);
  const connectionsHtml = renderCourtConnectionsForPower(state, playerId, draft, powerKey);
  const actionLimit = getCourtPowerActionLimit(powerKey);
  const remainingActions = Math.max(0, actionLimit - actionCount);
  const usedParts = [
    appointmentCount ? courtPowerCountLabel(appointmentCount, 'appointment') : '',
    revocationCount ? courtPowerCountLabel(revocationCount, 'revocation') : '',
  ].filter(Boolean).join(', ');
  const stateText = actionCount
    ? `${actionCount}/${actionLimit} actions${usedParts ? ` (${usedParts})` : ''}`
    : passed
      ? 'Passed'
      : 'Choose actions';
  const hint = passed
    ? ''
    : actionCount > 0 && !exhausted
    ? `${courtPowerCountLabel(remainingActions, 'action')} remains for this office.`
    : !exhausted && powerKey === 'BASILEUS'
      ? `Up to ${actionLimit} revocations for this office this round.`
    : !exhausted
      ? `Up to ${actionLimit} appointments or revocations for this office this round.`
      : '';
  const doneText = passed
    ? `${getCourtPowerLabel(powerKey)} passed${actionCount ? ` after ${courtPowerCountLabel(actionCount, 'action')}` : ' with no action recorded'}.`
    : actionCount
    ? `${getCourtPowerLabel(powerKey)} ${courtPowerCountLabel(actionCount, 'action')} recorded${usedParts ? ` (${escapeHtml(usedParts)})` : ''}.`
    : `${getCourtPowerLabel(powerKey)} actions recorded${usedSummary ? `: ${escapeHtml(usedSummary)}` : ''}.`;
  const body = exhausted
    ? `<div class="panel-empty court-power-done">${doneText}</div>`
    : `
        <div class="court-link-stack">
          ${connectionsHtml || '<div class="choice-grid-empty">No links available</div>'}
        </div>
        <div class="panel-actions court-pass-actions">
          <button type="button" class="btn-secondary" data-action="pass-court-power" data-court-pass-power="${escapeHtml(powerKey)}">${actionCount ? 'Pass Remaining' : 'Pass'}</button>
        </div>
      `;
  const cardClass = [
    'court-power-card',
    exhausted ? 'used' : '',
    passed ? 'passed' : '',
    mode === 'appoint' ? 'appointment-mode' : '',
    mode === 'revoke' ? 'revocation-mode' : '',
    mode === 'mixed' ? 'mixed-mode' : '',
  ].filter(Boolean).join(' ');
  return `
    <section class="${cardClass}" data-court-power="${powerKey}">
      <header class="court-power-head">
        ${renderCourtPowerBadge(state, playerId, powerKey)}
        <span class="court-power-state">${stateText}</span>
      </header>
      ${hint ? `<p class="section-hint">${hint}</p>` : ''}
      ${body}
    </section>
  `;
}

export function renderCourtPanel(container, state, activePlayerId, callbacks = {}, options = {}) {
  if (!container || !state) return;
  const draft = getDraftBucket(options.uiState, state, 'court', activePlayerId);
  if (!draft.appointStrategos) draft.appointStrategos = {};
  if (!draft.appointBishop) draft.appointBishop = {};
  if (!draft.revoke) draft.revoke = {};
  const powerKeys = getVisibleCourtPowerKeys(state, activePlayerId);
  const confirmed = Boolean(state.courtActions?.playerConfirmed?.has(activePlayerId));
  const rerender = () => renderCourtPanel(container, state, activePlayerId, callbacks, options);
  container.innerHTML = `
    <section class="phase-card court-panel">
      ${powerKeys.length ? `
        <div class="court-power-stack">
          ${powerKeys.map((powerKey) => renderCourtPowerCard(state, activePlayerId, draft, powerKey)).join('')}
        </div>
      ` : `<div class="panel-empty">${confirmed ? 'Court business complete.' : 'No court actions available.'}</div>`}
    </section>
  `;

  // Picker click handlers — store in draft, re-render to update visuals.
  const onPick = (selector, draftKey, prop, transform = (v) => v) => {
    const datasetKey = datasetKeyFromSelector(selector);
    container.querySelectorAll(selector).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
        const value = transform(btn.dataset[datasetKey] ?? '');
        const next = { ...(draft[draftKey] || {}), [prop]: value };
        draft[draftKey] = next;
        rerender();
      });
    });
  };
  onPick('[data-strategos-theme-pick]', 'appointStrategos', 'themeId');
  onPick('[data-strategos-player-pick]','appointStrategos', 'playerId',  (v) => Number(v));
  onPick('[data-bishop-theme-pick]',    'appointBishop',    'themeId');
  onPick('[data-bishop-player-pick]',   'appointBishop',    'playerId',  (v) => Number(v));
  onPick('[data-revoke-pick]',          'revoke',           'target');

  bindSelectAction(container, '[data-action="appoint-strategos"]', () => {
    const { themeId, playerId } = draft.appointStrategos || {};
    if (!themeId || playerId == null) return;
    callbacks['appoint-strategos']?.(
      regionTitleFor(state.themes[themeId]),
      themeId,
      playerId,
    );
  });
  bindSelectAction(container, '[data-action="appoint-bishop"]', () => {
    const { themeId, playerId } = draft.appointBishop || {};
    if (!themeId || playerId == null) return;
    callbacks['appoint-bishop']?.(themeId, playerId);
  });
  bindSelectAction(container, '[data-action="revoke"]', () => {
    const target = draft.revoke?.target;
    if (!target) return;
    callbacks.revoke?.(target);
  });
  container.querySelectorAll('[data-link-revoke]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;
      const target = button.dataset.linkRevoke;
      if (!target) return;
      callbacks.revoke?.(target);
    });
  });
  bindSelectAction(container, '[data-action="pass-court-power"]', (btn) => {
    const powerKey = btn.dataset.courtPassPower;
    if (!powerKey) return;
    callbacks['pass-court-power']?.(powerKey);
  });
}

export function renderEstatesPanel(container, state, playerId, callbacks = {}) {
  const freeThemes = getFreeThemes(state);
  const activeBidderId = Number(playerId);
  const reserve = getAvailableLandBidGold(state, activeBidderId);
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
            const ownAmount = Number(ownBid?.amount) || 0;
            const bidAmounts = getLandBidAmountOptions(state, activeBidderId, theme.id);
            const maxBid = bidAmounts.at(-1) || 0;
            const cannotAfford = bidAmounts.length === 0;
            const inputValue = ownAmount || minimum;
            const bidButtonLabel = ownBid ? 'Update Bid' : 'Place Bid';
            return `
              <article class="estate-card${cannotAfford ? ' disabled' : ''}${ownBid ? ' selected' : ''}" data-estate="${theme.id}" data-map-province="${theme.id}">
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
                ${ownBid ? `
                  <div class="estate-current-bid owned sealed">
                    <span class="estate-current-label">Your bid</span>
                    <span class="estate-current-bidder">Hidden until reveal</span>
                    <span class="estate-current-amount">${formatGoldHtml(ownAmount)}</span>
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
      <div class="panel-actions">
        <button type="button" class="${ready ? 'btn-secondary' : 'btn-primary'}" data-action="confirm-estates">${ready ? 'Keep Editing Bids' : 'Lock Bids'}</button>
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
      callbacks.buy?.(themeId, { amount: Number(container.querySelector(`[data-estate-bid="${themeId}"]`)?.value) });
    });
  });
  bindSelectAction(container, '[data-action="confirm-estates"]', () => callbacks.confirmEstates?.());
}

function getPlayerArmyKeys(state, playerId) {
  return getPlayerDeploymentArmyKeys(state, playerId);
}

function getArmyMaxTroops(state, playerId, officeKey) {
  return getDeploymentArmyTroopTotal(state, playerId, officeKey);
}

function ensureDeploymentDraft(state, draft, armyKeys) {
  for (const officeKey of armyKeys) {
    if (!draft.armies[officeKey]) draft.armies[officeKey] = {};
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
    if (normalizedFunded(order.funded, max) == null) missing.push(`${officeKey}:funding`);
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
  if (readiness?.ready) return 'Every army has a funding choice and a destination. You can lock deployment.';
  const missing = Array.isArray(readiness?.missing) ? readiness.missing : [];
  const needsFunding = missing.some((entry) => String(entry).endsWith(':funding'));
  const needsDestination = missing.some((entry) => String(entry).endsWith(':destination'));
  const needsRanking = missing.includes('ranking');
  const parts = [];
  if (needsFunding) parts.push('move each army funding slider');
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
    const funded = normalizedFunded(order.funded, totalTroops) ?? 0;
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
  const unfundedGold = armyKeys.reduce((sum, key) => (
    sum + Math.max(0, getArmyMaxTroops(state, playerId, key) - (Number(draft.armies[key]?.funded) || 0))
  ), 0);
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
    rows.push(`Coup rank: ${escapeHtml(playerDisplayLabel(candidate))} stays pledged`);
  }
  for (const office of orderLocks.officeSelections || []) {
    const destination = office.destination === 'capital' ? 'Capital' : 'Frontier';
    rows.push(`${escapeHtml(office.officeName || office.officeKey)} -> ${destination}`);
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
  const preferenceLabel = topPreference ? escapeHtml(playerDisplayLabel(topPreference)) : 'Rank claimants';
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
  ensureDeploymentDraft(state, draft, armyKeys);
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
      <p class="section-hint">Move each army slider to pick how many troops are funded, then choose Frontier or Capital for every deployed force.</p>
      ${alreadyLocked ? '<div class="panel-empty">Deployment orders locked.</div>' : `
        ${lockNotice}
        ${deploymentPreview}
        <div class="army-card-stack">
          ${armyKeys.map((officeKey) => {
            const entry = getDeploymentArmyTroopEntry(state, playerId, officeKey);
            const max = getArmyMaxTroops(state, playerId, officeKey);
            const current = draft.armies[officeKey];
            const currentFunded = normalizedFunded(current.funded, max);
            const sliderValue = currentFunded ?? 0;
            const idleGold = currentFunded == null ? null : Math.max(0, max - currentFunded);
            const lockedDestination = lockedDestinations[officeKey] || null;
            const lockedLabel = lockedDestination === 'capital' ? 'Capital' : lockedDestination === 'frontier' ? 'Frontier' : null;
            const needsFunding = currentFunded == null;
            const needsDestination = !isDeploymentDestination(current.destination);
            const fundingText = needsFunding ? 'Move slider' : `${currentFunded}/${max} funded`;
            const destinationText = needsDestination
              ? 'Choose destination'
              : current.destination === 'capital'
                ? 'Capital'
                : 'Frontier';
            const sourceCount = isStrategosDeploymentArmyKey(officeKey)
              ? getDeploymentArmySourceKeys(state, playerId, officeKey).length
              : 0;
            return `
              <article class="army-card${needsFunding || needsDestination ? ' unresolved' : ''}" data-army-card="${officeKey}">
                <header class="army-card-head">
                  <span class="army-card-title">${renderArmyOfficeBadge(state, officeKey, playerId)}</span>
                  <span class="army-card-count">${formatTroopsHtml(max, { label: 'Troops' })}</span>
                </header>
                ${sourceCount > 1 ? `<p class="army-card-sub">${sourceCount} Strategos commands combined.</p>` : ''}
                ${entry.capitalLocked ? `<p class="army-card-sub">${formatTroopsHtml(entry.capitalLocked)} capital locked</p>` : ''}
                ${lockedLabel ? `<p class="army-card-sub order-locked-sub">Deal lock: must deploy to ${lockedLabel}.</p>` : ''}
                <div class="army-card-readiness">
                  <span class="readiness-pill${needsFunding ? ' missing' : ' ready'}">Funding: ${escapeHtml(fundingText)}</span>
                  <span class="readiness-pill${needsDestination ? ' missing' : ' ready'}">Destination: ${escapeHtml(destinationText)}</span>
                </div>
                <label class="army-card-slider">
                  <span class="army-slider-label">Fund</span>
                  <input type="range" min="0" max="${max}" value="${sliderValue}" data-army-funded="${officeKey}" ${lockedDestination ? 'disabled' : ''}>
                  <span class="army-slider-readout">
                    <span class="army-slider-num${needsFunding ? ' unresolved' : ''}" data-funded-readout="${officeKey}">${needsFunding ? 'Pick' : currentFunded}</span>
                    <span class="army-slider-cost" data-funded-cost="${officeKey}" title="Gold from idle troops">${idleGold == null ? '<span class="muted">Pick</span>' : formatGoldHtml(idleGold, { signed: true, tone: 'income' })}</span>
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

        <div class="panel-actions">
          <p class="deployment-lock-help${readiness.ready && !totals.overBudget ? ' ready' : ''}" data-deployment-lock-help>${escapeHtml(lockHelp)}</p>
          <button type="button" class="btn-primary" data-action="lock-orders" ${totals.overBudget || !readiness.ready ? 'disabled' : ''}>${totals.overBudget ? 'Need More Gold' : readiness.ready ? 'Lock Deployment' : 'Finish Deployment'}</button>
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
    ensureDeploymentRanking(state, playerId, draft, candidateLockedId);
    callbacks.lockOrders?.({
      armies: draft.armies,
      mercenaries: draft.mercenaries,
      ranking: draft.ranking.slice(),
      candidateSupport: { ...normalizeCoupSupport(state, draft.candidateSupport, candidateLockedId) },
      candidate: draft.candidate == null ? null : Number(draft.candidate),
    });
  });
}

export function renderResolutionPanel(container, state, options = {}) {
  return renderResolutionPanelDetailed(container, state, options);
}

function getCurrentOrderRevealEvents(state) {
  return (state.history || [])
    .filter((event) => event?.type === 'orders_revealed')
    .filter((event) => Number(event.round ?? state.round) === Number(state.round))
    .sort((a, b) => Number(a.actorId) - Number(b.actorId));
}

function destinationLabel(value) {
  return value === 'capital' ? 'Capital' : 'Frontier';
}

function renderDeploymentOfficeRevealRows(state, playerId, offices) {
  if (!offices.length) return '';
  return `
    <div class="deployment-reveal-office-list">
      ${offices.map((office) => {
        const totalTroops = Math.max(0, Number(office.totalTroops) || 0);
        const fundedTroops = Math.max(0, Number(office.fundedTroops) || 0);
        const unfundedTroops = Math.max(0, Number(office.unfundedTroops) || 0);
        const capitalTroops = Math.max(0, Number(office.capitalTroops) || 0);
        const frontierTroops = Math.max(0, Number(office.frontierTroops) || 0);
        return `
          <div class="deployment-reveal-office-row">
            <span class="deployment-reveal-office-name">${renderArmyOfficeBadge(state, office.officeKey, playerId)}</span>
            <span>${formatTroopsHtml(fundedTroops)} funded of ${formatTroopsHtml(totalTroops)}</span>
            <span>${formatTroopsHtml(unfundedTroops)} stayed home</span>
            <span>${destinationLabel(office.destination)}: ${formatTroopsHtml(office.destination === 'capital' ? capitalTroops : frontierTroops)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderDeploymentRevealSection(state) {
  const events = getCurrentOrderRevealEvents(state);
  if (!events.length) return '';
  return `
    <details class="deployment-reveal-details">
      <summary class="deployment-reveal-summary">
        <span>Deployment Details</span>
        <span>funding, mercenaries, and destinations</span>
      </summary>
      <article class="result-card deployment-reveal-card">
      <header class="result-card-head">
        <span class="result-card-kicker">Deployment Reveal</span>
        <span class="result-card-against">funded troops, troops kept home, mercenaries, and destinations</span>
      </header>
      <div class="deployment-reveal-list">
        ${events.map((event) => {
          const details = event.details || {};
          const playerId = Number(event.actorId);
          const player = getPlayer(state, playerId);
          const offices = Array.isArray(details.offices) ? details.offices : [];
          const fundedTroops = offices.reduce((total, office) => total + Math.max(0, Number(office.fundedTroops) || 0), 0);
          const unfundedTroops = offices.reduce((total, office) => total + Math.max(0, Number(office.unfundedTroops) || 0), 0);
          const capitalTroops = Math.max(0, Number(details.capitalTroops) || 0);
          const frontierTroops = Math.max(0, Number(details.frontierTroops) || 0);
          const passiveCapitalSupport = Math.max(0, Number(details.passiveCapitalSupport) || 0);
          const mercenaries = details.mercenaries || {};
          const mercenaryCount = Math.max(0, Number(mercenaries.count) || 0);
          const mercenaryDestination = mercenaryCount > 0 ? destinationLabel(mercenaries.destination) : 'None';
          return `
            <section class="deployment-reveal-player">
              <header class="deployment-reveal-player-head">
                ${player ? renderPlayerRoleName(state, player) : escapeHtml(event.actorName || `Player ${playerId + 1}`)}
                <span>${formatTroopsHtml(capitalTroops)} Capital · ${formatTroopsHtml(frontierTroops)} Frontier</span>
              </header>
              <div class="deployment-reveal-pills">
                <span>Funded ${formatTroopsHtml(fundedTroops)}</span>
                <span>Stayed home ${formatTroopsHtml(unfundedTroops)}</span>
                <span>Mercenaries ${formatMercenariesHtml(mercenaryCount)} ${mercenaryCount ? `to ${mercenaryDestination}` : ''}</span>
                <span>Passive capital support ${renderValue('troop', passiveCapitalSupport, { displayValue: Math.round(passiveCapitalSupport * 100) / 100 })}</span>
              </div>
              ${renderDeploymentOfficeRevealRows(state, playerId, offices)}
            </section>
          `;
        }).join('')}
      </div>
      </article>
    </details>
  `;
}

export function renderResolutionPanelDetailed(container, state, options = {}) {
  if (!container || !state) return;
  const rewards = Array.isArray(state.pendingDefenderRewards) ? state.pendingDefenderRewards.filter((reward) => !reward.resolved) : [];
  const war = state.lastWarResult;
  const coup = state.lastCoupResult;
  const empireFell = Boolean(war?.reachedCPL) || state.gameOver?.type === 'fall';
  const invasionName = state.currentInvasion?.name || 'the invader';

  const deploymentRevealSection = renderDeploymentRevealSection(state);
  const warSection = war ? renderWarResultCard(state, war, invasionName, empireFell) : '';
  const coupSection = coup ? renderCoupResultCard(state, coup) : '';
  const rewardsSection = rewards.length ? renderDefenderRewardSection(state, rewards) : '';
  const empireFallenBanner = empireFell
    ? `<div class="empire-fall-banner">
        <span class="empire-fall-kicker">Empire Fallen</span>
        <span class="empire-fall-body">${escapeHtml(invasionName)} reached Constantinople. The empire is no more.</span>
      </div>`
    : '';

  container.innerHTML = `
    <section class="phase-card resolution-panel">
      <h3>Resolve Turn</h3>
      ${empireFallenBanner}
      ${warSection}
      ${coupSection}
      ${deploymentRevealSection}
      ${rewardsSection}
      <div class="panel-actions">
        <button type="button" class="btn-primary" data-action="continue">Continue</button>
      </div>
    </section>
  `;
}

function renderWarResultCard(state, war, invasionName, empireFell) {
  const outcome = war.outcome || (war.frontierTroops > war.invaderStrength ? 'victory' : war.frontierTroops < war.invaderStrength ? 'defeat' : 'stalemate');
  const outcomeLabel = empireFell ? 'Empire falls' : outcome.toUpperCase();
  const empireTroops = Math.max(0, Number(war.frontierTroops) || 0);
  const invaderStrength = Math.max(0, Number(war.invaderStrength) || 0);
  const themesLost = Array.isArray(war.themesLost) ? war.themesLost : [];
  const themesRecovered = Array.isArray(war.themesRecovered) ? war.themesRecovered : [];
  const frontierBreakdown = renderFrontierContributionBreakdown(state, war.contributions);
  const reconquestReward = war.reconquestReward || null;

  return `
    <article class="result-card war-result war-${outcome}${empireFell ? ' empire-fell' : ''}">
      <header class="result-card-head">
        <span class="result-card-kicker">War</span>
        <span class="result-card-against">vs <strong>${escapeHtml(invasionName)}</strong></span>
        <span class="war-outcome-badge">${escapeHtml(outcomeLabel)}</span>
      </header>
      <div class="war-tug">
        <div class="war-tug-side empire">
          <span class="war-tug-label">Empire</span>
          <span class="war-tug-value">${formatTroopsHtml(empireTroops)}</span>
        </div>
        <span class="war-tug-vs">vs</span>
        <div class="war-tug-side invader">
          <span class="war-tug-label">Invader</span>
          <span class="war-tug-value">${formatTroopsHtml(invaderStrength)}</span>
        </div>
      </div>
      ${frontierBreakdown}
      ${themesLost.length ? `
        <div class="war-result-row lost">
          <span class="war-result-row-label">Lost to the invader</span>
          <div class="war-result-tokens">${themesLost.map((id) => renderProvinceBadge(state, state.themes[id] || { id, name: id }, { compact: true })).join(' ')}</div>
        </div>
      ` : ''}
      ${themesRecovered.length ? `
        <div class="war-result-row recovered">
          <span class="war-result-row-label">Reclaimed for the empire</span>
          <div class="war-result-tokens">${themesRecovered.map((id) => renderProvinceBadge(state, state.themes[id] || { id, name: id }, { compact: true })).join(' ')}</div>
        </div>
      ` : ''}
      ${reconquestReward ? renderReconquestRewardRow(state, reconquestReward) : ''}
    </article>
  `;
}

function getReconquestRewardRecipients(reward) {
  if (Array.isArray(reward?.defenders) && reward.defenders.length) return reward.defenders;
  if (!reward) return [];
  return [{
    defenderId: reward.defenderId,
    defenderName: reward.defenderName,
    gold: reward.gold,
    capitalSupport: reward.capitalSupport,
  }];
}

function renderReconquestRewardRow(state, reward) {
  const recipients = getReconquestRewardRecipients(reward);
  if (!recipients.length) return '';
  const split = recipients.length > 1;
  const recoveredCount = Array.isArray(reward.themeIds) ? reward.themeIds.length : 0;
  const rewardProvinceCount = Math.max(
    recoveredCount,
    Number(reward.rewardProvinceCount ?? reward.totalGold ?? reward.totalCapitalSupport) || 0,
  );
  const repulseNote = rewardProvinceCount > recoveredCount
    ? `<span class="muted">Repulse value: ${rewardProvinceCount} province win${rewardProvinceCount === 1 ? '' : 's'}.</span>`
    : '';
  return `
    <div class="war-result-row recovered reconquest-reward-row">
      <span class="war-result-row-label">${split ? 'Triumph split' : 'Triumph'}</span>
      <div class="reward-card-body">
        ${recipients.map((recipient) => {
          const defender = getPlayer(state, Number(recipient.defenderId));
          return `
            <div class="reward-recipient">
              ${defender ? renderPlayerRoleName(state, defender) : escapeHtml(recipient.defenderName || 'Top defender')}
              <span class="muted">gains ${formatGoldHtml(recipient.gold || 0)} and ${renderValue('troop', recipient.capitalSupport || 0, { signed: true })} in Constantinople next round.</span>
            </div>
          `;
        }).join('')}
        ${repulseNote}
      </div>
    </div>
  `;
}

function renderFrontierContributionBreakdown(state, contributions = []) {
  const rows = (Array.isArray(contributions) ? contributions : [])
    .map((entry) => ({
      playerId: Number(entry.playerId),
      playerName: entry.playerName,
      troops: Math.max(0, Number(entry.troops) || 0),
    }))
    .filter((entry) => entry.troops > 0)
    .sort((a, b) => (b.troops - a.troops) || (a.playerId - b.playerId));

  return `
    <div class="vote-breakdown frontier-breakdown">
      <div class="frontier-breakdown-title">Frontier contributions</div>
      ${rows.length ? rows.map((row) => {
        const player = getPlayer(state, row.playerId);
        return `
          <div class="vote-row frontier-row">
            <span class="vote-candidate">
              ${renderPlayerRoleName(state, player, row.playerName || `Player ${row.playerId + 1}`)}
            </span>
            <span class="vote-troops frontier-troops">${formatTroopsHtml(row.troops)}</span>
          </div>
        `;
      }).join('') : '<p class="muted frontier-empty">No frontier troops were committed.</p>'}
    </div>
  `;
}

function renderCoupTieBreakNote(state, coup) {
  const tieBreak = coup?.tieBreak || null;
  const tiedIds = Array.isArray(tieBreak?.tiedCandidateIds) ? tieBreak.tiedCandidateIds : [];
  if (!tieBreak?.method || tiedIds.length < 2) return '';
  const winner = getPlayer(state, Number(coup.winner));
  const winnerName = winner ? renderPlayerRoleName(state, winner) : escapeHtml(`Player ${Number(coup.winner) + 1}`);
  const support = Number(tieBreak.patriarchSupport?.[Number(coup.winner)]) || 0;
  const text = tieBreak.method === 'patriarch'
    ? `${winnerName} wins the tied coup with ${renderValue('troop', support, { displayValue: Math.round(support * 100) / 100 })} of Patriarchal support.`
    : tieBreak.method === 'incumbent'
      ? 'Patriarchal support is still tied, so the sitting Basileus keeps the throne.'
      : 'Patriarchal support is still tied, so the remaining tie falls to dynasty order.';
  return `<div class="coup-tie-break">${text}</div>`;
}

function renderCoupResultCard(state, coup) {
  const winnerId = coup.winner;
  const winner = getPlayer(state, winnerId);
  const heldThrone = winnerId === state.basileusId;
  const votes = coup.votes || {};
  const contributions = Array.isArray(coup.contributions) ? coup.contributions : [];
  const ballots = Array.isArray(coup.ballots) ? coup.ballots : contributions;
  const voteRows = Object.entries(votes)
    .map(([candidateId, troops]) => ({ candidateId: Number(candidateId), troops: Number(troops) || 0 }))
    .filter((row) => row.troops !== 0)
    .sort((a, b) => (b.troops - a.troops) || (a.candidateId - b.candidateId));
  const zeroBallots = ballots
    .filter((ballot) => Math.max(0, Number(ballot.troops) || 0) <= 0)
    .sort((a, b) => Number(a.playerId) - Number(b.playerId));
  const zeroBallotSummary = zeroBallots.length
    ? `No capital troops from ${zeroBallots.map((ballot) => {
      const voter = getPlayer(state, Number(ballot.playerId));
      return `${escapeHtml(playerDisplayLabel(voter))}`;
    }).join(', ')}.`
    : '';

  return `
    <article class="result-card coup-result">
      <header class="result-card-head">
        <span class="result-card-kicker">Coup</span>
        <span class="coup-outcome-badge ${heldThrone ? 'held' : 'changed'}">${heldThrone ? 'Throne held' : 'New Basileus'}</span>
      </header>
      <div class="coup-winner-line">
        ${winner ? renderPlayerRoleName(state, winner) : 'Vacant'}
        <span class="muted">${heldThrone ? 'holds the throne' : 'claims the throne'}</span>
      </div>
      ${renderCoupTieBreakNote(state, coup)}
      ${voteRows.length ? `
        <div class="vote-breakdown">
          ${voteRows.map((row) => {
            const supporters = contributions
              .filter((entry) => Number(entry.candidateId) === row.candidateId && (Number(entry.votes ?? entry.troops) || 0) !== 0)
              .sort((a, b) => (Number(b.votes ?? b.troops) - Number(a.votes ?? a.troops)) || (Number(a.playerId) - Number(b.playerId)));
            return `
              <div class="vote-row">
                <span class="vote-candidate">
                  ${renderPlayerRoleName(state, getPlayer(state, row.candidateId), `Player ${row.candidateId + 1}`)}
                  ${supporters.length ? `
                    <span class="vote-supporters">
                      ${supporters.map((entry) => {
                        const supporter = getPlayer(state, Number(entry.playerId));
                        const value = Number(entry.votes ?? entry.troops) || 0;
                        const sourceLabel = entry.passive
                          ? escapeHtml(entry.supportLabel || 'Passive support')
                          : escapeHtml(playerDisplayLabel(supporter));
                        return `${sourceLabel} ${renderValue('troop', value, { signed: entry.passive, displayValue: Math.round(value * 100) / 100 })}`;
                      }).join(' ')}
                    </span>
                  ` : ''}
                </span>
                <span class="vote-troops">${renderValue('troop', row.troops, { signed: true, displayValue: Math.round(row.troops * 100) / 100 })}</span>
              </div>
            `;
          }).join('')}
          ${zeroBallotSummary ? `
            <div class="vote-zero-list">
              ${zeroBallotSummary}
            </div>
          ` : ''}
        </div>
      ` : `<p class="muted">No capital troops were committed.${zeroBallotSummary ? ` ${zeroBallotSummary}` : ''}</p>`}
    </article>
  `;
}

function renderDefenderRewardSection(state, rewards) {
  return `
    <div class="reward-section">
      ${renderPickerStep('⚑', `${rewards.length} defender reward${rewards.length === 1 ? '' : 's'} to settle`)}
      <div class="reward-list">
        ${rewards.map((reward) => renderDefenderRewardCard(state, reward)).join('')}
      </div>
    </div>
  `;
}

function renderDefenderRewardCard(state, reward) {
  const theme = state.themes[reward.themeId] || { id: reward.themeId, name: reward.themeName || reward.themeId };
  const defender = getPlayer(state, reward.defenderId);
  const gold = Math.max(0, Number(reward.goldValue) || 0);
  const rank = Number(reward.rank) || 1;
  const rankSuffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
  return `
    <article class="reward-card" data-reward-id="${reward.id}">
      <header class="reward-card-head">
        ${renderProvinceBadge(state, theme, { showValues: true })}
        <span class="reward-card-rank">${rank}${rankSuffix} defender</span>
      </header>
      <div class="reward-card-body">
        ${defender ? renderPlayerRoleName(state, defender) : 'Defender'}
        <span class="muted">contributed ${formatTroopsHtml(reward.troops || 0)} to the frontier.</span>
      </div>
      <div class="reward-card-choice">
        <button type="button" class="btn-primary reward-choice-restore" data-defender-reward-choice data-reward-id="${reward.id}" data-choice="empire">
          <span class="reward-choice-kicker">Restore</span>
          <span class="reward-choice-desc">Return ${renderProvinceBadge(state, theme, { compact: true })} to the empire</span>
        </button>
        <button type="button" class="btn-secondary reward-choice-gold" data-defender-reward-choice data-reward-id="${reward.id}" data-choice="gold">
          <span class="reward-choice-kicker">Take</span>
          <span class="reward-choice-desc">${formatGoldHtml(gold)} into your reserve (province stays occupied)</span>
        </button>
      </div>
    </article>
  `;
}
