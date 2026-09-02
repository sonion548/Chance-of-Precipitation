import * as THREE from 'three';
import { RARITY, TELEPORTER, ECONOMY } from '../core/config.js';
import { clamp01, damp } from '../core/mathx.js';
import {
  buildChestModel, buildTeleporterModel, buildOrbModel, buildItemDropModel, buildEggModel, buildPortalModel,
} from './models.js';
import { chestCost, eggCost, rollItem } from '../systems/loot.js';
import { EQUIPMENT } from '../data/equipment.js';
import { petById } from '../data/pets.js';
import { ELITE_AFFIXES } from '../data/enemies.js';
import { audio } from '../core/audio.js';

const _v = new THREE.Vector3();

/* ==========================================================================
   CHESTS & SHRINES
   ========================================================================== */
/**
 * Everything you walk up to and press E on.
 *
 * One class, several kinds, because what varies between them is small and
 * specific: what it costs you, and what happens when you pay. Both are single
 * overridable steps (`_pay` and `_payOut`), so a new device is a model, a label
 * and two short methods — and it replicates over the network, saves into the
 * stage packet and appears in the interaction prompt without touching any of
 * that plumbing.
 *
 * The kinds, and the verb each one is for:
 *
 *   chest / large / legendary  gold for a roll, at three price points
 *   shrine                     gold for a coin flip, three times
 *   altar                      *health* for a guaranteed good roll
 *   cache                      free, and it wakes something up
 *   duplicator                 gold to deepen a stack you already have
 *   forge                      spend junk Commons for something better
 *   equipment                  gold for a piece of equipment, swapping yours
 */
const KIND_INFO = {
  chest: { label: 'Chest', table: 'chest', uses: 1 },
  large: { label: 'Large Chest', table: 'large', uses: 1 },
  legendary: { label: 'Legendary Chest', table: 'legendary', uses: 1 },
  shrine: { label: 'Shrine of Chance', table: 'shrine', uses: 3 },
  // Ruin grants no item of its own: it buys a harder beacon fight and a bigger
  // pile on the far side of it, so it is a single deliberate deal, not a habit.
  ruin: { label: 'Shrine of Ruin', table: null, uses: 1 },
  altar: { label: 'Blood Altar', table: 'large', uses: 1, free: true },
  cache: { label: 'Cursed Cache', table: 'large', uses: 1, free: true },
  duplicator: { label: 'Pattern Duplicator', table: null, uses: 1 },
  forge: { label: 'Scrap Forge', table: 'large', uses: 2, free: true },
  /* The pod grants its equipment straight into the slot rather than dropping
     it on the floor.
     A world drop would be the consistent thing to do and the wrong one: an
     equipment pickup is a *swap*, and a swap lying in the grass means walking
     over the thing you already have and losing it by accident. Handing it over
     at the pod makes the trade explicit, and it sidesteps the networked
     item-drop path, which resolves ids against the item catalogue that
     equipment is deliberately not in. */
  equipment: { label: 'Equipment Pod', table: null, uses: 1, localPayout: true },
};

/** Fraction of maximum health the altar asks for. */
const ALTAR_TOLL = 0.35;
/** Commons the forge eats per use. */
const FORGE_COST = 2;

export class Chest {
  constructor(game, kind, position) {
    this.game = game;
    this.kind = kind;             // see KIND_INFO for what each one is
    this.position = position.clone();
    this.opened = false;
    const info = KIND_INFO[kind] || KIND_INFO.chest;
    this.uses = info.uses;
    /* Who resolves the payout.
     *
     * Everything else in this file drops an item on the ground, and the ground
     * belongs to the host — that is what stops one chest paying out twice. A
     * pod does not put anything on the ground: it fills a slot, and the slot
     * belongs to whoever pressed the button. Resolving it on the host would
     * hand a client's equipment to the host, which is precisely the bug the
     * host-owns-payouts rule exists to prevent, running the other way. */
    this.localPayout = !!info.localPayout;
    this.cost = info.free ? 0 : chestCost(kind, game.stageDifficulty ?? game.director.difficulty);
    this.model = buildChestModel(kind);
    this.model.position.copy(this.position);
    this.model.rotation.y = Math.random() * Math.PI * 2;
    game.engine.scene.add(this.model);
    this.lidAngle = 0;
    this.bob = Math.random() * 10;
    this.label = info.label;
    this.table = info.table;
  }

  /** Both shrines share the altar silhouette and the floating orb. */
  get isShrine() { return this.kind === 'shrine' || this.kind === 'ruin'; }

  get interactable() { return !this.opened && this.uses > 0; }

  /**
   * What it costs *you*.
   *
   * `cost` is the stage's price, fixed when the stage was built and identical
   * for everyone in the party. `price` is that after your own items have had
   * their say — a discount belongs to the person paying, not to the chest,
   * which is why it is read live here and never replicated.
   */
  get price() {
    return Math.max(1, Math.round(this.cost * (this.game.priceMultiplier ?? 1)));
  }

