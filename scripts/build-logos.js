'use strict';
// Download a bundled channel-logo pack (tv-logo/tv-logos, MIT) and build a
// normalized name -> filename index, so the app can fall back to a local logo
// when the provider's stream_icon is missing or its host is dead/blocked.
//
// Run: node scripts/build-logos.js
// Output: public/logos/uk/*.png  +  public/logos/index.json
// Logos are committed to the repo (self-contained, offline) — this script is
// only for (re)generating them.

const fs = require('fs');
const path = require('path');
const https = require('https');

const COUNTRIES = ['united-kingdom', 'ireland'];
const OUT_DIR = path.join(__dirname, '..', 'public', 'logos');
const UK_DIR = path.join(OUT_DIR, 'uk');

// Shared normaliser — MUST mirror normLogoKey() in public/js/api.js.
function normKey(s) {
  return String(s)
    .toLowerCase()
    .replace(/\.png$/, '')
    .replace(/-uk$/, '')                 // filename country suffix
    .replace(/\bxtra\b/g, 'extra')       // "Comedy Central Xtra" -> extra
    .replace(/\+\s*1\b/g, 'plus')        // "+1" -> plus
    .replace(/\b(hd|sd|fhd|uhd|qhd|4k|hevc|h265|h264|vip|raw|backup|feed)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');         // drop spaces/punctuation
}

function getJson(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'xcplaylist-logo-build' } }, (r) => {
      if (r.statusCode === 302 || r.statusCode === 301) return res(getJson(r.headers.location));
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

function download(url, dest) {
  return new Promise((res, rej) => {
    const f = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'xcplaylist-logo-build' } }, (r) => {
      if (r.statusCode !== 200) { f.close(); fs.unlinkSync(dest); return rej(new Error(`HTTP ${r.statusCode} ${url}`)); }
      r.pipe(f);
      f.on('finish', () => f.close(res));
    }).on('error', (e) => { f.close(); rej(e); });
  });
}

async function main() {
  fs.mkdirSync(UK_DIR, { recursive: true });
  const index = {}; // normKey -> "uk/<file>"
  let count = 0;

  for (const country of COUNTRIES) {
    let files;
    try {
      files = await getJson(`https://api.github.com/repos/tv-logo/tv-logos/contents/countries/${country}`);
    } catch (e) { console.error(`[logos] list ${country} failed: ${e.message}`); continue; }
    if (!Array.isArray(files)) { console.error(`[logos] ${country}: ${files && files.message}`); continue; }

    for (const f of files) {
      if (!f.name.endsWith('.png') || !f.download_url) continue;
      const dest = path.join(UK_DIR, f.name);
      try {
        if (!fs.existsSync(dest)) await download(f.download_url, dest);
        const key = normKey(f.name);
        // First file to claim a key wins (UK before Ireland); skip dup keys.
        if (key && !index[key]) index[key] = `uk/${f.name}`;
        count++;
      } catch (e) { console.error(`[logos] ${f.name}: ${e.message}`); }
    }
    console.log(`[logos] ${country}: processed`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index));
  console.log(`[logos] ${count} logos, ${Object.keys(index).length} index keys -> public/logos/index.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
