import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { characterSurfaces, makeCharacterMaterial } from '../world/textures.js';

/**
 * Authored character meshes, rigged at load time.
 *
 * Everything else in this game is generated from primitives. These are not:
 * they are modelled elsewhere and shipped as glTF. What they arrive without is
 * a skeleton — the Halcyon mesh is one welded shell of 33k triangles, no bones,
 * no animation, one flat grey material — so this module does the three jobs
 * that stand between a static export and a character you can play:
 *
 *   1. fits a skeleton to the mesh, measured from its own geometry
 *   2. skins every vertex to it with smooth falloff weights
 *   3. paints it, by region, in the character's palette
 *
 * The skeleton it fits is not arbitrary. `characterRig.js` animates whatever it
 * finds under `model.userData` — `torso`, `head`, `armL.userData.lower`,
 * `legR.userData.ankle` and so on — and never asks what those objects *are*.
 * So the bones are given exactly that shape, and the entire existing animation
 * system (gait blending, aim tracking, the six attack poses, flight) drives an
 * authored mesh without a line of it changing.
 */

/* ------------------------------------------------------------------ skeleton spec */
/**
 * Where the joints are, in the model's own space, after recentring.
 *
 * Measured off the mesh rather than guessed: horizontal slabs were clustered in
 * (x, z) to separate the limbs from the wings, which is the only way to find an
 * arm in a shell that also contains six blades passing through the same heights.
 * `head` and `tail` are the ends of the bone; weights come from distance to that
 * segment, so a bone is a capsule of influence rather than a point.
 */
const HALCYON_RIG = {
  /* The mesh is modelled symmetric about x = +0.075 rather than 0, so it is
     shifted onto its own centreline before anything else happens. */
  recentre: [-0.075, 0, 0],
  hipY: 0.95,
  bones: [
    { name: 'pelvis', parent: null,   head: [0, 0.95, 0.02],     tail: [0, 1.05, 0.00] },
    { name: 'torso',  parent: 'pelvis', head: [0, 0.95, 0.02],   tail: [0, 1.44, -0.02] },
    { name: 'head',   parent: 'torso',  head: [0, 1.56, 0.00],   tail: [0, 1.88, 0.03] },

    /* `bind` is the rotation the bone is bound at, and it is not zero for the
       arms on purpose — see the note on BIND POSE below. These are the exact
       values `poseArms` settles an idle character on. */
    { name: 'armL',      parent: 'torso', head: [-0.22, 1.38, 0.02], tail: [-0.305, 1.14, 0.10],
      bind: [0.4, 0.16, -0.9] },
    { name: 'armLlower', parent: 'armL',  head: [-0.305, 1.14, 0.10], tail: [-0.385, 0.92, 0.17],
      bind: [-0.24, 0, 0] },
    { name: 'armR',      parent: 'torso', head: [0.22, 1.38, 0.02],  tail: [0.305, 1.14, 0.10],
      bind: [0.4, -0.16, 0.9] },
    { name: 'armRlower', parent: 'armR',  head: [0.305, 1.14, 0.10], tail: [0.385, 0.92, 0.17],
      bind: [-0.24, 0, 0] },

    { name: 'legL',       parent: 'pelvis', head: [-0.12, 0.95, 0.02], tail: [-0.145, 0.60, 0.11] },
    { name: 'legLlower',  parent: 'legL',   head: [-0.145, 0.60, 0.11], tail: [-0.145, 0.22, -0.15] },
    { name: 'legLankle',  parent: 'legLlower', head: [-0.145, 0.22, -0.15], tail: [-0.145, 0.03, -0.09] },
    { name: 'legR',       parent: 'pelvis', head: [0.12, 0.95, 0.02],  tail: [0.13, 0.60, 0.10] },
    { name: 'legRlower',  parent: 'legR',   head: [0.13, 0.60, 0.10],  tail: [0.10, 0.22, -0.16] },
    { name: 'legRankle',  parent: 'legRlower', head: [0.10, 0.22, -0.16], tail: [0.10, 0.03, -0.10] },
  ],
  /* The wings are part of the same welded shell, so they cannot be split off —
     but they should not be split off. They grow from the upper back, so binding
     them to the chest is both the easy answer and the right one: they bank when
     the body banks and stay where they were bolted. Anything behind and above
     this line goes to `torso` no matter which bone is geometrically nearest,
     which stops a blade sweeping past a knee from being weighted to that knee. */
  wing: { minY: 0.18, behind: -0.16, outward: 0.30, bone: 'torso' },
  region(cx, cy, cz) {
    const wing = cy > 0.18 && (cz < -0.16 || Math.abs(cx) > 0.30) && Math.abs(cx) > 0.2;
    /* A band across the front of the head. Measured off the mesh: the skull
       runs roughly 1.62–1.88 and its front face peaks at z ≈ 0.25, so the eye
       line sits well forward — an earlier pass at z > 0.10 painted the crown. */
    const visor = !wing && cy > 1.665 && cy < 1.755 && cz > 0.185 && Math.abs(cx) < 0.115;
    return visor ? 2 : wing ? 1 : 0;
  },
  materials(char) {
    const S = characterSurfaces();
    return [
      // Airframe: the white shell, panelled like every other precision frame.
      makeCharacterMaterial(S.tech, {
        color: char.color, roughness: 0.52, metalness: 0.34, scale: 5.6,
      }),
      // Wings: lit from inside, the way the sheet draws them.
      makeCharacterMaterial(S.tech, {
        color: char.accent, emissive: char.accent, emissiveIntensity: 0.85,
        roughness: 0.34, metalness: 0.2, scale: 6.4,
      }),
      new THREE.MeshStandardMaterial({
        color: char.visor, emissive: char.visor, emissiveIntensity: 2.4,
        roughness: 0.18, metalness: 0.7,
      }),
    ];
  },
};

