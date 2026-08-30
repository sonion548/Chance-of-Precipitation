import * as THREE from 'three';
import { characterSurfaces, makeCharacterMaterial } from '../world/textures.js';
import { itemIconCanvas } from '../data/itemArt.js';

/**
 * Every character, prop and weapon is assembled from primitives — no external
 * assets, so the whole game ships as source.
 */

/** Deterministic RNG so a model's detail placement is stable between builds. */
function mulberryLite(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({
  color, roughness: opts.roughness ?? 0.6, metalness: opts.metalness ?? 0.25,
  emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
  transparent: opts.transparent ?? false, opacity: opts.opacity ?? 1,
  flatShading: opts.flat ?? false,
});

const glowMat = (color, opacity = 1) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
});

/**
 * How round everything is, in one place.
 *
 * The models read as blocky for three specific reasons, and none of them is the
 * shapes being wrong: a six-segment cylinder is a hexagonal prism, an
 * `IcosahedronGeometry(r, 1)` is a golf ball with eighty flat faces, and a
 * `BoxGeometry` has an infinitely sharp edge that catches a hard specular line
 * along its whole length. Curved surfaces were being built out of a handful of
 * flats and then lit as though they were curved.
 *
 * These are the segment counts everything now goes through. They are named by
 * what the part *is* rather than by number, so "make the arms rounder" is one
 * edit here instead of forty at the call sites. The budget is deliberately
 * uneven: the torso and the head are the two surfaces a player actually looks
 * at, so they get the segments, and a knuckle stud does not.
 */
const SEG = {
  torso: 28,      // the chest: the largest single curved surface on the body
  head: 26,       // helmet — read at conversational distance in the menus
  headRing: 18,
  limb: 16,       // arms and legs
  joint: 16,      // shoulder and knee caps
  pauldron: 20,   // the shoulder domes carry the silhouette
  medium: 14,     // packs, drums, launchers
  small: 10,      // pipes, vents, nozzles
  tiny: 8,        // studs, bolts, rivets, knuckles
  ring: 20,       // torus rings
};

/**
 * A box with its edges taken off.
 *
 * The single biggest contributor to the blocky read, because there are getting
 * on for ninety boxes across the character models and every one of them was
 * catching a razor-sharp specular line down each edge. Real hardware has a
 * break on every edge — a chamfer, a radius, a fillet — and the eye reads its
 * absence as "untextured primitive" long before it reads the proportions.
 *
 * Built by extruding a rounded rectangle with a bevel, so the corners round in
 * all three axes rather than only around the extrusion. `r` is the corner
 * radius and is clamped to just under half the smallest dimension, because a
 * radius larger than that inverts the shape.
 */
/* Not everything wants this. A lit edge strip two centimetres thick has no
   visible chamfer at any distance the player will ever see it from, and giving
   it one spends about forty triangles to change nothing — so the hairline glow
   strips down Dasher's ribs and Wraith's shins stay as boxes on purpose. */
function roundedBox(w, h, d, material, r = 0.02, curveSegments = 1) {
  const rad = Math.max(0.001, Math.min(r, Math.min(w, h, d) * 0.49));
  const shape = new THREE.Shape();
  const x = w / 2 - rad;
  const y = h / 2 - rad;
  shape.moveTo(-x, -h / 2);
  shape.lineTo(x, -h / 2);
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -y);
  shape.lineTo(w / 2, y);
  shape.quadraticCurveTo(w / 2, h / 2, x, h / 2);
  shape.lineTo(-x, h / 2);
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, y);
  shape.lineTo(-w / 2, -y);
  shape.quadraticCurveTo(-w / 2, -h / 2, -x, -h / 2);

  const depth = Math.max(0.001, d - rad * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    /* One bevel segment, not a rounded fillet. A single chamfer breaks the
       specular line down an edge just as completely as a radius does at any
       distance a player sees these from, and costs about a third as much —
       which is the whole reason low-poly hardware is chamfered rather than
       filleted. */
    depth, bevelEnabled: true, bevelThickness: rad, bevelSize: rad,
    bevelOffset: 0, bevelSegments: 1, curveSegments,
  });
  // Extrude runs along +Z from z=0; centre it so it drops into the same place
  // the BoxGeometry it replaces did.
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cyl(rt, rb, h, seg, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function sphere(r, material, x = 0, y = 0, z = 0, seg = 12) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, seg * 0.7), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}


/* ==========================================================================
   MESH MERGING
   ========================================================================== */

/**
 * Collapses sibling meshes that share a material into one mesh per group.
 *
 * The detail passes pushed a chest to ~60 meshes and a husk to ~37, and with ten
 * chests and dozens of enemies on screen that is well over a thousand draw calls
 * of pure overhead. Merging only ever happens *within* a group, never across
 * one, so every Group that the animation code rotates still exists and still
 * transforms its contents — detail is free, the draw calls are not.
 *
 * Meshes referenced from any `userData` in the tree are left alone, since
 * something is animating or recolouring them individually.
 */
export function mergeStaticMeshes(root) {
  // Protect only the referenced object itself, not its subtree. A referenced
  // Group is an animation node — its children can still be merged, because the
  // group keeps transforming whatever it contains.
  const protectedSet = new Set();
  root.traverse((node) => {
    const ud = node.userData;
    if (!ud) return;
    for (const key in ud) {
      const v = ud[key];
      if (v && v.isObject3D) protectedSet.add(v);
    }
  });

  const groups = [];
  root.traverse((node) => groups.push(node));

  for (const node of groups) {
    const byMaterial = new Map();
    for (const child of node.children) {
      if (!child.isMesh || child.isInstancedMesh) continue;
      if (protectedSet.has(child)) continue;
      if (child.children.length) continue;          // something is parented to it
      const list = byMaterial.get(child.material) || [];
      list.push(child);
      byMaterial.set(child.material, list);
    }

    for (const [material, meshes] of byMaterial) {
      if (meshes.length < 2) continue;
      const merged = mergeMeshGeometries(meshes);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = meshes.some((m) => m.castShadow);
      mesh.receiveShadow = meshes.some((m) => m.receiveShadow);
      for (const m of meshes) { node.remove(m); m.geometry.dispose(); }
      node.add(mesh);
    }
  }
  return root;
}

const _mm = new THREE.Matrix4();
const _mn = new THREE.Matrix3();
const _mv = new THREE.Vector3();

/** Bakes each mesh's local transform and concatenates position/normal/uv. */
function mergeMeshGeometries(meshes) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const m of meshes) {
    const g = m.geometry;
    if (!g.attributes.position) return null;
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  if (vertexCount > 65535) return null;             // keep 16-bit indices

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = new Uint16Array(indexCount);

  let vOff = 0;
  let iOff = 0;
  for (const m of meshes) {
    const g = m.geometry;
    m.updateMatrix();
    _mm.copy(m.matrix);
    _mn.getNormalMatrix(_mm);

    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const tex = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      _mv.fromBufferAttribute(pos, i).applyMatrix4(_mm);
      position[(vOff + i) * 3] = _mv.x;
      position[(vOff + i) * 3 + 1] = _mv.y;
      position[(vOff + i) * 3 + 2] = _mv.z;
      if (nrm) {
        _mv.fromBufferAttribute(nrm, i).applyMatrix3(_mn).normalize();
        normal[(vOff + i) * 3] = _mv.x;
        normal[(vOff + i) * 3 + 1] = _mv.y;
        normal[(vOff + i) * 3 + 2] = _mv.z;
      }
      if (tex) {
        uv[(vOff + i) * 2] = tex.getX(i);
        uv[(vOff + i) * 2 + 1] = tex.getY(i);
      }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[iOff + i] = g.index.array[i] + vOff;
      iOff += g.index.count;
    } else {
      for (let i = 0; i < pos.count; i++) index[iOff + i] = i + vOff;
      iOff += pos.count;
    }
    vOff += pos.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

/* ==========================================================================
   HARD-SURFACE DETAIL HELPERS
   ========================================================================== */

/** Row of bolt heads along a line — the cheapest read of "manufactured". */
function boltRow(parent, material, { from, to, count, r = 0.012 }) {
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(r, r, r * 1.2, 6), material);
    head.position.set(
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    );
    head.rotation.x = Math.PI / 2;
    parent.add(head);
  }
}

/** Recessed panel line. Reads as a seam without needing a texture. */
function panelLine(parent, material, { pos, size, rot = [0, 0, 0] }) {
  const line = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  line.position.set(pos[0], pos[1], pos[2]);
  line.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(line);
}

/** Segmented cable following a shallow arc between two points. */
function cableRun(parent, material, a, bPt, sag = 0.08, segments = 6, r = 0.016) {
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const pt = (t) => [
      a[0] + (bPt[0] - a[0]) * t,
      a[1] + (bPt[1] - a[1]) * t - Math.sin(t * Math.PI) * sag,
      a[2] + (bPt[2] - a[2]) * t,
    ];
    const p0 = pt(t0);
    const p1 = pt(t1);
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz);
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len * 1.08, 6), material);
    seg.position.set((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2);
    seg.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(dx, dy, dz).normalize(),
    );
    parent.add(seg);
  }
}

/** Cooling fins / vent stack. */
function ventStack(parent, material, { pos, count, size, spacing, axis = 'z' }) {
  for (let i = 0; i < count; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
    const off = (i - (count - 1) / 2) * spacing;
    fin.position.set(
      pos[0] + (axis === 'x' ? off : 0),
      pos[1] + (axis === 'y' ? off : 0),
      pos[2] + (axis === 'z' ? off : 0),
    );
    parent.add(fin);
  }
}

/** Boot sole with tread blocks. */
function treadSole(parent, material, { pos, w, d, blocks = 4 }) {
  const sole = new THREE.Mesh(new THREE.BoxGeometry(w, 0.045, d), material);
  sole.position.set(pos[0], pos[1], pos[2]);
  parent.add(sole);
  for (let i = 0; i < blocks; i++) {
    const t = (i + 0.5) / blocks - 0.5;
    const block = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.03, d / blocks * 0.62), material);
    block.position.set(pos[0], pos[1] - 0.035, pos[2] + t * d);
    parent.add(block);
  }
}

/** Four-finger hand with a thumb — reads as a glove rather than a lump. */
function glove(parent, materials, scale, side) {
  const hand = new THREE.Group();
  // Fingers are capsules and the palm is a rounded slab: a finger is the one
  // part of a body nobody will accept as a rectangular prism.
  const palm = roundedBox(scale * 1.6, scale * 1.9, scale * 0.95, materials.trim, scale * 0.34);
  hand.add(palm);
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(
      new THREE.CapsuleGeometry(scale * 0.19, scale * 0.6, 3, SEG.small), materials.suit);
    f.position.set((i - 1.5) * scale * 0.38, -scale * 1.25, scale * 0.12);
    f.rotation.x = -0.5;
    f.castShadow = true;
    hand.add(f);
  }
  const thumb = new THREE.Mesh(
    new THREE.CapsuleGeometry(scale * 0.21, scale * 0.46, 3, SEG.small), materials.suit);
  thumb.position.set(side * scale * 0.85, -scale * 0.75, scale * 0.28);
  thumb.rotation.set(-0.6, 0, side * 0.7);
  thumb.castShadow = true;
  hand.add(thumb);
  const knuckle = roundedBox(scale * 1.7, scale * 0.34, scale * 0.3, materials.accent, scale * 0.12);
  knuckle.position.set(0, -scale * 0.9, scale * 0.4);
  hand.add(knuckle);
  parent.add(hand);
  return hand;
}

/* ==========================================================================
   PLAYER CHARACTERS
   ========================================================================== */

/**
 * Shared construction helpers for character bodies.
 *
 * The previous pass was raw boxes, which read as blocky because every silhouette
 * was a hard 90° corner. These use chamfered forms — cylinders with segment
 * counts, tapered limbs, and shoulder/knee joints — so the outline breaks up
 * without adding meaningful triangle cost. Limb groups still pivot at the joint
 * so the existing animation code drives them unchanged.
 */

/**
 * Tapered limb segment, capped at both ends.
 *
 * An eight-sided shaft is an octagonal prism, and at arm's length that is
 * exactly what it looked like. Sixteen reads as round. Both ends get a sphere
 * rather than only the top, because the open rim of a cylinder is a hard disc
 * edge — that rim is what made every elbow and knee look like a cut pipe, and
 * capping it costs less than the taper does.
 */
function limbSegment(len, rTop, rBot, material, joint = null) {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBot, len, SEG.limb, 1, true), material);
  shaft.position.y = -len / 2;
  shaft.castShadow = true;
  g.add(shaft);

  // The far end, closing the shaft into the next joint.
  const foot = new THREE.Mesh(new THREE.SphereGeometry(rBot * 0.99, SEG.joint, SEG.joint * 0.6), material);
  foot.scale.set(1, 0.9, 1);
  foot.position.y = -len;
  foot.castShadow = true;
  g.add(foot);

  if (joint) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(rTop * 0.99, SEG.joint, SEG.joint * 0.6), joint);
    cap.scale.set(1, 0.85, 1);
    cap.castShadow = true;
    g.add(cap);
  }
  return g;
}

/** Two-segment limb: upper pivots at the shoulder/hip, lower at the elbow/knee. */
function articulatedLimb(parent, x, y, z, spec, materials) {
  const root = new THREE.Group();
  root.position.set(x, y, z);
  const { upper, lower, rTop, rMid, rBot } = spec;

  const up = limbSegment(upper, rTop, rMid, materials.suit, materials.joint);
  root.add(up);

  const low = new THREE.Group();
  low.position.y = -upper;
  const lowSeg = limbSegment(lower, rMid * 0.98, rBot, materials.trim, materials.joint);
  low.add(lowSeg);
  root.add(low);
  root.userData.lower = low;

  if (spec.foot) {
    // Ankle group so the foot can roll through the step instead of staying rigid.
    const ankle = new THREE.Group();
    ankle.position.y = -lower;
    const foot = roundedBox(rBot * 2.3, rBot * 1.0, rBot * 3.0, materials.trim, rBot * 0.34);
    foot.position.set(0, -rBot * 0.4, rBot * 0.75);
    ankle.add(foot);
    const toe = roundedBox(rBot * 2.0, rBot * 0.8, rBot * 1.0, materials.suit, rBot * 0.3);
    toe.position.set(0, -rBot * 0.45, rBot * 2.0);
    ankle.add(toe);
    // The toe rounds off into a proper cap rather than ending on a flat wall.
    const toeCap = new THREE.Mesh(
      new THREE.SphereGeometry(rBot * 0.62, SEG.small, SEG.small * 0.7, 0, Math.PI * 2, 0, Math.PI * 0.6),
      materials.accent);
    toeCap.scale.set(1.6, 0.7, 1);
    toeCap.rotation.x = Math.PI / 2;
    toeCap.position.set(0, -rBot * 0.36, rBot * 2.35);
    toeCap.castShadow = true;
    ankle.add(toeCap);
    const heel = roundedBox(rBot * 1.9, rBot * 1.2, rBot * 0.8, materials.joint, rBot * 0.3);
    heel.position.set(0, -rBot * 0.3, -rBot * 0.6);
    ankle.add(heel);
    treadSole(ankle, materials.joint, { pos: [0, -rBot * 0.92, rBot * 0.9], w: rBot * 2.2, d: rBot * 3.6, blocks: 5 });
    // Ankle actuator.
    const strut = new THREE.Mesh(
      new THREE.CapsuleGeometry(rBot * 0.22, rBot * 1.2, 3, SEG.small), materials.accent);
    strut.position.set(0, rBot * 0.35, -rBot * 0.5);
    strut.rotation.x = 0.4;
    ankle.add(strut);
    low.add(ankle);
    root.userData.ankle = ankle;
  }
  /* Armour plate over the joint (knee or elbow). Kept shallow and only slightly
     wider than the limb — a full hemisphere at this radius reads as a balloon.

     Which side it goes on is not cosmetic. A knee points forward and an elbow
     points backward, so a pad hard-coded to +Z is correct on a leg and on the
     inside of the elbow crease on an arm. `spec.foot` is only ever set on legs,
     which is what tells the two apart. */
  const jointSide = spec.foot ? 1 : -1;
  if (spec.pad) {
    const pad = new THREE.Mesh(
      new THREE.SphereGeometry(rMid * 1.08, SEG.pauldron, SEG.joint * 0.6, 0, Math.PI * 2, 0, Math.PI * 0.5),
      materials.trim);
    pad.scale.set(1, 0.5, 1);
    pad.position.set(0, -rMid * 0.15, jointSide * rMid * 0.5);
    pad.rotation.x = jointSide * Math.PI / 2.1;
    pad.castShadow = true;
    low.add(pad);
    const ridge = roundedBox(rMid * 0.32, rMid * 0.9, rMid * 0.22, materials.accent, rMid * 0.08);
    ridge.position.set(0, -rMid * 0.35, jointSide * rMid * 0.92);
    low.add(ridge);
  }
  if (spec.hand) {
    const hand = glove(low, materials, rBot * 0.9, spec.side ?? 1);
    hand.position.y = -lower - rBot * 0.5;
    root.userData.hand = hand;
    root.userData.handRest = hand.position.clone();
  }
  parent.add(root);
  return root;
}

/** Layered chest: core torso, chest plate, collar and back pack. */
/**
 * The body under the character's own hardware.
 *
 * `kit` is how much of the soldier's kit it is wearing, because not every
 * silhouette in the descent is a soldier. A wanderer in a straw hat wearing a
 * rebreather, a hard harness and two belt pouches under his robe is a wanderer
 * nobody built on purpose — and every one of those parts is hidden by the robe
 * anyway, so it is triangles spent on making the shape worse.
 *
 *   'armoured'  the full kit: pack, harness, pouches, exhaust stacks, cable
 *   'light'     a frame: core, plates, collar, belt, chest light, abdomen
 *   'cloth'     core, collar and belt, and nothing else — something covers it
 */
/**
 * The torso profile, as radius-at-height fractions.
 *
 * A cylinder was the whole problem. The chest and the waist of any figure are
 * nothing like the same width, and a body that is one radius from hip to
 * shoulder reads as a barrel with arms on it no matter how many segments it
 * has. This is the outline of a torso: hips, a pinch at the waist, the ribcage
 * opening out, the widest point up at the chest, then a fast run-in to the
 * neck. It is lathed, so the surface is genuinely continuous rather than three
 * cylinders stacked with visible seams between them.
 *
 * [heightFraction, radiusFraction] — height of `height`, radius of `width`.
 */
const TORSO_PROFILE = [
  [0.00, 0.005], [0.02, 0.36], [0.10, 0.395], [0.20, 0.375],
  [0.30, 0.345], [0.40, 0.355], [0.52, 0.395], [0.66, 0.445],
  [0.80, 0.485], [0.90, 0.475], [0.96, 0.40], [1.00, 0.235],
];

/** Radius of the torso at a height fraction, so plates can sit *on* it. */
function torsoRadiusAt(t) {
  const P = TORSO_PROFILE;
  if (t <= P[0][0]) return P[0][1];
  for (let i = 1; i < P.length; i++) {
    if (t <= P[i][0]) {
      const k = (t - P[i - 1][0]) / (P[i][0] - P[i - 1][0]);
      return P[i - 1][1] + (P[i][1] - P[i - 1][1]) * k;
    }
  }
  return P[P.length - 1][1];
}

/** A band of the torso surface, slightly proud of it — armour, belts, plates. */
function torsoBand(width, depth, height, from, to, out, material, steps = 5) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = from + (to - from) * (i / steps);
    pts.push(new THREE.Vector2(Math.max(0.001, torsoRadiusAt(t) * width * out), t * height));
  }
  const band = new THREE.Mesh(new THREE.LatheGeometry(pts, SEG.torso), material);
  band.scale.z = depth / width;
  band.castShadow = true;
  return band;
}

function buildTorso(group, materials, spec) {
  const { width, depth, height, accentColor } = spec;
  const kit = spec.kit || 'armoured';

  const core = new THREE.Mesh(
    new THREE.LatheGeometry(
      TORSO_PROFILE.map(([t, r]) => new THREE.Vector2(Math.max(0.001, r * width), t * height)),
      SEG.torso,
    ),
    materials.suit,
  );
  core.scale.z = depth / width;
  core.castShadow = true;
  group.add(core);

  // Chest plate: a band lying on the ribcage rather than a wider cylinder
  // swallowing it, so the chest keeps its shape under the armour.
  const plate = torsoBand(width, depth, height, 0.54, 0.93, 1.05, materials.trim, 6);
  group.add(plate);

  // Collar ring reads as a neck seal and breaks the shoulder line.
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(torsoRadiusAt(0.97) * width, width * 0.05, 10, SEG.ring), materials.trim);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = height * 0.965;
  collar.scale.z = depth / width;
  group.add(collar);

  const belt = torsoBand(width, depth, height, 0.06, 0.19, 1.06, materials.trim, 3);
  group.add(belt);

  // Whatever is going over the top of this owns the read from here on.
  if (kit === 'cloth') return core;

  const chestLight = new THREE.Mesh(new THREE.CircleGeometry(width * 0.1, SEG.ring), materials.glow);
  chestLight.position.set(0, height * 0.74, torsoRadiusAt(0.74) * depth * 1.14);
  group.add(chestLight);

  // Segmented abdominal plates — narrow bands following the waist pinch.
  for (let i = 0; i < 3; i++) {
    const t0 = 0.22 + i * 0.1;
    group.add(torsoBand(width, depth, height, t0, t0 + 0.07, 1.035, materials.trim, 2));
  }

  // A light frame stops here: no pack, no harness, no pouches. What hangs off
  // one of these is the character's own hardware, and it goes on next.
  if (kit === 'light') return core;

  const pack = roundedBox(width * 0.72, height * 0.5, depth * 0.42, materials.trim, width * 0.08);
  pack.position.set(0, height * 0.6, -depth * 0.6);
  group.add(pack);
  boltRow(group, materials.joint, {
    from: [-width * 0.3, height * 0.78, -depth * 0.79],
    to: [width * 0.3, height * 0.78, -depth * 0.79], count: 5, r: 0.018,
  });
  for (const sx of [-1, 1]) {
    const vent = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.09, width * 0.09, height * 0.2, SEG.small), materials.accent);
    vent.position.set(sx * width * 0.26, height * 0.72, -depth * 0.72);
    group.add(vent);
    // Exhaust stack behind the shoulder.
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.055, width * 0.07, height * 0.42, SEG.small), materials.joint);
    stack.position.set(sx * width * 0.4, height * 0.82, -depth * 0.66);
    stack.rotation.x = -0.14;
    stack.castShadow = true;
    group.add(stack);
  }

  // Harness: two straps over the chest plate meeting at a buckle.
  for (const sx of [-1, 1]) {
    const strap = roundedBox(width * 0.13, height * 0.7, depth * 0.1, materials.joint, width * 0.035);
    strap.position.set(sx * width * 0.19, height * 0.55, depth * 0.5);
    strap.rotation.z = sx * 0.18;
    group.add(strap);
  }
  const buckle = roundedBox(width * 0.22, height * 0.16, depth * 0.14, materials.accent, width * 0.05);
  buckle.position.set(0, height * 0.32, depth * 0.53);
  group.add(buckle);

  // Belt pouches and a shoulder pauldron rivet line.
  for (const sx of [-1, 1]) {
    const pouch = roundedBox(width * 0.24, height * 0.24, depth * 0.24, materials.joint, width * 0.06);
    pouch.position.set(sx * width * 0.44, height * 0.1, depth * 0.28);
    group.add(pouch);
    const flap = roundedBox(width * 0.26, height * 0.07, depth * 0.26, materials.trim, width * 0.025);
    flap.position.set(sx * width * 0.44, height * 0.22, depth * 0.28);
    group.add(flap);
  }

  // Cable from the pack around to the chest light.
  cableRun(group, materials.joint,
    [width * 0.28, height * 0.7, -depth * 0.5], [width * 0.16, height * 0.74, depth * 0.44], 0.1, 6, width * 0.035);
  return core;
}

/**
 * The head, in as much gear as the character actually wears.
 *
 * `kit` again, and for the same reason as the torso: the comms boom, the jaw
 * filters and the antenna are a trooper's helmet, and three of the seven
 * characters are not troopers. A smooth frame reads by its silhouette, and
 * hanging a microphone off it is how you lose the silhouette.
 *
 *   'trooper'  the issued helmet: crest, boom, mic, filters, vents, antenna
 *   'smooth'   a shell and a visor, nothing protruding
 *   'plain'    the shell alone — a hood or a hat is going over it
 */
