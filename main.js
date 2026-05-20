import { makeChoiceRng, pickRandom, resolveConfiguredSeed } from './engine/setup.js';
import { GameController } from './ui/gameController.js';
import { launchMultiplayerClient } from './ui/multiplayerController.js';
import { loadBrowserAiOpponentRoster } from './ai/brain.js';
import { DYNASTY_COLORS } from './data/invasions.js';

const SETUP_RANDOM_VALUE = 'random';

const setupDialog = document.getElementById('setupDialog');
const btnStart = document.getElementById('btnStart');
const btnCreateRoom = document.getElementById('btnCreateRoom');
const btnJoinRoom = document.getElementById('btnJoinRoom');
const defaultSetupActions = document.getElementById('defaultSetupActions');
const setupPlayers = document.getElementById('setupPlayers');
const setupDeck = document.getElementById('setupDeck');
const setupMode = document.getElementById('setupMode');
const setupSeat = document.getElementById('setupSeat');
const singlePlayerFields = document.getElementById('singlePlayerFields');
const multiplayerFields = document.getElementById('multiplayerFields');
const setupPlayerName = document.getElementById('setupPlayerName');
const setupRoomCode = document.getElementById('setupRoomCode');
const setupSaveFile = document.getElementById('setupSaveFile');
const setupMultiplayerError = document.getElementById('setupMultiplayerError');
const setupStartError = document.getElementById('setupStartError');
const setupAiRoster = document.getElementById('setupAiRoster');
const setupAiRosterHint = document.getElementById('setupAiRosterHint');

let multiplayerLaunchInFlight = false;
let gameLaunchInFlight = false;
let aiOpponentRoster = [];
let aiOpponentRosterLoaded = false;
let aiOpponentRosterError = '';
const selectedAiOpponentBySeat = new Map();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function seatCartoucheStyle(seat) {
  const color = DYNASTY_COLORS[(Math.max(1, Number(seat) || 1) - 1) % DYNASTY_COLORS.length] || '#5a3810';
  return `--player-color: ${color}; --role-color: var(--empire-border); --role-outline-color: var(--empire-border);`;
}

function renderSetupChoiceControl(select) {
  if (!select) return;
  select.classList.add('setup-select-source');
  let row = select.nextElementSibling;
  if (!row?.matches?.(`[data-setup-choice="${select.id}"]`)) {
    row = document.createElement('div');
    row.className = 'setup-choice-row';
    row.dataset.setupChoice = select.id;
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', select.closest('.setup-field')?.querySelector('label')?.textContent?.trim() || select.id);
    select.insertAdjacentElement('afterend', row);
  }
  row.innerHTML = [...select.options].map((option) => `
    <button type="button"
      class="setup-choice-btn${option.selected ? ' selected' : ''}"
      role="radio"
      aria-checked="${option.selected ? 'true' : 'false'}"
      data-setup-choice-value="${escapeHtml(option.value)}">
      ${escapeHtml(option.textContent.trim())}
    </button>
  `).join('');
  row.querySelectorAll('[data-setup-choice-value]').forEach((button) => {
    button.addEventListener('click', () => {
      if (select.value === button.dataset.setupChoiceValue) return;
      select.value = button.dataset.setupChoiceValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      renderSetupChoiceControl(select);
    });
  });
}

function renderSetupChoiceControls() {
  [setupPlayers, setupDeck, setupMode, setupSeat].forEach(renderSetupChoiceControl);
}

function getNonRandomOptionValues(select) {
  return [...select.options]
    .map((option) => option.value)
    .filter((value) => value && value !== SETUP_RANDOM_VALUE);
}

function getSupportedPlayerCounts() {
  return getNonRandomOptionValues(setupPlayers)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isInteger);
}

function getConfiguredPlayerCountForUi() {
  const explicitValue = Number.parseInt(setupPlayers.value, 10);
  if (Number.isInteger(explicitValue) && explicitValue > 0) return explicitValue;
  const supportedCounts = getSupportedPlayerCounts();
  return supportedCounts.length ? Math.max(...supportedCounts) : 4;
}

function resolveRandomValue(rawValue, choices, rng, fallback = null) {
  if (rawValue === SETUP_RANDOM_VALUE) return pickRandom(rng, choices, fallback);
  return rawValue;
}

