import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { applyCourtAction } from '../engine/commands.js';
import { buildPrivateDealView } from '../engine/deals.js';
import { STRATEGOS_DEPLOYMENT_ARMY_KEY } from '../engine/deployment.js';
import { hydratePublicState, serializePublicGameState } from '../engine/publicState.js';
import {
  renderCartouchedText,
  renderPlayerRoleName,
  renderProvinceBadge,
  formatProvinceValuesText,
} from './labels.js';
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
  bindProvinceInterfaceSync,
  getPhaseRenderKey,
  getPlayerTabEconomy,
  isNestedProvinceControlClick,
  renderGameActionPanel,
  renderNotificationsPanel,
  renderPlayerTabs,
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
  const provinceHtml = renderProvinceBadge(state, 'OPS', { showValues: true });

  assert.equal(formatProvinceValuesText(state.themes.OPS), 'P1 T1 C1');
  assert.equal(formatProvinceValuesText(state.themes.CPL), '');
  assert.match(provinceHtml, /province-token-values/);
  assert.match(provinceHtml, /icon-gold/);
  assert.match(provinceHtml, /icon-troop/);
  assert.match(provinceHtml, /icon-church/);
  assert.doesNotMatch(renderProvinceBadge(state, 'CPL', { showValues: true }), /province-token-values/);
});

test('player cartouches escape custom multiplayer names', () => {
  const state = makeState();
  state.players[1].firstName = '<img src=x onerror=alert(1)>';

  const html = renderPlayerRoleName(state, state.players[1]);

  assert.equal(html.includes(`&lt;img src=x onerror=alert(1)&gt; ${state.players[1].dynasty}`), true);
  assert.doesNotMatch(html, /<img src=x/);
});

test('running text upgrades player and province mentions into cartouches', () => {
  const state = makeState();
  const text = `<b>${state.players[1].dynasty}</b> negotiated in ${state.themes.OPS.name}.`;

  const html = renderCartouchedText(state, text);

  assert.match(html, /&lt;b&gt;/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /class="player-chip cartouche-light"/);
  assert.match(html, /data-province-token="OPS"/);
});

