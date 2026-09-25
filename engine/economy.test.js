import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DYNASTY_COLORS,
  DYNASTY_PROFILES,
  INVASIONS,
  INVASION_DIFFICULTIES,
  getDynastyColor,
} from '../data/invasions.js';
import { BALANCE, MAP_BALANCE, applyBalanceOverrides, getBalance, resetBalance } from '../data/balance.js';

const {
  EARLY_INVASION_GRACE_ROUNDS,
  INVASION_ESTIMATE_INTERVAL,
  INVASION_STRENGTH_RATIOS,
} = BALANCE;
import { PROVINCES } from '../data/provinces.js';
import {
  createGameState,
  createInvasionInstance,
  makeRng,
  canTriggerInvasion,
  getEmpireProvinceStrength,
  getInvasionStrengthBounds,
  getPlayer,
  getOfficeHolder,
  pickInvasionTemplate,
} from './state.js';
import {
  buildProvinceChurchAttributions,
  buildProvinceEstateAttributions,
  buildProvinceTroopAttributions,
  readTroopCount,
  runIncome,
} from './cascade.js';
import { applyInvasionResult, buildInvasionLadder, buildReconquestLadder, resolveInvasion } from './combat.js';
import { getDismissalGold, getMercenaryCostForCount, getRisingPriceTotal, getRisingStepPrice } from './rules.js';
import { addEstates, getDomainCount, getEstateCount, getEstatePlanCost } from './estates.js';
import { buildPrivateNotifications } from './notifications.js';
import { serializePublicGameState } from './publicState.js';
import {
  buildBalanceOfPower,
  buildFinalScores,
  getScorePointsForShare,
  SCORE_MAX_POINTS_PER_CATEGORY,
  SCORE_SHARE_THRESHOLDS,
} from './scoring.js';
import { STRATEGOS_DEPLOYMENT_ARMY_KEY } from './deployment.js';
import {
  applyCourtAction,
  applyEstateAction,
  confirmEstates,
  submitHumanOrders,
} from './commands.js';
import {
  advanceToNextInteractivePhase,
  completeCourtPhase,
  confirmTitleRedistribution,
  phaseInvasion,
  phaseCleanup,
  phaseCourt,
  phaseEstates,
  phaseResolution,
} from './turnflow.js';
import { addTemporaryCapitalSupport, getCapitalSupportByPlayer, getCapitalSupportEntries } from './capitalSupport.js';
import { normalizeCoupChoices } from './coup.js';
import {
  getCourtPowerActionCount,
  getCourtPowerAppointmentCount,
  getCourtPowerRevocationCount,
  isCourtPowerExhausted,
  isCourtPowerPassed,
  resolveCoup,
  revokeMinorTitle,
  suggestMajorTitleAssignments,
} from './actions.js';

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

test('invasion draw weights match the configured probability table', () => {
  const weights = Object.fromEntries(INVASIONS.map(({ id, drawWeight }) => [id, drawWeight]));

  assert.deepEqual(weights, {
    emirate: 5,
    kievan_rus: 5,
    normans: 5,
    venetians: 5,
    bulgars: 20,
    serbs: 5,
    hungarians: 5,
    turks: 25,
    caliphate: 25,
  });
  assert.equal(Object.values(weights).reduce((sum, weight) => sum + weight, 0), 100);
});

test('dynasty colors are fixed to their family names', () => {
  assert.deepEqual(DYNASTY_PROFILES, [
    { name: 'Phokas', color: DYNASTY_COLORS[0] },
    { name: 'Doukas', color: DYNASTY_COLORS[1] },
    { name: 'Komnenos', color: DYNASTY_COLORS[2] },
    { name: 'Botenaiates', color: DYNASTY_COLORS[3] },
    { name: 'Diogenes', color: DYNASTY_COLORS[4] },
  ]);

  assert.equal(getDynastyColor('Doukas'), DYNASTY_COLORS[1]);
  assert.equal(getDynastyColor('Komnenos'), DYNASTY_COLORS[2]);
  assert.equal(getDynastyColor('Phokas'), DYNASTY_COLORS[0]);
  assert.equal(getDynastyColor('Diogenes'), DYNASTY_COLORS[4]);
  assert.equal(getDynastyColor('Botenaiates'), DYNASTY_COLORS[3]);

  const state = createGameState({ playerCount: 5, deckSize: 1, seed: 123 });
  assert.deepEqual(
    state.players.map(({ dynasty, color }) => ({ name: dynasty, color })),
    DYNASTY_PROFILES.map(({ name, color }) => ({ name, color })),
  );
});

test('invasion picker uses weighted probability bands', () => {
  assert.equal(pickInvasionTemplate(() => 0).id, 'emirate');
  assert.equal(pickInvasionTemplate(() => 0.049999).id, 'emirate');
  assert.equal(pickInvasionTemplate(() => 0.05).id, 'kievan_rus');
  assert.equal(pickInvasionTemplate(() => 0.1).id, 'normans');
  assert.equal(pickInvasionTemplate(() => 0.15).id, 'venetians');
  assert.equal(pickInvasionTemplate(() => 0.2).id, 'bulgars');
  assert.equal(pickInvasionTemplate(() => 0.399999).id, 'bulgars');
  assert.equal(pickInvasionTemplate(() => 0.4).id, 'serbs');
  assert.equal(pickInvasionTemplate(() => 0.45).id, 'hungarians');
  assert.equal(pickInvasionTemplate(() => 0.5).id, 'turks');
  assert.equal(pickInvasionTemplate(() => 0.749999).id, 'turks');
  assert.equal(pickInvasionTemplate(() => 0.75).id, 'caliphate');
  assert.equal(pickInvasionTemplate(() => 0.999999).id, 'caliphate');
});

test('invasion templates carry relative difficulty bands', () => {
  const emirateTemplate = INVASIONS.find((entry) => entry.id === 'emirate');
  const turksTemplate = INVASIONS.find((entry) => entry.id === 'turks');
  const state = makeState();
  const empireStrength = getEmpireProvinceStrength(state);
  const expectedDifficulties = {
    emirate: INVASION_DIFFICULTIES.MEDIUM,
    kievan_rus: INVASION_DIFFICULTIES.EASY,
    normans: INVASION_DIFFICULTIES.MEDIUM,
    venetians: INVASION_DIFFICULTIES.MEDIUM,
    bulgars: INVASION_DIFFICULTIES.MEDIUM,
    serbs: INVASION_DIFFICULTIES.EASY,
    hungarians: INVASION_DIFFICULTIES.MEDIUM,
    turks: INVASION_DIFFICULTIES.HARD,
    caliphate: INVASION_DIFFICULTIES.HARD,
  };

  assert.deepEqual(INVASION_STRENGTH_RATIOS[INVASION_DIFFICULTIES.EASY], [0.5, 0.9]);
  assert.deepEqual(INVASION_STRENGTH_RATIOS[INVASION_DIFFICULTIES.MEDIUM], [0.6, 1]);
  assert.deepEqual(INVASION_STRENGTH_RATIOS[INVASION_DIFFICULTIES.HARD], [0.7, 1.1]);
  for (const template of INVASIONS) {
    const expectedDifficulty = expectedDifficulties[template.id];
    assert.equal(template.difficulty, expectedDifficulty, `${template.id} should use the configured difficulty`);

    const [min, max] = getInvasionStrengthBounds(template, state);
    const [minRatio, maxRatio] = INVASION_STRENGTH_RATIOS[expectedDifficulty];
    const scaled = empireStrength * BALANCE.INVASION_STRENGTH_PER_PROVINCE;
    assert.equal(min, Math.ceil(scaled * minRatio), `${template.id} strength minimum should scale from empire strength`);
    assert.equal(max, Math.floor(scaled * maxRatio), `${template.id} strength maximum should scale from empire strength`);

    const invasion = createInvasionInstance(template, () => 0, state);
    assert.equal(invasion.empireStrength, empireStrength);
    assert.deepEqual(invasion.strengthBounds, [min, max]);
    assert.deepEqual(invasion.strength, [min, Math.min(max, min + INVASION_ESTIMATE_INTERVAL)]);
  }

  state.themes.OPS.lost = true;
  assert.equal(getEmpireProvinceStrength(state), empireStrength - 1);
  const [hardMinRatio, hardMaxRatio] = INVASION_STRENGTH_RATIOS[INVASION_DIFFICULTIES.HARD];
  assert.deepEqual(
    getInvasionStrengthBounds(turksTemplate, state),
    [
      Math.ceil((empireStrength - 1) * BALANCE.INVASION_STRENGTH_PER_PROVINCE * hardMinRatio),
      Math.floor((empireStrength - 1) * BALANCE.INVASION_STRENGTH_PER_PROVINCE * hardMaxRatio),
    ],
  );

  const drawState = makeState();
  drawState.invasionDeck = [turksTemplate];
  drawState.round = EARLY_INVASION_GRACE_ROUNDS;
  drawState.maxRounds = EARLY_INVASION_GRACE_ROUNDS + 1;
  drawState.themes.OPS.lost = true;
  phaseInvasion(drawState);
  assert.equal(drawState.currentInvasion.empireStrength, empireStrength - 1);
  assert.deepEqual(drawState.currentInvasion.strengthBounds, getInvasionStrengthBounds(turksTemplate, drawState));
  assert.equal(emirateTemplate.name, 'Emirate');
  assert.equal(emirateTemplate.objective, 'provinces');
  assert.equal(emirateTemplate.requiresImperialTarget, true);
  assert.deepEqual(emirateTemplate.route, ['SIC', 'ITA', 'KEP', 'KRE', 'KYP']);
});

