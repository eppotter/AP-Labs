'use strict';

// Story 13.3: GRD-002 names the four coordinate columns (DEP-028). Plan
// brightside-v1, Story 18.1: Ely Potter signed every rule card on 2026-10-31
// (DEP-025, DEP-028, DEP-032 closed), and the gate approval signed GRD-009
// (Story 19.7), so all nine cards are approved and
// `npm run onboard -- --status` shows guardrails.md signed. An example test
// (architecture carve-out): it reads profiles/brightside/ and is deleted with
// the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { contextStatus } = require('../../../kit/lib/onboard');
const { countApprovedRules } = require('../../../kit/runtime/knowledge/readiness');

const CONTEXT = path.join(__dirname, '../../../profiles/brightside/context');
const read = () => fs.readFileSync(path.join(CONTEXT, 'guardrails.md'), 'utf8');

function card(id) {
  const text = read();
  const start = text.indexOf(`### ${id}:`);
  assert.ok(start >= 0, `${id} card present`);
  const next = text.indexOf('\n### ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

// Each card's first "- status:" line is exactly "approved" (the readiness
// parser counts nothing else); its history is in an "- approval:" line.
const APPROVED = /\n- status: approved\n- approval: approved by Ely Potter on 2026-10-31\b/;

test('GRD-002 names the four coordinate columns and is approved', () => {
  const grd = card('GRD-002');
  for (const column of ['properties.geo_lat_e6', 'properties.geo_lon_e6', 'crews.base_geo_lat_e6', 'crews.base_geo_lon_e6']) {
    assert.ok(grd.includes(column), `GRD-002 names ${column}`);
  }
  assert.match(grd, APPROVED);
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
// words, quoted, and both cards approved by Ely Potter (Story 18.1).
const GRD_002_DISTANCE = "Only a route's total distance is shown, in whole km; the distance of one leg is never shown or logged.";
const GRD_002_OFFICE = [
  "The Office, where every crew starts and ends in Plan a route, is a point in the data's `depots` table.",
  'Its coordinate columns are forbidden like the others.',
  'The map shows it with its own marker.',
  "It is called 'Office' in the list, never by address.",
].join(' ');
const GRD_007_OFFICE = 'One point is not random: the Office, a point Ely chose in Westerville, rounded to 0.002° (about 150 m).';

test('GRD-002 and GRD-007 carry Story 15.15\'s Office and distance words, approved (DEP-032)', () => {
  const grd2 = card('GRD-002').replace(/\s+/g, ' ');
  assert.ok(grd2.includes(GRD_002_DISTANCE), 'the distance line');
  assert.ok(grd2.includes(GRD_002_OFFICE), 'the Office line');
  for (const column of ['depots.geo_lat_e6', 'depots.geo_lon_e6']) assert.ok(grd2.includes(column), column);
  assert.match(grd2, /approved by Ely Potter on 2026-10-31, DEP-032/);
  assert.match(grd2, /- status: approved - approval: approved by Ely Potter on 2026-10-31\b/);
  const grd7 = card('GRD-007').replace(/\s+/g, ' ');
  assert.ok(grd7.includes(GRD_007_OFFICE), 'the GRD-007 Office exception');
  assert.match(grd7, /approved by Ely Potter on 2026-10-31, DEP-032/);
  assert.match(grd7, /- status: approved - approval: approved by Ely Potter on 2026-10-31\b/);
  // No street address is written for the Office: only the rounded point's words.
  assert.doesNotMatch(read(), /Office[^\n]*\b\d+ [A-Z][a-z]+ (St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Ln|Lane|Way|Ct|Pl)\b/);
});

// Story 15.5 (AD-R12): GRD-002 states the map image rule in plain words with
// its numbers, the named crash risk and what Story 15.1's live check found a
// viewer can do with the picture, signed by Ely Potter on 2026-10-31 (DEP-025).
test('GRD-002 states the map image rule with its numbers, the named risk and what a viewer can do, approved (DEP-025)', () => {
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
  assert.match(grd, /- status: approved\b/);
});

// Story 15.11 (AD-R12 amended, AD-R18): GRD-002's map image part carries the
// street-map wording Ely Potter signed (DEP-025), word for word, beside what was
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

test('GRD-002 carries the street-map wording word for word, approved (DEP-025), beside the rest of the map rule', () => {
  const grd = card('GRD-002').replace(/\s+/g, ' ');
  assert.ok(grd.includes(STREET_MAP_WORDING), 'the quoted street-map wording');
  assert.match(grd, /The street map \(Story 15\.11, the wording Ely Potter signed on 2026-10-31, DEP-025\)/);
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
  assert.match(grd, /- status: approved\b/);
});

// Plan brightside-v1 D2: GRD-008 approved with its edge cases settled.
test('the crew-out rule (GRD-008) is approved with its edge cases settled (DEP-028)', () => {
  const text = read();
  assert.match(text, /lead is absent, or nobody on the crew is present/);
  const grd = card('GRD-008').replace(/\s+/g, ' ');
  assert.ok(grd.includes('- edge_cases: A stand-in lead counts as the lead for that day. A member present for part of the day counts as present.'), 'the edge cases');
  assert.ok(grd.includes("Brightside's data has neither (no stand-in field; `staff_absences` holds whole days only), so the adapter needs no change; a fork whose data records either must map it this way."), 'no adapter change');
  assert.match(grd, /DEP-028/);
  assert.match(card('GRD-008'), APPROVED);
});

// Plan brightside-v1 D2 and D10: every one of the nine cards is approved, and the
// readiness parser counts exactly nine (the strip's "9 rules", D13).
test('all nine rule cards are approved and countApprovedRules counts 9', () => {
  for (let n = 1; n <= 9; n += 1) {
    const id = `GRD-00${n}`;
    assert.match(card(id), /\n- status: approved\n/, id);
  }
  assert.equal(countApprovedRules(read()), 9);
  const cards = read().slice(read().indexOf('\n### GRD-001:'));
  assert.doesNotMatch(cards, /^- status: (?!approved$).*$/m, 'no card status line other than approved');
});

test('guardrails.md is signed off by Ely Potter on 2026-10-31 in onboard --status', () => {
  const g = contextStatus(CONTEXT).find((s) => s.file === 'guardrails.md');
  assert.equal(g.present, true);
  assert.equal(g.error, undefined);
  assert.equal(g.signed, true);
  assert.equal(g.signedOff, '2026-10-31');
  assert.equal(g.owner, 'Ely Potter');
});

test('every Brightside context file is owned and signed by Ely Potter on 2026-10-31', () => {
  const all = contextStatus(CONTEXT);
  assert.deepEqual(all.map((s) => s.file).sort(), ['connectors.md', 'data.md', 'guardrails.md', 'org.md']);
  for (const s of all) {
    assert.equal(s.owner, 'Ely Potter', s.file);
    assert.equal(s.signed, true, s.file);
    assert.equal(s.signedOff, '2026-10-31', s.file);
  }
});

// Story 15.7 (AD-R22): GRD-007 says the coordinates are random points in the
// Columbus area, none from a real address, signed by Ely Potter on 2026-10-31
// with DEP-025.
test('GRD-007 says the coordinates are random Columbus points, none from a real address, approved (DEP-025)', () => {
  const grd = card('GRD-007').replace(/\s+/g, ' ');
  for (const words of [
    /random synthetic point in the Columbus, Ohio area/,
    /a marker sits near real streets and homes/,
    /none is or comes from a real address/,
    /synthetic-coordinates\.sql/,
    /DEP-025/,
  ]) assert.match(grd, words);
  assert.match(grd, /- status: approved\b/);
});

// Plan brightside-v1, D7, Story 19.3: Data sources on a hub that sees rules
// (/brightside-v1, /brightside) reads Brightside's own files and says
// "Rule cards approved: 9" (GRD-009, Story 19.7).
test('Data sources on Brightside\'s files: "Rule cards approved: 9"', () => {
  const { loadProfile } = require('../../../kit/lib/profile');
  const { readiness, createRulesReader } = require('../../../kit/runtime/knowledge/readiness');
  const dataSources = require('../../../kit/runtime/archetypes/data-sources');
  const profilePath = path.join(CONTEXT, '../profile.yml');
  const rules = createRulesReader({ profile: loadProfile(profilePath), profilePath, readLast: () => null });
  const view = {
    id: 'brightside-v1', sees: ['context', 'data', 'rules'], data: null, rules: true,
  };
  const text = dataSources.render({ ready: readiness(view, { rules }) }).blocks.map((b) => (b.text && b.text.text) || '').join('\n');
  assert.match(text, /\n• Rule cards approved: 9\n/);
});
