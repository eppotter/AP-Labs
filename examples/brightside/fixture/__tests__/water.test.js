'use strict';

// Fix to Story 15.7 (generator v6): no synthetic home or crew base sits on
// the Columbus box's big water. Ely's live check found a stop on Alum Creek
// Reservoir; lib/water.js holds rough hand-drawn outlines and the generator
// redraws a point that falls in one. Example tests (AD-1 carve-out): they
// read Brightside's own fixture and go with it in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generate, readSeedConfig } = require('../generate');
const { checkRouting } = require('../lib/routing-rules');
const routing = require('../lib/routing');
const { WATER, MAP_GRID_E6, snap, inRing, waterAt, onWater } = require('../lib/water');
const { AS_OF } = require('../lib/reference');
const { loadChecks } = require('../../../../kit/fixture/validate');
const { loadProfile } = require('../../../../kit/lib/profile');

const FIXTURE_DIR = path.join(__dirname, '..');
const REPO = path.resolve(FIXTURE_DIR, '..', '..', '..');
const SMALL = { seed: 7, clients: 60 };
const COORDINATE_COLUMNS = ['properties.geo_lat_e6', 'properties.geo_lon_e6', 'crews.base_geo_lat_e6', 'crews.base_geo_lon_e6'];

// A point on Alum Creek Reservoir, north of Westerville (the live check's
// stop sat on it), and one on land (the box's centre, near campus).
const ALUM = [40180000, -82960000];
const LAND = [40000000, -83000000];

test('a point on Alum Creek Reservoir is water and the generator\'s rules refuse it; a point on land is accepted', () => {
  assert.equal(waterAt(...ALUM), 'Alum Creek Reservoir');
  assert.equal(waterAt(...LAND), null);
  const { tables } = generate(SMALL);
  assert.deepEqual(checkRouting(tables, { asOf: AS_OF }), []);
  const wet = JSON.parse(JSON.stringify(tables));
  Object.assign(wet.properties[0], { geo_lat_e6: ALUM[0], geo_lon_e6: ALUM[1] });
  assert.ok(checkRouting(wet, { asOf: AS_OF }).includes('properties 1: coordinates on water (Alum Creek Reservoir)'));
  const dry = JSON.parse(JSON.stringify(tables));
  Object.assign(dry.properties[0], { geo_lat_e6: LAND[0], geo_lon_e6: LAND[1] });
  assert.ok(!checkRouting(dry, { asOf: AS_OF }).some((p) => /on water/.test(p)));
});

test('the outlines cover the big water bodies named in the brief, each a simple ring inside or across the box', () => {
  const names = WATER.map((w) => w.name);
  for (const n of ['Alum Creek Reservoir', 'Hoover Reservoir', "O'Shaughnessy Reservoir", 'Griggs Reservoir']) assert.ok(names.includes(n), n);
  assert.ok(names.some((n) => n.startsWith('Scioto River')) && names.includes('Olentangy River'));
  // One point inside each, well known: Hoover's water by the dam, O'Shaughnessy
  // above its dam, Griggs by Fishinger Road, the Scioto by the Broad Street
  // bridge, the Olentangy behind the stadium.
  assert.equal(waterAt(40120000, -82880000), 'Hoover Reservoir');
  assert.equal(waterAt(40180000, -83130000), "O'Shaughnessy Reservoir");
  assert.equal(waterAt(40030000, -83093000), 'Griggs Reservoir');
  assert.equal(waterAt(39960000, -83006000), 'Scioto River (downtown)');
  assert.equal(waterAt(40002000, -83023000), 'Olentangy River');
  for (const w of WATER) {
    assert.ok(w.ring.length >= 4, w.name);
    for (const [lat, lon] of w.ring) assert.ok(Number.isSafeInteger(lat) && Number.isSafeInteger(lon) && lat % 1000 === 0 && lon % 1000 === 0, `${w.name}: whole thousands`);
    assert.ok(w.ring.some(([lat, lon]) => lat > 39700000 && lat < 40300000 && lon > -83400000 && lon < -82600000), `${w.name} touches the box`);
  }
});

test('snap rounds to the 2000 micro-degree map grid half away from zero; a point wet only once snapped is refused', () => {
  assert.equal(MAP_GRID_E6, loadProfile(path.join(REPO, 'profiles', 'brightside', 'profile.yml')).routing.map_grid_e6);
  assert.deepEqual([snap(40000999), snap(40001000), snap(40001001), snap(-83000999), snap(-83001000), snap(-83001001)],
    [40000000, 40002000, 40002000, -83000000, -83002000, -83002000]);
  // Just south of Alum Creek's south edge (40.172): dry as is, wet snapped.
  const [lat, lon] = [40171100, -82960000];
  const alum = WATER.find((w) => w.name === 'Alum Creek Reservoir').ring;
  assert.equal(inRing(lat, lon, alum), false);
  assert.equal(inRing(snap(lat), snap(lon), alum), true);
  assert.equal(onWater(lat, lon), true);
});

