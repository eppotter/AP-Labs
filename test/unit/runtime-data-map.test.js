'use strict';

// Story 15.2 (AD-R13, data-design §3), projected in Web Mercator with the tile
// mosaic since Story 15.8 (AD-R20): mapPoints, the second governed read of
// coordinate columns. It returns only integers: { points: [{ node, x, y }],
// mosaic: { z, tx0, ty0, cols, rows, ox, oy } | null }. Each place is snapped
// to the routing.map_grid_e6 grid first, the requested nodes' box widened to
// routing.map_min_span_km, then drawn at the largest whole zoom at which the
// box fits inside the padding, centred, north up. Real DuckDB tests build
// test/fixtures/routing-data (or a copy with other made-up positions) into a
// temporary file and read it with test/fixtures/profiles/routing.yml; the
// MotherDuck-mode tests use the fake instance factory. No client path.
//
// Why the pinned pixels changed in 15.8: the old projection stretched the
// box to fill the frame (x from longitude scaled by the middle latitude's
// cosine); now the frame is a whole-zoom Web Mercator view, so the box fills
// between half and all of the inner frame. The new pins come from byHand
// below (the slippy-map formulas, worked independently of the SQL) and are
// checked again by properties that need no pin: north up, east right, the
// box inside the padding, a lone node at the centre, the tile a known point
// falls in, and the span the frame shows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { build } = require('../../kit/fixture/build');
const { loadProfile, validateProfile } = require('../../kit/lib/profile');
const sqlGuard = require('../../kit/runtime/sql');
const dataModule = require('../../kit/runtime/data');
const travel = require('../../kit/runtime/data/travel');
const map = require('../../kit/runtime/data/map');
const { RoutingFault } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');
const sdk = require('../../kit/runtime/sdk');
const { createFakeMotherDuck } = require('../fixtures/fake-motherduck');

const { createData, QueryRefusedError } = dataModule;
const { mapPoints } = map;
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'routing-data');
const PROFILE_FILE = path.join(__dirname, '..', 'fixtures', 'profiles', 'routing.yml');
const SEEDS = path.join(FIXTURE, 'seeds');
const COORDINATE_COLUMNS = ['sites.pos_lat_e6', 'sites.pos_lon_e6', 'vans.home_lat_e6', 'vans.home_lon_e6'];
const TOKEN = 'fake-read-key-0000-not-a-credential';
const FRAME = Object.freeze({ width: 800, height: 600, padding: 20 });
const ALL = ['site:s1', 'site:s2', 'site:s3', 'van:v1', 'van:v2'];
const TILE = 256;

// The seeds, read as plain CSV (no quoting in them), for the hand computation.
function seedIn(dir, table) {
  const [head, ...lines] = fs.readFileSync(path.join(dir, `${table}.csv`), 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}
const seed = (table) => seedIn(SEEDS, table);
function positionsIn(dir) {
  return new Map([
    ...seedIn(dir, 'sites').filter((r) => r.pos_lat_e6).map((r) => [`site:${r.site_id}`, [Number(r.pos_lat_e6), Number(r.pos_lon_e6)]]),
    ...seedIn(dir, 'vans').map((r) => [`van:${r.van_id}`, [Number(r.home_lat_e6), Number(r.home_lon_e6)]]),
  ]);
}
const POSITIONS = positionsIn(SEEDS);

// The projection by hand, from the slippy-map formulas (OpenStreetMap wiki,
// "Slippy map tilenames"): x = (lon + 180) / 360 and y = (1 - ln(tan φ +
// sec φ) / π) / 2, the world as 1 x 1, times 256 * 2^z pixels. First snap
// each micro-degree value to the nearest grid multiple (half away from zero,
// as DuckDB's round); widen the box around its centre to the minimum span,
// north-south in degrees of latitude and east-west at the poleward edge; take
// the largest whole zoom at which the widened box, centred on its middle
// latitude (Mercator stretches poleward, so twice its longer half), fits in
// the frame inside its padding less one pixel; put the box's middle longitude
// and latitude at the frame's centre on a whole-pixel corner; the mosaic is
// the tiles under the frame.
const KM_PER_DEG = ((1 * Math.PI) / 180) * travel.EARTH_RADIUS_KM;
const MAX_LAT = 85.0511287798066;
const rad = (deg) => (deg * Math.PI) / 180;
const half = (v) => Math.sign(v) * Math.round(Math.abs(v));
const snap = (e6, grid) => (half(e6 / grid) * grid) / 1e6;
const held = (lat) => Math.min(Math.max(lat, -MAX_LAT), MAX_LAT);
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(rad(held(lat))) + 1 / Math.cos(rad(held(lat)))) / Math.PI) / 2;
// Back from a world fraction to a latitude (the inverse of mercY).
const latOf = (my) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;

function byHand(ids, frame, routing, { maxZoom = 19, positions = POSITIONS } = {}) {
  const pts = ids.filter((id) => positions.has(id)).map((id) => {
    const [lat, lon] = positions.get(id);
    return { node: id, lat: snap(lat, routing.map_grid_e6), lon: snap(lon, routing.map_grid_e6) };
  });
  if (!pts.length) return { points: [], mosaic: null };
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const midLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const degLat = Math.max(Math.max(...lats) - Math.min(...lats), routing.map_min_span_km / KM_PER_DEG);
  const latLo = midLat - degLat / 2;
  const latHi = midLat + degLat / 2;
  const edge = Math.min(Math.max(Math.abs(latLo), Math.abs(latHi)), MAX_LAT);
  const degLon = Math.max(Math.max(...lons) - Math.min(...lons), routing.map_min_span_km / (KM_PER_DEG * Math.cos(rad(edge))));
  const mx = [mercX(midLon - degLon / 2), mercX(midLon + degLon / 2)];
  const my = [mercY(latHi), mercY(latLo)];
  const myMid = mercY(midLat);
  const myHalf = Math.max(my[1] - myMid, myMid - my[0]);
  const onWorld = latLo >= -MAX_LAT && latHi <= MAX_LAT && midLon - degLon / 2 >= -180 && midLon + degLon / 2 <= 180
    && Math.max(...lons) - Math.min(...lons) <= 180;
  const room = (side) => frame[side] - 2 * frame.padding - 1;
  const fit = Math.min(room('width') / (TILE * Math.max(mx[1] - mx[0], 1e-15)), room('height') / (TILE * Math.max(2 * myHalf, 1e-15)));
  const z = Math.min(maxZoom, Math.floor(Math.log2(fit)));
  const world = TILE * 2 ** z;
  const left = half(((mx[0] + mx[1]) / 2) * world - frame.width / 2);
  const top = half(myMid * world - frame.height / 2);
  const tx0 = Math.floor(left / TILE);
  const ty0 = Math.floor(top / TILE);
  const ox = tx0 * TILE - left;
  const oy = ty0 * TILE - top;
  const cols = Math.ceil((frame.width - ox) / TILE);
  const rows = Math.ceil((frame.height - oy) / TILE);
  const drawn = onWorld && z >= 0 && tx0 >= 0 && ty0 >= 0 && tx0 + cols <= 2 ** z && ty0 + rows <= 2 ** z;
  const tiles = drawn ? { z, tx0, ty0, cols, rows, ox, oy } : null;
  return {
    points: pts.map((p) => ({ node: p.node, x: half(mercX(p.lon) * world - left), y: half(mercY(p.lat) * world - top) })),
    mosaic: tiles && cols * rows <= 64 ? tiles : null,
    // Not returned by mapPoints: for the tests below.
    tiles,
    boxPx: (zoom) => [(mx[1] - mx[0]) * TILE * 2 ** zoom, 2 * myHalf * TILE * 2 ** zoom],
  };
}
const expected = (ids, frame, routing, opts) => {
  const { points, mosaic } = byHand(ids, frame, routing, opts);
  return { points, mosaic };
};

