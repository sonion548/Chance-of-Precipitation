import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { characterSurfaces, makeCharacterMaterial } from '../world/textures.js';
import { weaponById } from '../data/weapons.js';

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
 *
 * ---------------------------------------------------------------------------
 * THE WEAPON IS IN THE MESH
 *
 * Every one of these characters was sculpted holding something, and that thing
 * is the weapon they carry. So an authored body does not get a procedural
 * weapon model bolted onto its wrist the way a built body does — it already has
 * one, welded into the same shell as the fingers around it, and a second gun
 * hanging off the same hand looks exactly as bad as it sounds.
 *
 * A spec therefore declares `weapon` — a grip, a muzzle and a radius around the
 * line between them — which is three things at once:
 *
 *   • the vertices that are the weapon rather than the body, skinned in one
 *     piece to a bone of their own so the whole thing swings from the grip;
 *   • that bone, published as `userData.weaponMount`, which is the object
 *     `poseWeapon` aims at the crosshair — so a mesh weapon tracks the aim
 *     exactly like a held one, because as far as the rig is concerned it is;
 *   • `userData.muzzle`, parked at the business end, which is where every shot
 *     in the game originates.
 *
 * `userData.bodyWeapon` then tells `Combat.equip` and `RemotePlayer.setWeapon`
 * to leave the mount alone. A character with no weapon in its mesh simply omits
 * the block and gets the procedural model, as before.
 *
 * The one exception runs the other way. Unloader was sculpted with a cargo hook
 * on a chain hanging off his fist, and the hook is not his weapon — it is the
 * grapple, an ability that fires a line and reels it back in, which no lump of
 * iron dangling at knee height is going to do. A spec can therefore also
 * declare `strip`: geometry to take off the mesh at load time. See
 * `stripGeometry` for why it collapses the vertices rather than deleting them.
 */

/* ------------------------------------------------------------------ arm bind pose */
/**
 * The rotations `poseArms` settles an idle character on.
 *
 * Skinning does not care what pose a mesh was modelled in; it cares about the
 * difference between a bone's current transform and its *bind* transform. The
 * rig writes absolute rotations, so binding an arm at anything other than the
 * rig's own idle values means an idle character is already deformed — and these
 * were bound at values left over from an older `poseArms`, which is why both
 * authored characters have been standing with their arms folded across their
 * chests since the day they landed.
 *
 * These are read straight back off `poseArms` with `ready = 0` and
 * `stride = 0`: the shoulder settles on `loweredR` / `loweredL`, the elbow on
 * the bottom of its `lerp`. Bound here, the sculpted arm pose *is* the idle
 * pose — the deformation at idle is the identity — and every animation deviates
 * from what the sculptor drew rather than from a T-pose the mesh has never been
 * in.
 */
const ARM_BIND_R = [-0.16, 0, 0.06];
const ELBOW_BIND_R = [-0.34, 0, 0];
const ARM_BIND_L = [-0.16, 0.04, -0.06];
const ELBOW_BIND_L = [-0.30, 0, 0];

/**
 * Is this point inside an axis-aligned ellipsoid?
 *
 * The region tests are the only shape language a spec has, and a box is a poor
 * one for anything that is meant to look rounded — see UNLOADER_RIG.region.
 */
