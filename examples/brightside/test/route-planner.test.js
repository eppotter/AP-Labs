'use strict';

// Brightside's Plan a route (Story 15.15, AD-R23, AD-R26): the adapter's
// route({ day, crewId, depot, scope }) and the route-planner module.
//
// First, sdk-only unit tests on hand-made rows (no DuckDB): one crew's
// booked stops, every crew in the input from the Office (baseNode the depot
// node, returnToBase true), a crew lead's crew from the scope whatever the
// click says, travel and distance covering exactly [Office, stops] x
// [stops, Office] and each read within max_pairs, distance in whole tenths
// of a km that throws (never guesses) for a pair it was not given, and each
// bad argument refused by field name only.
//
// Then the same on a temporary build of the fixture: S3's day (as_of+3,
// crew 7 out) and an ordinary day; a crew lead; the route's totals
// plausible for the Columbus box; the SQL route() runs passes the guardrail
// with the six coordinate columns forbidden and names none; and nothing it
// returns holds a coordinate (the Office's too), a street address or a
// postal code.
//
// An example test (architecture carve-out): it reads Brightside's app dir and
// fixture, and is deleted with the example in a fork. Its profile comes from
// a test fixture (fixtures/routing-profile.yml), never profiles/brightside/.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sdk = require('../../../kit/runtime/sdk');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { createData } = require('../../../kit/runtime/data');
const { checkSql } = require('../../../kit/runtime/sql');
const { createAdapter, SQL } = require('../app/routing/adapter');
const { S3 } = require('../fixture/lib/scenarios');
const { toDay, toIso } = require('../fixture/lib/days');

const { routing: engine, RoutingFault } = sdk;

const ROOT = path.join(__dirname, '../../..');
const APP = path.join(ROOT, 'examples/brightside/app');
const profile = loadProfile(path.join(__dirname, 'fixtures/routing-profile.yml'));
const OFFICE = profile.routing.depot.node;
const AS_OF_SQL = "SELECT value FROM fixture_meta WHERE key = 'as_of'";
const COORDINATES = ['properties.geo_lat_e6', 'properties.geo_lon_e6', 'crews.base_geo_lat_e6', 'crews.base_geo_lon_e6',
  'depots.geo_lat_e6', 'depots.geo_lon_e6'];

// ---- the module -------------------------------------------------------------

test('the Plan a route manifest: label, routing-map on the route-editor screen, dev only, the Routing module\'s resource', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'modules/route-planner/manifest.json'), 'utf8'));
  const routing = JSON.parse(fs.readFileSync(path.join(APP, 'modules/routing/manifest.json'), 'utf8'));
  assert.deepEqual(manifest, {
    id: 'route-planner',
    hub: 'brightside',
    label: 'Plan a route',
    description: "Reorder one crew's day from the Office: suggestions only, nothing is changed",
    resource: routing.resource,
    archetype: 'routing-map',
    screen: 'route-editor',
    environments: ['dev'],
    adapter: 'adapter.js',
  });
  assert.equal(manifest.resource, profile.routing.audience.all_crews, 'the same audience as Routing');
  // Its adapter is Brightside's routing adapter, as the Routing module's is.
  assert.equal(require('../app/modules/route-planner/adapter').createAdapter, createAdapter);
  assert.equal(require('../app/modules/routing/adapter').createAdapter, createAdapter);
  // The existing Routing module is unchanged (Story 15.5's manifest).
  assert.deepEqual(routing, {
    id: 'routing',
    hub: 'brightside',
    label: 'Routing',
    description: 'Each crew\'s day on a map: suggestions only, nothing is changed',
    resource: 'ROUTING_ALL_CREWS',
    archetype: 'routing-map',
    environments: ['dev'],
    adapter: 'adapter.js',
  });
});

test('the test profile declares the Office as Brightside does: its columns forbidden, a depot node source, routing.depot', () => {
  for (const c of COORDINATES) assert.ok(profile.sql.forbidden_columns.includes(c), c);
  assert.deepEqual(profile.routing.coordinates.nodes.find((n) => n.kind === 'depot'),
    { kind: 'depot', table: 'depots', id_column: 'depot_id', lat_column: 'geo_lat_e6', lon_column: 'geo_lon_e6' });
  assert.deepEqual(profile.routing.depot, { node: 'depot:office', label: 'Office' });
});

