import assert from 'node:assert/strict';
import test from 'node:test';

import { listAvailableAiProfiles } from './profileStore.js';

function profile(id, name) {
  return { id, name, weights: {}, tactics: {}, meta: {} };
}

test('GitHub Pages loads direct trained-personalities JSON files without a same-origin API', async (t) => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;

  globalThis.window = {
    location: {
      hostname: 'escadronrogue.github.io',
      pathname: '/Basileus/index.html',
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  };
  globalThis.document = {
    querySelector: () => null,
  };

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    assert(!String(url).includes('/Basileus/api/personalities/exported'));
    assert(!String(url).includes('/api/personalities/exported'));

    if (String(url).includes('/contents/trained-personalities')) {
      return new Response(JSON.stringify([
        { type: 'file', name: 'alpha.json', download_url: 'https://raw.githubusercontent.test/alpha.json' },
        { type: 'file', name: 'manifest.json', download_url: 'https://raw.githubusercontent.test/manifest.json' },
        { type: 'dir', name: 'runs', download_url: null },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (String(url) === 'https://raw.githubusercontent.test/alpha.json') {
      return new Response(JSON.stringify(profile('alpha', 'Alpha')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };

  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  });

  const profiles = await listAvailableAiProfiles();
  assert.deepEqual(profiles.map(item => item.id), ['alpha']);
  assert.deepEqual(calls, [
    'https://api.github.com/repos/escadronrogue/Basileus/contents/trained-personalities?ref=main',
    'https://raw.githubusercontent.test/alpha.json',
  ]);
});

test('configured backend loads exported personalities through the API route', async (t) => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;

  globalThis.window = {
    BASILEUS_MULTIPLAYER_URL: 'https://basileus-backend.example/',
    location: {
      hostname: 'escadronrogue.github.io',
      pathname: '/Basileus/index.html',
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  };
  globalThis.document = {
    querySelector: () => null,
  };

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === 'https://basileus-backend.example/api/personalities/exported') {
      return new Response(JSON.stringify({ profiles: [profile('beta', 'Beta')] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  });

  const profiles = await listAvailableAiProfiles();
  assert.deepEqual(profiles.map(item => item.id), ['beta']);
  assert.equal(calls[0], 'https://basileus-backend.example/api/personalities/exported');
});
