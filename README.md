# Dimensions

Fly through geometric worlds shaped by your music. Big drops warp you into the next dimension.

A single page (`public/index.html`): a WebGL kaleidoscope tunnel driven by the Web Audio API.
No framework, no build, no server.

## Using it
- **Choose songs:** pick one or more audio files. They play in order and the tunnel reacts to
  them. Nothing is uploaded; the files stay in your browser.
- **Use microphone:** reacts to music playing out loud nearby (the mic isn't sent to the speakers,
  so there's no feedback).
- **Drift in silence:** a gentle, self-running version.
- **Drag** to look around, **double-tap** or press **Warp** to jump to the next dimension. A big
  bass drop warps you automatically (at most every 9 seconds).

There are five dimensions (Indigo Hex, Ember Tetra, Jade Cube, Ultraviolet Octa, Solar Dodeca),
each with its own symmetry and colours. The chakra dots are a symbolic frequency map, not a
measurement.

## Run it locally
Any static file server works. With Python:
```bash
python -m http.server 5173 --directory public
```
Then open http://localhost:5173. (The microphone only works on `localhost` or HTTPS.)

## Put it online (Render)
`render.yaml` is a [Render Blueprint](https://render.com/docs/blueprint-spec). In Render choose
**New > Blueprint** and point it at this repository. There's no build: Render publishes the
`public/` folder as a static site, with security headers and microphone permission set.

## Credits
Font: [Syne](https://fonts.google.com/specimen/Syne) (SIL Open Font License), loaded from Google Fonts.
