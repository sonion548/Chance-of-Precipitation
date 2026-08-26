import * as THREE from 'three';
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
  const palm = new THREE.Mesh(new THREE.BoxGeometry(scale * 1.6, scale * 1.9, scale * 0.95), materials.trim);
  palm.castShadow = true;
  hand.add(palm);
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(scale * 0.33, scale * 0.85, scale * 0.42), materials.suit);
    f.position.set((i - 1.5) * scale * 0.38, -scale * 1.25, scale * 0.12);
    f.rotation.x = -0.5;
    hand.add(f);
  }
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(scale * 0.36, scale * 0.72, scale * 0.44), materials.suit);
  thumb.position.set(side * scale * 0.85, -scale * 0.75, scale * 0.28);
  thumb.rotation.set(-0.6, 0, side * 0.7);
  hand.add(thumb);
  const knuckle = new THREE.Mesh(new THREE.BoxGeometry(scale * 1.7, scale * 0.34, scale * 0.3), materials.accent);
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

/** Tapered limb segment with a rounded joint cap at the top. */
function limbSegment(len, rTop, rBot, material, joint = null) {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, 8), material);
  shaft.position.y = -len / 2;
  shaft.castShadow = true;
  g.add(shaft);
  if (joint) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(rTop * 0.98, 8, 6), joint);
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
    const foot = new THREE.Mesh(new THREE.BoxGeometry(rBot * 2.3, rBot * 1.0, rBot * 3.0), materials.trim);
    foot.position.set(0, -rBot * 0.4, rBot * 0.75);
    foot.castShadow = true;
    ankle.add(foot);
    const toe = new THREE.Mesh(new THREE.BoxGeometry(rBot * 2.0, rBot * 0.8, rBot * 1.0), materials.suit);
    toe.position.set(0, -rBot * 0.45, rBot * 2.0);
    ankle.add(toe);
    const toeCap = new THREE.Mesh(new THREE.BoxGeometry(rBot * 2.05, rBot * 0.5, rBot * 0.45), materials.accent);
    toeCap.position.set(0, -rBot * 0.3, rBot * 2.4);
    ankle.add(toeCap);
    const heel = new THREE.Mesh(new THREE.BoxGeometry(rBot * 1.9, rBot * 1.2, rBot * 0.8), materials.joint);
    heel.position.set(0, -rBot * 0.3, -rBot * 0.6);
    ankle.add(heel);
    treadSole(ankle, materials.joint, { pos: [0, -rBot * 0.92, rBot * 0.9], w: rBot * 2.2, d: rBot * 3.6, blocks: 5 });
    // Ankle actuator.
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(rBot * 0.22, rBot * 0.22, rBot * 1.4, 6), materials.accent);
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
      new THREE.SphereGeometry(rMid * 1.08, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), materials.trim);
    pad.scale.set(1, 0.5, 1);
    pad.position.set(0, -rMid * 0.15, jointSide * rMid * 0.5);
    pad.rotation.x = jointSide * Math.PI / 2.1;
    pad.castShadow = true;
    low.add(pad);
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(rMid * 0.32, rMid * 0.9, rMid * 0.22), materials.accent);
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
function buildTorso(group, materials, spec) {
  const { width, depth, height, accentColor } = spec;

  const core = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.52, width * 0.46, height, 8), materials.suit);
  core.scale.z = depth / width;
  core.position.y = height * 0.5;
  core.castShadow = true;
  group.add(core);

  const plate = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.55, width * 0.5, height * 0.42, 8), materials.trim);
  plate.scale.z = (depth / width) * 1.04;
  plate.position.y = height * 0.72;
  plate.castShadow = true;
  group.add(plate);

  // Collar ring reads as a neck seal and breaks the shoulder line.
  const collar = new THREE.Mesh(new THREE.TorusGeometry(width * 0.3, width * 0.075, 6, 12), materials.trim);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = height * 0.98;
  group.add(collar);

  const belt = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.5, width * 0.5, height * 0.14, 8), materials.trim);
  belt.scale.z = depth / width;
  belt.position.y = height * 0.12;
  group.add(belt);

  const chestLight = new THREE.Mesh(new THREE.CircleGeometry(width * 0.13, 8), materials.glow);
  chestLight.position.set(0, height * 0.74, depth * 0.53);
  group.add(chestLight);

  const pack = new THREE.Mesh(new THREE.BoxGeometry(width * 0.72, height * 0.5, depth * 0.42), materials.trim);
  pack.position.set(0, height * 0.6, -depth * 0.6);
  pack.castShadow = true;
  group.add(pack);
  boltRow(group, materials.joint, {
    from: [-width * 0.3, height * 0.78, -depth * 0.79],
    to: [width * 0.3, height * 0.78, -depth * 0.79], count: 5, r: 0.018,
  });
  for (const sx of [-1, 1]) {
    const vent = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.09, width * 0.09, height * 0.2, 6), materials.accent);
    vent.position.set(sx * width * 0.26, height * 0.72, -depth * 0.72);
    group.add(vent);
    // Exhaust stack behind the shoulder.
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.055, width * 0.07, height * 0.42, 6), materials.joint);
    stack.position.set(sx * width * 0.4, height * 0.82, -depth * 0.66);
    stack.rotation.x = -0.14;
    stack.castShadow = true;
    group.add(stack);
  }

  // Harness: two straps over the chest plate meeting at a buckle.
  for (const sx of [-1, 1]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(width * 0.13, height * 0.7, depth * 0.1), materials.joint);
    strap.position.set(sx * width * 0.19, height * 0.55, depth * 0.5);
    strap.rotation.z = sx * 0.18;
    group.add(strap);
  }
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(width * 0.22, height * 0.16, depth * 0.14), materials.accent);
  buckle.position.set(0, height * 0.32, depth * 0.53);
  group.add(buckle);

  // Segmented abdominal plates.
  for (let i = 0; i < 3; i++) {
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(width * (0.5 - i * 0.02), width * (0.48 - i * 0.02), height * 0.1, 8),
      materials.trim);
    plate.scale.z = depth / width;
    plate.position.y = height * (0.28 - i * 0.09);
    group.add(plate);
  }

  // Belt pouches and a shoulder pauldron rivet line.
  for (const sx of [-1, 1]) {
    const pouch = new THREE.Mesh(new THREE.BoxGeometry(width * 0.24, height * 0.24, depth * 0.24), materials.joint);
    pouch.position.set(sx * width * 0.44, height * 0.1, depth * 0.28);
    pouch.castShadow = true;
    group.add(pouch);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(width * 0.26, height * 0.07, depth * 0.26), materials.trim);
    flap.position.set(sx * width * 0.44, height * 0.22, depth * 0.28);
    group.add(flap);
  }

  // Cable from the pack around to the chest light.
  cableRun(group, materials.joint,
    [width * 0.28, height * 0.7, -depth * 0.5], [width * 0.16, height * 0.74, depth * 0.44], 0.1, 6, width * 0.035);
  return core;
}

