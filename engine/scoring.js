import { runIncome } from './cascade.js';
import { findTitleHolder, getPlayer } from './state.js';
import {
  getThemeChurchValue,
  getThemeOwnerIncome,
  getThemeTroopCount,
} from './rules.js';

export const SCORE_CATEGORIES = [
  {
    key: 'gold',
    label: 'Gold Reserves',
    description: 'Gold currently held in the treasury.',
  },
  {
    key: 'estate',
    label: 'Private Estates',
    description: 'Current private land estates owned inside the empire.',
  },
  {
    key: 'church',
    label: 'Bishops',
    description: 'Current bishops held by the dynasty, including sees in occupied provinces.',
  },
  {
    key: 'strategos',
    label: 'Strategoi',
    description: 'Current strategos appointments held inside the empire.',
  },
];

export const SCORE_SHARE_THRESHOLDS = [0.25, 0.5, 0.75];
const SCORE_EPSILON = 1e-9;

function countPrivateEstates(state, playerId) {
  return Object.values(state.themes || {}).reduce((total, theme) => {
    if (!theme || theme.id === 'CPL' || theme.occupied) return total;
    return theme.owner === playerId ? total + 1 : total;
  }, 0);
}

function countBishops(state, playerId) {
  return Object.values(state.themes || {}).reduce((total, theme) => {
    if (!theme || theme.id === 'CPL') return total;
    return theme.bishop === playerId ? total + 1 : total;
  }, 0);
}

function countStrategoi(state, playerId) {
  return Object.values(state.themes || {}).reduce((total, theme) => {
    if (!theme || theme.id === 'CPL' || theme.occupied) return total;
    return theme.strategos === playerId ? total + 1 : total;
  }, 0);
}

function readCategoryValue(state, playerId, categoryKey) {
  if (categoryKey === 'gold') return Math.max(0, Number(getPlayer(state, playerId)?.gold) || 0);
  if (categoryKey === 'estate') return countPrivateEstates(state, playerId);
  if (categoryKey === 'church') return countBishops(state, playerId);
  if (categoryKey === 'strategos') return countStrategoi(state, playerId);
  return 0;
}

export function getScorePointsForShare(share) {
  const normalized = Math.max(0, Number(share) || 0);
  return SCORE_SHARE_THRESHOLDS.reduce(
    (points, threshold) => (normalized + SCORE_EPSILON >= threshold ? points + 1 : points),
    0,
  );
}

function scoreCategory(state, category) {
  const totalValue = state.players.reduce(
    (total, player) => total + readCategoryValue(state, player.id, category.key),
    0,
  );

  return state.players.map((player) => {
    const value = readCategoryValue(state, player.id, category.key);
    const share = totalValue > 0 ? value / totalValue : 0;
    return {
      ...category,
      playerId: player.id,
      value,
      totalValue,
      share,
      points: totalValue > 0 ? getScorePointsForShare(share) : 0,
    };
  });
}

export function buildFinalScores(state) {
  const income = runIncome(state);
  const categoryScores = new Map();

  for (const category of SCORE_CATEGORIES) {
    for (const entry of scoreCategory(state, category)) {
      if (!categoryScores.has(entry.playerId)) categoryScores.set(entry.playerId, []);
      categoryScores.get(entry.playerId).push(entry);
    }
  }

  const scores = state.players.map((player) => {
    const categories = categoryScores.get(player.id) || [];
    const points = categories.reduce((total, category) => total + category.points, 0);
    const projectedIncome = income.income[player.id] || 0;
    return {
      player,
      playerId: player.id,
      dynasty: player.dynasty,
      points,
      wealth: points,
      gold: player.gold,
      projectedIncome,
      categories,
    };
  }).sort((left, right) => (
    (right.points - left.points)
    || (right.gold - left.gold)
    || (left.playerId - right.playerId)
  ));

  const topScore = scores[0]?.points ?? 0;
  const winners = scores.filter((score) => score.points === topScore);
  return {
    scores,
    winners,
    topScore,
    topWealth: topScore,
    income,
  };
}

