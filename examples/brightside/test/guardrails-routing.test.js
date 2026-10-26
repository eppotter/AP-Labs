'use strict';

// Story 13.3: GRD-002 names the four coordinate columns and waits for Dana
// Reyes's sign-off again (DEP-028), so `npm run onboard -- --status` shows
// guardrails.md pending. An example test (architecture carve-out): it reads
// profiles/brightside/ and is deleted with the example in a fork. When Dana
// signs, record the date in guardrails.md and update this test with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { contextStatus } = require('../../../kit/lib/onboard');

const CONTEXT = path.join(__dirname, '../../../profiles/brightside/context');
const read = () => fs.readFileSync(path.join(CONTEXT, 'guardrails.md'), 'utf8');

function card(id) {
  const text = read();
  const start = text.indexOf(`### ${id}:`);
  assert.ok(start >= 0, `${id} card present`);
  const next = text.indexOf('\n### ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

test('GRD-002 names the four coordinate columns and is a draft again', () => {
  const grd = card('GRD-002');
  for (const column of ['properties.geo_lat_e6', 'properties.geo_lon_e6', 'crews.base_geo_lat_e6', 'crews.base_geo_lon_e6']) {
    assert.ok(grd.includes(column), `GRD-002 names ${column}`);
  }
  assert.match(grd, /\n- status: draft\b/);
});

test('GRD-002 names travelMatrix as the one coordinate exception, minutes only', () => {
  const grd = card('GRD-002');
  assert.match(grd, /stay forbidden to every query and every other read path/);
  assert.match(grd, /one named exception is the kit's drive-time read, `travelMatrix`/);
  assert.match(grd, /whole-minute drive times between two places only, never\s+a latitude or longitude/);
});

test('the crew-out rule is recorded as pending Dana Reyes (DEP-028)', () => {
  const text = read();
  assert.match(text, /lead is absent, or nobody on the crew is present/);
  assert.match(text, /DEP-028/);
});

test('guardrails.md awaits sign-off in onboard --status', () => {
  const g = contextStatus(CONTEXT).find((s) => s.file === 'guardrails.md');
  assert.equal(g.present, true);
  assert.equal(g.error, undefined);
  assert.equal(g.signed, false);
  assert.equal(g.signedOff, 'pending');
});
