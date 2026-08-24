/**
 * Procedural item artwork.
 *
 * Every item draws its own icon from primitives on a canvas, so all 44 read as
 * distinct silhouettes rather than sharing five category shapes. The same art is
 * used in three places — the world drop, the HUD inventory strip, and the
 * Sanctum/Codex cards — so an item looks the same wherever you meet it.
 *
 * Icons are authored in a normalised 0..1 space and scaled to whatever size the
 * caller asks for, which keeps them crisp for both a 36px HUD slot and a 256px
 * world texture.
 */

const TAU = Math.PI * 2;

/** Drawing helpers, all in normalised coordinates. */
function makeBrush(ctx, size) {
  const S = (v) => v * size;
  const g = {
    ctx,
    size,
    fill(c) { ctx.fillStyle = c; return g; },
    stroke(c, w = 0.04) { ctx.strokeStyle = c; ctx.lineWidth = S(w); return g; },

    disc(cx, cy, r, c) {
      ctx.beginPath(); ctx.arc(S(cx), S(cy), S(r), 0, TAU);
      ctx.fillStyle = c; ctx.fill(); return g;
    },
    ring(cx, cy, r, w, c) {
      ctx.beginPath(); ctx.arc(S(cx), S(cy), S(r), 0, TAU);
      ctx.strokeStyle = c; ctx.lineWidth = S(w); ctx.stroke(); return g;
    },
    arc(cx, cy, r, a0, a1, w, c) {
      ctx.beginPath(); ctx.arc(S(cx), S(cy), S(r), a0, a1);
      ctx.strokeStyle = c; ctx.lineWidth = S(w); ctx.lineCap = 'round'; ctx.stroke(); return g;
    },
    poly(cx, cy, r, sides, rot, c) {
      ctx.beginPath();
      for (let i = 0; i < sides; i++) {
        const a = rot + (i / sides) * TAU;
        const x = S(cx + Math.cos(a) * r);
        const y = S(cy + Math.sin(a) * r);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.fillStyle = c; ctx.fill(); return g;
    },
    star(cx, cy, rOut, rIn, points, rot, c) {
      ctx.beginPath();
      for (let i = 0; i < points * 2; i++) {
        const r = i % 2 ? rIn : rOut;
        const a = rot + (i / (points * 2)) * TAU;
        const x = S(cx + Math.cos(a) * r);
        const y = S(cy + Math.sin(a) * r);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.fillStyle = c; ctx.fill(); return g;
    },
    /** Tapered blade pointing along `rot`. */
    blade(cx, cy, len, w, rot, c) {
      ctx.save();
      ctx.translate(S(cx), S(cy)); ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(0, S(-len * 0.5));
      ctx.lineTo(S(w * 0.5), S(len * 0.12));
      ctx.lineTo(S(w * 0.28), S(len * 0.5));
      ctx.lineTo(S(-w * 0.28), S(len * 0.5));
      ctx.lineTo(S(-w * 0.5), S(len * 0.12));
      ctx.closePath(); ctx.fillStyle = c; ctx.fill();
      ctx.restore(); return g;
    },
    bar(cx, cy, w, h, rot, c, round = 0.2) {
      ctx.save();
      ctx.translate(S(cx), S(cy)); ctx.rotate(rot);
      const rw = S(w), rh = S(h), r = Math.min(rw, rh) * round;
      ctx.beginPath();
      ctx.roundRect(-rw / 2, -rh / 2, rw, rh, r);
      ctx.fillStyle = c; ctx.fill();
      ctx.restore(); return g;
    },
    tri(cx, cy, w, h, rot, c) {
      ctx.save();
      ctx.translate(S(cx), S(cy)); ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(0, S(-h / 2)); ctx.lineTo(S(w / 2), S(h / 2)); ctx.lineTo(S(-w / 2), S(h / 2));
      ctx.closePath(); ctx.fillStyle = c; ctx.fill();
      ctx.restore(); return g;
    },
    chevron(cx, cy, w, h, rot, c, thick = 0.09) {
      ctx.save();
      ctx.translate(S(cx), S(cy)); ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(S(-w / 2), S(h / 2)); ctx.lineTo(0, S(-h / 2)); ctx.lineTo(S(w / 2), S(h / 2));
      ctx.strokeStyle = c; ctx.lineWidth = S(thick); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
      ctx.restore(); return g;
    },
    bolt(cx, cy, scale, c) {
      ctx.save();
      ctx.translate(S(cx), S(cy)); ctx.scale(S(scale), S(scale));
      ctx.beginPath();
      ctx.moveTo(0.08, -0.5); ctx.lineTo(-0.26, 0.06); ctx.lineTo(-0.02, 0.06);
      ctx.lineTo(-0.1, 0.5); ctx.lineTo(0.26, -0.08); ctx.lineTo(0.02, -0.08);
      ctx.closePath(); ctx.fillStyle = c; ctx.fill();
      ctx.restore(); return g;
    },
    drop(cx, cy, r, c) {
      ctx.beginPath();
      ctx.moveTo(S(cx), S(cy - r * 1.5));
      ctx.bezierCurveTo(S(cx + r), S(cy - r * 0.3), S(cx + r), S(cy + r * 0.8), S(cx), S(cy + r));
      ctx.bezierCurveTo(S(cx - r), S(cy + r * 0.8), S(cx - r), S(cy - r * 0.3), S(cx), S(cy - r * 1.5));
      ctx.closePath(); ctx.fillStyle = c; ctx.fill(); return g;
    },
    flask(cx, cy, r, body, neck) {
      ctx.beginPath();
      ctx.arc(S(cx), S(cy + r * 0.25), S(r), Math.PI * 0.86, Math.PI * 0.14);
      ctx.lineTo(S(cx + r * 0.34), S(cy - r * 0.85));
      ctx.lineTo(S(cx - r * 0.34), S(cy - r * 0.85));
      ctx.closePath(); ctx.fillStyle = body; ctx.fill();
      g.bar(cx, cy - r * 1.05, r * 0.62, r * 0.34, 0, neck, 0.3);
      return g;
    },
    shield(cx, cy, w, h, c) {
      ctx.beginPath();
      ctx.moveTo(S(cx - w / 2), S(cy - h / 2));
      ctx.lineTo(S(cx + w / 2), S(cy - h / 2));
      ctx.lineTo(S(cx + w / 2), S(cy + h * 0.1));
      ctx.quadraticCurveTo(S(cx + w / 2), S(cy + h / 2), S(cx), S(cy + h / 2));
      ctx.quadraticCurveTo(S(cx - w / 2), S(cy + h / 2), S(cx - w / 2), S(cy + h * 0.1));
      ctx.closePath(); ctx.fillStyle = c; ctx.fill(); return g;
    },
    gear(cx, cy, r, teeth, c) {
      ctx.beginPath();
      for (let i = 0; i < teeth * 2; i++) {
        const rr = i % 2 ? r * 0.76 : r;
        const a = (i / (teeth * 2)) * TAU;
        const x = S(cx + Math.cos(a) * rr);
        const y = S(cy + Math.sin(a) * rr);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.fillStyle = c; ctx.fill(); return g;
    },
    crystal(cx, cy, w, h, c) {
      ctx.beginPath();
      ctx.moveTo(S(cx), S(cy - h / 2));
      ctx.lineTo(S(cx + w / 2), S(cy - h * 0.12));
      ctx.lineTo(S(cx + w * 0.3), S(cy + h / 2));
      ctx.lineTo(S(cx - w * 0.3), S(cy + h / 2));
      ctx.lineTo(S(cx - w / 2), S(cy - h * 0.12));
      ctx.closePath(); ctx.fillStyle = c; ctx.fill(); return g;
    },
    feather(cx, cy, len, rot, c) {
      ctx.save();
      ctx.translate(S(cx), S(cy)); ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(0, S(-len / 2));
      ctx.quadraticCurveTo(S(len * 0.34), 0, 0, S(len / 2));
      ctx.quadraticCurveTo(S(-len * 0.34), 0, 0, S(-len / 2));
      ctx.closePath(); ctx.fillStyle = c; ctx.fill();
      ctx.restore(); return g;
    },
    spikes(cx, cy, rIn, rOut, n, c, rot = 0) {
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * TAU;
        g.tri(cx + Math.cos(a) * (rIn + rOut) * 0.5, cy + Math.sin(a) * (rIn + rOut) * 0.5,
          (rOut - rIn) * 0.9, rOut - rIn, a + Math.PI / 2, c);
      }
      return g;
    },
    dots(cx, cy, r, n, dotR, c, rot = 0) {
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * TAU;
        g.disc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, dotR, c);
      }
      return g;
    },
    plus(cx, cy, r, w, c) {
      g.bar(cx, cy, r * 2, w, 0, c, 0.25);
      g.bar(cx, cy, w, r * 2, 0, c, 0.25);
      return g;
    },
    /** Soft radial backing that lifts the icon off dark and light backdrops alike. */
    glow(cx, cy, r, c) {
      const grd = ctx.createRadialGradient(S(cx), S(cy), 0, S(cx), S(cy), S(r));
      grd.addColorStop(0, c);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(S(cx), S(cy), S(r), 0, TAU); ctx.fill();
      return g;
    },
  };
  return g;
}