/** Helmet with a wrapped visor band. */
function buildHead(parent, materials, spec) {
  const head = new THREE.Group();
  head.position.y = spec.y;

  const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(spec.r, 1), materials.suit);
  skull.scale.set(1, 1.06, 0.96);
  skull.castShadow = true;
  head.add(skull);

  const crest = new THREE.Mesh(new THREE.CylinderGeometry(spec.r * 0.92, spec.r * 0.86, spec.r * 0.5, 8), materials.trim);
  crest.position.y = spec.r * 0.62;
  crest.castShadow = true;
  head.add(crest);

  // Comms boom and mic.
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(spec.r * 0.05, spec.r * 0.05, spec.r * 0.9, 5), materials.joint);
  boom.position.set(spec.r * 0.55, -spec.r * 0.08, spec.r * 0.32);
  boom.rotation.set(0.5, 0, 0.9);
  head.add(boom);
  const mic = new THREE.Mesh(new THREE.SphereGeometry(spec.r * 0.11, 6, 5), materials.accent);
  mic.position.set(spec.r * 0.2, -spec.r * 0.3, spec.r * 0.6);
  head.add(mic);

  // Filter canisters at the jaw.
  for (const sx of [-1, 1]) {
    const filter = new THREE.Mesh(new THREE.CylinderGeometry(spec.r * 0.19, spec.r * 0.19, spec.r * 0.3, 7), materials.joint);
    filter.position.set(sx * spec.r * 0.62, -spec.r * 0.2, spec.r * 0.3);
    filter.rotation.z = Math.PI / 2;
    head.add(filter);
  }

  // Vent slots along the crown, and a stubby antenna.
  ventStack(head, materials.joint, {
    pos: [0, spec.r * 0.86, 0], count: 3, size: [spec.r * 1.0, spec.r * 0.07, spec.r * 0.16], spacing: spec.r * 0.24,
  });
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(spec.r * 0.035, spec.r * 0.05, spec.r * 1.1, 5), materials.joint);
  antenna.position.set(-spec.r * 0.6, spec.r * 0.75, -spec.r * 0.25);
  antenna.rotation.z = 0.24;
  head.add(antenna);
  // Tip light on the antenna.
  //
  // This was written as `head.add(mesh).position.set(...)`. Object3D.add returns
  // the PARENT, so that line moved the entire head down to the antenna tip's
  // coordinates — inside the torso — and the character rendered headless.
  const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(spec.r * 0.06, 6, 5), materials.glow);
  antennaTip.position.set(-spec.r * 0.73, spec.r * 1.28, -spec.r * 0.25);
  head.add(antennaTip);

  // Brow ridge above the visor.
  const brow = new THREE.Mesh(new THREE.BoxGeometry(spec.r * 1.5, spec.r * 0.16, spec.r * 0.4), materials.trim);
  brow.position.set(0, spec.r * 0.34, spec.r * 0.5);
  head.add(brow);

  // Visor is a torus arc, so it wraps the face instead of sitting on it flat.
  const visor = new THREE.Mesh(new THREE.TorusGeometry(spec.r * 0.72, spec.r * 0.2, 6, 14, Math.PI * 0.95), materials.visor);
  visor.rotation.set(Math.PI / 2, 0, Math.PI * 0.52);
  visor.position.set(0, spec.r * 0.05, spec.r * 0.2);
  head.add(visor);

  parent.add(head);
  return head;
}

