import * as THREE from 'three';

/**
 * Axis-separated collide-and-slide for vertical-cylinder characters against the
 * arena's axis-aligned boxes. Entities carry their feet position, a radius, and a
 * height; `velocity` is mutated in place when a collision cancels motion.
 */

const _tmp = new THREE.Vector3();

function overlapsBox(x, y, z, radius, height, box, skin = 0) {
  return (
    x + radius > box.min.x - skin && x - radius < box.max.x + skin &&
    z + radius > box.min.z - skin && z - radius < box.max.z + skin &&
    y + height > box.min.y - skin && y < box.max.y - skin
  );
}

/**
 * Moves an entity by `delta`, resolving collisions.
 * Returns { grounded, hitWall, groundY, ceiling }.
 */
export function moveWithCollision(entity, delta, world, opts = {}) {
  const { radius, height } = entity;
  const pos = entity.position;
  const stepHeight = opts.stepHeight ?? 0.85;
  // Broadphase: only the colliders whose cells the swept box touches.
  const pad = radius + Math.abs(delta.x) + Math.abs(delta.z) + 0.5;
  const colliders = world.queryAABB
    ? world.queryAABB(pos.x - pad, pos.z - pad, pos.x + pad, pos.z + pad).slice()
    : world.colliders;
  if (!colliders) return { grounded: false, hitWall: false, groundY: 0 };
  const arenaRadius = world.radius;

  let grounded = false;
  let hitWall = false;
  let groundY = 0;

  // ---- Horizontal (X then Z) with step-up ----
  for (const axis of ['x', 'z']) {
    const d = delta[axis];
    if (d === 0) continue;
    pos[axis] += d;
    for (const box of colliders) {
      if (!overlapsBox(pos.x, pos.y, pos.z, radius, height, box)) continue;

      // Small ledges are stepped over rather than blocking.
      const rise = box.max.y - pos.y;
      if (rise > 0 && rise <= stepHeight) {
        const clearAbove = !colliders.some((b) =>
          b !== box && overlapsBox(pos.x, box.max.y + 0.02, pos.z, radius, height, b));
        if (clearAbove) { pos.y = box.max.y + 0.001; grounded = true; groundY = box.max.y; continue; }
      }

      // Push back out along the axis of travel.
      pos[axis] = d > 0
        ? (axis === 'x' ? box.min.x - radius - 0.001 : box.min.z - radius - 0.001)
        : (axis === 'x' ? box.max.x + radius + 0.001 : box.max.z + radius + 0.001);
      if (entity.velocity) entity.velocity[axis] = 0;
      hitWall = true;
    }
  }

  // ---- Vertical ----
  pos.y += delta.y;
  // The floor is a surface, not a plane. Sampling it here rather than assuming
  // y = 0 is the whole of what makes the hills stand up: everything else in the
  // movement code was already asking the world how high the ground was.
  const terrainY = world.terrainHeightAt ? world.terrainHeightAt(pos.x, pos.z) : 0;
  if (delta.y <= 0) {
    // Falling / resting: find the highest surface we passed through.
    let best = terrainY;
    for (const box of colliders) {
      if (pos.x + radius <= box.min.x || pos.x - radius >= box.max.x) continue;
      if (pos.z + radius <= box.min.z || pos.z - radius >= box.max.z) continue;
      if (pos.y < box.max.y && pos.y - delta.y >= box.max.y - 0.35 && box.max.y > best) best = box.max.y;
    }
    if (pos.y <= best) { pos.y = best; grounded = true; groundY = best; if (entity.velocity) entity.velocity.y = 0; }
  } else {
    // Rising: bonk on the underside of platforms.
    for (const box of colliders) {
      if (!overlapsBox(pos.x, pos.y, pos.z, radius, height, box)) continue;
      if (pos.y + height > box.min.y && pos.y < box.min.y) {
        pos.y = box.min.y - height - 0.001;
        if (entity.velocity) entity.velocity.y = Math.min(0, entity.velocity.y);
      }
    }
  }

  // Walking uphill: the vertical pass only catches you on the way down, so a
  // slope you walk straight into would leave your feet inside it for a frame.
  // Lifting here keeps contact with the ground continuous, and the step limit
  // stops it doubling as a free climb up anything steep.
  if (terrainY > pos.y && terrainY - pos.y < stepHeight * 1.6) {
    pos.y = terrainY;
    grounded = true;
    groundY = terrainY;
    if (entity.velocity && entity.velocity.y < 0) entity.velocity.y = 0;
  }

  // ---- Arena boundary (radial clamp) ----
  const distXZ = Math.hypot(pos.x, pos.z);
  const limit = arenaRadius - radius - 0.4;
  if (distXZ > limit) {
    const s = limit / distXZ;
    pos.x *= s; pos.z *= s;
    hitWall = true;
    if (entity.velocity) {
      const n = _tmp.set(pos.x, 0, pos.z).normalize();
      const vd = entity.velocity.x * n.x + entity.velocity.z * n.z;
      if (vd > 0) { entity.velocity.x -= n.x * vd; entity.velocity.z -= n.z * vd; }
    }
  }

  return { grounded, hitWall, groundY };
}

