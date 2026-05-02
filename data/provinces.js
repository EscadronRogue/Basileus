// data/provinces.js — All Byzantine themes with gold (G), levy (L), region, geography
// Coordinates are on a 1200×700 canvas, roughly matching Eastern Mediterranean geography

export const REGIONS = {
  EAST: 'east',
  WEST: 'west',
  SEA: 'sea',
  CPL: 'cpl'
};

// Region border colors — rich command colours for map province outlines.
// Chosen to be legible against the parchment map background and clearly
// distinct from one another and from dynasty ownership colors.
export const REGION_BORDER_COLORS = {
  [REGIONS.EAST]: '#1e5c34', // deep forest green — Domestic of the East
  [REGIONS.WEST]: '#7a2020', // deep crimson — Domestic of the West
  [REGIONS.SEA]:  '#1e3a7a', // deep cobalt — Admiral of the Fleet
  [REGIONS.CPL]:  '#9a7010'  // deep imperial gold — Constantinople / Basileus
};

export const PROVINCES = [
  // ── EAST (17 themes) ── Domestic of the East
  { id: 'OPS', name: 'Opsikion',      G: 4, L: 1, region: REGIONS.EAST, cx: 640, cy: 280 },
  { id: 'OPT', name: 'Optimaton',     G: 4, L: 1, region: REGIONS.EAST, cx: 610, cy: 240 },
  { id: 'ANA', name: 'Anatolikon',    G: 2, L: 3, region: REGIONS.EAST, cx: 720, cy: 340 },
  { id: 'PAP', name: 'Paphlagonia',   G: 3, L: 2, region: REGIONS.EAST, cx: 700, cy: 220 },
  { id: 'BOU', name: 'Boukellarion',  G: 2, L: 3, region: REGIONS.EAST, cx: 680, cy: 260 },
  { id: 'ARM', name: 'Armeniakon',    G: 1, L: 4, region: REGIONS.EAST, cx: 790, cy: 210 },
  { id: 'CHD', name: 'Chaldia',       G: 3, L: 2, region: REGIONS.EAST, cx: 870, cy: 195 },
  { id: 'CHA', name: 'Charsianon',    G: 2, L: 3, region: REGIONS.EAST, cx: 800, cy: 280 },
  { id: 'KOL', name: 'Koloneia',      G: 1, L: 4, region: REGIONS.EAST, cx: 880, cy: 240, startOccupied: true },
  { id: 'SEB', name: 'Sebasteia',     G: 2, L: 3, region: REGIONS.EAST, cx: 850, cy: 270, startOccupied: true },
  { id: 'KAP', name: 'Kappadokia',    G: 1, L: 4, region: REGIONS.EAST, cx: 780, cy: 330 },
  { id: 'THK', name: 'Thrakesion',    G: 3, L: 2, region: REGIONS.EAST, cx: 620, cy: 350 },
  { id: 'SEL', name: 'Seleukia',      G: 1, L: 4, region: REGIONS.EAST, cx: 760, cy: 400 },
  { id: 'CIL', name: 'Kilikia',       G: 4, L: 1, region: REGIONS.EAST, cx: 830, cy: 380, startOccupied: true },
  { id: 'ANT', name: 'Antiochia',     G: 4, L: 1, region: REGIONS.EAST, cx: 900, cy: 420, startOccupied: true },
  { id: 'MES', name: 'Mesopotamia',   G: 2, L: 3, region: REGIONS.EAST, cx: 950, cy: 350, startOccupied: true },
  { id: 'VAS', name: 'Vaspurakan',    G: 1, L: 4, region: REGIONS.EAST, cx: 980, cy: 280, startOccupied: true },

  // ── WEST (12 themes) ── Domestic of the West
  { id: 'NIK', name: 'Nikopolis',     G: 3, L: 2, region: REGIONS.WEST, cx: 340, cy: 340 },
  { id: 'HEL', name: 'Hellas',        G: 3, L: 2, region: REGIONS.WEST, cx: 380, cy: 390 },
  { id: 'THS', name: 'Thessalonike',  G: 4, L: 1, region: REGIONS.WEST, cx: 400, cy: 290 },
  { id: 'STR', name: 'Strymon',       G: 2, L: 3, region: REGIONS.WEST, cx: 440, cy: 260 },
  { id: 'MAK', name: 'Makedonia',     G: 2, L: 3, region: REGIONS.WEST, cx: 490, cy: 240 },
  { id: 'THR', name: 'Thrake',        G: 4, L: 1, region: REGIONS.WEST, cx: 540, cy: 230 },
  { id: 'CRO', name: 'Kroatia',       G: 2, L: 3, region: REGIONS.WEST, cx: 280, cy: 160, startOccupied: true },
  { id: 'DAL', name: 'Dalmatia',      G: 4, L: 1, region: REGIONS.WEST, cx: 310, cy: 200, startOccupied: true },
  { id: 'SRB', name: 'Serbia',        G: 1, L: 4, region: REGIONS.WEST, cx: 350, cy: 190, startOccupied: true },
  { id: 'SIM', name: 'Sirmion',       G: 3, L: 2, region: REGIONS.WEST, cx: 320, cy: 130, startOccupied: true },
  { id: 'BUL', name: 'Boulgaria',     G: 2, L: 3, region: REGIONS.WEST, cx: 420, cy: 200, startOccupied: true },
  { id: 'PAR', name: 'Paradounavon',  G: 2, L: 3, region: REGIONS.WEST, cx: 490, cy: 170, startOccupied: true },

  // ── SEA (11 themes) ── Admiral of the Fleet
  { id: 'AEG', name: 'Aigaion Pelagos', G: 2, L: 3, region: REGIONS.SEA, cx: 510, cy: 370 },
  { id: 'SAM', name: 'Samos',           G: 2, L: 3, region: REGIONS.SEA, cx: 570, cy: 390 },
  { id: 'KIB', name: 'Kibyrrhaiotai',   G: 1, L: 4, region: REGIONS.SEA, cx: 630, cy: 420 },
  { id: 'KEP', name: 'Kephallenia',     G: 1, L: 4, region: REGIONS.SEA, cx: 290, cy: 380 },
  { id: 'KRE', name: 'Krete',           G: 4, L: 1, region: REGIONS.SEA, cx: 450, cy: 480 },
  { id: 'KYP', name: 'Kypros',          G: 4, L: 1, region: REGIONS.SEA, cx: 790, cy: 460 },
  { id: 'CHE', name: 'Cherson',         G: 3, L: 2, region: REGIONS.SEA, cx: 620, cy: 120 },
  { id: 'PEL', name: 'Peloponnesos',    G: 2, L: 3, region: REGIONS.SEA, cx: 380, cy: 440 },
  { id: 'DYR', name: 'Dyrrachium',      G: 2, L: 3, region: REGIONS.SEA, cx: 310, cy: 280 },
  { id: 'SIC', name: 'Sikelia',         G: 4, L: 1, region: REGIONS.SEA, cx: 170, cy: 360, startOccupied: true },
  { id: 'ITA', name: 'Italias',         G: 2, L: 3, region: REGIONS.SEA, cx: 190, cy: 280 },

  // ── CONSTANTINOPLE
  { id: 'CPL', name: 'Constantinople',  G: 0, L: 0, region: REGIONS.CPL, cx: 565, cy: 265 }
];