/**
 * Dasher: hooded, wide-stanced, and wearing the one thing the rig has never had
 * to move before — a cape.
 *
 * Measured the same way. The body is modelled symmetric about x = +0.085 and
 * the stance is deliberately wide: the hips are ±0.12 apart and the feet ±0.375,
 * so the legs splay rather than hang. The cape leaves the +X shoulder and
 * trails back to z ≈ −0.6, which is why it needs bones of its own; bound to the
 * chest like Halcyon's wings it would be a plank of cloth welded to his back.
 */
const DASHER_RIG = {
  recentre: [-0.085, 0, -0.03],
  hipY: 0.95,
  bones: [
    { name: 'pelvis', parent: null,    head: [0, 0.95, 0.04],   tail: [0, 1.05, 0.02] },
    { name: 'torso',  parent: 'pelvis', head: [0, 0.95, 0.04],  tail: [0, 1.46, 0.00] },
    { name: 'head',   parent: 'torso',  head: [0, 1.58, 0.02],  tail: [0, 1.89, 0.05] },

    { name: 'armL',      parent: 'torso', head: [-0.22, 1.44, 0.02],  tail: [-0.36, 1.16, 0.04],
      bind: [0.4, 0.16, -0.9] },
    { name: 'armLlower', parent: 'armL',  head: [-0.36, 1.16, 0.04],  tail: [-0.42, 0.93, 0.06],
      bind: [-0.24, 0, 0] },
    { name: 'armR',      parent: 'torso', head: [0.22, 1.44, 0.02],   tail: [0.36, 1.16, 0.04],
      bind: [0.4, -0.16, 0.9] },
    { name: 'armRlower', parent: 'armR',  head: [0.36, 1.16, 0.04],   tail: [0.42, 0.93, 0.06],
      bind: [-0.24, 0, 0] },

    { name: 'legL',       parent: 'pelvis',    head: [-0.12, 0.95, 0.04],  tail: [-0.27, 0.55, 0.00] },
    { name: 'legLlower',  parent: 'legL',      head: [-0.27, 0.55, 0.00],  tail: [-0.36, 0.14, -0.06] },
    { name: 'legLankle',  parent: 'legLlower', head: [-0.36, 0.14, -0.06], tail: [-0.38, 0.02, 0.00] },
    { name: 'legR',       parent: 'pelvis',    head: [0.12, 0.95, 0.04],   tail: [0.29, 0.55, -0.02] },
    { name: 'legRlower',  parent: 'legR',      head: [0.29, 0.55, -0.02],  tail: [0.39, 0.14, -0.14] },
    { name: 'legRankle',  parent: 'legRlower', head: [0.39, 0.14, -0.14],  tail: [0.42, 0.02, -0.08] },

    /* The cape: a three-link chain off the right shoulder blade, following the
       line the cloth is actually modelled along. Chained rather than rigid so
       it can trail — see `swayCape`. */
    { name: 'capeA', parent: 'torso', head: [0.16, 1.42, -0.14], tail: [0.36, 1.20, -0.36] },
    { name: 'capeB', parent: 'capeA', head: [0.36, 1.20, -0.36], tail: [0.53, 0.99, -0.52] },
    { name: 'capeC', parent: 'capeB', head: [0.53, 0.99, -0.52], tail: [0.60, 0.68, -0.56] },
  ],
  // Dasher has no wings; the cape is claimed by its own region test instead.
  wing: { minY: 99, behind: -99, outward: 99, bone: 'torso' },
  cape: { bones: ['capeA', 'capeB', 'capeC'], test: (x, y, z) => x > 0.16 && z < -0.12 && y > 0.35 },
  /* Matte black plate, and everything that is not plate is discharge.
     0 armour · 1 cape · 2 visor · 3 lit trim (hood collar, forearm blades) */
  region(cx, cy, cz) {
    /* Every one of these thresholds is fighting the stance. Dasher is modelled
       with his feet ±0.375 apart, so "outboard" is not on its own a test for
       anything — an early pass called everything past |x| > 0.30 a forearm
       blade and painted both boots teal, and called everything behind z < −0.12
       cape and painted the back of his right leg with it. The tests below are
       all bounded in Y as well, which is what actually separates an arm from
       the leg underneath it. */
    // Cape: outboard, and properly behind — the legs reach z ≈ −0.14, so the
    // cloth has to start further back than that to be told apart from them.
    if (cx > 0.20 && cz < -0.20 && cy > 0.45) return 1;
    // The slot in the mask. Narrow, and set into the front of the hood.
    if (cy > 1.63 && cy < 1.73 && cz > 0.14 && Math.abs(cx) < 0.10) return 2;
    // Collar of the hood where it sits on the shoulders.
    if (cy > 1.42 && cy < 1.60 && cz > -0.16 && Math.hypot(cx, cz) > 0.17) return 3;
    // Forearm blades. Bounded above the knee, or the shins qualify.
    if (cy > 0.80 && cy < 1.12 && Math.abs(cx) > 0.33 && cz > -0.16) return 3;
    return 0;
  },
  materials(char) {
    const S = characterSurfaces();
    return [
      // The plate gives the light back to nobody.
      makeCharacterMaterial(S.tech, {
        color: char.color, roughness: 0.44, metalness: 0.55, scale: 6.2,
      }),
      // Cloth, and the brightest thing on him.
      makeCharacterMaterial(S.cloth, {
        color: char.accent, emissive: char.accent, emissiveIntensity: 1.05,
        roughness: 0.72, metalness: 0.05, scale: 4.6, side: THREE.DoubleSide,
      }),
      new THREE.MeshStandardMaterial({
        color: char.visor, emissive: char.visor, emissiveIntensity: 2.8,
        roughness: 0.16, metalness: 0.6,
      }),
      makeCharacterMaterial(S.tech, {
        color: char.accent, emissive: char.accent, emissiveIntensity: 1.3,
        roughness: 0.34, metalness: 0.4, scale: 7.0,
      }),
    ];
  },
};