// ---- unit: hand-made rows, no DuckDB ------------------------------------------

const DAY = '2026-10-05';
const UNIT_ROUTING = {
  limits: { earliest_start: 360, default_start: 480, aim_finish: 1080, latest_finish: 1380, slot_minutes: 15 },
  max_pairs: 10000,
  gap_fill: { horizon_days: 14 },
};
const crewRow = (id, zone, over = {}) => ({
  crew_id: id, zone_id: zone, headcount_planned: 3, headcount_present: 3, leads_planned: 1, leads_present: 1, ...over,
});
const visitRow = (id, property, crew, order, over = {}) => ({
  scheduled_visit_id: id,
  property_id: property,
  crew_id: crew,
  status: 'scheduled',
  visit_date: DAY,
  route_order: order,
  start_minutes: 480 + order * 60,
  scheduled_minutes: 60,
  labour_minutes: 180,
  preferred_crew: null,
  preferred_crew_strength: null,
  allowed_days: null,
  allowed_days_strength: null,
  time_window: null,
  time_window_strength: null,
  ...over,
});
const CREWS = [crewRow(1, 'north'), crewRow(2, 'north'), crewRow(3, 'south', { leads_present: 0, headcount_present: 2 })];
const VISITS = [
  visitRow(11, 101, 1, 1), visitRow(12, 102, 1, 2), visitRow(13, 103, 1, 3, { status: 'cancelled' }), visitRow(14, 104, 1, 4),
  visitRow(21, 201, 2, 1), visitRow(22, 202, 2, 2),
  visitRow(31, 301, 3, 1), visitRow(32, 302, 3, 2),
];
// A made-up matrix: minutes and tenths from the two ids, so each leg differs.
const num = (node) => Number(node.split(':')[1].replace(/\D/g, '') || 7);
const legOf = (from, to) => ({
  from_node: from, to_node: to, minutes: from === to ? 0 : 5 + ((num(from) + num(to)) % 11), km_tenths: from === to ? 0 : 20 + ((num(from) * 3 + num(to)) % 50),
});

function fakeData() {
  const fake = {
    runs: [],
    matrices: [],
    async run(sql, params = {}) {
      fake.runs.push({ sql, params });
      if (sql === AS_OF_SQL) return [{ value: '2026-09-30' }];
      if (sql === SQL.crews) return CREWS.map((r) => ({ ...r }));
      if (sql === SQL.day) return VISITS.map((r) => ({ ...r }));
      throw new Error('unexpected query');
    },
    async travelMatrix(fromIds, toIds) {
      fake.matrices.push({ fromIds: [...fromIds], toIds: [...toIds] });
      return fromIds.flatMap((f) => toIds.map((t) => legOf(f, t)));
    },
  };
  return fake;
}

// Every (from, to) pair the recorded travelMatrix calls asked for.
const pairsAsked = (matrices) => new Set(matrices.flatMap((m) => m.fromIds.flatMap((f) => m.toIds.map((t) => `${f}>${t}`))));
const rectangle = (office, nodes) => new Set([office, ...nodes].flatMap((f) => [...nodes, office].map((t) => `${f}>${t}`)));

