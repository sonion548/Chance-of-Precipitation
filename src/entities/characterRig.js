import * as THREE from 'three';
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

export function createRig(yaw = 0) {
  return {
    modelYaw: yaw,
    walkPhase: Math.random() * 10,
    breathPhase: Math.random() * 10,
    swayPhase: Math.random() * 10,
    recoil: 0,
    flinch: 0,
    flinchDir: 0,
    ready: 0,
    land: 0,
    airTime: 0,
    prevGrounded: true,
    deathTime: 0,
    strafe: 0,
    forward: 0,
    turnRate: 0,
    prevYaw: yaw,
  };
}

/** Kick the whole upper body — called when a shot goes off. */
export function rigRecoil(rig, amount) {
  rig.recoil = Math.min(2.6, rig.recoil + amount);
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

  // Backing up runs the cycle the other way so the feet do not moonwalk.
  const dirSign = rig.forward < -0.25 ? -1 : 1;
  rig.walkPhase += dt * (2.0 + speed * 0.95) * dirSign;
  rig.breathPhase += dt * (1.05 + stride * 0.9);
  rig.swayPhase += dt * 0.53;
  const ph = rig.walkPhase;

  // Airborne / landing bookkeeping.
  if (s.grounded) {
    if (!rig.prevGrounded) rig.land = Math.min(1, 0.35 + rig.airTime * 0.9);
    rig.airTime = 0;
  } else {
    rig.airTime += dt;
  }
  rig.prevGrounded = s.grounded;
  rig.land = Math.max(0, rig.land - dt * 3.4);
  rig.recoil = damp(rig.recoil, 0, 11, dt);
  rig.flinch = Math.max(0, rig.flinch - dt * 3.2);

  // Weapon readiness. Rises almost instantly (you snap a gun up), falls slowly.
  const wantUp = s.weaponUp ? 1 : 0;
  rig.ready = wantUp > rig.ready
    ? Math.min(1, rig.ready + dt * 16)
    : damp(rig.ready, wantUp, 2.6, dt);

  if (s.dead) {
    rig.deathTime += dt;
    poseDeath(ud, rig, dt);
    applyCloak(model, s.cloaked);
    return;
  }
  rig.deathTime = 0;

  const breath = Math.sin(rig.breathPhase * Math.PI * 2 * 0.32);
  const idle = 1 - stride;                      // how "at rest" the body is
  const airborne = s.grounded ? 0 : clamp01(rig.airTime * 4);

  poseLegs(ud, rig, dt, { stride, dirSign, ph, airborne, land: rig.land, strafe: rig.strafe });
  posePelvis(ud, rig, dt, { stride, ph, land: rig.land, strafe: rig.strafe, breath, idle });
  poseTorso(ud, rig, dt, s, { stride, ph, breath, idle, airborne, land: rig.land });
  poseHead(ud, rig, dt, s, { breath, idle, ph, stride });
  poseArms(ud, rig, dt, s, { stride, ph, airborne, breath, idle });
  poseWeapon(ud, rig, dt, s);
  applyCloak(model, s.cloaked);
}

/* ------------------------------------------------------------------ legs */
function poseLegs(ud, rig, dt, o) {
  if (!ud.legL || !ud.legR) return;
  const { stride, dirSign, ph, airborne, land, strafe } = o;

  const legPose = (leg, phase) => {
    const sw = Math.sin(phase);
    // Real gait is asymmetric: the stance leg is straight and slow, the swing
    // leg bends hard and moves fast. One sine driving both reads as marching.
    leg.rotation.x = sw * 0.78 * stride * dirSign;
    const swingAmt = Math.max(0, -Math.cos(phase));
    const lower = leg.userData.lower;
    if (lower) lower.rotation.x = (0.12 + swingAmt * 1.15) * stride;
    if (leg.userData.ankle) {
      leg.userData.ankle.rotation.x = (-sw * 0.42 * dirSign - swingAmt * 0.25) * stride;
    }
    // Feet turn out toward the direction of travel when strafing.
    leg.rotation.y = damp(leg.rotation.y, strafe * 0.42, 10, dt);
    leg.rotation.z = 0;
  };
  legPose(ud.legL, ph);
  legPose(ud.legR, ph + Math.PI);

  // Crossover: the trailing leg swings across the body during a hard strafe.
  const cross = clamp(strafe, -1, 1) * 0.16;
  ud.legL.rotation.z = damp(ud.legL.rotation.z, cross, 10, dt);
  ud.legR.rotation.z = damp(ud.legR.rotation.z, cross, 10, dt);

  if (airborne > 0.01) {
    // Tuck: lead leg pulls up, trailing leg extends.
    const k = airborne;
    ud.legL.rotation.x = lerp(ud.legL.rotation.x, -0.62, k);
    ud.legR.rotation.x = lerp(ud.legR.rotation.x, 0.34, k);
    if (ud.legL.userData.lower) ud.legL.userData.lower.rotation.x = lerp(ud.legL.userData.lower.rotation.x, 1.15, k);
    if (ud.legR.userData.lower) ud.legR.userData.lower.rotation.x = lerp(ud.legR.userData.lower.rotation.x, 0.5, k);
    if (ud.legL.userData.ankle) ud.legL.userData.ankle.rotation.x = lerp(ud.legL.userData.ankle.rotation.x, 0.34, k);
    if (ud.legR.userData.ankle) ud.legR.userData.ankle.rotation.x = lerp(ud.legR.userData.ankle.rotation.x, 0.28, k);
  }

  if (land > 0.01) {
    // Absorb the landing: both knees bend, then spring back.
    for (const leg of [ud.legL, ud.legR]) {
      if (leg.userData.lower) leg.userData.lower.rotation.x += land * 0.85;
      leg.rotation.x -= land * 0.22;
    }
  }
}

