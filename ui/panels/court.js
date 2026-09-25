// ui/panels/court.js - Court panel: appointments, revocations, and the planned-action queue.

import { MAJOR_TITLES } from '../../data/titles.js';
import { applyCourtAction } from '../../engine/commands.js';
import {
  getCourtPowerActionLimit,
  getCourtPowerActionCount,
  getCourtPowerAppointmentCount,
  getCourtPowerActionKinds,
  getCourtPowerActionKind,
  getCourtPowerRevocationCount,
  getCourtPowerUseMode,
  getUsedCourtPowers,
  isCourtPowerExhausted,
  isCourtPowerPassed,
  isCourtPowerUsed,
} from '../../engine/actions.js';
import { getPlayer } from '../../engine/state.js';
import { getRevocableEstateCount } from '../../engine/estates.js';
import { escapeHtml } from '../html.js';
import { getPlayerStyleAttr, renderPlayerChip, renderProvinceOfficeBadge, renderTitleBadge } from '../labels.js';
import {
  bindSelectAction,
  cloneStateForValidation,
  disabledChoiceAttrs,
  getBishopTargets,
  getDraftBucket,
  getRevocationTargets,
  getStrategosTargets,
  notifyDraftChange,
  playerDisplayLabel,
  regionTitleFor,
  roleKeysForCourt,
  validateCourtPayload,
} from './shared.js';
import {
  COURT_WIRE_STEP,
  bindWireDraftMotion,
  bindWireFocus,
  bindWireGeometry,
  getCourtWireStep,
  layoutCourtWireRows,
  normalizeWirePlayerId,
  renderCourtDraftWire,
  renderCourtWireLine,
  renderCourtWireSeat,
} from './wires.js';

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

function getAppointmentDisabledReason(state, playerId, powerKey, targetKey, appointeeId, draft = null) {
  const payload = getAppointmentPayload(powerKey, targetKey, appointeeId);
  if (!payload) return 'Make both picks first.';
  const result = validateCourtPayloadWithDraft(state, playerId, draft, payload);
  return result.ok ? '' : result.reason;
}

function getTargetDisabledReason(state, playerId, powerKey, targetKey, draft = null) {
  let firstReason = '';
  for (const player of state.players || []) {
    const reason = getAppointmentDisabledReason(state, playerId, powerKey, targetKey, player.id, draft);
    if (!reason) return '';
    if (!firstReason) firstReason = reason;
  }
  return firstReason || 'No legal appointee right now.';
}

