import { runIncome } from './cascade.js';
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
    description: 'Income from owned estates.',
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
  const income = runIncome(state);
  const categoryScores = new Map();

  for (const category of SCORE_CATEGORIES) {
    for (const entry of scoreCategory(state, income, category)) {
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

// Value of each category sitting outside player hands ("free citizens" share).
// Only estate income is meaningfully held by free citizens — unowned, unoccupied
// land pays its profit to nobody, so it counts toward the citizens' slice in
// the balance-of-power pie. Church revenue is extracted from citizens rather
// than retained by them, and gold reserves are dynastic only.
function getFreeCitizensCategoryValue(state, categoryKey) {
  if (categoryKey !== 'estate') return 0;
  return Object.values(state.themes).reduce((total, theme) => {
    if (!theme || theme.id === 'CPL' || theme.occupied) return total;
    if (theme.owner !== null) return total;
    return total + Math.max(0, Number(theme.P) || 0);
  }, 0);
}

// Per-category share breakdown used by the Balance of Power panel. Points
// follow the official scoring rule (share of the player-only pool), so the
// pie's denominator (player + free citizens) is purely informational — it
// shows the dynasties how much of each category is still up for grabs.
export function buildBalanceOfPower(state) {
  const final = buildFinalScores(state);
  const scoreByPlayer = new Map(final.scores.map((entry) => [entry.playerId, entry]));

  const categories = SCORE_CATEGORIES.map((category) => {
    const playerEntries = state.players.map((player) => (
      scoreByPlayer.get(player.id)?.categories.find((c) => c.key === category.key) || null
    )).filter(Boolean);

    const playerTotal = playerEntries[0]?.totalValue || 0;
    const freeCitizens = getFreeCitizensCategoryValue(state, category.key);
    const total = playerTotal + freeCitizens;

    const slices = playerEntries.map((entry) => ({
      kind: 'player',
      playerId: entry.playerId,
      value: entry.value,
      share: total > 0 ? entry.value / total : 0,
      playerShare: entry.share,
      points: entry.points,
    }));

    if (freeCitizens > 0) {
      slices.push({
        kind: 'free',
        value: freeCitizens,
        share: total > 0 ? freeCitizens / total : 0,
      });
    }

    return {
      key: category.key,
      label: category.label,
      description: category.description,
      total,
      playerTotal,
      freeCitizens,
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
