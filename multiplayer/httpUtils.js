// multiplayer/httpUtils.js — shared HTTP utilities for the multiplayer and
// training servers. Static file serving, JSON responses, and graceful
// listen/close helpers live here so both servers stay in lockstep.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

export const MIME_TYPES = new Map([
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

export function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// Resolves a URL pathname against `projectRoot` and streams the file. Returns
// the served file path on success; throws an error with `statusCode` on
// forbidden/missing paths so callers can map to a JSON error.
export async function serveStatic(req, res, url, projectRoot, options = {}) {
  const indexFile = options.indexFile || 'index.html';
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = `/${indexFile}`;
  const filePath = resolve(projectRoot, `.${pathname}`);
  const relativePath = relative(projectRoot, filePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    const error = new Error('Forbidden path.');
    error.statusCode = 403;
    throw error;
  }
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error('Not a file.');
  } catch {
    const error = new Error('Not found.');
    error.statusCode = 404;
    throw error;
  }
  res.writeHead(200, {
    'content-type': MIME_TYPES.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
    'content-length': fileInfo.size,
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
  return filePath;
}

export function listenServer(server, port, host) {
  return new Promise((resolveReady) => {
    server.listen(port, host, resolveReady);
  });
}

export function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}
