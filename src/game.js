import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Input, isTextTarget } from './core/input.js';
import { RNG } from './core/rng.js';
import { TELEPORTER, PLAYER, MINIONS, RARITY, COOP } from './core/config.js';

import { Arena } from './world/arena.js';
import { Player } from './entities/player.js';
import { EnemyManager } from './entities/enemy.js';
import { ProjectileManager } from './entities/projectiles.js';
import { Chest, Teleporter, PickupManager, Egg } from './entities/interactables.js';
import { MinionManager } from './entities/minion.js';
import { characterById } from './data/characters.js';
import { itemById } from './data/items.js';
import { Coop } from './net/coop.js';

import { FX } from './systems/fx.js';
import { Combat } from './systems/combat.js';
import { Inventory } from './systems/inventory.js';
import { Director } from './systems/director.js';
import { rollItem } from './systems/loot.js';

import { HUD } from './ui/hud.js';
import { Menus } from './ui/menus.js';

import { profile } from './meta/save.js';
import { computeEchoes, runModeById } from './meta/progression.js';

const _v = new THREE.Vector3();

/**
 * Owns the world, the run, and the frame loop. Systems talk to each other
 * through this object rather than to one another directly.
 */
export class Game {
  constructor(container) {
    this.engine = new Engine(container);
    this.input = new Input(this.engine.renderer.domElement);
    this.profile = profile;
    this.rng = new RNG(Date.now());

    this.fx = new FX(this.engine.scene);
    this.fxApi = this.fx;
    this.engine.onQualityChange = (level) => { this.fx.lightScale = level >= 2 ? 1 : level >= 1 ? 0.5 : 0; };

    this.hud = new HUD(this);
    this.ui = this.hud;                 // systems address floating text via game.ui
    this.coop = new Coop(this);
    this.menus = new Menus(this);

    this.state = 'menu';                // menu | running | paused | dead
    this.paused = true;
    this.time = 0;
    this.frame = 0;

    this.chests = [];
    this.eggs = [];
    this.teleporter = null;
    this.arena = null;
    this.player = null;

    // Losing pointer lock mid-run means the player hit Esc, so pause. If lock was
    // never granted at all (embedded frames, some kiosk setups), keep playing
    // rather than trapping them on the pause screen.
    this.input.onUnlock = () => {
      if (this.state === 'running' && this.input.everLocked) this.pause();
    };

    window.addEventListener('keydown', (e) => this._onKey(e));
    document.addEventListener('click', () => {
      // Clicking the canvas while a run is live re-acquires pointer lock.
      if (this.state === 'running' && !this.input.locked && this.menus.current === 'none') {
        this.input.requestLock();
      }
    });

    this._loop = this._loop.bind(this);
    this._lastFrame = performance.now();
  }

  // ==================================================================== run
  /**
   * `opts.coopClient` means somebody else owns the world: skip the director,
   * do not generate a stage, and wait to be told what the arena looks like.
   */
  startRun(opts = {}) {
    this._teardownRun();
    this.coopClient = !!opts.coopClient;
    this.coop?.onRunStart();

    const mode = runModeById(opts.mode || this.profile.data.runMode);
    this.rng = new RNG(Date.now() ^ (Math.random() * 0xffffffff));
    this.run = {
      time: 0,
      stage: 1,
      stagesCleared: 0,
      kills: 0,
      eliteKills: 0,
      bossKills: 0,
      goldEarned: 0,
      chestsOpened: 0,
      mode: mode.id,
      killedBy: null,
      // Scratch space items persist values in (Eclipse Crown, Infusion Core, …)
      infusion: 0,
      crown: 0,
      discCharge: 0,
      frostStacks: 0,
      // Shrine of Ruin: more bosses at the beacon, more boss loot for everyone.
      bossCountBonus: 0,
      bossItemBonus: 0,
    };

    this.director = new Director(this, mode.mult, mode.spawnMult ?? 1);
    this.enemies = new EnemyManager(this);
    this.projectiles = new ProjectileManager(this);
    this.pickups = new PickupManager(this);
    this.minions = new MinionManager(this);
    this.inventory = new Inventory(this);

    // A client has no stage until the host sends one, but it still needs an
    // arena to stand in — it gets replaced the moment the stage packet lands.
    this._buildStage(1, this.coopClient ? { pending: true } : null);

    this.player = new Player(this, this.profile.data.equippedCharacter);
    this.player.position.copy(this.arena.findSpawnPoint(this.rng, { minDist: 0, maxDist: 12 }));
    this.player.position.y += 0.2;
    this.player.snapCamera();

    this.combat = new Combat(this);
    this.combat.setCharacter(this.profile.data.equippedCharacter);
    this.combat.equip(this.profile.data.equippedWeapon);

    this.hud.buildAbilities(this.combat.weapon, this.combat.character);
    this.hud.show();
    this.hud.lastInventorySignature = '';
    this.menus.hide();

    this.state = 'running';
    this.paused = false;
    this.time = 0;
    this._lastFrame = performance.now();
    this.input.requestLock();
    this.hud.toast(`${this.player.char.name} — ${this.arena.theme.name}`, '#46e0c0');
    if (this.coop?.isHost) this.coop.onStageBuilt();
  }

