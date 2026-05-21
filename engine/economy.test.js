import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVINCES } from '../data/provinces.js';
import { createGameState, getPlayer, getOfficeHolder } from './state.js';
import { readTroopEntry, runIncome } from './cascade.js';
import { applyInvasionResult } from './combat.js';
import { buildBalanceOfPower, buildFinalScores } from './scoring.js';
import {
  applyCourtAction,
  applyEstateAction,
  confirmEstates,
  submitHumanOrders,
} from './commands.js';
import {
  confirmTitleRedistribution,
  phaseCleanup,
  phaseCourt,
} from './turnflow.js';
import { suggestMajorTitleAssignments } from './actions.js';

function makeState() {
  const state = createGameState({ playerCount: 4, deckSize: 2, seed: 7, historyEnabled: true });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  for (const player of state.players) player.majorTitles = [];
  state.players[1].majorTitles = ['DOM_EAST', 'PATRIARCH'];
  state.players[2].majorTitles = ['DOM_WEST'];
  state.players[3].majorTitles = ['ADMIRAL'];
  return state;
}

function enterCourt(state) {
  state.phase = 'income';
  phaseCourt(state);
}

test('province table uses profit, troop, and church values with capital excluded', () => {
  const state = makeState();
  const churchThemes = new Set([
    'OPS', 'OPT', 'KAP', 'CIL', 'ANT', 'MES',
    'HEL', 'THS', 'THR', 'BUL',
    'SAM', 'KYP', 'SIC', 'ITA',
  ]);

  for (const province of PROVINCES) {
    const theme = state.themes[province.id];
    if (province.id === 'CPL') {
      assert.equal(Object.hasOwn(theme, 'P'), false);
      assert.equal(Object.hasOwn(theme, 'T'), false);
      assert.equal(Object.hasOwn(theme, 'C'), false);
      assert.deepEqual(theme.origin, { P: 0, T: 0, C: 0 });
      continue;
    }

    assert.equal(theme.P, 1, `${province.id} profit`);
    assert.equal(theme.T, 1, `${province.id} troops`);
    assert.equal(theme.C, churchThemes.has(province.id) ? 1 : 0, `${province.id} church`);
    assert.deepEqual(theme.origin, { P: theme.P, T: theme.T, C: theme.C });
    assert.equal(Object.hasOwn(theme, 'L'), false, `${province.id} should not keep legacy L`);
  }
});

test('income routes estates, bishops, strategos troops, and occupied bishop value', () => {
  const state = makeState();
  state.themes.KAP.owner = 2;
  state.themes.KAP.strategos = 3;
  state.themes.KAP.bishop = 1;
  state.themes.ANT.bishop = 1;
  state.themes.ANT.occupied = true;

  const result = runIncome(state);

  assert.equal(result.income[2], 1);
  assert.equal(result.incomeBreakdown.church[1] >= 2, true);
  assert.deepEqual(readTroopEntry(result.troops.STRAT_KAP), { normal: 1, capitalLocked: 0 });

  const profitRoute = result.flow.sections.find((section) => section.key === 'profit').routes[0];
  assert.equal(profitRoute.total, 1);
  assert.deepEqual(profitRoute.recipients, [{ playerId: 2, value: 1 }]);

  const troopRoutes = result.flow.sections.find((section) => section.key === 'troop').routes;
  const strategoiRoute = troopRoutes.find((route) => route.key === 'strategoi');
  assert.equal(strategoiRoute.total, 1);
  assert.deepEqual(strategoiRoute.recipients, [{ playerId: 3, value: 1 }]);
  const eastPool = troopRoutes.find((route) => route.key === 'east_pool');
  assert.equal(eastPool.total, 9);
  assert.deepEqual(eastPool.offices.map((office) => [office.officeKey, office.playerId, office.value]), [
    ['DOM_EAST', 1, 6],
    ['BASILEUS', 0, 3],
  ]);

  const bishopRoute = result.flow.sections.find((section) => section.key === 'church').routes.find((route) => route.key === 'bishops');
  assert.equal(bishopRoute.total, 2);
  assert.deepEqual(bishopRoute.recipients, [{ playerId: 1, value: 2 }]);
});

