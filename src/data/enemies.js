/**
 * Bestiary. `cost` is what the director pays in credits to spawn one; health and
 * damage are base values before the difficulty coefficient is applied.
 *
 * A guardian pays out a little under half what it used to. It was never the
 * fight that funded a run — the trash between beacons is — and a boss worth
 * five or six chests on its own meant the stage-clear moment handed you a
 * shopping trip you had not earned anywhere else. The item drop is the reward
 * for killing a boss; the gold is a tip. XP is untouched: the levels were never
 * the problem.
 */

export const ENEMIES = [
  {
    id: 'husk', name: 'Husk', cost: 10, weight: 100,
    health: 60, damage: 9, speed: 5.6, radius: 0.55, height: 1.8,
    xp: 8, gold: 5, color: 0x8a5a4a, accent: 0xff6a4a, model: 'husk',
    ai: 'melee', attackRange: 2.3, attackCooldown: 1.15, windup: 0.35, knockbackResist: 0,
    lore: 'A body kept moving by something that is not quite alive. Fast, fragile, and never alone.',
    minStage: 1,
  },
  {
    id: 'spitter', name: 'Spitter', cost: 22, weight: 78,
    health: 78, damage: 13, speed: 4.0, radius: 0.6, height: 1.7,
    xp: 14, gold: 9, color: 0x5a7a4a, accent: 0x9fe04a, model: 'spitter',
    ai: 'ranged', attackRange: 26, preferredRange: 17, attackCooldown: 2.1, windup: 0.55,
    projectile: { speed: 26, radius: 0.34, gravity: -9, color: 0x9fe04a, splash: 3.2 },
    knockbackResist: 0.15,
    lore: 'Lobs an acidic sac in a lazy arc. The arc is the only warning you get.',
    minStage: 1,
  },
  {
    id: 'skimmer', name: 'Skimmer', cost: 28, weight: 62,
    health: 66, damage: 8, speed: 7.4, radius: 0.62, height: 1.3,
    xp: 16, gold: 10, color: 0x4a6a8a, accent: 0x6fd0ff, model: 'skimmer',
    ai: 'flyer', attackRange: 22, preferredRange: 14, attackCooldown: 1.9, windup: 0.55,
    flyHeight: 6.5, projectile: { speed: 40, radius: 0.24, gravity: 0, color: 0x6fd0ff },
    knockbackResist: 0,
    lore: 'Hovers just out of comfortable reach and fires in bursts. Ignores your careful use of cover.',
    minStage: 1,
  },
  {
    id: 'charger', name: 'Charger', cost: 40, weight: 55,
    health: 165, damage: 21, speed: 5.2, radius: 0.72, height: 2.0,
    xp: 26, gold: 16, color: 0x7a4a5a, accent: 0xff4a7a, model: 'charger',
    ai: 'charger', attackRange: 22, attackCooldown: 3.4, windup: 0.8, chargeSpeed: 26, chargeDuration: 1.1,
    knockbackResist: 0.4,
    lore: 'Locks on, plants its feet, and converts the intervening distance into a problem.',
    minStage: 1,
  },
  {
    id: 'brute', name: 'Brute', cost: 68, weight: 42,
    health: 420, damage: 34, speed: 3.5, radius: 1.05, height: 2.9,
    xp: 52, gold: 30, color: 0x6a5a3a, accent: 0xffb347, model: 'brute',
    ai: 'melee', attackRange: 4.2, attackCooldown: 2.2, windup: 0.75, slamRadius: 5.5,
    knockbackResist: 0.75,
    lore: 'Slow enough to outrun, heavy enough that outrunning it is the only option early on.',
    minStage: 2,
  },
  {
    id: 'warden', name: 'Warden', cost: 96, weight: 30,
    health: 340, damage: 26, speed: 3.8, radius: 0.85, height: 2.5,
    xp: 70, gold: 42, color: 0x4a4a7a, accent: 0xb473ff, model: 'warden',
    ai: 'artillery', attackRange: 40, preferredRange: 27, attackCooldown: 3.6, windup: 1.1, volley: 3,
    projectile: { speed: 34, radius: 0.4, gravity: -12, color: 0xb473ff, splash: 5.5, homing: 0.9 },
    knockbackResist: 0.6,
    lore: 'Ranks its shots. The first one is a question; the next two are the answer.',
    minStage: 2,
  },
  {
    id: 'lancer', name: 'Void Lancer', cost: 120, weight: 24,
    health: 300, damage: 30, speed: 7.4, radius: 0.6, height: 2.1,
    xp: 84, gold: 50, color: 0x3a2a5a, accent: 0xd94bff, model: 'lancer',
    ai: 'flyer', attackRange: 34, preferredRange: 21, attackCooldown: 2.3, windup: 0.75,
    flyHeight: 8, projectile: { speed: 62, radius: 0.22, gravity: 0, color: 0xd94bff, pierce: true },
    knockbackResist: 0.3,
    lore: 'Fires a hairline beam that does not care what is between you and it.',
    minStage: 3,
  },
];