  _teardownRun() {
    this.enemies?.clear();
    this.projectiles?.clear();
    this.pickups?.clear();
    this.minions?.clear();
    for (const c of this.chests || []) c.dispose();
    this.chests = [];
    for (const e of this.eggs || []) e.dispose();
    this.eggs = [];
    this.teleporter?.dispose();
    this.teleporter = null;
    if (this.player) {
      this.player.model.parent?.remove(this.player.model);
      this.player = null;
    }
    this.arena?.dispose();
    this.arena = null;
    this.coop?._teardownRemotes();
    this.hud.clearFloaters();
  }

  /**
   * Builds (or rebuilds) the arena and its interactables for a stage.
   *
   * The arena is generated from a single explicit seed rather than from the run
   * RNG's running state. That is what lets a co-op client rebuild the host's
   * arena exactly — same seed, same props, same colliders — while everything
   * placed *on* it (chests, eggs, the beacon) is sent over the wire instead,
   * because those carry state that has to agree, not just geometry.
   */
  _buildStage(stage, layout = null) {
    // A client waiting on the host builds one agreed placeholder rather than an
    // arena of its own: an arena only it can see is an arena it stands on at a
    // height nobody else believes in, which is exactly how a teammate ends up
    // buried to the waist or hovering.
    const seed = layout?.pending
      ? COOP.pendingSeed
      : (layout?.seed ?? this.rng.int(1, 0x7ffffffe));
    this.stageSeed = seed;
    this.stagePending = !!layout?.pending;
    this.arena?.dispose();
    this.arena = new Arena(this.engine.scene, seed, stage);
    this.engine.setTheme(this.arena.theme);

    for (const c of this.chests) c.dispose();
    this.chests = [];
    for (const e of this.eggs) e.dispose();
    this.eggs = [];
    this.teleporter?.dispose();
    this.teleporter = null;
    this.stageCleared = false;
    this.bossRefs = [];

    if (layout?.pending) return;              // waiting on the host's packet
    if (layout) { this._placeFromLayout(layout); return; }

    // Interactable placement: mostly ordinary chests, with rarer, richer options.
    const eggCount = this.rng.int(MINIONS.eggsPerStage[0], MINIONS.eggsPerStage[1]);
    const chestCount = 6 + this.rng.int(0, 3) + Math.min(3, stage - 1);
    const points = this.arena.scatterPoints(this.rng, chestCount + 5 + eggCount, { minSeparation: 13, minRadius: 17 });

    let i = 0;
    for (; i < chestCount && i < points.length; i++) {
      let kind = 'chest';
      const roll = this.rng.next();
      if (roll < 0.14 + stage * 0.015) kind = 'large';
      if (roll > 0.975) kind = 'legendary';
      this.chests.push(new Chest(this, kind, points[i]));
    }
    const shrines = 1 + (this.rng.next() < 0.45 ? 1 : 0);
    for (let s = 0; s < shrines && i < points.length; s++, i++) {
      this.chests.push(new Chest(this, 'shrine', points[i]));
    }
    // The Shrine of Ruin stays rare, and never on the opening stage: it is a
    // choice about the beacon fight, and stage one has not shown you one yet.
    if (stage > 1 && this.rng.next() < 0.5 && i < points.length) {
      this.chests.push(new Chest(this, 'ruin', points[i]));
      i++;
    }
    // Eggs glow in the recruiting character's colour, so a hatchling reads as
    // yours from across the arena the moment it appears.
    const accent = this.player?.char?.accent
      ?? characterById(this.profile.data.equippedCharacter)?.accent
      ?? 0xff8a3d;
    for (let e = 0; e < eggCount && i < points.length; e++, i++) {
      this.eggs.push(new Egg(this, points[i], accent));
    }
    this.chests.forEach((c, idx) => { c.index = idx; });
    this.eggs.forEach((e, idx) => { e.index = idx; });

    const tpPoint = this.arena.findSpawnPoint(this.rng, { minDist: 30, maxDist: 60 });
    this.teleporter = new Teleporter(this, tpPoint);
  }

  /** Client side of the above: same ground, the host's furniture. */
  _placeFromLayout(layout) {
    const accent = this.player?.char?.accent
      ?? characterById(this.profile.data.equippedCharacter)?.accent
      ?? 0xff8a3d;
    layout.chests.forEach((c, idx) => {
      const chest = new Chest(this, c.k, _v.set(c.x, c.y, c.z));
      chest.index = idx;
      chest.cost = c.cost;
      chest.uses = c.uses;
      chest.opened = !!c.o;
      this.chests.push(chest);
    });
    layout.eggs.forEach((e, idx) => {
      const egg = new Egg(this, _v.set(e.x, e.y, e.z), accent);
      egg.index = idx;
      egg.hatched = !!e.h;
      this.eggs.push(egg);
    });
    this.teleporter = new Teleporter(this, _v.set(layout.tp.x, layout.tp.y, layout.tp.z));
    this.teleporter.state = layout.tp.state || 'idle';
    this.teleporter.charge = layout.tp.charge || 0;
  }

