import { runAdministration } from './cascade.js';
import { getPlayer } from './state.js';

export const SCORE_CATEGORIES = [
  {
    key: 'church',
    label: 'Church Income',
    description: 'Income from the Patriarch and Bishops.',
  },
  {
    key: 'estate',
    label: 'Estate Income',
    description: 'Income from owned estates and tax exemptions.',
  },
  {
    key: 'tax',
    label: 'Tax Income',
    description: 'Income from imperial, regional, and provincial tax offices.',
  },
  {
    key: 'gold',
    label: 'Gold Reserves',
    description: 'Gold currently held in the treasury.',
  },
];

export const SCORE_SHARE_THRESHOLDS = [0.25, 0.5, 0.75];
const SCORE_EPSILON = 1e-9;

function readCategoryValue(state, administration, playerId, categoryKey) {
  if (categoryKey === 'gold') return Math.max(0, Number(getPlayer(state, playerId)?.gold) || 0);
  return Math.max(0, Number(administration.incomeBreakdown?.[categoryKey]?.[playerId]) || 0);
}

export function getScorePointsForShare(share) {
  const normalized = Math.max(0, Number(share) || 0);
  return SCORE_SHARE_THRESHOLDS.reduce(
    (points, threshold) => (normalized + SCORE_EPSILON >= threshold ? points + 1 : points),
    0,
  );
}

function scoreCategory(state, administration, category) {
  const totalValue = state.players.reduce(
    (total, player) => total + readCategoryValue(state, administration, player.id, category.key),
    0,
  );

  return state.players.map((player) => {
    const value = readCategoryValue(state, administration, player.id, category.key);
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
  const administration = runAdministration(state);
  const categoryScores = new Map();

  for (const category of SCORE_CATEGORIES) {
    for (const entry of scoreCategory(state, administration, category)) {
      if (!categoryScores.has(entry.playerId)) categoryScores.set(entry.playerId, []);
      categoryScores.get(entry.playerId).push(entry);
    }
  }

  const scores = state.players.map((player) => {
    const categories = categoryScores.get(player.id) || [];
    const points = categories.reduce((total, category) => total + category.points, 0);
    const projectedIncome = administration.income[player.id] || 0;
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
    administration,
  };
}

export function getPlayerFinalScore(state, playerId) {
  return buildFinalScores(state).scores.find((score) => score.playerId === playerId) || null;
}
