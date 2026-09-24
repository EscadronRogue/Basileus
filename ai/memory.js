import { analyzeMajorTitleAssignments } from './patronage.js';

const MEMORY_DECAY = 0.84;
const EPSILON = 1e-9;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function decayedWeight(state, event) {
  const currentRound = Math.max(0, Number(state?.round) || 0);
  const eventRound = Math.max(0, Number(event?.round) || 0);
  const age = Math.max(0, currentRound - eventRound);
  return MEMORY_DECAY ** age;
}

function createPlayerMemory(playerId) {
  return {
    playerId,
    observations: 0,
    orders: 0,
    totalTroops: 0,
    fundedTroops: 0,
    idleTroops: 0,
    frontierTroops: 0,
    capitalTroops: 0,
    selfClaims: 0,
    incumbentBacks: 0,
    otherBacks: 0,
    appointments: 0,
    selfAppointments: 0,
    otherAppointments: 0,
    revocations: 0,
    dealFailures: 0,
    dealTransfers: 0,
    titleAssignments: 0,
    titlePatronageValue: 0,
    titleExpectedValue: 0,
    titleOverReward: 0,
    titleUnderReward: 0,
    defenseReliability: 0,
    fundingGreed: 0,
    coupPressure: 0,
    patronageGenerosity: 0,
    titlePatronageGenerosity: 0,
    titlePatronageStinginess: 0,
    revocationAggression: 0,
    incumbentLoyalty: 0,
    kingmaking: 0,
  };
}

function createRelationship(viewerId, otherId) {
  return {
    viewerId,
    otherId,
    favor: 0,
    harm: 0,
    trust: 0,
    debt: 0,
    givenFavor: 0,
    neglect: 0,
    titleFavor: 0,
    titleJealousy: 0,
    coupSupport: 0,
    revokedMe: 0,
    score: 0,
  };
}

function createMemory(state) {
  const playerIds = (state?.players || []).map((player) => player.id);
  const players = Object.fromEntries(playerIds.map((playerId) => [playerId, createPlayerMemory(playerId)]));
  const relationships = {};
  for (const viewerId of playerIds) {
    relationships[viewerId] = {};
    for (const otherId of playerIds) {
      if (viewerId === otherId) continue;
      relationships[viewerId][otherId] = createRelationship(viewerId, otherId);
    }
  }
  return {
    players,
    relationships,
    table: {
      averageDefenseReliability: 0,
      averageFundingGreed: 0,
      averageCoupPressure: 0,
      averageRevocationAggression: 0,
      warDefeatPressure: 0,
      warVictoryPressure: 0,
      underDefense: 0,
      overDefense: 0,
      underFunding: 0,
      overFunding: 0,
      underCouping: 0,
      overCouping: 0,
      underRevoking: 0,
      overRevoking: 0,
    },
  };
}

function relation(memory, viewerId, otherId) {
  if (viewerId === otherId) return null;
  if (!memory.relationships[viewerId]) memory.relationships[viewerId] = {};
  if (!memory.relationships[viewerId][otherId]) {
    memory.relationships[viewerId][otherId] = createRelationship(viewerId, otherId);
  }
  return memory.relationships[viewerId][otherId];
}

function addPlayer(memory, playerId, key, amount) {
  const entry = memory.players[playerId];
  if (!entry) return;
  entry[key] = (Number(entry[key]) || 0) + (Number(amount) || 0);
}

function addRelation(memory, viewerId, otherId, patch = {}) {
  const entry = relation(memory, viewerId, otherId);
  if (!entry) return;
  for (const [key, amount] of Object.entries(patch)) {
    entry[key] = (Number(entry[key]) || 0) + (Number(amount) || 0);
  }
}

function playerIds(memory) {
  return Object.keys(memory.players).map((playerId) => Number(playerId));
}

function noteBenefit(memory, actorId, targetId, amount, options = {}) {
  if (!Number.isInteger(actorId) || !Number.isInteger(targetId) || actorId === targetId) return;
  const value = Math.max(0, Number(amount) || 0);
  if (value <= 0) return;
  addRelation(memory, targetId, actorId, {
    favor: value,
    debt: value * 0.65,
    trust: value * (options.trustScale ?? 0.25),
    coupSupport: options.coupSupport ? value : 0,
  });
  addRelation(memory, actorId, targetId, {
    givenFavor: value,
    trust: value * (options.actorTrustScale ?? 0.08),
  });

  for (const viewerId of playerIds(memory)) {
    if (viewerId === actorId || viewerId === targetId) continue;
    const viewerRelation = relation(memory, viewerId, actorId);
    const invested = Math.max(0, Number(viewerRelation?.givenFavor) || 0);
    if (invested <= 0) continue;
    addRelation(memory, viewerId, actorId, {
      neglect: Math.min(value * 0.45, invested * 0.18),
    });
  }
}

