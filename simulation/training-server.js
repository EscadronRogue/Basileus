import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import {
  attachMultiplayerSocketServer,
  closeMultiplayerConnections,
  handleMultiplayerApiRequest,
  MultiplayerRoomManager,
} from '../multiplayer/service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const runsDir = resolve(projectRoot, '.training-runs');

const jobs = new Map();

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
]);

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readRequestJson(req) {
  return new Promise((resolveRequest, rejectRequest) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        rejectRequest(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolveRequest({});
      try {
        resolveRequest(JSON.parse(body));
      } catch (error) {
        rejectRequest(error);
      }
    });
    req.on('error', rejectRequest);
  });
}

function pushJobEvent(job, event) {
  const normalizedEvent = {
    at: new Date().toISOString(),
    ...event,
  };
  job.events.push(normalizedEvent);
  for (const res of job.clients) {
    res.write(`data: ${JSON.stringify(normalizedEvent)}\n\n`);
  }
}

function configToArgs(config, outputPath) {
  const args = [
    resolve(__dirname, 'train-node.js'),
    `--out=${outputPath}`,
    '--progressEvery=1',
  ];

  const flatKeys = [
    'seed',
    'playerCount',
    'deckSize',
    'fitnessPresetId',
    'populationSize',
    'generations',
    'matchesPerCandidate',
    'validationMatchesPerCandidate',
    'holdoutMatchesPerChampion',
    'champions',
    'hallOfFameSize',
    'eliteFraction',
    'freshBloodRate',
    'hallOfFameMixFraction',
  ];

  for (const key of flatKeys) {
    if (config[key] !== undefined && config[key] !== null && config[key] !== '') {
      args.push(`--${key}=${config[key]}`);
    }
  }

  if (Number(config.parallelWorkers || 0) <= 0) {
    args.push('--parallelWorkers=auto');
  } else {
    args.push(`--parallelWorkers=${Number(config.parallelWorkers)}`);
  }

  for (const [key, value] of Object.entries(config.fitness || {})) {
    if (Number.isFinite(Number(value))) {
      args.push(`--fitness.${key}=${value}`);
    }
  }

  return args;
}

async function createTrainingJob(config) {
  await mkdir(runsDir, { recursive: true });
  const id = randomUUID();
  const outputPath = resolve(runsDir, `${id}.json`);
  const job = {
    id,
    type: 'training',
    status: 'queued',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    config,
    outputPath,
    events: [],
    clients: new Set(),
    process: null,
  };
  jobs.set(id, job);

  const args = configToArgs(config, outputPath);
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  job.process = child;
  job.status = 'running';
  const command = `node ${args.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ")}`;
  console.log(`[trainer] starting job ${id}`);
  console.log(`[trainer] ${command}`);
  pushJobEvent(job, {
    event: 'spawn',
    jobId: id,
    command,
  });

  let stdoutBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      console.log(`[trainer ${id}] ${trimmed}`);
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        pushJobEvent(job, { jobId: id, ...event });
      } catch {
        pushJobEvent(job, { event: 'log', jobId: id, line: trimmed });
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    for (const line of chunk.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
      console.error(`[trainer ${id} stderr] ${line}`);
      pushJobEvent(job, { event: 'stderr', jobId: id, line });
    }
  });

  child.on('error', error => {
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    pushJobEvent(job, {
      event: 'error',
      jobId: id,
      message: error?.message || 'Training process failed to start.',
      stack: error?.stack || '',
    });
  });

  child.on('exit', code => {
    console.log(`[trainer] job ${id} exited with code ${code}`);
    job.finishedAt = new Date().toISOString();
    if (job.status === 'cancelled') {
      pushJobEvent(job, { event: 'cancelled', jobId: id, code });
      return;
    }
    if (code === 0) {
      job.status = 'done';
      pushJobEvent(job, { event: 'result-ready', jobId: id, output: outputPath });
    } else {
      job.status = 'error';
      pushJobEvent(job, {
        event: 'error',
        jobId: id,
        message: `Training process exited with code ${code}.`,
      });
    }
  });

  return job;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/simulator.html';
  const filePath = resolve(projectRoot, `.${pathname}`);
  const relativePath = relative(projectRoot, filePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    jsonResponse(res, 403, { error: "Forbidden path." });
    return;
  }
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error('Not a file.');
    res.writeHead(200, {
      'content-type': MIME_TYPES.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
      'content-length': fileInfo.size,
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    jsonResponse(res, 404, { error: 'Not found.' });
  }
}

