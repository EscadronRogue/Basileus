import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { GameController } from './gameController.js';
import { MultiplayerController } from './multiplayerController.js';
import { formatProvinceValuesText, renderProvinceBadge } from './labels.js';
import { renderCourtPanel, renderOrdersPanel } from './panels.js';
import { bindUiChrome, createDefaultUiState, getPlayerTabEconomy, renderNotificationsPanel, renderPlayerTabFinance, renderScoringHtml } from './sharedView.js';

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
  assert.match(container.innerHTML, /Church Gifts/);
  assert.match(container.innerHTML, /Revocation/);
  assert.match(container.innerHTML, /Armies/);
  assert.match(container.innerHTML, /Confirm/);
  assert.match(container.innerHTML, /Mercenary Company/);
  assert.match(container.innerHTML, /Professional troops 2 \| 3 levies \| 0 mercenaries/);
  assert.match(container.innerHTML, /1 mercenary \| No levies \| No professional troops/);
  assert.match(container.innerHTML, /Hire 1 mercenary \(2 gold\)/);
});

test('court panel splits church and revocation folds by role', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const nonBasileus = state.players.find((player) => player.majorTitles.includes('PATRIARCH')).id;
  state.phase = 'court';
  state.themes.OPS.bishop = state.basileusId;

  const container = makePanelContainer();
  renderCourtPanel(container, state, nonBasileus, {}, { uiState: null });

  assert.match(container.innerHTML, /Church Gifts/);
  assert.match(container.innerHTML, /Revocation/);
  assert.doesNotMatch(container.innerHTML, /Privileges And Church/);
});

test('appointment panel starts with no default player or province selection', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const playerId = state.basileusId;
  state.phase = 'court';

  const container = makePanelContainer();
  renderCourtPanel(container, state, playerId, {}, { uiState: createDefaultUiState() });

  assert.doesNotMatch(container.innerHTML, /player-choice-btn selected/);
  assert.match(container.innerHTML, /id="basileusApptPlayer" class="appt-player-select" value=""/);
  assert.match(container.innerHTML, /id="basileusApptTheme" class="appt-theme-select" value=""/);
  assert.match(container.innerHTML, /data-action="commit-basileus-appt" disabled/);
});

test('Patriarch revocation panel displays gold costs for selected bishop targets', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const patriarchId = state.players.find((player) => player.majorTitles.includes('PATRIARCH')).id;
  state.phase = 'court';
  state.players[patriarchId].gold = 3;
  state.themes.OPS.bishop = state.basileusId;
  const uiState = {
    drafts: {
      [`court:${state.round}:${patriarchId}`]: {
        revocationValue: 'minor:OPS:bishop',
      },
    },
  };

  const container = makePanelContainer();
  renderCourtPanel(container, state, patriarchId, {}, { uiState });

  assert.match(container.innerHTML, /Revoke \(2 gold\)/);
  assert.doesNotMatch(container.innerHTML, /Revoke \(1 troop\)/);
});

test('province cartouche values render from live mutated province state', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const theme = state.themes.OPS;

  theme.owner = state.players[1].id;
  theme.L = Math.max(0, theme.L - 1);
  assert.equal(formatProvinceValuesText(theme), 'P2 T2 L0 C1');
  assert.match(renderProvinceBadge(state, 'OPS', { showValues: true }), /P2 T2 L0 C1/);

  theme.owner = 'church';
  theme.C = (Number(theme.P) || 0) + (Number(theme.T) || 0);
  theme.P = 0;
  theme.T = 0;

  assert.equal(formatProvinceValuesText(theme), 'P0 T0 L0 C4');
  assert.match(renderProvinceBadge(state, 'OPS', { showValues: true }), /P0 T0 L0 C4/);
});

