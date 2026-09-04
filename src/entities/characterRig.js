import * as THREE from 'three';
import { swayCape } from './authoredRig.js';
import { clamp, clamp01, damp, lerp, wrapAngle, angleLerp } from '../core/mathx.js';

/**
 * Procedural animation for a character body built by `buildPlayerModel`.
 *
 * This lives apart from the Player because three different things drive the same
 * skeleton: the local player, a networked teammate, and anything else that wants
 * to puppet a body. They all feed the same descriptor and get the same motion.
 *
 * The design rule here is that *everything* moves, all the time. A body where
 * only the legs cycle reads as a mannequin on a treadmill — the eye picks up on
 * the still torso immediately. So the spine counter-rotates against the hips, the
 * chest breathes whether or not you are moving, the head stabilises against both,
 * arms swing when the weapon is down and brace when it is up, and shots, landings
 * and hits all push the whole upper body around.
 */

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _mountPos = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _aimQuat = new THREE.Quaternion();
const _offsetQuat = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _tmpAim = new THREE.Vector3();
const _restQuat = new THREE.Quaternion();
const _restFwd = new THREE.Vector3();
/** How far off the arm's own direction the weapon may be aimed. */
const WEAPON_CONE = 1.25;   // ~72 degrees
/**
 * The weapon's resting orientation in the hand.
 *
 * A barrel continues the line of the forearm, and the forearm runs down the
 * mount's local −Y, not its +Z. Rotating +Z onto −Y is a quarter turn about X;
 * the 0.3 taken off it is the wrist, which does not hold a gun perfectly in
 * line with the arm.
 */
const _holdOffset = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(Math.PI / 2 - 0.3, 0, 0, 'XYZ'));

export function createRig(yaw = 0) {
  return {
    modelYaw: yaw,
    walkPhase: Math.random() * 10,
    breathPhase: Math.random() * 10,
    swayPhase: Math.random() * 10,
    recoil: 0,
    flinch: 0,
    flinchDir: 0,
    // Attack playback: which move, how far through it, and which way the last
    // swing went (so a held attack alternates instead of repeating one stroke).
    attackKind: null,
    attackTime: 0,
    attackDur: 0.25,
    attackPower: 1,
    attackSide: 1,
    attack: 0,
    // Damped bases for the limbs the attack poses add on top of. Keeping these
    // apart from the Object3D rotations is what stops a swing from feeding its
    // own offset back into the smoothing every frame and over-rotating.
    // Thrusters: how far into the flight pose the body is, and a slow phase of
    // its own so the drift under thrust is not locked to the walk cycle.
    fly: 0,
    flyPhase: Math.random() * 10,
    dash: 0,
    travelF: 0,
    travelS: 0,
    idlePhase: Math.random() * 10,
    idleShift: 0,
    armRX: 0, armRY: 0, armRZ: 0, armRLower: 0,
    armLX: 0, armLY: 0, armLZ: 0, armLLower: 0,
    torsoY: 0, torsoZ: 0, torsoX: 0,
    ready: 0,
    land: 0,
    airTime: 0,
    // Where the body is in its arc, and how hard it left the ground. `rise` and
    // `fall` are not opposites: both are zero at the apex, which is the third
    // shape a jump has and the one the old single tuck was standing in for.
    rise: 0,
    fall: 0,
    launch: 0,
    fallSpeed: 0,
    prevVY: 0,
    prevGrounded: true,
    deathTime: 0,
    strafe: 0,
    forward: 0,
    turnRate: 0,
    prevYaw: yaw,
    // Gait blend weights: how much of this frame's pose is a forward run, a
    // backpedal, and a side-step. They are not exclusive — running diagonally
    // is genuinely part of two gaits at once, and the legs should say so.
    gaitF: 1,
    gaitB: 0,
    gaitS: 0,
    pivot: 0,
    lookOffset: 0,
    stepIndex: 0,
    onStep: null,
  };
}

/** Kick the whole upper body — called when a shot goes off. */
export function rigRecoil(rig, amount) {
  rig.recoil = Math.min(2.6, rig.recoil + amount);
}

/**
 * Play a weapon's attack move.
 *
 * `kind` is the `anim` a weapon ability declares: 'slash', 'punch', 'thrust',
 * 'pump', 'lob', 'beam' or 'shoot'. Melee kinds get a real body movement; the
 * shooting kinds are a shoulder punch on top of the existing recoil, which is
 * what they always were.
 */
export function rigAttack(rig, kind = 'shoot', power = 1) {
  if (!kind) return;
  rig.attackKind = kind;
  rig.attackTime = 0;
  rig.attackPower = 0.5 + 0.5 * (power ?? 1);
  rig.attackDur = ATTACK_DURATION[kind] ?? 0.2;
  rig.attackAntic = ATTACK_ANTICIPATION[kind] ?? 0.3;
  // Alternate the swing direction so holding attack reads as a sequence of
  // strokes rather than one shape stuttering.
  rig.attackSide = -(rig.attackSide || 1);
}

const ATTACK_DURATION = {
  slash: 0.38, punch: 0.30, punchL: 0.30, swing: 0.46, thrust: 0.28,
  pump: 0.32, lob: 0.34, beam: 0.16, shoot: 0.16,
};

/**
 * How far each move winds back before it goes forward, as a fraction of its
 * own full extension.
 *
 * This is the thing the animation was missing. Every strike used to begin at
 * rest and travel one way, which is what a swing looks like when nobody has
 * animated the part before it — the eye reads the absence immediately, because
 * nothing heavy in the world starts moving at full speed. A blade goes back
 * before it comes across, a fist is drawn in before it is thrown, and an
 * overarm lob reaches behind the shoulder first.
 *
 * A rifle does not, which is why `shoot` is almost nothing: the anticipation on
 * a gun is the trigger finger, and it is a recoil kick afterwards rather than a
 * wind-up before.
 */
const ATTACK_ANTICIPATION = {
  slash: 0.42, swing: 0.58, punch: 0.40, punchL: 0.40, thrust: 0.46,
  pump: 0.26, lob: 0.52, beam: 0, shoot: 0.06,
};

/* The four phases, as fractions of the move. Wind back, strike, hold at full
   extension, recover. The hold is two or three frames and is the whole of why
   a hit reads as landing on something rather than passing through it. */
const WIND_END = 0.26;
const STRIKE_END = 0.46;
const HOLD_END = 0.56;

/**
 * Attack envelope: wind up, strike, hold, recover.
 *
 * Returns a **signed** value, and that sign is the trick. Every attack pose in
 * this file is written as an offset scaled by this number, so a negative one
 * runs the same pose backwards and gives every move its anticipation for free —
 * the slash winds back along the arc it is about to cut, the punch pulls the
 * fist in along the line it is about to travel, and neither needed a second
 * pose written for it.
 *
 * Consumers must therefore test `Math.abs(rig.attack)`, never `rig.attack > 0`.
 */
function attackEnvelope(t, antic) {
  if (t <= 0 || t >= 1) return 0;
  // Wind back, accelerating away from rest.
  if (t < WIND_END) return -antic * Math.sin((t / WIND_END) * Math.PI * 0.5);
  // The strike itself: the fastest part of the move, covering the wind-up and
  // the full extension in a fifth of its duration.
  if (t < STRIKE_END) {
    const u = (t - WIND_END) / (STRIKE_END - WIND_END);
    return lerp(-antic, 1, Math.sin(u * Math.PI * 0.5));
  }
  // Contact. Held, not passed through.
  if (t < HOLD_END) return 1;
  // Recovery, back to the guard.
  return Math.cos(((t - HOLD_END) / (1 - HOLD_END)) * Math.PI * 0.5);
}

/** Take-a-hit flinch. `side` is -1..1 in the body's own frame. */
export function rigFlinch(rig, amount = 1, side = 0) {
  rig.flinch = Math.min(1.4, rig.flinch + amount);
  rig.flinchDir = side || (Math.random() - 0.5) * 2;
}

/**
 * Poses one character for this frame.
 *
 * `s` describes the body's situation, not its animation:
 *   position, yaw, pitch, velocity, speed, moveSpeed, grounded,
 *   aiming, firing, weaponUp, dead, grapple, cloaked, aimPoint
 */
