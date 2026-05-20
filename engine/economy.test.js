import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVINCES } from '../data/provinces.js';
import { createGameState, getPlayer, getOfficeHolder } from './state.js';
import { readTroopEntry, runIncome } from './cascade.js';
import { applyInvasionResult } from './combat.js';
import {
  applyCourtAction,
  applyEstateAction,
  confirmEstates,
  submitHumanOrders,
} from './commands.js';
import {
  confirmTitleRedistribution,
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
  const churchThemes = new Set(['KAP', 'ANT', 'THS', 'THR', 'BUL', 'SAM', 'KYP']);

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

test('court actions are role-filtered and one action per player', () => {
  const state = makeState();
  enterCourt(state);

  const badStrategos = applyCourtAction(state, 0, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(badStrategos.ok, false);
  assert.match(badStrategos.reason, /regional Domestic|Admiral/);

  const goodStrategos = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(goodStrategos.ok, true);
  assert.equal(state.themes.OPS.strategos, 2);

  const secondAction = applyCourtAction(state, 1, { action: 'appoint-bishop', themeId: 'KAP', appointeeId: 3 });
  assert.equal(secondAction.ok, false);
  assert.match(secondAction.reason, /already used/);
});

test('patriarch may appoint bishops in occupied original church provinces', () => {
  const state = makeState();
  enterCourt(state);
  state.themes.KAP.occupied = true;

  const result = applyCourtAction(state, 1, { action: 'appoint-bishop', themeId: 'KAP', appointeeId: 2 });

  assert.equal(result.ok, true);
  assert.equal(state.themes.KAP.bishop, 2);
});

test('church gifts inflate church value and consume the donor court action', () => {
  const state = makeState();
  enterCourt(state);
  state.themes.SAM.owner = 2;

  const result = applyCourtAction(state, 2, { action: 'gift', themeId: 'SAM' });

  assert.equal(result.ok, true);
  assert.equal(state.themes.SAM.owner, 'church');
  assert.equal(state.themes.SAM.bishop, 2);
  assert.deepEqual(
    { P: state.themes.SAM.P, T: state.themes.SAM.T, C: state.themes.SAM.C },
    { P: 0, T: 0, C: 3 },
  );
  assert.equal(applyCourtAction(state, 2, { action: 'skip' }).ok, false);
});

test('estates phase stores bids and settles them when deployment opens', () => {
  const state = makeState();
  state.phase = 'estates';
  getPlayer(state, 2).gold = 5;

  const bid = applyEstateAction(state, 2, { action: 'buy', themeId: 'OPS', amount: 2 });
  assert.equal(bid.ok, true);
  assert.equal(getPlayer(state, 2).gold, 3);
  assert.equal(state.landAuctions.OPS.bidderId, 2);

  const result = confirmEstates(state);
  assert.equal(result.ok, true);
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