function getAppointeeDisabledReason(state, playerId, powerKey, targets, appointeeId, selectedTargetKey = null, draft = null) {
  if (selectedTargetKey) {
    return getAppointmentDisabledReason(state, playerId, powerKey, selectedTargetKey, appointeeId, draft);
  }
  let firstReason = '';
  for (const target of targets || []) {
    const targetKey = target.key || target.id;
    const reason = getAppointmentDisabledReason(state, playerId, powerKey, targetKey, appointeeId, draft);
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
  if (kind === 'strategos') return 'Strategos';
  if (kind === 'bishop') return 'Bishop';
  if (kind === 'estate') return 'Estates';
  return 'Office';
}

function courtSeatHolder(state, holderId) {
  if (holderId == null || holderId === '') return null;
  const playerId = Number(holderId);
  return Number.isInteger(playerId) ? getPlayer(state, playerId) : null;
}

function renderCourtSeatTitleCartouche(state, kind, theme, holderId, count = null) {
  const holder = courtSeatHolder(state, holderId);
  return renderProvinceOfficeBadge(state, kind, theme, {
    holderId: holder?.id ?? null,
    compact: true,
    label: kind === 'estate' && count ? `Estates ×${count}` : undefined,
  });
}

// `count` is how many estates a revocation would take (estate seats only).
function renderCourtLinkSeat(state, kind, theme, holderId = null, count = null) {
  if (!theme) return '';
  const holder = courtSeatHolder(state, holderId);
  const countText = kind === 'estate' && count ? ` ×${count}` : '';
  return `
    <span class="court-link-seat-token ${escapeHtml(kind)}${holder ? ' tied' : ' open'}"
      ${holder ? `style="${getPlayerStyleAttr(state, holder.id)}"` : ''}
      title="${escapeHtml(`${courtSeatLabel(kind)}${countText} in ${theme.name}${holder ? `: ${playerDisplayLabel(holder)}` : ''}`)}">
      ${renderCourtSeatTitleCartouche(state, kind, theme, holder?.id ?? null, count)}
    </span>
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
      label: target?.label || `${courtSeatLabel(linkKind)} in ${theme.name}`,
    };
  }
  if (kind === 'estates') {
    const holderId = Number(titleType);
    const count = getRevocableEstateCount(theme, holderId);
    return {
      kind: 'estate',
      keyId: `${theme.id}:${holderId}`,
      theme,
      holderId,
      seatHtml: renderCourtLinkSeat(state, 'estate', theme, holderId, count),
      label: target?.label || `Estates in ${theme.name}`,
    };
  }
  return null;
}

// Estate rows are per dynasty, so their key carries the holder too.
function courtConnectionKey(kind, themeId) {
  return `${kind}:${themeId}`;
}

function ensureCourtPlan(draft) {
  if (!Array.isArray(draft.plannedActions)) draft.plannedActions = [];
  if (!Array.isArray(draft.plannedPassPowers)) draft.plannedPassPowers = [];
  return draft.plannedActions;
}

function courtPlanActionKey(action) {
  if (!action) return '';
  if (action.action === 'revoke') return `revoke:${action.value}`;
  if (action.action === 'appoint-bishop') return `bishop:${action.themeId}`;
  if (action.action === 'appoint-strategos') return `strategos:${action.themeId}`;
  return `${action.action}:${action.powerKey || ''}`;
}

function courtPlanActionPower(action) {
  return action?.powerKey || action?.titleKey || '';
}

function validateCourtPlan(state, playerId, actions) {
  const clone = cloneStateForValidation(state);
  for (const action of actions) {
    const result = applyCourtAction(clone, playerId, action);
    if (!result?.ok) return result || { ok: false, reason: 'Could not plan that action.' };
  }
  return { ok: true };
}

function getCourtPlanActionsWithCandidate(draft, action) {
  const actionKey = courtPlanActionKey(action);
  return ensureCourtPlan(draft)
    .filter((entry) => courtPlanActionKey(entry) !== actionKey)
    .concat(action);
}

function validateCourtPayloadWithDraft(state, playerId, draft, payload) {
  if (!draft) return validateCourtPayload(state, playerId, payload);
  return validateCourtPlan(state, playerId, getCourtPlanActionsWithCandidate(draft, payload));
}

function queueCourtPlannedAction(state, playerId, draft, action) {
  const nextActions = getCourtPlanActionsWithCandidate(draft, action);
  const validation = validateCourtPlan(state, playerId, nextActions);
  if (!validation.ok) {
    draft.planError = validation.reason || 'That plan is not legal.';
    return false;
  }
  draft.plannedActions = nextActions;
  delete draft.planError;
  return true;
}

function removeCourtPlannedAction(draft, actionKey) {
  ensureCourtPlan(draft);
  draft.plannedActions = draft.plannedActions.filter((entry) => courtPlanActionKey(entry) !== actionKey);
  delete draft.planError;
}

function toggleCourtPlannedRevocation(state, playerId, draft, powerKey, value) {
  const actionKey = `revoke:${value}`;
  if (ensureCourtPlan(draft).some((entry) => courtPlanActionKey(entry) === actionKey)) {
    removeCourtPlannedAction(draft, actionKey);
    return true;
  }
  return queueCourtPlannedAction(state, playerId, draft, {
    action: 'revoke',
    value,
    powerKey,
  });
}

function getPlannedCourtActionsForPower(draft, powerKey) {
  return ensureCourtPlan(draft).filter((action) => courtPlanActionPower(action) === powerKey);
}

function getPlannedActionForEntry(entry, plannedActions) {
  return plannedActions.find((action) => {
    if (action.action === 'revoke') return entry.revokeValue && action.value === entry.revokeValue;
    if (action.action === 'appoint-bishop') return entry.kind === 'bishop' && action.themeId === entry.theme.id;
    if (action.action === 'appoint-strategos') return entry.kind === 'strategos' && action.themeId === entry.theme.id;
    return false;
  }) || null;
}

function getCourtAppointmentDraft(draft, kind) {
  return kind === 'bishop' ? (draft.appointBishop || {}) : (draft.appointStrategos || {});
}

function buildCourtConnectionEntries(state, playerId, powerKey, draft) {
  const entries = [];
  const seen = new Set();
  const addEntry = (entry) => {
    if (!entry?.key || seen.has(entry.key)) return;
    seen.add(entry.key);
    entries.push(entry);
  };

  getRevocationTargets(state, playerId, powerKey)
    .map((target) => {
      const result = validateCourtPayloadWithDraft(state, playerId, draft, { action: 'revoke', value: target.value, powerKey });
      return { ...target, disabledReason: result.ok ? '' : result.reason };
    })
    .forEach((target) => {
      const link = describeRevocationLinkTarget(state, target);
      if (!link) return;
      addEntry({
        key: courtConnectionKey(link.kind, link.keyId || link.theme.id),
        mode: 'bound',
        kind: link.kind,
        theme: link.theme,
        holderId: link.holderId,
        label: link.label,
        seatHtml: link.seatHtml,
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
      powerKey,
      holderId: null,
      label: `${courtSeatLabel(kind)} in ${theme.name}`,
      seatHtml: renderCourtLinkSeat(state, kind, theme),
      action,
      targetAttr,
      playerAttr,
      buttonLabel,
      targetDisabledReason: getTargetDisabledReason(state, playerId, powerKey, theme.id, draft),
    });
  };

  if (powerKey === 'PATRIARCH') {
    getBishopTargets(state, playerId).forEach((theme) => addOpenAppointment('bishop', theme));
  } else {
    getStrategosTargets(state, playerId, powerKey).forEach((theme) => addOpenAppointment('strategos', theme));
  }
  return entries;
}

function renderCourtWirePlayerButton(state, player, index, activeEntry, draft, playerId, powerKey, linkedPlayerIds) {
  const isActiveOpen = Boolean(activeEntry);
  const linked = linkedPlayerIds.has(player.id);
  let disabledReason = '';
  let selected = false;
  let dataAttrs = '';
  if (isActiveOpen) {
    const appoint = getCourtAppointmentDraft(draft, activeEntry.kind);
    const targets = activeEntry.kind === 'bishop'
      ? getBishopTargets(state, playerId)
      : getStrategosTargets(state, playerId, powerKey);
    disabledReason = getAppointeeDisabledReason(state, playerId, powerKey, targets, player.id, activeEntry.theme.id, draft);
    selected = Number(appoint.playerId) === player.id && appoint.themeId === activeEntry.theme.id;
    dataAttrs = `
      data-${activeEntry.targetAttr}="${activeEntry.theme.id}"
      data-${activeEntry.playerAttr}="${player.id}"
      aria-pressed="${selected ? 'true' : 'false'}"
    `;
  }
  const socketAttrs = isActiveOpen
    ? `
      data-wire-player-finish="${player.id}"
      data-wire-kind="${escapeHtml(activeEntry.kind)}"
      data-wire-theme-id="${escapeHtml(activeEntry.theme.id)}"
      data-wire-power-key="${escapeHtml(powerKey || '')}"
    `
    : '';
  return `
    <button type="button"
      class="court-wire-player${linked ? ' linked' : ''}${selected ? ' selected' : ''}${disabledReason ? ' disabled' : ''}"
      style="--wire-row: ${index + 1}; ${getPlayerStyleAttr(state, player.id)}"
      data-wire-player-row="${player.id}"
      ${dataAttrs}
      ${disabledReason ? disabledChoiceAttrs(disabledReason, playerDisplayLabel(player)) : ''}>
      <span class="court-wire-socket court-wire-player-socket" ${socketAttrs} aria-hidden="true"></span>
      ${renderPlayerChip(state, player)}
    </button>
  `;
}

function renderCourtWireLines(state, entries, players, draft, playerId, powerKey, activeOpenEntry, layout, wireStep = COURT_WIRE_STEP) {
  const lines = [];
  entries.forEach((entry, entryIndex) => {
    const linePlayerId = normalizeWirePlayerId(entry.plannedHolderId ?? (entry.mode === 'bound' ? entry.holderId : null));
    if (linePlayerId == null) return;
    const holder = getPlayer(state, linePlayerId);
    const entryRow = layout?.entryRows?.get(entry.key) ?? entryIndex;
    const playerIndex = layout?.playerRows?.get(holder?.id) ?? players.findIndex((player) => player.id === holder?.id);
    const isPlannedAppointment = entry.mode === 'planned';
    lines.push(renderCourtWireLine(entry, entryRow, playerIndex, holder, {
      kind: 'bound',
      label: isPlannedAppointment
        ? `Cut planned appointment: ${entry.label}`
        : `Revoke ${entry.label}`,
      disabledReason: entry.revokeDisabledReason || '',
      lineKey: entry.key,
      step: wireStep,
      actionAttrs: isPlannedAppointment
        ? `data-plan-remove="${escapeHtml(courtPlanActionKey(entry.plannedAction))}" aria-label="${escapeHtml(`Remove planned appointment for ${entry.label}`)}"`
        : `data-link-revoke="${escapeHtml(entry.revokeValue)}" data-revoke-pick="${escapeHtml(entry.revokeValue)}" aria-label="${escapeHtml(`Revoke ${entry.label}`)}"`,
    }));
  });

  const wireStart = draft.wireStart || null;
  if (activeOpenEntry && wireStart?.kind === activeOpenEntry.kind && wireStart?.themeId === activeOpenEntry.theme.id) {
    const entryIndex = entries.findIndex((entry) => entry.key === activeOpenEntry.key);
    const entryRow = layout?.entryRows?.get(activeOpenEntry.key) ?? entryIndex;
    lines.push(renderCourtDraftWire(activeOpenEntry, entryRow, wireStep));
  }
  return lines.join('');
}

function renderCourtConnectionsForPower(state, playerId, draft, powerKey) {
  const plannedActions = getPlannedCourtActionsForPower(draft, powerKey);
  const entries = buildCourtConnectionEntries(state, playerId, powerKey, draft).map((entry) => {
    const plannedAction = getPlannedActionForEntry(entry, plannedActions);
    if (!plannedAction) return entry;
    if (plannedAction.action === 'revoke') {
      return {
        ...entry,
        mode: 'cut',
        plannedAction,
        holderId: null,
        seatHtml: renderCourtLinkSeat(state, entry.kind, entry.theme, null),
      };
    }
    const plannedHolderId = Number(plannedAction.appointeeId);
    return {
      ...entry,
      mode: 'planned',
      plannedAction,
      plannedHolderId,
      seatHtml: renderCourtLinkSeat(state, entry.kind, entry.theme, plannedHolderId),
    };
  });
  if (!entries.length) return '';
  const players = state.players || [];
  const openEntries = entries.filter((entry) => entry.mode === 'open');
  const selectedStrategos = draft.appointStrategos?.themeId
    ? courtConnectionKey('strategos', draft.appointStrategos.themeId)
    : null;
  const selectedBishop = draft.appointBishop?.themeId
    ? courtConnectionKey('bishop', draft.appointBishop.themeId)
    : null;
  const wireKey = draft.wireStart?.powerKey === powerKey && draft.wireStart?.kind && draft.wireStart?.themeId
    ? courtConnectionKey(draft.wireStart.kind, draft.wireStart.themeId)
    : null;
  const selectedKeys = new Set([wireKey, selectedStrategos, selectedBishop].filter(Boolean));
  const activeOpenEntry = openEntries.find((entry) => selectedKeys.has(entry.key)) || openEntries[0] || null;
  const activeKey = activeOpenEntry?.key || null;
  const layout = layoutCourtWireRows(entries, players);
  const linkedPlayerIds = new Set(entries
    .map((entry) => entry.plannedHolderId ?? (entry.mode === 'bound' ? entry.holderId : null))
    .map(normalizeWirePlayerId)
    .filter((id) => id != null));
  const rows = layout.rows;
  const wireStep = getCourtWireStep();
  const height = rows * wireStep;
  const openCount = openEntries.length;
  const cutCount = entries.filter((entry) => entry.mode === 'cut').length;
  const boundCount = entries.filter((entry) => entry.mode === 'bound' || entry.mode === 'planned').length;
  const warningRows = entries
    .map((entry) => ({
      label: entry.label,
      reason: entry.mode === 'bound' ? entry.revokeDisabledReason : entry.mode === 'cut' ? '' : entry.targetDisabledReason,
    }))
    .filter((entry) => entry.reason);
  return `
    <section class="court-link-section court-wire-section">
      <header class="court-link-section-head">
        <span class="appointment-section-title">Links</span>
        <span class="court-link-section-note">${boundCount} tied, ${openCount} open${cutCount ? `, ${cutCount} cut` : ''}. Click an office circle, guide the rope, then click a dynasty circle. Click a tied rope to cut it.</span>
      </header>
      <div class="court-wire-board${wireKey ? ' tying' : ''}${boundCount > 8 ? ' many-bound' : ''}" style="--wire-rows: ${rows}; --wire-step: ${wireStep}px;" data-court-wire-board data-court-power-key="${escapeHtml(powerKey || '')}">
        <div class="court-wire-col-head seats">Offices</div>
        <div class="court-wire-col-head players">Dynasties</div>
        <div class="court-wire-seats">
          ${entries
            .slice()
            .sort((left, right) => (layout.entryRows.get(left.key) ?? 0) - (layout.entryRows.get(right.key) ?? 0))
            .map((entry) => renderCourtWireSeat(entry, layout.entryRows.get(entry.key) ?? 0, entry.key === activeKey))
            .join('')}
        </div>
        <svg class="court-wire-svg" viewBox="0 0 1000 ${height}" preserveAspectRatio="none" aria-hidden="false">
          ${renderCourtWireLines(state, entries, players, draft, playerId, powerKey, activeOpenEntry, layout, wireStep)}
        </svg>
        <div class="court-wire-players">
          ${players.map((player) => renderCourtWirePlayerButton(state, player, layout.playerRows.get(player.id) ?? 0, activeOpenEntry, draft, playerId, powerKey, linkedPlayerIds)).join('')}
        </div>
      </div>
      ${warningRows.length ? `
        <details class="court-wire-note-list court-wire-note-details">
          <summary>${warningRows.length} unavailable ${warningRows.length === 1 ? 'link' : 'links'}</summary>
          <div class="court-wire-note-body">
            ${warningRows.map((entry) => `<span class="court-wire-note">${escapeHtml(entry.label)}: ${escapeHtml(entry.reason)}</span>`).join('')}
          </div>
        </details>
      ` : ''}
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

function renderCourtActionBudget(actionCount, plannedCount, actionLimit, powerLabel) {
  const committed = Math.max(0, Number(actionCount) || 0);
  const planned = Math.max(0, Number(plannedCount) || 0);
  const limit = Math.max(0, Number(actionLimit) || 0);
  const usedAfterPlan = Math.min(limit, committed + planned);
  const remaining = Math.max(0, limit - usedAfterPlan);
  const pips = Array.from({ length: limit }, (_, index) => {
    const stateClass = index < committed ? 'used' : index < committed + planned ? 'planned' : 'free';
    return `<span class="court-action-pip ${stateClass}"></span>`;
  }).join('');
  const summary = [
    `${committed} used`,
    planned ? `${planned} drafted` : '',
    `${remaining} left`,
  ].filter(Boolean).join(', ');
  return `
    <div class="court-action-budget" aria-label="${escapeHtml(`${powerLabel}: ${summary} out of ${limit} actions.`)}">
      <span class="court-action-budget-label">Actions</span>
      <span class="court-action-pips" aria-hidden="true">${pips}</span>
      <span class="court-action-budget-count"><strong>${remaining}</strong> left of ${limit}</span>
      ${planned ? `<span class="court-action-budget-draft">${planned} planned</span>` : ''}
    </div>
  `;
}

function renderCourtPowerCard(state, playerId, draft, powerKey) {
  const plannedActions = getPlannedCourtActionsForPower(draft, powerKey);
  const usedKinds = getCourtPowerActionKinds(state, playerId, powerKey);
  const appointmentCount = getCourtPowerAppointmentCount(state, playerId, powerKey);
  const revocationCount = getCourtPowerRevocationCount(state, playerId, powerKey);
  const actionCount = getCourtPowerActionCount(state, playerId, powerKey);
  const mode = getCourtPowerUseMode(state, playerId, powerKey);
  const passed = isCourtPowerPassed(state, playerId, powerKey);
  const exhausted = isCourtPowerExhausted(state, playerId, powerKey);
  const usedSummary = usedKinds.length ? usedKinds.join(', ') : getCourtPowerActionKind(state, playerId, powerKey);
  const connectionsHtml = renderCourtConnectionsForPower(state, playerId, draft, powerKey);
  const actionLimit = getCourtPowerActionLimit(powerKey, state);
  const remainingActions = Math.max(0, actionLimit - actionCount);
  const remainingAfterPlan = Math.max(0, actionLimit - actionCount - plannedActions.length);
  const powerLabel = getCourtPowerLabel(powerKey);
  const usedParts = [
    appointmentCount ? courtPowerCountLabel(appointmentCount, 'appointment') : '',
    revocationCount ? courtPowerCountLabel(revocationCount, 'revocation') : '',
  ].filter(Boolean).join(', ');
  const stateText = plannedActions.length
      ? `${plannedActions.length} planned`
      : actionCount
    ? `${actionCount}/${actionLimit} actions${usedParts ? ` (${usedParts})` : ''}`
    : passed
      ? 'Passed'
      : 'Choose actions';
  const hint = passed
    ? ''
    : plannedActions.length
    ? `${courtPowerCountLabel(remainingAfterPlan, 'action')} will remain if you lock this draft.`
    : actionCount > 0 && !exhausted
    ? `${courtPowerCountLabel(remainingActions, 'action')} remains for this office.`
    : !exhausted && powerKey === 'BASILEUS'
      ? `Up to ${actionLimit} estate revocations this round: one takes all of a dynasty's estates in one province.`
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
      ${renderCourtActionBudget(actionCount, plannedActions.length, actionLimit, powerLabel)}
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
  ensureCourtPlan(draft);
  const powerKeys = getVisibleCourtPowerKeys(state, activePlayerId);
  const confirmed = Boolean(state.courtActions?.playerConfirmed?.has(activePlayerId));
  const rerender = () => {
    renderCourtPanel(container, state, activePlayerId, callbacks, options);
    notifyDraftChange();
  };
  const plannedCount = draft.plannedActions.length;
  const hasPlan = plannedCount > 0;
  container.innerHTML = `
    <section class="phase-card court-panel">
      ${powerKeys.length ? `
        <div class="court-power-stack">
          ${powerKeys.map((powerKey) => renderCourtPowerCard(state, activePlayerId, draft, powerKey)).join('')}
        </div>
        <div class="appointment-preview court-plan-preview">
          ${hasPlan
            ? `${plannedCount} planned action${plannedCount === 1 ? '' : 's'}. Lock to commit, or reset to change everything.`
            : 'Plan appointments or revocations. Nothing is committed until you lock.'}
        </div>
        ${draft.planError ? `<p class="form-error" role="alert">${escapeHtml(draft.planError)}</p>` : ''}
        <div class="panel-actions court-plan-actions action-priority">
          <button type="button" class="btn-secondary btn-reset" data-action="reset-court-plan" ${hasPlan ? '' : 'disabled'}>Reset Plan</button>
          <button type="button" class="btn-primary btn-commit" data-action="confirm-court-plan">${hasPlan ? 'Lock Planned Actions' : 'Lock No Actions'}</button>
        </div>
      ` : `<div class="panel-empty">${confirmed ? 'Court business complete.' : 'No court actions available.'}</div>`}
    </section>
  `;

  // The circles are the controls here: click a seat socket, then a player socket.
  container.querySelectorAll('[data-wire-seat-start]').forEach((socket) => {
    socket.addEventListener('click', (event) => {
      event.stopPropagation();
      const row = socket.closest('.court-wire-seat');
      if (row?.disabled || row?.getAttribute('aria-disabled') === 'true') return;
      const kind = socket.dataset.wireKind;
      const themeId = socket.dataset.wireThemeId;
      const powerKey = socket.dataset.wirePowerKey;
      if (!kind || !themeId) return;
      draft.wireStart = { kind, themeId, powerKey };
      if (kind === 'bishop') draft.appointBishop = { themeId };
      else draft.appointStrategos = { themeId };
      rerender();
    });
  });

  container.querySelectorAll('[data-wire-player-finish]').forEach((socket) => {
    socket.addEventListener('click', (event) => {
      event.stopPropagation();
      const row = socket.closest('.court-wire-player');
      if (row?.disabled || row?.getAttribute('aria-disabled') === 'true') return;
      const wireStart = draft.wireStart;
      if (!wireStart) return;
      const kind = wireStart.kind;
      const themeId = wireStart.themeId;
      const powerKey = wireStart.powerKey || socket.dataset.wirePowerKey;
      const playerId = Number(socket.dataset.wirePlayerFinish);
      if (socket.dataset.wireKind !== kind || socket.dataset.wireThemeId !== themeId) return;
      if (!kind || !themeId || !Number.isInteger(playerId)) return;
      const disabledReason = getAppointmentDisabledReason(state, activePlayerId, powerKey, themeId, playerId, draft);
      if (disabledReason) return;
      delete draft.wireStart;
      const plannedAction = kind === 'bishop'
        ? { action: 'appoint-bishop', themeId, appointeeId: playerId, powerKey }
        : { action: 'appoint-strategos', titleKey: regionTitleFor(state.themes[themeId]), themeId, appointeeId: playerId, powerKey };
      queueCourtPlannedAction(state, activePlayerId, draft, plannedAction);
      rerender();
    });
  });

  bindWireGeometry(container);
  bindWireDraftMotion(container);
  bindWireFocus(container);

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
      const powerKey = button.closest('[data-court-power]')?.dataset.courtPower || '';
      toggleCourtPlannedRevocation(state, activePlayerId, draft, powerKey, target);
      rerender();
    });
  });
  container.querySelectorAll('[data-plan-remove]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      removeCourtPlannedAction(draft, button.dataset.planRemove || '');
      rerender();
    });
  });
  bindSelectAction(container, '[data-action="reset-court-plan"]', () => {
    draft.plannedActions = [];
    draft.plannedPassPowers = [];
    delete draft.wireStart;
    delete draft.planError;
    rerender();
  });
  bindSelectAction(container, '[data-action="confirm-court-plan"]', () => {
    const actions = ensureCourtPlan(draft).slice();
    const plannedCounts = actions.reduce((counts, action) => {
      const powerKey = courtPlanActionPower(action);
      counts[powerKey] = (counts[powerKey] || 0) + 1;
      return counts;
    }, {});
    const passPowers = powerKeys.filter((powerKey) => (
      getCourtPowerActionCount(state, activePlayerId, powerKey) + (plannedCounts[powerKey] || 0) < getCourtPowerActionLimit(powerKey, state)
    ));
    callbacks['submit-court-plan']?.({ actions, passPowers });
  });
}