function buildHead(parent, materials, spec) {
  const head = new THREE.Group();
  head.position.y = spec.y;
  const kit = spec.kit || 'trooper';

  /* Was `IcosahedronGeometry(r, 1)` — eighty flat faces, and the single most
     obviously faceted surface on the whole character, sitting at eye level. */
  const skull = new THREE.Mesh(
    new THREE.SphereGeometry(spec.r, SEG.head, SEG.head * 0.7), materials.suit);
  skull.scale.set(1, 1.06, 0.96);
  skull.castShadow = true;
  head.add(skull);

  if (kit === 'plain') {
    parent.add(head);
    return head;
  }

  if (kit === 'smooth') {
    /* One unbroken shell over the skull and a visor let into it. Slightly
       larger than the skull so the face is a surface rather than a facet — at
       range this is the whole difference between a helmet and a lump. */
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(spec.r * 1.04, SEG.head, SEG.head * 0.7), materials.trim);
    shell.scale.set(1, 1.1, 1.02);
    shell.castShadow = true;
    head.add(shell);
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(spec.r * 0.86, spec.r * 0.15, 10, SEG.ring, Math.PI * 0.8), materials.visor);
    band.rotation.set(Math.PI / 2, 0, Math.PI * 0.6);
    band.position.set(0, spec.r * 0.06, spec.r * 0.12);
    head.add(band);
    // A raised keel down the crown: the shape that says "fast" from behind.
    const keel = roundedBox(spec.r * 0.14, spec.r * 0.3, spec.r * 1.7, materials.trim, spec.r * 0.06);
    keel.position.set(0, spec.r * 0.9, -spec.r * 0.12);
    keel.rotation.x = 0.12;
    head.add(keel);
    parent.add(head);
    return head;
  }

  const crest = new THREE.Mesh(
    new THREE.CylinderGeometry(spec.r * 0.92, spec.r * 0.86, spec.r * 0.5, SEG.headRing), materials.trim);
  crest.position.y = spec.r * 0.62;
  crest.castShadow = true;
  head.add(crest);

  // Comms boom and mic.
  const boom = new THREE.Mesh(
    new THREE.CapsuleGeometry(spec.r * 0.05, spec.r * 0.8, 2, SEG.tiny), materials.joint);
  boom.position.set(spec.r * 0.55, -spec.r * 0.08, spec.r * 0.32);
  boom.rotation.set(0.5, 0, 0.9);
  head.add(boom);
  const mic = new THREE.Mesh(new THREE.SphereGeometry(spec.r * 0.11, SEG.small, SEG.tiny), materials.accent);
  mic.position.set(spec.r * 0.2, -spec.r * 0.3, spec.r * 0.6);
  head.add(mic);

  // Filter canisters at the jaw.
  for (const sx of [-1, 1]) {
    const filter = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.r * 0.19, spec.r * 0.19, spec.r * 0.3, SEG.small), materials.joint);
    filter.position.set(sx * spec.r * 0.62, -spec.r * 0.2, spec.r * 0.3);
    filter.rotation.z = Math.PI / 2;
    head.add(filter);
  }

  // Vent slots along the crown, and a stubby antenna.
  ventStack(head, materials.joint, {
    pos: [0, spec.r * 0.86, 0], count: 3, size: [spec.r * 1.0, spec.r * 0.07, spec.r * 0.16], spacing: spec.r * 0.24,
  });
  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(spec.r * 0.035, spec.r * 0.05, spec.r * 1.1, SEG.tiny), materials.joint);
  antenna.position.set(-spec.r * 0.6, spec.r * 0.75, -spec.r * 0.25);
  antenna.rotation.z = 0.24;
  head.add(antenna);
  // Tip light on the antenna.
  //
  // This was written as `head.add(mesh).position.set(...)`. Object3D.add returns
  // the PARENT, so that line moved the entire head down to the antenna tip's
  // coordinates — inside the torso — and the character rendered headless.
  const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(spec.r * 0.06, SEG.tiny, SEG.tiny), materials.glow);
  antennaTip.position.set(-spec.r * 0.73, spec.r * 1.28, -spec.r * 0.25);
  head.add(antennaTip);

  // Brow ridge above the visor.
  const brow = roundedBox(spec.r * 1.5, spec.r * 0.16, spec.r * 0.4, materials.trim, spec.r * 0.06);
  brow.position.set(0, spec.r * 0.34, spec.r * 0.5);
  head.add(brow);

  // Visor is a torus arc, so it wraps the face instead of sitting on it flat.
  const visor = new THREE.Mesh(
    new THREE.TorusGeometry(spec.r * 0.72, spec.r * 0.2, 12, SEG.ring, Math.PI * 0.95), materials.visor);
  visor.rotation.set(Math.PI / 2, 0, Math.PI * 0.52);
  visor.position.set(0, spec.r * 0.05, spec.r * 0.2);
  head.add(visor);

  parent.add(head);
  return head;
}

/**
 * The materials one character is made of.
 *
 * Every one of these used to be a bare colour at a uniform roughness, which is
 * the whole reason the bodies read as moulded plastic — a flat surface tells
 * you nothing about what it is made of, so a steel pauldron, a rubber joint and
 * a linen sleeve all came back as "smooth thing, tinted". They now carry
 * procedural detail maps (see `characterSurfaces` in world/textures.js): seams
 * and bolts on plate, a fibre grid on cloth, concertina ribs on a joint, and a
 * roughness map under each so the three of them catch light differently. The
 * maps are neutral, so the character's own palette still supplies every colour.
 *
 * `heavy` picks the coarser, more damaged plate for the industrial frames over
 * the tighter panelling the precision ones wear.
 */
const characterMaterials = (char, heavy = false) => {
  const S = characterSurfaces();
  const shell = heavy ? S.plate : S.tech;
  return {
    suit: makeCharacterMaterial(shell, {
      color: char.color, roughness: 0.62, metalness: 0.42, scale: heavy ? 4.4 : 5.6,
    }),
    trim: makeCharacterMaterial(shell, {
      color: new THREE.Color(char.color).offsetHSL(0, -0.04, 0.13).getHex(),
      roughness: 0.46, metalness: 0.62, scale: heavy ? 5.0 : 6.2,
    }),
    joint: makeCharacterMaterial(S.joint, {
      color: 0x2a3040, roughness: 0.86, metalness: 0.22, scale: 7.0,
    }),
    accent: makeCharacterMaterial(shell, {
      color: char.accent, emissive: char.accent, emissiveIntensity: 0.85,
      roughness: 0.5, metalness: 0.35, scale: 5.4,
    }),
    // The lit parts stay untextured on purpose: a detail map on an emissive
    // strip reads as dirt on a light, which is the one place grime is wrong.
    glow: new THREE.MeshStandardMaterial({
      color: char.accent, emissive: char.accent, emissiveIntensity: 2.2, roughness: 0.3, metalness: 0.4,
    }),
    visor: new THREE.MeshStandardMaterial({
      color: char.visor, emissive: char.visor, emissiveIntensity: 2.4, roughness: 0.18, metalness: 0.7,
    }),
    // Handed to the per-build hardware so a robe, a rope belt or a straw hat
    // can be made of the right thing rather than of tinted plastic.
    surfaces: S,
  };
};

