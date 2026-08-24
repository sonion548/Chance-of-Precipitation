// Central tuning constants. Everything a designer would want to touch lives here.

export const VERSION = '1.0.0';

export const PLAYER = {
  baseHealth: 110,
  baseRegen: 1.0,           // hp / sec
  baseDamage: 12,
  baseArmor: 0,
  baseMoveSpeed: 8.2,       // units / sec
  sprintMultiplier: 1.45,
  baseCrit: 0.01,
  baseCritDamage: 2.0,
  jumpVelocity: 11.5,
  gravity: -34,
  airControl: 0.42,
  groundFriction: 12,
  airFriction: 1.1,
  radius: 0.45,
  height: 1.75,
  eyeHeight: 1.45,
  dashSpeed: 26,
  dashDuration: 0.20,
  dashCooldown: 3.0,
  iframesOnDash: 0.16,
  pickupRadius: 3.2,
  interactRange: 4.2,
  // Level scaling (per level gained)
  hpPerLevel: 32,
  regenPerLevel: 0.2,
  damagePerLevel: 2.4,
  xpBase: 22,               // xp needed for level 2
  xpGrowth: 1.55,
};

export const CAMERA = {
  fov: 74,
  near: 0.1,
  far: 620,
  distance: 7.0,
  height: 1.40,      // pivot sits near head height so level aim hits body height
  shoulder: 1.05,
  aimDistance: 4.2,
  aimFov: 62,
  minPitch: -1.15,
  maxPitch: 0.95,
  smoothing: 17,
  sensitivity: 0.0023,
};

export const DIRECTOR = {
  creditRateBase: 1.55,     // credits/sec at difficulty 1
  creditRateGrowth: 0.62,   // sub-linear: volume must grow slower than player DPS
  creditCapBase: 26,        // banked credits are capped so falling behind cannot spiral
  creditCapPerDifficulty: 16,
  activeEnemiesBase: 16,    // the population cap also ramps with difficulty
  activeEnemiesPerDifficulty: 3.4,
  waveInterval: [3.6, 6.8], // seconds between spawn attempts
  maxActiveEnemies: 46,     // absolute ceiling
  eliteCostMultiplier: 5.2,
  eliteHealthMultiplier: 3.6,
  eliteDamageMultiplier: 1.9,
  eliteGoldMultiplier: 2.4,
  eliteChanceStart: 0.0,
  eliteUnlockDifficulty: 1.9,
  eliteChanceMax: 0.42,
  spawnMinDistance: 22,
  spawnMaxDistance: 52,
};

export const DIFFICULTY = {
  // difficulty coefficient = (1 + timeScalar * minutes) * stageMult^stagesCleared
  timeScalar: 0.26,
  stageMult: 1.14,
  hpScale: 0.70,            // enemy hp   = base * (1 + (diff-1) * hpScale)
  dmgScale: 0.40,           // enemy dmg  = base * (1 + (diff-1) * dmgScale)
  goldScale: 0.50,
  xpScale: 0.55,
  // Displayed ramp tiers
  tiers: [
    { at: 1.0,  name: 'Easy',       color: '#4be08a' },
    { at: 2.0,  name: 'Medium',     color: '#a8e04b' },
    { at: 3.4,  name: 'Hard',       color: '#ffd54b' },
    { at: 5.2,  name: 'Very Hard',  color: '#ffb347' },
    { at: 7.5,  name: 'Insane',     color: '#ff7a47' },
    { at: 10.5, name: 'Impossible', color: '#ff4d5e' },
    { at: 15.0, name: 'Cataclysm',  color: '#d94bff' },
    { at: 21.0, name: 'Oblivion',   color: '#ff2f8f' },
  ],
};

// Global difficulty selection (chosen before a run)
export const RUN_MODES = [
  { id: 'calm',  name: 'Calm',  mult: 0.72, spawnMult: 0.7, echoMult: 0.7,  desc: 'A gentler ramp and thinner crowds. Fewer Echoes.' },
  { id: 'storm', name: 'Storm', mult: 1.0,  spawnMult: 1.0, echoMult: 1.0,  desc: 'The intended descent.' },
  { id: 'void',  name: 'Void',  mult: 1.42, spawnMult: 1.3, echoMult: 1.55, desc: 'Brutal scaling and denser waves. Rich rewards.' },
];

export const ECONOMY = {
  chestBaseCost: 26,
  chestCostExponent: 1.05,   // cost = base * difficulty^exp
  largeChestMult: 3.1,
  legendaryChestMult: 7.5,
  shrineCostGrowth: 1.35,
  ruinShrineMult: 2.2,       // the Shrine of Ruin is priced against a Large chest
  goldPerKillBase: 5,
  goldOrbLifetime: 26,
};

