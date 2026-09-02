import * as THREE from 'three';

/**
 * Procedural heightfield terrain, chunked with distance LOD.
 *
 * This scene is metres, not megametres. Space runs at 1 unit = 1000 km, which
 * is unusable for walking, so a surface world is a completely separate scene
 * at 1 unit = 1 m and the two never share a camera.
 *
 * The height function is plain JavaScript rather than a shader, because the
 * character controller has to sample the exact same surface it is standing on.
 * Displacing vertices on the GPU and raycasting the mesh on the CPU gives you
 * two subtly different surfaces and a character that sinks into hills.
 * One function, both consumers.
 */

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

function hash(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

/** Gradient (Perlin) noise, -1..1. */
function perlin(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;

  // Quintic fade: continuous second derivative, so lighting has no creases.
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);

  const g = (cx, cy, dx, dy) => {
    const a = hash(cx, cy, seed) * 6.28318530718;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };

  const n00 = g(ix, iy, fx, fy);
  const n10 = g(ix + 1, iy, fx - 1, fy);
  const n01 = g(ix, iy + 1, fx, fy - 1);
  const n11 = g(ix + 1, iy + 1, fx - 1, fy - 1);

  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  return nx0 + v * (nx1 - nx0);
}

// ---------------------------------------------------------------------------
// World presets
// ---------------------------------------------------------------------------

/**
 * Gravity values are real. Sky and terrain parameters are tuned by eye against
 * surface photography from each body.
 */
export const WORLDS = {
  earth: {
    name: 'Earth', key: 'earth',
    gravity: 9.807,
    amp: 62, freq: 0.0022, octaves: 6, ridge: 0.35, warp: 26,
    ground: 0x5c6b4a, rock: 0x6e6a60, peak: 0xa8a49a, low: 0x3f5138,
    sky: 0x86a8cc, horizon: 0xc9d6e0, fog: 0x9fb6cc, fogNear: 340, fogFar: 2100,
    sunColor: 0xfff2dc, sunIntensity: 3.0, ambient: 0x6d84a3, ambientI: 0.75,
    stones: 14, boulders: 150,
    blurb: 'Sea level. One gravity. The baseline your body was built for.',
  },
  mars: {
    name: 'Mars', key: 'mars',
    gravity: 3.721,
    amp: 96, freq: 0.0018, octaves: 6, ridge: 0.52, warp: 40,
    ground: 0x9c5636, rock: 0x7d4429, peak: 0xc98d63, low: 0x6d3a24,
    sky: 0xc08a63, horizon: 0xe0b493, fog: 0xc28c66, fogNear: 260, fogFar: 1700,
    sunColor: 0xffe3c4, sunIntensity: 1.9, ambient: 0xa06a48, ambientI: 0.7,
    stones: 11, boulders: 210,
    blurb: 'Two-fifths gravity. A day 39 minutes longer than the one you know.',
  },
  moon: {
    name: 'The Moon', key: 'moon',
    gravity: 1.625,
    amp: 78, freq: 0.0026, octaves: 5, ridge: 0.28, warp: 18,
    ground: 0x8a8781, rock: 0x6b6864, peak: 0xa9a6a0, low: 0x55534f,
    sky: 0x000000, horizon: 0x0a0a10, fog: 0x111114, fogNear: 3000, fogFar: 9000,
    sunColor: 0xffffff, sunIntensity: 3.6, ambient: 0x1a1c22, ambientI: 0.18,
    stones: 9, boulders: 260,
    blurb: 'A sixth of a gravity, and no air to carry sound. Nothing here erodes.',
  },
};

// ---------------------------------------------------------------------------

export class Terrain {
  constructor(world, seed = 1337) {
    this.w = world;
    this.seed = seed;
    this.group = new THREE.Group();

    this.CHUNK = 256;      // metres per chunk
    this.VIEW = 5;         // chunks out from the player (so 11x11 max)
    this._chunks = new Map();
    this._queue = [];
    this._material = this._buildMaterial();
  }

  // -------------------------------------------------------------------
  // The height function. Everything else depends on this being cheap.
  // -------------------------------------------------------------------

  height(x, z) {
    const w = this.w;
    const f = w.freq;

    // Domain warp: offset the sample point by another noise field. This is
    // what turns obviously-periodic hills into ridgelines and valleys that
    // look eroded rather than stamped.
    const wx = x + perlin(x * f * 0.5, z * f * 0.5, this.seed + 71) * w.warp;
    const wz = z + perlin(x * f * 0.5 + 5.2, z * f * 0.5 + 1.3, this.seed + 91) * w.warp;

    let sum = 0, amp = 1, fr = f, norm = 0;
    for (let o = 0; o < w.octaves; o++) {
      let n = perlin(wx * fr, wz * fr, this.seed + o * 17);

      // Ridged octaves: fold the noise around zero and invert. Produces sharp
      // crests instead of rolling blobs.
      if (o < 3 && w.ridge > 0) {
        const r = 1 - Math.abs(n);
        n = n * (1 - w.ridge) + (r * r * 2 - 1) * w.ridge;
      }

      sum += n * amp;
      norm += amp;
      amp *= 0.5;
      fr *= 2.03;   // not exactly 2, to avoid octaves aligning into grid artefacts
    }

    return (sum / norm) * w.amp;
  }

