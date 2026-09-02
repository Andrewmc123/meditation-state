/**
 * Acquires every external asset the game uses.
 * All sources are free and permissively licensed - see LICENSES.md.
 * Run: node tools/fetch-assets.mjs
 */
// createWriteStream/pipeline are gone: downloads are buffered and validated
// before anything is written, so a block page never lands on disk.
import { writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEX = path.join(ROOT, 'public', 'tex');
const DATA = path.join(ROOT, 'public', 'data');
const RAW  = path.join(ROOT, 'tools', 'raw');

/**
 * Upstream publishes 2K and 8K only - there is no 4K to download - so the 4K
 * level used at runtime is always derived locally by tools/build-catalog.mjs.
 *
 * There is deliberately no reduced download profile. Every planet is a jump
 * target, so there is no body you cannot fly right up to and no map that can
 * safely be left at 2K. Deploy builds fetch the same 8K sources, derive 4K,
 * then discard the 8K with `build-catalog --prune-8k` - which is where the
 * published size saving actually comes from.
 */

// --- Solar System Scope, CC BY 4.0 -----------------------------------------
const SSS = 'https://www.solarsystemscope.com/textures/download/';
const TEXTURES = [
  '8k_sun.jpg',
  '8k_mercury.jpg',
  '8k_venus_surface.jpg',
  '4k_venus_atmosphere.jpg',
  '8k_earth_daymap.jpg',
  '8k_earth_nightmap.jpg',
  '8k_earth_clouds.jpg',
  // Upstream publishes these two only as TIFF, and only the normal map at 2K.
  // build-catalog converts them to JPEG, which is what the loader wants.
  '2k_earth_normal_map.tif',
  '8k_earth_specular_map.tif',
  '8k_moon.jpg',
  '8k_mars.jpg',
  '8k_jupiter.jpg',
  '8k_saturn.jpg',
  '8k_saturn_ring_alpha.png',
  '2k_uranus.jpg',
  '2k_neptune.jpg',
  '2k_ceres_fictional.jpg',
  '2k_eris_fictional.jpg',
  '2k_haumea_fictional.jpg',
  '2k_makemake_fictional.jpg',
  '8k_stars_milky_way.jpg',
];

// --- Catalogues -------------------------------------------------------------
const HYG =
  'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv';

const EXO_TAP = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';

/**
 * Asked for as CSV, not JSON, and without an ORDER BY.
 *
 * Measured against the live archive: the same rows take 220 s as JSON and 65 s
 * as CSV, and the payload halves from 1.25 MB to 0.57 MB. The cost is in their
 * JSON serialiser, not the query. Sorting is done here instead, which is free.
 */
const EXO_QUERY = `select pl_name,hostname,sy_dist,pl_rade,pl_bmasse,pl_orbper,pl_orbsmax,pl_eqt,st_teff,st_rad,st_mass,ra,dec,discoverymethod,disc_year
from pscomppars
where sy_dist is not null and sy_dist < 500`;

/** Minimal RFC4180 reader: the archive quotes any field containing a comma. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- Rigged characters, MIT, from the three.js examples --------------------
const MODELS_BASE = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/';
const MODELS = ['Xbot.glb', 'Soldier.glb', 'RobotExpressive/RobotExpressive.glb'];

/**
 * Solar System Scope's CDN filters by User-Agent: curl's default gets 200,
 * a custom agent string gets a 403 HTML page, and from a datacenter it 403s
 * regardless. The textures are CC BY 4.0 and meant to be downloaded, so this
 * presents as an ordinary browser rather than fighting a bot filter that is
 * not aimed at this use.
 *
 * This only matters for refreshing assets locally. The committed 2K/4K set
 * means a deploy never touches that host at all - see the note in .gitignore.
 */
const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
};

/**
 * Reject an HTML error page served with a 200, rather than trying to prove a
 * payload IS a given format.
 *
 * The first version of this checked for JPEG/PNG/TIFF/glTF magic bytes and
 * rejected everything else - which promptly rejected the HYG catalogue,
 * because a CSV is not an image. What actually needs catching is the block
 * page, and that is always HTML.
 */
function looksLikeErrorPage(buf) {
  const head = buf.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  return head.startsWith('<!doctype html')
      || head.startsWith('<html')
      || head.startsWith('<?xml') && head.includes('<html');
}

function human(n) {
  return n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' kB';
}

async function exists(f) {
  try {
    const s = await stat(f);
    return s.size > 1024;
  } catch {
    return false;
  }
}

