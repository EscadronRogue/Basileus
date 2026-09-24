import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RULES_DOC_PATH } from './build-rules-doc.js';
import { PHASE_GUIDES, RULE_SECTIONS, renderRulesHtml, renderRulesMarkdown } from '../ui/rules.js';

const root = new URL('../', import.meta.url);

test('docs/rules.md matches ui/rules.js (run npm run build:rules-doc)', () => {
  assert.ok(readFileSync(new URL(RULES_DOC_PATH, root), 'utf8') === renderRulesMarkdown(), `${RULES_DOC_PATH} is stale`);
});

test('rules HTML renders every section and escapes text', () => {
  const html = renderRulesHtml();
  for (const section of RULE_SECTIONS) assert.ok(html.includes(`<h3>${section.title.replace('&', '&amp;')}</h3>`), section.title);
  assert.doesNotMatch(html, /\*\*/, 'bold markers are converted');
});

test('the in-game page and README point at the single rules source', () => {
  const index = readFileSync(new URL('index.html', root), 'utf8');
  assert.match(index, /id="rulesCardBody"/);
  assert.doesNotMatch(index, /<h3>Coup &amp; War<\/h3>/, 'rules text is rendered from ui/rules.js, not duplicated in index.html');
  assert.match(readFileSync(new URL('README.md', root), 'utf8'), /docs\/rules\.md/);
});

test('every interactive phase has a guide', () => {
  for (const phase of ['title_redistribution', 'court', 'estates', 'deployment', 'resolution']) {
    assert.ok(PHASE_GUIDES[phase]?.steps?.length >= 2, phase);
  }
});
