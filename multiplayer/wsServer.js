import { createHash } from 'node:crypto';

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

function tryParseFrame(buffer) {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const fin = (firstByte & 0x80) !== 0;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + payloadLength) return null;

  let payload = buffer.subarray(offset + maskLength, offset + maskLength + payloadLength);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    const unmasked = Buffer.alloc(payloadLength);
    for (let index = 0; index < payloadLength; index += 1) {
      unmasked[index] = payload[index] ^ mask[index % 4];
    }
    payload = unmasked;
  }

  return {
    fin,
    opcode,
    payload,
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

    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('close', () => this.handleClose());
    socket.on('end', () => this.handleClose());
    socket.on('error', () => this.handleClose());
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  onClose(handler) {
    this.closeHandler = handler;
  }

  sendJson(payload) {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x1, JSON.stringify(payload)));
  }

  sendPong(payload) {
    if (this.closed) return;
    this.socket.write(encodeFrame(0xA, payload));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    if (reason) body.write(reason, 2);
    try {
      this.socket.write(encodeFrame(0x8, body));
    } catch {
      // Ignore close write errors.
    }
    this.socket.end();
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = tryParseFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.consumed);

      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        this.sendPong(frame.payload);
        continue;
      }
      if (frame.opcode !== 0x1 || !frame.fin) continue;

      try {
        const message = JSON.parse(frame.payload.toString('utf8'));
        this.messageHandler?.(message);
      } catch {
        this.sendJson({
          type: 'action_rejected',
          reason: 'Malformed WebSocket message.',
        });
      }
    }
  }

  handleClose() {
    this.closed = true;
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closeHandler?.();
  }
}

export function attachWebSocketServer(server, onConnection, options = {}) {
  const allowRequest = typeof options.allowRequest === 'function'
    ? options.allowRequest
    : null;

  server.on('upgrade', (request, socket) => {
    if (!request.url?.startsWith('/ws')) {
      socket.destroy();
      return;
    }

    if (allowRequest && !allowRequest(request)) {
      socket.write([
        'HTTP/1.1 403 Forbidden',
        'Connection: close',
        '\r\n',
      ].join('\r\n'));
      socket.destroy();
      return;
    }

    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
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
