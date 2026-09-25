// data/maps/compact.js - the Compact map: 21 larger provinces made by fusing
// provinces of the Classic map, seven per region. A fused province keeps the
// id and name of the part listed first and covers the land of all its parts;
// like every province it raises 1 troop, and only seven of them are
// bishoprics. assets/hitzones-compact.svg holds the fused shapes
// (npm run build:compact-map).
import { ADJACENCY_EDGES, PROVINCES, REGIONS } from '../provinces.js';
import { INVASIONS } from '../invasions.js';

// Fused province id -> the Classic provinces it covers.
export const COMPACT_MERGES = Object.freeze({
  CRO: ['CRO', 'SRB', 'SIM'],
  DAL: ['DAL', 'DYR'],
  ITA: ['ITA', 'SIC'],
  PEL: ['PEL', 'KEP'],
  HEL: ['HEL', 'NIK'],
  THS: ['THS', 'STR'],
  THR: ['THR', 'MAK'],
  SAM: ['SAM', 'AEG'],
  OPS: ['OPS', 'OPT'],
  SEL: ['SEL', 'KIB'],
  ANA: ['ANA', 'THK'],
  PAP: ['PAP', 'BOU'],
  ARM: ['ARM', 'CHD'],
  KAP: ['KAP', 'CHA'],
  SEB: ['SEB', 'KOL'],
  MES: ['MES', 'VAS'],
  CIL: ['CIL', 'ANT'],
  BUL: ['BUL', 'PAR'],
});

// The seven bishoprics: the three provinces that held two churches, and the
// great sees of Caesarea, Thessalonike, Corinth and Cyprus.
export const COMPACT_BISHOPRICS = Object.freeze(['OPS', 'ITA', 'CIL', 'KAP', 'THS', 'HEL', 'KYP']);

// Provinces held by invaders when the game starts; a province with a lost
// part starts lost.
export const COMPACT_START_LOST = Object.freeze(['CRO', 'DAL', 'BUL', 'SEB', 'MES', 'ITA', 'CIL']);

const REGION_OVERRIDES = Object.freeze({ PEL: REGIONS.WEST });

const COMPACT_ID_OF = Object.fromEntries(PROVINCES.map((province) => [province.id, province.id]));
for (const [id, parts] of Object.entries(COMPACT_MERGES)) {
  for (const part of parts) COMPACT_ID_OF[part] = id;
}

// The Compact province a Classic province belongs to.
export function toCompactProvinceId(classicId) {
  return COMPACT_ID_OF[classicId] || null;
}

export const COMPACT_PROVINCES = Object.freeze(PROVINCES
  .filter((province) => COMPACT_ID_OF[province.id] === province.id)
  .map((province) => {
    if (province.id === 'CPL') return province;
    const entry = {
      ...province,
      region: REGION_OVERRIDES[province.id] || province.region,
      C: COMPACT_BISHOPRICS.includes(province.id) ? 1 : 0,
      parts: COMPACT_MERGES[province.id] || [province.id],
    };
    delete entry.startLost;
    if (COMPACT_START_LOST.includes(province.id)) entry.startLost = true;
    return entry;
  }));

// Two fused provinces touch when any of their parts did.
export const COMPACT_ADJACENCY_EDGES = Object.freeze((() => {
  const seen = new Set();
  const edges = [];
  for (const [a, b] of ADJACENCY_EDGES) {
    const left = COMPACT_ID_OF[a];
    const right = COMPACT_ID_OF[b];
    if (!left || !right || left === right) continue;
    const key = [left, right].sort().join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([left, right]);
  }
  return edges;
})());

// The same invasions, marching through the fused provinces.
export const COMPACT_INVASION_ROUTES = Object.freeze({
  emirate: ['ITA', 'PEL', 'KRE', 'KYP'],
  kievan_rus: ['CHE', 'BUL', 'THS', 'THR', 'CPL'],
  normans: ['ITA', 'DAL', 'PEL', 'HEL', 'THS', 'THR', 'CPL'],
  venetians: ['DAL', 'PEL', 'KRE', 'SAM', 'CPL'],
  bulgars: ['BUL', 'THS', 'THR', 'CPL'],
  serbs: ['CRO', 'DAL', 'BUL', 'HEL', 'THS', 'THR', 'CPL'],
  hungarians: ['CRO', 'DAL', 'BUL'],
  turks: ['MES', 'SEB', 'ARM', 'KAP', 'ANA', 'PAP', 'OPS', 'CPL'],
  caliphate: ['CIL', 'KYP', 'SEL', 'SAM', 'ANA', 'OPS', 'CPL'],
});

export const COMPACT_INVASIONS = Object.freeze(INVASIONS.map((invasion) => ({
  ...invasion,
  route: COMPACT_INVASION_ROUTES[invasion.id].slice(),
})));
