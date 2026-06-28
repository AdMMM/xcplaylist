const express = require('express');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const { XMLParser } = require('fast-xml-parser');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { xcUrl, buildExtraParams, assertProxyTarget } = require('./lib/url-safety');

// Detect ffmpeg binary location
const isWin = process.platform === 'win32';
let ffmpegPath = null;

// Strategy 1: Check extraResources in packaged Electron app
// electron-builder copies platform-specific binaries to resources/bin/
if (process.resourcesPath) {
  const binName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const resPath = path.join(process.resourcesPath, 'bin', binName);
  try {
    execFileSync(resPath, ['-version'], { stdio: 'ignore', timeout: 5000 });
    ffmpegPath = resPath;
    console.log(`[ffmpeg] Bundled resource at ${ffmpegPath}`);
  } catch {}
}

// Strategy 2: Try ffmpeg-static npm package (works in dev + same-platform builds)
if (!ffmpegPath) {
  try {
    let staticPath = require('ffmpeg-static');
    if (staticPath) {
      // In packaged Electron app, binaries inside app.asar can't be executed.
      // electron-builder unpacks them to app.asar.unpacked via asarUnpack config.
      if (staticPath.includes('app.asar')) {
        staticPath = staticPath.replace('app.asar', 'app.asar.unpacked');
      }
      execFileSync(staticPath, ['-version'], { stdio: 'ignore', timeout: 5000 });
      ffmpegPath = staticPath;
      console.log(`[ffmpeg] ffmpeg-static at ${ffmpegPath}`);
    }
  } catch {
    ffmpegPath = null;
  }
}

// Strategy 3: Fall back to system-installed ffmpeg
if (!ffmpegPath) {
  try {
    const cmd = isWin ? 'where' : 'which';
    let found = execFileSync(cmd, ['ffmpeg'], { encoding: 'utf-8', timeout: 5000 }).trim();
    // 'where' on Windows may return multiple lines; take the first
    if (isWin && found.includes('\n')) found = found.split('\n')[0].trim();
    ffmpegPath = found;
    console.log(`[ffmpeg] System binary at ${ffmpegPath}`);
  } catch {
    // Try common platform-specific paths
    const searchPaths = isWin
      ? [
          'C:\\ffmpeg\\bin\\ffmpeg.exe',
          'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
          'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
        ]
      : [
          '/opt/homebrew/bin/ffmpeg',
          '/usr/local/bin/ffmpeg',
          '/usr/bin/ffmpeg',
        ];

    for (const p of searchPaths) {
      try {
        execFileSync(p, ['-version'], { stdio: 'ignore', timeout: 5000 });
        ffmpegPath = p;
        console.log(`[ffmpeg] Found at ${ffmpegPath}`);
        break;
      } catch {}
    }

    if (!ffmpegPath) console.warn('[ffmpeg] Not found — audio transcoding unavailable');
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache
const epgCache = new Map();

// ---------- helpers ----------

const MAX_REDIRECTS = 10;

function fetch(targetUrl, opts = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount >= MAX_REDIRECTS) {
      return reject(new Error('Too many redirects'));
    }
    const parsed = new URL(targetUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' },
      timeout: opts.timeout || 15000,
    };
    const req = mod.request(reqOpts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetch(res.headers.location, opts, redirectCount + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ---------- IMDb ratings (optional, bundled) ----------
// A compact { "<normalized-title>|<year>": [rating, votes] } map built at
// package time by scripts/build-imdb-ratings.js. Used to attach trustworthy
// ratings to VOD/series so the renderer can show + sort by them. Absent in a
// dev checkout that hasn't run the build → enrichment is simply skipped.
let imdbMap = null;
(function loadImdb() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'imdb-ratings.json.gz') : null,
    path.join(__dirname, 'build', 'imdb-ratings.json.gz'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        imdbMap = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf-8'));
        console.log(`[imdb] loaded ${Object.keys(imdbMap).length} ratings from ${p}`);
        return;
      }
    } catch (e) {
      console.warn(`[imdb] failed to load ${p}: ${e.message}`);
    }
  }
  console.log('[imdb] no ratings map found — IMDb enrichment disabled');
})();

