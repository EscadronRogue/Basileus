// ui/panels/shared.js - helpers shared by the phase panels: court targets, drafts, labels, bindings.

import { applyCourtAction } from '../../engine/commands.js';
import { getOfficeDisplayName, getOfficeHolder, getPlayer } from '../../engine/state.js';
import { getDeploymentArmyDisplayName, isStrategosDeploymentArmyKey } from '../../engine/deployment.js';
import { escapeHtml } from '../html.js';
import { renderThemeOfficeBadge, renderTitleBadge } from '../labels.js';

export function cloneStateForValidation(state) {
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

export function validateCourtPayload(state, playerId, payload) {
  if (!payload) return { ok: false, reason: 'Choose a legal court action.' };
  try {
    const result = applyCourtAction(cloneStateForValidation(state), playerId, payload);
    return result?.ok ? { ok: true } : { ok: false, reason: result?.reason || 'Not legal right now.' };
  } catch (error) {
    return { ok: false, reason: error?.message || 'Not legal right now.' };
  }
}

export function disabledChoiceAttrs(reason, label) {
  if (!reason) return '';
  const title = label ? `${label} - ${reason}` : reason;
  return ` disabled aria-disabled="true" title="${escapeHtml(title)}"`;
}

export function getDraftBucket(uiState, state, scope, playerId) {
  if (!uiState) return {};
  if (!uiState.drafts) uiState.drafts = {};
  const key = `${scope}:${state.round}:${playerId}`;
  if (!uiState.drafts[key]) uiState.drafts[key] = {};
  return uiState.drafts[key];
}

export function playerDisplayLabel(player) {
  return player?.firstName ? `${player.firstName} ${player.dynasty}` : (player?.dynasty || 'Player');
}

export function playerInitial(player) {
  const name = (player?.dynasty || '').trim();
  return name ? name[0].toUpperCase() : '?';
}

export function roleKeysForCourt(state, playerId) {
  const player = getPlayer(state, playerId);
  return [
    playerId === state.basileusId ? 'BASILEUS' : null,
    ...(player?.majorTitles || []),
  ].filter(Boolean);
}

export function regionTitleFor(theme) {
  return { east: 'DOM_EAST', west: 'DOM_WEST', sea: 'ADMIRAL' }[theme?.region] || null;
}

export function getStrategosTargets(state, playerId, powerKey = null) {
  const roles = new Set(powerKey ? [powerKey] : roleKeysForCourt(state, playerId));
  return Object.values(state.themes || {}).filter((theme) => (
    theme.id !== 'CPL'
    && !theme.lost
    && theme.strategos == null
    && roles.has(regionTitleFor(theme))
  ));
}

export function getBishopTargets(state, playerId) {
  const roles = new Set(roleKeysForCourt(state, playerId));
  if (!roles.has('PATRIARCH')) return [];
  return Object.values(state.themes || {}).filter((theme) => (
    theme.id !== 'CPL'
    && theme.bishop == null
    && (Number(theme.origin?.C) || 0) >= 1
  ));
}

export function getRevocationTargets(state, playerId, powerKey = null) {
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
    if (theme.strategos != null && !theme.lost && (roles.has(regionTitleFor(theme)) || isBasileusPower)) {
      pushTarget({ value: `minor:${theme.id}:strategos`, label: `Strategos of ${theme.name}` });
    }
    if (theme.bishop != null && roles.has('PATRIARCH')) {
      pushTarget({ value: `minor:${theme.id}:bishop`, label: `Bishop of ${theme.name}` });
    }
    if (isBasileusPower && Number.isInteger(theme.owner) && !theme.lost) {
      pushTarget({ value: `theme:${theme.id}`, label: `Estate in ${theme.name}` });
    }
  }
  return targets;
}

export function bindSelectAction(container, selector, callback) {
  container.querySelectorAll(selector).forEach((node) => {
    node.addEventListener('click', () => callback?.(node));
  });
}

export function renderPickerStep(num, label) {
  return `<div class="picker-step"><span class="picker-step-no">${num}</span><span class="picker-step-label">${label}</span></div>`;
}

export function renderArmyOfficeBadge(state, officeKey, playerId) {
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
