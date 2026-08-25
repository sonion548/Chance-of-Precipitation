import * as THREE from 'three';

/**
 * Low-poly prop library.
 *
 * Every builder returns a single BufferGeometry so the scatterer can drive it
 * through one InstancedMesh — the whole dressing of an arena costs a handful of
 * draw calls rather than one per bush.
 *
 * Production constraints this is built against:
 *   • Silhouette first. These read at 40–200m through fog, so shapes are
 *     separated by outline, not detail.
 *   • Intentional triangle budgets (listed per builder). Static props, so
 *     triangles are fine; nothing here deforms.
 *   • Geometry is authored at unit scale around a base at y = 0, letting the
 *     scatterer own placement, tilt and non-uniform scale.
 *   • Flat shading throughout — normals are per-face by construction, so the
 *     facets that define the look survive.
 */

const _v = new THREE.Vector3();

/** Merges positional geometries without pulling in BufferGeometryUtils. */
function mergeGeometries(parts) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const { geo } of parts) {
    vertexCount += geo.attributes.position.count;
    indexCount += geo.index ? geo.index.count : geo.attributes.position.count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const index = new Uint16Array(indexCount);

  let vOff = 0;
  let iOff = 0;
  const nm = new THREE.Matrix3();
  const c = new THREE.Color();

  for (const { geo, matrix, color: hex } of parts) {
    const p = geo.attributes.position;
    const n = geo.attributes.normal;
    // A geometry that is itself a merge already carries per-vertex colour; keep it
    // unless this part explicitly overrides, or nested props come out white.
    const srcColor = hex === undefined ? geo.attributes.color : null;
    if (matrix) nm.getNormalMatrix(matrix);
    c.setHex(hex ?? 0xffffff);

    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      if (matrix) _v.applyMatrix4(matrix);
      position[(vOff + i) * 3] = _v.x;
      position[(vOff + i) * 3 + 1] = _v.y;
      position[(vOff + i) * 3 + 2] = _v.z;

      if (n) {
        _v.fromBufferAttribute(n, i);
        if (matrix) _v.applyMatrix3(nm).normalize();
        normal[(vOff + i) * 3] = _v.x;
        normal[(vOff + i) * 3 + 1] = _v.y;
        normal[(vOff + i) * 3 + 2] = _v.z;
      }

      if (srcColor) {
        color[(vOff + i) * 3] = srcColor.getX(i);
        color[(vOff + i) * 3 + 1] = srcColor.getY(i);
        color[(vOff + i) * 3 + 2] = srcColor.getZ(i);
      } else {
        color[(vOff + i) * 3] = c.r;
        color[(vOff + i) * 3 + 1] = c.g;
        color[(vOff + i) * 3 + 2] = c.b;
      }
    }

    if (geo.index) {
      for (let i = 0; i < geo.index.count; i++) index[iOff + i] = geo.index.array[i] + vOff;
      iOff += geo.index.count;
    } else {
      for (let i = 0; i < p.count; i++) index[iOff + i] = i + vOff;
      iOff += p.count;
    }
    vOff += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  for (const { geo } of parts) geo.dispose();
  return out;
}

const part = (geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = 0xffffff } = {}) => {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
    new THREE.Vector3(...scale),
  );
  return { geo, matrix: m, color };
};

/* ==========================================================================
   GROUND COVER
   ========================================================================== */

/**
 * Grass tuft — 5 tapered blades, 2 tris each (10 tris).
 * Blades are real geometry rather than alpha cards: no sorting, no overdraw,
 * and they hold their shape when the wind shader bends them.
 */
export function grassTuft(rng, palette) {
  const parts = [];
  const blades = 4 + Math.floor(rng.next() * 3);
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const h = rng.range(0.42, 0.95);
    const w = rng.range(0.05, 0.09);
    const lean = rng.range(0.12, 0.42);

    // Tapered quad: wide at the root, pinched at the tip.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -w, 0, 0, w, 0, 0, -w * 0.35, h * 0.6, lean * h * 0.4,
      w * 0.35, h * 0.6, lean * h * 0.4, 0, h, lean * h,
    ]), 3));
    g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    g.computeVertexNormals();
    parts.push(part(g, {
      rot: [0, a, 0],
      pos: [Math.cos(a) * rng.range(0, 0.16), 0, Math.sin(a) * rng.range(0, 0.16)],
      color: pick(rng, palette.grass),
    }));
  }
  return mergeGeometries(parts);
}

