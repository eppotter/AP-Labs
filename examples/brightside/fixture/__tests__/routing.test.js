'use strict';

// Story 14.1: the fixture gains synthetic coordinates and a booked schedule
// after as_of (generator v4). Story 15.7: the coordinates move to a box in
// Columbus, Ohio (generator v5); only the box's centre and bounds change, so
// every draw and every non-routing value stays as v4 had it. Fix to 15.7: no
// point on water (generator v6, lib/water.js). Example tests (AD-1
// carve-out): they read Brightside's own fixture and go with it in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { generate, readSeedConfig, storedName, GENERATOR_VERSION } = require('../generate');
const { checkRouting } = require('../lib/routing-rules');
const routing = require('../lib/routing');
const { S2 } = require('../lib/scenarios');
const { ZONES, AS_OF } = require('../lib/reference');
const { EARLIEST_START, DAY_START, AIM_TO_FINISH, LATEST_FINISH, SLOT_MINUTES } = require('../lib/operations');
const { loadProfile } = require('../../../../kit/lib/profile');
const { loadChecks } = require('../../../../kit/fixture/validate');
const { build, readRows } = require('../../../../kit/fixture/build');

const FIXTURE_DIR = path.join(__dirname, '..');
const REPO = path.resolve(FIXTURE_DIR, '..', '..', '..');
const PROFILE = loadProfile(path.join(REPO, 'profiles', 'brightside', 'profile.yml'));
const SMALL = { seed: 7, clients: 60 };
const COORDINATE_COLUMNS = ['properties.geo_lat_e6', 'properties.geo_lon_e6', 'crews.base_geo_lat_e6', 'crews.base_geo_lon_e6'];

// Each v3 seed's header and the sha256 of its whole v3 content, recorded from
// the committed v3 files before the v4 generator ran. Every v3 column must
// keep every value byte for byte: the v4 seed, cut back to the v3 columns,
// must hash the same.
const V3_SEEDS = {
  add_ons: ['add_on_id,name,price_cents', '1d24020a1595ce14b2642c3abec3bdddbb70f9657761dfc1f326260158fe46c4'],
  clients: ['client_id,zone_id,first_name,last_name,email,phone,created_on', '30d2b1b7d8ed478d254a3127c585f1f5d213fd98ec96c27359c427f52f929a6a'],
  crew_memberships: ['membership_id,crew_id,staff_name,start_date,end_date,staff_id', '646d62cec8592b5a550e7ee514916f2bbdc283652f82b4833e25b50124441cb0'],
  crews: ['crew_id,zone_id,name', '252667cf26c52d0661266b6c2a1b198eb691b1c31649c1395620f6439fb3dbfb'],
  invoice_lines: ['line_id,invoice_id,package_id,add_on_id,quantity,amount_cents', '27f9ce59a1b099e97ada39d371e2820afe8c96db460bc17c40a529a7514c7fe9'],
  invoices: ['invoice_id,client_id,visit_id,issued_on,due_on,total_cents', '21c2ec5851729994e2e71548ab071367dabd2af022818dce541c20c917af8cd0'],
  packages: ['package_id,name,base_price_cents', 'f7e783b29c23c44d8a8cfcd16bee06f017bf5a33eee13216b653531f8a00ebcc'],
  pay_rates: ['rate_id,staff_id,start_date,end_date,role,hourly_rate_cents', 'a3b504c7002532a890dccd2aa4d133c8feb3b9f5c361146d07f740b4bfb089fd'],
  payments: ['payment_id,invoice_id,paid_on,amount_cents,method', '6577c8d32ba971d40b3614e5f339fdd229d4c36bef73c45d85292d47eddc51c4'],
  plan_price_changes: ['change_id,plan_id,effective_date,old_price_cents,new_price_cents', '3d7570e7980df40bc8f719163d6b4016bcfa5a04bbcda273480ce165028d77be'],
  plans: ['plan_id,property_id,package_id,frequency,start_date,end_date,status,start_price_cents,price_cents', '6bdfefd9755cf02630df3c4650017120d9da17f614696e46a971fedc50728798'],
  properties: ['property_id,client_id,street_address,city,postal_code,home_type,square_feet,bedrooms,bathrooms,has_pets,access_method', 'a839ecbb121b6220f5346e38fc9d2b7ce42632e2ea81365a1d3500bf0799ecef'],
  staff: ['staff_id,name,role,hire_date,end_date,hourly_rate_cents', 'd2db07cdbbf57664c03e0a0d7bf2723d576ec236bb291d8fda50ce19efc3f629'],
  timesheets: ['timesheet_id,visit_id,staff_id,clock_in,clock_out,minutes', '7bab81055390ef83244227cb154fbfe2c1b3753be4e42e41a4e8dd48a356e10b'],
  visits: ['visit_id,property_id,plan_id,crew_id,package_id,visit_date,status,arrival_window,scheduled_start,scheduled_minutes,route_order,travel_minutes_from_previous', '72d93a37df05ac155aaef94f2f0b557e781d78e64303e6d8e809ab4bb1e1e7b3'],
  zones: ['zone_id,name', '7603749c0cc3aa3c898a4004174c1ae25037100c1c1902320a8f3934bd4ac570'],
};
// v3's fixture_meta, every key but generator_version (3 then).
const V3_META = {
  as_of: '2026-09-30', history_start: '2024-10-01', seed: '20241001',
  rows_add_ons: '5', rows_clients: '2000', rows_crew_memberships: '108', rows_crews: '15', rows_invoice_lines: '47133',
  rows_invoices: '38434', rows_packages: '3', rows_pay_rates: '287', rows_payments: '39680', rows_plan_price_changes: '1013',
  rows_plans: '1584', rows_properties: '2186', rows_staff: '89', rows_timesheets: '115302', rows_visits: '40895', rows_zones: '5',
};