  promptText() {
    switch (this.kind) {
      case 'ruin': {
        const bosses = 2 + (this.game.run.bossCountBonus | 0);
        return `${this.label} — ${this.price} gold (${bosses} guardians, +1 item each)`;
      }
      case 'shrine':
        return `${this.label} — ${this.price} gold (${this.uses} left)`;
      case 'altar':
        return `${this.label} — ${Math.round(ALTAR_TOLL * 100)}% of your health, for something worth having`;
      case 'cache':
        return `${this.label} — free. Something is in there with it`;
      case 'duplicator': {
        const n = this.game.inventory?.order.length ?? 0;
        return n
          ? `${this.label} — ${this.price} gold, deepens one item you already carry`
          : `${this.label} — ${this.price} gold (you carry nothing to copy)`;
      }
      case 'forge': {
        const n = this._commonStacks();
        return `${this.label} — ${FORGE_COST} Common items (${n} spare) for one better (${this.uses} left)`;
      }
      case 'equipment': {
        const held = this.game.inventory?.equipment;
        return held
          ? `${this.label} — ${this.price} gold (replaces ${held.name})`
          : `${this.label} — ${this.price} gold`;
      }
      default:
        return `${this.label} — ${this.price} gold`;
    }
  }

  /** Everything the prompt needs to know about whether you can use this. */
  affordable(player) {
    switch (this.kind) {
      case 'altar': return player.health > player.stats.maxHealth * (ALTAR_TOLL + 0.05);
      case 'cache': return true;
      case 'forge': return this._commonStacks() >= FORGE_COST;
      case 'duplicator': return player.gold >= this.price && (this.game.inventory?.order.length ?? 0) > 0;
      default: return player.gold >= this.price;
    }
  }

  /** Total stacks of Common items held — the forge's fuel. */
  _commonStacks() {
    const inv = this.game.inventory;
    if (!inv) return 0;
    let n = 0;
    for (const { item, stacks } of inv.entries()) if (item.rarity === 'common') n += stacks;
    return n;
  }

  /**
   * Takes the price, whatever the price is made of. Returns false if it could
   * not be paid, in which case nothing else happens.
   */
  _pay(player) {
    if (this.kind === 'altar') {
      const toll = player.stats.maxHealth * ALTAR_TOLL;
      if (player.health <= toll + 1) return false;
      // Bypasses `takeDamage` on purpose: armour, barriers and Phoenix Charm
      // have nothing to do with a price you agreed to pay.
      player.health -= toll;
      player.timeSinceDamage = 0;
      this.game.ui.playerDamageNumber(toll);
      this.game.ui.flashHurt(0.8);
      this.game.fx.explosion(this.position.clone().setY(this.position.y + 1.4), 4, 0xff2f5e, 1.1);
      return true;
    }
    if (this.kind === 'forge') {
      const inv = this.game.inventory;
      let left = FORGE_COST;
      // Spend the deepest stacks first, so the forge never takes the last copy
      // of something you might have been building around.
      const commons = inv.entries().filter((e) => e.item.rarity === 'common')
        .sort((a, b) => b.stacks - a.stacks);
      if (commons.reduce((n, e) => n + e.stacks, 0) < FORGE_COST) return false;
      for (const entry of commons) {
        if (left <= 0) break;
        const take = Math.min(left, entry.stacks);
        inv.remove(entry.item.id, take);
        left -= take;
      }
      this.game.player.recomputeStats();
      this.game.fx.explosion(this.position.clone().setY(this.position.y + 1.2), 3.4, 0xffb347, 0.9);
      return true;
    }
    if (this.kind === 'cache') return true;
    if (this.kind === 'duplicator' && !(this.game.inventory?.order.length)) {
      this.game.ui.toast('The duplicator has nothing to copy', '#7d89a3');
      return false;
    }
    return player.spendGold(this.price);
  }

  /**
   * Paying is local; opening is not.
   *
   * You spend your own gold on your own machine — nobody should wait on a round
   * trip to find out whether they could afford a chest. What comes out of it is
   * decided by whoever owns the world, so a chest cannot pay out twice and two
   * players cannot both claim the same roll.
   */
  interact(player) {
    if (!this.interactable) return false;
    if (!this._pay(player)) {
      this.game.ui.showPromptLocked();
      audio.denied();
      return false;
    }
    audio.chestOpen(this.position, this.kind);
    if (this.game.coopClient) {
      this._consume();
      // The pod's payout is yours, so it happens here rather than on the host.
      // The host is still told, because whether it is *open* is shared.
      if (this.localPayout) this._payOut();
      this.game.coop.session.sendHost({ k: 'act', kind: 'chest', i: this.index });
      return true;
    }
    this._consume();
    this._payOut();
    this.game.coop?.onChestState(this.index, this.opened, this.cost);
    return true;
  }

  /** Host side of a teammate's request: they already paid, so just open it. */
  resolve() {
    if (!this.interactable) return false;
    this._consume();
    // A local payout has already happened on the machine that asked for it.
    if (!this.localPayout) this._payOut();
    return true;
  }