test('invasions in the early grace rounds strike at most at easy strength', () => {
  const turksTemplate = INVASIONS.find((entry) => entry.id === 'turks');
  const kievTemplate = INVASIONS.find((entry) => entry.id === 'kievan_rus');
  assert.ok(EARLY_INVASION_GRACE_ROUNDS >= 1);

  const early = makeState();
  early.invasionDeck = [turksTemplate];
  phaseInvasion(early);
  assert.equal(early.round, 1);
  assert.equal(early.currentInvasion.difficulty, INVASION_DIFFICULTIES.EASY);
  assert.equal(early.currentInvasion.earlyGrace, true);
  assert.deepEqual(
    early.currentInvasion.strengthBounds,
    getInvasionStrengthBounds({ ...turksTemplate, difficulty: INVASION_DIFFICULTIES.EASY }, early),
  );

  const alreadyEasy = makeState();
  alreadyEasy.invasionDeck = [kievTemplate];
  phaseInvasion(alreadyEasy);
  assert.equal(alreadyEasy.currentInvasion.earlyGrace, undefined);

  const later = makeState();
  later.round = EARLY_INVASION_GRACE_ROUNDS;
  later.maxRounds = EARLY_INVASION_GRACE_ROUNDS + 1;
  later.invasionDeck = [turksTemplate];
  phaseInvasion(later);
  assert.equal(later.currentInvasion.difficulty, INVASION_DIFFICULTIES.HARD);
  assert.equal(later.currentInvasion.earlyGrace, undefined);
});

test('score shares award one point per 10 percent threshold', () => {
  assert.deepEqual(
    SCORE_SHARE_THRESHOLDS.map((threshold) => Math.round(threshold * 100)),
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
  );
  assert.equal(getScorePointsForShare(0.09), 0);
  assert.equal(getScorePointsForShare(0.1), 1);
  assert.equal(getScorePointsForShare(0.25), 2);
  assert.equal(getScorePointsForShare(0.5), 5);
  assert.equal(getScorePointsForShare(1), SCORE_MAX_POINTS_PER_CATEGORY);
});

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

test('income: each office raises its own troops and church gold, nothing is shared out', () => {
  const state = makeState();
  addEstates(state.themes.KAP, 2, 1);
  state.themes.KAP.strategos = 3;
  state.themes.KAP.bishop = 1;
  state.themes.ANT.bishop = 1;
  state.themes.ANT.lost = true;
  const imperial = (region) => Object.values(state.themes)
    .filter((theme) => theme.region === region && theme.id !== 'CPL' && !theme.lost).length;
  const imperialBishoprics = Object.values(state.themes)
    .filter((theme) => theme.id !== 'CPL' && !theme.lost && theme.C > 0).length;

  const result = runIncome(state);

  assert.equal(result.income[2], 1, 'the estate pays its owner');
  assert.equal(readTroopCount(result.troops.STRAT_KAP), 1, 'the Strategos raises its province');
  assert.equal(result.troops.DOM_EAST, imperial('east'), 'the Domestic still raises Kappadokia');
  assert.equal(result.troops.DOM_EAST, 10);
  assert.equal(result.troops.DOM_WEST, imperial('west'));
  assert.equal(result.troops.ADMIRAL, imperial('sea'));
  assert.equal(result.troops.BASILEUS, 9, '27 imperial provinces give the Basileus 9 troops');
  assert.equal(result.incomeBreakdown.church[1], 2 + imperialBishoprics, 'Bishop pay does not reduce the Patriarch');

  const profitRoute = result.flow.sections.find((section) => section.key === 'profit').routes[0];
  assert.deepEqual(profitRoute.recipients, [{ playerId: 2, value: 1 }]);
  const troopRoutes = result.flow.sections.find((section) => section.key === 'troop').routes;
  assert.deepEqual(troopRoutes.find((route) => route.key === 'strategoi').recipients, [{ playerId: 3, value: 1 }]);
  assert.deepEqual(troopRoutes.find((route) => route.key === 'east').offices.map((office) => [office.officeKey, office.playerId, office.value]), [
    ['DOM_EAST', 1, 10],
  ]);
  assert.deepEqual(troopRoutes.find((route) => route.key === 'basileus').recipients, [{ playerId: 0, value: 9 }]);
  const churchRoutes = result.flow.sections.find((section) => section.key === 'church').routes;
  assert.deepEqual(churchRoutes.find((route) => route.key === 'bishops').recipients, [{ playerId: 1, value: 2 }]);
  assert.equal(churchRoutes.find((route) => route.key === 'patriarch').total, imperialBishoprics);
});

test('the Basileus raises 1 troop per 3 imperial provinces, rounded down', () => {
  const state = makeState();
  const startLost = Object.values(state.themes).filter((theme) => theme.lost);
  assert.equal(runIncome(state).troops.BASILEUS, 9);
  const [firstFree] = Object.values(state.themes).filter((theme) => theme.id !== 'CPL' && !theme.lost);
  firstFree.lost = true;
  assert.equal(runIncome(state).troops.BASILEUS, 8, '26 provinces');
  firstFree.lost = false;
  for (const theme of startLost.slice(0, 3)) theme.lost = false;
  assert.equal(runIncome(state).troops.BASILEUS, 10, '30 provinces');
});

test('a lost province keeps its Strategos and estate on record but they stop working', () => {
  const state = makeState();
  addEstates(state.themes.OPS, 2, 1);
  state.themes.OPS.strategos = 3;
  state.themes.OPS.bishop = 2;
  applyInvasionResult(state, { themesLost: ['OPS'], themesRecovered: [], reachedCPL: false });

  assert.equal(state.themes.OPS.lost, true);
  assert.equal(getEstateCount(state.themes.OPS, 2), 1);
  assert.equal(state.themes.OPS.strategos, 3);
  const whileLost = runIncome(state);
  assert.equal(whileLost.income[2] ?? 0, 1, 'only the Bishop is paid while the province is lost');
  assert.equal(whileLost.troops.STRAT_OPS, undefined);

  applyInvasionResult(state, { themesLost: [], themesRecovered: ['OPS'], reachedCPL: false });
  const restored = runIncome(state);
  assert.equal(restored.income[2], 2, 'estate and bishopric pay again');
  assert.equal(restored.troops.STRAT_OPS, 1);
});

test('map filters show only appointed Strategoi and Bishops', () => {
  const state = makeState();
  addEstates(state.themes.OPS, 2, 1);
  state.themes.KAP.strategos = 3;
  state.themes.HEL.bishop = 2;

  const estateAttributions = buildProvinceEstateAttributions(state);
  assert.equal(estateAttributions.OPS.playerId, 2);
  assert.equal(estateAttributions.OPS.mode, 'estate');

  const troopAttributions = buildProvinceTroopAttributions(state);
  assert.deepEqual(Object.keys(troopAttributions), ['KAP']);
  assert.equal(troopAttributions.KAP.playerId, 3);

  const churchAttributions = buildProvinceChurchAttributions(state);
  assert.deepEqual(Object.keys(churchAttributions), ['HEL']);
  assert.equal(churchAttributions.HEL.playerId, 2);
});