const RIGS = { halcyon: HALCYON_RIG, dasher: DASHER_RIG };
const SOURCES = {
  halcyon: './assets/models/halcyon.glb',
  dasher: './assets/models/dasher.glb',
};

/* ------------------------------------------------------------------ skinning */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();

/** Shortest distance from a point to a bone's segment. */
function distToSegment(px, py, pz, head, tail) {
  _p.set(px, py, pz);
  _a.fromArray(head);
  _b.fromArray(tail);
  _ab.subVectors(_b, _a);
  _ap.subVectors(_p, _a);
  const len2 = _ab.lengthSq();
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, _ap.dot(_ab) / len2)) : 0;
  return _p.distanceTo(_a.addScaledVector(_ab, t));
}

/**
 * Per-vertex weights, from distance to each bone segment.
 *
 * Inverse distance raised to a power, keep the best four, normalise. The power
 * is what decides how far a joint's influence bleeds: too low and an elbow drags
 * the whole ribcage with it, too high and the mesh tears at every joint because
 * neighbouring vertices belong to different bones outright. Four is what the
 * standard skinned-mesh shader supports, and is more than enough here.
 */
function computeSkinWeights(positions, spec, boneOrder) {
  const n = positions.length / 3;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const POWER = 4.0;
  const EPS = 1e-4;
  const wingBone = boneOrder.indexOf(spec.wing.bone);
  const capeBones = spec.cape ? spec.cape.bones.map((n) => boneOrder.indexOf(n)) : null;
  const cand = [];

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];

    // A blade sweeping past the legs is still a wing, so claim it before the
    // nearest-bone search can hand it to a knee.
    const isWing = y > spec.wing.minY
      && (z < spec.wing.behind || Math.abs(x) > spec.wing.outward)
      && Math.abs(x) > 0.2;
    if (isWing && wingBone >= 0) {
      skinIndex[i * 4] = wingBone;
      skinWeight[i * 4] = 1;
      continue;
    }

    /* Cloth is claimed too, and for the same reason as a wing: the hem of a
       cape hangs beside a thigh, so nearest-bone would sew it to the leg and
       the cape would kick when he walks. Inside the chain the weights are
       blended between neighbouring links rather than snapped to the closest —
       a cape that switches bone abruptly creases in a hard line across itself,
       which is exactly what cloth does not do. */
    if (capeBones && spec.cape.test(x, y, z)) {
      let best = 0, bestD = Infinity;
      const d = capeBones.map((bi, k) => {
        const bone = spec.bones[bi];
        const dist = distToSegment(x, y, z, bone.head, bone.tail);
        if (dist < bestD) { bestD = dist; best = k; }
        return dist;
      });
      let total = 0;
      const w = d.map((dist) => {
        const v = 1 / Math.pow(Math.max(dist, EPS), 2.0);
        total += v; return v;
      });
      for (let k = 0; k < Math.min(4, capeBones.length); k++) {
        skinIndex[i * 4 + k] = capeBones[k];
        skinWeight[i * 4 + k] = w[k] / total;
      }
      void best;
      continue;
    }

    cand.length = 0;
    for (let b = 0; b < spec.bones.length; b++) {
      const bone = spec.bones[b];
      const d = distToSegment(x, y, z, bone.head, bone.tail);
      cand.push([b, 1 / Math.pow(Math.max(d, EPS), POWER)]);
    }
    cand.sort((p, q) => q[1] - p[1]);
    let total = 0;
    for (let k = 0; k < 4; k++) total += cand[k][1];
    for (let k = 0; k < 4; k++) {
      skinIndex[i * 4 + k] = cand[k][0];
      skinWeight[i * 4 + k] = cand[k][1] / total;
    }
  }
  return { skinIndex, skinWeight };
}

