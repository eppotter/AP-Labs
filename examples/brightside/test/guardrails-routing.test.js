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

// Story 15.5 (AD-R12): GRD-002 states the map image rule in plain words with
// its numbers, the named crash risk and what Story 15.1's live check found a
// viewer can do with the picture, pending Dana Reyes's sign-off (DEP-025).
test('GRD-002 states the map image rule with its numbers, the named risk and what a viewer can do, pending DEP-025', () => {
  const grd = card('GRD-002').replace(/\s+/g, ' ');
  for (const words of [
    /about 220 m north-south/,
    /about 140 to 190 m east-west \(at 30° to 50° latitude\)/,
    /within about 150 m of the real place and never closer/,
    /at least 5 km each way/,
    /deleted when the window closes, or by a sweep at the latest 20 minutes after upload/,
    /crashes between uploading a picture and recording it/,
    /open it in a browser, copy its private link, or share it \(AirDrop, Messages, Mail, Notes, Copy\)/,
    /only for a workspace member with access/,
    /screenshot/,
    /DEP-025/,
  ]) assert.match(grd, words);
  assert.match(grd, /- status: draft\b/);
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

// Story 15.7 (AD-R22): GRD-007 says the coordinates are random points in the
// Columbus area, none from a real address, pending Dana Reyes's sign-off with
// DEP-025.
test('GRD-007 says the coordinates are random Columbus points, none from a real address, pending DEP-025', () => {
  const grd = card('GRD-007').replace(/\s+/g, ' ');
  for (const words of [
    /random synthetic point in the Columbus, Ohio area/,
    /a marker sits near real streets and homes/,
    /none is or comes from a real address/,
    /synthetic-coordinates\.sql/,
    /DEP-025/,
  ]) assert.match(grd, words);
  assert.match(grd, /- status: draft\b/);
});
