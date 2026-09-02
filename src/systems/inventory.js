import * as THREE from 'three';
import { itemById } from '../data/items.js';
import { equipmentById } from '../data/equipment.js';
import { AFFIX_BY_ID } from '../data/enemies.js';
import { rollProc } from '../core/mathx.js';

const _v = new THREE.Vector3();

/**
 * Holds the run's items and dispatches their hooks.
 *
 * Item code never touches the game object directly — it receives `ctx`, a stable
 * façade built here. That keeps items declarative and makes them safe to add.
 */
export class Inventory {
  constructor(game) {
    this.game = game;
    this.stacks = new Map();       // itemId -> count
    this.order = [];               // acquisition order, for the HUD strip
    this.internalCooldowns = new Map();
    this.timers = new Map();
    this.scheduled = [];
    this.frame = 0;
    /* The equipment slot: one thing, its cooldown, and a scratch object it owns.
     *
     * Deliberately not part of `stacks`. Items are a bag you add to; equipment
     * is a slot you *replace*, and modelling the second as a special case of
     * the first is how you end up with two of something that can only be one.
     * `equipState` is where a piece of equipment keeps whatever it needs
     * between presses — the recall beacon's mark — and it is cleared whenever
     * the slot changes, so the new one never inherits the last one's mind. */
    this.equipment = null;
    this.equipTimer = 0;
    this.equipState = {};
    this.effigies = [];
    this.ctx = this._buildContext();
  }

  // ------------------------------------------------------------------ equipment
  /**
   * Puts something in the slot and hands back whatever was in it.
   *
   * The swap is the whole interaction: you cannot hold two, so taking one is
   * always also giving one up, and the caller is told what it cost so it can
   * say so.
   */
  equip(equipmentId) {
    const next = equipmentById(equipmentId);
    if (!next) return null;
    const previous = this.equipment;
    this.equipment = next;
    this.equipState = {};
    // A fresh piece of equipment arrives ready. It is a decision you have to be
    // able to make now, not in forty seconds.
    this.equipTimer = 0;
    return previous;
  }

  get equipReady() { return !!this.equipment && this.equipTimer <= 0; }

  /** What one press costs, after item cooldown reduction. */
  equipCooldown() {
    const mult = this.game.player?.stats.cooldownMult ?? 1;
    return Math.max(0.5, (this.equipment?.cooldown ?? 10) * mult);
  }

  /**
   * Fires the equipment.
   *
   * `use` returning false is a refusal, not a failure: the recall beacon's
   * outbound press plants a mark and explicitly declines the cooldown, because
   * what you are paying for is the trip back.
   */
  useEquipment() {
    if (!this.equipReady || this.game.player?.dead || this.game.paused) return false;
    const eq = this.equipment;
    let charged = true;
    try {
      charged = eq.use(this.ctx) !== false;
    } catch (err) {
      console.error(`Equipment "${eq.id}" failed`, err);
    }
    if (charged) {
      this.equipTimer = this.equipCooldown();
      this.trigger('onEquipment', { equipment: eq });
    }
    return charged;
  }

  // ------------------------------------------------------------------ contents
  add(itemId, count = 1) {
    const cur = this.stacks.get(itemId) || 0;
    if (cur === 0) this.order.push(itemId);
    this.stacks.set(itemId, cur + count);
    this.game.player.markStatsDirty();
    return this.stacks.get(itemId);
  }

  remove(itemId, count = 1) {
    const cur = this.stacks.get(itemId) || 0;
    const next = Math.max(0, cur - count);
    if (next === 0) {
      this.stacks.delete(itemId);
      this.order = this.order.filter((id) => id !== itemId);
    } else {
      this.stacks.set(itemId, next);
    }
    this.game.player.markStatsDirty();
  }

  count(itemId) { return this.stacks.get(itemId) || 0; }
  has(itemId) { return this.stacks.has(itemId); }
  get totalItems() { return [...this.stacks.values()].reduce((a, b) => a + b, 0); }

  entries() { return this.order.map((id) => ({ item: itemById(id), stacks: this.stacks.get(id) })); }

  // ------------------------------------------------------------------ stats
  /**
   * Folds every held item's passive modifiers into the accumulator.
   *
   * `player` is handed in as a fourth argument, and may be undefined: this runs
   * from `recomputeStats`, which the Player constructor calls before
   * `game.player` has been assigned. Nothing is held at that point so no item
   * code actually runs, but an item that reads it must still guard — which is
   * cheap, and worth it for the items that only make sense against a
   * particular character's kit.
   */
  applyStats(acc) {
    for (const [id, stacks] of this.stacks) {
      const item = itemById(id);
      item?.stats?.(stacks, acc, this.game.run, this.game.player);
    }
  }