export function updateRig(model, rig, dt, s) {
  const ud = model.userData;
  if (!ud) return;

  model.position.copy(s.position);

  /* ---- facing ----------------------------------------------------------
     The weapon is locked to the crosshair every frame, so the body has to
     agree with it: a character that turns to face its running direction while
     the gun stays on the crosshair looks like two separate objects. The body
     therefore always faces the aim, and the *legs* express which way it is
     actually travelling. */
  const turn = wrapAngle(s.yaw - rig.modelYaw);
  rig.modelYaw = angleLerp(rig.modelYaw, s.yaw, 1 - Math.exp(-16 * dt));
  rig.turnRate = damp(rig.turnRate, clamp(turn / Math.max(dt, 0.001) * 0.02, -1, 1), 8, dt);
  model.rotation.y = rig.modelYaw;

  /* How far the camera has swung off the body.
     The body is allowed to face its travel direction while the camera looks
     somewhere else entirely, so the head — and, to a lesser degree, the chest —
     turn to split the difference. Without this a character sprinting east while
     the player studies something to the north reads as if nobody is driving. */
  const lookTarget = s.lookYaw === undefined ? rig.modelYaw : s.lookYaw;
  rig.lookOffset = damp(rig.lookOffset, clamp(wrapAngle(lookTarget - rig.modelYaw), -1.5, 1.5), 11, dt);

  // Travel direction in the body's own frame.
  _fwd.set(Math.sin(rig.modelYaw), 0, Math.cos(rig.modelYaw));
  _right.set(-_fwd.z, 0, _fwd.x);
  const speed = s.speed ?? Math.hypot(s.velocity.x, s.velocity.z);
  const vz = s.velocity.x * _fwd.x + s.velocity.z * _fwd.z;
  const vx = s.velocity.x * _right.x + s.velocity.z * _right.z;
  const stride = clamp01(speed / Math.max(1, s.moveSpeed || 8));
  rig.stride = stride;
  const ref = Math.max(speed, 0.001);
  rig.forward = damp(rig.forward, vz / ref * stride, 10, dt);
  rig.strafe = damp(rig.strafe, vx / ref * stride, 10, dt);
  // The same two numbers undamped. A dash lasts a quarter of a second, which is
  // less than the smoothing above takes to arrive, so a pose that has to commit
  // to a direction *now* reads these instead.
  rig.travelF = vz / ref;
  rig.travelS = vx / ref;

  /* ---- gait blend ----
     Three cycles share one clock. Which of them you are actually watching is
     decided by where the body is travelling *in its own frame*: straight ahead
     is a run, straight back is a backpedal, sideways is a shuffle, and anything
     between is a weighted sum of them. Sharing the clock is what keeps the feet
     from stuttering as the blend moves — a diagonal is one continuous gait
     changing shape, not a crossfade between two animations. */
  const fAmt = clamp01(rig.forward);
  const bAmt = clamp01(-rig.forward);
  const sAmt = clamp01(Math.abs(rig.strafe));
  const total = Math.max(0.0001, fAmt + bAmt + sAmt);
  rig.gaitF = damp(rig.gaitF, fAmt / total, 12, dt);
  rig.gaitB = damp(rig.gaitB, bAmt / total, 12, dt);
  rig.gaitS = damp(rig.gaitS, sAmt / total, 12, dt);
  rig.strafeSign = Math.abs(rig.strafe) < 0.02 ? (rig.strafeSign || 1) : Math.sign(rig.strafe);

  // Backing up runs the cycle the other way so the feet do not moonwalk, and a
  // side-step is a shorter, quicker cycle than a run of the same speed.
  const dirSign = rig.gaitB > 0.55 ? -1 : 1;
  /* Legs can only turn over so fast.
     The cadence used to be driven by the raw speed, and the raw speed in this
     game is not bounded by the walk: Overclock adds 25%, Inferno 50%, a Speed
     Dash 45% and the dash itself moves at forty metres a second. Feeding any of
     those straight in spun the legs into a blur — the stride is already clamped
     to 1, so past a point the cycle was going faster without covering any more
     ground, which is the definition of a treadmill. */
  const cadenceSpeed = Math.min(speed, (s.moveSpeed || 8) * 1.45);
  const cadence = 2.0 + cadenceSpeed * (0.95 + rig.gaitS * 0.35 + rig.gaitB * 0.2);
  const prevPhase = rig.walkPhase;
  rig.walkPhase += dt * cadence * dirSign;
  rig.breathPhase += dt * (1.05 + stride * 0.9);
  rig.swayPhase += dt * 0.53;
  // Slow enough that a weight change is something you notice having happened
  // rather than something you watch happen: about eleven seconds a cycle.
  rig.idlePhase += dt * 0.58;
  const ph = rig.walkPhase;

  // A foot lands every half cycle. Reporting it here rather than guessing from
  // the speed means the sound is on the frame the foot actually arrives, at
  // whatever cadence the blend happens to be running.
  if (rig.onStep && s.grounded && stride > 0.14) {
    const a = Math.floor(prevPhase / Math.PI);
    const b = Math.floor(ph / Math.PI);
    if (a !== b) {
      rig.stepIndex++;
      rig.onStep(stride, rig.stepIndex);
    }
  }

  /* ---- the arc ----------------------------------------------------------
     A jump is three shapes, not one: the push off the ground, the moment at the
     top where the legs come up, and the fall, where they reach back down for
     the floor. The rig used to hold a single tuck for the whole time in the air
     and blend into it on a timer, which is why every jump in the game looked
     the same and looked like it was over before it started.

     All three are read off the vertical velocity, which costs nothing, needs no
     new call from the player, and works for a networked teammate — who is only
     ever described to us by where they are and how fast. */
  const vy = s.velocity?.y ?? 0;
  rig.rise = damp(rig.rise, s.grounded ? 0 : clamp01(vy / 8), 14, dt);
  rig.fall = damp(rig.fall, s.grounded ? 0 : clamp01(-vy / 12), 14, dt);

  /* The push-off, from an upward step in velocity too large to be gravity.
     Gravity is worth about 0.57 per frame and it is always negative, so an
     upward jump of 3+ is unambiguous — and because it is the velocity being
     read and not a jump button, this also catches the second jump, a pitched
     dash and anything else that throws the body upward. */
  const dv = vy - rig.prevVY;
  rig.prevVY = vy;
  if (dv > 3.2 && vy > 1.5) rig.launch = 1;
  rig.launch = Math.max(0, rig.launch - dt * 5.5);

  // Airborne / landing bookkeeping.
  if (s.grounded) {
    // Weighted by how hard the body actually arrived rather than by how long it
    // was in the air: a drop off a ledge and a hop over a rock are different
    // landings, and timing them made them the same one.
    if (!rig.prevGrounded) rig.land = clamp01(0.22 + rig.fallSpeed * 0.030);
    rig.airTime = 0;
    rig.fallSpeed = 0;
  } else {
    rig.airTime += dt;
    rig.fallSpeed = Math.max(rig.fallSpeed, -vy);
  }
  rig.prevGrounded = s.grounded;
  rig.land = Math.max(0, rig.land - dt * 3.4);
  rig.recoil = damp(rig.recoil, 0, 11, dt);
  rig.flinch = Math.max(0, rig.flinch - dt * 3.2);

  // Attack playback.
  if (rig.attackKind) {
    rig.attackTime += dt;
    const t = rig.attackTime / rig.attackDur;
    rig.attack = attackEnvelope(t, rig.attackAntic ?? 0.3) * rig.attackPower;
    if (t >= 1) { rig.attackKind = null; rig.attack = 0; }
  } else {
    rig.attack = 0;
  }

  // Weapon readiness. Rises almost instantly (you snap a gun up), falls slowly.
  // Mid-swing the weapon is up by definition, whatever the situation says.
  const wantUp = (s.weaponUp || Math.abs(rig.attack) > 0.02) ? 1 : 0;
  rig.ready = wantUp > rig.ready
    ? Math.min(1, rig.ready + dt * 16)
    : damp(rig.ready, wantUp, 2.6, dt);

  if (s.dead) {
    rig.deathTime += dt;
    poseDeath(ud, rig, dt);
    applyCloak(model, s.cloaked);
    // A cape keeps falling after its owner stops.
    swayCape(model, rig, dt, s);
    return;
  }
  rig.deathTime = 0;

  const breath = Math.sin(rig.breathPhase * Math.PI * 2 * 0.32);
  const idle = 1 - stride;                      // how "at rest" the body is
  const airborne = s.grounded ? 0 : clamp01(rig.airTime * 4);

  /* How far the pelvis twists into this step.
     Computed here rather than inside `posePelvis` because the legs need the
     same number: they hang off the pelvis, so whatever it does to them has to
     be answered at the hip. See `poseLegs`. */
  const pelvisSwing = -Math.sin(ph) * PELVIS_SWING * stride * (rig.gaitF + rig.gaitB);

  /* How far the hips turn into a melee swing. Shared by the pelvis, which does
     it, and the legs, which have to answer it — the same split the gait's own
     `pelvisSwing` uses, and for the same reason. */
  const meleeStep = (MELEE_KINDS.has(rig.attackKind) ? rig.attack : 0) * 0.22 * (rig.attackSide || 1);

  poseLegs(ud, rig, dt, { stride, dirSign, ph, airborne, land: rig.land, strafe: rig.strafe, pelvisSwing, meleeStep });
  posePelvis(ud, rig, dt, { stride, ph, land: rig.land, strafe: rig.strafe, breath, idle, pelvisSwing, meleeStep });
  poseTorso(ud, rig, dt, s, { stride, ph, breath, idle, airborne, land: rig.land });
  poseHead(ud, rig, dt, s, { breath, idle, ph, stride });
  poseArms(ud, rig, dt, s, { stride, ph, airborne, breath, idle });
  // After the gait, before the weapon: flight overrides the limbs, and the
  // weapon mount has to be resolved from wherever the arms actually ended up.
  poseFlight(ud, rig, dt, s);
  // A dash overrides both the gait and the flight pose: it is the most
  // committed thing the body does and it should look like nothing else.
  poseDash(ud, rig, dt, s);
  poseWeapon(ud, rig, dt, s);
  applyCloak(model, s.cloaked);
  // Cloth trails whatever the body just did, so it is settled last of all.
  swayCape(model, rig, dt, s);
}

