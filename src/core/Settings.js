/**
 * User settings: key bindings and movement/camera tunables, persisted.
 *
 * Everything that reads input goes through here rather than checking
 * `keys.has('KeyW')` directly. That indirection is the whole point - it is
 * what makes rebinding possible without hunting hardcoded codes through the
 * flight controller, the surface controller and the menu handlers.
 *
 * An action can hold several keys, so WASD and the arrow keys can both drive
 * forward without one having to win.
 */

const STORAGE_KEY = 'meditation-state.settings.v1';

/**
 * Default bindings. `groups` order is the order they appear in the UI.
 * `contexts` says where the action applies, purely so the settings panel can
 * tell you a binding is only relevant on foot or only relevant in flight.
 */
export const ACTIONS = {
  forward:    { label: 'Forward',        group: 'Movement', keys: ['KeyW', 'ArrowUp'] },
  back:       { label: 'Back',           group: 'Movement', keys: ['KeyS', 'ArrowDown'] },
  left:       { label: 'Left',           group: 'Movement', keys: ['KeyA', 'ArrowLeft'] },
  right:      { label: 'Right',          group: 'Movement', keys: ['KeyD', 'ArrowRight'] },
  up:         { label: 'Up / Jump',      group: 'Movement', keys: ['Space'] },
  down:       { label: 'Down / Descend', group: 'Movement', keys: ['ControlLeft'] },
  run:        { label: 'Run / Boost',    group: 'Movement', keys: ['ShiftLeft'] },

  rollLeft:   { label: 'Roll left',      group: 'Flight',   keys: ['KeyQ'], context: 'space' },
  rollRight:  { label: 'Roll right',     group: 'Flight',   keys: ['KeyE'], context: 'space' },
  boost:      { label: 'Afterburner',    group: 'Flight',   keys: ['KeyR'], context: 'space' },
  brake:      { label: 'Brake',          group: 'Flight',   keys: ['KeyX'], context: 'space' },

  jetpack:    { label: 'Jetpack toggle', group: 'Surface',  keys: ['KeyF'], edge: true, context: 'surface' },

  land:       { label: 'Land / Leave',   group: 'General',  keys: ['KeyL'], edge: true },
  interstellar: { label: 'Interstellar', group: 'General',  keys: ['KeyG'], edge: true },
  view:       { label: 'First / third',  group: 'General',  keys: ['KeyV'], edge: true },
  mode:       { label: 'Cycle mode',     group: 'General',  keys: ['Tab'],  edge: true },
  hud:        { label: 'Toggle HUD',     group: 'General',  keys: ['KeyH'], edge: true },
  menu:       { label: 'Menu',           group: 'General',  keys: ['Escape'], edge: true, locked: true },
};

/**
 * Tunables. `apply` names what reads it, so nothing here is a dead slider.
 */
export const TUNABLES = {
  mouseSensitivity: {
    label: 'Mouse sensitivity', group: 'Look',
    min: 0.15, max: 3.0, step: 0.05, def: 1.0,
    fmt: (v) => v.toFixed(2) + '×',
  },
  invertY: {
    label: 'Invert vertical look', group: 'Look', bool: true, def: false,
  },
  lookSmoothing: {
    label: 'Look smoothing', group: 'Look',
    min: 0, max: 1, step: 0.05, def: 0.5,
    fmt: (v) => (v < 0.05 ? 'off' : v.toFixed(2)),
  },
  fov: {
    label: 'Field of view', group: 'Camera',
    min: 55, max: 105, step: 1, def: 62,
    fmt: (v) => v.toFixed(0) + '°',
  },
  camDistance: {
    label: 'Third-person distance', group: 'Camera',
    min: 0.4, max: 2.6, step: 0.05, def: 1.0,
    fmt: (v) => v.toFixed(2) + '×',
  },
  camHeight: {
    label: 'Camera height', group: 'Camera',
    min: -0.8, max: 1.2, step: 0.05, def: 0,
    fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + ' m',
  },
  camShoulder: {
    label: 'Shoulder offset', group: 'Camera',
    min: -1.2, max: 1.2, step: 0.05, def: 0.38,
    fmt: (v) => v.toFixed(2) + ' m',
  },

  walkSpeed: {
    label: 'Walk speed', group: 'On foot',
    min: 1.0, max: 9.0, step: 0.1, def: 3.4,
    fmt: (v) => v.toFixed(1) + ' m/s',
  },
  runSpeed: {
    label: 'Run speed', group: 'On foot',
    min: 3.0, max: 26.0, step: 0.2, def: 8.4,
    fmt: (v) => v.toFixed(1) + ' m/s',
  },
  jumpHeight: {
    label: 'Jump height', group: 'On foot',
    min: 0.3, max: 6.0, step: 0.05, def: 1.35,
    fmt: (v) => v.toFixed(2) + ' m',
  },
  groundGrip: {
    label: 'Ground grip', group: 'On foot',
    min: 3, max: 30, step: 0.5, def: 11,
    fmt: (v) => v.toFixed(1),
  },
  jetpackPower: {
    label: 'Jetpack power', group: 'On foot',
    min: 1.0, max: 6.0, step: 0.1, def: 2.6,
    fmt: (v) => v.toFixed(1) + '× g',
  },

  flightDamping: {
    label: 'Flight drag', group: 'In flight',
    min: 0.3, max: 4.0, step: 0.05, def: 1.35,
    fmt: (v) => v.toFixed(2),
  },
  boostMultiplier: {
    label: 'Afterburner', group: 'In flight',
    min: 1.5, max: 12.0, step: 0.5, def: 4.0,
    fmt: (v) => v.toFixed(1) + '×',
  },
  turnDamping: {
    label: 'Turn settle', group: 'In flight',
    min: 2.0, max: 20.0, step: 0.5, def: 9.0,
    fmt: (v) => v.toFixed(1),
  },
  proximityBrake: {
    label: 'Auto-slow near bodies', group: 'In flight',
    min: 0.1, max: 2.0, step: 0.05, def: 0.55,
    fmt: (v) => v.toFixed(2) + '×',
  },
};