// The ground the frame shows inside its padding, in km, derived only from the
// mosaic and the frame: north-south between the inner top and bottom edges,
// east-west along the poleward inner edge (where it is shortest).
function shownKm(mosaic, frame) {
  const world = TILE * 2 ** mosaic.z;
  const top = mosaic.ty0 * TILE - mosaic.oy;
  const latTop = latOf((top + frame.padding) / world);
  const latBottom = latOf((top + frame.height - frame.padding) / world);
  const inner = frame.width - 2 * frame.padding;
  return {
    northSouth: (latTop - latBottom) * KM_PER_DEG,
    eastWest: (inner / world) * 360 * KM_PER_DEG * Math.cos(rad(Math.max(Math.abs(latTop), Math.abs(latBottom)))),
  };
}

// The mosaic covers the frame from tiles on the world, at most 64 of them.
function assertCovers(mosaic, frame) {
  assert.deepEqual(Object.keys(mosaic), ['z', 'tx0', 'ty0', 'cols', 'rows', 'ox', 'oy']);
  for (const v of Object.values(mosaic)) assert.ok(Number.isSafeInteger(v), `${v} is an integer`);
  assert.ok(mosaic.ox <= 0 && mosaic.oy <= 0, 'the first tile starts at or before the frame');
  assert.ok(mosaic.ox + TILE * mosaic.cols >= frame.width, 'the tiles reach the right edge');
  assert.ok(mosaic.oy + TILE * mosaic.rows >= frame.height, 'the tiles reach the bottom edge');
  assert.ok(mosaic.ox > -TILE && mosaic.oy > -TILE, 'no tile column or row wholly off the frame');
  assert.ok(mosaic.tx0 >= 0 && mosaic.tx0 + mosaic.cols <= 2 ** mosaic.z && mosaic.ty0 >= 0 && mosaic.ty0 + mosaic.rows <= 2 ** mosaic.z);
  assert.ok(mosaic.cols * mosaic.rows <= 64);
  assert.ok(Object.isFrozen(mosaic));
}

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-map-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function builtFile(t, fixtureDir = FIXTURE) {
  const file = path.join(tmpDir(t), 'route-co.duckdb');
  await build({ fixtureDir, out: file });
  return file;
}

// A copy of the fixture with other made-up site positions ([lat_e6, lon_e6]
// for s1, s2, s3; s4 stays without one). Returns the fixture dir.
function fixtureWith(t, sites) {
  const dir = tmpDir(t);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const rows = seed('sites').map((r, i) => (sites[i] ? { ...r, pos_lat_e6: String(sites[i][0]), pos_lon_e6: String(sites[i][1]) } : r));
  const head = Object.keys(rows[0]);
  fs.writeFileSync(path.join(dir, 'seeds', 'sites.csv'), `${[head.join(','), ...rows.map((r) => head.map((h) => r[h]).join(','))].join('\n')}\n`);
  return dir;
}

// The fixture profile, optionally edited (re-validated, so defaults fill).
function profileWith(edit) {
  if (!edit) return loadProfile(PROFILE_FILE);
  const raw = YAML.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
  edit(raw);
  return validateProfile(raw);
}

// The fixture profile with a routing.basemap block. Story 15.9 adds the block
// to the schema; until then it is set on the loaded profile, past validation.
const withBasemap = (basemap) => {
  const loaded = profileWith();
  return { ...loaded, routing: { ...loaded.routing, basemap } };
};

async function source(t, profile = profileWith(), fixtureDir = FIXTURE) {
  const data = createData({ file: await builtFile(t, fixtureDir), profile });
  t.after(() => data.close());
  return data;
}

// A data object over no file: anything that reaches DuckDB fails as unavailable.
function offline(t, profile = profileWith()) {
  return createData({ file: path.join(tmpDir(t), 'none.duckdb'), profile });
}

const refused = (field, problem) => (err) => {
  assert.ok(err instanceof RoutingFault, `a RoutingFault, got ${err && err.stack}`);
  assert.deepEqual(err.details, { field, problem });
  assert.equal(err.message, `routing input refused: "${field}" ${problem}`);
  return true;
};

// Every coordinate value in the seeds (the depot's too), as an integer and as degrees.
const COORDINATE_TEXT = [...[...POSITIONS.values()].flat(), ...seed('depots').map((r) => Number(r.pos_lat_e6))]
  .flatMap((v) => [String(v), String(v / 1e6), (v / 1e6).toFixed(6)]);
const ADDRESSES = seed('sites').flatMap((r) => [r.street_address, r.phone]);

// --- The projection ------------------------------------------------------------

