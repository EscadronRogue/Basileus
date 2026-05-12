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
        this.waiters = this.waiters.filter((waiter) => waiter !== record);
        reject(new Error('Timed out waiting for WebSocket message.'));
      }, timeoutMs);

      const record = {
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      this.waiters.push(record);
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
  return player.majorTitles.find((titleKey) => titleKey !== 'PATRIARCH') || null;
}

async function createStartedThreePlayerRoom(baseUrl, manager) {
  const createPayload = await createRoom(baseUrl, {
    playerName: 'Host',
    config: {
      playerCount: 3,
      deckSize: 6,
      seed: 'alpha-seed',
    },
  });

  assert.equal(createPayload.claimResult, null);
  assert.equal(createPayload.seatToken, null);

  const hostSocket = await connectSocket(baseUrl, {
    roomCode: createPayload.roomCode,
    sessionToken: createPayload.sessionToken,
    playerName: 'Host',
    seatToken: createPayload.seatToken,
  });

  hostSocket.send({
    type: 'claim_seat',
    requestId: 'claim-host',
    seatId: 0,
    playerName: 'Host',
  });
  await hostSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'claim-host');
  const hostPrivate = await hostSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 0);

  const joinPayload = await joinRoom(baseUrl, createPayload.roomCode, {
    playerName: 'Guest',
  });
  assert.equal(joinPayload.claimResult, null);
  assert.equal(joinPayload.seatToken, null);

  const guestSocket = await connectSocket(baseUrl, {
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
  const hostGamePrivate = await hostSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 0);
  const guestGamePrivate = await guestSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 1);

  return {
    roomCode: createPayload.roomCode,
    room: manager.getRoom(createPayload.roomCode),
    host: {
      socket: hostSocket,
      sessionToken: createPayload.sessionToken,
      seatToken: hostPrivate.seatToken,
      game: hostGame,
      private: hostGamePrivate,
    },
    guest: {
      socket: guestSocket,
      sessionToken: joinPayload.sessionToken,
      seatToken: guestPrivate.seatToken,
      game: guestGame,
      private: guestGamePrivate,
    },
    close: async () => {
      await Promise.allSettled([
        hostSocket.close(),
        guestSocket.close(),
      ]);
    },
  };
}

async function createStartedFourPlayerRoom(baseUrl, manager) {
  const createPayload = await createRoom(baseUrl, {
    playerName: 'Host',
    config: {
      playerCount: 4,
      deckSize: 6,
      seed: 'deal-privacy-seed',
    },
  });

  const hostSocket = await connectSocket(baseUrl, {
    roomCode: createPayload.roomCode,
    sessionToken: createPayload.sessionToken,
    playerName: 'Host',
    seatToken: createPayload.seatToken,
  });
  hostSocket.send({
    type: 'claim_seat',
    requestId: 'claim-host',
    seatId: 0,
    playerName: 'Host',
  });
  await hostSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'claim-host');
  const hostPrivate = await hostSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 0);

  const guestJoin = await joinRoom(baseUrl, createPayload.roomCode, {
    playerName: 'Guest',
  });
  const guestSocket = await connectSocket(baseUrl, {
    roomCode: guestJoin.roomCode,
    sessionToken: guestJoin.sessionToken,
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

  const observerJoin = await joinRoom(baseUrl, createPayload.roomCode, {
    playerName: 'Observer',
  });
  const observerSocket = await connectSocket(baseUrl, {
    roomCode: observerJoin.roomCode,
    sessionToken: observerJoin.sessionToken,
    playerName: 'Observer',
  });
  observerSocket.send({
    type: 'claim_seat',
    requestId: 'claim-observer',
    seatId: 2,
    playerName: 'Observer',
  });
  await observerSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'claim-observer');
  const observerPrivate = await observerSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 2);

  hostSocket.send({
    type: 'set_seat_kind',
    requestId: 'seat-three-ai',
    seatId: 3,
    kind: 'ai',
  });
  await hostSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'seat-three-ai');

  hostSocket.send({
    type: 'start_game',
    requestId: 'start-room',
  });
  await hostSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'start-room');
  const hostGame = await hostSocket.waitFor((message) => message.type === 'game_snapshot');
  const guestGame = await guestSocket.waitFor((message) => message.type === 'game_snapshot');
  const observerGame = await observerSocket.waitFor((message) => message.type === 'game_snapshot');
  const hostGamePrivate = await hostSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 0);
  const guestGamePrivate = await guestSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 1);
  const observerGamePrivate = await observerSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 2);

  return {
    roomCode: createPayload.roomCode,
    room: manager.getRoom(createPayload.roomCode),
    host: {
      socket: hostSocket,
      sessionToken: createPayload.sessionToken,
      seatToken: hostPrivate.seatToken,
      game: hostGame,
      private: hostGamePrivate,
    },
    guest: {
      socket: guestSocket,
      sessionToken: guestJoin.sessionToken,
      seatToken: guestPrivate.seatToken,
      game: guestGame,
      private: guestGamePrivate,
    },
    observer: {
      socket: observerSocket,
      sessionToken: observerJoin.sessionToken,
      seatToken: observerPrivate.seatToken,
      game: observerGame,
      private: observerGamePrivate,
    },
    close: async () => {
      await Promise.allSettled([
        hostSocket.close(),
        guestSocket.close(),
        observerSocket.close(),
      ]);
    },
  };
}

