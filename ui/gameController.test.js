import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { GameController } from './gameController.js';
import { MultiplayerController } from './multiplayerController.js';
import { renderCourtPanel, renderOrdersPanel } from './panels.js';
import { getPlayerTabEconomy, renderPlayerTabFinance } from './sharedView.js';

function makePanelContainer() {
  return {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

test('resolution continue does not submit empty title reassignment when throne is unchanged', () => {
  const controller = new GameController({ playerCount: 4, deckSize: 1, seed: 7 });
  controller.state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  controller.state.phase = 'resolution';
  controller.state.nextBasileusId = controller.state.basileusId;

  const panelWithoutTitleControls = {
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  const result = controller.tryResolveTitleReassignment(panelWithoutTitleControls);
  assert.equal(result.ok, true);
});

test('court panel groups army information and mercenary hiring under Armies', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const playerId = state.basileusId;
  state.phase = 'court';
  state.players[playerId].gold = 10;
  state.currentLevies = { BASILEUS: 3 };
  state.currentMercenaryTroops = { [playerId]: 1 };

  const container = makePanelContainer();
  renderCourtPanel(container, state, playerId, {}, { uiState: null });

  assert.doesNotMatch(container.innerHTML, /Phase Guide/);
  assert.match(container.innerHTML, /Appointments/);
  assert.match(container.innerHTML, /Estates/);
  assert.match(container.innerHTML, /Privileges And Church/);
  assert.match(container.innerHTML, /Armies/);
  assert.match(container.innerHTML, /Confirm/);
  assert.match(container.innerHTML, /Mercenary Company/);
  assert.match(container.innerHTML, /Professional troops 2 \| 3 levies \| 0 mercenaries/);
  assert.match(container.innerHTML, /1 mercenary \| No levies \| No professional troops/);
  assert.match(container.innerHTML, /Hire 1 mercenary \(2 gold\)/);
});

test('orders panel contains only deployments, claimant choice, and order locking', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 9 });
  const playerId = state.basileusId;
  state.phase = 'orders';
  state.currentLevies = { BASILEUS: 2 };
  state.currentMercenaryTroops = { [playerId]: 1 };

  const container = makePanelContainer();
  renderOrdersPanel(container, state, playerId, {}, { uiState: null });

  assert.doesNotMatch(container.innerHTML, /Phase Guide/);
  assert.match(container.innerHTML, /Deploy Troops/);
  assert.match(container.innerHTML, /Choose Your Claimant/);
  assert.match(container.innerHTML, /Confirm/);
  assert.match(container.innerHTML, /Lock Secret Orders/);
  assert.match(container.innerHTML, /Professional troops 2 \| 2 levies \| 0 mercenaries/);
  assert.match(container.innerHTML, /Mercenary Company/);
  assert.match(container.innerHTML, /1 mercenary \| No levies \| No professional troops/);
  assert.doesNotMatch(container.innerHTML, /Hire Mercenaries/);
  assert.doesNotMatch(container.innerHTML, /mercTotalCost/);
});

test('player tabs use compact reserve, income, and upkeep formatting', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const player = state.players[state.basileusId];
  player.gold = 4;
  player.professionalArmies.BASILEUS = 3;

  const economy = getPlayerTabEconomy(player, { income: { [player.id]: 7 } });
  const html = renderPlayerTabFinance(economy);

  assert.match(html, />4</);
  assert.match(html, />\|</);
  assert.match(html, />\+7</);
  assert.match(html, />-3</);
  assert.doesNotMatch(html, /gold/i);
});

test('court panel renders the private deals fold when seat-local deal data exists', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 12 });
  const playerId = state.basileusId;
  const counterpartyId = state.players.find((player) => player.id !== playerId).id;
  state.phase = 'court';

  const container = makePanelContainer();
  renderCourtPanel(container, state, playerId, {}, {
    uiState: null,
    privateData: {
      dealEligiblePlayerIds: [counterpartyId],
      dealThreads: [
        {
          id: 'deal-thread-1',
          playerIds: [playerId, counterpartyId],
          status: 'open',
          revision: 2,
          awaitingPlayerId: playerId,
          currentOffer: {
            clauses: [
              {
                kind: 'gold',
                giverId: counterpartyId,
                receiverId: playerId,
                startTrigger: { type: 'immediate' },
                durationTurns: 1,
                payload: { totalAmount: 3, installments: [3] },
              },
            ],
          },
          history: [],
        },
      ],
      dealCounts: {
        pendingInbox: 1,
        pendingOutbox: 0,
        activeObligations: 0,
      },
      orderLocks: null,
    },
  });

  assert.match(container.innerHTML, /Deals/);
  assert.match(container.innerHTML, /Create Deal/);
  assert.match(container.innerHTML, /What this part is about/);
  assert.match(container.innerHTML, /You pay them/);
  assert.match(container.innerHTML, /Awaiting You/);
  assert.match(container.innerHTML, /Accept/);
  assert.match(container.innerHTML, /Change Offer/);
  assert.doesNotMatch(container.innerHTML, /Troops each turn/);
  assert.doesNotMatch(container.innerHTML, /Which claimant to back/);
});

