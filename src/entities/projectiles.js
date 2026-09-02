import * as THREE from 'three';
import { raycastWorld, distanceToBody } from '../systems/physics.js';
import { fx as rng } from '../core/rng.js';
import { aimYaw, aimPitch } from '../core/mathx.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e = new THREE.Euler();
const _roll = new THREE.Quaternion();
const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * Points a travelling crescent along the way it is actually going.
 *
 * A wave used to be turned about Y alone, which meant a cut thrown at
 * something above you arrived as a flat disc hanging in the air at the height
 * you threw it from — the same orientation every time, whatever you were
 * aiming at. Both angles come off the velocity now.
 *
 * The roll is what keeps it from vanishing: a crescent is paper thin, and one
 * travelling level with no cant at all is invisible edge-on from a camera
 * sitting at about its own height, which is where the camera always is.
 */
function orientWave(mesh, velocity, roll = 0.22) {
  _e.set(aimPitch(velocity.x, velocity.y, velocity.z), aimYaw(velocity.x, velocity.z), 0, 'YXZ');
  mesh.quaternion.setFromEuler(_e);
  if (roll) mesh.quaternion.multiply(_roll.setFromAxisAngle(FORWARD, roll));
}

/**
 * How much of its damage a projectile still has, this far from where it began.
 *
 * Linear between `near` and `far`, flat outside both. A shot with no falloff
 * spec is worth exactly what it was worth when it left, which is what almost
 * everything in the game wants.
 */
function falloffAt(p) {
  const f = p.falloff;
  if (!f) return 1;
  const d = p.position.distanceTo(p.origin);
  const near = f.near ?? 0;
  const far = f.far ?? 40;
  if (d <= near) return 1;
  const min = f.min ?? 0.3;
  if (d >= far) return min;
  return 1 - (1 - min) * ((d - near) / (far - near));
}

const SPHERE = new THREE.SphereGeometry(1, 10, 8);
const RING = (() => { const g = new THREE.RingGeometry(0.82, 1, 32); g.rotateX(-Math.PI / 2); return g; })();

/**
 * A crescent, lying flat, opening along +Z.
 *
 * This is what a thrown melee arc looks like in flight: the cut itself, still
 * travelling. Built once and shared — the alternative was a glowing ball, which
 * is what a horizontal slash absolutely does not leave behind.
 */
const CRESCENT = (() => {
  const arc = 2.0;
  const start = -Math.PI / 2 - arc / 2;
  const g = new THREE.RingGeometry(0.5, 1, 36, 1, start, arc);
  const pos = g.attributes.position;
  // Taper the band to a point at both tips, same trick the FX slashes use.
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 1e-6) continue;
    let theta = Math.atan2(y, x) - start;
    while (theta < 0) theta += Math.PI * 2;
    const u = Math.min(1, theta / arc);
    const taper = Math.pow(Math.sin(u * Math.PI), 0.6);
    const innerNow = 1 - 0.5 * taper;
    const t = (r - 0.5) / 0.5;
    const rNew = innerNow + t * (1 - innerNow);
    pos.setXY(i, (x / r) * rNew, (y / r) * rNew);
  }
  pos.needsUpdate = true;
  g.rotateX(-Math.PI / 2);
  return g;
})();

/**
 * Materials are cached by colour and shared.
 *
 * Every fresh material is a new shader program compile on first draw; a boss
 * volley spawning five projectiles a second was compiling five programs a second
 * and stalling the frame. These pools keep the program count flat.
 */
const matCache = new Map();
function glowMaterial(color) {
  if (!matCache.has(color)) {
    matCache.set(color, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  }
  return matCache.get(color);
}

const haloCache = new Map();
function haloMaterial(color) {
  if (!haloCache.has(color)) {
    haloCache.set(color, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  }
  return haloCache.get(color);
}

const hazardCache = new Map();
function hazardMaterial(color) {
  if (!hazardCache.has(color)) {
    hazardCache.set(color, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }));
  }
  return hazardCache.get(color);
}

const singularityCoreMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
const singularityHaloMat = new THREE.MeshBasicMaterial({
  color: 0xb473ff, transparent: true, opacity: 0.3,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
});

/**
 * One manager for everything that flies, falls, or festers: player bullets,
 * enemy shots, mortars, homing daggers, singularities and ground hazards.
 */
export class ProjectileManager {
  constructor(game) {
    this.game = game;
    this.bullets = [];
    this.hazards = [];
    this.singularities = [];
    this.group = new THREE.Group();
    game.engine.scene.add(this.group);
  }

