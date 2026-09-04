import * as THREE from 'three';
import { PLAYER, CAMERA } from '../core/config.js';
import { clamp, clamp01, damp, armorMultiplier, angleLerp } from '../core/mathx.js';
import { audio } from '../core/audio.js';
import { settings } from '../core/settings.js';
import { moveWithCollision, raycastWorld, raycastBoxes } from '../systems/physics.js';
import { buildPlayerModel } from './models.js';
import { createRig, updateRig, rigRecoil, rigFlinch } from './characterRig.js';
import { characterById } from '../data/characters.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camWant = new THREE.Vector3();
const _camBack = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camProbe = new THREE.Vector3();
const _camChest = new THREE.Vector3();
const _camSight = new THREE.Vector3();
// Centre, then four corners of the camera's cross-section. Cheaper than a
// sphere cast and enough that nothing trunk-width threads between them.
const BOOM_PROBES = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];

const settingsTurnSnap = () => settings.data.turnSnap ?? 1;

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
    addEggs: 0, multPetDamage: 1, multPetHealth: 1, addPetVolley: 0,
    // Fraction knocked off the price of everything on the stage.
    priceMult: 0,
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

    /* The camera and the body are two different things.
     *
     * `camYaw`/`camPitch` are where you are LOOKING — the mouse drives them and
     * nothing else does. `yaw` is where the character is FACING, which follows
     * your travel direction while you are just running around and snaps to the
     * camera the moment you do something that needs the body pointed at what
     * you are aiming at. That separation is the whole reason you can run one
     * way and watch another. */
    this.camYaw = 0;
    this.camPitch = -0.12;
    this.yaw = 0;
    this.pitch = -0.12;
    this.modelYaw = 0;
    this.camLift = 0;

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
    // Parry: a window, not a state. Non-zero means the next thing to touch you
    // is going to regret it — see `takeDamage`.
    this.parryTime = 0;
    // Overshield: what Bulwark's passive is waiting on, so it can only fire
    // once every twenty seconds however many big hits arrive in between.
    this.overshieldTimer = 0;
    this.dashDir = new THREE.Vector3();
    this.dashPitched = false;     // dash flies its own line, gravity suspended
    this.dashSpec = null;         // { damage, radius, onHit, hit:Set } for a piercing dash
    // Movement states driven by character abilities.
    this.grapple = null;          // { anchor, time, enemy }
    this.diveSlam = null;         // { target, speed, onLand } — a committed drop
    this.shieldCharge = null;     // { dir, time, hit:Set }
    this.flight = null;           // { time, riseSpeed, hoverSpeed, speedMult, color }

    this.buffs = new Map();
    this.statuses = new Map();
    this.stealAffix = null;

    this.timeSinceDamage = 99;
    this.combatTimer = 0;
    this.aiming = false;
    this.aimBlend = 0;
    // How far behind a scoped weapon's glass the camera currently is. Separate
    // from `aimBlend` because aiming and scoping are different postures: one
    // leans over the shoulder, the other collapses onto the eye.
    this.scopeBlend = 0;
    this.rig = createRig(this.yaw);
    // Footfalls come from the rig rather than from a timer: the gait blend
    // changes cadence as you turn from a run into a shuffle, and a timer would
    // drift off the feet the moment it did.
    this.rig.onStep = (stride) => {
      if (!this.dead) audio.footstep(this.position, stride > 0.7);
    };

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
    let damageMult = 1;
    let damageTakenMult = acc.multDamageTaken;

    /* Generic item buffs.
     *
     * The named buffs below are character abilities, and each of them does
     * something bespoke enough to be worth writing out. Items only ever want a
     * temporary multiplier on one of four numbers, and making this function
     * learn the name of every item that grants one does not scale — so a buff
     * carrying `extra.stat` folds itself in and nothing here needs updating
     * when the next one is written. */
    for (const b of this.buffs.values()) {
      const stat = b.extra?.stat;
      if (!stat) continue;
      const f = 1 + b.power * b.stacks;
      if (stat === 'attackSpeed') atkSpeed *= f;
      else if (stat === 'moveSpeed') moveMult *= f;
      else if (stat === 'damage') damageMult *= f;
      else if (stat === 'damageTaken') damageTakenMult *= f;
    }
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
    /* Bulwark behind his plate. Refreshed every frame the button is held, so
       it is a posture rather than a duration.
       The only cost is that he cannot attack, which is paid continuously for
       as long as he holds it — the ability has no cooldown precisely because
       holding it *is* the cooldown. */
    const guard = this.buffs.get('guard');
    if (guard) { damageTakenMult *= 1 - guard.power; moveMult *= guard.extra?.move ?? 1; }

    /* Precision weapons trade the dice for the multiplier.
     *
     * A weapon that never rolls a critical hit makes every point of crit
     * chance you own worthless, which would quietly turn a third of the item
     * pool into dead weight the moment you picked the thing up. So the chance
     * is read as damage instead: the stat still does something, it just does
     * it through the seam you aimed at rather than through a coin flip. */
    const weapon = this.game.combat?.weapon;
    const chance = clamp(base.crit + acc.addCrit, 0, 1);
    const rolledCrit = weapon?.randomCrits === false ? 0 : chance;
    const convertedCrit = weapon?.critChanceToDamage ? chance * weapon.critChanceToDamage : 0;

    // Statuses
    const chill = this.statuses.get('chill');
    if (chill) moveMult *= 1 - (chill.data.slow ?? 0.4);
    const suppress = this.statuses.get('suppress');
    const healingMult = acc.multHealing * (suppress ? (suppress.data.healing ?? 0.4) : 1);

    this.stats = {
      maxHealth,
      damage: damage * damageMult,
      regen,
      attackSpeed: atkSpeed,
      moveSpeed: base.moveSpeed * moveMult,
      crit: rolledCrit,
      critDamage: PLAYER.baseCritDamage + acc.addCritDamage + convertedCrit,
      armor: base.armor + acc.addArmor,
      /* A passive may shorten every cooldown the character has. Folded in here
         rather than at the four call sites that read it, so the utility, the
         special, the secondary and anything written later all get it without
         having to remember to ask. Overclock still wins outright: zero times
         anything is zero. */
      cooldownMult: this.buffs.has('overclock')
        ? 0
        : acc.multCooldown * (this.char.passive?.cooldownMult?.(this) ?? 1),
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
      priceMult: acc.priceMult,
      extraEggs: acc.addEggs,
      petDamageMult: acc.multPetDamage,
      petHealthMult: acc.multPetHealth,
      petVolley: acc.addPetVolley,
    };

    // Gaining max health from items grants the difference, matching genre convention.
    if (prevMax !== undefined && maxHealth > prevMax) this.health += maxHealth - prevMax;
    this.health = clamp(this.health, 0, maxHealth);
    this.statsDirty = false;
  }

  /**
   * What the character's own passive does to its movement speed, right now.
   *
   * Kept out of `recomputeStats` on purpose: Halcyon's altitude changes every
   * frame he is in the air, and a stat that has to be invalidated sixty times a
   * second is not a cached stat. The rig is handed the same number so the gait
   * still knows what a full stride is at speed.
   */
  passiveMoveMult() {
    return this.char.passive?.moveMult?.(this) ?? 1;
  }

  /** Grants a barrier worth a fraction of max health, capped at one bar. */
  grantOvershield(fraction, label = 'OVERSHIELD', color = '#8fd0ff') {
    const amount = this.stats.maxHealth * fraction;
    this.barrier = Math.min(this.stats.maxHealth, this.barrier + amount);
    this.game.fx.ring(this.position, 0.6, 3.4, 0x8fd0ff, 0.5, 0.9);
    this.game.ui.toast(label, color);
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
    // The parry window eats the hit whole and throws it back. Asked before
    // armour, because what is reflected is the blow that was thrown, not the
    // fraction of it your plate would have let through.
    if (this.parryTime > 0 && !opts.dot) {
      this.parryTime = 0;
      this.game.combat?.onParried(amount, opts);
      return 0;
    }

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
    audio.playerHurt(Math.min(1, dmg / (this.stats.maxHealth * 0.3)));
    this.game.ui.flashHurt(Math.min(1, dmg / (this.stats.maxHealth * 0.22)));
    this.game.engine.addShake(Math.min(0.34, 0.06 + dmg / this.stats.maxHealth * 0.9));
    this.game.inventory.trigger('onDamaged', { amount: dmg, source: opts.source });
    // Half the ultimate meter is bought with your own health.
    this.game.combat?.noteDamageTaken(dmg);
    // A character passive may have something to say about being hit.
    this.char.passive?.onDamaged?.(this, dmg, amount, opts);

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
    this.flight = null;
    this.diveSlam = null;
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
    this.parryTime = Math.max(0, this.parryTime - dt);
    this.overshieldTimer = Math.max(0, this.overshieldTimer - dt);
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

    this.aiming = input.actionDown('aim');

    // --- Look ---
    // Looking around keeps working while you are down: in co-op that is the
    // difference between waiting to be revived and staring at the dirt.
    if (input.locked) {
      const look = input.lookDelta(this.aiming);
      // A scope that magnifies eight times and turns at full speed is unusable.
      // The optic's own multiplier scales in with the zoom, so the transition
      // is as smooth as the field of view it belongs to.
      const scopeSens = this.scopeBlend > 0.002
        ? THREE.MathUtils.lerp(1, this.game.combat?.weapon?.scope?.sensitivity ?? 0.45, this.scopeBlend)
        : 1;
      const sens = CAMERA.sensitivity * scopeSens;
      this.camYaw -= look.x * sens;
      this.camPitch -= look.y * sens;
      this.camPitch = clamp(this.camPitch, CAMERA.minPitch, CAMERA.maxPitch);
    }
    if (this.dead) { this._updateBodyFacing(dt); this._updateModel(dt); return; }

    const axis = input.moveAxis();
    // Movement is camera-relative — W is always "away from the camera",
    // whichever way the character happens to be facing at the time.
    _fwd.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    // Screen-right is forward × up. For forward = (sin y, 0, cos y) that is
    // (-cos y, 0, sin y) — the negation of this is left, which is what D used to do.
    _right.set(-_fwd.z, 0, _fwd.x);
    this.moveBasis = { fwd: _fwd, right: _right, axis };
    this._updateBodyFacing(dt);

    // --- Character movement states take over from normal locomotion ---
    if (this.dashTime > 0) { this._tickDash(dt, world); return; }
    if (this.diveSlam) { this._tickDiveSlam(dt, world); this._updateAim(world); this._updateModel(dt); return; }
    if (this.grapple) { this._tickGrapple(dt, world); return; }
    if (this.shieldCharge) { this._tickShieldCharge(dt, world); return; }

    /* --- Flight: a whole different relationship with the floor ---
       A character whose thrusters are innate is simply never without them: the
       flight is re-armed the moment anything takes it away, so it is a property
       of the body rather than an ability with a duration. */
    if (this.char.infiniteFlight && !this.flight) this._startInnateFlight();
    if (this.flight) this._tickFlight(dt);

    // --- Horizontal acceleration ---
    const wish = _v.set(0, 0, 0)
      .addScaledVector(_fwd, axis.y)
      .addScaledVector(_right, axis.x);
    const wishLen = wish.length();
    if (wishLen > 0.001) wish.divideScalar(wishLen);

    // Flying keeps full authority over your own direction — an aircraft that
    // handles like a thrown rock is not a flying character, it is a jump.
    const flightSpeed = this.flight ? (this.flight.speedMult ?? 1) : 1;
    const targetSpeed = this.stats.moveSpeed * flightSpeed * this.passiveMoveMult()
      * (wishLen > 0 ? 1 : 0);
    const accel = (this.grounded || this.flight) ? 62 : 62 * PLAYER.airControl;
    this.velocity.x = damp(this.velocity.x, wish.x * targetSpeed, accel / 6, dt);
    this.velocity.z = damp(this.velocity.z, wish.z * targetSpeed, accel / 6, dt);

    if (wishLen < 0.01) {
      const fr = this.grounded ? PLAYER.groundFriction : PLAYER.airFriction;
      this.velocity.x = damp(this.velocity.x, 0, fr, dt);
      this.velocity.z = damp(this.velocity.z, 0, fr, dt);
    }

    if (this.flight) {
      // Hold the jump binding to climb, hold nothing to sink gently. Gravity is off.
      const rise = input.actionDown('jump')
        ? (this.flight.riseSpeed ?? 11)
        : (this.flight.hoverSpeed ?? -1.4);
      this.velocity.y = damp(this.velocity.y, rise, 7, dt);
    } else {
      // --- Jump ---
      if (input.actionPressed('jump')) {
        if (this.grounded) {
          this.velocity.y = PLAYER.jumpVelocity; this.jumpsUsed = 1; this.grounded = false;
          audio.jump(this.position);
        } else if (this.jumpsUsed < this.stats.maxJumps) {
          this.velocity.y = PLAYER.jumpVelocity * 0.94;
          this.jumpsUsed++;
          this.game.fx.ring(this.position, 0.3, 2.4, 0xb8c8ff, 0.35, 0.55);
          audio.jump(this.position);
        }
      }

      this.velocity.y += PLAYER.gravity * dt;
      this.velocity.y = Math.max(this.velocity.y, -62);
    }

    _v.set(this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt);
    const res = moveWithCollision(this, _v, world);
    if (res.grounded && !this.grounded) {
      // Landing puff
      const hard = this.velocity.y < -14;
      if (hard) this.game.fx.ring(this.position, 0.3, 2.2, 0xffffff, 0.28, 0.3);
      audio.land(this.position, hard);
      this.jumpsUsed = 0;
    }
    // Touching down puts the thrusters out, and hands back half of whatever
    // flight time you did not spend — landing early is rewarded, not punished.
    // Endless flight is the exception: its window is the ability, so touching
    // the floor mid-override is a place to stand rather than the end of it.
    if (res.grounded && this.flight && !this.flight.endless && this.flight.grace <= 0) this.endFlight(true);
    this.grounded = res.grounded;
    if (this.grounded) this.jumpsUsed = 0;

    // --- Regen (ramps up out of combat) ---
    const outOfCombat = this.combatTimer <= 0 ? 2.2 : 1;
    this.heal(this.stats.regen * outOfCombat * dt, null, true);
    if (this.barrier > 0) this.barrier = Math.max(0, this.barrier - this.stats.maxHealth * 0.035 * dt);

    this._updateAim(world);
    this._updateModel(dt);
  }

  /* ---------------------------------------------------------------- facing */
  /**
   * Where the body points, which is now always where the camera points.
   *
   * The body used to turn into its own travel direction whenever you were not
   * fighting, so running left across the screen turned the character side-on
   * and you spent most of a stage looking at an ear. Everything the character
   * does — the weapon in the hand, every ability, the crosshair itself — is
   * resolved along the camera's line, and a body facing ninety degrees off it
   * is a second model sharing a position with the first.
   *
   * So the hips always face straight ahead and the *legs* say which way you
   * are travelling. `characterRig` already blends a run, a backpedal and a
   * side-step out of the velocity in the body's own frame, which is exactly
   * the gait a person running sideways while watching something has.
   *
   * `pitch` is the camera's for the same reason: the spine leans towards
   * whatever you are looking at.
   */
  _updateBodyFacing(dt) {
    this.pitch = this.camPitch;
    if (this.dead) return;
    const rate = CAMERA.bodyTurn * (settingsTurnSnap());
    this.yaw = angleLerp(this.yaw, this.camYaw, 1 - Math.exp(-rate * dt));
  }

  /* ---------------------------------------------------------------- ability movement */

  /**
   * Burst of speed along the current input direction, with optional i-frames.
   *
   * Called bare, this is the baseline roll and its numbers come from `PLAYER` —
   * so a designer changing the dash in config.js changes the dash. A character
   * whose movement is its identity passes its own. A dash that damages what it
   * passes through is optional, because most dashes are an escape and only some
   * of them are an attack.
   */
  startDash({
    speed = PLAYER.dashSpeed,
    duration = PLAYER.dashDuration,
    iframes = PLAYER.iframesOnDash,
    dir = null,
    // A pitched dash keeps the vertical component of its direction instead of
    // flattening it. Every dash in the game is a ground move except the one
    // whose whole promise is that it goes wherever you are looking.
    pitched = false,
    damage = 0,
    radius = 0,
    proc = 1,
    knockback = 8,
    onHit = null,
    source = 'Dash',
    color = 0x8fd8ff,
  } = {}) {
    const basis = this.moveBasis;
    const d = dir ? dir.clone() : new THREE.Vector3();
    if (!dir) {
      const { fwd, right, axis } = basis || {};
      if (basis && (Math.abs(axis.x) > 0.01 || Math.abs(axis.y) > 0.01)) {
        d.addScaledVector(fwd, axis.y).addScaledVector(right, axis.x).normalize();
      } else {
        d.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
      }
    }
    this.dashPitched = pitched && !!dir;
    this.dashDir.copy(this.dashPitched ? d.normalize() : d.setY(0).normalize());
    this.dashSpeed = speed;
    this.dashTime = duration;
    this.dashIFrames = iframes;
    // A dash that hurts carries its own hit set: it goes *through* people, so
    // each one has to be remembered rather than the dash ending on the first.
    this.dashSpec = damage > 0 || onHit
      ? { damage, radius: radius || 2.2, proc, knockback, onHit, source, color, hit: new Set() }
      : null;
    // A climbing dash must not be fighting a fall it inherited; a level one
    // still refuses to carry downward momentum into the burst.
    this.velocity.y = this.dashPitched ? 0 : Math.max(this.velocity.y, 0);
    this.game.fx.ring(this.position, 0.4, 3.2, color, 0.32, 0.6);
    audio.dash(this.position);
    for (let i = 0; i < 8; i++) {
      this.game.fx.spawnParticle(
        this.chestPosition,
        this.dashDir.clone().multiplyScalar(-6).add(
          new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(3)),
        { color, size: 0.16, life: 0.32, gravity: -2 },
      );
    }
  }

  _tickDash(dt, world) {
    this.dashTime -= dt;
    _v.copy(this.dashDir).multiplyScalar(this.dashSpeed * dt);
    // A flat dash drifts with whatever vertical velocity it already had; a
    // pitched one flies its own line and ignores gravity for its duration.
    if (!this.dashPitched) _v.y = this.velocity.y * dt * 0.25;
    const res = moveWithCollision(this, _v, world);
    this.grounded = res.grounded;
    this._dashDamage();
    if (this.dashTime <= 0) {
      this.velocity.x = this.dashDir.x * this.dashSpeed * 0.42;
      this.velocity.z = this.dashDir.z * this.dashSpeed * 0.42;
      // Carrying a little of the climb out keeps a dash up onto a ledge from
      // stopping dead in the air a metre below it.
      if (this.dashPitched) this.velocity.y = this.dashDir.y * this.dashSpeed * 0.35;
      this.dashPitched = false;
      this.dashSpec = null;
    }
    this._updateAim(world);
    this._updateModel(dt);
  }

  /** Everything the lance passes through, once each, on the way past. */
  _dashDamage() {
    const spec = this.dashSpec;
    if (!spec) return;
    for (const e of this.game.enemies.inRadius(this.chestPosition, spec.radius)) {
      if (spec.hit.has(e)) continue;
      spec.hit.add(e);
      // The callback runs before the damage so an ability keyed to a status —
      // Dasher's mark — still sees it on an enemy the dash is about to kill.
      spec.onHit?.(e);
      if (spec.damage > 0) {
        this.game.combat.damageEnemy(e, spec.damage, {
          proc: spec.proc ?? 1, source: spec.source,
          knockback: spec.knockback ?? 8, knockbackDir: this.dashDir.clone().setY(0.3).normalize(),
        });
      }
      this.game.fx.slash(this.chestPosition, this.dashDir, {
        color: spec.color, radius: spec.radius * 1.3, life: 0.16, tilt: 0.3,
      });
    }
  }

  /* ---------------------------------------------------------------- flight */

  /**
   * Thrusters on.
   *
   * Flight is not a long jump: gravity stops applying entirely, Space becomes a
   * throttle, and the body keeps full ground-level control of its direction.
   * The grace window exists so taking off from the floor does not immediately
   * count as landing on it.
   */
  /**
   * Thrusters that were never bought and cannot run out.
   *
   * Deliberately quiet where `startFlight` is loud — no ring, no toast, no
   * fuel — because this is not an ability going off, it is how the character
   * stands up. He sinks about three metres a second with nothing held, which
   * is what lets him touch the floor, take a fight and leave again without ever
   * pressing anything.
   */
  _startInnateFlight() {
    this.flight = {
      time: Infinity, maxTime: Infinity, riseSpeed: 12, hoverSpeed: -3.4,
      speedMult: 1, color: 0xff7a2a, grace: 0, endless: true, innate: true,
    };
  }

  startFlight({ duration = 6, riseSpeed = 11, hoverSpeed = -1.4, speedMult = 1.1, color = 0x7fe0ff, endless = false } = {}) {
    this.flight = { time: duration, maxTime: duration, riseSpeed, hoverSpeed, speedMult, color, grace: 0.45, endless };
    this.grounded = false;
    this.jumpsUsed = 0;
    this.velocity.y = Math.max(this.velocity.y, 7);
    this.game.fx.ring(this.position, 0.4, 4.2, color, 0.45, 0.9);
    this.game.ui.toast('THRUSTERS', '#7fe0ff');
  }

  _tickFlight(dt) {
    const f = this.flight;
    f.grace = Math.max(0, f.grace - dt);
    f.time -= dt;
    if (f.time <= 0) { this.endFlight(false); return; }
    /* Exhaust. Cheap, and it is the only thing that says "this is costing
       fuel" — so innate thrusters only show it when they are actually working
       against gravity, rather than smoking continuously for a whole run. */
    const show = f.innate ? this.velocity.y > 1 && this.game.frame % 3 === 0 : this.game.frame % 2 === 0;
    if (show) {
      this.game.fx.spawnParticle(
        _v2.set(this.position.x, this.position.y + 0.3, this.position.z),
        _v.set((Math.random() - 0.5) * 2.2, -4 - Math.random() * 3, (Math.random() - 0.5) * 2.2),
        { color: f.color, size: 0.13, life: 0.3, gravity: -2, drag: 0.93 },
      );
    }
  }

  /** Cuts the thrusters. Landing early pays half the unspent time back. */
  endFlight(landed = false) {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    this.game.fx.ring(this.position, 0.3, 3, f.color, 0.35, 0.7);
    if (landed && !f.endless && f.time > 0) this.game.combat?.reduceCooldowns(f.time * 0.5);
  }

  /**
   * A committed drop: straight at a point on the ground, fast, and it hurts
   * when it arrives.
   *
   * Not a dash and not the meteor slam. A dash carries you along a direction
   * for a fixed time; this travels to a *place*, arrives when it gets there,
   * and cannot be steered on the way — which is what makes choosing the place
   * the entire skill of the ability. It also cannot be interrupted, so the
   * i-frames are honest rather than generous: you are safe because you are
   * moving at forty metres a second, not because the ability says so.
   *
   * `straightDown` ignores the aim and drops on the spot, which is what a
   * ground slam is when the character is already above what he wants to hit.
   */
  startDiveSlam({
    speed = 46, radius = 8, maxRange = 34, straightDown = false,
    color = 0xff7a2a, iframes = 0.25, onLand = null,
  } = {}) {
    void radius;
    const target = new THREE.Vector3();
    if (straightDown) {
      target.copy(this.position);
      target.y = this.game.arena.groundHeightAt(this.position.x, this.position.z, this.position.y + 1);
    } else {
      target.copy(this.aimPoint);
      // Cap the reach so it stays a slam rather than a teleport with a crater.
      _v.copy(target).sub(this.position);
      if (_v.length() > maxRange) target.copy(this.position).addScaledVector(_v.normalize(), maxRange);
      target.y = this.game.arena.groundHeightAt(target.x, target.z, target.y + 3);
    }
    this.diveSlam = { target, speed, color, onLand, time: 0 };
    this.dashIFrames = Math.max(this.dashIFrames || 0, iframes);
    this.invulnerable = Math.max(this.invulnerable, iframes);
    this.game.fx.ring(this.position, 0.4, 4, color, 0.35, 0.8);
  }

  _tickDiveSlam(dt, world) {
    const d = this.diveSlam;
    d.time += dt;
    _v.copy(d.target).sub(this.position);
    const dist = _v.length();
    const step = d.speed * dt;
    // Arrived, ran out of patience, or hit something on the way: all three end
    // it here, because a slam that never lands is a player stuck in the air.
    if (dist <= step || d.time > 1.6) {
      const landing = this.position.clone();
      this.diveSlam = null;
      this.velocity.set(0, 0, 0);
      d.onLand?.(landing);
      return;
    }
    _v.divideScalar(dist);
    this.velocity.copy(_v).multiplyScalar(d.speed);
    const res = moveWithCollision(this, _v.multiplyScalar(step), world);
    this.grounded = res.grounded;
    if (this.game.frame % 2 === 0) {
      this.game.fx.spawnParticle(
        _v2.copy(this.position).setY(this.position.y + 0.5),
        _v.set((Math.random() - 0.5) * 3, 3 + Math.random() * 3, (Math.random() - 0.5) * 3),
        { color: d.color, size: 0.18, life: 0.35, gravity: 2, drag: 0.93 },
      );
    }
    if (res.grounded || res.hitWall) {
      const landing = this.position.clone();
      this.diveSlam = null;
      this.velocity.set(0, 0, 0);
      d.onLand?.(landing);
    }
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
    const dir = new THREE.Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
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
    if (input && (input.actionDown('primary') || input.actionDown('secondary'))) return true;
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
      lookYaw: this.camYaw,
      velocity: this.velocity,
      speed: this.speedXZ,
      moveSpeed: this.stats.moveSpeed * this.passiveMoveMult(),
      grounded: this.grounded,
      aiming: this.aiming,
      firing: !!this.game.combat?.firing,
      weaponUp: this.dead ? false : this._weaponUp(this._lastInput),
      dead: this.dead,
      grapple: !!this.grapple,
      // A dash is its own pose, not a very fast run — see `poseDash`.
      dashing: this.dashTime > 0,
      cloaked: this.buffs.has('cloak'),
      aimPoint: this.aimPoint,
      // Standing on something is standing, whatever the thrusters are doing.
      // Diver's are never off, so without this he would walk around a stage
      // with his legs trailing behind him like a dropped puppet.
      flying: !!this.flight && !this.grounded,
      // Normalised throttle: +1 climbing flat out, 0 holding height, -1 sinking.
      // Read off the velocity rather than the button so it eases with the
      // damping the thrusters already have instead of snapping on the keypress.
      flightClimb: this.flight
        ? clamp(this.velocity.y / (this.flight.riseSpeed || 11), -1, 1)
        : 0,
    });
    this.modelYaw = this.rig.modelYaw;
    this._readMuzzle();
  }

  /**
   * Third-person camera with obstruction pull-in.
   *
   * The old version cast one thin ray from the pivot and trusted it. The pivot
   * is offset a metre over the right shoulder, so that ray ran *beside* every
   * tree trunk in the game rather than into it — measured: standing directly
   * behind a trunk, the boom stayed at its full 7m and put the camera inside
   * the tree, because the ray passed 0.66m clear of a 0.77m-wide box. Foliage
   * was worse: a canopy is five times the width of its trunk and has no
   * collider at all, since you are meant to be able to walk under it.
   *
   * So: probe with a bundle of rays across the camera's own width, test the
   * canopy volumes the arena keeps for exactly this, and keep the camera
   * *on* the boom at all times — smoothing the pivot rather than the camera
   * position, so it can never lerp through the geometry we just avoided.
   */
  updateCamera(dt, world, aiming) {
    const cam = this.game.engine.camera;
    this.aimBlend = damp(this.aimBlend, aiming ? 1 : 0, 12, dt);

    /* Behind the glass the camera stops being a boom and becomes the optic.
     *
     * A third-person boom and a sixteen-degree field of view do not coexist:
     * at that magnification the character's own shoulder is most of the frame.
     * So the arm collapses onto the eye, the shoulder offset goes with it, and
     * the body stops drawing — which is also what makes the scope overlay read
     * as a lens rather than as a sticker over a shot of someone's back. */
    const scope = this.game.combat?.weapon?.scope;
    this.scopeBlend = damp(this.scopeBlend, this.game.combat?.scoped ? 1 : 0, 13, dt);
    const sb = this.scopeBlend;

    let dist = THREE.MathUtils.lerp(CAMERA.distance, CAMERA.aimDistance, this.aimBlend);
    let fov = THREE.MathUtils.lerp(CAMERA.fov, CAMERA.aimFov, this.aimBlend);
    if (sb > 0.001) {
      dist = THREE.MathUtils.lerp(dist, scope?.distance ?? 0.3, sb);
      fov = THREE.MathUtils.lerp(fov, scope?.fov ?? 16, sb);
    }
    this.model.visible = sb < 0.7;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }

    /* Pitch moves the pivot as well as the boom.
     *
     * A boom is a rigid arm: swing it up and the camera goes *down*, and on a
     * character standing on the ground that means straight into the floor. The
     * old code clamped the camera height afterwards, which took it off the boom
     * entirely — the arm was still pointing one way and the camera was lying on
     * the ground pointing another, so looking up simply stopped working.
     * Raising the pivot as the pitch climbs buys the arm the room it needs, and
     * the shortening below covers whatever is left.
     */
    const up = clamp01(this.camPitch / CAMERA.maxPitch);
    const down = clamp01(this.camPitch / CAMERA.minPitch);
    this.camLift = damp(this.camLift, up * CAMERA.pitchLift - down * CAMERA.pitchDrop, 10, dt);

    // Ideal pivot: head height, offset over the player's right shoulder.
    const shoulder = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(CAMERA.shoulder, CAMERA.shoulder * 1.25, this.aimBlend), 0.1, sb,
    );
    _camWant.set(
      this.position.x - Math.cos(this.camYaw) * shoulder,
      this.position.y + CAMERA.height + PLAYER.eyeHeight * 0.35 + this.camLift,
      this.position.z + Math.sin(this.camYaw) * shoulder,
    );

    // Smoothing lives on the pivot, not on the camera. Lerping the camera
    // position toward a validated spot lets it cut the corner through whatever
    // we just moved it out of; lerping the pivot keeps it on the boom.
    const pivot = this._camTarget;
    if (this._snapCamera) pivot.copy(_camWant);
    else pivot.lerp(_camWant, 1 - Math.exp(-CAMERA.smoothing * dt));

    // Forward matches the movement basis (yaw 0 faces +Z), so the camera sits
    // behind the player and the crosshair agrees with where the camera looks.
    _camBack.set(
      -Math.sin(this.camYaw) * Math.cos(this.camPitch),
      -Math.sin(this.camPitch),
      -Math.cos(this.camYaw) * Math.cos(this.camPitch),
    ).normalize();

    // The boom hangs off a pivot a metre to the side of the character, so a
    // clear boom is not the same thing as a clear view. Find the longest boom
    // that both keeps the camera out of geometry and leaves the character
    // visible — the second condition is the one the player actually notices.
    _camChest.set(this.position.x, this.position.y + 1.1, this.position.z);
    // Everything feeding the target distance is a pure function of the world
    // and the pose — never of the current distance. Feeding the previous frame
    // distance back in is what made the camera pump in and out on the spot.
    const groundLimit = this._groundLimit(pivot, _camBack, dist, world);
    const probed = Math.min(groundLimit, this._probeBoom(pivot, _camBack, dist, world));
    const want = this._resolveBoom(pivot, probed, world);

    // Pull in the instant something is in the way; ease back out afterwards, or
    // stepping out from behind a pillar snaps the whole world backwards.
    this.camDistance = want < this.camDistance
      ? want
      : damp(this.camDistance, want, 6, dt);
    // The floor here is deliberately below CAMERA.minDistance: on a steep look
    // up, or with a rise directly behind you, the only legal boom really is a
    // very short one, and clamping back up to the nominal minimum would put the
    // camera underground again — which is the bug this whole path exists for.
    this.camDistance = clamp(this.camDistance, 0.45, dist);
    this._placeBoom(pivot, this.camDistance, world);

    cam.position.copy(_camPos);
    this._snapCamera = false;
    /* The look-at is aimed a little above the pivot, which frames the character
     * nicely on a seven-metre boom and is catastrophic on a thirty-centimetre
     * one: the same 12cm offset is under a degree at full extension and about
     * twenty-three degrees with the camera at the eye, which pointed a scoped
     * shot at the sky. It is an angle, not a distance, so it scales with the
     * arm it is being applied to. */
    const lookLift = 0.12 * clamp01(this.camDistance / CAMERA.distance);
    cam.lookAt(pivot.x, pivot.y + lookLift, pivot.z);
  }

  /**
   * Longest boom that keeps the camera above the terrain under it.
   *
   * This is the whole of the "cannot aim up" bug. The arm swings down as the
   * pitch swings up, so past about forty degrees the far end of it is below the
   * ground — and on a level with hills, "the ground" is not a plane you can
   * solve for in closed form. Marching the arm and stopping where it would go
   * under is exact enough, and costs eight height lookups.
   */
  _groundLimit(pivot, back, maxDist, world) {
    if (back.y > -0.02) return maxDist;      // level or rising: nothing to hit
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * maxDist;
      const x = pivot.x + back.x * d;
      const y = pivot.y + back.y * d;
      const z = pivot.z + back.z * d;
      // Terrain only. Asking for the highest *solid* surface would count the
      // roof of the building the camera is trying to see past, and the boom
      // would hop up onto it — which is the exact bug the old flat-plane lift
      // was written to avoid. Structures shorten the boom via the probe; the
      // ground is what limits how far it can swing.
      const floor = world.terrainHeightAt ? world.terrainHeightAt(x, z) : 0;
      if (y >= floor + CAMERA.groundClearance) continue;
      // Solve the crossing on this segment rather than snapping back to the
      // last clean sample, or the camera visibly steps as you sweep the mouse.
      const prev = ((i - 1) / steps) * maxDist;
      const py = pivot.y + back.y * prev;
      const denom = py - y;
      const t = denom > 1e-5 ? (py - (floor + CAMERA.groundClearance)) / denom : 0;
      return Math.max(0.4, prev + clamp01(t) * (d - prev));
    }
    return maxDist;
  }

  /**
   * Puts `_camPos` on the boom at `distance`, kept above whatever is beneath it.
   *
   * The lift here is a backstop, not the mechanism: `_groundLimit` has already
   * shortened the arm so that it almost never fires. It exists for the one case
   * the march cannot fix — a boom so short that even at the minimum length the
   * camera is inside a rise.
   */
  _placeBoom(pivot, distance, world) {
    _camPos.copy(pivot).addScaledVector(_camBack, distance);
    const floor = world && world.terrainHeightAt
      ? world.terrainHeightAt(_camPos.x, _camPos.z)
      : 0;
    const min = floor + CAMERA.groundClearance * 0.6;
    if (_camPos.y < min) _camPos.y = min;
  }

  /**
   * Longest boom no greater than `distance` that keeps the camera out of
   * geometry and the character in view. Leaves `_camPos` at the answer.
   */
  _resolveBoom(pivot, distance, world) {
    let d = distance;
    for (let i = 0; i < 6; i++) {
      this._placeBoom(pivot, d, world);
      if (!world.isInsideSolid(_camPos.x, _camPos.y, _camPos.z, 0.3)
        && this._sightClear(_camPos, _camChest, world)) break;
      if (d <= CAMERA.minDistance) break;
      d = Math.max(CAMERA.minDistance, d * 0.72);
    }
    return d;
  }

  /**
   * Nearest obstruction along the boom, probed across the camera own width.
   *
   * Five parallel rays — centre plus four at the collision radius — is enough
   * that nothing as narrow as a trunk or a column can thread between them.
   */
  _probeBoom(pivot, back, maxDist, world) {
    const reach = maxDist + CAMERA.collisionPad;
    // A basis across the boom. Near-vertical booms need a different seed axis
    // or the cross product collapses.
    _camRight.set(-back.z, 0, back.x);
    if (_camRight.lengthSq() < 1e-6) _camRight.set(1, 0, 0);
    _camRight.normalize();
    _camUp.crossVectors(_camRight, back).normalize();

    let best = reach;
    const r = CAMERA.collisionRadius;
    const cast = (origin) => {
      const hit = raycastWorld(origin, back, best, world);
      // Terrain is handled by the boom march instead. Shortening for it here as
      // well would double-count the same constraint and make the camera jitter
      // wherever the ground is close.
      if (hit && !hit.ground && hit.distance < best) best = hit.distance;
      const soft = raycastBoxes(origin, back, best, world.cameraBlockers);
      if (soft !== null && soft < best) best = soft;
    };
    for (const [ox, oy] of BOOM_PROBES) {
      cast(_camProbe.copy(pivot).addScaledVector(_camRight, ox * r).addScaledVector(_camUp, oy * r));
    }
    // Also probe from the body itself. The pivot sits a metre to the side, so a
    // boom that is clear from the pivot can still have a trunk squarely between
    // the camera and the character — which is the case you actually notice.
    for (const ox of [0, 1, -1]) {
      cast(_camProbe.copy(_camChest).addScaledVector(_camRight, ox * r));
    }
    return clamp(best - CAMERA.collisionPad, CAMERA.minDistance, maxDist);
  }

  /** Is there anything between the camera and the character's chest? */
  _sightClear(from, chest, world) {
    _camSight.copy(chest).sub(from);
    const len = _camSight.length();
    if (len < 0.5) return true;
    _camSight.divideScalar(len);
    const reach = len - 0.4;
    const hit = raycastWorld(from, _camSight, reach, world);
    // The ground plane and the arena wall are never between you and yourself.
    if (hit && !hit.ground && !hit.wall) return false;
    return raycastBoxes(from, _camSight, reach, world.cameraBlockers) === null;
  }
}