test('orders panel renders deal lock summaries from private order lock data', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 13 });
  const playerId = state.basileusId;
  const counterpartyId = state.players.find((player) => player.id !== playerId).id;
  state.phase = 'orders';
  state.currentLevies = { BASILEUS: 2 };

  const container = makePanelContainer();
  renderOrdersPanel(container, state, playerId, {}, {
    uiState: null,
    privateData: {
      orderLocks: {
        ok: true,
        candidateId: counterpartyId,
        capitalRequired: 1,
        frontierRequired: 0,
        committedOfficeKeys: {
          BASILEUS: 'capital',
        },
        officeSelections: [
          {
            officeKey: 'BASILEUS',
            officeName: 'Basileus',
            troops: 4,
            destination: 'capital',
          },
        ],
      },
    },
  });

  assert.match(container.innerHTML, /Deal Locks/);
  assert.match(container.innerHTML, /Claimant locked:/);
  assert.match(container.innerHTML, /Capital \(deal locked\)/);
  assert.match(container.innerHTML, /Your claimant is locked to/);
});

test('multiplayer heartbeat policy keeps active rooms awake for one idle hour', () => {
  const createdAt = '2026-05-09T10:00:00.000Z';
  const updatedAt = '2026-05-09T10:12:00.000Z';
  const updatedAtMs = Date.parse(updatedAt);
  const controller = new MultiplayerController({
    roomCode: 'ABC123',
    sessionToken: 'session',
    roomSnapshot: {
      status: 'in_progress',
      createdAt,
      updatedAt,
    },
  });

  assert.equal(controller.shouldKeepHeartbeatAlive(updatedAtMs + 60 * 60 * 1000), true);
  assert.equal(controller.shouldKeepHeartbeatAlive(updatedAtMs + 60 * 60 * 1000 + 1), false);

  controller.noteLocalPlayerActivity(updatedAtMs + 30 * 60 * 1000);
  assert.equal(controller.shouldKeepHeartbeatAlive(updatedAtMs + 90 * 60 * 1000), true);
  assert.equal(controller.shouldKeepHeartbeatAlive(updatedAtMs + 90 * 60 * 1000 + 1), false);
});

test('multiplayer heartbeat policy stops ten minutes after a finished game', () => {
  const finishedAt = '2026-05-09T11:00:00.000Z';
  const finishedAtMs = Date.parse(finishedAt);
  const controller = new MultiplayerController({
    roomCode: 'ABC123',
    sessionToken: 'session',
    roomSnapshot: {
      status: 'finished',
      createdAt: '2026-05-09T10:00:00.000Z',
      updatedAt: finishedAt,
      finishedAt,
    },
  });

  assert.equal(controller.shouldKeepHeartbeatAlive(finishedAtMs + 10 * 60 * 1000), true);
  assert.equal(controller.shouldKeepHeartbeatAlive(finishedAtMs + 10 * 60 * 1000 + 1), false);

  controller.noteLocalPlayerActivity(finishedAtMs + 20 * 60 * 1000);
  assert.equal(controller.shouldKeepHeartbeatAlive(finishedAtMs + 10 * 60 * 1000 + 1), false);
});

test('multiplayer HTTP keepalive pings health without extending room activity', async () => {
  const updatedAt = '2026-05-09T10:12:00.000Z';
  const updatedAtMs = Date.parse(updatedAt);
  const fetchCalls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true };
  };

  try {
    const controller = new MultiplayerController({
      roomCode: 'ABC123',
      sessionToken: 'session',
      roomSnapshot: {
        status: 'in_progress',
        createdAt: '2026-05-09T10:00:00.000Z',
        updatedAt,
      },
    });

    await controller.sendHttpKeepalive(updatedAtMs + 15 * 60 * 1000);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /^\/healthz\?keepalive=/);
    assert.equal(fetchCalls[0].options.method, 'GET');
    assert.equal(fetchCalls[0].options.credentials, 'omit');
    assert.equal(controller.localPlayerActivityAtMs, 0);

    await controller.sendHttpKeepalive(updatedAtMs + 60 * 60 * 1000 + 1);
    assert.equal(fetchCalls.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
