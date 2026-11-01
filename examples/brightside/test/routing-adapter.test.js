'use strict';

// Brightside's routing adapter (Story 14.3, AD-R2, data-design §4) on a
// temporary build of the fixture. Checked here: the inputs it builds pass the
// engine's validateInput; its SQL passes the guardrail with the four
// coordinate columns forbidden and never names one; rules are pivoted one row
// per property (no fan-out); headcount subtracts absences and a crew is out
// when its lead is absent or nobody is present (GRD-008, approved 2026-10-31);
// node ids are kind-prefixed; candidates leave out the cancelled property and
// every property visited on the gap day; prevVisitDate is the latest
// non-cancelled visit across history and schedule; flexible means no hard day
// or time rule; and travel comes only from travelMatrix, one rectangle the
// engine reads at a time, each within max_pairs. Then the three planted
// scenarios run through the adapter and the engine: S1 booked drive minutes
// and no hard break, S2's valid count and top fill, S3's in-zone /
// cross-zone / unplaced split, against targets.json `routing`.
//
// An example test (architecture carve-out): it reads Brightside's app dir and
// fixture (its targets and planted scenario ids), and is deleted with the
// example in a fork. Its profile comes from a test fixture
// (fixtures/routing-profile.yml), never profiles/brightside/.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { createData } = require('../../../kit/runtime/data');
const { checkSql } = require('../../../kit/runtime/sql');
const routing = require('../../../kit/runtime/routing');
const { createAdapter, SQL } = require('../app/routing/adapter');
const { S1, S2, S3 } = require('../fixture/lib/scenarios');
const { toDay, toIso } = require('../fixture/lib/days');

const ROOT = path.join(__dirname, '../../..');
const ADAPTER_DIR = path.join(__dirname, '../app/routing');
const profile = loadProfile(path.join(__dirname, 'fixtures/routing-profile.yml'));
const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/brightside/fixture/targets.json'), 'utf8')).routing;
const COORDINATES = ['properties.geo_lat_e6', 'properties.geo_lon_e6', 'crews.base_geo_lat_e6', 'crews.base_geo_lon_e6'];
const NODE = /^(property|crew):\d+$/;

