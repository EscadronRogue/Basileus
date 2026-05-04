// data/invasions.js — Invasion routes and shared invasion strength bounds.

export const INVASION_STRENGTH_RANGE = [10, 30];
export const INVASION_ESTIMATE_INTERVAL = 7;

export const INVASIONS = [
  {
    id: 'aghlabids',
    name: 'Aghlabids',
    origin: 'SIC',           // first theme on the route
    originLabel: 'North Africa',
    originPos: { cx: 100, cy: 440 },
    route: ['SIC', 'ITA', 'KEP', 'KRE', 'AEG', 'CPL'],
    color: '#c9a84c'
  },
  {
    id: 'kievan_rus',
    name: 'Kievan Rus',
    origin: 'CHE',
    originLabel: 'Steppes',
    originPos: { cx: 650, cy: 60 },
    route: ['CHE', 'PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#5b8fb9'
  },
  {
    id: 'normans',
    name: 'Normans',
    origin: 'ITA',
    originLabel: 'Southern Italy',
    originPos: { cx: 120, cy: 220 },
    route: ['ITA', 'SIC', 'DYR', 'KEP', 'NIK', 'HEL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#a35638'
  },
  {
    id: 'venetians',
    name: 'Venetians',
    origin: 'KEP',
    originLabel: 'Venice',
    originPos: { cx: 210, cy: 160 },
    route: ['KEP', 'KRE', 'AEG', 'CPL'],
    color: '#2e6b5e'
  },
  {
    id: 'bulgars',
    name: 'Bulgars',
    origin: 'BUL',
    originLabel: 'Bulgaria',
    originPos: { cx: 440, cy: 130 },
    route: ['BUL', 'PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#7a4988'
  },
  {
    id: 'serbs',
    name: 'Serbs',
    origin: 'SRB',
    originLabel: 'Serbia',
    originPos: { cx: 310, cy: 130 },
    route: ['SRB', 'DAL', 'BUL', 'NIK', 'HEL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#b04050'
  },
  {
    id: 'hungarians',
    name: 'Hungarians',
    origin: 'SIM',
    originLabel: 'Pannonia',
    originPos: { cx: 280, cy: 80 },
    route: ['SIM', 'CRO', 'SRB', 'DAL', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#3d7a3d'
  },
  {
    id: 'turks',
    name: 'Turks',
    origin: 'VAS',
    originLabel: 'Persia',
    originPos: { cx: 1060, cy: 250 },
    route: ['VAS', 'MES', 'KOL', 'SEB', 'CHA', 'KAP', 'ANA', 'BOU', 'ARM', 'PAP', 'OPT', 'CPL'],
    color: '#cc3333'
  },
  {
    id: 'caliphate',
    name: 'Caliphate',
    origin: 'ANT',
    originLabel: 'Levant',
    originPos: { cx: 1000, cy: 460 },
    route: ['ANT', 'CIL', 'KYP', 'SEL', 'KIB', 'AEG', 'SAM', 'THK', 'OPS', 'OPT', 'CPL'],
    color: '#d4a017'
  }
];

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