  /* ------------------------------------------------------ co-op replication */
  buildStagePacket() {
    return {
      k: 'stage',
      stage: this.run.stage,
      seed: this.stageSeed,
      // The seed is the instruction; the hash is the receipt. A client that
      // rebuilds and gets a different number knows immediately, instead of
      // finding out when a teammate walks through a wall that is not there.
      th: this.arena.terrainHash(),
      bosses: this.run.bossCountBonus | 0,
      bossItems: this.run.bossItemBonus | 0,
      chests: this.chests.map((c) => ({
        k: c.kind, x: c.position.x, y: c.position.y, z: c.position.z,
        cost: c.cost, uses: c.uses, o: c.opened ? 1 : 0,
      })),
      eggs: this.eggs.map((e) => ({ x: e.position.x, y: e.position.y, z: e.position.z, h: e.hatched ? 1 : 0 })),
      tp: {
        x: this.teleporter.position.x, y: this.teleporter.position.y, z: this.teleporter.position.z,
        state: this.teleporter.state, charge: this.teleporter.charge,
      },
    };
  }

  applyStagePacket(m) {
    const advancing = this.run.stage !== m.stage || this.stageSeed !== m.seed || this.stagePending;
    this.run.stage = m.stage;
    if (typeof m.bosses === 'number') this.run.bossCountBonus = m.bosses;
    if (typeof m.bossItems === 'number') this.run.bossItemBonus = m.bossItems;
    this.enemies.clear();
    this.projectiles.clear();
    this.pickups.clear();
    this._buildStage(m.stage, m);
    this._verifyTerrain(m.th);
    if (!advancing) return;

    const p = this.player;
    if (p) {
      p.position.copy(this.arena.findSpawnPoint(this.rng, { minDist: 0, maxDist: 10 }));
      p.position.y += 0.2;
      p.velocity.set(0, 0, 0);
      p.snapCamera();
      if (p.dead) this.revivePlayer(1);
      else p.heal(p.stats.maxHealth * 0.25, 'Descent');
    }
    this.minions.regroup();
    this.hud.setBoss(null);
    this.hud.setObjective(null);
    this.hud.toast(`${this.arena.theme.name} — Stage ${this.run.stage}`, '#46e0c0');
    this.engine.addShake(0.5);
  }

  /**
   * Checks the arena we just built against the one the host built.
   *
   * Same seed and same code means the same ground, so a mismatch is a real
   * defect somewhere — not something to paper over silently while everyone
   * wonders why a teammate is knee-deep in the floor. Say so, and ask the host
   * for the stage again in case what arrived was mangled rather than wrong.
   */
  _verifyTerrain(expected) {
    if (typeof expected !== 'number' || !this.arena) return true;
    if (this._terrainSeedChecked !== this.stageSeed) {
      this._terrainSeedChecked = this.stageSeed;
      this._terrainRetried = false;
    }
    const mine = this.arena.terrainHash();
    if (mine === expected) return true;

    console.warn(`Terrain mismatch: host ${expected}, local ${mine} (seed ${this.stageSeed}, stage ${this.run.stage})`);
    if (this._terrainRetried) {
      // The seed built different ground twice, so the packet was never the
      // problem. Nothing left to do but be loud about it.
      this.hud.toast('Terrain still out of sync — tell the host', '#ff4d5e');
      return false;
    }
    this._terrainRetried = true;
    this.hud.toast('Terrain out of sync — resyncing with the host', '#ffb347');
    this.coop?.requestStage(true);
    return false;
  }

  applyDirectorSnapshot(difficulty, time) {
    if (this.director) this.director.difficulty = difficulty;
    if (typeof time === 'number') this.run.time = time;
  }

  applyChestState(index, opened, cost) {
    const chest = this.chests[index];
    if (!chest) return;
    chest.opened = !!opened;
    if (typeof cost === 'number') chest.cost = cost;
    if (opened && chest.isShrine) chest.uses = 0;
  }

  applyEggState(index) {
    const egg = this.eggs[index];
    if (egg) egg.hatched = true;
  }

  applyTeleporterState(m) {
    const tp = this.teleporter;
    if (!tp) return;
    const was = tp.state;
    tp.state = m.state;
    tp.charge = m.charge ?? tp.charge;
    if (was !== 'ready' && tp.state === 'ready') this.hud.toast('STAGE CLEAR', '#ffb347');
    if (was === 'idle' && tp.state === 'charging') this.hud.toast('BEACON ACTIVE — hold the ring', '#46e0c0');
  }