async function withServer(run) {
  const instance = await startMultiplayerServer({ port: 0 });
  try {
    await run(instance);
  } finally {
    await instance.close();
  }
}

async function runCase(name, fn) {
  console.log(`running - ${name}`);
  await fn();
  console.log(`ok - ${name}`);
}

async function verifyLobbyAndStart() {
  await withServer(async (instance) => {
    const created = await createRoom(instance.url, {
      playerName: 'Host',
      config: {
        playerCount: 3,
        deckSize: 6,
        seed: 'room-seed',
      },
    });
    assert.equal(created.claimResult, null);
    assert.equal(created.seatToken, null);

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

    hostSocket.send({
      type: 'claim_seat',
      requestId: 'host-claim',
      seatId: 0,
      playerName: 'Host',
    });
    await hostSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'host-claim');

    const joined = await joinRoom(instance.url, created.roomCode, {
      playerName: 'Guest',
    });
    assert.equal(joined.claimResult, null);
    assert.equal(joined.seatToken, null);

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

    await guestSocket.close();
    await hostSocket.close();
  });
}

async function verifyOrderRedaction() {
  await withServer(async (instance) => {
    const harness = await createStartedThreePlayerRoom(instance.url, instance.manager);
    try {
      const { room, host, guest } = harness;

      const actorSeatId = room.gameState.players.find((player) => {
        if (![0, 1].includes(player.id) || player.gold < 1) return false;
        return Boolean(firstPlayableOffice(room, player.id));
      }).id;
      const viewerSeatId = actorSeatId === 0 ? 1 : 0;
      const actorSocket = actorSeatId === 0 ? host.socket : guest.socket;
      const viewerSocket = viewerSeatId === 0 ? host.socket : guest.socket;
      const actorOffice = firstPlayableOffice(room, actorSeatId);
      const actorGoldBefore = room.gameState.players.find((player) => player.id === actorSeatId).gold;

      actorSocket.send({
        type: 'court_action',
        requestId: 'hire-public-mercenaries',
        action: 'hire-mercenaries',
        office: actorOffice,
        count: 1,
      });

      await actorSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'hire-public-mercenaries');
      const mercenaryVisible = (message) =>
        message.type === 'game_snapshot'
        && message.state.phase === 'court'
        && message.state.currentMercenaryTroops?.[String(actorSeatId)] === 1;
      const actorCourtGame = await actorSocket.waitFor(mercenaryVisible);
      const viewerCourtGame = await viewerSocket.waitFor(mercenaryVisible);

      const actorGoldVisible = actorCourtGame.state.players.find((player) => player.id === actorSeatId).gold;
      const viewerGoldVisible = viewerCourtGame.state.players.find((player) => player.id === actorSeatId).gold;
      assert.equal(actorGoldVisible, actorGoldBefore - 1);
      assert.equal(viewerGoldVisible, actorGoldBefore - 1);
      assert.equal(viewerCourtGame.state.currentMercenaryTroops[String(actorSeatId)], 1);
      assert.equal(viewerCourtGame.state.history.some((entry) => entry.type === 'hire_mercenaries' && entry.actorId === actorSeatId), true);

      room.gameState.phase = 'orders';
      room.gameState.currentLevies = {};
      room.broadcastGameSnapshots({ previousPhase: 'court' });
      await host.socket.waitFor((message) => message.type === 'phase_changed' && message.phase === 'orders');
      await guest.socket.waitFor((message) => message.type === 'phase_changed' && message.phase === 'orders');
      await host.socket.waitFor((message) => message.type === 'game_snapshot' && message.state.phase === 'orders');
      await guest.socket.waitFor((message) => message.type === 'game_snapshot' && message.state.phase === 'orders');

      actorSocket.send({
        type: 'submit_orders',
        requestId: 'submit-invalid-secret-orders',
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

      const invalidReject = await actorSocket.waitFor((message) => message.type === 'action_rejected' && message.requestId === 'submit-invalid-secret-orders');
      assert.match(invalidReject.reason, /Court/i);

      actorSocket.send({
        type: 'submit_orders',
        requestId: 'submit-secret-orders',
        orders: {
          deployments: {
            [actorOffice]: 'capital',
          },
          candidate: viewerSeatId,
        },
      });

      await actorSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'submit-secret-orders');
      const hasSubmittedActorOrder = (message) => message.type === 'game_snapshot' && Boolean(message.state?.allOrders?.[String(actorSeatId)]);
      const actorGame = await actorSocket.waitFor(hasSubmittedActorOrder);
      const viewerGame = await viewerSocket.waitFor(hasSubmittedActorOrder);

      const historyEntry = viewerGame.state.history.find((entry) => entry.type === 'orders_submitted' && entry.actorId === actorSeatId);
      assert.ok(historyEntry);
      assert.equal(historyEntry.details, null);
      assert.equal(viewerGame.state.allOrders[String(actorSeatId)], true);
    } finally {
      await harness.close();
    }
  });
}

