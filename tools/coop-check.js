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
 * the invariant under test. Run it through `npm run check:coop`, which supplies
 * the resolve hook that makes `three` mean the vendored build outside a browser.
 */
import { Scene } from 'three';

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
const build = (seed, stage, opts) => new Arena(new Scene(), seed, stage, opts);

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

/* The asymmetry that actually happens in a run, and the one the checks above
 * cannot see: a host *picks* its theme and a client is *told* one, so the two
 * take different branches through the constructor. Building both the same way
 * — as every check above does — exercises neither the divergence nor the fix.
 *
 * This is the regression for the bug where a joiner saw chests hanging in the
 * air and enemies buried: theme selection drew from the arena's own RNG, the
 * client short-circuited past it because it had been handed a theme id, and
 * from there the two drew their terrain phase offsets from different positions
 * in the same sequence. Same seed, different hills.
 */
for (const stage of [1, 2, 3, 4]) {
  const seed = 0x51a6e00 + stage;
  const host = build(seed, stage);                                  // picks
  const client = build(seed, stage, { themeId: host.theme.id });    // is told
  check(`stage ${stage}: a told client agrees with a picking host`,
    host.terrainHash() === client.terrainHash());

  let agrees = true;
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const x = -70 + (i % 20) * 7;
    const z = -70 + Math.floor(i / 20) * 7;
    const d = Math.abs(host.groundHeightAt(x, z) - client.groundHeightAt(x, z));
    if (d > worst) worst = d;
    if (d >= 1e-9) agrees = false;
  }
  check(`stage ${stage}: told-client ground matches host (worst ${worst.toFixed(4)}m)`, agrees);
}

// And the same asymmetry with a previous theme to avoid, which is what the
// game actually passes when you descend.
{
  const host = build(0x7c0ffee, 3, { avoidTheme: 'verdant' });
  const client = build(0x7c0ffee, 3, { themeId: host.theme.id, avoidTheme: 'verdant' });
  check('avoidTheme does not desync a told client',
    host.terrainHash() === client.terrainHash());
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

/* ---------------------------------------------------------------- themes --
 * The structure the descent is supposed to have, asserted rather than assumed.
 * Every one of these was false before the tier rework: stage 3 drew from five
 * themes, the opening forest and swamp were still eligible at stage 5, and the
 * two themes in a band shared guardians.
 */
const { THEMES, THEME_TIERS, themesForStage, bossesForTheme } = await import('../src/world/themes.js');
const { BOSSES } = await import('../src/data/enemies.js');

const bossIds = new Set(BOSSES.map((b) => b.id));

check('every theme is either in a tier or loop-only',
  THEMES.every((t) => (t.tier > 0) !== !!t.loopOnly));

for (let tier = 1; tier <= THEME_TIERS; tier++) {
  const inTier = THEMES.filter((t) => t.tier === tier);
  check(`tier ${tier}: exactly two places`, inTier.length === 2);
  const names = inTier.flatMap((t) => t.bosses || []);
  check(`tier ${tier}: two guardians each, none shared`,
    inTier.every((t) => (t.bosses || []).length === 2)
    && new Set(names).size === names.length);
  check(`tier ${tier}: every guardian is a real boss`, names.every((b) => bossIds.has(b)));
}

for (let stage = 1; stage <= 12; stage++) {
  check(`stage ${stage}: exactly two places to land`, themesForStage(stage, false).length === 2);
}
check('stage 1 is the forest or the swamp',
  themesForStage(1, false).map((t) => t.id).sort().join() === 'hollow,mire');
check('the opening pair does not come back until the descent loops',
  [2, 3, 4].every((s) => !themesForStage(s, false).some((t) => t.id === 'hollow' || t.id === 'mire')));
check('the loop-only place is unreachable before looping',
  ![1, 2, 3, 4, 5, 6].some((s) => themesForStage(s, false).some((t) => t.loopOnly))
  && themesForStage(1, true).some((t) => t.loopOnly));
check('looping puts the whole roster on the table',
  bossesForTheme(THEMES[0], true) === null && bossesForTheme(THEMES[0], false).length === 2);

console.log(failed ? `\n${failed} check(s) failed.` : '\n✓ co-op terrain agrees.');
process.exit(failed ? 1 : 0);
