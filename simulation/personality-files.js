import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { normalizeAiProfile } from '../ai/profileStore.js';

const EXCLUDED_JSON_FILES = new Set([
  'manifest.json',
  'latest-manifest.json',
  'package.json',
]);

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'latest',
]);

function isProfileJsonFile(fileName) {
  const lower = String(fileName || '').toLowerCase();
  return lower.endsWith('.json') && !EXCLUDED_JSON_FILES.has(lower);
}

function shouldSkipDirectory(dirName, includeRuns = false) {
  if (EXCLUDED_DIRS.has(dirName)) return true;
  if (includeRuns) return false;
  return true;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walkJsonFiles(rootDir, options = {}, currentDir = rootDir, output = []) {
  const includeRuns = Boolean(options.includeRuns);
  let entries = [];
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    const path = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (includeRuns && !shouldSkipDirectory(entry.name, includeRuns)) {
        await walkJsonFiles(rootDir, options, path, output);
      }
      continue;
    }
    if (entry.isFile() && isProfileJsonFile(entry.name)) {
      output.push(path);
    }
  }

  return output;
}

export async function listExportedPersonalityFiles(exportRoot, options = {}) {
  if (!exportRoot || !(await pathExists(exportRoot))) return [];
  const files = await walkJsonFiles(exportRoot, options);
  return files.sort((left, right) => left.localeCompare(right));
}

export async function readExportedPersonalitiesFromFolder(exportRoot, options = {}) {
  const files = await listExportedPersonalityFiles(exportRoot, options);
  const profiles = [];
  const seen = new Set();

  for (const filePath of files) {
    try {
      const rawProfile = JSON.parse(await readFile(filePath, 'utf8'));
      const profile = normalizeAiProfile(rawProfile);
      if (!profile || seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push({
        ...profile,
        librarySource: 'exported',
        file: relative(exportRoot, filePath).replace(/\\/g, '/'),
      });
    } catch {
      // Ignore invalid JSON or non-profile files so users can stage files in the
      // folder without breaking the roster.
    }
  }

  return profiles;
}
