import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import { applyCourtAction } from '../engine/commands.js';
import { buildPrivateDealView } from '../engine/deals.js';
import { STRATEGOS_DEPLOYMENT_ARMY_KEY } from '../engine/deployment.js';
import { resolveInvasion } from '../engine/combat.js';
import { addEstates } from '../engine/estates.js';
import { phaseEstates } from '../engine/turnflow.js';
import { addEstateToDraft, getEstateDraft, removeEstateFromDraft } from './panels/estates.js';
import { getProvinceCourtOptions, planProvinceAppointment, toggleProvinceRevocation } from './panels/court.js';
import { toggleCoupChoice } from './panels/orders.js';
import { playerDisplayLabel } from './panels/shared.js';
import { formatHalves } from './icons.js';
import { BALANCE } from '../data/balance.js';
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

test('province badges only mark bishoprics, never Constantinople', () => {
  const state = makeState();
  const bishopric = Object.values(state.themes).find((theme) => theme.id !== 'CPL' && theme.C > 0);
  const plain = Object.values(state.themes).find((theme) => theme.id !== 'CPL' && !(theme.C > 0));

  assert.equal(formatProvinceValuesText(bishopric), 'Bishopric');
  assert.equal(formatProvinceValuesText(plain), '');
  assert.equal(formatProvinceValuesText(state.themes.CPL), '');
  const bishopricHtml = renderProvinceBadge(state, bishopric.id, { showValues: true });
  assert.match(bishopricHtml, /province-token-values/);
  assert.match(bishopricHtml, /icon-church/);
  assert.doesNotMatch(bishopricHtml, /icon-gold|icon-troop/);
  assert.doesNotMatch(renderProvinceBadge(state, plain.id, { showValues: true }), /province-token-values/);
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

  assert.match(container.innerHTML, /Major offices/);
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
  addEstates(state.themes.OPS, 2, 2);
  state.themes.KAP.strategos = 1;

  const basileusPanel = makePanelContainer();
  renderCourtPanel(basileusPanel, state, state.basileusId, {}, { uiState: createDefaultUiState() });
  assert.match(basileusPanel.innerHTML, /Basileus/);
  assert.match(basileusPanel.innerHTML, /Choose actions/);
  // The Basileus revokes estates only.
  assert.doesNotMatch(basileusPanel.innerHTML, /data-revoke-pick="minor:KAP:strategos"/);
  assert.match(basileusPanel.innerHTML, /data-revoke-pick="estates:OPS:2"/);
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

test('court panel disables appointment targets blocked by current legality', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  state.players[1].appointmentCooldown = { lastAppointeeId: 2 };
  const container = makePanelContainer();

  renderCourtPanel(container, state, 1, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /data-strategos-player-pick="2"[^>]*disabled[^>]*>/);
  assert.match(container.innerHTML, /data-bishop-player-pick="2"[^>]*disabled[^>]*>/);
  assert.doesNotMatch(container.innerHTML, /data-strategos-player-pick="1"[^>]*disabled[^>]*>/);
  assert.match(container.innerHTML, /You cannot appoint .* twice in a row/);
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
  assert.match(container.innerHTML, /was appointed this round and cannot be revoked until the next one/);
  assert.doesNotMatch(container.innerHTML, /data-revoke-pick="minor:KAP:strategos"[^>]*disabled[^>]*>/);
});

test('court estate revocations show one row per dynasty with its estate count', () => {
  const state = makeState();
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
  addEstates(state.themes.OPS, 2, 3);
  addEstates(state.themes.OPS, 3, 1);
  const container = makePanelContainer();

  renderCourtPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /data-revoke-pick="estates:OPS:2"/);
  assert.match(container.innerHTML, /data-revoke-pick="estates:OPS:3"/);
  assert.match(container.innerHTML, /court-link-connection bound/);
  assert.match(container.innerHTML, /province-office-token-estate/);
  assert.equal(container.innerHTML.includes(`--office-holder-color: ${state.players[2].color};`), true);
  assert.match(container.innerHTML, /<span class="province-office-kind">Estates ×3<\/span>/);
  assert.match(container.innerHTML, /<span class="province-token-name">Opsikion<\/span>/);
});

