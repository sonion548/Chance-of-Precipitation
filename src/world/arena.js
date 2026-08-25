import * as THREE from 'three';
import { WORLD } from '../core/config.js';
import { RNG } from '../core/rng.js';
import { disposeObject } from '../core/engine.js';
import { themeForStage, THEMES_BY_ID } from './themes.js';
import { PROP_BUILDERS, PROP_PHYSICS, propColliders, applyWind } from './props.js';
import { themeMaterials } from './textures.js';

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A vertical gradient, top to bottom, in one unlit material.
 *
 * Used for the sky dome and the haze band. Doing it in a shader rather than
 * with vertex colours means it works on any geometry without having to author
 * a colour attribute, and the alpha ramp is what lets the haze fade into the
 * sky instead of ending in a line.
 */
function gradientMaterial(top, bottom, opts = {}) {
  return new THREE.ShaderMaterial({
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(top) },
      uBottom: { value: new THREE.Color(bottom) },
      uTopA: { value: opts.topAlpha ?? 1 },
      uBottomA: { value: opts.bottomAlpha ?? 1 },
      uPower: { value: opts.power ?? 1 },
    },
    vertexShader: `
      varying float vT;
      void main() {
        vT = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform float uTopA;
      uniform float uBottomA;
      uniform float uPower;
      varying float vT;
      void main() {
        float t = pow(clamp(vT, 0.0, 1.0), uPower);
        gl_FragColor = vec4(mix(uBottom, uTop, t), mix(uBottomA, uTopA, t));
      }`,
  });
}

/** Hermite fade between two edges. Used to blend the landform in and out. */
function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Procedurally generated combat arena: ground, boundary, cover, and colliders.
 *
 * Built from a seed, never from a live RNG handed in by the caller. Two streams
 * come off that seed and they are kept strictly apart:
 *
 * - `rng` draws everything that has a collider — landform, plateau, columns,
 *   decks, stairs, walls, rubble, prop placement and prop variant. This is the
 *   terrain every player has to agree on, so nothing else is ever allowed to
 *   draw from it.
 * - `decorRng` draws things that only exist to be looked at — the ground
 *   texture's mottling and the drifting motes.
 *
 * Splitting them is what makes co-op terrain safe to change. Before, the ground
 * texture pulled ~3,600 numbers out of the same stream the colliders came from,
 * so editing a cosmetic detail — or skipping it on one machine — shifted every
 * structure in the arena and two players ended up on different ground while
 * still believing they shared a seed.
 */
const _scatter = new THREE.Vector3();

export class Arena {
  constructor(scene, seed, stage, opts = {}) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.rng = new RNG(this.seed);
    this.decorRng = new RNG((this.seed ^ 0x9e3779b9) >>> 0);
    this.stage = stage;
    // The sanctum forces its own theme rather than taking a turn in the
    // rotation, and brings its own (much smaller) radius with it.
    // The world's owner decides which place this is; everyone else is told.
    this.theme = opts.theme
      || (opts.themeId && THEMES_BY_ID[opts.themeId])
      || themeForStage(stage, this.rng, opts.avoidTheme);
    this.radius = this.theme.arenaRadius ?? WORLD.arenaRadius;
    this.group = new THREE.Group();
    this._initLandform();
    this.colliders = [];        // { min:Vector3, max:Vector3 }
    this.cameraBlockers = [];   // camera-only: foliage you walk under but cannot see through
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

