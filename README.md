# Meditation State

A meditative space sim. Real astronomical data, live-synthesised audio, and a
third-person body that space-walks between the planets.

```bash
npm install
npm run assets     # downloads ~90 MB of textures and catalogues (once)
npm run catalog    # builds the star binary + texture pyramid (once)
npm run dev
```

Then open http://localhost:5173.

---

## What is actually real in here

| Thing | Source | Real? |
|---|---|---|
| 119,626 stars, true positions and colours | HYG catalogue v4.1 | Yes — constellations are correct |
| Planet positions | JPL Keplerian elements, solved per frame | Yes — set the date, they're where they are |
| Planet radii, rotation rates, axial tilts | JPL / IAU | Exact |
| Surface maps | Solar System Scope (from NASA imagery) | 8K, real imagery |
| 3,736 exoplanet systems within 500 pc | NASA Exoplanet Archive | Downloaded, not yet rendered |
| Breath pacing at 6/min | Baroreflex resonance, 0.1 Hz | Yes — see the research brief |
| Sunlight falloff | Compressed `pow 0.35`, not inverse-square | **No** — true 1/r² leaves Neptune black |
| Time rate | Accelerated by default | **No** — or nothing appears to move |

Everything that departs from physical truth is commented at the point where it
departs, and says why.

---

## Controls

**Everything below is rebindable** — `Esc` → Controls. Click a key to reassign,
right-click to remove an alternative, `Esc` mid-capture to cancel. Each action
holds up to three keys, so WASD and the arrows both work out of the box.

A key drives exactly one action: binding a key that is already in use takes it
from wherever it was and tells you which action lost it. The only fixed binding
is `Esc` for the menu, because a rebind that leaves you unable to reach the menu
is a rebind you cannot undo.

Settings persist to `localStorage` and are merged on load, so a build that adds
a new action will not wipe your existing bindings.

### Defaults

| Key | Action |
|---|---|
| `W A S D` | Fly |
| `Space` / `Shift` | Up / down |
| `Q` `E` | Roll |
| `R` | Boost (free roam only) |
| `X` | Brake |
| `scroll` | Throttle — logarithmic, 1 km/s to 30 M km/s |
| `mouse` | Look (pointer lock, or click-drag as fallback) |
| `V` | First / third person |
| `L` | Land on a surface / return to orbit |
| `F` | Jetpack (on a surface) |
| `Tab` | Cycle mode |
| `H` | Hide HUD |
| `G` | Interstellar mode |
| `1`–`9` | Emotes |
| `` ` `` | Hide emote bar |
| `Esc` | Menu |

### Tunables

`Esc` → Controls → Movement & camera. Sixteen sliders, grouped:

- **Look** — mouse sensitivity, invert vertical, look smoothing
- **Camera** — field of view, third-person distance, camera height, shoulder offset
- **On foot** — walk speed, run speed, jump height, ground grip, jetpack power
- **In flight** — flight drag, afterburner multiplier, turn settle, auto-slow near bodies

These drive the real values, not cosmetic copies. Set jump height to 4 m and
the measured apex is 4.03 m; set run speed to 18 and you run at exactly 18 m/s.
Jump height stays independent of gravity via `v = sqrt(2gh)`, so raising it
behaves the same on the Moon as on Earth.

### Characters and emotes

Three selectable characters, remembered between sessions:

| | Rig | Emotes |
|---|---|---|
| **Astra** | Mixamo human | 4 clips + 5 poses |
| **Vega** | Mixamo human, heavier | 5 poses |
| **Kepler** | Robot, own skeleton | 8 clips |

Emotes fire on the number keys, or from the bar (`` ` `` hides it). Two kinds,
because the free rigs do not ship the same clips:

- **Clip emotes** play an animation that came with the model. RobotExpressive
  has a real set — Dance, Wave, Sit, Stand, Yes, No, Thumbs up, Leap.
- **Pose emotes** are authored here as bone rotations and blended on. They
  exist because the poses this project actually wants — cross-legged
  **Meditate**, **Lie down**, **Float** in lotus, **Bow**, **Reach** — are in
  no free clip set. They need Mixamo bone names, so they are offered on the two
  human rigs.

Walking cancels an emote automatically; an emote you must cancel by hand before
you can move feels broken.

### Modes

- **Free roam** — everything unlocked, boost available, unpaced audio.
- **Meditative** — thrust breathes with the pacer. You accelerate on the inhale
  and coast on the exhale without touching the controls.
- **Rest** — drift only. You may approach a planet but not land; a floor at
  1.35 radii holds you off the surface.

---

## Architecture notes worth knowing

**One world unit = 1000 km.** Keeps the solar system inside float32 while
leaving Earth 6.371 units across. A logarithmic depth buffer covers metres to
30 AU without z-fighting.

**The character does not translate.** A 1.8 m human is 1.8e-6 world units —
below the near plane and deep in float mush. So the body lives in its own scene
at true human scale and renders as a second pass with the depth buffer cleared.
The world moves; the body banks, leans and poses in place. That is what reads
as flight.

**Reference-frame lock.** Inside ~60 body radii you inherit that body's orbital
motion; by 600 radii you are back in the Sun's frame, blended smoothly between.
Without it, accelerating time throws you off any planet you are near — Earth
covers 2.6 million km a day.

