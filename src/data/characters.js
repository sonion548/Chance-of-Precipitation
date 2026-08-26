/**
 * Playable characters.
 *
 * A character supplies base stats, a model build, and three signature abilities:
 * a **utility** on Shift (replacing the generic dash), a **special** on R, and
 * an **ultimate** on F. Weapons remain independent and cover primary (M1) and
 * secondary (Q), so a character defines how you move and commit, while the
 * weapon defines how you shoot.
 *
 * The ultimate is not on a cooldown. It is bought with a charge meter that
 * fills from kills and from damage taken (see `ULTIMATE` in core/config.js), so
 * it is the one ability the game hands you for having been in a fight rather
 * than for having waited. They are deliberately, unapologetically enormous.
 *
 * Ability `fire` receives the same combat context weapons use, plus the
 * character-specific helpers documented in systems/combat.js.
 */

export const CHARACTERS = [
  /* ------------------------------------------------------------------ */
  {
    id: 'vanguard',
    name: 'Vanguard',
    title: 'Line Trooper',
    icon: '🛡️',
    build: 'vanguard',
    unlocked: true,
    echoCost: 0,
    color: 0x4c5a72, accent: 0xffb347, visor: 0x46e0c0,
    desc: 'Standard issue and deliberately unremarkable. Good health, good speed, no sharp edges — the baseline every other character is tuned against.',
    lore: 'Whoever they were before the descent, they were trained for this.',
    stats: {
      health: 115, healthPerLevel: 33, regen: 1.0, regenPerLevel: 0.2,
      damage: 12, damagePerLevel: 2.4, moveSpeed: 8.2, armor: 0, crit: 0.01, jumps: 1,
    },
    utility: {
      name: 'Combat Roll', key: 'SHIFT', icon: '⇢', cooldown: 3.0, charges: 1,
      desc: 'Roll a short distance with brief invulnerability.',
      // The baseline roll, verbatim from PLAYER — Vanguard is the character the
      // others are tuned against, so it takes the numbers rather than restating them.
      fire(ctx) { ctx.dash(); },
    },
    special: {
      name: 'Overclock', key: 'R', icon: '⚡', cooldown: 18,
      desc: 'For 8s, gain 60% attack speed and 25% movement speed.',
      fire(ctx) {
        ctx.addBuff('warcry', 8, 0.6, 1, '⚡ Overclocked', { move: 0.25 });
        ctx.fx.ring(ctx.player.position, 0.5, 6, 0xffb347, 0.6, 0.9);
        ctx.toast('OVERCLOCK', '#ffb347');
      },
    },
    ultimate: {
      name: 'Fire Mission', key: 'F', icon: '☄️',
      anim: 'lob',
      desc: 'Paint the ground and call in 26 shells for 420% damage each, then run hot: 120% attack speed and 50% movement for 12s.',
      fire(ctx) {
        ctx.mortarStorm({
          count: 26, spread: 17, damage: ctx.dmg * 4.2, radius: 8, interval: 0.09, color: 0xffb347,
        });
        ctx.addBuff('warcry', 12, 1.2, 1, '☄️ Fire Mission', { move: 0.5 });
        ctx.fx.ring(ctx.player.position, 1, 14, 0xffb347, 0.8, 1);
        ctx.shake(0.5);
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'unloader',
    name: 'Unloader',
    title: 'Cargo Handler',
    icon: '🤜',
    build: 'unloader',
    unlocked: false,
    echoCost: 600,
    color: 0xd08a3a, accent: 0xffd24b, visor: 0xff9a3a,
    desc: 'Industrial exosuit with a cargo grapple welded to one arm and far too much power routed to the other. Grapple in, hit something very hard, repeat.',
    lore: 'The suit was built to move freight. Nobody specified how fast.',
    stats: {
      health: 165, healthPerLevel: 46, regen: 1.3, regenPerLevel: 0.26,
      damage: 14, damagePerLevel: 2.8, moveSpeed: 7.1, armor: 8, crit: 0.01, jumps: 1,
    },
    utility: {
      name: 'Grapple Gun', key: 'SHIFT', icon: '🪝', cooldown: 4.5, charges: 2,
      anim: 'thrust',
      desc: 'Fire a cargo hook. Anchors to terrain or enemies and reels you in fast, building the speed that powers your fist.',
      fire(ctx) {
        ctx.fireGrapple({ range: 46, pullSpeed: 40, damage: ctx.dmg * 1.6, color: 0xffd24b });
      },
    },
    special: {
      name: 'Overcharged Fist', key: 'R', icon: '🤜', cooldown: 5.5,
      anim: 'punch',
      desc: 'Detonate a colossal punch and launch yourself through it, cutting down anything in the way. Damage and distance both scale with how fast you were already moving — up to 1800% at full tilt.',
      fire(ctx) {
        ctx.momentumPunch({
          baseDamage: ctx.dmg * 4.5, maxDamage: ctx.dmg * 18, radius: 9,
          reference: 30, knockback: 30, color: 0xffd24b,
          dashSpeed: 32, dashTime: 0.24, sweepFraction: 0.45,
        });
      },
    },
    ultimate: {
      name: 'Terminal Velocity', key: 'F', icon: '💥',
      anim: 'punch',
      desc: 'Launch skyward, then come down on the aim point for 2600% damage in 20m — and four aftershocks that finish what the crater started.',
      fire(ctx) {
        ctx.meteorSlam({
          damage: ctx.dmg * 26, radius: 20, riseSpeed: 26, aftershocks: 4,
          aftershockDamage: ctx.dmg * 6, knockback: 42, color: 0xffd24b,
        });
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'wraith',
    name: 'Wraith',
    title: 'Phase Operative',
    icon: '🌑',
    build: 'wraith',
    unlocked: false,
    echoCost: 750,
    color: 0x3a2c54, accent: 0xd94bff, visor: 0xff6ad0,
    desc: 'Thin armour, sharpened everything else. Blinks instead of running and pays for its damage in health it does not have.',
    lore: 'Phase-shift trials had a survivor. This is what came back.',
    stats: {
      health: 88, healthPerLevel: 25, regen: 0.8, regenPerLevel: 0.16,
      damage: 15.5, damagePerLevel: 3.1, moveSpeed: 9.2, armor: -6, crit: 0.12, jumps: 2,
    },
    utility: {
      name: 'Blink', key: 'SHIFT', icon: '⟿', cooldown: 3.4, charges: 2,
      desc: 'Phase 13m the way you are moving — through the air if you are in it — leaving an afterimage that detonates for 320% damage.',
      fire(ctx) {
        ctx.blink({ distance: 13, damage: ctx.dmg * 3.2, radius: 4.5, color: 0xd94bff });
      },
    },
    special: {
      name: 'Umbral Volley', key: 'R', icon: '✦', cooldown: 11,
      desc: 'Release 9 homing shades that seek nearby enemies for 200% damage each.',
      fire(ctx) {
        ctx.homingVolley({ count: 9, damage: ctx.dmg * 2.0, color: 0xd94bff, spread: 1.1 });
        ctx.fx.ring(ctx.player.position, 0.5, 7, 0xd94bff, 0.6, 0.9);
      },
    },
    ultimate: {
      name: 'Event Horizon', key: 'F', icon: '🕳️',
      desc: 'Tear three singularities open around your aim, hurl 30 shades into them, and phase out: 6s of 70% damage reduction and 40% more speed.',
      fire(ctx) {
        ctx.voidStorm({
          singularities: 3, singularityDamage: ctx.dmg * 9, radius: 13,
          shades: 30, shadeDamage: ctx.dmg * 2.4, color: 0xd94bff,
        });
        ctx.addBuff('cloak', 6, 1, 1, '🕳️ Event Horizon');
        ctx.toast('EVENT HORIZON', '#d94bff');
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'bulwark',
    name: 'Bulwark',
    title: 'Breach Warden',
    icon: '🧱',
    build: 'bulwark',
    unlocked: false,
    echoCost: 700,
    color: 0x46607a, accent: 0x6fd0ff, visor: 0x9fe8ff,
    desc: 'Walks slowly toward the problem behind a very large plate of metal. Trades reach and speed for the ability to simply not die.',
    lore: 'Issued one shield and one instruction: hold.',
    stats: {
      health: 200, healthPerLevel: 56, regen: 1.6, regenPerLevel: 0.32,
      damage: 10.5, damagePerLevel: 2.1, moveSpeed: 6.9, armor: 16, crit: 0.01, jumps: 1,
    },
    utility: {
      name: 'Shield Charge', key: 'SHIFT', icon: '🛡️', cooldown: 5.0, charges: 1,
      desc: 'Charge forward behind your plate, shoving enemies aside for 260% damage and gaining a barrier.',
      fire(ctx) {
        ctx.shieldCharge({ speed: 30, duration: 0.42, damage: ctx.dmg * 2.6, radius: 3.2, barrier: 0.18, color: 0x6fd0ff });
      },
    },
    special: {
      name: 'Bastion', key: 'R', icon: '⬢', cooldown: 20,
      desc: 'Plant a bastion field for 8s: 45% damage reduction, a barrier worth 40% of your health, and enemies inside are chilled.',
      fire(ctx) {
        ctx.bastion({ duration: 8, radius: 12, reduction: 0.45, barrier: 0.4, color: 0x6fd0ff });
      },
    },
    ultimate: {
      name: 'Last Stand', key: 'F', icon: '🛡️',
      desc: 'Become untouchable for 6s. Every half-second the plate discharges for 380% damage in 18m, and the shockwaves shove everything out of the ring.',
      fire(ctx) {
        ctx.lastStand({
          duration: 6, radius: 18, interval: 0.5, damage: ctx.dmg * 3.8,
          knockback: 20, barrier: 1.0, color: 0x6fd0ff,
        });
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'halcyon',
    name: 'Halcyon',
    title: 'Aerial Bombardier',
    icon: '🕊️',
    build: 'halcyon',
    unlocked: false,
    echoCost: 900,
    color: 0x2f5d78, accent: 0x7fe0ff, visor: 0xd8f4ff,
    desc: 'Thrusters where the armour should be. Thin, brittle and a little short on punch — and the only thing in the descent that never has to touch the floor.',
    lore: 'The airframe was salvage. The pilot did not ask what from.',
    stats: {
      health: 84, healthPerLevel: 24, regen: 0.9, regenPerLevel: 0.18,
      damage: 10.8, damagePerLevel: 2.15, moveSpeed: 8.6, armor: -10, crit: 0.03, jumps: 2,
    },
    utility: {
      name: 'Thruster Flight', key: 'SHIFT', icon: '🕊️', cooldown: 9, charges: 1,
      desc: 'Ignite the thrusters and fly for 7s — hold Space to climb, release to drift down. Gravity does not apply and you keep full control. Touching down ends it early and refunds half the unused time.',
      fire(ctx) {
        ctx.flight({ duration: 7, riseSpeed: 11, hoverSpeed: -1.4, speedMult: 1.15, color: 0x7fe0ff });
      },
    },
    special: {
      name: 'Bomb Cluster', key: 'R', icon: '💣', cooldown: 3.2,
      anim: 'lob',
      desc: 'Shoot a cluster of three bombs that detonate on impact for 340% damage in 7m. Under Ordnance Override it becomes a single bunker charge dropped straight down for 700% in 16m, every half second, for as long as the override holds.',
      /* The rack is the same rack; the override just takes the limiter off it.
         Returning the *final* number rather than a multiplier is deliberate —
         half a second is the arming time of the bomb, not a cooldown, and it
         should not shrink because somebody picked up a cooldown item. */
      cooldownFor: (player, base) => (player.buffs.has('bombardier') ? 0.5 : base),
      fire(ctx) {
        if (ctx.player.buffs.has('bombardier')) {
          ctx.bunkerBomb({ damage: ctx.dmg * 7, radius: 16, color: 0x7fe0ff });
          return;
        }
        ctx.bombVolley({ count: 3, damage: ctx.dmg * 3.4, radius: 7, speed: 44, spread: 0.09, color: 0x7fe0ff });
      },
    },
    ultimate: {
      name: 'Ordnance Override', key: 'F', icon: '🛩️',
      /* An ultimate that hands you no new button.
         Halcyon already owns the two things the override touches — the
         thrusters and the rack — and both of them are rationed. Taking the
         ration away for fifteen seconds is a bigger ability than any single
         enormous explosion would have been, because for those fifteen seconds
         the character finally gets to be the thing the silhouette promises:
         airborne, indefinitely, dropping ordnance on a timer. */
      desc: 'Cut the limiters for 15s. Flight stops burning fuel and landing no longer ends it, and the bomb rack unlocks: Bomb Cluster becomes one bunker charge dropped straight down for 700% damage in 16m, on nothing but a half-second arming delay.',
      fire(ctx) {
        ctx.ordnanceOverride({ duration: 15, color: 0x7fe0ff });
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'dasher',
    name: 'Dasher',
    title: 'Skirmish Lancer',
    icon: '➤',
    build: 'dasher',
    unlocked: false,
    echoCost: 850,
    color: 0x2d4a3e, accent: 0x3dffa5, visor: 0xc8ffe6,
    desc: 'The fastest and hardest-hitting thing in the descent, wrapped in almost nothing. Paints a crowd with a spear, then travels through it — every dash that lands on paint is a dash you did not spend.',
    lore: 'Armour is weight. Weight is time. Time is the only thing that kills you.',
    stats: {
      health: 76, healthPerLevel: 21, regen: 0.8, regenPerLevel: 0.16,
      damage: 17.5, damagePerLevel: 3.5, moveSpeed: 9.8, armor: -8, crit: 0.06, jumps: 1,
    },
    utility: {
      /* Ten seconds, and the mark is how you get out of paying it.
         A cheap dash that refunds itself on a hit is just a dash — you take it
         on cooldown and the mark is a bonus you sometimes notice. Priced this
         high, the refund *is* the ability: land it on something painted and you
         keep moving, miss and you are walking for ten seconds. The spear stops
         being setup and starts being the thing that keeps the dash alive. */
      name: 'Lance Dash', key: 'SHIFT', icon: '➤', cooldown: 10, charges: 1,
      anim: 'thrust',
      desc: 'Dash along your line of sight — up a wall, down a drop, straight through a crowd — cutting everything on the way for 420% damage. Ten second cooldown, and landing it on a marked enemy hands the whole thing back.',
      fire(ctx) {
        ctx.markDash({
          speed: 52, duration: 0.28, damage: ctx.dmg * 4.2, radius: 2.6,
          iframes: 0.18, color: 0x3dffa5,
        });
      },
    },
    special: {
      name: 'Marking Spear', key: 'R', icon: '🔱', cooldown: 3, charges: 2,
      anim: 'lob',
      desc: 'Throw a spear that lands for 70% damage and marks everything within 15m for 10s. Two charges — the dash eats marks faster than one throw can paint them.',
      fire(ctx) {
        ctx.markSpear({
          radius: 15, duration: 10, speed: 78, damage: ctx.dmg * 0.7, color: 0x3dffa5,
        });
      },
    },
    ultimate: {
      name: 'Skewer', key: 'F', icon: '🗡️',
      anim: 'lob',
      desc: 'Hurl a great spear at your aim point: 900% damage in 22m, everything caught is marked for 14s and dragged onto the shaft — and you bank three dashes that cost nothing at all.',
      fire(ctx) {
        ctx.greatSpear({
          radius: 22, damage: ctx.dmg * 9, markDuration: 14, speed: 74,
          pull: { time: 1.1, speed: 30 }, dashResets: 3, color: 0x3dffa5,
        });
      },
    },
  },
];

export const CHARACTERS_BY_ID = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));
export const DEFAULT_CHARACTER = 'vanguard';
export const DEFAULT_UNLOCKED_CHARACTERS = CHARACTERS.filter((c) => c.unlocked).map((c) => c.id);
export function characterById(id) { return CHARACTERS_BY_ID[id] || CHARACTERS_BY_ID[DEFAULT_CHARACTER]; }
