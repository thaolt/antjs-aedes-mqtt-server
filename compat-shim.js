// Compatibility shims for the Ant runtime's incomplete Node.js APIs,
// plus the WebSocket transport adapter used by server.js.
//
// Everything below no-ops or passthroughs under Node and Bun, which
// don't need any of it.
import nodeStream from 'stream';
import nodeBuffer from 'buffer';
import net from 'net';
import { Buffer as PolyfillBuffer } from 'buffer/index.js';
import { createHash } from 'crypto';
import { Duplex } from 'readable-stream';

const isAnt = typeof process !== 'undefined' &&
  process.versions && process.versions.ant;

if (isAnt) {
  // Buffer: ant's Buffer rejects `new Buffer(n)` and lacks most read*/write*
  // accessors. Restore constructor semantics and graft the missing methods
  // from feross/buffer (npm `buffer`), whose methods operate on plain indexed
  // bytes and work on native instances.
  const NativeBuffer = globalThis.Buffer;

  function BufferCompat(value, encoding) {
    return typeof value === 'number'
      ? NativeBuffer.alloc(value)
      : NativeBuffer.from(value, encoding);
  }
  BufferCompat.prototype = NativeBuffer.prototype;
  Object.setPrototypeOf(BufferCompat, NativeBuffer);

  Object.getOwnPropertyNames(PolyfillBuffer.prototype).forEach(function (name) {
    if (name === 'constructor' || name in NativeBuffer.prototype) return;
    const desc = Object.getOwnPropertyDescriptor(PolyfillBuffer.prototype, name);
    try { Object.defineProperty(NativeBuffer.prototype, name, desc); } catch (e) {}
  });

  globalThis.Buffer = BufferCompat;
  try { nodeBuffer.Buffer = BufferCompat; } catch (e) {}

  // ant's setImmediate drops extra arguments; wrap to forward them.
  const origSetImmediate = globalThis.setImmediate;
  globalThis.setImmediate = function (fn) {
    const args = Array.prototype.slice.call(arguments, 1);
    return origSetImmediate(function () { return fn.apply(null, args); });
  };

  // ant's stream.finished() returns a non-function; Node returns a cleanup
  // function that aedes calls on close. Wrap it to guarantee a function.
  try {
    const origFinished = nodeStream.finished;
    nodeStream.finished = function () {
      const undo = origFinished.apply(this, arguments);
      return typeof undo === 'function' ? undo : function () {};
    };
  } catch (e) {}

  // ant's Readable.from() doesn't support async iterables, streams, or object
  // items — aedes-persistence relies on all three. Readable.from is always
  // objectMode; reimplement it by pulling from the source and push()ing.
  try {
    const Readable = nodeStream.Readable;
    const origFrom = Readable.from;
    Readable.from = function (src, opts) {
      if (src == null || typeof src === 'string' || NativeBuffer.isBuffer(src) || src instanceof Uint8Array) {
        return origFrom.call(Readable, src, opts);
      }
      const out = new Readable({ objectMode: true, read: function () {} });
      if (typeof src[Symbol.asyncIterator] === 'function') {
        (async function () {
          try {
            for await (const c of src) out.push(c);
            out.push(null);
          } catch (e) { try { out.destroy(e); } catch (_) {} }
        })();
      } else if (typeof src.on === 'function' && typeof src.pipe === 'function') {
        src.on('data', function (c) { out.push(c); });
        src.on('end', function () { out.push(null); });
        src.on('error', function (e) { try { out.destroy(e); } catch (_) {} });
      } else if (typeof src[Symbol.iterator] === 'function') {
        for (const c of src) out.push(c);
        out.push(null);
      } else {
        out.push(src);
        out.push(null);
      }
      return out;
    };
  } catch (e) {}
}

