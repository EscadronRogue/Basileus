import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DYNASTY_COLORS,
  DYNASTY_PROFILES,
  INVASIONS,
  INVASION_ESTIMATE_INTERVAL,
  getDynastyColor,
} from '../data/invasions.js';
import { PROVINCES } from '../data/provinces.js';
import { createGameState, createInvasionInstance, getPlayer, getOfficeHolder, pickInvasionTemplate } from './state.js';
import { readTroopEntry, runIncome } from './cascade.js';
import { applyInvasionResult, resolveInvasion } from './combat.js';
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
  phaseResolution,
} from './turnflow.js';
import { addTemporaryCapitalSupport, getCapitalSupportByPlayer } from './capitalSupport.js';
import {
  getCourtPowerActionCount,
  getCourtPowerAppointmentCount,
  getCourtPowerRevocationCount,
  isCourtPowerExhausted,
  isCourtPowerPassed,
  resolveCoup,
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

test('invasion templates carry individual strength bounds', () => {
  const emirateTemplate = INVASIONS.find((entry) => entry.id === 'emirate');

  assert.equal(INVASIONS.every(({ strengthBounds }) => Array.isArray(strengthBounds)), true);
  assert.equal(new Set(INVASIONS.map(({ strengthBounds }) => strengthBounds.join('-'))).size > 1, true);
  for (const template of INVASIONS) {
    const [min, max] = template.strengthBounds;
    assert.equal(Number.isInteger(min), true, `${template.id} strength minimum should be an integer`);
    assert.equal(Number.isInteger(max), true, `${template.id} strength maximum should be an integer`);
    assert.equal(min >= 1, true, `${template.id} strength minimum should be positive`);
    assert.equal(max - min >= INVASION_ESTIMATE_INTERVAL, true, `${template.id} strength range should support an estimate interval`);

    const invasion = createInvasionInstance(template, () => 0);
    assert.deepEqual(invasion.baseStrength, template.strengthBounds);
    assert.deepEqual(invasion.strength, [min, min + INVASION_ESTIMATE_INTERVAL]);
  }
  assert.equal(emirateTemplate.name, 'Emirate');
  assert.equal(emirateTemplate.objective, 'provinces');
  assert.equal(emirateTemplate.requiresImperialTarget, true);
  assert.deepEqual(emirateTemplate.route, ['SIC', 'ITA', 'KEP', 'KRE', 'KYP']);
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
  state.themes.SAM.owner = 2;
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

  const secondAction = applyCourtAction(state, 1, { action: 'appoint-bishop', themeId: 'KAP', appointeeId: 3 });
  assert.equal(secondAction.ok, true);
  assert.equal(state.themes.KAP.bishop, 3);

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
  assert.match(sameTitleRevocation.reason, /was appointed this turn and cannot be revoked/);

  const otherRevocation = applyCourtAction(state, 1, { action: 'revoke', value: 'minor:KAP:strategos' });
  assert.equal(otherRevocation.ok, true);
  assert.equal(state.themes.KAP.strategos, null);

  const thirdAction = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPT', appointeeId: 3 });
  assert.equal(thirdAction.ok, false);
  assert.match(thirdAction.reason, /already completed its 2 court actions/);
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
  assert.match(appointment.reason, /already completed its 2 court actions/);
});

test('basileus court power is revocation-only and allows four revocations', () => {
  const state = makeState();
  state.themes.OPS.strategos = 1;
  state.themes.KAP.strategos = 2;
  state.themes.CIL.bishop = 2;
  state.themes.SAM.owner = 3;
  state.themes.ITA.owner = 1;
  enterCourt(state);

  const appointment = applyCourtAction(state, 0, { action: 'basileus-appoint', titleType: 'STRATEGOS', appointeeId: 1 });
  assert.equal(appointment.ok, false);
  assert.match(appointment.reason, /can no longer appoint minor titles/);

  const bishopRevocation = applyCourtAction(state, 0, { action: 'revoke', value: 'minor:CIL:bishop' });
  assert.equal(bishopRevocation.ok, false);
  assert.match(bishopRevocation.reason, /Only the Patriarch/);
  assert.equal(state.themes.CIL.bishop, 2);

  const firstRevocation = applyCourtAction(state, 0, { action: 'revoke', value: 'minor:OPS:strategos' });
  assert.equal(firstRevocation.ok, true);
  assert.equal(state.themes.OPS.strategos, null);

  const secondRevocation = applyCourtAction(state, 0, { action: 'revoke', value: 'minor:KAP:strategos' });
  assert.equal(secondRevocation.ok, true);
  assert.equal(state.themes.KAP.strategos, null);

  const thirdRevocation = applyCourtAction(state, 0, { action: 'revoke', value: 'theme:SAM' });
  assert.equal(thirdRevocation.ok, true);
  assert.equal(state.themes.SAM.owner, null);

  const fourthRevocation = applyCourtAction(state, 0, { action: 'revoke', value: 'theme:ITA' });
  assert.equal(fourthRevocation.ok, true);
  assert.equal(state.themes.ITA.owner, null);
  assert.equal(getCourtPowerActionCount(state, 0, 'BASILEUS'), 4);
  assert.equal(getCourtPowerRevocationCount(state, 0, 'BASILEUS'), 4);
  assert.equal(isCourtPowerExhausted(state, 0, 'BASILEUS'), true);
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

test('patriarch may appoint bishops in occupied original church provinces', () => {
  const state = makeState();
  enterCourt(state);
  state.themes.KAP.occupied = true;

  const result = applyCourtAction(state, 1, { action: 'appoint-bishop', themeId: 'KAP', appointeeId: 2 });

  assert.equal(result.ok, true);
  assert.equal(state.themes.KAP.bishop, 2);
});

test('private estate revocation preserves seated offices and notifies the estate owner', () => {
  const state = makeState();
  state.themes.OPS.owner = 2;
  state.themes.OPS.strategos = 3;
  state.themes.OPS.bishop = 1;
  enterCourt(state);

  const result = applyCourtAction(state, 0, { action: 'revoke', value: 'theme:OPS' });

  assert.equal(result.ok, true);
  assert.equal(state.themes.OPS.owner, null);
  assert.equal(state.themes.OPS.strategos, 3);
  assert.equal(state.themes.OPS.bishop, 1);
  assert.equal(state.courtActions.revokedThisTurn['theme:OPS'], true);
  assert.equal(state.courtActions.revokedThisTurn['minor:OPS:strategos'], undefined);
  assert.equal(state.courtActions.revokedThisTurn['minor:OPS:bishop'], undefined);

  const ownerNotices = buildPrivateNotifications(state, 2).notifications;
  assert.equal(ownerNotices.some((notice) => notice.kind === 'revocation' && /private ownership/.test(notice.body)), true);
  assert.equal(ownerNotices.find((notice) => notice.kind === 'revocation')?.tone, 'negative');
  assert.equal(buildPrivateNotifications(state, 3).notifications.some((notice) => notice.kind === 'revocation'), false);
  assert.equal(buildPrivateNotifications(state, 1).notifications.some((notice) => notice.kind === 'revocation'), false);
});

test('private notifications cover action prompts and toned chronicle news', () => {
  const state = makeState();
  enterCourt(state);

  const courtNotice = buildPrivateNotifications(state, 1).notifications.find((notice) => notice.kind === 'court_action');
  assert.equal(courtNotice?.urgent, true);
  assert.equal(courtNotice?.tone, 'neutral');
  assert.equal(courtNotice?.action, 'open_court');

  const appointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 2 });
  assert.equal(appointment.ok, true);
  const appointmentNotice = buildPrivateNotifications(state, 2).notifications.find((notice) => notice.kind === 'appointment');
  assert.equal(appointmentNotice?.tone, 'positive');
  assert.match(appointmentNotice?.title || '', /appointed strategos/);

  state.history.push({
    id: 'history-auction-test',
    round: state.round,
    phase: 'deployment',
    type: 'buy_theme',
    actorId: 1,
    summary: `${state.players[1].dynasty} wins Opsikion for 4 gold.`,
    details: {
      themeId: 'OPS',
      themeName: 'Opsikion',
      cost: 4,
      bids: [
        { bidderId: 0, amount: 3 },
        { bidderId: 1, amount: 4 },
      ],
    },
  });
  const lostBidNotice = buildPrivateNotifications(state, 0).notifications.find((notice) => notice.kind === 'estate_lost');
  assert.equal(lostBidNotice?.tone, 'negative');

  state.phase = 'deployment';
  state.allOrders = {};
  const deploymentNotice = buildPrivateNotifications(state, 0).notifications.find((notice) => notice.kind === 'deployment_orders');
  assert.equal(deploymentNotice?.urgent, true);
  assert.equal(deploymentNotice?.tone, 'neutral');
  assert.equal(deploymentNotice?.action, 'open_deployment');
});

test('same-turn office appointments do not block private estate revocation', () => {
  const state = makeState();
  state.themes.OPS.owner = 2;
  enterCourt(state);

  const appointment = applyCourtAction(state, 1, { action: 'appoint-strategos', themeId: 'OPS', appointeeId: 3 });
  assert.equal(appointment.ok, true);

  const result = applyCourtAction(state, 0, { action: 'revoke', value: 'theme:OPS' });

  assert.equal(result.ok, true);
  assert.equal(state.themes.OPS.owner, null);
  assert.equal(state.themes.OPS.strategos, 3);
});

test('court no longer allows gifting private land', () => {
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
  assert.equal(getPlayer(state, 2).gold, 5);
  assert.equal(state.landAuctions.OPS.bids[2].amount, 2);

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
  assert.equal(getPlayer(state, 2).gold, 3);
});

test('sealed estate bids resolve by amount, refund losing commitments, and rotate ties', () => {
  const state = makeState();
  state.phase = 'estates';
  getPlayer(state, 1).gold = 8;
  getPlayer(state, 2).gold = 8;
  getPlayer(state, 3).gold = 8;

  assert.equal(applyEstateAction(state, 1, { action: 'buy', themeId: 'OPS', amount: 3 }).ok, true);
  assert.equal(applyEstateAction(state, 2, { action: 'buy', themeId: 'OPS', amount: 4 }).ok, true);
  assert.equal(applyEstateAction(state, 3, { action: 'buy', themeId: 'OPS', amount: 4 }).ok, true);
  assert.equal(getPlayer(state, 1).gold, 8);
  assert.equal(getPlayer(state, 2).gold, 8);
  assert.equal(getPlayer(state, 3).gold, 8);

  for (const player of state.players) confirmEstates(state, player.id);

  const firstWinner = state.themes.OPS.owner;
  const firstLoser = firstWinner === 2 ? 3 : 2;
  assert.equal([2, 3].includes(firstWinner), true);
  assert.equal(getPlayer(state, firstWinner).gold, 4);
  assert.equal(getPlayer(state, firstLoser).gold, 8);
  assert.equal(getPlayer(state, 1).gold, 8);

  state.phase = 'estates';
  state.landAuctions = {};
  state.estatesReady = {};
  state.themes.OPS.owner = null;
  getPlayer(state, 2).gold = 8;
  getPlayer(state, 3).gold = 8;

  assert.equal(applyEstateAction(state, 2, { action: 'buy', themeId: 'OPS', amount: 4 }).ok, true);
  assert.equal(applyEstateAction(state, 3, { action: 'buy', themeId: 'OPS', amount: 4 }).ok, true);
  for (const player of state.players) confirmEstates(state, player.id);

  assert.equal(state.themes.OPS.owner, firstLoser);
  assert.equal(getPlayer(state, firstLoser).gold, 4);
  assert.equal(getPlayer(state, firstWinner).gold, 8);
});

test('public estate snapshots expose only the viewer sealed bid', () => {
  const state = makeState();
  state.phase = 'estates';
  getPlayer(state, 1).gold = 5;
  getPlayer(state, 2).gold = 5;

  assert.equal(applyEstateAction(state, 1, { action: 'buy', themeId: 'OPS', amount: 2 }).ok, true);
  assert.equal(applyEstateAction(state, 2, { action: 'buy', themeId: 'OPS', amount: 4 }).ok, true);

  const playerOneView = serializePublicGameState(state, 1);
  const playerThreeView = serializePublicGameState(state, 3);

  assert.deepEqual(Object.keys(playerOneView.landAuctions.OPS.bids), ['1']);
  assert.equal(playerOneView.landAuctions.OPS.bids[1].amount, 2);
  assert.deepEqual(playerThreeView.landAuctions.OPS.bids, {});
  assert.equal(playerOneView.players[2].gold, 5);
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

test("deployment bundles a player's strategos troops into one army", () => {
  const state = makeState();
  state.phase = 'deployment';
  state.themes.OPS.strategos = 1;
  state.themes.KAP.strategos = 1;
  state.currentTroops = {
    STRAT_OPS: { normal: 1, capitalLocked: 0 },
    STRAT_KAP: { normal: 2, capitalLocked: 0 },
  };
  getPlayer(state, 1).gold = 0;

  const result = submitHumanOrders(state, 1, {
    armies: {
      [STRATEGOS_DEPLOYMENT_ARMY_KEY]: { funded: 2, destination: 'frontier' },
    },
    mercenaries: { count: 0 },
    candidate: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(getPlayer(state, 1).gold, 1);
  assert.deepEqual(state.allOrders[1].armies, {
    [STRATEGOS_DEPLOYMENT_ARMY_KEY]: { funded: 2, destination: 'frontier' },
  });
});

test('coup resolution uses ranked ballots and passive title support', () => {
  const state = makeState();
  const result = resolveCoup(state, {
    0: { candidate: 2 },
    1: { candidate: 3 },
  }, {
    0: 4,
    1: 0,
  });

  assert.equal(result.winner, 0);
  assert.equal(Math.round(result.votes[0] * 1000) / 1000, 6.333);
  assert.equal(Math.round(result.votes[2] * 1000) / 1000, 2.667);
  assert.equal(Math.round(result.votes[1] * 1000) / 1000, 2.333);
  assert.equal(Math.round(result.votes[3] * 1000) / 1000, 0.667);
  assert.deepEqual(result.ballots.map((ballot) => ballot.ranking), [
    [0, 2, 1, 3],
    [1, 3, 0, 2],
  ]);
  assert.equal(result.contributions.some((entry) => entry.passive && entry.titleKey === 'BASILEUS' && entry.votes === 2), true);
  assert.equal(result.contributions.some((entry) => entry.passive && entry.titleKey === 'PATRIARCH' && entry.candidateId === 3 && Math.abs(entry.votes - 0.6666666666666667) < 1e-9), true);
});

test('coup ties break toward the most Patriarchal support before incumbent support', () => {
  const state = makeState();
  addTemporaryCapitalSupport(state, {
    kind: 'lost_provinces',
    label: 'Lost-province unrest',
    playerId: state.basileusId,
    amount: -1,
    activeRound: state.round,
  });

  const result = resolveCoup(state, {
    1: {
      ranking: [2, 1, 0, 3],
      candidateSupport: { 0: false, 1: false, 3: false },
    },
  }, {});

  assert.equal(result.votes[0], 1);
  assert.equal(result.votes[2], 1);
  assert.equal(result.winner, 2);
  assert.equal(result.tieBreak.method, 'patriarch');
  assert.equal(result.tieBreak.patriarchSupport[2], 1);
});

test('ranked coup support can transfer secondary support without reciprocal merging', () => {
  const state = makeState();
  const result = resolveCoup(state, {
    1: { candidate: 2 },
    2: { candidate: 1 },
    3: { candidate: 3 },
  }, {
    1: 3,
    2: 5,
    3: 2,
  });

  assert.equal(result.winner, 1);
  assert.equal(result.votes[1], 8);
  assert.equal(Math.round(result.votes[2] * 1000) / 1000, 7.667);
  assert.deepEqual(result.ballots.map((ballot) => ballot.ranking), [
    [1, 2, 0, 3],
    [2, 1, 0, 3],
    [3, 0, 1, 2],
  ]);
  assert.equal(result.contributions.some((entry) => entry.playerId === 2 && entry.candidateId === 1 && Math.abs(entry.votes - 3.333333333333334) < 1e-9), true);
});

test('ranked coup support allows movable self rank and disabled candidates keep rank weights', () => {
  const state = createGameState({ playerCount: 5, deckSize: 2, seed: 11 });
  state.basileusId = 0;
  state.nextBasileusId = 0;
  for (const player of state.players) player.majorTitles = [];

  const result = resolveCoup(state, {
    0: {
      ranking: [2, 0, 1, 3, 4],
      candidateSupport: { 3: false, 4: false },
    },
  }, {
    0: 4,
  });

  assert.deepEqual(result.ballots[0].ranking, [2, 0, 1, 3, 4]);
  assert.deepEqual(result.ballots[0].weightedVotes.map((entry) => [entry.candidateId, entry.votes, entry.enabled]), [
    [2, 4, true],
    [0, 3, true],
    [1, 2, true],
    [3, 0, false],
    [4, 0, false],
  ]);
});

test('patriarch influence follows rankings while fortifications and triumph stay direct', () => {
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
    label: 'Lost-province unrest',
    playerId: state.basileusId,
    amount: -1,
    activeRound: state.round,
  });

  const result = resolveCoup(state, {
    1: { ranking: [2, 1, 0, 3], candidateSupport: { 0: false } },
    2: { ranking: [3, 2, 1, 0] },
  }, {
    1: 0,
    2: 0,
  });

  assert.equal(result.votes[0], 1);
  assert.equal(Math.round(result.votes[2] * 1000) / 1000, 3);
  assert.equal(Math.round(result.votes[1] * 1000) / 1000, 0.667);
  assert.equal(result.votes[3] || 0, 0);
  assert.equal(result.contributions.some((entry) => entry.supportLabel === 'Basileus fortifications' && entry.candidateId === 0 && entry.votes === 2), true);
  assert.equal(result.contributions.some((entry) => entry.supportLabel === 'Lost-province unrest' && entry.candidateId === 0 && entry.votes === -1), true);
  assert.equal(result.contributions.some((entry) => entry.supportLabel === 'Patriarchal influence' && entry.candidateId === 0), false);
  assert.equal(result.contributions.some((entry) => entry.supportLabel === 'Triumph' && entry.candidateId === 2 && entry.votes === 2 && !entry.distributed), true);
  assert.equal(result.contributions.some((entry) => entry.supportLabel === 'Triumph' && entry.candidateId === 3), false);
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

test('limited invasions take their target route without toppling the empire', () => {
  const state = makeState();
  state.themes.ITA.owner = 2;

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
  assert.equal(state.themes.ITA.occupied, true);
  assert.equal(state.themes.ITA.suspendedOwner, 2);
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
  state.themes.SAM.occupied = true;

  phaseInvasion(state);

  assert.equal(state.round, 2);
  assert.equal(state.maxRounds, 2);
  assert.equal(state.currentInvasion.id, 'capital_test');
  assert.equal(state.log.some((entry) => entry.type === 'invasion_skipped' && entry.invader === 'Limited Test'), true);
  assert.equal(state.history.some((entry) => entry.type === 'invasion_skipped'), true);
});

test('reconquered provinces auto-restore and reward the top defender next round', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'deployment';
  state.currentInvasion = { name: 'Raiders', route: ['SAM'], strength: [1, 1] };
  state.themes.SAM.occupied = true;
  state.currentTroops = { DOM_WEST: { normal: 3, capitalLocked: 0 } };
  state.allOrders = {
    2: {
      armies: { DOM_WEST: { funded: 3, destination: 'frontier' } },
      mercenaries: { count: 0, destination: 'frontier' },
      ranking: [2, 0, 1, 3],
      candidate: 0,
    },
  };
  getPlayer(state, 2).gold = 0;

  phaseResolution(state);

  assert.equal(state.themes.SAM.occupied, false);
  assert.equal(getPlayer(state, 2).gold, 1);
  assert.deepEqual(state.lastWarResult.themesRecovered, ['SAM']);
  assert.equal(state.lastWarResult.reconquestReward.defenderId, 2);
  assert.equal(getCapitalSupportByPlayer(state)[2], undefined);
  assert.equal(getCapitalSupportByPlayer(state)[0], 2);
  assert.equal(getCapitalSupportByPlayer(state, 2)[2], 1);
});

test('repulsed invasions reward the top defender for province wins even without occupied provinces', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'deployment';
  state.currentInvasion = { name: 'Raiders', route: ['OPS', 'SAM', 'ITA'], strength: [2, 2] };
  state.currentTroops = { DOM_WEST: { normal: 5, capitalLocked: 0 } };
  state.allOrders = {
    2: {
      armies: { DOM_WEST: { funded: 5, destination: 'frontier' } },
      mercenaries: { count: 0, destination: 'frontier' },
      ranking: [2, 0, 1, 3],
      candidate: 0,
    },
  };
  getPlayer(state, 2).gold = 0;

  phaseResolution(state);

  assert.deepEqual(state.lastWarResult.themesRecovered, []);
  assert.equal(state.lastWarResult.reconquestRewardProvinceCount, 2);
  assert.equal(state.lastWarResult.reconquestReward.rewardProvinceCount, 2);
  assert.deepEqual(state.lastWarResult.reconquestReward.themeIds, []);
  assert.equal(getPlayer(state, 2).gold, 2);
  assert.equal(getCapitalSupportByPlayer(state, 2)[2], 2);
});

test('tied top defenders split reconquest reward with rounded shares', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'deployment';
  state.currentInvasion = { name: 'Raiders', route: ['OPS', 'SAM', 'ITA'], strength: [2, 2] };
  state.themes.OPS.occupied = true;
  state.themes.SAM.occupied = true;
  state.themes.ITA.occupied = true;
  state.currentTroops = {
    DOM_WEST: { normal: 4, capitalLocked: 0 },
    ADMIRAL: { normal: 4, capitalLocked: 0 },
  };
  state.allOrders = {
    2: {
      armies: { DOM_WEST: { funded: 4, destination: 'frontier' } },
      mercenaries: { count: 0, destination: 'frontier' },
      ranking: [2, 0, 1, 3],
      candidate: 0,
    },
    3: {
      armies: { ADMIRAL: { funded: 4, destination: 'frontier' } },
      mercenaries: { count: 0, destination: 'frontier' },
      ranking: [3, 0, 1, 2],
      candidate: 0,
    },
  };
  getPlayer(state, 2).gold = 0;
  getPlayer(state, 3).gold = 0;

  phaseResolution(state);

  assert.equal(state.lastWarResult.themesRecovered.length, 3);
  assert.equal(getPlayer(state, 2).gold, 2);
  assert.equal(getPlayer(state, 3).gold, 2);
  assert.deepEqual(state.lastWarResult.reconquestReward.defenders.map((entry) => entry.defenderId), [2, 3]);
  assert.equal(state.lastWarResult.reconquestReward.gold, 2);
  assert.equal(state.lastWarResult.reconquestReward.capitalSupport, 1);
  assert.equal(getCapitalSupportByPlayer(state, 2)[2], 1);
  assert.equal(getCapitalSupportByPlayer(state, 2)[3], 1);
});

test('lost provinces reduce the next round Basileus passive support', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'deployment';
  state.currentInvasion = { name: 'Raiders', route: ['SAM'], strength: [1, 1] };
  state.currentTroops = {};
  state.allOrders = {
    0: { armies: {}, mercenaries: { count: 0, destination: 'frontier' }, ranking: [0, 1, 2, 3], candidate: 1 },
  };

  phaseResolution(state);

  assert.deepEqual(state.lastWarResult.themesLost, ['SAM']);
  assert.equal(getCapitalSupportByPlayer({ ...state, round: 2 })[0], 1);
});

test('lost province unrest follows the basileus who lost provinces through a coup', () => {
  const state = makeState();
  state.round = 1;
  state.phase = 'deployment';
  state.currentInvasion = { name: 'Raiders', route: ['SAM'], strength: [1, 1] };
  state.currentTroops = {};
  state.mercenaryOrders = {
    2: { count: 3, destination: 'capital' },
  };
  state.allOrders = {
    2: {
      armies: {},
      mercenaries: { count: 0, destination: 'frontier' },
      ranking: [2, 1, 3, 0],
      candidate: 2,
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
  assert.equal(nextRoundSupport[2], 2);
  assert.equal(nextRoundSupport[0], -1);
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
  assert.equal(category(0, 'office').value, 1);
  assert.equal(category(1, 'office').value, 6);
  assert.equal(category(2, 'office').value, 11);
  assert.equal(category(3, 'office').value, 2);
  assert.equal(category(2, 'office').totalValue, 20);
  assert.equal(category(1, 'church'), undefined);
  assert.equal(category(2, 'strategos'), undefined);

  const balance = buildBalanceOfPower(state);
  assert.equal(balance.categories.some((entry) => entry.slices.some((slice) => slice.kind === 'free')), false);
  assert.equal(balance.categories.find((entry) => entry.key === 'estate').total, 4);
  assert.equal(balance.categories.find((entry) => entry.key === 'office').total, 20);
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