function imdbNorm(s) {
  s = (s || '').toLowerCase().trim().replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  return s.startsWith('the ') ? s.slice(4) : s;
}

function imdbLookup(name, year) {
  if (!imdbMap || !year) return null;
  const n = imdbNorm(name);
  const y = String(year).trim();
  let r = imdbMap[`${n}|${y}`];
  if (!r && /^\d{4}$/.test(y)) {
    r = imdbMap[`${n}|${+y + 1}`] || imdbMap[`${n}|${+y - 1}`]; // release-year drift
  }
  return r || null;
}

// Attach imdb_rating / imdb_votes to each VOD/series item (mutates + returns).
function enrichImdb(items) {
  if (!imdbMap || !Array.isArray(items)) return items;
  for (const it of items) {
    const r = imdbLookup(it.name || it.title, it.year);
    if (r) { it.imdb_rating = r[0]; it.imdb_votes = r[1]; }
  }
  return items;
}

// ---------- Generic XC API proxy ----------

function xcProxy(action, extraParams = [], transform = null) {
  return async (req, res) => {
    try {
      const { server, username, password } = req.body;
      const extra = buildExtraParams(extraParams, req.body);
      const resp = await fetch(xcUrl(server, username, password, action, extra));
      let data = JSON.parse(resp.body.toString());
      if (transform) data = transform(data);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

// ---------- XC API proxy routes ----------

app.post('/api/auth', async (req, res) => {
  try {
    const { server, username, password } = req.body;
    const [acctResp, infoResp] = await Promise.all([
      fetch(xcUrl(server, username, password, 'get_account_info')),
      fetch(xcUrl(server, username, password, 'get_server_info')),
    ]);
    const data = JSON.parse(acctResp.body.toString());
    const serverInfo = JSON.parse(infoResp.body.toString());
    res.json({ ...data, server_info: serverInfo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/live/categories', xcProxy('get_live_categories'));
app.post('/api/live/streams', xcProxy('get_live_streams', ['category_id']));
app.post('/api/vod/categories', xcProxy('get_vod_categories'));
app.post('/api/vod/streams', xcProxy('get_vod_streams', ['category_id'], enrichImdb));
app.post('/api/series/categories', xcProxy('get_series_categories'));
app.post('/api/series/streams', xcProxy('get_series', ['category_id'], enrichImdb));
app.post('/api/series/info', xcProxy('get_series_info', ['series_id']));
app.post('/api/vod/info', xcProxy('get_vod_info', ['vod_id']));
app.post('/api/epg/short', xcProxy('get_short_epg', ['stream_id']));

// Full EPG (XMLTV) - parsed and cached
app.post('/api/epg/full', async (req, res) => {
  try {
    const { server, username, password } = req.body;
    const cacheKey = `${server}:${username}`;

    if (epgCache.has(cacheKey)) {
      const cached = epgCache.get(cacheKey);
      if (Date.now() - cached.ts < 3600000) {
        return res.json(cached.data);
      }
    }

    const base = server.replace(/\/+$/, '');
    const epgUrl = `${base}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    const resp = await fetch(epgUrl, { timeout: 60000 });

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => ['channel', 'programme'].includes(name),
    });
    const xml = parser.parse(resp.body.toString());
    const tv = xml.tv || xml.TV || {};

    const channels = {};
    (tv.channel || []).forEach((ch) => {
      channels[ch['@_id']] = {
        id: ch['@_id'],
        name: ch['display-name'] || ch['@_id'],
        icon: ch.icon?.['@_src'] || null,
      };
    });

    const programmes = {};
    (tv.programme || []).forEach((p) => {
      const chId = p['@_channel'];
      if (!programmes[chId]) programmes[chId] = [];
      programmes[chId].push({
        start: p['@_start'],
        stop: p['@_stop'],
        title: typeof p.title === 'object' ? p.title['#text'] || '' : p.title || '',
        desc: typeof p.desc === 'object' ? p.desc['#text'] || '' : p.desc || '',
      });
    });

    const data = { channels, programmes };
    epgCache.set(cacheKey, { ts: Date.now(), data });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stream URL builder (returns proxied playback URLs)
app.post('/api/stream/url', (req, res) => {
  const { server, username, password, stream_id, type, container } = req.body;
  const base = server.replace(/\/+$/, '');
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);

  const pathMap = { live: 'live', vod: 'movie', series: 'series' };
  const segment = pathMap[type];
  if (!segment) return res.status(400).json({ error: 'Invalid type' });

  const ext = type === 'live' ? (container || 'ts') : (container || 'mp4');
  const rawUrl = `${base}/${segment}/${user}/${pass}/${stream_id}.${ext}`;
  // HLS manifests need /api/proxy for URL rewriting; everything else uses /api/stream
  const proxy = ext === 'm3u8' ? '/api/proxy' : '/api/stream';
  res.json({ url: `${proxy}?url=${encodeURIComponent(rawUrl)}` });
});

// Catch-up / timeshift stream URL builder
app.post('/api/stream/catchup', (req, res) => {
  const { server, username, password, stream_id, start, duration } = req.body;
  if (!stream_id || !start || !duration) {
    return res.status(400).json({ error: 'Missing stream_id, start, or duration' });
  }
  const base = server.replace(/\/+$/, '');
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  const rawUrl = `${base}/timeshift/${user}/${pass}/${duration}/${start}/${stream_id}.ts`;
  res.json({ url: `/api/stream?url=${encodeURIComponent(rawUrl)}` });
});

// Proxy stream (avoids CORS for HLS manifests, segments, and VOD)
app.get('/api/proxy', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url');

  let parsed;
  try { parsed = assertProxyTarget(target); } catch (e) { return res.status(e.statusCode || 400).send(e.message); }

  const mod = parsed.protocol === 'https:' ? https : http;
  const shortPath = parsed.pathname.split('/').pop();

  const proxyReq = mod.request({
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    },
    timeout: 30000,
  }, (proxyRes) => {
    // Follow redirects
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      proxyRes.resume();
      const loc = proxyRes.headers.location;
      const abs = loc.startsWith('http') ? loc : new URL(loc, target).toString();
      try { assertProxyTarget(abs); } catch (e) { return res.status(e.statusCode || 400).send(e.message); }
      console.log(`[proxy] ${shortPath} -> redirect -> ${abs.split('/').pop()}`);
      return res.redirect(`/api/proxy?url=${encodeURIComponent(abs)}`);
    }

    const ct = proxyRes.headers['content-type'] || '';
    console.log(`[proxy] ${proxyRes.statusCode} ${shortPath} (${ct.split(';')[0] || 'no-ct'})`);

    if (proxyRes.statusCode >= 400) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(proxyRes.statusCode);
      return proxyRes.pipe(res);
    }

    const isM3u8 = target.includes('.m3u8') || ct.includes('mpegurl') || ct.includes('x-mpegURL');

    if (isM3u8) {
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const origin = parsed.origin;
        const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
        const text = Buffer.concat(chunks).toString('utf-8');

        function resolveUrl(ref) {
          if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
          if (ref.startsWith('/')) return origin + ref;
          return baseUrl + ref;
        }

        const rewritten = text.split('\n').map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            if (trimmed.includes('URI="')) {
              return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
                return `URI="/api/proxy?url=${encodeURIComponent(resolveUrl(uri))}"`;
              });
            }
            return line;
          }
          return `/api/proxy?url=${encodeURIComponent(resolveUrl(trimmed))}`;
        }).join('\n');

        console.log(`[proxy] m3u8 rewritten (${rewritten.split('\n').length} lines)`);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewritten);
      });
    } else {
      const fwd = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      fwd.forEach((h) => { if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]); });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (e) => {
    console.error(`[proxy] ERROR ${shortPath}: ${e.message}`);
    if (!res.headersSent) res.status(502).json({ error: e.message });
  });
  proxyReq.on('timeout', () => {
    console.error(`[proxy] TIMEOUT ${shortPath}`);
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Upstream timeout' });
  });
  req.on('close', () => proxyReq.destroy());
  proxyReq.end();
});

// Range-request proxy for VOD/live streams - supports seeking
app.get('/api/stream', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url');

  let parsed;
  try { parsed = assertProxyTarget(target); } catch (e) { return res.status(e.statusCode || 400).send(e.message); }

  const mod = parsed.protocol === 'https:' ? https : http;

  const headers = { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' };
  if (req.headers.range) headers.Range = req.headers.range;

  const proxyReq = mod.request({
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers,
  }, (proxyRes) => {
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      proxyRes.resume();
      const abs = proxyRes.headers.location.startsWith('http')
        ? proxyRes.headers.location
        : new URL(proxyRes.headers.location, target).toString();
      try { assertProxyTarget(abs); } catch (e) { return res.status(e.statusCode || 400).send(e.message); }
      return res.redirect(`/api/stream?url=${encodeURIComponent(abs)}`);
    }

    const fwd = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    fwd.forEach((h) => { if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]); });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  });
  req.on('close', () => proxyReq.destroy());
  proxyReq.end();
});

// Audio transcoding proxy — pipes stream through FFmpeg to convert
// AC3/EAC3/DTS/Atmos → AAC stereo while keeping video untouched.
// This is the ONLY way to play 5.1/Atmos streams in Chromium/Electron.
app.get('/api/transcode', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url');
  if (!ffmpegPath) return res.status(501).json({ error: 'FFmpeg not available' });

  let parsed;
  try { parsed = assertProxyTarget(target); } catch (e) { return res.status(e.statusCode || 400).send(e.message); }

  const shortPath = parsed.pathname.split('/').pop();
  // VOD/series are finite files — without -re ffmpeg races through them at
  // download speed (playback "flies along"). Live sources already pace
  // themselves, so -re there would just add latency.
  const isLiveSrc = /\/live\//.test(parsed.pathname);
  console.log(`[transcode] Starting: ${shortPath}${isLiveSrc ? '' : ' (paced)'}`);

  // Spawn FFmpeg: read from URL, copy video, transcode audio to AAC stereo
  // -re: read at native rate (VOD/series only — avoids racing through the file)
  // -c:v copy: pass video through untouched (no re-encoding = zero quality loss)
  // -c:a aac: transcode audio to AAC (universally supported by browsers)
  // -ac 2: downmix to stereo (5.1 → 2.0)
  // -b:a 192k: good quality AAC bitrate
  // -f mpegts: output as MPEG-TS (streamable, works with mpegts.js and HLS.js)
  const ffArgs = [
    '-hide_banner', '-loglevel', 'warning',
    ...(isLiveSrc ? [] : ['-re']),
    '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
    // Restrict input protocols so a crafted URL can't coax ffmpeg into
    // file:/concat:/etc. (assertProxyTarget already enforces http/https above).
    '-protocol_whitelist', 'http,https,tcp,tls,crypto',
    '-i', target,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ac', '2',
    '-b:a', '192k',
    '-f', 'mpegts',
    'pipe:1',
  ];

  const ff = spawn(ffmpegPath, ffArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, // Prevent cmd.exe flash on Windows
  });
  activeTranscodes.add(ff);

  let ffStarted = false;

  ff.stdout.on('data', () => {
    if (!ffStarted) {
      ffStarted = true;
      console.log(`[transcode] Streaming: ${shortPath}`);
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    }
  });

  ff.stdout.pipe(res);

  ff.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) console.log(`[transcode] ${msg}`);
  });

  ff.on('error', (e) => {
    console.error(`[transcode] FFmpeg error: ${e.message}`);
    if (!res.headersSent) res.status(502).json({ error: 'Transcode failed' });
  });

  ff.on('close', (code) => {
    activeTranscodes.delete(ff);
    console.log(`[transcode] FFmpeg exited (code ${code}) for ${shortPath}`);
    if (!res.headersSent && code !== 0) {
      res.status(502).json({ error: `FFmpeg exited with code ${code}` });
    }
  });

  // Clean up when client disconnects
  req.on('close', () => {
    if (!ff.killed) {
      console.log(`[transcode] Client disconnected, killing FFmpeg for ${shortPath}`);
      if (isWin) {
        // On Windows, kill() calls TerminateProcess immediately
        ff.kill();
      } else {
        ff.kill('SIGTERM');
        // Force kill after 2s if it doesn't exit
        setTimeout(() => { if (!ff.killed) ff.kill('SIGKILL'); }, 2000);
      }
    }
  });
});

// FFmpeg availability check
app.get('/api/transcode/check', (req, res) => {
  res.json({ available: !!ffmpegPath });
});

// ---------- Seekable audio-remux for VOD/series (HLS) ----------
// Instead of one live MPEG-TS pipe (no seek/duration/resume), serve an up-front
// VOD HLS playlist computed from the title's known duration, and transcode each
// segment on demand (video copy, audio→AAC, input -ss seek). hls.js then plays
// it as seekable VOD. (Jellyfin's approach, simplified to stateless segments.)
const HLS_SEG = 6; // seconds per segment

app.get('/api/hls/playlist.m3u8', (req, res) => {
  const target = req.query.url;
  const total = parseFloat(req.query.dur) || 0;
  if (!target || total <= 0) return res.status(400).send('Missing url/dur');
  try { assertProxyTarget(target); } catch (e) { return res.status(e.statusCode || 400).send(e.message); }

  const n = Math.ceil(total / HLS_SEG);
  let m = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n';
  m += `#EXT-X-TARGETDURATION:${HLS_SEG}\n#EXT-X-MEDIA-SEQUENCE:0\n`;
  for (let i = 0; i < n; i++) {
    const start = i * HLS_SEG;
    const len = Math.min(HLS_SEG, total - start);
    m += `#EXTINF:${len.toFixed(3)},\n`;
    m += `/api/hls/seg.ts?url=${encodeURIComponent(target)}&start=${start}&dur=${len.toFixed(3)}\n`;
  }
  m += '#EXT-X-ENDLIST\n';
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(m);
});

app.get('/api/hls/seg.ts', (req, res) => {
  const target = req.query.url;
  const start = parseFloat(req.query.start) || 0;
  const dur = parseFloat(req.query.dur) || HLS_SEG;
  if (!target) return res.status(400).send('Missing url');
  try { assertProxyTarget(target); } catch (e) { return res.status(e.statusCode || 400).send(e.message); }
  if (!ffmpegPath) return res.status(501).json({ error: 'FFmpeg not available' });

  // -ss before -i = fast input seek to the keyframe at/before `start` (so the
  // segment begins decodable); copy video, transcode audio. No -copyts: each
  // segment restarts at ts 0 and hls.js stitches them by playlist order.
  const ffArgs = [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
    '-protocol_whitelist', 'http,https,tcp,tls,crypto',
    '-ss', String(start),
    '-i', target,
    '-t', String(dur),
    '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-muxdelay', '0',
    '-f', 'mpegts', 'pipe:1',
  ];
  const ff = spawn(ffmpegPath, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  activeTranscodes.add(ff);
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Access-Control-Allow-Origin', '*');
  ff.stdout.pipe(res);
  ff.stderr.on('data', (c) => { const s = c.toString().trim(); if (s) console.log(`[hls-seg ${start}s] ${s}`); });
  ff.on('error', (e) => { if (!res.headersSent) res.status(502).end(); });
  ff.on('close', () => activeTranscodes.delete(ff));
  req.on('close', () => { if (!ff.killed) ff.kill('SIGKILL'); });
});

// Catch-all for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Track active FFmpeg processes so we can kill them on shutdown
const activeTranscodes = new Set();

// Bind to loopback only — the server is for this machine's renderer, never
// the LAN. Without the host arg Node binds all interfaces (0.0.0.0).
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`XCPlaylist running at http://localhost:${PORT}`);
});

// Graceful shutdown — called from electron.js before-quit
function shutdown() {
  console.log('[server] Shutting down...');
  // Kill all active FFmpeg processes
  for (const ff of activeTranscodes) {
    try {
      if (!ff.killed) {
        console.log('[server] Killing FFmpeg process', ff.pid);
        ff.kill(isWin ? undefined : 'SIGTERM');
      }
    } catch {}
  }
  activeTranscodes.clear();
  // Close the Express server
  server.close(() => {
    console.log('[server] Express server closed');
  });
}

module.exports = { shutdown };
