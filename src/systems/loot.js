import { RARITY_TABLES, RARITY, RARITY_ORDER, ECONOMY, MINIONS } from '../core/config.js';
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
 * Egg price. Scales with difficulty like a chest, and again with how many
 * lizards you already own — the third one should be a real decision against a
 * Large chest, not an afterthought.
 */
export function eggCost(difficulty, owned) {
  const base = MINIONS.eggBaseCost * Math.pow(difficulty, MINIONS.eggCostExponent);
  return Math.max(1, Math.round(base * (1 + owned * MINIONS.eggCostPerOwned)));
}

/** Interactable cost scales with the difficulty coefficient, matching enemy gold. */
export function chestCost(kind, difficulty) {
  const base = ECONOMY.chestBaseCost * Math.pow(difficulty, ECONOMY.chestCostExponent);
  const mult = {
    chest: 1, large: ECONOMY.largeChestMult, legendary: ECONOMY.legendaryChestMult,
    shrine: 0.7, ruin: ECONOMY.ruinShrineMult,
  }[kind] ?? 1;
  return Math.max(1, Math.round(base * mult));
}
