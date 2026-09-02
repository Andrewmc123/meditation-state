import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CHARACTERS, POSES } from './CharacterLibrary.js';

/**
 * The third-person body: a rigged humanoid that space-walks.
 *
 * SCALE
 * -----
 * One world unit is 1000 km, so a 1.8 m person is 1.8e-6 units - far below
 * the camera's near plane and deep into float32 mush. The character therefore
 * lives in its own scene at true human scale, rendered as a second pass with
 * the depth buffer cleared. Its camera mirrors the space camera's field of
 * view, so the body composites over the planets at a constant apparent size
 * and the two never fight over precision.
 *
 * That also means the character does not translate. The world moves; the body
 * banks, leans and poses in place, which is exactly what reads as flight.
 *
 * POSE
 * ----
 * Three blended states driven by speed and input:
 *   float   - near-still, slow idle drift, limbs loose
 *   glide   - moving, body pitched along the velocity vector, arms trailing
 *   burn    - thrusting hard, arms swept back, torso tucked
 * Turning banks the body into the turn, the way a skydiver steers.
 */

const LIMB = [
  'mixamorigLeftArm', 'mixamorigRightArm',
  'mixamorigLeftForeArm', 'mixamorigRightForeArm',
  'mixamorigLeftUpLeg', 'mixamorigRightUpLeg',
  'mixamorigLeftLeg', 'mixamorigRightLeg',
  'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2',
  'mixamorigHead', 'mixamorigNeck',
];

export class Character {
  constructor(engine) {
    this.engine = engine;
    this.visible = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.05, 200);

    // Camera sits behind and slightly above the shoulder.
    this.camOffset = new THREE.Vector3(0.38, 1.52, 2.75);
    this.camLookAt = new THREE.Vector3(0, 1.15, 0);

    this.root = new THREE.Group();      // yaw/pitch/bank of the body
    this.scene.add(this.root);

    this.mixer = null;
    this.actions = {};
    this.bones = {};
    this.loaded = false;

    this._bank = 0;
    this._pitch = 0;
    this._burn = 0;
    this._t = 0;
    this.emote = null;
    this.emoteWeight = 0;
    this.poseMode = 'space';   // 'space' | 'surface'

