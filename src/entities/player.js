import * as THREE from 'three';
import { PLAYER, CAMERA } from '../core/config.js';
import { clamp, damp, armorMultiplier } from '../core/mathx.js';
import { moveWithCollision, raycastWorld } from '../systems/physics.js';
import { buildPlayerModel } from './models.js';
import { createRig, updateRig, rigRecoil, rigFlinch } from './characterRig.js';
import { characterById } from '../data/characters.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camDir = new THREE.Vector3();

/** Fresh stat accumulator; items fold their passive modifiers into this. */
export function freshAccumulator() {
  return {
    addMaxHealth: 0, multMaxHealth: 1,
    addRegen: 0, multRegen: 1,
    addDamage: 0, multDamage: 1,
    multAttackSpeed: 1,
    multMoveSpeed: 1,
    multDamageTaken: 1,
    addCrit: 0, addCritDamage: 0,
    addArmor: 0,
    multCooldown: 1,
    multDashCooldown: 1, addDashCharges: 0,
    addJumps: 0,
    multGold: 1, multXp: 1,
    addPickupRadius: 0,
    multHealing: 1,
    lifesteal: 0,
    luck: 0,
    barrierCap: 0, overhealToBarrier: false,
    addMinionCap: 0, multMinionDamage: 1, multMinionHealth: 1, addMinionVolley: 0,
  };
}

export class Player {
  constructor(game, characterId) {
    this.game = game;
    this.char = characterById(characterId);
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.radius = PLAYER.radius;
    this.height = PLAYER.height;

    this.yaw = 0;
    this.pitch = -0.12;
    this.modelYaw = 0;

    this.level = 1;
    this.xp = 0;
    this.xpToNext = PLAYER.xpBase;
    this.gold = 0;

    this.health = this.char.stats.health;
    this.barrier = 0;
    this.grounded = true;
    this.jumpsUsed = 0;
    this.invulnerable = 0;
    this.dead = false;

    this.dashTime = 0;
    this.dashDir = new THREE.Vector3();
    // Movement states driven by character abilities.
    this.grapple = null;          // { anchor, time, enemy }
    this.shieldCharge = null;     // { dir, time, hit:Set }

    this.buffs = new Map();
    this.statuses = new Map();
    this.stealAffix = null;

    this.timeSinceDamage = 99;
    this.combatTimer = 0;
    this.aiming = false;
    this.aimBlend = 0;
    this.rig = createRig(this.yaw);

    this.statsDirty = true;
    this.stats = {};

    this.model = buildPlayerModel(this.char);
    this.model.position.copy(this.position);
    game.engine.scene.add(this.model);

    this.aimPoint = new THREE.Vector3();
    this.chestPosition = new THREE.Vector3();
    this.muzzlePosition = new THREE.Vector3();

    this.camDistance = CAMERA.distance;
    this._camTarget = new THREE.Vector3();

    this.recomputeStats();
    this.health = this.stats.maxHealth;
  }

  markStatsDirty() { this.statsDirty = true; }

  get speedXZ() { return Math.hypot(this.velocity.x, this.velocity.z); }

