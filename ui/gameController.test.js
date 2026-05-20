import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { renderProvinceBadge, formatProvinceValuesText } from './labels.js';
import {
  renderCourtPanel,
  renderEstatesPanel,
  renderOrdersPanel,
  renderTitleRedistributionPanel,
} from './panels.js';
import {
  createDefaultUiState,
  getPlayerTabEconomy,
  renderNotificationsPanel,
  renderPlayerTabFinance,
  renderScoringHtml,
} from './sharedView.js';

function makeState() {
  const state = createGameState({ playerCount: 4, deckSize: 2, seed: 19, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  for (const player of state.players) player.majorTitles = [];
  state.players[1].majorTitles = ['DOM_EAST', 'PATRIARCH'];
  state.players[2].majorTitles = ['DOM_WEST'];
  state.players[3].majorTitles = ['ADMIRAL'];
  return state;
}

function makePanelContainer() {
  return {
    innerHTML: '',
    classList: { toggle: () => {} },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

test('province badges render the updated P/T/C economy and hide capital values', () => {
  const state = makeState();

  assert.equal(formatProvinceValuesText(state.themes.OPS), 'P1 T1 C0');
  assert.equal(formatProvinceValuesText(state.themes.CPL), '');
  assert.match(renderProvinceBadge(state, 'OPS', { showValues: true }), /P1 T1 C0/);
  assert.doesNotMatch(renderProvinceBadge(state, 'CPL', { showValues: true }), /province-token-values/);
});

test('title redistribution panel is its own phase panel', () => {
  const state = makeState();
  state.phase = 'title_redistribution';
  const container = makePanelContainer();

  renderTitleRedistributionPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /Redistribute Major Titles/);
  assert.match(container.innerHTML, /data-title-assignment="DOM_EAST"/);
  assert.match(container.innerHTML, /Confirm Titles/);
});

test('court panel exposes only role-legal appointments and no legacy army buying', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };

  const basileusPanel = makePanelContainer();
  renderCourtPanel(basileusPanel, state, state.basileusId, {}, { uiState: createDefaultUiState() });
  assert.match(basileusPanel.innerHTML, /Empress/);
  assert.doesNotMatch(basileusPanel.innerHTML, /Appoint Strategos/);
  assert.doesNotMatch(basileusPanel.innerHTML, /Appoint Bishop/);

  const patriarchPanel = makePanelContainer();
  renderCourtPanel(patriarchPanel, state, 1, {}, { uiState: createDefaultUiState() });
  assert.match(patriarchPanel.innerHTML, /Appoint Strategos/);
  assert.match(patriarchPanel.innerHTML, /Appoint Bishop/);
  assert.doesNotMatch(patriarchPanel.innerHTML, new RegExp('Mercenary Company|Prof' + 'essional|lev' + 'ies', 'i'));
});

test('estates panel lists free land bids before deployment', () => {
  const state = makeState();
  state.phase = 'estates';
  const container = makePanelContainer();

  renderEstatesPanel(container, state, 2, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /Estates/);
  assert.match(container.innerHTML, /data-estate-bid="OPS"/);
  assert.match(container.innerHTML, /Open Deployment/);
});

test('deployment panel uses funded armies and mercenary slider schema', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.currentTroops = {
    BASILEUS: { normal: 2, capitalLocked: 1 },
  };
  const container = makePanelContainer();

  renderOrdersPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /Deployment/);
  assert.match(container.innerHTML, /Funding/);
  assert.match(container.innerHTML, /capital locked/);
  assert.match(container.innerHTML, /Mercenaries/);
  assert.match(container.innerHTML, /Lock Deployment/);
});

test('notification panel labels deployment actions with updated vocabulary', () => {
  const state = makeState();
  const panel = makePanelContainer();
  const uiState = createDefaultUiState();
  const privateData = {
    notifications: [{
      id: 'order-lock:test',
      kind: 'order_lock',
      title: 'Deal commitments affect your orders',
      body: 'deployment lock',
      urgent: false,
      action: 'open_deployment',
    }],
  };

  renderNotificationsPanel(panel, state, privateData, uiState, 'seat-0');

  assert.match(panel.innerHTML, /Private Inbox/);
  assert.match(panel.innerHTML, /Deployment/);
  assert.doesNotMatch(panel.innerHTML, />Orders</);
});

test('player finance renders compact icon values without retired upkeep copy', () => {
  const state = makeState();
  state.players[0].gold = 4;

  const html = renderPlayerTabFinance(getPlayerTabEconomy(state.players[0], { income: { 0: 1 } }, state));

  assert.match(html, /Reserve, income, and troops/);
  assert.doesNotMatch(html, new RegExp('upkeep|prof' + 'essional', 'i'));
});

test('final scoring view uses current scoring categories', () => {
  const state = makeState();
  state.players[0].gold = 50;
  state.themes.OPS.owner = 1;
  state.themes.KAP.bishop = 2;

  const html = renderScoringHtml(state);

  assert.match(html, /Final Reckoning/);
  assert.match(html, /Estate/);
  assert.match(html, /Church/);
  assert.doesNotMatch(html, new RegExp('T' + 'ax'));
});
