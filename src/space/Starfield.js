import * as THREE from 'three';

/**
 * 119,626 real stars from the HYG catalogue (Hipparcos + Yale + Gliese),
 * plus the Milky Way band as a backdrop.
 *
 * Positions are the catalogue's true equatorial cartesian coordinates, so the
 * constellations are correct - find Orion and it is actually Orion. They are
 * projected onto a sphere at SKY_R because from anywhere inside the solar
 * system stellar parallax is far below a pixel; true distance is kept as an
 * attribute for the interstellar mode later.
 *
 * Brightness follows the real magnitude scale: flux goes as 10^(-0.4 m), so
 * Sirius at -1.46 lands roughly 100x brighter than a mag 4 star, which is what
 * makes the sky read as a sky instead of as scattered confetti.
 */

const SKY_R = 4.0e7; // inside the far plane, far outside anything you can fly to

const VERT = /* glsl */ `
  attribute float aMag;
  attribute vec3  aColor;

  uniform float uPixelScale;
  uniform float uExposure;
  uniform float uTwinkle;
  uniform float uTime;

  varying vec3  vColor;
  varying float vBright;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    // Real photometry: flux relative to a magnitude 6.0 naked-eye limit.
    float flux = pow(10.0, -0.4 * (aMag - 6.0));

    // Sub-pixel stars can't get dimmer than one pixel, so below a threshold
    // extra flux goes into brightness instead of radius. Same trick the eye
    // uses; without it faint stars vanish and bright ones become blobs.
    float radius = 0.85 + 1.55 * pow(clamp(flux, 0.0, 400.0), 0.21);

    float tw = 1.0 + uTwinkle * 0.22 * sin(uTime * 2.3 + aMag * 91.7 + position.x * 0.0001);

    gl_PointSize = radius * uPixelScale * tw;

    vBright = clamp(flux * uExposure * 0.012, 0.02, 14.0);
    vColor  = aColor;
  }
`;

const FRAG = /* glsl */ `
  varying vec3  vColor;
  varying float vBright;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;

    // Gaussian core plus a wider, weaker halo - an approximation of a real
    // point-spread function. The halo is what the bloom pass latches onto.
    float core = exp(-r2 * 34.0);
    float halo = exp(-r2 * 6.0) * 0.32;
    float a = core + halo;

    // Bright stars desaturate toward white at the centre, as they do to the eye.
    vec3 c = mix(vColor, vec3(1.0), clamp(vBright * 0.06, 0.0, 0.72) * core);

    gl_FragColor = vec4(c * vBright * a, a);
  }
`;

export class Starfield {
  constructor(engine) {
    this.engine = engine;
    this.group = new THREE.Group();
    this.group.renderOrder = -10;
    this.points = null;
    this.milkyway = null;
    this.named = [];
    this._t = 0;
  }

  async load(onProgress) {
    const [binRes, namedRes] = await Promise.all([
      fetch('data/stars.bin'),
      fetch('data/stars-named.json'),
    ]);
    if (!binRes.ok) throw new Error('stars.bin missing - run: node tools/build-catalog.mjs');

    const buf = await binRes.arrayBuffer();
    this.named = await namedRes.json();
    onProgress?.(0.6);

    const f = new Float32Array(buf);
    const n = f.length / 7; // x y z mag r g b

    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const mag = new Float32Array(n);
    const dist = new Float32Array(n);

    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      v.set(f[o], f[o + 1], f[o + 2]);
      dist[i] = v.length();
      v.normalize().multiplyScalar(SKY_R);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.z; pos[i * 3 + 2] = -v.y; // catalogue Z-up -> Y-up
      mag[i] = f[o + 3];
      col[i * 3] = f[o + 4]; col[i * 3 + 1] = f[o + 5]; col[i * 3 + 2] = f[o + 6];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    geo.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKY_R * 1.01);

    this.uniforms = {
      uPixelScale: { value: 1 },
      uExposure: { value: 1 },
      uTwinkle: { value: 0 },
      uTime: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.count = n;

    onProgress?.(0.85);
    await this._buildMilkyWay();
    onProgress?.(1);
    return this;
  }

  async _buildMilkyWay() {
    const loader = new THREE.TextureLoader();
    const tex = await loader.loadAsync('tex/4k_stars_milky_way.jpg').catch(() => null);
    if (!tex) return;
    this.engine.prepTexture(tex);

    const geo = new THREE.SphereGeometry(SKY_R * 0.98, 64, 32);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    });
    this.milkyway = new THREE.Mesh(geo, mat);
    this.milkyway.frustumCulled = false;
    this.milkyway.renderOrder = -11;
    // The catalogue is in equatorial coordinates; the panorama is galactic.
    this.milkyway.rotation.set(-Math.PI / 2, 0, -1.097);
    this.group.add(this.milkyway);
  }

  /** Keep the sky centred on the camera so it stays at infinity. */
  update(camera, dt, renderHeight) {
    this.group.position.copy(camera.position);
    this._t += dt;
    if (!this.uniforms) return;
    this.uniforms.uTime.value = this._t;
    // Point size is in device pixels, so it must track the render scale or
    // the sky gets denser every time the governor changes resolution.
    this.uniforms.uPixelScale.value = Math.max(1, renderHeight / 1080);
  }

  setExposure(v) { if (this.uniforms) this.uniforms.uExposure.value = v; }
  setMilkyWay(v) { if (this.milkyway) this.milkyway.material.opacity = v; }
}
