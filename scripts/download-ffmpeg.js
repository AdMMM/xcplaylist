#!/usr/bin/env node
// Downloads ffmpeg binaries for cross-platform Electron builds.
// Usage:  node scripts/download-ffmpeg.js [win|mac|all]
// Binaries are saved to build/ffmpeg-{platform}/ and bundled via extraResources.

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createGunzip } = require('zlib');
const { pipeline } = require('stream');

const RELEASE = 'b6.1.1';
const BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;

// sha256 = SHA-256 of the *decompressed* binary, verified against the
// eugeneware/ffmpeg-static b6.1.1 GitHub release (fetched over HTTPS). Pinning
// fails the build if the upstream asset ever changes or a download is tampered with.
const TARGETS = {
  win: { file: 'ffmpeg-win32-x64.gz', outDir: 'build/ffmpeg-win', outName: 'ffmpeg.exe',
    sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00' },
  mac: { file: 'ffmpeg-darwin-arm64.gz', outDir: 'build/ffmpeg-mac', outName: 'ffmpeg',
    sha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584' },
};

function download(url) {
  return new Promise((resolve, reject) => {
    const handler = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect — HTTPS only (the result is bundled as an executable).
        const loc = res.headers.location;
        if (!loc.startsWith('https:')) {
          res.resume();
          return reject(new Error(`Refusing non-HTTPS redirect to ${loc}`));
        }
        https.get(loc, handler).on('error', reject);
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

  // Write to a temp file and hash the decompressed bytes as they stream through;
  // only rename into place after the digest matches, so an interrupted or tampered
  // download never leaves a trusted binary behind.
  const tmpPath = `${outPath}.partial`;
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    gunzip.on('data', (chunk) => hash.update(chunk));
    pipeline(
      res,
      gunzip,
      fs.createWriteStream(tmpPath),
      (err) => (err ? reject(err) : resolve())
    );
  });

  const digest = hash.digest('hex');
  if (target.sha256 && digest !== target.sha256) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(`${platform}: SHA-256 mismatch\n  expected ${target.sha256}\n  got      ${digest}`);
  }

  // Make executable (relevant on macOS/Linux), then atomically move into place.
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, outPath);

  const finalSize = fs.statSync(outPath).size;
  console.log(`\n✓ ${platform}: verified + saved ${target.outName} (${(finalSize / 1024 / 1024).toFixed(1)} MB)`);
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
