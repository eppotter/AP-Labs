'use strict';

// Story 15.2 (AD-R13, data-design §3): mapPoints, the second governed read of
// coordinate columns. It returns only { node, x, y } integer pixels: snapped
// to the routing.map_grid_e6 grid first, then fit to the requested nodes' box
// (widened to routing.map_min_span_km), padded, centred, north up. Real
// DuckDB tests build test/fixtures/routing-data into a temporary file and read
// it with test/fixtures/profiles/routing.yml; the MotherDuck-mode tests use
// the fake instance factory. No client path.

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

// The seeds, read as plain CSV (no quoting in them), for the hand computation.
function seed(table) {
  const [head, ...lines] = fs.readFileSync(path.join(SEEDS, `${table}.csv`), 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}
const POSITIONS = new Map([
  ...seed('sites').filter((r) => r.pos_lat_e6).map((r) => [`site:${r.site_id}`, [Number(r.pos_lat_e6), Number(r.pos_lon_e6)]]),
  ...seed('vans').map((r) => [`van:${r.van_id}`, [Number(r.home_lat_e6), Number(r.home_lon_e6)]]),
]);

// The projection by hand: snap each micro-degree value to the nearest grid
// multiple (half away from zero, as DuckDB's round), then fit the snapped box,
// each side widened to the minimum span, inside the padding at one scale,
// centred, north up, rounded to whole pixels.
const rad = (deg) => (deg * Math.PI) / 180;
const snap = (e6, grid) => {
  const q = e6 / grid;
  return (Math.sign(q) * Math.round(Math.abs(q)) * grid) / 1e6;
};
function byHand(ids, frame, routing) {
  const pts = ids.filter((id) => POSITIONS.has(id)).map((id) => {
    const [lat, lon] = POSITIONS.get(id);
    return { node: id, lat: snap(lat, routing.map_grid_e6), lon: snap(lon, routing.map_grid_e6) };
  });
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const midLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const kmLat = rad(1) * travel.EARTH_RADIUS_KM;
  const kmLon = kmLat * Math.cos(rad(midLat));
  const pxPerKm = Math.min(
    (frame.width - 2 * frame.padding) / Math.max((Math.max(...lons) - Math.min(...lons)) * kmLon, routing.map_min_span_km),
    (frame.height - 2 * frame.padding) / Math.max((Math.max(...lats) - Math.min(...lats)) * kmLat, routing.map_min_span_km),
  );
  return pts.map((p) => ({
    node: p.node,
    x: Math.round(frame.width / 2 + (p.lon - midLon) * kmLon * pxPerKm),
    y: Math.round(frame.height / 2 - (p.lat - midLat) * kmLat * pxPerKm),
  }));
}

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-map-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function builtFile(t) {
  const file = path.join(tmpDir(t), 'route-co.duckdb');
  await build({ fixtureDir: FIXTURE, out: file });
  return file;
}

// The fixture profile, optionally edited (re-validated, so defaults fill).
function profileWith(edit) {
  if (!edit) return loadProfile(PROFILE_FILE);
  const raw = YAML.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
  edit(raw);
  return validateProfile(raw);
}

async function source(t, profile = profileWith()) {
  const data = createData({ file: await builtFile(t), profile });
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

test('returns only node, x, y as integers inside the frame, matching the hand-computed projection, in the order asked', async (t) => {
  const profile = profileWith();
  assert.equal(profile.routing.map_grid_e6, 2000, 'the default grid');
  assert.equal(profile.routing.map_min_span_km, 5, 'the default minimum span');
  const data = await source(t, profile);
  const ids = ['van:v2', 'site:s1', 'site:s3', 'van:v1', 'site:s2'];
  const points = await mapPoints(data, ids, FRAME);
  assert.deepEqual(points, byHand(ids, FRAME, profile.routing));
  assert.deepEqual(points.map((p) => p.node), ids);
  for (const p of points) {
    assert.deepEqual(Object.keys(p), ['node', 'x', 'y']);
    assert.ok(Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y));
    assert.ok(p.x >= FRAME.padding && p.x <= FRAME.width - FRAME.padding, `x ${p.x} inside the padding`);
    assert.ok(p.y >= FRAME.padding && p.y <= FRAME.height - FRAME.padding, `y ${p.y} inside the padding`);
    assert.ok(Object.isFrozen(p));
  }
  // Pinned by hand once, so the test and the SQL cannot drift together.
  assert.deepEqual(points.map(({ x, y }) => [x, y]), [[676, 20], [404, 316], [124, 580], [322, 373], [503, 166]]);
  // North up: the northernmost place has the smallest y; east is right.
  assert.equal(points.find((p) => p.node === 'van:v2').y, 20, 'v2, the northernmost, touches the top padding');
  assert.equal(points.find((p) => p.node === 'site:s3').y, 580, 's3, the southernmost, touches the bottom padding');
  assert.ok(points.find((p) => p.node === 'van:v2').x > points.find((p) => p.node === 'site:s3').x, 'east is right');
});

test('coordinates are snapped to the grid first: two places in one grid cell get the same pixel', async (t) => {
  // At a 0.2° grid, s1 and s2 fall in one cell; s3 does not.
  const profile = profileWith((p) => { p.routing.map_grid_e6 = 200000; });
  const data = await source(t, profile);
  const points = await mapPoints(data, ['site:s1', 'site:s2', 'site:s3'], FRAME);
  assert.deepEqual(points, byHand(['site:s1', 'site:s2', 'site:s3'], FRAME, profile.routing));
  const [s1, s2, s3] = points;
  assert.deepEqual([s1.x, s1.y], [s2.x, s2.y], 's1 and s2 share a marker');
  assert.notDeepEqual([s1.x, s1.y], [s3.x, s3.y]);
  // At the default grid they are apart.
  const fine = await mapPoints(await source(t), ['site:s1', 'site:s2'], FRAME);
  assert.notDeepEqual([fine[0].x, fine[0].y], [fine[1].x, fine[1].y]);
});

test('a box smaller than the minimum span is widened: one node, or a one-cell cluster, sits at the centre', async (t) => {
  const data = await source(t);
  assert.deepEqual(await mapPoints(data, ['site:s1'], FRAME), [{ node: 'site:s1', x: 400, y: 300 }]);
  const coarse = await source(t, profileWith((p) => { p.routing.map_grid_e6 = 200000; }));
  assert.deepEqual(await mapPoints(coarse, ['site:s1', 'site:s2'], FRAME), [
    { node: 'site:s1', x: 400, y: 300 }, { node: 'site:s2', x: 400, y: 300 },
  ]);
  // s1 and v1 are about 2.7 km apart north-south and 3.9 km east-west: both
  // sides widen to 5 km, so the scale is the smaller of 760/5 and 560/5.
  const profile = profileWith();
  const pair = await mapPoints(data, ['site:s1', 'van:v1'], FRAME);
  assert.deepEqual(pair, byHand(['site:s1', 'van:v1'], FRAME, profile.routing));
  assert.deepEqual(pair.map(({ x, y }) => [x, y]), [[616, 151], [184, 449]]);
  const pxPerKm = 560 / 5;
  const kmEastWest = (pair[0].x - pair[1].x) / pxPerKm;
  assert.ok(kmEastWest > 3.8 && kmEastWest < 3.9, `${kmEastWest} km east-west at the 5 km scale`);
  // A wider floor zooms out further around the same centre.
  const wide = await mapPoints(await source(t, profileWith((p) => { p.routing.map_min_span_km = 50; })), ['site:s1', 'van:v1'], FRAME);
  assert.ok(Math.abs(wide[0].x - 400) < Math.abs(pair[0].x - 400) / 5);
});

test('the frame fits only the nodes asked for: other nodes never widen it', async (t) => {
  const data = await source(t);
  const some = await mapPoints(data, ['site:s1', 'site:s2'], FRAME);
  const all = await mapPoints(data, ALL, FRAME);
  assert.notDeepEqual(some, all.filter((p) => p.node === 'site:s1' || p.node === 'site:s2'));
  assert.deepEqual(some, byHand(['site:s1', 'site:s2'], FRAME, profileWith().routing));
});

test('an unknown node id, or a node whose coordinate is null, is left out and the rest return (F16)', async (t) => {
  const data = await source(t);
  const points = await mapPoints(data, ['site:zz', 'site:s1', 'site:s4', 'van:s1'], FRAME);
  assert.deepEqual(points, [{ node: 'site:s1', x: 400, y: 300 }]);
  assert.deepEqual(await mapPoints(data, ['site:s4', 'site:zz'], FRAME), []);
});

test('an empty list is an empty result, read from nothing', async (t) => {
  const data = offline(t);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  assert.deepEqual(await mapPoints(data, [], FRAME), []);
  assert.equal(checks.mock.callCount(), 0);
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
    [{ width: 800, height: 600, padding: 20, zoom: 4 }, 'frame.zoom', 'out_of_range'],
  ];
  for (const [frame, field, problem] of cases) {
    await assert.rejects(mapPoints(data, ['site:s1'], frame), refused(field, problem), JSON.stringify(frame));
  }
  assert.equal(checks.mock.callCount(), 0, 'nothing reached the guard or DuckDB');
  // The bounds themselves are allowed (and then fail only for want of the file).
  for (const frame of [{ width: 200, height: 200, padding: 0 }, { width: 2000, height: 2000, padding: 200 }, { width: 201, height: 201, padding: 100 }]) {
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
  await mapPoints(data, ['van:v2', 'site:s3'], { width: 1234, height: 987, padding: 56 });
  const sqls = checks.mock.calls.map((c) => c.arguments[0]);
  assert.equal(sqls.length, 4, 'the column-type query and the points query, twice');
  assert.equal(sqls[0], travel.COLUMN_TYPES_SQL);
  assert.equal(sqls[1], sqls[3], 'one static template');
  for (const sql of sqls) {
    const text = sql.replace(/\$\w+/g, '');
    assert.ok(!/s1|s2|s3|v1|v2|1234|987|56/.test(text), 'no id or frame number in the text');
  }
  assert.match(sqls[1], /^SELECT s\.node AS node,$/m);
  assert.match(sqls[1], /AS INTEGER\) AS x,$/m);
  assert.match(sqls[1], /AS INTEGER\) AS y$/m);
  assert.deepEqual([...sqls[1].matchAll(/\$(\w+)/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort(), [...map.POINTS_PARAMS].sort());
  const read = new Set([...sqls[1].matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/g)].map((m) => m[1]));
  assert.deepEqual([...read].sort(), ['b', 'f', 'nodes', 's', 'sites', 'vans'], 'only the declared tables and its own steps');
});

