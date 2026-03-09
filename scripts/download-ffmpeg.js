#!/usr/bin/env node
// Downloads ffmpeg binaries for cross-platform Electron builds.
// Usage:  node scripts/download-ffmpeg.js [win|mac|all]
// Binaries are saved to build/ffmpeg-{platform}/ and bundled via extraResources.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGunzip } = require('zlib');
const { pipeline } = require('stream');

const RELEASE = 'b6.1.1';
const BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;

const TARGETS = {
  win: { file: 'ffmpeg-win32-x64.gz', outDir: 'build/ffmpeg-win', outName: 'ffmpeg.exe' },
  mac: { file: 'ffmpeg-darwin-arm64.gz', outDir: 'build/ffmpeg-mac', outName: 'ffmpeg' },
};

function download(url) {
  return new Promise((resolve, reject) => {
    const handler = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        const loc = res.headers.location;
        const mod = loc.startsWith('https') ? https : http;
        mod.get(loc, handler).on('error', reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolve(res);
    };
    https.get(url, handler).on('error', reject);
  });
}

async function downloadTarget(platform) {
  const target = TARGETS[platform];
  if (!target) {
    console.error(`Unknown platform: ${platform}. Use: win, mac, or all`);
    process.exit(1);
  }

  const root = path.resolve(__dirname, '..');
  const outDir = path.join(root, target.outDir);
  const outPath = path.join(outDir, target.outName);

  // Skip if already downloaded
  if (fs.existsSync(outPath)) {
    const stat = fs.statSync(outPath);
    if (stat.size > 1000000) { // > 1MB = likely valid
      console.log(`✓ ${platform}: already exists (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
      return;
    }
  }

  fs.mkdirSync(outDir, { recursive: true });

  const url = `${BASE_URL}/${target.file}`;
  console.log(`⬇ ${platform}: downloading ${target.file}...`);

  const res = await download(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  let downloaded = 0;

  res.on('data', (chunk) => {
    downloaded += chunk.length;
    if (total > 0) {
      const pct = ((downloaded / total) * 100).toFixed(0);
      process.stdout.write(`\r  ${platform}: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
    }
  });

  await new Promise((resolve, reject) => {
    pipeline(
      res,
      createGunzip(),
      fs.createWriteStream(outPath),
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

  // Make executable (relevant on macOS/Linux)
  fs.chmodSync(outPath, 0o755);

  const finalSize = fs.statSync(outPath).size;
  console.log(`\n✓ ${platform}: saved ${target.outName} (${(finalSize / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  const arg = process.argv[2] || 'all';
  const platforms = arg === 'all' ? Object.keys(TARGETS) : [arg];

  console.log(`Downloading ffmpeg ${RELEASE} for: ${platforms.join(', ')}\n`);

  for (const p of platforms) {
    await downloadTarget(p);
  }

  console.log('\nDone! Binaries ready for electron-builder.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
