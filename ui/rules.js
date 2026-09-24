// ui/rules.js - the one written copy of the rules.
//
// Rendered into the in-game "How to Play" card, used for the per-phase guides,
// and exported to docs/rules.md by scripts/build-rules-doc.js. Numbers come
// from the engine so the text cannot drift from what the game enforces.
// Strings may use **bold**; everything else is plain text.
import { EARLY_INVASION_GRACE_ROUNDS } from '../data/invasions.js';
import { MAJOR_TITLES } from '../data/titles.js';
import {
  BASILEUS_COURT_REVOCATION_LIMIT,
  COURT_POWER_ACTION_LIMIT,
  PRIVATE_ESTATE_REVOCATION_COMPENSATION,
} from '../engine/actions.js';
import { BASILEUS_CAPITAL_SUPPORT, PATRIARCH_CAPITAL_SUPPORT } from '../engine/capitalSupport.js';
import { SCORE_CATEGORIES, SCORE_MAX_POINTS_PER_CATEGORY, SCORE_SHARE_STEP_PERCENT } from '../engine/scoring.js';
import { PLAYER_COUNT_MAX, PLAYER_COUNT_MIN } from '../engine/setup.js';
import { STARTING_INCOME_GOLD } from '../engine/turnflow.js';

const MAJOR_TITLE_COUNT = Object.keys(MAJOR_TITLES).length;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (value) => NUMBER_WORDS[value] || String(value);
const categoryList = SCORE_CATEGORIES.map((category) => category.label.toLowerCase());

export const RULES_TAGLINE = `A ${PLAYER_COUNT_MIN}-${PLAYER_COUNT_MAX} player game of dynastic profiteering inside the Byzantine Empire.`;

export const RULE_SECTIONS = [
  {
    id: 'goal',
    title: 'Goal',
    blocks: [
      { paragraph: `Hold the strongest balance of power when the game ends. After the last turn, Court resolves and a final income phase runs. Each dynasty then scores 1 point for every ${SCORE_SHARE_STEP_PERCENT}% share it holds of ${categoryList.slice(0, -1).join(', ')}, and ${categoryList.at(-1)} (church plus troop income) from that final income phase, up to ${SCORE_MAX_POINTS_PER_CATEGORY} points per category. Highest total wins.` },
      { paragraph: 'If invaders sack Constantinople, the empire falls and everyone loses; the final standings only record who held the strongest position in the collapse.' },
    ],
  },
  {
    id: 'round',
    title: 'A Round, Step By Step',
    blocks: [
      {
        steps: [
          ['Invasion drawn.', `A new threat appears with a route through the provinces. During the first ${word(EARLY_INVASION_GRACE_ROUNDS)} rounds invasions strike at most at easy strength. Limited invasions only launch while a province on their route is still imperial; skipped invasions can be drawn again later.`],
          ['Title redistribution.', `Only after a coup installs a new Basileus: they assign the ${word(MAJOR_TITLE_COUNT)} major titles before Court.`],
          ['Court.', `Each dynasty may make deals or skip. Major offices may make up to ${word(COURT_POWER_ACTION_LIMIT)} appointments or revocations in any mix; the Basileus may make up to ${word(BASILEUS_COURT_REVOCATION_LIMIT)} revocations.`],
          ['Income.', 'Estates pay gold, bishops collect church value, and offices raise troops automatically after Court.'],
          ['Estates.', 'Dynasties submit sealed bids for free-citizen land. Winning bids are revealed and settled when Deployment opens.'],
          ['Deployment.', 'Each dynasty funds office troops, hires mercenaries, chooses destinations, and ranks the claimants to the throne.'],
          ['Resolution.', 'The coup is decided first, then the war. Lost provinces become occupied; every province the empire can recover is reconquered automatically.'],
          ['Cleanup.', 'The new Basileus takes effect and the next turn begins. After the last turn, a final Court and income phase run before scoring, preceded by a title redistribution if the throne just changed hands.'],
        ],
      },
    ],
  },
  {
    id: 'money',
    title: 'Provinces & Money',
    blocks: [
      { paragraph: 'Each province outside Constantinople has three original values: **P** (profit to a private owner), **T** (troops raised by its office), and **C** (church gold). Constantinople has no provincial economy.' },
      {
        items: [
          ['Starting purse.', `Every dynasty receives ${STARTING_INCOME_GOLD} gold of starting income in the first round.`],
          ['Buying land', 'happens in Estates through sealed bids. The owner collects that profit during Income.'],
          ['Troops', "come from the province's troop value. A province with a Strategos sends its troops to that Strategos; otherwise they flow to the regional Domestic or Admiral, then to the Basileus."],
          ['Church value', 'goes directly to the province Bishop. Unassigned church value flows to the Patriarch.'],
          ['Occupation.', 'Lost provinces suspend their owner and strategos, keep their bishop, and pay only original church value to that bishop until reconquered.'],
        ],
      },
    ],
  },
  {
    id: 'titles',
    title: 'Titles & Appointments',
    blocks: [
      {
        items: [
          ['Basileus', 'may revoke strategoi and private estates, but may not appoint minor titles or revoke bishops.'],
          ['Domestic of the East / West', 'and the **Admiral** may appoint or revoke Strategoi in their region.'],
          ['Patriarch', 'may appoint or revoke Bishops in any province with original C ≥ 1, even if occupied.'],
          ['Major titles', 'never change in Court. They are redistributed only in the Title Redistribution phase.'],
          ['No repeats.', 'A player cannot appoint the same dynasty twice in a row; appointing someone else unlocks the previous appointee again. The same revoker cannot revoke the same target twice in a row.'],
          ['Revocations', `are free and count against each office's action limit. The same title cannot be appointed and revoked in the same turn.`],
          ['Private estates', `bought in the previous turn cannot be revoked yet. When an older private estate is revoked, its owner receives ${PRIVATE_ESTATE_REVOCATION_COMPENSATION} gold.`],
        ],
      },
    ],
  },
  {
    id: 'armies',
    title: 'Armies',
    blocks: [
      {
        items: [
          ['Office troops', "appear during Income and are assigned during Deployment. A player's Strategos troops deploy together as one combined Strategoi army."],
          ['Funding', 'is chosen per office. Unfunded troops stay home and pay 1 gold each to their controller.'],
          ['Mercenaries', 'are hired during Deployment. Their cost rises triangularly: 1, then +2, then +3, and so on. All hired mercenaries share one destination.'],
          ['Capital-locked troops', 'always defend the throne and cannot go to the frontier.'],
          ['Passive capital support', 'comes from offices and acclaim, always stays in Constantinople, cannot be defunded, and never counts for scoring or office troop shares.'],
        ],
      },
    ],
  },
  {
    id: 'coup-war',
    title: 'Coup & War',
    blocks: [
      {
        items: [
          ['Coup.', `Every funded capital troop follows its owner's ranking: first place gets full support, last place gets none, and the ranks between scale evenly. A claimant can be toggled off for 0 support without changing the weights of those ranked above. The Basileus starts with ${BASILEUS_CAPITAL_SUPPORT} passive capital support and the Patriarch with ${PATRIARCH_CAPITAL_SUPPORT}; temporary acclaim or unrest can adjust those totals for one round. Most support wins. Ties go to the tied claimant with the most Patriarchal support, then to the sitting Basileus, then to dynasty order. A new Basileus redistributes all ${word(MAJOR_TITLE_COUNT)} major titles at the start of the next round or the final reckoning.`],
          ['War.', 'Frontier troops minus invader strength. Win → reconquer occupied provinces along the route (cost 1, then +1, +1…). Lose → the invader advances along the route capturing provinces at the same rising cost. If a capital invasion reaches Constantinople, the empire falls; limited invasions stop after taking their target route.'],
          ['Best defender.', 'When the empire wins the war, the top frontier contributor gains 1 gold and 1 temporary Triumph support for each province the surplus could reconquer along the route, even if none remain to restore. Tied top contributors share it equally: gold rounds up, Triumph rounds down. Triumph follows their coup ranking and applies only during the next coup.'],
        ],
      },
    ],
  },
];