function noteHarm(memory, actorId, targetId, amount) {
  if (!Number.isInteger(actorId) || !Number.isInteger(targetId) || actorId === targetId) return;
  const value = Math.max(0, Number(amount) || 0);
  if (value <= 0) return;
  addRelation(memory, targetId, actorId, {
    harm: value,
    revokedMe: value,
    trust: -value * 0.18,
  });
  addRelation(memory, actorId, targetId, {
    trust: -value * 0.05,
  });
}

function titleEntitlement(memory, actorId, targetId, averagePackageValue) {
  if (!Number.isInteger(actorId) || !Number.isInteger(targetId) || actorId === targetId) return 0;
  const rel = relation(memory, actorId, targetId);
  const support = Math.max(0, Number(rel?.coupSupport) || 0);
  const favor = Math.max(0, Number(rel?.favor) || 0);
  const debt = Math.max(0, Number(rel?.debt) || 0);
  const trust = Math.max(0, Number(rel?.trust) || 0);
  const harm = Math.max(0, Number(rel?.harm) || 0);
  const share = clamp(support * 0.08 + favor * 0.025 + debt * 0.015 + trust * 0.025 - harm * 0.04, -0.35, 0.75);
  return Math.max(0, Number(averagePackageValue) || 0) * share;
}

function noteTitlePatronage(memory, actorId, targetId, actualValue, expectedValue, weight) {
  if (!Number.isInteger(actorId) || !Number.isInteger(targetId) || actorId === targetId) return;
  const actual = Math.max(0, Number(actualValue) || 0);
  const expected = Math.max(0, Number(expectedValue) || 0);
  const delta = actual - expected;
  const scale = Math.max(1, actual, expected);
  const quality = delta / scale;
  const titleWeight = Math.max(0, Number(weight) || 0);
  if (titleWeight <= 0) return;

  addPlayer(memory, actorId, 'titleAssignments', titleWeight);
  addPlayer(memory, actorId, 'titlePatronageValue', actual * titleWeight);
  addPlayer(memory, actorId, 'titleExpectedValue', expected * titleWeight);
  addPlayer(memory, actorId, delta >= 0 ? 'titleOverReward' : 'titleUnderReward', Math.abs(delta) * titleWeight);

  const baseFavor = Math.min(1.1, actual * 0.1) * titleWeight;
  const bonusFavor = Math.max(0, quality) * 2.2 * titleWeight;
  const jealousy = Math.max(0, -quality) * 2.2 * titleWeight;

  if (baseFavor > 0 || bonusFavor > 0) {
    const value = baseFavor * 0.25 + bonusFavor;
    addRelation(memory, targetId, actorId, {
      titleFavor: value,
      favor: value * 0.42,
      debt: value * 0.28,
      trust: value * 0.24,
    });
    addRelation(memory, actorId, targetId, {
      givenFavor: value * 0.35,
      trust: value * 0.08,
    });
  }

  if (jealousy > 0) {
    addRelation(memory, targetId, actorId, {
      titleJealousy: jealousy,
      neglect: jealousy * 0.75,
      trust: -jealousy * 0.26,
    });
    addRelation(memory, actorId, targetId, {
      trust: -jealousy * 0.04,
    });
  }
}

function themeStakeOwnerIds(state, themeId) {
  const theme = state?.themes?.[themeId];
  if (!theme) return [];
  return [...new Set([theme.owner, theme.strategos, theme.bishop]
    .map((value) => Number(value))
    .filter(Number.isInteger))];
}

function handleAppointment(memory, event, weight) {
  const actorId = Number(event.actorId);
  const appointeeId = Number(event.details?.appointeeId);
  if (!Number.isInteger(actorId) || !Number.isInteger(appointeeId)) return;
  const amount = weight;
  addPlayer(memory, actorId, 'appointments', amount);
  if (actorId === appointeeId) addPlayer(memory, actorId, 'selfAppointments', amount);
  else {
    addPlayer(memory, actorId, 'otherAppointments', amount);
    noteBenefit(memory, actorId, appointeeId, amount, { trustScale: 0.35 });
  }
}

