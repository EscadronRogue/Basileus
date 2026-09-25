// scripts/playerText.js - pulls the text players can read out of the source.
//
// String and template literals are read from the player-facing files; HTML
// tags, ${...} expressions and strings that look like code (selectors, ids,
// class names) are dropped, so what is left is the words on screen.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Files and folders whose strings reach players.
export const PLAYER_TEXT_SOURCES = [
  'index.html',
  'main.js',
  'ui',
  'render',
  'game',
  'ai/personalities.js',
  'data/terms.js',
  'data/titles.js',
  'data/invasions.js',
  'data/provinces.js',
  'engine/actions.js',
  'engine/capitalSupport.js',
  'engine/combat.js',
  'engine/commands.js',
  'engine/deployment.js',
  'engine/estates.js',
  'engine/notifications.js',
  'engine/orders.js',
  'engine/presentation.js',
  'engine/rules.js',
  'engine/scoring.js',
  'engine/state.js',
  'engine/turnflow.js',
  'multiplayer/controller.js',
  'docs/rules.md',
];

function listFiles(root, path) {
  const full = join(root, path);
  if (!statSync(full, { throwIfNoEntry: false })) return [];
  if (statSync(full).isFile()) return [path];
  return readdirSync(full).flatMap((name) => listFiles(root, join(path, name)));
}

export function listPlayerTextFiles(root) {
  return PLAYER_TEXT_SOURCES
    .flatMap((path) => listFiles(root, path))
    .filter((path) => /\.(js|html|md)$/.test(path) && !/\.test\.js$/.test(path));
}

// Drops ${...} expressions, keeping the literal text around them.
function stripExpressions(text) {
  let out = '';
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (depth === 0 && text[index] === '$' && text[index + 1] === '{') {
      depth = 1;
      index += 1;
      out += ' ';
      continue;
    }
    if (depth > 0) {
      if (text[index] === '{') depth += 1;
      else if (text[index] === '}') depth -= 1;
      continue;
    }
    out += text[index];
  }
  return out;
}

// Every string and template literal in a JS source, with its line number.
function extractJsLiterals(source) {
  const literals = [];
  let line = 1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\n') {
      line += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      line += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += (source.slice(index, stop).match(/\n/g) || []).length;
      index = stop - 1;
      continue;
    }
    if (char !== '\'' && char !== '"' && char !== '`') continue;
    const quote = char;
    const startLine = line;
    let text = '';
    let depth = 0;
    index += 1;
    for (; index < source.length; index += 1) {
      const next = source[index];
      if (next === '\n') line += 1;
      if (next === '\\') {
        text += source[index + 1] || '';
        index += 1;
        continue;
      }
      if (quote === '`' && next === '$' && source[index + 1] === '{') depth += 1;
      else if (quote === '`' && depth > 0 && next === '}') depth -= 1;
      else if (depth === 0 && next === quote) break;
      text += next;
    }
    literals.push({ line: startLine, text });
  }
  return literals;
}

function looksLikeCode(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // A regex literal can throw the quote matching off; what follows is code.
  if (/=>|\bfunction\b|\);|===|\bconst\b|\breturn\b|\?\.|\|\||&&|\w+\.\w+\(/.test(trimmed)) return true;
  if (/^[\w./:#[\]=\-*>~+,()'"@]+$/.test(trimmed) && !/^[A-Z][a-z]/.test(trimmed)) return true;
  if (/^(\.|#|\[|:)/.test(trimmed)) return true;
  // A list of class names, or a call to a camelCase function.
  if (trimmed.split(/\s+/).every((token) => /^[a-z0-9]+(-[a-z0-9]+)+$/.test(token))) return true;
  if (/\b[a-z]\w*[A-Z]\w*\(/.test(trimmed)) return true;
  return false;
}

function visibleText(text) {
  return stripExpressions(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b[\w-]+="[^"]*"/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
}

// [{ file, line, text }] for every piece of player-readable text.
export function collectPlayerText(root) {
  const entries = [];
  for (const file of listPlayerTextFiles(root)) {
    const source = readFileSync(join(root, file), 'utf8');
    if (/\.md$/.test(file)) {
      source.split('\n').forEach((text, index) => entries.push({ file, line: index + 1, text }));
      continue;
    }
    if (/\.html$/.test(file)) {
      const body = source.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
      body.split('\n').forEach((text, index) => {
        const attributes = [...text.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map((match) => match[1]);
        entries.push({ file, line: index + 1, text: `${visibleText(text)} ${attributes.join(' ')}` });
      });
      continue;
    }
    for (const literal of extractJsLiterals(source)) {
      const attributes = [...literal.text.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"$]*)"/g)].map((match) => match[1]);
      const text = `${visibleText(literal.text)} ${attributes.join(' ')}`;
      if (looksLikeCode(text)) continue;
      entries.push({ file, line: literal.line, text });
    }
  }
  return entries;
}

export function relativeTo(root, path) {
  return relative(root, path);
}
