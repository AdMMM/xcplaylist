'use strict';

const net = require('net');

// Pure URL helpers for the backend, extracted so they can be unit-tested
// without starting the Express server.

// Build the Xtream player_api.php URL with encoded credentials.
function xcUrl(server, username, password, action, extra = '') {
  const base = server.replace(/\/+$/, '');
  return `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=${action}${extra}`;
}

// Build the &key=value suffix for optional XC params from a request body.
// Values are URL-encoded so they can't inject extra query params.
function buildExtraParams(extraParams, body) {
  return extraParams
    .map((p) => (body[p] ? `&${p}=${encodeURIComponent(body[p])}` : ''))
    .join('');
}

// Is this host a loopback / private / link-local address we must never proxy to?
function isPrivateHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(h)) {
    if (/^127\./.test(h) || h === '::1' || /^0\./.test(h)) return true;
    if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h) || /^fe80:/.test(h)) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique-local IPv6
    return false;
  }
  return h === 'localhost' || h.endsWith('.localhost');
}

// Parse + validate a caller-supplied proxy target. We only ever need to reach
// the user's (public) Xtream server, so refuse non-http(s) schemes and any
// loopback/private/link-local target (SSRF guard). Throws an Error carrying
// a .statusCode for the route to surface.
// NOTE: hostnames that *resolve* to private IPs via DNS are not caught here;
// the loopback bind in server.js is the backstop for that.
function assertProxyTarget(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    const e = new Error('Invalid url');
    e.statusCode = 400;
    throw e;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const e = new Error('Unsupported URL scheme');
    e.statusCode = 400;
    throw e;
  }
  if (isPrivateHost(parsed.hostname)) {
    const e = new Error('Refusing to proxy a private or loopback address');
    e.statusCode = 403;
    throw e;
  }
  return parsed;
}

module.exports = { xcUrl, buildExtraParams, isPrivateHost, assertProxyTarget };