// Story 15.7 (generator v5): v4's routing tables, each cut back to every
// column but the ones a drive time decides, and the sha256 of that cut,
// recorded from the committed v4 files before the v5 generator ran. Only the
// four coordinate columns and scheduled_visits' scheduled_start and
// travel_minutes_from_previous may move from v4; every other value of every
// table stays byte for byte (V3_SEEDS holds the rest of v4's columns).
const V4_MOVED = {
  properties: ['geo_lat_e6', 'geo_lon_e6'],
  crews: ['base_geo_lat_e6', 'base_geo_lon_e6'],
  scheduled_visits: ['scheduled_start', 'travel_minutes_from_previous'],
};
const V4_SEEDS = {
  scheduled_visits: ['scheduled_visit_id,property_id,plan_id,crew_id,package_id,visit_date,status,status_changed_on,arrival_window,scheduled_minutes,labour_minutes,route_order', '5d9645abc1e5fc34d72ce6ead94b2d73df09f75cdc6c4132b357e8a2b3190495'],
  service_rules: ['rule_id,property_id,rule_type,value,strength', 'e5a77a1bcfb46ef342003e97e4c1ce1d0cd33db1c887d4cb47090036ea6d57cc'],
  staff_absences: ['absence_id,staff_id,absence_date,reported_on', '55fadd7fe56e73d2752eac529b0ae7526b16d4e40161d74fd572e3590060317c'],
};
// v4's fixture_meta keys v3 did not have: the routing tables' counts are v4's.
const V4_META = { rows_scheduled_visits: '1720', rows_service_rules: '781', rows_staff_absences: '5', schedule_horizon_end: '2026-10-28' };

