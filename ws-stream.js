// Minimal WebSocket server-side transport for Ant.
//
// Ant's http server ignores Upgrade requests, so this performs the RFC 6455
// handshake and frame codec directly on a raw net.Socket, exposing the result
// as a readable-stream Duplex suitable for aedes.handle().
import { createHash } from 'crypto'
import { Duplex } from 'readable-stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

function encodeFrame(payload, opcode) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeUInt32BE(Math.floor(len / 4294967296), 2)
    header.writeUInt32BE(len >>> 0, 6)
  }
  return Buffer.concat([header, payload])
}

function endOfHeaders(buffer) {
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === 0x0d && buffer[i + 3] === 0x0a) {
      return i
    }
  }
  return -1
}

function acceptKey(key) {
  return createHash('sha1').update(key.trim() + WS_GUID).digest('base64')
}

export function wsStream(socket) {
  let buffer = Buffer.alloc(0)
  let handshaken = false
  let closed = false
  let fragments = []
  let fragmentOpcode = 0

  const duplex = new Duplex({
    read() {},
    write(chunk, enc, cb) {
      socket.write(encodeFrame(chunk, OP_BINARY))
      cb()
    },
    final(cb) {
      close()
      cb()
    },
    destroy(err, cb) {
      socket.destroy()
      cb(err)
    },
  })

  function close() {
    if (closed) return
    closed = true
    socket.write(encodeFrame(Buffer.alloc(0), OP_CLOSE))
    socket.end()
    duplex.push(null)
    duplex.end()
  }

  function fail() {
    socket.destroy()
    duplex.destroy(new Error('websocket protocol error'))
  }

  function handshake() {
    const end = endOfHeaders(buffer)
    if (end === -1) return false

    const request = buffer.slice(0, end).toString('latin1')
    buffer = buffer.slice(end + 4)

    const lines = request.split('\r\n')
    const headers = {}
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':')
      if (i !== -1) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
    }

    const key = headers['sec-websocket-key']
    if (!key || !headers.upgrade || headers.upgrade.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
      fail()
      return true
    }

    let response = 'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n`

    const requested = headers['sec-websocket-protocol']
    if (requested) {
      const protocol = requested.split(',').map((p) => p.trim()).find((p) => p === 'mqtt' || p === 'mqttv3.1')
      if (protocol) response += `Sec-WebSocket-Protocol: ${protocol}\r\n`
    }
    socket.write(response + '\r\n')
    handshaken = true
    return true
  }

  function processFrames() {
    for (;;) {
      if (buffer.length < 2) return
      const fin = (buffer[0] & 0x80) !== 0
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let len = buffer[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (buffer.length < offset + 2) return
        len = buffer.readUInt16BE(offset)
        offset += 2
      } else if (len === 127) {
        if (buffer.length < offset + 8) return
        len = buffer.readUInt32BE(offset) * 4294967296 + buffer.readUInt32BE(offset + 4)
        offset += 8
      }
      let mask
      if (masked) {
        if (buffer.length < offset + 4) return
        mask = buffer.slice(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + len) return
      let payload = buffer.slice(offset, offset + len)
      buffer = buffer.slice(offset + len)
      if (masked) {
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      }

      switch (opcode) {
        case OP_CLOSE:
          close()
          return
        case OP_PING:
          socket.write(encodeFrame(payload, OP_PONG))
          break
        case OP_PONG:
          break
        case OP_TEXT:
        case OP_BINARY:
        case OP_CONTINUATION:
          if (opcode !== OP_CONTINUATION) fragmentOpcode = opcode
          fragments.push(payload)
          if (fin) {
            duplex.push(Buffer.concat(fragments))
            fragments = []
            fragmentOpcode = 0
          }
          break
        default:
          fail()
          return
      }
    }
  }

  socket.on('data', (chunk) => {
    if (closed) return
    buffer = Buffer.concat([buffer, chunk])
    if (!handshaken && !handshake()) return
    processFrames()
  })
  socket.on('error', (err) => duplex.destroy(err))
  socket.on('end', () => {
    duplex.push(null)
    duplex.end()
  })
  socket.on('close', () => {
    duplex.push(null)
    duplex.end()
  })

  return duplex
}
