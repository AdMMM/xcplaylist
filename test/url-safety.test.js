'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { xcUrl, buildExtraParams, assertProxyTarget, isPrivateHost } = require('../lib/url-safety');

test('xcUrl encodes credentials', () => {
  const u = xcUrl('http://host.tv', 'user name', 'p@ss&x', 'get_live_streams');
  assert.match(u, /username=user%20name/);
  assert.match(u, /password=p%40ss%26x/);
  assert.match(u, /action=get_live_streams$/);
});

test('xcUrl strips trailing slashes from server', () => {
  assert.match(xcUrl('http://host.tv///', 'a', 'b', 'x'), /^http:\/\/host\.tv\/player_api\.php/);
});

test('buildExtraParams encodes values (no query-param injection)', () => {
  // A value with & and space must not break out into extra params.
  const extra = buildExtraParams(['category_id'], { category_id: 'a b&action=evil' });
  assert.equal(extra, '&category_id=a%20b%26action%3Devil');
});

test('buildExtraParams omits absent params', () => {
  assert.equal(buildExtraParams(['category_id', 'series_id'], { category_id: '5' }), '&category_id=5');
});

test('assertProxyTarget accepts public http/https', () => {
  assert.equal(assertProxyTarget('http://mrgtvor.club/live/x.ts').protocol, 'http:');
  assert.equal(assertProxyTarget('https://example.tv:8080/a.m3u8').protocol, 'https:');
});

test('assertProxyTarget rejects non-http(s) schemes', () => {
  assert.throws(() => assertProxyTarget('file:///etc/passwd'), /scheme/i);
  assert.throws(() => assertProxyTarget('ftp://host/x'), /scheme/i);
  assert.throws(() => assertProxyTarget('concat:/a|/b'), /scheme|Invalid/i);
});

test('assertProxyTarget rejects invalid URLs', () => {
  assert.throws(() => assertProxyTarget('not a url'), /Invalid/i);
});

test('assertProxyTarget rejects loopback / localhost', () => {
  assert.throws(() => assertProxyTarget('http://127.0.0.1/x'), /private|loopback/i);
  assert.throws(() => assertProxyTarget('http://localhost:9000/x'), /private|loopback/i);
  assert.throws(() => assertProxyTarget('http://[::1]/x'), /private|loopback/i);
});

test('assertProxyTarget rejects private + link-local ranges (SSRF)', () => {
  for (const h of ['10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.1', '169.254.169.254', '0.0.0.0']) {
    assert.throws(() => assertProxyTarget(`http://${h}/x`), /private|loopback/i, `${h} should be rejected`);
  }
});

test('isPrivateHost classifies hosts', () => {
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('169.254.169.254'), true);
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(isPrivateHost('mrgtvor.club'), false);
});
