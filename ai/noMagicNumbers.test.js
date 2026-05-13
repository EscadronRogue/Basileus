import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AI_NUM } from './numericConstants.js';

const AI_NUMERIC_FREE_FILES = [
  new URL('./brain.js', import.meta.url),
  new URL('./consequences.js', import.meta.url),
  new URL('./policyGenome.js', import.meta.url),
  new URL('./personalities.js', import.meta.url),
  new URL('../simulation/evolution.js', import.meta.url),
];

function collectRawNumericTokens(source) {
  const hits = [];
  const stack = [{ mode: 'normal', templateDepth: 0 }];
  const isIdentifier = (ch) => ch != null && /[A-Za-z0-9_$]/.test(ch);
  let index = 0;
  let line = 1;
  let column = 1;

  const top = () => stack[stack.length - 1];
  const advance = (ch) => {
    index++;
    if (ch === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  };

  while (index < source.length) {
    const mode = top().mode;
    const ch = source[index];
    const next = source[index + 1];

    if (mode === 'lineComment') {
      advance(ch);
      if (ch === '\n') stack.pop();
      continue;
    }
    if (mode === 'blockComment') {
      advance(ch);
      if (ch === '*' && next === '/') {
        advance(next);
        stack.pop();
      }
      continue;
    }
    if (mode === 'single' || mode === 'double') {
      advance(ch);
      if (ch === '\\') {
        advance(source[index] || '');
        continue;
      }
      if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"')) stack.pop();
      continue;
    }
    if (mode === 'templateText') {
      advance(ch);
      if (ch === '\\') {
        advance(source[index] || '');
        continue;
      }
      if (ch === '`') {
        stack.pop();
        continue;
      }
      if (ch === '$' && next === '{') {
        advance(next);
        stack.push({ mode: 'normal', templateDepth: 1 });
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      advance(ch);
      advance(next);
      stack.push({ mode: 'lineComment' });
      continue;
    }
    if (ch === '/' && next === '*') {
      advance(ch);
      advance(next);
      stack.push({ mode: 'blockComment' });
      continue;
    }
    if (ch === "'") {
      advance(ch);
      stack.push({ mode: 'single' });
      continue;
    }
    if (ch === '"') {
      advance(ch);
      stack.push({ mode: 'double' });
      continue;
    }
    if (ch === '`') {
      advance(ch);
      stack.push({ mode: 'templateText' });
      continue;
    }
    if (top().templateDepth) {
      if (ch === '{') top().templateDepth++;
      else if (ch === '}') {
        top().templateDepth--;
        advance(ch);
        if (top().templateDepth === 0) stack.pop();
        continue;
      }
    }

    const previous = index > 0 ? source[index - 1] : '';
    if ((/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next))) && !isIdentifier(previous)) {
      const match = source.slice(index).match(/^(?:\d+\.\d*|\d+|\.\d+)(?:e[+-]?\d+)?/i);
      if (match) {
        const token = match[0];
        const after = source[index + token.length];
        if (!isIdentifier(after) && after !== '.') {
          hits.push({ line, column, token });
          for (const tokenChar of token) advance(tokenChar);
          continue;
        }
      }
    }

    advance(ch);
  }

  return hits;
}

test('AI decision and training code has no raw numeric literals', () => {
  for (const fileUrl of AI_NUMERIC_FREE_FILES) {
    const source = readFileSync(fileUrl, 'utf8');
    const hits = collectRawNumericTokens(source);
    assert.deepEqual(hits, [], `${fileUrl.pathname} contains raw numeric literals`);
  }
});

test('all centralized AI numeric constants are defined', () => {
  for (const fileUrl of AI_NUMERIC_FREE_FILES) {
    const source = readFileSync(fileUrl, 'utf8');
    for (const match of source.matchAll(/AI_NUM\.(N_[A-Z0-9_]+)/g)) {
      assert.equal(Object.hasOwn(AI_NUM, match[1]), true, `${match[1]} is missing from AI_NUM`);
    }
  }
});