export function getPlayerFinalScore(state, playerId) {
  return buildFinalScores(state).scores.find((score) => score.playerId === playerId) || null;
}

// Per-category share breakdown used by the Balance of Power panel. The pies
// use the same player-held totals as scoring, so the visible share always
// matches the points share.
export function buildBalanceOfPower(state) {
  const final = buildFinalScores(state);
  const scoreByPlayer = new Map(final.scores.map((entry) => [entry.playerId, entry]));

  const categories = SCORE_CATEGORIES.map((category) => {
    const playerEntries = state.players.map((player) => (
      scoreByPlayer.get(player.id)?.categories.find((c) => c.key === category.key) || null
    )).filter(Boolean);

    const total = playerEntries[0]?.totalValue || 0;

    const slices = playerEntries.map((entry) => ({
      kind: 'player',
      playerId: entry.playerId,
      value: entry.value,
      share: total > 0 ? entry.value / total : 0,
      playerShare: entry.share,
      points: entry.points,
    }));

    return {
      key: category.key,
      label: category.label,
      description: category.description,
      total,
      playerTotal: total,
      freeCitizens: 0,
      slices,
    };
  });

  return {
    categories,
    scores: final.scores,
    winners: final.winners,
    topScore: final.topScore,
  };
}

// ── Power Flow ──────────────────────────────────────────────────────────────
// Income flow data used by the Balance of Power panel to draw a Sankey-style
// diagram. For each of the three resources that the empire produces this turn
// (profits, frontier troops, church income) we describe the chain
//   pool → office → player.
//
// This mirrors the logic in cascade.js / runIncome but reshapes the breakdown
// so the UI can render flows by office rather than only by recipient.

function sliceSorter(left, right) {
  return (Number(right.amount) || 0) - (Number(left.amount) || 0)
    || (Number(left.playerId) || 0) - (Number(right.playerId) || 0);
}

function emptyPool(key, kind, label, description) {
  return {
    key,
    kind,
    label,
    description,
    total: 0,
    offices: [],
  };
}

function buildEstateFlow(state, themes) {
  const pool = emptyPool('profit', 'gold', 'Estate Profits', 'Gold from private estates each turn.');
  const byPlayer = new Map();
  for (const theme of themes) {
    if (!theme || theme.id === 'CPL') continue;
    if (theme.occupied) continue;
    if (theme.owner === 'church' || theme.owner == null) continue;
    const amount = getThemeOwnerIncome(theme);
    if (amount <= 0) continue;
    pool.total += amount;
    byPlayer.set(theme.owner, (byPlayer.get(theme.owner) || 0) + amount);
  }
  if (pool.total > 0) {
    pool.offices.push({
      key: 'LANDOWNERS',
      label: 'Landowners',
      holderPlayerId: null,
      total: pool.total,
      slices: Array.from(byPlayer.entries())
        .map(([playerId, amount]) => ({ playerId, amount }))
        .sort(sliceSorter),
    });
  }
  return pool;
}

function buildChurchFlow(state, themes) {
  const pool = emptyPool('church', 'church', 'Church Income', 'Gold from bishoprics and the Patriarchate.');
  const byBishop = new Map();
  let patriarchPool = 0;
  for (const theme of themes) {
    if (!theme || theme.id === 'CPL') continue;
    let amount = 0;
    if (theme.occupied) {
      if (theme.bishop == null) continue;
      amount = Math.max(0, Number(theme.origin?.C) || 0);
    } else {
      amount = getThemeChurchValue(theme);
    }
    if (amount <= 0) continue;
    pool.total += amount;
    if (theme.bishop != null) {
      byBishop.set(theme.bishop, (byBishop.get(theme.bishop) || 0) + amount);
    } else {
      patriarchPool += amount;
    }
  }
  const bishopTotal = Array.from(byBishop.values()).reduce((sum, value) => sum + value, 0);
  if (bishopTotal > 0) {
    pool.offices.push({
      key: 'BISHOPS',
      label: 'Bishops',
      holderPlayerId: null,
      total: bishopTotal,
      slices: Array.from(byBishop.entries())
        .map(([playerId, amount]) => ({ playerId, amount }))
        .sort(sliceSorter),
    });
  }
  if (patriarchPool > 0) {
    const holder = findTitleHolder(state, 'PATRIARCH');
    pool.offices.push({
      key: 'PATRIARCH',
      label: 'Patriarch',
      holderPlayerId: holder,
      vacant: holder == null,
      total: patriarchPool,
      slices: holder != null ? [{ playerId: holder, amount: patriarchPool }] : [],
    });
  }
  return pool;
}

