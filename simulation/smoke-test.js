import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const BASE_SMOKE_CASE = {
  playerCount: 4,
  deckSize: 1,
  seed: 123,
  strictTimeoutMs: 5000,
  maxLoopIterations: 128,
  maxRounds: 8,
};

const WORKER_TIMEOUT_MS = 5000;

function runOneSmokeCase(caseConfig, timeoutMs = WORKER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./smoke-test.worker.js', import.meta.url), {
      workerData: { caseConfig },
    });
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Smoke test timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);

    worker.once('message', (message) => {
      finish(() => {
        if (message?.ok) resolve(message.result);
        else reject(new Error(message?.error || 'Smoke-test worker failed.'));
      });
    });

    worker.once('error', (error) => {
      finish(() => reject(error));
    });

    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(`Smoke-test worker exited with code ${code}.`)));
      }
    });
  });
}

function assertDeterministic(first, second) {
  const firstJson = JSON.stringify(first);
  const secondJson = JSON.stringify(second);
  if (firstJson !== secondJson) {
    throw new Error(`Smoke test is not deterministic.\nFirst: ${firstJson}\nSecond: ${secondJson}`);
  }
}

function assertHealthy(snapshot) {
  if (snapshot.guardTriggered) {
    throw new Error(`Simulation guard triggered during smoke test: ${snapshot.guardReason || 'unknown reason'}.`);
  }
  if (snapshot.roundsPlayed < 1) {
    throw new Error('Smoke test produced an invalid round count.');
  }
}

async function loadSmokeProfiles() {
  const manifestPaths = [
    join(projectRoot, 'trained-personalities', 'latest', 'latest-manifest.json'),
    join(projectRoot, 'trained-personalities', 'latest', 'manifest.json'),
    join(projectRoot, 'trained-personalities', 'definitive', 'manifest.json'),
  ];

  for (const manifestPath of manifestPaths) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!Array.isArray(manifest.files) || !manifest.files.length) continue;
      const manifestDir = dirname(manifestPath);
      const baseDir = manifestPath.endsWith(join('latest', 'latest-manifest.json')) && manifest.runId
        ? join(manifestDir, manifest.runId)
        : manifestDir;
      const fileNames = manifest.files
        .map((entry) => entry?.file)
        .filter(Boolean)
        .slice(0, 4);
      if (!fileNames.length) continue;
      return Promise.all(
        fileNames.map(async (fileName) => JSON.parse(await readFile(join(baseDir, fileName), 'utf8')))
      );
    } catch {
      // Try the next manifest path.
    }
  }

  throw new Error('Smoke test could not find any trained AI profile exports.');
}

async function main() {
  const allowedProfiles = await loadSmokeProfiles();
  const smokeCase = {
    ...BASE_SMOKE_CASE,
    allowedProfiles,
  };
  const startedAt = Date.now();
  const first = await runOneSmokeCase(smokeCase, WORKER_TIMEOUT_MS);
  const second = await runOneSmokeCase(smokeCase, WORKER_TIMEOUT_MS);
  assertHealthy(first);
  assertHealthy(second);
  assertDeterministic(first, second);

  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    ok: true,
    elapsedMs,
    case: {
      ...BASE_SMOKE_CASE,
      allowedProfiles: allowedProfiles.map((profile) => profile.name),
    },
    snapshot: first,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || 'Unknown smoke-test failure');
  process.exit(1);
});