  /** Marks it used and moves its price along, without granting anything. */
  _consume() {
    // Multi-use devices (the shrine, the forge) count down and get dearer each
    // time; everything else is spent in one go. Driven by the declared use
    // count rather than by naming kinds, so adding another repeatable device
    // does not mean editing this.
    if (this.uses > 1) {
      this.uses--;
      this.cost = Math.round(this.cost * ECONOMY.shrineCostGrowth);
      return;
    }
    this.uses = 0;
    this.opened = true;
    this.game.run.chestsOpened++;
  }

  _payOut() {
    switch (this.kind) {
      case 'ruin':
        // No item comes out of this one. What you buy is a harder beacon fight
        // and a bigger pile on the other side of it — for everyone, not just you.
        this.game.fx.explosion(this.position.clone().setY(this.position.y + 2.6), 5, 0xff7a47, 1.1);
        this.game.grantRuinBoon();
        return;
      case 'shrine': {
        const win = this.game.rng.next() < 0.42;
        this.game.fx.explosion(this.position.clone().setY(this.position.y + 2.5), 4, win ? 0xd94bff : 0x555a6a, 0.8);
        if (win) this._grantItem();
        else this.game.ui.toast('The shrine takes, and gives nothing', '#7d89a3');
        return;
      }
      case 'cache':
        this._grantItem();
        this._ambush();
        return;
      case 'duplicator':
        this._duplicate();
        return;
      case 'equipment':
        this._grantEquipment();
        return;
      default:
        this._grantItem();
    }
  }