function ellipsoid(x, y, z, [ox, oy, oz], [rx, ry, rz]) {
  const dx = (x - ox) / rx, dy = (y - oy) / ry, dz = (z - oz) / rz;
  return dx * dx + dy * dy + dz * dz < 1;
}

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
       arms on purpose — see ARM_BIND_R above and the note on BIND POSE below.

       `armR` is the *weapon* arm, and it is the one at −X. That is not a
       mirroring slip: the rig braces armR when you aim, swings it on an attack
       and aims the mount hanging off it, and every authored mesh so far was
       sculpted holding its weapon in the hand at −X. Naming the empty hand R
       would brace the wrong arm and leave the blade swinging loose beside it. */
    { name: 'armR',      parent: 'torso', head: [-0.22, 1.38, 0.02], tail: [-0.305, 1.14, 0.10],
      bind: ARM_BIND_R },
    { name: 'armRlower', parent: 'armR',  head: [-0.305, 1.14, 0.10], tail: [-0.385, 0.92, 0.17],
      bind: ELBOW_BIND_R },
    { name: 'armL',      parent: 'torso', head: [0.22, 1.38, 0.02],  tail: [0.305, 1.14, 0.10],
      bind: ARM_BIND_L },
    { name: 'armLlower', parent: 'armL',  head: [0.305, 1.14, 0.10], tail: [0.385, 0.92, 0.17],
      bind: ELBOW_BIND_L },

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
  /**
   * The cannon.
   *
   * A long tapered emitter carried in the weapon hand, pointing down and
   * forward past the knee — the airframe's own gun, and until now weighted to
   * the chest as a seventh wing, because it is outboard and long and that is
   * all the wing test asks. It is claimed before that test for exactly this
   * reason.
   *
   * Read as a sword if you look at the shape alone, so it is *lit* as a cannon:
   * dark casing for the back half and the character's discharge colour only at
   * the emitter. Lighting the whole length would make it a lightsaber, which is
   * the one thing an aerial bombardier is not carrying.
   */
  weapon: {
    grip: [-0.415, 0.93, 0.20],
    muzzle: [-0.670, 0.230, 0.514],
    /* The cannon and the forearm holding it are one continuous run of geometry
       — there is no gap between them to find — so `from` is what separates
       them, and it is set just below the fist. */
    radius: 0.16, from: 0.06,
    lit: 0.58,
    casing: 3, emitter: 4,
  },
  region(cx, cy, cz) {
    const wing = cy > 0.18 && (cz < -0.16 || Math.abs(cx) > 0.30) && Math.abs(cx) > 0.2;
    /* A band across the front of the head. Measured off the mesh: the skull
       runs roughly 1.62–1.88 and its front face peaks at z ≈ 0.25, so the eye
       line sits well forward — an earlier pass at z > 0.10 painted the crown. */
    const visor = !wing && cy > 1.665 && cy < 1.755 && cz > 0.185 && Math.abs(cx) < 0.115;
    return visor ? 2 : wing ? 1 : 0;
  },
  materials(char, weapon) {
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
      // Cannon casing: the one dark thing on a white airframe, so the weapon
      // reads as hardware against the body rather than as more of it.
      makeCharacterMaterial(S.tech, {
        color: 0x2b323d, roughness: 0.38, metalness: 0.86, scale: 7.2,
      }),
      // Emitter, in the colour of what comes out of it.
      new THREE.MeshStandardMaterial({
        color: weapon.color, emissive: weapon.color, emissiveIntensity: 1.9,
        roughness: 0.22, metalness: 0.55,
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

    // Weapon arm at −X, empty hand at +X — see the note in HALCYON_RIG.
    { name: 'armR',      parent: 'torso', head: [-0.22, 1.44, 0.02],  tail: [-0.36, 1.16, 0.04],
      bind: ARM_BIND_R },
    { name: 'armRlower', parent: 'armR',  head: [-0.36, 1.16, 0.04],  tail: [-0.42, 0.93, 0.06],
      bind: ELBOW_BIND_R },
    { name: 'armL',      parent: 'torso', head: [0.22, 1.44, 0.02],   tail: [0.36, 1.16, 0.04],
      bind: ARM_BIND_L },
    { name: 'armLlower', parent: 'armL',  head: [0.36, 1.16, 0.04],   tail: [0.42, 0.93, 0.06],
      bind: ELBOW_BIND_L },

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
  /* The same box the cloth was always claimed by, with its two live edges
     softened. A cape test is a line drawn through a mesh and both of these run
     close to a leg; reporting how sure it is instead of yes-or-no lets the
     triangles that straddle it be part cloth and part thigh, which is what they
     are. See the cape branch in `computeSkinWeights`. */
  cape: {
    bones: ['capeA', 'capeB', 'capeC'],
    test: (x, y, z) => Math.max(0, Math.min(1, Math.min(
      (x - 0.16) / 0.07, (-0.12 - z) / 0.07, (y - 0.28) / 0.14))),
  },
  /**
   * The spear.
   *
   * A long single-edged head carried point-down and outboard of the weapon
   * hand — the reach weapon the character is built around, sculpted into the
   * mesh from the start. It replaces the procedural haft that used to be bolted
   * to the same wrist; the Splitting Lance's numbers and both of its abilities
   * are untouched, it is only what you see that changed.
   *
   * Lit the way the procedural spear was lit and for the same reason: dark for
   * the length that is haft, discharge colour for the head. A spear that glows
   * end to end reads as a lightsaber, and the character it belongs to is
   * defined by being almost invisible.
   */
  weapon: {
    grip: [-0.42, 0.93, 0.06],
    muzzle: [-0.686, 0.616, 0.317],
    radius: 0.16, from: 0.10,
    lit: 0.60,
    casing: 4, emitter: 5,
  },
  /* Matte black plate, and everything that is not plate is discharge.
     0 armour · 1 cape · 2 visor · 3 lit trim (hood collar, forearm blades)
     4 spear haft · 5 spear head */
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
  materials(char, weapon) {
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
      // Haft: darker than the plate, so the weapon is a line and not a limb.
      makeCharacterMaterial(S.tech, {
        color: 0x0d1014, roughness: 0.4, metalness: 0.8, scale: 6.6,
      }),
      // Head, in the colour of what it leaves behind.
      new THREE.MeshStandardMaterial({
        color: weapon.color, emissive: weapon.color, emissiveIntensity: 2.1,
        roughness: 0.2, metalness: 0.6,
      }),
    ];
  },
};

/**
 * Unloader: an industrial exosuit, and the one mesh that arrived carrying
 * something that is not its weapon.
 *
 * Everything about him is wider than the other two — the fists sit at
 * x ≈ ±0.72, further out than Halcyon's wingtips, and the pauldrons are the
 * widest thing on the body at y ≈ 1.3. The bones below were clustered out of
 * horizontal slabs the same way, which on this mesh is easy: the arms hang
 * clear of the torso at every height, so each slab reads as three separate runs
 * of x and the limbs fall out of it without any of the guesswork the winged
 * shell needed.
 *
 * Colour follows the reference sheet: a dark slate frame with hazard-amber
 * armour on everything that is bolted onto it — pauldrons, the whole arm down
 * to the wrist, and the plates over the thighs and knees — steel at the fists
 * and the belt, and one lit band across the front of the helmet.
 */
const UNLOADER_RIG = {
  // Modelled on its own centreline already, unlike the other two.
  recentre: [0, 0, 0],
  hipY: 0.95,
  bones: [
    { name: 'pelvis', parent: null,     head: [0, 0.95, -0.01], tail: [0, 1.05, -0.02] },
    { name: 'torso',  parent: 'pelvis', head: [0, 0.95, -0.01], tail: [0, 1.46, -0.05] },
    { name: 'head',   parent: 'torso',  head: [0, 1.60, -0.06], tail: [0, 1.88, -0.04] },

    // Weapon arm at −X, empty hand at +X — see the note in HALCYON_RIG.
    { name: 'armR',      parent: 'torso', head: [-0.34, 1.38, -0.03], tail: [-0.62, 1.10, -0.04],
      bind: ARM_BIND_R },
    { name: 'armRlower', parent: 'armR',  head: [-0.62, 1.10, -0.04], tail: [-0.72, 0.84, 0.03],
      bind: ELBOW_BIND_R },
    { name: 'armL',      parent: 'torso', head: [0.34, 1.38, -0.03],  tail: [0.62, 1.10, -0.04],
      bind: ARM_BIND_L },
    { name: 'armLlower', parent: 'armL',  head: [0.62, 1.10, -0.04],  tail: [0.72, 0.84, 0.03],
      bind: ELBOW_BIND_L },

    /* The stance is wide and the boots are long: the hips are ±0.17 apart, the
       ankles ±0.40, and the sole runs from z ≈ −0.36 to +0.20. Splitting the
       ankle off as its own bone is what lets the toe stay on the floor while
       the shin swings over it. */
    { name: 'legL',       parent: 'pelvis',    head: [-0.17, 0.95, -0.01], tail: [-0.31, 0.52, -0.03] },
    { name: 'legLlower',  parent: 'legL',      head: [-0.31, 0.52, -0.03], tail: [-0.40, 0.16, -0.09] },
    { name: 'legLankle',  parent: 'legLlower', head: [-0.40, 0.16, -0.09], tail: [-0.42, 0.03, 0.02] },
    { name: 'legR',       parent: 'pelvis',    head: [0.17, 0.95, -0.01],  tail: [0.31, 0.52, -0.03] },
    { name: 'legRlower',  parent: 'legR',      head: [0.31, 0.52, -0.03],  tail: [0.40, 0.16, -0.09] },
    { name: 'legRankle',  parent: 'legRlower', head: [0.40, 0.16, -0.09],  tail: [0.42, 0.03, 0.02] },
  ],
  // Nothing on this suit grows off the back, so the wing claim never fires.
  wing: { minY: 99, behind: -99, outward: 99, bone: 'torso' },
  /**
   * The hook, and why it goes.
   *
   * A cargo hook on a four-link chain, hanging off the weapon fist and reaching
   * almost to the floor. It is a fine thing to have sculpted and a bad thing to
   * animate: it is welded rigid, so it cannot swing, and a rigid chain bolted to
   * a fist that punches is a bar of iron that clips through the leg it swings
   * past. It is also not the weapon. The suit's weapon is the pair of gauntlets
   * — the Siege Gauntlets are the fists themselves — and the hook is the
   * grapple, which is fired, flies out on a line and is reeled back. Nothing
   * about that ability is served by the hook being *already out*.
   *
   * The test is a box outboard of the boot and forward of the shin, which is
   * the only place on the mesh the chain occupies: the boot reaches x = −0.68
   * but never past z = +0.17, and the chain never comes inboard of x = −0.66.
   */
  strip: {
    test: (x, y, z) => x < -0.62 && z > 0.18 && y < 0.90,
    to: [-0.73, 0.86, 0.10],
  },
  /**
   * No held weapon: the gauntlets are the weapon and they are the hands.
   *
   * The block is still declared, because the mount is what `poseWeapon` aims
   * and the muzzle is where a shockwave leaves from. With no `test` nothing is
   * skinned to the mount, so the fist itself does not swivel with the aim — it
   * only decides where in front of the knuckles the charge goes off.
   */
  weapon: {
    grip: [-0.72, 0.86, 0.04],
    muzzle: [-0.72, 0.86, 0.34],
  },
  /* 0 frame · 1 amber plate · 2 visor · 3 steel
   *
   * Two of these are ellipsoids rather than boxes, and it is worth saying why:
   * the shell is 34k triangles over a whole body, so a plane cutting across a
   * limb leaves an edge a triangle deep and the plate reads as damage rather
   * than as a panel. Where the shape is meant to be a rounded thing — a lamp in
   * a helmet, a cap over a knee — a rounded test gives it a rounded edge, and
   * the facets fall along it instead of across it. */
  region(cx, cy, cz) {
    const ax = Math.abs(cx);
    /* The visor. There is none in the geometry — the helmet is one smooth
       dome — so the face is painted on: a wide, shallow lamp across the front,
       deep enough in z to take the whole curve of the brow. */
    if (ellipsoid(cx, cy, cz, [0, 1.695, 0.10], [0.155, 0.048, 0.22])) return 2;
    // Pauldrons, and the arm below them all the way to the wrist. The torso
    // never reaches x = 0.30 above the belt, so width alone separates them.
    if (cy > 1.24 && ax > 0.30) return 1;
    if (cy > 0.96 && cy < 1.24 && ax > 0.40) return 1;
    // Fists: bare metal, because they are what he hits things with.
    if (cy > 0.62 && cy < 0.96 && ax > 0.52) return 3;
    // Knee caps, one ellipsoid per leg, pushed forward so the back stays dark.
    if (ellipsoid(ax, cy, cz, [0.33, 0.55, 0.10], [0.17, 0.13, 0.20])) return 1;
    /* Thigh plates. Bounded in front as well as outboard — the same band taken
       all the way round paints the backs of his legs, which the sheet shows as
       dark. */
    if (cy > 0.62 && cy < 0.90 && ax > 0.15 && ax < 0.60 && cz > 0.0) return 1;
    // Belt.
    if (cy > 0.97 && cy < 1.10 && ax < 0.36) return 3;
    return 0;
  },
  materials(char) {
    const S = characterSurfaces();
    return [
      /* The frame: heavy, dark, and barely reflective. This is the one build in
         the game wearing the coarse damaged plate rather than the fine tech
         panelling — the same split the built bodies make between industrial
         equipment and a precision airframe, and Unloader is a forklift. */
      makeCharacterMaterial(S.plate, {
        color: char.color, roughness: 0.72, metalness: 0.34, scale: 4.4,
      }),
      /* Hazard amber. Lit, but only just — this is paint on a plate, not a
         power source, and pushing the emissive any further turns a work suit
         into a neon sign. */
      makeCharacterMaterial(S.plate, {
        color: char.accent, emissive: char.accent, emissiveIntensity: 0.22,
        roughness: 0.58, metalness: 0.24, scale: 4.8,
      }),
      new THREE.MeshStandardMaterial({
        color: char.visor, emissive: char.visor, emissiveIntensity: 2.2,
        roughness: 0.2, metalness: 0.65,
      }),
      // Bare steel: knuckles and the belt, the two things that take the wear.
      makeCharacterMaterial(S.tech, {
        color: 0xaab2be, roughness: 0.38, metalness: 0.72, scale: 6.8,
      }),
    ];
  },
};

/**
 * Sniper: a cloak, a rifle held across the body, and the most surgery any
 * authored mesh has needed.
 *
 * The body is easy — a hooded figure in plate over a bodysuit, measured the same
 * way as the others. The rifle is not. It arrived welded to its owner in two
 * places and misaligned in a third:
 *
 *   • the scope's eyepiece runs into the shoulder, so scope and shoulder are one
 *     surface — see `detach`;
 *   • the scope is cocked 15° off the bore, up and to the right, which reads as
 *     a broken optic from any angle you can see both from;
 *   • the barrel and the receiver, mercifully, are dead straight already: the
 *     bore fits a line to within 7 mm over its whole length, which is what makes
 *     that line trustworthy enough to align everything else to.
 *
 * The bore is the frame the whole weapon is described in. Measured off the mesh
 * by walking the barrel in slices and least-squares fitting its centres, it runs
 * from the muzzle back through the receiver to the butt at the shoulder, and
 * every number below is either a point on it or an offset from it.
 */
const BORE = {
  // A point on the bore, and the direction it points, in recentred model space.
  at: [0.6521, 0.9287, 0.6108],
  dir: [0.7406, -0.4671, 0.4831],
};

const SNIPER_RIG = {
  // The body stands at x = −0.10, z = −0.20 of its own file's origin.
  recentre: [0.10, 0, 0.20],
  hipY: 0.95,
  bones: [
    { name: 'pelvis', parent: null,     head: [0, 0.95, -0.02], tail: [0, 1.05, -0.02] },
    { name: 'torso',  parent: 'pelvis', head: [0, 0.95, -0.02], tail: [0, 1.45, 0.00] },
    { name: 'head',   parent: 'torso',  head: [0, 1.58, 0.00],  tail: [0, 1.88, 0.00] },

    /* The rifle is carried across the body, so both hands end up near the
       centreline with the elbows out — the forearms run *inward*, which is the
       opposite of every other authored mesh here and the reason these were
       measured off the bore rather than off the arm. `armR` is the trigger hand
       and it is the one at −X, as it is on every mesh so far. */
    { name: 'armR',      parent: 'torso', head: [-0.21, 1.42, -0.04], tail: [-0.30, 1.20, 0.02],
      bind: ARM_BIND_R },
    { name: 'armRlower', parent: 'armR',  head: [-0.30, 1.20, 0.02],  tail: [-0.06, 1.30, 0.15],
      bind: ELBOW_BIND_R },
    { name: 'armL',      parent: 'torso', head: [0.21, 1.42, -0.04],  tail: [0.27, 1.19, 0.10],
      bind: ARM_BIND_L },
    { name: 'armLlower', parent: 'armL',  head: [0.27, 1.19, 0.10],   tail: [0.19, 1.15, 0.31],
      bind: ELBOW_BIND_L },

    // A wide, staggered shooting stance: left foot forward, right foot back.
    { name: 'legL',       parent: 'pelvis',    head: [-0.16, 0.95, -0.02], tail: [-0.24, 0.55, 0.00] },
    { name: 'legLlower',  parent: 'legL',      head: [-0.24, 0.55, 0.00],  tail: [-0.30, 0.15, -0.02] },
    { name: 'legLankle',  parent: 'legLlower', head: [-0.30, 0.15, -0.02], tail: [-0.32, 0.03, 0.06] },
    { name: 'legR',       parent: 'pelvis',    head: [0.16, 0.95, -0.02],  tail: [0.20, 0.55, -0.04] },
    { name: 'legRlower',  parent: 'legR',      head: [0.20, 0.55, -0.04],  tail: [0.25, 0.15, -0.10] },
    { name: 'legRankle',  parent: 'legRlower', head: [0.25, 0.15, -0.10],  tail: [0.30, 0.03, -0.04] },

    /* The cloak: a three-link chain off the back of the chest, following the
       line the cloth hangs along. Chained rather than rigid so it can trail —
       see `swayCape`. */
    { name: 'capeA', parent: 'torso', head: [0, 1.44, -0.14],     tail: [-0.06, 1.10, -0.24] },
    { name: 'capeB', parent: 'capeA', head: [-0.06, 1.10, -0.24], tail: [-0.10, 0.70, -0.30] },
    { name: 'capeC', parent: 'capeB', head: [-0.10, 0.70, -0.30], tail: [-0.12, 0.24, -0.30] },
  ],
  // Nothing grows off this one's back but cloth, which has its own claim.
  wing: { minY: 99, behind: -99, outward: 99, bone: 'torso' },
  /**
   * The core: from the hips to the collar, and nothing but the spine may have it.
   *
   * He carries the rifle across his chest, so both forearms run over his ribs
   * and are nearer to them than the spine is. Without this the chest is skinned
   * to the arms and swells and buckles every time they move — which is exactly
   * what it did. An ellipse rather than a box because a ribcage is one, and
   * because the upper arms sit at |x| ≈ 0.22 and a box wide enough to hold the
   * chest would take them with it.
   */
  core: {
    bones: ['pelvis', 'torso', 'head'],
    test: (x, y, z) => {
      const q = Math.hypot(x / 0.20, (z - 0.02) / 0.20);
      return Math.max(0, Math.min(1, Math.min(
        (1.18 - q) / 0.18, (y - 0.88) / 0.06, (1.64 - y) / 0.06)));
    },
  },
  /**
   * The cloak — all of it, which is the whole difficulty.
   *
   * It is not simply *behind* the way a cape is on a character who wears one
   * hanging down their back: this one wraps, and hangs past both hips to the
   * floor. Claiming only what is behind leaves the two front panels to the
   * nearest bone, which is a thigh, and then half the cloak swings with the leg
   * — the legs read as swinging enormously wide when in fact it is the cloth
   * doing it.
   *
   * Two clauses, then. Anything behind the body's own back, which never passes
   * z = −0.14. And anything outboard of the legs below the waist, where the
   * threshold has to step out at the ankles: the boots reach |x| = 0.41 and the
   * hem starts at 0.43, which is a 2 cm gap and the only place on the model
   * where cloth and body come that close.
   */
  cape: {
    bones: ['capeA', 'capeB', 'capeC'],
    test: (x, y, z) => sniperCloak(x, y, z),
    // It wraps, so its front panels are a long way out from the chain: what
    // reads as a flick at the back reads as a sail at the front.
    sway: 0.4,
  },
  /**
   * The scope, cut free of the shoulder and set square on the bore.
   *
   * `from` is the axis the scope was modelled on, fitted the same way the bore
   * was: ring centres taken in slices down the tube, then a line through them.
   * Rotating that onto the bore is the entire alignment — 15.2°, most of it
   * pitch — and `move` is the last centimetre, squaring the tube up over the
   * barrel instead of sitting a little left of it.
   */
  detach: [{
    test: (x, y, z) => {
      const [t, u, r] = boreFrame(x, y, z);
      if (t < -0.92 || t > -0.52) return false;
      return Math.hypot(u - (0.1603 * t + 0.2545), r - (0.2198 * t + 0.1543)) < 0.085;
    },
    seal: false,
    from: [0.6592, -0.3139, 0.6833],
    to: BORE.dir,
    pivot: [0.1754, 1.3880, 0.2951],
    move: [-0.0077, -0.0125, -0.0003],
  }],
  /**
   * The rifle, from the butt in the shoulder to the muzzle.
   *
   * A fat capsule by the standards of the other two — it has to swallow a scope
   * standing 12 cm proud of the bore — and it starts at the butt rather than
   * below a fist, because this weapon is held in two hands with its back end
   * behind both of them. The seam therefore falls at the hands, which is where
   * a rifle's seam belongs, and the grip-end blend does the rest.
   */
  weapon: {
    grip: [-0.3111, 1.5359, 0.0179],
    muzzle: [0.8300, 0.8170, 0.7270],
    radius: 0.115, from: 0.0,
    also: (x, y, z) => scopeCylinder(x, y, z),
    // The brake, and nothing else: a sniper is not a lamp.
    lit: 0.962,
    casing: 4, emitter: 5,
  },
  /* 0 webbing · 1 cloak · 2 visor · 3 bodysuit · 4 rifle · 5 muzzle · 6 trim
   *
   * Almost all of the mesh is the suit. That is deliberate now: the plate is
   * `attachments`, real geometry strapped over the top, and painting a plate
   * onto a bare arm to stand in for one is what made him read as a man in a
   * T-shirt. What is left for the paint is the cloth, the slit, and the two
   * things the sculpt does model as kit — the hip pouches and the boots. */
  region(cx, cy, cz) {
    // The slit. Wide and shallow, set back under the brow of the hood.
    if (ellipsoid(cx, cy, cz, [0, 1.715, 0.02], [0.105, 0.032, 0.15])) return 2;
    if (cy > 1.58) return 1;                              // hood
    if (sniperCloak(cx, cy, cz) > 0.5) return 1;          // cloak
    if (cy < 0.14) return 0;                              // boot leather
    return 3;
  },
  /**
   * The kit, in model space, measured off the limbs it is strapped to.
   *
   * A scout's load-out rather than a knight's: hard plate only where a round
   * would land — shoulders, chest, forearms, thighs, knees, shins — and webbing
   * everywhere else. Every piece is a shell, a slab or a sleeve, and every
   * position was read off the mesh's own cross-sections, which is why the
   * numbers are not symmetric: he stands staggered, left foot forward, so his
   * right leg is 4 cm further back than his left.
   */
  attachments(char) {
    const S = characterSurfaces();
    const plate = makeCharacterMaterial(S.plate, {
      color: 0xcdb98c, roughness: 0.56, metalness: 0.32, scale: 5.4,
    });
    const dark = makeCharacterMaterial(S.tech, {
      color: 0x1b2027, roughness: 0.76, metalness: 0.3, scale: 6.4,
    });
    const brass = makeCharacterMaterial(S.tech, {
      color: char.accent, emissive: char.accent, emissiveIntensity: 0.35,
      roughness: 0.4, metalness: 0.72, scale: 7.4,
    });

    /* Both shoulders get the same pauldron, mirrored: a cap over a lame, which
       is two shapes and reads as five times that many at any distance. */
    const pauldron = (sx) => [
      shell(plate, [0.125, 0.08, 0.135], [sx * 0.225, 1.41, -0.02]),
      shell(plate, [0.135, 0.055, 0.125], [sx * 0.25, 1.345, -0.02]),
      // Upper-arm band, so the arm between pauldron and bracer is not bare.
      sleeve(dark, [0.09, 0.09, 0.95], [sx * 0.255, 1.28, 0.0], [0.25, 0, sx * 0.32]),
      slab(plate, [0.05, 0.10, 0.10], [sx * 0.30, 1.29, 0.02], [0, 0, sx * 0.3]),
    ];
    // Forearm: a sleeve of plate with a strap at each end.
    const bracer = (from, to, r) => {
      const mid = from.map((v, i) => (v + to[i]) / 2);
      const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize(),
      );
      const e = new THREE.Euler().setFromQuaternion(q);
      const rot = [e.x, e.y, e.z];
      return [
        sleeve(plate, [r, len * 0.62, 0.85], mid, rot),
        sleeve(dark, [r * 1.04, len * 0.12, 0.9], from.map((v, i) => v + (to[i] - v) * 0.22), rot),
        sleeve(dark, [r * 1.04, len * 0.12, 0.9], from.map((v, i) => v + (to[i] - v) * 0.78), rot),
      ];
    };
    /* Thigh guard, knee cap and greave, per leg.
    
       `front` is the one number that matters and the one that cannot be
       guessed: how far forward that leg's surface actually is at each of the
       three heights. He stands staggered, so his left leg is up to 8 cm ahead
       of his right, and a plate placed by symmetry ends up buried in one leg
       and floating off the other. These were read off the mesh's own
       cross-sections; each piece then stands 2 cm proud of the number. */
    const legKit = (sx, hip, knee, ankle, front) => ({
      thigh: [
        shell(plate, [0.10, 0.026, 0.175],
          [(hip[0] + knee[0]) / 2 + sx * 0.02, (hip[1] + knee[1]) / 2 + 0.04,
            front[0] - 0.015], [1.2, 0, 0]),
        slab(dark, [0.105, 0.028, 0.115], [(hip[0] + knee[0]) / 2, hip[1] - 0.13, front[0] - 0.07]),
      ],
      shin: [
        // Knee cap, sitting on the joint so it turns with the shin.
        shell(plate, [0.078, 0.028, 0.078], [knee[0] + sx * 0.01, knee[1] - 0.01, front[1] - 0.012],
          [1.3, 0, 0]),
        // Greave: a plate down the front of the shin, not a pipe the leg is
        // inside — a sleeve reads as a tin can from every angle that matters.
        shell(plate, [0.078, 0.026, 0.19],
          [(knee[0] + ankle[0]) / 2 + sx * 0.005, (knee[1] + ankle[1]) / 2,
            front[2] - 0.012], [1.4, 0, 0]),
        slab(dark, [0.085, 0.026, 0.095], [(knee[0] + ankle[0]) / 2, knee[1] - 0.10, front[2] - 0.06]),
      ],
    });
    const legL = legKit(-1, [-0.16, 0.95, -0.02], [-0.24, 0.55, 0.00], [-0.30, 0.15, -0.02],
      [0.170, 0.120, 0.060]);
    const legR = legKit(+1, [0.16, 0.95, -0.02], [0.20, 0.55, -0.04], [0.25, 0.15, -0.10],
      [0.140, 0.085, -0.020]);

    return [
      { bone: 'armR', nodes: pauldron(-1) },
      { bone: 'armL', nodes: pauldron(+1) },
      { bone: 'armRlower', nodes: bracer([-0.28, 1.21, 0.03], [-0.10, 1.28, 0.13], 0.085) },
      { bone: 'armLlower', nodes: bracer([0.26, 1.19, 0.12], [0.20, 1.16, 0.28], 0.085) },
      {
        bone: 'torso',
        nodes: [
          /* Chest plate: a shallow shell over the ribs, standing a centimetre
             proud of them, with a raised sternum down the middle. It has to sit
             forward — buried in the chest it is invisible from the one angle
             the game actually shows a character from. */
          shell(plate, [0.165, 0.045, 0.165], [0, 1.22, 0.235], [1.45, 0, 0]),
          slab(plate, [0.05, 0.22, 0.04], [0, 1.26, 0.285], [0.12, 0, 0]),
          // Bandolier over one shoulder, and the buckle that holds it.
          slab(dark, [0.06, 0.34, 0.045], [0.09, 1.27, 0.26], [0.08, 0, 0.5]),
          slab(brass, [0.045, 0.045, 0.03], [0.04, 1.13, 0.28]),
          // Collar, so the chest plate has something to end against.
          shell(dark, [0.135, 0.06, 0.115], [0, 1.44, 0.01]),
        ],
      },
      {
        bone: 'pelvis',
        nodes: [
          // Tassets: two hanging plates over the hips.
          slab(plate, [0.085, 0.15, 0.13], [-0.19, 0.88, 0.10], [0, 0, -0.18]),
          slab(plate, [0.085, 0.15, 0.13], [0.19, 0.88, 0.08], [0, 0, 0.18]),
          slab(brass, [0.30, 0.03, 0.21], [0, 0.99, 0.08]),
        ],
      },
      { bone: 'legL', nodes: legL.thigh },
      { bone: 'legR', nodes: legR.thigh },
      { bone: 'legLlower', nodes: legL.shin },
      { bone: 'legRlower', nodes: legR.shin },
      // Ankle cuffs, rounded rather than blocked: a boot top, not a brick.
      { bone: 'legLankle', nodes: [shell(plate, [0.095, 0.035, 0.10], [-0.31, 0.11, 0.02])] },
      { bone: 'legRankle', nodes: [shell(plate, [0.095, 0.035, 0.10], [0.26, 0.11, -0.06])] },
    ];
  },
  materials(char, weapon) {
    const S = characterSurfaces();
    return [
      // Webbing and boot leather: the same sand as the plate strapped over it.
      makeCharacterMaterial(S.plate, {
        color: 0xbca77c, roughness: 0.62, metalness: 0.3, scale: 5.4,
      }),
      /* The cloak. Lit, faintly — the sheet draws it as a colour that carries
         across an arena, and cloth this dark otherwise reads as a hole. */
      makeCharacterMaterial(S.cloth, {
        color: char.color, emissive: char.color, emissiveIntensity: 0.18,
        roughness: 0.82, metalness: 0.04, scale: 4.2, side: THREE.DoubleSide,
      }),
      new THREE.MeshStandardMaterial({
        color: char.visor, emissive: char.visor, emissiveIntensity: 2.6,
        roughness: 0.16, metalness: 0.6,
      }),
      // The suit under the plate: matte, dark, and deliberately unremarkable.
      makeCharacterMaterial(S.tech, {
        color: 0x2b323c, roughness: 0.76, metalness: 0.24, scale: 6.4,
      }),
      // The rifle: furniture in the same sand as the plate, over dark metal.
      makeCharacterMaterial(S.tech, {
        color: 0x9a8a66, roughness: 0.5, metalness: 0.55, scale: 7.0,
      }),
      // The brake, in the colour of what comes out of it.
      new THREE.MeshStandardMaterial({
        color: weapon.color, emissive: weapon.color, emissiveIntensity: 1.5,
        roughness: 0.24, metalness: 0.6,
      }),
      // Brow mark and belt: brass, and the only warm metal on him.
      makeCharacterMaterial(S.tech, {
        color: char.accent, emissive: char.accent, emissiveIntensity: 0.4,
        roughness: 0.4, metalness: 0.7, scale: 7.4,
      }),
    ];
  },
};

