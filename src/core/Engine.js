import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Renderer, post chain and the adaptive resolution controller.
 *
 * Render scale is decoupled from window size on purpose. On a 1080p laptop
 * panel, scale 2.0 renders a 3840x2160 buffer and downsamples it - real 4K
 * supersampling, which is sharper than native 1080p rather than merely
 * bigger. On a 4K panel the same setting is native.
 *
 * The governor watches a rolling median frame time and walks the scale down
 * before it walks the effects down, because in a meditation app a steady 60
 * matters more than a sharp 24.
 */

export const QUALITY = {
  calm:    { label: 'Calm',    scale: 1.00, bloom: 0.55, bloomRes: 0.35, aniso: 4,  note: 'Native. Highest frame rate.' },
  clear:   { label: 'Clear',   scale: 1.40, bloom: 0.62, bloomRes: 0.45, aniso: 8,  note: '~1440p supersampled.' },
  vivid:   { label: 'Vivid',   scale: 2.00, bloom: 0.70, bloomRes: 0.50, aniso: 16, note: '4K supersampled. Demanding.' },
};

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // supersampling does this better and cheaper
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 1);

    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();

    // near/far this wide only works because of the log depth buffer above.
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.002, 5e9);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.75, 0.55);
    this.composer.addPass(this.bloom);

    this.composer.addPass(new OutputPass());

    this.quality = QUALITY.clear;
    this.adaptive = true;
    this._scaleNow = this.quality.scale;
    this._frames = [];
    this._lastGovern = 0;
    this.fps = 0;

    this.setQuality('clear');
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setQuality(key) {
    const q = QUALITY[key] || QUALITY.clear;
    this.quality = q;
    this.qualityKey = key;
    this._scaleNow = q.scale;
    this.bloom.strength = q.bloom;
    this.resize();
  }

  setAdaptive(on) {
    this.adaptive = on;
    if (!on) this._scaleNow = this.quality.scale;
    this.resize();
  }

  /** Effective device pixels the scene is being rendered at. */
  get renderSize() {
    const w = Math.round(this.canvas.clientWidth * this._scaleNow);
    const h = Math.round(this.canvas.clientHeight * this._scaleNow);
    return { w, h };
  }

  resize() {
    // A hidden or collapsed container reports 0. Sizing render targets to zero
    // makes every subsequent draw fail with an incomplete framebuffer, and the
    // canvas never recovers once the container comes back, so clamp instead.
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth || 1);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight || 1);
    this.viewportOk = w > 16 && h > 16;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(this._scaleNow);
    this.renderer.setSize(w, h, false);
    // Order matters: setPixelRatio re-runs setSize internally using the
    // previous dimensions, so the real setSize has to come second.
    this.composer.setPixelRatio(this._scaleNow);
    this.composer.setSize(w, h);
    // Do not poke bloom.resolution by hand - the composer already called
    // bloom.setSize(), and overwriting resolution afterwards desynchronises
    // it from its own render targets, which is what produced
    // "Framebuffer is incomplete: Attachment has zero size".
  }

  /**
   * Rolling frame-time governor. Median over ~40 frames so a single hitch
   * (texture upload, GC) never triggers a visible resolution change.
   */
  _govern(dtMs, now) {
    this._frames.push(dtMs);
    if (this._frames.length > 40) this._frames.shift();
    if (this._frames.length < 40) return;
    if (now - this._lastGovern < 900) return;
    this._lastGovern = now;

    const sorted = [...this._frames].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.fps = 1000 / median;

    if (!this.adaptive) return;

    const target = this.quality.scale;
    const floor = 0.62;
    let next = this._scaleNow;

    if (median > 22 && this._scaleNow > floor) next = this._scaleNow - 0.12;
    else if (median < 13.5 && this._scaleNow < target) next = Math.min(target, this._scaleNow + 0.08);

    next = Math.max(floor, Math.min(target, next));
    if (Math.abs(next - this._scaleNow) > 0.005) {
      this._scaleNow = next;
      this.resize();
    }
  }

  render(dtMs, now) {
    // Containers can collapse and return without emitting a resize event
    // (hidden tabs, docked panes), so verify rather than trust the listener.
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (cw !== this._lastW || ch !== this._lastH) {
      this._lastW = cw; this._lastH = ch;
      this.resize();
    }
    if (!this.viewportOk) return;   // nothing to draw into yet

    this._govern(dtMs, now);
    this.composer.render();
  }

  /** Anisotropy tuned to the current quality tier. */
  prepTexture(tex, srgb = true) {
    if (!tex) return tex;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(this.quality.aniso, this.maxAniso);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }
}