function handleRevocation(memory, event, weight) {
  const actorId = Number(event.actorId);
  if (!Number.isInteger(actorId)) return;
  addPlayer(memory, actorId, 'revocations', weight);
  const revokedIds = Array.isArray(event.details?.revokedPlayerIds)
    ? event.details.revokedPlayerIds
    : [event.details?.revokedPlayerId];
  for (const rawId of revokedIds) {
    const targetId = Number(rawId);
    if (!Number.isInteger(targetId)) continue;
    noteHarm(memory, actorId, targetId, weight * (event.type === 'revoke_theme' ? 1.35 : 1));
  }
}

function handleTitleRedistribution(memory, event, weight, state) {
  const actorId = Number(event.actorId);
  if (!Number.isInteger(actorId)) return;
  const assignments = event.details?.assignments || {};
  const normalizedAssignments = Object.fromEntries(Object.entries(assignments).map(([titleKey, assignment]) => [
    titleKey,
    Number(assignment?.playerId ?? assignment),
  ]));
  const analysis = analyzeMajorTitleAssignments(state, actorId, normalizedAssignments);
  const assignedIds = [];
  for (const packageEntry of analysis.entries) {
    const targetId = Number(packageEntry.playerId);
    if (!Number.isInteger(targetId) || targetId === actorId) continue;
    assignedIds.push(targetId);
    const expected = analysis.averagePackageValue + titleEntitlement(memory, actorId, targetId, analysis.averagePackageValue);
    noteTitlePatronage(memory, actorId, targetId, packageEntry.value, expected, weight);
  }
  addPlayer(memory, actorId, 'otherAppointments', assignedIds.length * weight * 1.35);
}

function handleDealTransfer(memory, event, weight) {
  const giverId = Number(event.details?.giverId ?? event.actorId);
  const receiverId = Number(event.details?.receiverId);
  if (!Number.isInteger(giverId) || !Number.isInteger(receiverId)) return;
  const amount = event.type === 'deal_gold_transfer'
    ? Math.min(3, (Number(event.details?.amount) || 0) * 0.35)
    : 1.6;
  addPlayer(memory, giverId, 'dealTransfers', weight);
  noteBenefit(memory, giverId, receiverId, weight * amount, { trustScale: 0.45 });
}

function handleDealFailure(memory, event, weight) {
  const giverId = Number(event.details?.giverId ?? event.actorId);
  const receiverId = Number(event.details?.receiverId);
  if (!Number.isInteger(giverId) || !Number.isInteger(receiverId)) return;
  addPlayer(memory, giverId, 'dealFailures', weight);
  noteHarm(memory, giverId, receiverId, weight * 1.5);
}

function orderTotalTroops(details = {}) {
  return (details.offices || []).reduce((total, office) => (
    total + Math.max(0, Number(office.totalTroops) || 0)
  ), 0) + Math.max(0, Number(details.mercenaries?.count) || 0);
}

function handleOrders(memory, event, weight, state) {
  const actorId = Number(event.actorId);
  if (!Number.isInteger(actorId)) return;
  const details = event.details || {};
  const candidateId = Number(details.candidateId);
  const capitalTroops = Math.max(0, Number(details.capitalTroops) || 0);
  const frontierTroops = Math.max(0, Number(details.frontierTroops) || 0);
  const totalTroops = Math.max(orderTotalTroops(details), capitalTroops + frontierTroops);
  const fundedTroops = (details.offices || []).reduce((total, office) => (
    total + Math.max(0, Number(office.fundedTroops) || 0)
  ), 0) + Math.max(0, Number(details.mercenaries?.count) || 0);
  const idleTroops = (details.offices || []).reduce((total, office) => (
    total + Math.max(0, Number(office.unfundedTroops) || 0)
  ), 0);

  addPlayer(memory, actorId, 'orders', weight);
  addPlayer(memory, actorId, 'observations', weight);
  addPlayer(memory, actorId, 'capitalTroops', capitalTroops * weight);
  addPlayer(memory, actorId, 'frontierTroops', frontierTroops * weight);
  addPlayer(memory, actorId, 'totalTroops', totalTroops * weight);
  addPlayer(memory, actorId, 'fundedTroops', fundedTroops * weight);
  addPlayer(memory, actorId, 'idleTroops', idleTroops * weight);

  // Who the dynasty put first. `candidateId` is its best choice other than
  // itself, so ranking itself first with troops in the capital is a claim.
  const ranking = Array.isArray(details.ranking) ? details.ranking.map(Number) : [];
  const topChoice = Number.isInteger(ranking[0]) ? ranking[0] : candidateId;
  if (topChoice === actorId) {
    if (capitalTroops > 0) addPlayer(memory, actorId, 'selfClaims', weight);
  } else if (topChoice === state.basileusId) {
    addPlayer(memory, actorId, 'incumbentBacks', weight);
  } else if (Number.isInteger(topChoice)) {
    addPlayer(memory, actorId, 'otherBacks', weight);
  }

  if (Number.isInteger(candidateId)) {
    if (candidateId !== actorId && capitalTroops > 0) {
      noteBenefit(memory, actorId, candidateId, Math.min(4, capitalTroops * 0.55) * weight, {
        coupSupport: true,
        trustScale: 0.35,
      });
    }
    if (state.basileusId !== candidateId && capitalTroops > 0) {
      noteHarm(memory, actorId, state.basileusId, Math.min(3, capitalTroops * 0.35) * weight);
    }
  }
}

