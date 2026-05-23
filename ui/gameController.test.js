import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { applyCourtAction } from '../engine/commands.js';
import { buildPrivateDealView } from '../engine/deals.js';
import { STRATEGOS_DEPLOYMENT_ARMY_KEY } from '../engine/deployment.js';
import { renderProvinceBadge, formatProvinceValuesText } from './labels.js';
import {
  renderCourtPanel,
  renderEstatesPanel,
  renderHistoryPanel,
  renderOrdersPanel,
  renderResolutionPanel,
  renderTitleRedistributionPanel,
} from './panels.js';
import {
  createDefaultUiState,
  getPhaseRenderKey,
  getPlayerTabEconomy,
  renderGameActionPanel,
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

function makeFakeElement() {
  const element = {
    innerHTML: '',
    textContent: '',
    disabled: false,
    children: [],
    classList: { toggle: () => {} },
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
    querySelector(selector) {
      if (selector === '[data-action="continue"]' && this.innerHTML.includes('data-action="continue"')) {
        this.continueButton = this.continueButton || makeFakeElement();
        return this.continueButton;
      }
      return null;
    },
  };
  return element;
}

function makeActionPanelContainer() {
  const panel = makeFakeElement();
  const body = makeFakeElement();
  panel.querySelector = (selector) => (
    selector === '[data-role="action-panel-body"]' ? body : null
  );
  return { panel, body };
}

function withFakeDocument(callback) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => makeFakeElement(),
  };
  try {
    return callback();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

test('province badges render the updated P/T/C economy and hide capital values', () => {
  const state = makeState();

  assert.equal(formatProvinceValuesText(state.themes.OPS), 'P1 T1 C1');
  assert.equal(formatProvinceValuesText(state.themes.CPL), '');
  assert.match(renderProvinceBadge(state, 'OPS', { showValues: true }), /P1 T1 C1/);
  assert.doesNotMatch(renderProvinceBadge(state, 'CPL', { showValues: true }), /province-token-values/);
});

test('title redistribution panel is its own phase panel', () => {
  const state = makeState();
  state.phase = 'title_redistribution';
  const container = makePanelContainer();

  renderTitleRedistributionPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /Redistribute Major Titles/);
  assert.match(container.innerHTML, /data-title-assignment="DOM_EAST"/);
  assert.match(container.innerHTML, /data-title-assignment="DOM_EAST" value=""/);
  assert.match(container.innerHTML, /data-action="confirm-title-redistribution" disabled/);
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
  state.themes.OPS.owner = 2;
  state.themes.KAP.strategos = 1;

  const basileusPanel = makePanelContainer();
  renderCourtPanel(basileusPanel, state, state.basileusId, {}, { uiState: createDefaultUiState() });
  assert.match(basileusPanel.innerHTML, /Basileus/);
  assert.match(basileusPanel.innerHTML, /Choose actions/);
  assert.match(basileusPanel.innerHTML, /data-revoke-pick="minor:KAP:strategos"/);
  assert.match(basileusPanel.innerHTML, /data-revoke-pick="theme:OPS"/);
  assert.match(basileusPanel.innerHTML, /data-action="pass-court-power"/);
  assert.doesNotMatch(basileusPanel.innerHTML, /Empress|Chief of Eunuchs/);
  assert.doesNotMatch(basileusPanel.innerHTML, />Appoint</);
  assert.doesNotMatch(basileusPanel.innerHTML, /End Court/);
  assert.doesNotMatch(basileusPanel.innerHTML, /Skip Action/);
  assert.doesNotMatch(basileusPanel.innerHTML, /Confirm Court/);
  assert.doesNotMatch(basileusPanel.innerHTML, /Appoint Strategos/);
  assert.doesNotMatch(basileusPanel.innerHTML, /Appoint Bishop/);

  state.themes.KAP.bishop = 2;
  const patriarchPanel = makePanelContainer();
  renderCourtPanel(patriarchPanel, state, 1, {}, { uiState: createDefaultUiState() });
  assert.match(patriarchPanel.innerHTML, /Appoint Strategos/);
  assert.match(patriarchPanel.innerHTML, /Appoint Bishop/);
  assert.match(patriarchPanel.innerHTML, /Revoke/);
  assert.doesNotMatch(patriarchPanel.innerHTML, /Gift/);
  assert.doesNotMatch(patriarchPanel.innerHTML, new RegExp('Mercenary Company|Prof' + 'essional|lev' + 'ies', 'i'));
});

