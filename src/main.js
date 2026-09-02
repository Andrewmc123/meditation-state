import * as THREE from 'three';
import { Engine, QUALITY } from './core/Engine.js';
import { Starfield } from './space/Starfield.js';
import { SolarSystem } from './space/SolarSystem.js';
import { Debris } from './space/Debris.js';
import { Interstellar } from './space/Interstellar.js';
import { FlightControls, FLIGHT_MODE } from './core/FlightControls.js';
import { MeditationAudio, PRESETS } from './audio/MeditationAudio.js';
import { Character } from './world/Character.js';
import { Wardrobe } from './world/Wardrobe.js';
import { SurfaceWorld, WORLDS } from './world/SurfaceWorld.js';
import { AU, KM } from './core/constants.js';
import { Settings, ACTIONS, TUNABLES, prettyKey } from './core/Settings.js';

const $ = (id) => document.getElementById(id);

const MODES = {
  free: {
    label: 'Free roam', flight: FLIGHT_MODE.FREE, preset: 'drift',
    exposure: 1.0, milkyway: 0.5,
  },
  meditative: {
    label: 'Meditative', flight: FLIGHT_MODE.MEDITATIVE, preset: 'resonance',
    exposure: 1.25, milkyway: 0.72,
  },
  rest: {
    label: 'Rest', flight: FLIGHT_MODE.REST, preset: 'settle',
    exposure: 1.45, milkyway: 0.9,
  },
};

class Game {
  constructor() {
    this.engine = new Engine($('c'));
    this.settings = new Settings();
    this.audio = new MeditationAudio();
    this.controls = new FlightControls(this.engine.camera, $('c'), this.settings);
    this.starfield = new Starfield(this.engine);
    this.system = new SolarSystem(this.engine);
    this.debris = new Debris(this.engine);
    this.interstellar = new Interstellar(this.engine);
    this.inInterstellar = false;
    this.character = new Character(this.engine);
    this.wardrobe = new Wardrobe();
    this.surface = new SurfaceWorld(this.engine, this.audio, this.settings);
    this.onSurface = false;
    this.thirdPerson = true;

    this.mode = 'free';
    this.showHud = true;
    this.breathEnv = 0.5;
    this.clock = new THREE.Clock();
    this._lockDelta = new THREE.Vector3();
    this._acc = 0;
    this._hudAcc = 0;
  }

  async boot() {
    const step = (p, msg) => {
      $('barFill').style.width = (p * 100).toFixed(0) + '%';
      if (msg) $('loadTxt').textContent = msg;
    };

    step(0.04, 'loading star catalogue');
    await this.starfield.load((p) => step(0.04 + p * 0.34));
    this.engine.scene.add(this.starfield.group);
    $('sStars').textContent = this.starfield.count.toLocaleString();

    step(0.4, 'building the solar system');
    await this.system.load((p) => step(0.4 + p * 0.55, 'loading planetary maps'));
    this.engine.scene.add(this.system.group);

    step(0.93, 'scattering the belt');
    await this.debris.load();
    this.engine.scene.add(this.debris.group);

    step(0.95, 'mapping the neighbourhood');
    await this.interstellar.load(this.starfield);

    step(0.96, 'waking the body');
    try {
      await this.character.load();
      this.wardrobe.attach(this.character);
      this.character.setVisible(this.thirdPerson);
    } catch (e) {
      // A missing character model must not cost you the whole solar system.
      console.warn('character unavailable, staying in first person:', e.message);
      this.thirdPerson = false;
    }

    step(1, 'ready');

    // Open just off Earth, looking back at it.
    const earth = this.system.bodies.find((b) => b.key === 'earth');
    this.system.update(0, new THREE.Vector3());
    const p = earth.worldPos.clone();
    this.engine.camera.position.copy(p).add(new THREE.Vector3(0, earth.radius * 1.1, earth.radius * 4.2));
    this.engine.camera.lookAt(p);

    this.settings.onChange(() => this.applySettings());
    this.applySettings();

    this.buildMenu();
    this.buildSettingsUI();
    this.bindKeys();

    $('enter').classList.add('ready');
    $('enterHint').classList.add('ready');
    $('enter').addEventListener('click', async () => {
      await this.audio.init();
      this.setMode('free');
      $('load').classList.add('gone');
      $('hud').classList.add('on');
      setTimeout(() => { $('load').style.display = 'none'; }, 1200);
      this.controls.requestLock();
    });

    this.loop();
  }