function handleWarResult(memory, event, weight, state) {
  const details = event.details || {};
  const outcome = details.outcome;
  if (outcome === 'defeat') memory.table.warDefeatPressure += weight;
  if (outcome === 'victory') memory.table.warVictoryPressure += weight;
  const recoveredThemes = Array.isArray(details.themesRecovered) ? details.themesRecovered : [];
  const contributors = Array.isArray(details.contributions) ? details.contributions : [];

  for (const contribution of contributors) {
    const defenderId = Number(contribution.playerId);
    const troops = Math.max(0, Number(contribution.troops) || 0);
    if (!Number.isInteger(defenderId) || troops <= 0) continue;
    const publicGood = Math.min(1.5, troops * 0.08) * weight;
    for (const viewerId of playerIds(memory)) {
      if (viewerId === defenderId) continue;
      addRelation(memory, viewerId, defenderId, { favor: publicGood, trust: publicGood * 0.4 });
    }
    for (const themeId of recoveredThemes) {
      for (const stakeholderId of themeStakeOwnerIds(state, themeId)) {
        if (stakeholderId !== defenderId) {
          addRelation(memory, stakeholderId, defenderId, {
            favor: Math.min(2.5, troops * 0.18) * weight,
            debt: Math.min(1.5, troops * 0.12) * weight,
          });
        }
      }
    }
  }
}


