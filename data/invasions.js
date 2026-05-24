// data/invasions.js — Invasion routes and relative difficulty bands.

export const INVASION_ESTIMATE_INTERVAL = 5;

export const INVASION_DIFFICULTIES = Object.freeze({
  EASY: 'easy',
  MEDIUM: 'medium',
  HARD: 'hard',
});

export const INVASION_STRENGTH_RATIOS = Object.freeze({
  [INVASION_DIFFICULTIES.EASY]: [0.3, 0.5],
  [INVASION_DIFFICULTIES.MEDIUM]: [0.5, 0.7],
  [INVASION_DIFFICULTIES.HARD]: [0.7, 0.9],
});

export const INVASION_OBJECTIVES = Object.freeze({
  CAPITAL: 'capital',
  PROVINCES: 'provinces',
});

export const INVASIONS = [
  {
    id: 'emirate',
    name: 'Emirate',
    drawWeight: 5,
    origin: 'SIC',           // first theme on the route
    originLabel: 'North Africa',
    originMarker: 'AGH',
    objective: INVASION_OBJECTIVES.PROVINCES,
    requiresImperialTarget: true,
    difficulty: INVASION_DIFFICULTIES.MEDIUM,
    route: ['SIC', 'ITA', 'KEP', 'KRE', 'KYP'],
    color: '#c9a84c'
  },
  {
    id: 'kievan_rus',
    name: 'Kievan Rus',
    drawWeight: 5,
    origin: 'CHE',
    originLabel: 'Steppes',
    originMarker: 'RUS',
    objective: INVASION_OBJECTIVES.CAPITAL,
    difficulty: INVASION_DIFFICULTIES.MEDIUM,
    route: ['CHE', 'PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#5b8fb9'
  },
  {
    id: 'normans',
    name: 'Normans',
    drawWeight: 5,
    origin: 'ITA',
    originLabel: 'Southern Italy',
    originMarker: 'NOR',
    objective: INVASION_OBJECTIVES.CAPITAL,
    difficulty: INVASION_DIFFICULTIES.MEDIUM,
    route: ['ITA', 'SIC', 'DYR', 'KEP', 'NIK', 'HEL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#a35638'
  },
  {
    id: 'venetians',
    name: 'Venetians',
    drawWeight: 5,
    origin: 'KEP',
    originLabel: 'Venice',
    originMarker: 'VEN',
    objective: INVASION_OBJECTIVES.CAPITAL,
    difficulty: INVASION_DIFFICULTIES.MEDIUM,
    route: ['DAL', 'DYR', 'KEP', 'KRE', 'AEG', 'CPL'],
    color: '#2e6b5e'
  },
  {
    id: 'bulgars',
    name: 'Bulgars',
    drawWeight: 20,
    origin: 'BUL',
    originLabel: 'Bulgaria',
    originMarker: 'BBUULL',
    objective: INVASION_OBJECTIVES.CAPITAL,
    difficulty: INVASION_DIFFICULTIES.MEDIUM,
    route: ['PAR', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#7a4988'
  },
  {
    id: 'serbs',
    name: 'Serbs',
    drawWeight: 5,
    origin: 'SRB',
    originLabel: 'Serbia',
    originMarker: 'SSRRBB',
    objective: INVASION_OBJECTIVES.CAPITAL,
    difficulty: INVASION_DIFFICULTIES.MEDIUM,
    route: ['SRB', 'DAL', 'BUL', 'NIK', 'HEL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#b04050'
  },
  {
    id: 'hungarians',
    name: 'Hungarians',
    drawWeight: 5,
    origin: 'SIM',
    originLabel: 'Pannonia',
    originMarker: 'HON',
    objective: INVASION_OBJECTIVES.CAPITAL,
    difficulty: INVASION_DIFFICULTIES.MEDIUM,
    route: ['SIM', 'CRO', 'SRB', 'DAL', 'BUL', 'THS', 'STR', 'MAK', 'THR', 'CPL'],
    color: '#3d7a3d'
  },
  {
    id: 'turks',
    name: 'Turks',
    drawWeight: 25,
    origin: 'VAS',
    originLabel: 'Persia',
    originMarker: 'TUR',
    objective: INVASION_OBJECTIVES.CAPITAL,
    difficulty: INVASION_DIFFICULTIES.HARD,
    route: ['VAS', 'MES', 'KOL', 'SEB', 'CHA', 'KAP', 'ANA', 'BOU', 'ARM', 'PAP', 'OPT', 'CPL'],
    color: '#cc3333'
  },
  {
    id: 'caliphate',
    name: 'Caliphate',
    drawWeight: 25,
    origin: 'ANT',
    originLabel: 'Levant',
    originMarker: 'CAL',
    objective: INVASION_OBJECTIVES.CAPITAL,
    difficulty: INVASION_DIFFICULTIES.HARD,
    route: ['ANT', 'CIL', 'KYP', 'SEL', 'KIB', 'AEG', 'SAM', 'THK', 'OPS', 'OPT', 'CPL'],
    color: '#d4a017'
  }
];

// Dynasty colors - chosen to be clearly distinct from ALL reserved colors:
// region borders (forest green, crimson, cobalt, gold), free-citizen amethyst,
// church slate-blue, and invasion route colors.
// Family names are fixed below so each color always identifies the same house.
export const DYNASTY_COLORS = [
  '#c02020', // red
  '#1a50a0', // blue
  '#c89010', // yellow
  '#2a8030', // green
  '#d06010', // orange
];

export const DYNASTY_PROFILES = Object.freeze([
  { name: 'Phokas', color: DYNASTY_COLORS[0] },
  { name: 'Doukas', color: DYNASTY_COLORS[1] },
  { name: 'Komnenos', color: DYNASTY_COLORS[2] },
  { name: 'Botenaiates', color: DYNASTY_COLORS[3] },
  { name: 'Diogenes', color: DYNASTY_COLORS[4] },
]);

export const DYNASTIES = Object.freeze(DYNASTY_PROFILES.map(({ name }) => name));

export const DYNASTY_COLOR_BY_NAME = Object.freeze({
  ...Object.fromEntries(DYNASTY_PROFILES.map(({ name, color }) => [name, color])),
  // Historical spelling kept as an alias for older saves or external data.
  Botaneiates: DYNASTY_COLORS[3],
});

export function getDynastyColor(dynasty) {
  return DYNASTY_COLOR_BY_NAME[String(dynasty || '').trim()] || '#5a3810';
}

export function getDynastyProfileForSeat(seatIndex) {
  const normalizedSeat = Math.max(0, Math.floor(Number(seatIndex) || 0));
  return DYNASTY_PROFILES[normalizedSeat % DYNASTY_PROFILES.length];
}
