// ui/multiplayer/connection.js - backend URLs, the HTTP room API, and sessions remembered per room.

const STORAGE_KEY = 'basileus.multiplayer.sessions.v1';
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HTTP_KEEPALIVE_INTERVAL_MS = 4 * 60_000;
export const ACTIVE_ROOM_KEEPALIVE_MS = 60 * 60 * 1000;
export const FINISHED_ROOM_KEEPALIVE_MS = 10 * 60 * 1000;

export function parseTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function maxTimestampMs(...values) {
  return values.reduce((max, value) => Math.max(max, parseTimestampMs(value)), 0);
}

function readStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStorage(store) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore storage failures.
  }
}

export function normalizeRoomCode(roomCode) {
  return String(roomCode || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

export function getStoredMultiplayerSession(roomCode) {
  return readStorage()[normalizeRoomCode(roomCode)] || null;
}

export function saveMultiplayerSession(record) {
  if (!record?.roomCode) return;
  const store = readStorage();
  store[normalizeRoomCode(record.roomCode)] = {
    roomCode: normalizeRoomCode(record.roomCode),
    sessionToken: record.sessionToken || '',
    seatToken: record.seatToken || '',
    playerName: record.playerName || '',
  };
  writeStorage(store);
}

export function clearMultiplayerSession(roomCode) {
  const normalized = normalizeRoomCode(roomCode);
  const store = readStorage();
  delete store[normalized];
  writeStorage(store);
}

function readBackendBase() {
  // Highest priority: explicit override via `window.BASILEUS_MULTIPLAYER_URL`.
  // Useful for ad-hoc testing without rebuilding the page.
  const override = typeof window !== 'undefined' && window.BASILEUS_MULTIPLAYER_URL;
  if (override && typeof override === 'string') {
    return override.trim().replace(/\/+$/, '');
  }
  // Then: a <meta name="basileus-multiplayer-url" content="..."> tag in the
  // page. The deployed GitHub Pages build sets this to the Render URL; the
  // local dev server leaves it blank so we fall back to same-origin.
  if (typeof document !== 'undefined') {
    const meta = document.querySelector('meta[name="basileus-multiplayer-url"]');
    const value = meta?.getAttribute('content');
    if (value && value.trim()) {
      return value.trim().replace(/\/+$/, '');
    }
  }
  return '';
}

export function resolveApiUrl(path) {
  const base = readBackendBase();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function buildWebSocketUrl() {
  const base = readBackendBase();
  if (base) {
    // Translate http(s):// → ws(s):// while keeping host + path intact.
    const url = new URL(base);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${url.host}${url.pathname.replace(/\/$/, '')}/ws`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export async function requestJson(path, payload) {
  const url = resolveApiUrl(path);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = response.status === 404 && String(path).startsWith('/api/rooms')
      ? 'This server does not have the multiplayer backend yet. Stop the current local server and start it again.'
      : body?.error || 'Request failed.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function joinRoomPayload(roomCode, playerName) {
  return requestJson(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
    playerName,
  });
}
