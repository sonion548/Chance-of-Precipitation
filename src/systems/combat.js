import * as THREE from 'three';
import { weaponById } from '../data/weapons.js';
import { characterById } from '../data/characters.js';
import { buildWeaponModel } from '../entities/models.js';
import { rigAttack } from '../entities/characterRig.js';
import { raycastWorld } from '../systems/physics.js';
import { clamp01, damp, TAU } from '../core/mathx.js';
import { ULTIMATE } from '../core/config.js';

/**
 * Where a teleport puts you, and whether you are still airborne when it lands.
 *
 * Both the Wraith's blink and the Reaper's blink slash hold the altitude they
 * left from — crossing a gap must not plant you on the floor — and rise only if
 * the ground under the exit is higher than you already are. Mutates `end.y` and
 * returns whether the player should stay off the ground.
 */
function settleTeleport(player, arena, start, end) {
  const ground = arena.groundHeightAt(end.x, end.z, Math.max(start.y, end.y) + 2.5);
  end.y = Math.max(start.y, ground);
  return !player.grounded || end.y > ground + 0.05;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _ray = new THREE.Vector3();   // hitscan direction — must survive item procs

export const SECONDARY_KEY = 'KeyQ';
export const UTILITY_KEYS = ['ShiftLeft', 'ShiftRight'];
export const SPECIAL_KEY = 'KeyR';
export const ULTIMATE_KEY = 'KeyF';

/**
 * Weapon handling and damage resolution.
 *
 * All damage to enemies funnels through `damageEnemy` so crits, item damage
 * modifiers, lifesteal and on-hit procs are applied in exactly one place.
 */
export class Combat {
  constructor(game) {
    this.game = game;
    this.weapon = null;
    this.weaponModel = null;
    this.character = null;
    this.primaryTimer = 0;
    this.secondaryTimer = 0;
    this.utilityTimer = 0;
    this.utilityCharges = 1;
    this.specialTimer = 0;
    this.bastionTimer = 0;
    this.lastStandTimer = 0;
    // The ultimate meter, 0..ULTIMATE.max. Never a cooldown — see config.
    this.ultimateCharge = ULTIMATE.startCharge;
    this._ultimateAnnounced = false;
    this._pendingSlam = null;
    this.chargeTime = 0;
    this.charging = false;
    this.heat = 0;
    this.firing = false;
    this.beamActive = false;
    this.ctx = this._buildContext();
  }

  setCharacter(characterId) {
    this.character = characterById(characterId);
    this.utilityCharges = this.character.utility.charges ?? 1;
    this.utilityTimer = 0;
    this.specialTimer = 0;
    this.ultimateCharge = ULTIMATE.startCharge;
    this._ultimateAnnounced = false;
  }

  /* ------------------------------------------------------------------ ultimate */
  get hasUltimate() { return !!this.character?.ultimate; }
  get ultimateFraction() { return clamp01(this.ultimateCharge / ULTIMATE.max); }
  get ultimateReady() { return this.hasUltimate && this.ultimateCharge >= ULTIMATE.max; }

  /**
   * Feeds the meter. Everything that fills it comes through here so the
   * "READY" announcement fires exactly once per fill, wherever the charge
   * came from.
   */
  addUltimateCharge(amount) {
    if (!this.hasUltimate || amount <= 0 || this.game.player?.dead) return;
    const before = this.ultimateCharge;
    this.ultimateCharge = Math.min(ULTIMATE.max, this.ultimateCharge + amount);
    if (before < ULTIMATE.max && this.ultimateCharge >= ULTIMATE.max && !this._ultimateAnnounced) {
      this._ultimateAnnounced = true;
      this.game.ui.toast(`${this.character.ultimate.name.toUpperCase()} READY — F`, '#ffcf5c');
      this.game.fxApi.ring(this.game.player.position, 0.5, 5, 0xffcf5c, 0.6, 0.9);
    }
  }

  /** An enemy died: elites and bosses are worth a great deal more than a husk. */
  noteKill(enemy) {
    this.addUltimateCharge(
      enemy?.boss ? ULTIMATE.perBossKill
        : enemy?.elite ? ULTIMATE.perEliteKill
        : ULTIMATE.perKill,
    );
  }

  /** Taking a beating is the other half of the meter. `amount` is health lost. */
  noteDamageTaken(amount) {
    const max = this.game.player?.stats.maxHealth || 1;
    this.addUltimateCharge((amount / max) * 100 * ULTIMATE.perHealthPercent);
  }

  /** Hands one utility charge back and restarts its regeneration cleanly. */
  refundUtility() {
    const max = this.maxUtilityCharges;
    this.utilityCharges = Math.min(max, this.utilityCharges + 1);
    const stats = this.game.player.stats;
    const cd = (this.character?.utility.cooldown ?? 3) * stats.cooldownMult * stats.dashCooldownMult;
    // Setting the timer to zero here would hand out a *second* free charge on
    // the next frame, because that is exactly the condition the regen ticks on.
    this.utilityTimer = this.utilityCharges >= max ? 0 : cd;
  }

  /** Max utility charges: the character's own plus anything items grant. */
  get maxUtilityCharges() {
    const extra = Math.max(0, (this.game.player?.stats.maxDashCharges ?? 1) - 1);
    return (this.character?.utility.charges ?? 1) + extra;
  }

  equip(weaponId) {
    const player = this.game.player;
    const mount = player.model.userData.weaponMount;
    if (this.weaponModel) {
      this.weaponModel.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
      });
      mount.remove(this.weaponModel);
    }
    this.weapon = weaponById(weaponId);
    this.weaponModel = buildWeaponModel(this.weapon);
    mount.add(this.weaponModel);
    player.model.userData.muzzle = this.weaponModel.userData.muzzle;
    this.primaryTimer = 0;
    this.secondaryTimer = 0;
    this.heat = 0;
  }

  // ------------------------------------------------------------------ per-frame
  update(dt, input, player) {
    const stats = player.stats;
    this.primaryTimer = Math.max(0, this.primaryTimer - dt);
    this.secondaryTimer = Math.max(0, this.secondaryTimer - dt);
    this.firing = false;

    if (player.dead || !this.weapon) return;

    const primary = this.weapon.primary;
    const secondary = this.weapon.secondary;
    const canAct = !this.game.paused;

    // ---- Secondary: Q, charged or instant ----
    const secondaryHeld = input.down(SECONDARY_KEY);
    if (secondary.charge) {
      if (secondaryHeld && this.secondaryTimer <= 0 && canAct) {
        this.charging = true;
        this.chargeTime = Math.min(secondary.charge, this.chargeTime + dt);
      } else if (this.charging) {
        const t = this.chargeTime / secondary.charge;
        this.charging = false;
        if (this.chargeTime >= (secondary.minCharge ?? 0.15)) this._fireAbility(secondary, t);
        this.chargeTime = 0;
      }
    } else if (input.justPressed(SECONDARY_KEY) && this.secondaryTimer <= 0 && canAct) {
      this._fireAbility(secondary, 1);
    }

    // ---- Utility (Shift): charge-based, character-defined ----
    const util = this.character?.utility;
    if (util) {
      const maxCharges = this.maxUtilityCharges;
      const cd = util.cooldown * stats.cooldownMult * stats.dashCooldownMult;
      if (this.utilityCharges < maxCharges) {
        this.utilityTimer -= dt;
        if (this.utilityTimer <= 0) {
          this.utilityCharges = Math.min(maxCharges, this.utilityCharges + 1);
          this.utilityTimer = cd;
        }
      } else {
        this.utilityTimer = 0;
      }
      if (canAct && this.utilityCharges > 0 && UTILITY_KEYS.some((k) => input.justPressed(k))) {
        // Impaling Storm suspends the cost entirely rather than shortening it,
        // so a dash taken during it is genuinely free rather than merely cheap.
        if (!player.buffs.has('freedash')) {
          this.utilityCharges--;
          if (this.utilityTimer <= 0) this.utilityTimer = cd;
        }
        this._fireAbility(util, 1, false, 'utility');
      }
    }

    // ---- Special (R) ----
    const special = this.character?.special;
    if (special) {
      this.specialTimer = Math.max(0, this.specialTimer - dt);
      if (canAct && this.specialTimer <= 0 && input.justPressed(SPECIAL_KEY)) {
        this.specialTimer = special.cooldown * stats.cooldownMult;
        this._fireAbility(special, 1, false, 'special');
      }
    }

    // ---- Ultimate (F): paid for in kills and in blood ----
    const ult = this.character?.ultimate;
    if (ult) {
      this.addUltimateCharge(ULTIMATE.perSecond * dt);
      if (canAct && this.ultimateReady && input.justPressed(ULTIMATE_KEY)) {
        this.ultimateCharge = 0;
        this._ultimateAnnounced = false;
        this.game.ui.toast(ult.name.toUpperCase(), '#ffcf5c');
        this.game.engine.addShake(0.4);
        this._fireAbility(ult, 1, false, 'ultimate');
      }
    }

    // ---- Fields and multi-frame ultimates tick while their buffs are up ----
    this._tickBastion(dt, player);
    this._tickLastStand(dt, player);
    this._tickSlam(dt, player);

    // ---- Primary ----
    const wantPrimary = primary.hold ? input.mouse.left : input.mouse.leftPressed;
    if (wantPrimary && this.primaryTimer <= 0 && canAct && !this.charging) {
      const interval = primary.cooldown / Math.max(0.05, stats.attackSpeed);
      this.primaryTimer = interval;
      this.firing = true;
      this._fireAbility(primary, 1, true);
    }
    if (!input.mouse.left && primary.beam) {
      this.heat = damp(this.heat, 0, 2.4, dt);
      primary.onRelease?.(this.ctx);
    }
    this.beamActive = !!(primary.beam && input.mouse.left);

    // Weapon visual: emitter glow tracks heat/charge.
    if (this.weaponModel?.userData.glow) {
      const g = this.weaponModel.userData.glow;
      const t = this.charging ? this.chargeTime / (secondary.charge || 1) : this.heat;
      g.material.opacity = 0.45 + t * 0.55 + (this.firing ? 0.4 : 0);
      g.scale.setScalar(1 + t * 1.6);
    }
  }

  _fireAbility(ability, chargeRatio, isPrimary = false, kind = isPrimary ? 'primary' : 'secondary') {
    const player = this.game.player;
    this.ctx.dmg = player.stats.damage;
    _origin.copy(player.muzzlePosition);
    this.ctx.origin = _origin;
    player.aimDirection(_dir);
    this.ctx.dir = _dir;
    this.ctx.aimPoint = player.aimPoint;
    this.ctx.chargeRatio = chargeRatio;

    // The body acts the ability out: a swing swings, a punch punches. The rig
    // owns what that looks like; all that is decided here is which one to play.
    if (ability.anim) rigAttack(player.rig, ability.anim, chargeRatio);

    try {
      ability.fire(this.ctx, chargeRatio);
    } catch (err) {
      console.error(`Weapon "${this.weapon.id}" ability failed`, err);
    }

    if (kind === 'secondary') {
      this.secondaryTimer = ability.cooldown * player.stats.cooldownMult;
      this.game.inventory.trigger('onSecondary', { ability });
    }
  }

  /** Bastion is a field, not an instant: it pulses while its buff is alive. */
  _tickBastion(dt, player) {
    const buff = player.buffs.get('bastion');
    if (!buff) { this.bastionTimer = 0; return; }
    this.bastionTimer -= dt;
    if (this.bastionTimer > 0) return;
    this.bastionTimer = 0.45;
    const radius = buff.extra?.radius ?? 12;
    this.game.fxApi.ring(player.position, radius * 0.55, radius, buff.extra?.color ?? 0x6fd0ff, 0.45, 0.55);
    for (const e of this.game.enemies.inRadius(player.position, radius)) {
      e.applyStatus('chill', 1.2, { slow: 0.4 });
    }
  }

  /**
   * Last Stand: six seconds of standing there while the plate does the work.
   * Same shape as Bastion — a buff the ability system pulses — because the
   * alternative is an ability that owns a timer nothing else can see.
   */
  _tickLastStand(dt, player) {
    const buff = player.buffs.get('laststand');
    if (!buff) { this.lastStandTimer = 0; return; }
    const extra = buff.extra || {};
    // Immunity is refreshed from the buff so a mid-ultimate death is impossible
    // even if something else clears the invulnerability window.
    player.invulnerable = Math.max(player.invulnerable, Math.min(buff.time, 0.3));
    this.lastStandTimer -= dt;
    if (this.lastStandTimer > 0) return;
    this.lastStandTimer = extra.interval ?? 0.5;
    const radius = extra.radius ?? 16;
    const color = extra.color ?? 0x6fd0ff;
    this.areaDamage(player.position, radius, extra.damage ?? 0, {
      proc: 0.5, source: 'Last Stand', force: extra.knockback ?? 18,
    });
    this.game.fxApi.ring(player.position, 1.5, radius, color, 0.42, 1);
    this.game.fxApi.glow(player.chestPosition, { color, size: 2.4, life: 0.2, grow: 3 });
    this.game.engine.addShake(0.12);
  }

  /**
   * Terminal Velocity, in two acts: the launch, then the landing.
   *
   * It is a state machine rather than a single call because the whole point of
   * the ability is the hang time — the player leaves the floor, the camera
   * catches up, and only then does the ground arrive.
   */
  _tickSlam(dt, player) {
    const slam = this._pendingSlam;
    if (!slam) return;
    slam.timer -= dt;
    if (slam.phase === 'rise') {
      player.invulnerable = Math.max(player.invulnerable, 0.4);
      if (this.game.frame % 2 === 0) {
        this.game.fxApi.glow(player.position, { color: slam.spec.color, size: 1.6, life: 0.25, grow: 2 });
      }
      if (slam.timer > 0) return;
      // Come down on what you were looking at, within reach of the leap.
      const aim = this.game.player.aimPoint;
      const to = _v.copy(aim).sub(player.position).setY(0);
      const dist = Math.min(to.length(), slam.spec.reach ?? 30);
      to.setLength(dist);
      const land = player.position.clone().add(to);
      land.y = this.game.arena.groundHeightAt(land.x, land.z) + 16;
      player.position.copy(land);
      player.velocity.set(0, -78, 0);
      player.grounded = false;
      player.snapCamera();
      slam.phase = 'fall';
      slam.timer = 0.6;
      return;
    }
    player.invulnerable = Math.max(player.invulnerable, 0.2);
    if (!player.grounded && slam.timer > 0) return;
    this._pendingSlam = null;
    this._slamImpact(player.position.clone(), slam.spec);
  }

  _slamImpact(pos, spec) {
    const game = this.game;
    this.areaDamage(pos, spec.radius, spec.damage, {
      proc: 1, source: 'Terminal Velocity', force: spec.knockback ?? 30,
    });
    game.fxApi.explosion(pos, spec.radius, spec.color, 2.2);
    game.fxApi.ring(pos, 1, spec.radius * 1.6, spec.color, 0.9, 1);
    game.engine.addShake(1.3);
    for (let i = 0; i < (spec.aftershocks ?? 0); i++) {
      const a = game.rng.next() * TAU;
      const r = spec.radius * (0.3 + game.rng.next() * 0.6);
      const p = pos.clone();
      p.x += Math.cos(a) * r;
      p.z += Math.sin(a) * r;
      game.projectiles.spawnHazard(p, {
        radius: spec.radius * 0.42, damage: spec.aftershockDamage ?? spec.damage * 0.25,
        delay: 0.4 + i * 0.28, color: spec.color, hostile: false, source: 'Terminal Velocity',
      });
    }
  }

  /** Paints everything in a radius. Each enemy owns its own mark. */
  markEnemies(position, radius, duration, color = 0x9dff6a) {
    let count = 0;
    for (const e of this.game.enemies.inRadius(position, radius)) {
      e.applyStatus('marked', duration, { color, blink: 0 });
      this.game.fxApi.glow(e.center, { color, size: 1.5, life: 0.35, grow: 1.8 });
      count++;
    }
    this.game.fxApi.ring(position, 0.8, radius, color, 0.7, 0.9);
    return count;
  }

  reduceCooldowns(seconds) {
    this.secondaryTimer = Math.max(0, this.secondaryTimer - seconds);
    this.specialTimer = Math.max(0, this.specialTimer - seconds);
    this.utilityTimer = Math.max(0, this.utilityTimer - seconds);
  }

  // ------------------------------------------------------------------ damage
  /**
   * The single entry point for hurting an enemy.
   * opts: { proc, source, crit, knockback, knockbackDir, chill, freeze, lifesteal, hitPoint, noSplash }
   */
  damageEnemy(enemy, amount, opts = {}) {
    if (!enemy || enemy.dead || amount <= 0) return 0;
    const player = this.game.player;
    const stats = player.stats;
    const proc = opts.proc ?? 1;

    // Crit roll (skipped for damage-over-time and item procs with proc 0).
    let isCrit = opts.crit ?? false;
    if (opts.crit === undefined && proc > 0) isCrit = this.game.rng.next() < stats.crit;
    let damage = amount * (isCrit ? stats.critDamage : 1);

    damage = this.game.inventory.modifyDamage({ enemy, damage, isCrit, proc });

    const dealt = enemy.takeDamage(damage, { ...opts, crit: isCrit });

    // Lifesteal (weapon-specific plus item-wide)
    const steal = (opts.lifesteal ?? 0) + stats.lifesteal;
    if (steal > 0 && dealt > 0) player.heal(dealt * steal, null, true);

    if (proc > 0) {
      this.game.inventory.trigger('onHit', {
        enemy, damage: dealt, isCrit, proc, source: opts.source, noSplash: opts.noSplash,
      });
      if (isCrit) this.game.inventory.trigger('onCrit', { enemy, damage: dealt, proc });
    }

    this.game.ui.flashCrosshair(enemy.dead ? 'kill' : 'hit');
    return dealt;
  }

  areaDamage(position, radius, amount, opts = {}) {
    const targets = this.game.enemies.inRadius(position, radius, opts.exclude || null);
    let total = 0;
    for (const e of targets) {
      // Linear falloff keeps splash from out-damaging direct hits.
      const d = e.position.distanceTo(position);
      const falloff = 1 - clamp01(d / radius) * 0.42;
      const o = { ...opts };
      if (opts.force) {
        o.knockback = opts.force;
        o.knockbackDir = _v.copy(e.position).sub(position).setY(0.4).normalize().clone();
      }
      total += this.damageEnemy(e, amount * falloff, o);
    }
    return total;
  }

  /** Lightning that leaps between nearby enemies with per-jump falloff. */
  chainFrom(source, jumps, damage, range, color = 0x9fd0ff, falloff = 1) {
    let current = source;
    const hit = new Set([source]);
    let dmg = damage;
    for (let i = 0; i < jumps; i++) {
      const candidates = this.game.enemies
        .inRadius(current.center ?? current.position, range)
        .filter((e) => !hit.has(e));
      if (!candidates.length) break;
      candidates.sort((a, b) => a.position.distanceToSquared(current.position) - b.position.distanceToSquared(current.position));
      const next = candidates[0];
      hit.add(next);
      this.game.fx.lightning(current.center ?? current.position, next.center, color, 0.15, 5);
      this.damageEnemy(next, dmg, { proc: 0.2, source: 'Chain' });
      dmg *= falloff;
      current = next;
    }
  }

  // ------------------------------------------------------------------ weapon API
  _buildContext() {
    const game = this.game;
    const self = this;

    // Named rather than returned anonymously: several of the helpers below are
    // built out of the others (a slash wave is a melee swing plus a projectile),
    // and composing them beats copying them.
    const api = {
      dmg: 0,
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      aimPoint: new THREE.Vector3(),
      chargeRatio: 0,
      get fx() { return game.fxApi; },
      get player() { return game.player; },

      getHeat() { return self.heat; },
      setHeat(v) { self.heat = clamp01(v); },
      decayHeat() { self.heat *= 0.5; },

      recoil(amount) { game.player.addRecoil(amount); },
      shake(amount) { game.engine.addShake(amount); },
      impulse(vec) { game.player.applyImpulse(vec); },

      /** Instant-hit shot. Returns the enemy hit, or null. */
      hitscan(spec) {
        const dir = _ray.copy(self.ctx.dir);
        if (spec.spread) {
          dir.x += (game.rng.next() - 0.5) * spec.spread * 2;
          dir.y += (game.rng.next() - 0.5) * spec.spread * 2;
          dir.z += (game.rng.next() - 0.5) * spec.spread * 2;
          dir.normalize();
        }
        const origin = self.ctx.origin;
        const range = spec.range ?? 120;
        let remaining = spec.pierce ?? 0;
        let travelled = 0;
        let from = origin.clone();
        let firstHit = null;
        const excluded = new Set();

        game.fxApi.muzzle(origin, dir, spec.color ?? 0xffd58a, spec.thick ? 1.6 : 1);
        // Teammates see the tracer, not the maths behind it: one small message
        // per shot, and their copy of the beam lands in the same place.
        game.coop?.onLocalShot({
          kind: 'beam', x: origin.x, y: origin.y, z: origin.z,
          dx: dir.x, dy: dir.y, dz: dir.z,
          x2: origin.x + dir.x * range, y2: origin.y + dir.y * range, z2: origin.z + dir.z * range,
          c: spec.color ?? 0xffd58a,
        });

        while (travelled <= range) {
          const worldHit = raycastWorld(from, dir, range - travelled, game.arena);
          let enemyHit = null;
          const eh = game.enemies.raycast(from, dir, range - travelled);
          if (eh && !excluded.has(eh.enemy)) enemyHit = eh;
          else if (eh) {
            // Skip already-pierced enemies by nudging past them.
            from.addScaledVector(dir, eh.distance + 0.4);
            travelled += eh.distance + 0.4;
            continue;
          }

          if (enemyHit && (!worldHit || enemyHit.distance <= worldHit.distance)) {
            const point = from.clone().addScaledVector(dir, enemyHit.distance);
            if (spec.tracer || spec.beam) {
              game.fxApi.beam(travelled === 0 ? origin : from, point, spec.color ?? 0xffd58a, spec.beam ?? 0.09, spec.thick ?? 0.035);
            }
            const falloffMult = spec.falloff ? falloffScale(enemyHit.distance + travelled, spec.falloff) : 1;
            self.damageEnemy(enemyHit.enemy, spec.damage * falloffMult, {
              proc: spec.proc ?? 1, source: self.weapon?.name, hitPoint: point,
              knockback: spec.knockback ?? 0, knockbackDir: dir.clone(),
              lifesteal: spec.lifesteal ?? 0,
            });
            game.fxApi.impact(point, dir.clone().negate(), spec.color ?? 0xffd58a, spec.thick ? 1.6 : 1);
            firstHit ??= enemyHit.enemy;
            excluded.add(enemyHit.enemy);
            if (remaining <= 0) return firstHit;
            remaining--;
            from = point.clone();
            travelled += enemyHit.distance + 0.05;
            continue;
          }

          // Hit the world (or nothing).
          const dist = worldHit ? worldHit.distance : range - travelled;
          const point = from.clone().addScaledVector(dir, dist);
          if (spec.tracer || spec.beam) {
            game.fxApi.beam(travelled === 0 ? origin : from, point, spec.color ?? 0xffd58a, spec.beam ?? 0.09, spec.thick ?? 0.035);
          }
          if (worldHit) game.fxApi.impact(point, dir.clone().negate(), spec.color ?? 0xffd58a, 0.8);
          return firstHit;
        }
        return firstHit;
      },

      spawnBullet(spec) {
        const dir = _v2.copy(self.ctx.dir);
        if (spec.spread) {
          dir.x += (game.rng.next() - 0.5) * spec.spread * 2;
          dir.y += (game.rng.next() - 0.5) * spec.spread * 2;
          dir.z += (game.rng.next() - 0.5) * spec.spread * 2;
          dir.normalize();
        }
        game.fxApi.muzzle(self.ctx.origin, dir, spec.color ?? 0xffffff);
        const o = self.ctx.origin;
        game.coop?.onLocalShot({
          kind: 'bullet', x: o.x, y: o.y, z: o.z,
          dx: dir.x, dy: dir.y, dz: dir.z, sp: spec.speed ?? 60,
          r: spec.radius, l: spec.life, g: spec.gravity, c: spec.color ?? 0xffffff,
          tr: spec.trail, gl: spec.glow,
        });
        return game.projectiles.spawn({
          ...spec,
          position: self.ctx.origin.clone(),
          velocity: dir.clone().multiplyScalar(spec.speed ?? 60),
          source: self.weapon?.name,
        });
      },

      spawnMortar(spec) {
        game.projectiles.spawnMortar({ ...spec, source: self.weapon?.name });
      },

      /** Cone attack in front of the player. */
      cone(spec) {
        const origin = self.ctx.origin;
        const dir = self.ctx.dir;
        const cosLimit = Math.cos(spec.angle ?? 0.8);
        const targets = game.enemies.inRadius(origin, spec.range ?? 12);
        for (const e of targets) {
          _v.copy(e.center).sub(origin).normalize();
          if (_v.dot(dir) < cosLimit) continue;
          self.damageEnemy(e, spec.damage, {
            proc: spec.proc ?? 1, source: self.weapon?.name,
            knockback: spec.knockback ?? 0,
            knockbackDir: _v.clone().setY(0.35).normalize(),
          });
        }
        game.fxApi.muzzle(origin, dir, spec.color ?? 0xffa050, 2.4);
      },

      /** Wide melee arc centred on the aim direction. */
      melee(spec) {
        const player = game.player;
        const origin = player.chestPosition;
        const dir = self.ctx.dir;
        const cosLimit = Math.cos(spec.angle ?? 1.4);
        const targets = game.enemies.inRadius(origin, spec.range ?? 5);
        let any = false;
        for (const e of targets) {
          _v.copy(e.center).sub(origin).normalize();
          if (_v.dot(dir) < cosLimit) continue;
          any = true;
          self.damageEnemy(e, spec.damage, {
            proc: spec.proc ?? 1, source: self.weapon?.name, lifesteal: spec.lifesteal ?? 0,
            knockback: 5, knockbackDir: _v.clone().setY(0.3).normalize(),
          });
        }
        // One crescent along the swing, alternating which way it cuts so a held
        // attack reads as a sequence of strokes rather than one stuttering shape.
        self._slashSide = -(self._slashSide || 1);
        // `tilt` is how far out of the horizontal the cut is rolled. A weapon
        // that swings flat asks for a small one and gets a flat crescent.
        const tilt = spec.tilt ?? 0.5;
        game.fxApi.slash(origin.clone().setY(origin.y - 0.15), dir, {
          color: spec.color ?? 0xa15bff,
          radius: (spec.range ?? 5) * 0.92,
          life: 0.2,
          tilt: tilt * self._slashSide,
        });
        if (any) game.engine.addShake(0.08);
        return any;
      },

      /**
       * A flat horizontal cut that keeps going.
       *
       * The swing itself is an ordinary melee arc; what makes it a Reaper swing
       * is that the crescent leaves the blade and travels. The wave is its own
       * damage event with its own proc coefficient, so a held attack is not
       * secretly double-dipping every on-hit item you own.
       */
      slashWave(spec) {
        api.melee({ ...spec, tilt: spec.tilt ?? 0.16 });
        const w = spec.wave;
        if (!w) return;
        const player = game.player;
        const dir = self.ctx.dir.clone();
        const speed = w.speed ?? 32;
        const range = w.range ?? 24;
        const origin = player.chestPosition.clone().addScaledVector(dir, 1.2);
        game.projectiles.spawn({
          position: origin,
          velocity: dir.clone().multiplyScalar(speed),
          damage: 0,
          radius: w.radius ?? 2.4,
          life: range / speed,
          color: spec.color ?? 0xa15bff,
          gravity: 0,
          // The wave is light, not matter: it sweeps through walls and bodies
          // alike and resolves its damage from the sweep, once per enemy.
          ghost: true,
          wave: {
            width: (w.radius ?? 2.4) * 1.35,
            damage: w.damage ?? 0,
            proc: w.proc ?? 0.6,
            lifesteal: w.lifesteal ?? 0,
            color: spec.color ?? 0xa15bff,
          },
          source: self.weapon?.name,
        });
        game.coop?.onLocalShot({
          kind: 'bullet', x: origin.x, y: origin.y, z: origin.z,
          dx: dir.x, dy: dir.y, dz: dir.z, sp: speed,
          r: w.radius ?? 2.4, l: range / speed, g: 0, c: spec.color ?? 0xa15bff, tr: 1, gl: 1.6,
        });
      },

      /**
       * A compression charge punched out in front of the knuckles.
       *
       * Short, wide and immediate — the gauntlets have no muzzle, so the reach
       * is the ability rather than a property of the projectile.
       */
      shockwave(spec) {
        const player = game.player;
        const origin = player.chestPosition.clone();
        const dir = self.ctx.dir.clone().setY(0);
        if (dir.lengthSq() < 1e-6) dir.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
        dir.normalize();
        const range = spec.range ?? 9;
        const cosLimit = Math.cos(spec.angle ?? 0.95);
        const color = spec.color ?? 0xffb347;

        for (const e of game.enemies.inRadius(origin, range)) {
          _v.copy(e.center).sub(origin).setY(0);
          const d = _v.length();
          if (d > 0.001) _v.divideScalar(d);
          if (_v.dot(dir) < cosLimit) continue;
          // The front loses a little punch on the way out, but not much: this
          // is a wall of air, not a bullet.
          const falloff = 1 - clamp01(d / range) * 0.3;
          self.damageEnemy(e, spec.damage * falloff, {
            proc: spec.proc ?? 0.8, source: self.weapon?.name,
            knockback: spec.knockback ?? 12,
            knockbackDir: _v.clone().setY(0.3).normalize(),
          });
        }

        // Three crescents standing upright, marching away from the fist.
        for (let i = 0; i < 3; i++) {
          const p = origin.clone().addScaledVector(dir, range * (0.28 + i * 0.26));
          game.fxApi.slash(p, dir, {
            color, radius: range * (0.3 + i * 0.16), life: 0.13 + i * 0.03,
            tilt: Math.PI / 2, grow: 2,
          });
        }
        game.fxApi.glow(origin.clone().addScaledVector(dir, 1.4), { color, size: 1.3, life: 0.12, grow: 2.2 });
        game.fxApi.ring(player.position, 0.5, range * 0.6, color, 0.24, 0.5);
        game.engine.addShake(0.14);
      },

      /**
       * Both gauntlets fired at the floor.
       *
       * Jumps are refunded rather than spent: the boost is the mobility, and
       * taking your double jump for using it would make it a worse jump.
       */
      jetBoost(spec) {
        const player = game.player;
        const color = spec.color ?? 0xffb347;
        const ground = player.position.clone();
        ground.y += 0.4;

        if (spec.damage) {
          self.areaDamage(ground, spec.radius ?? 6, spec.damage, {
            proc: 0.7, source: self.weapon?.name, force: 10,
          });
        }

        // Cancel any fall first, or boosting mid-drop barely lifts you.
        player.velocity.y = Math.max(player.velocity.y, 0);
        const forward = player.moveDirection(_v2.set(0, 0, 0));
        player.applyImpulse(
          forward.clone().multiplyScalar(spec.forward ?? 0).setY(spec.up ?? 20),
        );
        player.jumpsUsed = 0;

        game.fxApi.explosion(ground, (spec.radius ?? 6) * 0.7, color, 0.9);
        game.fxApi.ring(player.position, 0.5, (spec.radius ?? 6) * 1.4, color, 0.4, 0.9);
        for (let i = 0; i < 14; i++) {
          game.fxApi.spawnParticle(ground, new THREE.Vector3(
            (game.rng.next() - 0.5) * 9, -game.rng.next() * 6, (game.rng.next() - 0.5) * 9,
          ), { color, size: 0.16, life: 0.4, gravity: -6, drag: 0.94 });
        }
        game.engine.addShake(0.3);
        player.addRecoil(3);
      },

      /** Teleporting slash that damages everything along the path. */
      blinkSlash(spec) {
        const player = game.player;
        // Own the vector: the shared scratch is written again inside the damage
        // loop below, and this direction is still needed after it.
        const dir = self.ctx.dir.clone().setY(0).normalize();
        const start = player.position.clone();
        const hit = raycastWorld(
          player.chestPosition, dir, spec.distance, game.arena,
        );
        const dist = hit ? Math.max(1, hit.distance - 1) : spec.distance;
        const end = start.clone().addScaledVector(dir, dist);
        const airborne = settleTeleport(player, game.arena, start, end);

        // Damage everything on the swept line. The path is marked by crescents
        // laid along it — the cut you made, not a row of glowing lumps.
        const steps = Math.ceil(dist / 2);
        const hitSet = new Set();
        for (let i = 0; i <= steps; i++) {
          const p = start.clone().lerp(end, i / steps);
          p.y += 1;
          for (const e of game.enemies.inRadius(p, spec.radius)) {
            if (hitSet.has(e)) continue;
            hitSet.add(e);
            self.damageEnemy(e, spec.damage, {
              proc: spec.proc ?? 1, source: self.weapon?.name, lifesteal: spec.lifesteal ?? 0,
            });
          }
          if (i % 2 === 0) {
            game.fxApi.slash(p, dir, {
              color: spec.color, radius: spec.radius * 1.35, life: 0.26,
              tilt: i % 4 === 0 ? 0.4 : -0.4,
            });
          }
        }
        // The cut that lands: one wide arc across the far end of the dash.
        game.fxApi.slash(end.clone().setY(end.y + 1.1), dir, {
          color: spec.color, radius: spec.radius * 2.1, life: 0.3, tilt: 0.25, grow: 1.6,
        });
        player.position.copy(end);
        player.velocity.x *= 0.3;
        player.velocity.z *= 0.3;
        if (airborne) player.grounded = false;
        player.snapCamera();
      },

      chain(fromEnemy, jumps, damage, range, color, falloff) {
        self.chainFrom(fromEnemy, jumps, damage, range, color, falloff);
      },

      addBuff(id, dur, power, maxStacks, label, extra) {
        game.player.addBuff(id, dur, power, maxStacks, label, extra);
      },
      toast(text, color) { game.ui.toast(text, color); },

      /* ---------------- character abilities ---------------- */

      dash(opts) { game.player.startDash(opts); },

      /**
       * Cargo hook. Anchors to an enemy if one is in the way, otherwise to
       * terrain, then reels the player in. Anchors almost always exist because
       * the world raycast includes the ground plane and the arena wall — a shot
       * into open sky still finds something to bite.
       */
      fireGrapple(spec) {
        const player = game.player;
        const origin = player.muzzlePosition.clone();
        const dir = player.aimDirection(new THREE.Vector3());
        const range = spec.range ?? 45;

        const eh = game.enemies.raycast(origin, dir, range);
        const wh = raycastWorld(origin, dir, range, game.arena);

        let anchor = null;
        let enemy = null;
        if (eh && (!wh || eh.distance <= wh.distance)) {
          enemy = eh.enemy;
          anchor = origin.clone().addScaledVector(dir, eh.distance);
          self.damageEnemy(enemy, spec.damage ?? 0, {
            proc: 1, source: 'Grapple Gun', hitPoint: anchor.clone(),
          });
        } else if (wh) {
          anchor = origin.clone().addScaledVector(dir, Math.max(1.5, wh.distance - 0.6));
        }

        if (!anchor) {
          // Nothing to bite: refund the charge rather than eating it.
          self.utilityCharges = Math.min(self.maxUtilityCharges, self.utilityCharges + 1);
          game.fxApi.beam(origin, origin.clone().addScaledVector(dir, range), spec.color ?? 0xffd24b, 0.14, 0.03);
          return;
        }

        game.fxApi.beam(origin, anchor, spec.color ?? 0xffd24b, 0.2, 0.06);
        game.fxApi.glow(anchor, { color: spec.color ?? 0xffd24b, size: 1.2, life: 0.25, grow: 1.4 });
        player.startGrapple(anchor, { pullSpeed: spec.pullSpeed ?? 40, enemy });
      },

      /**
       * A punch whose damage is bought with momentum — the payoff for grappling
       * in fast rather than walking up.
       */
      momentumPunch(spec) {
        const player = game.player;
        player.endGrapple();
        const speed = Math.hypot(player.velocity.x, player.velocity.z);
        const t = clamp01(speed / (spec.reference ?? 30));
        const damage = spec.baseDamage + (spec.maxDamage - spec.baseDamage) * t;

        const dir = player.aimDirection(_v2.set(0, 0, 0));
        const centre = player.chestPosition.clone().addScaledVector(dir, spec.radius * 0.5);

        self.areaDamage(centre, spec.radius, damage, {
          proc: 1, source: 'Overcharged Fist', force: spec.knockback ?? 26,
        });

        const intensity = 0.9 + t * 1.5;
        game.fxApi.explosion(centre, spec.radius, spec.color ?? 0xffd24b, intensity);
        game.fxApi.ring(centre, 1, spec.radius * 1.5, spec.color ?? 0xffd24b, 0.5, 0.9);
        game.engine.addShake(0.35 + t * 0.7);
        player.addRecoil(4 + t * 4);
        // A charged punch carries you through the target.
        player.applyImpulse(dir.clone().setY(0).normalize().multiplyScalar(4 + t * 8).setY(3 + t * 3));
        if (t > 0.7) game.ui.toast(`OVERCHARGED ×${(1 + t * 3).toFixed(1)}`, '#ffd24b');
      },

      /**
       * Phase shift: an instant reposition that leaves a detonating afterimage.
       *
       * Two things it deliberately does not do. It does not travel down the
       * camera's line — it goes where the character is going, so looking at the
       * ground while blinking forward still blinks you forward. And it does not
       * put you on the floor: blink out of a jump and you come out of it still
       * in the air, at the same height, with your fall intact and your double
       * jump untouched. Snapping to ground height was the thing that made this
       * useless for crossing a gap, which is most of what it is for.
       */
      blink(spec) {
        const player = game.player;
        const dir = player.moveDirection();
        const start = player.position.clone();
        const eye = player.chestPosition.clone();
        const hit = raycastWorld(eye, dir, spec.distance, game.arena);
        const dist = hit ? Math.max(1.5, hit.distance - 1) : spec.distance;
        const end = start.clone().addScaledVector(dir, dist);

        const airborne = settleTeleport(player, game.arena, start, end);

        self.areaDamage(start.clone().setY(start.y + 1), spec.radius, spec.damage, {
          proc: 1, source: 'Blink',
        });
        game.fxApi.explosion(start.clone().setY(start.y + 1), spec.radius, spec.color, 0.9);
        game.fxApi.beam(start.clone().setY(start.y + 1), end.clone().setY(end.y + 1), spec.color, 0.28, 0.22);

        player.position.copy(end);
        // Horizontal speed is shed on arrival; vertical is not, so a blink taken
        // mid-jump keeps the arc it was already on.
        player.velocity.x *= 0.5;
        player.velocity.z *= 0.5;
        // Blinking is not a jump and does not land you: come out of it airborne
        // with the jumps you had left still in hand.
        if (airborne) player.grounded = false;
        player.dashIFrames = Math.max(player.dashIFrames || 0, 0.22);
        player.snapCamera();
        game.fxApi.glow(end.clone().setY(end.y + 1), { color: spec.color, size: 2, life: 0.3, grow: 2 });
      },

      /** Scatter of seekers that pick their own targets. */
      homingVolley(spec) {
        const player = game.player;
        const base = player.aimDirection(new THREE.Vector3());
        for (let i = 0; i < spec.count; i++) {
          const v = base.clone();
          v.x += (game.rng.next() - 0.5) * spec.spread;
          v.y += (game.rng.next() - 0.5) * spec.spread * 0.6 + 0.25;
          v.z += (game.rng.next() - 0.5) * spec.spread;
          v.normalize().multiplyScalar(24);
          game.projectiles.spawn({
            position: player.chestPosition.clone(), velocity: v,
            damage: spec.damage, proc: 0.6, radius: 0.2, life: 4, color: spec.color,
            gravity: 0, homingRadius: 40, homingStrength: 5, trail: 1, glow: 1.8,
            source: 'Umbral Volley',
          });
        }
      },

      shieldCharge(spec) {
        game.player.startShieldCharge(spec);
        game.player.grantBarrier(game.player.stats.maxHealth * (spec.barrier ?? 0.15));
      },

      bastion(spec) {
        const player = game.player;
        player.addBuff('bastion', spec.duration, spec.reduction, 1, '⬢ Bastion',
          { radius: spec.radius, color: spec.color });
        player.grantBarrier(player.stats.maxHealth * spec.barrier);
        game.fxApi.ring(player.position, 1, spec.radius, spec.color, 0.8, 1);
        game.ui.toast('BASTION', '#6fd0ff');
      },

      /** Bulwark's ultimate: six seconds of simply not being killable. */
      lastStand(spec) {
        const player = game.player;
        player.invulnerable = Math.max(player.invulnerable, spec.duration);
        player.grantBarrier(player.stats.maxHealth * (spec.barrier ?? 0.5));
        player.addBuff('laststand', spec.duration, 1, 1, '🛡️ Last Stand', {
          radius: spec.radius, color: spec.color, damage: spec.damage,
          interval: spec.interval, knockback: spec.knockback,
        });
        self.lastStandTimer = 0;
        game.fxApi.ring(player.position, 1, spec.radius, spec.color, 0.9, 1);
        game.engine.addShake(0.5);
      },

      /* ---------------- flight ---------------- */

      /** Halcyon's identity: leave the floor and stay off it. */
      flight(spec) { game.player.startFlight(spec); },

      /** Bombs on a ballistic arc that go off on whatever they touch first. */
      bombVolley(spec) {
        const player = game.player;
        const base = player.aimDirection(new THREE.Vector3());
        const color = spec.color ?? 0x7fe0ff;
        for (let i = 0; i < spec.count; i++) {
          const v = base.clone();
          const spread = spec.spread ?? 0.08;
          v.x += (game.rng.next() - 0.5) * spread * 2;
          v.y += (game.rng.next() - 0.5) * spread + 0.03;
          v.z += (game.rng.next() - 0.5) * spread * 2;
          v.normalize().multiplyScalar(spec.speed ?? 44);
          game.projectiles.spawn({
            position: player.muzzlePosition.clone(), velocity: v,
            damage: 0, radius: 0.26, life: 5, color, gravity: spec.gravity ?? -20,
            trail: 1.2, glow: 1.9, detonateOnGround: true,
            splash: { radius: spec.radius ?? 7, damage: spec.damage, proc: 1, color, force: 12 },
            source: 'Bomb Cluster',
          });
        }
        player.addRecoil(2.2);
        game.engine.addShake(0.14);
      },

      /* ---------------- marks and lances ---------------- */

      /**
       * A spear that does nothing at all on the way in.
       *
       * Zero damage is the point: what it buys is the mark on everything near
       * where it sticks, and the mark is what the dash is looking for.
       */
      markSpear(spec) {
        const player = game.player;
        const dir = player.aimDirection(new THREE.Vector3());
        const color = spec.color ?? 0x9dff6a;
        const radius = spec.radius ?? 13;
        const duration = spec.duration ?? 10;
        game.projectiles.spawn({
          position: player.muzzlePosition.clone(),
          velocity: dir.clone().multiplyScalar(spec.speed ?? 78),
          damage: 0, proc: 0, radius: 0.22, life: 3, color,
          gravity: -6, trail: 1.3, glow: 1.6,
          onLand: (position) => {
            const n = self.markEnemies(position, radius, duration, color);
            game.fxApi.explosion(position, radius * 0.35, color, 0.6);
            if (n > 0) game.ui.toast(`${n} MARKED`, '#9dff6a');
          },
          source: 'Marking Spear',
        });
        player.addRecoil(1.4);
      },

      /**
       * A dash that goes *through* people.
       *
       * The refund is the whole design: land it on something the spear painted
       * and the dash comes straight back, so a well-thrown spear turns into a
       * chain of dashes across a crowd. Only the enemy actually struck spends
       * its mark — everything else the spear painted stays painted — and the
       * refund is capped at one per dash so a line of marked targets is a
       * bonus rather than infinite movement.
       */
      lanceDash(spec) {
        const player = game.player;
        const color = spec.color ?? 0x9dff6a;
        let refunded = false;
        player.startDash({
          speed: spec.speed ?? 40,
          duration: spec.duration ?? 0.3,
          iframes: spec.iframes ?? 0.2,
          damage: spec.damage ?? 0,
          radius: spec.radius ?? 2.4,
          color,
          source: 'Lance Dash',
          onHit: (enemy) => {
            if (refunded || !enemy.statuses.has('marked')) return;
            enemy.statuses.delete('marked');
            refunded = true;
            self.refundUtility();
            game.fxApi.ring(enemy.position, 0.5, 5, color, 0.4, 0.9);
            game.ui.toast('MARK CONSUMED — DASH READY', '#9dff6a');
          },
        });
      },

      /* ---------------- ultimates ---------------- */

      /** Vanguard: shells walked onto the aim point, one after another. */
      mortarStorm(spec) {
        const target = self.ctx.aimPoint.clone();
        for (let i = 0; i < spec.count; i++) {
          game.projectiles.spawnMortar({
            target, scatter: spec.spread ?? 14, delay: i * (spec.interval ?? 0.09),
            color: spec.color,
            splash: {
              radius: spec.radius ?? 8, damage: spec.damage, proc: 0.6,
              color: spec.color, force: 10,
            },
            source: 'Fire Mission',
          });
        }
        game.engine.addShake(0.3);
      },

      /** Unloader: up, then very suddenly down. Resolved over several frames. */
      meteorSlam(spec) {
        const player = game.player;
        player.endGrapple();
        player.velocity.y = Math.max(player.velocity.y, spec.riseSpeed ?? 26);
        player.grounded = false;
        player.invulnerable = Math.max(player.invulnerable, 0.5);
        self._pendingSlam = { spec, phase: 'rise', timer: 0.75 };
        game.fxApi.ring(player.position, 0.5, 8, spec.color, 0.5, 0.9);
        game.engine.addShake(0.3);
      },

      /** Wraith: holes in the world, and something thrown into each of them. */
      voidStorm(spec) {
        const centre = self.ctx.aimPoint.clone();
        const count = spec.singularities ?? 3;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * TAU;
          const p = centre.clone();
          p.x += Math.cos(a) * spec.radius * 0.45;
          p.z += Math.sin(a) * spec.radius * 0.45;
          p.y = game.arena.groundHeightAt(p.x, p.z);
          game.projectiles.spawnSingularity(p, spec.radius, spec.singularityDamage);
        }
        api.homingVolley({
          count: spec.shades ?? 24, damage: spec.shadeDamage, color: spec.color, spread: 1.7,
        });
        game.fxApi.ring(game.player.position, 1, spec.radius, spec.color, 0.8, 1);
        game.engine.addShake(0.5);
      },

      /** Halcyon: a bombing run walked out along the line you are looking down. */
      carpetBomb(spec) {
        const player = game.player;
        const dir = self.ctx.dir.clone().setY(0);
        if (dir.lengthSq() < 1e-6) dir.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
        dir.normalize();
        const start = player.position.clone();
        for (let i = 0; i < spec.count; i++) {
          const t = i / Math.max(1, spec.count - 1);
          const p = start.clone().addScaledVector(dir, 7 + t * (spec.length ?? 60));
          p.x += (game.rng.next() - 0.5) * (spec.width ?? 10);
          p.z += (game.rng.next() - 0.5) * (spec.width ?? 10);
          game.projectiles.spawnMortar({
            target: p, scatter: 0, delay: i * (spec.interval ?? 0.07), color: spec.color,
            splash: {
              radius: spec.radius ?? 8, damage: spec.damage, proc: 0.5,
              color: spec.color, force: 12,
            },
            source: 'Carpet Bombing',
          });
        }
        game.engine.addShake(0.35);
      },

      /** Javelin: everything painted at once, then the sky falls on it. */
      spearStorm(spec) {
        const player = game.player;
        const color = spec.color ?? 0x9dff6a;
        const marked = self.markEnemies(player.position, spec.markRadius, spec.markDuration, color);
        const targets = game.enemies.inRadius(player.position, spec.markRadius);
        for (let i = 0; i < spec.count; i++) {
          // Spears land on what is actually there; with nothing in range they
          // still come down around you rather than vanishing.
          const t = targets.length
            ? targets[i % targets.length].position
            : player.position;
          game.projectiles.spawnMortar({
            target: t, scatter: targets.length ? 3 : 14, delay: i * (spec.interval ?? 0.08),
            color,
            splash: { radius: spec.radius ?? 6, damage: spec.damage, proc: 0.6, color, force: 8 },
            source: 'Impaling Storm',
          });
        }
        player.addBuff('freedash', spec.freeDashTime ?? 8, 1, 1, '➤ Free Dash');
        self.refundUtility();
        game.ui.toast(`${marked} MARKED`, '#9dff6a');
        game.engine.addShake(0.4);
      },
    };

    return api;
  }
}

function falloffScale(distance, f) {
  if (distance <= f.start) return 1;
  if (distance >= f.end) return f.min;
  const t = (distance - f.start) / (f.end - f.start);
  return 1 + (f.min - 1) * t;
}