function clampSeatIndex(rawSeatValue, playerCount) {
  const seatNumber = Number.parseInt(rawSeatValue, 10);
  if (!Number.isInteger(seatNumber)) return 0;
  return Math.max(0, Math.min(playerCount - 1, seatNumber - 1));
}

function refreshSeatOptions() {
  const playerCount = getConfiguredPlayerCountForUi();
  const currentValue = setupSeat.value || SETUP_RANDOM_VALUE;
  const clampedSeat = currentValue === SETUP_RANDOM_VALUE
    ? SETUP_RANDOM_VALUE
    : String(Math.min(Math.max(Number.parseInt(currentValue, 10) || 1, 1), playerCount));

  setupSeat.innerHTML = [
    `<option value="${SETUP_RANDOM_VALUE}" ${clampedSeat === SETUP_RANDOM_VALUE ? 'selected' : ''}>Random Valid Seat</option>`,
    ...Array.from({ length: playerCount }, (_, index) => {
      const seat = index + 1;
      return `<option value="${seat}" ${String(seat) === clampedSeat ? 'selected' : ''}>Seat ${seat}</option>`;
    }),
  ].join('');
  renderSetupChoiceControl(setupSeat);
}

function updateStartAvailability() {
  const needsAiRoster = setupMode.value === 'single';
  btnStart.disabled = gameLaunchInFlight || (needsAiRoster && (!aiOpponentRosterLoaded || aiOpponentRoster.length === 0));
  if (btnJoinRoom) {
    btnJoinRoom.disabled = setupRoomCode.value.trim().length !== 6;
  }
}

function setSetupError(message = '') {
  if (setupStartError) setupStartError.textContent = message;
}

function setMultiplayerError(message = '') {
  if (setupMultiplayerError) setupMultiplayerError.textContent = message;
}

function renderAiRoster() {
  if (setupMode.value !== 'single') {
    setupAiRoster.innerHTML = '';
    updateStartAvailability();
    return;
  }

  const playerCount = getConfiguredPlayerCountForUi();
  const playerCountIsRandom = setupPlayers.value === SETUP_RANDOM_VALUE;
  const seatIsRandom = setupSeat.value === SETUP_RANDOM_VALUE;
  const seatAssignmentUnresolved = playerCountIsRandom || seatIsRandom;
  const humanSeat = clampSeatIndex(setupSeat.value, playerCount) + 1;
  const aiSeats = Array.from({ length: playerCount }, (_, index) => index + 1)
    .filter((seat) => seatAssignmentUnresolved || seat !== humanSeat);

  if (!aiOpponentRosterLoaded) {
    setupAiRoster.innerHTML = '<div class="setup-ai-seat setup-ai-seat-empty"><strong>Loading AI placeholders...</strong><span>Preparing named seats</span></div>';
    setupAiRosterHint.textContent = 'AI seats are placeholders until a new AI system is installed.';
    updateStartAvailability();
    return;
  }

  if (!aiOpponentRoster.length) {
    setupAiRoster.innerHTML = `
      <div class="setup-ai-seat setup-ai-seat-empty">
        <strong>No AI opponents found</strong>
        <span>${escapeHtml(aiOpponentRosterError || 'No AI placeholders are available.')}</span>
      </div>
    `;
    setupAiRosterHint.textContent = 'Single-player AI is unavailable until seat placeholders are available.';
    updateStartAvailability();
    return;
  }

  if (seatAssignmentUnresolved) {
    setupAiRoster.innerHTML = `
      <div class="setup-ai-seat setup-ai-seat-empty">
        <strong>AI names assigned at start</strong>
        <span>Random setup will resolve your seat first, then fill the remaining seats with Greek placeholders.</span>
      </div>
    `;
    setupAiRosterHint.textContent = 'Choose a fixed player count and seat to customize individual AI names.';
    updateStartAvailability();
    return;
  }

  setupAiRoster.innerHTML = aiSeats.map((seat, index) => {
    const existing = selectedAiOpponentBySeat.get(seat);
    const selectedId = aiOpponentRoster.some((opponent) => opponent.id === existing)
      ? existing
      : aiOpponentRoster[index % aiOpponentRoster.length]?.id;
    selectedAiOpponentBySeat.set(seat, selectedId);
    const selectedOpponent = aiOpponentRoster.find((opponent) => opponent.id === selectedId);
    return `
      <div class="setup-ai-seat" style="${seatCartoucheStyle(seat)}" data-seat="${seat}">
        <span class="choice-crest">S${seat}</span>
        <span class="setup-ai-copy">
          <strong>Seat ${seat}</strong>
          <span>${escapeHtml(selectedOpponent?.firstName || selectedOpponent?.id || 'Choose opponent')}</span>
        </span>
        <span class="setup-ai-choice-row">
          ${aiOpponentRoster.map((opponent) => {
            const label = opponent.firstName || opponent.id;
            const selected = opponent.id === selectedId;
            return `
              <button type="button"
                class="setup-ai-opponent-btn${selected ? ' selected' : ''}"
                data-seat="${seat}"
                data-ai-opponent="${escapeHtml(opponent.id)}">
                ${escapeHtml(label)}
              </button>
            `;
          }).join('')}
        </span>
      </div>
    `;
  }).join('');

  setupAiRoster.querySelectorAll('.setup-ai-opponent-btn').forEach((button) => {
    button.addEventListener('click', () => {
      selectedAiOpponentBySeat.set(Number(button.dataset.seat), button.dataset.aiOpponent);
      setSetupError('');
      renderAiRoster();
    });
  });

  setupAiRosterHint.textContent = 'Choose a Greek name placeholder for each AI seat.';
  updateStartAvailability();
}