// ---------------------------------------------------------------------------

export class Settings {
  constructor() {
    this.bindings = {};
    this.values = {};
    this.keys = new Set();          // live, set by whoever owns the listeners
    this._edgeConsumed = new Set();
    this._listeners = new Set();

    this.resetAll(true);
    this.load();
  }

  attachKeys(set) { this.keys = set; }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(what) { for (const fn of this._listeners) fn(what, this); }

  // ---- persistence ---------------------------------------------------

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      // Merge rather than replace: a build that adds a new action or tunable
      // must not wipe the user's existing choices, and must not leave the new
      // one undefined either.
      for (const [k, v] of Object.entries(saved.bindings || {})) {
        if (ACTIONS[k] && Array.isArray(v)) this.bindings[k] = v.slice();
      }
      for (const [k, v] of Object.entries(saved.values || {})) {
        if (TUNABLES[k]) this.values[k] = v;
      }
    } catch {
      // Corrupt or unavailable storage (private mode, disabled site data) is
      // not worth failing the whole app over - defaults are already loaded.
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        bindings: this.bindings, values: this.values,
      }));
    } catch { /* see load() */ }
  }

  resetAll(silent = false) {
    for (const [k, a] of Object.entries(ACTIONS)) this.bindings[k] = a.keys.slice();
    for (const [k, t] of Object.entries(TUNABLES)) this.values[k] = t.def;
    if (!silent) { this.save(); this._emit('reset'); }
  }

  resetBindings() {
    for (const [k, a] of Object.entries(ACTIONS)) this.bindings[k] = a.keys.slice();
    this.save();
    this._emit('bindings');
  }

  // ---- tunables ------------------------------------------------------

  get(key) {
    const v = this.values[key];
    return v === undefined ? TUNABLES[key]?.def : v;
  }

  set(key, value) {
    const t = TUNABLES[key];
    if (!t) return;
    if (t.bool) this.values[key] = !!value;
    else this.values[key] = Math.min(t.max, Math.max(t.min, Number(value)));
    this.save();
    this._emit(key);
  }

  // ---- bindings ------------------------------------------------------

  keysFor(action) { return this.bindings[action] || []; }

  /** Which action a physical key currently drives, if any. */
  actionFor(code) {
    for (const [a, list] of Object.entries(this.bindings)) {
      if (list.includes(code)) return a;
    }
    return null;
  }

  /**
   * Bind `code` to `action`. A key drives exactly one action, so binding it
   * here removes it from wherever it was - otherwise you end up with a key
   * that both jumps and opens the menu and no way to tell which fires first.
   * Returns the action it was taken from, or null.
   */
  bind(action, code, slot = 0) {
    if (!ACTIONS[action] || ACTIONS[action].locked) return null;
    let stolenFrom = null;

    for (const [a, list] of Object.entries(this.bindings)) {
      const i = list.indexOf(code);
      if (i === -1) continue;
      if (a === action && i === slot) return null;   // already there
      list.splice(i, 1);
      if (a !== action) stolenFrom = a;
    }

    const list = this.bindings[action];
    if (slot < list.length) list[slot] = code;
    else list.push(code);

    this.save();
    this._emit('bindings');
    return stolenFrom;
  }

  unbind(action, slot) {
    const list = this.bindings[action];
    if (!list || ACTIONS[action]?.locked) return;
    list.splice(slot, 1);
    this.save();
    this._emit('bindings');
  }

  // ---- queries -------------------------------------------------------

  /** Is any key bound to this action currently held? */
  down(action) {
    const list = this.bindings[action];
    if (!list) return false;
    for (const c of list) if (this.keys.has(c)) return true;
    return false;
  }

  /**
   * Edge-triggered: true once per physical press. Used for toggles, so
   * holding the key does not flap the state every frame.
   */
  pressed(action) {
    const list = this.bindings[action];
    if (!list) return false;
    let held = false;
    for (const c of list) if (this.keys.has(c)) { held = true; break; }
    if (!held) { this._edgeConsumed.delete(action); return false; }
    if (this._edgeConsumed.has(action)) return false;
    this._edgeConsumed.add(action);
    return true;
  }

  /** Mouse deltas, after sensitivity and inversion. */
  lookScale() { return this.get('mouseSensitivity'); }
  invertY() { return !!this.get('invertY'); }
}

/** "KeyW" -> "W", "ArrowUp" -> "Up", for the settings panel. */
export function prettyKey(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  const map = {
    Space: 'Space', Escape: 'Esc', Tab: 'Tab', Enter: 'Enter',
    ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
    AltLeft: 'L Alt', AltRight: 'R Alt',
    Backquote: '`', Minus: '−', Equal: '=', Comma: ',', Period: '.',
    Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', CapsLock: 'Caps',
  };
  return map[code] || code;
}