export function buildPlayerModel(char) {
  const g = new THREE.Group();
  const build = char.build || 'vanguard';
  // The three heavy frames wear the coarse, damaged plate; the rest wear the
  // finer panelling. It is the same difference the concept sheets draw between
  // industrial equipment and a precision airframe.
  const m = characterMaterials(char, build === 'unloader' || build === 'bulwark' || build === 'vanguard');

  /* Proportions per build — the silhouette is what tells them apart at range.
   *
   * These are figure-drawing proportions, and getting them wrong is what made
   * the first two passes read as toys no matter how round the surfaces were.
   * The measure that matters is *heads tall*: the old bodies were 4.7 heads,
   * which is the proportion of a bobblehead, and the concept sheets are about
   * 7.5. Every one of these is now laid out on a ~7-head figure with the legs
   * at just over half the total height, because a head you can shrink and legs
   * you can lengthen fix more than any amount of geometry ever will.
   *
   * `w` drives the chest, `d` the depth through it — bodies are much wider than
   * they are deep, and a torso lathed on a circle is a barrel. `legLen` and
   * `armLen` are [upper, lower]; the legs must sum to `hipY` or the feet do not
   * reach the floor.
   *
   * `torsoKit` and `headKit` decide how much issued gear the body underneath is
   * wearing; see `buildTorso` and `buildHead`.
   */
  const P = {
    vanguard: {
      w: 0.50, d: 0.29, torso: 0.60, hipY: 1.04, headR: 0.136, neck: 0.062,
      armR: [0.079, 0.067, 0.057], legR: [0.107, 0.089, 0.073],
      legLen: [0.53, 0.51], armLen: [0.35, 0.33], shoulder: 0.255,
    },
    // Freight equipment with somebody inside it: the widest thing in the
    // descent, and the only one whose head is small even for seven heads —
    // a big suit reads as big precisely because the head does not grow with it.
    unloader: {
      w: 0.76, d: 0.45, torso: 0.62, hipY: 0.99, headR: 0.142, neck: 0.075,
      armR: [0.135, 0.112, 0.096], legR: [0.158, 0.132, 0.108],
      legLen: [0.51, 0.48], armLen: [0.35, 0.33], shoulder: 0.36,
      torsoKit: 'armoured', headKit: 'trooper',
    },
    wraith: {
      w: 0.41, d: 0.245, torso: 0.59, hipY: 1.12, headR: 0.123, neck: 0.05,
      armR: [0.058, 0.049, 0.042], legR: [0.082, 0.069, 0.057],
      legLen: [0.57, 0.55], armLen: [0.36, 0.35], shoulder: 0.205,
      torsoKit: 'light', headKit: 'plain',
    },
    bulwark: {
      w: 0.70, d: 0.42, torso: 0.58, hipY: 0.97, headR: 0.142, neck: 0.072,
      armR: [0.117, 0.098, 0.084], legR: [0.144, 0.12, 0.099],
      legLen: [0.50, 0.47], armLen: [0.34, 0.32], shoulder: 0.335,
      torsoKit: 'armoured', headKit: 'trooper',
    },
    halcyon: {
      w: 0.425, d: 0.25, torso: 0.59, hipY: 1.10, headR: 0.126, neck: 0.051,
      armR: [0.063, 0.053, 0.045], legR: [0.088, 0.073, 0.061],
      legLen: [0.56, 0.54], armLen: [0.355, 0.34], shoulder: 0.212,
      torsoKit: 'light', headKit: 'smooth',
    },
    dasher: {
      w: 0.435, d: 0.255, torso: 0.60, hipY: 1.11, headR: 0.124, neck: 0.052,
      armR: [0.065, 0.055, 0.046], legR: [0.091, 0.076, 0.063],
      legLen: [0.565, 0.545], armLen: [0.355, 0.34], shoulder: 0.216,
      torsoKit: 'light', headKit: 'smooth',
    },
    chain: {
      w: 0.47, d: 0.28, torso: 0.60, hipY: 1.05, headR: 0.132, neck: 0.058,
      armR: [0.070, 0.059, 0.050], legR: [0.098, 0.082, 0.068],
      legLen: [0.535, 0.515], armLen: [0.35, 0.335], shoulder: 0.235,
      torsoKit: 'cloth', headKit: 'plain',
    },
  }[build] || {
    w: 0.50, d: 0.29, torso: 0.60, hipY: 1.04, headR: 0.136, neck: 0.062,
    armR: [0.079, 0.067, 0.057], legR: [0.107, 0.089, 0.073],
    legLen: [0.53, 0.51], armLen: [0.35, 0.33], shoulder: 0.255,
  };

  // --- legs (parented to a pelvis so the hips can counter-rotate) ---
  const pelvis = new THREE.Group();
  pelvis.position.y = P.hipY;
  g.add(pelvis);
  const hipPlate = new THREE.Mesh(
    new THREE.CylinderGeometry(P.w * 0.42, P.w * 0.36, 0.24, SEG.torso), m.trim);
  hipPlate.scale.z = 0.8;
  hipPlate.castShadow = true;
  pelvis.add(hipPlate);
  const legSpec = {
    upper: P.legLen[0], lower: P.legLen[1],
    rTop: P.legR[0], rMid: P.legR[1], rBot: P.legR[2], foot: true, pad: true,
  };
  // Hips set wide enough that the feet do not collide at mid-stride. At the old
  // 0.24 the two boots were 7cm apart on a body 62cm across, so every walk cycle
  // looked like the knees were being pressed together.
  const legL = articulatedLimb(pelvis, -P.w * 0.32, 0, 0, { ...legSpec, side: -1 }, m);
  const legR = articulatedLimb(pelvis, P.w * 0.32, 0, 0, { ...legSpec, side: 1 }, m);
  /* A few degrees of splay, so the legs form an A rather than two parallel
     posts. Real legs converge from hip to knee; a chunky low-poly one reads
     better doing the opposite, because the silhouette is the whole character.

     The sign matters and used to be backwards. A positive Z rotation swings a
     limb's downward axis toward +X, so the left leg — the one at negative X —
     needs a *negative* angle to lean away from the body. Positive on both made
     a V instead of an A: knees drawn together, feet inboard of the hips, which
     is most of what read as a goofy walk.

     `outZ` is which way is outboard for each leg, so nothing downstream has to
     re-derive it from the sign of a magnitude. */
  legL.rotation.z = -0.06;
  legR.rotation.z = 0.06;
  legL.userData.restZ = -0.06;
  legR.userData.restZ = 0.06;
  legL.userData.outZ = -1;
  legR.userData.outZ = 1;

  // --- torso ---
  const torso = new THREE.Group();
  torso.position.y = P.hipY;
  g.add(torso);
  buildTorso(torso, m, {
    width: P.w, depth: P.d, height: P.torso, accentColor: char.accent, kit: P.torsoKit,
  });

  /* A neck. There was not one — the head sat straight on the collar, which is
     the other half of why these read as dolls: a figure with no neck has no
     place for the head to be *attached*, so it looks placed on top instead. */
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(P.neck * 0.92, P.neck * 1.15, P.torso * 0.16, SEG.limb),
    m.joint,
  );
  neck.position.y = P.torso * 1.02;
  neck.castShadow = true;
  torso.add(neck);

  const head = buildHead(torso, m, { y: P.torso * 1.30, r: P.headR, kit: P.headKit });

  // --- arms ---
  const armSpec = {
    upper: P.armLen[0], lower: P.armLen[1],
    rTop: P.armR[0], rMid: P.armR[1], rBot: P.armR[2], hand: true, pad: true,
  };
  const armL = articulatedLimb(torso, -P.shoulder, P.torso * 0.82, 0, { ...armSpec, side: -1 }, m);
  const armR = articulatedLimb(torso, P.shoulder, P.torso * 0.82, 0, { ...armSpec, side: 1 }, m);
  armR.rotation.x = -1.15;
  armL.rotation.x = -0.85;
  // Negative bends the forearm forward, which is the direction an elbow goes.
  // These were positive, which folded both arms backwards at the elbow.
  armR.userData.lower.rotation.x = -0.45;
  armL.userData.lower.rotation.x = -0.6;

  /* Pauldrons: the single biggest readability win at distance.
     Chain gets none — the shoulder under his robe is a shoulder, and a dome of
     plate on it is the one thing that would stop the silhouette reading as
     cloth. Everything else keeps the dome and puts its own shape over it. */
  if (build !== 'chain') {
    for (const [side, arm] of [[-1, armL], [1, armR]]) {
      const pauldron = new THREE.Mesh(
        new THREE.SphereGeometry(P.armR[0] * 1.32, SEG.pauldron, SEG.joint * 0.7, 0, Math.PI * 2, 0, Math.PI * 0.55),
        m.trim,
      );
      pauldron.position.set(side * P.shoulder * 1.04, P.torso * 0.8, 0);
      pauldron.rotation.z = side * 0.24;
      pauldron.castShadow = true;
      torso.add(pauldron);
      void arm;
    }
  }

  /* Anything a build wants the game to be able to reach later is declared out
     here, because `g.userData` is replaced wholesale further down and a handle
     stashed on it from inside the switch does not survive. */
  let hatNode = null;

  // --- per-build signature hardware ---
  switch (build) {
    case 'unloader': {
      /* Freight equipment with somebody inside it.
       *
       * The read is safety yellow on dark steel, and it is a *panelled* read —
       * big flat plates bolted onto a dark frame, not a yellow suit. So the
       * frame stays the base colour and the accent goes on in slabs: the
       * shoulders, the chest, the knees, the shins. At range you see four
       * yellow blocks arranged in the shape of a very large person.
       */
      const panel = m.accent;

      // --- shoulders: the biggest slabs on the model ---
      for (const sx of [-1, 1]) {
        const cap = new THREE.Mesh(
          new THREE.SphereGeometry(P.armR[0] * 1.9, SEG.pauldron, SEG.pauldron * 0.7, 0, Math.PI * 2, 0, Math.PI * 0.52), panel);
        cap.scale.set(1.05, 0.9, 1.05);
        cap.position.set(sx * P.shoulder * 1.04, P.torso * 0.79, 0);
        cap.rotation.z = sx * 0.3;
        cap.castShadow = true;
        torso.add(cap);
        // Lip around the bottom of the cap, so it reads as a plate with an
        // edge rather than a painted-on hemisphere.
        const lip = new THREE.Mesh(new THREE.TorusGeometry(P.armR[0] * 1.86, 0.026, 10, SEG.ring), m.joint);
        lip.rotation.x = Math.PI / 2;
        lip.position.set(sx * P.shoulder * 1.04, P.torso * 0.73, 0);
        torso.add(lip);
        boltRow(torso, m.joint, {
          from: [sx * (P.shoulder * 1.04 - 0.11), P.torso * 0.92, 0.1],
          to: [sx * (P.shoulder * 1.04 + 0.11), P.torso * 0.92, 0.1], count: 3, r: 0.017,
        });
      }

      // --- chest and belly plates ---
      const bib = roundedBox(P.w * 0.62, P.torso * 0.34, 0.09, panel, 0.035);
      bib.position.set(0, P.torso * 0.72, P.d * 0.58);
      torso.add(bib);
      const bibLip = roundedBox(P.w * 0.66, 0.045, 0.11, m.joint, 0.018);
      bibLip.position.set(0, P.torso * 0.55, P.d * 0.58);
      torso.add(bibLip);
      // Hazard chevrons across the belly: the one piece of livery on the model.
      for (let i = 0; i < 3; i++) {
        const chev = new THREE.Mesh(new THREE.BoxGeometry(P.w * 0.13, 0.05, 0.05), panel);
        chev.position.set((i - 1) * P.w * 0.17, P.torso * 0.2, P.d * 0.56);
        chev.rotation.z = 0.6;
        torso.add(chev);
      }

      // Exo-frame ribs across the chest, in bare metal under the plate.
      for (let i = 0; i < 3; i++) {
        const rib = new THREE.Mesh(new THREE.TorusGeometry(P.w * 0.46, 0.03, 10, SEG.ring, Math.PI), m.joint);
        rib.rotation.set(Math.PI / 2, 0, 0);
        rib.position.y = P.torso * (0.36 + i * 0.15);
        torso.add(rib);
      }

      // --- legs: knee caps and shin plates ---
      for (const leg of [legL, legR]) {
        const knee = new THREE.Mesh(
          new THREE.SphereGeometry(P.legR[1] * 1.5, SEG.small, SEG.small * 0.7, 0, Math.PI * 2, 0, Math.PI * 0.55), panel);
        knee.rotation.x = 1.4;
        knee.position.set(0, 0.01, P.legR[1] * 0.5);
        knee.castShadow = true;
        leg.userData.lower.add(knee);
        const shin = roundedBox(P.legR[2] * 2.1, 0.3, 0.07, panel, 0.028);
        shin.position.set(0, -0.2, P.legR[2] * 1.5);
        leg.userData.lower.add(shin);
      }

      // --- the fist: the arm the character is named for ---
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(P.armR[2] * 2.0, P.armR[2] * 2.5, 0.28, SEG.medium), panel);
      sleeve.position.y = -0.2;
      sleeve.castShadow = true;
      armR.userData.lower.add(sleeve);

      const fist = new THREE.Mesh(new THREE.IcosahedronGeometry(P.armR[2] * 2.7, 1), m.trim);
      fist.scale.set(1, 0.92, 1.05);
      fist.position.y = -0.46;
      fist.castShadow = true;
      armR.userData.lower.add(fist);

      for (let k = 0; k < 3; k++) {
        const knuckle = new THREE.Mesh(new THREE.SphereGeometry(P.armR[2] * 0.78, SEG.small, SEG.small * 0.7), m.glow);
        knuckle.position.set((k - 1) * P.armR[2] * 1.3, -0.52, P.armR[2] * 2.2);
        armR.userData.lower.add(knuckle);
      }
      // Two hydraulic rams down the back of the forearm, feeding the fist.
      for (const sx of [-1, 1]) {
        const ram = new THREE.Mesh(new THREE.CylinderGeometry(P.armR[2] * 0.42, P.armR[2] * 0.42, 0.32, SEG.small), m.glow);
        ram.position.set(sx * P.armR[2] * 0.9, -0.24, -P.armR[2] * 1.8);
        armR.userData.lower.add(ram);
      }

      /* --- the grapple: a launcher, a chain, and a hook that hangs off it ---
       *
       * The chain is the whole reason this arm reads as a cargo grapple rather
       * than a second gun. It is built hanging slack from the muzzle with the
       * hook swinging at the bottom, because a hook stowed flush against the
       * launcher is a detail nobody sees and a hook on a metre of chain is a
       * silhouette you recognise across the arena. */
      const launcher = roundedBox(P.armR[2] * 2.7, P.armR[2] * 2.4, 0.46, m.trim, 0.035);
      launcher.position.set(0, -0.28, 0.14);
      armL.userData.lower.add(launcher);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(P.armR[2] * 1.15, P.armR[2] * 1.15, P.armR[2] * 2.4, SEG.medium), panel);
      drum.rotation.z = Math.PI / 2;
      drum.position.set(0, -0.28, -0.06);
      drum.castShadow = true;
      armL.userData.lower.add(drum);
      const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(P.armR[2] * 0.8, P.armR[2] * 0.95, 0.2, SEG.medium), m.joint);
      muzzle.rotation.x = Math.PI / 2;
      muzzle.position.set(0, -0.28, 0.42);
      armL.userData.lower.add(muzzle);

      const chain = new THREE.Group();
      chain.position.set(0, -P.armLen[1] * 0.95, P.armR[2] * 4.3);
      armL.userData.lower.add(chain);
      for (let i = 0; i < 7; i++) {
        const link = new THREE.Mesh(
          new THREE.TorusGeometry(P.armR[2] * 0.42, P.armR[2] * 0.14, 8, SEG.medium), m.joint);
        // Alternating link planes, which is what makes a run of toruses read
        // as chain rather than as a stack of washers.
        link.rotation.y = (i % 2) * Math.PI / 2;
        link.position.set(0, -i * P.armR[2] * 0.68, Math.sin(i * 0.5) * P.armR[2] * 0.2);
        chain.add(link);
      }
      const hookShank = new THREE.Mesh(
        new THREE.CylinderGeometry(P.armR[2] * 0.22, P.armR[2] * 0.22, P.armR[2] * 1.2, SEG.small), panel);
      hookShank.position.y = -P.armR[2] * 5.3;
      chain.add(hookShank);
      const hookCurve = new THREE.Mesh(
        new THREE.TorusGeometry(P.armR[2] * 0.75, P.armR[2] * 0.24, 8, SEG.medium, Math.PI * 1.35), panel);
      hookCurve.rotation.set(0, Math.PI / 2, 0.5);
      hookCurve.position.y = -P.armR[2] * 6.4;
      hookCurve.castShadow = true;
      chain.add(hookCurve);
      const hookTip = new THREE.Mesh(
        new THREE.ConeGeometry(P.armR[2] * 0.26, P.armR[2] * 0.9, SEG.small), m.glow);
      hookTip.position.set(0, -P.armR[2] * 6.0, P.armR[2] * 0.75);
      hookTip.rotation.x = -0.9;
      chain.add(hookTip);
      break;
    }
    case 'wraith': {
      /* A hood, a rag of a cloak, and a light source where the face should be.
       *
       * Almost nothing on this frame is armour — the concept is a thin body
       * inside a lot of moving cloth, so the budget goes on the cloth. The
       * mantle is built as seven ragged strips of different length rather than
       * one cone, because a cone is a cape and strips are a thing coming apart.
       */
      /* Double-sided: the hood is an open shell and the mantle is rags, and
         both are seen from inside as often as out. */
      const shroud = makeCharacterMaterial(m.surfaces.cloth, {
        color: 0x14111c, roughness: 0.96, metalness: 0.04, scale: 3.4, side: THREE.DoubleSide,
      });

      /* --- the hood ---
       * Lathed rather than a hemisphere, because a hemisphere over a head is a
       * helmet: what makes cloth read as a *hood* is that it does not follow
       * the skull. This profile sits close at the crown, swings out, and opens
       * into a wide mouth at the front with the face set back inside it. Only
       * slightly larger than the head, too — the first pass had it at 1.8× and
       * it read as a black mushroom. */
      const hoodProfile = [
        [P.headR * 0.10, P.headR * 1.45],
        [P.headR * 0.55, P.headR * 1.36],
        [P.headR * 0.95, P.headR * 1.05],
        [P.headR * 1.22, P.headR * 0.55],
        [P.headR * 1.34, P.headR * 0.02],
        [P.headR * 1.38, -P.headR * 0.5],
        [P.headR * 1.30, -P.headR * 0.95],   // the mouth of the hood
        [P.headR * 1.16, -P.headR * 1.02],
        [P.headR * 1.05, -P.headR * 0.5],
        [P.headR * 0.98, P.headR * 0.4],
      ].map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y));
      /* Open at the front. A closed lathe is a radially symmetric shell — it
         has no face hole at all, and the first pass sealed him in — so the
         sweep stops short of a wedge centred on +Z, which is where the face is.
         LatheGeometry places a profile point at (x·sin φ, y, x·cos φ), so φ=0
         is dead ahead and the gap is centred by starting half of it round. */
      const HOOD_GAP = 1.45;
      const cowl = new THREE.Mesh(
        new THREE.LatheGeometry(hoodProfile, SEG.headRing, HOOD_GAP / 2, Math.PI * 2 - HOOD_GAP),
        shroud,
      );
      cowl.scale.z = 1.16;
      cowl.rotation.x = -0.08;
      cowl.castShadow = true;
      head.add(cowl);
      /* The peak, swept back off the crown. It is what tells you the hood is
         drawn *up* rather than lying on the shoulders, and it is the whole of
         Wraith's read from behind. */
      const peak = new THREE.Mesh(
        new THREE.ConeGeometry(P.headR * 0.62, P.headR * 2.0, SEG.medium), shroud);
      peak.position.set(0, P.headR * 1.1, -P.headR * 0.66);
      peak.rotation.x = -1.05;
      peak.castShadow = true;
      head.add(peak);
      // The single eye under it. Everything else on the head is unlit.
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(P.headR * 0.26, SEG.small, SEG.small * 0.7), m.visor);
      eye.scale.set(1.5, 0.7, 0.6);
      eye.position.set(0, -P.headR * 0.16, P.headR * 0.84);
      head.add(eye);
      const eyeGlow = new THREE.Mesh(
        new THREE.SphereGeometry(P.headR * 0.5, SEG.small, SEG.small * 0.7),
        new THREE.MeshBasicMaterial({
          color: char.visor, transparent: true, opacity: 0.28,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      eyeGlow.position.set(0, -P.headR * 0.16, P.headR * 0.78);
      head.add(eyeGlow);

      /* --- the mantle: strips, not a cape ---
         Eleven narrow ones rather than seven wide, and quoted off the torso, so
         it reads as something coming apart at the hem instead of a row of
         planks bolted to his back. */
      for (let i = 0; i < 11; i++) {
        const t = (i / 10) - 0.5;                         // −0.5 … +0.5 across the back
        const len = P.torso * (2.15 - Math.abs(t) * 1.0); // longest down the middle
        const strip = roundedBox(P.w * 0.19, len, P.w * 0.035, shroud, P.w * 0.012);
        strip.position.set(
          t * P.w * 1.5,
          P.torso * 0.52 - len * 0.44,
          -P.d * (0.55 + Math.abs(t) * 0.5),
        );
        strip.rotation.set(0.1 + Math.abs(t) * 0.08, t * 0.75, t * 0.3);
        strip.castShadow = true;
        torso.add(strip);
      }
      // Shoulder shrouds over the top of them.
      for (const sx of [-1, 1]) {
        const drape = new THREE.Mesh(
          new THREE.ConeGeometry(P.armR[0] * 3.0, P.torso * 0.62, SEG.medium, 1, true), shroud);
        drape.position.set(sx * P.shoulder * 1.0, P.torso * 0.74, -P.d * 0.08);
        drape.rotation.z = sx * 0.3;
        drape.castShadow = true;
        torso.add(drape);
      }
      // A high collar behind the hood, standing up.
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(P.w * 0.4, P.w * 0.3, 0.3, SEG.medium, 1, true), shroud);
      collar.position.set(0, P.torso * 1.02, -P.d * 0.2);
      collar.rotation.x = -0.24;
      torso.add(collar);

      // --- lit edges: the frame under the cloth, glimpsed ---
      for (const sx of [-1, 1]) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.022, P.torso * 0.5, 0.022), m.glow);
        rib.position.set(sx * P.w * 0.46, P.torso * 0.55, P.d * 0.2);
        torso.add(rib);
      }
      const sternum = new THREE.Mesh(new THREE.BoxGeometry(0.03, P.torso * 0.34, 0.03), m.glow);
      sternum.position.set(0, P.torso * 0.62, P.d * 0.56);
      torso.add(sternum);
      for (const leg of [legL, legR]) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.34, 0.02), m.glow);
        line.position.set(leg.userData.outZ * P.legR[1] * 1.1, -0.18, 0);
        leg.userData.lower.add(line);
      }

      /* --- the orb, in the off hand ---
       * Sat just past the fingers rather than in them: it is not held, it is
       * kept. Two shells so it has a falloff instead of an edge. */
      const orb = new THREE.Group();
      orb.position.set(0, -P.armLen[1] * 1.35, P.armR[2] * 2.4);
      armL.userData.lower.add(orb);
      const orbCore = new THREE.Mesh(
        new THREE.SphereGeometry(P.armR[2] * 1.5, SEG.pauldron, SEG.joint * 0.7), m.glow);
      orb.add(orbCore);
      for (const [r, o] of [[P.armR[2] * 2.6, 0.3], [P.armR[2] * 4.2, 0.11]]) {
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(r, SEG.pauldron, SEG.pauldron * 0.7),
          new THREE.MeshBasicMaterial({
            color: char.accent, transparent: true, opacity: o,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
          }),
        );
        orb.add(halo);
      }
      // Three shards circling it, because a sphere on its own reads as a ball.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const shard = new THREE.Mesh(
          new THREE.ConeGeometry(P.armR[2] * 0.42, P.armR[2] * 2.7, SEG.small), m.accent);
        shard.position.set(
          Math.cos(a) * P.armR[2] * 3.0, Math.sin(a) * P.armR[2] * 0.95, Math.sin(a) * P.armR[2] * 3.0);
        shard.rotation.set(1.2, a, 0.4);
        orb.add(shard);
      }
      break;
    }
    case 'bulwark': {
      /* A very large plate of metal with a person behind it.
       *
       * The shield stopped being a hexagon: the concept is a full-height slab
       * with a rounded top, wider than the body, and it carries the one piece
       * of heraldry in the game. It is built as a flat box with a half-round
       * cap rather than as an extruded cylinder, because the read is a *door*.
       */
      /* Sized off the body rather than in metres, because a tower shield is
         defined by how much of its owner it covers — quote it absolutely and it
         becomes a door the moment the figure's proportions change. */
      const shield = new THREE.Group();
      const SW = P.w * 0.84;            // slab width: a shade under shoulder width
      const SH = P.w * 1.42;            // slab height, before the cap

      const face = roundedBox(SW, SH, SW * 0.13, m.trim, SW * 0.055);
      shield.add(face);
      /* Rounded top: a whole cylinder laid across the head of the slab with its
         lower half buried inside it. A half-cylinder would be the tidier answer
         and is not worth it — getting the open half to point up survives
         exactly until somebody changes a rotation, and the seven triangles it
         saves are seven triangles. */
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(SW / 2, SW / 2, SW * 0.13, SEG.medium), m.trim);
      cap.rotation.set(Math.PI / 2, 0, 0);
      cap.position.y = SH / 2;
      cap.castShadow = true;
      shield.add(cap);

      // Banded iron edging all the way round, in the trim's darker metal.
      for (const sx of [-1, 1]) {
        const edge = roundedBox(SW * 0.09, SH, SW * 0.17, m.trim, SW * 0.03);
        edge.position.set(sx * (SW / 2 - SW * 0.03), 0, 0);
        shield.add(edge);
      }
      const foot = roundedBox(SW * 1.05, SW * 0.11, SW * 0.19, m.accent, SW * 0.04);
      foot.position.y = -SH / 2;
      shield.add(foot);
      // Two horizontal straps across the face, riveted.
      for (const y of [-SH * 0.26, SH * 0.22]) {
        const strap = roundedBox(SW, SW * 0.1, SW * 0.16, m.trim, SW * 0.035);
        strap.position.set(0, y, SW * 0.015);
        shield.add(strap);
        boltRow(shield, m.accent, {
          from: [-SW * 0.38, y, SW * 0.11], to: [SW * 0.38, y, SW * 0.11], count: 4, r: SW * 0.022,
        });
      }

      /* The eight-pointed star, dead centre. Four crossed bars plus four short
         diagonals — the shape is what a player remembers a tank by, and it is
         cheap: eight boxes and a boss. */
      const emblem = new THREE.Group();
      emblem.position.z = SW * 0.085;
      shield.add(emblem);
      for (let i = 0; i < 4; i++) {
        const long = i < 2;
        const ray = new THREE.Mesh(
          new THREE.BoxGeometry(SW * 0.05, SW * (long ? 0.86 : 0.58), SW * 0.04), m.accent);
        ray.rotation.z = (i / 4) * Math.PI;
        emblem.add(ray);
      }
      for (let i = 0; i < 4; i++) {
        const barb = new THREE.Mesh(new THREE.ConeGeometry(SW * 0.062, SW * 0.17, SEG.small), m.accent);
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        barb.position.set(Math.cos(a) * SW * 0.28, Math.sin(a) * SW * 0.28, 0);
        barb.rotation.z = a - Math.PI / 2;
        emblem.add(barb);
      }
      const boss = new THREE.Mesh(new THREE.IcosahedronGeometry(SW * 0.14, 1), m.glow);
      boss.position.z = SW * 0.055;
      emblem.add(boss);

      // Held close and slightly across the body — a tower shield is cover, and
      // cover with daylight between it and the ribs is not cover.
      /* Counter-rotated out of the forearm's frame so it hangs vertically.
         The forearm sits at about −0.46 rad in X once the rig settles into
         idle — measured, not guessed — and a slab strapped to it inherits that
         and lies back like a table top. Undoing it here keeps the shield
         upright while still letting it follow the arm, which is what a strapped
         shield should do. */
      shield.position.set(P.armR[2] * 0.56, -P.armLen[1] * 0.48, P.armR[2] * 1.3);
      shield.rotation.set(0.46, -0.22, 0.07);
      armL.userData.lower.add(shield);

      // --- the body behind it ---
      const backplate = new THREE.Mesh(new THREE.CylinderGeometry(P.w * 0.52, P.w * 0.46, P.torso * 0.74, SEG.small), m.trim);
      backplate.scale.z = 0.4;
      backplate.position.set(0, P.torso * 0.6, -P.d * 0.78);
      backplate.castShadow = true;
      torso.add(backplate);

      // Gorget under the helmet, and a heavy brow over the lamps.
      const gorget = new THREE.Mesh(new THREE.CylinderGeometry(P.w * 0.36, P.w * 0.44, 0.16, SEG.medium), m.joint);
      gorget.position.y = P.torso * 1.02;
      torso.add(gorget);
      const brow = roundedBox(P.headR * 1.9, P.headR * 0.3, P.headR * 0.5, m.trim, P.headR * 0.1);
      brow.position.set(0, P.headR * 0.42, P.headR * 0.62);
      head.add(brow);

      /* Tabard: three orange panels hanging off the belt, front and both hips.
         The one soft edge on an otherwise entirely rigid character, and the
         reason the waist does not read as a barrel. */
      for (const [sx, w, len, rot] of [[0, 0.3, 0.62, 0], [-1, 0.2, 0.46, -0.25], [1, 0.2, 0.46, 0.25]]) {
        const panel = roundedBox(w, len, 0.035, m.accent, 0.014);
        panel.position.set(sx * P.w * 0.4, P.torso * 0.02 - len * 0.5, P.d * (sx === 0 ? 0.56 : 0.3));
        panel.rotation.z = rot;
        torso.add(panel);
      }

      // Pauldron spikes: three studs across the top of each shoulder.
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const stud = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.11, SEG.small), m.joint);
          stud.position.set(sx * P.shoulder * 1.04 + (i - 1) * 0.11, P.torso * 0.96, -0.02);
          torso.add(stud);
        }
      }

      // Knee cops, so the legs read as armour rather than as posts.
      for (const leg of [legL, legR]) {
        const cop = new THREE.Mesh(
          new THREE.SphereGeometry(P.legR[1] * 1.5, SEG.small, SEG.small * 0.7, 0, Math.PI * 2, 0, Math.PI * 0.55), m.trim);
        cop.rotation.x = 1.4;
        cop.position.set(0, 0.01, P.legR[1] * 0.55);
        cop.castShadow = true;
        leg.userData.lower.add(cop);
        const spur = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, SEG.small), m.accent);
        spur.position.set(0, 0.02, P.legR[1] * 1.5);
        spur.rotation.x = 1.5;
        leg.userData.lower.add(spur);
      }
      break;
    }
    case 'halcyon': {
      /* White airframe, and everything that is not white is thrust.
       *
       * The concept's whole silhouette is the wing: four long swept blades
       * fanning off the back, lit from inside. Every dimension here is quoted
       * off the body rather than in metres — a wing given an absolute length
       * stops being a wing the moment the figure's proportions change, and the
       * first pass turned into a hang-glider when the bodies were rebuilt.
       */
      const blade = new THREE.MeshStandardMaterial({
        color: char.accent, emissive: char.accent, emissiveIntensity: 2.6,
        roughness: 0.2, metalness: 0.3, transparent: true, opacity: 0.92,
      });

      // --- the wing: four blades a side, fanning out and back ---
      const wingRoot = new THREE.Group();
      // Rooted at the shoulder blades rather than the base of the neck: a wing
      // that grows out of the collar is a crown.
      wingRoot.position.set(0, P.torso * 0.66, -P.d * 0.7);
      torso.add(wingRoot);
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const t = i / 3;                               // 0 innermost … 1 outermost
          const len = P.torso * (1.55 - t * 0.34);
          const vane = new THREE.Mesh(
            new THREE.ConeGeometry(P.w * (0.13 - t * 0.025), len, SEG.small), blade);
          /* Cones point +Y, so each blade is laid onto its own spoke: mostly
             out to the side with a little lift and a little sweep back. */
          vane.position.set(
            sx * P.w * (0.3 + t * 0.28),
            P.w * (0.2 - t * 0.13),
            -P.w * (0.08 + t * 0.13),
          );
          vane.rotation.set(-0.34 - t * 0.16, 0, sx * (0.95 + t * 0.3));
          vane.castShadow = true;
          wingRoot.add(vane);
          // Housing at the root of each blade, in white.
          const housing = new THREE.Mesh(
            new THREE.CylinderGeometry(P.w * 0.11, P.w * 0.135, P.w * 0.28, SEG.medium), m.trim);
          housing.position.copy(vane.position);
          housing.rotation.copy(vane.rotation);
          housing.translateY(-len * 0.46);
          wingRoot.add(housing);
        }
      }
      // Spine the wing bolts to.
      const spine = roundedBox(P.w * 0.5, P.torso * 0.52, P.w * 0.34, m.trim, P.w * 0.1);
      spine.position.set(0, P.torso * 0.66, -P.d * 0.72);
      torso.add(spine);
      const spineLight = new THREE.Mesh(
        new THREE.BoxGeometry(P.w * 0.09, P.torso * 0.4, P.w * 0.09), m.glow);
      spineLight.position.set(0, P.torso * 0.66, -P.d * 0.86);
      torso.add(spineLight);

      // --- thrusters: two under the pack, one behind each calf ---
      for (const sx of [-1, 1]) {
        const nozzle = new THREE.Mesh(
          new THREE.CylinderGeometry(P.w * 0.17, P.w * 0.25, P.w * 0.5, SEG.medium, 1, true), m.trim);
        nozzle.position.set(sx * P.w * 0.32, P.torso * 0.3, -P.d * 0.74);
        nozzle.rotation.x = -0.26;
        nozzle.castShadow = true;
        torso.add(nozzle);
        const flame = new THREE.Mesh(new THREE.ConeGeometry(P.w * 0.15, P.w * 0.55, SEG.medium), m.glow);
        flame.position.set(sx * P.w * 0.32, P.torso * 0.08, -P.d * 0.68);
        flame.rotation.x = Math.PI;
        torso.add(flame);
      }
      for (const leg of [legL, legR]) {
        const pod = new THREE.Mesh(
          new THREE.CylinderGeometry(P.legR[2] * 0.8, P.legR[2] * 1.0, P.legR[2] * 2.8, SEG.medium), m.trim);
        pod.position.set(0, -P.legLen[1] * 0.3, -P.legR[2] * 2.0);
        pod.rotation.x = 0.2;
        leg.userData.lower.add(pod);
        const jet = new THREE.Mesh(
          new THREE.ConeGeometry(P.legR[2] * 0.68, P.legR[2] * 3.0, SEG.small), m.glow);
        jet.position.set(0, -P.legLen[1] * 0.56, -P.legR[2] * 2.1);
        jet.rotation.x = Math.PI - 0.2;
        leg.userData.lower.add(jet);
      }

      // --- ordnance: a rack of three charges on the hip ---
      const rack = roundedBox(P.w * 0.44, P.w * 0.22, P.w * 0.44, m.trim, P.w * 0.07);
      rack.position.set(P.w * 0.5, P.torso * 0.08, P.d * 0.3);
      torso.add(rack);
      for (let i = 0; i < 3; i++) {
        const bomb = new THREE.Mesh(new THREE.IcosahedronGeometry(P.w * 0.13, 1), m.trim);
        bomb.position.set(P.w * 0.5 + (i - 1) * P.w * 0.14, P.torso * 0.08 - P.w * 0.2, P.d * 0.3);
        bomb.castShadow = true;
        torso.add(bomb);
        const fuse = new THREE.Mesh(
          new THREE.SphereGeometry(P.w * 0.05, SEG.small, SEG.small * 0.7), m.glow);
        fuse.position.set(P.w * 0.5 + (i - 1) * P.w * 0.14, P.torso * 0.08 - P.w * 0.31, P.d * 0.36);
        torso.add(fuse);
      }

      // --- white plating over the light frame ---
      const breast = new THREE.Mesh(
        new THREE.SphereGeometry(P.w * 0.46, SEG.pauldron, SEG.joint * 0.7, 0, Math.PI * 2, 0, Math.PI * 0.5),
        m.trim);
      breast.scale.set(1, 0.8, 0.66);
      breast.position.set(0, P.torso * 0.6, P.d * 0.16);
      breast.castShadow = true;
      torso.add(breast);
      for (const sx of [-1, 1]) {
        const intake = new THREE.Mesh(
          new THREE.BoxGeometry(P.w * 0.1, P.torso * 0.28, P.w * 0.1), m.glow);
        intake.position.set(sx * P.w * 0.42, P.torso * 0.56, P.d * 0.1);
        torso.add(intake);
      }
      // Ankle fins — the last thing off the ground, and the concept lights them.
      for (const leg of [legL, legR]) {
        const fin = new THREE.Mesh(
          new THREE.ConeGeometry(P.legR[2] * 0.55, P.legR[2] * 3.6, 4), blade);
        fin.position.set(leg.userData.outZ * P.legR[2] * 1.3, -P.legLen[1] * 0.72, -P.legR[2] * 0.3);
        fin.rotation.set(-0.3, 0, leg.userData.outZ * 0.5);
        leg.userData.lower.add(fin);
      }
      break;
    }
    case 'dasher': {
      /* Matte black, and the only thing you can actually see is the discharge.
       *
       * The plate is nearly the background colour, so the silhouette has to be
       * carried entirely by light: a soft additive shell around the body, a
       * harder rim just off the chest, lit edges wherever the frame has one —
       * and, the thing the concept is actually built around, a teal scarf.
       *
       * The scarf is doing the work the old cone sash could not. A cone off the
       * back is a tail; a wrapped collar with two long tails streaming behind
       * is a neck, a direction of travel, and the only warm shape on an
       * otherwise entirely hard body. It is also the one part of the character
       * that is *cloth*, which is what stops the frame reading as another
       * armoured trooper painted black.
       */
      const auraColor = new THREE.Color(char.accent);
      // Off the chest, so the discharge stays a halo around the body rather
      // than a weather balloon he is standing inside.
      for (const [radius, opacity] of [[P.w * 1.55, 0.15], [P.w * 2.05, 0.055]]) {
        const shell = new THREE.Mesh(
          new THREE.SphereGeometry(radius, SEG.pauldron, SEG.pauldron * 0.7),
          new THREE.MeshBasicMaterial({
            color: auraColor, transparent: true, opacity,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
          }),
        );
        shell.scale.set(1, 1.15, 1);
        shell.position.y = P.torso * 0.45;
        torso.add(shell);
      }
      // A hard ring around the chest: the aura wants an edge somewhere or it
      // is just a smudge the character is standing inside.
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(P.w * 0.92, 0.022, 10, SEG.ring),
        new THREE.MeshBasicMaterial({
          color: auraColor, transparent: true, opacity: 0.5,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = P.torso * 0.55;
      torso.add(halo);

      /* --- the scarf --- */
      const scarfMat = makeCharacterMaterial(m.surfaces.cloth, {
        color: char.accent, emissive: char.accent, emissiveIntensity: 0.5,
        roughness: 0.88, metalness: 0.0, scale: 6.0,
      });
      // The wrap itself: a thick collar sitting on the shoulders, tipped
      // forward so it bunches under the chin rather than ringing the neck.
      const wrap = new THREE.Mesh(new THREE.TorusGeometry(P.w * 0.31, 0.055, 10, SEG.ring), scarfMat);
      wrap.rotation.set(Math.PI / 2 + 0.12, 0, 0);
      wrap.position.set(0, P.torso * 1.0, 0.01);
      wrap.scale.z = 0.88;
      wrap.castShadow = true;
      torso.add(wrap);
      // A knot at the throat and a short bib hanging off it.
      const knot = new THREE.Mesh(new THREE.IcosahedronGeometry(0.055, 0), scarfMat);
      knot.position.set(P.w * 0.13, P.torso * 0.96, P.d * 0.4);
      torso.add(knot);
      const bib = new THREE.Mesh(new THREE.ConeGeometry(P.w * 0.17, 0.22, SEG.small, 1, true), scarfMat);
      bib.position.set(P.w * 0.1, P.torso * 0.84, P.d * 0.34);
      bib.rotation.set(-0.2, 0, 0.2);
      torso.add(bib);
      /* Two tails, streaming *back* and down. They were fanned out to the sides
         and read as a bow tie: a scarf is only a scarf while it hangs behind
         the shoulder line, so the lateral spread stays small and almost all the
         travel is in −Z. Tapered segments rather than one long box, so they
         read as fabric with weight in them. */
      for (const sx of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const t = k / 2;
          const tail = roundedBox(0.085 - t * 0.022, 0.32 - t * 0.05, 0.02, scarfMat, 0.008);
          tail.position.set(
            sx * (P.w * 0.11 + t * 0.045),
            P.torso * 0.9 - t * 0.34,
            -P.d * (0.62 + t * 0.62),
          );
          tail.rotation.set(0.85 + t * 0.3, sx * t * 0.14, sx * (0.06 + t * 0.08));
          tail.castShadow = true;
          torso.add(tail);
        }
      }

      /* --- lit edges: how a black frame keeps a shape at range --- */
      // A blade fin off each pauldron, angled back — the concept's shoulders
      // are wedges, not domes, and the fin is what makes them read that way.
      for (const sx of [-1, 1]) {
        // Swept back along the body, not out from it — a fin that points
        // sideways is an antler, and the concept's shoulders are wedges.
        const fin = new THREE.Mesh(new THREE.ConeGeometry(0.042, 0.3, SEG.small), m.glow);
        fin.position.set(sx * P.shoulder * 1.02, P.torso * 0.88, -0.16);
        fin.rotation.set(-1.42, 0, sx * 0.18);
        fin.castShadow = true;
        torso.add(fin);
        const edge = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.028, P.d * 1.5), m.glow);
        edge.position.set(sx * P.shoulder * 1.1, P.torso * 0.82, 0);
        torso.add(edge);
      }
      // Ribs down the flanks and a line down the sternum.
      for (const sx of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const rib = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.13), m.glow);
          rib.position.set(sx * P.w * 0.47, P.torso * (0.4 + k * 0.14), 0.02);
          rib.rotation.y = sx * 0.3;
          torso.add(rib);
        }
      }
      const sternum = new THREE.Mesh(new THREE.BoxGeometry(0.024, P.torso * 0.36, 0.024), m.glow);
      sternum.position.set(0, P.torso * 0.6, P.d * 0.56);
      torso.add(sternum);

      // Sprinter's greaves, heel blades and lit thigh stripes: the legs are
      // the character, and they are the part that has to say "fast".
      for (const leg of [legL, legR]) {
        const greave = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.32, 0.028), m.glow);
        greave.position.set(0, -0.2, P.legR[2] * 1.5);
        leg.userData.lower.add(greave);
        const heel = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.24, SEG.small), m.accent);
        heel.position.set(0, -0.3, -P.legR[2] * 1.9);
        heel.rotation.x = -0.5;
        leg.userData.lower.add(heel);
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.4, 0.026), m.glow);
        stripe.position.set(leg.userData.outZ * P.legR[0] * 1.05, -0.2, 0);
        leg.add(stripe);
      }

      // Vents down the ribs — the frame is mostly cooling and almost no armour.
      ventStack(torso, m.trim, {
        pos: [P.w * 0.44, P.torso * 0.5, -0.06], count: 4, size: [0.014, 0.09, 0.05], spacing: 0.075,
      });
      ventStack(torso, m.trim, {
        pos: [-P.w * 0.44, P.torso * 0.5, -0.06], count: 4, size: [0.014, 0.09, 0.05], spacing: 0.075,
      });
      break;
    }
    case 'chain': {
      /* A straw hat, a robe, and no armour worth the name.
       *
       * Every other silhouette in the descent is plate and thrusters, so this
       * one is deliberately cloth and deliberately layered: a dark red under-
       * robe from the shoulders to the shins, a cream over-robe open down the
       * front, a rope belt, and the widest flat disc in the game where the head
       * should be. All of it is built from its own materials — a straw hat that
       * takes the character's metalness stops looking like straw.
       *
       * The hat gets a red flower and the face gets a red scarf, and between
       * them they are the only saturated colour on the model. That is the whole
       * palette trick: everything else is linen, straw and dirt, so the eye
       * goes to the two red marks and reads them as the character.
       */
      const S = m.surfaces;
      const straw = makeCharacterMaterial(S.straw, { color: 0xd2b48c, roughness: 0.94, scale: 5.0 });
      const strawDark = makeCharacterMaterial(S.straw, { color: 0x9c7a48, roughness: 0.95, scale: 5.0 });
      const linen = makeCharacterMaterial(S.cloth, { color: 0xf2e6c9, roughness: 0.94, scale: 4.4 });
      const under = makeCharacterMaterial(S.cloth, { color: 0x7d2f31, roughness: 0.92, scale: 4.0 });
      const rope = makeCharacterMaterial(S.rope, { color: 0x8a6f4a, roughness: 0.96, scale: 9.0 });
      const red = makeCharacterMaterial(S.cloth, { color: 0xc94a4a, roughness: 0.88, scale: 6.0 });
      const iron = makeCharacterMaterial(S.plate, { color: 0x4a4038, roughness: 0.55, metalness: 0.72, scale: 8.0 });

      /* --- the straw hat: a wide conical brim, a crown, a band, a flower --- */
      const hat = new THREE.Group();
      /* Brim and crown are one surface, lathed.
       *
       * They were two cones, which is why the weave sticks used to poke out
       * past the edge: the brim cone's radius at the height the sticks sat at
       * was nothing like its radius at the base, so anything positioned by eye
       * against the base overshot the silhouette. A lathe removes the guesswork
       * — the profile *is* the hat, the widest point is where the profile says
       * it is, and everything else is placed against `BRIM`. */
      /* Wide enough to read as a farmer's hat, narrow enough to still be a hat.
         Two headR was arrived at by rendering it: a cone's radius is quoted at
         its *base* and it tapers away above that, so the old cone's silhouette
         was far narrower than its number suggested — matching the number on a
         lathe produced a garden parasol. */
      const BRIM = P.headR * 2.0;
      const profile = [
        [0.0, P.headR * 2.5],               // tip of the crown
        [P.headR * 0.34, P.headR * 2.24],
        [P.headR * 0.62, P.headR * 1.72],
        [P.headR * 0.86, P.headR * 1.12],   // shoulder where the crown meets the brim
        [P.headR * 0.98, P.headR * 0.7],
        [BRIM * 0.66, P.headR * 0.38],
        [BRIM, P.headR * 0.12],             // the brim edge, thin
        [BRIM * 0.985, P.headR * 0.05],     // and its underside, so it has thickness
        [BRIM * 0.6, P.headR * 0.1],
        [P.headR * 0.88, P.headR * 0.26],
      ].map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y));
      const hatShell = new THREE.Mesh(new THREE.LatheGeometry(profile, SEG.headRing), straw);
      hatShell.castShadow = true;
      hat.add(hatShell);

      const band = new THREE.Mesh(
        new THREE.TorusGeometry(P.headR * 1.02, 0.03, 10, SEG.ring), strawDark);
      band.rotation.x = Math.PI / 2;
      band.position.y = P.headR * 0.86;
      hat.add(band);
      /* Weave: concentric rings, which is what a woven brim actually looks like
         from above and, unlike radial sticks, cannot escape the silhouette
         because every one of them is a circle smaller than the brim. */
      for (let i = 0; i < 3; i++) {
        const t = 0.5 + i * 0.16;
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(BRIM * t, 0.008, 6, SEG.ring), strawDark);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = P.headR * (0.4 - i * 0.09);
        hat.add(ring);
      }
      // The flower, pinned to the brim on his right.
      const flower = new THREE.Group();
      flower.position.set(BRIM * 0.62, P.headR * 0.36, BRIM * 0.44);
      hat.add(flower);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const petal = new THREE.Mesh(new THREE.SphereGeometry(0.042, SEG.small, SEG.small * 0.7), red);
        petal.scale.set(1, 0.42, 1.25);
        petal.position.set(Math.cos(a) * 0.045, 0.012, Math.sin(a) * 0.045);
        petal.rotation.y = -a;
        flower.add(petal);
      }
      const pistil = new THREE.Mesh(new THREE.SphereGeometry(0.026, SEG.small, SEG.small * 0.7), strawDark);
      pistil.position.y = 0.028;
      flower.add(pistil);
      // Two ribbons off the pin, hanging under the brim.
      for (const sx of [-1, 1]) {
        const ribbon = roundedBox(0.02, 0.2, 0.014, red, 0.006);
        ribbon.position.set(sx * 0.03, -0.11, 0.01);
        ribbon.rotation.z = sx * 0.18;
        flower.add(ribbon);
      }
      hat.position.y = P.headR * 0.34;
      head.add(hat);
      // Named so the hat-throw can take it off him — see `Combat._tickHat`.
      hatNode = hat;

      // --- the face: a red scarf over the lower half, and nothing else ---
      const scarf = new THREE.Mesh(new THREE.SphereGeometry(P.headR * 1.06, SEG.pauldron, SEG.pauldron * 0.7, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.4), red);
      scarf.scale.set(1, 1.15, 1.02);
      scarf.castShadow = true;
      head.add(scarf);
      const scarfKnot = roundedBox(0.07, 0.16, 0.05, red, 0.02);
      scarfKnot.position.set(-P.headR * 0.72, -P.headR * 0.42, -P.headR * 0.3);
      scarfKnot.rotation.z = 0.4;
      head.add(scarfKnot);
      // The dark under the brim, where a face would be.
      const shade = new THREE.Mesh(new THREE.BoxGeometry(P.headR * 1.15, 0.03, 0.03), m.glow);
      shade.position.set(0, P.headR * 0.06, P.headR * 0.88);
      head.add(shade);

      /* --- the robe, in two layers --- */
      // Under-robe: dark red, shoulders to shins, the longer of the two.
      const underRobe = new THREE.Mesh(
        new THREE.ConeGeometry(P.w * 1.1, P.torso + P.hipY * 0.92, SEG.medium, 1, true), under);
      underRobe.position.y = P.torso * 0.46 - P.hipY * 0.44;
      underRobe.castShadow = true;
      torso.add(underRobe);
      // Over-robe: cream, shorter, and open down the front — built as two
      // half-cones with a gap between them rather than one closed cone, which
      // is what makes it read as a coat somebody is wearing open.
      for (const sx of [-1, 1]) {
        const half = new THREE.Mesh(
          new THREE.ConeGeometry(P.w * 1.16, P.torso + P.hipY * 0.5, SEG.medium, 1, true, sx > 0 ? 0.35 : Math.PI + 0.35, Math.PI - 0.7),
          linen,
        );
        half.position.set(0, P.torso * 0.5 - P.hipY * 0.22, 0);
        half.castShadow = true;
        torso.add(half);
      }
      // The shoulder yoke, which is what stops the two halves reading as wings.
      const yoke = new THREE.Mesh(
        new THREE.SphereGeometry(P.w * 0.62, SEG.pauldron, SEG.pauldron * 0.7, 0, Math.PI * 2, 0, Math.PI * 0.42), linen);
      yoke.scale.set(1, 0.66, 0.86);
      yoke.position.y = P.torso * 0.78;
      yoke.castShadow = true;
      torso.add(yoke);
      // Wide sleeves over the upper arms — cloth, not plate.
      for (const arm of [armL, armR]) {
        const sleeve = new THREE.Mesh(new THREE.ConeGeometry(P.armR[0] * 2.3, 0.38, SEG.medium, 1, true), linen);
        sleeve.position.y = -0.13;
        sleeve.castShadow = true;
        arm.add(sleeve);
        // Wrapped forearm underneath it.
        const wrapArm = new THREE.Mesh(
          new THREE.CylinderGeometry(P.armR[2] * 1.25, P.armR[2] * 1.1, 0.26, SEG.medium), under);
        wrapArm.position.y = -0.18;
        arm.userData.lower.add(wrapArm);
      }

      /* --- the rope belt, and the chain hanging off it --- */
      // Braided: two offset toruses reading as a twist, rather than one ring.
      for (const [tilt, r] of [[0.05, 0.042], [-0.05, 0.038]]) {
        const coil = new THREE.Mesh(new THREE.TorusGeometry(P.w * 0.58, r, 10, SEG.ring), rope);
        coil.rotation.set(Math.PI / 2, 0, tilt);
        coil.position.y = P.torso * 0.06;
        coil.scale.z = 0.8;
        torso.add(coil);
      }
      const beltKnot = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 0), rope);
      beltKnot.position.set(-P.w * 0.16, P.torso * 0.04, P.d * 0.54);
      torso.add(beltKnot);
      // Two cord ends hanging from the knot.
      for (const sx of [-1, 1]) {
        const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.013, 0.4, SEG.small), rope);
        cord.position.set(-P.w * 0.16 + sx * 0.05, P.torso * 0.04 - 0.22, P.d * 0.52);
        cord.rotation.z = sx * 0.14;
        torso.add(cord);
      }

      /* The chain, on his left hip. It is the ability made visible: the hat
         goes out on it and comes back on it, and a run of alternating links
         with a weight on the end is the shape that says so from any angle. */
      const chain = new THREE.Group();
      chain.position.set(-P.w * 0.5, P.torso * 0.02, P.d * 0.18);
      chain.rotation.z = 0.16;
      torso.add(chain);
      for (let i = 0; i < 9; i++) {
        const link = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.012, 10, SEG.ring), iron);
        // Alternating link planes: what makes a stack of toruses read as chain.
        link.rotation.y = (i % 2) * Math.PI / 2;
        link.position.set(Math.sin(i * 0.55) * 0.03, -i * 0.058, 0);
        chain.add(link);
      }
      // The weight at the end of it: a little straw hat, because of course.
      const weight = new THREE.Group();
      weight.position.y = -0.55;
      chain.add(weight);
      const wBrim = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.045, SEG.medium, 1, true), straw);
      weight.add(wBrim);
      const wCrown = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.055, SEG.medium), straw);
      wCrown.position.y = 0.038;
      weight.add(wCrown);
      const wFlower = new THREE.Mesh(new THREE.SphereGeometry(0.024, SEG.small, SEG.small * 0.7), red);
      wFlower.scale.y = 0.5;
      wFlower.position.set(0.062, 0.014, 0.03);
      weight.add(wFlower);

      // Sandals: a sole and two straps, so the feet are not boots.
      for (const leg of [legL, legR]) {
        const strapA = roundedBox(P.legR[2] * 2.1, 0.024, 0.05, rope, 0.01);
        strapA.position.set(0, -0.4, P.legR[2] * 0.5);
        leg.userData.lower.add(strapA);
        const shinWrap = new THREE.Mesh(
          new THREE.CylinderGeometry(P.legR[2] * 1.2, P.legR[2] * 1.35, 0.24, SEG.medium), under);
        shinWrap.position.y = -0.26;
        leg.userData.lower.add(shinWrap);
      }
      break;
    }
    default: {
      // Vanguard: utility pouches and a shoulder lamp.
      for (const sx of [-1, 1]) {
        const pouch = roundedBox(0.16, 0.18, 0.12, m.trim, 0.035);
        pouch.position.set(sx * P.w * 0.42, P.torso * 0.2, P.d * 0.3);
        torso.add(pouch);
      }
      // Seen end-on, so the cap is the shape — a decagon read as a decagon.
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.14, SEG.ring), m.glow);
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(-P.shoulder * 0.95, P.torso * 1.0, P.d * 0.3);
      torso.add(lamp);
      break;
    }
  }

  /* Weapon mount sits at the right hand, and the hand goes with it.
   *
   * The mount's orientation is driven every frame so the muzzle tracks the
   * crosshair, and it used to be the only thing that moved — the glove stayed
   * with the forearm, so the weapon floated next to a hand that was not holding
   * it. Re-parenting the glove into the mount means the fingers are rigidly
   * attached to the grip: however the weapon turns, the hand turns with it, and
   * it always reads as being held rather than carried alongside.
   *
   * Every weapon is authored with its grip just below the origin (see
   * `buildWeaponModel`), so one offset works for the whole arsenal. */
  const weaponMount = new THREE.Group();
  weaponMount.position.set(0, -0.34, 0.02);
  armR.userData.lower.add(weaponMount);

  const gripHand = armR.userData.hand;
  if (gripHand) {
    gripHand.parent.remove(gripHand);
    gripHand.position.set(0, -0.055, -0.015);
    gripHand.rotation.set(0.34, 0, 0);
    weaponMount.add(gripHand);
  }

  g.userData = {
    torso, torsoBaseY: torso.position.y, head, armL, armR, legL, legR, pelvis,
    weaponMount, gripHand, visor: m.visor, build, hipY: P.hipY, hat: hatNode,
  };
  return mergeStaticMeshes(g);
}