test('route(): one crew\'s booked stops from the Office, the crew\'s baseNode the depot and returnToBase true', async () => {
  const data = fakeData();
  const adapter = createAdapter({ data, routing: UNIT_ROUTING });
  const got = await adapter.route({ day: DAY, crewId: '1', depot: OFFICE, scope: { all: true } });
  assert.deepEqual(Object.keys(got).sort(), ['distance', 'input', 'travel']);
  const { input } = got;
  assert.equal(engine.validateInput(input), input);
  assert.deepEqual(input.crews, [{
    crewId: '1', zoneId: 'north', baseNode: OFFICE, returnToBase: true, headcountPlanned: 3, headcountPresent: 3, available: true,
  }]);
  // The scheduled stops only (13 is cancelled), in booked order; no other crew's.
  assert.deepEqual(input.stops.map((s) => [s.stopId, s.node, s.currentCrewId, s.routeOrder]),
    [['11', 'property:101', '1', 1], ['12', 'property:102', '1', 2], ['14', 'property:104', '1', 4]]);
  assert.equal(input.day, DAY);
  assert.equal(input.asOf, '2026-09-30');
  assert.equal(input.cancelled, undefined);
  assert.equal(input.candidates, undefined);
  // It reads only as_of, crews.sql and day.sql.
  assert.deepEqual(data.runs.map((r) => r.sql).sort(), [AS_OF_SQL, SQL.crews, SQL.day].sort());
  // Exactly [Office, stops] x [stops, Office].
  const nodes = input.stops.map((s) => s.node);
  assert.deepEqual(pairsAsked(data.matrices), rectangle(OFFICE, nodes));
  for (const f of [OFFICE, ...nodes]) {
    for (const t of [...nodes, OFFICE]) {
      assert.equal(got.travel(f, t), legOf(f, t).minutes, `${f} to ${t}`);
      assert.equal(got.distance(f, t), legOf(f, t).km_tenths, `${f} to ${t}`);
    }
  }
  // The engine times the booked order from the Office and back.
  const ev = engine.evaluateOrder(input, { travel: got.travel, returnToBase: true, crewId: '1', order: nodes.map((n) => input.stops.find((s) => s.node === n).stopId) });
  assert.equal(ev.stops.length, 3);
  assert.equal(ev.stops[0].travelMinutesFromPrevious, legOf(OFFICE, 'property:101').minutes);
  assert.equal(ev.returnMinutes, legOf('property:104', OFFICE).minutes);
});

test('route(): distance throws a RoutingFault for a pair it was not given, naming no node or value', async () => {
  const adapter = createAdapter({ data: fakeData(), routing: UNIT_ROUTING });
  const { distance } = await adapter.route({ day: DAY, crewId: '1', depot: OFFICE, scope: { all: true } });
  for (const [from, to] of [['property:201', 'property:101'], ['crew:1', OFFICE], ['property:101', 'property:999']]) {
    assert.throws(() => distance(from, to), (err) => {
      assert.ok(err instanceof RoutingFault);
      assert.deepEqual(err.details, { field: 'distance', problem: 'no_travel' });
      assert.ok(!err.message.includes(from.split(':')[1]) && !err.message.includes(to.split(':')[1]));
      return true;
    });
  }
});

test('route(): a crew lead gets their own crew whatever crewId says; a crew out keeps its booked minutes', async () => {
  const data = fakeData();
  const adapter = createAdapter({ data, routing: UNIT_ROUTING });
  const lead = await adapter.route({ day: DAY, crewId: '1', depot: OFFICE, scope: { crewId: '2' } });
  assert.deepEqual(lead.input.crews.map((c) => c.crewId), ['2']);
  assert.deepEqual(lead.input.stops.map((s) => s.stopId), ['21', '22']);
  assert.deepEqual(pairsAsked(data.matrices), rectangle(OFFICE, ['property:201', 'property:202']));
  // A lead with no crewId at all still gets their crew.
  const bare = await adapter.route({ day: DAY, depot: OFFICE, scope: { crewId: '2' } });
  assert.deepEqual(bare.input.crews.map((c) => c.crewId), ['2']);
  // Crew 3's lead is absent: it is out (available false), its stops keep their booked minutes.
  const out = await adapter.route({ day: DAY, crewId: '3', depot: OFFICE, scope: { all: true } });
  assert.equal(out.input.crews[0].available, false);
  assert.equal(out.input.crews[0].baseNode, OFFICE);
  assert.deepEqual(out.input.stops.map((s) => s.serviceMinutes), [60, 60]);
});

test('route(): a crew the day does not know gives no crew and no stops, and reads no travel', async () => {
  const data = fakeData();
  const adapter = createAdapter({ data, routing: UNIT_ROUTING });
  const got = await adapter.route({ day: DAY, crewId: '99', depot: OFFICE, scope: { all: true } });
  assert.deepEqual([got.input.crews, got.input.stops], [[], []]);
  assert.equal(engine.validateInput(got.input), got.input);
  assert.deepEqual(data.matrices, []);
  assert.throws(() => got.distance(OFFICE, OFFICE), RoutingFault);
});

