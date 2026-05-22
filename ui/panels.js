// ui/panels.js - compact phase panels for the updated ruleset.
import { MAJOR_TITLES } from '../data/titles.js';
import { readTroopEntry, runIncome } from '../engine/cascade.js';
import { applyCourtAction } from '../engine/commands.js';
import {
  COURT_POWER_ACTION_LIMIT,
  getCourtPowerActionCount,
  getCourtPowerAppointmentCount,
  getCourtPowerActionKinds,
  getCourtPowerActionKind,
  getCourtPowerRevocationCount,
  getCourtPowerUseMode,
  getUsedCourtPowers,
  isCourtPowerExhausted,
  isCourtPowerUsed,
  getMinimumLandBid,
  suggestMajorTitleAssignments,
} from '../engine/actions.js';
import { getMercenaryHireCost, getThemeLandPrice } from '../engine/rules.js';
import { getFreeThemes, getOfficeDisplayName, getOfficeHolder, getPlayer, getPlayerPrimaryRoleKey, getBishopThemes } from '../engine/state.js';
import {
  formatGoldHtml,
  formatTroopsHtml,
  formatChurchHtml,
  formatMercenariesHtml,
} from '../engine/presentation.js';
import { renderIcon } from './icons.js';
import {
  getPlayerStyleAttr,
  renderPlayerRoleName,
  renderProvinceBadge,
  renderProvinceOwnerMarker,
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
    && theme.owner !== 'church'
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
  for (const theme of Object.values(state.themes || {})) {
    if (theme.id === 'CPL') continue;
    if (theme.strategos != null && roles.has(regionTitleFor(theme))) {
      targets.push({ value: `minor:${theme.id}:strategos`, label: `Strategos of ${theme.name}` });
    }
    if (theme.bishop != null && roles.has('PATRIARCH')) {
      targets.push({ value: `minor:${theme.id}:bishop`, label: `Bishop of ${theme.name}` });
    }
    if ((powerKey == null || powerKey === 'BASILEUS') && playerId === state.basileusId && theme.owner != null && !theme.occupied) {
      targets.push({ value: `theme:${theme.id}`, label: `${theme.owner === 'church' ? 'Church land' : 'Estate'} in ${theme.name}` });
    }
  }
  if ((powerKey == null || powerKey === 'BASILEUS') && playerId === state.basileusId && state.empress != null) targets.push({ value: 'court:EMPRESS', label: 'Empress' });
  if ((powerKey == null || powerKey === 'BASILEUS') && playerId === state.basileusId && state.chiefEunuchs != null) targets.push({ value: 'court:CHIEF_EUNUCHS', label: 'Chief of Eunuchs' });
  return targets;
}

