'use strict';

// Story 14.2: customer rules, staff absences and the planted routing
// scenarios S1 to S3 (data-design §1 and §5). Example tests (AD-1
// carve-out): they read Brightside's own fixture and go with it in a fork.
// The engine's answers for S1 to S3 are truths run under npm run verify
// (Story 14.4); here the data is checked to hold each scenario's shape, and
// S2's valid set is proved by the gap mirror in lib/scenarios.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generate, readSeedConfig, readRoutingTargets, readTargets } = require('../generate');
const { TRUTH_IDS } = require('../lib/truths');
const { travelMinutes, isoWeekday, DAY_NAMES } = require('../lib/routing');
const { checkRouting } = require('../lib/routing-rules');
const scenarios = require('../lib/scenarios');
const { toDay, toIso } = require('../lib/days');
const { AS_OF } = require('../lib/reference');

const { S1, S2, S3, ROUTING_TARGET_IDS, s2Candidates, routingFigures, checkScenarios } = scenarios;
const FIXTURE_DIR = path.join(__dirname, '..');
const SMALL = { seed: 7, clients: 60 };
const day = (n) => toIso(toDay(AS_OF) + n);

let recorded;
const run = () => (recorded ??= generate(readSeedConfig()));
const tables = () => run().tables;
const crewDay = (t, crewId, offset) => t.scheduled_visits
  .filter((v) => v.crew_id === crewId && v.visit_date === day(offset))
  .sort((a, b) => a.route_order - b.route_order);
const rulesOf = (t, pid) => t.service_rules.filter((r) => r.property_id === pid).map((r) => `${r.rule_type}=${r.value}`);

test('targets.json keeps truths as they were and holds the routing targets under routing', () => {
  assert.deepEqual(TRUTH_IDS, ['clients-total', 'active-plans-at-as-of', 'winback-north-90d', 'winback-north-90d-price-rise',
    'paid-revenue-2026-09', 'billed-revenue-2026-09', 'outstanding-at-as-of']);
  assert.deepEqual(Object.keys(readTargets()).sort(), TRUTH_IDS.slice().sort());
  const routing = readRoutingTargets();
  assert.deepEqual(Object.keys(routing).sort(), ROUTING_TARGET_IDS.slice().sort());
  assert.deepEqual(ROUTING_TARGET_IDS, ['scheduled-stops-next-14d', 'route-optimize-s1-drive', 'route-change-s2-top',
    'route-change-s2-count', 'route-change-s3-crosszone']);
  assert.deepEqual(routing, {
    'scheduled-stops-next-14d': 825,
    'route-optimize-s1-drive': 140,
    'route-change-s2-top': S2.bestFill,
    'route-change-s2-count': 2,
    'route-change-s3-crosszone': { in_zone: 5, cross_zone: 1, unplaced: 0 },
  });
});

test('readRoutingTargets refuses a missing, extra or malformed routing target', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brightside-routing-targets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'targets.json'), 'utf8'));
  const write = (routing) => {
    const file = path.join(dir, 'targets.json');
    fs.writeFileSync(file, JSON.stringify({ ...good, routing }));
    return file;
  };
  assert.deepEqual(readRoutingTargets(write(good.routing)), good.routing);
  const { 'route-change-s2-count': _drop, ...missing } = good.routing;
  for (const bad of [
    undefined,
    missing,
    { ...good.routing, extra: 1 },
    { ...good.routing, 'route-change-s2-top': '762' },
    { ...good.routing, 'scheduled-stops-next-14d': -1 },
    { ...good.routing, 'route-change-s3-crosszone': 6 },
    { ...good.routing, 'route-change-s3-crosszone': { in_zone: 5, cross_zone: 1 } },
    { ...good.routing, 'route-change-s3-crosszone': { in_zone: 5, cross_zone: 1, unplaced: 0.5 } },
  ]) {
    assert.throws(() => readRoutingTargets(write(bad)), /routing must give a whole number/);
  }
});

