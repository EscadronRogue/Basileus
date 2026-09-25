// data/maps/index.js - the maps a game can be played on.
//
// Every map has its provinces, which of them touch, its invasions and the
// SVG that draws its provinces. The rules are the same on every map; a few
// balance values differ (data/balance.js, MAP_BALANCE).
import { ADJACENCY_EDGES, PROVINCES } from '../provinces.js';
import { INVASIONS } from '../invasions.js';
import {
  COMPACT_ADJACENCY_EDGES,
  COMPACT_INVASIONS,
  COMPACT_MERGES,
  COMPACT_PROVINCES,
} from './compact.js';

export const MAPS = Object.freeze({
  classic: Object.freeze({
    id: 'classic',
    name: 'Classic',
    summary: '40 provinces',
    provinces: PROVINCES,
    adjacencyEdges: ADJACENCY_EDGES,
    invasions: INVASIONS,
    hitzonesAsset: 'hitzones.svg',
    hitzonesFallback: 'HITZONES_SVG',
    parts: null,
  }),
  compact: Object.freeze({
    id: 'compact',
    name: 'Compact',
    summary: '21 larger provinces',
    provinces: COMPACT_PROVINCES,
    adjacencyEdges: COMPACT_ADJACENCY_EDGES,
    invasions: COMPACT_INVASIONS,
    hitzonesAsset: 'hitzones-compact.svg',
    hitzonesFallback: 'HITZONES_COMPACT_SVG',
    parts: COMPACT_MERGES,
  }),
});

export const MAP_IDS = Object.freeze(Object.keys(MAPS));
export const DEFAULT_MAP_ID = 'classic';

export function normalizeMapId(mapId) {
  return Object.hasOwn(MAPS, mapId) ? mapId : DEFAULT_MAP_ID;
}

// Accepts a map id or a game state.
export function getMapDefinition(mapOrState = DEFAULT_MAP_ID) {
  const mapId = typeof mapOrState === 'string' ? mapOrState : mapOrState?.mapId;
  return MAPS[normalizeMapId(mapId)];
}

export function getMapProvinces(mapOrState) {
  return getMapDefinition(mapOrState).provinces;
}

export function getMapInvasions(mapOrState) {
  return getMapDefinition(mapOrState).invasions;
}

export function buildMapAdjacency(mapOrState) {
  const map = getMapDefinition(mapOrState);
  const adjacency = Object.fromEntries(map.provinces.map((province) => [province.id, new Set()]));
  for (const [a, b] of map.adjacencyEdges) {
    adjacency[a]?.add(b);
    adjacency[b]?.add(a);
  }
  return adjacency;
}
