// ui/glossary.js - key words and their definitions.
//
// Anywhere in the game UI, these words are shown in bold and explain
// themselves when hovered (ui/glossaryTooltips.js). Definitions may use other
// key words, which are marked in turn, so a tooltip can be followed into the
// next one. Numbers come from the engine so definitions match the rules.
import { MAJOR_TITLES } from '../data/titles.js';
import { getBalance } from '../data/balance.js';
import { SCORE_MAX_POINTS_PER_CATEGORY, SCORE_SHARE_STEP_PERCENT } from '../engine/scoring.js';
import { PERSONALITIES } from '../ai/personalities.js';

const MAJOR_TITLE_COUNT = Object.keys(MAJOR_TITLES).length;

// Some numbers differ between maps: definitions read them for the map of the
// game on screen (set by the game controller), or the Classic map.
let glossaryMapId = null;

export function setGlossaryMap(mapId) {
  glossaryMapId = mapId || null;
}

function balance() {
  return getBalance(glossaryMapId);
}

// `aliases` are the spellings that get marked (matched as whole words, any
// case). `category` is shown above the definition.
export const GLOSSARY_TERMS = [
  // Offices
  {
    id: 'basileus',
    term: 'Basileus',
    category: 'Office',
    aliases: ['Basileus', 'emperor'],
    get definition() { return `The emperor. Hands out the ${MAJOR_TITLE_COUNT} major offices on taking the throne, is the only one who can revoke estates (up to ${balance().BASILEUS_REVOCATION_LIMIT} revocations in each Offices phase, and nothing else), raises 1 troop per ${balance().BASILEUS_PROVINCES_PER_TROOP} imperial provinces, and has the Theodosian Walls in every coup.`; },
  },
  {
    id: 'major-office',
    term: 'Major office',
    category: 'Office',
    aliases: ['major offices', 'major office'],
    definition: `One of the ${MAJOR_TITLE_COUNT} great offices below the throne: Domestic of the East, Domestic of the West, Admiral and Patriarch. Only a new Basileus hands them out again.`,
  },
  {
    id: 'minor-office',
    term: 'Minor office',
    category: 'Office',
    aliases: ['minor offices', 'minor office'],
    definition: 'A Strategos or a Bishop: one of each per province at most, appointed and revoked by a major office in the Offices phase.',
  },
  {
    id: 'domestic',
    term: 'Domestic',
    category: 'Office',
    aliases: ['Domestic of the East', 'Domestic of the West', 'Domestics', 'Domestic'],
    get definition() { return `Commands the eastern or the western provinces: appoints and revokes their Strategoi (up to ${balance().MAJOR_OFFICE_ACTION_LIMIT} actions per Offices phase) and raises 1 troop per imperial province of the region.`; },
  },
  {
    id: 'admiral',
    term: 'Admiral',
    category: 'Office',
    aliases: ['Admiral of the Fleet', 'Admiral'],
    get definition() { return `Commands the sea provinces: appoints and revokes their Strategoi (up to ${balance().MAJOR_OFFICE_ACTION_LIMIT} actions per Offices phase) and raises 1 troop per imperial sea province.`; },
  },
  {
    id: 'patriarch',
    term: 'Patriarch',
    category: 'Office',
    aliases: ['Patriarch', 'Patriarchal'],
    get definition() { return `Head of the Church: appoints and revokes Bishops (up to ${balance().MAJOR_OFFICE_ACTION_LIMIT} actions per Offices phase), receives 1 gold per imperial bishopric, and brings the Patriarch's influence to every coup.`; },
  },
  {
    id: 'strategos',
    term: 'Strategos',
    category: 'Office',
    aliases: ['Strategoi', 'Strategos'],
    definition: 'Governor of one province, appointed by the Domestic or Admiral of its region. Raises 1 troop there while the province is imperial. All of a dynasty\'s Strategos troops march as one army.',
  },
  {
    id: 'bishop',
    term: 'Bishop',
    category: 'Office',
    aliases: ['Bishops', 'Bishop'],
    definition: 'Holds one bishopric, appointed by the Patriarch. Receives 1 gold from it every income, even while it is lost.',
  },
  {
    id: 'bishopric',
    term: 'Bishopric',
    category: 'Map',
    aliases: ['bishoprics', 'bishopric'],
    definition: 'A province with a church, marked with a triangle on the map. Only bishoprics have Bishops.',
  },
  {
    id: 'appointment',
    term: 'Appointment',
    category: 'Offices',
    aliases: ['appointments', 'appointment', 'appoints', 'appoint'],
    definition: 'Giving a Strategos or Bishop office to a dynasty. An office cannot appoint the same dynasty twice in a row; appointing another dynasty unlocks the first again.',
  },
  {
    id: 'revocation',
    term: 'Revocation',
    category: 'Offices',
    aliases: ['revocations', 'revocation', 'revokes', 'revoke'],
    definition: 'Taking away a Strategos (by the Domestic or Admiral of the region) or a Bishop (by the Patriarch), or all of one dynasty\'s estates in one province, domain and all (by the Basileus only). A Strategos or estates in a lost province cannot be revoked.',
  },
  // Phases
  {
    id: 'offices',
    term: 'Offices',
    category: 'Phase',
    aliases: ['Offices phase', 'Offices'],
    caseSensitive: true,
    definition: 'The first phase of a round. A new Basileus first hands out the major offices; then the major offices appoint and revoke, and the Basileus may revoke estates. Income is paid when every dynasty has locked.',
  },
  {
    id: 'income',
    term: 'Income',
    category: 'Phase',
    aliases: ['Income'],
    definition: 'Paid at the end of the Offices phase: troops to Strategoi, Domestics, the Admiral and the Basileus; gold to Bishops, the Patriarch and estate owners. Lost provinces produce no troops and no estate gold.',
  },
  {
    id: 'estate',
    term: 'Estate',
    category: 'Economy',
    aliases: ['Estates', 'Estate'],
    get definition() { return `Land a dynasty owns in a province: pays it 1 gold every income while the province is imperial. A province can hold any number of estates of any dynasties. In the Estates phase each dynasty secretly plans new ones, at ${balance().ESTATE_PRICE} gold each.`; },
  },
  {
    id: 'domain',
    term: 'Domain',
    category: 'Economy',
    aliases: ['domains', 'domain'],
    get definition() { return `Every ${balance().ESTATE_DOMAIN_SIZE} estates a dynasty holds in one province: pays ${balance().ESTATE_DOMAIN_BONUS} more gold every income. A domain is also a bigger target, since one revocation takes all of a dynasty's estates in a province.`; },
  },
  {
    id: 'deployment',
    term: 'Deployment',
    category: 'Phase',
    aliases: ['Deployment'],
    definition: 'Each dynasty secretly sends its armies to the frontier or to Constantinople, dismisses the troops it does not field, hires mercenaries and makes its coup choices.',
  },
  {
    id: 'resolution',
    term: 'Resolution',
    category: 'Phase',
    aliases: ['Resolution'],
    definition: 'Orders are revealed. The coup is decided first, then the war is fought.',
  },
  {
    id: 'final-reckoning',
    term: 'Final reckoning',
    category: 'Phase',
    aliases: ['final reckoning'],
    definition: 'After the last round, a final Offices phase and income, then the Balance of Power is scored.',
  },
  // Army
  {
    id: 'troop',
    term: 'Troop',
    category: 'Army',
    aliases: ['troops', 'troop'],
    definition: 'Raised by offices at every income and used in the same round\'s Deployment: fielded at the frontier or in Constantinople, or dismissed for gold.',
  },
  {
    id: 'dismissed',
    term: 'Dismissed troops',
    category: 'Army',
    aliases: ['dismissed troops', 'dismissed', 'dismiss'],
    get definition() { return `Troops a dynasty does not field in Deployment. Each pays it ${balance().GOLD_PER_DISMISSED_TROOP} gold instead.`; },
  },
  {
    id: 'mercenaries',
    term: 'Mercenaries',
    category: 'Army',
    aliases: ['mercenaries', 'mercenary'],
    get definition() { return `Troops hired with gold in Deployment, ${balance().MERCENARY_PRICE} gold each, up to ${balance().MAX_MERCENARIES}. All go to the same place.`; },
  },
  {
    id: 'frontier',
    term: 'Frontier',
    category: 'Army',
    aliases: ['frontier'],
    definition: 'Where the war is fought: the troops every dynasty sends there are added up against the invasion.',
  },
  {
    id: 'capital',
    term: 'Constantinople',
    category: 'Army',
    aliases: ['Constantinople', 'capital'],
    definition: 'The capital. Troops sent there support claimants in the coup instead of fighting. If an invasion takes it, the empire falls.',
  },
  // Throne
  {
    id: 'coup',
    term: 'Coup',
    category: 'Throne',
    aliases: ['coups', 'coup'],
    definition: 'Decided in every Resolution, before the war: the claimant with the most support becomes Basileus from the next round. If nobody has support, the Basileus stays. A tie goes to the claimant with more of the Patriarch\'s influence, then to the Basileus.',
  },
  {
    id: 'support',
    term: 'Support',
    category: 'Throne',
    aliases: ['support'],
    definition: 'What decides the coup: troops in Constantinople (following their coup choices), the Theodosian Walls, the Patriarch\'s influence, Triumph and Unrest.',
  },
  {
    id: 'coup-choice',
    term: 'Coup choices',
    category: 'Throne',
    aliases: ['first choice', 'second choice', 'claimant', 'claimants', 'coup choices', 'coup choice'],
    get definition() { return `Up to two claimants a dynasty backs, itself allowed: its troops in Constantinople give all their support to the first and ${Math.round((balance().COUP_CHOICE_WEIGHTS?.[1] ?? 0.5) * 100)}% to the second. With no choice, they back nobody.`; },
  },
  {
    id: 'theodosian-walls',
    term: 'Theodosian Walls',
    category: 'Throne',
    aliases: ['Theodosian Walls'],
    get definition() { return `The walls of Constantinople: ${balance().THEODOSIAN_WALLS} support for the Basileus in every coup, and ${balance().THEODOSIAN_WALLS} more strength an invader needs to take Constantinople.`; },
  },
  {
    id: 'patriarch-influence',
    term: "Patriarch's influence",
    category: 'Throne',
    aliases: ["Patriarch's influence"],
    get definition() { return `${balance().PATRIARCH_INFLUENCE} support in every coup that follows the Patriarch's coup choices like troops: all to the first choice, half to the second.`; },
  },
  {
    id: 'triumph',
    term: 'Triumph',
    category: 'Throne',
    aliases: ['Triumph'],
    get definition() { return `Support for the best defender of the last war, for that dynasty itself, in the next coup only: ${balance().WAR_REWARD_TRIUMPH_PER_PROVINCE} for each province won.`; },
  },
  {
    id: 'unrest',
    term: 'Unrest',
    category: 'Throne',
    aliases: ['unrest'],
    get definition() { return `${balance().UNREST_PER_LOST_PROVINCE} less support per province lost in the last war, for the Basileus who lost them, in the next coup only.`; },
  },
  // War
  {
    id: 'invasion',
    term: 'Invasion',
    category: 'War',
    aliases: ['invasions', 'invasion', 'invaders', 'invader'],
    get definition() { return `This round's enemy: a route of provinces, shown on the map, and a strength known when it is drawn: ${balance().INVASION_STRENGTH_PER_PROVINCE} for every imperial province on its route, plus ${balance().INVASION_STRENGTH_PER_ROUND} for every round so far. If it beats the frontier, it takes provinces along its route.`; },
  },
  {
    id: 'ladder',
    term: 'Invasion ladder',
    category: 'War',
    aliases: ['invasion ladder', 'ladder'],
    get definition() { return `What each step of an invasion's route costs the invader, out of what it beats the frontier by: ${balance().PROVINCE_WAR_COST} to take an imperial province, nothing to cross a lost one, and ${balance().PROVINCE_WAR_COST} plus the Theodosian Walls for Constantinople. Shown as "+N" tags on the map; the invasion card adds them up.`; },
  },
  {
    id: 'imperial',
    term: 'Imperial province',
    category: 'Map',
    aliases: ['imperial provinces', 'imperial province', 'imperial'],
    definition: 'A province the empire holds. Only imperial provinces raise troops and pay estate gold.',
  },
  {
    id: 'lost',
    term: 'Lost province',
    category: 'Map',
    aliases: ['lost provinces', 'lost province', 'lost'],
    definition: 'A province held by invaders. Its Strategos and estates stay on record but produce nothing, and cannot be revoked, until the empire retakes it. Its Bishop is still paid.',
  },
  {
    id: 'reconquest',
    term: 'Reconquest',
    category: 'War',
    aliases: ['reconquest', 'reconquer', 'reconquered', 'retake', 'retaken', 'retakes'],
    get definition() { return `When the frontier wins, its lead retakes lost provinces on the route, ${balance().PROVINCE_WAR_COST} each, starting from the end nearest Constantinople.`; },
  },
  {
    id: 'best-defender',
    term: 'Best defender',
    category: 'War',
    aliases: ['best defenders', 'best defender'],
    get definition() { return `The dynasty with the most troops at the frontier in a won war. For each province of the route the frontier's lead could pay for (${balance().PROVINCE_WAR_COST} each), lost or not, it gets ${balance().WAR_REWARD_GOLD_PER_PROVINCE} gold and ${balance().WAR_REWARD_TRIUMPH_PER_PROVINCE} Triumph.`; },
  },
  {
    id: 'fall',
    term: 'Fall of the empire',
    category: 'War',
    aliases: ['empire falls', 'empire fell', 'fall of the empire'],
    definition: 'If an invasion takes Constantinople, the game ends at once and nobody wins.',
  },
  // Scoring
  {
    id: 'balance-of-power',
    term: 'Balance of Power',
    category: 'Scoring',
    aliases: ['Balance of Power'],
    definition: `How the game is won: 1 point per ${SCORE_SHARE_STEP_PERCENT}% share of all the gold, estate income and office income, up to ${SCORE_MAX_POINTS_PER_CATEGORY} points each. The two incomes are those of the final income.`,
  },
  // AI temperaments: explained when hovering an AI's name, not listed in the rules.
  ...PERSONALITIES.map((personality) => ({
    id: `personality-${personality.id}`,
    term: personality.title,
    category: 'AI temperament',
    hiddenFromIndex: true,
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
