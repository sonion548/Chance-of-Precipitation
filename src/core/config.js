// Central tuning constants. Everything a designer would want to touch lives here.

export const VERSION = '1.0.0';

// The body every character shares: how it moves, how big it is, how it levels.
// What separates one character from another — health, damage, regen, armour,
// crit, speed and their per-level growth — lives on the character in
// `data/characters.js`, and is read from there, never from here.
export const PLAYER = {
  baseCritDamage: 2.0,      // crit chance is per-character; the multiplier is not
  jumpVelocity: 11.5,
  gravity: -34,
  airControl: 0.42,
  groundFriction: 12,
  airFriction: 1.1,
  radius: 0.45,
  height: 1.75,
  eyeHeight: 1.45,
  // The baseline roll. A character that passes nothing to `dash()` gets these;
  // its cooldown comes from the ability, like every other cooldown.
  dashSpeed: 26,
  dashDuration: 0.20,
  iframesOnDash: 0.16,
  pickupRadius: 3.2,
  interactRange: 4.2,
  xpBase: 22,               // xp needed for level 2
  xpGrowth: 1.55,
};

export const CAMERA = {
  fov: 74,
  // The backdrop ranges sit several arena radii out, so the far plane has to
  // reach them. Pushing the near plane out with it keeps the depth precision
  // roughly where it was; nothing ever gets closer than the minimum boom.
  near: 0.2,
  far: 3200,
  distance: 7.0,
  height: 1.40,      // pivot sits near head height so level aim hits body height
  shoulder: 1.05,
  aimDistance: 4.2,
  aimFov: 62,
  // Steeper than a boom of this length can physically swing to, because it no
  // longer has to: looking up lifts the pivot and shortens the arm instead of
  // burying the camera in the floor.
  minPitch: -1.28,
  maxPitch: 1.30,
  // How far the pivot rises as you look up, and how far it drops looking down.
  pitchLift: 1.45,
  pitchDrop: 0.35,
  smoothing: 17,
  sensitivity: 0.0023,
  // Obstruction probing. The camera is a volume, not a point: a single ray from
  // the shoulder-offset pivot slips past anything narrower than the offset —
  // which is every tree trunk in the game.
  collisionRadius: 0.34,    // half-width of the probe bundle
  collisionPad: 0.3,        // stop this far short of whatever we hit
  minDistance: 1.55,
  groundClearance: 0.55,   // never closer than this to whatever is underneath
  /* How fast the body swings round to the camera.
     There used to be two of these — a fast one for when the weapon needed to
     be on the crosshair and a slow one for free running, where the character
     turned into its own travel direction instead. The body faces the camera
     at all times now, so there is one speed and it is the fast one; the legs
     carry the travel direction. */
  bodyTurn: 16,
};