test('title redistribution opens court before starting income', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'title_redistribution';
  const assignments = suggestMajorTitleAssignments(state, state.basileusId);

  const result = confirmTitleRedistribution(state, state.basileusId, assignments);

  assert.equal(result.ok, true);
  assert.equal(state.phase, 'court');
  assert.equal(state.startingIncomeResolved, false);
  assert.deepEqual(state.players.map((player) => player.gold), [0, 0, 0, 0]);
  assert.equal(getOfficeHolder(state, 'BASILEUS'), state.basileusId);

  for (const player of state.players) {
    if (state.phase !== 'court' || state.courtActions.playerConfirmed.has(player.id)) continue;
    const skip = applyCourtAction(state, player.id, { action: 'skip' });
    assert.equal(skip.ok, true);
  }
  completeCourtPhase(state);
  assert.equal(state.phase, 'estates');
  assert.equal(state.startingIncomeResolved, true);
  assert.deepEqual(state.players.map((player) => player.gold), [4, 4, 4, 4]);
});

test('opening phase skips title redistribution when no coup replaced the Basileus', () => {
  const state = makeState();

  advanceToNextInteractivePhase(state);

  assert.equal(state.round, 1);
  assert.equal(state.phase, 'court');
  assert.equal(state.majorTitleRedistributionPending, false);
});

test('coup replacement schedules title redistribution before the next court', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'cleanup';
  state.nextBasileusId = 2;

  phaseCleanup(state);

  assert.equal(state.basileusId, 2);
  assert.equal(state.phase, 'cleanup');
  assert.equal(state.majorTitleRedistributionPending, true);

  advanceToNextInteractivePhase(state);

  assert.equal(state.round, 2);
  assert.equal(state.phase, 'title_redistribution');
  assert.equal(state.majorTitleRedistributionPending, true);
});

test('court actions are role-filtered and appointment-capped per major title', () => {
  const state = makeState();
  addEstates(state.themes.SAM, 2, 1);
  enterCourt(state);

  const badStrategos = applyCourtAction(state, 0, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(badStrategos.ok, false);
  assert.match(badStrategos.reason, /regional Domestic|Admiral/);

  const goodStrategos = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(goodStrategos.ok, true);
  assert.equal(state.themes.OPS.strategos, 2);

  const secondStrategos = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPT', appointeeId: 3 });
  assert.equal(secondStrategos.ok, true);
  assert.equal(state.themes.OPT.strategos, 3);

  const sameTitleAction = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'KAP', appointeeId: 0 });
  assert.equal(sameTitleAction.ok, false);
  assert.match(sameTitleAction.reason, /already used 2 appointments/);

  const secondAction = applyCourtAction(state, 1, { action: 'appoint-bishop', themeId: 'KAP', appointeeId: 0 });
  assert.equal(secondAction.ok, true);
  assert.equal(state.themes.KAP.bishop, 0);

  const secondBishop = applyCourtAction(state, 1, { action: 'appoint-bishop', themeId: 'ANT', appointeeId: 2 });
  assert.equal(secondBishop.ok, true);
  assert.equal(state.themes.ANT.bishop, 2);
  assert.equal(state.courtActions.playerConfirmed.has(1), true);
});

test('court powers can mix appointments and revocations while preserving same-title turn locks', () => {
  const state = makeState();
  state.themes.KAP.strategos = 3;
  enterCourt(state);

  const appointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(appointment.ok, true);

  const sameTitleRevocation = applyCourtAction(state, 1, { action: 'revoke', value: 'minor:OPS:strategos' });
  assert.equal(sameTitleRevocation.ok, false);
  assert.match(sameTitleRevocation.reason, /was appointed this round and cannot be revoked/);

  const otherRevocation = applyCourtAction(state, 1, { action: 'revoke', value: 'minor:KAP:strategos' });
  assert.equal(otherRevocation.ok, true);
  assert.equal(state.themes.KAP.strategos, null);

  const thirdAction = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPT', appointeeId: 3 });
  assert.equal(thirdAction.ok, false);
  assert.match(thirdAction.reason, /already used its 2 actions this round/);
});

test('court powers may spend both actions on revocations', () => {
  const state = makeState();
  state.themes.OPS.strategos = 2;
  state.themes.KAP.strategos = 3;
  enterCourt(state);

  const firstRevocation = applyCourtAction(state, 1, { action: 'revoke', value: 'minor:OPS:strategos' });
  assert.equal(firstRevocation.ok, true);
  assert.equal(state.themes.OPS.strategos, null);

  const secondRevocation = applyCourtAction(state, 1, { action: 'revoke', value: 'minor:KAP:strategos' });
  assert.equal(secondRevocation.ok, true);
  assert.equal(state.themes.KAP.strategos, null);

  const appointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPT', appointeeId: 3 });
  assert.equal(appointment.ok, false);
  assert.match(appointment.reason, /already used its 2 actions this round/);
});

test('revocation cooldown unlocks as soon as another target is revoked', () => {
  const state = makeState();
  state.players[1].revocationCooldown = { lastRevokedPlayerId: 2 };
  state.themes.OPS.strategos = 2;
  state.themes.KAP.strategos = 3;
  enterCourt(state);

  const repeatedRevocation = applyCourtAction(state, 1, { action: 'revoke', value: 'minor:OPS:strategos' });
  assert.equal(repeatedRevocation.ok, false);
  assert.match(repeatedRevocation.reason, /twice in a row/);

  const differentRevocation = applyCourtAction(state, 1, { action: 'revoke', value: 'minor:KAP:strategos' });
  assert.equal(differentRevocation.ok, true);

  const unlockedRevocation = applyCourtAction(state, 1, { action: 'revoke', value: 'minor:OPS:strategos' });
  assert.equal(unlockedRevocation.ok, true);
  assert.equal(state.themes.OPS.strategos, null);
});

test('appointment cooldown blocks the last appointee across turns until someone else is appointed', () => {
  const state = makeState();
  state.players[1].appointmentCooldown = { lastAppointeeId: 2 };
  enterCourt(state);

  const repeatedAppointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(repeatedAppointment.ok, false);
  assert.match(repeatedAppointment.reason, /appoint .* twice in a row/);

  const otherAppointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 3 });
  assert.equal(otherAppointment.ok, true);

  const unlockedAppointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPT', appointeeId: 2 });
  assert.equal(unlockedAppointment.ok, true);
  assert.equal(state.themes.OPT.strategos, 2);
});

test('legacy self-appointment cooldown still blocks self until someone else is appointed', () => {
  const state = makeState();
  state.players[1].appointmentCooldown = { selfLocked: true };
  enterCourt(state);

  const repeatedSelfAppointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 1 });
  assert.equal(repeatedSelfAppointment.ok, false);
  assert.match(repeatedSelfAppointment.reason, /appoint yourself twice in a row/);
});

test('the Basileus only revokes estates, up to four times', () => {
  const state = makeState();
  state.themes.OPS.strategos = 1;
  state.themes.CIL.bishop = 2;
  addEstates(state.themes.SAM, 3, 2);
  addEstates(state.themes.ITA, 1, 1);
  addEstates(state.themes.KAP, 2, 1);
  addEstates(state.themes.KAP, 3, 1);
  enterCourt(state);

  const appointment = applyCourtAction(state, 0, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 1 });
  assert.equal(appointment.ok, false);
  assert.equal(state.themes.OPS.strategos, 1);

  const strategosRevocation = applyCourtAction(state, 0, { action: 'revoke', value: 'minor:OPS:strategos' });
  assert.equal(strategosRevocation.ok, false);
  assert.match(strategosRevocation.reason, /Domestic or Admiral/);
  assert.equal(state.themes.OPS.strategos, 1);

  const bishopRevocation = applyCourtAction(state, 0, { action: 'revoke', value: 'minor:CIL:bishop' });
  assert.equal(bishopRevocation.ok, false);
  assert.match(bishopRevocation.reason, /Only the Patriarch/);
  assert.equal(state.themes.CIL.bishop, 2);

  const first = applyCourtAction(state, 0, { action: 'revoke', value: 'estates:SAM:3' });
  assert.equal(first.ok, true);
  assert.equal(getEstateCount(state.themes.SAM, 3), 0, 'one action takes both estates');
  assert.equal(applyCourtAction(state, 0, { action: 'revoke', value: 'estates:ITA:1' }).ok, true);
  assert.equal(applyCourtAction(state, 0, { action: 'revoke', value: 'estates:KAP:2' }).ok, true);
  assert.equal(applyCourtAction(state, 0, { action: 'revoke', value: 'estates:KAP:3' }).ok, true);
  assert.equal(getCourtPowerActionCount(state, 0, 'BASILEUS'), 4);
  assert.equal(getCourtPowerRevocationCount(state, 0, 'BASILEUS'), 4);
  assert.equal(isCourtPowerExhausted(state, 0, 'BASILEUS'), true);
  assert.equal(state.courtActions.playerConfirmed.has(0), true);
});