let tmp;
let data;
let asOf;
let calls;
let adapter;
const dayOf = (offset) => toIso(toDay(asOf) + offset);

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-routing-adapter-')));
  const file = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: file });
  data = createData({ file, profile });
  asOf = (await data.run("SELECT value FROM fixture_meta WHERE key = 'as_of'"))[0].value;
  // The data object the adapter gets: the real one, its travelMatrix
  // recorded so the test sees every rectangle read.
  calls = [];
  const spied = Object.freeze({
    run: data.run,
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
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sql = (text, params = {}) => data.run(text, params, { declared: Object.keys(params) });

test('the test profile forbids the four coordinate columns and declares routing', () => {
  for (const c of COORDINATES) assert.ok(profile.sql.forbidden_columns.includes(c), c);
  assert.equal(profile.routing.max_pairs, 10000);
  assert.equal(profile.routing.gap_fill.horizon_days, 14);
});

test('the adapter SQL passes the guardrail with the coordinate columns forbidden, and names none', () => {
  const files = fs.readdirSync(ADAPTER_DIR).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual(files, ['candidates.sql', 'crews.sql', 'day.sql', 'labels.sql']);
  for (const [name, text] of Object.entries(SQL)) {
    const verdict = checkSql(text, { forbiddenColumns: profile.sql.forbidden_columns });
    assert.deepEqual(verdict, { ok: true }, name);
    for (const c of COORDINATES) assert.ok(!text.includes(c.split('.')[1]), `${name} names ${c}`);
  }
  // Nor does the adapter's code: drive times come only from travelMatrix.
  const code = fs.readFileSync(path.join(ADAPTER_DIR, 'adapter.js'), 'utf8');
  for (const c of COORDINATES) assert.ok(!code.includes(c.split('.')[1]), `adapter.js names ${c}`);
  assert.ok(!/haversine|asin|radians/i.test(code.replace(/^\s*\/\/.*$/gm, '')), 'adapter.js works out no distance');
});

test('the day input passes validateInput; node ids are kind-prefixed; every booked stop is there once', async () => {
  for (const offset of [1, 2, 3, 7, 14]) {
    const day = dayOf(offset);
    const { input } = await adapter.dayInput({ day });
    assert.equal(routing.validateInput(input), input);
    assert.equal(input.day, day);
    assert.equal(input.asOf, asOf);
    assert.deepEqual(input.limits, { earliestStart: 360, defaultStart: 480, aimFinish: 1080, latestFinish: 1380, startRoundTo: 5 });
    const [{ n }] = await sql("SELECT CAST(COUNT(scheduled_visit_id) AS INTEGER) AS n FROM scheduled_visits WHERE status = 'scheduled' AND visit_date = CAST($day AS DATE)", { day });
    assert.equal(input.stops.length, n, day);
    assert.equal(new Set(input.stops.map((s) => s.stopId)).size, n);
    for (const s of input.stops) assert.match(s.node, /^property:\d+$/);
    for (const c of input.crews) assert.match(c.baseNode, /^crew:\d+$/);
    assert.equal(input.crews.length, 15);
  }
});

test('rules are pivoted one row per property: the day query never fans out', async () => {
  let multi = 0;
  for (let offset = 1; offset <= 28; offset += 1) {
    const day = dayOf(offset);
    const rows = await data.run(SQL.day, { day }, { declared: ['day'] });
    const [{ n }] = await sql("SELECT CAST(COUNT(scheduled_visit_id) AS INTEGER) AS n FROM scheduled_visits WHERE visit_date = CAST($day AS DATE) AND status IN ('scheduled', 'cancelled')", { day });
    assert.equal(rows.length, n, day);
    assert.equal(new Set(rows.map((r) => r.scheduled_visit_id)).size, n, day);
    multi += rows.filter((r) => [r.preferred_crew, r.allowed_days, r.time_window].filter((v) => v !== null).length >= 2).length;
  }
  assert.ok(multi > 0, 'some property has two or more rules, so the pivot is exercised');
});

test('rules map to engine rule instances: ISO day numbers, windows as minutes, the row\'s strength', async () => {
  const rules = await sql('SELECT property_id, rule_type, value, strength FROM service_rules');
  const byProperty = new Map();
  for (const r of rules) {
    if (!byProperty.has(r.property_id)) byProperty.set(r.property_id, {});
    byProperty.get(r.property_id)[r.rule_type] = r;
  }
  const ISO = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 7 };
  let days = 0;
  let windows = 0;
  for (let offset = 1; offset <= 14; offset += 1) {
    const { input } = await adapter.dayInput({ day: dayOf(offset) });
    for (const stop of input.stops) {
      const raw = byProperty.get(Number(stop.node.split(':')[1])) || {};
      const expected = [];
      if (raw.preferred_crew) expected.push({ ruleId: 'preferred-crew', value: raw.preferred_crew.value, strength: raw.preferred_crew.strength });
      if (raw.day_of_week) {
        days += raw.day_of_week.value.includes('|') ? 1 : 0;
        expected.push({ ruleId: 'day-of-week', value: raw.day_of_week.value.split('|').map((d) => ISO[d]).sort((a, b) => a - b), strength: raw.day_of_week.strength });
      }
      if (raw.time_of_day) {
        windows += 1;
        const value = raw.time_of_day.value === 'morning' ? { startFrom: 360, startBefore: 720 } : { startFrom: 720, startBefore: 1380 };
        expected.push({ ruleId: 'time-of-day', value, strength: raw.time_of_day.strength });
      }
      assert.deepEqual(stop.rules, expected, `stop ${stop.stopId}`);
    }
  }
  assert.ok(days > 0, 'a day_of_week rule with two days, MON|THU style, is mapped');
  assert.ok(windows > 0, 'a time_of_day rule is mapped');
});

test('headcount subtracts absences; a crew is out when its lead is absent or nobody is present (GRD-008, approved 2026-10-31)', async () => {
  const day = dayOf(S3.dayOffset);
  const { input } = await adapter.dayInput({ day });
  const crew = (id) => input.crews.find((c) => c.crewId === String(id));
  // Crew 7: lead and one cleaner absent, one present.
  assert.deepEqual(
    { planned: crew(S3.crewId).headcountPlanned, present: crew(S3.crewId).headcountPresent, available: crew(S3.crewId).available },
    { planned: 3, present: 1, available: false },
  );
  for (const id of S3.zoneCrews.filter((c) => c !== S3.crewId)) assert.equal(crew(id).available, true);
  // Every crew's headcount, independently: open memberships less absences.
  const members = await sql(
    'SELECT crew_id, staff_id FROM crew_memberships WHERE start_date <= CAST($day AS DATE) AND (end_date IS NULL OR end_date >= CAST($day AS DATE))', { day },
  );
  const away = new Set((await sql('SELECT staff_id FROM staff_absences WHERE absence_date = CAST($day AS DATE)', { day })).map((r) => r.staff_id));
  assert.ok(away.size >= S3.absent.length);
  for (const c of input.crews) {
    const mine = members.filter((m) => String(m.crew_id) === c.crewId);
    assert.equal(c.headcountPlanned, mine.length, `crew ${c.crewId}`);
    assert.equal(c.headcountPresent, mine.filter((m) => !away.has(m.staff_id)).length, `crew ${c.crewId}`);
  }
});

test('service time: labour over the people present on a working crew; an out crew keeps its booked minutes', async () => {
  const day = dayOf(S3.dayOffset);
  const { input } = await adapter.dayInput({ day });
  const booked = new Map((await sql('SELECT scheduled_visit_id, scheduled_minutes FROM scheduled_visits WHERE visit_date = CAST($day AS DATE)', { day }))
    .map((r) => [String(r.scheduled_visit_id), r.scheduled_minutes]));
  const crewOf = new Map(input.crews.map((c) => [c.crewId, c]));
  let out = 0;
  for (const s of input.stops) {
    const c = crewOf.get(s.currentCrewId);
    if (!c.available) {
      out += 1;
      assert.equal(s.serviceMinutes, booked.get(s.stopId), `stop ${s.stopId}`);
    } else {
      assert.equal(s.serviceMinutes, Math.max(30, Math.round(s.labourMinutes / c.headcountPresent / 15) * 15), `stop ${s.stopId}`);
    }
  }
  assert.equal(out, 6);
});

test('travel comes only from travelMatrix: the day reads each zone\'s rectangle, plus the orphans\' when a crew is out', async () => {
  calls.length = 0;
  const day = dayOf(S3.dayOffset);
  const { input, travel } = await adapter.dayInput({ day });
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(call.fromIds.length * call.toIds.length <= profile.routing.max_pairs);
    for (const id of [...call.fromIds, ...call.toIds]) assert.match(id, NODE);
  }
  // A pair the adapter did not fetch is refused, never 0: two stops in
  // different zones, neither on the crew that is out.
  const zoneOf = new Map(input.crews.map((c) => [c.crewId, c.zoneId]));
  const outCrews = new Set(input.crews.filter((c) => !c.available).map((c) => c.crewId));
  const working = input.stops.filter((s) => !outCrews.has(s.currentCrewId));
  const a = working[0];
  const b = working.find((s) => zoneOf.get(s.currentCrewId) !== zoneOf.get(a.currentCrewId));
  assert.throws(() => travel(a.node, b.node), (err) => err.code === 'ROUTING_FAULT' && err.details.problem === 'no_travel');
  // The rectangles hold no more than the engine reads.
  const pairs = calls.reduce((n, c) => n + c.fromIds.length * c.toIds.length, 0);
  const zones = new Map();
  for (const c of input.crews) {
    if (!zones.has(c.zoneId)) zones.set(c.zoneId, { bases: 0, stops: 0 });
    zones.get(c.zoneId).bases += 1;
  }
  for (const s of input.stops) zones.get(zoneOf.get(s.currentCrewId)).stops += 1;
  const orphans = input.stops.length - working.length;
  const expected = [...zones.values()].reduce((n, z) => n + (z.bases + z.stops) * z.stops, 0)
    + (input.crews.length + input.stops.length) * orphans + orphans * input.stops.length;
  assert.equal(pairs, expected);
});

