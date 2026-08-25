import * as THREE from 'three';
import { MINIONS } from '../core/config.js';
import { clamp01, damp, angleLerp } from '../core/mathx.js';
import { moveWithCollision, raycastWorld } from '../systems/physics.js';
import { buildMinionModel } from './models.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * A brood lizard: a bought, permanent ally that fights with your build.
 *
 * "Inherits your items" is meant literally rather than cosmetically. A lizard
 * has no stats of its own — every number it uses is derived from its owner's
 * *current* stats, so a Stim Injector speeds its breath up and a Bitterroot
 * makes it tougher, with no per-item plumbing. More importantly its fireballs
 * are resolved through `Combat.damageEnemy` like any other source of player
 * damage, which means your crit chance, your damage modifiers, your lifesteal
 * and every on-hit proc you own all fire off its hits too. The proc coefficient
 * is deliberately below 1 so a pack of lizards cannot out-proc your own gun.
 *
 * They cannot die permanently. Dropping one to zero curls it back into an egg
 * for a few seconds — losing a purchase you made three stages ago to one stray
 * mortar would make buying them a trap rather than a choice.
 */
export class Minion {
  constructor(game, owner, opts = {}) {
    this.game = game;
    this.owner = owner;
    this.slot = opts.slot ?? 0;
    this.netId = opts.netId ?? null;

    this.position = (opts.position || owner.position).clone();
    this.velocity = new THREE.Vector3();
    this.radius = 0.34;
    this.height = 0.72;
    this.yaw = owner.rig?.modelYaw ?? 0;
    this.grounded = false;

    this.attackTimer = 0.6 + this.slot * 0.22;
    this.windup = 0;
    this.state = 'follow';        // follow | attack | dormant
    this.dormantTimer = 0;
    this.hitFlash = 0;
    this.walkPhase = Math.random() * 10;
    this.jawOpen = 0;
    this.target = null;
    this.retargetTimer = 0;
    this.spawnAnim = 1;
    this.remote = !!opts.remote;
    this.netTarget = this.position.clone();
    this.netYaw = this.yaw;

    this.health = this.maxHealth;

    this.model = buildMinionModel({
      color: opts.color ?? 0x5f7a4a,
      accent: opts.accent ?? (owner.char?.accent ?? 0xff8a3d),
      trophies: opts.trophies ?? 0,
    });
    this.model.position.copy(this.position);
    this.model.scale.setScalar(0.01);
    game.engine.scene.add(this.model);

    this.baseMaterials = [];
    this.model.traverse((c) => {
      if (c.material && c.material.color) this.baseMaterials.push({ mat: c.material, color: c.material.color.clone() });
    });
  }

  /* ---------------------------------------------------------- inherited stats */
  get ownerStats() { return this.owner?.stats || {}; }
  get maxHealth() {
    return Math.max(20, (this.ownerStats.maxHealth ?? 100) * MINIONS.health
      * (this.ownerStats.minionHealthMult ?? 1));
  }
  get damage() {
    return (this.ownerStats.damage ?? 10) * MINIONS.damage * (this.ownerStats.minionDamageMult ?? 1);
  }
  get speed() { return (this.ownerStats.moveSpeed ?? 8) * MINIONS.speed; }
  get fireInterval() { return MINIONS.attackCooldown / Math.max(0.2, this.ownerStats.attackSpeed ?? 1); }
  get center() { return _v2.set(this.position.x, this.position.y + 0.45, this.position.z); }
  get alive() { return this.state !== 'dormant'; }

  /** Where this lizard should stand relative to its owner: a ring slot behind them. */
  _anchor(out) {
    const o = this.owner;
    const yaw = (o.rig?.modelYaw ?? o.yaw ?? 0) + Math.PI;
    const spread = ((this.slot % 2) * 2 - 1) * (0.6 + Math.floor(this.slot / 2) * 0.55);
    const a = yaw + spread;
    return out.set(
      o.position.x + Math.sin(a) * MINIONS.followRadius,
      o.position.y,
      o.position.z + Math.cos(a) * MINIONS.followRadius,
    );
  }