test('returns { points, mosaic }: node, x, y and the mosaic as integers, matching the hand-computed Web Mercator projection, in the order asked', async (t) => {
  const profile = profileWith();
  assert.equal(profile.routing.map_grid_e6, 2000, 'the default grid');
  assert.equal(profile.routing.map_min_span_km, 5, 'the default minimum span');
  const data = await source(t, profile);
  const ids = ['van:v2', 'site:s1', 'site:s3', 'van:v1', 'site:s2'];
  const got = await mapPoints(data, ids, FRAME);
  assert.deepEqual(Object.keys(got), ['points', 'mosaic']);
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got.points));
  assert.deepEqual(got, expected(ids, FRAME, profile.routing));
  assert.deepEqual(got.points.map((p) => p.node), ids);
  for (const p of got.points) {
    assert.deepEqual(Object.keys(p), ['node', 'x', 'y']);
    assert.ok(Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y));
    assert.ok(p.x >= FRAME.padding && p.x <= FRAME.width - FRAME.padding, `x ${p.x} inside the padding`);
    assert.ok(p.y >= FRAME.padding && p.y <= FRAME.height - FRAME.padding, `y ${p.y} inside the padding`);
    assert.ok(Object.isFrozen(p));
  }
  assertCovers(got.mosaic, FRAME);
  // Pinned once from byHand, so the test and the SQL cannot drift together.
  // The box (about 27 km north-south) fits 560 px at zoom 11 (about 58 m a
  // pixel at 41°), not at 12, so it fills most of the frame's height.
  assert.deepEqual(got.points.map(({ x, y }) => [x, y]), [[627, 70], [403, 314], [172, 530], [336, 360], [484, 190]]);
  assert.deepEqual(got.mosaic, { z: 11, tx0: 603, ty0: 765, cols: 4, rows: 4, ox: -107, oy: -176 });
  // North up, east right.
  const at = Object.fromEntries(got.points.map((p) => [p.node, p]));
  assert.ok(at['van:v2'].y < at['site:s2'].y && at['site:s2'].y < at['site:s1'].y && at['site:s1'].y < at['site:s3'].y, 'north is up');
  assert.ok(at['van:v2'].x > at['site:s2'].x && at['site:s2'].x > at['site:s3'].x, 'east is right');
});

test('a reference point falls in its slippy-map tile: s1 at zoom 13 is tile 2419 / 3067 (worked by hand)', async (t) => {
  // s1 is 41123457, -73654321, snapped to 41.124, -73.654. At zoom 13 (8192
  // tiles a side): x = (-73.654 + 180) / 360 * 8192 = 2419.96, tile 2419;
  // y = (1 - ln(tan 41.124° + sec 41.124°) / π) / 2 * 8192 = 3067.65, tile 3067.
  const data = await source(t);
  const { points: [s1], mosaic } = await mapPoints(data, ['site:s1'], FRAME);
  assert.equal(mosaic.z, 13, 'a lone node: the 5 km floor fits 560 px at zoom 13, not 14');
  assert.deepEqual([mosaic.tx0 + Math.floor((s1.x - mosaic.ox) / TILE), mosaic.ty0 + Math.floor((s1.y - mosaic.oy) / TILE)], [2419, 3067]);
  // And within the tile, at the fraction the formula gives (to a pixel).
  assert.ok(Math.abs(((s1.x - mosaic.ox) % TILE) - 0.9623 * TILE) <= 1, 'x within its tile');
  assert.ok(Math.abs(((s1.y - mosaic.oy) % TILE) - 0.6517 * TILE) <= 1, 'y within its tile');
});

test('z is the largest whole zoom (at most 19) at which the widened box fits; the frame shows at least 5 km each way', async (t) => {
  const profile = profileWith();
  const data = await source(t, profile);
  const inner = (side) => FRAME[side] - 2 * FRAME.padding;
  for (const ids of [['site:s1'], ['site:s1', 'van:v1'], ALL, ['site:s3', 'van:v2']]) {
    const { mosaic } = await mapPoints(data, ids, FRAME);
    const hand = byHand(ids, FRAME, profile.routing);
    const [w, h] = hand.boxPx(mosaic.z);
    assert.ok(w <= inner('width') - 1 && h <= inner('height') - 1, `${ids}: the box fits at z ${mosaic.z}`);
    const [w1, h1] = hand.boxPx(mosaic.z + 1);
    assert.ok(w1 > inner('width') - 1 || h1 > inner('height') - 1, `${ids}: the box does not fit at z ${mosaic.z + 1}`);
    assert.ok(mosaic.z <= 19);
    const shown = shownKm(mosaic, FRAME);
    assert.ok(shown.northSouth >= 5, `${ids}: ${shown.northSouth} km north-south`);
    assert.ok(shown.eastWest >= 5, `${ids}: ${shown.eastWest} km east-west`);
  }
  // A lone node: the 5 km floor alone sets the zoom. Shown at zoom 13 it is
  // about 8 km high (under twice the floor); at 14 it would be under 5 km.
  const { mosaic } = await mapPoints(data, ['site:s1'], FRAME);
  const shown = shownKm(mosaic, FRAME);
  assert.ok(shown.northSouth < 10 && shown.eastWest < 2 * 5 * (inner('width') / inner('height')), 'never more than twice the floor on the tighter side');
  assert.ok(shownKm({ ...mosaic, z: mosaic.z + 1, ty0: mosaic.ty0 * 2 }, FRAME).northSouth < 5, 'one zoom in would show under 5 km');
  // A wider floor zooms out (a lower z) around the same centre.
  const wide = await mapPoints(await source(t, profileWith((p) => { p.routing.map_min_span_km = 50; })), ['site:s1'], FRAME);
  assert.ok(wide.mosaic.z < mosaic.z);
  assert.ok(shownKm(wide.mosaic, FRAME).northSouth >= 50 && shownKm(wide.mosaic, FRAME).eastWest >= 50);
  assert.deepEqual(wide.points, [{ node: 'site:s1', x: 400, y: 300 }]);
});

test('routing.basemap.max_zoom caps the zoom; absent, 19 is the cap; a value outside 0 to 19 is refused before running', async (t) => {
  assert.equal(map.MAX_ZOOM, 19);
  const file = await builtFile(t);
  const read = async (profile, ids = ['site:s1']) => {
    const data = createData({ file, profile });
    t.after(() => data.close());
    return mapPoints(data, ids, FRAME);
  };
  const free = await read(withBasemap({}));
  assert.equal(free.mosaic.z, 13, 'a block without max_zoom: 19 is the cap, the fit gives 13');
  const capped = await read(withBasemap({ max_zoom: 12 }));
  assert.deepEqual(capped, expected(['site:s1'], FRAME, profileWith().routing, { maxZoom: 12 }));
  assert.equal(capped.mosaic.z, 12);
  assert.deepEqual(capped.points, [{ node: 'site:s1', x: 400, y: 300 }], 'still centred');
  assertCovers(capped.mosaic, FRAME);
  // A cap of 0: the world is one 256 px tile, smaller than the frame, so the
  // tiles cannot cover it: no mosaic, and the point is still centred.
  const world = await read(withBasemap({ max_zoom: 0 }));
  assert.deepEqual(world, { points: [{ node: 'site:s1', x: 400, y: 300 }], mosaic: null });
  const checks = t.mock.method(sqlGuard, 'checkSql');
  for (const bad of [20, -1, 1.5, '19', null, Number.NaN]) {
    await assert.rejects(mapPoints(offline(t, withBasemap({ max_zoom: bad })), ['site:s1'], FRAME), refused('routing.basemap.max_zoom', 'out_of_range'), String(bad));
  }
  for (const bad of ['on', 19, ['max_zoom']]) {
    await assert.rejects(mapPoints(offline(t, withBasemap(bad)), ['site:s1'], FRAME), refused('routing.basemap', 'not_object'), JSON.stringify(bad));
  }
  assert.equal(checks.mock.callCount(), 0, 'nothing reached the guard or DuckDB');
  checks.mock.restore();
  // 19, the top of the range, is allowed: the read runs on the built file and
  // gives the same map as no cap at all.
  const top = await read(withBasemap({ max_zoom: 19 }));
  assert.deepEqual(top, expected(['site:s1'], FRAME, profileWith().routing, { maxZoom: 19 }));
  assert.deepEqual(top, free);
  assertCovers(top.mosaic, FRAME);
});

