import * as THREE from 'three';
import { PETS } from '../core/config.js';
import { clamp01, damp, angleLerp } from '../core/mathx.js';
import { moveWithCollision, raycastWorld } from '../systems/physics.js';
import { buildPetSpeciesModel } from './models.js';
import { petById, rollPetSpecies } from '../data/pets.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const WHITE = new THREE.Color(0xffffff);

/**
 * A pet: a bought, permanent ally that fights with your build.
 *
 * "Inherits your items" is meant literally rather than cosmetically. A pet has
 * no stats of its own — every number it uses is its species' multiplier against
 * its owner's *current* stats, so a Stim Injector speeds its attacks up and a
 * Bitterroot makes it tougher, with no per-item plumbing. More importantly its
 * attacks resolve through `Combat.damageEnemy` like any other source of player
 * damage, which means your crit chance, your damage modifiers, your lifesteal
 * and every on-hit proc you own all fire off its hits too. Proc coefficients are
 * per species and all well below 1, so a pack cannot out-proc your own gun.
 *
 * They cannot die permanently. Dropping one to zero curls it back into an egg
 * for a few seconds — losing a purchase you made three stages ago to one stray
 * mortar would make buying them a trap rather than a choice.
 */
export class Pet {
  constructor(game, owner, opts = {}) {
    this.game = game;
    this.owner = owner;
    this.slot = opts.slot ?? 0;
    this.def = petById(opts.species || 'lizard');
    this.species = this.def.id;

    this.position = (opts.position || owner.position).clone();
    this.velocity = new THREE.Vector3();
    this.radius = this.def.radius;
    this.height = this.def.height;
    this.yaw = owner.rig?.modelYaw ?? 0;
    this.grounded = false;

    this.attackTimer = 0.6 + this.slot * 0.22;
    this.windup = 0;
    this.pendingShots = 0;
    this.charge = null;
    this.state = 'follow';        // follow | attack | dormant
    this.dormantTimer = 0;
    this.hitFlash = 0;
    this.walkPhase = Math.random() * 10;
    this.bob = Math.random() * 10;
    this.jawOpen = 0;
    this.target = null;
    this.retargetTimer = 0;
    this.spawnAnim = 1;
    this.remote = !!opts.remote;
    this.netTarget = this.position.clone();
    this.netYaw = this.yaw;
    this._trophies = opts.trophies ?? 0;

    this.health = this.maxHealth;
    this.model = this._buildModel(opts.accent ?? (owner.char?.accent ?? 0xff8a3d), this._trophies);
    this.model.position.copy(this.position);
    this.model.scale.setScalar(0.01);
    game.engine.scene.add(this.model);
  }

  _buildModel(accent, trophies) {
    const model = buildPetSpeciesModel(this.def.model, { color: this.def.color, accent, trophies });
    this.baseMaterials = [];
    model.traverse((c) => {
      if (c.material && c.material.color) this.baseMaterials.push({ mat: c.material, color: c.material.color.clone() });
    });
    return model;
  }

  /* ---------------------------------------------------------- inherited stats */
  get ownerStats() { return this.owner?.stats || {}; }
  get maxHealth() {
    return Math.max(15, (this.ownerStats.maxHealth ?? 100) * this.def.health
      * (this.ownerStats.petHealthMult ?? 1));
  }
  get damage() {
    return (this.ownerStats.damage ?? 10) * this.def.damage * (this.ownerStats.petDamageMult ?? 1);
  }
  get speed() { return (this.ownerStats.moveSpeed ?? 8) * this.def.speed; }
  get fireInterval() { return this.def.attackCooldown / Math.max(0.2, this.ownerStats.attackSpeed ?? 1); }
  get center() { return _v2.set(this.position.x, this.position.y + this.height * 0.6, this.position.z); }
  get alive() { return this.state !== 'dormant'; }
  get accent() { return this.model.userData.accent; }