/** Ray vs axis-aligned box slab test. Returns hit distance or null. */
export function rayBox(origin, dir, box) {
  let tmin = 0;
  let tmax = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const d = dir[axis];
    const o = origin[axis];
    if (Math.abs(d) < 1e-8) {
      if (o < box.min[axis] || o > box.max[axis]) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (box.min[axis] - o) * inv;
    let t2 = (box.max[axis] - o) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Nearest world-geometry hit along a ray, or null. */
/**
 * Ray against an explicit list of boxes, pre-filtered on an XZ bounding circle.
 *
 * Used only by the camera, against the foliage volumes that have no collider.
 * The list is a few hundred entries at most and this runs once per frame for
 * one entity, so a filtered linear scan is cheaper than another spatial grid.
 */
export function raycastBoxes(origin, dir, maxDist, boxes) {
  if (!boxes || !boxes.length) return null;
  let best = null;
  const ex = origin.x + dir.x * maxDist;
  const ez = origin.z + dir.z * maxDist;
  const midX = (origin.x + ex) * 0.5;
  const midZ = (origin.z + ez) * 0.5;
  const span = Math.hypot(ex - origin.x, ez - origin.z) * 0.5;
  for (const box of boxes) {
    const dx = box.cx - midX;
    const dz = box.cz - midZ;
    const reach = span + box.cr;
    if (dx * dx + dz * dz > reach * reach) continue;
    // A volume you are already standing inside cannot be occluding you, and
    // treating it as if it were pins the camera to the back of your head for
    // as long as you stand under the tree.
    if (origin.x > box.min.x && origin.x < box.max.x
      && origin.y > box.min.y && origin.y < box.max.y
      && origin.z > box.min.z && origin.z < box.max.z) continue;
    const t = rayBox(origin, dir, box);
    if (t !== null && t >= 0 && t <= maxDist && (best === null || t < best)) best = t;
  }
  return best;
}

export function raycastWorld(origin, dir, maxDist, world) {
  let best = null;
  const boxes = world.queryRay ? world.queryRay(origin, dir, maxDist) : world.colliders;
  for (const box of boxes) {
    const t = rayBox(origin, dir, box);
    if (t !== null && t >= 0 && t <= maxDist && (best === null || t < best.distance)) {
      best = { distance: t, box };
    }
  }
  // Ground. A flat world can solve this in one line; a world with hills has to
  // be marched. The march is guarded so it costs nothing on the common cases —
  // a ray already above every hill and climbing can never come back down to
  // meet one, and a level with no relief still takes the closed-form answer.
  const groundT = raycastGround(origin, dir, maxDist, world, best ? best.distance : Infinity);
  if (groundT !== null && (best === null || groundT < best.distance)) {
    best = { distance: groundT, ground: true };
  }
  // Arena wall (infinite cylinder) — keeps shots from escaping the level.
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a > 1e-8) {
    const b = 2 * (origin.x * dir.x + origin.z * dir.z);
    const c = origin.x * origin.x + origin.z * origin.z - world.radius * world.radius;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b + Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t <= maxDist && (best === null || t < best.distance)) best = { distance: t, wall: true };
    }
  }
  return best;
}

/**
 * First intersection of a ray with the terrain surface, or null.
 *
 * Marches at a step sized to the ray rather than to the world, then bisects the
 * segment that straddles the surface. Eight bisections put the hit within a
 * centimetre, which is well under the size of anything that gets drawn on it.
 */
export function raycastGround(origin, dir, maxDist, world, ceiling = Infinity) {
  const sample = world.terrainHeightAt;
  if (!sample) {
    if (dir.y >= -1e-6) return null;
    const t = -origin.y / dir.y;
    return t >= 0 && t <= maxDist ? t : null;
  }
  const top = world.terrainMax || 0;
  if (dir.y >= 0 && origin.y >= top) return null;
  const limit = Math.min(maxDist, ceiling);
  if (limit <= 0) return null;

  const height = (t) => origin.y + dir.y * t
    - sample.call(world, origin.x + dir.x * t, origin.z + dir.z * t);

  let prevT = 0;
  let prev = height(0);
  if (prev <= 0) return 0;           // started underground
  const steps = Math.min(140, Math.max(12, Math.ceil(limit / 1.4)));
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * limit;
    const h = height(t);
    if (h <= 0) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) * 0.5;
        if (height(mid) > 0) lo = mid; else hi = mid;
      }
      return hi;
    }
    prevT = t;
    prev = h;
  }
  return null;
}

/** Ray vs vertical capsule (approximated as a sphere-swept segment). */
export function rayCapsule(origin, dir, base, radius, height) {
  // Treat the body as a cylinder with spherical caps; test against the axis segment.
  const ax = base.x, az = base.z;
  const oy = origin.y;
  const dx = origin.x - ax;
  const dz = origin.z - az;
  const a = dir.x * dir.x + dir.z * dir.z;
  const b = 2 * (dx * dir.x + dz * dir.z);
  const c = dx * dx + dz * dz - radius * radius;

  if (a < 1e-8) {
    // Vertical shot: hit if we are already inside the cylinder's footprint.
    if (c > 0) return null;
    const t = dir.y > 0 ? (base.y - oy) / dir.y : (base.y + height - oy) / dir.y;
    return t >= 0 ? t : null;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t < 0) continue;
    const y = oy + dir.y * t;
    if (y >= base.y - radius * 0.5 && y <= base.y + height + radius * 0.5) return t;
  }
  return null;
}

/** Distance from point to the vertical segment of a character's body. */
export function distanceToBody(point, entity) {
  const y = Math.max(entity.position.y, Math.min(point.y, entity.position.y + entity.height));
  return Math.hypot(point.x - entity.position.x, point.y - y, point.z - entity.position.z);
}