/* ==========================================================================
   WEAPONS
   ========================================================================== */
/**
 * Weapons.
 *
 * Each build is an assembly of recognisable parts — receiver, barrel and shroud,
 * muzzle device, magazine, grip with trigger guard, stock, optic, rails and heat
 * vents — rather than a couple of boxes. Everything is authored pointing down
 * +Z with the grip below origin, so the hand mount can align the whole weapon to
 * the aim direction without per-weapon fudging.
 */
/**
 * The hat, off the head.
 *
 * Chain's two abilities both throw the same object, so it is built once here
 * rather than twice at the call sites — and it is built flat and light, because
 * it spends its life spinning through the air at thirty metres a second where
 * nobody is going to read the weave.
 */
export function buildHatModel(accent = 0xc94a4a, scale = 1) {
  const g = new THREE.Group();
  const straw = mat(0xd2b48c, { roughness: 0.94, metalness: 0.02 });
  const strawDark = mat(0x9c7a48, { roughness: 0.95, metalness: 0.02 });
  const petalMat = mat(0xc94a4a, { roughness: 0.86, metalness: 0.04 });
  const lit = new THREE.MeshStandardMaterial({
    color: accent, emissive: accent, emissiveIntensity: 2.0, roughness: 0.4,
  });
  const brim = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.1, 14, 1, true), straw);
  g.add(brim);
  const crown = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.32, 14), straw);
  crown.position.y = 0.14;
  g.add(crown);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.022, 4, 14), strawDark);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.05;
  g.add(band);
  /* The flower goes with it. It is the same object as the one on his head, and
     the thing that makes a spinning disc identifiable as *his* hat mid-flight
     rather than as a generic projectile — so it is worth six triangles. */
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const petal = new THREE.Mesh(new THREE.SphereGeometry(0.062, 6, 5), petalMat);
    petal.scale.set(1, 0.4, 1.2);
    petal.position.set(0.36 + Math.cos(a) * 0.065, 0.03, Math.sin(a) * 0.065);
    petal.rotation.y = -a;
    g.add(petal);
  }
  const pistil = new THREE.Mesh(new THREE.SphereGeometry(0.036, 6, 5), strawDark);
  pistil.position.set(0.36, 0.055, 0);
  g.add(pistil);
  // A lit rim around the edge: it has to be findable across an arena.
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.018, 4, 20), lit);
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  g.scale.setScalar(scale);
  return g;
}