async function verifySeatReclaim() {
  await withServer(async (instance) => {
    const harness = await createStartedThreePlayerRoom(instance.url, instance.manager);
    let rejoinSocket = null;
    try {
      const { roomCode, host, guest } = harness;

      await guest.socket.close();
      const disconnected = await host.socket.waitFor((message) => message.type === 'seat_disconnected' && message.seatId === 1);
      assert.equal(disconnected.seatId, 1);

      const rejoined = await joinRoom(instance.url, roomCode, {
        playerName: 'Guest Rejoin',
      });
      assert.equal(rejoined.claimResult, null);

      rejoinSocket = await connectSocket(instance.url, {
        roomCode,
        sessionToken: rejoined.sessionToken,
        playerName: 'Guest Rejoin',
      });
      const spectatorPrivate = await rejoinSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId == null);
      assert.equal(spectatorPrivate.seatId, null);

      rejoinSocket.send({
        type: 'claim_seat',
        requestId: 'manual-live-claim',
        seatId: 1,
        playerName: 'Guest Rejoin',
      });
      await rejoinSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'manual-live-claim');
      const rejoinPrivate = await rejoinSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 1);
      assert.equal(rejoinPrivate.seatId, 1);
      const rejoinGame = await rejoinSocket.waitFor((message) => message.type === 'game_snapshot');
      assert.equal(rejoinGame.status, 'in_progress');
    } finally {
      if (rejoinSocket) await rejoinSocket.close();
      await harness.close();
    }
  });
}

