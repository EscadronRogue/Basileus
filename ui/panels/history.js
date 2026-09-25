// ui/panels/history.js - chronicle of past rounds.

import { MOODS } from '../../ai/mood.js';
import { escapeHtml } from '../html.js';
import { renderCartouchedText } from '../labels.js';

// The mood an AI dynasty announced, with what it means on hover.
function renderMoodTag(entry) {
  const mood = MOODS[entry.details?.mood];
  if (!mood) return '';
  return `<span class="history-entry-tag" title="${escapeHtml(mood.hint)}">${escapeHtml(mood.title)}</span>`;
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
            <article class="history-entry-card${entry.category === 'voice' ? ' is-voice' : ''}">
              <header class="history-entry-head">
                <span class="history-entry-round">R${entry.round}</span>
                <span class="history-entry-phase">${escapeHtml(entry.phase)}</span>
                ${entry.category === 'voice' ? renderMoodTag(entry) : ''}
              </header>
              <div class="history-entry-summary">${renderCartouchedText(state, entry.summary)}</div>
            </article>
          `).join('') : '<div class="panel-empty">No history yet.</div>'}
        </div>
      ` : ''}
    </div>
  `;
}
