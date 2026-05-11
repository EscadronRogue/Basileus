import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVINCES } from '../data/provinces.js';
import { createGameState, makeRng, MERCENARY_COMPANY_KEY, rollInvasionStrength } from './state.js';
import { runAdministration } from './cascade.js';
import { phaseAdministration, phaseCleanup, phaseInvasion, phaseResolution, STARTING_ADMINISTRATION_GOLD } from './turnflow.js';
import {
  appointBishop,
  appointCourtTitle,
  appointStrategos,
  buyTheme,
  canRecruitProfessional,
  grantTaxExemption,
  getNextAppointmentCost,
  hireMercenaries,
  recruitProfessional,
  settleLandAuctions,
} from './actions.js';
import { buildFinalScores } from './scoring.js';
import {
  acceptDealOffer,
  buildOrderLocksForPlayer,
  counterDealOffer,
  refuseDealOffer,
  sendDealOffer,
  setDealParticipantIds,
  startCourtDealRound,
} from './deals.js';
import {
  getMercenaryHireCost,
  getNormalOwnerIncome,
  getNormalTaxIncome,
  getTaxExemptionCost,
  getThemeLandPrice,
} from './rules.js';
import { normalizeHumanOrders } from './orders.js';
import { applyCourtAction, confirmCourt } from './commands.js';
import { handleHumanCourtConfirmation } from './runtime.js';
import { createAIMeta } from '../ai/brain.js';

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
    nextBasileusId: 0,
    empress: null,
    chiefEunuchs: null,
    players,
    themes: Object.fromEntries(themes.map((theme) => [theme.id, theme])),
    currentLevies: {},
    currentMercenaryTroops: {},
    allOrders: {},
    currentInvasion: null,
    invasionDeck: [{ id: 'test-invasion' }],
    maxRounds: 9,
    recruitedThisRound: {},
    pendingTitleReassignment: false,
    lastCoupResult: null,
    lastWarResult: null,
    gameOver: null,
    log: [],
    historyEnabled: false,
    history: [],
  };
}

function setDealHumans(state, humanPlayerIds = [0, 1]) {
  setDealParticipantIds(state, humanPlayerIds);
  return state;
}

