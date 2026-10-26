'use strict';

// Story 14.1: the fixture gains synthetic coordinates and a booked schedule
// after as_of (generator v4). Example tests (AD-1 carve-out): they read
// Brightside's own fixture and go with it in a fork.

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
const recordedTables = () => (recorded ??= generate(readSeedConfig()).tables);

test('generator v4: seed.json and fixture_meta record it, and fixture_meta gains the horizon and the new table\'s count', () => {
  assert.equal(GENERATOR_VERSION, 4);
  assert.equal(readSeedConfig().generator_version, 4);
  const meta = Object.fromEntries(recordedTables().fixture_meta.map((m) => [m.key, m.value]));
  assert.equal(meta.generator_version, '4');
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
  for (const c of checks.filter((x) => x.id !== 'synthetic-coordinates')) {
    assert.doesNotMatch(c.sql, /geo_l(at|on)_e6/, `${c.id} reads no coordinate`);
  }
  for (const id of ['integrity-scheduled-route-order', 'integrity-scheduled-schedule', 'integrity-scheduled-after-as-of', 'integrity-scheduled-cadence']) {
    assert.ok(checks.some((c) => c.id === id), id);
  }
});

test('every coordinate is a whole micro-degree inside the synthetic ocean box', () => {
  const { BOX } = routing;
  // The box sits in the open South Pacific, over 1,000 km from any land.
  assert.deepEqual(BOX, { latMin: -40300000, latMax: -39700000, lonMin: -130400000, lonMax: -129600000 });
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

test('drives between a zone\'s city centres are 10 to 35 minutes; booked drives inside one city 5 to 15', () => {
  const at = (city) => ({ lat: -40000000 + Math.round(routing.CITY_KM[city][1] * 8993), lon: -130000000 + Math.round(routing.CITY_KM[city][0] * 11740) });
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
  const route = new Map(t.scheduled_visits.map((v) => [`${v.crew_id}|${v.visit_date}|${v.route_order}`, v]));
  for (const v of t.scheduled_visits) {
    const prev = route.get(`${v.crew_id}|${v.visit_date}|${v.route_order - 1}`);
    if (prev && city.get(prev.property_id) === city.get(v.property_id)) {
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
  assert.deepEqual(checkRouting(t, { asOf: AS_OF }), []);
});

test('the routing rules catch each broken rule', () => {
  const { tables } = generate(SMALL);
  assert.deepEqual(checkRouting(tables, { asOf: AS_OF }), []);
  const first = (t) => t.scheduled_visits.find((v) => v.route_order === 1);
  const cases = [
    [(t) => { t.properties[0].geo_lat_e6 = -1000000; }, /properties 1: coordinates outside the synthetic box/],
    [(t) => { t.crews[0].base_geo_lon_e6 = 0; }, /crews 1: base coordinates outside/],
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
  BOX.latMax = -40100000;
  t.after(() => Object.assign(BOX, original));
  assert.throws(() => generate(SMALL), /breaks \d+ rule\(s\)[\s\S]*coordinates outside the synthetic box/);
});