test('court panel disables appointments blocked by current legality', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  state.players[1].appointmentCooldown = { selfLocked: true };
  const container = makePanelContainer();

  renderCourtPanel(container, state, 1, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /data-strategos-player-pick="1"[^>]*disabled[^>]*>/);
  assert.match(container.innerHTML, /data-bishop-player-pick="1"[^>]*disabled[^>]*>/);
  assert.match(container.innerHTML, /You cannot appoint yourself twice in a row/);
});

test('court panel keeps mixed actions open but blocks same-turn title reversals', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  state.themes.KAP.strategos = 3;

  const result = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(result.ok, true);

  const container = makePanelContainer();
  renderCourtPanel(container, state, 1, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /1\/2 actions \(1 appointment\)/);
  assert.match(container.innerHTML, /1 action remains for this office/);
  assert.match(container.innerHTML, /data-revoke-pick="minor:OPS:strategos"[^>]*disabled[^>]*>/);
  assert.match(container.innerHTML, /was appointed this turn and cannot be revoked until next turn/);
  assert.doesNotMatch(container.innerHTML, /data-revoke-pick="minor:KAP:strategos"[^>]*disabled[^>]*>/);
});

test('court estate revocations show owner color without the old separator', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  state.themes.OPS.owner = 2;
  const container = makePanelContainer();

  renderCourtPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /data-revoke-pick="theme:OPS"/);
  assert.match(container.innerHTML, /revocation-target-card estate/);
  assert.match(container.innerHTML, /province-owner-marker compact/);
  assert.equal(container.innerHTML.includes(`--province-owner-color: ${state.players[2].color};`), true);
  assert.equal(container.innerHTML.includes('Estate —'), false);
  assert.equal(container.innerHTML.includes('Estate â€”'), false);
});

test('court panel lets a player pass one office while keeping other offices available', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  const container = makePanelContainer();

  renderCourtPanel(container, state, 1, {}, { uiState: createDefaultUiState() });
  assert.match(container.innerHTML, /data-court-pass-power="DOM_EAST"/);
  assert.match(container.innerHTML, /data-court-pass-power="PATRIARCH"/);

  const pass = applyCourtAction(state, 1, { action: 'pass-court-power', powerKey: 'DOM_EAST' });
  assert.equal(pass.ok, true);
  renderCourtPanel(container, state, 1, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /passed with no action recorded/);
  assert.doesNotMatch(container.innerHTML, /data-court-pass-power="DOM_EAST"/);
  assert.match(container.innerHTML, /data-court-pass-power="PATRIARCH"/);
});

test('estates panel lists free land bids before deployment', () => {
  const state = makeState();
  state.phase = 'estates';
  const container = makePanelContainer();

  renderEstatesPanel(container, state, 2, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /Estates/);
  assert.match(container.innerHTML, /data-estate-bid="OPS"/);
  assert.match(container.innerHTML, /0\/4 ready/);
  assert.match(container.innerHTML, /Ready for Deployment/);
});

test('estates panel marks the active sealed bid', () => {
  const state = makeState();
  state.phase = 'estates';
  state.players[2].gold = 5;
  state.landAuctions.OPS = {
    themeId: 'OPS',
    round: state.round,
    sealed: true,
    bids: { 2: { bidderId: 2, amount: 3, round: state.round } },
  };
  const container = makePanelContainer();

  renderEstatesPanel(container, state, 2, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /estate-card selected/);
  assert.match(container.innerHTML, /Your sealed bid/);
  assert.match(container.innerHTML, />Update</);
});

