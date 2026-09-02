/**
 * Turns the raw downloads into things a browser can actually load.
 *
 *  1. HYG CSV (34 MB of text) -> packed Float32 binary (~2 MB).
 *  2. Every 8K texture -> a 2K/4K/8K pyramid, so the renderer can pick a
 *     level by distance instead of holding 19 8K maps in VRAM at once.
 *     On integrated graphics that difference is the whole ballgame.
 *
 * Run: node tools/build-catalog.mjs
 */
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');
const RAW  = path.join(ROOT, 'tools', 'raw');
const TEX = path.join(ROOT, 'public', 'tex');

// ---------------------------------------------------------------------------
// 1. Star catalogue
// ---------------------------------------------------------------------------

/**
 * B-V colour index -> approximate RGB.
 * Piecewise fit to the standard main-sequence colour track: hot O/B stars are
 * blue-white around B-V = -0.3, the Sun sits at +0.65, M dwarfs run red past
 * +1.6. Good enough that the constellations come out the right colours.
 */
function bvToRGB(bv) {
  const t = Math.max(-0.4, Math.min(2.0, bv));
  let r, g, b;
  if (t < 0.0) { r = 0.61 + 0.11 * t + 0.1 * t * t; g = 0.70 + 0.07 * t + 0.1 * t * t; b = 1.0; }
  else if (t < 0.4) { r = 0.83 + 0.17 * t; g = 0.87 + 0.11 * t; b = 1.0; }
  else if (t < 1.6) { r = 1.0; g = 0.98 - 0.16 * (t - 0.4); b = 1.0 - 0.47 * (t - 0.4); }
  else { r = 1.0; g = 0.82 - 0.5 * (t - 1.6); b = 0.44 - 0.1 * (t - 1.6); }
  return [
    Math.max(0, Math.min(1, r)),
    Math.max(0, Math.min(1, g)),
    Math.max(0, Math.min(1, b)),
  ];
}

async function buildStars() {
  console.log('\n[stars] reading HYG catalogue...');
  const csv = await readFile(path.join(RAW, 'hyg.csv'), 'utf8');
  const lines = csv.split('\n');

  // HYG quotes its header names and quotes string values inconsistently.
  const unq = (s) => (s || '').trim().replace(/^"(.*)"$/, '$1');
  const head = lines[0].split(',').map(unq);

  const col = {};
  head.forEach((h, i) => (col[h] = i));
  const need = ['x', 'y', 'z', 'mag', 'ci', 'proper', 'dist', 'bayer', 'con'];
  for (const k of need) {
    if (col[k] === undefined) console.log(`  warn: no column "${k}"`);
  }

  const xs = [], named = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const L = lines[i];
    if (!L) continue;
    const f = L.split(',');

    const x = parseFloat(f[col.x]);
    const y = parseFloat(f[col.y]);
    const z = parseFloat(f[col.z]);
    const mag = parseFloat(f[col.mag]);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(mag)) { skipped++; continue; }
    if (x === 0 && y === 0 && z === 0) { skipped++; continue; } // that row is Sol

    const ci = parseFloat(f[col.ci]);
    const bv = isFinite(ci) ? ci : 0.65;

    xs.push({ x, y, z, mag, bv });

    const proper = unq(f[col.proper]);
    if (proper && mag < 4.2) {
      named.push({
        n: proper,
        c: unq(f[col.con]),
        m: +mag.toFixed(2),
        d: +(parseFloat(f[col.dist]) || 0).toFixed(2),
        p: [+x.toFixed(3), +y.toFixed(3), +z.toFixed(3)],
      });
    }
  }

  // Brightest first, so the renderer can draw a subset and still get the sky right.
  xs.sort((a, b) => a.mag - b.mag);

  // Layout per star: x, y, z (parsecs), magnitude, r, g, b  = 7 float32 = 28 B
  const buf = new Float32Array(xs.length * 7);
  xs.forEach((s, i) => {
    const [r, g, b] = bvToRGB(s.bv);
    const o = i * 7;
    buf[o] = s.x; buf[o + 1] = s.y; buf[o + 2] = s.z;
    buf[o + 3] = s.mag;
    buf[o + 4] = r; buf[o + 5] = g; buf[o + 6] = b;
  });

  await writeFile(path.join(DATA, 'stars.bin'), Buffer.from(buf.buffer));
  named.sort((a, b) => a.m - b.m);
  await writeFile(path.join(DATA, 'stars-named.json'), JSON.stringify(named));

  console.log(`  ${xs.length} stars -> stars.bin (${(buf.byteLength / 1e6).toFixed(1)} MB)`);
  console.log(`  ${named.length} named stars brighter than mag 4.2`);
  console.log(`  ${skipped} rows skipped`);
}

// ---------------------------------------------------------------------------
// 2. Texture pyramid
// ---------------------------------------------------------------------------

const LEVELS = [
  { tag: '2k', w: 2048 },
  { tag: '4k', w: 4096 },
];