/* How far the pelvis twists into each step, in radians at a full stride.
   Seventeen degrees was about double a real running gait, and because both legs
   hang rigidly off the pelvis it did not read as hip rotation — it swung the
   whole leg sideways, carrying the forward foot across the centreline. */
const PELVIS_SWING = 0.15;

/* How much of a splayed leg's stance is taken out as the stride comes up.

   A body sculpted standing still is sculpted with its feet apart — the
   authored meshes stand between 60 and 85 cm wide at the boots — and every
   swing the gait asks for is a rotation about the hip's lateral axis. Swing a
   leg that already points 17° outboard forward by 45° and the vertical drop
   shortens while the sideways offset does not, so the leg reads as swinging
   *out* as well as forward: measured on Dasher, an apparent stance of 17° at
   rest opening to 25° at mid-stride, on both legs, in opposite phase. That is
   the whole of the wide-legged run on the advanced models.

   A runner does the opposite — the faster they go the further under the body
   the feet land — so the correction is the same thing the animation was
   missing rather than a fudge over it: take the sculpted splay back out in
   proportion to the stride. `splayZ` is measured off each rig's own bones (see
   `publishRigContract`), so a body that was modelled standing straight gets
   nothing and nothing changes for it. */
const LEG_TUCK = 0.85;

/* How much of that twist the hips answer, so the legs keep tracking the way the
   body is going. This is what a femur does: the pelvis rotates and the leg
   rotates back under it, which is why a person's feet land in a line and not in
   a plait. Short of 1 on purpose — fully cancelling it reads as a mannequin
   sliding along a rail rather than someone walking. */
const LEG_TRACK = 0.75;

/* ------------------------------------------------------------------ legs */
/**
 * The legs carry the whole read of which way the body is travelling.
 *
 * Three poses are evaluated for every leg and mixed by the gait weights:
 *
 *   run        long swing about X, stance leg straight, swing leg folded hard
 *   backpedal  shorter swing, higher knee, toes reaching behind — a backwards
 *              walk is not a forwards walk played in reverse, the knee leads
 *   side-step  swing about Z instead: the leading leg abducts out into the
 *              direction of travel while the trailing leg crosses under, and
 *              the feet turn out so the ankles do not read as broken
 */
function poseLegs(ud, rig, dt, o) {
  if (!ud.legL || !ud.legR) return;
  const { stride, dirSign, ph, airborne, land, pelvisSwing, meleeStep } = o;
  const wF = rig.gaitF, wB = rig.gaitB, wS = rig.gaitS;
  const side = rig.strafeSign || 1;

  /* Turning on the spot.
     Spinning a standing body used to rotate it as one rigid piece, feet planted
     and sliding across the floor — the single most obvious mannequin tell left
     in the rig, and very visible in this game because the body is welded to a
     camera the player whips around. A person pivoting opens the leading foot
     out and lets the trailing one follow, so the two legs counter-yaw against
     each other in proportion to how fast the turn is and how little the stride
     is already explaining. */
  // Kept on the rig, not on `o`: the state object is rebuilt every frame, so a
  // damp seeded from it would restart from zero each time and never accumulate.
  rig.pivot = damp(rig.pivot,
    clamp(rig.turnRate, -1, 1) * 0.30 * (1 - stride) * (1 - airborne), 9, dt);
  o.pivot = rig.pivot;

  const legPose = (leg, phase, mirror) => {
    const sw = Math.sin(phase);
    const swingAmt = Math.max(0, -Math.cos(phase));

    // --- swing about X: forwards and backwards gaits ---
    const runX = sw * 0.78;
    const backX = sw * 0.46 - 0.10;              // sits behind the hip throughout
    const sideX = sw * 0.20;                     // a shuffle barely leaves the ground
    leg.rotation.x = (runX * wF + backX * wB + sideX * wS) * stride * dirSign;

    // --- knee ---
    const lower = leg.userData.lower;
    if (lower) {
      const runK = 0.12 + swingAmt * 1.15;
      const backK = 0.30 + swingAmt * 1.55;      // knee leads a backwards step
      const sideK = 0.18 + swingAmt * 0.7;
      lower.rotation.x = (runK * wF + backK * wB + sideK * wS) * stride;
    }

    // --- ankle ---
    if (leg.userData.ankle) {
      const runA = -sw * 0.42 * dirSign - swingAmt * 0.25;
      const backA = -sw * 0.2 * dirSign + 0.18;  // toes reach for the ground behind
      const sideA = -sw * 0.14 * dirSign;
      leg.userData.ankle.rotation.x = (runA * wF + backA * wB + sideA * wS) * stride;
    }

    /* --- swing about Z: the side-step ---
       The two legs are half a cycle apart, so one abducts out into the travel
       direction while the other adducts under the body. `mirror` is which leg
       this is, and it biases the resting stance wider on the leading side. */
    const abduct = (Math.sin(phase) * 0.40 + 0.10 * mirror) * wS * stride * side;
    // Running keeps a hint of the old crossover so a hard diagonal still leans.
    const cross = clamp(rig.strafe, -1, 1) * 0.16 * (wF + wB);
    // The rest splay set at build time is the baseline, not zero — writing an
    // absolute here is what collapsed the stance back to parallel on frame one.
    const rest = leg.userData.restZ ?? 0;
    // Bring a splayed leg under the body in proportion to how hard it is
    // running. Zero on a body modelled with its legs already vertical.
    const tuck = (leg.userData.splayZ ?? 0) * stride * LEG_TUCK;
    leg.rotation.z = damp(leg.rotation.z, rest + tuck - abduct + cross, 12, dt);

    /* --- yaw: where the foot points, and undoing the pelvis ---
       Feet turn out towards the direction of travel; a side-step turns them
       much further than a diagonal run does. That part is damped, because it
       follows your intent and should not snap.

       The pelvis compensation is not, and must not be: it cancels something
       that oscillates at stride frequency, and a damped answer would lag a
       quarter of a cycle behind the thing it is answering and leave the foot
       swinging out anyway. So the damped toe-out is kept on the leg itself and
       the counter-rotation is added on top of it, undamped — the same
       separation the arms use for their attack poses, and for the same reason. */
    const toeOut = rig.strafe * (0.42 + wS * 0.55) + wB * -rig.strafe * 0.2;
    leg.userData.toeOut = damp(leg.userData.toeOut ?? 0, toeOut, 10, dt);
    leg.rotation.y = leg.userData.toeOut - pelvisSwing * LEG_TRACK + o.pivot * mirror
      // The hips turn into a swing; the legs give some of it back, so the feet
      // stay planted while the body rotates over them rather than skating round
      // with it. Same relationship the gait already has with `pelvisSwing`.
      - meleeStep * LEG_TRACK;
  };
  legPose(ud.legL, ph, 1);
  legPose(ud.legR, ph + Math.PI, -1);

  /* --- off the ground ---
     Three poses again, and for the same reason the gait has three: which one
     you are looking at is a fact about the body's state, not about how long it
     has been in this state.

       push    driven off a straightening leg, the other trailing, toes down
       apex    knees up, the shape everything used to hold for the whole jump
       reach   legs swinging down and forward, ankles flexed to take the floor

     `rise` and `fall` are both zero at the top of the arc, so the apex weight
     falls out of them rather than needing its own test. */
  if (airborne > 0.01) {
    const rise = rig.rise;
    const fall = rig.fall;
    const apex = Math.max(0, 1 - rise - fall);
    const k = airborne;

    // Lead / trail split, so the two legs never mirror exactly — a body with
    // its legs in perfect symmetry in the air reads as a doll being dropped.
    const legAir = (leg, lead) => {
      if (!leg) return;
      const push = lead ? 0.34 : 0.12;          // extended, driving down and back
      const tuck = lead ? -0.66 : 0.30;         // knees up
      const reach = lead ? -0.30 : -0.06;       // swinging down to meet the floor
      leg.rotation.x = lerp(leg.rotation.x, push * rise + tuck * apex + reach * fall, k);

      const rest = leg.userData.restZ ?? 0;
      const out = leg.userData.outZ ?? 1;
      // Together at the top, opening again to take the landing.
      leg.rotation.z = lerp(leg.rotation.z, rest - out * (0.07 * apex - 0.03 * fall), k);

      if (leg.userData.lower) {
        const kn = (lead ? 0.16 : 0.34) * rise + (lead ? 1.25 : 0.55) * apex + (lead ? 0.30 : 0.16) * fall;
        leg.userData.lower.rotation.x = lerp(leg.userData.lower.rotation.x, kn, k);
      }
      if (leg.userData.ankle) {
        // Pointed off the push, relaxed at the top, and toes up on the way down:
        // a foot that stays pointed into a landing is a foot that breaks.
        const an = 0.5 * rise + 0.3 * apex - 0.34 * fall;
        leg.userData.ankle.rotation.x = lerp(leg.userData.ankle.rotation.x, an, k);
      }
    };
    legAir(ud.legL, true);
    legAir(ud.legR, false);
  }

  /* The push itself: a short, hard extension of both legs as the body leaves.
     Added over the air pose rather than blended into it, because it is an
     impulse and not a state — it wants to be visible for a tenth of a second
     and then gone, whatever the arc is doing around it. */
  if (rig.launch > 0.01) {
    for (const leg of [ud.legL, ud.legR]) {
      if (!leg) continue;
      leg.rotation.x += rig.launch * 0.30;
      // Straightened, and no further: zero is a straight leg, and a knee is the
      // one joint on the body with nothing behind it to stop at. Subtracting
      // the push blind drove it to -0.43 — a shin bent backwards through the
      // kneecap, which is a good deal more noticeable than the pose it was
      // meant to improve.
      const knee = leg.userData.lower;
      if (knee) knee.rotation.x = Math.max(0, knee.rotation.x - rig.launch * 0.55);
      if (leg.userData.ankle) leg.userData.ankle.rotation.x += rig.launch * 0.55;
    }
  }

  if (land > 0.01) {
    // Absorb the landing: both knees bend, then spring back.
    for (const leg of [ud.legL, ud.legR]) {
      if (leg.userData.lower) leg.userData.lower.rotation.x += land * 0.85;
      leg.rotation.x -= land * 0.22;
    }
  }
}

