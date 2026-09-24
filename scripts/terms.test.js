// scripts/terms.test.js - retired words stay out of what players read.
//
// data/terms.js names every concept once. These are the words the game used
// to use for the same things (or for mechanics that no longer exist); any of
// them in player-facing text means two names for one idea again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { collectPlayerText } from './playerText.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// [pattern, the word to use instead]
const RETIRED_WORDS = [
  [/\boccup(y|ied|ies|ation|ying)\b/i, 'lost (a province held by invaders) or imperial'],
  [/\bcourt\b/i, 'the Offices phase'],
  [/\bTitle Redistribution\b/i, 'the new Basileus hands out the major offices'],
  [/\b(major|minor) titles?\b/i, 'major office / minor office'],
  [/\branking\b/i, 'coup choices'],
  [/\bpassive (capital )?support\b/i, 'Theodosian Walls, Patriarch\'s influence, Triumph, Unrest'],
  [/\bcapital (support|troops)\b/i, 'support / troops in Constantinople'],
  [/\b(un)?funded\b|\bfunding\b/i, 'fielded / dismissed'],
  [/\bstayed home\b|\bkept home\b/i, 'dismissed'],
  [/\bsealed bids?\b|\bbid(s|ding)?\b/i, 'estates are planned and built, not bid for'],
  [/\bfree[- ]citizens?\b/i, 'imperial province'],
  [/\bthemes?\b/i, 'province'],
  [/\bseats?\b/i, 'dynasty, office or player'],
  [/\bplanner\b|\btrained\b/i, 'AI opponent / temperament'],
  [/\bChurch Yield\b|\bProfit Income\b|\bGold Reserves\b/i, 'gold, estate income, office income'],
  [/\bPhase Panel\b/i, 'the phase name'],
  [/\bKonstantinopolis\b/, 'Constantinople'],
  [/\bturns?\b/i, 'round'],
];

test('player-facing text uses the current vocabulary', () => {
  const problems = [];
  for (const entry of collectPlayerText(ROOT)) {
    for (const [pattern, instead] of RETIRED_WORDS) {
      if (!pattern.test(entry.text)) continue;
      problems.push(`${entry.file}:${entry.line} "${entry.text.trim().replace(/\s+/g, ' ').slice(0, 120)}" -> use ${instead}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the checker reads text out of code and ignores identifiers', () => {
  const entries = collectPlayerText(ROOT);
  assert.ok(entries.some((entry) => /Theodosian Walls/.test(entry.text)), 'finds rules text');
  assert.ok(!entries.some((entry) => /^\s*court\s*$/.test(entry.text)), 'skips bare identifiers such as phase ids');
});