test('the mosaic covers the frame for every frame shape, and the points share its pixel grid', async (t) => {
  const profile = profileWith();
  const data = await source(t, profile);
  const frames = [FRAME, { width: 700, height: 560, padding: 40 }, { width: 200, height: 200, padding: 0 },
    { width: 1234, height: 987, padding: 56 }, { width: 333, height: 1201, padding: 7 }, { width: 1999, height: 211, padding: 99 }];
  for (const frame of frames) {
    for (const ids of [['site:s1'], ALL]) {
      const got = await mapPoints(data, ids, frame);
      assert.deepEqual(got, expected(ids, frame, profile.routing), `${JSON.stringify(frame)} ${ids}`);
      if (got.mosaic) assertCovers(got.mosaic, frame);
      for (const p of got.points) {
        assert.ok(p.x >= frame.padding && p.x <= frame.width - frame.padding && p.y >= frame.padding && p.y <= frame.height - frame.padding, `${JSON.stringify(frame)} ${p.node} inside the padding`);
      }
    }
  }
});

test('coordinates are snapped to the grid first: two places in one grid cell get the same pixel', async (t) => {
  // At a 0.2° grid, s1 and s2 fall in one cell; s3 does not.
  const profile = profileWith((p) => { p.routing.map_grid_e6 = 200000; });
  const data = await source(t, profile);
  const got = await mapPoints(data, ['site:s1', 'site:s2', 'site:s3'], FRAME);
  assert.deepEqual(got, expected(['site:s1', 'site:s2', 'site:s3'], FRAME, profile.routing));
  const [s1, s2, s3] = got.points;
  assert.deepEqual([s1.x, s1.y], [s2.x, s2.y], 's1 and s2 share a marker');
  assert.notDeepEqual([s1.x, s1.y], [s3.x, s3.y]);
  // At the default grid they are apart.
  const fine = (await mapPoints(await source(t), ['site:s1', 'site:s2'], FRAME)).points;
  assert.notDeepEqual([fine[0].x, fine[0].y], [fine[1].x, fine[1].y]);
});

test('a box smaller than the minimum span is widened: one node, or a one-cell cluster, sits at the centre', async (t) => {
  const data = await source(t);
  assert.deepEqual((await mapPoints(data, ['site:s1'], FRAME)).points, [{ node: 'site:s1', x: 400, y: 300 }]);
  const coarse = await source(t, profileWith((p) => { p.routing.map_grid_e6 = 200000; }));
  assert.deepEqual((await mapPoints(coarse, ['site:s1', 'site:s2'], FRAME)).points, [
    { node: 'site:s1', x: 400, y: 300 }, { node: 'site:s2', x: 400, y: 300 },
  ]);
  // s1 and v1 are about 2.7 km apart north-south and 3.9 km east-west: both
  // sides widen to 5 km, which fits 560 px at zoom 13 (about 14.4 m a pixel at
  // 41°), so they sit about 3.9 km = 268 px apart east-west, around the centre.
  const profile = profileWith();
  const pair = await mapPoints(data, ['site:s1', 'van:v1'], FRAME);
  assert.deepEqual(pair, expected(['site:s1', 'van:v1'], FRAME, profile.routing));
  assert.equal(pair.mosaic.z, 13);
  assert.deepEqual(pair.points.map(({ x, y }) => [x, y]), [[534, 207], [266, 392]]);
  const metresPerPx = (2 * Math.PI * travel.EARTH_RADIUS_KM * 1000 * Math.cos(rad(41.112))) / (TILE * 2 ** 13);
  const kmEastWest = ((pair.points[0].x - pair.points[1].x) * metresPerPx) / 1000;
  assert.ok(kmEastWest > 3.8 && kmEastWest < 3.9, `${kmEastWest} km east-west at zoom 13`);
  // The box's centre is the frame's centre (to a pixel).
  assert.ok(Math.abs((pair.points[0].x + pair.points[1].x) / 2 - 400) <= 1);
  assert.ok(Math.abs((pair.points[0].y + pair.points[1].y) / 2 - 300) <= 1);
});

test('the frame fits only the nodes asked for: other nodes never widen it', async (t) => {
  const data = await source(t);
  const some = await mapPoints(data, ['site:s1', 'site:s2'], FRAME);
  const all = await mapPoints(data, ALL, FRAME);
  assert.notDeepEqual(some.points, all.points.filter((p) => p.node === 'site:s1' || p.node === 'site:s2'));
  assert.notDeepEqual(some.mosaic, all.mosaic);
  assert.deepEqual(some, expected(['site:s1', 'site:s2'], FRAME, profileWith().routing));
});

test('an unknown node id, or a node whose coordinate is null, is left out and the rest return (F16)', async (t) => {
  const data = await source(t);
  const got = await mapPoints(data, ['site:zz', 'site:s1', 'site:s4', 'van:s1'], FRAME);
  assert.deepEqual(got.points, [{ node: 'site:s1', x: 400, y: 300 }]);
  assert.deepEqual(got.mosaic, (await mapPoints(data, ['site:s1'], FRAME)).mosaic);
  assert.deepEqual(await mapPoints(data, ['site:s4', 'site:zz'], FRAME), { points: [], mosaic: null });
});

test('an empty list is an empty result, read from nothing', async (t) => {
  const data = offline(t);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  assert.deepEqual(await mapPoints(data, [], FRAME), { points: [], mosaic: null });
  assert.equal(checks.mock.callCount(), 0);
});

// --- No mosaic: too many tiles, the antimeridian, past ±85.0511° ---------------

test('a frame needing more than 64 tiles has no mosaic; the points still return', async (t) => {
  assert.equal(map.MAX_TILES, 64);
  const profile = profileWith();
  const data = await source(t, profile);
  const frame = { width: 2000, height: 2000, padding: 0 };
  const hand = byHand(['site:s1'], frame, profile.routing);
  assert.ok(hand.tiles.cols * hand.tiles.rows > 64, `${hand.tiles.cols} x ${hand.tiles.rows} tiles`);
  const got = await mapPoints(data, ['site:s1'], frame);
  assert.deepEqual(got, { points: [{ node: 'site:s1', x: 1000, y: 1000 }], mosaic: null });
  // 2000 x 1000 needs at most 9 x 5: a mosaic.
  const wide = await mapPoints(data, ['site:s1'], { width: 2000, height: 1000, padding: 0 });
  assertCovers(wide.mosaic, { width: 2000, height: 1000 });
});