  /** A teammate asked to use something. Only the host answers. */
  applyRemoteAct(m, from) {
    if (m.kind === 'chest') {
      const chest = this.chests[m.i];
      if (!chest || !chest.interactable) return;
      chest.resolve(from);
      this.coop.onChestState(m.i, chest.opened, chest.cost);
    } else if (m.kind === 'egg') {
      const egg = this.eggs[m.i];
      if (!egg || egg.hatched) return;
      egg.hatched = true;
      this.coop.onEggState(m.i);
    } else if (m.kind === 'tp') {
      const tp = this.teleporter;
      if (!tp) return;
      if (tp.state === 'idle') this.startTeleporterEvent(tp);
      else if (tp.state === 'ready') this.advanceStage();
      this.coop.onTeleporterState();
    }
  }

  applyRemotePickup(dropId, from) {
    const taken = this.pickups.takeNetItem(dropId);
    if (!taken) return;
    this.coop.session.send({ k: 'take', id: dropId, by: from });
  }

  spawnNetItemDrop(itemId, position, netId) {
    const item = itemById(itemId);
    if (!item) return null;
    return this.pickups.spawnItem(item, position.clone(), { netId, grounded: true });
  }

  removeNetDrop(netId) { this.pickups.takeNetItem(netId); }

  /** The host says the drop is yours: take it. */
  claimNetDrop(netId) {
    const entry = this.pickups.byNetId.get(netId);
    if (!entry) return;
    const item = entry.item;
    const at = entry.mesh.position.clone();
    if (!this.pickups.takeNetItem(netId)) return;
    this.collectItem(item);
    this.fx.pickup(at, RARITY[item.rarity].hex);
  }

  /** Rebuilds a teammate's lizards from their state stream: puppets, no AI. */
  applyRemoteMinions(peerId, list, owner) {
    if (!owner) return;
    this.minions.applyRemote(peerId, list, owner);
  }

  spawnRemoteShot(m) {
    if (m.kind === 'beam') {
      this.fx.beam(_v.set(m.x, m.y, m.z).clone(), new THREE.Vector3(m.x2, m.y2, m.z2), m.c, 0.09, 0.035);
      this.fx.muzzle(_v.set(m.x, m.y, m.z), new THREE.Vector3(m.dx, m.dy, m.dz), m.c, 1);
      return;
    }
    // A harmless twin of the shooter's projectile: it collides and leaves
    // impacts so the shot reads, but damageEnemy ignores a zero payload.
    this.projectiles.spawn({
      position: _v.set(m.x, m.y, m.z).clone(),
      velocity: new THREE.Vector3(m.dx, m.dy, m.dz).multiplyScalar(m.sp),
      damage: 0, proc: 0, radius: m.r ?? 0.2, life: m.l ?? 3,
      gravity: m.g ?? 0, color: m.c, trail: m.tr ?? 0, glow: m.gl ?? 1,
      source: 'Ally',
    });
  }

  spawnEnemyProjectileRaw(spec) {
    this.projectiles.spawn({
      position: _v.set(spec.x, spec.y, spec.z).clone(),
      velocity: new THREE.Vector3(spec.dx, spec.dy, spec.dz),
      damage: spec.damage, radius: spec.radius, life: spec.life, gravity: spec.gravity,
      color: spec.color, hostile: true, splash: spec.splash, pierce: spec.pierce,
      trail: 0.8, glow: 1.6, source: spec.source,
    });
  }

  revivePlayer(healthFraction) {
    const p = this.player;
    if (!p) return;
    p.dead = false;
    p.health = Math.max(1, p.stats.maxHealth * healthFraction);
    p.barrier = 0;
    p.invulnerable = 2;
    p.velocity.set(0, 0, 0);
    p.rig.deathTime = 0;
    this.state = 'running';
    this.fx.ring(p.position, 0.5, 5, 0x4be08a, 0.6, 1);
    this.fx.explosion(p.chestPosition, 3, 0x4be08a, 0.7);
    this.hud.toast('BACK ON YOUR FEET', '#4be08a');
  }

  /** Everyone is down (or the host said the run is over). */
  finishCoopRun() {
    if (this.state === 'menu') return;
    this._finishRun(false);
  }

  /** Who the enemies are allowed to fight. */
  party() {
    const list = this.coop?.active ? this.coop.party() : null;
    if (list && list.length) return list;
    return this.player ? [this.player] : [];
  }

  advanceStage() {
    const p = this.player;
    this.run.stage++;
    this.run.stagesCleared++;
    this.director.onStageCleared();

    this.enemies.clear();
    this.projectiles.clear();
    this.pickups.clear();

    this.hud.setBoss(null);
    this._buildStage(this.run.stage);

    p.position.copy(this.arena.findSpawnPoint(this.rng, { minDist: 0, maxDist: 10 }));
    p.position.y += 0.2;
    p.velocity.set(0, 0, 0);
    p.snapCamera();
    p.heal(p.stats.maxHealth * 0.25, 'Descent');
    // The brood comes down with you, whole — they are a purchase, not a rental.
    this.minions.regroup();

    this.director.eventMultiplier = 1;
    this.hud.setObjective(null);
    this.hud.toast(`${this.arena.theme.name} — Stage ${this.run.stage}`, '#46e0c0');
    this.engine.addShake(0.5);
    // Descending is also how a downed party gets back on its feet.
    if (p.dead) this.revivePlayer(1);
    this.coop?.onStageBuilt();
  }