export function buildWeaponModel(weapon) {
  const g = new THREE.Group();
  const body = mat(0x424a59, { roughness: 0.44, metalness: 0.72 });
  const dark = mat(0x272d38, { roughness: 0.6, metalness: 0.5 });
  const grip = mat(0x22262e, { roughness: 0.88, metalness: 0.12 });
  const steel = mat(0x6d7787, { roughness: 0.3, metalness: 0.9 });
  const accent = mat(weapon.color, { emissive: weapon.color, emissiveIntensity: 0.9, roughness: 0.34, metalness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x8fd8ff, emissive: 0x4aa8ff, emissiveIntensity: 1.4, roughness: 0.1, metalness: 0.4,
    transparent: true, opacity: 0.75,
  });
  const muzzle = new THREE.Object3D();

  /** Pistol grip with a trigger guard and trigger — shared by most builds. */
  const addGrip = (z, angle = 0.28, scale = 1) => {
    const gr = new THREE.Group();
    gr.position.set(0, -0.06 * scale, z);
    gr.rotation.x = angle;
    gr.add(box(0.075 * scale, 0.27 * scale, 0.105 * scale, grip, 0, -0.14 * scale, 0));
    gr.add(box(0.08 * scale, 0.06 * scale, 0.12 * scale, dark, 0, -0.28 * scale, 0));
    for (let i = 0; i < 3; i++) {
      gr.add(box(0.085 * scale, 0.015 * scale, 0.11 * scale, dark, 0, -0.08 * scale - i * 0.055 * scale, 0));
    }
    g.add(gr);
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.062 * scale, 0.014 * scale, 8, SEG.medium, Math.PI), dark);
    guard.rotation.set(Math.PI / 2, 0, 0);
    guard.position.set(0, -0.075 * scale, z + 0.055 * scale);
    g.add(guard);
    g.add(box(0.022 * scale, 0.055 * scale, 0.02 * scale, steel, 0, -0.085 * scale, z + 0.045 * scale));
    return gr;
  };

  /** Slotted heat shroud around a barrel. */
  const addShroud = (z, len, r, slots = 5) => {
    const sh = cyl(r, r, len, 10, body, 0, 0, z);
    sh.rotation.x = Math.PI / 2;
    g.add(sh);
    for (let i = 0; i < slots; i++) {
      const t = (i + 0.5) / slots;
      for (const sx of [-1, 1]) {
        g.add(box(r * 0.5, r * 0.9, len / slots * 0.45, dark, sx * r * 0.78, 0, z - len / 2 + t * len));
      }
      g.add(box(r * 1.5, r * 0.32, len / slots * 0.4, dark, 0, r * 0.72, z - len / 2 + t * len));
    }
  };

  /** Boxy optic with a glowing lens. */
  const addOptic = (z, scale = 1) => {
    g.add(box(0.075 * scale, 0.06 * scale, 0.2 * scale, dark, 0, 0.085 * scale, z));
    g.add(box(0.095 * scale, 0.09 * scale, 0.13 * scale, body, 0, 0.14 * scale, z));
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.035 * scale, 10), glass);
    lens.position.set(0, 0.14 * scale, z + 0.068 * scale);
    g.add(lens);
    g.add(box(0.02 * scale, 0.03 * scale, 0.02 * scale, accent, 0, 0.2 * scale, z));
  };

  /** Picatinny-style rail. */
  const addRail = (z, len, y = 0.06) => {
    for (let i = 0; i < Math.round(len / 0.035); i++) {
      g.add(box(0.05, 0.016, 0.02, dark, 0, y, z - len / 2 + i * 0.035));
    }
  };

  /** Backup iron sights: front post in a hood, rear aperture. */
  const addIronSights = (frontZ, rearZ, y = 0.085, scale = 1) => {
    g.add(box(0.012 * scale, 0.05 * scale, 0.012 * scale, steel, 0, y + 0.03 * scale, frontZ));
    for (const sx of [-1, 1]) {
      g.add(box(0.01 * scale, 0.055 * scale, 0.03 * scale, dark, sx * 0.028 * scale, y + 0.03 * scale, frontZ));
    }
    const rear = new THREE.Mesh(new THREE.TorusGeometry(0.022 * scale, 0.008 * scale, 8, SEG.medium), dark);
    rear.position.set(0, y + 0.03 * scale, rearZ);
    g.add(rear);
    g.add(box(0.05 * scale, 0.014 * scale, 0.03 * scale, dark, 0, y + 0.005 * scale, rearZ));
  };

  /** Charging handle and ejection port on the right side of the receiver. */
  const addAction = (z, scale = 1) => {
    const port = box(0.02 * scale, 0.075 * scale, 0.17 * scale, dark, 0.055 * scale, 0.02 * scale, z);
    g.add(port);
    g.add(box(0.024 * scale, 0.085 * scale, 0.02 * scale, steel, 0.058 * scale, 0.02 * scale, z + 0.1 * scale));
    const handle = box(0.075 * scale, 0.022 * scale, 0.05 * scale, steel, 0.05 * scale, 0.055 * scale, z - 0.09 * scale);
    g.add(handle);
    // Selector switch and magazine release.
    const selector = cyl(0.016 * scale, 0.016 * scale, 0.03 * scale, 6, steel, 0.05 * scale, -0.035 * scale, z - 0.13 * scale);
    selector.rotation.z = Math.PI / 2;
    g.add(selector);
    g.add(box(0.018 * scale, 0.03 * scale, 0.022 * scale, steel, 0.05 * scale, -0.02 * scale, z + 0.02 * scale));
  };

  /** Sling loops fore and aft. */
  const addSling = (frontZ, rearZ, scale = 1) => {
    for (const [z, sx] of [[frontZ, -1], [rearZ, 1]]) {
      const loop = new THREE.Mesh(new THREE.TorusGeometry(0.026 * scale, 0.008 * scale, 8, SEG.medium), steel);
      loop.rotation.y = Math.PI / 2;
      loop.position.set(sx * 0.045 * scale, -0.035 * scale, z);
      g.add(loop);
    }
  };

  /** Fluted barrel: shallow flutes cut along the length. */
  const addFlutes = (z, len, r, count = 6) => {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      g.add(box(r * 0.22, r * 0.22, len * 0.86, dark,
        Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92, z));
    }
  };

  switch (weapon.model) {
    case 'pistol': {
      g.add(box(0.085, 0.13, 0.4, body, 0, 0, 0.1));            // slide
      g.add(box(0.09, 0.03, 0.42, steel, 0, 0.07, 0.1));        // slide top rib
      for (let i = 0; i < 5; i++) g.add(box(0.088, 0.09, 0.012, dark, 0, 0, -0.02 + i * 0.028));
      g.add(box(0.06, 0.1, 0.34, dark, 0, -0.06, 0.12));        // frame
      addShroud(0.3, 0.16, 0.036, 3);
      g.add(cyl(0.03, 0.034, 0.09, 8, steel, 0, 0, 0.39));      // compensator
      g.add(box(0.048, 0.048, 0.05, accent, 0, 0, 0.36));
      g.add(box(0.055, 0.19, 0.09, dark, 0, -0.16, -0.02));     // magazine
      addGrip(-0.02, 0.3);
      addOptic(0.06, 0.9);
      addIronSights(0.29, -0.06, 0.075, 0.9);
      addAction(0.02, 0.85);
      addSling(0.24, -0.08, 0.9);
      panelLine(g, dark, { pos: [0, -0.108, 0.12], size: [0.062, 0.008, 0.3] });
      boltRow(g, steel, { from: [0.031, -0.055, -0.05], to: [0.031, -0.055, 0.2], count: 3, r: 0.008 });
      g.add(box(0.052, 0.02, 0.055, dark, 0, -0.26, -0.02));    // magazine floorplate
      muzzle.position.set(0, 0, 0.44);
      break;
    }
    case 'shotgun': {
      g.add(box(0.12, 0.15, 0.5, body, 0, 0, 0.2));             // receiver
      g.add(box(0.125, 0.05, 0.28, dark, 0, 0.09, 0.16));       // top plate
      addShroud(0.55, 0.52, 0.055, 5);                          // barrel + shroud
      g.add(cyl(0.062, 0.075, 0.12, 8, steel, 0, 0, 0.84));     // choke
      for (let i = 0; i < 4; i++) g.add(box(0.03, 0.03, 0.04, accent, 0, 0.055, 0.62 + i * 0.06));
      g.add(cyl(0.045, 0.045, 0.46, 8, dark, 0, -0.085, 0.56)); // tube magazine
      const pump = box(0.11, 0.09, 0.2, grip, 0, -0.085, 0.5);
      g.add(pump);
      for (let i = 0; i < 4; i++) g.add(box(0.115, 0.014, 0.02, dark, 0, -0.085, 0.44 + i * 0.04));
      addGrip(0.02, 0.34, 1.1);
      // Folding stock.
      g.add(box(0.06, 0.09, 0.26, dark, 0, -0.02, -0.16));
      g.add(box(0.09, 0.16, 0.06, grip, 0, -0.05, -0.3));
      g.add(box(0.05, 0.02, 0.24, steel, 0, 0.04, -0.16));
      // Shell loops on the receiver, each with a visible brass head.
      for (let i = 0; i < 4; i++) {
        const shell = cyl(0.022, 0.022, 0.055, 6, dark, -0.07, -0.02 - i * 0.05, 0.06);
        shell.rotation.x = Math.PI / 2;
        g.add(shell);
        const primer = cyl(0.019, 0.019, 0.012, 6, accent, -0.07, -0.02 - i * 0.05, 0.09);
        primer.rotation.x = Math.PI / 2;
        g.add(primer);
      }
      addIronSights(0.78, 0.06, 0.095, 1.15);
      addAction(0.16, 1.1);
      addSling(0.5, -0.22, 1.1);
      ventStack(g, dark, { pos: [0, 0.1, 0.5], count: 4, size: [0.13, 0.012, 0.04], spacing: 0.09 });
      boltRow(g, steel, { from: [0.062, 0.05, 0.05], to: [0.062, 0.05, 0.34], count: 4, r: 0.009 });
      muzzle.position.set(0, 0, 0.92);
      break;
    }
    case 'rifle': {
      g.add(box(0.095, 0.14, 0.58, body, 0, 0, 0.22));          // receiver
      g.add(box(0.1, 0.04, 0.6, dark, 0, 0.085, 0.22));
      addRail(0.2, 0.42, 0.108);
      addShroud(0.62, 0.44, 0.05, 6);
      // Coil emitter stack.
      for (let i = 0; i < 4; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.062 - i * 0.006, 0.016, 8, SEG.medium), accent);
        ring.rotation.y = Math.PI / 2;
        ring.rotation.x = Math.PI / 2;
        ring.position.set(0, 0, 0.78 + i * 0.07);
        g.add(ring);
      }
      g.add(cyl(0.028, 0.028, 0.34, 8, steel, 0, 0, 0.86));
      g.add(box(0.07, 0.2, 0.12, dark, 0, -0.16, 0.16));        // cell magazine
      g.add(box(0.05, 0.12, 0.07, accent, 0, -0.2, 0.16));
      addGrip(0.02, 0.3);
      addOptic(0.12);
      addIronSights(0.6, -0.02, 0.115);
      addAction(0.2);
      addSling(0.46, -0.3);
      addFlutes(0.86, 0.34, 0.028, 6);
      cableRun(g, dark, [0.05, -0.06, 0.1], [0.05, 0.02, 0.55], 0.05, 5, 0.012);
      ventStack(g, dark, { pos: [-0.052, 0.02, 0.3], count: 5, size: [0.012, 0.07, 0.03], spacing: 0.06 });
      // Skeleton stock.
      g.add(box(0.05, 0.075, 0.3, dark, 0, -0.01, -0.2));
      g.add(box(0.085, 0.19, 0.055, grip, 0, -0.05, -0.36));
      g.add(box(0.045, 0.02, 0.28, steel, 0, 0.06, -0.2));
      muzzle.position.set(0, 0, 1.06);
      break;
    }
    case 'smg': {
      g.add(box(0.1, 0.14, 0.42, body, 0, 0, 0.14));
      g.add(box(0.105, 0.035, 0.44, dark, 0, 0.085, 0.14));
      addRail(0.12, 0.3, 0.104);
      addShroud(0.42, 0.3, 0.042, 5);
      g.add(cyl(0.026, 0.03, 0.1, 8, steel, 0, 0, 0.6));
      // Ammo drum with a visible feed.
      const drum = cyl(0.1, 0.1, 0.07, 12, dark, 0, -0.16, 0.06);
      drum.rotation.x = Math.PI / 2;
      drum.rotation.z = Math.PI / 2;
      g.add(drum);
      g.add(cyl(0.055, 0.055, 0.08, 10, accent, 0, -0.16, 0.06));
      g.add(box(0.05, 0.12, 0.06, dark, 0, -0.1, 0.06));
      addGrip(-0.02, 0.26, 0.95);
      // Angled foregrip with finger stops.
      g.add(box(0.055, 0.16, 0.07, grip, 0, -0.14, 0.34));
      for (let i = 0; i < 3; i++) g.add(box(0.06, 0.012, 0.075, dark, 0, -0.09 - i * 0.045, 0.34));
      g.add(box(0.05, 0.06, 0.22, dark, 0, -0.02, -0.14));
      g.add(box(0.08, 0.14, 0.05, grip, 0, -0.04, -0.26));
      addIronSights(0.42, -0.02, 0.11, 0.95);
      addAction(0.1, 0.9);
      addSling(0.3, -0.2, 0.95);
      addFlutes(0.42, 0.24, 0.024, 5);
      ventStack(g, dark, { pos: [0, 0.095, 0.28], count: 4, size: [0.11, 0.012, 0.035], spacing: 0.07 });
      muzzle.position.set(0, 0, 0.66);
      break;
    }
    case 'launcher': {
      const tube = cyl(0.13, 0.13, 0.76, 12, body, 0, 0, 0.24);
      tube.rotation.x = Math.PI / 2;
      g.add(tube);
      for (const z of [0.0, 0.22, 0.44]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.02, 8, SEG.medium), dark);
        band.rotation.y = Math.PI / 2;
        band.rotation.x = Math.PI / 2;
        band.position.z = z;
        g.add(band);
      }
      const flare = cyl(0.19, 0.14, 0.16, 12, steel, 0, 0, 0.68);
      flare.rotation.x = Math.PI / 2;
      g.add(flare);
      const muzzleRing = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 8, SEG.medium), accent);
      muzzleRing.position.z = 0.7;
      g.add(muzzleRing);
      g.children[g.children.length - 1].rotation.y = Math.PI / 2;
      g.children[g.children.length - 1].rotation.x = Math.PI / 2;
      // Revolver cylinder of charges.
      const cylBlock = cyl(0.15, 0.15, 0.2, 6, dark, 0, -0.02, -0.1);
      cylBlock.rotation.x = Math.PI / 2;
      g.add(cylBlock);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const chg = cyl(0.035, 0.035, 0.21, 6, accent, Math.cos(a) * 0.095, -0.02 + Math.sin(a) * 0.095, -0.1);
        chg.rotation.x = Math.PI / 2;
        g.add(chg);
      }
      addGrip(-0.16, 0.28, 1.15);
      g.add(box(0.06, 0.14, 0.18, grip, 0, -0.16, 0.3));        // foregrip
      g.add(box(0.22, 0.09, 0.22, dark, 0, 0.16, -0.02));       // top carry handle
      for (const sx of [-1, 1]) g.add(box(0.03, 0.12, 0.05, dark, sx * 0.1, 0.1, -0.02));
      addOptic(0.1, 1.1);
      addSling(0.34, -0.24, 1.2);
      // Blast-shield vanes around the flare.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.add(box(0.03, 0.03, 0.13, dark, Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0.62));
      }
      cableRun(g, dark, [0.1, -0.12, -0.14], [0.1, 0.02, 0.3], 0.06, 5, 0.014);
      boltRow(g, steel, { from: [0, 0.135, -0.16], to: [0, 0.135, 0.12], count: 4, r: 0.01 });
      muzzle.position.set(0, 0, 0.8);
      break;
    }
    case 'beam': {
      g.add(box(0.14, 0.17, 0.52, body, 0, 0, 0.16));
      g.add(box(0.145, 0.045, 0.5, dark, 0, 0.1, 0.16));
      // Focusing prisms stepping down toward the emitter.
      for (let i = 0; i < 4; i++) {
        const r = 0.11 - i * 0.018;
        const prism = cyl(r, r + 0.012, 0.1, 6, i % 2 ? steel : body, 0, 0, 0.46 + i * 0.11);
        prism.rotation.x = Math.PI / 2;
        g.add(prism);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.014, 0.012, 8, SEG.medium), accent);
        ring.rotation.y = Math.PI / 2;
        ring.rotation.x = Math.PI / 2;
        ring.position.z = 0.51 + i * 0.11;
        g.add(ring);
      }
      // Side radiators.
      for (const sx of [-1, 1]) {
        g.add(box(0.035, 0.15, 0.36, dark, sx * 0.1, 0.02, 0.2));
        for (let i = 0; i < 5; i++) {
          g.add(box(0.05, 0.13, 0.016, accent, sx * 0.11, 0.02, 0.08 + i * 0.075));
        }
      }
      // Coolant tank.
      const tank = cyl(0.07, 0.07, 0.24, 10, dark, 0, -0.14, 0.02);
      tank.rotation.z = Math.PI / 2;
      g.add(tank);
      const coolant = cyl(0.045, 0.045, 0.26, 8, glass, 0, -0.14, 0.02);
      coolant.rotation.z = Math.PI / 2;
      g.add(coolant);
      addGrip(-0.04, 0.3, 1.05);
      addOptic(0.08);
      addSling(0.34, -0.16, 1.05);
      // Capacitor bank down the spine, and coolant lines to the radiators.
      for (let i = 0; i < 4; i++) {
        const cap = cyl(0.032, 0.032, 0.13, 8, dark, 0, 0.13, -0.02 + i * 0.11);
        cap.rotation.z = Math.PI / 2;
        g.add(cap);
        const band = cyl(0.036, 0.036, 0.02, 8, accent, 0, 0.13, 0.04 + i * 0.11);
        band.rotation.z = Math.PI / 2;
        g.add(band);
      }
      for (const sx of [-1, 1]) {
        cableRun(g, dark, [sx * 0.07, -0.12, 0.0], [sx * 0.11, 0.02, 0.3], 0.05, 5, 0.013);
      }
      boltRow(g, steel, { from: [0, -0.085, 0.0], to: [0, -0.085, 0.3], count: 4, r: 0.009 });
      muzzle.position.set(0, 0, 0.92);
      break;
    }
    case 'gauntlet': {
      /*
       * Not a gun: a demolition driver worn on the hand.
       *
       * The mount sits at the wrist and the weapon has to read as an extension
       * of the fist rather than as something held, so the mass is packed tight
       * around the origin and the only thing sticking out along +Z is the
       * compression port the shockwave leaves through.
       */
      const plateMat = mat(0x3b414d, { roughness: 0.42, metalness: 0.8 });
      const hot = mat(weapon.color, {
        emissive: weapon.color, emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.5,
      });

      // Forearm sleeve, tapering toward the wrist.
      const sleeve = cyl(0.11, 0.135, 0.34, 8, plateMat, 0, 0, -0.2);
      sleeve.rotation.x = Math.PI / 2;
      g.add(sleeve);
      for (let i = 0; i < 3; i++) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.014, 8, SEG.medium), steel);
        band.position.z = -0.32 + i * 0.1;
        g.add(band);
      }

      // Knuckle block and four knuckles, each with a lit vent behind it.
      g.add(box(0.22, 0.15, 0.16, plateMat, 0, 0, 0.05));
      for (let k = 0; k < 4; k++) {
        const x = (k - 1.5) * 0.055;
        g.add(sphere(0.032, steel, x, 0.03, 0.13, 6));
        g.add(box(0.03, 0.02, 0.05, hot, x, -0.03, 0.1));
      }

      // Compression port: the ring the wave actually leaves through.
      const port = cyl(0.085, 0.105, 0.09, 10, plateMat, 0, 0, 0.16);
      port.rotation.x = Math.PI / 2;
      g.add(port);
      const iris = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 8, SEG.medium), hot);
      iris.position.z = 0.2;
      g.add(iris);

      // Piston pack on top of the forearm, and the pressure bottle under it.
      for (const sx of [-1, 1]) {
        const piston = cyl(0.026, 0.026, 0.28, 6, steel, sx * 0.075, 0.09, -0.16);
        piston.rotation.x = Math.PI / 2;
        g.add(piston);
        const cap = sphere(0.032, accent, sx * 0.075, 0.09, -0.02, 6);
        g.add(cap);
      }
      const bottle = cyl(0.05, 0.05, 0.22, 8, dark, 0, -0.1, -0.18);
      bottle.rotation.x = Math.PI / 2;
      g.add(bottle);
      g.add(box(0.04, 0.03, 0.04, hot, 0, -0.1, -0.06));

      // Vent slots down both sides — the jet boost has to come out somewhere.
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          g.add(box(0.012, 0.05, 0.03, hot, sx * 0.115, -0.03, -0.1 + i * 0.07));
        }
      }

      muzzle.position.set(0, 0, 0.28);
      break;
    }
    case 'sniper': {
      // A long bolt gun: heavy receiver, free-floated fluted barrel, a real
      // tube optic sat high on rings, and a bipod folded under the handguard.
      g.add(box(0.1, 0.15, 0.66, body, 0, 0, 0.26));            // receiver
      g.add(box(0.105, 0.045, 0.68, dark, 0, 0.09, 0.26));      // top flat
      addRail(0.24, 0.5, 0.115);
      // Free-floated barrel: a heavy contour that steps down to the brake.
      g.add(cyl(0.045, 0.052, 0.62, 10, steel, 0, 0, 0.9));
      addFlutes(0.9, 0.62, 0.045, 8);
      g.add(cyl(0.038, 0.045, 0.16, 10, dark, 0, 0, 1.27));     // muzzle brake body
      for (let i = 0; i < 3; i++) {
        g.add(box(0.09, 0.016, 0.028, dark, 0, 0, 1.22 + i * 0.05));   // brake ports
      }
      g.add(box(0.052, 0.052, 0.05, accent, 0, 0, 1.33));

      // Tube optic on two rings, with a lit objective at the far end.
      for (const z of [0.16, 0.46]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 8, SEG.medium), steel);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(0, 0.19, z);
        g.add(ring);
        g.add(box(0.045, 0.06, 0.03, dark, 0, 0.14, z));
      }
      const tube = cyl(0.042, 0.042, 0.5, 12, dark, 0, 0.19, 0.32);
      tube.rotation.x = Math.PI / 2;
      g.add(tube);
      const bell = cyl(0.056, 0.042, 0.11, 12, body, 0, 0.19, 0.6);
      bell.rotation.x = Math.PI / 2;
      g.add(bell);
      const objective = new THREE.Mesh(new THREE.CircleGeometry(0.05, 12), glass);
      objective.position.set(0, 0.19, 0.657);
      g.add(objective);
      // Elevation and windage turrets — the detail that says "optic", not "box".
      const elev = cyl(0.028, 0.03, 0.05, 8, steel, 0, 0.245, 0.34);
      g.add(elev);
      const wind = cyl(0.026, 0.028, 0.045, 8, steel, 0.055, 0.19, 0.34);
      wind.rotation.z = Math.PI / 2;
      g.add(wind);

      // Bipod, folded back along the handguard.
      for (const sx of [-1, 1]) {
        const leg = cyl(0.011, 0.014, 0.3, 5, dark, sx * 0.035, -0.09, 0.72);
        leg.rotation.set(-0.9, 0, sx * 0.24);
        g.add(leg);
        g.add(box(0.03, 0.014, 0.03, steel, sx * 0.05, -0.2, 0.62));
      }
      g.add(box(0.075, 0.05, 0.1, dark, 0, -0.075, 0.74));      // bipod mount

      g.add(box(0.08, 0.22, 0.11, dark, 0, -0.17, 0.14));       // box magazine
      g.add(box(0.06, 0.03, 0.09, steel, 0, -0.285, 0.14));
      addGrip(-0.04, 0.34, 1.05);
      addIronSights(1.05, -0.1, 0.1, 0.85);
      addAction(0.22, 1.1);
      addSling(0.72, -0.34, 1.1);
      // Bolt handle: the thing the reload minigame is actually working.
      const bolt = cyl(0.017, 0.017, 0.13, 6, steel, 0.075, 0.035, 0.06);
      bolt.rotation.z = Math.PI / 2 - 0.35;
      g.add(bolt);
      g.add(sphere(0.028, steel, 0.13, 0.01, 0.06, 8));
      // Adjustable stock with a cheek riser and a monopod spike.
      g.add(box(0.055, 0.1, 0.34, dark, 0, -0.015, -0.24));
      g.add(box(0.075, 0.05, 0.24, body, 0, 0.065, -0.24));     // cheek riser
      g.add(box(0.095, 0.21, 0.06, grip, 0, -0.05, -0.44));     // butt pad
      g.add(box(0.05, 0.02, 0.3, steel, 0, 0.075, -0.24));
      g.add(box(0.03, 0.09, 0.03, steel, 0, -0.16, -0.42));     // monopod
      panelLine(g, dark, { pos: [0, -0.082, 0.34], size: [0.07, 0.008, 0.36] });
      boltRow(g, steel, { from: [0.052, -0.05, 0.02], to: [0.052, -0.05, 0.44], count: 4, r: 0.009 });
      muzzle.position.set(0, 0, 1.4);
      break;
    }
    case 'scythe':
    case 'voidblade': {
      /*
       * A straight two-handed blade.
       *
       * It used to be a crescent on the end of a pole, which from behind the
       * shoulder read as an axe — a heavy head swinging off-centre, nothing
       * about it saying "sword". This is built the other way round: the mass
       * runs down the centreline, the silhouette is one long edge, and the void
       * light lives in the fuller so the blade reads dark with a lit spine
       * rather than as a glowing slab.
       */
      const bladeMat = mat(0x2a2333, { roughness: 0.26, metalness: 0.92 });
      const edgeMat = mat(weapon.color, {
        emissive: weapon.color, emissiveIntensity: 1.5, roughness: 0.2, metalness: 0.7,
      });

      // --- Grip: wrapped, two-handed, with a heavy pommel. ---
      const handle = cyl(0.036, 0.042, 0.46, 8, grip, 0, 0, -0.3);
      handle.rotation.x = Math.PI / 2;
      g.add(handle);
      for (let i = 0; i < 6; i++) {
        const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.043, 0.009, 8, SEG.medium), dark);
        wrap.rotation.y = Math.PI / 2;
        wrap.rotation.x = Math.PI / 2;
        wrap.position.z = -0.49 + i * 0.075;
        g.add(wrap);
      }
      const pommel = new THREE.Mesh(new THREE.OctahedronGeometry(0.062, 0), steel);
      pommel.position.z = -0.56;
      g.add(pommel);
      g.add(sphere(0.028, accent, 0, 0, -0.56, 8));

      // --- Crossguard: a swept bar, thickest at the centre. ---
      g.add(box(0.34, 0.05, 0.09, steel, 0, 0, -0.04));
      g.add(box(0.1, 0.075, 0.13, steel, 0, 0, -0.04));
      for (const sx of [-1, 1]) {
        const guardTip = box(0.07, 0.045, 0.075, steel, sx * 0.185, 0, -0.015);
        guardTip.rotation.y = sx * 0.5;
        g.add(guardTip);
        // `Object3D.add` returns the PARENT — position the mesh before adding it.
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.026, 0), accent);
        gem.position.set(sx * 0.215, 0, 0.005);
        g.add(gem);
      }
      // Ricasso, where the edge has not started yet.
      g.add(box(0.075, 0.032, 0.13, bladeMat, 0, 0, 0.07));

      // --- Blade: four segments narrowing along its length, then a point. ---
      const bladeLen = 1.5;
      const segs = 4;
      let z = 0.13;
      for (let i = 0; i < segs; i++) {
        const t = i / segs;
        const len = bladeLen / segs;
        const w = 0.15 - t * 0.045;
        const th = 0.036 - t * 0.008;
        g.add(box(w, th, len, bladeMat, 0, 0, z + len / 2));
        // Fuller: the lit groove down the centre of each face.
        g.add(box(w * 0.34, th * 1.12, len * 0.94, edgeMat, 0, 0, z + len / 2));
        z += len;
      }
      // Point: a four-sided taper, so the tip is a tip and not a cut-off box.
      const point = cyl(0.0, 0.075, 0.3, 4, bladeMat, 0, 0, z + 0.15);
      point.rotation.set(Math.PI / 2, Math.PI / 4, 0);
      g.add(point);
      const spark = new THREE.Mesh(new THREE.OctahedronGeometry(0.03, 0), edgeMat);
      spark.position.z = z + 0.05;
      g.add(spark);

      // Void bleeding off the edges — small, and only along the blade.
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const zz = 0.35 + i * 0.42;
          g.add(box(0.012, 0.02, 0.26, edgeMat, sx * 0.068, 0, zz));
        }
      }
      muzzle.position.set(0, 0, bladeLen + 0.4);
      break;
    }
    default:
      g.add(box(0.12, 0.12, 0.5, body, 0, 0, 0.16));
      muzzle.position.set(0, 0, 0.42);
  }

  g.add(muzzle);
  g.userData.muzzle = muzzle;
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.055, SEG.small, SEG.small * 0.7), glowMat(weapon.color, 0.7));
  glow.position.copy(muzzle.position);
  g.add(glow);
  g.userData.glow = glow;
  g.traverse((c) => { if (c.isMesh) c.castShadow = true; });
  return mergeStaticMeshes(g);
}

/* ==========================================================================
   ENEMIES
   ========================================================================== */
/** Overlapping carapace plates along an axis — cheap silhouette detail. */
function addPlates(parent, count, material, { radius, from, to, width = 0.8, thick = 0.06, curve = 0 }) {
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    const y = from + (to - from) * t;
    const r = radius * (1 - Math.abs(t - 0.5) * 0.35);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.92, thick, 8), material);
    plate.scale.z = width;
    plate.position.set(0, y, curve * Math.sin(t * Math.PI) * radius * 0.3);
    plate.rotation.x = curve * 0.2;
    plate.castShadow = true;
    parent.add(plate);
  }
}

/** A row of spines along the back. */
function addSpines(parent, count, material, { from, to, size, z = 0, lean = -0.45 }) {
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    const sc = size * (0.5 + Math.sin(t * Math.PI) * 0.75);
    const spike = new THREE.Mesh(new THREE.ConeGeometry(sc * 0.3, sc, 5), material);
    spike.position.set(0, from + (to - from) * t, z);
    spike.rotation.x = lean;
    spike.castShadow = true;
    parent.add(spike);
  }
}

/** Glowing seams that read as something alive inside the shell. */
function addSeams(parent, material, { count = 3, radius, y, spread = 0.3 }) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const seam = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.12, spread, radius * 0.12), material);
    seam.position.set(Math.cos(a) * radius, y, Math.sin(a) * radius);
    parent.add(seam);
  }
}

/** Small asymmetric growths so no two enemies read as mirrored. */
function addGrowths(parent, rng, count, material, scale) {
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const r = scale * (0.5 + rng() * 0.6);
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(scale * (0.14 + rng() * 0.16), 0), material);
    blob.position.set(Math.cos(a) * r, scale * (rng() * 1.4), Math.sin(a) * r * 0.7);
    blob.castShadow = true;
    parent.add(blob);
  }
}

