// e2e/smoke.test.js - real-browser smoke tests for the shipped game.
//
// Runs the actual server and drives index.html in headless Chromium, failing on
// any console error or uncaught page exception. Run with `npm run test:browser`
// (requires `npx playwright install chromium` once).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { startMultiplayerServer } from '../multiplayer/server.js';

const PHASE_BUTTONS = [
  '[data-action="confirm-court-plan"]',
  '[data-action="confirm-estates"]',
  '[data-action="continue"]',
];

let server;
let browser;
let baseUrl;

before(async () => {
  server = await startMultiplayerServer({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${server.port}/`;
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openGame(t, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  t.after(() => context.close());
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url()}`);
    // The embedded SVG fallback only loads when fetching assets/*.svg fails.
    if (response.url().endsWith('/render/svgAssets.js')) problems.push('map fell back to embedded SVGs');
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  return { page, problems };
}

async function chooseSetup(page, selectId, value) {
  await page.click(`[data-setup-choice="${selectId}"] [data-setup-choice-value="${value}"]`);
}

async function startLocalGame(page, { mode = 'single', players = 5, turns = 6, seed = 'smoke', map = null } = {}) {
  await chooseSetup(page, 'setupMode', mode);
  await chooseSetup(page, 'setupPlayers', String(players));
  await chooseSetup(page, 'setupTurns', String(turns));
  if (map) await chooseSetup(page, 'setupMap', map);
  await page.click('#setupAiDetails summary').catch(() => {});
  await page.click('.setup-advanced-card:has(#setupSeed) summary');
  await page.fill('#setupSeed', seed);
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__basileus?.state?.phase && window.__basileus.state.phase !== 'setup');
}

function readGame(page) {
  return page.evaluate(() => {
    const game = window.__basileus;
    if (!game?.state) return null;
    return {
      phase: game.state.phase,
      round: game.state.round,
      gameOver: game.state.gameOver?.type || null,
      activePlayer: game.activePlayer,
      locked: Boolean(game.state.allOrders?.[game.activePlayer]),
      isBasileus: game.state.basileusId === game.activePlayer,
    };
  });
}

// Plays the human seat with simple legal moves until the game ends. Buttons
// are clicked like a player would; the two drag-heavy screens (office links
// and deployment) go through the same controller callbacks the panels use.
async function playToEnd(page, { maxSteps = 600 } = {}) {
  for (let step = 0; step < maxSteps; step += 1) {
    const game = await readGame(page);
    if (game?.gameOver || game?.phase === 'scoring') return game;

    if (game?.phase === 'title_redistribution' && game.isBasileus) {
      await page.evaluate(async () => {
        const { suggestMajorTitleAssignments } = await import('/engine/actions.js');
        const controller = window.__basileus;
        controller.confirmTitleRedistribution(suggestMajorTitleAssignments(controller.state, controller.activePlayer));
      });
      continue;
    }

    if (game?.phase === 'deployment' && !game.locked) {
      await page.evaluate(async () => {
        const { getPlayerOrderOfficeKeys } = await import('/engine/orders.js');
        const controller = window.__basileus;
        const armies = {};
        for (const officeKey of getPlayerOrderOfficeKeys(controller.state, controller.activePlayer)) {
          armies[officeKey] = { funded: 999, destination: 'frontier' };
        }
        controller.lockOrders({ armies, mercenaries: { count: 0, destination: 'frontier' } });
      });
      continue;
    }

    let clicked = false;
    for (const selector of PHASE_BUTTONS) {
      const button = page.locator(selector).first();
      if (await button.isVisible() && await button.isEnabled()) {
        await button.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) await page.waitForTimeout(100);
  }
  throw new Error(`Game did not finish within ${maxSteps} steps: ${JSON.stringify(await readGame(page))}`);
}

test('setup screen loads self-hosted fonts without errors', async (t) => {
  const { page, problems } = await openGame(t);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((font) => font.status === 'loaded').map((font) => font.family);
  });
  assert.ok(fonts.some((family) => family.includes('Cinzel')), 'Cinzel loads');
  assert.ok(fonts.some((family) => family.includes('EB Garamond')), 'EB Garamond loads');
  assert.deepEqual(problems, []);
});

