import * as THREE from 'three';
import { DIRECTOR, DIFFICULTY } from '../core/config.js';
import { clamp01, damp, armorMultiplier, angleLerp } from '../core/mathx.js';
import { moveWithCollision, rayCapsule, raycastWorld, distanceToBody } from '../systems/physics.js';
import { buildEnemyModel } from './models.js';
import { ENEMIES_BY_ID, AFFIX_BY_ID } from '../data/enemies.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class Enemy {
  constructor(game, def, position, opts = {}) {
    this.game = game;
    this.def = def;
    this.id = def.id;
    this.boss = !!def.boss;
    this.elite = opts.elite ? AFFIX_BY_ID[opts.elite] : null;

    const diff = opts.difficulty ?? 1;
    const hpMult = 1 + (diff - 1) * DIFFICULTY.hpScale;
    const dmgMult = 1 + (diff - 1) * DIFFICULTY.dmgScale;
    const eliteHp = this.elite ? DIRECTOR.eliteHealthMultiplier : 1;
    const eliteDmg = this.elite ? DIRECTOR.eliteDamageMultiplier : 1;

    this.maxHealth = def.health * hpMult * eliteHp * (opts.healthMult ?? 1);
    this.health = this.maxHealth;
    this.damage = def.damage * dmgMult * eliteDmg;
    this.goldValue = def.gold * (1 + (diff - 1) * DIFFICULTY.goldScale) * (this.elite ? DIRECTOR.eliteGoldMultiplier : 1);
    this.xpValue = def.xp * (1 + (diff - 1) * DIFFICULTY.xpScale) * (this.elite ? 2.2 : 1);

    this.position = position.clone();
    this.velocity = new THREE.Vector3();
    this.radius = def.radius;
    this.height = def.height;
    this.speed = def.speed;
    this.grounded = false;

    this.state = 'chase';
    this.stateTime = 0;
    this.attackTimer = def.attackCooldown * 0.5;
    this.windupTimer = 0;
    this.yaw = 0;
    this.walkPhase = Math.random() * 10;
    this.statuses = new Map();
    this.dead = false;
    this.hitFlash = 0;
    this.spawnTime = 0;
    this.volleyLeft = 0;
    this.volleyTimer = 0;
    this.sunderCount = 0;
    this.affixTimer = 0;
    this.repositionTarget = null;
    this.hoverTarget = null;
    this.hoverRepick = 0;
    this.stuckTimer = 0;
    this.lastPos = this.position.clone();

    // Networking. On a client every enemy is a ghost: no AI, no physics, just
    // the host's transform smoothed out and the same model animation as ever.
    this.netId = opts.netId ?? null;
    this.netGhost = !!opts.ghost;
    this.netFrom = this.position.clone();
    this.netTarget = this.position.clone();
    this.netYaw = 0;
    this.netBlend = 1;
    this.netMissing = 0;
    this.currentTarget = null;

    this.model = buildEnemyModel(def);
    this.model.position.copy(this.position);
    game.engine.scene.add(this.model);

    this.baseMaterials = [];
    this.model.traverse((c) => {
      if (c.material && c.material.color) this.baseMaterials.push({ mat: c.material, color: c.material.color.clone() });
    });

    if (this.elite) this._applyEliteVisuals();
    if (this.boss || this.elite) this._buildHealthBar();

    // Spawn-in animation
    this.model.scale.setScalar(0.01);
    this.spawnAnim = 1;
  }

  _applyEliteVisuals() {
    const c = new THREE.Color(this.elite.color);
    for (const rec of this.baseMaterials) {
      rec.mat.color.lerp(c, 0.45);
      if (rec.mat.emissive) { rec.mat.emissive.copy(c); rec.mat.emissiveIntensity = 0.55; }
      rec.color.copy(rec.mat.color);
    }
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(this.radius * 2.1, 1.1), 12, 10),
      new THREE.MeshBasicMaterial({
        color: this.elite.color, transparent: true, opacity: 0.13,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
      }),
    );
    aura.position.y = this.height * 0.5;
    this.model.add(aura);
    this.aura = aura;
    this.maxHealth *= 1;
  }

  _buildHealthBar() {
    const g = new THREE.Group();
    const w = this.boss ? 4.2 : 1.7;
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(w, this.boss ? 0.3 : 0.16),
      new THREE.MeshBasicMaterial({ color: 0x101520, transparent: true, opacity: 0.75, depthTest: false }),
    );
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(w, this.boss ? 0.3 : 0.16),
      new THREE.MeshBasicMaterial({
        color: this.elite ? this.elite.color : 0xff4d5e, transparent: true, opacity: 0.95, depthTest: false,
      }),
    );
    fill.position.z = 0.01;
    g.add(back, fill);
    g.position.y = this.height + (this.boss ? 1.6 : 0.55);
    g.renderOrder = 999;
    this.model.add(g);
    this.healthBar = { group: g, fill, width: w };
  }

  // ------------------------------------------------------------------
  get center() { return _v2.set(this.position.x, this.position.y + this.height * 0.55, this.position.z); }

  applyStatus(id, duration, data = {}) {
    const cur = this.statuses.get(id);
    if (cur) { cur.time = Math.max(cur.time, duration); cur.data = { ...cur.data, ...data }; }
    else this.statuses.set(id, { time: duration, data });
  }

  get slowFactor() {
    let f = 1;
    const chill = this.statuses.get('chill');
    if (chill) f *= 1 - (chill.data.slow ?? 0.5);
    if (this.statuses.has('freeze')) f = 0;
    return f;
  }

  takeDamage(amount, opts = {}) {
    if (this.dead) return 0;

    let dmg = amount;
    const sunder = this.statuses.get('sunder');
    let armor = 0;
    if (sunder) { armor -= sunder.data.armor ?? 0; dmg *= 1 + (sunder.data.vuln ?? 0); }
    if (armor !== 0) dmg *= armorMultiplier(armor);

    this.health -= dmg;
    this.hitFlash = 1;

    // On a client this body is a copy. Predict the damage so numbers and hit
    // flashes are instant, but never let it die here — the host owns that, and
    // a corpse that comes back to life is worse than one that dies late.
    if (this.netGhost) {
      this.health = Math.max(1, this.health);
      this.game.coop?.reportDamage(this, dmg);
      if (!opts.quiet) this.game.ui.damageNumber(opts.hitPoint || this.center, dmg, opts.crit);
      return dmg;
    }

    if (opts.knockback && this.def.knockbackResist < 1) {
      const k = opts.knockback * (1 - this.def.knockbackResist);
      this.velocity.addScaledVector(opts.knockbackDir || _dir.set(0, 1, 0), k);
      this.grounded = false;
    }
    if (opts.chill) this.applyStatus('chill', opts.chill, { slow: 0.5 });
    if (opts.freeze) this.applyStatus('freeze', opts.freeze, {});
    if (opts.burn) this.applyStatus('burn', opts.burn.time ?? 3, { dps: opts.burn.dps ?? 0 });

    if (!opts.quiet) this.game.ui.damageNumber(opts.hitPoint || this.center, dmg, opts.crit);
    if (this.health <= 0) this.die(opts);
    return dmg;
  }

  die(opts = {}) {
    if (this.dead) return;
    this.dead = true;
    this.game.onEnemyDeath(this, opts);
  }

  // ------------------------------------------------------------------ AI
  update(dt, player, world) {
    if (this.dead) return;
    this.currentTarget = player;
    if (this.netGhost) return this._updateGhost(dt, player);
    this.stateTime += dt;
    this.spawnTime += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4.5);

    // Spawn scale-in
    if (this.spawnAnim > 0) {
      this.spawnAnim = Math.max(0, this.spawnAnim - dt * 3.2);
      const s = 1 - this.spawnAnim * this.spawnAnim;
      this.model.scale.setScalar(Math.max(0.01, s));
    }

    // Status ticks
    for (const [id, st] of this.statuses) {
      st.time -= dt;
      if (id === 'burn' && st.data.dps) {
        this.health -= st.data.dps * dt;
        if (Math.random() < dt * 7) {
          this.game.fx.spawnParticle(this.center, _v.set(Math.random() - 0.5, 2.5, Math.random() - 0.5), {
            color: 0xff6a2a, size: 0.13, life: 0.4, gravity: 2,
          });
        }
        if (this.health <= 0) { this.die({ source: 'Burning' }); return; }
      }
      // A mark has to be visible from across the arena or the Javelin is
      // guessing. One glow every few frames is enough and costs nothing.
      if (id === 'marked') {
        st.data.blink = (st.data.blink ?? 0) - dt;
        if (st.data.blink <= 0) {
          st.data.blink = 0.45;
          _v.copy(this.center);
          _v.y += this.height * 0.75;
          this.game.fx.glow(_v, { color: st.data.color ?? 0x9dff6a, size: 0.9, life: 0.4, grow: 0.5 });
        }
      }
      if (st.time <= 0) this.statuses.delete(id);
    }

    const toPlayer = _v.copy(player.position).sub(this.position);
    const distXZ = Math.hypot(toPlayer.x, toPlayer.z);
    this.distToPlayer = distXZ;
    this.attackTimer -= dt;

    const slow = this.slowFactor;
    if (slow > 0) this._runAI(dt * slow, player, world, toPlayer, distXZ);

    // Being winched in overrides whatever the AI decided this frame. It is the
    // last word on velocity precisely because a charger sprinting away from the
    // line would otherwise win the tug of war against it.
    const pulled = this.statuses.get('pulled');
    if (pulled) this._tickPull(dt, pulled);

    // Physics
    const flying = this.def.ai === 'flyer' || this.def.model === 'leviathan' || this.def.model === 'harbinger' || this.def.model === 'warden';
    if (flying) {
      const targetY = world.groundHeightAt(this.position.x, this.position.z) + (this.def.flyHeight ?? 6);
      // Hold altitude firmly so flyers track a predictable horizontal plane.
      this.velocity.y = damp(this.velocity.y, (targetY - this.position.y) * 3.2, 9, dt);
      _v2.set(this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt);
      moveWithCollision(this, _v2, world, { stepHeight: 99 });
      this.position.y = Math.max(this.position.y, world.groundHeightAt(this.position.x, this.position.z) + 1.2);
    } else {
      this.velocity.y += -34 * dt;
      _v2.set(this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt);
      const res = moveWithCollision(this, _v2, world);
      this.grounded = res.grounded;
      if (this.grounded) {
        this.velocity.x *= Math.pow(0.02, dt);
        this.velocity.z *= Math.pow(0.02, dt);
      }
    }

    this._eliteTick(dt, player);
    this._updateModel(dt, player);
  }

  /**
   * Reels this enemy toward whoever harpooned it.
   *
   * Heavy things resist in proportion to their knockback resistance rather than
   * being immune, so a Brute comes in slowly and a boss barely shifts — but the
   * line is never simply ignored.
   */
  _tickPull(dt, st) {
    const target = st.data.target || this.game.player;
    if (!target) return;
    const resist = Math.min(0.92, this.def.knockbackResist ?? 0);
    const speed = (st.data.speed ?? 34) * (1 - resist);
    _v.copy(target.position).sub(this.position);
    const d = _v.length();
    if (d < 1.8) { this.statuses.delete('pulled'); return; }
    _v.divideScalar(d);
    this.velocity.x = _v.x * speed;
    this.velocity.z = _v.z * speed;
    // A little lift so the winch drags things over lips and debris instead of
    // grinding them into the first kerb between here and the player.
    if (this.grounded) { this.velocity.y = Math.max(this.velocity.y, 4.5); this.grounded = false; }
    if (this.game.frame % 3 === 0) {
      this.game.fx.beam(target.chestPosition, this.center, st.data.color ?? 0x7ad4ff, 0.09, 0.05);
    }
  }

  /**
   * Client-side body: catch up to the last transform the host sent.
   *
   * Blending toward the target rather than snapping is what keeps a teammate's
   * screen from looking like a slideshow at 15 snapshots a second, and deriving
   * a velocity from the blend means the existing walk animation still drives
   * itself off movement with no special cases.
   */
  _updateGhost(dt, player) {
    this.stateTime += dt;
    this.spawnTime += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4.5);
    if (this.spawnAnim > 0) {
      this.spawnAnim = Math.max(0, this.spawnAnim - dt * 3.2);
      const s = 1 - this.spawnAnim * this.spawnAnim;
      this.model.scale.setScalar(Math.max(0.01, s));
    }
    const prevX = this.position.x;
    const prevZ = this.position.z;
    const k = 1 - Math.exp(-13 * dt);
    this.position.lerp(this.netTarget, k);
    this.yaw = angleLerp(this.yaw, this.netYaw, k);
    this.velocity.set((this.position.x - prevX) / Math.max(dt, 1e-4), 0, (this.position.z - prevZ) / Math.max(dt, 1e-4));
    this.distToPlayer = player ? Math.hypot(player.position.x - this.position.x, player.position.z - this.position.z) : 99;
    this._updateModel(dt, player);
  }

  _steer(dt, targetPos, speedMult, world) {
    _dir.copy(targetPos).sub(this.position);
    _dir.y = 0;
    const d = _dir.length();
    if (d < 0.001) return;
    _dir.divideScalar(d);

    // Cheap obstacle avoidance: if the path ahead is blocked, slide around it.
    const probe = _v2.set(this.position.x, this.position.y + this.height * 0.5, this.position.z);
    const hit = raycastWorld(probe, _dir, this.radius + 2.6, world);
    if (hit && hit.box) {
      const side = (this.avoidSide ??= Math.random() < 0.5 ? 1 : -1);
      _dir.set(_dir.z * side, 0, -_dir.x * side).normalize();
    } else if (Math.random() < dt * 0.6) {
      this.avoidSide = Math.random() < 0.5 ? 1 : -1;
    }

    const speed = this.speed * speedMult;
    this.velocity.x = damp(this.velocity.x, _dir.x * speed, 8, dt);
    this.velocity.z = damp(this.velocity.z, _dir.z * speed, 8, dt);

    // Unstick: if we barely moved while trying to, hop.
    if (this.grounded) {
      const moved = this.position.distanceTo(this.lastPos);
      this.stuckTimer = moved < 0.02 ? this.stuckTimer + dt : 0;
      if (this.stuckTimer > 0.75) { this.velocity.y = 9; this.stuckTimer = 0; this.avoidSide = -(this.avoidSide ?? 1); }
    }
    this.lastPos.copy(this.position);
  }

  _faceTarget(dt, targetPos, rate = 9) {
    const want = Math.atan2(targetPos.x - this.position.x, targetPos.z - this.position.z);
    this.yaw = angleLerp(this.yaw, want, 1 - Math.exp(-rate * dt));
  }

  _hasLineOfSight(player, world) {
    const from = this.center.clone();
    const to = _v2.set(player.position.x, player.position.y + 1.0, player.position.z);
    const dir = to.clone().sub(from);
    const dist = dir.length();
    dir.divideScalar(dist);
    const hit = raycastWorld(from, dir, dist, world);
    return !hit || hit.distance >= dist - 0.5 || (!hit.box && !hit.wall);
  }

  _runAI(dt, player, world, toPlayer, distXZ) {
    const def = this.def;
    switch (def.ai) {
      case 'melee': return this._aiMelee(dt, player, world, distXZ);
      case 'ranged': return this._aiRanged(dt, player, world, distXZ);
      case 'flyer': return this._aiFlyer(dt, player, world, distXZ);
      case 'charger': return this._aiCharger(dt, player, world, distXZ);
      case 'artillery': return this._aiArtillery(dt, player, world, distXZ);
      case 'boss_colossus': return this._aiColossus(dt, player, world, distXZ);
      case 'boss_leviathan': return this._aiLeviathan(dt, player, world, distXZ);
      case 'boss_harbinger': return this._aiHarbinger(dt, player, world, distXZ);
      default: return this._aiMelee(dt, player, world, distXZ);
    }
  }

  _aiMelee(dt, player, world, dist) {
    this._faceTarget(dt, player.position);
    if (this.state === 'windup') {
      this.windupTimer -= dt;
      this.velocity.x *= 0.86; this.velocity.z *= 0.86;
      if (this.windupTimer <= 0) {
        this.state = 'chase';
        this._meleeStrike(player);
      }
      return;
    }
    if (dist > this.def.attackRange) {
      this._steer(dt, player.position, 1, world);
    } else {
      this.velocity.x *= 0.9; this.velocity.z *= 0.9;
      if (this.attackTimer <= 0) {
        this.state = 'windup';
        this.windupTimer = this.def.windup;
        this.attackTimer = this.def.attackCooldown;
        this.stateTime = 0;
      }
    }
  }

  _meleeStrike(player) {
    const range = this.def.slamRadius ?? this.def.attackRange + 0.6;
    const d = distanceToBody(player.position.clone().setY(player.position.y + 0.8), this);
    if (this.def.slamRadius) {
      this.game.fx.ring(this.position, 0.5, this.def.slamRadius, this.def.accent, 0.35, 0.8);
      this.game.fx.burst(this.position, 12, { color: this.def.accent, speed: 7, size: 0.22, life: 0.5 });
      this.game.engine.addShake(0.16);
    }
    if (d <= range + player.radius) {
      player.takeDamage(this.damage, { source: this.def.name });
      this.elite?.onHitPlayer?.(this._affixCtx());
      _dir.copy(player.position).sub(this.position).setY(0).normalize();
      player.applyImpulse(_dir.multiplyScalar(4).setY(3));
    }
    // Anything else standing inside the swing eats it too.
    for (const m of this.game.minions?.inRadius(this.position, range + 1.2) || []) {
      m.takeDamage(this.damage * 0.7, { source: this.def.name });
    }
  }

  _aiRanged(dt, player, world, dist) {
    this._faceTarget(dt, player.position);
    const pref = this.def.preferredRange;
    if (this.state === 'windup') {
      this.windupTimer -= dt;
      this.velocity.x *= 0.8; this.velocity.z *= 0.8;
      if (this.windupTimer <= 0) { this.state = 'chase'; this._fireProjectile(player); }
      return;
    }
    if (dist > this.def.attackRange) this._steer(dt, player.position, 1, world);
    else if (dist < pref * 0.65) {
      _v2.copy(this.position).sub(player.position).setY(0).normalize().multiplyScalar(12).add(this.position);
      this._steer(dt, _v2, 0.9, world);
    } else {
      // Strafe to stay awkward to hit.
      const t = this.game.time * 0.7 + this.walkPhase;
      _v2.copy(player.position);
      _v2.x += Math.cos(t) * pref;
      _v2.z += Math.sin(t) * pref;
      this._steer(dt, _v2, 0.55, world);
    }
    if (this.attackTimer <= 0 && dist < this.def.attackRange && this._hasLineOfSight(player, world)) {
      this.state = 'windup';
      this.windupTimer = this.def.windup;
      this.attackTimer = this.def.attackCooldown;
    }
  }

  /**
   * Flyers move in readable beats rather than a continuous orbit.
   *
   * The old behaviour was a constant circular strafe with damped steering on
   * top, which meant they were never travelling in a straight line long enough
   * to lead a shot. Now they alternate between a straight reposition to a chosen
   * hover point and a full stop while they wind up and fire — so there is always
   * a stationary window to punish, and the movement between windows is linear.
   */
  _aiFlyer(dt, player, world, dist) {
    this._faceTarget(dt, player.position, 7);
    const pref = this.def.preferredRange;

    // Firing beat: hold completely still so the shot can be dodged and the
    // drone can be hit.
    if (this.state === 'windup') {
      this.windupTimer -= dt;
      this.velocity.x *= Math.pow(0.02, dt);
      this.velocity.z *= Math.pow(0.02, dt);
      if (this.windupTimer <= 0) {
        this.state = 'recover';
        this.stateTime = 0;
        this._fireProjectile(player);
      }
      return;
    }
    if (this.state === 'recover') {
      this.velocity.x *= Math.pow(0.15, dt);
      this.velocity.z *= Math.pow(0.15, dt);
      if (this.stateTime > 0.45) { this.state = 'chase'; this.hoverTarget = null; }
      return;
    }

    // Reposition beat: pick one hover point and fly to it in a straight line.
    if (!this.hoverTarget || this.hoverRepick <= 0
        || _v2.set(this.hoverTarget.x, 0, this.hoverTarget.z)
             .distanceTo(_v.set(this.position.x, 0, this.position.z)) < 2.5) {
      const a = Math.atan2(this.position.x - player.position.x, this.position.z - player.position.z)
        + this.game.rng.range(-1.1, 1.1);
      this.hoverTarget = {
        x: player.position.x + Math.sin(a) * pref,
        z: player.position.z + Math.cos(a) * pref,
      };
      this.hoverRepick = this.game.rng.range(1.6, 2.8);
    }
    this.hoverRepick -= dt;

    _v2.set(this.hoverTarget.x, this.position.y, this.hoverTarget.z);
    this._steer(dt, _v2, 1, world);

    if (this.attackTimer <= 0 && dist < this.def.attackRange && this._hasLineOfSight(player, world)) {
      this.state = 'windup';
      this.windupTimer = this.def.windup;
      this.attackTimer = this.def.attackCooldown;
      this.hoverTarget = null;
    }
  }

  _aiCharger(dt, player, world, dist) {
    if (this.state === 'charging') {
      this.windupTimer -= dt;
      this.velocity.x = this.chargeDir.x * this.def.chargeSpeed;
      this.velocity.z = this.chargeDir.z * this.def.chargeSpeed;
      const d = distanceToBody(player.position.clone().setY(player.position.y + 0.8), this);
      if (d < this.radius + player.radius + 1.2) {
        player.takeDamage(this.damage, { source: this.def.name });
        this.elite?.onHitPlayer?.(this._affixCtx());
        player.applyImpulse(this.chargeDir.clone().multiplyScalar(14).setY(6));
        this.state = 'recover'; this.stateTime = 0;
        this.game.engine.addShake(0.2);
      }
      if (this.windupTimer <= 0) { this.state = 'recover'; this.stateTime = 0; }
      if (Math.random() < dt * 20) {
        this.game.fx.spawnParticle(this.center, _v.set(Math.random() - 0.5, Math.random(), Math.random() - 0.5).multiplyScalar(3), {
          color: this.def.accent, size: 0.16, life: 0.3, gravity: -2,
        });
      }
      return;
    }
    if (this.state === 'recover') {
      this.velocity.x *= 0.9; this.velocity.z *= 0.9;
      if (this.stateTime > 0.8) this.state = 'chase';
      return;
    }
    if (this.state === 'windup') {
      this.windupTimer -= dt;
      this.velocity.x *= 0.8; this.velocity.z *= 0.8;
      this._faceTarget(dt, player.position, 5);
      if (this.windupTimer <= 0) {
        this.state = 'charging';
        this.windupTimer = this.def.chargeDuration;
        this.chargeDir = _dir.copy(player.position).sub(this.position).setY(0).normalize().clone();
        this.game.fx.ring(this.position, 0.5, 3, this.def.accent, 0.3, 0.8);
      }
      return;
    }
    this._faceTarget(dt, player.position);
    this._steer(dt, player.position, 1, world);
    if (this.attackTimer <= 0 && dist < this.def.attackRange && dist > 4) {
      this.state = 'windup';
      this.windupTimer = this.def.windup;
      this.attackTimer = this.def.attackCooldown;
    }
  }

  _aiArtillery(dt, player, world, dist) {
    this._faceTarget(dt, player.position, 5);
    const pref = this.def.preferredRange;
    if (dist > this.def.attackRange) this._steer(dt, player.position, 1, world);
    else if (dist < pref * 0.7) {
      _v2.copy(this.position).sub(player.position).setY(0).normalize().multiplyScalar(14).add(this.position);
      this._steer(dt, _v2, 0.8, world);
    } else { this.velocity.x *= 0.9; this.velocity.z *= 0.9; }

    if (this.volleyLeft > 0) {
      this.volleyTimer -= dt;
      if (this.volleyTimer <= 0) {
        this.volleyTimer = 0.28;
        this.volleyLeft--;
        this._fireProjectile(player, true);
      }
      return;
    }
    if (this.state === 'windup') {
      this.windupTimer -= dt;
      if (this.windupTimer <= 0) {
        this.state = 'chase';
        this.volleyLeft = this.def.volley ?? 1;
        this.volleyTimer = 0;
      }
      return;
    }
    if (this.attackTimer <= 0 && dist < this.def.attackRange) {
      this.state = 'windup';
      this.windupTimer = this.def.windup;
      this.attackTimer = this.def.attackCooldown;
    }
  }

  // ---- Bosses ----
  _aiColossus(dt, player, world, dist) {
    this._faceTarget(dt, player.position, 3.4);
    if (this.state === 'windup') {
      this.windupTimer -= dt;
      this.velocity.x *= 0.85; this.velocity.z *= 0.85;
      if (this.windupTimer <= 0) {
        this.state = 'chase';
        if (this.pendingAttack === 'slam') {
          this.game.fx.explosion(this.position, this.def.slamRadius, this.def.accent, 1.4);
          this.game.engine.addShake(0.42);
          const d = Math.hypot(player.position.x - this.position.x, player.position.z - this.position.z);
          if (d < this.def.slamRadius) player.takeDamage(this.damage * 1.4, { source: this.def.name });
          // Shockwave ring of fissures
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            this.game.spawnHazard(
              _v.set(this.position.x + Math.cos(a) * 7, this.position.y, this.position.z + Math.sin(a) * 7),
              { radius: 3.4, damage: this.damage * 0.7, delay: 0.5, color: this.def.accent },
            );
          }
        } else {
          // Boulder volley
          for (let i = 0; i < 5; i++) {
            this.game.spawnEnemyProjectile(this, {
              speed: 30, radius: 0.6, gravity: -14, color: this.def.accent, splash: 5,
              damage: this.damage * 0.8, spread: 0.12, target: player.position,
            });
          }
        }
      }
      return;
    }
    if (dist > 9) this._steer(dt, player.position, 1, world);
    else { this.velocity.x *= 0.9; this.velocity.z *= 0.9; }

    if (this.attackTimer <= 0) {
      this.state = 'windup';
      this.windupTimer = this.def.windup;
      this.attackTimer = this.def.attackCooldown;
      this.pendingAttack = dist < this.def.slamRadius ? 'slam' : (Math.random() < 0.5 ? 'volley' : 'slam');
      if (this.pendingAttack === 'slam') this.game.fx.ring(this.position, 1, this.def.slamRadius, this.def.accent, this.def.windup, 0.5);
    }
  }

  _aiLeviathan(dt, player, world, dist) {
    this._faceTarget(dt, player.position, 3);
    const t = this.game.time * 0.32;
    _v2.set(Math.cos(t) * 26, 0, Math.sin(t) * 26).add(player.position);
    this._steer(dt, _v2, 1, world);

    if (this.volleyLeft > 0) {
      this.volleyTimer -= dt;
      if (this.volleyTimer <= 0) {
        this.volleyTimer = 0.18;
        this.volleyLeft--;
        this.game.spawnEnemyProjectile(this, {
          ...this.def.projectile, damage: this.damage * 0.7, target: player.position, spread: 0.06, lead: 0.6,
        });
      }
      return;
    }
    if (this.attackTimer <= 0) {
      this.attackTimer = this.def.attackCooldown;
      if (Math.random() < 0.35) {
        // Strafing run of ground fire
        for (let i = 0; i < 8; i++) {
          const p = player.position.clone();
          p.x += (Math.random() - 0.5) * 26;
          p.z += (Math.random() - 0.5) * 26;
          this.game.spawnHazard(p, { radius: 4, damage: this.damage * 0.8, delay: 0.9 + i * 0.08, color: this.def.accent });
        }
      } else {
        this.volleyLeft = this.def.volley;
        this.volleyTimer = 0;
      }
    }
  }

  _aiHarbinger(dt, player, world, dist) {
    this._faceTarget(dt, player.position, 4);
    if (this.state === 'blink') {
      this.windupTimer -= dt;
      if (this.windupTimer <= 0) {
        const a = Math.random() * Math.PI * 2;
        const r = 14 + Math.random() * 10;
        this.position.set(player.position.x + Math.cos(a) * r, player.position.y + 8, player.position.z + Math.sin(a) * r);
        this.game.fx.explosion(this.position, 6, this.def.accent, 1);
        this.state = 'chase';
      }
      return;
    }
    if (dist > this.def.preferredRange * 1.3) this._steer(dt, player.position, 1, world);
    else if (dist < this.def.preferredRange * 0.6) {
      _v2.copy(this.position).sub(player.position).setY(0).normalize().multiplyScalar(16).add(this.position);
      this._steer(dt, _v2, 1, world);
    } else { this.velocity.x *= 0.94; this.velocity.z *= 0.94; }

    if (this.attackTimer <= 0) {
      this.attackTimer = this.def.attackCooldown;
      const roll = Math.random();
      if (roll < 0.25) {
        this.state = 'blink';
        this.windupTimer = 0.35;
        this.game.fx.explosion(this.position, 5, this.def.accent, 0.8);
      } else if (roll < 0.5 && this.game.enemies.list.length < DIRECTOR.maxActiveEnemies - 4) {
        // Summon adds
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          const p = this.position.clone();
          p.x += Math.cos(a) * 5; p.z += Math.sin(a) * 5;
          p.y = world.groundHeightAt(p.x, p.z);
          this.game.enemies.spawn('husk', p, { difficulty: this.game.director.difficulty });
          this.game.fx.explosion(p, 4, this.def.accent, 0.7);
        }
      } else {
        // Radial barrage
        const count = 12;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2;
          this.game.spawnEnemyProjectile(this, {
            speed: 26, radius: 0.3, gravity: 0, color: this.def.accent, damage: this.damage * 0.55,
            direction: _v.set(Math.cos(a), -0.12, Math.sin(a)).clone(),
          });
        }
      }
    }
  }

  _fireProjectile(player, isVolley = false) {
    const p = this.def.projectile;
    if (!p) return;
    this.game.spawnEnemyProjectile(this, {
      ...p,
      damage: this.damage * (isVolley ? 0.7 : 1),
      target: player.position,
      spread: isVolley ? 0.05 : 0.02,
      lead: p.gravity ? 0.35 : 0.15,
    });
    this.game.fx.muzzle(this.center, _dir.copy(player.position).sub(this.position).normalize(), this.def.accent, 1.2);
  }

  _affixCtx() {
    // Affix side-effects land on whoever this enemy is actually fighting, which
    // in co-op is not necessarily the player running the simulation.
    const target = this.currentTarget || this.game.player;
    return {
      enemy: this,
      applyPlayerStatus: (id, dur, data) => target?.applyStatus(id, dur, data),
    };
  }

  _eliteTick(dt, player) {
    if (!this.elite?.tick) return;
    this.affixTimer -= dt;
    if (this.affixTimer > 0) return;
    switch (this.elite.tick) {
      case 'fireTrail':
        this.affixTimer = 0.6;
        if (this.velocity.lengthSq() > 1) {
          this.game.spawnHazard(this.position.clone(), {
            radius: 2.6, damage: this.damage * 0.35, delay: 0.15, duration: 3.2, color: 0xff6a2a, lingering: true,
          });
        }
        break;
      case 'shockNova':
        this.affixTimer = 3.2;
        if (this.distToPlayer < 24) {
          this.game.fx.ring(this.position, 1, 9, 0xffe04b, 0.4, 0.9);
          if (this.distToPlayer < 9) player.takeDamage(this.damage * 0.6, { source: 'Overcharged' });
          this.game.fx.lightning(this.center, player.chestPosition, 0xffe04b, 0.2, 6);
        }
        break;
      case 'voidPull':
        this.affixTimer = 0.1;
        if (this.distToPlayer < 18 && this.distToPlayer > 2) {
          _dir.copy(this.position).sub(player.position).setY(0).normalize().multiplyScalar(3.2 * dt * 10);
          player.velocity.add(_dir);
        }
        break;
    }
  }

  _updateModel(dt, player) {
    const m = this.model;
    m.position.copy(this.position);
    m.rotation.y = this.yaw;

    const ud = m.userData;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.walkPhase += dt * (2 + speed * 0.85);

    if (ud.legL && ud.legR) {
      const sw = Math.sin(this.walkPhase * 2) * clamp01(speed / this.speed) * 0.85;
      ud.legL.rotation.x = sw;
      ud.legR.rotation.x = -sw;
      if (ud.legBL) { ud.legBL.rotation.x = -sw; ud.legBR.rotation.x = sw; }
    }
    if (ud.armL && ud.armR) {
      const windup = this.state === 'windup' ? 1 - clamp01(this.windupTimer / Math.max(0.01, this.def.windup)) : 0;
      const sw = Math.sin(this.walkPhase * 2) * 0.4 * clamp01(speed / this.speed);
      const raise = windup * -2.3;
      ud.armL.rotation.x = damp(ud.armL.rotation.x, -sw + raise, 16, dt);
      ud.armR.rotation.x = damp(ud.armR.rotation.x, sw + raise, 16, dt);
    }
    if (ud.torso) ud.torso.position.y = (ud.torso.userData.baseY ??= ud.torso.position.y) + Math.sin(this.walkPhase * 4) * 0.03 * clamp01(speed / this.speed);
    if (ud.hover) {
      // Gentle bob only — a big vertical wobble makes flyers unhittable.
      m.position.y += Math.sin(this.game.time * 1.5 + this.walkPhase) * 0.1;
      if (ud.core) ud.core.rotation.y += dt * 1.1;
    }
    if (ud.rings) { ud.rings.rotation.y += dt * 0.9; ud.rings.rotation.x += dt * 0.4; }
    if (ud.tail) ud.tail.rotation.y = Math.sin(this.game.time * 3) * 0.35;
    if (ud.cannonL) {
      const aim = Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z) - this.yaw;
      ud.cannonL.rotation.y = damp(ud.cannonL.rotation.y, aim, 8, dt);
      ud.cannonR.rotation.y = ud.cannonL.rotation.y;
    }

    // Hit flash + windup tell
    const windupGlow = this.state === 'windup' ? 1 - clamp01(this.windupTimer / Math.max(0.01, this.def.windup)) : 0;
    const flash = Math.max(this.hitFlash, windupGlow * 0.55);
    if (flash > 0.001 || this._wasFlashing) {
      for (const rec of this.baseMaterials) {
        rec.mat.color.copy(rec.color).lerp(WHITE, flash * 0.85);
      }
      this._wasFlashing = flash > 0.001;
    }
    if (this.aura) this.aura.material.opacity = 0.1 + Math.sin(this.game.time * 3 + this.walkPhase) * 0.04;

    if (this.healthBar) {
      const bar = this.healthBar;
      bar.group.quaternion.copy(this.game.engine.camera.quaternion);
      const f = clamp01(this.health / this.maxHealth);
      bar.fill.scale.x = Math.max(0.001, f);
      bar.fill.position.x = -(bar.width * (1 - f)) / 2;
    }
  }

  dispose() {
    this.model.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
    });
    this.model.parent?.remove(this.model);
  }
}