export function buildEnemyModel(def) {
  const g = new THREE.Group();
  const base = mat(def.color, { roughness: 0.75, metalness: 0.15, flat: true });
  const accent = mat(def.accent, { emissive: def.accent, emissiveIntensity: 1.4, roughness: 0.4 });
  const dark = mat(0x1a1a22, { roughness: 0.9, metalness: 0.1 });
  const parts = {};

  switch (def.model) {
    case 'husk': {
      const torso = new THREE.Group();
      torso.position.y = 1.16;
      g.add(torso);
      const ribcage = cyl(0.3, 0.24, 0.78, 8, base, 0, 0, 0);
      ribcage.scale.z = 0.72;
      torso.add(ribcage);
      const chest = cyl(0.32, 0.28, 0.3, 8, base, 0, 0.24, 0);
      chest.scale.z = 0.78;
      torso.add(chest);
      // Exposed ribs give the husk its sunken, wrong silhouette.
      for (let i = 0; i < 3; i++) {
        const rib = new THREE.Mesh(new THREE.TorusGeometry(0.22 - i * 0.02, 0.022, 4, 8, Math.PI), accent);
        rib.rotation.set(Math.PI / 2, 0, 0);
        rib.position.y = -0.05 - i * 0.13;
        torso.add(rib);
      }
      const head = sphere(0.19, base, 0, 0.52, 0.02, 8);
      head.scale.set(1, 1.1, 1.05);
      torso.add(head);
      const jaw = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.2, 6), base);
      jaw.rotation.x = Math.PI * 0.52;
      jaw.position.set(0, 0.45, 0.16);
      torso.add(jaw);
      const eye = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.032, 4, 10, Math.PI), accent);
      eye.rotation.set(Math.PI / 2, 0, Math.PI);
      eye.position.set(0, 0.55, 0.14);
      torso.add(eye);
      addPlates(torso, 4, dark, { radius: 0.27, from: -0.3, to: 0.16, width: 0.7, thick: 0.05, curve: 0.4 });
      addSpines(torso, 5, accent, { from: -0.25, to: 0.3, size: 0.16, z: -0.2 });
      addSeams(torso, accent, { count: 4, radius: 0.25, y: 0.05, spread: 0.22 });
      addGrowths(torso, mulberryLite(3), 4, dark, 0.3);
      parts.armL = pivotLimb(g, -0.4, 1.5, 0, [0.17, 0.66, 0.17], base, accent);
      parts.armR = pivotLimb(g, 0.4, 1.5, 0, [0.17, 0.66, 0.17], base, accent);
      parts.legL = pivotLimb(g, -0.17, 0.8, 0, [0.19, 0.8, 0.19], dark);
      parts.legR = pivotLimb(g, 0.17, 0.8, 0, [0.19, 0.8, 0.19], dark);
      parts.torso = torso;
      break;
    }
    case 'spitter': {
      const torso = sphere(0.46, base, 0, 1.02, 0, 10);
      torso.scale.set(1, 0.9, 1.1);
      g.add(torso);
      g.add(sphere(0.26, base, 0, 1.42, 0.1, 8));
      g.add(box(0.3, 0.1, 0.08, accent, 0, 1.46, 0.24));
      // Pressurised sacs on the back, with feed tubes into the body.
      for (const s of [-1, 1]) {
        const sac = sphere(0.19, accent, s * 0.27, 1.16, -0.3, 8);
        sac.scale.set(1, 0.85, 1.1);
        g.add(sac);
        const tube = cyl(0.05, 0.05, 0.28, 6, dark, s * 0.16, 1.1, -0.18);
        tube.rotation.z = s * 0.7;
        g.add(tube);
        g.add(sphere(0.07, dark, s * 0.27, 1.34, -0.3, 6));
      }
      addPlates(torso, 3, dark, { radius: 0.4, from: -0.24, to: 0.2, width: 1.05, thick: 0.06 });
      addSpines(torso, 4, accent, { from: -0.1, to: 0.26, size: 0.13, z: -0.34, lean: -0.9 });
      // Mandibles around the mouth.
      for (const s of [-1, 1]) {
        const mand = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 5), dark);
        mand.position.set(s * 0.12, 1.36, 0.28);
        mand.rotation.set(1.5, 0, s * 0.5);
        g.add(mand);
      }
      parts.legL = pivotLimb(g, -0.24, 0.7, 0, [0.16, 0.7, 0.16], dark, accent);
      parts.legR = pivotLimb(g, 0.24, 0.7, 0, [0.16, 0.7, 0.16], dark, accent);
      parts.torso = torso;
      break;
    }
    case 'skimmer': {
      const core = sphere(0.4, base, 0, 0.6, 0, 10);
      core.scale.set(1.3, 0.7, 1);
      g.add(core);
      g.add(sphere(0.19, accent, 0, 0.6, 0.34, 8));
      for (const s of [-1, 1]) {
        const wing = box(0.62, 0.06, 0.3, base, s * 0.6, 0.66, -0.06);
        wing.rotation.z = s * 0.3;
        g.add(wing);
        // Engine nacelle with an intake ring and exhaust glow.
        const nac = cyl(0.1, 0.12, 0.34, 8, dark, s * 0.82, 0.7, -0.06);
        nac.rotation.x = Math.PI / 2;
        g.add(nac);
        const intake = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.026, 4, 10), accent);
        intake.rotation.y = Math.PI / 2;
        intake.position.set(s * 0.82, 0.7, 0.1);
        g.add(intake);
        g.add(sphere(0.07, accent, s * 0.82, 0.7, -0.24, 6));
        // Wing struts.
        const strut = box(0.34, 0.035, 0.035, dark, s * 0.42, 0.62, 0.06);
        strut.rotation.z = s * 0.3;
        g.add(strut);
      }
      // Tail fins.
      for (const s of [-1, 1]) {
        const fin = box(0.05, 0.26, 0.2, base, s * 0.16, 0.76, -0.34);
        fin.rotation.z = s * 0.35;
        g.add(fin);
      }
      addPlates(core, 3, dark, { radius: 0.34, from: -0.1, to: 0.12, width: 1.3, thick: 0.05 });
      g.add(sphere(0.1, accent, 0, 0.45, 0.2, 7));
      parts.core = core;
      parts.hover = true;
      break;
    }
    case 'charger': {
      const torso = new THREE.Group();
      torso.position.y = 1.14;
      g.add(torso);
      const body = cyl(0.42, 0.36, 1.0, 8, base, 0, 0, 0);
      body.rotation.x = Math.PI / 2;
      body.scale.z = 0.72;
      torso.add(body);
      const hump = sphere(0.36, base, 0, 0.16, -0.16, 8);
      hump.scale.set(1.1, 0.8, 1.2);
      torso.add(hump);
      const headG = new THREE.Group();
      headG.position.set(0, 1.2, 0.62);
      const skull = sphere(0.24, base, 0, 0, 0, 8);
      skull.scale.set(1.05, 0.9, 1.2);
      headG.add(skull);
      const plate = new THREE.Mesh(new THREE.ConeGeometry(0.27, 0.34, 6), base);
      plate.rotation.x = -Math.PI / 2.1;
      plate.position.set(0, 0.1, 0.16);
      headG.add(plate);
      headG.add(box(0.3, 0.08, 0.07, accent, 0, 0.02, 0.24));
      for (const s of [-1, 1]) {
        const horn = cyl(0.02, 0.09, 0.5, 6, accent, s * 0.2, 0.3, 0.1);
        horn.rotation.x = -0.5;
        headG.add(horn);
      }
      // Jaw and tusks.
      for (const sx of [-1, 1]) {
        const tusk = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.26, 5), accent);
        tusk.position.set(sx * 0.14, -0.1, 0.28);
        tusk.rotation.set(-1.2, 0, sx * 0.3);
        headG.add(tusk);
      }
      headG.add(box(0.3, 0.1, 0.28, dark, 0, -0.14, 0.14));
      g.add(headG);
      parts.head = headG;
      addPlates(torso, 4, dark, { radius: 0.44, from: -0.24, to: 0.24, width: 1.5, thick: 0.07 });
      addSpines(torso, 6, accent, { from: -0.3, to: 0.34, size: 0.17, z: -0.3, lean: -0.7 });
      addSeams(torso, accent, { count: 4, radius: 0.38, y: 0, spread: 0.26 });
      parts.legL = pivotLimb(g, -0.3, 0.82, 0.3, [0.2, 0.82, 0.2], dark);
      parts.legR = pivotLimb(g, 0.3, 0.82, 0.3, [0.2, 0.82, 0.2], dark);
      parts.legBL = pivotLimb(g, -0.3, 0.82, -0.34, [0.2, 0.82, 0.2], dark);
      parts.legBR = pivotLimb(g, 0.3, 0.82, -0.34, [0.2, 0.82, 0.2], dark);
      parts.torso = torso;
      break;
    }
    case 'brute': {
      const torso = new THREE.Group();
      torso.position.y = 1.86;
      g.add(torso);
      const barrel = cyl(0.68, 0.56, 1.3, 9, base, 0, 0, 0);
      barrel.scale.z = 0.72;
      torso.add(barrel);
      const gut = sphere(0.56, base, 0, -0.4, 0.08, 9);
      gut.scale.set(1.05, 0.78, 0.9);
      torso.add(gut);
      const head = sphere(0.3, base, 0, 0.78, 0.06, 9);
      head.scale.set(1.05, 0.95, 1.05);
      torso.add(head);
      const brow = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.05, 4, 10, Math.PI), accent);
      brow.rotation.set(Math.PI / 2, 0, Math.PI);
      brow.position.set(0, 0.82, 0.2);
      torso.add(brow);
      const yoke = cyl(0.78, 0.74, 0.32, 9, dark, 0, 0.58, 0);
      yoke.scale.z = 0.8;
      torso.add(yoke);
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const spike = new THREE.Mesh(new THREE.ConeGeometry(0.11 - i * 0.015, 0.4 - i * 0.06, 5), accent);
          spike.position.set(sx * (0.5 + i * 0.16), 0.72 - i * 0.06, -0.1 + i * 0.12);
          spike.rotation.z = sx * (0.4 + i * 0.15);
          torso.add(spike);
        }
        // Layered shoulder pauldron.
        const pauld = new THREE.Mesh(
          new THREE.SphereGeometry(0.42, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), dark);
        pauld.position.set(sx * 0.72, 0.5, 0);
        pauld.rotation.z = sx * 0.4;
        pauld.castShadow = true;
        torso.add(pauld);
      }
      addPlates(torso, 4, dark, { radius: 0.6, from: -0.5, to: 0.3, width: 0.8, thick: 0.08 });
      addSeams(torso, accent, { count: 5, radius: 0.55, y: 0.1, spread: 0.3 });
      addGrowths(torso, mulberryLite(11), 5, dark, 0.6);
      parts.armL = pivotLimb(g, -0.88, 2.4, 0, [0.34, 1.35, 0.34], base, accent);
      parts.armR = pivotLimb(g, 0.88, 2.4, 0, [0.34, 1.35, 0.34], base, accent);
      parts.legL = pivotLimb(g, -0.34, 1.2, 0, [0.34, 1.2, 0.34], dark);
      parts.legR = pivotLimb(g, 0.34, 1.2, 0, [0.34, 1.2, 0.34], dark);
      parts.torso = torso;
      break;
    }
    case 'warden': {
      const torso = cyl(0.42, 0.6, 1.3, 8, base, 0, 1.5, 0);
      g.add(torso);
      g.add(sphere(0.34, base, 0, 2.26, 0, 10));
      g.add(sphere(0.18, accent, 0, 2.26, 0.24, 8));
      // Floating shoulder cannons
      for (const s of [-1, 1]) {
        const arm = new THREE.Group();
        arm.position.set(s * 0.66, 1.92, 0);
        arm.add(box(0.24, 0.24, 0.7, base, 0, 0, 0.1));
        arm.add(cyl(0.09, 0.09, 0.2, 6, accent, 0, 0, 0.44));
        g.add(arm);
        parts[s < 0 ? 'cannonL' : 'cannonR'] = arm;
      }
      g.add(cyl(0.5, 0.2, 0.6, 8, dark, 0, 0.5, 0));
      parts.torso = torso;
      parts.hover = true;
      parts.hoverBase = 0.35;
      break;
    }
    case 'lancer': {
      const core = new THREE.Group();
      core.position.y = 1.4;
      g.add(core);
      const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), base);
      shard.scale.set(0.8, 1.6, 0.8);
      shard.castShadow = true;
      core.add(shard);
      core.add(sphere(0.2, accent, 0, 0, 0.3, 8));
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const blade = box(0.1, 0.7, 0.1, accent, Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55);
        blade.rotation.z = Math.cos(a) * 0.5;
        core.add(blade);
      }
      parts.core = core;
      parts.hover = true;
      break;
    }
    case 'colossus': {
      const torso = new THREE.Group();
      torso.position.y = 3.6;
      g.add(torso);
      const chest = cyl(1.34, 1.1, 2.4, 9, base, 0, 0, 0);
      chest.scale.z = 0.78;
      torso.add(chest);
      const shoulderMass = sphere(1.2, base, 0, 0.9, 0, 9);
      shoulderMass.scale.set(1.25, 0.62, 0.9);
      torso.add(shoulderMass);
      const head = sphere(0.6, base, 0, 1.72, 0.12, 9);
      head.scale.set(1, 0.92, 1.05);
      torso.add(head);
      const crown = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.1, 5, 12, Math.PI), accent);
      crown.rotation.set(Math.PI / 2, 0, Math.PI);
      crown.position.set(0, 1.8, 0.34);
      torso.add(crown);
      const yoke = cyl(1.62, 1.5, 0.6, 9, dark, 0, 1.1, 0);
      yoke.scale.z = 0.86;
      torso.add(yoke);
      for (const s of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const spike = cyl(0.05, 0.22, 0.9, 5, accent, s * (0.7 + i * 0.5), 5.1, -0.6);
          spike.rotation.x = -0.4;
          g.add(spike);
        }
      }
      parts.armL = pivotLimb(g, -1.7, 4.5, 0, [0.7, 2.6, 0.7], base, accent);
      parts.armR = pivotLimb(g, 1.7, 4.5, 0, [0.7, 2.6, 0.7], base, accent);
      parts.legL = pivotLimb(g, -0.72, 2.4, 0, [0.72, 2.4, 0.72], dark);
      parts.legR = pivotLimb(g, 0.72, 2.4, 0, [0.72, 2.4, 0.72], dark);
      parts.torso = torso;
      break;
    }
    case 'leviathan': {
      const core = new THREE.Group();
      core.position.y = 2.2;
      g.add(core);
      const body = cyl(0.5, 1.1, 3.2, 8, base);
      body.rotation.x = Math.PI / 2;
      body.castShadow = true;
      core.add(body);
      core.add(sphere(0.55, accent, 0, 0, 1.5, 10));
      for (const s of [-1, 1]) {
        const fin = box(2.4, 0.14, 1.0, base, s * 1.4, 0.1, -0.3);
        fin.rotation.z = s * 0.24;
        core.add(fin);
        core.add(box(0.5, 0.1, 0.4, accent, s * 2.3, 0.16, -0.3));
      }
      const tail = box(0.5, 0.9, 1.2, base, 0, 0, -2.0);
      core.add(tail);
      parts.core = core;
      parts.tail = tail;
      parts.hover = true;
      break;
    }
    case 'thornmaw': {
      /* A jaw on the end of a stalk, and the stalk goes back into the ground.
         Built leaning, because a thing that erupts does not come up straight —
         the lean is most of what says "this was underground a second ago". */
      const stalk = new THREE.Group();
      stalk.position.y = 0.1;
      stalk.rotation.x = -0.16;
      g.add(stalk);

      const SEGS = 6;
      let node = stalk;
      const rings = [];
      for (let i = 0; i < SEGS; i++) {
        const t = i / (SEGS - 1);
        const r = 1.05 - t * 0.42;
        const seg = new THREE.Group();
        seg.position.y = i === 0 ? 0.4 : 0.62;
        const body = cyl(r * 0.92, r, 0.68, 8, base, 0, 0, 0);
        body.castShadow = true;
        seg.add(body);
        // A collar of husk plates at each joint, flaring outward.
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + i * 0.4;
          const plate = box(r * 0.42, 0.12, r * 0.5, dark,
            Math.cos(a) * r * 0.95, -0.24, Math.sin(a) * r * 0.95);
          plate.rotation.y = -a;
          plate.rotation.x = -0.5;
          seg.add(plate);
        }
        node.add(seg);
        rings.push(seg);
        node = seg;
      }

      // The maw: four petal jaws round a throat, on the last segment.
      const maw = new THREE.Group();
      maw.position.y = 0.5;
      node.add(maw);
      const throat = cyl(0.34, 0.5, 0.5, 8, accent, 0, 0.1, 0);
      maw.add(throat);
      const petals = [];
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const petal = new THREE.Group();
        petal.position.set(Math.cos(a) * 0.34, 0.16, Math.sin(a) * 0.34);
        petal.rotation.y = -a;
        petal.rotation.x = -0.5;
        const blade = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.5, 4), base);
        blade.position.y = 0.72;
        blade.scale.z = 0.55;
        blade.castShadow = true;
        petal.add(blade);
        for (let t = 0; t < 4; t++) {
          const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 4), accent);
          tooth.position.set((t - 1.5) * 0.16, 0.24, 0.2);
          tooth.rotation.x = 1.5;
          petal.add(tooth);
        }
        maw.add(petal);
        petals.push(petal);
      }
      // Root tendrils splayed round the base, so it reads as anchored.
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        const root = cyl(0.06, 0.3, 2.2, 5, dark, Math.cos(a) * 1.1, 0.5, Math.sin(a) * 1.1);
        root.rotation.z = -Math.cos(a) * 0.9;
        root.rotation.x = Math.sin(a) * 0.9;
        root.castShadow = true;
        g.add(root);
      }
      parts.torso = stalk;
      parts.stalkSegments = rings;
      parts.maw = maw;
      parts.petals = petals;
      break;
    }

    case 'fulgurant': {
      /* No body — a suspended core inside two counter-turning rings, with coil
         arms hanging beneath it. Nothing about it should read as anatomy; it is
         a machine for putting lightning somewhere. */
      const core = new THREE.Group();
      core.position.y = 2.6;
      g.add(core);

      const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.86, 1), base);
      shell.castShadow = true;
      core.add(shell);
      const heart = new THREE.Mesh(new THREE.IcosahedronGeometry(0.56, 1), accent);
      core.add(heart);

      const ringA = new THREE.Group();
      const ringB = new THREE.Group();
      core.add(ringA, ringB);
      const bigRing = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.1, 5, 22), dark);
      bigRing.rotation.x = Math.PI / 2;
      ringA.add(bigRing);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const node = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), accent);
        node.position.set(Math.cos(a) * 1.7, 0, Math.sin(a) * 1.7);
        ringA.add(node);
      }
      const midRing = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.075, 5, 18), dark);
      midRing.rotation.set(Math.PI / 2, 0, 0.9);
      ringB.add(midRing);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const shard = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.7, 4), accent);
        shard.position.set(Math.cos(a) * 1.2, Math.sin(a) * 0.9, Math.sin(a) * 1.2);
        shard.rotation.z = a;
        ringB.add(shard);
      }

      // Coil arms: three tapering rods hanging under the core, tipped with emitters.
      const arms = [];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const arm = new THREE.Group();
        arm.position.set(Math.cos(a) * 0.7, -0.5, Math.sin(a) * 0.7);
        const rod = cyl(0.11, 0.05, 1.7, 6, dark, 0, -0.85, 0);
        rod.castShadow = true;
        arm.add(rod);
        for (let c = 0; c < 3; c++) {
          const coil = new THREE.Mesh(new THREE.TorusGeometry(0.15 - c * 0.02, 0.03, 4, 10), accent);
          coil.rotation.x = Math.PI / 2;
          coil.position.y = -0.45 - c * 0.42;
          arm.add(coil);
        }
        const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), accent);
        tip.position.y = -1.78;
        arm.add(tip);
        core.add(arm);
        arms.push(arm);
      }

      parts.torso = core;
      parts.ringA = ringA;
      parts.ringB = ringB;
      parts.arms = arms;
      parts.heart = heart;
      break;
    }

    case 'choir': {
      /* A bell of bone with nothing under it, ringed by lanterns.
         The lanterns are the health bar you are supposed to be reading: one per
         chorister still standing, and the AI lights them. */
      const bell = new THREE.Group();
      bell.position.y = 2.3;
      g.add(bell);

      const robe = cyl(1.32, 0.42, 3.0, 9, base, 0, -0.4, 0);
      robe.castShadow = true;
      bell.add(robe);
      for (let i = 0; i < 5; i++) {
        const fold = cyl(1.34 - i * 0.06, 1.2 - i * 0.06, 0.16, 9, dark, 0, -1.5 + i * 0.36, 0);
        bell.add(fold);
      }
      // Hood and the dark under it.
      const hood = new THREE.Mesh(
        new THREE.SphereGeometry(0.72, 9, 7, 0, Math.PI * 2, 0, Math.PI * 0.62), base);
      hood.position.y = 0.95;
      hood.castShadow = true;
      bell.add(hood);
      bell.add(sphere(0.5, dark, 0, 0.8, 0.06, 8));
      for (const sx of [-1, 1]) {
        bell.add(sphere(0.11, accent, sx * 0.2, 0.86, 0.42, 6));
      }
      // A rib cage worn over the front.
      addPlates(bell, 5, dark, { radius: 0.95, from: -0.9, to: 0.5, width: 0.9, thick: 0.09 });

      // Conductor's arms — long, thin, and always raised.
      const arms = [];
      for (const sx of [-1, 1]) {
        const arm = pivotLimb(bell, sx * 1.15, 0.5, 0, [0.26, 1.9, 0.26], base, accent);
        arm.rotation.z = sx * 0.9;
        arm.rotation.x = -0.5;
        arms.push(arm);
      }

      // Lantern ring: six skull lamps orbiting the hem.
      const lanterns = [];
      const lanternRing = new THREE.Group();
      lanternRing.position.y = 1.4;
      g.add(lanternRing);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const lantern = new THREE.Group();
        lantern.position.set(Math.cos(a) * 2.2, 0, Math.sin(a) * 2.2);
        const cage = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), dark);
        lantern.add(cage);
        const flame = new THREE.Mesh(new THREE.SphereGeometry(0.17, 7, 6), glowMat(def.accent, 0.9));
        lantern.add(flame);
        lantern.userData.flame = flame;
        lanternRing.add(lantern);
        lanterns.push(lantern);
      }

      parts.torso = bell;
      parts.armL = arms[0];
      parts.armR = arms[1];
      parts.lanternRing = lanternRing;
      parts.lanterns = lanterns;
      break;
    }

    case 'sovereign': {
      /* The Null Sovereign. Nothing else in the game floats a mask over a
         hollow frame, so the silhouette is unmistakable the moment the rift
         closes behind you: a crown of shards, a mask with no face, and a
         tattered column of nothing where a body should be. */
      const core = new THREE.Group();
      core.position.y = 3.4;
      g.add(core);

      // Hollow frame: two shells with a gap you can see the glow through.
      const outer = new THREE.Mesh(new THREE.IcosahedronGeometry(1.35, 1), base);
      outer.scale.set(1, 1.5, 1);
      outer.castShadow = true;
      core.add(outer);
      const heart = new THREE.Mesh(new THREE.IcosahedronGeometry(0.72, 0), accent);
      core.add(heart);
      parts.core = heart;

      // Mask: a smooth plate with a slit, hanging in front of the frame.
      const mask = new THREE.Mesh(new THREE.CylinderGeometry(0.86, 0.62, 0.18, 6), dark);
      mask.rotation.x = Math.PI / 2;
      mask.position.set(0, 0.35, 1.15);
      mask.castShadow = true;
      core.add(mask);
      const slit = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.14, 0.1), accent);
      slit.position.set(0, 0.4, 1.26);
      core.add(slit);
      for (const sx of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 7, 6), accent);
        eye.position.set(sx * 0.34, 0.42, 1.3);
        core.add(eye);
      }

      // Crown of shards, and a second counter-rotating ring below it.
      const crown = new THREE.Group();
      crown.position.y = 1.5;
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const shard = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.9 + (i % 3) * 0.34, 4), accent);
        shard.position.set(Math.cos(a) * 1.15, 0.2 + (i % 2) * 0.2, Math.sin(a) * 1.15);
        shard.rotation.set(Math.cos(a) * 0.3, -a, -Math.sin(a) * 0.3);
        crown.add(shard);
      }
      core.add(crown);
      parts.rings = crown;

      const halo = new THREE.Group();
      halo.position.y = -0.4;
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.9 + i * 0.5, 0.07, 4, 20), dark);
        ring.rotation.set(Math.PI / 2 + i * 0.22, i * 0.5, 0);
        halo.add(ring);
      }
      core.add(halo);
      parts.halo = halo;

      // Shoulders, so the crown has something to sit on.
      for (const sx of [-1, 1]) {
        const pauldron = new THREE.Mesh(
          new THREE.SphereGeometry(0.7, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), base);
        pauldron.position.set(sx * 1.3, 0.7, 0);
        pauldron.rotation.z = sx * 0.4;
        pauldron.castShadow = true;
        core.add(pauldron);
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.5, 5), dark);
        spike.position.set(sx * 1.5, 1.5, -0.2);
        spike.rotation.z = sx * 0.5;
        core.add(spike);
      }

      // A tattered column instead of legs, tapering away underneath.
      const tatters = new THREE.Group();
      const rngS = mulberryLite(21);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const len = 1.6 + rngS() * 1.8;
        const rag = new THREE.Mesh(new THREE.ConeGeometry(0.22, len, 4), base);
        rag.position.set(Math.cos(a) * 0.68, -1.5 - len * 0.4, Math.sin(a) * 0.68);
        rag.rotation.set(Math.cos(a) * 0.22, a, Math.PI + Math.sin(a) * 0.22);
        tatters.add(rag);
      }
      core.add(tatters);
      parts.tail = tatters;
      parts.torso = core;
      parts.hover = true;
      break;
    }
    case 'harbinger': {
      const core = new THREE.Group();
      core.position.y = 2.4;
      g.add(core);
      const shard = new THREE.Mesh(new THREE.OctahedronGeometry(1.1, 0), base);
      shard.scale.set(1, 1.8, 1);
      shard.castShadow = true;
      core.add(shard);
      core.add(sphere(0.4, accent, 0, 0, 0, 12));
      const ringGroup = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5 + i * 0.35, 0.07, 5, 22), accent);
        ring.rotation.set(Math.PI / 2 + i * 0.5, i * 0.7, 0);
        ringGroup.add(ring);
      }
      core.add(ringGroup);
      parts.rings = ringGroup;
      parts.core = core;
      parts.hover = true;
      break;
    }
    default:
      g.add(box(0.6, 1.4, 0.6, base, 0, 0.7, 0));
  }

  g.userData = parts;
  return mergeStaticMeshes(g);
}

/**
 * Enemy limb: tapered cylinder with a ball joint at the pivot and an optional
 * cuff. Boxes read as blocky mainly because every limb is a hard prism — a
 * taper plus a joint sphere costs a dozen triangles and fixes the silhouette.
 */
function pivotLimb(parent, x, y, z, [w, h, d], material, accentMaterial = null) {
  const grp = new THREE.Group();
  grp.position.set(x, y, z);

  const r = Math.max(w, d) * 0.5;
  const limb = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.76, h, 7), material);
  limb.position.y = -h / 2;
  limb.scale.z = Math.max(0.55, d / Math.max(w, 0.001));
  limb.castShadow = true;
  limb.receiveShadow = true;
  grp.add(limb);

  const joint = new THREE.Mesh(new THREE.SphereGeometry(r * 1.06, 7, 5), material);
  joint.castShadow = true;
  grp.add(joint);

  if (accentMaterial) {
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r * 0.92, w * 0.5, 7), accentMaterial);
    cuff.position.y = -h + w * 0.35;
    grp.add(cuff);
    const claw = new THREE.Mesh(new THREE.ConeGeometry(r * 0.6, h * 0.22, 5), accentMaterial);
    claw.position.y = -h - h * 0.08;
    claw.castShadow = true;
    grp.add(claw);
  }
  parent.add(grp);
  return grp;
}

/* ==========================================================================
   PROPS
   ========================================================================== */
/**
 * Chests.
 *
 * Built as real containers rather than two boxes: a banded carcass with corner
 * ironwork, a barrel-vaulted lid made of staves, riveted straps, a working hasp
 * and lock plate, feet, and an interior that is visible once the lid swings.
 * The lid pivots on a hinge bar at the back so the animation reads mechanically.
 */
