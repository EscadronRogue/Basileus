import { createHash } from 'node:crypto';

// Hard cap on the size of any single WebSocket message we'll accept from a
// client, in bytes. The legitimate Basileus protocol sends small JSON
// messages — well under 64 KiB — so 1 MiB is a generous ceiling that still
// stops a malicious client from declaring a 2^63-byte frame and forcing the
// server to buffer indefinitely.
const MAX_MESSAGE_BYTES = 1 << 20; // 1 MiB
// Cap on the unframed text payload we'll re-assemble across fragmented
// frames. Same rationale as above, applied to the running total.
const MAX_FRAGMENT_BUFFER_BYTES = MAX_MESSAGE_BYTES;
// RFC 6455 §5.5: control frames must have a payload of at most 125 bytes
// and must not be fragmented.
const MAX_CONTROL_FRAME_BYTES = 125;

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

function isControlOpcode(opcode) {
  return (opcode & 0x8) !== 0;
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const source = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = source.length;

  let header = null;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, source]);
}

// Returns one of:
//   null                                   — need more bytes, try again later
//   { protocolError, reason }              — fail the connection per RFC
//   { frame, consumed }                    — successfully parsed
function tryParseFrame(buffer) {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const fin = (firstByte & 0x80) !== 0;
  const rsv = firstByte & 0x70;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  // No extensions are negotiated, so reserved bits must be zero.
  if (rsv !== 0) {
    return { protocolError: true, reason: 'Reserved bits must be 0 (no extensions negotiated).' };
  }

  // RFC 6455 §5.1: a client MUST mask all frames sent to the server.
  if (!masked) {
    return { protocolError: true, reason: 'Client frames must be masked.' };
  }

  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE_BYTES)) {
      return { protocolError: true, reason: `Frame payload exceeds ${MAX_MESSAGE_BYTES} bytes.` };
    }
    payloadLength = Number(big);
    offset = 10;
  }

  if (payloadLength > MAX_MESSAGE_BYTES) {
    return { protocolError: true, reason: `Frame payload exceeds ${MAX_MESSAGE_BYTES} bytes.` };
  }

  if (isControlOpcode(opcode)) {
    if (!fin) {
      return { protocolError: true, reason: 'Control frames must not be fragmented.' };
    }
    if (payloadLength > MAX_CONTROL_FRAME_BYTES) {
      return { protocolError: true, reason: 'Control frame payload too large.' };
    }
  }

  const maskLength = 4;
  if (buffer.length < offset + maskLength + payloadLength) return null;

  const mask = buffer.subarray(offset, offset + maskLength);
  const maskedPayload = buffer.subarray(offset + maskLength, offset + maskLength + payloadLength);
  const unmasked = Buffer.alloc(payloadLength);
  for (let index = 0; index < payloadLength; index += 1) {
    unmasked[index] = maskedPayload[index] ^ mask[index % 4];
  }

  return {
    frame: { fin, opcode, payload: unmasked },
    consumed: offset + maskLength + payloadLength,
  };
}

export class WebSocketConnection {
  constructor(socket, request) {
    this.socket = socket;
    this.request = request;
    this.buffer = Buffer.alloc(0);
    this.messageHandler = null;
    this.closeHandler = null;
    this.closed = false;
    this.closeNotified = false;
    this.awaitingPong = false;
    this.lastActivityAt = Date.now();
    // Accumulator for fragmented messages (0x1/0x2 followed by 0x0…).
    this.fragmentOpcode = null;
    this.fragmentChunks = [];
    this.fragmentBytes = 0;
    this.keepaliveTimer = setInterval(() => this.runKeepalive(), 25_000);

    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('close', () => this.handleClose());
    socket.on('end', () => this.handleClose());
    socket.on('error', () => this.handleClose());
  }

  onMessage(handler) { this.messageHandler = handler; }
  onClose(handler) { this.closeHandler = handler; }

  sendJson(payload) {
    if (this.closed) return;
    this.socket.write(encodeFrame(OPCODE.TEXT, JSON.stringify(payload)));
  }

  sendPong(payload) {
    if (this.closed) return;
    this.socket.write(encodeFrame(OPCODE.PONG, payload));
  }

