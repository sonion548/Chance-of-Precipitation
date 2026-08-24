/**
 * Playable characters.
 *
 * A character supplies base stats, a model build, and two signature abilities:
 * a **utility** on Shift (replacing the generic dash) and a **special** on R.
 * Weapons remain independent and cover primary (M1) and secondary (Q), so a
 * character defines how you move and commit, while the weapon defines how you
 * shoot.
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
      fire(ctx) { ctx.dash({ speed: 26, duration: 0.2, iframes: 0.16 }); },
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
      desc: 'Fire a cargo hook. Anchors to terrain or enemies and reels you in fast, building the speed that powers your fist.',
      fire(ctx) {
        ctx.fireGrapple({ range: 46, pullSpeed: 40, damage: ctx.dmg * 1.6, color: 0xffd24b });
      },
    },
    special: {
      name: 'Overcharged Fist', key: 'R', icon: '🤜', cooldown: 5.5,
      desc: 'A colossal punch. Damage scales with how fast you are moving — up to 1800% at full tilt — and detonates in a shockwave.',
      fire(ctx) {
        ctx.momentumPunch({
          baseDamage: ctx.dmg * 4.5, maxDamage: ctx.dmg * 18, radius: 9,
          reference: 30, knockback: 30, color: 0xffd24b,
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
  },
];

export const CHARACTERS_BY_ID = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));
export const DEFAULT_CHARACTER = 'vanguard';
export const DEFAULT_UNLOCKED_CHARACTERS = CHARACTERS.filter((c) => c.unlocked).map((c) => c.id);
export function characterById(id) { return CHARACTERS_BY_ID[id] || CHARACTERS_BY_ID[DEFAULT_CHARACTER]; }