/**
 * A point in the bore's own frame: along it, above it, right of it.
 *
 * Declared out here rather than inside the spec because the scope's test needs
 * it before the spec object exists, and because it is the frame every number in
 * SNIPER_RIG was measured in — the rifle is diagonal across the body in all
 * three axes, so nothing about it is expressible in model space without this.
 */
const _boreUp = new THREE.Vector3();
const _boreRight = new THREE.Vector3();
const _boreAt = new THREE.Vector3().fromArray(BORE.at);
const _boreDir = new THREE.Vector3().fromArray(BORE.dir);
_boreUp.set(0, 1, 0).addScaledVector(_boreDir, -_boreDir.y).normalize();
_boreRight.crossVectors(_boreDir, _boreUp).normalize();
const _borePoint = new THREE.Vector3();
function boreFrame(x, y, z) {
  _borePoint.set(x, y, z).sub(_boreAt);
  return [_borePoint.dot(_boreDir), _borePoint.dot(_boreUp), _borePoint.dot(_boreRight)];
}

/**
 * The scope, as it is *after* `detach` has put it right: a cylinder 12.5 cm
 * above the bore and dead parallel to it. Before the surgery this shape would
 * describe nothing; afterwards it is exact, which is the point of doing the
 * surgery first and asking questions second.
 */
