import * as THREE from 'three';
import { itemById } from '../data/items.js';
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
    this.ctx = this._buildContext();
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
  applyStats(acc) {
    for (const [id, stacks] of this.stacks) {
      const item = itemById(id);
      item?.stats?.(stacks, acc, this.game.run);
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
    this.trigger('onTick', { dt });
  }

  reset() {
    this.stacks.clear();
    this.order.length = 0;
    this.internalCooldowns.clear();
    this.timers.clear();
    this.scheduled.length = 0;
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
