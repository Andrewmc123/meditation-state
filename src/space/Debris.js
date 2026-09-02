import * as THREE from 'three';
import { KM, AU } from '../core/constants.js';

/**
 * Asteroid belt, Kuiper belt, and the handful of spacecraft still out there.
 *
 * THE SCALE PROBLEM, AGAIN
 * ------------------------
 * A 10 km asteroid at 2.5 AU is about 0.01 world units seen from 300,000 -
 * many orders of magnitude below one pixel. Rendering the real belt as real
 * geometry gets you an empty screen, which is also what it genuinely looks
 * like: the belt is mostly vacuum, and the spacing between rocks averages
 * hundreds of thousands of kilometres.
 *
 * So the belt is drawn twice:
 *   - FAR: a wide point field with the real radial and inclination
 *     distribution, so from outside it reads as the faint band it is.
 *   - NEAR: real geometry, recycled in a shell that follows the camera, so
 *     once you are inside the belt there are actual rocks to fly past at
 *     honest sizes (1-40 km).
 *
 * Object SIZES are real throughout (1-40 km rocks). Near-field DENSITY is not:
 * see the note on NEAR_RADIUS below for the magnitude of that cheat and why it
 * is unavoidable.
 */

const BELT_INNER = 2.06;  // AU - inner edge, just past the 4:1 Kirkwood gap
const BELT_OUTER = 3.28;  // AU - outer edge near the 2:1 resonance
const KUIPER_INNER = 30;
const KUIPER_OUTER = 50;

/** Kirkwood gaps: orbital resonances with Jupiter that the belt is cleared from. */
const KIRKWOOD = [2.06, 2.5, 2.82, 2.95, 3.27];

/**
 * Deep-space craft. Distances are approximate for 2026 and grow slowly; each
 * is a real object on a real escape trajectory.
 */
const CRAFT = [
  { key: 'voyager1', name: 'Voyager 1', au: 167.4, ra: 17.2, dec: 12.4,
    blurb: 'Interstellar space since 2012. Still answering, 22 light-hours out.' },
  { key: 'voyager2', name: 'Voyager 2', au: 139.6, ra: 20.1, dec: -58.9,
    blurb: 'The only craft to have visited Uranus and Neptune.' },
  { key: 'pioneer10', name: 'Pioneer 10', au: 138.2, ra: 5.1, dec: 26.0,
    blurb: 'Silent since 2003. Carrying a plaque nobody will read.' },
  { key: 'newhorizons', name: 'New Horizons', au: 62.7, ra: 19.4, dec: -20.6,
    blurb: 'Passed Pluto in 2015 and kept going.' },
];

export class Debris {
  constructor(engine) {
    this.engine = engine;
    this.group = new THREE.Group();
    this.craft = [];
    this._rng = mulberry32(0x5EED);
    this._nearActive = false;
    this._camPrev = new THREE.Vector3();
  }

  async load() {
    this._buildFarBelt();
    this._buildKuiper();
    this._buildNearRocks();
    this._buildCraft();
    return this;
  }

  // ---------------------------------------------------------------------
  // Far field
  // ---------------------------------------------------------------------

  _buildFarBelt() {
    const N = 26000;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const siz = new Float32Array(N);
    const R = this._rng;
    const c = new THREE.Color();

    let n = 0;
    while (n < N) {
      // Radial distribution peaks near 2.7 AU; reject samples that land in a
      // Kirkwood gap so the resonance structure is actually visible.
      const a = BELT_INNER + R() * (BELT_OUTER - BELT_INNER);
      if (KIRKWOOD.some((g) => Math.abs(a - g) < 0.022 + R() * 0.012)) continue;

      const th = R() * Math.PI * 2;
      // Inclinations run to about 20 deg, concentrated near the ecliptic.
      const inc = (R() + R() + R() - 1.5) * 0.155;
      const rr = a * AU;

      pos[n * 3]     = Math.cos(th) * rr;
      pos[n * 3 + 1] = Math.sin(inc) * rr * 0.5;
      pos[n * 3 + 2] = Math.sin(th) * rr;

      // C-type (dark, carbonaceous) dominates the outer belt, S-type (stony,
      // brighter) the inner. Real compositional gradient.
      const stony = 1 - (a - BELT_INNER) / (BELT_OUTER - BELT_INNER);
      const tone = 0.30 + stony * 0.34 + R() * 0.14;
      c.setRGB(tone * 1.06, tone * 0.97, tone * 0.86);
      col[n * 3] = c.r; col[n * 3 + 1] = c.g; col[n * 3 + 2] = c.b;

      siz[n] = 0.55 + R() * R() * 2.4;
      n++;
    }

    this.beltPoints = this._makePointField(pos, col, siz, 0.9);
    this.group.add(this.beltPoints);
  }