const SCOPE_HEIGHT = 0.125;

/**
 * The cloak — all of it, which is the whole difficulty, and the reason it is a
 * named function rather than two copies of the same guesswork.
 *
 * It is not simply *behind* the way a cape is on somebody who wears one hanging
 * down their back: this one wraps, and hangs past both hips to the floor.
 * Claiming only what is behind leaves the two front panels to the nearest bone,
 * which is a thigh — and then half the cloak swings with the leg, which reads
 * as the legs swinging enormously wide when it is the cloth doing it.
 *
 * Two clauses. Anything behind the body's own back, which never passes
 * z = −0.14. And anything outboard of the legs below the waist, where the
 * threshold has to step out at the ankles: the boots reach |x| = 0.41 and the
 * hem starts at 0.43, a 2 cm gap and the only place on this model where cloth
 * and body come that close.
 *
 * The same shape decides which vertices are cloth for the skinning and which
 * triangles are cloth for the paint, because they are the same question.
 */
function sniperCloak(x, y, z) {
  const behind = (-0.14 - z) / 0.05;
  const beside = y < 1.12 ? (Math.abs(x) - (y < 0.24 ? 0.40 : 0.34)) / 0.05 : -1;
  // Every edge of the shape is a ramp, the hem and the collar included: the
  // hem passes within two centimetres of a boot and the collar of a shoulder.
  return Math.max(0, Math.min(1, Math.max(behind, beside),
    (y - 0.05) / 0.06, (1.58 - y) / 0.05));
}