/**
 * May this rig move a joint, as opposed to turning one?
 *
 * On a body built out of primitives every joint is a Group with its own boxes
 * hanging off it, so sliding one up an inch slides its geometry with it and
 * nothing else moves. On an authored mesh it is a *bone*, and the vertices
 * around it are shared with the bones on either side — so the same inch does
 * not move the chest, it stretches the waist into it. That is the whole of why
 * the advanced models used to visibly change shape as they ran: the breath, the
 * step bob, the shoulder shrug and the head float were all translations, and on
 * a skinned body a translation is a deformation.
 *
 * So on a skinned body the rig rotates and does not translate. The one
 * exception is the pelvis, which is the root: moving it carries every other
 * bone with it, which is a body bobbing rather than a body stretching.
 */
const canTranslate = (ud) => !ud.authored;

/** Moves that are thrown with the body rather than fired from it. */
const MELEE_KINDS = new Set(['slash', 'swing', 'punch', 'punchL', 'thrust']);

/* ---------------------------------------------------------------- pelvis */
function posePelvis(ud, rig, dt, o) {
  if (!ud.pelvis) return;
  const { stride, ph, land, strafe, breath, idle } = o;
  // Hips rise twice per stride and counter-rotate against the shoulders. A
  // side-step bobs less and swings the pelvis laterally instead, which is the
  // difference between a shuffle and a strange sideways march.
  const bobScale = 0.085 * (1 - rig.gaitS * 0.55);
  const bob = Math.abs(Math.sin(ph)) * bobScale * stride;
  const idleBob = breath * 0.012 * idle;
  const sway = Math.sin(ph) * 0.06 * rig.gaitS * stride * (rig.strafeSign || 1);
  /* Standing still is not standing still.
     Nobody holds their weight evenly on both feet for more than a few seconds;
     they settle onto one hip, drift, and change over. It is a very small
     movement and it is most of the difference between a character who is idle
     and a character who has been paused — and unlike the breath, which is
     vertical and easy to miss, this one moves the silhouette. Its own slow
     clock so it never syncs up with the breathing. */
  const weight = Math.sin(rig.idlePhase) * o.idle;
  ud.pelvis.position.y = ud.hipY - 0.045 * stride - land * 0.26 + bob + idleBob
    - Math.abs(weight) * 0.012;
  ud.pelvis.position.x = (ud.hipX ??= ud.pelvis.position.x) + sway + weight * 0.022;
  // The swing half comes in from `updateRig` so the legs can answer the exact
  // same number. The strafe offset stays here: it is a standing orientation
  // rather than part of the step, and the feet are meant to follow it.
  ud.pelvis.rotation.y = o.pelvisSwing + strafe * 0.24;
  ud.pelvis.rotation.z = Math.sin(ph) * (0.1 + rig.gaitS * 0.12) * stride - strafe * 0.12
    + weight * 0.05;

  /* Stepping into a swing.
     A strike used to be entirely above the waist, which is how a swing looks
     when the person doing it is bolted to the floor. The hips lead it: they
     load back over the rear foot through the wind-up and drive through as the
     blow lands — and because `rig.attack` is signed, both halves of that come
     out of one number without a second pose being written. */
  const melee = MELEE_KINDS.has(rig.attackKind) ? rig.attack : 0;
  ud.pelvis.rotation.y += o.meleeStep;
  ud.pelvis.rotation.x = damp(ud.pelvis.rotation.x, land * 0.2 - rig.gaitB * stride * 0.1, 12, dt)
    + melee * 0.12;
}

/* ----------------------------------------------------------------- torso */
function poseTorso(ud, rig, dt, s, o) {
  const torso = ud.torso;
  if (!torso) return;
  const { stride, ph, breath, idle, airborne, land } = o;

  const bob = Math.abs(Math.sin(ph)) * 0.05 * stride;
  const breathe = breath * (0.022 + idle * 0.03);
  if (canTranslate(ud)) {
    torso.position.y = ud.torsoBaseY - 0.03 * stride - land * 0.24 + bob + breathe;
  }

  // Shoulders counter-rotate against the hips; a lean into the turn on top.
  const counter = Math.sin(ph) * 0.28 * stride * (rig.gaitF + rig.gaitB);
  const bank = -rig.strafe * 0.2 - rig.turnRate * 0.12;
  // A quarter of the camera's offset is carried by the chest; the head takes
  // most of the rest. Splitting it across the spine is what stops the neck
  // doing all of the work and looking snapped.
  const chestLook = rig.lookOffset * 0.24 * (1 - rig.ready * 0.7);
  rig.torsoY = damp(rig.torsoY,
    counter - rig.turnRate * 0.22 + chestLook + rig.flinch * rig.flinchDir * 0.2, 14, dt);
  rig.torsoZ = damp(rig.torsoZ, -Math.sin(ph) * 0.11 * stride + bank, 12, dt);

  // Spine pitch: follows the aim, leans into a run, folds on recoil and impacts.
  // Backing up leans away rather than into it, which is most of what sells a
  // retreat as deliberate instead of as a run played backwards.
  const lean = clamp(rig.forward * 0.22, -0.2, 0.22);
  /* Through the arc the trunk does the opposite of the legs: it opens up over
     the push, hangs at the top, and curls forward on the way down to get the
     feet out in front. `airborne * 0.12` used to be the whole of it, which is a
     constant, and a constant is the one thing a body in the air is not. */
  const arc = -rig.launch * 0.22 - rig.rise * 0.10 + rig.fall * 0.20;
  const target = -s.pitch * 0.38 + lean - rig.recoil * 0.12 - rig.flinch * 0.16
    + land * 0.34 + arc;
  rig.torsoX = damp(rig.torsoX, target, 12, dt);

  /* A swing is a whole-body movement or it is a wrist flick. The trunk leads
     the arm round on a slash, drops a shoulder into a punch, and squares up
     behind a thrust — added on top of the damped bases rather than into them,
     so the smoothing never inherits its own offset. */
  const atk = rig.attack;
  const side = rig.attackSide;
  let twist = 0;
  let fold = 0;
  let roll = 0;
  if (Math.abs(atk) > 0.001) {
    switch (rig.attackKind) {
      case 'slash': twist = side * 0.52 * atk; roll = side * 0.14 * atk; fold = 0.1 * atk; break;
      /* A round swing is a slash with the whole body behind it: the trunk
         leads further and always the same way, because a chain on a length of
         iron has one direction it can be thrown and it is not negotiable. */
      case 'swing': twist = 0.85 * atk; roll = 0.2 * atk; fold = 0.14 * atk; break;
      case 'punch': twist = -0.34 * atk; fold = 0.24 * atk; roll = 0.1 * atk; break;
      // The other fist, so the shoulders open the opposite way.
      case 'punchL': twist = 0.34 * atk; fold = 0.24 * atk; roll = -0.1 * atk; break;
      case 'thrust': twist = -0.18 * atk; fold = 0.2 * atk; break;
      case 'pump': twist = 0.16 * atk; fold = 0.12 * atk; break;
      case 'lob': twist = -side * 0.2 * atk; fold = -0.14 * atk; break;
      default: fold = 0.06 * atk; break;
    }
  }
  torso.rotation.y = rig.torsoY + twist;
  torso.rotation.z = rig.torsoZ + roll;
  torso.rotation.x = rig.torsoX + fold;

  /* The chest itself swells with the breath cycle. Tiny, but it kills the
     "statue with moving legs" read more than any of the big rotations do.

     Not on a skinned body, where it is not a chest being scaled but a bone —
     and every vertex weighted partly to it and partly to its neighbours gets
     pulled off the surface it belongs to. Non-uniform scale down a bone chain
     is the single worst thing you can do to a skinned mesh; on the authored
     characters this was the breathing visibly inflating and deflating the
     torso as they ran. */
  const swell = canTranslate(ud) ? 1 + breath * (0.012 + idle * 0.016) : 1;
  torso.scale.set(swell, canTranslate(ud) ? 1 + breath * 0.006 : 1, swell);
}