export const DIRECTOR = {
  creditRateBase: 1.72,     // credits/sec at difficulty 1
  creditRateGrowth: 0.62,   // sub-linear: volume must grow slower than player DPS
  creditCapBase: 26,        // banked credits are capped so falling behind cannot spiral
  creditCapPerDifficulty: 16,
  // Population scales with the arena as well as with the difficulty: the same
  // headcount spread over twice the ground is not the same fight, it is a
  // walking simulator with occasional violence.
  activeEnemiesBase: 20,    // the population cap also ramps with difficulty
  activeEnemiesPerDifficulty: 3.8,
  waveInterval: [3.6, 6.8], // seconds between spawn attempts
  maxActiveEnemies: 58,     // absolute ceiling
  eliteCostMultiplier: 5.2,
  eliteHealthMultiplier: 3.6,
  eliteDamageMultiplier: 1.9,
  eliteGoldMultiplier: 2.4,
  eliteUnlockDifficulty: 1.9,
  eliteChanceMax: 0.42,
  spawnMinDistance: 24,
  spawnMaxDistance: 64,
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
  duplicatorMult: 3.6,
  equipmentPodMult: 2.2,
  shrineCostGrowth: 1.35,
  ruinShrineMult: 2.2,       // the Shrine of Ruin is priced against a Large chest
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
export const PETS = {
  // No headcount cap: the eggs a stage puts out, and the rising price of the
  // next one, are the limit.
  eggBaseCost: 48,
  eggCostExponent: 1.02,    // cost = base * difficulty^exp * (1 + owned * perOwned)
  eggCostPerOwned: 0.85,
  eggsPerStage: [2, 3],     // inclusive range
  // Everything about a species — health, damage, reach, how it fights and what
  // its attacks proc at — lives in data/pets.js. Only what every pet shares is
  // here.
  followRadius: 5.0,
  leash: 30,                // teleports back past this
  reviveTime: 15,
  regen: 0.11,              // × own max health per second, out of combat
};

/**
 * Ultimates: one enormous ability per character, bought with violence.
 *
 * The meter fills from two sources on purpose — kills and damage taken — so it
 * pays out both to the player clearing a room and to the one being ground down
 * in it. Neither alone fills it quickly; a fight does. The trickle exists only
 * so a long walk between fights is not dead time.
 */
export const ULTIMATE = {
  max: 100,
  /* Priced for roughly one ultimate every two stages.
   *
   * Measured against the director rather than guessed: a five-minute stage
   * spawns about 56 bodies at stage one and about 90 with a dozen elites by
   * stage five, and at the old rates that paid out three to five and a half
   * full meters *per stage* — an ultimate every ninety seconds, which is not
   * a run-swinging ability, it is a rotation. These numbers land the same
   * stages at 0.46 / 0.49 / 0.52 / 0.70 meters, so the ability arrives about
   * every second stage early on and a little more often deep into a run,
   * which is where you want it.
   *
   * The boss is deliberately the single largest source: it is the one
   * landmark every stage has, and a fifth of the meter for killing it is what
   * makes the pacing legible rather than arbitrary. */
  perKill: 0.28,
  perEliteKill: 0.9,
  perBossKill: 11,
  // Per 1% of your max health actually lost. A full bar is worth six points.
  perHealthPercent: 0.06,
  /* Per 1% of an enemy's *own* max health you take off it.
   *
   * The meter used to pay out only for finishing things and for bleeding,
   * which meant the two characters who spend a whole fight chipping a boss
   * down earned nothing for it while the one who cleaned up a spawn wave got
   * a bar. Damage is what an ultimate is actually made of, so damage is what
   * buys it: measured as a fraction of the target rather than as raw numbers,
   * so a build with ten times the damage does not charge ten times as fast —
   * it kills the same body ten times quicker and is paid the same for it.
   *
   * Capped per hit at `maxPerHit`, which is deliberately exactly one whole
   * body: `takeDamage` reports what was thrown rather than what fitted, so a
   * 2600% slam into a husk returns fifteen times the husk's health, and
   * without the cap one ultimate would pay for the next four. Overkill is
   * worth the thing you killed and not a point more.
   *
   * Sized against the director: a five-minute stage spawns about 56 bodies, so
   * clearing one on damage alone is worth a little under a full meter. Added
   * to what kills and blood already paid, an ultimate now arrives about once a
   * stage rather than once every two — which is the point of paying for damage
   * at all. It is the largest single source now, as it should be: the meter is
   * meant to measure how much fighting you have done. */
  perEnemyHealthPercent: 0.016,
  maxPerHit: 1.6,
  perSecond: 0.035,
  startCharge: 0,
};

// Co-op. Send rates are a compromise: high enough that a teammate strafing
// past you does not skate, low enough that eight players on a home upload do
// not saturate it. Everything is interpolated on the receiving side.
/**
 * How much harder a party makes the run.
 *
 * Two dials, because they are not the same problem. `difficultyPerPlayer` feeds
 * the coefficient, so enemies get tougher and richer; the spawn dials make the
 * arena busier. Four players with four times the DPS against one enemy at a
 * time would be a parade, and against four times the enemies at unchanged
 * health would be a bullet sponge convention — so both move.
 */
export const PARTY = {
  difficultyPerPlayer: 0.22,   // coefficient × (1 + this × extra players)
  creditsPerPlayer: 0.55,      // spawn budget, and the banked-credit ceiling
  capPerPlayer: 0.55,          // simultaneous enemies
  chestsPerPlayer: 1.6,        // more loot for more people to buy it
  eggsPerPlayer: 0.9,
};

export const COOP = {
  stateInterval: 1 / 20,    // your own body, to everyone
  snapInterval: 1 / 15,     // the host's enemy snapshot
  petInterval: 1 / 10,   // your pets, to everyone
  damageInterval: 1 / 20,   // batched damage reports, client → host
  maxPlayers: 8,
  reviveRadius: 3.6,
  reviveTime: 5,
  reviveHealth: 0.45,       // fraction of max health you come back on
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

/**
 * The optional ending.
 *
 * Offered rather than imposed: the rift opens beside the Beacon from stage five
 * onward and the descent still goes on forever if you would rather keep going.
 */
export const FINAL = {
  unlockStage: 5,
  bossHealthMult: 1.0,
  bossHealthPerPlayer: 0.85,   // on top of the difficulty coefficient
  directorMultiplier: 1.35,    // the sanctum keeps spawning while you fight
};

export const ECHOES = {
  perMinute: 9,
  perStage: 30,
  perKill: 0.32,
  perBoss: 45,
  firstClearBonus: 60,
  victoryBonus: 900,          // for actually finishing it
};

export const WORLD = {
  // Fallback only: every theme names its own radius, between 148 and 176.
  arenaRadius: 160,
  // Not a wall any more — the height of the containment field that draws when
  // you get near the edge. See `Arena._buildBarrier`.
  wallHeight: 34,
  fogNear: 60,
  fogFar: 430,
};