const WHITE = new THREE.Color(0xffffff);

/* ========================================================================== */

export class EnemyManager {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.byNetId = new Map();
    this._nextNetId = 1;
  }

  spawn(defId, position, opts = {}) {
    const def = ENEMIES_BY_ID[defId];
    if (!def) return null;
    const e = new Enemy(this.game, def, position, opts);
    // Every enemy carries an id whether or not anyone is listening, so a
    // teammate joining mid-run can be handed the fight already in progress.
    e.netId = this._nextNetId++;
    this.byNetId.set(e.netId, e);
    this.list.push(e);
    this.game.profile.noteEnemySeen(defId);
    this.game.coop?.onEnemySpawned(e);
    return e;
  }

  /** A body the host owns: no AI here, only the transform it sends us. */
  spawnGhost(defId, netId, position, opts = {}) {
    const def = ENEMIES_BY_ID[defId];
    if (!def || this.byNetId.has(netId)) return null;
    const e = new Enemy(this.game, def, position, { ...opts, ghost: true, netId });
    if (opts.maxHealth) { e.maxHealth = opts.maxHealth; e.health = opts.health ?? opts.maxHealth; }
    this.byNetId.set(netId, e);
    this.list.push(e);
    this.game.profile.noteEnemySeen(defId);
    return e;
  }

  /**
   * Picks who each enemy is fighting.
   *
   * Re-chosen on a slow timer rather than every frame: an enemy that swaps
   * target the instant two players cross paths reads as indecisive, and the
   * cost of the scan adds up across forty of them.
   */
  _chooseTarget(e, party, dt, fallback) {
    if (party.length <= 1) return party[0] || fallback;
    e.targetTimer = (e.targetTimer ?? 0) - dt;
    if (e.aggroTarget && !e.aggroTarget.dead && e.targetTimer > 0) return e.aggroTarget;
    e.targetTimer = 0.6 + Math.random() * 0.5;
    let best = null;
    let bestDist = Infinity;
    for (const p of party) {
      const d = p.position.distanceToSquared(e.position);
      // Stickiness, so the current target has to be clearly beaten to be dropped.
      const bias = p === e.aggroTarget ? 0.7 : 1;
      if (d * bias < bestDist) { bestDist = d * bias; best = p; }
    }
    e.aggroTarget = best;
    return best || fallback;
  }

  update(dt, player, world) {
    const party = this.game.party();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.dead) {
        if (e.netId) this.byNetId.delete(e.netId);
        e.dispose();
        this.list.splice(i, 1);
        continue;
      }
      e.update(dt, this._chooseTarget(e, party, dt, player), world);
    }
  }

  /** Nearest enemy hit along a ray. */
  raycast(origin, dir, maxDist, exclude = null) {
    let best = null;
    for (const e of this.list) {
      if (e.dead || e === exclude || e.spawnAnim > 0.6) continue;
      const t = rayCapsule(origin, dir, e.position, e.radius * 1.15, e.height);
      if (t !== null && t >= 0 && t <= maxDist && (!best || t < best.distance)) {
        best = { distance: t, enemy: e };
      }
    }
    return best;
  }

  inRadius(pos, radius, exclude = null) {
    const out = [];
    const r2 = radius * radius;
    for (const e of this.list) {
      if (e.dead || e === exclude) continue;
      const dx = e.position.x - pos.x;
      const dy = (e.position.y + e.height * 0.5) - pos.y;
      const dz = e.position.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(e);
    }
    return out;
  }

  nearest(pos, radius, count = 1, exclude = null) {
    const found = this.inRadius(pos, radius, exclude);
    found.sort((a, b) => a.position.distanceToSquared(pos) - b.position.distanceToSquared(pos));
    return found.slice(0, count);
  }

  get aliveCount() { return this.list.length; }

  killAll(reason = 'cleanup') {
    for (const e of [...this.list]) {
      if (!e.boss) e.die({ source: reason, silent: true });
    }
  }

  clear() {
    for (const e of this.list) e.dispose();
    this.list.length = 0;
    this.byNetId.clear();
  }
}
