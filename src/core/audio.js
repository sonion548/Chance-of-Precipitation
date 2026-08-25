/**
 * The sound of the descent.
 *
 * Everything here is synthesised at runtime — there is not a single audio file
 * in the project, and there is not going to be one. The whole game is built out
 * of procedural geometry and procedural texture; loading a folder of .ogg files
 * would be the only part of it that had to be downloaded, and the only part
 * that could not be retuned by changing a number.
 *
 * Three buses hang off the master: SFX, music, and UI. Positional sounds are
 * attenuated by distance and panned by where they sit relative to the camera's
 * right vector, which is enough spatialisation for a third-person game and
 * costs a fraction of what a PannerNode per voice would.
 */

import { settings } from './settings.js';

const MAX_VOICES = 28;          // hard ceiling on simultaneous SFX graphs
// Beyond this a positional sound is not synthesised at all. It grew with the
// arenas: at 62m, in a 170m-radius stage, you could not hear a fight you were
// running towards until you were nearly in it.
const HEAR_DISTANCE = 96;

/** Semitone offsets from a root, per scale. Music picks one per theme. */
const SCALES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

/** Musical identity per stage theme, so each arena sounds like itself. */
export const THEME_MUSIC = {
  hollow: { root: 55.00, scale: 'dorian', bpm: 84, warmth: 0.62, drive: 0.18 },      // G1
  mire: { root: 51.91, scale: 'dorian', bpm: 70, warmth: 0.68, drive: 0.14 },        // G#1
  spire: { root: 46.25, scale: 'harmonicMinor', bpm: 92, warmth: 0.34, drive: 0.38 },// F#1
  ossuary: { root: 58.27, scale: 'phrygian', bpm: 80, warmth: 0.46, drive: 0.3 },    // A#1
  tidal: { root: 51.91, scale: 'aeolian', bpm: 78, warmth: 0.55, drive: 0.2 },       // G#1
  frozen: { root: 49.00, scale: 'aeolian', bpm: 72, warmth: 0.3, drive: 0.24 },      // G1
  ashfall: { root: 43.65, scale: 'phrygian', bpm: 96, warmth: 0.34, drive: 0.42 },   // F1
  void: { root: 41.20, scale: 'harmonicMinor', bpm: 88, warmth: 0.26, drive: 0.5 },  // E1
  ember: { root: 38.89, scale: 'phrygian', bpm: 104, warmth: 0.22, drive: 0.62 },    // D#1
  sanctum: { root: 36.71, scale: 'locrian', bpm: 116, warmth: 0.12, drive: 0.85 },   // D1
  menu: { root: 48.99, scale: 'dorian', bpm: 66, warmth: 0.7, drive: 0.05 },
};

