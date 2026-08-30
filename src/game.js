import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Input, isTextTarget } from './core/input.js';
import { RNG } from './core/rng.js';
import { TELEPORTER, DIFFICULTY, PLAYER, ECONOMY, PETS, RARITY, PARTY, FINAL, COOP } from './core/config.js';
import { clamp01, formatTime, formatNumber } from './core/mathx.js';
import { audio } from './core/audio.js';

import { Arena } from './world/arena.js';
import { Player } from './entities/player.js';
import { EnemyManager } from './entities/enemy.js';
import { ProjectileManager } from './entities/projectiles.js';
import { Chest, Teleporter, PickupManager, Egg, Portal } from './entities/interactables.js';
import { PetManager } from './entities/pet.js';
import { rollPetSpecies } from './data/pets.js';
import { finalTheme } from './world/themes.js';
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
import { Chat } from './ui/chat.js';

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
    this.chat = new Chat(this);
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
      // Opening the chat releases the mouse on purpose; that is not a pause.
      if (this.chat?.open) return;
      if (this.state === 'running' && this.input.everLocked) this.pause();
    };

    window.addEventListener('keydown', (e) => this._onKey(e));
    // Browsers refuse to make a sound until the page has been touched. Both of
    // these fire once and then cost nothing.
    const wake = () => audio.unlock();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    document.addEventListener('click', () => {
      // Clicking the canvas while a run is live re-acquires pointer lock.
      if (this.state === 'running' && !this.input.locked && !this.chat?.open
        && this.menus.current === 'none') {
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
      victory: false,
      // Scratch space items persist values in (Eclipse Crown, Infusion Core, …)
      infusion: 0,
      crown: 0,
      discCharge: 0,
      frostStacks: 0,
      // Shrine of Ruin: more bosses at the beacon, more boss loot for everyone.
      bossCountBonus: 0,
      bossItemBonus: 0,
      /* Set the first time you stand in front of the rift and descend anyway.
         From then on the descent has no order left to respect: every stage can
         be any of its tier's places plus the Void Terrace, and any guardian can
         be waiting. Refusing the ending is what opens the roster. */
      looped: false,
    };

    this.director = new Director(this, mode.mult, mode.spawnMult ?? 1);
    this.enemies = new EnemyManager(this);
    this.projectiles = new ProjectileManager(this);
    this.pickups = new PickupManager(this);
    this.pets = new PetManager(this);
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
    this.chat.clear();
    this.menus.hide();

    this.state = 'running';
    this.paused = false;
    this.time = 0;
    this._lastFrame = performance.now();
    audio.unlock();
    audio.setIntensity(0.1);
    this.input.requestLock();
    this.hud.toast(`${this.player.char.name} — ${this.arena.theme.name}`, '#46e0c0');
    if (this.coop?.isHost) this.coop.onStageBuilt();
  }

  _teardownRun() {
    this.enemies?.clear();
    this.projectiles?.clear();
    this.pickups?.clear();
    this.pets?.clear();
    for (const c of this.chests || []) c.dispose();
    this.chests = [];
    for (const e of this.eggs || []) e.dispose();
    this.eggs = [];
    this.teleporter?.dispose();
    this.teleporter = null;
    this.portal?.dispose();
    this.portal = null;
    this.finalStage = false;
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
  _buildStage(stage, layout = null, opts = {}) {
    // A client waiting on the host builds one agreed placeholder rather than an
    // arena of its own: an arena only it can see is an arena it stands on at a
    // height nobody else believes in, which is exactly how a teammate ends up
    // buried to the waist or hovering.
    const seed = layout?.pending
      ? COOP.pendingSeed
      : (layout?.seed ?? this.rng.int(1, 0x7ffffffe));
    const final = opts.final ?? !!layout?.final;
    this.stageSeed = seed;
    this.stagePending = !!layout?.pending;
    this.finalStage = final;
    /* One difficulty reading, taken here, that prices everything on the stage.
     *
     * Chests and eggs both used to sample `director.difficulty` whenever they
     * felt like it, which climbs every second — so the price of a thing changed
     * between seeing it and reaching it. Freezing it at the door means the
     * stage is a shop with a price list, and the list only changes when you
     * descend. */
    this.stageDifficulty = layout?.diff ?? this.director?.difficulty ?? 1;
    const previousTheme = this.arena?.theme?.id ?? null;
    this.arena?.dispose();
    this.arena = new Arena(this.engine.scene, seed, stage, {
      theme: final ? finalTheme() : null,
      themeId: layout?.theme ?? null,
      avoidTheme: previousTheme,
      looped: !!this.run?.looped,
    });
    this.stageThemeId = this.arena.theme.id;
    this.engine.setTheme(this.arena.theme);
    audio.setMusic(this.arena.theme.id);

    for (const c of this.chests) c.dispose();
    this.chests = [];
    for (const e of this.eggs) e.dispose();
    this.eggs = [];
    this.teleporter?.dispose();
    this.teleporter = null;
    this.portal?.dispose();
    this.portal = null;
    this.stageCleared = false;
    this.bossRefs = [];

    if (layout?.pending) return;              // waiting on the host's packet
    // The sanctum has no shops and no way onward. Nothing to place.
    if (final) return;
    if (layout) { this._placeFromLayout(layout); return; }

    // Interactable placement: mostly ordinary chests, with rarer, richer options.
    // More people means more buyers, so the stage has to stock more shelves —
    // otherwise the second player through the door finds an empty arena.
    const extra = Math.max(0, this.partySize - 1);
    const eggBonus = Math.round(extra * PARTY.eggsPerPlayer) + (this.player?.stats.extraEggs ?? 0);
    // Interactable counts scale with the floor area, not just with the party.
    // The arenas are between a third and a half again as wide as they were, and
    // a stage stocked for the old disc reads as an empty field with a chest in
    // the corner of it.
    const spread = Math.min(3.4, Math.pow(this.arena.radius / 78, 1.35));
    // Eggs scale at half the rate the shelves do. A chest is a purchase you
    // make once; a lizard is a permanent addition to the party, so eight of
    // them a stage is a different game rather than a bigger one.
    const eggSpread = 1 + (spread - 1) * 0.45;
    const eggCount = Math.round(this.rng.int(PETS.eggsPerStage[0], PETS.eggsPerStage[1]) * eggSpread) + eggBonus;
    const chestCount = Math.round((6 + this.rng.int(0, 3) + Math.min(4, stage - 1)) * spread)
      + Math.round(extra * PARTY.chestsPerPlayer);
    const shrineCount = 2 + this.rng.int(0, 2);
    const points = this.arena.scatterPoints(
      this.rng, chestCount + shrineCount + eggCount + 8,
      { minSeparation: 15, minRadius: (this.arena.theme.terrain?.plateauRadius ?? 16) + 3 },
    );

    let i = 0;
    for (; i < chestCount && i < points.length; i++) {
      let kind = 'chest';
      const roll = this.rng.next();
      if (roll < 0.14 + stage * 0.015) kind = 'large';
      if (roll > 0.975) kind = 'legendary';
      this.chests.push(new Chest(this, kind, points[i]));
    }

    /* Devices.
     *
     * Two or three a stage, drawn without replacement, so you get a couple of
     * the four rather than one of each every time — which is what makes finding
     * a Blood Altar worth crossing the arena for. They are placed after the
     * chests and before the shrines so they land on the good open points. */
    const deviceKinds = ['altar', 'cache', 'duplicator', 'forge'];
    const deviceCount = Math.min(deviceKinds.length, 2 + (this.rng.next() < 0.55 ? 1 : 0)
      + Math.round(extra * 0.4));
    for (let d = 0; d < deviceCount && i < points.length; d++, i++) {
      const pick = this.rng.int(0, deviceKinds.length - 1);
      const kind = deviceKinds.splice(pick, 1)[0];
      this.chests.push(new Chest(this, kind, points[i]));
    }
    for (let s = 0; s < shrineCount && i < points.length; s++, i++) {
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
      this.eggs.push(new Egg(this, points[i], accent, rollPetSpecies(this.rng), e));
    }
    this.chests.forEach((c, idx) => { c.index = idx; });
    this.eggs.forEach((e, idx) => { e.index = idx; });

    const tpPoint = this.arena.findSpawnPoint(this.rng, { minDist: 34, maxDist: this.arena.radius - 22 });
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
      const egg = new Egg(this, _v.set(e.x, e.y, e.z), accent, e.s || 'lizard', e.q ?? idx);
      egg.index = idx;
      // The host's price list is authoritative: two people standing at the same
      // egg must be quoted the same number.
      if (typeof e.cost === 'number') egg.cost = e.cost;
      egg.hatched = !!e.h;
      this.eggs.push(egg);
    });
    if (layout.tp) {
      this.teleporter = new Teleporter(this, _v.set(layout.tp.x, layout.tp.y, layout.tp.z));
      this.teleporter.state = layout.tp.state || 'idle';
      this.teleporter.charge = layout.tp.charge || 0;
    }
  }

  /* ------------------------------------------------------ co-op replication */
  buildStagePacket() {
    return {
      k: 'stage',
      stage: this.run.stage,
      seed: this.stageSeed,
      theme: this.stageThemeId,
      final: this.finalStage ? 1 : 0,
      portal: this.portal ? { x: this.portal.position.x, y: this.portal.position.y, z: this.portal.position.z } : null,
      // The seed is the instruction; the hash is the receipt. A client that
      // rebuilds and gets a different number knows immediately, instead of
      // finding out when a teammate walks through a wall that is not there.
      th: this.arena.terrainHash(),
      bosses: this.run.bossCountBonus | 0,
      bossItems: this.run.bossItemBonus | 0,
      looped: this.run.looped ? 1 : 0,
      chests: this.chests.map((c) => ({
        k: c.kind, x: c.position.x, y: c.position.y, z: c.position.z,
        cost: c.cost, uses: c.uses, o: c.opened ? 1 : 0,
      })),
      diff: this.stageDifficulty,
      eggs: this.eggs.map((e) => ({
        x: e.position.x, y: e.position.y, z: e.position.z, h: e.hatched ? 1 : 0, s: e.species,
        cost: e.cost, q: e.sequence,
      })),
      // The sanctum has no Beacon. Reading one unconditionally threw here and
      // the exception ate the whole packet, so the boss replicated to clients
      // but the arena it lives in did not.
      tp: this.teleporter ? {
        x: this.teleporter.position.x, y: this.teleporter.position.y, z: this.teleporter.position.z,
        state: this.teleporter.state, charge: this.teleporter.charge,
      } : null,
    };
  }

  applyStagePacket(m) {
    const advancing = this.run.stage !== m.stage || this.stageSeed !== m.seed
      || this.stageThemeId !== m.theme || this.stagePending;
    this.run.stage = m.stage;
    if (typeof m.bosses === 'number') this.run.bossCountBonus = m.bosses;
    if (typeof m.bossItems === 'number') this.run.bossItemBonus = m.bossItems;
    if (typeof m.looped === 'number') this.run.looped = !!m.looped;
    this.enemies.clear();
    this.projectiles.clear();
    this.pickups.clear();
    this._buildStage(m.stage, m, { final: !!m.final });
    this._verifyTerrain(m.th);
    if (m.final) {
      this.hud.setObjective('The Null Sovereign', 0, 'Kill it, or do not leave');
      this.hud.toast('THE NULL SANCTUM', '#ff2f8f');
    } else if (m.portal) {
      this.applyPortalState(m.portal);
    }
    if (!advancing) return;

    const p = this.player;
    if (p) {
      p.position.copy(this.arena.findSpawnPoint(this.rng, { minDist: 0, maxDist: 10 }));
      p.position.y += 0.2;
      p.velocity.set(0, 0, 0);
      p.snapCamera();
      if (p.dead) this.revivePlayer(1);
      else p.heal(p.stats.maxHealth * 0.25, 'Descent');
      this.spendGoldOnDescent();
    }
    this.pets.regroup();
    this.hud.setBoss(null);
    this.hud.setObjective(null);
    this.hud.toast(`${this.arena.theme.name} — Stage ${this.run.stage}`, '#46e0c0');
    this.engine.addShake(0.5);
  }

  /**
   * Gold does not survive a stage.
   *
   * Chest prices climb with the difficulty coefficient, so gold hoarded on
   * stage one buys almost nothing on stage five — carrying it forward only ever
   * rewarded not spending it. Wiping the purse at every descent makes each
   * stage a closed economy: everything you earn here is meant to be spent here,
   * and standing in front of a chest you cannot quite afford is a real decision
   * rather than a reason to walk away and come back richer.
   */
  spendGoldOnDescent() {
    const p = this.player;
    if (!p) return;
    const had = p.gold;
    p.gold = 0;
    if (had > 0) this.hud.toast(`${formatNumber(had)} gold spent on the descent`, '#ffcf5c');
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
    } else if (m.kind === 'portal') {
      if (this.portal?.interactable) this.enterFinalArena();
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
  applyRemotePets(peerId, list, owner) {
    if (!owner) return;
    this.pets.applyRemote(peerId, list, owner);
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
    this.chat.system('You are back on your feet', '#4be08a');
  }

  /** Everyone is down (or the host said the run is over). */
  finishCoopRun() {
    if (this.state === 'menu') return;
    this._finishRun(false);
  }

  /**
   * How many people are in this run, alive or downed.
   *
   * Distinct from `party()`, which is who the enemies can currently chase — the
   * world should not get easier the moment somebody goes down.
   */
  get partySize() {
    if (!this.coop?.active) return 1;
    // Count the lobby, not the avatars. A remote body is only created when its
    // first state packet arrives, which is *after* the host has already built
    // stage one — so asking the scene how many players there are gave the first
    // arena of every run a solo stocking.
    return Math.max(1, 1 + this.coop.session.peers.size);
  }

  /**
   * What everything on the stage costs you, as a fraction of its listed price.
   *
   * Read live rather than baked into each interactable, so picking up a
   * Covenant of Debt marks down the chest you are already standing in front of
   * rather than only the ones on the next stage.
   */
  get priceMultiplier() {
    return 1 - (this.player?.stats.priceMult ?? 0);
  }

  /** Who the enemies are allowed to fight. */
  party() {
    const list = this.coop?.active ? this.coop.party() : null;
    if (list && list.length) return list;
    return this.player ? [this.player] : [];
  }

  advanceStage() {
    const p = this.player;
    // Descending while the rift is open is the refusal. Read it before the
    // stage tears down and takes the portal with it.
    if (this.portal) this.run.looped = true;
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
    this.spendGoldOnDescent();
    // The brood comes down with you, whole — they are a purchase, not a rental.
    this.pets.regroup();

    this.director.eventMultiplier = 1;
    this.hud.setObjective(null);
    this.hud.toast(`${this.arena.theme.name} — Stage ${this.run.stage}`, '#46e0c0');
    this.engine.addShake(0.5);
    audio.descend();
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
    audio.teleporter('charging');
    if (this.bossRef) audio.bossSpawn();
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
      /* The moment the beacon fills, the arena stops feeding the fight.
         Charging is the pressure — double spawn rate for forty-two seconds —
         and the guardian is the wall at the end of it. Once the meter is full
         there is nothing left to hold, so a stream of fresh husks arriving
         while you finish the boss is pressure that is no longer buying
         anything. It stays halted for the rest of the stage: the quiet
         afterwards is where the gold gets spent. */
      if (charged && !this.director.spawnsHalted) {
        this.director.spawnsHalted = true;
        this.hud.toast('BEACON CHARGED — NO REINFORCEMENTS', '#46e0c0');
      }
      // Keep the boss bar on something that is still standing.
      if (living.length && this.hud.bossTarget !== living[0]) this.hud.setBoss(living[0], living.length);

      if (charged && bossDown) {
        tp.state = 'ready';
        this.coop?.onTeleporterState();
        this._openFinalPortal();
        this.director.eventMultiplier = 1;
        this.enemies.killAll('teleporter');
        const bonus = Math.round(this.player.gold * TELEPORTER.postClearGoldBonus) + 25;
        this.player.addGold(bonus);
        this.hud.toast('STAGE CLEAR', '#ffb347');
        audio.teleporter('ready');
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

  /** In the sanctum there is exactly one objective, and it has a health bar. */
  _updateFinalObjective() {
    const boss = this.bossRef;
    if (boss && !boss.dead) {
      this.hud.setObjective('The Null Sovereign', 1 - boss.health / boss.maxHealth, 'Kill it, or do not leave');
    } else if (this.run.victory) {
      this.hud.setObjective('Sanctum Silent', 1, 'The descent is over');
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

  /* ------------------------------------------------------- the final fight */
  /**
   * Opens the rift beside the Beacon, once the descent is deep enough.
   *
   * It appears at the same moment the Beacon turns green, so clearing a stage
   * from stage five onward presents two doors rather than one: keep descending
   * forever, or take the ending. Nobody is pushed through it.
   */
  _openFinalPortal() {
    if (this.coopClient || this.run.stage < FINAL.unlockStage || this.portal) return;
    const tp = this.teleporter;
    if (!tp) return;
    const at = tp.position.clone();
    at.x += 9;
    at.y = this.arena.groundHeightAt(at.x, at.z);
    this.portal = new Portal(this, at);
    this.portal.armed = true;
    this.hud.toast('A RIFT HAS OPENED BESIDE THE BEACON', '#ff2f8f');
    this.chat.system('A rift has torn open beside the Beacon. Something is waiting on the other side.', '#ff2f8f');
    this.coop?.onPortalState();
  }

  /** Client mirror: the host tells us the rift exists and where. */
  applyPortalState(m) {
    if (!m || this.portal) return;
    this.portal = new Portal(this, _v.set(m.x, m.y, m.z));
    this.portal.armed = true;
    this.hud.toast('A RIFT HAS OPENED BESIDE THE BEACON', '#ff2f8f');
  }

  /**
   * Steps the whole party through into the Null Sanctum.
   *
   * A one-way door: no chests, no eggs, no Beacon, and nothing to descend to.
   * Whatever build you walked in with is the build you finish on.
   */
  enterFinalArena() {
    if (this.finalStage) return;
    this.finalStage = true;
    this.run.stage++;
    this.run.stagesCleared++;
    this.director.onStageCleared();
    this.director.eventMultiplier = FINAL.directorMultiplier;

    this.enemies.clear();
    this.projectiles.clear();
    this.pickups.clear();
    this.hud.setBoss(null);
    this._buildStage(this.run.stage, null, { final: true });

    const p = this.player;
    p.position.copy(this.arena.findSpawnPoint(this.rng, { minDist: 0, maxDist: 8 }));
    p.position.y += 0.2;
    p.velocity.set(0, 0, 0);
    p.snapCamera();
    if (p.dead) this.revivePlayer(1);
    else p.heal(p.stats.maxHealth * 0.5, 'The Rift');
    this.spendGoldOnDescent();
    this.pets.regroup();

    this.hud.setObjective('The Null Sovereign', 0, 'Kill it, or do not leave');
    this.hud.toast('THE NULL SANCTUM', '#ff2f8f');
    this.chat.system('The rift closes behind you.', '#ff2f8f');
    this.engine.addShake(1.2);
    audio.descend();
    audio.bossSpawn();

    if (!this.coopClient) {
      // Hand out the arena *before* putting anything in it. Applying a stage
      // packet clears the enemy list, so a boss announced first is a boss the
      // clients immediately throw away.
      this.coop?.onStageBuilt();
      const at = this.arena.findSpawnPoint(this.rng, { minDist: 26, maxDist: 40 });
      at.y += this.arena.groundHeightAt(at.x, at.z) + 6;
      // Scales with the party on top of the difficulty coefficient: this is the
      // one fight that is supposed to be a wall.
      const boss = this.enemies.spawn('sovereign', at, {
        difficulty: this.director.difficulty,
        healthMult: FINAL.bossHealthMult * (1 + (this.partySize - 1) * FINAL.bossHealthPerPlayer),
      });
      this.bossRef = boss;
      if (boss) this.hud.setBoss(boss);
    }
  }

  /** The Sovereign is down. That is the end of the run, and a win. */
  _onFinalBossDown() {
    if (this.state === 'menu' || this.run.victory) return;
    this.run.victory = true;
    this.hud.toast('THE SOVEREIGN FALLS', '#ffcf5c');
    this.chat.system('The Sovereign falls. The descent is over.', '#ffcf5c');
    this.engine.addShake(1.6);
    this.coop?.onVictory();
    setTimeout(() => { if (this.state !== 'menu') this._finishRun(true); }, 2600);
  }

  /** A teammate finished it on their machine. */
  applyVictory() {
    if (this.state === 'menu' || this.run.victory) return;
    this.run.victory = true;
    this.hud.toast('THE SOVEREIGN FALLS', '#ffcf5c');
    setTimeout(() => { if (this.state !== 'menu') this._finishRun(true); }, 2600);
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
    audio.enemyDeath(enemy.center, enemy.boss ? 2.4 : enemy.elite ? 1.5 : 1);
    if (enemy.boss) this.engine.addShake(0.7);

    if (!silent) {
      this.pickups.spawnGold(enemy.position, gold, enemy.boss ? 14 : null);
      this.player.addXp(xp);
      if (enemy.boss || (enemy.elite && this.rng.next() < 0.3)) {
        this.pickups.spawnHealth(enemy.position, this.player.stats.maxHealth * (enemy.boss ? 0.3 : 0.12));
      }
      this.inventory.trigger('onKill', { enemy });
      // Kills are the other half of the ultimate meter.
      this.combat?.noteKill(enemy);
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

    if (enemy.def.final) {
      this.hud.setBoss(null);
      this._onFinalBossDown();
      return;
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
    audio.playerDeath();
    if (this.coop?.active) {
      // Downed, not finished: keep playing as a spectator until a teammate
      // stands you back up or the last of you falls.
      this.hud.toast('YOU ARE DOWN — a teammate can revive you', '#ff4d5e');
      this.chat.system(`You went down to ${this.run.killedBy}`, '#ff4d5e');
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
      victory: victory || !!this.run.victory,
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
    audio.setMusic('menu');
    audio.setIntensity(0);
    this.menus.showSummary(result, echoes);
    this._teardownRun();
  }

  collectItem(item) {
    const stacks = this.inventory.add(item.id, 1);
    this.profile.noteItemSeen(item.id);
    this.profile.save();
    this.player.recomputeStats();
    // Pets wear what you pick up.
    this.pets.refreshTrophies(this.player);
    this.hud.showPickup(item, stacks);
    audio.pickup(RARITY[item.rarity]?.order ?? 0);
    this.chat.itemPickup('You', item, true);
    this.coop?.announcePickup(item.id);
  }

  /** Hatches a lizard for `owner`, keeping the networked side in step. */
  hatchPet(owner, position, species) {
    const pet = this.pets.hatch(owner, position, { species });
    if (pet) this.coop?.onPetHatched(pet);
    return pet;
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
    return Math.max(1, Math.round(this.partySize * perPlayer));
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
    // While the chat box is open every key belongs to it. Its own handler stops
    // propagation, so anything arriving here is from outside the field.
    if (this.chat?.open) {
      if (e.code === 'Escape') this.chat.close();
      return;
    }
    if (this.input.bindingsFor('chat').includes(e.code) && this.state === 'running') {
      e.preventDefault();
      this.chat.openBox();
      return;
    }
    if (e.code === 'Escape') {
      // The settings panel is a layer over whatever opened it, so Esc there
      // steps back one screen rather than resuming a run you are still tuning.
      if (this.menus.current === 'settings') {
        this.menus.show(this.menus.settingsReturn === 'pause' ? 'pause' : 'menu');
        return;
      }
      if (this.coopPaused) this.resume();
      else if (this.state === 'running') this.pause();
      else if (this.state === 'paused') this.resume();
      else if (['loadout', 'unlocks', 'codex', 'stats', 'help', 'coop', 'settings'].includes(this.menus.current)) this.menus.show('menu');
      return;
    }
    if (this.input.bindingsFor('interact').includes(e.code) && this.state === 'running') this._interact();
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
    const candidates = [...this.chests, ...this.eggs, this.teleporter, this.portal]
      .filter((c) => c && c.interactable);
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

    if (this.player) this.engine.followShadows(this.player.position);
    audio.updateListener(this.engine.camera);
    audio.update(dt);
    this.fx.update(dt, this.engine.camera);
    if (this.state === 'running' || this.state === 'dead') {
      this.engine.applyShake(dt, this.time);
      this.hud.update(dt);
      this.chat.update(dt);
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

    this.pets.update(dt, arena);
    for (const c of this.chests) c.update(dt, this.time);
    for (const e of this.eggs) e.update(dt, this.time);
    if (this.portal) this.portal.update(dt, this.time);
    if (this.finalStage) this._updateFinalObjective();
    if (this.teleporter) {
      this.teleporter.update(dt, this.time, player);
      if (player.dead && this.coop?.active) this.hud.downedObjective(this.coop.reviveProgress);
      else if (this.coopClient) this._updateClientObjective();
      else this._updateTeleporterEvent(dt);
    }
    // The containment field only draws near whoever is looking at it.
    arena.barrierFocus = player.position;
    arena.update(dt, this.time);
    this.coop?.update(dt);

    // Interaction prompt
    if (this.state === 'running') {
      const target = this._nearestInteractable();
      if (target) {
        const text = target.promptText();
        // Not every device is bought with gold any more — the altar takes health
        // and the forge takes junk items — so each one answers for itself.
        const affordable = target === this.teleporter || target.affordable?.(player) !== false;
        this.hud.showPrompt(text, 'E');
        if (!affordable) this.hud.el.prompt.classList.add('locked');
        else if (this.hud.lockedTimer <= 0) this.hud.el.prompt.classList.remove('locked');
      } else {
        this.hud.hidePrompt();
      }
    }

    player.updateCamera(dt, arena, player.aiming && !player.dead);
    this._updateMusicIntensity(dt);
  }

  /**
   * How loud the score gets.
   *
   * Driven by what is actually happening rather than by the clock: a boss, a
   * crowd, or being hurt all open the arrangement up, and a quiet minute
   * between waves closes it again. The floor rises with the difficulty
   * coefficient so late stages never fully relax.
   */
  _updateMusicIntensity(dt) {
    if (this.frame % 12 !== 0) return;
    const p = this.player;
    const near = this.enemies?.nearest(p.position, 40, 12).length ?? 0;
    const floor = clamp01((this.director.difficulty - 1) * 0.06);
    let want = floor + clamp01(near / 9) * 0.55;
    if (p.combatTimer > 0) want += 0.15;
    if (this.bossRef && !this.bossRef.dead) want = Math.max(want, 0.85);
    if (p.health / p.stats.maxHealth < 0.3) want = Math.max(want, 0.7);
    audio.setIntensity(clamp01(want));
  }
}