  /**
   * What is in the cache with the item.
   *
   * The point is that free loot has to cost something, and the only currency
   * this game has left at that moment is your position — you are now standing
   * in the middle of a ring of things that were not there a second ago, holding
   * an item you have not picked up yet.
   */
  _ambush() {
    const g = this.game;
    const difficulty = g.director.difficulty;
    const count = 4 + g.rng.int(0, 2);
    const pool = ['husk', 'husk', 'spitter', 'skimmer', 'charger'];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + g.rng.next() * 0.4;
      const at = _v.set(
        this.position.x + Math.cos(a) * 7, 0, this.position.z + Math.sin(a) * 7,
      ).clone();
      at.y = g.arena.groundHeightAt(at.x, at.z) + 0.4;
      g.enemies.spawn(g.rng.pick(pool), at, {
        difficulty,
        // One of them is always an elite: the cache should be a decision, not
        // a tax you stop noticing.
        elite: i === 0 ? g.rng.pick(ELITE_AFFIXES).id : null,
      });
      g.fx.ring(at, 0.3, 2.6, 0xff4d5e, 0.5, 0.8);
    }
    g.engine.addShake(0.35);
    g.ui.toast('THE CACHE WAS NOT EMPTY', '#ff4d5e');
    g.chat?.system('Something came out of the cache with it.', '#ff4d5e');
  }

  /**
   * Deepens a stack you already have.
   *
   * Weighted toward what you already have most of, which sounds like it rewards
   * luck and actually rewards commitment: the duplicator is how a build that is
   * already going somewhere gets there faster, rather than another way to roll
   * the dice.
   */
  _duplicate() {
    const inv = this.game.inventory;
    const entries = inv.entries();
    if (!entries.length) return;
    const total = entries.reduce((n, e) => n + e.stacks, 0);
    let roll = this.game.rng.next() * total;
    let chosen = entries[entries.length - 1];
    for (const e of entries) {
      roll -= e.stacks;
      if (roll <= 0) { chosen = e; break; }
    }
    const spawn = this.position.clone();
    spawn.y += 1.8;
    this.game.spawnItemPickup(chosen.item, spawn);
    this.game.fx.explosion(spawn, 3.2, RARITY[chosen.item.rarity].hex, 0.8);
    this.game.ui.toast(`Duplicating ${chosen.item.name}`, RARITY[chosen.item.rarity].color);
  }

  /**
   * Hands over a piece of equipment, and says what it cost you.
   *
   * Never the one you are already holding — a pod that offers you your own
   * equipment back for full price is a pod that wasted your walk.
   */
  _grantEquipment() {
    const inv = this.game.inventory;
    if (!inv) return;
    const held = inv.equipment;
    const pool = EQUIPMENT.filter((e) => e.id !== held?.id);
    const pick = this.game.rng.pick(pool.length ? pool : EQUIPMENT);
    const dropped = inv.equip(pick.id);
    const spawn = this.position.clone();
    spawn.y += 2.2;
    this.game.fx.explosion(spawn, 3.2, 0xff8a3d, 0.8);
    this.game.ui.toast(
      dropped ? `${pick.name} — dropped ${dropped.name}` : `${pick.name} equipped — X`,
      '#ff8a3d',
    );
    this.game.chat?.system(`Equipment: ${pick.name}. ${pick.desc}`, '#ff8a3d');
  }

  _grantItem() {
    const item = rollItem(this.game.rng, this.table, this.game.player.stats.luck, this.game.profile.data);
    if (!item) return;
    const spawn = this.position.clone();
    spawn.y += this.isShrine ? 2.6 : 1.4;
    this.game.spawnItemPickup(item, spawn);
    this.game.fx.explosion(spawn, 3, RARITY[item.rarity].hex, 0.7);
  }

  update(dt, time) {
    const ud = this.model.userData;

    /* The four devices. Each animates the one part that says what it does:
       the altar's shard drops into the channel when it is taken, the cache's
       lid stays shut but its seams keep leaking, the duplicator's bar scans,
       and the forge's mouth breathes. */
    if (this.kind === 'altar' || this.kind === 'duplicator' || this.kind === 'forge') {
      const spent = this.opened;
      if (ud.orb) {
        const base = this.kind === 'altar' ? 2.15 : this.kind === 'duplicator' ? 1.1 : 2.5;
        ud.orb.position.y = base + Math.sin(time * 1.5 + this.bob) * 0.12;
        ud.orb.rotation.y += dt * 0.8;
        ud.orb.rotation.x += dt * 0.45;
        ud.orb.material.opacity = damp(ud.orb.material.opacity, spent ? 0.1 : 0.75 + Math.sin(time * 3) * 0.15, 4, dt);
        ud.orb.scale.setScalar(spent ? 0.5 : 1);
      }
      if (ud.halo) { ud.halo.rotation.z += dt * 0.6; }
      if (ud.scanBar) {
        // Sweeps the frame, and parks at the bottom once it is spent.
        const t = spent ? 0 : (Math.sin(time * 1.1 + this.bob) * 0.5 + 0.5);
        ud.scanBar.position.y = 0.5 + t * 2.2;
      }
      if (ud.mouth) {
        ud.mouth.material.emissiveIntensity = spent ? 0.2 : 1.2 + Math.sin(time * 4 + this.bob) * 0.5;
      }
      return;
    }
    if (this.kind === 'cache') {
      if (ud.light) {
        ud.light.material.opacity = damp(ud.light.material.opacity, this.opened ? 0.05 : 0.8, 4, dt);
        ud.light.position.y = 1.9 + Math.sin(time * 2.2 + this.bob) * 0.06;
      }
      if (ud.halo) {
        ud.halo.material.opacity = damp(ud.halo.material.opacity,
          this.opened ? 0 : 0.22 + Math.sin(time * 3.4 + this.bob) * 0.14, 4, dt);
      }
      // The lid only comes off once, and stays off.
      this.lidAngle = damp(this.lidAngle, this.opened ? -2.1 : 0, 10, dt);
      if (ud.lid) ud.lid.rotation.x = this.lidAngle;
      // A restless shudder while it is still sealed.
      if (!this.opened) this.model.rotation.z = Math.sin(time * 11 + this.bob) * 0.006;
      return;
    }

    if (this.isShrine) {
      if (ud.orb) {
        ud.orb.position.y = 2.5 + Math.sin(time * 1.6 + this.bob) * 0.18;
        ud.orb.rotation.y += dt * 0.9;
        ud.orb.rotation.x += dt * 0.5;
        ud.orb.material.opacity = this.opened ? 0.12 : 0.7 + Math.sin(time * 3) * 0.15;
      }
      return;
    }
    const target = this.opened ? -1.9 : 0;
    this.lidAngle = damp(this.lidAngle, target, 8, dt);
    if (ud.lid) ud.lid.rotation.x = this.lidAngle;
    if (ud.light) ud.light.material.opacity = this.opened ? 0.08 : 0.55 + Math.sin(time * 2.6 + this.bob) * 0.25;

    // The reliquary has moving parts a plain chest does not: two counter-turning
    // rings, a light shaft, and a halo on the ground. All of it dies back when
    // the chest is spent, so an opened one stops advertising itself from across
    // the arena — which is the only reason the shaft is there at all.
    if (ud.rings) {
      ud.rings.userData.a.rotation.y += dt * 0.55;
      ud.rings.userData.b.rotation.y -= dt * 0.82;
      ud.rings.userData.b.rotation.z = Math.sin(time * 0.6 + this.bob) * 0.2;
      ud.rings.position.y = 2.5 + Math.sin(time * 1.1 + this.bob) * 0.09;
      ud.rings.visible = !this.opened || this.lidAngle > -1.7;
    }
    if (ud.beam) {
      const live = this.opened ? 0 : 0.11 + Math.sin(time * 1.7 + this.bob) * 0.05;
      ud.beam.material.opacity = damp(ud.beam.material.opacity, live, 3, dt);
      ud.beam.rotation.y += dt * 0.22;
    }
    if (ud.halo) {
      ud.halo.material.opacity = damp(ud.halo.material.opacity,
        this.opened ? 0 : 0.3 + Math.sin(time * 2.2 + this.bob) * 0.12, 3, dt);
      ud.halo.rotation.z -= dt * 0.35;
    }
  }

  dispose() {
    this.model.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
    });
    this.model.parent?.remove(this.model);
  }
}

/* ==========================================================================
   BROOD EGG
   ========================================================================== */
