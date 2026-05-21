import { runIncome } from './cascade.js';
import { getPlayer } from './state.js';

export const SCORE_CATEGORIES = [
  {
    key: 'gold',
    label: 'Gold Reserves',
    description: 'Gold currently held in the treasury.',
  },
  {
    key: 'estate',
    label: 'Profit Income',
    description: 'Profit income received during the last income phase.',
  },
  {
    key: 'church',
    label: 'Church Income',
    description: 'Church income received during the last income phase.',
  },
  {
    key: 'strategos',
    label: 'Troop Income',
    description: 'Troop income raised during the last income phase.',
  },
];

export const SCORE_SHARE_THRESHOLDS = [0.25, 0.5, 0.75];
const SCORE_EPSILON = 1e-9;

const SCORE_INCOME_RESOURCE_BY_CATEGORY = {
  estate: 'profit',
  church: 'church',
  strategos: 'troop',
};

function getScoringIncome(state) {
  return Array.isArray(state?.lastIncome?.flow?.playerTotals) ? state.lastIncome : runIncome(state);
}

function readIncomeResource(income, playerId, resource) {
  if (!resource) return 0;
  const playerTotals = Array.isArray(income?.flow?.playerTotals) ? income.flow.playerTotals : [];
  const entry = playerTotals
    .find((row) => Number(row.playerId) === Number(playerId));
  return Math.max(0, Number(entry?.[resource]) || 0);
}

function readCategoryValue(state, playerId, categoryKey, income) {
  if (categoryKey === 'gold') return Math.max(0, Number(getPlayer(state, playerId)?.gold) || 0);
  return readIncomeResource(income, playerId, SCORE_INCOME_RESOURCE_BY_CATEGORY[categoryKey]);
}

export function getScorePointsForShare(share) {
  const normalized = Math.max(0, Number(share) || 0);
  return SCORE_SHARE_THRESHOLDS.reduce(
    (points, threshold) => (normalized + SCORE_EPSILON >= threshold ? points + 1 : points),
    0,
  );
}

function scoreCategory(state, category, income) {
  const totalValue = state.players.reduce(
    (total, player) => total + readCategoryValue(state, player.id, category.key, income),
    0,
  );

  return state.players.map((player) => {
    const value = readCategoryValue(state, player.id, category.key, income);
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
  const income = getScoringIncome(state);
  const categoryScores = new Map();

  for (const category of SCORE_CATEGORIES) {
    for (const entry of scoreCategory(state, category, income)) {
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
// use the same last-income totals as scoring, so the visible share always
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
    income: final.income,
  };
}
