// ui/panels/wires.js - the rope-and-circle link widget used by Court and Title Redistribution.

import { escapeHtml } from '../html.js';
import { disabledChoiceAttrs } from './shared.js';

export function bindWireDraftMotion(container) {
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

export function bindWireGeometry(container) {
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

export function bindWireFocus(container) {
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

export function normalizeWirePlayerId(value) {
  if (value == null || value === '') return null;
  const playerId = Number(value);
  return Number.isInteger(playerId) ? playerId : null;
}

export const COURT_WIRE_STEP = 58;
const COURT_WIRE_NARROW_STEP = 76;

export function getCourtWireStep() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return COURT_WIRE_STEP;
  }
  return window.matchMedia('(max-width: 560px)').matches
    ? COURT_WIRE_NARROW_STEP
    : COURT_WIRE_STEP;
}

function courtWireY(index, step = COURT_WIRE_STEP) {
  return Math.round(step / 2) + (Math.max(0, Number(index) || 0) * step);
}

export function renderCourtWireSeat(entry, index, active) {
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

export function renderCourtWireLine(entry, entryIndex, playerIndex, player, options = {}) {
  if (!player || playerIndex < 0) return '';
  const step = options.step || COURT_WIRE_STEP;
  const y1 = courtWireY(entryIndex, step);
  const y2 = courtWireY(playerIndex, step);
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

export function renderCourtDraftWire(entry, entryIndex, step = COURT_WIRE_STEP) {
  if (!entry || entryIndex < 0) return '';
  const y = courtWireY(entryIndex, step);
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

export function layoutCourtWireRows(entries, players) {
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