  /* ==========================================================================
     LANDFORM
     ==========================================================================
     The floor is not a plane any more.

     Every arena used to be a flat disc with things standing on it, which meant
     six stages differed only in their palette and their prop list — the *shape*
     of the ground, which is the thing you actually navigate, was identical
     everywhere. Each theme now carries a landform: an amplitude, a wavelength,
     and three dials that decide whether the relief reads as rolling hills, cut
     shelves, or a jagged ridge field.

     It is an analytic height function rather than a baked heightmap for two
     reasons. Co-op replicates an arena by seed alone, so the ground has to be
     reproducible from that seed and nothing else. And the physics, the camera
     boom and every prop placement need to ask "how high is the ground at this
     exact point" thousands of times a frame, which a closed-form answer gives
     for a handful of trig calls and a texture lookup does not.
  */
  _initLandform() {
    const L = {
      amplitude: 0, scale: 48, detail: 0.35, ridged: 0, bowl: 0, terrace: 0,
      ...(this.theme.landform || {}),
    };
    // Phase offsets come out of the arena's own RNG, so the same seed always
    // grows the same hills — which is what lets a client rebuild the host's
    // level from four bytes.
    L.p0 = this.rng.range(0, 100);
    L.p1 = this.rng.range(0, 100);
    L.p2 = this.rng.range(0, 100);
    L.p3 = this.rng.range(0, 100);
    L.p4 = this.rng.range(0, 100);
    // The centre is held flat so the plateau, the beacon fight and the spawn
    // all sit on level ground, and the last few metres before the wall are
    // flattened too so the boundary ring and its buttresses meet the floor.
    L.flatInner = (this.theme.terrain?.plateauRadius ?? 16) + 5;
    L.flatFade = 16;
    L.rimFrom = this.radius - 18;
    L.rimTo = this.radius - 4;
    L.max = L.amplitude + Math.abs(L.bowl) + 1;
    this._land = L;
    this.terrainMax = L.max;
  }

  /**
   * Ground height at a point, before anything built on top of it.
   *
   * Cheap on purpose: two sine products, one diagonal swell, one fine chop, and
   * a radial term. Everything that makes the six arenas feel different comes
   * out of how those are weighted rather than out of extra octaves.
   */
  terrainHeightAt(x, z) {
    const L = this._land;
    if (!L || L.amplitude <= 0) return 0;

    const r = Math.hypot(x, z);
    const mask = smoothstep(L.flatInner, L.flatInner + L.flatFade, r)
      * (1 - smoothstep(L.rimFrom, L.rimTo, r));
    if (mask <= 0.0001) return 0;

    const f = 1 / L.scale;
    let h = Math.sin(x * f + L.p0) * Math.cos(z * f * 0.87 + L.p1);
    h += 0.55 * Math.sin((x * 0.63 + z * 0.78) * f * 1.9 + L.p2);
    if (L.detail > 0) {
      h += L.detail * 0.42 * Math.sin(x * f * 4.3 + L.p3) * Math.sin(z * f * 3.7 + L.p4);
    }
    h *= 0.62;

    // Ridging folds the field about zero and squares it, which turns smooth
    // swells into crests with valleys between them — the difference between a
    // meadow and a lava field.
    if (L.ridged > 0) {
      const folded = 1 - Math.min(1, Math.abs(h));
      h = h * (1 - L.ridged) + (folded * folded * 2 - 1) * L.ridged;
    }

    h *= L.amplitude;
    // Radial profile: positive lifts the outer ring into a rim, negative sinks
    // the arena into a bowl.
    const t = r / this.radius;
    h += L.bowl * t * t;

    // Terracing quantises the result into shelves. Only partially, so the
    // shelves keep a rounded lip instead of reading as a staircase.
    if (L.terrace > 0) {
      // Weighted rather than hard-quantised, and the weighting matters: a pure
      // step function puts a vertical wall at every threshold, and a wall in
      // the *ground* is worse than a wall you can see, because nothing about
      // it says you cannot walk there. At this ratio a shelf edge is a short
      // scramble the step-up can carry you over.
      const q = Math.round(h / L.terrace) * L.terrace;
      h = h * 0.45 + q * 0.55;
    }
    return h * mask;
  }