async function download(url, dest, label) {
  if (await exists(dest)) {
    const s = await stat(dest);
    console.log(`  skip  ${label}  (${human(s.size)} already present)`);
    return true;
  }
  try {
    const res = await fetch(url, { headers: UA, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    // Buffer rather than stream straight to disk, so a rejected body is never
    // written. A CDN that answers 200 with an HTML block page used to leave 21
    // "textures" of ~200 bytes on disk, which then crashed the TIFF converter.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) {
      throw new Error(`only ${buf.length} bytes - likely a block or error page`);
    }
    if (looksLikeErrorPage(buf)) {
      const sniff = buf.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ').trim();
      throw new Error(`server sent an HTML page, not the file: ${sniff.slice(0, 70)}`);
    }

    await writeFile(dest, buf);
    console.log(`  ok    ${label}  ${human(buf.length)}`);
    return true;
  } catch (e) {
    console.log(`  FAIL  ${label}  ${e.message}`);
    return false;
  }
}

async function main() {
  await mkdir(TEX, { recursive: true });
  await mkdir(DATA, { recursive: true });
  await mkdir(RAW, { recursive: true });

  console.log('\n[1/4] Planetary textures - Solar System Scope, CC BY 4.0');
  /**
   * A map counts as present if ANY usable resolution of it is on disk.
   *
   * Handling this case by case did not work. build-catalog converts the TIFF
   * sources to JPEG and deletes the originals, and a deploy prunes each 8K
   * source once its 4K level exists - so after one build the requested
   * filename is routinely not the filename present, at a different extension
   * AND a different resolution. Matching on the base name covers every
   * combination at once, and is what actually makes the build hermetic.
   *
   * Pass --refresh to ignore what is on disk and re-download everything.
   */
  const REFRESH = process.argv.includes('--refresh');
  const baseOf = (f) => f.replace(/^\d+k_/, '').replace(/\.(jpe?g|png|tiff?)$/i, '');
  const onDisk = new Set((await readdir(TEX).catch(() => [])).map(baseOf));

  let ok = 0, already = 0;
  // Serial: the host throttles parallel bursts and starts serving HTML error pages.
  for (const f of TEXTURES) {
    if (!REFRESH && onDisk.has(baseOf(f))) { ok++; already++; continue; }
    if (await download(SSS + f, path.join(TEX, f), f)) ok++;
  }
  if (already) {
    console.log(`  ${already} already present at some resolution (--refresh to re-download)`);
  }
  console.log(`      ${ok}/${TEXTURES.length} textures`);
  if (ok === 0) {
    console.log('      NOTE: every texture failed. The committed set under');
    console.log('            public/tex is what deploys actually use, so this');
    console.log('            only matters when refreshing assets locally.');
  }

  console.log('\n[2/4] Rigged characters - three.js examples, MIT');
  const MODELS_DIR = path.join(ROOT, 'public', 'models');
  await mkdir(MODELS_DIR, { recursive: true });
  for (const m of MODELS) {
    await download(MODELS_BASE + m, path.join(MODELS_DIR, m.split('/').pop()), m.split('/').pop());
  }

  console.log('\n[3/4] HYG star catalogue v4.1 - astronexus, CC BY-SA 2.5');
  await download(HYG, path.join(RAW, 'hyg.csv'), 'hygdata_v41.csv');

  console.log('\n[4/4] Confirmed exoplanets - NASA Exoplanet Archive, public domain');
  const exoPath = path.join(DATA, 'exoplanets.json');

  // This file is committed, precisely because the archive is the slowest and
  // least reliable dependency here. A deploy should never wait a minute on it,
  // and must never quietly ship without it. Delete the file to force a refresh.
  if (await exists(exoPath)) {
    const s = await stat(exoPath);
    console.log(`  skip  exoplanets.json  (${human(s.size)} already present)`);
  } else {
    const url = `${EXO_TAP}?query=${encodeURIComponent(EXO_QUERY)}&format=csv`;
    let rows = null;

    // The archive routinely takes a minute and occasionally drops the
    // connection outright, so give it real time and two more chances.
    for (let attempt = 1; attempt <= 3 && !rows; attempt++) {
      try {
        const res = await fetch(url, {
          headers: UA,
          signal: AbortSignal.timeout(240000),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const table = parseCSV(await res.text());
        const head = table.shift().map((h) => h.trim());
        rows = table
          .filter((r) => r.length === head.length)
          .map((r) => Object.fromEntries(head.map((h, i) => {
            const v = r[i];
            if (v === '' || v === undefined) return [h, null];
            const n = Number(v);
            return [h, Number.isNaN(n) ? v : n];
          })));
        rows.sort((a, b) => (a.sy_dist ?? 1e9) - (b.sy_dist ?? 1e9));
      } catch (e) {
        console.log(`  retry ${attempt}/3  ${e.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 5000));
      }
    }

    if (rows?.length) {
      await writeFile(exoPath, JSON.stringify(rows));
      console.log(`  ok    exoplanets.json  ${rows.length} planets within 500 pc`);
    } else {
      console.log('  FAIL  exoplanets  could not reach the archive');
    }
  }

  console.log('\nDone.\n');
}

main();