/* ---------------------------------------------------------------- flight */
/**
 * Under thrust.
 *
 * Everything else here is a gait: it reads the horizontal speed and works out
 * how the feet should be meeting the ground. Flight has no ground to meet, and
 * it is not a gait with the floor deleted — that is what it looked like before,
 * and a walk cycle with nothing under it is the most obviously wrong thing a
 * character can do. Under thrust the legs stop being what moves you and become
 * what trails behind you, and the throttle takes over from the stride as the
 * thing the whole body answers to:
 *
 *   climbing   vertical, legs hanging, chest tipped back over the thrust
 *   cruising   pitched forward into the direction of travel, legs streamed out
 *   hovering   upright and loose, drifting on its own slow phase
 *
 * Written as a blend over the finished ground pose rather than as a branch
 * around it. Taking off then eases out of the walk instead of cutting, landing
 * eases back in, and anything that still has a claim on the arms — aiming, or
 * an ability mid-flight — keeps them by holding its own weight back.
 */
function poseFlight(ud, rig, dt, s) {
  // Slightly slower in than out: a takeoff wants to look like it is being
  // fought for, a landing wants the legs under you before you touch.
  const want = s.flying ? 1 : 0;
  rig.fly = damp(rig.fly, want, want > rig.fly ? 6 : 10, dt);
  if (rig.fly < 0.002) return;

  const k = rig.fly;
  rig.flyPhase += dt * 1.5;
  const sway = Math.sin(rig.flyPhase);
  const sway2 = Math.sin(rig.flyPhase * 0.73 + 1.1);

  const climb = clamp(s.flightClimb ?? 0, -1, 1);
  const drive = clamp01(rig.stride);            // how hard you are going somewhere
  /* Banking. A body under thrust turns by rolling into it — this is the one
     place the rig can say "these are thrusters and not a jetpack-shaped hat",
     and without it a flying character changing direction just rotates on the
     spot like a turret. */
  const bank = clamp(rig.turnRate, -1, 1) * 0.5;

  /* --- trunk ---
     Nose down into a cruise, chest up under climb. This is the whole read: a
     flying body says which way it is going with its spine, not its legs. */
  const lean = drive * 0.34 - climb * 0.44;
  if (ud.torso) {
    ud.torso.rotation.x = lerp(ud.torso.rotation.x, lean + sway * 0.03, k);
    ud.torso.rotation.z = lerp(ud.torso.rotation.z,
      -rig.strafe * 0.44 - bank + sway2 * 0.03, k);
    // Yawing into the turn as well as rolling: a shoulder leads the direction
    // the body is coming round to, the way a diver's does.
    ud.torso.rotation.y = lerp(ud.torso.rotation.y, rig.turnRate * 0.18, k);
  }
  if (ud.pelvis) {
    // The pelvis follows the chest at half depth and stops counter-rotating —
    // there is no step for it to counter.
    ud.pelvis.rotation.x = lerp(ud.pelvis.rotation.x, lean * 0.55, k);
    ud.pelvis.rotation.y = lerp(ud.pelvis.rotation.y, 0, k);
    ud.pelvis.rotation.z = lerp(ud.pelvis.rotation.z, -rig.strafe * 0.2 - bank * 0.5, k);
    ud.pelvis.position.y = lerp(ud.pelvis.position.y, ud.hipY ?? ud.pelvis.position.y, k);
  }

  /* --- legs ---
     Trailing, toes pointed, scissoring gently against each other. How far they
     trail is the throttle: streamed out behind a fast cruise, hanging straight
     down off a hard climb. */
  const trail = 0.22 + drive * 0.6 - climb * 0.18;
  const knee = 0.55 - drive * 0.3;
  // The legs swing outboard of the roll, which is what keeps a bank reading as
  // the whole body coming round rather than the chest alone.
  const legBank = bank * 0.5;
  for (const [leg, sign] of [[ud.legL, 1], [ud.legR, -1]]) {
    if (!leg) continue;
    const scissor = sway * 0.11 * sign;
    const rest = leg.userData.restZ ?? 0;
    const out = leg.userData.outZ ?? 1;
    leg.rotation.x = lerp(leg.rotation.x, trail + scissor, k);
    leg.rotation.z = lerp(leg.rotation.z, rest + out * 0.06 + sway2 * 0.025 * sign - legBank, k);
    leg.rotation.y = lerp(leg.rotation.y, 0, k);
    if (leg.userData.lower) {
      leg.userData.lower.rotation.x = lerp(leg.userData.lower.rotation.x, knee - scissor * 1.1, k);
    }
    if (leg.userData.ankle) {
      // Pointed. A flat foot in the air is a person standing on nothing.
      leg.userData.ankle.rotation.x = lerp(leg.userData.ankle.rotation.x, 0.6 + scissor * 0.5, k);
    }
  }

  /* --- arms ---
     Swept back and out, the way somebody hanging off their own shoulders holds
     them. Yielded entirely the moment the weapon comes up or an ability plays:
     those poses are load-bearing — the weapon is cone-clamped to the arm, so an
     arm left out here would drag the gun off the crosshair. */
  const free = k * (1 - rig.ready) * (1 - clamp01(Math.abs(rig.attack)));
  if (free > 0.002) {
    for (const [arm, sign] of [[ud.armR, 1], [ud.armL, -1]]) {
      if (!arm) continue;
      arm.rotation.x = lerp(arm.rotation.x, 0.4 + sway * 0.1 * sign, free);
      arm.rotation.y = lerp(arm.rotation.y, -0.16 * sign, free);
      arm.rotation.z = lerp(arm.rotation.z, sign * (0.9 + sway2 * 0.06), free);
      if (arm.userData.lower) {
        arm.userData.lower.rotation.x = lerp(arm.userData.lower.rotation.x, -0.24, free);
      }
    }
  }
}

/* ------------------------------------------------------------------ dash */
/**
 * The dash, which is not a fast run.
 *
 * A dash moves at thirty to forty-five metres a second for about a quarter of a
 * second. Fed to the gait that is simply a very large `speed`, and the gait did
 * the only thing it could with it: ran the walk cycle as fast as it would go.
 * The result was a character crossing ten metres with their legs going round
 * like a cartoon, which is the single least convincing thing the rig did.
 *
 * What a body actually does over a distance it cannot take a step through is
 * commit: it points itself at where it is going and stops cycling. So the legs
 * trail split behind the direction of travel, the trunk drives into it, and the
 * arms sweep back out of the way. It reads as one shape held for four frames,
 * which is exactly how long it lasts.
 *
 * Blended over the finished pose rather than branching around it, so the run
 * flows into it and back out; and yielded from the arms the moment the weapon
 * is up, for the same reason flight yields them — the mount is cone-clamped to
 * the arm and an arm swept back here would drag the weapon off the crosshair.
 */
