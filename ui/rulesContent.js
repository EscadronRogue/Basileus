import { REGIONS } from '../data/provinces.js';
import { computeFullWealth } from '../engine/actions.js';
import { CAPITAL_LOCKED_TITLE_LEVIES } from '../engine/cascade.js';
import { runAdministration } from '../engine/cascade.js';
import {
  getMercenaryHireCost,
  getNormalOwnerIncome,
  getNormalTaxIncome,
  getTaxExemptionCost,
  getTaxExemptOwnerIncome,
  getThemeLandPrice,
  getThemeOwnerIncome,
} from '../engine/rules.js';
import {
  findTitleHolder,
  getOfficeDisplayName,
  getPlayer,
  getPlayerLabel,
} from '../engine/state.js';
import { formatGold, formatProvinceYield } from '../engine/presentation.js';

export const RULES_SECTION_IDS = Object.freeze({
  GOAL: 'goal',
  ROUND: 'round',
  GOLD: 'gold',
  PROFIT_TAX_LEVIES: 'profit_tax_levies',
  ESTATES: 'estates',
  TITLES_AND_OFFICES: 'titles_and_offices',
  CHURCH: 'church',
  ARMIES: 'armies',
  COUPS: 'coups',
  INVASIONS: 'invasions',
  SCORING: 'scoring',
});

export const RULES_SECTION_TITLES = Object.freeze({
  [RULES_SECTION_IDS.GOAL]: 'Goal',
  [RULES_SECTION_IDS.ROUND]: 'Round Structure',
  [RULES_SECTION_IDS.GOLD]: 'Gold',
  [RULES_SECTION_IDS.PROFIT_TAX_LEVIES]: 'Profit, Tax, And Levies',
  [RULES_SECTION_IDS.ESTATES]: 'Estates And Privileges',
  [RULES_SECTION_IDS.TITLES_AND_OFFICES]: 'Titles And Offices',
  [RULES_SECTION_IDS.CHURCH]: 'Church',
  [RULES_SECTION_IDS.ARMIES]: 'Armies',
  [RULES_SECTION_IDS.COUPS]: 'Coups',
  [RULES_SECTION_IDS.INVASIONS]: 'Invasions',
  [RULES_SECTION_IDS.SCORING]: 'Final Scoring',
});

const REGION_LABELS = Object.freeze({
  [REGIONS.EAST]: 'East',
  [REGIONS.WEST]: 'West',
  [REGIONS.SEA]: 'Sea',
  [REGIONS.CPL]: 'Constantinople',
});

const REGIONAL_OFFICE_KEYS = Object.freeze({
  [REGIONS.EAST]: 'DOM_EAST',
  [REGIONS.WEST]: 'DOM_WEST',
  [REGIONS.SEA]: 'ADMIRAL',
});

function formatNumber(value) {
  const numeric = Number(value) || 0;
  return Number.isInteger(numeric) ? numeric : Math.round(numeric * 100) / 100;
}

function pluralize(value, singular, plural = `${singular}s`) {
  return `${formatNumber(value)} ${formatNumber(value) === 1 ? singular : plural}`;
}

function getRegionLabel(region) {
  return REGION_LABELS[region] || region;
}

function getRegionalOfficeLabel(state, region) {
  const officeKey = REGIONAL_OFFICE_KEYS[region];
  if (!officeKey) return 'regional major office';
  return getOfficeDisplayName(state, officeKey);
}

function getPlayerName(state, playerId, fallback = 'No dynasty') {
  const player = getPlayer(state, playerId);
  return player ? getPlayerLabel(state, player.id) : fallback;
}

function getProjectedFinance(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return null;
  const administration = runAdministration(state);
  const projectedIncome = administration.income[playerId] || 0;
  const estateIncome = Object.values(state.themes).reduce((total, theme) => (
    theme.owner === playerId && !theme.occupied && theme.id !== 'CPL'
      ? total + getThemeOwnerIncome(theme)
      : total
  ), 0);
  const officeIncome = projectedIncome - estateIncome;
  const maintenance = Object.values(player.professionalArmies || {}).reduce((total, count) => total + count, 0);
  return {
    projectedIncome,
    estateIncome,
    officeIncome,
    maintenance,
    treasuryAfterAdministration: player.gold + projectedIncome,
    wealth: computeFullWealth(state, playerId, projectedIncome),
  };
}

