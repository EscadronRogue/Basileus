import { makeChoiceRng, pickRandom, resolveConfiguredSeed } from './engine/setup.js';
import { GameController } from './ui/gameController.js';
import { launchMultiplayerClient } from './ui/multiplayerController.js';
import { loadBrowserAiOpponentRoster } from './ai/brain.js';
import {
  RANDOM_TUNED_OPPONENT_ID,
  describeAiOpponentChoice,
  getOfferedAiOpponents,
  getSelectableAiOpponents,
  getTunedAiOpponents,
} from './ai/opponentRoster.js';
import { getDynastyProfileForSeat } from './data/invasions.js';
import { dynastySeatStyle, escapeHtml } from './ui/html.js';
import {
  OUTDATED_SAVE_MESSAGE,
  clearLocalSave,
  describeLocalSave,
  isLocalSaveOutdated,
  readLastGameRecord,
  readLocalSave,
} from './ui/localSave.js';
import { downloadJsonFile } from './ui/recordControls.js';
import { gameRecordFilename, isGameRecord } from './game/record.js';
import { getMapDefinition } from './data/maps/index.js';
import { renderGlossaryHtml, renderRulesHtml } from './ui/rules.js';
import { installGlossary } from './ui/glossaryTooltips.js';
import { TutorialGuide } from './ui/tutorial/tutorial.js';
import {
  TUTORIAL_HUMAN_ID,
  TUTORIAL_PLAYER_COUNT,
  TUTORIAL_RIVALS,
  TUTORIAL_SEED,
  TUTORIAL_TURN_COUNT,
} from './ui/tutorial/steps.js';

const SETUP_RANDOM_VALUE = 'random';
const SETUP_CHOICE_NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

function installViewportHeightSync() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const root = document.documentElement;
  let frame = 0;

  const sync = () => {
    frame = 0;
    const height = Math.round(
      window.visualViewport?.height
      || window.innerHeight
      || root.clientHeight
      || 0,
    );
    if (height > 0) root.style.setProperty('--game-vh', `${height}px`);
  };

  const schedule = () => {
    if (frame) return;
    const requestFrame = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));
    frame = requestFrame(sync);
  };

  schedule();
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  window.addEventListener('pageshow', schedule, { passive: true });
  window.visualViewport?.addEventListener?.('resize', schedule, { passive: true });
  window.visualViewport?.addEventListener?.('scroll', schedule, { passive: true });
}

installViewportHeightSync();

const setupDialog = document.getElementById('setupDialog');
const btnStart = document.getElementById('btnStart');
const btnCreateRoom = document.getElementById('btnCreateRoom');
const btnJoinRoom = document.getElementById('btnJoinRoom');
const defaultSetupActions = document.getElementById('defaultSetupActions');
const multiplayerActions = document.getElementById('multiplayerActions');
const setupPlayers = document.getElementById('setupPlayers');
const setupTurns = document.getElementById('setupTurns');
const setupMap = document.getElementById('setupMap');
const setupMode = document.getElementById('setupMode');
const setupSeat = document.getElementById('setupSeat');
const singlePlayerFields = document.getElementById('singlePlayerFields');
const singlePlayerAdvancedFields = document.getElementById('singlePlayerAdvancedFields');
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

function getTrainedAiOpponents() {
  return getTunedAiOpponents(aiOpponentRoster);
}

function randomItemFromPool(pool, rng = Math.random) {
  if (!pool.length) return null;
  const index = Math.floor(rng() * pool.length);
  return pool.splice(index, 1)[0] || pool[0] || null;
}