test('title redistribution precedes starting income and court', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'title_redistribution';
  const assignments = suggestMajorTitleAssignments(state, state.basileusId);

  const result = confirmTitleRedistribution(state, state.basileusId, assignments);

  assert.equal(result.ok, true);
  assert.equal(state.phase, 'court');
  assert.equal(state.startingIncomeResolved, true);
  assert.deepEqual(state.players.map((player) => player.gold), [4, 4, 4, 4]);
  assert.equal(getOfficeHolder(state, 'BASILEUS'), state.basileusId);
});

test('court actions are role-filtered and one action per major title', () => {
  const state = makeState();
  enterCourt(state);

  const badStrategos = applyCourtAction(state, 0, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(badStrategos.ok, false);
  assert.match(badStrategos.reason, /regional Domestic|Admiral/);

  const goodStrategos = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(goodStrategos.ok, true);
  assert.equal(state.themes.OPS.strategos, 2);

  const sameTitleAction = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPT', appointeeId: 3 });
  assert.equal(sameTitleAction.ok, false);
  assert.match(sameTitleAction.reason, /Domestic of the East already appointed/);

  const secondAction = applyCourtAction(state, 1, { action: 'appoint-bishop', themeId: 'KAP', appointeeId: 3 });
  assert.equal(secondAction.ok, true);
  assert.equal(state.themes.KAP.bishop, 3);
  assert.equal(state.courtActions.playerConfirmed.has(1), true);
});

test('patriarch may appoint bishops in occupied original church provinces', () => {
  const state = makeState();
  enterCourt(state);
  state.themes.KAP.occupied = true;

  const result = applyCourtAction(state, 1, { action: 'appoint-bishop', themeId: 'KAP', appointeeId: 2 });

  assert.equal(result.ok, true);
  assert.equal(state.themes.KAP.bishop, 2);
});

test('court no longer allows gifting private land to the church', () => {
  const state = makeState();
  enterCourt(state);
  state.themes.SAM.owner = 2;

  const result = applyCourtAction(state, 2, { action: 'gift', themeId: 'SAM' });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Unknown court action/);
  assert.equal(state.themes.SAM.owner, 2);
  assert.equal(state.themes.SAM.bishop, null);
  assert.deepEqual(
    { P: state.themes.SAM.P, T: state.themes.SAM.T, C: state.themes.SAM.C },
    { P: 1, T: 1, C: 1 },
  );
});

test('estates phase stores bids and settles them when deployment opens', () => {
  const state = makeState();
  state.phase = 'estates';
  getPlayer(state, 2).gold = 5;

  const bid = applyEstateAction(state, 2, { action: 'buy', themeId: 'OPS', amount: 2 });
  assert.equal(bid.ok, true);
  assert.equal(getPlayer(state, 2).gold, 3);
  assert.equal(state.landAuctions.OPS.bidderId, 2);

  const ready = confirmEstates(state, 2);
  assert.equal(ready.ok, true);
  assert.equal(state.phase, 'estates');
  const unready = confirmEstates(state, 2);
  assert.equal(unready.ok, true);
  assert.equal(state.estatesReady[2], undefined);
  for (const player of state.players) {
    const result = confirmEstates(state, player.id);
    assert.equal(result.ok, true);
  }
  assert.equal(state.phase, 'deployment');
  assert.equal(state.themes.OPS.owner, 2);
});

test('deployment schema funds armies, pays unfunded troops, and stores mercenary orders', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.currentTroops = { BASILEUS: { normal: 2, capitalLocked: 0 } };
  getPlayer(state, 0).gold = 2;

  const result = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { funded: 1, destination: 'frontier' } },
    mercenaries: { count: 2, destination: 'capital' },
    candidate: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(getPlayer(state, 0).gold, 0);
  assert.deepEqual(state.mercenaryOrders[0], { count: 2, destination: 'capital' });
  assert.equal(state.allOrders[0].armies.BASILEUS.funded, 1);
});