  takeDamage(amount, opts = {}) {
    if (!this.alive || amount <= 0) return 0;
    this.health -= amount;
    this.hitFlash = 1;
    this.game.ui.damageNumber(this.center, amount, false);
    if (this.health <= 0) this._collapse(opts);
    return amount;
  }

  _collapse() {
    this.state = 'dormant';
    this.dormantTimer = MINIONS.reviveTime;
    this.health = 0;
    this.game.fx.explosion(this.center, 2.2, this.model.userData.accent, 0.7);
    this.game.fx.burst(this.center, 10, { color: 0xe6dfc8, speed: 6, size: 0.16, life: 0.6 });
    this.game.ui.toast('A brood lizard went down', '#ff8a3d');
    this.game.inventory?.trigger('onMinionDown', { minion: this });
  }

  revive(atOwner = true) {
    this.state = 'follow';
    this.health = this.maxHealth;
    this.dormantTimer = 0;
    this.spawnAnim = 1;
    if (atOwner && this.owner) {
      this._anchor(_v);
      this.position.copy(_v);
      this.position.y = this.game.arena?.groundHeightAt(_v.x, _v.z) ?? _v.y;
    }
    this.game.fx.ring(this.position, 0.4, 2.4, this.model.userData.accent, 0.4, 0.8);
  }

  // ------------------------------------------------------------------ frame
  update(dt, world) {
    const owner = this.owner;
    if (!owner) return;

    this.hitFlash = Math.max(0, this.hitFlash - dt * 4.5);
    if (this.spawnAnim > 0) {
      this.spawnAnim = Math.max(0, this.spawnAnim - dt * 2.6);
      const s = 1 - this.spawnAnim * this.spawnAnim;
      this.model.scale.setScalar(Math.max(0.01, s));
    }

    if (this.state === 'dormant') {
      this.dormantTimer -= dt;
      this._updateDormant(dt, world);
      if (this.dormantTimer <= 0) this.revive();
      return;
    }

    // Out-of-combat regeneration, so a bad fight is not permanent.
    if (this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + this.maxHealth * MINIONS.regen * dt);
    }

