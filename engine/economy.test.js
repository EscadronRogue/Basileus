import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVINCES } from '../data/provinces.js';
import { createGameState } from './state.js';
import { runAdministration } from './cascade.js';
import { buyTheme, canRecruitProfessional, grantTaxExemption, hireMercenaries, recruitProfessional } from './actions.js';
import {
  getMercenaryOrderCost,
  getNormalOwnerIncome,
  getNormalTaxIncome,
  getTaxExemptionCost,
  getThemeLandPrice,
} from './rules.js';

function province(id) {
  return PROVINCES.find((entry) => entry.id === id);
}

function makeTheme(id, overrides = {}) {
  const source = province(id);
  return {
    id: source.id,
    name: source.name,
    P: source.P,
    T: source.T,
    L: source.L,
    privateLevyReduced: false,
    region: source.region,
    owner: null,
    occupied: false,
    taxExempt: false,
    strategos: null,
    bishop: null,
    bishopIsDonor: false,
    ...overrides,
  };
}

function makeState(themes, playerOverrides = {}) {
  const players = [0, 1, 2].map((id) => ({
    id,
    dynasty: `Player ${id + 1}`,
    color: '#000000',
    gold: 0,
    majorTitles: [],
    minorTitles: [],
    professionalArmies: {},
    orders: null,
    appointmentCooldown: {},
    ...(playerOverrides[id] || {}),
  }));

  return {
    round: 1,
    phase: 'court',
    basileusId: 0,
    empress: null,
    chiefEunuchs: null,
    players,
    themes: Object.fromEntries(themes.map((theme) => [theme.id, theme])),
    log: [],
    historyEnabled: false,
    history: null,
  };
}

test('province table matches the profit-tax-levy economy constraints', () => {
  const expected = {
    OPS: [2, 2, 1],
    ANT: [2, 2, 1],
    KOL: [1, 0, 3],
    THS: [2, 2, 1],
    AEG: [1, 1, 2],
    KYP: [2, 2, 1],
    CPL: [0, 0, 0],
  };

  for (const [id, [profit, tax, levies]] of Object.entries(expected)) {
    const theme = province(id);
    assert.ok(theme, `Missing province ${id}.`);
    assert.equal(theme.P, profit, `${id} profit mismatch.`);
    assert.equal(theme.T, tax, `${id} tax mismatch.`);
    assert.equal(theme.L, levies, `${id} levy mismatch.`);
  }

  for (const theme of PROVINCES) {
    if (theme.id === 'CPL') {
      assert.equal(theme.P, 0);
      assert.equal(theme.T, 0);
      assert.equal(theme.L, 0);
      continue;
    }

    assert.ok(theme.P >= 1 && theme.P <= 3, `${theme.id} profit should be between 1 and 3.`);
    assert.ok(theme.T >= 0 && theme.T <= 3, `${theme.id} tax should be between 0 and 3.`);
    assert.ok(theme.L >= 1 && theme.L <= 3, `${theme.id} levy should be between 1 and 3.`);
  }
});

test('new games start every dynasty at 0 gold', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  for (const player of state.players) {
    assert.equal(player.gold, 0);
  }
});

test('theme pricing and split-income helpers follow the new rules', () => {
  const anti = province('ANT');
  const kol = province('KOL');
  const sam = province('SAM');

  assert.equal(getThemeLandPrice(anti), 4);
  assert.equal(getTaxExemptionCost(anti), 4);
  assert.equal(getNormalOwnerIncome(anti), 2);
  assert.equal(getNormalTaxIncome(anti), 2);

  assert.equal(getThemeLandPrice(kol), 2);
  assert.equal(getTaxExemptionCost(kol), 0);
  assert.equal(getNormalOwnerIncome(kol), 1);
  assert.equal(getNormalTaxIncome(kol), 0);

  assert.equal(getThemeLandPrice(sam), 2);
  assert.equal(getTaxExemptionCost(sam), 2);
  assert.equal(getNormalOwnerIncome(sam), 1);
  assert.equal(getNormalTaxIncome(sam), 1);
});

test('administration gives strategoi only their own theme tax and levies', () => {
  const antState = makeState([
    makeTheme('ANT', { owner: 1, strategos: 2 }),
  ]);
  const antAdmin = runAdministration(antState);
  assert.equal(antAdmin.income[1], 2);
  assert.equal(antAdmin.income[2], 2);
  assert.equal(antAdmin.levies.STRAT_ANT, 1);
  assert.equal(antAdmin.levies.BASILEUS || 0, 0);

  const kolState = makeState([
    makeTheme('KOL', { owner: 1, strategos: 2 }),
  ]);
  const kolAdmin = runAdministration(kolState);
  assert.equal(kolAdmin.income[1], 1);
  assert.equal(kolAdmin.income[2] || 0, 0);
  assert.equal(kolAdmin.levies.STRAT_KOL, 3);

  const samState = makeState([
    makeTheme('SAM', { owner: 1, strategos: 2 }),
  ]);
  const samAdmin = runAdministration(samState);
  assert.equal(samAdmin.income[1], 1);
  assert.equal(samAdmin.income[2], 1);
  assert.equal(samAdmin.levies.STRAT_SAM, 2);
});

