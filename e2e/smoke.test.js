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
  '[data-defender-reward-choice][data-choice="empire"]',
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

async function startLocalGame(page, { mode = 'single', players = 5, turns = 6, seed = 'smoke' } = {}) {
  await chooseSetup(page, 'setupMode', mode);
  await chooseSetup(page, 'setupPlayers', String(players));
  await chooseSetup(page, 'setupTurns', String(turns));
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
