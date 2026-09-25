import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RULES_DOC_PATH } from './build-rules-doc.js';
import { MAP_VALUE_LABELS, RULE_SECTIONS, renderGlossaryHtml, renderRulesHtml, renderRulesMarkdown } from '../ui/rules.js';
import { BALANCE, MAP_BALANCE } from '../data/balance.js';
import { GLOSSARY_TERMS, findGlossaryMatches, getGlossaryTerm, setGlossaryMap } from '../ui/glossary.js';

const root = new URL('../', import.meta.url);

test('docs/rules.md matches ui/rules.js (run npm run build:rules-doc)', () => {
  assert.ok(readFileSync(new URL(RULES_DOC_PATH, root), 'utf8') === renderRulesMarkdown(), `${RULES_DOC_PATH} is stale`);
});

test('rules HTML renders every section and escapes text', () => {
  const html = renderRulesHtml();
  for (const section of RULE_SECTIONS) assert.ok(html.includes(`<h3>${section.title.replace('&', '&amp;')}</h3>`), section.title);
  assert.doesNotMatch(html, /\*\*/, 'bold markers are converted');
});

test('the Maps section names every value a map changes', () => {
  for (const [mapId, overlay] of Object.entries(MAP_BALANCE)) {
    for (const key of Object.keys(overlay)) assert.ok(MAP_VALUE_LABELS[key], `${mapId}.${key} has a label in ui/rules.js`);
  }
});

test('glossary numbers follow the map of the game on screen', () => {
  const walls = () => getGlossaryTerm('theodosian-walls').definition;
  assert.match(walls(), new RegExp(`: ${BALANCE.THEODOSIAN_WALLS} support`));
  setGlossaryMap('compact');
  try {
    assert.match(walls(), new RegExp(`: ${MAP_BALANCE.compact.THEODOSIAN_WALLS} support`));
  } finally {
    setGlossaryMap(null);
  }
  assert.match(walls(), new RegExp(`: ${BALANCE.THEODOSIAN_WALLS} support`));
});

test('the in-game page and README point at the single rules source', () => {
  const index = readFileSync(new URL('index.html', root), 'utf8');
  assert.match(index, /id="rulesCardBody"/);
  assert.doesNotMatch(index, /<h3>Coup &amp; War<\/h3>/, 'rules text is rendered from ui/rules.js, not duplicated in index.html');
  assert.match(readFileSync(new URL('README.md', root), 'utf8'), /docs\/rules\.md/);
});

test('the glossary lists every key word and finds them in running text', () => {
  const html = renderGlossaryHtml();
  for (const entry of GLOSSARY_TERMS) {
    // AI temperaments are explained on the AI's name, not in the rules.
    assert.equal(html.includes(`<dt>${entry.term}</dt>`), !entry.hiddenFromIndex, entry.term);
  }
  const ids = new Set(GLOSSARY_TERMS.map((entry) => entry.id));
  assert.equal(ids.size, GLOSSARY_TERMS.length, 'term ids are unique');

  const matches = findGlossaryMatches('The Domestic of the East appoints a strategos; troops in Constantinople ignore the Frontier.');
  assert.deepEqual(matches.map((match) => [match.id, match.text]), [
    ['domestic', 'Domestic of the East'],
    ['appointment', 'appoints'],
    ['strategos', 'strategos'],
    ['troop', 'troops'],
    ['capital', 'Constantinople'],
    ['frontier', 'Frontier'],
  ]);
  // The phase name only matches with its capital letter.
  assert.deepEqual(findGlossaryMatches('your offices').map((match) => match.id), []);
  assert.deepEqual(findGlossaryMatches('the Offices phase').map((match) => match.id), ['offices']);
  // Personality names only match with their capital letter.
  assert.deepEqual(findGlossaryMatches('a patron of the arts').map((match) => match.id), []);
  assert.deepEqual(findGlossaryMatches('Leo the Patron').map((match) => match.id), ['personality-patron']);
  // A tooltip does not mark the word it explains.
  assert.deepEqual(findGlossaryMatches('the Basileus', { skipIds: new Set(['basileus']) }), []);
});