function streamJobEvents(req, res, job) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  job.clients.add(res);
  req.on('close', () => {
    job.clients.delete(res);
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/trainer/status') {
    jsonResponse(res, 200, {
      localTrainer: true,
      availableParallelism: availableParallelism(),
      busy: [...jobs.values()].some(job => job.status === 'running' || job.status === 'queued'),
      jobs: [...jobs.values()].slice(-10).map(job => ({
        id: job.id,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      })),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/trainer/jobs') {
    try {
      const body = await readRequestJson(req);
      const config = body.config || {};
      const job = await createTrainingJob(config);
      jsonResponse(res, 201, {
        id: job.id,
        status: job.status,
        outputPath: job.outputPath,
      });
    } catch (error) {
      jsonResponse(res, 400, {
        error: error?.message || 'Could not start training job.',
      });
    }
    return;
  }

  const eventMatch = url.pathname.match(/^\/api\/trainer\/jobs\/([^/]+)\/events$/);
  if (req.method === 'GET' && eventMatch) {
    const job = jobs.get(eventMatch[1]);
    if (!job) return jsonResponse(res, 404, { error: 'Unknown job.' });
    streamJobEvents(req, res, job);
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/trainer\/jobs\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const job = jobs.get(cancelMatch[1]);
    if (!job) return jsonResponse(res, 404, { error: 'Unknown job.' });
    if (job.process && job.status === 'running') {
      job.status = 'cancelled';
      job.process.kill();
    }
    jsonResponse(res, 200, { id: job.id, status: job.status });
    return;
  }

  const resultMatch = url.pathname.match(/^\/api\/trainer\/jobs\/([^/]+)\/result$/);
  if (req.method === 'GET' && resultMatch) {
    const job = jobs.get(resultMatch[1]);
    if (!job) return jsonResponse(res, 404, { error: 'Unknown job.' });
    if (job.status !== 'done') return jsonResponse(res, 409, { error: `Job is ${job.status}.` });
    try {
      const result = JSON.parse(await readFile(job.outputPath, 'utf8'));
      jsonResponse(res, 200, result);
    } catch (error) {
      jsonResponse(res, 500, { error: error?.message || 'Could not read training result.' });
    }
    return;
  }

  jsonResponse(res, 404, { error: 'Unknown API route.' });
}


function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

export async function startTrainingServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] ?? 8123);
  const openOnStart = Boolean(options.open ?? process.argv.includes('--open'));
  const multiplayerManager = new MultiplayerRoomManager();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    try {
      if (url.pathname.startsWith('/api/trainer/')) {
        await handleApi(req, res, url);
        return;
      }
      if (url.pathname === '/api/rooms' || /^\/api\/rooms\/[^/]+\/join$/.test(url.pathname)) {
        const result = await handleMultiplayerApiRequest(multiplayerManager, req, url);
        jsonResponse(res, result.statusCode, result.payload);
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      jsonResponse(res, error?.statusCode || 500, {
        error: error?.message || 'Internal server error.',
        stack: error?.stack || '',
      });
    }
  });

  attachMultiplayerSocketServer(server, multiplayerManager);

  await new Promise((resolveReady) => {
    server.listen(port, host, resolveReady);
  });

  const address = server.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;
  const baseUrl = `http://${host}:${resolvedPort}`;
  const simulatorUrl = `${baseUrl}/simulator.html`;
  const gameUrl = `${baseUrl}/index.html`;

  console.log(`Basileus local server is running at ${simulatorUrl}`);
  console.log(`Main game URL: ${gameUrl}`);
  console.log(`Trainer status endpoint: ${baseUrl}/api/trainer/status`);
  console.log(`Multiplayer rooms endpoint: ${baseUrl}/api/rooms`);
  console.log('Use Ctrl+C to stop the local server.');
  if (openOnStart) {
    openBrowser(simulatorUrl);
  }

  return {
    host,
    port: resolvedPort,
    server,
    multiplayerManager,
    url: `${baseUrl}/`,
    close: async () => {
      closeMultiplayerConnections(multiplayerManager);
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startTrainingServer().catch((error) => {
    console.error(error?.stack || error?.message || 'Failed to start the local server.');
    process.exit(1);
  });
}
