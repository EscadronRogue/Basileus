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
  getLandBidCommitment,
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
  getProvinceRegionPalette,
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

function bindWireDraftMotion(container) {
  container.querySelectorAll('[data-court-wire-board]').forEach((board) => {
    const svg = board.querySelector('.court-wire-svg');
    const draftLines = [...board.querySelectorAll('[data-wire-draft-line]')];
    if (!svg || !draftLines.length) return;
    const viewBox = svg.viewBox?.baseVal;
    const height = viewBox?.height || Number(svg.getAttribute('viewBox')?.split(/\s+/).at(3)) || 58;
    const toSvgPoint = (clientX, clientY) => {
      const rect = svg.getBoundingClientRect();
      const x = ((clientX - rect.left) / Math.max(rect.width, 1)) * 1000;
      const y = ((clientY - rect.top) / Math.max(rect.height, 1)) * height;
      return {
        x: Math.max(0, Math.min(1000, x)),
        y: Math.max(0, Math.min(height, y)),
      };
    };
    const setDraftEnd = ({ x, y }, color = '') => {
      draftLines.forEach((line) => {
        line.setAttribute('x2', String(Math.round(x)));
        line.setAttribute('y2', String(Math.round(y)));
        if (color) line.style.setProperty('--wire-color', color);
      });
    };
    board.addEventListener('pointermove', (event) => {
      setDraftEnd(toSvgPoint(event.clientX, event.clientY));
    });
    board.querySelectorAll('[data-wire-player-finish], [data-title-wire-finish]').forEach((socket) => {
      const snapToSocket = () => {
        const rect = socket.getBoundingClientRect();
        const playerRow = socket.closest('.court-wire-player');
        const color = playerRow ? getComputedStyle(playerRow).getPropertyValue('--player-color').trim() : '';
        setDraftEnd(toSvgPoint(rect.left + rect.width / 2, rect.top + rect.height / 2), color);
      };
      socket.addEventListener('pointerenter', snapToSocket);
      socket.addEventListener('focus', snapToSocket);
    });
  });
}

function getWireSvgPoint(svg, element) {
  if (!svg || !element) return null;
  const svgRect = svg.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const viewBox = svg.viewBox?.baseVal;
  const width = viewBox?.width || 1000;
  const height = viewBox?.height || Number(svg.getAttribute('viewBox')?.split(/\s+/).at(3)) || 58;
  return {
    x: ((elementRect.left + elementRect.width / 2 - svgRect.left) / Math.max(svgRect.width, 1)) * width,
    y: ((elementRect.top + elementRect.height / 2 - svgRect.top) / Math.max(svgRect.height, 1)) * height,
  };
}

function findWireRowByKey(board, key) {
  return [...board.querySelectorAll('[data-wire-row-key]')]
    .find((row) => row.dataset.wireRowKey === key) || null;
}

function findWirePlayerRow(board, playerId, copyIndex = '') {
  return [...board.querySelectorAll('[data-wire-player-row]')]
    .find((row) => (
      row.dataset.wirePlayerRow === String(playerId)
      && (copyIndex === '' || row.dataset.wirePlayerCopy === String(copyIndex))
    )) || null;
}

function setWireLineEndpoint(group, x1, y1, x2, y2) {
  group.querySelectorAll('.court-wire-line').forEach((line) => {
    line.setAttribute('x1', String(Math.round(x1)));
    line.setAttribute('y1', String(Math.round(y1)));
    line.setAttribute('x2', String(Math.round(x2)));
    line.setAttribute('y2', String(Math.round(y2)));
  });
  group.querySelectorAll('.court-wire-scissors, .court-wire-tie-label').forEach((label) => {
    label.setAttribute('x', String(Math.round((x1 + x2) / 2)));
    label.setAttribute('y', String(Math.round((y1 + y2) / 2)));
  });
}