// Chest rarity tables. Weights are relative.
export const RARITY_TABLES = {
  chest:     { common: 74, uncommon: 20, rare: 4.6, epic: 1.1, legendary: 0.3 },
  // Large chests never roll Common — paying the premium guarantees a step up.
  large:     { common: 0,  uncommon: 64, rare: 26,  epic: 8,   legendary: 2 },
  legendary: { common: 0,  uncommon: 0,  rare: 42,  epic: 40,  legendary: 18 },
  shrine:    { common: 58, uncommon: 27, rare: 10,  epic: 4,   legendary: 1 },
  boss:      { common: 0,  uncommon: 34, rare: 42,  epic: 18,  legendary: 6 },
};

export const RARITY = {
  common:    { name: 'Common',    color: '#d5dae6', hex: 0xd5dae6, order: 0, echoCost: 40 },
  uncommon:  { name: 'Uncommon',  color: '#5fe07a', hex: 0x5fe07a, order: 1, echoCost: 110 },
  rare:      { name: 'Rare',      color: '#4aa8ff', hex: 0x4aa8ff, order: 2, echoCost: 240 },
  epic:      { name: 'Epic',      color: '#b473ff', hex: 0xb473ff, order: 3, echoCost: 480 },
  legendary: { name: 'Legendary', color: '#ff8a3d', hex: 0xff8a3d, order: 4, echoCost: 900 },
};

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

// Brood lizards: bought from eggs with gold, they inherit the owner's items.
export const MINIONS = {
  baseCap: 3,               // more from Brood Totem
  eggBaseCost: 48,
  eggCostExponent: 1.02,    // cost = base * difficulty^exp * (1 + owned * perOwned)
  eggCostPerOwned: 0.85,
  eggsPerStage: [1, 2],     // inclusive range
  health: 0.42,             // × owner max health
  damage: 0.60,             // × owner damage, per fireball
  attackCooldown: 1.35,     // ÷ owner attack speed
  attackRange: 27,
  minRange: 4.5,            // backs off if something gets this close
  projectileSpeed: 33,
  splashRadius: 2.7,
  burnDps: 0.18,            // × owner damage, per second
  burnTime: 3.0,
  // Proc coefficient. Low, because a fireball is an area hit and a full brood
  // firing into a crowd resolves far more hit events per second than your gun
  // does — at 1.0 the lizards would be procing your items harder than you are.
  proc: 0.15,
  followRadius: 5.0,
  leash: 30,                // teleports back past this
  speed: 1.08,              // × owner move speed
  reviveTime: 15,
};

// Co-op. Send rates are a compromise: high enough that a teammate strafing
// past you does not skate, low enough that eight players on a home upload do
// not saturate it. Everything is interpolated on the receiving side.
export const COOP = {
  stateInterval: 1 / 20,    // your own body, to everyone
  snapInterval: 1 / 15,     // the host's enemy snapshot
  minionInterval: 1 / 10,   // your lizards, to everyone
  damageInterval: 1 / 20,   // batched damage reports, client → host
  maxPlayers: 8,
  reviveRadius: 3.6,
  reviveTime: 5,
  reviveHealth: 0.45,       // fraction of max health you come back on
  friendlyFire: false,
  // A client has to stand somewhere in the half-second before the host's stage
  // packet lands. It builds this seed rather than one of its own, so every
  // machine's placeholder is the same ground and nobody is ever described to
  // the party at a height that only exists on their own screen.
  pendingSeed: 0x5eed,
  stageResendDelay: 2.0,    // seconds a client waits before asking again
};

export const TELEPORTER = {
  chargeTime: 42,           // seconds to charge
  radius: 21,
  bossCreditBonus: 1.0,
  postClearGoldBonus: 0.35, // % of current gold granted on stage clear
  // Boss loot is per head, not per party: four players clearing a stage get
  // four items, the same one item each a solo run gets. Splitting a single drop
  // four ways would make co-op strictly worse than playing alone.
  bossItemsPerPlayer: 1,
  bossItemSpread: 2.4,      // metres between drops so they do not stack
  // The Shrine of Ruin compounds — the boon lasts the rest of the run and every
  // guardian pays out — so it stacks twice and no further. Three guardians at a
  // beacon with three items each per player is already the top of the curve.
  maxBosses: 3,             // ceiling on what the Shrine of Ruin can summon
  maxBossItemBonus: 2,      // ceiling on the shrine's extra items per player
};

export const ECHOES = {
  perMinute: 9,
  perStage: 30,
  perKill: 0.32,
  perBoss: 45,
  firstClearBonus: 60,
};

export const WORLD = {
  arenaRadius: 78,
  wallHeight: 26,
  fogNear: 40,
  fogFar: 260,
};
