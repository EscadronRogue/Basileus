import test from 'node:test';
import assert from 'node:assert/strict';

import { createGameState } from '../engine/state.js';
import {
  buildProvinceRulesFacts,
  getRulesSections,
  RULES_SECTION_IDS,
} from './rulesContent.js';

function getSection(sections, id) {
  return sections.find((section) => section.id === id);
}

function getFactMap(sectionOrProvince) {
  return Object.fromEntries((sectionOrProvince?.facts || []).map((fact) => [fact.label, fact.value]));
}

test('rules content exposes the key formulas and exact coup rule', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const sections = getRulesSections(state);

  const scoringFacts = getFactMap(getSection(sections, RULES_SECTION_IDS.SCORING));
  const estateFacts = getFactMap(getSection(sections, RULES_SECTION_IDS.ESTATES));
  const armyFacts = getFactMap(getSection(sections, RULES_SECTION_IDS.ARMIES));
  const outputFacts = getFactMap(getSection(sections, RULES_SECTION_IDS.PROFIT_TAX_LEVIES));
  const coupFacts = getFactMap(getSection(sections, RULES_SECTION_IDS.COUPS));

  assert.equal(scoringFacts['Final score'], 'Gold on hand + next Administration income.');
  assert.equal(estateFacts['Buy estate'], 'Land price = 2 x Profit. The buyer becomes the estate owner.');
  assert.equal(estateFacts['Tax exemption'], 'Tax exemption price = 2 x Tax. The estate owner pays the Basileus immediately. During Administration, that estate owner keeps the province tax and the province pays no tax that round.');
  assert.match(armyFacts.Mercenaries, /1 gold, then 2 gold, then 3 gold/);
  assert.match(outputFacts['Court-title levies'], /exactly 2 capital-only levies/);
  assert.equal(coupFacts['Who wins'], 'The claimant with the highest capital troop total wins. The current Basileus wins all ties.');
});

test('province rules facts explain private estate routing', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const playerId = state.players[0].id;
  const theme = Object.values(state.themes).find((entry) => entry.id !== 'CPL' && !entry.occupied);
  theme.owner = playerId;

  const facts = getFactMap(buildProvinceRulesFacts(state, theme.id));

  assert.match(facts['Owner receives'], /during Administration from province profit/);
  assert.match(facts['Tax goes to'], /regional tax pool/);
  assert.match(facts['Levies go to'], /regional levy pool/);
});

test('province rules facts explain tax exempt routing', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const playerId = state.players[0].id;
  const theme = Object.values(state.themes).find((entry) => entry.id !== 'CPL' && !entry.occupied);
  theme.owner = playerId;
  theme.taxExempt = true;

  const facts = getFactMap(buildProvinceRulesFacts(state, theme.id));

  assert.match(facts['Tax goes to'], /estate owner keeps the tax this round/);
  assert.match(facts['Tax exempt effect'], /Active now/);
});

test('province rules facts explain strategos routing', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const playerId = state.players[0].id;
  const theme = Object.values(state.themes).find((entry) => entry.id !== 'CPL' && !entry.occupied);
  theme.owner = playerId;
  theme.strategos = state.players[1].id;

  const facts = getFactMap(buildProvinceRulesFacts(state, theme.id));

  assert.match(facts['Tax goes to'], /receives .* directly during Administration/);
  assert.match(facts['Levies go to'], /receives .* directly during Administration/);
});

test('province rules facts explain church routing', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const theme = Object.values(state.themes).find((entry) => entry.id !== 'CPL' && !entry.occupied);
  theme.owner = 'church';

  const facts = getFactMap(buildProvinceRulesFacts(state, theme.id));

  assert.match(facts['Tax goes to'], /church pool/);
  assert.match(facts['Levies go to'], /regional levy pool/);
  assert.match(facts['Church-owned effect'], /Active now/);
});

test('province rules facts explain occupied routing', () => {
  const state = createGameState({ playerCount: 4, deckSize: 1, seed: 7 });
  const theme = Object.values(state.themes).find((entry) => entry.id !== 'CPL');
  theme.occupied = true;

  const facts = getFactMap(buildProvinceRulesFacts(state, theme.id));

  assert.equal(facts['Owner receives'], 'No profit while occupied.');
  assert.equal(facts['Tax goes to'], 'No tax while occupied.');
  assert.equal(facts['Levies go to'], 'No levies while occupied.');
  assert.match(facts['Occupied effect'], /Active now/);
});
