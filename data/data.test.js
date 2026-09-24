import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ADJACENCY_EDGES, PROVINCES, REGIONS, buildAdjacency } from './provinces.js';
import {
  DYNASTY_PROFILES,
  INVASION_DIFFICULTIES,
  INVASION_OBJECTIVES,
  INVASION_STRENGTH_RATIOS,
  INVASIONS,
} from './invasions.js';
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
  assert.equal(capital.startOccupied, undefined, 'the capital cannot start occupied');
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

test('invasions have valid weights, difficulties, and routes', () => {
  const ids = new Set();
  for (const invasion of INVASIONS) {
    assert.ok(!ids.has(invasion.id), `${invasion.id} is unique`);
    ids.add(invasion.id);
    assert.ok(invasion.drawWeight > 0, `${invasion.id} can be drawn`);
    assert.ok(Object.values(INVASION_DIFFICULTIES).includes(invasion.difficulty), `${invasion.id} difficulty`);
    assert.ok(INVASION_STRENGTH_RATIOS[invasion.difficulty], `${invasion.id} strength ratio`);
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