const noteHz = (root, semis) => root * Math.pow(2, semis / 12);

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.voices = 0;
    this._lastPlayed = new Map();     // name -> ctx time, for throttling
    this._listener = { x: 0, y: 0, z: 0, rx: 1, ry: 0, rz: 0, fx: 0, fy: 0, fz: 1 };
    this._musicState = null;
    this._nextNote = 0;
    this._step = 0;
    this._intensity = 0;
    this._targetIntensity = 0;
    this._noise = null;
    settings.onChange(() => this.applyVolumes());
  }

  /**
   * Browsers will not let a page make noise before it has been touched, so the
   * whole graph is built on the first gesture rather than at load. Everything
   * that plays before then is silently dropped — which is correct: it is the
   * menu, and the player has not asked for anything yet.
   */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      return;
    }

    const ctx = this.ctx;
    this.master = ctx.createGain();
    // A gentle limiter keeps a room full of explosions from clipping without
    // audibly pumping the way an aggressive compressor would.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -9;
    this.limiter.knee.value = 12;
    this.limiter.ratio.value = 5;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.18;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.uiBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.uiBus.connect(this.master);
    this.musicBus.connect(this.master);

    // One shared reverb for everything spatial. A convolver with a synthesised
    // impulse is far cheaper than per-voice delay lines and makes the arena
    // sound like a space rather than a headset.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.1, 2.6);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.5;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);

    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.22;
    this.reverbSend.connect(this.reverb);

    this._noise = this._noiseBuffer(2.0);
    this.ready = true;
    this.applyVolumes();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  applyVolumes() {
    if (!this.ready) return;
    const s = settings.data;
    const m = s.muted ? 0 : s.masterVolume;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(m, now, 0.05);
    this.sfxBus.gain.setTargetAtTime(s.sfxVolume, now, 0.05);
    this.uiBus.gain.setTargetAtTime(s.sfxVolume * 0.8, now, 0.05);
    this.musicBus.gain.setTargetAtTime(s.musicVolume * 0.75, now, 0.1);
  }

  /* ------------------------------------------------------------- buffers */
  _noiseBuffer(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Exponentially decaying noise, which is what a room's tail actually is. */
  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // A short pre-delay of silence stops the reverb smearing the transient.
        const gate = t < 0.012 ? t / 0.012 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * gate;
      }
    }
    return buf;
  }

  /* ----------------------------------------------------------- listener */
  /** Called once a frame with the render camera, before any sound is placed. */
  updateListener(camera) {
    if (!camera) return;
    const l = this._listener;
    l.x = camera.position.x; l.y = camera.position.y; l.z = camera.position.z;
    const e = camera.matrixWorld.elements;
    l.rx = e[0]; l.ry = e[1]; l.rz = e[2];      // camera right, world space
    l.fx = -e[8]; l.fy = -e[9]; l.fz = -e[10];  // camera forward
  }

  /**
   * Distance gain and stereo pan for a world position.
   *
   * Attenuation is inverse-ish rather than inverse-square: true inverse-square
   * makes anything past twenty metres inaudible, and in an arena a hundred and
   * fifty metres across that means you never hear the fight you are walking
   * towards until you are standing in it.
   */
  _place(pos) {
    const l = this._listener;
    const dx = pos.x - l.x, dy = pos.y - l.y, dz = pos.z - l.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > HEAR_DISTANCE) return null;
    const gain = Math.pow(1 - dist / HEAR_DISTANCE, 1.6) / (1 + dist * 0.055);
    if (gain < 0.004) return null;
    const inv = dist > 0.001 ? 1 / dist : 0;
    const pan = Math.max(-1, Math.min(1, (dx * l.rx + dy * l.ry + dz * l.rz) * inv * 0.92));
    return { gain: gain * 1.35, pan, dist };
  }

  /* ------------------------------------------------------------- voicing */
  /**
   * Opens one voice: a gain node, optionally panned and placed, wired into the
   * requested bus plus the reverb send. Returns null when the sound is out of
   * earshot, muted, or the voice ceiling is already reached — every caller
   * treats that as "do not bother synthesising it", which is the point.
   */
  _voice(name, { position = null, bus = 'sfx', gain = 1, throttle = 0.03, send = 0.22 } = {}) {
    if (!this.ready || settings.data.muted) return null;
    const t = this.ctx.currentTime;
    if (throttle > 0) {
      const last = this._lastPlayed.get(name) || -1;
      if (t - last < throttle) return null;
      this._lastPlayed.set(name, t);
    }
    if (this.voices >= MAX_VOICES) return null;

    let g = gain;
    let pan = 0;
    if (position) {
      const p = this._place(position);
      if (!p) return null;
      g *= p.gain;
      pan = p.pan;
    }
    if (g < 0.003) return null;

    const out = this.ctx.createGain();
    out.gain.value = g;
    let tail = out;
    if (pan !== 0 && this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = pan;
      out.connect(panner);
      tail = panner;
    }
    const target = bus === 'music' ? this.musicBus : bus === 'ui' ? this.uiBus : this.sfxBus;
    tail.connect(target);
    if (send > 0 && position) {
      const s = this.ctx.createGain();
      s.gain.value = send;
      tail.connect(s);
      s.connect(this.reverbSend);
    }
    this.voices++;
    return { node: out, t };
  }

  _release(voice, at) {
    // Voices are counted down when the last source stops, not when the caller
    // thinks it will — a stray long release would otherwise leak a slot.
    const delay = Math.max(0, (at - this.ctx.currentTime) * 1000) + 60;
    setTimeout(() => { this.voices = Math.max(0, this.voices - 1); }, delay);
  }

  /** One oscillator with an envelope. The workhorse behind most of the SFX. */
  _osc(dest, { type = 'sine', freq = 440, to = null, t0, attack = 0.002, decay = 0.18, peak = 1, curve = 'exp', detune = 0 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(Math.max(12, freq), t0);
    if (to !== null && to !== freq) {
      o.frequency.exponentialRampToValueAtTime(Math.max(12, to), t0 + decay);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    else g.gain.linearRampToValueAtTime(0.0001, t0 + attack + decay);
    o.connect(g);
    g.connect(dest);
    o.start(t0);
    o.stop(t0 + attack + decay + 0.02);
    return o;
  }

  /** A burst of filtered noise — impacts, wind, footfalls, explosions. */
  _noiseBurst(dest, { t0, decay = 0.2, peak = 1, type = 'lowpass', freq = 1200, q = 1, sweepTo = null, attack = 0.002 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    f.Q.value = q;
    if (sweepTo !== null) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t0 + Math.random() * 0.01);
    src.stop(t0 + attack + decay + 0.02);
    return src;
  }

  /* ========================================================== sound effects */

  /**
   * Weapon fire. The character of the shot comes from the weapon's model tag,
   * so a new weapon that reuses an existing silhouette gets a fitting report
   * without anyone having to author one.
   */
  shoot(model, position, pitch = 1) {
    const spec = {
      pistol: { body: 210, decay: 0.11, noise: 2400, gain: 0.5, type: 'square' },
      shotgun: { body: 110, decay: 0.3, noise: 1500, gain: 0.95, type: 'sawtooth' },
      rifle: { body: 260, decay: 0.13, noise: 3000, gain: 0.55, type: 'sawtooth' },
      smg: { body: 300, decay: 0.07, noise: 3600, gain: 0.34, type: 'square' },
      launcher: { body: 90, decay: 0.26, noise: 900, gain: 0.8, type: 'triangle' },
      beam: { body: 700, decay: 0.06, noise: 5200, gain: 0.22, type: 'sine' },
      scythe: { body: 340, decay: 0.22, noise: 4200, gain: 0.5, type: 'triangle' },
      fists: { body: 150, decay: 0.14, noise: 1800, gain: 0.7, type: 'triangle' },
    }[model] || { body: 220, decay: 0.12, noise: 2600, gain: 0.5, type: 'square' };

    const v = this._voice(`shoot:${model}`, { position, gain: spec.gain, throttle: 0.022, send: 0.16 });
    if (!v) return;
    const { node, t } = v;
    const p = pitch * (0.96 + Math.random() * 0.08);
    this._osc(node, { type: spec.type, freq: spec.body * p, to: spec.body * 0.35 * p, t0: t, decay: spec.decay, peak: 0.7 });
    this._noiseBurst(node, { t0: t, decay: spec.decay * 0.8, peak: 0.8, type: 'highpass', freq: spec.noise * p, sweepTo: spec.noise * 0.25 });
    // A tiny sub thump underneath is what makes a shot feel like it has a body.
    this._osc(node, { type: 'sine', freq: 74 * p, to: 40, t0: t, decay: spec.decay * 1.3, peak: 0.55 });
    this._release(v, t + spec.decay * 1.4);
  }

  /** Bullet or beam striking the world. */
  impact(position, hard = false) {
    const v = this._voice('impact', { position, gain: hard ? 0.42 : 0.26, throttle: 0.03 });
    if (!v) return;
    const { node, t } = v;
    this._noiseBurst(node, {
      t0: t, decay: hard ? 0.14 : 0.07, peak: 0.85,
      type: 'bandpass', freq: hard ? 900 : 2600, q: 1.4, sweepTo: hard ? 260 : 900,
    });
    this._release(v, t + 0.2);
  }

  /** Something took damage. Pitch rides the fraction of its health removed. */
  hit(position, severity = 0.4, crit = false) {
    const v = this._voice(crit ? 'crit' : 'hit', { position, gain: crit ? 0.5 : 0.3, throttle: 0.028 });
    if (!v) return;
    const { node, t } = v;
    const base = crit ? 620 : 300 + severity * 220;
    this._osc(node, { type: crit ? 'square' : 'triangle', freq: base, to: base * 0.4, t0: t, decay: crit ? 0.14 : 0.08, peak: 0.6 });
    this._noiseBurst(node, { t0: t, decay: 0.075, peak: 0.7, type: 'bandpass', freq: crit ? 3200 : 1500, q: 1.2 });
    this._release(v, t + 0.22);
  }

  /** Enemy dies: a short collapse rather than a bang. */
  enemyDeath(position, scale = 1) {
    const v = this._voice('death', { position, gain: 0.5 * Math.min(2, scale), throttle: 0.04, send: 0.34 });
    if (!v) return;
    const { node, t } = v;
    this._osc(node, { type: 'sawtooth', freq: 190 / scale, to: 46 / scale, t0: t, decay: 0.34 * scale, peak: 0.5 });
    this._noiseBurst(node, { t0: t, decay: 0.3 * scale, peak: 0.7, type: 'lowpass', freq: 1600, sweepTo: 180 });
    this._release(v, t + 0.4 * scale);
  }

  explosion(position, radius = 6) {
    const scale = Math.min(2.4, radius / 6);
    const v = this._voice('boom', { position, gain: 0.7 * scale, throttle: 0.045, send: 0.5 });
    if (!v) return;
    const { node, t } = v;
    this._noiseBurst(node, { t0: t, decay: 0.42 * scale, peak: 1, type: 'lowpass', freq: 2200, sweepTo: 120, attack: 0.004 });
    this._osc(node, { type: 'sine', freq: 90 * (1 / scale), to: 26, t0: t, decay: 0.5 * scale, peak: 0.9 });
    this._osc(node, { type: 'sawtooth', freq: 150, to: 44, t0: t + 0.01, decay: 0.2 * scale, peak: 0.32 });
    this._release(v, t + 0.6 * scale);
  }

  /** Whatever the player is standing on, one step of it. */
  footstep(position, running = false) {
    const v = this._voice('step', { position, gain: running ? 0.2 : 0.13, throttle: 0.11, send: 0.12 });
    if (!v) return;
    const { node, t } = v;
    this._noiseBurst(node, {
      t0: t, decay: 0.075, peak: 0.7, type: 'bandpass',
      freq: 380 + Math.random() * 220, q: 0.9, sweepTo: 180,
    });
    this._release(v, t + 0.14);
  }

  jump(position) {
    const v = this._voice('jump', { position, gain: 0.3, throttle: 0.06 });
    if (!v) return;
    const { node, t } = v;
    this._osc(node, { type: 'sine', freq: 240, to: 480, t0: t, decay: 0.14, peak: 0.5 });
    this._noiseBurst(node, { t0: t, decay: 0.1, peak: 0.35, type: 'highpass', freq: 900 });
    this._release(v, t + 0.2);
  }

  land(position, hard = false) {
    const v = this._voice('land', { position, gain: hard ? 0.5 : 0.26, throttle: 0.06 });
    if (!v) return;
    const { node, t } = v;
    this._osc(node, { type: 'sine', freq: hard ? 130 : 180, to: 50, t0: t, decay: hard ? 0.22 : 0.12, peak: 0.7 });
    this._noiseBurst(node, { t0: t, decay: 0.13, peak: 0.6, type: 'lowpass', freq: 1100, sweepTo: 220 });
    this._release(v, t + 0.3);
  }

  dash(position) {
    const v = this._voice('dash', { position, gain: 0.4, throttle: 0.05 });
    if (!v) return;
    const { node, t } = v;
    this._noiseBurst(node, { t0: t, decay: 0.26, peak: 0.7, type: 'bandpass', freq: 480, q: 0.8, sweepTo: 2600 });
    this._osc(node, { type: 'triangle', freq: 160, to: 620, t0: t, decay: 0.2, peak: 0.3 });
    this._release(v, t + 0.32);
  }

  /** The player took a hit. Never positional — it happened to you. */
  playerHurt(severity = 0.4) {
    const v = this._voice('hurt', { gain: 0.42, throttle: 0.12, send: 0 });
    if (!v) return;
    const { node, t } = v;
    this._osc(node, { type: 'sawtooth', freq: 150 - severity * 50, to: 58, t0: t, decay: 0.3, peak: 0.5 });
    this._noiseBurst(node, { t0: t, decay: 0.2, peak: 0.5, type: 'lowpass', freq: 900, sweepTo: 200 });
    this._release(v, t + 0.4);
  }

  playerDeath() {
    const v = this._voice('playerDeath', { gain: 0.85, throttle: 0.5, send: 0 });
    if (!v) return;
    const { node, t } = v;
    for (let i = 0; i < 4; i++) {
      this._osc(node, { type: 'sawtooth', freq: 320 - i * 40, to: 30, t0: t + i * 0.07, decay: 1.2, peak: 0.28 });
    }
    this._noiseBurst(node, { t0: t, decay: 1.4, peak: 0.5, type: 'lowpass', freq: 1400, sweepTo: 60 });
    this._release(v, t + 1.6);
  }

  heal() {
    const v = this._voice('heal', { gain: 0.28, throttle: 0.25, send: 0 });
    if (!v) return;
    const { node, t } = v;
    [523.25, 659.25, 783.99].forEach((f, i) => {
      this._osc(node, { type: 'sine', freq: f, t0: t + i * 0.045, decay: 0.3, peak: 0.28 });
    });
    this._release(v, t + 0.5);
  }

  pickup(rarityOrder = 0) {
    const v = this._voice('pickup', { gain: 0.4, throttle: 0.05, send: 0 });
    if (!v) return;
    const { node, t } = v;
    // Higher rarities arpeggiate further up, so you hear what you got before
    // the card has finished sliding in.
    const steps = [0, 4, 7, 11, 14].slice(0, 2 + Math.min(3, rarityOrder));
    steps.forEach((s, i) => {
      this._osc(node, { type: 'triangle', freq: noteHz(523.25, s), t0: t + i * 0.055, decay: 0.26, peak: 0.3 });
    });
    this._release(v, t + 0.5);
  }

  gold(position) {
    const v = this._voice('gold', { position, gain: 0.22, throttle: 0.05, send: 0.1 });
    if (!v) return;
    const { node, t } = v;
    const f = 1180 + Math.random() * 380;
    this._osc(node, { type: 'square', freq: f, to: f * 1.5, t0: t, decay: 0.09, peak: 0.22 });
    this._osc(node, { type: 'sine', freq: f * 2, t0: t + 0.02, decay: 0.1, peak: 0.14 });
    this._release(v, t + 0.18);
  }

  levelUp() {
    const v = this._voice('levelUp', { gain: 0.55, throttle: 0.4, send: 0 });
    if (!v) return;
    const { node, t } = v;
    [0, 4, 7, 12, 16].forEach((s, i) => {
      this._osc(node, { type: 'triangle', freq: noteHz(392, s), t0: t + i * 0.07, decay: 0.4, peak: 0.3 });
      this._osc(node, { type: 'sine', freq: noteHz(784, s), t0: t + i * 0.07, decay: 0.3, peak: 0.14 });
    });
    this._release(v, t + 0.8);
  }

  chestOpen(position, kind = 'chest') {
    const v = this._voice('chest', { position, gain: 0.6, throttle: 0.1, send: 0.4 });
    if (!v) return;
    const { node, t } = v;
    // Hinge and lid first, then a chord whose weight matches what it cost.
    this._noiseBurst(node, { t0: t, decay: 0.18, peak: 0.5, type: 'bandpass', freq: 1600, q: 2, sweepTo: 700 });
    this._osc(node, { type: 'sine', freq: 120, to: 70, t0: t + 0.05, decay: 0.3, peak: 0.5 });
    const chord = kind === 'legendary' ? [0, 5, 9, 14, 17] : kind === 'large' ? [0, 4, 9, 12] : [0, 7, 12];
    const root = kind === 'legendary' ? 293.66 : kind === 'large' ? 329.63 : 349.23;
    chord.forEach((s, i) => {
      this._osc(node, { type: 'triangle', freq: noteHz(root, s), t0: t + 0.12 + i * 0.05, decay: 0.55, peak: 0.24 });
    });
    this._release(v, t + 1.0);
  }

  eggHatch(position) {
    const v = this._voice('egg', { position, gain: 0.55, throttle: 0.12, send: 0.35 });
    if (!v) return;
    const { node, t } = v;
    for (let i = 0; i < 5; i++) {
      this._noiseBurst(node, { t0: t + i * 0.045, decay: 0.05, peak: 0.5, type: 'bandpass', freq: 2400 + i * 400, q: 3 });
    }
    this._osc(node, { type: 'sawtooth', freq: 420, to: 900, t0: t + 0.22, decay: 0.26, peak: 0.3 });
    this._release(v, t + 0.6);
  }

  /** Interaction denied — not enough gold. */
  denied() {
    const v = this._voice('denied', { gain: 0.34, throttle: 0.2, send: 0 });
    if (!v) return;
    const { node, t } = v;
    this._osc(node, { type: 'square', freq: 180, to: 110, t0: t, decay: 0.14, peak: 0.28 });
    this._release(v, t + 0.2);
  }

  bossSpawn() {
    const v = this._voice('bossSpawn', { gain: 0.9, throttle: 0.6, send: 0 });
    if (!v) return;
    const { node, t } = v;
    this._osc(node, { type: 'sawtooth', freq: 55, to: 27.5, t0: t, decay: 1.6, peak: 0.6 });
    this._osc(node, { type: 'square', freq: 82.4, to: 41.2, t0: t + 0.1, decay: 1.4, peak: 0.28 });
    this._noiseBurst(node, { t0: t, decay: 1.2, peak: 0.45, type: 'lowpass', freq: 600, sweepTo: 80 });
    this._release(v, t + 1.9);
  }

  teleporter(state) {
    const v = this._voice(`tp:${state}`, { gain: 0.6, throttle: 0.3, send: 0 });
    if (!v) return;
    const { node, t } = v;
    if (state === 'ready') {
      [0, 7, 12, 19].forEach((s, i) => {
        this._osc(node, { type: 'triangle', freq: noteHz(261.63, s), t0: t + i * 0.09, decay: 0.7, peak: 0.28 });
      });
    } else {
      this._osc(node, { type: 'sawtooth', freq: 110, to: 330, t0: t, decay: 0.9, peak: 0.35 });
      this._noiseBurst(node, { t0: t, decay: 0.8, peak: 0.3, type: 'bandpass', freq: 400, q: 1.4, sweepTo: 2400 });
    }
    this._release(v, t + 1.1);
  }

  /** Descending to the next stage, or stepping through the rift. */
  descend() {
    const v = this._voice('descend', { gain: 0.8, throttle: 0.5, send: 0 });
    if (!v) return;
    const { node, t } = v;
    this._osc(node, { type: 'sine', freq: 440, to: 55, t0: t, decay: 1.1, peak: 0.45 });
    this._noiseBurst(node, { t0: t, decay: 1.0, peak: 0.4, type: 'lowpass', freq: 3000, sweepTo: 120 });
    this._release(v, t + 1.3);
  }

  /** Fists: enemies coming apart on contact. */
  gib(position) {
    const v = this._voice('gib', { position, gain: 0.7, throttle: 0.035, send: 0.4 });
    if (!v) return;
    const { node, t } = v;
    this._noiseBurst(node, { t0: t, decay: 0.22, peak: 1, type: 'lowpass', freq: 1800, sweepTo: 90 });
    this._osc(node, { type: 'sawtooth', freq: 120, to: 34, t0: t, decay: 0.3, peak: 0.65 });
    this._osc(node, { type: 'square', freq: 62, to: 30, t0: t + 0.02, decay: 0.24, peak: 0.4 });
    this._release(v, t + 0.42);
  }

  /** Fists: the ground slam landing. */
  slam(position) {
    const v = this._voice('slam', { position, gain: 1.0, throttle: 0.1, send: 0.55 });
    if (!v) return;
    const { node, t } = v;
    this._osc(node, { type: 'sine', freq: 78, to: 22, t0: t, decay: 0.9, peak: 1 });
    this._noiseBurst(node, { t0: t, decay: 0.7, peak: 0.8, type: 'lowpass', freq: 2600, sweepTo: 70, attack: 0.003 });
    this._noiseBurst(node, { t0: t + 0.02, decay: 0.35, peak: 0.4, type: 'highpass', freq: 1800 });
    this._release(v, t + 1.1);
  }

  uiClick(kind = 'click') {
    const v = this._voice(`ui:${kind}`, { bus: 'ui', gain: 0.3, throttle: 0.03, send: 0 });
    if (!v) return;
    const { node, t } = v;
    const f = kind === 'back' ? 420 : kind === 'confirm' ? 660 : 540;
    this._osc(node, { type: 'square', freq: f, to: f * (kind === 'back' ? 0.7 : 1.35), t0: t, decay: 0.06, peak: 0.2 });
    this._release(v, t + 0.12);
  }

  /* ================================================================ music */

  /**
   * Starts (or crossfades to) a theme's score.
   *
   * The music is not a loop of anything — it is a small generative engine, and
   * the only thing a stage change does is hand it a different key, tempo and
   * timbre. That is why the transition never sounds like a cut.
   */
  setMusic(themeId) {
    const spec = THEME_MUSIC[themeId] || THEME_MUSIC.menu;
    if (this._musicState?.id === themeId) return;
    this._musicState = { id: themeId, ...spec, scaleSteps: SCALES[spec.scale] || SCALES.aeolian };
    this._step = 0;
    if (!this.ready) return;
    this._nextNote = this.ctx.currentTime + 0.1;
    this._startDrone();
  }

  stopMusic() {
    this._musicState = null;
    this._stopDrone();
  }

  /** Intensity 0..1 opens up the arrangement: percussion, then a lead. */
  setIntensity(v) { this._targetIntensity = Math.max(0, Math.min(1, v)); }

  _startDrone() {
    this._stopDrone();
    const ctx = this.ctx;
    const m = this._musicState;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.gain.setTargetAtTime(0.16, ctx.currentTime, 1.4);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300 + m.warmth * 900;
    filter.Q.value = 0.7;
    filter.connect(g);
    g.connect(this.musicBus);

    const oscs = [];
    // Root, fifth, and an octave above — detuned against each other so the pad
    // beats slowly instead of sitting still.
    for (const [semis, detune, type, level] of [
      [0, -6, 'sawtooth', 0.5], [0, 7, 'sawtooth', 0.42],
      [7, -3, 'triangle', 0.3], [12, 5, 'triangle', 0.18],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = noteHz(m.root, semis);
      o.detune.value = detune;
      const og = ctx.createGain();
      og.gain.value = level;
      o.connect(og); og.connect(filter);
      o.start();
      oscs.push(o);
    }
    // A slow LFO on the cutoff keeps the pad breathing.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220 + m.warmth * 260;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    this._drone = { g, filter, oscs, lfo, lfoGain };
  }

  _stopDrone() {
    const d = this._drone;
    if (!d) return;
    this._drone = null;
    const now = this.ctx.currentTime;
    d.g.gain.setTargetAtTime(0.0001, now, 0.5);
    setTimeout(() => {
      try {
        d.oscs.forEach((o) => o.stop());
        d.lfo.stop();
        d.g.disconnect();
      } catch { /* already torn down */ }
    }, 2200);
  }

  /**
   * Sequencer. Called from the frame loop; schedules ahead of the audio clock
   * rather than playing on the frame, so notes land on the grid even when the
   * renderer stutters.
   */
  update(dt) {
    if (!this.ready || !this._musicState) return;
    this._intensity += (this._targetIntensity - this._intensity) * Math.min(1, dt * 0.6);

    const m = this._musicState;
    const ctx = this.ctx;
    const stepDur = 60 / m.bpm / 2;         // eighth notes
    // A stalled frame loop — a hidden tab, a long stage build — leaves the
    // schedule pointing into the past. Walking it forward one note at a time
    // would then fire every missed note at once, which is a burst of noise the
    // moment you come back. Skip the gap instead: the score is generative, so
    // there is no bar to be in the middle of and nothing to resynchronise with.
    if (this._nextNote < ctx.currentTime - stepDur) {
      this._nextNote = ctx.currentTime + 0.02;
    }
    const horizon = ctx.currentTime + 0.25;
    let guard = 0;
    while (this._nextNote < horizon && guard++ < 16) {
      this._scheduleStep(this._nextNote, this._step, m);
      this._nextNote += stepDur;
      this._step = (this._step + 1) % 32;
    }

    if (this._drone) {
      const target = 300 + m.warmth * 900 + this._intensity * 1500;
      this._drone.filter.frequency.setTargetAtTime(target, ctx.currentTime, 0.8);
    }
  }

  _scheduleStep(t, step, m) {
    const intensity = this._intensity;
    const bus = this.musicBus;
    const scale = m.scaleSteps;

    // --- Bass: root on the downbeat, fifth on the and-of-three ---
    if (step % 8 === 0 || (step % 8 === 5 && intensity > 0.25)) {
      const g = this.ctx.createGain();
      g.gain.value = 0.3;
      g.connect(bus);
      const semis = step % 8 === 0 ? 0 : 7;
      this._osc(g, { type: 'sawtooth', freq: noteHz(m.root * 2, semis), to: noteHz(m.root, semis), t0: t, decay: 0.34, peak: 0.5 });
      this._osc(g, { type: 'sine', freq: noteHz(m.root, semis), t0: t, decay: 0.5, peak: 0.6 });
      setTimeout(() => g.disconnect(), 1400);
    }

    // --- Percussion: arrives with the fight, not before it ---
    if (intensity > 0.18) {
      const g = this.ctx.createGain();
      g.gain.value = 0.24 * Math.min(1, intensity * 1.6);
      g.connect(bus);
      if (step % 8 === 0) {
        this._osc(g, { type: 'sine', freq: 110, to: 42, t0: t, decay: 0.2, peak: 0.9 });
      } else if (step % 8 === 4) {
        this._noiseBurst(g, { t0: t, decay: 0.14, peak: 0.6, type: 'highpass', freq: 1400 });
      } else if (step % 2 === 1 && intensity > 0.45) {
        this._noiseBurst(g, { t0: t, decay: 0.04, peak: 0.22, type: 'highpass', freq: 5200 });
      }
      setTimeout(() => g.disconnect(), 1000);
    }

    // --- Lead: a wandering line that only shows up when things are bad ---
    if (intensity > 0.55 && step % 2 === 0 && Math.random() < 0.42 + intensity * 0.3) {
      const g = this.ctx.createGain();
      g.gain.value = 0.13 * (intensity - 0.5) * 2;
      g.connect(bus);
      const degree = scale[Math.floor(Math.random() * scale.length)];
      const octave = 24 + (Math.random() < 0.3 ? 12 : 0);
      this._osc(g, {
        type: m.drive > 0.4 ? 'square' : 'triangle',
        freq: noteHz(m.root, degree + octave), t0: t, decay: 0.28, peak: 0.5,
      });
      setTimeout(() => g.disconnect(), 1000);
    }
  }
}

export const audio = new Audio();