const characterMaterials = (char) => ({
  suit: mat(char.color, { roughness: 0.52, metalness: 0.45 }),
  trim: mat(new THREE.Color(char.color).offsetHSL(0, -0.04, 0.13).getHex(), { roughness: 0.38, metalness: 0.66 }),
  joint: mat(0x1c202b, { roughness: 0.7, metalness: 0.4 }),
  accent: mat(char.accent, { emissive: char.accent, emissiveIntensity: 0.85, roughness: 0.4 }),
  glow: new THREE.MeshStandardMaterial({
    color: char.accent, emissive: char.accent, emissiveIntensity: 2.2, roughness: 0.3, metalness: 0.4,
  }),
  visor: new THREE.MeshStandardMaterial({
    color: char.visor, emissive: char.visor, emissiveIntensity: 2.4, roughness: 0.18, metalness: 0.7,
  }),
});

export function buildPlayerModel(char) {
  const g = new THREE.Group();
  const m = characterMaterials(char);
  const build = char.build || 'vanguard';

  // Proportions per build — the silhouette is what tells them apart at range.
  const P = {
    vanguard: { w: 0.62, d: 0.4, torso: 0.68, hipY: 0.86, headR: 0.23, armR: [0.11, 0.095, 0.085], legR: [0.14, 0.12, 0.1], shoulder: 0.36 },
    unloader: { w: 0.86, d: 0.52, torso: 0.72, hipY: 0.9, headR: 0.24, armR: [0.16, 0.14, 0.12], legR: [0.19, 0.16, 0.13], shoulder: 0.5 },
    wraith:   { w: 0.5,  d: 0.34, torso: 0.7, hipY: 0.92, headR: 0.21, armR: [0.085, 0.075, 0.065], legR: [0.11, 0.095, 0.08], shoulder: 0.3 },
    bulwark:  { w: 0.8,  d: 0.5, torso: 0.66, hipY: 0.84, headR: 0.23, armR: [0.14, 0.125, 0.11], legR: [0.18, 0.155, 0.13], shoulder: 0.46 },
    halcyon:  { w: 0.54, d: 0.36, torso: 0.66, hipY: 0.9, headR: 0.22, armR: [0.095, 0.085, 0.072], legR: [0.12, 0.1, 0.085], shoulder: 0.33 },
    dasher:   { w: 0.54, d: 0.35, torso: 0.72, hipY: 0.94, headR: 0.21, armR: [0.092, 0.082, 0.07], legR: [0.125, 0.105, 0.086], shoulder: 0.32 },
    chain:    { w: 0.56, d: 0.37, torso: 0.7, hipY: 0.9, headR: 0.22, armR: [0.098, 0.088, 0.075], legR: [0.13, 0.11, 0.09], shoulder: 0.33 },
  }[build] || {
    w: 0.62, d: 0.4, torso: 0.68, hipY: 0.86, headR: 0.23,
    armR: [0.11, 0.095, 0.085], legR: [0.14, 0.12, 0.1], shoulder: 0.36,
  };

  // --- legs (parented to a pelvis so the hips can counter-rotate) ---
  const pelvis = new THREE.Group();
  pelvis.position.y = P.hipY;
  g.add(pelvis);
  const hipPlate = new THREE.Mesh(new THREE.CylinderGeometry(P.w * 0.42, P.w * 0.36, 0.24, 8), m.trim);
  hipPlate.scale.z = 0.8;
  hipPlate.castShadow = true;
  pelvis.add(hipPlate);
  const legSpec = { upper: 0.44, lower: 0.42, rTop: P.legR[0], rMid: P.legR[1], rBot: P.legR[2], foot: true, pad: true };
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
  buildTorso(torso, m, { width: P.w, depth: P.d, height: P.torso, accentColor: char.accent });

  const head = buildHead(torso, m, { y: P.torso * 1.24, r: P.headR });

  // --- arms ---
  const armSpec = { upper: 0.34, lower: 0.32, rTop: P.armR[0], rMid: P.armR[1], rBot: P.armR[2], hand: true, pad: true };
  const armL = articulatedLimb(torso, -P.shoulder, P.torso * 0.82, 0, { ...armSpec, side: -1 }, m);
  const armR = articulatedLimb(torso, P.shoulder, P.torso * 0.82, 0, { ...armSpec, side: 1 }, m);
  armR.rotation.x = -1.15;
  armL.rotation.x = -0.85;
  // Negative bends the forearm forward, which is the direction an elbow goes.
  // These were positive, which folded both arms backwards at the elbow.
  armR.userData.lower.rotation.x = -0.45;
  armL.userData.lower.rotation.x = -0.6;

  // Pauldrons: the single biggest readability win at distance.
  for (const [side, arm] of [[-1, armL], [1, armR]]) {
    const pauldron = new THREE.Mesh(
      new THREE.SphereGeometry(P.armR[0] * 1.32, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55),
      m.trim,
    );
    pauldron.position.set(side * P.shoulder * 1.04, P.torso * 0.8, 0);
    pauldron.rotation.z = side * 0.24;
    pauldron.castShadow = true;
    torso.add(pauldron);
  }

  /* Anything a build wants the game to be able to reach later is declared out
     here, because `g.userData` is replaced wholesale further down and a handle
     stashed on it from inside the switch does not survive. */
  let hatNode = null;

  // --- per-build signature hardware ---
  switch (build) {
    case 'unloader': {
      // Oversized gauntlet on the punching arm, hook launcher on the other.
      // Gauntlet: forearm sleeve, a fist mass, and knuckle plates that catch light.
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(P.armR[2] * 1.9, P.armR[2] * 2.3, 0.26, 8), m.accent);
      sleeve.position.y = -0.2;
      sleeve.castShadow = true;
      armR.userData.lower.add(sleeve);

      const fist = new THREE.Mesh(new THREE.IcosahedronGeometry(P.armR[2] * 2.5, 1), m.trim);
      fist.scale.set(1, 0.92, 1.05);
      fist.position.y = -0.44;
      fist.castShadow = true;
      armR.userData.lower.add(fist);

      for (let k = 0; k < 3; k++) {
        const knuckle = new THREE.Mesh(new THREE.SphereGeometry(P.armR[2] * 0.72, 6, 5), m.glow);
        knuckle.position.set((k - 1) * P.armR[2] * 1.25, -0.5, P.armR[2] * 2.1);
        armR.userData.lower.add(knuckle);
      }
      const piston = new THREE.Mesh(new THREE.CylinderGeometry(P.armR[2] * 0.5, P.armR[2] * 0.5, 0.3, 6), m.glow);
      piston.position.set(0, -0.24, -P.armR[2] * 1.7);
      armR.userData.lower.add(piston);

      const launcher = new THREE.Mesh(new THREE.BoxGeometry(P.armR[2] * 2.4, P.armR[2] * 2.2, 0.42), m.trim);
      launcher.position.set(0, -0.26, 0.12);
      launcher.castShadow = true;
      armL.userData.lower.add(launcher);
      const hookTip = new THREE.Mesh(new THREE.ConeGeometry(P.armR[2] * 0.9, 0.16, 5), m.accent);
      hookTip.rotation.x = Math.PI / 2;
      hookTip.position.set(0, -0.26, 0.36);
      armL.userData.lower.add(hookTip);

      // Exo-frame ribs across the chest.
      for (let i = 0; i < 3; i++) {
        const rib = new THREE.Mesh(new THREE.TorusGeometry(P.w * 0.46, 0.028, 4, 10, Math.PI), m.accent);
        rib.rotation.set(Math.PI / 2, 0, 0);
        rib.position.y = P.torso * (0.4 + i * 0.16);
        torso.add(rib);
      }
      break;
    }
    case 'wraith': {
      // Hooded cowl and a trailing mantle.
      const cowl = new THREE.Mesh(
        new THREE.SphereGeometry(P.headR * 1.5, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), m.trim);
      cowl.position.y = P.headR * 0.24;
      cowl.rotation.x = -0.18;
      head.add(cowl);
      const mantle = new THREE.Mesh(new THREE.ConeGeometry(P.w * 0.62, 0.9, 7, 1, true), m.trim);
      mantle.position.set(0, P.torso * 0.5, -P.d * 0.4);
      mantle.rotation.x = 0.22;
      torso.add(mantle);
      for (let i = 0; i < 4; i++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.26, 4), m.accent);
        spike.position.set((i - 1.5) * 0.13, P.torso * 0.98, -P.d * 0.52);
        spike.rotation.x = -0.5;
        torso.add(spike);
      }
      break;
    }
    case 'bulwark': {
      // Tower shield strapped to the off arm.
      // Tower shield: a hexagonal slab standing upright, facing forward.
      const shield = new THREE.Group();
      const face = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.5, 0.12, 6), m.trim);
      face.rotation.x = Math.PI / 2;      // flat side toward +Z
      face.castShadow = true;
      face.receiveShadow = true;
      shield.add(face);

      const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.38, 0.14, 6), m.suit);
      inner.rotation.x = Math.PI / 2;
      inner.position.z = 0.02;
      shield.add(inner);

      const boss = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), m.glow);
      boss.position.z = 0.12;
      shield.add(boss);

      const edge = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.05, 4, 6), m.accent);
      edge.position.z = 0.01;
      shield.add(edge);

      // Ribs radiating from the boss.
      for (let i = 0; i < 3; i++) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, 0.06), m.accent);
        rib.position.z = 0.08;
        rib.rotation.z = (i / 3) * Math.PI;
        shield.add(rib);
      }

      shield.position.set(-0.12, -0.36, 0.3);
      shield.rotation.set(0, -0.18, 0);
      armL.userData.lower.add(shield);

      const backplate = new THREE.Mesh(new THREE.CylinderGeometry(P.w * 0.5, P.w * 0.44, P.torso * 0.7, 6), m.trim);
      backplate.scale.z = 0.4;
      backplate.position.set(0, P.torso * 0.6, -P.d * 0.78);
      torso.add(backplate);
      break;
    }
    case 'halcyon': {
      // Everything about this silhouette is thrust: a backpack with two
      // gimballed nozzles, wing vanes off the shoulders, and a bomb rack.
      const pack = new THREE.Mesh(new THREE.BoxGeometry(P.w * 0.78, P.torso * 0.62, 0.24), m.trim);
      pack.position.set(0, P.torso * 0.62, -P.d * 0.72);
      pack.castShadow = true;
      torso.add(pack);

      for (const sx of [-1, 1]) {
        // Nozzle: a cone pointing down, with the flame plate inside it lit.
        const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.26, 8, 1, true), m.trim);
        nozzle.position.set(sx * P.w * 0.34, P.torso * 0.3, -P.d * 0.74);
        nozzle.rotation.x = -0.24;
        nozzle.castShadow = true;
        torso.add(nozzle);
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.2, 7), m.glow);
        flame.position.set(sx * P.w * 0.34, P.torso * 0.18, -P.d * 0.72);
        flame.rotation.x = Math.PI;
        torso.add(flame);

        // Wing vane: a swept blade off the shoulder, canted for lift.
        const vane = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.17), m.accent);
        vane.position.set(sx * (P.shoulder + 0.26), P.torso * 0.86, -P.d * 0.3);
        vane.rotation.set(0.1, sx * 0.34, sx * -0.42);
        vane.castShadow = true;
        torso.add(vane);
        const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.24, 5), m.trim);
        strut.position.set(sx * (P.shoulder + 0.1), P.torso * 0.84, -P.d * 0.2);
        strut.rotation.z = Math.PI / 2;
        torso.add(strut);
      }

      // Bomb rack across the belly: three little ordnance eggs.
      for (let i = 0; i < 3; i++) {
        const bomb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 7, 6), m.accent);
        bomb.position.set((i - 1) * 0.17, P.torso * 0.22, P.d * 0.52);
        bomb.scale.z = 1.5;
        torso.add(bomb);
      }

      // Flight visor: a wraparound band rather than a slit.
      const band = new THREE.Mesh(new THREE.TorusGeometry(P.headR * 0.95, 0.03, 4, 12, Math.PI), m.glow);
      band.rotation.set(0, 0, Math.PI);
      band.position.set(0, 0.02, P.headR * 0.3);
      head.add(band);
      break;
    }
    case 'dasher': {
      /* Matte black, and the only thing you can actually see is the discharge.
       *
       * The plate itself is nearly the background colour, so the silhouette has
       * to be carried entirely by light: a soft additive shell around the body,
       * a harder rim just off the chest, and lit edges wherever the frame has
       * one. Two nested BackSide shells rather than one, because a single shell
       * reads as a bubble and two read as falloff. `depthWrite: false` keeps
       * them from punching a hole in whatever is drawn behind them, and neither
       * one merges with anything because both own their material. */
      const auraColor = new THREE.Color(char.accent);
      for (const [radius, opacity] of [[0.92, 0.15], [1.22, 0.055]]) {
        const shell = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 14, 12),
          new THREE.MeshBasicMaterial({
            color: auraColor, transparent: true, opacity,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
          }),
        );
        shell.scale.set(1, 1.15, 1);
        shell.position.y = P.torso * 0.35;
        torso.add(shell);
      }
      // A hard ring around the chest: the aura wants an edge somewhere or it
      // is just a smudge the character is standing inside.
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(P.w * 0.92, 0.022, 4, 20),
        new THREE.MeshBasicMaterial({
          color: auraColor, transparent: true, opacity: 0.5,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = P.torso * 0.5;
      torso.add(halo);

      // Everything on this frame is either a spear or a way of going faster.
      // A quiver across the back, lit strips down the shins, and a sash that
      // reads as speed even standing still.
      const quiver = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.085, 0.6, 7), m.trim);
      quiver.position.set(-P.w * 0.3, P.torso * 0.62, -P.d * 0.6);
      quiver.rotation.set(0.2, 0, -0.42);
      quiver.castShadow = true;
      torso.add(quiver);
      for (let i = 0; i < 3; i++) {
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.95, 5), m.suit);
        shaft.position.set(-P.w * 0.3 + (i - 1) * 0.045, P.torso * 0.88, -P.d * 0.66);
        shaft.rotation.set(0.2, 0, -0.42);
        torso.add(shaft);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.034, 0.14, 5), m.glow);
        tip.position.set(-P.w * 0.3 + (i - 1) * 0.045 + 0.2, P.torso * 1.32, -P.d * 0.56);
        tip.rotation.set(0.2, 0, -0.42);
        torso.add(tip);
      }

      // Sprinter's greaves and heel blades: the legs are the character.
      for (const leg of [legL, legR]) {
        const greave = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.32, 0.03), m.glow);
        greave.position.set(0, -0.2, P.legR[2] * 1.5);
        leg.userData.lower.add(greave);
        const blade = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 4), m.accent);
        blade.position.set(0, -0.3, -P.legR[2] * 1.9);
        blade.rotation.x = -0.5;
        leg.userData.lower.add(blade);
      }

      // Trailing sash, lit rather than painted — on a black frame an accent
      // that only reflects is an accent nobody ever sees.
      const sash = new THREE.Mesh(new THREE.ConeGeometry(P.w * 0.4, 0.78, 6, 1, true), m.glow);
      sash.position.set(0, P.torso * 0.42, -P.d * 0.46);
      sash.rotation.x = 0.3;
      torso.add(sash);

      // Lit edge along each pauldron and down the outside of each thigh, so the
      // shape still resolves at range with no light on it at all.
      for (const sx of [-1, 1]) {
        const edge = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, P.d * 1.5), m.glow);
        edge.position.set(sx * P.shoulder * 1.12, P.torso * 0.84, 0);
        torso.add(edge);
      }
      for (const leg of [legL, legR]) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.4, 0.028), m.glow);
        stripe.position.set(leg.userData.outZ * P.legR[0] * 1.05, -0.2, 0);
        leg.add(stripe);
      }

      // Vents down the ribs — the frame is mostly cooling and almost no armour.
      ventStack(torso, m.trim, {
        pos: [P.w * 0.44, P.torso * 0.5, 0], count: 4, size: [0.014, 0.09, 0.05], spacing: 0.075,
      });
      ventStack(torso, m.trim, {
        pos: [-P.w * 0.44, P.torso * 0.5, 0], count: 4, size: [0.014, 0.09, 0.05], spacing: 0.075,
      });

      // Single-eye visor slit: nothing on this head but the part that aims.
      const slit = new THREE.Mesh(new THREE.BoxGeometry(P.headR * 1.5, 0.035, 0.03), m.glow);
      slit.position.set(0, 0.015, P.headR * 0.92);
      head.add(slit);
      break;
    }
    case 'chain': {
      /* A straw hat and a robe, and almost no hardware.
       *
       * Every other silhouette in the descent is plate and thrusters, so this
       * one is deliberately cloth: the read at range is a wide flat disc where
       * the head should be and a cone where the legs should be. Both are built
       * from their own materials rather than the suit's, because a straw hat
       * that takes the character's metalness stops looking like straw. */
      const straw = mat(0xd8b877, { roughness: 0.94, metalness: 0.02 });
      const strawDark = mat(0xa8863f, { roughness: 0.95, metalness: 0.02 });
      const cloth = mat(char.color, { roughness: 0.92, metalness: 0.03 });

      // --- straw hat: a wide conical brim, a crown, and a band ---
      const hat = new THREE.Group();
      const brim = new THREE.Mesh(new THREE.ConeGeometry(P.headR * 2.9, 0.14, 14, 1, true), straw);
      brim.position.y = P.headR * 0.42;
      brim.castShadow = true;
      hat.add(brim);
      // A second, shallower cone closes the top of the brim so it is not a
      // hollow funnel when you look down on it.
      const crown = new THREE.Mesh(new THREE.ConeGeometry(P.headR * 1.15, P.headR * 1.5, 14), straw);
      crown.position.y = P.headR * 1.05;
      crown.castShadow = true;
      hat.add(crown);
      const band = new THREE.Mesh(new THREE.TorusGeometry(P.headR * 1.06, 0.026, 4, 14), strawDark);
      band.rotation.x = Math.PI / 2;
      band.position.y = P.headR * 0.5;
      hat.add(band);
      // Weave lines radiating out across the brim.
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, P.headR * 1.7), strawDark);
        rib.position.set(Math.cos(a) * P.headR * 1.4, P.headR * 0.44, Math.sin(a) * P.headR * 1.4);
        rib.rotation.y = -a;
        hat.add(rib);
      }
      hat.position.y = P.headR * 0.35;
      head.add(hat);
      // Named so the hat-throw can take it off him — see `Combat._tickHat`.
      hatNode = hat;

      // --- robe: one long cone from the shoulders past the knees ---
      const robe = new THREE.Mesh(
        new THREE.ConeGeometry(P.w * 1.15, P.torso + P.hipY * 0.78, 9, 1, true), cloth,
      );
      robe.position.y = P.torso * 0.52 - P.hipY * 0.36;
      robe.castShadow = true;
      torso.add(robe);
      // Open front: two lapels laid over the cone so it reads as a garment
      // rather than a traffic cone somebody is standing in.
      for (const sx of [-1, 1]) {
        const lapel = new THREE.Mesh(new THREE.BoxGeometry(0.14, P.torso * 1.15, 0.04), m.trim);
        lapel.position.set(sx * P.w * 0.2, P.torso * 0.3, P.d * 0.58);
        lapel.rotation.z = sx * 0.1;
        torso.add(lapel);
      }
      // Sash at the waist, and the knot hanging off it.
      const sash = new THREE.Mesh(new THREE.TorusGeometry(P.w * 0.56, 0.05, 5, 14), m.accent);
      sash.rotation.x = Math.PI / 2;
      sash.position.y = P.torso * 0.06;
      sash.scale.z = 0.78;
      torso.add(sash);
      const knot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.06), m.accent);
      knot.position.set(P.w * 0.32, -P.torso * 0.18, P.d * 0.5);
      knot.rotation.z = 0.22;
      torso.add(knot);

      // Wide sleeves over the upper arms — cloth, not plate.
      for (const arm of [armL, armR]) {
        const sleeve = new THREE.Mesh(new THREE.ConeGeometry(P.armR[0] * 2.1, 0.34, 7, 1, true), cloth);
        sleeve.position.y = -0.14;
        arm.add(sleeve);
      }

      // Under the brim there is nothing but the visor line.
      const shade = new THREE.Mesh(new THREE.BoxGeometry(P.headR * 1.2, 0.03, 0.03), m.glow);
      shade.position.set(0, -0.02, P.headR * 0.9);
      head.add(shade);
      break;
    }
    default: {
      // Vanguard: utility pouches and a shoulder lamp.
      for (const sx of [-1, 1]) {
        const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.12), m.trim);
        pouch.position.set(sx * P.w * 0.42, P.torso * 0.2, P.d * 0.3);
        torso.add(pouch);
      }
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.14, 6), m.glow);
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
export function buildHatModel(accent = 0x9dff6a, scale = 1) {
  const g = new THREE.Group();
  const straw = mat(0xd8b877, { roughness: 0.94, metalness: 0.02 });
  const strawDark = mat(0xa8863f, { roughness: 0.95, metalness: 0.02 });
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
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.062 * scale, 0.014 * scale, 4, 10, Math.PI), dark);
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
    const rear = new THREE.Mesh(new THREE.TorusGeometry(0.022 * scale, 0.008 * scale, 4, 10), dark);
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
      const loop = new THREE.Mesh(new THREE.TorusGeometry(0.026 * scale, 0.008 * scale, 4, 8), steel);
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
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.062 - i * 0.006, 0.016, 4, 12), accent);
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
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.02, 4, 14), dark);
        band.rotation.y = Math.PI / 2;
        band.rotation.x = Math.PI / 2;
        band.position.z = z;
        g.add(band);
      }
      const flare = cyl(0.19, 0.14, 0.16, 12, steel, 0, 0, 0.68);
      flare.rotation.x = Math.PI / 2;
      g.add(flare);
      const muzzleRing = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 4, 16), accent);
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
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.014, 0.012, 4, 12), accent);
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
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.014, 4, 12), steel);
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
      const iris = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 4, 14), hot);
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
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 4, 12), steel);
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
        const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.043, 0.009, 4, 10), dark);
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
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), glowMat(weapon.color, 0.7));
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
