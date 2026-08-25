/**
 * Persistent profile: unlocks, Echoes, and lifetime records.
 * Stored in localStorage; degrades gracefully to an in-memory profile when
 * storage is unavailable (private browsing, file:// sandboxes).
 */
import { ITEMS, DEFAULT_UNLOCKED_ITEMS } from '../data/items.js';
import { WEAPONS, DEFAULT_UNLOCKED_WEAPONS, DEFAULT_WEAPON } from '../data/weapons.js';
import { CHARACTERS, DEFAULT_UNLOCKED_CHARACTERS, DEFAULT_CHARACTER } from '../data/characters.js';
import { VERSION } from '../core/config.js';

const KEY = 'chance-of-precipitation.profile.v1';
// The game was called SONEYBUN when the first profiles were written. Renaming
// the key without this line would present every existing player with a blank
// save — no Echoes, no unlocks — and no way to tell that anything was lost.
const LEGACY_KEY = 'soneybun.profile.v1';

function freshProfile() {
  return {
    version: VERSION,
    echoes: 0,
    lifetimeEchoes: 0,
    unlockedItems: [...DEFAULT_UNLOCKED_ITEMS],
    unlockedWeapons: [...DEFAULT_UNLOCKED_WEAPONS],
    equippedWeapon: DEFAULT_WEAPON,
    unlockedCharacters: [...DEFAULT_UNLOCKED_CHARACTERS],
    equippedCharacter: DEFAULT_CHARACTER,
    runMode: 'storm',
    playerName: '',
    lastLobbyCode: '',
    // Player-facing options. Kept in the profile rather than in their own key
    // so a wipe takes them with it — "reset account" has to mean all of it.
    settings: {
      sensitivity: 1,        // × the base look sensitivity
      screenShake: 1,        // × engine shake
      damageNumbers: true,
    },
    stagesEverCleared: {},        // stageIndex -> true (for first-clear bonuses)
    stats: {
      runs: 0,
      kills: 0,
      bossKills: 0,
      eliteKills: 0,
      deaths: 0,
      bestTime: 0,
      bestStage: 0,
      totalTime: 0,
      goldEarned: 0,
      itemsCollected: 0,
      chestsOpened: 0,
      highestDifficulty: 1,
    },
    itemsSeen: {},                // itemId -> times picked up (drives the Codex)
    enemiesSeen: {},
  };
}

let memoryFallback = null;

function readRaw() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
    // First run since the rename: adopt the old profile and leave it where it
    // is. Copying rather than moving means an older build of the game still
    // finds its save, so this is not a one-way door.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      localStorage.setItem(KEY, legacy);
      return JSON.parse(legacy);
    }
    return null;
  } catch {
    return memoryFallback;
  }
}

function writeRaw(profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    memoryFallback = profile;
  }
}

/** Fills in fields added by later versions so old saves keep working. */
function migrate(p) {
  const base = freshProfile();
  const merged = { ...base, ...p };
  merged.stats = { ...base.stats, ...(p.stats || {}) };
  merged.itemsSeen = { ...(p.itemsSeen || {}) };
  merged.enemiesSeen = { ...(p.enemiesSeen || {}) };
  merged.stagesEverCleared = { ...(p.stagesEverCleared || {}) };
  merged.settings = { ...base.settings, ...(p.settings || {}) };
  // Guarantee the default unlocks are always present.
  merged.unlockedItems = [...new Set([...base.unlockedItems, ...(p.unlockedItems || [])])];
  merged.unlockedWeapons = [...new Set([...base.unlockedWeapons, ...(p.unlockedWeapons || [])])];
  merged.unlockedCharacters = [...new Set([...base.unlockedCharacters, ...(p.unlockedCharacters || [])])];
  merged.version = VERSION;
  return merged;
}

export class Profile {
  constructor() {
    this.data = migrate(readRaw() || freshProfile());
    this.listeners = new Set();
  }