    this._retarget(dt, world);
    this._move(dt, world);
    this._shoot(dt, world);
    this._physics(dt, world);
    this._updateModel(dt);
  }

  _retarget(dt, world) {
    this.retargetTimer -= dt;
    if (this.target && (this.target.dead || this.target.position.distanceTo(this.position) > MINIONS.attackRange * 1.3)) {
      this.target = null;
    }
    if (this.target || this.retargetTimer > 0) return;
    this.retargetTimer = 0.35;

    // Prefer what the owner is shooting at, then anything close to the owner.
    const candidates = this.game.enemies.inRadius(this.owner.position, MINIONS.attackRange);
    if (!candidates.length) { this.target = null; return; }
    let best = null;
    let bestScore = Infinity;
    for (const e of candidates) {
      if (e.spawnAnim > 0.6) continue;
      const d = e.position.distanceTo(this.position);
      // A little bias toward the owner's own aim so the pack focuses fire.
      _dir.copy(e.center).sub(this.owner.chestPosition).normalize();
      const aimAlign = _dir.dot(_v.copy(this.owner.aimPoint).sub(this.owner.chestPosition).normalize());
      const score = d - aimAlign * 9 - (e.boss ? 6 : 0) - (e.elite ? 4 : 0);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (best && this._hasLineOfSight(best, world)) this.target = best;
  }

  _hasLineOfSight(enemy, world) {
    const from = this.center.clone();
    from.y += 0.2;
    _dir.copy(enemy.center).sub(from);
    const dist = _dir.length();
    _dir.divideScalar(Math.max(dist, 0.001));
    const hit = raycastWorld(from, _dir, dist - 0.4, world);
    return !hit;
  }

  _move(dt, world) {
    const owner = this.owner;
    this._anchor(_v);
    let goal = _v;
    let speedMult = 1;

    const distToOwner = this.position.distanceTo(owner.position);
    if (distToOwner > MINIONS.leash) {
      // Snapped the leash — scurry back rather than pathing across the arena.
      this.position.copy(_v);
      this.position.y = world.groundHeightAt(_v.x, _v.z) + 0.1;
      this.game.fx.ring(this.position, 0.3, 2, this.model.userData.accent, 0.3, 0.6);
    }

    if (this.target) {
      const dt2 = this.target.position.distanceTo(this.position);
      if (dt2 < MINIONS.minRange) {
        // Too close to spit comfortably: back off along the line away from it.
        goal = _v2.copy(this.position).sub(this.target.position).setY(0).normalize()
          .multiplyScalar(MINIONS.minRange * 1.6).add(this.position);
        speedMult = 1.1;
      } else if (dt2 > MINIONS.attackRange * 0.8 || !this._hasLineOfSight(this.target, world)) {
        goal = this.target.position;
        speedMult = 1.15;
      } else {
        // In the pocket: hold the owner's flank instead of crowding the enemy.
        goal = _v;
        speedMult = 0.9;
      }
    }

    _dir.copy(goal).sub(this.position);
    _dir.y = 0;
    const d = _dir.length();
    const want = d < 1.1 ? 0 : Math.min(1, d / 4) * this.speed * speedMult;
    if (d > 0.001) _dir.divideScalar(d);

    // Sprint to catch up if it has fallen a long way behind.
    const catchUp = clamp01((distToOwner - MINIONS.followRadius * 1.6) / 10) * 0.8;
    this.velocity.x = damp(this.velocity.x, _dir.x * want * (1 + catchUp), 9, dt);
    this.velocity.z = damp(this.velocity.z, _dir.z * want * (1 + catchUp), 9, dt);

    // Face the target while it has one, otherwise face where it is going.
    const face = this.target
      ? Math.atan2(this.target.position.x - this.position.x, this.target.position.z - this.position.z)
      : (Math.hypot(this.velocity.x, this.velocity.z) > 0.6
        ? Math.atan2(this.velocity.x, this.velocity.z)
        : (this.owner.rig?.modelYaw ?? this.yaw));
    this.yaw = angleLerp(this.yaw, face, 1 - Math.exp(-9 * dt));
  }

  _shoot(dt, world) {
    this.attackTimer -= dt;
    if (this.windup > 0) {
      this.windup -= dt;
      if (this.windup <= 0) this._spit();
      return;
    }
    if (!this.target || this.attackTimer > 0) return;
    const d = this.target.position.distanceTo(this.position);
    if (d > MINIONS.attackRange || !this._hasLineOfSight(this.target, world)) return;
    this.attackTimer = this.fireInterval;
    this.windup = 0.28;
    this.state = 'attack';
    this.pendingShots = this.ownerStats.minionVolley ?? 0;
  }

  _spit() {
    const target = this.target;
    if (!target || target.dead) return;
    const ud = this.model.userData;
    const origin = new THREE.Vector3();
    (ud.maw || this.model).getWorldPosition(origin);

    _dir.copy(target.center).sub(origin);
    // Lead the shot a little; a lizard that always misses movers is just noise.
    _dir.addScaledVector(target.velocity, 0.12 * (_dir.length() / MINIONS.projectileSpeed));
    _dir.normalize();

    const dmg = this.damage;
    this.game.projectiles.spawn({
      position: origin,
      velocity: _dir.clone().multiplyScalar(MINIONS.projectileSpeed),
      damage: dmg,
      proc: MINIONS.proc,
      radius: 0.24,
      life: 3.2,
      color: ud.accent,
      gravity: -3,
      trail: 1.1,
      glow: 1.7,
      homingRadius: 14,
      homingStrength: 2.2,
      target,
      burn: { dps: (this.ownerStats.damage ?? 10) * MINIONS.burnDps, time: MINIONS.burnTime },
      // A splashing projectile detonates instead of resolving a direct hit, so
      // the splash is where the whole payload lives.
      splash: { radius: MINIONS.splashRadius, damage: dmg, proc: MINIONS.proc, color: ud.accent },
      source: 'Brood Lizard',
    });
    this.game.fx.muzzle(origin, _dir, ud.accent, 0.9);
    this.jawOpen = 1;
    // Volleys keep the jaw open and chamber the next round on a short beat.
    if (this.pendingShots > 0) { this.pendingShots--; this.windup = 0.14; return; }
    this.state = 'follow';
  }

  _physics(dt, world) {
    this.velocity.y += -34 * dt;
    _v.set(this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt);
    const res = moveWithCollision(this, _v, world, { stepHeight: 0.6 });
    this.grounded = res.grounded;
    if (this.grounded) this.velocity.y = 0;
  }

  /** Teammate's lizard: chase the transform they sent, animate as normal. */
  updateRemote(dt) {
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4.5);
    if (this.spawnAnim > 0) this.spawnAnim = Math.max(0, this.spawnAnim - dt * 2.6);
    const prevX = this.position.x;
    const prevZ = this.position.z;
    const k = 1 - Math.exp(-12 * dt);
    this.position.lerp(this.netTarget, k);
    this.yaw = angleLerp(this.yaw, this.netYaw, k);
    this.velocity.set((this.position.x - prevX) / Math.max(dt, 1e-4), 0, (this.position.z - prevZ) / Math.max(dt, 1e-4));
    if (this.state === 'dormant') {
      this.model.position.copy(this.position);
      this.model.scale.setScalar(0.55);
      this.model.rotation.y += dt * 0.6;
      return;
    }
    this.windup = 0;
    this._updateModel(dt);
  }

  _updateDormant(dt, world) {
    this.velocity.y += -34 * dt;
    _v.set(0, this.velocity.y * dt, 0);
    const res = moveWithCollision(this, _v, world, { stepHeight: 0.6 });
    if (res.grounded) this.velocity.y = 0;
    const m = this.model;
    m.position.copy(this.position);
    // Curl into a ball and pulse: unmistakably "coming back".
    const t = 1 - clamp01(this.dormantTimer / MINIONS.reviveTime);
    m.scale.setScalar(0.55 + Math.sin(this.game.time * 4) * 0.02 + t * 0.12);
    m.rotation.y += dt * 0.6;
    const ud = m.userData;
    if (ud.throat) ud.throat.material.opacity = 0.2 + t * 0.6;
    for (const key of ['legFL', 'legFR', 'legBL', 'legBR']) {
      if (ud[key]) ud[key].rotation.x = damp(ud[key].rotation.x, 1.5, 6, dt);
    }
  }

  _updateModel(dt) {
    const m = this.model;
    const ud = m.userData;
    m.position.copy(this.position);
    m.rotation.y = this.yaw;
    m.scale.setScalar(Math.max(0.01, 1 - this.spawnAnim * this.spawnAnim));

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const stride = clamp01(speed / Math.max(1, this.speed));
    this.walkPhase += dt * (3.4 + speed * 1.5);
    const ph = this.walkPhase;

    // Diagonal gait: front-left moves with back-right.
    const legPose = (leg, phase) => {
      if (!leg) return;
      leg.rotation.x = Math.sin(phase) * 0.85 * stride;
      const lower = leg.userData.lower;
      if (lower) lower.rotation.x = (0.15 + Math.max(0, -Math.cos(phase)) * 0.9) * stride;
    };
    legPose(ud.legFL, ph);
    legPose(ud.legBR, ph + 0.4);
    legPose(ud.legFR, ph + Math.PI);
    legPose(ud.legBL, ph + Math.PI + 0.4);

    // Body rolls and dips with the gait; spine and tail follow one wave down
    // the length of the animal, which is what makes a quadruped read as alive.
    if (ud.body) {
      ud.body.position.y = 0.42 + Math.abs(Math.sin(ph)) * 0.045 * stride;
      ud.body.rotation.z = Math.sin(ph) * 0.14 * stride;
      ud.body.rotation.y = Math.sin(ph) * 0.09 * stride;
      ud.body.rotation.x = -stride * 0.06;
    }
    const wave = (i) => Math.sin(this.game.time * 2.6 - i * 0.9 + ph * 0.5);
    if (ud.tail0) ud.tail0.rotation.y = wave(0) * (0.14 + stride * 0.22);
    if (ud.tail1) ud.tail1.rotation.y = wave(1) * (0.16 + stride * 0.26);
    if (ud.tail2) {
      ud.tail2.rotation.y = wave(2) * (0.18 + stride * 0.3);
      ud.tail2.rotation.x = Math.sin(this.game.time * 3.1) * 0.12;
    }
    if (ud.neck) {
      ud.neck.rotation.x = damp(ud.neck.rotation.x, -0.12 + (this.target ? -0.1 : 0.08) - stride * 0.1, 8, dt);
      ud.neck.rotation.y = damp(ud.neck.rotation.y, -Math.sin(ph) * 0.1 * stride, 10, dt);
    }
    if (ud.head) {
      ud.head.rotation.x = damp(ud.head.rotation.x, this.target ? 0.05 : Math.sin(this.game.time * 1.6) * 0.1, 8, dt);
      ud.head.rotation.y = damp(ud.head.rotation.y, this.target ? 0 : Math.sin(this.game.time * 0.9) * 0.35, 5, dt);
    }

    // Charge tell: throat and maw light up through the windup, jaw snaps open.
    const charge = this.windup > 0 ? 1 - clamp01(this.windup / 0.28) : 0;
    this.jawOpen = damp(this.jawOpen, charge * 0.7, 9, dt);
    if (ud.jaw) ud.jaw.rotation.x = this.jawOpen * 0.7;
    if (ud.throat) {
      ud.throat.material.opacity = 0.28 + charge * 0.7 + Math.sin(this.game.time * 3) * 0.05;
      ud.throat.scale.setScalar(1 + charge * 0.35);
    }
    if (ud.maw) {
      ud.maw.material.opacity = charge * 0.9;
      ud.maw.scale.setScalar(0.4 + charge * 1.4);
    }
    if (charge > 0.5 && Math.random() < dt * 18) {
      const p = new THREE.Vector3();
      (ud.maw || m).getWorldPosition(p);
      this.game.fx.spawnParticle(p, _v.set((Math.random() - 0.5) * 2, 1.4, (Math.random() - 0.5) * 2), {
        color: ud.accent, size: 0.07, life: 0.3, gravity: 1.5,
      });
    }

    if (this.hitFlash > 0.001 || this._wasFlashing) {
      for (const rec of this.baseMaterials) rec.mat.color.copy(rec.color).lerp(WHITE, this.hitFlash * 0.8);
      this._wasFlashing = this.hitFlash > 0.001;
    }
  }

  dispose() {
    this.model.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((mm) => mm.dispose());
    });
    this.model.parent?.remove(this.model);
  }
}

