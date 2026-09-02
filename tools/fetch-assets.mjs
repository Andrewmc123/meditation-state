/**
 * Acquires every external asset the game uses.
 * All sources are free and permissively licensed - see LICENSES.md.
 * Run: node tools/fetch-assets.mjs
 */
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEX = path.join(ROOT, 'public', 'tex');
const DATA = path.join(ROOT, 'public', 'data');
const RAW  = path.join(ROOT, 'tools', 'raw');

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
  '8k_earth_normal_map.jpg',
  '8k_earth_specular_map.jpg',
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
const EXO_QUERY = `select pl_name,hostname,sy_dist,pl_rade,pl_bmasse,pl_orbper,pl_orbsmax,pl_eqt,st_teff,st_rad,st_mass,ra,dec,discoverymethod,disc_year
from pscomppars
where sy_dist is not null and sy_dist < 500
order by sy_dist asc`;

// --- Rigged characters, MIT, from the three.js examples --------------------
const MODELS_BASE = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/';
const MODELS = ['Xbot.glb', 'Soldier.glb', 'RobotExpressive/RobotExpressive.glb'];

const UA = { 'User-Agent': 'MeditationStateApp/1.0 (asset fetch)' };

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
    await pipeline(res.body, createWriteStream(dest));
    const s = await stat(dest);
    if (s.size < 1024) throw new Error('suspiciously small: ' + s.size + ' bytes');
    console.log(`  ok    ${label}  ${human(s.size)}`);
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

  console.log('\n[1/3] Planetary textures - Solar System Scope, CC BY 4.0');
  let ok = 0;
  // Serial: the host throttles parallel bursts and starts serving HTML error pages.
  for (const f of TEXTURES) {
    if (await download(SSS + f, path.join(TEX, f), f)) ok++;
  }
  console.log(`      ${ok}/${TEXTURES.length} textures`);

  console.log('\n[2/3] HYG star catalogue v4.1 - astronexus, CC BY-SA 2.5');
  await download(HYG, path.join(RAW, 'hyg.csv'), 'hygdata_v41.csv');

  console.log('\n[3/3] Confirmed exoplanets - NASA Exoplanet Archive, public domain');
  try {
    const url = `${EXO_TAP}?query=${encodeURIComponent(EXO_QUERY)}&format=json`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = await res.json();
    await writeFile(path.join(DATA, 'exoplanets.json'), JSON.stringify(rows));
    console.log(`  ok    exoplanets.json  ${rows.length} systems within 500 pc`);
  } catch (e) {
    console.log(`  FAIL  exoplanets  ${e.message}`);
  }

  console.log('\nDone.\n');
}

main();