function poseDash(ud, rig, dt, s) {
  // Fast in, slower out: a dash should snap into its shape and settle out of it.
  rig.dash = damp(rig.dash, s.dashing ? 1 : 0, s.dashing ? 22 : 9, dt);
  if (rig.dash < 0.002) return;

  const k = rig.dash;
  // Undamped, because the whole move is over before the damping would arrive.
  const f = clamp(rig.travelF, -1, 1);
  const side = clamp(rig.travelS, -1, 1);

  if (ud.torso) {
    // Into the direction of travel — including backwards, where a dash away
    // from something leans away from it rather than pretending to charge.
    ud.torso.rotation.x = lerp(ud.torso.rotation.x, f * 0.42, k);
    ud.torso.rotation.z = lerp(ud.torso.rotation.z, -side * 0.40, k);
    ud.torso.rotation.y = lerp(ud.torso.rotation.y, side * 0.24, k);
  }
  if (ud.pelvis) {
    ud.pelvis.rotation.x = lerp(ud.pelvis.rotation.x, f * 0.2, k);
    ud.pelvis.rotation.z = lerp(ud.pelvis.rotation.z, -side * 0.18, k);
  }

  /* Legs split along the line of travel and hold there — a leading leg reaching
     out of the dash and a trailing one still behind it, neither of them cycling.
     Dashing sideways splits them laterally instead, which is the difference
     between a lunge and a hop. */
  for (const [leg, lead] of [[ud.legL, 1], [ud.legR, -1]]) {
    if (!leg) continue;
    const rest = leg.userData.restZ ?? 0;
    const out = leg.userData.outZ ?? 1;
    leg.rotation.x = lerp(leg.rotation.x, -f * (0.30 + lead * 0.34), k);
    leg.rotation.z = lerp(leg.rotation.z, rest - out * side * (0.34 + lead * 0.2), k);
    leg.rotation.y = lerp(leg.rotation.y, 0, k);
    if (leg.userData.lower) {
      // The trailing leg folds, the leading one reaches. Never negative.
      leg.userData.lower.rotation.x = lerp(leg.userData.lower.rotation.x,
        Math.max(0, 0.42 + lead * 0.34 * f), k);
    }
    if (leg.userData.ankle) leg.userData.ankle.rotation.x = lerp(leg.userData.ankle.rotation.x, 0.4, k);
  }

  const free = k * (1 - rig.ready) * (1 - clamp01(Math.abs(rig.attack)));
  if (free > 0.002) {
    for (const [arm, sign] of [[ud.armR, 1], [ud.armL, -1]]) {
      if (!arm) continue;
      // Swept back and tucked in, the way arms go when the body is thrown.
      arm.rotation.x = lerp(arm.rotation.x, 0.75 - f * 0.3, free);
      arm.rotation.z = lerp(arm.rotation.z, sign * 0.34, free);
      if (arm.userData.lower) arm.userData.lower.rotation.x = lerp(arm.userData.lower.rotation.x, -0.5, free);
    }
  }
}

/* ------------------------------------------------------------------ head */
function poseHead(ud, rig, dt, s, o) {
  const head = ud.head;
  const torso = ud.torso;
  if (!head || !torso) return;
  const { breath, idle, ph, stride } = o;

  // The head stabilises against everything the body does under it, then adds
  // its own slow drift while idle so it never sits perfectly still.
  const drift = Math.sin(rig.swayPhase * 1.7) * 0.05 * idle;
  const nod = Math.sin(rig.swayPhase * 1.1) * 0.03 * idle + breath * 0.02 * idle;
  // The head is where the decoupled camera is most visible: it goes on looking
  // at whatever you are looking at while the body runs somewhere else.
  head.rotation.y = damp(head.rotation.y,
    -torso.rotation.y * 0.75 + drift + rig.turnRate * 0.3
    + clamp(rig.lookOffset, -1.1, 1.1) * 0.62, 16, dt);
  head.rotation.z = damp(head.rotation.z, -torso.rotation.z * 0.6 - rig.strafe * 0.07, 16, dt);
  head.rotation.x = damp(head.rotation.x,
    -torso.rotation.x * 0.35 - s.pitch * 0.28 + nod + rig.recoil * 0.1 + rig.flinch * 0.22, 16, dt);
  // Slight vertical float so the neck is not welded — on a body that has a
  // neck to float. On a skinned one it stretches the throat instead.
  if (canTranslate(ud)) {
    head.position.y = (ud.headBaseY ??= head.position.y)
      + Math.abs(Math.sin(ph)) * 0.012 * stride + breath * 0.008;
  }
}

/* ------------------------------------------------------------------ arms */
function poseArms(ud, rig, dt, s, o) {
  if (!ud.armR || !ud.armL) return;
  const { stride, ph, airborne, breath, idle } = o;

  // Seed the damped bases from the pose the model was built in, or the first
  // frame snaps the arms to zero and then eases back — a visible flinch at spawn.
  if (!rig._armsInit) {
    rig._armsInit = true;
    rig.armRX = ud.armR.rotation.x; rig.armRY = ud.armR.rotation.y; rig.armRZ = ud.armR.rotation.z;
    rig.armLX = ud.armL.rotation.x; rig.armLY = ud.armL.rotation.y; rig.armLZ = ud.armL.rotation.z;
    rig.armRLower = ud.armR.userData.lower?.rotation.x ?? 0;
    rig.armLLower = ud.armL.userData.lower?.rotation.x ?? 0;
  }
  const ready = rig.ready;
  const aimLift = -s.pitch * 0.55;

  // Down-arm swing is a real gait swing; braced arms only get a fraction of it,
  // because a braced weapon damps the shoulder.
  // A side-step barely swings the arms and a backpedal swings them short, so
  // the amplitude is a blend too rather than one constant.
  const swingAmp = 0.62 * rig.gaitF + 0.42 * rig.gaitB + 0.20 * rig.gaitS;
  const swingR = Math.sin(ph + Math.PI) * swingAmp * stride;
  const swingL = Math.sin(ph) * swingAmp * stride;
  // Arms drift across the chest during a shuffle, the way they do when you are
  // side-stepping and keeping your guard between you and something.
  const sideDrift = rig.gaitS * stride * (rig.strafeSign || 1) * 0.22;

  /* ---- right arm: the weapon hand ---- */
  const bracedR = (-1.15 + aimLift) - rig.recoil * 0.55;
  const loweredR = -0.16 + swingR;
  /* What the arms do in the air, and only while they are free to do it.
     A braced weapon owns the shoulder — the mount is cone-clamped to the arm,
     so an arm thrown up here would drag the gun off the crosshair — so all of
     this is scaled by how far the weapon is *down*.

     Off the push the arms swing up and back; on the way down they come out
     wide, which is what a body does when it is about to have to balance. */
  // The raw arc, before either arm's own claim on it is taken into account.
  const arcLift = -rig.launch * 0.55 - rig.rise * 0.22 + rig.fall * 0.30;
  const arcSpread = rig.fall * 0.36 + rig.launch * 0.18;

  rig.armRX = damp(rig.armRX,
    lerp(loweredR, bracedR + swingR * 0.5, ready) - airborne * 0.2 + arcLift * (1 - ready), 18, dt);
  rig.armRZ = damp(rig.armRZ,
    lerp(0.06, -0.12, ready) - sideDrift - arcSpread * (1 - ready), 12, dt);
  rig.armRY = damp(rig.armRY, -rig.turnRate * 0.2 * ready, 12, dt);

  /* ---- left arm: supports the weapon, or reaches out on a grapple ---- */
  /* Unless it is already holding something.
     The support pose exists to put a second hand on a rifle, and it is exactly
     wrong for the two characters carrying a shield and a second blade — the
     shield came up across the chest every time a target appeared, which is a
     plate being aimed rather than a plate being carried. A busy offhand keeps
     most of its carry through the ready blend: it lifts a little, the way a
     shield does when you square up, and no further. */
  const readyL = ud.offhandHeld ? ready * 0.26 : ready;
  const bracedL = (-0.95 + aimLift) - rig.recoil * 0.28;
  const loweredL = -0.16 + swingL;
  const supportPose = s.grapple ? -1.5 : lerp(loweredL, bracedL - swingL * 0.5, readyL);
  rig.armLX = damp(rig.armLX,
    supportPose - airborne * 0.2 + arcLift * (1 - readyL), 18, dt);
  rig.armLZ = damp(rig.armLZ,
    s.grapple ? 0.1 : lerp(-0.06, 0.34, readyL) - sideDrift + arcSpread * (1 - readyL), 12, dt);
  rig.armLY = damp(rig.armLY, s.grapple ? 0 : lerp(0.04, -0.28, readyL), 12, dt);

  /* Elbows.
     Negative bends the forearm *forward*, which is the only direction a human
     elbow goes. Every one of these used to be positive, which folded both arms
     backwards at the elbow — most obvious with the weapon lowered, where the
     hands ended up behind the hips.
     Elbows pump either way: a braced arm still absorbs the stride, it just does
     it with the forearm instead of the shoulder. */
  rig.armRLower = damp(rig.armRLower,
    -(lerp(0.34, 0.42 + rig.recoil * 0.5, ready) + Math.abs(swingR) * lerp(0.3, 0.22, ready)), 18, dt);
  rig.armLLower = damp(rig.armLLower,
    s.grapple ? -0.35 : -(lerp(0.3, 0.7, readyL) + Math.abs(swingL) * lerp(0.3, 0.22, readyL)), 14, dt);

  const atk = poseAttackArms(rig);
  ud.armR.rotation.x = rig.armRX + atk.rx;
  ud.armR.rotation.y = rig.armRY + atk.ry;
  ud.armR.rotation.z = rig.armRZ + atk.rz;
  ud.armL.rotation.x = rig.armLX + atk.lx;
  ud.armL.rotation.y = rig.armLY + atk.ly;
  ud.armL.rotation.z = rig.armLZ + atk.lz;
  if (ud.armR.userData.lower) ud.armR.userData.lower.rotation.x = rig.armRLower + atk.rElbow;
  if (ud.armL.userData.lower) ud.armL.userData.lower.rotation.x = rig.armLLower + atk.lElbow;

  // Shoulders shrug with the breath and rock with the stride — again, only
  // where a shoulder is a Group of its own and not a bone sharing its skin
  // with the chest it would otherwise tear away from.
  if (canTranslate(ud)) {
    const shrug = breath * 0.03 * idle * (1 - ready * 0.6);
    const rock = Math.sin(ph) * 0.035 * stride;
    ud.armR.position.y = (ud.armRBaseY ??= ud.armR.position.y) + shrug - rock;
    ud.armL.position.y = (ud.armLBaseY ??= ud.armL.position.y) + shrug + rock;
  }
}

