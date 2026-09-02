import * as THREE from 'three';
import { KM, AU, SUN_RADIUS, PLANETS, DWARFS } from '../core/constants.js';

/**
 * The real solar system, on real orbits.
 *
 * Positions come from the JPL Keplerian element set for 1800-2050, solved each
 * frame with Newton iteration on Kepler's equation. Set the clock to today and
 * the planets are where they actually are; the alignment you fly through is
 * the real one.
 *
 * Two deliberate departures from physical truth, both for legibility:
 *   - Sunlight falloff is compressed (pow 0.35 instead of inverse-square).
 *     True 1/r^2 leaves Neptune at 1/900 of Earth's illumination, which is
 *     black on any consumer display.
 *   - Time runs faster than 1x by default, or nothing appears to move.
 * Body radii, orbital geometry and rotation rates are all exact.
 */

const DEG = Math.PI / 180;

function solveKepler(M, e) {
  // Newton-Raphson. Five iterations is plenty below e = 0.25; every planet
  // here is well under that (Mercury is worst at 0.206).
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let i = 0; i < 6; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

/** Heliocentric ecliptic position, in world units, Y-up. */
export function orbitalPosition(p, centuriesSinceJ2000, out = new THREE.Vector3()) {
  const T = centuriesSinceJ2000;
  const a = p.a;
  const e = p.e;
  const i = p.i * DEG;
  const O = p.O * DEG;
  const wBar = p.w * DEG;
  const L = (p.L + p.dL * T) * DEG;

  const w = wBar - O;                 // argument of perihelion
  let M = L - wBar;
  M = ((M % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;

  const E = solveKepler(M, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

  const cw = Math.cos(w), sw = Math.sin(w);
  const cO = Math.cos(O), sO = Math.sin(O);
  const ci = Math.cos(i), si = Math.sin(i);

  const xe = xp * (cw * cO - sw * sO * ci) + yp * (-sw * cO - cw * sO * ci);
  const ye = xp * (cw * sO + sw * cO * ci) + yp * (-sw * sO + cw * cO * ci);
  const ze = xp * (sw * si) + yp * (cw * si);

  // Ecliptic (Z north) -> Three.js (Y up)
  return out.set(xe * AU, ze * AU, -ye * AU);
}

// ---------------------------------------------------------------------------

class TextureStore {
  constructor(engine) {
    this.engine = engine;
    this.loader = new THREE.TextureLoader();
    this.cache = new Map();
  }
  /** Tries `level` and walks down until something loads. */
  async get(name, level, srgb = true) {
    const order = ['8k', '4k', '2k'];
    const start = order.indexOf(level);
    for (let i = Math.max(0, start); i < order.length; i++) {
      const url = `tex/${order[i]}_${name}.${name.includes('ring') ? 'png' : 'jpg'}`;
      if (this.cache.has(url)) return this.cache.get(url);
      try {
        const t = await this.loader.loadAsync(url);
        this.engine.prepTexture(t, srgb);
        this.cache.set(url, t);
        return t;
      } catch { /* try the next level down */ }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------

class Body {
  constructor(def, sys, parent = null) {
    this.def = def;
    this.sys = sys;
    this.parent = parent;
    this.name = def.name;
    this.key = def.key;
    this.radius = def.r * KM;
    this.blurb = def.blurb || '';

    this.group = new THREE.Group();
    this.pivot = new THREE.Group();     // holds axial tilt
    this.group.add(this.pivot);

    this.worldPos = new THREE.Vector3();
    this.prevWorldPos = new THREE.Vector3();
    this.frameDelta = new THREE.Vector3(); // how far it moved this frame
    this._lod = null;
    this._lodBusy = false;
    this._hasPrev = false;

    const seg = def.r > 20000 ? 96 : 64;
    const geo = new THREE.SphereGeometry(this.radius, seg, seg / 2);

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 0.0,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = def.name;
    this.pivot.add(this.mesh);
    this.pivot.rotation.z = (def.tilt || 0) * DEG;

    // Solar irradiance, compressed so the outer system stays legible.
    const aAU = def.a || (parent ? parent.def.a : 1);
    const lit = Math.pow(1 / Math.max(0.05, aAU * aAU), 0.35);
    this.material.color.setScalar(Math.min(1, 0.22 + lit * 0.9));

    if (def.atmosphere) this._addAtmosphere(def.atmosphere);
    if (def.ring) this._addRing(def.ring);

    this.moons = (def.moons || []).map((m) => {
      const b = new Body({ ...m, a: aAU }, sys, this);
      b.orbitDist = m.dist * KM;
      b.orbitPeriod = m.period; // hours
      this.group.add(b.group);
      return b;
    });
  }

  _addAtmosphere(cfg) {
    // Backside fresnel shell. Cheap, and it is what separates a textured ball
    // from a planet with air on it.
    const geo = new THREE.SphereGeometry(this.radius * 1.026, 64, 32);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(cfg.color) },
        uPower: { value: cfg.power },
        uStrength: { value: cfg.strength },
        uSun: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vW;
        void main(){
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position,1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uPower; uniform float uStrength; uniform vec3 uSun;
        varying vec3 vN; varying vec3 vW;
        void main(){
          vec3 V = normalize(cameraPosition - vW);
          float rim = pow(1.0 - abs(dot(V, normalize(vN))), uPower);
          float lit = clamp(dot(normalize(vN), normalize(uSun - vW)) * 1.4 + 0.28, 0.0, 1.0);
          gl_FragColor = vec4(uColor * rim * uStrength * lit, rim * lit);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.atmosphere = new THREE.Mesh(geo, mat);
    this.pivot.add(this.atmosphere);
  }

  _addRing(cfg) {
    const inner = cfg.inner * KM;
    const outer = cfg.outer * KM;
    const geo = new THREE.RingGeometry(inner, outer, 256, 1);

    // RingGeometry's default UVs are useless for a radial strip texture, so
    // remap u to normalised radius and v to a constant.
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const v3 = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v3.fromBufferAttribute(pos, i);
      const t = (v3.length() - inner) / (outer - inner);
      uv.setXY(i, t, 0.5);
    }
    uv.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({
      color: cfg.faint ? 0x8899aa : 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: cfg.faint ? 0.28 : 0.92,
      depthWrite: false,
    });
    this.ringMesh = new THREE.Mesh(geo, mat);
    this.ringMesh.rotation.x = Math.PI / 2;
    this.ringMesh.renderOrder = 2;
    this.pivot.add(this.ringMesh);
  }

  async loadTextures(level = '2k') {
    const t = this.def.tex;
    if (!t) return;
    const S = this.sys.textures;

    if (t.map) this.material.map = await S.get(t.map, level);
    if (t.normal) {
      this.material.normalMap = await S.get(t.normal, '2k', false);
      if (this.material.normalMap) this.material.normalScale = new THREE.Vector2(0.85, 0.85);
    }
    if (t.spec) {
      const s = await S.get(t.spec, level, false);
      if (s) { this.material.roughnessMap = s; this.material.roughness = 0.92; this.material.metalness = 0.05; }
    }
    if (t.night) this._night = await S.get(t.night, level);
    if (t.clouds) await this._addClouds(t.clouds, level);
    if (t.ring && this.ringMesh) {
      const r = await S.get(t.ring, level);
      if (r) {
        r.wrapS = THREE.ClampToEdgeWrapping;
        this.ringMesh.material.map = r;
        this.ringMesh.material.alphaMap = r;
        this.ringMesh.material.needsUpdate = true;
      }
    }
    if (this._night) this._injectNightSide();
    this.material.needsUpdate = true;
    this._lod = level;

    // Moons are built in the constructor but are not in SolarSystem's top
    // level list, so nothing else would ever texture them.
    for (const m of this.moons) {
      if (!m._lod) await m.loadTextures(level);
    }
  }

  /** City lights on the dark hemisphere, blended across the terminator. */
  _injectNightSide() {
    const sunUniform = { value: new THREE.Vector3() };
    this._sunUniform = sunUniform;
    const nightMap = { value: this._night };

    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uSunPos = sunUniform;
      shader.uniforms.uNightMap = nightMap;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
           vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
           vWNrm = normalize(mat3(modelMatrix) * objectNormal);`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform vec3 uSunPos;
           uniform sampler2D uNightMap;
           varying vec3 vWPos;
           varying vec3 vWNrm;
           float gNight;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           gNight = smoothstep(0.10, -0.16, dot(normalize(vWNrm), normalize(uSunPos - vWPos)));`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           totalEmissiveRadiance += texture2D(uNightMap, vMapUv).rgb * gNight * 1.9;`,
        );
    };
    this.material.needsUpdate = true;
  }

  async _addClouds(name, level) {
    const tex = await this.sys.textures.get(name, level);
    if (!tex) return;
    const geo = new THREE.SphereGeometry(this.radius * 1.012, 64, 32);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, alphaMap: tex, transparent: true,
      opacity: this.def.cloudOpacity ?? 0.6,
      depthWrite: false, roughness: 1, metalness: 0,
      color: this.material.color,
    });
    this.clouds = new THREE.Mesh(geo, mat);
    this.pivot.add(this.clouds);
  }

  update(days, sunPos) {
    // Sidereal rotation. def.rot is in hours; negative means retrograde.
    if (this.def.rot) {
      this.mesh.rotation.y = ((days * 24) / this.def.rot) * Math.PI * 2;
    }
    if (this.clouds) {
      this.clouds.rotation.y = this.mesh.rotation.y + days * (this.def.cloudSpeed || 0) * 1000;
    }
    if (this.orbitPeriod) {
      const a = ((days * 24) / this.orbitPeriod) * Math.PI * 2;
      this.group.position.set(Math.cos(a) * this.orbitDist, 0, Math.sin(a) * this.orbitDist);
    }
    this.prevWorldPos.copy(this.worldPos);
    this.mesh.getWorldPosition(this.worldPos);
    if (this._hasPrev) this.frameDelta.subVectors(this.worldPos, this.prevWorldPos);
    else { this.frameDelta.set(0, 0, 0); this._hasPrev = true; }

    if (this._sunUniform) this._sunUniform.value.copy(sunPos);
    if (this.atmosphere) this.atmosphere.material.uniforms.uSun.value.copy(sunPos);
    for (const m of this.moons) m.update(days, sunPos);
  }

  /** Pull in a sharper texture set once the body fills enough of the screen. */
  async considerLOD(camPos) {
    if (this._lodBusy) return;
    const d = this.worldPos.distanceTo(camPos);
    const radii = d / this.radius;
    const want = radii < 12 ? '8k' : radii < 90 ? '4k' : '2k';
    const rank = { '2k': 0, '4k': 1, '8k': 2 };
    for (const m of this.moons) m.considerLOD(camPos);
    if (rank[want] <= rank[this._lod || '2k']) return;
    this._lodBusy = true;
    try { await this.loadTextures(want); } finally { this._lodBusy = false; }
  }
}

// ---------------------------------------------------------------------------

export class SolarSystem {
  constructor(engine) {
    this.engine = engine;
    this.group = new THREE.Group();
    this.textures = new TextureStore(engine);
    this.bodies = [];
    this.epoch = Date.now();
    this.timeScale = 40000; // sim-seconds per real second
    this.simMs = 0;
  }

  async load(onProgress) {
    // Sun: emissive sphere. It is the only light source in the scene.
    const sunTex = await this.textures.get('sun', '2k');
    this.sun = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_RADIUS, 96, 48),
      new THREE.MeshBasicMaterial({ map: sunTex, color: 0xffffff, toneMapped: false }),
    );
    this.sun.name = 'Sun';
    this.group.add(this.sun);

    // decay 0 because true inverse-square across 30 AU cannot be represented
    // in a single exposure; per-body irradiance is applied in Body instead.
    this.light = new THREE.PointLight(0xfff4e8, 3.1, 0, 0);
    this.group.add(this.light);
    this.group.add(new THREE.AmbientLight(0x2a3242, 0.16));

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(), color: 0xffd9a0, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    glow.scale.setScalar(SUN_RADIUS * 9);
    this.sun.add(glow);

    const all = [...PLANETS];
    for (let i = 0; i < all.length; i++) {
      const b = new Body(all[i], this);
      await b.loadTextures('2k');
      this.bodies.push(b);
      this.group.add(b.group);
      onProgress?.((i + 1) / (all.length + DWARFS.length));
    }

    for (let i = 0; i < DWARFS.length; i++) {
      const d = DWARFS[i];
      const b = new Body({
        key: d.key, name: d.name, a: d.a, e: 0, i: 0, O: 0, w: 0,
        L: (i * 71) % 360, dL: 36000 / d.period,
        r: d.r, rot: 8 + i * 3, tilt: 5,
        tex: { map: d.tex }, blurb: d.blurb,
      }, this);
      await b.loadTextures('2k');
      this.bodies.push(b);
      this.group.add(b.group);
      onProgress?.((PLANETS.length + i + 1) / (PLANETS.length + DWARFS.length));
    }

    this._addOrbitLines();
    return this;
  }

  _addOrbitLines() {
    this.orbits = new THREE.Group();
    const tmp = new THREE.Vector3();
    for (const b of this.bodies) {
      const d = b.def;
      if (!d.dL) continue;
      const pts = [];
      // dL is degrees per century, so one full revolution takes 360/dL
      // centuries. Sweeping any further just redraws the same ellipse.
      const centuriesPerRev = 360 / d.dL;
      for (let k = 0; k <= 512; k++) {
        orbitalPosition(d, (k / 512) * centuriesPerRev, tmp);
        pts.push(tmp.clone());
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: 0x4a6a8a, transparent: true, opacity: 0.07, depthWrite: false,
      });
      this.orbits.add(new THREE.Line(geo, mat));
    }
    this.orbits.visible = false;
    this.group.add(this.orbits);
  }

  setOrbitLines(v) { if (this.orbits) this.orbits.visible = v; }

  update(dtSec, camPos) {
    this.simMs += dtSec * 1000 * this.timeScale;
    const now = this.epoch + this.simMs;
    const T = (now - Date.UTC(2000, 0, 1, 12)) / (86400000 * 36525);
    const days = (now - Date.UTC(2000, 0, 1, 12)) / 86400000;

    const sunPos = this.sun.position;
    for (const b of this.bodies) {
      if (b.def.dL) orbitalPosition(b.def, T, b.group.position);
      b.update(days, sunPos);
    }
    this._lodTick = (this._lodTick || 0) + 1;
    if (this._lodTick % 30 === 0) for (const b of this.bodies) b.considerLOD(camPos);
  }

  /** Simulation date, for the HUD. */
  get date() { return new Date(this.epoch + this.simMs); }

  /**
   * How much of a body's orbital motion the camera should inherit.
   *
   * Without this, accelerating time throws you off any planet you are near:
   * Earth covers 2.6 million km a day, so at 20,000x it leaves the frame in
   * seconds while you sit still in heliocentric space. Real space sims solve
   * it the same way - inside a body's sphere of influence you ride along with
   * it; far outside, you stay in the Sun's frame. The blend between the two
   * is smooth so there is no snap at the boundary.
   */
  frameLockDelta(camPos, out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    let best = null, bestW = 0;

    const consider = (b) => {
      const d = b.worldPos.distanceTo(camPos);
      const radii = d / b.radius;
      // Full lock inside 60 radii, released by 600.
      const w = 1 - THREE.MathUtils.smoothstep(radii, 60, 600);
      if (w > bestW) { bestW = w; best = b; }
      for (const m of b.moons) consider(m);
    };
    for (const b of this.bodies) consider(b);

    if (best && bestW > 0) out.copy(best.frameDelta).multiplyScalar(bestW);
    this.frameAnchor = bestW > 0.02 ? best : null;
    this.frameAnchorWeight = bestW;
    return out;
  }

  /** Nearest body and its surface distance, for the approach readout. */
  nearest(camPos) {
    let best = null, bestD = Infinity;
    const check = (b) => {
      const d = b.worldPos.distanceTo(camPos) - b.radius;
      if (d < bestD) { bestD = d; best = b; }
      for (const m of b.moons) check(m);
    };
    for (const b of this.bodies) check(b);
    const sd = camPos.length() - SUN_RADIUS;
    if (sd < bestD) return { body: { name: 'The Sun', blurb: 'Four billion years in, halfway through.', radius: SUN_RADIUS, worldPos: new THREE.Vector3() }, dist: sd };
    return { body: best, dist: bestD };
  }
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0.0, 'rgba(255,244,224,1)');
  grd.addColorStop(0.12, 'rgba(255,226,170,0.55)');
  grd.addColorStop(0.35, 'rgba(255,190,120,0.14)');
  grd.addColorStop(1.0, 'rgba(255,170,90,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