function refreshModeVisibility() {
  const mode = setupMode.value;
  singlePlayerFields.hidden = mode !== 'single';
  multiplayerFields.hidden = mode !== 'multiplayer';
  if (defaultSetupActions) defaultSetupActions.hidden = mode === 'multiplayer';
  setSetupError('');
  setMultiplayerError('');
  renderAiRoster();
}

async function readSelectedMultiplayerSave() {
  const file = setupSaveFile?.files?.[0];
  if (!file) return null;
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new Error('Saved match file must be valid JSON.');
  }
}

function buildAiOpponentSelections(playerCount, humanSeat) {
  const selections = [];
  if (!aiOpponentRoster.length) return selections;
  for (let playerId = 0; playerId < playerCount; playerId += 1) {
    if (playerId === humanSeat) continue;
    const seat = playerId + 1;
    const selectedId = selectedAiOpponentBySeat.get(seat) || aiOpponentRoster[selections.length % aiOpponentRoster.length]?.id;
    const opponent = aiOpponentRoster.find((entry) => entry.id === selectedId) || aiOpponentRoster[0];
    if (!opponent) continue;
    selections.push({
      playerId,
      id: opponent.id,
      firstName: opponent.firstName,
      label: opponent.label,
    });
  }
  return selections;
}

async function launchMultiplayerFlow(intent) {
  if (multiplayerLaunchInFlight) return;
  multiplayerLaunchInFlight = true;
  setSetupError('');
  if (btnCreateRoom) btnCreateRoom.disabled = true;
  if (btnJoinRoom) btnJoinRoom.disabled = true;

  const seedInput = document.getElementById('setupSeed').value.trim();
  const seed = resolveConfiguredSeed(seedInput);
  const setupRng = makeChoiceRng(seed);

  const playerCount = Number.parseInt(
    resolveRandomValue(setupPlayers.value, getNonRandomOptionValues(setupPlayers), setupRng, '4'),
    10,
  );
  const deckSize = Number.parseInt(
    resolveRandomValue(setupDeck.value, getNonRandomOptionValues(setupDeck), setupRng, '9'),
    10,
  );

  try {
    const saveGame = intent === 'create' ? await readSelectedMultiplayerSave() : null;
    if (typeof window.__basileus?.disconnect === 'function') {
      window.__basileus.disconnect();
    }
    const multiplayer = await launchMultiplayerClient({
      intent,
      setupDialog,
      playerName: setupPlayerName.value.trim() || 'Guest',
      roomCode: intent === 'join' ? setupRoomCode.value.trim() : '',
      config: {
        playerCount,
        deckSize,
        seed: seedInput,
      },
      saveGame,
    });
    window.__basileus = multiplayer;
    setMultiplayerError('');
  } catch (error) {
    setupDialog.style.display = 'flex';
    const reason = error?.message || 'Could not reach the multiplayer server.';
    setMultiplayerError(intent === 'join' ? `Join Room failed: ${reason}` : `Create Room failed: ${reason}`);
  } finally {
    multiplayerLaunchInFlight = false;
    if (btnCreateRoom) btnCreateRoom.disabled = false;
    if (btnJoinRoom) btnJoinRoom.disabled = false;
  }
}