/* ------------------------------------------------------------------ cape */
/**
 * Trails the cape behind whatever the body just did.
 *
 * There is no cloth simulation here and there does not need to be one: a cape
 * reads correctly if it lags the body, lifts with speed and swings when you
 * turn. Each link takes a fraction of the one above it, so the motion runs down
 * the chain and the tip moves furthest — which is the whole visual difference
 * between cloth and a board.
 *
 * `lift` is signed by travel direction rather than raw speed, so backpedalling
 * throws it forward instead of pretending you are still running away.
 */
export function swayCape(model, rig, dt, s) {
  const bones = model.userData?.capeBones;
  if (!bones || !bones.length) return;

  const speed = s.speed ?? Math.hypot(s.velocity.x, s.velocity.z);
  const stride = Math.min(1, speed / Math.max(1, s.moveSpeed || 8));
  const st = model.userData.capeState || (model.userData.capeState = {
    lift: 0, swing: 0, phase: Math.random() * 10,
  });

  st.phase += dt * (1.2 + stride * 2.4);
  // Damp toward the target so a direction change eases rather than snaps.
  const k = 1 - Math.exp(-6 * dt);
  st.lift += ((rig.forward ?? 0) * 0.55 * stride - st.lift) * k;
  st.swing += ((rig.turnRate ?? 0) * 0.5 + (rig.strafe ?? 0) * 0.35 - st.swing) * k;

  const flutter = Math.sin(st.phase) * (0.03 + stride * 0.07);
  bones.forEach((bone, i) => {
    // Each link inherits a little less, so the motion accumulates outward.
    const f = 0.55 + i * 0.28;
    bone.rotation.x = st.lift * f + flutter * f;
    bone.rotation.y = st.swing * f * 0.8;
    bone.rotation.z = Math.sin(st.phase * 0.7 + i) * 0.05 * (0.4 + stride);
  });
}

/* ------------------------------------------------------------------ colour */
/**
 * Which material each triangle belongs to, decided by where it is.
 *
 * The mesh ships as one flat grey material and one welded shell, so there is no
 * object list to read a palette off — the regions have to be inferred. This is
 * position-based and deliberately simple: wings and the shapes that read as
 * thrusters take the lit cyan, the visor band takes the eye colour, and
 * everything else is the white airframe. Three groups is all the concept sheet
 * actually shows.
 */