  // ==================================================================== teleporter event
  startTeleporterEvent(tp) {
    if (tp.state !== 'idle') return;
    tp.state = 'charging';
    this.coop?.onTeleporterState();
    this.director.eventMultiplier = 2.15;
    // One guardian normally; every Shrine of Ruin paid for this stage adds
    // another. That is the whole bargain the shrine offers — the extra items
    // are on the other side of an extra boss.
    const count = Math.min(TELEPORTER.maxBosses, 1 + (this.run.bossCountBonus | 0));
    this.bossRefs = [];
    for (let i = 0; i < count; i++) {
      const boss = this.director.spawnStageBoss(this.arena, this.player);
      if (boss) this.bossRefs.push(boss);
    }
    if (this.bossRefs.length) this.hud.setBoss(this.bossRefs[0], this.bossRefs.length);
    this.hud.toast(count > 1 ? `BEACON ACTIVE — ${count} guardians` : 'BEACON ACTIVE — hold the ring', '#46e0c0');
    this.engine.addShake(0.6);
  }

  /** The living guardians of the current beacon event, host side. */
  livingBosses() {
    return (this.bossRefs || []).filter((b) => b && !b.dead);
  }

  _updateTeleporterEvent(dt) {
    const tp = this.teleporter;
    if (!tp) return;

    if (tp.state === 'charging') {
      const charged = tp.chargeFraction >= 1;
      const living = this.livingBosses();
      const bossDown = living.length === 0;
      // Keep the boss bar on something that is still standing.
      if (living.length && this.hud.bossTarget !== living[0]) this.hud.setBoss(living[0], living.length);

      if (charged && bossDown) {
        tp.state = 'ready';
        this.coop?.onTeleporterState();
        this.director.eventMultiplier = 1;
        this.enemies.killAll('teleporter');
        const bonus = Math.round(this.player.gold * TELEPORTER.postClearGoldBonus) + 25;
        this.player.addGold(bonus);
        this.hud.toast('STAGE CLEAR', '#ffb347');
        this.hud.setObjective('Beacon Ready', 1, 'Interact to descend');
        // Clearing a stage always yields one good item — each.
        this.spawnBossLoot(tp.position.clone().setY(tp.position.y + 2.5));
      } else {
        const sub = !bossDown
          ? (charged
            ? `${living.length > 1 ? `${living.length} guardians` : 'Guardian'} still standing`
            : 'Guardian inbound')
          : `${Math.ceil((1 - tp.chargeFraction) * tp.chargeTime)}s remaining`;
        this.hud.setObjective('Charging Beacon', tp.chargeFraction, sub);
      }
    } else if (tp.state === 'idle') {
      const d = this.player.position.distanceTo(tp.position);
      this.hud.setObjective('Locate the Beacon', 0, d < 900 ? `${Math.round(d)}m away` : '');
    }
  }

  /** Client mirror of the objective panel, driven by the replicated beacon. */
  _updateClientObjective() {
    if (this.stagePending) {
      this.hud.setObjective('Descending', 0, 'Waiting for the host to describe the stage');
      return;
    }
    const tp = this.teleporter;
    if (!tp) return;
    if (tp.state === 'charging') {
      const remaining = Math.ceil((1 - tp.chargeFraction) * tp.chargeTime);
      this.hud.setObjective('Charging Beacon', tp.chargeFraction, `${remaining}s remaining`);
    } else if (tp.state === 'ready') {
      this.hud.setObjective('Beacon Ready', 1, 'Interact to descend');
    } else {
      const d = this.player.position.distanceTo(tp.position);
      this.hud.setObjective('Locate the Beacon', 0, `${Math.round(d)}m away`);
    }
  }

  // ==================================================================== events
  /**
   * An enemy died on this machine, which in co-op means this machine is the
   * host. Everyone is told, and everyone then resolves the same death locally:
   * gold, experience and on-kill items all pay out per player, so nobody has to
   * race a teammate to a corpse.
   */
  onEnemyDeath(enemy, opts = {}) {
    const rewards = { gold: enemy.goldValue, xp: enemy.xpValue, silent: !!opts.silent };
    this.coop?.onEnemyDeath(enemy, rewards);
    this.resolveEnemyDeath(enemy, opts, rewards);
  }

