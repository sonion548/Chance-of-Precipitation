// Deterministic RNG (mulberry32) + weighted helpers.

export function hashSeed(str) {
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

export class RNG {
  constructor(seed = Date.now()) {
    this.seed = typeof seed === 'string' ? hashSeed(seed) : (seed >>> 0);
    this.state = this.seed || 1;
  }
  next() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min, max) { return min + this.next() * (max - min); }
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  bool(p = 0.5) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  /** Pick a key from an object of { key: weight }. Zero/negative weights are skipped. */
  weighted(table) {
    let total = 0;
    for (const k in table) if (table[k] > 0) total += table[k];
    if (total <= 0) return null;
    let roll = this.next() * total;
    for (const k in table) {
      if (table[k] <= 0) continue;
      roll -= table[k];
      if (roll <= 0) return k;
    }
    return Object.keys(table).find((k) => table[k] > 0) ?? null;
  }
  /** Random point on a circle of given radius (uniform over the disc when `solid`). */
  onCircle(radius, solid = false) {
    const a = this.next() * Math.PI * 2;
    const r = solid ? radius * Math.sqrt(this.next()) : radius;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }
}

/** Shared, non-deterministic instance for cosmetic effects (particles, jitter). */
export const fx = new RNG(Date.now() ^ 0x9e3779b9);