  /** Analytic-ish normal by central difference. */
  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 1.2;
    const hL = this.height(x - e, z), hR = this.height(x + e, z);
    const hD = this.height(x, z - e), hU = this.height(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  /** Steepness 0..1, used for both texturing and whether you can stand. */
  slopeAt(x, z) {
    const n = this.normalAt(x, z, this._tmpN || (this._tmpN = new THREE.Vector3()));
    return 1 - n.y;
  }

  // -------------------------------------------------------------------

  _buildMaterial() {
    const w = this.w;
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.97,
      metalness: 0.0,
    });

    // Cheap triplanar-ish detail: break up the flat shading with a fine noise
    // derived from world position. Costs nothing and stops close ground from
    // looking like painted cardboard.
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPosT;')
        .replace('#include <project_vertex>',
          '#include <project_vertex>\nvWPosT = (modelMatrix * vec4(transformed,1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPosT;
          float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float vnoise(vec2 p){
            vec2 i = floor(p), f = fract(p);
            f = f*f*(3.0-2.0*f);
            return mix(mix(h21(i), h21(i+vec2(1,0)), f.x),
                       mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y);
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float g = vnoise(vWPosT.xz * 0.9) * 0.5 + vnoise(vWPosT.xz * 4.1) * 0.3
                  + vnoise(vWPosT.xz * 17.0) * 0.2;
          diffuseColor.rgb *= 0.80 + g * 0.40;`);
    };
    return mat;
  }

  // -------------------------------------------------------------------

  _chunkKey(cx, cz, lod) { return `${cx},${cz},${lod}`; }

  /** Segments per chunk edge for a given ring distance. */
  _lodFor(dist) {
    if (dist <= 1) return 64;
    if (dist <= 2) return 32;
    if (dist <= 3) return 16;
    return 8;
  }

  _buildChunk(cx, cz, segs) {
    const S = this.CHUNK;
    const geo = new THREE.PlaneGeometry(S, S, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const ox = cx * S, oz = cz * S;

    const w = this.w;
    const cLow = new THREE.Color(w.low);
    const cGround = new THREE.Color(w.ground);
    const cRock = new THREE.Color(w.rock);
    const cPeak = new THREE.Color(w.peak);
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + ox;
      const z = pos.getZ(i) + oz;
      const h = this.height(x, z);
      pos.setY(i, h);

      // Colour by altitude, then override with rock on steep faces. Same rule
      // real landscapes follow: nothing accumulates on a cliff.
      const t = THREE.MathUtils.clamp((h / w.amp) * 0.5 + 0.5, 0, 1);
      if (t < 0.42) c.copy(cLow).lerp(cGround, t / 0.42);
      else c.copy(cGround).lerp(cPeak, (t - 0.42) / 0.58);

      const slope = this.slopeAt(x, z);
      c.lerp(cRock, THREE.MathUtils.clamp((slope - 0.10) * 3.4, 0, 0.9));

      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, this._material);
    mesh.position.set(ox, 0, oz);
    mesh.frustumCulled = true;
    return mesh;
  }

  /**
   * Keep the chunk set centred on the player. Builds at most `budget` chunks
   * per call so walking never drops a frame to terrain generation.
   */
  update(px, pz, budget = 1) {
    const S = this.CHUNK;
    const pcx = Math.round(px / S), pcz = Math.round(pz / S);
    const wanted = new Set();

    for (let dz = -this.VIEW; dz <= this.VIEW; dz++) {
      for (let dx = -this.VIEW; dx <= this.VIEW; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        if (dx * dx + dz * dz > (this.VIEW + 0.5) * (this.VIEW + 0.5)) continue;
        const cx = pcx + dx, cz = pcz + dz;
        const key = this._chunkKey(cx, cz, this._lodFor(dist));
        wanted.add(key);
        if (!this._chunks.has(key)) {
          this._queue.push({ cx, cz, segs: this._lodFor(dist), key, dist });
        }
      }
    }

    // Nearest first, so what you are about to walk onto exists.
    this._queue.sort((a, b) => a.dist - b.dist);

    let built = 0;
    while (this._queue.length && built < budget) {
      const j = this._queue.shift();
      if (this._chunks.has(j.key)) continue;
      const m = this._buildChunk(j.cx, j.cz, j.segs);
      this._chunks.set(j.key, m);
      this.group.add(m);
      built++;
    }

    // Retire anything out of range, including stale LOD copies.
    for (const [key, mesh] of this._chunks) {
      if (wanted.has(key)) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      this._chunks.delete(key);
    }
  }

  /** Build the immediate neighbourhood up front so you never spawn in a void. */
  prime(px, pz) {
    for (let i = 0; i < 60; i++) this.update(px, pz, 4);
  }

  dispose() {
    for (const [, m] of this._chunks) m.geometry.dispose();
    this._chunks.clear();
    this._material.dispose();
  }
}

export { perlin };