test('a Basileus with no estates to revoke has nothing to do in the Offices phase', () => {
  const state = makeState();
  state.themes.OPS.strategos = 1;
  enterCourt(state);
  assert.equal(state.courtActions.playerConfirmed.has(0), true);
});

test('court powers can pass remaining appointments and revocations without counting either', () => {
  const state = makeState();
  state.themes.KAP.strategos = 3;
  enterCourt(state);

  const appointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(appointment.ok, true);

  const domesticPass = applyCourtAction(state, 1, { action: 'pass-court-power', powerKey: 'DOM_EAST' });
  assert.equal(domesticPass.ok, true);
  assert.equal(getCourtPowerActionCount(state, 1, 'DOM_EAST'), 1);
  assert.equal(getCourtPowerAppointmentCount(state, 1, 'DOM_EAST'), 1);
  assert.equal(getCourtPowerRevocationCount(state, 1, 'DOM_EAST'), 0);
  assert.equal(isCourtPowerPassed(state, 1, 'DOM_EAST'), true);
  assert.equal(isCourtPowerExhausted(state, 1, 'DOM_EAST'), true);

  const blockedAppointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPT', appointeeId: 3 });
  assert.equal(blockedAppointment.ok, false);
  assert.match(blockedAppointment.reason, /already passed/);

  const patriarchPass = applyCourtAction(state, 1, { action: 'pass-court-power', powerKey: 'PATRIARCH' });
  assert.equal(patriarchPass.ok, true);
  assert.equal(getCourtPowerActionCount(state, 1, 'PATRIARCH'), 0);
  assert.equal(getCourtPowerAppointmentCount(state, 1, 'PATRIARCH'), 0);
  assert.equal(getCourtPowerRevocationCount(state, 1, 'PATRIARCH'), 0);
  assert.equal(isCourtPowerPassed(state, 1, 'PATRIARCH'), true);
  assert.equal(state.courtActions.playerConfirmed.has(1), true);
});

test('patriarch may appoint bishops in lost bishoprics', () => {
  const state = makeState();
  enterCourt(state);
  state.themes.KAP.lost = true;

  const result = applyCourtAction(state, 1, { action: 'appoint-bishop', themeId: 'KAP', appointeeId: 2 });

  assert.equal(result.ok, true);
  assert.equal(state.themes.KAP.bishop, 2);
});

test('one revocation takes all of one dynasty\'s estates in a province, and nothing else', () => {
  const state = makeState();
  addEstates(state.themes.OPS, 2, 3);
  addEstates(state.themes.OPS, 3, 1);
  addEstates(state.themes.SAM, 2, 1);
  state.themes.OPS.strategos = 3;
  state.themes.OPS.bishop = 1;
  getPlayer(state, 2).gold = 4;
  enterCourt(state);

  const result = applyCourtAction(state, 0, { action: 'revoke', value: 'estates:OPS:2' });

  assert.equal(result.ok, true);
  assert.equal(getEstateCount(state.themes.OPS, 2), 0);
  assert.equal(getEstateCount(state.themes.OPS, 3), 1, 'other dynasties keep their estates');
  assert.equal(getEstateCount(state.themes.SAM, 2), 1, 'estates elsewhere are untouched');
  assert.equal(state.themes.OPS.strategos, 3);
  assert.equal(state.themes.OPS.bishop, 1);
  assert.equal(getPlayer(state, 2).gold, 4, 'no refund');
  assert.equal(state.courtActions.revokedThisTurn['estates:OPS:2'], true);
  assert.equal(state.history.find((event) => event.type === 'revoke_estates')?.details?.count, 3);

  state.phase = 'income';
  const ownerNotices = buildPrivateNotifications(state, 2).notifications;
  assert.equal(ownerNotices.find((notice) => notice.kind === 'revocation')?.tone, 'negative');
  assert.equal(buildPrivateNotifications(state, 3).notifications.some((notice) => notice.kind === 'revocation'), false);
});

test('estates built last round can be revoked in the next Offices phase', () => {
  const state = makeState();
  state.round = 1;
  phaseEstates(state);
  getPlayer(state, 2).gold = 20;
  addEstates(state.themes.OPS, 2, 1);

  assert.equal(applyEstateAction(state, 2, { action: 'plan', plan: { OPS: 2 } }).ok, true);
  for (const player of state.players) confirmEstates(state, player.id);
  assert.equal(state.phase, 'deployment');
  assert.equal(getEstateCount(state.themes.OPS, 2), 3);
  assert.equal(getPlayer(state, 2).gold, 20 - getRisingPriceTotal(2));

  state.round = 2;
  enterCourt(state);
  const revoked = applyCourtAction(state, 0, { action: 'revoke', value: 'estates:OPS:2' });
  assert.equal(revoked.ok, true);
  assert.equal(getEstateCount(state.themes.OPS, 2), 0, 'new and old estates go together');
});

test('every three estates of a dynasty in one province form a domain that pays extra', () => {
  const state = makeState();
  const size = BALANCE.ESTATE_DOMAIN_SIZE;
  const bonus = BALANCE.ESTATE_DOMAIN_BONUS;
  addEstates(state.themes.OPS, 2, size - 1);
  addEstates(state.themes.SAM, 2, 1);
  assert.equal(runIncome(state).incomeBreakdown.estate[2], size, 'no domain yet');

  addEstates(state.themes.OPS, 2, size + 1);
  assert.equal(getDomainCount(2 * size), 2);
  assert.equal(runIncome(state).incomeBreakdown.estate[2], 2 * size + 1 + 2 * bonus, 'two domains in Opsikion');

  // Estates of different dynasties never add up to a domain.
  addEstates(state.themes.SAM, 3, size - 1);
  assert.equal(runIncome(state).incomeBreakdown.estate[3], size - 1);

  state.themes.OPS.lost = true;
  assert.equal(runIncome(state).incomeBreakdown.estate[2], 1, 'a lost province pays nothing');
});

test('private notifications cover personal toned chronicle news without turn prompts', () => {
  const state = makeState();
  enterCourt(state);

  assert.equal(buildPrivateNotifications(state, 1).notifications.some((notice) => notice.kind === 'court_action'), false);

  const appointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(appointment.ok, true);
  assert.equal(buildPrivateNotifications(state, 2).notifications.some((notice) => notice.kind === 'appointment'), false);
  state.phase = 'income';
  const appointmentNotice = buildPrivateNotifications(state, 2).notifications.find((notice) => notice.kind === 'appointment');
  assert.equal(appointmentNotice?.tone, 'positive');
  assert.equal(appointmentNotice?.toast, true);
  assert.match(appointmentNotice?.title || '', /appointed strategos/);

  state.phase = 'deployment';
  state.allOrders = {};
  assert.equal(buildPrivateNotifications(state, 0).notifications.some((notice) => notice.kind === 'deployment_orders'), false);
});

test('same-turn office appointments do not block estate revocation', () => {
  const state = makeState();
  addEstates(state.themes.OPS, 2, 1);
  enterCourt(state);

  const appointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 3 });
  assert.equal(appointment.ok, true);

  const result = applyCourtAction(state, 0, { action: 'revoke', value: 'estates:OPS:2' });

  assert.equal(result.ok, true);
  assert.equal(getEstateCount(state.themes.OPS, 2), 0);
  assert.equal(state.themes.OPS.strategos, 3);
});

test('court no longer allows gifting estates', () => {
  const state = makeState();
  enterCourt(state);
  addEstates(state.themes.SAM, 2, 1);

  const result = applyCourtAction(state, 2, { action: 'gift', themeId: 'SAM' });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Unknown office action/);
  assert.equal(getEstateCount(state.themes.SAM, 2), 1);
});