export function getSetupPrimerSections() {
  return [
    {
      id: 'setup-goal',
      title: 'Goal Of The Game',
      lines: [
        'Finish with the highest gold on hand + next Administration income.',
        'If an invasion reaches Constantinople, the empire falls and everyone loses.',
      ],
    },
    {
      id: 'setup-round',
      title: 'Round Structure',
      lines: [
        'Each round is Invasion -> Administration -> Court -> Secret Orders -> Resolution -> Cleanup.',
        'Administration is automatic. Court is public. Secret Orders stay hidden until Resolution.',
      ],
    },
    {
      id: 'setup-resources',
      title: 'Resources And Troops',
      lines: [
        'Profit goes to estate owners, tax becomes office or church income, and levies become temporary troops during Administration.',
        'Gold buys estates, tax exemptions, and mercenaries, and it pays professional troop upkeep.',
      ],
    },
    {
      id: 'setup-win-lose',
      title: 'How You Win And How Everyone Can Lose',
      lines: [
        'Capital troops decide the Basileus. Frontier troops fight the invasion.',
        'Build gold, protect Constantinople, and end with the best final score.',
      ],
    },
  ];
}

export function buildEconomyRulesFacts(state, playerId) {
  const player = getPlayer(state, playerId);
  const finance = getProjectedFinance(state, playerId);
  if (!player || !finance) return null;

  return {
    cards: [
      { label: 'Current gold', value: formatGold(player.gold) },
      { label: 'Next income', value: formatGold(finance.projectedIncome, { signed: true }) },
      { label: 'Next upkeep', value: formatGold(-finance.maintenance) },
      { label: 'Final score right now', value: `${finance.wealth}` },
    ],
    facts: [
      {
        label: 'How gold arrives',
        value: `Administration pays ${formatGold(finance.estateIncome)} from estates and ${formatGold(finance.officeIncome)} from offices.`,
      },
      {
        label: 'Current projected income',
        value: `${formatGold(finance.projectedIncome, { signed: true })} next Administration = ${formatGold(finance.estateIncome)} estate income + ${formatGold(finance.officeIncome)} office income.`,
      },
      {
        label: 'When upkeep is charged',
        value: `Cleanup charges ${formatGold(finance.maintenance)} if you keep ${pluralize(finance.maintenance, 'professional troop')}. Levies and mercenaries cost no upkeep because they leave play in Cleanup.`,
      },
      {
        label: 'What final scoring counts',
        value: `Final score = gold on hand + next Administration income. Right now that is ${player.gold} + ${finance.projectedIncome} = ${finance.wealth}.`,
      },
    ],
  };
}

