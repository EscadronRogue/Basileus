import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hydrateLearningPolicy,
  serializeLearningPolicy,
} from './policy.js';
import { slugifyGreekFirstName } from './greekNames.js';

const AI_DIR = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_OPPONENT_DIR = resolve(AI_DIR, 'opponents');
export const DEFAULT_POLICY_PATH = resolve(DEFAULT_OPPONENT_DIR, 'latest.json');
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
  const serialized = serializeLearningPolicy(policy);
  const payload = {
    schema: 'basileus-ai-policy-file.v1',
    version: 1,
    savedAt: new Date().toISOString(),
    metadata,
    identity: serialized.identity,
    policy: serialized,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}

export function policyFirstName(policyOrPayload, fallback = 'AI') {
  const raw = policyOrPayload?.policy || policyOrPayload || {};
  return String(raw.identity?.firstName || raw.identity?.name || raw.name || fallback).trim() || fallback;
}

export function listOpponentPolicyFilesSync(dir = DEFAULT_OPPONENT_DIR) {
  const resolved = resolve(dir);
  if (!existsSync(resolved)) return [];
  return readdirSync(resolved)
    .filter((name) => extname(name).toLowerCase() === '.json')
    .map((name) => resolve(resolved, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => basename(left).localeCompare(basename(right)));
}

export function opponentIdFromPath(path) {
  return basename(path, extname(path));
}

export function loadOpponentRosterSync(dir = DEFAULT_OPPONENT_DIR) {
  return listOpponentPolicyFilesSync(dir)
    .map((path) => {
      try {
        const payload = loadPolicyPayloadSync(path);
        const policy = hydrateLearningPolicy(payload?.policy || payload);
        if (!policy) return null;
        const id = opponentIdFromPath(path);
        return {
          id,
          firstName: policyFirstName(policy, id),
          fileName: basename(path),
          path,
          url: `ai/opponents/${encodeURIComponent(basename(path))}`,
          step: policy.step || 0,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function loadOpponentPolicyByIdSync(id, dir = DEFAULT_OPPONENT_DIR) {
  const safeId = basename(String(id || ''), '.json');
  const match = listOpponentPolicyFilesSync(dir)
    .find((path) => opponentIdFromPath(path) === safeId);
  return match ? loadPolicyFileSync(match) : null;
}

export function uniqueOpponentPolicyPathSync(policy, dir = DEFAULT_OPPONENT_DIR) {
  const firstName = policyFirstName(policy, 'ai');
  const base = slugifyGreekFirstName(firstName);
  let candidate = resolve(dir, `${base}.json`);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = resolve(dir, `${base}-${suffix}.json`);
    suffix += 1;
  }
  return candidate;
}