function assignMaterialGroups(geometry, spec, char) {
  const pos = geometry.attributes.position.array;
  const index = geometry.index ? geometry.index.array : null;
  const triCount = index ? index.length / 3 : pos.length / 9;
  const region = new Uint8Array(triCount);        // 0 airframe, 1 wing, 2 visor

  for (let t = 0; t < triCount; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) {
      const vi = index ? index[t * 3 + k] : t * 3 + k;
      cx += pos[vi * 3]; cy += pos[vi * 3 + 1]; cz += pos[vi * 3 + 2];
    }
    cx /= 3; cy /= 3; cz /= 3;

    region[t] = spec.region(cx, cy, cz);
  }

  // Reorder the index buffer so each region is one contiguous draw group.
  const order = spec.materials(char).map(() => []);
  for (let t = 0; t < triCount; t++) order[region[t]].push(t);
  const out = new (index && index.BYTES_PER_ELEMENT === 4 ? Uint32Array : Uint16Array)(triCount * 3);
  let w = 0;
  geometry.clearGroups();
  order.forEach((tris, r) => {
    const start = w;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) out[w++] = index ? index[t * 3 + k] : t * 3 + k;
    }
    if (w > start) geometry.addGroup(start, w - start, r);
  });
  geometry.setIndex(new THREE.BufferAttribute(out, 1));

  return spec.materials(char);
}

/* ------------------------------------------------------------------ build */
/* ---------------------------------------------------------------- BIND POSE
 * Why the arms are bound rotated.
 *
 * Skinning does not care what pose a mesh was modelled in; it cares about the
 * difference between a bone's current transform and its *bind* transform. The
 * rig, meanwhile, writes absolute rotations — `poseArms` settles an idle
 * character on `rotation.z = ±0.9`, and it does so because a procedural arm is
 * built pointing straight down and needs swinging out to look relaxed.
 *
 * This mesh's arms are already modelled hanging down and out. Bind them at
 * zero and the rig's idle pose adds its 0.9 on top of the twenty degrees the
 * sculptor already put there, and the character stands with its arms out like
 * a scarecrow. Binding them *at* the rig's idle values instead makes the
 * authored pose the idle pose exactly — the deformation at idle is the
 * identity — and every animation then deviates from the sculpted pose rather
 * than from an imaginary T-pose the mesh has never been in.
 *
 * The cost is that a bone's children can no longer be offset by a plain
 * subtraction: with the parent bound rotated, a child's local position has to
 * be expressed in the parent's rotated frame, or the elbow ends up somewhere
 * the elbow is not. Hence the accumulated inverse below.
 */
function buildSkeleton(spec) {
  const byName = new Map();
  const bones = [];
  for (const b of spec.bones) {
    const bone = new THREE.Bone();
    bone.name = b.name;
    byName.set(b.name, bone);
    bones.push(bone);
  }
  const worldRot = new Map();          // accumulated bind rotation per bone
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _v = new THREE.Vector3();

  for (const b of spec.bones) {
    const bone = byName.get(b.name);
    const parent = b.parent ? byName.get(b.parent) : null;
    const parentHead = b.parent ? byName.get(b.parent).userData.head : [0, 0, 0];
    const parentRot = b.parent ? worldRot.get(b.parent) : new THREE.Quaternion();

    // Offset to the joint, rotated back into the parent's own frame.
    _v.set(b.head[0] - parentHead[0], b.head[1] - parentHead[1], b.head[2] - parentHead[2]);
    _v.applyQuaternion(_q.copy(parentRot).invert());
    bone.position.copy(_v);

    if (b.bind) {
      bone.rotation.set(b.bind[0], b.bind[1], b.bind[2]);
      bone.userData.bind = b.bind;
    }
    worldRot.set(b.name, parentRot.clone().multiply(
      new THREE.Quaternion().setFromEuler(_e.set(...(b.bind || [0, 0, 0]))),
    ));

    bone.userData.head = b.head;
    bone.userData.tail = b.tail;
    if (parent) parent.add(bone);
  }
  return { bones, byName, root: byName.get(spec.bones[0].name) };
}

/**
 * Hands the rig the node names it already animates.
 *
 * `characterRig.js` reaches for `userData.armR.userData.lower` and friends and
 * does not care whether it finds a Group of primitives or a Bone — it sets
 * rotations either way. Publishing the bones under those names is the whole of
 * making an authored mesh animate with the procedural characters' code.
 */