test('gap fill: candidates leave out the cancelled property and every property visited that day', async () => {
  const day = dayOf(S2.dayOffset);
  const { input } = await adapter.gapInput({ day, crewId: S2.crewId });
  assert.equal(routing.validateInput(input), input);
  assert.deepEqual(input.cancelled.map((c) => c.stopId), [String(S2.cancelled)]);
  const cancelledNode = input.cancelled[0].node;
  const nodes = new Set(input.candidates.map((c) => c.node));
  assert.ok(!nodes.has(cancelledNode), 'the cancelled property is not a candidate');
  for (const s of input.stops) assert.ok(!nodes.has(s.node), `property visited on ${day} is not a candidate`);
  // The exclusion is real: the cancelled property has a visit in the horizon.
  const [{ n }] = await sql(
    "SELECT CAST(COUNT(scheduled_visit_id) AS INTEGER) AS n FROM scheduled_visits WHERE property_id = $pid AND status = 'scheduled' AND visit_date > CAST($day AS DATE) AND visit_date <= CAST($day AS DATE) + 14",
    { pid: Number(cancelledNode.split(':')[1]), day },
  );
  assert.ok(n > 0);
  // Each candidate is its property's next booked visit within 14 days.
  const next = new Map();
  for (const r of await sql(
    "SELECT scheduled_visit_id, property_id, CAST(visit_date AS VARCHAR) AS visit_date FROM scheduled_visits WHERE status = 'scheduled' AND visit_date > CAST($day AS DATE) AND visit_date <= CAST($day AS DATE) + 14 ORDER BY visit_date, scheduled_visit_id",
    { day },
  )) if (!next.has(r.property_id)) next.set(r.property_id, r);
  const visited = new Set((await sql('SELECT property_id FROM scheduled_visits WHERE visit_date = CAST($day AS DATE)', { day })).map((r) => r.property_id));
  const expected = [...next.values()].filter((r) => !visited.has(r.property_id)).map((r) => String(r.scheduled_visit_id)).sort();
  assert.deepEqual(input.candidates.map((c) => c.stopId).sort(), expected);
  for (const c of input.candidates) assert.equal(c.plannedDate, next.get(Number(c.node.split(':')[1])).visit_date);
});