async function verifySaveLoadRecovery() {
  await withServer(async (instance) => {
    const harness = await createStartedThreePlayerRoom(instance.url, instance.manager);
    let loadedSocket = null;
    try {
      const { room, host } = harness;
      room.gameState.players[0].gold = 7;
      room.gameState.themes.CPL.C = 1;
      room.gameState.allOrders[1] = {
        deployments: { DOM_EAST: 'capital' },
        candidate: 0,
      };
      const rngBeforeSave = room.gameState.rng.getState();
      const saveGame = room.createSavePayload();

      const loaded = await createRoom(instance.url, {
        playerName: 'Loader',
        saveGame,
      });
      assert.notEqual(loaded.roomCode, harness.roomCode);
      assert.equal(loaded.claimResult, null);

      const loadedRoom = instance.manager.getRoom(loaded.roomCode);
      assert.equal(loadedRoom.gameState.players[0].gold, 7);
      assert.equal(loadedRoom.gameState.themes.CPL.C, 1);
      assert.deepEqual(loadedRoom.gameState.allOrders[1], {
        deployments: { DOM_EAST: 'capital' },
        candidate: 0,
      });
      assert.equal(loadedRoom.gameState.rng.getState(), rngBeforeSave);

      loadedSocket = await connectSocket(instance.url, {
        roomCode: loaded.roomCode,
        sessionToken: loaded.sessionToken,
        playerName: 'Loader',
      });
      await loadedSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId == null);
      loadedSocket.send({
        type: 'claim_seat',
        requestId: 'claim-loaded-seat',
        seatId: 0,
        playerName: 'Loader',
      });
      await loadedSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'claim-loaded-seat');
      const privateSnapshot = await loadedSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 0);
      assert.equal(privateSnapshot.seatId, 0);

      host.socket.send({
        type: 'request_save',
        requestId: 'download-save',
      });
      const saveMessage = await host.socket.waitFor((message) => message.type === 'room_save' && message.requestId === 'download-save');
      assert.equal(saveMessage.save.schema, 'basileus.multiplayer.save');
    } finally {
      if (loadedSocket) await loadedSocket.close();
      await harness.close();
    }
  });
}

async function verifyDealPrivacy() {
  await withServer(async (instance) => {
    const harness = await createStartedFourPlayerRoom(instance.url, instance.manager);
    try {
      const { host, guest, observer } = harness;

      host.socket.send({
        type: 'court_action',
        requestId: 'send-private-deal',
        action: 'deal-send',
        counterpartyId: 1,
        clauses: [
          { kind: 'non_revocation', direction: 'give', durationTurns: 1 },
        ],
      });

      await host.socket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'send-private-deal');
      const publicSnapshot = await host.socket.waitFor((message) => message.type === 'game_snapshot' && message.state.phase === 'court');
      const hostPrivate = await host.socket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 0 && message.dealThreads.length === 1);
      const guestPrivate = await guest.socket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 1 && message.dealThreads.length === 1);
      const observerPrivate = await observer.socket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === 2);

      assert.equal('dealThreads' in publicSnapshot.state, false);
      assert.equal('activeDealObligations' in publicSnapshot.state, false);
      assert.equal('reservedGold' in publicSnapshot.state, false);
      assert.equal(hostPrivate.dealThreads[0].currentOffer.clauses.length, 1);
      assert.equal(hostPrivate.dealThreads[0].id, guestPrivate.dealThreads[0].id);
      assert.deepEqual(observerPrivate.dealThreads, []);
      assert.deepEqual(observerPrivate.dealCounts, {
        pendingInbox: 0,
        pendingOutbox: 0,
        activeObligations: 0,
      });
    } finally {
      await harness.close();
    }
  });
}