test('a box crossing the antimeridian has no mosaic; the points still return', async (t) => {
  const profile = profileWith();
  // s1 just west of 180°: the 5 km box crosses it. s2 and s3 on either side.
  const dir = fixtureWith(t, [[10000000, 179990000], [-20000000, 179950000], [-20000000, -179950000]]);
  const data = await source(t, profile, dir);
  const positions = positionsIn(path.join(dir, 'seeds'));
  const one = await mapPoints(data, ['site:s1'], FRAME);
  assert.deepEqual(one, { points: [{ node: 'site:s1', x: 400, y: 300 }], mosaic: null });
  const both = await mapPoints(data, ['site:s2', 'site:s3'], FRAME);
  assert.deepEqual(both, expected(['site:s2', 'site:s3'], FRAME, profile.routing, { positions }));
  assert.equal(both.mosaic, null);
  assert.equal(both.points.length, 2);
  for (const p of both.points) assert.ok(p.x >= FRAME.padding && p.x <= FRAME.width - FRAME.padding);
});

test('a wide cluster straddling the antimeridian (nodes more than 180° apart) has no mosaic; the points still return', async (t) => {
  // 170°E and 170°W are 20° apart across the antimeridian, but read as a box
  // they span 340° the long way round, a box that stays inside ±180°: without
  // the spread check it would get a whole-world mosaic.
  const profile = profileWith();
  const dir = fixtureWith(t, [[-17000000, 170000000], [-17000000, -170000000]]);
  const data = await source(t, profile, dir);
  const positions = positionsIn(path.join(dir, 'seeds'));
  const frame = { width: 1000, height: 600, padding: 0 };
  const got = await mapPoints(data, ['site:s1', 'site:s2'], frame);
  assert.equal(got.mosaic, null);
  assert.equal(got.points.length, 2);
  assert.deepEqual(got, expected(['site:s1', 'site:s2'], frame, profile.routing, { positions }));
  for (const p of got.points) assert.ok(p.x >= 0 && p.x <= frame.width && p.y >= 0 && p.y <= frame.height);
  // Each alone is well inside the world: its mosaic is there.
  for (const id of ['site:s1', 'site:s2']) assertCovers((await mapPoints(data, [id], frame)).mosaic, frame);
});

test('a box reaching beyond ±85.0511° has no mosaic; the points still return, inside the frame', async (t) => {
  assert.equal(map.MAX_LAT, 85.0511287798066);
  const profile = profileWith();
  // s1 just inside the edge (its 5 km box goes past it), s2 at 89° north, s3 past the south edge.
  const dir = fixtureWith(t, [[85040000, 10000000], [89000000, 20000000], [-85040000, 30000000]]);
  const data = await source(t, profile, dir);
  const positions = positionsIn(path.join(dir, 'seeds'));
  for (const id of ['site:s1', 'site:s2', 'site:s3']) {
    const got = await mapPoints(data, [id], FRAME);
    assert.deepEqual(got, { points: [{ node: id, x: 400, y: 300 }], mosaic: null }, id);
  }
  const all = await mapPoints(data, ['site:s1', 'site:s2', 'site:s3', 'van:v1'], FRAME);
  assert.deepEqual(all, expected(['site:s1', 'site:s2', 'site:s3', 'van:v1'], FRAME, profile.routing, { positions }));
  assert.equal(all.mosaic, null);
  assert.equal(all.points.length, 4);
  // Just inside: a box wholly within ±85.0511° has its mosaic.
  const near = await mapPoints(await source(t, profile, fixtureWith(t, [[84900000, 10000000]])), ['site:s1'], FRAME);
  assertCovers(near.mosaic, FRAME);
});

// --- What never comes back ---------------------------------------------------

test('the output holds no coordinate value, address or phone (scan of the serialized result)', async (t) => {
  const data = await source(t);
  const text = JSON.stringify(await mapPoints(data, ALL, FRAME));
  for (const v of [...COORDINATE_TEXT, ...ADDRESSES]) assert.ok(!text.includes(v), `the output holds ${v}`);
  assert.ok(!/lat|lon/i.test(text), 'no latitude or longitude key');
});

// --- Refused before running --------------------------------------------------

test('a frame out of bounds or of the wrong shape is refused before running', async (t) => {
  const data = offline(t);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  const cases = [
    [null, 'frame', 'not_object'],
    [[800, 600, 20], 'frame', 'not_object'],
    ['800x600', 'frame', 'not_object'],
    [{ width: 800, height: 600 }, 'frame.padding', 'missing'],
    [{ height: 600, padding: 0 }, 'frame.width', 'missing'],
    [{ width: 800.5, height: 600, padding: 0 }, 'frame.width', 'not_integer'],
    [{ width: '800', height: 600, padding: 0 }, 'frame.width', 'not_integer'],
    [{ width: 800, height: Infinity, padding: 0 }, 'frame.height', 'not_integer'],
    [{ width: 199, height: 600, padding: 0 }, 'frame.width', 'out_of_range'],
    [{ width: 2001, height: 600, padding: 0 }, 'frame.width', 'out_of_range'],
    [{ width: 800, height: 199, padding: 0 }, 'frame.height', 'out_of_range'],
    [{ width: 800, height: 2001, padding: 0 }, 'frame.height', 'out_of_range'],
    [{ width: 800, height: 600, padding: -1 }, 'frame.padding', 'out_of_range'],
    [{ width: 800, height: 600, padding: 201 }, 'frame.padding', 'out_of_range'],
    [{ width: 200, height: 600, padding: 100 }, 'frame.padding', 'out_of_range'],
    // No room left to draw in once the rounding pixel is kept (201 - 200 - 1 = 0).
    [{ width: 201, height: 201, padding: 100 }, 'frame.padding', 'out_of_range'],
    [{ width: 800, height: 201, padding: 100 }, 'frame.padding', 'out_of_range'],
    [{ width: 800, height: 600, padding: 20, zoom: 4 }, 'frame.zoom', 'out_of_range'],
  ];
  for (const [frame, field, problem] of cases) {
    await assert.rejects(mapPoints(data, ['site:s1'], frame), refused(field, problem), JSON.stringify(frame));
  }
  assert.equal(checks.mock.callCount(), 0, 'nothing reached the guard or DuckDB');
  // The bounds themselves are allowed (and then fail only for want of the file).
  for (const frame of [{ width: 200, height: 200, padding: 0 }, { width: 2000, height: 2000, padding: 200 }, { width: 201, height: 201, padding: 99 }]) {
    await assert.rejects(mapPoints(data, ['site:s1'], frame), refused('mapPoints', 'data_unavailable'), JSON.stringify(frame));
  }
});

