'use strict';
// Seekable on-the-fly HLS transcode for VOD/series (movies + episodes).
//
// Pattern adapted from advplyr/hls-media-server (ISC) + Jellyfin's spec
// (GPL — pattern only, no code copied):
//   - Serve a COMPLETE VOD playlist up front (uniform 6s segments from the known
//     runtime) so duration + scrubbing work instantly.
//   - One rolling ffmpeg RE-ENCODES video to H.264 with keyframes FORCED at each
//     6s boundary (so segments align exactly → no overlap/stutter/desync) and
//     audio to AAC. -copyts keeps timestamps absolute so segments are contiguous
//     across the playlist and across restarts.
//   - On a seek outside the produced window, SIGKILL ffmpeg and restart it with
//     input -ss at the requested segment (-start_number keeps file numbering
//     aligned to the playlist). Small forward gaps let the encoder catch up.
//   - Idle sessions are reaped (ffmpeg killed + temp dir removed).
//
// Re-encoding (not -c:v copy) is deliberate: it's the only way to guarantee
// keyframe-aligned segments without an ffprobe keyframe pass, and it also makes
// otherwise-undecodable video (HEVC) play in-app.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SEG = 6;             // seconds per segment
const WINDOW_AHEAD = 5;    // let the encoder run up to this many segments ahead before a seek forces a restart
const IDLE_MS = 60000;     // reap a session after this long with no segment requests
const WAIT_MS = 30000;     // max wait for a segment to be produced
const POLL_MS = 150;

let ffmpegPath = null;
function setFfmpegPath(p) { ffmpegPath = p; }

const sessions = new Map(); // key -> session

function keyFor(url) { return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16); }

// Complete VOD playlist from the known runtime. Segments are referenced by index
// through /api/hls/seg.ts?key=&n= (absolute, so no base-path assumptions).
function buildPlaylist(key, durationSecs) {
  const n = Math.max(1, Math.ceil(durationSecs / SEG));
  let m = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n';
  m += `#EXT-X-TARGETDURATION:${SEG}\n#EXT-X-MEDIA-SEQUENCE:0\n`;
  for (let i = 0; i < n; i++) {
    const len = Math.min(SEG, durationSecs - i * SEG) || SEG;
    m += `#EXTINF:${len.toFixed(3)},\n/api/hls/seg.ts?key=${key}&n=${i}\n`;
  }
  m += '#EXT-X-ENDLIST\n';
  return { playlist: m, segments: n };
}

function ensureSession(url, durationSecs) {
  const key = keyFor(url);
  let s = sessions.get(key);
  if (!s) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcp-hls-'));
    s = { key, url, durationSecs, dir, ff: null, baseSeg: 0, lastAccess: Date.now() };
    sessions.set(key, s);
  } else {
    s.durationSecs = durationSecs || s.durationSecs;
    s.lastAccess = Date.now();
  }
  return s;
}

function segPath(s, n) { return path.join(s.dir, `seg${n}.ts`); }

function killFfmpeg(s) {
  if (s.ff && !s.ff.killed) { try { s.ff.kill('SIGKILL'); } catch {} }
  s.ff = null;
}

// (Re)start the rolling encoder so it begins producing at segment `startSeg`.
function startEncoder(s, startSeg) {
  killFfmpeg(s);
  s.baseSeg = startSeg;
  const offset = startSeg * SEG;
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
    '-protocol_whitelist', 'http,https,tcp,tls,crypto',
  ];
  if (offset > 0) args.push('-ss', String(offset));
  args.push(
    '-i', s.url,
    '-copyts', '-avoid_negative_ts', 'disabled',
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
    '-sc_threshold', '0',
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-f', 'hls',
    '-hls_time', String(SEG),
    '-hls_playlist_type', 'vod',
    '-hls_list_size', '0',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'temp_file',
    '-start_number', String(startSeg),
    '-hls_segment_filename', path.join(s.dir, 'seg%d.ts'),
    path.join(s.dir, '_internal.m3u8'),
    '-y',
  );
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  s.ff = ff;
  ff.stderr.on('data', (d) => { const t = d.toString().trim(); if (t) console.log(`[hls ${s.key} @${offset}s] ${t}`); });
  ff.on('close', () => { if (s.ff === ff) s.ff = null; });
  ff.on('error', () => { if (s.ff === ff) s.ff = null; });
}

// Highest contiguous produced segment index from baseSeg (files land in order).
function producedUpTo(s) {
  let n = s.baseSeg;
  while (fs.existsSync(segPath(s, n))) n++;
  return n - 1; // last existing, or baseSeg-1 if none yet
}

// Resolve segment n's file for an existing session, (re)starting/awaiting the
// encoder as needed. Returns null if the session is gone (client should re-fetch
// the playlist) or the segment couldn't be produced in time.
async function getSegmentFile(key, n) {
  const s = sessions.get(key);
  if (!s) return null;
  s.lastAccess = Date.now();

  if (fs.existsSync(segPath(s, n))) return segPath(s, n);

  const top = producedUpTo(s);
  const needRestart = !s.ff || n < s.baseSeg || n > top + WINDOW_AHEAD;
  if (needRestart) startEncoder(s, n);

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(segPath(s, n))) return segPath(s, n);
    if (!s.ff) {
      // encoder died before producing it — one retry from n, else give up
      if (!fs.existsSync(segPath(s, n))) startEncoder(s, n);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    s.lastAccess = Date.now();
  }
  return null;
}

function destroySession(s) {
  killFfmpeg(s);
  sessions.delete(s.key);
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

function reap() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastAccess > IDLE_MS) destroySession(s);
  }
}
const reaper = setInterval(reap, 15000);
if (reaper.unref) reaper.unref();

function shutdown() {
  clearInterval(reaper);
  for (const s of [...sessions.values()]) destroySession(s);
}

module.exports = { setFfmpegPath, buildPlaylist, ensureSession, getSegmentFile, segPath, shutdown, keyFor };
