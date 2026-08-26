import * as THREE from 'three';
import { NetSession, defaultRelayUrl } from './session.js';
import { RemotePlayer } from './remotePlayer.js';
import { clamp01 } from '../core/mathx.js';
import { COOP } from '../core/config.js';
import { itemById } from '../data/items.js';
import { characterById } from '../data/characters.js';

const _v = new THREE.Vector3();

/**
 * Co-op: the bridge between the relay and the running game.
 *
 * ## Who decides what
 *
 * The host owns the world — arena seed, enemies, bosses, the director, chests
 * and the beacon. Everyone owns themselves: your position, your items, your
 * gold, your level and your lizards are simulated on your own machine and only
 * ever described to everyone else. Nothing about your movement waits on a round
 * trip, which is the whole point; friends playing over a home connection should
 * not feel their own character lag.
 *
 * Damage runs the same way in both directions. When you shoot something you
 * resolve the hit locally against your copy of that enemy — your crit, your
 * items, your damage numbers, immediately — and then tell the host the number.
 * The host applies it to the real enemy and its health comes back in the next
 * snapshot. When something hits *you*, the host does not decide what it costs:
 * it forwards the raw damage and your machine applies your armour, your barrier
 * and your items to it. Each player's build is only ever evaluated where that
 * build actually lives.
 *
 * This trusts the other players completely. That is a deliberate choice for a
 * game you host for friends off a code you read out loud — there is no ladder
 * to protect and no stranger to keep out.
 */
export class Coop {
  constructor(game) {
    this.game = game;
    this.session = new NetSession();
    this.remotes = new Map();       // peerId -> RemotePlayer
    this.dropById = new Map();      // dropId -> pickup entry
    this.pendingDamage = new Map(); // netId -> accumulated damage (clients)
    this.lobbyProfiles = new Map(); // peerId -> { character, weapon, name }

    this.stateTimer = 0;
    this.snapTimer = 0;
    this.petTimer = 0;
    this.damageTimer = 0;
    this.nextDropId = 1;
    this.reviveProgress = 0;
    this.runStarted = false;

    this.onLobbyChange = null;      // UI hook
    this.onFatal = null;

    this.session.onRoster = () => this.onLobbyChange?.();
    this.session.onStatus = () => this.onLobbyChange?.();
    this.session.onFatal = (msg) => {
      this._teardownRemotes();
      this.onFatal?.(msg);
    };
    this._bind();
  }

  get active() { return this.session.active; }
  get isHost() { return this.session.isHost; }
  get isClient() { return this.session.isClient; }
  get code() { return this.session.code; }

  /** Everything the enemy AI is allowed to chase. */
  party() {
    const out = [];
    const p = this.game.player;
    if (p && !p.dead) out.push(p);
    for (const r of this.remotes.values()) if (!r.dead) out.push(r);
    return out;
  }

  /* ==================================================================== lobby */
  async host(name, url = defaultRelayUrl()) {
    await this.session.connect({ url, name, profile: this._selfProfile() });
    this._announceProfile();
    return this.session.code;
  }

  async join(code, name, url = defaultRelayUrl()) {
    await this.session.connect({ url, name, code, profile: this._selfProfile() });
    this._announceProfile();
    return this.session.code;
  }

  leave() {
    this.session.disconnect();
    this._teardownRemotes();
    this.runStarted = false;
    this.onLobbyChange?.();
  }

  _selfProfile() {
    const d = this.game.profile.data;
    return { character: d.equippedCharacter, weapon: d.equippedWeapon };
  }

  /** Tells the lobby what you are bringing, so the roster cards stay honest. */
  _announceProfile() {
    if (!this.active) return;
    const p = this._selfProfile();
    this.session.selfProfile = p;
    this.session.send({ k: 'prof', ...p, name: this.session.selfName });
    this.onLobbyChange?.();
  }

  announceLoadout() { this._announceProfile(); }

  lobbyList() {
    return this.session.roster().map((r) => ({
      ...r,
      ...(this.lobbyProfiles.get(r.id) || {}),
      host: r.id === this.session.hostId,
    }));
  }

  /* ================================================================= run start */
  startRun() {
    if (!this.isHost) return;
    this.runStarted = true;
    this.session.status = 'ingame';
    this.session.send({ k: 'start', mode: this.game.profile.data.runMode });
    this.game.startRun();
  }