function bindSelectAction(container, selector, callback) {
  container.querySelectorAll(selector).forEach((node) => {
    node.addEventListener('click', () => callback?.(node));
  });
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
            ${renderProvinceBadge(state, theme, { showValues: true })}
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

function renderArmyOfficeBadge(state, officeKey) {
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
  const initial = options.assignments || suggestMajorTitleAssignments(state, state.basileusId);
  if (!draft.assignments) draft.assignments = { ...initial };
  const eligible = state.players.filter((player) => player.id !== state.basileusId);
  const rerender = () => renderTitleRedistributionPanel(container, state, playerId, callbacks, options);

  container.innerHTML = `
    <section class="phase-card title-redistribution-panel">
      <h3>Redistribute Major Titles</h3>
      <p class="section-hint">${isBasileus ? 'Assign each major office to an eligible player before Court opens.' : 'Waiting for the Basileus to assign the major titles.'}</p>
      <div class="title-redist-stack">
        ${Object.entries(MAJOR_TITLES).map(([titleKey, title]) => {
          const assigned = Number(draft.assignments[titleKey]);
          const assignedPlayer = Number.isFinite(assigned) ? getPlayer(state, assigned) : null;
          return `
            <section class="title-redist-row">
              <header class="title-redist-row-head">
                ${renderTitleBadge(state, titleKey, { holderId: assignedPlayer?.id, compact: false, label: title.name })}
                ${assignedPlayer ? `<span class="title-redist-arrow">→</span> ${renderPlayerRoleName(state, assignedPlayer)}` : '<span class="muted">vacant</span>'}
              </header>
              <input type="hidden" data-title-assignment="${titleKey}" value="${assignedPlayer?.id ?? ''}">
              ${isBasileus ? renderPlayerChoiceGrid(state, {
                attr: 'title-redist-pick',
                selectedId: assignedPlayer?.id ?? null,
                excludeIds: [state.basileusId],
                players: eligible,
              }).replace('player-choice-grid', `player-choice-grid title-redist-grid-${titleKey}`) : ''}
            </section>
          `;
        }).join('')}
      </div>
      <p class="form-error" data-role="title-reassignment-error"></p>
      <div class="panel-actions">
        <button type="button" class="btn-primary" data-action="confirm-title-redistribution" ${isBasileus ? '' : 'disabled'}>Confirm Titles</button>
      </div>
    </section>
  `;

  if (isBasileus) {
    Object.keys(MAJOR_TITLES).forEach((titleKey) => {
      const scope = container.querySelector(`.title-redist-grid-${titleKey}`);
      if (!scope) return;
      scope.querySelectorAll('[data-title-redist-pick]').forEach((btn) => {
        btn.addEventListener('click', () => {
          draft.assignments[titleKey] = Number(btn.dataset.titleRedistPick);
          rerender();
        });
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
  const history = Array.isArray(state.history) ? state.history.slice(-30).reverse() : [];
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
  const courtTargets = playerId === state.basileusId
    ? [
      state.empress == null ? { key: 'EMPRESS', kind: 'EMPRESS', label: 'Empress' } : null,
      state.chiefEunuchs == null ? { key: 'CHIEF_EUNUCHS', kind: 'CHIEF_EUNUCHS', label: 'Chief of Eunuchs' } : null,
    ].filter(Boolean)
    : [];
  if (!strategoi.length && !bishops.length && !courtTargets.length) return '';

  const sections = [];

  // Court titles (Empress / Chief of Eunuchs) — only the Basileus can fill.
  if (courtTargets.length) {
    const appoint = draft.appointCourt || {};
    const target = courtTargets.find((entry) => entry.key === appoint.title) || null;
    const appointee = appoint.playerId != null ? getPlayer(state, appoint.playerId) : null;
    const ready = Boolean(target && appointee);
    const preview = ready
      ? `${renderPlayerRoleName(state, appointee)} → ${renderTitleBadge(state, target.kind, { holderId: appointee.id, label: target.label, compact: true })}`
      : null;
    sections.push(renderAppointmentSection({
      kind: 'court',
      title: 'Court title',
      targetPicker: renderTitleChoiceGrid(state, courtTargets, { attr: 'court-title-pick', selectedKey: appoint.title }),
      playerPicker: renderPlayerChoiceGrid(state, { attr: 'court-player-pick', selectedId: appoint.playerId }),
      preview,
      buttonLabel: 'Appoint',
      buttonAttr: 'appoint-court',
      disabled: !ready,
    }));
  }

  // Strategoi (regional governors)
  if (strategoi.length) {
    const appoint = draft.appointStrategos || {};
    const target = appoint.themeId ? state.themes[appoint.themeId] : null;
    const appointee = appoint.playerId != null ? getPlayer(state, appoint.playerId) : null;
    const ready = Boolean(target && appointee);
    const preview = ready
      ? `${renderPlayerRoleName(state, appointee)} → ${renderTitleBadge(state, 'STRATEGOS', { holderId: appointee.id, themeId: target.id, compact: true })} of ${renderProvinceBadge(state, target, { compact: true })}`
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
      ? `${renderPlayerRoleName(state, appointee)} → ${renderTitleBadge(state, 'BISHOP', { holderId: appointee.id, themeId: target.id, compact: true })} of ${renderProvinceBadge(state, target, { compact: true })}`
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
  // Decorate each target with a cartouche badge so the choice grid looks
  // like the appointment row, not a flat list.
  const targets = rawTargets.map((target) => {
    let badge = '';
    if (target.value.startsWith('minor:')) {
      const [, themeId, kind] = target.value.split(':');
      const theme = state.themes[themeId];
      if (theme) {
        const titleKind = kind === 'strategos' ? 'STRATEGOS' : 'BISHOP';
        const holderId = kind === 'strategos' ? theme.strategos : theme.bishop;
        badge = `${renderTitleBadge(state, titleKind, { holderId, themeId, compact: true })} ${renderProvinceBadge(state, theme, { compact: true })}`;
      }
    } else if (target.value.startsWith('theme:')) {
      const themeId = target.value.split(':')[1];
      const theme = state.themes[themeId];
      if (theme) {
        const ownerLabel = theme.owner === 'church' ? 'Church land' : 'Estate';
        badge = `<span class="muted">${ownerLabel}</span> ${renderProvinceOwnerMarker(state, theme, { compact: true })} ${renderProvinceBadge(state, theme, { compact: true })}`;
      }
    } else if (target.value === 'court:EMPRESS') {
      badge = renderTitleBadge(state, 'EMPRESS', { holderId: state.empress, compact: true });
    } else if (target.value === 'court:CHIEF_EUNUCHS') {
      badge = renderTitleBadge(state, 'CHIEF_EUNUCHS', { holderId: state.chiefEunuchs, compact: true });
    }
    return { ...target, badge };
  });
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

function getCourtTitleTargets(state, playerId) {
  return playerId === state.basileusId
    ? [
      state.empress == null ? { key: 'EMPRESS', kind: 'EMPRESS', label: 'Empress' } : null,
      state.chiefEunuchs == null ? { key: 'CHIEF_EUNUCHS', kind: 'CHIEF_EUNUCHS', label: 'Chief of Eunuchs' } : null,
    ].filter(Boolean)
    : [];
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
    return { action: 'appoint-court', titleType: targetKey, appointeeId: normalizedAppointeeId };
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

function renderCourtAppointmentsForPower(state, playerId, draft, powerKey) {
  if (powerKey === 'BASILEUS') {
    const courtTargets = getCourtTitleTargets(state, playerId);
    if (!courtTargets.length) return '';
    const appoint = draft.appointCourt || {};
    const target = courtTargets.find((entry) => entry.key === appoint.title) || null;
    const appointee = appoint.playerId != null ? getPlayer(state, appoint.playerId) : null;
    const selectedReason = target && appointee
      ? getAppointmentDisabledReason(state, playerId, powerKey, target.key, appointee.id)
      : '';
    const ready = Boolean(target && appointee && !selectedReason);
    const preview = ready
      ? `${renderPlayerRoleName(state, appointee)} → ${renderTitleBadge(state, target.kind, { holderId: appointee.id, label: target.label, compact: true })}`
      : selectedReason
        ? `<span class="muted">Cannot appoint: ${escapeHtml(selectedReason)}</span>`
        : null;
    return renderAppointmentSection({
      kind: 'court',
      title: 'Appoint',
      targetPicker: renderTitleChoiceGrid(state, courtTargets, {
        attr: 'court-title-pick',
        selectedKey: appoint.title,
        getDisabledReason: (entry) => getTargetDisabledReason(state, playerId, powerKey, entry.key),
      }),
      playerPicker: renderPlayerChoiceGrid(state, {
        attr: 'court-player-pick',
        selectedId: appoint.playerId,
        getDisabledReason: (player) => getAppointeeDisabledReason(state, playerId, powerKey, courtTargets, player.id, target?.key || null),
      }),
      preview,
      buttonLabel: 'Appoint',
      buttonAttr: 'appoint-court',
      disabled: !ready,
    });
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
      ? `${renderPlayerRoleName(state, appointee)} → ${renderTitleBadge(state, 'BISHOP', { holderId: appointee.id, themeId: target.id, compact: true })} of ${renderProvinceBadge(state, target, { compact: true })}`
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
    ? `${renderPlayerRoleName(state, appointee)} → ${renderTitleBadge(state, 'STRATEGOS', { holderId: appointee.id, themeId: target.id, compact: true })} of ${renderProvinceBadge(state, target, { compact: true })}`
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
  return targets.map((target) => {
    let badge = '';
    if (target.value.startsWith('minor:')) {
      const [, themeId, kind] = target.value.split(':');
      const theme = state.themes[themeId];
      if (theme) {
        const titleKind = kind === 'strategos' ? 'STRATEGOS' : 'BISHOP';
        const holderId = kind === 'strategos' ? theme.strategos : theme.bishop;
        badge = `${renderTitleBadge(state, titleKind, { holderId, themeId, compact: true })} ${renderProvinceBadge(state, theme, { compact: true })}`;
      }
    } else if (target.value.startsWith('theme:')) {
      const themeId = target.value.split(':')[1];
      const theme = state.themes[themeId];
      if (theme) {
        const ownerLabel = theme.owner === 'church' ? 'Church land' : 'Estate';
        badge = `<span class="muted">${ownerLabel}</span> ${renderProvinceOwnerMarker(state, theme, { compact: true })} ${renderProvinceBadge(state, theme, { compact: true })}`;
      }
    } else if (target.value === 'court:EMPRESS') {
      badge = renderTitleBadge(state, 'EMPRESS', { holderId: state.empress, compact: true });
    } else if (target.value === 'court:CHIEF_EUNUCHS') {
      badge = renderTitleBadge(state, 'CHIEF_EUNUCHS', { holderId: state.chiefEunuchs, compact: true });
    }
    return { ...target, badge };
  });
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
  if (powerKey === 'BASILEUS') return getCourtTitleTargets(state, playerId).length > 0;
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
  const exhausted = isCourtPowerExhausted(state, playerId, powerKey);
  const usedSummary = usedKinds.length ? usedKinds.join(', ') : getCourtPowerActionKind(state, playerId, powerKey);
  const appointHtml = renderCourtAppointmentsForPower(state, playerId, draft, powerKey);
  const revokeHtml = renderCourtRevocationsForPower(state, playerId, draft, powerKey);
  const remainingActions = Math.max(0, COURT_POWER_ACTION_LIMIT - actionCount);
  const usedParts = [
    appointmentCount ? courtPowerCountLabel(appointmentCount, 'appointment') : '',
    revocationCount ? courtPowerCountLabel(revocationCount, 'revocation') : '',
  ].filter(Boolean).join(', ');
  const stateText = actionCount
    ? `${actionCount}/${COURT_POWER_ACTION_LIMIT} actions${usedParts ? ` (${usedParts})` : ''}`
    : 'Choose actions';
  const hint = actionCount > 0 && !exhausted
    ? `${courtPowerCountLabel(remainingActions, 'action')} remains for this office.`
    : !exhausted
      ? `Up to ${COURT_POWER_ACTION_LIMIT} appointments or revocations for this office this round.`
      : '';
  const doneText = actionCount
    ? `${getCourtPowerLabel(powerKey)} ${courtPowerCountLabel(actionCount, 'action')} recorded${usedParts ? ` (${escapeHtml(usedParts)})` : ''}.`
    : `${getCourtPowerLabel(powerKey)} actions recorded${usedSummary ? `: ${escapeHtml(usedSummary)}` : ''}.`;
  const body = exhausted
    ? `<div class="panel-empty court-power-done">${doneText}</div>`
    : `
        <div class="court-choice-lane">
          ${appointHtml || '<div class="choice-grid-empty">No appointments available</div>'}
          ${revokeHtml || '<div class="choice-grid-empty">No revocations available</div>'}
        </div>
      `;
  const cardClass = [
    'court-power-card',
    exhausted ? 'used' : '',
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
  if (!draft.appointCourt) draft.appointCourt = {};
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
    container.querySelectorAll(selector).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
        const value = transform(btn.dataset[Object.keys(btn.dataset)[0]] ?? '');
        const next = { ...(draft[draftKey] || {}), [prop]: value };
        draft[draftKey] = next;
        rerender();
      });
    });
  };
  onPick('[data-court-title-pick]',     'appointCourt',     'title');
  onPick('[data-court-player-pick]',    'appointCourt',     'playerId',  (v) => Number(v));
  onPick('[data-strategos-theme-pick]', 'appointStrategos', 'themeId');
  onPick('[data-strategos-player-pick]','appointStrategos', 'playerId',  (v) => Number(v));
  onPick('[data-bishop-theme-pick]',    'appointBishop',    'themeId');
  onPick('[data-bishop-player-pick]',   'appointBishop',    'playerId',  (v) => Number(v));
  onPick('[data-revoke-pick]',          'revoke',           'target');

  bindSelectAction(container, '[data-action="appoint-court"]', () => {
    const { title, playerId } = draft.appointCourt || {};
    if (!title || playerId == null) return;
    callbacks['appoint-court']?.(title, playerId);
  });
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
}

export function renderEstatesPanel(container, state, playerId, callbacks = {}) {
  const freeThemes = getFreeThemes(state);
  const player = getPlayer(state, playerId);
  const activeBidderId = Number(playerId);
  const reserve = Math.max(0, Number(player?.gold) || 0);
  const ready = Boolean(state.estatesReady?.[playerId]);
  const readyCount = state.players.filter((entry) => Boolean(state.estatesReady?.[entry.id])).length;
  container.innerHTML = `
    <section class="phase-card estates-panel">
      <header class="estates-head">
        <h3>Estates</h3>
        <div class="estates-head-meta">
          <span class="estates-ready-count">${readyCount}/${state.players.length} ready</span>
          <span class="estates-reserve" title="Your unreserved gold">
            <span class="reserve-label">Your reserve</span>
            ${formatGoldHtml(reserve)}
          </span>
        </div>
      </header>
      ${freeThemes.length ? `
        <div class="estate-grid">
          ${freeThemes.map((theme) => {
            const minimum = getMinimumLandBid(state, theme.id);
            const value = getThemeLandPrice(theme);
            const auction = state.landAuctions?.[theme.id] || null;
            const bidderId = auction?.bidderId == null ? null : Number(auction.bidderId);
            const bidder = bidderId == null ? null : getPlayer(state, bidderId);
            const isLeading = bidderId === activeBidderId;
            const ownBid = isLeading ? Number(auction?.amount) || 0 : 0;
            const dueNow = Math.max(0, minimum - ownBid);
            const cannotAfford = dueNow > reserve;
            const bidButtonLabel = auction
              ? (isLeading ? 'Raise' : 'Outbid')
              : 'Bid';
            return `
              <article class="estate-card${cannotAfford ? ' disabled' : ''}${isLeading ? ' selected' : ''}${auction && !isLeading ? ' contested' : ''}" data-estate="${theme.id}" data-map-province="${theme.id}">
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
                ${auction ? `
                  <div class="estate-current-bid ${isLeading ? 'owned' : 'contested'}">
                    <span class="estate-current-label">${isLeading ? 'Your high bid' : 'High bid'}</span>
                    <span class="estate-current-bidder">${bidder ? renderPlayerRoleName(state, bidder) : 'Unknown'}</span>
                    <span class="estate-current-amount">${formatGoldHtml(Number(auction.amount) || 0)}</span>
                  </div>
                ` : ''}
                <div class="estate-card-bid">
                  <input type="number" min="${minimum}" value="${minimum}" data-estate-bid="${theme.id}" ${cannotAfford ? 'disabled' : ''}>
                  <button type="button" class="btn-primary estate-bid-btn" data-action="bid-estate" data-theme="${theme.id}" ${cannotAfford ? 'disabled' : ''}>${bidButtonLabel}</button>
                </div>
                ${cannotAfford ? `<div class="estate-card-warn">Need ${formatGoldHtml(dueNow)} of unreserved gold to bid.</div>` : ''}
              </article>
            `;
          }).join('')}
        </div>
      ` : '<div class="panel-empty">No free citizen land this round.</div>'}
      <div class="panel-actions">
        <button type="button" class="${ready ? 'btn-secondary' : 'btn-primary'}" data-action="confirm-estates">${ready ? 'Stay in Estates' : 'Ready for Deployment'}</button>
      </div>
    </section>
  `;
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
  return Object.keys(state.currentTroops || {})
    .filter((officeKey) => getOfficeHolder(state, officeKey) === playerId)
    .sort((left, right) => left.localeCompare(right));
}

function getArmyMaxTroops(state, officeKey) {
  const entry = readTroopEntry(state.currentTroops?.[officeKey]);
  return entry.normal + entry.capitalLocked;
}

function ensureDeploymentDraft(state, draft, armyKeys) {
  for (const officeKey of armyKeys) {
    if (!draft.armies[officeKey]) {
      draft.armies[officeKey] = {
        funded: getArmyMaxTroops(state, officeKey),
        destination: 'frontier',
      };
    }
  }
}

function getActiveOrderLocks(options = {}) {
  const locks = options.privateData?.orderLocks;
  return locks && typeof locks === 'object' ? locks : null;
}

function applyOrderLocksToDraft(state, draft, orderLocks) {
  if (!orderLocks?.ok) return;
  if (orderLocks.candidateId != null) draft.candidate = Number(orderLocks.candidateId);
  for (const [officeKey, destination] of Object.entries(orderLocks.committedOfficeKeys || {})) {
    if (!draft.armies[officeKey]) draft.armies[officeKey] = { funded: 0, destination: 'frontier' };
    draft.armies[officeKey].funded = getArmyMaxTroops(state, officeKey);
    draft.armies[officeKey].destination = destination === 'capital' ? 'capital' : 'frontier';
  }
}

function getDraftArmyBreakdown(state, draft, armyKeys) {
  let capitalTroops = 0;
  let frontierTroops = 0;
  let unfundedTroops = 0;

  for (const officeKey of armyKeys) {
    const pool = readTroopEntry(state.currentTroops?.[officeKey]);
    const totalTroops = pool.normal + pool.capitalLocked;
    const order = draft.armies?.[officeKey] || {};
    const funded = Math.max(0, Math.min(totalTroops, Number(order.funded) || 0));
    const fundedLocked = Math.min(pool.capitalLocked, funded);
    const fundedNormal = Math.min(pool.normal, Math.max(0, funded - fundedLocked));
    const destination = order.destination === 'capital' ? 'capital' : 'frontier';

    capitalTroops += fundedLocked + (destination === 'capital' ? fundedNormal : 0);
    frontierTroops += destination === 'frontier' ? fundedNormal : 0;
    unfundedTroops += Math.max(0, totalTroops - funded);
  }

  const mercenaryCount = Math.max(0, Number(draft.mercenaries?.count) || 0);
  if (draft.mercenaries?.destination === 'capital') capitalTroops += mercenaryCount;
  else frontierTroops += mercenaryCount;

  return { capitalTroops, frontierTroops, unfundedTroops };
}

function getDeploymentTotals(state, draft, armyKeys, reserve) {
  const unfundedGold = armyKeys.reduce((sum, key) => (
    sum + Math.max(0, getArmyMaxTroops(state, key) - (Number(draft.armies[key]?.funded) || 0))
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
    rows.push(`Claimant: ${escapeHtml(playerDisplayLabel(candidate))}`);
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

function renderDeploymentPreview(state, draft, armyKeys) {
  const breakdown = getDraftArmyBreakdown(state, draft, armyKeys);
  const candidate = getPlayer(state, Number(draft.candidate));
  const candidateLabel = escapeHtml(playerDisplayLabel(candidate));
  return `
    <div class="deployment-preview" data-deployment-preview>
      <div class="deployment-preview-row">
        <span class="deployment-preview-label">Coup support</span>
        <span class="deployment-preview-value">${formatTroopsHtml(breakdown.capitalTroops)} for ${candidateLabel}</span>
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
          ? 'Only funded Capital troops and Capital mercenaries count in the coup.'
          : 'No troops are backing this claimant yet. Move funded troops or mercenaries to Capital to make them count in the coup.'}
      </p>
    </div>
  `;
}

export function renderOrdersPanel(container, state, playerId, callbacks = {}, options = {}) {
  if (!container || !state) return;
  const draft = getDraftBucket(options.uiState, state, 'deployment', playerId);
  if (!draft.armies) draft.armies = {};
  if (!draft.mercenaries) draft.mercenaries = { count: 0, destination: 'frontier' };
  if (draft.candidate == null) draft.candidate = state.basileusId;
  const alreadyLocked = state.allOrders?.[playerId] != null;
  const armyKeys = getPlayerArmyKeys(state, playerId);
  const player = getPlayer(state, playerId);
  const reserve = Math.max(0, Number(player?.gold) || 0);
  ensureDeploymentDraft(state, draft, armyKeys);
  const orderLocks = getActiveOrderLocks(options);
  applyOrderLocksToDraft(state, draft, orderLocks);
  const totals = getDeploymentTotals(state, draft, armyKeys, reserve);
  const candidateLockedId = orderLocks?.ok && orderLocks.candidateId != null ? Number(orderLocks.candidateId) : null;
  const lockedDestinations = orderLocks?.ok ? (orderLocks.committedOfficeKeys || {}) : {};
  const deploymentPreview = renderDeploymentPreview(state, draft, armyKeys);
  const lockNotice = renderOrderLockNotice(state, orderLocks);

  const candidateRows = state.players.map((candidate) => {
    const isCurrent = candidate.id === state.basileusId;
    const isSelected = Number(draft.candidate) === candidate.id;
    const isLockedCandidate = candidateLockedId === candidate.id;
    const isDisabled = candidateLockedId != null && !isLockedCandidate;
    const tag = isLockedCandidate ? 'Deal lock' : (isSelected ? 'Your pick' : (isCurrent ? 'Current' : 'Claimant'));
    return `
      <button type="button"
        class="candidate-row${isSelected ? ' selected' : ''}${isDisabled ? ' disabled' : ''}"
        data-candidate-pick="${candidate.id}"
        aria-pressed="${isSelected ? 'true' : 'false'}"
        style="${getPlayerStyleAttr(state, candidate.id)}"
        ${isDisabled ? 'disabled' : ''}>
        <span class="candidate-crest">${playerInitial(candidate)}</span>
        <span class="candidate-name">${escapeHtml(playerDisplayLabel(candidate))}</span>
        <span class="candidate-tag">${tag}</span>
      </button>
    `;
  }).join('');

  container.innerHTML = `
    <section class="phase-card orders-panel">
      <header class="orders-head">
        <h3>Deployment</h3>
        <div class="orders-budget${totals.overBudget ? ' over' : ''}" title="Mercenary cost after idle troop income" data-orders-budget>
          <span class="orders-budget-label">Mercs</span>
          <span data-orders-merc-cost>${formatGoldHtml(totals.mercCost, { signed: false })}</span>
          <span class="orders-budget-of">of</span>
          <span data-orders-reserve>${formatGoldHtml(reserve + totals.unfundedGold, { signed: false })}</span>
        </div>
      </header>
      <p class="section-hint">Funding sends troops to war. Unfunded troops stay home and add gold before mercenaries are paid.</p>
      ${alreadyLocked ? '<div class="panel-empty">Deployment orders locked.</div>' : `
        ${lockNotice}
        ${deploymentPreview}
        <div class="army-card-stack">
          ${armyKeys.map((officeKey) => {
            const entry = readTroopEntry(state.currentTroops?.[officeKey]);
            const max = getArmyMaxTroops(state, officeKey);
            const current = draft.armies[officeKey];
            const idleGold = Math.max(0, max - (Number(current.funded) || 0));
            const lockedDestination = lockedDestinations[officeKey] || null;
            const lockedLabel = lockedDestination === 'capital' ? 'Capital' : lockedDestination === 'frontier' ? 'Frontier' : null;
            return `
              <article class="army-card" data-army-card="${officeKey}">
                <header class="army-card-head">
                  <span class="army-card-title">${renderArmyOfficeBadge(state, officeKey)}</span>
                  <span class="army-card-count">${formatTroopsHtml(max, { label: 'Troops' })}</span>
                </header>
                ${entry.capitalLocked ? `<p class="army-card-sub">${formatTroopsHtml(entry.capitalLocked)} capital locked</p>` : ''}
                ${lockedLabel ? `<p class="army-card-sub order-locked-sub">Deal lock: must deploy to ${lockedLabel}.</p>` : ''}
                <label class="army-card-slider">
                  <span class="army-slider-label">Fund</span>
                  <input type="range" min="0" max="${max}" value="${current.funded}" data-army-funded="${officeKey}" ${lockedDestination ? 'disabled' : ''}>
                  <span class="army-slider-readout">
                    <span class="army-slider-num" data-funded-readout="${officeKey}">${current.funded}</span>
                    <span class="army-slider-cost" data-funded-cost="${officeKey}" title="Gold from idle troops">${formatGoldHtml(idleGold, { signed: true, tone: 'income' })}</span>
                  </span>
                </label>
                <div class="segmented-control">
                  <button type="button" class="${current.destination === 'frontier' ? 'active' : ''}" data-army-destination="${officeKey}" data-destination="frontier" ${lockedDestination ? 'disabled' : ''}>Frontier</button>
                  <button type="button" class="${current.destination === 'capital' ? 'active' : ''}" data-army-destination="${officeKey}" data-destination="capital" ${lockedDestination ? 'disabled' : ''}>Capital</button>
                </div>
              </article>
            `;
          }).join('')}
          <article class="army-card mercenary-card">
            <header class="army-card-head">
              <span class="army-card-title">${renderIcon('troop')} Mercenaries</span>
              <span class="army-card-count">${formatMercenariesHtml(draft.mercenaries.count || 0)}</span>
            </header>
            <p class="army-card-sub">Triangular cost: 1, +2, +3 …</p>
            <label class="army-card-slider">
              <span class="army-slider-label">Hire</span>
              <input type="range" min="0" max="10" value="${draft.mercenaries.count || 0}" data-mercenary-count>
              <span class="army-slider-readout">
                <span class="army-slider-num" data-mercenary-num>${draft.mercenaries.count || 0}</span>
                <span class="army-slider-cost" data-mercenary-cost>${formatGoldHtml(-totals.mercCost, { tone: 'upkeep' })}</span>
              </span>
            </label>
            <div class="segmented-control">
              <button type="button" class="${draft.mercenaries.destination !== 'capital' ? 'active' : ''}" data-mercenary-destination="frontier">Frontier</button>
              <button type="button" class="${draft.mercenaries.destination === 'capital' ? 'active' : ''}" data-mercenary-destination="capital">Capital</button>
            </div>
          </article>
        </div>

        <div class="candidate-section">
          <div class="candidate-section-head">
            ${renderPickerStep('★', 'Back a claimant for the throne')}
          </div>
          <div class="candidate-grid">${candidateRows}</div>
        </div>

        <div class="panel-actions">
          <button type="button" class="btn-primary" data-action="lock-orders" ${totals.overBudget ? 'disabled' : ''}>${totals.overBudget ? 'Need More Gold' : 'Lock Deployment'}</button>
        </div>
      `}
    </section>
  `;

  const rerender = () => renderOrdersPanel(container, state, playerId, callbacks, options);
  const updateBudgetReadout = () => {
    const nextTotals = getDeploymentTotals(state, draft, armyKeys, reserve);
    const budget = container.querySelector('[data-orders-budget]');
    budget?.classList.toggle('over', nextTotals.overBudget);
    const mercCost = container.querySelector('[data-orders-merc-cost]');
    if (mercCost) mercCost.innerHTML = formatGoldHtml(nextTotals.mercCost, { signed: false });
    const reserveEl = container.querySelector('[data-orders-reserve]');
    if (reserveEl) reserveEl.innerHTML = formatGoldHtml(reserve + nextTotals.unfundedGold, { signed: false });
    const lockButton = container.querySelector('[data-action="lock-orders"]');
    if (lockButton) {
      lockButton.disabled = nextTotals.overBudget;
      lockButton.textContent = nextTotals.overBudget ? 'Need More Gold' : 'Lock Deployment';
    }
    const preview = container.querySelector('[data-deployment-preview]');
    if (preview) preview.outerHTML = renderDeploymentPreview(state, draft, armyKeys);
  };

  container.querySelectorAll('[data-army-funded]').forEach((input) => {
    input.addEventListener('input', () => {
      const officeKey = input.dataset.armyFunded;
      if (!draft.armies[officeKey]) draft.armies[officeKey] = { funded: 0, destination: 'frontier' };
      const next = Number(input.value) || 0;
      draft.armies[officeKey].funded = next;
      const max = getArmyMaxTroops(state, officeKey);
      const readout = container.querySelector(`[data-funded-readout="${officeKey}"]`);
      if (readout) readout.textContent = next;
      const costEl = container.querySelector(`[data-funded-cost="${officeKey}"]`);
      if (costEl) costEl.innerHTML = formatGoldHtml(Math.max(0, max - next), { signed: true, tone: 'income' });
      updateBudgetReadout();
    });
    input.addEventListener('change', rerender);
  });
  container.querySelectorAll('[data-army-destination]').forEach((button) => {
    button.addEventListener('click', () => {
      const officeKey = button.dataset.armyDestination;
      if (!draft.armies[officeKey]) draft.armies[officeKey] = { funded: 0, destination: 'frontier' };
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
  container.querySelectorAll('[data-candidate-pick]').forEach((button) => {
    button.addEventListener('click', () => {
      draft.candidate = Number(button.dataset.candidatePick);
      rerender();
    });
  });
  bindSelectAction(container, '[data-action="lock-orders"]', () => {
    callbacks.lockOrders?.({
      armies: draft.armies,
      mercenaries: draft.mercenaries,
      candidate: Number(draft.candidate ?? state.basileusId),
    });
  });
}

export function renderResolutionPanel(container, state, options = {}) {
  return renderResolutionPanelDetailed(container, state, options);
}

export function renderResolutionPanelDetailed(container, state, options = {}) {
  if (!container || !state) return;
  const rewards = Array.isArray(state.pendingDefenderRewards) ? state.pendingDefenderRewards.filter((reward) => !reward.resolved) : [];
  const war = state.lastWarResult;
  const coup = state.lastCoupResult;
  const empireFell = Boolean(war?.reachedCPL) || state.gameOver?.type === 'fall';
  const invasionName = state.currentInvasion?.name || 'the invader';

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
      <h3>Resolution</h3>
      ${empireFallenBanner}
      ${warSection}
      ${coupSection}
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
    </article>
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

function renderCoupResultCard(state, coup) {
  const winnerId = coup.winner;
  const winner = getPlayer(state, winnerId);
  const heldThrone = winnerId === state.basileusId;
  const votes = coup.votes || {};
  const contributions = Array.isArray(coup.contributions) ? coup.contributions : [];
  const ballots = Array.isArray(coup.ballots) ? coup.ballots : contributions;
  const voteRows = Object.entries(votes)
    .map(([candidateId, troops]) => ({ candidateId: Number(candidateId), troops: Math.max(0, Number(troops) || 0) }))
    .filter((row) => row.troops > 0)
    .sort((a, b) => b.troops - a.troops);
  const zeroBallots = ballots
    .filter((ballot) => Math.max(0, Number(ballot.troops) || 0) <= 0)
    .sort((a, b) => Number(a.playerId) - Number(b.playerId));
  const zeroBallotSummary = zeroBallots.length
    ? `No capital troops from ${zeroBallots.map((ballot) => {
      const voter = getPlayer(state, Number(ballot.playerId));
      const candidate = getPlayer(state, Number(ballot.candidateId));
      return `${escapeHtml(playerDisplayLabel(voter))} (${escapeHtml(playerDisplayLabel(candidate))})`;
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
      ${voteRows.length ? `
        <div class="vote-breakdown">
          ${voteRows.map((row) => {
            const supporters = contributions
              .filter((entry) => Number(entry.candidateId) === row.candidateId && (Number(entry.troops) || 0) > 0)
              .sort((a, b) => (Number(b.troops) - Number(a.troops)) || (Number(a.playerId) - Number(b.playerId)));
            return `
              <div class="vote-row">
                <span class="vote-candidate">
                  ${renderPlayerRoleName(state, getPlayer(state, row.candidateId), `Player ${row.candidateId + 1}`)}
                  ${supporters.length ? `
                    <span class="vote-supporters">
                      ${supporters.map((entry) => {
                        const supporter = getPlayer(state, Number(entry.playerId));
                        return `${escapeHtml(playerDisplayLabel(supporter))} ${formatTroopsHtml(entry.troops)}`;
                      }).join(' ')}
                    </span>
                  ` : ''}
                </span>
                <span class="vote-troops">${formatTroopsHtml(row.troops)}</span>
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
