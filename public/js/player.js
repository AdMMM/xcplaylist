// Video Player module - wraps mpegts.js (HEVC/H.265) + HLS.js (H.264) + native video
const Player = (() => {
  let hls = null;
  let mpegtsPlayer = null;
  let video = null;
  let isLive = false;
  let onErrorCb = null;
  let bufferingTimer = null;
  let stalledRetries = 0;
  const MAX_STALL_RETRIES = 3;

  function init(videoEl) {
    video = videoEl;
    // Buffer health monitoring: detect stalls and recover
    video.addEventListener('waiting', onBuffering);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('stalled', onStalled);
  }

  function onError(cb) { onErrorCb = cb; }

  // Show buffering state and auto-recover if stuck too long
  function onBuffering() {
    clearTimeout(bufferingTimer);
    video.classList.add('buffering');
    // If stuck buffering for 8s, try to recover
    bufferingTimer = setTimeout(() => {
      if (video.paused || !video.classList.contains('buffering')) return;
      console.warn('[player] Stuck buffering, attempting recovery');
      recoverPlayback();
    }, 8000);
  }

  function onPlaying() {
    clearTimeout(bufferingTimer);
    video.classList.remove('buffering');
    stalledRetries = 0;
  }

  function onStalled() {
    console.warn('[player] Stream stalled');
    // Give it a moment, then try to nudge playback
    setTimeout(() => {
      if (video.paused || video.readyState >= 3) return;
      recoverPlayback();
    }, 3000);
  }

  function recoverPlayback() {
    if (stalledRetries >= MAX_STALL_RETRIES) {
      console.warn('[player] Max stall retries reached');
      if (onErrorCb) onErrorCb('Stream buffering. Check your connection.');
      stalledRetries = 0;
      return;
    }
    stalledRetries++;

    if (mpegtsPlayer) {
      // For mpegts: if buffer is too far behind live edge, jump forward
      if (video.buffered.length > 0) {
        const bufEnd = video.buffered.end(video.buffered.length - 1);
        if (bufEnd - video.currentTime > 2) {
          console.log('[player] Jumping to buffer end:', bufEnd.toFixed(1));
          video.currentTime = bufEnd - 0.5;
          return;
        }
      }
      // Otherwise reload the stream
      mpegtsPlayer.unload();
      mpegtsPlayer.load();
      startPlay();
    } else if (hls) {
      hls.recoverMediaError();
    } else {
      // Native: try nudging currentTime
      video.currentTime = video.currentTime;
    }
  }

  function destroy() {
    clearTimeout(bufferingTimer);
    stalledRetries = 0;
    pausedAt = 0;
    video.classList.remove('buffering');
    if (mpegtsPlayer) {
      mpegtsPlayer.pause();
      mpegtsPlayer.unload();
      mpegtsPlayer.detachMediaElement();
      mpegtsPlayer.destroy();
      mpegtsPlayer = null;
    }
    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  function startPlay() {
    // Start muted to satisfy autoplay policy, then unmute
    video.muted = true;
    video.play().then(() => {
      video.muted = false;
      video.volume = parseFloat(document.getElementById('volume-slider').value) || 1;
    }).catch(() => {});
  }

  function play(url, live = false) {
    isLive = live;
    destroy();
    resetAudioCheck();

    // Check m3u8 FIRST so format cycling to HLS works even for live streams
    if (url.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
      console.log('[player] Using HLS.js');
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: live,
        backBufferLength: live ? 30 : 90,
        maxBufferLength: live ? 20 : 60,
        maxMaxBufferLength: live ? 40 : 120,
        maxBufferHole: 0.5,
        startLevel: -1,
        abrEwmaDefaultEstimate: 5000000,
        abrBandWidthUpFactor: 0.7,
        abrBandWidthFactor: 0.9,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        startPlay();
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        console.warn('[player] HLS error:', data.type, data.details, data.reason);
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setTimeout(() => hls && hls.startLoad(), 1000);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            if (onErrorCb) onErrorCb('Playback error. Stream may be unavailable.');
          }
        }
      });

    } else if ((live || url.includes('/api/transcode')) && typeof mpegts !== 'undefined' && mpegts.isSupported()) {
      // mpegts.js for live MPEG-TS streams and FFmpeg transcode output
      const isTranscode = url.includes('/api/transcode');
      const absUrl = url.startsWith('http') ? url : `${location.origin}${url}`;
      console.log(`[player] Using mpegts.js for ${isTranscode ? 'transcoded' : 'live'} stream:`, absUrl);
      mpegtsPlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: live || isTranscode, // transcode streams are continuous
        url: absUrl,
      }, {
        enableWorker: true,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 8,
        liveBufferLatencyMinRemain: 2,
        stashInitialSize: 1024 * 1024,
        enableStashBuffer: true,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 15,
        lazyLoadMaxDuration: 30,
        seekType: 'range',
        fixAudioTimestampGap: true,
        accurateSeek: true,
      });
      mpegtsPlayer.attachMediaElement(video);
      mpegtsPlayer.load();
      startPlay();

      mpegtsPlayer.on(mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
        console.warn('[player] mpegts error:', errorType, errorDetail, errorInfo?.msg);
        if (onErrorCb && errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
          onErrorCb('Network error. Retrying...');
          setTimeout(() => {
            if (mpegtsPlayer) {
              mpegtsPlayer.unload();
              mpegtsPlayer.load();
              startPlay();
            }
          }, 2000);
        } else if (onErrorCb && errorType === mpegts.ErrorTypes.MEDIA_ERROR) {
          onErrorCb('Media error: ' + (errorInfo?.msg || errorDetail));
        }
      });

    } else if (video.canPlayType('application/vnd.apple.mpegurl') && url.includes('.m3u8')) {
      // Safari native HLS
      console.log('[player] Using native HLS (Safari)');
      video.src = url;
      startPlay();

    } else {
      // Direct video (MP4, MKV via /api/stream proxy)
      console.log('[player] Using native video element');
      video.src = url;
      video.addEventListener('error', () => {
        const err = video.error;
        console.warn('[player] Video error:', err?.code, err?.message);
        if (onErrorCb) onErrorCb('Playback error. Stream may be unavailable.');
      }, { once: true });
      startPlay();
    }
  }

  let pausedAt = 0; // timestamp when pause was pressed (live streams only)

  function togglePlay() {
    if (video.paused) {
      // ── Unpause ──
      if (isLive && pausedAt) {
        const pausedFor = (Date.now() - pausedAt) / 1000;
        pausedAt = 0;

        // If paused for more than 3s on a live stream, jump to live edge
        if (pausedFor > 3) {
          console.log(`[player] Live stream was paused for ${pausedFor.toFixed(0)}s — jumping to live edge`);
          seekToLiveEdge();
          return;
        }
      }
      video.play().catch(() => {});
    } else {
      // ── Pause ──
      if (isLive) {
        pausedAt = Date.now();
        // Stop fetching to save bandwidth while paused
        if (hls) hls.stopLoad();
        if (mpegtsPlayer) mpegtsPlayer.pause(); // pauses network fetching
      }
      video.pause();
    }
  }

  function seekToLiveEdge() {
    if (hls) {
      // Restart HLS loading — it will fetch the latest live segments
      hls.startLoad(-1);
      // Jump to the live sync position once available
      if (typeof hls.liveSyncPosition === 'number' && hls.liveSyncPosition > 0) {
        video.currentTime = hls.liveSyncPosition;
      } else if (video.buffered.length > 0) {
        video.currentTime = video.buffered.end(video.buffered.length - 1);
      }
      video.play().catch(() => {});
    } else if (mpegtsPlayer) {
      // Reconnect the MPEG-TS stream from the current live point
      mpegtsPlayer.unload();
      mpegtsPlayer.load();
      startPlay();
    } else {
      // Native HLS (Safari) or direct — seek to end of buffer
      if (video.buffered.length > 0) {
        video.currentTime = video.buffered.end(video.buffered.length - 1);
      }
      video.play().catch(() => {});
    }
  }

  function setVolume(v) { video.volume = v; }
  function toggleMute() { video.muted = !video.muted; }
  function isPlaying() { return !video.paused; }
  function isMuted() { return video.muted; }
  function duration() { return video.duration; }
  function currentTime() { return video.currentTime; }
  function seek(t) { video.currentTime = t; }

  function toggleFullscreen() {
    const container = document.getElementById('player-container');
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen().catch(() => {});
    }
  }

  async function togglePiP() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (video && document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('[player] PiP error:', e.message);
    }
  }

  // ===== Audio Health Detection =====
  // Chromium exposes webkitAudioDecodedByteCount on <video>.
  // If video is playing but this stays at 0, the audio codec is unsupported
  // (typically AC3, EAC3/Atmos, DTS, MP2 — none are decoded by Chromium).

  let lastAudioBytes = 0;
  let audioCheckStart = 0;

  function resetAudioCheck() {
    lastAudioBytes = 0;
    audioCheckStart = Date.now();
  }

  // Returns: 'ok' | 'silent' | 'unknown'
  // 'silent' means video is playing but audio codec can't be decoded
  function getAudioHealth() {
    if (!video) return 'unknown';
    // Need some time for decoder to start
    if (Date.now() - audioCheckStart < 2000) return 'unknown';
    // Video must be actively playing
    if (video.paused || video.readyState < 3) return 'unknown';
    // Muted doesn't affect decoded byte count, so we can still check
    if (typeof video.webkitAudioDecodedByteCount === 'number') {
      const bytes = video.webkitAudioDecodedByteCount;
      if (bytes === 0 && video.currentTime > 0) return 'silent';
      if (bytes > lastAudioBytes) { lastAudioBytes = bytes; return 'ok'; }
      // Bytes unchanged — might still be loading
      return bytes > 0 ? 'ok' : 'silent';
    }
    // Fallback: check audioTracks API (less reliable)
    if (video.audioTracks && video.audioTracks.length === 0) return 'silent';
    return 'unknown';
  }

  function getQualityStats() {
    const stats = { resolution: '', health: 'good', codec: '', bitrate: 0, audioCodec: '' };
    if (!video || !video.videoWidth) return stats;

    // Resolution
    const h = video.videoHeight;
    stats.resolution = h >= 2160 ? '4K' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : h > 0 ? `${h}p` : '';

    // Buffer health
    if (video.buffered.length > 0) {
      const bufEnd = video.buffered.end(video.buffered.length - 1);
      const ahead = bufEnd - video.currentTime;
      stats.health = ahead > 5 ? 'good' : ahead > 2 ? 'fair' : 'poor';
    }

    // Codec info
    if (mpegtsPlayer && mpegtsPlayer.mediaInfo) {
      const mi = mpegtsPlayer.mediaInfo;
      stats.codec = mi.videoCodec || '';
      stats.audioCodec = mi.audioCodec || '';
      if (mi.videoDataRate) stats.bitrate = Math.round(mi.videoDataRate);
    } else if (hls && hls.levels && hls.currentLevel >= 0) {
      const level = hls.levels[hls.currentLevel];
      if (level) {
        stats.codec = level.videoCodec || '';
        stats.audioCodec = level.audioCodec || '';
        stats.bitrate = level.bitrate ? Math.round(level.bitrate / 1000) : 0;
      }
    }

    return stats;
  }

  return {
    init, play, destroy, togglePlay, setVolume, toggleMute,
    isPlaying, isMuted, duration, currentTime, seek,
    toggleFullscreen, togglePiP, getQualityStats, onError,
    getAudioHealth, resetAudioCheck, seekToLiveEdge,
    get isLive() { return isLive; },
    get video() { return video; },
  };
})();