  // ------------------------------------------------------------------ spawn
  spawn(spec) {
    const p = {
      position: spec.position.clone(),
      velocity: spec.velocity.clone(),
      damage: spec.damage ?? 0,
      proc: spec.proc ?? 1,
      radius: spec.radius ?? 0.2,
      life: spec.life ?? 3,
      maxLife: spec.life ?? 3,
      gravity: spec.gravity ?? 0,
      color: spec.color ?? 0xffffff,
      pierce: spec.pierce ?? 0,
      hostile: !!spec.hostile,
      splash: spec.splash || null,
      aura: spec.aura ? { ...spec.aura, timer: 0 } : null,
      homingRadius: spec.homingRadius ?? 0,
      homingStrength: spec.homingStrength ?? 0,
      target: spec.target || null,
      // A harpoon spec is the winch itself: { time, speed }. `true` still works
      // and takes the defaults, so nothing that passed a flag has to change.
      harpoon: spec.harpoon ? (spec.harpoon === true ? { time: 0.9, speed: 34 } : spec.harpoon) : null,
      wave: spec.wave ? { ...spec.wave, hits: new Set() } : null,
      onLand: spec.onLand || null,
      landed: false,
      detonateOnGround: !!spec.detonateOnGround,
      trail: spec.trail ?? 0,
      chill: spec.chill ?? 0,
      freeze: spec.freeze ?? 0,
      burn: spec.burn || null,
      knockback: spec.knockback ?? 0,
      source: spec.source ?? null,
      spin: spec.spin ?? 0,
      onHit: spec.onHit || null,
      hits: new Set(),
      trailTimer: 0,
      dead: false,
      crit: spec.crit ?? null,
      lifesteal: spec.lifesteal ?? 0,
      /* Distance falloff: `{ near, far, min }`.
         A pellet is devastating in somebody's face and merely useful across a
         room, and that is a property of the pellet rather than of the gun that
         threw it — so it lives here, measured from where the shot started,
         rather than being baked in at spawn time when nobody yet knows how far
         it is going to get. `min` is the floor: a scatter gun that keeps some
         of its bite at range keeps it because this number is not zero. */
      falloff: spec.falloff || null,
      origin: spec.position.clone(),
      dagger: !!spec.dagger,
      disc: !!spec.disc,
      slash: !!spec.slash,
      // Aura carriers (e.g. Overload Sphere) pass through everything and damage
      // purely through their pulse, so a stray wall does not end them early.
      ghost: !!spec.ghost || (!!spec.aura && !(spec.damage > 0) && !spec.splash),
    };

    const scale = p.radius * (spec.glow ?? 1);
    const mesh = p.wave
      ? new THREE.Mesh(CRESCENT, hazardMaterial(p.color))
      : new THREE.Mesh(SPHERE, glowMaterial(p.color));
    mesh.scale.setScalar(scale);
    mesh.position.copy(p.position);
    if (p.disc) mesh.scale.set(scale * 2.6, scale * 0.5, scale * 2.6);
    // A slash is a standing blade of energy: wide, tall, and paper thin, turned
    // to face the way it is travelling.
    if (p.slash) mesh.scale.set(scale * 2.2, scale * 2.9, scale * 0.32);
    if (p.wave) {
      const w = p.wave.width ?? p.radius * 1.4;
      mesh.scale.set(w, 1, w);
      orientWave(mesh, p.velocity);
    }
    this.group.add(mesh);
    p.mesh = mesh;

    if (spec.glow && spec.glow > 1) {
      const halo = new THREE.Mesh(SPHERE, haloMaterial(p.color));
      halo.scale.setScalar(scale * 2.4);
      mesh.add(halo);
    }

    this.bullets.push(p);
    return p;
  }

  /** Delayed indirect fire that lands at a target point. */
  spawnMortar({ target, scatter = 0, delay = 0, splash, color = 0xa8e070, source = null }) {
    const t = target.clone();
    t.x += rng.range(-scatter, scatter);
    t.z += rng.range(-scatter, scatter);
    t.y = this.game.arena.groundHeightAt(t.x, t.z);
    this.hazards.push({
      position: t, radius: splash.radius, damage: splash.damage, proc: splash.proc ?? 0.7,
      delay: delay + 0.85, duration: 0, color, hostile: false, source, mesh: this._hazardMesh(t, splash.radius, color),
      fired: false, mortar: true, lingering: false, tickTimer: 0,
    });
  }