// ant sockets only emit 'data'; aedes needs the pull-style 'readable'/read()
// interface, so wrap the socket in a readable-stream Duplex. Other runtimes
// already provide proper Duplex sockets — passthrough there.
export const wrapSocket = isAnt
  ? function wrapSocket(socket) {
      const d = new Duplex({
        write(chunk, enc, cb) {
          socket.write(chunk);
          cb();
        },
        final(cb) {
          socket.end();
          cb();
        },
        destroy(err, cb) {
          socket.destroy();
          cb(err);
        },
        read() {}
      });
      socket.on('data', c => d.push(c));
      socket.on('end', () => d.push(null));
      socket.on('error', e => d.destroy(e));
      socket.on('close', () => d.push(null));
      return d;
    }
  : function wrapSocket(socket) { return socket; };

// ---------------------------------------------------------------------------
// WebSocket transport
//
// Ant's http server ignores Upgrade requests, so under ant the RFC 6455
// handshake and frame codec run directly on a raw TCP socket (wsStream below).
// Under Node/Bun the standard http + ws stack is used instead.
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}

function endOfHeaders(buffer) {
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === 0x0d && buffer[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}

function acceptKey(key) {
  return createHash('sha1').update(key.trim() + WS_GUID).digest('base64');
}

function wsStream(socket) {
  let buffer = Buffer.alloc(0);
  let handshaken = false;
  let closed = false;
  let fragments = [];

  const duplex = new Duplex({
    read() {},
    write(chunk, enc, cb) {
      socket.write(encodeFrame(chunk, OP_BINARY));
      cb();
    },
    final(cb) {
      close();
      cb();
    },
    destroy(err, cb) {
      socket.destroy();
      cb(err);
    },
  });

  function close() {
    if (closed) return;
    closed = true;
    socket.write(encodeFrame(Buffer.alloc(0), OP_CLOSE));
    socket.end();
    duplex.push(null);
    duplex.end();
  }

  function fail() {
    socket.destroy();
    duplex.destroy(new Error('websocket protocol error'));
  }

  function handshake() {
    const end = endOfHeaders(buffer);
    if (end === -1) return false;

    const request = buffer.slice(0, end).toString('latin1');
    buffer = buffer.slice(end + 4);

    const lines = request.split('\r\n');
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i !== -1) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }

    const key = headers['sec-websocket-key'];
    if (!key || !headers.upgrade || headers.upgrade.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      fail();
      return true;
    }

    let response = 'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n`;

    const requested = headers['sec-websocket-protocol'];
    if (requested) {
      const protocol = requested.split(',').map((p) => p.trim()).find((p) => p === 'mqtt' || p === 'mqttv3.1');
      if (protocol) response += `Sec-WebSocket-Protocol: ${protocol}\r\n`;
    }
    socket.write(response + '\r\n');
    handshaken = true;
    return true;
  }

  function processFrames() {
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        len = buffer.readUInt32BE(offset) * 4294967296 + buffer.readUInt32BE(offset + 4);
        offset += 8;
      }
      let mask;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) return;
      let payload = buffer.slice(offset, offset + len);
      buffer = buffer.slice(offset + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }

      switch (opcode) {
        case OP_CLOSE:
          close();
          return;
        case OP_PING:
          socket.write(encodeFrame(payload, OP_PONG));
          break;
        case OP_PONG:
          break;
        case OP_BINARY:
        case OP_CONTINUATION:
        case 0x1:
          fragments.push(payload);
          if (fin) {
            duplex.push(Buffer.concat(fragments));
            fragments = [];
          }
          break;
        default:
          fail();
          return;
      }
    }
  }

  socket.on('data', (chunk) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshaken && !handshake()) return;
    processFrames();
  });
  socket.on('error', (err) => duplex.destroy(err));
  socket.on('end', () => {
    duplex.push(null);
    duplex.end();
  });
  socket.on('close', () => {
    duplex.push(null);
    duplex.end();
  });

  return duplex;
}

// Returns a server object with listen(port, cb); the handler receives a
// Duplex stream ready for aedes.handle().
export let createWsServer;

if (isAnt) {
  createWsServer = function createWsServer(handler) {
    return net.createServer((socket) => handler(wsStream(socket)));
  };
} else {
  const { createServer } = await import('http');
  const { WebSocketServer, createWebSocketStream } = await import('ws');
  createWsServer = function createWsServer(handler) {
    const server = createServer();
    new WebSocketServer({ server })
      .on('connection', (ws) => handler(createWebSocketStream(ws)));
    return server;
  };
}
