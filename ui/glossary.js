// ui/glossary.js - key words and their definitions.
//
// Anywhere in the game UI, these words are shown in bold and explain
// themselves when hovered (ui/glossaryTooltips.js). Definitions may use other
// key words, which are marked in turn, so a tooltip can be followed into the
// next one. Numbers come from the engine so definitions match the rules.
import { MAJOR_TITLES } from '../data/titles.js';
import { BALANCE } from '../data/balance.js';
import { SCORE_MAX_POINTS_PER_CATEGORY, SCORE_SHARE_STEP_PERCENT } from '../engine/scoring.js';
import { PERSONALITIES } from '../ai/personalities.js';

const MAJOR_TITLE_COUNT = Object.keys(MAJOR_TITLES).length;

// `aliases` are the spellings that get marked (matched as whole words, any
// case). `category` is shown above the definition.
export const GLOSSARY_TERMS = [
  {
    id: 'basileus',
    term: 'Basileus',
    category: 'Office',
    aliases: ['Basileus', 'emperor'],
    definition: `The emperor. Starts every coup with ${BALANCE.THEODOSIAN_WALLS_SUPPORT} passive capital support, may make up to ${BALANCE.BASILEUS_REVOCATION_LIMIT} revocations of Strategoi and estates in Court, and hands out the major titles after taking the throne. Troops that no Strategos, Domestic or Admiral receives flow to the Basileus.`,
  },
  {
    id: 'major-titles',
    term: 'Major titles',
    category: 'Office',
    aliases: ['major titles', 'major title', 'major offices', 'major office'],
    definition: `The ${MAJOR_TITLE_COUNT} great offices: Domestic of the East, Domestic of the West, Admiral and Patriarch. They never change in Court; only a new Basileus reassigns them, in Title Redistribution.`,
  },
  {
    id: 'domestic',
    term: 'Domestic',
    category: 'Office',
    aliases: ['Domestic of the East', 'Domestic of the West', 'Domestics', 'Domestic'],
    definition: `Commander of the eastern or western provinces. Appoints and revokes Strategoi in that region, up to ${BALANCE.MAJOR_OFFICE_ACTION_LIMIT} actions per Court, and raises the troops of its provinces that have no Strategos.`,
  },
  {
    id: 'admiral',
    term: 'Admiral',
    category: 'Office',
    aliases: ['Admiral of the Fleet', 'Admiral'],
    definition: `Commander of the sea provinces. Appoints and revokes Strategoi there, up to ${BALANCE.MAJOR_OFFICE_ACTION_LIMIT} actions per Court, and raises the troops of sea provinces that have no Strategos.`,
  },
  {
    id: 'patriarch',
    term: 'Patriarch',
    category: 'Office',
    aliases: ['Patriarch', 'Patriarchal'],
    definition: `Head of the Church. Appoints and revokes Bishops and brings the Patriarch's influence (${BALANCE.PATRIARCH_INFLUENCE} support) to the coup, which follows the Patriarch's own coup choices. Breaks coup ties.`,
  },
  {
    id: 'strategos',
    term: 'Strategos',
    category: 'Office',
    aliases: ['Strategoi', 'Strategos'],
    definition: 'Military governor of one province, appointed by the Domestic or Admiral of its region. Receives the troops that province raises (its T value). All of a dynasty\'s Strategos troops march as one Strategoi army.',
  },
  {
    id: 'bishop',
    term: 'Bishop',
    category: 'Office',
    aliases: ['Bishops', 'Bishop'],
    definition: 'Church office over one province, appointed by the Patriarch. Collects that province\'s church gold (its C value), even while the province is occupied.',
  },
  {
    id: 'appointment',
    term: 'Appointment',
    category: 'Court',
    aliases: ['appointments', 'appointment', 'appoints', 'appoint'],
    definition: 'Giving a Strategos or Bishop seat to a dynasty during Court. No office may appoint the same dynasty twice in a row; appointing someone else unlocks them again.',
  },
  {
    id: 'revocation',
    term: 'Revocation',
    category: 'Court',
    aliases: ['revocations', 'revocation', 'revokes', 'revoke'],
    definition: `Taking a Strategos or Bishop away, or all of one dynasty's estates in one province. Each revocation uses one of the office's actions. Estates built last round cannot be revoked yet.`,
  },
  {
    id: 'title-redistribution',
    term: 'Title Redistribution',
    category: 'Phase',
    aliases: ['Title Redistribution'],
    definition: 'Happens only after a coup installs a new Basileus: before Court, they give each major title to a dynasty.',
  },
  {
    id: 'court',
    term: 'Court',
    category: 'Phase',
    aliases: ['Court'],
    definition: 'The political phase. Offices appoint and revoke titles. Nothing happens until each dynasty confirms its court plan.',
  },
  {
    id: 'income',
    term: 'Income',
    category: 'Phase',
    aliases: ['Income'],
    definition: 'Runs by itself after Court: estates pay their profit, Bishops collect church gold, and offices raise troops.',
  },
  {
    id: 'estate',
    term: 'Estate',
    category: 'Economy',
    aliases: ['private estates', 'private estate', 'Estates', 'Estate'],
    definition: 'A province owned by a dynasty. Its owner collects the province\'s profit (P) every Income. Free provinces are sold by sealed bid in the Estates phase; the Basileus can revoke an estate.',
  },
  {
    id: 'sealed-bid',
    term: 'Sealed bid',
    category: 'Economy',
    aliases: ['sealed bids', 'sealed bid'],
    definition: 'A secret offer of gold for a free province. The highest bid wins when Deployment opens. Gold you bid is set aside until then.',
  },
  {
    id: 'profit',
    term: 'Profit (P)',
    category: 'Economy',
    aliases: ['profit income', 'profit'],
    definition: 'The gold a province pays its private owner every Income.',
  },
  {
    id: 'church',
    term: 'Church (C)',
    category: 'Economy',
    aliases: ['church gold', 'church value', 'church income'],
    definition: 'The gold a province gives its Bishop every Income. Church value with no Bishop goes to the Patriarch.',
  },
  {
    id: 'deployment',
    term: 'Deployment',
    category: 'Phase',
    aliases: ['Deployment'],
    definition: 'Each dynasty secretly funds its office troops, hires mercenaries, sends them to the frontier or the capital, and ranks the claimants to the throne.',
  },
  {
    id: 'funding',
    term: 'Funding',
    category: 'Army',
    aliases: ['unfunded', 'funded', 'funding'],
    definition: 'Office troops only march when you pay for them. Unfunded troops stay home and pay 1 gold each to their controller instead.',
  },
  {
    id: 'mercenaries',
    term: 'Mercenaries',
    category: 'Army',
    aliases: ['mercenaries', 'mercenary'],
    definition: 'Troops hired with gold in Deployment. Each costs one more than the last (1, then 2, then 3...), and all of them go to the same destination.',
  },
  {
    id: 'frontier',
    term: 'Frontier',
    category: 'Army',
    aliases: ['frontier'],
    definition: 'Where the war is fought. Every dynasty\'s frontier troops add up against this round\'s invasion; sending none leaves the defence to the others.',
  },
  {
    id: 'capital',
    term: 'Constantinople',
    category: 'Army',
    aliases: ['Constantinople', 'capital'],
    definition: 'The seat of the throne. Troops sent to the capital vote in the coup instead of fighting. If an invasion reaches Constantinople, the empire falls.',
  },
  {
    id: 'coup',
    term: 'Coup',
    category: 'Throne',
    aliases: ['coups', 'coup'],
    definition: `The contest for the throne, decided in every Resolution before the war. Each dynasty's troops in Constantinople give full support to its first choice and half to its second. The claimant with the most support becomes Basileus; if nobody has any, the Basileus stays. A tie goes to the claimant with more of the Patriarch's influence, then to the Basileus.`,
  },
  {
    id: 'coup-choice',
    term: 'Coup choices',
    category: 'Throne',
    aliases: ['first choice', 'second choice', 'claimant', 'claimants', 'coup choice'],
    definition: `In Deployment each dynasty picks up to two claimants, itself allowed: its first choice gets full support from its troops in Constantinople, its second choice gets ${Math.round((BALANCE.COUP_CHOICE_WEIGHTS?.[1] ?? 0.5) * 100)}%. With no choice, those troops back nobody.`,
  },
  {
    id: 'theodosian-walls',
    term: 'Theodosian Walls',
    category: 'Throne',
    aliases: ['Theodosian Walls', 'walls'],
    definition: `The walls of Constantinople give the Basileus ${BALANCE.THEODOSIAN_WALLS_SUPPORT} support in every coup.`,
  },
  {
    id: 'patriarch-influence',
    term: "Patriarch's influence",
    category: 'Throne',
    aliases: ["Patriarch's influence", 'influence'],
    definition: `The Patriarch brings ${BALANCE.PATRIARCH_INFLUENCE} support to every coup. It follows the Patriarch's coup choices like troops do: all of it to the first choice, half to the second.`,
  },
  {
    id: 'triumph',
    term: 'Triumph',
    category: 'Throne',
    aliases: ['Triumph'],
    definition: `Support earned by the best defender: ${BALANCE.TRIUMPH_PER_PROVINCE} for each province the war surplus could reconquer. It counts for that dynasty itself in the next coup only.`,
  },
  {
    id: 'unrest',
    term: 'Unrest',
    category: 'Throne',
    aliases: ['unrest'],
    definition: `When the empire loses provinces, the Basileus who lost them has ${BALANCE.UNREST_PER_LOST_PROVINCE} less support per lost province in the next coup.`,
  },
  {
    id: 'invasion',
    term: 'Invasion',
    category: 'War',
    aliases: ['invasions', 'invasion', 'invaders', 'invader'],
    definition: 'This round\'s threat: an enemy with a strength range and a route of provinces. A capital invasion that breaks through can reach Constantinople; a limited invasion stops once it has taken its route.',
  },
  {
    id: 'resolution',
    term: 'Resolution',
    category: 'Phase',
    aliases: ['Resolution'],
    definition: 'Orders are revealed. The coup is decided first, then frontier troops fight the invasion.',
  },
  {
    id: 'lost',
    term: 'Occupied',
    category: 'War',
    aliases: ['lost'],
    definition: 'A province taken by invaders. Its owner and Strategos are suspended and its Bishop keeps only the original church value until the empire reconquers it.',
  },
  {
    id: 'reconquest',
    term: 'Reconquest',
    category: 'War',
    aliases: ['reconquest', 'reconquer', 'reconquered'],
    definition: 'When the empire wins a war, the surplus frontier troops recover occupied provinces along the route: the first costs 1 troop, the next 2, and so on.',
  },
  {
    id: 'best-defender',
    term: 'Best defender',
    category: 'War',
    aliases: ['best defenders', 'best defender'],
    definition: 'The dynasty that sent the most troops to the frontier in a won war. It gains gold and Triumph, and chooses for each recovered province whether to restore it to the empire or take gold instead.',
  },
  {
    id: 'fall',
    term: 'Fall of the empire',
    category: 'War',
    aliases: ['empire falls', 'empire fell', 'fall of the empire'],
    definition: 'If invaders sack Constantinople the game ends at once and every dynasty loses.',
  },
  {
    id: 'balance-of-power',
    term: 'Balance of Power',
    category: 'Scoring',
    aliases: ['Balance of Power'],
    definition: `How the game is won. Each dynasty scores 1 point per ${SCORE_SHARE_STEP_PERCENT}% share it holds of gold reserves, profit income and office income, up to ${SCORE_MAX_POINTS_PER_CATEGORY} points each. Highest total after the final reckoning wins.`,
  },
  {
    id: 'final-reckoning',
    term: 'Final reckoning',
    category: 'Phase',
    aliases: ['final reckoning'],
    definition: 'After the last turn, a last Court and Income phase run, then the Balance of Power is scored.',
  },
  ...PERSONALITIES.map((personality) => ({
    id: `personality-${personality.id}`,
    term: personality.title,
    category: 'AI temperament',
    aliases: [personality.title],
    caseSensitive: true,
    definition: personality.summary,
  })),
];