/* ==========================================================================
   RECIPES — one per item
   ========================================================================== */
const C = {
  steel: '#c7d0e0', dark: '#2a3040', gold: '#ffcf5c', amber: '#ff9a3d',
  blood: '#ff4d5e', leaf: '#6fdc7f', teal: '#46e0c0', ice: '#8fd8ff',
  volt: '#ffe04b', violet: '#b473ff', rose: '#ff6ad0', bone: '#efe6d2',
  ember: '#ff6a2a', deep: '#4aa8ff', shadow: '#1a1e28',
};

export const ICON_RECIPES = {
  /* ---- common ---- */
  stim_injector: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(110,220,255,0.18)');
    g.bar(0.5, 0.52, 0.18, 0.52, Math.PI / 4, C.steel, 0.25);
    g.bar(0.5, 0.52, 0.3, 0.16, Math.PI / 4, '#8fa0bb', 0.3);
    g.blade(0.71, 0.31, 0.24, 0.07, Math.PI / 4, C.ice);
    g.disc(0.34, 0.68, 0.07, C.deep);
  },
  glass_shard: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(74,168,255,0.2)');
    g.crystal(0.5, 0.5, 0.46, 0.72, C.deep);
    g.crystal(0.5, 0.48, 0.2, 0.4, '#bfe4ff');
  },
  tungsten_plate: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(199,208,224,0.16)');
    g.shield(0.5, 0.5, 0.62, 0.72, '#7d8798');
    g.shield(0.5, 0.5, 0.42, 0.5, C.steel);
    g.bar(0.5, 0.5, 0.34, 0.08, 0, '#5b6474', 0.3);
  },
  sprint_servos: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(111,220,127,0.18)');
    g.chevron(0.5, 0.34, 0.5, 0.2, 0, C.leaf, 0.1);
    g.chevron(0.5, 0.53, 0.5, 0.2, 0, C.leaf, 0.1);
    g.chevron(0.5, 0.72, 0.5, 0.2, 0, '#3f9b52', 0.1);
  },
  bitterroot: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(111,220,127,0.18)');
    g.drop(0.5, 0.46, 0.26, '#a8543a');
    for (let i = 0; i < 3; i++) g.feather(0.5 + (i - 1) * 0.16, 0.72, 0.34, (i - 1) * 0.5, C.leaf);
  },
  field_dressing: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,255,255,0.14)');
    g.bar(0.5, 0.5, 0.72, 0.34, -0.4, C.bone, 0.3);
    g.plus(0.5, 0.5, 0.13, 0.09, C.blood);
  },
  spore_bloom: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(111,220,127,0.18)');
    g.bar(0.5, 0.66, 0.14, 0.34, 0, C.bone, 0.3);
    g.arc(0.5, 0.52, 0.28, Math.PI, TAU, 0.26, '#d05a6a');
    g.dots(0.5, 0.46, 0.16, 3, 0.05, C.bone, -0.6);
  },
  prospectors_lens: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,207,92,0.2)');
    g.ring(0.44, 0.44, 0.24, 0.09, C.gold);
    g.disc(0.44, 0.44, 0.19, 'rgba(180,220,255,0.5)');
    g.bar(0.68, 0.68, 0.1, 0.28, Math.PI / 4, '#8a7a5a', 0.4);
  },
  capacitor_cell: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,224,75,0.2)');
    g.bar(0.5, 0.54, 0.42, 0.6, 0, '#3c4658', 0.18);
    g.bar(0.5, 0.2, 0.16, 0.1, 0, C.steel, 0.3);
    g.bolt(0.5, 0.54, 0.62, C.volt);
  },
  hollowpoint: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,154,61,0.18)');
    for (const dx of [-0.17, 0.17]) {
      g.bar(0.5 + dx, 0.6, 0.2, 0.36, 0, '#b08040', 0.25);
      g.tri(0.5 + dx, 0.34, 0.2, 0.22, 0, C.amber);
    }
    g.bar(0.5, 0.8, 0.62, 0.08, 0, '#5b6474', 0.4);
  },
  scholars_tab: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(74,168,255,0.18)');
    g.bar(0.5, 0.5, 0.56, 0.64, 0, '#33507a', 0.1);
    g.bar(0.5, 0.5, 0.06, 0.64, 0, '#22385a', 0.1);
    g.bar(0.36, 0.42, 0.16, 0.05, 0, '#cfe0ff', 0.4);
    g.bar(0.64, 0.42, 0.16, 0.05, 0, '#cfe0ff', 0.4);
  },

  /* ---- uncommon ---- */
  infusion_core: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(95,224,122,0.22)');
    g.poly(0.5, 0.5, 0.34, 6, Math.PI / 6, '#2f6b3f');
    g.poly(0.5, 0.5, 0.22, 6, Math.PI / 6, C.leaf);
    g.dots(0.5, 0.5, 0.3, 6, 0.045, '#d8ffe0', Math.PI / 6);
  },
  resonant_chime: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(143,216,255,0.22)');
    g.arc(0.5, 0.46, 0.3, Math.PI, TAU, 0.1, C.ice);
    g.bar(0.5, 0.28, 0.06, 0.2, 0, C.steel, 0.4);
    g.disc(0.5, 0.62, 0.09, C.deep);
    g.bolt(0.5, 0.5, 0.44, '#eaffff');
  },
  grav_boots: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(143,216,255,0.2)');
    g.feather(0.38, 0.44, 0.56, -0.35, C.steel);
    g.feather(0.62, 0.44, 0.56, 0.35, '#9fb0c8');
    g.chevron(0.5, 0.78, 0.4, 0.16, Math.PI, C.ice, 0.09);
  },
  predatory_instinct: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,77,94,0.2)');
    for (let i = 0; i < 3; i++) g.blade(0.3 + i * 0.2, 0.5, 0.56, 0.13, 0.22, C.blood);
    g.disc(0.5, 0.8, 0.07, '#7a2530');
  },
  battle_horn: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,207,92,0.2)');
    g.arc(0.42, 0.56, 0.3, -1.1, 1.5, 0.16, C.gold);
    g.disc(0.72, 0.34, 0.13, '#c79a34');
    g.arc(0.5, 0.5, 0.42, -0.6, 0.2, 0.05, 'rgba(255,231,160,0.7)');
  },
  reaper_lens: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(180,115,255,0.2)');
    g.ctx.save();
    g.ctx.beginPath();
    g.ctx.ellipse(0.5 * g.size, 0.5 * g.size, 0.36 * g.size, 0.22 * g.size, 0, 0, TAU);
    g.ctx.fillStyle = C.bone; g.ctx.fill();
    g.ctx.restore();
    g.disc(0.5, 0.5, 0.15, C.violet);
    g.disc(0.5, 0.5, 0.07, C.shadow);
  },
  fuel_cell: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,154,61,0.2)');
    g.bar(0.5, 0.52, 0.34, 0.6, 0, '#3c4658', 0.3);
    g.bar(0.5, 0.42, 0.26, 0.26, 0, C.amber, 0.3);
    g.disc(0.5, 0.2, 0.09, C.steel);
    g.bar(0.5, 0.74, 0.4, 0.07, 0, '#5b6474', 0.4);
  },
  ignition_core: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,106,42,0.24)');
    g.star(0.5, 0.5, 0.42, 0.17, 8, -0.2, C.ember);
    g.disc(0.5, 0.5, 0.16, C.volt);
  },
  phase_cloak: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(184,200,255,0.2)');
    g.arc(0.5, 0.56, 0.32, Math.PI * 1.05, TAU * 0.98, 0.13, '#8fa0d0');
    g.arc(0.5, 0.56, 0.2, Math.PI * 1.1, TAU * 0.95, 0.1, '#cfd8ff');
    g.dots(0.5, 0.34, 0.22, 3, 0.04, '#eaf0ff', 0.4);
  },
  seeker_missile: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,154,61,0.2)');
    g.bar(0.5, 0.52, 0.2, 0.5, 0, C.steel, 0.4);
    g.tri(0.5, 0.22, 0.22, 0.22, 0, C.blood);
    g.tri(0.36, 0.72, 0.16, 0.2, 0, '#7d8798');
    g.tri(0.64, 0.72, 0.16, 0.2, 0, '#7d8798');
    g.disc(0.5, 0.84, 0.08, C.amber);
  },

  /* ---- rare ---- */
  brilliant_behemoth: (g) => {
    g.glow(0.5, 0.5, 0.48, 'rgba(255,166,75,0.26)');
    g.star(0.5, 0.5, 0.46, 0.2, 10, 0.1, C.amber);
    g.star(0.5, 0.5, 0.28, 0.12, 10, -0.2, C.volt);
    g.disc(0.5, 0.5, 0.11, '#fff4d0');
  },
  spirit_dagger: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(239,230,210,0.2)');
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i - 1) * 0.7;
      g.blade(0.5 + Math.cos(a) * 0.2, 0.56 + Math.sin(a) * 0.2, 0.5, 0.14, a + Math.PI / 2, C.bone);
    }
    g.disc(0.5, 0.72, 0.09, C.deep);
  },
  chrono_shard: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(74,168,255,0.22)');
    g.crystal(0.5, 0.5, 0.42, 0.7, '#2e6ba8');
    g.ring(0.5, 0.5, 0.2, 0.05, '#cfe8ff');
    g.bar(0.5, 0.44, 0.03, 0.16, 0, '#cfe8ff', 0.5);
    g.bar(0.55, 0.5, 0.14, 0.03, 0, '#cfe8ff', 0.5);
  },
  carrion_mantle: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(180,115,255,0.2)');
    g.feather(0.32, 0.5, 0.62, -0.5, '#4a3a6a');
    g.feather(0.68, 0.5, 0.62, 0.5, '#4a3a6a');
    g.feather(0.5, 0.46, 0.66, 0, C.violet);
    g.disc(0.5, 0.24, 0.08, C.rose);
  },
  vampiric_edge: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,77,94,0.24)');
    g.blade(0.5, 0.46, 0.72, 0.24, 0, '#d0d8e8');
    g.bar(0.5, 0.74, 0.34, 0.08, 0, '#5b3038', 0.4);
    g.drop(0.5, 0.34, 0.1, C.blood);
  },
  fortune_clover: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(111,220,127,0.24)');
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      g.disc(0.5 + Math.cos(a) * 0.19, 0.46 + Math.sin(a) * 0.19, 0.16, C.leaf);
    }
    g.disc(0.5, 0.46, 0.08, '#2f6b3f');
    g.bar(0.5, 0.76, 0.05, 0.24, 0, '#2f6b3f', 0.5);
  },
  razorwire: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,77,94,0.2)');
    g.ring(0.5, 0.5, 0.3, 0.07, '#8a94a8');
    g.spikes(0.5, 0.5, 0.3, 0.46, 8, C.blood);
    g.ring(0.5, 0.5, 0.15, 0.05, '#5b6474');
  },
  soul_catalyst: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(74,168,255,0.24)');
    g.poly(0.5, 0.5, 0.4, 4, Math.PI / 4, '#2a4c7a');
    g.poly(0.5, 0.5, 0.24, 4, Math.PI / 4, C.deep);
    g.disc(0.5, 0.5, 0.09, '#eaf6ff');
  },
  tesla_coil: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,224,75,0.24)');
    g.bar(0.5, 0.72, 0.32, 0.14, 0, '#5b6474', 0.3);
    g.bar(0.5, 0.56, 0.1, 0.3, 0, '#8a94a8', 0.3);
    g.disc(0.5, 0.34, 0.16, C.ice);
    g.bolt(0.34, 0.44, 0.34, C.volt);
    g.bolt(0.66, 0.44, 0.34, C.volt);
  },

  /* ---- epic ---- */
  sunder_rounds: (g) => {
    g.glow(0.5, 0.5, 0.48, 'rgba(180,115,255,0.24)');
    g.bar(0.5, 0.66, 0.12, 0.44, 0, '#6a5a48', 0.4);
    g.bar(0.5, 0.34, 0.56, 0.26, 0, '#8a94a8', 0.15);
    g.bar(0.5, 0.34, 0.2, 0.3, 0, '#5b6474', 0.2);
    g.bolt(0.72, 0.62, 0.3, C.violet);
  },
  frost_relic: (g) => {
    g.glow(0.5, 0.5, 0.48, 'rgba(143,216,255,0.26)');
    for (let i = 0; i < 3; i++) g.bar(0.5, 0.5, 0.06, 0.8, (i / 3) * Math.PI, C.ice, 0.4);
    g.dots(0.5, 0.5, 0.3, 6, 0.055, '#eaffff');
    g.disc(0.5, 0.5, 0.12, '#ffffff');
  },
  vital_rack: (g) => {
    g.glow(0.5, 0.5, 0.48, 'rgba(75,224,138,0.26)');
    g.bar(0.5, 0.5, 0.66, 0.56, 0, '#2b4a3a', 0.14);
    for (const dx of [-0.16, 0.16]) g.flask(0.5 + dx, 0.5, 0.14, C.leaf, C.steel);
    g.bar(0.5, 0.78, 0.66, 0.08, 0, '#5b6474', 0.4);
  },
  ember_band: (g) => {
    g.glow(0.5, 0.5, 0.48, 'rgba(255,106,42,0.3)');
    g.ring(0.5, 0.5, 0.34, 0.13, '#a04a1a');
    g.arc(0.5, 0.5, 0.34, -0.9, 0.9, 0.13, C.ember);
    g.disc(0.5, 0.16, 0.11, C.volt);
  },
  cryo_band: (g) => {
    g.glow(0.5, 0.5, 0.48, 'rgba(111,208,255,0.3)');
    g.ring(0.5, 0.5, 0.34, 0.13, '#2a6a9a');
    g.arc(0.5, 0.5, 0.34, -0.9, 0.9, 0.13, C.ice);
    g.crystal(0.5, 0.16, 0.18, 0.24, '#eaffff');
  },
  neural_spike: (g) => {
    g.glow(0.5, 0.5, 0.48, 'rgba(180,115,255,0.26)');
    g.arc(0.42, 0.46, 0.26, Math.PI * 0.7, Math.PI * 1.9, 0.13, C.rose);
    g.arc(0.58, 0.46, 0.26, Math.PI * 1.2, Math.PI * 2.4, 0.13, C.violet);
    g.bar(0.5, 0.78, 0.09, 0.26, 0, '#8a94a8', 0.4);
    g.dots(0.5, 0.46, 0.34, 4, 0.045, '#f0e0ff', 0.5);
  },
  aegis: (g) => {
    g.glow(0.5, 0.5, 0.48, 'rgba(255,215,110,0.28)');
    g.shield(0.5, 0.5, 0.66, 0.76, '#7a6a34');
    g.shield(0.5, 0.5, 0.46, 0.54, C.gold);
    g.star(0.5, 0.48, 0.16, 0.07, 6, 0, '#fff4d0');
  },
  laser_scope: (g) => {
    g.glow(0.5, 0.5, 0.48, 'rgba(255,77,94,0.26)');
    g.ring(0.5, 0.5, 0.36, 0.07, '#8a94a8');
    g.bar(0.5, 0.5, 0.72, 0.035, 0, C.blood, 0.5);
    g.bar(0.5, 0.5, 0.035, 0.72, 0, C.blood, 0.5);
    g.disc(0.5, 0.5, 0.08, C.blood);
  },

  /* ---- legendary ---- */
  phoenix_charm: (g) => {
    g.glow(0.5, 0.5, 0.5, 'rgba(255,138,61,0.34)');
    g.feather(0.3, 0.48, 0.62, -0.7, C.ember);
    g.feather(0.7, 0.48, 0.62, 0.7, C.ember);
    g.feather(0.5, 0.42, 0.7, 0, C.volt);
    g.disc(0.5, 0.72, 0.12, '#fff0c0');
  },
  prismatic_glass: (g) => {
    g.glow(0.5, 0.5, 0.5, 'rgba(255,138,61,0.3)');
    g.crystal(0.5, 0.5, 0.56, 0.82, '#dfe8ff');
    g.crystal(0.5, 0.5, 0.3, 0.5, C.rose);
    g.bar(0.5, 0.5, 0.56, 0.04, 0.5, 'rgba(255,255,255,0.8)', 0.5);
  },
  singularity_core: (g) => {
    g.glow(0.5, 0.5, 0.5, 'rgba(180,115,255,0.34)');
    g.ring(0.5, 0.5, 0.42, 0.06, C.violet);
    g.ring(0.5, 0.5, 0.3, 0.05, C.rose);
    g.disc(0.5, 0.5, 0.19, '#0a0812');
    g.arc(0.5, 0.5, 0.36, 0.3, 2.4, 0.05, '#ffffff');
  },
  genesis_loop: (g) => {
    g.glow(0.5, 0.5, 0.5, 'rgba(180,115,255,0.32)');
    for (let i = 0; i < 3; i++) g.arc(0.5, 0.5, 0.22 + i * 0.1, i * 2, i * 2 + 4.2, 0.06, i % 2 ? C.rose : C.violet);
    g.disc(0.5, 0.5, 0.1, '#fff0ff');
  },
  eclipse_crown: (g) => {
    g.glow(0.5, 0.5, 0.5, 'rgba(255,207,92,0.34)');
    g.disc(0.5, 0.44, 0.28, '#1a1420');
    g.ring(0.5, 0.44, 0.3, 0.05, C.gold);
    for (let i = 0; i < 5; i++) g.tri(0.5 + (i - 2) * 0.16, 0.68, 0.13, 0.2, 0, C.gold);
    g.bar(0.5, 0.8, 0.72, 0.09, 0, '#c79a34', 0.4);
  },
  resonance_disc: (g) => {
    g.glow(0.5, 0.5, 0.5, 'rgba(255,138,61,0.32)');
    g.disc(0.5, 0.5, 0.44, '#3a2418');
    for (let i = 0; i < 4; i++) g.ring(0.5, 0.5, 0.12 + i * 0.09, 0.035, i % 2 ? C.amber : C.ember);
    g.disc(0.5, 0.5, 0.08, '#fff0c0');
  },
  /* ---- brood & second-wave additions ---- */
  hatchling_charm: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,138,61,0.2)');
    g.disc(0.5, 0.54, 0.28, '#e6dfc8');
    g.disc(0.5, 0.42, 0.22, '#f2ecd8');
    g.arc(0.5, 0.52, 0.2, Math.PI * 0.15, Math.PI * 0.85, 0.05, C.amber);
    g.tri(0.42, 0.36, 0.1, 0.12, 0, C.ember);
    g.tri(0.58, 0.36, 0.1, 0.12, 0, C.ember);
    g.disc(0.5, 0.56, 0.05, C.ember);
  },
  whetstone: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(199,208,224,0.18)');
    g.bar(0.46, 0.6, 0.62, 0.24, -0.22, '#6b6f7a', 0.18);
    g.blade(0.56, 0.38, 0.6, 0.2, 0.5, C.steel);
    g.arc(0.62, 0.3, 0.16, -0.6, 0.9, 0.035, '#ffffff');
  },
  ration_tin: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(111,220,127,0.16)');
    g.bar(0.5, 0.56, 0.5, 0.5, 0, '#9aa4b4', 0.12);
    g.bar(0.5, 0.3, 0.56, 0.1, 0, C.steel, 0.4);
    g.bar(0.5, 0.58, 0.4, 0.22, 0, '#3f6b45', 0.1);
    g.plus(0.5, 0.58, 0.09, 0.06, C.leaf);
    g.disc(0.72, 0.28, 0.05, '#d8dee8');
  },
  ballast_rig: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(143,216,255,0.16)');
    g.bar(0.5, 0.5, 0.09, 0.66, 0, C.steel, 0.4);
    g.arc(0.5, 0.62, 0.28, Math.PI * 0.08, Math.PI * 0.92, 0.09, C.steel);
    g.bar(0.5, 0.24, 0.26, 0.09, 0, '#8a94a6', 0.4);
    g.ring(0.5, 0.22, 0.09, 0.05, '#8a94a6');
    g.tri(0.24, 0.66, 0.14, 0.14, 0.6, C.deep);
    g.tri(0.76, 0.66, 0.14, 0.14, -0.6, C.deep);
  },
  brood_totem: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,138,61,0.2)');
    g.bar(0.5, 0.56, 0.44, 0.72, 0, '#6a6152', 0.1);
    g.tri(0.5, 0.2, 0.5, 0.2, 0, '#4e4739');
    for (let i = 0; i < 3; i++) {
      g.bar(0.5, 0.36 + i * 0.2, 0.5, 0.05, 0, '#3a352b', 0.4);
      g.disc(0.38, 0.45 + i * 0.2, 0.045, C.amber);
      g.disc(0.62, 0.45 + i * 0.2, 0.045, C.amber);
    }
    g.tri(0.5, 0.9, 0.2, 0.1, Math.PI, C.ember);
  },
  kinetic_dampener: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(143,216,255,0.2)');
    g.arc(0.5, 0.62, 0.36, Math.PI, TAU, 0.12, C.ice);
    g.arc(0.5, 0.62, 0.24, Math.PI, TAU, 0.08, '#5f8fb8');
    for (const dx of [-0.22, 0, 0.22]) g.bar(0.5 + dx, 0.72, 0.03, 0.28, dx * 0.9, C.steel, 0.5);
    g.bar(0.5, 0.86, 0.2, 0.1, 0, '#4a5364', 0.3);
  },
  ember_cache: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,106,42,0.24)');
    g.bar(0.5, 0.7, 0.52, 0.3, 0, '#4a4038', 0.16);
    g.drop(0.5, 0.42, 0.2, C.ember);
    g.drop(0.5, 0.46, 0.11, C.gold);
    g.dots(0.5, 0.66, 0.2, 3, 0.035, C.amber, 0.4);
  },
  slipstream: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(143,216,255,0.2)');
    for (let i = 0; i < 3; i++) {
      g.arc(0.34 + i * 0.02, 0.32 + i * 0.19, 0.3, -1.0, 0.9, 0.06, i === 1 ? C.ice : '#7fb6d8');
    }
    g.tri(0.78, 0.5, 0.14, 0.16, Math.PI / 2, C.ice);
  },
  clutch_incubator: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,207,92,0.2)');
    g.disc(0.5, 0.56, 0.3, '#e6dfc8');
    g.disc(0.5, 0.42, 0.23, '#f4eeda');
    // A crack running through the shell, lit from inside.
    g.stroke(C.ember, 0.05);
    g.bar(0.44, 0.5, 0.05, 0.3, 0.4, C.ember, 0.2);
    g.bar(0.56, 0.56, 0.05, 0.24, -0.5, C.ember, 0.2);
    g.arc(0.5, 0.84, 0.3, Math.PI * 1.15, Math.PI * 1.85, 0.07, '#8a7a5a');
  },
  splinter_rounds: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,224,75,0.2)');
    g.blade(0.5, 0.44, 0.5, 0.16, 0, C.steel);
    g.blade(0.3, 0.6, 0.34, 0.12, -0.7, '#9fb0c8');
    g.blade(0.7, 0.6, 0.34, 0.12, 0.7, '#9fb0c8');
    g.disc(0.5, 0.74, 0.06, C.volt);
  },
  warded_plating: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(143,216,255,0.2)');
    g.shield(0.5, 0.5, 0.66, 0.74, '#3f5a72');
    g.shield(0.5, 0.5, 0.46, 0.52, C.ice);
    g.poly(0.5, 0.48, 0.16, 6, Math.PI / 6, '#e8f6ff');
    g.ring(0.5, 0.48, 0.24, 0.03, '#e8f6ff');
  },
  killers_eye: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,77,94,0.2)');
    g.arc(0.5, 0.66, 0.34, Math.PI * 1.12, Math.PI * 1.88, 0.08, C.bone);
    g.arc(0.5, 0.34, 0.34, Math.PI * 0.12, Math.PI * 0.88, 0.08, C.bone);
    g.disc(0.5, 0.5, 0.17, C.blood);
    g.disc(0.5, 0.5, 0.07, C.shadow);
    g.bar(0.5, 0.5, 0.05, 0.28, 0, C.shadow, 0.4);
  },
  alpha_bond: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,138,61,0.22)');
    g.ring(0.5, 0.5, 0.32, 0.06, C.amber);
    g.disc(0.32, 0.5, 0.1, C.ember);
    g.disc(0.68, 0.5, 0.1, C.gold);
    g.bolt(0.5, 0.5, 0.5, '#fff2cf');
    g.dots(0.5, 0.5, 0.32, 6, 0.03, C.amber, 0.5);
  },
  molten_core: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,106,42,0.26)');
    g.poly(0.5, 0.54, 0.34, 6, 0.2, '#3a2a26');
    g.poly(0.5, 0.54, 0.24, 6, 0.2, C.ember);
    g.poly(0.5, 0.54, 0.13, 6, 0.2, C.gold);
    for (const dx of [-0.2, 0.05, 0.22]) g.tri(0.5 + dx, 0.22, 0.1, 0.18, 0, C.ember);
  },
  second_wind: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(143,216,255,0.2)');
    g.arc(0.46, 0.5, 0.3, -2.4, 1.4, 0.09, C.ice);
    g.arc(0.5, 0.5, 0.14, 0.4, 3.6, 0.07, '#d8f2ff');
    g.tri(0.72, 0.34, 0.13, 0.15, 1.1, C.ice);
    g.dots(0.5, 0.5, 0.38, 3, 0.035, '#d8f2ff', 1.2);
  },
  dracoform_sigil: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(255,138,61,0.26)');
    g.poly(0.5, 0.5, 0.4, 3, -Math.PI / 2, '#3a2a1e');
    g.poly(0.5, 0.54, 0.28, 3, -Math.PI / 2, C.ember);
    // Slit pupil.
    g.disc(0.5, 0.56, 0.13, C.gold);
    g.bar(0.5, 0.56, 0.05, 0.22, 0, C.shadow, 0.5);
    g.tri(0.24, 0.3, 0.14, 0.18, -0.5, C.amber);
    g.tri(0.76, 0.3, 0.14, 0.18, 0.5, C.amber);
  },
  ouroboros_coil: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(180,115,255,0.24)');
    g.ring(0.5, 0.5, 0.32, 0.11, '#5c3a86');
    g.arc(0.5, 0.5, 0.32, -0.4, 4.4, 0.09, C.violet);
    g.disc(0.78, 0.5, 0.09, C.violet);
    g.disc(0.8, 0.47, 0.026, C.shadow);
    g.tri(0.66, 0.66, 0.09, 0.12, -0.8, C.rose);
    g.dots(0.5, 0.5, 0.32, 8, 0.022, '#e7d4ff', 0.2);
  },
  zero_hour: (g) => {
    g.glow(0.5, 0.5, 0.46, 'rgba(159,224,255,0.24)');
    g.ring(0.5, 0.52, 0.34, 0.07, C.ice);
    g.disc(0.5, 0.52, 0.27, 'rgba(20,30,44,0.85)');
    g.dots(0.5, 0.52, 0.24, 12, 0.02, '#d8f2ff');
    g.bar(0.5, 0.42, 0.045, 0.24, 0, '#ffffff', 0.5);
    g.bar(0.56, 0.55, 0.045, 0.18, 1.9, C.blood, 0.5);
    g.disc(0.5, 0.52, 0.045, C.blood);
    g.bar(0.5, 0.14, 0.16, 0.07, 0, C.steel, 0.4);
  },
};