export function buildProvinceRulesFacts(state, themeId) {
  const theme = state?.themes?.[themeId];
  if (!theme) return null;

  const regionLabel = getRegionLabel(theme.region);
  const ownerName = theme.owner === 'church'
    ? 'Church estate'
    : theme.owner != null
      ? `${getPlayerName(state, theme.owner)} estate`
      : 'Free estate';
  const strategosLabel = theme.strategos != null
    ? `${getOfficeDisplayName(state, `STRAT_${theme.id}`)} (${getPlayerName(state, theme.strategos)})`
    : 'No Strategos';
  const bishopLabel = theme.bishop != null
    ? `${getPlayerName(state, theme.bishop)}`
    : 'No Bishop';

  let ownerReceives = 'No dynasty receives province profit.';
  let taxGoesTo = `${formatGold(getNormalTaxIncome(theme))} enters the ${regionLabel} regional tax pool.`;
  let leviesGoTo = `${pluralize(theme.L, 'levy', 'levies')} enter the ${regionLabel} regional levy pool.`;

  if (theme.occupied) {
    ownerReceives = 'No profit while occupied.';
    taxGoesTo = 'No tax while occupied.';
    leviesGoTo = 'No levies while occupied.';
  } else if (theme.owner === 'church') {
    ownerReceives = 'No dynasty receives province profit.';
    taxGoesTo = `${formatGold(getNormalTaxIncome(theme))} goes to the church pool.`;
    leviesGoTo = `${pluralize(theme.L, 'levy', 'levies')} enter the ${regionLabel} regional levy pool.`;
  } else if (theme.taxExempt && theme.owner != null) {
    ownerReceives = `${getPlayerName(state, theme.owner)} receives ${formatGold(getTaxExemptOwnerIncome(theme))} during Administration: ${formatGold(theme.P)} profit + ${formatGold(theme.T)} tax.`;
    taxGoesTo = 'The estate owner keeps the tax this round because the province is tax exempt.';
    leviesGoTo = `${pluralize(theme.L, 'levy', 'levies')} enter the ${regionLabel} regional levy pool.`;
  } else {
    if (theme.owner != null) {
      ownerReceives = `${getPlayerName(state, theme.owner)} receives ${formatGold(getNormalOwnerIncome(theme))} during Administration from province profit.`;
    }
    if (theme.strategos != null) {
      taxGoesTo = `${getOfficeDisplayName(state, `STRAT_${theme.id}`)} receives ${formatGold(getNormalTaxIncome(theme))} directly during Administration.`;
      leviesGoTo = `${getOfficeDisplayName(state, `STRAT_${theme.id}`)} receives ${pluralize(theme.L, 'levy', 'levies')} directly during Administration.`;
    }
  }

  return {
    provinceName: theme.name,
    yieldLabel: formatProvinceYield(theme),
    facts: [
      { label: 'Region', value: regionLabel },
      { label: 'Current owner', value: theme.occupied ? 'Occupied by invaders' : ownerName },
      { label: 'Owner receives', value: ownerReceives },
      { label: 'Tax goes to', value: taxGoesTo },
      { label: 'Levies go to', value: leviesGoTo },
      { label: 'Price', value: `${formatGold(getThemeLandPrice(theme))} to buy this estate.` },
      {
        label: 'Tax exempt effect',
        value: theme.taxExempt
          ? `Active now: the estate owner keeps ${formatGold(theme.T)} tax this Administration.`
          : `If bought, tax exemption costs ${formatGold(getTaxExemptionCost(theme))}. The estate owner would keep ${formatGold(theme.T)} tax, and the province would pay no tax that round.`,
      },
      {
        label: 'Church-owned effect',
        value: theme.owner === 'church'
          ? 'Active now: province tax goes to the church pool, and province levies still enter the regional levy pool.'
          : 'If gifted to the church, province tax would go to the church pool and province levies would still enter the regional levy pool.',
      },
      {
        label: 'Occupied effect',
        value: theme.occupied
          ? 'Active now: occupied provinces produce no profit, no tax, and no levies.'
          : 'If occupied by the invasion, this province would produce no profit, no tax, and no levies until recovered.',
      },
      { label: 'Strategos', value: strategosLabel },
      { label: 'Bishop', value: bishopLabel },
    ],
  };
}