  /** Where this pet should stand relative to its owner: a ring slot behind them. */
  _anchor(out) {
    const o = this.owner;
    const yaw = (o.rig?.modelYaw ?? o.yaw ?? 0) + Math.PI;
    const spread = ((this.slot % 2) * 2 - 1) * (0.55 + Math.floor(this.slot / 2) * 0.42);
    const a = yaw + spread;
    const ring = PETS.followRadius + Math.floor(this.slot / 4) * 1.6;
    return out.set(o.position.x + Math.sin(a) * ring, o.position.y, o.position.z + Math.cos(a) * ring);
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
    this.dormantTimer = PETS.reviveTime;
    this.health = 0;
    this.charge = null;
    this.game.fx.explosion(this.center, 2.2, this.accent, 0.7);
    this.game.fx.burst(this.center, 10, { color: 0xe6dfc8, speed: 6, size: 0.16, life: 0.6 });
    this.game.ui.toast(`Your ${this.def.name} went down`, '#ff8a3d');
    this.game.inventory?.trigger('onPetDown', { pet: this });
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
    this.game.fx.ring(this.position, 0.4, 2.4, this.accent, 0.4, 0.8);
  }

  // ------------------------------------------------------------------ frame
  update(dt, world) {
    if (!this.owner) return;

    this.hitFlash = Math.max(0, this.hitFlash - dt * 4.5);
    if (this.spawnAnim > 0) {
      this.spawnAnim = Math.max(0, this.spawnAnim - dt * 2.6);
      this.model.scale.setScalar(Math.max(0.01, 1 - this.spawnAnim * this.spawnAnim));
    }

    if (this.state === 'dormant') {
      this.dormantTimer -= dt;
      this._updateDormant(dt, world);
      if (this.dormantTimer <= 0) this.revive();
      return;
    }

    // Out-of-combat regeneration, so a bad fight is not permanent.
    if (this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + this.maxHealth * PETS.regen * dt);
    }

