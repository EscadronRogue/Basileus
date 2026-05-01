import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  attachMultiplayerSocketServer,
  closeMultiplayerConnections,
  createMultiplayerError,
  handleMultiplayerApiRequest,
  MultiplayerRoomManager,
} from './service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

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

// Origins allowed to talk to the API/WebSocket from a browser. Localhost on any
// port always works (so the local dev server keeps functioning), and the
// deployed GitHub Pages site is allowed by default. Extra origins can be added
// via the ALLOWED_ORIGINS env var (comma-separated).
const DEFAULT_ALLOWED_ORIGINS = [
  'https://escadronrogue.github.io',
];

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  const extra = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

const ALLOWED_ORIGINS = parseAllowedOrigins();

function isLocalOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

function isSelfOrigin(req, requestOrigin) {
  if (!requestOrigin) return false;
  try {
    const origin = new URL(requestOrigin);
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const requestProtocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
    const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!requestHost) return false;
    return origin.protocol === `${requestProtocol}:` && origin.host === requestHost;
  } catch {
    return false;
  }
}

function resolveAllowedOrigin(req, requestOrigin) {
  if (!requestOrigin) return null;
  if (ALLOWED_ORIGINS.has(requestOrigin)) return requestOrigin;
  if (isLocalOrigin(requestOrigin)) return requestOrigin;
  if (isSelfOrigin(req, requestOrigin)) return requestOrigin;
  return null;
}

function applyCorsHeaders(req, res) {
  const requestOrigin = req.headers.origin || '';
  const allowedOrigin = resolveAllowedOrigin(req, requestOrigin);
  if (allowedOrigin) {
    res.setHeader('access-control-allow-origin', allowedOrigin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '600');
  }
  return Boolean(allowedOrigin);
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function serveStaticFile(res, filePath, fileInfo) {
  res.writeHead(200, {
    'content-type': MIME_TYPES.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
    'content-length': fileInfo.size,
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = resolve(projectRoot, `.${pathname}`);
  const relativePath = relative(projectRoot, filePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw createMultiplayerError(403, 'Forbidden path.');
  }
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) {
    throw createMultiplayerError(404, 'Not found.');
  }
  serveStaticFile(res, filePath, fileInfo);
}

export async function startMultiplayerServer(options = {}) {
  const manager = new MultiplayerRoomManager();
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? 8133);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    applyCorsHeaders(req, res);

    // CORS preflight: respond before doing any work.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'content-length': '0' });
      res.end();
      return;
    }

    try {
      // Health check — used by Render and any uptime monitor.
      if (req.method === 'GET' && url.pathname === '/healthz') {
        jsonResponse(res, 200, { ok: true, service: 'basileus-multiplayer' });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const result = await handleMultiplayerApiRequest(manager, req, url);
        jsonResponse(res, result.statusCode, result.payload);
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      jsonResponse(res, error?.statusCode || 500, {
        error: error?.message || 'Internal server error.',
      });
    }
  });

  attachMultiplayerSocketServer(server, manager, {
    allowRequest: (request) => {
      const origin = request.headers.origin || '';
      return !origin || Boolean(resolveAllowedOrigin(request, origin));
    },
  });

  await new Promise((resolveReady) => {
    server.listen(port, host, resolveReady);
  });

  const address = server.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;

  return {
    host,
    port: resolvedPort,
    server,
    manager,
    url: `http://${host}:${resolvedPort}/`,
    close: async () => {
      closeMultiplayerConnections(manager);

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
  // Bind to 0.0.0.0 by default when launched as the entry point, so the
  // process is reachable in container/PaaS environments (Render, Fly, etc.).
  // Local dev can still pin to 127.0.0.1 by setting HOST.
  startMultiplayerServer({
    port: Number(process.env.PORT || 8133),
    host: process.env.HOST || '0.0.0.0',
  }).then((instance) => {
    console.log(`Basileus multiplayer server is running on ${instance.host}:${instance.port}`);
    console.log(`Health check: http://${instance.host}:${instance.port}/healthz`);
    console.log(`Allowed browser origins: ${[...ALLOWED_ORIGINS].join(', ')} (+ localhost)`);
  }).catch((error) => {
    console.error(error?.stack || error?.message || 'Failed to start multiplayer server.');
    process.exit(1);
  });
}