test('a node id without a declared kind prefix, or a duplicate, is refused before running', async (t) => {
  const data = offline(t);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await assert.rejects(mapPoints(data, 'site:s1', FRAME), refused('nodeIds', 'not_list'));
  await assert.rejects(mapPoints(data, ['site:s1', 7], FRAME), refused('nodeIds[1]', 'not_text'));
  for (const bad of ['s1', ':s1', 'property:s1', 'crew:v1', 'site:', "site:s1' OR 1=1 --", 'site:s1,site:s2', 'SITE:s1', `site:${'x'.repeat(65)}`]) {
    await assert.rejects(mapPoints(data, ['site:s2', bad], FRAME), refused('nodeIds[1]', 'bad_node'), bad);
  }
  await assert.rejects(mapPoints(data, ['site:s1', 'van:v1', 'site:s1'], FRAME), refused('nodeIds[2]', 'duplicate'));
  assert.equal(checks.mock.callCount(), 0, 'nothing reached the guard or DuckDB');
});

test('more than routing.max_points ids is refused before running (default 500)', async (t) => {
  assert.equal(profileWith().routing.max_points, 500);
  const data = offline(t, profileWith((p) => { p.routing.max_points = 3; }));
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await assert.rejects(mapPoints(data, ['site:s1', 'site:s2', 'site:s3', 'van:v1'], FRAME), refused('nodeIds', 'out_of_range'));
  // Counted before each id is read: a long list of junk is refused by its size.
  await assert.rejects(mapPoints(data, Array.from({ length: 4 }, () => 'junk'), FRAME), refused('nodeIds', 'out_of_range'));
  assert.equal(checks.mock.callCount(), 0);
  // Exactly the cap is allowed (and then fails only for want of the file).
  await assert.rejects(mapPoints(data, ['site:s1', 'site:s2', 'site:s3'], FRAME), refused('mapPoints', 'data_unavailable'));
  const big = offline(t);
  await assert.rejects(mapPoints(big, Array.from({ length: 501 }, (_, i) => `site:n${i}`), FRAME), refused('nodeIds', 'out_of_range'));
});

test('a routing block without its map keys, or with a floor lowered, is refused, never read as "no limit"', async (t) => {
  const loaded = profileWith();
  const cases = [
    ['max_points', undefined], ['max_points', 0], ['map_grid_e6', undefined], ['map_grid_e6', 1999], ['map_grid_e6', 2000.5],
    ['map_min_span_km', undefined], ['map_min_span_km', 4.99], ['map_min_span_km', Number.NaN],
  ];
  for (const [key, value] of cases) {
    const routing = { ...loaded.routing };
    if (value === undefined) delete routing[key];
    else routing[key] = value;
    const data = offline(t, { ...loaded, routing });
    await assert.rejects(mapPoints(data, ['site:s1'], FRAME), refused(`routing.${key}`, 'out_of_range'), `${key} ${value}`);
  }
  assert.equal(map.MAP_GRID_FLOOR_E6, 2000);
  assert.equal(map.MAP_MIN_SPAN_FLOOR_KM, 5);
});

test('with no routing block, mapPoints refuses (routing is off)', async (t) => {
  const data = offline(t, { client: { id: 'x' }, sql: { forbidden_columns: [] } });
  await assert.rejects(mapPoints(data, ['site:s1'], FRAME), refused('routing', 'routing_off'));
});

// --- The column checks ---------------------------------------------------------

test('declaring street_address as a coordinate column is refused before the points query runs (not INTEGER/BIGINT)', async (t) => {
  const profile = profileWith((p) => {
    p.sql.forbidden_columns.push('sites.street_address');
    p.routing.coordinates.nodes[0].lat_column = 'street_address';
  });
  const data = await source(t, profile);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await assert.rejects(mapPoints(data, ['site:s1'], FRAME), refused('routing.coordinates.nodes[0].lat_column', 'not_coordinate_column'));
  assert.deepEqual(checks.mock.calls.map((c) => c.arguments[0]), [travel.COLUMN_TYPES_SQL], 'only the column-type query ran');
});

test('a forbidden column in another table with a declared coordinate column\'s name is refused before any query', async (t) => {
  const profile = profileWith((p) => { p.sql.forbidden_columns.push('depots.pos_lat_e6'); });
  const data = await source(t, profile);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await assert.rejects(mapPoints(data, ['site:s1'], FRAME), refused('routing.coordinates.nodes[0].lat_column', 'shared_column_name'));
  assert.equal(checks.mock.callCount(), 0, 'nothing reached the guard or DuckDB');
});

// --- The guard: exactly the coordinate columns dropped ------------------------

test('checkSql runs with the profile\'s forbidden list minus exactly the declared coordinate columns', async (t) => {
  const profile = profileWith((p) => { p.sql.forbidden_columns.push('sites.phone', 'sites.street_address'); });
  const data = await source(t, profile);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await mapPoints(data, ['site:s1', 'van:v1'], FRAME);
  const [types, points] = checks.mock.calls.map((c) => c.arguments[1].forbiddenColumns);
  assert.deepEqual(types, profile.sql.forbidden_columns, 'the column-type query runs under the full list');
  assert.deepEqual(points, ['sites.phone', 'sites.street_address']);
  assert.deepEqual(profile.sql.forbidden_columns.filter((c) => !points.includes(c)).sort(), [...COORDINATE_COLUMNS].sort());
});

test('every other forbidden column still applies: an id column the profile forbids is refused', async (t) => {
  const data = await source(t, profileWith((p) => { p.sql.forbidden_columns.push('sites.site_id'); }));
  await assert.rejects(mapPoints(data, ['site:s1'], FRAME), refused('mapPoints', 'query_refused'));
});

