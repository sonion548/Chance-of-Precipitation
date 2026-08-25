/**
 * Pet species.
 *
 * Every number here is a multiplier on its owner's stats rather than a value of
 * its own — that is what "pets inherit your items" means mechanically, and it is
 * why a species can be described in a dozen lines. Health scales off your max
 * health, damage off your damage, fire rate off your attack speed, and every hit
 * they land runs through `Combat.damageEnemy`, so your crit, your damage
 * modifiers, your lifesteal and your on-hit items all fire from their attacks.
 *
 * The four are deliberately spread across the roles a pack can want rather than
 * being four flavours of the same thing:
 *
 *   Lizard  — the all-rounder. Ranged, splash, sets things on fire.
 *   Beetle  — the bruiser. Runs in, gores, survives being noticed.
 *   Wisp    — the artillery. Fires four times as often as anything else and
 *             dies to a stiff breeze.
 *   Shell   — the wall. Almost no damage; hands its bulk to the party as barrier.
 *
 * `weight` is the roll when an egg picks what is inside it.
 */
export const PETS_SPECIES = [
  {
    id: 'lizard',
    name: 'Brood Lizard',
    model: 'lizard',
    icon: '🦎',
    weight: 100,
    color: 0x5f7a4a,
    desc: 'Spits homing fire that bursts and burns. Good at everything, best at nothing.',
    health: 0.42,
    damage: 0.60,
    speed: 1.08,
    attackCooldown: 1.35,
    attackRange: 27,
    minRange: 4.5,
    attack: 'fireball',
    windup: 0.28,
    projectileSpeed: 33,
    splashRadius: 2.7,
    burnDps: 0.18,
    burnTime: 3.0,
    proc: 0.15,
    radius: 0.34,
    height: 0.72,
  },
  {
    id: 'beetle',
    name: 'Cinder Beetle',
    model: 'beetle',
    icon: '🪲',
    weight: 74,
    color: 0x6b4630,
    desc: 'Charges whatever you are looking at and gores it. Takes a beating and keeps going.',
    health: 1.25,
    damage: 1.15,
    speed: 1.32,
    attackCooldown: 2.0,
    attackRange: 22,          // how far it will go looking for a fight
    strikeRange: 3.4,         // how close it has to be to connect
    attack: 'gore',
    windup: 0.34,
    chargeSpeed: 26,
    chargeTime: 0.5,
    knockback: 16,
    burnDps: 0.1,
    burnTime: 2.5,
    proc: 0.5,                // one heavy hit, so it can afford a real coefficient
    radius: 0.4,
    height: 0.66,
  },
  {
    id: 'wisp',
    name: 'Spark Wisp',
    model: 'wisp',
    icon: '✨',
    weight: 62,
    color: 0x8fd8ff,
    desc: 'Hovers and fires constantly. Arcs to a second target. Almost no health at all.',
    health: 0.16,
    damage: 0.19,
    speed: 1.45,
    attackCooldown: 0.42,
    attackRange: 26,
    minRange: 7,
    attack: 'bolt',
    windup: 0.1,
    projectileSpeed: 58,
    chainJumps: 1,
    chainFraction: 0.55,
    proc: 0.1,                // it fires four times as often as anything else
    flying: true,
    flyHeight: 2.4,
    radius: 0.3,
    height: 1.4,
  },
  {
    id: 'shell',
    name: 'Aegis Shell',
    model: 'shell',
    icon: '🐢',
    weight: 48,
    color: 0x4a5a6a,
    desc: 'Slow, enormously tough, and pulses a barrier onto everyone nearby while chilling what is not.',
    health: 2.6,
    damage: 0.34,
    speed: 0.72,
    attackCooldown: 2.4,
    attackRange: 13,
    minRange: 0,              // it wants to be in the middle of it
    attack: 'guard',
    windup: 0.5,
    guardRadius: 9,
    // Barrier decays at 3.5% of max health a second, so a pulse worth less than
    // ~8% every 2.4s is a pet that visibly does nothing. This clears it.
    barrierFraction: 0.16,    // × owner max health, per pulse
    chillTime: 2.2,
    proc: 0.2,
    radius: 0.46,
    height: 0.8,
  },
];

export const PET_BY_ID = Object.fromEntries(PETS_SPECIES.map((p) => [p.id, p]));

export function petById(id) { return PET_BY_ID[id] || PETS_SPECIES[0]; }

/** What an egg has in it. Weighted, so the lizard stays the common case. */
export function rollPetSpecies(rng) {
  const table = {};
  for (const p of PETS_SPECIES) table[p.id] = p.weight;
  return rng.weighted(table) || 'lizard';
}