export const BOSSES = [
  {
    id: 'colossus', name: 'The Colossus', cost: 0, boss: true,
    health: 2600, damage: 40, speed: 3.4, radius: 2.3, height: 6.0,
    xp: 480, gold: 145, color: 0x5a4a3a, accent: 0xffb347, model: 'colossus',
    ai: 'boss_colossus', attackRange: 8, attackCooldown: 2.6, windup: 0.9, slamRadius: 12,
    knockbackResist: 1, guaranteedDrop: true,
    lore: 'The basin grew a guardian out of its own rubble. It has never had to move quickly.',
  },
  {
    id: 'leviathan', name: 'Ashen Leviathan', cost: 0, boss: true,
    health: 2300, damage: 34, speed: 6.2, radius: 1.8, height: 4.2,
    xp: 460, gold: 140, color: 0x3a5a6a, accent: 0x6fd0ff, model: 'leviathan',
    ai: 'boss_leviathan', attackRange: 34, preferredRange: 20, attackCooldown: 2.2, windup: 0.6,
    flyHeight: 9, volley: 5,
    projectile: { speed: 48, radius: 0.35, gravity: 0, color: 0x6fd0ff, splash: 4 },
    knockbackResist: 1, guaranteedDrop: true,
    lore: 'Circles the arena in long, patient arcs, painting the ground with cold fire.',
  },
  {
    id: 'harbinger', name: 'Void Harbinger', cost: 0, boss: true,
    health: 3100, damage: 46, speed: 5.0, radius: 1.6, height: 4.6,
    xp: 560, gold: 165, color: 0x2a1a4a, accent: 0xd94bff, model: 'harbinger',
    ai: 'boss_harbinger', attackRange: 30, preferredRange: 14, attackCooldown: 2.0, windup: 0.5,
    flying: true, flyHeight: 6,
    knockbackResist: 1, guaranteedDrop: true,
    lore: 'It teleports, it summons, and it is aware that you are the anomaly here.',
  },

  /* ----------------------------------------------------------------------
     The second three.
     ----------------------------------------------------------------------
     Three bosses was one per stage in a fixed rotation, so by your fourth run
     you knew what was coming before the Beacon finished charging. These are
     built to be *different problems* rather than more health bars: one you
     cannot hit for half the fight, one that punishes standing still, and one
     that cannot be hurt until you deal with what it brought.
  */
  {
    id: 'thornmaw', name: 'Thornmaw', cost: 0, boss: true,
    health: 2800, damage: 38, speed: 5.6, radius: 2.0, height: 4.4,
    xp: 500, gold: 150, color: 0x4a5a32, accent: 0xc8e04b, model: 'thornmaw',
    ai: 'boss_thornmaw', attackRange: 9, attackCooldown: 2.4, windup: 0.7,
    burrowTime: 4.5, surfaceTime: 9.0, eruptRadius: 9,
    knockbackResist: 1, guaranteedDrop: true,
    lore: 'It does not chase you across the ground. It chases you through it.',
  },
  {
    id: 'fulgurant', name: 'The Fulgurant', cost: 0, boss: true,
    health: 2500, damage: 42, speed: 7.4, radius: 1.7, height: 4.0,
    xp: 520, gold: 155, color: 0x2c3c52, accent: 0x7fd8ff, model: 'fulgurant',
    ai: 'boss_fulgurant', attackRange: 40, preferredRange: 22, attackCooldown: 1.5, windup: 0.4,
    flying: true, flyHeight: 12, novaInterval: 9, novaRadius: 27,
    knockbackResist: 1, guaranteedDrop: true,
    lore: 'Strikes where you were going to be. Standing still is the only reliable way to be wrong.',
  },
  {
    id: 'choir', name: 'The Ossuary Choir', cost: 0, boss: true,
    health: 2400, damage: 36, speed: 4.2, radius: 1.9, height: 4.8,
    xp: 540, gold: 160, color: 0xa89878, accent: 0xff6a9a, model: 'choir',
    ai: 'boss_choir', attackRange: 26, preferredRange: 17, attackCooldown: 2.1, windup: 0.55,
    // Every living chorister it has raised takes a bite out of incoming damage.
    wardPerMinion: 0.16, wardCap: 0.72, maxMinions: 6, summonInterval: 4.5,
    summonPool: ['husk', 'spitter', 'skimmer'],
    knockbackResist: 1, guaranteedDrop: true,
    lore: 'It does not fight. It conducts, and it is very hard to interrupt a choir.',
  },
];

