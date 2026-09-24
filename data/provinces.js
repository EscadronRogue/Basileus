// data/provinces.js - Byzantine themes with profit (P), troops (T), church (C),
// region, and map geography. Constantinople (CPL) has no economic flow.

export const REGIONS = {
  EAST: 'east',
  WEST: 'west',
  SEA: 'sea',
  CPL: 'cpl',
};

export const REGION_BORDER_COLORS = {
  [REGIONS.EAST]: '#800080',
  [REGIONS.WEST]: '#B80D4D',
  [REGIONS.SEA]: '#5D3FD3',
  [REGIONS.CPL]: '#E49B0F',
};

export const PROVINCES = [
  // EAST - Domestic of the East
  { id: 'OPS', name: 'Opsikion',      P: 1, T: 1, C: 1, region: REGIONS.EAST, cx: 640, cy: 280 },
  { id: 'OPT', name: 'Optimaton',     P: 1, T: 1, C: 1, region: REGIONS.EAST, cx: 610, cy: 240 },
  { id: 'ANA', name: 'Anatolikon',    P: 1, T: 1, C: 0, region: REGIONS.EAST, cx: 720, cy: 340 },
  { id: 'PAP', name: 'Paphlagonia',   P: 1, T: 1, C: 0, region: REGIONS.EAST, cx: 700, cy: 220 },
  { id: 'BOU', name: 'Boukellarion',  P: 1, T: 1, C: 0, region: REGIONS.EAST, cx: 680, cy: 260 },
  { id: 'ARM', name: 'Armeniakon',    P: 1, T: 1, C: 0, region: REGIONS.EAST, cx: 790, cy: 210 },
  { id: 'CHD', name: 'Chaldia',       P: 1, T: 1, C: 0, region: REGIONS.EAST, cx: 870, cy: 195 },
  { id: 'CHA', name: 'Charsianon',    P: 1, T: 1, C: 0, region: REGIONS.EAST, cx: 800, cy: 280 },
  { id: 'KOL', name: 'Koloneia',      P: 1, T: 1, C: 0, region: REGIONS.EAST, cx: 880, cy: 240, startLost: true },
  { id: 'SEB', name: 'Sebasteia',     P: 1, T: 1, C: 0, region: REGIONS.EAST, cx: 850, cy: 270, startLost: true },
  { id: 'KAP', name: 'Kappadokia',    P: 1, T: 1, C: 1, region: REGIONS.EAST, cx: 780, cy: 330 },
  { id: 'THK', name: 'Thrakesion',    P: 1, T: 1, C: 0, region: REGIONS.EAST, cx: 620, cy: 350 },
  { id: 'MES', name: 'Mesopotamia',   P: 1, T: 1, C: 1, region: REGIONS.EAST, cx: 950, cy: 350, startLost: true },
  { id: 'VAS', name: 'Vaspurakan',    P: 1, T: 1, C: 0, region: REGIONS.EAST, cx: 980, cy: 280, startLost: true },

  // WEST - Domestic of the West
  { id: 'NIK', name: 'Nikopolis',     P: 1, T: 1, C: 0, region: REGIONS.WEST, cx: 340, cy: 340 },
  { id: 'HEL', name: 'Hellas',        P: 1, T: 1, C: 1, region: REGIONS.WEST, cx: 380, cy: 390 },
  { id: 'THS', name: 'Thessalonike',  P: 1, T: 1, C: 1, region: REGIONS.WEST, cx: 400, cy: 290 },
  { id: 'STR', name: 'Strymon',       P: 1, T: 1, C: 0, region: REGIONS.WEST, cx: 440, cy: 260 },
  { id: 'MAK', name: 'Makedonia',     P: 1, T: 1, C: 0, region: REGIONS.WEST, cx: 490, cy: 240 },
  { id: 'THR', name: 'Thrake',        P: 1, T: 1, C: 1, region: REGIONS.WEST, cx: 540, cy: 230 },
  { id: 'PEL', name: 'Peloponnesos',    P: 1, T: 1, C: 0, region: REGIONS.WEST, cx: 380, cy: 440 },
  { id: 'DYR', name: 'Dyrrachium',      P: 1, T: 1, C: 0, region: REGIONS.WEST, cx: 310, cy: 280 },
  { id: 'CRO', name: 'Kroatia',       P: 1, T: 1, C: 0, region: REGIONS.WEST, cx: 280, cy: 160, startLost: true },
  { id: 'DAL', name: 'Dalmatia',      P: 1, T: 1, C: 0, region: REGIONS.WEST, cx: 310, cy: 200, startLost: true },
  { id: 'SRB', name: 'Serbia',        P: 1, T: 1, C: 0, region: REGIONS.WEST, cx: 350, cy: 190, startLost: true },
  { id: 'SIM', name: 'Sirmion',       P: 1, T: 1, C: 0, region: REGIONS.WEST, cx: 320, cy: 130, startLost: true },
  { id: 'BUL', name: 'Boulgaria',     P: 1, T: 1, C: 1, region: REGIONS.WEST, cx: 420, cy: 200, startLost: true },
  { id: 'PAR', name: 'Paradounavon',  P: 1, T: 1, C: 0, region: REGIONS.WEST, cx: 490, cy: 170, startLost: true },

  // SEA - Admiral of the Fleet
  { id: 'AEG', name: 'Aigaion Pelagos', P: 1, T: 1, C: 0, region: REGIONS.SEA, cx: 510, cy: 370 },
  { id: 'SAM', name: 'Samos',           P: 1, T: 1, C: 1, region: REGIONS.SEA, cx: 570, cy: 390 },
  { id: 'KIB', name: 'Kibyrrhaiotai',   P: 1, T: 1, C: 0, region: REGIONS.SEA, cx: 630, cy: 420 },
  { id: 'KEP', name: 'Kephallenia',     P: 1, T: 1, C: 0, region: REGIONS.SEA, cx: 290, cy: 380 },
  { id: 'KRE', name: 'Krete',           P: 1, T: 1, C: 0, region: REGIONS.SEA, cx: 450, cy: 480 },
  { id: 'KYP', name: 'Kypros',          P: 1, T: 1, C: 1, region: REGIONS.SEA, cx: 790, cy: 460 },
  { id: 'CHE', name: 'Cherson',         P: 1, T: 1, C: 0, region: REGIONS.SEA, cx: 620, cy: 120 },
  { id: 'SEL', name: 'Seleukia',      P: 1, T: 1, C: 0, region: REGIONS.SEA, cx: 760, cy: 400 },
  { id: 'CIL', name: 'Kilikia',       P: 1, T: 1, C: 1, region: REGIONS.SEA, cx: 830, cy: 380, startLost: true },
  { id: 'ANT', name: 'Antiochia',     P: 1, T: 1, C: 1, region: REGIONS.SEA, cx: 900, cy: 420, startLost: true },
  { id: 'SIC', name: 'Sikelia',         P: 1, T: 1, C: 1, region: REGIONS.SEA, cx: 170, cy: 360, startLost: true },
  { id: 'ITA', name: 'Italias',         P: 1, T: 1, C: 1, region: REGIONS.SEA, cx: 190, cy: 280 },

  { id: 'CPL', name: 'Konstantinopolis', region: REGIONS.CPL, cx: 565, cy: 265 },
];

// Adjacency graph - bidirectional (define each edge once, engine builds both directions).
export const ADJACENCY_EDGES = [
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
  ['AEG','CPL'], ['AEG','KRE'],
  ['SAM','KIB'], ['SAM','OPS'],
  ['KEP','SIC'], ['KEP','KRE'], ['KEP','ITA'],
  ['KRE','KYP'],
  ['CHE','PAR'],
  ['PEL','NIK'],
  ['DYR','ITA'], ['DYR','KEP'],
  ['SIC','ITA'],
];

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
  return PROVINCES.find((p) => p.id === id);
}