function finalizeRelationships(memory) {
  for (const row of Object.values(memory.relationships)) {
    for (const entry of Object.values(row)) {
      const raw = entry.favor + entry.trust * 0.8 + entry.debt * 0.45
        + entry.titleFavor * 0.9
        - entry.harm * 1.15 - entry.neglect * 0.75 - entry.titleJealousy * 0.9;
      entry.score = clamp(raw, -8, 8);
      entry.trust = clamp(entry.trust, -6, 6);
      entry.favor = clamp(entry.favor, 0, 10);
      entry.harm = clamp(entry.harm, 0, 10);
      entry.debt = clamp(entry.debt, 0, 8);
      entry.givenFavor = clamp(entry.givenFavor, 0, 8);
      entry.neglect = clamp(entry.neglect, 0, 8);
      entry.titleFavor = clamp(entry.titleFavor, 0, 8);
      entry.titleJealousy = clamp(entry.titleJealousy, 0, 8);
    }
  }
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function finalizePlayerPatterns(memory) {
  const entries = Object.values(memory.players);
  for (const entry of entries) {
    const totalTroops = Math.max(EPSILON, entry.totalTroops);
    const orders = Math.max(EPSILON, entry.orders);
    const appointments = Math.max(EPSILON, entry.appointments);
    entry.defenseReliability = clamp((entry.frontierTroops / totalTroops) * 1.2 + (entry.fundedTroops / totalTroops) * 0.45, 0, 1.5);
    entry.fundingGreed = clamp(entry.idleTroops / totalTroops, 0, 1);
    entry.coupPressure = clamp((entry.capitalTroops / totalTroops) * 1.15 + ((entry.selfClaims + entry.otherBacks) / orders) * 0.45, 0, 1.8);
    entry.patronageGenerosity = clamp(entry.otherAppointments / appointments, 0, 1);
    entry.titlePatronageGenerosity = clamp(entry.titleOverReward / Math.max(EPSILON, entry.titleExpectedValue), 0, 1.5);
    entry.titlePatronageStinginess = clamp(entry.titleUnderReward / Math.max(EPSILON, entry.titleExpectedValue), 0, 1.5);
    entry.revocationAggression = clamp(entry.revocations / orders, 0, 1.5);
    entry.incumbentLoyalty = clamp(entry.incumbentBacks / orders, 0, 1);
    entry.kingmaking = clamp(entry.otherBacks / orders, 0, 1);
  }

  const orderEntries = entries.filter((entry) => entry.orders > 0);
  const revocationEntries = entries.filter((entry) => entry.orders > 0 || entry.revocations > 0);
  memory.table.averageDefenseReliability = orderEntries.length
    ? average(orderEntries.map((entry) => entry.defenseReliability))
    : 0.62;
  memory.table.averageFundingGreed = orderEntries.length
    ? average(orderEntries.map((entry) => entry.fundingGreed))
    : 0.22;
  memory.table.averageCoupPressure = orderEntries.length
    ? average(orderEntries.map((entry) => entry.coupPressure))
    : 0.18;
  memory.table.averageRevocationAggression = revocationEntries.length
    ? average(revocationEntries.map((entry) => entry.revocationAggression))
    : 0.08;
  memory.table.underDefense = clamp(0.62 - memory.table.averageDefenseReliability + memory.table.warDefeatPressure * 0.12, 0, 1);
  memory.table.overDefense = clamp(memory.table.averageDefenseReliability - 0.95 + memory.table.warVictoryPressure * 0.06, 0, 1);
  memory.table.underFunding = clamp(memory.table.averageFundingGreed - 0.22, 0, 1);
  memory.table.overFunding = clamp(0.06 - memory.table.averageFundingGreed, 0, 1);
  memory.table.underCouping = clamp(0.18 - memory.table.averageCoupPressure, 0, 1);
  memory.table.overCouping = clamp(memory.table.averageCoupPressure - 0.62, 0, 1);
  memory.table.underRevoking = clamp(0.08 - memory.table.averageRevocationAggression, 0, 1);
  memory.table.overRevoking = clamp(memory.table.averageRevocationAggression - 0.35, 0, 1);
}

function buildMemoryKey(state) {
  return [
    state?.round ?? 0,
    state?.phase || '',
    Array.isArray(state?.history) ? state.history.length : 0,
    Object.keys(state?.allOrders || {}).length,
  ].join(':');
}

export function buildAiMemory(state) {
  const memory = createMemory(state);
  const history = Array.isArray(state?.history) ? state.history : [];
  for (const event of history) {
    const weight = decayedWeight(state, event);
    if (['appoint_strategos', 'appoint_bishop'].includes(event.type)) handleAppointment(memory, event, weight);
    else if (['revoke_minor_title', 'revoke_theme'].includes(event.type)) handleRevocation(memory, event, weight);
    else if (event.type === 'title_redistribution') handleTitleRedistribution(memory, event, weight, state);
    else if (event.type === 'deal_gold_transfer' || event.type === 'deal_estate_transfer') handleDealTransfer(memory, event, weight);
    else if (event.type === 'deal_obligation_failed') handleDealFailure(memory, event, weight);
    else if (event.type === 'orders_revealed') handleOrders(memory, event, weight, state);
    else if (event.type === 'war_result') handleWarResult(memory, event, weight, state);
  }
  finalizeRelationships(memory);
  finalizePlayerPatterns(memory);
  return memory;
}

export function getAiMemory(state, meta = null) {
  const key = buildMemoryKey(state);
  if (meta?.fastCache?.memoryKey === key && meta.fastCache.memory) return meta.fastCache.memory;
  const memory = buildAiMemory(state);
  if (meta) {
    meta.fastCache = {
      ...(meta.fastCache || {}),
      memoryKey: key,
      memory,
    };
  }
  return memory;
}

export function getRelationship(memory, viewerId, otherId) {
  return relation(memory || { relationships: {}, players: {} }, viewerId, otherId) || createRelationship(viewerId, otherId);
}

export function getPlayerMemory(memory, playerId) {
  return memory?.players?.[playerId] || createPlayerMemory(playerId);
}

export function relationshipScore(memory, viewerId, otherId) {
  if (viewerId === otherId) return 0;
  return getRelationship(memory, viewerId, otherId).score;
}
