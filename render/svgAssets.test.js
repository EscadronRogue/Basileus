import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { buildSvgFallbackSource, SVG_FALLBACK_MODULE } from '../scripts/build-svg-fallback.js';

test('embedded SVG fallback matches assets/*.svg (run npm run build:svg-fallback)', () => {
  const committed = readFileSync(new URL(`../${SVG_FALLBACK_MODULE}`, import.meta.url), 'utf8');
  assert.ok(committed === buildSvgFallbackSource(), `${SVG_FALLBACK_MODULE} is stale`);
});

test('map renderer only loads the SVG fallback lazily', () => {
  const renderDir = new URL('./', import.meta.url);
  const sources = ['mapRenderer.js', ...readdirSync(new URL('./map/', renderDir)).map((name) => `map/${name}`)]
    .map((path) => readFileSync(new URL(path, renderDir), 'utf8'));
  for (const source of sources) {
    assert.doesNotMatch(source, /^import[^;]*svgAssets\.js/m, 'a static import ships ~650 KB to every player');
  }
  const loader = readFileSync(new URL('./map/svgImport.js', renderDir), 'utf8');
  assert.match(loader, /import\('\.\.\/svgAssets\.js'\)/);
});