test('estate plans are secret, cost the rising price per dynasty and are built when Deployment opens', () => {
  const state = makeState();
  phaseEstates(state);
  const gold = getRisingPriceTotal(4) - 1;
  getPlayer(state, 2).gold = gold;
  getPlayer(state, 3).gold = getRisingPriceTotal(1);

  const tooMany = applyEstateAction(state, 2, { action: 'plan', plan: { OPS: 4 } });
  assert.equal(tooMany.ok, false, 'four estates cost more than the purse');
  const plan = applyEstateAction(state, 2, { action: 'plan', plan: { OPS: 2, SAM: 1 } });
  assert.equal(plan.ok, true);
  assert.equal(plan.cost, getRisingPriceTotal(3));
  assert.equal(getPlayer(state, 2).gold, gold, 'nothing is paid before Deployment');
  assert.equal(applyEstateAction(state, 3, { action: 'plan', plan: { OPS: 1 } }).ok, true);

  const ready = confirmEstates(state, 2);
  assert.equal(ready.ok, true);
  const unready = confirmEstates(state, 2);
  assert.equal(unready.ok, true);
  assert.equal(state.estatesReady[2], undefined);

  const playerOneView = serializePublicGameState(state, 1);
  const playerTwoView = serializePublicGameState(state, 2);
  assert.deepEqual(playerOneView.estatePlans, {}, 'other dynasties cannot see the plan');
  assert.deepEqual(playerTwoView.estatePlans, { 2: { OPS: 2, SAM: 1 } });

  for (const player of state.players) assert.equal(confirmEstates(state, player.id).ok, true);
  assert.equal(state.phase, 'deployment');
  assert.equal(getEstateCount(state.themes.OPS, 2), 2);
  assert.equal(getEstateCount(state.themes.SAM, 2), 1);
  assert.equal(getEstateCount(state.themes.OPS, 3), 1, 'several dynasties build in one province');
  assert.equal(getPlayer(state, 2).gold, gold - getRisingPriceTotal(3));
  assert.equal(getPlayer(state, 3).gold, 0);
  assert.equal(runIncome(state).incomeBreakdown.estate[2], 3, 'each estate pays 1 gold');
  assert.match(state.history.find((event) => event.type === 'build_estates')?.summary || '', /Opsikion ×2/);
});

test('the estate price starts again each round, and lost provinces take no estates', () => {
  const state = makeState();
  phaseEstates(state);
  getPlayer(state, 2).gold = 20;
  assert.equal(applyEstateAction(state, 2, { action: 'plan', plan: { OPS: 1 } }).ok, true);
  for (const player of state.players) confirmEstates(state, player.id);
  assert.equal(getPlayer(state, 2).gold, 20 - getRisingPriceTotal(1));

  phaseEstates(state);
  assert.equal(applyEstateAction(state, 2, { action: 'plan', plan: { OPS: 1 } }).cost, getRisingPriceTotal(1));
  const lost = applyEstateAction(state, 2, { action: 'plan', plan: { ANT: 1 } });
  assert.equal(lost.ok, false);
  assert.match(lost.reason, /lost/);
});

test('deployment schema funds armies, pays unfunded troops, and stores mercenary orders', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.currentTroops = { BASILEUS: 2 };
  // The dismissed troop's gold helps pay for the mercenaries.
  getPlayer(state, 0).gold = getMercenaryCostForCount(2) - getDismissalGold(1);

  const result = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { funded: 1, destination: 'frontier' } },
    mercenaries: { count: 2, destination: 'capital' },
    coupChoices: [0],
  });

  assert.equal(result.ok, true);
  assert.equal(getPlayer(state, 0).gold, 0);
  assert.deepEqual(state.mercenaryOrders[0], { count: 2, destination: 'capital' });
  assert.equal(state.allOrders[0].armies.BASILEUS.funded, 1);
});

test('deployment defaults army funding when only a destination is chosen', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.currentTroops = { BASILEUS: 3 };
  getPlayer(state, 0).gold = 0;

  const result = submitHumanOrders(state, 0, {
    armies: { BASILEUS: { destination: 'capital' } },
    mercenaries: { count: 0 },
    coupChoices: [0],
  });

  assert.equal(result.ok, true);
  assert.equal(state.allOrders[0].armies.BASILEUS.funded, 2);
  assert.equal(getPlayer(state, 0).gold, 1);
});

test("deployment bundles a player's strategos troops into one army", () => {
  const state = makeState();
  state.phase = 'deployment';
  state.themes.OPS.strategos = 1;
  state.themes.KAP.strategos = 1;
  state.currentTroops = {
    STRAT_OPS: 1,
    STRAT_KAP: 2,
  };
  getPlayer(state, 1).gold = 0;

  const result = submitHumanOrders(state, 1, {
    armies: {
      [STRATEGOS_DEPLOYMENT_ARMY_KEY]: { funded: 2, destination: 'frontier' },
    },
    mercenaries: { count: 0 },
    coupChoices: [1],
  });

  assert.equal(result.ok, true);
  assert.equal(getPlayer(state, 1).gold, 1);
  assert.deepEqual(state.allOrders[1].armies, {
    [STRATEGOS_DEPLOYMENT_ARMY_KEY]: { funded: 2, destination: 'frontier' },
  });
});

// Pins the coup numbers so these tests do not move when the balance does.
function withCoupBalance(fn) {
  applyBalanceOverrides({ THEODOSIAN_WALLS: 5, PATRIARCH_INFLUENCE: 4, COUP_CHOICE_WEIGHTS: [1, 0.5] });
  try {
    fn();
  } finally {
    resetBalance();
  }
}

test('coup choices keep at most two different dynasties, first choice first', () => {
  const state = makeState();
  assert.deepEqual(normalizeCoupChoices(state, [2, 2, 1, 3]), [2, 1]);
  assert.deepEqual(normalizeCoupChoices(state, [9, '', null, 3]), [3]);
  assert.deepEqual(normalizeCoupChoices(state, { coupChoices: [1, 0] }), [1, 0]);
  assert.deepEqual(normalizeCoupChoices(state, null), []);
});

test('orders that never mention the coup back the dynasty itself; an empty list backs nobody', () => {
  const state = makeState();
  state.phase = 'deployment';
  state.currentTroops = {};
  assert.equal(submitHumanOrders(state, 2, { mercenaries: { count: 0 } }).ok, true);
  assert.deepEqual(state.allOrders[2].coupChoices, [2]);
  assert.equal(submitHumanOrders(state, 3, { mercenaries: { count: 0 }, coupChoices: [] }).ok, true);
  assert.deepEqual(state.allOrders[3].coupChoices, []);
});

test('coup: troops give full support to the first choice and half to the second', () => {
  withCoupBalance(() => {
    const state = makeState();
    const result = resolveCoup(state, {
      0: { coupChoices: [0, 2] },
      1: { coupChoices: [3] },
      2: { coupChoices: [2, 3] },
    }, {
      0: 4,
      1: 2,
      2: 3,
    });

    // Player 0: 4 troops + 5 Theodosian Walls. Player 2: 3 own + 2 from player 0's second choice.
    // Player 3: 2 from player 1, 4 from the Patriarch (player 1), 1.5 from player 2's second choice.
    assert.equal(result.votes[0], 9);
    assert.equal(result.votes[2], 5);
    assert.equal(result.votes[3], 7.5);
    assert.equal(result.votes[1] || 0, 0);
    assert.equal(result.winner, 0);
    assert.deepEqual(result.ballots.map((ballot) => ballot.coupChoices), [[0, 2], [3], [2, 3]]);
    assert.deepEqual(result.ballots[0].shares.map((share) => [share.candidateId, share.weight, share.votes]), [
      [0, 1, 4],
      [2, 0.5, 2],
    ]);
  });
});

test("the Patriarch's influence follows the Patriarch's choices; Walls, Triumph and Unrest apply directly", () => {
  withCoupBalance(() => {
    const state = makeState();
    addTemporaryCapitalSupport(state, {
      kind: 'reconquest',
      label: 'Triumph',
      playerId: 2,
      amount: 2,
      activeRound: state.round,
    });
    addTemporaryCapitalSupport(state, {
      kind: 'lost_provinces',
      label: 'Unrest',
      playerId: state.basileusId,
      amount: -1,
      activeRound: state.round,
    });

    const result = resolveCoup(state, {
      1: { coupChoices: [2, 1] },
      2: { coupChoices: [3] },
    }, {
      1: 0,
      2: 0,
    });

    assert.equal(result.votes[0], 4);
    assert.equal(result.votes[2], 6);
    assert.equal(result.votes[1], 2);
    assert.equal(result.votes[3] || 0, 0);
    assert.equal(result.winner, 2);
    const find = (source, candidateId) => result.contributions.filter((entry) => entry.source === source && entry.candidateId === candidateId);
    assert.equal(find('walls', 0)[0]?.supportLabel, 'Theodosian Walls');
    assert.equal(find('walls', 0)[0]?.votes, 5);
    assert.equal(find('unrest', 0)[0]?.votes, -1);
    assert.equal(find('patriarch', 2)[0]?.supportLabel, "Patriarch's influence");
    assert.equal(find('patriarch', 2)[0]?.votes, 4);
    assert.equal(find('patriarch', 1)[0]?.votes, 2);
    assert.equal(find('triumph', 2)[0]?.votes, 2);
    assert.equal(find('triumph', 3).length, 0);
  });
});