/* ---------------------------------------------------------------- pelvis */
function posePelvis(ud, rig, dt, o) {
  if (!ud.pelvis) return;
  const { stride, ph, land, strafe, breath, idle } = o;
  // Hips rise twice per stride and counter-rotate against the shoulders.
  const bob = Math.abs(Math.sin(ph)) * 0.085 * stride;
  const idleBob = breath * 0.012 * idle;
  ud.pelvis.position.y = ud.hipY - 0.045 * stride - land * 0.26 + bob + idleBob;
  ud.pelvis.rotation.y = -Math.sin(ph) * 0.3 * stride + strafe * 0.24;
  ud.pelvis.rotation.z = Math.sin(ph) * 0.1 * stride - strafe * 0.12;
  ud.pelvis.rotation.x = damp(ud.pelvis.rotation.x, land * 0.2, 12, dt);
}

/* ----------------------------------------------------------------- torso */
function poseTorso(ud, rig, dt, s, o) {
  const torso = ud.torso;
  if (!torso) return;
  const { stride, ph, breath, idle, airborne, land } = o;

  const bob = Math.abs(Math.sin(ph)) * 0.05 * stride;
  const breathe = breath * (0.022 + idle * 0.03);
  torso.position.y = ud.torsoBaseY - 0.03 * stride - land * 0.24 + bob + breathe;

  // Shoulders counter-rotate against the hips; a lean into the turn on top.
  const counter = Math.sin(ph) * 0.28 * stride;
  const bank = -rig.strafe * 0.2 - rig.turnRate * 0.12;
  torso.rotation.y = damp(torso.rotation.y, counter - rig.turnRate * 0.22 + rig.flinch * rig.flinchDir * 0.2, 14, dt);
  torso.rotation.z = damp(torso.rotation.z, -Math.sin(ph) * 0.11 * stride + bank, 12, dt);

  // Spine pitch: follows the aim, leans into a run, folds on recoil and impacts.
  const lean = clamp(rig.forward * 0.22, -0.14, 0.22);
  const target = -s.pitch * 0.38 + lean - rig.recoil * 0.12 - rig.flinch * 0.16
    + land * 0.34 + airborne * 0.12;
  torso.rotation.x = damp(torso.rotation.x, target, 12, dt);

  // The chest itself swells with the breath cycle. Tiny, but it kills the
  // "statue with moving legs" read more than any of the big rotations do.
  const swell = 1 + breath * (0.012 + idle * 0.016);
  torso.scale.set(swell, 1 + breath * 0.006, swell);
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
  head.rotation.y = damp(head.rotation.y,
    -torso.rotation.y * 0.75 + drift + rig.turnRate * 0.3, 16, dt);
  head.rotation.z = damp(head.rotation.z, -torso.rotation.z * 0.6 - rig.strafe * 0.07, 16, dt);
  head.rotation.x = damp(head.rotation.x,
    -torso.rotation.x * 0.35 - s.pitch * 0.28 + nod + rig.recoil * 0.1 + rig.flinch * 0.22, 16, dt);
  // Slight vertical float so the neck is not welded.
  head.position.y = (ud.headBaseY ??= head.position.y)
    + Math.abs(Math.sin(ph)) * 0.012 * stride + breath * 0.008;
}

