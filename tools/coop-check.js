#!/usr/bin/env node
/**
 * Co-op terrain agreement.
 *
 * Everything in a shared descent is negotiable except the ground. Two players
 * on the same seed have to build the same colliders, or one of them watches the
 * other walk around knee-deep in the floor. That property is easy to break by
 * accident — a cosmetic tweak that draws one extra random number used to shift
 * every structure in the arena — so it is checked here rather than discovered
 * in a lobby.
 *
 * Canvas is stubbed out: nothing it draws reaches a collider, which is exactly
 * the invariant under test.
 */
import { Scene } from '../vendor/three.module.js';

const noop = () => {};
const ctx2d = () => ({
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
  fillRect: noop, strokeRect: noop, clearRect: noop, beginPath: noop, closePath: noop,
  moveTo: noop, lineTo: noop, arc: noop, fill: noop, stroke: noop, save: noop, restore: noop,
  translate: noop, rotate: noop, scale: noop, fillText: noop, strokeText: noop, setTransform: noop,
  quadraticCurveTo: noop, bezierCurveTo: noop, ellipse: noop, clip: noop, drawImage: noop,
  createRadialGradient: () => ({ addColorStop: noop }),
  createLinearGradient: () => ({ addColorStop: noop }),
  createPattern: () => null,
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  putImageData: noop,
  measureText: () => ({ width: 10 }),
});
globalThis.document = {
  createElement: (tag) => {
    if (tag !== 'canvas') return { style: {}, appendChild: noop, addEventListener: noop };
    return { width: 300, height: 150, style: {}, addEventListener: noop, getContext: ctx2d };
  },
  addEventListener: noop,
};
globalThis.window = { addEventListener: noop, devicePixelRatio: 1 };

const { Arena } = await import('../src/world/arena.js');
const { COOP } = await import('../src/core/config.js');

let failed = 0;
const check = (name, pass) => {
  console.log(`${pass ? '✓' : '✗'} ${name}`);
  if (!pass) failed++;
};
const build = (seed, stage) => new Arena(new Scene(), seed, stage);

for (const stage of [1, 2, 3]) {
  const seed = 0x1234abc + stage;
  const host = build(seed, stage);
  const client = build(seed, stage);
  check(`stage ${stage}: same seed, same colliders`,
    host.terrainHash() === client.terrainHash() && host.colliders.length === client.colliders.length);

  let agrees = true;
  for (let i = 0; i < 400 && agrees; i++) {
    const x = -70 + (i % 20) * 7;
    const z = -70 + Math.floor(i / 20) * 7;
    agrees = Math.abs(host.groundHeightAt(x, z) - client.groundHeightAt(x, z)) < 1e-9;
  }
  check(`stage ${stage}: ground height agrees across the arena`, agrees);
}

check('different seeds build different terrain',
  build(0x1234abd, 1).terrainHash() !== build(0x9999999, 1).terrainHash());
check('the pending placeholder is the same on every client',
  build(COOP.pendingSeed, 1).terrainHash() === build(COOP.pendingSeed, 1).terrainHash());

// The regression this split exists for: cosmetic work must not move terrain.
const before = build(0x777aa, 2).terrainHash();
const realAtmosphere = Arena.prototype._buildAtmosphere;
Arena.prototype._buildAtmosphere = function extraDecor() {
  for (let i = 0; i < 5000; i++) this.decorRng.next();
  return realAtmosphere.call(this);
};
const after = build(0x777aa, 2).terrainHash();
Arena.prototype._buildAtmosphere = realAtmosphere;
check('cosmetic draws do not move a single collider', before === after);

console.log(failed ? `\n${failed} check(s) failed.` : '\n✓ co-op terrain agrees.');
process.exit(failed ? 1 : 0);