**Adaptive resolution.** A rolling median frame time walks the render scale
between 0.62× and the quality tier's target. Resolution degrades before effects
do, because a steady 60 matters more here than a sharp 24.

---

## About "4K"

Render scale is decoupled from window size. On a 1080p panel, **Vivid** renders
a 3840×2160 buffer and downsamples — real supersampling, sharper than native,
not merely bigger. On a 4K panel it is native.

Source textures are 8K, with 4K and 2K levels built at install time. The
renderer picks a level by distance: 8K inside 12 body radii, 4K to 90, 2K
beyond. Holding nineteen 8K maps resident at once would be ~2.5 GB of VRAM,
which is why the pyramid exists.

**On integrated graphics** (this machine: Intel Iris Xe), space scenes are the
good case — low geometry, low overdraw, mostly a skybox and some spheres. Vivid
is genuinely usable. Dense surface scenes would not be; that is the honest
limit, and it is a hardware limit, not a code one.

---

## Wardrobe

Upload any photo. It is projected onto the body as a garment print in object
space — front and back separately, seam at the sides, soft edges and a grazing
falloff so it wraps the ribs instead of ending in a rectangle. It works on any
rig regardless of UV layout. The photo's dominant colours are extracted and dye
the rest of the suit.

**It does not reconstruct 3D garment geometry.** That needs a trained cloth /
body-fitting model and cannot be faked convincingly. A photo of a hoodie gives
you a hoodie-coloured suit printed with the hoodie — not modelled sleeves and a
hood.

---

## Audio

Everything is synthesised in the Web Audio graph. No sample packs, so every
frequency is an exact number.

Five layers: a just-intonation drone bed with golden-ratio-spread drift LFOs, a
binaural pair (200 Hz carrier), an isochronic pulse, a brown-noise breath bed,
and a sub. The breath envelope is asymmetric — raised-cosine rise over the
inhale fraction, longer fall over the exhale — because exhale-longer-than-inhale
is the actual parasympathetic lever.

The same envelope drives the visuals, so the world and the sound breathe
together rather than merely near each other.

**Deliberately not implemented:** solfeggio "healing" frequencies. Invented in
1974; the claims attached to them are false. A=432 is offered as a tuning
preference and labelled as exactly that.

---

## The asteroid belt

Drawn twice, because it has to be:

- **Far field** — 26,000 points with the real radial distribution, real
  inclination spread, and the Kirkwood gaps (2.06, 2.5, 2.82, 2.95, 3.27 AU)
  cleared out. Inner belt runs brighter (S-type, stony), outer darker (C-type,
  carbonaceous) — the real compositional gradient. Plus 9,000 Kuiper objects
  from 30–50 AU.
- **Near field** — 200 real rocks, 1–40 km, tumbling, recycled in a shell that
  follows you. Charcoal albedo, because that is what asteroids are.

**Density in the near field is a lie, by roughly 10⁴.** A 40 km rock at
320,000 km subtends 0.13 of a pixel; the real belt averages ~1 million km
between neighbours, so an honest simulation is an empty screen. Sizes are real;
only spacing is faked. The far-field band is the truthful picture.

Voyager 1 and 2, Pioneer 10 and New Horizons sit at their real distances and
bearings, with beacons so you can find them. All are jump targets.

## Walkable surfaces

Press `L` near Earth, Mars or the Moon, or pick one from the menu. A surface is
a **completely separate scene at 1 unit = 1 metre** — the overlay trick that
puts the body over the space view cannot support walking, so the two scenes
never share a camera.

**Gravity is real, and it is the only thing that differs between worlds.**
Earth 9.807, Mars 3.721, Moon 1.625 m/s². The controller is identical; jump
height is fixed via `v = sqrt(2gh)`, so the same input hangs for ~0.9 s on
Earth and ~3.5 s on the Moon. Measured, not guessed.

- **Terrain** — domain-warped ridged fBm, chunked with four LOD rings out to
  1.3 km. The height function is plain JavaScript, not a shader, because the
  character controller has to sample the exact surface it stands on; displacing
  on the GPU and colliding on the CPU gives two different surfaces and a
  character that sinks into hills.
- **Resonance stones** — monoliths tuned to a just-intonation pentatonic.
  Walk within 18 m and one lights; within 11 m it sounds, once, with a 6 s
  cooldown. The landscape is an instrument you play by walking through it.
- **Airless skies show stars in full daylight**, because with no atmosphere
  there is nothing to scatter them out. It is one of the genuinely strange
  things about standing on the Moon.
- Contact shadow rather than shadow mapping — across a 1 km view distance on
  integrated graphics, a shadow map costs far more than the grounding cue is
  worth.

Runs at 60 fps at 2016×1134 on Iris Xe.

## Not built yet

- The 3,736 downloaded exoplanet systems are not yet rendered
- Surfaces exist for Earth, Mars and the Moon only
- No interiors, structures or NPCs — the stones are the only interactable

### Known cosmetic issues

- Near-field asteroids light flatter than they should. Geometry, normals and
  albedo all check out; the sun-lit terminator still reads weaker than
  expected. Cosmetic, not structural.
- Terrain chunk LOD boundaries can show a faint seam where a 64-segment chunk
  meets a 32-segment one. Standard skirt geometry would fix it.

See `LICENSES.md` for attribution — several sources require it.
