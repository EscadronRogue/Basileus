import { installNodeWorkerShim } from './node-worker-shim.js';
import { runEvolutionTraining, DEFAULT_TRAINING_CONFIG, estimateTrainingMatches } from './evolution.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { assignGreekNamesToChampions, slugifyGreekName } from './greek-name-service.js';
import { join, resolve } from 'node:path';
import { availableParallelism } from 'node:os';

function parseValue(value) {
  if (typeof value === 'string' && value.includes(',')) {
    return value.split(',').map(part => parseValue(part.trim())).filter(part => part !== '');
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
  return value;
}

function parseArgs(argv) {
  const config = { ...DEFAULT_TRAINING_CONFIG };
  let output = 'training-result.json';
  let exportDir = 'trained-personalities';
  let progressEvery = 1;
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [rawKey, rawValue = 'true'] = arg.slice(2).split('=');
    const key = rawKey.trim();
    const value = parseValue(rawValue.trim());
    if (key === 'out' || key === 'output') output = String(value);
    else if (key === 'exportDir' || key === 'personalitiesDir') exportDir = String(value || 'trained-personalities');
    else if (key === 'progressEvery') progressEvery = Math.max(1, Number(value) || 1);
    else if (key === 'parallelWorkers' && value === 'auto') config.parallelWorkers = Math.max(1, Math.min(availableParallelism() - 1, 8));
    else if (key in config) config[key] = value;
    else if (key.startsWith('fitness.')) {
      config.fitness = { ...(config.fitness || {}) };
      config.fitness[key.slice('fitness.'.length)] = value;
      config.fitnessPresetId = 'custom';
    }
  }
  return { config, output, exportDir, progressEvery };
}

function formatMs(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function slugifyFileName(value, fallback = 'personality') {
  return slugifyGreekName(value, fallback);
}

function buildRunId(result) {
  const generatedAt = result?.generatedAt ? new Date(result.generatedAt) : new Date();
  const timestamp = Number.isNaN(generatedAt.getTime())
    ? new Date().toISOString()
    : generatedAt.toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/g, '-');
  const seed = slugifyFileName(result?.config?.seed || 'seed', 'seed');
  const generations = Number(result?.config?.generations || 0);
  const population = Number(result?.config?.populationSize || 0);
  return `${safeTimestamp}_seed-${seed}_g${generations}_p${population}`;
}

async function writeJsonFile(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function exportChampionPersonalities(result, exportDir = 'trained-personalities') {
  const champions = Array.isArray(result?.champions) ? result.champions : [];
  const exportRoot = resolve(process.cwd(), exportDir || 'trained-personalities');
  const runDir = join(exportRoot, 'runs', buildRunId(result));

  await mkdir(exportRoot, { recursive: true });
  await mkdir(runDir, { recursive: true });

  const files = [];
  for (const [index, profile] of champions.entries()) {
    const rank = index + 1;
    const name = profile.name || `Champion ${rank}`;
    const filename = `${slugifyFileName(name, `champion-${rank}`)}.json`;
    const activeFile = join(exportRoot, filename);
    const runFile = join(runDir, filename);

    await writeJsonFile(activeFile, profile);
    await writeJsonFile(runFile, profile);
    files.push({
      rank,
      id: profile.id || null,
      name,
      file: filename,
      activeFile,
      runFile,
    });
  }

  return {
    exportRoot,
    runDir,
    files,
  };
}

async function main() {
  installNodeWorkerShim();
  const { config, output, exportDir, progressEvery } = parseArgs(process.argv.slice(2));
  const totalMatches = estimateTrainingMatches(config);
  const startedAt = Date.now();
  let lastPrinted = 0;

  console.log(JSON.stringify({
    event: 'start',
    totalMatches,
    config,
    availableParallelism: availableParallelism(),
  }));

  const result = await runEvolutionTraining(config, (progress) => {
    const now = Date.now();
    const completed = Number(progress.completed) || 0;
    const percent = progress.total ? Math.round((completed / progress.total) * 1000) / 10 : 0;
    if (completed - lastPrinted < progressEvery && completed < progress.total) return;
    lastPrinted = completed;
    console.log(JSON.stringify({
      event: 'progress',
      generation: progress.generation,
      stage: progress.stage,
      completed,
      total: progress.total,
      percent,
      leaderName: progress.leaderName,
      leaderFitness: progress.leaderFitness,
      elapsed: formatMs(now - startedAt),
    }));
  });

  const exportRoot = resolve(process.cwd(), exportDir || 'trained-personalities');
  result.champions = await assignGreekNamesToChampions(result.champions, {
    exportRoot,
    seed: result?.config?.seed,
  });
  const personalityExport = await exportChampionPersonalities(result, exportDir);
  result.personalityExport = personalityExport;

  const outputPath = resolve(process.cwd(), output);
  await writeJsonFile(outputPath, result);
  console.log(JSON.stringify({
    event: 'personalities-exported',
    exportRoot: personalityExport.exportRoot,
    runDir: personalityExport.runDir,
    files: personalityExport.files.length,
  }));
  console.log(JSON.stringify({
    event: 'done',
    runtimeMs: result.runtimeMs,
    runtime: formatMs(result.runtimeMs),
    output: outputPath,
    personalityExport,
    bestChampion: result.champions?.[0]?.name || null,
    bestHoldoutWinShare: result.overview?.bestHoldoutWinShare ?? null,
  }));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
