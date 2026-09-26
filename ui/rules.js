// ui/rules.js - the one written copy of the rules.
//
// Rendered into the in-game "How to Play" card and exported to docs/rules.md
// by scripts/build-rules-doc.js, together with the glossary (ui/glossary.js). Numbers come
// from the engine so the text cannot drift from what the game enforces.
// Strings may use **bold**; everything else is plain text.
import { BALANCE, MAP_BALANCE } from '../data/balance.js';
import { MAPS } from '../data/maps/index.js';
import { MAJOR_TITLES } from '../data/titles.js';
import { SCORE_CATEGORIES, SCORE_MAX_POINTS_PER_CATEGORY, SCORE_SHARE_STEP_PERCENT } from '../engine/scoring.js';
import { DEFAULT_TURN_COUNT, PLAYER_COUNT_MAX, PLAYER_COUNT_MIN } from '../engine/setup.js';
import { PROVINCES } from '../data/provinces.js';
import { renderIcon } from './icons.js';
import { GLOSSARY_TERMS } from './glossary.js';

const MAJOR_TITLE_COUNT = Object.keys(MAJOR_TITLES).length;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (value) => NUMBER_WORDS[value] || String(value);
const categoryList = SCORE_CATEGORIES.map((category) => category.label.toLowerCase());

export const RULES_TAGLINE = `A game for ${PLAYER_COUNT_MIN} to ${PLAYER_COUNT_MAX} players. Each leads a noble dynasty of the Byzantine Empire, grows rich from its offices and estates, and plots for the throne while invaders close in.`;

const START_LOST_COUNT = PROVINCES.filter((province) => province.startLost).length;
const PROVINCE_COUNT = PROVINCES.filter((province) => province.id !== 'CPL').length;
const BISHOPRIC_COUNT = PROVINCES.filter((province) => (Number(province.C) || 0) > 0).length;
// How the Maps section names each value a map can change (MAP_BALANCE).
export const MAP_VALUE_LABELS = {
  STARTING_INCOME_GOLD: 'starting gold',
  BASILEUS_REVOCATION_LIMIT: 'estate revocations by the Basileus per round',
  MAX_MERCENARIES: 'most mercenaries a dynasty can hire',
  THEODOSIAN_WALLS: 'Theodosian Walls',
  PATRIARCH_INFLUENCE: 'Patriarch\'s influence',
  UNREST_PER_LOST_PROVINCE: 'Unrest per lost province',
  INVASION_STRENGTH_PER_PROVINCE: 'invasion strength per imperial province on its route',
  INVASION_STRENGTH_PER_ROUND: 'invasion strength added every round',
};

function describeMapRules(map) {
  const provinces = map.provinces.filter((province) => province.id !== 'CPL');
  const bishoprics = provinces.filter((province) => (Number(province.C) || 0) > 0).length;
  const lost = provinces.filter((province) => province.startLost).length;
  const changes = Object.entries(MAP_BALANCE[map.id] || {})
    .filter(([key, value]) => MAP_VALUE_LABELS[key] && value !== BALANCE[key])
    .map(([key, value]) => `${MAP_VALUE_LABELS[key]} ${value} (Classic ${BALANCE[key]})`);
  const base = `${provinces.length} provinces, ${bishoprics} of them bishoprics; ${lost} start lost.`;
  if (!changes.length) return base;
  return `${base} Every province raises 1 troop, so armies, invasions and income are smaller. Values that differ from the Classic map: ${changes.join('; ')}. Everything else is the same.`;
}

const SECOND_CHOICE_PERCENT = Math.round((BALANCE.COUP_CHOICE_WEIGHTS?.[1] ?? 0.5) * 100);
const WAR_COST = BALANCE.PROVINCE_WAR_COST;
const DOMAIN_SIZE = BALANCE.ESTATE_DOMAIN_SIZE;
const DOMAIN_BONUS = BALANCE.ESTATE_DOMAIN_BONUS;