test('node ids and frame numbers reach DuckDB only as bound parameters: one static template, a fixed select list', async (t) => {
  const data = await source(t);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await mapPoints(data, ['site:s1'], FRAME);
  await mapPoints(data, ['van:v2', 'site:s3'], { width: 1234, height: 987, padding: 43 });
  const sqls = checks.mock.calls.map((c) => c.arguments[0]);
  assert.equal(sqls.length, 4, 'the column-type query and the points query, twice');
  assert.equal(sqls[0], travel.COLUMN_TYPES_SQL);
  assert.equal(sqls[1], sqls[3], 'one static template');
  for (const sql of sqls) {
    const text = sql.replace(/\$\w+/g, '');
    assert.ok(!/s1|s2|s3|v1|v2|1234|987|43/.test(text), 'no id or frame number in the text');
  }
  // The fixed select list (AD-R20): node, then x, y and the mosaic, each cast to INTEGER.
  const select = sqls[1].slice(sqls[1].lastIndexOf('\nSELECT s.node AS node,'));
  assert.match(select, /^\nSELECT s\.node AS node,$/m);
  const columns = [...select.matchAll(/AS INTEGER\)(?: END)? AS (\w+),?$/gm)].map((m) => m[1]);
  assert.deepEqual(['node', ...columns], [...map.SELECT_LIST]);
  assert.deepEqual([...map.SELECT_LIST], ['node', 'x', 'y', 'z', 'tx0', 'ty0', 'cols', 'rows', 'ox', 'oy']);
  assert.equal(select.split('\n').filter((l) => /^ {2}\S/.test(l)).length, 9, 'nine columns after node, nothing else');
  assert.match(select, /\nFROM s CROSS JOIN k\nORDER BY node$/);
  assert.deepEqual([...sqls[1].matchAll(/\$(\w+)/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort(), [...map.POINTS_PARAMS].sort());
  const read = new Set([...sqls[1].matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/g)].map((m) => m[1]));
  assert.deepEqual([...read].sort(), ['b', 'k', 'm', 'nodes', 'o', 's', 'sites', 't', 'vans', 'w', 'z'], 'only the declared tables and its own steps');
});

test('the Earth radius is travelMatrix\'s (6371.0088 km), and the grid snap comes before the box', () => {
  assert.equal(travel.EARTH_RADIUS_KM, 6371.0088);
  const sql = map.pointsSql(profileWith().routing);
  assert.equal(sql.split('6371.0088').length - 1, 2, 'both km-per-degree factors use it');
  assert.ok(sql.indexOf('$grid_e6') < sql.indexOf('min(_map_lat)'), 'snapped before the box is taken');
  assert.ok(!/lat_e6|lon_e6/.test(sql.slice(sql.indexOf('\nb AS ('))), 'nothing after the snap sees the raw values');
});

test('run() still refuses each coordinate column after a map read, and no option drops one', async (t) => {
  const data = await source(t);
  await mapPoints(data, ALL, FRAME);
  for (const fc of COORDINATE_COLUMNS) {
    const [table, column] = fc.split('.');
    await assert.rejects(data.run(`SELECT ${column} FROM ${table}`), (err) => err instanceof QueryRefusedError && err.rule === 'forbidden_column', fc);
    await assert.rejects(
      data.run(`SELECT ${column} FROM ${table}`, {}, { declared: [], forbiddenColumns: [], mapPoints: true }),
      (err) => err instanceof QueryRefusedError && err.rule === 'forbidden_column',
      `${fc} with options`,
    );
  }
});

// --- Who may call it ------------------------------------------------------------

test('mapPoints is not a key of the data object, and the sdk does not export it', async (t) => {
  const data = await source(t);
  assert.ok(Object.isFrozen(data));
  assert.deepEqual(Object.keys(data), ['open', 'run', 'travelMatrix', 'describe', 'close']);
  assert.equal('mapPoints' in data, false);
  assert.deepEqual(Object.getOwnPropertyNames(data).sort(), ['close', 'describe', 'open', 'run', 'travelMatrix']);
  assert.deepEqual(Object.getOwnPropertySymbols(data), []);
  assert.equal(Object.hasOwn(sdk, 'mapPoints'), false);
  assert.equal(sdk.mapPoints, undefined);
  for (const [name, value] of Object.entries(sdk)) assert.notEqual(value, mapPoints, `sdk.${name}`);
  assert.equal(Object.hasOwn(dataModule, 'mapPoints'), false);
  // The test ctx a module gets has no way to it either.
  await assert.rejects(mapPoints(sdk.testContext().data, ['site:s1'], FRAME), refused('mapPoints', 'data_unavailable'));
});

test('mapPoints reads only through a data object createData made; attach takes one read, once', async (t) => {
  for (const bad of [null, undefined, {}, 'data', Object.freeze({ run: async () => [] })]) {
    await assert.rejects(mapPoints(bad, ['site:s1'], FRAME), refused('mapPoints', 'data_unavailable'));
  }
  const data = offline(t);
  assert.throws(() => map.attach(data, async () => []), TypeError, 'already attached by createData');
  assert.throws(() => map.attach({}, async () => []), TypeError, 'not frozen');
  assert.throws(() => map.attach(Object.freeze({}), null), TypeError, 'not a function');
  const mine = Object.freeze({});
  map.attach(mine, async () => [{ node: 'x', x: 1, y: 1 }]);
  assert.throws(() => map.attach(mine, async () => []), TypeError, 'once');
  for (const [name, value] of Object.entries(map)) {
    if (typeof value === 'function' && name !== 'mapPoints') assert.notEqual(value.constructor.name, 'AsyncFunction', `${name} runs nothing`);
  }
});

// --- Errors: fixed text, shared limits ---------------------------------------

test('a DuckDB error is a fixed-text RoutingFault: no SQL, path or value', async (t) => {
  const profile = profileWith((p) => { p.routing.coordinates.nodes[0].id_column = 'site_ref'; });
  const file = await builtFile(t);
  const data = createData({ file, profile });
  t.after(() => data.close());
  const err = await mapPoints(data, ['site:s1'], FRAME).catch((e) => e);
  refused('mapPoints', 'query_failed')(err);
  for (const leak of ['site_ref', 'SELECT', 'pos_lat_e6', path.basename(file), path.dirname(file), 'Binder']) {
    assert.ok(!err.message.includes(leak) && !JSON.stringify(err.details).includes(leak), leak);
  }
  assert.equal(err.cause, undefined, 'the original error is not carried');
  const words = messageFor(err, { admin: 'Sam' });
  assert.ok(!words.includes('site_ref') && !words.includes('SELECT'));
  assert.match(words, /mapPoints/);
});

test('a missing data file is a fixed-text RoutingFault (data unavailable)', async (t) => {
  await assert.rejects(mapPoints(offline(t), ['site:s1'], FRAME), refused('mapPoints', 'data_unavailable'));
});

