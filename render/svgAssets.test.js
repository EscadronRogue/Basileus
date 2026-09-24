import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildSvgFallbackSource, SVG_FALLBACK_MODULE } from '../scripts/build-svg-fallback.js';

test('embedded SVG fallback matches assets/*.svg (run npm run build:svg-fallback)', () => {
  const committed = readFileSync(new URL(`../${SVG_FALLBACK_MODULE}`, import.meta.url), 'utf8');
  assert.ok(committed === buildSvgFallbackSource(), `${SVG_FALLBACK_MODULE} is stale`);
});

test('map renderer only loads the SVG fallback lazily', () => {
  const renderer = readFileSync(new URL('./mapRenderer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(renderer, /^import[^;]*svgAssets\.js/m, 'a static import ships ~650 KB to every player');
  assert.match(renderer, /import\('\.\/svgAssets\.js'\)/);
});
