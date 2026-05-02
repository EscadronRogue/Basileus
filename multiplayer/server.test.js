import test from 'node:test';
import assert from 'node:assert/strict';

import { startMultiplayerServer } from './server.js';

class SocketHarness {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.messages = [];
    this.waiters = [];
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      this.messages.push(message);
      this.flush();
    });
  }

  async ready() {
    await this.openPromise;
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  take(predicate) {
    const index = this.messages.findIndex(predicate);
    if (index === -1) return null;
    return this.messages.splice(index, 1)[0];
  }

  waitFor(predicate, timeoutMs = 5000) {
    const immediate = this.take(predicate);
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== waiterRecord);
        reject(new Error('Timed out waiting for WebSocket message.'));
      }, timeoutMs);

      const waiterRecord = {
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      this.waiters.push(waiterRecord);
    });
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      const message = this.take(waiter.predicate);
      if (!message) continue;
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(message);
    }
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      this.ws.addEventListener('close', resolve, { once: true });
      this.ws.close();
    });
  }
}

async function createServerHarness(t) {
  const instance = await startMultiplayerServer({ port: 0 });
  t.after(async () => {
    await instance.close();
  });
  return instance;
}

async function createRoom(baseUrl, payload) {
  const response = await fetch(`${baseUrl}api/rooms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function joinRoom(baseUrl, roomCode, payload) {
  const response = await fetch(`${baseUrl}api/rooms/${encodeURIComponent(roomCode)}/join`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function connectSocket(baseUrl, helloPayload) {
  const socket = new SocketHarness(baseUrl.replace(/^http/, 'ws') + 'ws');
  await socket.ready();
  socket.send({
    type: 'hello',
    ...helloPayload,
  });
  await socket.waitFor((message) => message.type === 'room_snapshot');
  return socket;
}

function firstPlayableOffice(room, playerId) {
  const player = room.gameState.players[playerId];
  const professionalOffice = Object.keys(player.professionalArmies || {})[0];
  if (professionalOffice) return professionalOffice;
  if (playerId === room.gameState.basileusId) return 'BASILEUS';
  return player.majorTitles.find((titleKey) => titleKey !== 'PATRIARCH') || player.majorTitles[0];
}

async function createStartedThreePlayerRoom(t) {
  const instance = await createServerHarness(t);
  const createPayload = await createRoom(instance.url, {
    playerName: 'Host',
    config: {
      playerCount: 3,
      deckSize: 6,
      seed: 'alpha-seed',
    },
  });

  const hostSocket = await connectSocket(instance.url, {
    roomCode: createPayload.roomCode,
    sessionToken: createPayload.sessionToken,
    playerName: 'Host',
    seatToken: createPayload.seatToken,
  });

  const joinPayload = await joinRoom(instance.url, createPayload.roomCode, {
    playerName: 'Guest',
  });

  const guestSocket = await connectSocket(instance.url, {
    roomCode: joinPayload.roomCode,
    sessionToken: joinPayload.sessionToken,
    playerName: 'Guest',
  });

  guestSocket.send({
    type: 'claim_seat',
    requestId: 'claim-guest',
    seatId: 1,
    playerName: 'Guest',
  });
  await guestSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'claim-guest');
  const guestPrivate = await guestSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 1);

  hostSocket.send({
    type: 'set_seat_kind',
    requestId: 'seat-two-ai',
    seatId: 2,
    kind: 'ai',
  });
  await hostSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'seat-two-ai');

  hostSocket.send({
    type: 'start_game',
    requestId: 'start-room',
  });
  await hostSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'start-room');
  const hostGame = await hostSocket.waitFor((message) => message.type === 'game_snapshot');
  const guestGame = await guestSocket.waitFor((message) => message.type === 'game_snapshot');

  return {
    instance,
    roomCode: createPayload.roomCode,
    room: instance.manager.getRoom(createPayload.roomCode),
    host: {
      socket: hostSocket,
      sessionToken: createPayload.sessionToken,
      seatToken: createPayload.seatToken,
      game: hostGame,
    },
    guest: {
      socket: guestSocket,
      sessionToken: joinPayload.sessionToken,
      seatToken: guestPrivate.seatToken,
      game: guestGame,
    },
  };
}

test('multiplayer server enforces lobby ownership and starts a live room', async (t) => {
  const instance = await createServerHarness(t);
  const created = await createRoom(instance.url, {
    playerName: 'Host',
    config: {
      playerCount: 3,
      deckSize: 6,
      seed: 'room-seed',
    },
  });
  const hostSocket = await connectSocket(instance.url, {
    roomCode: created.roomCode,
    sessionToken: created.sessionToken,
    playerName: 'Host',
    seatToken: created.seatToken,
  });

  hostSocket.send({
    type: 'start_game',
    requestId: 'too-early',
  });
  const earlyReject = await hostSocket.waitFor((message) => message.type === 'action_rejected' && message.requestId === 'too-early');
  assert.match(earlyReject.reason, /claimed/i);

  const joined = await joinRoom(instance.url, created.roomCode, {
    playerName: 'Guest',
  });
  const guestSocket = await connectSocket(instance.url, {
    roomCode: joined.roomCode,
    sessionToken: joined.sessionToken,
    playerName: 'Guest',
  });

  guestSocket.send({
    type: 'set_seat_kind',
    requestId: 'guest-seat-type',
    seatId: 2,
    kind: 'ai',
  });
  const guestReject = await guestSocket.waitFor((message) => message.type === 'action_rejected' && message.requestId === 'guest-seat-type');
  assert.match(guestReject.reason, /host/i);

  guestSocket.send({
    type: 'claim_seat',
    requestId: 'guest-claim',
    seatId: 1,
    playerName: 'Guest',
  });
  await guestSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'guest-claim');

  hostSocket.send({
    type: 'set_seat_kind',
    requestId: 'host-seat-type',
    seatId: 2,
    kind: 'ai',
  });
  await hostSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'host-seat-type');

  hostSocket.send({
    type: 'start_game',
    requestId: 'start-ok',
  });
  await hostSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'start-ok');
  const gameSnapshot = await hostSocket.waitFor((message) => message.type === 'game_snapshot');
  assert.equal(gameSnapshot.status, 'in_progress');
  assert.equal(gameSnapshot.state.phase, 'court');

  const room = instance.manager.getRoom(created.roomCode);
  const aiProfile = room.aiMeta.players[2].profile;
  assert.ok(aiProfile, 'AI seats should receive explicit trained profiles.');
  assert.equal(aiProfile.source, 'emergent-trained');
  assert.equal(aiProfile.basePersonalityId, null);

  await guestSocket.close();
  await hostSocket.close();
});

test('multiplayer snapshots redact sealed orders and hidden mercenary spend', async (t) => {
  const harness = await createStartedThreePlayerRoom(t);
  const { room, host, guest } = harness;

  room.gameState.phase = 'orders';
  room.gameState.currentLevies = {};
  room.broadcastGameSnapshots({ previousPhase: 'court' });
  await host.socket.waitFor((message) => message.type === 'phase_changed' && message.phase === 'orders');
  await guest.socket.waitFor((message) => message.type === 'phase_changed' && message.phase === 'orders');

  const actorSeatId = room.gameState.players.find((player) => {
    if (![0, 1].includes(player.id) || player.gold < 1) return false;
    return Boolean(firstPlayableOffice(room, player.id));
  }).id;
  const viewerSeatId = actorSeatId === 0 ? 1 : 0;
  const actorSocket = actorSeatId === 0 ? host.socket : guest.socket;
  const viewerSocket = viewerSeatId === 0 ? host.socket : guest.socket;
  const actorRequestId = 'submit-secret-orders';
  const actorOffice = firstPlayableOffice(room, actorSeatId);
  const actorGoldBefore = room.gameState.players.find((player) => player.id === actorSeatId).gold;

  actorSocket.send({
    type: 'submit_orders',
    requestId: actorRequestId,
    orders: {
      deployments: {
        [actorOffice]: 'capital',
      },
      mercenaries: [
        { officeKey: actorOffice, count: 1 },
      ],
      candidate: viewerSeatId,
    },
  });

  await actorSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === actorRequestId);
  const hasSubmittedActorOrder = (message) => message.type === 'game_snapshot' && Boolean(message.state?.allOrders?.[String(actorSeatId)]);
  const actorGame = await actorSocket.waitFor(hasSubmittedActorOrder);
  const viewerGame = await viewerSocket.waitFor(hasSubmittedActorOrder);

  const actorGoldVisible = actorGame.state.players.find((player) => player.id === actorSeatId).gold;
  const viewerGoldVisible = viewerGame.state.players.find((player) => player.id === actorSeatId).gold;
  assert.equal(actorGoldVisible, actorGoldBefore - 1);
  assert.equal(viewerGoldVisible, actorGoldBefore);

  const historyEntry = viewerGame.state.history.find((entry) => entry.type === 'orders_submitted' && entry.actorId === actorSeatId);
  assert.ok(historyEntry);
  assert.equal(historyEntry.details, null);
  assert.equal(viewerGame.state.history.some((entry) => entry.type === 'hire_mercenaries'), false);
  assert.equal(viewerGame.state.allOrders[String(actorSeatId)], true);
});

test('multiplayer rooms allow reclaiming a disconnected live seat', async (t) => {
  const harness = await createStartedThreePlayerRoom(t);
  const { instance, roomCode, host, guest } = harness;

  await guest.socket.close();
  const disconnected = await host.socket.waitFor((message) => message.type === 'seat_disconnected' && message.seatId === 1);
  assert.equal(disconnected.seatId, 1);

  const rejoined = await joinRoom(instance.url, roomCode, {
    playerName: 'Guest Rejoin',
    seatToken: guest.seatToken,
  });
  assert.deepEqual(rejoined.claimResult, { seatId: 1 });

  const rejoinSocket = await connectSocket(instance.url, {
    roomCode,
    sessionToken: rejoined.sessionToken,
    playerName: 'Guest Rejoin',
    seatToken: rejoined.seatToken,
  });
  const rejoinPrivate = await rejoinSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 1);
  assert.equal(rejoinPrivate.seatId, 1);
  const rejoinGame = await rejoinSocket.waitFor((message) => message.type === 'game_snapshot');
  assert.equal(rejoinGame.status, 'in_progress');

  await rejoinSocket.close();
});

test('only the host can advance past resolution in multiplayer', async (t) => {
  const harness = await createStartedThreePlayerRoom(t);
  const { room, guest } = harness;

  room.gameState.phase = 'resolution';
  room.gameState.nextBasileusId = room.gameState.basileusId;
  room.broadcastGameSnapshots({ previousPhase: 'orders' });
  await guest.socket.waitFor((message) => message.type === 'phase_changed' && message.phase === 'resolution');

  guest.socket.send({
    type: 'continue_after_resolution',
    requestId: 'guest-continue',
  });
  const rejection = await guest.socket.waitFor((message) => message.type === 'action_rejected' && message.requestId === 'guest-continue');
  assert.match(rejection.reason, /host/i);
});