function makeRandomOpponentBag(opponents) {
  return {
    source: opponents.slice(),
    bag: opponents.slice(),
    take(rng) {
      if (!this.source.length) return null;
      if (!this.bag.length) this.bag = this.source.slice();
      return randomItemFromPool(this.bag, rng);
    },
  };
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
  row.innerHTML = [...select.options].map((option) => {
    const seatStyle = select.id === 'setupSeat' && option.value !== SETUP_RANDOM_VALUE
      ? ` style="${dynastySeatStyle(Number(option.value) - 1)}"`
      : '';
    return `
    <button type="button"
      class="setup-choice-btn${option.selected ? ' selected' : ''}"
      role="radio"
      aria-checked="${option.selected ? 'true' : 'false'}"
      tabindex="${option.selected ? '0' : '-1'}"
      data-setup-choice-value="${escapeHtml(option.value)}"${seatStyle}>
      ${escapeHtml(option.textContent.trim())}
    </button>
  `;
  }).join('');

  const focusSetupChoice = (value) => {
    const requestFrame = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));
    requestFrame(() => {
      const nextButton = [...row.querySelectorAll('[data-setup-choice-value]')]
        .find((candidate) => candidate.dataset.setupChoiceValue === value);
      nextButton?.focus();
    });
  };

  const commitChoice = (value, options = {}) => {
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    renderSetupChoiceControl(select);
    if (options.focus) focusSetupChoice(value);
  };

  row.querySelectorAll('[data-setup-choice-value]').forEach((button) => {
    button.addEventListener('click', () => {
      commitChoice(button.dataset.setupChoiceValue, { focus: true });
    });

    button.addEventListener('keydown', (event) => {
      if (!SETUP_CHOICE_NAV_KEYS.has(event.key)) return;
      const buttons = [...row.querySelectorAll('[data-setup-choice-value]')];
      const currentIndex = Math.max(0, buttons.indexOf(button));
      const lastIndex = Math.max(0, buttons.length - 1);
      const nextIndex = {
        ArrowLeft: Math.max(0, currentIndex - 1),
        ArrowUp: Math.max(0, currentIndex - 1),
        ArrowRight: Math.min(lastIndex, currentIndex + 1),
        ArrowDown: Math.min(lastIndex, currentIndex + 1),
        Home: 0,
        End: lastIndex,
      }[event.key];
      const nextButton = buttons[nextIndex];
      if (!nextButton) return;
      event.preventDefault();
      commitChoice(nextButton.dataset.setupChoiceValue, { focus: true });
    });
  });
}

