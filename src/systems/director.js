import { DIRECTOR, DIFFICULTY, PARTY } from '../core/config.js';
import { ENEMIES, BOSSES, ELITE_AFFIXES } from '../data/enemies.js';
import { clamp } from '../core/mathx.js';
import { bossesForTheme } from '../world/themes.js';

/**
 * The difficulty engine.
 *
 * A coefficient rises continuously with elapsed time and steps up per stage. It
 * feeds enemy health and damage, gold values, chest prices, and the rate at
 * which the director earns credits to spend on spawns — so surviving longer is
 * uniformly harder rather than harder in one dimension only.
 */
export class Director {
  constructor(game, modeMultiplier = 1, spawnMultiplier = 1) {
    this.game = game;
    this.modeMultiplier = modeMultiplier;
    this.spawnMultiplier = spawnMultiplier;
    this.credits = 0;
    this.nextWaveIn = 7;          // a beat of quiet at the start of a run
    this.difficulty = 1;
    this.elapsed = 0;
    this.stagesCleared = 0;
    this.eventMultiplier = 1;     // raised during the teleporter event
    /* Set the moment the beacon finishes charging, and held for the rest of
       the stage. Whatever is on the ground is the fight you finish the
       guardian with, and once it is down the stage is genuinely quiet — time
       to spend the gold rather than another forty seconds of husks between you
       and the chest. The clock is deliberately *not* stopped with it: standing
       on a charged beacon must not be a way to pause the difficulty ramp. */
    this.spawnsHalted = false;
    this.paused = false;
    this.totalSpawned = 0;
    this.stageTime = 0;
  }

  /** How much of the extra pressure a full party earns. 1 player = 1. */
  get partyScale() {
    return 1 + (this.game.partySize - 1) * PARTY.difficultyPerPlayer;
  }

  /** Spawn volume multiplier from party size, kept separate from difficulty. */
  get partyVolume() {
    return 1 + (this.game.partySize - 1) * PARTY.creditsPerPlayer;
  }

  /** difficulty = (1 + timeScalar × minutes) × stageMult^cleared × mode × party */
  computeDifficulty() {
    const minutes = this.elapsed / 60;
    const timePart = 1 + DIFFICULTY.timeScalar * minutes;
    const stagePart = Math.pow(DIFFICULTY.stageMult, this.stagesCleared);
    return timePart * stagePart * this.modeMultiplier * this.partyScale;
  }

  /** Ceiling on banked credits, so a bad minute cannot snowball into an unplayable one. */
  get creditCap() {
    return (DIRECTOR.creditCapBase + DIRECTOR.creditCapPerDifficulty * this.difficulty)
      * this.spawnMultiplier * this.partyVolume;
  }

  /** Population cap ramps with difficulty rather than sitting at the ceiling from minute one. */
  get activeEnemyCap() {
    const party = 1 + (this.game.partySize - 1) * PARTY.capPerPlayer;
    return Math.min(
      Math.round(DIRECTOR.maxActiveEnemies * party),
      Math.round((DIRECTOR.activeEnemiesBase + DIRECTOR.activeEnemiesPerDifficulty * (this.difficulty - 1))
        * this.spawnMultiplier * party),
    );
  }

  get tier() {
    const d = this.difficulty;
    let best = DIFFICULTY.tiers[0];
    for (const t of DIFFICULTY.tiers) if (d >= t.at) best = t;
    return best;
  }

  /** 0..1 progress toward the next named difficulty tier, for the HUD meter. */
  get tierProgress() {
    const tiers = DIFFICULTY.tiers;
    const d = this.difficulty;
    for (let i = 0; i < tiers.length; i++) {
      if (d < tiers[i].at) {
        const lo = i === 0 ? 1 : tiers[i - 1].at;
        return clamp((d - lo) / (tiers[i].at - lo), 0, 1);
      }
    }
    return 1;
  }

  update(dt, player, arena) {
    if (this.paused) return;
    this.elapsed += dt;
    this.stageTime += dt;
    this.difficulty = this.computeDifficulty();

    // Each new arena opens at reduced pressure so the player can read the space
    // and reach a chest before the pack arrives.
    const warmup = Math.min(1, 0.45 + this.stageTime / 26);
    const rate = DIRECTOR.creditRateBase * (1 + (this.difficulty - 1) * DIRECTOR.creditRateGrowth)
      * this.eventMultiplier * warmup * this.spawnMultiplier * this.partyVolume;
    this.credits += rate * dt;

    // Cap the bank. Without this, a player who falls behind keeps banking credits
    // while the arena fills, and the next wave is bigger than the one they could
    // not clear — the difficulty spike compounds instead of plateauing.
    this.credits = Math.min(this.credits, this.creditCap);

    this.nextWaveIn -= dt;
    if (this.nextWaveIn > 0) return;

    const [lo, hi] = DIRECTOR.waveInterval;
    this.nextWaveIn = this.game.rng.range(lo, hi) / Math.max(0.6, this.eventMultiplier);

    // The interval is still rolled above, so lifting the halt does not dump a
    // wave on the first frame it comes back.
    if (this.spawnsHalted) return;
    if (this.game.enemies.aliveCount >= this.activeEnemyCap) return;
    this._spawnWave(player, arena);
  }