/** Fern — 6 fronds radiating from a crown. ~24 tris. */
export function fern(rng, palette) {
  const parts = [];
  const fronds = 5 + Math.floor(rng.next() * 3);
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2;
    const len = rng.range(0.7, 1.15);
    const g = new THREE.PlaneGeometry(0.2, len, 1, 2);
    // Droop the frond so it arcs instead of standing flat.
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const t = (p.getY(v) + len / 2) / len;
      p.setZ(v, -t * t * len * 0.42);
    }
    g.computeVertexNormals();
    parts.push(part(g, {
      pos: [Math.cos(a) * 0.1, len * 0.5 + 0.05, Math.sin(a) * 0.1],
      rot: [Math.PI / 2 - rng.range(0.5, 0.85), a, 0],
      color: pick(rng, palette.foliage),
    }));
  }
  return mergeGeometries(parts);
}

/** Reeds — tall thin blades for water edges and marsh. ~12 tris. */
export function reeds(rng, palette) {
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const h = rng.range(1.2, 2.3);
    const g = new THREE.BufferGeometry();
    const w = 0.035;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -w, 0, 0, w, 0, 0, 0, h, rng.range(-0.25, 0.25),
    ]), 3));
    g.setIndex([0, 1, 2]);
    g.computeVertexNormals();
    parts.push(part(g, {
      rot: [0, rng.next() * Math.PI * 2, 0],
      pos: [rng.range(-0.2, 0.2), 0, rng.range(-0.2, 0.2)],
      color: pick(rng, palette.grass),
    }));
  }
  return mergeGeometries(parts);
}

/* ==========================================================================
   SHRUBS & TREES
   ========================================================================== */

/** Bush — 3 overlapping icospheres. 60 tris, one clean silhouette. */
export function bush(rng, palette) {
  const parts = [];
  const blobs = 3;
  for (let i = 0; i < blobs; i++) {
    const r = rng.range(0.34, 0.6);
    parts.push(part(new THREE.IcosahedronGeometry(r, 0), {
      pos: [rng.range(-0.35, 0.35), r * rng.range(0.7, 1.1), rng.range(-0.35, 0.35)],
      scale: [1, rng.range(0.7, 1), 1],
      color: pick(rng, palette.foliage),
    }));
  }
  return mergeGeometries(parts);
}

/**
 * Tree — trunk plus 2–3 stacked canopy shells.
 * ~120 tris. Canopy blobs are offset off-axis so the silhouette is asymmetric;
 * a perfectly stacked cone reads as a traffic cone at distance.
 */
export function tree(rng, palette) {
  const parts = [];
  const h = rng.range(3.4, 6.2);
  const trunkR = h * 0.055;

  const trunk = new THREE.CylinderGeometry(trunkR * 0.7, trunkR, h, 5);
  parts.push(part(trunk, { pos: [0, h / 2, 0], color: pick(rng, palette.bark) }));

  const tiers = 2 + Math.floor(rng.next() * 2);
  for (let i = 0; i < tiers; i++) {
    const t = i / Math.max(1, tiers - 1);
    const r = h * (0.34 - t * 0.13) * rng.range(0.85, 1.15);
    parts.push(part(new THREE.IcosahedronGeometry(r, 0), {
      pos: [rng.range(-0.3, 0.3), h * (0.68 + t * 0.26), rng.range(-0.3, 0.3)],
      scale: [1, rng.range(0.72, 0.95), 1],
      color: pick(rng, palette.foliage),
    }));
  }
  return mergeGeometries(parts);
}

/** Conifer — stacked cones. ~90 tris. Reads instantly against a skyline. */
export function conifer(rng, palette) {
  const parts = [];
  const h = rng.range(4.5, 8);
  parts.push(part(new THREE.CylinderGeometry(h * 0.03, h * 0.05, h * 0.4, 5), {
    pos: [0, h * 0.2, 0], color: pick(rng, palette.bark),
  }));
  const tiers = 3;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    parts.push(part(new THREE.ConeGeometry(h * (0.24 - t * 0.06), h * 0.36, 6), {
      pos: [0, h * (0.34 + t * 0.24), 0],
      color: pick(rng, palette.foliage),
    }));
  }
  return mergeGeometries(parts);
}