// Short, practical guides shown the first time a player reaches each phase.
export const PHASE_GUIDES = {
  title_redistribution: {
    title: 'Assign the offices',
    steps: [
      `As the new Basileus, give each of the ${word(MAJOR_TITLE_COUNT)} major offices to a dynasty.`,
      'Click an office circle, guide the rope to a dynasty, and click that dynasty to tie them together.',
      'Offices decide who appoints strategoi and bishops and where troops and church gold flow. Lock the offices when every rope is tied.',
    ],
  },
  court: {
    title: 'Court: appoint and revoke',
    steps: [
      `Each office you hold can make up to ${word(COURT_POWER_ACTION_LIMIT)} appointments or revocations; the Basileus can make up to ${word(BASILEUS_COURT_REVOCATION_LIMIT)} revocations.`,
      'To appoint, click a seat circle on the left, guide the rope, and click a dynasty on the right. Click a tied rope to cut it, which revokes that title.',
      'Planned actions only happen when you confirm the court plan. You can also open a deal with another dynasty, or skip Court entirely.',
    ],
  },
  estates: {
    title: 'Estates: bid for land',
    steps: [
      'Free provinces are sold in sealed bids. Choose an amount on any estate you want; rivals cannot see it.',
      'The highest bid wins when Deployment opens, and the owner collects that province\'s profit (P) each income phase.',
      'Gold you bid is committed until the bids settle, so keep enough for troops and mercenaries.',
    ],
  },
  deployment: {
    title: 'Deployment: send armies',
    steps: [
      'For each office army, choose how many troops to fund and send them to the frontier or the capital. Unfunded troops stay home and refund 1 gold each.',
      'Frontier troops fight the invasion; capital troops back your ranking of claimants in the coup.',
      'Rank the claimants to the throne (yourself included), optionally hire mercenaries, then lock your deployment.',
    ],
  },
  resolution: {
    title: 'Resolution',
    steps: [
      'The coup is decided first: capital troops follow each dynasty\'s ranking. Then frontier troops fight the invader.',
      'If you were the best defender, choose between restoring a province to the empire or taking gold.',
      'Press Continue when you have read the results.',
    ],
  },
};

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

function leadItemHtml([lead, text]) {
  return `<li><strong>${inlineHtml(lead)}</strong> ${inlineHtml(text)}</li>`;
}

export function renderRulesHtml() {
  return RULE_SECTIONS.map((section) => {
    const blocks = section.blocks.map((block) => {
      if (block.paragraph) return `<p>${inlineHtml(block.paragraph)}</p>`;
      if (block.steps) return `<ol>${block.steps.map(leadItemHtml).join('')}</ol>`;
      if (block.items) return `<ul>${block.items.map(leadItemHtml).join('')}</ul>`;
      return '';
    }).join('');
    return `<h3>${inlineHtml(section.title)}</h3>${blocks}`;
  }).join('');
}

export function renderPhaseGuideHtml(phase) {
  const guide = PHASE_GUIDES[phase];
  if (!guide) return '';
  return `<ol>${guide.steps.map((step) => `<li>${inlineHtml(step)}</li>`).join('')}</ol>`;
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
    }
  }
  lines.push('## Phase Guides', '');
  for (const guide of Object.values(PHASE_GUIDES)) {
    lines.push(`### ${guide.title}`, '');
    guide.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
