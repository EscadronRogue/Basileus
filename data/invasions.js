// data/invasions.js — Invasion routes and shared invasion strength bounds.

import { getInvasionOriginProfile } from './mapPoints.js';

export const INVASION_STRENGTH_RANGE = [10, 30];
export const INVASION_ESTIMATE_INTERVAL = 7;

// entryTheme is the first imperial theme hit by the gameplay route.
// originProfileId is the historical/geographic source used by the map renderer
// to derive the visible route origin from the current SVG calibration.
export const INVASIONS = validateInvasionDefinitions([
  {
    id: 'aghlabids',
    name: 'Aghlabids',
    entryTheme: 'SIC',
    originProfileId: 'ifriqiya',
    route: ['SIC', 'ITA', 'KEP', 'KRE', 'AEG', 'CPL'],
    color: '#c9a84c',
  },
  {
    id: 'kievan_rus',
    name: 'Kievan Rus',
    entryTheme: 'CHE',
    originProfileId: 'pontic_steppe',
    route: ['CHE', 'PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#5b8fb9',
  },
  {
    id: 'normans',
    name: 'Normans',
    entryTheme: 'ITA',
    originProfileId: 'norman_italy',
    route: ['ITA', 'SIC', 'DYR', 'KEP', 'NIK', 'HEL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#a35638',
  },
  {
    id: 'venetians',
    name: 'Venetians',
    entryTheme: 'KEP',
    originProfileId: 'venice',
    route: ['KEP', 'KRE', 'AEG', 'CPL'],
    color: '#2e6b5e',
  },
  {
    id: 'bulgars',
    name: 'Bulgars',
    entryTheme: 'BUL',
    originProfileId: 'bulgaria',
    route: ['BUL', 'PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#7a4988',
  },
  {
    id: 'serbs',
    name: 'Serbs',
    entryTheme: 'SRB',
    originProfileId: 'serbia',
    route: ['SRB', 'DAL', 'BUL', 'NIK', 'HEL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#b04050',
  },
  {
    id: 'hungarians',
    name: 'Hungarians',
    entryTheme: 'SIM',
    originProfileId: 'pannonia',
    route: ['SIM', 'CRO', 'SRB', 'DAL', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#3d7a3d',
  },
  {
    id: 'turks',
    name: 'Turks',
    entryTheme: 'VAS',
    originProfileId: 'persia',
    route: ['VAS', 'MES', 'KOL', 'SEB', 'CHA', 'KAP', 'ANA', 'BOU', 'ARM', 'PAP', 'OPT', 'CPL'],
    color: '#cc3333',
  },
  {
    id: 'caliphate',
    name: 'Caliphate',
    entryTheme: 'ANT',
    originProfileId: 'levant',
    route: ['ANT', 'CIL', 'KYP', 'SEL', 'KIB', 'AEG', 'SAM', 'THK', 'OPS', 'OPT', 'CPL'],
    color: '#d4a017',
  },
]);

export const DYNASTIES = [
  'Doukas', 'Phokas', 'Komnenos', 'Angeloi', 'Skleros',
  'Botaneiates', 'Diogenes', 'Bryennios', 'Dalassenos',
  'Kontostephanos', 'Kantakouzenos', 'Palaiologos'
];

// Dynasty colors — chosen to be clearly distinct from ALL reserved colors:
// region borders (forest green, crimson, cobalt, gold), free-citizen amethyst,
// church slate-blue, and invasion route colors.
// Hues used: teal, amber-orange, rose, chartreuse, warm brown — all unoccupied.
export const DYNASTY_COLORS = [
  '#c02020', // red
  '#1a50a0', // blue
  '#c89010', // yellow
  '#2a8030', // green
  '#d06010', // orange
];

function validateInvasionDefinitions(invasions) {
  const seenIds = new Set();

  for (const invasion of invasions) {
    if (!invasion?.id) throw new Error('Every invasion requires an id.');
    if (seenIds.has(invasion.id)) throw new Error(`Duplicate invasion id: ${invasion.id}`);
    seenIds.add(invasion.id);

    if (!Array.isArray(invasion.route) || invasion.route.length < 2) {
      throw new Error(`Invasion ${invasion.id} requires a route with at least two themes.`);
    }
    if (!invasion.entryTheme) throw new Error(`Invasion ${invasion.id} requires an entryTheme.`);
    if (invasion.route[0] !== invasion.entryTheme) {
      throw new Error(`Invasion ${invasion.id} entryTheme must match the first route theme.`);
    }
    if (!getInvasionOriginProfile(invasion.originProfileId)) {
      throw new Error(`Invasion ${invasion.id} references unknown origin profile: ${invasion.originProfileId}`);
    }
  }

  return Object.freeze(invasions.map((invasion) => Object.freeze({ ...invasion })));
}