test('single-player short game plays through to final scoring', { timeout: 600_000 }, async (t) => {
  const { page, problems } = await openGame(t);
  await startLocalGame(page, { mode: 'single', players: 5, turns: 6, seed: 'smoke-single' });
  assert.equal(await page.locator('#mapContainer svg').count() > 0, true, 'map renders');

  const end = await playToEnd(page);

  assert.ok(end.gameOver || end.phase === 'scoring', `game finished: ${JSON.stringify(end)}`);
  assert.deepEqual(problems, []);
});

test('the compact map starts, draws its 21 provinces, and plays to the end', { timeout: 600_000 }, async (t) => {
  const { page, problems } = await openGame(t);
  await startLocalGame(page, { mode: 'single', players: 4, turns: 6, seed: 'smoke-compact', map: 'compact' });
  const map = await page.evaluate(() => ({
    mapId: window.__basileus.state.mapId,
    themes: Object.keys(window.__basileus.state.themes).length,
    shapes: document.querySelectorAll('#mapContainer .province-shape').length,
    hitboxes: document.querySelectorAll('#mapContainer .province-hitbox').length,
  }));
  assert.equal(map.mapId, 'compact');
  // 21 provinces plus Constantinople.
  assert.equal(map.themes, 22);
  assert.equal(map.shapes, 22, 'every compact province has a fused outline');
  assert.equal(map.hitboxes, 22, 'every compact province can be clicked');

  const end = await playToEnd(page);

  assert.ok(end.gameOver || end.phase === 'scoring', `game finished: ${JSON.stringify(end)}`);
  assert.deepEqual(problems, []);
});

function readSnapshot(page) {
  return page.evaluate(() => {
    const { state, activePlayer } = window.__basileus;
    return {
      round: state.round,
      phase: state.phase,
      activePlayer,
      rng: state.rng.getState(),
      gold: state.players.map((player) => player.gold),
      owners: Object.values(state.themes).map((theme) => theme.owner),
      aiSeats: Object.values(window.__basileus.aiMeta?.players || {}).filter((player) => player.isAI).length,
    };
  });
}

test('an interrupted single-player game resumes exactly where it stopped', { timeout: 600_000 }, async (t) => {
  const { page, problems } = await openGame(t);
  await startLocalGame(page, { mode: 'single', players: 4, turns: 6, seed: 'smoke-resume' });

  // Play into round 2, then leave the page mid-game.
  for (let step = 0; step < 200; step += 1) {
    const game = await readGame(page);
    if (game.round >= 2 && ['court', 'estates'].includes(game.phase)) break;
    if (game.phase === 'deployment' && !game.locked) {
      await page.evaluate(async () => {
        const { getPlayerOrderOfficeKeys } = await import('/engine/orders.js');
        const controller = window.__basileus;
        const armies = {};
        for (const key of getPlayerOrderOfficeKeys(controller.state, controller.activePlayer)) armies[key] = { funded: 999, destination: 'frontier' };
        controller.lockOrders({ armies, mercenaries: { count: 0, destination: 'frontier' } });
      });
      continue;
    }
    const button = page.locator(PHASE_BUTTONS.join(', ')).first();
    if (await button.isVisible() && await button.isEnabled()) await button.click();
    else await page.waitForTimeout(100);
  }
  const before = await readSnapshot(page);
  assert.ok(before.round >= 2, 'reached round 2');
  await page.evaluate(() => window.__basileus.saveNow());

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#resumeGameCard').waitFor({ state: 'visible' });
  assert.match(await page.locator('#resumeGameSummary').textContent(), new RegExp(`round ${before.round} of 6`));
  await page.click('#btnResumeGame');
  await page.waitForFunction(() => window.__basileus?.state?.phase && window.__basileus.state.phase !== 'setup');

  assert.deepEqual(await readSnapshot(page), before, 'state, RNG position, and AI seats are restored');
  const end = await playToEnd(page);
  assert.ok(end.gameOver || end.phase === 'scoring');

  // A finished game is not offered again.
  await page.evaluate(() => window.__basileus.saveNow());
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#resumeGameCard').isVisible(), false);
  assert.deepEqual(problems, []);
});