export const ELITE_AFFIXES = [
  {
    id: 'blazing', name: 'Blazing', color: 0xff6a2a, prefix: 'Blazing',
    desc: 'Attacks ignite. Leaves burning ground.',
    onHitPlayer: (ctx) => ctx.applyPlayerStatus('burn', 4, { dps: ctx.enemy.damage * 0.28 }),
    tick: 'fireTrail',
  },
  {
    id: 'glacial', name: 'Glacial', color: 0x6fd0ff, prefix: 'Glacial',
    desc: 'Attacks chill you. Explodes into ice on death.',
    onHitPlayer: (ctx) => ctx.applyPlayerStatus('chill', 3, { slow: 0.45 }),
    onDeath: 'iceNova',
  },
  {
    id: 'overcharged', name: 'Overcharged', color: 0xffe04b, prefix: 'Overcharged',
    desc: 'Periodically discharges lightning at close range.',
    tick: 'shockNova',
  },
  {
    id: 'voidtouched', name: 'Voidtouched', color: 0xd94bff, prefix: 'Voidtouched',
    desc: 'Suppresses your healing and pulls you inward.',
    onHitPlayer: (ctx) => ctx.applyPlayerStatus('suppress', 5, { healing: 0.4 }),
    tick: 'voidPull',
  },
];

/**
 * The Null Sovereign's three phases.
 *
 * One table rather than a scatter of `phase >= 3 ?` ternaries through the AI,
 * because a boss whose phases are an emergent property of six separate
 * conditionals is a boss nobody can retune. Every number that changes between
 * thresholds is here; the AI reads the row and does what it says.
 *
 * The shape of the fight is *addition*, not replacement — each threshold keeps
 * everything the last one had and puts something new on top, so the last third
 * is genuinely all of it at once rather than a different fight wearing the same
 * model. `at` is the health fraction the phase begins at, so the first row is
 * the one it opens on and the thresholds are 66% and 33%.
 *
 * `armour` is how long it is untouchable while it sheds. A phase change you can
 * burst straight through is not a phase change, it is a health bar with lines
 * drawn on it: the shift has to cost you the damage window to read as a beat.
 */
export const SOVEREIGN_PHASES = [
  {
    at: 1.0, name: 'Sealed', armour: 0,
    // Opening form: it keeps its distance and works you with spirals and adds.
    attacks: ['barrage', 'summon'],
    cooldown: 1.0, windup: 1.0, orbitSpeed: 0.32, moveScale: 1.0,
    volley: 4, spokes: 7, projectileSpeed: 30,
    summons: 4, summonKinds: ['husk'], summonElite: 0,
    riftRings: 3,
  },
  {
    at: 0.66, name: 'Shelled', armour: 1.4,
    // The shell comes off: ground it can deny, and it starts closing on you.
    attacks: ['barrage', 'summon', 'rift', 'slam'],
    cooldown: 0.78, windup: 1.0, orbitSpeed: 0.42, moveScale: 1.0,
    volley: 6, spokes: 7, projectileSpeed: 33,
    summons: 4, summonKinds: ['husk', 'charger'], summonElite: 0,
    riftRings: 3,
    toast: 'THE SOVEREIGN SHEDS ITS SHELL',
    line: 'The Sovereign sheds its shell.',
  },
  {
    at: 0.33, name: 'Unravelled', armour: 1.8,
    // Everything, faster, and a wall of fire across the whole arena.
    attacks: ['barrage', 'summon', 'rift', 'slam', 'sweep', 'rift', 'barrage'],
    cooldown: 0.56, windup: 0.7, orbitSpeed: 0.52, moveScale: 1.25,
    volley: 9, spokes: 9, projectileSpeed: 36,
    summons: 6, summonKinds: ['husk', 'charger'], summonElite: 0.4,
    riftRings: 4,
    toast: 'THE SOVEREIGN UNRAVELS',
    line: 'The Sovereign unravels.',
  },
];

/**
 * The optional final fight.
 *
 * Kept out of BOSSES so the director can never roll it as a stage guardian —
 * the only way to meet it is to walk through the rift on purpose. Its health is
 * three times a normal boss before difficulty and party scaling touch it, and
 * it fights in the three escalating phases above rather than one loop of
 * patterns.
 */
export const FINAL_BOSS = {
  id: 'sovereign', name: 'The Null Sovereign', cost: 0, boss: true, final: true,
  health: 9400, damage: 62, speed: 6.2, radius: 2.1, height: 6.2,
  xp: 2400, gold: 640, color: 0x1a0e2c, accent: 0xff2f8f, model: 'sovereign',
  ai: 'boss_sovereign', attackRange: 46, preferredRange: 17, attackCooldown: 1.9, windup: 0.55,
  knockbackResist: 1, flyHeight: 4.2, guaranteedDrop: true,
  phases: SOVEREIGN_PHASES,
  lore: 'The thing the descent was built to keep down here. It has been waiting the whole time.',
};

export const ENEMIES_BY_ID = Object.fromEntries(
  [...ENEMIES, ...BOSSES, FINAL_BOSS].map((e) => [e.id, e]),
);
export const AFFIX_BY_ID = Object.fromEntries(ELITE_AFFIXES.map((a) => [a.id, a]));