test('a Patriarch without orders backs themselves with their influence', () => {
  withCoupBalance(() => {
    const state = makeState();
    const result = resolveCoup(state, {}, {});
    assert.equal(result.votes[1], 4);
    assert.equal(result.votes[0], 5);
    assert.equal(result.winner, 0);
  });
});

test('coup ties break toward the most Patriarchal support before incumbent support', () => {
  withCoupBalance(() => {
    const state = makeState();
    addTemporaryCapitalSupport(state, {
      kind: 'lost_provinces',
      label: 'Unrest',
      playerId: state.basileusId,
      amount: -1,
      activeRound: state.round,
    });

    const result = resolveCoup(state, {
      1: { coupChoices: [2] },
    }, {});

    assert.equal(result.votes[0], 4);
    assert.equal(result.votes[2], 4);
    assert.equal(result.winner, 2);
    assert.equal(result.tieBreak.method, 'patriarch');
    assert.equal(result.tieBreak.patriarchSupport[2], 4);
  });
});

test('nobody backed in the coup leaves the Basileus on the throne', () => {
  const state = makeState();
  state.players[1].majorTitles = ['DOM_EAST'];
  applyBalanceOverrides({ THEODOSIAN_WALLS: 0 });
  try {
    const result = resolveCoup(state, { 0: { coupChoices: [] }, 1: { coupChoices: [] } }, { 0: 3, 1: 3 });
    assert.equal(result.winner, 0);
  } finally {
    resetBalance();
  }
});

test('the invasion ladder costs the rising price per imperial province, crosses lost ones free, and ends at the Walls', () => {
  const state = makeState();
  for (const theme of Object.values(state.themes)) theme.lost = false;
  state.themes.STR.lost = true;
  const ladder = buildInvasionLadder(state, ['CHE', 'PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL']);
  const expected = [];
  let needed = 0;
  let position = 1;
  for (const themeId of ['CHE', 'PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR']) {
    if (themeId === 'STR') {
      expected.push([themeId, 'lost', 0, needed]);
      continue;
    }
    needed += getRisingStepPrice(position);
    expected.push([themeId, 'imperial', getRisingStepPrice(position), needed]);
    position += 1;
  }
  const capitalCost = getRisingStepPrice(position) + BALANCE.THEODOSIAN_WALLS;
  expected.push(['CPL', 'capital', capitalCost, needed + capitalCost]);
  assert.deepEqual(ladder.map((step) => [step.themeId, step.status, step.cost, step.needed]), expected);
  assert.deepEqual(expected.slice(0, 4).map((step) => step[2]), [2, 2, 2, 3], 'the rising price: 2, 2, 2, 3...');
  assert.equal(ladder.at(-1).walls, BALANCE.THEODOSIAN_WALLS, 'the Walls defend Constantinople');

  const back = buildReconquestLadder(state, ['CHE', 'PAR', 'STR', 'MAK', 'CPL'], new Set(['PAR', 'MAK']));
  assert.deepEqual(back.map((step) => [step.themeId, step.status, step.cost, step.needed]), [
    ['MAK', 'lost', getRisingStepPrice(1), getRisingPriceTotal(1)],
    ['STR', 'imperial', 0, getRisingPriceTotal(1)],
    ['PAR', 'lost', getRisingStepPrice(2), getRisingPriceTotal(2)],
    ['CHE', 'imperial', 0, getRisingPriceTotal(2)],
  ]);
});

test('the Theodosian Walls make Constantinople cost the invader more on the Compact map too', () => {
  const state = createGameState({ seed: 4, mapId: 'compact' });
  const ladder = buildInvasionLadder(state, ['BUL', 'THS', 'THR', 'CPL']);
  const capital = ladder.at(-1);
  assert.equal(capital.walls, MAP_BALANCE.compact.THEODOSIAN_WALLS);
  const war = resolveInvasion(state, 0, capital.needed - 1, { route: ['BUL', 'THS', 'THR', 'CPL'] });
  assert.equal(war.reachedCPL, false, 'one short of the Walls holds the city');
  assert.equal(resolveInvasion(state, 0, capital.needed, { route: ['BUL', 'THS', 'THR', 'CPL'] }).reachedCPL, true);
});

test('every war records the strength spent on each province and the strength left over', () => {
  const route = ['CHE', 'PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'];
  const rng = makeRng(99);
  for (let trial = 0; trial < 300; trial += 1) {
    const state = makeState();
    for (const theme of Object.values(state.themes)) theme.lost = theme.id !== 'CPL' && rng() < 0.35;
    const frontier = Math.floor(rng() * 30);
    const strength = Math.floor(rng() * 30);
    const result = resolveInvasion(state, frontier, strength, { route });
    const spent = result.steps.reduce((sum, step) => sum + step.spent, 0);
    assert.equal(result.spent, spent);
    if (result.outcome === 'stalemate') {
      assert.equal(result.steps.length, 0);
      continue;
    }
    assert.equal(result.margin, Math.abs(frontier - strength));
    assert.equal(result.leftover, result.margin - result.spent);
    assert.ok(result.leftover >= 0);
    const stopped = result.steps.find((step) => step.outcome === 'held' || step.outcome === 'out_of_reach');
    if (stopped) assert.ok(stopped.cost > result.leftover, 'the leftover never pays for the next step');
    const won = result.steps.filter((step) => step.outcome === 'taken' || step.outcome === 'retaken').map((step) => step.themeId);
    if (result.outcome === 'defeat') {
      assert.deepEqual(won.filter((id) => id !== 'CPL'), result.themesLost);
      assert.equal(won.includes('CPL'), result.reachedCPL);
    } else {
      assert.deepEqual(won, result.themesRecovered);
    }
  }
});

test('invasion loss keeps holders on record and reconquest gives the province back to them', () => {
  const state = makeState();
  addEstates(state.themes.SAM, 2, 1);
  state.themes.SAM.strategos = 3;
  state.themes.SAM.bishop = 1;

  applyInvasionResult(state, { themesLost: ['SAM'], themesRecovered: [], reachedCPL: false });
  assert.equal(state.themes.SAM.lost, true);
  assert.equal(getEstateCount(state.themes.SAM, 2), 1);
  assert.equal(state.themes.SAM.strategos, 3);
  assert.equal(state.themes.SAM.bishop, 1);

  applyInvasionResult(state, { themesLost: [], themesRecovered: ['SAM'], reachedCPL: false });
  assert.equal(state.themes.SAM.lost, false);
  assert.equal(getEstateCount(state.themes.SAM, 2), 1);
  assert.equal(state.themes.SAM.strategos, 3);
  assert.equal(state.themes.SAM.bishop, 1);
});

test('limited invasions take their target route without toppling the empire', () => {
  const state = makeState();
  addEstates(state.themes.ITA, 2, 1);

  const result = resolveInvasion(state, 0, 6, {
    id: 'limited_test',
    name: 'Limited Test',
    objective: 'provinces',
    requiresImperialTarget: true,
    route: ['ITA'],
  });
  applyInvasionResult(state, result);

  assert.equal(result.reachedCPL, false);
  assert.deepEqual(result.themesLost, ['ITA']);
  assert.equal(state.themes.ITA.lost, true);
  assert.equal(getEstateCount(state.themes.ITA, 2), 1);
  assert.equal(state.gameOver, null);
});

