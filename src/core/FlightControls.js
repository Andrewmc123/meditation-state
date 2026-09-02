import * as THREE from 'three';

/**
 * Six-degree-of-freedom flight with meditative damping.
 *
 * Two things make this feel unlike a normal space sim:
 *
 * 1. Nothing stops sharply. Inputs feed an acceleration, and velocity decays
 *    exponentially. Releasing the stick coasts to rest over a couple of
 *    seconds instead of halting, so the camera never jerks.
 *
 * 2. Speed is relative to the nearest surface. Full throttle a hundred million
 *    km out is interplanetary; the same throttle five hundred km above Saturn's
 *    rings is a slow drift. You cannot accidentally punch through a planet, and
 *    approaches decelerate on their own.
 *
 * Space is genuinely enormous, so the throttle is logarithmic across seven
 * orders of magnitude: 1 km/s to about 30 million km/s.
 */

const V = () => new THREE.Vector3();

export const FLIGHT_MODE = {
  FREE: 'free',        // everything unlocked
  MEDITATIVE: 'meditative', // gentler, breath-coupled, softer ceiling
  REST: 'rest',        // drift only, cannot approach a surface
};

export class FlightControls {
  constructor(camera, domElement, settings) {
    this.camera = camera;
    this.dom = domElement;
    this.settings = settings;
    this.mode = FLIGHT_MODE.FREE;

    this.velocity = V();
    this.angular = V();            // pitch, yaw, roll rates
    this.throttle = 0.42;          // 0..1, logarithmic
    this.enabled = true;
    this.locked = false;

    this.minSpeed = 1e-3;          // 1 km/s
    this.maxSpeed = 3e4;           // 30 M km/s
    this.surfaceDist = Infinity;   // set each frame by the caller
    this.breath = 0.5;

    this.keys = new Set();
    // The settings object reads this same Set, so a rebind takes effect on the
    // next frame with nothing to re-register.
    this.settings?.attachKeys(this.keys);
    this._quat = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._tmp = V();

    this._bind();
  }

