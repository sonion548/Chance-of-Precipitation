import * as THREE from 'three';

/**
 * Procedural material library.
 *
 * Everything is painted onto canvases at load time — no external assets — and
 * tiled with triplanar projection so a texture never stretches across a box that
 * has been scaled non-uniformly. Each generator paints albedo plus a matching
 * roughness map, because uniform roughness is what makes untextured geometry read
 * as plastic no matter how good the albedo is.
 */

const SIZE = 256;

function canvas(size = SIZE) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(c, { repeat = 1, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Deterministic value noise so a texture looks the same every run. */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speckled grain over the whole tile — the base layer under everything. */
function grain(g, size, amount, dark = true) {
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  const r = mulberry(1337);
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount * 255;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
}

/** Soft blotches, for weathering and staining. */
function blotches(g, size, count, colors, rnd, alpha = [0.04, 0.16], radius = [8, 46]) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const rad = radius[0] + rnd() * (radius[1] - radius[0]);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const c = colors[Math.floor(rnd() * colors.length)];
    const a = alpha[0] + rnd() * (alpha[1] - alpha[0]);
    grd.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a})`);
    grd.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
}

/** Hairline cracks that branch — reads as age rather than damage. */
function cracks(g, size, count, rnd, color = 'rgba(0,0,0,0.34)') {
  g.strokeStyle = color;
  g.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    let x = rnd() * size;
    let y = rnd() * size;
    let a = rnd() * Math.PI * 2;
    g.lineWidth = 0.6 + rnd() * 1.4;
    g.beginPath();
    g.moveTo(x, y);
    const segs = 5 + Math.floor(rnd() * 8);
    for (let s = 0; s < segs; s++) {
      a += (rnd() - 0.5) * 1.1;
      x += Math.cos(a) * (3 + rnd() * 9);
      y += Math.sin(a) * (3 + rnd() * 9);
      g.lineTo(x, y);
    }
    g.stroke();
  }
}

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const rgb = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const shade = (n, f) => {
  const c = new THREE.Color(n);
  c.multiplyScalar(f);
  return `#${c.getHexString()}`;
};

/* ==========================================================================
   GENERATORS — each returns { map, roughnessMap }
   ========================================================================== */

/** Coursed masonry: offset rows, recessed mortar, chipped corners. */
export function stoneBrick(base, mortar, seed = 7) {
  const c = canvas();
  const g = c.getContext('2d');
  const rnd = mulberry(seed);
  const rows = 8;
  const h = SIZE / rows;

  g.fillStyle = shade(mortar, 0.68);
  g.fillRect(0, 0, SIZE, SIZE);

  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * (SIZE / 12);
    const cols = 6;
    const w = SIZE / cols;
    for (let col = -1; col <= cols; col++) {
      const x = col * w + offset;
      const y = row * h;
      const inset = 1.6;
      const tone = 0.72 + rnd() * 0.56;
      g.fillStyle = shade(base, tone);
      g.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);
      // Bevel: light on top, shadow beneath, so bricks read as solid blocks.
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(x + inset, y + inset, w - inset * 2, 2);
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(x + inset, y + h - inset - 2.5, w - inset * 2, 2.5);
      // Occasional chipped corner.
      if (rnd() < 0.18) {
        g.fillStyle = shade(mortar, 1.1);
        const cs = 3 + rnd() * 6;
        g.beginPath();
        g.moveTo(x + inset, y + inset);
        g.lineTo(x + inset + cs, y + inset);
        g.lineTo(x + inset, y + inset + cs);
        g.closePath(); g.fill();
      }
    }
  }
  blotches(g, SIZE, 26, [rgb(mortar), [40, 44, 38], [96, 92, 78]], rnd, [0.03, 0.13], [10, 52]);
  cracks(g, SIZE, 7, rnd);
  grain(g, SIZE, 0.1);

  // Roughness: mortar is rough, brick faces are smoother where worn.
  // Mortar stays rough; brick faces are polished a little by weather.
  const rc = canvas();
  const rg = rc.getContext('2d');
  rg.fillStyle = '#d8d8d8'; rg.fillRect(0, 0, SIZE, SIZE);
  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * (SIZE / 12);
    for (let col = -1; col <= 6; col++) {
      const w = SIZE / 6;
      const v = 150 + Math.floor(rnd() * 50);
      const hexv = v.toString(16).padStart(2, '0');
      rg.fillStyle = `#${hexv}${hexv}${hexv}`;
      rg.fillRect(col * w + offset + 2, row * (SIZE / rows) + 2, w - 4, SIZE / rows - 4);
    }
  }
  return { map: toTexture(c), roughnessMap: toTexture(rc, { srgb: false }) };
}