test('the generator plants the routing targets, and refuses when one misses', () => {
  const config = readSeedConfig();
  const got = routingFigures(tables(), { asOf: AS_OF });
  for (const id of ROUTING_TARGET_IDS.filter((x) => x !== 'route-change-s3-crosszone')) assert.equal(got[id], config.routing[id], id);
  assert.throws(() => generate({ ...config, routing: { ...config.routing, 'route-optimize-s1-drive': 141 } }),
    /planted routing figures missed: route-optimize-s1-drive 140 \(target 141\)/);
  assert.throws(() => generate({ ...config, routing: { ...config.routing, 'route-change-s3-crosszone': { in_zone: 6, cross_zone: 1, unplaced: 0 } } }),
    /route-change-s3-crosszone adds up to 7, not crew 7's 6 stops/);
  // The scenarios' ids fit the recorded seed only.
  assert.throws(() => generate({ ...SMALL, routing: config.routing }), /scenario: /);
});

test('scheduled-stops-next-14d is the booked (not cancelled) stops after as_of through as_of + 14', () => {
  const t = tables();
  const n = t.scheduled_visits.filter((v) => v.status === 'scheduled' && v.visit_date > AS_OF && v.visit_date <= day(14)).length;
  assert.equal(n, readRoutingTargets()['scheduled-stops-next-14d']);
});

// ---- service_rules --------------------------------------------------------

test('service_rules: long form, one row per property and rule type, each type at its strength', () => {
  const t = tables();
  const keys = new Set(t.service_rules.map((r) => `${r.property_id}|${r.rule_type}`));
  assert.equal(keys.size, t.service_rules.length);
  assert.deepEqual(t.service_rules.map((r) => r.rule_id), t.service_rules.map((_, i) => i + 1));
  const strength = { preferred_crew: 'soft', day_of_week: 'hard', time_of_day: 'hard' };
  for (const r of t.service_rules) assert.equal(r.strength, strength[r.rule_type], `${r.rule_id} ${r.rule_type}`);
  // Shares of booked properties, roughly data-design's (preferred crew only
  // when every booked visit is on one crew; a window only when they share one).
  const booked = new Set(t.scheduled_visits.filter((v) => v.status === 'scheduled').map((v) => v.property_id));
  const share = (type) => t.service_rules.filter((r) => r.rule_type === type).length / booked.size;
  assert.ok(share('preferred_crew') > 0.45 && share('preferred_crew') < 0.65, `preferred_crew ${share('preferred_crew')}`);
  assert.ok(share('day_of_week') > 0.12 && share('day_of_week') < 0.28, `day_of_week ${share('day_of_week')}`);
  assert.ok(share('time_of_day') > 0.08 && share('time_of_day') < 0.3, `time_of_day ${share('time_of_day')}`);
  for (const r of t.service_rules) assert.ok(booked.has(r.property_id), `rule ${r.rule_id} is on a booked property`);
});

test('service_rules: values are well formed and every booked visit keeps its property\'s rules', () => {
  const t = tables();
  const visits = new Map();
  for (const v of t.scheduled_visits) if (v.status === 'scheduled') visits.set(v.property_id, [...(visits.get(v.property_id) || []), v]);
  for (const r of t.service_rules) {
    const own = visits.get(r.property_id);
    if (r.rule_type === 'day_of_week') {
      const days = r.value.split('|');
      assert.deepEqual(days, DAY_NAMES.filter((d) => days.includes(d)), `${r.value} in week order, no repeat`);
      for (const v of own) assert.ok(days.includes(DAY_NAMES[isoWeekday(toDay(v.visit_date)) - 1]), `${v.scheduled_visit_id} on ${r.value}`);
    } else if (r.rule_type === 'time_of_day') {
      for (const v of own) assert.equal(v.arrival_window, r.value, `${v.scheduled_visit_id}`);
    } else {
      for (const v of own) assert.equal(String(v.crew_id), r.value, `${v.scheduled_visit_id}`);
    }
  }
  // ISO weekdays: 2026-10-05 is a Monday, 2026-10-04 a Sunday.
  assert.equal(isoWeekday(toDay('2026-10-05')), 1);
  assert.equal(isoWeekday(toDay('2026-10-04')), 7);
});

// ---- staff_absences -------------------------------------------------------

test('staff_absences: S3\'s two, then background cleaners only, at most one per crew-day, none on the scenario days', () => {
  const t = tables();
  const role = new Map(t.staff.map((s) => [s.staff_id, s.role]));
  const crewOf = new Map(t.crew_memberships.filter((m) => m.end_date === null).map((m) => [m.staff_id, m.crew_id]));
  const planted = t.staff_absences.filter((a) => a.absence_date === day(S3.dayOffset));
  assert.deepEqual(planted.map((a) => [a.staff_id, a.reported_on]).sort(), [[55, AS_OF], [87, AS_OF]]);
  const background = t.staff_absences.filter((a) => a.absence_date !== day(S3.dayOffset));
  assert.ok(background.length > 0, 'some background absences');
  const seen = new Set();
  for (const a of background) {
    assert.equal(role.get(a.staff_id), 'cleaner', `${a.absence_id}`);
    assert.ok(a.absence_date > day(3) && a.absence_date <= day(28), a.absence_date);
    assert.ok(a.reported_on <= AS_OF, a.reported_on);
    const key = `${crewOf.get(a.staff_id)}|${a.absence_date}`;
    assert.ok(!seen.has(key), `one absence on crew-day ${key}`);
    seen.add(key);
  }
  assert.deepEqual(t.staff_absences.map((a) => a.absence_id), t.staff_absences.map((_, i) => i + 1));
});

test('without routing targets nothing is planted: no visit moves crew and no crew lead is absent', () => {
  const run7 = generate(SMALL);
  assert.deepEqual(run7.reassigned, []);
  const role = new Map(run7.tables.staff.map((s) => [s.staff_id, s.role]));
  assert.ok(run7.tables.staff_absences.every((a) => role.get(a.staff_id) === 'cleaner'));
  assert.deepEqual(checkRouting(run7.tables, { asOf: AS_OF }), []);
  // Same seed, same rules and absences.
  assert.deepEqual(generate(SMALL).tables.service_rules, run7.tables.service_rules);
  assert.deepEqual(generate(SMALL).tables.staff_absences, run7.tables.staff_absences);
});

// ---- S1 -------------------------------------------------------------------

test('S1: crew 4 on as_of + 1 has seven booked stops going back and forth between cities', () => {
  const t = tables();
  const city = new Map(t.properties.map((p) => [p.property_id, p.city]));
  const route = crewDay(t, S1.crewId, S1.dayOffset);
  assert.equal(route.length, 7);
  assert.ok(route.every((v) => v.status === 'scheduled'));
  const cities = route.map((v) => city.get(v.property_id));
  assert.deepEqual(cities, ['Clayfield', 'Riverbend', 'Southmere', 'Clayfield', 'Southmere', 'Clayfield', 'Southmere']);
  // The booked drive: every leg travelMatrix's figure, from the crew's base.
  const place = new Map(t.properties.map((p) => [p.property_id, { lat: p.geo_lat_e6, lon: p.geo_lon_e6 }]));
  const crew = t.crews.find((c) => c.crew_id === S1.crewId);
  let at = { lat: crew.base_geo_lat_e6, lon: crew.base_geo_lon_e6 };
  let drive = 0;
  for (const v of route) {
    const to = place.get(v.property_id);
    assert.equal(v.travel_minutes_from_previous, travelMinutes(at, to));
    drive += v.travel_minutes_from_previous;
    at = to;
  }
  assert.equal(drive, readRoutingTargets()['route-optimize-s1-drive']);
  // No time window on S1's stops: the engine starts the day at 08:00.
  for (const v of route) assert.ok(!rulesOf(t, v.property_id).some((r) => r.startsWith('time_of_day')), `${v.property_id}`);
});

// ---- S2 -------------------------------------------------------------------

test('S2: crew 2\'s afternoon stop on as_of + 2 was cancelled on as_of, inside the planted route', () => {
  const t = tables();
  const route = crewDay(t, S2.crewId, S2.dayOffset);
  assert.deepEqual(route.map((v) => v.scheduled_visit_id), [110, 100, 114, 80, 79]);
  const c = route.find((v) => v.scheduled_visit_id === S2.cancelled);
  assert.deepEqual([c.status, c.status_changed_on, c.arrival_window], ['cancelled', AS_OF, 'afternoon']);
  assert.ok(route.filter((v) => v !== c).every((v) => v.status === 'scheduled'));
});

test('S2: the best fill ranks first of exactly two valid candidates; each decoy is left out for its one reason', () => {
  const t = tables();
  const { out, prevEnd, nextStart } = s2Candidates(t, AS_OF);
  assert.equal(nextStart - prevEnd, 70, 'a 70-minute gap');
  const by = new Map(out.map((x) => [x.pid, x]));
  assert.deepEqual(out.filter((x) => x.valid).map((x) => x.pid).sort((a, b) => a - b), [S2.runnerUp, S2.bestFill].sort((a, b) => a - b));
  const best = by.get(S2.bestFill);
  assert.deepEqual([best.daysMovedUp, best.flexible, best.extraDrive], [3, true, 5]);
  assert.equal(t.properties.find((p) => p.property_id === S2.bestFill).city, 'Pinecrest');
  assert.equal(t.properties.find((p) => p.property_id === 629).city, 'Pinecrest', 'the cancelled home is in Pinecrest too');
  assert.deepEqual(rulesOf(t, S2.bestFill), []);
  assert.ok(by.get(S2.runnerUp).daysMovedUp > best.daysMovedUp);
  const morning = by.get(S2.morningDecoy);
  assert.deepEqual([morning.fits, morning.dayOk, morning.cadenceOk, morning.windowOk], [true, true, true, false]);
  assert.deepEqual(rulesOf(t, S2.morningDecoy), ['time_of_day=morning']);
  const early = by.get(S2.cadenceDecoy);
  assert.deepEqual([early.fits, early.dayOk, early.windowOk, early.cadenceOk], [true, true, true, false]);
  // Only the four planted homes fit the gap at all; the closer decoy sits
  // nearer the cancelled home than the best fill.
  assert.deepEqual(out.filter((x) => x.fits).map((x) => x.pid).sort((a, b) => a - b),
    [S2.bestFill, S2.runnerUp, S2.morningDecoy, S2.cadenceDecoy].sort((a, b) => a - b));
  const place = new Map(t.properties.map((p) => [p.property_id, [p.geo_lat_e6, p.geo_lon_e6]]));
  const dist = (a, b) => Math.hypot(place.get(a)[0] - place.get(b)[0], place.get(a)[1] - place.get(b)[1]);
  assert.ok(dist(S2.morningDecoy, 629) < dist(S2.bestFill, 629));
});

test('S2: the estate is in the box, and every other home is too far to fit the gap', () => {
  const t = tables();
  const estate = new Set(Object.keys(S2.estate).map(Number));
  const place = new Map(t.properties.map((p) => [p.property_id, { lat: p.geo_lat_e6, lon: p.geo_lon_e6 }]));
  for (const pid of estate) {
    assert.equal(t.properties.find((p) => p.property_id === pid).city, 'Pinecrest');
    assert.equal(travelMinutes(place.get(pid), place.get(629)), 5);
  }
  const nearest = Math.min(...t.properties.filter((p) => !estate.has(p.property_id)).map((p) => travelMinutes(place.get(629), place.get(p.property_id))));
  assert.ok(nearest >= 11, `the nearest other home is ${nearest} minutes away`);
});

// ---- S3 -------------------------------------------------------------------

test('S3: crew 7 is out on as_of + 3 with six stops; crews 8 and 9 work in full', () => {
  const t = tables();
  const d = day(S3.dayOffset);
  const away = new Set(t.staff_absences.filter((a) => a.absence_date === d).map((a) => a.staff_id));
  const present = (crewId) => t.crew_memberships.filter((m) => m.crew_id === crewId && m.end_date === null && !away.has(m.staff_id));
  const lead = t.staff.find((s) => s.staff_id === 87);
  assert.equal(lead.role, 'crew_lead');
  assert.ok(t.crew_memberships.some((m) => m.crew_id === 7 && m.staff_id === 87 && m.end_date === null));
  assert.deepEqual(present(7).map((m) => m.staff_id), [15]);
  assert.equal(present(8).length, 3);
  assert.equal(present(9).length, 3);
  for (const crewId of S3.zoneCrews) assert.deepEqual(crewDay(t, crewId, S3.dayOffset).map((v) => v.scheduled_visit_id), S3.routes[crewId]);
  const orphans = crewDay(t, 7, S3.dayOffset);
  assert.equal(orphans.length, 6);
  assert.ok(orphans.every((v) => v.status === 'scheduled'));
  // The orphan that must start before noon, and the blocking stops on 8 and 9.
  const o6 = orphans.find((v) => v.property_id === S3.orphanMorning);
  assert.equal(o6.arrival_window, 'morning');
  for (const pid of S3.morning) assert.deepEqual(rulesOf(t, pid), ['time_of_day=morning'], `${pid}`);
  const zoneDay = S3.zoneCrews.flatMap((c) => crewDay(t, c, S3.dayOffset));
  for (const v of zoneDay) if (!S3.morning.includes(v.property_id)) assert.deepEqual(rulesOf(t, v.property_id), [], `${v.property_id}`);
});

test('the scenario checks catch a broken scenario', () => {
  const t = tables();
  assert.deepEqual(checkScenarios(t, { asOf: AS_OF }), []);
  const cases = [
    [(x) => { x.scheduled_visits.find((v) => v.scheduled_visit_id === S2.cancelled).status_changed_on = '2026-09-29'; }, /S2: visit 80 is not cancelled on as_of/],
    [(x) => { x.service_rules = x.service_rules.filter((r) => r.property_id !== S2.morningDecoy); }, /S2: valid fills are/],
    [(x) => { x.staff_absences = x.staff_absences.filter((a) => a.staff_id !== 87); }, /S3: crew 7 is not out/],
    [(x) => {
      const r = crewDay(x, S1.crewId, S1.dayOffset);
      [r[0].route_order, r[1].route_order] = [2, 1];
    }, /S1: the day is not booked city by city in turn/],
  ];
  for (const [mutate, expected] of cases) {
    const copy = JSON.parse(JSON.stringify(t));
    mutate(copy);
    const problems = checkScenarios(copy, { asOf: AS_OF });
    assert.ok(problems.some((p) => expected.test(p)), `${expected}: ${problems.join('; ')}`);
  }
});
