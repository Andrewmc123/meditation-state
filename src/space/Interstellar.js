import * as THREE from 'three';

/**
 * Interstellar mode: the real stellar neighbourhood, at 1 unit = 1 parsec.
 *
 * The solar system runs at 1 unit = 1000 km. The nearest star is 4.0e10 of
 * those units, so interstellar travel cannot share that scale - this is a
 * separate scene with its own camera, the same way surfaces are.
 *
 * Stars use their TRUE three-dimensional catalogue positions here, not the
 * projected-to-a-sphere version the solar system view uses. That difference is
 * the whole point of the mode: fly a few parsecs and the constellations pull
 * apart, because you are seeing them from somewhere else. Orion only looks
 * like Orion from within about a light-year of home.
 *
 * Host stars of confirmed exoplanets are marked. Arriving at one builds its
 * planets from the archive's real orbital and physical parameters.
 */

const PC = 1;                       // world unit
const LY_PER_PC = 3.26156;

/**
 * Known black holes, and Sagittarius A* at the galactic centre.
 * Distances in parsecs; ra in hours, dec in degrees.
 */
const BLACK_HOLES = [
  { name: 'Sagittarius A*', pc: 8178, ra: 17.761, dec: -29.008, solarMass: 4.297e6,
    blurb: 'Four million suns at the centre of the galaxy. Everything here orbits it.' },
  { name: 'Cygnus X-1', pc: 2220, ra: 19.972, dec: 35.202, solarMass: 21.2,
    blurb: 'The first object widely accepted as a black hole. Feeding on a blue supergiant.' },
  { name: 'V404 Cygni', pc: 2390, ra: 20.409, dec: 33.867, solarMass: 9.0,
    blurb: 'Quiet for decades, then it erupts. Last outburst 2015.' },
  { name: 'Gaia BH1', pc: 480, ra: 17.472, dec: -0.581, solarMass: 9.62,
    blurb: 'The closest known black hole. Dormant, found by how it tugs its companion.' },
];

/** Nearby galaxies. Distances in parsecs. */
const GALAXIES = [
  { name: 'Large Magellanic Cloud', pc: 49970, ra: 5.393, dec: -69.756,
    size: 4300, tilt: 0.5, arms: 1, color: 0x9fb8e8,
    blurb: 'A satellite of our own galaxy. Visible to the naked eye from the south.' },
  { name: 'Small Magellanic Cloud', pc: 62440, ra: 0.877, dec: -72.829,
    size: 3200, tilt: 0.9, arms: 1, color: 0xa8bce0,
    blurb: 'Being torn apart by the Milky Way, slowly.' },
  { name: 'Andromeda', pc: 765000, ra: 0.712, dec: 41.269,
    size: 34000, tilt: 1.28, arms: 2, color: 0xe8d9c0,
    blurb: 'A trillion stars, approaching at 110 km/s. It arrives in four billion years.' },
  { name: 'Triangulum', pc: 840000, ra: 1.564, dec: 30.660,
    size: 18000, tilt: 0.6, arms: 3, color: 0xcfd8e8,
    blurb: 'The third galaxy of the Local Group, and the furthest thing most eyes can see.' },
];

// ---------------------------------------------------------------------------

/**
 * Blackbody colour from effective temperature, 1000-40000 K.
 * Tanner Helland's piecewise fit to the Planck locus - accurate enough that an
 * M dwarf comes out orange, the Sun near-white and an O star blue-white.
 */
export function blackbody(kelvin, out = new THREE.Color()) {
  const t = THREE.MathUtils.clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;

  if (t <= 66) r = 255;
  else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);

  if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
  else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);

  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  return out.setRGB(
    THREE.MathUtils.clamp(r, 0, 255) / 255,
    THREE.MathUtils.clamp(g, 0, 255) / 255,
    THREE.MathUtils.clamp(b, 0, 255) / 255,
    THREE.SRGBColorSpace,
  );
}

/** RA (hours) + Dec (deg) + distance -> cartesian, Y-up, matching Starfield. */
function radecToVec(raHours, decDeg, dist, out = new THREE.Vector3()) {
  const ra = (raHours / 24) * Math.PI * 2;
  const dec = decDeg * Math.PI / 180;
  const x = Math.cos(dec) * Math.cos(ra) * dist;
  const y = Math.cos(dec) * Math.sin(ra) * dist;
  const z = Math.sin(dec) * dist;
  return out.set(x, z, -y);   // catalogue Z-up -> three.js Y-up
}

// ---------------------------------------------------------------------------