test('the Earth radius is travelMatrix\'s (6371.0088 km), and the grid snap comes before the box', () => {
  assert.equal(travel.EARTH_RADIUS_KM, 6371.0088);
  const sql = map.pointsSql(profileWith().routing);
  assert.equal(sql.split('6371.0088').length - 1, 2, 'both km-per-degree factors use it');
  assert.ok(sql.indexOf('$grid_e6') < sql.indexOf('min(lat)'), 'snapped before the box is taken');
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
  assert.deepEqual(map.points([{ node: 'site:s2', x: 0, y: 600 }], ids, FRAME), [{ node: 'site:s2', x: 0, y: 600 }]);
  assert.throws(() => map.points([{ node: 'site:s9', x: 1, y: 1 }], ids, FRAME), refused('mapPoints', 'query_failed'));
  assert.throws(() => map.points([{ node: 'site:s1', x: 1, y: 1 }, { node: 'site:s1', x: 2, y: 2 }], ids, FRAME), refused('mapPoints', 'duplicate'));
  for (const [x, y] of [[-1, 1], [801, 1], [1, -1], [1, 601], [1.5, 1], ['1', 1], [null, 1]]) {
    assert.throws(() => map.points([{ node: 'site:s1', x, y }], ids, FRAME), refused('mapPoints', 'query_failed'), `${x},${y}`);
  }
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
