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

// Story 15.15 (AD-R25) changed "whole-minute drive times only": travelMatrix
// also returns an estimated distance, and only a route's total is shown.
test('GRD-002 names travelMatrix as the one coordinate exception: minutes and an estimated distance, never a position', () => {
  const grd = card('GRD-002');
  assert.match(grd, /stay forbidden to every query and every other read path/);
  assert.match(grd, /one named exception is the kit's drive-time read, `travelMatrix`/);
  assert.match(grd.replace(/\s+/g, ' '), /whole-minute drive times and an estimated distance \(straight line × 1\.3, in tenths of a km\) between two places only, never a latitude or longitude/);
});

// Story 15.15 (AD-R23, AD-R25, DEP-032): the story's GRD-002 and GRD-007
// words, quoted, and both cards still drafts so guardrails.md stays pending.
const GRD_002_DISTANCE = "Only a route's total distance is shown, in whole km; the distance of one leg is never shown or logged.";
const GRD_002_OFFICE = [
  "The Office, where every crew starts and ends in Plan a route, is a point in the data's `depots` table.",
  'Its coordinate columns are forbidden like the others.',
  'The map shows it with its own marker.',
  "It is called 'Office' in the list, never by address.",
].join(' ');
const GRD_007_OFFICE = 'One point is not random: the Office, a point Ely chose in Westerville, rounded to 0.002° (about 150 m).';

test('GRD-002 and GRD-007 carry Story 15.15\'s Office and distance words, pending DEP-032', () => {
  const grd2 = card('GRD-002').replace(/\s+/g, ' ');
  assert.ok(grd2.includes(GRD_002_DISTANCE), 'the distance line');
  assert.ok(grd2.includes(GRD_002_OFFICE), 'the Office line');
  for (const column of ['depots.geo_lat_e6', 'depots.geo_lon_e6']) assert.ok(grd2.includes(column), column);
  assert.match(grd2, /pending DEP-032/);
  assert.match(grd2, /- status: draft\b/);
  const grd7 = card('GRD-007').replace(/\s+/g, ' ');
  assert.ok(grd7.includes(GRD_007_OFFICE), 'the GRD-007 Office exception');
  assert.match(grd7, /pending DEP-032/);
  assert.match(grd7, /- status: draft\b/);
  // No street address is written for the Office: only the rounded point's words.
  assert.doesNotMatch(read(), /Office[^\n]*\b\d+ [A-Z][a-z]+ (St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Ln|Lane|Way|Ct|Pl)\b/);
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

// Story 15.11 (AD-R12 amended, AD-R18): GRD-002's map image part carries the
// street-map wording Dana Reyes signs (DEP-025), word for word, beside what was
// already there (the grid numbers, the sweep, the crash risk, what a viewer can
// do, and travelMatrix and mapPoints as the only coordinate reads).
const STREET_MAP_WORDING = [
  'The picture now has a street map under it.',
  "Anyone who sees it can read each marker's area directly, to about 150 m (a block), with no need to line it up.",
  "Next to the window's list (client name, city, stop number), a screenshot shows roughly where a named client lives.",
  'To draw the streets, the bot asks the street-map provider (OpenStreetMap, through its delivery network) for the map squares of the area shown.',
  "The provider learns which area of 5 km or more is being viewed, and when, from the bot's server address.",
  'It never learns which stops or customers.',
  'The bot keeps those squares in memory only.',
  "The provider's name and credit show under the picture.",
  "If the street map can't be fetched, the plain map shows.",
].join(' ');

test('GRD-002 carries the street-map wording word for word, pending DEP-025, beside the rest of the map rule', () => {
  const grd = card('GRD-002').replace(/\s+/g, ' ');
  assert.ok(grd.includes(STREET_MAP_WORDING), 'the quoted street-map wording');
  assert.match(grd, /The street map \(Story 15\.11, the wording Dana signs, pending DEP-025\)/);
  for (const words of [
    /about 220 m north-south/,
    /at least 5 km each way/,
    /at the latest 20 minutes after upload/,
    /crashes between uploading/,
    /`mapPoints`/,
    /`travelMatrix`/,
    /routing\.basemap/,
    /APLABS_BASEMAP_OFF/,
  ]) assert.match(grd, words);
  assert.doesNotMatch(grd, /The map has no street names, tiles/, 'the old "no tiles" line is gone');
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