  // -----------------------------------------------------------------

  setMode(name) {
    const m = MODES[name];
    if (!m) return;
    this.mode = name;
    this.controls.setMode(m.flight);
    this.audio.applyPreset(m.preset, 5);
    this.starfield.setExposure(m.exposure);
    this.starfield.setMilkyWay(m.milkyway);
    $('mName').textContent = m.label;
    $('bRate').textContent = PRESETS[m.preset].breathBpm
      ? PRESETS[m.preset].breathBpm.toFixed(1) + ' / min'
      : 'unpaced';
    this.syncMenu();
  }

  /** Push tunables into the objects that actually consume them. */
  applySettings() {
    const S = this.settings;
    this.engine.camera.fov = S.get('fov');
    this.engine.camera.updateProjectionMatrix();

    // Third-person rig in space. The stored offset is the baseline; the
    // distance tunable scales it and the height/shoulder shift it.
    const c = this.character;
    if (c) {
      c.camOffset.set(
        S.get('camShoulder'),
        1.52 + S.get('camHeight'),
        2.75 * S.get('camDistance'),
      );
      c.camLookAt.set(0, 1.15 + S.get('camHeight') * 0.6, 0);
    }
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      // While rebinding, the panel owns the keyboard entirely.
      if (this._capturing) return;
      const action = this.settings.actionFor(e.code);
      if (!action) return;

      if (action === 'menu') { e.preventDefault(); this.toggleMenu(); return; }
      if ($('menu').classList.contains('on')) return;

      if (action === 'mode') {
        e.preventDefault();
        const order = ['free', 'meditative', 'rest'];
        this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
      }
      if (action === 'land') {
        if (this.onSurface) this.leaveSurface();
        else {
          const n = this.system.nearest(this.engine.camera.position);
          const k = n.body?.key;
          if (WORLDS[k]) this.land(k);
          else $('tBlurb').textContent = 'No surface built for this body yet.';
        }
      }
      if (action === 'interstellar') {
        if (this.onSurface) return;
        if (this.inInterstellar) this.leaveInterstellar();
        else this.enterInterstellar();
      }
      if (action === 'view') {
        this.thirdPerson = !this.thirdPerson;
        this.character.setVisible(this.thirdPerson && this.character.loaded);
        $('sView').textContent = this.thirdPerson ? 'third' : 'first';
      }
      if (action === 'hud') {
        this.showHud = !this.showHud;
        $('hud').classList.toggle('on', this.showHud);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.audio.suspend(); else this.audio.resume();
    });
  }

  toggleMenu(force) {
    const on = force ?? !$('menu').classList.contains('on');
    $('menu').classList.toggle('on', on);
    this.controls.enabled = !on;
    if (on && document.pointerLockElement) document.exitPointerLock();
    else if (!on) this.controls.requestLock();
  }

  // -----------------------------------------------------------------

  buildMenu() {
    // Sound presets
    const pw = $('optPreset');
    for (const [k, v] of Object.entries(PRESETS)) {
      const d = document.createElement('div');
      d.className = 'opt';
      d.dataset.preset = k;
      d.innerHTML = `${v.label}<small>${v.breathBpm ? v.breathBpm.toFixed(1) + '/min &middot; ' : ''}${v.beat} Hz &middot; ${v.note}</small>`;
      d.onclick = () => { this.audio.applyPreset(k, 5); this._preset = k; this.syncMenu(); };
      pw.appendChild(d);
    }

    // Quality
    const qw = $('optQuality');
    for (const [k, v] of Object.entries(QUALITY)) {
      const d = document.createElement('div');
      d.className = 'opt' + (k === 'clear' ? ' sel' : '');
      d.dataset.q = k;
      d.innerHTML = `${v.label}<small>${v.note}</small>`;
      d.onclick = () => { this.engine.setQuality(k); this.syncMenu(); };
      qw.appendChild(d);
    }

    // Jump targets
    const jw = $('optJump');
    const targets = [
      { name: 'The Sun', get: () => ({ pos: new THREE.Vector3(), r: 696.34 }) },
      ...this.system.bodies.map((b) => ({ name: b.name, get: () => ({ pos: b.worldPos.clone(), r: b.radius }) })),
      ...this.debris.craft.map((c) => ({ name: c.name, get: () => ({ pos: c.worldPos.clone(), r: 0.006 }) })),
      { name: 'Asteroid belt', get: () => ({ pos: new THREE.Vector3(2.65 * AU, 0, 0), r: 260 }) },
    ];
    for (const t of targets) {
      const d = document.createElement('div');
      d.className = 'opt';
      d.textContent = t.name;
      d.onclick = () => { this.jumpTo(t.get()); this.toggleMenu(false); };
      jw.appendChild(d);
    }

    // Tuning
    $('optTuning').querySelectorAll('[data-t]').forEach((el) => {
      el.onclick = () => {
        this.audio.setTuning(+el.dataset.t);
        $('optTuning').querySelectorAll('.opt').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
      };
    });

    // Toggles
    document.querySelectorAll('[data-tog]').forEach((el) => {
      el.onclick = () => {
        const on = !el.classList.contains('sel');
        el.classList.toggle('sel', on);
        const k = el.dataset.tog;
        if (k === 'orbits') this.system.setOrbitLines(on);
        if (k === 'hud') { this.showHud = on; $('hud').classList.toggle('on', on); }
        if (k === 'adaptive') this.engine.setAdaptive(on);
      };
    });
    this.system.setOrbitLines(true);

    // Sliders
    $('vol').oninput = (e) => {
      const v = +e.target.value;
      this.audio.setMasterLevel(v / 100);
      $('volV').textContent = v + '%';
    };
    $('tScale').oninput = (e) => {
      // Logarithmic: real time up to about a year per second.
      const t = +e.target.value / 100;
      const s = Math.exp(Math.log(1) + (Math.log(3e7) - Math.log(1)) * t);
      this.system.timeScale = s;
      $('tScaleV').textContent = fmtTimeScale(s);
    };
    $('tScale').dispatchEvent(new Event('input'));

    // ---- interstellar ----
    const iw = $('optStars');
    const mk = (label, sub, fn) => {
      const d = document.createElement('div');
      d.className = 'opt';
      d.innerHTML = sub ? label + '<small>' + sub + '</small>' : label;
      d.onclick = () => { this.toggleMenu(false); fn(); };
      iw.appendChild(d);
    };
    mk('Enter / leave', 'parsec scale', () => {
      if (this.inInterstellar) this.leaveInterstellar(); else this.enterInterstellar();
    });
    const goTo = (pos, standoff) => {
      if (!this.inInterstellar) this.enterInterstellar();
      const cam = this.interstellar.camera;
      cam.position.copy(pos).add(
        new THREE.Vector3(0.4, 0.3, 1).normalize().multiplyScalar(standoff));
      cam.lookAt(pos);
      this.controls.velocity.set(0, 0, 0);
      this.controls.angular.set(0, 0, 0);
    };
    for (const b of this.interstellar.blackHoles) {
      mk(b.name, (b.pc * 3.26156 / 1000).toFixed(1) + 'k ly',
         () => goTo(b.worldPos, b.radius * 6));
    }
    for (const g of this.interstellar.galaxies) {
      mk(g.name, (g.pc * 3.26156 / 1e6).toFixed(2) + 'M ly',
         () => goTo(g.worldPos, g.radius * 3.2));
    }
    // The ten nearest systems that actually have planets.
    for (const sys of this.interstellar.systems.slice(0, 10)) {
      mk(sys.name,
         (sys.pc * 3.26156).toFixed(1) + ' ly / ' + sys.planets.length + 'p',
         () => goTo(sys.pos, 0.06));
    }

    // ---- surfaces ----
    const sw = $('optLand');
    for (const [k, w] of Object.entries(WORLDS)) {
      const d = document.createElement('div');
      d.className = 'opt';
      d.innerHTML = `${w.name}<small>gravity ${w.gravity.toFixed(2)} m/s²</small>`;
      d.onclick = () => { this.toggleMenu(false); this.land(k); };
      sw.appendChild(d);
    }
    const up = document.createElement('div');
    up.className = 'opt';
    up.innerHTML = 'Back to orbit<small>leave the surface</small>';
    up.onclick = () => { this.toggleMenu(false); this.leaveSurface(); };
    sw.appendChild(up);

    // ---- wardrobe ----
    const photo = $('photo');
    photo.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      $('wardrobeMsg').textContent = 'reading ' + f.name;
      try {
        const { palette, size } = await this.wardrobe.loadPhoto(f);
        this.wardrobe.attach(this.character);
        $('wardrobeMsg').textContent = `${size[0]}x${size[1]} applied`;
        $('swatches').innerHTML = palette
          .map((c) => `<i style="background:${c.hex}" title="${c.hex}"></i>`).join('');
        if (!this.thirdPerson) {
          this.thirdPerson = true;
          this.character.setVisible(this.character.loaded);
          $('sView').textContent = 'third';
        }
      } catch (err) {
        $('wardrobeMsg').textContent = 'could not read that image';
      }
    });
    $('wClear').onclick = () => {
      this.wardrobe.clear();
      photo.value = '';
      $('swatches').innerHTML = '';
      $('wardrobeMsg').textContent = 'suit reset';
    };
    $('wScale').oninput = (e) => this.wardrobe.setScale(+e.target.value / 100);
    $('wHeight').oninput = (e) => this.wardrobe.setHeight(+e.target.value / 100);
    $('wDye').oninput = (e) => this.wardrobe.setDye(+e.target.value / 100);

    $('menu').addEventListener('click', (e) => {
      if (e.target.id === 'menu') this.toggleMenu(false);
    });
  }

  /**
   * Controls panel: rebinding grid plus tunable sliders.
   * Rebinding captures the next physical keydown, so it works for keys that
   * have no printable character and for keys not currently bound to anything.
   */
  buildSettingsUI() {
    const S = this.settings;
    const bindWrap = $('bindList');
    const tuneWrap = $('tuneList');

    const renderBindings = () => {
      bindWrap.innerHTML = '';
      let lastGroup = null;
      for (const [key, a] of Object.entries(ACTIONS)) {
        if (a.group !== lastGroup) {
          lastGroup = a.group;
          const h = document.createElement('div');
          h.className = 'bindGroup';
          h.textContent = a.group;
          bindWrap.appendChild(h);
        }
        const row = document.createElement('div');
        row.className = 'bindRow';

        const name = document.createElement('span');
        name.className = 'bindName';
        name.textContent = a.label;
        if (a.context) {
          const tag = document.createElement('i');
          tag.textContent = a.context === 'space' ? 'flight' : 'on foot';
          name.appendChild(tag);
        }
        row.appendChild(name);

        const slots = document.createElement('div');
        slots.className = 'bindSlots';
        const codes = S.keysFor(key);
        const shown = Math.max(codes.length, 1);

        for (let i = 0; i < shown; i++) {
          const b = document.createElement('button');
          b.className = 'keycap' + (a.locked ? ' locked' : '');
          b.textContent = prettyKey(codes[i]);
          b.title = a.locked ? 'Menu cannot be rebound' : 'Click, then press a key';
          if (!a.locked) {
            b.onclick = () => this._captureKey(key, i, b, renderBindings);
            b.oncontextmenu = (ev) => {
              ev.preventDefault();
              if (S.keysFor(key).length > 1) { S.unbind(key, i); renderBindings(); }
            };
          }
          slots.appendChild(b);
        }

        if (!a.locked && codes.length < 3) {
          const add = document.createElement('button');
          add.className = 'keycap add';
          add.textContent = '+';
          add.title = 'Add an alternative key';
          add.onclick = () => this._captureKey(key, codes.length, add, renderBindings);
          slots.appendChild(add);
        }

        row.appendChild(slots);
        bindWrap.appendChild(row);
      }
    };

    const renderTunables = () => {
      tuneWrap.innerHTML = '';
      let lastGroup = null;
      for (const [key, t] of Object.entries(TUNABLES)) {
        if (t.group !== lastGroup) {
          lastGroup = t.group;
          const h = document.createElement('div');
          h.className = 'bindGroup';
          h.textContent = t.group;
          tuneWrap.appendChild(h);
        }
        const row = document.createElement('div');
        row.className = 'tuneRow';

        const name = document.createElement('span');
        name.className = 'bindName';
        name.textContent = t.label;
        row.appendChild(name);

        if (t.bool) {
          const b = document.createElement('button');
          const paint = () => {
            const on = !!S.get(key);
            b.className = 'toggle' + (on ? ' on' : '');
            b.textContent = on ? 'On' : 'Off';
          };
          b.onclick = () => { S.set(key, !S.get(key)); paint(); };
          paint();
          row.appendChild(b);
        } else {
          const inp = document.createElement('input');
          inp.type = 'range';
          inp.min = t.min; inp.max = t.max; inp.step = t.step;
          inp.value = S.get(key);
          const val = document.createElement('span');
          val.className = 'tuneVal';
          val.textContent = t.fmt ? t.fmt(S.get(key)) : S.get(key);
          inp.oninput = () => {
            S.set(key, +inp.value);
            val.textContent = t.fmt ? t.fmt(+inp.value) : inp.value;
          };
          row.appendChild(inp);
          row.appendChild(val);
        }
        tuneWrap.appendChild(row);
      }
    };

    const renderHint = () => {
      const k = (a) => `<kbd>${prettyKey(S.keysFor(a)[0])}</kbd>`;
      $('hint').innerHTML =
        `${k('forward')}${k('left')}${k('back')}${k('right')} move &nbsp; ` +
        `${k('up')}/${k('down')} up&middot;down<br>` +
        `${k('rollLeft')}${k('rollRight')} roll &nbsp; ${k('boost')} boost &nbsp; ` +
        `${k('brake')} brake<br>` +
        `<kbd>scroll</kbd> throttle &nbsp; ${k('view')} view &nbsp; ${k('land')} land<br>` +
        `${k('jetpack')} jetpack &nbsp; ${k('mode')} mode &nbsp; ${k('menu')} menu`;
    };

    renderBindings();
    renderTunables();
    renderHint();
    S.onChange((what) => { if (what === 'bindings' || what === 'reset') renderHint(); });

    $('resetBinds').onclick = () => { S.resetBindings(); renderBindings(); };
    $('resetAll').onclick = () => {
      S.resetAll();
      renderBindings(); renderTunables(); this.applySettings();
    };

    // Tab between the two panes.
    document.querySelectorAll('[data-pane]').forEach((el) => {
      el.onclick = () => {
        document.querySelectorAll('[data-pane]').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
        $('paneBinds').style.display = el.dataset.pane === 'binds' ? 'block' : 'none';
        $('paneTune').style.display = el.dataset.pane === 'tune' ? 'block' : 'none';
      };
    });
  }

  /** Swallow the next keydown and assign it. */
  _captureKey(action, slot, button, rerender) {
    if (this._capturing) return;
    this._capturing = true;

    const prev = button.textContent;
    button.textContent = 'press…';
    button.classList.add('capturing');

    const finish = () => {
      this._capturing = false;
      window.removeEventListener('keydown', onKey, true);
      button.classList.remove('capturing');
    };

    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { button.textContent = prev; finish(); return; }
      const stolen = this.settings.bind(action, e.code, slot);
      finish();
      rerender();
      $('bindMsg').textContent = stolen
        ? `${prettyKey(e.code)} taken from “${ACTIONS[stolen].label}” — a key drives one action.`
        : `${ACTIONS[action].label} → ${prettyKey(e.code)}`;
    };

    // Capture phase, so this beats the game's own keydown handler.
    window.addEventListener('keydown', onKey, true);
  }

  syncMenu() {
    const cur = this._preset || MODES[this.mode].preset;
    document.querySelectorAll('[data-preset]').forEach((el) =>
      el.classList.toggle('sel', el.dataset.preset === cur));
    document.querySelectorAll('[data-q]').forEach((el) =>
      el.classList.toggle('sel', el.dataset.q === this.engine.qualityKey));
  }

  /**
   * Interstellar uses parsecs where the solar system uses thousands of km -
   * a factor of 3e10 - so it gets its own camera rather than trying to make
   * one frustum span both.
   */
  enterInterstellar() {
    if (this.inInterstellar || this.onSurface) return;
    this.inInterstellar = true;

    const cam = this.interstellar.camera;
    cam.fov = this.engine.camera.fov;
    cam.position.set(0, 0.35, 1.1);   // just outside Sol, looking back in
    cam.lookAt(0, 0, 0);

    // Parsec-scale throttle: 0.001 pc (200 AU) up to 40,000 pc, which crosses
    // the galaxy. Same logarithmic feel, entirely different magnitudes.
    this._savedSpeeds = [this.controls.minSpeed, this.controls.maxSpeed];
    this.controls.minSpeed = 1e-3;
    this.controls.maxSpeed = 4e4;
    this.controls.camera = cam;
    this.controls.velocity.set(0, 0, 0);
    this.controls.throttle = 0.34;

    $('mName').textContent = 'Interstellar';
    this.audio.applyPreset('deep', 6);
  }

  leaveInterstellar() {
    if (!this.inInterstellar) return;
    this.inInterstellar = false;
    this.controls.camera = this.engine.camera;
    const sp = this._savedSpeeds || [1e-3, 3e4];
    this.controls.minSpeed = sp[0];
    this.controls.maxSpeed = sp[1];
    this.controls.velocity.set(0, 0, 0);
    this.setMode(this.mode);
  }

  /** Drop onto a walkable world. Space keeps running underneath, paused. */
  async land(key) {
    if (this.onSurface) return;
    const w = WORLDS[key];
    $('loadTxt').textContent = 'descending to ' + w.name;
    $('load').style.display = 'grid';
    $('load').classList.remove('gone');
    $('enter').style.display = 'none';
    $('enterHint').style.display = 'none';
    await new Promise((r) => setTimeout(r, 60));   // let the overlay paint

    await this.surface.load(key, this.character);
    this.onSurface = true;
    this.controls.enabled = false;      // flight controls do not apply here
    this.wardrobe.attach(this.character);

    $('mName').textContent = w.name;
    $('tName').textContent = w.name;
    $('tBlurb').textContent = w.blurb;
    $('load').classList.add('gone');
    setTimeout(() => { $('load').style.display = 'none'; }, 900);
  }

  leaveSurface() {
    if (!this.onSurface) return;
    const key = this.surface.worldKey;
    this.surface.dispose();
    this.onSurface = false;
    this.controls.enabled = true;
    this.character.setVisible(this.thirdPerson);
    // Come back in orbit above whatever you were standing on.
    const body = this.system.bodies.find((b) => b.key === key)
      || this.system.bodies.find((b) => b.key === 'earth');
    const target = body.moons.find((m) => m.key === key) || body;
    this.jumpTo({ pos: target.worldPos.clone(), r: target.radius });
    this.setMode(this.mode);
  }

  jumpTo({ pos, r }) {
    const cam = this.engine.camera;
    const off = new THREE.Vector3(0.35, 0.28, 1).normalize().multiplyScalar(r * 5.5);
    cam.position.copy(pos).add(off);
    cam.lookAt(pos);
    this.controls.velocity.set(0, 0, 0);
    this.controls.angular.set(0, 0, 0);
  }

  // -----------------------------------------------------------------

  loop = () => {
    this._raf = requestAnimationFrame(this.loop);
    this.step();
  };

  /** One frame. Split out so it can be driven manually. */
  step = (forceDt) => {
    const dt = forceDt ?? Math.min(this.clock.getDelta(), 0.1);
    const now = performance.now();

    this.breathEnv = this.audio.update(dt);
    this.controls.breath = this.breathEnv;

    if (this.onSurface) { this.stepSurface(dt, now); return; }
    if (this.inInterstellar) { this.stepInterstellar(dt, now); return; }

    this.system.update(dt, this.engine.camera.position);

    // Ride along with whatever body you are close to, so accelerated time
    // does not fling the planet out from under you.
    this.engine.camera.position.add(
      this.system.frameLockDelta(this.engine.camera.position, this._lockDelta),
    );

    const near = this.system.nearest(this.engine.camera.position);

    // A probe you are closer to than any planet becomes the named target.
    const nc = this.debris.nearestCraft(this.engine.camera.position);
    if (nc.craft && nc.dist < near.dist && nc.dist < 4000) {
      near.body = nc.craft;
      near.dist = nc.dist;
    }

    this.controls.surfaceDist = Math.max(near.dist, 0.02);

    this.controls.update(dt);

    // Rest mode keeps you off the surface. You may visit; you may not land.
    if (this.mode === 'rest' && near.body) {
      const floor = near.body.radius * 1.35;
      const d = this.engine.camera.position.distanceTo(near.body.worldPos);
      if (d < floor) {
        const push = this.engine.camera.position.clone()
          .sub(near.body.worldPos).normalize().multiplyScalar(floor);
        this.engine.camera.position.copy(near.body.worldPos).add(push);
        this.controls.velocity.multiplyScalar(0.25);
      }
    }

    const rs = this.engine.renderSize;
    this.starfield.update(this.engine.camera, dt, rs.h);
    this.debris.update(this.engine.camera.position, dt, rs.h, this.system.sun.position);

    // Exposure breathes very slightly with the pacer. Below the threshold of
    // noticing it, above the threshold of feeling it.
    this.engine.renderer.toneMappingExposure = 1.0 + (this.breathEnv - 0.5) * 0.07;

    if (this.thirdPerson && this.character.loaded) {
      const ceiling = Math.max(this.controls.speedCeiling, 1e-6);
      this._sunDirCam = this._sunDirCam || new THREE.Vector3();
      // Sun direction in camera space, so the body is lit by the real star.
      this._sunDirCam.copy(this.system.sun.position)
        .sub(this.engine.camera.position).normalize()
        .applyQuaternion(this.engine.camera.quaternion.clone().invert());

      this.character.update(dt, {
        speed01: Math.min(1, this.controls.speed / ceiling),
        turn: this.controls.angular,
        sunDir: this._sunDirCam,
        breath: this.breathEnv,
        thrusting: this.controls.keys.has('KeyW') || this.controls.keys.has('KeyR'),
      });
    }

    this.engine.render(dt * 1000, now);
    if (this.thirdPerson) this.character.render(this.engine.renderer);

    this._hudAcc += dt;
    if (this._hudAcc > 0.1) { this._hudAcc = 0; this.updateHud(near, rs); }
  };

  /** Interstellar frame. Parsec scale, its own scene and camera. */
  stepInterstellar(dt, now) {
    const cam = this.interstellar.camera;
    const near = this.interstellar.nearest(cam.position);
    this.controls.surfaceDist = Math.max(near.dist, 1e-4);
    this.controls.update(dt);

    const rs = this.engine.renderSize;
    this.interstellar.update(dt, cam.position, rs.h);

    cam.aspect = this.engine.camera.aspect;
    cam.fov = this.engine.camera.fov;
    cam.updateProjectionMatrix();

    const cw = this.engine.canvas.clientWidth, ch = this.engine.canvas.clientHeight;
    if (cw !== this.engine._lastW || ch !== this.engine._lastH) {
      this.engine._lastW = cw; this.engine._lastH = ch;
      this.engine.resize();
    }
    if (!this.engine.viewportOk) return;
    this.engine._govern(dt * 1000, now);
    this.interstellar.render(this.engine.renderer, cam);

    this._hudAcc += dt;
    if (this._hudAcc > 0.1) {
      this._hudAcc = 0;
      $('sFps').textContent = this.engine.fps ? this.engine.fps.toFixed(0) : '--';
      $('sRes').textContent = rs.w + '\u00d7' + rs.h;
      $('sFrame').textContent = 'galactic';
      $('sView').textContent = 'map';
      $('sDate').textContent = this.interstellar.systems.length + ' systems';
      if (near.body) {
        $('tName').textContent = near.body.name;
        $('tBlurb').textContent = near.body.blurb || '';
        $('tDist').textContent = Interstellar.fmtDistance(near.dist);
      }
      // Light-years per second is the only speed unit that means anything here.
      const lyps = this.controls.speed * 3.26156;
      $('fSpeed').textContent = lyps < 1
        ? (lyps * 1000).toFixed(0) + ' mly/s'
        : lyps.toFixed(1) + ' ly/s';
      $('thrFill').style.width = (this.controls.throttle * 100).toFixed(0) + '%';
      const b = this.audio.breathState();
      $('bRing').setAttribute('r', (22 + this.breathEnv * 28).toFixed(1));
      $('bProg').setAttribute('stroke-dashoffset', (326.7 * (1 - b.phase)).toFixed(1));
      $('bWord').textContent = b.label === 'in' ? 'in' : b.label === 'out' ? 'out' : '\u00b7';
    }
  }

  /** Surface frame: a completely separate scene, so none of the space work runs. */
  stepSurface(dt, now) {
    this.surface.update(dt, this.controls.keys, this.controls.angular, this.breathEnv);

    this.engine.renderer.toneMappingExposure = 1.0 + (this.breathEnv - 0.5) * 0.05;
    const cw = this.engine.canvas.clientWidth, ch = this.engine.canvas.clientHeight;
    if (cw !== this.engine._lastW || ch !== this.engine._lastH) {
      this.engine._lastW = cw; this.engine._lastH = ch;
      this.engine.resize();
    }
    if (!this.engine.viewportOk) return;
    this.engine._govern(dt * 1000, now);
    this.surface.render(this.engine.renderer);

    this._hudAcc += dt;
    if (this._hudAcc > 0.1) {
      this._hudAcc = 0;
      const rs = this.engine.renderSize;
      $('sFps').textContent = this.engine.fps ? this.engine.fps.toFixed(0) : '--';
      $('sRes').textContent = `${rs.w}×${rs.h}`;
      $('sFrame').textContent = this.surface.w.name;
      $('sView').textContent = this.surface.flying ? 'flying' : 'walking';
      $('fSpeed').textContent = this.surface.speed.toFixed(1) + ' m/s';
      $('tDist').textContent = this.surface.altitude < 0.4
        ? `gravity ${this.surface.w.gravity.toFixed(2)} m/s²`
        : `${this.surface.altitude.toFixed(0)} m up`;
      const b = this.audio.breathState();
      $('bRing').setAttribute('r', (22 + this.breathEnv * 28).toFixed(1));
      $('bProg').setAttribute('stroke-dashoffset', (326.7 * (1 - b.phase)).toFixed(1));
      $('bWord').textContent = b.label === 'in' ? 'in' : b.label === 'out' ? 'out' : '·';
    }
  }

  updateHud(near, rs) {
    if (!this.showHud) return;

    if (near.body) {
      $('tName').textContent = near.body.name;
      $('tBlurb').textContent = near.body.blurb || '';
      $('tDist').textContent = fmtDist(near.dist);
    }

    $('sFps').textContent = this.engine.fps ? this.engine.fps.toFixed(0) : '--';
    $('sRes').textContent = `${rs.w}×${rs.h}`;
    $('sDate').textContent = this.system.date.toISOString().slice(0, 10);
    const anch = this.system.frameAnchor;
    $('sFrame').textContent = anch ? anch.name : 'heliocentric';

    const el = $('sRes');
    el.className = rs.h >= 2000 ? 'warn' : '';

    $('fSpeed').textContent = fmtSpeed(this.controls.speed);
    $('thrFill').style.width = (this.controls.throttle * 100).toFixed(0) + '%';

    // Breath ring: radius tracks the envelope, the arc tracks cycle progress.
    const b = this.audio.breathState();
    const r = 22 + this.breathEnv * 28;
    $('bRing').setAttribute('r', r.toFixed(1));
    $('bProg').setAttribute('stroke-dashoffset', (326.7 * (1 - b.phase)).toFixed(1));
    $('bWord').textContent = b.label === 'in' ? 'in' : b.label === 'out' ? 'out' : '·';
  }
}

