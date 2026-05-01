import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVINCES } from '../data/provinces.js';
import { createGameState } from './state.js';
import { runAdministration } from './cascade.js';
import { grantTaxExemption, hireMercenaries } from './actions.js';
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
    G: source.G,
    L: source.L,
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

test('province table matches the new economy constraints', () => {
  const expected = {
    OPS: [4, 1],
    ANT: [4, 1],
    KOL: [1, 4],
    THS: [4, 1],
    AEG: [2, 3],
    KYP: [4, 1],
    CPL: [0, 0],
  };

  for (const [id, [gold, levies]] of Object.entries(expected)) {
    const theme = province(id);
    assert.ok(theme, `Missing province ${id}.`);
    assert.equal(theme.G, gold, `${id} gold mismatch.`);
    assert.equal(theme.L, levies, `${id} levy mismatch.`);
  }

  for (const theme of PROVINCES) {
    if (theme.id === 'CPL') {
      assert.equal(theme.G, 0);
      assert.equal(theme.L, 0);
      continue;
    }

    assert.equal(theme.G + theme.L, 5, `${theme.id} should total 5.`);
    assert.ok(theme.G >= 1 && theme.G <= 4, `${theme.id} gold should be between 1 and 4.`);
    assert.ok(theme.L >= 1 && theme.L <= 4, `${theme.id} levy should be between 1 and 4.`);
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

  assert.equal(getThemeLandPrice(anti), 8);
  assert.equal(getTaxExemptionCost(anti), 8);
  assert.equal(getNormalOwnerIncome(anti), 2);
  assert.equal(getNormalTaxIncome(anti), 2);

  assert.equal(getThemeLandPrice(kol), 2);
  assert.equal(getNormalOwnerIncome(kol), 1);
  assert.equal(getNormalTaxIncome(kol), 0);

  assert.equal(getThemeLandPrice(sam), 4);
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
  assert.equal(kolAdmin.levies.STRAT_KOL, 4);

  const samState = makeState([
    makeTheme('SAM', { owner: 1, strategos: 2 }),
  ]);
  const samAdmin = runAdministration(samState);
  assert.equal(samAdmin.income[1], 1);
  assert.equal(samAdmin.income[2], 1);
  assert.equal(samAdmin.levies.STRAT_SAM, 3);
});

test('church land sends full gold to the church cascade and yields no levy', () => {
  const state = makeState(
    [makeTheme('KYP', { owner: 'church', bishop: 2 })],
    {
      2: { majorTitles: ['PATRIARCH'] },
    },
  );
  const admin = runAdministration(state);
  assert.equal(admin.income[2], 4);
  assert.deepEqual(admin.levies, {});
});

test('tax exemption costs 2G, pays the Basileus, and grants full owner income', () => {
  const state = makeState(
    [makeTheme('ANT', { owner: 1 })],
    {
      1: { gold: 12 },
    },
  );

  const result = grantTaxExemption(state, 1, 'ANT');
  assert.equal(result.ok, true);
  assert.equal(result.cost, 8);
  assert.equal(state.players[1].gold, 4);
  assert.equal(state.players[0].gold, 8);
  assert.equal(state.themes.ANT.taxExempt, true);

  const admin = runAdministration(state);
  assert.equal(admin.income[1], 4);
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
