import * as THREE from 'three';
import { weaponById } from '../data/weapons.js';
import { characterById } from '../data/characters.js';
import { buildWeaponModel, buildHatModel } from '../entities/models.js';
import { rigAttack } from '../entities/characterRig.js';
import { raycastWorld, distanceToBody } from '../systems/physics.js';
import { clamp01, damp, TAU } from '../core/mathx.js';
import { ULTIMATE } from '../core/config.js';
import { audio } from '../core/audio.js';

/**
 * Where a teleport puts you, and whether you are still airborne when it lands.
 *
 * The Wraith's blink holds the altitude it left from — crossing a gap must not
 * plant you on the floor — and rises only if the ground under the exit is
 * higher than you already are. Mutates `end.y` and returns whether the player
 * should stay off the ground.
 */
function settleTeleport(player, arena, start, end) {
  const ground = arena.groundHeightAt(end.x, end.z, Math.max(start.y, end.y) + 2.5);
  end.y = Math.max(start.y, ground);
  return !player.grounded || end.y > ground + 0.05;
}

/**
 * What a repeat Kill Order round is worth, compounding.
 *
 * The first round into a body is worth full, the second 72% of that, the third
 * 52%, and so on. Twelve rounds into a lone boss come to about three and a half
 * rounds' worth rather than twelve — a little under what Vanguard's Fire
 * Mission does to the same body — while twelve rounds across a field are still
 * worth twelve. That gap is the whole point: this is an ultimate that clears a
 * field, not one that deletes whatever is biggest.
 */
const KILL_ORDER_REPEAT = 0.72;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _ray = new THREE.Vector3();   // hitscan direction — must survive item procs
const _hatUp = new THREE.Vector3(0, 1, 0);  // the axis a rebounding hat swings around

/* Abilities are addressed by action, not by key: the settings screen can move
   any of them onto any key or mouse button, and nothing downstream cares. */