    this._retarget(dt, world);
    if (this.charge) this._tickCharge(dt, world);
    else {
      this._move(dt, world);
      this._attack(dt, world);
    }
    this._physics(dt, world);
    this._updateModel(dt);
  }

  _retarget(dt, world) {
    this.retargetTimer -= dt;
    if (this.target && (this.target.dead
      || this.target.position.distanceTo(this.position) > this.def.attackRange * 1.4)) {
      this.target = null;
    }
    if (this.target || this.retargetTimer > 0) return;
    this.retargetTimer = 0.35;

    const candidates = this.game.enemies.inRadius(this.owner.position, this.def.attackRange);
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
    if (!best) return;
    // A charger does not need line of sight to start running at something.
    if (this.def.attack === 'gore' || this._hasLineOfSight(best, world)) this.target = best;
  }

  _hasLineOfSight(enemy, world) {
    const from = this.center.clone();
    from.y += 0.2;
    _dir.copy(enemy.center).sub(from);
    const dist = _dir.length();
    _dir.divideScalar(Math.max(dist, 0.001));
    return !raycastWorld(from, _dir, dist - 0.4, world);
  }

  /* -------------------------------------------------------------- movement */
  _move(dt, world) {
    const owner = this.owner;
    this._anchor(_v);
    let goal = _v;
    let speedMult = 1;

    const distToOwner = this.position.distanceTo(owner.position);
    if (distToOwner > PETS.leash) {
      // Snapped the leash — scurry back rather than pathing across the arena.
      this.position.copy(_v);
      this.position.y = world.groundHeightAt(_v.x, _v.z) + 0.1;
      this.game.fx.ring(this.position, 0.3, 2, this.accent, 0.3, 0.6);
    }

    if (this.target) {
      const d = this.target.position.distanceTo(this.position);
      const strike = this.def.strikeRange ?? 0;
      if (this.def.attack === 'gore') {
        // Bruisers close. Everything else keeps its distance.
        goal = d > strike ? this.target.position : _v;
        speedMult = 1.2;
      } else if (this.def.attack === 'guard') {
        // The wall wants to be between the owner and the trouble.
        goal = _v2.copy(this.target.position).add(owner.position).multiplyScalar(0.5);
        speedMult = 1;
      } else if (d < (this.def.minRange ?? 0)) {
        goal = _v2.copy(this.position).sub(this.target.position).setY(0).normalize()
          .multiplyScalar(this.def.minRange * 1.6).add(this.position);
        speedMult = 1.1;
      } else if (d > this.def.attackRange * 0.8 || !this._hasLineOfSight(this.target, world)) {
        goal = this.target.position;
        speedMult = 1.15;
      } else {
        goal = _v;
        speedMult = 0.9;
      }
    }

    _dir.copy(goal).sub(this.position);
    _dir.y = 0;
    const d = _dir.length();
    const want = d < 1.1 ? 0 : Math.min(1, d / 4) * this.speed * speedMult;
    if (d > 0.001) _dir.divideScalar(d);

    const catchUp = clamp01((distToOwner - PETS.followRadius * 1.6) / 10) * 0.8;
    this.velocity.x = damp(this.velocity.x, _dir.x * want * (1 + catchUp), 9, dt);
    this.velocity.z = damp(this.velocity.z, _dir.z * want * (1 + catchUp), 9, dt);

    const face = this.target
      ? Math.atan2(this.target.position.x - this.position.x, this.target.position.z - this.position.z)
      : (Math.hypot(this.velocity.x, this.velocity.z) > 0.6
        ? Math.atan2(this.velocity.x, this.velocity.z)
        : (this.owner.rig?.modelYaw ?? this.yaw));
    this.yaw = angleLerp(this.yaw, face, 1 - Math.exp(-9 * dt));
  }

  _physics(dt, world) {
    if (this.def.flying) {
      // Hovers at a fixed height over whatever is underneath, so it drifts over
      // rubble instead of pathing around it.
      const targetY = world.groundHeightAt(this.position.x, this.position.z) + this.def.flyHeight;
      this.velocity.y = damp(this.velocity.y, (targetY - this.position.y) * 3.4, 9, dt);
      _v.set(this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt);
      moveWithCollision(this, _v, world, { stepHeight: 99 });
      return;
    }
    this.velocity.y += -34 * dt;
    _v.set(this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt);
    const res = moveWithCollision(this, _v, world, { stepHeight: 0.6 });
    this.grounded = res.grounded;
    if (this.grounded) this.velocity.y = 0;
  }

  /* --------------------------------------------------------------- attacks */
  _attack(dt, world) {
    this.attackTimer -= dt;
    if (this.windup > 0) {
      this.windup -= dt;
      if (this.windup <= 0) this._release(world);
      return;
    }
    if (this.attackTimer > 0) return;

    if (this.def.attack === 'guard') {
      // The shell does not need a target; it guards whoever is around it.
      this.attackTimer = this.fireInterval;
      this.windup = this.def.windup;
      this.state = 'attack';
      return;
    }
    if (!this.target) return;
    const d = this.target.position.distanceTo(this.position);
    const reach = this.def.attack === 'gore' ? this.def.attackRange : this.def.attackRange;
    if (d > reach) return;
    if (this.def.attack !== 'gore' && !this._hasLineOfSight(this.target, world)) return;

    this.attackTimer = this.fireInterval;
    this.windup = this.def.windup;
    this.state = 'attack';
    this.pendingShots = this.def.attack === 'fireball' || this.def.attack === 'bolt'
      ? (this.ownerStats.petVolley ?? 0)
      : 0;
  }

  _release(world) {
    switch (this.def.attack) {
      case 'gore': return this._startCharge();
      case 'bolt': return this._fireBolt();
      case 'guard': return this._guardPulse();
      default: return this._fireball();
    }
  }

  /** Where an attack leaves from. */
  _muzzle(out) {
    const ud = this.model.userData;
    const node = ud.maw || ud.head || ud.core || this.model;
    node.getWorldPosition(out);
    return out;
  }

  _fireball() {
    const target = this.target;
    if (!target || target.dead) { this.state = 'follow'; return; }
    const origin = this._muzzle(new THREE.Vector3());
    _dir.copy(target.center).sub(origin);
    _dir.addScaledVector(target.velocity, 0.12 * (_dir.length() / this.def.projectileSpeed));
    _dir.normalize();

    const dmg = this.damage;
    this.game.projectiles.spawn({
      position: origin,
      velocity: _dir.clone().multiplyScalar(this.def.projectileSpeed),
      damage: dmg, proc: this.def.proc, radius: 0.24, life: 3.2,
      color: this.accent, gravity: -3, trail: 1.1, glow: 1.7,
      homingRadius: 14, homingStrength: 2.2, target,
      burn: { dps: (this.ownerStats.damage ?? 10) * this.def.burnDps, time: this.def.burnTime },
      // A splashing projectile detonates instead of resolving a direct hit, so
      // the splash is where the whole payload lives.
      splash: { radius: this.def.splashRadius, damage: dmg, proc: this.def.proc, color: this.accent },
      source: `Pet: ${this.def.name}`,
    });
    this.game.fx.muzzle(origin, _dir, this.accent, 0.9);
    this.jawOpen = 1;
    this._afterShot();
  }

  _fireBolt() {
    const target = this.target;
    if (!target || target.dead) { this.state = 'follow'; return; }
    const origin = this._muzzle(new THREE.Vector3());
    _dir.copy(target.center).sub(origin).normalize();
    const dmg = this.damage;
    const game = this.game;
    const jumps = this.def.chainJumps + (this.ownerStats.petVolley ?? 0);
    game.projectiles.spawn({
      position: origin,
      velocity: _dir.clone().multiplyScalar(this.def.projectileSpeed),
      damage: dmg, proc: this.def.proc, radius: 0.14, life: 1.6,
      color: this.accent, gravity: 0, trail: 0.8, glow: 2.1,
      homingRadius: 18, homingStrength: 6, target,
      source: `Pet: ${this.def.name}`,
      onHit: (enemy) => {
        game.combat.chainFrom(enemy, jumps, dmg * this.def.chainFraction, 11, this.accent, 0.8);
      },
    });
    game.fx.muzzle(origin, _dir, this.accent, 0.6);
    this._afterShot();
  }

  /**
   * The shell's pulse: barrier for the party, cold for everyone else.
   *
   * The barrier is the point. A pet that dealt damage would just be a worse
   * lizard; one that hands its own bulk to the group is a different purchase.
   */
  _guardPulse() {
    const r = this.def.guardRadius;
    const owner = this.owner;
    this.game.fx.ring(this.position, r * 0.3, r, this.accent, 0.55, 0.8);
    this.game.fx.glow(this.center, { color: this.accent, size: 2.2, life: 0.35, grow: 1.6 });
    if (owner && owner.position.distanceTo(this.position) < r) {
      owner.grantBarrier?.(owner.stats.maxHealth * this.def.barrierFraction);
    }
    for (const e of this.game.enemies.inRadius(this.position, r)) {
      e.applyStatus('chill', this.def.chillTime, { slow: 0.35 });
      this.game.combat.damageEnemy(e, this.damage, { proc: this.def.proc, source: `Pet: ${this.def.name}` });
    }
    this.state = 'follow';
  }

  _startCharge() {
    const target = this.target;
    if (!target || target.dead) { this.state = 'follow'; return; }
    _dir.copy(target.position).sub(this.position).setY(0);
    if (_dir.lengthSq() < 1e-5) { this.state = 'follow'; return; }
    this.charge = {
      dir: _dir.normalize().clone(),
      time: this.def.chargeTime,
      hit: new Set(),
    };
    this.game.fx.ring(this.position, 0.3, 2.2, this.accent, 0.3, 0.7);
  }

  _tickCharge(dt, world) {
    const c = this.charge;
    c.time -= dt;
    this.velocity.x = c.dir.x * this.def.chargeSpeed;
    this.velocity.z = c.dir.z * this.def.chargeSpeed;
    this.yaw = angleLerp(this.yaw, Math.atan2(c.dir.x, c.dir.z), 1 - Math.exp(-14 * dt));

    for (const e of this.game.enemies.inRadius(this.center, this.def.strikeRange)) {
      if (c.hit.has(e)) continue;
      c.hit.add(e);
      this.game.combat.damageEnemy(e, this.damage, {
        proc: this.def.proc, source: `Pet: ${this.def.name}`,
        knockback: this.def.knockback,
        knockbackDir: c.dir.clone().setY(0.35).normalize(),
        burn: { dps: (this.ownerStats.damage ?? 10) * this.def.burnDps, time: this.def.burnTime },
      });
      this.game.fx.impact(e.center, c.dir.clone().negate(), this.accent, 1.4);
    }
    if (this.game.frame % 2 === 0) {
      this.game.fx.spawnParticle(this.center, _v.set((Math.random() - 0.5) * 2, 1, (Math.random() - 0.5) * 2), {
        color: this.accent, size: 0.1, life: 0.3, gravity: 1,
      });
    }
    if (c.time <= 0 || c.hit.size) {
      this.charge = null;
      this.state = 'follow';
      this.velocity.multiplyScalar(0.25);
    }
  }

  /** Volleys keep the attack going on a short beat instead of a full cooldown. */
  _afterShot() {
    if (this.pendingShots > 0) { this.pendingShots--; this.windup = 0.14; return; }
    this.state = 'follow';
  }

  /* ---------------------------------------------------------------- visuals */
  _updateDormant(dt, world) {
    if (!this.def.flying) {
      this.velocity.y += -34 * dt;
      _v.set(0, this.velocity.y * dt, 0);
      if (moveWithCollision(this, _v, world, { stepHeight: 0.6 }).grounded) this.velocity.y = 0;
    }
    const m = this.model;
    m.position.copy(this.position);
    const t = 1 - clamp01(this.dormantTimer / PETS.reviveTime);
    m.scale.setScalar(0.55 + Math.sin(this.game.time * 4) * 0.02 + t * 0.12);
    m.rotation.y += dt * 0.6;
    const ud = m.userData;
    if (ud.throat) ud.throat.material.opacity = 0.2 + t * 0.6;
    for (const key of ['legFL', 'legFR', 'legBL', 'legBR']) {
      if (ud[key]) ud[key].rotation.x = damp(ud[key].rotation.x, 1.5, 6, dt);
    }
  }

  /** Teammate's pet: chase the transform they sent, animate as normal. */
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

  _updateModel(dt) {
    const m = this.model;
    const ud = m.userData;
    m.position.copy(this.position);
    m.rotation.y = this.yaw;
    m.scale.setScalar(Math.max(0.01, 1 - this.spawnAnim * this.spawnAnim));

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const stride = clamp01(speed / Math.max(1, this.speed));
    this.walkPhase += dt * (3.4 + speed * 1.5);
    const charge = this.windup > 0 ? 1 - clamp01(this.windup / Math.max(0.01, this.def.windup)) : 0;

    if (ud.kind === 'wisp') this._animateWisp(dt, stride, charge);
    else if (ud.kind === 'beetle') this._animateBeetle(dt, stride, charge);
    else if (ud.kind === 'shell') this._animateShell(dt, stride, charge);
    else this._animateLizard(dt, stride, charge);

    if (this.hitFlash > 0.001 || this._wasFlashing) {
      for (const rec of this.baseMaterials) rec.mat.color.copy(rec.color).lerp(WHITE, this.hitFlash * 0.8);
      this._wasFlashing = this.hitFlash > 0.001;
    }
  }

  _legPose(leg, phase, stride, amount = 0.85) {
    if (!leg) return;
    leg.rotation.x = Math.sin(phase) * amount * stride;
    const lower = leg.userData.lower;
    if (lower) lower.rotation.x = (0.15 + Math.max(0, -Math.cos(phase)) * 0.9) * stride;
  }

  _animateLizard(dt, stride, charge) {
    const ud = this.model.userData;
    const ph = this.walkPhase;
    // Diagonal gait: front-left moves with back-right.
    this._legPose(ud.legFL, ph, stride);
    this._legPose(ud.legBR, ph + 0.4, stride);
    this._legPose(ud.legFR, ph + Math.PI, stride);
    this._legPose(ud.legBL, ph + Math.PI + 0.4, stride);

    if (ud.body) {
      ud.body.position.y = 0.42 + Math.abs(Math.sin(ph)) * 0.045 * stride;
      ud.body.rotation.z = Math.sin(ph) * 0.14 * stride;
      ud.body.rotation.y = Math.sin(ph) * 0.09 * stride;
      ud.body.rotation.x = -stride * 0.06;
    }
    // One wave travelling down the spine and tail is what makes a quadruped
    // read as alive rather than as four legs on a box.
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
    this._chargeSparks(charge, dt);
  }

  _animateBeetle(dt, stride, charge) {
    const ud = this.model.userData;
    const ph = this.walkPhase * 1.3;
    // Alternating tripod, the way a real six-legged thing walks.
    for (const side of ['L', 'R']) {
      for (let i = 0; i < 3; i++) {
        const tripod = (side === 'L' ? i : i + 1) % 2;
        this._legPose(ud[`leg${side}${i}`], ph + tripod * Math.PI, stride, 0.7);
      }
    }
    if (ud.body) {
      ud.body.position.y = 0.34 + Math.abs(Math.sin(ph * 2)) * 0.03 * stride;
      ud.body.rotation.z = Math.sin(ph) * 0.09 * stride;
      ud.body.rotation.x = -0.05 - (this.charge ? 0.22 : 0) - charge * 0.12;
    }
    // The elytra crack open as it winds up and while it is charging: the tell
    // that something is about to be hit very hard.
    const open = Math.max(charge, this.charge ? 1 : 0);
    if (ud.wingL) ud.wingL.rotation.z = damp(ud.wingL.rotation.z, open * 0.5, 12, dt);
    if (ud.wingR) ud.wingR.rotation.z = damp(ud.wingR.rotation.z, -open * 0.5, 12, dt);
    if (ud.jawL) ud.jawL.rotation.y = damp(ud.jawL.rotation.y, -0.2 - open * 0.7, 12, dt);
    if (ud.jawR) ud.jawR.rotation.y = damp(ud.jawR.rotation.y, 0.2 + open * 0.7, 12, dt);
    if (ud.head) ud.head.rotation.x = damp(ud.head.rotation.x, -open * 0.3, 10, dt);
    this._chargeSparks(charge, dt);
  }

  _animateWisp(dt, stride, charge) {
    const ud = this.model.userData;
    const t = this.game.time;
    if (ud.body) {
      ud.body.position.y = 1.05 + Math.sin(t * 1.7 + this.bob) * 0.16;
      ud.body.rotation.z = Math.sin(t * 1.1 + this.bob) * 0.12 + this.velocity.x * 0.01;
    }
    if (ud.rings) {
      ud.rings.rotation.y += dt * (1.2 + stride * 2.6 + charge * 6);
      ud.rings.rotation.x += dt * 0.5;
    }
    if (ud.shards) {
      ud.shards.rotation.y -= dt * (0.9 + charge * 5);
      ud.shards.scale.setScalar(1 + charge * 0.25);
    }
    if (ud.core) {
      const pulse = 1 + Math.sin(t * 4) * 0.06 + charge * 0.5;
      ud.core.scale.setScalar(pulse);
    }
    if (ud.husk) ud.husk.material.opacity = 0.35 + charge * 0.4;
    if (ud.tail) {
      ud.tail.rotation.x = Math.sin(t * 2.2) * 0.2 - stride * 0.3;
      ud.tail.rotation.z = Math.cos(t * 1.8) * 0.2;
    }
  }

  _animateShell(dt, stride, charge) {
    const ud = this.model.userData;
    const ph = this.walkPhase * 0.7;
    this._legPose(ud.legFL, ph, stride, 0.5);
    this._legPose(ud.legBR, ph + 0.5, stride, 0.5);
    this._legPose(ud.legFR, ph + Math.PI, stride, 0.5);
    this._legPose(ud.legBL, ph + Math.PI + 0.5, stride, 0.5);
    if (ud.body) {
      ud.body.position.y = 0.46 + Math.abs(Math.sin(ph)) * 0.03 * stride - charge * 0.06;
      ud.body.rotation.z = Math.sin(ph) * 0.06 * stride;
    }
    // Head withdraws into the shell as the guard pulse charges.
    if (ud.neck) ud.neck.position.z = damp(ud.neck.position.z, 0.5 - charge * 0.3, 10, dt);
    if (ud.runes) {
      ud.runes.rotation.y += dt * (0.5 + charge * 5);
      ud.runes.scale.setScalar(1 + charge * 0.2);
    }
    if (charge > 0.6 && Math.random() < dt * 12) {
      this.game.fx.spawnParticle(this.center, _v.set((Math.random() - 0.5) * 3, 2, (Math.random() - 0.5) * 3), {
        color: this.accent, size: 0.09, life: 0.4, gravity: -1,
      });
    }
  }

  _chargeSparks(charge, dt) {
    if (charge <= 0.5 || Math.random() >= dt * 18) return;
    const p = this._muzzle(new THREE.Vector3());
    this.game.fx.spawnParticle(p, _v.set((Math.random() - 0.5) * 2, 1.4, (Math.random() - 0.5) * 2), {
      color: this.accent, size: 0.07, life: 0.3, gravity: 1.5,
    });
  }

  dispose() {
    this.model.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((mm) => mm.dispose());
    });
    this.model.parent?.remove(this.model);
  }
}