// ---------------------------------------------------------------------------
// The same plan, driven from the map (ui/mapActions.js): what the dynasty
// can plan in one province, and the edits the map popover makes. They share
// the panel's draft, so the panel shows what was planned on the map.

function getCourtDraft(uiState, state, playerId) {
  const draft = getDraftBucket(uiState, state, 'court', playerId);
  if (!draft.appointStrategos) draft.appointStrategos = {};
  if (!draft.appointBishop) draft.appointBishop = {};
  if (!draft.revoke) draft.revoke = {};
  ensureCourtPlan(draft);
  return draft;
}

// [{ key, powerKey, powerLabel, kind, mode, label, holderId, revokeValue,
//    disabledReason, plannedAction, plannedKey, appointees }] for one
// province. `mode` is 'bound' (a holder that can be revoked) or 'open' (a
// seat to fill); `appointees` lists who can fill an open seat.
export function getProvinceCourtOptions(state, playerId, themeId, uiState) {
  if (state?.phase !== 'court' || !state.themes?.[themeId]) return { options: [], planError: '' };
  if (state.courtActions?.playerConfirmed?.has(playerId)) return { options: [], planError: '' };
  const draft = getCourtDraft(uiState, state, playerId);
  const options = [];
  for (const powerKey of getVisibleCourtPowerKeys(state, playerId)) {
    if (isCourtPowerExhausted(state, playerId, powerKey)) continue;
    const plannedActions = getPlannedCourtActionsForPower(draft, powerKey);
    for (const entry of buildCourtConnectionEntries(state, playerId, powerKey, draft)) {
      if (entry.theme?.id !== themeId) continue;
      const plannedAction = getPlannedActionForEntry(entry, plannedActions);
      const option = {
        key: entry.key,
        powerKey,
        powerLabel: getCourtPowerLabel(powerKey),
        kind: entry.kind,
        mode: entry.mode,
        label: entry.label,
        holderId: entry.holderId ?? null,
        revokeValue: entry.revokeValue || null,
        disabledReason: entry.mode === 'bound' ? entry.revokeDisabledReason || '' : entry.targetDisabledReason || '',
        plannedAction,
        plannedKey: plannedAction ? courtPlanActionKey(plannedAction) : null,
        appointees: [],
      };
      if (entry.mode === 'open') {
        option.appointees = (state.players || []).map((player) => ({
          playerId: player.id,
          disabledReason: getAppointmentDisabledReason(state, playerId, powerKey, themeId, player.id, draft),
        }));
      }
      options.push(option);
    }
  }
  return { options, planError: draft.planError || '' };
}

export function toggleProvinceRevocation(state, playerId, uiState, powerKey, value) {
  return toggleCourtPlannedRevocation(state, playerId, getCourtDraft(uiState, state, playerId), powerKey, value);
}

export function planProvinceAppointment(state, playerId, uiState, powerKey, kind, themeId, appointeeId) {
  const draft = getCourtDraft(uiState, state, playerId);
  const action = kind === 'bishop'
    ? { action: 'appoint-bishop', themeId, appointeeId, powerKey }
    : { action: 'appoint-strategos', titleKey: regionTitleFor(state.themes[themeId]), themeId, appointeeId, powerKey };
  delete draft.wireStart;
  return queueCourtPlannedAction(state, playerId, draft, action);
}

export function removeProvincePlannedAction(state, playerId, uiState, actionKey) {
  removeCourtPlannedAction(getCourtDraft(uiState, state, playerId), actionKey);
  return true;
}
