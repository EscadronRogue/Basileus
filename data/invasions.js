// data/invasions.js — Invasion cards with updated strength ranges from the new ruleset

export const INVASIONS = [
  {
    id: 'aghlabids',
    name: 'Aghlabids',
    strength: [4, 6],
    origin: 'SIC',           // first theme on the route
    originLabel: 'North Africa',
    originPos: { cx: 100, cy: 440 },
    route: ['SIC', 'ITA', 'KEP', 'KRE', 'AEG', 'CPL'],
    color: '#c9a84c'
  },
  {
    id: 'kievan_rus',
    name: 'Kievan Rus',
    strength: [4, 6],
    origin: 'CHE',
    originLabel: 'Steppes',
    originPos: { cx: 650, cy: 60 },
    route: ['CHE', 'PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#5b8fb9'
  },
  {
    id: 'normans',
    name: 'Normans',
    strength: [5, 8],
    origin: 'ITA',
    originLabel: 'Southern Italy',
    originPos: { cx: 120, cy: 220 },
    route: ['ITA', 'SIC', 'DYR', 'KEP', 'NIK', 'HEL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#a35638'
  },
  {
    id: 'venetians',
    name: 'Venetians',
    strength: [7, 10],
    origin: 'KEP',
    originLabel: 'Venice',
    originPos: { cx: 210, cy: 160 },
    route: ['KEP', 'KRE', 'AEG', 'CPL'],
    color: '#2e6b5e'
  },
  {
    id: 'bulgars',
    name: 'Bulgars',
    strength: [8, 11],
    origin: 'BUL',
    originLabel: 'Bulgaria',
    originPos: { cx: 440, cy: 130 },
    route: ['BUL', 'PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#7a4988'
  },
  {
    id: 'serbs',
    name: 'Serbs',
    strength: [8, 11],
    origin: 'SRB',
    originLabel: 'Serbia',
    originPos: { cx: 310, cy: 130 },
    route: ['SRB', 'DAL', 'BUL', 'NIK', 'HEL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#b04050'
  },
  {
    id: 'hungarians',
    name: 'Hungarians',
    strength: [8, 11],
    origin: 'SIM',
    originLabel: 'Pannonia',
    originPos: { cx: 280, cy: 80 },
    route: ['SIM', 'CRO', 'SRB', 'DAL', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#3d7a3d'
  },
  {
    id: 'turks',
    name: 'Turks',
    strength: [12, 15],
    origin: 'VAS',
    originLabel: 'Persia',
    originPos: { cx: 1060, cy: 250 },
    route: ['VAS', 'MES', 'KOL', 'SEB', 'CHA', 'KAP', 'ANA', 'BOU', 'ARM', 'PAP', 'OPT', 'CPL'],
    color: '#cc3333'
  },
  {
    id: 'caliphate',
    name: 'Caliphate',
    strength: [14, 17],
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

// Dynasty colors — high-separation ownership colours. Kept away from the
// red / green / yellow / black region-border palette and from neutral free land.
export const DYNASTY_COLORS = [
  '#006DFF', // cobalt blue
  '#D100B8', // magenta
  '#00AFC8', // cyan
  '#FF7A00', // orange
  '#6C00FF', // violet
];