  _bind() {
    const d = this.dom;

    d.addEventListener('click', () => {
      if (!this.locked && this.enabled) this.requestLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === d;
      this.onLockChange?.(this.locked);
    });

    // Drag-to-look fallback. Pointer lock is unavailable inside embedded
    // documents and some kiosk contexts; without this the game is unplayable
    // there rather than merely less comfortable.
    this.dragging = false;
    d.addEventListener('pointerdown', (e) => {
      if (this.locked || !this.enabled || e.button !== 0) return;
      this.dragging = true;
      d.setPointerCapture?.(e.pointerId);
    });
    const endDrag = () => { this.dragging = false; };
    d.addEventListener('pointerup', endDrag);
    d.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);

    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (!this.locked && !this.dragging) return;
      const S = this.settings;
      const s = 0.00042 * (this.mode === FLIGHT_MODE.FREE ? 1 : 0.55)
              * (this.locked ? 1 : 1.5)   // dragging has less travel to work with
              * (S ? S.lookScale() : 1);
      const invert = S && S.invertY() ? -1 : 1;
      this.angular.x -= e.movementY * s * invert;
      this.angular.y -= e.movementX * s;
    });

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    d.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.throttle = Math.max(0, Math.min(1, this.throttle - e.deltaY * 0.00055));
    }, { passive: false });
  }

  /** Never throws: some contexts reject pointer lock outright. */
  requestLock() {
    try {
      const p = this.dom.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => { this.lockUnavailable = true; });
    } catch { this.lockUnavailable = true; }
  }

  setMode(m) {
    this.mode = m;
    if (m === FLIGHT_MODE.REST) this.throttle = Math.min(this.throttle, 0.22);
  }

  /** Throttle position -> units per second, logarithmic. */
  get throttleSpeed() {
    const t = this.throttle;
    const lo = Math.log(this.minSpeed), hi = Math.log(this.maxSpeed);
    return Math.exp(lo + (hi - lo) * t);
  }

  /** What the throttle is actually allowed to deliver here and now. */
  get speedCeiling() {
    let ceiling = this.throttleSpeed;

    // Never move faster than you could stop before hitting the thing ahead.
    const pb = this.settings ? this.settings.get('proximityBrake') : 0.55;
    const proximity = Math.max(this.surfaceDist, 0.05) * pb;
    ceiling = Math.min(ceiling, Math.max(this.minSpeed, proximity));

    if (this.mode === FLIGHT_MODE.MEDITATIVE) ceiling *= 0.55;
    if (this.mode === FLIGHT_MODE.REST) ceiling *= 0.16;
    return ceiling;
  }

  get speed() { return this.velocity.length(); }

  update(dt) {
    if (!this.enabled) return;
    const S = this.settings;
    const down = (a) => (S ? S.down(a) : false);
    const free = this.mode === FLIGHT_MODE.FREE;

    // ---- rotation ------------------------------------------------------
    const rollRate = 1.6 * dt;
    if (down('rollLeft')) this.angular.z += rollRate;
    if (down('rollRight')) this.angular.z -= rollRate;

    this._quat.setFromEuler(this._euler.set(this.angular.x, this.angular.y, this.angular.z, 'YXZ'));
    this.camera.quaternion.multiply(this._quat);
    this.camera.quaternion.normalize();

    // Angular damping. Heavier outside free flight so the view settles.
    const turnBase = S ? S.get('turnDamping') : 9.0;
    const angDamp = Math.exp(-(free ? turnBase : turnBase * 0.55) * dt);
    this.angular.multiplyScalar(angDamp);

    // ---- translation ---------------------------------------------------
    const dir = this._tmp.set(0, 0, 0);
    if (down('forward')) dir.z -= 1;
    if (down('back')) dir.z += 1;
    if (down('left')) dir.x -= 1;
    if (down('right')) dir.x += 1;
    if (down('up')) dir.y += 1;
    if (down('down')) dir.y -= 1;

    const ceiling = this.speedCeiling;

    if (dir.lengthSq() > 0) {
      dir.normalize().applyQuaternion(this.camera.quaternion);

      // Boost is only available in free flight - the other modes are supposed
      // to be unhurried.
      const boostMax = S ? S.get('boostMultiplier') : 4.0;
      const boost = free && down('boost') ? boostMax : 1.0;

      // In meditative mode thrust breathes with the pacer: you accelerate on
      // the inhale and coast on the exhale, without touching the controls.
      const breathGain = this.mode === FLIGHT_MODE.MEDITATIVE
        ? 0.45 + this.breath * 0.9
        : 1.0;

      const accel = ceiling * 1.9 * boost * breathGain;
      this.velocity.addScaledVector(dir, accel * dt);
    }

    // Exponential drag. Long tail: coasting is the default state.
    const dragBase = S ? S.get('flightDamping') : 1.35;
    const drag = Math.exp(-(free ? dragBase : dragBase * 0.63) * dt);
    this.velocity.multiplyScalar(drag);

    const sp = this.velocity.length();
    const hard = ceiling * (free && down('boost') ? (S ? S.get('boostMultiplier') : 4.0) : 1.0);
    if (sp > hard) this.velocity.multiplyScalar(hard / sp);

    if (down('brake')) this.velocity.multiplyScalar(Math.exp(-6 * dt));

    this.camera.position.addScaledVector(this.velocity, dt);
  }

  /** Smoothly point the camera at a world position. Returns true when aligned. */
  lookToward(target, dt, rate = 1.6) {
    const m = new THREE.Matrix4().lookAt(this.camera.position, target, this.camera.up);
    const want = new THREE.Quaternion().setFromRotationMatrix(m);
    this.camera.quaternion.slerp(want, 1 - Math.exp(-rate * dt));
    return this.camera.quaternion.angleTo(want) < 0.01;
  }
}