test('balance of power panel toggle is wired through shared chrome binding', () => {
  const previousDocument = global.document;
  const listeners = {};
  const balanceButton = {
    dataset: { uiPanelToggle: 'balance' },
    addEventListener: (event, handler) => {
      listeners[event] = handler;
    },
  };
  const emptyContainer = {
    querySelectorAll: () => [],
  };
  const balanceContainer = {
    querySelectorAll: (selector) => (selector === '[data-ui-panel-toggle]' ? [balanceButton] : []),
  };
  global.document = {
    getElementById: (id) => (id === 'balancePanel' ? balanceContainer : emptyContainer),
  };

  const uiState = createDefaultUiState();
  let renders = 0;
  try {
    bindUiChrome({ uiState, render: () => { renders++; } });
    listeners.click();
  } finally {
    global.document = previousDocument;
  }

  assert.equal(uiState.panels.balance, false);
  assert.equal(renders, 1);
});

test('notification panel renders inbox counts and urgent toast actions', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const panel = {
    innerHTML: '',
    classList: { toggle: () => {} },
  };
  const uiState = createDefaultUiState();
  const privateData = {
    notifications: [
      {
        id: 'deal:test:1',
        kind: 'deal_incoming',
        title: 'New offer from Player 2',
        body: 'A deal is waiting for your reply.',
        urgent: true,
        action: 'open_deals',
      },
      {
        id: 'obligation:test:1',
        kind: 'deal_obligation',
        title: 'Active deal obligation',
        body: 'You owe support.',
        urgent: false,
        action: 'open_orders',
      },
    ],
  };

  renderNotificationsPanel(panel, state, privateData, uiState, 'test-seat');

  assert.match(panel.innerHTML, /Private Inbox/);
  assert.match(panel.innerHTML, /1 urgent/);
  assert.match(panel.innerHTML, /New offer from Player 2/);
  assert.match(panel.innerHTML, /notification-toast/);
  assert.match(panel.innerHTML, /data-notification-dismiss="deal:test:1"/);
});

test('final scoring view shows threshold share points', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  state.players.forEach((player) => {
    player.gold = player.id < 2 ? 50 : 0;
  });

  const html = renderScoringHtml(state);

  assert.match(html, /Each 25% share/);
  assert.match(html, /Gold Reserves: 50% -> 2/);
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

test('court panel reuses local appointment and land bid drafts on rerender', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 9 });
  const playerId = state.basileusId;
  const otherId = state.players.find((player) => player.id !== playerId).id;
  state.phase = 'court';
  state.players[playerId].gold = 10;
  const freeTheme = Object.values(state.themes).find((theme) => !theme.occupied && theme.id !== 'CPL' && theme.owner === null);
  const uiState = {
    drafts: {
      [`court:${state.round}:${playerId}`]: {
        appointments: {
          basileus: {
            titleType: 'STRATEGOS',
            themeId: freeTheme.id,
            appointeeId: otherId,
          },
        },
        landBids: {
          [freeTheme.id]: 7,
        },
      },
    },
  };

  const container = makePanelContainer();
  renderCourtPanel(container, state, playerId, {}, { uiState });

  assert.match(container.innerHTML, new RegExp(`data-player-choice="${otherId}"[^>]*selected|selected[^>]*data-player-choice="${otherId}"`));
  assert.match(container.innerHTML, new RegExp(`id="basileusApptTheme"[^>]*value="${freeTheme.id}"`));
  assert.match(container.innerHTML, new RegExp(`data-bid-theme="${freeTheme.id}"[^>]*value="7"|value="7"[^>]*data-bid-theme="${freeTheme.id}"`));
  assert.match(container.innerHTML, /Appoint \(0 troops\)/);
  assert.match(container.innerHTML, /Offer 7 gold now/);
});

test('court panel prices repeat appointments for the selected recipient', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 9 });
  const playerId = state.basileusId;
  const otherId = state.players.find((player) => player.id !== playerId).id;
  state.phase = 'court';
  state.currentLevies = { BASILEUS: 1 };
  state.courtActions = {
    ...(state.courtActions || {}),
    appointmentsByRecipient: {
      [playerId]: {
        [playerId]: 1,
      },
    },
    playerConfirmed: new Set(),
  };
  const uiState = {
    drafts: {
      [`court:${state.round}:${playerId}`]: {
        appointments: {
          basileus: {
            appointeeId: playerId,
          },
        },
      },
    },
  };

  const container = makePanelContainer();
  renderCourtPanel(container, state, playerId, {}, { uiState });

  assert.match(container.innerHTML, /Selected cost[\s\S]*1 troop/);
  assert.match(container.innerHTML, /Appoint \(1 troop\)/);

  uiState.drafts[`court:${state.round}:${playerId}`].appointments.basileus.appointeeId = otherId;
  renderCourtPanel(container, state, playerId, {}, { uiState });

  assert.match(container.innerHTML, /Selected cost[\s\S]*0 troops/);
  assert.match(container.innerHTML, /Appoint \(0 troops\)/);
});