// Fix to Story 15.7 (generator v6, points off water): v5's routing tables cut
// back the same way, recorded from the committed v5 files before the v6
// generator ran. A redrawn point and three moved cities change drive times
// and starts, and so 8 booked arrival windows and the time_of_day rules drawn
// from them; every other value stays v5's. service_rules is pinned without
// rule_id (a dropped rule renumbers the rest) and without its time_of_day rows.
const V5_MOVED = {
  properties: ['geo_lat_e6', 'geo_lon_e6'],
  crews: ['base_geo_lat_e6', 'base_geo_lon_e6'],
  scheduled_visits: ['arrival_window', 'scheduled_start', 'travel_minutes_from_previous'],
  service_rules: ['rule_id'],
};
const V5_SEEDS = {
  scheduled_visits: ['scheduled_visit_id,property_id,plan_id,crew_id,package_id,visit_date,status,status_changed_on,scheduled_minutes,labour_minutes,route_order', '099a6929f48f14f868971fe70748ac340490eca186463568ef3ff6d53fafa9d6'],
  service_rules: ['property_id,rule_type,value,strength', 'c4efbeea14de7f7dfd3835a675d3dacd09ef623808f68cabae181855006d682c'],
  staff_absences: ['absence_id,staff_id,absence_date,reported_on', '55fadd7fe56e73d2752eac529b0ae7526b16d4e40161d74fd572e3590060317c'],
};
// v6's routing counts: one time_of_day rule fell away with its window.
const V6_META = { rows_scheduled_visits: '1720', rows_service_rules: '780', rows_staff_absences: '5', schedule_horizon_end: '2026-10-28' };

const seedText = (table) => {
  const file = path.join(FIXTURE_DIR, storedName(`seeds/${table}.csv`));
  return file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
};