test('key words are bold and explain themselves in nested tooltips', async (t) => {
  const { page, problems } = await openGame(t);
  assert.equal(await page.locator('#rulesCardBody h3').count() >= 5, true, 'rules are rendered on the setup screen');
  assert.equal(await page.locator('#rulesCardBody .glossary-index dt').count() > 20, true, 'the glossary is listed with the rules');

  await startLocalGame(page, { mode: 'single', players: 3, turns: 6, seed: 'smoke-glossary' });
  assert.equal(await page.locator('.phase-guide').count(), 0, 'normal games have no tutorial cards');
  await page.waitForFunction(() => document.querySelectorAll('#sidebar .glossary-term').length > 0);

  // Hovering shows the definition; resting on the word locks the tooltip.
  const term = page.locator('#sidebar .glossary-term').first();
  const termId = await term.getAttribute('data-glossary-id');
  await term.hover();
  const tooltip = page.locator('.glossary-tooltip').first();
  await tooltip.waitFor({ state: 'visible' });
  await page.waitForSelector('.glossary-tooltip.is-locked');

  // A key word inside a locked tooltip opens a second tooltip beside it.
  const nested = tooltip.locator('.glossary-term').first();
  assert.notEqual(await nested.getAttribute('data-glossary-id'), termId, 'a tooltip does not mark its own word');
  await nested.hover();
  await page.waitForFunction(() => document.querySelectorAll('.glossary-tooltip.is-visible').length === 2);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.glossary-tooltip').count(), 0);

  // Clicking a word locks its tooltip at once; clicking elsewhere closes it.
  await term.click();
  await page.waitForSelector('.glossary-tooltip.is-locked');
  await page.mouse.click(5, 5);
  assert.equal(await page.locator('.glossary-tooltip').count(), 0);
  assert.deepEqual(problems, []);
});

test('the tutorial guides a full round, then leaves no save behind', async (t) => {
  const { page, problems } = await openGame(t);
  await page.evaluate(() => window.localStorage.removeItem('basileus.localGame'));
  await page.click('#btnTutorial');
  await page.waitForSelector('.tutorial-coach');
  const stepId = () => page.evaluate(() => window.__basileusTutorial.step?.id);
  const clickSocket = (selector) => page.evaluate((target) => document.querySelector(target).click(), selector);

  // Follow the coach card: do what it asks, press Next when it only explains.
  const actions = {
    'bishop-seat': () => clickSocket('[data-court-power="PATRIARCH"] [data-wire-seat-start]'),
    'bishop-player': () => clickSocket('[data-court-power="PATRIARCH"] [data-wire-player-finish="0"]'),
    'bishop-second': async () => {
      await page.evaluate(() => [...document.querySelectorAll('[data-court-power="PATRIARCH"] [data-wire-seat-start]')][1].click());
      await clickSocket('[data-court-power="PATRIARCH"] [data-wire-player-finish="2"]');
    },
    strategos: async () => {
      await clickSocket('[data-court-power="DOM_EAST"] [data-wire-seat-start]');
      await clickSocket('[data-court-power="DOM_EAST"] [data-wire-player-finish="0"]');
    },
    'court-lock': () => page.click('[data-action="confirm-court-plan"]'),
    'estates-bid': () => page.locator('[data-estate-add]:not([disabled])').first().click(),
    'estates-lock': () => page.click('[data-action="confirm-estates"]'),
    'deploy-frontier': async () => {
      while (await page.locator('.army-card.unresolved').count()) {
        await page.locator('.army-card.unresolved [data-destination="frontier"]').first().click();
      }
    },
    'deploy-lock': () => page.click('[data-action="lock-orders"]'),
    'resolution-continue': () => page.click('[data-action="continue"]'),
  };
  const seen = [];
  for (let guard = 0; guard < 80; guard += 1) {
    const id = await stepId();
    if (seen.at(-1) !== id) seen.push(id);
    if (id === 'on-your-own') break;
    assert.equal(await page.locator('.tutorial-coach-title').isVisible(), true);
    if (actions[id]) await actions[id]();
    else await page.click('[data-tutorial="next"]');
    await page.waitForFunction((previous) => window.__basileusTutorial.step?.id !== previous, id, { timeout: 15000 });
  }

  for (const id of ['welcome', 'bishop-seat', 'bishop-player', 'strategos', 'court-lock', 'estates-bid', 'deploy-frontier', 'deploy-lock', 'resolution-coup', 'resolution-continue', 'on-your-own']) {
    assert.ok(seen.includes(id), `the tutorial reached ${id}`);
  }
  assert.equal(await page.evaluate(() => window.__basileus.state.round), 2);
  assert.equal(await page.evaluate(() => window.localStorage.getItem('basileus.localGame')), null, 'the tutorial never autosaves');

  await page.click('[data-tutorial="leave"]');
  await page.waitForSelector('#btnTutorial', { state: 'visible' });
  assert.equal(await page.locator('#resumeGameCard').isVisible(), false);
  assert.deepEqual(problems, []);
});