  // ------------------------------------------------------------------ stats
  recomputeStats() {
    const acc = freshAccumulator();
    this.game.inventory.applyStats(acc);

    const lvl = this.level - 1;
    const prevMax = this.stats.maxHealth;
    const base = this.char.stats;

    const maxHealth = Math.max(1, (base.health + base.healthPerLevel * lvl + acc.addMaxHealth) * acc.multMaxHealth);
    const damage = (base.damage + base.damagePerLevel * lvl + acc.addDamage) * acc.multDamage;
    const regen = (base.regen + base.regenPerLevel * lvl + acc.addRegen) * acc.multRegen;

    // Buffs layer on top of item stats.
    let atkSpeed = acc.multAttackSpeed;
    let moveMult = acc.multMoveSpeed;
    let damageTakenMult = acc.multDamageTaken;
    const frenzy = this.buffs.get('frenzy');
    if (frenzy) atkSpeed *= 1 + frenzy.power * frenzy.stacks;
    const warcry = this.buffs.get('warcry');
    if (warcry) { atkSpeed *= 1 + warcry.power; moveMult *= 1 + (warcry.extra?.move || 0); }
    const cloak = this.buffs.get('cloak');
    if (cloak) { moveMult *= 1.4; damageTakenMult *= 0.3; }
    const affix = this.buffs.get('stolen_affix');
    if (affix) { atkSpeed *= 1.15; moveMult *= 1.15; }
    const bastion = this.buffs.get('bastion');
    if (bastion) damageTakenMult *= 1 - bastion.power;

    // Statuses
    const chill = this.statuses.get('chill');
    if (chill) moveMult *= 1 - (chill.data.slow ?? 0.4);
    const suppress = this.statuses.get('suppress');
    const healingMult = acc.multHealing * (suppress ? (suppress.data.healing ?? 0.4) : 1);

    this.stats = {
      maxHealth,
      damage,
      regen,
      attackSpeed: atkSpeed,
      moveSpeed: base.moveSpeed * moveMult,
      crit: clamp(base.crit + acc.addCrit, 0, 1),
      critDamage: PLAYER.baseCritDamage + acc.addCritDamage,
      armor: base.armor + acc.addArmor,
      cooldownMult: this.buffs.has('overclock') ? 0 : acc.multCooldown,
      dashCooldownMult: acc.multDashCooldown,
      maxDashCharges: 1 + acc.addDashCharges,
      maxJumps: base.jumps + acc.addJumps,
      goldMult: acc.multGold,
      xpMult: acc.multXp,
      pickupRadius: PLAYER.pickupRadius + acc.addPickupRadius,
      healingMult,
      lifesteal: acc.lifesteal,
      luck: acc.luck,
      barrierCap: acc.barrierCap,
      overhealToBarrier: acc.overhealToBarrier,
      damageTakenMult,
      minionCap: acc.addMinionCap,
      minionDamageMult: acc.multMinionDamage,
      minionHealthMult: acc.multMinionHealth,
      minionVolley: acc.addMinionVolley,
    };

    // Gaining max health from items grants the difference, matching genre convention.
    if (prevMax !== undefined && maxHealth > prevMax) this.health += maxHealth - prevMax;
    this.health = clamp(this.health, 0, maxHealth);
    this.statsDirty = false;
  }

