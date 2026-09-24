// ui/phaseGuide.js - "How this phase works" card at the top of the action panel.
//
// Opens by itself the first time a player reaches each phase in this browser,
// then stays available collapsed. Text comes from PHASE_GUIDES in ui/rules.js.
import { PHASE_GUIDES, renderPhaseGuideHtml } from './rules.js';
import { escapeHtml } from './html.js';

const STORAGE_KEY = 'basileus.phaseGuides';

function readPrefs() {
  try {
    const prefs = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    return { seen: prefs?.seen || {}, autoOpen: prefs?.autoOpen !== false };
  } catch {
    return { seen: {}, autoOpen: true };
  }
}

function writePrefs(prefs) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Tips still work for this page view without storage.
  }
}

// The action panel re-renders on every click, so remember whether the guide
// is open for the phase on screen instead of re-deriving it each time.
let renderedPhase = null;
let openForPhase = null;

export function renderPhaseGuide(container, phase) {
  const guide = PHASE_GUIDES[phase];
  if (!container || !guide || typeof window === 'undefined') return null;
  if (phase !== renderedPhase) {
    renderedPhase = phase;
    openForPhase = null;
    const prefs = readPrefs();
    if (prefs.autoOpen && !prefs.seen[phase]) {
      prefs.seen[phase] = true;
      writePrefs(prefs);
      openForPhase = phase;
    }
  }
  const prefs = readPrefs();
  const open = openForPhase === phase;

  const card = document.createElement('details');
  card.className = 'phase-guide';
  card.open = open;
  card.innerHTML = `
    <summary><span class="phase-guide-kicker">How this phase works</span><span class="phase-guide-title">${escapeHtml(guide.title)}</span></summary>
    <div class="phase-guide-body">
      ${renderPhaseGuideHtml(phase)}
      <div class="phase-guide-actions">
        <button type="button" class="btn-secondary" data-phase-guide="dismiss">Got it</button>
        <button type="button" class="phase-guide-link" data-phase-guide="auto-off" ${prefs.autoOpen ? '' : 'hidden'}>Don't open tips automatically</button>
      </div>
    </div>
  `;
  card.addEventListener('toggle', () => {
    openForPhase = card.open ? phase : null;
  });
  card.querySelector('[data-phase-guide="dismiss"]').addEventListener('click', () => {
    card.open = false;
  });
  card.querySelector('[data-phase-guide="auto-off"]').addEventListener('click', (event) => {
    writePrefs({ ...readPrefs(), autoOpen: false });
    event.currentTarget.hidden = true;
    card.open = false;
  });
  container.append(card);
  return card;
}
