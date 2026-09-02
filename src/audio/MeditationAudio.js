/**
 * MeditationAudio - everything is synthesised live in the Web Audio graph.
 * No sample packs, so every frequency in here is an exact number rather than
 * whatever a stock loop happened to be mastered at.
 *
 * The numbers come from the research brief:
 *   - Breath pacing lives at 4.5-6.5 breaths/min. Six breaths/min is 0.1 Hz,
 *     the baroreflex resonance where HRV amplitude peaks (Lehrer & Gevirtz).
 *   - Binaural carriers stay under 1000 Hz and beat frequencies under 30 Hz;
 *     outside that range the superior olivary complex stops fusing them.
 *   - Isochronic pulses drive cortical following harder than binaural beats
 *     and need no headphones, so they are the default.
 *   - Exhale is always longer than inhale. That asymmetry is the actual
 *     parasympathetic lever, not the pitch of the drone.
 *
 * Deliberately NOT implemented: solfeggio "healing" frequencies. They were
 * invented in 1974 and the claims attached to them are false. A=432 is offered
 * purely as a tuning preference, labelled as such.
 */

const GOLDEN = 1.61803398875;

/** Named states. beat = binaural/isochronic rate in Hz. */
export const PRESETS = {
  resonance: {
    label: 'Resonance',
    note: 'Baroreflex coherence. The default.',
    breathBpm: 6.0, // 0.1 Hz
    inhale: 0.4, exhale: 0.6,
    beat: 10, // alpha
    rootHz: 110,
    brightness: 0.42,
    color: '#5FA8D3',
  },
  settle: {
    label: 'Settle',
    note: 'Long exhale. For coming down.',
    breathBpm: 5.0,
    inhale: 0.32, exhale: 0.68, // ~1:2
    beat: 7.5,
    rootHz: 82.41,
    brightness: 0.3,
    color: '#7B93B8',
  },
  deep: {
    label: 'Deep',
    note: 'Theta. Hypnagogic edge.',
    breathBpm: 4.5,
    inhale: 0.3, exhale: 0.7,
    beat: 5.5,
    rootHz: 65.41,
    brightness: 0.2,
    color: '#6E6A9E',
  },
  focus: {
    label: 'Focus',
    note: '40 Hz. Steady-state auditory drive.',
    breathBpm: 6.0,
    inhale: 0.45, exhale: 0.55,
    beat: 40,
    rootHz: 146.83,
    brightness: 0.62,
    color: '#D9A441',
  },
  drift: {
    label: 'Drift',
    note: 'No pacing. Free roam.',
    breathBpm: 0, // pacer off
    inhale: 0.5, exhale: 0.5,
    beat: 8,
    rootHz: 98,
    brightness: 0.5,
    color: '#8E7CC3',
  },
};