test('orders panel reuses local deployment and claimant drafts on rerender', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 10 });
  const playerId = state.basileusId;
  const otherId = state.players.find((player) => player.id !== playerId).id;
  state.phase = 'orders';
  state.currentLevies = { BASILEUS: 2 };
  const uiState = {
    drafts: {
      [`orders:${state.round}:${playerId}`]: {
        deployments: { BASILEUS: 'capital' },
        candidateId: otherId,
      },
    },
  };

  const container = makePanelContainer();
  renderOrdersPanel(container, state, playerId, {}, { uiState });

  assert.match(container.innerHTML, /data-office="BASILEUS"[\s\S]*data-dest="capital">Capital/);
  assert.match(container.innerHTML, new RegExp(`data-candidate="${otherId}"[^>]*selected|selected[^>]*data-candidate="${otherId}"`));
});

test('court panel reuses local deal composer drafts on rerender', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 11 });
  const playerId = state.basileusId;
  const counterpartyId = state.players.find((player) => player.id !== playerId).id;
  state.phase = 'court';
  const uiState = {
    drafts: {
      [`court:${state.round}:${playerId}`]: {
        deals: {
          counterpartyId,
          clauses: [
            {
              kind: 'coup_support',
              direction: 'give',
              startTriggerType: 'immediate',
              triggerPlayerId: '',
              amount: 1,
              durationTurns: 2,
              troopCount: 3,
              candidateId: counterpartyId,
              themeId: '',
              appointmentCount: 1,
            },
          ],
        },
      },
    },
  };

  const container = makePanelContainer();
  renderCourtPanel(container, state, playerId, {}, {
    uiState,
    privateData: {
      dealEligiblePlayerIds: [counterpartyId],
      dealThreads: [],
      dealCounts: {
        pendingInbox: 0,
        pendingOutbox: 0,
        activeObligations: 0,
      },
    },
  });

  assert.match(container.innerHTML, /Back a claimant in the coup/);
  assert.match(container.innerHTML, /value="3"[^>]*data-deal-field="troops"|data-deal-field="troops"[^>]*value="3"/);
  assert.match(container.innerHTML, new RegExp(`value="${counterpartyId}"[^>]*selected|selected[^>]*value="${counterpartyId}"`));
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

test('player tabs include professional troops away on court missions in upkeep', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const player = state.players[state.basileusId];
  player.gold = 4;
  player.professionalArmies.BASILEUS = 1;
  state.suspendedProfessionals = { [player.id]: { BASILEUS: 2 } };

  const economy = getPlayerTabEconomy(player, { income: { [player.id]: 7 } }, state);
  const html = renderPlayerTabFinance(economy);

  assert.match(html, />-3</);
});

test('Patriarch bishop appointment panel displays gold costs', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  state.phase = 'court';
  const patriarchId = state.players.find((player) => player.id !== state.basileusId).id;
  state.players[patriarchId].majorTitles = ['PATRIARCH'];
  state.players[patriarchId].gold = 5;

  const container = makePanelContainer();
  renderCourtPanel(container, state, patriarchId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /Patriarch/);
  assert.match(container.innerHTML, /Appoint \(0 gold\)/);
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
  assert.match(container.innerHTML, /New Offer/);
  assert.match(container.innerHTML, /You pay them/);
  assert.match(container.innerHTML, /Awaiting You/);
  assert.match(container.innerHTML, /Accept/);
  assert.match(container.innerHTML, /Counter/);
  assert.doesNotMatch(container.innerHTML, /Troops per turn/);
  assert.doesNotMatch(container.innerHTML, /Claimant to back/);
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

test('multiplayer heartbeat timing keeps active rooms awake for one idle hour', () => {
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

test('multiplayer heartbeat timing stops ten minutes after a finished game', () => {
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