/**
 * How far each arm joint is pushed out of its resting pose by the current
 * attack, in the arm's own frame. Returns offsets, never absolute angles —
 * the caller adds them to the damped bases.
 *
 * The moves themselves:
 *   slash   the weapon arm sweeps across the body, elbow opening through it
 *   punch   the shoulder drives forward and the elbow snaps straight
 *   thrust  a shorter, straighter version of the punch, both hands on the line
 *   pump    the support hand racks the action back and lets it go
 *   lob     an overarm throw: the arm comes up and over
 */
function poseAttackArms(rig) {
  const out = { rx: 0, ry: 0, rz: 0, lx: 0, ly: 0, lz: 0, rElbow: 0, lElbow: 0 };
  const a = rig.attack;
  if (Math.abs(a) <= 0.001) return out;
  const side = rig.attackSide;
  switch (rig.attackKind) {
    case 'slash':
      out.ry = side * 1.35 * a;
      out.rx = -0.6 * a;
      out.rz = -side * 0.45 * a;
      out.rElbow = -0.4 * a;
      out.ly = side * 0.7 * a;
      out.lx = -0.25 * a;
      out.lElbow = -0.3 * a;
      break;
    case 'punch':
      out.rx = -0.95 * a;
      out.rz = -0.18 * a;
      out.rElbow = -0.75 * a;
      out.lx = 0.5 * a;
      out.lElbow = 0.5 * a;
      break;
    /* The same punch thrown off the other shoulder. Written out rather than
       folded into `punch` with a sign, because the two arms do not have
       mirrored rest poses — the left is the support hand — and mirroring the
       offsets would land the left fist somewhere the right one never goes. */
    case 'punchL':
      out.lx = -0.95 * a;
      out.lz = 0.18 * a;
      out.lElbow = -0.75 * a;
      out.rx = 0.5 * a;
      out.rElbow = 0.5 * a;
      break;
    /* A round swing: the arm comes across from outside the shoulder, opening
       through the elbow, and the far hand stays out of its way. Bigger than a
       slash in every axis — this is a weight on the end of a chain. */
    case 'swing':
      out.ry = 1.9 * a;
      out.rx = -0.5 * a;
      out.rz = -0.7 * a;
      out.rElbow = -0.55 * a;
      out.ly = 0.5 * a;
      out.lz = -0.2 * a;
      break;
    case 'thrust':
      out.rx = -0.6 * a;
      out.rElbow = -0.55 * a;
      out.lx = -0.35 * a;
      out.lElbow = -0.35 * a;
      break;
    case 'pump':
      out.lx = 0.55 * a;
      out.lElbow = 0.7 * a;
      out.rx = -0.16 * a;
      break;
    case 'lob':
      out.rx = -0.85 * a;
      out.rElbow = 0.6 * a;
      out.rz = -0.2 * a;
      break;
    default:
      out.rx = -0.2 * a;
      out.rElbow = 0.16 * a;
      break;
  }
  return out;
}

/* ---------------------------------------------------------------- weapon */
/**
 * The weapon, and where it is allowed to point.
 *
 * There are two answers now and the character picks one.
 *
 * A **fixed** weapon is part of the body. It sits in the hand in the carry it
 * was authored in and moves for exactly one reason: the arm moved. A spear
 * swung in a slash goes where the shoulder takes it; standing still, it hangs
 * where a spear hangs. This is what every character carries, and it is the
 * reason a weapon reads as belonging to the person holding it — the old
 * behaviour swivelled the gun onto the crosshair independently of the arm, so a
 * body running one way with the camera pointed another had a rifle rotating in
 * a fist that was plainly not turning with it.
 *
 * An **aimed** weapon is the exception, and it is a scope: Sniper's longrifle
 * has to sit exactly on the line the round is going down, because the whole
 * character is that line. One character, deliberately.
 */
