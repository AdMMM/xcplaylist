'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseTime } = require('../public/js/parse-time');

test('parseTime honors a positive XMLTV offset', () => {
  // 12:00 at +05:00 is 07:00 UTC.
  const d = parseTime('20250308120000 +0500');
  assert.equal(d.toISOString(), '2025-03-08T07:00:00.000Z');
});

test('parseTime honors a negative XMLTV offset', () => {
  // 12:00 at -03:00 is 15:00 UTC.
  const d = parseTime('20250308120000 -0300');
  assert.equal(d.toISOString(), '2025-03-08T15:00:00.000Z');
});

test('parseTime treats +0000 as UTC', () => {
  assert.equal(parseTime('20250308120000 +0000').toISOString(), '2025-03-08T12:00:00.000Z');
});

test('parseTime handles a 14-digit timestamp with no offset (UTC fallback)', () => {
  assert.equal(parseTime('20250308120000').toISOString(), '2025-03-08T12:00:00.000Z');
});

test('parseTime parses ISO strings', () => {
  assert.equal(parseTime('2025-03-08T12:00:00Z').toISOString(), '2025-03-08T12:00:00.000Z');
});

test('parseTime returns null on empty / falsy', () => {
  assert.equal(parseTime(''), null);
  assert.equal(parseTime(null), null);
});