function updateWireGeometry(container) {
  container.querySelectorAll('[data-court-wire-board]').forEach((board) => {
    const svg = board.querySelector('.court-wire-svg');
    if (!svg) return;
    board.querySelectorAll('[data-wire-line-key]').forEach((group) => {
      const seatRow = findWireRowByKey(board, group.dataset.wireLineKey);
      const playerRow = findWirePlayerRow(board, group.dataset.wireToPlayer, group.dataset.wireToCopy || '');
      const start = getWireSvgPoint(svg, seatRow?.querySelector('.court-wire-seat-socket'));
      const end = getWireSvgPoint(svg, playerRow?.querySelector('.court-wire-player-socket'));
      if (!start || !end) return;
      setWireLineEndpoint(group, start.x, start.y, end.x, end.y);
    });
    board.querySelectorAll('[data-wire-draft-key]').forEach((group) => {
      const seatRow = findWireRowByKey(board, group.dataset.wireDraftKey);
      const start = getWireSvgPoint(svg, seatRow?.querySelector('.court-wire-seat-socket'));
      if (!start) return;
      group.querySelectorAll('[data-wire-draft-line]').forEach((line) => {
        line.setAttribute('x1', String(Math.round(start.x)));
        line.setAttribute('y1', String(Math.round(start.y)));
      });
    });
  });
}

function bindWireGeometry(container) {
  if (typeof container.__courtWireGeometryCleanup === 'function') {
    container.__courtWireGeometryCleanup();
  }
  const update = () => updateWireGeometry(container);
  let frame = null;
  const scheduleUpdate = () => {
    if (frame != null) return;
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => {
        frame = null;
        update();
      });
    } else {
      frame = setTimeout(() => {
        frame = null;
        update();
      }, 0);
    }
  };
  const observed = [];
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(scheduleUpdate)
    : null;
  if (resizeObserver) {
    container
      .querySelectorAll('[data-court-wire-board], .court-wire-seat, .court-wire-player, .court-wire-svg')
      .forEach((node) => {
        resizeObserver.observe(node);
        observed.push(node);
      });
  }
  const onResize = () => scheduleUpdate();
  if (typeof window !== 'undefined') window.addEventListener('resize', onResize);
  const laterUpdates = [120, 360].map((delay) => {
    const timer = setTimeout(update, delay);
    if (typeof timer?.unref === 'function') timer.unref();
    return timer;
  });
  container.__courtWireGeometryCleanup = () => {
    if (frame != null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      else clearTimeout(frame);
      frame = null;
    }
    laterUpdates.forEach((timer) => clearTimeout(timer));
    if (resizeObserver) {
      observed.forEach((node) => resizeObserver.unobserve(node));
      resizeObserver.disconnect();
    }
    if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
  };
  update();
  scheduleUpdate();
}

function bindWireFocus(container) {
  container.querySelectorAll('[data-wire-row-key]').forEach((row) => {
    const key = row.dataset.wireRowKey;
    if (!key) return;
    const setFocused = (focused) => {
      container.querySelectorAll('[data-wire-line-key]').forEach((line) => {
        if (line.dataset.wireLineKey !== key) return;
        line.classList.toggle('is-wire-focused', focused);
      });
    };
    row.addEventListener('pointerenter', () => setFocused(true));
    row.addEventListener('pointerleave', () => setFocused(false));
    row.addEventListener('focusin', () => setFocused(true));
    row.addEventListener('focusout', () => setFocused(false));
  });
}

