// ui/rules.js - the one written copy of the rules.
//
// Rendered into the in-game "How to Play" card and exported to docs/rules.md
// by scripts/build-rules-doc.js, together with the glossary (ui/glossary.js). Numbers come
// from the engine so the text cannot drift from what the game enforces.
// Strings may use **bold**; everything else is plain text.
import { BALANCE } from '../data/balance.js';
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
const SECOND_CHOICE_PERCENT = Math.round((BALANCE.COUP_CHOICE_WEIGHTS?.[1] ?? 0.5) * 100);

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
          ['The map', `has ${PROVINCE_COUNT} provinces around Constantinople, in three regions: East, West and Sea. ${BISHOPRIC_COUNT} of them are bishoprics. ${START_LOST_COUNT} provinces start the game lost to invaders; the others are imperial.`],
          ['Offices.', `One dynasty, drawn at random, starts as Basileus. The ${word(MAJOR_TITLE_COUNT)} major offices (Domestic of the East, Domestic of the West, Admiral, Patriarch) are dealt to the other dynasties. No Strategos, Bishop or estate exists yet.`],
          ['Gold.', `Every dynasty receives ${BALANCE.STARTING_INCOME_GOLD} gold with the first income.`],
        ],
      },
    ],
  },
  {
    id: 'round',
    title: 'A Round',
    blocks: [
      { paragraph: 'Each round has four phases. Before the first, a new invasion is drawn and shown on the map with its route and estimated strength.' },
      {
        steps: [
          ['Offices.', `If the last coup crowned a new Basileus, they first hand out the ${word(MAJOR_TITLE_COUNT)} major offices. Then the Domestics and the Admiral appoint and revoke Strategoi in their region and the Patriarch appoints and revokes Bishops: up to ${word(BALANCE.MAJOR_OFFICE_ACTION_LIMIT)} actions per major office. The Basileus may make up to ${word(BALANCE.BASILEUS_REVOCATION_LIMIT)} revocations. Each dynasty locks when done; then income is paid.`],
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
          ['Estates:', '1 gold per estate in an imperial province.'],
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
          ['Revoking', 'takes a Strategos or Bishop away. One revocation by the Basileus takes all of one dynasty\'s estates in one province, except those built last round, with no refund.'],
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
          ['Building.', `Each round, a dynasty's first estate costs ${BALANCE.ESTATE_BASE_PRICE} gold, its second ${BALANCE.ESTATE_BASE_PRICE + 1}, its third ${BALANCE.ESTATE_BASE_PRICE + 2}, and so on. Estates can only be built in imperial provinces.`],
          ['Any number.', 'A province can hold any number of estates, owned by any dynasties.'],
          ['Secret.', 'Plans stay hidden until Deployment opens, when every plan is paid and built at once.'],
          ['Protection.', 'Estates built this round cannot be revoked in the next Offices phase.'],
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
          ['Mercenaries', `cost ${BALANCE.MERCENARY_BASE_PRICE} gold for the first, then 1 more for each next one, up to ${BALANCE.MAX_MERCENARIES}. They all go to the same place.`],
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
          ['Theodosian Walls:', `the Basileus always has ${BALANCE.THEODOSIAN_WALLS_SUPPORT} support.`],
          ['Patriarch\'s influence:', `${BALANCE.PATRIARCH_INFLUENCE} support that follows the Patriarch's choices like troops.`],
          ['Triumph:', `the best defender of the last war gets ${BALANCE.TRIUMPH_PER_PROVINCE} support per province won (see The War).`],
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
      { paragraph: 'All troops at the frontier fight the invasion. Its exact strength is drawn from the estimate when the war starts.' },
      {
        items: [
          ['Invader stronger.', 'The invader walks its route and pays for each province it takes with the strength it has over the frontier: the first imperial province costs 1, the next 2, then 3, and so on. Lost provinces cost nothing. It stops at the first province it cannot pay for.'],
          ['Constantinople', 'ends some routes. If the invader can pay for it too, the empire falls and nobody wins.'],
          ['Frontier stronger.', 'Its lead retakes lost provinces on the route the same way, 1, then 2, then 3, starting from the end nearest Constantinople.'],
          ['The ladder.', 'The invasion card and the "+N" tags on the map show how much the invader must beat the frontier by to take each province.'],
          ['Best defender.', `When the frontier wins, the dynasty with the most troops there gets ${BALANCE.BEST_DEFENDER_GOLD_PER_PROVINCE} gold and ${BALANCE.TRIUMPH_PER_PROVINCE} Triumph for each province its lead could pay for on the route, lost or not. Tied dynasties share: gold rounded up, Triumph rounded down.`],
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
