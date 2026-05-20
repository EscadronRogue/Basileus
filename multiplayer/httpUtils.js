// multiplayer/httpUtils.js - shared HTTP utilities for the local and
// multiplayer servers.

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

// Security headers attached to every response from this server. They are
// conservative but compatible with the game (single-origin, no third-party
// scripts, no embedded fonts).
const BASE_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
};

// CSP for the HTML shell. The game ships zero third-party scripts but the
// HTML contains inline <style>/<script> blocks, so 'unsafe-inline' is
// reluctantly kept. WebSocket connections are allowed because the deployed
// page targets a Render host.
const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: ws:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function applySecurityHeaders(res, { html = false } = {}) {
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  if (html) res.setHeader('content-security-policy', HTML_CSP);
}

export function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  applySecurityHeaders(res);
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
  const ext = extname(filePath).toLowerCase();
  const isHtml = ext === '.html' || ext === '.htm';
  applySecurityHeaders(res, { html: isHtml });
  res.writeHead(200, {
    'content-type': MIME_TYPES.get(ext) || 'application/octet-stream',
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
