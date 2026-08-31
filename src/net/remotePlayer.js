import * as THREE from 'three';
import { PLAYER } from '../core/config.js';
import { clamp01 } from '../core/mathx.js';
import { buildPlayerModel, buildWeaponModel } from '../entities/models.js';
import { createRig, updateRig, rigRecoil, rigFlinch } from '../entities/characterRig.js';
import { characterById } from '../data/characters.js';
import { weaponById } from '../data/weapons.js';

const _v = new THREE.Vector3();

/**
 * A teammate's body.
 *
 * Two jobs. Visually it is the same rig as your own character, fed interpolated
 * state instead of input — which is the entire payoff for pulling the animation
 * out of Player in the first place.
 *
 * Mechanically it stands in for that player inside the host's simulation: it
 * answers to `position`, `radius`, `takeDamage` and friends, so the enemy AI can
 * chase it, hit it and shove it without knowing that the thing it is fighting is
 * actually a person on another machine. Damage is not resolved here — it is
 * forwarded to the owner, who applies their own armour and items to it.
 */
export class RemotePlayer {
  constructor(game, { id, name, character, weapon }) {
    this.game = game;
    this.id = id;
    this.name = name || 'Descender';
    this.char = characterById(character) || characterById(undefined);
    this.weaponId = weapon;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.radius = PLAYER.radius;
    this.height = PLAYER.height;
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = true;
    this.dead = false;
    this.health = 100;
    this.maxHealth = 100;
    this.level = 1;
    this.items = 0;
    this.reviveProgress = 0;

    // What the rig needs but the wire does not carry precisely.
    this.aiming = false;
    this.firing = false;
    this.weaponUp = false;
    this.moveSpeed = 8.2;

    this.chestPosition = new THREE.Vector3();
    this.aimPoint = new THREE.Vector3();
    this.muzzlePosition = new THREE.Vector3();

    // Interpolation: render a beat in the past so packet jitter does not
    // translate into a teammate that stutters on the spot.
    this.buffer = [];
    this.renderDelay = 0.1;
    this.clock = 0;

    this.model = buildPlayerModel(this.char);
    this.rig = createRig(0);
    game.engine.scene.add(this.model);
    this.setWeapon(weapon);
    this.nameplate = this._buildNameplate();
    this.model.add(this.nameplate.sprite);
  }

