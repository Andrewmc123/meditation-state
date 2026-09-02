# Attribution

Every asset and data source in this project is free to use. Several **require
attribution**, and one is **non-commercial**. If you ship this, the notices
below have to go somewhere visible — the in-game menu footer already carries a
short form of them.

---

## Requires attribution

### Planetary and solar textures — CC BY 4.0
**Solar System Scope** — https://www.solarsystemscope.com/textures/
Equirectangular maps built from NASA imagery (Blue Marble, and mission data
for the other bodies). Free for any purpose including commercial, with credit.

> Textures by Solar System Scope (solarsystemscope.com), CC BY 4.0.

Files: `public/tex/*` (8K sources plus the 4K/2K levels derived from them).
Derived levels are the same licence.

### Star catalogue — CC BY-SA 2.5
**HYG Database v4.1** — astronexus — https://codeberg.org/astronexus/hyg
A merge of Hipparcos, Yale Bright Star and Gliese. 119,626 stars.

> Star data from the HYG Database by David Nash, CC BY-SA 2.5.

Note **ShareAlike**: `public/data/stars.bin` and `stars-named.json` are derived
works and carry the same licence. The rendering code that reads them does not.

Files: `tools/raw/hyg.csv` → `public/data/stars.bin`, `stars-named.json`.

---

## Public domain

### Orbital elements
**NASA JPL** — Keplerian elements for the major planets, epoch J2000,
valid 1800–2050. https://ssd.jpl.nasa.gov/planets/approx_pos.html
US Government work, no restriction.

Files: `src/core/constants.js`.

### Exoplanets
**NASA Exoplanet Archive** (Caltech / IPAC under NASA contract) —
`pscomppars` table via TAP. 3,736 systems within 500 pc.
https://exoplanetarchive.ipac.caltech.edu/

Courtesy acknowledgement is requested rather than required:

> This research has made use of the NASA Exoplanet Archive, operated by the
> California Institute of Technology under contract with NASA under the
> Exoplanet Exploration Program.

Files: `public/data/exoplanets.json`.

---

## Permissive code licences

### three.js — MIT
https://github.com/mrdoob/three.js — renderer, loaders, post-processing.

### Xbot / Soldier / RobotExpressive — MIT
Shipped in the three.js examples. Rigged humanoids with Mixamo-style
skeletons and animation clips.

Files: `public/models/*.glb`. Currently only `Xbot.glb` is used; the other two
are alternates.

### Vite — MIT · sharp — Apache-2.0
Build tooling only; neither ships in the output.

### Fonts — SIL Open Font License 1.1
Cormorant Garamond and IBM Plex Mono, via Google Fonts.

---

## Considered and not used

**Ready Player Me** — the obvious choice for photo-to-avatar, and its API is
free. Two reasons it is not wired in:

1. Avatars created on their site are **CC BY-NC-SA 4.0** — non-commercial and
   ShareAlike. That is a licence you have to choose deliberately, not inherit
   by accident.
2. Their domains did not resolve from this build environment, so it could not
   be verified end to end.

The character loader takes any glTF/GLB, so an RPM avatar URL drops straight in
if you want it — just make the licence call first.

---

## Summary

| Asset | Licence | Attribution | Commercial |
|---|---|---|---|
| Solar System Scope textures | CC BY 4.0 | Required | Yes |
| HYG star catalogue | CC BY-SA 2.5 | Required + ShareAlike | Yes |
| JPL orbital elements | Public domain | No | Yes |
| NASA Exoplanet Archive | Public domain | Requested | Yes |
| three.js + example models | MIT | Licence text | Yes |
| Cormorant Garamond, IBM Plex Mono | OFL 1.1 | Licence text | Yes |

Nothing here was scraped from a commercial game. NASA and ESA imagery is both
the best space imagery that exists and free of restriction, which makes the
legal route also the better-looking one.
