import * as THREE from 'three';
import { Terrain, WORLDS, perlin } from './Terrain.js';

/**
 * A walkable surface: its own scene, its own camera, metres as the unit.
 *
 * Gravity is the real value for each body, and it is the single thing that
 * makes these worlds feel different from each other. At 1.62 m/s^2 a jump on
 * the Moon hangs for about three seconds and you cover a lot of ground; the
 * same input on Earth barely leaves the floor. Nothing else about the
 * controller changes between worlds.
 *
 * Scattered across each world are resonance stones, tuned to a just-intonation
 * pentatonic. Walk near one and it sounds. It is the one interactive object
 * that belongs in this project rather than being borrowed from a platformer:
 * the landscape is an instrument you play by walking through it.
 */

const EYE = 1.62;              // camera height at the head, metres
const PENTATONIC = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2];

export class SurfaceWorld {
  constructor(engine, audio, settings) {
    this.engine = engine;
    this.audio = audio;
    this.settings = settings;
    this.active = false;
    this.worldKey = null;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(66, 1, 0.1, 12000);

    // Player state, in metres and metres/second.
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.12;
    this.grounded = false;
    this.flying = false;
    this.camDist = 4.6;

    this._tmp = new THREE.Vector3();
    this._stones = [];
    this._lastChime = 0;
    this._t = 0;
  }

  // -------------------------------------------------------------------

  async load(key, character) {
    const w = WORLDS[key];
    if (!w) throw new Error('unknown world: ' + key);

    this.dispose();
    this.w = w;
    this.worldKey = key;
    this.character = character;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(w.fog, w.fogNear, w.fogFar);

    this._buildSky();
    this._buildLights();

    this.terrain = new Terrain(w, 1337 + key.length * 977);
    this.scene.add(this.terrain.group);

    // Spawn on flat-ish ground: sample a spiral until the slope is walkable.
    this.pos.set(0, 0, 0);
    for (let i = 0; i < 400; i++) {
      const a = i * 2.4, r = i * 3.5;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (this.terrain.slopeAt(x, z) < 0.06) { this.pos.set(x, 0, z); break; }
    }
    this.terrain.prime(this.pos.x, this.pos.z);
    this.pos.y = this.terrain.height(this.pos.x, this.pos.z);

    this._scatterBoulders();
    this._placeStones();

    this._buildContactShadow();

    if (character?.root) {
      this._prevParent = character.root.parent;
      this.scene.add(character.root);
      character.root.position.set(0, 0, 0);
      character.root.rotation.set(0, 0, 0);
      character.setPoseMode?.('surface');
      character.setVisible(true);
    }

    this.active = true;
    return this;
  }