test('court panel offers every estate for revocation, even those built last round', () => {
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
  addEstates(state.themes.OPS, 2, 1);
  addEstates(state.themes.KAP, 1, 1);
  const container = makePanelContainer();

  renderCourtPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /data-revoke-pick="estates:OPS:2"/);
  assert.match(container.innerHTML, /data-revoke-pick="estates:KAP:1"/);
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

test('estates panel plans estates with + and - and locks the whole plan once', () => {
  const state = makeState();
  phaseEstates(state);
  // Enough for two estates, not three.
  state.players[2].gold = 3 * BALANCE.ESTATE_PRICE - 1;
  addEstates(state.themes.OPS, 3, 2);
  const uiState = createDefaultUiState();
  const container = makePanelContainer();
  const submitted = [];

  renderEstatesPanel(container, state, 2, { submitEstatePlan: (payload) => submitted.push(payload) }, { uiState });

  assert.match(container.innerHTML, /<h3>Estates<\/h3>/);
  assert.match(container.innerHTML, /data-estate-add="OPS"/);
  assert.match(container.innerHTML, /data-estate-remove="OPS"[^>]*disabled/);
  assert.doesNotMatch(container.innerHTML, /data-estate-add="ANT"/, 'lost provinces take no estates');
  assert.match(container.innerHTML, /class="estate-chip" style="--chip-color: [^"]+;" title="[^"]*: 2 estates"/);
  assert.match(container.innerHTML, /0\/4 locked/);
  assert.match(container.innerHTML, /Lock No Estates/);

  assert.equal(addEstateToDraft(uiState, state, 2, 'OPS'), true);
  assert.equal(addEstateToDraft(uiState, state, 2, 'OPS'), true);
  assert.equal(addEstateToDraft(uiState, state, 2, 'SAM'), false, 'a third estate is more than the purse');
  renderEstatesPanel(container, state, 2, { submitEstatePlan: (payload) => submitted.push(payload) }, { uiState });
  assert.match(container.innerHTML, /estate-row planned/);
  assert.match(container.innerHTML, /estate-chip planned[^>]*>\+2</);
  assert.match(container.innerHTML, />Lock Estates</);
});

test('a locked estate plan is shown read-only until the dynasty changes it', () => {
  const state = makeState();
  phaseEstates(state);
  state.players[2].gold = 5;
  state.estatePlans = { 2: { OPS: 1 } };
  state.estatesReady = { 2: true };
  const container = makePanelContainer();

  renderEstatesPanel(container, state, 2, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /Your estates are locked/);
  assert.match(container.innerHTML, />Change Plan</);
  assert.match(container.innerHTML, /data-estate-add="OPS"[^>]*disabled/);
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
  // With the two dismissed troops, enough for two mercenaries.
  state.players[state.basileusId].gold = 2 * BALANCE.MERCENARY_PRICE - 2 * BALANCE.GOLD_PER_DISMISSED_TROOP;
  state.currentTroops = {
    BASILEUS: 3,
  };
  const container = makePanelContainer();
  const uiState = createDefaultUiState();
  uiState.drafts[`deployment:${state.round}:${state.basileusId}`] = {
    armies: {
      BASILEUS: { funded: 1, destination: 'frontier' },
    },
    mercenaries: { count: 2, destination: 'frontier' },
  };

  renderOrdersPanel(container, state, state.basileusId, {}, { uiState });

  assert.match(container.innerHTML, /<h3>Deployment<\/h3>/);
  assert.match(container.innerHTML, /Fielded: 1 of 3/);
  assert.match(container.innerHTML, /Mercenaries/);
  assert.match(container.innerHTML, /Send each army to the Frontier/);
  assert.match(container.innerHTML, /deployment-preview-label">Constantinople/);
  assert.match(container.innerHTML, /deployment-preview-label">Dismissed/);
  assert.match(container.innerHTML, /Coup: who do you back for the throne\?/);
  // A new draft backs the dynasty itself first.
  assert.match(container.innerHTML, /data-coup-choice="0" data-coup-candidate="0" aria-pressed="true"/);
  assert.match(container.innerHTML, /data-coup-choice="1" data-coup-candidate="1" aria-pressed="false"/);
  assert.match(container.innerHTML, /Theodosian Walls/);
  assert.match(container.innerHTML, /Patriarch&#39;s influence/);
  assert.match(container.innerHTML, /follows the choices of the Patriarch/);
  assert.doesNotMatch(container.innerHTML, /ranking|Capital|Mercs|Funding/);
  assert.match(container.innerHTML, /Lock Deployment/);
});

test('fresh deployment panel defaults funding and requires only a destination', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.players[state.basileusId].gold = 1;
  state.currentTroops = {
    BASILEUS: 2,
  };
  const container = makePanelContainer();

  renderOrdersPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /army-card unresolved/);
  assert.match(container.innerHTML, /data-funded-readout="BASILEUS"[^>]*>1</);
  assert.match(container.innerHTML, /Fielded: 1 of 2/);
  assert.doesNotMatch(container.innerHTML, /Move slider/);
  assert.doesNotMatch(container.innerHTML, /class="candidate-row selected/);
  assert.match(container.innerHTML, /Finish Deployment/);
  assert.match(container.innerHTML, /btn-primary btn-commit" data-action="lock-orders" disabled/);
});

test('deployment panel can lock after destination without touching funding slider', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.players[state.basileusId].gold = 0;
  state.currentTroops = {
    BASILEUS: 3,
  };
  const container = makePanelContainer();
  const uiState = createDefaultUiState();
  uiState.drafts[`deployment:${state.round}:${state.basileusId}`] = {
    armies: {
      BASILEUS: { destination: 'capital' },
    },
    mercenaries: { count: 0, destination: null },
  };

  renderOrdersPanel(container, state, state.basileusId, {}, { uiState });

  assert.match(container.innerHTML, /data-funded-readout="BASILEUS"[^>]*>2</);
  assert.match(container.innerHTML, /value="2" data-army-funded="BASILEUS"/);
  assert.match(container.innerHTML, /btn-primary btn-commit" data-action="lock-orders" >Lock Deployment/);
});

test("the Patriarch sees their influence follow their coup choices", () => {
  const state = makeState();
  state.phase = 'deployment';
  state.currentTroops = {
    DOM_EAST: 2,
  };
  const container = makePanelContainer();
  const uiState = createDefaultUiState();
  uiState.drafts[`deployment:${state.round}:1`] = {
    armies: {
      DOM_EAST: { funded: 2, destination: 'capital' },
    },
    mercenaries: { count: 0, destination: null },
    coupChoices: [2, 1],
  };

  renderOrdersPanel(container, state, 1, {}, { uiState });

  const influence = BALANCE.PATRIARCH_INFLUENCE;
  const name = playerDisplayLabel(state.players[2]);
  assert.match(container.innerHTML, /follows your choices/);
  assert.match(container.innerHTML, /data-coup-choice="0" data-coup-candidate="2" aria-pressed="true"/);
  assert.match(container.innerHTML, /data-coup-choice="1" data-coup-candidate="1" aria-pressed="true"/);
  assert.equal(
    container.innerHTML.includes(`You back ${name} with ${formatHalves(2 + influence)} and yourself with ${formatHalves((2 + influence) / 2)}.`),
    true,
  );
});

test('coup choices: first and second are set, swapped and cleared like two radio columns', () => {
  const state = makeState();
  const draft = { coupChoices: [0] };
  const steps = [[2, 1, [0, 2]], [3, 0, [3, 2]], [2, 0, [2, 3]], [3, 1, [2]], [2, 0, []], [1, 1, [1]]];
  for (const [candidateId, index, expected] of steps) {
    toggleCoupChoice(state, draft, candidateId, index);
    assert.deepEqual(draft.coupChoices, expected, `${candidateId} as choice ${index + 1}`);
  }
  const locked = { coupChoices: [0, 2] };
  assert.equal(toggleCoupChoice(state, locked, 2, 1, 2), false);
  assert.deepEqual(locked.coupChoices, [0, 2]);
});

test('deployment panel bundles strategos commands and does not require idle mercenary destination', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.themes.OPS.strategos = 1;
  state.themes.KAP.strategos = 1;
  state.currentTroops = {
    STRAT_OPS: 1,
    STRAT_KAP: 2,
  };
  const container = makePanelContainer();
  const uiState = createDefaultUiState();
  uiState.drafts[`deployment:${state.round}:1`] = {
    armies: {
      [STRATEGOS_DEPLOYMENT_ARMY_KEY]: { funded: 3, destination: 'capital' },
    },
    mercenaries: { count: 0, destination: null },
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
    BASILEUS: 2,
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
  assert.match(container.innerHTML, /Coup choice:/);
  assert.match(container.innerHTML, /Deal lock/);
  assert.match(container.innerHTML, /must deploy to Constantinople/);
  assert.match(container.innerHTML, /data-coup-choice="1" data-coup-candidate="2" aria-pressed="true"[^>]*disabled/);
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

test('war resolution lists the strength spent on each province and what was left', () => {
  const state = makeState();
  state.phase = 'resolution';
  for (const theme of Object.values(state.themes)) theme.lost = false;
  state.lastWarResult = resolveInvasion(state, 2, 2 + 2 * BALANCE.PROVINCE_WAR_COST + 1, { route: ['THS', 'STR', 'MAK', 'THR', 'CPL'] });
  state.lastWarResult.contributions = [];
  const container = makePanelContainer();

  renderResolutionPanel(container, state);

  const cost = BALANCE.PROVINCE_WAR_COST;
  assert.match(container.innerHTML, new RegExp(`The invader won by ${2 * cost + 1}`));
  // Every province costs the same: two taken, the third out of reach.
  assert.match(container.innerHTML, new RegExp(`war-ledger-step taken[\\s\\S]*costs ${cost}[\\s\\S]*war-ledger-step taken[\\s\\S]*costs ${cost}[\\s\\S]*war-ledger-step held[\\s\\S]*costs ${cost}`));
  assert.match(container.innerHTML, new RegExp(`The invader spent ${2 * cost} and had 1 left over\\.`));
});

test('estates and deployment show the invasion ladder', () => {
  const state = makeState();
  for (const theme of Object.values(state.themes)) theme.lost = false;
  state.themes.STR.lost = true;
  state.currentInvasion = { id: 'bulgars', name: 'Bulgars', route: ['THS', 'STR', 'MAK', 'CPL'], strength: [4, 6], reach: 2, drawnRound: 1 };
  state.phase = 'deployment';
  state.currentTroops = { BASILEUS: 2 };
  const container = makePanelContainer();

  renderOrdersPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });

  assert.match(container.innerHTML, /data-invasion-card/);
  assert.match(container.innerHTML, /Strength[\s\S]*4–6/);
  // Each step shows its own cost; Constantinople adds the Walls.
  const cost = BALANCE.PROVINCE_WAR_COST;
  const walls = BALANCE.THEODOSIAN_WALLS;
  assert.match(container.innerHTML, new RegExp(`data-ladder-step="THS"[\\s\\S]*\\+${cost}</span>[\\s\\S]*data-ladder-step="STR"[\\s\\S]*>lost</span>[\\s\\S]*data-ladder-step="MAK"[\\s\\S]*\\+${cost}</span>[\\s\\S]*data-ladder-step="CPL"[\\s\\S]*\\+${cost + walls} \\(Theodosian Walls ${walls}\\)</span>`));
  assert.match(container.innerHTML, new RegExp(`${BALANCE.INVASION_STRENGTH_PER_PROVINCE} × 2 imperial provinces on its route \\+ ${BALANCE.INVASION_STRENGTH_PER_ROUND} × round 1`));
  // Strength 4: a lead of 3 takes Thessalonike, so 2 troops hold everything;
  // Constantinople is beyond its reach.
  assert.match(container.innerHTML, /Hold every province: <strong>[\s\S]*?2[\s\S]*?<\/strong>/);
  assert.match(container.innerHTML, /Constantinople is out of its reach/);
  assert.doesNotMatch(container.innerHTML, /Save Constantinople:/);
  assert.match(container.innerHTML, /retakes lost provinces on the route/);

  // A stronger invasion can reach it.
  state.currentInvasion = { ...state.currentInvasion, strength: [20, 20] };
  renderOrdersPanel(container, state, state.basileusId, {}, { uiState: createDefaultUiState() });
  assert.match(container.innerHTML, /Save Constantinople:/);
});

test('coup resolution shows each claimant\'s support by source', () => {
  const state = makeState();
  state.phase = 'resolution';
  state.lastCoupResult = {
    winner: 2,
    votes: { 0: 4, 2: 5.5 },
    contributions: [
      { playerId: 0, candidateId: 2, troops: 3, votes: 3, choice: 1, weight: 1, source: 'troops' },
      { playerId: 1, candidateId: 2, troops: 2.5, votes: 2.5, choice: 2, weight: 0.5, source: 'patriarch', passive: true, supportLabel: "Patriarch's influence" },
      { playerId: 0, candidateId: 0, troops: 5, votes: 5, choice: 0, weight: 1, source: 'walls', passive: true, supportLabel: 'Theodosian Walls' },
      { playerId: 0, candidateId: 0, troops: -1, votes: -1, choice: 0, weight: 1, source: 'unrest', passive: true, supportLabel: 'Unrest' },
    ],
    ballots: [
      { playerId: 0, candidateId: 2, coupChoices: [2], troops: 3 },
      { playerId: 3, candidateId: 3, coupChoices: [3], troops: 0 },
    ],
  };
  const container = makePanelContainer();

  renderResolutionPanel(container, state);

  assert.match(container.innerHTML, /Coup/);
  assert.match(container.innerHTML, /vote-supporters/);
  assert.match(container.innerHTML, /troops <span class="vote-choice">\(1st\)/);
  assert.match(container.innerHTML, /Patriarch&#39;s influence of[\s\S]*\(2nd, half\)/);
  assert.match(container.innerHTML, /Theodosian Walls/);
  assert.match(container.innerHTML, /Unrest/);
  assert.match(container.innerHTML, /5½/);
  assert.match(container.innerHTML, /No troops in Constantinople from/);
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
      coupChoices: [2, 0],
      mercenaries: { count: 0, destination: null },
      offices: [{ officeKey: 'BASILEUS', totalTroops: 3, fundedTroops: 3, unfundedTroops: 0, capitalTroops: 3, frontierTroops: 0, destination: 'capital' }],
    },
  });
  const container = makePanelContainer();

  renderResolutionPanel(container, state);

  assert.match(container.innerHTML, /<details class="deployment-reveal-details">/);
  assert.equal(container.innerHTML.indexOf('Coup') < container.innerHTML.indexOf('Deployment Details'), true);
  assert.match(container.innerHTML, /Coup 1st[\s\S]*2nd/);
  assert.match(container.innerHTML, /Fielded/);
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
  assert.equal(shell.continueButton.textContent, 'Balance of Power');
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
  assert.match(panel.innerHTML, />Deployment</);
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

  assert.match(html, /Balance of Power/);
  assert.match(html, /Highest point total wins/);
  assert.match(html, /Each 10% share/);
  assert.match(html, /estate income/);
  assert.match(html, /office income/i);
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

  assert.match(html, /Balance of Power/);
  assert.match(html, /Empire Fallen/);
  assert.match(html, /Everyone lost/);
  assert.match(html, /strongest position/);
  assert.match(html, /score-row\s+top-score/);
  assert.match(html, /Top score, rank/);
  assert.doesNotMatch(html, /Highest point total wins/);
  assert.doesNotMatch(html, /Winner, rank/);
  assert.doesNotMatch(html, /score-row\s+winner/);
});

function openCourt(state) {
  state.phase = 'court';
  state.courtActions = {
    actionUsed: {},
    powerUsed: {},
    appointedThisTurn: {},
    revokedThisTurn: {},
    playerConfirmed: new Set(),
  };
}

test('the map popover plans a revocation into the same plan as the Offices panel', () => {
  const state = makeState();
  openCourt(state);
  addEstates(state.themes.KAP, 1, 3);
  addEstates(state.themes.KAP, 2, 1);
  const uiState = createDefaultUiState();

  const { options } = getProvinceCourtOptions(state, 0, 'KAP', uiState);
  const estates = options.filter((option) => option.kind === 'estate');
  assert.deepEqual(estates.map((option) => option.holderId).sort(), [1, 2]);
  assert.ok(estates.every((option) => option.powerKey === 'BASILEUS' && option.mode === 'bound' && !option.plannedAction));

  const target = estates.find((option) => option.holderId === 1);
  assert.equal(toggleProvinceRevocation(state, 0, uiState, target.powerKey, target.revokeValue), true);
  const after = getProvinceCourtOptions(state, 0, 'KAP', uiState).options.find((option) => option.holderId === 1);
  assert.equal(after.plannedAction?.value, 'estates:KAP:1');

  const container = makePanelContainer();
  renderCourtPanel(container, state, 0, {}, { uiState });
  assert.match(container.innerHTML, /1 planned action/);

  toggleProvinceRevocation(state, 0, uiState, target.powerKey, target.revokeValue);
  assert.equal(getProvinceCourtOptions(state, 0, 'KAP', uiState).options.find((option) => option.holderId === 1).plannedAction, null);
});

test('the map popover offers an open seat to every legal appointee', () => {
  const state = makeState();
  openCourt(state);
  const theme = Object.values(state.themes).find((entry) => entry.region === 'east' && entry.id !== 'CPL' && !entry.lost && entry.strategos == null);
  const uiState = createDefaultUiState();

  const open = getProvinceCourtOptions(state, 1, theme.id, uiState).options.find((option) => option.mode === 'open' && option.kind === 'strategos');
  assert.ok(open, 'the Domestic of the East can fill the seat');
  assert.equal(open.powerKey, 'DOM_EAST');
  const legal = open.appointees.filter((entry) => !entry.disabledReason).map((entry) => entry.playerId);
  assert.ok(legal.length > 0);

  assert.equal(planProvinceAppointment(state, 1, uiState, open.powerKey, 'strategos', theme.id, legal[0]), true);
  const planned = getProvinceCourtOptions(state, 1, theme.id, uiState).options.find((option) => option.kind === 'strategos');
  assert.equal(planned.plannedAction?.appointeeId, legal[0]);
  assert.ok(planned.plannedKey);
});

test('nothing is offered on the map once a dynasty has locked its offices', () => {
  const state = makeState();
  openCourt(state);
  addEstates(state.themes.KAP, 1, 3);
  state.courtActions.playerConfirmed.add(0);
  assert.deepEqual(getProvinceCourtOptions(state, 0, 'KAP', createDefaultUiState()).options, []);
});

test('the estate popover edits the Estates panel plan', () => {
  const state = makeState();
  phaseEstates(state);
  state.players[1].gold = BALANCE.ESTATE_PRICE * 2;
  const uiState = createDefaultUiState();
  assert.equal(addEstateToDraft(uiState, state, 1, 'KAP'), true);
  assert.equal(addEstateToDraft(uiState, state, 1, 'KAP'), true);
  assert.equal(addEstateToDraft(uiState, state, 1, 'KAP'), false, 'not enough gold for a third');
  assert.equal(removeEstateFromDraft(uiState, state, 1, 'KAP'), true);
  assert.deepEqual(getEstateDraft(uiState, state, 1).plan, { KAP: 1 });
});