function renderSetupChoiceControls() {
  [setupMode, setupPlayers, setupTurns, setupMap, setupSeat].filter(Boolean).forEach(renderSetupChoiceControl);
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
  const currentValue = setupSeat.value || '1';
  const clampedSeat = String(Math.min(Math.max(Number.parseInt(currentValue, 10) || 1, 1), playerCount));

  setupSeat.innerHTML = [
    ...Array.from({ length: playerCount }, (_, index) => {
      const seat = index + 1;
      const dynasty = getDynastyProfileForSeat(index).name;
      return `<option value="${seat}" ${String(seat) === clampedSeat ? 'selected' : ''}>${dynasty}</option>`;
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
    setupAiRoster.innerHTML = '<div class="setup-ai-seat setup-ai-seat-empty"><strong>Loading AI opponents...</strong><span>Preparing named dynasties</span></div>';
    setupAiRosterHint.textContent = 'Choose a temperament for each AI dynasty, or leave it random.';
    updateStartAvailability();
    return;
  }

  if (!aiOpponentRoster.length) {
    setupAiRoster.innerHTML = `
      <div class="setup-ai-seat setup-ai-seat-empty">
        <strong>No AI opponents found</strong>
        <span>${escapeHtml(aiOpponentRosterError || 'No AI opponents are available.')}</span>
      </div>
    `;
    setupAiRosterHint.textContent = 'Single-player AI is unavailable until named AI dynasties are available.';
    updateStartAvailability();
    return;
  }

  if (seatAssignmentUnresolved) {
    setupAiRoster.innerHTML = `
      <div class="setup-ai-seat setup-ai-seat-empty">
        <strong>AI dynasties assigned at start</strong>
        <span>Random setup will resolve your dynasty first, then fill the remaining dynasties with available AI strategies.</span>
      </div>
    `;
    setupAiRosterHint.textContent = 'Choose a fixed player count and dynasty to customize individual AI opponents.';
    updateStartAvailability();
    return;
  }

  setupAiRoster.innerHTML = aiSeats.map((seat, index) => {
    const trainedOpponents = getTrainedAiOpponents();
    const existing = selectedAiOpponentBySeat.get(seat);
    const selectedId = existing === RANDOM_TUNED_OPPONENT_ID || aiOpponentRoster.some((opponent) => opponent.id === existing)
      ? existing
      : trainedOpponents.length
        ? RANDOM_TUNED_OPPONENT_ID
        : aiOpponentRoster[index % aiOpponentRoster.length]?.id;
    selectedAiOpponentBySeat.set(seat, selectedId);
    const selectedOpponent = aiOpponentRoster.find((opponent) => opponent.id === selectedId);
    const dynasty = getDynastyProfileForSeat(seat - 1).name;
    const displayName = selectedId === RANDOM_TUNED_OPPONENT_ID
      ? 'Random temperament'
      : describeAiOpponentChoice(selectedOpponent) || 'Choose opponent';
    const randomTrainedButton = trainedOpponents.length ? `
      <button type="button"
        class="setup-ai-opponent-btn${selectedId === RANDOM_TUNED_OPPONENT_ID ? ' selected' : ''}"
        data-seat="${seat}"
        data-ai-opponent="${RANDOM_TUNED_OPPONENT_ID}">
        Random
      </button>
    ` : '';
    return `
      <div class="setup-ai-seat" style="${dynastySeatStyle(seat - 1)}" data-seat="${seat}">
        <span class="choice-crest">${escapeHtml(dynasty.slice(0, 1))}</span>
        <span class="setup-ai-copy">
          <strong>${escapeHtml(dynasty)}</strong>
          <span>${escapeHtml(displayName)}</span>
        </span>
        <span class="setup-ai-choice-row">
          ${randomTrainedButton}
          ${getSelectableAiOpponents(aiOpponentRoster).map((opponent) => {
            const label = describeAiOpponentChoice(opponent);
            const selected = opponent.id === selectedId;
            return `
              <button type="button"
                class="setup-ai-opponent-btn${selected ? ' selected' : ''}"
                data-seat="${seat}"
                data-ai-opponent="${escapeHtml(opponent.id)}"
                ${opponent.description ? `title="${escapeHtml(opponent.description)}"` : ''}>
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

  setupAiRosterHint.textContent = 'Choose a temperament for each AI dynasty, or leave it random. Hover a temperament to read how it plays.';
  updateStartAvailability();
}

function refreshModeVisibility() {
  const mode = setupMode.value;
  singlePlayerFields.hidden = mode !== 'single';
  if (singlePlayerAdvancedFields) singlePlayerAdvancedFields.hidden = mode !== 'single';
  multiplayerFields.hidden = mode !== 'multiplayer';
  if (defaultSetupActions) defaultSetupActions.hidden = mode === 'multiplayer';
  if (multiplayerActions) multiplayerActions.hidden = mode !== 'multiplayer';
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

function buildAiOpponentSelections(playerCount, humanSeat, rng = Math.random) {
  const selections = [];
  if (!aiOpponentRoster.length) return selections;
  // Random seats draw only from the AIs players are offered.
  const randomTrainedBag = makeRandomOpponentBag(getOfferedAiOpponents(aiOpponentRoster));
  for (let playerId = 0; playerId < playerCount; playerId += 1) {
    if (playerId === humanSeat) continue;
    const seat = playerId + 1;
    const selectedId = selectedAiOpponentBySeat.get(seat);
    const selectedOpponent = selectedId && selectedId !== RANDOM_TUNED_OPPONENT_ID
      ? aiOpponentRoster.find((entry) => entry.id === selectedId)
      : null;
    const opponent = selectedOpponent
      || randomTrainedBag.take(rng)
      || aiOpponentRoster[selections.length % aiOpponentRoster.length]
      || aiOpponentRoster[0];
    if (!opponent) continue;
    selections.push({
      playerId,
      id: opponent.id,
      firstName: opponent.firstName,
      personality: opponent.personality || null,
      label: opponent.label,
      policy: opponent.policy || null,
      strategyWeights: opponent.strategyWeights || opponent.policy?.strategyWeights || null,
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
    resolveRandomValue(setupPlayers.value, getNonRandomOptionValues(setupPlayers), setupRng, '5'),
    10,
  );
  const turnCount = Number.parseInt(
    resolveRandomValue(setupTurns.value, getNonRandomOptionValues(setupTurns), setupRng, '9'),
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
        turnCount,
        deckSize: turnCount,
        mapId: setupMap?.value || 'classic',
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
    resolveRandomValue(setupPlayers.value, getNonRandomOptionValues(setupPlayers), setupRng, '5'),
    10,
  );
  const turnCount = Number.parseInt(
    resolveRandomValue(setupTurns.value, getNonRandomOptionValues(setupTurns), setupRng, '9'),
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
      ? buildAiOpponentSelections(playerCount, seat, setupRng)
      : [];
    if (mode === 'single' && aiOpponentSelections.length !== playerCount - 1) {
      throw new Error('Choose an AI opponent for every AI dynasty.');
    }
    setupDialog.style.display = 'none';

    const game = new GameController({
      playerCount,
      turnCount,
      deckSize: turnCount,
      mapId: setupMap?.value || 'classic',
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
setupTurns.addEventListener('change', () => renderSetupChoiceControl(setupTurns));
setupMap?.addEventListener('change', () => renderSetupChoiceControl(setupMap));
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

const resumeGameCard = document.getElementById('resumeGameCard');
const resumeGameSummary = document.getElementById('resumeGameSummary');
const resumeGameError = document.getElementById('resumeGameError');
const btnResumeGame = document.getElementById('btnResumeGame');
const btnDiscardSave = document.getElementById('btnDiscardSave');

function formatSavedAgo(savedAt) {
  const elapsedMs = Date.now() - Date.parse(savedAt || '');
  if (!Number.isFinite(elapsedMs)) return '';
  const minutes = Math.round(elapsedMs / 60_000);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return format.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return format.format(-hours, 'hour');
  return format.format(-Math.round(hours / 24), 'day');
}

function renderResumeCard() {
  const save = readLocalSave();
  resumeGameCard.hidden = !save;
  if (!save) return;
  const info = describeLocalSave(save);
  const parts = [
    info.dynasty ? `${info.mode} as ${info.dynasty}` : info.mode,
    info.turnCount ? `round ${info.round} of ${info.turnCount}` : `round ${info.round}`,
    `${info.playerCount} dynasties`,
    `${info.mapName} map`,
    formatSavedAgo(info.savedAt) ? `saved ${formatSavedAgo(info.savedAt)}` : '',
  ].filter(Boolean);
  resumeGameSummary.textContent = parts.join(' · ');
  const outdated = isLocalSaveOutdated(save);
  btnResumeGame.hidden = outdated;
  resumeGameError.textContent = outdated ? OUTDATED_SAVE_MESSAGE : '';
}

const lastRecordCard = document.getElementById('lastRecordCard');
const lastRecordSummary = document.getElementById('lastRecordSummary');

// The record of the last finished game, until the next one ends.
function renderLastRecordCard() {
  const record = readLastGameRecord();
  lastRecordCard.hidden = !isGameRecord(record);
  if (lastRecordCard.hidden) return;
  const ended = record.exportedAt ? new Date(record.exportedAt) : null;
  lastRecordSummary.textContent = [
    `${record.config?.playerCount || '?'} dynasties`,
    `${getMapDefinition(record.config?.mapId).name} map`,
    record.fallen ? 'the empire fell' : `${record.round || '?'} rounds`,
    ended && !Number.isNaN(ended.getTime()) ? `ended ${ended.toLocaleString()}` : '',
  ].filter(Boolean).join(' · ');
}

document.getElementById('btnDownloadLastRecord').addEventListener('click', () => {
  const record = readLastGameRecord();
  if (isGameRecord(record)) downloadJsonFile(record, gameRecordFilename(record, new Date(record.exportedAt || Date.now())));
});

btnResumeGame.addEventListener('click', async () => {
  if (gameLaunchInFlight) return;
  const save = readLocalSave();
  if (!save) {
    renderResumeCard();
    return;
  }
  gameLaunchInFlight = true;
  updateStartAvailability();
  setupDialog.style.display = 'none';
  try {
    const game = new GameController(save.config);
    window.__basileus = game;
    await game.resume(save);
  } catch (error) {
    window.__basileus = null;
    setupDialog.style.display = 'flex';
    resumeGameError.textContent = `Could not continue that game: ${error?.message || 'unknown error'}`;
  } finally {
    gameLaunchInFlight = false;
    updateStartAvailability();
  }
});

// The tutorial's rivals: the trained AI of each chosen temperament, or the
// built-in policy of that temperament before any roster is trained.
function buildTutorialRivals() {
  const trained = getTrainedAiOpponents();
  const fallbackNames = ['Leon', 'Nikephoros'];
  return TUTORIAL_RIVALS.map((rival, index) => {
    const opponent = trained.find((entry) => entry.personality === rival.personality);
    if (opponent) {
      return {
        playerId: rival.playerId,
        id: opponent.id,
        firstName: opponent.firstName,
        personality: rival.personality,
        label: opponent.label,
        policy: opponent.policy || null,
        strategyWeights: opponent.strategyWeights || opponent.policy?.strategyWeights || null,
      };
    }
    return {
      playerId: rival.playerId,
      id: `${rival.fallbackPolicy}-default`,
      firstName: fallbackNames[index] || 'Basileios',
      personality: rival.personality,
      label: rival.personality,
      policy: { policyId: rival.fallbackPolicy },
      strategyWeights: null,
    };
  });
}

// The tutorial is a separate, fixed game. It never autosaves, so it cannot
// replace a game the player left unfinished.
document.getElementById('btnTutorial').addEventListener('click', async () => {
  if (gameLaunchInFlight) return;
  gameLaunchInFlight = true;
  setSetupError('');
  updateStartAvailability();
  const backToSetup = () => window.location.reload();
  const guide = new TutorialGuide({ onLeave: backToSetup, onFinish: backToSetup });
  try {
    setupDialog.style.display = 'none';
    const game = new GameController({
      playerCount: TUTORIAL_PLAYER_COUNT,
      turnCount: TUTORIAL_TURN_COUNT,
      deckSize: TUTORIAL_TURN_COUNT,
      seed: TUTORIAL_SEED,
      mode: 'single',
      aiOpponentSelections: buildTutorialRivals(),
      humanPlayerIds: [TUTORIAL_HUMAN_ID],
      autosave: false,
      record: false,
      onRender: () => guide.update(),
    });
    window.__basileus = game;
    window.__basileusTutorial = guide;
    await game.init();
    guide.mount(game);
  } catch (error) {
    guide.destroy();
    window.__basileus = null;
    window.__basileusTutorial = null;
    setupDialog.style.display = 'flex';
    setSetupError(`Could not start the tutorial: ${error?.message || 'unknown error'}`);
  } finally {
    gameLaunchInFlight = false;
    updateStartAvailability();
  }
});

btnDiscardSave.addEventListener('click', () => {
  clearLocalSave();
  renderResumeCard();
});

// Leaving the page flushes the pending autosave so the latest move is kept.
window.addEventListener('pagehide', () => window.__basileus?.saveNow?.());

document.getElementById('rulesCardBody').innerHTML = renderRulesHtml() + renderGlossaryHtml();
installGlossary(document.body);
refreshSeatOptions();
renderSetupChoiceControls();
refreshModeVisibility();
renderResumeCard();
renderLastRecordCard();

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