test('invasion loss suspends owners and reconquest restores them while bishops remain', () => {
  const state = makeState();
  state.themes.SAM.owner = 2;
  state.themes.SAM.strategos = 3;
  state.themes.SAM.bishop = 1;

  applyInvasionResult(state, { themesLost: ['SAM'], themesRecovered: [], reachedCPL: false });
  assert.equal(state.themes.SAM.occupied, true);
  assert.equal(state.themes.SAM.owner, null);
  assert.equal(state.themes.SAM.suspendedOwner, 2);
  assert.equal(state.themes.SAM.strategos, null);
  assert.equal(state.themes.SAM.bishop, 1);

  applyInvasionResult(state, { themesLost: [], themesRecovered: ['SAM'], reachedCPL: false });
  assert.equal(state.themes.SAM.occupied, false);
  assert.equal(state.themes.SAM.owner, 2);
  assert.equal(state.themes.SAM.suspendedOwner, null);
  assert.equal(state.themes.SAM.bishop, 1);
});

test('final scoring uses last income phase shares without free citizens', () => {
  const state = makeState();
  for (const player of state.players) player.gold = 0;

  for (const theme of Object.values(state.themes)) {
    if (!theme || theme.id === 'CPL') continue;
    theme.P = 0;
    theme.T = 0;
    theme.C = 0;
    theme.owner = null;
    theme.bishop = null;
    theme.strategos = null;
    theme.occupied = false;
  }

  state.themes.OPS.P = 3;
  state.themes.OPS.owner = 0;
  state.themes.SAM.P = 1;
  state.themes.SAM.owner = 1;
  state.themes.KAP.C = 2;
  state.themes.KAP.bishop = 1;
  state.themes.ANT.C = 6;
  state.themes.ANT.bishop = 2;
  state.themes.MES.C = 4;
  state.themes.AEG.T = 5;
  state.themes.AEG.strategos = 2;
  state.themes.ITA.T = 3;

  state.lastIncome = runIncome(state);
  state.themes.OPS.P = 30;
  state.themes.OPS.owner = 3;

  const final = buildFinalScores(state);
  const category = (playerId, key) => (
    final.scores.find((score) => score.playerId === playerId)?.categories.find((entry) => entry.key === key)
  );

  assert.equal(category(0, 'estate').value, 3);
  assert.equal(category(1, 'estate').value, 1);
  assert.equal(category(0, 'estate').totalValue, 4);
  assert.equal(category(1, 'church').value, 6);
  assert.equal(category(2, 'church').value, 6);
  assert.equal(category(2, 'strategos').value, 5);
  assert.equal(category(3, 'strategos').value, 2);
  assert.equal(category(0, 'strategos').value, 1);
  assert.equal(category(2, 'strategos').totalValue, 8);

  const balance = buildBalanceOfPower(state);
  assert.equal(balance.categories.some((entry) => entry.slices.some((slice) => slice.kind === 'free')), false);
  assert.equal(balance.categories.find((entry) => entry.key === 'estate').total, 4);
});

test('final title redistribution triggers one last income phase before scoring', () => {
  const state = makeState();
  state.round = state.maxRounds;
  state.invasionDeck = [];
  state.phase = 'cleanup';
  state.nextBasileusId = 2;

  phaseCleanup(state);

  assert.equal(state.basileusId, 2);
  assert.equal(state.phase, 'title_redistribution');
  assert.equal(state.finalScoringPending, true);

  const assignments = suggestMajorTitleAssignments(state, state.basileusId);
  const result = confirmTitleRedistribution(state, state.basileusId, assignments);

  assert.equal(result.ok, true);
  assert.equal(state.phase, 'scoring');
  assert.equal(state.finalScoringPending, false);
  assert.equal(state.lastIncome.round, state.round);
  assert.ok(state.lastIncome.flow.totals.troop > 0);
});