  resolveEnemyDeath(enemy, opts = {}, rewards = null) {
    const gold = rewards?.gold ?? enemy.goldValue;
    const xp = rewards?.xp ?? enemy.xpValue;
    const silent = rewards ? rewards.silent : !!opts.silent;
    this.run.kills++;
    if (enemy.elite) this.run.eliteKills++;
    if (enemy.boss) this.run.bossKills++;

    const color = enemy.elite ? enemy.elite.color : enemy.def.accent;
    this.fx.deathBurst(enemy.center, color, enemy.boss ? 3.5 : enemy.elite ? 1.7 : 1);
    if (enemy.boss) this.engine.addShake(0.7);

    if (!silent) {
      this.pickups.spawnGold(enemy.position, gold, enemy.boss ? 14 : null);
      this.player.addXp(xp);
      if (enemy.boss || (enemy.elite && this.rng.next() < 0.3)) {
        this.pickups.spawnHealth(enemy.position, this.player.stats.maxHealth * (enemy.boss ? 0.3 : 0.12));
      }
      this.inventory.trigger('onKill', { enemy });
    }

    // Elite death effects
    if (enemy.elite?.onDeath === 'iceNova') {
      this.fx.explosion(enemy.center, 9, 0x6fd0ff, 1.2);
      const d = this.player.position.distanceTo(enemy.position);
      if (d < 9) {
        this.player.takeDamage(enemy.damage * 0.8, { source: 'Glacial' });
        this.player.applyStatus('chill', 3, { slow: 0.45 });
      }
    }

    if (enemy.boss) {
      const living = this.livingBosses();
      if (living.length) this.hud.setBoss(living[0], living.length);
      else this.hud.setBoss(null);
      this.hud.toast(`${enemy.def.name} destroyed`, '#ffb347');
      // Only the world's owner rolls loot, or every machine would roll its own
      // and the party would end up with one drop per player per player.
      if (!this.coopClient) {
        this.spawnBossLoot(enemy.position.clone().setY(enemy.position.y + 2));
      }
    }
  }

  onPlayerDeath(source) {
    this.run.killedBy = source || 'the descent';
    if (this.coop?.active) {
      // Downed, not finished: keep playing as a spectator until a teammate
      // stands you back up or the last of you falls.
      this.hud.toast('YOU ARE DOWN — a teammate can revive you', '#ff4d5e');
      return;
    }
    this.state = 'dead';
    this.input.exitLock();
    setTimeout(() => this._finishRun(false), 1500);
  }

  abandonRun() {
    if (this.state === 'menu') return;
    if (this.coop?.active) {
      // Walking out of a co-op run leaves the lobby too: the host owns the
      // world, and a client with no world is just a camera in the dark.
      if (this.coop.isHost) this.coop.onRunOver();
      this.coop.leave();
    }
    this.coopPaused = false;
    this.input.enabled = true;
    this._finishRun(false, true);
  }

  _finishRun(victory, abandoned = false) {
    if (this.state === 'menu') return;
    const result = {
      time: this.run.time,
      stage: this.run.stage,
      stagesCleared: this.run.stagesCleared,
      kills: this.run.kills,
      eliteKills: this.run.eliteKills,
      bossKills: this.run.bossKills,
      goldEarned: this.run.goldEarned,
      chestsOpened: this.run.chestsOpened,
      difficulty: this.director.difficulty,
      tierName: this.director.tier.name,
      level: this.player?.level ?? 1,
      mode: this.run.mode,
      victory,
      killedBy: abandoned ? 'withdrawal' : this.run.killedBy,
    };

    const echoes = computeEchoes(result, this.profile.data);
    this.profile.recordRun(result);
    this.profile.addEchoes(echoes.total);

    this.state = 'menu';
    this.paused = true;
    this.coopPaused = false;
    this.coopClient = false;
    this.input.enabled = true;
    this.hud.hide();
    this.hud.setObjective(null);
    this.hud.setBoss(null);
    this.input.exitLock();
    this.menus.showSummary(result, echoes);
    this._teardownRun();
  }

  collectItem(item) {
    const stacks = this.inventory.add(item.id, 1);
    this.profile.noteItemSeen(item.id);
    this.profile.save();
    this.player.recomputeStats();
    // Lizards wear what you pick up.
    this.minions.refreshTrophies(this.player);
    this.hud.showPickup(item, stacks);
  }

  /** Hatches a lizard for `owner`, keeping the networked side in step. */
  hatchMinion(owner, position) {
    const minion = this.minions.hatch(owner, position);
    if (minion) this.coop?.onMinionHatched(minion);
    return minion;
  }

  // ==================================================================== spawn helpers
  spawnItemPickup(item, position) {
    const entry = this.pickups.spawnItem(item, position);
    if (entry && this.coop?.isHost) this.coop.onItemDrop(entry, item.id);
    return entry;
  }

  /**
   * How many items a boss owes the room.
   *
   * One per player, because a boss drop that four people have to race for is
   * three players watching someone else get stronger. Every drop is a separate
   * networked pickup, so each of them can only be claimed once — four items
   * means four people leave with one, not one person leaving with four.
   */
  bossItemCount() {
    const perPlayer = TELEPORTER.bossItemsPerPlayer
      + Math.min(TELEPORTER.maxBossItemBonus, this.run.bossItemBonus | 0);
    return Math.max(1, Math.round(this.partySize() * perPlayer));
  }

