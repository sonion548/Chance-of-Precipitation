// Small math helpers used across systems.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };

/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export const TAU = Math.PI * 2;

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