async function verifyDealOrderEnforcement() {
  await withServer(async (instance) => {
    const harness = await createStartedThreePlayerRoom(instance.url, instance.manager);
    try {
      const { room, host, guest } = harness;

      const actorSeatId = room.gameState.players.find((player) => {
        if (![0, 1].includes(player.id)) return false;
        return Boolean(firstPlayableOffice(room, player.id));
      }).id;
      const counterpartySeatId = actorSeatId === 0 ? 1 : 0;
      const actorSocket = actorSeatId === 0 ? host.socket : guest.socket;
      const counterpartySocket = counterpartySeatId === 0 ? host.socket : guest.socket;

      counterpartySocket.send({
        type: 'court_action',
        requestId: 'send-locking-deal',
        action: 'deal-send',
        counterpartyId: actorSeatId,
        clauses: [
          { kind: 'coup_support', direction: 'ask', troopCount: 1, candidateId: counterpartySeatId, durationTurns: 1 },
        ],
      });

      await counterpartySocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'send-locking-deal');
      const actorThreadSnapshot = await actorSocket.waitFor((message) => (
        message.type === 'private_snapshot'
        && message.seatId === actorSeatId
        && message.dealThreads.some((thread) => thread.status === 'open' && thread.awaitingPlayerId === actorSeatId)
      ));
      const thread = actorThreadSnapshot.dealThreads.find((entry) => entry.status === 'open' && entry.awaitingPlayerId === actorSeatId);

      actorSocket.send({
        type: 'court_action',
        requestId: 'accept-locking-deal',
        action: 'deal-accept',
        threadId: thread.id,
        expectedRevision: thread.revision,
      });

      await actorSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'accept-locking-deal');
      const acceptedSnapshot = await actorSocket.waitFor((message) => message.type === 'game_snapshot' && message.state.phase === 'court');
      assert.equal('dealThreads' in acceptedSnapshot.state, false);
      await actorSocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === actorSeatId);
      await counterpartySocket.waitFor((message) => message.type === 'private_snapshot' && message.seatId === counterpartySeatId);

      room.gameState.phase = 'orders';
      room.broadcastGameSnapshots({ previousPhase: 'court' });
      await host.socket.waitFor((message) => message.type === 'phase_changed' && message.phase === 'orders');
      await guest.socket.waitFor((message) => message.type === 'phase_changed' && message.phase === 'orders');
      await host.socket.waitFor((message) => message.type === 'game_snapshot' && message.state.phase === 'orders');
      await guest.socket.waitFor((message) => message.type === 'game_snapshot' && message.state.phase === 'orders');

      const actorOrderLocks = await actorSocket.waitFor((message) => (
        message.type === 'private_snapshot'
        && message.seatId === actorSeatId
        && message.orderLocks?.candidateId === counterpartySeatId
        && Array.isArray(message.orderLocks.officeSelections)
        && message.orderLocks.officeSelections.length > 0
      ));
      const lockedOfficeKey = actorOrderLocks.orderLocks.officeSelections[0].officeKey;

      actorSocket.send({
        type: 'submit_orders',
        requestId: 'submit-locked-orders',
        orders: {
          deployments: {
            [lockedOfficeKey]: 'frontier',
          },
          candidate: actorSeatId,
        },
      });

      await actorSocket.waitFor((message) => message.type === 'action_accepted' && message.requestId === 'submit-locked-orders');
      assert.equal(room.gameState.allOrders[actorSeatId].candidate, counterpartySeatId);
      assert.equal(room.gameState.allOrders[actorSeatId].deployments[lockedOfficeKey], 'capital');
    } finally {
      await harness.close();
    }
  });
}

async function verifyHostOnlyContinue() {
  await withServer(async (instance) => {
    const harness = await createStartedThreePlayerRoom(instance.url, instance.manager);
    try {
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
    } finally {
      await harness.close();
    }
  });
}

async function main() {
  await runCase('lobby ownership and room start', verifyLobbyAndStart);
  await runCase('public court mercenaries and sealed order redaction', verifyOrderRedaction);
  await runCase('private deal snapshots stay seat-local', verifyDealPrivacy);
  await runCase('accepted deal locks are enforced on submitted orders', verifyDealOrderEnforcement);
  await runCase('manual live seat reclaim', verifySeatReclaim);
  await runCase('save/load recovery', verifySaveLoadRecovery);
  await runCase('host-only resolution continue', verifyHostOnlyContinue);
  console.log('multiplayer verification passed');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || 'multiplayer verification failed');
  process.exit(1);
});
