import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HUMAN_FEEDBACK_SCHEMA,
  humanFeedbackSamplesToTransitions,
} from './humanFeedback.js';

const AI_DIR = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_HUMAN_GAMES_DIR = resolve(AI_DIR, 'human-games');

function isJsonFile(path) {
  return extname(path).toLowerCase() === '.json';
}

function listHumanFeedbackFiles(path) {
  const resolved = resolve(path || '');
  if (!existsSync(resolved)) {
    return [];
  }
  const stats = statSync(resolved);
  if (stats.isFile()) return isJsonFile(resolved) ? [resolved] : [];
  if (!stats.isDirectory()) return [];

  const files = [];
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    const fullPath = join(resolved, entry.name);
    if (entry.isDirectory()) {
      files.push(...listHumanFeedbackFiles(fullPath));
    } else if (entry.isFile() && isJsonFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

export function loadHumanFeedbackPayloadSync(path) {
  const resolved = resolve(path || '');
  if (!existsSync(resolved)) {
    throw new Error(`Human feedback file not found: ${resolved}`);
  }
  const payload = JSON.parse(readFileSync(resolved, 'utf8'));
  if (Array.isArray(payload)) {
    return {
      schema: HUMAN_FEEDBACK_SCHEMA,
      version: 1,
      samples: payload,
    };
  }
  if (payload?.schema !== HUMAN_FEEDBACK_SCHEMA && !Array.isArray(payload?.samples)) {
    throw new Error(`Human feedback file must use schema ${HUMAN_FEEDBACK_SCHEMA}.`);
  }
  return payload;
}

export function loadHumanFeedbackDatasetSync(paths = DEFAULT_HUMAN_GAMES_DIR, options = {}) {
  const pathList = Array.isArray(paths) ? paths : [paths];
  const files = pathList.flatMap((path) => listHumanFeedbackFiles(path));
  if (!files.length) {
    if (options.required) {
      throw new Error(`No human feedback JSON files found in ${pathList.map((path) => resolve(path)).join(', ')}.`);
    }
    return {
      files: [],
      payloads: [],
      samples: [],
      transitions: [],
    };
  }

  const payloads = files.map((file) => ({
    file,
    payload: loadHumanFeedbackPayloadSync(file),
  }));
  const samples = payloads.flatMap((entry) => entry.payload.samples || []);
  return {
    files,
    payloads,
    samples,
    transitions: humanFeedbackSamplesToTransitions(samples, options),
  };
}

export function loadHumanFeedbackTransitionsSync(path, options = {}) {
  return loadHumanFeedbackDatasetSync(path, { ...options, required: true }).transitions;
}