  // ------------------------------------------------------------------ xp / level
  addXp(amount) {
    if (this.dead) return;
    this.xp += amount * this.stats.xpMult;
    let leveled = false;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      this.xpToNext = Math.round(PLAYER.xpBase * Math.pow(PLAYER.xpGrowth, this.level - 1));
      leveled = true;
    }
    if (leveled) {
      const before = this.stats.maxHealth;
      this.recomputeStats();
      this.health += this.stats.maxHealth - before;
      this.game.fx.levelUp(this.position);
      this.game.ui.toast(`LEVEL ${this.level}`, '#57b7ff');
      this.game.ui.flashCrosshair('kill');
    }
  }

  addGold(amount) {
    const g = Math.max(1, Math.round(amount * this.stats.goldMult));
    this.gold += g;
    this.game.run.goldEarned += g;
    this.game.ui.pulseGold();
    return g;
  }

  spendGold(amount) {
    if (this.gold < amount) return false;
    this.gold -= amount;
    return true;
  }

  // ------------------------------------------------------------------ health
  heal(amount, source = null, silent = false) {
    if (this.dead || amount <= 0) return 0;
    const eff = amount * this.stats.healingMult;
    const before = this.health;
    this.health = Math.min(this.stats.maxHealth, this.health + eff);
    const healed = this.health - before;
    const overflow = eff - healed;
    if (overflow > 0 && this.stats.overhealToBarrier) {
      const cap = this.stats.maxHealth * this.stats.barrierCap;
      this.barrier = Math.min(cap, this.barrier + overflow);
    }
    if (healed > 0.5 && !silent) this.game.ui.healNumber(this.position, healed);
    if (healed > 0.5) this.game.ui.flashHeal();
    return healed;
  }

  grantBarrier(amount) {
    const cap = this.stats.maxHealth * Math.max(0.25, this.stats.barrierCap);
    this.barrier = Math.min(cap, this.barrier + amount);
  }

  takeDamage(amount, opts = {}) {
    if (this.dead || this.invulnerable > 0) return 0;
    if (this.dashTime > 0 && this.dashIFrames > 0) return 0;

    let dmg = amount * this.stats.damageTakenMult * armorMultiplier(this.stats.armor);
    dmg = this.game.inventory.modifyIncoming({ amount: dmg, source: opts.source, raw: amount });
    if (dmg <= 0) return 0;

    // Barrier absorbs first.
    if (this.barrier > 0) {
      const absorbed = Math.min(this.barrier, dmg);
      this.barrier -= absorbed;
      dmg -= absorbed;
    }

    if (dmg > 0) this.health -= dmg;
    this.timeSinceDamage = 0;
    this.combatTimer = 5;
    rigFlinch(this.rig, Math.min(1, 0.4 + dmg / Math.max(1, this.stats.maxHealth) * 2.2));
    this.game.ui.playerDamageNumber(dmg);
    this.game.ui.flashHurt(Math.min(1, dmg / (this.stats.maxHealth * 0.22)));
    this.game.engine.addShake(Math.min(0.34, 0.06 + dmg / this.stats.maxHealth * 0.9));
    this.game.inventory.trigger('onDamaged', { amount: dmg, source: opts.source });

    const hpFrac = this.health / this.stats.maxHealth;
    if (hpFrac <= 0.25 && hpFrac > 0) this.game.inventory.trigger('onLowHealth', {});

    if (this.health <= 0) {
      // Items get a chance to prevent lethal damage.
      const prevented = this.game.inventory.triggerFatal();
      if (!prevented) this.die(opts.source);
    }
    return dmg;
  }

  die(source) {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.game.fx.deathBurst(this.chestPosition, 0xff4d5e, 2.2);
    this.game.engine.addShake(1.4);
    this.game.onPlayerDeath(source);
  }

  // ------------------------------------------------------------------ buffs & statuses
  addBuff(id, duration, power, maxStacks = 1, label = '', extra = null) {
    const cur = this.buffs.get(id);
    if (cur) {
      cur.time = Math.max(cur.time, duration);
      cur.stacks = Math.min(maxStacks, cur.stacks + 1);
      cur.power = power;
      cur.extra = extra ?? cur.extra;
    } else {
      this.buffs.set(id, { time: duration, power, stacks: 1, label, extra, maxStacks });
    }
    this.statsDirty = true;
  }

  applyStatus(id, duration, data = {}) {
    const cur = this.statuses.get(id);
    if (cur) { cur.time = Math.max(cur.time, duration); cur.data = { ...cur.data, ...data }; }
    else this.statuses.set(id, { time: duration, data });
    this.statsDirty = true;
  }

  _updateTimers(dt) {
    let dirty = false;
    for (const [id, b] of this.buffs) {
      b.time -= dt;
      if (b.time <= 0) { this.buffs.delete(id); dirty = true; }
    }
    for (const [id, s] of this.statuses) {
      s.time -= dt;
      if (id === 'burn' && s.data.dps) this.takeDamage(s.data.dps * dt, { source: 'Burning', dot: true });
      if (s.time <= 0) { this.statuses.delete(id); dirty = true; }
    }
    if (dirty) this.statsDirty = true;
  }

  // ------------------------------------------------------------------ movement
  update(dt, input, world) {
    if (this.statsDirty) this.recomputeStats();
    this._lastInput = input;
    this._updateTimers(dt);

    this.timeSinceDamage += dt;
    this.combatTimer = Math.max(0, this.combatTimer - dt);
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.dashIFrames = Math.max(0, (this.dashIFrames || 0) - dt);
    if (this.shieldCharge) this.dashIFrames = Math.max(this.dashIFrames, 0.05);

    this.aiming = !!input.mouse.right;

    // --- Look ---
    // Looking around keeps working while you are down: in co-op that is the
    // difference between waiting to be revived and staring at the dirt.
    if (input.locked) {
      const sens = CAMERA.sensitivity * input.sensitivityScale;
      this.yaw -= input.mouse.dx * sens;
      this.pitch -= input.mouse.dy * sens;
      this.pitch = clamp(this.pitch, CAMERA.minPitch, CAMERA.maxPitch);
    }
    if (this.dead) { this._updateModel(dt); return; }

    const axis = input.moveAxis();
    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    // Screen-right is forward × up. For forward = (sin y, 0, cos y) that is
    // (-cos y, 0, sin y) — the negation of this is left, which is what D used to do.
    _right.set(-_fwd.z, 0, _fwd.x);
    this.moveBasis = { fwd: _fwd, right: _right, axis };

    // --- Character movement states take over from normal locomotion ---
    if (this.dashTime > 0) { this._tickDash(dt, world); return; }
    if (this.grapple) { this._tickGrapple(dt, world); return; }
    if (this.shieldCharge) { this._tickShieldCharge(dt, world); return; }

    // --- Horizontal acceleration ---
    const wish = _v.set(0, 0, 0)
      .addScaledVector(_fwd, axis.y)
      .addScaledVector(_right, axis.x);
    const wishLen = wish.length();
    if (wishLen > 0.001) wish.divideScalar(wishLen);

    const targetSpeed = this.stats.moveSpeed * (wishLen > 0 ? 1 : 0);
    const accel = this.grounded ? 62 : 62 * PLAYER.airControl;
    this.velocity.x = damp(this.velocity.x, wish.x * targetSpeed, accel / 6, dt);
    this.velocity.z = damp(this.velocity.z, wish.z * targetSpeed, accel / 6, dt);

    if (wishLen < 0.01) {
      const fr = this.grounded ? PLAYER.groundFriction : PLAYER.airFriction;
      this.velocity.x = damp(this.velocity.x, 0, fr, dt);
      this.velocity.z = damp(this.velocity.z, 0, fr, dt);
    }

    // --- Jump ---
    if (input.justPressed('Space')) {
      if (this.grounded) { this.velocity.y = PLAYER.jumpVelocity; this.jumpsUsed = 1; this.grounded = false; }
      else if (this.jumpsUsed < this.stats.maxJumps) {
        this.velocity.y = PLAYER.jumpVelocity * 0.94;
        this.jumpsUsed++;
        this.game.fx.ring(this.position, 0.3, 2.4, 0xb8c8ff, 0.35, 0.55);
      }
    }

    this.velocity.y += PLAYER.gravity * dt;
    this.velocity.y = Math.max(this.velocity.y, -62);

    _v.set(this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt);
    const res = moveWithCollision(this, _v, world);
    if (res.grounded && !this.grounded) {
      // Landing puff
      if (this.velocity.y < -14) this.game.fx.ring(this.position, 0.3, 2.2, 0xffffff, 0.28, 0.3);
      this.jumpsUsed = 0;
    }
    this.grounded = res.grounded;
    if (this.grounded) this.jumpsUsed = 0;

    // --- Regen (ramps up out of combat) ---
    const outOfCombat = this.combatTimer <= 0 ? 2.2 : 1;
    this.heal(this.stats.regen * outOfCombat * dt, null, true);
    if (this.barrier > 0) this.barrier = Math.max(0, this.barrier - this.stats.maxHealth * 0.035 * dt);

    this._updateAim(world);
    this._updateModel(dt);
  }

  /* ---------------------------------------------------------------- ability movement */

  /** Burst of speed along the current input direction, with optional i-frames. */
  startDash({ speed = 26, duration = 0.2, iframes = 0.16, dir = null } = {}) {
    const basis = this.moveBasis;
    const d = dir ? dir.clone() : new THREE.Vector3();
    if (!dir) {
      const { fwd, right, axis } = basis || {};
      if (basis && (Math.abs(axis.x) > 0.01 || Math.abs(axis.y) > 0.01)) {
        d.addScaledVector(fwd, axis.y).addScaledVector(right, axis.x).normalize();
      } else {
        d.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      }
    }
    this.dashDir.copy(d.setY(0).normalize());
    this.dashSpeed = speed;
    this.dashTime = duration;
    this.dashIFrames = iframes;
    this.velocity.y = Math.max(this.velocity.y, 0);
    this.game.fx.ring(this.position, 0.4, 3.2, 0x8fd8ff, 0.32, 0.6);
    for (let i = 0; i < 8; i++) {
      this.game.fx.spawnParticle(
        this.chestPosition,
        this.dashDir.clone().multiplyScalar(-6).add(
          new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(3)),
        { color: 0x8fd8ff, size: 0.16, life: 0.32, gravity: -2 },
      );
    }
  }

  _tickDash(dt, world) {
    this.dashTime -= dt;
    _v.copy(this.dashDir).multiplyScalar(this.dashSpeed * dt);
    _v.y = this.velocity.y * dt * 0.25;
    const res = moveWithCollision(this, _v, world);
    this.grounded = res.grounded;
    if (this.dashTime <= 0) {
      this.velocity.x = this.dashDir.x * this.dashSpeed * 0.42;
      this.velocity.z = this.dashDir.z * this.dashSpeed * 0.42;
    }
    this._updateAim(world);
    this._updateModel(dt);
  }

  /**
   * Reels the player toward an anchor point.
   *
   * Momentum is preserved on release rather than zeroed — that carried speed is
   * exactly what Unloader's fist spends, so the grapple and the punch are one
   * combo rather than two abilities.
   */
  startGrapple(anchor, { pullSpeed = 40, enemy = null } = {}) {
    this.grapple = { anchor: anchor.clone(), time: 0, pullSpeed, enemy };
    this.jumpsUsed = 0;
  }

  _tickGrapple(dt, world) {
    const gr = this.grapple;
    gr.time += dt;

    // Follow a live target so the line does not anchor to thin air.
    if (gr.enemy && !gr.enemy.dead) gr.anchor.copy(gr.enemy.center);

    _v.copy(gr.anchor).sub(this.chestPosition);
    const dist = _v.length();
    _v.divideScalar(Math.max(dist, 0.001));

    this.velocity.copy(_v).multiplyScalar(gr.pullSpeed);
    _v2.copy(this.velocity).multiplyScalar(dt);
    const res = moveWithCollision(this, _v2, world);
    this.grounded = res.grounded;

    this.game.fx.beam(this.chestPosition, gr.anchor, 0xffd24b, 0.06, 0.05);
    if (this.game.frame % 3 === 0) {
      this.game.fx.spawnParticle(this.chestPosition, new THREE.Vector3(0, 0, 0),
        { color: 0xffd24b, size: 0.11, life: 0.2, gravity: 0, drag: 1 });
    }

    // Release on arrival, on a wall, or if the line has run too long.
    if (dist < 3.0 || gr.time > 1.6 || (res.hitWall && gr.time > 0.12)) {
      this.endGrapple();
    }
    this._updateAim(world);
    this._updateModel(dt);
  }

  endGrapple() {
    if (!this.grapple) return;
    // Keep most of the speed — this is the input to Overcharged Fist.
    this.velocity.multiplyScalar(0.78);
    this.velocity.y = Math.max(this.velocity.y, 3);
    this.grapple = null;
    this.game.fx.ring(this.position, 0.4, 3, 0xffd24b, 0.3, 0.7);
  }

  /** Bulwark's shove: a short forward charge that damages what it hits. */
  startShieldCharge({ speed = 30, duration = 0.42, damage = 0, radius = 3.2, color = 0x6fd0ff }) {
    const dir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.shieldCharge = { dir, time: duration, speed, damage, radius, color, hit: new Set() };
    this.game.fx.ring(this.position, 0.4, 3.4, color, 0.35, 0.8);
  }

  _tickShieldCharge(dt, world) {
    const sc = this.shieldCharge;
    sc.time -= dt;

    _v.copy(sc.dir).multiplyScalar(sc.speed * dt);
    _v.y = this.velocity.y * dt * 0.3;
    const res = moveWithCollision(this, _v, world);
    this.grounded = res.grounded;

    for (const e of this.game.enemies.inRadius(this.chestPosition, sc.radius)) {
      if (sc.hit.has(e)) continue;
      sc.hit.add(e);
      this.game.combat.damageEnemy(e, sc.damage, {
        proc: 1, source: 'Shield Charge',
        knockback: 18, knockbackDir: sc.dir.clone().setY(0.35).normalize(),
      });
    }
    this.game.fx.glow(this.chestPosition, { color: sc.color, size: 1.6, life: 0.12, grow: 0.4 });

    if (sc.time <= 0 || (res.hitWall && sc.time < 0.3)) {
      this.velocity.x = sc.dir.x * sc.speed * 0.3;
      this.velocity.z = sc.dir.z * sc.speed * 0.3;
      this.shieldCharge = null;
    }
    this._updateAim(world);
    this._updateModel(dt);
  }

  /** Resolves the world point under the crosshair and the muzzle transform. */
  _updateAim(world) {
    const cam = this.game.engine.camera;
    cam.getWorldDirection(_camDir);
    const origin = cam.position;
    this.chestPosition.set(this.position.x, this.position.y + PLAYER.eyeHeight * 0.82, this.position.z);

    // The aim point must always land well in FRONT of the player, measured along
    // the camera ray rather than from the camera. Using the camera's own distance
    // meant that when the camera pulled in close to avoid geometry, the crosshair
    // resolved almost on top of the player and the muzzle-to-aim direction became
    // degenerate — which is how the gun ended up pointing at the floor.
    const toPlayer = _v.copy(this.chestPosition).sub(origin);
    const tPlayer = Math.max(0, toPlayer.dot(_camDir));
    const minDist = tPlayer + 5;

    const hit = raycastWorld(origin, _camDir, 300, world);
    const enemyHit = this.game.enemies.raycast(origin, _camDir, 300);
    const dist = Math.min(hit ? hit.distance : 300, enemyHit ? enemyHit.distance : 300);
    this.aimPoint.copy(origin).addScaledVector(_camDir, Math.max(dist, minDist));
  }

  /**
   * Reads the muzzle transform out of the posed model.
   *
   * Deliberately called *after* the rig has run: reading it before meant every
   * shot left from where the muzzle was last frame, which at a full sprint is a
   * hand's width behind the gun.
   */
  _readMuzzle() {
    if (this.model.userData.muzzle) {
      this.model.userData.muzzle.getWorldPosition(this.muzzlePosition);
    } else {
      this.muzzlePosition.copy(this.chestPosition);
    }
  }

  /** Direction from the muzzle to the aim point — what weapons actually fire along. */
  aimDirection(out = new THREE.Vector3()) {
    return out.copy(this.aimPoint).sub(this.muzzlePosition).normalize();
  }

  /**
   * Where the character is going, flattened: the way you are holding WASD, or
   * the way the body is facing if you are holding nothing.
   *
   * This is what movement abilities travel along. Aim is where you are looking,
   * which is a different question — blinking down the camera's line means
   * glancing at the floor teleports you into it.
   */
  moveDirection(out = new THREE.Vector3()) {
    const basis = this.moveBasis;
    if (basis && (Math.abs(basis.axis.x) > 0.01 || Math.abs(basis.axis.y) > 0.01)) {
      out.set(0, 0, 0)
        .addScaledVector(basis.fwd, basis.axis.y)
        .addScaledVector(basis.right, basis.axis.x);
    } else {
      out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    }
    out.y = 0;
    return out.lengthSq() < 1e-6 ? out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)) : out.normalize();
  }

  addRecoil(amount) { rigRecoil(this.rig, amount * 0.02); }

  /** Call after moving the player instantly so the camera does not sweep the level. */
  snapCamera() { this._snapCamera = true; this.camDistance = CAMERA.distance; }

  applyImpulse(vec) {
    this.velocity.add(vec);
    this.grounded = false;
  }

  // ------------------------------------------------------------------ visuals
  /**
   * Decides whether the weapon is up, then hands the body to the shared rig.
   *
   * "Up" is deliberately generous: any intent to shoot, aiming, recent combat, or
   * an enemy anywhere nearby. Out in the open with nothing to kill the weapon
   * drops to a low carry and the arms swing with the walk, which is most of what
   * makes the character read as alive rather than posed.
   */
  _weaponUp(input) {
    if (this.game.combat?.firing || this.game.combat?.beamActive) return true;
    if (this.aiming || this.combatTimer > 0 || this.grapple || this.shieldCharge) return true;
    if (input && (input.mouse.left || input.mouse.leftPressed || input.down('KeyQ'))) return true;
    // Scanning for company is cheap but not free — a few times a second is plenty.
    if (this.game.frame % 12 === 0) {
      this._enemyNear = !!this.game.enemies?.nearest(this.position, 34, 1).length;
    }
    return !!this._enemyNear;
  }

  _updateModel(dt, input) {
    if (input !== undefined) this._lastInput = input;
    updateRig(this.model, this.rig, dt, {
      position: this.position,
      yaw: this.yaw,
      pitch: this.pitch,
      velocity: this.velocity,
      speed: this.speedXZ,
      moveSpeed: this.stats.moveSpeed,
      grounded: this.grounded,
      aiming: this.aiming,
      firing: !!this.game.combat?.firing,
      weaponUp: this.dead ? false : this._weaponUp(this._lastInput),
      dead: this.dead,
      grapple: !!this.grapple,
      cloaked: this.buffs.has('cloak'),
      aimPoint: this.aimPoint,
    });
    this.modelYaw = this.rig.modelYaw;
    this._readMuzzle();
  }

  /** Third-person camera with obstruction pull-in. */
  updateCamera(dt, world, aiming) {
    const cam = this.game.engine.camera;
    this.aimBlend = damp(this.aimBlend, aiming ? 1 : 0, 12, dt);

    const dist = THREE.MathUtils.lerp(CAMERA.distance, CAMERA.aimDistance, this.aimBlend);
    const fov = THREE.MathUtils.lerp(CAMERA.fov, CAMERA.aimFov, this.aimBlend);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }

    const pivot = this._camTarget.set(
      this.position.x, this.position.y + CAMERA.height + PLAYER.eyeHeight * 0.35, this.position.z,
    );
    // Offset over the player's right shoulder (same basis as movement).
    const shoulder = THREE.MathUtils.lerp(CAMERA.shoulder, CAMERA.shoulder * 1.25, this.aimBlend);
    pivot.x -= Math.cos(this.yaw) * shoulder;
    pivot.z += Math.sin(this.yaw) * shoulder;

    // Forward matches the movement basis (yaw 0 faces +Z), so the camera sits
    // behind the player and the crosshair agrees with where the character looks.
    const forward = _v.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ).normalize();

    // Pull in if geometry is between the pivot and the ideal camera spot.
    let want = dist;
    const back = forward.clone().negate();
    const hit = raycastWorld(pivot, back, dist + 0.6, world);
    if (hit) want = Math.max(1.5, hit.distance - 0.45);
    this.camDistance = damp(this.camDistance, want, want < this.camDistance ? 40 : 9, dt);

    // The sweep above can still leave the camera embedded when the pivot jumps
    // (stage change, blink). Walk it in until it is clear of solid geometry —
    // into a LOCAL value. Writing the shrink back into this.camDistance made the
    // damp push it out again next frame only to be shrunk again, so the camera
    // pumped in and out whenever the player stood near a tree or some debris.
    let usedDistance = this.camDistance;
    for (let i = 0; i < 6 && usedDistance > 1.3; i++) {
      const test = _v.copy(pivot).addScaledVector(back, usedDistance);
      if (!world.isInsideSolid(test.x, test.y, test.z, 0.4)) break;
      usedDistance *= 0.68;
    }

    const desired = pivot.clone().addScaledVector(back, usedDistance);
    desired.y = Math.max(desired.y, world.groundHeightAt(desired.x, desired.z) + 0.6);
    if (this._snapCamera) { cam.position.copy(desired); this._snapCamera = false; }
    else cam.position.lerp(desired, 1 - Math.exp(-CAMERA.smoothing * dt));
    cam.lookAt(pivot.x, pivot.y + 0.12, pivot.z);
  }
}