/**
 * The recruitment point for brood lizards.
 *
 * Priced against a Large chest on purpose. A chest is power now; an egg is
 * power that compounds with everything you pick up afterwards, but only if you
 * live long enough to pick it up. That is the whole decision.
 */
export class Egg {
  /**
   * Each egg already knows what is in it, and says so.
   *
   * Rolling the species on pickup would make every egg identical until the
   * moment you had already paid; deciding it at stage build and printing the
   * name in the prompt turns a row of eggs into a choice about what your pack
   * is missing.
   */
  constructor(game, position, accent = 0xff8a3d, species = 'lizard', sequence = 0) {
    this.game = game;
    this.position = position.clone();
    this.hatched = false;
    this.accent = accent;
    this.species = species;
    this.sequence = sequence;
    this.def = petById(species);
    // Priced once, here, off the stage's own difficulty. See `eggCost`.
    this.cost = eggCost(game.stageDifficulty ?? game.director.difficulty, sequence);
    // The shell is tinted by the species, and lit from within by whoever is
    // looking at it, so you can read both facts at a glance.
    this.model = buildEggModel(accent, this.def.color);
    this.model.position.copy(this.position);
    this.model.rotation.y = Math.random() * Math.PI * 2;
    game.engine.scene.add(this.model);
    this.bob = Math.random() * 10;
    this.shake = 0;
    this.label = `${this.def.name} Egg`;
  }

  get interactable() { return !this.hatched; }

  /** Stage price after your own discounts. See `Chest.price`. */
  get price() {
    return Math.max(1, Math.round(this.cost * (this.game.priceMultiplier ?? 1)));
  }

  promptText() {
    const owned = this.game.pets.ownedBy(this.game.player).length;
    return `${this.def.icon} ${this.label} — ${this.price} gold  ·  ${this.def.desc}  ·  ${owned} in your pack`;
  }

  interact(player) {
    if (!this.interactable) return false;
    // Eggs are bought with gold and nothing else, so there is no payment step
    // to abstract here the way the chest kinds need one.
    if (!player.spendGold(this.price)) {
      this.game.ui.showPromptLocked();
      audio.denied();
      return false;
    }
    audio.eggHatch(this.position);

    this.hatched = true;
    const spawn = this.position.clone();
    spawn.y += 0.2;
    // The lizard belongs to whoever paid and runs on their machine; only the
    // cracked shell has to be agreed on, so that is all that goes over the wire.
    const pet = this.game.hatchPet(player, spawn, this.species);
    if (this.game.coopClient) this.game.coop.session.sendHost({ k: 'act', kind: 'egg', i: this.index });
    else this.game.coop?.onEggState(this.index);
    this.game.fx.explosion(this.position.clone().setY(this.position.y + 0.7), 3, this.accent, 0.9);
    this.game.fx.burst(this.position.clone().setY(this.position.y + 0.7), 16,
      { color: 0xe6dfc8, speed: 7, size: 0.14, life: 0.8 });
    this.game.ui.toast(pet ? `A ${this.def.name} imprints on you` : 'The egg was empty', '#ff8a3d');
    return true;
  }

  update(dt, time) {
    const ud = this.model.userData;
    if (this.hatched) {
      // Split shell: sink it into the nest and dim the glow out.
      if (ud.shell) {
        ud.shell.scale.y = damp(ud.shell.scale.y, 0.15, 4, dt);
        ud.shell.position.y = damp(ud.shell.position.y, 0.18, 4, dt);
        ud.shell.rotation.z = damp(ud.shell.rotation.z, 0.5, 3, dt);
      }
      if (ud.halo) ud.halo.material.opacity = damp(ud.halo.material.opacity, 0, 3, dt);
      return;
    }
    // Something inside is trying to get out.
    const pulse = 0.5 + Math.sin(time * 2.2 + this.bob) * 0.28;
    if (ud.halo) ud.halo.material.opacity = 0.06 + pulse * 0.09;
    if (ud.veins) {
      for (const v of ud.veins.children) v.material.opacity = 0.25 + pulse * 0.55;
    }
    if (ud.shell) {
      const kick = Math.max(0, Math.sin(time * 0.7 + this.bob) - 0.93) * 9;
      ud.shell.rotation.z = Math.sin(time * 21) * 0.05 * kick;
      ud.shell.position.y = 0.62 + Math.sin(time * 1.5 + this.bob) * 0.02 + kick * 0.03;
    }
  }

  dispose() {
    this.model.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
    });
    this.model.parent?.remove(this.model);
  }
}

/* ==========================================================================
   TELEPORTER
   ========================================================================== */
export class Teleporter {
  constructor(game, position) {
    this.game = game;
    this.position = position.clone();
    this.state = 'idle';          // idle | charging | ready | used
    this.charge = 0;
    this.chargeTime = TELEPORTER.chargeTime;
    this.radius = TELEPORTER.radius;
    this.model = buildTeleporterModel();
    this.model.position.copy(this.position);
    game.engine.scene.add(this.model);

    // Charge-zone boundary ring
    const geo = new THREE.RingGeometry(this.radius - 0.35, this.radius, 72);
    geo.rotateX(-Math.PI / 2);
    this.zone = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x46e0c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.zone.position.copy(this.position);
    this.zone.position.y += 0.1;
    game.engine.scene.add(this.zone);
  }