  _availableCards() {
    const stage = this.game.run.stage;
    return ENEMIES.filter((e) => (e.minStage ?? 1) <= stage);
  }

  _spawnWave(player, arena) {
    const rng = this.game.rng;
    const cards = this._availableCards();
    if (!cards.length) return;

    // Pick one enemy type for the wave, weighted toward what we can afford.
    const affordable = cards.filter((c) => c.cost <= this.credits);
    const pool = affordable.length ? affordable : [cards[0]];
    const table = {};
    for (const c of pool) {
      // Favour costlier enemies as difficulty climbs so waves do not stay trivial.
      const costBias = Math.pow(c.cost / 10, Math.min(1.1, (this.difficulty - 1) * 0.22));
      table[c.id] = c.weight * costBias;
    }
    const chosenId = rng.weighted(table);
    const card = pool.find((c) => c.id === chosenId) || pool[0];

    // Elites become possible once the ramp gets going.
    const eliteChance = this.difficulty < DIRECTOR.eliteUnlockDifficulty
      ? 0
      : Math.min(DIRECTOR.eliteChanceMax, (this.difficulty - DIRECTOR.eliteUnlockDifficulty) * 0.06);
    // Spend up to ~55% of the bank on one wave so credits smooth out over time.
    const budget = this.credits * rng.range(0.35, 0.62);
    let count = Math.max(1, Math.floor(budget / card.cost));
    count = Math.min(count, 9, this.activeEnemyCap - this.game.enemies.aliveCount);
    if (count <= 0) return;

    const anchor = arena.findSpawnPoint(rng, {
      minDist: DIRECTOR.spawnMinDistance,
      maxDist: DIRECTOR.spawnMaxDistance,
      avoid: player.position,
    });

    let spent = 0;
    for (let i = 0; i < count; i++) {
      const isElite = rng.next() < eliteChance && this.credits - spent > card.cost * DIRECTOR.eliteCostMultiplier;
      const affix = isElite ? rng.pick(ELITE_AFFIXES).id : null;
      const spread = 3.2 + count * 0.5;
      const p = anchor.clone();
      p.x += rng.range(-spread, spread);
      p.z += rng.range(-spread, spread);
      p.y = arena.groundHeightAt(p.x, p.z);
      if (arena.isInsideSolid(p.x, p.y + 1, p.z, 0.4)) p.copy(anchor);

      const enemy = this.game.enemies.spawn(card.id, p, {
        difficulty: this.difficulty,
        elite: affix,
      });
      if (!enemy) continue;
      spent += card.cost * (isElite ? DIRECTOR.eliteCostMultiplier : 1);
      this.totalSpawned++;
      this.game.fx.ring(p, 0.4, 2.4, isElite ? enemy.elite.color : card.accent, 0.5, 0.8);
      if (this.credits - spent < card.cost) break;
    }
    this.credits = Math.max(0, this.credits - spent);
  }

  /**
   * Which boss guards this stage.
   *
   * Drawn at random from the arena's own shortlist rather than cycled by stage
   * number, so the same place can hand you a different fight and the fight
   * always suits the place — the Fulgurant belongs over the Spires, the Choir
   * belongs on the Flats. A theme with no shortlist falls back to the roster.
   */
  bossForStage() {
    const list = bossesForTheme(this.game.arena?.theme);
    const pool = list ? list.map((id) => BOSSES.find((b) => b.id === id)).filter(Boolean) : BOSSES;
    return this.game.rng.pick(pool.length ? pool : BOSSES);
  }

  spawnStageBoss(arena, player) {
    const def = this.bossForStage();
    const p = arena.findSpawnPoint(this.game.rng, { minDist: 18, maxDist: 30, avoid: player.position });
    const boss = this.game.enemies.spawn(def.id, p, {
      difficulty: this.difficulty,
      healthMult: 1,
      elite: this.difficulty > 4 ? this.game.rng.pick(ELITE_AFFIXES).id : null,
    });
    if (boss) {
      this.game.fx.explosion(p, 12, def.accent, 2);
      this.game.engine.addShake(0.55);
    }
    return boss;
  }

  onStageCleared() {
    this.stagesCleared++;
    this.stageTime = 0;
    this.credits = Math.min(this.credits, 24);
    this.nextWaveIn = 6;
    // A new arena spawns again, whatever the last one ended up doing.
    this.spawnsHalted = false;
  }
}