/** Dead tree — bare trunk with angled branches. ~70 tris. */
export function deadTree(rng, palette) {
  const parts = [];
  const h = rng.range(3, 5.5);
  parts.push(part(new THREE.CylinderGeometry(h * 0.03, h * 0.07, h, 5), {
    pos: [0, h / 2, 0], rot: [rng.range(-0.08, 0.08), 0, rng.range(-0.08, 0.08)],
    color: pick(rng, palette.bark),
  }));
  for (let i = 0; i < 4; i++) {
    const a = rng.next() * Math.PI * 2;
    const bh = h * rng.range(0.45, 0.9);
    const len = h * rng.range(0.18, 0.34);
    parts.push(part(new THREE.CylinderGeometry(h * 0.012, h * 0.025, len, 4), {
      pos: [Math.cos(a) * len * 0.35, bh, Math.sin(a) * len * 0.35],
      rot: [Math.PI / 2.6 * Math.sin(a), -a, Math.PI / 2.6 * Math.cos(a)],
      color: pick(rng, palette.bark),
    }));
  }
  return mergeGeometries(parts);
}

/** Mushroom cluster — 3 caps on stems. ~70 tris. */
export function mushrooms(rng, palette) {
  const parts = [];
  const n = 2 + Math.floor(rng.next() * 3);
  for (let i = 0; i < n; i++) {
    const h = rng.range(0.3, 0.75);
    const r = h * rng.range(0.42, 0.7);
    const x = rng.range(-0.4, 0.4);
    const z = rng.range(-0.4, 0.4);
    parts.push(part(new THREE.CylinderGeometry(h * 0.11, h * 0.15, h, 5), {
      pos: [x, h / 2, z], color: 0xe8e0d0,
    }));
    parts.push(part(new THREE.ConeGeometry(r, r * 0.85, 7), {
      pos: [x, h + r * 0.3, z], color: pick(rng, palette.accentProps),
    }));
  }
  return mergeGeometries(parts);
}

/* ==========================================================================
   ROCK
   ========================================================================== */

/**
 * Rock — an icosahedron with vertices jittered along their own normal.
 * 20 tris. Displacing along the normal keeps every face planar-ish and the
 * silhouette angular; random XYZ jitter produces pinched, ugly facets.
 */
export function rock(rng, palette, { detail = 0, jitter = 0.28 } = {}) {
  const g = new THREE.IcosahedronGeometry(0.5, detail);
  const p = g.attributes.position;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    _v.fromBufferAttribute(p, i);
    // Shared vertices must move together or the mesh splits open.
    const key = `${_v.x.toFixed(3)},${_v.y.toFixed(3)},${_v.z.toFixed(3)}`;
    let scale = seen.get(key);
    if (scale === undefined) { scale = 1 + rng.range(-jitter, jitter); seen.set(key, scale); }
    _v.multiplyScalar(scale);
    p.setXYZ(i, _v.x, _v.y * rng.range(0.75, 1.0), _v.z);
  }
  g.computeVertexNormals();
  return mergeGeometries([part(g, { pos: [0, 0.34, 0], color: pick(rng, palette.rock) })]);
}

/** Rock cluster — one large plus two satellites. ~60 tris. */
export function rockCluster(rng, palette) {
  const parts = [];
  const main = rock(rng, palette, { jitter: 0.3 });
  parts.push(part(main, { scale: [1.4, 1.2, 1.4] }));
  for (let i = 0; i < 2; i++) {
    const a = rng.next() * Math.PI * 2;
    const s = rng.range(0.4, 0.7);
    parts.push(part(rock(rng, palette, { jitter: 0.34 }), {
      pos: [Math.cos(a) * rng.range(0.6, 1.1), -0.1, Math.sin(a) * rng.range(0.6, 1.1)],
      scale: [s, s * 0.8, s],
    }));
  }
  return mergeGeometries(parts);
}