// ---------------------------------------------------------------------------

function fmtDist(u) {
  const km = u * 1000;
  if (km < 0) return 'inside';
  if (km < 1000) return km.toFixed(0) + ' km';
  if (km < 1e6) return (km / 1000).toFixed(0) + ' thousand km';
  if (km / 149597870.7 < 0.02) return (km / 1e6).toFixed(2) + ' million km';
  return (km / 149597870.7).toFixed(3) + ' AU';
}

function fmtSpeed(u) {
  const kms = u * 1000;
  if (kms < 1) return (kms * 1000).toFixed(0) + ' m/s';
  if (kms < 299792) return kms.toFixed(0) + ' km/s';
  return (kms / 299792.458).toFixed(2) + ' × c';
}

function fmtTimeScale(s) {
  if (s < 2) return 'real time';
  if (s < 3600) return s.toFixed(0) + '×';
  if (s < 86400) return (s / 3600).toFixed(1) + ' hr/s';
  if (s < 86400 * 365) return (s / 86400).toFixed(1) + ' day/s';
  return (s / (86400 * 365.25)).toFixed(1) + ' yr/s';
}

const game = new Game();

// Exposed deliberately: lets you inspect state from the console, and lets a
// harness step a frame by hand where requestAnimationFrame is throttled
// (embedded preview panes, offscreen tabs).
window.__game = game;

game.boot().catch((e) => {
  console.error(e);
  $('loadTxt').textContent = 'Failed: ' + e.message;
  $('loadTxt').style.color = '#E0705A';
});