const WHITE = new THREE.Color(0xffffff);

/* ========================================================================== */

export class MinionManager {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.remoteBySlot = new Map();   // peerId -> Map<slot, Minion>
  }

  /** Cap is the base plus whatever Brood Totem stacks the owner is carrying. */
  capFor(owner) {
    const extra = owner?.stats?.minionCap ?? 0;
    return MINIONS.baseCap + extra;
  }

  ownedBy(owner) { return this.list.filter((m) => m.owner === owner && !m.remote); }

  hatch(owner, position, opts = {}) {
    const mine = this.ownedBy(owner);
    if (mine.length >= this.capFor(owner)) return null;
    const m = new Minion(this.game, owner, {
      position,
      slot: mine.length,
      accent: owner.char?.accent,
      color: opts.color ?? 0x5f7a4a,
      trophies: this.game.inventory?.totalItems ?? 0,
      netId: opts.netId,
    });
    this.list.push(m);
    return m;
  }

  /**
   * Rebuilds a lizard's body so new items show up on its back.
   *
   * Cheap because it only happens on pickup, and it is the difference between
   * "inherits your items" being a stat line and being something you can see.
   */
  refreshTrophies(owner) {
    const trophies = this.game.inventory?.totalItems ?? 0;
    for (const m of this.list) {
      if (m.owner !== owner) continue;
      if (Math.floor(trophies / 2) === Math.floor((m._trophies ?? 0) / 2)) { m._trophies = trophies; continue; }
      m._trophies = trophies;
      const old = m.model;
      const wasScale = old.scale.x;
      m.model = buildMinionModel({
        color: 0x5f7a4a, accent: old.userData.accent, trophies,
      });
      m.model.position.copy(old.position);
      m.model.rotation.copy(old.rotation);
      m.model.scale.setScalar(wasScale);
      this.game.engine.scene.add(m.model);
      m.baseMaterials = [];
      m.model.traverse((c) => {
        if (c.material && c.material.color) m.baseMaterials.push({ mat: c.material, color: c.material.color.clone() });
      });
      old.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((mm) => mm.dispose());
      });
      old.parent?.remove(old);
    }
  }

  update(dt, world) {
    for (const m of this.list) {
      if (m.remote) m.updateRemote(dt);
      else m.update(dt, world);
    }
  }

  /**
   * Puppets for a teammate's lizards.
   *
   * They have no AI here at all — the owner runs the real thing and we only
   * animate what they tell us, the same way a remote player's body works.
   */
  applyRemote(peerId, list, owner) {
    let mine = this.remoteBySlot.get(peerId);
    if (!mine) { mine = new Map(); this.remoteBySlot.set(peerId, mine); }

    const seen = new Set();
    for (const [slot, x, y, z, yaw, alive, accent, trophies] of list) {
      seen.add(slot);
      let m = mine.get(slot);
      if (!m || m._trophies !== trophies) {
        if (m) { this._drop(m); mine.delete(slot); }
        m = new Minion(this.game, owner, {
          slot, position: new THREE.Vector3(x, y, z), accent, trophies, remote: true,
        });
        m.remote = true;
        m._trophies = trophies;
        this.list.push(m);
        mine.set(slot, m);
      }
      m.netTarget.set(x, y, z);
      m.netYaw = yaw;
      m.state = alive ? 'follow' : 'dormant';
    }
    for (const [slot, m] of mine) {
      if (seen.has(slot)) continue;
      this._drop(m);
      mine.delete(slot);
    }
  }

  _drop(m) {
    const i = this.list.indexOf(m);
    if (i >= 0) this.list.splice(i, 1);
    m.dispose();
  }

  dropPeer(peerId) {
    const mine = this.remoteBySlot.get(peerId);
    if (!mine) return;
    for (const m of mine.values()) this._drop(m);
    this.remoteBySlot.delete(peerId);
  }

  /** Splash and stray fire can catch a lizard standing in the wrong place. */
  inRadius(pos, radius) {
    const out = [];
    const r2 = radius * radius;
    for (const m of this.list) {
      if (!m.alive) continue;
      const dx = m.position.x - pos.x;
      const dy = (m.position.y + 0.4) - pos.y;
      const dz = m.position.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(m);
    }
    return out;
  }

  /** Called when the party descends: everyone comes with you, healthy. */
  regroup() {
    for (const m of this.list) {
      m.revive(true);
      m.velocity.set(0, 0, 0);
    }
  }

  get aliveCount() { return this.list.filter((m) => m.alive).length; }

  clear() {
    for (const m of this.list) m.dispose();
    this.list.length = 0;
    this.remoteBySlot.clear();
  }
}