  /**
   * A soft dark ellipse laid on the terrain under the character. Real shadow
   * mapping across a 1 km view distance costs far more than this is worth on
   * integrated graphics, and at this sun angle a contact patch carries almost
   * all of the grounding cue.
   */
  _buildContactShadow() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.22)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 1.9),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false,
        opacity: 0.9, fog: true,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
    this.scene.add(this.shadow);
  }

  _buildSky() {
    const w = this.w;
    // Gradient dome. Cheaper than any atmospheric scattering model and, for a
    // fixed time of day, indistinguishable.
    const geo = new THREE.SphereGeometry(9000, 32, 20);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(w.sky) },
        uBottom: { value: new THREE.Color(w.horizon) },
        uSun: { value: new THREE.Vector3(0.4, 0.35, 1).normalize() },
        uSunColor: { value: new THREE.Color(w.sunColor) },
        uAirless: { value: w.key === 'moon' ? 1 : 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop, uBottom, uSunColor; uniform vec3 uSun; uniform float uAirless;
        varying vec3 vDir;

        float h31(vec3 p){
          p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }

        void main(){
          float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 c = mix(uBottom, uTop, pow(h, 0.62));

          // Sun glow. On an airless body there is no scattering, so the sky
          // stays black right up to the disc.
          float d = max(dot(normalize(vDir), normalize(uSun)), 0.0);
          c += uSunColor * pow(d, 220.0) * 2.4;
          c += uSunColor * pow(d, 5.0) * 0.16 * (1.0 - uAirless);

          // With no atmosphere the stars are visible in full daylight, which
          // is one of the genuinely strange things about standing on the Moon.
          if (uAirless > 0.5) {
            vec3 g = floor(normalize(vDir) * 260.0);
            float r = h31(g);
            if (r > 0.9965) {
              float b = (r - 0.9965) / 0.0035;
              c += vec3(0.86, 0.90, 1.0) * b * 1.5;
            }
          }
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  _buildLights() {
    const w = this.w;
    this.sun = new THREE.DirectionalLight(w.sunColor, w.sunIntensity);
    this.sun.position.set(400, 350, 1000);
    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(w.ambient, w.ambientI));

    // A dim up-light stands in for bounce off the ground; without it the shaded
    // side of every rock is pure black, which only looks right on the Moon.
    if (w.key !== 'moon') {
      const bounce = new THREE.HemisphereLight(w.sky, w.ground, 0.42);
      this.scene.add(bounce);
    }
  }

  _scatterBoulders() {
    const w = this.w;
    const N = w.boulders;
    const geos = [];
    for (let v = 0; v < 3; v++) {
      const g = new THREE.IcosahedronGeometry(1, 1);
      const p = g.attributes.position;
      const squash = 0.55 + v * 0.18;          // per shape, never per vertex
      const n = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        n.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
        const d = 1 + perlin(n.x * 2.4 + v * 9, n.z * 2.4, 7 + v) * 0.34;
        p.setXYZ(i, n.x * d, n.y * d * squash, n.z * d);
      }
      g.computeVertexNormals();
      geos.push(g);
    }

    this.boulders = geos.map((g, i) => {
      const m = new THREE.InstancedMesh(
        g,
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(w.rock).multiplyScalar(0.82 + i * 0.14),
          roughness: 0.98, flatShading: true,
        }),
        Math.ceil(N / 3),
      );
      m.count = 0;
      this.scene.add(m);
      return m;
    });

    const d = new THREE.Object3D();
    const counts = [0, 0, 0];
    const R = mulberry32(99);
    for (let i = 0; i < N; i++) {
      const a = R() * Math.PI * 2;
      const r = 40 + Math.sqrt(R()) * 900;
      const x = this.pos.x + Math.cos(a) * r;
      const z = this.pos.z + Math.sin(a) * r;
      // Boulders collect where the ground is not too steep to hold them.
      if (this.terrain.slopeAt(x, z) > 0.34) continue;

      const s = 0.6 + R() * R() * 5.4;
      d.position.set(x, this.terrain.height(x, z) - s * 0.28, z);
      d.rotation.set(R() * 6.28, R() * 6.28, R() * 6.28);
      d.scale.setScalar(s);
      d.updateMatrix();
      const slot = i % 3;
      this.boulders[slot].setMatrixAt(counts[slot]++, d.matrix);
    }
    this.boulders.forEach((m, i) => {
      m.count = counts[i];
      m.instanceMatrix.needsUpdate = true;
    });
  }

  _placeStones() {
    const w = this.w;
    const R = mulberry32(4242);
    const base = 110;
    this._stones = [];

    for (let i = 0; i < w.stones; i++) {
      const a = (i / w.stones) * Math.PI * 2 + R() * 0.5;
      const r = 90 + R() * 620;
      const x = this.pos.x + Math.cos(a) * r;
      const z = this.pos.z + Math.sin(a) * r;
      const y = this.terrain.height(x, z);

      const h = 4.5 + R() * 5.5;
      const geo = new THREE.BoxGeometry(1.1 + R() * 0.7, h, 0.75 + R() * 0.5);
      const mat = new THREE.MeshStandardMaterial({
        // Lighter base so it reads as stone rather than a silhouette, and a
        // deliberately restrained emissive: at 1.7 the bloom pass turned these
        // into flat glowing bricks with no form left in them.
        color: 0x4a4f5c, roughness: 0.62, metalness: 0.18,
        emissive: new THREE.Color(0xE3A458), emissiveIntensity: 0.0,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y + h * 0.42, z);
      mesh.rotation.y = R() * 6.28;
      mesh.rotation.z = (R() - 0.5) * 0.10;   // none of them stand quite straight
      this.scene.add(mesh);

      this._stones.push({
        mesh, mat, x, z, y,
        freq: base * PENTATONIC[i % PENTATONIC.length] * (i >= PENTATONIC.length ? 2 : 1),
        lit: 0, cooldown: 0,
      });
    }
  }

  // -------------------------------------------------------------------

  /**
   * @param keys    live Set of KeyboardEvent.code
   * @param angular mouse deltas from the shared controls object
   */
  update(dt, keys, angular, breath) {
    if (!this.active) return;
    this._t += dt;
    const w = this.w;
    const S = this.settings;
    const down = (a) => (S ? S.down(a) : false);
    const pressed = (a) => (S ? S.pressed(a) : false);

    // ---- look ----------------------------------------------------------
    this.yaw += angular.y;
    this.pitch = THREE.MathUtils.clamp(this.pitch + angular.x, -1.15, 0.85);
    // Smoothing 0 means the view stops the instant the mouse does; 1 lets it
    // coast. Mapped so the default feels the same as it did before.
    const sm = S ? S.get('lookSmoothing') : 0.5;
    angular.multiplyScalar(Math.exp(-(28 - sm * 26) * dt));

    // ---- intent --------------------------------------------------------
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = this._tmp.set(0, 0, 0);
    if (down('forward')) move.add(fwd);
    if (down('back')) move.sub(fwd);
    if (down('right')) move.add(right);
    if (down('left')) move.sub(right);
    const moving = move.lengthSq() > 0;
    if (moving) move.normalize();

    const running = down('run');
    const walkSpeed = running
      ? (S ? S.get('runSpeed') : 8.4)
      : (S ? S.get('walkSpeed') : 3.4);

    // ---- flight --------------------------------------------------------
    // Jetpack: hold jump in the air. Thrust is scaled against local gravity so
    // it feels controllable on every world instead of rocketing off the Moon.
    if (pressed('jetpack')) this.flying = !this.flying;

    if (this.flying) {
      const flySpeed = running ? (S ? S.get('runSpeed') * 4 : 34) : (S ? S.get('walkSpeed') * 4 : 14);
      this.vel.x += move.x * flySpeed * 4 * dt;
      this.vel.z += move.z * flySpeed * 4 * dt;
      let lift = 0;
      if (down('up')) lift += 1;
      if (down('down')) lift -= 1;
      this.vel.y += lift * w.gravity * (S ? S.get('jetpackPower') : 2.6) * dt;
      this.vel.y -= w.gravity * 0.25 * dt;           // gentle sink when idle
      this.vel.multiplyScalar(Math.exp(-1.9 * dt));  // air brake
    } else {
      // Velocity target, not acceleration-plus-drag. Balancing an accel term
      // against a drag term means the equilibrium speed is whatever the two
      // happen to settle at - it was reaching 1.4 m/s against a 3.4 target.
      // Easing toward the wanted velocity hits the target exactly and still
      // gives a soft start and stop.
      const wantX = move.x * walkSpeed;
      const wantZ = move.z * walkSpeed;

      // Grip when your feet are on rock; almost none in mid-air, which is what
      // makes a jump commit you to its arc.
      const grip = S ? S.get('groundGrip') : 11;
      const k = this.grounded ? (moving ? grip : grip * 1.18) : 1.4;
      const a = 1 - Math.exp(-k * dt);
      this.vel.x += (wantX - this.vel.x) * a;
      this.vel.z += (wantZ - this.vel.z) * a;

      this.vel.y -= w.gravity * dt;

      if (down('up') && this.grounded) {
        // Fixed jump height regardless of gravity: v = sqrt(2*g*h).
        const h = S ? S.get('jumpHeight') : 1.35;
        this.vel.y = Math.sqrt(2 * w.gravity * h);
        this.grounded = false;
      }
    }

    // ---- integrate + collide -------------------------------------------
    this.pos.addScaledVector(this.vel, dt);

    const ground = this.terrain.height(this.pos.x, this.pos.z);

    // Ground snapping. Walking down any slope moves you horizontally faster
    // than gravity pulls you down, so without a stick threshold you leave the
    // surface every single frame - which reads as permanently airborne and
    // keeps the walk animation from ever playing.
    const STICK = 0.55;
    const falling = this.vel.y <= 0.01;
    if (this.pos.y <= ground || (!this.flying && falling && this.pos.y - ground < STICK)) {
      this.pos.y = ground;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
      if (this.flying && !down('up')) this.flying = false;
    } else {
      this.grounded = false;
    }

    // Steep ground pushes you back downhill rather than letting you walk up a
    // cliff face. Cheap substitute for real slope collision.
    const slope = this.terrain.slopeAt(this.pos.x, this.pos.z);
    if (this.grounded && slope > 0.55) {
      const n = this.terrain.normalAt(this.pos.x, this.pos.z, new THREE.Vector3());
      this.vel.x += n.x * 26 * dt;
      this.vel.z += n.z * 26 * dt;
    }

    this.terrain.update(this.pos.x, this.pos.z, 2);

    // ---- body ------------------------------------------------------------
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.character?.root) {
      const r = this.character.root;
      r.position.copy(this.pos);
      if (moving || this.flying) {
        // Face travel direction, easing rather than snapping.
        const want = Math.atan2(-this.vel.x, -this.vel.z);
        let d = want - r.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        r.rotation.y += d * (1 - Math.exp(-9 * dt));
      }
      this.character.updateSurface?.(dt, {
        speed, running, grounded: this.grounded, flying: this.flying,
        walkSpeed, breath,
      });
    }

    // Shadow follows the feet, lies flat on the slope, and fades with altitude.
    if (this.shadow) {
      const gy = this.terrain.height(this.pos.x, this.pos.z);
      const n = this.terrain.normalAt(this.pos.x, this.pos.z, new THREE.Vector3());
      this.shadow.position.set(this.pos.x, gy + 0.06, this.pos.z);
      this.shadow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      const alt = this.pos.y - gy;
      this.shadow.material.opacity = THREE.MathUtils.clamp(1 - alt / 14, 0, 0.9);
      const sp = 1 + THREE.MathUtils.clamp(alt / 10, 0, 1.4);
      this.shadow.scale.setScalar(sp);
    }

    this._updateStones(dt, speed);
    this._updateCamera(dt);
    this.sky.position.copy(this.camera.position);
  }

  _updateStones(dt, speed) {
    for (const s of this._stones) {
      const dx = s.x - this.pos.x, dz = s.z - this.pos.z;
      const d = Math.hypot(dx, dz);

      // Glow rises within 18 m and peaks at the base of the stone.
      const target = THREE.MathUtils.clamp(1 - d / 18, 0, 1);
      s.lit += (target - s.lit) * (1 - Math.exp(-3.2 * dt));
      s.mat.emissiveIntensity = s.lit * 0.34;

      s.cooldown -= dt;
      // Sound it once on entry, not continuously - a stone that drones while
      // you stand next to it stops being an event.
      if (d < 11 && s.cooldown <= 0) {
        s.cooldown = 6;
        this.audio?.chime?.(s.freq, 0.16);
      }
    }
  }

  _updateCamera(dt) {
    const S = this.settings;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * cp, -sp, Math.cos(this.yaw) * cp,
    );

    const eye = EYE + (S ? S.get('camHeight') : 0);
    const focus = this._tmp.copy(this.pos).setY(this.pos.y + eye);
    const dist = this.camDist * (S ? S.get('camDistance') : 1);
    const want = focus.clone().addScaledVector(dir, dist);

    // Shoulder offset, perpendicular to the view.
    const sh = S ? S.get('camShoulder') : 0.38;
    want.x += Math.cos(this.yaw) * sh;
    want.z += -Math.sin(this.yaw) * sh;

    // Never let the camera end up underground.
    const g = this.terrain.height(want.x, want.z) + 0.9;
    if (want.y < g) want.y = g;

    this.camera.position.lerp(want, 1 - Math.exp(-13 * dt));
    this.camera.lookAt(focus);
    this.camera.fov = this.engine.camera.fov;
    this.camera.aspect = this.engine.camera.aspect;
    this.camera.updateProjectionMatrix();
  }

  render(renderer) {
    if (!this.active) return;
    renderer.render(this.scene, this.camera);
  }

  /** Metres per second, for the HUD. */
  get speed() { return Math.hypot(this.vel.x, this.vel.z); }
  get altitude() {
    return this.pos.y - this.terrain.height(this.pos.x, this.pos.z);
  }

  dispose() {
    if (this.character?.root && this._prevParent) {
      this._prevParent.add(this.character.root);
      this.character.setPoseMode?.('space');
    }
    this.terrain?.dispose();
    this.scene?.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose?.());
    });
    this._stones = [];
    this.active = false;
  }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { WORLDS };
