#!/usr/bin/env node
// Build a compact IMDb ratings map from IMDb's official (free, non-commercial)
// datasets, bundled so the app can show + sort by trustworthy ratings offline.
// Output: build/imdb-ratings.json.gz  — { "<normalized-title>|<year>": [rating, votes] }
// Skips if the output already exists (like download-ffmpeg.js).
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'imdb-ratings.json.gz');
const CACHE = path.join(ROOT, 'build', '.imdb-cache');
const BASE = 'https://datasets.imdbws.com/';
const RATINGS = 'title.ratings.tsv.gz';
const BASICS = 'title.basics.tsv.gz';
const TYPES = new Set(['movie', 'tvMovie', 'tvSeries', 'tvMiniSeries']);

function norm(s) {
  s = (s || '').toLowerCase().trim().replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  return s.startsWith('the ') ? s.slice(4) : s;
}

function download(file) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    console.log(`[imdb] cached ${file}`);
    return Promise.resolve(dest);
  }
  console.log(`[imdb] downloading ${file}...`);
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    https.get(BASE + file, (r) => {
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`HTTP ${r.statusCode} for ${file}`)); }
      r.pipe(f);
      f.on('finish', () => f.close(() => resolve(dest)));
    }).on('error', reject);
  });
}

function eachLine(gzPath, onLine) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(gzPath).pipe(zlib.createGunzip()) });
    let first = true;
    rl.on('line', (l) => { if (first) { first = false; return; } onLine(l); });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

async function main() {
  if (fs.existsSync(OUT)) { console.log('[imdb] imdb-ratings.json.gz already present — skipping'); return; }
  fs.mkdirSync(CACHE, { recursive: true });

  const ratingsPath = await download(RATINGS);
  const basicsPath = await download(BASICS);

  console.log('[imdb] parsing ratings...');
  const ratings = new Map();
  await eachLine(ratingsPath, (l) => {
    const [t, a, v] = l.split('\t');
    ratings.set(t, [parseFloat(a), parseInt(v, 10)]);
  });
  console.log(`[imdb] ratings: ${ratings.size.toLocaleString()}`);

  console.log('[imdb] building title+year map...');
  const mp = Object.create(null);
  await eachLine(basicsPath, (l) => {
    const p = l.split('\t');
    if (!TYPES.has(p[1])) return;
    const r = ratings.get(p[0]);
    if (!r || p[5] === '\\N') return;
    const titles = p[2] === p[3] ? [p[2]] : [p[2], p[3]];
    for (const t of titles) {
      const k = `${norm(t)}|${p[5]}`;
      const c = mp[k];
      if (!c || r[1] > c[1]) mp[k] = r; // keep the most-voted on collisions
    }
  });
  console.log(`[imdb] map keys: ${Object.keys(mp).length.toLocaleString()}`);

  fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(JSON.stringify(mp))));
  console.log(`[imdb] wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => { console.error('[imdb] build failed:', e.message); process.exit(1); });
