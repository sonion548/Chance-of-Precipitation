import * as THREE from 'three';
import { CAMERA, WORLD } from './config.js';

const SHAKE_GAIN = 0.42;      // incoming amounts are scaled by this
const SHAKE_CEILING = 0.62;   // and the total can never exceed this

/** Renderer, scene, camera, lighting and the resize/quality plumbing. */
export class Engine {
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: window.devicePixelRatio < 1.6,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a0d16, WORLD.fogNear, WORLD.fogFar);

    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
    this.camera.position.set(0, 6, 12);

    // Lighting rig — rebuilt per stage theme.
    this.hemi = new THREE.HemisphereLight(0x8899cc, 0x2a2018, 0.55);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffd9a8, 1.5);
    this.sun.position.set(48, 76, 34);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 240;
    const S = 74;
    Object.assign(this.sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S });
    this.sun.shadow.bias = -0.0009;
    this.sun.shadow.normalBias = 0.045;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.rim = new THREE.DirectionalLight(0x6688ff, 0.35);
    this.rim.position.set(-40, 28, -50);
    this.scene.add(this.rim);

    this.clock = new THREE.Clock();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();

    // Camera shake state
    this.shakeAmount = 0;
    this.shakeDecay = 7.0;
    this._shakeOffset = new THREE.Vector3();

    // Adaptive quality: step down on sustained slow frames, back up when it recovers.
    this.qualityLevel = 3;          // 3 = full, 0 = minimum
    this._frameAvg = 16;
    this._qualityHold = 2;
    this._basePixelRatio = Math.min(window.devicePixelRatio, 2);
  }

  /**
   * Watches a smoothed frame time and trades visual fidelity for responsiveness.
   * Held for a couple of seconds either side so it never oscillates.
   */
  updateQuality(dtMs) {
    this._frameAvg += (dtMs - this._frameAvg) * 0.06;
    this._qualityHold -= dtMs / 1000;
    if (this._qualityHold > 0) return;

    if (this._frameAvg > 30 && this.qualityLevel > 0) {
      this.setQuality(this.qualityLevel - 1);
      this._qualityHold = 3;
    } else if (this._frameAvg < 13 && this.qualityLevel < 3) {
      this.setQuality(this.qualityLevel + 1);
      this._qualityHold = 6;
    }
  }

  setQuality(level) {
    this.qualityLevel = level;
    const shadows = level >= 2;
    this.renderer.shadowMap.enabled = shadows;
    this.sun.castShadow = shadows;
    if (shadows) {
      const size = level >= 3 ? 1536 : 1024;
      if (this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
    }
    this.renderer.setPixelRatio(level >= 1 ? this._basePixelRatio : Math.min(1, this._basePixelRatio * 0.7));
    // Dynamic point lights are the first thing to go: they are per-pixel work
    // across the whole screen and the effects still read without them.
    if (this.onQualityChange) this.onQualityChange(level);
    this.scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setTheme(theme) {
    this.scene.fog.color.setHex(theme.fog);
    this.scene.fog.near = theme.fogNear ?? WORLD.fogNear;
    this.scene.fog.far = theme.fogFar ?? WORLD.fogFar;
    this.renderer.setClearColor(theme.sky, 1);
    this.hemi.color.setHex(theme.hemiSky);
    this.hemi.groundColor.setHex(theme.hemiGround);
    this.hemi.intensity = theme.hemiIntensity ?? 0.55;
    this.sun.color.setHex(theme.sunColor);
    this.sun.intensity = theme.sunIntensity ?? 1.5;
    this.sun.position.set(...theme.sunDir);
    this.rim.color.setHex(theme.rimColor ?? 0x6688ff);
    this.rim.intensity = theme.rimIntensity ?? 0.35;
    this.renderer.toneMappingExposure = theme.exposure ?? 1.08;
  }

  /**
   * Trauma-style shake, deliberately restrained.
   *
   * Boss slams and volleys were stacking enough shake to make the crosshair
   * unusable during exactly the fight that needs aim most. Incoming amounts are
   * scaled and the total is capped low; the decay is also faster, so hits read
   * as punchy without taking the camera away from the player.
   */
  addShake(amount) {
    // `shakeScale` is the player's own setting; zero turns the whole effect off
    // rather than merely quieting it, which is what people who need it off want.
    const scale = this.shakeScale ?? 1;
    if (scale <= 0) return;
    this.shakeAmount = Math.min(SHAKE_CEILING, this.shakeAmount + amount * SHAKE_GAIN * scale);
  }

  /** Applies decaying positional shake to the camera. Call after camera placement. */
  applyShake(dt, t) {
    if (this.shakeAmount <= 0.0005) { this.shakeAmount = 0; return; }
    const a = this.shakeAmount;
    this._shakeOffset.set(
      Math.sin(t * 41.3) * a * 0.14 + Math.sin(t * 78.7) * a * 0.05,
      Math.sin(t * 53.1) * a * 0.12 + Math.cos(t * 89.3) * a * 0.04,
      Math.cos(t * 47.9) * a * 0.09,
    );
    this.camera.position.add(this._shakeOffset);
    this.camera.rotateZ(Math.sin(t * 39.7) * a * 0.005);
    this.shakeAmount = Math.max(0, this.shakeAmount - this.shakeDecay * a * dt - dt * 0.3);
  }

  render() { this.renderer.render(this.scene, this.camera); }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}

/** Disposes a subtree's geometries/materials and removes it from its parent. */
export function disposeObject(obj) {
  obj.traverse?.((child) => {
    if (child.geometry) child.geometry.dispose();
    const m = child.material;
    // Materials tagged `shared` are cached and reused across stages — disposing
    // one here would leave the next arena of the same theme with a dead material.
    const kill = (mm) => { if (mm && !mm.userData?.shared) mm.dispose(); };
    if (Array.isArray(m)) m.forEach(kill);
    else kill(m);
  });
  obj.parent?.remove(obj);
}