/* ========================================================================== */

export class PetManager {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.remoteBySlot = new Map();   // peerId -> Map<slot, Pet>
    this._nextSlot = 0;
  }

  ownedBy(owner) { return this.list.filter((m) => m.owner === owner && !m.remote); }

  /**
   * No headcount limit. The eggs a stage puts out, and the rising price of the
   * next one, are the constraint — so the pack you end up with is something you
   * spent gold on rather than a number in a config file.
   */
  hatch(owner, position, opts = {}) {
    const pet = new Pet(this.game, owner, {
      position,
      slot: this._nextSlot++,
      species: opts.species,
      accent: owner.char?.accent,
      trophies: this.game.inventory?.totalItems ?? 0,
    });
    this.list.push(pet);
    return pet;
  }

  /**
   * Rebuilds a pet's body so new items show up on it.
   *
   * Cheap because it only happens on pickup, and it is the difference between
   * "inherits your items" being a stat line and being something you can see.
   */
  refreshTrophies(owner) {
    const trophies = this.game.inventory?.totalItems ?? 0;
    for (const pet of this.list) {
      if (pet.owner !== owner || pet.remote) continue;
      if (Math.floor(trophies / 2) === Math.floor((pet._trophies ?? 0) / 2)) { pet._trophies = trophies; continue; }
      pet._trophies = trophies;
      this._reskin(pet, trophies);
    }
  }

  _reskin(pet, trophies) {
    const old = pet.model;
    const scale = old.scale.x;
    pet.model = pet._buildModel(old.userData.accent, trophies);
    pet.model.position.copy(old.position);
    pet.model.rotation.copy(old.rotation);
    pet.model.scale.setScalar(scale);
    this.game.engine.scene.add(pet.model);
    old.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((mm) => mm.dispose());
    });
    old.parent?.remove(old);
  }

  update(dt, world) {
    for (const pet of this.list) {
      if (pet.remote) pet.updateRemote(dt);
      else pet.update(dt, world);
    }
  }

  /**
   * Puppets for a teammate's pets.
   *
   * They have no AI here at all — the owner runs the real thing and we only
   * animate what they tell us, the same way a remote player's body works.
   */
  applyRemote(peerId, list, owner) {
    if (!owner) return;
    let mine = this.remoteBySlot.get(peerId);
    if (!mine) { mine = new Map(); this.remoteBySlot.set(peerId, mine); }

    const seen = new Set();
    for (const [slot, x, y, z, yaw, alive, accent, trophies, species] of list) {
      seen.add(slot);
      let pet = mine.get(slot);
      if (!pet || pet._trophies !== trophies || pet.species !== (species || 'lizard')) {
        if (pet) { this._drop(pet); mine.delete(slot); }
        pet = new Pet(this.game, owner, {
          slot, position: new THREE.Vector3(x, y, z), accent, trophies,
          species: species || 'lizard', remote: true,
        });
        pet._trophies = trophies;
        this.list.push(pet);
        mine.set(slot, pet);
      }
      pet.netTarget.set(x, y, z);
      pet.netYaw = yaw;
      pet.state = alive ? 'follow' : 'dormant';
    }
    for (const [slot, pet] of mine) {
      if (seen.has(slot)) continue;
      this._drop(pet);
      mine.delete(slot);
    }
  }

  _drop(pet) {
    const i = this.list.indexOf(pet);
    if (i >= 0) this.list.splice(i, 1);
    pet.dispose();
  }

  dropPeer(peerId) {
    const mine = this.remoteBySlot.get(peerId);
    if (!mine) return;
    for (const pet of mine.values()) this._drop(pet);
    this.remoteBySlot.delete(peerId);
  }

  /** Splash and stray fire can catch a pet standing in the wrong place. */
  inRadius(pos, radius) {
    const out = [];
    const r2 = radius * radius;
    for (const pet of this.list) {
      if (!pet.alive || pet.remote) continue;
      const dx = pet.position.x - pos.x;
      const dy = (pet.position.y + 0.4) - pos.y;
      const dz = pet.position.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(pet);
    }
    return out;
  }

  /** Called when the party descends: everyone comes with you, healthy. */
  regroup() {
    for (const pet of this.list) {
      if (pet.remote) continue;
      pet.revive(true);
      pet.velocity.set(0, 0, 0);
    }
  }

  get aliveCount() { return this.list.filter((m) => m.alive && !m.remote).length; }

  clear() {
    for (const pet of this.list) pet.dispose();
    this.list.length = 0;
    this.remoteBySlot.clear();
    this._nextSlot = 0;
  }
}

export { rollPetSpecies };