  /** Everyone in the descent, standing or downed. One, in a solo run. */
  partySize() {
    return this.coop?.active ? this.coop.partySize() : 1;
  }

  /** Boss-table loot, spread in a ring so it does not land in one heap. */
  spawnBossLoot(center, count = this.bossItemCount()) {
    const spread = count > 1 ? TELEPORTER.bossItemSpread : 0;
    for (let i = 0; i < count; i++) {
      const item = rollItem(this.rng, 'boss', this.player.stats.luck, this.profile.data);
      if (!item) continue;
      const a = (i / count) * Math.PI * 2;
      const p = center.clone();
      p.x += Math.cos(a) * spread;
      p.z += Math.sin(a) * spread;
      this.spawnItemPickup(item, p);
    }
  }

  /**
   * A Shrine of Ruin was paid for. More bosses stand between the party and the
   * beacon, and everyone walks away from them with more.
   *
   * The host owns both effects — it spawns the bosses and rolls the loot — but
   * clients mirror the counters so their HUD and their toast tell the truth.
   */
  grantRuinBoon() {
    this.run.bossItemBonus = Math.min(TELEPORTER.maxBossItemBonus, (this.run.bossItemBonus | 0) + 1);
    this.run.bossCountBonus = Math.min(TELEPORTER.maxBosses - 1, (this.run.bossCountBonus | 0) + 1);
    this.coop?.onBoon(this.run.bossItemBonus, this.run.bossCountBonus);
    this.announceRuinBoon();
  }

  applyBoon(m) {
    if (typeof m.items === 'number') this.run.bossItemBonus = m.items;
    if (typeof m.bosses === 'number') this.run.bossCountBonus = m.bosses;
    this.announceRuinBoon();
  }

  announceRuinBoon() {
    const bosses = 1 + (this.run.bossCountBonus | 0);
    this.hud.toast(`RUIN — ${bosses} guardians, ${this.bossItemCount()} items on the corpse`, '#ff7a47');
    this.engine.addShake(0.4);
  }

  spawnHazard(position, opts) {
    this.projectiles.spawnHazard(position, { hostile: true, ...opts });
    this.coop?.onHazard(position, { hostile: true, ...opts });
  }

  spawnEnemyProjectile(enemy, spec) {
    const origin = enemy.center.clone();
    let dir;
    if (spec.direction) {
      dir = spec.direction.clone().normalize();
    } else {
      const target = spec.target.clone();
      // Lead the victim, who in co-op is not necessarily the local player.
      const victim = enemy.currentTarget || this.player;
      if (spec.lead && victim) target.addScaledVector(victim.velocity, spec.lead);
      dir = target.sub(origin);
      // Arc ballistic shots so gravity still lands them on target.
      if (spec.gravity && spec.gravity < 0) {
        const horiz = Math.hypot(dir.x, dir.z);
        const t = horiz / Math.max(1, spec.speed);
        dir.y += 0.5 * -spec.gravity * t * t;
      }
      dir.normalize();
    }
    if (spec.spread) {
      dir.x += (this.rng.next() - 0.5) * spec.spread * 2;
      dir.y += (this.rng.next() - 0.5) * spec.spread * 2;
      dir.z += (this.rng.next() - 0.5) * spec.spread * 2;
      dir.normalize();
    }

    const splash = typeof spec.splash === 'number'
      ? { radius: spec.splash, damage: spec.damage, color: spec.color }
      : spec.splash || null;

    const p = this.projectiles.spawn({
      position: origin,
      velocity: dir.multiplyScalar(spec.speed ?? 30),
      damage: spec.damage,
      radius: spec.radius ?? 0.3,
      life: spec.life ?? 5,
      gravity: spec.gravity ?? 0,
      color: spec.color ?? 0xff6a4a,
      hostile: true,
      splash,
      pierce: spec.pierce ? 99 : 0,
      trail: 0.8,
      glow: 1.6,
      homingRadius: spec.homing ? 20 : 0,
      homingStrength: spec.homing ?? 0,
      source: enemy.def.name,
    });
    if (p) p.sourceEnemy = enemy;
    // Enemy fire is broadcast as a spawn, not as a stream of positions: every
    // peer runs the identical ballistic path and resolves it against their own
    // body, so an incoming shot costs one small message no matter how long it
    // stays in the air.
    this.coop?.onEnemyProjectile({
      x: origin.x, y: origin.y, z: origin.z,
      dx: p ? p.velocity.x : 0, dy: p ? p.velocity.y : 0, dz: p ? p.velocity.z : 0,
      damage: spec.damage, radius: spec.radius ?? 0.3, life: spec.life ?? 5,
      gravity: spec.gravity ?? 0, color: spec.color ?? 0xff6a4a,
      splash, pierce: spec.pierce ? 99 : 0, source: enemy.def.name,
    });
    return p;
  }

  // ==================================================================== loop
  start() {
    this.menus.show('menu');
    requestAnimationFrame(this._loop);
  }