/** Crystal spire — clustered octahedra. ~40 tris, emissive-tinted. */
export function crystal(rng, palette) {
  const parts = [];
  const n = 2 + Math.floor(rng.next() * 3);
  for (let i = 0; i < n; i++) {
    const h = rng.range(0.8, 2.2);
    const a = rng.next() * Math.PI * 2;
    parts.push(part(new THREE.OctahedronGeometry(0.28, 0), {
      pos: [Math.cos(a) * rng.range(0, 0.4), h * 0.5, Math.sin(a) * rng.range(0, 0.4)],
      rot: [rng.range(-0.25, 0.25), a, rng.range(-0.25, 0.25)],
      scale: [1, h * 1.7, 1],
      color: pick(rng, palette.crystal),
    }));
  }
  return mergeGeometries(parts);
}

/* ==========================================================================
   STRUCTURES
   ========================================================================== */

/** Broken column — fluted shaft with an angled break. ~70 tris. */
export function ruinColumn(rng, palette) {
  const parts = [];
  const h = rng.range(2.2, 5.5);
  const r = rng.range(0.3, 0.5);
  parts.push(part(new THREE.CylinderGeometry(r * 0.92, r, h, 8), {
    pos: [0, h / 2, 0], color: pick(rng, palette.stone),
  }));
  // Base plinth reads as "built" rather than "dropped".
  parts.push(part(new THREE.BoxGeometry(r * 2.6, 0.28, r * 2.6), {
    pos: [0, 0.14, 0], color: pick(rng, palette.stone),
  }));
  if (rng.next() < 0.6) {
    parts.push(part(new THREE.BoxGeometry(r * 2.4, 0.24, r * 2.4), {
      pos: [0, h + 0.12, 0], rot: [0, rng.range(0, 0.6), 0], color: pick(rng, palette.stone),
    }));
  }
  return mergeGeometries(parts);
}

/** Ruined arch — two piers and a lintel. ~80 tris. Great mid-ground framing. */
export function ruinArch(rng, palette) {
  const parts = [];
  const w = rng.range(2.6, 4.2);
  const h = rng.range(3, 4.6);
  const t = 0.42;
  for (const side of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(t, h, t * 1.2), {
      pos: [side * w / 2, h / 2, 0],
      rot: [0, 0, side * rng.range(0, 0.05)],
      color: pick(rng, palette.stone),
    }));
  }
  parts.push(part(new THREE.BoxGeometry(w + t, t * 0.9, t * 1.3), {
    pos: [0, h, 0], color: pick(rng, palette.stone),
  }));
  return mergeGeometries(parts);
}

/** Broken wall — staggered blocks with a collapsed end. ~90 tris. */
export function brokenWall(rng, palette) {
  const parts = [];
  const len = rng.range(3, 6);
  const courses = 3 + Math.floor(rng.next() * 3);
  const blockH = 0.42;
  for (let c = 0; c < courses; c++) {
    // Each course is shorter than the last, so the wall reads as ruined.
    const courseLen = len * (1 - c / (courses + 1.2)) * rng.range(0.85, 1);
    const blocks = Math.max(1, Math.round(courseLen / 0.9));
    for (let b = 0; b < blocks; b++) {
      const bw = courseLen / blocks;
      parts.push(part(new THREE.BoxGeometry(bw * 0.94, blockH, 0.6), {
        pos: [-courseLen / 2 + bw * (b + 0.5), blockH * (c + 0.5), rng.range(-0.04, 0.04)],
        rot: [0, rng.range(-0.05, 0.05), 0],
        color: pick(rng, palette.stone),
      }));
    }
  }
  return mergeGeometries(parts);
}

/** Standing monolith — a leaning slab with a carved band. ~40 tris. */
export function monolith(rng, palette) {
  const parts = [];
  const h = rng.range(3.5, 7);
  const w = rng.range(0.8, 1.5);
  parts.push(part(new THREE.BoxGeometry(w, h, w * 0.42), {
    pos: [0, h / 2, 0], rot: [rng.range(-0.06, 0.06), rng.next() * 3, rng.range(-0.06, 0.06)],
    color: pick(rng, palette.stone),
  }));
  parts.push(part(new THREE.BoxGeometry(w * 1.08, h * 0.09, w * 0.5), {
    pos: [0, h * 0.68, 0], color: pick(rng, palette.crystal),
  }));
  return mergeGeometries(parts);
}