const TERMS_BY_ID = new Map(GLOSSARY_TERMS.map((entry) => [entry.id, entry]));

export function getGlossaryTerm(id) {
  return TERMS_BY_ID.get(id) || null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest aliases first, so "Domestic of the East" wins over "Domestic".
const ALIASES = GLOSSARY_TERMS
  .flatMap((entry) => entry.aliases.map((alias) => ({ alias, id: entry.id, caseSensitive: Boolean(entry.caseSensitive) })))
  .sort((left, right) => right.alias.length - left.alias.length);
const ALIAS_LOOKUP = new Map();
for (const entry of ALIASES) {
  const key = entry.caseSensitive ? entry.alias : entry.alias.toLowerCase();
  if (!ALIAS_LOOKUP.has(key)) ALIAS_LOOKUP.set(key, entry);
}
const ALIAS_PATTERN = new RegExp(`(?<![\\w-])(${ALIASES.map((entry) => escapeRegExp(entry.alias)).join('|')})(?![\\w-])`, 'gi');

function lookupAlias(text) {
  return ALIAS_LOOKUP.get(text) || (() => {
    const entry = ALIAS_LOOKUP.get(text.toLowerCase());
    return entry && !entry.caseSensitive ? entry : null;
  })();
}

// Key words found in `text`, in order: [{ id, start, end, text }].
// `skipIds` leaves some terms unmarked, such as the term a tooltip explains.
export function findGlossaryMatches(text, { skipIds = null } = {}) {
  const matches = [];
  const source = String(text || '');
  ALIAS_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(ALIAS_PATTERN)) {
    const entry = lookupAlias(match[0]);
    if (!entry || skipIds?.has(entry.id)) continue;
    matches.push({ id: entry.id, start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return matches;
}