  get interactable() { return this.state === 'idle' || this.state === 'ready'; }

  promptText() {
    if (this.state === 'idle') return 'Activate the Beacon';
    if (this.state === 'ready') return 'Descend to the next stage';
    return '';
  }

  interact() {
    if (this.state !== 'idle' && this.state !== 'ready') return false;
    if (this.game.coopClient) {
      this.game.coop.session.sendHost({ k: 'act', kind: 'tp' });
      return true;
    }
    if (this.state === 'idle') this.game.startTeleporterEvent(this);
    else this.game.advanceStage();
    this.game.coop?.onTeleporterState();
    return true;
  }

  update(dt, time, player) {
    const ud = this.model.userData;
    if (ud.core) {
      ud.core.rotation.y += dt * 0.6;
      ud.core.rotation.x += dt * 0.3;
      const pulse = this.state === 'charging' ? 0.5 + Math.sin(time * 8) * 0.25 : 0.4;
      ud.core.material.opacity = this.state === 'used' ? 0.1 : pulse;
      ud.core.scale.setScalar(1 + Math.sin(time * 2.4) * 0.06);
    }
    if (ud.ring) {
      ud.ring.rotation.z += dt * (this.state === 'charging' ? 2.4 : 0.5);
      ud.ring.position.y = 2.1 + Math.sin(time * 1.7) * 0.12;
    }
    if (ud.motes) {
      // The plume: a funnel of motes spiralling up out of the ring. Its speed
      // and reach are the Beacon's state — idle drifts, charging races, and a
      // charged Beacon stands in a tall calm column.
      const spin = this.state === 'charging' ? 2.6 : this.state === 'ready' ? 0.9 : 0.5;
      const rise = this.state === 'charging' ? 7.5 : this.state === 'ready' ? 3.2 : 1.8;
      const reach = this.state === 'ready' ? 30 : this.state === 'charging' ? 24 : 15;
      this._plume = (this._plume || 0) + dt;
      const arr = ud.motes.geometry.attributes.position.array;
      const seeds = ud.moteSeeds;
      for (let i = 0; i < seeds.length / 4; i++) {
        const r0 = seeds[i * 4];
        const phase = seeds[i * 4 + 1];
        const speed = seeds[i * 4 + 3];
        // Height cycles independently per mote so the column never pulses as one.
        const h = ((seeds[i * 4 + 2] + this._plume * rise * speed * 0.03) % 1);
        const y = 0.6 + h * reach;
        // Narrows as it climbs, and flares again right at the top.
        const taper = 1 - h * 0.62 + Math.pow(h, 6) * 1.6;
        const a = phase + this._plume * spin * speed * 0.6 - h * 2.4;
        const rr = r0 * taper * (1 + Math.sin(this._plume * 0.8 + phase) * 0.08);
        arr[i * 3] = Math.cos(a) * rr;
        arr[i * 3 + 1] = y;
        arr[i * 3 + 2] = Math.sin(a) * rr;
      }
      ud.motes.geometry.attributes.position.needsUpdate = true;
      const want = this.state === 'used' ? 0 : this.state === 'ready' ? 0.95 : this.state === 'charging' ? 0.85 : 0.6;
      ud.motes.material.opacity = damp(ud.motes.material.opacity, want, 3, dt);
      ud.motes.material.size = this.state === 'ready' ? 1.15 : 0.9;
    }

    if (this.state === 'charging') {
      // Any member of the party holds the ring — one of you can go and fight.
      let inZone = false;
      for (const member of this.game.party()) {
        if (Math.hypot(member.position.x - this.position.x, member.position.z - this.position.z) < this.radius) {
          inZone = true;
          if (member === player) break;
        }
      }
      const localInZone = Math.hypot(player.position.x - this.position.x, player.position.z - this.position.z) < this.radius;
      if (inZone && !this.game.coopClient) this.charge = Math.min(this.chargeTime, this.charge + dt);
      this.zone.material.opacity = damp(this.zone.material.opacity, localInZone ? 0.5 : inZone ? 0.34 : 0.2, 6, dt);
      this.zone.scale.setScalar(1 + Math.sin(time * 3) * 0.006);
      return localInZone;
    }
    this.zone.material.opacity = damp(this.zone.material.opacity, 0, 4, dt);
    return false;
  }

  get chargeFraction() { return clamp01(this.charge / this.chargeTime); }

  dispose() {
    for (const obj of [this.model, this.zone]) {
      obj.traverse?.((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
      });
      obj.parent?.remove(obj);
    }
  }
}

/* ==========================================================================
   RIFT PORTAL
   ========================================================================== */
/**
 * The way out of the rotation.
 *
 * Opens beside the Beacon once a deep enough stage has been cleared, and offers
 * the one thing the descent otherwise never does: an ending. Deliberately a
 * second, separate interactable rather than a prompt on the Beacon — nobody
 * should fall into the final fight while reaching for the next stage.
 */