    this._buildLights();
    this._buildThrusters();
  }

  _buildLights() {
    // Keyed from the Sun each frame; the fill keeps the dark side readable
    // without flattening the suit.
    this.key = new THREE.DirectionalLight(0xfff2e0, 4.2);
    this.key.position.set(3, 2, 2);
    this.scene.add(this.key);

    // Generous fill: in space the only bounce light is the planet below, and
    // without it the suit goes to pure silhouette against the star field.
    this.fill = new THREE.HemisphereLight(0x5c74a8, 0x241d2e, 1.5);
    this.scene.add(this.fill);

    this.rim = new THREE.DirectionalLight(0x8ab4ff, 1.8);
    this.rim.position.set(-2, 1, -3);
    this.scene.add(this.rim);
  }

  _buildThrusters() {
    // Two soft additive puffs at the heels, driven by throttle.
    const tex = makeSoftDot();
    this.thrusters = [];
    for (const x of [-0.16, 0.16]) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: 0x7fd4ff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
      }));
      s.position.set(x, 0.06, 0.16);
      s.scale.setScalar(0.16);
      this.root.add(s);
      this.thrusters.push(s);
    }
  }

  /**
   * Load one of the library characters. Safe to call repeatedly - the previous
   * model is disposed first, so switching characters mid-session does not leak
   * geometry or leave two skeletons in the scene.
   */
  async load(charKey = 'xbot') {
    const def = CHARACTERS[charKey] || CHARACTERS.xbot;

    if (this.model) {
      this.root.remove(this.model);
      this.model.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach((m) => m.dispose?.());
      });
      this.mixer?.stopAllAction();
    }

    this.charKey = charKey;
    this.def = def;
    this.bones = {};
    this.actions = {};
    this.skinned = [];

    const gltf = await new GLTFLoader().loadAsync(def.file);
    this.model = gltf.scene;
    this.model.rotation.y = Math.PI;   // face away from camera
    this.model.scale.setScalar(def.scale || 1);
    this.root.add(this.model);

    this.model.traverse((o) => {
      if (o.isSkinnedMesh || o.isMesh) {
        o.frustumCulled = false;
        if (o.isSkinnedMesh) this.skinned.push(o);
        const m = o.material;
        if (m && m.isMeshStandardMaterial) {
          m.roughness = 0.55; m.metalness = 0.15; m.envMapIntensity = 0.6;
          // A little self-illumination so the suit never fully disappears on
          // the night side of a planet.
          m.emissive = new THREE.Color(0x1a2030);
          m.emissiveIntensity = 1.0;
        }
      }
      if (o.isBone) this.bones[o.name] = o;
    });

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      this.actions[clip.name] = a;
    }

    const L = def.locomotion;
    this.idleA = this.actions[L.idle] || null;
    this.walkA = this.actions[L.walk] || null;
    this.runA  = this.actions[L.run]  || null;
    if (this.idleA) this.idleA.setEffectiveWeight(1);

    // Bind pose, captured so both the space-walk and the authored poses have
    // something to blend against.
    this._rest = {};
    for (const name of Object.keys(this.bones)) {
      this._rest[name] = this.bones[name].quaternion.clone();
    }

    this.emote = null;
    this.emoteWeight = 0;
    this.loaded = true;
    return this;
  }

  /** Emote names this character can perform. */
  get emoteKeys() {
    const out = Object.keys(this.def?.clipEmotes || {});
    if (this.def?.skeleton === 'mixamo') out.push(...Object.keys(POSES));
    return out;
  }

  /**
   * Start an emote. Clip emotes play their animation; pose emotes blend the
   * authored bone rotations in. Passing the active emote again cancels it.
   */
  playEmote(key) {
    if (!this.loaded) return;
    if (this.emote && this.emote.key === key) { this.stopEmote(); return; }
    this.stopEmote();

    const clipDef = this.def.clipEmotes?.[key];
    if (clipDef) {
      const a = this.actions[clipDef.clip];
      if (!a) return;
      a.reset();
      a.setEffectiveWeight(1);
      a.setLoop(clipDef.hold ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = true;
      a.play();
      this.emote = { key, kind: 'clip', action: a, hold: !!clipDef.hold };
      return;
    }

    const pose = POSES[key];
    if (pose && this.def.skeleton === 'mixamo') {
      this.emote = { key, kind: 'pose', pose };
    }
  }

  stopEmote() {
    if (this.emote?.kind === 'clip') {
      this.emote.action.setEffectiveWeight(0);
      this.emote.action.stop();
    }
    this.emote = null;
  }

  /** Blend an authored pose in over whatever the clips produced. */
  _applyPose(pose, w) {
    const e = new THREE.Euler();
    const q = new THREE.Quaternion();
    for (const [name, rot] of Object.entries(pose.bones)) {
      const b = this.bones[name];
      const rest = this._rest[name];
      if (!b || !rest) continue;
      e.set(rot[0], rot[1], rot[2]);
      q.setFromEuler(e).premultiply(rest);
      b.quaternion.slerp(q, w);
    }
  }

  setVisible(v) { this.visible = v; this.root.visible = v; }

  /**
   * Space uses the procedural space-walk; surface hands the skeleton back to
   * the walk/run clips, which is what they were authored for.
   */
  setPoseMode(mode) {
    this.poseMode = mode;
    if (mode === 'surface') {
      // Undo the space-walk offsets, or the arms stay swept back while walking.
      for (const n of Object.keys(this._rest || {})) {
        this.bones[n]?.quaternion.copy(this._rest[n]);
      }
      this.root.rotation.set(0, 0, 0);
      this.root.position.set(0, 0, 0);
      for (const t of this.thrusters) t.material.opacity = 0;
    }
  }

  /**
   * Locomotion blend for walking on ground.
   * Clip playback is tied to actual ground speed so the feet do not skate -
   * the walk cycle covers roughly 1.4 m per stride, the run about 3.4 m.
   */
  updateSurface(dt, { speed = 0, running = false, grounded = true, flying = false, breath = 0.5 }) {
    if (!this.loaded) return;
    this._t += dt;
    const walkRef = 3.4, runRef = 8.4;
    let wIdle = 0, wWalk = 0, wRun = 0;

    if (flying || !grounded) {
      // Airborne: hold a loose pose rather than running in mid-air.
      wIdle = 1;
      this._burn += ((flying ? 1 : 0.35) - this._burn) * (1 - Math.exp(-5 * dt));
    } else {
      this._burn += (0 - this._burn) * (1 - Math.exp(-6 * dt));
      if (speed < 0.25) wIdle = 1;
      else if (speed <= walkRef) { wWalk = speed / walkRef; wIdle = 1 - wWalk; }
      else {
        wRun = THREE.MathUtils.clamp((speed - walkRef) / (runRef - walkRef), 0, 1);
        wWalk = 1 - wRun;
      }
    }

    // Resolved at load time, because the three rigs name these clips
    // differently: idle/walk/run, Idle/Walk/Run, Idle/Walking/Running.
    if (this.idleA) this.idleA.setEffectiveWeight(wIdle);
    if (this.walkA) {
      this.walkA.setEffectiveWeight(wWalk);
      this.walkA.timeScale = THREE.MathUtils.clamp(speed / 1.4, 0.35, 2.4);
    }
    if (this.runA) {
      this.runA.setEffectiveWeight(wRun);
      this.runA.timeScale = THREE.MathUtils.clamp(speed / 3.4, 0.5, 2.2);
    }
    this.mixer.update(dt);

    // Airborne, tuck slightly and trail the arms; on the ground, leave the
    // clips alone so the walk reads cleanly.
    if (flying || !grounded) this._poseSpacewalk(flying ? 0.7 : 0.3, this._burn);

    this._tickEmote(dt, speed > 0.35);

    for (let i = 0; i < this.thrusters.length; i++) {
      const s = this.thrusters[i];
      const th = flying ? 0.9 : 0;
      s.material.opacity = th * 0.8 * (0.6 + 0.4 * Math.sin(this._t * 22 + i * 2.1));
      s.scale.setScalar(0.10 + th * 0.22);
    }
  }

  /**
   * @param dt        seconds
   * @param speed01   0..1 fraction of the current speed ceiling
   * @param turn      {x,y,z} angular rates from the flight controls
   * @param sunDir    unit vector to the Sun in camera space
   * @param breath    0..1 breath envelope
   */
  update(dt, { speed01 = 0, turn, sunDir, breath = 0.5, thrusting = false }) {
    if (!this.loaded || !this.visible || this.poseMode !== 'space') return;
    this._t += dt;

    // ---- blend targets ------------------------------------------------
    const burnTarget = thrusting ? 1 : 0;
    this._burn += (burnTarget - this._burn) * (1 - Math.exp(-4.5 * dt));

    const glide = THREE.MathUtils.clamp(speed01 * 1.6, 0, 1);

    // Bank into the turn; lean into acceleration.
    const bankTarget = THREE.MathUtils.clamp(-(turn?.y ?? 0) * 26, -0.62, 0.62);
    const pitchTarget = THREE.MathUtils.clamp((turn?.x ?? 0) * 18, -0.5, 0.5)
                      + glide * 0.34 + this._burn * 0.2;
    this._bank += (bankTarget - this._bank) * (1 - Math.exp(-3.4 * dt));
    this._pitch += (pitchTarget - this._pitch) * (1 - Math.exp(-3.0 * dt));

    this.root.rotation.z = this._bank;
    this.root.rotation.x = this._pitch;

    // Breathing: the whole body rises and falls a few centimetres. At six
    // breaths a minute this is the slowest thing on screen, which is the point.
    const bob = (breath - 0.5) * 0.055;
    this.root.position.y = bob;

    // ---- animation weights ---------------------------------------------
    if (this.idleA) this.idleA.setEffectiveWeight(1 - glide * 0.75);
    if (this.runA) {
      // Only meaningful once there is a surface underfoot; in space it just
      // adds a little limb motion to the glide.
      this.runA.setEffectiveWeight(glide * 0.18);
      this.runA.timeScale = 0.55 + glide * 0.5;
    }
    this.mixer.update(dt);

    // ---- procedural space-walk on top of the clips ----------------------
    // Skip it while an authored pose is showing, or the two fight over the
    // same bones and the lotus turns into a shrug.
    if (!this.emote || this.emoteWeight < 0.5) this._poseSpacewalk(glide, this._burn);

    this._tickEmote(dt, speed01 > 0.04);

    // ---- thrusters -------------------------------------------------------
    const th = this._burn * 0.85 + glide * 0.25;
    for (let i = 0; i < this.thrusters.length; i++) {
      const s = this.thrusters[i];
      s.material.opacity = th * 0.75 * (0.62 + 0.38 * Math.sin(this._t * 21 + i * 2.1));
      s.scale.setScalar(0.10 + th * 0.20);
    }

    // ---- lighting follows the real Sun ----------------------------------
    if (sunDir) {
      this.key.position.copy(sunDir).multiplyScalar(6);
      this.rim.position.copy(sunDir).multiplyScalar(-4).setY(1.4);
    }

    // ---- camera ----------------------------------------------------------
    this.camera.fov = this.engine.camera.fov;
    this.camera.aspect = this.engine.camera.aspect;
    // Pull back a touch when moving fast - a cheap, readable speed cue.
    const back = 1 + glide * 0.34 + this._burn * 0.22;
    this.camera.position.set(
      this.camOffset.x, this.camOffset.y, this.camOffset.z * back,
    );
    this.camera.lookAt(this.camLookAt);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Ease the active emote in, and drop it when the player starts moving -
   * an emote you have to cancel by hand before you can walk feels broken.
   */
  _tickEmote(dt, moving) {
    if (this.emote && moving) this.stopEmote();

    const want = this.emote ? 1 : 0;
    this.emoteWeight += (want - this.emoteWeight) * (1 - Math.exp(-7 * dt));
    if (this.emoteWeight < 0.002) {
      if (this._poseRootApplied) {
        this.root.rotation.set(this._bank ? 0 : 0, this.root.rotation.y, 0);
        this._poseRootApplied = false;
      }
      return;
    }

    if (this.emote?.kind === 'pose') {
      const p = this.emote.pose;
      this._applyPose(p, this.emoteWeight);
      // Root tilt is what turns a relaxed skeleton into someone lying down.
      this.root.rotation.x = p.root.rot[0] * this.emoteWeight;
      this.root.rotation.z = p.root.rot[2] * this.emoteWeight;
      this.root.position.y += p.root.y * this.emoteWeight;
      this._poseRootApplied = true;
    }

    // A one-shot clip that has finished releases itself.
    if (this.emote?.kind === 'clip' && !this.emote.hold) {
      const a = this.emote.action;
      if (a.time >= a.getClip().duration - 0.02) this.stopEmote();
    }
  }

  /** Rotate the limbs from the rest pose into a trailing space-walk. */
  _poseSpacewalk(glide, burn) {
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const set = (name, x, y, z, w = 1) => {
      const b = this.bones[name];
      const r = this._rest[name];
      if (!b || !r) return;
      e.set(x, y, z);
      q.setFromEuler(e);
      b.quaternion.copy(r).slerp(q.premultiply(r), w);
    };

    const drift = Math.sin(this._t * 0.7) * 0.05 * (1 - glide);
    const sweep = glide * 0.9 + burn * 0.75;

    // Arms trail backwards and outwards as speed rises.
    set('mixamorigLeftArm', -0.25 - sweep * 0.6, 0, -0.5 - sweep * 0.55 + drift, 1);
    set('mixamorigRightArm', -0.25 - sweep * 0.6, 0, 0.5 + sweep * 0.55 - drift, 1);
    set('mixamorigLeftForeArm', 0, 0, -0.35 - sweep * 0.3, 1);
    set('mixamorigRightForeArm', 0, 0, 0.35 + sweep * 0.3, 1);

    // Legs tuck slightly under burn, splay when floating.
    const tuck = burn * 0.5;
    set('mixamorigLeftUpLeg', tuck * 0.7, 0, -0.10 - glide * 0.06 + drift * 0.6, 1);
    set('mixamorigRightUpLeg', tuck * 0.7, 0, 0.10 + glide * 0.06 - drift * 0.6, 1);
    set('mixamorigLeftLeg', -tuck, 0, 0, 1);
    set('mixamorigRightLeg', -tuck, 0, 0, 1);

    // Torso curls into the burn; head stays looking forward.
    set('mixamorigSpine1', -glide * 0.12 - burn * 0.16, 0, 0, 1);
    set('mixamorigHead', glide * 0.14 + burn * 0.2, 0, 0, 1);
  }

  /** Draw the body over the finished space frame, at human scale. */
  render(renderer) {
    if (!this.loaded || !this.visible) return;
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAuto;
  }

  dispose() {
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose?.());
    });
  }
}

function makeSoftDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(180,230,255,0.6)');
  grd.addColorStop(1, 'rgba(120,200,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