  /* ==================================================================== wiring */
  _bind() {
    const s = this.session;

    s.on('prof', (m, from) => {
      this.lobbyProfiles.set(from, { character: m.character, weapon: m.weapon, name: m.name });
      const peer = s.peers.get(from);
      if (peer) { peer.character = m.character; peer.weapon = m.weapon; if (m.name) peer.name = m.name; }
      const remote = this.remotes.get(from);
      if (remote) { remote.setCharacter(m.character); remote.setWeapon(m.weapon); }
      this.onLobbyChange?.();
    });

    s.on('peerJoined', (m) => {
      // Bring the newcomer up to speed on who you are; the host also has to
      // hand them the run they are dropping into. The `start` matters as much
      // as the stage does — it was broadcast before they connected, so without
      // it they sit in the lobby holding an arena they never entered.
      this._announceProfile();
      this.game.chat?.system(`${this.nameOf(m?.id)} joined the descent`, '#46e0c0');
      if (this.isHost && this.runStarted) this._sendWorldTo(m.id);
    });

    s.on('peerLeft', (m) => {
      const remote = this.remotes.get(m.id);
      if (remote) { remote.dispose(); this.remotes.delete(m.id); }
      this.game.pets?.dropPeer(m.id);
      this.game.chat?.system(`${this.nameOf(m.id)} left the descent`, '#7d89a3');
      this.lobbyProfiles.delete(m.id);
      this.game.hud?.toast('A descender disconnected', '#7d89a3');
    });

    s.on('start', (m) => {
      if (this.isHost) return;
      this.runStarted = true;
      this.session.status = 'ingame';
      this.game.startRun({ coopClient: true, mode: m.mode });
    });

    /* ---------------- world state, host → clients ---------------- */
    s.on('stage', (m) => {
      if (this.isHost) return;
      // Joining mid-run, `start` and the stage arrive back to back and the
      // stage can land first on a client that has not entered the run yet — on
      // which it would have no player, no managers and nothing to build onto.
      // Enter the run first. The guard is `runStarted`, not the packet itself:
      // a stray stage after the run has ended must not drag anyone back in.
      if (this.runStarted && this.game.state !== 'running') {
        this.session.status = 'ingame';
        this.game.startRun({ coopClient: true, mode: m.mode });
      }
      this.stageWait = 0;
      this.game.applyStagePacket(m);
    });
    s.on('snap', (m) => { if (!this.isHost) this._applySnapshot(m); });
    s.on('espawn', (m) => { if (!this.isHost) this._spawnGhost(m); });
    s.on('edeath', (m) => { if (!this.isHost) this._applyEnemyDeath(m); });
    s.on('eshot', (m) => { if (!this.isHost) this.game.spawnEnemyProjectileRaw(m.s); });
    s.on('hazard', (m) => { if (!this.isHost) this.game.projectiles.spawnHazard(_v.set(m.x, m.y, m.z), m.o); });
    s.on('drop', (m) => { if (!this.isHost) this._applyDrop(m); });
    s.on('take', (m) => this._applyTake(m));
    s.on('chest', (m) => { if (!this.isHost) this.game.applyChestState(m.i, m.o, m.c); });
    s.on('egg', (m) => { if (!this.isHost) this.game.applyEggState(m.i); });
    s.on('tp', (m) => { if (!this.isHost) this.game.applyTeleporterState(m); });
    s.on('portal', (m) => { if (!this.isHost) this.game.applyPortalState(m); });
    s.on('win', () => { if (!this.isHost) this.game.applyVictory(); });
    s.on('over', () => {
      if (this.isHost) return;
      // The run is finished, so nothing that arrives late reopens it.
      this.runStarted = false;
      this.game.finishCoopRun();
    });
    s.on('fx', (m) => this._applyFx(m));

    /* ---------------- per-peer state, everyone → everyone ---------------- */
    s.on('p', (m, from) => {
      const remote = this._remote(from);
      if (remote) remote.applyState(m);
    });
    s.on('mins', (m, from) => this.game.applyRemotePets(from, m.l, this._remote(from)));
    s.on('shot', (m, from) => {
      this._remote(from)?.onShot();
      this.game.spawnRemoteShot(m);
    });

    s.on('chat', (m, from) => {
      const who = this.nameOf(from);
      this.game.chat.chat(who, String(m.t ?? '').slice(0, 140), this.colorOf(from));
    });
    s.on('got', (m, from) => {
      const item = itemById(m.i);
      if (item) this.game.chat.itemPickup(this.nameOf(from), item, false);
    });
    s.on('boon', (m) => { if (!this.isHost) this.game.applyBoon(m); });

    /* ---------------- commands, clients → host ---------------- */
    // "I do not have the world you think I have." Cheap to answer and the only
    // recovery there is for a stage packet that was dropped on the way out.
    s.on('need', (m, from) => { if (this.isHost && this.runStarted) this._sendWorldTo(from); });
    s.on('dmg', (m, from) => { if (this.isHost) this._applyRemoteDamage(m, from); });
    s.on('act', (m, from) => { if (this.isHost) this.game.applyRemoteAct(m, from); });
    s.on('pick', (m, from) => { if (this.isHost) this.game.applyRemotePickup(m.id, from); });

    /* ---------------- targeted, host → one peer ---------------- */
    s.on('hurt', (m) => {
      const p = this.game.player;
      if (!p || p.dead) return;
      p.takeDamage(m.a, { source: m.s });
    });
    s.on('push', (m) => this.game.player?.applyImpulse(_v.set(m.x, m.y, m.z).clone()));
    s.on('status', (m) => this.game.player?.applyStatus(m.id, m.d, m.data || {}));
  }