// A committed seed cut back to the given columns, as CSV text. The seeds
// never quote (generate.test.js), so a plain split is a full parse.
function project(text, columns) {
  const [header, ...lines] = text.slice(0, -1).split('\n');
  const index = columns.map((c) => header.split(',').indexOf(c));
  assert.ok(index.every((i) => i >= 0), `columns ${columns.join(',')} in ${header}`);
  return `${[columns.join(','), ...lines.map((l) => { const cells = l.split(','); return index.map((i) => cells[i]).join(','); })].join('\n')}\n`;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

let recorded;
const recordedRun = () => (recorded ??= generate(readSeedConfig()));
const recordedTables = () => recordedRun().tables;

test('generator v6: seed.json and fixture_meta record it, and fixture_meta has the horizon and the new table\'s count', () => {
  assert.equal(GENERATOR_VERSION, 6);
  assert.equal(readSeedConfig().generator_version, 6);
  const meta = Object.fromEntries(recordedTables().fixture_meta.map((m) => [m.key, m.value]));
  assert.equal(meta.generator_version, '6');
  assert.equal(meta.schedule_horizon_end, '2026-10-28', 'as_of + 28 days');
  assert.equal(meta.rows_scheduled_visits, String(recordedTables().scheduled_visits.length));
});

test('every v3 column of every v3 seed is unchanged byte for byte', () => {
  for (const [table, [header, digest]] of Object.entries(V3_SEEDS)) {
    assert.equal(sha256(project(seedText(table), header.split(','))), digest, `${table}: a v3 column changed`);
  }
  const meta = Object.fromEntries(seedText('fixture_meta').trim().split('\n').slice(1).map((l) => l.split(',')));
  for (const [key, value] of Object.entries(V3_META)) assert.equal(meta[key], value, `fixture_meta ${key}`);
});

// v6 replaced the v5 test that pinned v4's routing values: v6 moves arrival
// windows and time_of_day rules on purpose (see V5_SEEDS). V4_SEEDS and
// V4_META stay as the record of v4.
test('v6 keeps every v5 value but the coordinates, the booked drives, starts and windows and the time_of_day rules', () => {
  assert.ok(V4_SEEDS && V4_META && V4_MOVED, 'v4\'s record is kept');
  const untimed = (text) => text.split('\n').filter((l) => !l.includes(',time_of_day,')).join('\n');
  for (const [table, [header, digest]] of Object.entries(V5_SEEDS)) {
    const cut = project(seedText(table), header.split(','));
    assert.equal(sha256(table === 'service_rules' ? untimed(cut) : cut), digest, `${table}: a v5 value changed`);
  }
  // The columns left out of the pins are exactly the moved ones.
  for (const [table, moved] of Object.entries(V5_MOVED)) {
    const pinned = (V5_SEEDS[table] || V3_SEEDS[table])[0].split(',');
    const columns = seedText(table).split('\n')[0].split(',');
    assert.deepEqual(columns.filter((c) => !pinned.includes(c)), moved, `${table}: only the moved columns are unpinned`);
  }
  for (const table of [...Object.keys(V3_SEEDS), ...Object.keys(V5_SEEDS)].filter((t) => !V5_MOVED[t])) {
    assert.equal(seedText(table).split('\n')[0], (V5_SEEDS[table] || V3_SEEDS[table])[0], `${table}: every column is pinned`);
  }
  const meta = Object.fromEntries(seedText('fixture_meta').trim().split('\n').slice(1).map((l) => l.split(',')));
  for (const [key, value] of Object.entries(V6_META)) assert.equal(meta[key], value, `fixture_meta ${key}`);
});

test('only the routing columns and table are new', () => {
  const { tables } = generate(SMALL);
  assert.deepEqual(Object.keys(tables.crews[0]).slice(-2), ['base_geo_lat_e6', 'base_geo_lon_e6']);
  assert.deepEqual(Object.keys(tables.properties[0]).slice(-2), ['geo_lat_e6', 'geo_lon_e6']);
  for (const table of Object.keys(V3_SEEDS)) assert.ok(seedText(table).startsWith(V3_SEEDS[table][0]), `${table} keeps its v3 columns first`);
});

test('generating twice gives identical files, for the recorded seed too', () => {
  const a = generate(readSeedConfig()).files;
  const b = generate(readSeedConfig()).files;
  assert.deepEqual([...a.keys()], [...b.keys()]);
  for (const [rel, content] of a) assert.ok(content === b.get(rel), rel);
  assert.ok(a.has('seeds/scheduled_visits.csv'));
});

test('the generator\'s drive constants are the profile\'s and travelMatrix\'s', () => {
  assert.equal(routing.SPEED_KMH, PROFILE.routing.speed_kmh);
  assert.equal(routing.SPEED_KMH, 40);
  assert.equal(routing.DETOUR_FACTOR, PROFILE.routing.detour_factor);
  assert.equal(routing.DETOUR_FACTOR, 1.3);
  assert.equal(routing.MIN_TRAVEL_MINUTES, PROFILE.routing.min_travel_minutes);
  assert.equal(routing.EARTH_RADIUS_KM, 6371.0088);
  assert.deepEqual(PROFILE.routing.limits, {
    earliest_start: EARLIEST_START, default_start: DAY_START, aim_finish: AIM_TO_FINISH, latest_finish: LATEST_FINISH, slot_minutes: SLOT_MINUTES,
  });
});

test('the profile\'s node kinds are property and crew only, on the columns the generator writes, all four forbidden', () => {
  const nodes = PROFILE.routing.coordinates.nodes;
  assert.deepEqual(nodes.map((n) => n.kind), ['property', 'crew']);
  const tables = generate(SMALL).tables;
  for (const n of nodes) {
    const row = tables[n.table][0];
    for (const col of [n.id_column, n.lat_column, n.lon_column]) assert.ok(Number.isSafeInteger(row[col]), `${n.table}.${col}`);
  }
  const declared = nodes.flatMap((n) => [`${n.table}.${n.lat_column}`, `${n.table}.${n.lon_column}`]);
  assert.deepEqual(declared, COORDINATE_COLUMNS);
  for (const c of COORDINATE_COLUMNS) assert.ok(PROFILE.sql.forbidden_columns.includes(c), `${c} is forbidden`);
});

test('synthetic-coordinates declares exactly the four coordinate columns in its protected-columns header, and no other check names one', () => {
  const checks = loadChecks(FIXTURE_DIR);
  const coords = checks.find((c) => c.id === 'synthetic-coordinates');
  assert.deepEqual(coords.protectedColumns.slice().sort(), COORDINATE_COLUMNS.slice().sort());
  // Story 15.7: its header says where the points come from, and it checks lib/routing.js BOX.
  assert.equal(coords.description, 'Synthetic only: random points in a real metro, never taken from an address.');
  const { BOX } = routing;
  assert.equal(coords.sql.split(`NOT BETWEEN ${BOX.latMin} AND ${BOX.latMax}`).length - 1, 2, 'both latitudes against BOX');
  assert.equal(coords.sql.split(`NOT BETWEEN ${BOX.lonMin} AND ${BOX.lonMax}`).length - 1, 2, 'both longitudes against BOX');
  assert.equal((coords.sql.match(/NOT BETWEEN/g) || []).length, 4);
  // Fix to 15.7: synthetic-off-water reads them too, under the same header (water.test.js).
  for (const c of checks.filter((x) => x.id !== 'synthetic-coordinates' && x.id !== 'synthetic-off-water')) {
    assert.doesNotMatch(c.sql, /geo_l(at|on)_e6/, `${c.id} reads no coordinate`);
  }
  for (const id of ['integrity-scheduled-route-order', 'integrity-scheduled-schedule', 'integrity-scheduled-after-as-of', 'integrity-scheduled-cadence']) {
    assert.ok(checks.some((c) => c.id === id), id);
  }
});

test('every coordinate is a whole micro-degree inside the Columbus box; v6 moved only three city centres off water', () => {
  const { BOX } = routing;
  // Random points in Columbus, Ohio, round numbers, never taken from an address.
  assert.deepEqual(routing.CENTRE, { lat: 40000000, lon: -83000000 });
  assert.deepEqual(BOX, { latMin: 39700000, latMax: 40300000, lonMin: -83400000, lonMax: -82600000 });
  // Every other coordinate constant is v4's but three city centres, which v6
  // moved off water; no constant takes part in a draw, so every draw is v4's.
  assert.equal(routing.LAT_E6_PER_KM, 8993);
  assert.equal(routing.LON_E6_PER_KM, 11740);
  assert.equal(routing.JITTER_KM, 2.5);
  assert.deepEqual(routing.BASE_OFFSET_KM, [[-1, -1.5], [0, -1.5], [1, -1.5]]);
  assert.deepEqual(routing.CITY_KM, {
    Centerpoint: [0, 0], Midtown: [4, 3], Oldmarket: [-0.5, 6],
    Fernhill: [-5, 16], Northvale: [0, 18.5], Pinecrest: [6, 15],
    Clayfield: [-6, -15], Riverbend: [4, -20], Southmere: [5, -14],
    Eastbrook: [15, -4], Harborview: [21, 2], Sunridge: [15, 5],
    Stonegate: [-15, 4], Westfall: [-21, -1], Willowmere: [-14, -5],
  });
  const t = recordedTables();
  const points = t.properties.map((p) => [p.geo_lat_e6, p.geo_lon_e6]).concat(t.crews.map((c) => [c.base_geo_lat_e6, c.base_geo_lon_e6]));
  for (const [lat, lon] of points) {
    assert.ok(Number.isSafeInteger(lat) && lat >= BOX.latMin && lat <= BOX.latMax, String(lat));
    assert.ok(Number.isSafeInteger(lon) && lon >= BOX.lonMin && lon <= BOX.lonMax, String(lon));
  }
  // Crew bases take no draws: the same for every seed.
  const small = generate(SMALL).tables.crews.map((c) => [c.base_geo_lat_e6, c.base_geo_lon_e6]);
  assert.deepEqual(small, t.crews.map((c) => [c.base_geo_lat_e6, c.base_geo_lon_e6]));
});

test('drives between a zone\'s city centres are 10 to 35 minutes; booked drives inside one city 5 to 15, but to S2\'s estate', () => {
  const at = (city) => ({ lat: 40000000 + Math.round(routing.CITY_KM[city][1] * 8993), lon: -83000000 + Math.round(routing.CITY_KM[city][0] * 11740) });
  for (const zone of ZONES) {
    for (const a of zone.cities) {
      for (const b of zone.cities) {
        if (a === b) continue;
        const m = routing.travelMinutes(at(a), at(b));
        assert.ok(m >= 10 && m <= 35, `${a} to ${b}: ${m}`);
      }
    }
  }
  const t = recordedTables();
  const city = new Map(t.properties.map((p) => [p.property_id, p.city]));
  // S2's planted estate sits over 5 km off Pinecrest's homes (lib/scenarios.js).
  const estate = new Set(Object.keys(S2.estate).map(Number));
  const route = new Map(t.scheduled_visits.map((v) => [`${v.crew_id}|${v.visit_date}|${v.route_order}`, v]));
  for (const v of t.scheduled_visits) {
    const prev = route.get(`${v.crew_id}|${v.visit_date}|${v.route_order - 1}`);
    if (prev && city.get(prev.property_id) === city.get(v.property_id) && estate.has(prev.property_id) === estate.has(v.property_id)) {
      assert.ok(v.travel_minutes_from_previous >= 5 && v.travel_minutes_from_previous <= 15, `${v.scheduled_visit_id}: ${v.travel_minutes_from_previous}`);
    }
  }
});

test('every booked drive equals travelMatrix\'s formula run in DuckDB on the built fixture', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brightside-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'brightside.duckdb');
  await build({ fixtureDir: FIXTURE_DIR, out });
  const { speed_kmh: speed, detour_factor: detour, min_travel_minutes: min } = PROFILE.routing;
  for (const n of [speed, detour, min]) assert.ok(Number.isFinite(n));
  // Each booked leg's two places (the crew's base before route stop 1), then
  // kit/runtime/data travelMatrix's distance and minutes expressions (Story
  // 13.2) with the profile's numbers.
  const rows = await readRows(out, [
    'WITH legs AS (',
    '  SELECT s.scheduled_visit_id AS id, s.travel_minutes_from_previous AS booked,',
    '    COALESCE(LAG(p.geo_lat_e6) OVER w, c.base_geo_lat_e6) AS f_lat, COALESCE(LAG(p.geo_lon_e6) OVER w, c.base_geo_lon_e6) AS f_lon,',
    '    p.geo_lat_e6 AS t_lat, p.geo_lon_e6 AS t_lon',
    '  FROM scheduled_visits s JOIN properties p ON p.property_id = s.property_id JOIN crews c ON c.crew_id = s.crew_id',
    '  WINDOW w AS (PARTITION BY s.crew_id, s.visit_date ORDER BY s.route_order)),',
    'pts AS (SELECT id, booked, CAST(f_lat AS DOUBLE) / 1e6 AS flat, CAST(f_lon AS DOUBLE) / 1e6 AS flon,',
    '  CAST(t_lat AS DOUBLE) / 1e6 AS tlat, CAST(t_lon AS DOUBLE) / 1e6 AS tlon FROM legs),',
    'd AS (SELECT id, booked,',
    `  2 * ${routing.EARTH_RADIUS_KM} * asin(least(1.0, sqrt(`,
    '    power(sin(radians(tlat - flat) / 2), 2)',
    '    + cos(radians(flat)) * cos(radians(tlat)) * power(sin(radians(tlon - flon) / 2), 2)',
    '  ))) AS km FROM pts)',
    `SELECT id, booked, CAST(greatest(${min}, ceil(round(km * ${detour} / ${speed} * 60, 6))) AS INTEGER) AS minutes`,
    'FROM d ORDER BY id',
  ].join('\n'));
  assert.equal(rows.length, recordedTables().scheduled_visits.length);
  assert.deepEqual(rows.filter((r) => r.minutes !== r.booked), []);
});

