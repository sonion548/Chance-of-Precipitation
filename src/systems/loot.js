import { RARITY_TABLES, RARITY, RARITY_ORDER, ECONOMY, PETS } from '../core/config.js';
import { availableItemPool } from '../meta/progression.js';

/**
 * Chest and drop rolling.
 *
 * Luck (from Fortune Clover) rerolls the rarity and keeps the better result, so
 * stacking it meaningfully shifts the curve without ever guaranteeing an outcome.
 */
export function rollRarity(rng, tableName, luck = 0) {
  const table = RARITY_TABLES[tableName] || RARITY_TABLES.chest;
  let best = rng.weighted(table);
  for (let i = 0; i < luck; i++) {
    const again = rng.weighted(table);
    if (again && RARITY[again].order > RARITY[best].order) best = again;
  }
  return best || 'common';
}

/**
 * Picks a concrete item of the requested rarity.
 *
 * If nothing of that tier is unlocked yet it steps down, but never below
 * `minOrder` — a Large chest that rolls Rare may hand you an Uncommon, but it
 * must never hand you a Common. If the floor blocks the way down it searches
 * upward instead, so the drop always happens.
 */
export function pickItem(rng, rarity, profileData, minOrder = 0) {
  const pool = availableItemPool(profileData);
  const start = RARITY[rarity].order;

  for (let order = start; order >= minOrder; order--) {
    const candidates = pool.filter((i) => i.rarity === RARITY_ORDER[order]);
    if (candidates.length) return rng.pick(candidates);
  }
  for (let order = start + 1; order < RARITY_ORDER.length; order++) {
    const candidates = pool.filter((i) => i.rarity === RARITY_ORDER[order]);
    if (candidates.length) return rng.pick(candidates);
  }
  // Nothing at or above the floor is unlocked yet. Give the best thing that is,
  // rather than the first item in the pool — a Legendary chest handing out a
  // Common because no Rares are unlocked is worse than no chest at all.
  for (let order = RARITY_ORDER.length - 1; order >= 0; order--) {
    const candidates = pool.filter((i) => i.rarity === RARITY_ORDER[order]);
    if (candidates.length) return rng.pick(candidates);
  }
  return null;
}

/** Lowest rarity a table can actually produce — the floor for fallbacks. */
export function tableFloor(tableName) {
  const table = RARITY_TABLES[tableName] || RARITY_TABLES.chest;
  for (let i = 0; i < RARITY_ORDER.length; i++) {
    if ((table[RARITY_ORDER[i]] ?? 0) > 0) return i;
  }
  return 0;
}

export function rollItem(rng, tableName, luck, profileData) {
  const rarity = rollRarity(rng, tableName, luck);
  return pickItem(rng, rarity, profileData, tableFloor(tableName));
}

/**
 * Egg price.
 *
 * Fixed the moment the stage is built, from the difficulty coefficient at that
 * moment, and never touched again until the next stage. It used to be
 * recalculated every time you walked up to one, against how many lizards you
 * were holding — which meant the number on the prompt changed while you were
 * running back to it with the gold, and buying the cheap egg made the one you
 * were saving for more expensive. Pricing the whole clutch up front turns a row
 * of eggs into a shopping list you can actually plan against.
 *
 * `sequence` is the egg's position in the stage's clutch, so the second and
 * third are still dearer than the first — that pressure was always the point,
 * it just has to be legible from the start rather than applied behind you.
 */
export function eggCost(difficulty, sequence = 0) {
  const base = PETS.eggBaseCost * Math.pow(difficulty, PETS.eggCostExponent);
  return Math.max(1, Math.round(base * (1 + sequence * PETS.eggCostPerOwned)));
}

/** Interactable cost scales with the difficulty coefficient, matching enemy gold. */
export function chestCost(kind, difficulty) {
  const base = ECONOMY.chestBaseCost * Math.pow(difficulty, ECONOMY.chestCostExponent);
  const mult = {
    chest: 1,
    large: ECONOMY.largeChestMult,
    legendary: ECONOMY.legendaryChestMult,
    shrine: 0.7,
    ruin: ECONOMY.ruinShrineMult,
    // A duplicator is not a roll — it is a guaranteed extra stack of something
    // you have already decided you want, so it is priced above a Large chest.
    duplicator: ECONOMY.duplicatorMult,
    // A pod is priced between a chest and a large one: what comes out is always
    // useful, and always the only one of its kind you can carry.
    equipment: ECONOMY.equipmentPodMult,
    // The altar, the cache and the forge are not bought with gold at all.
    altar: 0, cache: 0, forge: 0,
  }[kind] ?? 1;
  return Math.max(1, Math.round(base * mult));
}
