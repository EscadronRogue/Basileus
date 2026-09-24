// ui/multiplayer/lobby.js - the pre-game room lobby: settings, seats, AI choices, and start.

import { getDynastyProfileForSeat } from '../../data/invasions.js';
import { RANDOM_TUNED_OPPONENT_ID, getTunedAiOpponents } from '../../ai/opponentRoster.js';
import { dynastySeatStyle, escapeHtml } from '../html.js';

export function dynastyNameForSeat(seatOrId) {
  const seatId = typeof seatOrId === 'object' ? seatOrId?.seatId : seatOrId;
  return (typeof seatOrId === 'object' ? seatOrId?.dynasty : null)
    || getDynastyProfileForSeat(Math.max(0, Number(seatId) || 0)).name
    || 'Dynasty';
}

export function renderRoomChoiceButtons(name, options, selectedValue) {
  return `
    <div class="setup-choice-row room-choice-row" data-room-choice="${name}" role="radiogroup">
      ${options.map((option) => {
        const selected = String(option.value) === String(selectedValue);
        return `
          <button type="button"
            class="setup-choice-btn room-config-choice${selected ? ' selected' : ''}"
            role="radio"
            aria-checked="${selected ? 'true' : 'false'}"
            data-room-target="${name}"
            data-room-value="${escapeHtml(option.value)}">
            ${escapeHtml(option.label)}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

// Renders the lobby into the controller's setup dialog and wires its buttons
// back to the controller's WebSocket commands.
export function renderMultiplayerLobby(controller) {
  if (!controller.setupDialog || !controller.roomSnapshot) return;
  const isHost = controller.isHost();
  const seats = controller.roomSnapshot.seats || [];
  const aiOpponents = controller.roomSnapshot.aiOpponents || [];
  const tunedAiOpponents = getTunedAiOpponents(aiOpponents);
  const config = controller.roomSnapshot.config || {};
  const turnCount = Number(config.turnCount || config.deckSize || 9);
  const controlledSeatId = controller.getControlledSeatId();
  const previousCard = controller.setupDialog.querySelector('.setup-card');
  const previousDialogScrollTop = controller.setupDialog.scrollTop;
  const previousCardScrollTop = previousCard?.scrollTop ?? 0;

  controller.setupDialog.style.display = 'flex';
  controller.setupDialog.innerHTML = `
    <div class="setup-card multiplayer-lobby-card">
      <h1>BASILEUS</h1>
      <p class="setup-subtitle">Private live room</p>
      <div class="multiplayer-room-meta">
        <div><strong>Room code:</strong> <span class="room-code">${escapeHtml(controller.roomSnapshot.roomCode)}</span></div>
        <div><strong>Status:</strong> ${escapeHtml(controller.connectionState === 'connected' ? 'Connected' : controller.connectionState)}</div>
        <div><strong>You:</strong> ${escapeHtml(controller.playerName)}</div>
      </div>
      ${controller.lastError ? `<div class="multiplayer-banner error">${escapeHtml(controller.lastError)}</div>` : ''}
      <div class="setup-field">
        <label>Dynasties</label>
        ${isHost ? `
          <select id="roomPlayerCount" class="room-config-source" aria-hidden="true" tabindex="-1">
            ${[3, 4, 5].map((count) => `<option value="${count}" ${count === config.playerCount ? 'selected' : ''}>${count} dynasties</option>`).join('')}
          </select>
          ${renderRoomChoiceButtons('roomPlayerCount', [3, 4, 5].map((count) => ({ value: count, label: `${count} dynasties` })), config.playerCount)}
        ` : `<div class="setup-hint">${escapeHtml(config.playerCount)} dynasties</div>`}
      </div>
      <div class="setup-field">
        <label>Game Length</label>
        ${isHost ? `
          <select id="roomTurnCount" class="room-config-source" aria-hidden="true" tabindex="-1">
            ${[6, 9, 12].map((count) => `<option value="${count}" ${count === turnCount ? 'selected' : ''}>${count} turns</option>`).join('')}
          </select>
          ${renderRoomChoiceButtons('roomTurnCount', [6, 9, 12].map((count) => ({ value: count, label: `${count} turns` })), turnCount)}
        ` : `<div class="setup-hint">${escapeHtml(turnCount)} turns</div>`}
      </div>
      <div class="setup-field">
        <label>Seed</label>
        ${isHost ? `<input type="text" id="roomSeedInput" value="${escapeHtml(config.seed || '')}" placeholder="Leave blank for random">`
          : `<div class="setup-hint">${escapeHtml(config.seed || 'Random on start')}</div>`}
      </div>
      <div class="setup-field">
        <label>Dynasties</label>
        <div class="multiplayer-seat-list">
          ${seats.map((seat) => {
            const dynasty = dynastyNameForSeat(seat);
            const controllerLabel = seat.isViewerSeat
              ? 'You'
              : (seat.playerName || (seat.kind === 'ai' ? 'AI dynasty' : (seat.claimed ? 'Human dynasty' : 'Open human dynasty')));
            return `
              <div class="multiplayer-seat ${seat.isViewerSeat ? 'is-you' : ''}" style="${dynastySeatStyle(seat.seatId, seat.color)}">
                <span class="choice-crest">${escapeHtml(dynasty.slice(0, 1))}</span>
                <div class="multiplayer-seat-copy">
                  <strong>${escapeHtml(dynasty)}</strong>
                  <span class="setup-hint">${escapeHtml(controllerLabel)} - ${escapeHtml(seat.status)}</span>
                </div>
                <div class="multiplayer-seat-actions">
                  ${seat.kind === 'human' && !seat.claimed && controlledSeatId == null ? `
                    <button class="btn-primary btn-claim-seat" type="button" data-seat-id="${seat.seatId}">Claim</button>
                  ` : ''}
                  ${isHost && !seat.claimed ? `
                    <button class="btn-secondary" type="button" data-seat-kind data-seat-id="${seat.seatId}" data-kind="${seat.kind === 'ai' ? 'human' : 'ai'}">
                      ${seat.kind === 'ai' ? 'Set Human' : 'Set AI'}
                    </button>
                  ` : ''}
                  ${isHost && !seat.claimed && seat.kind === 'ai' && aiOpponents.length ? `
                    <span class="setup-ai-choice-row multiplayer-ai-choice-row">
                      ${tunedAiOpponents.length ? `
                        <button type="button"
                          class="setup-ai-opponent-btn multiplayer-ai-opponent"
                          data-seat-id="${seat.seatId}"
                          data-ai-opponent="${RANDOM_TUNED_OPPONENT_ID}">
                          Random trained
                        </button>
                      ` : ''}
                      ${aiOpponents.map((opponent) => {
                        const selected = opponent.id === seat.aiOpponentId;
                        return `
                          <button type="button"
                            class="setup-ai-opponent-btn multiplayer-ai-opponent${selected ? ' selected' : ''}"
                            data-seat-id="${seat.seatId}"
                            data-ai-opponent="${escapeHtml(opponent.id)}">
                            ${escapeHtml(opponent.firstName || opponent.id)}
                          </button>
                        `;
                      }).join('')}
                    </span>
                  ` : ''}
                  ${seat.isViewerSeat ? '<span class="setup-hint">You</span>' : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      <div class="setup-actions">
        ${isHost && controlledSeatId == null ? '<span class="setup-hint">Claim a human dynasty before starting the match.</span>' : ''}
        ${isHost ? `<button class="btn-primary" type="button" id="btnStartRoom" ${controller.roomSnapshot.canStart ? '' : 'disabled'}>Start Match</button>` : '<span class="setup-hint">Waiting for host to start the match.</span>'}
        <button class="btn-secondary" type="button" id="btnLeaveRoom">${controlledSeatId != null ? 'Leave Dynasty' : 'Close Connection'}</button>
      </div>
    </div>
  `;

  const restoreLobbyScroll = () => {
    controller.setupDialog.scrollTop = previousDialogScrollTop;
    const nextCard = controller.setupDialog.querySelector('.setup-card');
    if (nextCard) nextCard.scrollTop = previousCardScrollTop;
  };
  restoreLobbyScroll();
  window.requestAnimationFrame?.(restoreLobbyScroll);

  controller.setupDialog.querySelectorAll('.btn-claim-seat').forEach((button) => {
    button.addEventListener('click', () => {
      controller.send('claim_seat', { seatId: Number(button.dataset.seatId), playerName: controller.playerName });
    });
  });

  controller.setupDialog.querySelectorAll('[data-seat-kind]').forEach((button) => {
    button.addEventListener('click', () => {
      const seatId = Number(button.dataset.seatId);
      const selectedOpponent = controller.setupDialog.querySelector(`.multiplayer-ai-opponent.selected[data-seat-id="${seatId}"]`)?.dataset.aiOpponent;
      controller.send('set_seat_kind', {
        seatId,
        kind: button.dataset.kind,
        aiOpponentId: selectedOpponent || undefined,
      });
    });
  });

  controller.setupDialog.querySelectorAll('.room-config-choice').forEach((button) => {
    button.addEventListener('click', () => {
      const target = controller.setupDialog.querySelector(`#${button.dataset.roomTarget}`);
      if (!target) return;
      target.value = button.dataset.roomValue;
      button.closest('.room-choice-row')?.querySelectorAll('.room-config-choice').forEach((choice) => {
        const selected = choice === button;
        choice.classList.toggle('selected', selected);
        choice.setAttribute('aria-checked', selected ? 'true' : 'false');
      });
    });
  });

  controller.setupDialog.querySelectorAll('.multiplayer-ai-opponent').forEach((button) => {
    button.addEventListener('click', () => {
      controller.send('set_seat_kind', {
        seatId: Number(button.dataset.seatId),
        kind: 'ai',
        aiOpponentId: button.dataset.aiOpponent,
      });
    });
  });

  controller.setupDialog.querySelector('#btnStartRoom')?.addEventListener('click', () => {
    const playerCount = Number(controller.setupDialog.querySelector('#roomPlayerCount')?.value || config.playerCount || 5);
    const turnCount = Number(controller.setupDialog.querySelector('#roomTurnCount')?.value || config.turnCount || config.deckSize || 9);
    const seed = controller.setupDialog.querySelector('#roomSeedInput')?.value?.trim() || '';
    controller.send('set_room_config', {
      config: { playerCount, turnCount, deckSize: turnCount, seed },
    });
    controller.send('start_game');
  });

  controller.setupDialog.querySelector('#btnLeaveRoom')?.addEventListener('click', () => {
    if (controlledSeatId != null) {
      controller.send('leave_room');
      return;
    }
    controller.disconnect();
    window.location.reload();
  });
}
