/**
 * Character kits.
 *
 * This used to be an arsenal — a list of guns you unlocked, picked up and
 * handed to whoever you happened to be playing. It is not one any more. Every
 * character carries exactly one of these and can carry nothing else, so what
 * each entry actually describes is *how that character fights*: the attack on
 * M1 and the ability on Q. The other three — Shift, R and F — live on the
 * character itself in `data/characters.js`, and the split is only which file
 * they are written in, not what they are.
 *
 * The consequence worth stating: a kit is free to be strange. A weapon that
 * anybody might pick up has to be balanced against everybody's stat line; one
 * that exactly one 200-health character with a shield will ever fire can be
 * built around that character and nothing else. So Bulwark's shotgun is short
 * enough that only a body that can walk into range would carry it, Halcyon's
 * beam has no falloff at all because a bombardier who is never on the ground
 * has to be able to reach the ground, and Wraith's blades pay four times as
 * much at the hilt as at the tip.
 *
 * Damage figures are multipliers of the player's current damage stat, so kits
 * scale automatically with levels and items.
 *
 * Every ability receives a combat context (see systems/combat.js) exposing:
 *   ctx.origin      muzzle position (Vector3)
 *   ctx.dir         normalised aim direction (Vector3)
 *   ctx.aimPoint    world point under the crosshair
 *   ctx.dmg         the player's current damage stat
 *   ctx.spawnBullet(spec) / ctx.hitscan(spec) / ctx.melee(spec) / ctx.shotgun(spec)
 *   ctx.recoil(n) / ctx.shake(n) / ctx.impulse(vec) / ctx.fx
 *
 * `proc` is the proc coefficient — how strongly a hit triggers on-hit items.
 *
 * A kit may also opt into:
 *   scope: { fov, distance, sensitivity }  the camera goes to the eye while
 *                                          aiming, and the HUD draws a lens
 *   randomCrits: false                     crits are never rolled, only earned
 *   critChanceToDamage: n                  crit chance an item grants is read
 *                                          as n× that much crit damage instead
 * and `primary.activeReload: { time, window, cooldown }`, which takes the fire
 * button away after each shot until the reload bar is answered. The Meridian
 * Longrifle is the one kit that carries it.
 *
 * `primary.magazine: { size, time }` is the other kind: a round is spent on
 * every shot, and when the last one goes the weapon stops for `time` seconds
 * flat — no window, nothing to get right, just a hole in your damage the
 * kit's rhythm is priced around.
 *
 * The Q slot understands four shapes, and which one an ability is says most of
 * what it is for:
 *   plain            one press, one cooldown
 *   `charges: n`     n uses on independent timers, like the Shift slot
 *   `charge: t`      held to wind up, released to fire
 *   `sustain: true`  true while the button is down; `onSustain(ctx, on)` is
 *                    told when that changes and `whileHeld(ctx, dt)` runs every
 *                    frame it is. `blocksPrimary` takes M1 away while it holds.
 *
 * `anim` names the body animation an ability plays: 'shoot', 'pump', 'slash',
 * 'swing', 'punch', 'punchL', 'thrust', 'beam' or 'lob'. `animFor(ctx)` is the
 * same thing for an attack whose animation changes shot to shot — a combo that
 * ends on a thrust, a pair of fists that alternate. It is a hint to the rig,
 * not a state machine; see entities/characterRig.js.
 *
 * `model` picks the held object (entities/models.js) and the report it makes
 * (core/audio.js). It is welded into the hand and does not swivel to the
 * crosshair — see `poseWeapon` — so what you see is a character holding a
 * thing, not a character standing beside one.
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
    id: 'siege_gauntlets',
    name: 'Siege Gauntlets',
    icon: '🥊',
    tag: 'Melee · Slow · Heavy',
    color: 0xffb347,
    model: 'fists',
    desc: 'Two demolition drivers worn on the hands. One arm at a time, all the way through, and nothing about the rhythm is negotiable — the suit was built to move freight and it swings like it.',
    lore: 'Rated for load-bearing walls. Nobody wrote down what else.',
    displayStats: { Damage: '340%', 'Punch Rate': '1.6/s', Range: '7m', Proc: '1.0' },
    primary: {
      /* Slow, and slow is the whole of it.
         Every other primary in the game is something you hold down; this one is
         a decision you commit to, and the reason it can hit for three and a
         half times a hit is that you are standing still for two thirds of a
         second afterwards. The arms alternate because a punch thrown twice off
         the same shoulder is a man shadow-boxing, not a man hitting something. */
      name: 'Punch', key: 'M1', icon: '🤜', hold: true,
      animFor: (ctx) => (ctx.combo(2) === 0 ? 'punch' : 'punchL'),
      desc: 'Drive a fist through everything 7m in front for 340% damage, right then left. Slow — this is one punch at a time.',
      cooldown: 0.62, scalesWithAttackSpeed: true,
      fire(ctx) {
        ctx.shockwave({
          damage: ctx.dmg * 3.4, proc: 1.0, range: 7, angle: 0.8,
          knockback: 13, color: 0xffb347,
        });
        ctx.recoil(2.2);
        ctx.shake(0.1);
      },
    },
    secondary: {
      name: 'Down Slam', key: 'Q', icon: '⬇️',
      anim: 'punch',
      desc: 'Drop straight down under full power, cratering for 620% damage in 9m and throwing everything caught away from you.',
      cooldown: 5.0,
      fire(ctx) {
        ctx.downSlam({
          damage: ctx.dmg * 6.2, radius: 9, speed: 58, knockback: 26, color: 0xffd24b,
        });
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'shadow_blades',
    name: 'Shadow Blades',
    icon: '🗡️',
    tag: 'Melee · Proximity',
    color: 0xa15bff,
    model: 'shadowblade',
    desc: 'A matched pair folded out of a collapsed star, one in each hand. They pay for reach in damage and then refuse to sell any of it back: at arm\'s length a cut is worth four times what the same cut is worth at the tip, so a character with 88 health and negative armour has exactly one way to do damage, and it is forward.',
    displayStats: { Damage: '480% → 120%', 'Swing Rate': '2.4/s', Range: '6.5m', Proc: '1.0' },
    primary: {
      name: 'Void Slashes', key: 'M1', icon: '◜', hold: true,
      anim: 'slash',
      desc: 'Cut with one blade and then the other for 480% damage in your face, falling to 120% at the very tip of the reach. Heals you for 7% of everything it takes.',
      cooldown: 0.42, scalesWithAttackSpeed: true,
      fire(ctx) {
        ctx.melee({
          damage: ctx.dmg * 4.8, proc: 1.0, range: 6.5, angle: 1.15,
          lifesteal: 0.07, color: 0xa15bff, tilt: 0.3,
          // 1.0 at the hilt down to 0.25 at the tip. Written as a curve rather
          // than as two numbers so the middle of the swing is worth something
          // specific instead of being whatever a lerp happened to produce.
          rangeScale: (t) => 1 - 0.75 * t * t,
        });
        ctx.recoil(0.9);
      },
    },
    secondary: {
      name: 'Phase', key: 'Q', icon: '🌑',
      desc: 'Step out of the world for 2s: nothing can touch you and nothing can find you. Everything hunting you loses the thread and has to look again.',
      cooldown: 10,
      fire(ctx) {
        ctx.phase({ duration: 2, radius: 30, aggro: 2.4, color: 0xd94bff });
        ctx.toast('PHASE', '#d94bff');
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'breach_shotgun',
    name: 'Breach Shotgun',
    icon: '💥',
    tag: 'Shotgun · Short',
    color: 0xf97316,
    model: 'shotgun',
    desc: 'A short, ugly, eight-round thing carried in the hand that is not holding the plate. It reaches almost nowhere, which is the point: it is the weapon of the one character who can afford to walk all the way in and stand there.',
    displayStats: { Damage: '420% close', Magazine: '8 · 1.8s', Range: '15m', Proc: '1.0' },
    primary: {
      name: 'Shotgun', key: 'M1', icon: '💥', hold: true,
      anim: 'pump',
      desc: 'Nine pellets for 420% damage together at close range, falling to a fifth of that by 15m. Eight in the tube, then a second and a half to fill it.',
      cooldown: 0.72, scalesWithAttackSpeed: true,
      magazine: { size: 8, time: 1.8 },
      fire(ctx) {
        ctx.shotgun({
          pellets: 9, damage: ctx.dmg * 4.2, range: 15, spread: 0.075,
          near: 4, falloff: 0.2, knockback: 5, color: 0xffb066,
        });
        ctx.recoil(3.2);
        ctx.shake(0.16);
      },
    },
    secondary: {
      /* No cooldown, and it does not need one.
         An ability you hold is an ability you are not shooting during, and for
         the character whose damage is already the lowest in the descent that is
         a real price paid continuously. Anything else — a duration, a timer, a
         resource — would be charging twice for the same thing. */
      name: 'Guard', key: 'Q', icon: '🛡️',
      sustain: true, blocksPrimary: true, cooldown: 0,
      desc: 'Hold to put the plate between you and everything: 62% less damage taken for as long as you hold it. You cannot attack behind it, and that is the whole of the price.',
      onSustain(ctx, on) { ctx.guard(on, { reduction: 0.62, color: 0x6fd0ff }); },
      whileHeld(ctx) { ctx.holdGuard({ reduction: 0.62, color: 0x6fd0ff }); },
      fire() {},
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'palm_beam',
    name: 'Palm Beam',
    icon: '🔆',
    tag: 'Beam · Infinite Range',
    color: 0xffffff,
    model: 'beam',
    desc: 'A white line out of the right hand that does not care how far away anything is. No falloff, no travel time, no arc — which is the only kind of weapon that works from four hundred metres up, and the reason the cell is as small as it is.',
    displayStats: { Damage: '62%/tick', 'Tick Rate': '13/s', Magazine: '40 · 1.6s', Range: 'Infinite', Proc: '0.2' },
    primary: {
      name: 'Beam', key: 'M1', icon: '━', hold: true, beam: true,
      anim: 'beam',
      desc: 'A continuous beam for 62% damage a tick at any range at all. Forty in the cell, then a second and a half of nothing.',
      cooldown: 0.075, scalesWithAttackSpeed: true,
      magazine: { size: 40, time: 1.6 },
      fire(ctx) {
        ctx.hitscan({
          damage: ctx.dmg * 0.62, proc: 0.2, range: 500, thick: 0.045,
          color: 0xf2fbff, beam: 0.1, spread: 0,
        });
        ctx.recoil(0.06);
      },
    },
    secondary: {
      name: 'Missile Cluster', key: 'Q', icon: '🚀',
      anim: 'lob',
      desc: 'Fire four small missiles down onto your aim point for 260% damage each in 5m.',
      cooldown: 5.0,
      fire(ctx) {
        ctx.missileCluster({
          count: 4, damage: ctx.dmg * 2.6, radius: 5, scatter: 3.5, color: 0x7fe0ff,
        });
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'black_lance',
    name: 'Black Lance',
    icon: '🔻',
    tag: 'Reach · Combo',
    color: 0x00ffa6,
    model: 'spear',
    desc: 'A long matte haft and a head of contained discharge, and a rhythm three swings long. Two cuts to hold a crowd off the body, then a thrust that goes considerably further than either of them and through whatever it starts on.',
    displayStats: { Damage: '210% · 210% · 380%', 'Rate': '2.9/s', Range: '5.4m → 9m', Proc: '0.8' },
    primary: {
      /* Three hits, and the third is the reason for the first two.
         A combo whose finisher is only bigger is a combo you can ignore; one
         whose finisher is bigger *and reaches four metres further* changes
         where you are standing, which is the one thing this character's whole
         kit is about. */
      name: 'Lance', key: 'M1', icon: '↑', hold: true,
      animFor: (ctx) => (ctx.comboPeek(3) === 2 ? 'thrust' : 'slash'),
      desc: 'Two cuts across everything within 5.4m for 210% each, then a thrust that goes 9m out and through three bodies for 380%.',
      cooldown: 0.34, scalesWithAttackSpeed: true,
      fire(ctx) {
        const step = ctx.combo(3);
        if (step < 2) {
          ctx.melee({
            damage: ctx.dmg * 2.1, proc: 0.8, range: 5.4, angle: 1.25,
            color: 0x00ffa6, tilt: 0.2,
          });
          ctx.recoil(0.9);
          return;
        }
        ctx.hitscan({
          damage: ctx.dmg * 3.8, proc: 0.8, range: 9, thick: 0.42,
          color: 0x3dffa5, pierce: 3, beam: 0.09, spread: 0, knockback: 7,
        });
        ctx.recoil(2.2);
        ctx.shake(0.14);
      },
    },
    secondary: {
      /* Half a second, and nothing happens during it.
         An ability that does something while it waits is one you press on
         cooldown; one that does nothing at all is a read. Ten seconds is the
         price of being wrong, and getting the dash back is what makes being
         right worth the whole rotation. */
      name: 'Parry', key: 'Q', icon: '⟠',
      desc: 'A 0.5s window. Anything that lands in it does nothing at all and comes back at whoever threw it for 300%, and your dash is handed straight back.',
      cooldown: 10,
      fire(ctx) {
        ctx.parry({ window: 0.5, reflect: 3.0, range: 22, iframes: 0.35, color: 0x3dffa5 });
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'chain_hat',
    name: 'Chain Hat',
    icon: '👒',
    tag: 'Melee · Reach',
    color: 0xff5a4d,
    model: 'chainhat',
    desc: 'A length of iron with the other hat on the end of it. Swung rather than thrown, so it does not chain and does not come back — it is simply the longest thing a man in a robe can hit you with, and that turns out to be quite long.',
    displayStats: { Damage: '300%', 'Swing Rate': '2/s', Range: '7.5m', Proc: '1.0' },
    primary: {
      name: 'Chain Hat', key: 'M1', icon: '👒', hold: true,
      anim: 'swing',
      desc: 'Swing the chain through everything within 7.5m in front for 300% damage. It does not bounce — that is the other hat.',
      cooldown: 0.5, scalesWithAttackSpeed: true,
      fire(ctx) {
        ctx.melee({
          damage: ctx.dmg * 3.0, proc: 1.0, range: 7.5, angle: 1.05,
          color: 0xff5a4d, tilt: 0.24, knockback: 6,
        });
        ctx.recoil(1.4);
      },
    },
    secondary: {
      name: 'Chain Pull', key: 'Q', icon: '⛓️',
      anim: 'lob',
      desc: 'Throw the chain at something for 180% and winch it in. Whatever it catches arrives at your feet, which is where the swing is.',
      cooldown: 5.0,
      fire(ctx) {
        ctx.chainPull({
          damage: ctx.dmg * 1.8, speed: 72, pullTime: 0.8, pullSpeed: 42, color: 0xff5a4d,
        });
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'ember_scattergun',
    name: 'Ember Scatter',
    icon: '🔥',
    tag: 'Scatter · Projectile',
    color: 0xff7a2a,
    model: 'fists',
    desc: 'Not a gun. A palmful of burning shot thrown out of the hand, seven pieces at a time — devastating against something standing on your boots, and still worth firing at a body across the arena, which is not a thing a shotgun normally gets to be.',
    displayStats: { Damage: '400% close · 180% far', 'Rate': '2.4/s', Range: '34m', Proc: '0.9' },
    primary: {
      name: 'Scatter Shot', key: 'M1', icon: '✳️', hold: true,
      anim: 'shoot',
      desc: 'Seven embers in a cone for 400% damage together up close, keeping 45% of it all the way out to 34m.',
      cooldown: 0.42, scalesWithAttackSpeed: true,
      fire(ctx) {
        const pellets = 7;
        for (let i = 0; i < pellets; i++) {
          ctx.spawnBullet({
            speed: 96, damage: (ctx.dmg * 4.0) / pellets, proc: 0.9 / pellets,
            radius: 0.26, life: 0.42, color: 0xff9a3a, gravity: 0, spread: 0.075,
            glow: 1.8, trail: 0.5, knockback: 2,
            // Still worth firing from a distance, and never as good as being
            // in somebody's face — which is the whole shape of the character.
            falloff: { near: 7, far: 34, min: 0.45 },
          });
        }
        ctx.fx.muzzle(ctx.origin, ctx.dir, 0xff7a2a, 2.2);
        ctx.recoil(1.8);
      },
    },
    secondary: {
      name: 'Fire Patch', key: 'Q', icon: '🔥',
      anim: 'lob',
      charges: 3,
      desc: 'Throw fire onto the ground where you are looking. Everything standing in the circle burns for 55% a second and keeps burning after it leaves. Three charges, three seconds each — and everything you land a slam on goes up.',
      cooldown: 3.0,
      fire(ctx) {
        ctx.firePatch({
          radius: 4.2, duration: 6, dps: ctx.dmg * 0.55, burn: ctx.dmg * 0.3,
          speed: 42, color: 0xff7a2a,
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
export function weaponById(id) { return WEAPONS_BY_ID[id] || WEAPONS_BY_ID[DEFAULT_WEAPON]; }
