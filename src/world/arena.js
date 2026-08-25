import * as THREE from 'three';
import { WORLD } from '../core/config.js';
import { RNG } from '../core/rng.js';
import { disposeObject } from '../core/engine.js';
import { themeForStage } from './themes.js';
import { PROP_BUILDERS, PROP_COLLISION, applyWind } from './props.js';
import { themeMaterials } from './textures.js';

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/**
 * Procedurally generated combat arena: ground, boundary, cover, and colliders.
 *
 * Built from a seed, never from a live RNG handed in by the caller. Two streams
 * come off that seed and they are kept strictly apart:
 *
 * - `rng` draws everything that has a collider — plateau, columns, decks,
 *   stairs, walls, rubble, prop placement. This is the terrain every player has
 *   to agree on, so nothing else is ever allowed to draw from it.
 * - `decorRng` draws things that only exist to be looked at — the ground
 *   texture's mottling and the drifting motes.
 *
 * Splitting them is what makes co-op terrain safe to change. Before, the ground
 * texture pulled ~3,600 numbers out of the same stream the colliders came from,
 * so editing a cosmetic detail — or skipping it on one machine — shifted every
 * structure in the arena and two players ended up on different ground while
 * still believing they shared a seed.
 */
export class Arena {
  constructor(scene, seed, stage) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.rng = new RNG(this.seed);
    this.decorRng = new RNG((this.seed ^ 0x9e3779b9) >>> 0);
    this.stage = stage;
    this.theme = themeForStage(stage);
    this.radius = WORLD.arenaRadius;
    this.group = new THREE.Group();
    this.colliders = [];        // { min:Vector3, max:Vector3 }
    this.platforms = [];        // colliders you can stand on, for spawn placement
    this.decor = [];
    scene.add(this.group);
    this.build();
  }

  build() {
    this._buildGround();
    this._buildBoundary();
    this._buildProps();
    this._scatterProps();
    this._buildAtmosphere();
    this.buildColliderGrid();
  }

  /**
   * Fingerprint of everything you can stand on or walk into.
   *
   * Two players who agree on this agree on the ground, which is the only thing
   * co-op actually needs them to agree on — the mottling on the dirt can differ
   * all it likes. Bounds are quantised to a centimetre before hashing so the
   * last-bit differences you get out of `Math.sin` on different browsers cannot
   * report a false mismatch, while a genuinely different arena — one column
   * moved, one deck missing — always does.
   */
  terrainHash() {
    if (this._terrainHash !== undefined) return this._terrainHash;
    let h = 0x811c9dc5;
    const mix = (v) => {
      h ^= Math.round(v * 100) | 0;
      h = Math.imul(h, 0x01000193);
    };
    mix(this.colliders.length);
    for (const c of this.colliders) {
      mix(c.min.x); mix(c.min.y); mix(c.min.z);
      mix(c.max.x); mix(c.max.y); mix(c.max.z);
    }
    this._terrainHash = h >>> 0;
    return this._terrainHash;
  }

  /**
   * Dresses the arena with the theme's prop mix.
   *
   * Each prop type gets a few pre-built geometry variants, and every variant is
   * drawn by one InstancedMesh — so ~1300 pieces of scenery in the opening stage
   * cost around 30 draw calls rather than 1300. Variants exist because a single
   * shared mesh reads as wallpaper the moment you see two of them side by side.
   */
  _scatterProps() {
    const theme = this.theme;
    if (!theme.props) return;

    this.propGroup = new THREE.Group();
    this.group.add(this.propGroup);

    this.propMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0.02, flatShading: true,
    });
    this.windMaterial = applyWind(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, metalness: 0.02, flatShading: true,
      side: THREE.DoubleSide,
    }), 0.14);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    for (const spec of theme.props) {
      const build = PROP_BUILDERS[spec.type];
      if (!build) continue;

      const variantCount = spec.type === 'grass' ? 4 : 3;
      const variants = [];
      // The shape of a bush is cosmetic; where it stands is not. Its collider
      // comes from PROP_COLLISION and the placement below, never from the mesh,
      // so variant geometry is drawn from the cosmetic stream.
      for (let v = 0; v < variantCount; v++) variants.push(build(this.decorRng, theme.palette));

      // Decide placements first so instance counts per variant are known up front.
      const placements = variants.map(() => []);
      const collision = PROP_COLLISION[spec.type];

      for (let i = 0; i < spec.count; i++) {
        const p = this._propPlacement(spec, !!collision);
        if (!p) continue;
        placements[Math.floor(this.decorRng.next() * variantCount)].push(p);
        if (collision) this._addPropCollider(p, collision, spec);
      }

      variants.forEach((geo, v) => {
        const list = placements[v];
        if (!list.length) { geo.dispose(); return; }
        const mesh = new THREE.InstancedMesh(geo, spec.wind ? this.windMaterial : this.propMaterial, list.length);
        mesh.castShadow = spec.wind ? false : true;   // grass shadows are noise at this scale
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        list.forEach((pl, i) => {
          e.set(pl.tilt.x, pl.yaw, pl.tilt.z);
          q.setFromEuler(e);
          pos.set(pl.x, pl.y, pl.z);
          scl.set(pl.sx, pl.sy, pl.sz);
          m.compose(pos, q, scl);
          mesh.setMatrixAt(i, m);
        });
        mesh.instanceMatrix.needsUpdate = true;
        this.propGroup.add(mesh);
      });
    }
  }

  /** Finds a spot for one prop, or null if it could not be placed cleanly. */
  _propPlacement(spec, needsClearance) {
    const R = this.radius;
    for (let attempt = 0; attempt < 8; attempt++) {
      const p = this.rng.onCircle(R - 6, true);
      const d = Math.hypot(p.x, p.z);
      // Keep the central plateau clear so the teleporter fight has open ground.
      if (d < 17) continue;
      const y = this.groundHeightAt(p.x, p.z);
      // Never bury a prop inside existing structure.
      if (this.isInsideSolid(p.x, y + 0.4, p.z, needsClearance ? 1.2 : 0.15)) continue;

      const [lo, hi] = spec.scale || [0.9, 1.1];
      const s = this.rng.range(lo, hi);
      const tiltAmount = needsClearance ? 0.05 : 0.11;
      return {
        x: p.x, y, z: p.z,
        yaw: this.rng.next() * Math.PI * 2,
        tilt: { x: this.rng.range(-tiltAmount, tiltAmount), z: this.rng.range(-tiltAmount, tiltAmount) },
        sx: s * this.rng.range(0.9, 1.1),
        sy: s * this.rng.range(0.9, 1.15),
        sz: s * this.rng.range(0.9, 1.1),
      };
    }
    return null;
  }

  _addPropCollider(p, collision, spec) {
    const r = collision.radius * p.sx;
    const h = collision.height * p.sy;
    if (collision.box) {
      // Walls are long and thin, so a square footprint would over-block.
      const [bw, bh, bd] = collision.box;
      const w = (bw * p.sx) / 2;
      const dz = (bd * p.sz) / 2;
      const c = Math.abs(Math.cos(p.yaw));
      const sn = Math.abs(Math.sin(p.yaw));
      const ex = w * c + dz * sn;
      const ez = w * sn + dz * c;
      this.colliders.push({
        min: new THREE.Vector3(p.x - ex, p.y, p.z - ez),
        max: new THREE.Vector3(p.x + ex, p.y + bh * p.sy, p.z + ez),
      });
      return;
    }
    this.colliders.push({
      min: new THREE.Vector3(p.x - r, p.y, p.z - r),
      max: new THREE.Vector3(p.x + r, p.y + h, p.z + r),
    });
  }

  // ------------------------------------------------------------------
  _groundTexture() {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const base = new THREE.Color(this.theme.ground);
    const accent = new THREE.Color(this.theme.groundAccent);

    g.fillStyle = `#${base.getHexString()}`;
    g.fillRect(0, 0, size, size);

    // Mottled patches for organic variation. Drawn from the cosmetic stream —
    // see the class comment: this must never move the terrain.
    for (let i = 0; i < 900; i++) {
      const x = this.decorRng.next() * size;
      const y = this.decorRng.next() * size;
      const r = this.decorRng.range(3, 26);
      const t = this.decorRng.range(0.06, 0.3);
      const col = base.clone().lerp(accent, this.decorRng.next());
      g.fillStyle = `rgba(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0},${t})`;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // Faint tech grid so movement reads clearly.
    g.strokeStyle = `rgba(255,255,255,0.045)`;
    g.lineWidth = 1;
    for (let i = 0; i <= size; i += 32) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, size); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(size, i); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(12, 12);
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _buildGround() {
    const mats = themeMaterials(this.theme);
    const geo = new THREE.CircleGeometry(this.radius + 3, 128);
    geo.rotateX(-Math.PI / 2);
    // Detail texture over the painted base: the canvas map carries large-scale
    // colour variation, the tiled ground texture carries close-up grain.
    const mat = new THREE.MeshStandardMaterial({
      map: this._groundTexture(), roughness: 0.96, metalness: 0.03,
    });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.group.add(this.ground);

    // A second, tiled pass adds grain that the 12×-repeat base map cannot.
    const detail = new THREE.Mesh(
      geo.clone(),
      new THREE.MeshStandardMaterial({
        color: this.theme.ground, transparent: true, opacity: 0.3,
        roughness: 1, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
      }),
    );
    detail.material.map = mats.raw.rockT.map.clone();
    detail.material.map.repeat.set(30, 30);
    detail.material.map.needsUpdate = true;
    detail.position.y = 0.012;
    this.group.add(detail);
    this.groundDetail = detail;

    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(this.radius + 3, this.radius + 9, 26, 64, 1, true),
      new THREE.MeshStandardMaterial({
        color: this.theme.rock, roughness: 1, metalness: 0,
        side: THREE.BackSide, transparent: true, opacity: 0.95,
      }),
    );
    skirt.position.y = -13;
    this.group.add(skirt);
  }

  _buildBoundary() {
    // Visual wall — collision is handled by a radial clamp, not boxes.
    const mats = themeMaterials(this.theme);
    const wallGeo = new THREE.CylinderGeometry(this.radius, this.radius, WORLD.wallHeight, 96, 4, true);
    const wallTex = mats.raw.brick.map.clone();
    wallTex.repeat.set(26, 5);
    wallTex.needsUpdate = true;
    const wallRough = mats.raw.brick.roughnessMap.clone();
    wallRough.repeat.set(26, 5);
    wallRough.needsUpdate = true;
    const wallMat = new THREE.MeshStandardMaterial({
      color: this.theme.rock, map: wallTex, roughnessMap: wallRough,
      roughness: 0.92, metalness: 0.05, side: THREE.BackSide,
    });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.y = WORLD.wallHeight / 2 - 1;
    wall.receiveShadow = true;
    this.group.add(wall);

    // Buttresses around the rim break up the silhouette.
    const count = 22;
    const geo = new THREE.CylinderGeometry(1.6, 2.6, 16, 6);
    const inst = new THREE.InstancedMesh(geo, mats.concrete, count);
    inst.castShadow = inst.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + this.rng.range(-0.05, 0.05);
      const r = this.radius - 1.5;
      const h = this.rng.range(0.8, 1.5);
      q.setFromEuler(new THREE.Euler(0, a, 0));
      m.compose(
        new THREE.Vector3(Math.cos(a) * r, 8 * h - 2, Math.sin(a) * r),
        q,
        new THREE.Vector3(1, h, 1),
      );
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);

    // Emissive rim strip for readability at the arena edge.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(this.radius - 0.4, 0.16, 6, 84),
      new THREE.MeshBasicMaterial({ color: this.theme.emissive, transparent: true, opacity: 0.42 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.7;
    this.group.add(ring);
    this.rimRing = ring;
  }

  /**
   * Queues one textured block.
   *
   * `mat` selects which of the theme's material sets draws it, so a structure can
   * mix masonry, panelling and raw rock the way a real ruin does. Rotated blocks
   * get a conservative axis-aligned collider derived from their footprint.
   */
  _addBox(x, y, z, sx, sy, sz, colorHex, solid = true, mat = 'concrete', ry = 0) {
    this._boxSpecs.push({ x, y, z, sx, sy, sz, color: colorHex, mat, ry });
    if (!solid) return;
    const c = Math.abs(Math.cos(ry));
    const sn = Math.abs(Math.sin(ry));
    const ex = (sx * c + sz * sn) / 2;
    const ez = (sx * sn + sz * c) / 2;
    const col = {
      min: new THREE.Vector3(x - ex, y - sy / 2, z - ez),
      max: new THREE.Vector3(x + ex, y + sy / 2, z + ez),
    };
    this.colliders.push(col);
    if (sy < 14 && sx > 2.2 && sz > 2.2) this.platforms.push(col);
  }

  /* ------------------------------------------------------------------
     Structure modules — each is an assembly, not a single slab.
     ------------------------------------------------------------------ */

  /** Column: plinth, tapering drum shaft, banding, capital, optional broken top. */
  _column(x, z, height, radius, tint) {
    const base = this.groundHeightAt(x, z);
    const r = radius;
    // Stepped plinth.
    this._addBox(x, base + 0.18, z, r * 2.9, 0.36, r * 2.9, tint(0.9), true, 'brick');
    this._addBox(x, base + 0.5, z, r * 2.5, 0.3, r * 2.5, tint(1.0), true, 'brick');

    // Shaft in drums, each slightly narrower, with a recessed band between.
    const drums = Math.max(2, Math.round(height / 1.5));
    const drumH = (height - 1.5) / drums;
    for (let d = 0; d < drums; d++) {
      const t = d / drums;
      const dr = r * (2.1 - t * 0.35);
      const y = base + 0.65 + drumH * (d + 0.5);
      this._addBox(x, y, z, dr, drumH * 0.86, dr, tint(0.96 + (d % 2) * 0.08), true, 'concrete', (d % 2) * 0.4);
      this._addBox(x, y + drumH * 0.47, z, dr * 0.92, drumH * 0.14, dr * 0.92, tint(0.8), false, 'brick');
    }
    // Capital.
    const capY = base + 0.65 + height - 1.5;
    this._addBox(x, capY + 0.2, z, r * 2.4, 0.4, r * 2.4, tint(1.05), true, 'brick');
    this._addBox(x, capY + 0.56, z, r * 2.9, 0.32, r * 2.9, tint(0.92), true, 'brick');
    if (this.rng.next() < 0.45) {
      this._addBox(x, capY + 0.95, z, r * 2.2, 0.46, r * 2.2, tint(1.0), true, 'concrete', this.rng.range(0, 0.7));
    }
  }

  /** Elevated deck: slab, edge trim, braced legs, and a broken railing. */
  _deck(cx, cz, w, d, h, tint) {
    const base = this.groundHeightAt(cx, cz);
    const top = base + h;
    // Slab with a lipped edge.
    this._addBox(cx, top - 0.25, cz, w, 0.5, d, tint(1.0), true, 'panel');
    this._addBox(cx, top + 0.06, cz, w * 1.04, 0.12, d * 1.04, tint(0.86), false, 'panel');

    // Legs with cross bracing.
    const legs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [ox, oz] of legs) {
      const lx = cx + ox * (w / 2 - 0.9);
      const lz = cz + oz * (d / 2 - 0.9);
      this._addBox(lx, base + h / 2 - 0.25, lz, 0.72, h - 0.5, 0.72, tint(0.88), true, 'panel');
      this._addBox(lx, base + 0.2, lz, 1.5, 0.4, 1.5, tint(0.8), true, 'brick');
    }
    for (const [a, b] of [[legs[0], legs[1]], [legs[2], legs[3]], [legs[0], legs[2]], [legs[1], legs[3]]]) {
      const ax = cx + a[0] * (w / 2 - 0.9), az = cz + a[1] * (d / 2 - 0.9);
      const bx = cx + b[0] * (w / 2 - 0.9), bz = cz + b[1] * (d / 2 - 0.9);
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const len = Math.hypot(bx - ax, bz - az);
      const ang = Math.atan2(bx - ax, bz - az);
      this._addBox(mx, base + h * 0.45, mz, 0.26, 0.26, len, tint(0.78), false, 'panel', ang);
    }

    // Railing posts with gaps where it has collapsed.
    const perim = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [ox, oz] of perim) {
      const count = 4;
      for (let i = 0; i < count; i++) {
        if (this.rng.next() < 0.3) continue;
        const t = (i + 0.5) / count - 0.5;
        const px = cx + ox * (w / 2) + (ox ? 0 : t * w);
        const pz = cz + oz * (d / 2) + (oz ? 0 : t * d);
        this._addBox(px, top + 0.55, pz, 0.16, 0.9, 0.16, tint(0.9), false, 'panel');
      }
      const rx = cx + ox * (w / 2), rz = cz + oz * (d / 2);
      this._addBox(rx, top + 1.0, rz, ox ? 0.14 : w, 0.12, oz ? 0.14 : d, tint(0.84), false, 'panel');
    }
    return { top, base };
  }

  /** Stair flight up to a deck, with side stringers. */
  _stairs(fromX, fromZ, angle, height, tint) {
    const steps = Math.ceil(height / 0.55);
    for (let i = 0; i < steps; i++) {
      const dist = 1.6 + i * 1.05;
      const px = fromX + Math.cos(angle) * dist;
      const pz = fromZ + Math.sin(angle) * dist;
      const h = (i + 1) * 0.55;
      const gy = this.groundHeightAt(px, pz);
      this._addBox(px, gy + h / 2, pz, 3.0, h, 1.1, tint(0.94), true, 'brick', angle);
      if (i % 2 === 0) {
        this._addBox(px, gy + h + 0.06, pz, 3.1, 0.1, 1.15, tint(0.82), false, 'concrete', angle);
      }
    }
  }

  /** Ruined wall: coursed brick, collapsing toward one end, with a doorway. */
  _ruinWall(cx, cz, length, angle, tint) {
    const base = this.groundHeightAt(cx, cz);
    const courses = 5;
    const blockH = 0.52;
    const doorAt = this.rng.next() < 0.5 ? this.rng.range(-0.2, 0.2) : null;
    for (let c = 0; c < courses; c++) {
      const courseLen = length * (1 - c / (courses + 1.4));
      const blocks = Math.max(1, Math.round(courseLen / 1.1));
      for (let bIdx = 0; bIdx < blocks; bIdx++) {
        const t = (bIdx + 0.5) / blocks - 0.5;
        if (doorAt !== null && Math.abs(t - doorAt) < 0.12 && c < 3) continue;
        if (this.rng.next() < 0.08) continue;      // missing block
        const bw = courseLen / blocks;
        const px = cx + Math.cos(angle) * t * courseLen;
        const pz = cz + Math.sin(angle) * t * courseLen;
        this._addBox(px, base + blockH * (c + 0.5), pz, bw * 0.95, blockH, 0.7,
          tint(0.86 + this.rng.next() * 0.3), true, 'brick', angle);
      }
    }
    // Lintel over the doorway.
    if (doorAt !== null) {
      const px = cx + Math.cos(angle) * doorAt * length;
      const pz = cz + Math.sin(angle) * doorAt * length;
      this._addBox(px, base + blockH * 3.5, pz, 1.9, 0.4, 0.85, tint(1.05), true, 'concrete', angle);
    }
  }

  /** Rubble pile: several rotated rock chunks at varied scale. */
  _rubble(x, z, scale, tint) {
    const base = this.groundHeightAt(x, z);
    const chunks = 2 + this.rng.int(0, 3);
    for (let i = 0; i < chunks; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const dist = i === 0 ? 0 : this.rng.range(0.4, 1.3) * scale;
      const sz = scale * this.rng.range(0.5, 1.1);
      this._addBox(
        x + Math.cos(a) * dist, base + sz * 0.4, z + Math.sin(a) * dist,
        sz, sz * this.rng.range(0.55, 0.9), sz * this.rng.range(0.7, 1.2),
        tint(0.85 + this.rng.next() * 0.35), i === 0, 'rock', this.rng.next() * Math.PI,
      );
    }
  }

  /** Rune obelisk — the theme's accent structure. */
  _obelisk(x, z, height, tint) {
    const base = this.groundHeightAt(x, z);
    this._addBox(x, base + 0.25, z, 2.2, 0.5, 2.2, tint(0.9), true, 'brick');
    this._addBox(x, base + 0.62, z, 1.7, 0.34, 1.7, tint(1.0), true, 'brick');
    const shaftH = height - 1.2;
    this._addBox(x, base + 0.8 + shaftH / 2, z, 1.1, shaftH, 1.1, tint(1.0), true, 'rune', this.rng.range(0, 0.5));
    this._addBox(x, base + 0.8 + shaftH + 0.3, z, 0.8, 0.6, 0.8, tint(1.1), false, 'rune');
    this._boxSpecs.push({
      x, y: base + 0.8 + shaftH + 0.75, z, sx: 0.4, sy: 0.7, sz: 0.4,
      color: this.theme.emissive, emissive: true, ry: 0.4,
    });
  }

  _buildProps() {
    this._boxSpecs = [];
    const R = this.radius;
    const rock = new THREE.Color(this.theme.rock);
    const struct = new THREE.Color(this.theme.structure);
    const tintOf = (base) => (f) => base.clone().multiplyScalar(f).getHex();
    const tStruct = tintOf(struct);
    const tRock = tintOf(rock);

    const T = {
      plateauSteps: 4, plateauRise: 0.62, plateauRadius: 16,
      pillars: [16, 22], pillarWidth: [2.4, 5.2], pillarHeight: [4, 13],
      decks: [4, 7], rubble: [28, 42], shards: 26,
      ...(this.theme.terrain || {}),
    };

    // --- Central plateau: coursed masonry ring with capstones ---
    const plateauR = T.plateauRadius;
    for (let step = 0; step < T.plateauSteps; step++) {
      const r = plateauR - step * 3.4;
      const h = T.plateauRise + step * T.plateauRise;
      const segs = 16;
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const w = (2 * Math.PI * r) / segs * 1.14;
        const px = Math.cos(a) * r, pz = Math.sin(a) * r;
        this._addBox(px, h / 2, pz, w, h, 3.2, tStruct(0.92 + (i % 2) * 0.12), true, 'brick', a);
        // Capstone lip along the tread.
        this._addBox(px, h + 0.08, pz, w * 1.02, 0.16, 3.35, tStruct(0.8), false, 'concrete', a);
        if (i % 4 === 0) {
          this._addBox(px, h + 0.5, pz, 0.6, 0.8, 0.6, tStruct(1.06), false, 'brick', a);
        }
      }
    }

    // --- Columns ---
    const pillars = this.rng.int(T.pillars[0], T.pillars[1]);
    for (let i = 0; i < pillars; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = this.rng.range(24, R - 12);
      const h = this.rng.range(T.pillarHeight[0], T.pillarHeight[1]);
      const rad = this.rng.range(T.pillarWidth[0], T.pillarWidth[1]) * 0.34;
      this._column(Math.cos(a) * r, Math.sin(a) * r, h, rad, tRock);
    }

    // --- Decks with stairs ---
    const decks = this.rng.int(T.decks[0], T.decks[1]);
    for (let i = 0; i < decks; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = this.rng.range(26, R - 18);
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      const w = this.rng.range(9, 16), d = this.rng.range(9, 16);
      const h = this.rng.range(3.4, 6.4);
      this._deck(cx, cz, w, d, h, tStruct);
      const sa = this.rng.next() * Math.PI * 2;
      this._stairs(cx + Math.cos(sa) * (w / 2), cz + Math.sin(sa) * (d / 2), sa, h, tRock);
    }

    // --- Ruined walls ---
    const walls = 4 + this.rng.int(0, 4);
    for (let i = 0; i < walls; i++) {
      const p = this.rng.onCircle(R - 14, true);
      if (Math.hypot(p.x, p.z) < plateauR + 6) continue;
      this._ruinWall(p.x, p.z, this.rng.range(5, 10), this.rng.next() * Math.PI, tStruct);
    }

    // --- Obelisks ---
    const obelisks = Math.max(2, Math.round(T.shards / 6));
    for (let i = 0; i < obelisks; i++) {
      const p = this.rng.onCircle(R - 12, true);
      if (Math.hypot(p.x, p.z) < plateauR + 5) continue;
      this._obelisk(p.x, p.z, this.rng.range(4, 8), tStruct);
    }

    // --- Rubble ---
    const rubble = this.rng.int(T.rubble[0], T.rubble[1]);
    for (let i = 0; i < rubble; i++) {
      const p = this.rng.onCircle(R - 8, true);
      if (Math.hypot(p.x, p.z) < plateauR + 4) continue;
      this._rubble(p.x, p.z, this.rng.range(1.1, 2.6), tRock);
    }

    this._commitBoxes();
  }

  /**
   * Builds one InstancedMesh per material.
   *
   * Grouping by material keeps the whole arena to a handful of draw calls while
   * still letting a single structure mix masonry, panelling and rock.
   */
  _commitBoxes() {
    const mats = themeMaterials(this.theme);
    this.structureMeshes = [];

    const groups = new Map();
    for (const b of this._boxSpecs) {
      if (b.emissive) continue;
      const key = b.mat || 'concrete';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();

    for (const [key, list] of groups) {
      const mesh = new THREE.InstancedMesh(UNIT_BOX, mats[key] || mats.concrete, list.length);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      list.forEach((b, i) => {
        e.set(0, b.ry || 0, 0);
        q.setFromEuler(e);
        pos.set(b.x, b.y, b.z);
        scl.set(b.sx, b.sy, b.sz);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, col.setHex(b.color));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
      this.structureMeshes.push(mesh);
    }

    const glow = this._boxSpecs.filter((b) => b.emissive);
    if (glow.length) {
      const gmat = new THREE.MeshBasicMaterial({ color: this.theme.emissive, transparent: true, opacity: 0.62 });
      const ginst = new THREE.InstancedMesh(UNIT_BOX, gmat, glow.length);
      glow.forEach((b, i) => {
        e.set(0, b.ry || 0, 0);
        q.setFromEuler(e);
        m.compose(pos.set(b.x, b.y, b.z), q, scl.set(b.sx, b.sy, b.sz));
        ginst.setMatrixAt(i, m);
      });
      ginst.instanceMatrix.needsUpdate = true;
      this.group.add(ginst);
      this.glowMesh = ginst;
    }
  }

  _buildAtmosphere() {
    // Drifting motes — cheap, and they sell the scale of the space.
    const n = this.theme.particleCount;
    const pos = new Float32Array(n * 3);
    this.moteSeeds = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.decorRng.onCircle(this.radius, true);
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = this.decorRng.range(0.5, 34);
      pos[i * 3 + 2] = p.z;
      this.moteSeeds[i] = this.decorRng.next() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: this.theme.particle, size: 0.34, transparent: true,
      opacity: this.theme.particleOpacity ?? 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.motes = new THREE.Points(geo, mat);
    this.motes.frustumCulled = false;
    this.group.add(this.motes);
  }

  update(dt, time) {
    if (this.windMaterial) this.windMaterial.userData.windTime.value = time;
    if (this.motes) {
      const arr = this.motes.geometry.attributes.position.array;
      const [dx, dy, dz] = this.theme.particleDrift;
      for (let i = 0; i < this.moteSeeds.length; i++) {
        const s = this.moteSeeds[i];
        arr[i * 3] += (dx + Math.sin(time * 0.3 + s) * 0.25) * dt;
        arr[i * 3 + 1] += dy * dt;
        arr[i * 3 + 2] += (dz + Math.cos(time * 0.24 + s) * 0.25) * dt;
        if (arr[i * 3 + 1] > 36) arr[i * 3 + 1] = 0.4;
        if (arr[i * 3 + 1] < 0.2) arr[i * 3 + 1] = 35;
      }
      this.motes.geometry.attributes.position.needsUpdate = true;
    }
    if (this.rimRing) {
      this.rimRing.material.opacity = 0.32 + Math.sin(time * 1.3) * 0.1;
    }
  }

  /**
   * Uniform XZ grid over the colliders.
   *
   * Detailed structures pushed the collider count from ~190 to ~400, and every
   * enemy raycasts the world several times a frame — linear scans made that the
   * single most expensive thing in the simulation. Broadphase queries bring it
   * back to roughly constant cost regardless of how ornate the arena gets.
   */
  buildColliderGrid() {
    this.cellSize = 7;
    this.gridMin = -(this.radius + 14);
    this.gridDim = Math.ceil(((this.radius + 14) * 2) / this.cellSize);
    this.grid = new Array(this.gridDim * this.gridDim);
    this._stamp = new Int32Array(this.colliders.length);
    this._stampTick = 0;
    this._queryOut = [];
    this._rayOut = [];
    // Buckets hold indices into `colliders`. If that array is ever replaced or
    // resized without a rebuild, those indices are stale, so every query checks
    // the length first and falls back to a linear scan rather than handing out
    // undefined entries.
    this._gridColliderCount = this.colliders.length;

    const cellOf = (v) => Math.max(0, Math.min(this.gridDim - 1,
      Math.floor((v - this.gridMin) / this.cellSize)));

    this.colliders.forEach((c, i) => {
      const x0 = cellOf(c.min.x), x1 = cellOf(c.max.x);
      const z0 = cellOf(c.min.z), z1 = cellOf(c.max.z);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const key = cz * this.gridDim + cx;
          (this.grid[key] ||= []).push(i);
        }
      }
    });
  }

  _cellOf(v) {
    return Math.max(0, Math.min(this.gridDim - 1, Math.floor((v - this.gridMin) / this.cellSize)));
  }

  /** Colliders overlapping an XZ box. Reuses one output array — do not retain it. */
  queryAABB(minX, minZ, maxX, maxZ) {
    if (!this.grid || this.colliders.length !== this._gridColliderCount) return this.colliders;
    const out = this._queryOut;
    out.length = 0;
    const tick = ++this._stampTick;
    const x0 = this._cellOf(minX), x1 = this._cellOf(maxX);
    const z0 = this._cellOf(minZ), z1 = this._cellOf(maxZ);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.grid[cz * this.gridDim + cx];
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const i = bucket[k];
          if (this._stamp[i] === tick) continue;
          this._stamp[i] = tick;
          out.push(this.colliders[i]);
        }
      }
    }
    return out;
  }

  /** Colliders along a ray, gathered by walking the grid (2D DDA over XZ). */
  queryRay(origin, dir, maxDist) {
    if (!this.grid || this.colliders.length !== this._gridColliderCount) return this.colliders;
    const out = this._rayOut;
    out.length = 0;
    const tick = ++this._stampTick;

    const collect = (cx, cz) => {
      if (cx < 0 || cz < 0 || cx >= this.gridDim || cz >= this.gridDim) return;
      const bucket = this.grid[cz * this.gridDim + cx];
      if (!bucket) return;
      for (let k = 0; k < bucket.length; k++) {
        const i = bucket[k];
        if (this._stamp[i] === tick) continue;
        this._stamp[i] = tick;
        out.push(this.colliders[i]);
      }
    };

    let cx = this._cellOf(origin.x);
    let cz = this._cellOf(origin.z);
    collect(cx, cz);

    const dx = dir.x, dz = dir.z;
    if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return out;   // vertical ray

    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const cell = this.cellSize;
    const bx = this.gridMin + (cx + (dx > 0 ? 1 : 0)) * cell;
    const bz = this.gridMin + (cz + (dz > 0 ? 1 : 0)) * cell;
    let tMaxX = Math.abs(dx) < 1e-9 ? Infinity : (bx - origin.x) / dx;
    let tMaxZ = Math.abs(dz) < 1e-9 ? Infinity : (bz - origin.z) / dz;
    const tDeltaX = Math.abs(dx) < 1e-9 ? Infinity : Math.abs(cell / dx);
    const tDeltaZ = Math.abs(dz) < 1e-9 ? Infinity : Math.abs(cell / dz);

    let guard = 0;
    while (guard++ < 512) {
      if (tMaxX < tMaxZ) {
        if (tMaxX > maxDist) break;
        cx += stepX; tMaxX += tDeltaX;
      } else {
        if (tMaxZ > maxDist) break;
        cz += stepZ; tMaxZ += tDeltaZ;
      }
      if (cx < 0 || cz < 0 || cx >= this.gridDim || cz >= this.gridDim) break;
      collect(cx, cz);
    }
    return out;
  }

  /** Highest solid surface directly under (x, z) at or below `fromY`. */
  groundHeightAt(x, z, fromY = 999) {
    let best = 0;
    const candidates = this.queryAABB(x, z, x, z);
    for (const c of candidates) {
      if (x < c.min.x || x > c.max.x || z < c.min.z || z > c.max.z) continue;
      if (c.max.y <= fromY + 0.02 && c.max.y > best) best = c.max.y;
    }
    return best;
  }

  /** True when the point sits inside any solid box. */
  isInsideSolid(x, y, z, pad = 0) {
    const candidates = this.queryAABB(x - pad, z - pad, x + pad, z + pad);
    for (const c of candidates) {
      if (x > c.min.x - pad && x < c.max.x + pad &&
          y > c.min.y - pad && y < c.max.y + pad &&
          z > c.min.z - pad && z < c.max.z + pad) return true;
    }
    return false;
  }

  /** A clear standing position, preferring points far from `avoid`. */
  findSpawnPoint(rng, { minDist = 20, maxDist = 55, avoid = null, tries = 40 } = {}) {
    for (let i = 0; i < tries; i++) {
      const a = rng.next() * Math.PI * 2;
      const dist = rng.range(minDist, maxDist);
      let x, z;
      if (avoid) { x = avoid.x + Math.cos(a) * dist; z = avoid.z + Math.sin(a) * dist; }
      else { const p = rng.onCircle(this.radius - 8, true); x = p.x; z = p.z; }
      if (Math.hypot(x, z) > this.radius - 5) continue;
      const y = this.groundHeightAt(x, z);
      if (this.isInsideSolid(x, y + 1.2, z, 0.35)) continue;
      return new THREE.Vector3(x, y, z);
    }
    // Fallback: anywhere on the open ring.
    const p = rng.onCircle(this.radius * 0.6, true);
    return new THREE.Vector3(p.x, this.groundHeightAt(p.x, p.z), p.z);
  }

  /** Scatter positions for interactables, spread apart from one another. */
  scatterPoints(rng, count, { minSeparation = 12, minRadius = 8, maxRadius = null } = {}) {
    const maxR = maxRadius ?? this.radius - 10;
    const out = [];
    let guard = 0;
    while (out.length < count && guard++ < count * 60) {
      const p = rng.onCircle(maxR, true);
      const d = Math.hypot(p.x, p.z);
      if (d < minRadius) continue;
      const y = this.groundHeightAt(p.x, p.z);
      if (this.isInsideSolid(p.x, y + 1.0, p.z, 0.8)) continue;
      if (out.some((o) => o.distanceTo(new THREE.Vector3(p.x, y, p.z)) < minSeparation)) continue;
      out.push(new THREE.Vector3(p.x, y, p.z));
    }
    return out;
  }

  dispose() {
    this.ground?.material.map?.dispose();
    this.propMaterial?.dispose();
    this.windMaterial?.dispose();
    disposeObject(this.group);
  }
}