  _remote(id) {
    let remote = this.remotes.get(id);
    if (remote) return remote;
    if (!this.game.arena) return null;      // not in a run yet
    const peer = this.session.peers.get(id);
    const prof = this.lobbyProfiles.get(id) || {};
    remote = new RemotePlayer(this.game, {
      id,
      name: prof.name || peer?.name || 'Descender',
      character: prof.character || peer?.character,
      weapon: prof.weapon || peer?.weapon,
    });
    this.remotes.set(id, remote);
    return remote;
  }

  _teardownRemotes() {
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    this.dropById.clear();
  }

  /* ==================================================================== frame */
  update(dt) {
    if (!this.active || !this.game.player) return;

    for (const r of this.remotes.values()) r.update(dt);

    // Standing on the placeholder arena, our position means nothing to anyone
    // else — sending it is what puts a teammate in the ground. Stay quiet, and
    // chase the host if the stage is taking too long to turn up.
    if (this.game.stagePending) {
      this.stageWait = (this.stageWait ?? 0) + dt;
      if (this.stageWait >= COOP.stageResendDelay) this.requestStage();
      return;
    }
    this.stageWait = COOP.stageResendDelay;

    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      this.stateTimer = COOP.stateInterval;
      this.session.send(this._statePacket());
    }

    this.petTimer -= dt;
    if (this.petTimer <= 0) {
      this.petTimer = COOP.petInterval;
      const mine = this.game.pets.ownedBy(this.game.player);
      if (mine.length) {
        this.session.send({
          k: 'mins',
          l: mine.map((m) => [
            m.slot, r2(m.position.x), r2(m.position.y), r2(m.position.z), r2(m.yaw),
            m.alive ? 1 : 0, m.accent, m._trophies || 0, m.species,
          ]),
        });
      }
    }

    if (this.isHost) {
      this.snapTimer -= dt;
      if (this.snapTimer <= 0) {
        this.snapTimer = COOP.snapInterval;
        this.session.send(this._snapshotPacket());
      }
      this._checkPartyWipe();
    } else {
      this.damageTimer -= dt;
      if (this.damageTimer <= 0 && this.pendingDamage.size) {
        this.damageTimer = COOP.damageInterval;
        const list = [];
        for (const [id, amount] of this.pendingDamage) list.push([id, Math.round(amount * 10) / 10]);
        this.pendingDamage.clear();
        this.session.sendHost({ k: 'dmg', l: list });
      }
    }