  /**
   * The ground mesh: a polar grid displaced by the landform.
   *
   * Polar rather than a clipped plane because the arena is a disc — a square
   * grid either wastes most of its triangles outside the boundary or leaves a
   * ragged edge where the wall meets it. Rings are spaced with a slight bias
   * toward the middle, where the player spends their time.
   */
  _terrainGeometry(radius, rings, segs) {
    const positions = [];
    const uvs = [];
    const indices = [];
    const push = (x, z) => {
      positions.push(x, this.terrainHeightAt(x, z), z);
      uvs.push(x / (2 * radius) + 0.5, z / (2 * radius) + 0.5);
    };

    push(0, 0);
    for (let ring = 1; ring <= rings; ring++) {
      const rr = radius * Math.pow(ring / rings, 0.92);
      for (let s = 0; s < segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        push(Math.cos(a) * rr, Math.sin(a) * rr);
      }
    }
    for (let s = 0; s < segs; s++) {
      indices.push(0, 1 + ((s + 1) % segs), 1 + s);
    }
    for (let ring = 1; ring < rings; ring++) {
      const a0 = 1 + (ring - 1) * segs;
      const b0 = 1 + ring * segs;
      for (let s = 0; s < segs; s++) {
        const s1 = (s + 1) % segs;
        indices.push(a0 + s, b0 + s1, b0 + s);
        indices.push(a0 + s, a0 + s1, b0 + s1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    // The winding above is worked out by hand, and hand-worked winding is how
    // you end up with a level lit from underneath. One cheap assertion against
    // the centre normal, and a flip if it is wrong, is worth more than the
    // comment explaining which way round the fan goes.
    if (geo.attributes.normal.getY(0) < 0) {
      const idx = geo.getIndex().array;
      for (let i = 0; i < idx.length; i += 3) {
        const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
      }
      geo.getIndex().needsUpdate = true;
      geo.computeVertexNormals();
    }
    geo.computeBoundingSphere();
    return geo;
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

    // Prop counts in the theme tables were authored against a 78m arena. The
    // arenas are bigger now, so they are scaled by area rather than re-typed —
    // otherwise every stage would read as the same amount of scenery spread
    // thinner, which is exactly what "bigger map" should not mean.
    const density = Math.min(4.2, Math.pow(this.radius / 78, 1.5));

    for (const spec of theme.props) {
      const build = PROP_BUILDERS[spec.type];
      if (!build) continue;
      const count = Math.round(spec.count * density);

      const variantCount = spec.type === 'grass' ? 4 : 3;
      const variants = [];
      // Variant geometry is drawn from the terrain stream, not the cosmetic one.
      // It used to be cosmetic — a bush's shape did not decide what you bumped
      // into — but colliders are measured off each variant's mesh now, so which
      // variant a prop gets is something every player has to agree on.
      for (let v = 0; v < variantCount; v++) variants.push(build(this.rng, theme.palette));

      // Every variant is measured separately. A prop type makes three or four
      // randomised shapes and they are not the same size as each other, so one
      // collider shared across all of them is wrong for at least two.
      const shapes = variants.map((geo) => propColliders(spec.type, geo));
      const solid = !!PROP_PHYSICS[spec.type];

      // Decide placements first so instance counts per variant are known up front.
      const placements = variants.map(() => []);

      for (let i = 0; i < count; i++) {
        const p = this._propPlacement(spec, solid);
        if (!p) continue;
        const v = Math.floor(this.rng.next() * variantCount);
        placements[v].push(p);
        if (shapes[v]) this._addPropCollider(p, shapes[v]);
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
      if (d < (this.theme.terrain?.plateauRadius ?? 16) + 1) continue;
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

  /**
   * Turns a measured prop shape into world colliders for one instance.
   *
   * The instance carries a non-uniform scale and a yaw, and the collider is an
   * AABB, so a rotated footprint is widened to the box that contains it — the
   * same conservative expansion `_addBox` uses for rotated structures. Being a
   * little generous is the right failure: catching on air a hand's width from a
   * rock reads as solidity, walking through the rock does not.
   */
  _addPropCollider(p, shape) {
    const c = Math.abs(Math.cos(p.yaw));
    const sn = Math.abs(Math.sin(p.yaw));

    for (const box of shape.solid) {
      const hx = box.hx * p.sx;
      const hz = box.hz * p.sz;
      const ex = hx * c + hz * sn;
      const ez = hx * sn + hz * c;
      const cx = p.x + (box.cx * p.sx) * Math.cos(p.yaw) + (box.cz * p.sz) * Math.sin(p.yaw);
      const cz = p.z - (box.cx * p.sx) * Math.sin(p.yaw) + (box.cz * p.sz) * Math.cos(p.yaw);
      this.colliders.push({
        min: new THREE.Vector3(cx - ex, p.y + box.y0 * p.sy, cz - ez),
        max: new THREE.Vector3(cx + ex, p.y + box.y1 * p.sy, cz + ez),
      });
    }

    // Foliage: solid to the camera, thin air to everything else.
    const cam = shape.camera;
    if (cam) {
      const cr = Math.max(cam.hx, cam.hz) * Math.max(p.sx, p.sz);
      this.cameraBlockers.push({
        min: new THREE.Vector3(p.x - cr, p.y + cam.y0 * p.sy, p.z - cr),
        max: new THREE.Vector3(p.x + cr, p.y + cam.y1 * p.sy, p.z + cr),
        cx: p.x, cz: p.z, cr: cr + 0.5,
      });
    }
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
    // Denser tessellation on a landform with real relief; a flat sanctum floor
    // does not need four thousand triangles to be flat.
    const relief = this._land.amplitude > 0.5;
    const geo = this._terrainGeometry(this.radius + 3, relief ? 46 : 10, relief ? 112 : 48);
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

  /* ==========================================================================
     THE EDGE OF THE WORLD
     ==========================================================================
     There used to be a stone wall around every arena — a thirty-metre brick
     cylinder you could see from anywhere in the level. It answered the question
     "what stops me leaving" very clearly and every other question very badly:
     every stage was visibly a room, the horizon was always four seconds away,
     and no amount of landform mattered because the backdrop was masonry.

     What replaces it is two separate things, because they are two separate
     jobs. A **backdrop** says what kind of place this is and goes on past the
     fog — distant ranges, spires, a sky. And a **barrier** says you cannot go
     that way, which is information you only need at the moment it applies, so
     it is invisible until you are almost touching it.
  */
  _buildBoundary() {
    this._buildBackdrop();
    this._buildBarrier();
  }

  /**
   * Distant scenery, well outside the playfield and never collided with.
   *
   * Three rings at increasing distance and decreasing saturation, each a band of
   * low-poly peaks. They sit beyond the fog far plane so they read as haze-blue
   * silhouettes rather than as objects, which is what makes a bounded arena feel
   * like it is somewhere rather than in something.
   */
  _buildBackdrop() {
    const theme = this.theme;
    const group = new THREE.Group();
    group.renderOrder = -1;
    this.group.add(group);
    this.backdrop = group;

    const sky = new THREE.Color(theme.sky);
    const fog = new THREE.Color(theme.fog);
    const rock = new THREE.Color(theme.rock);
    // The horizon is where the fog colour lives; the zenith is the sky proper,
    // pushed a little darker and more saturated so the gradient has somewhere
    // to go. A flat dome reads as a painted wall the moment you look up.
    const zenith = sky.clone().multiplyScalar(0.72).lerp(new THREE.Color(theme.hemiSky), 0.18);
    const horizon = sky.clone().lerp(fog, 0.55);

    const domeR = this.radius * 8.5;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(domeR, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.62),
      gradientMaterial(zenith, horizon, { side: THREE.BackSide, power: 0.85 }),
    );
    dome.position.y = -domeR * 0.08;
    group.add(dome);

    /* Three ranges at increasing distance.
     *
     * Aerial perspective does the work: each ring is washed further toward the
     * horizon colour than the one in front of it, so depth reads from value
     * rather than from parallax — which matters because none of this ever
     * moves relative to the player. */
    /* Distances are multiples of the arena radius, and they are large on
     * purpose. A range at 1.4x the radius subtends thirty-plus degrees, which
     * does not read as a distant mountain — it reads as a wall someone has
     * painted the sky onto. Pushing the nearest ring out past two and a half
     * radii brings it down to about fifteen degrees, which is what a real
     * mountain twenty kilometres away looks like. */
    const rings = [
      { dist: 2.6, height: [70, 150], count: 44, blend: 0.34, width: 0.8 },
      { dist: 3.8, height: [110, 230], count: 34, blend: 0.58, width: 1.05 },
      { dist: 5.2, height: [170, 340], count: 26, blend: 0.78, width: 1.45 },
    ];

    for (const ring of rings) {
      const r = this.radius * ring.dist;
      const colour = rock.clone().multiplyScalar(0.8).lerp(horizon, ring.blend);
      const mat = new THREE.MeshBasicMaterial({ color: colour, fog: false, side: THREE.DoubleSide });
      const geo = new THREE.ConeGeometry(1, 1, 4, 1);
      const inst = new THREE.InstancedMesh(geo, mat, ring.count);
      inst.frustumCulled = false;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      for (let i = 0; i < ring.count; i++) {
        const a = (i / ring.count) * Math.PI * 2 + this.rng.range(-0.08, 0.08);
        const rr = r * this.rng.range(0.88, 1.14);
        const h = this.rng.range(ring.height[0], ring.height[1]);
        const w = h * this.rng.range(0.42, 0.78) * ring.width;
        // A quarter turn of yaw jitter is enough to stop four-sided cones
        // reading as a row of identical pyramids.
        e.set(this.rng.range(-0.05, 0.05), this.rng.next() * Math.PI, this.rng.range(-0.05, 0.05));
        q.setFromEuler(e);
        m.compose(
          new THREE.Vector3(Math.cos(a) * rr, h * 0.42 - this.radius * 0.05, Math.sin(a) * rr),
          q,
          new THREE.Vector3(w, h, w),
        );
        inst.setMatrixAt(i, m);
      }
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
    }

    /* Haze, sitting between the playfield and the ranges.
     *
     * A flat band drew a hard line across the middle of the sky, which is
     * exactly the artefact it exists to prevent. Fading it out with height
     * instead lets the mountains rise out of it. */
    const hazeH = this.radius * 0.9;
    const haze = new THREE.Mesh(
      new THREE.CylinderGeometry(this.radius * 1.6, this.radius * 1.6, hazeH, 64, 1, true),
      gradientMaterial(fog, fog, {
        side: THREE.BackSide, transparent: true, topAlpha: 0, bottomAlpha: 0.92, power: 1.5,
      }),
    );
    haze.position.y = hazeH * 0.32;
    group.add(haze);
  }

  /**
   * The barrier: a containment field you only see when it concerns you.
   *
   * One cylinder, one shader, no colliders — the radial clamp in the physics
   * has always been what actually stops you, and this is purely the readout for
   * it. Opacity is driven by the player's distance from the wall, so from the
   * middle of the arena there is nothing there at all and walking into it lights
   * up the panel you are pressed against rather than the whole ring.
   */
  _buildBarrier() {
    const height = WORLD.wallHeight;
    const geo = new THREE.CylinderGeometry(this.radius, this.radius, height, 96, 1, true);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPlayer: { value: new THREE.Vector3(0, 0, 0) },
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x4aa8ff) },
        uHot: { value: new THREE.Color(0xd8f0ff) },
        uNear: { value: 4.0 },       // fully lit within this of the wall
        uFar: { value: 19.0 },       // invisible beyond this
        uHeight: { value: height },
      },
      vertexShader: `
        varying vec3 vWorld;
        varying float vY;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vY = uv.y;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 uPlayer;
        uniform vec3 uColor;
        uniform vec3 uHot;
        uniform float uTime;
        uniform float uNear;
        uniform float uFar;
        varying vec3 vWorld;
        varying float vY;

        void main() {
          // Proximity: measured from the player to this point on the wall, in
          // the plane. Distance along the wall matters as much as distance to
          // it, so pressing into one side does not light up the far side.
          float d = distance(vWorld.xz, uPlayer.xz);
          float prox = 1.0 - smoothstep(uNear, uFar, d);
          if (prox <= 0.001) discard;

          // Hexagonal lattice. Two offset square grids, nearest-cell wins, and
          // the distance to that cell's hex edge is the line. A real hex tiling
          // rather than crossed stripes, because stripes on a curved surface
          // read as a shading artefact rather than as a structure.
          vec2 uvh = vec2(atan(vWorld.z, vWorld.x) * 76.0, vWorld.y * 1.35);
          vec2 hs = vec2(1.0, 1.7320508);
          vec2 a1 = mod(uvh, hs) - hs * 0.5;
          vec2 b1 = mod(uvh - hs * 0.5, hs) - hs * 0.5;
          vec2 gv = dot(a1, a1) < dot(b1, b1) ? a1 : b1;
          vec2 ag = abs(gv);
          float hex = max(dot(ag, normalize(vec2(1.0, 1.7320508))), ag.x);
          float lattice = smoothstep(0.40, 0.5, hex);

          // A slow vertical scan, so the field reads as powered rather than painted.
          float scan = 0.5 + 0.5 * sin(vWorld.y * 0.6 - uTime * 1.6);

          // Fades out at the top so it does not end in a hard line against the sky.
          float fade = 1.0 - smoothstep(0.22, 0.8, vY);

          // Mostly the cell edges, with a faint fill so the panel reads as a
          // surface rather than as wireframe floating in front of the sky.
          float a = prox * fade * (0.03 + lattice * 0.22 + scan * 0.04 * lattice);
          vec3 col = mix(uColor, uHot, lattice * 0.65);
          gl_FragColor = vec4(col, a);
        }`,
    });
    const barrier = new THREE.Mesh(geo, mat);
    barrier.position.y = height / 2 - 1;
    barrier.frustumCulled = false;
    this.group.add(barrier);
    this.barrier = barrier;

    // A dim ground line where the field meets the floor. Same proximity rule,
    // so it is not a permanent racing-track edge painted round the arena.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(this.radius - 0.3, 0.22, 6, 96),
      new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0, depthWrite: false }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.5;
    ring.frustumCulled = false;
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
    // Same reasoning as the prop density: a wider arena needs proportionally
    // more structure or it turns into a field with some ruins at one end.
    const density = Math.min(4.0, Math.pow(R / 78, 1.55));
    const scaled = (n) => Math.round(n * density);

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
    /* Cap the middle.
     *
     * The steps are rings, and rings enclose nothing — which meant the centre
     * of every arena was a four-metre well with a two-and-a-half-metre masonry
     * wall round it. It was meant to be a ziggurat and it was built as an
     * amphitheatre with no seats. One box fills it: its corners are buried
     * inside the innermost ring, so a square reads as the round platform the
     * rings imply. */
    const capR = plateauR - (T.plateauSteps - 1) * 3.4 - 1.6;
    if (capR > 0.8) {
      const capH = T.plateauRise * T.plateauSteps;
      this._addBox(0, capH / 2, 0, capR * 2, capH, capR * 2, tStruct(0.98), true, 'brick');
      this._addBox(0, capH + 0.09, 0, capR * 2.02, 0.18, capR * 2.02, tStruct(0.84), false, 'concrete');
    }

    // --- Columns ---
    const pillars = scaled(this.rng.int(T.pillars[0], T.pillars[1]));
    for (let i = 0; i < pillars; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = this.rng.range(T.plateauRadius + 8, R - 12);
      const h = this.rng.range(T.pillarHeight[0], T.pillarHeight[1]);
      const rad = this.rng.range(T.pillarWidth[0], T.pillarWidth[1]) * 0.34;
      this._column(Math.cos(a) * r, Math.sin(a) * r, h, rad, tRock);
    }

    // --- Decks with stairs ---
    const decks = scaled(this.rng.int(T.decks[0], T.decks[1]));
    for (let i = 0; i < decks; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = this.rng.range(T.plateauRadius + 12, R - 18);
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      const w = this.rng.range(9, 16), d = this.rng.range(9, 16);
      const h = this.rng.range(3.4, 6.4);
      this._deck(cx, cz, w, d, h, tStruct);
      const sa = this.rng.next() * Math.PI * 2;
      this._stairs(cx + Math.cos(sa) * (w / 2), cz + Math.sin(sa) * (d / 2), sa, h, tRock);
    }

    // --- Ruined walls ---
    const walls = scaled(4 + this.rng.int(0, 4));
    for (let i = 0; i < walls; i++) {
      const p = this.rng.onCircle(R - 14, true);
      if (Math.hypot(p.x, p.z) < plateauR + 6) continue;
      this._ruinWall(p.x, p.z, this.rng.range(5, 10), this.rng.next() * Math.PI, tStruct);
    }

    // --- Obelisks ---
    const obelisks = scaled(Math.max(2, Math.round(T.shards / 6)));
    for (let i = 0; i < obelisks; i++) {
      const p = this.rng.onCircle(R - 12, true);
      if (Math.hypot(p.x, p.z) < plateauR + 5) continue;
      this._obelisk(p.x, p.z, this.rng.range(4, 8), tStruct);
    }

    // --- Rubble ---
    const rubble = scaled(this.rng.int(T.rubble[0], T.rubble[1]));
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
    if (this.barrier) {
      this.barrier.material.uniforms.uTime.value = time;
      const p = this.barrierFocus;
      if (p) {
        this.barrier.material.uniforms.uPlayer.value.copy(p);
        // The floor line follows the same rule as the field above it.
        const edge = this.radius - Math.hypot(p.x, p.z);
        this.rimRing.material.opacity = clamp01(1 - edge / 22) * (0.34 + Math.sin(time * 2.4) * 0.08);
        this.rimRing.position.y = this.terrainHeightAt(p.x, p.z) + 0.5;
      }
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
    let best = this.terrainHeightAt(x, z);
    const candidates = this.queryAABB(x, z, x, z);
    for (const c of candidates) {
      if (x < c.min.x || x > c.max.x || z < c.min.z || z > c.max.z) continue;
      if (c.max.y <= fromY + 0.02 && c.max.y > best) best = c.max.y;
    }
    return best;
  }

  /** True when the point sits inside any solid box, or under the ground. */
  isInsideSolid(x, y, z, pad = 0) {
    if (y < this.terrainHeightAt(x, z) - pad) return true;
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
  /**
   * Well-separated open spots for chests, eggs and the like.
   *
   * The separation relaxes if the arena cannot fit the request. A four-player
   * stage asks for close to twenty points at 13m apart, which does not fit in a
   * 78m circle that is already full of ruins — and silently returning twelve
   * meant the things placed last (the eggs) simply never appeared.
   */
  scatterPoints(rng, count, { minSeparation = 12, minRadius = 8, maxRadius = null } = {}) {
    const maxR = maxRadius ?? this.radius - 10;
    const out = [];
    let sep = minSeparation;
    for (let pass = 0; pass < 5 && out.length < count; pass++) {
      let guard = 0;
      while (out.length < count && guard++ < count * 60) {
        const p = rng.onCircle(maxR, true);
        const d = Math.hypot(p.x, p.z);
        if (d < minRadius) continue;
        const y = this.groundHeightAt(p.x, p.z);
        if (this.isInsideSolid(p.x, y + 1.0, p.z, 0.8)) continue;
        if (out.some((o) => o.distanceTo(_scatter.set(p.x, y, p.z)) < sep)) continue;
        out.push(new THREE.Vector3(p.x, y, p.z));
      }
      sep *= 0.72;      // crowd them a little and try again
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