function poseWeapon(ud, rig, dt, s) {
  const mount = ud.weaponMount;
  if (!mount || !mount.parent) return;

  if (!ud.aimWeapon) { poseFixedWeapon(ud, rig); return; }

  mount.parent.updateWorldMatrix(true, false);
  mount.getWorldPosition(_mountPos);

  // Aim at the resolved aim POINT, not along the pitch angle. The crosshair is
  // resolved through the camera, which sits behind and above the muzzle, so
  // matching angles leaves the barrel off-target by the parallax — up to 25° when
  // looking steeply down.
  const aimPoint = s.aimPoint || _tmpAim.set(
    s.position.x + Math.sin(s.yaw) * Math.cos(s.pitch) * 40,
    s.position.y + 1.4 + Math.sin(s.pitch) * 40,
    s.position.z + Math.cos(s.yaw) * Math.cos(s.pitch) * 40,
  );
  _aimDir.copy(aimPoint).sub(_mountPos);
  if (_aimDir.lengthSq() < 1e-6) return;
  _aimDir.normalize();

  /* Build a full orientation, not just a direction.
     `setFromUnitVectors(+Z, aim)` gives the shortest arc from world +Z, which
     carries an arbitrary amount of roll: the weapon canted by ~15° on a diagonal
     aim, and flipped fully upside down when aiming near world −Z. Constructing an
     explicit basis against world up keeps the sights on top at every angle. */
  _up.copy(WORLD_UP);
  if (Math.abs(_aimDir.y) > 0.999) _up.copy(FALLBACK_UP);
  _right.crossVectors(_up, _aimDir).normalize();
  _up.crossVectors(_aimDir, _right).normalize();
  _basis.makeBasis(_right, _up, _aimDir);
  _aimQuat.setFromRotationMatrix(_basis);

  // The weapon itself moves with the attack: a blade rolls over through its
  // arc, a fist and a spear are driven forward out of the hand's rest position.
  const a = rig.attack;
  let swingRoll = 0;
  let swingPitch = 0;
  let reach = 0;
  if (Math.abs(a) > 0.001) {
    switch (rig.attackKind) {
      case 'slash': swingRoll = rig.attackSide * 1.15 * a; swingPitch = -0.3 * a; break;
      case 'swing': swingRoll = 1.6 * a; swingPitch = -0.15 * a; break;
      case 'punch': case 'punchL': reach = 0.34 * a; swingPitch = -0.12 * a; break;
      case 'thrust': reach = 0.42 * a; break;
      case 'pump': swingPitch = 0.22 * a; reach = -0.1 * a; break;
      case 'lob': swingPitch = -0.4 * a; break;
      default: break;
    }
  }
  /* A punch or a thrust drives the weapon out of the hand — but only a weapon
     that is a separate model, which the hand can travel with. On an authored
     mesh the mount is a bone with the weapon skinned to it and the fist is not,
     so translating it would slide the blade out of the fingers holding it. The
     arm still lunges; the weapon just stays in the hand while it does. */
  if (!ud.mountIsGeometry) {
    ud.mountBaseZ ??= mount.position.z;
    ud.mountBaseY ??= mount.position.y;
    mount.position.z = ud.mountBaseZ + reach;
    mount.position.y = ud.mountBaseY + reach * 0.18;
  }

  /* Local offsets, in the weapon's own frame: a natural cant, muzzle rise from
     recoil, walking sway, and the barrel dropping when the weapon is stowed.

     A mesh weapon does not drop: it goes back to the carry it was sculpted in,
     which `mountRest` holds — see the slerp at the bottom. Applying the stow
     droop as well would take a rifle held across the chest and point it at its
     owner's boot. */
  const lower = ud.mountRest ? 0 : 1 - rig.ready;
  // Sway is walk-driven: standing still, the barrel must not drift off the
  // crosshair at all, or precise shots feel like the game is lying to you.
  const sway = (1 - rig.ready * 0.7) * clamp01(rig.stride * 1.4);
  _euler.set(
    -rig.recoil * 0.45 + lower * 0.95 + Math.sin(rig.walkPhase) * 0.035 * sway + swingPitch,
    lower * 0.34 + Math.sin(rig.walkPhase * 0.5) * 0.045 * sway,
    -0.07 - lower * 0.22 + Math.sin(rig.walkPhase + 1.2) * 0.03 * sway + swingRoll,
    'XYZ',
  );
  _offsetQuat.setFromEuler(_euler);
  _aimQuat.multiply(_offsetQuat);

  /* Bring the world-space aim back into the mount's parent.
   *
   * `setFromRotationMatrix` assumes a pure rotation, and `matrixWorld` here is
   * not one: the torso group is scaled every frame by the breathing, which
   * propagates down the arm. `getWorldQuaternion` decomposes properly, which
   * costs a little more and is right. */
  mount.parent.getWorldQuaternion(_parentQuat);
  _restQuat.copy(_parentQuat);
  _parentQuat.invert();

  /* Clamp the weapon to a cone around the arm.
   *
   * The weapon tracks the crosshair and the arm does not, so when the body is
   * facing its travel direction rather than the camera — which is most of the
   * time now that the two are decoupled — an unclamped aim swings the gun to
   * point somewhere the hand plainly is not. Limiting it to what the shoulder
   * could plausibly reach keeps the pose honest; the body snaps to the camera
   * the moment you actually fire, so the clamp is a backstop rather than
   * something you feel. */
  _restQuat.multiply(_holdOffset);
  const restFwd = _restFwd.set(0, 0, 1).applyQuaternion(_restQuat);
  const angle = Math.acos(clamp(restFwd.dot(_aimDir), -1, 1));
  if (angle > WEAPON_CONE) {
    _aimQuat.slerpQuaternions(_restQuat, _aimQuat, WEAPON_CONE / angle);
  }

  mount.quaternion.copy(_parentQuat).multiply(_aimQuat);

  /* Stowed, a mesh weapon sits exactly where it was sculpted.
   *
   * A procedural weapon can be pointed anywhere because it is a separate model
   * in a hand that goes with it. A weapon skinned into the body is different:
   * the sculptor drew a carry — a rifle across the chest, a blade hanging at
   * the hip — and the hands are drawn around it. `mountRest` is that carry, and
   * `ready` is the blend to it, so the weapon comes up to the crosshair when
   * there is something to shoot and goes back to the pose the art intended when
   * there is not. */
  if (ud.mountRest) mount.quaternion.slerp(ud.mountRest, 1 - rig.ready);
}

/**
 * A weapon welded into the hand.
 *
 * The rest pose is whatever the art intended — `mountRest` for a mesh weapon
 * sculpted into the body, and the standard hold for a model dropped into a
 * fist, which continues the line of the forearm with a little wrist under it.
 * On top of that go the same swing offsets the aimed path uses, so a slash
 * still rolls the blade over and a thrust still drives the point out; they are
 * simply expressed in the hand's frame instead of in the world's.
 */
function poseFixedWeapon(ud, rig) {
  const mount = ud.weaponMount;
  const rest = ud.mountRest ?? (ud.mountFixedRest ??= _holdOffset.clone());

  const a = rig.attack;
  let swingRoll = 0;
  let swingPitch = 0;
  let reach = 0;
  if (Math.abs(a) > 0.001) {
    switch (rig.attackKind) {
      case 'slash': swingRoll = rig.attackSide * 1.15 * a; swingPitch = -0.3 * a; break;
      case 'swing': swingRoll = 1.6 * a; swingPitch = -0.15 * a; break;
      case 'punch': case 'punchL': reach = 0.34 * a; swingPitch = -0.12 * a; break;
      case 'thrust': reach = 0.42 * a; break;
      case 'pump': swingPitch = 0.22 * a; reach = -0.1 * a; break;
      case 'lob': swingPitch = -0.4 * a; break;
      default: swingPitch = -rig.recoil * 0.35; break;
    }
  }
  _euler.set(swingPitch - rig.recoil * 0.3, 0, swingRoll, 'XYZ');
  _offsetQuat.setFromEuler(_euler);
  mount.quaternion.copy(rest).multiply(_offsetQuat);

  // Same rule as the aimed path: a weapon that is vertices in the body's own
  // buffer cannot be slid out of the fist holding it.
  if (!ud.mountIsGeometry) {
    ud.mountBaseZ ??= mount.position.z;
    ud.mountBaseY ??= mount.position.y;
    mount.position.z = ud.mountBaseZ + reach;
    mount.position.y = ud.mountBaseY + reach * 0.18;
  }
}

/* ----------------------------------------------------------------- death */
function poseDeath(ud, rig, dt) {
  const t = clamp01(rig.deathTime * 1.6);
  const fall = t * t * (3 - 2 * t);
  if (ud.torso) {
    ud.torso.rotation.x = damp(ud.torso.rotation.x, 0.9 * fall, 6, dt);
    ud.torso.rotation.z = damp(ud.torso.rotation.z, 0.35 * fall, 6, dt);
    if (canTranslate(ud)) ud.torso.position.y = ud.torsoBaseY - 0.55 * fall;
    ud.torso.scale.setScalar(1);
  }
  if (ud.pelvis) {
    ud.pelvis.position.y = ud.hipY - 0.6 * fall;
    ud.pelvis.rotation.x = 0.3 * fall;
  }
  if (ud.head) ud.head.rotation.x = damp(ud.head.rotation.x, -0.5 * fall, 6, dt);
  for (const leg of [ud.legL, ud.legR]) {
    if (!leg) continue;
    leg.rotation.x = damp(leg.rotation.x, -0.9 * fall, 6, dt);
    if (leg.userData.lower) leg.userData.lower.rotation.x = damp(leg.userData.lower.rotation.x, 1.5 * fall, 6, dt);
  }
  for (const arm of [ud.armL, ud.armR]) {
    if (!arm) continue;
    arm.rotation.x = damp(arm.rotation.x, 0.4 * fall, 5, dt);
    arm.rotation.z = damp(arm.rotation.z, 0, 5, dt);
    if (arm.userData.lower) arm.userData.lower.rotation.x = damp(arm.userData.lower.rotation.x, -0.2 * fall, 5, dt);
  }
}

/* ----------------------------------------------------------------- cloak */
/**
 * Fades the whole body out while something is hiding it.
 *
 * What a part comes *back* to is whatever it was authored at, which has to be
 * remembered before the first dim — restoring everything to 1 turns the
 * Wraith's 28%-opacity eye glow and the shells around its orb into solid balls
 * the moment Event Horizon drops. It is recorded on the material rather than
 * the mesh because merging leaves several meshes sharing one material, and the
 * second of those would otherwise record the already-dimmed value.
 *
 * `Math.min` for the same reason in the other direction: a shell authored at 5%
 * must not become *more* visible for being cloaked.
 */
function applyCloak(model, cloaked) {
  if (!cloaked && !model.userData._wasCloaked) return;
  model.userData._wasCloaked = !!cloaked;
  model.traverse((c) => {
    if (!c.material) return;
    // An authored mesh carries one material per region, so `c.material` is an
    // array — reading `.transparent` off the array itself silently skipped it.
    for (const mat of (Array.isArray(c.material) ? c.material : [c.material])) {
      if (!mat.transparent) continue;
      const ud = mat.userData;
      if (ud.baseOpacity === undefined) ud.baseOpacity = mat.opacity;
      mat.opacity = cloaked ? Math.min(ud.baseOpacity, 0.35) : ud.baseOpacity;
    }
  });
}