test('the booked schedule: active plans only, after as_of through the horizon, times inside 06:00 to 23:00', () => {
  const t = recordedTables();
  const plans = new Map(t.plans.map((p) => [p.plan_id, p]));
  const sv = t.scheduled_visits;
  assert.ok(sv.length > 1000, `about 1,700 booked visits, got ${sv.length}`);
  for (const v of sv) {
    assert.equal(plans.get(v.plan_id).end_date, null, `plan ${v.plan_id} is active`);
    assert.ok(v.visit_date > AS_OF && v.visit_date <= '2026-10-28', v.visit_date);
  }
  const cancelled = sv.filter((v) => v.status === 'cancelled');
  assert.ok(cancelled.length > 0 && cancelled.length < sv.length / 20, 'a few booked visits are already called off');
  for (const v of cancelled) assert.ok(v.status_changed_on <= AS_OF && v.status_changed_on >= '2026-09-24', v.status_changed_on);
  // Every active plan whose cadence falls in the horizon is booked.
  const bookedPlans = new Set(sv.map((v) => v.plan_id));
  const weekly = t.plans.filter((p) => p.end_date === null && p.frequency !== 'monthly');
  assert.ok(weekly.every((p) => bookedPlans.has(p.plan_id)), 'every weekly and biweekly active plan is booked');
  // scheduled_minutes is labour over the crew's headcount, to 15, at least 30,
  // on a day that was not squeezed.
  const heads = new Map();
  for (const m of t.crew_memberships) if (m.end_date === null) heads.set(m.crew_id, (heads.get(m.crew_id) || 0) + 1);
  const unsqueezed = sv.filter((v) => v.scheduled_minutes === Math.max(30, Math.round(v.labour_minutes / heads.get(v.crew_id) / 15) * 15));
  assert.ok(unsqueezed.length > sv.length * 0.95, `${unsqueezed.length} of ${sv.length}`);
  // The planted scenarios moved seven visits to another crew of their zone.
  const { reassigned } = recordedRun();
  assert.deepEqual(reassigned, [27, 79, 80, 100, 172, 184, 191]);
  assert.deepEqual(checkRouting(t, { asOf: AS_OF, reassigned: new Set(reassigned) }), []);
  assert.ok(checkRouting(t, { asOf: AS_OF }).every((p) => /not plan \d+'s crew/.test(p)), 'without the planted list, only those seven fail');
  assert.equal(checkRouting(t, { asOf: AS_OF }).length, 7);
});

test('the routing rules catch each broken rule', () => {
  const { tables } = generate(SMALL);
  assert.deepEqual(checkRouting(tables, { asOf: AS_OF }), []);
  const first = (t) => t.scheduled_visits.find((v) => v.route_order === 1);
  const cases = [
    [(t) => { t.properties[0].geo_lat_e6 = -1000000; }, /properties 1: coordinates outside the synthetic box/],
    [(t) => { t.crews[0].base_geo_lon_e6 = 0; }, /crews 1: base coordinates outside/],
    // Fix to 15.7: a point on water, as is or only once snapped to the map grid.
    [(t) => { Object.assign(t.properties[0], { geo_lat_e6: 40200000, geo_lon_e6: -82970000 }); }, /properties 1: coordinates on water \(Alum Creek Reservoir\)/],
    [(t) => { Object.assign(t.crews[0], { base_geo_lat_e6: 40120000, base_geo_lon_e6: -82880000 }); }, /crews 1: base coordinates on water \(Hoover Reservoir\)/],
    [(t) => { first(t).travel_minutes_from_previous += 1; }, /travel is not travelMatrix's figure/],
    [(t) => { first(t).route_order = 9; }, /route_order is not 1 to/],
    [(t) => { const v = first(t); v.arrival_window = v.arrival_window === 'morning' ? 'afternoon' : 'morning'; }, /arrival_window .* disagrees/],
    [(t) => { first(t).scheduled_start = '06:00:00'; }, /starts before the crew can get there/],
    [(t) => { const v = t.scheduled_visits.at(-1); v.scheduled_minutes = 1500; }, /ends after 23:00/],
    [(t) => { first(t).scheduled_minutes = 20; }, /scheduled_minutes 20 is not a whole number/],
    [(t) => { first(t).labour_minutes = 0; }, /labour_minutes 0 is not a positive/],
    [(t) => { first(t).status = 'done'; }, /status done is not scheduled or cancelled/],
    [(t) => { first(t).status_changed_on = '2026-10-01'; }, /status_changed_on 2026-10-01 is after as_of/],
    [(t) => { const v = first(t); const plan = t.plans.find((p) => p.plan_id === v.plan_id); plan.end_date = AS_OF; }, /ended 2026-09-30 but has booked visits/],
    [(t) => { const v = first(t); v.package_id = v.package_id === 'deep' ? 'standard' : 'deep'; }, /not plan \d+'s property and package/],
    [(t) => { const v = first(t); v.crew_id = v.crew_id === 1 ? 2 : 1; }, /not plan \d+'s crew/],
    [(t) => { t.scheduled_visits.find((v) => v.visit_date > '2026-10-01').visit_date = '2026-09-30'; }, /visit_date 2026-09-30 is outside/],
    // Story 14.2: service_rules and staff_absences.
    [(t) => { t.service_rules[0].rule_type = 'favourite_colour'; }, /rule_type favourite_colour is not/],
    [(t) => { t.service_rules.find((r) => r.rule_type === 'day_of_week').strength = 'soft'; }, /day_of_week is hard, not soft/],
    [(t) => { t.service_rules.find((r) => r.rule_type === 'preferred_crew').value = '99'; }, /preferred_crew 99 is not a crew/],
    [(t) => { const r = t.service_rules.find((x) => x.rule_type === 'preferred_crew'); r.value = r.value === '1' ? '15' : '1'; }, /is not in the property's zone|is not on preferred crew/],
    [(t) => { t.service_rules.find((r) => r.rule_type === 'day_of_week').value = 'SUN|MON'; }, /day_of_week SUN\|MON is not ISO day names in week order|is not on SUN\|MON/],
    [(t) => { t.service_rules.find((r) => r.rule_type === 'day_of_week').value = 'MON,TUE'; }, /day_of_week MON,TUE is not ISO day names in week order/],
    [(t) => { const r = t.service_rules.find((x) => x.rule_type === 'time_of_day'); r.value = r.value === 'morning' ? 'afternoon' : 'morning'; }, /is booked in the (morning|afternoon), not the/],
    [(t) => { t.service_rules.find((r) => r.rule_type === 'time_of_day').value = 'evening'; }, /time_of_day evening is not morning or afternoon/],
    [(t) => { t.staff_absences.push({ absence_id: 999, staff_id: t.crew_memberships.find((m) => m.end_date === null).staff_id, absence_date: '2026-10-29', reported_on: AS_OF }); }, /staff_absences 999: absence_date 2026-10-29 is outside/],
    [(t) => { t.staff_absences.push({ absence_id: 999, staff_id: t.crew_memberships.find((m) => m.end_date === null).staff_id, absence_date: '2026-10-20', reported_on: '2026-10-01' }); }, /staff_absences 999: reported_on 2026-10-01 is after as_of/],
    [(t) => {
      const open = new Set(t.crew_memberships.filter((m) => m.end_date === null).map((m) => m.staff_id));
      t.staff_absences.push({ absence_id: 999, staff_id: t.staff.find((x) => !open.has(x.staff_id)).staff_id, absence_date: '2026-10-20', reported_on: AS_OF });
    }, /staff_absences 999: staff \d+ has no membership on 2026-10-20/],
  ];
  for (const [mutate, expected] of cases) {
    const copy = JSON.parse(JSON.stringify(tables));
    mutate(copy);
    const problems = checkRouting(copy, { asOf: AS_OF });
    assert.ok(problems.some((p) => expected.test(p)), `${expected}: ${problems.join('; ')}`);
  }
});

test('the generator refuses to write routing data that breaks a rule', (t) => {
  const { BOX } = routing;
  const original = { ...BOX };
  BOX.latMax = 39900000;
  t.after(() => Object.assign(BOX, original));
  assert.throws(() => generate(SMALL), /breaks \d+ rule\(s\)[\s\S]*coordinates outside the synthetic box/);
});