  /** Telegraphed ground AoE. Enemy hazards damage the player, player hazards damage enemies. */
  spawnHazard(position, { radius, damage, delay = 0.6, duration = 0, color = 0xff6a2a, hostile = true, lingering = false, source = null }) {
    const pos = position.clone();
    pos.y = this.game.arena.groundHeightAt(pos.x, pos.z);
    this.hazards.push({
      position: pos, radius, damage, delay, duration, color, hostile, lingering,
      mesh: this._hazardMesh(pos, radius, color), fired: false, tickTimer: 0, proc: 0, source,
    });
  }

  _hazardMesh(pos, radius, color) {
    // Shared material: a boss slam spawns ten of these at once.
    const m = new THREE.Mesh(RING, hazardMaterial(color));
    m.position.copy(pos);
    m.position.y += 0.08;
    m.scale.setScalar(radius);
    this.group.add(m);
    return m;
  }

  spawnSingularity(position, radius, damage) {
    const mesh = new THREE.Mesh(SPHERE, singularityCoreMat);
    mesh.scale.setScalar(1.2);
    mesh.position.copy(position);
    mesh.position.y += 1.5;
    const halo = new THREE.Mesh(SPHERE, singularityHaloMat);
    halo.scale.setScalar(2.1);
    mesh.add(halo);
    this.group.add(mesh);
    this.singularities.push({ position: mesh.position.clone(), radius, damage, life: 2.6, maxLife: 2.6, mesh, tickTimer: 0 });
    this.game.fx.ring(position, 1, radius, 0xb473ff, 0.6, 0.9);
  }

  // ------------------------------------------------------------------ update
  update(dt, player, world) {
    this._updateBullets(dt, player, world);
    this._updateHazards(dt, player);
    this._updateSingularities(dt, player);
  }

  _updateBullets(dt, player, world) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const p = this.bullets[i];
      p.life -= dt;
      if (p.life <= 0 || p.dead) {
        if (p.splash && !p.dead) this._detonate(p, _v.copy(p.velocity).normalize());
        if (!p.dead) this._land(p);
        this._destroy(p, i);
        continue;
      }

      // Homing
      if (p.homingRadius > 0 || p.target) {
        let tgt = p.target;
        if (!tgt || tgt.dead) {
          const found = p.hostile
            ? null
            : this.game.enemies.nearest(p.position, p.homingRadius || 12, 1)[0];
          tgt = found || null;
          if (p.homingRadius > 0) p.target = tgt;
        }
        if (tgt && !tgt.dead) {
          const want = _v.copy(tgt.center).sub(p.position).normalize();
          const speed = p.velocity.length();
          p.velocity.lerp(want.multiplyScalar(speed), Math.min(1, (p.homingStrength || 4) * dt));
          p.velocity.setLength(speed);
        }
      }

      p.velocity.y += p.gravity * dt;
      _v.copy(p.velocity).multiplyScalar(dt);
      const step = _v.length();
      const dir = _v2.copy(p.velocity).normalize();

      // World collision along the step
      const worldHit = p.ghost ? null : raycastWorld(p.position, dir, step + p.radius, world);

      // Entity collision
      let entityHit = null;
      if (p.ghost) {
        entityHit = null;
      } else if (p.hostile) {
        const d = distanceToBody(p.position, player);
        if (d < p.radius + player.radius + 0.2) entityHit = { entity: player, distance: 0 };
        else {
          // Lizards are not targeted, but they do stop bullets meant for you.
          const shielded = this.game.pets?.inRadius(p.position, p.radius + 0.7) || [];
          if (shielded.length) entityHit = { entity: shielded[0], distance: 0 };
        }
      } else {
        const hit = this.game.enemies.raycast(p.position, dir, step + p.radius);
        if (hit && !p.hits.has(hit.enemy)) entityHit = { entity: hit.enemy, distance: hit.distance };
      }

      if (entityHit && (!worldHit || entityHit.distance <= worldHit.distance)) {
        p.position.addScaledVector(dir, Math.max(0, entityHit.distance));
        const done = this._onEntityHit(p, entityHit.entity, dir, player);
        if (done) { this._destroy(p, i); continue; }
      } else if (worldHit && worldHit.distance <= step + p.radius) {
        p.position.addScaledVector(dir, Math.max(0, worldHit.distance - 0.02));
        this._detonate(p, dir);
        this._land(p);
        this._destroy(p, i);
        continue;
      } else {
        p.position.add(_v);
      }

