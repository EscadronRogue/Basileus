import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { listExportedPersonalityFiles } from './personality-files.js';

const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const DEFAULT_BATCH_SIZE = 3000;
const NAME_QUERY_TIMEOUT_MS = 8_000;
const MAX_FETCH_ATTEMPTS = 2;

const EMERGENCY_GREEK_NAMES = [
  'Alexandros', 'Dimitrios', 'Nikolaos', 'Georgios', 'Konstantinos', 'Ioannis',
  'Theodoros', 'Panagiotis', 'Anastasios', 'Christos', 'Vasileios', 'Spyridon',
  'Antonios', 'Charilaos', 'Evangelos', 'Fotios', 'Leonidas', 'Miltiadis',
  'Periklis', 'Sotirios', 'Athanasios', 'Stylianos', 'Achilleas', 'Aikaterini',
  'Eleni', 'Sofia', 'Maria', 'Kalliopi', 'Nefeli', 'Ifigeneia', 'Daphne',
  'Dimitra', 'Theodora', 'Anastasia', 'Kleoniki', 'Olympia', 'Ourania',
  'Chrysanthi', 'Evdokia', 'Irene', 'Xenia', 'Antigoni', 'Artemis', 'Calliope',
  'Phoebe', 'Penelope', 'Ariadne', 'Danae', 'Melina', 'Thalia'
];

function normalizeNameKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, '');
}

function cleanGreekName(value) {
  const name = String(value || '')
    .normalize('NFC')
    .replace(/[\u200E\u200F]/g, '')
    .trim();
  if (name.length < 3 || name.length > 28) return null;
  if (!/\p{Script=Latin}/u.test(name)) return null;
  if (!/^[\p{L}][\p{L}'’.-]*$/u.test(name)) return null;
  if (/\d|_|\/|\(|\)|,|:|;|\s/u.test(name)) return null;
  return name;
}

export function slugifyGreekName(value, fallback = 'greek-name') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function buildWikidataGreekGivenNameQuery(seed, limit) {
  const salt = String(seed || Date.now()).replace(/["\\]/g, '');
  return `
SELECT DISTINCT ?name WHERE {
  ?item wdt:P31/wdt:P279* wd:Q202444;
        wdt:P407 wd:Q9129.
  ?item rdfs:label ?name.
  FILTER(LANG(?name) = "en")
  FILTER(STRLEN(STR(?name)) >= 3 && STRLEN(STR(?name)) <= 28)
}
ORDER BY MD5(CONCAT(STR(?item), "${salt}"))
LIMIT ${Math.max(1, Math.min(Number(limit) || DEFAULT_BATCH_SIZE, 5000))}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGreekNamesFromWikidata(seed, limit = DEFAULT_BATCH_SIZE) {
  if (process?.env?.BASILEUS_OFFLINE_GREEK_NAMES === '1') return [];
  if (typeof fetch !== 'function') return [];
  const body = new URLSearchParams({
    query: buildWikidataGreekGivenNameQuery(seed, limit),
    format: 'json',
  });
  const response = await fetchWithTimeout(WIKIDATA_SPARQL_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/sparql-results+json',
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'user-agent': 'BasileusAITrainer/0.1 (Greek-name champion export)',
    },
    body,
  }, NAME_QUERY_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Wikidata Greek-name query failed with HTTP ${response.status}.`);
  }
  const payload = await response.json();
  return (payload?.results?.bindings || [])
    .map((binding) => cleanGreekName(binding?.name?.value))
    .filter(Boolean);
}

async function readUsedNamesFromExports(exportRoot) {
  const root = resolve(exportRoot || 'trained-personalities');
  const used = new Set();
  const files = await listExportedPersonalityFiles(root, { includeRuns: true });

  for (const file of files) {
    const fileName = basename(file, '.json');
    const fileNameKey = normalizeNameKey(fileName);
    if (fileNameKey) used.add(fileNameKey);
    try {
      const payload = JSON.parse(await readFile(file, 'utf8'));
      const profileNameKey = normalizeNameKey(payload?.name);
      const shortNameKey = normalizeNameKey(payload?.shortName);
      if (profileNameKey) used.add(profileNameKey);
      if (shortNameKey) used.add(shortNameKey);
    } catch {
      // Ignore invalid JSON when building the anti-duplication set.
    }
  }

  return used;
}

function pushUniqueNames(target, incoming, used) {
  for (const rawName of incoming) {
    const name = cleanGreekName(rawName);
    const key = normalizeNameKey(name);
    if (!name || !key || used.has(key) || target.some((entry) => normalizeNameKey(entry) === key)) continue;
    target.push(name);
  }
}

async function buildGreekNamePool({ count, seed, usedNames }) {
  const names = [];
  let lastError = null;

  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS && names.length < count; attempt += 1) {
    try {
      const batch = await fetchGreekNamesFromWikidata(`${seed}:${attempt}:${Date.now()}`, DEFAULT_BATCH_SIZE);
      pushUniqueNames(names, batch, usedNames);
    } catch (error) {
      lastError = error;
    }
  }

  if (names.length < count) {
    pushUniqueNames(names, EMERGENCY_GREEK_NAMES, usedNames);
  }

  if (names.length < count) {
    const reason = lastError?.message ? ` ${lastError.message}` : '';
    throw new Error(`Could not allocate ${count} unused Greek first name${count === 1 ? '' : 's'}.${reason}`);
  }

  return names;
}

export async function assignGreekNamesToChampions(champions, options = {}) {
  const profiles = Array.isArray(champions) ? champions : [];
  if (!profiles.length) return [];

  const exportRoot = options.exportRoot || join(process.cwd(), 'trained-personalities');
  const usedNames = await readUsedNamesFromExports(exportRoot);
  const namePool = await buildGreekNamePool({
    count: profiles.length,
    seed: options.seed || Date.now(),
    usedNames,
  });

  return profiles.map((profile, index) => {
    const greekName = namePool[index];
    const key = normalizeNameKey(greekName);
    usedNames.add(key);
    return {
      ...profile,
      id: slugifyGreekName(greekName, `greek-ai-${index + 1}`),
      name: greekName,
      shortName: greekName,
    };
  });
}