export function getRulesSections(state = null) {
  const titleDistribution = state
    ? `The required non-Basileus title distribution in this game is ${state.players.length === 3 ? '2-2' : state.players.length === 4 ? '2-1-1' : '1-1-1-1'}.`
    : 'A new Basileus must redistribute the four major offices using the required non-Basileus title distribution for this player count.';
  const patriarchHolder = state ? findTitleHolder(state, 'PATRIARCH') : null;

  return [
    {
      id: RULES_SECTION_IDS.GOAL,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.GOAL],
      summary: 'Win condition and shared loss condition',
      facts: [
        { label: 'How to win', value: 'Have the highest gold on hand + next Administration income at final scoring.' },
        { label: 'How everyone loses', value: 'If an invasion reaches Constantinople, the empire falls and no dynasty wins.' },
      ],
    },
    {
      id: RULES_SECTION_IDS.ROUND,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.ROUND],
      summary: 'Exact turn order and timing',
      facts: [
        { label: 'Round order', value: 'Invasion -> Administration -> Court -> Secret Orders -> Resolution -> Cleanup.' },
        { label: 'Administration', value: 'Automatic. The game pays income and raises levies before any player acts.' },
        { label: 'Court', value: 'Public. Players appoint offices, manage estates, change privileges, recruit professional troops, and hire mercenaries.' },
        { label: 'Secret Orders', value: 'Hidden. Players choose troop destinations and one claimant for the throne vote.' },
        { label: 'Resolution order', value: 'Reveal Orders -> Coup -> Invasion War -> Cleanup.' },
      ],
    },
    {
      id: RULES_SECTION_IDS.GOLD,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.GOLD],
      summary: 'What gold is and what it buys',
      facts: [
        { label: 'Stored resource', value: 'Gold is the only stored currency in the game.' },
        { label: 'Where gold comes from', value: 'Profit and tax become gold during Administration.' },
        { label: 'What gold buys', value: 'Gold pays for estates, tax exemptions, mercenaries, and professional troop upkeep.' },
      ],
    },
    {
      id: RULES_SECTION_IDS.PROFIT_TAX_LEVIES,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.PROFIT_TAX_LEVIES],
      summary: 'Exactly where province outputs go',
      facts: [
        { label: 'Profit', value: 'Province profit goes to the estate owner during Administration.' },
        { label: 'Tax', value: 'Tax exempt estate: owner keeps the tax. Strategos province: Strategos gets the tax. Church estate: tax goes to the church pool. Otherwise: tax enters the regional tax pool.' },
        { label: 'Regional tax cascade', value: 'Repeat until the pool is empty: 1 gold to the Basileus, 1 gold to that region major office, then 1 gold to the church pool. If the regional office is vacant, that middle step is skipped.' },
        { label: 'Constantinople tax cascade', value: 'The Basileus share from regional tax is redistributed 1 gold to the Basileus, 1 gold to the Empress, and 1 gold to the Chief of Eunuchs, repeating while that share remains.' },
        { label: 'Levies', value: 'Levies are temporary troops raised in Administration and removed in Cleanup.' },
        { label: 'Regional levy cascade', value: 'Repeat until the pool is empty: 2 levies to the region major office and 1 levy to the Basileus. If the regional office is vacant, those levies fall through to the Basileus.' },
        { label: 'Court-title levies', value: `Empress, Patriarch, and Chief of Eunuchs each receive exactly ${CAPITAL_LOCKED_TITLE_LEVIES} capital-only levies every Administration while appointed.` },
      ],
      examples: [
        {
          title: 'Regional tax example',
          lines: [
            'A province adds 4 tax to its regional tax pool.',
            'Distribution: 1 to Basileus, 1 to the region major office, 1 to the church pool, then 1 to Basileus.',
          ],
        },
        {
          title: 'Regional levies example',
          lines: [
            'A province adds 5 levies to its regional levy pool.',
            'Distribution: 2 to the region major office, 1 to the Basileus, then 2 to the region major office.',
          ],
        },
      ],
    },
    {
      id: RULES_SECTION_IDS.ESTATES,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.ESTATES],
      summary: 'Buying land, tax exemptions, and church gifts',
      facts: [
        { label: 'Buy estate', value: 'Land price = 2 x Profit. The buyer becomes the estate owner.' },
        { label: 'Private estate levies', value: 'The first time a province becomes privately owned, that province loses 1 levy.' },
        { label: 'Tax exemption', value: 'Tax exemption price = 2 x Tax. The estate owner pays the Basileus immediately. During Administration, that estate owner keeps the province tax and the province pays no tax that round.' },
        { label: 'Gift to church', value: 'The dynasty loses the estate. Province tax goes to the church pool, and province levies still enter the regional levy pool.' },
        { label: 'Province badge legend', value: 'P = Profit, T = Tax, L = Levies.' },
      ],
    },
    {
      id: RULES_SECTION_IDS.TITLES_AND_OFFICES,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.TITLES_AND_OFFICES],
      summary: 'What each office does',
      facts: [
        { label: 'Basileus', value: 'Receives the Basileus share of regional tax, spends troops on revocations, and keeps the throne in coup ties.' },
        { label: 'Domestics and Admiral', value: 'Receive regional tax and regional levies from their own region through the cascade.' },
        { label: 'Strategos', value: 'Receives that province tax and levies directly. A newly appointed Strategos office starts with 1 professional troop.' },
        { label: 'Patriarch', value: 'Receives church-pool income and appoints bishops.' },
        { label: 'Bishops', value: 'Each bishop receives 1 gold each church-pool cycle while gold remains.' },
        { label: 'Empress and Chief of Eunuchs', value: `Each receives ${CAPITAL_LOCKED_TITLE_LEVIES} capital-only levies every Administration while appointed.` },
      ],
    },
    {
      id: RULES_SECTION_IDS.CHURCH,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.CHURCH],
      summary: 'Church estates and church income',
      facts: [
        { label: 'Church estates', value: 'A church-owned province sends its tax to the church pool and its levies to the regional levy pool.' },
        { label: 'Church pool distribution', value: 'Repeat until the pool is empty: 2 gold to the Patriarch, then 1 gold to each Bishop. If the Patriarchate is vacant, that Patriarch share is not paid to anyone.' },
        { label: 'Bishop provinces', value: 'A bishop does not change province tax or levy routing unless the province is church-owned.' },
        { label: 'Current Patriarch', value: patriarchHolder == null ? 'No Patriarch is appointed right now.' : `${getPlayerName(state, patriarchHolder)} currently holds the Patriarchate.` },
      ],
      examples: [
        {
          title: 'Church pool example',
          lines: [
            'If the church pool has 5 gold and there are 2 bishops, the Patriarch gets 2, each bishop gets 1, and the Patriarch gets the last 1.',
            'Result: Patriarch 3, first bishop 1, second bishop 1.',
          ],
        },
      ],
    },
    {
      id: RULES_SECTION_IDS.ARMIES,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.ARMIES],
      summary: 'What troops do and how long they last',
      facts: [
        { label: 'Levies', value: 'Raised automatically in Administration. Removed in Cleanup.' },
        { label: 'Professional troops', value: 'Recruited in Court. Stay until dismissed. Cost 1 gold per troop in Cleanup.' },
        { label: 'Mercenary Company', value: 'Each dynasty has one Mercenary Company army. It can hold only mercenaries.' },
        { label: 'Mercenaries', value: `Hired only in Court through the Mercenary Company. Costs rise within the same round: ${formatGold(getMercenaryHireCost(0, 1))}, then ${formatGold(getMercenaryHireCost(1, 1))}, then ${formatGold(getMercenaryHireCost(2, 1))}, and so on. Mercenaries disband in Cleanup.` },
        { label: 'Capital vs frontier', value: 'Capital troops vote for Basileus. Frontier troops fight the invasion.' },
      ],
    },
    {
      id: RULES_SECTION_IDS.COUPS,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.COUPS],
      summary: 'How the throne vote works',
      facts: [
        { label: 'Who votes', value: 'Only capital troops vote for Basileus. Frontier troops never vote.' },
        { label: 'Who wins', value: 'The claimant with the highest capital troop total wins. The current Basileus wins all ties.' },
        { label: 'After a new Basileus wins', value: `The new Basileus must reassign all four major titles to non-Basileus players before the next round. ${titleDistribution}` },
      ],
      examples: [
        {
          title: 'Tie example',
          lines: [
            'If the current Basileus has 5 capital troops and another claimant also has 5 capital troops, the current Basileus keeps the throne.',
          ],
        },
      ],
    },
    {
      id: RULES_SECTION_IDS.INVASIONS,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.INVASIONS],
      summary: 'How the frontier war resolves',
      facts: [
        { label: 'Card information', value: 'Each invasion card shows a route and a strength range.' },
        { label: 'Rolled strength', value: 'Resolution rolls the exact invader strength from the shown range.' },
        { label: 'If frontier troops are higher', value: 'The empire recovers occupied provinces from the end of the route at costs 1, then 2, then 3, and so on.' },
        { label: 'If frontier troops are lower', value: 'The invasion captures new provinces from the start of the route at costs 1, then 2, then 3, and so on.' },
        { label: 'If tied', value: 'The invasion is a stalemate.' },
        { label: 'If Constantinople is reached', value: 'The game ends immediately in total defeat.' },
      ],
      examples: [
        {
          title: 'Advance and recovery costs',
          lines: [
            'Winning by a small margin only recovers the last provinces on the route that fit the 1, 2, 3... cost sequence.',
            'Losing by a small margin only captures the first provinces on the route that fit the same 1, 2, 3... cost sequence.',
          ],
        },
      ],
    },
    {
      id: RULES_SECTION_IDS.SCORING,
      title: RULES_SECTION_TITLES[RULES_SECTION_IDS.SCORING],
      summary: 'Exact final formula',
      facts: [
        { label: 'Final score', value: 'Gold on hand + next Administration income.' },
        { label: 'Winner', value: 'The dynasty with the highest total wins.' },
        { label: 'Empire loss', value: 'If Constantinople falls first, final scoring does not produce a winner.' },
      ],
    },
  ];
}
