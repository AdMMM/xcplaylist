// XMLTV time parsing — extracted so it can be unit-tested under node:test
// and reused by the renderer (loaded as a global before epg.js).
(function (root) {
  'use strict';

  function parseTime(str) {
    if (!str) return null;
    // Format: "20250308120000 +0500"  or  "2025-03-08T12:00:00"
    const s = String(str).trim();
    const m = s.match(/^(\d{14})(?:\s*([+-]\d{4}))?$/);
    if (m) {
      const ts = m[1];
      const y = ts.slice(0, 4), mo = ts.slice(4, 6), d = ts.slice(6, 8);
      const h = ts.slice(8, 10), mi = ts.slice(10, 12), se = ts.slice(12, 14);
      // Honor the XMLTV timezone offset; fall back to UTC when absent.
      const offset = m[2] ? `${m[2].slice(0, 3)}:${m[2].slice(3, 5)}` : 'Z';
      const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${offset}`);
      return isNaN(date) ? null : date;
    }
    const date = new Date(s);
    return isNaN(date) ? null : date;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseTime };
  } else {
    root.parseTime = parseTime;
  }
})(typeof window !== 'undefined' ? window : this);