export const RULE_SECTIONS = [
  {
    id: 'goal',
    title: 'Goal',
    blocks: [
      { paragraph: `The game lasts a set number of rounds (${DEFAULT_TURN_COUNT} unless you choose otherwise). When it ends, each dynasty scores 1 point for every ${SCORE_SHARE_STEP_PERCENT}% it holds of all the ${categoryList.slice(0, -1).join(', ')} and ${categoryList.at(-1)} in the game, up to ${SCORE_MAX_POINTS_PER_CATEGORY} points in each. The highest total wins.` },
      { paragraph: 'If an invasion takes Constantinople, the empire falls and the game ends at once: nobody wins.' },
    ],
  },
  {
    id: 'symbols',
    title: 'Symbols',
    blocks: [
      {
        legend: [
          ['troop', 'Troops', 'raised by offices every round, and hired as mercenaries.'],
          ['gold', 'Gold', 'paid by estates, bishoprics and dismissed troops; spent on estates and mercenaries.'],
          ['support', 'Support', 'what decides the coup: troops in Constantinople and the other sources of support.'],
          ['marker-estate', 'Estate', 'a circle in the dynasty\'s colour on a province, with the number of estates it holds there.'],
          ['marker-strategos', 'Strategos', 'a square on a province; hollow while no Strategos is appointed.'],
          ['marker-bishop', 'Bishopric', 'a triangle on a province that has a church; hollow while it has no Bishop.'],
          ['marker-lost', 'Lost province', 'faded markers and a "Lost" tag: the province is held by invaders.'],
        ],
      },
    ],
  },
  {
    id: 'start',
    title: 'Game Start',
    blocks: [
      {
        items: [
          ['The map', `has provinces around Constantinople in three regions: East, West and Sea. On the Classic map there are ${PROVINCE_COUNT}; ${BISHOPRIC_COUNT} of them are bishoprics and ${START_LOST_COUNT} start the game lost to invaders; the others are imperial. See Maps for the Compact map.`],
          ['Offices.', `One dynasty, drawn at random, starts as Basileus. The ${word(MAJOR_TITLE_COUNT)} major offices (Domestic of the East, Domestic of the West, Admiral, Patriarch) are dealt to the other dynasties. No Strategos, Bishop or estate exists yet.`],
          ['Gold.', `Every dynasty receives ${BALANCE.STARTING_INCOME_GOLD} gold with the first income.`],
        ],
      },
    ],
  },
  {
    id: 'maps',
    title: 'Maps',
    blocks: [
      { paragraph: 'Choose the map when you set up a game. The rules are the same on both.' },
      { items: Object.values(MAPS).map((map) => [`${map.name}:`, describeMapRules(map)]) },
    ],
  },
  {
    id: 'round',
    title: 'A Round',
    blocks: [
      { paragraph: 'Each round has four phases. Before the first, a new invasion is drawn and shown on the map with its route and its strength.' },
      {
        steps: [
          ['Offices.', `If the last coup crowned a new Basileus, they first hand out the ${word(MAJOR_TITLE_COUNT)} major offices. Then the Domestics and the Admiral appoint and revoke Strategoi in their region and the Patriarch appoints and revokes Bishops: up to ${word(BALANCE.MAJOR_OFFICE_ACTION_LIMIT)} actions per major office. The Basileus may revoke estates, up to ${word(BALANCE.BASILEUS_REVOCATION_LIMIT)} times. Each dynasty locks when done; then income is paid.`],
          ['Estates.', 'Each dynasty secretly plans the estates it builds this round.'],
          ['Deployment.', 'Each dynasty secretly sends its armies to the frontier or to Constantinople, hires mercenaries and chooses who it backs in the coup.'],
          ['Resolution.', 'All orders are revealed. The coup is decided first, then the war is fought. Then the next round begins.'],
        ],
      },
    ],
  },
  {
    id: 'income',
    title: 'Income',
    blocks: [
      { paragraph: 'Paid at the end of the Offices phase. Only imperial provinces produce troops and estate gold.' },
      {
        items: [
          ['Strategos:', '1 troop from their province.'],
          ['Domestic of the East / West, Admiral:', '1 troop per imperial province of their region, whether or not it has a Strategos.'],
          ['Basileus:', `1 troop per ${BALANCE.BASILEUS_PROVINCES_PER_TROOP} imperial provinces, rounded down.`],
          ['Patriarch:', '1 gold per imperial bishopric.'],
          ['Bishop:', '1 gold per bishopric they hold, even a lost one.'],
          ['Estates:', `1 gold per estate in an imperial province, and ${DOMAIN_BONUS} more for each domain (every ${word(DOMAIN_SIZE)} estates a dynasty holds in one province).`],
        ],
      },
      { paragraph: 'Troops are used in the Deployment phase of the same round; troops not sent anywhere are dismissed for gold.' },
    ],
  },
  {
    id: 'offices',
    title: 'Offices',
    blocks: [
      {
        items: [
          ['Appointing.', 'A Strategos can only be appointed in an imperial province, a Bishop in any bishopric. A dynasty may hold any number of minor offices, including through its own appointments.'],
          ['No repeats.', 'An office cannot appoint the same dynasty twice in a row: appointing another dynasty unlocks the first again. The same holds for revoking the same target twice in a row.'],
          ['Revoking.', 'A Domestic or the Admiral may revoke the Strategoi of their region, the Patriarch any Bishop. Only the Basileus revokes estates, and cannot revoke anything else: one revocation takes all of one dynasty\'s estates in one province, even those built last round, with no refund.'],
          ['Lost provinces.', 'No Strategos can be appointed in a lost province, and its Strategos and estates cannot be revoked: they stay on record and work again when the province is retaken. Its Bishop can still be appointed and revoked.'],
          ['Major offices', 'only change hands when a new Basileus hands them all out.'],
        ],
      },
    ],
  },
  {
    id: 'estates',
    title: 'Estates',
    blocks: [
      {
        items: [
          ['Building.', `Every estate costs ${BALANCE.ESTATE_PRICE} gold, however many a dynasty builds. Estates can only be built in imperial provinces.`],
          ['Any number.', 'A province can hold any number of estates, owned by any dynasties.'],
          ['Domains.', `Every ${word(DOMAIN_SIZE)} estates a dynasty holds in one province form a domain, which pays ${DOMAIN_BONUS} more gold every income: ${word(DOMAIN_SIZE)} estates there pay ${DOMAIN_SIZE + DOMAIN_BONUS}, ${word(DOMAIN_SIZE * 2)} pay ${DOMAIN_SIZE * 2 + DOMAIN_BONUS * 2}. A domain is also a bigger target: one revocation by the Basileus takes all of a dynasty's estates in a province, and a lost province pays nothing.`],
          ['Secret.', 'Plans stay hidden until Deployment opens, when every plan is paid and built at once. New estates can be revoked from the next Offices phase.'],
        ],
      },
    ],
  },
  {
    id: 'deployment',
    title: 'Deployment',
    blocks: [
      {
        items: [
          ['Armies.', 'Each office\'s troops form one army; a dynasty\'s Strategos troops form one army together. Send each army to the frontier or to Constantinople, and choose how many of its troops to field.'],
          ['Dismissed troops', `are the troops you do not field: they pay you ${BALANCE.GOLD_PER_DISMISSED_TROOP} gold each instead.`],
          ['Mercenaries', `cost ${BALANCE.MERCENARY_PRICE} gold each, up to ${BALANCE.MAX_MERCENARIES}. They all go to the same place.`],
          ['Coup choices.', `Choose up to two claimants to the throne, yourself allowed. Your troops in Constantinople give all their support to your first choice and ${SECOND_CHOICE_PERCENT}% to your second.`],
        ],
      },
    ],
  },
  {
    id: 'coup',
    title: 'The Coup',
    blocks: [
      { paragraph: 'The claimant with the most support becomes Basileus from the next round. If nobody has any support, the Basileus stays.' },
      {
        items: [
          ['Troops in Constantinople', `follow their dynasty's choices: all to the first, ${SECOND_CHOICE_PERCENT}% to the second.`],
          ['Theodosian Walls:', `the Basileus always has ${BALANCE.THEODOSIAN_WALLS} support. The Walls also defend Constantinople in war (see The War).`],
          ['Patriarch\'s influence:', `${BALANCE.PATRIARCH_INFLUENCE} support that follows the Patriarch's choices like troops.`],
          ['Triumph:', 'support for the best defender of the last war (see The War).'],
          ['Unrest:', `a Basileus who lost provinces in the last war has ${BALANCE.UNREST_PER_LOST_PROVINCE} less support per lost province.`],
          ['Ties', 'go to the claimant with more of the Patriarch\'s influence, then to the Basileus, then to the first in seating order.'],
        ],
      },
    ],
  },
  {
    id: 'war',
    title: 'The War',
    blocks: [
      { paragraph: `All troops at the frontier fight the invasion. Its strength is known when it is drawn: ${BALANCE.INVASION_STRENGTH_PER_PROVINCE} for every imperial province on its route, as much as taking it costs (the farther the empire reaches toward the invader, the stronger it is, and no province holds on its own), plus ${BALANCE.INVASION_STRENGTH_PER_ROUND} for every round of the game so far (the threat grows every round).` },
      {
        items: [
          ['Invader stronger.', `What the invader beats the frontier by pays for its route, step by step: ${WAR_COST} to take each imperial province; land already lost offers no resistance. It stops at the first step it cannot pay for.`],
          ['Constantinople', `ends some routes. It costs the invader ${WAR_COST} plus the Theodosian Walls (${BALANCE.THEODOSIAN_WALLS}). If the invader can pay for it too, the empire falls and nobody wins.`],
          ['Frontier stronger.', `Its lead retakes lost provinces on the route, ${WAR_COST} each, starting from the end nearest Constantinople.`],
          ['The ladder.', 'The "+N" tags on the map show what each step of the route costs the invader. The invasion card adds them up: how many troops hold every province, and how many save Constantinople.'],
          ['Best defender.', `When the frontier wins, the dynasty with the most troops there earns ${BALANCE.WAR_REWARD_GOLD_PER_PROVINCE} gold and ${BALANCE.WAR_REWARD_TRIUMPH_PER_PROVINCE} Triumph for each province of the route the lead could pay for at ${WAR_COST} each, lost or not. Tied dynasties share: gold rounded up, Triumph rounded down.`],
        ],
      },
    ],
  },
  {
    id: 'end',
    title: 'End of the Game',
    blocks: [
      { paragraph: `After the last round's Resolution, a final Offices phase is played (after the major offices are handed out if the throne changed) and income is paid. Then the Balance of Power is scored: 1 point per ${SCORE_SHARE_STEP_PERCENT}% share of ${categoryList.join(', ')}, up to ${SCORE_MAX_POINTS_PER_CATEGORY} points each. Gold counts what each dynasty holds; the two incomes count the final income.` },
    ],
  },
];

