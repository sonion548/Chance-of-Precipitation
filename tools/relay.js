// Room relay for co-op, spoken over WebSocket, with no dependencies.
//
// The relay is deliberately stupid: it knows about rooms and peers and nothing
// at all about the game. One peer in each room is the host and runs the whole
// simulation; everyone else is a client. All the relay does is hand messages
// between them and tell people who has arrived and who has left.
//
// That is worth the ~200 lines of frame handling below, because it means the
// project keeps its "no build step, no dependencies" promise — `npm start` is
// still the only command, and it now serves the game and the lobby together.
import { createHash, randomInt } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;          // 1 MB; nothing we send is remotely this big
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1

/* ==========================================================================
   WEBSOCKET FRAMING
   ========================================================================== */

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encodes a server→client frame. Server frames are never masked. */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/**
 * One connected socket. Buffers partial frames and reassembles fragmented
 * messages, which browsers do send once a payload gets large enough.
 */
class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = 0;
    this.closed = false;
    this.id = null;
    this.room = null;
    this.name = 'Descender';
    this.onMessage = null;
    this.onClose = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => {
      this.closed = true;
      this.onClose?.();
    });
  }

  send(obj) {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')));
    } catch {
      this.close();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch { /* already gone */ }
    try { this.socket.end(); } catch { /* already gone */ }
    this.onClose?.();
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (this.closed) return;
    }
  }

  /** Pulls one complete frame off the buffer, or returns null if it is short. */
  _readFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const high = b.readUInt32BE(2);
      len = high * 4294967296 + b.readUInt32BE(6);
      offset = 10;
    }
    if (len > MAX_FRAME) { this.close(); return null; }

    let mask = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      mask = b.subarray(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + len) return null;

    const payload = Buffer.from(b.subarray(offset, offset + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = b.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) { this.close(); return; }
    if (opcode === 0x9) {                       // ping → pong
      try { this.socket.write(encodeFrame(0xA, payload)); } catch { this.close(); }
      return;
    }
    if (opcode === 0xA) return;                 // pong

    if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      this.fragments = [payload];
      this.fragmentOp = opcode;
    }
    if (!fin) return;

    const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOp !== 0x1) return;        // text only
    let msg;
    try { msg = JSON.parse(full.toString('utf8')); } catch { return; }
    this.onMessage?.(msg);
  }
}

/* ==========================================================================
   ROOMS
   ========================================================================== */

export class Relay {
  constructor({ log = () => {} } = {}) {
    this.rooms = new Map();     // code -> { code, hostId, peers: Map<id, Conn> }
    this.nextId = 1;
    this.log = log;
  }

  /** Attaches to a node http server, taking over websocket upgrades. */
  attach(server, path = '/net') {
    server.on('upgrade', (req, socket) => {
      if (!req.url.startsWith(path)) { socket.destroy(); return; }
      const key = req.headers['sec-websocket-key'];
      if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
      socket.setNoDelay(true);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
      this._accept(new Conn(socket));
    });
  }

  _accept(conn) {
    conn.onMessage = (msg) => this._route(conn, msg);
    conn.onClose = () => this._leave(conn);
  }

  _freshCode() {
    for (let attempt = 0; attempt < 200; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return `R${Date.now().toString(36).slice(-4).toUpperCase()}`;
  }

  _route(conn, msg) {
    switch (msg.t) {
      case 'hello': return this._hello(conn, msg);
      case 'to': return this._forward(conn, msg);
      case 'all': return this._broadcast(conn, msg);
      case 'bye': return conn.close();
      default: break;
    }
  }

  _hello(conn, msg) {
    if (conn.room) return;
    conn.name = String(msg.name || 'Descender').slice(0, 18);

    let room;
    if (msg.code) {
      room = this.rooms.get(String(msg.code).toUpperCase().trim());
      if (!room) { conn.send({ t: 'error', reason: 'no-room', message: 'No lobby with that code.' }); return; }
      if (room.peers.size >= 8) { conn.send({ t: 'error', reason: 'full', message: 'That lobby is full.' }); return; }
    } else {
      const code = this._freshCode();
      room = { code, hostId: null, peers: new Map() };
      this.rooms.set(code, room);
    }

    conn.id = this.nextId++;
    conn.room = room;
    // First one in owns the simulation.
    if (room.hostId === null) room.hostId = conn.id;
    room.peers.set(conn.id, conn);

    conn.send({
      t: 'welcome',
      id: conn.id,
      code: room.code,
      hostId: room.hostId,
      peers: [...room.peers.values()]
        .filter((p) => p !== conn)
        .map((p) => ({ id: p.id, name: p.name })),
    });
    for (const peer of room.peers.values()) {
      if (peer === conn) continue;
      peer.send({ t: 'peerJoined', id: conn.id, name: conn.name });
    }
    this.log(`+ ${conn.name} (#${conn.id}) → room ${room.code} [${room.peers.size}]`);
  }

  _forward(conn, msg) {
    const room = conn.room;
    if (!room) return;
    const target = room.peers.get(msg.id);
    if (!target) return;
    target.send({ t: 'msg', from: conn.id, m: msg.m });
  }

  _broadcast(conn, msg) {
    const room = conn.room;
    if (!room) return;
    for (const peer of room.peers.values()) {
      if (peer === conn) continue;
      peer.send({ t: 'msg', from: conn.id, m: msg.m });
    }
  }

  _leave(conn) {
    const room = conn.room;
    if (!room) return;
    conn.room = null;
    room.peers.delete(conn.id);
    this.log(`- ${conn.name} (#${conn.id}) left room ${room.code} [${room.peers.size}]`);

    if (!room.peers.size) { this.rooms.delete(room.code); return; }

    // The host leaving ends the session for everyone: only the host has the
    // world, so promoting a client would hand them an empty arena.
    const hostLeft = room.hostId === conn.id;
    for (const peer of room.peers.values()) {
      peer.send({ t: 'peerLeft', id: conn.id, hostLeft });
    }
    if (hostLeft) {
      for (const peer of [...room.peers.values()]) peer.close();
      this.rooms.delete(room.code);
    }
  }
}