/** Industrial panelling: seams, rivet rows, wear streaks, hazard corner. */
export function metalPanel(base, trim, seed = 11) {
  const c = canvas();
  const g = c.getContext('2d');
  const rnd = mulberry(seed);

  g.fillStyle = hex(base);
  g.fillRect(0, 0, SIZE, SIZE);

  // Panel grid at two scales so the tiling does not read as one repeating square.
  const drawPanel = (x, y, w, h) => {
    g.fillStyle = shade(base, 0.9 + rnd() * 0.25);
    g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 1.6;
    g.strokeRect(x + 0.8, y + 0.8, w - 1.6, h - 1.6);
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x + 2, y + 2); g.lineTo(x + w - 2, y + 2); g.stroke();
  };
  drawPanel(0, 0, SIZE / 2, SIZE / 2);
  drawPanel(SIZE / 2, 0, SIZE / 2, SIZE * 0.3);
  drawPanel(SIZE / 2, SIZE * 0.3, SIZE / 2, SIZE * 0.2);
  drawPanel(0, SIZE / 2, SIZE * 0.35, SIZE / 2);
  drawPanel(SIZE * 0.35, SIZE / 2, SIZE * 0.65, SIZE / 2);

  // Rivets along the seams.
  const rivet = (x, y) => {
    g.fillStyle = shade(trim, 1.15);
    g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.beginPath(); g.arc(x + 0.6, y + 0.8, 1.5, 0, Math.PI * 2); g.fill();
  };
  for (let i = 0; i < SIZE; i += 18) {
    rivet(i + 9, 7); rivet(i + 9, SIZE / 2 - 7); rivet(i + 9, SIZE / 2 + 7); rivet(i + 9, SIZE - 7);
  }
  for (let i = 0; i < SIZE; i += 18) { rivet(7, i + 9); rivet(SIZE - 7, i + 9); }

  // Vertical wear streaks under the seams.
  for (let i = 0; i < 22; i++) {
    const x = rnd() * SIZE;
    const len = 20 + rnd() * 70;
    const grd = g.createLinearGradient(x, SIZE / 2, x, SIZE / 2 + len);
    grd.addColorStop(0, 'rgba(30,24,18,0.28)');
    grd.addColorStop(1, 'rgba(30,24,18,0)');
    g.fillStyle = grd;
    g.fillRect(x, SIZE / 2, 1.5 + rnd() * 3, len);
  }
  blotches(g, SIZE, 18, [[120, 70, 30], [40, 44, 52]], rnd, [0.05, 0.18], [6, 30]);
  grain(g, SIZE, 0.09);

  const rc = canvas();
  const rg = rc.getContext('2d');
  rg.fillStyle = '#5a5a5a'; rg.fillRect(0, 0, SIZE, SIZE);
  blotches(rg, SIZE, 40, [[220, 220, 220], [30, 30, 30]], mulberry(seed + 3), [0.2, 0.6], [8, 40]);
  return { map: toTexture(c), roughnessMap: toTexture(rc, { srgb: false }) };
}