/** Category fallbacks so an item without a bespoke recipe still gets sensible art. */
const TAG_FALLBACK = {
  Offense: (g) => { g.glow(0.5, 0.5, 0.46, 'rgba(255,77,94,0.2)'); g.blade(0.5, 0.5, 0.7, 0.26, 0, C.steel); },
  Defense: (g) => { g.glow(0.5, 0.5, 0.46, 'rgba(199,208,224,0.18)'); g.shield(0.5, 0.5, 0.6, 0.7, C.steel); },
  Healing: (g) => { g.glow(0.5, 0.5, 0.46, 'rgba(75,224,138,0.2)'); g.flask(0.5, 0.52, 0.28, C.leaf, C.steel); },
  Mobility: (g) => { g.glow(0.5, 0.5, 0.46, 'rgba(143,216,255,0.2)'); g.chevron(0.5, 0.42, 0.5, 0.2, 0, C.ice, 0.1); g.chevron(0.5, 0.64, 0.5, 0.2, 0, C.ice, 0.1); },
  Utility: (g) => { g.glow(0.5, 0.5, 0.46, 'rgba(180,115,255,0.2)'); g.gear(0.5, 0.5, 0.4, 8, C.steel); g.disc(0.5, 0.5, 0.15, C.shadow); },
};