  // ------------------------------------------------------------------ hooks
  trigger(hookName, ev = {}) {
    for (const [id, stacks] of this.stacks) {
      const item = itemById(id);
      const fn = item?.hooks?.[hookName];
      if (fn) {
        try { fn(this.ctx, stacks, ev); }
        catch (err) { console.error(`Item "${id}" hook ${hookName} failed`, err); }
      }
    }
  }

  /** Damage-modifying hooks fold in sequence so multiple items compose. */
  modifyDamage(ev) {
    let damage = ev.damage;
    for (const [id, stacks] of this.stacks) {
      const fn = itemById(id)?.hooks?.modifyDamage;
      if (!fn) continue;
      try { damage = fn(this.ctx, stacks, { ...ev, damage }) ?? damage; }
      catch (err) { console.error(`Item "${id}" modifyDamage failed`, err); }
    }
    return damage;
  }

  /**
   * Incoming-damage hooks, folded in sequence like `modifyDamage`.
   * Runs after armour, so an item sees the number that is about to land.
   */
  modifyIncoming(ev) {
    let amount = ev.amount;
    for (const [id, stacks] of this.stacks) {
      const fn = itemById(id)?.hooks?.modifyIncoming;
      if (!fn) continue;
      try { amount = fn(this.ctx, stacks, { ...ev, amount }) ?? amount; }
      catch (err) { console.error(`Item "${id}" modifyIncoming failed`, err); }
    }
    return amount;
  }

  /** Lethal-damage interception. Returns true when an item prevented death. */
  triggerFatal() {
    for (const [id, stacks] of this.stacks) {
      const fn = itemById(id)?.hooks?.onFatal;
      if (!fn) continue;
      try { if (fn(this.ctx, stacks, {})) return true; }
      catch (err) { console.error(`Item "${id}" onFatal failed`, err); }
    }
    return false;
  }