/** Poured concrete: form-board lines, pitting, water staining. */
export function concrete(base, seed = 23) {
  const c = canvas();
  const g = c.getContext('2d');
  const rnd = mulberry(seed);
  g.fillStyle = hex(base);
  g.fillRect(0, 0, SIZE, SIZE);

  for (let y = 0; y < SIZE; y += SIZE / 4) {
    g.fillStyle = 'rgba(0,0,0,0.13)';
    g.fillRect(0, y, SIZE, 2);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, y + 2, SIZE, 1);
  }
  for (let i = 0; i < 260; i++) {
    const x = rnd() * SIZE, y = rnd() * SIZE, r = 0.6 + rnd() * 2.2;
    g.fillStyle = `rgba(0,0,0,${0.06 + rnd() * 0.18})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  blotches(g, SIZE, 30, [[60, 64, 60], [130, 128, 118], [80, 74, 60]], rnd, [0.04, 0.15], [14, 60]);
  cracks(g, SIZE, 5, rnd, 'rgba(0,0,0,0.26)');
  grain(g, SIZE, 0.12);

  const rc = canvas();
  const rg = rc.getContext('2d');
  rg.fillStyle = '#c8c8c8'; rg.fillRect(0, 0, SIZE, SIZE);
  blotches(rg, SIZE, 30, [[160, 160, 160], [240, 240, 240]], mulberry(seed + 5), [0.15, 0.5], [10, 50]);
  return { map: toTexture(c), roughnessMap: toTexture(rc, { srgb: false }) };
}

/** Packed earth / rock face for natural cliff and boulder surfaces. */
export function rockFace(base, seed = 31) {
  const c = canvas();
  const g = c.getContext('2d');
  const rnd = mulberry(seed);
  g.fillStyle = hex(base);
  g.fillRect(0, 0, SIZE, SIZE);

  // Angular facets, drawn as filled polygons with light/shadow edges.
  for (let i = 0; i < 40; i++) {
    const cx = rnd() * SIZE, cy = rnd() * SIZE;
    const r = 12 + rnd() * 34;
    const sides = 4 + Math.floor(rnd() * 3);
    g.beginPath();
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2 + rnd() * 0.5;
      const rr = r * (0.6 + rnd() * 0.6);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      s ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
    g.fillStyle = shade(base, 0.82 + rnd() * 0.38);
    g.fill();
    g.strokeStyle = `rgba(0,0,0,${0.1 + rnd() * 0.15})`;
    g.lineWidth = 1;
    g.stroke();
  }
  blotches(g, SIZE, 34, [[50, 48, 40], [120, 116, 100]], rnd, [0.04, 0.16], [12, 54]);
  cracks(g, SIZE, 9, rnd, 'rgba(0,0,0,0.3)');
  grain(g, SIZE, 0.14);

  const rc = canvas();
  const rg = rc.getContext('2d');
  rg.fillStyle = '#e0e0e0'; rg.fillRect(0, 0, SIZE, SIZE);
  blotches(rg, SIZE, 26, [[170, 170, 170]], mulberry(seed + 9), [0.2, 0.5], [12, 48]);
  return { map: toTexture(c), roughnessMap: toTexture(rc, { srgb: false }) };
}

/** Etched arcane plating for void/crystal themes. */
export function runePlate(base, glow, seed = 41) {
  const c = canvas();
  const g = c.getContext('2d');
  const rnd = mulberry(seed);
  g.fillStyle = hex(base);
  g.fillRect(0, 0, SIZE, SIZE);

  for (let i = 0; i < 6; i++) {
    g.strokeStyle = `rgba(0,0,0,0.3)`;
    g.lineWidth = 2;
    g.strokeRect(12 + i * 6, 12 + i * 6, SIZE - 24 - i * 12, SIZE - 24 - i * 12);
  }
  g.strokeStyle = hex(glow);
  g.lineWidth = 2.4;
  g.globalAlpha = 0.75;
  for (let i = 0; i < 10; i++) {
    g.beginPath();
    let x = rnd() * SIZE, y = rnd() * SIZE;
    g.moveTo(x, y);
    for (let s = 0; s < 4; s++) {
      const horiz = rnd() < 0.5;
      x += horiz ? (rnd() - 0.5) * 70 : 0;
      y += horiz ? 0 : (rnd() - 0.5) * 70;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  blotches(g, SIZE, 18, [rgb(glow), [20, 12, 30]], rnd, [0.05, 0.2], [10, 50]);
  grain(g, SIZE, 0.1);

  const rc = canvas();
  const rg = rc.getContext('2d');
  rg.fillStyle = '#909090'; rg.fillRect(0, 0, SIZE, SIZE);
  return { map: toTexture(c), roughnessMap: toTexture(rc, { srgb: false }) };
}

/* ==========================================================================
   TRIPLANAR MATERIAL
   ========================================================================== */

/**
 * Projects a texture on the three world axes and blends by surface normal.
 *
 * The arena's structures are boxes scaled to wildly different dimensions through
 * an instance matrix, so ordinary UVs would smear the texture along whichever
 * axis got stretched. Triplanar costs three samples but needs no UV authoring and
 * never stretches — the correct trade for procedurally sized geometry.
 */
export function makeTriplanarMaterial({ map, roughnessMap, color = 0xffffff, scale = 0.22,
  roughness = 0.95, metalness = 0.04 } = {}) {
  // Deliberately NOT vertexColors. These materials are used on InstancedMesh with
  // a shared BoxGeometry that has no `color` attribute; turning vertexColors on
  // defines USE_COLOR, which multiplies by that missing attribute (zero) and
  // renders every structure black. Per-instance tint arrives via instanceColor,
  // which three.js handles through USE_INSTANCING_COLOR on its own.
  const mat = new THREE.MeshStandardMaterial({
    color, map, roughnessMap, roughness, metalness,
  });
  mat.userData.triScale = { value: scale };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = mat.userData.triScale;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTriPos;
        varying vec3 vTriNormal;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        #ifdef USE_INSTANCING
          vTriNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
        #else
          vTriNormal = normalize(mat3(modelMatrix) * objectNormal);
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vTriPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vTriPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTriPos;
        varying vec3 vTriNormal;
        uniform float uTriScale;
        vec4 triplanar(sampler2D tex, vec3 p, vec3 n) {
          vec3 w = abs(n);
          w = pow(w, vec3(4.0));
          w /= max(w.x + w.y + w.z, 0.0001);
          return texture2D(tex, p.zy * uTriScale) * w.x
               + texture2D(tex, p.xz * uTriScale) * w.y
               + texture2D(tex, p.xy * uTriScale) * w.z;
        }`)
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
          diffuseColor *= triplanar(map, vTriPos, normalize(vTriNormal));
        #endif`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          roughnessFactor *= triplanar(roughnessMap, vTriPos, normalize(vTriNormal)).g;
        #endif`);
  };
  mat.customProgramCacheKey = () => 'triplanar';
  return mat;
}

