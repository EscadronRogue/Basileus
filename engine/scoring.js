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

function readCategoryValue(state, administration, playerId, categoryKey) {
  if (categoryKey === 'gold') return Math.max(0, Number(getPlayer(state, playerId)?.gold) || 0);
  return Math.max(0, Number(administration.incomeBreakdown?.[categoryKey]?.[playerId]) || 0);
}

function rankCategory(state, administration, category) {
  const playerCount = state.players.length;
  const totalValue = state.players.reduce(
    (total, player) => total + readCategoryValue(state, administration, player.id, category.key),
    0,
  );
  const values = state.players.map((player) => ({
    playerId: player.id,
    value: readCategoryValue(state, administration, player.id, category.key),
  }));

  return values.map((entry) => {
    const higherCount = values.filter((other) => other.value > entry.value).length;
    const rank = higherCount + 1;
    return {
      ...category,
      playerId: entry.playerId,
      value: entry.value,
      share: totalValue > 0 ? entry.value / totalValue : 0,
      rank,
      points: Math.max(1, playerCount - rank + 1),
    };
  });
}

export function buildFinalScores(state) {
  const administration = runAdministration(state);
  const categoryRanks = new Map();

  for (const category of SCORE_CATEGORIES) {
    for (const entry of rankCategory(state, administration, category)) {
      if (!categoryRanks.has(entry.playerId)) categoryRanks.set(entry.playerId, []);
      categoryRanks.get(entry.playerId).push(entry);
    }
  }

  const scores = state.players.map((player) => {
    const categories = categoryRanks.get(player.id) || [];
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
