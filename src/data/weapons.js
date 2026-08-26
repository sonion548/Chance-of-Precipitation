/**
 * Weapon arsenal.
 *
 * Damage figures are multipliers of the player's current damage stat, so weapons
 * scale automatically with levels and items.
 *
 * Every ability receives a combat context (see systems/combat.js) exposing:
 *   ctx.origin      muzzle position (Vector3)
 *   ctx.dir         normalised aim direction (Vector3)
 *   ctx.aimPoint    world point under the crosshair
 *   ctx.dmg         the player's current damage stat
 *   ctx.spawnBullet(spec) / ctx.hitscan(spec) / ctx.melee(spec) / ctx.spawnMortar(spec)
 *   ctx.recoil(n) / ctx.shake(n) / ctx.impulse(vec) / ctx.fx
 *
 * `proc` is the proc coefficient — how strongly a hit triggers on-hit items.
 *
 * A weapon may also opt into three things nothing else in the arsenal has:
 *   scope: { fov, distance, sensitivity }  the camera goes to the eye while
 *                                          aiming, and the HUD draws a lens
 *   randomCrits: false                     crits are never rolled, only earned
 *   critChanceToDamage: n                  crit chance an item grants is read
 *                                          as n× that much crit damage instead
 * and `primary.activeReload: { time, window, cooldown }`, which takes the fire
 * button away after each shot until the reload bar is answered.
 *
 * `anim` names the body animation the ability plays: 'shoot' (a recoil punch
 * through the shoulder), 'pump', 'slash', 'punch', 'thrust', 'beam' or 'lob'.
 * It is a hint to the rig, not a state machine — see entities/characterRig.js.
 * An ability with no `anim` still recoils; it just does not act out a swing.
 */