test('gap fill: prevVisitDate is the latest non-cancelled visit across history and schedule; cadence and flexible', async () => {
  const day = dayOf(S2.dayOffset);
  const { input } = await adapter.gapInput({ day, crewId: S2.crewId });
  const latest = new Map();
  const later = (pid, d) => { if (!latest.has(pid) || latest.get(pid) < d) latest.set(pid, d); };
  for (const r of await sql("SELECT property_id, CAST(visit_date AS VARCHAR) AS d FROM visits WHERE status <> 'cancelled'")) later(r.property_id, r.d);
  for (const r of await sql("SELECT property_id, CAST(visit_date AS VARCHAR) AS d FROM scheduled_visits WHERE status <> 'cancelled' AND visit_date < CAST($day AS DATE)", { day })) later(r.property_id, r.d);
  let fromSchedule = 0;
  for (const c of input.candidates) {
    const want = latest.get(Number(c.node.split(':')[1])) || null;
    assert.equal(c.prevVisitDate, want, `candidate ${c.stopId}`);
    if (want !== null && want > asOf) fromSchedule += 1;
  }
  assert.ok(fromSchedule > 0, 'some candidates were last visited in the booked schedule, after as_of');
  // A cancelled visit never counts: the cadence decoy's last visit is real.
  const plans = new Map((await sql('SELECT sv.scheduled_visit_id, p.frequency FROM scheduled_visits sv JOIN plans p ON p.plan_id = sv.plan_id'))
    .map((r) => [String(r.scheduled_visit_id), r.frequency]));
  const cadence = { weekly: 7, biweekly: 14, monthly: 30 };
  for (const c of input.candidates) {
    assert.equal(c.cadenceDays, cadence[plans.get(c.stopId)]);
    const hard = c.rules.some((r) => (r.ruleId === 'day-of-week' || r.ruleId === 'time-of-day') && r.strength === 'hard');
    assert.equal(c.flexible, !hard, `candidate ${c.stopId}`);
  }
  assert.ok(input.candidates.some((c) => c.cadenceDays === 30), 'a monthly plan counts 30 days');
  const of = (pid) => input.candidates.find((c) => c.node === `property:${pid}`);
  assert.equal(of(S2.bestFill).flexible, true);
  assert.equal(of(S2.morningDecoy).flexible, false);
  // A candidate's service time uses the gap crew's headcount that day.
  const crew = input.crews.find((c) => c.crewId === String(S2.crewId));
  for (const c of input.candidates) assert.equal(c.serviceMinutes, Math.max(30, Math.round(c.labourMinutes / crew.headcountPresent / 15) * 15));
});