function makeDealState(themes = [], playerOverrides = {}, humanPlayerIds = [0, 1]) {
  const state = makeState(themes, playerOverrides);
  setDealHumans(state, humanPlayerIds);
  state.phase = 'court';
  state.courtActions = { playerConfirmed: new Set() };
  state.historyEnabled = true;
  return state;
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


test('settled land auctions reduce provincial levy by 1', () => {
  const state = makeState(
    [makeTheme('SAM')],
    {
      1: { gold: 5 },
    },
  );

  const result = buyTheme(state, 1, 'SAM');
  assert.equal(result.ok, true);
  assert.equal(state.themes.SAM.owner, null);
  assert.equal(state.players[1].gold, 3);
  assert.equal(state.landAuctions.SAM.bidderId, 1);
  assert.equal(state.landAuctions.SAM.amount, 2);

  settleLandAuctions(state);
  assert.equal(state.themes.SAM.owner, 1);
  assert.equal(state.themes.SAM.L, province('SAM').L - 1);
  assert.equal(state.themes.SAM.privateLevyReduced, true);
});

test('land auctions require higher bids, pay immediately, and refund overbid players', () => {
  const state = makeState(
    [makeTheme('SAM')],
    {
      1: { gold: 5 },
      2: { gold: 8 },
    },
  );

  const opening = buyTheme(state, 1, 'SAM', 4);
  assert.equal(opening.ok, true);
  assert.equal(state.players[1].gold, 1);

  const tooLow = buyTheme(state, 2, 'SAM', 4);
  assert.equal(tooLow.ok, false);
  assert.match(tooLow.reason, /higher/i);

  const overbid = buyTheme(state, 2, 'SAM', 6);
  assert.equal(overbid.ok, true);
  assert.equal(state.players[1].gold, 5);
  assert.equal(state.players[2].gold, 2);
  assert.equal(state.landAuctions.SAM.bidderId, 2);
  assert.equal(state.landAuctions.SAM.amount, 6);

  settleLandAuctions(state);
  assert.equal(state.themes.SAM.owner, 2);
  assert.equal(state.landAuctions.SAM, undefined);
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

  const first = hireMercenaries(state, 1, MERCENARY_COMPANY_KEY, 1);
  assert.equal(first.cost, 1);
  assert.equal(state.players[1].gold, 19);

  const second = hireMercenaries(state, 1, MERCENARY_COMPANY_KEY, 2);
  assert.equal(second.cost, 5);
  assert.equal(state.players[1].gold, 14);
  assert.equal(getMercenaryHireCost(0, 3), 6);

  state.round += 1;
  state.currentMercenaryTroops = {};

  const third = hireMercenaries(state, 1, MERCENARY_COMPANY_KEY, 1);
  assert.equal(third.cost, 1);
  assert.equal(state.players[1].gold, 13);
});

test('deal threads support send, counter, refuse, accept, stale revisions, and only one open negotiation per pair', () => {
  const state = makeDealState();

  const firstOffer = sendDealOffer(state, 0, {
    counterpartyId: 1,
    clauses: [
      { kind: 'non_revocation', direction: 'give', durationTurns: 1 },
    ],
  });
  assert.equal(firstOffer.ok, true);
  assert.equal(state.dealThreads.length, 1);
  assert.equal(state.dealThreads[0].status, 'open');

  const duplicateOpenOffer = sendDealOffer(state, 0, {
    counterpartyId: 1,
    clauses: [
      { kind: 'appointment_promise', direction: 'give', appointmentCount: 1 },
    ],
  });
  assert.equal(duplicateOpenOffer.ok, false);
  assert.match(duplicateOpenOffer.reason, /still open/i);

  const counter = counterDealOffer(state, 1, {
    threadId: firstOffer.threadId,
    expectedRevision: 1,
    clauses: [
      { kind: 'appointment_promise', direction: 'ask', appointmentCount: 1 },
    ],
  });
  assert.equal(counter.ok, true);
  assert.equal(counter.revision, 2);
  assert.equal(state.dealThreads[0].awaitingPlayerId, 0);

  const staleAccept = acceptDealOffer(state, 0, {
    threadId: firstOffer.threadId,
    expectedRevision: 1,
  });
  assert.equal(staleAccept.ok, false);
  assert.match(staleAccept.reason, /changed before your action/i);

  const refusal = refuseDealOffer(state, 0, {
    threadId: firstOffer.threadId,
    expectedRevision: 2,
  });
  assert.equal(refusal.ok, true);
  assert.equal(state.dealThreads[0].status, 'refused');

  const reopenedOffer = sendDealOffer(state, 0, {
    counterpartyId: 1,
    expectedRevision: 2,
    clauses: [
      { kind: 'appointment_promise', direction: 'give', appointmentCount: 1 },
    ],
  });
  assert.equal(reopenedOffer.ok, true);
  assert.equal(reopenedOffer.revision, 3);

  const acceptance = acceptDealOffer(state, 1, {
    threadId: reopenedOffer.threadId,
    expectedRevision: 3,
  });
  assert.equal(acceptance.ok, true);
  assert.equal(state.dealThreads[0].status, 'accepted');
  assert.equal(state.activeDealObligations.length, 1);
  assert.equal(state.activeDealObligations[0].kind, 'appointment_promise');
  assert.deepEqual(
    state.dealThreads[0].history.map((entry) => entry.type),
    ['offer_sent', 'offer_countered', 'offer_refused', 'offer_sent', 'offer_accepted'],
  );
});

test('confirming court auto-refuses waiting deals and blocks new incoming offers', () => {
  const state = makeDealState();

  const sent = sendDealOffer(state, 0, {
    counterpartyId: 1,
    clauses: [
      { kind: 'non_revocation', direction: 'give', durationTurns: 1 },
    ],
  });
  assert.equal(sent.ok, true);

  const confirmation = confirmCourt(state, 1);
  assert.equal(confirmation.ok, true);
  assert.equal(state.dealThreads[0].status, 'refused');
  assert.equal(state.dealThreads[0].history.at(-1).type, 'auto_refused');
  assert.equal(state.dealThreads[0].history.at(-1).reason, 'court_confirmed');

  const blocked = sendDealOffer(state, 0, {
    counterpartyId: 1,
    clauses: [
      { kind: 'non_revocation', direction: 'give', durationTurns: 1 },
    ],
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /already confirmed court actions/i);
});

test('accepted gold deals reserve future installments and settle them at later court starts', () => {
  const state = makeDealState(
    [makeTheme('SAM')],
    {
      0: { gold: 5 },
    },
  );

  const sent = sendDealOffer(state, 0, {
    counterpartyId: 1,
    clauses: [
      { kind: 'gold', direction: 'give', amount: 4, durationTurns: 2 },
    ],
  });
  assert.equal(sent.ok, true);

  const accepted = acceptDealOffer(state, 1, {
    threadId: sent.threadId,
    expectedRevision: 1,
  });
  assert.equal(accepted.ok, true);
  assert.equal(state.players[0].gold, 3);
  assert.equal(state.players[1].gold, 2);
  assert.equal(state.reservedGold[0], 2);

  const blockedPurchase = buyTheme(state, 0, 'SAM');
  assert.equal(blockedPurchase.ok, false);
  assert.match(blockedPurchase.reason, /unreserved gold/i);

  state.round = 2;
  const nextCourt = startCourtDealRound(state);
  assert.equal(nextCourt.ok, true);
  assert.equal(state.players[0].gold, 1);
  assert.equal(state.players[1].gold, 4);
  assert.equal(state.reservedGold[0], 0);
  assert.equal(state.activeDealObligations.length, 0);
});

test('accepted estate deals transfer the estate immediately without disturbing its province state', () => {
  const state = makeDealState([
    makeTheme('OPS', {
      owner: 0,
      taxExempt: true,
      strategos: 1,
      bishop: 2,
      privateLevyReduced: true,
    }),
  ]);

  const sent = sendDealOffer(state, 0, {
    counterpartyId: 1,
    clauses: [
      { kind: 'estate', direction: 'give', themeId: 'OPS' },
    ],
  });
  assert.equal(sent.ok, true);

  const accepted = acceptDealOffer(state, 1, {
    threadId: sent.threadId,
    expectedRevision: 1,
  });
  assert.equal(accepted.ok, true);
  assert.equal(state.themes.OPS.owner, 1);
  assert.equal(state.themes.OPS.taxExempt, true);
  assert.equal(state.themes.OPS.strategos, 1);
  assert.equal(state.themes.OPS.bishop, 2);
  assert.equal(state.themes.OPS.privateLevyReduced, true);
  assert.equal(state.activeDealObligations.length, 0);
});

test('appointment promises carry forward until a legal appointment is made to the promised beneficiary', () => {
  const state = makeDealState();

  const sent = sendDealOffer(state, 0, {
    counterpartyId: 1,
    clauses: [
      { kind: 'appointment_promise', direction: 'give', appointmentCount: 1 },
    ],
  });
  assert.equal(sent.ok, true);
  assert.equal(acceptDealOffer(state, 1, { threadId: sent.threadId, expectedRevision: 1 }).ok, true);

  state.round = 3;
  assert.equal(startCourtDealRound(state).ok, true);
  assert.equal(state.activeDealObligations[0].remainingAppointments, 1);

  const wrongAppointee = appointCourtTitle(state, 'EMPRESS', 2);
  assert.equal(wrongAppointee.ok, false);
  assert.match(wrongAppointee.reason, /owes the next legal appointment/i);

  const promisedAppointee = appointCourtTitle(state, 'EMPRESS', 1);
  assert.equal(promisedAppointee.ok, true);
  assert.equal(state.empress, 1);
  assert.equal(state.activeDealObligations.length, 0);
});

test('repeat appointments cost troops only when appointing the same recipient again', () => {
  const state = makeDealState([makeTheme('OPS'), makeTheme('ANT')], {
    0: { professionalArmies: { BASILEUS: 2 } },
  });
  state.currentLevies = { BASILEUS: 1 };

  const firstSelf = appointCourtTitle(state, 'EMPRESS', 0);
  assert.equal(firstSelf.ok, true);
  assert.equal(getNextAppointmentCost(state, 0, 0), 1);
  assert.equal(state.currentLevies.BASILEUS, 1);

  const secondSelf = appointCourtTitle(state, 'CHIEF_EUNUCHS', 0);
  assert.equal(secondSelf.ok, true);
  assert.equal(state.currentLevies.BASILEUS, 0);
  assert.equal(getNextAppointmentCost(state, 0, 0), 2);

  const firstOther = appointStrategos(state, 0, 'OPS', 1);
  assert.equal(firstOther.ok, true);
  assert.equal(getNextAppointmentCost(state, 0, 1), 1);
  assert.equal(state.players[0].professionalArmies.BASILEUS, 2);

  const secondOther = appointBishop(state, 0, 'ANT', 1);
  assert.equal(secondOther.ok, true);
  assert.equal(state.players[0].professionalArmies.BASILEUS, 1);
  assert.equal(state.suspendedProfessionals[0].BASILEUS, 1);
  assert.equal(getNextAppointmentCost(state, 0, 1), 2);
});

test('self appointment promises enforce the promised beneficiary immediately', () => {
  const state = makeDealState();
  state.activeDealObligations = [{
    kind: 'appointment_promise',
    status: 'active',
    giverId: 0,
    receiverId: 0,
    remainingAppointments: 1,
  }];

  const wrongAppointee = appointCourtTitle(state, 'EMPRESS', 1);
  assert.equal(wrongAppointee.ok, false);
  assert.match(wrongAppointee.reason, /owes the next legal appointment/i);

  const selfAppointment = appointCourtTitle(state, 'EMPRESS', 0);
  assert.equal(selfAppointment.ok, true);
  assert.equal(state.activeDealObligations.length, 0);
});

test('final scoring ranks shares across church, estates, taxes, and gold with full tie points', () => {
  const state = makeState([], {
    0: { gold: 5 },
    1: { gold: 5 },
    2: { gold: 1 },
  });

  const finalScores = buildFinalScores(state);
  const byPlayer = Object.fromEntries(finalScores.scores.map((score) => [score.playerId, score]));
  const gold0 = byPlayer[0].categories.find((category) => category.key === 'gold');
  const gold1 = byPlayer[1].categories.find((category) => category.key === 'gold');
  const gold2 = byPlayer[2].categories.find((category) => category.key === 'gold');

  assert.equal(gold0.points, 3);
  assert.equal(gold1.points, 3);
  assert.equal(gold2.points, 1);
  assert.deepEqual(finalScores.winners.map((winner) => winner.playerId).sort(), [0, 1]);
});

test('all-human court advances only after each player confirms', () => {
  const state = makeState([makeTheme('OPS')]);
  state.courtActions = {
    basileusAppointed: true,
    domesticEastAppointed: true,
    domesticWestAppointed: true,
    admiralAppointed: true,
    patriarchAppointed: true,
    basileusRevocationsUsed: 0,
    appointmentsByRecipient: {},
    playerConfirmed: new Set([0, 1]),
  };

  const result = handleHumanCourtConfirmation(state, null, {}, 2);
  assert.equal(result.ok, true);
  assert.equal(state.phase, 'orders');
});

test('court confirmation passes only the confirming players own mandatory appointments', () => {
  const state = makeState([makeTheme('OPS'), makeTheme('THS'), makeTheme('AEG')], {
    0: { majorTitles: ['DOM_EAST'] },
    1: { majorTitles: ['DOM_WEST'] },
    2: { majorTitles: ['PATRIARCH'] },
  });
  state.courtActions = {
    basileusAppointed: false,
    domesticEastAppointed: false,
    domesticWestAppointed: false,
    admiralAppointed: true,
    patriarchAppointed: false,
    basileusRevocationsUsed: 0,
    appointmentsByRecipient: {},
    playerConfirmed: new Set(),
  };

  const result = confirmCourt(state, 0);
  assert.equal(result.ok, true);
  assert.equal(state.courtActions.basileusAppointed, true);
  assert.equal(state.courtActions.domesticEastAppointed, true);
  assert.equal(state.courtActions.domesticWestAppointed, false);
  assert.equal(state.courtActions.patriarchAppointed, false);
  assert.equal(state.courtActions.playerConfirmed.has(0), true);
  assert.equal(state.phase, 'court');
});

test('solo court confirmation can pass without taking optional mandatory actions', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 21 });
  state.phase = 'court';
  state.basileusId = 0;
  state.nextBasileusId = 0;
  state.players.forEach((player) => {
    player.majorTitles = [];
  });
  state.players[1].majorTitles = ['DOM_EAST'];
  state.players[2].majorTitles = ['DOM_WEST', 'PATRIARCH'];
  state.players[3].majorTitles = ['ADMIRAL'];
  state.courtActions = {
    basileusAppointed: false,
    domesticEastAppointed: false,
    domesticWestAppointed: false,
    admiralAppointed: false,
    patriarchAppointed: false,
    basileusRevocationsUsed: 0,
    appointmentsByRecipient: {},
    playerConfirmed: new Set(),
  };
  const aiMeta = createAIMeta(state, { humanPlayerIds: [0] });

  const result = handleHumanCourtConfirmation(state, aiMeta, {}, 0);
  assert.equal(result.ok, true);
  assert.equal(state.phase, 'orders');
});

