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
  if (delta.y <= 0) {
    // Falling / resting: find the highest surface we passed through.
    let best = 0;
    for (const box of colliders) {
      if (pos.x + radius <= box.min.x || pos.x - radius >= box.max.x) continue;
      if (pos.z + radius <= box.min.z || pos.z - radius >= box.max.z) continue;
      if (pos.y < box.max.y && pos.y - delta.y >= box.max.y - 0.35 && box.max.y > best) best = box.max.y;
    }
    if (pos.y <= best) { pos.y = best; grounded = true; groundY = best; if (entity.velocity) entity.velocity.y = 0; }
    if (pos.y <= 0) { pos.y = 0; grounded = true; groundY = 0; if (entity.velocity) entity.velocity.y = 0; }
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
export function raycastWorld(origin, dir, maxDist, world) {
  let best = null;
  const boxes = world.queryRay ? world.queryRay(origin, dir, maxDist) : world.colliders;
  for (const box of boxes) {
    const t = rayBox(origin, dir, box);
    if (t !== null && t >= 0 && t <= maxDist && (best === null || t < best.distance)) {
      best = { distance: t, box };
    }
  }
  // Ground plane at y = 0
  if (dir.y < -1e-6) {
    const t = -origin.y / dir.y;
    if (t >= 0 && t <= maxDist && (best === null || t < best.distance)) best = { distance: t, ground: true };
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