test('screen readers hear new phases and turn results', async (t) => {
  const { page, problems } = await openGame(t);
  await startLocalGame(page, { mode: 'single', players: 3, turns: 6, seed: 'smoke-a11y' });
  const announcer = page.locator('#liveAnnouncer');
  assert.equal(await announcer.getAttribute('aria-live'), 'polite');
  await page.waitForFunction(() => /Round 1 of 6/.test(document.getElementById('liveAnnouncer').textContent));

  for (let step = 0; step < 100; step += 1) {
    const game = await readGame(page);
    if (game.phase === 'resolution') break;
    if (game.phase === 'deployment' && !game.locked) {
      await page.evaluate(async () => {
        const { getPlayerOrderOfficeKeys } = await import('/engine/orders.js');
        const controller = window.__basileus;
        const armies = {};
        for (const key of getPlayerOrderOfficeKeys(controller.state, controller.activePlayer)) armies[key] = { funded: 999, destination: 'frontier' };
        controller.lockOrders({ armies, mercenaries: { count: 0, destination: 'frontier' } });
      });
      continue;
    }
    const button = page.locator(PHASE_BUTTONS.join(', ')).first();
    if (await button.isVisible() && await button.isEnabled()) await button.click();
    else await page.waitForTimeout(100);
  }
  await page.waitForFunction(() => /Round 1 resolved\..*(Basileus|throne)/.test(document.getElementById('liveAnnouncer').textContent));
  assert.deepEqual(problems, []);
});

test('map filters, zoom, and province selection respond to input', async (t) => {
  const { page, problems } = await openGame(t);
  await startLocalGame(page, { mode: 'single', players: 5, turns: 6, seed: 'smoke-map' });
  const svg = page.locator('#mapContainer svg').first();

  await page.click('[data-map-filter="estates"]');
  assert.match(await svg.getAttribute('class'), /map-filter-estates/);

  const viewport = page.locator('#mapContainer svg g[transform]').first();
  const before = await viewport.getAttribute('transform');
  await page.click('.map-zoom-controls .map-control-btn >> nth=0');
  assert.notEqual(await viewport.getAttribute('transform'), before, 'zoom changes the viewport');
  assert.match(await svg.getAttribute('class'), /is-map-zoomed/);

  const province = page.locator('#mapContainer [data-id="THS"]').last();
  const box = await province.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => Boolean(window.__basileus.selectedProvinceId));
  assert.deepEqual(problems, []);
});

