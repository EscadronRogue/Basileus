import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ADJACENCY_EDGES, PROVINCES, REGIONS, buildAdjacency } from './provinces.js';
import {
  DYNASTY_PROFILES,
  INVASION_OBJECTIVES,
  INVASIONS,
} from './invasions.js';
import { BALANCE, MAP_BALANCE } from './balance.js';
import { MAPS, buildMapAdjacency } from './maps/index.js';
import { COMPACT_MERGES, COMPACT_PROVINCES } from './maps/compact.js';
import { MAJOR_TITLE_DISTRIBUTION, MAJOR_TITLES } from './titles.js';
import { PLAYER_COUNT_MAX, PLAYER_COUNT_MIN } from '../engine/setup.js';

const provinceIds = new Set(PROVINCES.map((province) => province.id));

function readSvgIds(...files) {
  const text = files.map((file) => readFileSync(new URL(`../assets/${file}`, import.meta.url), 'utf8')).join('\n');
  return new Set([...text.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
}

test('provinces have unique ids, known regions, and sane values', () => {
  assert.equal(provinceIds.size, PROVINCES.length, 'province ids are unique');
  const regions = new Set(Object.values(REGIONS));
  for (const province of PROVINCES) {
    assert.match(province.id, /^[A-Z]{3}$/, `${province.id} id`);
    assert.ok(regions.has(province.region), `${province.id} region`);
    assert.ok(province.name, `${province.id} name`);
    assert.ok(Number.isFinite(province.cx) && Number.isFinite(province.cy), `${province.id} centroid`);
    if (province.id === 'CPL') continue;
    for (const key of ['P', 'T', 'C']) {
      assert.ok(Number.isInteger(province[key]) && province[key] >= 0, `${province.id}.${key}`);
    }
  }
  const capital = PROVINCES.find((province) => province.id === 'CPL');
  assert.ok(capital, 'Constantinople exists');
  assert.equal(capital.region, REGIONS.CPL);
  assert.equal(capital.startLost, undefined, 'the capital cannot start lost');
});

test('adjacency edges are known, unique, and connect every province to the capital', () => {
  const seen = new Set();
  for (const [left, right] of ADJACENCY_EDGES) {
    assert.ok(provinceIds.has(left) && provinceIds.has(right), `${left}-${right} uses known provinces`);
    assert.notEqual(left, right, `${left} is not adjacent to itself`);
    const key = [left, right].sort().join('-');
    assert.ok(!seen.has(key), `${key} is listed once`);
    seen.add(key);
  }

  const adjacency = buildAdjacency();
  const reached = new Set(['CPL']);
  const queue = ['CPL'];
  while (queue.length) {
    for (const next of adjacency[queue.shift()]) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  assert.deepEqual(PROVINCES.map((province) => province.id).filter((id) => !reached.has(id)), []);
});

test('invasions have valid weights and routes', () => {
  const ids = new Set();
  for (const invasion of INVASIONS) {
    assert.ok(!ids.has(invasion.id), `${invasion.id} is unique`);
    ids.add(invasion.id);
    assert.ok(invasion.drawWeight > 0, `${invasion.id} can be drawn`);
    assert.ok(Object.values(INVASION_OBJECTIVES).includes(invasion.objective), `${invasion.id} objective`);
    assert.match(invasion.color, /^#[0-9a-f]{6}$/i, `${invasion.id} color`);

    const { route } = invasion;
    assert.ok(route.length >= 2, `${invasion.id} route has a path`);
    assert.equal(new Set(route).size, route.length, `${invasion.id} route never revisits a province`);
    for (const provinceId of route) assert.ok(provinceIds.has(provinceId), `${invasion.id} route uses ${provinceId}`);

    if (invasion.objective === INVASION_OBJECTIVES.CAPITAL) {
      assert.equal(route.at(-1), 'CPL', `${invasion.id} marches on Constantinople`);
    } else {
      assert.ok(!route.includes('CPL'), `${invasion.id} only threatens provinces`);
    }
  }
});

test('every province and invasion origin has a shape on the map', () => {
  const hitzoneIds = readSvgIds('hitzones.svg');
  const originIds = readSvgIds('origin.svg');
  assert.deepEqual(PROVINCES.map((province) => province.id).filter((id) => !hitzoneIds.has(id)), []);
  assert.deepEqual(INVASIONS.map((invasion) => invasion.originMarker).filter((id) => !originIds.has(id)), []);
});

test('major title distribution hands out every office for each player count', () => {
  const titleCount = Object.keys(MAJOR_TITLES).length;
  for (let playerCount = PLAYER_COUNT_MIN; playerCount <= PLAYER_COUNT_MAX; playerCount += 1) {
    const shares = MAJOR_TITLE_DISTRIBUTION[playerCount];
    assert.ok(Array.isArray(shares), `${playerCount} players have a distribution`);
    assert.equal(shares.length, playerCount - 1, `${playerCount} players: one share per non-Basileus`);
    assert.equal(shares.reduce((total, share) => total + share, 0), titleCount, `${playerCount} players: all offices assigned`);
  }
});

test('dynasty profiles cover every seat with distinct names and colors', () => {
  assert.ok(DYNASTY_PROFILES.length >= PLAYER_COUNT_MAX);
  assert.equal(new Set(DYNASTY_PROFILES.map((profile) => profile.name)).size, DYNASTY_PROFILES.length);
  assert.equal(new Set(DYNASTY_PROFILES.map((profile) => profile.color.toLowerCase())).size, DYNASTY_PROFILES.length);
});

// ── Compact map ──────────────────────────────────────────────────────────


test('the Compact map has 21 provinces, seven per region, seven bishoprics and seven lost', () => {
  const provinces = COMPACT_PROVINCES.filter((province) => province.id !== 'CPL');
  assert.equal(provinces.length, 21);
  for (const region of [REGIONS.EAST, REGIONS.WEST, REGIONS.SEA]) {
    assert.equal(provinces.filter((province) => province.region === region).length, 7, `${region} provinces`);
  }
  assert.equal(provinces.filter((province) => province.C > 0).length, 7, 'bishoprics');
  assert.equal(provinces.filter((province) => province.startLost).length, 7, 'lost at the start');
  assert.equal(COMPACT_PROVINCES.find((province) => province.id === 'PEL').region, REGIONS.WEST);
  assert.equal(COMPACT_PROVINCES.find((province) => province.id === 'DAL').startLost, true);
  assert.equal(COMPACT_PROVINCES.find((province) => province.id === 'ITA').startLost, true);
  for (const province of provinces) assert.equal(province.T, 1, `${province.id} raises 1 troop`);
});

test('every Classic province belongs to exactly one Compact province', () => {
  const covered = new Map();
  for (const province of COMPACT_PROVINCES) {
    for (const part of COMPACT_MERGES[province.id] || [province.id]) {
      assert.equal(covered.has(part), false, `${part} is fused twice`);
      covered.set(part, province.id);
    }
  }
  assert.deepEqual([...covered.keys()].sort(), [...provinceIds].sort());
});

test('Compact invasions keep every invasion, on routes through touching provinces', () => {
  const map = MAPS.compact;
  const ids = new Set(map.provinces.map((province) => province.id));
  const adjacency = buildMapAdjacency('compact');
  const regionOf = Object.fromEntries(map.provinces.map((province) => [province.id, province.region]));
  assert.deepEqual(map.invasions.map((invasion) => invasion.id), INVASIONS.map((invasion) => invasion.id));
  for (const invasion of map.invasions) {
    assert.equal(new Set(invasion.route).size, invasion.route.length, `${invasion.id} visits each province once`);
    invasion.route.forEach((id, index) => {
      assert.ok(ids.has(id), `${invasion.id} route province ${id}`);
      if (index === 0) return;
      const previous = invasion.route[index - 1];
      // Land steps must touch; sea provinces can be crossed by ship.
      const bySea = regionOf[previous] === REGIONS.SEA && regionOf[id] === REGIONS.SEA;
      assert.ok(adjacency[previous].has(id) || bySea, `${invasion.id}: ${previous} -> ${id}`);
    });
    const classic = INVASIONS.find((entry) => entry.id === invasion.id);
    assert.equal(invasion.route.includes('CPL'), classic.route.includes('CPL'), `${invasion.id} keeps its goal`);
  }
});

test('the Compact map has one shape per province and none left of the fused parts', () => {
  const ids = readSvgIds('hitzones-compact.svg');
  for (const province of COMPACT_PROVINCES) assert.ok(ids.has(province.id), `${province.id} has a shape`);
  for (const [id, parts] of Object.entries(COMPACT_MERGES)) {
    for (const part of parts) if (part !== id) assert.equal(ids.has(part), false, `${part} was fused into ${id}`);
  }
});

test('map balance values only change known settings', () => {
  for (const [mapId, overlay] of Object.entries(MAP_BALANCE)) {
    assert.ok(MAPS[mapId], `${mapId} is a map`);
    for (const key of Object.keys(overlay)) assert.ok(Object.hasOwn(BALANCE, key), `${mapId}.${key}`);
  }
});
