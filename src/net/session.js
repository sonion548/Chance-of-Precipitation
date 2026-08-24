/**
 * Transport for co-op: one WebSocket to the relay, a roster, and a dispatcher.
 *
 * Deliberately knows nothing about the game. It hands out `send`, `sendTo` and
 * `on`, tracks who is in the lobby and who the host is, and stays out of the
 * way. All the game-specific traffic lives in `net/coop.js`.
 */

const CONNECT_TIMEOUT = 8000;

export class NetSession {
  constructor() {
    this.socket = null;
    this.id = null;
    this.hostId = null;
    this.code = null;
    this.peers = new Map();       // id -> { id, name, character, weapon, ready }
    this.handlers = new Map();    // kind -> Set<fn>
    this.status = 'offline';      // offline | connecting | lobby | ingame
    this.onRoster = null;
    this.onStatus = null;
    this.onFatal = null;
    this.lastError = null;
  }

  get active() { return this.status === 'lobby' || this.status === 'ingame'; }
  get isHost() { return this.active && this.id !== null && this.id === this.hostId; }
  get isClient() { return this.active && this.id !== null && this.id !== this.hostId; }
  get peerCount() { return this.peers.size + (this.id === null ? 0 : 1); }

  /** Everyone in the lobby including you, host first, then join order. */
  roster() {
    const list = [{ id: this.id, name: this.selfName, self: true, ...(this.selfProfile || {}) }];
    for (const p of this.peers.values()) list.push({ ...p, self: false });
    list.sort((a, b) => (a.id === this.hostId ? -1 : b.id === this.hostId ? 1 : a.id - b.id));
    return list;
  }

  /**
   * Opens the socket and joins (or creates) a room.
   * `code` omitted means "make me a new lobby and put me in charge".
   */
  connect({ url, name, code = null, profile = {} }) {
    this.disconnect();
    this.selfName = name;
    this.selfProfile = profile;
    this.status = 'connecting';
    this.lastError = null;
    this._emitStatus();

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        this.lastError = message;
        this.status = 'offline';
        this._emitStatus();
        try { this.socket?.close(); } catch { /* already gone */ }
        this.socket = null;
        reject(new Error(message));
      };

      let socket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        fail(`Could not reach ${url} — ${err.message}`);
        return;
      }
      this.socket = socket;
      const timer = setTimeout(() => fail('The lobby server did not answer.'), CONNECT_TIMEOUT);

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ t: 'hello', name, code: code || undefined }));
      });

      socket.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.t === 'welcome') {
          clearTimeout(timer);
          settled = true;
          this.id = msg.id;
          this.hostId = msg.hostId;
          this.code = msg.code;
          this.peers.clear();
          for (const p of msg.peers) this.peers.set(p.id, { ...p, ready: false });
          this.status = 'lobby';
          this._emitStatus();
          this._emitRoster();
          resolve(this);
          return;
        }
        if (msg.t === 'error') { clearTimeout(timer); fail(msg.message || 'The lobby refused the connection.'); return; }
        if (msg.t === 'peerJoined') {
          this.peers.set(msg.id, { id: msg.id, name: msg.name, ready: false });
          this._emitRoster();
          this._dispatch('peerJoined', { id: msg.id, name: msg.name }, msg.id);
          return;
        }
        if (msg.t === 'peerLeft') {
          this.peers.delete(msg.id);
          this._emitRoster();
          this._dispatch('peerLeft', { id: msg.id, hostLeft: msg.hostLeft }, msg.id);
          if (msg.hostLeft) this._fatal('The host left the game.');
          return;
        }
        if (msg.t === 'msg' && msg.m) this._dispatch(msg.m.k, msg.m, msg.from);
      });

      socket.addEventListener('close', () => {
        clearTimeout(timer);
        if (!settled) { fail('The connection closed before the lobby answered.'); return; }
        if (this.status !== 'offline') this._fatal(this.lastError || 'Disconnected from the lobby.');
      });
      socket.addEventListener('error', () => {
        if (!settled) fail(`Could not reach ${url}. Is the host's server running?`);
      });
    });
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.status = 'offline';
    this.id = null;
    this.hostId = null;
    this.code = null;
    this.peers.clear();
    if (socket && socket.readyState <= 1) {
      try { socket.send(JSON.stringify({ t: 'bye' })); } catch { /* already gone */ }
      try { socket.close(); } catch { /* already gone */ }
    }
  }

  _fatal(message) {
    if (this.status === 'offline') return;
    this.status = 'offline';
    this.lastError = message;
    this._emitStatus();
    this.onFatal?.(message);
  }

  // ------------------------------------------------------------------ send
  send(m) {
    if (!this.socket || this.socket.readyState !== 1) return;
    this.socket.send(JSON.stringify({ t: 'all', m }));
  }

  sendTo(id, m) {
    if (!this.socket || this.socket.readyState !== 1) return;
    this.socket.send(JSON.stringify({ t: 'to', id, m }));
  }

  /** Convenience: clients talk to the host far more than to each other. */
  sendHost(m) {
    if (this.hostId === null || this.hostId === this.id) return;
    this.sendTo(this.hostId, m);
  }

  // ------------------------------------------------------------------ receive
  on(kind, fn) {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  _dispatch(kind, m, from) {
    const set = this.handlers.get(kind);
    if (!set) return;
    for (const fn of set) {
      try { fn(m, from); }
      catch (err) { console.error(`Net handler "${kind}" failed`, err); }
    }
  }

  _emitRoster() { this.onRoster?.(this.roster()); }
  _emitStatus() { this.onStatus?.(this.status); }
}

/** Default relay URL: the same host and port the page came from. */
export function defaultRelayUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.host || 'localhost:8080';
  return `${proto}//${host}/net`;
}