export function buildChestModel(kind) {
  const g = new THREE.Group();

  const P = {
    chest:     { wood: 0x6b4a2f, iron: 0x4a4f5a, trim: 0x8a6a3a, glow: 0xffcf5c, s: 1.0, staves: 5 },
    large:     { wood: 0x3d4d5e, iron: 0x5f7488, trim: 0x8fa6bd, glow: 0x7fd0ff, s: 1.34, staves: 7 },
    legendary: { wood: 0x5a2f22, iron: 0x7a4a24, trim: 0xffa04a, glow: 0xff8a3d, s: 1.5, staves: 7 },
    shrine:    { wood: 0x2f2440, iron: 0x5a4480, trim: 0x9a6ada, glow: 0xd94bff, s: 1.2, staves: 0 },
    // Shrine of Ruin: the same altar in iron and ember, so it reads as a shrine
    // from across the arena and as a different bargain once you are close.
    ruin:      { wood: 0x3a2018, iron: 0x7a3a22, trim: 0xff7a47, glow: 0xff5a2a, s: 1.28, staves: 0 },
  }[kind] || { wood: 0x6b4a2f, iron: 0x4a4f5a, trim: 0x8a6a3a, glow: 0xffcf5c, s: 1, staves: 5 };

  const wood = mat(P.wood, { roughness: 0.86, metalness: 0.06, flat: true });
  const iron = mat(P.iron, { roughness: 0.42, metalness: 0.82 });
  const trim = mat(P.trim, { roughness: 0.34, metalness: 0.88 });
  const glowM = glowMat(P.glow, 0.9);
  const inner = mat(0x140f0a, { roughness: 1, metalness: 0 });

  if (kind === 'shrine' || kind === 'ruin') {
    // Shrine: a tiered altar with a floating, caged orb.
    const steps = 3;
    for (let i = 0; i < steps; i++) {
      const r = 1.35 - i * 0.22;
      const drum = cyl(r, r + 0.06, 0.26, 8, i % 2 ? iron : wood, 0, 0.13 + i * 0.26, 0);
      g.add(drum);
      const lip = new THREE.Mesh(new THREE.TorusGeometry(r, 0.035, 4, 16), trim);
      lip.rotation.x = Math.PI / 2;
      lip.position.y = 0.26 + i * 0.26;
      g.add(lip);
    }
    const pillar = cyl(0.16, 0.24, 1.5, 6, iron, 0, 1.6, 0);
    g.add(pillar);
    for (let i = 0; i < 3; i++) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 4, 10), trim);
      band.rotation.x = Math.PI / 2;
      band.position.y = 1.1 + i * 0.5;
      g.add(band);
    }
    // Cage arms cradling the orb.
    const cage = new THREE.Group();
    cage.position.y = 2.55;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const arm = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 4, 12, Math.PI * 0.9), trim);
      arm.rotation.set(Math.PI / 2, 0, a);
      arm.rotation.x = Math.PI / 2;
      arm.position.set(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05);
      arm.rotateOnAxis(new THREE.Vector3(0, 0, 1), a);
      cage.add(arm);
    }
    g.add(cage);
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), glowM);
    orb.position.y = 2.55;
    g.add(orb);
    const orbCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), glowMat(0xffffff, 0.85));
    orbCore.position.y = 2.55;
    g.add(orbCore);
    if (kind === 'ruin') {
      // A crown of blades: what this shrine summons, said in one silhouette.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const spike = cyl(0.005, 0.05, 0.62, 4, trim, Math.cos(a) * 0.52, 2.55, Math.sin(a) * 0.52);
        spike.rotation.set(Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5);
        g.add(spike);
      }
    }
    g.userData = { orb, cage, spin: pillar, glowColor: P.glow };
    g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    return mergeStaticMeshes(g);
  }

  /* ==========================================================================
     THE LEGENDARY RELIQUARY
     ==========================================================================
     A Legendary chest used to be an ordinary chest painted orange and scaled up
     half again. At forty metres through fog, in an arena that also contains
     Large chests painted blue and scaled up a third, that is not a silhouette —
     it is a colour you have to be close enough to read. Given what one costs,
     you should be able to tell what it is from across the stage and decide to
     walk over before you can make out the price.

     So this one is not a chest at all. It is a hexagonal reliquary held off the
     ground by four claws, crowned by two counter-rotating rings and lit by a
     shaft of light that goes up past the fog ceiling. Nothing else in the game
     has that outline, which is the whole requirement.
  */
  if (kind === 'legendary') {
    const obsidian = mat(0x231018, { roughness: 0.32, metalness: 0.55, flat: true });
    const goldDark = mat(0x8a5a1e, { roughness: 0.36, metalness: 0.95 });
    const gold = mat(0xffb44a, { roughness: 0.22, metalness: 1.0, emissive: 0xff8a3d, emissiveIntensity: 0.35 });
    const ember = glowMat(0xff8a3d, 0.92);
    const emberSoft = glowMat(0xffc27a, 0.5);

    /* ---- plinth: three hexagonal steps ---- */
    for (let i = 0; i < 3; i++) {
      const r = 1.55 - i * 0.26;
      g.add(cyl(r, r + 0.05, 0.24, 6, i === 1 ? goldDark : obsidian, 0, 0.12 + i * 0.24, 0));
      const lip = new THREE.Mesh(new THREE.TorusGeometry(r, 0.036, 4, 6), gold);
      lip.rotation.x = Math.PI / 2;
      lip.rotation.z = Math.PI / 6;
      lip.position.y = 0.24 + i * 0.24;
      g.add(lip);
    }

    /* ---- four claws holding the vault clear of the plinth ---- */
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const cx = Math.cos(a) * 0.72;
      const cz = Math.sin(a) * 0.72;
      const claw = new THREE.Group();
      claw.position.set(cx, 0.84, cz);
      claw.rotation.y = -a;
      claw.add(box(0.17, 0.62, 0.2, goldDark, 0, 0, 0));
      const knee = box(0.14, 0.44, 0.17, goldDark, 0, 0.42, -0.12);
      knee.rotation.x = 0.5;
      claw.add(knee);
      claw.add(box(0.2, 0.12, 0.28, gold, 0, -0.3, 0.05));
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.075, 0), ember);
      gem.position.set(0, 0.12, 0.11);
      claw.add(gem);
      g.add(claw);
    }

    /* ---- the vault: a hexagonal drum with rune faces ---- */
    const vault = new THREE.Group();
    vault.position.y = 1.42;
    g.add(vault);
    vault.add(cyl(0.98, 1.02, 0.86, 6, obsidian, 0, 0, 0));
    for (const y of [-0.4, 0.4]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.055, 4, 6), gold);
      band.rotation.x = Math.PI / 2;
      band.rotation.z = Math.PI / 6;
      band.position.y = y;
      vault.add(band);
    }
    // Rune plates recessed into each of the six faces, lit from behind.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const px = Math.cos(a) * 0.9;
      const pz = Math.sin(a) * 0.9;
      const plate = box(0.44, 0.5, 0.06, goldDark, px, 0, pz);
      plate.rotation.y = -a + Math.PI / 2;
      vault.add(plate);
      const litRune = box(0.2, 0.32, 0.05, ember, Math.cos(a) * 0.94, 0, Math.sin(a) * 0.94);
      litRune.rotation.y = -a + Math.PI / 2;
      vault.add(litRune);
      // Studs framing the plate.
      for (const sy of [-0.3, 0.3]) {
        vault.add(sphere(0.045, gold, Math.cos(a) * 0.95, sy, Math.sin(a) * 0.95, 6));
      }
    }
    // Hollow interior, visible once the crown lifts.
    vault.add(cyl(0.8, 0.8, 0.7, 6, inner, 0, 0.12, 0));

    /* ---- the crown: a hexagonal pyramid that hinges up and back ---- */
    const lid = new THREE.Group();
    lid.position.set(0, 1.88, -0.95);
    g.add(lid);
    const capBase = cyl(0.88, 1.04, 0.2, 6, obsidian, 0, 0.1, 0.95);
    lid.add(capBase);
    const spire = cyl(0.06, 0.86, 0.78, 6, obsidian, 0, 0.58, 0.95);
    lid.add(spire);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const rib = box(0.06, 0.8, 0.06, gold, Math.cos(a) * 0.4, 0.56, 0.95 + Math.sin(a) * 0.4);
      rib.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
      lid.add(rib);
    }
    const finial = new THREE.Mesh(new THREE.OctahedronGeometry(0.17, 0), gold);
    finial.position.set(0, 1.02, 0.95);
    lid.add(finial);
    const finialCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), ember);
    finialCore.position.set(0, 1.02, 0.95);
    lid.add(finialCore);
    const lidRing = new THREE.Mesh(new THREE.TorusGeometry(0.98, 0.05, 4, 6), gold);
    lidRing.rotation.x = Math.PI / 2;
    lidRing.rotation.z = Math.PI / 6;
    lidRing.position.set(0, 0.2, 0.95);
    lid.add(lidRing);

    /* ---- crown of orbiting rings ---- */
    const rings = new THREE.Group();
    rings.position.y = 2.5;
    g.add(rings);
    const ringA = new THREE.Group();
    const ringB = new THREE.Group();
    rings.add(ringA, ringB);
    const buildRing = (parent, radius, tube, tilt) => {
      const torus = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 5, 22), gold);
      torus.rotation.x = Math.PI / 2 + tilt;
      parent.add(torus);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const node = new THREE.Mesh(new THREE.OctahedronGeometry(tube * 2.4, 0), ember);
        node.position.set(Math.cos(a) * radius, Math.sin(tilt) * Math.sin(a) * radius, Math.sin(a) * radius * Math.cos(tilt));
        parent.add(node);
      }
    };
    buildRing(ringA, 1.15, 0.045, 0);
    buildRing(ringB, 0.82, 0.035, 0.62);
    rings.userData.a = ringA;
    rings.userData.b = ringB;

    /* ---- the light shaft: what you actually see from across the arena ---- */
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.9, 22, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff9a4a, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    beam.position.y = 12.4;
    g.add(beam);

    const halo = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.7, 24), emberSoft);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.05;
    g.add(halo);

    // The "lamp" the update loop dims when the chest is spent.
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), ember);
    core.position.y = 1.42;
    g.add(core);

    g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    beam.castShadow = false;
    halo.castShadow = false;
    g.userData = { lid, light: core, rings, beam, halo, glowColor: P.glow, legendary: true };
    return mergeStaticMeshes(g);
  }

  /* ==========================================================================
     THE OTHER FOUR
     ==========================================================================
     Each of these has to be identifiable at fifty metres by silhouette alone,
     because the whole reason to put four more devices on a stage is that you
     decide which one to walk towards before you can read the prompt. So: an
     altar is low and wide and horizontal, a cache is a squat sealed drum, a
     duplicator is tall and framed, and a forge is a hopper with a chimney.
  */
  if (kind === 'altar') {
    const stone = mat(0x4a4048, { roughness: 0.86, metalness: 0.06, flat: true });
    const dark = mat(0x2a2028, { roughness: 0.9, metalness: 0.05 });
    const iron = mat(0x5a4a4a, { roughness: 0.5, metalness: 0.7 });
    const bloodM = glowMat(0xff2f5e, 0.9);

    // Slab on two plinths, low and horizontal.
    for (const sx of [-1, 1]) {
      g.add(box(0.5, 0.8, 1.5, stone, sx * 0.95, 0.4, 0));
      g.add(box(0.62, 0.14, 1.62, dark, sx * 0.95, 0.86, 0));
    }
    const slab = box(2.9, 0.34, 1.9, stone, 0, 1.05, 0);
    g.add(slab);
    g.add(box(3.0, 0.1, 2.0, dark, 0, 1.24, 0));
    // A channel cut down the middle, running to a drain at one end.
    g.add(box(0.42, 0.08, 1.7, bloodM, 0, 1.28, 0));
    g.add(box(0.9, 0.06, 0.42, bloodM, 0, 1.28, 0.85));
    for (let i = 0; i < 4; i++) {
      g.add(box(0.13, 0.05, 0.5, bloodM, -1.0 + i * 0.66, 1.28, -0.6));
    }
    // Chains and rings at the corners.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.035, 4, 10), iron);
        ring.position.set(sx * 1.3, 1.16, sz * 0.78);
        ring.rotation.x = Math.PI / 2;
        g.add(ring);
        cableRun(g, iron, [sx * 1.3, 1.14, sz * 0.78], [sx * 1.5, 0.2, sz * 0.95], 0.16, 5, 0.03);
      }
    }
    // The offering: a shard held above the slab.
    const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.36, 0), bloodM);
    shard.position.y = 2.15;
    g.add(shard);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.045, 4, 18), iron);
    halo.rotation.x = Math.PI / 2;
    halo.position.y = 2.15;
    g.add(halo);
    g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    g.userData = { light: shard, orb: shard, halo, glowColor: 0xff2f5e };
    return mergeStaticMeshes(g);
  }

  if (kind === 'cache') {
    const drum = mat(0x3c4230, { roughness: 0.72, metalness: 0.34, flat: true });
    const band = mat(0x2a2e22, { roughness: 0.6, metalness: 0.6 });
    const rust = mat(0x6a4a2a, { roughness: 0.94, metalness: 0.1 });
    const leak = glowMat(0xff4d5e, 0.85);

    g.add(cyl(1.05, 1.15, 1.9, 10, drum, 0, 0.95, 0));
    for (const y of [0.34, 0.95, 1.56]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.075, 4, 14), band);
      hoop.rotation.x = Math.PI / 2;
      hoop.position.y = y;
      g.add(hoop);
    }
    // Cross-strapping over the lid, bolted down. Sealed by someone worried.
    const lid = new THREE.Group();
    lid.position.set(0, 1.9, -1.0);
    g.add(lid);
    lid.add(cyl(1.0, 1.06, 0.16, 10, band, 0, 0.08, 1.0));
    for (let i = 0; i < 2; i++) {
      const strap = box(i ? 2.2 : 0.34, 0.1, i ? 0.34 : 2.2, rust, 0, 0.2, 1.0);
      lid.add(strap);
    }
    const seal = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), leak);
    seal.position.set(0, 0.34, 1.0);
    lid.add(seal);
    // Leaking seams: it is not holding.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.add(box(0.1, 0.5, 0.1, leak, Math.cos(a) * 1.08, 0.95, Math.sin(a) * 1.08));
    }
    const warn = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.3, 20), glowMat(0xff4d5e, 0.3));
    warn.rotation.x = -Math.PI / 2;
    warn.position.y = 0.06;
    g.add(warn);
    g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    warn.castShadow = false;
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), leak);
    core.position.y = 1.9;
    g.add(core);
    g.userData = { lid, light: core, halo: warn, glowColor: 0xff4d5e };
    return mergeStaticMeshes(g);
  }

  if (kind === 'duplicator') {
    const frame = mat(0x4a5260, { roughness: 0.44, metalness: 0.78 });
    const dark = mat(0x232a34, { roughness: 0.7, metalness: 0.5 });
    const glow = glowMat(0x6fd0ff, 0.85);

    g.add(box(2.4, 0.3, 1.5, dark, 0, 0.15, 0));
    for (const sx of [-1, 1]) {
      g.add(box(0.26, 3.0, 0.4, frame, sx * 1.0, 1.6, 0));
      ventStack(g, dark, { pos: [sx * 1.0, 1.2, 0.22], count: 4, size: [0.3, 0.05, 0.06], spacing: 0.3, axis: 'z' });
    }
    g.add(box(2.4, 0.34, 0.5, frame, 0, 3.1, 0));
    g.add(box(2.0, 0.12, 0.3, glow, 0, 2.9, 0.06));
    // The scanning bar: what a duplicator is, in one part.
    const bar = new THREE.Group();
    bar.position.y = 1.5;
    g.add(bar);
    bar.add(box(2.1, 0.16, 0.34, frame, 0, 0, 0));
    bar.add(box(1.9, 0.07, 0.12, glow, 0, 0, 0.2));
    // Plate, and the ghost of a thing standing on it.
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.8, 0.14, 12), frame);
    plate.position.y = 0.36;
    g.add(plate);
    const ghost = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 0), glow);
    ghost.position.y = 1.1;
    g.add(ghost);
    for (let i = 0; i < 3; i++) {
      const halo = new THREE.Mesh(new THREE.TorusGeometry(0.55 + i * 0.12, 0.025, 4, 16), glow);
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.62 + i * 0.42;
      g.add(halo);
    }
    cableRun(g, dark, [-1.0, 2.9, -0.2], [1.0, 2.9, -0.2], 0.22, 6, 0.035);
    g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    g.userData = { light: ghost, orb: ghost, scanBar: bar, glowColor: 0x6fd0ff };
    return mergeStaticMeshes(g);
  }

  if (kind === 'forge') {
    const iron = mat(0x40342c, { roughness: 0.68, metalness: 0.5, flat: true });
    const hot = mat(0xff8a3d, { emissive: 0xff6a2a, emissiveIntensity: 1.5, roughness: 0.4 });
    const dark = mat(0x231c18, { roughness: 0.9, metalness: 0.2 });
    const fire = glowMat(0xffb347, 0.9);

    // Squat body on splayed legs.
    g.add(box(2.2, 1.5, 1.8, iron, 0, 0.95, 0));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = box(0.24, 0.9, 0.24, dark, sx * 0.85, 0.42, sz * 0.68);
      leg.rotation.z = sx * 0.14;
      g.add(leg);
    }
    // Hopper: a funnel you visibly drop things into.
    const hopper = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.45, 0.9, 8, 1, true), iron);
    hopper.position.y = 2.1;
    g.add(hopper);
    const hopperRim = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.08, 4, 14), dark);
    hopperRim.rotation.x = Math.PI / 2;
    hopperRim.position.y = 2.55;
    g.add(hopperRim);
    // Chimney, offset, with a heat glow at the throat.
    g.add(cyl(0.3, 0.36, 2.0, 7, iron, 0.72, 2.6, -0.5));
    g.add(cyl(0.38, 0.3, 0.22, 7, dark, 0.72, 3.7, -0.5));
    g.add(cyl(0.24, 0.24, 0.12, 7, fire, 0.72, 3.6, -0.5));
    // The fire door, and the light coming out of it.
    g.add(box(0.9, 0.7, 0.12, dark, 0, 0.85, 0.92));
    const mouth = box(0.66, 0.46, 0.08, fire, 0, 0.85, 0.98);
    g.add(mouth);
    for (let i = 0; i < 3; i++) {
      g.add(box(1.9, 0.09, 0.1, hot, 0, 0.35 + i * 0.5, 0.9));
    }
    boltRow(g, dark, { from: [-0.9, 1.66, 0.92], to: [0.9, 1.66, 0.92], count: 5, r: 0.05 });
    const ember = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), fire);
    ember.position.set(0, 2.5, 0);
    g.add(ember);
    g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    g.userData = { light: ember, orb: ember, mouth, glowColor: 0xffb347 };
    return mergeStaticMeshes(g);
  }

  const s = P.s;
  const W = 1.55 * s, D = 1.02 * s, H = 0.7 * s;

  /* ---- carcass ---- */
  const body = new THREE.Group();
  g.add(body);

  const shell = box(W, H, D, wood, 0, H / 2 + 0.1, 0);
  body.add(shell);
  // Hollow interior so the open chest is not a solid block.
  const cavity = box(W - 0.2, H - 0.16, D - 0.2, inner, 0, H / 2 + 0.2, 0);
  body.add(cavity);

  // Vertical plank seams.
  const planks = 6;
  for (let i = 0; i <= planks; i++) {
    const x = -W / 2 + (i / planks) * W;
    body.add(box(0.03, H * 0.96, D + 0.012, iron, x, H / 2 + 0.1, 0));
  }
  // Horizontal iron straps with rivets.
  for (const sy of [0.3, 0.78]) {
    const strap = box(W + 0.02, 0.11 * s, D + 0.02, iron, 0, H * sy + 0.1, 0);
    body.add(strap);
    for (let i = 0; i < 5; i++) {
      const rx = -W / 2 + 0.16 + (i / 4) * (W - 0.32);
      body.add(sphere(0.033 * s, trim, rx, H * sy + 0.1, D / 2 + 0.012, 6));
      body.add(sphere(0.033 * s, trim, rx, H * sy + 0.1, -D / 2 - 0.012, 6));
    }
  }
  // Corner ironwork.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = box(0.1 * s, H + 0.06, 0.1 * s, iron, sx * (W / 2 - 0.04), H / 2 + 0.1, sz * (D / 2 - 0.04));
    body.add(post);
    const foot = box(0.19 * s, 0.16 * s, 0.19 * s, iron, sx * (W / 2 - 0.08), 0.08, sz * (D / 2 - 0.08));
    body.add(foot);
  }
  // Base skirt.
  body.add(box(W + 0.06, 0.1 * s, D + 0.06, iron, 0, 0.16, 0));

  /* ---- lid ----
     Built in an unambiguous frame: a cylinder whose axis is rotated onto X, so
     its circle lies in the YZ plane with theta 0 at +Z and theta pi/2 at +Y.
     Sweeping theta over [0, pi] therefore arches from the front edge, over the
     top, to the back edge — which is exactly a barrel-vaulted lid. The previous
     construction stacked two rotations and landed the vault on its side. */
  const lid = new THREE.Group();
  lid.position.set(0, H + 0.1, -D / 2);
  g.add(lid);

  const vaultR = D * 0.5;
  const vaultZ = D / 2;               // circle centre, so the arc spans z = 0..D

  // Staves: boxes tangent to the arc. At theta = pi/2 (top) a stave needs no
  // rotation; the tangent turns with theta, hence rotation.x = pi/2 - theta.
  const staveArc = Math.PI / Math.max(1, P.staves);
  for (let i = 0; i < P.staves; i++) {
    const theta = ((i + 0.5) / P.staves) * Math.PI;
    const stave = box(W - 0.05, 0.09 * s, vaultR * staveArc * 1.22, wood,
      0, Math.sin(theta) * vaultR, vaultZ + Math.cos(theta) * vaultR);
    stave.rotation.x = Math.PI / 2 - theta;
    lid.add(stave);
    // Seam between staves.
    const seamT = (i / P.staves) * Math.PI;
    lid.add(box(W - 0.02, 0.03 * s, 0.04 * s, iron,
      0, Math.sin(seamT) * vaultR * 1.02, vaultZ + Math.cos(seamT) * vaultR * 1.02));
  }

  // End caps: the same half-circle as a thin closed disc at each end.
  for (const sx of [-1, 1]) {
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(vaultR, vaultR, 0.07 * s, 14, 1, false, 0, Math.PI), wood);
    cap.rotation.z = Math.PI / 2;     // axis onto X; circle now lies in YZ
    cap.position.set(sx * (W / 2 - 0.02), 0, vaultZ);
    cap.castShadow = true;
    lid.add(cap);
  }

  // Iron ribs following the vault.
  for (const rx of [-W * 0.31, 0, W * 0.31]) {
    const rib = new THREE.Mesh(
      new THREE.TorusGeometry(vaultR * 1.02, 0.032 * s, 4, 16, Math.PI), iron);
    // Torus lies in XY by default; rotate it into YZ and start the sweep at +Z.
    rib.rotation.set(0, Math.PI / 2, 0);
    rib.position.set(rx, 0, vaultZ);
    rib.castShadow = true;
    lid.add(rib);
  }

  // Hinge barrel at the pivot, running across the back edge.
  const hinge = cyl(0.07 * s, 0.07 * s, W * 0.92, 8, iron, 0, 0, 0);
  hinge.rotation.z = Math.PI / 2;
  lid.add(hinge);
  for (const sx of [-1, 1]) {
    lid.add(box(0.15 * s, 0.15 * s, 0.15 * s, trim, sx * W * 0.37, 0, 0));
  }

  /* ---- lock furniture ---- */
  const latch = new THREE.Group();
  latch.position.set(0, 0.02, D - 0.01);        // front lip of the vault
  lid.add(latch);
  latch.add(box(0.3 * s, 0.24 * s, 0.05 * s, trim, 0, -0.09, 0));
  latch.add(box(0.12 * s, 0.15 * s, 0.045 * s, iron, 0, -0.22, 0.005));

  const lockPlate = box(0.36 * s, 0.34 * s, 0.07 * s, trim, 0, H * 0.62 + 0.1, D / 2 + 0.02);
  body.add(lockPlate);
  const keyhole = box(0.08 * s, 0.13 * s, 0.05 * s, inner, 0, H * 0.6 + 0.1, D / 2 + 0.06);
  body.add(keyhole);
  const lamp = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.62, 0.07 * s), glowM);
  lamp.position.set(0, H * 0.86 + 0.1, D / 2 + 0.015);
  body.add(lamp);

  // Corner lamps so the chest is findable in fog.
  for (const sx of [-1, 1]) {
    const bulb = sphere(0.05 * s, glowM, sx * (W / 2 - 0.06), H * 0.94 + 0.1, D / 2 + 0.03, 6);
    body.add(bulb);
  }

  g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  g.userData = { lid, light: lamp, glowColor: P.glow, latch };
  return mergeStaticMeshes(g);
}

export function buildTeleporterModel() {
  const g = new THREE.Group();
  const body = mat(0x2e3646, { roughness: 0.5, metalness: 0.7 });
  const trim = mat(0x46e0c0, { emissive: 0x2ad0b0, emissiveIntensity: 1.6, roughness: 0.3 });

  g.add(cyl(2.6, 3.2, 0.5, 8, body, 0, 0.25, 0));
  g.add(cyl(2.2, 2.4, 0.16, 8, trim, 0, 0.55, 0));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const p = cyl(0.16, 0.22, 2.6, 6, body, Math.cos(a) * 2.2, 1.6, Math.sin(a) * 2.2);
    p.rotation.z = -Math.cos(a) * 0.12;
    p.rotation.x = Math.sin(a) * 0.12;
    g.add(p);
    g.add(box(0.2, 0.2, 0.2, trim, Math.cos(a) * 2.2, 2.9, Math.sin(a) * 2.2));
  }
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 1), glowMat(0x46e0c0, 0.55));
  core.position.y = 2.1;
  g.add(core);
  g.userData.core = core;

  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.09, 6, 30), glowMat(0x46e0c0, 0.8));
  ring.position.y = 2.1;
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  g.userData.ring = ring;

  /* The Beacon's plume.
   *
   * This used to be a thirty-metre cylinder of flat additive colour — a light
   * beam, which found the Beacon for you from anywhere on the stage and looked
   * like a rendering artefact while doing it. A column of motes reads as the
   * same landmark from the same distance, but it is *made of* something: it
   * drifts, it accelerates when the Beacon is charging, and it goes still when
   * the fight is over. Same navigational job, and it belongs to the world.
   *
   * One Points object, one buffer, updated on the CPU. At 260 particles that is
   * a few thousand floats a frame, against a draw call either way.
   */
  const COUNT = 260;
  const positions = new Float32Array(COUNT * 3);
  const seeds = new Float32Array(COUNT * 4);   // radius, phase, height0, speed
  for (let i = 0; i < COUNT; i++) {
    seeds[i * 4] = 0.6 + Math.random() * 2.6;
    seeds[i * 4 + 1] = Math.random() * Math.PI * 2;
    seeds[i * 4 + 2] = Math.random();
    seeds[i * 4 + 3] = 0.35 + Math.random() * 0.9;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({
    color: 0x8ff0e0, size: 0.9, transparent: true, opacity: 0.85,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  motes.frustumCulled = false;
  g.add(motes);
  g.userData.motes = motes;
  g.userData.moteSeeds = seeds;

  return g;
}

export function buildOrbModel(color, size = 0.28) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), glowMat(color, 0.95));
  g.add(core);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(size * 1.9, 10, 8), glowMat(color, 0.16));
  g.add(halo);
  g.userData.core = core;
  g.userData.halo = halo;
  return g;
}