// Adjacency graph — bidirectional (define each edge once, engine builds both directions)
export const ADJACENCY_EDGES = [
  // East internal
  ['OPS','OPT'], ['OPS','THK'], ['OPS','ANA'], ['OPS','BOU'],
  ['OPT','BOU'], ['OPT','CPL'],
  ['ANA','THK'], ['ANA','KAP'], ['ANA','BOU'], ['ANA','SEL'], ['ANA','CIL'], ['ANA','KIB'],
  ['BOU','PAP'], ['BOU','ARM'], ['BOU','CHA'], ['BOU','KAP'],
  ['PAP','ARM'],
  ['ARM','CHD'], ['ARM','CHA'], ['ARM','SEB'],
  ['CHD','KOL'], ['CHD','SEB'],
  ['CHA','SEB'], ['CHA','KAP'],
  ['KOL','SEB'], ['KOL','VAS'], ['KOL','MES'],
  ['SEB','MES'], ['SEB','CIL'], ['SEB','KAP'],
  ['KAP','CIL'],
  ['SEL','KIB'], ['SEL','CIL'],
  ['CIL','MES'], ['CIL','ANT'],
  ['ANT','MES'],
  ['MES','VAS'],
  ['THK','SAM'], ['THK','KIB'],
  // West internal
  ['NIK','HEL'], ['NIK','DYR'], ['NIK','BUL'],
  ['HEL','THS'], ['HEL','PEL'],
  ['THS','STR'], ['THS','BUL'],
  ['STR','MAK'], ['STR','BUL'], ['STR','PAR'],
  ['MAK','THR'], ['MAK','PAR'],
  ['THR','CPL'], ['THR','PAR'],
  ['CRO','DAL'], ['CRO','SRB'], ['CRO','SIM'],
  ['DAL','SRB'], ['DAL','BUL'], ['DAL','DYR'],
  ['SRB','SIM'], ['SRB','BUL'],
  ['SIM','BUL'],
  ['BUL','PAR'], ['BUL','DYR'],
  // Sea internal
  ['AEG','CPL'], ['AEG','KRE'],
  ['SAM','KIB'], ['SAM','OPS'],
  ['KEP','SIC'], ['KEP','KRE'], ['KEP','ITA'],
  ['KRE','KYP'],
  ['CHE','PAR'],
  ['PEL','NIK'], ['PEL','HEL'],
  ['DYR','ITA'], ['DYR','KEP'],
  ['SIC','ITA'],
];

// Build full adjacency map
export function buildAdjacency() {
  const adj = {};
  for (const p of PROVINCES) adj[p.id] = new Set();
  for (const [a, b] of ADJACENCY_EDGES) {
    adj[a].add(b);
    adj[b].add(a);
  }
  return adj;
}

export function getProvince(id) {
  return PROVINCES.find(p => p.id === id);
}