function renderPickerStep(num, label) {
  return `<div class="picker-step"><span class="picker-step-no">${num}</span><span class="picker-step-label">${label}</span></div>`;
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
                <span class="candidate-crest">${playerInitial(token.player)}</span>
                <span class="candidate-name">${escapeHtml(playerDisplayLabel(token.player))}</span>
                <span class="candidate-tag">${token.available ? `Copy ${token.copyIndex + 1}` : 'Tied'}</span>
              </button>
            `;
          }).join('')}
          </div>
        </div>
      </section>
      ${isBasileus ? `<div class="appointment-preview title-redist-link-preview">${escapeHtml(selectedSummary)}</div>` : ''}
      <p class="form-error" data-role="title-reassignment-error">${complete && !validation.ok ? escapeHtml(validation.reason || '') : ''}</p>
      <div class="panel-actions">
        <button type="button" class="btn-primary" data-action="confirm-title-redistribution" ${canConfirm ? '' : 'disabled'}>${validation.ok ? 'Lock Offices' : 'Finish Office Slots'}</button>
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

function courtSeatShortLabel(kind) {
  if (kind === 'strategos') return 'Strategos';
  if (kind === 'bishop') return 'Bishop';
  if (kind === 'estate') return 'Estate';
  return 'Seat';
}

function courtSeatTitleKind(kind) {
  if (kind === 'strategos') return 'STRATEGOS';
  if (kind === 'bishop') return 'BISHOP';
  return null;
}

function courtSeatHolder(state, holderId) {
  if (holderId == null || holderId === '') return null;
  const playerId = Number(holderId);
  return Number.isInteger(playerId) ? getPlayer(state, playerId) : null;
}

function renderCourtSeatTitleCartouche(state, kind, theme, holderId) {
  const holder = courtSeatHolder(state, holderId);
  const titleKind = courtSeatTitleKind(kind);
  if (titleKind) {
    return renderTitleBadge(state, titleKind, {
      holderId: holder?.id ?? null,
      themeId: theme.id,
      compact: true,
      label: `${courtSeatShortLabel(kind)} ${theme.name}`,
    });
  }
  if (kind === 'estate' && holder) {
    const palette = getProvinceRegionPalette(theme);
    return renderOwnershipBadge(state, {
      kind,
      holderId: holder.id,
      color: holder.color || '#5a3810',
      accent: palette.outline,
    }, {
      compact: true,
      label: `Estate ${theme.name}`,
      title: `Private estate in ${theme.name}: ${playerDisplayLabel(holder)}`,
    });
  }
  if (kind === 'estate') {
    const palette = getProvinceRegionPalette(theme);
    return `
      <span class="ownership-badge ownership-badge-estate compact vacant"
        style="--ownership-accent: ${palette.outline};"
        title="Private estate" aria-label="Private estate">
        <span class="ownership-mark" aria-hidden="true"></span>
        <span class="ownership-text">${escapeHtml(`Estate ${theme.name}`)}</span>
      </span>
    `;
  }
  return '';
}

function renderCourtLinkSeat(state, kind, theme, holderId = null) {
  if (!theme) return '';
  const holder = courtSeatHolder(state, holderId);
  return `
    <span class="court-link-seat-token ${escapeHtml(kind)}${holder ? ' tied' : ' open'}"
      ${holder ? `style="${getPlayerStyleAttr(state, holder.id)}"` : ''}
      title="${escapeHtml(`${courtSeatLabel(kind)} in ${theme.name}${holder ? `: ${playerDisplayLabel(holder)}` : ''}`)}">
      ${renderCourtSeatTitleCartouche(state, kind, theme, holder?.id ?? null)}
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
  if (kind === 'theme') {
    return {
      kind: 'estate',
      theme,
      holderId: theme.owner,
      seatHtml: renderCourtLinkSeat(state, 'estate', theme, theme.owner),
      label: target?.label || `Estate in ${theme.name}`,
    };
  }
  return null;
}

function courtConnectionKey(kind, themeId) {
  return `${kind}:${themeId}`;
}