/* ------------------------------------------------------------------ arms */
function poseArms(ud, rig, dt, s, o) {
  if (!ud.armR || !ud.armL) return;
  const { stride, ph, airborne, breath, idle } = o;
  const ready = rig.ready;
  const aimLift = -s.pitch * 0.55;

  // Down-arm swing is a real gait swing; braced arms only get a fraction of it,
  // because a braced weapon damps the shoulder.
  const swingR = Math.sin(ph + Math.PI) * 0.62 * stride;
  const swingL = Math.sin(ph) * 0.62 * stride;

  /* ---- right arm: the weapon hand ---- */
  const bracedR = (-1.15 + aimLift) - rig.recoil * 0.55;
  const loweredR = -0.16 + swingR;
  ud.armR.rotation.x = damp(ud.armR.rotation.x,
    lerp(loweredR, bracedR + swingR * 0.5, ready) - airborne * 0.2, 18, dt);
  ud.armR.rotation.z = damp(ud.armR.rotation.z, lerp(0.06, -0.12, ready), 12, dt);
  ud.armR.rotation.y = damp(ud.armR.rotation.y, -rig.turnRate * 0.2 * ready, 12, dt);

  /* ---- left arm: supports the weapon, or reaches out on a grapple ---- */
  const bracedL = (-0.95 + aimLift) - rig.recoil * 0.28;
  const loweredL = -0.16 + swingL;
  const supportPose = s.grapple ? -1.5 : lerp(loweredL, bracedL - swingL * 0.5, ready);
  ud.armL.rotation.x = damp(ud.armL.rotation.x, supportPose - airborne * 0.2, 18, dt);
  ud.armL.rotation.z = damp(ud.armL.rotation.z,
    s.grapple ? 0.1 : lerp(-0.06, 0.34, ready), 12, dt);
  ud.armL.rotation.y = damp(ud.armL.rotation.y, s.grapple ? 0 : lerp(0.04, -0.28, ready), 12, dt);

  // Elbows.
  // Elbows pump either way: a braced arm still absorbs the stride, it just does
  // it with the forearm instead of the shoulder.
  if (ud.armR.userData.lower) {
    ud.armR.userData.lower.rotation.x = damp(ud.armR.userData.lower.rotation.x,
      lerp(0.34, 0.5 + rig.recoil * 0.5, ready) + Math.abs(swingR) * lerp(0.3, 0.22, ready), 18, dt);
  }
  if (ud.armL.userData.lower) {
    ud.armL.userData.lower.rotation.x = damp(ud.armL.userData.lower.rotation.x,
      s.grapple ? -0.35 : lerp(0.3, 0.85, ready) + Math.abs(swingL) * lerp(0.3, 0.22, ready), 14, dt);
  }

  // Shoulders shrug with the breath and rock with the stride.
  const shrug = breath * 0.03 * idle * (1 - ready * 0.6);
  const rock = Math.sin(ph) * 0.035 * stride;
  ud.armR.position.y = (ud.armRBaseY ??= ud.armR.position.y) + shrug - rock;
  ud.armL.position.y = (ud.armLBaseY ??= ud.armL.position.y) + shrug + rock;
}

/* ---------------------------------------------------------------- weapon */
function poseWeapon(ud, rig, dt, s) {
  const mount = ud.weaponMount;
  if (!mount || !mount.parent) return;

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

  // Local offsets, in the weapon's own frame: a natural cant, muzzle rise from
  // recoil, walking sway, and the barrel dropping when the weapon is stowed.
  const lower = 1 - rig.ready;
  // Sway is walk-driven: standing still, the barrel must not drift off the
  // crosshair at all, or precise shots feel like the game is lying to you.
  const sway = (1 - rig.ready * 0.7) * clamp01(rig.stride * 1.4);
  _euler.set(
    -rig.recoil * 0.45 + lower * 0.95 + Math.sin(rig.walkPhase) * 0.035 * sway,
    lower * 0.34 + Math.sin(rig.walkPhase * 0.5) * 0.045 * sway,
    -0.07 - lower * 0.22 + Math.sin(rig.walkPhase + 1.2) * 0.03 * sway,
    'XYZ',
  );
  _offsetQuat.setFromEuler(_euler);
  _aimQuat.multiply(_offsetQuat);

  _parentQuat.setFromRotationMatrix(mount.parent.matrixWorld).invert();
  mount.quaternion.copy(_parentQuat).multiply(_aimQuat);
}

/* ----------------------------------------------------------------- death */
function poseDeath(ud, rig, dt) {
  const t = clamp01(rig.deathTime * 1.6);
  const fall = t * t * (3 - 2 * t);
  if (ud.torso) {
    ud.torso.rotation.x = damp(ud.torso.rotation.x, 0.9 * fall, 6, dt);
    ud.torso.rotation.z = damp(ud.torso.rotation.z, 0.35 * fall, 6, dt);
    ud.torso.position.y = ud.torsoBaseY - 0.55 * fall;
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
    if (arm.userData.lower) arm.userData.lower.rotation.x = damp(arm.userData.lower.rotation.x, 0.2 * fall, 5, dt);
  }
}

/* ----------------------------------------------------------------- cloak */
function applyCloak(model, cloaked) {
  if (!cloaked && !model.userData._wasCloaked) return;
  model.userData._wasCloaked = !!cloaked;
  model.traverse((c) => {
    if (!c.material || !c.material.transparent) return;
    c.material.opacity = cloaked ? 0.35 : (c.userData.baseOpacity ?? 1);
  });
}