test('desktop map fills its area with readable, non-overlapping labels', async (t) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 2560, height: 1440 }]) {
    const { page, problems } = await openGame(t, viewport);
    await startLocalGame(page, { mode: 'single', players: 5, turns: 6, seed: 'smoke-layout' });
    const layout = await page.evaluate(() => {
      const shell = document.querySelector('.map-shell').getBoundingClientRect();
      const area = document.getElementById('mapArea').getBoundingClientRect();
      const names = [...document.querySelectorAll('#mapContainer .map-cart-name')]
        .map((text) => text.getBoundingClientRect().height).sort((a, b) => a - b);
      const boxes = [...document.querySelectorAll('#mapContainer .map-cartouche .map-cart-bg')].map((bg) => bg.getBoundingClientRect());
      let overlaps = 0;
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const width = Math.min(boxes[i].right, boxes[j].right) - Math.max(boxes[i].left, boxes[j].left);
          const height = Math.min(boxes[i].bottom, boxes[j].bottom) - Math.max(boxes[i].top, boxes[j].top);
          if (width > 2 && height > 2) overlaps += 1;
        }
      }
      return {
        fill: (shell.width * shell.height) / (area.width * area.height),
        medianNamePx: names[Math.floor(names.length / 2)],
        overlaps,
      };
    });
    assert.ok(layout.fill > 0.6, `map fills its area at ${viewport.width}px: ${layout.fill.toFixed(2)}`);
    assert.ok(layout.medianNamePx >= 8, `province names are legible: ${layout.medianNamePx}px`);
    assert.equal(layout.overlaps, 0, 'enlarged labels never overlap');
    assert.deepEqual(problems, []);
  }
});

test('hotseat game lets every dynasty act', async (t) => {
  const { page, problems } = await openGame(t);
  await startLocalGame(page, { mode: 'hotseat', players: 3, turns: 6, seed: 'smoke-hotseat' });
  const humans = await page.evaluate(() => window.__basileus.config.humanPlayerIds);
  assert.deepEqual(humans, [0, 1, 2]);
  assert.equal(await page.locator('#playerTabBar [data-player-id], #playerTabBar button').count() >= 3, true);
  assert.deepEqual(problems, []);
});

test('phone layout never scrolls horizontally', async (t) => {
  const { page, problems } = await openGame(t, { width: 390, height: 844 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(await overflow() <= 1, 'setup screen fits');
  await startLocalGame(page, { mode: 'single', players: 5, turns: 6, seed: 'smoke-phone' });
  assert.ok(await overflow() <= 1, 'game screen fits');
  await page.waitForTimeout(200);
  const mapTop = await page.evaluate(() => document.querySelector('.map-shell').getBoundingClientRect().top);
  assert.ok(mapTop >= 0 && mapTop < 844, 'the map is on screen right after starting');
  assert.deepEqual(problems, []);
});

test('multiplayer room can be created and joined from two browsers', async (t) => {
  const host = await openGame(t);
  await chooseSetup(host.page, 'setupMode', 'multiplayer');
  await host.page.fill('#setupPlayerName', 'Alice');
  await host.page.click('#btnCreateRoom');
  const roomCode = (await host.page.locator('.room-code').textContent({ timeout: 15_000 })).trim();
  assert.match(roomCode, /^[A-Z0-9]{6}$/);

  const guest = await openGame(t);
  await chooseSetup(guest.page, 'setupMode', 'multiplayer');
  await guest.page.fill('#setupPlayerName', 'Bob');
  await guest.page.fill('#setupRoomCode', roomCode);
  await guest.page.click('#btnJoinRoom');
  await guest.page.locator('.room-code', { hasText: roomCode }).waitFor({ timeout: 15_000 });

  await host.page.click('.btn-claim-seat[data-seat-id="0"]');
  await guest.page.click('.btn-claim-seat[data-seat-id="1"]');
  await host.page.locator('.multiplayer-seat', { hasText: 'Bob' }).waitFor({ timeout: 15_000 });

  assert.deepEqual(host.problems, []);
  assert.deepEqual(guest.problems, []);
});