export const SECONDARY_ACTION = 'secondary';
export const UTILITY_ACTION = 'utility';
export const SPECIAL_ACTION = 'special';
export const ULTIMATE_ACTION = 'ultimate';

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
    // The secondary is a character ability now rather than a second trigger on
    // a gun, so it gets the same charge pool the other two have had all along.
    this.secondaryCharges = 1;
    this.specialTimer = 0;
    this.specialCharges = 1;
    // A held ability — Bulwark behind his plate — while the button is down.
    this.sustaining = false;
    // Fire patches burning on the ground, oldest first. Diver's, and the only
    // thing in the game that is both a hazard and a target.
    this.firePatches = [];
    /* Where a multi-hit primary is up to, and when it forgets.
       A three-hit lance combo is a property of the trigger being pulled in
       rhythm, not of the weapon, so it lives here and resets itself. */
    this._comboIndex = 0;
    this._comboTimer = 0;
    // Dashes that have already been paid for. Spent before charges are, so an
    // ultimate that hands you three of them is three dashes rather than three
    // seconds shaved off one cooldown.
    this.dashResets = 0;
    // The active-reload minigame, while one is running. Weapons opt in through
    // `primary.activeReload`; everything else leaves this null forever.
    this.reload = null;
    // Rounds left in the magazine, for a weapon that has one. `null` is a
    // weapon that does not — most of the arsenal — and nothing downstream has
    // to special-case it beyond that one check.
    this.ammo = null;
    this._secondaryRefund = false;
    // Chain's hat, in its two possible places: in the air ricocheting, and on
    // the ground waiting to be teleported to. Never both at once.
    this.hat = null;
    this.hatMarker = null;
    this.bastionTimer = 0;
    this.lastStandTimer = 0;
    // The ultimate meter, 0..ULTIMATE.max. Never a cooldown — see config.
    this.ultimateCharge = ULTIMATE.startCharge;
    this._ultimateAnnounced = false;
    this._pendingSlam = null;
    this._killOrder = null;
    this.infernoTimer = 0;
    // What the last parry was told to do with the blow it catches.
    this._parrySpec = null;
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
    this.specialCharges = this.character.special.charges ?? 1;
    this.secondaryCharges = 1;
    this.sustaining = false;
    this.dashResets = 0;
    this._clearFirePatches();
    this._clearHat();
    this._clearHatMarker();
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
    // The meter is the ultimate's cooldown, so a passive about cooldowns has
    // to reach it too — see Vanguard's. Applied here because this is the one
    // funnel every source of charge already goes through.
    amount *= this.character?.passive?.ultimateMult?.(this.game.player) ?? 1;
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

  /**
   * Dealing damage is the main half of it.
   *
   * Measured as a fraction of the *target*, not as raw damage, and that is the
   * whole design: a run that has quadrupled its damage kills the same husk four
   * times faster and is paid the same for it, so the meter tracks how much
   * fighting you have done rather than how big your numbers have got. The cap
   * is what stops one enormous slam into something small being worth a whole
   * bar — you are paid for the body, not for the overkill.
   */
  noteDamageDealt(enemy, dealt) {
    if (!(dealt > 0)) return;
    const max = enemy?.maxHealth || 1;
    const gain = (dealt / max) * 100 * ULTIMATE.perEnemyHealthPercent;
    this.addUltimateCharge(Math.min(ULTIMATE.maxPerHit, gain));
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

  /**
   * Banks dashes that cost nothing.
   *
   * A reset is not a refund and not a cooldown reduction: it is a dash you
   * already own, spent ahead of the charge, so three of them survive a full
   * cooldown and can be taken back to back.
   */
  grantDashResets(count) {
    this.dashResets += count;
    this.refundUtility();
  }

  /** Max special charges. Ability-defined; nothing grants extras yet. */
  get maxSpecialCharges() { return this.character?.special.charges ?? 1; }

  /** Max secondary charges. Most abilities want one; Fire Patch wants three. */
  get maxSecondaryCharges() { return this.weapon?.secondary?.charges ?? 1; }

  /**
   * Spends one use of the utility and starts its cooldown.
   *
   * Pulled out of the input handler because one ability does not pay when it is
   * pressed. Chain's mark is two presses — a throw and a recall — and the thing
   * you are buying is the recall: charging the throw would start the timer
   * while the hat is still in the air, so a hat left in a field for twenty
   * seconds would come back with the cooldown already served. Paying on arrival
   * makes the five seconds mean what the ability says it means.
   */
  spendUtility() {
    if (this.dashResets > 0) { this.dashResets--; return; }
    const cd = (this.character?.utility.cooldown ?? 3)
      * this.game.player.stats.cooldownMult * this.game.player.stats.dashCooldownMult;
    this.utilityCharges = Math.max(0, this.utilityCharges - 1);
    if (this.utilityTimer <= 0) this.utilityTimer = cd;
  }

  /**
   * What one use of the special costs in seconds.
   *
   * An ability may override it outright — Halcyon's rack drops to a flat
   * arming delay while the override is up — so the base, cooldown items and
   * all, is handed in rather than recomputed by the ability.
   */
  specialCooldown(player) {
    const sp = this.character?.special;
    if (!sp) return 0.01;
    const base = sp.cooldown * player.stats.cooldownMult;
    return Math.max(0.01, sp.cooldownFor ? sp.cooldownFor(player, base) : base);
  }

  /**
   * True while the player is actually behind a scoped weapon's glass.
   *
   * One question, asked by the camera, the HUD overlay and every enemy
   * deciding whether to show its seam — so they can never disagree.
   */
  get scoped() {
    return !!(this.weapon?.scope && this.game.player?.aiming
      && !this.game.player.dead && !this.game.paused);
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
      this.weaponModel = null;
    }
    this.weapon = weaponById(weaponId);
    /* An authored body is holding its weapon already — it was sculpted that
       way, skinned to this same mount, and lit in this weapon's colour. Building
       the procedural model would hang a second gun off the same fist. Its
       muzzle, published by the rig, is the one shots come out of. */
    if (!player.model.userData.bodyWeapon) {
      this.weaponModel = buildWeaponModel(this.weapon);
      mount.add(this.weaponModel);
      player.model.userData.muzzle = this.weaponModel.userData.muzzle;
    }
    this.primaryTimer = 0;
    this.secondaryTimer = 0;
    // A multi-charge Q arrives full, for the same reason a magazine does: a
    // character who starts a run with one of their three patches has been
    // charged for a cooldown they never spent.
    this.secondaryCharges = this.weapon.secondary?.charges ?? 1;
    this._comboIndex = 0;
    this._comboTimer = 0;
    this.heat = 0;
    this.reload = null;
    // Anything picked up comes with a full magazine. Carrying a half-empty one
    // across a swap would punish trying a weapon out.
    this.ammo = this.weapon.primary.magazine?.size ?? null;
    // A precision weapon rewrites what crit chance is worth, so the stat block
    // has to be rebuilt the moment the weapon in the hands changes.
    player.markStatsDirty();
  }

  // ------------------------------------------------------------------ per-frame
  update(dt, input, player) {
    const stats = player.stats;
    this.primaryTimer = Math.max(0, this.primaryTimer - dt);
    this.secondaryTimer = Math.max(0, this.secondaryTimer - dt);
    this.firing = false;

    if (player.dead || !this.weapon) {
      // Dying mid-reload must not leave the bar on screen for the next run,
      // and a hat in flight has nobody to come back to.
      this.reload = null;
      if (this.weapon) this.ammo = this.weapon.primary.magazine?.size ?? null;
      this._clearHat();
      this._clearHatMarker();
      this._clearFirePatches();
      this.sustaining = false;
      return;
    }

    const primary = this.weapon.primary;
    const secondary = this.weapon.secondary;
    const canAct = !this.game.paused;

    // Combos forget themselves if you stop swinging.
    if (this._comboTimer > 0 && (this._comboTimer -= dt) <= 0) this._comboIndex = 0;

    /* ---- Secondary: Q — held, charged, charge-based or instant ----
     *
     * Four shapes now, because the second button is a character ability rather
     * than a gun's alternate fire. A *sustained* ability is the odd one: it has
     * no cooldown and no cast, it is simply true for as long as the button is
     * down, and the ability is told when that changes rather than when it
     * fires. Bulwark's guard is the only one, and it is the only one that
     * should be: an ability you hold is an ability you are not doing anything
     * else during, which is a real cost and a hard one to price twice.
     */
    const secondaryHeld = input.actionDown(SECONDARY_ACTION);
    if (secondary.sustain) {
      const want = canAct && secondaryHeld;
      if (want !== this.sustaining) {
        this.sustaining = want;
        secondary.onSustain?.(this.ctx, want);
      }
      if (want) secondary.whileHeld?.(this.ctx, dt);
    } else if (secondary.charge) {
      if (secondaryHeld && this.secondaryTimer <= 0 && canAct) {
        this.charging = true;
        this.chargeTime = Math.min(secondary.charge, this.chargeTime + dt);
      } else if (this.charging) {
        const t = this.chargeTime / secondary.charge;
        this.charging = false;
        if (this.chargeTime >= (secondary.minCharge ?? 0.15)) this._fireAbility(secondary, t);
        this.chargeTime = 0;
      }
    } else {
      /* Charge regeneration, as the utility and the special do it — but
         without a second `-= dt`. The secondary timer is already stepped once
         at the top of this function, which the other two slots are not, and
         subtracting again here regenerated three-second charges in a second
         and a half. */
      const maxSecondary = this.maxSecondaryCharges;
      const qcd = secondary.cooldown * stats.cooldownMult;
      if (maxSecondary > 1) {
        if (this.secondaryCharges < maxSecondary && this.secondaryTimer <= 0) {
          this.secondaryCharges++;
          this.secondaryTimer = this.secondaryCharges < maxSecondary ? qcd : 0;
        }
      }
      const ready = maxSecondary > 1 ? this.secondaryCharges > 0 : this.secondaryTimer <= 0;
      if (input.actionPressed(SECONDARY_ACTION) && ready && canAct) {
        if (maxSecondary > 1) {
          this.secondaryCharges--;
          if (this.secondaryTimer <= 0) this.secondaryTimer = qcd;
        }
        this._fireAbility(secondary, 1);
      }
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
      const canDash = this.utilityCharges > 0 || this.dashResets > 0;
      if (canAct && canDash && input.actionPressed(UTILITY_ACTION)) {
        /* Most abilities are paid for on the press. One is not: an ability
           that declares `deferCooldown` bills itself, from inside `fire`, at
           whichever of its steps is the one worth charging for. */
        if (!util.deferCooldown) {
          // A banked reset is spent before the charge is, so three of them are
          // three genuinely free dashes rather than a shorter cooldown.
          if (this.dashResets > 0) this.dashResets--;
          else {
            this.utilityCharges--;
            if (this.utilityTimer <= 0) this.utilityTimer = cd;
          }
        }
        this._fireAbility(util, 1, false, 'utility');
      }
    }

    // ---- Special (R): charge-based, like the utility ----
    const special = this.character?.special;
    if (special) {
      const maxSpecial = this.maxSpecialCharges;
      const scd = this.specialCooldown(player);
      if (this.specialCharges < maxSpecial) {
        this.specialTimer -= dt;
        if (this.specialTimer <= 0) {
          this.specialCharges = Math.min(maxSpecial, this.specialCharges + 1);
          this.specialTimer = scd;
        }
      } else {
        this.specialTimer = Math.max(0, this.specialTimer - dt);
      }
      if (canAct && this.specialCharges > 0 && input.actionPressed(SPECIAL_ACTION)) {
        this.specialCharges--;
        if (this.specialTimer <= 0) this.specialTimer = scd;
        this._fireAbility(special, 1, false, 'special');
      }
    }

    // ---- Ultimate (F): paid for in kills and in blood ----
    const ult = this.character?.ultimate;
    if (ult) {
      this.addUltimateCharge(ULTIMATE.perSecond * dt);
      if (canAct && this.ultimateReady && input.actionPressed(ULTIMATE_ACTION)) {
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
    this._tickKillOrder(dt, player);
    this._tickHat(dt, player);
    this._tickFirePatches(dt, player);
    this._tickInferno(dt, player);

    // ---- Primary ----
    // A weapon mid-reload owns the fire button: the click that lands on the
    // mark is the reload, not the next shot, so the whole branch is skipped
    // for the frame the minigame consumed.
    const reloading = this._tickReload(dt, input, player, canAct);
    const wantPrimary = primary.hold ? input.actionDown('primary') : input.actionPressed('primary');
    // Both hands on the shield is both hands off everything else.
    const blocked = this.sustaining && secondary.blocksPrimary;
    if (wantPrimary && !reloading && !blocked && this.primaryTimer <= 0 && canAct && !this.charging) {
      const interval = primary.cooldown / Math.max(0.05, stats.attackSpeed);
      this.primaryTimer = interval;
      this.firing = true;
      this._fireAbility(primary, 1, true);
    }
    const primaryHeld = input.actionDown('primary');
    if (!primaryHeld && primary.beam) {
      this.heat = damp(this.heat, 0, 2.4, dt);
      primary.onRelease?.(this.ctx);
    }
    // A beam with an empty cell is not a beam: holding the button through a
    // reload must not keep the body in its firing pose.
    this.beamActive = !!(primary.beam && primaryHeld && !reloading);

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

    // One report per ability, before it fires: a weapon whose ability kills the
    // frame it goes off should still have been heard going off.
    if (!ability.silent) {
      audio.shoot(this.weapon?.model || 'pistol', _origin,
        kind === 'secondary' ? 0.72 : kind === 'primary' ? 1 : 0.85);
    }
    /* The body acts the ability out: a swing swings, a punch punches. The rig
       owns what that looks like; all that is decided here is which one to play
       — and an ability whose animation changes from swing to swing, like a
       combo that ends on a thrust or a pair of fists that alternate, answers
       `animFor` instead of naming one. */
    const anim = ability.animFor ? ability.animFor(this.ctx) : ability.anim;
    if (anim) rigAttack(player.rig, anim, chargeRatio);

    this._secondaryRefund = false;
    try {
      ability.fire(this.ctx, chargeRatio);
    } catch (err) {
      console.error(`Weapon "${this.weapon.id}" ability failed`, err);
    }

    if (kind === 'secondary') {
      /* An ability may buy its own cooldown back out of what it just did — the
         revolver holsters free when the shot finishes something.
         A multi-charge secondary has already been billed above, and setting the
         timer here would restart its regeneration from scratch on every use. */
      if ((ability.charges ?? 1) <= 1) {
        this.secondaryTimer = this._secondaryRefund ? 0 : ability.cooldown * player.stats.cooldownMult;
      } else if (this._secondaryRefund) {
        this.secondaryCharges = Math.min(this.maxSecondaryCharges, this.secondaryCharges + 1);
      }
      this._secondaryRefund = false;
      this.game.inventory.trigger('onSecondary', { ability });
    }
    if (kind === 'primary' && ability.activeReload) this._beginReload(ability.activeReload);
    if (kind === 'primary' && ability.magazine && this.ammo !== null) {
      this.ammo--;
      if (this.ammo <= 0) this._beginMagazineReload(ability.magazine);
    }
  }

  /* ------------------------------------------------------------------ active reload */
  /**
   * Opens the reload window.
   *
   * The mark moves every shot on purpose. A fixed window is a rhythm you learn
   * once and then stop reading; a window that moves is a thing you have to
   * actually watch, which is the entire point of taking the fire button away
   * from you for a second and a quarter.
   */
  _beginReload(spec) {
    const time = spec.time ?? 1.25;
    const width = spec.window ?? 0.14;
    // Never flush against either end: a mark you cannot miss and a mark you
    // cannot hit are the same non-decision.
    const start = 0.3 + this.game.rng.next() * (0.94 - width - 0.3);
    this.reload = {
      time, t: 0, zoneStart: start, zoneEnd: start + width,
      cooldown: spec.cooldown ?? 3.0, result: null, hold: 0,
    };
    // Nothing fires until the bar resolves; the timer is what the HUD reads if
    // the window is missed, so park it out of the way until then.
    this.primaryTimer = time + 0.5;
  }

  /**
   * Works a spent magazine.
   *
   * Not the minigame above: there is no mark to hit and nothing to get wrong,
   * just a fixed hole in your damage that the weapon's whole rhythm is priced
   * around. A beam that never has to stop is a beam you hold down forever, and
   * the ramp is worth what it is worth precisely because it is interrupted.
   *
   * The two seconds are flat on purpose. Attack speed buys rounds per second,
   * not hands per second, and letting it shorten the reload would hand the
   * weapon its uptime back exactly where the magazine was meant to take it.
   */
  _beginMagazineReload(spec) {
    const time = spec.time ?? 2.0;
    this.reload = {
      timed: true, size: spec.size ?? 30,
      time, t: 0, zoneStart: 0, zoneEnd: 1, cooldown: 0, result: null, hold: 0,
    };
    // A beam that stops firing should stop being hot as well — the ramp is
    // time on target, and the reload is time very much not on it.
    this.heat = 0;
    this.primaryTimer = time;
    audio.uiClick('back');
  }

  /**
   * Runs the reload bar. Returns true while it owns the fire button.
   *
   * The bar outlives its own result by a fraction of a second so the player
   * sees *why* the bolt jammed rather than watching the panel vanish on the
   * frame they got it wrong.
   */
  _tickReload(dt, input, player, canAct) {
    const r = this.reload;
    if (!r) return false;
    if (r.timed) {
      // A pause is not part of the reload; neither is being dead.
      if (!canAct) return true;
      r.t += dt;
      if (r.t >= r.time) {
        this.ammo = r.size;
        this.reload = null;
        this.primaryTimer = 0;
        this.game.fxApi.ring(player.position, 0.4, 2.2, 0x46e0c0, 0.28, 0.6);
        audio.uiClick('confirm');
      }
      return true;
    }
    if (r.result) {
      r.hold -= dt;
      if (r.hold <= 0) this.reload = null;
      return true;
    }
    // A pause is not a miss: the marker stops with everything else.
    if (!canAct) return true;
    r.t += dt;
    const frac = r.t / r.time;
    if (input.actionPressed('primary')) {
      this._resolveReload(frac >= r.zoneStart && frac <= r.zoneEnd, player);
    } else if (frac >= 1) {
      // Running the marker off the right-hand end is a miss like any other.
      this._resolveReload(false, player);
    }
    return true;
  }

  _resolveReload(good, player) {
    const r = this.reload;
    r.result = good ? 'good' : 'bad';
    r.t = Math.min(r.t, r.time);
    r.hold = good ? 0.22 : 0.5;
    if (good) {
      this.primaryTimer = 0;
      this.game.fxApi.ring(player.position, 0.4, 2.4, 0x46e0c0, 0.3, 0.7);
      audio.uiClick('confirm');
    } else {
      this.primaryTimer = r.cooldown * player.stats.cooldownMult;
      audio.denied();
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
   * Kill Order: one round per tick, into whatever most deserves it.
   *
   * "Most deserves it" is the biggest health pool in range, which is what a
   * sniper's list would actually say — a shot spent on a wisp is a shot not
   * spent on the thing about to reach you. Every round is forced critical
   * rather than rolled, because that is the character's whole trade: the
   * longrifle never rolls, so an ultimate that did would be somebody else's.
   */
  _tickKillOrder(dt, player) {
    const order = this._killOrder;
    if (!order) return;
    if (player.dead) { this._killOrder = null; return; }
    order.timer -= dt;
    if (order.timer > 0) return;
    order.timer = order.interval;

    /* One round, one body — including here.
     *
     * The order used to pick the highest-health target every time, which in a
     * boss fight is the boss on all fourteen rounds: an ultimate whose own
     * description is "work down the field" was in practice a single-target
     * execution with a guaranteed critical on every shot. It deleted bosses,
     * and it did it harder the more crit damage the build had bought, because
     * `critChanceToDamage` turns this character's crit-chance items into
     * multiplier.
     *
     * So the order now works down the field for real: it takes the biggest
     * thing it has *not* already shot, and only doubles back once everything in
     * range has been served. A second round into the same body is worth a
     * fraction of the first, which is what a marksman working a field would do
     * anyway, and what stops fourteen rounds stacking into one health bar.
     */
    const targets = this.game.enemies.nearest(player.position, order.radius, 24);
    let best = null;
    let fresh = null;
    for (const e of targets) {
      if (!best || e.health > best.health) best = e;
      if (!order.hits.has(e) && (!fresh || e.health > fresh.health)) fresh = e;
    }
    const target = fresh ?? best;
    if (target) {
      // Every round after the first into the same body is a repeat, and each
      // one is worth less than the last rather than a flat discount — a boss
      // that soaks the whole order should see the returns visibly close up.
      const repeats = order.hits.get?.(target) ?? (order.hits.has(target) ? 1 : 0);
      const scale = repeats === 0 ? 1 : KILL_ORDER_REPEAT ** repeats;
      order.hits.set(target, repeats + 1);

      const from = player.muzzlePosition.clone();
      const to = target.center.clone();
      const dir = to.clone().sub(from).normalize();
      this.game.fxApi.beam(from, to, order.color, 0.16, 0.06);
      this.game.fxApi.muzzle(from, dir, order.color, 1.6);
      this.damageEnemy(target, order.damage * scale, {
        proc: 1, source: 'Kill Order', hitPoint: to, crit: true,
        knockback: 10, knockbackDir: dir,
      });
      this.game.fxApi.explosion(to, 1.8, order.color, 0.7);
      player.addRecoil(2.2);
    }
    order.left--;
    if (order.left <= 0) this._killOrder = null;
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

  /* ------------------------------------------------------------------ the hat */
  /**
   * Chain's hat, in flight.
   *
   * Resolved here rather than as a projectile because a projectile flies at
   * whatever it was pointed at and this one chooses: on every body it crosses
   * it picks the next one and turns, and the turn is the ability. Bounces are
   * multiplicative — five percent each — so what makes a throw good is not
   * where you aimed it but how many bodies were standing close enough together
   * to be strung onto it.
   *
   * It ignores terrain on purpose. A boomerang that catches on a kerb halfway
   * through a chain is a boomerang nobody throws twice.
   */
  _tickHat(dt, player) {
    /* One hat, and it is either on his head or it is somewhere else.
     *
     * Derived rather than toggled: both abilities can have a hat out at the
     * same time, so a call site that hid it on throw and showed it on catch
     * would put it back on his head while the other one was still lying in a
     * field. Asking the question every frame cannot get out of step. */
    const worn = player.model.userData.hat;
    if (worn) worn.visible = !this.hat && !this.hatMarker;

    // The marker is not thrown at anything and does not move; it just runs out.
    if (this.hatMarker) {
      this.hatMarker.time -= dt;
      this.hatMarker.mesh.rotation.y += dt * 0.7;
      if (this.hatMarker.time <= 0) {
        this.game.fxApi.glow(this.hatMarker.position, {
          color: this.hatMarker.color, size: 1, life: 0.3, grow: 1.6,
        });
        this._clearHatMarker();
      }
    }

    const h = this.hat;
    if (!h) return;

    if (h.endless > 0) {
      h.endless -= dt;
      if (h.endless <= 0) h.state = 'return';
    }
    h.age += dt;
    // Nothing may orbit forever: a hat that somehow never finds its way home
    // is still gone within a few seconds of giving up.
    if (h.age > h.maxAge) { this._clearHat(); return; }

    const step = h.speed * dt;
    h.position.addScaledVector(h.velocity, dt);
    h.travelled += step;
    h.mesh.position.copy(h.position);
    h.mesh.rotation.y += dt * 15;
    h.mesh.rotation.z = Math.sin(h.age * 9) * 0.5;

    if (h.state === 'out') {
      /* Swinging clear of the body it just came off.
       *
       * The second cut on the same enemy has to be a rebound, not a second
       * frame of contact: without this the hat is still inside the hit radius
       * on the frame after it strikes, and "twice" resolves as one double-tap
       * nobody can read. So it carries on past, turns, and comes back — and it
       * cuts nothing on the way out. */
      if (h.rearm > 0) {
        h.rearm -= dt;
        if (h.rearm <= 0) {
          const back = h.reboundTo;
          h.reboundTo = null;
          if (back && !back.dead) {
            this.game.fxApi.lightning(h.position, back.center, h.color, 0.12, 4);
            h.velocity.copy(back.center).sub(h.position).normalize().multiplyScalar(h.speed);
          } else if (!this._aimHatAtNextTarget(h)) {
            h.state = 'return';
          }
        }
        return;
      }

      const struck = this.game.enemies
        .inRadius(h.position, h.radius)
        .find((e) => (h.hits.get(e) ?? 0) < h.maxHits);
      if (struck) {
        h.hits.set(struck, (h.hits.get(struck) ?? 0) + 1);
        this.damageEnemy(struck, h.damage, {
          proc: 0.7, source: h.source, hitPoint: struck.center.clone(),
          knockback: 4, knockbackDir: _v.copy(h.velocity).normalize().setY(0.3).clone(),
        });
        h.bounces++;
        h.damage *= 1 + h.growth;
        // Chain Reaction: every body the hat crosses is time off everything.
        this.character?.passive?.onHatHit?.(this, struck, h);
        this.game.fxApi.ring(struck.center, 0.3, h.radius * 1.6, h.color, 0.28, 0.85);
        if (!this._aimHatAtNextTarget(h, struck)) h.state = 'return';
      } else if (h.travelled >= h.range) {
        h.state = 'return';
      }
      return;
    }

    // Coming home. It does no damage on the way back — the trip is the cost of
    // having missed, not a second chance at the same throw.
    _v.copy(player.chestPosition).sub(h.position);
    const dist = _v.length();
    if (dist < 1.6) {
      this.game.fxApi.glow(player.chestPosition, { color: h.color, size: 1.1, life: 0.22, grow: 1.6 });
      this._clearHat();
      return;
    }
    h.velocity.copy(_v).divideScalar(dist).multiplyScalar(h.speed);
  }

  /* ------------------------------------------------------------------ fire */
  /**
   * The fire patches burning on the floor, and why they are objects rather
   * than hazards.
   *
   * `spawnHazard` already exists and already burns things that stand in it, so
   * the obvious implementation is one line. It is the wrong one: Diver's whole
   * kit is a conversation between two abilities — the patch says where, the
   * slam says now — and for the slam to detonate a patch it lands on, the patch
   * has to be a thing with a position and a life that something else can find,
   * take and consume. A hazard is fire on the ground; this is ammunition that
   * happens to be on fire while it waits.
   */
  /**
   * Puts a patch on the floor at `position` and keeps it there.
   *
   * Three at a time, oldest evicted — a cap rather than a cooldown, because
   * the ability already has one and a floor covered in every patch you have
   * ever thrown is not a decision about where to throw the next.
   */
  placeFirePatch(position, spec = {}) {
    const radius = spec.radius ?? 4.2;
    const color = spec.color ?? 0xff7a2a;
    const p = position.clone();
    p.y = this.game.arena.groundHeightAt(p.x, p.z, p.y + 2) + 0.06;

    const geo = new THREE.CircleGeometry(radius, 24);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.26, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    mesh.position.copy(p);
    this.game.engine.scene.add(mesh);

    this.firePatches.push({
      mesh, position: p, radius, color,
      time: spec.duration ?? 6,
      // Per half-second tick, so the number in the description is per second.
      damage: (spec.dps ?? 0) * 0.5,
      burn: spec.burn ?? 0,
      tick: 0,
    });
    while (this.firePatches.length > (spec.max ?? 3)) this._removeFirePatch(0);
    this.game.fxApi.ring(p, 0.4, radius, color, 0.45, 0.9);
    this.game.fxApi.explosion(p, radius * 0.5, color, 0.5);
  }

  _tickFirePatches(dt, player) {
    if (!this.firePatches.length) return;
    for (let i = this.firePatches.length - 1; i >= 0; i--) {
      const f = this.firePatches[i];
      f.time -= dt;
      f.tick -= dt;
      f.mesh.rotation.y += dt * 0.6;
      // Fading out over the last second, so a patch about to die says so.
      const fade = clamp01(f.time / 1.0);
      f.mesh.material.opacity = (0.24 + Math.sin(f.time * 7) * 0.05) * fade;
      if (this.game.frame % 4 === 0) {
        const a = this.game.rng.next() * TAU;
        const r = Math.sqrt(this.game.rng.next()) * f.radius;
        this.game.fx.spawnParticle(
          _v.set(f.position.x + Math.cos(a) * r, f.position.y + 0.1, f.position.z + Math.sin(a) * r),
          _v2.set(0, 2.4 + this.game.rng.next() * 2, 0),
          { color: f.color, size: 0.16, life: 0.45, gravity: 2, drag: 0.94 },
        );
      }
      if (f.tick <= 0) {
        f.tick = 0.5;
        for (const e of this.game.enemies.inRadius(f.position, f.radius)) {
          this.damageEnemy(e, f.damage, { proc: 0.25, source: 'Fire Patch' });
          e.applyStatus('burn', 3, { dps: f.burn });
        }
      }
      if (f.time <= 0) this._removeFirePatch(i);
    }
    void player;
  }

  /**
   * Sets everything within `radius` of a point alight, consuming any patch it
   * catches. Returns how many patches went up, which is what the slam reports.
   */
  /**
   * Sets off every fire patch under a slam. At most three exist at any moment —
   * `placeFirePatch` retires the oldest past that — so this is already bounded
   * and the slam's per-patch figure is priced against three, not against a
   * carpet.
   */
  detonateFirePatches(position, radius, damage, color) {
    let count = 0;
    for (let i = this.firePatches.length - 1; i >= 0; i--) {
      const f = this.firePatches[i];
      if (f.position.distanceTo(position) > radius + f.radius) continue;
      count++;
      const blastR = f.radius * 1.9;
      this.areaDamage(f.position, blastR, damage, {
        proc: 0.7, source: 'Firebomb', force: 16,
        burn: { time: 4, dps: f.burn * 1.6 },
      });
      this.game.fxApi.explosion(f.position, blastR, color ?? f.color, 1.3);
      this.game.fxApi.ring(f.position, 0.6, blastR, color ?? f.color, 0.45, 1);
      this._removeFirePatch(i);
    }
    if (count) this.game.engine.addShake(0.12 * count);
    return count;
  }

  _removeFirePatch(i) {
    const f = this.firePatches[i];
    f.mesh.parent?.remove(f.mesh);
    f.mesh.geometry.dispose();
    f.mesh.material.dispose();
    this.firePatches.splice(i, 1);
  }

  _clearFirePatches() {
    while (this.firePatches.length) this._removeFirePatch(this.firePatches.length - 1);
  }

  /**
   * Everything this system has put into the scene that is not the player.
   *
   * The hat in flight, the hat lying in a field, and the fire on the ground.
   * All three are *positions in an arena*, so they belong to the stage rather
   * than to the run — the game calls this when it tears a stage down and when
   * it tears a run down, and both matter: a run builds a fresh `Combat`, so
   * anything the old one left behind has nobody to remove it.
   */
  clearWorldObjects() {
    this._clearHat();
    this._clearHatMarker();
    this._clearFirePatches();
  }

  /**
   * Inferno: ten seconds during which standing near Diver is a mistake.
   *
   * A ring rather than a one-off blast, pulsed off the buff the same way
   * Bastion and Last Stand are, so the ability owns no timer of its own and
   * cannot outlive the thing that says it is running.
   */
  _tickInferno(dt, player) {
    const buff = player.buffs.get('inferno');
    if (!buff) { this.infernoTimer = 0; return; }
    const extra = buff.extra || {};
    this.infernoTimer = (this.infernoTimer ?? 0) - dt;
    if (this.infernoTimer > 0) return;
    this.infernoTimer = extra.interval ?? 0.5;
    const radius = extra.radius ?? 22;
    const color = extra.color ?? 0xff7a2a;
    for (const e of this.game.enemies.inRadius(player.position, radius)) {
      this.damageEnemy(e, extra.damage ?? 0, { proc: 0.3, source: 'Inferno' });
      e.applyStatus('burn', 3.5, { dps: extra.burn ?? 0 });
    }
    this.game.fxApi.ring(player.position, radius * 0.25, radius, color, 0.5, 0.7);
    this.game.fxApi.glow(player.chestPosition, { color, size: 2.2, life: 0.25, grow: 2.6 });
  }

  /**
   * A blow that was caught rather than taken.
   *
   * The player has already refused the damage by this point; all that is left
   * is to decide what "reflected" means. It means the attacker wears it: the
   * enemy that threw it if the call site named one, otherwise whatever is
   * nearest and in front, because a parry is a thing you do facing somebody.
   */
  onParried(amount, opts = {}) {
    const player = this.game.player;
    const spec = this._parrySpec || {};
    const color = spec.color ?? 0x3dffa5;
    player.invulnerable = Math.max(player.invulnerable, spec.iframes ?? 0.35);
    this.game.fxApi.ring(player.position, 0.5, 4.2, color, 0.4, 1);
    this.game.fxApi.glow(player.chestPosition, { color, size: 2, life: 0.3, grow: 2.4 });
    this.game.engine.addShake(0.25);
    this.game.ui.toast('PARRY', '#3dffa5');
    audio.uiClick('confirm');

    const back = amount * (spec.reflect ?? 3.0);
    let target = opts.enemy && !opts.enemy.dead ? opts.enemy : null;
    if (!target) {
      const dir = player.aimDirection(_dir);
      const pool = this.game.enemies.inRadius(player.position, spec.range ?? 22);
      let best = -1;
      for (const e of pool) {
        const dot = _v.copy(e.center).sub(player.chestPosition).normalize().dot(dir);
        if (dot > best) { best = dot; target = e; }
      }
    }
    if (target) {
      this.damageEnemy(target, back, { proc: 1, source: 'Parry', crit: true, knockback: 14 });
      this.game.fxApi.lightning(player.chestPosition, target.center, color, 0.16, 5);
    }
    // The dash comes back, which is the whole reason to take the risk.
    this.refundUtility();
  }

  /**
   * Points the hat at the next body worth crossing. False when there is none.
   *
   * An endless hat re-crosses what it has already cut once it runs out of fresh
   * targets, which is the whole of what makes the ultimate an ultimate: the
   * ramp never resets, so a small crowd held together is worth as much as a
   * large one strung out.
   */
  _aimHatAtNextTarget(h, justStruck = null) {
    const spare = (e) => (h.hits.get(e) ?? 0) < h.maxHits;
    let pool = this.game.enemies.inRadius(h.position, h.searchRadius).filter(spare);
    if (!pool.length && h.endless > 0) {
      h.hits.clear();
      pool = this.game.enemies.inRadius(h.position, h.searchRadius);
    }
    if (!pool.length) return false;
    pool.sort((a, b) => a.position.distanceToSquared(h.position) - b.position.distanceToSquared(h.position));

    /* A fresh body first, every time. Coming back around onto the one it just
       cut is the fallback, not the preference — otherwise a hat thrown into a
       crowd would spend both its cuts on whoever happened to be nearest and
       never reach the second man. */
    const next = pool.find((e) => e !== justStruck) ?? pool[0];
    if (next === justStruck) {
      // Carry on past, deflected, and come back for the second cut.
      h.reboundTo = next;
      h.rearm = 0.26;
      h.velocity.applyAxisAngle(_hatUp, 0.9);
      return true;
    }
    this.game.fxApi.lightning(h.position, next.center, h.color, 0.12, 4);
    h.velocity.copy(next.center).sub(h.position).normalize().multiplyScalar(h.speed);
    return true;
  }

  _clearHat() {
    if (!this.hat) return;
    this.hat.mesh.parent?.remove(this.hat.mesh);
    disposeTree(this.hat.mesh);
    this.hat = null;
  }

  _clearHatMarker() {
    if (!this.hatMarker) return;
    this.hatMarker.mesh.parent?.remove(this.hatMarker.mesh);
    disposeTree(this.hatMarker.mesh);
    this.hatMarker = null;
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

    /* Per-target scaling for abilities that ramp.
     *
     * A weapon whose damage climbs the longer it stays on one target is
     * balanced against a crowd that keeps moving; a boss is one enormous
     * stationary target that lets it sit at the top of its curve for the whole
     * fight. `bossScale` is how such a weapon gives that back — applied here,
     * because this is the one place that knows both the number and the body it
     * is about to land on. */
    if (opts.bossScale !== undefined && enemy.boss) damage *= opts.bossScale;

    damage = this.game.inventory.modifyDamage({ enemy, damage, isCrit, proc });

    /* The character's own passive, and it goes last on purpose.
     *
     * Every one of these reads something about the moment rather than about
     * the build — how hurt you are, how fast you are moving, how nearly dead
     * the thing in front of you is — so it multiplies the finished number, and
     * a passive that doubles your damage doubles the damage you were actually
     * about to deal rather than some intermediate the items had not seen yet. */
    const passive = this.character?.passive;
    if (passive?.damageMult) damage *= passive.damageMult(player, enemy);

    const dealt = enemy.takeDamage(damage, { ...opts, crit: isCrit });
    // The other half of the ultimate meter.
    this.noteDamageDealt(enemy, dealt);

    // Lifesteal (weapon-specific plus item-wide)
    const steal = (opts.lifesteal ?? 0) + stats.lifesteal;
    if (steal > 0 && dealt > 0) player.heal(dealt * steal, null, true);

    if (proc > 0) {
      this.game.inventory.trigger('onHit', {
        enemy, damage: dealt, isCrit, proc, source: opts.source, noSplash: opts.noSplash,
      });
      if (isCrit) this.game.inventory.trigger('onCrit', { enemy, damage: dealt, proc });
    }

    // The hit sound is pitched by how much of the target it removed, so a
    // chip and a nearly-lethal blow do not read the same.
    if (dealt > 0) {
      audio.hit(opts.hitPoint || enemy.center, clamp01(dealt / Math.max(1, enemy.maxHealth) * 3), isCrit);
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

      /**
       * Hands a secondary its cooldown back before it has been charged.
       *
       * Read once, immediately after the ability returns, so an ability can
       * decide from what actually happened — the revolver only holsters free
       * if the shot it just fired finished something.
       */
      refundSecondary() { self._secondaryRefund = true; },

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
            /* The seam is a second question asked of the same ray.
               A precision weapon does not roll for crits — it goes and finds
               them, and the only place it can find one is the plate the scope
               draws a box around. Asked against the plate's own volume rather
               than against the hit point, so a shot that clips the corner of
               the box counts exactly as much as one down the middle. */
            const weak = spec.weakPoint && enemyHit.enemy.weakPointHit(from, dir);
            self.damageEnemy(enemyHit.enemy, spec.damage * falloffMult, {
              proc: spec.proc ?? 1, source: self.weapon?.name, hitPoint: point,
              knockback: spec.knockback ?? 0, knockbackDir: dir.clone(),
              lifesteal: spec.lifesteal ?? 0,
              bossScale: spec.bossScale,
              // `undefined` leaves the roll alone; only a seam hit forces it.
              crit: weak || undefined,
            });
            if (weak) {
              game.fxApi.explosion(point, 1.7, 0xff2b3c, 0.7);
              game.fxApi.ring(point, 0.3, 2.2, 0xff2b3c, 0.35, 0.9);
            }
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

      /**
       * Wide melee arc centred on the aim direction.
       *
       * `rangeScale` is optional and is the difference between a sword and a
       * *reach* — hand it a function of how far out along the swing a body is
       * (0 at the hilt, 1 at the tip) and it decides what that body is worth.
       * Wraith's blades pay far more at the hilt than at the point, which is
       * the whole of what makes a character with 88 health walk towards things.
       */
      melee(spec) {
        const player = game.player;
        const origin = player.chestPosition;
        const dir = self.ctx.dir;
        const range = spec.range ?? 5;
        const cosLimit = Math.cos(spec.angle ?? 1.4);
        const targets = game.enemies.inRadius(origin, range);
        let any = false;
        for (const e of targets) {
          const dist = _v.copy(e.center).sub(origin).length();
          _v.normalize();
          if (_v.dot(dir) < cosLimit) continue;
          any = true;
          const scale = spec.rangeScale ? spec.rangeScale(clamp01(dist / range)) : 1;
          self.damageEnemy(e, spec.damage * scale, {
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

      /**
       * Teleporting slash that damages everything along the path.
       *
       * Goes exactly where you are looking, in three dimensions. It used to
       * flatten the aim to the horizontal and then drop you onto the ground at
       * the far end, which meant it could not be used to cross a gap, get onto
       * a ledge, or extend a jump — the three things a blink is for. Now it
       * takes the full aim vector, and if you were in the air you stay there.
       */
      blinkSlash(spec) {
        const player = game.player;
        const dir = player.aimDirection(_v).clone();
        if (dir.lengthSq() < 1e-6) dir.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
        dir.normalize();

        const start = player.position.clone();
        const from = player.chestPosition.clone();
        const hit = raycastWorld(from, dir, spec.distance, game.arena);
        let dist = hit ? Math.max(1, hit.distance - 1) : spec.distance;

        // Walk the landing point back until it is somewhere a body can be.
        const end = new THREE.Vector3();
        for (let i = 0; i < 6; i++) {
          end.copy(start).addScaledVector(dir, dist);
          const floor = game.arena.groundHeightAt(end.x, end.z, end.y + player.height);
          if (end.y < floor) end.y = floor;
          if (!game.arena.isInsideSolid(end.x, end.y + player.height * 0.5, end.z, player.radius)) break;
          dist *= 0.7;
        }

        // Damage everything on the swept line.
        const steps = Math.max(2, Math.ceil(dist / 2));
        const hitSet = new Set();
        const p = new THREE.Vector3();
        for (let i = 0; i <= steps; i++) {
          p.copy(start).lerp(end, i / steps);
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
        game.fxApi.beam(start.clone().setY(start.y + 1), end.clone().setY(end.y + 1), spec.color, 0.3, 0.3);
        // The cut that lands: one wide arc across the far end of the dash.
        game.fxApi.slash(end.clone().setY(end.y + 1.1), dir, {
          color: spec.color, radius: spec.radius * 2.1, life: 0.3, tilt: 0.25, grow: 1.6,
        });

        player.position.copy(end);
        // Keep the momentum you arrived with rather than being planted. Blinking
        // upward gives you the height; blinking mid-jump does not cancel it.
        player.velocity.multiplyScalar(0.3);
        if (dir.y > 0.05) player.velocity.y = Math.max(player.velocity.y, dir.y * 6);
        player.grounded = false;
        player.dashIFrames = Math.max(player.dashIFrames || 0, 0.2);
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

        /* The punch is also the movement.
         *
         * It used to be a shove — an impulse applied after the blast, which the
         * ground friction ate in half a second. As a dash it becomes a way to
         * cross a room, and because the dash sweeps, everything between you and
         * where you land gets hit on the way through. The distance scales with
         * the same momentum the damage does, so a grapple into a punch throws
         * you the length of the arena and a standing punch barely steps. */
        const lunge = dir.clone().setY(0);
        if (lunge.lengthSq() < 1e-6) lunge.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
        player.startDash({
          dir: lunge.normalize(),
          speed: (spec.dashSpeed ?? 30) * (1 + t * 0.9),
          duration: (spec.dashTime ?? 0.22) * (1 + t * 0.55),
          iframes: 0.3,
          damage: damage * (spec.sweepFraction ?? 0.45),
          radius: spec.radius * 0.42,
          proc: 0.6,
          source: 'Overcharged Fist',
          knockback: (spec.knockback ?? 26) * 0.7,
          color: spec.color ?? 0xffd24b,
        });
        player.velocity.y = Math.max(player.velocity.y, 2.5 + t * 3);
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
       * A spear thrown for what it paints, not for what it hits.
       *
       * The damage is deliberately negligible: what the throw actually buys is
       * the mark on everything near where it sticks, and the mark is what the
       * dash is looking for.
       */
      markSpear(spec) {
        const player = game.player;
        const dir = player.aimDirection(new THREE.Vector3());
        const color = spec.color ?? 0x3dffa5;
        const radius = spec.radius ?? 13;
        const duration = spec.duration ?? 10;
        const damage = spec.damage ?? 0;
        game.projectiles.spawn({
          position: player.muzzlePosition.clone(),
          velocity: dir.clone().multiplyScalar(spec.speed ?? 78),
          damage: 0, proc: 0, radius: 0.22, life: 3, color,
          gravity: -6, trail: 1.3, glow: 1.6,
          onLand: (position) => {
            const n = self.markEnemies(position, radius, duration, color);
            if (damage > 0) {
              self.areaDamage(position, radius, damage, { proc: 0.4, source: 'Marking Spear' });
            }
            game.fxApi.explosion(position, radius * 0.35, color, 0.6);
            if (n > 0) game.ui.toast(`${n} MARKED`, '#3dffa5');
          },
          source: 'Marking Spear',
        });
        player.addRecoil(1.4);
      },

      /**
       * A dash that goes *through* people, down the line you are looking along.
       *
       * Two things make it Dasher's rather than anybody else's. It takes the
       * camera's direction, pitch included, so a ledge is somewhere you can go
       * rather than something you arrive underneath; and it refunds itself on
       * a marked target. The refund is the whole design — land it on paint and
       * you keep moving, miss and you are walking for ten seconds. Only the
       * enemy actually struck spends its mark, and the refund is capped at one
       * per dash so a line of marked targets is a bonus rather than infinite
       * movement.
       */
      markDash(spec) {
        const player = game.player;
        const color = spec.color ?? 0x3dffa5;
        let refunded = false;
        player.startDash({
          speed: spec.speed ?? 52,
          duration: spec.duration ?? 0.28,
          iframes: spec.iframes ?? 0.18,
          damage: spec.damage ?? 0,
          radius: spec.radius ?? 2.6,
          dir: player.aimDirection(new THREE.Vector3()),
          pitched: true,
          color,
          source: 'Lance Dash',
          onHit: (enemy) => {
            if (refunded || !enemy.statuses.has('marked')) return;
            enemy.statuses.delete('marked');
            refunded = true;
            self.refundUtility();
            game.fxApi.ring(enemy.position, 0.5, 5, color, 0.4, 0.9);
            game.ui.toast('MARK CONSUMED — DASH READY', '#3dffa5');
          },
        });
      },

      /* ---------------- the hat ---------------- */

      /**
       * Throws the hat, and lets it choose where it goes after that.
       *
       * The whole ability is resolved by `Combat._tickHat`; all this does is
       * put the thing in the air pointed at whatever you were looking at.
       * Throwing again while one is already out replaces it, because two hats
       * is one hat too many for a character defined by owning exactly one.
       */
      throwHat(spec) {
        const player = game.player;
        const color = spec.color ?? 0xff5a4d;
        self._clearHat();
        const mesh = buildHatModel(color, spec.scale ?? 0.55);
        const position = player.chestPosition.clone();
        mesh.position.copy(position);
        game.engine.scene.add(mesh);
        self.hat = {
          mesh, position,
          velocity: player.aimDirection(new THREE.Vector3()).multiplyScalar(spec.speed ?? 34),
          speed: spec.speed ?? 34,
          damage: spec.damage ?? 0,
          growth: spec.growth ?? 0.05,
          radius: spec.radius ?? 1.5,
          searchRadius: spec.searchRadius ?? 18,
          range: spec.range ?? 34,
          endless: spec.endless ?? 0,
          maxAge: spec.maxAge ?? ((spec.endless ?? 0) + 12),
          source: spec.source ?? 'Hat Toss',
          // Two cuts per body, not one. A crowd of three is six bounces rather
          // than three, and the growth compounds across all of them — which is
          // what makes a small crowd held together worth staying in.
          maxHits: spec.maxHits ?? 2,
          color, travelled: 0, age: 0, bounces: 0, state: 'out',
          hits: new Map(), rearm: 0, reboundTo: null,
        };
        player.addRecoil(1.2);
      },

      /**
       * Two presses, one hat: throw it somewhere, then be there.
       *
       * The charge is spent on the throw and handed straight back on the
       * teleport, so a charge buys a whole round trip rather than half of one
       * — which is what makes two charges read as two blinks instead of one.
       */
      hatBlink(spec) {
        const player = game.player;
        const color = spec.color ?? 0xff5a4d;

        if (self.hatMarker) {
          /* Go to the hat. Not to the hat's *height* — to the hat.
           *
           * This used to run the exit through `settleTeleport`, which holds the
           * altitude you left from and only ever rises. That is right for a
           * blink, where crossing a gap must not drop you into it, and exactly
           * wrong for a recall: the hat is a place, lying on a specific piece of
           * ground, and throwing it off a ledge and pressing recall left you
           * hanging in the air at the height you were standing at with the hat
           * visible somewhere below your feet. The whole ability is "be where
           * that is", so it puts you where that is. */
          const start = player.position.clone();
          const end = self.hatMarker.position.clone();
          // The marker sits 12 cm above the ground it landed on; stand on it
          // rather than in it.
          end.y = game.arena.groundHeightAt(end.x, end.z, end.y + 2);
          game.fxApi.beam(start.clone().setY(start.y + 1), end.clone().setY(end.y + 1), color, 0.3, 0.2);
          game.fxApi.glow(start.clone().setY(start.y + 1), { color, size: 1.8, life: 0.3, grow: 2 });
          player.position.copy(end);
          player.velocity.set(0, 0, 0);
          player.grounded = true;
          player.jumpsUsed = 0;
          player.dashIFrames = Math.max(player.dashIFrames || 0, 0.2);
          player.snapCamera();
          game.fxApi.ring(end, 0.4, 4, color, 0.45, 0.9);
          self._clearHatMarker();
          /* And *now* the five seconds start.
             The throw is free — see `deferCooldown` — because the thing being
             bought is the trip, and a hat left in a field for half a minute
             should not have been quietly serving its own cooldown out there. */
          self.spendUtility();
          return;
        }

        self._clearHatMarker();
        game.projectiles.spawn({
          position: player.muzzlePosition.clone(),
          velocity: player.aimDirection(new THREE.Vector3()).multiplyScalar(spec.speed ?? 62),
          damage: 0, proc: 0, radius: 0.3, life: 3, color,
          gravity: spec.gravity ?? -12, trail: 1.1, glow: 1.8,
          onLand: (position) => {
            // Sat on the ground rather than floating in it, whatever it landed on.
            const p = position.clone();
            p.y = game.arena.groundHeightAt(p.x, p.z, p.y + 2) + 0.12;
            const mesh = buildHatModel(color, 0.55);
            mesh.position.copy(p);
            game.engine.scene.add(mesh);
            self.hatMarker = { mesh, position: p, color, time: spec.life ?? 30 };
            game.fxApi.ring(p, 0.3, 2.4, color, 0.4, 0.8);
            game.ui.toast('HAT SET — SHIFT TO RECALL', `#${color.toString(16).padStart(6, '0')}`);
          },
          source: "Wanderer's Mark",
        });
        player.addRecoil(1);
      },

      /* ---------------- primaries ---------------- */

      /**
       * Where a repeating primary is in its own sequence.
       *
       * Returns 0..length-1 and advances, resetting if the trigger has been
       * quiet for `reset` seconds. That reset is what makes a combo a combo
       * rather than a counter: stop swinging for a moment and the lance starts
       * again at the first cut instead of handing you the long thrust for free
       * every third click of a fight you walked away from.
       */
      combo(length, reset = 1.1) {
        const i = self._comboIndex % length;
        self._comboIndex = (self._comboIndex + 1) % length;
        self._comboTimer = reset;
        return i;
      },

      /** What the *next* call to `combo` will return, without advancing it. */
      comboPeek(length) { return self._comboIndex % length; },

      /**
       * A spread of pellets down one trigger pull.
       *
       * Hitscan rather than projectiles, and deliberately: a shotgun is a
       * decision about distance, and the distance has to be resolved on the
       * frame you pull the trigger or the decision is being made by the
       * travel time instead of by you. What makes it a shotgun and not a
       * burst of rifle rounds is `falloff` — the fraction of its damage still
       * standing at `range`. A short, brutal one keeps almost none; a scatter
       * gun that is still worth firing across a room keeps half.
       */
      shotgun(spec) {
        const pellets = spec.pellets ?? 8;
        const spread = spec.spread ?? 0.08;
        const range = spec.range ?? 22;
        const each = spec.damage / pellets;
        let hits = 0;
        for (let i = 0; i < pellets; i++) {
          const hit = api.hitscan({
            damage: each, proc: (spec.proc ?? 1) / pellets, range,
            color: spec.color ?? 0xffd58a, tracer: true, thick: spec.thick ?? 0.03,
            spread, falloff: { start: spec.near ?? range * 0.18, end: range, min: spec.falloff ?? 0.3 },
            knockback: spec.knockback ?? 0,
          });
          if (hit) hits++;
        }
        game.fxApi.muzzle(self.ctx.origin, self.ctx.dir, spec.color ?? 0xffd58a, 2.2);
        return hits;
      },

      /* ---------------- Diver ---------------- */

      /**
       * Fire on the ground, thrown where you are looking.
       *
       * Two things at once, and the second is the point: it burns whatever
       * stands in it, and it is a *charge* lying in the arena waiting for the
       * slam. Everything about the patch — that it is thrown rather than
       * placed, that there are three of them, that they last a while — exists
       * so that by the time Diver commits to a slam there is already something
       * on the floor worth landing on.
       */
      firePatch(spec) {
        const target = self.ctx.aimPoint.clone();
        const color = spec.color ?? 0xff7a2a;
        game.projectiles.spawn({
          position: game.player.chestPosition.clone(),
          velocity: _v.copy(target).sub(game.player.chestPosition)
            .normalize().multiplyScalar(spec.speed ?? 42).clone(),
          damage: 0, proc: 0, radius: 0.28, life: 3, color,
          gravity: spec.gravity ?? -16, trail: 1.2, glow: 2.2,
          onLand: (position) => self.placeFirePatch(position, { ...spec, color }),
          source: 'Fire Patch',
        });
        game.player.addRecoil(0.9);
      },

      /**
       * The slam. Straight down onto the aim point, fast, and hard on arrival.
       *
       * The dive is a real movement rather than a teleport with an explosion at
       * the end, because the patches are on the floor and the whole skill of
       * the ability is choosing which one to arrive at.
       */
      diveSlam(spec) {
        game.player.startDiveSlam({
          ...spec,
          onLand: (position) => {
            const color = spec.color ?? 0xff7a2a;
            self.areaDamage(position, spec.radius ?? 8, spec.damage ?? 0, {
              proc: 0.9, source: 'Dive Slam', force: spec.knockback ?? 18,
            });
            game.fxApi.explosion(position, spec.radius ?? 8, color, 1.1);
            game.fxApi.ring(position, 0.8, spec.radius ?? 8, color, 0.5, 1);
            game.engine.addShake(0.4);
            // Firebomb: everything he lands on goes up with him.
            const lit = self.detonateFirePatches(
              position, spec.patchRadius ?? (spec.radius ?? 8),
              spec.patchDamage ?? (spec.damage ?? 0) * 2.4, color,
            );
            if (lit) game.ui.toast(`FIREBOMB ×${lit}`, '#ff7a2a');
          },
        });
      },

      /** A dash that leaves you faster than it found you. */
      speedDash(spec) {
        game.player.startDash({
          speed: spec.speed ?? 40, duration: spec.duration ?? 0.26,
          iframes: spec.iframes ?? 0.14, color: spec.color ?? 0xff7a2a,
          pitched: spec.pitched ?? true,
        });
        game.player.addBuff('warcry', spec.buffTime ?? 5, 0, 1, spec.label ?? '💨 Speed Dash',
          { move: spec.move ?? 0.45 });
      },

      /* ---------------- the second button ---------------- */

      /**
       * Opens the parry window.
       *
       * Half a second, and nothing happens during it — that is the design. An
       * ability that does something while it waits is an ability you press on
       * cooldown; one that does nothing at all is a read, and the reward for
       * reading correctly is enormous precisely because the cost of pressing it
       * blind is a whole ten seconds of not having a dash.
       */
      parry(spec) {
        self._parrySpec = spec;
        game.player.parryTime = spec.window ?? 0.5;
        game.fxApi.ring(game.player.position, 0.3, 2.4, spec.color ?? 0x3dffa5, 0.35, 0.55);
      },

      /** Four small charges dropped on the aim point. */
      missileCluster(spec) {
        const target = self.ctx.aimPoint.clone();
        for (let i = 0; i < (spec.count ?? 4); i++) {
          game.projectiles.spawnMortar({
            target, scatter: spec.scatter ?? 3.5, delay: i * (spec.interval ?? 0.08),
            color: spec.color,
            splash: {
              radius: spec.radius ?? 5, damage: spec.damage, proc: 0.7,
              color: spec.color, force: 8,
            },
            source: 'Missile Cluster',
          });
        }
        game.player.addRecoil(1.6);
      },

      /** Two seconds of not being there, and of nothing looking for you. */
      phase(spec) {
        const player = game.player;
        const dur = spec.duration ?? 2;
        player.invulnerable = Math.max(player.invulnerable, dur);
        player.addBuff('cloak', dur, 1, 1, spec.label ?? '🌑 Phase');
        game.fxApi.cloakBurst(player.chestPosition);
        game.fxApi.ring(player.position, 0.4, 5, spec.color ?? 0xd94bff, 0.45, 0.8);
        // Losing aggro is the half of the ability the invulnerability does not
        // cover: two seconds of immunity you spend still being chased is two
        // seconds of nothing, and this is the character who cannot afford it.
        for (const e of game.enemies.inRadius(player.position, spec.radius ?? 30)) {
          e.loseTarget?.(spec.aggro ?? 2.4);
        }
      },

      /**
       * Behind the plate: sets or clears the guard posture.
       *
       * Refreshed rather than granted, because it has no duration — it is true
       * for exactly as long as the button is down, and a buff with a duration
       * would either expire under a held button or outlive a released one.
       */
      guard(on, spec) {
        const player = game.player;
        if (!on) { player.buffs.delete('guard'); player.markStatsDirty(); return; }
        player.addBuff('guard', 0.3, spec.reduction ?? 0.62, 1, spec.label ?? '🛡️ Guard',
          { move: spec.move ?? 1 });
        game.fxApi.ring(player.position, 0.4, 2.6, spec.color ?? 0x6fd0ff, 0.35, 0.6);
      },
      holdGuard(spec) {
        const player = game.player;
        const b = player.buffs.get('guard');
        if (b) b.time = 0.3;
        else api.guard(true, spec);
      },

      /** Straight down, immediately, and hard. */
      downSlam(spec) {
        game.player.startDiveSlam({
          ...spec, straightDown: true,
          onLand: (position) => {
            const color = spec.color ?? 0xffd24b;
            self.areaDamage(position, spec.radius ?? 9, spec.damage ?? 0, {
              proc: 0.9, source: 'Down Slam', force: spec.knockback ?? 24,
            });
            game.fxApi.explosion(position, spec.radius ?? 9, color, 1.2);
            game.fxApi.ring(position, 1, spec.radius ?? 9, color, 0.5, 1);
            game.engine.addShake(0.45);
          },
        });
      },

      /**
       * The chain, thrown at a body and used as a winch.
       *
       * The same harpoon the projectile system already knows how to run, which
       * is deliberate — Chain's whole identity is that the thing he throws
       * comes back, and this is the version where what comes back is whoever
       * he threw it at.
       */
      chainPull(spec) {
        const color = spec.color ?? 0xff5a4d;
        game.projectiles.spawn({
          position: game.player.muzzlePosition.clone(),
          velocity: game.player.aimDirection(new THREE.Vector3()).multiplyScalar(spec.speed ?? 70),
          damage: spec.damage ?? 0, proc: 0.7, radius: 0.6, life: 1.1, color,
          gravity: 0, trail: 1.4, glow: 1.6, knockback: 0,
          harpoon: { time: spec.pullTime ?? 0.8, speed: spec.pullSpeed ?? 40, color },
          source: 'Chain Pull',
        });
        game.player.addRecoil(1.4);
      },

      /* ---------------- ultimates ---------------- */

      /**
       * Diver: everything within a very large circle catches, and stays lit.
       *
       * The damage is deliberately not front-loaded. An ultimate that goes off
       * once is a button; this one is ten seconds during which the arena around
       * him is on fire and he is faster than anything in it, so the play is to
       * keep moving through the crowd rather than to stand in the middle of the
       * explosion you just made.
       */
      inferno(spec) {
        const player = game.player;
        const color = spec.color ?? 0xff7a2a;
        const duration = spec.duration ?? 10;
        player.addBuff('inferno', duration, 0, 1, spec.label ?? '🔥 Inferno', {
          radius: spec.radius ?? 22, damage: spec.damage ?? 0, burn: spec.burn ?? 0,
          interval: spec.interval ?? 0.5, color,
        });
        // The speed comes from the same buff every other haste in the game
        // uses, so items and abilities stack the one way rather than two.
        player.addBuff('warcry', duration, 0, 1, '🔥 Inferno', { move: spec.move ?? 0.5 });
        // The opening circle: everything caught right now is already burning.
        for (const e of game.enemies.inRadius(player.position, spec.radius ?? 22)) {
          e.applyStatus('burn', spec.burnTime ?? 6, { dps: spec.burn ?? 0 });
        }
        game.fxApi.ring(player.position, 1, spec.radius ?? 22, color, 0.9, 1);
        game.fxApi.explosion(player.position, 6, color, 1.6);
      },

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

      /**
       * Sniper: call the range on a piece of ground.
       *
       * The paint is `marked`, so it glows through the arena the way Dasher's
       * does and is visible from wherever you are lying; the teeth are
       * `sunder`, which is the same status Sunder Rounds applies and therefore
       * already understood by `takeDamage`. Nothing new is being invented here
       * — the ability is a spotter putting two existing labels on a group at
       * once, which is what a spotter does.
       */
      rangeCard(spec) {
        const centre = self.ctx.aimPoint.clone();
        const radius = spec.radius ?? 16;
        const hit = self.markEnemies(centre, radius, spec.duration ?? 12, spec.color);
        for (const e of game.enemies.inRadius(centre, radius)) {
          e.applyStatus('sunder', spec.duration ?? 12, {
            armor: spec.armor ?? 45, vuln: spec.vuln ?? 0.25,
          });
        }
        game.fxApi.ring(centre, 0.6, radius, spec.color, 0.8, 1.1);
        game.ui.toast(hit ? `${hit} RANGED` : 'RANGE CALLED', '#d6a24a');
      },

      /**
       * Sniper's ultimate: a list, worked down one round at a time.
       *
       * Resolved over several frames rather than all at once, because the whole
       * read of the ability is the *rhythm* — a round leaving every quarter
       * second, each one picking its own target — and a burst of fourteen
       * simultaneous tracers is a firework instead of a sniper. Targets are
       * chosen at the moment each round is fired, not up front, so a round is
       * never spent on something already dead.
       */
      killOrder(spec) {
        self._killOrder = {
          left: spec.count ?? 12,
          // Which bodies have already taken a round, and how many. A Map rather
          // than a Set because the falloff compounds per repeat.
          hits: new Map(),
          timer: 0,
          interval: spec.interval ?? 0.28,
          damage: spec.damage,
          radius: spec.radius ?? 60,
          color: spec.color ?? 0xff6a4d,
        };
        game.engine.addShake(0.25);
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

      /**
       * Halcyon: the limiters come off, and nothing else changes.
       *
       * There is no new attack here on purpose. Halcyon already owns the two
       * things this touches — the thrusters and the bomb rack — and both are
       * rationed. Removing the ration for fifteen seconds is the ability; the
       * buff is the whole payload, read by the flight tick and by the special's
       * own `cooldownFor`.
       */
      ordnanceOverride(spec) {
        const player = game.player;
        const duration = spec.duration ?? 15;
        const color = spec.color ?? 0x7fe0ff;
        player.startFlight({
          duration, riseSpeed: 13, hoverSpeed: -1.2, speedMult: 1.25, color,
          // Endless within its window: fuel does not tick down and touching the
          // floor no longer cuts the thrusters, so the whole fifteen seconds is
          // spent airborne whether or not you land in the middle of it.
          endless: true,
        });
        player.addBuff('bombardier', duration, 1, 1, '🛩️ Ordnance Override');
        game.fxApi.ring(player.position, 1, 14, color, 0.9, 1);
        game.engine.addShake(0.45);
      },

      /**
       * One charge, thrown at whatever you are looking at.
       *
       * Aimed at the crosshair point rather than at the crosshair *direction*:
       * a bombardier hanging thirty metres up is looking down a steep line, and
       * a charge thrown along that line with any real gravity on it lands well
       * short of the thing being aimed at. Almost no drop and a fast throw
       * means where you look is where the crater goes, which is the whole
       * reason to be up there.
       */
      bunkerBomb(spec) {
        const player = game.player;
        const color = spec.color ?? 0x7fe0ff;
        const origin = player.muzzlePosition.clone();
        const dir = _v.copy(self.ctx.aimPoint).sub(origin);
        if (dir.lengthSq() < 1e-6) dir.copy(self.ctx.dir);
        dir.normalize();
        game.projectiles.spawn({
          position: origin,
          velocity: dir.clone().multiplyScalar(spec.speed ?? 62),
          damage: 0, radius: 0.42, life: 5, color, gravity: spec.gravity ?? -5,
          trail: 1.8, glow: 2.6, detonateOnGround: true,
          splash: { radius: spec.radius ?? 16, damage: spec.damage, proc: 1, color, force: 22 },
          source: 'Bomb Cluster',
        });
        player.addRecoil(1.8);
        game.engine.addShake(0.18);
      },

      /**
       * Dasher: one spear, thrown properly, and everything it catches comes to it.
       *
       * The pull is what makes the dash resets worth having — a crowd raked
       * into a single point is a crowd one dash goes through end to end, and
       * every body in it is painted, so each pass hands the dash straight back.
       */
      greatSpear(spec) {
        const player = game.player;
        const color = spec.color ?? 0x3dffa5;
        const radius = spec.radius ?? 20;
        game.projectiles.spawn({
          position: player.muzzlePosition.clone(),
          velocity: player.aimDirection(new THREE.Vector3()).multiplyScalar(spec.speed ?? 74),
          damage: 0, proc: 0, radius: 0.55, life: 4, color,
          gravity: -3, trail: 2.4, glow: 2.8,
          onLand: (position) => {
            const marked = self.markEnemies(position, radius, spec.markDuration ?? 14, color);
            self.areaDamage(position, radius, spec.damage, { proc: 0.7, source: 'Skewer', force: 4 });
            // The shaft is the anchor. `pulled` reels toward whatever it is
            // handed, so a bare point stands in for a body perfectly well.
            const anchor = { position, chestPosition: position };
            for (const e of game.enemies.inRadius(position, radius)) {
              e.applyStatus('pulled', spec.pull?.time ?? 1.1, {
                target: anchor, speed: spec.pull?.speed ?? 30, color,
              });
              e.grounded = false;
            }
            game.fxApi.explosion(position, radius * 0.5, color, 1.3);
            game.fxApi.ring(position, 1, radius, color, 0.9, 1);
            game.engine.addShake(0.5);
            if (marked > 0) game.ui.toast(`${marked} SKEWERED`, '#3dffa5');
          },
          source: 'Skewer',
        });
        self.grantDashResets(spec.dashResets ?? 3);
        game.ui.toast(`DASH ×${self.dashResets}`, '#3dffa5');
        player.addRecoil(3);
      },
    };

    return api;
  }
}

/** Frees a small one-off model. Hats are built per throw, not pooled. */
function disposeTree(root) {
  root.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
  });
}

function falloffScale(distance, f) {
  if (distance <= f.start) return 1;
  if (distance >= f.end) return f.min;
  const t = (distance - f.start) / (f.end - f.start);
  return 1 + (f.min - 1) * t;
}
