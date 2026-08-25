import * as THREE from 'three';
import { fx as rng } from '../core/rng.js';
import { audio } from '../core/audio.js';
import { aimYaw, aimPitch } from '../core/mathx.js';

const MAX_PARTICLES = 2600;
const MAX_BEAMS = 90;
const MAX_RINGS = 70;
const MAX_SPRITES = 220;
const MAX_SLASHES = 24;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _e = new THREE.Euler();
const _q2 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * Pooled visual effects. Everything is drawn from fixed-size instanced meshes so
 * a heavy fight never allocates mid-frame.
 */
export class FX {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;
    this._buildParticles();
    this._buildBeams();
    this._buildRings();
    this._buildSlashes();
    this._buildSprites();
    this.lights = [];
    this.lightScale = 1;      // driven by adaptive quality
    this._buildLights();
  }

  // ---------------------------------------------------------------- particles
  _buildParticles() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // Normal blending, depth-written: debris is solid matter, not light. It fades by
    // shrinking rather than dimming, which works on light and dark themes alike.
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.pMesh = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES);
    this.pMesh.frustumCulled = false;
    this.pMesh.count = 0;
    this.pMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.scene.add(this.pMesh);

    this.particles = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles[i] = {
        active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        life: 0, maxLife: 1, size: 0.2, color: new THREE.Color(), gravity: -12,
        drag: 0.985, spin: 0, rot: 0, fade: 1,
      };
    }
    this.pCursor = 0;
  }

  _particle() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const idx = (this.pCursor + i) % MAX_PARTICLES;
      if (!this.particles[idx].active) { this.pCursor = (idx + 1) % MAX_PARTICLES; return this.particles[idx]; }
    }
    this.pCursor = (this.pCursor + 1) % MAX_PARTICLES;
    return this.particles[this.pCursor];
  }

  spawnParticle(pos, vel, { color = 0xffffff, size = 0.2, life = 0.6, gravity = -12, drag = 0.985, spin = 0 } = {}) {
    const p = this._particle();
    p.active = true;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.life = p.maxLife = life;
    p.size = size;
    p.color.setHex(color);
    p.gravity = gravity;
    p.drag = drag;
    p.spin = spin;
    p.rot = rng.next() * Math.PI;
    return p;
  }

  burst(pos, count, opts = {}) {
    const speed = opts.speed ?? 7;
    for (let i = 0; i < count; i++) {
      const dir = _v.set(rng.range(-1, 1), rng.range(-0.3, 1), rng.range(-1, 1)).normalize();
      this.spawnParticle(pos, dir.multiplyScalar(speed * rng.range(0.35, 1.2)), {
        ...opts,
        size: (opts.size ?? 0.22) * rng.range(0.6, 1.4),
        life: (opts.life ?? 0.6) * rng.range(0.7, 1.3),
      });
    }
  }

  // ---------------------------------------------------------------- beams
  _buildBeams() {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    geo.translate(0, 0.5, 0);
    geo.rotateX(Math.PI / 2);   // aim along +Z
    const mat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.bMesh = new THREE.InstancedMesh(geo, mat, MAX_BEAMS);
    this.bMesh.frustumCulled = false;
    this.bMesh.count = 0;
    this.bMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 3), 3);
    this.scene.add(this.bMesh);
    this.beams = Array.from({ length: MAX_BEAMS }, () => ({
      active: false, from: new THREE.Vector3(), to: new THREE.Vector3(),
      life: 0, maxLife: 0.1, width: 0.05, color: new THREE.Color(),
    }));
    this.bCursor = 0;
  }

  beam(from, to, color = 0xffffff, life = 0.12, width = 0.05) {
    let slot = null;
    for (let i = 0; i < MAX_BEAMS; i++) {
      const idx = (this.bCursor + i) % MAX_BEAMS;
      if (!this.beams[idx].active) { slot = this.beams[idx]; this.bCursor = (idx + 1) % MAX_BEAMS; break; }
    }
    if (!slot) { slot = this.beams[this.bCursor]; this.bCursor = (this.bCursor + 1) % MAX_BEAMS; }
    slot.active = true;
    slot.from.copy(from);
    slot.to.copy(to);
    slot.life = slot.maxLife = life;
    slot.width = width;
    slot.color.setHex(color);
  }

  /** Jagged multi-segment lightning between two points. */
  lightning(from, to, color = 0x9fd0ff, life = 0.14, segments = 5) {
    const dir = _v.copy(to).sub(from);
    const len = dir.length();
    const step = 1 / segments;
    let prev = from.clone();
    for (let i = 1; i <= segments; i++) {
      const t = i * step;
      const point = from.clone().addScaledVector(dir, t);
      if (i < segments) {
        point.x += rng.range(-1, 1) * len * 0.055;
        point.y += rng.range(-1, 1) * len * 0.055;
        point.z += rng.range(-1, 1) * len * 0.055;
      }
      this.beam(prev, point, color, life, 0.05);
      prev = point;
    }
  }

  // ---------------------------------------------------------------- rings
  _buildRings() {
    const geo = new THREE.RingGeometry(0.86, 1, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.rMesh = new THREE.InstancedMesh(geo, mat, MAX_RINGS);
    this.rMesh.frustumCulled = false;
    this.rMesh.count = 0;
    this.rMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 3), 3);
    this.scene.add(this.rMesh);
    this.rings = Array.from({ length: MAX_RINGS }, () => ({
      active: false, pos: new THREE.Vector3(), r0: 1, r1: 6, life: 0, maxLife: 0.5,
      color: new THREE.Color(), vertical: false, opacity: 1,
    }));
    this.rCursor = 0;
  }

  ring(pos, r0, r1, color = 0xffffff, life = 0.45, opacity = 1) {
    let slot = null;
    for (let i = 0; i < MAX_RINGS; i++) {
      const idx = (this.rCursor + i) % MAX_RINGS;
      if (!this.rings[idx].active) { slot = this.rings[idx]; this.rCursor = (idx + 1) % MAX_RINGS; break; }
    }
    if (!slot) { slot = this.rings[this.rCursor]; this.rCursor = (this.rCursor + 1) % MAX_RINGS; }
    slot.active = true;
    slot.pos.copy(pos);
    slot.pos.y += 0.12;
    slot.r0 = r0; slot.r1 = r1;
    slot.life = slot.maxLife = life;
    slot.color.setHex(color);
    slot.opacity = opacity;
  }

  // ---------------------------------------------------------------- slashes
  /**
   * Crescent cuts.
   *
   * A swing used to be drawn as nine short beams fanned out from the chest,
   * which at close range is exactly what it sounds like: a row of blocks. This
   * is one arc — a ring sector tapered to a point at both ends — drawn in the
   * plane the blade actually travelled through. No glow sprite behind it: the
   * gradient halo those left around the swing read as fog and buried the edge
   * it was supposed to be selling.
   */
  _buildSlashes() {
    const arc = 2.2;
    const inner = 0.62;
    const start = -Math.PI / 2 - arc / 2;
    const geo = new THREE.RingGeometry(inner, 1, 44, 1, start, arc);

    // A ring sector has the same width all the way round, which reads as a
    // piece of a circle. Pull the inner edge out toward the rim at both ends so
    // the band is fattest through the middle of the sweep and closes to a point
    // at the tips — the shape a blade leaves.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.hypot(x, y);
      if (r < 1e-6) continue;
      let theta = Math.atan2(y, x) - start;
      while (theta < 0) theta += Math.PI * 2;
      const u = Math.min(1, theta / arc);
      const taper = Math.pow(Math.sin(u * Math.PI), 0.55);   // 1 mid-sweep, 0 at the tips
      const innerNow = 1 - (1 - inner) * taper;
      const t = (r - inner) / (1 - inner);                   // 0 inner edge, 1 outer edge
      const rNew = innerNow + t * (1 - innerNow);
      pos.setXY(i, (x / r) * rNew, (y / r) * rNew);
    }
    pos.needsUpdate = true;

    // Ring geometry is born in XY; the sweep happens in the ground plane, and
    // after this rotation theta = -90° points down +Z, which is "forward".
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    });
    this.slMesh = new THREE.InstancedMesh(geo, mat, MAX_SLASHES);
    this.slMesh.frustumCulled = false;
    this.slMesh.count = 0;
    this.slMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SLASHES * 3), 3);
    this.scene.add(this.slMesh);
    this.slashes = Array.from({ length: MAX_SLASHES }, () => ({
      active: false, pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
      radius: 5, grow: 1.2, life: 0, maxLife: 0.22, color: new THREE.Color(),
    }));
    this.slCursor = 0;
  }

  /**
   * One crescent, centred on `pos`, opening along `dir`.
   *
   * `tilt` rolls the arc out of the horizontal: 0 is a flat sweep, ±1 a
   * diagonal cut through the same plane the blade swung in.
   */
  slash(pos, dir, { color = 0xffffff, radius = 5, life = 0.22, tilt = 0, grow = 1.25 } = {}) {
    let slot = null;
    for (let i = 0; i < MAX_SLASHES; i++) {
      const idx = (this.slCursor + i) % MAX_SLASHES;
      if (!this.slashes[idx].active) { slot = this.slashes[idx]; this.slCursor = (idx + 1) % MAX_SLASHES; break; }
    }
    if (!slot) { slot = this.slashes[this.slCursor]; this.slCursor = (this.slCursor + 1) % MAX_SLASHES; }
    slot.active = true;
    slot.pos.copy(pos);
    /* The cut is angled by the direction it was thrown, not merely turned to
       face it. It used to take only the yaw, so every crescent lay flat in the
       ground plane however steeply you were aiming: swing up at something
       overhead and the damage went up while the cut stayed at your feet. Both
       angles now come off `dir`, so a swing up a slope leaves a cut lying up
       the slope and one at a flyer is a cut through the air above you.

       `tilt` is the roll about that direction — the cant of the stroke — and
       is applied afterwards, in the cut's own frame, so it keeps meaning the
       same thing whichever way the swing is pointed. */
    _e.set(aimPitch(dir.x, dir.y, dir.z), aimYaw(dir.x, dir.z), 0, 'YXZ');
    slot.quat.setFromEuler(_e);
    if (tilt) slot.quat.multiply(_q2.setFromAxisAngle(FORWARD, tilt));
    slot.radius = radius;
    slot.grow = grow;
    slot.life = slot.maxLife = life;
    slot.color.setHex(color);
  }

  // ---------------------------------------------------------------- sprites (billboarded glows)
  _buildSprites() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const tex = this._glowTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.sMesh = new THREE.InstancedMesh(geo, mat, MAX_SPRITES);
    this.sMesh.frustumCulled = false;
    this.sMesh.count = 0;
    this.sMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRITES * 3), 3);
    this.scene.add(this.sMesh);
    this.sprites = Array.from({ length: MAX_SPRITES }, () => ({
      active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      size: 1, grow: 0, life: 0, maxLife: 0.4, color: new THREE.Color(),
    }));
    this.sCursor = 0;
  }

  _glowTexture() {
    const s = 64;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  glow(pos, { color = 0xffffff, size = 2, life = 0.35, grow = 3, vel = null } = {}) {
    let slot = null;
    for (let i = 0; i < MAX_SPRITES; i++) {
      const idx = (this.sCursor + i) % MAX_SPRITES;
      if (!this.sprites[idx].active) { slot = this.sprites[idx]; this.sCursor = (idx + 1) % MAX_SPRITES; break; }
    }
    if (!slot) { slot = this.sprites[this.sCursor]; this.sCursor = (this.sCursor + 1) % MAX_SPRITES; }
    slot.active = true;
    slot.pos.copy(pos);
    slot.vel.copy(vel || _v.set(0, 0, 0));
    slot.size = size; slot.grow = grow;
    slot.life = slot.maxLife = life;
    slot.color.setHex(color);
  }

  // ---------------------------------------------------------------- dynamic lights
  /**
   * Dynamic lights are allocated once and never toggled.
   *
   * three.js bakes the visible light count into every material's shader, so
   * flipping `visible` on a PointLight invalidates and recompiles the program
   * for every material in the scene. Explosions did exactly that several times a
   * second, which cost hundreds of milliseconds per frame. Keeping the count
   * fixed and animating intensity to zero instead is visually identical and free.
   */
  _buildLights() {
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 20, 2);
      l.visible = true;              // never toggled — see above
      this.scene.add(l);
      this.lights.push({ light: l, life: 0, maxLife: 1, power: 0 });
    }
    this.lCursor = 0;
  }

  flash(pos, color = 0xffaa55, power = 18, life = 0.25, distance = 26) {
    const slot = this.lights[this.lCursor];
    this.lCursor = (this.lCursor + 1) % this.lights.length;
    slot.light.position.copy(pos);
    slot.light.color.setHex(color);
    slot.light.distance = distance;
    slot.life = slot.maxLife = life;
    slot.power = power * this.lightScale;
  }

  // ---------------------------------------------------------------- composites
  explosion(pos, radius, color = 0xff8a3d, intensity = 1) {
    // Every explosion in the game comes through here, so this is the one place
    // the bang has to be hooked up — a new weapon that detonates something gets
    // its sound for nothing.
    audio.explosion(pos, radius * intensity);
    this.ring(pos, radius * 0.25, radius, color, 0.42 + intensity * 0.12, 0.95);
    this.glow(pos, { color, size: radius * 0.9, life: 0.26, grow: radius * 1.4 });
    this.burst(pos, Math.min(46, Math.round(12 + radius * 2.2 * intensity)), {
      color, speed: 5 + radius * 0.9, size: 0.2 + radius * 0.028, life: 0.55, gravity: -14,
    });
    this.flash(pos, color, 14 * intensity + radius, 0.22, radius * 3.4);
  }

  impact(pos, normal, color = 0xffe0a0, scale = 1) {
    audio.impact(pos, scale > 1.2);
    for (let i = 0; i < 6; i++) {
      const dir = _v.copy(normal).add(
        new THREE.Vector3(rng.range(-0.7, 0.7), rng.range(-0.4, 0.9), rng.range(-0.7, 0.7)),
      ).normalize();
      this.spawnParticle(pos, dir.multiplyScalar(rng.range(2.5, 7) * scale), {
        color, size: 0.09 * scale, life: 0.3, gravity: -18,
      });
    }
    this.glow(pos, { color, size: 0.9 * scale, life: 0.13, grow: 1.2 });
  }

  bloodSpray(pos, dir, color = 0xff4d5e, amount = 8) {
    for (let i = 0; i < amount; i++) {
      const v = _v.copy(dir).multiplyScalar(rng.range(1.5, 5))
        .add(new THREE.Vector3(rng.range(-2.4, 2.4), rng.range(0.6, 4.2), rng.range(-2.4, 2.4)));
      this.spawnParticle(pos, v, { color, size: 0.13, life: 0.5, gravity: -20, drag: 0.97 });
    }
  }

  deathBurst(pos, color, scale = 1) {
    this.burst(pos, Math.round(18 * scale), { color, speed: 8 * scale, size: 0.2 * scale, life: 0.7, gravity: -16 });
    this.ring(pos, 0.4, 3.4 * scale, color, 0.4, 0.7);
    this.glow(pos, { color, size: 2.2 * scale, life: 0.24, grow: 3.4 * scale });
  }

  muzzle(pos, dir, color = 0xffd58a, scale = 1) {
    this.glow(pos, { color, size: 0.85 * scale, life: 0.07, grow: 0.6 });
    for (let i = 0; i < 3; i++) {
      this.spawnParticle(pos, _v.copy(dir).multiplyScalar(rng.range(4, 11))
        .add(new THREE.Vector3(rng.range(-1.4, 1.4), rng.range(-1, 1.4), rng.range(-1.4, 1.4))), {
        color, size: 0.075 * scale, life: 0.11, gravity: -3,
      });
    }
    this.flash(pos, color, 4 * scale, 0.06, 9);
  }

  sporeRing(pos) { this.ring(pos, 0.6, 2.6, 0x7fe08a, 0.5, 0.35); }
  frostRing(pos, r) { this.ring(pos, r * 0.7, r, 0x9fe0ff, 0.42, 0.5); }
  shatter(pos) { this.burst(pos, 8, { color: 0xffd76e, speed: 6, size: 0.14, life: 0.4 }); }
  cloakBurst(pos) {
    this.ring(pos, 0.5, 5, 0xb8c8ff, 0.5, 0.6);
    this.burst(pos, 16, { color: 0xb8c8ff, speed: 5, size: 0.16, life: 0.55, gravity: -3 });
  }
  levelUp(pos) {
    audio.levelUp();
    this.ring(pos, 0.5, 6.5, 0x57b7ff, 0.75, 0.9);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      this.spawnParticle(
        _v.set(pos.x + Math.cos(a) * 1.6, pos.y + 0.2, pos.z + Math.sin(a) * 1.6),
        new THREE.Vector3(Math.cos(a) * 1.2, rng.range(6, 11), Math.sin(a) * 1.2),
        { color: 0x7fd0ff, size: 0.2, life: 0.9, gravity: -5, drag: 0.99 },
      );
    }
    this.flash(pos, 0x57b7ff, 22, 0.5, 30);
  }
  pickup(pos, color) {
    audio.gold(pos);
    this.ring(pos, 0.2, 2.2, color, 0.35, 0.8);
    this.burst(pos, 10, { color, speed: 4, size: 0.13, life: 0.45, gravity: -6 });
  }

  // ---------------------------------------------------------------- update
  update(dt, camera) {
    this.time += dt;

    // Particles.
    // Active instances are written consecutively from 0 and `count` is set to
    // however many there were, so an idle pool costs nothing to draw. Matrices
    // are rewritten every frame regardless, so the compaction is free.
    let write = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.vel.y += p.gravity * dt;
      p.vel.multiplyScalar(Math.pow(p.drag, dt * 60));
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.03) { p.pos.y = 0.03; p.vel.y *= -0.32; p.vel.x *= 0.7; p.vel.z *= 0.7; }
      p.rot += p.spin * dt;
      const k = p.life / p.maxLife;
      // Ease the last third to zero so chips vanish instead of popping.
      const shrink = k > 0.35 ? 1 : k / 0.35;
      const size = p.size * (0.55 + k * 0.55) * shrink * shrink;
      _q.setFromAxisAngle(UP, p.rot);
      _m.compose(p.pos, _q, _s.set(size, size, size));
      this.pMesh.setMatrixAt(write, _m);
      this.pMesh.setColorAt(write, _c.copy(p.color));
      write++;
    }
    this.pMesh.count = write;
    if (write) {
      this.pMesh.instanceMatrix.needsUpdate = true;
      if (this.pMesh.instanceColor) this.pMesh.instanceColor.needsUpdate = true;
    }

    // Beams
    write = 0;
    for (let i = 0; i < MAX_BEAMS; i++) {
      const b = this.beams[i];
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) { b.active = false; continue; }
      const k = b.life / b.maxLife;
      _v.copy(b.to).sub(b.from);
      const len = _v.length();
      _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _v.normalize());
      const w = b.width * (0.4 + k * 0.9);
      _m.compose(b.from, _q, _s.set(w, w, len));
      this.bMesh.setMatrixAt(write, _m);
      this.bMesh.setColorAt(write, _c.copy(b.color).multiplyScalar(0.3 + k));
      write++;
    }
    this.bMesh.count = write;
    if (write) {
      this.bMesh.instanceMatrix.needsUpdate = true;
      if (this.bMesh.instanceColor) this.bMesh.instanceColor.needsUpdate = true;
    }

    // Rings
    write = 0;
    for (let i = 0; i < MAX_RINGS; i++) {
      const r = this.rings[i];
      if (!r.active) continue;
      r.life -= dt;
      if (r.life <= 0) { r.active = false; continue; }
      const t = 1 - r.life / r.maxLife;
      const rad = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - t, 2.4));
      _m.compose(r.pos, _q.identity(), _s.set(rad, 1, rad));
      this.rMesh.setMatrixAt(write, _m);
      this.rMesh.setColorAt(write, _c.copy(r.color).multiplyScalar((1 - t) * r.opacity));
      write++;
    }
    this.rMesh.count = write;
    if (write) {
      this.rMesh.instanceMatrix.needsUpdate = true;
      if (this.rMesh.instanceColor) this.rMesh.instanceColor.needsUpdate = true;
    }

    // Slashes: open fast, thin out, gone. The arc widens by a fraction over its
    // life so the cut reads as travelling rather than as a decal.
    write = 0;
    for (let i = 0; i < MAX_SLASHES; i++) {
      const sl = this.slashes[i];
      if (!sl.active) continue;
      sl.life -= dt;
      if (sl.life <= 0) { sl.active = false; continue; }
      const t = 1 - sl.life / sl.maxLife;
      const rad = sl.radius * (0.82 + 0.18 * sl.grow * t);
      _m.compose(sl.pos, sl.quat, _s.set(rad, 1, rad));
      this.slMesh.setMatrixAt(write, _m);
      this.slMesh.setColorAt(write, _c.copy(sl.color).multiplyScalar(Math.pow(1 - t, 1.4)));
      write++;
    }
    this.slMesh.count = write;
    if (write) {
      this.slMesh.instanceMatrix.needsUpdate = true;
      if (this.slMesh.instanceColor) this.slMesh.instanceColor.needsUpdate = true;
    }

    // Billboarded glows
    write = 0;
    const camQ = camera.quaternion;
    for (let i = 0; i < MAX_SPRITES; i++) {
      const s = this.sprites[i];
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) { s.active = false; continue; }
      s.pos.addScaledVector(s.vel, dt);
      const t = 1 - s.life / s.maxLife;
      const size = s.size + s.grow * t;
      _m.compose(s.pos, camQ, _s.set(size, size, size));
      this.sMesh.setMatrixAt(write, _m);
      this.sMesh.setColorAt(write, _c.copy(s.color).multiplyScalar(1 - t));
      write++;
    }
    this.sMesh.count = write;
    if (write) {
      this.sMesh.instanceMatrix.needsUpdate = true;
      if (this.sMesh.instanceColor) this.sMesh.instanceColor.needsUpdate = true;
    }

    // Lights
    for (const l of this.lights) {
      if (l.life <= 0) { l.light.intensity = 0; continue; }
      l.life -= dt;
      l.light.intensity = l.life > 0 ? l.power * (l.life / l.maxLife) : 0;
    }
  }
}