function escapeText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineHtml(text) {
  return escapeText(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function legendSymbolHtml(kind) {
  if (kind.startsWith('marker-')) return `<span class="rules-marker ${kind}" aria-hidden="true"></span>`;
  return renderIcon(kind);
}

function leadItemHtml([lead, text]) {
  return `<li><strong>${inlineHtml(lead)}</strong> ${inlineHtml(text)}</li>`;
}

export function renderRulesHtml() {
  return RULE_SECTIONS.map((section) => {
    const blocks = section.blocks.map((block) => {
      if (block.paragraph) return `<p>${inlineHtml(block.paragraph)}</p>`;
      if (block.steps) return `<ol>${block.steps.map(leadItemHtml).join('')}</ol>`;
      if (block.items) return `<ul>${block.items.map(leadItemHtml).join('')}</ul>`;
      if (block.legend) {
        return `<ul class="rules-legend">${block.legend.map(([kind, name, text]) => `<li>${legendSymbolHtml(kind)}<strong>${inlineHtml(name)}</strong> ${inlineHtml(text)}</li>`).join('')}</ul>`;
      }
      return '';
    }).join('');
    return `<h3>${inlineHtml(section.title)}</h3>${blocks}`;
  }).join('');
}

// Every key word the game explains on hover, as a list.
export function renderGlossaryHtml() {
  const entries = GLOSSARY_TERMS
    .filter((entry) => !entry.hiddenFromIndex)
    .map((entry) => `<dt>${escapeText(entry.term)}</dt><dd>${escapeText(entry.definition)}</dd>`)
    .join('');
  return `<h3>Glossary</h3><dl class="glossary-index">${entries}</dl>`;
}

export function renderRulesMarkdown() {
  const lines = [
    '# Basileus Rules',
    '',
    '<!-- Generated from ui/rules.js by `npm run build:rules-doc`; edit that file instead. -->',
    '',
    RULES_TAGLINE,
    '',
  ];
  for (const section of RULE_SECTIONS) {
    lines.push(`## ${section.title}`, '');
    for (const block of section.blocks) {
      if (block.paragraph) lines.push(block.paragraph, '');
      if (block.steps) {
        block.steps.forEach(([lead, text], index) => lines.push(`${index + 1}. **${lead}** ${text}`));
        lines.push('');
      }
      if (block.items) {
        block.items.forEach(([lead, text]) => lines.push(`- **${lead}** ${text}`));
        lines.push('');
      }
      if (block.legend) {
        block.legend.forEach(([, name, text]) => lines.push(`- **${name}**: ${text}`));
        lines.push('');
      }
    }
  }
  lines.push('## Glossary', '');
  for (const entry of GLOSSARY_TERMS.filter((item) => !item.hiddenFromIndex)) lines.push(`- **${entry.term}** (${entry.category.toLowerCase()}): ${entry.definition}`);
  return `${lines.join('\n').trimEnd()}\n`;
}