function scopeCylinder(x, y, z) {
  const [t, u, r] = boreFrame(x, y, z);
  return t > -1.03 && t < -0.52 && Math.hypot(u - SCOPE_HEIGHT, r) < 0.085;
}

const RIGS = { halcyon: HALCYON_RIG, dasher: DASHER_RIG, unloader: UNLOADER_RIG, sniper: SNIPER_RIG };
const SOURCES = {
  halcyon: './assets/models/halcyon.glb',
  dasher: './assets/models/dasher.glb',
  unloader: './assets/models/unloader.glb',
  sniper: './assets/models/sniper.glb',
};

/**
 * Name of the bone a mesh weapon hangs off, and the object the rig aims.
 *
 * It is a real bone rather than the plain Group a built body uses, because on
 * an authored mesh the weapon is *skinned* to it — there is no separate object
 * to parent, only a run of vertices in the same buffer as the hand.
 */
const WEAPON_BONE = 'weapon';
const FORWARD = new THREE.Vector3(0, 0, 1);
/** How much of a mesh weapon's length is blended back into the hand. */
const WEAPON_BLEND = 0.1;

/* ------------------------------------------------------------------ armour */
/**
 * Plate bolted onto an authored mesh, and why a rig spec builds any at all.
 *
 * The sculpts arrive as bodies. Halcyon's is an airframe and Unloader's is a
 * suit, so painting them is enough — but Sniper's is a man in a cloak with bare
 * arms and bare legs, and no amount of region painting turns that into a
 * soldier. Painted, he read as somebody in a T-shirt and shorts, because that
 * is what the geometry is.
 *
 * So a spec may declare `attachments`: procedural pieces parented to bones,
 * built by the same kind of code every non-authored body in this game is built
 * by. They are authored in **model space** — the same space as every other
 * number in the spec, measured off the same mesh — and the builder moves each
 * one into its bone's frame afterwards, which is the only way to place a knee
 * cap by looking at where the knee is rather than by solving for a bind
 * rotation first. Once parented they animate for free: the plate on a shin is a
 * child of the shin.
 */
const _plateGeo = new THREE.SphereGeometry(1, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
const _boxGeo = new THREE.BoxGeometry(1, 1, 1);
const _tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);

/**
 * A curved shell: a dome squashed to the size given, facing **+Y** before
 * rotation — so a plate meant to face forward wants a *positive* quarter turn
 * about X. Negative points it backwards into the limb it is supposed to cover,
 * which is invisible and was exactly where every plate on this character spent
 * its first draft.
 */
function shell(material, [sx, sy, sz], pos, rot = [0, 0, 0]) {
  const m = new THREE.Mesh(_plateGeo, material);
  m.scale.set(sx, sy, sz);
  m.position.fromArray(pos);
  m.rotation.set(...rot);
  m.castShadow = true;
  return m;
}

/** A flat slab — straps, buckles, greave faces, magazine pouches. */
function slab(material, [sx, sy, sz], pos, rot = [0, 0, 0]) {
  const m = new THREE.Mesh(_boxGeo, material);
  m.scale.set(sx, sy, sz);
  m.position.fromArray(pos);
  m.rotation.set(...rot);
  m.castShadow = true;
  return m;
}

/** An open sleeve around a limb: a bracer, a greave, a thigh guard. */
function sleeve(material, [r, len, flat], pos, rot = [0, 0, 0]) {
  const m = new THREE.Mesh(_tubeGeo, material);
  m.scale.set(r, len, r * (flat ?? 1));
  m.position.fromArray(pos);
  m.rotation.set(...rot);
  m.castShadow = true;
  return m;
}