    this._tickRevive(dt);
  }

  /* ------------------------------------------------------------ own state */
  _statePacket() {
    const p = this.game.player;
    const rig = p.rig;
    const flags = (p.grounded ? 1 : 0) | (p.aiming ? 2 : 0)
      | (this.game.combat?.firing ? 4 : 0) | ((rig?.ready ?? 0) > 0.5 ? 8 : 0)
      | (p.dead ? 16 : 0);
    return {
      k: 'p',
      x: r2(p.position.x), y: r2(p.position.y), z: r2(p.position.z),
      yaw: r2(p.yaw), pitch: r2(p.pitch),
      vx: r2(p.velocity.x), vy: r2(p.velocity.y), vz: r2(p.velocity.z),
      hp: Math.round(p.health), mhp: Math.round(p.stats.maxHealth),
      ms: r2(p.stats.moveSpeed),
      lvl: p.level, it: this.game.inventory.totalItems,
      rv: p.dead ? Math.round(this.reviveProgress * 100) : 0,
      f: flags,
    };
  }

  /* ------------------------------------------------------------ host → all */
  _snapshotPacket() {
    const enemies = [];
    for (const e of this.game.enemies.list) {
      if (e.dead || !e.netId) continue;
      enemies.push([
        e.netId,
        r2(e.position.x), r2(e.position.y), r2(e.position.z),
        r2(e.yaw), Math.max(0, Math.round(e.health)),
        e.state === 'windup' ? 1 : 0,
        // Mid-shed the boss is untouchable. Replicated so a client's predicted
        // damage does not sail through a phase change the host is ignoring.
        e.shellTimer > 0 ? 1 : 0,
      ]);
    }
    const tp = this.game.teleporter;
    return {
      k: 'snap',
      d: r2(this.game.director.difficulty),
      t: r2(this.game.run.time),
      e: enemies,
      tp: tp ? [tp.state, r2(tp.charge)] : null,
    };
  }

  _spawnPacket(e) {
    return {
      k: 'espawn', id: e.netId, def: e.def.id,
      x: r2(e.position.x), y: r2(e.position.y), z: r2(e.position.z),
      hp: Math.round(e.health), mhp: Math.round(e.maxHealth),
      el: e.elite?.id || null, boss: !!e.boss,
    };
  }

  _stagePacket() { return this.game.buildStagePacket(); }

  /** Everything one peer needs to be standing in the same world as everyone else. */
  _sendWorldTo(id) {
    if (!this.isHost || !this.game.arena) return;
    this.session.sendTo(id, { k: 'start', mode: this.game.run.mode });
    this.session.sendTo(id, this._stagePacket());
    for (const e of this.game.enemies.list) this.session.sendTo(id, this._spawnPacket(e));
  }

  /**
   * Asks the host to describe the world again.
   *
   * Called when the stage packet never arrived, or arrived and did not build
   * the ground the host says it should have. Rate-limited, because the honest
   * failure case is a host that cannot answer and there is no sense flooding it.
   */
  requestStage(force = false) {
    if (!this.isClient) return;
    if (!force && this.stageWait !== undefined && this.stageWait < COOP.stageResendDelay) return;
    this.stageWait = 0;
    this.session.sendHost({ k: 'need' });
  }

  /** Everyone at the table, standing or downed — what boss loot is counted against. */
  partySize() {
    if (!this.active) return 1;
    return Math.max(1, this.session.peerCount);
  }

  /** Host → all: a Shrine of Ruin was paid for, so the whole party sees the deal. */
  onBoon(items, bosses) {
    if (!this.isHost) return;
    this.session.send({ k: 'boon', items, bosses });
  }

  onStageBuilt() { if (this.isHost) this.session.send(this._stagePacket()); }

  onEnemySpawned(e) { if (this.isHost) this.session.send(this._spawnPacket(e)); }

  onEnemyDeath(e, rewards) {
    if (!this.isHost || !e.netId) return;
    this.session.send({
      k: 'edeath', id: e.netId,
      x: r2(e.position.x), y: r2(e.position.y), z: r2(e.position.z),
      g: Math.round(rewards.gold), xp: Math.round(rewards.xp), s: rewards.silent ? 1 : 0,
    });
  }

  onEnemyProjectile(spec) { if (this.isHost) this.session.send({ k: 'eshot', s: spec }); }

  onHazard(position, opts) {
    if (!this.isHost) return;
    this.session.send({ k: 'hazard', x: r2(position.x), y: r2(position.y), z: r2(position.z), o: opts });
  }

  onItemDrop(entry, itemId) {
    if (!this.isHost) return null;
    const id = this.nextDropId++;
    entry.netId = id;
    // The pickup manager has to know the id too, or the host cannot arbitrate a
    // claim against its own drop.
    this.game.pickups.byNetId.set(id, entry);
    this.dropById.set(id, entry);
    this.session.send({
      k: 'drop', id, item: itemId,
      x: r2(entry.mesh.position.x), y: r2(entry.mesh.position.y), z: r2(entry.mesh.position.z),
    });
    return id;
  }

  onChestState(index, opened, cost) {
    if (!this.isHost) return;
    this.session.send({ k: 'chest', i: index, o: opened, c: cost });
  }

  onEggState(index) { if (this.isHost) this.session.send({ k: 'egg', i: index }); }

  onTeleporterState() {
    if (!this.isHost) return;
    const tp = this.game.teleporter;
    if (tp) this.session.send({ k: 'tp', state: tp.state, charge: r2(tp.charge) });
  }

  onPetHatched() { /* covered by the pet state stream */ }

  onRunOver() {
    if (!this.isHost) return;
    this.runStarted = false;
    this.session.send({ k: 'over' });
  }

  onPortalState() {
    if (!this.isHost || !this.game.portal) return;
    const p = this.game.portal.position;
    this.session.send({ k: 'portal', x: r2(p.x), y: r2(p.y), z: r2(p.z) });
  }

  onVictory() { if (this.isHost) this.session.send({ k: 'win' }); }

  /** Display name for a peer, falling back through everything we might know. */
  nameOf(id) {
    return this.lobbyProfiles.get(id)?.name
      || this.session.peers.get(id)?.name
      || 'Descender';
  }

  /** A peer's character accent, so the log colour-codes who is talking. */
  colorOf(id) {
    const charId = this.lobbyProfiles.get(id)?.character
      || this.session.peers.get(id)?.character;
    const accent = characterById(charId)?.accent ?? 0xdfe6f5;
    return `#${accent.toString(16).padStart(6, '0')}`;
  }

  sendChat(text) {
    if (!this.active) return;
    this.session.send({ k: 'chat', t: String(text).slice(0, 140) });
  }

  announcePickup(itemId) {
    if (!this.active) return;
    this.session.send({ k: 'got', i: itemId });
  }

  /** Fires whenever the local player shoots, so teammates see tracers. */
  onLocalShot(payload) {
    if (!this.active) return;
    this.session.send({ k: 'shot', ...payload });
  }

  onFx(payload) { if (this.active) this.session.send({ k: 'fx', ...payload }); }

  /* -------------------------------------------------- damage in both directions */
  /** A client dealt damage: predict locally, tell the host the number. */
  reportDamage(enemy, amount) {
    if (!this.isClient || !enemy?.netId || amount <= 0) return;
    this.pendingDamage.set(enemy.netId, (this.pendingDamage.get(enemy.netId) || 0) + amount);
  }

  _applyRemoteDamage(m, from) {
    for (const [netId, amount] of m.l) {
      const enemy = this.game.enemies.byNetId.get(netId);
      if (!enemy || enemy.dead) continue;
      // Already crit-rolled and item-modified on the shooter's machine; the
      // host only applies enemy-side mitigation and decides death.
      enemy.takeDamage(amount, { source: 'Ally', netFrom: from, quiet: true });
    }
  }

  hurtPeer(id, amount, source) {
    this.session.sendTo(id, { k: 'hurt', a: Math.round(amount * 10) / 10, s: source });
  }

  pushPeer(id, vec) {
    this.session.sendTo(id, { k: 'push', x: r2(vec.x), y: r2(vec.y), z: r2(vec.z) });
  }

  statusPeer(id, statusId, duration, data) {
    this.session.sendTo(id, { k: 'status', id: statusId, d: duration, data });
  }

  /* -------------------------------------------------------------- client side */
  _applySnapshot(m) {
    this.game.applyDirectorSnapshot(m.d, m.t);
    const seen = new Set();
    for (const row of m.e) {
      const [netId, x, y, z, yaw, hp, windup, shed] = row;
      seen.add(netId);
      const e = this.game.enemies.byNetId.get(netId);
      if (!e) continue;
      e.netFrom.copy(e.position);
      e.netTarget.set(x, y, z);
      e.netYaw = yaw;
      e.netBlend = 0;
      e.health = Math.max(1, hp);
      e.state = windup ? 'windup' : 'chase';
      /* Safe to assign outright: a ghost runs no AI (see `Enemy.update`), so
         nothing on this machine maintains a ward of its own and the host is the
         only authority on one. */
      e.shellTimer = shed ? 1 : 0;
      e.ward = shed ? 1 : 0;
    }
    // Anything the host has stopped reporting is gone; drop it quietly rather
    // than leaving a statue in the arena.
    for (const [netId, e] of this.game.enemies.byNetId) {
      if (seen.has(netId)) continue;
      e.netMissing = (e.netMissing || 0) + 1;
      if (e.netMissing > 3) { e.dead = true; e.silentRemoval = true; }
    }
    if (m.tp) this.game.applyTeleporterState({ state: m.tp[0], charge: m.tp[1] });
  }

  _spawnGhost(m) {
    this.game.enemies.spawnGhost(m.def, m.id, _v.set(m.x, m.y, m.z), {
      elite: m.el, health: m.hp, maxHealth: m.mhp,
    });
  }

  _applyEnemyDeath(m) {
    const e = this.game.enemies.byNetId.get(m.id);
    if (!e || e.dead) return;
    this.game.resolveEnemyDeath(e, { silent: !!m.s }, { gold: m.g, xp: m.xp });
    e.dead = true;
    e.silentRemoval = true;
  }

  _applyDrop(m) {
    const entry = this.game.spawnNetItemDrop(m.item, _v.set(m.x, m.y, m.z), m.id);
    if (entry) this.dropById.set(m.id, entry);
  }

  _applyTake(m) {
    this.dropById.delete(m.id);
    // Whoever asked first wins. If that was you, the item is yours now; if it
    // was not, the drop simply disappears from under your feet.
    if (m.by === this.session.id) this.game.claimNetDrop(m.id);
    else this.game.removeNetDrop(m.id);
  }

  _applyFx(m) {
    const fx = this.game.fx;
    if (m.f === 'beam') fx.beam(_v.set(m.x, m.y, m.z).clone(), new THREE.Vector3(m.x2, m.y2, m.z2), m.c, 0.09, 0.035);
    else if (m.f === 'muzzle') fx.muzzle(_v.set(m.x, m.y, m.z), new THREE.Vector3(m.dx, m.dy, m.dz), m.c, 1);
    else if (m.f === 'explosion') fx.explosion(_v.set(m.x, m.y, m.z).clone(), m.r, m.c, 1);
  }

  /* ------------------------------------------------------------------ revive */
  /**
   * The downed player runs their own revive timer.
   *
   * They already know where everybody is, so nobody has to send anything: if a
   * living teammate is standing over you, the clock ticks. That also means the
   * bar you are watching is your own machine's, not a number relayed twice.
   */
  _tickRevive(dt) {
    const p = this.game.player;
    if (!p) return;
    if (!p.dead) { this.reviveProgress = 0; return; }

    let helper = false;
    for (const r of this.remotes.values()) {
      if (r.dead) continue;
      if (r.position.distanceTo(p.position) < COOP.reviveRadius) { helper = true; break; }
    }
    if (helper) {
      this.reviveProgress = clamp01(this.reviveProgress + dt / COOP.reviveTime);
      if (this.game.frame % 6 === 0) {
        this.game.fx.ring(p.position, 0.6, 2.2 * this.reviveProgress + 0.4, 0x4be08a, 0.3, 0.5);
      }
      if (this.reviveProgress >= 1) {
        this.reviveProgress = 0;
        this.game.revivePlayer(COOP.reviveHealth);
      }
    } else {
      this.reviveProgress = Math.max(0, this.reviveProgress - dt * 0.35);
    }
  }

  /** Progress a teammate is making on their own revival, for their nameplate. */
  reviveOf(remoteId) {
    const peer = this.remotes.get(remoteId);
    return peer?.reviveProgress ?? 0;
  }

  _checkPartyWipe() {
    if (!this.isHost || !this.game.player) return;
    if (!this.game.player.dead) return;
    for (const r of this.remotes.values()) if (!r.dead) return;
    if (this._wipeSent) return;
    this._wipeSent = true;
    this.onRunOver();
    this.game.finishCoopRun();
  }

  onRunStart() {
    this._wipeSent = false;
    this.reviveProgress = 0;
    this.pendingDamage.clear();
    this.dropById.clear();
    this.nextDropId = 1;
    this.stageWait = 0;
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
