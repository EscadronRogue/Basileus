// ui/panels.js - compact phase panels for the updated ruleset.
import { MAJOR_TITLES } from '../data/titles.js';
import { readTroopEntry } from '../engine/cascade.js';
import { getMinimumLandBid, suggestMajorTitleAssignments } from '../engine/actions.js';
import { getMercenaryHireCost, getThemeLandPrice } from '../engine/rules.js';
import { getFreeThemes, getOfficeDisplayName, getOfficeHolder, getPlayer, getPlayerThemes } from '../engine/state.js';
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

function actionUsed(state, playerId) {
  return Boolean(state.courtActions?.actionUsed?.[playerId]);
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

function getStrategosTargets(state, playerId) {
  const roles = new Set(roleKeysForCourt(state, playerId));
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

function getGiftTargets(state, playerId) {
  return getPlayerThemes(state, playerId).filter((theme) => (
    !theme.occupied && (Number(theme.origin?.C) || 0) >= 1
  ));
}

function getRevocationTargets(state, playerId) {
  const roles = new Set(roleKeysForCourt(state, playerId));
  const targets = [];
  for (const theme of Object.values(state.themes || {})) {
    if (theme.id === 'CPL') continue;
    if (theme.strategos != null && roles.has(regionTitleFor(theme))) {
      targets.push({ value: `minor:${theme.id}:strategos`, label: `Strategos of ${theme.name}` });
    }
    if (theme.bishop != null && roles.has('PATRIARCH')) {
      targets.push({ value: `minor:${theme.id}:bishop`, label: `Bishop of ${theme.name}` });
    }
    if (playerId === state.basileusId && theme.owner != null && !theme.occupied) {
      targets.push({ value: `theme:${theme.id}`, label: `${theme.owner === 'church' ? 'Church land' : 'Estate'} in ${theme.name}` });
    }
  }
  if (playerId === state.basileusId && state.empress != null) targets.push({ value: 'court:EMPRESS', label: 'Empress' });
  if (playerId === state.basileusId && state.chiefEunuchs != null) targets.push({ value: 'court:CHIEF_EUNUCHS', label: 'Chief of Eunuchs' });
  return targets;
}

function bindSelectAction(container, selector, callback) {
  container.querySelector(selector)?.addEventListener('click', () => callback?.());
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
        const isSelected = Number(selectedId) === player.id;
        return `
          <button type="button" class="choice-btn player-choice-btn${isSelected ? ' selected' : ''}"
            data-${attr}="${player.id}"
            style="${getPlayerStyleAttr(state, player.id)}"
            title="${escapeHtml(playerDisplayLabel(player))}">
            <span class="choice-crest">${playerInitial(player)}</span>
            <span class="choice-label">${escapeHtml(playerDisplayLabel(player))}</span>
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
        const isSelected = selectedId === theme.id;
        return `
          <button type="button" class="choice-btn province-choice-btn${isSelected ? ' selected' : ''}"
            data-${attr}="${theme.id}"
            title="${escapeHtml(theme.name)}">
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
        const isSelected = entry.key === selectedKey;
        const badge = renderTitleBadge(state, entry.kind, {
          holderId,
          label: entry.label,
          compact: true,
        });
        return `
          <button type="button" class="choice-btn title-choice-btn${isSelected ? ' selected' : ''}"
            data-${attr}="${entry.key}">
            ${badge}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderRevocationChoiceGrid(state, targets, options = {}) {
  void state;
  const { attr, selectedValue = null } = options;
  if (!targets.length) return `<div class="choice-grid-empty">Nothing to revoke right now</div>`;
  return `
    <div class="choice-grid revocation-choice-grid">
      ${targets.map((target) => {
        const isSelected = target.value === selectedValue;
        return `
          <button type="button" class="choice-btn revocation-choice-btn${isSelected ? ' selected' : ''}"
            data-${attr}="${target.value}">
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
      <p class="section-hint">${isBasileus ? 'Assign each major office to a vassal before the income phase.' : 'Waiting for the Basileus to assign the major titles.'}</p>
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

export function renderPlayerDashboard(container, state, playerId, selectedProvinceId = null, options = {}) {
  if (!container || !state) return;
  const player = getPlayer(state, playerId);
  const isOpen = options.uiState?.panels?.dashboard ?? true;
  const selected = selectedProvinceId ? state.themes[selectedProvinceId] : null;
  const titles = [
    playerId === state.basileusId ? renderTitleBadge(state, 'BASILEUS', { holderId: playerId, compact: true }) : '',
    ...(player?.majorTitles || []).map((titleKey) => renderTitleBadge(state, titleKey, { holderId: playerId, compact: true })),
  ].filter(Boolean).join(' ');
  container.classList?.toggle?.('panel-collapsed', !isOpen);
  container.innerHTML = `
    <div class="player-dashboard sidebar-panel${isOpen ? '' : ' is-collapsed'}" style="${player ? getPlayerStyleAttr(state, player.id) : ''}">
      <button class="sidebar-panel-head" type="button" data-ui-panel-toggle="dashboard" aria-expanded="${isOpen}">
        <span class="sidebar-panel-head-copy">
          <span class="sidebar-panel-kicker">Dynasty</span>
          <span class="sidebar-panel-title">${player ? renderPlayerRoleName(state, player) : 'No dynasty'}</span>
        </span>
      </button>
      ${isOpen ? `
      <div class="sidebar-panel-body">
        <div class="dashboard-stat-row">
          <span class="dashboard-stat-label">${renderIcon('gold')} Gold</span>
          <strong>${formatGoldHtml(player?.gold || 0)}</strong>
        </div>
        <div class="dashboard-token-row">${titles || '<span class="muted">No major office</span>'}</div>
        ${selected ? `
          <div class="selected-province">
            ${renderProvinceBadge(state, selected, { showValues: true })}
            ${selected.id !== 'CPL' ? `<div class="selected-province-yield">
              ${formatGoldHtml(Math.max(0, Number(selected.P) || 0), { label: 'Profit' })}
              ${formatTroopsHtml(Math.max(0, Number(selected.T) || 0), { label: 'Troops' })}
              ${formatChurchHtml(Math.max(0, Number(selected.C) || 0), { label: 'Church' })}
            </div>` : ''}
          </div>
        ` : ''}
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
        badge = `<span class="muted">${ownerLabel} —</span> ${renderProvinceBadge(state, theme, { compact: true })}`;
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

function renderCourtGifts(state, playerId, draft) {
  const targets = getGiftTargets(state, playerId);
  if (!targets.length) return '';
  const selectedId = draft.gift?.themeId || null;
  const selected = selectedId ? state.themes[selectedId] : null;
  const ready = Boolean(selected);
  return `
    <details class="action-fold">
      <summary>Gift Land</summary>
      <div class="appointment-section">
        <div class="appointment-step">
          ${renderPickerStep(1, 'Pick land to gift to the Church')}
          ${renderProvinceChoiceGrid(state, targets, { attr: 'gift-pick', selectedId })}
        </div>
        <div class="appointment-preview">
          ${selected ? `Gift ${renderProvinceBadge(state, selected, { compact: true })} to the Church (you become Bishop)` : '<span class="muted">Pick a province to gift</span>'}
        </div>
        <div class="panel-actions">
          <button type="button" class="btn-primary" data-action="gift" ${ready ? '' : 'disabled'}>Gift</button>
        </div>
      </div>
    </details>
  `;
}

export function renderCourtPanel(container, state, activePlayerId, callbacks = {}, options = {}) {
  if (!container || !state) return;
  const player = getPlayer(state, activePlayerId);
  const draft = getDraftBucket(options.uiState, state, 'court', activePlayerId);
  if (!draft.appointCourt) draft.appointCourt = {};
  if (!draft.appointStrategos) draft.appointStrategos = {};
  if (!draft.appointBishop) draft.appointBishop = {};
  if (!draft.revoke) draft.revoke = {};
  if (!draft.gift) draft.gift = {};
  const used = actionUsed(state, activePlayerId);
  const rerender = () => renderCourtPanel(container, state, activePlayerId, callbacks, options);
  container.innerHTML = `
    <section class="phase-card court-panel">
      <h3>${player ? renderPlayerRoleName(state, player) : 'Court'}</h3>
      <div class="dashboard-token-row">${roleKeysForCourt(state, activePlayerId).map((role) => renderTitleBadge(state, role, { holderId: activePlayerId, compact: true })).join(' ')}</div>
      ${used ? '<div class="panel-empty">Court action recorded.</div>' : `
        ${renderCourtAppointments(state, activePlayerId, draft)}
        ${renderCourtRevocations(state, activePlayerId, draft)}
        ${renderCourtGifts(state, activePlayerId, draft)}
      `}
      <div class="panel-actions">
        <button type="button" class="btn-primary" data-action="confirm-court">End Court</button>
      </div>
    </section>
  `;

  // Picker click handlers — store in draft, re-render to update visuals.
  const onPick = (selector, draftKey, prop, transform = (v) => v) => {
    container.querySelectorAll(selector).forEach((btn) => {
      btn.addEventListener('click', () => {
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
  onPick('[data-gift-pick]',            'gift',             'themeId');

  bindSelectAction(container, '[data-action="appoint-court"]', () => {
    const { title, playerId } = draft.appointCourt || {};
    if (!title || playerId == null) return;
    callbacks['appoint-court']?.(title, playerId);
    draft.appointCourt = {};
  });
  bindSelectAction(container, '[data-action="appoint-strategos"]', () => {
    const { themeId, playerId } = draft.appointStrategos || {};
    if (!themeId || playerId == null) return;
    callbacks['appoint-strategos']?.(
      regionTitleFor(state.themes[themeId]),
      themeId,
      playerId,
    );
    draft.appointStrategos = {};
  });
  bindSelectAction(container, '[data-action="appoint-bishop"]', () => {
    const { themeId, playerId } = draft.appointBishop || {};
    if (!themeId || playerId == null) return;
    callbacks['appoint-bishop']?.(themeId, playerId);
    draft.appointBishop = {};
  });
  bindSelectAction(container, '[data-action="revoke"]', () => {
    const target = draft.revoke?.target;
    if (!target) return;
    callbacks.revoke?.(target);
    draft.revoke = {};
  });
  bindSelectAction(container, '[data-action="gift"]', () => {
    const themeId = draft.gift?.themeId;
    if (!themeId) return;
    callbacks.gift?.(themeId);
    draft.gift = {};
  });
  bindSelectAction(container, '[data-action="confirm-court"]', () => callbacks['confirm-court']?.());
}

export function renderEstatesPanel(container, state, playerId, callbacks = {}) {
  const freeThemes = getFreeThemes(state);
  const player = getPlayer(state, playerId);
  const reserve = Math.max(0, Number(player?.gold) || 0);
  container.innerHTML = `
    <section class="phase-card estates-panel">
      <header class="estates-head">
        <h3>Estates</h3>
        <span class="estates-reserve" title="Your unreserved gold">
          <span class="reserve-label">Your reserve</span>
          ${formatGoldHtml(reserve)}
        </span>
      </header>
      ${freeThemes.length ? `
        <div class="estate-grid">
          ${freeThemes.map((theme) => {
            const minimum = getMinimumLandBid(state, theme.id);
            const value = getThemeLandPrice(theme);
            const cannotAfford = minimum > reserve;
            return `
              <article class="estate-card${cannotAfford ? ' disabled' : ''}" data-estate="${theme.id}">
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
                <div class="estate-card-bid">
                  <input type="number" min="${minimum}" value="${minimum}" data-estate-bid="${theme.id}" ${cannotAfford ? 'disabled' : ''}>
                  <button type="button" class="btn-primary estate-bid-btn" data-action="bid-estate" data-theme="${theme.id}" ${cannotAfford ? 'disabled' : ''}>Bid</button>
                </div>
                ${cannotAfford ? '<div class="estate-card-warn">Not enough gold to meet the minimum.</div>' : ''}
              </article>
            `;
          }).join('')}
        </div>
      ` : '<div class="panel-empty">No free citizen land this round.</div>'}
      <div class="panel-actions">
        <button type="button" class="btn-primary" data-action="confirm-estates">Open Deployment</button>
      </div>
    </section>
  `;
  container.querySelectorAll('[data-action="bid-estate"]').forEach((button) => {
    button.addEventListener('click', () => {
      const themeId = button.dataset.theme;
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
  const totals = getDeploymentTotals(state, draft, armyKeys, reserve);

  const candidateRows = state.players.map((candidate) => {
    const isCurrent = candidate.id === state.basileusId;
    const isSelected = Number(draft.candidate) === candidate.id;
    return `
      <button type="button"
        class="candidate-row${isSelected ? ' selected' : ''}"
        data-candidate-pick="${candidate.id}"
        style="${getPlayerStyleAttr(state, candidate.id)}">
        <span class="candidate-crest">${playerInitial(candidate)}</span>
        <span class="candidate-name">${escapeHtml(playerDisplayLabel(candidate))}</span>
        <span class="candidate-tag">${isCurrent ? 'Current' : (isSelected ? 'Your pick' : 'Claimant')}</span>
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
        <div class="army-card-stack">
          ${armyKeys.map((officeKey) => {
            const entry = readTroopEntry(state.currentTroops?.[officeKey]);
            const max = getArmyMaxTroops(state, officeKey);
            const current = draft.armies[officeKey];
            const idleGold = Math.max(0, max - (Number(current.funded) || 0));
            return `
              <article class="army-card" data-army-card="${officeKey}">
                <header class="army-card-head">
                  <span class="army-card-title">${renderArmyOfficeBadge(state, officeKey)}</span>
                  <span class="army-card-count">${formatTroopsHtml(max, { label: 'Troops' })}</span>
                </header>
                ${entry.capitalLocked ? `<p class="army-card-sub">${formatTroopsHtml(entry.capitalLocked)} capital locked</p>` : ''}
                <label class="army-card-slider">
                  <span class="army-slider-label">Fund</span>
                  <input type="range" min="0" max="${max}" value="${current.funded}" data-army-funded="${officeKey}">
                  <span class="army-slider-readout">
                    <span class="army-slider-num" data-funded-readout="${officeKey}">${current.funded}</span>
                    <span class="army-slider-cost" data-funded-cost="${officeKey}" title="Gold from idle troops">${formatGoldHtml(idleGold, { signed: true, tone: 'income' })}</span>
                  </span>
                </label>
                <div class="segmented-control">
                  <button type="button" class="${current.destination === 'frontier' ? 'active' : ''}" data-army-destination="${officeKey}" data-destination="frontier">Frontier</button>
                  <button type="button" class="${current.destination === 'capital' ? 'active' : ''}" data-army-destination="${officeKey}" data-destination="capital">Capital</button>
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

function renderCoupResultCard(state, coup) {
  const winnerId = coup.winner;
  const winner = getPlayer(state, winnerId);
  const heldThrone = winnerId === state.basileusId;
  const votes = coup.votes || {};
  const voteRows = Object.entries(votes)
    .map(([candidateId, troops]) => ({ candidateId: Number(candidateId), troops: Math.max(0, Number(troops) || 0) }))
    .filter((row) => row.troops > 0)
    .sort((a, b) => b.troops - a.troops);

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
          ${voteRows.map((row) => `
            <div class="vote-row">
              ${renderPlayerRoleName(state, getPlayer(state, row.candidateId), `Player ${row.candidateId + 1}`)}
              <span class="vote-troops">${formatTroopsHtml(row.troops)}</span>
            </div>
          `).join('')}
        </div>
      ` : '<p class="muted">No capital troops were committed.</p>'}
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