function publishRigContract(g, byName, spec, char, visorMaterial) {
  const arm = (side) => {
    const a = byName.get(`arm${side}`);
    a.userData.lower = byName.get(`arm${side}lower`);
    return a;
  };
  const leg = (side, outZ) => {
    const l = byName.get(`leg${side}`);
    l.userData.lower = byName.get(`leg${side}lower`);
    l.userData.ankle = byName.get(`leg${side}ankle`);
    l.userData.restZ = 0;
    l.userData.outZ = outZ;
    return l;
  };
  const torso = byName.get('torso');
  const armR = arm('R');

  /* The weapon mount rides the right forearm exactly as it does on a built
     body, so the gun tracks the crosshair and the hand goes with it. */
  const weaponMount = new THREE.Group();
  weaponMount.position.set(0.06, -0.2, 0.06);
  byName.get('armRlower').add(weaponMount);

  const capeBones = (spec.cape?.bones || []).map((n) => byName.get(n)).filter(Boolean);

  g.userData = {
    capeBones,
    torso, torsoBaseY: torso.position.y, head: byName.get('head'),
    armL: arm('L'), armR,
    legL: leg('L', -1), legR: leg('R', 1),
    pelvis: byName.get('pelvis'),
    weaponMount, gripHand: null,
    visor: visorMaterial, build: char.build, hipY: spec.hipY, hat: null,
    authored: true,
  };
}

const _cache = new Map();

/** True once the file for this build is loaded and ready to be instanced. */
export function hasAuthoredModel(build) { return _cache.has(build); }

/**
 * Loads every authored mesh. Called once at boot, before a run can start, so
 * `buildPlayerModel` stays synchronous and nothing downstream has to learn
 * about promises. A file that fails to load is simply absent from the cache and
 * that character falls back to its built body.
 */
export async function preloadAuthoredModels() {
  const loader = new GLTFLoader();
  await Promise.all(Object.entries(SOURCES).map(([build, url]) => new Promise((resolve) => {
    loader.load(url, (gltf) => {
      let mesh = null;
      gltf.scene.traverse((n) => { if (!mesh && n.isMesh) mesh = n; });
      if (!mesh) { resolve(); return; }
      const spec = RIGS[build];
      const geo = mesh.geometry.clone();
      geo.translate(spec.recentre[0], spec.recentre[1], spec.recentre[2]);
      if (!geo.index) {
        // Skinning wants an indexed buffer to reorder into material groups.
        const count = geo.attributes.position.count;
        const idx = new Uint32Array(count);
        for (let i = 0; i < count; i++) idx[i] = i;
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
      }
      _cache.set(build, { geometry: geo, spec });
      resolve();
    }, undefined, (err) => {
      console.warn(`authored model for "${build}" failed to load`, err);
      resolve();
    });
  })));
}

/**
 * One playable body from an authored mesh, or null if there isn't one.
 *
 * Geometry is shared between instances — eight players in a co-op run pay for
 * one copy of the mesh — while the skeleton and the materials are per instance,
 * because both are animated.
 */
export function buildAuthoredModel(char) {
  const entry = _cache.get(char.build);
  if (!entry) return null;
  const { spec } = entry;

  const g = new THREE.Group();
  const geometry = entry.geometry.clone();

  const boneOrder = spec.bones.map((b) => b.name);
  const { skinIndex, skinWeight } = computeSkinWeights(
    geometry.attributes.position.array, spec, boneOrder,
  );
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

  const materials = assignMaterialGroups(geometry, spec, char);
  const mesh = new THREE.SkinnedMesh(geometry, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // The mesh is authored in the same space the bones are measured in, so it
  // needs no bind transform of its own.
  mesh.bindMode = THREE.AttachedBindMode;

  const { bones, byName, root } = buildSkeleton(spec);
  g.add(root);
  g.add(mesh);

  /* The bind pose has to be *resolved* before the skeleton is built.
   *
   * `Skeleton` derives each bone's inverse bind matrix from that bone's
   * `matrixWorld` at construction time, and a bone that has only just been
   * parented still has the identity there. Building the skeleton first
   * therefore records "no bind transform at all" for every joint, and the mesh
   * comes out transformed by each bone's full world matrix instead of by how
   * far that bone has moved from where it started — which lands as a body at
   * roughly twice the size with its limbs in the wrong places. */
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton, new THREE.Matrix4());

  publishRigContract(g, byName, spec, char, materials[2]);
  g.userData.skinnedMesh = mesh;
  return g;
}