test('every city centre and crew base is on land with room to spare, and so is every recorded home', () => {
  // Any point within `km` of (lat, lon) on water, on rings 50 m apart.
  const near = (lat, lon, km) => {
    for (let r = 0; r <= km; r += 0.05) {
      for (let a = 0; a < 360; a += 10) {
        const rad = (a * Math.PI) / 180;
        if (onWater(lat + Math.round(r * Math.sin(rad) * routing.LAT_E6_PER_KM), lon + Math.round(r * Math.cos(rad) * routing.LON_E6_PER_KM))) return true;
      }
    }
    return false;
  };
  for (const [city, km] of Object.entries(routing.CITY_KM)) {
    const c = routing.point(km);
    // Each outline already holds a margin of 250 m or more round the water.
    assert.equal(near(c.lat, c.lon, 0.5), false, `${city}'s centre is 500 m or more from any outline`);
  }
  const { tables } = generate(readSeedConfig());
  for (const c of tables.crews) assert.equal(waterAt(c.base_geo_lat_e6, c.base_geo_lon_e6), null, `crew ${c.crew_id}`);
  const wet = tables.properties.filter((p) => onWater(p.geo_lat_e6, p.geo_lon_e6)).map((p) => p.property_id);
  assert.deepEqual(wet, []);
});

test('a home that falls on water is drawn again from the water stream; the routing stream still gives two draws per home', () => {
  const calls = { main: 0, water: 0 };
  // The main stream always gives the top of the range: Northvale's north-east
  // corner, on Alum Creek Reservoir. The water stream gives the bottom of the
  // range (its south-west corner, on the Olentangy), then the centre.
  const main = { int: (lo, hi) => { calls.main++; return hi; } };
  const redraws = [(lo) => lo, (lo) => lo, () => 0, () => 0];
  const water = { int: (lo, hi) => redraws[calls.water++](lo, hi) };
  const centre = routing.point(routing.CITY_KM.Northvale);
  const [home, other] = routing.placeProperties(main, [{ property_id: 1, city: 'Northvale' }, { property_id: 2, city: 'Centerpoint' }], water);
  assert.equal(onWater(centre.lat + Math.round(2.5 * routing.LAT_E6_PER_KM), centre.lon + Math.round(2.5 * routing.LON_E6_PER_KM)), true);
  assert.equal(onWater(centre.lat - Math.round(2.5 * routing.LAT_E6_PER_KM), centre.lon - Math.round(2.5 * routing.LON_E6_PER_KM)), true);
  assert.deepEqual([home.geo_lat_e6, home.geo_lon_e6], [centre.lat, centre.lon]);
  assert.equal(calls.water, 4);
  assert.equal(calls.main, 4, 'two draws per home from the routing stream, wet or dry');
  const c = routing.point(routing.CITY_KM.Centerpoint);
  assert.deepEqual([other.geo_lat_e6, other.geo_lon_e6], [c.lat + Math.round(2.5 * routing.LAT_E6_PER_KM), c.lon + Math.round(2.5 * routing.LON_E6_PER_KM)]);
  // A city with no dry point gives up rather than looping.
  const always = { int: (lo, hi) => hi };
  assert.throws(() => routing.placeProperties(always, [{ property_id: 9, city: 'Northvale' }], always), /properties 9: no dry point near Northvale's centre/);
});

test('generation stays deterministic with redraws, and the routing stream is the same as before them', () => {
  const a = generate(SMALL);
  const b = generate(SMALL);
  for (const [name, content] of a.files) assert.equal(b.files.get(name), content, name);
  assert.equal(routing.WATER_STREAM, 'routing-water');
  assert.notEqual(routing.WATER_STREAM, routing.ROUTING_STREAM);
});

test('synthetic-off-water declares the four coordinate columns and holds exactly lib/water.js\'s edges', () => {
  const check = loadChecks(FIXTURE_DIR).find((c) => c.id === 'synthetic-off-water');
  assert.ok(check, 'checks/synthetic-off-water.sql exists');
  assert.deepEqual(check.protectedColumns.slice().sort(), COORDINATE_COLUMNS.slice().sort());
  assert.equal(check.description, 'Synthetic only: no home or crew base sits on water in the Columbus box.');
  const edges = [...check.sql.matchAll(/SELECT '((?:[^']|'')+)'(?: AS body)?, (-?\d+)(?: AS lat1)?, (-?\d+)(?: AS lon1)?, (-?\d+)(?: AS lat2)?, (-?\d+)(?: AS lon2)?\n/g)]
    .map((m) => [m[1].replace(/''/g, "'"), ...m.slice(2).map(Number)]);
  const want = WATER.flatMap((w) => w.ring.map(([lat1, lon1], i) => [w.name, lat1, lon1, ...w.ring[(i + 1) % w.ring.length]]));
  assert.deepEqual(edges, want);
  // The grid and its rounding are the map's (half away from zero).
  assert.match(check.sql, /sign\(lat\) \* \(\(abs\(lat\) \+ 1000\) \/\/ 2000\) \* 2000/);
  assert.ok(fs.readFileSync(path.join(FIXTURE_DIR, 'lib', 'water.js'), 'utf8').includes('not taken from OpenStreetMap'));
});