test('a row the read did not ask for, a repeated row, or a pixel outside the frame is refused by fixed words', () => {
  const ids = ['site:s1', 'site:s2'];
  const none = { z: null, tx0: null, ty0: null, cols: null, rows: null, ox: null, oy: null };
  const row = (r) => ({ ...none, ...r });
  assert.deepEqual(map.result([row({ node: 'site:s2', x: 0, y: 600 })], ids, FRAME), { points: [{ node: 'site:s2', x: 0, y: 600 }], mosaic: null });
  assert.deepEqual(map.result([], ids, FRAME), { points: [], mosaic: null });
  assert.throws(() => map.result([row({ node: 'site:s9', x: 1, y: 1 })], ids, FRAME), refused('mapPoints', 'query_failed'));
  assert.throws(() => map.result([row({ node: 'site:s1', x: 1, y: 1 }), row({ node: 'site:s1', x: 2, y: 2 })], ids, FRAME), refused('mapPoints', 'duplicate'));
  for (const [x, y] of [[-1, 1], [801, 1], [1, -1], [1, 601], [1.5, 1], ['1', 1], [null, 1]]) {
    assert.throws(() => map.result([row({ node: 'site:s1', x, y })], ids, FRAME), refused('mapPoints', 'query_failed'), `${x},${y}`);
  }
});

test('the mosaic columns must agree on every row and cover the frame from tiles on the world, else query_failed; over 64 tiles is no mosaic', () => {
  const ids = ['site:s1', 'site:s2'];
  const good = Object.freeze({ z: 11, tx0: 603, ty0: 765, cols: 4, rows: 4, ox: -107, oy: -176 });
  const rows = (a, b = a) => [{ node: 'site:s1', x: 1, y: 1, ...a }, { node: 'site:s2', x: 2, y: 2, ...b }];
  const ok = map.result(rows(good), ids, FRAME);
  assert.deepEqual(ok.mosaic, good);
  assert.ok(Object.isFrozen(ok.mosaic));
  assert.deepEqual(Object.keys(ok.mosaic), [...map.MOSAIC_KEYS]);
  // Differing between rows, one column at a time; null on one row only.
  for (const k of map.MOSAIC_KEYS) {
    assert.throws(() => map.result(rows(good, { ...good, [k]: good[k] + 1 }), ids, FRAME), refused('mapPoints', 'query_failed'), `${k} differs`);
    assert.throws(() => map.result(rows(good, { ...good, [k]: null }), ids, FRAME), refused('mapPoints', 'query_failed'), `${k} null on one row`);
    assert.throws(() => map.result(rows({ ...good, [k]: null }), ids, FRAME), refused('mapPoints', 'query_failed'), `${k} alone null`);
    assert.throws(() => map.result(rows({ ...good, [k]: String(good[k]) }), ids, FRAME), refused('mapPoints', 'query_failed'), `${k} as text`);
  }
  // Not covering the frame, off the world, past the zoom cap.
  const bad = [
    { ox: 1 }, { oy: 1 }, { ox: -256 }, { oy: -300 }, { cols: 3 }, { rows: 2 }, { cols: 5 }, { rows: 5 },
    { tx0: -1 }, { ty0: -1 }, { tx0: 2048 - 3 }, { ty0: 2048 - 3 }, { z: 20 }, { z: -1 }, { z: 1.5 },
  ];
  for (const change of bad) {
    assert.throws(() => map.result(rows({ ...good, ...change }), ids, FRAME), refused('mapPoints', 'query_failed'), JSON.stringify(change));
  }
  assert.throws(() => map.result(rows({ ...good, z: 12, tx0: 1206 }), ids, FRAME, 11), refused('mapPoints', 'query_failed'), 'past the profile\'s cap');
  assert.equal(map.result(rows({ ...good, z: 12, tx0: 1206 }), ids, FRAME).mosaic.z, 12, 'within 19');
  // More than 64 tiles: no mosaic, the points still return.
  const huge = { z: 15, tx0: 9000, ty0: 12000, cols: 9, rows: 9, ox: -100, oy: -200 };
  const frame = Object.freeze({ width: 2000, height: 2000, padding: 0 });
  const many = map.result(rows(huge), ids, frame);
  assert.equal(many.mosaic, null);
  assert.equal(many.points.length, 2);
  assert.deepEqual(map.result(rows({ ...huge, cols: 8, rows: 8, ox: 0, oy: 0 }), ids, frame).mosaic, { ...huge, cols: 8, rows: 8, ox: 0, oy: 0 });
});

const MD_PROFILE = () => ({ ...profileWith(), data: { source: 'motherduck', database: 'brightside_fixture' } });

test('MotherDuck: DuckDB text holding coordinates, SQL and the key never reaches the fault', async (t) => {
  const fake = createFakeMotherDuck({
    failOn: (sql) => (sql === travel.COLUMN_TYPES_SQL ? new Error(`Binder Error: 41.123457 -73654321 ${TOKEN} near "SELECT pos_lat_e6 FROM sites"`) : null),
  });
  const data = createData({ profile: MD_PROFILE(), token: TOKEN, connect: fake.create });
  t.after(() => data.close());
  const err = await mapPoints(data, ['site:s1'], FRAME).catch((e) => e);
  refused('mapPoints', 'data_unavailable')(err);
  for (const leak of ['41.123457', '-73654321', TOKEN, 'SELECT', 'pos_lat_e6']) assert.ok(!err.message.includes(leak), leak);
});

test('MotherDuck: the column types are checked there too, and the points query never runs on a text column', async (t) => {
  const fake = createFakeMotherDuck({
    rows: (sql) => (sql === travel.COLUMN_TYPES_SQL ? [
      { table_name: 'sites', column_name: 'pos_lat_e6', data_type: 'INTEGER' },
      { table_name: 'sites', column_name: 'pos_lon_e6', data_type: 'DOUBLE' },
      { table_name: 'vans', column_name: 'home_lat_e6', data_type: 'BIGINT' },
      { table_name: 'vans', column_name: 'home_lon_e6', data_type: 'BIGINT' },
    ] : []),
  });
  const data = createData({ profile: MD_PROFILE(), token: TOKEN, connect: fake.create });
  t.after(() => data.close());
  await assert.rejects(mapPoints(data, ['site:s1'], FRAME), refused('routing.coordinates.nodes[0].lon_column', 'not_coordinate_column'));
  const statements = fake.state.instances.flatMap((i) => i.connections.flatMap((c) => c.statements));
  assert.ok(statements.includes(travel.COLUMN_TYPES_SQL));
  assert.ok(!statements.some((s) => s.includes('$grid_e6')), 'the points query never reached DuckDB');
});

test('MotherDuck: mapPoints shares the 30 s query limit (interrupted at the limit, fixed-text fault)', async (t) => {
  const fake = createFakeMotherDuck({ hangQueries: true });
  const data = createData({ profile: MD_PROFILE(), token: TOKEN, connect: fake.create, queryTimeoutMs: 20 });
  t.after(() => data.close());
  await data.open();
  await assert.rejects(mapPoints(data, ['site:s1'], FRAME), refused('mapPoints', 'data_unavailable'));
  assert.equal(fake.state.instances[0].connections[1].interrupted, 1, 'the shared timer interrupted the query');
});
