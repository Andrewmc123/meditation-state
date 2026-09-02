import * as THREE from 'three';

/**
 * Photo -> clothing.
 *
 * What this honestly does, and does well:
 *   - Projects an uploaded image onto the body as a garment print, in object
 *     space, so it works on any rig regardless of how its UVs are laid out.
 *     Front and back are separate projections; the seam falls at the sides.
 *   - Extracts a palette from the photo and dyes the suit with it, so a
 *     photo of a jacket produces a suit in that jacket's colours even where
 *     the print itself does not reach.
 *
 * What it does not do: reconstruct 3D garment geometry from a 2D photo. That
 * needs a trained model (cloth draping / SMPL fitting) and cannot be faked
 * convincingly. Uploading a photo of a hoodie gives you a hoodie-coloured
 * suit printed with the hoodie, not modelled sleeves and a hood.
 */

const DECAL_VERT = /* glsl */ `
  varying vec3 vObjPos;
  varying vec3 vObjNrm;
`;

export class Wardrobe {
  constructor() {
    this.texture = null;
    this.palette = [];
    this.enabled = false;

    // Projection box in the model's object space, in metres. Defaults frame
    // the torso of a ~1.8 m humanoid standing at the origin.
    this.uniforms = {
      uDecal:     { value: null },
      uDecalOn:   { value: 0 },
      uCenter:    { value: new THREE.Vector3(0, 1.32, 0) },
      uSize:      { value: new THREE.Vector2(0.62, 0.72) },
      uOpacity:   { value: 1.0 },
      uWrap:      { value: 0.55 },  // how far round the sides it bleeds
      uTint:      { value: new THREE.Color(0xffffff) },
      uTintAmt:   { value: 0.0 },
      uAccent:    { value: new THREE.Color(0xffffff) },
    };

    this._materials = new Set();
  }

  // ---------------------------------------------------------------------

  /** Read a File/Blob into a texture and pull its palette. */
  async loadPhoto(file) {
    const bitmap = await createImageBitmap(file);

    // Cap the working size: phone photos are 4000px and the GPU gains nothing.
    const max = 2048;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, w, h);

    this.palette = extractPalette(g, w, h, 5);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;

    this.texture?.dispose?.();
    this.texture = tex;
    this.sourceCanvas = c;

    this.uniforms.uDecal.value = tex;
    this.uniforms.uDecalOn.value = 1;
    this.enabled = true;

    // Dye the suit with the two most prominent colours.
    if (this.palette.length) {
      this.uniforms.uTint.value.setRGB(...this.palette[0].rgbLinear);
      this.uniforms.uAccent.value.setRGB(...(this.palette[1] || this.palette[0]).rgbLinear);
      this.uniforms.uTintAmt.value = 0.62;
    }

    bitmap.close?.();
    return { palette: this.palette, size: [w, h] };
  }

  clear() {
    this.uniforms.uDecalOn.value = 0;
    this.uniforms.uTintAmt.value = 0;
    this.enabled = false;
  }

  setOpacity(v) { this.uniforms.uOpacity.value = v; }
  setDye(v) { this.uniforms.uTintAmt.value = v; }
  setScale(v) { this.uniforms.uSize.value.set(0.62 * v, 0.72 * v); }
  setHeight(v) { this.uniforms.uCenter.value.y = v; }
  setWrap(v) { this.uniforms.uWrap.value = v; }

  // ---------------------------------------------------------------------

  /**
   * Inject the projection into every skinned material on the character.
   * Object-space position is taken before skinning so the print stays put on
   * the garment instead of swimming as the limbs move.
   */
  attach(character) {
    for (const mesh of character.skinned || []) {
      const mats = [].concat(mesh.material);
      for (const mat of mats) {
        if (this._materials.has(mat)) continue;
        this._materials.add(mat);
        this._inject(mat);
      }
    }
  }

  _inject(mat) {
    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${DECAL_VERT}`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           // Bind-pose position: the garment print must not slide when the
           // skeleton moves, so sample before skinning is applied.
           vObjPos = position;
           vObjNrm = normal;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vObjPos;
          varying vec3 vObjNrm;
          uniform sampler2D uDecal;
          uniform float uDecalOn;
          uniform vec3  uCenter;
          uniform vec2  uSize;
          uniform float uOpacity;
          uniform float uWrap;
          uniform vec3  uTint;
          uniform vec3  uAccent;
          uniform float uTintAmt;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          if (uTintAmt > 0.001) {
            // Dye by luminance so the suit's own shading survives the recolour.
            float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            vec3 dyed = mix(uTint, uAccent, smoothstep(0.35, 0.85, l)) * (0.35 + l * 1.15);
            diffuseColor.rgb = mix(diffuseColor.rgb, dyed, uTintAmt);
          }

          if (uDecalOn > 0.5) {
            vec3 n = normalize(vObjNrm);
            // Front and back are projected separately; sign of the normal's
            // Z picks which, and the back copy is mirrored so text is not
            // reversed when you orbit behind.
            float facing = n.z;
            float front = step(0.0, facing);
            vec2 duv = (vObjPos.xy - uCenter.xy) / uSize + 0.5;
            // Mirror one of the two copies so text reads correctly from both
            // sides rather than being reversed on whichever side you orbit to.
            duv.x = mix(1.0 - duv.x, duv.x, front);

            if (duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0) {
              // No manual V flip here: three.js already sets flipY on the
              // texture, so inverting again turns the print upside down.
              vec4 d = texture2D(uDecal, duv);
              // Fade where the surface turns away, so it wraps round the ribs
              // instead of stopping at a hard edge.
              float grazing = smoothstep(0.0, uWrap, abs(facing));
              // Soft border so the print does not end in a rectangle.
              float edge = smoothstep(0.0, 0.10, duv.x) * smoothstep(1.0, 0.90, duv.x)
                         * smoothstep(0.0, 0.10, duv.y) * smoothstep(1.0, 0.90, duv.y);
              diffuseColor.rgb = mix(diffuseColor.rgb, d.rgb,
                                     d.a * uOpacity * grazing * edge);
            }
          }`);
    };
    mat.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------

/**
 * Dominant colours by coarse quantisation. Full k-means is overkill here:
 * bucketing into a 5-bit-per-channel grid and ranking by population gives
 * stable, sensible garment colours in about a millisecond.
 */
function extractPalette(ctx, w, h, count = 5) {
  const step = Math.max(1, Math.floor(Math.max(w, h) / 160));
  const data = ctx.getImageData(0, 0, w, h).data;
  const bins = new Map();

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 200) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];

      // Skip near-black and near-white: backgrounds and shadows, not garment.
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 26 || mn > 242) continue;

      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const e = bins.get(key);
      if (e) { e.r += r; e.g += g; e.b += b; e.n++; }
      else bins.set(key, { r, g, b, n: 1 });
    }
  }

  return [...bins.values()]
    .sort((a, z) => z.n - a.n)
    .slice(0, count)
    .map((e) => {
      const r = e.r / e.n / 255, g = e.g / e.n / 255, b = e.b / e.n / 255;
      const c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
      return {
        hex: '#' + c.getHexString(),
        rgb: [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)],
        rgbLinear: [c.r, c.g, c.b],
        weight: e.n,
      };
    });
}