const iconTextureCache = new Map();

/** Cached icon texture for an item, drawn once and shared by every drop. */
function itemIconTexture(item) {
  if (iconTextureCache.has(item.id)) return iconTextureCache.get(item.id);
  const canvas = itemIconCanvas(item, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  iconTextureCache.set(item.id, tex);
  return tex;
}

/**
 * Ground drop for an item.
 *
 * The item's own icon is billboarded on a rarity-framed plate, so every one of
 * the 44 items is identifiable across the arena rather than resolving to one of
 * a handful of category shapes. The plate is held in a physical frame on a
 * pedestal so it still reads as an object sitting in the world.
 */
export function buildItemDropModel(item, rarityHex, beamOpacity = 0.13) {
  const g = new THREE.Group();
  const dark = mat(0x1b2029, { roughness: 0.5, metalness: 0.7 });
  const rarityScale = { common: 0.92, uncommon: 1.0, rare: 1.08, epic: 1.18, legendary: 1.32 }[item.rarity] ?? 1;

  // Billboard: the icon itself.
  const billboard = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(1.05, 1.05),
    new THREE.MeshBasicMaterial({ map: itemIconTexture(item), transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  billboard.add(plate);

  // Frame behind the icon gives it thickness and catches the light.
  const backing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.6, 0.07, 6),
    mat(rarityHex, { emissive: rarityHex, emissiveIntensity: 0.5, roughness: 0.35, metalness: 0.6 }),
  );
  backing.rotation.x = Math.PI / 2;
  backing.position.z = -0.06;
  backing.castShadow = true;
  billboard.add(backing);

  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.045, 4, 6), glowMat(rarityHex, 0.9));
  rim.position.z = -0.03;
  billboard.add(rim);

  billboard.scale.setScalar(rarityScale);
  g.add(billboard);

  // Pedestal so the drop reads as placed rather than dropped.
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.12, 6), dark);
  plinth.position.y = -0.78;
  plinth.receiveShadow = true;
  plinth.castShadow = true;
  g.add(plinth);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.42, 5), dark);
  stem.position.y = -0.54;
  g.add(stem);
  const plinthGlow = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.035, 4, 12), glowMat(rarityHex, 0.85));
  plinthGlow.position.y = -0.71;
  plinthGlow.rotation.x = Math.PI / 2;
  g.add(plinthGlow);

  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.62 * rarityScale, 12, 10),
    glowMat(rarityHex, Math.min(0.13, beamOpacity * 0.8)));
  g.add(halo);

  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 14, 14, 1, true),
    new THREE.MeshBasicMaterial({
      color: rarityHex, transparent: true, opacity: beamOpacity, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  pillar.position.y = 7;
  g.add(pillar);

  g.userData = { billboard, halo, pillar, plinthGlow, rarityScale };
  return g;
}

/* ==========================================================================
   BROOD LIZARDS
   ========================================================================== */

/**
 * A pet lizard, sized to sit at about knee height beside its owner.
 *
 * The silhouette has to survive a firefight: it is read at a glance, at
 * distance, against a floor full of hazard rings. So the shape is deliberately
 * long and low — nothing else in the game is — and the owner's accent colour is
 * carried on the spines, throat and eyes so you can tell whose lizard it is at
 * a glance in co-op.
 *
 * `trophies` is the owner's item count: every two items grow another crystal on
 * its back, which is the visible half of "pets inherit your items".
 */
export function buildLizardModel({ color = 0x5f7a4a, accent = 0xff8a3d, trophies = 0 } = {}) {
  const g = new THREE.Group();
  const hide = mat(color, { roughness: 0.82, metalness: 0.08, flat: true });
  const belly = mat(new THREE.Color(color).offsetHSL(0, -0.08, 0.16).getHex(), { roughness: 0.75, flat: true });
  const dark = mat(0x21242c, { roughness: 0.9, metalness: 0.1 });
  const glow = mat(accent, { emissive: accent, emissiveIntensity: 1.6, roughness: 0.4 });

  // ---- body ----
  const body = new THREE.Group();
  body.position.y = 0.42;
  g.add(body);

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.19, 0.86, 8), hide);
  trunk.rotation.x = Math.PI / 2;
  trunk.scale.set(1, 1, 0.82);
  trunk.castShadow = true;
  body.add(trunk);

  const chest = sphere(0.24, hide, 0, 0.01, 0.34, 8);
  chest.scale.set(1.02, 0.92, 0.9);
  body.add(chest);
  const hip = sphere(0.21, hide, 0, 0, -0.36, 8);
  hip.scale.set(1, 0.94, 0.95);
  body.add(hip);

  const underside = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.13, 0.8, 6), belly);
  underside.rotation.x = Math.PI / 2;
  underside.position.y = -0.13;
  underside.scale.set(1, 1, 0.5);
  body.add(underside);

  // Dorsal ridge — says "lizard" more than any other single detail.
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14 + Math.sin(t * Math.PI) * 0.13, 4), glow);
    fin.position.set(0, 0.2 + Math.sin(t * Math.PI) * 0.04, 0.34 - t * 0.72);
    fin.rotation.x = -0.28;
    body.add(fin);
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const scute = box(0.035, 0.07, 0.17, belly, sx * 0.215, -0.05, 0.2 - i * 0.22);
      scute.rotation.z = sx * 0.22;
      body.add(scute);
    }
  }

  // Trophies: crystals fused to the spine, one per two items the owner carries.
  const crystalCount = Math.min(6, Math.floor(trophies / 2));
  for (let i = 0; i < crystalCount; i++) {
    const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.05 + (i % 3) * 0.012, 0), glow);
    c.position.set((i % 2 ? 1 : -1) * 0.13, 0.19, 0.24 - i * 0.11);
    c.rotation.set(0.4, i * 0.7, 0.3);
    body.add(c);
  }

  // ---- neck + head ----
  const neck = new THREE.Group();
  neck.position.set(0, 0.08, 0.38);
  body.add(neck);
  const neckSeg = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.2, 7), hide);
  neckSeg.rotation.x = Math.PI / 2.4;
  neck.add(neckSeg);

  const head = new THREE.Group();
  head.position.set(0, 0.05, 0.11);
  neck.add(head);

  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.21, 0.3), hide);
  skull.castShadow = true;
  head.add(skull);
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.13, 0.24), hide);
  snout.position.set(0, -0.03, 0.24);
  head.add(snout);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.08, 0.07), dark);
  nose.position.set(0, -0.02, 0.37);
  head.add(nose);

  // Hinged jaw, opens on the shot.
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.06, 0.06);
  head.add(jaw);
  const jawBone = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.06, 0.3), belly);
  jawBone.position.z = 0.14;
  jaw.add(jawBone);
  for (let i = 0; i < 3; i++) {
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.055, 3), belly);
    tooth.position.set((i - 1) * 0.055, 0.045, 0.25);
    jaw.add(tooth);
  }
  // The fire builds here before it comes out.
  const maw = new THREE.Mesh(new THREE.SphereGeometry(0.07, 7, 6), glowMat(accent, 0.0));
  maw.position.set(0, -0.02, 0.3);
  head.add(maw);

  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.042, 6, 5), glow);
    eye.position.set(sx * 0.11, 0.06, 0.13);
    head.add(eye);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.035, 0.1), dark);
    brow.position.set(sx * 0.11, 0.11, 0.12);
    head.add(brow);
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.17, 4), dark);
    horn.position.set(sx * 0.08, 0.14, -0.06);
    horn.rotation.set(-0.5, 0, sx * 0.28);
    head.add(horn);
    const frill = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.13, 3), glow);
    frill.position.set(sx * 0.12, 0.02, -0.1);
    frill.rotation.set(1.4, 0, sx * 1.1);
    head.add(frill);
  }

  // Throat sac — brightens as the next shot charges.
  const throat = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), glowMat(accent, 0.35));
  throat.scale.set(1, 0.8, 1.1);
  throat.position.set(0, -0.08, 0.06);
  neck.add(throat);

  // ---- tail: three chained segments so it whips rather than swings ----
  let parent = body;
  const tails = [];
  for (let i = 0; i < 3; i++) {
    const seg = new THREE.Group();
    seg.position.set(0, i === 0 ? -0.02 : 0, i === 0 ? -0.4 : -0.19);
    const r = 0.13 - i * 0.036;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.6, 0.2, 6), hide);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = -0.1;
    mesh.castShadow = true;
    seg.add(mesh);
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.1, 4), glow);
    fin.position.set(0, r * 0.75, -0.1);
    fin.rotation.x = -0.4;
    seg.add(fin);
    parent.add(seg);
    parent = seg;
    tails.push(seg);
  }
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 5), glow);
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = -0.23;
  parent.add(tip);

  // ---- legs ----
  const legs = {};
  const legAt = (key, x, z, len) => {
    const hipG = new THREE.Group();
    hipG.position.set(x, 0.4, z);
    g.add(hipG);
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, len, 6), hide);
    upper.position.y = -len / 2;
    upper.castShadow = true;
    hipG.add(upper);
    const knee = new THREE.Group();
    knee.position.y = -len;
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, len * 0.85, 6), hide);
    shin.position.y = -len * 0.425;
    knee.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.045, 0.16), belly);
    foot.position.set(0, -len * 0.85 - 0.01, 0.04);
    knee.add(foot);
    for (let i = 0; i < 3; i++) {
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.05, 3), belly);
      claw.position.set((i - 1) * 0.033, -len * 0.85 - 0.01, 0.12);
      claw.rotation.x = Math.PI / 2;
      knee.add(claw);
    }
    hipG.add(knee);
    hipG.userData.lower = knee;
    legs[key] = hipG;
  };
  legAt('legFL', -0.19, 0.3, 0.24);
  legAt('legFR', 0.19, 0.3, 0.24);
  legAt('legBL', -0.2, -0.28, 0.26);
  legAt('legBR', 0.2, -0.28, 0.26);

  g.userData = {
    body, neck, head, jaw, throat, maw,
    tail0: tails[0], tail1: tails[1], tail2: tails[2],
    ...legs,
    accent,
  };
  return mergeStaticMeshes(g);
}

/** Speckled egg the lizards are recruited from. */
export function buildEggModel(accent = 0xff8a3d, tint = 0x8a7a5c) {
  const g = new THREE.Group();
  // Pale shell, speckled in the colour of whatever is inside it.
  const shellMat = mat(new THREE.Color(0xe6dfc8).lerp(new THREE.Color(tint), 0.22).getHex(),
    { roughness: 0.72, metalness: 0.05, flat: true });
  const speckMat = mat(tint, { roughness: 0.9 });
  const nestMat = mat(0x4a3b2c, { roughness: 0.95 });

  // A nest of debris, so the egg is not just floating on the grass.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.75, 5), nestMat);
    stick.position.set(Math.cos(a) * 0.52, 0.09, Math.sin(a) * 0.52);
    stick.rotation.set(Math.PI / 2 - 0.25, a + 1.1, 0);
    stick.receiveShadow = true;
    g.add(stick);
  }
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.5, 0.16, 10), nestMat);
  dish.position.y = 0.08;
  dish.receiveShadow = true;
  g.add(dish);

  const shell = new THREE.Group();
  shell.position.y = 0.62;
  g.add(shell);
  const egg = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 12), shellMat);
  egg.scale.set(1, 1.35, 1);
  egg.castShadow = true;
  shell.add(egg);

  const rng = mulberryLite(97);
  for (let i = 0; i < 14; i++) {
    const a = rng() * Math.PI * 2;
    const y = (rng() - 0.5) * 0.9;
    const r = 0.4 * Math.sqrt(Math.max(0, 1 - (y / 0.62) ** 2));
    const speck = new THREE.Mesh(new THREE.SphereGeometry(0.035 + rng() * 0.03, 5, 4), speckMat);
    speck.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    speck.scale.set(1, 0.5, 1);
    shell.add(speck);
  }

  // Cracks lit from inside: the tell that something in there is alive. One
  // shared material, so the merge pass can fold all five into a single mesh —
  // and so Egg.update can pulse them by touching one opacity.
  const veinMat = glowMat(accent, 0.5);
  const veins = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const vein = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.34, 0.03), veinMat);
    vein.position.set(Math.cos(a) * 0.36, -0.08 + (i % 2) * 0.16, Math.sin(a) * 0.36);
    vein.rotation.set(0.3 * Math.sin(a), -a, 0.35 * Math.cos(a));
    veins.add(vein);
  }
  shell.add(veins);

  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.72, 10, 8), glowMat(accent, 0.1));
  halo.scale.y = 1.25;
  halo.position.y = 0.62;
  g.add(halo);

  g.userData = { shell, veins, halo };
  // Nest sticks, shell and speckles are all static; only the three groups above
  // move. Merging takes the egg from 31 draw calls to a handful.
  return mergeStaticMeshes(g);
}


/**
 * Cinder Beetle — a low, wide bruiser that closes and gores.
 *
 * Deliberately the opposite silhouette to the lizard: no neck, no tail, all
 * carapace. At a glance across an arena the two should never be confused, which
 * matters more than either of them looking good up close.
 */
export function buildBeetleModel({ color = 0x6b4630, accent = 0xff8a3d, trophies = 0 } = {}) {
  const g = new THREE.Group();
  const shellMat = mat(color, { roughness: 0.55, metalness: 0.3, flat: true });
  const under = mat(new THREE.Color(color).offsetHSL(0, -0.1, -0.08).getHex(), { roughness: 0.8, flat: true });
  const dark = mat(0x1d1a1c, { roughness: 0.85, metalness: 0.15 });
  const glow = mat(accent, { emissive: accent, emissiveIntensity: 1.8, roughness: 0.35 });

  const body = new THREE.Group();
  body.position.y = 0.34;
  g.add(body);

  // Abdomen under a pair of elytra that part slightly when it charges.
  const abdomen = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), under);
  abdomen.scale.set(1, 0.62, 1.25);
  abdomen.castShadow = true;
  body.add(abdomen);

  const elytra = {};
  for (const sx of [-1, 1]) {
    const wing = new THREE.Group();
    wing.position.set(sx * 0.06, 0.06, -0.06);
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8, 0, Math.PI, 0, Math.PI * 0.62), shellMat);
    shell.scale.set(0.98, 0.66, 1.3);
    shell.rotation.y = sx > 0 ? 0 : Math.PI;
    shell.castShadow = true;
    wing.add(shell);
    for (let i = 0; i < 3; i++) {
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.62 - i * 0.12), glow);
      seam.position.set(sx * (0.12 + i * 0.09), 0.2 - i * 0.05, -0.06);
      wing.add(seam);
    }
    body.add(wing);
    elytra[sx > 0 ? 'wingR' : 'wingL'] = wing;
  }

  // Item trophies ride on the back as embedded cinders.
  for (let i = 0; i < Math.min(6, Math.floor(trophies / 2)); i++) {
    const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.05, 0), glow);
    c.position.set((i % 2 ? 1 : -1) * 0.2, 0.24 - (i % 3) * 0.03, 0.18 - i * 0.1);
    body.add(c);
  }

  // Head: a plated wedge with mandibles and a horn.
  const head = new THREE.Group();
  head.position.set(0, -0.02, 0.42);
  body.add(head);
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.26), shellMat);
  skull.castShadow = true;
  head.add(skull);
  const horn = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.36, 5), dark);
  horn.position.set(0, 0.14, 0.16);
  horn.rotation.x = -0.9;
  head.add(horn);
  const mandibles = {};
  for (const sx of [-1, 1]) {
    const jaw = new THREE.Group();
    jaw.position.set(sx * 0.12, -0.05, 0.12);
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.28, 4), dark);
    blade.position.set(sx * 0.03, 0, 0.13);
    blade.rotation.set(Math.PI / 2, 0, sx * 0.5);
    jaw.add(blade);
    head.add(jaw);
    mandibles[sx > 0 ? 'jawR' : 'jawL'] = jaw;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), glow);
    eye.position.set(sx * 0.13, 0.06, 0.08);
    head.add(eye);
  }

  // Six legs, three a side, splayed wide and low.
  const legs = {};
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const hip = new THREE.Group();
      hip.position.set(sx * 0.28, 0.3, 0.22 - i * 0.24);
      g.add(hip);
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.033, 0.26, 5), dark);
      thigh.position.set(sx * 0.1, -0.08, 0);
      thigh.rotation.z = sx * 1.0;
      hip.add(thigh);
      const knee = new THREE.Group();
      knee.position.set(sx * 0.2, -0.14, 0);
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.022, 0.24, 5), dark);
      shin.position.y = -0.11;
      knee.add(shin);
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 4), under);
      claw.position.y = -0.24;
      claw.rotation.x = Math.PI;
      knee.add(claw);
      hip.add(knee);
      hip.userData.lower = knee;
      legs[`leg${sx > 0 ? 'R' : 'L'}${i}`] = hip;
    }
  }

  g.userData = { kind: 'beetle', body, head, ...elytra, ...mandibles, ...legs, accent };
  return mergeStaticMeshes(g);
}

/**
 * Spark Wisp — a floating mote that never touches the ground.
 *
 * All glow and no mass. It reads as fragile because it is: it has a fraction of
 * anything else's health and dies to a stiff breeze, and the payoff is a rate of
 * fire nothing else comes close to.
 */
export function buildWispModel({ color = 0x8fd8ff, accent = 0x8fd8ff, trophies = 0 } = {}) {
  const g = new THREE.Group();
  const shellMat = mat(color, { emissive: color, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.4 });
  const glow = mat(accent, { emissive: accent, emissiveIntensity: 2.4, roughness: 0.2 });

  const body = new THREE.Group();
  body.position.y = 1.05;
  g.add(body);

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), glow);
  body.add(core);
  const husk = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), shellMat);
  husk.material = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.5, roughness: 0.3,
    transparent: true, opacity: 0.45, flatShading: true,
  });
  body.add(husk);

  // Two rings on different axes, so it never looks static.
  const rings = new THREE.Group();
  // Both rings glow. A dark one reads as a tyre hanging in mid-air.
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.028, 4, 16), shellMat);
  ringA.rotation.x = Math.PI / 2;
  rings.add(ringA);
  const ringB = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.024, 4, 14), glow);
  ringB.rotation.set(0.9, 0.4, 0);
  rings.add(ringB);
  body.add(rings);

  // Shards orbiting the core, one per pair of items carried.
  const shards = new THREE.Group();
  const shardCount = 3 + Math.min(5, Math.floor(trophies / 2));
  for (let i = 0; i < shardCount; i++) {
    const a = (i / shardCount) * Math.PI * 2;
    const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), shellMat);
    s.position.set(Math.cos(a) * 0.42, Math.sin(a * 2) * 0.1, Math.sin(a) * 0.42);
    s.rotation.set(a, a * 1.7, 0);
    shards.add(s);
  }
  body.add(shards);

  // A ragged tail of motes trailing underneath.
  const tail = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(new THREE.TetrahedronGeometry(0.07 - i * 0.012), glow);
    m.position.set(0, -0.28 - i * 0.16, 0);
    tail.add(m);
  }
  body.add(tail);

  g.userData = { kind: 'wisp', body, core, husk, rings, shards, tail, flying: true, accent };
  return g;
}

/**
 * Aegis Shell — a slow walking bunker.
 *
 * Almost no damage of its own. What it is for is standing between you and the
 * arena: it has more health than anything else you can own and it hands that
 * durability to the party as barrier, so it is a purchase you make to change
 * how much punishment the *group* can absorb.
 */
export function buildShellModel({ color = 0x4a5a6a, accent = 0x6fd0ff, trophies = 0 } = {}) {
  const g = new THREE.Group();
  const plate = mat(color, { roughness: 0.6, metalness: 0.4, flat: true });
  const rim = mat(new THREE.Color(color).offsetHSL(0, -0.05, 0.14).getHex(), { roughness: 0.45, metalness: 0.6 });
  const hide = mat(0x6a6252, { roughness: 0.85, flat: true });
  const glow = mat(accent, { emissive: accent, emissiveIntensity: 1.9, roughness: 0.3 });

  const body = new THREE.Group();
  body.position.y = 0.46;
  g.add(body);

  // Hexagonal carapace: one broad dome ringed by a skirt of plates.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.62, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), plate);
  dome.scale.set(1, 0.68, 1.12);
  dome.castShadow = true;
  body.add(dome);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.6, 0.14, 8), rim);
  skirt.scale.z = 1.12;
  skirt.position.y = -0.02;
  body.add(skirt);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const stud = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.16, 4), rim);
    stud.position.set(Math.cos(a) * 0.5, 0.24, Math.sin(a) * 0.56);
    stud.rotation.set(Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5);
    body.add(stud);
  }

  // The rune ring is the tell: it brightens as the guard pulse charges.
  const runes = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.2), glow);
    r.position.set(Math.cos(a) * 0.3, 0.38, Math.sin(a) * 0.34);
    r.rotation.y = -a;
    runes.add(r);
  }
  body.add(runes);
  for (let i = 0; i < Math.min(6, Math.floor(trophies / 2)); i++) {
    const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), glow);
    c.position.set((i % 2 ? 1 : -1) * 0.22, 0.42 - (i % 3) * 0.04, 0.2 - i * 0.11);
    body.add(c);
  }

  // Head on a stubby neck that pulls in when it guards.
  const neck = new THREE.Group();
  neck.position.set(0, 0.02, 0.5);
  body.add(neck);
  const head = new THREE.Group();
  head.position.z = 0.2;
  neck.add(head);
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.22, 0.3), hide);
  skull.castShadow = true;
  head.add(skull);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.2, 5), rim);
  beak.rotation.x = Math.PI / 2;
  beak.position.z = 0.22;
  head.add(beak);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), glow);
    eye.position.set(sx * 0.1, 0.07, 0.1);
    head.add(eye);
  }

  // Four column legs.
  const legs = {};
  const legAt = (key, x, z) => {
    const hip = new THREE.Group();
    hip.position.set(x, 0.4, z);
    g.add(hip);
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.14, 0.24, 6), hide);
    upper.position.y = -0.12;
    upper.castShadow = true;
    hip.add(upper);
    const knee = new THREE.Group();
    knee.position.y = -0.24;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.14, 6), rim);
    foot.position.y = -0.07;
    knee.add(foot);
    hip.add(knee);
    hip.userData.lower = knee;
    legs[key] = hip;
  };
  legAt('legFL', -0.34, 0.3);
  legAt('legFR', 0.34, 0.3);
  legAt('legBL', -0.36, -0.3);
  legAt('legBR', 0.36, -0.3);

  g.userData = { kind: 'shell', body, neck, head, runes, ...legs, accent };
  return mergeStaticMeshes(g);
}

/** Dispatch: every pet species builds from one entry point. */
export function buildPetSpeciesModel(kind, opts) {
  if (kind === 'beetle') return buildBeetleModel(opts);
  if (kind === 'wisp') return buildWispModel(opts);
  if (kind === 'shell') return buildShellModel(opts);
  return buildLizardModel(opts);
}


/**
 * The rift to the Null Sanctum.
 *
 * A torn oval standing on the ground, black inside, ringed with light. It has
 * to read as "somewhere else" rather than "another teleporter", because the one
 * thing a player must not do is walk into the final fight thinking it is the
 * next stage.
 */
export function buildPortalModel(accent = 0xff2f8f) {
  const g = new THREE.Group();
  const frameMat = mat(0x1a1024, { roughness: 0.5, metalness: 0.6, flat: true });
  const runeMat = mat(accent, { emissive: accent, emissiveIntensity: 2.2, roughness: 0.3 });

  // Broken plinth.
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.1, 0.4, 8), frameMat);
  base.position.y = 0.2;
  base.receiveShadow = true;
  g.add(base);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.1 + (i % 3) * 0.5, 4), frameMat);
    tooth.position.set(Math.cos(a) * 2.5, 0.75, Math.sin(a) * 2.5);
    tooth.rotation.set(Math.cos(a) * 0.24, -a, -Math.sin(a) * 0.24);
    tooth.castShadow = true;
    g.add(tooth);
  }

  // The tear itself: a black sheet behind a ring of light.
  const mouth = new THREE.Group();
  mouth.position.y = 3.1;
  g.add(mouth);
  const voidPane = new THREE.Mesh(
    new THREE.CircleGeometry(2.05, 22),
    new THREE.MeshBasicMaterial({ color: 0x05020a, side: THREE.DoubleSide }),
  );
  voidPane.scale.set(0.78, 1, 1);
  mouth.add(voidPane);

  const rim = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.15, 6, 26), runeMat);
  rim.scale.set(0.78, 1, 1);
  mouth.add(rim);

  const swirl = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5 - i * 0.42, 0.05, 4, 20), runeMat);
    ring.scale.set(0.78, 1, 1);
    ring.position.z = 0.06 + i * 0.05;
    swirl.add(ring);
  }
  mouth.add(swirl);

  const glowPane = new THREE.Mesh(new THREE.CircleGeometry(2.6, 20), glowMat(accent, 0.16));
  glowPane.scale.set(0.78, 1, 1);
  glowPane.position.z = -0.08;
  mouth.add(glowPane);

  // Shards hanging in the air around the tear.
  const motes = new THREE.Group();
  const rng = mulberryLite(53);
  for (let i = 0; i < 14; i++) {
    const a = rng() * Math.PI * 2;
    const r = 2.4 + rng() * 1.6;
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.1 + rng() * 0.14, 0), runeMat);
    m.position.set(Math.cos(a) * r * 0.8, 3.1 + (rng() - 0.5) * 4, Math.sin(a) * 0.6);
    motes.add(m);
  }
  g.add(motes);

  g.userData = { mouth, swirl, rim, motes, glowPane };
  return g;
}

export { mat as material, glowMat, box, cyl, sphere };