/** Per-theme material set, built once and cached. */
const themeCache = new Map();

const p_crystal = (theme) => theme.palette?.crystal?.[0] ?? theme.emissive;

export function themeMaterials(theme) {
  if (themeCache.has(theme.id)) return themeCache.get(theme.id);

  // Textures are painted as near-neutral *detail* maps with a mean close to white.
  // Hue comes from the per-instance tint. Painting them in the theme's own colours
  // instead would multiply a mid-tone map by a mid-tone tint and render everything
  // far darker than either — structures came out near-black doing exactly that.
  const brick = stoneBrick(0xd2d2d2, 0x9b9b9b, theme.id.length * 13 + 3);
  const panel = metalPanel(0xc9c9c9, 0xe8e8e8, theme.id.length * 7 + 11);
  const conc = concrete(0xcdcdcd, theme.id.length * 5 + 17);
  const rockT = rockFace(0xc6c6c6, theme.id.length * 3 + 29);
  const rune = runePlate(0xb8b8b8, p_crystal(theme), 41);

  const set = {
    brick: makeTriplanarMaterial({ ...brick, scale: 0.30 }),
    panel: makeTriplanarMaterial({ ...panel, scale: 0.22, roughness: 0.6, metalness: 0.45 }),
    concrete: makeTriplanarMaterial({ ...conc, scale: 0.18 }),
    rock: makeTriplanarMaterial({ ...rockT, scale: 0.16 }),
    rune: makeTriplanarMaterial({ ...rune, scale: 0.17, roughness: 0.55, metalness: 0.35 }),
    raw: { brick, panel, conc, rockT, rune },
  };
  for (const key of ['brick', 'panel', 'concrete', 'rock', 'rune']) set[key].userData.shared = true;
  themeCache.set(theme.id, set);
  return set;
}

export function disposeThemeMaterials() {
  for (const set of themeCache.values()) {
    for (const key of ['brick', 'panel', 'concrete', 'rock', 'rune']) {
      set[key].map?.dispose();
      set[key].roughnessMap?.dispose();
      set[key].dispose();
    }
  }
  themeCache.clear();
}
