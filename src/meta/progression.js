/** Echo award maths and the unlock catalogue shown in the Sanctum. */
import { ECHOES, RARITY, RUN_MODES } from '../core/config.js';
import { ITEMS } from '../data/items.js';
import { CHARACTERS } from '../data/characters.js';

export function runModeById(id) {
  return RUN_MODES.find((m) => m.id === id) || RUN_MODES[1];
}

/**
 * Echoes are the meta currency. Time survived dominates the payout, with
 * meaningful bumps for clearing stages and killing bosses.
 */
export function computeEchoes(result, profileData) {
  const mode = runModeById(result.mode);
  const minutes = result.time / 60;

  const fromTime = minutes * ECHOES.perMinute;
  const fromStages = result.stagesCleared * ECHOES.perStage;
  const fromKills = result.kills * ECHOES.perKill;
  const fromBosses = result.bossKills * ECHOES.perBoss;

  let firstClear = 0;
  for (let i = 1; i <= result.stagesCleared; i++) {
    if (!profileData.stagesEverCleared[i]) firstClear += ECHOES.firstClearBonus;
  }

  // Surviving deep into the difficulty ramp is worth a bonus of its own.
  const depthBonus = Math.max(0, result.difficulty - 2) * 12;

  // Finishing it is worth more than any amount of farming, because farming is
  // the thing the ending is competing against.
  const victoryBonus = result.victory ? ECHOES.victoryBonus : 0;
  const subtotal = fromTime + fromStages + fromKills + fromBosses + depthBonus;
  const total = Math.max(1, Math.round(subtotal * mode.echoMult + firstClear + victoryBonus));

  return {
    total,
    breakdown: [
      { label: `Survived ${minutes.toFixed(1)} min`, value: Math.round(fromTime) },
      { label: `Stages cleared × ${result.stagesCleared}`, value: Math.round(fromStages) },
      { label: `Enemies felled × ${result.kills}`, value: Math.round(fromKills) },
      { label: `Bosses slain × ${result.bossKills}`, value: Math.round(fromBosses) },
      ...(depthBonus > 0 ? [{ label: 'Difficulty depth', value: Math.round(depthBonus) }] : []),
      ...(mode.echoMult !== 1 ? [{ label: `${mode.name} modifier ×${mode.echoMult}`, value: null }] : []),
      ...(firstClear > 0 ? [{ label: 'First-clear bonus', value: firstClear }] : []),
      ...(victoryBonus > 0 ? [{ label: 'The Sovereign felled', value: victoryBonus }] : []),
    ],
  };
}

export function itemEchoCost(item) {
  return RARITY[item.rarity].echoCost;
}

/** Everything purchasable, grouped for the Sanctum UI. */
export function unlockCatalogue(profileData) {
  const items = ITEMS.filter((i) => !i.unlocked).map((i) => ({
    kind: 'item',
    id: i.id,
    ref: i,
    cost: itemEchoCost(i),
    owned: profileData.unlockedItems.includes(i.id),
  }));
  const characters = CHARACTERS.filter((c) => !c.unlocked).map((c) => ({
    kind: 'character',
    id: c.id,
    ref: c,
    cost: c.echoCost,
    owned: profileData.unlockedCharacters.includes(c.id),
  }));
  // Weapons are not in the Sanctum: a character carries one, and buying a
  // character buys the weapon with it.
  return { items, characters };
}

/** The item pool a run draws from: default items plus everything unlocked. */
export function availableItemPool(profileData) {
  return ITEMS.filter((i) => i.unlocked || profileData.unlockedItems.includes(i.id));
}
