import * as THREE from 'three';
import { RARITY, TELEPORTER, ECONOMY } from '../core/config.js';
import { clamp01, damp } from '../core/mathx.js';
import { buildChestModel, buildTeleporterModel, buildOrbModel, buildItemDropModel, buildEggModel } from './models.js';
import { chestCost, eggCost, rollItem } from '../systems/loot.js';

const _v = new THREE.Vector3();

/* ==========================================================================
   CHESTS & SHRINES
   ========================================================================== */
export class Chest {
  constructor(game, kind, position) {
    this.game = game;
    this.kind = kind;             // chest | large | legendary | shrine | ruin
    this.position = position.clone();
    this.opened = false;
    this.uses = kind === 'shrine' ? 3 : 1;
    this.cost = chestCost(kind, game.director.difficulty);
    this.model = buildChestModel(kind);
    this.model.position.copy(this.position);
    this.model.rotation.y = Math.random() * Math.PI * 2;
    game.engine.scene.add(this.model);
    this.lidAngle = 0;
    this.bob = Math.random() * 10;
    this.label = {
      chest: 'Chest', large: 'Large Chest', legendary: 'Legendary Chest',
      shrine: 'Shrine of Chance', ruin: 'Shrine of Ruin',
    }[kind];
    this.table = { chest: 'chest', large: 'large', legendary: 'legendary', shrine: 'shrine' }[kind];
  }

  /** Both shrines share the altar silhouette and the floating orb. */
  get isShrine() { return this.kind === 'shrine' || this.kind === 'ruin'; }

  get interactable() { return !this.opened && this.uses > 0; }

  promptText() {
    if (this.kind === 'ruin') {
      const bosses = 2 + (this.game.run.bossCountBonus | 0);
      return `${this.label} — ${this.cost} gold (${bosses} guardians, +1 item each)`;
    }
    if (this.kind === 'shrine') return `${this.label} — ${this.cost} gold (${this.uses} left)`;
    return `${this.label} — ${this.cost} gold`;
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
    if (!player.spendGold(this.cost)) {
      this.game.ui.showPromptLocked();
      return false;
    }
    if (this.game.coopClient) {
      this._consume();
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
    this._payOut();
    return true;
  }

  /** Marks the chest used and moves its price along, without granting anything. */
  _consume() {
    if (this.kind === 'shrine') {   // Chance only: Ruin is a single, deliberate deal
      this.uses--;
      this.cost = Math.round(this.cost * ECONOMY.shrineCostGrowth);
      if (this.uses <= 0) this.opened = true;
      return;
    }
    this.opened = true;
    this.game.run.chestsOpened++;
  }

  _payOut() {
    if (this.kind === 'ruin') {
      // No item comes out of this one. What you buy is a harder beacon fight
      // and a bigger pile on the other side of it — for everyone, not just you.
      this.game.fx.explosion(this.position.clone().setY(this.position.y + 2.6), 5, 0xff7a47, 1.1);
      this.game.grantRuinBoon();
      return;
    }
    if (this.kind === 'shrine') {
      const win = this.game.rng.next() < 0.42;
      this.game.fx.explosion(this.position.clone().setY(this.position.y + 2.5), 4, win ? 0xd94bff : 0x555a6a, 0.8);
      if (win) this._grantItem();
      else this.game.ui.toast('The shrine takes, and gives nothing', '#7d89a3');
      return;
    }
    this._grantItem();
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
  constructor(game, position, accent = 0xff8a3d) {
    this.game = game;
    this.position = position.clone();
    this.hatched = false;
    this.accent = accent;
    this.cost = eggCost(game.director.difficulty, 0);
    this.model = buildEggModel(accent);
    this.model.position.copy(this.position);
    this.model.rotation.y = Math.random() * Math.PI * 2;
    game.engine.scene.add(this.model);
    this.bob = Math.random() * 10;
    this.shake = 0;
    this.label = 'Brood Egg';
  }

  get interactable() { return !this.hatched; }

  /** Repriced on approach: the cost tracks how many lizards you already have. */
  _refreshCost(player) {
    const owned = this.game.minions.ownedBy(player).length;
    this.cost = eggCost(this.game.director.difficulty, owned);
    return owned;
  }

  promptText() {
    const player = this.game.player;
    const owned = this._refreshCost(player);
    const cap = this.game.minions.capFor(player);
    if (owned >= cap) return `${this.label} — brood is full (${owned}/${cap})`;
    return `${this.label} — ${this.cost} gold  ·  brood ${owned}/${cap}`;
  }

  interact(player) {
    if (!this.interactable) return false;
    const owned = this._refreshCost(player);
    if (owned >= this.game.minions.capFor(player)) {
      this.game.ui.showPromptLocked();
      this.game.ui.toast('Your brood is already full', '#7d89a3');
      return false;
    }
    if (!player.spendGold(this.cost)) {
      this.game.ui.showPromptLocked();
      return false;
    }

    this.hatched = true;
    const spawn = this.position.clone();
    spawn.y += 0.2;
    // The lizard belongs to whoever paid and runs on their machine; only the
    // cracked shell has to be agreed on, so that is all that goes over the wire.
    const minion = this.game.hatchMinion(player, spawn);
    if (this.game.coopClient) this.game.coop.session.sendHost({ k: 'act', kind: 'egg', i: this.index });
    else this.game.coop?.onEggState(this.index);
    this.game.fx.explosion(this.position.clone().setY(this.position.y + 0.7), 3, this.accent, 0.9);
    this.game.fx.burst(this.position.clone().setY(this.position.y + 0.7), 16,
      { color: 0xe6dfc8, speed: 7, size: 0.14, life: 0.8 });
    this.game.ui.toast(minion ? 'A brood lizard imprints on you' : 'The egg was empty', '#ff8a3d');
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
    if (ud.beam) {
      const want = this.state === 'ready' ? 0.22 : this.state === 'charging' ? 0.1 : 0.03;
      ud.beam.material.opacity = damp(ud.beam.material.opacity, want, 4, dt);
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