export const WEAPONS = [
  /* ------------------------------------------------------------------ */
  {
    id: 'mk4_sidearm',
    name: 'MK-4 Sidearm',
    icon: '🔫',
    tag: 'Balanced · Hitscan',
    color: 0xc8d2e4,
    model: 'pistol',
    unlocked: true,
    echoCost: 0,
    desc: 'Standard issue. Reliable, accurate, and forgiving — every proc coefficient in the game was balanced against this thing.',
    displayStats: { Damage: '100%', 'Fire Rate': '5.9/s', Range: 'Long', Proc: '1.0' },
    primary: {
      name: 'Service Round', key: 'M1', icon: '•', hold: true,
      anim: 'shoot',
      desc: 'Fire a round for 100% damage.',
      cooldown: 0.17, scalesWithAttackSpeed: true,
      fire(ctx) {
        ctx.hitscan({ damage: ctx.dmg * 1.0, proc: 1.0, range: 180, color: 0xfff0c0, tracer: true, spread: 0.006 });
        ctx.recoil(0.5);
      },
    },
    secondary: {
      name: 'Focused Shot', key: 'Q', icon: '◎',
      anim: 'shoot',
      desc: 'Charge up to 1s, then fire a piercing round for up to 480% damage.',
      cooldown: 3.0, charge: 1.0, minCharge: 0.18,
      fire(ctx, t) {
        const power = 1.2 + 3.6 * t;
        ctx.hitscan({ damage: ctx.dmg * power, proc: 1.0, range: 240, color: 0xffd58a, tracer: true, thick: 0.09 + t * 0.16, pierce: 6 });
        ctx.recoil(2.2 + t * 3);
        ctx.shake(0.18 + t * 0.3);
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'scattergun',
    name: 'Breach Scattergun',
    icon: '🔩',
    tag: 'Close Range · Burst',
    color: 0xd88a4a,
    model: 'shotgun',
    unlocked: false,
    echoCost: 250,
    desc: 'Ten pellets of persuasion. Devastating at point blank, embarrassing at range. Pairs beautifully with anything that procs on hit.',
    displayStats: { Damage: '10 × 44%', 'Fire Rate': '1.4/s', Range: 'Short', Proc: '0.4' },
    primary: {
      name: 'Buckshot', key: 'M1', icon: '⁘', hold: true,
      anim: 'pump',
      desc: 'Fire 10 pellets for 44% damage each.',
      cooldown: 0.72, scalesWithAttackSpeed: true,
      fire(ctx) {
        for (let i = 0; i < 10; i++) {
          ctx.hitscan({
            damage: ctx.dmg * 0.44, proc: 0.4, range: 42, color: 0xffc07a,
            tracer: i % 2 === 0, spread: 0.075, falloff: { start: 14, end: 40, min: 0.42 },
          });
        }
        ctx.recoil(3.4); ctx.shake(0.2);
      },
    },
    secondary: {
      name: 'Concussive Blast', key: 'Q', icon: '💨',
      anim: 'pump',
      desc: 'Blast a shockwave for 380% damage, launching enemies away — and you backwards.',
      cooldown: 5.0,
      fire(ctx) {
        ctx.cone({ damage: ctx.dmg * 3.8, proc: 1.0, range: 16, angle: 0.9, knockback: 26, color: 0xffa050 });
        ctx.impulse(ctx.dir.clone().multiplyScalar(-16).setY(7));
        ctx.recoil(6); ctx.shake(0.5);
        ctx.fx.explosion(ctx.origin.clone().addScaledVector(ctx.dir, 5), 9, 0xffa050, 1);
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'arc_emitter',
    name: 'Arc Emitter',
    icon: '⚡',
    tag: 'Chaining · Crowd Control',
    color: 0x6fd0ff,
    model: 'rifle',
    unlocked: false,
    echoCost: 400,
    desc: 'Fires an ionised tether that leaps between targets. Damage falls off with each jump, but the chain never asks permission.',
    displayStats: { Damage: '95% ×4', 'Fire Rate': '2.8/s', Range: 'Medium', Proc: '0.6' },
    primary: {
      name: 'Arc Bolt', key: 'M1', icon: '⌁', hold: true,
      anim: 'shoot',
      desc: 'Zap a target for 95% damage, chaining to 3 more for 70% each.',
      cooldown: 0.36, scalesWithAttackSpeed: true,
      fire(ctx) {
        const hit = ctx.hitscan({ damage: ctx.dmg * 0.95, proc: 0.6, range: 70, color: 0x9fe0ff, tracer: true, thick: 0.05 });
        if (hit) ctx.chain(hit, 3, ctx.dmg * 0.7, 15, 0x9fe0ff, 0.35);
        ctx.recoil(0.7);
      },
    },
    secondary: {
      name: 'Overload Sphere', key: 'Q', icon: '🔆',
      anim: 'lob',
      desc: 'Launch a slow orb that zaps everything within 14m for 70% damage 12 times.',
      cooldown: 8.0,
      fire(ctx) {
        ctx.spawnBullet({
          speed: 11, damage: 0, radius: 0.7, life: 7, color: 0x6fd0ff, glow: 2.4, gravity: 0, ghost: true,
          aura: { radius: 14, interval: 0.4, damage: ctx.dmg * 0.7, proc: 0.3, color: 0x9fe0ff },
        });
        ctx.recoil(1.2);
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'rivet_driver',
    name: 'Rivet Driver',
    icon: '📌',
    tag: 'Sustained · Piercing',
    color: 0xb9c4d8,
    model: 'smg',
    unlocked: false,
    echoCost: 550,
    desc: 'An industrial fastener with the safety removed. Low damage per rivet, absurd fire rate, and it goes through the first thing it hits.',
    displayStats: { Damage: '42%', 'Fire Rate': '13/s', Range: 'Medium', Proc: '0.25' },
    primary: {
      name: 'Rivet', key: 'M1', icon: '│', hold: true,
      anim: 'shoot',
      desc: 'Drive a rivet for 42% damage that pierces 2 enemies.',
      cooldown: 0.077, scalesWithAttackSpeed: true,
      fire(ctx) {
        ctx.spawnBullet({
          speed: 145, damage: ctx.dmg * 0.42, proc: 0.25, radius: 0.13, life: 1.1,
          color: 0xe4ecff, pierce: 2, spread: 0.022, trail: 0.5, gravity: -2,
        });
        ctx.recoil(0.26);
      },
    },
    secondary: {
      name: 'Harpoon', key: 'Q', icon: '🪝',
      anim: 'thrust',
      desc: 'Fire a barbed line for 420% damage, then winch the target all the way in — it is dragged to your feet over 0.9s and chilled when it lands.',
      cooldown: 4.0,
      fire(ctx) {
        ctx.spawnBullet({
          speed: 78, damage: ctx.dmg * 4.2, proc: 1.0, radius: 0.3, life: 1.6, color: 0x7ad4ff,
          trail: 1, pierce: 0, chill: 3,
          // The winch, not a shove: `reel` runs the target in on a line for its
          // whole duration. Heavy things resist it, bosses barely move.
          harpoon: { time: 0.9, speed: 34, color: 0x7ad4ff },
        });
        ctx.recoil(1.6);
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'seeker_launcher',
    name: 'Seeker Launcher',
    icon: '🚀',
    tag: 'Explosive · Area',
    color: 0x8fbf6a,
    model: 'launcher',
    unlocked: false,
    echoCost: 700,
    desc: 'Fires arcing charges that lock onto whatever is unlucky enough to be near the impact point. Clears rooms; also clears you if you are careless.',
    displayStats: { Damage: '260% AoE', 'Fire Rate': '1.2/s', Range: 'Medium', Proc: '1.0' },
    primary: {
      name: 'Seeker Charge', key: 'M1', icon: '◆', hold: true,
      anim: 'lob',
      desc: 'Lob a charge that detonates for 260% damage in 8m.',
      cooldown: 0.85, scalesWithAttackSpeed: true,
      fire(ctx) {
        ctx.spawnBullet({
          speed: 46, damage: 0, radius: 0.3, life: 5, color: 0xa8e070, gravity: -22, homingRadius: 9, homingStrength: 3.4,
          splash: { radius: 8, damage: ctx.dmg * 2.6, proc: 1.0, color: 0xa8e070, force: 12 },
          detonateOnGround: true, trail: 1.2,
        });
        ctx.recoil(2.1); ctx.shake(0.12);
      },
    },
    secondary: {
      name: 'Cluster Barrage', key: 'Q', icon: '☄️',
      anim: 'lob',
      desc: 'Call down 9 mortars around your aim point for 220% damage each.',
      cooldown: 9.0,
      fire(ctx) {
        for (let i = 0; i < 9; i++) {
          ctx.spawnMortar({
            target: ctx.aimPoint, scatter: 8, delay: i * 0.1,
            splash: { radius: 7, damage: ctx.dmg * 2.2, proc: 0.7, color: 0xa8e070, force: 8 },
          });
        }
        ctx.recoil(3); ctx.shake(0.3);
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'photon_lance',
    name: 'Photon Lance',
    icon: '🔆',
    tag: 'Beam · Ramping',
    color: 0xff7ad4,
    model: 'beam',
    unlocked: false,
    echoCost: 850,
    desc: 'A continuous coherent beam that heats up the longer it stays on a target — up to triple damage. Rewards commitment and punishes flinching. The ramp is what a boss is armoured against: against one it is worth barely a third as much.',
    displayStats: { Damage: '58%/tick →170%', 'Tick Rate': '11/s', 'vs Boss': 'ramp ×0.3', Proc: '0.15' },
    /* The ramp is the weapon, and a boss is the one target that lets it sit at
       the top of its curve for free.
       Everything else in the arena moves, dies, or has to be re-acquired, which
       is the cost the 3× was priced against; a boss is a stationary wall that
       pays that cost once. So the *ramp* is cut against bosses rather than the
       damage — the beam still opens at full strength, it just does not get to
       triple itself for standing still. One number, read by both abilities. */
    bossRamp: 0.3,
    primary: {
      name: 'Coherent Beam', key: 'M1', icon: '━', hold: true, beam: true,
      anim: 'beam',
      desc: 'Sustained beam dealing 58% damage per tick, ramping to 170% after 3s on target — but only to 93% against a boss.',
      cooldown: 0.09, scalesWithAttackSpeed: true,
      fire(ctx) {
        const heat = ctx.getHeat();
        const ramp = 1 + 2.0 * heat;
        const bossRamp = 1 + 2.0 * heat * 0.3;
        const hit = ctx.hitscan({
          damage: ctx.dmg * 0.58 * ramp, proc: 0.15, range: 130, thick: 0.05 + heat * 0.11,
          color: heat > 0.6 ? 0xffd0f0 : 0xff7ad4, beam: 0.1, spread: 0,
          bossScale: bossRamp / ramp,
        });
        ctx.setHeat(hit ? Math.min(1, heat + 0.055) : Math.max(0, heat - 0.02));
        ctx.recoil(0.06);
      },
      onRelease(ctx) { ctx.decayHeat(); },
    },
    secondary: {
      name: 'Prism Burst', key: 'Q', icon: '✳️',
      anim: 'beam',
      desc: 'Discharge stored light in a piercing lance for 620% damage, scaled by beam heat. A boss takes far less of the stored half.',
      cooldown: 7.0,
      fire(ctx) {
        const heat = ctx.getHeat();
        // Same split: half the burst is the base charge, half is stored heat,
        // and only the stored half is cut down against a boss.
        const stored = 0.5 + heat;
        const bossStored = 0.5 + heat * 0.3;
        ctx.hitscan({
          damage: ctx.dmg * 6.2 * stored, proc: 1.0, range: 200, thick: 0.42,
          color: 0xffb0e8, pierce: 99, beam: 0.35,
          bossScale: bossStored / stored,
        });
        ctx.setHeat(0);
        ctx.recoil(4); ctx.shake(0.45);
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'void_reaper',
    name: 'Void Reaper',
    icon: '🌑',
    tag: 'Piercing · Lifesteal',
    color: 0xa15bff,
    model: 'voidblade',
    unlocked: false,
    echoCost: 1000,
    desc: 'A blade folded out of a collapsed star. Every swing feeds you a little of what it takes. Requires getting uncomfortably close.',
    displayStats: { Damage: '245% arc + 130% wave', 'Swing Rate': '2.2/s', Range: 'Melee → 26m', Proc: '1.0' },
    primary: {
      name: 'Reaping Arc', key: 'M1', icon: '◜', hold: true,
      anim: 'slash',
      desc: 'A flat horizontal slash for 245% damage that heals you for 8% of what it deals — and throws the cut itself out as a crescent wave for another 130%, cleaving through everything it passes.',
      cooldown: 0.45, scalesWithAttackSpeed: true,
      fire(ctx) {
        ctx.slashWave({
          damage: ctx.dmg * 2.45, proc: 1.0, range: 6.4, angle: 1.5, lifesteal: 0.08,
          color: 0xa15bff,
          // The wave is the swing leaving the blade: same cut, still travelling.
          wave: {
            damage: ctx.dmg * 1.3, proc: 0.6, speed: 34, range: 26, radius: 2.6,
            pierce: 99, lifesteal: 0.08,
          },
        });
        ctx.recoil(0.9);
      },
    },
    secondary: {
      name: 'Blink Slash', key: 'Q', icon: '⟿',
      anim: 'slash',
      desc: 'Phase 14m along your line of sight — upward, downward, or across a gap — cutting everything on the path for 560% damage.',
      cooldown: 4.5,
      fire(ctx) {
        ctx.blinkSlash({ distance: 14, damage: ctx.dmg * 5.6, proc: 1.0, radius: 3.2, lifesteal: 0.12, color: 0xc98aff });
        ctx.shake(0.3);
      },
    },
  },


  /* ------------------------------------------------------------------ */
  {
    id: 'siege_gauntlets',
    name: 'Siege Gauntlets',
    icon: '🥊',
    tag: 'Melee · Shockwave · Mobility',
    color: 0xffb347,
    model: 'gauntlet',
    unlocked: false,
    echoCost: 800,
    desc: 'Two demolition drivers worn on the hands. Each punch fires a compression charge a few metres out in front of the knuckles, and the same charge, pointed downward, will put you on a rooftop.',
    lore: 'Rated for load-bearing walls. Nobody wrote down what else.',
    displayStats: { Damage: '210% wave', 'Punch Rate': '2.9/s', Range: '9m cone', Proc: '0.8' },
    primary: {
      name: 'Shock Jab', key: 'M1', icon: '🥊', hold: true,
      anim: 'punch',
      desc: 'Punch a compression wave 9m out in front of you for 210% damage, knocking everything it catches backwards.',
      cooldown: 0.35, scalesWithAttackSpeed: true,
      fire(ctx) {
        ctx.shockwave({
          damage: ctx.dmg * 2.1, proc: 0.8, range: 9, angle: 0.95,
          knockback: 15, color: 0xffb347,
        });
        ctx.recoil(1.6);
      },
    },
    secondary: {
      name: 'Jet Boost', key: 'Q', icon: '🚀',
      anim: 'punch',
      desc: 'Fire both gauntlets at the floor and ride the blast straight up, refunding your jumps and blasting anything underneath for 260% damage.',
      cooldown: 4.5,
      fire(ctx) {
        ctx.jetBoost({
          up: 21, forward: 6, damage: ctx.dmg * 2.6, radius: 6.5, color: 0xffb347,
        });
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'meridian_longrifle',
    name: 'Meridian Longrifle',
    icon: '🎯',
    tag: 'Precision · Scoped',
    color: 0xff6a4d,
    model: 'sniper',
    unlocked: false,
    echoCost: 950,
    desc: 'A bolt gun with a real optic on it. Behind the glass every body in the arena shows the one plate it never got seated properly — put a round through that and the hit is critical, guaranteed. It never rolls a crit of its own, so everything that would have bought you the dice buys you the multiplier instead.',
    lore: 'Issued with one round chambered and a note: make it count.',
    displayStats: { Damage: '900%', Crit: 'Earned, never rolled', Reload: 'Timed', Proc: '1.0' },
    /* The trade the whole weapon is built on.
       Handing a sniper random crits would make the seam pointless — you would
       hit it and sometimes get nothing extra, or miss it and get the crit
       anyway. Turning the chance off makes the seam the only source of a
       critical hit, and converting the stat keeps every crit-chance item in
       the pool worth picking up. */
    randomCrits: false,
    critChanceToDamage: 2.5,
    scope: { fov: 15, distance: 0.28, sensitivity: 0.4 },
    primary: {
      name: 'Bolt Round', key: 'M1', icon: '⌖',
      anim: 'shoot',
      desc: 'A round for 900% damage that goes through two bodies — double into a seam. Then work the bolt: click as the marker crosses the mark to chamber instantly, miss it or let it run off the end and the action jams for 3s.',
      cooldown: 0.2, scalesWithAttackSpeed: true,
      activeReload: { time: 1.25, window: 0.14, cooldown: 3.0 },
      fire(ctx) {
        ctx.hitscan({
          damage: ctx.dmg * 9.0, proc: 1.0, range: 320, color: 0xffb08a,
          tracer: true, thick: 0.07, pierce: 2, weakPoint: true, knockback: 8,
        });
        ctx.recoil(6); ctx.shake(0.4);
      },
    },
    secondary: {
      name: 'Sidearm Revolver', key: 'Q', icon: '🔘',
      anim: 'shoot',
      desc: 'Swing out a heavy revolver for 260% damage. Finish something with it and it holsters free; leave the target standing and it is gone for 10s.',
      cooldown: 10,
      fire(ctx) {
        const hit = ctx.hitscan({
          damage: ctx.dmg * 2.6, proc: 1.0, range: 90, color: 0xffd58a,
          tracer: true, thick: 0.05, weakPoint: true, knockback: 10,
        });
        ctx.recoil(3.4); ctx.shake(0.24);
        // The kill is the reload. A revolver that cleans up costs nothing,
        // which is what makes it a finisher rather than a second primary.
        if (hit?.dead) {
          ctx.refundSecondary();
          ctx.toast('CHAMBER CLEARED', '#ff6a4d');
        }
      },
    },
  },
];

export const WEAPONS_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
export const DEFAULT_WEAPON = 'mk4_sidearm';
export const DEFAULT_UNLOCKED_WEAPONS = WEAPONS.filter((w) => w.unlocked).map((w) => w.id);
export function weaponById(id) { return WEAPONS_BY_ID[id] || WEAPONS_BY_ID[DEFAULT_WEAPON]; }