  update(dt) {
    this.frame++;
    this.ctx.frame = this.frame;

    for (const [k, t] of this.internalCooldowns) {
      const next = t - dt;
      if (next <= 0) this.internalCooldowns.delete(k);
      else this.internalCooldowns.set(k, next);
    }
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      this.scheduled[i].time -= dt;
      if (this.scheduled[i].time <= 0) {
        const fn = this.scheduled[i].fn;
        this.scheduled.splice(i, 1);
        try { fn(); } catch (err) { console.error('Scheduled item effect failed', err); }
      }
    }
    if (this.equipTimer > 0) this.equipTimer = Math.max(0, this.equipTimer - dt);
    // The recall mark expires on its own; a beacon you planted a minute ago is
    // not somewhere you want to be sent.
    if (this.equipState.beaconTime > 0) {
      this.equipState.beaconTime -= dt;
      if (this.equipState.beaconTime <= 0) this.equipState.beacon = null;
    }
    this._tickEffigies(dt);
    this.trigger('onTick', { dt });
  }

  reset() {
    this.stacks.clear();
    this.order.length = 0;
    this.internalCooldowns.clear();
    this.timers.clear();
    this.scheduled.length = 0;
    this.equipment = null;
    this.equipTimer = 0;
    this.equipState = {};
    this._clearEffigies();
  }

  /**
   * Everything this system has left standing in the arena.
   *
   * The same contract `Combat.clearWorldObjects` has, and needed for the same
   * reason: an effigy is a position on a stage, and a run builds a fresh
   * `Inventory`, so anything the old one put in the scene has nobody left to
   * remove it. The recall mark goes too — a beacon planted on the last stage
   * is not somewhere anyone should be sent.
   */
  clearWorldObjects() {
    this._clearEffigies();
    this.equipState.beacon = null;
    this.equipState.beaconTime = 0;
  }

  _clearEffigies() {
    for (const e of this.effigies) {
      e.mesh.parent?.remove(e.mesh);
      e.mesh.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
    }
    this.effigies.length = 0;
  }

  /**
   * Effigies burning on the ground.
   *
   * The one piece of equipment that leaves something behind, so the something
   * has to be ticked by somebody. It lives here rather than in the projectile
   * system because it is not a projectile: it does not travel, it does not
   * collide, and it outlives the press that made it.
   */
  _tickEffigies(dt) {
    for (let i = this.effigies.length - 1; i >= 0; i--) {
      const e = this.effigies[i];
      e.time -= dt;
      e.tick -= dt;
      e.mesh.rotation.y += dt * 1.4;
      e.mesh.position.y = e.baseY + Math.sin(e.time * 3) * 0.12;
      if (e.tick <= 0) {
        e.tick = 0.5;
        for (const enemy of this.game.enemies.inRadius(e.position, e.radius)) {
          this.game.combat.damageEnemy(enemy, e.dps * 0.5, { proc: 0.2, source: 'Effigy of Spite' });
          enemy.applyStatus('chill', 1.2, { slow: 0.65 });
          // The taunt: everything looks at the effigy instead of at you, which
          // is done by taking the player away rather than by adding a target.
          enemy.loseTarget?.(0.9);
        }
        this.game.fxApi.ring(e.position, e.radius * 0.4, e.radius, e.color, 0.5, 0.5);
      }
      if (e.time <= 0) {
        this.game.fxApi.explosion(e.position, e.radius * 0.5, e.color, 0.8);
        e.mesh.parent?.remove(e.mesh);
        e.mesh.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
        this.effigies.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------------ context
  _buildContext() {
    const game = this.game;
    const self = this;

    return {
      frame: 0,
      get player() { return game.player; },
      get run() { return game.run; },
      get rng() { return game.rng; },
      get fx() { return game.fxApi; },

      /** Rolls a chance scaled by the triggering hit's proc coefficient. */
      procRoll(chance, proc = 1) {
        if (proc <= 0) return false;
        return rollProc(chance * proc, game.rng) > 0;
      },

      isOnInternalCooldown(key) { return self.internalCooldowns.has(key); },
      setInternalCooldown(key, seconds) { self.internalCooldowns.set(key, seconds); },

      /** Repeating timer keyed by name; invokes `fn` every `interval` seconds. */
      timer(key, dt, interval, fn) {
        const t = (self.timers.get(key) ?? 0) - dt;
        if (t <= 0) { self.timers.set(key, interval); fn(); }
        else self.timers.set(key, t);
      },

      schedule(delay, fn) { self.scheduled.push({ time: delay, fn }); },

      heal(amount, source, silent) { return game.player.heal(amount, source, silent); },
      grantBarrier(amount) { game.player.grantBarrier(amount); },
      addBuff(id, dur, power, maxStacks, label, extra) { game.player.addBuff(id, dur, power, maxStacks, label, extra); },
      applyStatus(enemy, id, dur, data) { enemy.applyStatus(id, dur, data); },
      consumeItem(id, count) { self.remove(id, count); },
      toast(text, color) { game.ui.toast(text, color); },
      shake(amount) { game.engine.addShake(amount); },

      damageEnemy(enemy, amount, opts) { return game.combat.damageEnemy(enemy, amount, opts); },
      areaDamage(pos, radius, amount, opts) { return game.combat.areaDamage(pos, radius, amount, opts); },
      nearestEnemies(pos, radius, count) { return game.enemies.nearest(pos, radius, count); },

      reduceCooldowns(seconds) { game.combat.reduceCooldowns(seconds); },

      /* ---------------- abilities ---------------- */
      /** The player's damage stat, which is what every payload is quoted in. */
      get damage() { return game.player.stats.damage; },
      get aimPoint() { return game.player.aimPoint; },
      get combat() { return game.combat; },
      get equipState() { return self.equipState; },

      /** Hands one use of an ability back — a charge, or a cleared timer. */
      refundAbility(kind) { game.combat.refundAbility(kind); },
      /** Puts a fraction of the ultimate meter back. */
      refundUltimate(fraction) { game.combat.refundUltimate(fraction); },
      /** Casts an ability again for free. Cannot recurse — see `recastAbility`. */
      recastAbility(kind, ability) { game.combat.recastAbility(kind, ability); },
      get recasting() { return game.combat.recasting; },

      grantGold(amount) { game.player.addGold(amount); },

      /** Heals every teammate but you. A no-op in single player, by design. */
      healAllies(amount) {
        for (const p of game.party()) {
          if (p !== game.player) p.heal?.(amount, 'Ally');
        }
      },

      /* ---------------- equipment payloads ---------------- */
      /**
       * A line drawn out of the muzzle that hurts everything near it.
       *
       * Not `hitscan`: that stops at the world and resolves one body at a time
       * down a ray, which is a bullet. This is a *lance* — a cylinder of
       * effect, so a beam two metres wide catches the three bodies standing
       * shoulder to shoulder rather than the one whose centre the ray happened
       * to cross. Returns how many it caught.
       */
      beamLine({ damage, range = 120, radius = 2.4, color = 0x8fd8ff, source = 'Equipment', onHit = null }) {
        const player = game.player;
        const origin = player.muzzlePosition.clone();
        const dir = player.aimDirection(_v.clone());
        const end = origin.clone().addScaledVector(dir, range);
        let count = 0;
        for (const e of game.enemies.list) {
          if (e.dead) continue;
          // Distance from the enemy's centre to the segment, clamped to it.
          const to = e.center.clone().sub(origin);
          const along = Math.max(0, Math.min(range, to.dot(dir)));
          const near = origin.clone().addScaledVector(dir, along);
          if (near.distanceTo(e.center) > radius + e.radius) continue;
          count++;
          game.combat.damageEnemy(e, damage, { proc: 1, source, hitPoint: e.center.clone() });
          onHit?.(e);
        }
        game.fxApi.beam(origin, end, color, 0.4, 0.32);
        game.fxApi.muzzle(origin, dir, color, 3);
        return count;
      },

      /** A slow, heavy, arcing charge that detonates enormously where it lands. */
      lobCharge({ speed = 26, gravity = -9, radius = 20, damage, color = 0x9a5bff, source = 'Equipment' }) {
        const player = game.player;
        game.projectiles.spawn({
          position: player.chestPosition.clone(),
          velocity: player.aimDirection(new THREE.Vector3()).multiplyScalar(speed),
          damage: 0, proc: 0, radius: 0.7, life: 6, color,
          gravity, trail: 2.2, glow: 3, detonateOnGround: true,
          splash: { radius, damage, proc: 1, color, force: 26 },
          source,
        });
      },

      /** Plants an effigy. Ticked by the inventory — see `_tickEffigies`. */
      plantEffigy({ duration = 12, radius = 18, dps = 0, color = 0xff6ad0 }) {
        const p = game.player.position.clone();
        p.y = game.arena.groundHeightAt(p.x, p.z, p.y + 2) + 1.1;
        const mesh = new THREE.Mesh(
          new THREE.ConeGeometry(0.55, 2.2, 6),
          new THREE.MeshStandardMaterial({
            color, emissive: color, emissiveIntensity: 1.6, roughness: 0.4, metalness: 0.5,
          }),
        );
        mesh.position.copy(p);
        mesh.castShadow = true;
        game.engine.scene.add(mesh);
        self.effigies.push({
          mesh, position: p.clone(), baseY: p.y, radius, dps, color,
          time: duration, tick: 0,
        });
        game.fxApi.ring(p, 0.5, radius, color, 0.7, 0.9);
      },

      /** Puts the player somewhere, standing on whatever is there. */
      teleportTo(position) {
        const p = game.player;
        const end = position.clone();
        end.y = game.arena.groundHeightAt(end.x, end.z, end.y + 3);
        game.fxApi.beam(p.chestPosition.clone(), end.clone().setY(end.y + 1), 0x46e0c0, 0.3, 0.18);
        p.position.copy(end);
        p.velocity.set(0, 0, 0);
        p.grounded = true;
        p.jumpsUsed = 0;
        p.snapCamera();
      },

      chainLightning(from, jumps, damage, range, color) {
        game.combat.chainFrom(from, jumps, damage, range, color, 1);
      },

      fireMissile(target, damage) {
        game.projectiles.spawn({
          position: game.player.chestPosition.clone(),
          velocity: _v.set(0, 12, 0).clone(),
          damage, proc: 0.4, radius: 0.22, life: 4, color: 0xffb347, gravity: 0,
          homingRadius: 40, homingStrength: 5, target, trail: 1,
          splash: { radius: 5, damage, proc: 0.4, color: 0xffb347 },
          source: 'Seeker Missile',
        });
      },

      spawnDaggers(position, count, damage) {
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2 + game.rng.next();
          game.projectiles.spawn({
            position: position.clone().setY(position.y + 1),
            velocity: new THREE.Vector3(Math.cos(a) * 16, 3, Math.sin(a) * 16),
            damage, proc: 0.5, radius: 0.18, life: 3.2, color: 0xffe0a0, gravity: 0,
            homingRadius: 30, homingStrength: 4.5, trail: 0.8, dagger: true, source: 'Spirit Daggers',
          });
        }
      },

      spawnDisc(damage) {
        const dir = game.player.aimDirection(new THREE.Vector3());
        game.projectiles.spawn({
          position: game.player.chestPosition.clone(),
          velocity: dir.multiplyScalar(34),
          damage, proc: 0.3, radius: 0.55, life: 3.4, color: 0xff8a3d, gravity: 0,
          pierce: 99, trail: 1.4, disc: true, glow: 2, source: 'Resonance Disc',
        });
        game.ui.toast('Resonance Disc released', '#ff8a3d');
      },

      spawnSingularity(position, radius, damage) {
        game.projectiles.spawnSingularity(position, radius, damage);
      },

      razorBurst(count, range, damage) {
        const targets = game.enemies.nearest(game.player.position, range, count);
        for (const t of targets) {
          game.combat.damageEnemy(t, damage, { proc: 0.4, source: 'Razorwire' });
          game.fxApi.beam(game.player.chestPosition, t.center, 0xff4d5e, 0.16);
        }
      },

      stealAffix(affixId, duration) {
        const affix = AFFIX_BY_ID[affixId];
        if (!affix) return;
        game.player.addBuff('stolen_affix', duration, 1, 1, `${affix.name}`, { affix: affixId });
        game.ui.toast(`Stole ${affix.name}`, '#4aa8ff');
      },
    };
  }
}