test('deployment panel uses funded armies and mercenary slider schema', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.players[state.basileusId].gold = 1;
  state.currentTroops = {
    BASILEUS: { normal: 2, capitalLocked: 1 },
  };
  const container = makePanelContainer();
  const uiState = createDefaultUiState();
  uiState.drafts[`deployment:${state.round}:${state.basileusId}`] = {
    armies: {
      BASILEUS: { funded: 1, destination: 'frontier' },
    },
    mercenaries: { count: 2, destination: 'frontier' },
    candidate: state.basileusId,
  };

  renderOrdersPanel(container, state, state.basileusId, {}, { uiState });

  assert.match(container.innerHTML, /Deployment/);
  assert.match(container.innerHTML, /Funding/);
  assert.match(container.innerHTML, /Mercs/);
  assert.match(container.innerHTML, /Unfunded troops stay home/);
  assert.match(container.innerHTML, /Capital troops/);
  assert.match(container.innerHTML, /through ranking/);
  assert.match(container.innerHTML, /Passive support/);
  assert.match(container.innerHTML, /Rank claimants for the throne/);
  assert.match(container.innerHTML, /candidate-drag-handle/);
  assert.match(container.innerHTML, /data-candidate-support=/);
  assert.doesNotMatch(container.innerHTML, /candidate-rank-row self locked/);
  assert.match(container.innerHTML, /capital locked/);
  assert.match(container.innerHTML, /Mercenaries/);
  assert.match(container.innerHTML, /Lock Deployment/);
});

test('fresh deployment panel requires explicit funding and destination', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.players[state.basileusId].gold = 1;
  state.currentTroops = {
    BASILEUS: { normal: 2, capitalLocked: 0 },
  };
  const container = makePanelContainer();

  renderOrdersPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /army-card unresolved/);
  assert.match(container.innerHTML, /data-funded-readout="BASILEUS"[^>]*>Pick</);
  assert.doesNotMatch(container.innerHTML, /class="candidate-row selected/);
  assert.match(container.innerHTML, /Finish Deployment/);
  assert.match(container.innerHTML, /data-action="lock-orders" disabled/);
});

test('deployment ranking can withhold support from seat one', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.players[state.basileusId].gold = 1;
  state.currentTroops = {
    BASILEUS: { normal: 2, capitalLocked: 0 },
  };
  const container = makePanelContainer();
  const uiState = createDefaultUiState();
  uiState.drafts[`deployment:${state.round}:${state.basileusId}`] = {
    armies: {
      BASILEUS: { funded: 1, destination: 'capital' },
    },
    mercenaries: { count: 0, destination: null },
    ranking: [0, 1, 2, 3],
    candidateSupport: { 0: false },
  };

  renderOrdersPanel(container, state, state.basileusId, {}, { uiState });

  assert.match(container.innerHTML, /support-off[\s\S]*data-candidate-rank="0"/);
  assert.match(container.innerHTML, /data-candidate-support="0"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(container.innerHTML, /data-candidate-support="0"[^>]*disabled/);
});

test('deployment panel bundles strategos commands and does not require idle mercenary destination', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.themes.OPS.strategos = 1;
  state.themes.KAP.strategos = 1;
  state.currentTroops = {
    STRAT_OPS: { normal: 1, capitalLocked: 0 },
    STRAT_KAP: { normal: 2, capitalLocked: 0 },
  };
  const container = makePanelContainer();
  const uiState = createDefaultUiState();
  uiState.drafts[`deployment:${state.round}:1`] = {
    armies: {
      [STRATEGOS_DEPLOYMENT_ARMY_KEY]: { funded: 3, destination: 'capital' },
    },
    mercenaries: { count: 0, destination: null },
    candidate: 1,
  };

  renderOrdersPanel(container, state, 1, {}, { uiState });

  assert.match(container.innerHTML, /data-army-card="STRAT_ALL"/);
  assert.match(container.innerHTML, /Strategoi/);
  assert.match(container.innerHTML, /2 Strategos commands combined/);
  assert.doesNotMatch(container.innerHTML, /data-army-card="STRAT_OPS"/);
  assert.doesNotMatch(container.innerHTML, /data-army-card="STRAT_KAP"/);
  assert.match(container.innerHTML, /data-action="lock-orders" >Lock Deployment/);
});

test('deployment panel surfaces deal-forced coup support before lock-in', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.round = 1;
  state.players[state.basileusId].gold = 1;
  state.currentTroops = {
    BASILEUS: { normal: 2, capitalLocked: 0 },
  };
  state.activeDealObligations = [{
    id: 'deal-obligation-test',
    kind: 'coup_support',
    status: 'active',
    giverId: state.basileusId,
    receiverId: 2,
    nextDueRound: state.round,
    durationTurns: 1,
    remainingTurns: 1,
    startTrigger: { type: 'immediate' },
    payload: { candidateId: 2, troopCount: 1 },
  }];
  const container = makePanelContainer();
  const uiState = createDefaultUiState();

  renderOrdersPanel(container, state, state.basileusId, {}, {
    uiState,
    privateData: buildPrivateDealView(state, state.basileusId),
  });

  assert.match(container.innerHTML, /Deal commitments/);
  assert.match(container.innerHTML, /Coup rank:/);
  assert.match(container.innerHTML, /Deal lock/);
  assert.match(container.innerHTML, /must deploy to Capital/);
  assert.match(container.innerHTML, /candidate-rank-row deal-locked/);
  assert.match(container.innerHTML, /data-candidate-rank="2"[\s\S]*draggable="false"/);
});