test('route(): each travel read stays within max_pairs and together they cover the rectangle exactly', async () => {
  const data = fakeData();
  const adapter = createAdapter({ data, routing: { ...UNIT_ROUTING, max_pairs: 5 } });
  const got = await adapter.route({ day: DAY, crewId: '1', depot: OFFICE, scope: { all: true } });
  assert.ok(data.matrices.length > 1, 'split into several reads');
  for (const m of data.matrices) assert.ok(m.fromIds.length * m.toIds.length <= 5, `${m.fromIds.length} x ${m.toIds.length}`);
  assert.deepEqual(pairsAsked(data.matrices), rectangle(OFFICE, got.input.stops.map((s) => s.node)));
});

test('route(): a bad day, depot or crew id is refused by field name, before any read', async () => {
  const cases = [
    [{ day: '5 Oct', crewId: '1', depot: OFFICE }, 'day'],
    [{ crewId: '1', depot: OFFICE }, 'day'],
    [{ day: DAY, crewId: '1' }, 'depot'],
    [{ day: DAY, crewId: '1', depot: 'crew:1' }, 'depot'],
    [{ day: DAY, crewId: '1', depot: 'depot:' }, 'depot'],
    [{ day: DAY, crewId: '1', depot: { node: OFFICE } }, 'depot'],
    [{ day: DAY, depot: OFFICE }, 'crewId'],
    [{ day: DAY, crewId: 1, depot: OFFICE }, 'crewId'],
    [{ day: DAY, crewId: "1' OR 1=1", depot: OFFICE }, 'crewId'],
  ];
  for (const [args, field] of cases) {
    const data = fakeData();
    const adapter = createAdapter({ data, routing: UNIT_ROUTING });
    await assert.rejects(adapter.route({ ...args, scope: { all: true } }), (err) => {
      assert.ok(err instanceof RoutingFault, JSON.stringify(args));
      assert.equal(err.details.field, field, JSON.stringify(args));
      return true;
    });
    assert.deepEqual([data.runs, data.matrices], [[], []], JSON.stringify(args));
  }
});

// ---- on the fixture ------------------------------------------------------------