test('accepted non-revocation promises block Basileus title revocations', () => {
  const state = makeDealState([], {
    0: { professionalArmies: { BASILEUS: 2 } },
    1: { majorTitles: ['DOM_EAST'] },
  });

  const sent = sendDealOffer(state, 0, {
    counterpartyId: 1,
    clauses: [
      { kind: 'non_revocation', direction: 'give', durationTurns: 2 },
    ],
  });
  assert.equal(sent.ok, true);
  assert.equal(acceptDealOffer(state, 1, { threadId: sent.threadId, expectedRevision: 1 }).ok, true);

  const revoke = applyCourtAction(state, 0, {
    action: 'revoke',
    value: 'major:1:DOM_EAST',
  });
  assert.equal(revoke.ok, false);
  assert.match(revoke.reason, /protected by an accepted non-revocation deal/i);
});

test('conflicting troop deals are rejected before they can create incompatible claimant locks', () => {
  const state = makeDealState([], {
    0: {
      majorTitles: ['DOM_EAST'],
      professionalArmies: { BASILEUS: 2, DOM_EAST: 2 },
    },
  });
  state.currentLevies = { BASILEUS: 2, DOM_EAST: 1 };

  const first = sendDealOffer(state, 1, {
    counterpartyId: 0,
    clauses: [
      { kind: 'coup_support', direction: 'ask', troopCount: 2, candidateId: 1, durationTurns: 1 },
    ],
  });
  assert.equal(first.ok, true);
  assert.equal(acceptDealOffer(state, 0, { threadId: first.threadId, expectedRevision: 1 }).ok, true);

  const second = sendDealOffer(state, 1, {
    counterpartyId: 0,
    clauses: [
      { kind: 'coup_support', direction: 'ask', troopCount: 1, candidateId: 2, durationTurns: 1 },
    ],
  });
  assert.equal(second.ok, false);
  assert.match(second.reason, /multiple claimants|another claimant/i);
});