btnStart.addEventListener('click', async () => {
  if (gameLaunchInFlight) return;
  gameLaunchInFlight = true;
  setSetupError('');
  updateStartAvailability();

  const seedInput = document.getElementById('setupSeed').value.trim();
  const seed = resolveConfiguredSeed(seedInput);
  const setupRng = makeChoiceRng(seed);
  const modeChoices = getNonRandomOptionValues(setupMode).filter((value) => value !== 'multiplayer');

  const playerCount = Number.parseInt(
    resolveRandomValue(setupPlayers.value, getNonRandomOptionValues(setupPlayers), setupRng, '4'),
    10,
  );
  const deckSize = Number.parseInt(
    resolveRandomValue(setupDeck.value, getNonRandomOptionValues(setupDeck), setupRng, '9'),
    10,
  );
  const mode = resolveRandomValue(setupMode.value, modeChoices, setupRng, 'single');

  if (setupMode.value === 'multiplayer') {
    gameLaunchInFlight = false;
    updateStartAvailability();
    return;
  }

  const seat = mode === 'single'
    ? (setupSeat.value === SETUP_RANDOM_VALUE
      ? Math.floor(setupRng() * playerCount)
      : clampSeatIndex(setupSeat.value, playerCount))
    : 0;

  try {
    const aiOpponentSelections = mode === 'single'
      ? buildAiOpponentSelections(playerCount, seat)
      : [];
    if (mode === 'single' && aiOpponentSelections.length !== playerCount - 1) {
      throw new Error('Choose an AI placeholder for every AI seat.');
    }
    setupDialog.style.display = 'none';

    const game = new GameController({
      playerCount,
      deckSize,
      seed,
      mode,
      aiOpponentSelections,
      humanPlayerIds: mode === 'single'
        ? [seat]
        : Array.from({ length: playerCount }, (_, index) => index),
    });
    window.__basileus = game;
    await game.init();
  } catch (error) {
    window.__basileus = null;
    setupDialog.style.display = 'flex';
    setSetupError(`Could not start game: ${error?.message || 'unknown error'}`);
  } finally {
    gameLaunchInFlight = false;
    updateStartAvailability();
  }
});

document.getElementById('setupSeed').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (setupMode.value === 'multiplayer') {
    event.preventDefault();
    return;
  }
  btnStart.click();
});

setupPlayers.addEventListener('change', () => {
  renderSetupChoiceControl(setupPlayers);
  refreshSeatOptions();
  renderAiRoster();
});
setupDeck.addEventListener('change', () => renderSetupChoiceControl(setupDeck));
setupMode.addEventListener('change', () => {
  renderSetupChoiceControl(setupMode);
  refreshModeVisibility();
});
setupSeat.addEventListener('change', () => {
  renderSetupChoiceControl(setupSeat);
  renderAiRoster();
});
setupRoomCode.addEventListener('input', () => {
  setupRoomCode.value = setupRoomCode.value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
  updateStartAvailability();
  setMultiplayerError('');
});
setupPlayerName.addEventListener('input', () => {
  setMultiplayerError('');
});
setupSaveFile?.addEventListener('change', () => {
  setMultiplayerError('');
});
btnCreateRoom?.addEventListener('click', () => {
  void launchMultiplayerFlow('create');
});
btnJoinRoom?.addEventListener('click', () => {
  void launchMultiplayerFlow('join');
});
setupRoomCode.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || btnJoinRoom?.disabled) return;
  event.preventDefault();
  btnJoinRoom.click();
});

refreshSeatOptions();
renderSetupChoiceControls();
refreshModeVisibility();

loadBrowserAiOpponentRoster(undefined, { required: false })
  .then((opponents) => {
    aiOpponentRoster = opponents;
    aiOpponentRosterLoaded = true;
    aiOpponentRosterError = '';
    renderAiRoster();
  })
  .catch((error) => {
    aiOpponentRoster = [];
    aiOpponentRosterLoaded = true;
    aiOpponentRosterError = error?.message || 'Could not list AI opponents.';
    renderAiRoster();
  });