async function buildTextures() {
  const files = (await readdir(TEX)).filter(
    (f) => f.startsWith('8k_') && /\.(jpg|png)$/i.test(f),
  );
  if (!files.length) {
    console.log('\n[tex] no 8K maps present - nothing to downsample.');
    return;
  }
  console.log(`\n[tex] building resolution pyramid from ${files.length} maps...`);

  // Imported here rather than at module scope: a deploy that ships 2K never
  // resizes anything, and should not fail if sharp's native binary is missing.
  const { default: sharp } = await import('sharp');

  for (const f of files) {
    const src = path.join(TEX, f);
    const isPng = f.toLowerCase().endsWith('.png');
    const meta = await sharp(src).metadata();

    for (const lv of LEVELS) {
      if (meta.width <= lv.w) continue;
      const out = path.join(TEX, f.replace(/^8k_/, lv.tag + '_'));
      try {
        const s = await stat(out);
        if (s.size > 1024) continue; // already built
      } catch { /* build it */ }

      const pipe = sharp(src).resize(lv.w, Math.round(lv.w / 2), { kernel: 'lanczos3' });
      if (isPng) await pipe.png({ compressionLevel: 9 }).toFile(out);
      else await pipe.jpeg({ quality: 88, mozjpeg: true }).toFile(out);

      const s = await stat(out);
      console.log(`  ${path.basename(out)}  ${(s.size / 1e6).toFixed(1)} MB`);
    }
  }
}

/**
 * Browsers cannot decode TIFF, and upstream ships Earth's normal and specular
 * maps only in that format. Convert whatever arrived, then drop the source.
 */
async function convertTiffs() {
  const tifs = (await readdir(TEX)).filter((f) => /\.tiff?$/i.test(f));
  if (!tifs.length) return;
  const { default: sharp } = await import('sharp');
  const { unlink } = await import('node:fs/promises');
  console.log('\n[tex] converting TIFF sources...');

  for (const f of tifs) {
    const src = path.join(TEX, f);

    // A failed download can leave an HTML error page sitting at a .tif path.
    // Handing that to sharp threw "Input file contains unsupported image
    // format" and took the whole build down, which is the wrong response to
    // one bad file: drop it and let the verify step decide if it mattered.
    const { readFile: rf } = await import('node:fs/promises');
    const head = (await rf(src)).subarray(0, 4);
    const isTiff = (head[0] === 0x49 && head[1] === 0x49)   // little-endian
                || (head[0] === 0x4d && head[1] === 0x4d);  // big-endian
    if (!isTiff) {
      console.log(`  skip ${f} - not a TIFF (${head.length ? [...head].map((b) => b.toString(16)).join(' ') : 'empty'})`);
      await unlink(src);
      continue;
    }

    const out = f.replace(/\.tiff?$/i, '.jpg');
    await sharp(src).jpeg({ quality: 90, mozjpeg: true })
      .toFile(path.join(TEX, out));
    await unlink(src);
    console.log(`  ${f} -> ${out}`);
  }
}

/**
 * Drop the 8K sources once the 4K level exists. Deploy builds use this: the
 * renderer's LOD walks down a level when a file is missing, so the site tops
 * out at 4K instead of shipping 45 MB that nobody downloads.
 */
async function prune8k() {
  const { unlink } = await import('node:fs/promises');
  const all = await readdir(TEX);
  const files = all.filter((f) => f.startsWith('8k_'));
  let freed = 0, pruned = 0, kept = [];

  for (const f of files) {
    // Only prune a source that actually produced a 4K level. Several of the
    // upstream "8k_" maps are narrower than 4096 - Jupiter, Saturn and the Sun
    // among them - so the pyramid skips them, and deleting those would leave
    // the body at 2K. They are small precisely because they are low
    // resolution, so keeping them costs almost nothing.
    const derived = all.includes(f.replace(/^8k_/, '4k_'));
    if (!derived) { kept.push(f.replace(/^8k_/, '')); continue; }
    freed += (await stat(path.join(TEX, f))).size;
    await unlink(path.join(TEX, f));
    pruned++;
  }

  if (pruned) {
    console.log(`\n[tex] pruned ${pruned} 8K maps (${(freed / 1e6).toFixed(0)} MB freed)`);
  }
  if (kept.length) {
    console.log(`[tex] kept ${kept.length} without a 4K level: ${kept.join(', ')}`);
  }
}

/**
 * Refuse to finish a build that would publish a broken site.
 *
 * The asset fetcher deliberately tolerates a failed download - one missing
 * texture just means the LOD serves a lower level. But a missing catalogue is
 * not survivable: without exoplanets.json interstellar mode loads zero systems
 * and the feature is silently gone. A green deploy that ships that is worse
 * than a red one. This check turns a real 218-second archive timeout from an
 * invisible regression into a failed build.
 */
async function verify() {
  const required = [
    ['data/stars.bin', 1_000_000, 'the star catalogue'],
    ['data/exoplanets.json', 200_000, 'the exoplanet archive'],
    ['models/Xbot.glb', 500_000, 'the default character'],
  ];

  const missing = [];
  for (const [rel, minBytes, what] of required) {
    try {
      const s = await stat(path.join(ROOT, 'public', rel));
      if (s.size < minBytes) missing.push(`${rel} is only ${s.size} bytes - ${what}`);
    } catch {
      missing.push(`${rel} is missing - ${what}`);
    }
  }

  // At least one map, at any resolution, per body you can land on.
  const tex = await readdir(TEX).catch(() => []);
  for (const body of ['earth_daymap', 'mars', 'moon']) {
    if (!tex.some((f) => f.endsWith(`_${body}.jpg`))) {
      missing.push(`no texture at any resolution for ${body}`);
    }
  }

  if (missing.length) {
    console.error('\n[verify] FAILED - refusing to publish an incomplete build:');
    for (const m of missing) console.error('  - ' + m);
    console.error('');
    process.exit(1);
  }
  console.log('\n[verify] required assets present.');
}

async function main() {
  await mkdir(DATA, { recursive: true });
  await buildStars();
  await convertTiffs();
  await buildTextures();
  if (process.argv.includes('--prune-8k')) await prune8k();
  await verify();
  console.log('\nDone.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