function cascadeRegionalTroops(state, regionAmount, commandKey) {
  // Mirrors cascade.js computeRegionalTroopCascade: a 2/1 pattern between the
  // regional commander and Basileus. When the office is vacant, every troop
  // falls through to Basileus.
  let pool = Math.max(0, Number(regionAmount) || 0);
  const holder = findTitleHolder(state, commandKey);
  const result = { commander: 0, basileus: 0, holder };
  while (pool > 0) {
    const slot = Math.min(2, pool);
    if (holder != null) result.commander += slot;
    else result.basileus += slot;
    pool -= slot;
    if (pool <= 0) break;
    result.basileus += 1;
    pool -= 1;
  }
  return result;
}

function buildTroopFlow(state, themes) {
  const pool = emptyPool('troops', 'troop', 'Frontier Troops', 'Troops raised in the themes each turn.');
  const byStrategos = new Map();
  const regional = { EAST: 0, WEST: 0, SEA: 0 };

  for (const theme of themes) {
    if (!theme || theme.id === 'CPL') continue;
    if (theme.occupied) continue;
    if (theme.owner === 'church') continue;
    const amount = getThemeTroopCount(theme);
    if (amount <= 0) continue;
    pool.total += amount;
    if (theme.strategos != null) {
      byStrategos.set(theme.strategos, (byStrategos.get(theme.strategos) || 0) + amount);
    } else if (Object.prototype.hasOwnProperty.call(regional, theme.region)) {
      regional[theme.region] += amount;
    }
  }

  const stratTotal = Array.from(byStrategos.values()).reduce((sum, value) => sum + value, 0);
  if (stratTotal > 0) {
    pool.offices.push({
      key: 'STRATEGOI',
      label: 'Strategoi',
      holderPlayerId: null,
      total: stratTotal,
      slices: Array.from(byStrategos.entries())
        .map(([playerId, amount]) => ({ playerId, amount }))
        .sort(sliceSorter),
    });
  }

  const regionDefs = [
    { key: 'DOM_EAST', region: 'EAST', label: 'Dom. East' },
    { key: 'DOM_WEST', region: 'WEST', label: 'Dom. West' },
    { key: 'ADMIRAL',  region: 'SEA',  label: 'Admiral' },
  ];

  let basileusTotal = 0;
  for (const def of regionDefs) {
    const cascade = cascadeRegionalTroops(state, regional[def.region], def.key);
    if (cascade.commander > 0 && cascade.holder != null) {
      pool.offices.push({
        key: def.key,
        label: def.label,
        holderPlayerId: cascade.holder,
        total: cascade.commander,
        slices: [{ playerId: cascade.holder, amount: cascade.commander }],
      });
    }
    basileusTotal += cascade.basileus;
  }

  if (basileusTotal > 0) {
    const basileusId = state.basileusId ?? null;
    pool.offices.push({
      key: 'BASILEUS',
      label: 'Basileus',
      holderPlayerId: basileusId,
      vacant: basileusId == null,
      total: basileusTotal,
      slices: basileusId != null ? [{ playerId: basileusId, amount: basileusTotal }] : [],
    });
  }

  return pool;
}

export function buildPowerFlow(state) {
  const themes = Object.values(state?.themes || {});
  const pools = [
    buildEstateFlow(state, themes),
    buildTroopFlow(state, themes),
    buildChurchFlow(state, themes),
  ];
  return { pools };
}