  sendPing(payload = '') {
    if (this.closed) return;
    this.socket.write(encodeFrame(OPCODE.PING, payload));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBytes = Buffer.byteLength(reason);
    const body = Buffer.alloc(2 + reasonBytes);
    body.writeUInt16BE(code, 0);
    if (reasonBytes) body.write(reason, 2);
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, body));
    } catch {
      // Ignore close-write errors.
    }
    this.socket.end();
  }

  failConnection(code, reason) {
    // RFC 6455 §7.1.7: send a close frame and then drop the connection.
    this.close(code, reason);
    this.socket.destroy();
  }

  resetFragmentBuffer() {
    this.fragmentOpcode = null;
    this.fragmentChunks = [];
    this.fragmentBytes = 0;
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (!this.closed) {
      const parsed = tryParseFrame(this.buffer);
      if (parsed == null) return;

      if (parsed.protocolError) {
        this.failConnection(1002, parsed.reason);
        return;
      }

      this.buffer = this.buffer.subarray(parsed.consumed);
      this.lastActivityAt = Date.now();

      const { fin, opcode, payload } = parsed.frame;

      if (opcode === OPCODE.CLOSE) { this.close(); return; }
      if (opcode === OPCODE.PING) { this.sendPong(payload); continue; }
      if (opcode === OPCODE.PONG) { this.awaitingPong = false; continue; }

      if (opcode === OPCODE.CONTINUATION) {
        if (this.fragmentOpcode == null) {
          this.failConnection(1002, 'Continuation frame without an initial data frame.');
          return;
        }
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > MAX_FRAGMENT_BUFFER_BYTES) {
          this.failConnection(1009, 'Fragmented message too large.');
          return;
        }
        this.fragmentChunks.push(payload);
        if (!fin) continue;
        const fullPayload = Buffer.concat(this.fragmentChunks, this.fragmentBytes);
        const startedOpcode = this.fragmentOpcode;
        this.resetFragmentBuffer();
        this.dispatchDataFrame(startedOpcode, fullPayload);
        continue;
      }

      if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
        if (this.fragmentOpcode != null) {
          this.failConnection(1002, 'New data frame received before previous fragmented message finished.');
          return;
        }
        if (fin) {
          this.dispatchDataFrame(opcode, payload);
        } else {
          this.fragmentOpcode = opcode;
          this.fragmentChunks = [payload];
          this.fragmentBytes = payload.length;
        }
        continue;
      }

      // Unknown opcode — RFC 6455 §5.2 requires failing the connection.
      this.failConnection(1002, `Unknown opcode 0x${opcode.toString(16)}.`);
      return;
    }
  }

  dispatchDataFrame(opcode, payload) {
    if (opcode !== OPCODE.TEXT) {
      // Basileus only speaks JSON-over-text. Reject binary frames cleanly.
      this.sendJson({ type: 'action_rejected', reason: 'Binary WebSocket frames are not supported.' });
      return;
    }
    let text;
    try {
      text = payload.toString('utf8');
    } catch {
      this.failConnection(1007, 'Invalid UTF-8 in text frame.');
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.sendJson({ type: 'action_rejected', reason: 'Malformed WebSocket message.' });
      return;
    }
    try {
      this.messageHandler?.(message);
    } catch {
      // Handler errors surface via the room's reject path; swallow here so a
      // buggy handler can't tear down the socket loop.
    }
  }

  runKeepalive() {
    if (this.closed) return;
    if (this.awaitingPong && Date.now() - this.lastActivityAt > 45_000) {
      this.close(1001, 'Ping timeout');
      return;
    }
    this.awaitingPong = true;
    this.sendPing(String(Date.now()));
  }

  handleClose() {
    this.closed = true;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.resetFragmentBuffer();
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closeHandler?.();
  }
}

function rejectUpgrade(socket, statusLine, reason = '') {
  const body = reason ? `${reason}\n` : '';
  const headers = [
    `HTTP/1.1 ${statusLine}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');
  try { socket.write(headers); } catch { /* ignore */ }
  socket.destroy();
}

export function attachWebSocketServer(server, onConnection, options = {}) {
  const allowRequest = typeof options.allowRequest === 'function' ? options.allowRequest : null;

  server.on('upgrade', (request, socket) => {
    if (!request.url?.startsWith('/ws')) {
      socket.destroy();
      return;
    }

    if (allowRequest && !allowRequest(request)) {
      rejectUpgrade(socket, '403 Forbidden', 'Origin not allowed.');
      return;
    }

    // Validate the WebSocket handshake headers per RFC 6455 §4.2.1.
    const upgradeHeader = String(request.headers.upgrade || '').toLowerCase();
    const connectionHeader = String(request.headers.connection || '').toLowerCase();
    const connectionTokens = connectionHeader.split(',').map((part) => part.trim());
    if (upgradeHeader !== 'websocket' || !connectionTokens.includes('upgrade')) {
      rejectUpgrade(socket, '400 Bad Request', 'Expected WebSocket upgrade headers.');
      return;
    }

    const version = String(request.headers['sec-websocket-version'] || '').trim();
    if (version !== '13') {
      try {
        socket.write([
          'HTTP/1.1 426 Upgrade Required',
          'Sec-WebSocket-Version: 13',
          'Connection: close',
          'Content-Length: 0',
          '\r\n',
        ].join('\r\n'));
      } catch { /* ignore */ }
      socket.destroy();
      return;
    }

    const key = String(request.headers['sec-websocket-key'] || '').trim();
    // Base64-encoded 16-byte nonce → 24 chars.
    if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) {
      rejectUpgrade(socket, '400 Bad Request', 'Invalid Sec-WebSocket-Key.');
      return;
    }

    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));

    onConnection(new WebSocketConnection(socket, request), request);
  });
}