  _buildKuiper() {
    const N = 9000;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const siz = new Float32Array(N);
    const R = this._rng;

    for (let i = 0; i < N; i++) {
      const a = KUIPER_INNER + R() * (KUIPER_OUTER - KUIPER_INNER);
      const th = R() * Math.PI * 2;
      const inc = (R() + R() - 1) * 0.30;   // thicker and colder than the belt
      const rr = a * AU;
      pos[i * 3]     = Math.cos(th) * rr;
      pos[i * 3 + 1] = Math.sin(inc) * rr * 0.45;
      pos[i * 3 + 2] = Math.sin(th) * rr;

      const tone = 0.24 + R() * 0.16;
      col[i * 3] = tone * 0.92; col[i * 3 + 1] = tone * 0.94; col[i * 3 + 2] = tone * 1.10;
      siz[i] = 0.5 + R() * R() * 2.0;
    }

    this.kuiperPoints = this._makePointField(pos, col, siz, 0.6);
    this.group.add(this.kuiperPoints);
  }

  _makePointField(pos, col, siz, brightness) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uPixelScale: { value: 1 },
        uBrightness: { value: brightness },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute vec3 aColor;
        uniform float uPixelScale;
        varying vec3 vColor;
        varying float vFade;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          // Perspective size, floored at one pixel: a rock cannot get smaller
          // than a pixel, it can only get fainter. Same trick as the stars.
          float px = aSize * 90000.0 / max(d, 1.0);
          gl_PointSize = clamp(px, 1.0, 9.0) * uPixelScale;
          vFade = clamp(px, 0.0, 1.0);
          vColor = aColor;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uBrightness;
        varying vec3 vColor;
        varying float vFade;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          float a = smoothstep(0.25, 0.02, r2);
          gl_FragColor = vec4(vColor * uBrightness, a * vFade * uBrightness);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    return p;
  }

  // ---------------------------------------------------------------------
  // Near field - real geometry that follows the camera
  // ---------------------------------------------------------------------

  _buildNearRocks() {
    this.NEAR_COUNT = 200;

    // 30 units = 30,000 km.
    //
    // DELIBERATE CHEAT, and a big one - stated plainly because the rest of this
    // project is not doing that. Do the arithmetic: a 40 km rock is 0.04 units,
    // so at 320,000 km it subtends 1.3e-4 rad, which is 0.13 of a pixel. To
    // read at all it has to be within a few thousand km. The real belt averages
    // something like a million km between neighbours, so an honest simulation
    // shows you an empty screen - you could fly across the whole belt for years
    // and never pass a rock. Movie asteroid fields are fiction.
    //
    // This shell packs 200 rocks into 30,000 km, which is denser than reality
    // by something on the order of 10^4. Sizes stay real; only spacing is a
    // lie. The far-field point band is the honest picture of the belt.
    this.NEAR_RADIUS = 30;

    // Four lumpy variants. An icosahedron at detail 1 is only 80 faces and
    // reads as a cut gem; detail 2 plus multi-octave displacement gives a
    // silhouette that actually looks eroded. 320 faces x 200 instances is
    // ~64k triangles, which is nothing.
    const geos = [];
    for (let v = 0; v < 4; v++) {
      const g = new THREE.IcosahedronGeometry(1, 2);
      const p = g.attributes.position;
      const R = mulberry32(1000 + v);

      // Random gradient field, sampled per vertex direction. Three octaves:
      // a big lopsided shape, medium lumps, then small craters and ridges.
      const grad = [];
      for (let i = 0; i < 24; i++) {
        grad.push(new THREE.Vector3(R() * 2 - 1, R() * 2 - 1, R() * 2 - 1).normalize());
      }
      const noise = (n, freq) => {
        let sum = 0;
        for (let i = 0; i < grad.length; i++) {
          sum += Math.sin(n.dot(grad[i]) * freq + i * 1.7);
        }
        return sum / grad.length;
      };

      // Per-SHAPE, not per-vertex. IcosahedronGeometry is non-indexed, so
      // every shared corner appears once per adjacent face; drawing a fresh
      // random number inside the loop gives those copies different positions
      // and rips the mesh into flying triangles. Displacement must be a pure
      // function of direction so duplicates land on the same point.
      const squash = 0.62 + R() * 0.30;

      const n = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        n.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
        const d = 1
          + noise(n, 1.3) * 0.34      // overall lopsidedness
          + noise(n, 3.1) * 0.16      // lumps
          + noise(n, 7.9) * 0.06;     // surface roughness
        p.setXYZ(i, n.x * d, n.y * d * squash, n.z * d);
      }
      p.needsUpdate = true;
      g.computeVertexNormals();
      geos.push(g);
    }

    this.nearMeshes = geos.map((g, i) => {
      const m = new THREE.InstancedMesh(
        g,
        new THREE.MeshStandardMaterial({
          // Real asteroids are charcoal: C-types sit around 0.05 albedo,
          // S-types near 0.15. The bright tan used before both overexposed
          // under the sun light and looked like sandstone. The spread across
          // variants keeps a cluster from reading as one object repeated.
          color: [0x4f4941, 0x3d3833, 0x5c5348, 0x332f2b][i],
          roughness: 0.98, metalness: 0.02, flatShading: true,
        }),
        Math.ceil(this.NEAR_COUNT / 4),
      );
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
      this.group.add(m);
      return m;
    });

    // Per-instance state, so rocks tumble and keep their size between frames.
    this._rocks = [];
    const R = this._rng;
    for (let i = 0; i < this.NEAR_COUNT; i++) {
      this._rocks.push({
        pos: new THREE.Vector3(),
        // 1 to 40 km. Real sizes - most of the belt is small.
        scale: (1 + R() * R() * 39) * KM,
        spin: new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(0.35),
        rot: new THREE.Euler(R() * 6.28, R() * 6.28, R() * 6.28),
        placed: false,
      });
    }
    this._dummy = new THREE.Object3D();
  }

  _scatterRock(rock, camPos, initial) {
    const R = this._rng;
    // Place on a sphere around the camera. On respawn, bias to the far side so
    // rocks appear behind you rather than popping in ahead.
    const u = R() * 2 - 1;
    const th = R() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const d = initial ? this.NEAR_RADIUS * Math.cbrt(R()) : this.NEAR_RADIUS * (0.86 + R() * 0.14);
    rock.pos.set(s * Math.cos(th), u * 0.35, s * Math.sin(th)).multiplyScalar(d).add(camPos);
    // Vary size per placement so the same instance is not always the same rock.
    rock.scale = (1 + R() * R() * 39) * 0.001;
    rock.placed = true;
  }

  // ---------------------------------------------------------------------
  // Spacecraft
  // ---------------------------------------------------------------------

  _buildCraft() {
    for (const c of CRAFT) {
      const g = new THREE.Group();

      // A dish, a bus and a boom. Not model-accurate, but it reads as a probe
      // at the only distance you will ever see it from.
      const dish = new THREE.Mesh(
        new THREE.SphereGeometry(1.9, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.42),
        new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide }),
      );
      dish.rotation.x = Math.PI;
      g.add(dish);

      const bus = new THREE.Mesh(
        new THREE.CylinderGeometry(0.75, 0.75, 0.6, 10),
        new THREE.MeshStandardMaterial({ color: 0xc9b489, roughness: 0.65, metalness: 0.5 }),
      );
      bus.position.y = -0.85;
      g.add(bus);

      const boom = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.055, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0x8d8d92, roughness: 0.8, metalness: 0.6 }),
      );
      boom.position.set(4, -1.0, 0);
      boom.rotation.z = Math.PI / 2;
      g.add(boom);

      // Beacon, so you can actually find it out there.
      const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: dot(), color: 0x9fe8ff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9,
      }));
      beacon.scale.setScalar(14);
      g.add(beacon);

      // RA/Dec -> direction, then out along it.
      const ra = (c.ra / 24) * Math.PI * 2;
      const dec = c.dec * Math.PI / 180;
      const r = c.au * AU;
      g.position.set(
        Math.cos(dec) * Math.cos(ra) * r,
        Math.sin(dec) * r,
        -Math.cos(dec) * Math.sin(ra) * r,
      );
      g.lookAt(0, 0, 0);   // antenna pointed home

      this.group.add(g);
      this.craft.push({
        name: c.name, blurb: c.blurb, node: g, beacon,
        worldPos: g.position.clone(), radius: 0.02, au: c.au,
      });
    }
  }

  // ---------------------------------------------------------------------

  update(camPos, dt, renderHeight, sunPos) {
    const px = Math.max(1, renderHeight / 1080);
    if (this.beltPoints) this.beltPoints.material.uniforms.uPixelScale.value = px;
    if (this.kuiperPoints) this.kuiperPoints.material.uniforms.uPixelScale.value = px;

    // Near rocks only exist while you are actually in the belt.
    const rAU = Math.hypot(camPos.x, camPos.z) / AU;
    const inBelt = rAU > BELT_INNER - 0.3 && rAU < BELT_OUTER + 0.3
                   && Math.abs(camPos.y) / AU < 0.5;

    if (inBelt !== this._nearActive) {
      this._nearActive = inBelt;
      for (const m of this.nearMeshes) m.visible = inBelt;
      if (inBelt) for (const r of this._rocks) this._scatterRock(r, camPos, true);
    }

    if (inBelt) this._updateNearRocks(camPos, dt);

    // Beacons pulse gently and stay a readable size at any distance.
    for (const c of this.craft) {
      const d = c.worldPos.distanceTo(camPos);
      c.beacon.scale.setScalar(THREE.MathUtils.clamp(d * 0.012, 6, 4200));
    }
  }

  _updateNearRocks(camPos, dt) {
    const per = Math.ceil(this.NEAR_COUNT / 4);
    const counts = [0, 0, 0, 0];
    const limit = this.NEAR_RADIUS * 1.06;

    for (let i = 0; i < this._rocks.length; i++) {
      const rock = this._rocks[i];
      if (!rock.placed || rock.pos.distanceTo(camPos) > limit) {
        this._scatterRock(rock, camPos, false);
      }
      rock.rot.x += rock.spin.x * dt;
      rock.rot.y += rock.spin.y * dt;
      rock.rot.z += rock.spin.z * dt;

      const slot = i & 3;
      if (counts[slot] >= per) continue;
      const d = this._dummy;
      d.position.copy(rock.pos);
      d.rotation.copy(rock.rot);
      d.scale.setScalar(rock.scale);
      d.updateMatrix();
      this.nearMeshes[slot].setMatrixAt(counts[slot]++, d.matrix);
    }

    for (let s = 0; s < 4; s++) {
      this.nearMeshes[s].count = counts[s];
      this.nearMeshes[s].instanceMatrix.needsUpdate = true;
    }
  }

  /** Nearest spacecraft, so the HUD can name it like a planet. */
  nearestCraft(camPos) {
    let best = null, bestD = Infinity;
    for (const c of this.craft) {
      const d = c.worldPos.distanceTo(camPos);
      if (d < bestD) { bestD = d; best = c; }
    }
    return { craft: best, dist: bestD };
  }

  setVisible(v) { this.group.visible = v; }
}

// ---------------------------------------------------------------------------

/** Deterministic PRNG, so the belt is identical every run. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dot() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(160,230,255,0.5)');
  grd.addColorStop(1, 'rgba(120,200,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