test('limited invasions are skipped when every target province is already lost', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'cleanup';
  state.maxRounds = 3;
  state.invasionDeck = [
    {
      id: 'limited_test',
      name: 'Limited Test',
      objective: 'provinces',
      requiresImperialTarget: true,
      route: ['SAM'],
      strength: [1, 1],
    },
    {
      id: 'capital_test',
      name: 'Capital Test',
      objective: 'capital',
      route: ['OPS', 'CPL'],
      strength: [1, 1],
    },
  ];
  state.themes.SAM.lost = true;

  phaseInvasion(state);

  assert.equal(state.round, 2);
  assert.equal(state.maxRounds, 3);
  assert.equal(state.currentInvasion.id, 'capital_test');
  assert.equal(state.invasionDeck.length, 1);
  assert.notEqual(state.invasionDeck[0].id, 'limited_test');
  assert.equal(canTriggerInvasion(state, state.invasionDeck[0]), true);
  assert.equal(state.log.some((entry) => entry.type === 'invasion_skipped' && entry.invader === 'Limited Test'), true);
  assert.equal(state.history.some((entry) => entry.type === 'invasion_skipped'), true);
});

test('skipped invasions are replaced so every non-final turn draws an invasion', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'cleanup';
  state.maxRounds = 3;
  state.invasionDeck = [
    {
      id: 'limited_test',
      name: 'Limited Test',
      objective: 'provinces',
      requiresImperialTarget: true,
      route: ['SAM'],
      strength: [1, 1],
    },
  ];
  state.themes.SAM.lost = true;

  phaseInvasion(state);

  assert.equal(state.round, 2);
  assert.equal(state.maxRounds, 3);
  assert.notEqual(state.currentInvasion, null);
  assert.notEqual(state.currentInvasion.id, 'limited_test');
  assert.equal(canTriggerInvasion(state, state.currentInvasion), true);
  assert.deepEqual(state.invasionDeck, []);
  assert.equal(state.log.some((entry) => entry.type === 'invasion_skipped' && entry.invader === 'Limited Test'), true);
  assert.equal(state.history.some((entry) => entry.type === 'invasion_skipped'), true);
  assert.equal(state.log.some((entry) => entry.type === 'no_invasion' && entry.round === 2), false);
  assert.equal(state.history.some((entry) => entry.type === 'no_invasion' && entry.round === 2), false);
});

test('empty invasion decks are replenished before non-final turns', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'cleanup';
  state.maxRounds = 3;
  state.invasionDeck = [];

  phaseInvasion(state);

  assert.equal(state.round, 2);
  assert.notEqual(state.currentInvasion, null);
  assert.equal(canTriggerInvasion(state, state.currentInvasion), true);
  assert.equal(state.log.some((entry) => entry.type === 'no_invasion' && entry.round === 2), false);
  assert.equal(state.history.some((entry) => entry.type === 'no_invasion' && entry.round === 2), false);
});

test('reconquered provinces auto-restore and reward the top defender next round', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'deployment';
  state.currentInvasion = { name: 'Raiders', route: ['SAM'], strength: [1, 1] };
  state.themes.SAM.lost = true;
  state.currentTroops = { DOM_WEST: 3 };
  state.allOrders = {
    2: {
      armies: { DOM_WEST: { funded: 3, destination: 'frontier' } },
      mercenaries: { count: 0, destination: 'frontier' },
      coupChoices: [2, 0],
    },
  };
  getPlayer(state, 2).gold = 0;

  phaseResolution(state);

  assert.equal(state.themes.SAM.lost, false);
  assert.equal(getPlayer(state, 2).gold, getRisingPriceTotal(1));
  assert.deepEqual(state.lastWarResult.themesRecovered, ['SAM']);
  assert.equal(state.lastWarResult.reconquestReward.defenderId, 2);
  assert.equal(getCapitalSupportByPlayer(state)[2], undefined);
  assert.equal(getCapitalSupportByPlayer(state)[0], BALANCE.THEODOSIAN_WALLS);
  assert.equal(getCapitalSupportByPlayer(state, 2)[2], getRisingPriceTotal(1));
});

test('repulsed invasions reward the top defender for province wins even without lost provinces', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'deployment';
  state.currentInvasion = { name: 'Raiders', route: ['OPS', 'SAM', 'ITA'], strength: [2, 2] };
  // A lead that pays for two provinces but not three.
  const troops = 2 + getRisingPriceTotal(2);
  state.currentTroops = { DOM_WEST: troops };
  state.allOrders = {
    2: {
      armies: { DOM_WEST: { funded: troops, destination: 'frontier' } },
      mercenaries: { count: 0, destination: 'frontier' },
      coupChoices: [2, 0],
    },
  };
  getPlayer(state, 2).gold = 0;

  phaseResolution(state);

  assert.deepEqual(state.lastWarResult.themesRecovered, []);
  assert.equal(state.lastWarResult.reconquestRewardProvinceCount, 2);
  assert.equal(state.lastWarResult.reconquestReward.rewardProvinceCount, 2);
  assert.deepEqual(state.lastWarResult.reconquestReward.themeIds, []);
  // Two provinces won, at the rising price.
  assert.equal(getPlayer(state, 2).gold, getRisingPriceTotal(2));
  assert.equal(getCapitalSupportByPlayer(state, 2)[2], getRisingPriceTotal(2));
});

test('tied top defenders split reconquest reward with rounded shares', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'deployment';
  state.currentInvasion = { name: 'Raiders', route: ['OPS', 'SAM', 'ITA'], strength: [2, 2] };
  state.themes.OPS.lost = true;
  state.themes.SAM.lost = true;
  state.themes.ITA.lost = true;
  const each = (2 + getRisingPriceTotal(3)) / 2;
  state.currentTroops = {
    DOM_WEST: each,
    ADMIRAL: each,
  };
  state.allOrders = {
    2: {
      armies: { DOM_WEST: { funded: each, destination: 'frontier' } },
      mercenaries: { count: 0, destination: 'frontier' },
      coupChoices: [2, 0],
    },
    3: {
      armies: { ADMIRAL: { funded: each, destination: 'frontier' } },
      mercenaries: { count: 0, destination: 'frontier' },
      coupChoices: [3, 0],
    },
  };
  getPlayer(state, 2).gold = 0;
  getPlayer(state, 3).gold = 0;

  phaseResolution(state);

  assert.equal(state.lastWarResult.themesRecovered.length, 3);
  const goldShare = Math.ceil(getRisingPriceTotal(3) / 2);
  assert.equal(getPlayer(state, 2).gold, goldShare);
  assert.equal(getPlayer(state, 3).gold, goldShare);
  assert.deepEqual(state.lastWarResult.reconquestReward.defenders.map((entry) => entry.defenderId), [2, 3]);
  assert.equal(state.lastWarResult.reconquestReward.gold, goldShare);
  // Three provinces won: gold is split rounding up, Triumph rounding down.
  const triumphShare = Math.floor(getRisingPriceTotal(3) / 2);
  assert.equal(state.lastWarResult.reconquestReward.capitalSupport, triumphShare);
  assert.equal(getCapitalSupportByPlayer(state, 2)[2], triumphShare);
  assert.equal(getCapitalSupportByPlayer(state, 2)[3], triumphShare);
});

test('lost provinces reduce the next round Basileus passive support', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'deployment';
  state.currentInvasion = { name: 'Raiders', route: ['SAM'], strength: [getRisingStepPrice(1), getRisingStepPrice(1)] };
  state.currentTroops = {};
  state.allOrders = {
    0: { armies: {}, mercenaries: { count: 0, destination: 'frontier' }, coupChoices: [0, 1] },
  };

  phaseResolution(state);

  assert.deepEqual(state.lastWarResult.themesLost, ['SAM']);
  assert.equal(getCapitalSupportByPlayer({ ...state, round: 2 })[0], BALANCE.THEODOSIAN_WALLS - BALANCE.UNREST_PER_LOST_PROVINCE);
});

test('lost province unrest follows the basileus who lost provinces through a coup', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'deployment';
  state.currentInvasion = { name: 'Raiders', route: ['SAM'], strength: [getRisingStepPrice(1), getRisingStepPrice(1)] };
  state.currentTroops = {};
  state.mercenaryOrders = {
    2: { count: BALANCE.THEODOSIAN_WALLS + BALANCE.PATRIARCH_INFLUENCE + 1, destination: 'capital' },
  };
  state.allOrders = {
    2: {
      armies: {},
      mercenaries: { count: 0, destination: 'frontier' },
      coupChoices: [2, 1],
    },
  };

  phaseResolution(state);

  assert.equal(state.basileusId, 0);
  assert.equal(state.nextBasileusId, 2);
  assert.deepEqual(state.lastWarResult.themesLost, ['SAM']);
  assert.equal(state.temporaryCapitalSupport.some((entry) => (
    entry.kind === 'lost_provinces'
    && entry.playerId === 0
    && entry.titleKey == null
  )), true);

  phaseCleanup(state);

  assert.equal(state.basileusId, 2);
  const nextRoundSupport = getCapitalSupportByPlayer({ ...state, round: 2 });
  assert.equal(nextRoundSupport[2], BALANCE.THEODOSIAN_WALLS);
  assert.equal(nextRoundSupport[0], -BALANCE.UNREST_PER_LOST_PROVINCE);
});