      // Slash waves cut everything they sweep across, once each. A raycast
      // down the centre line would let a wave the width of a car pass through
      // a body standing half a metre off its axis.
      if (p.wave) {
        const w = p.wave;
        for (const e of this.game.enemies.inRadius(p.position, w.width ?? p.radius * 1.4)) {
          if (w.hits.has(e)) continue;
          w.hits.add(e);
          this.game.combat.damageEnemy(e, w.damage, {
            proc: w.proc ?? 0.6, source: p.source, lifesteal: w.lifesteal ?? 0,
            hitPoint: e.center.clone(),
          });
          this.game.fx.impact(e.center, _v2.copy(p.velocity).normalize().negate(), w.color ?? p.color, 1.2);
        }
      }

      // Aura damage (Overload Sphere)
      if (p.aura) {
        p.aura.timer -= dt;
        if (p.aura.timer <= 0) {
          p.aura.timer = p.aura.interval;
          const targets = this.game.enemies.inRadius(p.position, p.aura.radius);
          for (const e of targets) {
            this.game.combat.damageEnemy(e, p.aura.damage, { proc: p.aura.proc, source: 'Overload Sphere' });
            this.game.fx.lightning(p.position, e.center, p.aura.color, 0.12, 4);
          }
          this.game.fx.ring(p.position, p.aura.radius * 0.4, p.aura.radius, p.aura.color, 0.35, 0.5);
        }
      }

      p.mesh.position.copy(p.position);
      if (p.disc) p.mesh.rotation.y += dt * 26;
      if (p.slash) {
        _v2.copy(p.position).add(p.velocity);
        p.mesh.lookAt(_v2);
        p.mesh.rotateZ(p.spin ?? 0);
      }
      if (p.wave) {
        // Fade and spread as it goes, so a wave reads as losing coherence
        // rather than as a solid object that suddenly stops existing.
        const k = p.life / p.maxLife;
        const w = (p.wave.width ?? p.radius * 1.4) * (1 + (1 - k) * 0.5);
        p.mesh.scale.set(w, 1, w);
        // Re-aimed every frame, not just at spawn: gravity and drag bend the
        // path, and a cut that keeps its launch angle while falling reads as a
        // dropped object rather than as a cut still travelling.
        orientWave(p.mesh, p.velocity);
      }