  /**
   * Pausing cannot stop the world when other people are in it.
   *
   * In co-op, Esc frees your mouse and puts the panel up, but the simulation
   * keeps running and your body keeps being described to the party — you are
   * simply standing still. Freezing your own client would desync you from
   * everyone and, worse, park an invulnerable statue in the middle of a fight.
   */
  pause() {
    if (this.state !== 'running') return;
    if (this.coop?.active) {
      this.coopPaused = true;
      this.input.enabled = false;
      this.input.keys.clear();
      this.input.exitLock();
      this.menus.show('pause');
      return;
    }
    this.state = 'paused';
    this.paused = true;
    this.input.exitLock();
    this.menus.show('pause');
  }

  resume() {
    if (this.coopPaused) {
      this.coopPaused = false;
      this.input.enabled = true;
      this.menus.hide();
      this.input.requestLock();
      return;
    }
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.paused = false;
    this.menus.hide();
    this._lastFrame = performance.now();
    this.input.requestLock();
  }

  _onKey(e) {
    // Same rule as the input layer: while a field has focus the keyboard
    // belongs to it. Escape is the one exception — it hands focus back.
    if (isTextTarget(e.target)) {
      if (e.code === 'Escape') e.target.blur();
      return;
    }
    if (e.code === 'Escape') {
      if (this.coopPaused) this.resume();
      else if (this.state === 'running') this.pause();
      else if (this.state === 'paused') this.resume();
      else if (['loadout', 'unlocks', 'codex', 'stats', 'help', 'coop'].includes(this.menus.current)) this.menus.show('menu');
      return;
    }
    if (e.code === 'KeyE' && this.state === 'running') this._interact();
  }

  _interact() {
    const target = this._nearestInteractable();
    if (!target) return;
    target.interact(this.player);
  }

  _nearestInteractable() {
    const p = this.player;
    if (!p) return null;
    let best = null;
    let bestDist = PLAYER.interactRange;
    const candidates = [...this.chests, ...this.eggs, this.teleporter].filter((c) => c && c.interactable);
    for (const c of candidates) {
      const extra = c === this.teleporter ? 3.4 : 0;
      const d = p.position.distanceTo(c.position);
      if (d < bestDist + extra) { best = c; bestDist = d - extra; }
    }
    return best;
  }

  _loop(now) {
    requestAnimationFrame(this._loop);

    // Clamp dt so tab-switching does not teleport the simulation. The lower bound
    // matters too: a rAF timestamp can predate a performance.now() taken in the
    // same frame, which would otherwise run the sim backwards for one step.
    const rawMs = now - this._lastFrame;
    const dt = Math.max(0, Math.min(0.05, rawMs / 1000));
    this._lastFrame = now;
    this.frame++;
    if (this.state === 'running') this.engine.updateQuality(Math.min(120, rawMs));

    if (this.state === 'running' || this.state === 'dead') {
      this.time += dt;
      this._update(dt);
    } else if (this.arena) {
      this.arena.update(dt, this.time);
    }

    this.fx.update(dt, this.engine.camera);
    if (this.state === 'running' || this.state === 'dead') {
      this.engine.applyShake(dt, this.time);
      this.hud.update(dt);
    }
    this.engine.render();
    this.input.endFrame();
  }

  _update(dt) {
    const player = this.player;
    const arena = this.arena;
    if (!player || !arena) return;

    if (this.state === 'running') {
      this.run.time += dt;
      // The world only ticks on the machine that owns it; a client's difficulty
      // and spawns arrive in the host's snapshot instead.
      if (!this.coopClient) this.director.update(dt, player, arena);
      this.inventory.update(dt);
    }

    player.update(dt, this.input, arena);
    if (this.state === 'running') this.combat.update(dt, this.input, player);

    this.enemies.update(dt, player, arena);
    this.projectiles.update(dt, player, arena);
    this.pickups.update(dt, player, arena);

    this.minions.update(dt, arena);
    for (const c of this.chests) c.update(dt, this.time);
    for (const e of this.eggs) e.update(dt, this.time);
    if (this.teleporter) {
      this.teleporter.update(dt, this.time, player);
      if (player.dead && this.coop?.active) this.hud.downedObjective(this.coop.reviveProgress);
      else if (this.coopClient) this._updateClientObjective();
      else this._updateTeleporterEvent(dt);
    }
    arena.update(dt, this.time);
    this.coop?.update(dt);

    // Interaction prompt
    if (this.state === 'running') {
      const target = this._nearestInteractable();
      if (target) {
        const text = target.promptText();
        const affordable = target === this.teleporter || player.gold >= target.cost;
        this.hud.showPrompt(text, 'E');
        if (!affordable) this.hud.el.prompt.classList.add('locked');
        else if (this.hud.lockedTimer <= 0) this.hud.el.prompt.classList.remove('locked');
      } else {
        this.hud.hidePrompt();
      }
    }

    player.updateCamera(dt, arena, this.input.mouse.right && !player.dead);
  }
}