test('title redistribution panel is its own phase panel', () => {
  const state = makeState();
  state.phase = 'title_redistribution';
  const container = makePanelContainer();

  renderTitleRedistributionPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /Assign Major Offices/);
  assert.match(container.innerHTML, /data-title-slot="DOM_EAST"/);
  assert.match(container.innerHTML, /title-redist-player-token/);
  assert.match(container.innerHTML, /court-wire-seat-socket/);
  assert.match(container.innerHTML, /court-wire-player-socket/);
  assert.match(container.innerHTML, /data-action="confirm-title-redistribution" disabled/);
  assert.match(container.innerHTML, /Finish Office Slots/);
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
  assert.doesNotMatch(basileusPanel.innerHTML, /data-action="pass-court-power"/);
  assert.doesNotMatch(basileusPanel.innerHTML, /btn-skip/);
  assert.match(basileusPanel.innerHTML, /btn-secondary btn-reset" data-action="reset-court-plan"/);
  assert.match(basileusPanel.innerHTML, /btn-primary btn-commit" data-action="confirm-court-plan"/);
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
  assert.match(patriarchPanel.innerHTML, /data-strategos-theme-pick=/);
  assert.match(patriarchPanel.innerHTML, /data-bishop-theme-pick=/);
  assert.match(patriarchPanel.innerHTML, /Revoke/);
  assert.match(patriarchPanel.innerHTML, /province-office-token-strategos/);
  assert.match(patriarchPanel.innerHTML, /data-province-token="OPS"/);
  assert.match(patriarchPanel.innerHTML, /province-office-token-bishop/);
  assert.match(patriarchPanel.innerHTML, /province-office-mark/);
  assert.doesNotMatch(patriarchPanel.innerHTML, /court-link-seat-province/);
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

test('court wire layout does not draw ownership ropes for open seats', () => {
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

  renderCourtPanel(container, state, 3, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /data-wire-seat-start="strategos:/);
  assert.doesNotMatch(container.innerHTML, /data-wire-line-key="strategos:/);
  assert.doesNotMatch(container.innerHTML, /court-wire-link bound/);
});

test('court plan preview cuts revoked links instead of dimming them', () => {
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
  const uiState = createDefaultUiState();
  uiState.drafts[`court:${state.round}:1`] = {
    plannedActions: [{ action: 'revoke', value: 'minor:KAP:strategos', powerKey: 'DOM_EAST' }],
    plannedPassPowers: [],
  };
  const container = makePanelContainer();

  renderCourtPanel(container, state, 1, {}, { uiState });

  assert.match(container.innerHTML, /court-link-connection cut/);
  assert.match(container.innerHTML, /1 cut/);
  assert.doesNotMatch(container.innerHTML, /data-wire-line-key="strategos:KAP"/);
  assert.doesNotMatch(container.innerHTML, /planned-revoke|pending/);
});

test('court plan preview shows new appointments as tied ropes', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  const uiState = createDefaultUiState();
  uiState.drafts[`court:${state.round}:3`] = {
    plannedActions: [{
      action: 'appoint-strategos',
      titleKey: 'ADMIRAL',
      themeId: 'AEG',
      appointeeId: 2,
      powerKey: 'ADMIRAL',
    }],
    plannedPassPowers: [],
  };
  const container = makePanelContainer();

  renderCourtPanel(container, state, 3, {}, { uiState });

  assert.match(container.innerHTML, /class="court-wire-link bound" data-wire-line-key="strategos:AEG"/);
  assert.match(container.innerHTML, /data-plan-remove="strategos:AEG"/);
  assert.doesNotMatch(container.innerHTML, /court-wire-link pending/);
});

test('court panel applies revocation cooldown to the current draft sequence', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  state.players[1].revocationCooldown = { lastRevokedPlayerId: 2 };
  state.themes.OPS.strategos = 2;
  state.themes.KAP.strategos = 3;
  state.themes.OPT.strategos = 3;
  const container = makePanelContainer();

  renderCourtPanel(container, state, 1, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /data-revoke-pick="minor:OPS:strategos"[^>]*aria-disabled="true"[^>]*>/);
  assert.match(container.innerHTML, /cannot revoke .* twice in a row/);

  const uiState = createDefaultUiState();
  uiState.drafts[`court:${state.round}:1`] = {
    plannedActions: [{ action: 'revoke', value: 'minor:KAP:strategos', powerKey: 'DOM_EAST' }],
    plannedPassPowers: [],
  };

  renderCourtPanel(container, state, 1, {}, { uiState });

  assert.doesNotMatch(container.innerHTML, /data-revoke-pick="minor:OPS:strategos"[^>]*aria-disabled="true"[^>]*>/);
  assert.match(container.innerHTML, /data-revoke-pick="minor:OPT:strategos"[^>]*aria-disabled="true"[^>]*>/);
  assert.doesNotMatch(container.innerHTML, /court-wire-player[^"]*cooldown/);
});

test('court panel applies self-appointment cooldown to the current draft sequence', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  state.players[1].revocationCooldown = { lastRevokedPlayerId: 2 };
  const container = makePanelContainer();
  const selfDraft = createDefaultUiState();
  selfDraft.drafts[`court:${state.round}:1`] = {
    plannedActions: [{
      action: 'appoint-strategos',
      titleKey: 'DOM_EAST',
      themeId: 'OPS',
      appointeeId: 1,
      powerKey: 'DOM_EAST',
    }],
    plannedPassPowers: [],
  };

  renderCourtPanel(container, state, 1, {}, { uiState: selfDraft });

  assert.match(container.innerHTML, /data-strategos-player-pick="1"[^>]*disabled[^>]*>/);
  assert.doesNotMatch(container.innerHTML, /data-strategos-player-pick="2"[^>]*disabled[^>]*>/);
  assert.doesNotMatch(container.innerHTML, /class="court-wire-player[^"]*cooldown[^"]*"[^>]*data-wire-player-row="2"/);
  assert.match(container.innerHTML, /You cannot appoint yourself twice in a row/);

  state.players[1].appointmentCooldown = { selfLocked: true };
  const unlockedDraft = createDefaultUiState();
  unlockedDraft.drafts[`court:${state.round}:1`] = {
    plannedActions: [{
      action: 'appoint-strategos',
      titleKey: 'DOM_EAST',
      themeId: 'OPS',
      appointeeId: 2,
      powerKey: 'DOM_EAST',
    }],
    plannedPassPowers: [],
  };

  renderCourtPanel(container, state, 1, {}, { uiState: unlockedDraft });

  assert.doesNotMatch(container.innerHTML, /data-strategos-player-pick="1"[^>]*disabled[^>]*>/);
});

test('court panel validates multiplayer public snapshots without private logs', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  const publicState = hydratePublicState(serializePublicGameState(state, 1));
  const container = makePanelContainer();

  renderCourtPanel(container, publicState, 1, {}, { uiState: createDefaultUiState() });

  assert.doesNotMatch(container.innerHTML, /Cannot read properties/);
  assert.doesNotMatch(container.innerHTML, /data-strategos-player-pick="0"[^>]*disabled[^>]*>/);
  assert.doesNotMatch(container.innerHTML, /data-bishop-player-pick="0"[^>]*disabled[^>]*>/);
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
  assert.match(container.innerHTML, /court-action-budget/);
  assert.match(container.innerHTML, /<strong>1<\/strong> left of 2/);
  assert.match(container.innerHTML, /1 action remains for this office/);
  assert.match(container.innerHTML, /data-revoke-pick="minor:OPS:strategos"[^>]*aria-disabled="true"[^>]*>/);
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
  assert.match(container.innerHTML, /court-link-connection bound/);
  assert.match(container.innerHTML, /province-office-token-estate/);
  assert.match(container.innerHTML, /data-link-revoke="theme:OPS"/);
  assert.equal(container.innerHTML.includes(`--office-holder-color: ${state.players[2].color};`), true);
  assert.match(container.innerHTML, /<span class="province-office-kind">Estate<\/span>/);
  assert.match(container.innerHTML, /<span class="province-token-name">Opsikion<\/span>/);
  assert.equal(container.innerHTML.includes('Estate —'), false);
  assert.equal(container.innerHTML.includes('Estate â€”'), false);
});

test('court panel disables recently bought estate revocations', () => {
  const state = makeState();
  state.round = 2;
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  state.themes.OPS.owner = 2;
  state.themes.OPS.privateEstatePurchasedRound = 1;
  const container = makePanelContainer();

  renderCourtPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /data-revoke-pick="theme:OPS"[^>]*aria-disabled="true"[^>]*>/);
  assert.match(container.innerHTML, /bought last turn and cannot be revoked until next turn/);
});

test('court panel shows passed offices while other offices remain available', () => {
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
  assert.match(container.innerHTML, /data-court-power="DOM_EAST"/);
  assert.match(container.innerHTML, /data-court-power="PATRIARCH"/);
  assert.doesNotMatch(container.innerHTML, /data-court-pass-power=/);

  const pass = applyCourtAction(state, 1, { action: 'pass-court-power', powerKey: 'DOM_EAST' });
  assert.equal(pass.ok, true);
  renderCourtPanel(container, state, 1, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /passed with no action recorded/);
  assert.match(container.innerHTML, /data-court-power="PATRIARCH"/);
  assert.doesNotMatch(container.innerHTML, /data-court-pass-power=/);
});

test('estates panel lists free land bids before deployment', () => {
  const state = makeState();
  state.phase = 'estates';
  state.players[2].gold = 4;
  const container = makePanelContainer();

  renderEstatesPanel(container, state, 2, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /Buy Land/);
  assert.match(container.innerHTML, /data-estate-bid="OPS"/);
  assert.match(container.innerHTML, /max="4"[^>]*step="1"[^>]*data-estate-bid="OPS"/);
  assert.match(container.innerHTML, /0\/4 ready/);
  assert.match(container.innerHTML, /Lock Bids/);
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
  assert.match(container.innerHTML, /Your bid/);
  assert.match(container.innerHTML, />Update Bid</);
});

test('province card sync ignores nested estate bid controls', () => {
  const estateCard = {};
  const bidInput = { closest: () => bidInput };
  const bidButton = { closest: () => bidButton };
  const provinceButton = {};
  const provinceButtonLabel = { closest: () => provinceButton };

  assert.equal(isNestedProvinceControlClick(bidInput, estateCard), true);
  assert.equal(isNestedProvinceControlClick(bidButton, estateCard), true);
  assert.equal(isNestedProvinceControlClick(provinceButtonLabel, provinceButton), false);
});

test('standalone province cartouches participate in hover and selection sync', () => {
  const handlers = {};
  const classes = new Set();
  const token = {
    dataset: { provinceToken: 'OPS' },
    parentElement: null,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
    },
    addEventListener(type, handler) {
      handlers[type] = handler;
    },
    closest(selector) {
      return selector.includes('data-province-token') ? this : null;
    },
  };
  const rootHandlers = {};
  const root = {
    contains: (element) => element === token,
    querySelectorAll(selector) {
      if (selector === '.map-selected, .map-hovered') return [];
      if (selector.includes('data-province-token')) return [token];
      return [];
    },
    addEventListener(type, handler) {
      rootHandlers[type] = handler;
    },
  };
  const hoverEvents = [];
  let selectedProvince = null;

  bindProvinceInterfaceSync({
    root,
    selectedProvinceId: 'OPS',
    hoveredProvinceId: 'OPS',
    onSelectProvince: (provinceId) => { selectedProvince = provinceId; },
    onHoverProvince: (provinceId) => hoverEvents.push(provinceId),
  });

  assert.equal(classes.has('map-selected'), true);
  assert.equal(classes.has('map-hovered'), true);
  handlers.pointerenter();
  handlers.pointerleave();
  rootHandlers.click({ target: token });

  assert.deepEqual(hoverEvents, ['OPS', null]);
  assert.equal(selectedProvince, 'OPS');
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

  assert.match(container.innerHTML, /Send Armies/);
  assert.match(container.innerHTML, /Funding/);
  assert.match(container.innerHTML, /Mercs/);
  assert.match(container.innerHTML, /Move each army slider/);
  assert.match(container.innerHTML, /Capital troops/);
  assert.match(container.innerHTML, /through ranking/);
  assert.match(container.innerHTML, /Passive support/);
  assert.match(container.innerHTML, /Rank claimants for the throne/);
  assert.match(container.innerHTML, /data-candidate-rank-list role="list"/);
  assert.match(container.innerHTML, /candidate-drag-handle/);
  assert.match(container.innerHTML, /Use arrow keys to move this claimant/);
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
  assert.match(container.innerHTML, /btn-primary btn-commit" data-action="lock-orders" disabled/);
});

test('deployment ranking can withhold support from the first dynasty', () => {
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
  assert.match(container.innerHTML, /btn-primary btn-commit" data-action="lock-orders" >Lock Deployment/);
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

test('deployment reveal is collapsed under the coup breakdown', () => {
  const state = makeState();
  state.phase = 'resolution';
  state.lastCoupResult = {
    winner: 2,
    votes: { 2: 3 },
    contributions: [{ playerId: 0, candidateId: 2, troops: 3 }],
    ballots: [{ playerId: 0, candidateId: 2, troops: 3 }],
  };
  state.history.push({
    type: 'orders_revealed',
    round: state.round,
    actorId: 0,
    actorName: 'Phokas',
    details: {
      capitalTroops: 3,
      frontierTroops: 0,
      passiveCapitalSupport: 0,
      mercenaries: { count: 0, destination: null },
      offices: [{ officeKey: 'BASILEUS', totalTroops: 3, fundedTroops: 3, unfundedTroops: 0, capitalTroops: 3, frontierTroops: 0, destination: 'capital' }],
    },
  });
  const container = makePanelContainer();

  renderResolutionPanel(container, state);

  assert.match(container.innerHTML, /<details class="deployment-reveal-details">/);
  assert.equal(container.innerHTML.indexOf('Coup') < container.innerHTML.indexOf('Deployment Details'), true);
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
  assert.match(panel.innerHTML, /sidebar-panel-title">Resolve Turn/);
  assert.match(shell.innerHTML, /<h3>Resolve Turn<\/h3>/);
  assert.match(shell.innerHTML, /Empire Fallen/);
  assert.match(shell.innerHTML, /Empire falls/);
  assert.doesNotMatch(shell.innerHTML, /Final Reckoning/);
  assert.equal(shell.continueButton.textContent, 'Final Score');
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
        toast: false,
        action: 'open_deployment',
      },
      {
        id: 'loss:test',
        kind: 'estate_lost',
        title: 'You lost a bid',
        body: 'sealed bid lost',
        urgent: false,
        toast: true,
        tone: 'negative',
        action: 'open_history',
      },
      {
        id: 'win:test',
        kind: 'estate_won',
        title: 'You won an estate',
        body: 'sealed bid won',
        urgent: true,
        tone: 'positive',
        action: 'open_history',
      },
    ],
  };

  renderNotificationsPanel(panel, state, privateData, uiState, 'seat-0');

  assert.match(panel.innerHTML, /Private Inbox/);
  assert.match(panel.innerHTML, /Send Armies/);
  assert.match(panel.innerHTML, /tone-neutral/);
  assert.match(panel.innerHTML, /tone-negative/);
  assert.match(panel.innerHTML, /tone-positive/);
  assert.match(panel.innerHTML, /notification-toast tone-negative/);
  assert.match(panel.innerHTML, /notification-toast tone-positive/);
  assert.doesNotMatch(panel.innerHTML, /notification-toast tone-neutral/);
  assert.doesNotMatch(panel.innerHTML, /Court business awaits/);
  assert.doesNotMatch(panel.innerHTML, />Orders</);
});

test('player finance renders compact icon values without retired upkeep copy', () => {
  const state = makeState();
  state.players[0].gold = 4;

  const html = renderPlayerTabFinance(getPlayerTabEconomy(state.players[0], { income: { 0: 1 } }, state));

  assert.match(html, /Reserve, income, and troops/);
  assert.doesNotMatch(html, new RegExp('upkeep|prof' + 'essional', 'i'));
});

test('player tabs separate status labels from the finance row without duplicate basileus badges', () => {
  const state = makeState();
  state.basileusId = 2;
  const previousDocument = globalThis.document;
  const tabBar = {
    innerHTML: '',
    querySelectorAll: () => [],
  };
  globalThis.document = {
    getElementById: (id) => (id === 'playerTabBar' ? tabBar : null),
  };

  try {
    renderPlayerTabs({
      state,
      activePlayerId: 0,
      onSelectPlayer: () => {},
      getBadges: (player) => (player.id === 0 ? ['<span class="tab-you">You</span>'] : []),
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  assert.match(tabBar.innerHTML, /class="tab-identity"/);
  assert.match(tabBar.innerHTML, /class="tab-finance"/);
  assert.match(tabBar.innerHTML, /class="tab-flags"><span class="tab-you">You<\/span><\/span>/);
  assert.match(tabBar.innerHTML, /Komnenos/);
  assert.match(tabBar.innerHTML, /Basileus/);
  assert.doesNotMatch(tabBar.innerHTML, /title-token/);
});

test('final scoring view uses income-share scoring categories', () => {
  const state = makeState();
  state.players[0].gold = 50;
  state.themes.OPS.owner = 1;
  state.themes.KAP.bishop = 2;
  state.themes.SAM.strategos = 3;

  const html = renderScoringHtml(state);

  assert.match(html, /Final Score/);
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

  assert.match(html, /Final Score/);
  assert.match(html, /Empire Fallen/);
  assert.match(html, /Everyone lost/);
  assert.match(html, /strongest position/);
  assert.match(html, /score-row\s+top-score/);
  assert.match(html, /Top score, rank/);
  assert.doesNotMatch(html, /Highest point total wins/);
  assert.doesNotMatch(html, /Winner, rank/);
  assert.doesNotMatch(html, /score-row\s+winner/);
});