  save() {
    writeRaw(this.data);
    this.listeners.forEach((fn) => fn(this.data));
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  get echoes() { return this.data.echoes; }

  addEchoes(n) {
    this.data.echoes += n;
    this.data.lifetimeEchoes += n;
    this.save();
  }

  spendEchoes(n) {
    if (this.data.echoes < n) return false;
    this.data.echoes -= n;
    this.save();
    return true;
  }

  isItemUnlocked(id) { return this.data.unlockedItems.includes(id); }
  isWeaponUnlocked(id) { return this.data.unlockedWeapons.includes(id); }
  isCharacterUnlocked(id) { return this.data.unlockedCharacters.includes(id); }

  unlockItem(id, cost) {
    if (this.isItemUnlocked(id)) return false;
    if (!this.spendEchoes(cost)) return false;
    this.data.unlockedItems.push(id);
    this.save();
    return true;
  }

  unlockWeapon(id, cost) {
    if (this.isWeaponUnlocked(id)) return false;
    if (!this.spendEchoes(cost)) return false;
    this.data.unlockedWeapons.push(id);
    this.save();
    return true;
  }

  unlockCharacter(id, cost) {
    if (this.isCharacterUnlocked(id)) return false;
    if (!this.spendEchoes(cost)) return false;
    this.data.unlockedCharacters.push(id);
    this.save();
    return true;
  }

  equipCharacter(id) {
    if (!this.isCharacterUnlocked(id)) return false;
    this.data.equippedCharacter = id;
    this.save();
    return true;
  }

  equipWeapon(id) {
    if (!this.isWeaponUnlocked(id)) return false;
    this.data.equippedWeapon = id;
    this.save();
    return true;
  }

  setRunMode(id) { this.data.runMode = id; this.save(); }

  /** Writes one option and persists. Unknown keys are ignored on purpose. */
  setSetting(key, value) {
    if (!(key in this.data.settings)) return false;
    this.data.settings[key] = value;
    this.save();
    return true;
  }

  setPlayerName(name) { this.data.playerName = String(name).slice(0, 18); this.save(); }
  setLastLobbyCode(code) { this.data.lastLobbyCode = String(code || '').toUpperCase().slice(0, 6); this.save(); }

  noteItemSeen(id) {
    this.data.itemsSeen[id] = (this.data.itemsSeen[id] || 0) + 1;
    this.data.stats.itemsCollected++;
  }

  noteEnemySeen(id) {
    this.data.enemiesSeen[id] = (this.data.enemiesSeen[id] || 0) + 1;
  }

  /** Folds a finished run's results into lifetime records. */
  recordRun(result) {
    const s = this.data.stats;
    s.runs++;
    s.kills += result.kills;
    s.bossKills += result.bossKills;
    s.eliteKills += result.eliteKills;
    s.totalTime += result.time;
    s.goldEarned += result.goldEarned;
    s.chestsOpened += result.chestsOpened;
    if (!result.victory) s.deaths++;
    s.bestTime = Math.max(s.bestTime, result.time);
    s.bestStage = Math.max(s.bestStage, result.stage);
    s.highestDifficulty = Math.max(s.highestDifficulty, result.difficulty);
    for (let i = 1; i <= result.stagesCleared; i++) this.data.stagesEverCleared[i] = true;
    this.save();
  }

  /**
   * Grants every item, weapon and character at once.
   *
   * Echoes are deliberately left alone: this hands over the catalogue, not the
   * currency, so the counter still reads as what you actually earned. Returns
   * how many things were newly unlocked, which is the only interesting thing to
   * say about it afterwards.
   */
  unlockAll() {
    const before = this.data.unlockedItems.length
      + this.data.unlockedWeapons.length
      + this.data.unlockedCharacters.length;
    this.data.unlockedItems = [...new Set([...this.data.unlockedItems, ...ITEMS.map((i) => i.id)])];
    this.data.unlockedWeapons = [...new Set([...this.data.unlockedWeapons, ...WEAPONS.map((w) => w.id)])];
    this.data.unlockedCharacters = [...new Set([...this.data.unlockedCharacters, ...CHARACTERS.map((c) => c.id)])];
    this.save();
    return this.data.unlockedItems.length
      + this.data.unlockedWeapons.length
      + this.data.unlockedCharacters.length - before;
  }

  /** True once there is nothing left to unlock. */
  get everythingUnlocked() {
    return this.data.unlockedItems.length >= ITEMS.length
      && this.data.unlockedWeapons.length >= WEAPONS.length
      && this.data.unlockedCharacters.length >= CHARACTERS.length;
  }

  /**
   * Erases the account: Echoes, unlocks, records, options, the lot.
   *
   * Both storage keys go, not just the current one — leaving the pre-rename
   * profile behind would resurrect it on the next boot and make the reset look
   * like it silently failed.
   */
  wipe() {
    this.data = freshProfile();
    memoryFallback = null;
    // Clear both, or a wipe would silently resurrect the pre-rename profile.
    try { localStorage.removeItem(KEY); localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
    this.save();
  }
}

export const profile = new Profile();