/* ==========================================================================
   REGISTRY
   ========================================================================== */

function pick(rng, arr) { return arr[Math.floor(rng.next() * arr.length)]; }

export const PROP_BUILDERS = {
  grass: grassTuft,
  fern,
  reeds,
  bush,
  tree,
  conifer,
  deadTree,
  mushrooms,
  rock,
  rockCluster,
  crystal,
  ruinColumn,
  ruinArch,
  brokenWall,
  monolith,
};

/** Props that should block movement, with an approximate collision footprint. */
/**
 * Colliders, plus what the camera should treat as solid.
 *
 * A tree's trunk is 0.8m across; its canopy is five times that and has no
 * collider at all, because you are meant to walk under it. The camera is not —
 * so foliage gets a `camera` volume that blocks the boom without blocking
 * anybody's feet.
 */
/**
 * How each prop type is meant to be collided with — the *policy*, not the
 * numbers.
 *
 * The numbers used to live here too: a hand-written radius and height per type.
 * That could only ever be approximately right, because every builder makes
 * several randomised variants and the scatterer then scales each instance
 * again, so a fat-trunked oak and a spindly one shared one radius. The result
 * was rocks you walked through, columns that stopped you a metre early, and
 * boulders with no collider at all because nobody had added a row.
 *
 * Now the shape is measured off the geometry that actually got built (see
 * `propColliders`), and this table only says what *kind* of thing it is:
 *
 *   null      no collider — you walk through grass
 *   trunk     a narrow solid trunk with a canopy above it that only the camera
 *             collides with, so you can stand under a tree and still see out
 *   box       the whole silhouette is solid
 *   arch      solid legs, open middle: you can walk through the arch
 */
export const PROP_PHYSICS = {
  grass: null, fern: null, reeds: null, bush: null, mushrooms: null,

  tree: { kind: 'trunk', trunkTo: 0.40, canopyFrom: 0.38 },
  conifer: { kind: 'trunk', trunkTo: 0.26, canopyFrom: 0.18 },
  // A dead tree has no canopy worth hiding behind, so it is trunk all the way up.
  deadTree: { kind: 'trunk', trunkTo: 0.55, canopyFrom: 1.0 },

  rock: { kind: 'box', shrink: 0.86 },
  rockCluster: { kind: 'box', shrink: 0.88 },
  crystal: { kind: 'box', shrink: 0.78 },
  monolith: { kind: 'box', shrink: 0.92 },
  ruinColumn: { kind: 'box', shrink: 0.88 },
  brokenWall: { kind: 'box', shrink: 0.94 },
  ruinArch: { kind: 'arch' },
};

/** Half-extents of every vertex in a Y band, or null if the band is empty. */
function bandExtent(pos, y0, y1, xMin = -Infinity, xMax = Infinity) {
  let maxX = 0;
  let maxZ = 0;
  let found = false;
  let loX = Infinity;
  let hiX = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < y0 || y > y1) continue;
    const x = pos.getX(i);
    if (x < xMin || x > xMax) continue;
    found = true;
    if (Math.abs(x) > maxX) maxX = Math.abs(x);
    if (Math.abs(pos.getZ(i)) > maxZ) maxZ = Math.abs(pos.getZ(i));
    if (x < loX) loX = x;
    if (x > hiX) hiX = x;
  }
  return found ? { hx: maxX, hz: maxZ, loX, hiX } : null;
}

/**
 * Measures collision volumes off a built prop geometry, in its own unit space.
 *
 * Returns `{ solid: [{cx, cz, hx, hz, y0, y1}], camera: {hx, hz, y0, y1} | null }`.
 * The scatterer scales, rotates and positions these per instance — this is the
 * shape, not the placement.
 *
 * Measuring rather than declaring is the whole point. A builder can change what
 * it makes, or gain a variant twice the width, and the thing you bump into
 * changes with it instead of drifting out of step.
 */
