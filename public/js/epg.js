// EPG module - handles programme guide data
const EPG = (() => {
  let epgData = null;
  let loading = false;

  // ===== Robust text decoding =====

  // Decode base64 → UTF-8 properly (atob alone garbles multi-byte chars)
  function decodeBase64(str) {
    if (!str || typeof str !== 'string') return '';
    const trimmed = str.trim();
    if (!trimmed) return '';

    // Try UTF-8-aware base64 decode
    try {
      const bytes = Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch { /* not valid base64 or not valid UTF-8 */ }

    // Fallback: classic atob with URI-escape trick for Latin-1 → UTF-8
    try {
      return decodeURIComponent(escape(atob(trimmed)));
    } catch { /* still broken */ }

    // Fallback: plain atob (may still garble, but better than nothing)
    try {
      return atob(trimmed);
    } catch { /* not base64 at all */ }

    // Last resort: return as-is (some providers send plain text)
    return trimmed;
  }

  // Strip HTML tags, decode HTML entities, remove control chars, normalise whitespace
  function cleanText(str) {
    if (!str) return '';
    let t = str;
    // Strip HTML tags
    t = t.replace(/<[^>]*>/g, '');
    // Decode common HTML entities
    t = t.replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&nbsp;/gi, ' ')
      // Numeric entities (decimal & hex)
      .replace(/&#(\d+);/g, (_, n) => {
        const code = parseInt(n, 10);
        return code > 0 && code < 0x10FFFF ? String.fromCodePoint(code) : '';
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
        const code = parseInt(h, 16);
        return code > 0 && code < 0x10FFFF ? String.fromCodePoint(code) : '';
      });
    // Remove control characters (except newline/tab)
    t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // Collapse whitespace
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  // Full decode pipeline: base64 → UTF-8 → strip HTML → clean
  function decodeField(value) {
    return cleanText(decodeBase64(value));
  }

  // ===== Time parsing =====

  function parseTime(str) {
    if (!str) return null;
    // Format: "20250308120000 +0000"  or  "2025-03-08T12:00:00"
    const clean = str.replace(/\s.*$/, '');
    if (clean.length === 14 && /^\d{14}$/.test(clean)) {
      const y = clean.slice(0, 4), m = clean.slice(4, 6), d = clean.slice(6, 8);
      const h = clean.slice(8, 10), mi = clean.slice(10, 12), s = clean.slice(12, 14);
      const date = new Date(`${y}-${m}-${d}T${h}:${mi}:${s}Z`);
      return isNaN(date) ? null : date;
    }
    const date = new Date(str);
    return isNaN(date) ? null : date;
  }

  function formatTime(date) {
    if (!date || isNaN(date)) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ===== EPG loading =====

  async function load() {
    if (loading) return;
    loading = true;
    try {
      epgData = await XC.fullEpg();
    } catch (e) {
      console.warn('EPG load failed:', e.message);
      epgData = null;
    }
    loading = false;
  }

  // Get short EPG for a stream via the API
  async function getShortEpg(streamId) {
    try {
      const data = await XC.shortEpg(streamId);
      if (!data?.epg_listings) return [];

      const now = new Date();

      return data.epg_listings
        .map((p) => {
          try {
            const start = parseTime(p.start) || (p.start_timestamp ? new Date(p.start_timestamp * 1000) : null);
            const end = parseTime(p.end) || (p.stop_timestamp ? new Date(p.stop_timestamp * 1000) : null);
            if (!start || !end) return null;
            return {
              start,
              end,
              title: decodeField(p.title),
              desc: decodeField(p.description),
              isNow: now >= start && now < end,
            };
          } catch {
            return null; // skip unparseable listings
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // Get current programme for a channel from full EPG
  function getCurrentProgramme(epgChannelId) {
    if (!epgData || !epgData.programmes) return null;
    const progs = epgData.programmes[epgChannelId];
    if (!progs) return null;

    const now = new Date();
    for (const p of progs) {
      const start = parseTime(p.start);
      const stop = parseTime(p.stop);
      if (start && stop && now >= start && now < stop) {
        return {
          title: cleanText(p.title || ''),
          desc: cleanText(p.desc || ''),
          start,
          stop,
        };
      }
    }
    return null;
  }

  function getData() { return epgData; }

  function getTimelineProgrammes(epgChannelId, rangeStart, rangeEnd) {
    if (!epgData || !epgData.programmes) return [];
    const progs = epgData.programmes[epgChannelId];
    if (!progs) return [];

    const now = new Date();
    const results = [];

    for (const p of progs) {
      const start = parseTime(p.start);
      const stop = parseTime(p.stop);
      if (!start || !stop) continue;
      if (stop <= rangeStart || start >= rangeEnd) continue;

      results.push({
        start,
        stop,
        title: cleanText(p.title || ''),
        desc: cleanText(p.desc || ''),
        isNow: now >= start && now < stop,
        isPast: now >= stop,
        isFuture: now < start,
      });
    }

    return results.sort((a, b) => a.start - b.start);
  }

  return { load, getShortEpg, getCurrentProgramme, formatTime, parseTime, getData, getTimelineProgrammes, cleanText };
})();