test('war resolution shows frontier contributor details', () => {
  const state = makeState();
  state.phase = 'resolution';
  state.lastWarResult = {
    outcome: 'victory',
    frontierTroops: 5,
    invaderStrength: 3,
    themesLost: [],
    themesRecovered: [],
    contributions: [
      { playerId: 0, playerName: 'Basileus', troops: 3 },
      { playerId: 2, playerName: 'Defender', troops: 2 },
    ],
  };
  const container = makePanelContainer();

  renderResolutionPanel(container, state);

  assert.match(container.innerHTML, /Frontier contributions/);
  assert.match(container.innerHTML, /frontier-troops/);
  assert.doesNotMatch(container.innerHTML, /No frontier troops were committed/);
});

test('coup resolution shows supporters and zero-capital claimant picks', () => {
  const state = makeState();
  state.phase = 'resolution';
  state.lastCoupResult = {
    winner: 2,
    votes: { 2: 3, 3: 0 },
    contributions: [{ playerId: 0, candidateId: 2, troops: 3 }],
    ballots: [
      { playerId: 0, candidateId: 2, troops: 3 },
      { playerId: 1, candidateId: 3, troops: 0 },
    ],
  };
  const container = makePanelContainer();

  renderResolutionPanel(container, state);

  assert.match(container.innerHTML, /Coup/);
  assert.match(container.innerHTML, /vote-supporters/);
  assert.match(container.innerHTML, /No capital troops from/);
});