export function propColliders(type, geo) {
  const spec = PROP_PHYSICS[type];
  if (!spec) return null;
  const pos = geo.attributes.position;
  if (!pos) return null;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const height = Math.max(0.05, bb.max.y);
  const out = { solid: [], camera: null };

  if (spec.kind === 'trunk') {
    /* The band starts fractionally below zero on purpose.
     *
     * A trunk is a cylinder, and a cylinder has vertices at its two caps and
     * nowhere in between. The bottom cap sits at y = 0 — or at -1e-8, once it
     * has been through a transform — and an exact `y >= 0` test drops it, which
     * left the whole band empty and every tree in the game with no collider at
     * all. Nothing else in the band moves, so the tolerance is free. */
    const trunk = bandExtent(pos, -0.01, height * spec.trunkTo)
      // If the shape genuinely has nothing down there, fall back to a share of
      // the silhouette rather than emitting no collider.
      || { hx: (bb.max.x - bb.min.x) * 0.12, hz: (bb.max.z - bb.min.z) * 0.12 };
    if (trunk) {
      // A trunk measured at its widest is the flare at the root, which is not
      // what you walk into. Two thirds of it is the shaft.
      out.solid.push({
        cx: 0, cz: 0,
        hx: Math.max(0.12, trunk.hx * 0.68), hz: Math.max(0.12, trunk.hz * 0.68),
        y0: 0, y1: height * Math.min(1, spec.canopyFrom + 0.1),
      });
    }
    if (spec.canopyFrom < 1) {
      const canopy = bandExtent(pos, height * spec.canopyFrom, height);
      if (canopy) {
        out.camera = { hx: canopy.hx * 0.9, hz: canopy.hz * 0.9, y0: height * spec.canopyFrom, y1: height };
      }
    }
    return out;
  }

  if (spec.kind === 'arch') {
    // Legs only: sample near the base and split by which side of the centre
    // each vertex is on, so the opening stays walkable.
    const legTop = height * 0.62;
    for (const [xMin, xMax] of [[-Infinity, -0.05], [0.05, Infinity]]) {
      const leg = bandExtent(pos, -0.01, height * 0.25, xMin, xMax);
      if (!leg) continue;
      const cx = (leg.loX + leg.hiX) / 2;
      out.solid.push({
        cx, cz: 0,
        hx: Math.max(0.15, (leg.hiX - leg.loX) / 2), hz: Math.max(0.15, leg.hz * 0.9),
        y0: 0, y1: legTop,
      });
    }
    if (!out.solid.length) {
      out.solid.push({ cx: 0, cz: 0, hx: bb.max.x * 0.9, hz: bb.max.z * 0.9, y0: 0, y1: legTop });
    }
    return out;
  }

  // Plain box: the silhouette, pulled in a little so you are not stopped by air.
  const k = spec.shrink ?? 0.9;
  out.solid.push({
    cx: (bb.min.x + bb.max.x) / 2 * k,
    cz: (bb.min.z + bb.max.z) / 2 * k,
    hx: Math.max(0.1, (bb.max.x - bb.min.x) / 2 * k),
    hz: Math.max(0.1, (bb.max.z - bb.min.z) / 2 * k),
    y0: 0, y1: height,
  });
  return out;
}

/**
 * Wind sway, injected into the standard material.
 *
 * Displacing in the vertex shader keeps the CPU out of it entirely — 900 grass
 * tufts cost nothing per frame. Sway scales with local height so roots stay put,
 * and the phase is offset by instance position so the field ripples.
 */
export function applyWind(material, strength = 0.16) {
  material.userData.windTime = { value: 0 };
  material.userData.windStrength = { value: strength };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = material.userData.windTime;
    shader.uniforms.uWindStrength = material.userData.windStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uWindTime;
        uniform float uWindStrength;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 wInst = instanceMatrix[3].xyz;
        #else
          vec3 wInst = vec3(0.0);
        #endif
        float wPhase = uWindTime * 1.7 + wInst.x * 0.32 + wInst.z * 0.27;
        float wAmt = uWindStrength * max(transformed.y, 0.0)
                   * (0.65 + 0.35 * sin(wPhase * 0.5));
        transformed.x += sin(wPhase) * wAmt;
        transformed.z += cos(wPhase * 0.83) * wAmt * 0.7;`);
  };
  material.needsUpdate = true;
  return material;
}