test('church land sends tax to the church cascade and levy to the regional pool', () => {
  const state = makeState(
    [makeTheme('KYP', { owner: 'church', bishop: 2 })],
    {
      2: { majorTitles: ['PATRIARCH'] },
    },
  );
  const admin = runAdministration(state);
  assert.equal(admin.income[2], 2);
  assert.equal(admin.levies.ADMIRAL || 0, 0);
  assert.equal(admin.levies.BASILEUS || 0, 1);
});

test('tax exemption costs 2T, pays the Basileus, and grants profit plus tax to the owner', () => {
  const state = makeState(
    [makeTheme('ANT', { owner: 1 })],
    {
      1: { gold: 12 },
    },
  );

  const result = grantTaxExemption(state, 1, 'ANT');
  assert.equal(result.ok, true);
  assert.equal(result.cost, 4);
  assert.equal(state.players[1].gold, 8);
  assert.equal(state.players[0].gold, 4);
  assert.equal(state.themes.ANT.taxExempt, true);

  const admin = runAdministration(state);
  assert.equal(admin.income[1], 4);
});


test('buying private land reduces provincial levy by 1', () => {
  const state = makeState(
    [makeTheme('SAM')],
    {
      1: { gold: 5 },
    },
  );

  const result = buyTheme(state, 1, 'SAM');
  assert.equal(result.ok, true);
  assert.equal(state.themes.SAM.owner, 1);
  assert.equal(state.themes.SAM.L, 1);
  assert.equal(state.themes.SAM.privateLevyReduced, true);
});

test('major military offices start with 2 professional troops and Patriarch starts with none', () => {
  const state = createGameState({ playerCount: 5, deckSize: 1, seed: 2 });
  for (const player of state.players) {
    if (player.id === state.basileusId) {
      assert.equal(player.professionalArmies.BASILEUS, 2);
    }
    for (const title of player.majorTitles) {
      if (title === 'PATRIARCH') {
        assert.equal(player.professionalArmies.PATRIARCH || 0, 0);
      } else {
        assert.equal(player.professionalArmies[title], 2);
      }
    }
  }
});

test('Patriarch, Empress, and Chief of Eunuchs cannot recruit professional troops', () => {
  const state = makeState([], {
    1: { majorTitles: ['PATRIARCH'] },
  });
  state.empress = 1;
  state.chiefEunuchs = 1;

  for (const officeKey of ['PATRIARCH', 'EMPRESS', 'CHIEF_EUNUCHS']) {
    assert.equal(canRecruitProfessional(state, 1, officeKey).ok, false);
    assert.equal(recruitProfessional(state, 1, officeKey).ok, false);
    assert.equal(state.players[1].professionalArmies[officeKey] || 0, 0);
  }
});

test('all invasion instances use the shared 10-30 strength range', () => {
  const state = createGameState({ playerCount: 4, deckSize: 9, seed: 4 });
  for (const invasion of state.invasionDeck) {
    assert.deepEqual(invasion.strength, [10, 30]);
  }
});

test('mercenary costs ramp within a turn and reset on the next turn', () => {
  const state = makeState([], {
    1: { gold: 20 },
  });

  const first = hireMercenaries(state, 1, 'DOM_EAST', 1);
  assert.equal(first.cost, 1);
  assert.equal(state.players[1].gold, 19);

  const second = hireMercenaries(state, 1, 'DOM_EAST', 2);
  assert.equal(second.cost, 5);
  assert.equal(state.players[1].gold, 14);
  assert.equal(getMercenaryOrderCost([{ officeKey: 'DOM_EAST', count: 3 }]), 6);

  state.round += 1;
  state.mercenariesHiredThisRound = {};

  const third = hireMercenaries(state, 1, 'DOM_EAST', 1);
  assert.equal(third.cost, 1);
  assert.equal(state.players[1].gold, 13);
});

test('the Basileus cannot buy tax exemption for his own estate', () => {
  const state = makeState(
    [makeTheme('OPS', { owner: 0 })],
    {
      0: { gold: 10 },
    },
  );

  const result = grantTaxExemption(state, 0, 'OPS');
  assert.equal(result.ok, false);
  assert.match(result.reason, /Basileus/i);
});