function normalizeWirePlayerId(value) {
  if (value == null || value === '') return null;
  const playerId = Number(value);
  return Number.isInteger(playerId) ? playerId : null;
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

function queueCourtPlannedAction(state, playerId, draft, action) {
  const actions = ensureCourtPlan(draft);
  const actionKey = courtPlanActionKey(action);
  const nextActions = actions
    .filter((entry) => courtPlanActionKey(entry) !== actionKey)
    .concat(action);
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

function courtWireY(index) {
  return 29 + (Math.max(0, Number(index) || 0) * 58);
}

function renderCourtWireSeat(entry, index, active) {
  const selectedClass = active ? ' selected' : '';
  const disabledReason = entry.mode === 'bound' ? entry.revokeDisabledReason : entry.targetDisabledReason;
  const canStartWire = entry.mode === 'open';
  const startAttrs = canStartWire
    ? `
      data-wire-seat-start="${escapeHtml(entry.key)}"
      data-wire-kind="${escapeHtml(entry.kind)}"
      data-wire-theme-id="${escapeHtml(entry.theme.id)}"
      data-wire-power-key="${escapeHtml(entry.powerKey || '')}"
    `
    : '';
  return `
    <button type="button"
      class="court-wire-seat court-link-connection ${entry.mode}${selectedClass}${disabledReason ? ' disabled' : ''}"
      style="--wire-row: ${index + 1};"
      data-link-kind="${escapeHtml(entry.kind)}"
      data-wire-row-key="${escapeHtml(entry.key)}"
      data-map-province="${escapeHtml(entry.theme.id)}"
      ${entry.revokeValue ? `data-revoke-pick="${escapeHtml(entry.revokeValue)}"` : ''}
      ${entry.mode === 'open' ? `data-${entry.targetAttr}="${entry.theme.id}"` : ''}
      aria-pressed="${active ? 'true' : 'false'}"
      ${disabledReason ? disabledChoiceAttrs(disabledReason, entry.label) : ''}>
      <span class="court-wire-seat-copy">${entry.seatHtml}</span>
      <span class="court-wire-socket court-wire-seat-socket" ${startAttrs} aria-hidden="true"></span>
    </button>
  `;
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
    disabledReason = getAppointeeDisabledReason(state, playerId, powerKey, targets, player.id, activeEntry.theme.id);
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
      <span class="candidate-crest">${playerInitial(player)}</span>
      <span class="candidate-name">${escapeHtml(playerDisplayLabel(player))}</span>
    </button>
  `;
}

function renderCourtWireLine(entry, entryIndex, playerIndex, player, options = {}) {
  if (!player || playerIndex < 0) return '';
  const y1 = courtWireY(entryIndex);
  const y2 = courtWireY(playerIndex);
  const midX = 510;
  const midY = Math.round((y1 + y2) / 2);
  const stroke = escapeHtml(player.color || '#5a3810');
  const disabledReason = options.disabledReason || '';
  const actionAttrs = options.actionAttrs || '';
  const label = options.label || entry.label;
  const lineKey = options.lineKey || entry.key || '';
  const toCopy = options.toCopyIndex == null ? '' : ` data-wire-to-copy="${escapeHtml(options.toCopyIndex)}"`;
  return `
    <g class="court-wire-link ${options.kind || entry.mode}${disabledReason ? ' disabled' : ''}" ${lineKey ? `data-wire-line-key="${escapeHtml(lineKey)}"` : ''} data-wire-to-player="${player.id}"${toCopy}>
      <line class="court-wire-line court-wire-shadow" x1="335" y1="${y1}" x2="665" y2="${y2}"></line>
      <line class="court-wire-line court-wire-visible"
        x1="335" y1="${y1}" x2="665" y2="${y2}"
        style="--wire-color: ${stroke};"
        ${actionAttrs}
        ${disabledReason ? disabledChoiceAttrs(disabledReason, label) : `title="${escapeHtml(label)}"`}></line>
      <line class="court-wire-line court-wire-hit"
        x1="335" y1="${y1}" x2="665" y2="${y2}"
        ${actionAttrs}
        ${disabledReason ? disabledChoiceAttrs(disabledReason, label) : `title="${escapeHtml(label)}"`}></line>
      ${options.kind === 'bound'
        ? `<text class="court-wire-scissors" x="${midX}" y="${midY}" ${actionAttrs} ${disabledReason ? disabledChoiceAttrs(disabledReason, label) : `title="${escapeHtml(label)}"`}>&#9986;</text>`
        : ''}
    </g>
  `;
}

function renderCourtDraftWire(entry, entryIndex) {
  if (!entry || entryIndex < 0) return '';
  const y = courtWireY(entryIndex);
  const label = `Tie ${entry.label}`;
  return `
    <g class="court-wire-link drawing" data-wire-draft-key="${escapeHtml(entry.key || '')}" aria-label="${escapeHtml(label)}">
      <line class="court-wire-line court-wire-shadow" x1="335" y1="${y}" x2="500" y2="${y}" data-wire-draft-line></line>
      <line class="court-wire-line court-wire-visible"
        x1="335" y1="${y}" x2="500" y2="${y}"
        style="--wire-color: var(--gold-1);"
        data-wire-draft-line
        title="${escapeHtml(label)}"></line>
    </g>
  `;
}

function layoutCourtWireRows(entries, players) {
  const ownerGroups = new Map();
  const unowned = [];
  entries.forEach((entry) => {
    const holderId = normalizeWirePlayerId(entry.plannedHolderId ?? (entry.mode === 'bound' ? entry.holderId : null));
    if (holderId != null) {
      const key = holderId;
      if (!ownerGroups.has(key)) ownerGroups.set(key, []);
      ownerGroups.get(key).push(entry);
    } else {
      unowned.push(entry);
    }
  });

  const entryRows = new Map();
  const playerRows = new Map();
  const hasOwnerGroups = ownerGroups.size > 0;
  let cursor = 0;

  if (hasOwnerGroups) {
    players.forEach((player) => {
      const group = ownerGroups.get(player.id) || [];
      if (group.length) {
        group.forEach((entry, index) => entryRows.set(entry.key, cursor + index));
        playerRows.set(player.id, cursor + Math.floor((group.length - 1) / 2));
        cursor += group.length + 1;
      } else {
        playerRows.set(player.id, cursor);
        cursor += 1;
      }
    });
    unowned.forEach((entry) => {
      entryRows.set(entry.key, cursor);
      cursor += 1;
    });
  } else {
    const rowCount = Math.max(entries.length, players.length, 1);
    entries.forEach((entry, index) => entryRows.set(entry.key, index));
    players.forEach((player, index) => {
      const row = players.length <= 1 ? Math.floor((rowCount - 1) / 2) : Math.round((index * (rowCount - 1)) / Math.max(players.length - 1, 1));
      playerRows.set(player.id, row);
    });
    cursor = rowCount;
  }

  const maxEntryRow = Math.max(-1, ...entryRows.values());
  const maxPlayerRow = Math.max(-1, ...playerRows.values());
  return {
    entryRows,
    playerRows,
    rows: Math.max(cursor, maxEntryRow + 1, maxPlayerRow + 1, 1),
  };
}

function renderCourtWireLines(state, entries, players, draft, playerId, powerKey, activeOpenEntry, layout) {
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
      actionAttrs: isPlannedAppointment
        ? `data-plan-remove="${escapeHtml(courtPlanActionKey(entry.plannedAction))}" aria-label="${escapeHtml(`Remove planned appointment for ${entry.label}`)}"`
        : `data-link-revoke="${escapeHtml(entry.revokeValue)}" data-revoke-pick="${escapeHtml(entry.revokeValue)}" aria-label="${escapeHtml(`Revoke ${entry.label}`)}"`,
    }));
  });

  const wireStart = draft.wireStart || null;
  if (activeOpenEntry && wireStart?.kind === activeOpenEntry.kind && wireStart?.themeId === activeOpenEntry.theme.id) {
    const entryIndex = entries.findIndex((entry) => entry.key === activeOpenEntry.key);
    const entryRow = layout?.entryRows?.get(activeOpenEntry.key) ?? entryIndex;
    lines.push(renderCourtDraftWire(activeOpenEntry, entryRow));
  }
  return lines.join('');
}

function renderCourtConnectionsForPower(state, playerId, draft, powerKey) {
  const plannedActions = getPlannedCourtActionsForPower(draft, powerKey);
  const entries = buildCourtConnectionEntries(state, playerId, powerKey).map((entry) => {
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
  const height = rows * 58;
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
        <span class="court-link-section-note">${boundCount} tied, ${openCount} open${cutCount ? `, ${cutCount} cut` : ''}. Click a seat circle, guide the rope, then click a dynasty circle. Click a tied rope to cut it.</span>
      </header>
      <div class="court-wire-board${wireKey ? ' tying' : ''}${boundCount > 8 ? ' many-bound' : ''}" style="--wire-rows: ${rows};" data-court-wire-board data-court-power-key="${escapeHtml(powerKey || '')}">
        <div class="court-wire-col-head seats">Seats</div>
        <div class="court-wire-col-head players">Dynasties</div>
        <div class="court-wire-seats">
          ${entries
            .slice()
            .sort((left, right) => (layout.entryRows.get(left.key) ?? 0) - (layout.entryRows.get(right.key) ?? 0))
            .map((entry) => renderCourtWireSeat(entry, layout.entryRows.get(entry.key) ?? 0, entry.key === activeKey))
            .join('')}
        </div>
        <svg class="court-wire-svg" viewBox="0 0 1000 ${height}" preserveAspectRatio="none" aria-hidden="false">
          ${renderCourtWireLines(state, entries, players, draft, playerId, powerKey, activeOpenEntry, layout)}
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

function renderCourtPowerCard(state, playerId, draft, powerKey) {
  const plannedActions = getPlannedCourtActionsForPower(draft, powerKey);
  const plannedPass = ensureCourtPlan(draft) && draft.plannedPassPowers.includes(powerKey);
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
  const stateText = plannedPass
    ? 'Planned skip'
    : plannedActions.length
      ? `${plannedActions.length} planned`
      : actionCount
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
          <button type="button" class="btn-secondary" data-action="pass-court-power" data-court-pass-power="${escapeHtml(powerKey)}">${plannedPass ? 'Undo Skip' : actionCount ? 'Plan Skip Rest' : 'Plan Skip'}</button>
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
  ensureCourtPlan(draft);
  const powerKeys = getVisibleCourtPowerKeys(state, activePlayerId);
  const confirmed = Boolean(state.courtActions?.playerConfirmed?.has(activePlayerId));
  const rerender = () => renderCourtPanel(container, state, activePlayerId, callbacks, options);
  const plannedCount = draft.plannedActions.length;
  const plannedPassCount = draft.plannedPassPowers.length;
  const hasPlan = plannedCount > 0 || plannedPassCount > 0;
  container.innerHTML = `
    <section class="phase-card court-panel">
      ${powerKeys.length ? `
        <div class="court-power-stack">
          ${powerKeys.map((powerKey) => renderCourtPowerCard(state, activePlayerId, draft, powerKey)).join('')}
        </div>
        <div class="appointment-preview court-plan-preview">
          ${hasPlan
            ? `${plannedCount} planned action${plannedCount === 1 ? '' : 's'}${plannedPassCount ? `, ${plannedPassCount} planned skip${plannedPassCount === 1 ? '' : 's'}` : ''}. Lock to commit, or reset to change everything.`
            : 'Plan appointments, revocations, or skips. Nothing is committed until you lock.'}
        </div>
        ${draft.planError ? `<p class="form-error">${escapeHtml(draft.planError)}</p>` : ''}
        <div class="panel-actions court-plan-actions">
          <button type="button" class="btn-secondary" data-action="reset-court-plan" ${hasPlan ? '' : 'disabled'}>Reset Plan</button>
          <button type="button" class="btn-primary" data-action="confirm-court-plan">${hasPlan ? 'Lock Planned Actions' : 'Lock No Actions'}</button>
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
      const disabledReason = getAppointmentDisabledReason(state, activePlayerId, powerKey, themeId, playerId);
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
  bindSelectAction(container, '[data-action="pass-court-power"]', (btn) => {
    const powerKey = btn.dataset.courtPassPower;
    if (!powerKey) return;
    ensureCourtPlan(draft);
    if (draft.plannedPassPowers.includes(powerKey)) {
      draft.plannedPassPowers = draft.plannedPassPowers.filter((entry) => entry !== powerKey);
    } else {
      draft.plannedPassPowers.push(powerKey);
    }
    rerender();
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
      getCourtPowerActionCount(state, activePlayerId, powerKey) + (plannedCounts[powerKey] || 0) < getCourtPowerActionLimit(powerKey)
    ));
    callbacks['submit-court-plan']?.({ actions, passPowers });
  });
}

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
      <div class="panel-actions">
        <button type="button" class="btn-secondary" data-action="reset-estate-plan" ${draftCommitment ? '' : 'disabled'}>Reset Bids</button>
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