export class Interstellar {
  constructor(engine) {
    this.engine = engine;
    this.active = false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.0005, 4e7);
    this.systems = [];
    this.blackHoles = [];
    this.galaxies = [];
    this._t = 0;
    this.target = null;
  }

  async load(starfield) {
    // ---- real 3D stars ------------------------------------------------
    // Starfield keeps direction and distance separately, so the true position
    // is simply direction * distance. Reconstructing it here avoids loading
    // and parsing the 3.3 MB binary a second time.
    const src = starfield.points.geometry;
    const sp = src.attributes.position;
    const sd = src.attributes.aDist;
    const sc = src.attributes.aColor;
    const sm = src.attributes.aMag;
    const n = sp.count;

    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const abs = new Float32Array(n);
    const SKY = 4.0e7;   // the radius Starfield projects onto

    for (let i = 0; i < n; i++) {
      const d = sd.getX(i) || 0.001;
      pos[i * 3]     = (sp.getX(i) / SKY) * d;
      pos[i * 3 + 1] = (sp.getY(i) / SKY) * d;
      pos[i * 3 + 2] = (sp.getZ(i) / SKY) * d;
      col[i * 3] = sc.getX(i); col[i * 3 + 1] = sc.getY(i); col[i * 3 + 2] = sc.getZ(i);
      // Absolute magnitude: how bright the star actually is, rather than how
      // bright it looks from Earth. Once you can fly away from Earth, apparent
      // magnitude is meaningless.
      abs[i] = sm.getX(i) - 5 * (Math.log10(Math.max(d, 0.01)) - 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aAbsMag', new THREE.BufferAttribute(abs, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.starUniforms = {
      uPixelScale: { value: 1 },
      uExposure: { value: 1 },
    };

    this.stars = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: this.starUniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aAbsMag;
        uniform float uPixelScale;
        uniform float uExposure;
        varying vec3 vColor;
        varying float vBright;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = max(-mv.z, 0.001);
          // Apparent magnitude from absolute magnitude and current distance:
          // m = M + 5(log10(d) - 1). This is why stars brighten as you approach.
          float m = aAbsMag + 5.0 * (log(d) / 2.302585 - 1.0);
          float flux = pow(10.0, -0.4 * (m - 6.0));
          float radius = 0.9 + 2.2 * pow(clamp(flux, 0.0, 900.0), 0.20);
          gl_PointSize = radius * uPixelScale;
          vBright = clamp(flux * uExposure * 0.014, 0.02, 22.0);
          vColor = aColor;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor; varying float vBright;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          float core = exp(-r2 * 32.0);
          float halo = exp(-r2 * 5.5) * 0.34;
          float a = core + halo;
          vec3 c = mix(vColor, vec3(1.0), clamp(vBright * 0.05, 0.0, 0.75) * core);
          gl_FragColor = vec4(c * vBright * a, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // ---- Sol, so you can find your way home ----------------------------
    this.sol = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff4e0, toneMapped: false }),
    );
    this.sol.name = 'Sol';
    this.scene.add(this.sol);

    await this._loadExoplanets();
    this._buildBlackHoles();
    this._buildGalaxies();

    return this;
  }

  // -------------------------------------------------------------------

  async _loadExoplanets() {
    let rows = [];
    try {
      const res = await fetch('data/exoplanets.json');
      rows = await res.json();
    } catch {
      return;   // the mode still works as a star map without them
    }

    // The archive lists one row per planet; group them into systems.
    const byHost = new Map();
    for (const r of rows) {
      if (!r.hostname || r.sy_dist == null || r.ra == null || r.dec == null) continue;
      let sys = byHost.get(r.hostname);
      if (!sys) {
        sys = {
          name: r.hostname,
          pc: r.sy_dist,
          // The archive gives RA in degrees; radecToVec wants hours.
          ra: r.ra / 15,
          dec: r.dec,
          teff: r.st_teff || 5000,
          srad: r.st_rad || 1,
          smass: r.st_mass || 1,
          planets: [],
          pos: new THREE.Vector3(),
        };
        radecToVec(sys.ra, sys.dec, sys.pc, sys.pos);
        byHost.set(r.hostname, sys);
      }
      sys.planets.push({
        name: r.pl_name,
        radiusEarth: r.pl_rade || 1,
        massEarth: r.pl_bmasse || null,
        periodDays: r.pl_orbper || null,
        semiMajorAU: r.pl_orbsmax || null,
        eqTemp: r.pl_eqt || null,
        method: r.discoverymethod,
        year: r.disc_year,
      });
    }

    this.systems = [...byHost.values()].sort((a, b) => a.pc - b.pc);

    // Mark every host with a ring so they read as destinations rather than
    // getting lost among 119,000 background stars.
    const N = this.systems.length;
    const mpos = new Float32Array(N * 3);
    const mcol = new Float32Array(N * 3);
    const c = new THREE.Color();
    this.systems.forEach((s, i) => {
      mpos[i * 3] = s.pos.x; mpos[i * 3 + 1] = s.pos.y; mpos[i * 3 + 2] = s.pos.z;
      blackbody(s.teff, c);
      mcol[i * 3] = c.r; mcol[i * 3 + 1] = c.g; mcol[i * 3 + 2] = c.b;
    });

    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mpos, 3));
    mg.setAttribute('aColor', new THREE.BufferAttribute(mcol, 3));
    mg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.markerUniforms = { uPixelScale: { value: 1 }, uTime: { value: 0 } };
    this.markers = new THREE.Points(mg, new THREE.ShaderMaterial({
      uniforms: this.markerUniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        uniform float uPixelScale;
        varying vec3 vColor;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(340.0 / max(-mv.z, 0.4), 5.0, 26.0) * uPixelScale;
          vColor = aColor;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vColor;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          if (r > 0.5) discard;
          // Open ring, so it never hides the star it is marking.
          float ring = smoothstep(0.5, 0.42, r) * smoothstep(0.28, 0.36, r);
          float pulse = 0.62 + 0.38 * sin(uTime * 1.6);
          gl_FragColor = vec4(vColor + 0.35, ring * pulse * 0.95);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.markers.frustumCulled = false;
    this.scene.add(this.markers);
  }

  _buildBlackHoles() {
    for (const bh of BLACK_HOLES) {
      const g = new THREE.Group();
      radecToVec(bh.ra, bh.dec, bh.pc, g.position);

      // Scale the visual to the Schwarzschild radius, then exaggerate hugely:
      // Sgr A*'s event horizon is 0.08 AU, which is 4e-9 parsecs and would
      // never be more than a fraction of a pixel. This is a map marker with
      // the right shape, not a physically sized object.
      const r = Math.max(0.06, Math.log10(bh.solarMass) * 0.10);

      // Shadow: the horizon itself, pure black, occluding what is behind.
      const shadow = new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 16),
        new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }),
      );
      g.add(shadow);

      // Accretion disk with Doppler beaming - the side rotating toward you is
      // blueshifted and dramatically brighter. That asymmetry is the single
      // most recognisable feature of a real black hole image.
      const disk = new THREE.Mesh(
        new THREE.RingGeometry(r * 2.2, r * 7.0, 96, 1),
        new THREE.ShaderMaterial({
          uniforms: { uTime: { value: 0 }, uInner: { value: r * 2.2 }, uOuter: { value: r * 7.0 } },
          vertexShader: /* glsl */ `
            varying vec2 vUvR; varying vec3 vLocal;
            void main(){
              vLocal = position;
              vUvR = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: /* glsl */ `
            uniform float uTime, uInner, uOuter;
            varying vec3 vLocal;
            void main(){
              float rad = length(vLocal.xy);
              float t = clamp((rad - uInner) / (uOuter - uInner), 0.0, 1.0);
              float ang = atan(vLocal.y, vLocal.x);

              // Inner disk is hotter: white-blue in, orange-red out.
              vec3 hot  = vec3(1.0, 0.95, 0.88);
              vec3 warm = vec3(1.0, 0.52, 0.16);
              vec3 cool = vec3(0.55, 0.16, 0.05);
              vec3 c = mix(hot, warm, smoothstep(0.0, 0.45, t));
              c = mix(c, cool, smoothstep(0.45, 1.0, t));

              // Doppler beaming on the approaching limb.
              float beam = 0.42 + 1.58 * pow(max(sin(ang), 0.0), 1.4);

              // Turbulent banding, drifting faster on the inside.
              float band = 0.72 + 0.28 * sin(ang * 7.0 + uTime * (2.6 - t * 2.0) + t * 18.0);

              float edge = smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.72, t);
              gl_FragColor = vec4(c * beam * band * 1.5, edge * beam * 0.85);
            }`,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      disk.rotation.x = Math.PI / 2.35;   // tilted, so the disk reads as a disk
      g.add(disk);

      // Photon ring: light that orbited the hole before escaping.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r * 1.42, r * 1.62, 96),
        new THREE.MeshBasicMaterial({
          color: 0xffd9a0, transparent: true, opacity: 0.85,
          side: THREE.DoubleSide, depthWrite: false,
          blending: THREE.AdditiveBlending, toneMapped: false,
        }),
      );
      g.add(ring);

      this.scene.add(g);
      this.blackHoles.push({ ...bh, node: g, disk, ring, worldPos: g.position.clone(), radius: r });
    }
  }

  _buildGalaxies() {
    const tex = makeGalaxyTexture();
    for (const gx of GALAXIES) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: gx.color, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
        opacity: 0.9, toneMapped: false,
      }));
      radecToVec(gx.ra, gx.dec, gx.pc, s.position);
      s.scale.setScalar(gx.size);
      this.scene.add(s);
      this.galaxies.push({ ...gx, node: s, worldPos: s.position.clone(), radius: gx.size * 0.5 });
    }
  }

  // -------------------------------------------------------------------

  /** Nearest labelled thing, for the HUD. */
  nearest(camPos) {
    let best = null, bestD = Infinity;
    const consider = (name, pos, blurb, radius) => {
      const d = pos.distanceTo(camPos) - (radius || 0);
      if (d < bestD) { bestD = d; best = { name, blurb, pos }; }
    };
    consider('Sol', this.sol.position, 'Home. Everything you have visited so far.', 0.01);
    for (const b of this.blackHoles) consider(b.name, b.worldPos, b.blurb, b.radius);
    for (const g of this.galaxies) consider(g.name, g.worldPos, g.blurb, g.radius);
    // Only the closest handful of systems are worth testing every frame.
    for (let i = 0; i < Math.min(this.systems.length, 400); i++) {
      const s = this.systems[i];
      consider(s.name, s.pos,
        `${s.planets.length} planet${s.planets.length > 1 ? 's' : ''} · ${(s.teff).toFixed(0)} K · discovered ${s.planets[0].year || '?'}`, 0);
    }
    return { body: best, dist: bestD };
  }

  /** Closest exoplanet system to a point, for the "arrive" action. */
  nearestSystem(camPos) {
    let best = null, bestD = Infinity;
    for (const s of this.systems) {
      const d = s.pos.distanceTo(camPos);
      if (d < bestD) { bestD = d; best = s; }
    }
    return { system: best, dist: bestD };
  }

  update(dt, camPos, renderHeight) {
    this._t += dt;
    const px = Math.max(1, renderHeight / 1080);
    if (this.starUniforms) {
      this.starUniforms.uPixelScale.value = px;
    }
    if (this.markerUniforms) {
      this.markerUniforms.uPixelScale.value = px;
      this.markerUniforms.uTime.value = this._t;
    }
    for (const b of this.blackHoles) {
      b.disk.material.uniforms.uTime.value = this._t;
      b.node.lookAt(camPos);
      b.node.rotateX(Math.PI / 2.35);   // keep the disk tilted relative to view
    }
  }

  render(renderer, camera) {
    renderer.render(this.scene, camera);
  }

  /** Distance readout: parsecs below 1, light-years above. */
  static fmtDistance(pc) {
    if (pc < 0) return 'arrived';
    if (pc < 0.02) return (pc * 206265).toFixed(0) + ' AU';
    const ly = pc * LY_PER_PC;
    if (ly < 1000) return ly.toFixed(2) + ' ly';
    if (ly < 1e6) return (ly / 1000).toFixed(1) + 'k ly';
    return (ly / 1e6).toFixed(2) + 'M ly';
  }
}

// ---------------------------------------------------------------------------

function makeGalaxyTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0)';
  g.fillRect(0, 0, S, S);

  // Core
  const core = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.16);
  core.addColorStop(0, 'rgba(255,248,232,0.95)');
  core.addColorStop(0.5, 'rgba(255,226,180,0.45)');
  core.addColorStop(1, 'rgba(255,210,150,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, S, S);

  // Two logarithmic spiral arms, drawn as dotted star clouds rather than solid
  // lines - a galaxy is a density of points, not a stroke.
  g.globalCompositeOperation = 'lighter';
  for (let arm = 0; arm < 2; arm++) {
    for (let i = 0; i < 1400; i++) {
      const t = i / 1400;
      const a = t * 5.4 + arm * Math.PI;
      const rad = Math.pow(t, 0.62) * S * 0.46;
      const jitter = (Math.random() - 0.5) * rad * 0.20;
      const x = S / 2 + Math.cos(a) * rad + jitter;
      const y = S / 2 + Math.sin(a) * rad + jitter;
      const alpha = (1 - t) * 0.5 + 0.05;
      const size = Math.random() * 2.1 + 0.5;
      g.fillStyle = `rgba(${210 + Math.random() * 45 | 0},${215 + Math.random() * 40 | 0},255,${alpha.toFixed(3)})`;
      g.beginPath();
      g.arc(x, y, size, 0, 6.283);
      g.fill();
    }
  }

  // Overall falloff so the sprite has no hard square edge.
  g.globalCompositeOperation = 'destination-in';
  const fade = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.5);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(0.72, 'rgba(0,0,0,0.85)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fade;
  g.fillRect(0, 0, S, S);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export { BLACK_HOLES, GALAXIES, LY_PER_PC };