test('final scoring uses last income phase shares without free citizens', () => {
  const state = makeState();
  for (const player of state.players) player.gold = 0;

  for (const theme of Object.values(state.themes)) {
    if (!theme || theme.id === 'CPL') continue;
    theme.P = 0;
    theme.T = 0;
    theme.C = 0;
    theme.estates = {};
    theme.bishop = null;
    theme.strategos = null;
    theme.lost = false;
  }

  state.themes.OPS.P = 1;
  addEstates(state.themes.OPS, 0, 2);
  state.themes.SAM.P = 1;
  addEstates(state.themes.SAM, 1, 1);
  state.themes.KAP.C = 2;
  state.themes.KAP.bishop = 1;
  state.themes.ANT.C = 6;
  state.themes.ANT.bishop = 2;
  state.themes.MES.C = 4;
  state.themes.AEG.T = 5;
  state.themes.AEG.strategos = 2;
  state.themes.ITA.T = 3;

  state.lastIncome = runIncome(state);
  addEstates(state.themes.OPS, 3, 30);

  const final = buildFinalScores(state);
  const category = (playerId, key) => (
    final.scores.find((score) => score.playerId === playerId)?.categories.find((entry) => entry.key === key)
  );

  assert.equal(category(0, 'estate').value, 2);
  assert.equal(category(1, 'estate').value, 1);
  assert.equal(category(0, 'estate').totalValue, 3);
  // Basileus: 40 imperial provinces -> 13 troops. Domestic of the East and
  // Patriarch: 2 (Bishop of Kappadokia) + 12 (every bishopric). Domestic of
  // the West: 5 (Strategos of the Aegean) + 6 (Bishop of Antiochia). Admiral:
  // 5 + 3 from the sea provinces, Strategos or not.
  assert.equal(category(0, 'office').value, 13);
  assert.equal(category(1, 'office').value, 14);
  assert.equal(category(2, 'office').value, 11);
  assert.equal(category(3, 'office').value, 8);
  assert.equal(category(2, 'office').totalValue, 46);
  assert.equal(category(1, 'church'), undefined);
  assert.equal(category(2, 'strategos'), undefined);

  const balance = buildBalanceOfPower(state);
  assert.equal(balance.categories.some((entry) => entry.slices.some((slice) => slice.kind === 'free')), false);
  // Thirty estates in one province are ten domains.
  const bigHolding = 30 + getDomainCount(30) * BALANCE.ESTATE_DOMAIN_BONUS;
  assert.equal(balance.categories.find((entry) => entry.key === 'estate').total, 3 + bigHolding);
  assert.equal(balance.categories.find((entry) => entry.key === 'estate').slices.find((slice) => slice.playerId === 3).value, bigHolding);
  assert.equal(balance.categories.find((entry) => entry.key === 'office').total, 46);
});

test('empire fall keeps final rankings but awards no winner', () => {
  const state = makeState();
  state.players[0].gold = 20;
  state.players[1].gold = 5;
  state.gameOver = { type: 'fall', message: 'Constantinople has fallen. The Empire is no more. No dynasty wins.' };

  const final = buildFinalScores(state);
  const balance = buildBalanceOfPower(state);

  assert.equal(final.empireFallen, true);
  assert.equal(final.scores[0].playerId, 0);
  assert.equal(final.winners.length, 0);
  assert.equal(balance.empireFallen, true);
  assert.equal(balance.winners.length, 0);
});

test('final phase skips title redistribution when the throne did not change', () => {
  const state = makeState();
  state.round = state.maxRounds;
  state.invasionDeck = [];
  state.phase = 'cleanup';
  state.nextBasileusId = state.basileusId;

  phaseCleanup(state);

  assert.equal(state.basileusId, 0);
  assert.equal(state.phase, 'court');
  assert.equal(state.majorTitleRedistributionPending, false);
  assert.equal(state.finalScoringPending, true);

  for (const player of state.players) {
    if (state.phase !== 'court' || state.courtActions.playerConfirmed.has(player.id)) continue;
    const skip = applyCourtAction(state, player.id, { action: 'skip' });
    assert.equal(skip.ok, true);
  }
  completeCourtPhase(state);
  assert.equal(state.phase, 'scoring');
  assert.equal(state.finalScoringPending, false);
  assert.equal(state.lastIncome.round, state.round);
});

test('coup replacement triggers major title redistribution before final court and income', () => {
  const state = makeState();
  state.round = state.maxRounds;
  state.invasionDeck = [];
  state.phase = 'cleanup';
  state.nextBasileusId = 2;

  phaseCleanup(state);

  assert.equal(state.basileusId, 2);
  assert.equal(state.phase, 'title_redistribution');
  assert.equal(state.majorTitleRedistributionPending, true);
  assert.equal(state.finalScoringPending, true);

  const assignments = suggestMajorTitleAssignments(state, state.basileusId);
  const result = confirmTitleRedistribution(state, state.basileusId, assignments);

  assert.equal(result.ok, true);
  assert.equal(state.phase, 'court');
  assert.equal(state.majorTitleRedistributionPending, false);
  assert.equal(state.finalScoringPending, true);

  for (const player of state.players) {
    if (state.phase !== 'court' || state.courtActions.playerConfirmed.has(player.id)) continue;
    const skip = applyCourtAction(state, player.id, { action: 'skip' });
    assert.equal(skip.ok, true);
  }
  completeCourtPhase(state);
  assert.equal(state.phase, 'scoring');
  assert.equal(state.finalScoringPending, false);
  assert.equal(state.lastIncome.round, state.round);
  assert.ok(state.lastIncome.flow.totals.troop > 0);
});

test('nothing in a lost province can be revoked, and the Basileus is not offered it', () => {
  const state = makeState();
  state.themes.OPS.strategos = 2;
  addEstates(state.themes.OPS, 3, 1);
  state.themes.OPS.lost = true;
  enterCourt(state);

  const revokeStrategos = revokeMinorTitle(state, 'OPS', 'strategos', 1);
  assert.equal(revokeStrategos.ok, false);
  assert.match(revokeStrategos.reason, /lost/);
  const revokeEstate = applyCourtAction(state, 0, { action: 'revoke', value: 'estates:OPS:3' });
  assert.equal(revokeEstate.ok, false);
  assert.equal(state.themes.OPS.strategos, 2);
  assert.equal(getEstateCount(state.themes.OPS, 3), 1);
});

test('a Compact game uses its 21 provinces, invasions and lower numbers', () => {
  const state = createGameState({ playerCount: 5, deckSize: 9, seed: 4, mapId: 'compact' });
  assert.equal(state.mapId, 'compact');
  assert.equal(Object.keys(state.themes).length, 22);
  assert.equal(Object.values(state.themes).filter((theme) => theme.lost).length, 7);
  assert.equal(Object.values(state.themes).filter((theme) => (Number(theme.C) || 0) > 0).length, 7);
  for (const invasion of state.invasionDeck) {
    for (const id of invasion.route) assert.ok(state.themes[id], `${invasion.id} route province ${id}`);
  }
  const balance = getBalance(state);
  assert.equal(balance.THEODOSIAN_WALLS, MAP_BALANCE.compact.THEODOSIAN_WALLS);
  const walls = getCapitalSupportEntries(state).find((entry) => entry.titleKey === 'BASILEUS');
  assert.equal(walls.amount, MAP_BALANCE.compact.THEODOSIAN_WALLS);
  assert.equal(getBalance(createGameState({ seed: 4 })).THEODOSIAN_WALLS, BALANCE.THEODOSIAN_WALLS);
  assert.equal(getEstatePlanCost(2, state), getRisingPriceTotal(2), 'both maps share the rising price');
  assert.equal(serializePublicGameState(state).mapId, 'compact');
});

test('unknown maps fall back to the Classic map', () => {
  const state = createGameState({ seed: 4, mapId: 'atlantis' });
  assert.equal(state.mapId, 'classic');
  assert.equal(Object.keys(state.themes).length, 41);
});
