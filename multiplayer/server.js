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
    try {
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

  attachMultiplayerSocketServer(server, manager);

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
  startMultiplayerServer({
    port: Number(process.env.PORT || 8133),
    host: process.env.HOST || '127.0.0.1',
  }).then((instance) => {
    console.log(`Basileus multiplayer server is running at ${instance.url}`);
    console.log(`WebSocket endpoint: ws://${instance.host}:${instance.port}/ws`);
  }).catch((error) => {
    console.error(error?.stack || error?.message || 'Failed to start multiplayer server.');
    process.exit(1);
  });
}