export class Portal {
  constructor(game, position) {
    this.game = game;
    this.position = position.clone();
    this.used = false;
    this.armed = false;      // only usable once the stage is actually clear
    this.model = buildPortalModel(0xff2f8f);
    this.model.position.copy(this.position);
    this.model.rotation.y = Math.random() * Math.PI * 2;
    this.model.scale.setScalar(0.01);
    game.engine.scene.add(this.model);
    this.grow = 0;
    this.bob = Math.random() * 10;
  }

  get interactable() { return this.armed && !this.used; }

  promptText() {
    return 'Enter the Rift — the Null Sovereign is waiting. There is no way back.';
  }

  interact() {
    if (!this.interactable) return false;
    if (this.game.coopClient) {
      this.game.coop.session.sendHost({ k: 'act', kind: 'portal' });
      return true;
    }
    this.game.enterFinalArena();
    return true;
  }

  update(dt, time) {
    const ud = this.model.userData;
    // Tears open over a couple of seconds once the stage clears.
    this.grow = damp(this.grow, this.armed ? 1 : 0, 2.2, dt);
    this.model.scale.setScalar(Math.max(0.01, this.grow));
    if (ud.swirl) {
      ud.swirl.rotation.z -= dt * 1.6;
      ud.swirl.children.forEach((r, i) => { r.rotation.z += dt * (0.5 + i * 0.4); });
    }
    if (ud.rim) ud.rim.rotation.z += dt * 0.35;
    if (ud.mouth) ud.mouth.position.y = 3.1 + Math.sin(time * 1.3 + this.bob) * 0.1;
    if (ud.glowPane) ud.glowPane.material.opacity = 0.12 + Math.sin(time * 2.4) * 0.06;
    if (ud.motes) {
      ud.motes.rotation.y += dt * 0.25;
      ud.motes.children.forEach((m, i) => {
        m.position.y += Math.sin(time * 1.6 + i) * dt * 0.4;
        m.rotation.x += dt * (0.6 + i * 0.05);
      });
    }
  }

  dispose() {
    this.model.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
    });
    this.model.parent?.remove(this.model);
  }
}

/* ==========================================================================
   PICKUPS
   ========================================================================== */
export class PickupManager {
  constructor(game) {
    this.game = game;
    this.orbs = [];
    this.items = [];
    this.byNetId = new Map();
    this.group = new THREE.Group();
    game.engine.scene.add(this.group);
  }