      // Trail
      if (p.trail > 0) {
        p.trailTimer -= dt;
        if (p.trailTimer <= 0) {
          p.trailTimer = 0.02;
          this.game.fx.spawnParticle(p.position, _v.set(0, 0, 0), {
            color: p.color, size: p.radius * 1.4 * p.trail, life: 0.22, gravity: 0, drag: 1,
          });
        }
      }
    }
  }

  _onEntityHit(p, entity, dir, player) {
    if (p.hostile) {
      // Splash shots damage through _detonate (with falloff); direct shots hit here.
      if (p.splash) {
        this._detonate(p, dir);
      } else {
        entity.takeDamage(p.damage, { source: p.source });
        this.game.fx.impact(p.position, dir.clone().negate(), p.color, 1.3);
      }
      p.sourceEnemy?.elite?.onHitPlayer?.({
        enemy: p.sourceEnemy,
        applyPlayerStatus: (id, dur, data) => player.applyStatus(id, dur, data),
      });
      return true;
    }

    p.hits.add(entity);
    const opts = {
      proc: p.proc, source: p.source, hitPoint: p.position.clone(),
      knockback: p.knockback, knockbackDir: dir.clone(), chill: p.chill, freeze: p.freeze,
      burn: p.burn, lifesteal: p.lifesteal,
    };
    if (p.splash) {
      this._detonate(p, dir);
      return true;
    }
    this.game.combat.damageEnemy(entity, p.damage * falloffAt(p), opts);
    this.game.fx.impact(p.position, dir.clone().negate(), p.color, 1);

    if (p.harpoon && !entity.dead) {
      // The winch, not a shove. A single impulse was the old behaviour and it
      // barely moved anything heavy — the target is now reeled in under power
      // for the whole duration, which is what a harpoon is for.
      entity.applyStatus('pulled', p.harpoon.time ?? 0.9, {
        target: player, speed: p.harpoon.speed ?? 34, color: p.harpoon.color ?? p.color,
      });
      entity.grounded = false;
      this.game.fx.beam(player.chestPosition, entity.center, p.color, 0.3, 0.07);
    }
    if (p.onHit) p.onHit(entity, p);
    this._land(p);

    if (p.pierce > 0) { p.pierce--; return false; }
    return true;
  }

  _detonate(p, dir) {
    if (!p.splash) {
      this.game.fx.impact(p.position, dir.clone().negate(), p.color, 1);
      return;
    }
    const s = p.splash;
    this.game.fx.explosion(p.position, s.radius, s.color ?? p.color, 1);
    this.game.engine.addShake(Math.min(0.25, s.radius * 0.02));
    if (p.hostile) {
      const d = distanceToBody(p.position, this.game.player);
      if (d < s.radius) {
        const falloff = 1 - Math.min(1, d / s.radius) * 0.5;
        this.game.player.takeDamage(s.damage * falloff, { source: p.source });
      }
      for (const m of this.game.pets?.inRadius(p.position, s.radius) || []) {
        const md = m.position.distanceTo(p.position);
        m.takeDamage(s.damage * (1 - Math.min(1, md / s.radius) * 0.5) * 0.6, { source: p.source });
      }
    } else {
      this.game.combat.areaDamage(p.position, s.radius, s.damage, {
        proc: s.proc ?? 1, source: p.source, force: s.force ?? 0,
        chill: p.chill, freeze: p.freeze, burn: p.burn,
      });
    }
  }

  /** Fires a projectile's `onLand` exactly once, wherever it ended up. */
  _land(p) {
    if (!p.onLand || p.landed) return;
    p.landed = true;
    p.onLand(p.position.clone(), p);
  }

  _destroy(p, index) {
    // Geometry and materials are both shared pools now — nothing to dispose.
    if (p.mesh) this.group.remove(p.mesh);
    this.bullets.splice(index, 1);
  }

  _updateHazards(dt, player) {
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      if (!h.fired) {
        h.delay -= dt;
        const warn = 1 - Math.max(0, Math.min(1, h.delay / 0.9));
        h.mesh.scale.setScalar(h.radius * (0.7 + warn * 0.3));
        if (h.delay <= 0) {
          h.fired = true;
          this.game.fx.explosion(h.position, h.radius, h.color, h.mortar ? 1 : 0.8);
          this._hazardDamage(h, player, 1);
          if (h.duration <= 0) { this._removeHazard(h, i); continue; }
        }
        continue;
      }
      h.duration -= dt;
      h.mesh.scale.setScalar(h.radius * (0.97 + Math.sin(this.game.time * 9) * 0.03));
      h.tickTimer -= dt;
      if (h.tickTimer <= 0) {
        h.tickTimer = 0.5;
        this._hazardDamage(h, player, 0.3);
      }
      if (h.duration <= 0) this._removeHazard(h, i);
    }
  }

  _hazardDamage(h, player, scale) {
    if (h.hostile) {
      const d = Math.hypot(player.position.x - h.position.x, player.position.z - h.position.z);
      if (d < h.radius && Math.abs(player.position.y - h.position.y) < 4) {
        player.takeDamage(h.damage * scale, { source: h.source || 'Hazard' });
      }
    } else {
      this.game.combat.areaDamage(h.position, h.radius, h.damage * scale, { proc: h.proc, source: h.source });
    }
  }

  _removeHazard(h, i) {
    this.group.remove(h.mesh);      // material is pooled by colour
    this.hazards.splice(i, 1);
  }

  _updateSingularities(dt, player) {
    for (let i = this.singularities.length - 1; i >= 0; i--) {
      const s = this.singularities[i];
      s.life -= dt;
      const k = s.life / s.maxLife;
      s.mesh.scale.setScalar(1.2 * (0.4 + k * 0.8));
      s.mesh.rotation.y += dt * 3;

      const targets = this.game.enemies.inRadius(s.position, s.radius);
      for (const e of targets) {
        _v.copy(s.position).sub(e.position).setY(0);
        const d = _v.length();
        if (d > 1) {
          _v.divideScalar(d).multiplyScalar(dt * 26 * (1 - d / s.radius));
          e.velocity.add(_v);
        }
      }
      s.tickTimer -= dt;
      if (s.tickTimer <= 0) {
        s.tickTimer = 0.35;
        this.game.combat.areaDamage(s.position, s.radius * 0.55, s.damage * 0.18, { proc: 0.2, source: 'Singularity Core' });
      }

      if (s.life <= 0) {
        this.game.fx.explosion(s.position, s.radius, 0xb473ff, 1.5);
        this.game.combat.areaDamage(s.position, s.radius, s.damage, { proc: 0, source: 'Singularity Core' });
        this.game.engine.addShake(0.3);
        this.group.remove(s.mesh);
        this.singularities.splice(i, 1);
      }
    }
  }

  clear() {
    for (const p of this.bullets) this.group.remove(p.mesh);
    for (const h of this.hazards) this.group.remove(h.mesh);
    for (const s of this.singularities) this.group.remove(s.mesh);
    this.bullets.length = 0;
    this.hazards.length = 0;
    this.singularities.length = 0;
  }
}
