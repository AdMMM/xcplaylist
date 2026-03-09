// XC API Client - handles all backend communication
const XC = (() => {
  let _creds = null;

  function creds() { return _creds; }

  function setCreds(server, username, password) {
    _creds = { server, username, password };
  }

  function clearCreds() { _creds = null; }

  async function post(endpoint, extra = {}) {
    const res = await window.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ..._creds, ...extra }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  return {
    creds,
    setCreds,
    clearCreds,

    auth: () => post('/api/auth'),

    liveCategories: () => post('/api/live/categories'),
    liveStreams: (category_id) => post('/api/live/streams', category_id ? { category_id } : {}),

    vodCategories: () => post('/api/vod/categories'),
    vodStreams: (category_id) => post('/api/vod/streams', category_id ? { category_id } : {}),

    seriesCategories: () => post('/api/series/categories'),
    seriesStreams: (category_id) => post('/api/series/streams', category_id ? { category_id } : {}),
    seriesInfo: (series_id) => post('/api/series/info', { series_id }),

    vodInfo: (vod_id) => post('/api/vod/info', { vod_id }),

    shortEpg: (stream_id) => post('/api/epg/short', { stream_id }),
    fullEpg: () => post('/api/epg/full'),

    streamUrl: (stream_id, type, container) =>
      post('/api/stream/url', { stream_id, type, container }),

    // Build a transcode URL for a stream (pipes through FFmpeg to convert AC3/EAC3 → AAC)
    transcodeUrl: (stream_id, type) => {
      if (!_creds) return null;
      const base = _creds.server.replace(/\/+$/, '');
      const user = encodeURIComponent(_creds.username);
      const pass = encodeURIComponent(_creds.password);
      const pathMap = { live: 'live', vod: 'movie', series: 'series' };
      const segment = pathMap[type];
      if (!segment) return null;
      const ext = type === 'live' ? 'ts' : 'mp4';
      const rawUrl = `${base}/${segment}/${user}/${pass}/${stream_id}.${ext}`;
      return `/api/transcode?url=${encodeURIComponent(rawUrl)}`;
    },

    // Check if server-side FFmpeg transcoding is available
    checkTranscode: async () => {
      try {
        const r = await window.fetch('/api/transcode/check');
        const data = await r.json();
        return data.available === true;
      } catch { return false; }
    },

    proxyUrl: (url) => `/api/proxy?url=${encodeURIComponent(url)}`,
  };
})();
