import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createKeyedRateLimiter,
  DEFAULT_FINISHED_ROOM_TTL_MS,
  DEFAULT_ROOM_IDLE_TTL_MS,
  MultiplayerRoomManager,
} from './service.js';
import { ROOM_STATUS } from './session.js';
import { startMultiplayerServer } from './server.js';

const TEST_AI = { id: 'test-ai', firstName: 'Test AI', label: 'Test AI', source: 'test' };

function makeManager(options = {}) {
  return new MultiplayerRoomManager({
    loadAiOpponentRoster: () => [TEST_AI],
    loadAiOpponentById: () => TEST_AI,
    ...options,
  });
}

function ageRoom(room, now, ageMs) {
  room.updatedAt = new Date(now - ageMs).toISOString();
}

test('idle rooms without connections are pruned after their TTL', () => {
  const manager = makeManager();
  const now = Date.now();
  const fresh = manager.createRoom({ playerName: 'Fresh', config: {} }).room;
  const stale = manager.createRoom({ playerName: 'Stale', config: {} }).room;
  const connected = manager.createRoom({ playerName: 'Connected', config: {} }).room;
  ageRoom(stale, now, DEFAULT_ROOM_IDLE_TTL_MS + 1);
  ageRoom(connected, now, DEFAULT_ROOM_IDLE_TTL_MS + 1);
  connected.connections.set('socket', { sendJson() {}, close() {} });

  const removed = manager.pruneIdleRooms(now);

  assert.deepEqual(removed, [stale.roomCode]);
  assert.equal(manager.getRoom(fresh.roomCode), fresh);
  assert.equal(manager.getRoom(stale.roomCode), null);
  assert.equal(manager.getRoom(connected.roomCode), connected);
});

test('finished rooms use the shorter finished-room TTL', () => {
  const manager = makeManager();
  const now = Date.now();
  const finished = manager.createRoom({ playerName: 'Done', config: {} }).room;
  const lobby = manager.createRoom({ playerName: 'Lobby', config: {} }).room;
  finished.status = ROOM_STATUS.FINISHED;
  ageRoom(finished, now, DEFAULT_FINISHED_ROOM_TTL_MS + 1);
  ageRoom(lobby, now, DEFAULT_FINISHED_ROOM_TTL_MS + 1);

  assert.deepEqual(manager.pruneIdleRooms(now), [finished.roomCode]);
  assert.equal(manager.getRoom(lobby.roomCode), lobby);
});

test('room creation prunes idle rooms before refusing at the room cap', () => {
  const manager = makeManager({ maxRooms: 2 });
  const first = manager.createRoom({ playerName: 'One', config: {} }).room;
  manager.createRoom({ playerName: 'Two', config: {} });

  assert.throws(
    () => manager.createRoom({ playerName: 'Three', config: {} }),
    (error) => error.statusCode === 503,
  );

  ageRoom(first, Date.now(), DEFAULT_ROOM_IDLE_TTL_MS + 1);
  const third = manager.createRoom({ playerName: 'Three', config: {} }).room;
  assert.equal(manager.rooms.size, 2);
  assert.equal(manager.getRoom(first.roomCode), null);
  assert.equal(manager.getRoom(third.roomCode), third);
});

test('keyed rate limiter refills per key', () => {
  let now = 0;
  const consume = createKeyedRateLimiter({ capacity: 2, refillPerMs: 1 / 1000, now: () => now });

  assert.equal(consume('a'), true);
  assert.equal(consume('a'), true);
  assert.equal(consume('a'), false);
  assert.equal(consume('b'), true);
  now += 1000;
  assert.equal(consume('a'), true);
  assert.equal(consume('a'), false);
});

test('keyed rate limiter stays bounded under many client keys', () => {
  const consume = createKeyedRateLimiter({ capacity: 1, refillPerMs: 0, maxKeys: 3, now: () => 0 });
  for (let index = 0; index < 50; index += 1) assert.equal(consume(`client-${index}`), true);
});

test('HTTP server serves the game, fonts, and room API with limits', async (t) => {
  const instance = await startMultiplayerServer({
    host: '127.0.0.1',
    port: 0,
    loadAiOpponentRoster: () => [TEST_AI],
    loadAiOpponentById: () => TEST_AI,
  });
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'basileus-multiplayer' });

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /font-src 'self'/);
  await page.text();

  const stylesheet = await (await fetch(`${base}/assets/style.css`)).text();
  assert.doesNotMatch(stylesheet, /fonts\.googleapis\.com/, 'fonts must be self-hosted to satisfy the CSP');

  const font = await fetch(`${base}/assets/fonts/eb-garamond-latin.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  await font.arrayBuffer();

  const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
  assert.equal(traversal.status, 403);
  await traversal.text();

  const malformed = await fetch(`${base}/%zz`);
  assert.equal(malformed.status, 400);
  await malformed.text();

  const dotfile = await fetch(`${base}/.github/CODEOWNERS`);
  assert.equal(dotfile.status, 404);
  await dotfile.text();

  const created = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerName: 'Host', config: { playerCount: 3 } }),
  });
  assert.equal(created.status, 201);
  const { roomCode, sessionToken } = await created.json();
  assert.match(roomCode, /^[A-Z0-9]{6}$/);
  assert.equal(typeof sessionToken, 'string');

  const oversized = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerName: 'x'.repeat(2_100_000) }),
  }).catch(() => null);
  if (oversized) {
    assert.equal(oversized.status, 413);
    await oversized.text();
  }

  let limited = null;
  for (let attempt = 0; attempt < 20 && !limited; attempt += 1) {
    const response = await fetch(`${base}/api/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerName: `Guest ${attempt}` }),
    });
    await response.text();
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, 'room API requests from one client are rate limited');
});