export class MeditationAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.preset = PRESETS.resonance;
    this.tuning = 440; // or 432, aesthetic only
    this.masterLevel = 0.55;
    this.breathPhase = 0; // 0..1 through one full cycle
    this._nodes = {};
    this._startedAt = 0;
  }

  /** Must be called from a user gesture. */
  async init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback', sampleRate: 48000 });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const ctx = this.ctx;
    const n = this._nodes;

    // ---- master chain -------------------------------------------------
    n.master = ctx.createGain();
    n.master.gain.value = 0;

    // Gentle bus compression so swells never spike.
    n.comp = ctx.createDynamicsCompressor();
    n.comp.threshold.value = -20;
    n.comp.knee.value = 24;
    n.comp.ratio.value = 3;
    n.comp.attack.value = 0.05;
    n.comp.release.value = 0.6;

    // Roll off the top so nothing ever gets shrill during long sessions.
    n.airLPF = ctx.createBiquadFilter();
    n.airLPF.type = 'lowpass';
    n.airLPF.frequency.value = 7200;
    n.airLPF.Q.value = 0.4;

    n.master.connect(n.comp);
    n.comp.connect(n.airLPF);
    n.airLPF.connect(ctx.destination);

    // ---- reverb (generated impulse, no external file) -------------------
    n.reverb = ctx.createConvolver();
    n.reverb.buffer = this._makeImpulse(6.5, 2.6);
    n.reverbSend = ctx.createGain();
    n.reverbSend.gain.value = 0.42;
    n.reverbSend.connect(n.reverb);
    n.reverb.connect(n.master);

    // ---- layer 1: drone bed --------------------------------------------
    // Five partials in just intonation, each detuned by a slow independent
    // LFO so the bed never sits perfectly still.
    n.droneGain = ctx.createGain();
    n.droneGain.gain.value = 0.0;
    n.droneGain.connect(n.master);
    n.droneGain.connect(n.reverbSend);

    n.droneFilter = ctx.createBiquadFilter();
    n.droneFilter.type = 'lowpass';
    n.droneFilter.frequency.value = 900;
    n.droneFilter.Q.value = 1.2;
    n.droneFilter.connect(n.droneGain);

    const ratios = [1, 1.5, 2, 3, 4.5]; // root, fifth, octave, twelfth, +fifth
    n.drones = ratios.map((r, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sine' : i < 3 ? 'sine' : 'triangle';
      osc.frequency.value = this.preset.rootHz * r;

      const g = ctx.createGain();
      g.gain.value = 0.28 / (i + 1.35);

      // Slow independent drift, periods spread by the golden ratio so they
      // never re-align into an audible pulse.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.021 * Math.pow(GOLDEN, i);
      const lfoAmt = ctx.createGain();
      lfoAmt.gain.value = osc.frequency.value * 0.0016;
      lfo.connect(lfoAmt);
      lfoAmt.connect(osc.detune);

      osc.connect(g);
      g.connect(n.droneFilter);
      osc.start();
      lfo.start();
      return { osc, g, lfo, ratio: r };
    });

    // ---- layer 2: binaural pair (headphones) ----------------------------
    n.binauralGain = ctx.createGain();
    n.binauralGain.gain.value = 0.0;
    n.binauralGain.connect(n.master);

    n.merger = ctx.createChannelMerger(2);
    n.merger.connect(n.binauralGain);

    const carrier = 200; // well inside the fusing range
    n.binL = ctx.createOscillator();
    n.binR = ctx.createOscillator();
    n.binL.type = n.binR.type = 'sine';
    n.binL.frequency.value = carrier;
    n.binR.frequency.value = carrier + this.preset.beat;

    const gl = ctx.createGain(), gr = ctx.createGain();
    gl.gain.value = gr.gain.value = 0.5;
    n.binL.connect(gl); gl.connect(n.merger, 0, 0);
    n.binR.connect(gr); gr.connect(n.merger, 0, 1);
    n.binL.start(); n.binR.start();

    // ---- layer 3: isochronic pulse (speakers) ---------------------------
    n.isoGain = ctx.createGain();
    n.isoGain.gain.value = 0.0;
    n.isoGain.connect(n.master);
    n.isoGain.connect(n.reverbSend);

    n.isoAmp = ctx.createGain();
    n.isoAmp.gain.value = 0.5;
    n.isoAmp.connect(n.isoGain);

    n.isoOsc = ctx.createOscillator();
    n.isoOsc.type = 'sine';
    n.isoOsc.frequency.value = this.preset.rootHz * 4;
    n.isoOsc.connect(n.isoAmp);
    n.isoOsc.start();

    // Square-ish LFO gates the amplitude - that gating is what drives the
    // auditory steady-state response.
    n.isoLFO = ctx.createOscillator();
    n.isoLFO.type = 'sine';
    n.isoLFO.frequency.value = this.preset.beat;
    n.isoLFOAmt = ctx.createGain();
    n.isoLFOAmt.gain.value = 0.5;
    n.isoLFO.connect(n.isoLFOAmt);
    n.isoLFOAmt.connect(n.isoAmp.gain);
    n.isoLFO.start();

    // ---- layer 4: breath bed --------------------------------------------
    // Filtered noise swelling at the breath rate. This is the pacing cue you
    // actually hear: brightness rises on the inhale, falls further and for
    // longer on the exhale.
    n.breathGain = ctx.createGain();
    n.breathGain.gain.value = 0.0;
    n.breathGain.connect(n.master);
    n.breathGain.connect(n.reverbSend);

    n.breathFilter = ctx.createBiquadFilter();
    n.breathFilter.type = 'bandpass';
    n.breathFilter.frequency.value = 420;
    n.breathFilter.Q.value = 0.9;
    n.breathFilter.connect(n.breathGain);

    n.noise = ctx.createBufferSource();
    n.noise.buffer = this._makeNoise(8);
    n.noise.loop = true;
    n.noise.connect(n.breathFilter);
    n.noise.start();

    // ---- layer 5: sub pulse ---------------------------------------------
    // One soft sine an octave below the root, swelling with the breath. Felt
    // more than heard on speakers; on headphones it is the body of the thing.
    n.subGain = ctx.createGain();
    n.subGain.gain.value = 0;
    n.subGain.connect(n.master);
    n.sub = ctx.createOscillator();
    n.sub.type = 'sine';
    n.sub.frequency.value = this.preset.rootHz / 2;
    n.sub.connect(n.subGain);
    n.sub.start();

    this.ready = true;
    this._startedAt = ctx.currentTime;
    this.applyPreset(this.preset, 0.01);
    this.fadeIn(4);
  }

  // ---------------------------------------------------------------------

  _makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Slight stereo decorrelation keeps the tail wide.
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (c ? 0.96 : 1);
      }
    }
    return buf;
  }

  _makeNoise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      // Brown noise - far gentler over long sessions than white.
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2;
      }
    }
    return buf;
  }

  // ---------------------------------------------------------------------

  fadeIn(sec = 4) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._nodes.master.gain.cancelScheduledValues(t);
    this._nodes.master.gain.setValueAtTime(this._nodes.master.gain.value, t);
    this._nodes.master.gain.linearRampToValueAtTime(this.masterLevel, t + sec);
  }

  fadeOut(sec = 3) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._nodes.master.gain.cancelScheduledValues(t);
    this._nodes.master.gain.setValueAtTime(this._nodes.master.gain.value, t);
    this._nodes.master.gain.linearRampToValueAtTime(0.0001, t + sec);
  }

  setMasterLevel(v) {
    this.masterLevel = Math.max(0, Math.min(1, v));
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._nodes.master.gain.linearRampToValueAtTime(this.masterLevel, t + 0.3);
  }

  /** 440 or 432. Purely a tuning preference - no claim attached. */
  setTuning(hz) {
    this.tuning = hz;
    if (this.ready) this.applyPreset(this.preset, 2.5);
  }

  setLayer(name, amount, ramp = 1.5) {
    if (!this.ready) return;
    const map = {
      drone: this._nodes.droneGain,
      binaural: this._nodes.binauralGain,
      isochronic: this._nodes.isoGain,
      breath: this._nodes.breathGain,
      sub: this._nodes.subGain,
    };
    const node = map[name];
    if (!node) return;
    const t = this.ctx.currentTime;
    node.gain.cancelScheduledValues(t);
    node.gain.setValueAtTime(node.gain.value, t);
    node.gain.linearRampToValueAtTime(amount, t + ramp);
  }

  /** Cross-fade the whole graph to a new state over `ramp` seconds. */
  applyPreset(preset, ramp = 6) {
    if (typeof preset === 'string') preset = PRESETS[preset];
    if (!preset) return;
    this.preset = preset;
    if (!this.ready) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = this._nodes;
    const scale = this.tuning / 440;
    const root = preset.rootHz * scale;

    n.drones.forEach((d) => {
      d.osc.frequency.cancelScheduledValues(t);
      d.osc.frequency.setValueAtTime(d.osc.frequency.value, t);
      d.osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, root * d.ratio), t + ramp,
      );
    });

    n.droneFilter.frequency.cancelScheduledValues(t);
    n.droneFilter.frequency.setValueAtTime(n.droneFilter.frequency.value, t);
    n.droneFilter.frequency.linearRampToValueAtTime(
      400 + preset.brightness * 2600, t + ramp,
    );

    n.sub.frequency.exponentialRampToValueAtTime(Math.max(20, root / 2), t + ramp);
    n.isoOsc.frequency.exponentialRampToValueAtTime(root * 4, t + ramp);

    const carrier = 200;
    n.binR.frequency.cancelScheduledValues(t);
    n.binR.frequency.setValueAtTime(n.binR.frequency.value, t);
    n.binR.frequency.linearRampToValueAtTime(carrier + preset.beat, t + ramp);

    n.isoLFO.frequency.cancelScheduledValues(t);
    n.isoLFO.frequency.setValueAtTime(n.isoLFO.frequency.value, t);
    n.isoLFO.frequency.linearRampToValueAtTime(preset.beat, t + ramp);

    n.breathFilter.frequency.linearRampToValueAtTime(
      280 + preset.brightness * 520, t + ramp,
    );
  }

  /**
   * Drive the breath cycle. Returns 0..1 envelope where 1 is full inhale.
   * Called every frame - the visuals read the same value, so the world and
   * the sound breathe together rather than merely near each other.
   */
  update(dt) {
    if (!this.ready) return 0;
    const p = this.preset;
    if (!p.breathBpm) {
      // Drift: no pacing, just a very slow ambient swell.
      this.breathPhase = (this.breathPhase + dt * 0.02) % 1;
      const env = 0.5 + 0.5 * Math.sin(this.breathPhase * Math.PI * 2);
      this._writeBreath(env, 0.35);
      return env;
    }

    const period = 60 / p.breathBpm;
    this.breathPhase = (this.breathPhase + dt / period) % 1;

    // Asymmetric envelope: rise over `inhale` fraction, fall over `exhale`.
    // Raised-cosine on each half so there is no corner at the turn.
    let env;
    const ph = this.breathPhase;
    if (ph < p.inhale) {
      env = 0.5 - 0.5 * Math.cos((ph / p.inhale) * Math.PI);
    } else {
      const e = (ph - p.inhale) / p.exhale;
      env = 0.5 + 0.5 * Math.cos(e * Math.PI);
    }

    this._writeBreath(env, 1);
    return env;
  }

  _writeBreath(env, depth) {
    const n = this._nodes;
    const t = this.ctx.currentTime;
    // setTargetAtTime smooths across frames without scheduling a ramp per tick.
    const TC = 0.06;
    n.breathFilter.frequency.setTargetAtTime(
      (280 + this.preset.brightness * 520) * (0.7 + env * 0.75), t, TC,
    );
    n.droneFilter.frequency.setTargetAtTime(
      (400 + this.preset.brightness * 2600) * (0.85 + env * 0.3), t, TC,
    );
    if (n.subGain.gain.value > 0.0005) {
      n.subGain.gain.setTargetAtTime(
        0.05 + env * 0.11 * depth, t, TC,
      );
    }
  }

  /** Where we are in the cycle, for the HUD. */
  breathState() {
    const p = this.preset;
    if (!p.breathBpm) return { label: 'drift', t: 0, phase: this.breathPhase };
    const ph = this.breathPhase;
    if (ph < p.inhale) {
      return { label: 'in', t: 1 - ph / p.inhale, phase: ph };
    }
    return { label: 'out', t: 1 - (ph - p.inhale) / p.exhale, phase: ph };
  }

  /**
   * A single struck tone, for the resonance stones. Two partials and a long
   * exponential tail - close enough to a struck bar, and it decays into the
   * drone bed instead of sitting on top of it.
   */
  chime(freq, gain = 0.18) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const scale = this.tuning / 440;
    const f = freq * scale;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(gain, t + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 5.5);
    out.connect(this._nodes.master);
    out.connect(this._nodes.reverbSend);

    // Fundamental plus a slightly sharp partial: real bars are inharmonic,
    // and a pure sine reads as a test tone rather than an object.
    [[1, 1], [2.76, 0.32]].forEach(([mult, amp]) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(amp, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (mult > 2 ? 1.6 : 5.5));
      o.connect(g); g.connect(out);
      o.start(t);
      o.stop(t + 6);
    });
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
}
