/**
 * Playable characters.
 *
 * A character is five buttons and a thing that is always true about them.
 *
 *   M1     the attack, in `data/weapons.js` as the character's kit
 *   Q      an ability, in the same place and for the same reason
 *   Shift  `utility` — how they move
 *   R      `special` — what they commit to
 *   F      `ultimate` — what they have earned
 *   —      `passive`, which is not a button at all
 *
 * The split between this file and `weapons.js` is historical and nothing more:
 * a kit belongs to exactly one character and no character can carry another's.
 * What used to be a shared arsenal — pick a gun, hand it to anyone — is gone,
 * because a weapon anybody can hold says nothing about whoever is holding it.
 *
 * The **passive** is the newest of the six and the one that does the most work
 * per line. It is a sentence about the character that is true whether or not
 * you press anything: Dasher is more dangerous the closer he is to dying,
 * Halcyon is faster the higher he is, Unloader hits harder the faster he was
 * already going. Each is a hook rather than a number — `damageMult`,
 * `moveMult`, `onDamaged`, `onHatHit` — read at the moment it applies, so a
 * passive can depend on things a stat block cannot see.
 *
 * The **ultimate** is not on a cooldown. It is bought with a charge meter that
 * fills from damage dealt, from kills and from damage taken (see `ULTIMATE` in
 * core/config.js), so it is the one ability the game hands you for having been
 * in a fight rather than for having waited. They are deliberately,
 * unapologetically enormous.
 *
 * Ability `fire` receives the same combat context kits use, plus the
 * character-specific helpers documented in systems/combat.js.
 *
 * Two other flags exist and both are about what is in the hands.
 * `emptyHanded` says this character holds nothing, so no model is attached to
 * the mount and shots leave the palm. `aimWeapon` says the weapon swivels onto
 * the crosshair independently of the arm holding it — every other character's
 * weapon is welded into the hand and moves only because the hand does, which is
 * what makes it read as theirs. Exactly one character sets it, and it is the
 * one whose entire identity is a line from an optic to a body.
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
    /* Standard issue for the standard soldier. The weapon every other one is measured against, in the hands of the character every other one is tuned against. */
    weapon: 'mk4_sidearm',
    stats: {
      health: 115, healthPerLevel: 33, regen: 1.0, regenPerLevel: 0.2,
      damage: 12, damagePerLevel: 2.4, moveSpeed: 8.2, armor: 0, crit: 0.01, jumps: 1,
    },
    passive: {
      /* The baseline's passive has to be the absence of a condition.
       *
       * Every other one in the roster is a *situation*: be nearly dead, be high
       * up, be moving fast, be close, be standing on your own fire. That is
       * what makes them characters. Vanguard is the character the others are
       * tuned against, so handing him a condition to play around would make him
       * one of them and leave nothing at the centre for the rest to be measured
       * from — and picking a weak condition would just make him worse.
       *
       * So the answer is the one thing that is true of a trooper trained on all
       * of it and specialised in none: every button comes back sooner. No
       * window to hit, no threshold to watch, no setup. It applies to the
       * ultimate as well, because the meter *is* that ability's cooldown, and a
       * passive about cooldowns that stopped at four of the five buttons would
       * be a rule with a hole in it.
       */
      name: 'Standard Issue', icon: '📋',
      desc: 'Every ability comes back 20% faster, and the ultimate meter fills 20% quicker. No condition, no window, no setup.',
      cooldownMult: () => 0.8,
      ultimateMult: () => 1.2,
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
    color: 0x3a4048, accent: 0xfdb515, visor: 0xf29c11,
    desc: 'Industrial exosuit with a cargo grapple welded to one arm and far too much power routed to the other. Grapple in, hit something very hard, repeat.',
    lore: 'The suit was built to move freight. Nobody specified how fast.',
    /* The suit's own fists. A cargo handler does not carry a gun; the punch *is* the weapon, and it is the only one that keeps up with the grapple. */
    weapon: 'siege_gauntlets',
    stats: {
      health: 165, healthPerLevel: 46, regen: 1.3, regenPerLevel: 0.26,
      damage: 14, damagePerLevel: 2.8, moveSpeed: 7.1, armor: 8, crit: 0.01, jumps: 1,
    },
    passive: {
      /* The suit is a mass, and a mass has momentum.
         The grapple already existed to build speed and the fist already existed
         to spend it, and this makes the *ordinary punch* do the same thing —
         so the loop is no longer "grapple, use the big one, wait", it is
         "never stop moving". Measured against 30 m/s, which is roughly what a
         grapple leaves you carrying. */
      name: 'Momentum', icon: '🏃',
      desc: 'Deal up to 80% more damage the faster you are moving.',
      damageMult(player) {
        return 1 + Math.min(1, player.speedXZ / 30) * 0.8;
      },
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
    color: 0x1f1b29, accent: 0x7a3ff2, visor: 0xa855f7,
    desc: 'Thin armour, sharpened everything else. Blinks instead of running and pays for its damage in health it does not have.',
    lore: 'Phase-shift trials had a survivor. This is what came back.',
    /* A matched pair, and they pay for reach in damage. Thin armour and 88 health need a weapon that pays some of it back, and one that pays most at arm's length is the only thing that makes walking towards something a plan. */
    weapon: 'shadow_blades',
    stats: {
      health: 88, healthPerLevel: 25, regen: 0.8, regenPerLevel: 0.16,
      damage: 15.5, damagePerLevel: 3.1, moveSpeed: 9.2, armor: -6, crit: 0.12, jumps: 2,
    },
    passive: {
      /* A finisher, and deliberately not a ramp.
         Forty percent is a threshold you can see on a health bar and decide
         about, which is what makes it a passive you play around rather than a
         number that quietly exists. */
      name: 'Executioner', icon: '💀',
      desc: 'Deal 45% more damage to anything at or below 40% health.',
      damageMult(player, enemy) {
        if (!enemy || !enemy.maxHealth) return 1;
        return enemy.health / enemy.maxHealth <= 0.4 ? 1.45 : 1;
      },
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
    color: 0x4a5d73, accent: 0xf97316, visor: 0x8fd0ff,
    desc: 'Walks slowly toward the problem behind a very large plate of metal. Trades reach and speed for the ability to simply not die.',
    lore: 'Issued one shield and one instruction: hold.',
    /* Fifteen metres of reach on the character who walks at seven metres a second. That is not an oversight — a weapon this short is only carryable by a body that can survive the walk, and surviving the walk is the entire character. */
    weapon: 'breach_shotgun',
    stats: {
      health: 200, healthPerLevel: 56, regen: 1.6, regenPerLevel: 0.32,
      damage: 10.5, damagePerLevel: 2.1, moveSpeed: 6.9, armor: 16, crit: 0.01, jumps: 1,
    },
    passive: {
      /* The answer to the one thing armour cannot help with.
         Flat reduction is worth least against exactly the hit that kills you,
         so the passive triggers on size rather than on frequency: chip damage
         does nothing at all, and the boss's wind-up hands you a quarter of a
         health bar back. Twenty seconds so it is once a fight, not once a
         swing. */
      name: 'Overshield', icon: '🔷',
      desc: 'Taking a hit worth 12% of your health grants a barrier worth 25% of it. 20s cooldown.',
      onDamaged(player, dealt) {
        if (player.overshieldTimer > 0) return;
        if (dealt < player.stats.maxHealth * 0.12) return;
        player.overshieldTimer = 20;
        player.grantOvershield(0.25, 'OVERSHIELD', '#8fd0ff');
      },
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
    color: 0xdde5ef, accent: 0x49f7e6, visor: 0x85fff0,
    desc: 'Thrusters where the armour should be. Thin, brittle and a little short on punch — and the only thing in the descent that never has to touch the floor.',
    lore: 'The airframe was salvage. The pilot did not ask what from.',
    /* A white line out of the hand with no falloff and no travel time. Everything else in the arsenal has a range; a character who spends the fight four hundred metres up needs a weapon that does not. */
    weapon: 'palm_beam',
    stats: {
      health: 84, healthPerLevel: 24, regen: 0.9, regenPerLevel: 0.18,
      damage: 10.8, damagePerLevel: 2.15, moveSpeed: 8.6, armor: -10, crit: 0.03, jumps: 2,
    },
    passive: {
      /* Height is already this character's whole answer to having no armour,
         and this makes it the answer to being slow as well: the higher he
         goes the harder he is to hit *and* the faster he crosses the arena.
         Measured off the ground directly under him rather than off sea level,
         so standing on a tower is not the same as flying over one. */
      name: 'Altitude', icon: '📈',
      desc: 'Move up to 55% faster the higher above the ground you are, reaching full speed at 30m.',
      moveMult(player) {
        const ground = player.game.arena?.groundHeightAt(
          player.position.x, player.position.z, player.position.y + 2) ?? 0;
        const height = Math.max(0, player.position.y - ground);
        return 1 + Math.min(1, height / 30) * 0.55;
      },
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
    color: 0x191e26, accent: 0x00ffa6, visor: 0x7ffff0,
    desc: 'A silhouette with almost nothing in it — matte black plate that gives the light back to nobody, wrapped in the discharge it never quite contains. The fastest and hardest-hitting thing in the descent. Paints a crowd with a spear, then travels through it; every dash that lands on paint is a dash you did not spend.',
    lore: 'Armour is weight. Weight is time. Time is the only thing that kills you.',
    /* The spear, and a rhythm three swings long. Reach, no reserve, and a finisher that reaches four metres further than the cuts before it — which is the one weapon whose weakness is exactly the weakness the dash exists to escape. */
    weapon: 'black_lance',
    stats: {
      health: 76, healthPerLevel: 21, regen: 0.8, regenPerLevel: 0.16,
      damage: 17.5, damagePerLevel: 3.5, moveSpeed: 9.8, armor: -8, crit: 0.06, jumps: 1,
    },
    passive: {
      /* Seventy-six health, minus eight armour, and the highest damage stat in
         the descent. The passive does not soften any of that — it doubles down
         on it. A Dasher at a quarter health is the most dangerous thing on the
         field and is one hit from being nothing at all, which is the trade the
         entire character is. */
      name: 'Desperation', icon: '🩸',
      desc: 'Deal up to 85% more damage as your health falls, at its highest when you are nearly dead.',
      damageMult(player) {
        const frac = player.health / Math.max(1, player.stats.maxHealth);
        return 1 + 0.85 * (1 - Math.max(0, Math.min(1, frac)));
      },
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

  /* ------------------------------------------------------------------ */
  {
    id: 'chain',
    name: 'Chain',
    title: 'Wandering Ronin',
    icon: '👒',
    build: 'chain',
    unlocked: false,
    echoCost: 800,
    color: 0x5a473e, accent: 0xc94a4a, visor: 0xffd9b0,
    desc: 'A straw hat, a robe, and no armour worth the name. Owns exactly one thing and throws it at everything — the hat that comes back, the hat that finds the next body, and the hat you left in a field to walk back to later.',
    lore: 'He was told to leave the hat. He left everything else.',
    /* A length of iron with the other hat on the end of it. He owns two things and this is the one he keeps hold of — the swung hat, as against the thrown one. */
    weapon: 'chain_hat',
    stats: {
      health: 104, healthPerLevel: 30, regen: 1.0, regenPerLevel: 0.2,
      damage: 13.2, damagePerLevel: 2.65, moveSpeed: 8.5, armor: 3, crit: 0.04, jumps: 1,
    },
    passive: {
      /* The hat pays for itself, and for everything else.
         Hat Toss ricochets, so a good throw crosses four or five bodies and
         each one is another half-second off all three cooldowns — which turns
         a crowd from a problem into the resource that funds the next throw.
         The ability that most rewards a big crowd is the one that most needs a
         reason to be thrown into one. */
      name: 'Chain Reaction', icon: '🔗',
      desc: 'Every enemy the thrown hat crosses takes 0.6s off all of your cooldowns.',
      onHatHit(combat) { combat.reduceCooldowns(0.6); },
    },
    utility: {
      /* Two presses, one hat, and the clock starts on the second one.
         The throw is not the ability — being somewhere else is. Billing on the
         throw meant a hat left lying in a field was quietly serving its own
         cooldown out there, so a mark set thirty seconds ago recalled for free
         and a mark set two seconds ago could not be used at all, which is
         exactly backwards. `deferCooldown` hands the billing to the ability,
         and it charges on arrival. */
      name: "Wanderer's Mark", key: 'SHIFT', icon: '🧭', cooldown: 5, charges: 1,
      anim: 'lob',
      deferCooldown: true,
      desc: 'Throw the hat at what you are looking at and leave it lying there. Press again to be exactly where it is. The throw is free — the five seconds only start once you have taken the trip. The hat gives up after 30s.',
      fire(ctx) {
        ctx.hatBlink({ speed: 62, life: 30, color: 0xff5a4d });
      },
    },
    special: {
      name: 'Hat Toss', key: 'R', icon: '👒', cooldown: 5,
      anim: 'lob',
      desc: 'Throw the hat for 210%. Find nobody and it simply comes back — but the first body it crosses it ricochets off into the next, and the next, taking 10% more with every bounce. It will come back around for a second cut on anything it has already crossed, so a crowd of three is six bounces.',
      fire(ctx) {
        ctx.throwHat({
          damage: ctx.dmg * 2.1, growth: 0.10, speed: 34, range: 34,
          searchRadius: 18, radius: 1.5, color: 0xff5a4d, source: 'Hat Toss',
        });
      },
    },
    ultimate: {
      name: 'Unbroken Chain', key: 'F', icon: '🌀',
      anim: 'lob',
      desc: 'Throw the hat and do not catch it. For 9s it ricochets without stopping, re-crossing bodies it has already cut, and every single bounce is another 10% — a crowd held together is worth many times what the throw opened at.',
      fire(ctx) {
        ctx.throwHat({
          damage: ctx.dmg * 1.4, growth: 0.10, speed: 46, range: 1e4,
          searchRadius: 26, radius: 1.8, endless: 9, scale: 0.75,
          color: 0xff5a4d, source: 'Unbroken Chain',
        });
        ctx.toast('UNBROKEN CHAIN', '#ff5a4d');
        ctx.shake(0.35);
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'sniper',
    name: 'Sniper',
    title: 'Overwatch',
    icon: '🎯',
    build: 'sniper',
    unlocked: false,
    echoCost: 950,
    color: 0x1f6166, accent: 0xd6a24a, visor: 0x3fe4ff,
    desc: 'A cloak, a bolt gun and a rule: one round, one body. Everything he owns is spent on making the first shot count and on not being where the answer lands — so the whole character is a loop of set up, fire, and be gone before anything has worked out where from.',
    lore: 'The range card in his pocket has nine entries on it. None of them are places.',
    /* The longrifle, and nobody else can hold it. Every other character in the
       descent rolls for crits; this one goes and finds them, which only works
       if the weapon that never rolls is welded to the hands that know where to
       look. */
    weapon: 'meridian_longrifle',
    /* The one weapon that still swivels onto the crosshair on its own.
       Every other character's is fixed in the hand, which is what makes it read
       as theirs — but this one *is* the crosshair. A rifle whose muzzle sits a
       few degrees off the line the round goes down is not a scoped weapon, it
       is a decoration, and the entire character is that line. */
    aimWeapon: true,
    stats: {
      health: 92, healthPerLevel: 26, regen: 0.9, regenPerLevel: 0.18,
      damage: 16.5, damagePerLevel: 3.3, moveSpeed: 8.4, armor: -4, crit: 0.08, jumps: 1,
    },
    passive: {
      /* The exact inverse of Wraith, and deliberately so.
       *
       * Her blades pay four times as much at the hilt as at the tip, which is
       * what makes a body with 88 health walk *towards* things. His rifle pays
       * for the opposite, which is what makes a body with 92 health and
       * negative armour refuse to. Two characters, one axis, opposite ends —
       * and the range card, the cloak and Break Contact all suddenly read as
       * one plan instead of three unrelated tools, because every one of them is
       * about getting back to the distance where the passive lives.
       *
       * Nothing inside ten metres: a sniper with a bonus at knife range is not
       * a sniper. It is worth its full value at sixty, which is about the width
       * of half an arena and further than anything in the game can cross before
       * the bolt is worked.
       */
      name: 'Standoff', icon: '📏',
      desc: 'Deal up to 55% more damage the further away the target is — nothing inside 10m, everything by 60m.',
      damageMult(player, enemy) {
        if (!enemy) return 1;
        const d = player.position.distanceTo(enemy.position);
        return 1 + 0.55 * Math.max(0, Math.min(1, (d - 10) / 50));
      },
    },
    utility: {
      /* The disengage, and it is not a mobility tool.
         Nine metres is barely a roll — what the ability actually buys is three
         seconds of not being a target, which is the only currency a body with
         92 health and negative armour has. Cloaked he moves 40% faster and
         takes 70% less, so it is an escape and a reposition at once, and it is
         priced so you cannot open a fight with it. */
      name: 'Break Contact', key: 'SHIFT', icon: '👁️', cooldown: 8, charges: 1,
      desc: 'Slip 9m and go dark for 3s: 40% more movement speed and 70% less damage taken while nothing can see you.',
      fire(ctx) {
        ctx.dash({ speed: 34, duration: 0.26, iframes: 0.2, color: 0x3fe4ff });
        ctx.addBuff('cloak', 3, 1, 1, '👁️ Break Contact');
        ctx.fx.ring(ctx.player.position, 0.4, 4, 0x3fe4ff, 0.5, 0.7);
      },
    },
    special: {
      name: 'Range Card', key: 'R', icon: '📐', cooldown: 11,
      anim: 'shoot',
      /* What a spotter is for.
         The longrifle already has one way to earn a critical hit and it is a
         plate the size of a fist at three hundred metres. This is the other
         way: call the range on a piece of ground and everything standing in it
         is opened up — armour off, damage up — for long enough to work through
         the whole group one round at a time. */
      desc: 'Range a 16m circle at your aim point. Everything inside is marked for 12s: 45 armour stripped and 25% more damage taken from everyone.',
      fire(ctx) {
        ctx.rangeCard({ radius: 16, duration: 12, armor: 45, vuln: 0.25, color: 0xd6a24a });
      },
    },
    ultimate: {
      name: 'Kill Order', key: 'F', icon: '☠️',
      anim: 'shoot',
      /* An ultimate that is just the weapon, faster and without the aiming.
         Sniper's whole problem is throughput — one round every second and a
         quarter, and a reload you can fail. The order does not add a new gun;
         it takes the two things the gun is short of, rate and certainty, and
         removes them for four seconds. Every round is a seam hit, so every
         point of crit damage the build has bought is spent at once. */
      desc: 'Work down the field: fourteen rounds at 750% each, one every 0.28s, each one a guaranteed critical, put through the biggest thing still standing within 60m. Anything that dies to it hands the next round to whatever is behind it.',
      fire(ctx) {
        ctx.killOrder({
          count: 14, damage: ctx.dmg * 7.5, interval: 0.28, radius: 60, color: 0xff6a4d,
        });
        ctx.toast('KILL ORDER', '#ff6a4d');
      },
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'diver',
    name: 'Diver',
    title: 'Ember Drop',
    icon: '🔥',
    build: 'diver',
    unlocked: false,
    echoCost: 1000,
    color: 0x2c2a2e, accent: 0xff7a2a, visor: 0xffb347,
    desc: 'A drop-suit with the whole budget spent on the pack, and the only thing in the descent that never has to come down. Paints the floor with fire, then arrives on it — the patches are not the damage, they are the ammunition, and the slam is what fires them.',
    lore: 'Everyone else was issued a parachute. He was issued the other half.',
    /* Not a weapon. A palmful of burning shot, which is what you can throw with
       both hands full of nothing — this is the character who carries no gun
       because the pack is already the heaviest thing he is wearing. */
    weapon: 'ember_scattergun',
    /* Both hands empty, and the shot leaves the palm. */
    emptyHanded: true,
    /* The thrusters are not an ability. Halcyon flies on a countdown and pays
       for every second of it; this one simply does not fall unless he decides
       to, which is a different character rather than a better one — he trades
       every ability Halcyon spends on getting airborne for abilities that only
       make sense once you already are. Hold jump to climb, hold nothing and he
       sinks gently enough to fight from the floor and leave again. */
    infiniteFlight: true,
    stats: {
      health: 108, healthPerLevel: 31, regen: 1.0, regenPerLevel: 0.2,
      damage: 14.5, damagePerLevel: 2.9, moveSpeed: 8.4, armor: 0, crit: 0.04, jumps: 1,
    },
    passive: {
      /* The passive is the combo, written down.
         Fire Patch on its own is a mediocre zone; Dive Slam on its own is a
         mediocre nuke. Landing one on the other is worth more than both, which
         means the whole character is a question of whether you set up two
         seconds ago — and a passive is the right place for that, because it is
         true whether or not you remembered to press anything. */
      name: 'Firebomb', icon: '💣',
      desc: 'Landing a slam on your own fire patches detonates them, for far more than the slam alone.',
    },
    utility: {
      name: 'Speed Dash', key: 'SHIFT', icon: '💨', cooldown: 5, charges: 2,
      desc: 'Dash along your line of sight — through the air, which is where you are — and keep 45% movement speed for 5s afterwards.',
      fire(ctx) {
        ctx.speedDash({
          speed: 44, duration: 0.26, iframes: 0.16, pitched: true,
          buffTime: 5, move: 0.45, label: '💨 Speed Dash', color: 0xff7a2a,
        });
      },
    },
    special: {
      name: 'Dive Slam', key: 'R', icon: '⤓', cooldown: 10,
      anim: 'punch',
      desc: 'Drop onto your aim point at fifty metres a second for 560% damage in 9m — and set off every fire patch you land on for 1340% each.',
      fire(ctx) {
        ctx.diveSlam({
          damage: ctx.dmg * 5.6, radius: 9, speed: 52, maxRange: 36,
          knockback: 20, patchRadius: 9, patchDamage: ctx.dmg * 13.4, color: 0xff7a2a,
        });
      },
    },
    ultimate: {
      name: 'Inferno', key: 'F', icon: '🌋',
      desc: 'For 10s everything within 22m of you catches and keeps burning — 150% a pulse twice a second, on top of the burn — and you move 50% faster for the whole of it.',
      fire(ctx) {
        ctx.inferno({
          duration: 10, radius: 22, damage: ctx.dmg * 1.5, burn: ctx.dmg * 0.55,
          interval: 0.5, move: 0.5, burnTime: 6, color: 0xff7a2a,
        });
      },
    },
  },
];

export const CHARACTERS_BY_ID = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));
export const DEFAULT_CHARACTER = 'vanguard';
export const DEFAULT_UNLOCKED_CHARACTERS = CHARACTERS.filter((c) => c.unlocked).map((c) => c.id);
export function characterById(id) { return CHARACTERS_BY_ID[id] || CHARACTERS_BY_ID[DEFAULT_CHARACTER]; }