/* ------------------------------------------------------------------ detach */
/**
 * Cuts a piece of the shell free of the body it was modelled into, and puts it
 * back where it belongs.
 *
 * `strip` below removes something the character should not be carrying. This is
 * the other repair: something the character *should* be carrying that the
 * sculpt has welded to them. Sniper's scope is the case it was written for —
 * its eyepiece runs into the shoulder, so the scope and the shoulder are one
 * surface, and it is cocked fifteen degrees off the bore into the bargain.
 * Nothing downstream can fix either: a mesh weapon is skinned to the mount and
 * aimed, and a scope welded to a shoulder would drag the shoulder with it.
 *
 * Three things happen, in this order, and each is needed by the next.
 *
 *   1. Every triangle is assigned to the piece or to the body by majority of
 *      its corners, so the cut runs along a line of edges rather than through
 *      triangles.
 *   2. The vertices both sides share — the seam, the ring where the scope
 *      passes into the shoulder — are duplicated, and the piece's triangles are
 *      pointed at the copies. That is the whole of "separate": until now the two
 *      were one surface because they were the same vertices.
 *   3. Both rings are collapsed onto the seam's centroid. Each side is now an
 *      open surface with a hole in it, and collapsing its boundary turns the
 *      ring of triangles around that hole into a fan — a cap. The body closes
 *      over where the scope used to emerge, the scope closes over its own back
 *      end, and neither is a window into the other any more.
 *
 * Then the piece — and only the piece, which is why this cannot be two separate
 * passes over positions — is rotated onto the axis it should have been on and
 * nudged into place. The seam's two copies sit on the same point until this
 * moment and are told apart by identity, not by where they are.
 */
function detachGeometry(geometry, piece) {
  const pos = geometry.attributes.position;
  const index = geometry.index.array;
  const n = pos.count;

  /* Welded first. The exporter splits a vertex wherever the UVs seam, so one
     point of the surface can be several entries in the buffer; cutting between
     two halves of the same point would open a crack down the middle of a face
     rather than around the scope. */
  const group = new Int32Array(n);
  const byKey = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
    let g = byKey.get(key);
    if (g === undefined) { g = i; byKey.set(key, i); }
    group[i] = g;
  }

  const isPiece = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    isPiece[i] = piece.test(pos.getX(i), pos.getY(i), pos.getZ(i)) ? 1 : 0;
  }
  const triPiece = new Uint8Array(index.length / 3);
  const usedByPiece = new Set();
  const usedByBody = new Set();
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const mine = isPiece[a] + isPiece[b] + isPiece[c] >= 2;
    triPiece[t / 3] = mine ? 1 : 0;
    const used = mine ? usedByPiece : usedByBody;
    used.add(group[a]); used.add(group[b]); used.add(group[c]);
  }
  const seam = new Set([...usedByPiece].filter((g) => usedByBody.has(g)));

  // Duplicate the seam, and hand the copies to the piece.
  const attrs = Object.values(geometry.attributes);
  const copyOf = new Int32Array(n).fill(-1);
  const extra = [];
  for (let i = 0; i < n; i++) {
    if (!seam.has(group[i])) continue;
    copyOf[i] = n + extra.length;
    extra.push(i);
  }
  if (extra.length) {
    for (const attr of attrs) {
      const size = attr.itemSize;
      const grown = new attr.array.constructor((n + extra.length) * size);
      grown.set(attr.array.subarray(0, n * size));
      extra.forEach((src, k) => {
        for (let c = 0; c < size; c++) grown[(n + k) * size + c] = attr.array[src * size + c];
      });
      attr.array = grown;
      attr.count = n + extra.length;
      attr.needsUpdate = true;
    }
    for (let t = 0; t < index.length; t += 3) {
      if (!triPiece[t / 3]) continue;
      for (let k = 0; k < 3; k++) {
        const c = copyOf[index[t + k]];
        if (c >= 0) index[t + k] = c;
      }
    }
  }

  /* Cap both sides: the ring of triangles around each hole becomes a fan.
   *
   * Per *loop*, not per seam. A tube passing through a surface can meet it in
   * more than one closed curve — this one meets the shoulder in three — and
   * collapsing every loop onto one shared centroid does not cap them, it sews
   * them together through the middle of the character and leaves a spike
   * standing where the three meet. Each loop is found by walking the seam's own
   * edges and is collapsed onto its own centre. */
  const p = geometry.attributes.position;
  const seamEdges = piece.seal === false ? null : new Map();
  if (seamEdges) {
    for (const g of seam) seamEdges.set(g, []);
    for (let t = 0; t < index.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = group[index[t + k]], b = group[index[t + (k + 1) % 3]];
        if (a === b || !seam.has(a) || !seam.has(b)) continue;
        seamEdges.get(a).push(b);
      }
    }
    const loopOf = new Map();
    let loops = 0;
    for (const start of seam) {
      if (loopOf.has(start)) continue;
      const stack = [start];
      loopOf.set(start, loops);
      while (stack.length) {
        const g = stack.pop();
        for (const nx of seamEdges.get(g)) {
          if (loopOf.has(nx)) continue;
          loopOf.set(nx, loops);
          stack.push(nx);
        }
      }
      loops++;
    }
    const sum = Array.from({ length: loops }, () => [0, 0, 0, 0]);
    for (const g of seam) {
      const acc = sum[loopOf.get(g)];
      acc[0] += p.getX(g); acc[1] += p.getY(g); acc[2] += p.getZ(g); acc[3]++;
    }
    for (let i = 0; i < n; i++) {
      if (!seam.has(group[i])) continue;
      const acc = sum[loopOf.get(group[i])];
      const cx = acc[0] / acc[3], cy = acc[1] / acc[3], cz = acc[2] / acc[3];
      p.setXYZ(i, cx, cy, cz);
      if (copyOf[i] >= 0) p.setXYZ(copyOf[i], cx, cy, cz);
    }
  }

  // Now move the piece, which is every vertex the piece's triangles still use.
  const moving = new Uint8Array(p.count);
  for (let t = 0; t < index.length; t += 3) {
    if (!triPiece[t / 3]) continue;
    moving[index[t]] = 1; moving[index[t + 1]] = 1; moving[index[t + 2]] = 1;
  }
  const q = new THREE.Quaternion();
  if (piece.from && piece.to) {
    q.setFromUnitVectors(
      new THREE.Vector3().fromArray(piece.from).normalize(),
      new THREE.Vector3().fromArray(piece.to).normalize(),
    );
  }
  const pivot = new THREE.Vector3().fromArray(piece.pivot ?? [0, 0, 0]);
  const move = new THREE.Vector3().fromArray(piece.move ?? [0, 0, 0]);
  const nrm = geometry.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    if (!moving[i]) continue;
    v.fromBufferAttribute(p, i).sub(pivot).applyQuaternion(q).add(pivot).add(move);
    p.setXYZ(i, v.x, v.y, v.z);
    if (nrm) {
      v.fromBufferAttribute(nrm, i).applyQuaternion(q);
      nrm.setXYZ(i, v.x, v.y, v.z);
    }
  }
  p.needsUpdate = true;
  if (nrm) nrm.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

/* ------------------------------------------------------------------ strip */
/**
 * Takes a piece off the mesh, by collapsing it rather than deleting it.
 *
 * The obvious way to remove geometry is to drop its triangles from the index
 * buffer, and the obvious way is wrong here: everything these meshes are made
 * of is one welded shell, so cutting a piece out leaves a hole where it was
 * joined on, and a hole in a closed body is a window into the inside of it.
 *
 * Collapsing every vertex in the region onto a single point inside the parent
 * limb costs nothing and closes itself. Triangles entirely inside the region
 * become degenerate and rasterise to nothing; the ring of triangles that
 * straddles the boundary becomes a fan from the rim to that point — which is
 * to say, a cap — and the cap is inside the fist, where nobody will ever see
 * it. The shell stays closed, the index buffer is untouched, and the vertex
 * count is unchanged, so this can run once on the shared geometry at load time.
 */