let tmp;
let data;
let raw; // a test-only reader of the hidden columns, to scan the output for them
let asOf;
let calls;
let runs;
let adapter;
const dayOf = (offset) => toIso(toDay(asOf) + offset);

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-route-planner-')));
  const file = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: file });
  data = createData({ file, profile });
  raw = createData({ file, profile: { sql: { forbidden_columns: [] } } });
  asOf = (await data.run(AS_OF_SQL))[0].value;
  // The data object the adapter gets: the real one, every query and every
  // travelMatrix rectangle recorded.
  calls = [];
  runs = [];
  const spied = Object.freeze({
    run: (sql, params, opts) => {
      runs.push(sql);
      return data.run(sql, params, opts);
    },
    describe: data.describe,
    travelMatrix: async (fromIds, toIds) => {
      calls.push({ fromIds: [...fromIds], toIds: [...toIds] });
      return data.travelMatrix(fromIds, toIds);
    },
  });
  adapter = createAdapter({ data: spied, routing: profile.routing });
});
after(() => {
  if (data) data.close();
  if (raw) raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// One crew's route from the adapter, with the recorded reads.
async function routeOf(day, crewId, scope = { all: true }) {
  calls.length = 0;
  runs.length = 0;
  const got = await adapter.route({ day, crewId, depot: OFFICE, scope });
  return { ...got, calls: calls.slice(), runs: runs.slice() };
}

// The booked order's totals: drive minutes, distance in tenths of a km.
function totals(got, crewId) {
  const order = got.input.stops.slice().sort((a, b) => a.routeOrder - b.routeOrder);
  const nodes = [OFFICE, ...order.map((s) => s.node), OFFICE];
  let minutes = 0;
  let tenths = 0;
  for (let i = 1; i < nodes.length; i += 1) {
    if (nodes[i - 1] === nodes[i]) continue;
    minutes += got.travel(nodes[i - 1], nodes[i]);
    tenths += got.distance(nodes[i - 1], nodes[i]);
  }
  const ev = engine.evaluateOrder(got.input, {
    travel: got.travel, returnToBase: true, crewId, order: order.map((s) => s.stopId),
  });
  return { minutes, tenths, ev, legs: nodes.length - 1 };
}

const crewsWithStops = async (day) => (await data.run(
  "SELECT crew_id, count(*) AS n FROM scheduled_visits WHERE visit_date = CAST($day AS DATE) AND status = 'scheduled' GROUP BY crew_id ORDER BY crew_id",
  { day },
  { declared: ['day'] },
)).map((r) => [String(r.crew_id), Number(r.n)]);

test('the Office is in the data: travelMatrix knows depot:office, and no other depot', async () => {
  const [row] = await data.run('SELECT count(*) AS n, min(depot_id) AS id, min(name) AS name FROM depots');
  assert.deepEqual([Number(row.n), row.id, row.name], [1, 'office', 'Office']);
  const legs = await data.travelMatrix([OFFICE], ['crew:1']);
  assert.equal(legs.length, 1);
  assert.ok(Number.isSafeInteger(legs[0].minutes) && Number.isSafeInteger(legs[0].km_tenths));
});

test('S3\'s day (as_of+3): crew 7 is out, its booked stops come from the Office, and the totals are plausible', async () => {
  const day = dayOf(S3.dayOffset);
  const got = await routeOf(day, String(S3.crewId));
  assert.equal(engine.validateInput(got.input), got.input);
  assert.deepEqual(got.input.crews.map((c) => [c.crewId, c.baseNode, c.returnToBase, c.available]), [[String(S3.crewId), OFFICE, true, false]]);
  // S3's planted route for crew 7, its scheduled visits in booked order.
  const booked = got.input.stops.slice().sort((a, b) => a.routeOrder - b.routeOrder).map((s) => Number(s.stopId));
  assert.deepEqual(booked, S3.routes[S3.crewId].filter((id) => booked.includes(id)));
  const want = (await crewsWithStops(day)).find(([id]) => id === String(S3.crewId))[1];
  assert.equal(got.input.stops.length, want);
  assert.ok(got.input.stops.every((s) => s.currentCrewId === String(S3.crewId)));
  // Exactly [Office, stops] x [stops, Office], within max_pairs.
  assert.deepEqual(pairsAsked(got.calls), rectangle(OFFICE, [...new Set(got.input.stops.map((s) => s.node))]));
  for (const c of got.calls) assert.ok(c.fromIds.length * c.toIds.length <= profile.routing.max_pairs);
  const { minutes, tenths, ev, legs } = totals(got, String(S3.crewId));
  // The Columbus box is about 70 km across: a crew's loop from the Office is
  // over 1 km and under 400 km; each leg at 40 km/h and a 5-minute floor.
  assert.ok(tenths > 10 && tenths < 4000, `${tenths / 10} km`);
  assert.ok(minutes >= legs * 5, `${minutes} min`);
  assert.ok(tenths <= Math.ceil((minutes * 40 * 10) / 60), 'no leg is faster than 40 km/h');
  assert.equal(ev.stops.length, got.input.stops.length);
  assert.equal(ev.cost.driveMinutes, minutes);
});

test('an ordinary day (as_of+7): every crew with stops gets its own route from the Office, totals plausible', async () => {
  const day = dayOf(7);
  const crews = await crewsWithStops(day);
  assert.ok(crews.length >= 5, `${crews.length} crews working`);
  for (const [crewId, n] of crews) {
    const got = await routeOf(day, crewId);
    assert.equal(got.input.crews.length, 1, crewId);
    assert.equal(got.input.crews[0].baseNode, OFFICE);
    assert.equal(got.input.crews[0].available, true, crewId);
    assert.equal(got.input.stops.length, n, crewId);
    assert.deepEqual(pairsAsked(got.calls), rectangle(OFFICE, [...new Set(got.input.stops.map((s) => s.node))]), crewId);
    const { minutes, tenths, ev } = totals(got, crewId);
    assert.ok(tenths > 10 && tenths < 4000, `crew ${crewId}: ${tenths / 10} km`);
    assert.ok(tenths <= Math.ceil((minutes * 40 * 10) / 60), `crew ${crewId}`);
    assert.equal(ev.cost.driveMinutes, minutes, crewId);
    // A drive from the Office: the first leg is the Office's, not the crew base's.
    const first = got.input.stops.slice().sort((a, b) => a.routeOrder - b.routeOrder)[0];
    assert.equal(ev.stops[0].travelMinutesFromPrevious, got.travel(OFFICE, first.node), crewId);
  }
});

test('a crew lead\'s route is their own crew\'s, whatever crewId the click says', async () => {
  const day = dayOf(S3.dayOffset);
  const lead = profile.routing.audience.crew_leads.find((l) => l.user === 'lee').crew_id;
  const got = await routeOf(day, '1', { crewId: lead });
  assert.deepEqual(got.input.crews.map((c) => c.crewId), [lead]);
  assert.ok(got.input.stops.length > 0 && got.input.stops.every((s) => s.currentCrewId === lead));
  assert.deepEqual(pairsAsked(got.calls), rectangle(OFFICE, [...new Set(got.input.stops.map((s) => s.node))]));
});

test('route() runs only the adapter\'s SQL, which passes the guardrail with the six coordinate columns forbidden and names none', async () => {
  const got = await routeOf(dayOf(7), '1');
  assert.deepEqual([...new Set(got.runs)].sort(), [AS_OF_SQL, SQL.crews, SQL.day].sort());
  for (const sql of [SQL.crews, SQL.day]) {
    assert.deepEqual(checkSql(sql, { forbiddenColumns: profile.sql.forbidden_columns }), { ok: true });
    for (const column of COORDINATES) assert.ok(!sql.includes(column.split('.')[1]), `names ${column}`);
    assert.doesNotMatch(sql, /\bdepots\b|street_address|postal_code/);
  }
});

// Whether text holds value as a whole token (see routing-module.test.js).
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const holdsToken = (text, value) => new RegExp(`(?<![0-9A-Za-z])${escape(String(value))}(?![0-9A-Za-z])`).test(text);

test('nothing route() returns holds a coordinate (the Office\'s too), a street address or a postal code', async () => {
  const day = dayOf(S3.dayOffset);
  const crews = (await crewsWithStops(day)).map(([id]) => id);
  const texts = [];
  for (const crewId of crews) {
    const got = await routeOf(day, crewId);
    const nodes = [OFFICE, ...new Set(got.input.stops.map((s) => s.node))];
    const legs = nodes.flatMap((f) => nodes.map((t) => (f === t ? null : [f, t, got.travel(f, t), got.distance(f, t)]))).filter(Boolean);
    texts.push(JSON.stringify(got.input), JSON.stringify(legs), JSON.stringify(got.calls));
  }
  const text = texts.join('\n');
  const secrets = await raw.run([
    'SELECT CAST(p.geo_lat_e6 AS VARCHAR) AS v FROM properties p',
    'UNION ALL SELECT CAST(p.geo_lon_e6 AS VARCHAR) FROM properties p',
    'UNION ALL SELECT CAST(c.base_geo_lat_e6 AS VARCHAR) FROM crews c',
    'UNION ALL SELECT CAST(c.base_geo_lon_e6 AS VARCHAR) FROM crews c',
    'UNION ALL SELECT CAST(d.geo_lat_e6 AS VARCHAR) FROM depots d',
    'UNION ALL SELECT CAST(d.geo_lon_e6 AS VARCHAR) FROM depots d',
    'UNION ALL SELECT p.street_address FROM properties p',
    'UNION ALL SELECT p.postal_code FROM properties p',
  ].join('\n'));
  assert.ok(secrets.length > 8000);
  // Postal codes are 5 digits, so only those of the day's own properties are
  // tested as tokens (a minute or tenths count could equal a random one).
  const ids = new Set(JSON.parse(texts[0]).stops.map((s) => s.node.split(':')[1]));
  const own = await raw.run('SELECT p.postal_code AS v FROM properties p WHERE list_contains(string_split($ids, \',\'), CAST(p.property_id AS VARCHAR))',
    { ids: [...ids].join(',') }, { declared: ['ids'] });
  const leaks = secrets.filter((r) => !/^\d{5}$/.test(r.v)).concat(own).filter((r) => holdsToken(text, r.v));
  assert.deepEqual(leaks, []);
  for (const v of ['40122000', '-82908000', '40.122', '-82.908']) assert.ok(!text.includes(v), v);
});
