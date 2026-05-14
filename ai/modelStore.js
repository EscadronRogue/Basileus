import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserializeNetwork, serializeNetwork } from './network.js';

const AI_DIR = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_MODEL_PATH = resolve(AI_DIR, 'models', 'latest.json');
export const DEFAULT_CHECKPOINT_DIR = resolve(AI_DIR, 'checkpoints');

export function loadModelFileSync(path = DEFAULT_MODEL_PATH) {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return deserializeNetwork(raw.network || raw);
}

export function saveModelFileSync(network, path = DEFAULT_MODEL_PATH, metadata = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    schema: 'basileus-neural-model',
    version: 1,
    savedAt: new Date().toISOString(),
    metadata,
    network: serializeNetwork(network),
  };
  writeFileSync(path, `${JSON.stringify(payload)}\n`, 'utf8');
  return path;
}

export function loadModelPayloadSync(path = DEFAULT_MODEL_PATH) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}