function stripGeometry(geometry, strip) {
  const pos = geometry.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) {
    if (!strip.test(pos[i], pos[i + 1], pos[i + 2])) continue;
    pos[i] = strip.to[0];
    pos[i + 1] = strip.to[1];
    pos[i + 2] = strip.to[2];
  }
  geometry.attributes.position.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

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
  // The chain's vertical reach: the top of its first link to the end of its last.
  const capeTop = capeBones ? spec.bones[capeBones[0]].head[1] : 0;
  const capeSpan = capeBones
    ? Math.max(1e-3, capeTop - spec.bones[capeBones[capeBones.length - 1]].tail[1])
    : 1;
  /** Which two links of the chain a piece of cloth at this height belongs to. */
  const capeLink = (y) => {
    const at = Math.max(0, Math.min(capeBones.length - 1,
      ((capeTop - y) / capeSpan) * (capeBones.length - 1)));
    const lo = Math.min(capeBones.length - 2, Math.floor(at));
    const f = Math.max(0, Math.min(1, at - lo));
    return [capeBones[lo], 1 - f, capeBones[lo + 1], f];
  };
  const weaponBone = boneOrder.indexOf(WEAPON_BONE);
  const handBone = boneOrder.indexOf('armRlower');
  const wep = spec.weapon ? weaponAxis(spec.weapon) : null;
  const coreSet = new Set((spec.core?.bones ?? [])
    .map((b) => spec.bones.findIndex((q) => q.name === b)));
  const cand = [];

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];

    /* Two things get claimed ahead of the nearest-bone search, and both of
       them can be claimed *partly*.
    
       The weapon goes first: ahead of the wing claim because on a winged mesh
       it is outboard and long, which is the entire wing test, and ahead of the
       search because a spear held point-down passes a knee. Along its own
       length it is rigid — a blade that bends is not a blade — so everything
       past the first tenth of the axis is the mount at full weight, and the
       tenth nearest the grip ramps down into whatever is holding it.
    
       Cloth is claimed for the same reason a wing is: the hem of a cape hangs
       beside a thigh, and nearest-bone would sew it to the leg and make the
       cape kick when he walks.
    
       Both share the same partial handling, because both draw a line through a
       mesh that has a limb on the other side of it. A hard line puts one corner
       of a triangle on a swinging cloak and the other two on a walking leg,
       which is a spike across the screen; reporting how *sure* the test is and
       sharing the last centimetres either side of it does not. */
    let claim = null;
    let share = 0;
    const wShare = weaponBone >= 0 && wep
      ? wep.test(x, y, z) * Math.max(0, Math.min(1, wep.along(x, y, z) / WEAPON_BLEND))
      : 0;
    if (wShare > 0) {
      claim = [weaponBone, 1, weaponBone, 0];
      share = wShare;
    } else if (capeBones) {
      const cloth = Number(spec.cape.test(x, y, z));
      if (cloth > 0) { claim = capeLink(y); share = cloth; }
    }
    if (share >= 0.999) {
      skinIndex[i * 4] = claim[0]; skinWeight[i * 4] = claim[1];
      skinIndex[i * 4 + 1] = claim[2]; skinWeight[i * 4 + 1] = claim[3];
      continue;
    }

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
       the cape would kick when he walks.
    
       Inside the chain the weight is blended by *height*, not by distance to
       the links. Distance is the obvious rule and it is wrong for anything that
       wraps: Sniper's cloak comes round both hips, so its front panels are half
       a metre from a chain that runs down his spine and end up with three
       near-equal weights — three links pulling one vertex three ways, which
       tears the cloth into spikes the moment he runs. Height is what cloth
       actually obeys. The top of the cape moves with the shoulders, the hem
       lags furthest behind, and how far round the body a given piece hangs does
       not come into it. */
    const cloth = capeBones ? Number(spec.cape.test(x, y, z)) : 0;
    if (cloth >= 0.999) {
      const [a, wa, b, wb] = capeLink(y);
      skinIndex[i * 4] = a; skinWeight[i * 4] = wa;
      skinIndex[i * 4 + 1] = b; skinWeight[i * 4 + 1] = wb;
      continue;
    }

    /* Inside the core, only the spine competes.
     *
     * Nearest-bone is a good rule everywhere a limb is the nearest thing to its
     * own surface, and a bad one the moment a limb crosses the body. Sniper
     * carries his rifle across his chest, so both forearms run over his ribs and
     * are genuinely closer to them than the spine is — nearest-bone hands the
     * chest to the arms, and the torso then swells and buckles every time they
     * move. It is the same story for a hood: the head bone is nearer the top of
     * the chest than the pelvis is.
     *
     * So a spec can fence off its core. Inside it the arms and legs are not
     * candidates at all and the ribcage belongs to the spine, which is what a
     * ribcage is. */
    const coreness = spec.core ? Number(spec.core.test(x, y, z)) : 0;
    cand.length = 0;
    for (let b = 0; b < spec.bones.length; b++) {
      const bone = spec.bones[b];
      const d = distToSegment(x, y, z, bone.head, bone.tail);
      /* A limb's pull is turned down inside the core rather than switched off
         at its surface: switched off, the ribs one millimetre inside the fence
         belong to the spine and the ribs one millimetre outside belong to an
         arm, and the triangle spanning the two is a spike. */
      const fence = coreness > 0 && !coreSet.has(b) ? 1 - coreness : 1;
      cand.push([b, fence * (1 / Math.pow(Math.max(d, EPS), POWER))]);
    }
    cand.sort((p, q) => q[1] - p[1]);
    const take = Math.min(share > 0 ? 2 : 4, cand.length);
    let total = 0;
    for (let k = 0; k < take; k++) total += cand[k][1];
    for (let k = 0; k < take; k++) {
      skinIndex[i * 4 + k] = cand[k][0];
      skinWeight[i * 4 + k] = (cand[k][1] / total) * (1 - share);
    }
    if (share > 0) {
      skinIndex[i * 4 + take] = claim[0];
      skinWeight[i * 4 + take] = claim[1] * share;
      skinIndex[i * 4 + take + 1] = claim[2];
      skinWeight[i * 4 + take + 1] = claim[3] * share;
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
  /* How hard this particular cloth swings.
     A cape hanging off one shoulder can throw itself around; a cloak that wraps
     both hips cannot, because its front panels are half a metre out from the
     chain driving them and a rotation that reads as a flick at the back reads
     as a sail at the front. One number per spec, rather than a second set of
     constants. */
  const gain = model.userData.capeSway ?? 1;

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
    const f = (0.55 + i * 0.28) * gain;
    bone.rotation.x = st.lift * f + flutter * f;
    bone.rotation.y = st.swing * f * 0.8;
    bone.rotation.z = Math.sin(st.phase * 0.7 + i) * 0.05 * (0.4 + stride) * gain;
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
function assignMaterialGroups(geometry, spec, char, weapon) {
  const pos = geometry.attributes.position.array;
  const index = geometry.index ? geometry.index.array : null;
  const triCount = index ? index.length / 3 : pos.length / 9;
  const region = new Uint8Array(triCount);        // 0 airframe, 1 wing, 2 visor
  const materials = spec.materials(char, weapon);
  const wep = spec.weapon ? weaponAxis(spec.weapon) : null;

  for (let t = 0; t < triCount; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) {
      const vi = index ? index[t * 3 + k] : t * 3 + k;
      cx += pos[vi * 3]; cy += pos[vi * 3 + 1]; cz += pos[vi * 3 + 2];
    }
    cx /= 3; cy /= 3; cz /= 3;

    /* The weapon is painted along its own length rather than by where it is in
       the world: how far this triangle sits from the grip toward the muzzle,
       as a fraction. Under `lit` it is casing, past it the emitter. A test in
       model space could not do this — the weapon hangs on a diagonal, so any
       axis-aligned cut across it slices the barrel lengthways. */
    if (wep?.test(cx, cy, cz)) {
      region[t] = wep.along(cx, cy, cz) > spec.weapon.lit ? spec.weapon.emitter : spec.weapon.casing;
      continue;
    }
    region[t] = spec.region(cx, cy, cz);
  }

  // Reorder the index buffer so each region is one contiguous draw group.
  const order = materials.map(() => []);
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

  return materials;
}

/* ------------------------------------------------------------------ weapon */
/**
 * Grip to muzzle: the line a mesh weapon is built along, and the capsule around
 * it that decides which vertices are the weapon.
 *
 * Everything about a held weapon is expressed against this one axis — which
 * part of it is lit, which way the mount is bound so the rig's aim runs down
 * the barrel, how far out the muzzle sits, and what belongs to it at all.
 *
 * A capsule rather than a box, because a box is the wrong shape for the
 * problem. Every one of these is a long thin thing leaving a fist at an angle,
 * and no axis-aligned box describes one: wide enough to hold a blade carried
 * diagonally, it also holds the thigh the blade passes; tight enough to miss
 * the thigh, it slices the blade lengthways and hands half of it to the body.
 * Measured along the weapon's own axis the test is two numbers — how far off
 * the line, and how far down it the claim starts — and `from` is the one that
 * earns its keep. It puts the seam *across* the weapon just below the fist,
 * which is where a held weapon's seam belongs and is a ring of a dozen
 * triangles, instead of running it the length of the blade's edge.
 *
 * `holds` is false for a character whose weapon is not a separate object at
 * all — Unloader's gauntlets are his hands — and then all of this collapses to
 * a mount and a muzzle, with nothing skinned to either.
 */
