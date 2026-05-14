import { makeChoiceRng, pickRandom, resolveConfiguredSeed } from './engine/setup.js';
import { GameController } from './ui/gameController.js';
import { launchMultiplayerClient } from './ui/multiplayerController.js';

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
const setupAiModelFile = document.getElementById('setupAiModelFile');
const setupStartError = document.getElementById('setupStartError');
const setupAiRoster = document.getElementById('setupAiRoster');
const setupAiRosterHint = document.getElementById('setupAiRosterHint');

let multiplayerLaunchInFlight = false;
let gameLaunchInFlight = false;

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
}

function updateStartAvailability() {
  btnStart.disabled = gameLaunchInFlight;
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

  setupAiRoster.innerHTML = aiSeats.map((seat) => `
    <div class="setup-ai-seat">
      <span>Seat ${seat}</span>
      <span>Neural AI seat</span>
    </div>
  `).join('');

  setupAiRosterHint.textContent = 'AI seats use ai/models/latest.json when the server can serve it. If that path 404s, select the trained model JSON below.';
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

async function readSelectedAiModelPayload() {
  const file = setupAiModelFile?.files?.[0];
  if (!file) return null;
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new Error('AI model file must be valid JSON.');
  }
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
    const aiModelPayload = mode === 'single' ? await readSelectedAiModelPayload() : null;
    setupDialog.style.display = 'none';

    const game = new GameController({
      playerCount,
      deckSize,
      seed,
      mode,
      aiModelPayload,
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
setupSaveFile?.addEventListener('change', () => {
  setMultiplayerError('');
});
setupAiModelFile?.addEventListener('change', () => {
  setSetupError('');
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
refreshModeVisibility();
