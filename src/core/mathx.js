// Small math helpers used across systems.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };

/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export const TAU = Math.PI * 2;

/*
 * Yaw and pitch that swing +Z onto a direction, for anything modelled facing
 * forward. Feed them to a `YXZ` Euler in that order and a third angle of your
 * own is a roll about the direction itself.
 *
 * Split into two scalar calls rather than one that returns a pair: these run
 * per effect per frame, and an object per call is garbage the frame does not
 * need. Neither wants a normalised input.
 *
 * The pitch is `atan2` against the horizontal length rather than `asin(y)`, so
 * it stays exact for an unnormalised vector and stays defined when the
 * direction is straight up. That is also the case with no yaw to recover —
 * `atan2(0, 0)` is zero rather than an error, but it is zero by luck, so the
 * yaw says so explicitly instead of reading noise out of two zeroes.
 */
export const aimYaw = (x, z) => (Math.abs(x) + Math.abs(z) > 1e-5 ? Math.atan2(x, z) : 0);
export const aimPitch = (x, y, z) => -Math.atan2(y, Math.hypot(x, z));

export function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

export function angleLerp(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

/** Diminishing-returns armor curve: 0 armor = 1.0x damage, negative armor amplifies. */
export function armorMultiplier(armor) {
  if (armor >= 0) return 100 / (100 + armor);
  return 2 - 100 / (100 - armor);
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function formatNumber(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

/** Percent chance to trigger, where >100% guarantees hits and rolls the remainder. */
export function rollProc(chance, rng) {
  if (chance <= 0) return 0;
  let count = Math.floor(chance);
  if (rng.next() < chance - count) count++;
  return count;
}

/**
 * Hyperbolic stacking, the standard "chance-like" curve.
 * 1 stack of a 15% item = 15%, 10 stacks approaches but never reaches 100%.
 */
export function hyperbolic(base, stacks) {
  return 1 - 1 / (1 + base * stacks);
}