function weaponAxis(weapon) {
  const grip = new THREE.Vector3().fromArray(weapon.grip);
  const dir = new THREE.Vector3().fromArray(weapon.muzzle).sub(grip);
  const length = dir.length() || 1;
  dir.divideScalar(length);
  const from = (weapon.from ?? 0) * length;
  const radius = weapon.radius ?? 0;
  const _r = new THREE.Vector3();

  return {
    grip: weapon.grip, dir, length, holds: radius > 0 || !!weapon.also,
    /** How far along the axis, as a fraction of its length. */
    along(x, y, z) {
      return ((x - grip.x) * dir.x + (y - grip.y) * dir.y + (z - grip.z) * dir.z) / length;
    },
    /**
     * How much of this point is weapon rather than body — 1 well inside the
     * capsule, 0 outside it, and a ramp across the last two centimetres.
     *
     * Not a yes-or-no, because the capsule's surface runs through the hands
     * holding the thing. Cut hard there and one corner of a triangle rides the
     * rifle while the other two ride a forearm, which is a spike drawn across
     * the screen every time the weapon comes up.
     */
    test(x, y, z) {
      /* `also` is for the part of a weapon that does not fit around its own
         bore. A scope stands 12 cm proud of the barrel, and a capsule fat
         enough to reach it is fat enough to swallow both forearms and half the
         chest plate on the way past — so it is claimed by a second, tighter
         shape of its own instead. */
      if (weapon.also?.(x, y, z)) return 1;
      if (radius <= 0) return 0;
      _r.set(x - grip.x, y - grip.y, z - grip.z);
      const t = _r.dot(dir);
      if (t < from || t > length * 1.15) return 0;
      const perp = Math.sqrt(Math.max(0, _r.lengthSq() - t * t));
      return Math.max(0, Math.min(1, (radius - perp) / 0.025));
    },
  };
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

  /* The weapon mount, appended last so its index is `spec.bones.length` and the
     nearest-bone search in `computeSkinWeights` — which walks `spec.bones` —
     can never hand a body vertex to it.
     Its bind rotation is the whole trick. `poseWeapon` orients the mount so
     that its local +Z lies along the aim, so for the aim to run down the barrel
     the weapon's own grip-to-muzzle line has to *be* the mount's +Z at bind
     time. Rotating +Z onto that line, expressed in the forearm's frame, is
     exactly that; the weapon then pivots about the grip and points wherever the
     crosshair is, the same as a model held in a fist. */
  const mount = new THREE.Bone();
  mount.name = WEAPON_BONE;
  byName.set(WEAPON_BONE, mount);
  bones.push(mount);
  if (spec.weapon) {
    const hand = byName.get('armRlower');
    const handRot = worldRot.get('armRlower');
    const axis = weaponAxis(spec.weapon);
    _v.set(
      spec.weapon.grip[0] - hand.userData.head[0],
      spec.weapon.grip[1] - hand.userData.head[1],
      spec.weapon.grip[2] - hand.userData.head[2],
    );
    mount.position.copy(_v.applyQuaternion(_q.copy(handRot).invert()));
    mount.quaternion.setFromUnitVectors(
      FORWARD, _v.copy(axis.dir).applyQuaternion(_q.copy(handRot).invert()),
    );
    mount.userData.axisLength = axis.length;
    hand.add(mount);
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
     body, so the weapon tracks the crosshair. On an authored mesh it is the
     bone the weapon is skinned to rather than a Group to hang a model on —
     `poseWeapon` only ever sets a rotation, so it cannot tell the difference.

     A spec with no `weapon` block at all gets the built body's offset, and with
     it the procedural weapon model: an authored mesh that arrived empty-handed
     still needs something to shoot with. */
  const weaponMount = byName.get(WEAPON_BONE);
  if (!spec.weapon) {
    weaponMount.position.set(0.06, -0.2, 0.06);
    byName.get('armRlower').add(weaponMount);
  }

  /* The muzzle: where every shot in the game starts, parked at the end of the
     weapon's own axis. It hangs off the mount, so it swings with the aim. */
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, weaponMount.userData.axisLength ?? 0.9);
  weaponMount.add(muzzle);

  /* The carry the mesh was sculpted in, kept so `poseWeapon` can put the weapon
     back in it whenever there is nothing to aim at. */
  const mountRest = spec.weapon ? weaponMount.quaternion.clone() : null;

  const capeBones = (spec.cape?.bones || []).map((n) => byName.get(n)).filter(Boolean);
  const capeSway = spec.cape?.sway ?? 1;

  g.userData = {
    capeBones, capeSway,
    torso, torsoBaseY: torso.position.y, head: byName.get('head'),
    armL: arm('L'), armR,
    legL: leg('L', -1), legR: leg('R', 1),
    pelvis: byName.get('pelvis'),
    weaponMount, gripHand: null,
    visor: visorMaterial, build: char.build, hipY: spec.hipY, hat: null,
    authored: true,
    /* Two flags, and they are not the same question.
       `bodyWeapon` says the mesh already carries a weapon, so nothing should be
       attached to the mount and the muzzle below is the real one.
       `mountIsGeometry` says the mount has vertices skinned to it, which is
       what stops `poseWeapon` shoving it forward on a thrust — that lunge is
       there to drive a *separate* model out of the hand, and applied to a bone
       it would tear the blade off the fist holding it. */
    bodyWeapon: !!spec.weapon,
    mountIsGeometry: !!(spec.weapon?.radius || spec.weapon?.also),
    mountRest,
    muzzle,
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
      /* Surgery, once, on the geometry every instance shares. Detach first:
         it is the one that changes the vertex count, and a strip region is
         written against a mesh that has already been put right. */
      if (spec.detach) for (const piece of spec.detach) detachGeometry(geo, piece);
      if (spec.strip) stripGeometry(geo, spec.strip);
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

  const boneOrder = [...spec.bones.map((b) => b.name), WEAPON_BONE];
  const { skinIndex, skinWeight } = computeSkinWeights(
    geometry.attributes.position.array, spec, boneOrder,
  );
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

  const materials = assignMaterialGroups(geometry, spec, char, weaponById(char.weapon));
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
  attachArmour(g, byName, spec, char);
  return g;
}

const _boneInverse = new THREE.Matrix4();

/**
 * Hangs a spec's `attachments` off the bones they belong to.
 *
 * Each piece is built in model space and moved into its bone's frame here, by
 * the inverse of that bone's *bind* world matrix — which is exactly what the
 * bone's `matrixWorld` holds at this moment, because the skeleton has just been
 * bound and nothing has posed it yet. Author in the space you measured in, and
 * let one matrix do the rest.
 *
 * Sibling meshes sharing a material are then merged per bone. Ten plates and
 * six straps is thirty draw calls a body otherwise, and there can be eight
 * bodies.
 */
function attachArmour(g, byName, spec, char) {
  if (!spec.attachments) return;
  for (const piece of spec.attachments(char)) {
    const bone = byName.get(piece.bone);
    if (!bone) continue;
    const holder = new THREE.Group();
    for (const node of piece.nodes) holder.add(node);
    holder.applyMatrix4(_boneInverse.copy(bone.matrixWorld).invert());
    mergeSiblings(holder);
    bone.add(holder);
  }
}

/**
 * Collapses a group's mesh children into one mesh per material.
 *
 * `models.js` has `mergeStaticMeshes` for the same job on procedural bodies, but
 * it walks a whole tree and protects anything referenced from `userData`, and
 * this module cannot import it without the two files importing each other. The
 * job here is one flat group of primitives, which is the easy half of it.
 */
function mergeSiblings(group) {
  const byMaterial = new Map();
  for (const child of group.children) {
    if (!child.isMesh) continue;
    const list = byMaterial.get(child.material) || [];
    list.push(child);
    byMaterial.set(child.material, list);
  }
  for (const [material, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    const parts = meshes.map((m) => {
      m.updateMatrix();
      return m.geometry.clone().applyMatrix4(m.matrix);
    });
    const merged = mergeGeometryList(parts);
    for (const part of parts) part.dispose();
    if (!merged) continue;
    for (const m of meshes) group.remove(m);
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    group.add(mesh);
  }
}

/** Concatenates position/normal/uv buffers. Everything here is non-indexed. */
function mergeGeometryList(list) {
  const flat = list.map((geo) => (geo.index ? geo.toNonIndexed() : geo));
  const total = flat.reduce((n, geo) => n + geo.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    if (!flat.every((geo) => geo.attributes[name])) continue;
    const size = flat[0].attributes[name].itemSize;
    const arr = new Float32Array(total * size);
    let at = 0;
    for (const geo of flat) {
      arr.set(geo.attributes[name].array, at);
      at += geo.attributes[name].count * size;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  flat.forEach((geo, i) => { if (geo !== list[i]) geo.dispose(); });
  return out.attributes.position ? out : null;
}