test('deal order locks choose the minimum-overcommit office plan and override conflicting human orders', () => {
  const state = makeDealState([], {
    0: {
      majorTitles: ['DOM_EAST', 'DOM_WEST'],
      professionalArmies: { BASILEUS: 2, DOM_EAST: 2, DOM_WEST: 0 },
    },
  });
  state.currentLevies = { BASILEUS: 2, DOM_EAST: 1, DOM_WEST: 4 };
  state.currentMercenaryTroops = { 0: 3 };

  const sent = sendDealOffer(state, 1, {
    counterpartyId: 0,
    clauses: [
      { kind: 'coup_support', direction: 'ask', troopCount: 3, candidateId: 1, durationTurns: 1 },
      { kind: 'frontier_support', direction: 'ask', troopCount: 3, durationTurns: 1 },
    ],
  });
  assert.equal(sent.ok, true);
  assert.equal(acceptDealOffer(state, 0, { threadId: sent.threadId, expectedRevision: 1 }).ok, true);

  const locks = buildOrderLocksForPlayer(state, 0);
  assert.equal(locks.ok, true);
  assert.equal(locks.candidateId, 1);
  assert.equal(locks.capitalCommitted, 3);
  assert.equal(locks.frontierCommitted, 3);
  assert.deepEqual(
    locks.officeSelections.map((selection) => ({
      officeKey: selection.officeKey,
      destination: selection.destination,
      troops: selection.troops,
    })),
    [
      { officeKey: 'DOM_EAST', destination: 'frontier', troops: 3 },
      { officeKey: MERCENARY_COMPANY_KEY, destination: 'capital', troops: 3 },
    ],
  );

  state.phase = 'orders';
  const normalized = normalizeHumanOrders(state, 0, {
    deployments: {
      BASILEUS: 'frontier',
      DOM_EAST: 'capital',
      DOM_WEST: 'capital',
      [MERCENARY_COMPANY_KEY]: 'frontier',
    },
    candidate: 0,
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.orders.candidate, 1);
  assert.equal(normalized.orders.deployments.DOM_EAST, 'frontier');
  assert.equal(normalized.orders.deployments[MERCENARY_COMPANY_KEY], 'capital');
});

test('secret orders reject mercenary payloads because mercenaries are hired in court', () => {
  const state = makeState([], {
    1: {
      majorTitles: ['DOM_EAST'],
      professionalArmies: { DOM_EAST: 2 },
    },
  });
  state.phase = 'orders';

  const result = normalizeHumanOrders(state, 1, {
    deployments: { DOM_EAST: 'frontier' },
    mercenaries: [{ officeKey: 'DOM_EAST', count: 1 }],
    candidate: 1,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Court/i);
});

test('resolution totals include public mercenary hires and cleanup removes them', () => {
  const state = makeState([], {
    1: {
      majorTitles: ['DOM_EAST'],
      professionalArmies: { DOM_EAST: 2 },
    },
  });
  state.phase = 'orders';
  state.historyEnabled = true;
  state.currentLevies.DOM_EAST = 3;
  state.currentMercenaryTroops[1] = 1;
  state.allOrders[1] = {
    deployments: { DOM_EAST: 'capital', [MERCENARY_COMPANY_KEY]: 'frontier' },
    candidate: 1,
  };

  phaseResolution(state);

  const reveal = state.history.find((entry) => entry.type === 'orders_revealed' && entry.actorId === 1);
  assert.ok(reveal, 'Orders should be revealed during resolution.');
  const office = reveal.details.offices.find((entry) => entry.officeKey === 'DOM_EAST');
  const mercenaryCompany = reveal.details.offices.find((entry) => entry.officeKey === MERCENARY_COMPANY_KEY);
  assert.deepEqual(office, {
    officeKey: 'DOM_EAST',
    officeName: 'Domestic of the East',
    professionalTroops: 2,
    levyTroops: 3,
    mercenaryTroops: 0,
    totalTroops: 5,
    destination: 'capital',
  });
  assert.deepEqual(mercenaryCompany, {
    officeKey: MERCENARY_COMPANY_KEY,
    officeName: 'Mercenary Company',
    professionalTroops: 0,
    levyTroops: 0,
    mercenaryTroops: 1,
    totalTroops: 1,
    destination: 'frontier',
  });
  assert.equal(reveal.details.capitalTroops, 5);
  assert.equal(reveal.details.frontierTroops, 1);

  phaseCleanup(state);
  assert.deepEqual(state.currentMercenaryTroops, {});
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
