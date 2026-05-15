import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hydrateLearningPolicy,
  serializeLearningPolicy,
} from './policy.js';

const AI_DIR = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_POLICY_PATH = resolve(AI_DIR, 'policies', 'latest.json');
export const DEFAULT_CHECKPOINT_DIR = resolve(AI_DIR, 'policy-checkpoints');

export function loadPolicyPayloadSync(path = DEFAULT_POLICY_PATH) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadPolicyFileSync(path = DEFAULT_POLICY_PATH) {
  const payload = loadPolicyPayloadSync(path);
  if (!payload) return null;
  return hydrateLearningPolicy(payload.policy || payload);
}

export function savePolicyFileSync(policy, path = DEFAULT_POLICY_PATH, metadata = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    schema: 'basileus-ai-policy-file.v1',
    version: 1,
    savedAt: new Date().toISOString(),
    metadata,
    policy: serializeLearningPolicy(policy),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}
