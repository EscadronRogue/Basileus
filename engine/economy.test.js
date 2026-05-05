import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVINCES } from '../data/provinces.js';
import { createGameState, makeRng, rollInvasionStrength } from './state.js';
import { runAdministration } from './cascade.js';
import { phaseAdministration, phaseInvasion, STARTING_ADMINISTRATION_GOLD } from './turnflow.js';
import {
  appointStrategos,
  buyTheme,
  canRecruitProfessional,
  grantTaxExemption,
  hireMercenaries,
  payMaintenance,
  recruitProfessional,
  restoreSuspendedProfessionals,
  revokeMajorTitle,
  revokeTheme,
} from './actions.js';
import {
  getMercenaryOrderCost,
  getNormalOwnerIncome,
  getNormalTaxIncome,
  getTaxExemptionCost,
  getThemeLandPrice,
} from './rules.js';
import { getAppointmentCost } from './turnCounters.js';

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
    mercenaryArmy: 0,
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
    currentLevies: {},
    suspendedProfessionals: {},
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


test('first administration grants every dynasty the fixed starting gold', () => {
  const state = createGameState({ playerCount: 5, deckSize: 2, seed: 11 });

  phaseInvasion(state);
  const firstAdmin = phaseAdministration(state);

  for (const player of state.players) {
    assert.equal(firstAdmin.income[player.id], STARTING_ADMINISTRATION_GOLD);
    assert.equal(player.gold, STARTING_ADMINISTRATION_GOLD);
  }

  state.phase = 'cleanup';
  phaseInvasion(state);
  const expectedSecondIncome = runAdministration(state).income;
  const secondAdmin = phaseAdministration(state);

  assert.deepEqual(secondAdmin.income, expectedSecondIncome);
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

test('Empress, Patriarch, and Chief of Eunuchs receive 2 free capital levies each turn', () => {
  const state = makeState([], {
    1: { majorTitles: ['PATRIARCH'] },
  });
  state.empress = 2;
  state.chiefEunuchs = 0;

  const firstAdmin = runAdministration(state);
  assert.equal(firstAdmin.levies.EMPRESS, 2);
  assert.equal(firstAdmin.levies.PATRIARCH, 2);
  assert.equal(firstAdmin.levies.CHIEF_EUNUCHS, 2);

  const secondAdmin = runAdministration(state);
  assert.equal(secondAdmin.levies.EMPRESS, 2);
  assert.equal(secondAdmin.levies.PATRIARCH, 2);
  assert.equal(secondAdmin.levies.CHIEF_EUNUCHS, 2);
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

test('invasion estimates stay inside 10-30 with exactly seven points of uncertainty', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const state = createGameState({ playerCount: 4, deckSize: 9, seed });
    for (const invasion of state.invasionDeck) {
      const [minStrength, maxStrength] = invasion.strength;
      assert.ok(minStrength >= 10, `estimate minimum ${minStrength} should be at least 10`);
      assert.ok(maxStrength <= 30, `estimate maximum ${maxStrength} should be at most 30`);
      assert.equal(maxStrength - minStrength, 7, `estimate ${minStrength}-${maxStrength} should span exactly 7`);
    }
  }
});

test('revealed invasion strength is rolled inside the announced estimate', () => {
  const state = createGameState({ playerCount: 4, deckSize: 9, seed: 7 });
  const rng = makeRng(99);

  for (const invasion of state.invasionDeck) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const rolled = rollInvasionStrength(invasion, rng);
      assert.ok(rolled >= invasion.strength[0], `${rolled} should be at least ${invasion.strength[0]}`);
      assert.ok(rolled <= invasion.strength[1], `${rolled} should be at most ${invasion.strength[1]}`);
    }
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

test('appointments use per-title turn counters and altruistic appointments discount self costs', () => {
  const state = makeState(
    [
      makeTheme('OPS', { region: 'east' }),
      makeTheme('ANT', { region: 'east' }),
      makeTheme('KYP', { region: 'east' }),
      makeTheme('AEG', { region: 'east' }),
    ],
    {
      1: { majorTitles: ['DOM_EAST'] },
    },
  );
  state.currentLevies.DOM_EAST = 10;

  const selfFirst = appointStrategos(state, 1, 'OPS', 1);
  assert.equal(selfFirst.ok, true);
  assert.equal(selfFirst.cost, 1);

  const otherFirst = appointStrategos(state, 1, 'ANT', 2);
  assert.equal(otherFirst.ok, true);
  assert.equal(otherFirst.cost, 0);

  const selfSecond = appointStrategos(state, 1, 'KYP', 1);
  assert.equal(selfSecond.ok, true);
  assert.equal(selfSecond.cost, 1);

  const otherSecondSameTarget = appointStrategos(state, 1, 'AEG', 2);
  assert.equal(otherSecondSameTarget.ok, true);
  assert.equal(otherSecondSameTarget.cost, 1);
  assert.equal(state.currentLevies.DOM_EAST, 7);
});

test('appointment counters transfer to a replacement major title during same-turn revocation swaps', () => {
  const state = makeState(
    [makeTheme('OPS', { region: 'east' })],
    {
      1: { majorTitles: ['DOM_EAST'] },
      2: { majorTitles: ['DOM_WEST'] },
    },
  );
  state.currentLevies.DOM_EAST = 4;
  state.currentLevies.BASILEUS = 4;

  assert.equal(appointStrategos(state, 1, 'OPS', 1).cost, 1);
  const revocation = revokeMajorTitle(state, 1, 'DOM_EAST', 2);

  assert.equal(revocation.ok, true);
  assert.deepEqual(state.players[1].majorTitles, ['DOM_WEST']);
  assert.equal(getAppointmentCost(state, 1, 'DOM_WEST', 1), 2);
});

test('self revocations are free and discount later non-self revocations without making them free', () => {
  const state = makeState(
    [
      makeTheme('OPS', { owner: 0 }),
      makeTheme('ANT', { owner: 1 }),
      makeTheme('KYP', { owner: 2 }),
    ],
  );
  state.currentLevies.BASILEUS = 5;

  const own = revokeTheme(state, 'OPS');
  assert.equal(own.ok, true);
  assert.equal(own.cost, 0);

  const firstOther = revokeTheme(state, 'ANT');
  assert.equal(firstOther.ok, true);
  assert.equal(firstOther.cost, 1);

  const secondOther = revokeTheme(state, 'KYP');
  assert.equal(secondOther.ok, true);
  assert.equal(secondOther.cost, 1);
});

test('professional troops spent on appointments stay owed for maintenance and return afterward', () => {
  const state = makeState(
    [makeTheme('OPS', { region: 'east' })],
    {
      1: { gold: 5, majorTitles: ['DOM_EAST'], professionalArmies: { DOM_EAST: 2 } },
    },
  );
  state.currentLevies.DOM_EAST = 0;

  const appointment = appointStrategos(state, 1, 'OPS', 1);
  assert.equal(appointment.ok, true);
  assert.equal(appointment.cost, 1);
  assert.equal(state.players[1].professionalArmies.DOM_EAST, 1);
  assert.equal(state.suspendedProfessionals[1].DOM_EAST, 1);

  const maintenance = payMaintenance(state, 1);
  assert.equal(maintenance.cost, 3);
  assert.equal(state.players[1].gold, 2);

  restoreSuspendedProfessionals(state);
  assert.equal(state.players[1].professionalArmies.DOM_EAST, 2);
  assert.equal(state.players[1].professionalArmies.STRAT_OPS, 1);
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