/**
 * Draws an item's icon onto a canvas context sized `size` × `size`.
 * `withPlate` paints a rarity-tinted rounded backing, used for the world drop.
 */
export function drawItemIcon(ctx, item, size, { withPlate = false, rarityColor = '#ffffff' } = {}) {
  ctx.clearRect(0, 0, size, size);
  if (withPlate) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(size * 0.04, size * 0.04, size * 0.92, size * 0.92, size * 0.16);
    ctx.fillStyle = 'rgba(12,14,20,0.82)';
    ctx.fill();
    ctx.strokeStyle = rarityColor;
    ctx.lineWidth = size * 0.045;
    ctx.stroke();
    ctx.restore();
  }
  const g = makeBrush(ctx, size);
  const recipe = ICON_RECIPES[item.id] || TAG_FALLBACK[item.tag] || TAG_FALLBACK.Utility;
  ctx.save();
  // Inset so strokes never clip the plate edge.
  ctx.translate(size * 0.5, size * 0.5);
  ctx.scale(0.84, 0.84);
  ctx.translate(-size * 0.5, -size * 0.5);
  recipe(g);
  ctx.restore();
}

const dataUrlCache = new Map();

/** Cached data URL of an item's icon, for DOM use (HUD, cards, codex). */
export function itemIconDataURL(item, size = 96) {
  const key = `${item.id}:${size}`;
  if (dataUrlCache.has(key)) return dataUrlCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  drawItemIcon(c.getContext('2d'), item, size);
  const url = c.toDataURL('image/png');
  dataUrlCache.set(key, url);
  return url;
}

/** Raw canvas of an item's icon, for building a texture. */
export function itemIconCanvas(item, size = 256, opts = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  drawItemIcon(c.getContext('2d'), item, size, opts);
  return c;
}

export function hasBespokeIcon(id) { return !!ICON_RECIPES[id]; }