  /* ------------------------------------------------------------ appearance */
  setWeapon(weaponId) {
    const mount = this.model.userData.weaponMount;
    if (!mount) return;
    if (this.weaponModel) {
      this.weaponModel.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
      });
      mount.remove(this.weaponModel);
      this.weaponModel = null;
    }
    this.weaponId = weaponId;
    const weapon = weaponById(weaponId);
    if (!weapon) return;
    // Same rule as `Combat.equip`: a mesh that came with a weapon keeps it.
    if (this.model.userData.bodyWeapon) return;
    this.weaponModel = buildWeaponModel(weapon);
    mount.add(this.weaponModel);
    this.model.userData.muzzle = this.weaponModel.userData.muzzle;
  }

  setCharacter(characterId) {
    const next = characterById(characterId);
    if (!next || next === this.char) return;
    this.char = next;
    const old = this.model;
    old.remove(this.nameplate.sprite);
    this.model = buildPlayerModel(next);
    this.model.position.copy(old.position);
    this.game.engine.scene.add(this.model);
    this.model.add(this.nameplate.sprite);
    this.weaponModel = null;
    this.setWeapon(this.weaponId);
    old.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
    });
    old.parent?.remove(old);
  }

  _buildNameplate() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, transparent: true, depthTest: false, depthWrite: false,
    }));
    sprite.scale.set(1.5, 0.375, 1);
    sprite.position.y = 2.2;
    sprite.renderOrder = 998;
    const plate = { canvas, texture, sprite, lastKey: '' };
    this._paintNameplate(plate);
    return plate;
  }

  _paintNameplate(plate = this.nameplate) {
    const frac = clamp01(this.health / Math.max(1, this.maxHealth));
    const rev = clamp01(this.reviveProgress || 0);
    const key = `${this.name}|${Math.round(frac * 40)}|${this.dead ? 1 : 0}|${Math.round(rev * 20)}`;
    if (plate.lastKey === key) return;
    plate.lastKey = key;

    const ctx = plate.canvas.getContext('2d');
    const W = plate.canvas.width;
    const H = plate.canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.font = 'bold 23px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(8,10,16,0.9)';
    ctx.strokeText(this.name, W / 2, 20);
    ctx.fillStyle = this.dead ? '#7d89a3' : `#${this.char.accent.toString(16).padStart(6, '0')}`;
    ctx.fillText(this.name, W / 2, 20);

    const bx = 58;
    const bw = W - bx * 2;
    ctx.fillStyle = 'rgba(8,10,16,0.8)';
    ctx.fillRect(bx - 2, 42, bw + 4, 10);
    if (this.dead) {
      // The bar becomes their revive progress, so you can see whether standing
      // over them is doing anything.
      ctx.fillStyle = '#2a3040';
      ctx.fillRect(bx, 44, bw, 6);
      ctx.fillStyle = '#4be08a';
      ctx.fillRect(bx, 44, bw * rev, 6);
    } else {
      ctx.fillStyle = frac < 0.3 ? '#ff4d5e' : '#4be08a';
      ctx.fillRect(bx, 44, bw * frac, 6);
    }
    plate.texture.needsUpdate = true;
  }

  /* ------------------------------------------------------------- net state */
  /** Pushes a state packet into the interpolation buffer. */
  applyState(s) {
    this.buffer.push({
      t: this.clock,
      x: s.x, y: s.y, z: s.z,
      yaw: s.yaw, pitch: s.pitch,
      vx: s.vx, vy: s.vy, vz: s.vz,
    });
    if (this.buffer.length > 24) this.buffer.shift();
    this.health = s.hp;
    this.maxHealth = s.mhp;
    this.level = s.lvl ?? this.level;
    this.items = s.it ?? this.items;
    this.moveSpeed = s.ms ?? this.moveSpeed;
    const f = s.f | 0;
    this.grounded = !!(f & 1);
    this.aiming = !!(f & 2);
    this.firing = !!(f & 4);
    this.weaponUp = !!(f & 8);
    this.reviveProgress = (s.rv || 0) / 100;
    const wasDead = this.dead;
    this.dead = !!(f & 16);
    if (this.dead && !wasDead) this.buffer.length = 0;
  }

  onShot() { rigRecoil(this.rig, 0.5); }
  onHurt(amount) { rigFlinch(this.rig, clamp01(0.3 + amount / Math.max(1, this.maxHealth) * 2)); }

  update(dt) {
    this.clock += dt;
    const renderAt = this.clock - this.renderDelay;

    // Find the pair of samples straddling the render time and blend between
    // them. Running out of samples means the sender stalled, so we coast on the
    // last known velocity rather than freezing mid-stride.
    const buf = this.buffer;
    while (buf.length > 2 && buf[1].t <= renderAt) buf.shift();
    if (buf.length >= 2) {
      const a = buf[0];
      const b = buf[1];
      const span = Math.max(1e-4, b.t - a.t);
      const k = clamp01((renderAt - a.t) / span);
      this.position.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
      this.velocity.set(a.vx + (b.vx - a.vx) * k, a.vy + (b.vy - a.vy) * k, a.vz + (b.vz - a.vz) * k);
      this.yaw = angleBlend(a.yaw, b.yaw, k);
      this.pitch = a.pitch + (b.pitch - a.pitch) * k;
    } else if (buf.length === 1) {
      const a = buf[0];
      const ahead = Math.max(0, renderAt - a.t);
      this.position.set(a.x + a.vx * ahead, a.y + a.vy * ahead, a.z + a.vz * ahead);
      this.velocity.set(a.vx, a.vy, a.vz);
      this.yaw = a.yaw;
      this.pitch = a.pitch;
    }

    this.chestPosition.set(this.position.x, this.position.y + PLAYER.eyeHeight * 0.82, this.position.z);
    this.aimPoint.set(
      this.position.x + Math.sin(this.yaw) * Math.cos(this.pitch) * 40,
      this.position.y + 1.4 + Math.sin(this.pitch) * 40,
      this.position.z + Math.cos(this.yaw) * Math.cos(this.pitch) * 40,
    );

    updateRig(this.model, this.rig, dt, {
      position: this.position,
      yaw: this.yaw,
      pitch: this.pitch,
      velocity: this.velocity,
      speed: Math.hypot(this.velocity.x, this.velocity.z),
      moveSpeed: this.moveSpeed,
      grounded: this.grounded,
      aiming: this.aiming,
      firing: this.firing,
      weaponUp: this.weaponUp,
      dead: this.dead,
      grapple: false,
      cloaked: false,
      aimPoint: this.aimPoint,
    });
    if (this.model.userData.muzzle) this.model.userData.muzzle.getWorldPosition(this.muzzlePosition);

    this._paintNameplate();
    // Fade the plate out at close range so a teammate beside you is not a
    // billboard in your face.
    const camDist = this.game.engine.camera.position.distanceTo(this.position);
    this.nameplate.sprite.material.opacity = clamp01((camDist - 2.5) / 3.5) * 0.9;
    // Grow slowly with distance so the plate stays readable across the arena
    // without becoming a banner when a teammate is standing next to you.
    const scale = 0.8 + clamp01(camDist / 45) * 1.5;
    this.nameplate.sprite.scale.set(1.5 * scale, 0.375 * scale, 1);
  }

  /* -------------------------------------------------- simulation stand-in */
  get center() { return _v.set(this.position.x, this.position.y + this.height * 0.5, this.position.z); }
  get speedXZ() { return Math.hypot(this.velocity.x, this.velocity.z); }

  /**
   * Damage is not resolved here.
   *
   * The owner applies their own armour, barrier and items to it, because those
   * live on their machine — so we forward the raw number and let them decide
   * what it costs. Returning it keeps callers that read the result honest
   * enough for knockback and on-hit effects.
   */
  takeDamage(amount, opts = {}) {
    if (this.dead || amount <= 0) return 0;
    this.game.coop?.hurtPeer(this.id, amount, opts.source);
    return amount;
  }

  applyImpulse(vec) { this.game.coop?.pushPeer(this.id, vec); }
  applyStatus(id, duration, data) { this.game.coop?.statusPeer(this.id, id, duration, data); }
  heal() { return 0; }
  addBuff() {}
  markStatsDirty() {}

  dispose() {
    this.nameplate.texture.dispose();
    this.nameplate.sprite.material.dispose();
    this.model.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
    });
    this.model.parent?.remove(this.model);
  }
}

function angleBlend(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
