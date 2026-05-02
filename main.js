import { listAvailableAiProfiles } from './ai/profileStore.js';
import { GameController } from './ui/gameController.js';
import { launchMultiplayerClient } from './ui/multiplayerController.js';

const SETUP_RANDOM_VALUE = 'random';
const AI_SELECTION_TRAINED_RANDOM = '__trained_random__';
const AI_SELECTION_PROFILE_PREFIX = 'profile:';

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
const setupMultiplayerError = document.getElementById('setupMultiplayerError');
const setupAiRoster = document.getElementById('setupAiRoster');
const setupAiRosterHint = document.getElementById('setupAiRosterHint');

const aiSeatSelections = new Map();
let availableAiProfiles = [];
let multiplayerLaunchInFlight = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function hashSeedInput(seedInput) {
  let seed = 0;
  for (let index = 0; index < seedInput.length; index += 1) {
    seed = ((seed << 5) - seed + seedInput.charCodeAt(index)) | 0;
  }
  return seed;
}

function cloneProfile(profile) {
  return profile ? JSON.parse(JSON.stringify(profile)) : null;
}

function makeChoiceRng(seed = Date.now()) {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pickRandom(rng, values, fallback = null) {
  if (!values.length) return fallback;
  return values[Math.floor(rng() * values.length)] ?? values[0] ?? fallback;
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

function isValidAiSeatSelection(value, profilesById) {
  if (value === AI_SELECTION_TRAINED_RANDOM) return true;
  if (value.startsWith(AI_SELECTION_PROFILE_PREFIX)) {
    return profilesById.has(value.slice(AI_SELECTION_PROFILE_PREFIX.length));
  }
  return false;
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
}

function updateStartAvailability() {
  const needsAiProfiles = setupMode.value === 'single';
  btnStart.disabled = needsAiProfiles && availableAiProfiles.length === 0;
  if (btnJoinRoom) {
    btnJoinRoom.disabled = setupRoomCode.value.trim().length !== 6;
  }
}

function setMultiplayerError(message = '') {
  if (setupMultiplayerError) setupMultiplayerError.textContent = message;
}

function renderAiRoster() {
  const mode = setupMode.value;
  if (mode !== 'single') {
    setupAiRoster.innerHTML = '';
    updateStartAvailability();
    return;
  }

  const playerCount = getConfiguredPlayerCountForUi();
  const playerCountIsRandom = setupPlayers.value === SETUP_RANDOM_VALUE;
  const seatIsRandom = setupSeat.value === SETUP_RANDOM_VALUE;
  const seatAssignmentUnresolved = playerCountIsRandom || seatIsRandom;
  const humanSeat = clampSeatIndex(setupSeat.value, playerCount) + 1;
  const profilesById = new Map(availableAiProfiles.map((profile) => [profile.id, profile]));
  const aiSeats = Array.from({ length: playerCount }, (_, index) => index + 1)
    .filter((seat) => seatAssignmentUnresolved || seat !== humanSeat);

  if (!availableAiProfiles.length) {
    setupAiRoster.innerHTML = '<div class="setup-hint">No trained AI profiles are available yet.</div>';
    setupAiRosterHint.textContent = 'Open the Simulation Lab, save champions to the library or export trained profiles, then return here to use them in live games.';
    updateStartAvailability();
    return;
  }

  setupAiRoster.innerHTML = aiSeats.map((seat) => {
    const savedSelection = aiSeatSelections.get(seat) || AI_SELECTION_TRAINED_RANDOM;
    const selection = isValidAiSeatSelection(savedSelection, profilesById)
      ? savedSelection
      : AI_SELECTION_TRAINED_RANDOM;

    return `
      <label class="setup-ai-seat">
        <span>Seat ${seat}</span>
        <select data-ai-seat="${seat}">
          <option value="${AI_SELECTION_TRAINED_RANDOM}" ${selection === AI_SELECTION_TRAINED_RANDOM ? 'selected' : ''}>Random Trained Profile</option>
          <optgroup label="Trained Profiles">
            ${availableAiProfiles.map((profile) => {
              const value = `${AI_SELECTION_PROFILE_PREFIX}${profile.id}`;
              return `<option value="${value}" ${value === selection ? 'selected' : ''}>${escapeHtml(profile.name)}</option>`;
            }).join('')}
          </optgroup>
        </select>
      </label>
    `;
  }).join('');

  if (seatAssignmentUnresolved) {
    setupAiRosterHint.textContent = `Each seat can already be configured from the trained roster; once player count and your seat resolve, unavailable seats and your final human seat ignore their AI assignments. ${availableAiProfiles.length} trained profile${availableAiProfiles.length === 1 ? '' : 's'} loaded.`;
  } else {
    setupAiRosterHint.textContent = `${availableAiProfiles.length} trained profile${availableAiProfiles.length === 1 ? '' : 's'} available. Each AI seat can use a specific trained opponent or a random trained profile.`;
  }

  updateStartAvailability();
}

function refreshModeVisibility() {
  const mode = setupMode.value;
  singlePlayerFields.hidden = mode !== 'single';
  multiplayerFields.hidden = mode !== 'multiplayer';
  if (defaultSetupActions) defaultSetupActions.hidden = mode === 'multiplayer';
  setMultiplayerError('');
  renderAiRoster();
}

function resolveConfiguredSeed(seedInput) {
  return seedInput ? hashSeedInput(seedInput) : Date.now();
}

function resolveAiSeatAssignments(playerCount, humanSeat, rng) {
  const profilesById = new Map(availableAiProfiles.map((profile) => [profile.id, profile]));
  const rawSelections = {};

  setupAiRoster.querySelectorAll('select[data-ai-seat]').forEach((select) => {
    const seat = Number.parseInt(select.dataset.aiSeat || '-1', 10);
    if (Number.isInteger(seat) && seat > 0) rawSelections[seat] = select.value;
  });

  const aiSeatProfiles = {};
  for (let seat = 1; seat <= playerCount; seat += 1) {
    if (seat === humanSeat) continue;
    const selection = rawSelections[seat] || AI_SELECTION_TRAINED_RANDOM;
    const profile = selection.startsWith(AI_SELECTION_PROFILE_PREFIX)
      ? profilesById.get(selection.slice(AI_SELECTION_PROFILE_PREFIX.length))
      : pickRandom(rng, availableAiProfiles, null);
    if (profile) aiSeatProfiles[seat - 1] = cloneProfile(profile);
  }

  return { aiSeatProfiles };
}

async function refreshAvailableAiProfiles() {
  availableAiProfiles = await listAvailableAiProfiles();
  renderAiRoster();
  return availableAiProfiles;
}

async function launchMultiplayerFlow(intent) {
  if (multiplayerLaunchInFlight) return;
  multiplayerLaunchInFlight = true;
  if (btnCreateRoom) btnCreateRoom.disabled = true;
  if (btnJoinRoom) btnJoinRoom.disabled = true;

  const seedInput = document.getElementById('setupSeed').value.trim();
  const seed = resolveConfiguredSeed(seedInput);
  const setupRng = makeChoiceRng(seed);

  const playerCount = Number.parseInt(
    resolveRandomValue(setupPlayers.value, getNonRandomOptionValues(setupPlayers), setupRng, '4'),
    10
  );
  const deckSize = Number.parseInt(
    resolveRandomValue(setupDeck.value, getNonRandomOptionValues(setupDeck), setupRng, '9'),
    10
  );

  try {
    if (typeof window.__basileus?.disconnect === 'function') {
      window.__basileus.disconnect();
    }
    const multiplayerAiProfiles = intent === 'create'
      ? await refreshAvailableAiProfiles()
      : [];
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
      aiProfiles: multiplayerAiProfiles,
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
  const seedInput = document.getElementById('setupSeed').value.trim();
  const seed = resolveConfiguredSeed(seedInput);
  const setupRng = makeChoiceRng(seed);
  const modeChoices = getNonRandomOptionValues(setupMode).filter((value) => value !== 'multiplayer');

  const playerCount = Number.parseInt(
    resolveRandomValue(setupPlayers.value, getNonRandomOptionValues(setupPlayers), setupRng, '4'),
    10
  );
  const deckSize = Number.parseInt(
    resolveRandomValue(setupDeck.value, getNonRandomOptionValues(setupDeck), setupRng, '9'),
    10
  );
  const mode = resolveRandomValue(setupMode.value, modeChoices, setupRng, 'single');

  if (mode === 'single' && !availableAiProfiles.length) {
    setupAiRosterHint.textContent = 'Single-player requires at least one trained AI profile. Open the Simulation Lab and save or export trained champions first.';
    return;
  }

  if (setupMode.value === 'multiplayer') {
    return;
  }

  const seat = mode === 'single'
    ? (setupSeat.value === SETUP_RANDOM_VALUE
      ? Math.floor(setupRng() * playerCount)
      : clampSeatIndex(setupSeat.value, playerCount))
    : 0;
  const aiAssignments = mode === 'single'
    ? resolveAiSeatAssignments(playerCount, seat + 1, setupRng)
    : { aiSeatProfiles: {} };

  setupDialog.style.display = 'none';

  const game = new GameController({
    playerCount,
    deckSize,
    seed,
    mode,
    humanPlayerIds: mode === 'single'
      ? [seat]
      : Array.from({ length: playerCount }, (_, index) => index),
    aiSeatProfiles: aiAssignments.aiSeatProfiles,
  });
  game.init();

  window.__basileus = game;
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
  refreshSeatOptions();
  renderAiRoster();
});
setupMode.addEventListener('change', refreshModeVisibility);
setupSeat.addEventListener('change', renderAiRoster);
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
setupAiRoster.addEventListener('change', (event) => {
  const select = event.target.closest('select[data-ai-seat]');
  if (!select) return;
  aiSeatSelections.set(Number.parseInt(select.dataset.aiSeat, 10), select.value);
});
window.addEventListener('focus', () => {
  void refreshAvailableAiProfiles();
});
window.addEventListener('pageshow', () => {
  void refreshAvailableAiProfiles();
});

refreshSeatOptions();
refreshModeVisibility();
await refreshAvailableAiProfiles();