  spawnGold(position, amount, count = null) {
    const n = count ?? Math.min(6, 1 + Math.floor(amount / 14));
    const per = amount / n;
    for (let i = 0; i < n; i++) {
      const m = buildOrbModel(0xffcf5c, 0.19);
      m.position.copy(position);
      m.position.y += 0.9;
      this.group.add(m);
      this.orbs.push({
        kind: 'gold', value: per, mesh: m,
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 7, 5 + Math.random() * 4, (Math.random() - 0.5) * 7,
        ),
        life: ECONOMY.goldOrbLifetime, grounded: false, seed: Math.random() * 10, delay: 0.25,
      });
    }
  }

  spawnHealth(position, amount) {
    const m = buildOrbModel(0x4be08a, 0.26);
    m.position.copy(position);
    m.position.y += 0.9;
    this.group.add(m);
    this.orbs.push({
      kind: 'health', value: amount, mesh: m,
      velocity: new THREE.Vector3((Math.random() - 0.5) * 5, 6, (Math.random() - 0.5) * 5),
      life: 22, grounded: false, seed: Math.random() * 10, delay: 0.25,
    });
  }

  spawnItem(item, position, opts = {}) {
    const hex = RARITY[item.rarity].hex;
    const m = buildItemDropModel(item, hex, this.game.arena?.theme?.beamOpacity);
    m.position.copy(position);
    this.group.add(m);
    const entry = {
      item, mesh: m, position: m.position,
      velocity: new THREE.Vector3((Math.random() - 0.5) * 3, 5.5, (Math.random() - 0.5) * 3),
      grounded: !!opts.grounded, seed: Math.random() * 10, life: 999,
      netId: opts.netId ?? null, claimed: false,
    };
    this.items.push(entry);
    if (entry.netId) this.byNetId.set(entry.netId, entry);
    return entry;
  }

  /**
   * Removes a networked drop because somebody claimed it.
   * Returns false if it was already gone, which is how the host arbitrates a
   * tie between two players reaching for the same item on the same frame.
   */
  takeNetItem(netId) {
    const entry = this.byNetId.get(netId);
    if (!entry || entry.claimed) return false;
    entry.claimed = true;
    this.byNetId.delete(netId);
    const i = this.items.indexOf(entry);
    if (i >= 0) this._removeItem(entry, i);
    return true;
  }

  update(dt, player, world) {
    const pr = player.stats.pickupRadius;

    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.life -= dt;
      o.delay -= dt;
      if (o.life <= 0) { this._removeOrb(o, i); continue; }

      if (!o.grounded) {
        o.velocity.y += -26 * dt;
        o.mesh.position.addScaledVector(o.velocity, dt);
        const gy = world.groundHeightAt(o.mesh.position.x, o.mesh.position.z) + 0.45;
        if (o.mesh.position.y <= gy) {
          o.mesh.position.y = gy;
          o.velocity.multiplyScalar(0.3);
          if (Math.abs(o.velocity.y) < 1.4) o.grounded = true; else o.velocity.y = Math.abs(o.velocity.y);
        }
      } else {
        o.mesh.position.y += Math.sin(this.game.time * 3 + o.seed) * dt * 0.35;
      }
      o.mesh.rotation.y += dt * 2.2;

      // Gold always finds its way home after a beat so kills never feel wasted;
      // health orbs still have to be walked over, which keeps them a decision.
      const d = o.mesh.position.distanceTo(player.position);
      const homing = o.kind === 'gold' ? o.life < ECONOMY.goldOrbLifetime - 1.0 : false;
      if (o.delay <= 0 && (homing || d < pr + (o.magnetised ? 6 : 0))) {
        o.magnetised = true;
        _v.copy(player.chestPosition).sub(o.mesh.position);
        const dist = _v.length();
        const pull = homing ? 14 + dist * 1.6 : 26 + (pr - dist) * 5;
        o.mesh.position.addScaledVector(_v.divideScalar(dist), Math.min(dist, pull * dt));
        o.grounded = true;
        if (dist < 1.1) {
          if (o.kind === 'gold') {
            const g = player.addGold(o.value);
            this.game.ui.goldNumber(o.mesh.position, g);
            this.game.inventory?.trigger('onGold', { amount: g, position: o.mesh.position });
          } else {
            player.heal(o.value, 'Health Orb');
          }
          this.game.fx.pickup(o.mesh.position, o.kind === 'gold' ? 0xffcf5c : 0x4be08a);
          this._removeOrb(o, i);
          continue;
        }
      }
      // Fade out near the end of life.
      if (o.life < 3) {
        const f = o.life / 3;
        o.mesh.userData.core.material.opacity = 0.95 * f;
        o.mesh.userData.halo.material.opacity = 0.16 * f;
      }
    }

    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (!it.grounded) {
        it.velocity.y += -26 * dt;
        it.mesh.position.addScaledVector(it.velocity, dt);
        const gy = world.groundHeightAt(it.mesh.position.x, it.mesh.position.z) + 1.1;
        if (it.mesh.position.y <= gy) { it.mesh.position.y = gy; it.grounded = true; }
      } else {
        it.mesh.position.y += Math.sin(this.game.time * 1.8 + it.seed) * dt * 0.3;
      }
      const ud = it.mesh.userData;
      // Face the camera so the icon is legible from any approach angle.
      ud.billboard.quaternion.copy(this.game.engine.camera.quaternion);
      ud.billboard.position.y = Math.sin(this.game.time * 1.6 + it.seed) * 0.06;
      ud.halo.scale.setScalar(1 + Math.sin(this.game.time * 3 + it.seed) * 0.08);
      if (ud.plinthGlow) {
        ud.plinthGlow.material.opacity = 0.6 + Math.sin(this.game.time * 2.6 + it.seed) * 0.25;
        ud.plinthGlow.rotation.z += dt * 0.8;
      }

      if (it.mesh.position.distanceTo(player.position) < 2.2 && !it.claimed && !it.requested) {
        // In co-op the host decides who got there first; until it answers, the
        // drop stays on the ground rather than being granted twice.
        if (it.netId && this.game.coopClient) {
          it.requested = true;
          this.game.coop.session.sendHost({ k: 'pick', id: it.netId });
          continue;
        }
        if (it.netId && this.game.coop?.isHost && !this.takeNetItem(it.netId)) continue;
        if (it.netId && this.game.coop?.isHost) {
          this.game.coop.session.send({ k: 'take', id: it.netId, by: this.game.coop.session.id });
          this.game.collectItem(it.item);
          this.game.fx.pickup(it.mesh.position, RARITY[it.item.rarity].hex);
          continue;                                   // takeNetItem already removed it
        }
        this.game.collectItem(it.item);
        this.game.fx.pickup(it.mesh.position, RARITY[it.item.rarity].hex);
        this._removeItem(it, i);
      }
    }
  }

  _removeOrb(o, i) {
    o.mesh.traverse((c) => { if (c.material) c.material.dispose(); if (c.geometry) c.geometry.dispose(); });
    this.group.remove(o.mesh);
    this.orbs.splice(i, 1);
  }

  _removeItem(it, i) {
    it.mesh.traverse((c) => { if (c.material) c.material.dispose(); if (c.geometry) c.geometry.dispose(); });
    this.group.remove(it.mesh);
    this.items.splice(i, 1);
  }

  clear() {
    for (const o of this.orbs) { this.group.remove(o.mesh); }
    for (const i of this.items) { this.group.remove(i.mesh); }
    this.orbs.length = 0;
    this.items.length = 0;
    this.byNetId.clear();
  }
}