test('gap fill reads only [previous, ...candidates] x [...candidates, next] rows the engine uses, within max_pairs', async () => {
  calls.length = 0;
  const day = dayOf(S2.dayOffset);
  const { input, travel } = await adapter.gapInput({ day, crewId: S2.crewId });
  const route = input.stops.filter((s) => s.currentCrewId === String(S2.crewId)).sort((a, b) => a.start - b.start);
  const cut = input.cancelled[0].start;
  const prev = route.filter((s) => s.start < cut).pop().node;
  const next = route.find((s) => s.start > cut).node;
  const cands = input.candidates.map((c) => c.node);
  const fetched = new Set();
  for (const call of calls) {
    assert.ok(call.fromIds.length * call.toIds.length <= profile.routing.max_pairs);
    for (const f of call.fromIds) for (const t of call.toIds) fetched.add(`${f}>${t}`);
  }
  const want = new Set([`${prev}>${next}`, ...cands.map((c) => `${prev}>${c}`), ...cands.map((c) => `${c}>${next}`)]);
  assert.deepEqual([...fetched].sort(), [...want].sort());
  assert.ok(cands.length * cands.length > profile.routing.max_pairs, 'the full square would exceed max_pairs');
  assert.ok(Number.isSafeInteger(travel(prev, next)));
});

test('S1 through the adapter and the engine: booked drive minutes match targets.json, no hard break, optimized no worse', async () => {
  const { input, travel } = await adapter.dayInput({ day: dayOf(S1.dayOffset), crewIds: [String(S1.crewId)] });
  assert.equal(input.stops.length, S1.stops);
  const result = routing.optimizeDay(input, { travel });
  assert.equal(result.booked.driveMinutes, TARGETS['route-optimize-s1-drive']);
  assert.equal(result.booked.hardBreaks, 0);
  assert.equal(result.cost.hardBreaks, 0);
  assert.ok(result.cost.driveMinutes <= result.booked.driveMinutes);
  assert.deepEqual(result.unplaced, []);
});

test('S2 through the adapter and the engine: the valid count and the top fill match targets.json', async () => {
  const { input, travel } = await adapter.gapInput({ day: dayOf(S2.dayOffset), crewId: S2.crewId });
  const result = routing.fillGap(input, { travel, horizonDays: profile.routing.gap_fill.horizon_days, limit: profile.routing.gap_fill.limit });
  assert.equal(result.gaps.length, 1);
  const [gap] = result.gaps;
  assert.equal(gap.valid, TARGETS['route-change-s2-count']);
  const node = (stopId) => input.candidates.find((c) => c.stopId === stopId).node;
  assert.equal(node(gap.candidates[0].stopId), `property:${TARGETS['route-change-s2-top']}`);
  assert.deepEqual(gap.candidates.map((c) => node(c.stopId)), [`property:${S2.bestFill}`, `property:${S2.runnerUp}`]);
  const why = (pid) => gap.excluded.find((e) => node(e.stopId) === `property:${pid}`).reason;
  assert.match(why(S2.morningDecoy), /time of day/i);
  assert.match(why(S2.cadenceDecoy), /cadence/);
});

test('S3 through the adapter and the engine: in-zone, cross-zone and unplaced match targets.json', async () => {
  const { input, travel } = await adapter.dayInput({ day: dayOf(S3.dayOffset) });
  const result = routing.placeOrphans(input, { travel });
  assert.deepEqual(result.crewsOut, [String(S3.crewId)]);
  const target = TARGETS['route-change-s3-crosszone'];
  assert.deepEqual({
    in_zone: result.moves.filter((m) => !m.crossZone).length,
    cross_zone: result.moves.filter((m) => m.crossZone && m.recommendation).length,
    unplaced: result.unplaced.length,
  }, target);
  const cross = result.moves.find((m) => m.crossZone);
  assert.equal(input.stops.find((s) => s.stopId === cross.stopId).node, `property:${S3.orphanMorning}`);
  for (const m of result.moves.filter((x) => !x.crossZone)) assert.ok(S3.zoneCrews.map(String).includes(m.toCrew));
});