test('empire fall still shows the resolution result before final reckoning', () => {
  const state = makeState();
  state.phase = 'resolution';
  state.gameOver = { type: 'fall', message: 'Constantinople has fallen. The Empire is no more. No dynasty wins.' };
  state.currentInvasion = { name: 'Ottomans' };
  state.lastWarResult = {
    outcome: 'defeat',
    frontierTroops: 2,
    invaderStrength: 7,
    themesLost: ['OPS'],
    themesRecovered: [],
    reachedCPL: true,
    contributions: [{ playerId: 1, playerName: 'Defender', troops: 2 }],
  };
  state.lastCoupResult = {
    winner: state.basileusId,
    votes: { [state.basileusId]: 2 },
    contributions: [{ playerId: 0, candidateId: state.basileusId, troops: 2 }],
    ballots: [{ playerId: 0, candidateId: state.basileusId, troops: 2 }],
  };
  const { panel, body } = makeActionPanelContainer();

  withFakeDocument(() => {
    renderGameActionPanel({
      panel,
      state,
      uiState: createDefaultUiState(),
      activePlayerId: state.basileusId,
      handlers: { includeNewGame: true },
      resolution: { continue: () => {} },
    });
  });

  const shell = body.children[0];
  assert.match(panel.innerHTML, /sidebar-panel-title">Resolution/);
  assert.match(shell.innerHTML, /<h3>Resolution<\/h3>/);
  assert.match(shell.innerHTML, /Empire Fallen/);
  assert.match(shell.innerHTML, /Empire falls/);
  assert.doesNotMatch(shell.innerHTML, /Final Reckoning/);
  assert.equal(shell.continueButton.textContent, 'Final Reckoning');
});

test('default interface opens the action lane and keeps support panels collapsed', () => {
  const uiState = createDefaultUiState();

  assert.equal(uiState.panels.action, true);
  assert.equal(uiState.panels.dashboard, true);
  assert.equal(uiState.panels.notifications, false);
  assert.equal(uiState.panels.balance, false);
  assert.equal(uiState.panels.history, false);
});

test('history panel renders the full chronicle instead of only recent entries', () => {
  const state = makeState();
  const panel = makePanelContainer();
  const uiState = createDefaultUiState();
  uiState.panels.history = true;
  state.history = Array.from({ length: 35 }, (_, index) => ({
    id: `history-${index + 1}`,
    round: index + 1,
    phase: 'court',
    summary: `Entry ${index + 1}`,
  }));

  renderHistoryPanel(panel, state, { uiState });

  assert.match(panel.innerHTML, /35 entries/);
  assert.match(panel.innerHTML, /Entry 1/);
  assert.match(panel.innerHTML, /Entry 35/);
});

test('phase render key changes when the active phase or ending changes', () => {
  const state = makeState();
  state.phase = 'court';
  const courtKey = getPhaseRenderKey(state);
  state.phase = 'deployment';
  assert.notEqual(getPhaseRenderKey(state), courtKey);
  state.gameOver = { type: 'empire_fallen' };
  assert.match(getPhaseRenderKey(state), /empire_fallen/);
});

test('notification panel labels deployment actions with updated vocabulary', () => {
  const state = makeState();
  const panel = makePanelContainer();
  const uiState = createDefaultUiState();
  uiState.panels.notifications = true;
  const privateData = {
    notifications: [
      {
        id: 'order-lock:test',
        kind: 'order_lock',
        title: 'Deal commitments affect your orders',
        body: 'deployment lock',
        urgent: false,
        action: 'open_deployment',
      },
      {
        id: 'gain:test',
        kind: 'court_action',
        title: 'Court business awaits',
        body: 'confirm court',
        urgent: true,
        tone: 'neutral',
        action: 'open_court',
      },
      {
        id: 'loss:test',
        kind: 'estate_lost',
        title: 'You lost a bid',
        body: 'sealed bid lost',
        urgent: false,
        tone: 'negative',
        action: 'open_estates',
      },
      {
        id: 'win:test',
        kind: 'estate_won',
        title: 'You won an estate',
        body: 'sealed bid won',
        urgent: false,
        tone: 'positive',
        action: 'open_history',
      },
    ],
  };

  renderNotificationsPanel(panel, state, privateData, uiState, 'seat-0');

  assert.match(panel.innerHTML, /Private Inbox/);
  assert.match(panel.innerHTML, /Deployment/);
  assert.match(panel.innerHTML, /Court/);
  assert.match(panel.innerHTML, /Estates/);
  assert.match(panel.innerHTML, /tone-neutral/);
  assert.match(panel.innerHTML, /tone-negative/);
  assert.match(panel.innerHTML, /tone-positive/);
  assert.doesNotMatch(panel.innerHTML, />Orders</);
});

test('player finance renders compact icon values without retired upkeep copy', () => {
  const state = makeState();
  state.players[0].gold = 4;

  const html = renderPlayerTabFinance(getPlayerTabEconomy(state.players[0], { income: { 0: 1 } }, state));

  assert.match(html, /Reserve, income, and troops/);
  assert.doesNotMatch(html, new RegExp('upkeep|prof' + 'essional', 'i'));
});

test('final scoring view uses income-share scoring categories', () => {
  const state = makeState();
  state.players[0].gold = 50;
  state.themes.OPS.owner = 1;
  state.themes.KAP.bishop = 2;
  state.themes.SAM.strategos = 3;

  const html = renderScoringHtml(state);

  assert.match(html, /Final Reckoning/);
  assert.match(html, /Highest point total wins/);
  assert.match(html, /Each 10% share/);
  assert.match(html, /Profit income/);
  assert.match(html, /Office income/);
  assert.match(html, /icon-church/);
  assert.match(html, /icon-troop/);
  assert.doesNotMatch(html, /Church income/);
  assert.doesNotMatch(html, /Troop income/);
  assert.doesNotMatch(html, new RegExp('T' + 'ax'));
});

test('fallen empire final scoring makes the collective loss explicit', () => {
  const state = makeState();
  state.players[0].gold = 50;
  state.players[1].gold = 5;
  state.gameOver = { type: 'fall', message: 'Constantinople has fallen. The Empire is no more. No dynasty wins.' };

  const html = renderScoringHtml(state);

  assert.match(html, /Final Reckoning/);
  assert.match(html, /Empire Fallen/);
  assert.match(html, /Everyone lost/);
  assert.match(html, /strongest position/);
  assert.match(html, /score-row\s+top-score/);
  assert.match(html, /Top score, rank/);
  assert.doesNotMatch(html, /Highest point total wins/);
  assert.doesNotMatch(html, /Winner, rank/);
  assert.doesNotMatch(html, /score-row\s+winner/);
});
